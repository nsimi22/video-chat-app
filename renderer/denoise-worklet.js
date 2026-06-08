// Noise-gate AudioWorklet processor for DenoisePipeline (see
// denoise-pipeline.js). This MUST be a standalone file rather than an
// inline Blob module: the renderer runs under a strict CSP
// (`script-src 'self' 'wasm-unsafe-eval'` in index.html, no `blob:`),
// and `audioWorklet.addModule()` fetches its module through that same
// directive — a `blob:` worklet URL is blocked, so addModule rejects and
// the whole feature throws on every enable. Shipping the worklet as a
// real same-origin file keeps the CSP strict (no `blob:` relaxation) and
// lets addModule load it from `'self'`. It is loaded only via
// addModule('denoise-worklet.js'), never as an index.html <script>.
//
// Per-sample noise gate with a slow noise-floor follower. Speech bursts
// well above the tracked floor pass at full gain; sustained low-level
// energy (room tone, fan) is pushed toward the floor and gated down.
// Gain changes are smoothed (attack/release) so we don't introduce
// zipper noise or chop word onsets.
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
    // gainAttack/Release shape the gain ramp.
    this._envAttack = 0.01;
    this._envRelease = 0.0008;
    // floorRate is the per-SAMPLE one-pole coefficient for the
    // noise-floor follower. For a one-pole smoother `y += (x-y)*k` the
    // time constant is tau = 1 / (k * fs). The previous value 0.0004 at
    // 48 kHz gave tau = 1/(0.0004*48000) ~= 52 ms, so the floor caught
    // up to active speech within ~100-200 ms and the gate threshold
    // (floor * OPEN_MARGIN) climbed to meet the speech envelope —
    // closing the gate mid-sentence and muting the speaker. We want the
    // floor to be GLACIAL: it should learn steady room tone over several
    // seconds but never react fast enough to chase a held note upward.
    //   target tau ~= 6 s  ->  k = 1 / (tau * fs)
    //                          = 1 / (6 * 48000) ~= 3.47e-6
    // Rounded to 0.000003 (tau ~= 6.9 s @ 48 kHz). The follower updates
    // once per input SAMPLE inside process() (not once per block), so
    // this per-sample coefficient needs no per-quantum rescaling.
    this._floorRate = 0.000003;
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
    // When the gate is "closed" we attenuate to this floor instead of full
    // silence. A hard mute (target 0.0) chopped speech in and out on pauses,
    // breaths, and quiet passages — most noticeable on recorded clips. ~-18 dB
    // still pushes room tone/fan well down while keeping the signal CONTINUOUS,
    // i.e. a downward expander rather than a hard gate.
    const GATE_FLOOR = 0.12; // ~-18 dB; 1.0 = fully open
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
      const target = this._env > threshold ? 1.0 : GATE_FLOOR;
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
