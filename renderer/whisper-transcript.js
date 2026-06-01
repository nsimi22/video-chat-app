// WhisperTranscriptManager — multi-track captions engine. Replaces
// the dead Web Speech API engine with a whisper.cpp sidecar.
//
// One enabler's machine transcribes EVERY audio source in the call:
//   - the local mic (via getUserMedia)
//   - each remote participant's published audio track (via the LK
//     Room's RemoteAudioTrack.mediaStreamTrack)
// so a single CC toggle gives the whole room captions. Per-chunk text
// is emitted through onFinal with full speaker attribution; the caller
// rebroadcasts via Supabase Realtime so non-enablers also see the
// captions panel light up.
//
// Each tracked source has its own AudioWorkletNode in a shared
// AudioContext. The worklet downsamples to 16 kHz mono Float32 + posts
// 1.5s chunks; we encode each chunk as 16-bit PCM WAV and ship to main
// via IPC. main spawns whisper-cli and replies with caption-line
// events tagged by chunkId.
//
// onInterim is exposed for API parity but never fires — whisper.cpp is
// batch per chunk, not streaming.
(function () {
  const TARGET_SAMPLE_RATE = 16000;

  function encodeWav(pcmFloat32, sampleRate) {
    const n = pcmFloat32.length;
    const buffer = new ArrayBuffer(44 + n * 2);
    const view = new DataView(buffer);
    view.setUint8(0, 0x52); view.setUint8(1, 0x49); view.setUint8(2, 0x46); view.setUint8(3, 0x46);
    view.setUint32(4, 36 + n * 2, true);
    view.setUint8(8, 0x57); view.setUint8(9, 0x41); view.setUint8(10, 0x56); view.setUint8(11, 0x45);
    view.setUint8(12, 0x66); view.setUint8(13, 0x6d); view.setUint8(14, 0x74); view.setUint8(15, 0x20);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    view.setUint8(36, 0x64); view.setUint8(37, 0x61); view.setUint8(38, 0x74); view.setUint8(39, 0x61);
    view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, pcmFloat32[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  // Shared IPC subscription. caption-line events fire for every chunk
  // posted by ANY manager instance; we route to the manager that owns
  // the chunkId. Manager.stop() cleans up its own pending entries so a
  // late reply doesn't fire on a torn-down manager.
  const pending = new Map(); // chunkId → { manager, meta }
  let captionLineUnsub = null;
  function ensureCaptionLineSubscription() {
    if (captionLineUnsub) return;
    if (!window.huddle?.whisperEngine?.onCaptionLine) return;
    captionLineUnsub = window.huddle.whisperEngine.onCaptionLine((payload) => {
      const entry = pending.get(payload.chunkId);
      if (!entry) return;
      pending.delete(payload.chunkId);
      entry.manager._emitFinal(payload, entry.meta);
    });
  }

  let nextChunkId = 1;

  class WhisperTranscriptManager {
    constructor() {
      this.handlers = { final: [], interim: [] };
      this.active = false;
      this.ctx = null;
      this.sink = null;
      // participantId → { sourceNode, workletNode, fromName, isLocal,
      //                   stream, audioTrack? } — audioTrack present
      // only for local mic so we can stop() it on teardown.
      this.tracks = new Map();
      this.room = null;
      this._roomListeners = null;
    }

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

    // `room` is the LiveKit Room exposed by LivekitCallClient. When
    // provided, we also subscribe to every remote audio track so a
    // single CC toggle captions the whole call. Pass null to capture
    // only the local mic (fallback when LK isn't available — captions
    // still work for the enabler's own speech).
    //
    // `localMeta` lets the caller stamp the local mic's chunks with
    // the right peer identity + name (state.huddle.peerId / .name).
    // Without it, lines fire with from=null and the receiver-side
    // rendering would attribute them to "someone".
    async start(room, localMeta) {
      if (this.active) return false;
      this.active = true;
      try {
        this.ctx = new AudioContext();
        await this.ctx.audioWorklet.addModule('whisper-audio-worklet.js');
        // One shared muted sink keeps every worklet in the audio graph
        // (worklets need a downstream node to pull frames) without
        // feeding any captured audio back to the user's speakers.
        this.sink = this.ctx.createGain();
        this.sink.gain.value = 0;
        this.sink.connect(this.ctx.destination);
        ensureCaptionLineSubscription();
      } catch (err) {
        console.warn('[whisper] audio context setup failed', err);
        this.stop();
        return false;
      }

      // Local mic.
      try {
        const localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
          video: false,
        });
        this._addTrack({
          participantId: localMeta?.participantId || 'local',
          fromName:      localMeta?.fromName || 'You',
          isLocal:       true,
          stream:        localStream,
          isOwnedStream: true,
        });
      } catch (err) {
        console.warn('[whisper] local mic open failed', err);
        // Continue with remote-only capture if the user denied the mic.
      }

      if (room) {
        this.room = room;
        this._attachRoom(room);
      }

      return true;
    }

    _attachRoom(room) {
      // Bootstrap: every audio track that's already subscribed.
      for (const participant of room.remoteParticipants.values()) {
        for (const pub of participant.trackPublications.values()) {
          if (pub.kind === 'audio' && pub.isSubscribed && pub.track?.mediaStreamTrack) {
            this._addRemoteTrack(participant, pub.track);
          }
        }
      }
      const RE = window.LivekitClient?.RoomEvent || window.LK?.RoomEvent;
      if (!RE) return; // LK globals unavailable; bootstrap-only mode
      const onSub = (track, _pub, participant) => {
        if (track.kind === 'audio' && track.mediaStreamTrack) {
          this._addRemoteTrack(participant, track);
        }
      };
      const onUnsub = (_track, _pub, participant) => {
        this._removeTrack(participant.identity);
      };
      const onLeft = (participant) => this._removeTrack(participant.identity);
      room.on(RE.TrackSubscribed, onSub);
      room.on(RE.TrackUnsubscribed, onUnsub);
      room.on(RE.ParticipantDisconnected, onLeft);
      this._roomListeners = { RE, onSub, onUnsub, onLeft };
    }

    _addRemoteTrack(participant, track) {
      // Skip if we're already capturing this participant.
      if (this.tracks.has(participant.identity)) return;
      // LiveKit's RemoteAudioTrack hands us a raw MediaStreamTrack —
      // wrap into a MediaStream so createMediaStreamSource accepts it.
      const stream = new MediaStream([track.mediaStreamTrack]);
      this._addTrack({
        participantId: participant.identity,
        fromName:      participant.name || participant.identity,
        isLocal:       false,
        stream,
        isOwnedStream: false, // don't stop the underlying track on teardown — LK owns it
      });
    }

    _addTrack({ participantId, fromName, isLocal, stream, isOwnedStream }) {
      if (!this.ctx || !this.active) return;
      try {
        const sourceNode = this.ctx.createMediaStreamSource(stream);
        const workletNode = new AudioWorkletNode(this.ctx, 'pcm-capture');
        const meta = { participantId, fromName, isLocal };
        workletNode.port.onmessage = (evt) => this._onChunk(evt.data, meta);
        sourceNode.connect(workletNode);
        workletNode.connect(this.sink);
        this.tracks.set(participantId, { sourceNode, workletNode, stream, isOwnedStream, ...meta });
      } catch (err) {
        console.warn('[whisper] addTrack failed for', participantId, err);
      }
    }

    _removeTrack(participantId) {
      const entry = this.tracks.get(participantId);
      if (!entry) return;
      this.tracks.delete(participantId);
      try { entry.workletNode.port.onmessage = null; } catch {}
      try { entry.workletNode.disconnect(); } catch {}
      try { entry.sourceNode.disconnect(); } catch {}
      if (entry.isOwnedStream) {
        for (const t of entry.stream.getTracks?.() || []) {
          try { t.stop(); } catch {}
        }
      }
    }

    stop() {
      this.active = false;
      for (const id of [...this.tracks.keys()]) this._removeTrack(id);
      if (this.room && this._roomListeners) {
        const { RE, onSub, onUnsub, onLeft } = this._roomListeners;
        try { this.room.off?.(RE.TrackSubscribed, onSub); } catch {}
        try { this.room.off?.(RE.TrackUnsubscribed, onUnsub); } catch {}
        try { this.room.off?.(RE.ParticipantDisconnected, onLeft); } catch {}
      }
      this._roomListeners = null;
      this.room = null;
      try { this.sink?.disconnect(); } catch {}
      try { this.ctx?.close?.(); } catch {}
      this.sink = null;
      this.ctx = null;
      for (const [id, entry] of pending) {
        if (entry.manager === this) pending.delete(id);
      }
    }

    async _onChunk({ chunk }, meta) {
      if (!this.active) return;
      const float32 = new Float32Array(chunk);
      let sumSq = 0;
      for (let i = 0; i < float32.length; i++) sumSq += float32[i] * float32[i];
      const rms = Math.sqrt(sumSq / float32.length);
      if (rms < 0.005) return;

      const wavBuffer = encodeWav(float32, TARGET_SAMPLE_RATE);
      const chunkId = String(nextChunkId++);
      pending.set(chunkId, { manager: this, meta });
      try {
        await window.huddle.whisperEngine.transcribeChunk({
          chunkId,
          participantId: meta.participantId,
          fromName:      meta.fromName,
          isLocal:       meta.isLocal,
          wavBuffer,
        });
      } catch (err) {
        pending.delete(chunkId);
        console.warn('[whisper] transcribe-chunk dispatch failed', err);
      }
    }

    _emitFinal(payload, meta) {
      if (!this.active) return;
      const text = (payload?.text || '').trim();
      if (!text) return;
      if (/^\[?\(?\s*(blank_audio|silence|music|inaudible|laughter)\s*\)?\]?\.?$/i.test(text)) return;
      if (/^thank you\.?$/i.test(text) && text.length < 12) return;
      const line = {
        text,
        from:     payload.participantId || meta?.participantId || null,
        fromName: payload.fromName      || meta?.fromName      || null,
        isLocal:  payload.isLocal       ?? meta?.isLocal       ?? false,
      };
      for (const cb of this.handlers.final) {
        try { cb(line); } catch {}
      }
    }
  }

  window.HuddleWhisperTranscript = { WhisperTranscriptManager };
})();
