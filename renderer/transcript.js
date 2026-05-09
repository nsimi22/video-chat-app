// Live call transcription via the browser's built-in SpeechRecognition
// (Chromium ships webkitSpeechRecognition). No external API, no key —
// audio is streamed to Chromium's bundled speech service. Caveat: that
// service is Google's, so audio leaves the device the same way it does
// for any Web Speech API consumer; this is intentional and out of our
// control.
//
// TranscriptManager wraps a single continuous recognition session.
// SpeechRecognition.continuous=true caps each session at ~60s before
// the engine fires `end` on its own — _spawn restarts a fresh
// recogniser whenever active is still true, giving us indefinite
// continuous recognition.
//
// Public API:
//   const t = new TranscriptManager();
//   t.onFinal((text) => …);     // committed segments (use these for broadcast)
//   t.onInterim((text) => …);   // partial in-progress text (use for live caption flicker)
//   t.start();
//   t.stop();
//   TranscriptManager.isSupported()
(function () {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // Cap consecutive failed restarts so a recurring `network` /
  // `audio-capture` error can't hot-spin Chromium's SR. Successful
  // capture (a result event or a clean idle-end) resets the
  // counter; backoff doubles each retry up to ~4s.
  const MAX_CONSECUTIVE_ERRORS = 6;

  class TranscriptManager {
    constructor({ lang = 'en-US' } = {}) {
      this.lang = lang;
      this.handlers = { final: [], interim: [] };
      this.active = false;
      this.rec = null;
      this._consecutiveErrors = 0;
      this._restartTimer = null;
    }
    static isSupported() { return !!SR; }

    onFinal(cb) { this.handlers.final.push(cb); }
    onInterim(cb) { this.handlers.interim.push(cb); }

    start() {
      if (!SR || this.active) return false;
      this.active = true;
      this._consecutiveErrors = 0;
      this._spawn();
      return true;
    }
    stop() {
      this.active = false;
      if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
      try { this.rec?.stop(); } catch {}
      this.rec = null;
    }

    _spawn() {
      let rec;
      try { rec = new SR(); }
      catch (err) {
        // Some Chromium builds throw at construction time when the
        // platform speech service is unavailable. Treat as terminal.
        console.warn('SpeechRecognition unavailable:', err);
        this.active = false;
        return;
      }
      rec.lang = this.lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
        // Any successful result clears the error backoff.
        this._consecutiveErrors = 0;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          const text = (r[0]?.transcript || '').trim();
          if (!text) continue;
          if (r.isFinal) {
            for (const cb of this.handlers.final) cb(text);
          } else {
            for (const cb of this.handlers.interim) cb(text);
          }
        }
      };
      rec.onerror = (e) => {
        const err = e?.error;
        // Terminal: the OS denied mic access or the speech service
        // is offline. Flip active off so onend doesn't loop.
        if (err === 'not-allowed' || err === 'service-not-allowed') {
          this.active = false;
          return;
        }
        // Other errors (network / audio-capture / no-speech) are
        // potentially transient. Count them; if we hit the cap
        // without a successful result in between, give up so we
        // don't hot-spin into Chromium's SR endpoint.
        this._consecutiveErrors++;
        if (this._consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.warn(`SpeechRecognition: ${MAX_CONSECUTIVE_ERRORS} consecutive ${err} errors, giving up`);
          this.active = false;
        }
      };
      rec.onend = () => {
        // Chromium auto-ends recognition ~every 60s or after long
        // silences. Respawn while active; back off when we've been
        // hitting errors so a flaky network / mic doesn't peg the
        // CPU. The first restart after a successful result fires
        // immediately (counter is 0).
        if (!this.active) return;
        const delay = this._consecutiveErrors === 0
          ? 0
          : Math.min(4000, 250 * 2 ** (this._consecutiveErrors - 1));
        this._restartTimer = setTimeout(() => {
          this._restartTimer = null;
          if (this.active) this._spawn();
        }, delay);
      };
      try { rec.start(); }
      catch (err) {
        console.warn('SpeechRecognition.start failed', err);
        this.active = false;
        return;
      }
      this.rec = rec;
    }
  }

  window.HuddleTranscript = { TranscriptManager };
})();
