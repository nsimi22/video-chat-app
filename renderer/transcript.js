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

  class TranscriptManager {
    constructor({ lang = 'en-US' } = {}) {
      this.lang = lang;
      this.handlers = { final: [], interim: [] };
      this.active = false;
      this.rec = null;
    }
    static isSupported() { return !!SR; }

    onFinal(cb) { this.handlers.final.push(cb); }
    onInterim(cb) { this.handlers.interim.push(cb); }

    start() {
      if (!SR || this.active) return false;
      this.active = true;
      this._spawn();
      return true;
    }
    stop() {
      this.active = false;
      try { this.rec?.stop(); } catch {}
      this.rec = null;
    }

    _spawn() {
      const rec = new SR();
      rec.lang = this.lang;
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = (e) => {
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
        // 'no-speech' / 'aborted' / 'audio-capture' are recoverable —
        // onend will restart. 'not-allowed' / 'service-not-allowed'
        // are terminal: the OS denied mic access or the speech
        // service is offline; flip active off so onend doesn't loop.
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          this.active = false;
        }
      };
      rec.onend = () => {
        // Chromium auto-ends recognition ~every 60s or after long
        // silences. Respawn whenever the user still has CC toggled
        // on; respect the terminal-error case where active was
        // already cleared by onerror.
        if (this.active) this._spawn();
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
