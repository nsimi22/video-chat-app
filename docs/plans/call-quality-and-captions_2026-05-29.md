---
title: Call quality + captions — outstanding work
status: open
created: 2026-05-29
tags: [call, captions, audio, livekit, transcription]
---

# Call quality + captions — outstanding work

Follow-up scope after the UI v2 overhaul (PRs #179–#186) shipped. Each item lists: **what's wrong**, **diagnosis approach**, **proposed fix**, **risk**, **rough effort**, and **files**.

---

## 1. Audio bug — only the first joiner is heard in 3+ person calls

### Symptom

In a call with 3 or more participants, only the first remote participant's audio plays. Subsequent joiners can be seen but not heard. Reported as: *"people can not hear other people other than the first person who joins the call."*

### Status

- **Diagnosed**: not yet — static reading of the LiveKit transport + tile commit path didn't surface the bug. Per-participant `MediaStream` cache and `commitStreamAsCamera` flow both look correct on inspection.
- **Need**: DevTools snapshot during an actual 3+ person call.

### Diagnostic snippet — paste in DevTools during a 3-person call

```js
const tiles = [...document.querySelectorAll('#tiles .tile')];
const room = window.huddleApp?.getHuddle?.()?.room || null;
console.table(tiles.map(t => {
  const v = t.querySelector('video');
  const s = v?.srcObject;
  return {
    key: t.dataset.key,
    kind: t.dataset.kind,
    audioTracks: s?.getAudioTracks?.()?.length || 0,
    videoTracks: s?.getVideoTracks?.()?.length || 0,
    paused: v?.paused,
    muted: v?.muted,
    volume: v?.volume,
    readyState: v?.readyState,
  };
}));
if (room) {
  console.log('--- LiveKit remote participants ---');
  for (const [id, p] of room.remoteParticipants.entries()) {
    const pubs = [...p.trackPublications.values()];
    console.log(id, 'pubs:', pubs.map(pub => ({
      source: pub.source,
      isSubscribed: pub.isSubscribed,
      track: !!pub.track,
      muted: pub.isMuted,
    })));
  }
}
```

### Diagnostic interpretation

| What the snippet shows | Diagnosis | Likely fix layer |
|---|---|---|
| Late joiners' tiles show `audioTracks: 0`, but their LK pubs show `isSubscribed: true` | Stream-wiring bug — track exists but didn't land in the tile's srcObject | `_onTrackSubscribed` / `commitStreamAsCamera` race |
| Tiles show `audioTracks: 1` but `paused: true` or `muted: true` | Browser playback / autoplay-policy issue | `makeTile` defaults + `autoplay: true` |
| Late joiners' LK pubs show `isSubscribed: false` | Subscription-side bug — LK isn't auto-subscribing to late audio | `room.connect` options (`autoSubscribe`) |

### Likely files

- `renderer/livekit.js` — `_onTrackSubscribed`, per-identity stream cache
- `renderer/app.js` — `onTrack`, `commitStreamAsCamera`, `makeTile`

### Risk + effort

- **Risk**: HIGH if regression — call audio is the core product surface. Verify with at least one solo dev test + one real 3-person test before shipping.
- **Effort**: 2–4 hours diagnostic + fix, assuming the snippet pinpoints the layer.

---

## 2. Captions — modal opens but no text appears

### Symptom

Clicking the CC button opens the captions panel but no transcribed text shows up while speaking.

### Diagnosis

Most likely cause: Electron's bundled Chromium has `webkitSpeechRecognition` as a class (so `isSupported()` returns true) but the underlying network-backed Google STT service isn't configured. Recognition fires `network` or `service-not-allowed` errors silently. The current `transcript.js` retries 6× then gives up — easy to miss in DevTools.

### Diagnostic snippet — paste in DevTools while in a call

```js
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
console.log('SR class exists:', !!SR);
if (SR) {
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.onresult = (e) => console.log('RESULT:', e.results[e.results.length-1][0].transcript);
  r.onerror = (e) => console.log('ERROR:', e.error);
  r.onend = () => console.log('ENDED');
  r.onstart = () => console.log('STARTED — say something');
  try { r.start(); } catch (err) { console.log('start() threw:', err.message); }
}
```

Speak for ~5 seconds.

| Output | Diagnosis | Fix |
|---|---|---|
| `ERROR: network` or `service-not-allowed` repeatedly | Web Speech unavailable in this Electron build | Bundle local STT engine (see below) |
| `STARTED` then 5s silence then `ENDED` | Recognition runs but produces no results — likely mic conflict with LiveKit's `getUserMedia` | Investigate audio routing |
| `RESULT: <your words>` actually fires | Web Speech works; bug is in renderer/transcript.js plumbing | Trace `onFinal` → `appendCaptionLine` |

### Proposed fix (assuming SR is dead, outcome 1): local whisper.cpp via Node addon

Reference: `~/Desktop/dictation-tauri_2026-05-29` — proves whisper.cpp + Metal works locally for hold-to-talk dictation. Adapt the engine to continuous-streaming for call captions.

#### Implementation phases

1. **Module pick** — `smart-whisper` (Node N-API addon for whisper.cpp, Metal on Apple Silicon, supports streaming chunks). Alternatives: `whisper-node` (older), `nodejs-whisper`. Decide based on N-API ABI compatibility with current Electron.

2. **electron-builder config**
   - `asarUnpack: ["node_modules/smart-whisper/**"]` so the native `.node` binary stays on disk (asar can't load addons)
   - `npmRebuild: true` to rebuild against Electron's Node ABI on install

3. **Model strategy** — first-launch download (~150 MB `tiny.en`) into `app.getPath('userData')` rather than bundling. Keeps the installer lean.
   - Add "Captions model" row in Settings → Integrations: status (not-downloaded / downloading XX% / ready) + manual re-download button.

4. **Audio capture path** — open a second `getUserMedia({audio: true})` consumer alongside LiveKit's. Mic is shared at the OS level; multiple consumers are fine. Chunk into ~1.5 sec windows, feed to whisper, emit `onFinal` per chunk.

5. **Module rewrite** — new `renderer/whisper-transcript.js` keeps the existing `TranscriptManager` API surface (`start`, `stop`, `onFinal`, `onInterim`, `isSupported`) so `app.js`'s captions wiring stays unchanged. Old `transcript.js` stays as a fallback behind a feature flag during rollout.

6. **First-launch UX** — first click of CC: show "Downloading caption model (~150 MB)…" toast → progress bar → resume. Subsequent launches: instant.

### Risk + effort

- **Risk**: MEDIUM. Native addon means platform-specific builds (Mac arm64, Mac x64, Win x64). Installer bloat ~50 MB binary + first-launch ~150 MB model. Worth confirming the model download flow doesn't hose someone's connection mid-call.
- **Effort**: Multi-day. Single isolated module + bundle config + UX for the model download.

### Files

- `package.json` — add `smart-whisper` dep + build config tweaks
- `main.js` — IPC handler for model download status (renderer → main → fs writes)
- `preload.js` — bridge for `downloadCaptionsModel()`, `getCaptionsModelStatus()`
- `renderer/whisper-transcript.js` — NEW (replaces `transcript.js`'s engine)
- `renderer/app.js` — feature flag gate, kept consumer-side API stable
- `renderer/index.html` + `styles.css` — Settings → Integrations row for the model

---

## 3. Call view — design-fidelity gap

Looking at the design bundle's `Huddle App.html` against what we ship: most chrome (titlebar, NavRail, dock with labels, layout switcher, fullscreen toggle, screen-share label) is in place, but the right-side **Live transcript panel** is the biggest visual gap, and a few smaller polish items are still missing.

### 3.1 Live transcript panel — right-side persistent dock

**Design**: when captions are on, a `296px` right-side panel renders next to the stage with:
- Header: caption icon + "Live transcript" + `summarize` button + hide button
- Body: per-line entries (18px avatar + name + mono time + text), streaming in every ~4.5s with typing-dots indicator
- Footer: a `/summarize` ghost button

**Shipped**: captions render as a footer strip below the tile grid (`#captions` in `index.html`). Not a side panel; no per-line avatar / name / timestamp; no `summarize` button in the panel.

**Effort**: Medium. Restructure the captions panel HTML + reposition CSS. The data path (transcript lines from peers via the call channel) already exists — just needs a new render target.

**Files**: `renderer/index.html`, `renderer/styles.css`, `renderer/app.js` (caption-line render).

### 3.2 Drawing toolbar — design fidelity pass

**Design**: bottom-center floating pill with cursor / pen / arrow / rect / ellipse / eraser tools, then a divider, 5 color swatches (`--accent`, `--live`, `--online`, `--away`, white; selected = white ring), then a divider, then undo + clear.

**Shipped**: drawing toolbar exists (PR `Annotate slack parity` and earlier) but its layout / styling may not match the design's pill chrome. Spot-check needed.

**Effort**: Small. CSS pass once we verify the markup matches what we need.

**Files**: `renderer/styles.css`, possibly `renderer/drawing.js`.

### 3.3 Screen-share center hint

**Design**: in the middle of the screen-share stage (over the live screen-share video), a center hint reads `shared screen · draw to annotate` (faded, large mono text).

**Shipped**: nothing.

**Effort**: Trivial CSS. ~5 LOC.

**Files**: `renderer/styles.css`.

### 3.4 Filmstrip tile sizing audit

**Design**: when screen-share is active, 4-tile right-side filmstrip with 16:10 aspect-ratio camera tiles at `184px` width.

**Shipped**: side-strip layout (#179 2.11) applies `:has(.tile.screen:not(.whiteboard))` to switch to `1fr / 184px`. Aspect ratio not explicitly enforced.

**Effort**: Trivial CSS. Verify `aspect-ratio: 16 / 10` is on `.tile` in the strip context.

**Files**: `renderer/styles.css`.

### Tracking sub-items

- [ ] **3.1** Live transcript panel (biggest gap)
- [ ] **3.2** Drawing toolbar fidelity pass
- [ ] **3.3** Screen-share center hint
- [ ] **3.4** Filmstrip tile sizing audit

---

## 4. Whiteboard view — design-fidelity gap

The whiteboard view ships in Huddle today but the chrome and tool palette layout diverge from the design bundle's `WhiteboardView`.

### 4.1 Left vertical tool palette

**Design**: a vertically-centered compact palette pinned to the left edge of the canvas (radius 15, `--bg-1` / `--line` / `--sh-pop`):
- Tools (36×36, active = `--accent`): cursor, pen, arrow, rectangle, ellipse, diamond, text, eraser
- Divider
- 2×2 grid of color swatches (15px each)
- Divider
- Undo + clear

**Shipped**: tool palette exists but probably as a horizontal top bar (Phase 2 / 3 whiteboard polish). Need to restructure to vertical-left.

**Effort**: Medium. Markup repositioning + CSS.

**Files**: `renderer/whiteboard.js`, `renderer/styles.css`.

### 4.2 Dotted-grid canvas background

**Design**: full-area `<canvas>` over a dotted-grid background (radial-dot, 26px grid, `--bg-0`).

**Shipped**: probably solid `--bg-0` or `#fdfcf8` (warm off-white). Add the radial-dot grid as a background-image.

**Effort**: Trivial. ~5 LOC of CSS.

**Files**: `renderer/styles.css`.

### 4.3 Collaborator cursor with name label

**Design**: a floating remote cursor with the editor's name in a pill at `--live` color.

**Shipped**: remote cursor exists (from the live-drawing work) but the name-pill styling may not match. Spot-check.

**Effort**: Small. CSS pass on the cursor markup.

**Files**: `renderer/whiteboard.js`, `renderer/styles.css`.

### 4.4 Whiteboard header chrome

**Design**: header reads "Whiteboard · `#channel`" + overlapping editor avatars + "N editing" + zoom-out / `100%` / zoom-in + Export button.

**Shipped**: header exists but the structure / button set may not match. Need a structural audit.

**Effort**: Small-medium. Mostly markup + CSS; "Export" already exists somewhere in the codebase.

**Files**: `renderer/whiteboard.js`, `renderer/index.html`, `renderer/styles.css`.

### Tracking sub-items

- [ ] **4.1** Left vertical tool palette
- [ ] **4.2** Dotted-grid background
- [ ] **4.3** Collaborator cursor name pill
- [ ] **4.4** Header chrome audit

---

## 5. _(further additions)_

<!-- Nick to fill: more outstanding items here. -->

---

## Tracking

- [ ] **1**: Run audio-bug diagnostic; pinpoint layer; ship fix in a PR off `main`.
- [ ] **2**: Run captions diagnostic; confirm SR is dead (or not); if dead, kick off the whisper.cpp work in a new PR.

## How to verify each item

- **Audio bug**: 3 real participants on a call, each on a different network. All three must hear each other.
- **Captions**: speak for 30 seconds, verify text appears in the captions panel with <2 sec latency, verify broadcast to other peers via `huddle.sendTranscriptLine` (existing path).
