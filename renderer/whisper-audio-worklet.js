// AudioWorklet processor for whisper.cpp caption capture. Runs on the
// audio render thread so it can't block the renderer's main thread.
//
// The renderer creates the AudioContext with `{ sampleRate: 16000 }`,
// so the input frames arrive already-resampled by Chromium's internal
// polyphase resampler (proper anti-aliased downsampling, way better
// than the simple decimation we used to do here). This worklet just
// buffers chunks of the right length and posts them back to the
// renderer, which encodes a WAV header and ships to main.
//
// Earlier iterations did the resampling here — naive neighborhood
// averaging without a low-pass pre-filter, which aliased high
// frequencies into the speech band and hurt whisper accuracy.
// Browser-side resampling removed that artifact.

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 1.5;
const CHUNK_SAMPLES = TARGET_SAMPLE_RATE * CHUNK_SECONDS;

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK_SAMPLES);
    this.bufferIdx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    // Copy as many samples as fit into the current buffer; spill the
    // remainder into the next chunk after emitting.
    let inIdx = 0;
    while (inIdx < channel.length) {
      const room = CHUNK_SAMPLES - this.bufferIdx;
      const take = Math.min(room, channel.length - inIdx);
      this.buffer.set(channel.subarray(inIdx, inIdx + take), this.bufferIdx);
      this.bufferIdx += take;
      inIdx += take;
      if (this.bufferIdx >= CHUNK_SAMPLES) {
        const out = this.buffer;
        this.port.postMessage({ chunk: out.buffer }, [out.buffer]);
        this.buffer = new Float32Array(CHUNK_SAMPLES);
        this.bufferIdx = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PCMCaptureProcessor);
