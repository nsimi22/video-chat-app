// v2 UI shell wiring: nav-rail icon population + click bridges.
//
// The rail markup lives in index.html and is hidden via CSS unless
// [data-ui="v2"] is set on <html>. This script is safe to load
// unconditionally — it just attaches handlers to the rail buttons.
//
// Each .huddle-rail-item carries a data-view (or data-action). At
// init we paint its SVG from HuddleIcons. At click we toggle the
// .is-active class and, if a bridge to a legacy element exists,
// trigger that element's click so the existing app.js state
// machine handles the view switch. Full standalone view-router
// + Contextual Panel restyle lands in a later Phase 2 sub-step.
(function () {
  const ICON_FOR = {
    chat: 'chat',
    calls: 'video',
    whiteboard: 'board',
    calendar: 'calendar',
    ai: 'sparkles',
    settings: 'settings',
  };

  // data-view / data-action → existing legacy element to click.
  // chat / calls are visual-only at this step; "ai" opens the
  // dedicated Huddle AI panel; "calendar" opens the week-grid view
  // (falls back to the legacy drawer if the grid module hasn't
  // loaded yet).
  const LEGACY_BRIDGE = {
    settings: 'open-settings',
    whiteboard: 'whiteboard-btn',
  };
  const CUSTOM_BRIDGE = {
    ai: () => window.HuddleAIPanel?.open?.(),
    calendar: () => (
      window.HuddleCalendarGrid?.open?.()
      ?? document.getElementById('open-calendar')?.click()
    ),
  };

  function paintIcons(rail) {
    rail.querySelectorAll('.huddle-rail-item').forEach((btn) => {
      const key = btn.dataset.view || btn.dataset.action;
      const iconName = ICON_FOR[key];
      const svg = iconName && window.HuddleIcons && window.HuddleIcons[iconName];
      if (svg) btn.innerHTML = svg;
    });
  }

  function wireClicks(rail) {
    rail.addEventListener('click', (e) => {
      const btn = e.target.closest('.huddle-rail-item');
      if (!btn) return;
      const key = btn.dataset.view || btn.dataset.action;
      if (!key) return;

      // Settings is a popover toggle on the legacy element, not a
      // sticky nav destination — don't move the active state for it.
      if (btn.dataset.view) {
        rail.querySelectorAll('.huddle-rail-item').forEach((b) => b.classList.remove('is-active'));
        btn.classList.add('is-active');
      }

      const legacyId = LEGACY_BRIDGE[key];
      if (legacyId) {
        const el = document.getElementById(legacyId);
        if (el) el.click();
      }
      const custom = CUSTOM_BRIDGE[key];
      if (custom) custom();
    });
  }

  function paintMeBadge() {
    const railMe = document.getElementById('huddle-rail-me');
    const me = document.getElementById('me');
    if (!railMe || !me) return;
    // Mirror the first character of the legacy #me label as a tiny
    // initial badge. Full Avatar primitive comes with Phase 3.
    const txt = (me.textContent || '').trim();
    if (txt) railMe.textContent = txt.slice(0, 1).toUpperCase();
  }

  function init() {
    const rail = document.querySelector('.huddle-rail-v2');
    if (rail) {
      paintIcons(rail);
      wireClicks(rail);
      paintMeBadge();

      // Keep the rail initial in sync if app.js re-renders #me later.
      const me = document.getElementById('me');
      if (me && 'MutationObserver' in window) {
        const obs = new MutationObserver(paintMeBadge);
        obs.observe(me, { childList: true, characterData: true, subtree: true });
      }
    }

    // v2 sign-in (brand pills + split OTP). Safe to call regardless
    // of whether the v2 sign-in DOM is currently visible.
    paintSigninBrandPills();
    wireSplitOtp();

    // v2 captions footer "/summarize" button — kicks off the
    // live-call transcript recap (same prompt + posting path as the
    // post-call recap). Composer is hidden during the call so
    // prefilling /summarize there wouldn't help; this triggers the
    // AI directly and posts the recap to the channel for after-call.
    const sumBtn = document.getElementById('captions-summarize-btn');
    if (sumBtn && !sumBtn.dataset.wired) {
      sumBtn.dataset.wired = '1';
      sumBtn.addEventListener('click', () => {
        sumBtn.disabled = true;
        sumBtn.textContent = 'Summarizing…';
        Promise.resolve(window.huddleApp?.summarizeCallNow?.())
          .finally(() => {
            sumBtn.disabled = false;
            sumBtn.innerHTML = `
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="11" x2="20" y2="11"/><line x1="4" y1="16" x2="14" y2="16"/><circle cx="18.5" cy="17" r="3.2"/>
              </svg>
              <span>/summarize</span>
            `;
          });
      });
    }

    // v2 call-view layout: dock mic / cam / share / etc. at the
    // bottom and toggle a body class when in-call so CSS can hide
    // chat + reposition the captions panel.
    setupCallDock();
  }

  // -------- v2 in-call layout (Phase 6) ----------------------------
  //
  // The design (huddle/call.jsx) puts the active call controls in a
  // dedicated BOTTOM bar — mic / cam / share / captions / raise /
  // board / leave. Legacy stuffs them all into the chat header's
  // right cluster. To match the design without rebuilding the app,
  // we physically move those buttons into a new .huddle-call-dock
  // element appended to .stage. The buttons keep their event
  // listeners + the legacy code that toggles their .hidden class
  // keeps working — only their parent in the DOM changes.
  //
  // We also watch #btn-leave for class changes and toggle a
  // body.huddle-in-call class so CSS can hide chat / composer /
  // unrelated header buttons while a call is active.
  function setupCallDock() {
    const stage = document.querySelector('.stage');
    const leaveBtn = document.getElementById('btn-leave');
    if (!stage || !leaveBtn || document.querySelector('.huddle-call-dock')) return;

    const dockIds = ['btn-mic', 'btn-cam', 'btn-blur', 'btn-share', 'btn-hand', 'btn-react', 'btn-cc', 'btn-leave'];
    const dock = document.createElement('div');
    dock.className = 'huddle-call-dock';
    dock.setAttribute('aria-label', 'Call controls');
    // Insert a divider before #btn-leave per design — visual cue
    // that Leave is destructive and separate from the toggle row.
    const beforeLeave = document.createElement('span');
    beforeLeave.className = 'huddle-call-dock-divider';
    for (const id of dockIds) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      if (id === 'btn-leave') dock.appendChild(beforeLeave);
      dock.appendChild(btn);
    }
    stage.appendChild(dock);

    // Sync body.huddle-in-call from #btn-leave's visibility.
    const syncBodyClass = () => {
      const inCall = !leaveBtn.classList.contains('hidden');
      document.body.classList.toggle('huddle-in-call', inCall);
    };
    syncBodyClass();
    new MutationObserver(syncBodyClass).observe(leaveBtn, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  function paintSigninBrandPills() {
    document.querySelectorAll('.huddle-signin-pill[data-icon]').forEach((pill) => {
      if (pill.querySelector('svg')) return; // already painted
      const iconName = pill.dataset.icon;
      const svg = iconName && window.HuddleIcons && window.HuddleIcons[iconName];
      if (svg) pill.insertAdjacentHTML('afterbegin', svg);
    });
  }

  // Split OTP — mirror to the legacy #auth-otp input on each
  // keystroke and auto-click #auth-verify when the full code is in.
  // Length is taken from the live DOM so the count can be tuned in
  // index.html without touching this file. The existing app.js
  // verifyOtp flow handles the rest unchanged.
  function wireSplitOtp() {
    const wrap = document.querySelector('.huddle-otp-digits-v2');
    if (!wrap) return;
    const inputs = Array.from(wrap.querySelectorAll('.huddle-otp-digit-v2'));
    const legacy = document.getElementById('auth-otp');
    const verifyBtn = document.getElementById('auth-verify');
    if (!legacy || !inputs.length) return;
    const N = inputs.length;

    function syncLegacy() {
      const concat = inputs.map((i) => i.value).join('');
      legacy.value = concat;
      legacy.dispatchEvent(new Event('input', { bubbles: true }));
      inputs.forEach((i) => i.classList.toggle('is-filled', !!i.value));
      if (concat.length === N && verifyBtn) {
        // Small delay so the last digit's render is visible before submit.
        setTimeout(() => verifyBtn.click(), 120);
      }
    }

    inputs.forEach((inp, i) => {
      inp.addEventListener('input', (e) => {
        const v = (e.target.value || '').replace(/\D/g, '').slice(-1);
        e.target.value = v;
        if (v && i < N - 1) inputs[i + 1].focus();
        syncLegacy();
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !inp.value && i > 0) {
          inputs[i - 1].focus();
        } else if (e.key === 'ArrowLeft' && i > 0) {
          inputs[i - 1].focus();
        } else if (e.key === 'ArrowRight' && i < N - 1) {
          inputs[i + 1].focus();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (verifyBtn) verifyBtn.click();
        }
      });
      inp.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = ((e.clipboardData && e.clipboardData.getData('text')) || '')
          .replace(/\D/g, '')
          .slice(0, N);
        inputs.forEach((target, j) => {
          target.value = text[j] || '';
        });
        syncLegacy();
        if (text.length < N) inputs[Math.min(text.length, N - 1)].focus();
      });
    });

    // Reset digits when the OTP step becomes visible again.
    const otpStep = document.getElementById('auth-otp-step');
    if (otpStep && 'MutationObserver' in window) {
      const obs = new MutationObserver(() => {
        if (!otpStep.classList.contains('hidden')) {
          inputs.forEach((inp) => {
            inp.value = '';
            inp.classList.remove('is-filled');
          });
          legacy.value = '';
          setTimeout(() => inputs[0] && inputs[0].focus(), 30);
        }
      });
      obs.observe(otpStep, { attributes: true, attributeFilter: ['class'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
