'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { parsePacket, buildPacket, chooseBoot, broadcastFor, ProxyDhcpServer } = require('../src/core/proxydhcp');
const { TftpServer, safeResolve } = require('../src/core/tftp');
const { BootHttpServer, parseRange } = require('../src/core/httpserver');

function discover({ arch = 7, ipxe = false, msgType = 1, ciaddr = '0.0.0.0', vendor } = {}) {
  const head = Buffer.alloc(240);
  head[0] = 1;
  head[1] = 1;
  head[2] = 6;
  head.writeUInt32BE(0xdeadbeef, 4);
  head.writeUInt16BE(0x8000, 10);
  Buffer.from(ciaddr.split('.').map(Number)).copy(head, 12);
  Buffer.from([0xd8, 0x3a, 0xdd, 0x10, 0xf5, 0x19]).copy(head, 28);
  Buffer.from([99, 130, 83, 99]).copy(head, 236);
  const vc = Buffer.from(vendor || `PXEClient:Arch:${String(arch).padStart(5, '0')}:UNDI:003016`);
  const opts = [Buffer.from([53, 1, msgType]), Buffer.from([60, vc.length]), vc, Buffer.from([93, 2, 0, arch]), Buffer.from([97, 17, 0, ...Array(16).fill(7)])];
  if (ipxe) opts.push(Buffer.from([77, 4]), Buffer.from('iPXE'));
  opts.push(Buffer.from([255]));
  return Buffer.concat([head, ...opts]);
}

test('parses PXE requests and picks the right boot file', () => {
  const p = parsePacket(discover({ arch: 7 }));
  assert.equal(p.mac, 'D8:3A:DD:10:F5:19');
  assert.equal(p.arch, 7);
  assert.equal(chooseBoot(p, { serverIp: '192.168.1.2', httpPort: 8080 }).file, 'ipxe.efi');
  assert.equal(chooseBoot(parsePacket(discover({ arch: 0 })), { serverIp: 'x', httpPort: 1 }).file, 'undionly.kpxe');
  assert.equal(chooseBoot(parsePacket(discover({ arch: 11 })), { serverIp: 'x', httpPort: 1 }).file, 'ipxe-arm64.efi');
  assert.equal(chooseBoot(parsePacket(discover({ arch: 7, ipxe: true })), { serverIp: '192.168.1.2', httpPort: 8080 }).file, 'http://192.168.1.2:8080/boot.ipxe');
  assert.equal(broadcastFor('192.168.1.2', '255.255.255.0'), '192.168.1.255');
});

test('builds a proxy-DHCP offer with no IP address but a boot file', () => {
  const req = parsePacket(discover({ arch: 0 }));
  const reply = parsePacket(buildPacket({ req, msgType: 2, serverIp: '192.168.1.2', bootFile: 'undionly.kpxe' }));
  assert.equal(reply.op, 2);
  assert.equal(reply.xid, 0xdeadbeef);
  assert.equal(reply.yiaddr, '0.0.0.0');
  assert.equal(reply.siaddr, '192.168.1.2');
  assert.equal(reply.msgType, 2);
  assert.equal(reply.vendorClass, 'PXEClient');
  assert.equal(reply.options.get(54).join('.'), '192.168.1.2');
  assert.deepEqual([...reply.options.get(43)], [6, 1, 8, 255]);
  assert.ok(reply.options.get(97).equals(req.options.get(97)));
});

test('proxy-DHCP answers a DISCOVER and a port-4011 REQUEST on real sockets', async () => {
  const dhcpPort = 16767, binlPort = 14011, clientPort = 16868;
  const srv = new ProxyDhcpServer({ serverIp: '127.0.0.1', netmask: '255.0.0.0', httpPort: 8080, ports: { dhcp: dhcpPort, binl: binlPort, client: clientPort } });
  await srv.start();
  const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  await new Promise((r) => client.bind(clientPort, r));
  client.setBroadcast(true);
  const offer = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no offer')), 3000);
    client.once('message', (m) => (clearTimeout(t), resolve(parsePacket(m))));
    client.send(discover({ arch: 7 }), dhcpPort, '127.0.0.1');
  });
  assert.equal(offer.msgType, 2);
  assert.equal(offer.siaddr, '127.0.0.1');

  const binl = dgram.createSocket('udp4');
  await new Promise((r) => binl.bind(0, '127.0.0.1', r));
  const ack = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no ack')), 3000);
    binl.once('message', (m) => (clearTimeout(t), resolve(parsePacket(m))));
    binl.send(discover({ arch: 0, msgType: 3, ciaddr: '127.0.0.1' }), binlPort, '127.0.0.1');
  });
  assert.equal(ack.msgType, 5);
  // a normal (non-PXE) DHCP packet must be ignored
  const ignored = await new Promise((resolve) => {
    const plain = discover({ vendor: 'MSFT 5.0' });
    const t = setTimeout(() => resolve(true), 600);
    client.once('message', () => (clearTimeout(t), resolve(false)));
    client.send(plain, dhcpPort, '127.0.0.1');
  });
  assert.equal(ignored, true);
  client.close();
  binl.close();
  srv.stop();
});

function tftpGet(port, filename, opts = {}) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    const chunks = [];
    let blksize = 512;
    const optWords = Object.entries(opts).flatMap(([k, v]) => [k, String(v)]);
    const rrq = Buffer.from(['\0\x01' + filename, 'octet', ...optWords, ''].join('\0'), 'latin1');
    const t = setTimeout(() => (s.close(), reject(new Error('tftp timeout'))), 5000);
    let oack = null;
    s.on('message', (m, r) => {
      const op = m.readUInt16BE(0);
      if (op === 6) {
        oack = Object.fromEntries(m.subarray(2).toString('latin1').split('\0').filter(Boolean).reduce((a, x, i, arr) => (i % 2 ? a : [...a, [x, arr[i + 1]]]), []));
        if (oack.blksize) blksize = Number(oack.blksize);
        s.send(Buffer.from([0, 4, 0, 0]), r.port, r.address);
      } else if (op === 3) {
        const block = m.readUInt16BE(2);
        chunks.push(m.subarray(4));
        s.send(Buffer.from([0, 4, block >> 8, block & 255]), r.port, r.address);
        if (m.length - 4 < blksize) {
          clearTimeout(t);
          s.close();
          resolve({ data: Buffer.concat(chunks), oack });
        }
      } else if (op === 5) {
        clearTimeout(t);
        s.close();
        reject(new Error('tftp error ' + m.readUInt16BE(2)));
      }
    });
    s.send(rrq, port, '127.0.0.1');
  });
}

test('TFTP serves files with blksize/tsize and refuses path escapes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tftp-'));
  const data = Buffer.alloc(100000);
  for (let i = 0; i < data.length; i++) data[i] = (i * 7) & 255;
  fs.writeFileSync(path.join(root, 'undionly.kpxe'), data);
  fs.writeFileSync(path.join(root, 'exact.bin'), Buffer.alloc(1024, 9));
  const srv = new TftpServer({ root, port: 0, host: '127.0.0.1', timeoutMs: 300 });
  await srv.start();
  const r1 = await tftpGet(srv.port, 'undionly.kpxe', { tsize: 0, blksize: 1432 });
  assert.equal(r1.oack.tsize, '100000');
  assert.equal(r1.oack.blksize, '1432');
  assert.ok(r1.data.equals(data));
  const r2 = await tftpGet(srv.port, '/exact.bin'); // multiple of 512: needs a final empty block
  assert.equal(r2.data.length, 1024);
  await assert.rejects(tftpGet(srv.port, '../../etc/passwd'), /tftp error 1/);
  assert.equal(safeResolve(root, '../x'), null);
  srv.stop();
});

test('HTTP server: menu, Range requests and 404', async () => {
  const payload = Buffer.from('0123456789abcdef');
  const srv = new BootHttpServer({
    port: 0,
    host: '127.0.0.1',
    provider: {
      menu: () => '#!ipxe\necho hi\n',
      bootfile: () => null,
      isoFile: () => null,
      isoEntry: (id, p) => (p === '/casper/vmlinuz' ? { size: payload.length, stream: (s, e) => require('stream').Readable.from([payload.subarray(s, e + 1)]) } : null),
    },
  });
  await srv.start();
  const get = (p, headers = {}) =>
    new Promise((res, rej) => http.get({ host: '127.0.0.1', port: srv.port, path: p, headers }, (r) => { const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c) })); }).on('error', rej));
  const m = await get('/boot.ipxe');
  assert.equal(m.status, 200);
  assert.match(m.body.toString(), /^#!ipxe/);
  const full = await get('/iso/abc/casper/vmlinuz');
  assert.equal(full.body.toString(), '0123456789abcdef');
  const part = await get('/iso/abc/casper/vmlinuz', { Range: 'bytes=4-7' });
  assert.equal(part.status, 206);
  assert.equal(part.body.toString(), '4567');
  assert.equal(part.headers['content-range'], 'bytes 4-7/16');
  assert.equal((await get('/iso/abc/../../secret')).status, 404);
  assert.equal((await get('/nope')).status, 404);
  assert.deepEqual(parseRange('bytes=-4', 16), { start: 12, end: 15 });
  assert.equal(parseRange('bytes=20-', 16), 'invalid');
  srv.stop();
});
