'use strict';
// HTTP server for the boot menu, iPXE binaries, files inside ISOs and whole ISOs.
// Supports Range requests (installers resume and read partial files).

const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) end = size - 1;
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

class BootHttpServer extends EventEmitter {
  /**
   * provider: {
   *   menu(): string,
   *   bootfile(name): absolute path | null,
   *   isoEntry(id, innerPath): { size, stream(start,end) } | null,
   *   isoFile(id): absolute path | null
   * }
   */
  constructor({ port = 8080, host = '0.0.0.0', provider }) {
    super();
    this.port = port;
    this.host = host;
    this.provider = provider;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.once('error', (e) => {
        if (e.code === 'EADDRINUSE') e.message = `TCP port ${this.port} is already in use. Pick another HTTP port in Settings.`;
        reject(e);
      });
      this.server.listen(this.port, this.host, () => {
        this.port = this.server.address().port;
        this.emit('log', `HTTP server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server.closeAllConnections?.();
      this.server = null;
    }
  }

  _send(req, res, size, stream, type = 'application/octet-stream') {
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
    let start = 0;
    let end = size - 1;
    if (range) {
      ({ start, end } = range);
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, headers);
    if (req.method === 'HEAD' || size === 0) return res.end();
    const s = stream(start, end);
    s.on('error', () => res.destroy());
    res.on('close', () => s.destroy());
    s.pipe(res);
  }

  _handle(req, res) {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const who = req.socket.remoteAddress?.replace('::ffff:', '');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end();
    }
    try {
      if (url === '/boot.ipxe') {
        const body = Buffer.from(this.provider.menu());
        this.emit('log', `${who} loaded the boot menu`);
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      let m;
      if ((m = /^\/bootfiles\/([\w.\-]+)$/.exec(url))) {
        const f = this.provider.bootfile(m[1]);
        if (!f) return this._404(res);
        const size = fs.statSync(f).size;
        return this._send(req, res, size, (s, e) => fs.createReadStream(f, { start: s, end: e }));
      }
      if ((m = /^\/isofile\/([\w\-]+)\.iso$/.exec(url))) {
        const f = this.provider.isoFile(m[1]);
        if (!f) return this._404(res);
        const size = fs.statSync(f).size;
        if (!req.headers.range) this.emit('log', `${who} is downloading the full ISO ${m[1]}`);
        return this._send(req, res, size, (s, e) => fs.createReadStream(f, { start: s, end: e }), 'application/x-iso9660-image');
      }
      if ((m = /^\/pveiso\/([\w\-]+)\.cpio$/.exec(url))) {
        const entry = this.provider.isoCpio?.(m[1]);
        if (!entry) return this._404(res);
        if (!req.headers.range) this.emit('log', `${who} is loading the Proxmox ISO ${m[1]} into RAM`);
        return this._send(req, res, entry.size, entry.stream);
      }
      if ((m = /^\/iso\/([\w\-]+)(\/.*)?$/.exec(url))) {
        const inner = m[2] || '/';
        if (inner.split('/').includes('..')) return this._404(res);
        const entry = this.provider.isoEntry(m[1], inner);
        if (!entry) return this._404(res);
        if (entry.isDir) {
          // tiny directory listing (Anaconda does not need it, but it helps debugging)
          const body = Buffer.from(entry.list.map((e) => `<a href="${encodeURIComponent(e.name)}${e.isDir ? '/' : ''}">${e.name}</a>`).join('<br>\n'));
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': body.length });
          return res.end(req.method === 'HEAD' ? undefined : body);
        }
        if (!req.headers.range && entry.size > 1024 * 1024) this.emit('log', `${who} GET ${url}`);
        return this._send(req, res, entry.size, entry.stream);
      }
      if (url === '/') {
        const body = Buffer.from('PXE Lab Installer is running. Boot menu: /boot.ipxe\n');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
        return res.end(body);
      }
      return this._404(res);
    } catch (e) {
      this.emit('log', `HTTP error for ${url}: ${e.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  _404(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
  }
}

module.exports = { BootHttpServer, parseRange };
