'use strict';
// Wraps one file as a cpio "newc" archive, streamed on the fly (nothing is written to disk).
// Proxmox VE's installer looks for /proxmox.iso inside its initrd, so we hand iPXE a second
// initrd that contains the ISO; the kernel unpacks it next to the original one.

const fs = require('fs');
const { Readable } = require('stream');

const hex = (n) => n.toString(16).padStart(8, '0');
const pad4 = (n) => (4 - (n % 4)) % 4;

function header(name, size, mode) {
  const nameBuf = Buffer.from(name + '\0', 'utf8');
  const fields = [0, mode, 0, 0, 1, 0, size, 0, 0, 0, 0, nameBuf.length, 0];
  const h = Buffer.from('070701' + fields.map(hex).join(''), 'ascii');
  return Buffer.concat([h, nameBuf, Buffer.alloc(pad4(h.length + nameBuf.length))]);
}

function cpioSingleFile(name, file) {
  const fileSize = fs.statSync(file).size;
  const head = header(name, fileSize, 0o100644);
  const tail = Buffer.concat([Buffer.alloc(pad4(fileSize)), header('TRAILER!!!', 0, 0)]);
  // cpio archives are padded to 512 bytes by convention; harmless and keeps sizes tidy
  const total0 = head.length + fileSize + tail.length;
  const tailFull = Buffer.concat([tail, Buffer.alloc((512 - (total0 % 512)) % 512)]);
  const size = head.length + fileSize + tailFull.length;

  function stream(start = 0, end = size - 1) {
    async function* gen() {
      if (start < head.length) yield head.subarray(start, Math.min(end + 1, head.length));
      const fStart = Math.max(start - head.length, 0);
      const fEnd = Math.min(end - head.length, fileSize - 1);
      if (fileSize > 0 && fEnd >= fStart) yield* fs.createReadStream(file, { start: fStart, end: fEnd });
      const tStart = Math.max(start - head.length - fileSize, 0);
      const tEnd = end - head.length - fileSize;
      if (tEnd >= tStart && tEnd >= 0) yield tailFull.subarray(tStart, tEnd + 1);
    }
    return Readable.from(gen());
  }
  return { size, stream };
}

/** Small in-memory archive: entries = [{ name, data: Buffer|string, mode?: 0o755 }] */
function cpioArchive(entries) {
  const parts = [];
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    parts.push(header(e.name, data.length, 0o100000 | (e.mode ?? 0o644)), data, Buffer.alloc(pad4(data.length)));
  }
  parts.push(header('TRAILER!!!', 0, 0));
  const buf = Buffer.concat(parts);
  return Buffer.concat([buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]);
}

module.exports = { cpioSingleFile, cpioArchive };
