const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  onState: (cb) => ipcRenderer.on('state', (e, d) => cb(d)),
  onUsage: (cb) => ipcRenderer.on('usage', (e, d) => cb(d)),
  onMenuAction: (cb) => ipcRenderer.on('menu-action', (e, d) => cb(d)),
  open: (id) => ipcRenderer.send('open', id),
  home: () => ipcRenderer.send('home'),
  close: (id) => ipcRenderer.send('close', id),
  reloadActive: () => ipcRenderer.send('reload-active'),
  refreshUsage: (id) => ipcRenderer.send('refresh-usage', id),
  zoomIn: () => ipcRenderer.send('zoom-in'),
  zoomOut: () => ipcRenderer.send('zoom-out'),
  zoomReset: () => ipcRenderer.send('zoom-reset'),
  openSplit: (id, side) => ipcRenderer.send('open-split', id, side),
  showServiceMenu: (id, x, y) => ipcRenderer.send('show-service-menu', id, x, y),
  saveService: (d) => ipcRenderer.send('save-service', d),
  deleteService: (id) => ipcRenderer.send('delete-service', id)
});
