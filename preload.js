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

// System wake / screen-unlock relay. main.js forwards Electron
// powerMonitor 'resume'/'unlock-screen' as a `system-resume` IPC so the
// renderer can recover a WebSocket the OS left half-open across sleep.
const resumeListeners = new Set();
ipcRenderer.on('system-resume', (_e, msg) => {
  for (const cb of resumeListeners) {
    try { cb(msg); } catch {}
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
  // macOS Screen Recording permission status ('granted'|'denied'|'restricted'|
  // 'not-determined'|'unknown'; always 'granted' off macOS) + a deep link to
  // the System Settings pane to re-enable it.
  getScreenAccess: () => ipcRenderer.invoke('get-screen-access'),
  openScreenSettings: () => ipcRenderer.invoke('open-screen-settings'),
  getSupabaseConfig: () => ipcRenderer.invoke('get-supabase-config'),
  // Captions engine — whisper.cpp sidecar. Returns
  // `{ available: false, path: null }` on platforms where no binary
  // was bundled (Linux today). Renderer flips the CC button to
  // disabled when unavailable.
  getWhisperBinaryStatus: () => ipcRenderer.invoke('whisper-binary-status'),
  // Captions model lifecycle. Multiple model sizes live in user-data
  // (tiny / base / small / medium); the user picks one as active via
  // Settings → Captions. Each lifecycle method takes an optional
  // model id; omitting falls back to the active model.
  whisperModel: {
    list:       () => ipcRenderer.invoke('whisper-model-list'),
    setCurrent: (id) => ipcRenderer.invoke('whisper-model-set', id),
    getStatus:  (id) => ipcRenderer.invoke('whisper-model-status', id),
    download:   (id) => ipcRenderer.invoke('whisper-model-download', id),
    cancel:     () => ipcRenderer.invoke('whisper-model-cancel'),
    deleteFile: (id) => ipcRenderer.invoke('whisper-model-delete', id),
    onProgress: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch {} };
      ipcRenderer.on('whisper-model-progress', handler);
      return () => ipcRenderer.removeListener('whisper-model-progress', handler);
    },
  },
  // Captions inference. Renderer ships per-chunk WAV buffers; main
  // spawns whisper-cli and replies with caption-line events tagged
  // by the same chunkId the renderer included.
  whisperEngine: {
    transcribeChunk: (payload) => ipcRenderer.invoke('whisper-transcribe-chunk', payload),
    onCaptionLine: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch {} };
      ipcRenderer.on('caption-line', handler);
      return () => ipcRenderer.removeListener('caption-line', handler);
    },
  },
  // In-app terminal. The real shell runs in main (the renderer is
  // sandboxed); this narrow bridge is the only surface it exposes.
  // spawn/write/resize/kill are request/response; onData/onExit are
  // push subscriptions that return an unsubscribe fn — same shape as
  // whisperEngine.onCaptionLine above.
  terminal: {
    spawn:  (opts) => ipcRenderer.invoke('terminal-spawn', opts || {}),
    write:  (id, data) => ipcRenderer.invoke('terminal-write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.invoke('terminal-resize', { id, cols, rows }),
    kill:   (id) => ipcRenderer.invoke('terminal-kill', { id }),
    onData: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch {} };
      ipcRenderer.on('terminal-data', handler);
      return () => ipcRenderer.removeListener('terminal-data', handler);
    },
    onExit: (cb) => {
      const handler = (_e, payload) => { try { cb(payload); } catch {} };
      ipcRenderer.on('terminal-exit', handler);
      return () => ipcRenderer.removeListener('terminal-exit', handler);
    },
  },
  fetchProxy: (req) => ipcRenderer.invoke('fetch-proxy', req),
  // Claude Code AI provider: run the user's local `claude` CLI headlessly
  // so /ai uses their already-configured (and already-authenticated) MCP
  // servers. Request/response only — { prompt, allowedTools?, binPath? }
  // in, { ok, text, sessionId, costUsd } | { ok:false, error } out.
  claudeCode: {
    run: (opts) => ipcRenderer.invoke('claude-code-run', opts || {}),
    // Binary presence probe (no CLI spawn) — powers the Settings
    // auto-default to the claude-code provider when no API key exists.
    detect: (opts) => ipcRenderer.invoke('claude-code-detect', opts || {}),
    // Local transcript scan for the Usage dashboard: per-day / per-model
    // token + estimated-cost aggregates across account profiles. Reads
    // <config-dir>/projects/**.jsonl in main; only aggregates cross IPC.
    usageScan: (opts) => ipcRenderer.invoke('claude-usage-scan', opts || {}),
  },
  // Render HTML to a PDF via a hidden window + native save dialog
  // (roadmap export). Returns { ok, path } or { ok:false, canceled|error }.
  exportPdf: (payload) => ipcRenderer.invoke('export-pdf', payload),
  // Main-process-backed clipboard for the text-input context menu. Using
  // Electron's clipboard (rather than navigator.clipboard / execCommand)
  // sidesteps the renderer permission handler and works reliably for
  // cut/copy/paste against the focused field. The `clipboard` module isn't
  // available to a sandboxed preload, so these hop to the main process via
  // IPC; readText stays synchronous (sendSync) because the paste handler
  // splices the returned string inline.
  clipboard: {
    readText: () => ipcRenderer.sendSync('clipboard-read-text'),
    writeText: (text) => ipcRenderer.send('clipboard-write-text', String(text ?? '')),
  },
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

  // Fires when the OS wakes from sleep or the screen is unlocked. The
  // renderer uses this to force a Realtime reconnect + message gap-fill,
  // since a half-open socket won't trigger focus/online/SUBSCRIBED.
  // Returns an unsubscribe function, matching onPopoutEvent/onProtocolUrl.
  onSystemResume: (cb) => {
    resumeListeners.add(cb);
    return () => resumeListeners.delete(cb);
  },
});
