// renderer/voice-note.js
//
// Huddle voice notes — short async audio messages posted inline in chat.
//
// Two halves, both exposed on window.HuddleVoiceNote:
//
//   VoiceNoteRecorder — the composer-side capture flow. Click the 🎙
//     button to start recording (mic only, denoised like calls/clips),
//     a small pill appears over the composer with a live timer, and the
//     user either sends (✓ → hooks.onPost(blob, meta)) or cancels (✕).
//     Deliberately lighter than the ClipRecorder modal: no preview, no
//     review phase — a voice note takes seconds to re-record.
//
//   renderVoiceAttachment(a) — the message-side player. Builds a
//     play/pause + waveform + time widget for an audio attachment. The
//     waveform is the real decoded audio (fetched once per URL, peaks
//     cached module-wide); if fetch/decode fails we fall back to
//     uniform bars so playback still works. Clicking the waveform seeks.
//
// Like clip-recorder.js this module is transport-agnostic: it never
// touches Supabase. ChatView owns upload + sendMessage via onPost.

(function () {
  'use strict';

  // Voice notes are for quick thoughts; match the clip recorder's cap so
  // uploads stay small (opus ≈ 20 KB/s → ~3.6 MB worst case).
  const MAX_DURATION_MS = 3 * 60 * 1000;

  // Bars drawn in the message player. Fixed count (not per-pixel) so the
  // same note looks identical at every tile width and the peak cache is
  // resolution-independent.
  const WAVE_BARS = 56;

  function pickAudioMimeType() {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm'];
    for (const t of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  function formatClock(totalSecs) {
    const m = Math.floor(totalSecs / 60);
    const s = Math.floor(totalSecs % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  // --- Recorder -------------------------------------------------------------

  class VoiceNoteRecorder {
    // els: { voiceBtn, voicePill, voicePillTimer, voicePillCancel, voicePillSend }
    // hooks:
    //   onPost(blob, meta) — fired on send; owner uploads + posts.
    //   denoiseEnabled()   — same preference the call/clip pipelines read.
    //   toast(msg)         — optional non-fatal notices.
    //   signal             — optional AbortSignal for listener teardown.
    constructor({ els, hooks, signal }) {
      this.els = els;
      this.hooks = hooks || {};
      this._signal = signal || null;
      this.stream = null;        // raw getUserMedia mic
      this.denoisePipe = null;   // DenoisePipeline instance (when active)
      this.recorder = null;
      this.chunks = [];
      this.recording = false;
      this._starting = false;    // getUserMedia in flight — ignore re-clicks
      this._startedAt = 0;
      this._capTimer = null;
      this._tickTimer = null;
      this._wired = false;
    }

    _wire() {
      if (this._wired) return;
      this._wired = true;
      const opts = this._signal ? { signal: this._signal } : undefined;
      this.els.voicePillCancel?.addEventListener('click', () => this._stop(false), opts);
      this.els.voicePillSend?.addEventListener('click', () => this._stop(true), opts);
    }

    // Entry point for the 🎙 button: starts a recording, or sends the one
    // in progress (so 🎙 → talk → 🎙 works without aiming for the ✓).
    async toggle() {
      if (this.recording) { this._stop(true); return; }
      if (this._starting) return;
      this._starting = true;
      try {
        await this._start();
      } finally {
        this._starting = false;
      }
    }

    async _start() {
      this._wire();
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        console.warn('[voice] mic capture failed', err);
        this.hooks.toast?.(
          err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
            ? 'Microphone permission denied.'
            : 'Could not access the microphone.'
        );
        return;
      }
      this.stream = stream;

      // Same denoise wiring as clip-recorder: default-on, best-effort, and
      // a pipeline failure falls back to the raw mic rather than aborting.
      let recordStream = stream;
      const denoiseWanted = (() => {
        try { return this.hooks.denoiseEnabled ? this.hooks.denoiseEnabled() !== false : true; }
        catch { return true; }
      })();
      if (denoiseWanted && window.DenoisePipeline?.isAvailable?.()) {
        try {
          this.denoisePipe = new window.DenoisePipeline();
          recordStream = await this.denoisePipe.start(stream);
        } catch (err) {
          console.warn('[voice] denoise setup failed, using raw mic', err);
          try { this.denoisePipe?.stop(); } catch {}
          this.denoisePipe = null;
          recordStream = stream;
        }
      }

      const mimeType = pickAudioMimeType();
      try {
        this.recorder = new MediaRecorder(recordStream, mimeType ? { mimeType } : undefined);
      } catch (err) {
        console.warn('[voice] MediaRecorder failed', err);
        this._releaseCapture();
        this.hooks.toast?.('Recording is not supported on this device.');
        return;
      }
      this.chunks = [];
      this.recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) this.chunks.push(ev.data);
      };
      // A mic that dies mid-take (unplugged headset) ends the note rather
      // than recording silence forever. Watch the SOURCE stream — in
      // denoise mode recordStream is the pipeline's synthetic track.
      const onEnded = () => { if (this.recording) this._stop(true); };
      for (const t of stream.getTracks()) t.addEventListener('ended', onEnded);

      // Timeslice so a crash mid-record still leaves a playable partial.
      this.recorder.start(1000);
      this.recording = true;
      this._startedAt = Date.now();
      this._capTimer = setTimeout(() => {
        this.hooks.toast?.('Voice note hit the 3-minute limit — sent.');
        this._stop(true);
      }, MAX_DURATION_MS);
      this._updateClock();
      this._tickTimer = setInterval(() => this._updateClock(), 1000);
      this.els.voicePill?.classList.remove('hidden');
      this.els.voiceBtn?.classList.add('recording');
    }

    _updateClock() {
      if (this.els.voicePillTimer) {
        this.els.voicePillTimer.textContent =
          formatClock((Date.now() - this._startedAt) / 1000);
      }
    }

    // Stop the take. post=true hands the blob to onPost; post=false discards.
    _stop(post) {
      if (!this.recording) return;
      this.recording = false;
      if (this._capTimer) { clearTimeout(this._capTimer); this._capTimer = null; }
      if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
      const durationSecs = Math.max(1, Math.round((Date.now() - this._startedAt) / 1000));
      this.els.voicePill?.classList.add('hidden');
      this.els.voiceBtn?.classList.remove('recording');

      const recorder = this.recorder;
      this.recorder = null;
      if (!recorder || recorder.state === 'inactive') {
        this._releaseCapture();
        return;
      }
      recorder.onstop = () => {
        const type = recorder.mimeType || (this.chunks[0] && this.chunks[0].type) || 'audio/webm';
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];
        this._releaseCapture();
        if (!post) return;
        if (!blob.size) {
          this.hooks.toast?.('Nothing was recorded — try again.');
          return;
        }
        // Extension must follow the ACTUAL container: if MediaRecorder
        // fell back past both webm candidates (pickAudioMimeType returned
        // ''), the blob may be mp4/ogg, and a lying .webm suffix breaks
        // players that trust the extension.
        const ext = /mp4|m4a|aac/.test(type) ? 'm4a' : (/ogg/.test(type) ? 'ogg' : 'webm');
        // Fire-and-forget: _postVoiceNote toasts its own failures, and
        // unlike a 3-minute clip a voice note is cheap to re-record, so
        // there's no retained-take retry state here.
        Promise.resolve(this.hooks.onPost?.(blob, {
          durationSecs,
          mimeType: type,
          name: `huddle-voice-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`,
        })).catch((err) => console.warn('[voice] post failed', err));
      };
      try { recorder.stop(); } catch { this._releaseCapture(); }
    }

    _releaseCapture() {
      try { this.denoisePipe?.stop(); } catch {}
      this.denoisePipe = null;
      if (this.stream) {
        for (const t of this.stream.getTracks()) { try { t.stop(); } catch {} }
      }
      this.stream = null;
    }

    // Programmatic teardown (team switch / ChatView destroy).
    destroy() {
      if (this.recording) this._stop(false);
      this._releaseCapture();
    }
  }

  // --- Message player ---------------------------------------------------------

  // url -> Promise<Float32Array of WAVE_BARS normalized peaks>. Peaks are
  // tiny; caching them module-wide means re-renders (pagination, reaction
  // repaints) never re-fetch or re-decode the audio.
  const peaksCache = new Map();

  // One shared decode context — decodeAudioData doesn't need a live
  // output, and Chromium caps the number of AudioContexts per page.
  let decodeCtx = null;

  function loadPeaks(url) {
    if (peaksCache.has(url)) return peaksCache.get(url);
    const p = (async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`waveform fetch ${res.status}`);
      const buf = await res.arrayBuffer();
      decodeCtx = decodeCtx || new (window.AudioContext || window.webkitAudioContext)();
      const audio = await decodeCtx.decodeAudioData(buf);
      // A corrupt/empty file can decode to 0 channels; getChannelData(0)
      // would throw INDEX_SIZE_ERR. Degrade to flat bars instead.
      const data = audio.numberOfChannels > 0 ? audio.getChannelData(0) : new Float32Array(0);
      const peaks = new Float32Array(WAVE_BARS);
      const chunk = Math.max(1, Math.floor(data.length / WAVE_BARS));
      let max = 0;
      for (let i = 0; i < WAVE_BARS; i++) {
        // RMS per bucket reads better than abs-max for speech (breaths and
        // clicks don't spike the whole bar to full height).
        let sum = 0;
        const start = i * chunk;
        const end = Math.min(start + chunk, data.length);
        for (let j = start; j < end; j++) sum += data[j] * data[j];
        peaks[i] = Math.sqrt(sum / Math.max(1, end - start));
        if (peaks[i] > max) max = peaks[i];
      }
      if (max > 0) for (let i = 0; i < WAVE_BARS; i++) peaks[i] /= max;
      return peaks;
    })();
    // Drop failed loads from the cache so a transient network error
    // doesn't pin a rejected promise against the URL forever.
    p.catch(() => peaksCache.delete(url));
    peaksCache.set(url, p);
    return p;
  }

  // Build the inline player for an audio attachment
  // ({ url, name, contentType, durationSecs?, kind? }). Returns a DOM node.
  function renderVoiceAttachment(a) {
    const root = document.createElement('div');
    root.className = 'msg-voice';

    const btn = document.createElement('button');
    btn.className = 'msg-voice-play';
    btn.setAttribute('aria-label', 'Play voice message');
    const ICON_PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
    const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
    btn.innerHTML = ICON_PLAY;

    const canvas = document.createElement('canvas');
    canvas.className = 'msg-voice-wave';
    const time = document.createElement('span');
    time.className = 'msg-voice-time';
    root.append(btn, canvas, time);

    // Not appended to the DOM — the canvas is the visible "controls".
    const audio = new Audio();
    audio.preload = 'none'; // don't fetch until first play; peaks come from fetch()
    audio.src = a.url;

    // MediaRecorder webm blobs famously report duration = Infinity until
    // you seek past the end once. We sidestep it: the recorder stamps
    // durationSecs on the attachment, and we only fall back to the
    // element's duration when that's missing AND finite.
    let duration = Number(a.durationSecs) || 0;
    audio.addEventListener('loadedmetadata', () => {
      if (!duration && Number.isFinite(audio.duration)) duration = audio.duration;
      draw();
    });

    time.textContent = duration ? formatClock(duration) : '·:··';

    // Uniform placeholder until the real peaks land (or forever, if
    // decode fails — the player still works, just with flat bars).
    let peaks = null;
    loadPeaks(a.url).then((p) => { peaks = p; draw(); }).catch(() => {});

    let rafId = null;
    const ctx = canvas.getContext('2d');
    const gap = 2;
    // Geometry + resolved colors, cached so draw() (which runs on every
    // animation frame during playback) does zero layout or style reads.
    // getComputedStyle alone is far too costly to call 60×/sec; measure()
    // refreshes these only when the size or theme could actually change.
    let cw = 160, ch = 28, barW = 3;
    let playedColor = '#0a84ff', restColor = 'rgba(255,255,255,0.28)';
    function measure() {
      cw = canvas.clientWidth || 160;
      ch = canvas.clientHeight || 28;
      const dpr = window.devicePixelRatio || 1;
      // Assigning width/height resets the context (incl. the transform),
      // so re-apply the DPR transform right after.
      if (canvas.width !== cw * dpr) canvas.width = cw * dpr;
      if (canvas.height !== ch * dpr) canvas.height = ch * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      barW = Math.max(1.5, (cw - gap * (WAVE_BARS - 1)) / WAVE_BARS);
      const styles = getComputedStyle(root);
      playedColor = styles.getPropertyValue('--voice-played').trim() || '#0a84ff';
      restColor = styles.getPropertyValue('--voice-rest').trim() || 'rgba(255,255,255,0.28)';
    }
    function draw() {
      ctx.clearRect(0, 0, cw, ch);
      const progress = duration ? Math.min(1, audio.currentTime / duration) : 0;
      for (let i = 0; i < WAVE_BARS; i++) {
        const v = peaks ? peaks[i] : 0.4;
        const h = Math.max(2, v * (ch - 4));
        const x = i * (barW + gap);
        ctx.fillStyle = (i + 0.5) / WAVE_BARS <= progress ? playedColor : restColor;
        // Rounded bars, vertically centered.
        const y = (ch - h) / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, barW, h, barW / 2);
        ctx.fill();
      }
    }
    measure();

    function updateTimeDisplay() {
      time.textContent = formatClock(duration ? Math.max(0, duration - audio.currentTime) : audio.currentTime);
    }

    function tick() {
      // The message list re-renders freely (pagination, reactions, channel
      // switches) and drops this card without any teardown hook. A detached
      // player must not keep talking from beyond the DOM — pause, which
      // also cancels this loop and releases the module refs via onStopped,
      // leaving the Audio object collectible.
      if (!root.isConnected) {
        audio.pause();
        return;
      }
      draw();
      updateTimeDisplay();
      if (!audio.paused && !audio.ended) rafId = requestAnimationFrame(tick);
    }

    btn.addEventListener('click', () => {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    });
    audio.addEventListener('play', () => {
      btn.innerHTML = ICON_PAUSE;
      btn.setAttribute('aria-label', 'Pause voice message');
      // Pause any other voice note that's currently playing — overlapping
      // voices are never what the listener wants.
      if (currentlyPlaying && currentlyPlaying !== audio) currentlyPlaying.pause();
      currentlyPlaying = audio;
      // Refresh cached colors once here so a theme/skin toggle since the
      // last measure is picked up — the frame loop itself never reads style.
      measure();
      rafId = requestAnimationFrame(tick);
    });
    const onStopped = () => {
      btn.innerHTML = ICON_PLAY;
      btn.setAttribute('aria-label', 'Play voice message');
      if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
      if (currentlyPlaying === audio) currentlyPlaying = null;
      if (audio.ended) audio.currentTime = 0;
      updateTimeDisplay();
      draw();
    };
    audio.addEventListener('pause', onStopped);
    audio.addEventListener('ended', onStopped);

    // Click-to-seek on the waveform. Refresh the time label too — while
    // paused there's no tick loop to pick the new position up.
    canvas.addEventListener('click', (ev) => {
      if (!duration) return;
      const rect = canvas.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
      audio.currentTime = frac * duration;
      updateTimeDisplay();
      draw();
    });

    // The initial measure() ran before layout settled (clientWidth 0 in the
    // detached node). A ResizeObserver re-measures once the canvas has a real
    // size and on any later resize / DPR change — the two moments the cached
    // geometry can go stale. It fires initially on observe(), covering the
    // first real paint, and self-stops when the node is GC'd (no teardown
    // hook needed, matching the rest of this card's lifecycle).
    new ResizeObserver(() => { measure(); draw(); }).observe(canvas);
    return root;
  }

  // Module-level "only one voice note plays at a time" pointer.
  let currentlyPlaying = null;

  window.HuddleVoiceNote = { VoiceNoteRecorder, renderVoiceAttachment };
})();
