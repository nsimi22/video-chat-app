# Huddle — desktop video + chat, on Supabase

A self-contained Electron desktop app that combines:

- **Email-code sign-in** — every teammate signs in with their email and a
  6-digit code; real per-user identity. A password can optionally be set
  (and changed) afterward for a faster return login.
- **Teams (workspaces)** — each user joins one or more teams. People in
  different teams can't see each other's chat, presence, or screen
  shares. Joining an unknown team auto-creates it.
- **Video chat** over WebRTC (camera + microphone, full mesh).
- **Live call transcription** — opt-in captions powered by the browser's
  built-in speech-to-text; every peer's lines merge into one shared
  transcript panel, and **`/summarize`** during a call asks the AI for a
  recap (key points, decisions, action items).
- **Multi-screen sharing** — share more than one screen or window at the
  same time. Each share appears as its own tile for everyone in the
  team.
- **Live drawing on shared screens** — pen, line, arrow, shapes, and an
  eraser. Strokes are broadcast in real time on a per-screen Realtime
  channel and align for every viewer (resolution-independent); screen
  annotations are ephemeral.
- **Collaborative whiteboard per channel** — click 🎨 in the chat
  header to open a blank infinite canvas anyone in the channel can draw
  on together. Tools: pen, straight line + arrow (hold Shift to snap to
  45°), rectangle / ellipse / diamond shapes (Shift = perfect
  square/circle), an **object eraser** that deletes whole strokes its
  nib passes over, and a **select tool** to click a stroke, drag it to a
  new spot, or hit Delete to remove it — all changes broadcast live and
  persisted. Live strokes ride the broadcast pipe; completed strokes are
  saved as polylines in Postgres so the canvas survives reloads and
  latecomers replay the full board on open. Open as many as you want at
  once — each channel gets its own whiteboard.
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
    inline; everything else lands as a download chip.
  - **GIF picker** powered by Giphy — click `GIF`, search, click a
    result to post. Get a free key at
    <https://developers.giphy.com/> and drop it into the in-app
    **Settings** panel.
  - **History pagination** — channels load 50 messages at a time.
  - **Search** — 🔍 in the chat header, scoped to all visible channels
    or just the current one.

Everything is persisted in **Supabase Postgres**; uploads land in
**Supabase Storage**; signaling, presence, drawing, and typing all ride
on **Supabase Realtime** broadcast channels. There's no local server to
run.

### Settings + integrations

The **⚙ Settings** panel (top-left of the sidebar) is the one place to
drop in API keys. Keys live in your private Supabase row
(`user_integrations`, RLS-gated to your own user_id) — they are never
shared with teammates.

- **Jira** (Atlassian Cloud)
  - Add your site (`acme.atlassian.net`), email, and an
    [API token](https://id.atlassian.com/manage-profile/security/api-tokens).
  - **Auto-unfurl**: any `PROJ-123` key or `*.atlassian.net/browse/…`
    URL pasted in chat shows a card with title, type, status, and
    assignee. Each viewer's unfurl uses their own credentials, so
    visibility matches their actual Jira access.
  - **`/jira PROJ-123`** posts a quick lookup.
  - **`/jira create [summary]`** or the **🎫 Ticket** button in the
    call controls opens a Create-ticket modal you can fire mid-meeting.
    Picks project, issue type, summary, description; optionally posts
    the new ticket back to the channel.
- **AI assistant** (Claude or OpenRouter)
  - **`/ai <prompt>`** is the general-purpose assistant — ask it
    anything. It posts an answer from your chosen provider (default
    model: `claude-opus-4-7` for Anthropic direct,
    `anthropic/claude-opus-4-7` via OpenRouter — both overridable in
    Settings). The team sees a single message containing your question
    above the AI's response, rendered with a robot avatar and a *via
    @you* footer. When Jira is configured it can also read, comment on,
    update, or transition a ticket you name.
  - **`/ai-ticket <description>`** turns a freeform description into a
    well-structured Jira ticket and files it in your default project. If
    a GitHub repo is wired up for the project, it first grounds itself in
    the actual code (searching files, reading them, scanning issues +
    recent commits) and cites file paths in the ticket body.
  - **`/summarize`** asks the AI for a recap — the last 100 messages of
    the current channel or thread, or the live transcript when you're on
    a call.
  - Anthropic calls use **adaptive thinking** (the model decides how
    much to think per request).
  - All AI traffic is routed through the Electron main process so the
    renderer never touches third-party origins directly.
- **GitHub** (Personal Access Token)
  - **Auto-unfurl** for `<owner>/<repo>#<number>` references and
    `https://github.com/<owner>/<repo>/(issues|pull)/<n>` URLs. Card
    shows title, state (open/closed/merged), author, and assignee.
  - **`/gh <owner>/<repo>#<n>`** posts the URL for an instant unfurl.
  - **`/gh issue <owner>/<repo> <title> [-- body…]`** files an issue
    from chat and posts the new URL.
  - Each viewer's PAT is used for their own unfurls, so visibility
    matches their actual GitHub access.
- **Giphy** (GIF picker) — same panel.

## Download

Pre-built installers are produced for every tagged release and attached
to the [latest GitHub Release](../../releases/latest):

| OS | Direct link |
| --- | --- |
| macOS (Apple silicon) | [Huddle-mac-arm64.dmg](../../releases/latest/download/Huddle-mac-arm64.dmg) |
| macOS (Intel) | [Huddle-mac-x64.dmg](../../releases/latest/download/Huddle-mac-x64.dmg) |
| Windows | [Huddle-win-x64.exe](../../releases/latest/download/Huddle-win-x64.exe) |
| Linux (AppImage) | [Huddle-linux-x64.AppImage](../../releases/latest/download/Huddle-linux-x64.AppImage) |
| Linux (.deb) | [Huddle-linux-x64.deb](../../releases/latest/download/Huddle-linux-x64.deb) |

Builds are **not Developer ID signed / not notarized** (the macOS
binary is ad-hoc signed only, so it launches on Apple Silicon, but
Gatekeeper still won't trust it). You'll need to bypass each OS's
first-launch gatekeeper:

- **macOS** — recent macOS versions report ad-hoc-signed downloaded
  apps as *"'Huddle' is damaged and can't be opened. You should move
  it to the Trash."* It isn't actually damaged; that's Gatekeeper
  refusing to trust the app because the browser tagged the download
  with `com.apple.quarantine`. After dragging Huddle into
  `/Applications`, remove just the quarantine attribute from Terminal:

  ```bash
  xattr -dr com.apple.quarantine /Applications/Huddle.app
  ```

  Then double-click to open normally. (The older right-click → *Open*
  bypass no longer works in macOS Sequoia 15+; the `xattr` command
  replaces it.)
- **Windows** — SmartScreen will block on first launch; click
  *More info → Run anyway*.

Signing requires an Apple Developer ID (~$99/yr) and a Windows
code-signing cert; once you have those, set the secrets called out in
`.github/workflows/release.yml` and electron-builder will sign +
notarize automatically.

## Run from source

```bash
npm install
npm start
```

The GIF picker (Giphy), AI assistant, Jira, GitHub, and other
integrations are configured per-user in the in-app **⚙ Settings**
panel after sign-in — no env vars required.

`npm install` runs a `postinstall` step that copies the
`@supabase/supabase-js` UMD bundle into `renderer/vendor/` so the
renderer can `<script src>` it without a CDN.

The app ships with the URL + publishable anon key for a Supabase
project I created (`huddle`). To point at your own project, set
`HUDDLE_SUPABASE_URL` and `HUDDLE_SUPABASE_KEY` before launching:

```bash
HUDDLE_SUPABASE_URL=https://<ref>.supabase.co \
HUDDLE_SUPABASE_KEY=sb_publishable_... \
npm start
```

The schema, RLS policies, auth settings, and Storage bucket are checked
into the migration history of the Supabase project. To recreate them
in a fresh project, use the `apply_migration` tool on the SQL files
that produced this state, or run them via the Supabase SQL editor:

- `huddle_initial_schema` — tables, RLS policies, triggers, Realtime
  publication
- `huddle_storage_and_realtime_broadcast` — Storage `uploads` bucket
  with per-uid RLS, Realtime broadcast policies for `team:*` and
  `screen:*` topics

## Architecture

```
main.js                Electron entry; opens window, handles screen-source
                       picker, exposes Supabase config + fetch-proxy via IPC.
preload.js             contextBridge surface for the renderer.
scripts/copy-vendor.js postinstall: copies supabase-js UMD into renderer/vendor/
renderer/
  index.html           UI shell: auth flow, sidebar, call grid, chat pane.
  styles.css           Slack-ish dark theme.
  emojis.js            Curated emoji set + shortcode replacement.
  markdown.js          Tiny markdown renderer (bold/italic/code/links/mentions).
  icons.js             Inline SVG icon set used across the UI.
  drawing.js           Per-screen DrawingLayer (canvas overlay, normalized
                       coordinates) for ephemeral screen annotations.
  infinite-canvas.js   InfiniteCanvas: the pannable/zoomable whiteboard
                       surface — pen/line/arrow/shape tools, object eraser,
                       select-move-delete, incremental + full re-render.
  whiteboard.js        WhiteboardSession: wires a channel's whiteboard to
                       Realtime broadcast + Postgres persistence (replay,
                       undo, erase, move) and the sticky-note layer.
  transcript.js        TranscriptManager: continuous browser speech-to-text
                       for live call captions.
  api.js               HuddleClient: Supabase Auth, Realtime channels for
                       signaling/presence/typing/drawing, Postgres reads/
                       writes for chat + whiteboard strokes, Storage uploads.
  webrtc.js            MeshClient: wraps a HuddleClient with WebRTC peer
                       connections; camera + screen streams + perfect-
                       negotiation signaling.
  ai.js, ai-tools.js   AI provider client (Claude / OpenRouter via the main-
                       process proxy) and the Jira tool definitions wired
                       into /ai. (The /ai-ticket GitHub repo tools are
                       defined in chat.js alongside that command.)
  jira.js, github.js   Atlassian + GitHub REST clients for unfurls, /jira,
                       /gh, and ticket creation/updates.
  chat.js              ChatView: channel/thread rendering, markdown,
                       reactions, edit/delete, attachments, GIF picker,
                       slash commands, history pagination.
  profile-card.js      Hover/click user profile cards.
  app.js               Orchestrator: auth state machine, team picker,
                       sidebar/tiles/notifications/search, call transcription,
                       integrates the drawing + whiteboard toolbars.
```

## Notes / limitations

- **Mesh topology** — every peer holds a direct WebRTC connection to
  every other peer. Fine up to ~6 concurrent cameras + screens; beyond
  that you'd want an SFU. Replacing the mesh with mediasoup is a
  multi-week change; deferred.
- **Auth** uses Supabase's email-OTP (`signInWithOtp` +
  `verifyOtp({ type: 'email' })`) which works in Electron without a
  custom URL scheme — users paste the 6-digit code from the email
  body.
- **Mentions, reactions** are computed/edited client-side. Reactions
  use optimistic concurrency on a JSONB column; collisions are rare
  and self-healing.
- **Storage** is public-read so attachment URLs are easy to embed in
  chat. Writes are restricted by RLS to `<uid>/...` paths so users
  can't overwrite each other's files.

## Cutting a release

The `release` workflow at `.github/workflows/release.yml` builds Mac /
Windows / Linux installers in parallel and attaches them to a GitHub
Release whose tag matches the one you pushed.

```bash
# Bump version in package.json, commit, then:
git tag v0.17.0
git push --tags
```

You can also trigger it manually from the Actions tab. Without
signing secrets the artifacts are unsigned (see warning above).
