---
title: Huddle UI Overhaul v2 — Apply Claude Design Bundle (full inventory)
status: draft-awaiting-approval
created: 2026-05-28
last_updated: 2026-05-28
supersedes: ui-overhaul_2026-05-28.md
feature: ui-overhaul
tags: [ui, design-system, electron, renderer, dark-theme]
current_phase: 0
total_phases: 6
---

# Huddle UI Overhaul v2

> v1 was light on content. Nick flagged: "the UI shows an AI assistant and live transcript, etc." v2 adds a **Design Inventory** that names every component from the bundle's JSX so no piece gets handwaved. The 6-phase structure is unchanged; phases now have real task lists.

## What's new vs v1

- **Design Inventory section** — every component spec from `huddle/*.jsx` is enumerated below, with the live-app file it maps to. Drives the per-phase task lists, so nothing gets skipped.
- **New features explicitly catalogued** — beyond shell + theme, the design implies several features the live app doesn't have yet (Saved-messages inbox, Mentions & reactions inbox, Raise hand in calls, dedicated AI panel, ⌘K palette, suggestion chips, AI-reply quick actions, workspace switcher, custom titlebar with traffic lights + ⌘K pill, persistent call dock, model badge, LiveKit + Mobile call indicators). Each is tagged **[NEW]** in the inventory.
- **Phase 3, 4, and 5 are deeper** — chat / call / AI now have full sub-task lists.

## Why this plan exists

The Claude Design bundle (`/tmp/huddle-bundle/huddle-logo/`) is a full visual + interaction spec for a Huddle redesign. README:

> "Match the visual output; don't copy the prototype's internal structure unless it happens to fit."

So: reskin the live vanilla-JS Electron renderer in place, add the missing features, do NOT introduce React. Backend (Supabase + LiveKit + WebRTC + Jira/GitHub/AI) stays untouched.

## Design Inventory (source-of-truth reference)

Every UI primitive, layout block, and interaction in the bundle, with its source file and target. Implementation phases pull directly from this list.

### Tokens (`Huddle App.html` `:root`)
| Group | Tokens |
|---|---|
| Backdrop | `--bg-0` `--bg-1` `--bg-2` `--bg-3` `--bg-hover` |
| Lines | `--line` `--line-soft` |
| Text | `--tx-hi` `--tx-mid` `--tx-lo` `--tx-faint` |
| Accent (hue swappable) | `--accent` `--accent-hi` `--accent-dim` `--accent-tx` |
| Status colors | `--live` `--live-dim` `--online` `--away` `--busy` `--danger` |
| Density (var-driven) | `--row-py` `--msg-gap` `--ui` |
| Radii | `--r-sm 7` `--r-md 11` `--r-lg 16` `--r-xl 22` |
| Layout | `--rail-w 68` `--panel-w 256` |
| Fonts | `--font` (Hanken Grotesk), `--mono` (JetBrains Mono) |
| Shadows | `--sh-pop` (popovers), `--sh-card` |
| Keyframes | `huddle-spin`, `huddle-pulse`, `huddle-fade-up`, `huddle-pop`, `huddle-live-ring` (transform-only entrance per the bundle's bug-fix in `chats/chat2.md`) |

### Iconography (`huddle/icons.jsx`)
- **51 stroke icons** in a single `ICON_PATHS` map, 24×24 viewBox, `currentColor`. Names: `hash, at, lock, chat, video, videoOff, board, calendar, sparkles, settings, search, bell, plus, chevronDown, chevronRight, chevronLeft, phone, phoneOff, mic, micOff, screen, grid, thread, reaction, pin, bookmark, link, edit, trash, more, send, paperclip, smile, logout, check, checks, x, command, pen, arrowTool, square, circle, diamond, eraser, text, cursor, zoomIn, zoomOut, undo, ticket, github, summarize, caption, people, expand, download, dot, arrowRight, reply, hand, star`.
- **`HuddleMark`** — brand mark: accent-dot + 3 concentric arcs. Already approximated in `index.html`; design version is at `huddle/icons.jsx:HuddleMark` (slightly different geometry — taller arcs).

### UI primitives (`huddle/ui.jsx`)
| Primitive | Spec |
|---|---|
| `Avatar` | Square w/ rounded corners (34% radius, 30% for bot), user-hue background `oklch(0.62 0.14 hue)`, initials in white, optional status dot (right-bottom, 32% size). Bot variant = accent gradient w/ sparkles icon. |
| `PresenceDot` | 8px circle, color from `statusColor()` |
| `Reaction` | Pill chip w/ inline SVG glyph + count, accent-tinted when `me: true`. **NOTE**: the design uses custom `REACTION_GLYPHS` SVG paths *as a mockup shortcut*; the live app uses real emoji (per README + a comment in `data.jsx`). Keep emoji in prod; only restyle the chip. |
| `IconBtn` | 34×34 square button, 9px radius, hover bg `--bg-3`, active accent-dim, optional `badge` dot, danger variant turns red on hover |
| `Btn` | 5 kinds: `primary` (accent fill, dark text, 700 weight), `live` (teal fill), `danger` (red), `solid` (raised, bordered), `ghost` (transparent + hover). Sizes `sm` (h30) / `md` (h36). Optional left icon. |
| `Tooltip` | Custom hover popover (bg-0, border, `--sh-pop`, 12px text, 700 weight). Not native `title`. |
| `renderText` | Tiny markdown: `**bold**`, `*italic*`, `` `code` `` (mono w/ bg-3 + accent-tx), `@mention` (accent-dim pill). Live app already has `markdown.js` — confirm parity, adopt the design's `@mention` pill style. |
| `ImgPlaceholder` | Diagonal stripe pattern w/ mono label chip. **For mockup only — never used in prod.** |

### App shell (`huddle/app.jsx`)
- **Custom 36px titlebar** [NEW]: macOS traffic lights left, centered "Huddle — <workspace>" label, ⌘K search pill on right (small, mono, w/ `⌘K` glyph). Body has 0 OS chrome.
- **NavRail** [NEW]: 68px column, items = `chat / call / whiteboard / calendar / ai` + `settings` (bottom) + `Avatar` (bottom-bottom). Active state: accent-dim background + 3px accent bar on left edge. Call icon shows pulsing live dot when call is active.
- **Contextual panel** (`--panel-w 256`): only renders when `view === 'chat'`. Header = workspace name (800 weight) + chevron-down switcher + "New message" icon-btn. Body =
  - 3 quick rows: **Saved** [NEW], **Mentions & reactions** [NEW], **Calendar** (deeplink to view).
  - `Section` "Channels" with `+` action; rows are `ChannelRow` (hash/lock icon, name, mute bell, unread chip).
  - `Section` "Direct messages" with `+` action; rows use 2-stacked avatars + comma-joined names.
  - `Section` "Team" — every non-bot user with status dot + role text.
- **CallDock** [NEW]: thin bar at top of content area when `callActive && view !== 'call'`. Live dot, "Call in #channel-name", mono timer "12:04", member-avatar stack, mic + camera quick toggles, **live**-kind "Return to call" button, **danger**-kind "Leave" button.
- **App body**: rail | panel | content | (right ThreadPanel when thread open).
- **Tweaks panel** in design = dev-only floating dock; in prod folds into Settings → Appearance.

### Chat surface (`huddle/chat.jsx`)
- **ChatHeader** (60px): channel icon + name (700 w, 16.5px) + topic (lo color, truncate), member-avatar stack w/ "+N" overflow chip, IconBtns: Whiteboard, Threads, Pin, divider, primary "Start call" / live "Join call".
- **DayDivider**: thin lines flanking a mono uppercase pill ("MON, MAY 18") on bg-2.
- **MessageRow**:
  - 38px avatar + status dot
  - meta line: name (700, 14.5) + role chip (11px, faint, letterspacing) + mono timestamp (11.5, faint)
  - optional **quote block** [verify exists in prod] — left-bordered, bg-1, small font
  - body via `renderText`
  - optional inline attachment (image placeholder in mock)
  - **Jira unfurl** card — left colored stripe + ticket icon + key (mono) + type + title + status pill w/ colored square + assignee
  - **GitHub unfurl** card — github icon + repo (mono) + #num (mono) + title + state pill (round, dot, colored)
  - **Reactions row** w/ chips + circular add-reaction button
  - **Thread continuation pill** — 20px avatars stacked, "N replies" (accent-tx, 700), "last reply" preview, chevron-right
  - **Hover toolbar** (top-right, popover): React, Reply in thread, **Save** [NEW], **Pin** [verify], More
- **AICard** (inline): outlined card w/ accent border + accent-dim gradient. Two sections: prompt header (sparkles icon + dimmed user prompt) + body (`renderText`). Footer "via <avatar> <user.short> · claude-opus-4" in faint text.
- **Composer**:
  - Outer: `--r-lg` border, bg-1.
  - Textarea (1 row, expands to 160px max).
  - **Toolbar row** below: paperclip / GIF (mono text button) / smile / sparkles ("Ask AI" — inserts `/ai `) / spacer / "↵ send · ⇧↵ newline" mono hint / Send button (primary when text, solid when empty).
  - **Slash-command popup** (appears above when input starts with `/`): "Commands" header + matching commands; each row = icon tile + mono command (96px col) + description. First row pre-highlighted (bg-3).
  - Slash commands shown: `/ai`, `/summarize`, `/huddle`, `/jira`, `/gh`.

### Call surface (`huddle/call.jsx`)
- **Call header**: LIVE pill (red dot + pulse + "LIVE" 700), channel name w/ faded `#`, mono "4 people · 12:04", **LiveKit pill** [NEW UI] (border, online-dot, "LiveKit", title="Calls run on LiveKit — works across desktop & mobile"), spacer, solid buttons "Open whiteboard" + "Create ticket", IconBtns "Layout" + "Fullscreen".
- **Stage** has two modes:
  - **Sharing**: `ScreenShareStage` fills, with 184px side strip of `VideoTile`s.
  - **Grid**: 2×2 (or 2×N) `VideoTile`s.
  - Layout button toggles between.
- **ScreenShareStage**:
  - Diagonal stripe placeholder background (mockup-only)
  - Top-left pill: screen icon (live color) + "Lando's screen" + mono context " · Figma — Huddle redesign"
  - `DrawingCanvas` overlay
  - **Drawing toolbar** at bottom-center: 6 tools (cursor / pen / arrow / rect / ellipse / eraser) + divider + 5 colors + divider + undo + clear. Each tool 34×34, active = accent fill + bg-0 icon.
- **VideoTile**:
  - When cam on: user-hue radial gradient (`oklch(0.4 0.07 hue)` → `oklch(0.22 0.04 hue)`), 1px scan-line repeating pattern.
  - When cam off: avatar centered (96px big / 56px small).
  - Bottom-left **mute pill**: mic/micOff icon + name (or "You"), backdrop-blur, semi-transparent bg.
  - Bottom-right **Mobile pip** [NEW] when peer joined via mobile: phone icon + "Mobile" label.
  - Top-right **speaking indicator** [NEW] (3 bars, animated, live color) when speaker is active.
  - Speaking ring: 2px live border + `box-shadow` 4px live-dim halo.
  - Mobile-mock variant adds an inner phone-frame outline overlay.
- **Live transcript panel** [NEW dedicated panel] (296px right rail, only when `captions === true`):
  - Header: caption icon (accent-tx) + "Live transcript" (700, 13.5) + spacer + summarize IconBtn + close X.
  - Body: scrolling list of speaker rows (avatar 18px + name 700 + mono time + indented text). Auto-scroll on append.
  - **Still-talking indicator**: 3 pulsing dots when next line is in flight.
  - Footer: full-width ghost button with summarize icon + "/summarize" label.
- **Control bar** (bottom, centered):
  - `CallControl` widgets stacked icon-over-label: Mute, Camera, Share (active=accent), Captions (active=accent), **Raise hand** [NEW: `hand` icon], Board.
  - Divider.
  - Wide danger "Leave" button (rounded pill, "phoneOff" icon + label).

### AI assistant panel — dedicated view (`huddle/overlays.jsx:AIPanel`) [NEW]
- **Header**: AI avatar (32px) + "Huddle AI" title + subtitle "Reads your channels, Jira & GitHub — with your access" + spacer + mono model badge ("claude-opus-4", bordered, padded).
- **Transcript**: centered max-width 760px column. Each turn = 30px avatar + name (700) + body via `renderText`. AI replies fade-up.
- **AI-reply action buttons** [NEW]: when the latest message is from AI, show "File ticket" (primary, ticket icon) + "Post to channel" (solid, link icon) chips below the reply.
- **Suggestion chips** [NEW]: above the composer, 3 pre-canned prompts as 18px rounded pills. Click → fills the composer.
- **Composer**: `--r-lg` bordered box, sparkles icon (accent-tx) + input + Send button (primary on text, solid empty).

### Command palette (`huddle/overlays.jsx:CommandPalette`) [NEW]
- ⌘K toggles. Click outside or ESC closes. Backdrop blurred.
- Modal: 600px wide, 70vh max, centered 12vh from top. `huddle-pop` animation in.
- Header: search icon + 16px input + ESC chip.
- Body grouped by `group` key: **Go to** (start call, whiteboard, calendar, ask AI), **Channels** (top 4), **People**, **Actions** (summarize, create Jira).
- Each row: 30px icon tile (or avatar for people) + label + right-side mono hint (e.g., `/huddle`, `/ai`, `/summarize`).
- First row pre-highlighted.

### Thread panel (`huddle/overlays.jsx:ThreadPanel`)
- 380px right-side panel. Border-left, bg-1.
- Header: thread icon (accent-tx) + "Thread" + close X.
- Body: parent message (full row) + thin divider + "N REPLIES" uppercase label + reply list.
- Footer: bordered composer w/ input + send IconBtn.

### Settings modal (`huddle/overlays.jsx:SettingsModal`)
- 760×540 modal, sidebar (200px, bg-0) + content. `huddle-pop` animation.
- Tabs: **Integrations**, **Profile**, **Notifications**, **Appearance** [NEW for prod — see Phase 5].
- Header: tab title + close X.
- **Integrations tab**: privacy disclaimer + cards. Each card = icon tile + name + CONNECTED badge (mono, online color, color-mixed bg) + description + mono meta (server URL / token type / model name) + Manage/Connect button (solid if on, primary if not). Currently: Jira, GitHub, AI assistant, Giphy.

### Sign-in (`huddle/overlays.jsx:SignIn`) [reskin]
- Full-screen, z-300.
- **Left brand panel** (`flex: 1`): bg-1 + radial gradient with accent-dim. Top: HuddleMark + "Huddle" (800, 22px, tight letter-spacing). Middle: 40px headline + paragraph. Bottom: 3 feature pills with icons (WebRTC calls, Live whiteboard, AI built in).
- **Right form panel** (460px): email step or 6-digit OTP step.
  - Email step: "Sign in" (26px 800), hint, "Work email" label, input, primary "Continue with email" button (full-width h46).
  - OTP step: "Enter your code", "Sent to <email>", **6 separate digit inputs** [NEW — replaces single OTP field] (56×64 each, mono 26px, accent border on filled), backbutton.
  - Auto-submits when all 6 digits entered.

### Whiteboard (`huddle/whiteboard.jsx`)
- **Header**: board icon + "Whiteboard" + mono channel ref + spacer + collaborator avatar stack + "3 editing" label + divider + zoom-out + mono "100%" + zoom-in + "Export" solid button.
- **Canvas**: bg-0 w/ **radial-dot grid** background (26px spacing).
- **Tool palette** (LEFT vertical, NOT bottom-center like call): 8 tools = cursor / pen / arrow / rect / ellipse / **diamond** [NEW shape] / **text** [NEW shape] / eraser. Divider. 4-color swatches in 2×2 grid. Divider. Undo + Clear.
- **Collaborator cursor**: stylized cursor + name label (live-tinted), shows live presence of other editors.

### Calendar (`huddle/calendar.jsx`)
- **Header**: calendar icon + "May 2026" (700, 17px) + prev/next IconBtns + "Today" solid + spacer + **legend** (color swatch + capitalized name for each `CAL_COLORS` key: team, design, huddle, personal) + divider + primary "New event".
- **Day-of-week headers**: 7 cols + 58px gutter. Today (Thu) = accent label + accent fill on the date number circle.
- **Grid**: hour gutter (8am–6pm, 56px/hour, mono labels) + 7 day columns w/ borders.
- **Events**: positioned absolute by `(start - 8) * 56`, color from `CAL_COLORS`, **live event** [NEW visual] = live-dim background + pulsing red dot + live border.
- **Now-line** [NEW]: 2px accent line + 10px accent dot on today's column.

### Data shape & mock content (`huddle/data.jsx`)
For reference, the design ships mock `USERS`, `CHANNELS`, `DMS`, `MESSAGES`, `TRANSCRIPT`, `CAL_EVENTS`, `CAL_COLORS`. Live app gets these from Supabase. Mocks only matter as illustrative content; production wiring stays as-is.

### Bundle features NOT in scope for this overhaul
- `Huddle Calendar.html` — mobile calendar prototype. Lives in `/mobile/` (separate React Native app); explicitly out of scope.
- `Huddle Concentric Arcs.html` — logo exploration. Already settled; the live `index.html` mark approximates it.
- The mockup-only `REACTION_GLYPHS` (custom SVG reactions). Live app keeps real emoji reactions per README + the comment in `data.jsx`. **Decision**: only restyle the chip; do not swap reaction glyphs.

## Decisions (Nick to confirm)

1. **No React rewrite.** Reskin in place.
2. **No backend logic touched** — only render code + CSS + new shells.
3. **Tweaks panel → Settings → Appearance** (folded, not floating).
4. **Calendar promotes to nav rail** (replaces whatever surfaces it today).
5. **⌘K opens the new command palette** (likely a global handler that didn't exist).
6. **No emoji icons** anywhere in UI chrome. Reactions stay as emoji (user content).
7. **Sign-in stays email-OTP + password** (live app has both; design only shows email-OTP). Keep password path; restyle to match.
8. **`[data-ui="v2"]` flag** on `<html>` gates the new theme/shell until Phase 6 flip.
9. **New features explicitly in scope**: Saved-messages inbox row, Mentions & reactions inbox row, Raise-hand call control, persistent CallDock, custom titlebar w/ ⌘K pill, dedicated AI panel, ⌘K palette, suggestion chips, AI-reply quick actions, Mobile + LiveKit call indicators, workspace switcher chevron, model badge in AI header.
10. **Whiteboard new shapes** (diamond, text): wire to existing `infinite-canvas.js` if the engine supports them; otherwise scope text-tool to a follow-up ticket.
11. **Per-phase PRs**, not a mega-PR.

## Phases

### Phase 1 — Foundation: tokens, fonts, icons, brand mark, animations
**Estimate**: 1 session
**Status**: Pending

#### Tasks
- [ ] In `index.html`: add `<link>` for Hanken Grotesk + JetBrains Mono. Confirm CSP meta tag allows `fonts.googleapis.com` (style-src) + `fonts.gstatic.com` (font-src — likely needs adding).
- [ ] In `styles.css`: add `[data-ui="v2"] :root { ... }` token block (full table above).
- [ ] In `styles.css`: add `@keyframes huddle-spin / huddle-pulse / huddle-fade-up / huddle-pop / huddle-live-ring` — transform-only entrance (per the bundle's fix-noted bug).
- [ ] Extend `renderer/icons.js`: import all 51 paths from `huddle/icons.jsx` (single source-of-truth file pattern unchanged).
- [ ] Update `HuddleMark` SVG in `index.html` to match `huddle/icons.jsx:HuddleMark` geometry (taller arcs, accent-dot at `cy=124`).
- [ ] Grep audit: list every emoji-as-icon in `renderer/**/*.{js,html,css}` and propose replacements. **Show Nick the list before bulk replace.**
- [ ] Toggle `<html data-ui="v2">` ON behind a query param (`?ui=v2`) so we can sanity-check the new tokens without flipping the default.

#### Files to Modify
`renderer/index.html`, `renderer/styles.css`, `renderer/icons.js`, `main.js` (if CSP needs an update).

#### Manual verification
- [ ] `npm start` → app boots, default UI unchanged.
- [ ] Launch with `?ui=v2` → fonts swap, palette warm-charcoal, no layout breakage.
- [ ] No console / CSP errors.
- [ ] HuddleMark renders identically in legacy + v2.

**Gate**: zero regressions w/ flag off; v2-on loads cleanly.

---

### Phase 2 — App shell: custom titlebar, NavRail, Contextual panel, view router, sign-in
**Estimate**: 1–2 sessions
**Status**: Pending

#### Tasks
- [ ] **Custom titlebar** [NEW]: in `main.js` set `frame: false` + `titleBarStyle: 'hiddenInset'` (mac) / `titleBarOverlay` (win). Add `.huddle-titlebar` to `index.html` w/ `-webkit-app-region: drag` (and `no-drag` on the ⌘K pill + traffic lights). Renders centered workspace label + ⌘K pill (mono, w/ `⌘K` glyph).
- [ ] **NavRail** [NEW]: 68px column; 5 items (chat/call/whiteboard/calendar/ai), settings IconBtn at bottom, Avatar at very bottom. Active state w/ accent-dim bg + 3px left bar. `live` dot on call icon when call active. Tooltips via custom `Tooltip` style.
- [ ] **Contextual panel**: workspace header w/ chevron switcher + new-message IconBtn; quick rows (Saved, Mentions & reactions, Calendar); Sections (Channels, DMs, Team) wired to existing `api.js` data.
- [ ] **View router**: extract from current `app.js` (locate the show/hide-pane code) and rewrite to set `data-view` on `<body>` so CSS controls which view mounts.
- [ ] **Sign-in reskin**: replace `#login` shell with the design's 2-column layout. Left = brand panel w/ HuddleMark + headline + feature pills. Right = form. **OTP step uses 6 separate digit inputs** [NEW] with auto-advance + auto-submit. Keep the existing password-fallback flow (hidden until "Use a password instead" link); restyle.
- [ ] **Workspace switcher** [NEW]: chevron next to workspace name in panel header → simple dropdown of teams the user is a member of (from existing team picker code).
- [ ] **Saved + Mentions inbox** [NEW]: stub views that mount when their quick row is clicked. Phase 6 adds the real query; Phase 2 just routes.

#### Files to Modify
`renderer/index.html`, `renderer/styles.css`, `renderer/app.js`, `main.js`.

#### Manual verification
- [ ] Sign-in renders in the new 2-column layout; 6-digit auto-submit works end-to-end against Supabase.
- [ ] After sign-in: rail + panel + content; channel/DM rows wired to live data.
- [ ] Click each rail item → view switches; only Chat shows the panel.
- [ ] Window can be moved by dragging titlebar on Mac; traffic lights line up.
- [ ] Workspace chevron lists teams; selecting one switches data.

**Gate**: live auth + channel data still load; no regression on team picker.

---

### Phase 3 — Chat surface (deep reskin + threading + slash menu)
**Estimate**: 1–2 sessions
**Status**: Pending

#### Tasks
- [ ] **ChatHeader**: channel icon + name + topic + member-avatar stack + IconBtns (Whiteboard, Threads, Pin) + divider + primary "Start call" / live "Join call".
- [ ] **DayDivider**: thin lines + mono uppercase pill.
- [ ] **MessageRow**: avatar 38px + meta (name + role + mono time), `renderText` body, quote block (if present), inline attachment, **JiraUnfurl** card, **GithubUnfurl** card, reactions row, **thread-continuation pill**, hover toolbar (React, Reply in thread, Save, Pin, More).
- [ ] **AICard** inline in chat: outlined accent card, prompt header + body + "via @user · claude-opus-4" footer.
- [ ] **Composer**: textarea + bottom toolbar (paperclip / GIF / smile / sparkles "Ask AI" / hint / Send). Style per spec.
- [ ] **Slash-command popup** [NEW or restyle, depends on current state]: appears when input starts with `/`. Lists `/ai`, `/summarize`, `/huddle`, `/jira`, `/gh` with mono command + icon + description. Arrow + Enter selects. Verify all 5 commands route to the existing handlers in `chat.js`.
- [ ] **ThreadPanel** (right side, 380px): parent + replies + reply composer (per spec).
- [ ] **Save** [NEW per-message action]: hover toolbar bookmark icon adds the message to the Saved inbox. Backing store: new column or JSONB key in `user_integrations.settings.saved_messages` (an array of `{channel_id, message_id, ts}`). RLS already covers it. Surface in the Saved quick-row view (Phase 6 lists them).
- [ ] **Pin** [verify existence]: if not in prod, add behind a simple `pinned_messages` table or `channels.settings` JSONB. Defer to Phase 6 if non-trivial.
- [ ] Confirm reactions render as styled chips wrapping existing emoji (no glyph swap).

#### Files to Modify
`renderer/chat.js` (render only), `renderer/styles.css`, possibly `renderer/api.js` (Save endpoint).

#### Manual verification
- [ ] Open a channel with one of each message kind. Eyeball vs `huddle/chat.jsx`.
- [ ] Hover a message → toolbar appears; Save → toast confirms; bookmark visible in Saved view (stub OK till Phase 6).
- [ ] `/ai foo` posts user msg + AI reply card.
- [ ] `/jira HUD-1` unfurls.
- [ ] `/summarize` renders an AI summary card.
- [ ] `/huddle` starts a call.
- [ ] Thread → right panel opens; reply works.

**Gate**: all existing chat features (edit/delete/upload/GIF/search/mentions/reactions) still work.

---

### Phase 4 — Call surface + persistent CallDock + live transcript + LiveKit/Mobile indicators
**Estimate**: 1–2 sessions
**Status**: Pending

#### Tasks
- [ ] **Call header**: LIVE pill, channel ref, mono "N people · MM:SS", **LiveKit pill** [NEW UI element], "Open whiteboard" + "Create ticket" solid buttons, Layout + Fullscreen IconBtns.
- [ ] **Layout switcher** [NEW]: grid icon in header toggles share-stage layout vs grid layout (4 tiles). Persist last choice per call.
- [ ] **Fullscreen** [NEW]: expand icon in header maximizes the Electron window.
- [ ] **VideoTile** restyle: user-hue radial gradient when cam on, scan-line overlay, mute pill, **speaking 3-bar indicator** [NEW], **Mobile pip** [NEW] when peer joined via mobile (read from existing `livekit.js` participant metadata).
- [ ] **ScreenShareStage**: screen-share content (existing) + top-left speaker pill ("X's screen") + drawing canvas overlay + **drawing toolbar bottom-center** (6 tools + 5 colors + undo + clear).
- [ ] **Live transcript panel** (296px right): header w/ icon + title + summarize IconBtn + close X; speaker rows w/ avatar + name + mono time + indented text; still-talking 3-dot indicator; **footer "/summarize" full-width ghost button** [NEW]. Wire to existing `transcript.js` STT stream.
- [ ] **Control bar**: Mute, Camera, Share, Captions, **Raise hand** [NEW: emits a Supabase Realtime broadcast event on the team channel; receivers show a hand icon on the tile for 4s], Board, divider, wide danger Leave.
- [ ] **CallDock** [NEW]: persistent thin bar at top of content area when `callActive && view !== 'call'`. Shows live dot, "Call in #channel", mono timer, member avatars, mute/cam quick toggles, "Return to call" live button, "Leave" danger button. Render in `app.js` shell.
- [ ] **Create ticket** button [verify existence]: opens the existing mid-call Jira modal.

#### Files to Modify
`renderer/app.js`, `renderer/livekit.js` (read participant metadata, emit raise-hand event), `renderer/styles.css`, `renderer/transcript.js` (no logic change — just confirm render hook).

#### Manual verification
- [ ] Start a call from chat header → grid + tile styles match design.
- [ ] Toggle layout → switches to grid.
- [ ] Navigate to Whiteboard while call is active → **CallDock** appears.
- [ ] "Return to call" / "Leave" both work from dock.
- [ ] Second peer on mobile → mobile pip + LiveKit pill still shows.
- [ ] Captions on → transcript panel populates from STT; /summarize footer works.
- [ ] Raise hand → other peers see indicator briefly.

**Gate**: call audio/video/share/drawing/whiteboard-from-call/Jira-mid-call all still work.

---

### Phase 5 — Huddle AI panel + ⌘K command palette
**Estimate**: 1 session
**Status**: Pending

#### Tasks
- [ ] **`renderer/ai-panel.js`** [NEW file]: render a dedicated `view === 'ai'` surface.
  - Header w/ AI avatar, title, subtitle, model badge.
  - Centered 760px column transcript. Each turn = avatar + name + `renderText` body.
  - **AI-reply quick actions** [NEW]: when latest message is from AI, show "File ticket" + "Post to channel" buttons. Wire to existing `ai-tools.js` (Jira create) + chat-post.
  - **Suggestion chips** [NEW]: 3 pre-canned prompts above composer. Curated based on context: today's channel name, current view.
  - Composer w/ sparkles icon + Send button.
  - Source AI provider config from `user_integrations.settings.ai` (existing).
- [ ] **`renderer/command-palette.js`** [NEW file]: global ⌘K handler.
  - Modal w/ search input + grouped results (Go to / Channels / People / Actions).
  - First-row pre-highlight, arrow navigation, Enter to select, ESC to close.
  - Channel search hits `CHANNELS` from `api.js`; people from team members; actions are static + hint mono-formatted to the corresponding slash command.
  - Wire titlebar ⌘K pill to open the palette.
- [ ] **Settings → Appearance** tab [NEW]: density radio (compact/comfortable) + 5-swatch accent picker. Persist to `user_integrations.settings.appearance`. Mount on app start.

#### Files to Modify
`renderer/ai-panel.js` (new), `renderer/command-palette.js` (new), `renderer/app.js` (register both, wire ⌘K listener), `renderer/index.html` (script includes), `renderer/api.js` (`getAppearance`/`setAppearance`).

#### Manual verification
- [ ] ⌘K (and ⌘K pill click) opens palette; typing filters; Enter navigates; ESC closes.
- [ ] Open Huddle AI from rail → conversation against existing provider works.
- [ ] AI reply → "File ticket" creates a Jira ticket; "Post to channel" posts the AI reply to the active channel.
- [ ] Suggestion chip click → fills composer.
- [ ] Settings → Appearance → density toggle shrinks rows; accent picker recolors. Reload → persists.

**Gate**: ⌘K works globally, AI panel doesn't break inline `/ai` slash command.

---

### Phase 6 — Whiteboard / Calendar reskin + Saved & Mentions inboxes + flip flag + cleanup
**Estimate**: 1–2 sessions
**Status**: Pending

#### Tasks
- [ ] **Whiteboard reskin**: header (board icon, name, channel ref, collaborator stack + "N editing", zoom controls, Export). Canvas radial-dot grid background. **Tool palette LEFT vertical** w/ 8 tools (cursor, pen, arrow, rect, ellipse, **diamond** [NEW], **text** [NEW], eraser) + 4-color swatch grid + undo + clear. Wire diamond + text to `infinite-canvas.js` (check if engine supports them; if not, scope as follow-up).
- [ ] **Collaborator cursor** [NEW]: render presence cursors for other editors on the same whiteboard (using existing whiteboard.js Realtime channel + adding cursor-position broadcast).
- [ ] **Calendar reskin**: header (icon, month/year, prev/next, "Today", color legend, "New event"). Day-of-week headers w/ today highlight on date circle. Hour gutter + 7-day grid. Event positioning + colored borders. **Live event** [NEW visual] w/ pulsing dot. **Now-line** [NEW] on today.
- [ ] **Saved messages inbox** [NEW view]: query `user_integrations.settings.saved_messages`, render as a chat-style list w/ "Unsave" hover action.
- [ ] **Mentions & reactions inbox** [NEW view]: query messages where `text` contains `@<me>` or where `reactions` JSONB includes me. Read-only list view w/ "Go to channel" hover action.
- [ ] **Flip `data-ui="v2"` default ON** in `index.html`.
- [ ] **Delete legacy CSS blocks** that v2 supersedes (only after a screenshot sweep confirms no surface still uses legacy classes).
- [ ] **`/self-review` gate** — required before any build per `~/.claude/CLAUDE.md`.
- [ ] **Bump `package.json` to 0.24.0**; tag `v0.24.0` to trigger release workflow.
- [ ] **Update README screenshots** OR add a follow-up note that screenshots are stale.

#### Files to Modify
`renderer/whiteboard.js`, `renderer/infinite-canvas.js`, `renderer/calendar.js`, `renderer/chat.js` (saved + mentions inboxes), `renderer/api.js` (saved/mentions queries), `renderer/index.html` (flip flag), `renderer/styles.css` (delete legacy), `README.md`, `package.json`.

#### Manual verification
- [ ] Cold boot → v2 default on, no legacy flash.
- [ ] Golden path: sign-in → team → chat (all message kinds) → thread → start call → screen-share → draw → call dock when nav away → whiteboard (new tools) → calendar (new event line) → AI panel → ⌘K → settings tabs → Saved → Mentions.
- [ ] `/self-review` sentinel exists at HEAD before `npm run dist`.

**Gate**: self-review sentinel present + zero console errors + emoji-icon grep returns 0 UI hits.

---

## Patterns to Follow

- **Vanilla JS only** — no React.
- **CSP-safe**: scripts stay `'self'`; fonts go through `font-src` allowance for `fonts.gstatic.com` (or self-host WOFF2 if CSP is messy).
- **IPC fetch proxy** stays the path for third-party calls; new AI quick actions reuse the existing `ai.js` plumbing.
- **Per-user prefs in `user_integrations.settings`** (JSONB, RLS-gated). New keys: `appearance` (density + accent hue), `saved_messages` (array). No env vars, no localStorage.
- **One PR per phase**, draft by default, per `CLAUDE.md`.

## External Resources

- Bundle: `/tmp/huddle-bundle/huddle-logo/` (re-read per phase).
- Hanken Grotesk: https://fonts.google.com/specimen/Hanken+Grotesk
- JetBrains Mono: https://fonts.google.com/specimen/JetBrains+Mono
- OKLCH reference: https://oklch.com/
- Electron custom titlebar: https://www.electronjs.org/docs/latest/tutorial/custom-window-controls

## Risks & Considerations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Custom titlebar breaks drag on Win/Linux | Medium | `-webkit-app-region: drag` w/ `no-drag` on controls; ship Mac-first if Win/Linux unstable. |
| 6-digit OTP UX changes Supabase verifyOtp call shape | Low | The 6 inputs just produce a concatenated string; existing `verifyOtp` call unchanged. |
| Whiteboard text-tool requires infinite-canvas.js engine work | Medium | Audit before Phase 6; if non-trivial, ship Phase 6 without text tool and open a follow-up ticket. |
| Saved + Mentions inboxes require schema work | Low–medium | Saved uses JSONB (no migration). Mentions inbox can be a client-side filter over recent messages (slow if huge — confirm acceptable). |
| Raise-hand event needs new Realtime broadcast name | Low | Add `hand:<uid>` broadcast topic on the team channel; transient, no Postgres write. |
| Power-users miss sidebar on non-chat views | Medium | Panel collapses on call/whiteboard/calendar/ai; cmd-K covers cross-view nav. |
| Emoji-icon audit misses one and ships in v2 | Medium | Phase 1 grep audit + Phase 6 golden-path sweep. |
| 220 KB `app.js` mixes render + state | Medium | Enforce "render functions only" per phase; if a function intermixes, leave state code alone. |
| Bundle is 5 days newer than `main` | Low | Rebase each phase PR. |

### Why this plan could fail
- Custom titlebar is the single riskiest piece — easy to misconfigure across platforms.
- Whiteboard `text` tool is non-trivial; might slip Phase 6.
- 220 KB of `app.js` may have implicit DOM dependencies the reskin overlooks.

### Why this plan could work
- Bundle README explicitly permits in-place reskin.
- Backend is fully decoupled — no Supabase/LiveKit code touched.
- The `[data-ui="v2"]` flag means we can land Phase 1 today with zero user-visible risk.
- Per-user `appearance` settings + JSONB `saved_messages` avoid migrations.

## Open Questions (need answers before Phase 1)

1. **Custom titlebar scope** — Mac-only this iteration, or all 3 platforms? (Risk + LOE matters.)
2. **Saved + Mentions inboxes** — ship in Phase 6, or split to a Phase 7? (Plan assumes Phase 6.)
3. **Whiteboard text tool** — keep in scope, or defer to a follow-up ticket if `infinite-canvas.js` needs engine changes?
4. **Workspace switcher** — wire to existing team picker, or is multi-workspace not a feature today?
5. **Raise-hand persistence** — transient broadcast (proposed) or persist a brief "hand raised at <ts>" record?
6. **PR strategy** — per-phase (proposed) vs. fewer larger PRs?
7. **Emoji-icon audit** — review the grep list before bulk-replace (proposed) or trust-and-replace?

---

## Files this plan would create or modify (when approved)

(None modified yet. This is a v2 draft.)

**Will create:**
- `renderer/ai-panel.js` (Phase 5)
- `renderer/command-palette.js` (Phase 5)
- `renderer/fonts/` (only if CSP forces self-hosting — Phase 1)

**Will modify:**
- `renderer/index.html` (Phases 1, 2, 5, 6)
- `renderer/styles.css` (every phase)
- `renderer/icons.js` (Phase 1)
- `renderer/app.js` (Phases 2, 4, 5)
- `renderer/chat.js` (Phase 3, 6)
- `renderer/livekit.js` (Phase 4)
- `renderer/transcript.js` (Phase 4)
- `renderer/whiteboard.js` (Phase 6)
- `renderer/infinite-canvas.js` (Phase 6, if text-tool stays in scope)
- `renderer/calendar.js` (Phase 6)
- `renderer/api.js` (Phase 3, 5, 6)
- `main.js` (Phase 1 if CSP, Phase 2 for titlebar config)
- `package.json` (Phase 6 — version bump)
- `README.md` (Phase 6)

**Database tables**: none modified. `public.user_integrations.settings` JSONB gains 2 new keys (`appearance`, `saved_messages`). No migration.

**Realtime broadcast topics**: 1 new transient — `hand:<uid>` on team channel.
