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
  // Synchronously-known platform string (matches Node's
  // `process.platform`: 'darwin', 'win32', 'linux', ...). Used by the
  // renderer to scope CSS for the custom titlebar (Mac+Win get one,
  // Linux falls back to the OS frame). Exposed as a value, not a
  // function, so initial-paint code can read it without an await.
  platform: process.platform,
  // Toggle window-level fullscreen (UI v2 design 2.3). Distinct
  // from per-tile fullscreen which only inflates one screen-share
  // tile over the existing window.
  toggleFullscreen: () => ipcRenderer.invoke('toggle-window-fullscreen'),
  // Resize the calling renderer's BrowserWindow to a specific content
  // size, preserving the caller's display + clamping to the work-area.
  // Used by the screen-share popout to match the shared video's
  // aspect ratio so the popout isn't padded with empty chrome.
  resizeWindowToContent: (w, h) => ipcRenderer.invoke('resize-window-to-content', { width: w, height: h }),
  getScreenSources: () => ipcRenderer.invoke('get-screen-sources'),
  getSupabaseConfig: () => ipcRenderer.invoke('get-supabase-config'),
  // Captions engine — whisper.cpp sidecar. Returns
  // `{ available: false, path: null }` on platforms where no binary
  // was bundled (Linux today). Renderer flips the CC button to
  // disabled when unavailable.
  getWhisperBinaryStatus: () => ipcRenderer.invoke('whisper-binary-status'),
  // Captions model lifecycle. The ~75 MB ggml-tiny.en.bin lives in
  // user-data and is downloaded lazily on first CC click. Renderer
  // calls download() and subscribes to onProgress for the progress bar.
  whisperModel: {
    getStatus:  () => ipcRenderer.invoke('whisper-model-status'),
    download:   () => ipcRenderer.invoke('whisper-model-download'),
    cancel:     () => ipcRenderer.invoke('whisper-model-cancel'),
    deleteFile: () => ipcRenderer.invoke('whisper-model-delete'),
    onProgress: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch {} };
      ipcRenderer.on('whisper-model-progress', handler);
      return () => ipcRenderer.removeListener('whisper-model-progress', handler);
    },
  },
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
