// renderer/clip-recorder.js
//
// Huddle Clips — Loom-style async video clips.
//
// This module owns the whole "record a short clip" interaction: it grabs
// the camera+mic (getUserMedia) and/or a screen (via the existing
// get-screen-sources picker), wires a live preview, records to a webm Blob
// with MediaRecorder, and exposes a tiny stop / re-record / discard /
// post lifecycle on a modal. It is intentionally *transport-agnostic*:
// the recorder never touches Supabase or the chat list. When the user
// hits "Post", the caller's `onPost(blob, meta)` callback fires and
// ChatView takes it from there (upload via the normal uploadFile path,
// then sendMessage with a video attachment).
//
// Capture modes:
//   - Camera + mic only  → record the camera MediaStream directly.
//   - Screen only        → record the screen MediaStream (mic muxed in if
//                          the camera box is also ticked for audio).
//   - Camera + screen    → composite onto a <canvas> (screen full-frame
//                          with a small circular camera bubble bottom-left,
//                          Loom-style) and record canvas.captureStream(),
//                          muxing the mic audio track in.
//
// Everything is cleaned up aggressively: every getUserMedia track is
// stopped on stop/cancel/close, the canvas RAF loop is cancelled, and the
// duration cap timer is cleared. Permission-denied / no-track errors are
// surfaced inline rather than thrown into the void.

(function () {
  'use strict';

  // Hard cap on clip length. Loom's free tier is 5 min; 3 min keeps blobs
  // small enough to upload comfortably and matches the brief.
  const MAX_DURATION_MS = 3 * 60 * 1000;

  // Camera bubble geometry for the composited (cam+screen) layout.
  const BUBBLE_DIAMETER = 180; // px on the capture canvas
  const BUBBLE_MARGIN = 24;

  // Pick the best webm codec the runtime supports. Electron/Chromium gives
  // us VP9+Opus; we fall back gracefully so MediaRecorder never throws on
  // an unknown mimeType. (mp4 is left out — Chromium can't reliably *record*
  // mp4, only play it.)
  function pickMimeType() {
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const t of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    }
    return ''; // let MediaRecorder choose its own default
  }

  class ClipRecorder {
    // els: the DOM handles from app.js (clipRecorder modal + its controls).
    // hooks:
    //   onPost(blob, meta)  — fired when the user posts a finished clip.
    //   pickScreenSource()  — async () => ({ id, name }) | null, opens the
    //                         existing source picker and resolves to a choice
    //                         (or null if cancelled). Reused from app.js so
    //                         we don't duplicate the permission/thumbnail UI.
    //   toast(msg)          — optional, for non-fatal notices.
    //   signal              — optional AbortSignal; when provided, all DOM
    //                         listeners are registered with it so the owner
    //                         (ChatView) can tear them down on destroy().
    constructor({ els, hooks, signal }) {
      this.els = els;
      this.hooks = hooks || {};
      this._signal = signal || null;

      // Live capture state.
      this.camStream = null;      // getUserMedia camera+mic
      this.screenStream = null;   // getUserMedia desktop
      this.compositeStream = null;// canvas.captureStream() when compositing
      this.recordStream = null;   // the stream actually fed to MediaRecorder
      this.recorder = null;
      this.chunks = [];
      this.recordedBlob = null;
      this.recordedUrl = null;    // object URL for playback (revoked on reset)

      // Compositing loop + canvas (only used in cam+screen mode).
      this.canvas = null;
      this.canvasCtx = null;
      this.camVideoEl = null;     // off-DOM <video> feeding the canvas
      this.screenVideoEl = null;
      this._rafId = null;

      // Timers.
      this._capTimer = null;      // auto-stop at MAX_DURATION_MS
      this._tickTimer = null;     // 1s timer updating the on-screen clock
      this._startedAt = 0;
      this._recordedSecs = 0;     // measured at stop; survives the review phase

      this._wired = false;
    }

    // Wire button handlers once. Called lazily on first open so it doesn't
    // matter whether ChatView constructs us before or after the DOM is ready.
    _wire() {
      if (this._wired) return;
      this._wired = true;
      const e = this.els;
      // Register with the owner's AbortSignal (when supplied) so a ChatView
      // rebuild on team-switch doesn't leak duplicate handlers on the shared
      // modal DOM.
      const opts = this._signal ? { signal: this._signal } : undefined;
      const on = (el, ev, fn) => el && el.addEventListener(ev, fn, opts);
      on(e.clipClose, 'click', () => this.close());
      on(e.clipRecord, 'click', () => this._startRecording());
      on(e.clipStop, 'click', () => this._stopRecording());
      on(e.clipRetake, 'click', () => this._retake());
      on(e.clipPost, 'click', () => this._post());
      // Re-arm the preview when the source checkboxes change (only while
      // idle — toggling mid-recording is ignored by disabling them).
      on(e.clipCam, 'change', () => this._refreshPreview());
      on(e.clipScreen, 'change', () => this._refreshPreview());
      // Click on the dimmed backdrop (but not the modal body) closes.
      on(e.clipRecorder, 'mousedown', (ev) => {
        if (ev.target === e.clipRecorder) this.close();
      });
    }

    // --- Open / close -------------------------------------------------------

    async open() {
      this._wire();
      this._resetState();
      this.els.clipRecorder.classList.remove('hidden');
      this.els.clipRecorder.setAttribute('aria-hidden', 'false');
      this._setPhase('idle');
      await this._refreshPreview();
    }

    // close(force):
    //   force=false (default) — user-initiated close (X button / backdrop).
    //     If there's a live recording or an un-posted review take, confirm
    //     before throwing it away so an accidental click can't nuke a clip.
    //   force=true — programmatic teardown (team-switch / ChatView destroy,
    //     or our own _post() after a successful hand-off). Skips the prompt
    //     and always releases capture; a left-open recorder must let go of
    //     the camera/screen even if nobody's around to answer a dialog.
    close(force = false) {
      if (!force && (this._phase === 'recording' || this._phase === 'review')) {
        // eslint-disable-next-line no-alert
        if (!confirm('Discard your recording and close?')) return;
      }
      // If we're closed mid-recording (X button, backdrop click, or a
      // team-switch teardown), the cap + tick timers and the live
      // MediaRecorder are still running. _stopRecording() clears both timers
      // and stops the recorder; without it the 1s tick setInterval would
      // fire forever on the now-hidden modal and the cap timer could later
      // resurrect review UI on a closed recorder.
      this._stopRecording();
      // The recorder's async onstop may still be queued (it would rebuild
      // review state) — but the modal is going away, so drop our handler so
      // it can't run against torn-down DOM.
      if (this.recorder) { this.recorder.onstop = null; this.recorder = null; }
      this._teardownCapture();
      this._discardRecording();
      this.els.clipRecorder.classList.add('hidden');
      this.els.clipRecorder.setAttribute('aria-hidden', 'true');
    }

    // --- Preview (idle) -----------------------------------------------------

    // (Re)acquire the live preview based on the current source checkboxes.
    // Stops any previous capture first so flipping a checkbox doesn't leak
    // a camera handle. Errors (permission denied / no device) are shown
    // inline and the Record button is disabled until a valid source exists.
    async _refreshPreview() {
      if (this._phase === 'recording' || this._phase === 'review') return;
      this._clearError();
      this._teardownCapture();

      const wantCam = this.els.clipCam.checked;
      const wantScreen = this.els.clipScreen.checked;

      if (!wantCam && !wantScreen) {
        this.els.clipStatus.textContent = 'Pick at least one source.';
        this.els.clipRecord.disabled = true;
        this.els.clipPreview.srcObject = null;
        return;
      }

      // Concurrency guard: toggling sources fires _refreshPreview again
      // while this one is still awaiting getUserMedia / the screen picker.
      // A newer run will have called _teardownCapture() and bumped the
      // generation; when our awaited streams finally resolve we must stop
      // them ourselves and bail, otherwise the orphaned camera handle keeps
      // the camera light on.
      const gen = (this._previewGen = (this._previewGen || 0) + 1);
      const stale = () => gen !== this._previewGen;
      const stopStream = (s) => { if (s) for (const t of s.getTracks()) { try { t.stop(); } catch {} } };

      try {
        if (wantCam) {
          const cam = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: true,
          });
          if (stale()) { stopStream(cam); return; }
          this.camStream = cam;
        }
        if (wantScreen) {
          const screen = await this._captureScreen();
          if (stale()) { stopStream(screen); return; }
          this.screenStream = screen;
          // _captureScreen returns null when the user cancels the picker —
          // fall back to camera-only so the modal isn't left blank.
          if (!this.screenStream) {
            this.els.clipScreen.checked = false;
            if (!this.camStream) {
              this.els.clipStatus.textContent = 'Screen selection cancelled.';
              this.els.clipRecord.disabled = true;
              return;
            }
          }
        }
      } catch (err) {
        if (stale()) return;
        // If the camera was already acquired before a later source (screen)
        // failed, the camera handle is still live — tear everything down so
        // the camera light doesn't stay on after an error.
        this._teardownCapture();
        this._showCaptureError(err);
        this.els.clipRecord.disabled = true;
        return;
      }

      // Decide what the *preview* shows and what we'll record.
      const previewStream = this._buildPreviewStream();
      this.els.clipPreview.srcObject = previewStream;
      this.els.clipPreview.muted = true; // never echo the mic back at record time
      this.els.clipPreview.controls = false;
      try { await this.els.clipPreview.play(); } catch { /* autoplay race — harmless */ }

      this.els.clipRecord.disabled = false;
      this.els.clipStatus.textContent = this._sourceLabel() + ' ready.';
    }

    // Reuse the app's existing source picker (permission gate + thumbnails)
    // to pick a screen/window, then open the desktop capture stream for it.
    async _captureScreen() {
      const choice = this.hooks.pickScreenSource
        ? await this.hooks.pickScreenSource()
        : null;
      if (!choice) return null;
      // Same constraint shape livekit.js addScreen uses: max bounds only,
      // never min* (those are hard floors and throw on small windows).
      return navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: choice.id,
            maxWidth: 2560, maxHeight: 1440, maxFrameRate: 30,
          },
        },
      });
    }

    // Build the MediaStream shown in the preview (and later recorded). In
    // cam+screen mode this spins up the compositing canvas; otherwise it's
    // just the single source stream.
    _buildPreviewStream() {
      const wantCam = !!this.camStream;
      const wantScreen = !!this.screenStream;

      if (wantCam && wantScreen) {
        this.recordStream = this._buildCompositeStream();
        return this.recordStream;
      }
      // Single-source: record exactly what we preview.
      this.recordStream = wantScreen ? this.screenStream : this.camStream;
      return this.recordStream;
    }

    // Composite screen (full frame) + camera (circular bubble) onto a canvas
    // and capture it as a stream, muxing in the mic audio track. Returns the
    // canvas captureStream with audio attached.
    _buildCompositeStream() {
      // Off-DOM video elements drive the canvas draw loop.
      this.screenVideoEl = document.createElement('video');
      this.screenVideoEl.srcObject = this.screenStream;
      this.screenVideoEl.muted = true;
      this.screenVideoEl.playsInline = true;
      this.camVideoEl = document.createElement('video');
      this.camVideoEl.srcObject = this.camStream;
      this.camVideoEl.muted = true;
      this.camVideoEl.playsInline = true;
      this.screenVideoEl.play().catch(() => {});
      this.camVideoEl.play().catch(() => {});

      // Size the canvas to the screen track's resolution so text stays crisp.
      // Guard the track lookup: a screen stream with no video track (revoked
      // before we got here, or audio-only) would otherwise crash on
      // getSettings(); fall back to the default 1280x720 below.
      const st = this.screenStream.getVideoTracks()[0]?.getSettings() || {};
      this.canvas = document.createElement('canvas');
      this.canvas.width = st.width || 1280;
      this.canvas.height = st.height || 720;
      this.canvasCtx = this.canvas.getContext('2d');

      const draw = () => {
        const ctx = this.canvasCtx;
        const W = this.canvas.width, H = this.canvas.height;
        // Screen fills the frame.
        if (this.screenVideoEl.readyState >= 2) {
          ctx.drawImage(this.screenVideoEl, 0, 0, W, H);
        } else {
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, W, H);
        }
        // Camera bubble, bottom-left, clipped to a circle.
        if (this.camVideoEl.readyState >= 2) {
          const d = BUBBLE_DIAMETER;
          const cx = BUBBLE_MARGIN + d / 2;
          const cy = H - BUBBLE_MARGIN - d / 2;
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
          ctx.closePath();
          ctx.clip();
          // Cover-fit the camera into the circle (center-crop to square).
          const vw = this.camVideoEl.videoWidth || 1;
          const vh = this.camVideoEl.videoHeight || 1;
          const side = Math.min(vw, vh);
          const sx = (vw - side) / 2;
          const sy = (vh - side) / 2;
          ctx.drawImage(this.camVideoEl, sx, sy, side, side, cx - d / 2, cy - d / 2, d, d);
          ctx.restore();
          // Subtle ring around the bubble.
          ctx.beginPath();
          ctx.arc(cx, cy, d / 2, 0, Math.PI * 2);
          ctx.lineWidth = 4;
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.stroke();
        }
        this._rafId = requestAnimationFrame(draw);
      };
      this._rafId = requestAnimationFrame(draw);

      // captureStream gives us the composited video; add the mic audio.
      const out = this.canvas.captureStream(30);
      const micTrack = this.camStream.getAudioTracks()[0];
      if (micTrack) out.addTrack(micTrack);
      // Hold the canvas-captured stream so teardown can stop its video track
      // (the mic track belongs to camStream and is stopped via that ref).
      this.compositeStream = out;
      return out;
    }

    // --- Recording ----------------------------------------------------------

    _startRecording() {
      if (!this.recordStream) return;
      const mimeType = pickMimeType();
      try {
        this.recorder = new MediaRecorder(
          this.recordStream,
          mimeType ? { mimeType } : undefined,
        );
      } catch (err) {
        this._showCaptureError(err);
        return;
      }
      this.chunks = [];
      this.recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
      };
      this.recorder.onstop = () => this._onRecorderStop(mimeType);
      // If a track ends out from under us (user revokes screen share via the
      // OS "stop sharing" bar, or unplugs a camera), stop cleanly rather than
      // recording a frozen/black frame forever.
      //
      // Crucially we listen on the *source* streams (camStream / screenStream),
      // NOT recordStream. In cam+screen composite mode recordStream is the
      // canvas captureStream (+ the muxed mic track) — it does NOT contain the
      // real screen track, so the OS "stop sharing" action would fire 'ended'
      // on the screen track without us ever hearing about it, and the canvas
      // would just keep drawing black. Watching the originals covers all three
      // modes (the single-source modes feed their source straight through, so
      // those tracks are the same objects).
      const onSourceEnded = () => {
        if (this._phase === 'recording') this._stopRecording();
      };
      for (const s of [this.camStream, this.screenStream]) {
        if (!s) continue;
        for (const t of s.getTracks()) t.addEventListener('ended', onSourceEnded);
      }

      // Timeslice so chunks flush periodically — a crash mid-record still
      // leaves us a partially-playable blob, and very long clips don't sit
      // in one giant buffer.
      this.recorder.start(1000);
      this._startedAt = Date.now();
      this._setPhase('recording');

      // Duration cap + live clock.
      this._capTimer = setTimeout(() => {
        this.hooks.toast?.('Clip hit the 3-minute limit — stopped.');
        this._stopRecording();
      }, MAX_DURATION_MS);
      this.els.clipTimer.classList.remove('hidden');
      this._updateClock();
      this._tickTimer = setInterval(() => this._updateClock(), 1000);
    }

    _stopRecording() {
      if (this._capTimer) { clearTimeout(this._capTimer); this._capTimer = null; }
      if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
      if (this.recorder && this.recorder.state !== 'inactive') {
        this.recorder.stop(); // fires onstop → _onRecorderStop
      }
    }

    _onRecorderStop(mimeType) {
      // Stop the canvas loop now that recording is done; the playback uses
      // the blob, not the live stream.
      this._stopCompositingLoop();
      const type = mimeType || (this.chunks[0] && this.chunks[0].type) || 'video/webm';
      this.recordedBlob = new Blob(this.chunks, { type });
      this.chunks = [];

      // Release live capture tracks — we have the blob now, no reason to
      // keep the camera/screen warm during review.
      this._teardownCapture();

      // A zero-byte blob (instant stop, codec hiccup, or a track that never
      // produced data) would upload + post a broken, unplayable attachment.
      // Bail back to idle with an inline notice instead of entering review.
      if (!this.recordedBlob.size) {
        this.recordedBlob = null;
        this._showError('Nothing was recorded — try again.');
        this._setPhase('idle');
        this._refreshPreview();
        return;
      }

      // Switch the preview <video> to play back the recorded blob with
      // controls. unmute so the user can hear their own audio on review.
      if (this.recordedUrl) URL.revokeObjectURL(this.recordedUrl);
      this.recordedUrl = URL.createObjectURL(this.recordedBlob);
      const v = this.els.clipPreview;
      v.srcObject = null;
      v.src = this.recordedUrl;
      v.muted = false;
      v.controls = true;
      v.play().catch(() => {});

      this._setPhase('review');
      // Freeze the recorded length now — _post() runs after an arbitrary
      // review pause, so re-measuring against _startedAt there would fold
      // the user's review time into the reported duration.
      this._recordedSecs = Math.round((Date.now() - this._startedAt) / 1000);
      this.els.clipStatus.textContent =
        `Recorded ${formatClock(this._recordedSecs)} · ${formatBytes(this.recordedBlob.size)}`;
    }

    _retake() {
      this._discardRecording();
      this._setPhase('idle');
      this._refreshPreview();
    }

    async _post() {
      if (!this.recordedBlob) return;
      const blob = this.recordedBlob;
      const durationSecs = this._recordedSecs;
      // Hand off to the caller; it owns upload + sendMessage. We only tear
      // the modal down once the hand-off *succeeds* — if onPost throws (upload
      // or sendMessage failed) we keep the recording so the user can retry
      // instead of silently losing the take.
      this.els.clipPost.disabled = true;
      try {
        await this.hooks.onPost?.(blob, {
          durationSecs,
          mimeType: blob.type || 'video/webm',
          // A friendly default filename; uploadFile sanitises it anyway.
          name: `huddle-clip-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.webm`,
        });
      } catch (err) {
        // Hand-off failed — _postClip has already toasted the specifics.
        // Surface it inline too and re-arm the Post button so the still-held
        // blob can be posted again. Stay in the review phase.
        console.warn('clip post failed', err);
        this.els.clipStatus.textContent = 'Failed to post clip.';
        this.els.clipPost.disabled = false;
        return;
      }
      // Success — force-close (no discard prompt) so teardown releases the
      // blob/URL and any lingering capture. Don't re-discard here; close()
      // handles teardown and revokes the URL.
      this.close(true);
    }

    // --- Cleanup ------------------------------------------------------------

    _stopCompositingLoop() {
      if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    }

    // Stop every live capture track + the compositing loop. Safe to call
    // repeatedly. Does NOT touch the recorded blob (that's _discardRecording).
    _teardownCapture() {
      // Invalidate any in-flight _refreshPreview so a getUserMedia call that
      // resolves *after* teardown (close/reset/re-toggle) stops its own
      // stream instead of re-assigning it onto a torn-down recorder.
      this._previewGen = (this._previewGen || 0) + 1;
      this._stopCompositingLoop();
      for (const s of [this.camStream, this.screenStream, this.compositeStream]) {
        if (s) for (const t of s.getTracks()) { try { t.stop(); } catch {} }
      }
      this.camStream = null;
      this.screenStream = null;
      this.compositeStream = null;
      // The composite output stream's video track is owned by the canvas;
      // stopping it isn't required, but null the ref so we don't reuse it.
      this.recordStream = null;
      // Pause the off-DOM feed elements before dropping their srcObject so
      // Chromium tears down the decode pipeline cleanly instead of leaving a
      // playing element pointed at a null source.
      if (this.camVideoEl) {
        try { this.camVideoEl.pause(); } catch {}
        this.camVideoEl.srcObject = null;
        this.camVideoEl = null;
      }
      if (this.screenVideoEl) {
        try { this.screenVideoEl.pause(); } catch {}
        this.screenVideoEl.srcObject = null;
        this.screenVideoEl = null;
      }
      this.canvas = null;
      this.canvasCtx = null;
    }

    _discardRecording() {
      this.recordedBlob = null;
      this.chunks = [];
      if (this.recordedUrl) { URL.revokeObjectURL(this.recordedUrl); this.recordedUrl = null; }
      const v = this.els.clipPreview;
      if (v) {
        // Fully detach the <video> so Chromium frees the decoded buffers held
        // for the blob/object URL. Setting src='' alone leaves a pending load;
        // removeAttribute('src') + srcObject=null + load() resets the element
        // to its empty state and releases those resources.
        v.removeAttribute('src');
        v.srcObject = null;
        v.controls = false;
        v.muted = true;
        try { v.load(); } catch {}
      }
    }

    _resetState() {
      this._teardownCapture();
      this._discardRecording();
      if (this._capTimer) { clearTimeout(this._capTimer); this._capTimer = null; }
      if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
      this.recorder = null;
      this._recordedSecs = 0;
      this.els.clipTimer.classList.add('hidden');
      this.els.clipTimer.textContent = '0:00';
      this.els.clipPost && (this.els.clipPost.disabled = false);
      // Default sources: camera on, screen off.
      this.els.clipCam.checked = true;
      this.els.clipScreen.checked = false;
    }

    // --- UI phase machine ---------------------------------------------------

    // Toggles which buttons / controls are visible for each phase:
    //   idle      → Record (+ source checkboxes enabled)
    //   recording → Stop
    //   review    → Re-record + Post
    _setPhase(phase) {
      this._phase = phase;
      const e = this.els;
      const show = (el, on) => el && el.classList.toggle('hidden', !on);
      show(e.clipRecord, phase === 'idle');
      show(e.clipStop, phase === 'recording');
      show(e.clipRetake, phase === 'review');
      show(e.clipPost, phase === 'review');
      // Lock source toggles while recording/reviewing so the live stream
      // can't be swapped out from under the recorder.
      const lock = phase !== 'idle';
      if (e.clipCam) e.clipCam.disabled = lock;
      if (e.clipScreen) e.clipScreen.disabled = lock;
      if (phase !== 'recording') e.clipTimer.classList.add('hidden');
    }

    _updateClock() {
      const secs = Math.floor((Date.now() - this._startedAt) / 1000);
      this.els.clipTimer.textContent = formatClock(secs);
    }

    _sourceLabel() {
      const cam = this.els.clipCam.checked, scr = this.els.clipScreen.checked && this.screenStream;
      if (cam && scr) return 'Camera + screen';
      if (scr) return 'Screen';
      return 'Camera + mic';
    }

    // --- Errors -------------------------------------------------------------

    _showCaptureError(err) {
      console.warn('clip recorder capture error', err);
      let msg = 'Could not start capture.';
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
        msg = 'Permission denied — allow camera, microphone, or screen access and try again.';
      } else if (err && err.name === 'NotFoundError') {
        msg = 'No camera or microphone found.';
      } else if (err && err.message) {
        msg = err.message;
      }
      this._showError(msg);
    }

    _showError(msg) {
      this.els.clipError.textContent = msg;
      this.els.clipError.classList.remove('hidden');
    }

    _clearError() {
      this.els.clipError.classList.add('hidden');
      this.els.clipError.textContent = '';
    }
  }

  // m:ss clock formatter (e.g. 0:07, 2:43).
  function formatClock(totalSecs) {
    const m = Math.floor(totalSecs / 60);
    const s = totalSecs % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // Tiny byte formatter mirroring chat.js's attachment-size labels.
  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  window.ClipRecorder = ClipRecorder;
})();
