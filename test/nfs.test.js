'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { makeIso } = require('./helpers/make-iso');
const { IsoImage } = require('../src/core/iso9660');
const { NfsServer, XdrReader, XdrWriter } = require('../src/core/nfs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxenfs-'));

// ---------- tiny ONC RPC / XDR client (TCP record marking, or UDP) ----------

class Rpc {
  constructor(sock, udp) {
    this.sock = sock;
    this.udp = udp;
    this.xid = 1;
    this.waiters = new Map();
    this.buf = Buffer.alloc(0);
    if (udp) sock.on('message', (m) => this._reply(m));
    else
      sock.on('data', (d) => {
        this.buf = Buffer.concat([this.buf, d]);
        for (;;) {
          if (this.buf.length < 4) return;
          const len = this.buf.readUInt32BE(0) & 0x7fffffff;
          if (this.buf.length < 4 + len) return;
          this._reply(this.buf.subarray(4, 4 + len));
          this.buf = this.buf.subarray(4 + len);
        }
      });
  }
  _reply(m) {
    const w = this.waiters.get(m.readUInt32BE(0));
    if (w) w(m);
  }
  call(prog, vers, proc, args = Buffer.alloc(0)) {
    const xid = this.xid++;
    const w = new XdrWriter().u32(xid).u32(0).u32(2).u32(prog).u32(vers).u32(proc);
    w.u32(1).opaque(Buffer.alloc(20)).u32(0).opaque(Buffer.alloc(0)); // AUTH_UNIX (garbage body is fine), AUTH_NONE
    const rec = Buffer.concat([w.buffer(), args]);
    return new Promise((resolve) => {
      this.waiters.set(xid, (m) => {
        const r = new XdrReader(m, 4);
        assert.equal(r.u32(), 1); // REPLY
        assert.equal(r.u32(), 0); // accepted
        r.u32();
        r.opaque();
        const stat = r.u32();
        resolve({ stat, r });
      });
      if (this.udp) this.sock.send(rec, this.port, '127.0.0.1');
      else {
        const h = Buffer.alloc(4);
        h.writeUInt32BE((0x80000000 | rec.length) >>> 0);
        this.sock.write(Buffer.concat([h, rec]));
      }
    });
  }
  close() {
    if (this.udp) this.sock.close();
    else this.sock.destroy();
  }
}
const tcpClient = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(new Rpc(s, false)));
  });
const udpClient = (port) => {
  const c = new Rpc(dgram.createSocket('udp4'), true);
  c.port = port;
  return c;
};

const args = (fn) => {
  const w = new XdrWriter();
  fn(w);
  return w.buffer();
};
const fhArg = (fh) => args((w) => w.opaque(fh));
const NFS = (c, proc, a) => c.call(100003, 3, proc, a);
const MOUNT = (c, proc, a) => c.call(100005, 3, proc, a);

// skip a fattr3 (84 bytes) and return key fields
function fattr(r) {
  const type = r.u32();
  const mode = r.u32();
  const nlink = r.u32();
  r.u32();
  r.u32();
  const size = r.u64();
  const used = r.u64();
  r.fixed(8 + 8 + 8);
  const mtime = r.u32();
  r.u32();
  r.fixed(16);
  return { type, mode, nlink, size, used, mtime };
}
const postOp = (r) => (r.u32() ? fattr(r) : null);

async function mnt(c, p) {
  const { stat, r } = await MOUNT(c, 1, args((w) => w.string(p)));
  assert.equal(stat, 0);
  const st = r.u32();
  if (st) return { status: st };
  return { status: 0, fh: Buffer.from(r.opaque()) };
}
async function lookup(c, dir, name) {
  const { r } = await NFS(c, 3, args((w) => w.opaque(dir).string(name)));
  const st = r.u32();
  if (st) return { status: st };
  const fh = Buffer.from(r.opaque());
  return { status: 0, fh, attr: postOp(r) };
}
async function read(c, fh, off, count) {
  const { r } = await NFS(c, 6, args((w) => w.opaque(fh).u64(off).u32(count)));
  const st = r.u32();
  if (st) return { status: st };
  postOp(r);
  const n = r.u32();
  const eof = !!r.u32();
  const data = Buffer.from(r.opaque(8 << 20));
  assert.equal(data.length, n);
  return { status: 0, data, eof };
}
async function readdirplus(c, fh, cookie, verf, dircount, maxcount) {
  const { r } = await NFS(c, 17, args((w) => w.opaque(fh).u64(cookie).fixed(verf).u32(dircount).u32(maxcount)));
  const st = r.u32();
  if (st) return { status: st };
  postOp(r);
  const v = Buffer.from(r.fixed(8));
  const entries = [];
  while (r.u32()) {
    const fileid = r.u64();
    const name = r.string();
    const ck = r.u64();
    const attr = postOp(r);
    const fh = r.u32() ? Buffer.from(r.opaque()) : null;
    entries.push({ fileid, name, cookie: ck, attr, fh });
  }
  return { status: 0, verf: v, entries, eof: !!r.u32() };
}

// ---------- test images ----------

const a = Buffer.alloc(5000, 1);
const b = Buffer.alloc(3000, 2);
const isoFile = makeIso(path.join(tmp, 'nfs.iso'), {
  casper: { vmlinuz: Buffer.from('KERNEL'), initrd: Buffer.from('INITRD'), 'filesystem.squashfs': { extents: [a, b] } },
  '.disk': { info: Buffer.from('hello disk\n') },
  'readme.txt': Buffer.from('readme'),
});

// a fake image with a 6 GiB file whose bytes are a function of the position (offsets beyond 4 GiB)
const BIG = 6 * 1024 * 1024 * 1024 + 123;
const patternAt = (p) => (p * 7 + Math.floor(p / 65536)) & 0xff;
const bigEntry = { name: 'big.bin', isDir: false, size: BIG, extents: [{ lba: 1, size: BIG }], mtime: 1700000000, mode: 0o100644 };
const manyEntries = Array.from({ length: 250 }, (_, i) => ({ name: `file-${String(i).padStart(4, '0')}-with-a-longer-name.txt`, isDir: false, size: i, extents: [], mtime: 0 }));
const fakeRoot = { name: '', isDir: true, size: 2048, extents: [{ lba: 1, size: 2048 }], mtime: 1700000000, mode: 0o40755 };
const fakeDir = { name: 'many', isDir: true, size: 2048, extents: [{ lba: 2, size: 2048 }], mtime: 0 };
const linkEntry = { name: 'lnk', isDir: false, size: 0, extents: [], isSymlink: true, link: '../big.bin', mode: 0o120777 };
const fakeIso = {
  root: fakeRoot,
  size: BIG,
  lookup: (p) => (p === '/' ? fakeRoot : null),
  readDir: (e) => (e === fakeRoot ? [bigEntry, fakeDir, linkEntry] : e === fakeDir ? manyEntries : []),
  createReadStream: (e, start, end) => {
    const out = Buffer.alloc(end - start + 1);
    for (let i = 0; i < out.length; i++) out[i] = patternAt(start + i);
    return Readable.from([out]);
  },
};

let server;
let ports;
let iso;
const logs = [];

test.before(async () => {
  iso = new IsoImage(isoFile);
  server = new NfsServer({
    port: 0,
    host: '127.0.0.1',
    portmapPort: 0,
    exports: () => [
      { path: '/iso/abc', iso },
      { path: '/iso/big', iso: fakeIso },
    ],
  });
  server.on('log', (m) => logs.push(m));
  await server.start();
  ports = { nfs: server.port, pmap: server.pmapActive, udp: server.udpPort };
});
test.after(() => {
  server.stop();
  iso.close();
});

test('portmap: NULL, GETPORT and DUMP', async () => {
  const c = await tcpClient(ports.pmap);
  assert.equal((await c.call(100000, 2, 0)).stat, 0);
  for (const [prog, vers] of [[100003, 3], [100005, 3]]) {
    const { r } = await c.call(100000, 2, 3, args((w) => w.u32(prog).u32(vers).u32(6).u32(0)));
    assert.equal(r.u32(), ports.nfs);
  }
  const udp = await c.call(100000, 2, 3, args((w) => w.u32(100003).u32(3).u32(17).u32(0)));
  assert.equal(udp.r.u32(), ports.udp);
  const none = await c.call(100000, 2, 3, args((w) => w.u32(100003).u32(2).u32(6).u32(0))); // NFSv2 is not offered
  assert.equal(none.r.u32(), 0);
  const dump = (await c.call(100000, 2, 4)).r;
  const seen = [];
  while (dump.u32()) seen.push([dump.u32(), dump.u32(), dump.u32(), dump.u32()].join('/'));
  assert.ok(seen.includes(`100003/3/6/${ports.nfs}`));
  assert.ok(seen.includes(`100005/3/6/${ports.nfs}`));
  // wrong versions get PROG_MISMATCH; unknown programs PROG_UNAVAIL
  assert.equal((await c.call(100003, 2, 0)).stat, 2);
  assert.equal((await c.call(123456, 1, 0)).stat, 1);
  c.close();
});

test('mount: export list, MNT of export, subdirectory, virtual dirs and bad paths', async () => {
  const c = await tcpClient(ports.nfs);
  const ex = (await MOUNT(c, 5)).r;
  const paths = [];
  while (ex.u32()) {
    paths.push(ex.string());
    assert.equal(ex.u32(), 0);
  }
  assert.deepEqual(paths.sort(), ['/', '/iso/abc', '/iso/big']);
  assert.equal((await mnt(c, '/iso/abc')).status, 0);
  assert.equal((await mnt(c, '/iso/abc/casper')).status, 0);
  assert.equal((await mnt(c, '/')).status, 0);
  assert.equal((await mnt(c, '/iso')).status, 0);
  assert.equal((await mnt(c, '/nope')).status, 2);
  assert.equal((await mnt(c, '/iso/abc/casper/nothere')).status, 2);
  assert.equal((await mnt(c, '/iso/abc/casper/vmlinuz')).status, 20);
  const dump = (await MOUNT(c, 2)).r;
  assert.equal(dump.u32(), 1);
  assert.equal(dump.string(), '127.0.0.1');
  assert.equal((await MOUNT(c, 4)).stat, 0); // UMNTALL
  assert.equal((await MOUNT(c, 3, args((w) => w.string('/iso/abc')))).stat, 0);
  c.close();
});

test('lookup/getattr/read on a Rock Ridge ISO including a read across the multi-extent boundary', async () => {
  const c = await tcpClient(ports.nfs);
  const root = (await mnt(c, '/iso/abc')).fh;
  const g = (await NFS(c, 1, fhArg(root))).r;
  assert.equal(g.u32(), 0);
  const ra = fattr(g);
  assert.equal(ra.type, 2);
  assert.equal(ra.mode & 0o222, 0);
  const casper = await lookup(c, root, 'casper');
  assert.equal(casper.status, 0);
  assert.equal(casper.attr.type, 2);
  assert.equal((await lookup(c, root, 'missing')).status, 2);
  assert.equal((await lookup(c, root, 'readme.txt').then((x) => x.attr.size)), 6);
  const sq = await lookup(c, casper.fh, 'filesystem.squashfs');
  assert.equal(sq.attr.size, 8000);
  assert.equal(sq.attr.type, 1);
  const mid = await read(c, sq.fh, 4990, 20);
  assert.ok(mid.data.equals(Buffer.concat([Buffer.alloc(10, 1), Buffer.alloc(10, 2)])));
  assert.equal(mid.eof, false);
  const all = await read(c, sq.fh, 0, 1 << 20);
  assert.ok(all.data.equals(Buffer.concat([a, b])));
  assert.equal(all.eof, true);
  const past = await read(c, sq.fh, 9000, 10);
  assert.equal(past.data.length, 0);
  assert.equal(past.eof, true);
  assert.equal((await read(c, casper.fh, 0, 10)).status, 21); // EISDIR
  // '..' goes back up, and from an export root up into the virtual /iso directory
  const up = await lookup(c, casper.fh, '..');
  assert.ok(up.fh.equals(root));
  const virt = await lookup(c, root, '..');
  assert.equal(virt.attr.type, 2);
  const entries = (await readdirplus(c, virt.fh, 0, Buffer.alloc(8), 4096, 32768)).entries.map((e) => e.name);
  assert.deepEqual(entries, ['.', '..', 'abc', 'big']);
  // virtual root lists "iso"
  const vroot = (await mnt(c, '/')).fh;
  assert.deepEqual((await readdirplus(c, vroot, 0, Buffer.alloc(8), 4096, 32768)).entries.map((e) => e.name), ['.', '..', 'iso']);
  c.close();
});

test('read at offsets beyond 4 GiB with a 1 MiB count (64-bit offsets)', async () => {
  const c = await tcpClient(ports.nfs);
  const root = (await mnt(c, '/iso/big')).fh;
  const big = await lookup(c, root, 'big.bin');
  assert.equal(big.attr.size, BIG);
  const off = 5 * 1024 * 1024 * 1024 + 4097;
  const r1 = await read(c, big.fh, off, 1024 * 1024);
  assert.equal(r1.data.length, 1024 * 1024);
  assert.equal(r1.data[0], patternAt(off));
  assert.equal(r1.data[777777], patternAt(off + 777777));
  const tail = await read(c, big.fh, BIG - 10, 100);
  assert.equal(tail.data.length, 10);
  assert.equal(tail.eof, true);
  const over = await read(c, big.fh, 2 * 1024 * 1024, 4 * 1024 * 1024); // count is capped at 1 MiB
  assert.equal(over.data.length, 1024 * 1024);
  // symlinks
  const l = await lookup(c, root, 'lnk');
  assert.equal(l.attr.type, 5);
  const rl = (await NFS(c, 5, fhArg(l.fh))).r;
  assert.equal(rl.u32(), 0);
  postOp(rl);
  assert.equal(rl.string(), '../big.bin');
  c.close();
});

test('READDIRPLUS paging with cookies, limits and eof; plain READDIR', async () => {
  const c = await tcpClient(ports.nfs);
  const root = (await mnt(c, '/iso/big')).fh;
  const dir = (await lookup(c, root, 'many')).fh;
  const seen = [];
  let cookie = 0;
  let verf = Buffer.alloc(8);
  let pages = 0;
  for (;;) {
    const page = await readdirplus(c, dir, cookie, verf, 2048, 4096);
    assert.equal(page.status, 0);
    assert.ok(page.entries.length > 0);
    pages++;
    verf = page.verf;
    for (const e of page.entries) {
      assert.ok(e.attr && e.fh);
      seen.push(e.name);
      cookie = e.cookie;
    }
    if (page.eof) break;
    assert.ok(pages < 200);
  }
  assert.ok(pages > 5, 'multiple pages expected, got ' + pages);
  assert.equal(seen.length, 252);
  assert.deepEqual(seen.slice(2), manyEntries.map((e) => e.name));
  assert.deepEqual(seen.slice(0, 2), ['.', '..']);
  // too small a buffer for even one entry
  assert.equal((await readdirplus(c, dir, 0, verf, 10, 120)).status, 10005);
  // bad cookie
  assert.equal((await readdirplus(c, dir, 99999, verf, 4096, 4096)).status, 10003);
  // READDIR (no attributes)
  const { r } = await NFS(c, 16, args((w) => w.opaque(dir).u64(0).fixed(Buffer.alloc(8)).u32(1024)));
  assert.equal(r.u32(), 0);
  postOp(r);
  r.fixed(8);
  let n = 0;
  while (r.u32()) {
    r.u64();
    r.string();
    r.u64();
    n++;
  }
  assert.ok(n > 5 && n < 250);
  assert.equal(r.u32(), 0); // not eof
  c.close();
});

test('read-only: every modifying procedure answers NFS3ERR_ROFS', async () => {
  const c = await tcpClient(ports.nfs);
  const root = (await mnt(c, '/iso/abc')).fh;
  for (const proc of [2, 7, 8, 9, 10, 11, 12, 13, 14, 15, 21]) {
    const { r } = await NFS(c, proc, fhArg(root));
    assert.equal(r.u32(), 30, `proc ${proc}`);
  }
  c.close();
});

test('ACCESS, FSINFO, FSSTAT, PATHCONF, stale and bad handles', async () => {
  const c = await tcpClient(ports.nfs);
  const root = (await mnt(c, '/iso/abc')).fh;
  const ac = (await NFS(c, 4, args((w) => w.opaque(root).u32(0x3f)))).r;
  assert.equal(ac.u32(), 0);
  postOp(ac);
  const granted = ac.u32();
  assert.ok(granted & 1 && granted & 2);
  assert.equal(granted & (4 | 8 | 0x10), 0);
  const fi = (await NFS(c, 19, fhArg(root))).r;
  assert.equal(fi.u32(), 0);
  postOp(fi);
  assert.equal(fi.u32(), 1048576); // rtmax
  assert.equal(fi.u32(), 1048576); // rtpref
  const fs_ = (await NFS(c, 18, fhArg(root))).r;
  assert.equal(fs_.u32(), 0);
  postOp(fs_);
  assert.ok(fs_.u64() > 0);
  const pc = (await NFS(c, 20, fhArg(root))).r;
  assert.equal(pc.u32(), 0);
  assert.equal((await NFS(c, 1, fhArg(Buffer.alloc(16, 9)))).r.u32(), 70);
  assert.equal((await NFS(c, 1, fhArg(Buffer.alloc(5, 9)))).r.u32(), 10001);
  c.close();
});

test('NFS and MOUNT also answer over UDP (klibc nfsmount defaults to UDP)', async () => {
  const c = udpClient(ports.udp);
  const { status, fh } = await mnt(c, '/iso/abc');
  assert.equal(status, 0);
  const ci = await lookup(c, fh, 'casper');
  const sq = await lookup(c, ci.fh, 'filesystem.squashfs');
  const d = await read(c, sq.fh, 4000, 2000000);
  assert.equal(d.data.length, 4000);
  assert.ok(d.data.subarray(0, 1000).equals(Buffer.alloc(1000, 1)));
  const fi = (await NFS(c, 19, fhArg(fh))).r;
  fi.u32();
  postOp(fi);
  assert.equal(fi.u32(), 32768);
  c.close();
});

test('garbage and truncated requests do not crash the server', async () => {
  const c = await tcpClient(ports.nfs);
  const bad = await NFS(c, 6, Buffer.alloc(2)); // truncated args
  assert.equal(bad.stat, 4); // GARBAGE_ARGS
  c.sock.write(Buffer.from([0x80, 0, 0, 3, 1, 2, 3]));
  c.close();
  const c2 = await tcpClient(ports.nfs);
  assert.equal((await NFS(c2, 0)).stat, 0);
  c2.close();
});

test('port in use gives a friendly error and a busy portmap port never throws', async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busy = blocker.address().port;
  const s1 = new NfsServer({ port: busy, host: '127.0.0.1', portmapPort: null, exports: () => [] });
  await assert.rejects(s1.start(), /already in use/);
  const msgs = [];
  const s2 = new NfsServer({ port: 0, host: '127.0.0.1', portmapPort: busy, exports: () => [] });
  s2.on('log', (m) => msgs.push(m));
  await s2.start();
  assert.ok(msgs.some((m) => /portmap/.test(m) && /explicit port=/.test(m)));
  assert.equal(s2.pmapActive, null);
  s2.stop();
  blocker.close();
});
