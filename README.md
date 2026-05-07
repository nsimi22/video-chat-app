# Huddle — desktop video + chat

A self-contained Electron desktop app that combines:

- **Teams (workspaces)** — every connection joins one team. People in
  different teams cannot see each other's chat, presence, or screen
  shares. Joining an unknown team auto-creates it.
- **Video chat** over WebRTC (camera + microphone, full mesh).
- **Multi-screen sharing** — share more than one screen or window at the same
  time. Each share appears as its own tile for everyone in the team.
- **Live drawing on shared screens** — anyone can pen, arrow, or erase on top
  of any shared screen. Strokes are broadcast in real time and are
  resolution-independent so they line up for every viewer.
- **Slack-style chat** — public + private channels, direct messages,
  threaded replies, emoji reactions, an emoji picker (with
  `:shortcode:` autoreplace on send), and a typing indicator. Everything
  is persisted to disk and survives server restarts.

The app ships a built-in signaling/chat server (WebSocket) so you can launch it
on one machine and have other peers on the same LAN point at
`ws://<host>:8787` to join.

## Run it

```bash
npm install
npm start            # launches Electron + the signaling server on :8787
```

To run more peers on the same network, start the app on another machine and
enter `ws://<first-machine-ip>:8787` in the connect dialog. Or run the server
standalone (`npm run server`) and have all clients point at it.

Type the same team name to land in the same workspace; type a different one
to spin up an isolated workspace on the same server (handy for hosting
multiple unrelated groups on one signaling box).

## Architecture

```
main.js                 Electron entry; spawns signaling server, sets up
                        permission and display-capture handlers.
preload.js              contextBridge bridge for desktopCapturer.
server/signaling.js     ws-based signaling: join/leave, SDP/ICE relay,
                        screen-announce/stop, drawing broadcast, chat with
                        channels + threads + reactions.
renderer/
  index.html            UI shell: sidebar, call grid, chat pane.
  styles.css            Slack-ish dark theme.
  emojis.js             Curated emoji set + shortcode replacement.
  drawing.js            Per-screen DrawingLayer (canvas overlay with
                        normalized coords).
  webrtc.js             MeshClient: full-mesh peer connections with
                        perfect-negotiation, multi-stream support.
  chat.js               ChatView: channel/thread rendering, reactions,
                        emoji picker.
  app.js                Orchestrator: tiles, controls, source picker.
```

### Multi-screen support

Each screen share is its own `MediaStream` added to every peer connection.
WebRTC's `onnegotiationneeded` re-offers automatically when tracks are added or
removed. A `screen-announce` signaling message carries the human label so each
share gets a friendly tile title on every viewer.

### Drawing sync

Each shared screen has a transparent canvas overlay. Stroke events
(`begin`/`move`/`end`/`clear`) are broadcast through the signaling server and
keyed by `streamId`. Coordinates are stored as normalized 0..1 in the tile's
space so they render correctly at any tile size on any peer.

### Chat

Messages are stored in memory on the server, grouped by channel. Threads are
modeled with `parentId` — clicking "Reply in thread" focuses the thread view
and posts subsequent messages with the parent set. Reactions are toggled with
`chat-react` and broadcast as `chat-update` so every client sees the same
counts.

## Notes / limitations

- Mesh topology — fine for ~6 people; for larger calls you'd want an SFU.
- Chat history is in-memory only; persistence is left as a follow-up.
- The bundled signaling server has no auth — meant for trusted LAN use.
