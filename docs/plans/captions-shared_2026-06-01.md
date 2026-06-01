# Shared Captions — designated-transcriber + local whisper.cpp

Plan doc, 2026-06-01. Successor to §2 of `call-quality-and-captions_2026-05-29.md`
(which deferred captions because Web Speech API is dead in Electron).

## Goal

Replace the broken Web Speech captions pipeline with a local, real-time
caption stream that **every participant in the call can see when any one
participant enables CC**.

## Non-goals (v1)

- Translation / multi-language. English only (`tiny.en` model).
- Per-participant CC toggle visibility (no UI indicator of WHO has CC on).
- Persistent transcripts saved to Supabase. Captions are in-memory.
- Speaker diarisation beyond LiveKit participant identity.
- Server-side LiveKit Agent. Deferred; revisit if compute on the enabler
  becomes painful with 8+ participants.

## Architecture

Designated-transcriber pattern:

```
  CC enabler (Client A)                 Receiver (Client B, CC off)
  ─────────────────────                 ──────────────────────────
  local mic + remote audio tracks       
            │                           
            ▼                           
  MediaRecorder → 1.5s WAV chunks       
            │                           
            ▼   (IPC chunk + meta)      
  main: spawn whisper-cli per chunk      
            │                           
            ▼   (IPC caption-text)      
  renderer: render caption line  ──┐   
                                   │   
                                   ▼   
                       LiveKit publishData                
                       topic: huddle.captions
                                   │                       
                                   └──────► subscribe ►── render
                                                          (auto-open panel)
```

### Designation rule

Whoever toggles CC first claims the role. Implemented as a "claim" message
broadcast on the data channel: clients track `currentTranscriber` =
participant identity. If a higher-priority claim arrives (lower identity
string), the current transcriber tears down its engine + capture, and the
new claimer takes over. Stops the room from running two engines.

### Privacy posture

- Audio never leaves the enabler's machine.
- Only the transcribed *text* crosses the wire (over LiveKit's existing
  data channel — same trust boundary as chat in the call).
- Receivers can opt out per-call via a "hide captions" toggle — captions
  still broadcast, they just don't render.

## Engine: sidecar whisper.cpp

- One per-platform binary in `resources/whisper/{darwin-arm64,darwin-x64,win32-x64}/whisper-cli`
- Model at `app.getPath('userData')/whisper-models/ggml-tiny.en.bin`
- First CC click triggers download with progress UI in Settings → Integrations.
- macOS build: `MACOSX_DEPLOYMENT_TARGET=11.0` per
  `project_dictation_tauri_build_macos26.md`.
- electron-builder: `extraResources` block copies binaries into the
  packaged app's Resources dir.

### Why sidecar over N-API addon

- No `npmRebuild` ceremony per Electron version bump.
- Native-module signing/notarization on macOS is a known footgun the
  sidecar pattern sidesteps.
- Per-chunk spawn cost (~100ms) is acceptable at 1.5s chunks.
- Memory cost lives in one short-lived subprocess; OS reclaims on exit.

## Phases

Each phase ends with a **verify** step. Don't advance until verify passes.

### Phase 0 — Confirm diagnosis on v0.25.1

- Build a fresh v0.25.1 install, open DevTools in a call, paste the SR
  probe from `call-quality-and-captions_2026-05-29.md` §2.
- **Verify**: `ERROR: network` (or equivalent) fires. If `RESULT:` fires
  unexpectedly, abort this plan and debug the old pipeline instead.

### Phase 1 — Ship whisper.cpp binary in the build

- Vendor `whisper-cli` binary for macOS arm64 (start narrow). Build via:
  `cmake -B build -DWHISPER_METAL=ON -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0`
- Copy binary to `resources/whisper/darwin-arm64/whisper-cli`.
- Add `extraResources` block to `electron-builder.json5`:
  ```
  "extraResources": [
    { "from": "resources/whisper/${os}-${arch}", "to": "whisper", "filter": ["**/*"] }
  ]
  ```
- Helper in main: `getWhisperBinaryPath()` → `process.resourcesPath/whisper/whisper-cli` in prod, `resources/whisper/darwin-arm64/whisper-cli` in dev.
- **Verify**: `npm run pack` → unzip the .app → `Contents/Resources/whisper/whisper-cli` is present and executable. Run it manually with `--help`.

### Phase 2 — Model download UX

- `main.js`: IPC handlers `whisper-model-status`, `whisper-model-download`, `whisper-model-cancel`.
- Status enum: `not-downloaded | downloading | ready | error`.
- Download from huggingface.co/ggerganov/whisper.cpp (`ggml-tiny.en.bin`, ~75 MB).
- Progress emitted as `whisper-model-progress` IPC event (bytes/total).
- Settings → Integrations row: status badge + "Download" button + "Re-download" button.
- **Verify**: fresh install with no model → click CC → modal "Download captions model? (75 MB)" → progress → ready. Subsequent CC clicks: instant.

### Phase 3 — Capture all audio tracks on the enabler

- New `renderer/captions-capture.js`. Exports `start(room)`, `stop()`.
- On start: `getUserMedia({audio:true})` for local mic + iterate `room.remoteParticipants` and grab each `RemoteAudioTrack`'s underlying `MediaStreamTrack`.
- Subscribe to `room.on(RoomEvent.TrackSubscribed)` to pick up late-joiners' audio.
- Per track: MediaRecorder → 1.5s chunks → WAV PCM 16kHz mono → IPC `whisper-transcribe-chunk { participantId, isLocal, wavBuffer }`.
- **Verify**: console-log every emitted chunk. Open 2-client call, only enable CC on A. Logs show chunks tagged with both A's identity and B's identity.

### Phase 4 — Engine wiring in main

- `main.js` queue: per-chunk spawn `whisper-cli -m <model> -f <chunk> -ot -nt -l en --no-prints`.
- Capture stdout; emit `caption-line { participantId, text, startedAt }` IPC back to *enabler's window*.
- Backpressure: if queue depth > 8, drop oldest. Captions are best-effort, not lossless.
- **Verify**: speak into the 2-client call; both A's mic and B's mic produce caption-line events on A's renderer within ~2s.

### Phase 5 — Renderer captions panel + LiveKit broadcast

- New `renderer/whisper-transcript.js` mirroring TranscriptManager's surface (`start`, `stop`, `onFinal`, `isSupported`).
- On each `caption-line`:
  - Render into the captions panel locally (existing UI from `transcript.js`).
  - Publish over LiveKit: `localParticipant.publishData(JSON.stringify(line), { topic: 'huddle.captions', reliable: true })`.
- All clients subscribe to `room.on(RoomEvent.DataReceived)` for topic `huddle.captions`:
  - Auto-open captions panel on first received line.
  - Render with participant attribution.
- **Verify**: Client A toggles CC, B does not. B sees the captions panel auto-open with lines from both A and B.

### Phase 6 — Designation handshake

- New data-channel topic: `huddle.captions.claim`.
- On CC enable, broadcast `{ claimer: identity, timestamp }`.
- Each client tracks `currentTranscriber`:
  - If incoming claim's identity < own identity (sort-order) → tear down engine, set `currentTranscriber = claimer`.
  - Else → reject + counter-claim.
- Edge cases: claimer leaves the room → broadcast `caption-end`; everyone clears `currentTranscriber`; UI shows "captions ended" toast.
- **Verify**: A toggles CC; B toggles CC second. One engine running (lower identity); both clients see captions; close the lower-identity client; captions stop with toast.

### Phase 7 — Lifecycle, error handling, polish

- CC toggle off → stop capture, kill in-flight chunks, send `caption-end` broadcast.
- Call end → same cleanup.
- Engine crash → backoff retry 3×, then fall back to "captions unavailable" toast.
- Mic permission denied → toast + auto-fallback to remote-only capture (other participants still get captioned).
- **Verify**: open/close CC 10× in one call; no orphan whisper-cli processes (`pgrep whisper`); no leaked MediaStreams.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| whisper-cli spawn cost overwhelms CPU on 6+ participants | Med | Profile in Phase 4; if hot, switch to long-lived `whisper-stream` mode with one process per track |
| `MACOSX_DEPLOYMENT_TARGET` mismatch breaks macOS 26 build | Low (known) | Bake into cmake invocation; also add to electron-builder mac config |
| Two clients both think they're the transcriber (split-brain) | Med | Strict tie-breaker on identity string; engine teardown is idempotent |
| Model download hangs mid-call | Med | Download happens on FIRST CC click, before engine spawns; can't block the call |
| Mic shared between LiveKit and our consumer fights for permission | Low | Same `getUserMedia` track that LiveKit already holds — we clone or open second consumer with identical constraints |
| Notarization rejects unsigned whisper-cli on macOS | High | Code-sign the binary during build; add to entitlements/hardened-runtime exception if needed |
| Captions broadcast leaks sensitive call audio to participants who hadn't enabled it themselves | By design | Document in Settings → Integrations: "Captions are broadcast to everyone in the call when enabled." |

## Open questions (resolve as we hit them)

- Windows + Linux binaries — defer to post-MVP? Or build all three before merging?
- Model upgrade path (`tiny.en` → `base.en` for accuracy) — single setting toggle, or do we ship multiple models?
- Do receivers need a "hide captions" per-call mute even though they didn't enable CC? Probably yes — add to UI.

## Files touched (estimate)

- `package.json` — no native deps; just maybe a build script for fetching the binary
- `electron-builder.json5` — `extraResources` block
- `main.js` — IPC handlers + spawn logic + model download
- `preload.js` — bridge for `whisper.getModelStatus`, `whisper.downloadModel`, `whisper.transcribeChunk` (renderer→main), `whisper.onCaptionLine`, `whisper.onModelProgress`
- `renderer/captions-capture.js` — NEW
- `renderer/whisper-transcript.js` — NEW (replaces `transcript.js` for v2 builds)
- `renderer/app.js` — wire CC button to new manager, add data-channel listener for `huddle.captions` + `huddle.captions.claim`
- `renderer/styles.css` — minimal (re-use existing captions panel styles)
- `renderer/index.html` — Settings → Integrations row for model status
- `resources/whisper/darwin-arm64/whisper-cli` — NEW binary asset

## Ship cadence

- Phase 0–2 → one PR (model UX, binary plumbing, no captions yet)
- Phase 3–5 → one PR (local-render only, no broadcast yet) — captions visible to enabler only
- Phase 6 → one PR (broadcast + designation)
- Phase 7 → one PR (polish + ship as v0.26.0)
