// Electron entry. With Supabase as the backend, the bundled signaling/chat
// server is gone — main.js only opens the BrowserWindow, hands the renderer
// a Supabase URL + publishable key, and exposes the desktopCapturer for
// screen sharing.
const { app, BrowserWindow, ipcMain, desktopCapturer, session, shell } = require('electron');
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
    if (url) deliverProtocolUrl(url);
    // Window-focus is centralised in deliverProtocolUrl so a URL
    // arriving via open-url (macOS) or pending-buffer drain gets
    // the same restore + focus treatment.
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
