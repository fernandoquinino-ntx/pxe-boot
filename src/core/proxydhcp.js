'use strict';
// Proxy-DHCP server (like dnsmasq "proxy" mode).
// It never hands out IP addresses: the MikroTik keeps doing that.
// It only answers PXE clients and tells them which boot file to load,
// choosing the right one for BIOS, UEFI x64, UEFI ARM64 and iPXE.

const dgram = require('dgram');
const { EventEmitter } = require('events');

const MAGIC = Buffer.from([99, 130, 83, 99]);

const DHCP = { DISCOVER: 1, OFFER: 2, REQUEST: 3, ACK: 5, INFORM: 8 };

function ipToBuf(ip) {
  return Buffer.from(ip.split('.').map(Number));
}
function bufToIp(b, o = 0) {
  return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
}

function parsePacket(buf) {
  if (buf.length < 240) throw new Error('packet too short');
  if (!buf.subarray(236, 240).equals(MAGIC)) throw new Error('no DHCP magic cookie');
  const p = {
    op: buf[0],
    htype: buf[1],
    hlen: buf[2],
    xid: buf.readUInt32BE(4),
    secs: buf.readUInt16BE(8),
    flags: buf.readUInt16BE(10),
    ciaddr: bufToIp(buf, 12),
    yiaddr: bufToIp(buf, 16),
    siaddr: bufToIp(buf, 20),
    giaddr: bufToIp(buf, 24),
    chaddr: Buffer.from(buf.subarray(28, 44)),
    options: new Map(),
  };
  let i = 240;
  while (i < buf.length) {
    const code = buf[i++];
    if (code === 0) continue;
    if (code === 255) break;
    if (i >= buf.length) break;
    const len = buf[i++];
    const val = Buffer.from(buf.subarray(i, i + len));
    // RFC 3396: repeated options are concatenated
    p.options.set(code, p.options.has(code) ? Buffer.concat([p.options.get(code), val]) : val);
    i += len;
  }
  p.mac = [...p.chaddr.subarray(0, p.hlen || 6)]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join(':')
    .toUpperCase();
  p.msgType = p.options.has(53) ? p.options.get(53)[0] : 0;
  p.vendorClass = p.options.has(60) ? p.options.get(60).toString('latin1') : '';
  p.userClass = p.options.has(77) ? p.options.get(77).toString('latin1') : '';
  p.arch = p.options.has(93) && p.options.get(93).length >= 2 ? p.options.get(93).readUInt16BE(0) : null;
  p.isIPXE = p.userClass.includes('iPXE') || p.options.has(175);
  return p;
}

function buildPacket({ req, msgType, serverIp, bootFile, vendorClass = 'PXEClient', ciaddr }) {
  const head = Buffer.alloc(240);
  head[0] = 2; // BOOTREPLY
  head[1] = req.htype || 1;
  head[2] = req.hlen || 6;
  head.writeUInt32BE(req.xid >>> 0, 4);
  head.writeUInt16BE(req.flags, 10);
  ipToBuf(ciaddr || '0.0.0.0').copy(head, 12);
  // yiaddr stays 0.0.0.0: we never assign addresses
  ipToBuf(serverIp).copy(head, 20); // siaddr = next-server (TFTP)
  ipToBuf(req.giaddr).copy(head, 24);
  req.chaddr.copy(head, 28, 0, 16);
  head.write(serverIp, 44, 63, 'latin1'); // sname
  if (bootFile) head.write(bootFile, 108, 127, 'latin1'); // file
  MAGIC.copy(head, 236);

  const opts = [];
  const add = (code, val) => {
    const b = Buffer.isBuffer(val) ? val : Buffer.from(val);
    opts.push(Buffer.from([code, b.length]), b);
  };
  add(53, [msgType]);
  add(54, ipToBuf(serverIp));
  add(60, Buffer.from(vendorClass, 'latin1'));
  if (req.options.has(97)) add(97, req.options.get(97));
  if (!req.isIPXE && vendorClass === 'PXEClient') {
    // PXE vendor options: discovery control = 8 -> "boot the file named in this reply"
    add(43, [6, 1, 8, 255]);
  }
  if (bootFile) add(67, Buffer.from(bootFile, 'latin1'));
  opts.push(Buffer.from([255]));
  return Buffer.concat([head, ...opts]);
}

// Client architecture (DHCP option 93, RFC 4578 / IANA registry)
const ARCH_NAMES = {
  0: 'BIOS',
  6: 'UEFI x86',
  7: 'UEFI x64',
  9: 'UEFI x64',
  10: 'UEFI ARM32',
  11: 'UEFI ARM64',
  16: 'UEFI x64 HTTP',
  19: 'UEFI ARM64 HTTP',
};

function chooseBoot(p, { serverIp, httpPort }) {
  const http = `http://${serverIp}:${httpPort}`;
  if (p.isIPXE) return { file: `${http}/boot.ipxe`, vendor: 'PXEClient', label: 'iPXE → menu' };
  const arch = p.arch == null ? 0 : p.arch;
  switch (arch) {
    case 0:
      return { file: 'undionly.kpxe', vendor: 'PXEClient', label: 'BIOS → undionly.kpxe' };
    case 7:
    case 9:
      return { file: 'ipxe.efi', vendor: 'PXEClient', label: 'UEFI x64 → ipxe.efi' };
    case 11:
      return { file: 'ipxe-arm64.efi', vendor: 'PXEClient', label: 'UEFI ARM64 → ipxe-arm64.efi' };
    case 16:
      return { file: `${http}/bootfiles/ipxe.efi`, vendor: 'HTTPClient', label: 'UEFI HTTP boot → ipxe.efi' };
    case 19:
      return { file: `${http}/bootfiles/ipxe-arm64.efi`, vendor: 'HTTPClient', label: 'UEFI ARM64 HTTP boot' };
    default:
      return null;
  }
}

function broadcastFor(ip, netmask) {
  const a = ip.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  return a.map((x, i) => (x & m[i]) | (~m[i] & 255)).join('.');
}

class ProxyDhcpServer extends EventEmitter {
  constructor({ serverIp, netmask = '255.255.255.0', httpPort = 8080, ports = { dhcp: 67, binl: 4011, client: 68 } }) {
    super();
    this.ports = ports;
    this.serverIp = serverIp;
    this.netmask = netmask;
    this.httpPort = httpPort;
    this.sockets = [];
  }

  _log(msg) {
    this.emit('log', msg);
  }

  async start() {
    this.sock67 = await this._bind(this.ports.dhcp);
    this.sock4011 = await this._bind(this.ports.binl);
    this.sock67.on('message', (m, r) => this._onMessage(m, r, this.ports.dhcp));
    this.sock4011.on('message', (m, r) => this._onMessage(m, r, this.ports.binl));
    this._log(`Proxy-DHCP listening on ${this.serverIp} (ports ${this.ports.dhcp} and ${this.ports.binl})`);
  }

  _bind(port) {
    return new Promise((resolve, reject) => {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      s.once('error', (e) => {
        if (e.code === 'EACCES') e.message = `Permission denied to open UDP port ${port}. Run the app as administrator.`;
        if (e.code === 'EADDRINUSE') e.message = `UDP port ${port} is already used by another program (another DHCP/PXE server, or macOS Internet Sharing).`;
        reject(e);
      });
      s.bind(port, '0.0.0.0', () => {
        s.setBroadcast(true);
        s.removeAllListeners('error');
        s.on('error', (e) => this._log(`DHCP socket error: ${e.message}`));
        this.sockets.push(s);
        resolve(s);
      });
    });
  }

  _onMessage(msg, rinfo, port) {
    let p;
    try {
      p = parsePacket(msg);
    } catch {
      return;
    }
    if (p.op !== 1) return;
    const pxe = p.vendorClass.startsWith('PXEClient') || p.vendorClass.startsWith('HTTPClient');
    if (!pxe) return; // normal clients: leave them to the MikroTik

    const boot = chooseBoot(p, { serverIp: this.serverIp, httpPort: this.httpPort });
    const archName = p.isIPXE ? 'iPXE' : ARCH_NAMES[p.arch == null ? 0 : p.arch] || `arch ${p.arch}`;
    if (!boot) {
      this._log(`PXE request from ${p.mac} (${archName}) ignored: architecture not supported`);
      return;
    }

    if (port === this.ports.dhcp && p.msgType === DHCP.DISCOVER) {
      const reply = buildPacket({ req: p, msgType: DHCP.OFFER, serverIp: this.serverIp, bootFile: boot.file, vendorClass: boot.vendor });
      if (p.giaddr !== '0.0.0.0') {
        this.sock67.send(reply, this.ports.dhcp, p.giaddr, () => {}); // via DHCP relay
      } else {
        // subnet broadcast leaves through the right interface on multi-homed machines
        for (const d of new Set([broadcastFor(this.serverIp, this.netmask), '255.255.255.255'])) this.sock67.send(reply, this.ports.client, d, () => {});
      }
      this._log(`PXE boot offer → ${p.mac} (${archName}): ${boot.label}`);
      this.emit('client', { mac: p.mac, arch: archName, file: boot.file });
    } else if (p.msgType === DHCP.REQUEST || p.msgType === DHCP.INFORM) {
      if (port === this.ports.dhcp) return; // address requests on 67 belong to the MikroTik
      const reply = buildPacket({ req: p, msgType: DHCP.ACK, serverIp: this.serverIp, bootFile: boot.file, vendorClass: boot.vendor, ciaddr: p.ciaddr });
      this.sock4011.send(reply, rinfo.port, rinfo.address, () => {});
      this._log(`PXE boot ack → ${p.mac} (${archName}) at ${rinfo.address}: ${boot.label}`);
    }
  }

  stop() {
    for (const s of this.sockets) {
      try {
        s.close();
      } catch {}
    }
    this.sockets = [];
  }
}

module.exports = { ProxyDhcpServer, parsePacket, buildPacket, chooseBoot, broadcastFor, DHCP };
