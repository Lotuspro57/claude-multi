const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onInit: (cb) => ipcRenderer.on('init', (e, d) => cb(d)),
  onUsage: (cb) => ipcRenderer.on('usage', (e, d) => cb(d)),
  onZoomed: (cb) => ipcRenderer.on('zoomed', (e, d) => cb(d)),
  rename: (id, name) => ipcRenderer.send('rename', { id, name }),
  zoom: (id) => ipcRenderer.send('zoom', id),
  reload: (id) => ipcRenderer.send('reload', id),
  refreshUsage: (id) => ipcRenderer.send('refresh-usage', id)
});
