'use strict';
// Read-only TFTP server (RFC 1350) with option negotiation:
// blksize (RFC 2348), tsize and timeout (RFC 2349). PXE ROMs use these.

const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const OP = { RRQ: 1, WRQ: 2, DATA: 3, ACK: 4, ERROR: 5, OACK: 6 };

function parseRequest(buf) {
  const op = buf.readUInt16BE(0);
  const parts = buf.subarray(2).toString('latin1').split('\0');
  const filename = parts[0];
  const mode = (parts[1] || '').toLowerCase();
  const options = {};
  for (let i = 2; i + 1 < parts.length; i += 2) {
    if (parts[i]) options[parts[i].toLowerCase()] = parts[i + 1];
  }
  return { op, filename, mode, options };
}

function errorPacket(code, msg) {
  return Buffer.concat([Buffer.from([0, OP.ERROR, 0, code]), Buffer.from(msg + '\0', 'latin1')]);
}

function safeResolve(root, filename) {
  const clean = filename.replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(root, clean);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

class TftpServer extends EventEmitter {
  constructor({ root, port = 69, host = '0.0.0.0', retries = 6, timeoutMs = 1000 }) {
    super();
    this.root = path.resolve(root);
    this.port = port;
    this.host = host;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.transfers = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      this.sock.once('error', (e) => {
        if (e.code === 'EACCES') e.message = `Permission denied to open UDP port ${this.port} (TFTP). Run the app as administrator.`;
        if (e.code === 'EADDRINUSE') e.message = `UDP port ${this.port} (TFTP) is already used by another program.`;
        reject(e);
      });
      this.sock.on('message', (m, r) => this._onRequest(m, r));
      this.sock.bind(this.port, this.host, () => {
        this.sock.removeAllListeners('error');
        this.sock.on('error', (e) => this.emit('log', `TFTP error: ${e.message}`));
        this.port = this.sock.address().port;
        this.emit('log', `TFTP listening on port ${this.port}`);
        resolve();
      });
    });
  }

  _onRequest(msg, rinfo) {
    let req;
    try {
      req = parseRequest(msg);
    } catch {
      return;
    }
    if (req.op === OP.WRQ) {
      this.sock.send(errorPacket(2, 'Read-only server'), rinfo.port, rinfo.address);
      return;
    }
    if (req.op !== OP.RRQ) return;
    this._transfer(req, rinfo).catch((e) => this.emit('log', `TFTP transfer failed: ${e.message}`));
  }

  async _transfer(req, rinfo) {
    const sock = dgram.createSocket('udp4');
    await new Promise((r) => sock.bind(0, this.host === '0.0.0.0' ? undefined : this.host, r));
    this.transfers.add(sock);
    let closed = false;
    const send = (b) => new Promise((r) => (closed ? r() : sock.send(b, rinfo.port, rinfo.address, () => r())));
    const done = () => {
      closed = true;
      this.transfers.delete(sock);
      try {
        sock.close();
      } catch {}
    };

    const file = safeResolve(this.root, req.filename);
    let stat;
    try {
      stat = file && fs.statSync(file);
    } catch {}
    if (!stat || !stat.isFile()) {
      this.emit('log', `TFTP: ${rinfo.address} asked for missing file "${req.filename}"`);
      await send(errorPacket(1, 'File not found'));
      return done();
    }

    let blksize = 512;
    const oack = {};
    if (req.options.blksize) {
      blksize = Math.max(8, Math.min(65464, parseInt(req.options.blksize, 10) || 512));
      blksize = Math.min(blksize, 1468); // keep within a standard Ethernet frame
      oack.blksize = String(blksize);
    }
    if (req.options.tsize !== undefined) oack.tsize = String(stat.size);
    let timeoutMs = this.timeoutMs;
    if (req.options.timeout) {
      const t = parseInt(req.options.timeout, 10);
      if (t >= 1 && t <= 255) {
        timeoutMs = t * 1000;
        oack.timeout = String(t);
      }
    }

    // Wait for an ACK of `block`, retransmitting `packet` on timeout.
    const exchange = (packet, block) =>
      new Promise((resolve, reject) => {
        let tries = 0;
        let timer;
        const onMsg = (m, r) => {
          if (r.address !== rinfo.address || r.port !== rinfo.port) return;
          const op = m.readUInt16BE(0);
          if (op === OP.ERROR) return finish(new Error(`client aborted: ${m.subarray(4).toString('latin1').replace(/\0.*/, '')}`));
          if (op === OP.ACK && m.readUInt16BE(2) === block) finish();
        };
        const finish = (err) => {
          clearTimeout(timer);
          sock.removeListener('message', onMsg);
          err ? reject(err) : resolve();
        };
        const fire = () => {
          if (closed) return finish(new Error('closed'));
          if (tries++ > this.retries) return finish(new Error('timeout'));
          try {
            sock.send(packet, rinfo.port, rinfo.address);
          } catch (e) {
            return finish(e);
          }
          timer = setTimeout(fire, timeoutMs);
        };
        sock.on('message', onMsg);
        fire();
      });

    const fd = fs.openSync(file, 'r');
    try {
      if (Object.keys(oack).length) {
        const body = Object.entries(oack).flatMap(([k, v]) => [k, v]).join('\0') + '\0';
        const packet = Buffer.concat([Buffer.from([0, OP.OACK]), Buffer.from(body, 'latin1')]);
        try {
          await exchange(packet, 0);
        } catch (e) {
          // Many PXE ROMs ask for tsize only, then abort and re-request: that is normal.
          return;
        }
      }
      this.emit('log', `TFTP: sending ${req.filename} (${stat.size} bytes) to ${rinfo.address}`);
      let block = 1;
      let offset = 0;
      const chunk = Buffer.alloc(blksize);
      for (;;) {
        const n = fs.readSync(fd, chunk, 0, blksize, offset);
        const packet = Buffer.alloc(4 + n);
        packet.writeUInt16BE(OP.DATA, 0);
        packet.writeUInt16BE(block & 0xffff, 2);
        chunk.copy(packet, 4, 0, n);
        await exchange(packet, block & 0xffff);
        offset += n;
        block++;
        if (n < blksize) break;
      }
      this.emit('log', `TFTP: ${req.filename} sent to ${rinfo.address}`);
      this.emit('sent', { file: req.filename, client: rinfo.address });
    } finally {
      fs.closeSync(fd);
      done();
    }
  }

  stop() {
    for (const s of this.transfers) {
      try {
        s.close();
      } catch {}
    }
    this.transfers.clear();
    if (this.sock) {
      try {
        this.sock.close();
      } catch {}
      this.sock = null;
    }
  }
}

module.exports = { TftpServer, parseRequest, safeResolve, OP };
