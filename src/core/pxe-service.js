'use strict';
// Glue: image library + boot files + the three servers (proxy-DHCP, TFTP, HTTP).
// Used by the Electron main process, and usable headless from Node.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const { IsoImage } = require('./iso9660');
const { detect } = require('./detect');
const { buildMenu } = require('./ipxe-menu');
const { download } = require('./downloader');
const { ProxyDhcpServer } = require('./proxydhcp');
const { TftpServer } = require('./tftp');
const { BootHttpServer } = require('./httpserver');
const { NfsServer } = require('./nfs');
const { cpioSingleFile, cpioArchive } = require('./cpio');
const { SHIM } = require('./nutanix');

const BOOTFILES = {
  'undionly.kpxe': ['https://boot.ipxe.org/undionly.kpxe', 'https://boot.ipxe.org/x86_64-pcbios/undionly.kpxe'],
  'ipxe.efi': ['https://boot.ipxe.org/x86_64-efi/ipxe.efi', 'https://boot.ipxe.org/ipxe.efi'],
  'ipxe-arm64.efi': ['https://boot.ipxe.org/arm64-efi/ipxe.efi'],
};

class PxeService extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.dataDir = dataDir;
    this.isoDir = path.join(dataDir, 'isos');
    this.bootDir = path.join(dataDir, 'bootfiles');
    this.dbFile = path.join(dataDir, 'images.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    fs.mkdirSync(this.isoDir, { recursive: true });
    fs.mkdirSync(this.bootDir, { recursive: true });
    this.images = this._load(this.dbFile, []);
    this.settings = { httpPort: 8080, menuTimeout: 60, builtins: { 'debian-netinst': true, netbootxyz: true }, router: { host: '', user: 'admin' }, ...this._load(this.settingsFile, {}) };
    this.isoCache = new Map();
    this.downloads = new Map();
    this.running = null;
    // downloads interrupted by closing the app can be resumed
    for (const img of this.images) if (img.status === 'downloading') img.status = 'paused';
    this._saveImages();
  }

  _load(f, def) {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      return def;
    }
  }
  _saveImages() {
    fs.writeFileSync(this.dbFile, JSON.stringify(this.images, null, 2));
    this.emit('images', this.publicImages());
  }
  saveSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    return this.settings;
  }
  log(msg) {
    this.emit('log', `[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  publicImages() {
    return this.images.map(({ id, label, url, status, progress, family, supported, reason, size, error, file, local }) => ({ id, label, url, status, progress, family, supported, reason, size, error, file, local }));
  }

  // ---------- images ----------

  addUrl(url) {
    url = String(url || '').trim();
    if (!/^https?:\/\/.+/i.test(url)) throw new Error('Paste a link that starts with http:// or https://');
    if (this.images.some((i) => i.url === url)) throw new Error('This link is already in the list');
    const id = crypto.randomBytes(4).toString('hex');
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image.iso');
    const img = { id, url, label: name, file: path.join(this.isoDir, `${id}.iso`), status: 'downloading', progress: 0 };
    this.images.push(img);
    this._saveImages();
    this._startDownload(img);
    return img;
  }

  addLocalFile(file) {
    if (!fs.existsSync(file)) throw new Error('File not found');
    const id = crypto.randomBytes(4).toString('hex');
    const img = { id, url: '', local: true, label: path.basename(file), file, status: 'checking', progress: 1 };
    this.images.push(img);
    this._inspect(img);
    return img;
  }

  _startDownload(img) {
    const ac = new AbortController();
    this.downloads.set(img.id, ac);
    img.status = 'downloading';
    img.error = undefined;
    this._saveImages();
    this.log(`Downloading ${img.label}`);
    download(img.url, img.file, {
      signal: ac.signal,
      onProgress: ({ received, total }) => {
        img.progress = total ? received / total : 0;
        img.size = total || received;
        this.emit('progress', { id: img.id, progress: img.progress, received, total });
      },
    })
      .then(() => {
        this.downloads.delete(img.id);
        this._inspect(img);
      })
      .catch((e) => {
        this.downloads.delete(img.id);
        img.status = e.message === 'Cancelled' ? 'paused' : 'error';
        img.error = e.message;
        this._saveImages();
        this.log(`${img.label}: ${e.message}`);
      });
  }

  retry(id) {
    const img = this.images.find((i) => i.id === id);
    if (img && img.url && !this.downloads.has(id)) this._startDownload(img);
  }

  pause(id) {
    this.downloads.get(id)?.abort();
  }

  remove(id) {
    const img = this.images.find((i) => i.id === id);
    if (!img) return;
    this.downloads.get(id)?.abort();
    this.isoCache.get(id)?.close();
    this.isoCache.delete(id);
    if (!img.local) {
      for (const f of [img.file, img.file + '.part']) {
        try {
          fs.unlinkSync(f);
        } catch {}
      }
    }
    this.images = this.images.filter((i) => i.id !== id);
    this._saveImages();
  }

  rename(id, label) {
    const img = this.images.find((i) => i.id === id);
    if (img && label) {
      img.label = String(label).slice(0, 70);
      this._saveImages();
    }
  }

  _inspect(img) {
    img.status = 'checking';
    this._saveImages();
    try {
      const iso = this._iso(img);
      const info = detect(iso, img.label);
      Object.assign(img, info, { size: fs.statSync(img.file).size, progress: 1 });
      img.status = info.supported ? 'ready' : 'unsupported';
      this.log(info.supported ? `${img.label}: ready (${info.family})` : `${img.label}: ${info.reason}`);
    } catch (e) {
      img.status = 'error';
      img.error = `Not a valid ISO: ${e.message}`;
      this.log(`${img.label}: ${img.error}`);
    }
    this._saveImages();
  }

  _iso(img) {
    if (!this.isoCache.has(img.id)) this.isoCache.set(img.id, new IsoImage(img.file));
    return this.isoCache.get(img.id);
  }

  // ---------- boot files ----------

  bootfileStatus() {
    return Object.keys(BOOTFILES).map((name) => ({ name, present: fs.existsSync(path.join(this.bootDir, name)) }));
  }

  async ensureBootfiles() {
    for (const [name, urls] of Object.entries(BOOTFILES)) {
      const dest = path.join(this.bootDir, name);
      if (fs.existsSync(dest)) continue;
      let ok = false;
      for (const u of urls) {
        try {
          this.log(`Downloading iPXE boot file ${name}`);
          await download(u, dest);
          ok = true;
          break;
        } catch (e) {
          this.log(`  ${u}: ${e.message}`);
        }
      }
      if (!ok && name !== 'ipxe-arm64.efi') throw new Error(`Could not download ${name}. Check the internet connection, or import it with "Import boot file".`);
    }
  }

  importBootfile(name, src) {
    if (!BOOTFILES[name]) throw new Error('Unknown boot file');
    fs.copyFileSync(src, path.join(this.bootDir, name));
  }

  // ---------- servers ----------

  menu(base) {
    return buildMenu(this.images, { base, builtins: this.settings.builtins, timeoutSec: this.settings.menuTimeout });
  }

  async start({ serverIp, netmask }) {
    if (this.running) return this.status();
    await this.ensureBootfiles();
    const httpPort = Number(this.settings.httpPort) || 8080;
    const base = `http://${serverIp}:${httpPort}`;
    const svc = this;
    const provider = {
      menu: () => svc.menu(base),
      bootfile: (name) => {
        const f = path.join(svc.bootDir, name);
        return fs.existsSync(f) ? f : null;
      },
      isoFile: (id) => {
        const img = svc.images.find((i) => i.id === id && i.status === 'ready');
        return img ? img.file : null;
      },
      isoCpio: (id) => {
        const img = svc.images.find((i) => i.id === id && i.status === 'ready' && i.family === 'proxmox');
        return img ? cpioSingleFile('proxmox.iso', img.file) : null;
      },
      ceShim: (id) => {
        const img = svc.images.find((i) => i.id === id && i.status === 'ready' && i.family === 'nutanix-ce');
        if (!img) return null;
        const buf = cpioArchive([{ name: 'ce_installer', data: SHIM, mode: 0o755 }]);
        return { size: buf.length, stream: (a, b) => require('stream').Readable.from([buf.subarray(a, b + 1)]) };
      },
      isoEntry: (id, inner) => {
        const img = svc.images.find((i) => i.id === id && i.status === 'ready');
        if (!img) return null;
        const iso = svc._iso(img);
        const e = iso.lookup(inner);
        if (!e) return null;
        if (e.isDir) return { isDir: true, list: iso.readDir(e) };
        return { size: e.size, stream: (s, en) => iso.createReadStream(e, s, en) };
      },
    };

    const http = new BootHttpServer({ port: httpPort, provider });
    const tftp = new TftpServer({ root: this.bootDir });
    const dhcp = new ProxyDhcpServer({ serverIp, netmask, httpPort });
    for (const s of [http, tftp, dhcp]) s.on('log', (m) => this.log(m));
    dhcp.on('client', (c) => this.emit('client', c));
    const started = [];
    try {
      await http.start();
      started.push(http);
      await tftp.start();
      started.push(tftp);
      await dhcp.start();
      started.push(dhcp);
    } catch (e) {
      started.forEach((s) => s.stop());
      throw e;
    }
    // optional read-only NFSv3 export of every ready ISO at /iso/<id> (e.g. casper netboot=nfs for images too big for RAM)
    let nfs = null;
    if (this.settings.nfs) {
      nfs = new NfsServer({
        port: Number(this.settings.nfsPort) || 2049,
        exports: () => svc.images.filter((i) => i.status === 'ready' && i.file).map((i) => ({ path: `/iso/${i.id}`, iso: svc._iso(i) })),
      });
      nfs.on('log', (m) => this.log(m));
      try {
        await nfs.start();
      } catch (e) {
        this.log(`NFS server not started: ${e.message}`);
        nfs = null;
      }
    }
    this.running = { http, tftp, dhcp, nfs, serverIp, httpPort, base, since: Date.now() };
    this.log(`PXE server running on ${serverIp}. Boot a machine from the network to see the menu.`);
    this.emit('status', this.status());
    return this.status();
  }

  stop() {
    if (!this.running) return this.status();
    for (const k of ['dhcp', 'tftp', 'http', 'nfs']) this.running[k]?.stop();
    this.running = null;
    this.log('PXE server stopped');
    this.emit('status', this.status());
    return this.status();
  }

  status() {
    return this.running ? { running: true, serverIp: this.running.serverIp, httpPort: this.running.httpPort, menuUrl: `${this.running.base}/boot.ipxe`, since: this.running.since } : { running: false };
  }
}

module.exports = { PxeService, BOOTFILES };
