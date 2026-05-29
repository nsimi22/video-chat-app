---
title: UI v2 — outstanding design items
status: open
created: 2026-05-28
related: ui-overhaul-v2_2026-05-28.md
tags: [ui, design-system, follow-up]
---

# UI v2 — outstanding design items

Inventoried against `huddle/*.jsx` in the Claude Design bundle after PRs #177 + #178 (v0.24.0) landed v2 as the default. These are the gaps between what shipped and what the design specifies.

Each item lists: **what the design has**, **what shipped**, **rough effort**, and **where the work would touch**.

---

## 1. Deferred — needs Nick's input first

### 1.1 Custom titlebar
**Design**: `huddle/app.jsx` — a 36px-tall custom titlebar with macOS traffic-light buttons left, centered workspace label (`Huddle — sunpowerai`), and a `⌘K` search pill on the right. `background: var(--bg-0)`, soft `--line-soft` border.
**Shipped**: native OS titlebar (Electron default frame).
**Effort**: Medium. Touches `main.js` (`frame: false`, `titleBarStyle: 'hiddenInset'` on Mac; `titleBarOverlay` on Win) + new HTML/CSS shell + `-webkit-app-region: drag` / `no-drag` setup.
**Decision needed**: Mac-only this iteration vs. all three platforms? Cross-platform titlebars are notoriously fragile on Linux.
**Files**: `main.js`, `renderer/index.html`, `renderer/styles.css`.

### 1.2 Calendar grid — full design fidelity (event categories)
**Design**: `huddle/calendar.jsx` — 4-way event color coding via `CAL_COLORS = { team: --accent, design: --live, huddle: --online, personal: --away }`. Each event carries a `cal` category.
**Shipped**: 2-way coding only (huddle events green, ICS events amber). The legacy data layer (`HuddleCalendar`) doesn't distinguish team / design / personal.
**Effort**: Medium-large. Schema work — either add a category enum to scheduled_calls or derive from channel mapping; expose in `listEvents()`; update `calendar-grid.js` color resolver.
**Files**: `supabase/migrations/*.sql`, `renderer/calendar.js`, `renderer/calendar-grid.js`.

---

## 2. Visible polish — small additive

### 2.0 NavRail Calls icon — pulsing live dot during call
**Design**: `NavRail` item `{ id: "call", icon: "video", label: "Calls", live: callActive }`. When `live: true`, an 8×8 pulsing live-color dot renders top-right of the rail item (per `app.jsx` `it.live` branch).
**Shipped**: rail item has no live dot.
**Effort**: Trivial. Sync from `body.huddle-in-call`; CSS pseudo or a static `<span>` toggled by the existing call-dock observer.
**Files**: `renderer/ui-v2-shell.js`, `renderer/styles.css`.

### 2.1 3-bar speaking indicator on tiles
**Design**: 3 animated vertical bars at top-right of a speaking tile (in addition to the outline ring + halo).
**Shipped**: outline ring + halo only.
**Effort**: Small. CSS-only with a tiny inline-SVG or 3 spans + staggered animation.
**Files**: `renderer/styles.css`, possibly markup hook in `app.js` for the tile.

### 2.2 Layout switcher in call header (grid ↔ stage)
**Design**: `IconBtn` with `grid` icon to toggle between screen-share-stage and grid layouts.
**Shipped**: No layout switcher — legacy auto-arranges based on share state.
**Effort**: Small-medium. CSS plus a JS toggle that forces grid even when a share is active.
**Files**: `renderer/app.js`, `renderer/styles.css`, `renderer/index.html`.

### 2.3 Fullscreen toggle in call header
**Design**: `expand` `IconBtn` for window-level fullscreen.
**Shipped**: Per-tile fullscreen exists; no window-level toggle.
**Effort**: Small. Wire to `BrowserWindow.setFullScreen()` via IPC.
**Files**: `main.js` (IPC handler), `preload.js`, `renderer/app.js`, `renderer/index.html`.

### 2.4 Mobile pip on tiles
**Design**: When a peer joined from the mobile app, a `📱 Mobile` pip renders bottom-right of their video tile (separate from the mute/name pill bottom-left).
**Shipped**: nothing — peer metadata isn't surfaced to the tile render path.
**Effort**: Small. Read LiveKit participant metadata; toggle a `data-platform="mobile"` attribute on the tile; CSS pseudo for the pip.
**Files**: `renderer/livekit.js`, `renderer/app.js`, `renderer/styles.css`.

### 2.5 User-hue radial gradient + scan-line on cam-off tiles
**Design**: When cam is off, tile background = `radial-gradient(120% 120% at 30% 20%, oklch(0.4 0.07 ${u.hue}), oklch(0.22 0.04 ${u.hue}))` plus a 3px scan-line repeating-linear-gradient overlay. Adds visual texture / depth.
**Shipped**: avatar centered on a flat `--bg-1` background.
**Effort**: Small. Needs per-user hue (could hash userId → hue). CSS-only.
**Files**: `renderer/app.js` (set `--tile-hue` on tile via inline style), `renderer/styles.css`.

### 2.6 Member-avatar stack in chat header
**Design**: `ChatHeader` shows the channel's member avatars with `+N` overflow chip.
**Shipped**: no member surface in the chat header.
**Effort**: Small-medium. Render avatars from existing `state.huddle.team.members`; CSS for the overlapping stack.
**Files**: `renderer/app.js`, `renderer/index.html`, `renderer/styles.css`.

### 2.7 Screen-share active-window context text
**Design**: top-left pill on a screen tile reads `Lando's screen · Figma — Huddle redesign` (the active window title, mono, `--tx-lo`).
**Shipped**: top-left pill with screen icon + `Window — Nick` (current label, no context).
**Effort**: Small. Use existing `desktopCapturer.getSources()` `name` field which already carries the window title; render after the · separator in mono.
**Files**: `renderer/app.js` (tile label render), `renderer/styles.css`.

### 2.8 Settings → Appearance tab (density + accent picker)
**Design**: dev-only Tweaks panel from the prototype folds into a production Settings tab. Density (`compact` / `comfortable`) updates `--row-py / --msg-gap / --ui`; accent updates `--accent-h`.
**Shipped**: tokens are var-driven but no UI to flip them; legacy uses defaults forever.
**Effort**: Small. New tab in the existing settings modal; persist to `user_integrations.settings.appearance`; on load, apply via `:root` style.
**Files**: `renderer/index.html`, `renderer/styles.css`, `renderer/app.js`, `renderer/api.js` (storage).

### 2.9 Settings modal — 2-column tabbed layout
**Design**: `SettingsModal` is a 760×540 modal with a 200px left sidebar containing 4 tab buttons (**Integrations / Profile / Notifications / Appearance**) and a content pane on the right with its own header. Integrations content is fully designed; the other tabs are placeholder text in the spec ("{tab} settings").
**Shipped**: legacy single-page settings modal with accordion sections; v2 chrome polished (Phase 3.4), but **structure is still single-page**, not tabbed.
**Effort**: Medium. Restructure the modal HTML into a sidebar+content layout; move existing accordion sections into the 4 tabs (Integrations → Integrations tab; Profile + me → Profile tab; Notifications → Notifications tab; Appearance is new — see 2.8).
**Files**: `renderer/index.html`, `renderer/styles.css`, `renderer/app.js` (settings open/close + tab switching).

### 2.10 Bottom CallControl labels (icon-over-label widgets)
**Design**: `CallControl` widget = 48×48 icon button stacked with a `10.5px` `--tx-lo` label below (`Mute`, `Camera`, `Share`, `Captions`, `Raise`, `Board`). The `Leave` button is a wide variant (icon + label inline in a rounded pill).
**Shipped**: bottom call-dock has 48×48 icon-only buttons; **no labels under them**. Leave is wide but otherwise standard.
**Effort**: Small. Inject a label span next to each button at dock-construct time (`setupCallDock()` already enumerates the dock buttons); CSS to flex-column each. Labels need to be short ("Mute", "Camera", etc.) — legacy `title` attrs are verbose so map per-id.
**Files**: `renderer/ui-v2-shell.js`, `renderer/styles.css`.

### 2.11 Screen-share stage + side strip layout (when sharing)
**Design**: while a screen is shared, the stage splits into **screen on the left (flex 1)** + a **184px right strip of small camera tiles**. When not sharing, it falls back to a 2-column grid of cameras.
**Shipped**: legacy CSS grid (`repeat(auto-fit, minmax(320px, 1fr))`); screen tile uses `grid-column: span 2`. Visually it ends up approximating the design at most layouts but doesn't enforce the side-strip arrangement.
**Effort**: Medium. CSS flex layout (or grid template areas) on `.tiles` under v2 when there's a `.tile.screen` child — use `:has()` to switch layouts.
**Files**: `renderer/styles.css`.

### 2.12 DM rows — 2-avatar stack for group DMs
**Design**: `ChannelRow` for DMs shows `users.slice(0, 2)` rendered as 2 overlapping 20px avatars (with `marginLeft: -8` on the second) instead of a hash/lock icon.
**Shipped**: legacy DM rows use a single icon (Users SVG for group, single avatar for 1:1). Not the stacked-2 visual.
**Effort**: Small. Touch the legacy DM-row render in `app.js` to inject 2 stacked avatars when `users.length >= 2`; CSS for the stack offset.
**Files**: `renderer/app.js`, `renderer/styles.css`.

---

## 3. AI panel — feature detail

### 3.1 "File ticket" action button on AI replies
**Design**: `AIPanel` AI replies expose **two** quick-actions — `File ticket` (primary, ticket icon) + `Post to channel` (solid, link icon).
**Shipped**: only `Post to channel`.
**Effort**: Small. Wire to existing `/ai-ticket` slash-command path via `window.huddleApp.postIntoComposer('/ai-ticket ' + lastReply.text)` or call `state.ai` + Jira tool directly.
**Files**: `renderer/ai-panel.js`.

### 3.2 Inline AI message card structure (prompt header / body / footer)
**Design**: `AICard` in chat is a 3-section outlined card:
1. Top: sparkles icon + small prompt text (the user's `/ai foo`)
2. Middle: AI response body
3. Footer: `via <avatar> @user · claude-opus-4`

**Shipped**: single accent-bordered block via `[data-ui="v2"] .msg.msg-ai` — no separate prompt header / via footer.
**Effort**: Small-medium. Needs a markup change in `chat.js`'s AI-message render path (the existing inline AI render is a single bubble); add prompt + via metadata to the message data shape if missing.
**Files**: `renderer/chat.js`, `renderer/styles.css`.

### 3.3 Context-aware suggestion chips
**Design**: suggestions are crafted to the current channel + recent activity (`"Summarize today in #design"`, `"Draft a ticket for status states"`, `"Who's free for a call at 2pm?"`).
**Shipped**: three static-ish chips that swap in the current channel name. Two of the three are evergreen.
**Effort**: Small. Hook into recent message activity / recent Jira issues / open calls for one or two of the chips.
**Files**: `renderer/ai-panel.js`.

---

## 4. Inbox views

### 4.1 Mentions & reactions inbox
**Design**: quick row at the top of the contextual panel routes to a list view of every `@me` mention + reaction-on-my-message across the team.
**Shipped**: the sidebar Saved row exists; Mentions & reactions row was added to the panel header in v2 but currently has no destination.
**Effort**: Medium. New view (could mirror the Saved drawer structure), query + sort over `messages` table, mark-as-read state.
**Files**: `renderer/app.js`, `renderer/chat.js` (or new module), `renderer/styles.css`, `renderer/api.js` (query helper), possibly a `mentions_read_at` column.

### 4.2 Saved-messages view restyle
**Design**: rich saved-items list with body preview, channel/author meta, and a label-chip rail at the top.
**Shipped**: legacy saved drawer with v2 chrome polish (Phase 3.4 / 5.2). Functional but not at design's polish level — no body previews, no chip rail.
**Effort**: Small-medium. Mostly markup/CSS — query path already exists.
**Files**: `renderer/app.js` (drawer render), `renderer/styles.css`.

---

## 5. Lower priority / decorative

### 5.1 Tile mobile-mock outline overlay
**Design**: mobile-peer tiles get a subtle inner phone-frame outline (decorative cue).
**Shipped**: nothing.
**Effort**: Trivial CSS but depends on 2.4 (Mobile detection).
**Files**: `renderer/styles.css`.

### 5.2 Tweaks panel as floating dock
**Design**: prototype has a floating dev-only Tweaks dock for live token tuning.
**Shipped**: not built (folded into the proposed Settings → Appearance tab instead — see 2.8).
**Effort**: Dev-only — not for production. Skip unless useful for design QA.
**Files**: would be a new dev-only module.

---

## Suggested batching

If working through this list, sensible groupings:

- **Batch A (call polish, ~1 session)**: 2.0 (NavRail live dot), 2.1 (3-bar speaker), 2.4 (mobile pip), 2.5 (user-hue gradient), 2.7 (screen-share context), 2.10 (CallControl labels), 2.11 (screen-share side-strip layout). All call-surface, mostly CSS + tiny JS.
- **Batch B (chat / sidebar polish, ~1 session)**: 2.6 (member-avatar stack), 2.12 (DM 2-avatar stack), 3.2 (AI card structure), 3.3 (suggestion chips). All chat-surface.
- **Batch C (new features, ~2 sessions)**: 4.1 (Mentions inbox), 4.2 (Saved view), 2.8 (Settings → Appearance), 2.9 (Settings 2-column tabbed). Touches data + UI structure.
- **Batch D (platform / decision-blocked)**: 1.1 (custom titlebar), 1.2 (calendar categories), 2.2 (layout switcher), 2.3 (window fullscreen). Need either Nick's call or backend / IPC work.

## How to verify each item

Open the design bundle locally — `/tmp/huddle-bundle/huddle-logo/` (or re-fetch from `https://api.anthropic.com/v1/design/h/-U0jRprtzT6CZQKrQf8uAg`) — and diff visually against `npm start` on `main`. The `huddle/*.jsx` files are the source-of-truth specs for each surface.
