const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('huddle', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  getSupabaseConfig: () => ipcRenderer.invoke('get-supabase-config'),
  getTenorKey: () => ipcRenderer.invoke('get-tenor-key'),
});
