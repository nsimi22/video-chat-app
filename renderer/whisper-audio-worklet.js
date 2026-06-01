// AudioWorklet processor for whisper.cpp caption capture. Runs on the
// audio render thread so it can't block the renderer's main thread.
// Downsamples the input mic stream (typically 48 kHz from
// `getUserMedia`) to whisper.cpp's expected 16 kHz mono Float32, buffers
// `CHUNK_SECONDS` of audio, then posts the completed chunk back to the
// renderer over the worklet `port`. Renderer encodes the WAV header and
// ships the buffer to main for inference.
//
// Resampling is a simple ratio decimation with neighborhood averaging —
// good enough for ASR-grade input where small spectral artifacts don't
// hurt token accuracy. Real low-pass filtering would be cleaner but
// adds latency + CPU; whisper's mel front-end already smooths the
// spectrum.

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SECONDS = 1.5;
const CHUNK_SAMPLES = TARGET_SAMPLE_RATE * CHUNK_SECONDS;

class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK_SAMPLES);
    this.bufferIdx = 0;
    this.resampleRatio = sampleRate / TARGET_SAMPLE_RATE;
    this.inputCursor = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    while (this.inputCursor < channel.length) {
      const startF = this.inputCursor;
      const endF = Math.min(channel.length, startF + this.resampleRatio);
      const startI = Math.floor(startF);
      const endI = Math.min(channel.length, Math.ceil(endF));
      let sum = 0;
      let count = 0;
      for (let i = startI; i < endI; i++) {
        sum += channel[i];
        count++;
      }
      this.buffer[this.bufferIdx++] = count > 0 ? sum / count : 0;
      this.inputCursor += this.resampleRatio;

      if (this.bufferIdx >= CHUNK_SAMPLES) {
        const out = this.buffer;
        this.port.postMessage({ chunk: out.buffer }, [out.buffer]);
        this.buffer = new Float32Array(CHUNK_SAMPLES);
        this.bufferIdx = 0;
      }
    }
    this.inputCursor -= channel.length;
    return true;
  }
}

registerProcessor('pcm-capture', PCMCaptureProcessor);
