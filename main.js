// Electron entry. With Supabase as the backend, the bundled signaling/chat
// server is gone — main.js only opens the BrowserWindow, hands the renderer
// a Supabase URL + publishable key, and exposes the desktopCapturer for
// screen sharing.
const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell } = require('electron');
const path = require('path');

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#1a1d21',
    title: 'Huddle',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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
  const ALLOWED = new Set(['media', 'display-capture', 'mediaKeySystem', 'notifications']);
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
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
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
      sandbox: false,
    },
  });
  // Match the main window's external-link policy.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
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
  win.on('closed', () => {
    if (popouts.get(target) === win) popouts.delete(target);
    // Notify any remaining window that a popout closed so they can
    // re-render headers (e.g., show "Pop out" button again).
    fanoutPopoutEvent(win.webContents.id, { event: 'popout-closed', target });
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
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
    display_id: s.display_id,
  }));
});

ipcMain.handle('get-supabase-config', () => ({ url: SUPABASE_URL, anonKey: SUPABASE_KEY }));

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

ipcMain.handle('fetch-proxy', async (_event, { url, method = 'GET', headers = {}, body = null }) => {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, status: 0, error: 'invalid url' }; }
  if (parsed.protocol !== 'https:') {
    return { ok: false, status: 0, error: 'only https urls are allowed' };
  }
  if (!ALLOWED_PROXY_HOSTS.some((re) => re.test(parsed.hostname))) {
    return { ok: false, status: 0, error: `host not allowed: ${parsed.hostname}` };
  }
  if (isLoopbackOrPrivate(parsed.hostname)) {
    return { ok: false, status: 0, error: 'private/loopback hosts blocked' };
  }
  try {
    const res = await fetch(parsed.toString(), { method, headers, body });
    const text = await res.text();
    return {
      ok: res.ok, status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: text,
    };
  } catch (err) {
    return { ok: false, status: 0, error: String(err && err.message || err) };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
