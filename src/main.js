'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { PxeService } = require('./core/pxe-service');
const routerSetup = require('./core/router-setup');

let win;
let service;
let session = { creds: null, plan: null }; // router password lives only in memory

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    title: 'PXE Lab Installer',
    backgroundColor: '#0f1115',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu?.();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function state() {
  return {
    platform: process.platform,
    dataDir: service.dataDir,
    settings: service.settings,
    images: service.publicImages(),
    status: service.status(),
    interfaces: routerSetup.listLocalIPv4(),
    bootfiles: service.bootfileStatus(),
    plan: session.plan,
  };
}

// Wrap handlers so errors reach the UI as { error } instead of noisy rejections.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });
}

app.whenReady().then(() => {
  service = new PxeService({ dataDir: path.join(app.getPath('userData'), 'data') });
  service.on('log', (m) => send('log', m));
  service.on('images', (imgs) => send('images', imgs));
  service.on('progress', (p) => send('progress', p));
  service.on('status', (s) => send('status', s));
  service.on('client', (c) => send('client', c));

  handle('state', () => state());

  handle('router:plan', async ({ host, user, password, desiredIp }) => {
    if (!host || !user) throw new Error('Enter the router IP and username');
    const creds = { host: host.trim(), user: user.trim(), password: password || '' };
    const plan = await routerSetup.plan(creds, { desiredIp: desiredIp || undefined });
    session = { creds, plan };
    service.saveSettings({ router: { host: creds.host, user: creds.user } });
    return plan;
  });

  handle('router:apply', async () => {
    if (!session.plan) throw new Error('Check the router first');
    const done = await routerSetup.apply(session.creds, session.plan);
    service.saveSettings({ serverIp: session.plan.targetIp });
    service.log(`Router configured: ${done.join('; ')}`);
    return { done, plan: session.plan, interfaces: routerSetup.listLocalIPv4() };
  });

  handle('images:addUrl', (url) => service.addUrl(url) && service.publicImages());
  handle('images:addFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose a Linux ISO', filters: [{ name: 'ISO images', extensions: ['iso'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return service.publicImages();
    service.addLocalFile(r.filePaths[0]);
    return service.publicImages();
  });
  handle('images:remove', (id) => (service.remove(id), service.publicImages()));
  handle('images:retry', (id) => (service.retry(id), service.publicImages()));
  handle('images:pause', (id) => (service.pause(id), service.publicImages()));
  handle('images:rename', (id, label) => (service.rename(id, label), service.publicImages()));

  handle('settings:save', (patch) => service.saveSettings(patch));
  handle('interfaces', () => routerSetup.listLocalIPv4());

  handle('server:start', async ({ serverIp }) => {
    const ifc = routerSetup.listLocalIPv4().find((i) => i.address === serverIp);
    if (!ifc) throw new Error(`This computer does not have the address ${serverIp} yet. Renew its network address (see step 1), or choose another address.`);
    service.saveSettings({ serverIp });
    return service.start({ serverIp, netmask: ifc.netmask });
  });
  handle('server:stop', () => service.stop());

  handle('bootfile:import', async (name) => {
    const r = await dialog.showOpenDialog(win, { title: `Choose ${name}`, properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return service.bootfileStatus();
    service.importBootfile(name, r.filePaths[0]);
    return service.bootfileStatus();
  });
  handle('open:data', () => shell.openPath(service.dataDir));
  handle('open:url', (url) => /^https:\/\//.test(url) && shell.openExternal(url));

  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  service?.stop();
  app.quit();
});
app.on('before-quit', () => service?.stop());
