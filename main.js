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
// Tenor key fallback for users who haven't set it in the in-app settings.
ipcMain.handle('get-tenor-key', () => process.env.TENOR_API_KEY || '');

// Generic fetch proxy. Some third-party APIs (notably Atlassian Cloud)
// don't permit browser-origin requests via CORS; routing through main lets
// the renderer hit them with stored credentials. We only proxy https URLs
// to avoid being repurposed for internal-network scans.
ipcMain.handle('fetch-proxy', async (_event, { url, method = 'GET', headers = {}, body = null }) => {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    return { ok: false, status: 0, error: 'only https urls are allowed' };
  }
  try {
    const res = await fetch(url, { method, headers, body });
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
