// Signaling + chat server (HTTP + WebSocket on the same port).
//
// Responsibilities:
//   - WebRTC signaling for a "huddle" (room): join/leave, offer/answer/ICE relay
//   - Drawing-stroke broadcast for annotations on shared screens
//   - Slack-style chat: public/private channels, DMs, threads, reactions,
//     edit/delete, history pagination, search
//   - Per-team password auth (set on team creation, required on subsequent
//     joins to that team)
//   - File uploads via short-lived single-use tokens + raw-body POSTs
//
// Persistence: all teams (channels + messages) are written to a JSON file
// behind a small debounced saver.
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { randomUUID } = crypto;

const DATA_FILE = process.env.HUDDLE_DATA_FILE
  || path.join(__dirname, '..', 'data', 'state.json');
const UPLOAD_DIR = process.env.HUDDLE_UPLOAD_DIR
  || path.join(__dirname, '..', 'data', 'uploads');
const UPLOAD_TOKEN_TTL_MS = 5 * 60 * 1000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const DEFAULT_TEAM_ID = 'huddle';
const DEFAULT_CHANNELS = [
  { id: 'general', name: 'general', topic: 'Company-wide announcements and chatter.', type: 'public', protected: true },
  { id: 'random', name: 'random', topic: 'Non-work banter and water-cooler talk.', type: 'public', protected: true },
  { id: 'design', name: 'design', topic: 'Mocks, critiques, and design reviews.', type: 'public', protected: true },
];

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[state] failed to load:', err.message);
    return null;
  }
}

function makePersister() {
  let pending = false, serializer = () => null, timer = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    pending = false;
    const snapshot = serializer();
    if (!snapshot) return;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(snapshot));
      fs.renameSync(tmp, DATA_FILE);
    } catch (err) { console.warn('[state] save failed:', err.message); }
  };
  return {
    bind: (fn) => { serializer = fn; },
    schedule: () => { pending = true; if (!timer) timer = setTimeout(flush, 250); },
    flushSync: flush,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(raw, { min = 2, max = 30, allowDmPrefix = false } = {}) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  if (id.length < min) return null;
  if (!allowDmPrefix && id.startsWith('dm:')) return null;
  return id;
}
const slugifyTeamName = (raw) => slugify(raw, { min: 2, max: 30 });
const slugifyChannelName = (raw) => slugify(raw, { min: 2, max: 30 });

function sanitizeEmoji(raw) {
  if (typeof raw !== 'string' || !raw.length || raw.length > 16) return null;
  if (/[\x00-\x1F\x7F]/.test(raw)) return null;
  return raw;
}

function dmIdFor(a, b) {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const [x, y] = [slug(a), slug(b)].sort();
  return `dm:${x}::${y}`;
}

function visibleTo(meta, name) {
  if (!meta) return false;
  if (meta.type === 'public' || !meta.type) return true;
  return Array.isArray(meta.members) && meta.members.includes(name);
}

function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 32).toString('hex');
}

// Extract `@name` mentions from text. Names are bounded by non-word chars.
function extractMentions(text, candidateNames) {
  if (!text || !candidateNames || candidateNames.length === 0) return [];
  const set = new Set();
  const lookup = new Map(candidateNames.map((n) => [n.toLowerCase(), n]));
  const re = /(^|[^a-zA-Z0-9_])@([a-zA-Z0-9_][a-zA-Z0-9_.-]{0,31})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const hit = lookup.get(m[2].toLowerCase());
    if (hit) set.add(hit);
  }
  return [...set];
}

// ---------------------------------------------------------------------------
// HTTP handler (file uploads + static download)
// ---------------------------------------------------------------------------

function safeFilename(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || 'file';
}

function serveUpload(req, res, uploadTokens) {
  // POST /upload?token=...   raw body, type from Content-Type, name from X-Filename header.
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const entry = uploadTokens.get(token);
  if (!entry || entry.expires < Date.now()) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_token' }));
    return;
  }
  uploadTokens.delete(token); // single-use
  const filename = safeFilename(req.headers['x-filename']);
  const contentType = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 200);
  const declaredSize = parseInt(req.headers['content-length'] || '0', 10);
  if (declaredSize > MAX_UPLOAD_BYTES) {
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'too_large' }));
    return;
  }
  const id = randomUUID();
  const dir = path.join(UPLOAD_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, filename);
  const stream = fs.createWriteStream(target);
  let received = 0;
  let aborted = false;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) {
      aborted = true;
      req.destroy();
      stream.destroy();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'too_large' }));
    }
  });
  req.pipe(stream);
  stream.on('finish', () => {
    if (aborted) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      url: `/uploads/${id}/${encodeURIComponent(filename)}`,
      name: filename,
      contentType,
      size: received,
    }));
  });
  stream.on('error', () => {
    if (aborted) return;
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'write_failed' }));
  });
}

function serveDownload(req, res) {
  // GET /uploads/<id>/<filename> — naive static handler scoped under UPLOAD_DIR.
  const parsed = decodeURIComponent(req.url.split('?')[0]);
  const rel = parsed.replace(/^\/uploads\//, '');
  // Prevent path traversal.
  const target = path.normalize(path.join(UPLOAD_DIR, rel));
  if (!target.startsWith(UPLOAD_DIR + path.sep)) {
    res.writeHead(400); res.end('bad path'); return;
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, {
      'content-length': st.size,
      'cache-control': 'public, max-age=31536000',
    });
    fs.createReadStream(target).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function startServer(port) {
  return new Promise((resolve) => {
    const persister = makePersister();
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    /** Map<peerId, {ws, name, color, team}> */
    const peers = new Map();
    /** Map<teamId, Team> */
    const teams = new Map();
    /** Map<token, {peerId, expires}> */
    const uploadTokens = new Map();
    setInterval(() => {
      const now = Date.now();
      for (const [t, e] of uploadTokens) if (e.expires < now) uploadTokens.delete(t);
    }, 60_000).unref?.();

    function makeTeam(id) {
      const team = {
        meta: { id, name: id },
        passwordHash: null,
        passwordSalt: null,
        channels: new Map(),
        activeScreens: new Map(),
      };
      for (const c of DEFAULT_CHANNELS) team.channels.set(c.id, { meta: { ...c }, messages: [] });
      teams.set(id, team);
      return team;
    }

    // Migrate / load persisted state ---------------------------------------
    const persisted = loadState();
    function ingestTeamPayload(team, tval) {
      if (tval && tval.meta && typeof tval.meta === 'object') {
        team.meta = { id: team.meta.id, name: tval.meta.name || team.meta.id };
      }
      if (tval && typeof tval.passwordHash === 'string') team.passwordHash = tval.passwordHash;
      if (tval && typeof tval.passwordSalt === 'string') team.passwordSalt = tval.passwordSalt;
      if (Array.isArray(tval?.channels)) {
        for (const entry of tval.channels) {
          if (!entry || !entry.meta || typeof entry.meta.id !== 'string') continue;
          const existing = team.channels.get(entry.meta.id);
          if (existing && existing.meta.protected) {
            existing.messages = Array.isArray(entry.messages) ? entry.messages : [];
          } else {
            team.channels.set(entry.meta.id, {
              meta: entry.meta,
              messages: Array.isArray(entry.messages) ? entry.messages : [],
            });
          }
        }
      }
    }
    if (persisted && Array.isArray(persisted.channels)) {
      // v1 -> v2 migration
      const team = makeTeam(DEFAULT_TEAM_ID);
      ingestTeamPayload(team, { channels: persisted.channels });
    } else if (persisted && persisted.teams && typeof persisted.teams === 'object') {
      for (const [tid, tval] of Object.entries(persisted.teams)) {
        if (typeof tid !== 'string') continue;
        ingestTeamPayload(makeTeam(tid), tval);
      }
    }

    persister.bind(() => ({
      version: 2,
      teams: Object.fromEntries(
        Array.from(teams.entries()).map(([id, t]) => [id, {
          meta: t.meta,
          passwordHash: t.passwordHash,
          passwordSalt: t.passwordSalt,
          channels: Array.from(t.channels.values()).map((c) => ({ meta: c.meta, messages: c.messages })),
        }]),
      ),
    }));
    const persist = () => persister.schedule();

    // Send / broadcast / relay --------------------------------------------

    const send = (ws, obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
    const broadcastTeam = (team, obj, exceptId) => {
      for (const [pid, p] of peers) if (p.team === team && pid !== exceptId) send(p.ws, obj);
    };
    const broadcastVisibleInTeam = (team, meta, obj) => {
      for (const p of peers.values()) if (p.team === team && visibleTo(meta, p.name)) send(p.ws, obj);
    };
    const relay = (fromId, toId, obj) => {
      const from = peers.get(fromId), target = peers.get(toId);
      if (from && target && from.team === target.team) send(target.ws, obj);
    };
    const presence = (team) =>
      Array.from(peers.entries())
        .filter(([, p]) => p.team === team)
        .map(([id, p]) => ({ id, name: p.name, color: p.color }));
    const visibleChannels = (team, name) =>
      Array.from(team.channels.values()).map((c) => c.meta).filter((m) => visibleTo(m, name));
    const findChannelByMessageInTeam = (team, messageId) => {
      for (const ch of team.channels.values()) {
        if (ch.messages.some((m) => m.id === messageId)) return ch;
      }
      return null;
    };
    const memberNames = (team) => {
      const set = new Set();
      for (const p of peers.values()) if (p.team === team) set.add(p.name);
      return [...set];
    };

    // ---- WS handler -----------------------------------------------------

    const httpServer = http.createServer((req, res) => {
      // Light CORS so a browser tab on another port can hit /upload during dev.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (req.method === 'POST' && req.url.startsWith('/upload')) return serveUpload(req, res, uploadTokens);
      if (req.method === 'GET' && req.url.startsWith('/uploads/')) return serveDownload(req, res);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('huddle signaling/chat server');
    });
    const wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws) => {
      const peerId = randomUUID();
      ws.peerId = peerId;

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        const me = peers.get(peerId);
        if (msg.type !== 'hello' && !me) return;
        const team = me?.team;

        switch (msg.type) {
          case 'hello': {
            const teamId = slugifyTeamName(msg.team) || DEFAULT_TEAM_ID;
            const existing = teams.get(teamId);
            const password = typeof msg.password === 'string' ? msg.password : '';
            // First join sets the team password (if any). Subsequent joins must match.
            if (existing && existing.passwordHash) {
              if (!password || hashPassword(password, existing.passwordSalt) !== existing.passwordHash) {
                send(ws, { type: 'auth-failed', reason: 'bad_team_password' });
                ws.close();
                return;
              }
            }
            const t = existing || makeTeam(teamId);
            if (!existing && password) {
              t.passwordSalt = crypto.randomBytes(16).toString('hex');
              t.passwordHash = hashPassword(password, t.passwordSalt);
              persist();
            }
            const name = String(msg.name || 'guest').slice(0, 32);
            const color = msg.color || randomColor();
            peers.set(peerId, { ws, name, color, team: t });
            send(ws, {
              type: 'welcome',
              peerId,
              you: { id: peerId, name, color },
              team: { id: t.meta.id, name: t.meta.name, hasPassword: !!t.passwordHash },
              channels: visibleChannels(t, name),
              peers: presence(t),
              activeScreens: Array.from(t.activeScreens.entries()).map(([streamId, info]) => ({
                streamId, from: info.fromId,
                fromName: peers.get(info.fromId)?.name || 'someone',
                label: info.label,
              })),
            });
            broadcastTeam(t, { type: 'peer-joined', peer: { id: peerId, name, color } }, peerId);
            break;
          }

          case 'signal':
            relay(peerId, msg.to, { type: 'signal', from: peerId, payload: msg.payload });
            break;

          case 'screen-announce': {
            team.activeScreens.set(msg.streamId, { fromId: peerId, label: msg.label });
            broadcastTeam(team, {
              type: 'screen-announce', from: peerId, fromName: me.name,
              streamId: msg.streamId, label: msg.label,
            }, peerId);
            break;
          }
          case 'screen-stop':
            team.activeScreens.delete(msg.streamId);
            broadcastTeam(team, { type: 'screen-stop', from: peerId, streamId: msg.streamId }, peerId);
            break;
          case 'draw':
            broadcastTeam(team, { type: 'draw', from: peerId, streamId: msg.streamId, stroke: msg.stroke }, peerId);
            break;

          case 'chat-send': {
            const ch = team.channels.get(msg.channelId);
            if (!ch || !visibleTo(ch.meta, me.name)) return;
            const text = String(msg.text || '').slice(0, 4000);
            const attachments = sanitizeAttachments(msg.attachments);
            if (!text && attachments.length === 0) return;
            const message = {
              id: randomUUID(),
              channelId: msg.channelId,
              parentId: msg.parentId || null,
              authorId: peerId,
              authorName: me.name,
              authorColor: me.color,
              text,
              attachments,
              ts: Date.now(),
              editedTs: null,
              reactions: Object.create(null),
              mentions: extractMentions(text, memberNames(team)),
            };
            ch.messages.push(message);
            persist();
            broadcastVisibleInTeam(team, ch.meta, { type: 'chat-message', message });
            break;
          }

          case 'chat-edit': {
            const ch = findChannelByMessageInTeam(team, msg.messageId);
            if (!ch || !visibleTo(ch.meta, me.name)) return;
            const message = ch.messages.find((m) => m.id === msg.messageId);
            if (!message || message.authorName !== me.name) return; // author-only
            message.text = String(msg.text || '').slice(0, 4000);
            message.editedTs = Date.now();
            message.mentions = extractMentions(message.text, memberNames(team));
            persist();
            broadcastVisibleInTeam(team, ch.meta, { type: 'chat-update', message });
            break;
          }

          case 'chat-delete-message': {
            const ch = findChannelByMessageInTeam(team, msg.messageId);
            if (!ch || !visibleTo(ch.meta, me.name)) return;
            const idx = ch.messages.findIndex((m) => m.id === msg.messageId);
            if (idx === -1) return;
            const message = ch.messages[idx];
            if (message.authorName !== me.name) return;
            ch.messages.splice(idx, 1);
            persist();
            broadcastVisibleInTeam(team, ch.meta, { type: 'chat-message-deleted', channelId: ch.meta.id, messageId: msg.messageId });
            break;
          }

          case 'chat-history': {
            const ch = team.channels.get(msg.channelId);
            if (!ch || !visibleTo(ch.meta, me.name)) return;
            const limit = Math.max(1, Math.min(parseInt(msg.limit, 10) || 50, 200));
            const before = typeof msg.before === 'number' ? msg.before : Infinity;
            // Take messages strictly older than `before`, newest-last, capped to limit.
            const list = ch.messages.filter((m) => m.ts < before).slice(-limit);
            send(ws, {
              type: 'chat-history',
              channelId: msg.channelId,
              messages: list,
              hasMore: list.length > 0 && ch.messages.length > list.length && ch.messages[0].ts < list[0].ts,
            });
            break;
          }

          case 'chat-search': {
            const q = String(msg.query || '').trim().toLowerCase();
            if (!q) return;
            const channelFilter = msg.channelId ? team.channels.get(msg.channelId) : null;
            const channelsToScan = channelFilter ? [channelFilter] : [...team.channels.values()];
            const hits = [];
            for (const ch of channelsToScan) {
              if (!visibleTo(ch.meta, me.name)) continue;
              for (const m of ch.messages) {
                if (m.text && m.text.toLowerCase().includes(q)) hits.push(m);
                if (hits.length >= 200) break;
              }
              if (hits.length >= 200) break;
            }
            send(ws, { type: 'chat-search-results', query: msg.query, results: hits });
            break;
          }

          case 'chat-react': {
            const ch = findChannelByMessageInTeam(team, msg.messageId);
            if (!ch || !visibleTo(ch.meta, me.name)) return;
            const message = ch.messages.find((m) => m.id === msg.messageId);
            if (!message) return;
            const emoji = sanitizeEmoji(msg.emoji);
            if (!emoji || emoji === '__proto__' || emoji === 'constructor' || emoji === 'prototype') return;
            const list = message.reactions[emoji] || (message.reactions[emoji] = []);
            const idx = list.indexOf(peerId);
            if (idx === -1) list.push(peerId);
            else list.splice(idx, 1);
            if (list.length === 0) delete message.reactions[emoji];
            persist();
            broadcastVisibleInTeam(team, ch.meta, { type: 'chat-update', message });
            break;
          }

          case 'chat-create-channel': {
            const id = slugifyChannelName(msg.name);
            if (!id) return;
            if (team.channels.has(id)) {
              const existing = team.channels.get(id).meta;
              if (visibleTo(existing, me.name)) send(ws, { type: 'chat-channel-added', channel: existing });
              return;
            }
            const isPrivate = !!msg.private;
            const requested = Array.isArray(msg.members)
              ? msg.members.filter((x) => typeof x === 'string').map((s) => s.slice(0, 32)).slice(0, 50)
              : [];
            const members = isPrivate ? Array.from(new Set([me.name, ...requested])) : undefined;
            const meta = {
              id, name: id, topic: String(msg.topic || '').slice(0, 200),
              type: isPrivate ? 'private' : 'public',
              createdBy: me.name,
              ...(members ? { members } : {}),
            };
            team.channels.set(id, { meta, messages: [] });
            persist();
            broadcastVisibleInTeam(team, meta, { type: 'chat-channel-added', channel: meta });
            break;
          }

          case 'chat-create-dm': {
            const otherName = String(msg.with || '').slice(0, 32).trim();
            if (!otherName || otherName === me.name) return;
            const id = dmIdFor(me.name, otherName);
            let ch = team.channels.get(id);
            if (!ch) {
              const meta = {
                id, name: otherName, topic: '', type: 'dm',
                createdBy: me.name, members: [me.name, otherName],
              };
              team.channels.set(id, { meta, messages: [] });
              ch = team.channels.get(id);
              persist();
            }
            broadcastVisibleInTeam(team, ch.meta, { type: 'chat-channel-added', channel: ch.meta });
            send(ws, { type: 'chat-channel-focus', channelId: id });
            break;
          }

          case 'chat-delete-channel': {
            const ch = team.channels.get(msg.channelId);
            if (!ch || ch.meta.protected) return;
            const isMember = visibleTo(ch.meta, me.name);
            const allowed = ch.meta.type === 'dm' ? isMember : (ch.meta.createdBy === me.name);
            if (!allowed) return;
            const metaCopy = ch.meta;
            team.channels.delete(msg.channelId);
            persist();
            broadcastVisibleInTeam(team, metaCopy, { type: 'chat-channel-removed', channelId: msg.channelId });
            break;
          }

          case 'typing': {
            const ch = team.channels.get(msg.channelId);
            if (!ch) return;
            broadcastVisibleInTeam(team, ch.meta, {
              type: 'typing', from: peerId, fromName: me.name,
              channelId: msg.channelId, parentId: msg.parentId || null,
            });
            break;
          }

          case 'request-upload-token': {
            // Hand out a single-use, time-boxed token to upload one file. The
            // peer must currently be authenticated and visible to the channel.
            const ch = team.channels.get(msg.channelId);
            if (!ch || !visibleTo(ch.meta, me.name)) return;
            const token = randomUUID();
            uploadTokens.set(token, { peerId, expires: Date.now() + UPLOAD_TOKEN_TTL_MS });
            send(ws, { type: 'upload-token', token, expiresAt: Date.now() + UPLOAD_TOKEN_TTL_MS });
            break;
          }

          default: break;
        }
      });

      ws.on('close', () => {
        const me = peers.get(peerId);
        peers.delete(peerId);
        if (!me) return;
        for (const [streamId, info] of me.team.activeScreens) {
          if (info.fromId === peerId) {
            me.team.activeScreens.delete(streamId);
            broadcastTeam(me.team, { type: 'screen-stop', from: peerId, streamId });
          }
        }
        broadcastTeam(me.team, { type: 'peer-left', peerId });
      });
    });

    httpServer.listen(port, () => {
      console.log(`[signaling] listening on http+ws://0.0.0.0:${port}`);
      resolve({
        close: () =>
          new Promise((res) => {
            persister.flushSync();
            for (const { ws } of peers.values()) { try { ws.close(); } catch {} }
            wss.close(() => httpServer.close(() => res()));
          }),
      });
    });
  });
}

function sanitizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 10).map((a) => ({
    url: typeof a?.url === 'string' ? a.url.slice(0, 500) : '',
    name: typeof a?.name === 'string' ? a.name.slice(0, 200) : '',
    contentType: typeof a?.contentType === 'string' ? a.contentType.slice(0, 100) : '',
    size: typeof a?.size === 'number' ? a.size : 0,
  })).filter((a) => a.url);
}

function randomColor() {
  const hues = [200, 280, 340, 20, 60, 140, 170];
  const h = hues[Math.floor(Math.random() * hues.length)];
  return `hsl(${h} 70% 55%)`;
}

module.exports = { startServer };

if (require.main === module) {
  const port = parseInt(process.env.PORT || '8787', 10);
  startServer(port);
}
