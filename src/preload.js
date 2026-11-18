'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, ...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (fn) => {
  const h = (_e, v) => fn(v);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('pxe', {
  state: () => call('state'),
  routerPlan: (args) => call('router:plan', args),
  routerApply: () => call('router:apply'),
  addUrl: (url) => call('images:addUrl', url),
  addFile: () => call('images:addFile'),
  removeImage: (id) => call('images:remove', id),
  retryImage: (id) => call('images:retry', id),
  pauseImage: (id) => call('images:pause', id),
  renameImage: (id, label) => call('images:rename', id, label),
  saveSettings: (p) => call('settings:save', p),
  interfaces: () => call('interfaces'),
  startServer: (args) => call('server:start', args),
  stopServer: () => call('server:stop'),
  importBootfile: (name) => call('bootfile:import', name),
  openData: () => call('open:data'),
  openUrl: (u) => call('open:url', u),
  onLog: on('log'),
  onImages: on('images'),
  onProgress: on('progress'),
  onStatus: on('status'),
  onClient: on('client'),
});
