'use strict';
// MikroTik RouterOS API client (TCP 8728 / TLS 8729), RouterOS v6.43+ and v7.

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function encodeLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x4000) return Buffer.from([(n >> 8) | 0x80, n & 0xff]);
  if (n < 0x200000) return Buffer.from([(n >> 16) | 0xc0, (n >> 8) & 0xff, n & 0xff]);
  if (n < 0x10000000) return Buffer.from([(n >> 24) | 0xe0, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.from([0xf0, (n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
}

// Returns [length, bytesUsed] or null if more data is needed.
function decodeLength(buf, off) {
  if (off >= buf.length) return null;
  const c = buf[off];
  if ((c & 0x80) === 0) return [c, 1];
  if ((c & 0xc0) === 0x80) return off + 2 > buf.length ? null : [((c & 0x3f) << 8) | buf[off + 1], 2];
  if ((c & 0xe0) === 0xc0) return off + 3 > buf.length ? null : [((c & 0x1f) << 16) | (buf[off + 1] << 8) | buf[off + 2], 3];
  if ((c & 0xf0) === 0xe0) return off + 4 > buf.length ? null : [((c & 0x0f) * 0x1000000) + (buf[off + 1] << 16) + (buf[off + 2] << 8) + buf[off + 3], 4];
  if (c === 0xf0) return off + 5 > buf.length ? null : [buf.readUInt32BE(off + 1), 5];
  throw new Error('bad length byte');
}

function encodeSentence(words) {
  const parts = [];
  for (const w of words) {
    const b = Buffer.from(w, 'utf8');
    parts.push(encodeLength(b.length), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

class RouterOSClient {
  constructor({ host, port, useTls = false, timeoutMs = 8000 }) {
    this.host = host;
    this.useTls = useTls;
    this.port = port || (useTls ? 8729 : 8728);
    this.timeoutMs = timeoutMs;
    this.buf = Buffer.alloc(0);
    this.sentence = [];
    this.pending = null;
    this.queue = Promise.resolve();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const opts = { host: this.host, port: this.port };
      const onConnect = () => {
        clearTimeout(timer);
        resolve();
      };
      this.sock = this.useTls ? tls.connect({ ...opts, rejectUnauthorized: false }, onConnect) : net.connect(opts, onConnect);
      const timer = setTimeout(() => {
        this.sock.destroy();
        reject(new Error(`Could not reach ${this.host}:${this.port}. Check the IP and that the "api" service is enabled (IP → Services).`));
      }, this.timeoutMs);
      this.sock.on('error', (e) => {
        clearTimeout(timer);
        const err = new Error(e.code === 'ECONNREFUSED' ? `Router refused the connection on port ${this.port}. Enable the "api" service in IP → Services.` : e.message);
        if (this.pending) this.pending.reject(err);
        else reject(err);
      });
      this.sock.on('data', (d) => this._onData(d));
      this.sock.on('close', () => {
        if (this.pending) this.pending.reject(new Error('Connection to router closed'));
      });
    });
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    let off = 0;
    for (;;) {
      const l = decodeLength(this.buf, off);
      if (!l) break;
      const [len, used] = l;
      if (off + used + len > this.buf.length) break;
      off += used;
      if (len === 0) {
        this._onSentence(this.sentence);
        this.sentence = [];
      } else {
        this.sentence.push(this.buf.toString('utf8', off, off + len));
        off += len;
      }
    }
    this.buf = this.buf.subarray(off);
  }

  _onSentence(words) {
    if (!this.pending) return;
    const type = words[0];
    const attrs = {};
    for (const w of words.slice(1)) {
      if (w.startsWith('=')) {
        const i = w.indexOf('=', 1);
        attrs[w.slice(1, i)] = w.slice(i + 1);
      }
    }
    if (type === '!re') this.pending.rows.push(attrs);
    else if (type === '!trap') this.pending.trap = attrs.message || 'router error';
    else if (type === '!fatal') {
      this.pending.reject(new Error(words.slice(1).join(' ') || 'fatal router error'));
      this.pending = null;
    } else if (type === '!done') {
      const p = this.pending;
      this.pending = null;
      if (p.trap) p.reject(new Error(p.trap));
      else p.resolve(Object.assign(p.rows, { done: attrs }));
    }
  }

  // Run a command, e.g. run('/ip/dhcp-server/lease/print', {'?mac-address': 'AA:..'})
  run(command, params = {}) {
    const words = [command];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      words.push(k.startsWith('?') || k.startsWith('=') ? `${k}=${v}` : `=${k}=${v}`);
    }
    const job = () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new Error(`Router did not answer "${command}"`));
        }, this.timeoutMs);
        this.pending = {
          rows: [],
          trap: null,
          resolve: (r) => (clearTimeout(timer), resolve(r)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        };
        this.sock.write(encodeSentence(words));
      });
    const p = this.queue.then(job, job);
    this.queue = p.catch(() => {});
    return p;
  }

  async login(user, password) {
    let res;
    try {
      res = await this.run('/login', { name: user, password });
    } catch (e) {
      throw new Error(/invalid user|cannot log in|failure/i.test(e.message) ? 'Wrong router username or password.' : e.message);
    }
    if (res.done && res.done.ret) {
      // RouterOS older than 6.43: MD5 challenge
      const challenge = Buffer.from(res.done.ret, 'hex');
      const md5 = crypto.createHash('md5').update(Buffer.concat([Buffer.from([0]), Buffer.from(password, 'utf8'), challenge])).digest('hex');
      try {
        await this.run('/login', { name: user, response: '00' + md5 });
      } catch {
        throw new Error('Wrong router username or password.');
      }
    }
  }

  close() {
    try {
      this.sock?.end();
      this.sock?.destroy();
    } catch {}
  }
}

module.exports = { RouterOSClient, encodeLength, decodeLength, encodeSentence };
