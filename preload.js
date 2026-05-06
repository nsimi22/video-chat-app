const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('huddle', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  getSignalingPort: () => ipcRenderer.invoke('get-signaling-port'),
  onSignalingPort: (cb) => ipcRenderer.on('signaling-port', (_e, port) => cb(port)),
});
