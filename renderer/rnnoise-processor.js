// ===========================================================================
// RNNoise AudioWorkletProcessor — the hand-written half of rnnoise-worklet.js.
//
// rnnoise-worklet.js (what addModule actually loads) is GENERATED, not edited
// by hand: it is @jitsi/rnnoise-wasm's `dist/rnnoise-sync.js` (the sync glue
// with the wasm inlined as base64 — the build the README marks as safe for an
// AudioWorklet) with its two ESM-only constructs neutralized, followed by this
// file. Regenerate after bumping the dep:
//
//   sed -e 's|import\.meta\.url|""|g' \
//       node_modules/@jitsi/rnnoise-wasm/dist/rnnoise-sync.js \
//     | sed '/^export default createRNNWasmModuleSync;/d' > /tmp/rnnoise-glue.js
//   cat /tmp/rnnoise-glue.js renderer/rnnoise-processor.js > renderer/rnnoise-worklet.js
//
// The glue leaves `createRNNWasmModuleSync` in the worklet's global scope; we
// instantiate it synchronously here (no fetch — the wasm is embedded).
//
// RNNoise operates on 480-sample (10 ms) frames at 48 kHz, mono, with samples
// in the INT16 amplitude range (-32768..32767) expressed as floats — NOT the
// -1..1 Web Audio range — so we scale on the way in and back out. The render
// quantum is 128 samples, so we buffer input into 480-frames and drain the
// denoised output through a small ring (one-frame ≈10 ms latency).
// ===========================================================================
class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.FRAME = 480;
    this.SCALE = 0x8000; // 32768 — int16 full-scale
    this.ready = false;
    try {
      // Synchronous instantiation (embedded wasm). Returns the emscripten
      // Module with the rnnoise_* exports + heap views.
      this.mod = createRNNWasmModuleSync();
      this.state = this.mod._rnnoise_create(0); // 0 = built-in model
      this.framePtr = this.mod._malloc(this.FRAME * 4); // Float32 scratch
      this.inBuf = new Float32Array(this.FRAME);
      this.inLen = 0;
      // Output ring — generous so a slow quantum can't overrun it.
      this.ring = new Float32Array(this.FRAME * 8);
      this.rRead = 0; this.rWrite = 0; this.rCount = 0;
      this.ready = true;
    } catch (err) {
      // If anything in load/instantiate fails, process() falls back to a
      // clean passthrough so the mic is never dropped — denoise just no-ops.
      // eslint-disable-next-line no-console
      console.error('[rnnoise] init failed, passing audio through', err);
      this.ready = false;
    }
  }

  _ringPush(v) {
    if (this.rCount >= this.ring.length) return; // full — drop (shouldn't happen)
    this.ring[this.rWrite] = v;
    this.rWrite = (this.rWrite + 1) % this.ring.length;
    this.rCount++;
  }
  _ringShift() {
    if (this.rCount === 0) return 0;
    const v = this.ring[this.rRead];
    this.rRead = (this.rRead + 1) % this.ring.length;
    this.rCount--;
    return v;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const outCh = output[0];
    const input = inputs[0];
    const inCh = input && input[0] ? input[0] : null;

    if (!this.ready) {
      if (inCh) outCh.set(inCh); // passthrough
      return true;
    }

    if (inCh) {
      // HEAPF32 view can be replaced if the wasm heap grows; re-read it.
      const heap = this.mod.HEAPF32;
      const base = this.framePtr >> 2;
      for (let i = 0; i < inCh.length; i++) {
        this.inBuf[this.inLen++] = inCh[i];
        if (this.inLen === this.FRAME) {
          for (let j = 0; j < this.FRAME; j++) heap[base + j] = this.inBuf[j] * this.SCALE;
          this.mod._rnnoise_process_frame(this.state, this.framePtr, this.framePtr);
          for (let j = 0; j < this.FRAME; j++) this._ringPush(heap[base + j] / this.SCALE);
          this.inLen = 0;
        }
      }
    }

    // Drain denoised samples; emit silence only during the initial ~10 ms
    // fill (ring empty) so we never output garbage.
    for (let i = 0; i < outCh.length; i++) outCh[i] = this._ringShift();
    for (let c = 1; c < output.length; c++) if (output[c]) output[c].set(outCh);
    return true;
  }
}
registerProcessor('huddle-rnnoise', RNNoiseProcessor);
