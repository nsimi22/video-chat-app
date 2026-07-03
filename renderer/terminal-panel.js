// v2 Terminal panel — a dedicated surface that opens when the nav-rail
// "Terminal" item is clicked. Mounts an xterm.js terminal backed by a
// real pty in the main process (via window.huddle.terminal.*), so the
// user can run any shell command — the point being to run the Claude
// Code CLI (`claude`) right inside Huddle.
//
// The pty is spawned lazily on first open and kept alive across close()
// so reopening resumes the same session (matching the AI panel's
// persist-on-close behaviour). The ✕ / "Stop" control kills it. Only
// active under [data-ui="v2"]; legacy renders never touch this code.
(function () {
  let root = null;
  let mount = null;
  let startBtn = null;
  let term = null;
  let fit = null;
  let ptyId = null;
  let unsubData = null;
  let unsubExit = null;
  let resizeObs = null;
  let bootPromise = null;

  function svg(name) {
    return (window.HuddleIcons && window.HuddleIcons[name]) || '';
  }

  // --- DOM ---------------------------------------------------------

  function buildDom() {
    root = document.createElement('div');
    root.className = 'huddle-terminal-view hidden';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="huddle-terminal-header">
        <div class="huddle-terminal-title-block">
          <div class="huddle-terminal-title">Terminal</div>
          <div class="huddle-terminal-subtitle">A real shell on your machine — run <code>claude</code> or anything else</div>
        </div>
        <div class="huddle-terminal-spacer"></div>
        <button class="huddle-terminal-start" type="button">${svg('sparkles')}<span>Start Claude Code</span></button>
        <button class="huddle-terminal-close" aria-label="Close" title="Close">${svg('x')}</button>
      </div>
      <div class="huddle-terminal-mount"></div>
    `;
    document.body.appendChild(root);

    mount    = root.querySelector('.huddle-terminal-mount');
    startBtn = root.querySelector('.huddle-terminal-start');

    root.querySelector('.huddle-terminal-close').addEventListener('click', close);
    startBtn.addEventListener('click', startClaude);
  }

  // --- pty lifecycle ----------------------------------------------

  function fitAndResize() {
    if (!term || !fit) return;
    try { fit.fit(); } catch {}
    if (ptyId) window.huddle?.terminal?.resize(ptyId, term.cols, term.rows);
  }

  function cleanupSubs() {
    try { unsubData && unsubData(); } catch {}
    try { unsubExit && unsubExit(); } catch {}
    unsubData = unsubExit = null;
  }

  async function ensureTerminal(mode) {
    if (!window.huddle || !window.huddle.terminal || typeof window.Terminal !== 'function') {
      if (mount) mount.innerHTML = '<div class="huddle-terminal-unavailable">Terminal engine unavailable in this build.</div>';
      return false;
    }
    // Build the xterm instance once.
    if (!term) {
      term = new window.Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
        fontSize: 13,
        cursorBlink: true,
        convertEol: false,
        theme: { background: '#0b0e14', foreground: '#d5d8df' },
      });
      const FitAddonCtor = window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon);
      if (FitAddonCtor) { fit = new FitAddonCtor(); term.loadAddon(fit); }
      term.open(mount);
      term.onData((d) => { if (ptyId) window.huddle.terminal.write(ptyId, d); });

      resizeObs = new ResizeObserver(() => fitAndResize());
      resizeObs.observe(mount);
    }

    // Shell already running: if this call wanted Claude, just type it in.
    if (ptyId) {
      if (mode === 'claude') window.huddle.terminal.write(ptyId, 'claude\r');
      return true;
    }
    // A boot is already in flight (e.g. open() started a shell and the
    // user clicked "Start Claude Code" before it finished). Await it, then
    // run the post-boot action so the click isn't silently dropped.
    if (bootPromise) {
      const ok = await bootPromise;
      if (ok && mode === 'claude' && ptyId) window.huddle.terminal.write(ptyId, 'claude\r');
      return ok;
    }

    // Spawn the pty once. A hidden element has zero size, so fit() must
    // run after the panel is visible — callers invoke this post-show.
    bootPromise = (async () => {
      try { fit && fit.fit(); } catch {}
      const cols = term.cols || 80;
      const rows = term.rows || 24;
      const res = await window.huddle.terminal.spawn({ cols, rows, mode });
      if (!res || !res.ok) {
        term.write(`\r\n\x1b[31m[terminal] ${res && res.error ? res.error : 'failed to start shell'}\x1b[0m\r\n`);
        return false;
      }
      ptyId = res.id;
      unsubData = window.huddle.terminal.onData((p) => { if (p.id === ptyId) term.write(p.data); });
      unsubExit = window.huddle.terminal.onExit((p) => {
        if (p.id !== ptyId) return;
        term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
        // Unsubscribe so listeners don't pile up across shell restarts.
        cleanupSubs();
        ptyId = null;
      });
      return true;
    })();
    const ok = await bootPromise;
    bootPromise = null;
    return ok;
  }

  function killPty() {
    cleanupSubs();
    if (ptyId) { try { window.huddle?.terminal?.kill(ptyId); } catch {} ptyId = null; }
  }

  // --- actions -----------------------------------------------------

  async function startClaude() {
    if (!root) buildDom();
    if (root.classList.contains('hidden')) open();
    // ensureTerminal('claude') covers every case: a running shell (types
    // `claude` in), an in-flight boot (awaits it, then types), or a fresh
    // spawn (main runs `claude` via mode). No second pty, no dropped click.
    const ok = await ensureTerminal('claude');
    if (ok) { fitAndResize(); term.focus(); }
  }

  function open() {
    if (!root) buildDom();
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    // Defer the fit + spawn until the element actually has a size.
    requestAnimationFrame(async () => {
      const ok = await ensureTerminal();
      if (ok) { fitAndResize(); term.focus(); }
    });
  }

  function close() {
    if (!root) return;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    // Persist the pty across close so reopening resumes the session.
  }

  function toggle() {
    if (!root) { open(); return; }
    if (root.classList.contains('hidden')) open();
    else close();
  }

  window.HuddleTerminalPanel = { open, close, toggle };

  // ESC closes the panel (keystrokes inside xterm are captured by the
  // terminal itself, so this only fires when focus is elsewhere).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root && !root.classList.contains('hidden')
        && document.activeElement && !root.contains(document.activeElement)) {
      close();
    }
  });

  // Clean up the shell if the window is torn down (belt-and-braces; main
  // also kills ptys when the renderer is destroyed).
  window.addEventListener('beforeunload', killPty);
})();
