'use strict';
// Minimal ISO 9660 reader with Rock Ridge and Joliet long names.
// Lets the app serve kernels, initrds, squashfs images and full install
// trees straight out of a downloaded .iso, without extracting it.

const fs = require('fs');
const { Readable } = require('stream');

const SECTOR = 2048;

class IsoImage {
  constructor(file) {
    this.file = file;
    this.fd = fs.openSync(file, 'r');
    this.size = fs.fstatSync(this.fd).size;
    this.dirCache = new Map();
    this._readVolumeDescriptors();
  }

  close() {
    if (this.fd != null) fs.closeSync(this.fd);
    this.fd = null;
  }

  _read(pos, len) {
    const b = Buffer.alloc(len);
    const n = fs.readSync(this.fd, b, 0, len, pos);
    return n === len ? b : b.subarray(0, n);
  }

  _readVolumeDescriptors() {
    let primary = null;
    let joliet = null;
    for (let s = 16; s < 64; s++) {
      const d = this._read(s * SECTOR, SECTOR);
      if (d.length < SECTOR || d.toString('latin1', 1, 6) !== 'CD001') break;
      const type = d[0];
      if (type === 255) break;
      if (type === 1 && !primary) primary = d;
      if (type === 2) {
        const esc = d.toString('latin1', 88, 91);
        if (['%/@', '%/C', '%/E'].includes(esc)) joliet = d;
      }
    }
    if (!primary) throw new Error('Not an ISO 9660 image');
    this.volumeId = primary.toString('latin1', 40, 72).trim();
    const rootRec = this._parseRecord(primary, 156, false);
    // Rock Ridge is detected from the "." entry of the root directory (SUSP "SP"/"RR"/"NM")
    this.rockRidge = this._detectRockRidge(rootRec);
    if (this.rockRidge || !joliet) {
      this.mode = this.rockRidge ? 'rockridge' : 'iso';
      this.root = rootRec;
    } else {
      this.mode = 'joliet';
      this.root = this._parseRecord(joliet, 156, true);
    }
  }

  _detectRockRidge(rootRec) {
    const d = this._read(rootRec.extents[0].lba * SECTOR, SECTOR);
    const len = d[0];
    if (!len) return false;
    const nameLen = d[32];
    let su = 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0);
    const area = d.subarray(su, len);
    for (let i = 0; i + 4 <= area.length; ) {
      const sig = area.toString('latin1', i, i + 2);
      const l = area[i + 2];
      if (sig === 'SP' || sig === 'RR' || sig === 'ER' || sig === 'PX') return true;
      if (!l) break;
      i += l;
    }
    return false;
  }

  _parseRecord(buf, off, joliet) {
    const len = buf[off];
    const lba = buf.readUInt32LE(off + 2);
    const size = buf.readUInt32LE(off + 10);
    const flags = buf[off + 25];
    const nameLen = buf[off + 32];
    const rawName = buf.subarray(off + 33, off + 33 + nameLen);
    let name;
    if (nameLen === 1 && (rawName[0] === 0 || rawName[0] === 1)) name = rawName[0] === 0 ? '.' : '..';
    else if (joliet) {
      // UCS-2 big-endian
      const swapped = Buffer.from(rawName);
      for (let i = 0; i + 1 < swapped.length; i += 2) [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
      name = swapped.toString('utf16le').replace(/;\d+$/, '');
    } else {
      name = rawName.toString('latin1').replace(/;\d+$/, '').replace(/\.$/, '');
    }
    let suStart = off + 33 + nameLen + (nameLen % 2 === 0 ? 1 : 0);
    const su = buf.subarray(suStart, off + len);
    return { name, isDir: !!(flags & 2), multiExtent: !!(flags & 0x80), extents: [{ lba, size }], size, su };
  }

  _rrName(su) {
    // Collect NM components, following CE continuation areas.
    let name = '';
    let found = false;
    const walk = (area, depth) => {
      for (let i = 0; i + 4 <= area.length; ) {
        const sig = area.toString('latin1', i, i + 2);
        const l = area[i + 2];
        if (!l || i + l > area.length) break;
        if (sig === 'NM') {
          const flags = area[i + 4];
          if (!(flags & 0x06)) {
            name += area.toString('utf8', i + 5, i + l);
            found = true;
          }
        } else if (sig === 'CE' && depth < 4) {
          const blk = area.readUInt32LE(i + 4);
          const offs = area.readUInt32LE(i + 12);
          const clen = area.readUInt32LE(i + 20);
          walk(this._read(blk * SECTOR + offs, clen), depth + 1);
        } else if (sig === 'ST') break;
        i += l;
      }
    };
    walk(su, 0);
    return found ? name : null;
  }

  readDir(rec) {
    const key = rec.extents[0].lba;
    if (this.dirCache.has(key)) return this.dirCache.get(key);
    const data = this._read(rec.extents[0].lba * SECTOR, rec.extents[0].size);
    const entries = [];
    let pending = null;
    for (let off = 0; off < data.length; ) {
      const len = data[off];
      if (len === 0) {
        off = (Math.floor(off / SECTOR) + 1) * SECTOR;
        continue;
      }
      const r = this._parseRecord(data, off, this.mode === 'joliet');
      off += len;
      if (r.name === '.' || r.name === '..') continue;
      if (this.mode === 'rockridge') {
        const nm = this._rrName(r.su);
        if (nm) r.name = nm;
      } else if (this.mode === 'iso') {
        r.name = r.name.toLowerCase();
      }
      delete r.su;
      if (pending) {
        // continuation of a multi-extent file (files > 4 GiB)
        pending.extents.push(r.extents[0]);
        pending.size += r.size;
        if (!r.multiExtent) {
          entries.push(pending);
          pending = null;
        }
        continue;
      }
      if (r.multiExtent) {
        pending = r;
        continue;
      }
      entries.push(r);
    }
    if (pending) entries.push(pending);
    this.dirCache.set(key, entries);
    return entries;
  }

  // Case-insensitive path lookup. Returns null when not found.
  lookup(p) {
    const parts = p.split('/').filter(Boolean);
    let cur = this.root;
    for (const part of parts) {
      if (!cur.isDir) return null;
      const entries = this.readDir(cur);
      let next = entries.find((e) => e.name === part);
      if (!next) next = entries.find((e) => e.name.toLowerCase() === part.toLowerCase());
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  list(p) {
    const d = this.lookup(p);
    if (!d || !d.isDir) return [];
    return this.readDir(d).map((e) => ({ name: e.name, isDir: e.isDir, size: e.size }));
  }

  readFile(p, max = 1024 * 1024) {
    const e = this.lookup(p);
    if (!e || e.isDir) return null;
    return this._read(e.extents[0].lba * SECTOR, Math.min(e.size, max, e.extents[0].size));
  }

  // Stream bytes [start, end] (inclusive) of a file entry.
  createReadStream(entry, start = 0, end = entry.size - 1) {
    const fd = fs.openSync(this.file, 'r');
    const segments = [];
    let base = 0;
    for (const ext of entry.extents) {
      const s0 = Math.max(start, base);
      const s1 = Math.min(end, base + ext.size - 1);
      if (s0 <= s1) segments.push({ pos: ext.lba * SECTOR + (s0 - base), len: s1 - s0 + 1 });
      base += ext.size;
    }
    let seg = 0;
    const CHUNK = 256 * 1024;
    return new Readable({
      read() {
        if (seg >= segments.length) return this.push(null);
        const cur = segments[seg];
        const n = Math.min(CHUNK, cur.len);
        const buf = Buffer.alloc(n);
        fs.read(fd, buf, 0, n, cur.pos, (err, got) => {
          if (err) return this.destroy(err);
          cur.pos += got;
          cur.len -= got;
          if (cur.len <= 0) seg++;
          this.push(got === n ? buf : buf.subarray(0, got));
        });
      },
      destroy(err, cb) {
        fs.close(fd, () => cb(err));
      },
    });
  }
}

module.exports = { IsoImage, SECTOR };
