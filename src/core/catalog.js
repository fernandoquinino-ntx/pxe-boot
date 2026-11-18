'use strict';
// Quick-download catalog: looks up the current ISO of each supported OS on the vendor's own mirror,
// falling back to a pinned link when the lookup fails (offline, mirror layout changed).
// Nutanix CE and NVIDIA JetPack need a vendor login for new versions, so they only get a page link.
const https = require('https');
const http = require('http');

function getText(url, timeoutMs = 15000, hops = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'user-agent': 'pxe-lab-installer' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops < 5) {
        res.resume();
        return resolve(getText(new URL(res.headers.location, url).href, timeoutMs, hops + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

const verKey = (s) => (s.match(/\d+/g) || []).map(Number);
function cmpVer(a, b) {
  const x = verKey(a), y = verKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}
const hrefs = (html, re) => [...new Set([...html.matchAll(/href="([^"?#]+)"/g)].map((m) => decodeURIComponent(m[1]).replace(/^\.\//, '')).filter((h) => re.test(h)))];
const newest = (list) => list.sort(cmpVer).pop();

// Each entry: id, name, note, family hint, and resolve(get) -> { url, version } (or throws)
const ENTRIES = [
  {
    id: 'ubuntu-server', name: 'Ubuntu Server 24.04 LTS (amd64)', note: 'Whole ISO is loaded into RAM: needs RAM > ISO size + 1 GB.',
    page: 'https://ubuntu.com/download/server',
    fallback: 'https://releases.ubuntu.com/noble/ubuntu-24.04.3-live-server-amd64.iso',
    async resolve(get) {
      const sums = await get('https://releases.ubuntu.com/noble/SHA256SUMS');
      const files = [...sums.matchAll(/\*(ubuntu-[\d.]+-live-server-amd64\.iso)/g)].map((m) => m[1]);
      const f = newest(files);
      return { url: `https://releases.ubuntu.com/noble/${f}`, version: f.match(/ubuntu-([\d.]+)-/)[1] };
    },
  },
  {
    id: 'debian-live', name: 'Debian Live (standard, amd64)', note: 'Current stable.',
    page: 'https://www.debian.org/CD/live/',
    fallback: 'https://cdimage.debian.org/debian-cd/current-live/amd64/iso-hybrid/debian-live-13.7.0-amd64-standard.iso',
    async resolve(get) {
      const base = 'https://cdimage.debian.org/debian-cd/current-live/amd64/iso-hybrid/';
      const f = newest(hrefs(await get(base), /^debian-live-[\d.]+-amd64-standard\.iso$/));
      return { url: base + f, version: f.match(/live-([\d.]+)-/)[1] };
    },
  },
  {
    id: 'fedora-workstation', name: 'Fedora Workstation Live (x86_64)', note: 'Latest release.',
    page: 'https://fedoraproject.org/workstation/download',
    fallback: 'https://dl.fedoraproject.org/pub/fedora/linux/releases/43/Workstation/x86_64/iso/Fedora-Workstation-Live-43-1.6.x86_64.iso',
    async resolve(get) {
      const root = 'https://dl.fedoraproject.org/pub/fedora/linux/releases/';
      const rels = hrefs(await get(root), /^\d+\/$/).map((h) => parseInt(h, 10)).sort((a, b) => b - a);
      for (const r of rels.slice(0, 3)) {
        try {
          const dir = `${root}${r}/Workstation/x86_64/iso/`;
          const f = newest(hrefs(await get(dir), /^Fedora-Workstation-Live.*\.iso$/));
          if (f) return { url: dir + f, version: String(r) };
        } catch { /* try an older release */ }
      }
      throw new Error('no Fedora ISO found');
    },
  },
  { id: 'rocky', name: 'Rocky Linux 9 (minimal)', note: 'Installer ISO, network-booted as a repo.', page: 'https://rockylinux.org/download', fallback: 'https://download.rockylinux.org/pub/rocky/9/isos/x86_64/Rocky-9-latest-x86_64-minimal.iso', version: '9 (latest)' },
  { id: 'alma', name: 'AlmaLinux 9 (minimal)', note: 'Installer ISO, network-booted as a repo.', page: 'https://almalinux.org/get-almalinux/', fallback: 'https://repo.almalinux.org/almalinux/9/isos/x86_64/AlmaLinux-9-latest-x86_64-minimal.iso', version: '9 (latest)' },
  { id: 'centos-stream', name: 'CentOS Stream 9 (DVD)', note: 'Installer ISO, network-booted as a repo.', page: 'https://www.centos.org/centos-stream/', fallback: 'https://mirror.stream.centos.org/9-stream/BaseOS/x86_64/iso/CentOS-Stream-9-latest-x86_64-dvd1.iso', version: '9 (latest)' },
  {
    id: 'proxmox', name: 'Proxmox VE (amd64)', note: 'Whole ISO is loaded into RAM: needs RAM > ISO size + 2 GB.',
    page: 'https://www.proxmox.com/en/downloads/proxmox-virtual-environment/iso',
    fallback: 'https://enterprise.proxmox.com/iso/proxmox-ve_9.2-1.iso',
    async resolve(get) {
      const f = newest(hrefs(await get('https://enterprise.proxmox.com/iso/'), /^proxmox-ve_[\d.]+-\d+\.iso$/));
      return { url: `https://enterprise.proxmox.com/iso/${f}`, version: f.match(/ve_([\d.]+-\d+)/)[1] };
    },
  },
  { id: 'nutanix-ce', name: 'Nutanix CE 2024.08.19 (AOS 6.8.1)', note: 'Experimental. Needs 32 GB RAM on the machine. Newer versions need a Nutanix login: use the page link.', page: 'https://www.nutanix.com/products/community-edition/download', fallback: 'https://download.nutanix.com/ce/2024.08.19/phoenix.x86_64-fnd_5.6.1_patch-aos_6.8.1_ga.iso', version: '2024.08.19' },
  { id: 'jetson', name: 'NVIDIA Jetson JetPack installer (Orin Nano)', note: 'Experimental. NVIDIA requires a login to download: get the ISO from the page, then use "Add ISO file".', page: 'https://developer.nvidia.com/embedded/jetpack', fallback: null },
];

/** Returns [{ id, name, note, page, url|null, version, live }] ; never throws. */
async function discover({ get = getText } = {}) {
  return Promise.all(ENTRIES.map(async (e) => {
    const base = { id: e.id, name: e.name, note: e.note, page: e.page };
    if (e.resolve) {
      try {
        const r = await e.resolve(get);
        return { ...base, url: r.url, version: r.version, live: true };
      } catch { /* fall through to the pinned link */ }
    }
    return { ...base, url: e.fallback, version: e.version || '', live: false };
  }));
}

module.exports = { discover, ENTRIES, getText, cmpVer };
