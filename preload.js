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
// open-url on macOS, second-instance on Windows/Linux). The
// renderer's onProtocolUrl callback only registers AFTER its
// IIFE boots (which awaits getActiveSession), so URLs delivered
// in the meantime would otherwise be silently dropped — buffer
// them here and flush on the first add().
const protocolListeners = new Set();
const pendingProtocolUrls = [];
ipcRenderer.on('protocol-url', (_e, url) => {
  if (protocolListeners.size === 0) {
    pendingProtocolUrls.push(url);
    return;
  }
  for (const cb of protocolListeners) {
    try { cb(url); } catch {}
  }
});

contextBridge.exposeInMainWorld('huddle', {
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  getSupabaseConfig: () => ipcRenderer.invoke('get-supabase-config'),
  fetchProxy: (req) => ipcRenderer.invoke('fetch-proxy', req),
  // ICS calendar subscription fetch. Separate from fetchProxy because
  // it accepts any HTTPS host (user-supplied URL in Settings) — the
  // main-process handler enforces a private-IP block, an HTTPS-only
  // policy, and a response-size cap.
  icsFetch: (url) => ipcRenderer.invoke('ics-fetch', { url }),

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
  // every URL the OS hands us flows through here. Drains any
  // URLs that arrived before this call so cold-start clicks
  // can't slip through the registration gap. Returns an
  // unsubscribe function for symmetry with onPopoutEvent.
  onProtocolUrl: (cb) => {
    protocolListeners.add(cb);
    while (pendingProtocolUrls.length) {
      const url = pendingProtocolUrls.shift();
      try { cb(url); } catch {}
    }
    return () => protocolListeners.delete(cb);
  },
});
