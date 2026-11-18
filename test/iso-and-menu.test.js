'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeIso } = require('./helpers/make-iso');
const { IsoImage } = require('../src/core/iso9660');
const { detect, bootArgs } = require('../src/core/detect');
const { buildMenu } = require('../src/core/ipxe-menu');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxeiso-'));
const streamToBuf = (s) => new Promise((res, rej) => { const c = []; s.on('data', (d) => c.push(d)); s.on('end', () => res(Buffer.concat(c))); s.on('error', rej); });

test('reads Rock Ridge names, case-insensitive lookup and multi-extent files', async () => {
  const a = Buffer.alloc(5000, 1);
  const b = Buffer.alloc(3000, 2);
  const f = makeIso(path.join(tmp, 'rr.iso'), {
    casper: { vmlinuz: Buffer.from('KERNEL'), 'initrd': Buffer.from('INITRD'), 'filesystem.squashfs': { extents: [a, b] } },
    '.disk': { info: Buffer.from('Ubuntu-Server 24.04.1 LTS "Noble Numbat" - Release amd64 (20240827.1)\n') },
  });
  const iso = new IsoImage(f);
  assert.equal(iso.mode, 'rockridge');
  assert.deepEqual(iso.list('/').map((e) => e.name).sort(), ['.disk', 'casper']);
  assert.equal(iso.readFile('/casper/vmlinuz').toString(), 'KERNEL');
  assert.equal(iso.readFile('/CASPER/VMLINUZ').toString(), 'KERNEL');
  const sq = iso.lookup('/casper/filesystem.squashfs');
  assert.equal(sq.size, 8000);
  assert.equal(sq.extents.length, 2);
  const all = await streamToBuf(iso.createReadStream(sq));
  assert.ok(all.equals(Buffer.concat([a, b])));
  const mid = await streamToBuf(iso.createReadStream(sq, 4990, 5009)); // crosses the extent boundary
  assert.ok(mid.equals(Buffer.concat([Buffer.alloc(10, 1), Buffer.alloc(10, 2)])));
  const info = detect(iso);
  assert.equal(info.family, 'ubuntu');
  assert.equal(info.label, 'Ubuntu-Server 24.04.1 LTS "Noble Numbat"');
  assert.equal(info.kernel, '/casper/vmlinuz');
  assert.equal(info.initrd, '/casper/initrd');
  iso.close();
});

test('plain ISO 9660 names (no Rock Ridge) still work', () => {
  const f = makeIso(path.join(tmp, 'plain.iso'), { images: { pxeboot: { vmlinuz: Buffer.from('K'), 'initrd.img': Buffer.from('I') } }, '.treeinfo': Buffer.from('[release]\nname = Rocky Linux\nversion = 9.5\n') }, { rr: false });
  const iso = new IsoImage(f);
  assert.equal(iso.mode, 'iso');
  const info = detect(iso);
  assert.equal(info.family, 'redhat-installer');
  assert.equal(info.label, 'Rocky Linux 9.5 (Installer)');
  assert.equal(bootArgs({ ...info, id: 'abcd' }, 'http://192.168.1.2:8080'), 'inst.repo=http://192.168.1.2:8080/iso/abcd/ ip=dhcp');
  iso.close();
});

test('detects Fedora live, Debian live, and rejects Debian netinst', () => {
  const fed = new IsoImage(makeIso(path.join(tmp, 'fed.iso'), { images: { pxeboot: { vmlinuz: Buffer.from('K'), 'initrd.img': Buffer.from('I') } }, LiveOS: { 'squashfs.img': Buffer.from('S') }, '.treeinfo': Buffer.from('[general]\nfamily = Fedora\nversion = 41\n') }));
  const fi = detect(fed);
  assert.equal(fi.family, 'fedora-live');
  assert.match(bootArgs({ ...fi, id: 'f1' }, 'http://h:1'), /root=live:http:\/\/h:1\/iso\/f1\/LiveOS\/squashfs.img rd.live.image/);

  const deb = new IsoImage(makeIso(path.join(tmp, 'deb.iso'), { live: { 'vmlinuz-6.1.0-27-amd64': Buffer.from('K'), 'initrd.img-6.1.0-27-amd64': Buffer.from('I'), 'filesystem.squashfs': Buffer.from('S') }, '.disk': { info: Buffer.from('Official Debian GNU/Linux Live 12.8.0 gnome 2024-11-09T11:21') } }));
  const di = detect(deb);
  assert.equal(di.family, 'debian-live');
  assert.equal(di.kernel, '/live/vmlinuz-6.1.0-27-amd64');
  assert.match(bootArgs({ ...di, id: 'd1' }, 'http://h:1'), /boot=live components fetch=http:\/\/h:1\/iso\/d1\/live\/filesystem.squashfs/);

  const net = new IsoImage(makeIso(path.join(tmp, 'netinst.iso'), { 'install.amd': { vmlinuz: Buffer.from('K') } }));
  const ni = detect(net);
  assert.equal(ni.supported, false);
  assert.match(ni.reason, /network installer/);
});

test('boot menu lists ready images and built-ins', () => {
  const menu = buildMenu(
    [
      { id: 'a1', label: 'Ubuntu 24.04', family: 'ubuntu', kernel: '/casper/vmlinuz', initrd: '/casper/initrd', supported: true, status: 'ready' },
      { id: 'b2', label: 'Still downloading', status: 'downloading' },
    ],
    { base: 'http://192.168.1.2:8080', builtins: { 'debian-netinst': true, netbootxyz: true } }
  );
  assert.match(menu, /^#!ipxe/);
  assert.match(menu, /item img-a1 Ubuntu 24.04/);
  assert.doesNotMatch(menu, /Still downloading/);
  assert.match(menu, /kernel \$\{server\}\/iso\/a1\/casper\/vmlinuz initrd=initrd ip=dhcp url=http:\/\/192.168.1.2:8080\/isofile\/a1.iso/);
  assert.match(menu, /item netbootxyz/);
  assert.match(menu, /installer-\$\{darch\}\/current\/images\/netboot/);
  assert.match(menu, /choose --default local/);
  const noBuiltins = buildMenu([], { base: 'http://x', builtins: { 'debian-netinst': false, netbootxyz: false } });
  assert.doesNotMatch(noBuiltins, /netboot.xyz/);
});
