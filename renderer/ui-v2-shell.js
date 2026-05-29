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
  // dedicated Huddle AI panel via window.HuddleAIPanel.
  const LEGACY_BRIDGE = {
    calendar: 'open-calendar',
    settings: 'open-settings',
    whiteboard: 'whiteboard-btn',
  };
  const CUSTOM_BRIDGE = {
    ai: () => window.HuddleAIPanel?.open?.(),
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
