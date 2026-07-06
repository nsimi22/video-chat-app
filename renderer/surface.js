// Shared helpers for the v2 nav-rail "surface" panels (recordings.js,
// integrations.js, usage.js — and any future full-stage overlay). These
// were copy-pasted per panel, which meant a fix to one (e.g. the ESC-while-
// typing guard) had to be re-applied by hand to each and silently missed
// the others. Centralize the parts that were genuinely identical.
//
// Loaded before the panels (see index.html); attaches window.HuddleSurface.
(function () {
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function svg(name) {
    return (window.HuddleIcons && window.HuddleIcons[name]) || '';
  }

  // Channel display name for an id, falling back to the id (then `fallback`)
  // — recordings + integrations both label rows by channel.
  function channelLabel(id, fallback = '—') {
    return window.huddleApp?.getChannelName?.(id) || id || fallback;
  }

  // Wire the standard panel Escape behaviour once. `getRoot()` returns the
  // panel's root element (may be null before first open). While the panel
  // is open:
  //   • Escape with focus inside one of the panel's own fields blurs that
  //     field instead of closing — so typing in a search box / create form
  //     doesn't tear the panel down and discard input. (This guard was the
  //     source of three separate copy-paste bugs before centralizing.)
  //   • otherwise, `onEscape(e)` runs first; if it returns true it handled
  //     the key (e.g. closed a sub-view like an open detail/editor) and the
  //     panel stays open. If it returns falsy, `close()` runs.
  function wireEscClose(getRoot, { onEscape, close } = {}) {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const root = getRoot();
      if (!root || root.classList.contains('hidden')) return;
      const a = document.activeElement;
      if (a && root.contains(a) && /^(input|textarea|select)$/i.test(a.tagName)) {
        a.blur();
        return;
      }
      if (onEscape && onEscape(e)) return;
      close?.();
    });
  }

  window.HuddleSurface = { escapeHtml, svg, channelLabel, wireEscClose };
})();
