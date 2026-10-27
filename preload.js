const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // updates from the app
  onState: (cb) => ipcRenderer.on('state', (e, d) => cb(d)),
  onUsage: (cb) => ipcRenderer.on('usage', (e, d) => cb(d)),
  onEdit: (cb) => ipcRenderer.on('edit', (e, id) => cb(id)),

  // navigation
  open: (id) => ipcRenderer.send('open', id),
  home: () => ipcRenderer.send('home'),
  close: (id) => ipcRenderer.send('close', id),
  reloadActive: () => ipcRenderer.send('reload-active'),

  // zoom: dir is 'in', 'out' or 'reset'
  zoom: (dir) => ipcRenderer.send('zoom', dir),
  zoomService: (id, dir) => ipcRenderer.send('zoom-id', { id, dir }),

  // split screen
  splitMenu: () => ipcRenderer.send('split-menu'),
  splitClose: () => ipcRenderer.send('split-close'),
  splitSwap: () => ipcRenderer.send('split-swap'),

  // right-click menu for a tab or tile
  contextMenu: (id) => ipcRenderer.send('context-menu', id),

  // services and usage
  refreshUsage: (id) => ipcRenderer.send('refresh-usage', id),
  saveService: (d) => ipcRenderer.send('save-service', d),
  deleteService: (id) => ipcRenderer.send('delete-service', id)
});
