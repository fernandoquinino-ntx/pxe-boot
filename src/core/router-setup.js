'use strict';
// Logs into the MikroTik, reserves a fixed IP (outside the DHCP pool) for this
// computer, and points the DHCP network's next-server at it.

const os = require('os');
const { RouterOSClient } = require('./routeros');

const ipToInt = (ip) => ip.split('.').reduce((a, x) => (a << 8) + Number(x), 0) >>> 0;
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

function parseCidr(cidr) {
  const [ip, bits] = cidr.split('/');
  const b = Number(bits);
  const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
  const network = ipToInt(ip) & mask;
  return { network: network >>> 0, mask, broadcast: (network | (~mask >>> 0)) >>> 0, bits: b };
}

function parseRanges(str) {
  // "192.168.1.10-192.168.1.254,192.168.1.5"
  return String(str || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((r) => {
      const [a, b] = r.split('-');
      return [ipToInt(a), ipToInt(b || a)];
    });
}

/** Local network interfaces that can reach `routerIp` directly. */
function localInterfaceFor(routerIp, interfaces = os.networkInterfaces()) {
  const r = ipToInt(routerIp);
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const mask = ipToInt(a.netmask);
      if ((ipToInt(a.address) & mask) === (r & mask)) {
        return { name, address: a.address, netmask: a.netmask, mac: a.mac.toUpperCase() };
      }
    }
  }
  return null;
}

function listLocalIPv4(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ name, address: a.address, netmask: a.netmask, mac: a.mac.toUpperCase() });
    }
  }
  return out;
}

/** Picks the lowest free address in the network that is outside every DHCP pool. */
function pickFreeAddress({ cidr, pools, used }) {
  const net = parseCidr(cidr);
  for (let n = net.network + 2; n < net.broadcast; n++) {
    if (pools.some(([a, b]) => n >= a && n <= b)) continue;
    if (used.has(n)) continue;
    return intToIp(n);
  }
  return null;
}

async function connect({ host, user, password, port, useTls }) {
  const c = new RouterOSClient({ host, port, useTls });
  await c.connect();
  try {
    await c.login(user, password);
  } catch (e) {
    c.close();
    throw e;
  }
  return c;
}

/**
 * Reads the router and returns what would be changed. Makes no changes.
 */
async function plan(creds, { desiredIp, local: forcedLocal } = {}) {
  const local = forcedLocal || localInterfaceFor(creds.host);
  if (!local) {
    const ips = listLocalIPv4().map((i) => `${i.name} ${i.address}`).join(', ') || 'none';
    throw new Error(`This computer is not on the same network as ${creds.host}. Connect it to the router's LAN (your addresses: ${ips}).`);
  }
  const c = await connect(creds);
  try {
    const [identity] = await c.run('/system/identity/print');
    const [resource] = await c.run('/system/resource/print');
    const servers = await c.run('/ip/dhcp-server/print');
    const networks = await c.run('/ip/dhcp-server/network/print');
    const pools = await c.run('/ip/pool/print');
    const leases = await c.run('/ip/dhcp-server/lease/print');
    const addrs = await c.run('/ip/address/print');

    const localInt = ipToInt(local.address);
    const network = networks.find((n) => {
      const p = parseCidr(n.address);
      return ((localInt & p.mask) >>> 0) === p.network;
    });
    if (!network) throw new Error(`The router has no DHCP network for ${local.address}. Is the DHCP server enabled on this LAN?`);
    const netInfo = parseCidr(network.address);
    const inNet = (ip) => ((ipToInt(ip) & netInfo.mask) >>> 0) === netInfo.network;
    const server = servers.find((s) => s.disabled !== 'true' && pools.some((p) => p.name === s['address-pool'] && parseRanges(p.ranges).some(([a]) => ((a & netInfo.mask) >>> 0) === netInfo.network))) || servers[0];
    if (!server) throw new Error('No DHCP server found on the router.');

    const poolRanges = pools.filter((p) => parseRanges(p.ranges).some(([a]) => ((a & netInfo.mask) >>> 0) === netInfo.network)).flatMap((p) => parseRanges(p.ranges));
    const myLease = leases.find((l) => (l['mac-address'] || '').toUpperCase() === local.mac);
    const used = new Set();
    for (const l of leases) if (l !== myLease && l.address && inNet(l.address)) used.add(ipToInt(l.address));
    for (const a of addrs) used.add(ipToInt(a.address.split('/')[0]));
    if (network.gateway) used.add(ipToInt(network.gateway));

    const isOutsidePool = (ip) => !poolRanges.some(([a, b]) => ipToInt(ip) >= a && ipToInt(ip) <= b);
    let targetIp = desiredIp;
    if (targetIp) {
      if (!inNet(targetIp)) throw new Error(`${targetIp} is not inside ${network.address}.`);
      if (used.has(ipToInt(targetIp))) throw new Error(`${targetIp} is already used by another device or by the router.`);
    } else if (myLease && myLease.dynamic !== 'true' && isOutsidePool(myLease.address)) {
      targetIp = myLease.address; // already reserved outside the pool
    } else {
      targetIp = pickFreeAddress({ cidr: network.address, pools: poolRanges, used });
      if (!targetIp) throw new Error('No free address outside the DHCP pool. Shrink the pool on the router first.');
    }

    const leaseAction = !myLease
      ? 'add'
      : myLease.dynamic === 'true'
        ? 'make-static'
        : myLease.address === targetIp && myLease.comment === 'pxe-server'
          ? 'none'
          : 'update';
    const nextServerAction = network['next-server'] === targetIp ? 'none' : 'set';

    return {
      router: { identity: identity?.name, version: resource?.version, board: resource?.['board-name'] },
      local,
      dhcpServer: server.name,
      network: { id: network['.id'], address: network.address, nextServer: network['next-server'] || '', bootFile: network['boot-file-name'] || '' },
      pools: poolRanges.map(([a, b]) => `${intToIp(a)}-${intToIp(b)}`),
      lease: myLease ? { id: myLease['.id'], address: myLease.address, dynamic: myLease.dynamic === 'true', comment: myLease.comment || '' } : null,
      targetIp,
      targetOutsidePool: isOutsidePool(targetIp),
      leaseAction,
      nextServerAction,
      warnings: network['boot-file-name']
        ? [`The router's DHCP network already has boot file "${network['boot-file-name']}". It will be cleared so the app can choose the right file for BIOS and UEFI.`]
        : [],
    };
  } finally {
    c.close();
  }
}

/** Applies a plan returned by plan(). */
async function apply(creds, p) {
  const c = await connect(creds);
  const done = [];
  try {
    const comment = 'pxe-server';
    if (p.leaseAction === 'add') {
      await c.run('/ip/dhcp-server/lease/add', { 'mac-address': p.local.mac, address: p.targetIp, server: p.dhcpServer, comment });
      done.push(`Reserved ${p.targetIp} for this computer (${p.local.mac})`);
    } else if (p.leaseAction === 'make-static' || p.leaseAction === 'update') {
      if (p.leaseAction === 'make-static') await c.run('/ip/dhcp-server/lease/make-static', { numbers: p.lease.id });
      const [lease] = await c.run('/ip/dhcp-server/lease/print', { '?mac-address': p.local.mac });
      await c.run('/ip/dhcp-server/lease/set', { '.id': lease['.id'], address: p.targetIp, comment });
      done.push(`Reserved ${p.targetIp} for this computer (${p.local.mac})`);
    } else done.push(`This computer already has ${p.targetIp} reserved`);

    if (p.nextServerAction === 'set') {
      await c.run('/ip/dhcp-server/network/set', { '.id': p.network.id, 'next-server': p.targetIp });
      done.push(`DHCP network ${p.network.address}: next-server = ${p.targetIp} (PXE server)`);
    } else done.push(`DHCP next-server already points to ${p.targetIp}`);
    if (p.network.bootFile) {
      await c.run('/ip/dhcp-server/network/unset', { numbers: p.network.id, 'value-name': 'boot-file-name' });
      done.push('Cleared the old boot file name on the router (the app picks BIOS/UEFI files itself)');
    }
    return done;
  } finally {
    c.close();
  }
}

/** Undo: removes next-server from the DHCP network (the reservation is kept). */
async function clearNextServer(creds, networkId) {
  const c = await connect(creds);
  try {
    await c.run('/ip/dhcp-server/network/unset', { numbers: networkId, 'value-name': 'next-server' });
  } finally {
    c.close();
  }
}

module.exports = { plan, apply, clearNextServer, localInterfaceFor, listLocalIPv4, pickFreeAddress, parseCidr, parseRanges, ipToInt, intToIp };
