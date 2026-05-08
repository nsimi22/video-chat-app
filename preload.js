const { contextBridge, ipcRenderer } = require('electron');

// Cross-window event relay for popouts. The main process echoes
// these to every window except the sender; consumers can subscribe
// via huddle.onPopoutEvent to react to "popout opened"/"popout
// closed"/etc.
const popoutListeners = new Set();
ipcRenderer.on('popout-event', (_e, msg) => {
  for (const cb of popoutListeners) {
    try { cb(msg); } catch {}
  }
});

// huddle:// protocol URL delivery. main.js sends a `protocol-url`
// IPC whenever the OS hands the app a deep link (cold-start,
// open-url on macOS, second-instance on Windows/Linux). The set
// is shared so multiple subscribers stay supported, though in
// practice the main renderer registers one.
const protocolListeners = new Set();
ipcRenderer.on('protocol-url', (_e, url) => {
  for (const cb of protocolListeners) {
    try { cb(url); } catch {}
  }
});

contextBridge.exposeInMainWorld('huddle', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  getSupabaseConfig: () => ipcRenderer.invoke('get-supabase-config'),
  fetchProxy: (req) => ipcRenderer.invoke('fetch-proxy', req),

  // Popout windows. `openPopout({ target, teamId, channelId, whiteboardId, title })`
  // spawns a child renderer that boots into the requested view.
  // sendPopoutEvent broadcasts a small JSON payload to every other
  // window; onPopoutEvent registers a listener (returns an unsubscribe
  // function).
  openPopout: (opts) => ipcRenderer.invoke('open-popout', opts),
  closePopout: (opts) => ipcRenderer.invoke('close-popout', opts),
  sendPopoutEvent: (msg) => ipcRenderer.send('popout-event', msg),
  onPopoutEvent: (cb) => {
    popoutListeners.add(cb);
    return () => popoutListeners.delete(cb);
  },

  // huddle:// protocol URLs. Renderer subscribes once at boot;
  // every URL the OS hands us flows through here. Returns an
  // unsubscribe function for symmetry with onPopoutEvent.
  onProtocolUrl: (cb) => {
    protocolListeners.add(cb);
    return () => protocolListeners.delete(cb);
  },
});
