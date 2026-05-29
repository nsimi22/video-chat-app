// v2 UI toggle: enables [data-ui="v2"] on <html> when the renderer
// is launched with ?ui=v2 in its URL. Runs as the first <script> in
// <head> so the attribute is set before any stylesheets are applied,
// avoiding a flash of legacy UI.
//
// Lives in a standalone file so we don't need to relax the CSP
// 'script-src' to allow inline scripts. Off by default; the default
// flips to v2 in Phase 6 of docs/plans/ui-overhaul-v2_2026-05-28.md.
(function () {
  try {
    if (new URLSearchParams(location.search).get('ui') === 'v2') {
      document.documentElement.setAttribute('data-ui', 'v2');
    }
  } catch (_) {
    /* file:// or no search — leave default */
  }
})();
