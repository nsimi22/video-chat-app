const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const path = require('path');
const { startServer } = require('./server/signaling');

const SIGNALING_PORT = parseInt(process.env.SIGNALING_PORT || '8787', 10);
let mainWindow;
let serverHandle;

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

  // Auto-allow only the permissions we need, and only for our own renderer
  // (the BrowserWindow we created loading our local file://). Any other
  // webContents — e.g. an opened external page — must go through the default
  // deny path.
  const isOurRenderer = (wc) => wc && mainWindow && wc.id === mainWindow.webContents.id;
  const ALLOWED_PERMISSIONS = new Set(['media', 'display-capture', 'mediaKeySystem']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(isOurRenderer(wc) && ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => {
    return isOurRenderer(wc) && ALLOWED_PERMISSIONS.has(permission);
  });

  // Provide on-demand display picker for screen-sharing requests.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    callback({ video: sources[0], audio: 'loopback' });
  }, { useSystemPicker: false });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('signaling-port', SIGNALING_PORT);
  });
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

ipcMain.handle('get-signaling-port', () => SIGNALING_PORT);
ipcMain.handle('get-tenor-key', () => process.env.TENOR_API_KEY || '');

app.whenReady().then(async () => {
  serverHandle = await startServer(SIGNALING_PORT);
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverHandle) serverHandle.close();
  if (process.platform !== 'darwin') app.quit();
});
