const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('agent', {
  scan: () => ipcRenderer.invoke('scan'),
  startChrome: () => ipcRenderer.invoke('start-chrome'),
  getState: () => ipcRenderer.invoke('get-state'),
  spamStart: (payload) => ipcRenderer.invoke('spam-start', payload),
  spamStop: (payload) => ipcRenderer.invoke('spam-stop', payload),
  spamAll: (payload) => ipcRenderer.invoke('spam-all', payload),
  browseStart: (payload) => ipcRenderer.invoke('browse-start', payload),
  browseStop: (payload) => ipcRenderer.invoke('browse-stop', payload),
  stopAll: () => ipcRenderer.invoke('stop-all'),
  onLog: (cb) => ipcRenderer.on('log', (_e, payload) => cb(payload)),
  onTabs: (cb) => ipcRenderer.on('tabs', (_e, tabs) => cb(tabs)),
})