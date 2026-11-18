'use strict';
// HTTP(S) download with redirects, progress and resume.

const fs = require('fs');
const http = require('http');
const https = require('https');

function download(url, dest, { onProgress, signal, maxRedirects = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const part = dest + '.part';
    let startAt = 0;
    try {
      startAt = fs.statSync(part).size;
    } catch {}

    const go = (u, redirects) => {
      let parsed;
      try {
        parsed = new URL(u);
      } catch {
        return reject(new Error(`Invalid URL: ${u}`));
      }
      const lib = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null;
      if (!lib) return reject(new Error('Only http:// and https:// links are supported'));
      const headers = { 'User-Agent': 'PXE-Lab-Installer/1.0' };
      if (startAt > 0) headers.Range = `bytes=${startAt}-`;
      const req = lib.get(u, { headers }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('Too many redirects'));
          return go(new URL(res.headers.location, u).toString(), redirects - 1);
        }
        if (res.statusCode === 416 && startAt > 0) {
          // already complete
          res.resume();
          fs.renameSync(part, dest);
          return resolve(dest);
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        }
        const resumed = res.statusCode === 206;
        if (!resumed) startAt = 0;
        const len = parseInt(res.headers['content-length'] || '0', 10);
        const total = len ? len + startAt : 0;
        let got = startAt;
        const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
        let last = 0;
        res.on('data', (chunk) => {
          got += chunk.length;
          const now = Date.now();
          if (onProgress && now - last > 300) {
            last = now;
            onProgress({ received: got, total });
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          if (total && got < total) return reject(new Error('Download interrupted. Press retry to resume.'));
          onProgress?.({ received: got, total: total || got });
          fs.renameSync(part, dest);
          resolve(dest);
        });
        res.on('error', reject);
        out.on('error', reject);
      });
      req.on('error', (e) => reject(new Error(`Download failed: ${e.message}`)));
      if (signal) {
        if (signal.aborted) req.destroy(new Error('Cancelled'));
        signal.addEventListener('abort', () => req.destroy(new Error('Cancelled')), { once: true });
      }
    };
    go(url, maxRedirects);
  });
}

module.exports = { download };
