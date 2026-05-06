// Signaling + chat server.
// One process serves:
//   - WebRTC signaling for a "huddle" (room): join/leave, offer/answer/ICE relay
//   - Drawing-stroke broadcast for annotations on shared screens
//   - Slack-style chat: public + private channels, DMs, threads, reactions
// Wire format: every message is JSON with a `type` field. Clients connect via ws://host:port/.
//
// Identity: a peer's display name is the persistent identity. peerIds are
// per-connection. Private channel membership and DMs are keyed by name so a
// user keeps their access across reconnects.
//
// Persistence: all channels (meta + messages) are written to a JSON file
// behind a small debounced saver; reloaded on startup so chat survives server
// restarts. Live presence (peers, active screens) is not persisted.
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.HUDDLE_DATA_FILE
  || path.join(__dirname, '..', 'data', 'state.json');

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
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[state] failed to load:', err.message);
    return null;
  }
}

function makePersister() {
  let pending = false;
  let serializer = () => null;
  let timer = null;
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
    } catch (err) {
      console.warn('[state] save failed:', err.message);
    }
  };
  return {
    bind: (fn) => { serializer = fn; },
    schedule: () => {
      pending = true;
      if (timer) return;
      timer = setTimeout(flush, 250);
    },
    flushSync: flush,
  };
}

// ---------------------------------------------------------------------------
// Visibility helpers
// ---------------------------------------------------------------------------

// Public channels are visible to anyone. Private/DM channels are visible only
// to peers whose display name appears in the member list.
function visibleTo(meta, name) {
  if (!meta) return false;
  if (meta.type === 'public' || !meta.type) return true;
  return Array.isArray(meta.members) && meta.members.includes(name);
}

function dmIdFor(a, b) {
  // Stable id from sorted, slugified names. Two distinct peers using the same
  // name pair will share the DM thread; this matches Slack-ish DM semantics.
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const [x, y] = [slug(a), slug(b)].sort();
  return `dm:${x}::${y}`;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function startServer(port) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port });
    const persister = makePersister();

    /** Map<peerId, {ws, name, color, room}> */
    const peers = new Map();
    /** Map<streamId, {fromId, label}> */
    const activeScreens = new Map();
    /** Map<channelId, {meta, messages: Message[]}> */
    const channels = new Map();

    // Seed defaults, then layer persisted state on top.
    DEFAULT_CHANNELS.forEach((c) => channels.set(c.id, { meta: { ...c }, messages: [] }));
    const persisted = loadState();
    if (persisted && Array.isArray(persisted.channels)) {
      for (const entry of persisted.channels) {
        if (!entry || !entry.meta || typeof entry.meta.id !== 'string') continue;
        // Default channels keep their seeded meta but pick up persisted messages.
        const existing = channels.get(entry.meta.id);
        if (existing && existing.meta.protected) {
          existing.messages = Array.isArray(entry.messages) ? entry.messages : [];
        } else {
          channels.set(entry.meta.id, {
            meta: entry.meta,
            messages: Array.isArray(entry.messages) ? entry.messages : [],
          });
        }
      }
    }

    persister.bind(() => ({
      version: 1,
      channels: Array.from(channels.values()).map((c) => ({ meta: c.meta, messages: c.messages })),
    }));
    const persist = () => persister.schedule();

    // Helpers --------------------------------------------------------------

    const send = (ws, obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };
    const broadcast = (obj, exceptId) => {
      for (const [pid, p] of peers) if (pid !== exceptId) send(p.ws, obj);
    };
    const relay = (toId, obj) => {
      const target = peers.get(toId);
      if (target) send(target.ws, obj);
    };
    // Send `obj` to peers who can see `meta` (public, or named member).
    const broadcastVisible = (meta, obj) => {
      for (const p of peers.values()) if (visibleTo(meta, p.name)) send(p.ws, obj);
    };
    const presence = () =>
      Array.from(peers.entries()).map(([id, p]) => ({ id, name: p.name, color: p.color }));
    const visibleChannels = (name) =>
      Array.from(channels.values()).map((c) => c.meta).filter((m) => visibleTo(m, name));

    wss.on('connection', (ws) => {
      const peerId = randomUUID();
      ws.peerId = peerId;

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        const me = peers.get(peerId);

        switch (msg.type) {
          case 'hello': {
            const name = (msg.name || 'guest').slice(0, 32);
            const color = msg.color || randomColor();
            peers.set(peerId, { ws, name, color, room: 'huddle' });
            send(ws, {
              type: 'welcome',
              peerId,
              you: { id: peerId, name, color },
              channels: visibleChannels(name),
              peers: presence(),
              activeScreens: Array.from(activeScreens.entries()).map(([streamId, info]) => ({
                streamId,
                from: info.fromId,
                fromName: peers.get(info.fromId)?.name || 'someone',
                label: info.label,
              })),
            });
            broadcast({ type: 'peer-joined', peer: { id: peerId, name, color } }, peerId);
            break;
          }

          case 'signal': {
            const { to, payload } = msg;
            relay(to, { type: 'signal', from: peerId, payload });
            break;
          }

          case 'screen-announce': {
            activeScreens.set(msg.streamId, { fromId: peerId, label: msg.label });
            broadcast(
              { type: 'screen-announce', from: peerId, fromName: me?.name || 'someone', streamId: msg.streamId, label: msg.label },
              peerId,
            );
            break;
          }
          case 'screen-stop': {
            activeScreens.delete(msg.streamId);
            broadcast({ type: 'screen-stop', from: peerId, streamId: msg.streamId }, peerId);
            break;
          }
          case 'draw': {
            broadcast({ type: 'draw', from: peerId, streamId: msg.streamId, stroke: msg.stroke }, peerId);
            break;
          }

          case 'chat-send': {
            if (!me) return;
            const ch = channels.get(msg.channelId);
            if (!ch) return;
            if (!visibleTo(ch.meta, me.name)) return;
            const message = {
              id: randomUUID(),
              channelId: msg.channelId,
              parentId: msg.parentId || null,
              authorId: peerId,
              authorName: me.name,
              authorColor: me.color,
              text: String(msg.text || '').slice(0, 4000),
              ts: Date.now(),
              reactions: Object.create(null),
            };
            ch.messages.push(message);
            persist();
            broadcastVisible(ch.meta, { type: 'chat-message', message });
            break;
          }

          case 'chat-history': {
            if (!me) return;
            const ch = channels.get(msg.channelId);
            if (!ch || !visibleTo(ch.meta, me.name)) return;
            send(ws, { type: 'chat-history', channelId: msg.channelId, messages: ch.messages });
            break;
          }

          case 'chat-react': {
            if (!me) return;
            const ch = findChannelByMessage(channels, msg.messageId);
            if (!ch) return;
            if (!visibleTo(ch.meta, me.name)) return;
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
            broadcastVisible(ch.meta, { type: 'chat-update', message });
            break;
          }

          case 'chat-create-channel': {
            if (!me) return;
            const id = slugifyChannelName(msg.name);
            if (!id) return;
            if (channels.has(id)) {
              const existing = channels.get(id).meta;
              if (visibleTo(existing, me.name)) {
                send(ws, { type: 'chat-channel-added', channel: existing });
              }
              return;
            }
            const isPrivate = !!msg.private;
            const requested = Array.isArray(msg.members)
              ? msg.members.filter((x) => typeof x === 'string').map((s) => s.slice(0, 32)).slice(0, 50)
              : [];
            const members = isPrivate
              ? Array.from(new Set([me.name, ...requested]))
              : undefined;
            const meta = {
              id, name: id,
              topic: String(msg.topic || '').slice(0, 200),
              type: isPrivate ? 'private' : 'public',
              createdBy: me.name,
              ...(members ? { members } : {}),
            };
            channels.set(id, { meta, messages: [] });
            persist();
            broadcastVisible(meta, { type: 'chat-channel-added', channel: meta });
            break;
          }

          case 'chat-create-dm': {
            if (!me) return;
            const otherName = String(msg.with || '').slice(0, 32).trim();
            if (!otherName || otherName === me.name) return;
            const id = dmIdFor(me.name, otherName);
            let ch = channels.get(id);
            if (!ch) {
              const meta = {
                id,
                name: otherName, // displayed from the perspective of the other side
                topic: '',
                type: 'dm',
                createdBy: me.name,
                members: [me.name, otherName],
              };
              channels.set(id, { meta, messages: [] });
              ch = channels.get(id);
              persist();
            }
            // Notify both members (whoever is online).
            broadcastVisible(ch.meta, { type: 'chat-channel-added', channel: ch.meta });
            // Echo to creator unconditionally so their UI switches into it
            // even if the broadcast already covered them.
            send(ws, { type: 'chat-channel-focus', channelId: id });
            break;
          }

          case 'chat-delete-channel': {
            if (!me) return;
            const ch = channels.get(msg.channelId);
            if (!ch) return;
            if (ch.meta.protected) return; // default channels are immutable
            // Only the creator may delete; for DMs either member counts.
            const creator = ch.meta.createdBy;
            const isMember = visibleTo(ch.meta, me.name);
            const allowed = ch.meta.type === 'dm' ? isMember : (creator === me.name);
            if (!allowed) return;
            const metaCopy = ch.meta;
            channels.delete(msg.channelId);
            persist();
            broadcastVisible(metaCopy, { type: 'chat-channel-removed', channelId: msg.channelId });
            break;
          }

          case 'typing': {
            if (!me) return;
            const ch = channels.get(msg.channelId);
            if (!ch) return;
            // Don't leak typing state to non-members of private channels.
            broadcastVisible(ch.meta, {
              type: 'typing', from: peerId, fromName: me.name,
              channelId: msg.channelId, parentId: msg.parentId || null,
            });
            break;
          }

          default: break;
        }
      });

      ws.on('close', () => {
        peers.delete(peerId);
        for (const [streamId, info] of activeScreens) {
          if (info.fromId === peerId) {
            activeScreens.delete(streamId);
            broadcast({ type: 'screen-stop', from: peerId, streamId });
          }
        }
        broadcast({ type: 'peer-left', peerId });
      });
    });

    wss.on('listening', () => {
      console.log(`[signaling] listening on ws://0.0.0.0:${port}`);
      resolve({
        close: () =>
          new Promise((res) => {
            persister.flushSync();
            for (const { ws } of peers.values()) { try { ws.close(); } catch {} }
            wss.close(() => res());
          }),
      });
    });
  });
}

function slugifyChannelName(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  if (id.length < 2) return null;
  if (id.startsWith('dm:')) return null; // reserved namespace for DMs
  return id;
}

function sanitizeEmoji(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 16) return null;
  if (/[\x00-\x1F\x7F]/.test(raw)) return null;
  return raw;
}

function findChannelByMessage(channels, messageId) {
  for (const ch of channels.values()) {
    if (ch.messages.some((m) => m.id === messageId)) return ch;
  }
  return null;
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
