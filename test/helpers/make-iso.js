'use strict';
// Tiny ISO 9660 writer used only by the tests (Rock Ridge NM names, multi-extent files).

const fs = require('fs');
const SECTOR = 2048;

function both32(n) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(n, 0);
  b.writeUInt32BE(n, 4);
  return b;
}
function both16(n) {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(n, 0);
  b.writeUInt16BE(n, 2);
  return b;
}

function record({ name, lba, size, isDir, rr, rrName, sp, multi }) {
  let nameBuf;
  if (name === '.') nameBuf = Buffer.from([0]);
  else if (name === '..') nameBuf = Buffer.from([1]);
  else nameBuf = Buffer.from(isDir ? name.toUpperCase().slice(0, 8) : name.toUpperCase().replace(/[^A-Z0-9_.]/g, '_').slice(0, 12) + ';1', 'latin1');
  const pad = nameBuf.length % 2 === 0 ? 1 : 0;
  const su = [];
  if (rr && sp) su.push(Buffer.from([0x53, 0x50, 7, 1, 0xbe, 0xef, 0]));
  if (rr && rrName) {
    const n = Buffer.from(rrName, 'utf8');
    su.push(Buffer.concat([Buffer.from([0x4e, 0x4d, 5 + n.length, 1, 0]), n]));
  }
  const suBuf = Buffer.concat(su);
  let len = 33 + nameBuf.length + pad + suBuf.length;
  if (len % 2) len++;
  const r = Buffer.alloc(len);
  r[0] = len;
  both32(lba).copy(r, 2);
  both32(size).copy(r, 10);
  r[25] = (isDir ? 2 : 0) | (multi ? 0x80 : 0);
  both16(1).copy(r, 28);
  r[32] = nameBuf.length;
  nameBuf.copy(r, 33);
  suBuf.copy(r, 33 + nameBuf.length + pad);
  return r;
}

/**
 * tree: { 'casper': { 'vmlinuz': Buffer }, '.disk': {...}, 'big.bin': { extents: [Buffer, Buffer] } }
 */
function makeIso(file, tree, { volumeId = 'TESTISO', rr = true } = {}) {
  const dirs = [];
  const files = [];
  const walk = (node, name, parent) => {
    const d = { name, node, parent, children: [] };
    dirs.push(d);
    for (const [k, v] of Object.entries(node)) {
      if (Buffer.isBuffer(v) || (v && v.extents)) {
        const f = { name: k, extents: Buffer.isBuffer(v) ? [v] : v.extents };
        files.push(f);
        d.children.push({ type: 'file', f });
      } else d.children.push({ type: 'dir', d: walk(v, k, d) });
    }
    return d;
  };
  const root = walk(tree, '', null);
  let next = 18;
  for (const d of dirs) {
    d.lba = next;
    d.size = SECTOR; // tests keep directories small
    next++;
  }
  for (const f of files) {
    f.lbas = f.extents.map((e) => {
      const l = next;
      next += Math.max(1, Math.ceil(e.length / SECTOR));
      return l;
    });
  }
  const total = next;
  const img = Buffer.alloc(total * SECTOR);

  // directories
  for (const d of dirs) {
    const recs = [
      record({ name: '.', lba: d.lba, size: d.size, isDir: true, rr, sp: rr && d === root }),
      record({ name: '..', lba: (d.parent || d).lba, size: SECTOR, isDir: true, rr }),
    ];
    for (const c of d.children) {
      if (c.type === 'dir') recs.push(record({ name: c.d.name, lba: c.d.lba, size: SECTOR, isDir: true, rr, rrName: c.d.name }));
      else
        c.f.extents.forEach((e, i) =>
          recs.push(record({ name: c.f.name, lba: c.f.lbas[i], size: e.length, isDir: false, rr, rrName: c.f.name, multi: i < c.f.extents.length - 1 }))
        );
    }
    const body = Buffer.concat(recs);
    if (body.length > SECTOR) throw new Error('test directory too big');
    body.copy(img, d.lba * SECTOR);
  }
  for (const f of files) f.extents.forEach((e, i) => e.copy(img, f.lbas[i] * SECTOR));

  // primary volume descriptor
  const pvd = img.subarray(16 * SECTOR, 17 * SECTOR);
  pvd[0] = 1;
  pvd.write('CD001', 1, 'latin1');
  pvd[6] = 1;
  pvd.write(volumeId.padEnd(32, ' '), 40, 'latin1');
  both32(total).copy(pvd, 80);
  both16(1).copy(pvd, 120);
  both16(1).copy(pvd, 124);
  both16(SECTOR).copy(pvd, 128);
  const rootRec = record({ name: '.', lba: root.lba, size: SECTOR, isDir: true, rr: false });
  rootRec.copy(pvd, 156);
  pvd[881] = 1;
  // terminator
  const term = img.subarray(17 * SECTOR, 18 * SECTOR);
  term[0] = 255;
  term.write('CD001', 1, 'latin1');
  term[6] = 1;
  fs.writeFileSync(file, img);
  return file;
}

module.exports = { makeIso };
