// Noise-suppression pipeline. The audio analogue of blur-pipeline.js:
// it takes the raw microphone MediaStream in, runs it through a Web
// Audio graph that attenuates steady-state background noise, and emits
// a *new* MediaStream carrying a single, cleaned audio track that
// callers publish in place of the raw mic.
//
// Why Web Audio instead of an RNNoise WASM AudioWorklet:
//   The blur path vendors a real ML model (MediaPipe) because there's
//   a maintained npm package shipping the WASM + weights. There is no
//   comparable first-party RNNoise package we can `require.resolve`
//   from `scripts/copy-vendor.js` without hand-vendoring a binary blob
//   the maintainers would have to audit. So this first pass uses a
//   robust, dependency-free Web-Audio chain that runs entirely on the
//   audio thread:
//     1. High-pass biquad @ ~85 Hz — kills low-frequency rumble (fans,
//        AC hum, desk thumps) that sits below the voice band.
//     2. A noise-gate AudioWorklet — tracks a slow noise-floor estimate
//        and smoothly ducks the signal when it's near that floor (i.e.
//        you're not talking), while passing speech through untouched.
//   The interface (isAvailable / start -> processedStream / stop)
//   mirrors BlurPipeline exactly, so livekit.js drives both the same
//   way and a future RNNoise drop-in only has to swap the graph here.
//
// Usage:
//   const pipe = new DenoisePipeline();
//   const clean = await pipe.start(rawMicStream);
//   // ...publish `clean`'s single audio track to peers...
//   pipe.stop();
(function () {
  // The noise-gate runs as an AudioWorklet so the per-sample envelope
  // tracking happens on the realtime audio thread (no main-thread jank,
  // no ScriptProcessorNode deprecation). The processor source is
  // injected as a Blob URL rather than a separate vendored file — it's
  // a few dozen lines and keeping it inline avoids another copy-vendor
  // entry + an index.html <script>/asset reference for one worklet.
  const WORKLET_SOURCE = `
    // Per-sample noise gate with a slow noise-floor follower. Speech
    // bursts well above the tracked floor pass at full gain; sustained
    // low-level energy (room tone, fan) is pushed toward the floor and
    // gated down. Gain changes are smoothed (attack/release) so we
    // don't introduce zipper noise or chop word onsets.
    class NoiseGateProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        // Running estimates, all in linear amplitude (0..1-ish).
        this._floor = 0.0;      // slow-moving noise-floor estimate
        this._env = 0.0;        // fast envelope follower of the signal
        this._gain = 1.0;       // current applied gain, smoothed
        // Coefficients. These are per-sample smoothing factors tuned for
        // 48 kHz; they degrade gracefully at other rates (slightly
        // faster/slower envelopes) so we don't bother rescaling by
        // sampleRate. envAttack/Release shape the signal follower;
        // floorRate is deliberately glacial so a held note doesn't get
        // mistaken for noise. gainAttack/Release shape the gain ramp.
        this._envAttack = 0.01;
        this._envRelease = 0.0008;
        this._floorRate = 0.0004;
        this._gainAttack = 0.02;   // open quickly when speech starts
        this._gainRelease = 0.002; // close gently when it stops
      }
      process(inputs, outputs) {
        const input = inputs[0];
        const output = outputs[0];
        // No input connected this quantum (e.g. track ended) — emit
        // silence and keep the node alive.
        if (!input || input.length === 0) return true;
        const inCh = input[0];
        const outCh = output[0];
        if (!inCh || !outCh) return true;
        // Open the gate when the fast envelope is a comfortable margin
        // above the tracked floor (speech), close it when it sinks back
        // toward the floor (silence/room tone). The 2x margin + small
        // absolute offset avoids chattering on near-silent input.
        const OPEN_MARGIN = 2.0;
        const FLOOR_OFFSET = 0.0008;
        for (let i = 0; i < inCh.length; i++) {
          const x = inCh[i];
          const ax = x < 0 ? -x : x;
          // Fast envelope follower (asymmetric attack/release).
          if (ax > this._env) {
            this._env += (ax - this._env) * this._envAttack;
          } else {
            this._env += (ax - this._env) * this._envRelease;
          }
          // Noise floor only tracks slowly toward the envelope (so a
          // newly-quiet room is learned) but never fast enough to chase
          // speech up and gate it.
          this._floor += (this._env - this._floor) * this._floorRate;
          if (this._floor < 0) this._floor = 0;
          const threshold = this._floor * OPEN_MARGIN + FLOOR_OFFSET;
          const target = this._env > threshold ? 1.0 : 0.0;
          // Smooth the gain toward the target (attack when opening,
          // release when closing) to avoid clicks.
          const rate = target > this._gain ? this._gainAttack : this._gainRelease;
          this._gain += (target - this._gain) * rate;
          outCh[i] = x * this._gain;
        }
        // Mirror mono output to any extra output channels so we don't
        // silence one side of a stereo capture.
        for (let c = 1; c < output.length; c++) {
          if (output[c]) output[c].set(outCh);
        }
        return true;
      }
    }
    registerProcessor('huddle-noise-gate', NoiseGateProcessor);
  `;

  class DenoisePipeline {
    constructor() {
      this._rawStream = null;
      this._ctx = null;          // AudioContext
      this._source = null;       // MediaStreamAudioSourceNode
      this._highpass = null;     // BiquadFilterNode
      this._gate = null;         // AudioWorkletNode (noise gate)
      this._dest = null;         // MediaStreamAudioDestinationNode
      this._output = null;       // cleaned MediaStream we hand back
      this._workletUrl = null;   // Blob URL for the worklet module
    }

    // Web Audio + AudioWorklet are the only requirements; both ship in
    // every Chromium build Electron uses, so this is effectively always
    // true on desktop. We still gate on it (mirroring BlurPipeline's
    // isAvailable) so callers degrade gracefully on any stripped-down
    // runtime and the toggle can hide itself rather than throw.
    static isAvailable() {
      return typeof window.AudioContext === 'function'
        && typeof window.AudioWorkletNode === 'function'
        && typeof Blob === 'function'
        && typeof URL?.createObjectURL === 'function';
    }

    async start(rawStream) {
      if (!DenoisePipeline.isAvailable()) {
        throw new Error('Web Audio noise-suppression runtime not available');
      }
      const audioTrack = rawStream.getAudioTracks()[0];
      if (!audioTrack) throw new Error('denoise: input stream has no audio track');
      this._rawStream = rawStream;

      // Lock the graph to the capture sample rate where the track
      // exposes it, so MediaStreamAudioSourceNode doesn't resample on
      // the way in (a needless quality hit + a few ms of latency).
      const settings = audioTrack.getSettings?.() || {};
      const ctx = settings.sampleRate
        ? new AudioContext({ sampleRate: settings.sampleRate })
        : new AudioContext();
      this._ctx = ctx;

      // Register the noise-gate worklet from an inline Blob module.
      this._workletUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
      );
      await ctx.audioWorklet.addModule(this._workletUrl);

      // Build the graph: source -> highpass -> gate -> destination.
      this._source = ctx.createMediaStreamSource(rawStream);
      this._highpass = ctx.createBiquadFilter();
      this._highpass.type = 'highpass';
      this._highpass.frequency.value = 85;   // below the voice fundamental
      this._highpass.Q.value = 0.707;        // Butterworth (flat passband)
      this._gate = new AudioWorkletNode(ctx, 'huddle-noise-gate');
      this._dest = ctx.createMediaStreamDestination();
      this._source.connect(this._highpass);
      this._highpass.connect(this._gate);
      this._gate.connect(this._dest);

      // Some Electron/Chromium versions create the context suspended
      // until a user gesture; the toggle click that drives start()
      // satisfies the gesture requirement, so resume eagerly. Ignore
      // the rejection if it's already running.
      try { await ctx.resume(); } catch {}

      // Output carries exactly the cleaned audio track. We deliberately
      // do NOT reattach the raw audio track — unlike blur (which keeps
      // the original *audio* flowing past the canvas video), this IS the
      // audio path, so the destination's processed track is the only one
      // we want published.
      this._output = this._dest.stream;
      return this._output;
    }

    stop() {
      // Disconnect nodes first so the graph stops pulling from the mic,
      // then close the context to free the audio thread. Each step is
      // guarded — stop() must be safe to call from teardown paths even
      // if start() half-failed.
      try { this._source?.disconnect(); } catch {}
      try { this._highpass?.disconnect(); } catch {}
      try { this._gate?.disconnect(); } catch {}
      try { this._dest?.disconnect(); } catch {}
      this._source = null;
      this._highpass = null;
      this._gate = null;
      this._dest = null;
      if (this._ctx) {
        try { this._ctx.close(); } catch {}
        this._ctx = null;
      }
      if (this._workletUrl) {
        try { URL.revokeObjectURL(this._workletUrl); } catch {}
        this._workletUrl = null;
      }
      if (this._output) {
        // The destination's track is synthetic; stop it so the LK sender
        // sees the track end cleanly after its replaceTrack swap, exactly
        // as the blur pipeline stops its canvas track.
        for (const t of this._output.getAudioTracks()) {
          try { t.stop(); } catch {}
        }
      }
      this._output = null;
      this._rawStream = null;
    }
  }

  window.DenoisePipeline = DenoisePipeline;
})();
