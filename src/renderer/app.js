'use strict';
/* global pxe */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let S = { images: [], status: { running: false }, interfaces: [], settings: {}, plan: null };
const clients = new Map();

function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), err ? 7000 : 3500);
}

async function call(fn, ...args) {
  const r = await fn(...args);
  if (!r.ok) {
    toast(r.error, true);
    throw new Error(r.error);
  }
  return r.data;
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = label || 'Working…';
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.disabled = false;
  }
}

function log(line) {
  const el = $('#log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

const fmtSize = (n) => (!n ? '' : n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(0) + ' MB');

function renewHelp() {
  return S.platform === 'win32'
    ? 'Open <b>Command Prompt</b> and run <code class="mono">ipconfig /renew</code>, or unplug and re-plug the network cable.'
    : 'Open <b>System Settings → Network →</b> your wired adapter <b>→ Details → TCP/IP → Renew DHCP Lease</b>, or unplug and re-plug the cable.';
}

// ---------------- Step 1: router ----------------

function renderPlan(p, applied) {
  const box = $('#plan');
  if (!p) return box.classList.add('hidden');
  box.classList.remove('hidden');
  const hasIp = S.interfaces.some((i) => i.address === p.targetIp);
  const leaseText = {
    add: 'Reserve',
    'make-static': 'Make this computer’s address fixed:',
    update: 'Change the reservation to',
    none: 'Already reserved:',
  }[p.leaseAction];
  box.innerHTML = `
    <dl class="facts">
      <dt>Router</dt><dd>${esc(p.router.identity)} · ${esc(p.router.board)} · RouterOS ${esc(p.router.version)}</dd>
      <dt>This computer</dt><dd>${esc(p.local.name)} · <code>${esc(p.local.mac)}</code> · now <code>${esc(p.local.address)}</code></dd>
      <dt>Lab network</dt><dd><code>${esc(p.network.address)}</code> · router hands out <code>${esc(p.pools.join(', '))}</code></dd>
    </dl>
    <div class="change"><span class="ico">IP</span><span>${leaseText}</span>
      <input id="target-ip" value="${esc(p.targetIp)}" ${applied ? 'disabled' : ''}/>
      <span class="hint">${p.targetOutsidePool ? 'outside the range the router hands out ✓' : 'inside the DHCP range'}</span></div>
    <div class="change"><span class="ico">⇢</span><span>Point the router’s network-boot setting (next-server) to <code class="mono">${esc(p.targetIp)}</code>${p.nextServerAction === 'none' ? ' — already set' : ''}</span></div>
    ${p.warnings.map((w) => `<div class="note">${esc(w)}</div>`).join('')}
    ${
      applied
        ? `<div class="note ok"><b>Router configured.</b> ${hasIp ? 'This computer already uses ' + esc(p.targetIp) + '.' : 'Now switch this computer to its new address ' + esc(p.targetIp) + ':<ol><li>' + renewHelp() + '</li><li>Come back and press <b>Start server</b> below.</li></ol>'}</div>`
        : `<div class="actions"><button class="primary" id="r-apply">Apply to router</button><button id="r-recheck">Re-check with this IP</button></div>`
    }`;
  $('#router-badge').textContent = applied ? 'Configured' : 'Ready to apply';
  $('#router-badge').className = 'badge ' + (applied ? 'ok' : 'warn');
  if (!applied) {
    $('#r-apply').onclick = async (e) => {
      busy(e.target, true, 'Applying…');
      try {
        const r = await call(pxe.routerApply);
        S.interfaces = r.interfaces;
        renderPlan(p, true);
        renderServerIps(p.targetIp);
        toast('Router updated');
      } catch {
        busy(e.target, false);
      }
    };
    $('#r-recheck').onclick = () => checkRouter($('#target-ip').value.trim());
  }
}

async function checkRouter(desiredIp) {
  const btn = $('#r-check');
  busy(btn, true, 'Connecting…');
  try {
    const p = await call(pxe.routerPlan, { host: $('#r-host').value, user: $('#r-user').value, password: $('#r-pass').value, desiredIp });
    S.plan = p;
    renderPlan(p, p.leaseAction === 'none' && p.nextServerAction === 'none' && !p.warnings.length);
  } catch {
    $('#router-badge').textContent = '';
  } finally {
    busy(btn, false);
  }
}

// ---------------- Step 2: images ----------------

const LETTER = { ubuntu: 'U', 'debian-live': 'D', 'debian-installer': 'D', 'fedora-live': 'F', 'redhat-installer': 'R', proxmox: 'P', nutanix: 'N', 'nutanix-ce': 'N' };

function renderImages() {
  const ul = $('#image-list');
  const ready = S.images.filter((i) => i.status === 'ready').length;
  $('#images-badge').textContent = S.images.length ? `${ready} ready` : '';
  $('#images-badge').className = 'badge ' + (ready ? 'ok' : 'warn');
  if (!S.images.length) {
    ul.innerHTML = '<li class="empty">No images yet. Paste an ISO link above — or just use the online installers below.</li>';
    return;
  }
  ul.innerHTML = S.images
    .map((i) => {
      const fam = i.family || 'none';
      const pct = Math.round((i.progress || 0) * 100);
      let meta = esc(i.local ? i.file : i.url);
      let cls = '';
      if (i.status === 'downloading') meta = `Downloading… ${pct}% ${fmtSize(i.size)}`;
      if (i.status === 'unsupported') (meta = esc(i.reason)), (cls = 'warn');
      if (i.status === 'error') (meta = esc(i.error)), (cls = 'err');
      if (i.status === 'paused') meta = `Paused at ${pct}%`;
      if (i.status === 'ready') meta = `${fmtSize(i.size)} · ${esc({ ubuntu: 'Ubuntu live/installer', 'debian-live': 'Debian live', 'fedora-live': 'Fedora live', 'redhat-installer': 'Installer (Anaconda)', proxmox: 'Proxmox (loaded into RAM)', 'nutanix-ce': 'Nutanix CE (loaded into RAM, experimental)' }[i.family] || i.family)}`;
      const btns = [
        i.status === 'downloading' ? `<button data-act="pause" data-id="${i.id}">Pause</button>` : '',
        ['paused', 'error'].includes(i.status) && i.url ? `<button data-act="retry" data-id="${i.id}">${i.status === 'paused' ? 'Resume' : 'Retry'}</button>` : '',
        `<button class="danger" data-act="remove" data-id="${i.id}">Remove</button>`,
      ].join('');
      return `<li class="img" data-id="${i.id}">
        <span class="distro ${esc(fam)}">${LETTER[fam] || '?'}</span>
        <div><div><span class="title" contenteditable="${i.status === 'ready'}" data-id="${i.id}" spellcheck="false">${esc(i.label)}</span><span class="status ${esc(i.status)}">${esc(i.status)}</span></div>
          <div class="meta ${cls}" id="meta-${i.id}">${meta}</div>
          ${i.status === 'downloading' ? `<div class="bar"><i id="bar-${i.id}" style="width:${pct}%"></i></div>` : ''}</div>
        <div class="btns">${btns}</div></li>`;
    })
    .join('');
}

$('#image-list').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const { act, id } = b.dataset;
  if (act === 'remove' && !confirm('Remove this image and delete its downloaded file?')) return;
  S.images = await call({ remove: pxe.removeImage, retry: pxe.retryImage, pause: pxe.pauseImage }[act], id);
  renderImages();
});
$('#image-list').addEventListener('keydown', (e) => {
  if (e.target.classList.contains('title') && e.key === 'Enter') {
    e.preventDefault();
    e.target.blur();
  }
});
$('#image-list').addEventListener('focusout', async (e) => {
  if (!e.target.classList.contains('title')) return;
  const label = e.target.textContent.trim();
  if (label) S.images = await call(pxe.renameImage, e.target.dataset.id, label);
});

// ---------------- Step 3: server ----------------

function renderServerIps(prefer) {
  const sel = $('#s-ip');
  const current = prefer || sel.value || S.settings.serverIp;
  const opts = S.interfaces.map((i) => `<option value="${esc(i.address)}">${esc(i.address)} (${esc(i.name)})</option>`);
  if (current && !S.interfaces.some((i) => i.address === current)) opts.unshift(`<option value="${esc(current)}">${esc(current)} (after renewing the address)</option>`);
  sel.innerHTML = opts.join('');
  if (current) sel.value = current;
}

function renderStatus() {
  const st = S.status;
  const pill = $('#server-pill');
  pill.className = 'pill ' + (st.running ? 'on' : 'off');
  $('#server-pill-text').textContent = st.running ? `Serving on ${st.serverIp}` : 'Server stopped';
  const btn = $('#s-toggle');
  btn.textContent = st.running ? 'Stop server' : 'Start server';
  btn.classList.toggle('primary', !st.running);
  btn.classList.toggle('danger', st.running);
  for (const id of ['#s-ip', '#s-port']) $(id).disabled = st.running;
  $('#s-hint').innerHTML = st.running ? `Menu: <code class="mono">${esc(st.menuUrl)}</code>` : 'Uses ports 67, 69, 4011 (UDP) and the web port (TCP).';
}

function renderBootfiles() {
  $('#bootfiles').innerHTML = (S.bootfiles || [])
    .map((b) => `<span class="bf"><b class="${b.present ? '' : 'miss'}">${b.present ? '✓' : '•'}</b>${esc(b.name)}<button data-bf="${esc(b.name)}">Import…</button></span>`)
    .join('') + (S.bootfiles?.some((b) => !b.present) ? '<span class="hint">Missing files download automatically when you start the server.</span>' : '');
}
$('#bootfiles').addEventListener('click', async (e) => {
  const n = e.target.dataset.bf;
  if (n) {
    S.bootfiles = await call(pxe.importBootfile, n);
    renderBootfiles();
  }
});

function renderClients() {
  $('#clients').classList.toggle('hidden', clients.size === 0);
  $('#client-list').innerHTML = [...clients.values()]
    .sort((a, b) => b.at - a.at)
    .map((c) => `<li><span>${esc(c.mac)}</span><span>${esc(c.arch)}</span><span>${new Date(c.at).toLocaleTimeString()}</span></li>`)
    .join('');
}

$('#s-toggle').onclick = async (e) => {
  const btn = e.target;
  if (S.status.running) {
    S.status = await call(pxe.stopServer);
    return renderStatus();
  }
  busy(btn, true, 'Starting…');
  try {
    await call(pxe.saveSettings, { httpPort: Number($('#s-port').value) || 8080, menuTimeout: Number($('#s-timeout').value) || 60 });
    S.status = await call(pxe.startServer, { serverIp: $('#s-ip').value });
    toast('Server running — boot a machine from the network');
  } catch {
  } finally {
    busy(btn, false);
    renderStatus();
    S.bootfiles = (await pxe.state()).data?.bootfiles;
    renderBootfiles();
  }
};

// ---------------- wiring ----------------

$('#router-form').onsubmit = (e) => {
  e.preventDefault();
  checkRouter();
};
$('#url-form').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('#iso-url').value.trim();
  if (!url) return;
  S.images = await call(pxe.addUrl, url);
  $('#iso-url').value = '';
  renderImages();
};
$('#add-file').onclick = async () => {
  S.images = await call(pxe.addFile);
  renderImages();
};
for (const [id, key] of [['#b-debian', 'debian-netinst'], ['#b-netboot', 'netbootxyz']]) {
  $(id).onchange = async () => {
    S.settings.builtins = { ...S.settings.builtins, [key]: $(id).checked };
    await call(pxe.saveSettings, { builtins: S.settings.builtins });
  };
}
$('#s-timeout').onchange = () => call(pxe.saveSettings, { menuTimeout: Number($('#s-timeout').value) || 60 });
$('#open-data').onclick = () => pxe.openData();
$('#log-clear').onclick = () => ($('#log').textContent = '');

pxe.onLog(log);
pxe.onImages((imgs) => {
  if (S.catalog) setTimeout(renderCatalog, 0);
  S.images = imgs;
  renderImages();
});
pxe.onProgress(({ id, progress, total }) => {
  const img = S.images.find((i) => i.id === id);
  if (img) Object.assign(img, { progress, size: total });
  const bar = document.getElementById('bar-' + id);
  const meta = document.getElementById('meta-' + id);
  if (bar) bar.style.width = Math.round(progress * 100) + '%';
  if (meta) meta.textContent = `Downloading… ${Math.round(progress * 100)}% of ${fmtSize(total)}`;
});
pxe.onStatus((s) => {
  S.status = s;
  renderStatus();
});
pxe.onClient((c) => {
  clients.set(c.mac, { ...c, at: Date.now() });
  renderClients();
});

(async function init() {
  S = await call(pxe.state);
  $('#r-host').value = S.settings.router?.host || '192.168.1.1';
  $('#r-user').value = S.settings.router?.user || 'admin';
  $('#s-port').value = S.settings.httpPort || 8080;
  $('#s-timeout').value = S.settings.menuTimeout || 60;
  $('#b-debian').checked = S.settings.builtins?.['debian-netinst'] !== false;
  $('#b-netboot').checked = S.settings.builtins?.netbootxyz !== false;
  renderImages();
  renderServerIps(S.settings.serverIp);
  renderStatus();
  renderBootfiles();
  log(`Data folder: ${S.dataDir}`);
})();

// ---- Quick download catalog (latest ISO of each supported OS, looked up on the vendor mirrors) ----
async function loadCatalog() {
  const ul = $('#quick-list');
  ul.innerHTML = '<li class="empty">Looking up the latest versions…</li>';
  let items = [];
  try {
    items = await call(pxe.catalog);
  } catch (e) {
    ul.innerHTML = `<li class="empty">Could not look up versions: ${esc(e.message)}</li>`;
    return;
  }
  S.catalog = items;
  renderCatalog();
}
function renderCatalog() {
  const have = new Set(S.images.map((i) => i.url));
  $('#quick-list').innerHTML = (S.catalog || [])
    .map((c) => {
      const added = c.url && have.has(c.url);
      const btn = c.url
        ? `<button data-dl="${esc(c.id)}" ${added ? 'disabled' : ''}>${added ? 'Added' : 'Download'}</button>`
        : '';
      const link = `<a href="#" data-page="${esc(c.page)}">Open download page</a>`;
      return `<li class="img"><div class="img-main"><div class="img-title">${esc(c.name)}${c.version ? ` <span class="hint">${esc(c.version)}${c.live ? '' : ' (pinned link)'}</span>` : ''}</div><div class="img-meta">${esc(c.note || '')}</div></div><div class="img-actions">${btn} ${link}</div></li>`;
    })
    .join('');
}
$('#quick-list').onclick = async (e) => {
  const page = e.target.dataset.page;
  if (page) { e.preventDefault(); pxe.openUrl(page); return; }
  const id = e.target.dataset.dl;
  if (!id) return;
  const c = (S.catalog || []).find((x) => x.id === id);
  if (!c || !c.url) return;
  e.target.disabled = true;
  try {
    S.images = await call(pxe.addUrl, c.url);
    renderImages();
    renderCatalog();
  } catch (err) {
    e.target.disabled = false;
  }
};
$('#quick-refresh').onclick = loadCatalog;
loadCatalog();
