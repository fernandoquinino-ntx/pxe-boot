'use strict';
// Minimal read-only NFSv3 server that serves the *contents of ISO 9660 images* directly
// (no extraction, no mount). Lets a Linux initramfs mount a live-media tree over the network
// (casper: netboot=nfs nfsroot=<ip>:/iso/<id>) when the ISO is too big to fit into the board's RAM.
//
// One ONC RPC dispatcher serves PORTMAP v2 (100000), MOUNT v3 (100005) and NFS v3 (100003)
// over TCP (record marking) and UDP on the same port. An optional separate listener
// (default port 111) answers the same RPCs so that clients which ask rpcbind work too.

const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const PMAP = 100000;
const NFS = 100003;
const MOUNT = 100005;
const IPPROTO_TCP = 6;
const IPPROTO_UDP = 17;

const S = {
  OK: 0, PERM: 1, NOENT: 2, IO: 5, ACCES: 13, NOTDIR: 20, ISDIR: 21, INVAL: 22, ROFS: 30,
  NAMETOOLONG: 63, STALE: 70, BADHANDLE: 10001, BAD_COOKIE: 10003, NOTSUPP: 10004, TOOSMALL: 10005, SERVERFAULT: 10006,
};

const MAX_READ_TCP = 1024 * 1024;
const MAX_READ_UDP = 32768;
const MAX_RECORD = 4 * 1024 * 1024; // largest RPC call accepted (writes are refused anyway)

// ---------- XDR ----------

class XdrReader {
  constructor(buf, off = 0) {
    this.b = buf;
    this.o = off;
  }
  u32() {
    if (this.o + 4 > this.b.length) throw new RangeError('xdr underflow');
    const v = this.b.readUInt32BE(this.o);
    this.o += 4;
    return v;
  }
  u64() {
    const hi = this.u32();
    const lo = this.u32();
    return hi * 4294967296 + lo; // exact up to 2^53, far beyond any ISO
  }
  opaque(max = 1 << 20) {
    const n = this.u32();
    if (n > max || this.o + n > this.b.length) throw new RangeError('xdr opaque');
    const v = this.b.subarray(this.o, this.o + n);
    this.o += (n + 3) & ~3;
    return v;
  }
  fixed(n) {
    if (this.o + n > this.b.length) throw new RangeError('xdr underflow');
    const v = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return v;
  }
  string(max = 4096) {
    return this.opaque(max).toString('utf8');
  }
}

class XdrWriter {
  constructor() {
    this.parts = [];
    this.len = 0;
  }
  _push(b) {
    this.parts.push(b);
    this.len += b.length;
  }
  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    this._push(b);
    return this;
  }
  u64(v) {
    const b = Buffer.alloc(8);
    b.writeUInt32BE(Math.floor(v / 4294967296) >>> 0, 0);
    b.writeUInt32BE(v >>> 0, 4);
    this._push(b);
    return this;
  }
  bool(v) {
    return this.u32(v ? 1 : 0);
  }
  fixed(buf) {
    this._push(buf);
    const pad = (4 - (buf.length & 3)) & 3;
    if (pad) this._push(Buffer.alloc(pad));
    return this;
  }
  opaque(buf) {
    this.u32(buf.length);
    return this.fixed(buf);
  }
  string(s) {
    return this.opaque(Buffer.from(s, 'utf8'));
  }
  buffer() {
    return Buffer.concat(this.parts, this.len);
  }
}

const xdrSize = (n) => 4 + ((n + 3) & ~3);

// ---------- helpers ----------

function normExportPath(p) {
  const parts = String(p || '/').split('/').filter(Boolean);
  return '/' + parts.join('/');
}
const hash = (s) => crypto.createHash('sha1').update(s).digest();

const FATTR_SIZE = 84;
const DEFAULT_TIME = Math.floor(Date.now() / 1000);

class NfsServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {number} [o.port=2049]   NFS/MOUNT/PORTMAP port (TCP and UDP). 0 = ephemeral.
   * @param {string} [o.host='0.0.0.0']
   * @param {number|null} [o.portmapPort=111] separate portmapper listener (TCP+UDP), null = none
   * @param {boolean} [o.udp=true]
   * @param {() => Array<{path:string, iso:object}>} o.exports  called on demand, so images can come and go
   */
  constructor({ port = 2049, host = '0.0.0.0', portmapPort = 111, udp = true, exports: exportsFn = () => [] } = {}) {
    super();
    this.port = port;
    this.host = host;
    this.portmapPort = portmapPort;
    this.udpEnabled = udp;
    this.exportsFn = exportsFn;
    this.nodes = new Map(); // hex handle -> node
    this.mounts = new Map(); // "ip|path" -> {host, path}
    this.listeners = [];
    this.sockets = new Set();
    this.running = false;
  }

  // ---------- lifecycle ----------

  async start() {
    this.udpPort = null;
    this.pmapActive = null;
    const tcp = await this._listenTcp(this.port, 'NFS');
    this.port = tcp.address().port;
    this.listeners.push(tcp);
    this.emit('log', `NFS server (NFSv3 + MOUNT) listening on TCP port ${this.port}`);
    if (this.udpEnabled) {
      try {
        const u = await this._listenUdp(this.port);
        this.listeners.push(u);
        this.udpPort = this.port;
        this.emit('log', `NFS server listening on UDP port ${this.port}`);
      } catch (e) {
        this.emit('log', `NFS over UDP unavailable (${e.code === 'EADDRINUSE' ? `UDP port ${this.port} is in use` : e.message}); clients must use TCP (proto=tcp)`);
      }
    }
    if (this.portmapPort !== null && this.portmapPort !== undefined) {
      try {
        const t = await this._listenTcp(this.portmapPort, 'portmap');
        this.listeners.push(t);
        this.pmapActive = t.address().port;
        try {
          this.listeners.push(await this._listenUdp(this.pmapActive));
        } catch (e) {
          this.emit('log', `portmap UDP port ${this.pmapActive} unavailable: ${e.message}`);
        }
        this.emit('log', `portmap listening on port ${this.pmapActive}`);
      } catch (e) {
        this.emit('log', `Could not start the portmap listener on port ${this.portmapPort} (${e.code === 'EADDRINUSE' ? 'already in use, probably the system rpcbind' : e.code === 'EACCES' ? 'needs administrator rights' : e.message}). Clients must be given explicit port=${this.port},mountport=${this.port}.`);
      }
    }
    this.running = true;
  }

  stop() {
    this.running = false;
    for (const l of this.listeners) {
      try {
        l.close();
      } catch {}
    }
    this.listeners = [];
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  _listenTcp(port, what) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this._onTcp(sock));
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE') e.message = `TCP port ${port} is already in use (${what}). Pick another NFS port in Settings.`;
        reject(e);
      });
      server.listen(port, this.host, () => {
        server.on('error', (e) => this.emit('log', `NFS: ${e.message}`));
        resolve(server);
      });
    });
  }

  _listenUdp(port) {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      sock.once('error', reject);
      sock.on('message', (msg, rinfo) => {
        this._handle(msg, { udp: true, ip: rinfo.address }).then(
          (reply) => reply && sock.send(reply, rinfo.port, rinfo.address),
          () => {}
        );
      });
      sock.bind(port, this.host, () => {
        sock.removeAllListeners('error');
        sock.on('error', (e) => this.emit('log', `NFS UDP: ${e.message}`));
        resolve({ close: () => sock.close(), address: () => sock.address() });
      });
    });
  }

  _onTcp(sock) {
    this.sockets.add(sock);
    sock.setNoDelay(true);
    const ip = (sock.remoteAddress || '').replace(/^::ffff:/, '');
    let frags = [];
    let fragLen = 0;
    let pending = Buffer.alloc(0);
    const ctx = { udp: false, ip };
    sock.on('data', (d) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      while (pending.length >= 4) {
        const h = pending.readUInt32BE(0);
        const last = !!(h & 0x80000000);
        const len = h & 0x7fffffff;
        if (fragLen + len > MAX_RECORD) return sock.destroy();
        if (pending.length < 4 + len) break;
        frags.push(pending.subarray(4, 4 + len));
        fragLen += len;
        pending = pending.subarray(4 + len);
        if (last) {
          const rec = frags.length === 1 ? frags[0] : Buffer.concat(frags);
          frags = [];
          fragLen = 0;
          this._handle(rec, ctx).then(
            (reply) => {
              if (!reply || sock.destroyed) return;
              const hdr = Buffer.alloc(4);
              hdr.writeUInt32BE((0x80000000 | reply.length) >>> 0);
              sock.write(Buffer.concat([hdr, reply]));
            },
            () => sock.destroy()
          );
        }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => this.sockets.delete(sock));
  }

  // ---------- ONC RPC ----------

  async _handle(buf, ctx) {
    let r;
    let xid;
    let prog;
    let vers;
    let proc;
    try {
      r = new XdrReader(buf);
      xid = r.u32();
      if (r.u32() !== 0) return null; // not a CALL
      const rpcvers = r.u32();
      prog = r.u32();
      vers = r.u32();
      proc = r.u32();
      if (rpcvers !== 2) {
        const w = new XdrWriter().u32(xid).u32(1).u32(1).u32(0).u32(2).u32(2); // MSG_DENIED, RPC_MISMATCH 2..2
        return w.buffer();
      }
      r.u32(); // cred flavor (AUTH_NONE / AUTH_UNIX / anything: accepted)
      r.opaque();
      r.u32(); // verifier
      r.opaque();
    } catch {
      return null;
    }
    const head = (stat, extra) => {
      const w = new XdrWriter().u32(xid).u32(1).u32(0).u32(0).u32(0).u32(stat);
      if (extra) for (const e of extra) w.u32(e);
      return w;
    };
    const progs = { [PMAP]: [2, 2], [MOUNT]: [3, 3], [NFS]: [3, 3] };
    if (!progs[prog]) return head(1).buffer();
    if (vers < progs[prog][0] || vers > progs[prog][1]) return head(2, progs[prog]).buffer();
    const out = head(0);
    let ok;
    try {
      if (prog === PMAP) ok = this._pmap(proc, r, out);
      else if (prog === MOUNT) ok = this._mount(proc, r, out, ctx);
      else ok = await this._nfs(proc, r, out, ctx);
    } catch (e) {
      if (e instanceof RangeError) return head(4).buffer(); // GARBAGE_ARGS
      this.emit('log', `NFS: proc ${proc} failed: ${e.message}`);
      return head(5).buffer(); // SYSTEM_ERR
    }
    if (!ok) return head(3).buffer(); // PROC_UNAVAIL
    return out.buffer();
  }

  // ---------- PORTMAP v2 ----------

  _mappings() {
    const m = [];
    for (const prog of [[PMAP, 2], [MOUNT, 3], [NFS, 3]]) {
      m.push([prog[0], prog[1], IPPROTO_TCP, prog[0] === PMAP ? this.pmapActive || this.port : this.port]);
      if (this.udpPort) m.push([prog[0], prog[1], IPPROTO_UDP, prog[0] === PMAP ? this.pmapActive || this.port : this.port]);
    }
    return m;
  }

  _pmap(proc, r, w) {
    switch (proc) {
      case 0:
        return true;
      case 1: // SET
      case 2: // UNSET
        w.bool(false);
        return true;
      case 3: {
        const prog = r.u32();
        const vers = r.u32();
        const prot = r.u32();
        const hit = this._mappings().find((m) => m[0] === prog && m[1] === vers && m[2] === prot);
        w.u32(hit ? hit[3] : 0);
        return true;
      }
      case 4:
        for (const m of this._mappings()) w.u32(1).u32(m[0]).u32(m[1]).u32(m[2]).u32(m[3]);
        w.u32(0);
        return true;
      default:
        return false;
    }
  }

  // ---------- exports and the node table ----------

  _exports() {
    const list = [];
    for (const e of this.exportsFn() || []) {
      if (e && e.iso) list.push({ path: normExportPath(e.path), iso: e.iso });
    }
    return list;
  }

  _vkey(p) {
    return hash('v:' + p);
  }

  _intern(node) {
    const hex = node.key.toString('hex');
    const have = this.nodes.get(hex);
    if (have) return have;
    node.hex = hex;
    this.nodes.set(hex, node);
    return node;
  }

  _vnode(p) {
    return this._intern({ kind: 'v', path: p, key: this._vkey(p).subarray(0, 16) });
  }

  _inode(exp, ipath, entry, parent) {
    const key = hash('i:' + exp.path + '\0' + ipath).subarray(0, 16);
    const n = this._intern({ kind: 'i', exp, ipath, entry, parent, key });
    if (!n.entry) n.entry = entry;
    if (!n.parent) n.parent = parent;
    // keep the iso of the live export (an image may have been re-added)
    n.exp = exp;
    return n;
  }

  _rootOf(exp) {
    const parentPath = exp.path === '/' ? null : exp.path.split('/').slice(0, -1).join('/') || '/';
    const root = this._inode(exp, '/', exp.iso.root || exp.iso.lookup('/'), parentPath ? this._vnode(parentPath) : null);
    if (!root.parent && parentPath) root.parent = this._vnode(parentPath);
    return root;
  }

  // Virtual directory (a path that is a strict prefix of one or more export paths): its child names.
  _vchildren(p, exps) {
    const pre = p === '/' ? '/' : p + '/';
    const names = new Set();
    for (const e of exps) if (e.path !== p && e.path.startsWith(pre)) names.add(e.path.slice(pre.length).split('/')[0]);
    return [...names].sort();
  }

  // Resolve an absolute server path (as sent to MNT) to a node, or an error status.
  _resolvePath(p) {
    const exps = this._exports();
    const path = normExportPath(p);
    let best = null;
    for (const e of exps) if (path === e.path || path.startsWith(e.path === '/' ? '/' : e.path + '/')) if (!best || e.path.length > best.path.length) best = e;
    if (best) {
      let node = this._rootOf(best);
      const rest = path === best.path ? [] : path.slice(best.path === '/' ? 1 : best.path.length + 1).split('/');
      for (const seg of rest) {
        const r = this._lookupIn(node, seg, exps);
        if (r.status) return { status: r.status === S.NOTDIR ? 20 : 2 };
        node = r.node;
      }
      return { node };
    }
    if (path === '/' || this._vchildren(path, exps).length) return { node: this._vnode(path) };
    return { status: 2 };
  }

  _isoChildren(node) {
    if (!node.entry.isDir) return null;
    const iso = node.exp.iso;
    const entries = iso.readDir(node.entry);
    if (!entries._byName) Object.defineProperty(entries, '_byName', { value: new Map(entries.map((e) => [e.name, e])), enumerable: false });
    return entries;
  }

  // lookup(dir node, name) -> {node} | {status}
  _lookupIn(dir, name, exps) {
    if (name === '.') return { node: dir };
    if (dir.kind === 'v') {
      exps = exps || this._exports();
      if (name === '..') return { node: this._vnode(dir.path === '/' ? '/' : dir.path.split('/').slice(0, -1).join('/') || '/') };
      const childPath = (dir.path === '/' ? '' : dir.path) + '/' + name;
      const exact = exps.find((e) => e.path === childPath);
      if (exact) return { node: this._rootOf(exact) };
      if (this._vchildren(childPath, exps).length) return { node: this._vnode(childPath) };
      return { status: S.NOENT };
    }
    if (!dir.entry.isDir) return { status: S.NOTDIR };
    if (name === '..') return { node: dir.parent || dir };
    const entries = this._isoChildren(dir);
    const e = entries._byName.get(name);
    if (!e) return { status: S.NOENT };
    return { node: this._inode(dir.exp, (dir.ipath === '/' ? '' : dir.ipath) + '/' + name, e, dir) };
  }

  // ---------- attributes ----------

  _isDir(n) {
    return n.kind === 'v' || n.entry.isDir;
  }

  _fattr(w, n) {
    let type;
    let mode;
    let nlink = 1;
    let size = 0;
    let mtime = DEFAULT_TIME;
    let fsidSrc;
    if (n.kind === 'v') {
      type = 2;
      mode = 0o555;
      nlink = 2;
      fsidSrc = '/';
    } else {
      const e = n.entry;
      fsidSrc = n.exp.path;
      mtime = e.mtime || DEFAULT_TIME;
      if (e.isDir) {
        type = 2;
        mode = e.mode ? e.mode & 0o555 : 0o555;
        nlink = 2;
      } else if (e.isSymlink) {
        type = 5;
        mode = 0o777;
        size = Buffer.byteLength(e.link || '');
      } else {
        type = 1;
        mode = e.mode ? e.mode & 0o555 : 0o444;
        size = e.size;
      }
      if (type !== 5 && !(mode & 0o444)) mode |= 0o444;
    }
    w.u32(type).u32(mode).u32(nlink).u32(0).u32(0);
    w.u64(size).u64(type === 1 ? Math.ceil(size / 4096) * 4096 : 0);
    w.u32(0).u32(0); // rdev
    w.u32(hash('fsid:' + fsidSrc).readUInt32BE(0) >>> 1).u32(hash('fsid:' + fsidSrc).readUInt32BE(4)); // fsid
    const fid = n.key.readUInt32BE(0) & 0x7fffffff;
    w.u32(fid).u32(n.key.readUInt32BE(4)); // fileid
    for (let i = 0; i < 3; i++) w.u32(mtime).u32(0); // atime, mtime, ctime
  }

  _postOp(w, n) {
    if (!n) return w.bool(false);
    w.bool(true);
    this._fattr(w, n);
  }

  _fileid(n) {
    return (n.key.readUInt32BE(0) & 0x7fffffff) * 4294967296 + n.key.readUInt32BE(4);
  }

  _getNode(r) {
    const fh = r.opaque(64);
    if (fh.length !== 16) return { status: S.BADHANDLE };
    const n = this.nodes.get(fh.toString('hex'));
    if (!n) return { status: S.STALE };
    return { node: n };
  }

  // ---------- MOUNT v3 ----------

  _mount(proc, r, w, ctx) {
    switch (proc) {
      case 0:
        return true;
      case 1: {
        // MNT
        const path = r.string(1024);
        if (path.length > 1024) return w.u32(63) && true;
        const res = this._resolvePath(path);
        if (res.status) {
          w.u32(res.status);
          this.emit('log', `NFS: ${ctx.ip} MNT ${path} -> not found`);
          return true;
        }
        if (!this._isDir(res.node)) {
          w.u32(S.NOTDIR);
          return true;
        }
        this.mounts.set(`${ctx.ip}|${normExportPath(path)}`, { host: ctx.ip, path: normExportPath(path) });
        this.emit('log', `NFS: ${ctx.ip} mounted ${normExportPath(path)}`);
        w.u32(0).opaque(res.node.key);
        w.u32(2).u32(1).u32(0); // auth flavors: AUTH_SYS, AUTH_NONE
        return true;
      }
      case 2: // DUMP
        for (const m of this.mounts.values()) w.u32(1).string(m.host).string(m.path);
        w.u32(0);
        return true;
      case 3: {
        // UMNT
        const path = normExportPath(r.string(1024));
        this.mounts.delete(`${ctx.ip}|${path}`);
        return true;
      }
      case 4: // UMNTALL
        for (const k of [...this.mounts.keys()]) if (k.startsWith(ctx.ip + '|')) this.mounts.delete(k);
        return true;
      case 5: {
        // EXPORT
        const exps = this._exports();
        const paths = new Set(['/', ...exps.map((e) => e.path)]);
        for (const p of paths) w.u32(1).string(p).u32(0); // value follows, name, empty group list (everyone)
        w.u32(0);
        return true;
      }
      default:
        return false;
    }
  }

  // ---------- NFS v3 ----------

  async _nfs(proc, r, w, ctx) {
    const readLimit = ctx.udp ? MAX_READ_UDP : MAX_READ_TCP;
    switch (proc) {
      case 0:
        return true;
      case 1: {
        // GETATTR
        const { node, status } = this._getNode(r);
        if (status) return !!w.u32(status);
        w.u32(0);
        this._fattr(w, node);
        return true;
      }
      case 3: {
        // LOOKUP
        const { node: dir, status } = this._getNode(r);
        const name = r.string(1024);
        if (status) return !!w.u32(status).bool(false);
        if (!this._isDir(dir)) return !!w.u32(S.NOTDIR).bool(false) || true;
        if (Buffer.byteLength(name) > 255) return !!w.u32(S.NAMETOOLONG);
        const res = this._lookupIn(dir, name);
        if (res.status) {
          w.u32(res.status);
          this._postOp(w, dir);
          return true;
        }
        w.u32(0).opaque(res.node.key);
        this._postOp(w, res.node);
        this._postOp(w, dir);
        return true;
      }
      case 4: {
        // ACCESS
        const { node, status } = this._getNode(r);
        const want = r.u32();
        if (status) return !!w.u32(status).bool(false);
        let allow = 1; // READ
        if (this._isDir(node)) allow |= 2 | 0x20; // LOOKUP, EXECUTE
        else if (node.entry.mode && node.entry.mode & 0o111) allow |= 0x20;
        w.u32(0);
        this._postOp(w, node);
        w.u32(want & allow);
        return true;
      }
      case 5: {
        // READLINK
        const { node, status } = this._getNode(r);
        if (status) return !!w.u32(status).bool(false);
        if (node.kind !== 'i' || !node.entry.isSymlink) {
          w.u32(S.INVAL);
          this._postOp(w, node);
          return true;
        }
        w.u32(0);
        this._postOp(w, node);
        w.string(node.entry.link || '');
        return true;
      }
      case 6:
        return this._read(r, w, readLimit);
      case 16:
      case 17:
        return this._readdir(proc === 17, r, w);
      case 18: {
        // FSSTAT
        const { node, status } = this._getNode(r);
        if (status) return !!w.u32(status).bool(false);
        const total = node.kind === 'i' ? node.exp.iso.size || 0 : 0;
        w.u32(0);
        this._postOp(w, node);
        w.u64(total).u64(0).u64(0).u64(0).u64(0).u64(0).u32(0);
        return true;
      }
      case 19: {
        // FSINFO
        const { node, status } = this._getNode(r);
        if (status) return !!w.u32(status).bool(false);
        w.u32(0);
        this._postOp(w, node);
        w.u32(readLimit).u32(readLimit).u32(4096); // rtmax rtpref rtmult
        w.u32(readLimit).u32(readLimit).u32(4096); // wtmax wtpref wtmult (writes are refused anyway)
        w.u32(32768); // dtpref
        w.u32(0x7fffffff).u32(0xffffffff); // maxfilesize
        w.u32(1).u32(0); // time_delta
        w.u32(0x02 | 0x08); // SYMLINK | HOMOGENEOUS
        return true;
      }
      case 20: {
        // PATHCONF
        const { node, status } = this._getNode(r);
        if (status) return !!w.u32(status).bool(false);
        w.u32(0);
        this._postOp(w, node);
        w.u32(1).u32(255).bool(true).bool(true).bool(false).bool(true);
        return true;
      }
      // read-only: every modifying procedure answers NFS3ERR_ROFS with empty wcc data
      case 2: // SETATTR
      case 7: // WRITE
      case 8: // CREATE
      case 9: // MKDIR
      case 10: // SYMLINK
      case 11: // MKNOD
      case 12: // REMOVE
      case 13: // RMDIR
      case 21: // COMMIT
        w.u32(S.ROFS).bool(false).bool(false);
        return true;
      case 14: // RENAME (two wcc)
        w.u32(S.ROFS).bool(false).bool(false).bool(false).bool(false);
        return true;
      case 15: // LINK (post_op_attr + wcc)
        w.u32(S.ROFS).bool(false).bool(false).bool(false);
        return true;
      default:
        return false;
    }
  }

  async _read(r, w, limit) {
    const { node, status } = this._getNode(r);
    const offset = r.u64();
    let count = r.u32();
    if (status) return !!w.u32(status).bool(false);
    if (this._isDir(node)) {
      w.u32(S.ISDIR);
      this._postOp(w, node);
      return true;
    }
    const e = node.entry;
    if (e.isSymlink) {
      w.u32(S.INVAL);
      this._postOp(w, node);
      return true;
    }
    count = Math.min(count, limit);
    const size = e.size;
    let data = Buffer.alloc(0);
    if (offset < size && count > 0) {
      const end = Math.min(offset + count, size) - 1;
      try {
        data = await collect(node.exp.iso.createReadStream(e, offset, end));
      } catch (err) {
        this.emit('log', `NFS: read error: ${err.message}`);
        w.u32(S.IO);
        this._postOp(w, node);
        return true;
      }
    }
    w.u32(0);
    this._postOp(w, node);
    w.u32(data.length).bool(offset + data.length >= size).opaque(data);
    return true;
  }

  _readdir(plus, r, w) {
    const { node, status } = this._getNode(r);
    const cookie = r.u64();
    r.fixed(8); // cookieverf: directories never change, any value is accepted
    let dircount;
    let maxcount;
    if (plus) {
      dircount = r.u32();
      maxcount = r.u32();
    } else {
      maxcount = r.u32();
      dircount = maxcount;
    }
    if (status) return !!w.u32(status).bool(false);
    if (!this._isDir(node)) {
      w.u32(S.NOTDIR);
      this._postOp(w, node);
      return true;
    }
    // full entry list: '.', '..', then the children (cookie = position + 1)
    const parent = node.kind === 'v' ? this._lookupIn(node, '..').node : node.parent || node;
    const exps = node.kind === 'v' ? this._exports() : null;
    let names;
    let childOf;
    if (node.kind === 'v') {
      names = this._vchildren(node.path, exps);
      childOf = (nm) => this._lookupIn(node, nm, exps).node;
    } else {
      const ents = this._isoChildren(node);
      names = ents.map((e) => e.name);
      childOf = (nm) => this._lookupIn(node, nm).node;
    }
    const total = names.length + 2;
    if (cookie > total) {
      w.u32(S.BAD_COOKIE);
      this._postOp(w, node);
      return true;
    }
    const verf = node.key.subarray(0, 8);
    const entryOverhead = plus ? 4 + 8 + 4 + 8 + 4 + FATTR_SIZE + 4 + 4 + 16 : 4 + 8 + 4 + 8;
    let used = 4 + 4 + FATTR_SIZE + 8 + 4 + 4; // status, post_op_attr, verf, list end marker, eof
    let dused = 0;
    const entries = [];
    let i = cookie; // cookie c = last entry returned (1-based position), so the next index is c
    for (; i < total; i++) {
      const nm = i === 0 ? '.' : i === 1 ? '..' : names[i - 2];
      const nb = Buffer.byteLength(nm);
      const sz = entryOverhead + ((nb + 3) & ~3);
      const dsz = 4 + 8 + xdrSize(nb) + 8; // READDIRPLUS dircount counts only fileid/name/cookie
      if (used + sz > maxcount || (plus && dused + dsz > dircount)) break;
      used += sz;
      dused += dsz;
      entries.push([i, nm]);
    }
    if (!entries.length && i < total) {
      w.u32(S.TOOSMALL);
      this._postOp(w, node);
      return true;
    }
    w.u32(0);
    this._postOp(w, node);
    w.fixed(verf);
    for (const [idx, nm] of entries) {
      const child = idx === 0 ? node : idx === 1 ? parent : childOf(nm);
      w.u32(1).u64(this._fileid(child)).string(nm).u64(idx + 1);
      if (plus) {
        this._postOp(w, child);
        w.bool(true).opaque(child.key);
      }
    }
    w.bool(false).bool(i >= total);
    return true;
  }
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

module.exports = { NfsServer, XdrReader, XdrWriter };
