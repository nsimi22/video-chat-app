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

  // Permission handler scoped to our renderer.
  const isOurRenderer = (wc) => wc && mainWindow && wc.id === mainWindow.webContents.id;
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
