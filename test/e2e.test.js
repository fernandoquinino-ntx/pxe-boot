'use strict';
// End-to-end: PxeService with a fake Ubuntu ISO, all three servers on their real ports.
// Needs permission to bind UDP 67/69 (root on Linux); skipped otherwise.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const dgram = require('dgram');
const { makeIso } = require('./helpers/make-iso');
const { PxeService } = require('../src/core/pxe-service');
const { parsePacket } = require('../src/core/proxydhcp');

const canBindLow = process.platform !== 'linux' || process.getuid?.() === 0;

test('service: ISO → menu → kernel over HTTP → TFTP → proxy-DHCP', { skip: !canBindLow && 'needs root for ports 67/69', timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxe-e2e-'));
  const svc = new PxeService({ dataDir: dir });
  for (const f of ['undionly.kpxe', 'ipxe.efi', 'ipxe-arm64.efi']) fs.writeFileSync(path.join(svc.bootDir, f), Buffer.alloc(2000, 5));
  const iso = makeIso(path.join(dir, 'ubuntu.iso'), {
    casper: { vmlinuz: Buffer.from('LINUX-KERNEL'), initrd: Buffer.from('INITRD') },
    '.disk': { info: Buffer.from('Ubuntu 24.04.1 LTS "Noble Numbat" - Release amd64 (20240827.1)') },
  });
  const img = svc.addLocalFile(iso);
  assert.equal(img.status, 'ready');
  svc.saveSettings({ httpPort: 18080 });
  await svc.start({ serverIp: '127.0.0.1', netmask: '255.0.0.0' });
  try {
    const get = (p) => new Promise((res, rej) => http.get(`http://127.0.0.1:18080${p}`, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c) })); }).on('error', rej));
    const menu = (await get('/boot.ipxe')).body.toString();
    assert.match(menu, /item img-\w+ Ubuntu 24.04.1 LTS "Noble Numbat"/);
    const kernelPath = menu.match(/kernel \$\{server\}(\S+)/)[1];
    assert.equal((await get(kernelPath)).body.toString(), 'LINUX-KERNEL');
    assert.equal((await get(`/isofile/${img.id}.iso`)).body.length, fs.statSync(iso).size);

    // TFTP: fetch undionly.kpxe
    const tftp = await new Promise((resolve, reject) => {
      const s = dgram.createSocket('udp4');
      const tm = setTimeout(() => (s.close(), reject(new Error('tftp timeout'))), 5000);
      const parts = [];
      s.on('message', (m, r) => {
        if (m.readUInt16BE(0) !== 3) return reject(new Error('tftp op ' + m.readUInt16BE(0)));
        parts.push(m.subarray(4));
        s.send(Buffer.from([0, 4, m[2], m[3]]), r.port, r.address);
        if (m.length - 4 < 512) (clearTimeout(tm), s.close(), resolve(Buffer.concat(parts)));
      });
      s.send(Buffer.from('\0\x01undionly.kpxe\0octet\0', 'latin1'), 69, '127.0.0.1');
    });
    assert.equal(tftp.length, 2000);

    // proxy-DHCP: UEFI x64 client gets ipxe.efi
    const c = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await new Promise((r) => c.bind(68, r));
    c.setBroadcast(true);
    const head = Buffer.alloc(240);
    head[0] = 1; head[1] = 1; head[2] = 6;
    head.writeUInt32BE(42, 4);
    Buffer.from([0xaa, 0xbb, 0xcc, 0, 0, 1]).copy(head, 28);
    Buffer.from([99, 130, 83, 99]).copy(head, 236);
    const vc = Buffer.from('PXEClient:Arch:00007:UNDI:003016');
    const pkt = Buffer.concat([head, Buffer.from([53, 1, 1, 60, vc.length]), vc, Buffer.from([93, 2, 0, 7, 255])]);
    const offer = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no offer')), 3000);
      c.on('message', (m) => { const p = parsePacket(m); if (p.op === 2) (clearTimeout(t), resolve(p)); });
      c.send(pkt, 67, '127.0.0.1');
    });
    c.close();
    assert.equal(offer.siaddr, '127.0.0.1');
    assert.match(offer.options.get(67).toString(), /^ipxe\.efi$/);
  } finally {
    svc.stop();
  }
});
