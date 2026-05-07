# Huddle — desktop video + chat, on Supabase

A self-contained Electron desktop app that combines:

- **Magic-link sign-in** — every teammate signs in with their email and a
  6-digit code. Real per-user identity; no shared passwords.
- **Teams (workspaces)** — each user joins one or more teams. People in
  different teams can't see each other's chat, presence, or screen
  shares. Joining an unknown team auto-creates it.
- **Video chat** over WebRTC (camera + microphone, full mesh).
- **Multi-screen sharing** — share more than one screen or window at the
  same time. Each share appears as its own tile for everyone in the
  team.
- **Live drawing on shared screens** — pen, arrow, eraser. Strokes are
  broadcast in real time on a per-screen Realtime channel and align
  for every viewer (resolution-independent).
- **Collaborative whiteboard per channel** — click 🎨 in the chat
  header to open a blank canvas anyone in the channel can draw on
  together. Live strokes ride the same broadcast pipe; completed
  strokes are persisted as polylines in Postgres so the canvas
  survives reloads and latecomers replay the full board on open.
  Open as many as you want at once — each channel gets its own
  whiteboard.
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
  - **GIF picker** powered by Tenor — click `GIF`, search, click a
    result to post. Get a free key at
    <https://tenor.com/developer/dashboard> and drop it into the
    in-app **Settings** panel.
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
- **Tenor** (GIF picker) — same panel.

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

Builds are **unsigned**. On first launch you'll see a Gatekeeper
warning on macOS ("Huddle can't be opened because it is from an
unidentified developer" — right-click the app and pick *Open* to
override) or SmartScreen on Windows (*More info → Run anyway*).
Signing requires an Apple Developer ID (~$99/yr) and a Windows
code-signing cert; once you have those, set the secrets called out in
`.github/workflows/release.yml` and electron-builder will sign +
notarize automatically.

## Run from source

```bash
npm install
npm start

# Optional: enable the GIF picker (Tenor)
TENOR_API_KEY=... npm start
```

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
                       picker, exposes Supabase config + Tenor key via IPC.
preload.js             contextBridge surface for the renderer.
scripts/copy-vendor.js postinstall: copies supabase-js UMD into renderer/vendor/
renderer/
  index.html           UI shell: auth flow, sidebar, call grid, chat pane.
  styles.css           Slack-ish dark theme.
  emojis.js            Curated emoji set + shortcode replacement.
  markdown.js          Tiny markdown renderer (bold/italic/code/links/mentions).
  drawing.js           Per-screen DrawingLayer (canvas overlay, normalized
                       coordinates).
  api.js               HuddleClient: Supabase Auth, Realtime channels for
                       signaling/presence/typing, Postgres reads/writes for
                       chat, Storage uploads.
  webrtc.js            MeshClient: wraps a HuddleClient with WebRTC peer
                       connections; camera + screen streams + perfect-
                       negotiation signaling.
  chat.js              ChatView: channel/thread rendering, markdown,
                       reactions, edit/delete, attachments, GIF picker,
                       history pagination.
  app.js               Orchestrator: auth state machine, team picker,
                       sidebar/tiles/notifications/search, integrates the
                       drawing toolbar.
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
git tag v0.3.0
git push --tags
```

You can also trigger it manually from the Actions tab. Without
signing secrets the artifacts are unsigned (see warning above).
