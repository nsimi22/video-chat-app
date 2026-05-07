// Signaling + chat server.
//
// Multi-team server. Each peer connection joins exactly one team, identified
// by a slugified team id sent in the `hello` message. A team is the workspace
// boundary: peers in different teams cannot see each other's chat, presence,
// screen shares, or signaling traffic. Joining an unknown team auto-creates
// it (Slack-workspace style — no separate provisioning step).
//
// Identity: a peer's display name is the persistent identity within a team.
// peerIds are per-connection. Private/DM membership is keyed by name so a
// user keeps access across reconnects.
//
// Persistence: all teams (channels + messages) are written to a JSON file
// behind a small debounced saver; reloaded on startup.
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.HUDDLE_DATA_FILE
  || path.join(__dirname, '..', 'data', 'state.json');

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
    schedule: () => { pending = true; if (!timer) timer = setTimeout(flush, 250); },
    flushSync: flush,
  };
}

// ---------------------------------------------------------------------------
// Slugs / sanitizers
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

function slugifyTeamName(raw) {
  return slugify(raw, { min: 2, max: 30 }) || null;
}
function slugifyChannelName(raw) {
  return slugify(raw, { min: 2, max: 30 });
}
function sanitizeEmoji(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > 16) return null;
  if (/[\x00-\x1F\x7F]/.test(raw)) return null;
  return raw;
}

function dmIdFor(a, b) {
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const [x, y] = [slug(a), slug(b)].sort();
  return `dm:${x}::${y}`;
}

// ---------------------------------------------------------------------------
// Visibility helpers
// ---------------------------------------------------------------------------

function visibleTo(meta, name) {
  if (!meta) return false;
  if (meta.type === 'public' || !meta.type) return true;
  return Array.isArray(meta.members) && meta.members.includes(name);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function startServer(port) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port });
    const persister = makePersister();

    /** Map<peerId, {ws, name, color, team}>  team is the Team object. */
    const peers = new Map();
    /** Map<teamId, Team>  Team = {meta, channels: Map<id, {meta, messages}>, activeScreens: Map<streamId, {fromId, label}>} */
    const teams = new Map();

    function makeTeam(id) {
      const team = {
        meta: { id, name: id },
        channels: new Map(),
        activeScreens: new Map(),
      };
      for (const c of DEFAULT_CHANNELS) team.channels.set(c.id, { meta: { ...c }, messages: [] });
      teams.set(id, team);
      return team;
    }

    function getOrCreateTeam(id) {
      return teams.get(id) || makeTeam(id);
    }

    // Bootstrap team state from persisted file. Supports both v1 (flat
    // `channels` field, single implicit "huddle" team) and v2 (`teams` map).
    const persisted = loadState();
    if (persisted && Array.isArray(persisted.channels)) {
      // v1 -> v2 migration: drop everything into the default team.
      const team = makeTeam(DEFAULT_TEAM_ID);
      for (const entry of persisted.channels) {
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
    } else if (persisted && persisted.teams && typeof persisted.teams === 'object') {
      for (const [tid, tval] of Object.entries(persisted.teams)) {
        if (typeof tid !== 'string') continue;
        const team = makeTeam(tid);
        if (tval && tval.meta && typeof tval.meta === 'object') {
          team.meta = { id: tid, name: tval.meta.name || tid };
        }
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
    }

    persister.bind(() => ({
      version: 2,
      teams: Object.fromEntries(
        Array.from(teams.entries()).map(([id, t]) => [id, {
          meta: t.meta,
          channels: Array.from(t.channels.values()).map((c) => ({ meta: c.meta, messages: c.messages })),
        }]),
      ),
    }));
    const persist = () => persister.schedule();

    // Helpers --------------------------------------------------------------

    const send = (ws, obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };
    // Broadcast to every peer in the given team, optionally except one peerId.
    const broadcastTeam = (team, obj, exceptId) => {
      for (const [pid, p] of peers) {
        if (p.team === team && pid !== exceptId) send(p.ws, obj);
      }
    };
    // Same, but additionally restrict to peers who can see `meta`.
    const broadcastVisibleInTeam = (team, meta, obj) => {
      for (const p of peers.values()) {
        if (p.team === team && visibleTo(meta, p.name)) send(p.ws, obj);
      }
    };
    // Relay a signaling message between two peers — only if they share a team.
    const relay = (fromId, toId, obj) => {
      const from = peers.get(fromId);
      const target = peers.get(toId);
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

    // Connection handler ---------------------------------------------------

    wss.on('connection', (ws) => {
      const peerId = randomUUID();
      ws.peerId = peerId;

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

        // For everything except `hello`, the peer must already be in a team.
        const me = peers.get(peerId);
        if (msg.type !== 'hello' && !me) return;
        const team = me?.team;

        switch (msg.type) {
          case 'hello': {
            const teamId = slugifyTeamName(msg.team) || DEFAULT_TEAM_ID;
            const t = getOrCreateTeam(teamId);
            const name = String(msg.name || 'guest').slice(0, 32);
            const color = msg.color || randomColor();
            peers.set(peerId, { ws, name, color, team: t });
            send(ws, {
              type: 'welcome',
              peerId,
              you: { id: peerId, name, color },
              team: { id: t.meta.id, name: t.meta.name },
              channels: visibleChannels(t, name),
              peers: presence(t),
              activeScreens: Array.from(t.activeScreens.entries()).map(([streamId, info]) => ({
                streamId,
                from: info.fromId,
                fromName: peers.get(info.fromId)?.name || 'someone',
                label: info.label,
              })),
            });
            broadcastTeam(t, { type: 'peer-joined', peer: { id: peerId, name, color } }, peerId);
            break;
          }

          case 'signal': {
            relay(peerId, msg.to, { type: 'signal', from: peerId, payload: msg.payload });
            break;
          }

          case 'screen-announce': {
            team.activeScreens.set(msg.streamId, { fromId: peerId, label: msg.label });
            broadcastTeam(team, {
              type: 'screen-announce', from: peerId, fromName: me.name,
              streamId: msg.streamId, label: msg.label,
            }, peerId);
            break;
          }
          case 'screen-stop': {
            team.activeScreens.delete(msg.streamId);
            broadcastTeam(team, { type: 'screen-stop', from: peerId, streamId: msg.streamId }, peerId);
            break;
          }
          case 'draw': {
            broadcastTeam(team, {
              type: 'draw', from: peerId, streamId: msg.streamId, stroke: msg.stroke,
            }, peerId);
            break;
          }

          case 'chat-send': {
            const ch = team.channels.get(msg.channelId);
            if (!ch || !visibleTo(ch.meta, me.name)) return;
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
            broadcastVisibleInTeam(team, ch.meta, { type: 'chat-message', message });
            break;
          }

          case 'chat-history': {
            const ch = team.channels.get(msg.channelId);
            if (!ch || !visibleTo(ch.meta, me.name)) return;
            send(ws, { type: 'chat-history', channelId: msg.channelId, messages: ch.messages });
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

          default: break;
        }
      });

      ws.on('close', () => {
        const me = peers.get(peerId);
        peers.delete(peerId);
        if (!me) return;
        // Tear down any screens this peer was hosting in their team.
        for (const [streamId, info] of me.team.activeScreens) {
          if (info.fromId === peerId) {
            me.team.activeScreens.delete(streamId);
            broadcastTeam(me.team, { type: 'screen-stop', from: peerId, streamId });
          }
        }
        broadcastTeam(me.team, { type: 'peer-left', peerId });
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
