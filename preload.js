const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('huddle', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  getSignalingPort: () => ipcRenderer.invoke('get-signaling-port'),
  getTenorKey: () => ipcRenderer.invoke('get-tenor-key'),
  onSignalingPort: (cb) => ipcRenderer.on('signaling-port', (_e, port) => cb(port)),
});
