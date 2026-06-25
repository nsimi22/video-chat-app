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
  // no ScriptProcessorNode deprecation). The processor source lives in a
  // standalone same-origin file (renderer/denoise-worklet.js) loaded via
  // addModule(). It is deliberately NOT injected as a `blob:` module: the
  // renderer's CSP is `script-src 'self' 'wasm-unsafe-eval'` (no `blob:`)
  // and addModule fetches the worklet through that same directive, so a
  // blob URL would be CSP-blocked and reject on every enable. Resolving
  // the path against document.baseURI keeps it correct in the popout
  // window too (it loads the same index.html, only with a query string).
  // The denoiser runs RNNoise (a small recurrent-NN model) as an AudioWorklet
  // so inference happens on the realtime audio thread. rnnoise-worklet.js is
  // @jitsi/rnnoise-wasm's sync glue (wasm inlined as base64) + our processor —
  // see renderer/rnnoise-processor.js for the regeneration command. It is a
  // same-origin file loaded via addModule(), CSP-safe (script-src 'self'
  // 'wasm-unsafe-eval' — the worklet instantiates wasm, which the directive
  // permits; no blob: needed). Path resolved against document.baseURI so the
  // popout window (same index.html + query string) loads it correctly too.
  const WORKLET_URL = new URL('rnnoise-worklet.js', document.baseURI).href;

  class DenoisePipeline {
    constructor() {
      this._rawStream = null;
      this._ctx = null;          // AudioContext (forced to 48 kHz for RNNoise)
      this._source = null;       // MediaStreamAudioSourceNode
      this._rnnoise = null;      // AudioWorkletNode (RNNoise denoiser)
      this._dest = null;         // MediaStreamAudioDestinationNode
      this._output = null;       // cleaned MediaStream we hand back
    }

    // Web Audio + AudioWorklet are the only requirements; both ship in
    // every Chromium build Electron uses, so this is effectively always
    // true on desktop. We still gate on it (mirroring BlurPipeline's
    // isAvailable) so callers degrade gracefully on any stripped-down
    // runtime and the toggle can hide itself rather than throw.
    static isAvailable() {
      return typeof window.AudioContext === 'function'
        && typeof window.AudioWorkletNode === 'function';
    }

    async start(rawStream) {
      if (!DenoisePipeline.isAvailable()) {
        throw new Error('Web Audio noise-suppression runtime not available');
      }
      const audioTrack = rawStream.getAudioTracks()[0];
      if (!audioTrack) throw new Error('denoise: input stream has no audio track');
      this._rawStream = rawStream;

      // RNNoise REQUIRES 48 kHz mono — its 480-sample frames are 10 ms at
      // 48k. Force the AudioContext to 48 kHz; Web Audio resamples the mic
      // source into the context rate for us, so a 44.1 kHz device just gets
      // resampled on the way in. If the backend can't open 48k (rare —
      // virtual/aggregate devices), fall back to the default-rate context;
      // RNNoise would then run at the wrong rate, so bail to passthrough by
      // throwing rather than degrade silently.
      let ctx;
      try {
        ctx = new AudioContext({ sampleRate: 48000 });
      } catch (err) {
        console.warn('[denoise] AudioContext @48kHz unsupported', err);
        throw new Error('denoise: 48 kHz AudioContext unavailable');
      }
      // Chromium doesn't throw when it can't honor the requested rate — it
      // hands back a context at the device's native rate. RNNoise's 480-sample
      // frames are only 10 ms at 48k, so a mismatched rate would denoise
      // incorrectly. Verify the realized rate and bail to passthrough instead.
      if (ctx.sampleRate !== 48000) {
        try { ctx.close(); } catch {}
        throw new Error('denoise: could not obtain a 48 kHz AudioContext');
      }
      this._ctx = ctx;

      // Register the RNNoise worklet from its same-origin module file
      // (CSP-safe — see WORKLET_URL note above).
      await ctx.audioWorklet.addModule(WORKLET_URL);

      // Build the graph: source -> rnnoise -> destination. RNNoise handles
      // low-frequency rumble itself, so no separate highpass stage.
      this._source = ctx.createMediaStreamSource(rawStream);
      this._rnnoise = new AudioWorkletNode(ctx, 'huddle-rnnoise');
      this._dest = ctx.createMediaStreamDestination();
      this._source.connect(this._rnnoise);
      this._rnnoise.connect(this._dest);

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
      try { this._rnnoise?.disconnect(); } catch {}
      try { this._dest?.disconnect(); } catch {}
      this._source = null;
      this._rnnoise = null;
      this._dest = null;
      if (this._ctx) {
        try { this._ctx.close(); } catch {}
        this._ctx = null;
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
