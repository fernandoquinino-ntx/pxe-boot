'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { encodeLength, decodeLength, encodeSentence } = require('../src/core/routeros');
const setup = require('../src/core/router-setup');

test('API length encoding round-trips', () => {
  for (const n of [0, 1, 0x7f, 0x80, 0x3fff, 0x4000, 0x1fffff, 0x200000, 0xfffffff, 0x10000000]) {
    const b = encodeLength(n);
    assert.deepEqual(decodeLength(b, 0), [n, b.length], `n=${n}`);
  }
});

// A fake RouterOS that mirrors the user's hEX: pool .10-.254, the Mac on a dynamic lease.
function fakeRouter({ password = 'secret', macLeaseDynamic = true } = {}) {
  const state = {
    leases: [
      { '.id': '*1', address: '192.168.1.20', 'mac-address': 'D8:3A:DD:15:BC:54', comment: 'blade-01', dynamic: 'false' },
      { '.id': '*2', address: '192.168.1.254', 'mac-address': '00:E0:4C:34:5B:A0', 'host-name': 'Fernandos-MBP', dynamic: macLeaseDynamic ? 'true' : 'false' },
    ],
    network: { '.id': '*1', address: '192.168.1.0/24', gateway: '192.168.1.1', 'dns-server': '' },
    log: [],
  };
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let words = [];
    const reply = (...sentences) => sock.write(Buffer.concat(sentences.map((s) => encodeSentence(s))));
    const row = (o) => ['!re', ...Object.entries(o).map(([k, v]) => `=${k}=${v}`)];
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      let off = 0;
      for (;;) {
        const l = decodeLength(buf, off);
        if (!l || off + l[1] + l[0] > buf.length) break;
        off += l[1];
        if (l[0] === 0) {
          handle(words);
          words = [];
        } else {
          words.push(buf.toString('utf8', off, off + l[0]));
          off += l[0];
        }
      }
      buf = buf.subarray(off);
    });
    const attrs = (w) => Object.fromEntries(w.slice(1).filter((x) => x.startsWith('=')).map((x) => [x.slice(1, x.indexOf('=', 1)), x.slice(x.indexOf('=', 1) + 1)]));
    function handle(w) {
      const cmd = w[0];
      const a = attrs(w);
      state.log.push({ cmd, a });
      switch (cmd) {
        case '/login':
          return a.password === password ? reply(['!done']) : reply(['!trap', '=message=invalid user name or password (6)'], ['!done']);
        case '/system/identity/print':
          return reply(row({ name: 'RouterOS' }), ['!done']);
        case '/system/resource/print':
          return reply(row({ version: '6.48.6 (long-term)', 'board-name': 'hEX' }), ['!done']);
        case '/ip/dhcp-server/print':
          return reply(row({ '.id': '*1', name: 'defconf', interface: 'bridge', 'address-pool': 'dhcp', disabled: 'false' }), ['!done']);
        case '/ip/dhcp-server/network/print':
          return reply(row(state.network), ['!done']);
        case '/ip/pool/print':
          return reply(row({ '.id': '*1', name: 'dhcp', ranges: '192.168.1.10-192.168.1.254' }), ['!done']);
        case '/ip/address/print':
          return reply(row({ '.id': '*1', address: '192.168.1.1/24', interface: 'bridge' }), ['!done']);
        case '/ip/dhcp-server/lease/print': {
          const q = w.find((x) => x.startsWith('?mac-address='));
          const list = q ? state.leases.filter((l) => l['mac-address'] === q.split('=')[1]) : state.leases;
          return reply(...list.map(row), ['!done']);
        }
        case '/ip/dhcp-server/lease/make-static': {
          const l = state.leases.find((x) => x['.id'] === a.numbers);
          l.dynamic = 'false';
          return reply(['!done']);
        }
        case '/ip/dhcp-server/lease/set': {
          const l = state.leases.find((x) => x['.id'] === a['.id']);
          Object.assign(l, { address: a.address, comment: a.comment });
          return reply(['!done']);
        }
        case '/ip/dhcp-server/lease/add':
          state.leases.push({ '.id': '*9', ...a, dynamic: 'false' });
          return reply(['!done', '=ret=*9']);
        case '/ip/dhcp-server/network/set':
          Object.assign(state.network, { 'next-server': a['next-server'] });
          return reply(['!done']);
        default:
          return reply(['!trap', `=message=no such command (${cmd})`], ['!done']);
      }
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port, state })));
}

const local = { name: 'en7', address: '192.168.1.254', netmask: '255.255.255.0', mac: '00:E0:4C:34:5B:A0' };

test('plans a reservation outside the DHCP pool and applies it', async () => {
  const { server, port, state } = await fakeRouter();
  const creds = { host: '127.0.0.1', port, user: 'admin', password: 'secret' };
  const p = await setup.plan(creds, { local });
  assert.equal(p.router.board, 'hEX');
  assert.equal(p.targetIp, '192.168.1.2'); // .1 is the router, pool starts at .10
  assert.equal(p.targetOutsidePool, true);
  assert.equal(p.leaseAction, 'make-static');
  assert.equal(p.nextServerAction, 'set');
  const done = await setup.apply(creds, p);
  assert.ok(done.some((d) => d.includes('Reserved 192.168.1.2')));
  const mac = state.leases.find((l) => l['mac-address'] === local.mac);
  assert.equal(mac.address, '192.168.1.2');
  assert.equal(mac.dynamic, 'false');
  assert.equal(state.network['next-server'], '192.168.1.2');

  // second run: nothing left to do
  const again = await setup.plan(creds, { local });
  assert.equal(again.leaseAction, 'none');
  assert.equal(again.nextServerAction, 'none');
  server.close();
});

test('rejects wrong password and addresses already in use', async () => {
  const { server, port } = await fakeRouter();
  await assert.rejects(setup.plan({ host: '127.0.0.1', port, user: 'admin', password: 'nope' }, { local }), /Wrong router username or password/);
  await assert.rejects(setup.plan({ host: '127.0.0.1', port, user: 'admin', password: 'secret' }, { local, desiredIp: '192.168.1.20' }), /already used/);
  await assert.rejects(setup.plan({ host: '127.0.0.1', port, user: 'admin', password: 'secret' }, { local, desiredIp: '10.0.0.5' }), /not inside/);
  server.close();
});

test('keeps an existing reservation that is already outside the pool', async () => {
  const { server, port, state } = await fakeRouter({ macLeaseDynamic: false });
  state.leases[1].address = '192.168.1.2';
  state.leases[1].comment = 'pxe-server';
  state.network['next-server'] = '192.168.1.2';
  const p = await setup.plan({ host: '127.0.0.1', port, user: 'admin', password: 'secret' }, { local });
  assert.equal(p.targetIp, '192.168.1.2');
  assert.equal(p.leaseAction, 'none');
  assert.equal(p.nextServerAction, 'none');
  server.close();
});

test('finds the local interface on the router network', () => {
  const ifs = {
    lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', mac: '00:00:00:00:00:00', internal: true }],
    en0: [{ family: 'IPv4', address: '192.168.3.50', netmask: '255.255.255.0', mac: 'aa:bb:cc:dd:ee:ff', internal: false }],
    en7: [{ family: 'IPv4', address: '192.168.1.254', netmask: '255.255.255.0', mac: '00:e0:4c:34:5b:a0', internal: false }],
  };
  assert.deepEqual(setup.localInterfaceFor('192.168.1.1', ifs), { name: 'en7', address: '192.168.1.254', netmask: '255.255.255.0', mac: '00:E0:4C:34:5B:A0' });
  assert.equal(setup.localInterfaceFor('10.0.0.1', ifs), null);
});
