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
  `:shortcode:` autoreplace on send), and a typing indicator.
  - Markdown: **bold**, *italic*, `inline code`, ```fenced blocks```,
    autolinked URLs.
  - **@mentions** highlight in messages and trigger a desktop
    notification when the mentioned user isn't actively viewing the
    channel.
  - **Edit / delete** your own messages.
  - **Unread badges** per channel + DM (DMs and `@you` mentions get a
    loud red badge; plain channel chatter gets a muted one).
  - **File uploads** — drag-drop, paste, or click 📎. Images preview
    inline; everything else lands as a download chip. Capped at 50 MB.
  - **History pagination** — channels load 50 messages at a time with
    a "Load older" button.
  - **Search** — 🔍 in the chat header, optionally scoped to the
    current channel.
  - Everything is persisted to disk and survives server restarts.
- **Per-team password auth** — first join sets the password; subsequent
  joins must match. Stored as a scrypt hash + per-team salt.
- **Reconnect with exponential backoff** — if the WebSocket drops, the
  client retries (1s, 2s, 4s, … capped at 30s) and re-syncs presence,
  channels, and roster on the next welcome. A banner warns the user
  while reconnecting.

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

- **Mesh topology** — every peer holds a direct WebRTC connection to
  every other peer. This works well up to roughly six concurrent
  cameras + screens; beyond that, upstream bandwidth (each sender
  encodes once per receiver) and CPU (each peer decodes N streams)
  start to bite. The fix is an SFU (Selective Forwarding Unit) such as
  mediasoup, where the server terminates each peer's WebRTC connection
  and forwards their media to the others. That's a substantial
  architectural change — server-side WebRTC negotiation, simulcast
  layers, native deps for the SFU library, bandwidth estimation —
  deferred as a follow-up.
- **Auth model** is intentionally lightweight (per-team password,
  trust-on-first-use). For a public-internet deployment you'd want
  per-user accounts, TLS termination in front of the signaling server,
  and rate limits on the upload endpoint.
- **Storage** for chat + uploads is the local filesystem under `data/`.
  Move that to a database / object store for anything multi-host.
