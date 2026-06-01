// WhisperTranscriptManager — drop-in replacement for the old
// `TranscriptManager` (Web Speech API). Captures the local mic, chunks
// into 1.5s slices of 16 kHz mono PCM via an AudioWorklet, ships each
// chunk over IPC to main where whisper.cpp runs on it, and surfaces
// returned text through the same `onFinal` callback that the old SR
// manager used. The renderer keeps the broadcast plumbing (Supabase
// Realtime → other call participants) so swapping engines doesn't
// touch the receiving side.
//
// onInterim is exposed for API parity but never fires — whisper.cpp is
// batch per chunk, not streaming. Interim text would mean running a
// second engine with smaller chunks; not worth the cost for v1.
(function () {
  const TARGET_SAMPLE_RATE = 16000;

  // Floats are clamped to [-1, 1] then mapped to int16 [-32768, 32767]
  // and packed little-endian alongside a minimal RIFF/WAVE header. The
  // ~50-byte header is the same for every chunk; we rebuild it inline
  // rather than caching to keep the encoder stateless.
  function encodeWav(pcmFloat32, sampleRate) {
    const n = pcmFloat32.length;
    const buffer = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buffer);
    // 'RIFF'
    view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46);
    view.setUint32(4, 36 + n * 2, true);
    // 'WAVE'
    view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45);
    // 'fmt '
    view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20);
    view.setUint32(16, 16, true);    // PCM subchunk size
    view.setUint16(20, 1, true);     // PCM format
    view.setUint16(22, 1, true);     // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);     // block align
    view.setUint16(34, 16, true);    // bits per sample
    // 'data'
    view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61);
    view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, pcmFloat32[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  // ──────────────────────────────────────────────────────────────
  // Shared IPC subscription — `huddle.whisperEngine.onCaptionLine`
  // delivers caption-line events for ALL chunks (regardless of which
  // manager instance posted them). We route to the in-flight manager
  // by the chunk id baked into the IPC roundtrip.
  // ──────────────────────────────────────────────────────────────
  const pending = new Map(); // chunkId → manager
  let captionLineUnsub = null;
  function ensureCaptionLineSubscription() {
    if (captionLineUnsub) return;
    if (!window.huddle?.whisperEngine?.onCaptionLine) return;
    captionLineUnsub = window.huddle.whisperEngine.onCaptionLine((payload) => {
      const mgr = pending.get(payload.chunkId);
      if (!mgr) return;
      pending.delete(payload.chunkId);
      mgr._emitFinal(payload);
    });
  }

  let nextChunkId = 1;

  class WhisperTranscriptManager {
    constructor() {
      this.handlers = { final: [], interim: [] };
      this.active = false;
      this.stream = null;
      this.ctx = null;
      this.workletNode = null;
      this.sourceNode = null;
    }

    // Match the old SR manager's surface — `isSupported()` answers
    // whether the captions sidecar can run at all (binary bundled +
    // model present). Renderer's CC gate also checks this before
    // calling start(), but exposing it keeps the contract symmetric.
    static async isSupported() {
      if (!window.huddle?.getWhisperBinaryStatus || !window.huddle?.whisperModel) {
        return false;
      }
      try {
        const [bin, model] = await Promise.all([
          window.huddle.getWhisperBinaryStatus(),
          window.huddle.whisperModel.getStatus(),
        ]);
        return !!bin?.available && model?.status === 'ready';
      } catch { return false; }
    }

    onFinal(cb)   { this.handlers.final.push(cb); }
    onInterim(cb) { this.handlers.interim.push(cb); }

    async start() {
      if (this.active) return false;
      this.active = true;
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
          video: false,
        });
      } catch (err) {
        console.warn('[whisper] mic open failed', err);
        this.active = false;
        return false;
      }
      try {
        this.ctx = new AudioContext();
        await this.ctx.audioWorklet.addModule('whisper-audio-worklet.js');
        this.sourceNode = this.ctx.createMediaStreamSource(this.stream);
        this.workletNode = new AudioWorkletNode(this.ctx, 'pcm-capture');
        this.workletNode.port.onmessage = (evt) => this._onChunk(evt.data);
        this.sourceNode.connect(this.workletNode);
        // Worklet must be in the graph somewhere to pull frames; pipe
        // to a muted gain so we don't echo the mic into the speakers.
        const sink = this.ctx.createGain();
        sink.gain.value = 0;
        this.workletNode.connect(sink).connect(this.ctx.destination);
        ensureCaptionLineSubscription();
      } catch (err) {
        console.warn('[whisper] audio graph setup failed', err);
        this.stop();
        return false;
      }
      return true;
    }

    stop() {
      this.active = false;
      // AudioWorkletNode.port is a MessagePort; closing it is a no-op
      // for our purposes since disconnecting the node above stops
      // process() from firing. Just null out the handler so any in-
      // flight messages from the audio thread don't process post-stop.
      if (this.workletNode) this.workletNode.port.onmessage = null;
      try { this.workletNode?.disconnect?.(); } catch {}
      try { this.sourceNode?.disconnect?.(); } catch {}
      try { this.ctx?.close?.(); } catch {}
      this.workletNode = null;
      this.sourceNode = null;
      this.ctx = null;
      const tracks = this.stream?.getTracks?.() || [];
      for (const t of tracks) { try { t.stop(); } catch {} }
      this.stream = null;
      // Drop any pending entries we own so a future restart doesn't
      // route their late callbacks back into this dead manager.
      for (const [id, mgr] of pending) {
        if (mgr === this) pending.delete(id);
      }
    }

    async _onChunk({ chunk }) {
      if (!this.active) return;
      const float32 = new Float32Array(chunk);
      // Skip near-silent chunks — saves a whisper invocation that would
      // produce no useful text. Threshold is RMS over the chunk; <0.005
      // (~-46 dBFS) corresponds to a quiet room with no speech.
      let sumSq = 0;
      for (let i = 0; i < float32.length; i++) sumSq += float32[i] * float32[i];
      const rms = Math.sqrt(sumSq / float32.length);
      if (rms < 0.005) return;

      const wavBuffer = encodeWav(float32, TARGET_SAMPLE_RATE);
      const chunkId = String(nextChunkId++);
      pending.set(chunkId, this);
      try {
        await window.huddle.whisperEngine.transcribeChunk({
          chunkId,
          isLocal: true,
          // ArrayBuffer goes over IPC by structured clone (Electron uses
          // the V8 serializer for invoke args) — the renderer side keeps
          // its own copy until the worklet next reuses the underlying
          // memory, which is fine since we re-allocate per chunk.
          wavBuffer,
        });
      } catch (err) {
        pending.delete(chunkId);
        console.warn('[whisper] transcribe-chunk dispatch failed', err);
      }
    }

    _emitFinal(payload) {
      if (!this.active) return;
      const text = (payload?.text || '').trim();
      if (!text) return;
      // Filter out the canonical whisper hallucination on silence — the
      // "[BLANK_AUDIO]" / "( silence )" / "[Music]" / "Thank you." that
      // tiny.en spits out for noisy-but-speechless chunks. Add more as
      // we see them in the wild.
      if (/^\[?\(?\s*(blank_audio|silence|music|inaudible|laughter)\s*\)?\]?\.?$/i.test(text)) return;
      if (/^thank you\.?$/i.test(text) && text.length < 12) return;
      for (const cb of this.handlers.final) {
        try { cb(text); } catch {}
      }
    }
  }

  window.HuddleWhisperTranscript = { WhisperTranscriptManager };
})();
