'use strict';
// Mock of the preload bridge (window.pxe) used to drive the renderer in a plain browser.
const { discover } = require('../../src/core/catalog');

const ubuntuSums = 'aa *ubuntu-24.04.10-live-server-amd64.iso\n';
const pages = { 'https://releases.ubuntu.com/noble/SHA256SUMS': ubuntuSums };

/** Real catalog entries; the Ubuntu lookup "succeeds" (live), the others use pinned links (live:false). */
async function catalogData() {
  return discover({ get: async (u) => { if (pages[u]) return pages[u]; throw new Error('offline'); } });
}

function sampleImages() {
  return [
    { id: 'a1', label: 'ubuntu-24.04.10-live-server-amd64.iso', url: 'https://releases.ubuntu.com/noble/ubuntu-24.04.10-live-server-amd64.iso', status: 'ready', progress: 1, family: 'ubuntu', supported: true, size: 3231000000, file: '/d/a1.iso' },
    { id: 'a2', label: 'debian-live-13.7.0-amd64-standard.iso', url: 'https://cdimage.debian.org/debian-cd/current-live/amd64/iso-hybrid/debian-live-13.7.0-amd64-standard.iso', status: 'downloading', progress: 0.42, size: 1500000000 },
    { id: 'a3', label: 'windows11.iso', url: 'https://example.com/windows11.iso', status: 'unsupported', reason: 'This looks like a Windows ISO, which cannot be network-booted this way.', family: 'windows', supported: false },
    { id: 'a4', label: 'broken.iso', url: 'https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/breaks/at/all/broken-image-with-a-really-long-file-name.iso', status: 'error', error: 'HTTP 404 while downloading https://example.com/a/very/long/path/that/keeps/going/broken.iso' },
    { id: 'a5', label: 'NVIDIA Jetson installer (JetPack 6.2)', status: 'ready', progress: 1, family: 'jetson-installer', supported: true, size: 8900000000, local: true, file: 'jetpack.iso', variants: [{ key: 'nvme', label: 'Install on NVMe', args: '' }] },
    { id: 'a6', label: 'paused.iso', url: 'https://example.com/paused.iso', status: 'paused', progress: 0.1, size: 100 },
  ];
}

/**
 * Installs window.pxe via page.addInitScript. cfg: { catalog, images, catalogDelayMs, catalogError }.
 * The page can inspect window.__calls (array of [method, ...args]).
 */
async function installMock(page, cfg) {
  const data = {
    catalog: cfg.catalog || (await catalogData()),
    images: cfg.images || [],
    catalogDelayMs: cfg.catalogDelayMs || 0,
    catalogError: cfg.catalogError || null,
  };
  await page.addInitScript((d) => {
    window.__calls = [];
    let images = d.images.slice();
    const ok = (data) => ({ ok: true, data });
    const subs = {};
    const sub = (k) => (fn) => ((subs[k] = subs[k] || []).push(fn), () => { subs[k] = subs[k].filter((f) => f !== fn); });
    window.__emit = (k, v) => (subs[k] || []).forEach((f) => f(v));
    const rec = (name, fn) => async (...a) => { window.__calls.push([name, ...a]); return fn(...a); };
    const ifaces = [{ name: 'eth0', address: '192.168.1.50', netmask: '255.255.255.0', mac: 'AA:BB:CC:DD:EE:FF' }];
    window.pxe = {
      state: rec('state', () => ok({ platform: 'linux', dataDir: '/home/u/.config/pxe/data', settings: { httpPort: 8080, menuTimeout: 60, builtins: { 'debian-netinst': true, netbootxyz: false }, router: { host: '192.168.1.1', user: 'admin' }, serverIp: '192.168.1.50' }, images: images.slice(), status: { running: false }, interfaces: ifaces, bootfiles: [{ name: 'snponly.efi', present: true }, { name: 'undionly.kpxe', present: false }], plan: null })),
      routerPlan: rec('routerPlan', () => ok({ router: { identity: 'MikroTik', board: 'hAP ax3', version: '7.15' }, local: { name: 'eth0', mac: 'AA:BB:CC:DD:EE:FF', address: '192.168.1.50' }, network: { address: '192.168.1.0/24' }, pools: ['192.168.1.100-192.168.1.200'], targetIp: '192.168.1.50', targetOutsidePool: true, leaseAction: 'make-static', nextServerAction: 'set', warnings: ['Example warning'] })),
      routerApply: rec('routerApply', () => ok({ done: ['x'], plan: {}, interfaces: ifaces })),
      catalog: rec('catalog', async () => {
        if (d.catalogDelayMs) await new Promise((r) => setTimeout(r, d.catalogDelayMs));
        return d.catalogError ? { ok: false, error: d.catalogError } : ok(d.catalog);
      }),
      addUrl: rec('addUrl', (url) => { images = [...images, { id: 'n' + images.length, label: url.split('/').pop(), url, status: 'downloading', progress: 0 }]; return ok(images.slice()); }),
      addFile: rec('addFile', () => ok(images.slice())),
      removeImage: rec('removeImage', (id) => { images = images.filter((i) => i.id !== id); return ok(images.slice()); }),
      retryImage: rec('retryImage', () => ok(images.slice())),
      pauseImage: rec('pauseImage', () => ok(images.slice())),
      renameImage: rec('renameImage', () => ok(images.slice())),
      saveSettings: rec('saveSettings', (p) => ok(p)),
      interfaces: rec('interfaces', () => ok(ifaces)),
      startServer: rec('startServer', () => ok({ running: true, serverIp: '192.168.1.50', httpPort: 8080, menuUrl: 'http://192.168.1.50:8080/boot.ipxe' })),
      stopServer: rec('stopServer', () => ok({ running: false })),
      importBootfile: rec('importBootfile', () => ok([])),
      openData: rec('openData', () => ok(true)),
      openUrl: rec('openUrl', () => ok(true)),
      onLog: sub('log'), onImages: sub('images'), onProgress: sub('progress'), onStatus: sub('status'), onClient: sub('client'),
    };
  }, data);
}

module.exports = { installMock, catalogData, sampleImages };
