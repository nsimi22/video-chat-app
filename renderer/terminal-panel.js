// v2 Terminal panel — a dedicated surface that opens when the nav-rail
// "Terminal" item is clicked. Mounts an xterm.js terminal backed by a
// real pty in the main process (via window.huddle.terminal.*), so the
// user can run any shell command — the point being to run the Claude
// Code CLI (`claude`) right inside Huddle.
//
// The pty is spawned lazily on first open and kept alive across close()
// so reopening resumes the same session (matching the AI panel's
// persist-on-close behaviour) — closing with ✕ does NOT kill the shell.
// The header "Stop" button kills it. Only active under [data-ui="v2"];
// legacy renders never touch this code.
(function () {
  let root = null;
  let mount = null;
  let term = null;
  let fit = null;
  let ptyId = null;
  let unsubData = null;
  let unsubExit = null;
  let resizeObs = null;
  let bootPromise = null;
  // Whether the in-flight boot should launch `claude` once it's up. Folding
  // every concurrent "Start Claude Code" caller into this single flag (vs.
  // each writing `claude\r` itself) stops a double-click during the spawn
  // window from typing `claude` twice.
  let bootWantsClaude = false;

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
        <button class="huddle-terminal-stop" type="button" title="Kill the shell">Stop</button>
        <button class="huddle-ai-close" aria-label="Close" title="Close (keeps the session)">${svg('x')}</button>
      </div>
      <div class="huddle-terminal-mount"></div>
    `;
    document.body.appendChild(root);

    mount = root.querySelector('.huddle-terminal-mount');

    root.querySelector('.huddle-ai-close').addEventListener('click', close);
    root.querySelector('.huddle-terminal-start').addEventListener('click', startClaude);
    root.querySelector('.huddle-terminal-stop').addEventListener('click', stopShell);
  }

  // --- pty lifecycle ----------------------------------------------

  function fitAndResize() {
    if (!term || !fit) return;
    // Skip while hidden: a display:none mount is 0×0, so fitting it computes
    // degenerate cols/rows and just wastes a reflow. open() re-fits on show.
    if (!root || root.classList.contains('hidden')) return;
    try { fit.fit(); } catch {}
    if (ptyId) window.huddle?.terminal?.resize(ptyId, term.cols, term.rows);
  }

  // Coalesce ResizeObserver bursts (dragging the window edge fires dozens
  // of callbacks/sec, each an fit() reflow + a resize IPC round-trip) into
  // one fit per animation frame.
  let fitScheduled = false;
  function scheduleFit() {
    if (fitScheduled) return;
    fitScheduled = true;
    requestAnimationFrame(() => { fitScheduled = false; fitAndResize(); });
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
      const FitAddonCtor = window.FitAddon?.FitAddon;
      if (FitAddonCtor) { fit = new FitAddonCtor(); term.loadAddon(fit); }
      term.open(mount);
      term.onData((d) => {
        if (ptyId) { window.huddle.terminal.write(ptyId, d); return; }
        // The shell has exited (or was stopped) — the next keystroke starts
        // a fresh one rather than being silently dropped. During a boot
        // (ptyId still null) ensureTerminal folds into the in-flight promise,
        // so this can't spawn a second shell.
        ensureTerminal();
      });

      resizeObs = new ResizeObserver(scheduleFit);
      resizeObs.observe(mount);
    }

    if (mode === 'claude') bootWantsClaude = true;

    // Shell already running: launch Claude directly if this call asked for it.
    if (ptyId) {
      if (mode === 'claude') { bootWantsClaude = false; launchClaude(); }
      return true;
    }
    // A boot is already in flight (e.g. open() started a shell and the user
    // clicked "Start Claude Code" before it finished). Just await it — the
    // boot's tail honours bootWantsClaude once, so we never double-launch.
    if (bootPromise) return bootPromise;

    // Spawn the pty once. A hidden element has zero size, so fit() must run
    // after the panel is visible — callers invoke this post-show. The IIFE
    // catches everything and resolves false (never rejects), so a transient
    // failure can't leave a stuck rejected bootPromise wedging the panel.
    bootPromise = (async () => {
      try {
        try { fit && fit.fit(); } catch {}
        const cols = term.cols || 80;
        const rows = term.rows || 24;
        const res = await window.huddle.terminal.spawn({ cols, rows });
        if (!res || !res.ok) {
          term.write(`\r\n\x1b[31m[terminal] ${res && res.error ? res.error : 'failed to start shell'}\x1b[0m\r\n`);
          return false;
        }
        ptyId = res.id;
        unsubData = window.huddle.terminal.onData((p) => { if (p.id === ptyId) term.write(p.data); });
        unsubExit = window.huddle.terminal.onExit((p) => {
          if (p.id !== ptyId) return;
          term.write('\r\n\x1b[90m[process exited — press any key to start a new shell]\x1b[0m\r\n');
          // Unsubscribe so listeners don't pile up across shell restarts.
          cleanupSubs();
          ptyId = null;
        });
        // Launch Claude once, if any concurrent caller asked for it. Doing it
        // here (rather than in main via a `mode` flag) keeps the pty transport
        // generic and puts all "Start Claude Code" logic in one place.
        if (bootWantsClaude) launchClaude();
        return true;
      } catch (err) {
        term.write(`\r\n\x1b[31m[terminal] ${err && err.message ? err.message : 'failed to start shell'}\x1b[0m\r\n`);
        return false;
      }
    })();
    // finally clears bootPromise on every path (success, false, or a throw
    // that escapes the IIFE), so the panel can always retry.
    try { return await bootPromise; }
    finally { bootPromise = null; bootWantsClaude = false; }
  }

  function launchClaude() {
    if (ptyId) window.huddle.terminal.write(ptyId, 'claude\r');
  }

  function killPty() {
    cleanupSubs();
    if (ptyId) { try { window.huddle?.terminal?.kill(ptyId); } catch {} ptyId = null; }
  }

  // "Stop" button — kill the shell (and any `claude` running in it). The
  // panel stays open; the next keystroke or "Start Claude Code" respawns.
  function stopShell() {
    if (!ptyId) return;
    killPty();
    if (term) term.write('\r\n\x1b[90m[stopped — press any key to start a new shell]\x1b[0m\r\n');
  }

  // --- actions -----------------------------------------------------

  // "Start Claude Code": just open with the claude mode. ensureTerminal
  // covers every case — a running shell types `claude` in, an in-flight
  // boot awaits then types, a fresh spawn types after boot. No second pty,
  // no dropped click.
  function startClaude() { open('claude'); }

  function open(mode) {
    if (!root) buildDom();
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    // Defer the fit + spawn until the element actually has a size.
    requestAnimationFrame(async () => {
      const ok = await ensureTerminal(mode);
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
        && !root.contains(document.activeElement)) {
      close();
    }
  });

  // Clean up the shell if the window is torn down (belt-and-braces; main
  // also kills ptys when the renderer is destroyed).
  window.addEventListener('beforeunload', killPty);
})();
