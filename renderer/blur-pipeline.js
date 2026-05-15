// Background-blur pipeline. Wraps MediaPipe Selfie Segmentation: each
// camera frame is run through the segmentation model, then composited
// onto a hidden canvas (blurred copy of the full frame, with sharp
// person pixels punched back in using the segmentation mask). The
// canvas is exposed as a MediaStream via captureStream(), with the
// original stream's audio tracks reattached so callers can publish a
// single composite stream to WebRTC.
//
// Usage:
//   const pipe = new BlurPipeline();
//   const blurred = await pipe.start(rawStream);
//   // ...send `blurred` to peers; raw stream's mic track is still
//   // the audio source, so existing mute toggles keep working.
//   pipe.stop();
(function () {
  const VENDOR_PATH = 'vendor/mediapipe/selfie_segmentation/';
  const DEFAULT_FPS = 30;
  const BLUR_PX = 10;

  class BlurPipeline {
    constructor() {
      this._rawStream = null;
      this._sourceVideo = null;
      this._canvas = document.createElement('canvas');
      this._ctx = this._canvas.getContext('2d');
      this._seg = null;
      this._running = false;
      this._output = null;
    }

    static isAvailable() {
      return typeof window.SelfieSegmentation === 'function';
    }

    async start(rawStream, { fps = DEFAULT_FPS } = {}) {
      if (!BlurPipeline.isAvailable()) {
        throw new Error('SelfieSegmentation runtime not loaded');
      }
      this._rawStream = rawStream;

      // Hidden <video> playing the raw camera — MediaPipe pulls frames
      // from this element each tick. Muted + playsInline so autoplay
      // policies don't block, no DOM attachment needed.
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = rawStream;
      this._sourceVideo = video;
      await new Promise((resolve, reject) => {
        const onReady = () => { video.removeEventListener('loadedmetadata', onReady); resolve(); };
        video.addEventListener('loadedmetadata', onReady, { once: true });
        video.addEventListener('error', () => reject(new Error('source video failed')), { once: true });
      });
      await video.play();

      // Match canvas resolution to the live video so the captureStream
      // we hand back to WebRTC keeps the camera's aspect ratio. Falls
      // back to 640×480 if track settings don't carry width/height
      // yet (some platforms surface them late).
      const settings = rawStream.getVideoTracks()[0]?.getSettings?.() || {};
      this._canvas.width = settings.width || video.videoWidth || 640;
      this._canvas.height = settings.height || video.videoHeight || 480;

      this._seg = new window.SelfieSegmentation({
        locateFile: (file) => VENDOR_PATH + file,
      });
      // modelSelection: 1 = landscape model (good for webcam framing).
      // selfieMode: false because we don't mirror here — the local
      // <video> tile applies a CSS mirror transform on display.
      this._seg.setOptions({ modelSelection: 1, selfieMode: false });
      this._seg.onResults((results) => this._draw(results));
      await this._seg.initialize();

      this._running = true;
      this._tick();

      // Output: canvas video + the original audio tracks. We don't
      // clone the audio — letting the original mic track flow through
      // means existing mute toggles (operating on the published
      // stream's audio track) keep working without coordination.
      const out = new MediaStream();
      const canvasTrack = this._canvas.captureStream(fps).getVideoTracks()[0];
      out.addTrack(canvasTrack);
      for (const at of rawStream.getAudioTracks()) out.addTrack(at);
      this._output = out;
      return out;
    }

    // Drives one segmentation frame and schedules the next via rAF.
    // Skipped while readyState < 2 (HAVE_CURRENT_DATA) — MediaPipe
    // throws on an undecoded HTMLVideoElement. Errors are logged but
    // never re-thrown; one bad frame must not break the steady-state
    // loop.
    _tick() {
      if (!this._running) return;
      const v = this._sourceVideo;
      if (v && v.readyState >= 2) {
        this._seg.send({ image: v }).catch((err) => {
          console.warn('[blur] segmentation send failed', err);
        }).finally(() => {
          if (this._running) requestAnimationFrame(() => this._tick());
        });
      } else {
        requestAnimationFrame(() => this._tick());
      }
    }

    _draw(results) {
      const ctx = this._ctx;
      const { width, height } = this._canvas;
      ctx.save();
      ctx.clearRect(0, 0, width, height);
      // 1. Blurred full-frame background.
      ctx.filter = `blur(${BLUR_PX}px)`;
      ctx.drawImage(results.image, 0, 0, width, height);
      // 2. Cut the person area out of the blurred layer (mask is
      //    opaque where the person is), then fill the resulting hole
      //    with the sharp image underneath. The composite-operation
      //    order matters: destination-out erases, then
      //    destination-over draws *behind* the remaining (blurred)
      //    pixels — which leaves a sharp person on a blurred
      //    background.
      ctx.filter = 'none';
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(results.segmentationMask, 0, 0, width, height);
      ctx.globalCompositeOperation = 'destination-over';
      ctx.drawImage(results.image, 0, 0, width, height);
      ctx.restore();
    }

    stop() {
      this._running = false;
      try { this._seg?.close(); } catch {}
      this._seg = null;
      if (this._sourceVideo) {
        try { this._sourceVideo.pause(); } catch {}
        this._sourceVideo.srcObject = null;
      }
      this._sourceVideo = null;
      if (this._output) {
        // captureStream gave us a synthetic track; stop it so the
        // downstream WebRTC sender (if any) sees the track end after
        // its replaceTrack swap.
        for (const t of this._output.getVideoTracks()) t.stop();
      }
      this._output = null;
      this._rawStream = null;
    }
  }

  window.BlurPipeline = BlurPipeline;
})();
