// v2 UI toggle: v2 is the default since v0.24.0; this script lets
// callers force legacy chrome via ?ui=legacy for triage or regression
// triage. ?ui=v2 stays accepted as a no-op for parity. Runs as the
// first <script> in <head> so any attribute change happens before
// stylesheets evaluate.
//
// Standalone file so we don't need to relax the CSP 'script-src'
// to allow inline scripts.
(function () {
  try {
    const flag = new URLSearchParams(location.search).get('ui');
    if (flag === 'legacy' || flag === 'v1') {
      document.documentElement.removeAttribute('data-ui');
    } else if (flag === 'v2') {
      document.documentElement.setAttribute('data-ui', 'v2');
    }
  } catch (_) {
    /* file:// or no search — leave default */
  }
})();
