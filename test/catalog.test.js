'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { discover, cmpVer } = require('../src/core/catalog');

const pages = {
  'https://releases.ubuntu.com/noble/SHA256SUMS': 'aa *ubuntu-24.04.3-live-server-amd64.iso\nbb *ubuntu-24.04.10-live-server-amd64.iso\ncc *ubuntu-24.04.5-desktop-amd64.iso\n',
  'https://enterprise.proxmox.com/iso/': '<a href="./proxmox-ve_8.4-1.iso"></a><a href="./proxmox-ve_9.2-1.iso"></a><a href="./proxmox-ve_9.2-1-arm64.iso"></a>',
};
const get = async (u) => { if (pages[u]) return pages[u]; throw new Error('offline'); };

test('version compare is numeric', () => assert.ok(cmpVer('24.04.10', '24.04.9') > 0));

test('discover picks the newest ISO and falls back to pinned links when a lookup fails', async () => {
  const list = await discover({ get });
  const by = Object.fromEntries(list.map((x) => [x.id, x]));
  assert.equal(by['ubuntu-server'].live, true);
  assert.match(by['ubuntu-server'].url, /24\.04\.10-live-server-amd64\.iso$/);
  assert.match(by.proxmox.url, /proxmox-ve_9\.2-1\.iso$/);
  assert.equal(by['debian-live'].live, false);
  assert.match(by['debian-live'].url, /^https:\/\/cdimage\.debian\.org\//);
  assert.equal(by.jetson.url, null);
  assert.ok(list.every((x) => x.page.startsWith('https://')));
});
