---
title: Huddle UI Overhaul — Apply Claude Design Bundle
status: draft-awaiting-approval
created: 2026-05-28
last_updated: 2026-05-28
feature: ui-overhaul
tags: [ui, design-system, electron, renderer, dark-theme]
current_phase: 0
total_phases: 6
---

# Huddle UI Overhaul — Apply Claude Design Bundle

> **Status**: Draft. Awaiting Nick's approval. Per org instructions (outline + wait before executing), nothing is changed in the renderer until this plan is approved.
>
> **Lifecycle**: Update phase status as work lands. When complete, archive via `/ce:compound`.

## Why this plan exists

Nick mocked a full Huddle redesign in Claude Design and exported a bundle (`/tmp/huddle-bundle/huddle-logo/`). The bundle README is explicit:

> "The design medium is HTML/CSS/JS — these are prototypes, not production code. Your job is to **recreate them pixel-perfectly** in whatever technology makes sense for the target codebase. Match the visual output; don't copy the prototype's internal structure unless it happens to fit."

So this is **not** a React rewrite. The live `renderer/` is vanilla HTML + a 220 KB `app.js` + 88 KB `styles.css` driving a fully working Electron + Supabase + WebRTC/LiveKit + AI app. We **reskin in place** and **add the few features the design implies that don't exist yet**.

## Skills Applied

None loaded yet — bundle README is the source of truth. Will load `update-config` if hooks/settings need tweaking; otherwise skill-free.

## Context

### What the live app already has (from `README.md` + `CLAUDE.md`)

- Slack-style chat: channels, DMs, threads, reactions, markdown, mentions, edit/delete, uploads (drag/paste), GIF picker, history pagination, search.
- WebRTC + LiveKit video calls; multi-screen share; live drawing on screen shares; per-channel infinite whiteboard with persistence.
- Live browser-STT call transcription; `/summarize`.
- Integrations: Jira (unfurl, `/jira`, ticket modal), GitHub (unfurl, `/gh`), AI assistant (`/ai`, `/ai-ticket`, `/summarize` — Claude or OpenRouter).
- Calendar view (`renderer/calendar.js`, 18 KB) + ICS sync (`renderer/ics.js`, 22 KB).
- Settings panel (gear in sidebar) for per-user API keys, stored in Supabase `user_integrations` with RLS.
- Email-OTP sign-in + team picker + profile step.

### What the design changes

Visually, **everything**:

| Token | Live (`renderer/styles.css`) | Design (`Huddle App.html` `:root`) |
|---|---|---|
| Background | near-black Slack clone | warm-charcoal layered: `oklch(0.165 0.004 70)` → `0.275 ...` |
| Accent | brand-blue (legacy) | indigo `oklch(0.70 0.145 250)` (default; tweakable hue) |
| Live/call state | (n/a as token) | cool teal `oklch(0.74 0.10 195)` + pulsing ring |
| Type | system stack | **Hanken Grotesk** (UI) + **JetBrains Mono** (metadata, timecodes) |
| Icons | mix of inline SVG + emoji | all real SVG strokes — **no emoji icons anywhere** |
| Radii | (mixed) | `--r-sm 7 / --r-md 11 / --r-lg 16 / --r-xl 22` |
| Layout primitive | single sidebar | **NavRail (68px)** + **Contextual panel (256px)** + content |
| Window chrome | OS default | custom 36px titlebar w/ traffic lights, centered workspace name, ⌘K search pill on right |

Layout-wise, the design adds:

- **NavRail** with 5 icons (Chat, Calls, Whiteboard, Calendar, Huddle AI), settings gear, and avatar dock-bottom.
- **Active state**: accent-dim background + a 3px accent bar on the left edge; live-call indicator dot when a call is in flight.
- **Persistent call dock** — when a call is active and the user navigates away from the Call view, a thin horizontal bar appears at the top of the main pane: live dot, channel name, mono timer, member avatars, mute/camera quick-toggles, "Return to call" button, "Leave" button.
- **Cmd-K command palette** triggered from the titlebar search pill or ⌘K.
- **Huddle AI** as a dedicated nav-rail destination (alongside the existing `/ai` slash command).
- **Tweaks panel** (design-only) — density + accent hue. We keep this as a Settings sub-pane for prod, not as a floating panel.
- **LiveKit/mobile teammate badge** — show a small "mobile" pip on a call tile when the peer joined from the mobile app, and a "via LiveKit" tag in the call header (the app already uses LiveKit per `package.json`).

### Mapping design files → existing renderer files

| Design (`/tmp/huddle-bundle/huddle-logo/project/`) | Lands in (live `renderer/`) |
|---|---|
| `Huddle App.html` `:root` tokens + `@keyframes` | `styles.css` (new `:root` block + animation set, behind a kill switch) |
| `huddle/icons.jsx` | `icons.js` (extend; replace emoji-as-icon usages elsewhere) |
| `huddle/ui.jsx` (Avatar, Btn, IconBtn, Tooltip, ReactionChip) | `styles.css` classes + small helpers in `app.js` |
| `huddle/app.jsx` (NavRail, ChatPanel, ChatHeader, CallDock, App shell) | New shell in `index.html` + new render code in `app.js` |
| `huddle/chat.jsx` | Reskin the existing `chat.js` rendering — same DOM structure, new classes |
| `huddle/call.jsx` | Reskin call grid + controls in `app.js`/`livekit.js` render paths |
| `huddle/whiteboard.jsx` | Reskin `whiteboard.js`/`infinite-canvas.js` toolbar + chrome |
| `huddle/calendar.jsx` | Reskin `calendar.js` |
| `huddle/overlays.jsx` (CommandPalette, ThreadPanel, AIPanel, SettingsModal, SignIn) | New modules: `command-palette.js`, `ai-panel.js`; reskin Settings + SignIn in `index.html` |

### Test infrastructure

- **Test command**: none. The repo has **no automated tests** — no `test` script in `package.json`, no `__tests__/`, no Jest/Vitest config.
- **CI**: `.github/workflows/release.yml` is build-only (Mac/Win/Linux installers). No test gate.
- **Implication**: every phase ships with **manual verification in `npm start`** — golden-path click-throughs on a real Electron window, plus a screenshot diff against the design HTML opened in a browser. I'll spell out the click path per phase.

## Decisions (proposed — Nick to confirm)

1. **No React rewrite.** Reskin in place. *Why:* bundle README says "match visual output, don't copy prototype structure"; live app is vanilla JS w/ 220 KB of working logic.
2. **No `livekit-client` / Supabase / WebRTC / Jira / GitHub logic touched.** Only render code + CSS + new shells. *Why:* zero risk to the existing call/chat backbone.
3. **Tweaks panel folds into Settings.** No floating prototype Tweaks dock in prod. *Why:* it's a design-prototype UX, not a product UX. Density + accent live under Settings → Appearance.
4. **Calendar stays where it is**, but graduates to the nav rail. *Why:* it already exists in `calendar.js`; design treats it as a first-class nav destination.
5. **Cmd-K opens the new command palette**, replacing whatever ⌘K does today (likely nothing global). *Why:* design's primary navigation pattern.
6. **"No emoji icons" is a hard rule.** Audit `chat.js`/`app.js`/`index.html` for emoji used as UI icons (🎨, 📎, 🔍, ⚙, 🎫, etc.) and replace with SVG from `icons.js`. *Why:* explicit user instruction in the design chat ("I do not want emojis as icons"); will land in memory.
7. **Sign-in keeps email-OTP + password** as today. The design's sign-in is visual-only (it explicitly drops SSO, which the live app also lacks). Just reskinned.
8. **One feature flag**, `HUDDLE_UI_V2`, on the `:root` element, lets us land Phase 1 (tokens) without breaking the live app until the flip. Off by default until Phase 6.

## Phases

### Phase 1: Design tokens + typography + icons (foundation, no UX shift)
**Estimate**: Single session
**Status**: Pending

#### Goal
Land the new color palette, fonts, radii, shadows, animation primitives, and the full SVG icon set **behind `[data-ui="v2"]`** so the live app is untouched until we flip it. Audit and replace every emoji-as-icon usage.

#### Tasks
- [ ] Add Hanken Grotesk + JetBrains Mono via `<link>` in `index.html` (matches the bundle; CSP `style-src 'self' 'unsafe-inline'` already permits Google Fonts CSS — verify CSP needs `font-src` allowance for `fonts.gstatic.com`).
- [ ] Add a `[data-ui="v2"]` scope block to `styles.css` with the design's `:root` token set (`--bg-0..3`, `--tx-hi..faint`, `--accent*`, `--live*`, `--r-*`, `--rail-w`, `--panel-w`, `--font`, `--mono`, `--sh-pop`, `--sh-card`, density vars).
- [ ] Port all `@keyframes` from the design (`huddle-spin`, `huddle-pulse`, `huddle-fade-up`, `huddle-pop`, `huddle-live-ring`). Use **transform-only** entrance animations (lesson from `chats/chat2.md`: `opacity:0` entrance keyframes painted invisible in throttled iframes).
- [ ] Extend `renderer/icons.js` with every icon used by `huddle/icons.jsx` (chat, video, board, calendar, sparkles, hash, lock, bookmark, at, plus, mic, phone, phoneOff, thread, pin, edit, settings, chevronDown, search, bell). Keep the existing icon API.
- [ ] Grep for emoji-as-icon uses across `renderer/**/*.{js,html,css}` and replace with `icons.js` calls. Surface a list to Nick before committing the replacements (one batch, not drip).

#### Files to Modify
- `renderer/index.html` — `<link>` for fonts; `<html data-ui="v2">` toggle (off by default until Phase 6).
- `renderer/styles.css` — new `[data-ui="v2"] :root { ... }` block; new keyframes scoped under v2.
- `renderer/icons.js` — extend icon set.
- Any file with emoji-as-icon (TBD list during Task 5).

#### Testing & Verification
**Approach**: Manual.

- [ ] `npm start` — app still renders identically (toggle is off). No console errors. No CSP violations for the new font URL.
- [ ] Temporarily set `<html data-ui="v2">` in DevTools → confirm the new CSS vars resolve and fonts swap, with no layout breakage in the existing shell.
- [ ] Open `/tmp/huddle-bundle/huddle-logo/project/Huddle App.html` in a browser side-by-side; eyeball the color tokens match.

**Gate**: App boots cleanly with v2 off. v2-on still loads.

---

### Phase 2: App shell — titlebar + NavRail + Contextual panel
**Estimate**: Single session
**Status**: Pending

#### Goal
Replace the current sidebar layout with the design's three-zone shell (custom titlebar, 68px NavRail, 256px Contextual panel, content area) when v2 is on. Existing routes still mount into the content area unchanged.

#### Tasks
- [ ] Add new shell DOM in `index.html`: `.huddle-titlebar`, `.huddle-rail`, `.huddle-context-panel`, `.huddle-content`.
- [ ] NavRail items: Chat, Calls, Whiteboard, Calendar, Huddle AI + Settings + Avatar (per `huddle/app.jsx:NavRail`). Selecting an item updates a `view` state in `app.js`. Active state = accent-dim bg + 3px left bar.
- [ ] Live indicator: small pulsing dot on Calls icon when a call is in flight.
- [ ] Contextual panel renders ONLY for `view === 'chat'` (per design). Other views span full content area.
- [ ] Wire the existing channel/DM/team list into the contextual panel UI from `huddle/app.jsx:ChatPanel`. Bookmark / Mentions & reactions / Calendar quick rows up top, then Channels / DMs / Team sections.
- [ ] Custom 36px titlebar w/ traffic lights, centered "Huddle — <team name>", and ⌘K search pill on right. Electron `frame: false` needs to be set in `main.js` — confirm or add (risk noted in **Risks**).

#### Files to Modify
- `renderer/index.html` — new shell scaffold.
- `renderer/styles.css` — `.huddle-rail`, `.huddle-context-panel`, `.huddle-titlebar` styles.
- `renderer/app.js` — view router; mount existing chat/call/whiteboard/calendar code into the new content zone.
- `main.js` — possibly `frame: false` + `titleBarStyle: 'hiddenInset'` for traffic lights to overlay (Mac); fall back to a non-traffic-light bar on Win/Linux.

#### Testing & Verification
**Approach**: Manual.

- [ ] Sign in → chat view appears with 3 columns (rail, panel, chat). Active channel highlighted with accent.
- [ ] Click each rail item → view switches; only Chat shows the contextual panel.
- [ ] Resize window — rail/panel widths constant; content area fluid. No overflow scrollbars except in the channel list.
- [ ] macOS: traffic lights line up with the titlebar; no double titlebar.
- [ ] Windows: window can still be moved (custom titlebar must have `-webkit-app-region: drag`).

**Gate**: All five rail destinations mount the existing view code without regressions.

---

### Phase 3: Reskin chat surface (header, messages, composer)
**Estimate**: Single session
**Status**: Pending

#### Goal
Apply the design to `chat.js` rendering — chat header, day dividers, message rows, reaction chips, threads, AI message cards, unfurls, composer with slash-command menu.

#### Tasks
- [ ] Chat header: channel icon + name + topic, member-avatar stack with "+N" badge, Whiteboard / Threads / Pinned icon buttons, vertical divider, primary "Start call" (or "Join call" when live).
- [ ] Message row: avatar, name + role + monospaced timestamp, reactions row, hover-only action toolbar (reply-in-thread, react, more).
- [ ] Day divider: thin line + centered "Today / Yesterday / Mon, May 26".
- [ ] AI message card: distinct outline (`var(--accent-dim)` border), sparkles icon, "via @nick" footer.
- [ ] Jira/GitHub unfurl cards: reskin to the design's compact card with status pills.
- [ ] Composer: rounded `--r-md`, attach + GIF + AI buttons, `/`-prefix dropdown menu (`/ai`, `/summarize`, `/huddle`, `/jira`, `/gh`, etc.) — wire to the existing slash-command handler in `chat.js`.
- [ ] Threads: right-side `ThreadPanel` matching `huddle/overlays.jsx:ThreadPanel`.

#### Files to Modify
- `renderer/chat.js` — render methods only; do not touch state/persistence/realtime logic.
- `renderer/styles.css` — `.msg-row`, `.msg-meta`, `.reaction-chip`, `.unfurl-card`, `.ai-msg`, `.composer`, `.slash-menu`.

#### Testing & Verification
**Approach**: Manual.

- [ ] Open a channel with mixed message types — text, code block, mention, attachment, GIF, AI reply, Jira unfurl, GitHub unfurl. All render in the new style.
- [ ] React → reaction chip animates in; second click removes.
- [ ] Type `/` → slash menu appears; arrow + Enter selects.
- [ ] Open a thread → right-panel slides in; close X hides it.
- [ ] Edit / delete a message; both still work.

**Gate**: All existing chat features work; visuals match `huddle/chat.jsx`.

---

### Phase 4: Reskin call view + persistent call dock + LiveKit/mobile badge
**Estimate**: Single session
**Status**: Pending

#### Goal
Apply the design to the in-call surface and add the new **persistent call dock**.

#### Tasks
- [ ] Call grid: tile background `var(--bg-2)`, rounded `--r-lg`, speaking-indicator ring (`huddle-live-ring`), name pill bottom-left, mute/cam icons bottom-right.
- [ ] Screen-share stage: dominant tile + side strip of camera tiles. Drawing toolbar floats top-center per design.
- [ ] Call controls: bottom bar with mic / camera / share / draw / transcript / `/summarize` / Jira-ticket / hangup. SVG icons only.
- [ ] Live transcript panel: collapsible right rail; mono font; speaker labels.
- [ ] **LiveKit/mobile badge**: when a peer's metadata indicates mobile join, render a "📱→ mobile" pip (icon, not emoji) on their tile. Add "via LiveKit" tag in call header.
- [ ] **Persistent call dock**: when `callActive && view !== 'call'`, render a thin bar above the content area: live dot, "Call in #channel-name", mono timer, member avatars, quick mute/cam, "Return to call" (live kind), "Leave" (danger).

#### Files to Modify
- `renderer/app.js` and/or `renderer/livekit.js` — call-grid render path.
- `renderer/styles.css` — `.call-tile`, `.call-controls`, `.call-dock`.
- New helper for the "mobile peer" indicator — read existing peer-metadata path in `livekit.js` to source the flag.

#### Testing & Verification
**Approach**: Manual (needs two Electron instances OR a second device on the same workspace).

- [ ] Start a call from chat header → grid renders in new style.
- [ ] Navigate to Whiteboard while call is active → **call dock** appears at top of content.
- [ ] Click "Return to call" → back in call view; dock disappears.
- [ ] Click "Leave" in dock → call ends from anywhere.
- [ ] Second peer joins from mobile app → mobile pip on their tile; LiveKit tag in header.

**Gate**: Call audio + video + screen-share + drawing still work; dock honors `callActive` correctly.

---

### Phase 5: Cmd-K command palette + Huddle AI panel
**Estimate**: Single session
**Status**: Pending

#### Goal
Ship the two design-implied features the live app doesn't have yet.

#### Tasks
- [ ] **Cmd-K command palette** (`renderer/command-palette.js`): full-text search across channels, DMs, members, recent messages; quick-actions ("Start call", "Open whiteboard", "Open AI", "Toggle compact density"). Keyboard nav (arrows + enter + esc). Wire to titlebar search pill.
- [ ] **Huddle AI panel** (`renderer/ai-panel.js`): dedicated view at `view === 'ai'`. Conversation list left, transcript right, composer at bottom. Reuses the existing `ai.js` Claude/OpenRouter routing and `ai-tools.js` Jira tools. Distinct from inline `/ai` (which keeps working in chat).
- [ ] Settings → Appearance sub-pane: density (compact/comfortable) + accent hue picker (5 swatches). Persist to `user_integrations.settings.appearance` (RLS-gated, per-user) so it follows the user across devices. *Why not localStorage*: CLAUDE.md says "no env vars or local-only state for new runtime settings — use `user_integrations`".

#### Files to Modify
- `renderer/command-palette.js` — new.
- `renderer/ai-panel.js` — new.
- `renderer/app.js` — register both; wire ⌘K listener at app-level.
- `renderer/index.html` — `<script src>` includes for the two new files.
- `renderer/api.js` — `getAppearance()` / `setAppearance()` on `user_integrations.settings.appearance`.
- `supabase/migrations/` — **no migration needed** (`settings` is JSONB, just a new key).

#### Testing & Verification
**Approach**: Manual.

- [ ] ⌘K opens palette; type a channel name → top result; Enter navigates. Esc closes.
- [ ] Open Huddle AI from rail → conversation works against the existing AI provider.
- [ ] Settings → Appearance → flip density to compact → message row shrinks; flip accent to Green → all accents recolor.
- [ ] Reload app → density + accent persist (loaded from Supabase).

**Gate**: All three new surfaces work without breaking existing AI/chat flows.

---

### Phase 6: Flip the feature flag + cleanup
**Estimate**: Half session
**Status**: Pending

#### Goal
Default `<html data-ui="v2">` to on, delete the legacy CSS path, ship.

#### Tasks
- [ ] Flip `data-ui` default to `"v2"` in `index.html`.
- [ ] Delete the legacy styling blocks in `styles.css` that v2 supersedes (only after a visual sweep confirms no v2 surface still leans on a legacy class).
- [ ] Update `README.md` screenshots section (note that screenshots are stale; flag a follow-up).
- [ ] Bump `package.json` version to `0.24.0` and tag (per CLAUDE.md release flow).
- [ ] Run `/self-review` per the user-level CLAUDE.md gate before any build.

#### Files to Modify
- `renderer/index.html` — flip default.
- `renderer/styles.css` — delete legacy.
- `README.md` — screenshot follow-up note.
- `package.json` — version bump.

#### Testing & Verification
**Approach**: Manual + `/self-review` gate.

- [ ] Cold boot from clean install → v2 UI is the default; no legacy classes flash before the swap.
- [ ] Run through the golden path: sign-in → pick team → chat → reply in thread → start call → screen-share → draw → open whiteboard from chat header → calendar → AI → settings.
- [ ] `/self-review` writes the sentinel; only then proceed to `eas`/`gh release`/etc. (per release-gate hook).

**Gate**: Self-review sentinel present at HEAD. No emoji-as-icon regressions. No console errors.

---

## Patterns to Follow

- **Vanilla JS over React**: live app is vanilla; don't introduce React for UI parity (bundle README permits this).
- **CSP-safe**: keep all scripts local (`'self'`), no external CDN script tags. Fonts are a CSS-only fetch — `font-src` may need to allow `fonts.gstatic.com` in the CSP meta tag.
- **IPC fetch proxy**: third-party calls (already true for AI/Jira/GH) go through `main.js`'s `fetch-proxy`; the new AI panel reuses the existing `ai.js` path — no new origin additions.
- **Per-user settings live in `user_integrations.settings`** (JSONB, RLS-gated). No env vars, no localStorage for prod state.
- **Branch + PR**: per CLAUDE.md — `git checkout -b ui-overhaul-phase-N`, push, draft PR via GitHub MCP. One PR per phase, not one mega-PR.

## External Resources

- **Bundle**: `/tmp/huddle-bundle/huddle-logo/` (README + chats + project source — read before each phase).
- **Hanken Grotesk**: https://fonts.google.com/specimen/Hanken+Grotesk
- **JetBrains Mono**: https://fonts.google.com/specimen/JetBrains+Mono
- **OKLCH color reference**: https://oklch.com/ — for any palette tweaks.
- **Electron custom titlebar**: https://www.electronjs.org/docs/latest/tutorial/custom-window-controls

## Risks & Considerations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Custom titlebar breaks window dragging on Win/Linux | Medium | `-webkit-app-region: drag` on the titlebar; test on a Windows VM if available, else ship Mac-first behind a per-platform branch. |
| CSP rejects Google Fonts | Low | Self-host the WOFF2 files in `renderer/fonts/` if the CSP fix proves messy. |
| Emoji-icon audit misses one and ships an emoji in v2 | Medium | Grep audit + screenshot review in Phase 6's golden-path sweep. |
| Persistent call dock conflicts with LiveKit re-render | Low | The dock is render-only; LiveKit state lives where it lives. Test by toggling views mid-call. |
| Density/accent toggle in Settings causes layout shift in active calls | Low | Use CSS variables only (no DOM re-mount); validated by the design prototype which does exactly this. |
| Scope creep — Nick asks for mobile in this overhaul | Real | `mobile/` is a separate React Native app per repo layout; explicitly out of scope for this plan. Flag and defer. |

### Why this plan could **fail**

- The design's NavRail + ContextPanel layout assumes chat is the only view with a sidebar. Existing power-users may rely on a persistent team picker / DM list — losing it on Call/Whiteboard/Calendar views could feel like a regression. *Mitigation*: Phase 2 should keep the panel collapsible-on-hover for non-chat views.
- 220 KB of `app.js` likely intermixes render + state; surgical reskin may bleed into refactor. *Mitigation*: enforce "render functions only" rule per phase; if a function does both, leave the state code untouched.
- The bundle is 5 days newer than the latest commit on `main`. There may be in-flight code Nick wrote between then and now that conflicts. *Mitigation*: rebase each phase PR on `main` before merging.

### Why this plan could **work**

- The bundle README is unusually explicit ("don't copy the prototype's internal structure"), so we have permission to reskin in place rather than rewrite.
- The live app already cleanly separates concerns (`chat.js`, `livekit.js`, `whiteboard.js`, `calendar.js`) — surface area for reskinning is well-scoped.
- The feature-flag-by-`data-ui` approach lets us land Phase 1 today with zero user-visible risk.
- No backend changes needed — all phases are renderer-only except a single JSONB key in `user_integrations.settings`.

## Open Questions (need answers before Phase 1)

1. **Calendar nav-rail item** — design promotes Calendar to a top-level destination. The live app has `calendar.js` but I haven't traced how it's surfaced today. Should the new rail entry replace whatever surfaces it now, or sit alongside? *Default if Nick doesn't answer*: replace.
2. **Tweaks panel placement** — design has a floating dock. Plan proposes folding into Settings → Appearance. OK to ship without the floating dock?
3. **Custom titlebar scope** — Mac-only this iteration, or all three platforms? Mac is straightforward; Win/Linux need more care.
4. **Phase-by-phase PRs** — one PR per phase, or one mega-PR at the end? Plan assumes per-phase, per the `pull requests are mandatory` rule in `CLAUDE.md`.
5. **Emoji-icon replacements** — review the grep list before committing, or trust the plan and replace in bulk? Plan assumes review-first.

---

## Files this plan would create or modify

(Listed per org rule — at end of task. None modified yet; this is a draft.)

**Will create (when approved):**
- `renderer/command-palette.js` (Phase 5)
- `renderer/ai-panel.js` (Phase 5)
- `renderer/fonts/` (only if CSP issue forces self-hosting — Phase 1)

**Will modify (when approved):**
- `renderer/index.html` (Phases 1, 2, 5, 6)
- `renderer/styles.css` (Phases 1, 2, 3, 4, 5, 6)
- `renderer/icons.js` (Phase 1)
- `renderer/app.js` (Phases 2, 4, 5)
- `renderer/chat.js` (Phase 3)
- `renderer/livekit.js` (Phase 4)
- `renderer/calendar.js` (Phase 3 reskin)
- `renderer/whiteboard.js` (Phase 3/4 reskin only — no logic changes)
- `renderer/api.js` (Phase 5 — new `getAppearance/setAppearance`)
- `main.js` (Phase 2 — custom titlebar)
- `package.json` (Phase 6 — version bump)
- `README.md` (Phase 6 — screenshot follow-up)

**Database tables touched**: none (uses existing `public.user_integrations.settings` JSONB; new key `appearance`, no migration).
