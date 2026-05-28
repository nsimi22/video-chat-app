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
  // chat / calls / ai are intentionally no-ops at this step —
  // they only update the visual active state for now.
  const LEGACY_BRIDGE = {
    calendar: 'open-calendar',
    settings: 'open-settings',
    whiteboard: 'whiteboard-btn',
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
    if (!rail) return;
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
