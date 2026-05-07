const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('huddle', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  getSupabaseConfig: () => ipcRenderer.invoke('get-supabase-config'),
  fetchProxy: (req) => ipcRenderer.invoke('fetch-proxy', req),
});
