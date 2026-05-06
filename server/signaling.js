// Signaling + chat server.
// One process serves:
//   - WebRTC signaling for a "huddle" (room): join/leave, offer/answer/ICE relay
//   - Drawing-stroke broadcast for annotations on shared screens
//   - Slack-style chat: channels, threaded replies, emoji reactions, presence
// Wire format: every message is JSON with a `type` field. Clients connect via ws://host:port/.
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');

const DEFAULT_CHANNELS = [
  { id: 'general', name: 'general', topic: 'Company-wide announcements and chatter.' },
  { id: 'random', name: 'random', topic: 'Non-work banter and water-cooler talk.' },
  { id: 'design', name: 'design', topic: 'Mocks, critiques, and design reviews.' },
];

function startServer(port) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port });

    /** Map<peerId, {ws, name, color, room}> */
    const peers = new Map();
    /** Map<streamId, {fromId, label}>  Active screen shares; replayed to late joiners. */
    const activeScreens = new Map();
    /** Map<channelId, {meta, messages: Message[]}>  Message = {id, channelId, parentId, authorId, authorName, text, ts, reactions: {emoji: [peerId,...]}} */
    const channels = new Map();
    DEFAULT_CHANNELS.forEach((c) => channels.set(c.id, { meta: c, messages: [] }));

    const send = (ws, obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };
    const broadcast = (obj, exceptId) => {
      for (const [pid, p] of peers) {
        if (pid !== exceptId) send(p.ws, obj);
      }
    };
    const relay = (toId, obj) => {
      const target = peers.get(toId);
      if (target) send(target.ws, obj);
    };

    const presence = () =>
      Array.from(peers.entries()).map(([id, p]) => ({ id, name: p.name, color: p.color }));

    wss.on('connection', (ws) => {
      const peerId = randomUUID();
      ws.peerId = peerId;

      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        switch (msg.type) {
          case 'hello': {
            const name = (msg.name || 'guest').slice(0, 32);
            const color = msg.color || randomColor();
            peers.set(peerId, { ws, name, color, room: 'huddle' });
            send(ws, {
              type: 'welcome',
              peerId,
              channels: Array.from(channels.values()).map((c) => c.meta),
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
            // WebRTC signaling: forward {sdp|ice} from one peer to another.
            const from = peerId;
            const { to, payload } = msg;
            relay(to, { type: 'signal', from, payload });
            break;
          }
          case 'screen-announce': {
            // Tell other peers a new screen track is incoming with a friendly label.
            const me = peers.get(peerId);
            activeScreens.set(msg.streamId, { fromId: peerId, label: msg.label });
            broadcast(
              {
                type: 'screen-announce',
                from: peerId,
                fromName: me ? me.name : 'someone',
                streamId: msg.streamId,
                label: msg.label,
              },
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
            // Drawing-stroke event tied to a specific shared streamId.
            broadcast(
              {
                type: 'draw',
                from: peerId,
                streamId: msg.streamId,
                stroke: msg.stroke, // {action, x, y, color, size, id}
              },
              peerId,
            );
            break;
          }
          case 'chat-send': {
            const me = peers.get(peerId);
            if (!me) return;
            const ch = channels.get(msg.channelId);
            if (!ch) return;
            const message = {
              id: randomUUID(),
              channelId: msg.channelId,
              parentId: msg.parentId || null,
              authorId: peerId,
              authorName: me.name,
              authorColor: me.color,
              text: String(msg.text || '').slice(0, 4000),
              ts: Date.now(),
              reactions: {},
            };
            ch.messages.push(message);
            broadcast({ type: 'chat-message', message });
            // Echo back to sender too.
            send(ws, { type: 'chat-message', message });
            break;
          }
          case 'chat-history': {
            const ch = channels.get(msg.channelId);
            if (!ch) return;
            send(ws, {
              type: 'chat-history',
              channelId: msg.channelId,
              messages: ch.messages,
            });
            break;
          }
          case 'chat-react': {
            const ch = findChannelByMessage(channels, msg.messageId);
            if (!ch) return;
            const message = ch.messages.find((m) => m.id === msg.messageId);
            if (!message) return;
            const list = (message.reactions[msg.emoji] = message.reactions[msg.emoji] || []);
            const idx = list.indexOf(peerId);
            if (idx === -1) list.push(peerId);
            else list.splice(idx, 1);
            if (list.length === 0) delete message.reactions[msg.emoji];
            broadcast({ type: 'chat-update', message });
            send(ws, { type: 'chat-update', message });
            break;
          }
          case 'typing': {
            const me = peers.get(peerId);
            if (!me) return;
            broadcast(
              { type: 'typing', from: peerId, fromName: me.name, channelId: msg.channelId, parentId: msg.parentId || null },
              peerId,
            );
            break;
          }
          default:
            break;
        }
      });

      ws.on('close', () => {
        peers.delete(peerId);
        // Drop any screens this peer was hosting.
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
            for (const { ws } of peers.values()) {
              try {
                ws.close();
              } catch {}
            }
            wss.close(() => res());
          }),
      });
    });
  });
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
