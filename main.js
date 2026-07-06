// Electron entry. With Supabase as the backend, the bundled signaling/chat
// server is gone — main.js only opens the BrowserWindow, hands the renderer
// a Supabase URL + publishable key, and exposes the desktopCapturer for
// screen sharing.
const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell, dialog, systemPreferences, clipboard, powerMonitor } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// Windows shows toast notifications under an "AppUserModelID"; without an
// explicit one, renderer `new Notification()` calls are silently dropped on
// Windows. No-op on macOS/Linux. Called before app `ready` per Electron's
// guidance. NOTE: must stay in sync with `build.appId` in package.json — we
// can't read it back from package.json at runtime because electron-builder
// strips the `build` block out of the packaged app's package.json.
const APP_ID = 'com.huddle.app';
app.setAppUserModelId(APP_ID);

// Defaults point at the project I provisioned. Override either via env vars
// (HUDDLE_SUPABASE_URL / HUDDLE_SUPABASE_KEY) for self-hosted Supabase.
const SUPABASE_URL = process.env.HUDDLE_SUPABASE_URL
  || 'https://jwqvrdgjpftjiwvgdrck.supabase.co';
const SUPABASE_KEY = process.env.HUDDLE_SUPABASE_KEY
  || 'sb_publishable_5eJWwJEHWHSLuhFEs2iUlw_tu4fGOvn';

let mainWindow;
// Popout child windows keyed by their target token (e.g.
// `whiteboard:<uuid>`, `call:<channel_id>`). Used to focus an
// existing popout if the user clicks the button twice and to
// fan-out IPC events to / from the popouts. Cleared on window
// 'closed' so a second pop-out works after the first is closed.
const popouts = new Map();

// huddle:// protocol handler. When the OS hands us a deep link
// (clicked huddle invite URL in chat / browser / email), the URL
// arrives via `open-url` on macOS or via process.argv on a
// second-instance launch on Windows/Linux. We deliver it to the
// renderer through IPC; the renderer routes it through the
// existing invite-redeem path. Cold-start URLs that arrive before
// the renderer is ready buffer here and flush on did-finish-load.
const HUDDLE_PROTOCOL = 'huddle';
const pendingProtocolUrls = [];

// Single-instance lock: a second launch (typical when an OS
// click on huddle://X starts the app while it's already running)
// hands its argv to this instance via the second-instance event
// instead of spinning up a duplicate process.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = argv.find((a) => typeof a === 'string' && a.startsWith(`${HUDDLE_PROTOCOL}://`));
    // Window-focus is centralised in deliverProtocolUrl so a URL
    // arriving via open-url (macOS) or pending-buffer drain gets
    // the same restore + focus treatment.
    if (url) { deliverProtocolUrl(url); return; }
    // No deep link means the user just launched the app again (taskbar
    // pin, Start menu, double-clicked the installer shortcut). Surface
    // the existing window — otherwise the second launch exits silently
    // and the app looks like it failed to start.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      try { mainWindow.focus(); } catch {}
    }
  });
}

// Register the scheme. On packaged builds this writes the OS
// association (Info.plist on Mac, registry on Windows). In dev
// (electron .) Windows/Linux need the executable + script-path
// args so the OS knows how to relaunch us with the URL.
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(HUDDLE_PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient(HUDDLE_PROTOCOL);
}

// macOS delivers huddle:// URLs via this event (both cold-start
// and while running). Windows/Linux use second-instance argv +
// initial process.argv (see below).
app.on('open-url', (event, url) => {
  event.preventDefault();
  deliverProtocolUrl(url);
});

// Cold-start with the URL on the command line (Windows/Linux):
const initialUrl = process.argv.find((a) => typeof a === 'string' && a.startsWith(`${HUDDLE_PROTOCOL}://`));
if (initialUrl) pendingProtocolUrls.push(initialUrl);

function deliverProtocolUrl(url) {
  // Bring the main window forward whenever a URL is delivered so
  // the user sees the result of their click — applies to every
  // entry point (open-url on macOS, second-instance on Win/Linux,
  // cold-start argv flush). Done before send() so even buffered
  // URLs that fire after did-finish-load focus correctly.
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    try { mainWindow.focus(); } catch {}
    if (mainWindow.webContents && !mainWindow.webContents.isLoading()) {
      try { mainWindow.webContents.send('protocol-url', url); return; }
      catch (err) { console.warn('deliverProtocolUrl: send failed', err); }
    }
  }
  pendingProtocolUrls.push(url);
}

// Custom titlebar (UI v2 design item 1.1). Mac uses `hiddenInset` so
// traffic-lights still render natively in their normal spot while the
// renderer paints its own bar to the right. Windows uses titleBarOverlay
// so the renderer-painted bar's left side shows window control overlays
// in our --bg-0 chrome. Linux keeps the default OS frame this iteration
// — cross-platform custom titlebars on Linux are notoriously fragile
// (window manager variance) and the design ships Mac+Win first.
function customTitlebarOptions() {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 12, y: 11 },
    };
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        // Match the design's `--bg-0` warm-charcoal so the overlay
        // blends with our custom titlebar background.
        color: '#2a2723',
        symbolColor: '#f0ece6',
        height: 36,
      },
    };
  }
  return {};
}

// Our only legitimate top-level document is renderer/index.html (popouts
// add a query string but the same file). Pin every window to it: a
// compromised/poisoned renderer must not be able to navigate the top frame
// to a remote origin, which would inherit the full `window.huddle` preload
// bridge (fetch-proxy with the user's API keys, popout spawning, etc.).
// loadFile from the main process does not fire will-navigate, and in-page
// pushState/hash changes fire did-navigate-in-page — so this only blocks
// genuine renderer-initiated cross-document navigations.
const INDEX_FILE = path.join(__dirname, 'renderer', 'index.html');
function lockNavigationToIndex(contents) {
  const isIndex = (raw) => {
    try {
      const u = new URL(raw);
      // fileURLToPath normalizes to a platform-native absolute path (handles
      // the leading-slash + forward-slash form of file: URLs on Windows,
      // which a raw pathname compare against path.join() would miss).
      return u.protocol === 'file:' && require('url').fileURLToPath(u) === INDEX_FILE;
    } catch { return false; }
  };
  const block = (e, url) => {
    if (isIndex(url)) return;
    e.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
  };
  contents.on('will-navigate', block);
  contents.on('will-redirect', block);
}

// External http(s) links open in the system browser; everything else
// (file://, custom schemes, etc.) is denied rather than spawned in a new
// BrowserWindow with default, unsandboxed webPreferences.
function externalLinkWindowOpenHandler({ url }) {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    shell.openExternal(url);
  }
  return { action: 'deny' };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#1a1d21',
    title: 'Huddle',
    ...customTitlebarOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Permission handler scoped to our renderers (main + any popout
  // child windows). Popouts run the same renderer code and need the
  // same media / display-capture grants for the call-popout flow.
  const isOurRenderer = (wc) => {
    if (!wc) return false;
    if (mainWindow && wc.id === mainWindow.webContents.id) return true;
    for (const w of popouts.values()) {
      if (!w.isDestroyed() && wc.id === w.webContents.id) return true;
    }
    return false;
  };
  // 'fullscreen' covers HTML5 Fullscreen API requests (e.g. the native
  // controls' fullscreen button on inline message videos) — without it
  // Chromium routes the request here and our handler denies it, so the
  // button silently does nothing.
  const ALLOWED = new Set(['media', 'display-capture', 'mediaKeySystem', 'notifications', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(isOurRenderer(wc) && ALLOWED.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => {
    return isOurRenderer(wc) && ALLOWED.has(permission);
  });

  // Default display picker uses the first screen; user picks via our own UI.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    callback({ video: sources[0], audio: 'loopback' });
  }, { useSystemPicker: false });

  // External http(s): links from chat (e.g. uploads, GIFs) open in the system
  // browser instead of replacing our renderer.
  mainWindow.webContents.setWindowOpenHandler(externalLinkWindowOpenHandler);
  lockNavigationToIndex(mainWindow.webContents);

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Flush any huddle:// URLs that arrived before the renderer was
  // ready (cold-start case). did-finish-load fires after both the
  // initial HTML load and renderer-side scripts have run, so the
  // preload's IPC subscriber is in place. Use `on` not `once` so
  // a Cmd-R reload (or any other navigation that re-fires
  // did-finish-load) still drains URLs that arrived during the
  // load gap.
  mainWindow.webContents.on('did-finish-load', () => {
    while (pendingProtocolUrls.length) {
      try { mainWindow.webContents.send('protocol-url', pendingProtocolUrls.shift()); }
      catch { break; }
    }
  });
}

// Spawn (or focus) a child window that runs the same renderer with
// `?popout=<target>&team=<team_id>&channel=<channel_id>` so it can
// boot directly into a focused view (whiteboard or call) without
// the login flow. Each popout has its own renderer process so it
// gets its own Supabase realtime subscriptions; coordination
// between main + popout flows over the `popout-event` relay below.
ipcMain.handle('open-popout', (_event, opts) => {
  const target = String(opts?.target || '');
  if (!target) return { ok: false, error: 'missing target' };
  if (popouts.has(target)) {
    const existing = popouts.get(target);
    if (!existing.isDestroyed()) {
      // Wrap focus() in a try/catch — between this isDestroyed check
      // and the focus call, the window's 'closed' event could fire if
      // the user is double-clicking Pop out during a close.
      try { existing.focus(); return { ok: true, reused: true }; }
      catch {}
    }
    popouts.delete(target);
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: '#1a1d21',
    title: opts?.title || 'Huddle',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Match the main window's external-link + navigation policy.
  win.webContents.setWindowOpenHandler(externalLinkWindowOpenHandler);
  lockNavigationToIndex(win.webContents);
  const params = new URLSearchParams();
  params.set('popout', target);
  if (opts?.teamId) params.set('team', opts.teamId);
  if (opts?.channelId) params.set('channel', opts.channelId);
  if (opts?.whiteboardId) params.set('whiteboard', opts.whiteboardId);
  // Forward the title to the renderer so document.title matches the
  // BrowserWindow title (which the OS reads); without this the
  // popout's tab/page title is a hard-coded fallback.
  if (opts?.title) params.set('title', opts.title);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { search: '?' + params.toString() });
  popouts.set(target, win);
  // Capture the contents id BEFORE 'closed' — by the time the event
  // fires Electron has invalidated win.webContents, and reading .id
  // off a destroyed contents throws "Object has been destroyed",
  // which would prevent fanoutPopoutEvent from broadcasting and
  // leave state.poppedOutCalls in the main renderer permanently
  // stuck on the popped-out channel.
  const senderId = win.webContents.id;
  win.on('closed', () => {
    if (popouts.get(target) === win) popouts.delete(target);
    // Notify any remaining window that a popout closed so they can
    // re-render headers (e.g., show "Pop out" button again).
    fanoutPopoutEvent(senderId, { event: 'popout-closed', target });
  });
  return { ok: true };
});

// Cross-window event relay. Renderers send via `huddle.sendPopoutEvent`,
// and every other window's preload subscribes via `huddle.onPopoutEvent`.
// Used for: main → popout (channel/team metadata refresh, force-close),
// popout → main (popout opened/closed, call-leave-please).
function fanoutPopoutEvent(senderId, msg) {
  const all = [mainWindow, ...popouts.values()].filter((w) => w && !w.isDestroyed());
  for (const w of all) {
    if (w.webContents.id === senderId) continue;
    try { w.webContents.send('popout-event', msg); } catch {}
  }
}
ipcMain.on('popout-event', (event, msg) => {
  fanoutPopoutEvent(event.sender.id, msg || {});
});

ipcMain.handle('close-popout', (_event, opts) => {
  const target = String(opts?.target || '');
  const win = popouts.get(target);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true };
});

ipcMain.handle('get-screen-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    // Modern macOS (14+/Sequoia/Tahoe) returns BLACK thumbnails for window
    // captures via desktopCapturer — display captures and the actual share
    // (ScreenCaptureKit) work fine, but the preview is black. Fetch each
    // window's app icon so the renderer can fall back to it when the
    // thumbnail comes back blank. appIcon is null for screen sources.
    fetchWindowIcons: true,
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
    display_id: s.display_id,
  }));
});

// macOS Screen Recording permission (TCC). desktopCapturer silently returns
// black frames when it's missing — and macOS often drops it after an app
// update — so the renderer checks this before sharing. Non-macOS has no such
// gate, so report 'granted'.
ipcMain.handle('get-screen-access', () => {
  if (process.platform !== 'darwin') return 'granted';
  try { return systemPreferences.getMediaAccessStatus('screen'); }
  catch { return 'unknown'; }
});
// Deep-link to System Settings → Privacy & Security → Screen Recording so the
// user can re-enable Huddle (there is no programmatic grant for screen capture).
ipcMain.handle('open-screen-settings', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
  return true;
});

ipcMain.handle('get-supabase-config', () => ({ url: SUPABASE_URL, anonKey: SUPABASE_KEY }));

// Window-level fullscreen toggle (UI v2 design item 2.3). The
// renderer's call header surfaces an "expand" button that calls this
// — distinct from the per-tile fullscreen which only inflates one
// screen-share tile over the existing window. Returns the new state
// so the renderer can update its button affordance immediately.
// Resize the calling window's content area to the requested width
// + height (typically the aspect ratio of a video the renderer is
// hosting, like a popped-out screen share). Clamps to the current
// display's work-area so we don't open a window larger than the
// screen. No-op if width/height aren't positive finite numbers.
ipcMain.handle('resize-window-to-content', (event, opts) => {
  const wc = event.sender;
  const win = BrowserWindow.fromWebContents(wc) || mainWindow;
  if (!win || win.isDestroyed()) return null;
  const w = Number(opts?.width);
  const h = Number(opts?.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  // Cap to the work-area of the display this window currently sits
  // on (Electron / Chromium tracks the active display per window).
  const display = require('electron').screen.getDisplayMatching(win.getBounds());
  const area = display?.workArea || { width: 1920, height: 1080 };
  const margin = 24;
  const maxW = Math.max(640, area.width - margin * 2);
  const maxH = Math.max(360, area.height - margin * 2);
  // Preserve aspect ratio while clamping. Scale down uniformly if
  // either dimension would exceed the work-area cap.
  const scale = Math.min(1, maxW / w, maxH / h);
  const targetW = Math.round(w * scale);
  const targetH = Math.round(h * scale);
  try { win.setContentSize(targetW, targetH); } catch (err) {
    console.warn('resize-window-to-content failed', err);
    return null;
  }
  return { width: targetW, height: targetH };
});

ipcMain.handle('toggle-window-fullscreen', (event) => {
  const wc = event.sender;
  // Find which BrowserWindow owns this webContents — either the main
  // window or a popout. Falls back to mainWindow for safety, though
  // every renderer is associated with some window.
  const target = BrowserWindow.fromWebContents(wc) || mainWindow;
  if (!target || target.isDestroyed()) return false;
  const next = !target.isFullScreen();
  target.setFullScreen(next);
  return next;
});

// Resolve the per-platform whisper-cli binary that ships under
// `resources/whisper/<platform>-<arch>/`. In a packaged build the dir
// lives at `process.resourcesPath/whisper`; in dev (electron .) it's
// the source-tree resources/ scoped to the host's platform+arch.
// Returns `null` when no binary was bundled for this platform (Linux
// today, future hosts) so callers can disable captions instead of
// crashing.
function getWhisperDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'whisper');
  return path.join(__dirname, 'resources', 'whisper', `${process.platform}-${process.arch}`);
}
function getWhisperBinaryPath() {
  const dir = getWhisperDir();
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const full = path.join(dir, exe);
  try {
    require('fs').accessSync(full, require('fs').constants.X_OK);
    return full;
  } catch { return null; }
}
ipcMain.handle('whisper-binary-status', () => {
  const binPath = getWhisperBinaryPath();
  return { available: !!binPath, path: binPath };
});

// Whisper model catalog + lifecycle. Captions runtime picks one model
// from this catalog (default: base) and downloads it lazily on first
// CC click. Settings → Captions exposes a picker so users on bigger
// machines can opt into small / medium for better accuracy. Each
// model lives at `whisper-models/<filename>` in user-data; the active
// choice is persisted in `whisper-models/current.txt`.
//
// Sizes verified against huggingface.co/ggerganov/whisper.cpp on
// 2026-06-01; treated as 90%-floor sanity bounds, not strict equality.
// Adding a new model: append here + verify size; downloads handle the
// rest. We deliberately don't ship large-v3 (~3 GB) — disk + memory
// asks are too steep for a desktop chat client.
const WHISPER_MODELS = {
  tiny: {
    label: 'Tiny — fastest, lowest accuracy',
    filename: 'ggml-tiny.en.bin',
    size: 77704715,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
  },
  base: {
    label: 'Base — recommended for laptops',
    filename: 'ggml-base.en.bin',
    size: 147964211,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  },
  small: {
    label: 'Small — better accuracy, more memory',
    filename: 'ggml-small.en.bin',
    size: 487614201,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
  },
  medium: {
    label: 'Medium — best accuracy, slowest',
    filename: 'ggml-medium.en.bin',
    size: 1533774781,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin',
  },
};
const WHISPER_DEFAULT_MODEL_ID = 'base';
let whisperDownloadController = null; // AbortController of the in-flight download, or null
let whisperDownloadingId = null;       // id of the model currently being downloaded

function getWhisperModelDir() {
  return path.join(app.getPath('userData'), 'whisper-models');
}
function whisperCurrentFile() {
  return path.join(getWhisperModelDir(), 'current.txt');
}
function getCurrentWhisperModelId() {
  try {
    const id = require('fs').readFileSync(whisperCurrentFile(), 'utf8').trim();
    if (WHISPER_MODELS[id]) return id;
  } catch {}
  return WHISPER_DEFAULT_MODEL_ID;
}
function setCurrentWhisperModelId(id) {
  if (!WHISPER_MODELS[id]) return false;
  const fs = require('fs');
  try {
    fs.mkdirSync(getWhisperModelDir(), { recursive: true });
    fs.writeFileSync(whisperCurrentFile(), id, 'utf8');
    return true;
  } catch (err) {
    console.warn('[whisper] setCurrentWhisperModelId failed', err);
    return false;
  }
}
function getWhisperModelPath(modelId) {
  const id = WHISPER_MODELS[modelId] ? modelId : getCurrentWhisperModelId();
  return path.join(getWhisperModelDir(), WHISPER_MODELS[id].filename);
}
function whisperModelStatusSync(modelId) {
  const id = WHISPER_MODELS[modelId] ? modelId : getCurrentWhisperModelId();
  const spec = WHISPER_MODELS[id];
  const p = path.join(getWhisperModelDir(), spec.filename);
  try {
    const st = require('fs').statSync(p);
    // Same 90%-floor as before: a half-written file (network drop,
    // app quit mid-download) reports as missing so the UI re-downloads
    // instead of feeding the engine a truncated model.
    if (st.size < spec.size * 0.9) {
      return { status: 'not-downloaded', bytes: st.size, total: spec.size };
    }
    return { status: 'ready', bytes: st.size, total: st.size };
  } catch { return { status: 'not-downloaded', bytes: 0, total: spec.size }; }
}

ipcMain.handle('whisper-model-list', () => {
  const currentId = getCurrentWhisperModelId();
  return Object.entries(WHISPER_MODELS).map(([id, spec]) => {
    const status = whisperDownloadingId === id
      ? { status: 'downloading', bytes: 0, total: spec.size }
      : whisperModelStatusSync(id);
    return {
      id,
      label: spec.label,
      size: spec.size,
      isCurrent: id === currentId,
      ...status,
    };
  });
});

ipcMain.handle('whisper-model-set', (_event, modelId) => {
  if (!WHISPER_MODELS[modelId]) return { ok: false, error: `unknown model: ${modelId}` };
  return { ok: setCurrentWhisperModelId(modelId), currentId: modelId };
});

ipcMain.handle('whisper-model-status', (_event, modelId) => {
  if (whisperDownloadingId && (!modelId || modelId === whisperDownloadingId)) {
    const spec = WHISPER_MODELS[whisperDownloadingId];
    return { status: 'downloading', bytes: 0, total: spec.size };
  }
  return whisperModelStatusSync(modelId);
});

ipcMain.handle('whisper-model-cancel', () => {
  if (whisperDownloadController) {
    try { whisperDownloadController.abort(); } catch {}
    return true;
  }
  return false;
});

ipcMain.handle('whisper-model-delete', (_event, modelId) => {
  const id = WHISPER_MODELS[modelId] ? modelId : getCurrentWhisperModelId();
  if (whisperDownloadingId === id) return { ok: false, error: 'download in progress' };
  try {
    require('fs').unlinkSync(path.join(getWhisperModelDir(), WHISPER_MODELS[id].filename));
    return { ok: true };
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true };
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('whisper-model-download', async (event, modelId) => {
  if (whisperDownloadController) return { ok: false, error: 'already downloading' };
  const id = WHISPER_MODELS[modelId] ? modelId : getCurrentWhisperModelId();
  const spec = WHISPER_MODELS[id];
  const wc = event.sender;
  const fs = require('fs');
  const dir = getWhisperModelDir();
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (err) { return { ok: false, error: `mkdir: ${err.message}` }; }
  const finalPath = path.join(dir, spec.filename);
  const tmpPath = `${finalPath}.partial`;
  try { fs.unlinkSync(tmpPath); } catch {}
  whisperDownloadController = new AbortController();
  whisperDownloadingId = id;
  try {
    const res = await fetch(spec.url, {
      signal: whisperDownloadController.signal,
      redirect: 'follow',
    });
    if (!res.ok) {
      return { ok: false, error: `http ${res.status}` };
    }
    const total = Number(res.headers.get('content-length')) || spec.size;
    const writeStream = fs.createWriteStream(tmpPath);
    // Without an 'error' listener a mid-download write failure (disk full on a
    // model up to ~1.5 GB) emits an unhandled 'error' that crashes the whole
    // main process. Capture it and route it through the normal catch below.
    let streamError = null;
    writeStream.on('error', (e) => { streamError = e; });
    let received = 0;
    let lastEmit = 0;
    const reader = res.body.getReader();
    try {
      while (true) {
        if (streamError) throw streamError;
        const { done, value } = await reader.read();
        if (done) break;
        writeStream.write(Buffer.from(value));
        received += value.length;
        const now = Date.now();
        if (now - lastEmit > 100) {
          lastEmit = now;
          try { wc.send('whisper-model-progress', { modelId: id, received, total, percent: received / total }); } catch {}
        }
      }
      await new Promise((resolve, reject) => {
        writeStream.end((err) => err ? reject(err) : resolve());
      });
    } catch (err) {
      // A reader abort (cancel) or write error leaves the HTTP body reader and
      // the write stream open. Cancel the reader so the socket is reclaimed
      // promptly, then wait for the write stream to fully close before
      // rethrowing — the outer catch unlinks tmpPath synchronously, which on
      // Windows fails while the fd is still held (destroy() closes on a later
      // tick, so we can't just fire-and-forget it).
      try { await reader.cancel(); } catch {}
      await new Promise((resolve) => {
        if (writeStream.destroyed) return resolve();
        writeStream.once('close', resolve);
        writeStream.destroy();
      });
      throw err;
    }
    const finalSize = fs.statSync(tmpPath).size;
    if (finalSize < spec.size * 0.9) {
      try { fs.unlinkSync(tmpPath); } catch {}
      return { ok: false, error: `truncated download (${finalSize} of ${total} bytes)` };
    }
    fs.renameSync(tmpPath, finalPath);
    try { wc.send('whisper-model-progress', { modelId: id, received: finalSize, total: finalSize, percent: 1 }); } catch {}
    return { ok: true, modelId: id, path: finalPath, bytes: finalSize };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    if (err.name === 'AbortError') return { ok: false, error: 'cancelled' };
    return { ok: false, error: err.message || 'download failed' };
  } finally {
    whisperDownloadController = null;
    whisperDownloadingId = null;
  }
});

// Whisper chunk-inference engine. Renderer ships per-chunk WAV
// buffers via `whisper-transcribe-chunk`; we write each to a tmp file,
// spawn the platform whisper-cli with the user-data model, parse
// stdout (with -np -nt the only stdout content is the transcribed
// text), and stream `caption-line` IPC events back to the sender.
//
// Concurrency is capped to 2 simultaneous engines so a slow chunk
// can't starve the renderer of progress. The pending queue drops
// oldest beyond MAX_QUEUE so a stall doesn't grow unbounded RAM.
// Captions are best-effort — dropping a chunk just leaves a gap in
// the transcript, never crashes the call.
const WHISPER_MAX_ACTIVE = 2;
const WHISPER_MAX_QUEUE  = 8;
const whisperQueue = [];
let whisperActive = 0;
ipcMain.handle('whisper-transcribe-chunk', async (event, payload) => {
  if (!payload || !payload.wavBuffer) return { ok: false, error: 'missing wavBuffer' };
  const job = {
    chunkId:       String(payload.chunkId || ''),
    participantId: payload.participantId || null,
    fromName:      payload.fromName || null,
    isLocal:       !!payload.isLocal,
    wavBuffer:     payload.wavBuffer,
    senderId:      event.sender.id,
    startedAt:     Date.now(),
  };
  if (whisperQueue.length >= WHISPER_MAX_QUEUE) {
    whisperQueue.shift(); // drop oldest — best-effort captions
  }
  whisperQueue.push(job);
  pumpWhisperQueue();
  return { ok: true };
});

function pumpWhisperQueue() {
  while (whisperActive < WHISPER_MAX_ACTIVE && whisperQueue.length > 0) {
    const job = whisperQueue.shift();
    whisperActive++;
    runWhisperJob(job).finally(() => { whisperActive--; pumpWhisperQueue(); });
  }
}

async function runWhisperJob(job) {
  const binPath = getWhisperBinaryPath();
  const modelPath = getWhisperModelPath();
  const fs = require('fs');
  if (!binPath || !fs.existsSync(modelPath)) {
    // No engine / no model — silently skip; the renderer's CC gate
    // should have prevented this from ever firing.
    return;
  }
  const os = require('os');
  const tmpFile = path.join(os.tmpdir(), `huddle-chunk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  try {
    fs.writeFileSync(tmpFile, Buffer.from(job.wavBuffer));
  } catch (err) {
    console.warn('[whisper] tmp write failed', err);
    return;
  }
  const { spawn } = require('child_process');
  // -np  suppresses log lines on stdout (still go to stderr)
  // -nt  suppresses timestamps
  // -l en + tiny.en model are paired; the model file name encodes lang
  // -t   thread count; 4 keeps headroom for the rest of the call
  const cp = spawn(binPath, [
    '-m', modelPath,
    '-f', tmpFile,
    '-l', 'en',
    '-np',
    '-nt',
    '-t', '4',
  ]);
  let stdout = '';
  cp.stdout.on('data', (d) => { stdout += d.toString(); });
  cp.stderr.on('data', () => { /* ignore — see -np */ });
  await new Promise((resolve) => {
    cp.on('close', () => resolve());
    cp.on('error', (err) => {
      console.warn('[whisper] engine error', err);
      resolve();
    });
  });
  try { fs.unlinkSync(tmpFile); } catch {}
  const text = stdout.trim();
  if (!text) return;
  const wc = require('electron').webContents.fromId(job.senderId);
  if (wc && !wc.isDestroyed()) {
    wc.send('caption-line', {
      chunkId:       job.chunkId,
      participantId: job.participantId,
      fromName:      job.fromName,
      isLocal:       job.isLocal,
      text,
      startedAt:     job.startedAt,
      finishedAt:    Date.now(),
    });
  }
}

// ---------------------------------------------------------------------------
// Embedded terminal (in-app pty). The renderer is sandboxed
// (contextIsolation + no nodeIntegration), so the real shell must live
// here in main and stream over IPC — same shape as the whisper caption
// engine above. Each pty is spawned by an explicit user click, runs as
// the user's own uid with their own login-shell PATH, and never touches
// the network from main. See the terminal panel in renderer/terminal-panel.js.
//
// node-pty is the app's first native addon, rebuilt against Electron's
// ABI by the postinstall `electron-rebuild` step. We lazy-require it
// inside the spawn handler so a failed rebuild degrades gracefully
// (terminal unavailable) instead of crashing app boot — mirroring how
// whisper tolerates a missing binary.
// Cap concurrent shells PER WINDOW (each webContents), not globally — the
// renderer's tab cap (MAX_TABS) is per-window too, so a global cap would let
// one window's tabs starve another's. Matches MAX_TABS in terminal-panel.js.
const TERMINAL_MAX_PTYS_PER_WINDOW = 8;
const ptys = new Map();      // id -> { pty, wc, onDestroyed }
let ptySeq = 0;

function ptyCountForSender(senderId) {
  let n = 0;
  for (const rec of ptys.values()) if (rec.wc && rec.wc.id === senderId) n++;
  return n;
}

ipcMain.handle('terminal-spawn', async (event, payload = {}) => {
  if (ptyCountForSender(event.sender.id) >= TERMINAL_MAX_PTYS_PER_WINDOW) {
    return { ok: false, error: 'too many open terminals' };
  }
  let pty;
  try {
    pty = require('node-pty');
  } catch (err) {
    console.warn('[terminal] node-pty unavailable (rebuild may have failed):', err && err.message);
    return { ok: false, error: 'terminal engine unavailable' };
  }
  const os = require('os');
  const isWin = process.platform === 'win32';
  // Spawn a login + interactive shell so it sources the user's profile
  // (~/.zprofile, ~/.zshrc, nvm, Homebrew shellenv, …). This is the fix
  // for the macOS GUI-PATH gotcha: a launchd-started app inherits a
  // truncated PATH, so npm-global / Homebrew binaries like `claude`
  // wouldn't be found without a login shell resolving the real PATH.
  // Fall back to bash (present on macOS + virtually all Linux) rather than
  // zsh (a macOS-only assumption) when $SHELL is unset.
  const shell = isWin
    ? (process.env.ComSpec || 'powershell.exe')
    : (process.env.SHELL || '/bin/bash');
  // `-l -i` (login+interactive, needed to source the profile for PATH) is
  // valid for bash/zsh/fish but rejected by dash/sh, which would exit the
  // pty immediately. Pass it only to the shells that accept it; others
  // still get an interactive shell.
  const base = shell.replace(/.*[\\/]/, '');
  const args = isWin ? [] : (/^(bash|zsh|fish)$/.test(base) ? ['-l', '-i'] : ['-i']);
  const cols = Number(payload.cols) > 0 ? Math.floor(payload.cols) : 80;
  const rows = Number(payload.rows) > 0 ? Math.floor(payload.rows) : 24;
  let child;
  try {
    child = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: payload.cwd || os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (err) {
    console.warn('[terminal] spawn failed:', err && err.message);
    return { ok: false, error: String(err && err.message || err) };
  }

  // If the renderer went away during the (async) spawn, don't leak the
  // shell we just started.
  const wc = event.sender;
  if (wc.isDestroyed()) {
    try { child.kill(); } catch {}
    return { ok: false, error: 'sender destroyed' };
  }

  const id = `pty-${++ptySeq}`;
  // Kill this pty if its owning renderer goes away (window closed /
  // reloaded) so we never leak an orphaned shell. Removed on exit (normal
  // or via terminal-kill) so these listeners don't pile up on the
  // long-lived webContents. wc + onDestroyed are stored on the record so
  // terminal-kill can detach the listener even if onExit never fires.
  const onDestroyed = () => { try { child.kill(); } catch {} ptys.delete(id); };
  ptys.set(id, { pty: child, wc, onDestroyed });
  wc.once('destroyed', onDestroyed);

  // Cache the webContents in the closure — terminal output is high
  // frequency, so a webContents.fromId() lookup per chunk would add real
  // overhead. isDestroyed() guards the case where the window closes
  // between chunks.
  child.onData((data) => {
    if (!wc.isDestroyed()) wc.send('terminal-data', { id, data });
  });
  child.onExit(({ exitCode }) => {
    ptys.delete(id);
    try { wc.off('destroyed', onDestroyed); } catch {}
    if (!wc.isDestroyed()) wc.send('terminal-exit', { id, exitCode });
  });

  return { ok: true, id };
});

ipcMain.handle('terminal-write', (_event, { id, data } = {}) => {
  const rec = ptys.get(id);
  if (rec) { try { rec.pty.write(data); } catch {} }
  return { ok: !!rec };
});

ipcMain.handle('terminal-resize', (_event, { id, cols, rows } = {}) => {
  const rec = ptys.get(id);
  if (rec && cols > 0 && rows > 0) {
    try { rec.pty.resize(Math.floor(cols), Math.floor(rows)); } catch {}
  }
  return { ok: !!rec };
});

ipcMain.handle('terminal-kill', (_event, { id } = {}) => {
  const rec = ptys.get(id);
  if (rec) {
    try { rec.wc.off('destroyed', rec.onDestroyed); } catch {}
    try { rec.pty.kill(); } catch {}
    ptys.delete(id);
  }
  return { ok: !!rec };
});

// Claude Code as an AI provider ("use my already-auth'd MCPs").
//
// Runs the user's locally installed `claude` CLI in headless print mode
// (`-p --output-format json`) so /ai answers come from Claude Code —
// which loads the user's OWN MCP servers (user-scope ~/.claude.json;
// OAuth tokens from the local credential store carry over, and claude.ai
// connectors surface too when the CLI is signed in with the same Pro/Max
// account). Huddle never sees or stores any of those credentials; the
// tool calls execute entirely inside the Claude Code process.
//
// Trust model: this executes a binary already on the user's machine, as
// the user, with the prompt they typed into /ai — the same power the
// in-app terminal (above) already grants, minus the interactive shell.
// The prompt travels via stdin (never a shell string), the binary is
// resolved once via the user's login shell (same GUI-PATH fix as
// terminal-spawn) or an explicit Settings override, and allowedTools is
// charset-validated before being passed as a discrete argv entry.
const CLAUDE_CODE_TIMEOUT_MS = 180 * 1000;
const CLAUDE_CODE_MAX_OUTPUT = 2 * 1024 * 1024;
// Tool patterns per docs: Bash(git *), mcp__server__*, Read, WebSearch…
const CLAUDE_ALLOWED_TOOLS_RE = /^[\w\s,*()\-:_./]+$/;
let cachedClaudeBin = null;
let claudeBinPromise = null; // in-flight/settled resolution (dedupes concurrent callers)
let claudeBinRetryAt = 0;    // when a not-found result may be re-probed

function resolveClaudeBinary() {
  // Memoize negatives too (with a retry window so a mid-session install is
  // picked up): the probe spawns a login shell, and detect fires on every
  // settings load — without this, no-claude machines pay a shell spawn
  // (sourcing ~/.zprofile / nvm, often seconds) each time, forever.
  if (claudeBinPromise && (cachedClaudeBin || Date.now() < claudeBinRetryAt)) {
    return claudeBinPromise;
  }
  claudeBinRetryAt = Date.now() + 60_000; // covers the in-flight window as well
  claudeBinPromise = new Promise((resolve) => {
    const { execFile } = require('child_process');
    const isWin = process.platform === 'win32';
    const settle = (p) => {
      cachedClaudeBin = p || null;
      if (!cachedClaudeBin) claudeBinRetryAt = Date.now() + 60_000;
      resolve(cachedClaudeBin);
    };
    if (isWin) {
      execFile('where', ['claude'], { timeout: 10_000 }, (err, stdout) => {
        const lines = err ? [] : String(stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        // `where` lists the extensionless sh-shim first for npm installs —
        // prefer a spawnable .exe/.cmd/.bat entry.
        settle(lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) || lines[0] || null);
      });
      return;
    }
    // Login shell so ~/.zprofile / nvm / Homebrew shellenv resolve the
    // real PATH — a launchd/GUI-started Electron inherits a truncated
    // one (same gotcha terminal-spawn documents).
    const shell = process.env.SHELL || '/bin/bash';
    execFile(shell, ['-l', '-c', 'command -v claude'], { timeout: 10_000 }, (err, stdout) => {
      settle(!err && String(stdout || '').trim());
    });
  });
  return claudeBinPromise;
}

// The one binary-selection policy both handlers share: an explicit
// Settings override wins, else login-shell PATH resolution; either way
// the file must exist on disk AND look like the claude CLI. Returns null
// when nothing usable does.
//
// The basename check is hygiene, not a security boundary — the override
// arrives from the renderer (settings live behind its Supabase session,
// so main can't read them independently), and a fully compromised
// renderer already has the terminal-spawn IPC's interactive shell. What
// it buys: this privileged exec path can't be casually repointed at an
// arbitrary binary, and a mistyped Settings path fails loud instead of
// running something unexpected.
const CLAUDE_BIN_NAME_RE = /^claude(?:\.(?:cmd|exe|bat))?$/i;
async function resolveExistingClaudeBin(overridePath) {
  const fs = require('fs');
  const bin = (typeof overridePath === 'string' && overridePath.trim())
    ? overridePath.trim()
    : await resolveClaudeBinary();
  if (!bin || !fs.existsSync(bin)) return null;
  return CLAUDE_BIN_NAME_RE.test(path.basename(bin)) ? bin : null;
}

// Account profiles: each profile is an isolated CLAUDE_CONFIG_DIR — its own
// login (personal Max vs work Team), its own MCP servers, its own transcript
// history. Normalize a user-supplied dir: expand leading ~, require an
// absolute path, else fall back to the default (empty → CLI default ~/.claude).
function normalizeClaudeConfigDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return '';
  const os = require('os');
  let d = dir.trim();
  if (d === '~') d = os.homedir();
  else if (d.startsWith('~/') || d.startsWith('~\\')) d = path.join(os.homedir(), d.slice(2));
  return path.isAbsolute(d) ? d : '';
}

// Cheap presence probe for the Settings auto-default: is a claude binary
// reachable (PATH via login shell, or the explicit override)? No spawn of
// the CLI itself — just resolution + existence.
ipcMain.handle('claude-code-detect', async (_event, payload = {}) => {
  const bin = await resolveExistingClaudeBin(payload.binPath);
  return { found: !!bin, path: bin };
});

// Local Claude usage scan for the Usage dashboard. Claude Code writes a
// JSONL transcript per session under <config-dir>/projects/**; every
// assistant turn carries message.usage (tokens) + message.model + a
// timestamp. Aggregating those locally gives a usage dashboard with no
// API calls and no credentials — the same data source ccusage uses.
// Only AGGREGATES cross the IPC boundary (per-day / per-model token sums
// and cost estimates), never transcript content.
//
// Cost is an API-LIST-PRICE EQUIVALENT (what the tokens would have cost
// via API-key billing): $/MTok in/out per model family, cache reads at
// 0.1x input, cache writes at 1.25x (5m TTL) / 2x (1h TTL). Subscription
// usage has no per-request charge — the estimate sizes the value of the
// plan, and is labeled as an estimate in the UI.
const CLAUDE_PRICING = [
  { re: /fable|mythos/i, inp: 10, out: 50 },
  { re: /opus-4-[5-9]/i, inp: 5, out: 25 },
  { re: /opus/i, inp: 15, out: 75 },        // opus 4.1 and older
  { re: /sonnet/i, inp: 3, out: 15 },
  { re: /haiku-4/i, inp: 1, out: 5 },
  // Real 3.5 Haiku ids put the digits FIRST ('claude-3-5-haiku-20241022');
  // match both orders so they don't fall through to the Haiku-3 tier.
  { re: /haiku-3-5|3-5-haiku/i, inp: 0.8, out: 4 },
  { re: /haiku/i, inp: 0.25, out: 1.25 },
];
const DEFAULT_PRICING = { inp: 5, out: 25 };
const USAGE_MAX_FILES_PER_PROFILE = 2000;

function pricingFor(model) {
  return CLAUDE_PRICING.find((p) => p.re.test(model || ''))
    || DEFAULT_PRICING;
}

function estimateCostUsd(model, t) {
  const p = pricingFor(model);
  return (t.input * p.inp
    + t.output * p.out
    + t.cacheRead * p.inp * 0.1
    + t.cacheWrite5m * p.inp * 1.25
    + t.cacheWrite1h * p.inp * 2) / 1e6;
}

// Async walk: months of Claude Code history can be thousands of files
// across hundreds of dirs, and this runs on the MAIN process — a sync
// walk would block every window's IPC for the duration. The mtime probe
// skips files untouched since the cutoff so they're never streamed.
async function listJsonlFiles(dir, cutoffMs, out) {
  const fsp = require('fs').promises;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= USAGE_MAX_FILES_PER_PROFILE) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await listJsonlFiles(p, cutoffMs, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        if ((await fsp.stat(p)).mtimeMs >= cutoffMs) out.push(p);
      } catch { /* raced deletion */ }
    }
  }
}

// Best-effort read of the signed-in plan tier for a config dir, so the
// usage panel can label whose limits these are ("Claude Max", "Pro").
// The tier string lives in <base>/.claude.json (or legacy ~/.claude.json)
// under oauthAccount.organizationRateLimitTier. That file also stores
// per-project history and can be multi-MB, so we regex for the one field
// rather than JSON.parse the whole thing, and skip anything absurdly large.
function readClaudePlanTier(base) {
  const fs = require('fs');
  const os = require('os');
  const candidates = [path.join(base, '.claude.json'), path.join(os.homedir(), '.claude.json')];
  for (const file of candidates) {
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size > 25 * 1024 * 1024) continue;
      const txt = fs.readFileSync(file, 'utf8');
      const m = txt.match(/"organizationRateLimitTier"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    } catch { /* missing / unreadable → next candidate */ }
  }
  return null;
}

// Stream one transcript, folding usage-bearing assistant lines into `entries`
// keyed by message.id:requestId. Streaming lines repeat the same message with
// growing usage — LAST occurrence wins (most complete), exactly one count per
// API request.
function scanTranscript(file, cutoffMs, entries) {
  const fs = require('fs');
  const readline = require('readline');
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(file),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!line.includes('"usage"')) return; // cheap pre-filter
      let d;
      try { d = JSON.parse(line); } catch { return; }
      if (d?.type !== 'assistant') return;
      const m = d.message;
      const u = m?.usage;
      if (!u || !m.model) return;
      const ts = Date.parse(d.timestamp || 0);
      if (!Number.isFinite(ts) || ts < cutoffMs) return;
      const key = `${m.id || d.uuid || 'x'}:${d.requestId || 'x'}`;
      const cc = u.cache_creation || {};
      const cacheWriteTotal = u.cache_creation_input_tokens || 0;
      const w1h = cc.ephemeral_1h_input_tokens || 0;
      entries.set(key, {
        ts,
        model: m.model,
        input: u.input_tokens || 0,
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
        // When the TTL breakdown is absent, treat the whole write as 5m
        // (the cheaper multiplier — under- rather than over-estimates).
        cacheWrite5m: Math.max(0, cacheWriteTotal - w1h),
        cacheWrite1h: w1h,
      });
    });
    rl.on('close', resolve);
    rl.on('error', resolve);
  });
}

ipcMain.handle('claude-usage-scan', async (_event, payload = {}) => {
  const os = require('os');
  const fs = require('fs');
  const days = Math.min(90, Math.max(1, Math.floor(payload.days) || 30));
  const cutoffMs = Date.now() - days * 24 * 3600 * 1000;
  // Always scan the default dir; extra profiles come from Settings.
  const wanted = [{ name: 'Default', configDir: '' }];
  for (const p of Array.isArray(payload.profiles) ? payload.profiles : []) {
    const dir = normalizeClaudeConfigDir(p?.configDir);
    if (dir && typeof p.name === 'string' && p.name.trim()) {
      wanted.push({ name: p.name.trim(), configDir: dir });
    }
  }

  // Dedup by resolved config dir — the built-in Default IS ~/.claude, so a
  // Settings profile pointing there would scan (and sum) the same
  // transcripts twice, doubling every number on the dashboard.
  const seenBases = new Set();
  const deduped = [];
  for (const prof of wanted) {
    const base = prof.configDir || path.join(os.homedir(), '.claude');
    if (seenBases.has(base)) continue;
    seenBases.add(base);
    deduped.push({ ...prof, base });
  }

  // Profiles are independent trees — scan them concurrently (each keeps
  // its own bounded pool) so wall-clock is the slowest profile, not the sum.
  const profiles = await Promise.all(deduped.map(async (prof) => {
    const base = prof.base;
    const projectsDir = path.join(base, 'projects');
    if (!fs.existsSync(projectsDir)) {
      return { name: prof.name, found: false, totals: null, byDay: {}, byModel: {}, files: 0, truncated: false, planTier: null, window5h: null, window7d: null };
    }
    const files = [];
    await listJsonlFiles(projectsDir, cutoffMs, files);
    // Bounded worker pool: one-at-a-time leaves the disk idle between
    // files; unbounded Promise.all risks EMFILE on thousands of files.
    // Per-key last-write-wins into the shared Map is order-independent
    // for the token sums (every occurrence of a key is the same request).
    const entries = new Map();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
      while (next < files.length) {
        const f = files[next++];
        await scanTranscript(f, cutoffMs, entries);
      }
    }));

    const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, messages: 0 });
    const totals = zero();
    const byDay = {};
    const byModel = {};
    // Rolling-window sums for the "current usage" view. These are a LOCAL
    // approximation of how much this account has spent in the trailing 5h
    // (Claude's session window) and 7d (weekly window) — NOT the account's
    // official remaining allowance, which isn't on disk (see the usage
    // panel's disclaimer). Computed from the same entries we already fold.
    const nowMs = Date.now();
    const cut5h = nowMs - 5 * 3600 * 1000;
    const cut7d = nowMs - 7 * 24 * 3600 * 1000;
    const window5h = zero();
    const window7d = zero();
    for (const e of entries.values()) {
      const day = new Date(e.ts).toISOString().slice(0, 10);
      const cost = estimateCostUsd(e.model, e);
      const cacheWrite = e.cacheWrite5m + e.cacheWrite1h;
      const buckets = [
        byDay[day] || (byDay[day] = zero()),
        byModel[e.model] || (byModel[e.model] = zero()),
        totals,
      ];
      if (e.ts >= cut5h) buckets.push(window5h);
      if (e.ts >= cut7d) buckets.push(window7d);
      for (const b of buckets) {
        b.input += e.input; b.output += e.output;
        b.cacheRead += e.cacheRead; b.cacheWrite += cacheWrite;
        b.costUsd += cost; b.messages += 1;
      }
    }
    return {
      name: prof.name,
      found: true,
      planTier: readClaudePlanTier(base),
      window5h,
      window7d,
      totals,
      byDay,
      byModel,
      files: files.length,
      truncated: files.length >= USAGE_MAX_FILES_PER_PROFILE,
    };
  }));
  return { days, profiles };
});

ipcMain.handle('claude-code-run', async (_event, payload = {}) => {
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt.trim()) return { ok: false, error: 'empty prompt' };

  const bin = await resolveExistingClaudeBin(payload.binPath);
  if (!bin) {
    return {
      ok: false,
      error: 'Claude Code not found. Install it (npm install -g @anthropic-ai/claude-code), sign in once with `claude`, or set an explicit binary path in Settings.',
    };
  }

  const args = ['-p', '--output-format', 'json'];
  const allowedTools = typeof payload.allowedTools === 'string' ? payload.allowedTools.trim() : '';
  if (allowedTools) {
    if (!CLAUDE_ALLOWED_TOOLS_RE.test(allowedTools)) {
      return { ok: false, error: 'allowed-tools contains unsupported characters' };
    }
    args.push('--allowedTools', allowedTools);
  }

  const { spawn } = require('child_process');
  const os = require('os');
  // The CLI silently prefers ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN over
  // the subscription login when either is in the environment — which also
  // drops claude.ai connectors. preferSubscription (Settings checkbox)
  // strips them from the child env so the /login credentials win.
  const childEnv = { ...process.env };
  const apiKeyEnv = !!(childEnv.ANTHROPIC_API_KEY || childEnv.ANTHROPIC_AUTH_TOKEN);
  if (payload.preferSubscription) {
    delete childEnv.ANTHROPIC_API_KEY;
    delete childEnv.ANTHROPIC_AUTH_TOKEN;
  }
  // Account profile: an isolated config dir carries its own /login
  // credentials and MCP servers (personal Max vs work Team).
  const configDir = normalizeClaudeConfigDir(payload.configDir);
  if (configDir) childEnv.CLAUDE_CONFIG_DIR = configDir;
  return await new Promise((resolve) => {
    let cp;
    try {
      // cwd = home, NOT the app bundle: session scoping and project
      // .mcp.json discovery are cwd-relative, and home is the stable,
      // user-expected context for a chat assistant.
      //
      // Windows npm installs resolve to a .cmd shim, which Node refuses to
      // spawn directly (EINVAL since the CVE-2024-27980 hardening) — route
      // those through the shell, quoting the path and any arg with spaces
      // or cmd metachars (the allowedTools charset excludes '"', so
      // embedding in quotes is safe).
      const winCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
      cp = winCmd
        ? spawn(`"${bin}"`, args.map((a) => (/[\s()]/.test(a) ? `"${a}"` : a)),
            { cwd: os.homedir(), env: childEnv, shell: true, windowsHide: true })
        : spawn(bin, args, { cwd: os.homedir(), env: childEnv });
    } catch (err) {
      resolve({ ok: false, error: `failed to start Claude Code: ${err?.message || err}` });
      return;
    }
    // Decode as UTF-8 streams, not per-chunk Buffer coercion — `out += d`
    // on Buffers corrupts a multibyte character split across chunk
    // boundaries into U+FFFD (and can break JSON.parse of the envelope).
    cp.stdout.setEncoding('utf8');
    cp.stderr.setEncoding('utf8');
    let out = '';
    let errOut = '';
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    const timer = setTimeout(() => {
      try { cp.kill('SIGKILL'); } catch {}
      finish({ ok: false, error: `Claude Code timed out after ${CLAUDE_CODE_TIMEOUT_MS / 1000}s` });
    }, CLAUDE_CODE_TIMEOUT_MS);
    cp.stdout.on('data', (d) => {
      out += d;
      if (out.length > CLAUDE_CODE_MAX_OUTPUT) {
        clearTimeout(timer);
        try { cp.kill('SIGKILL'); } catch {}
        finish({ ok: false, error: 'Claude Code output exceeded size cap' });
      }
    });
    cp.stderr.on('data', (d) => { errOut = (errOut + d).slice(-4000); });
    cp.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: `Claude Code spawn error: ${err?.message || err}` });
    });
    cp.on('close', (code) => {
      clearTimeout(timer);
      if (done) return;
      let json = null;
      try { json = JSON.parse(out); } catch { /* fall through */ }
      const text = json?.result ?? '';
      if ((code !== 0 && !text) || json?.is_error) {
        finish({ ok: false, error: (text || errOut || `exit code ${code}`).slice(0, 2000) });
        return;
      }
      finish({
        ok: true,
        text: String(text),
        costUsd: typeof json?.total_cost_usd === 'number' ? json.total_cost_usd : null,
        // Diagnostics for the Settings "Test" button: which binary ran,
        // and whether API-key env vars were present (billing signal).
        binPath: bin,
        apiKeyEnv,
        apiKeyEnvStripped: !!payload.preferSubscription && apiKeyEnv,
      });
    });
    // Prompt via stdin: no argv length limits, no quoting hazards.
    try { cp.stdin.write(prompt); cp.stdin.end(); } catch {}
  });
});

// Generic fetch proxy. Some third-party APIs (notably Atlassian Cloud)
// don't permit browser-origin requests via CORS; routing through main lets
// the renderer hit them with stored credentials. We only proxy https URLs
// to vetted hosts (currently Atlassian) and explicitly reject private /
// loopback addresses to defend against SSRF if the allow-list ever grows.
const ALLOWED_PROXY_HOSTS = [
  /^[a-z0-9-]+\.atlassian\.net$/i, // Jira Cloud
  /^api\.anthropic\.com$/i,        // Claude API
  /^openrouter\.ai$/i,             // OpenRouter
  /^api\.github\.com$/i,           // GitHub REST
];
const PRIVATE_IP_LITERAL_RE = /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/;
function isLoopbackOrPrivate(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (PRIVATE_IP_LITERAL_RE.test(h)) return true;
  // 172.16.0.0/12 — second octet between 16 and 31 inclusive.
  const m = /^172\.(\d+)\./.exec(h);
  if (m) { const o2 = parseInt(m[1], 10); if (o2 >= 16 && o2 <= 31) return true; }
  return false;
}

// ICS calendar subscription fetch. The URL is user-supplied in
// Settings (any provider's published .ics endpoint), so unlike the
// host-allowlisted fetch-proxy below this accepts any HTTPS host —
// but it still rejects loopback / RFC1918 to keep an SSRF surface
// off the table, caps the response body, and forces text/calendar
// content. A separate handler from fetch-proxy because the security
// posture is different (user URL vs. integration-allowlisted URL)
// and conflating them would weaken both. webcal:// is normalised
// to https:// per the de-facto convention used by every major
// calendar provider.
const ICS_MAX_BYTES = 4 * 1024 * 1024; // 4 MB — accommodates large feeds (year of 30+ events)
// fetch-proxy carries the user's API credentials (Authorization / x-api-key
// for Anthropic, OpenRouter, GitHub, Jira). Cap the redirect chain and the
// response body so a hostile-but-allowlisted endpoint can neither bounce the
// credentials to an internal host nor OOM the main process.
const FETCH_PROXY_MAX_REDIRECTS = 5;
const FETCH_PROXY_MAX_BYTES = 16 * 1024 * 1024; // 16 MB
ipcMain.handle('ics-fetch', async (_event, { url }) => {
  let parsed;
  try {
    // Case-insensitive webcal scheme normalisation — some providers
    // (and copy-paste from email) hand us mixed-case schemes like
    // WEBCAL://… which the URL parser preserves as "WEBCAL:". Match
    // any case so we don't reject otherwise-valid URLs.
    const s = String(url || '').replace(/^webcal:\/\//i, 'https://');
    parsed = new URL(s);
  } catch { return { ok: false, status: 0, error: 'invalid url' }; }
  if (parsed.protocol !== 'https:') {
    return { ok: false, status: 0, error: 'only https / webcal urls are allowed' };
  }
  if (isLoopbackOrPrivate(parsed.hostname)) {
    return { ok: false, status: 0, error: 'private/loopback hosts blocked' };
  }
  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      headers: { 'Accept': 'text/calendar, text/plain;q=0.9, */*;q=0.5' },
      redirect: 'follow',
    });
    // Defense-in-depth against SSRF via HTTP redirect: a public URL
    // might 302 to http://, to a private IP, or to file://. fetch()
    // followed the redirect — by the time we check, the connection
    // is made — but rejecting now still prevents body exfiltration
    // back to the renderer. We do NOT mitigate DNS rebinding
    // (public-host → private-IP resolution): doing that properly
    // requires a custom dns.lookup + http.Agent setup and is left
    // as follow-up.
    try {
      const finalUrl = new URL(res.url);
      if (finalUrl.protocol !== 'https:') {
        return { ok: false, status: res.status, error: 'redirect to non-https rejected' };
      }
      if (isLoopbackOrPrivate(finalUrl.hostname)) {
        return { ok: false, status: res.status, error: 'redirect to private/loopback rejected' };
      }
    } catch {
      return { ok: false, status: res.status, error: 'invalid final url' };
    }
    // Content-Type check: a server returning an HTML error page (or
    // a JSON 200 from an unrelated endpoint) shouldn't be parsed as
    // ICS. We accept any text/* + the spec-correct text/calendar
    // (Google sometimes returns text/plain for webcal exports) and
    // reject the rest before reading the body.
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.startsWith('text/calendar') && !ct.startsWith('text/plain') && !ct.startsWith('application/octet-stream')) {
      try { res.body?.cancel?.(); } catch {}
      return { ok: false, status: res.status, error: `unexpected content-type: ${ct}` };
    }
    // Guard against a rogue server streaming an unbounded response.
    // We consume up to ICS_MAX_BYTES then stop reading.
    const reader = res.body?.getReader();
    if (!reader) {
      return { ok: false, status: res.status, error: 'no response body' };
    }
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > ICS_MAX_BYTES) {
        try { await reader.cancel(); } catch {}
        return { ok: false, status: res.status, error: 'response too large' };
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { ok: res.ok, status: res.status, body: buf.toString('utf8') };
  } catch (err) {
    return { ok: false, status: 0, error: String(err && err.message || err) };
  }
});

// Re-runs the full host gate (https + allowlist + private/loopback) on a
// URL. Used for the initial request AND every redirect hop, so an allowlisted
// host that 3xx-redirects can't smuggle the credential-bearing request to an
// arbitrary or internal target.
function validateProxyTarget(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { return { error: 'invalid url' }; }
  if (parsed.protocol !== 'https:') return { error: 'only https urls are allowed' };
  if (!ALLOWED_PROXY_HOSTS.some((re) => re.test(parsed.hostname))) {
    return { error: `host not allowed: ${parsed.hostname}` };
  }
  if (isLoopbackOrPrivate(parsed.hostname)) return { error: 'private/loopback hosts blocked' };
  return { url: parsed.toString() };
}

ipcMain.handle('fetch-proxy', async (_event, { url, method = 'GET', headers = {}, body = null }) => {
  const first = validateProxyTarget(url);
  if (first.error) return { ok: false, status: 0, error: first.error };
  try {
    // Follow redirects manually so each hop is re-validated before we resend
    // the user's Authorization/x-api-key headers. (Default redirect:'follow'
    // would have already leaked them to the redirect target.)
    let current = first.url;
    let curMethod = method;
    let curHeaders = { ...headers };
    let curBody = body;
    let res;
    for (let hop = 0; ; hop++) {
      if (hop > FETCH_PROXY_MAX_REDIRECTS) {
        return { ok: false, status: 0, error: 'too many redirects' };
      }
      res = await fetch(current, { method: curMethod, headers: curHeaders, body: curBody, redirect: 'manual' });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get('location');
      if (!location) break; // e.g. 304 Not Modified — nothing to follow
      const nextUrl = new URL(location, current);
      const next = validateProxyTarget(nextUrl.toString());
      if (next.error) return { ok: false, status: res.status, error: `redirect ${next.error}` };
      try { res.body?.cancel?.(); } catch {}
      // Cross-host redirect: never resend the user's credentials to a
      // different origin, even an allowlisted one (each integration's key
      // is scoped to its own host).
      if (nextUrl.hostname !== new URL(current).hostname) {
        curHeaders = { ...curHeaders };
        for (const k of Object.keys(curHeaders)) {
          const kl = k.toLowerCase();
          if (kl === 'authorization' || kl === 'x-api-key' || kl === 'cookie') delete curHeaders[k];
        }
      }
      // Per RFC 9110, 301/302/303 turn the follow-up into a bodyless GET.
      if (res.status === 301 || res.status === 302 || res.status === 303) {
        curMethod = 'GET';
        curBody = null;
        curHeaders = { ...curHeaders };
        for (const k of Object.keys(curHeaders)) {
          const kl = k.toLowerCase();
          if (kl === 'content-type' || kl === 'content-length') delete curHeaders[k];
        }
      }
      current = next.url;
    }
    // Bounded read so a rogue server can't OOM the main process.
    let text = '';
    const reader = res.body?.getReader();
    if (reader) {
      const chunks = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > FETCH_PROXY_MAX_BYTES) {
          try { await reader.cancel(); } catch {}
          return { ok: false, status: res.status, error: 'response too large' };
        }
        chunks.push(value);
      }
      text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    }
    // Don't hand Set-Cookie back to the renderer.
    const outHeaders = {};
    for (const [k, v] of res.headers.entries()) {
      if (k.toLowerCase() === 'set-cookie') continue;
      outHeaders[k] = v;
    }
    return { ok: res.ok, status: res.status, headers: outHeaders, body: text };
  } catch (err) {
    return { ok: false, status: 0, error: String(err && err.message || err) };
  }
});

// Clipboard bridge for the text-input context menu (cut/copy/paste). The
// renderer preload runs sandboxed (sandbox: true), where require('electron')
// exposes only {contextBridge, crashReporter, ipcRenderer, nativeImage,
// webFrame, webUtils} — NOT `clipboard` — so the clipboard has to live in the
// main process and be reached over IPC. Read is sendSync because the paste
// handler consumes the string synchronously (renderer/app.js textInputContextMenu).
ipcMain.on('clipboard-read-text', (e) => { e.returnValue = clipboard.readText(); });
ipcMain.on('clipboard-write-text', (_e, text) => { clipboard.writeText(String(text ?? '')); });

// Render caller-supplied HTML to a PDF and save it where the user picks
// (used by the board's roadmap export). The HTML is loaded from a temp
// file into a hidden, JavaScript-disabled, sandboxed window — the markup
// is generated in our renderer but contains teammate-authored text, so
// it gets no scripting and no node access regardless.
ipcMain.handle('export-pdf', async (event, { html, filename, landscape = true } = {}) => {
  if (typeof html !== 'string' || !html || html.length > 4_000_000) {
    return { ok: false, error: 'invalid html payload' };
  }
  const parent = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const safeName = String(filename || 'export.pdf').replace(/[^\w.-]+/g, '-');
  const { canceled, filePath } = await dialog.showSaveDialog(parent, {
    title: 'Export PDF',
    defaultPath: path.join(app.getPath('documents'), safeName),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  const fs = require('fs');
  const tmp = path.join(app.getPath('temp'), `huddle-export-${Date.now()}.html`);
  let win = null;
  try {
    fs.writeFileSync(tmp, html, 'utf8');
    win = new BrowserWindow({
      show: false, width: 1200, height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
    });
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({
      landscape: !!landscape,
      printBackground: true, // bar fills are backgrounds — without this the PDF is empty boxes
      pageSize: 'A4',
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    });
    fs.writeFileSync(filePath, pdf);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    if (win) win.destroy();
    try { fs.unlinkSync(tmp); } catch {}
  }
});

// Background auto-updates via electron-updater (Squirrel.Mac on macOS,
// NSIS on Windows). Reads the GitHub Releases feed configured in the
// `build.publish` block; electron-builder bakes that into app-update.yml
// at package time. No-op when unpackaged (`electron .`) — there's no
// signed bundle to update, and Squirrel.Mac requires a valid Developer
// ID signature to apply anything, so updates only take effect on real
// signed builds. Failures are logged, never surfaced as a nag.
function initAutoUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.on('update-downloaded', ({ version }) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Huddle ${version} has been downloaded.`,
      detail: 'Restart to finish installing the update.',
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });
  autoUpdater.on('error', (err) => {
    console.error('[auto-update]', err == null ? 'unknown error' : (err.stack || err).toString());
  });
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[auto-update] check failed', err);
  });
}

app.whenReady().then(() => {
  createWindow();
  initAutoUpdates();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // System wake / screen unlock: the Realtime WebSocket is frequently
  // left half-open by a sleep (the OS reports the socket OPEN but it's
  // dead), so no `focus`/`online`/`SUBSCRIBED` event in the renderer
  // reliably fires to recover it. powerMonitor gives us the wake signal
  // from the OS itself — relay it (with the reason, so the renderer can
  // distinguish a true wake from a plain unlock) to every window, since
  // popouts run their own renderer/client. (powerMonitor is only usable
  // after `app` is ready.)
  const notifyResume = (reason) => {
    for (const w of [mainWindow, ...popouts.values()]) {
      if (w && !w.isDestroyed() && w.webContents && !w.webContents.isLoading()) {
        try { w.webContents.send('system-resume', { reason }); } catch {}
      }
    }
  };
  powerMonitor.on('resume', () => notifyResume('resume'));
  powerMonitor.on('unlock-screen', () => notifyResume('unlock-screen'));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
