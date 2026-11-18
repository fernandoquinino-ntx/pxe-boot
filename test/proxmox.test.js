'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { makeIso } = require('./helpers/make-iso');
const { IsoImage } = require('../src/core/iso9660');
const { detect, bootArgs, extraInitrds } = require('../src/core/detect');
const { buildMenu } = require('../src/core/ipxe-menu');
const { cpioSingleFile } = require('../src/core/cpio');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxepve-'));
const toBuf = (s) => new Promise((res, rej) => { const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => res(Buffer.concat(c))); s.on('error', rej); });
const hasCpio = (() => { try { execFileSync('cpio', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('cpio wrapper: valid newc archive, ranges match the full stream', async () => {
  const f = path.join(tmp, 'data.bin');
  const data = Buffer.from(Array.from({ length: 10007 }, (_, i) => i % 251));
  fs.writeFileSync(f, data);
  const c = cpioSingleFile('proxmox.iso', f);
  const full = await toBuf(c.stream());
  assert.equal(full.length, c.size);
  assert.equal(full.length % 512, 0);
  assert.equal(full.subarray(0, 6).toString(), '070701');
  for (const [s, e] of [[0, 99], [100, 5000], [10050, c.size - 1], [c.size - 3, c.size - 1]]) {
    assert.ok((await toBuf(c.stream(s, e))).equals(full.subarray(s, e + 1)), `range ${s}-${e}`);
  }
  if (hasCpio) {
    const out = path.join(tmp, 'x');
    fs.mkdirSync(out);
    execFileSync('cpio', ['-id', '--quiet'], { cwd: out, input: full });
    assert.ok(fs.readFileSync(path.join(out, 'proxmox.iso')).equals(data));
  }
});

test('detects Proxmox, serves it as RAM-loaded second initrd; Nutanix is flagged unsupported', () => {
  const pve = new IsoImage(makeIso(path.join(tmp, 'pve.iso'), { boot: { linux26: Buffer.from('K'), 'initrd.img': Buffer.from('I') }, '.pve-cd-id.txt': Buffer.from('1') }, { volumeId: 'PVE' }));
  const info = detect(pve);
  assert.equal(info.supported, true);
  assert.equal(info.family, 'proxmox');
  assert.equal(info.kernel, '/boot/linux26');
  assert.match(bootArgs({ ...info, id: 'p1' }, 'http://h:1'), /ramdisk_size=16777216/);
  assert.deepEqual(extraInitrds({ ...info, id: 'p1' }, 'http://h:1'), [{ name: 'proxmox.iso', url: 'http://h:1/pveiso/p1.cpio' }]);
  const menu = buildMenu([{ ...info, id: 'p1', label: 'Proxmox VE', status: 'ready' }], { base: 'http://h:1' });
  assert.match(menu, /initrd --name proxmox.iso http:\/\/h:1\/pveiso\/p1.cpio \/proxmox.iso/);

  const nut = new IsoImage(makeIso(path.join(tmp, 'nut.iso'), { images: { pxeboot: { vmlinuz: Buffer.from('K'), 'initrd.img': Buffer.from('I') } } }, { volumeId: 'PHOENIX' }));
  const ni = detect(nut);
  assert.equal(ni.supported, false);
  assert.equal(ni.family, 'nutanix');
  assert.match(ni.reason, /USB/);
  assert.match(ni.reason, /PHOENIX/);
});
