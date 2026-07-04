// v2 Terminal panel — a dedicated surface that opens when the nav-rail
// "Terminal" item is clicked. Hosts one or more tabs, each an xterm.js
// terminal backed by a real pty in the main process (via
// window.huddle.terminal.*), so the user can run shells side by side — the
// point being to run the Claude Code CLI (`claude`) right inside Huddle.
//
// Each tab owns its own pty + xterm instance. Tabs (and their shells) are
// kept alive across close() so reopening resumes every session (matching
// the AI panel's persist-on-close behaviour) — closing with ✕ does NOT
// kill the shells. The header "Stop" button kills the active tab's shell;
// a tab's own ✕ kills that tab. Only active under [data-ui="v2"]; legacy
// renders never touch this code.
(function () {
  // Keep in sync with TERMINAL_MAX_PTYS_PER_WINDOW in main.js — the main
  // process caps concurrent shells per window, so the tab count matches.
  const MAX_TABS = 8;

  let root = null;
  let tabsBar = null;
  let newTabBtn = null;
  let mountsWrap = null;
  let resizeObs = null;

  const sessions = []; // tab order
  let active = null;
  let seq = 0;

  function svg(name) {
    return (window.HuddleIcons && window.HuddleIcons[name]) || '';
  }

  function engineReady() {
    return !!(window.huddle && window.huddle.terminal && typeof window.Terminal === 'function');
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
          <div class="huddle-terminal-subtitle">Real shells on your machine — run <code>claude</code> or anything else</div>
        </div>
        <div class="huddle-terminal-spacer"></div>
        <button class="huddle-terminal-start" type="button">${svg('sparkles')}<span>Start Claude Code</span></button>
        <button class="huddle-terminal-stop" type="button" title="Kill the active tab's shell">Stop</button>
        <button class="huddle-ai-close" aria-label="Close" title="Close (keeps your sessions)">${svg('x')}</button>
      </div>
      <div class="huddle-terminal-tabs" role="tablist"></div>
      <div class="huddle-terminal-mounts"></div>
    `;
    document.body.appendChild(root);

    tabsBar    = root.querySelector('.huddle-terminal-tabs');
    mountsWrap = root.querySelector('.huddle-terminal-mounts');

    // Persistent "+" new-tab button lives at the end of the tab strip.
    newTabBtn = document.createElement('button');
    newTabBtn.className = 'huddle-terminal-newtab';
    newTabBtn.type = 'button';
    newTabBtn.title = 'New tab';
    newTabBtn.textContent = '+';
    newTabBtn.addEventListener('click', () => newTab());
    tabsBar.appendChild(newTabBtn);

    root.querySelector('.huddle-ai-close').addEventListener('click', close);
    root.querySelector('.huddle-terminal-start').addEventListener('click', startClaude);
    root.querySelector('.huddle-terminal-stop').addEventListener('click', stopActiveShell);

    // One observer for the shared mounts area; only the active tab is
    // visible/sized, so fit that one.
    resizeObs = new ResizeObserver(() => scheduleFit(active));
    resizeObs.observe(mountsWrap);

    // New-tab shortcut: Cmd+T (macOS) / Ctrl+Shift+T (elsewhere). Capture
    // phase so xterm doesn't eat it. We deliberately do NOT bind a close
    // shortcut: Cmd+W is the OS window-close accelerator (dispatched by the
    // default app menu independently of this keydown, so we can't reliably
    // own it), and plain Ctrl+W is the shell's delete-word. Tabs close via
    // their ✕ button.
    root.addEventListener('keydown', (e) => {
      const mac = (window.huddle?.platform === 'darwin');
      const newCombo = mac ? (e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 't')
                           : (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't');
      if (newCombo) { e.preventDefault(); e.stopPropagation(); newTab(); }
    }, true);
  }

  function updateNewTabBtn() {
    if (newTabBtn) newTabBtn.disabled = sessions.length >= MAX_TABS;
  }

  // --- session (one tab) ------------------------------------------

  function makeSession() {
    const title = `Terminal ${++seq}`;
    const s = {
      ptyId: null,
      term: null,
      fit: null,
      mountEl: null,
      chipEl: null,
      unsubData: null,
      unsubExit: null,
      bootPromise: null,
      bootWantsClaude: false,
      fitScheduled: false,
      // Set true once the tab is closed; the async boot re-checks it after
      // spawn so a shell that finishes booting into a closed tab is killed
      // instead of orphaned. stopRequested does the same for the Stop button.
      closed: false,
      stopRequested: false,
    };

    s.mountEl = document.createElement('div');
    s.mountEl.className = 'huddle-terminal-mount hidden';
    mountsWrap.appendChild(s.mountEl);

    s.chipEl = document.createElement('div');
    s.chipEl.className = 'huddle-terminal-tab';
    s.chipEl.setAttribute('role', 'tab');
    const label = document.createElement('span');
    label.className = 'huddle-terminal-tab-label';
    label.textContent = title;
    const closeX = document.createElement('button');
    closeX.className = 'huddle-terminal-tab-close';
    closeX.type = 'button';
    closeX.title = 'Close tab';
    closeX.innerHTML = svg('x');
    s.chipEl.appendChild(label);
    s.chipEl.appendChild(closeX);
    s.chipEl.addEventListener('click', (e) => {
      if (e.target.closest('.huddle-terminal-tab-close')) { closeSession(s); return; }
      activate(s);
    });
    tabsBar.insertBefore(s.chipEl, newTabBtn);

    sessions.push(s);
    updateNewTabBtn();
    return s;
  }

  function cleanupSubs(s) {
    try { s.unsubData && s.unsubData(); } catch {}
    try { s.unsubExit && s.unsubExit(); } catch {}
    s.unsubData = s.unsubExit = null;
  }

  function fitSession(s) {
    if (!s || !s.term || !s.fit) return;
    // Only the active tab is visible + sized; a hidden/0×0 mount fits to
    // degenerate dims and just wastes a reflow.
    if (s !== active || !root || root.classList.contains('hidden')) return;
    try { s.fit.fit(); } catch {}
    if (s.ptyId) window.huddle?.terminal?.resize(s.ptyId, s.term.cols, s.term.rows);
  }

  function scheduleFit(s) {
    if (!s || s.fitScheduled) return;
    s.fitScheduled = true;
    requestAnimationFrame(() => { s.fitScheduled = false; fitSession(s); });
  }

  function launchClaude(s) {
    if (s.ptyId) window.huddle.terminal.write(s.ptyId, 'claude\r');
  }

  // Ensure session `s` has a live shell. `mode==='claude'` launches Claude
  // Code once the shell is up. Concurrent claude-mode callers fold into the
  // single bootWantsClaude flag so a double-click can't launch it twice.
  async function ensureSession(s, mode) {
    if (!engineReady()) {
      if (s.mountEl) s.mountEl.innerHTML = '<div class="huddle-terminal-unavailable">Terminal engine unavailable in this build.</div>';
      return false;
    }
    if (!s.term) {
      s.term = new window.Terminal({
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
        fontSize: 13,
        cursorBlink: true,
        convertEol: false,
        theme: { background: '#0b0e14', foreground: '#d5d8df' },
      });
      const FitAddonCtor = window.FitAddon?.FitAddon;
      if (FitAddonCtor) { s.fit = new FitAddonCtor(); s.term.loadAddon(s.fit); }
      s.term.open(s.mountEl);
      s.term.onData((d) => {
        if (s.ptyId) { window.huddle.terminal.write(s.ptyId, d); return; }
        // Shell exited/stopped — the next keystroke starts a fresh one.
        // During a boot (ptyId null) ensureSession folds into the in-flight
        // promise, so this can't spawn a second shell.
        ensureSession(s);
      });
    }

    if (mode === 'claude') s.bootWantsClaude = true;

    if (s.ptyId) {
      if (mode === 'claude') { s.bootWantsClaude = false; launchClaude(s); }
      return true;
    }
    if (s.bootPromise) return s.bootPromise;

    s.bootPromise = (async () => {
      try {
        try { s.fit && s.fit.fit(); } catch {}
        const cols = s.term.cols || 80;
        const rows = s.term.rows || 24;
        const res = await window.huddle.terminal.spawn({ cols, rows });
        // The tab may have been closed or Stopped during the async spawn.
        // Kill the just-born shell instead of wiring it to a disposed term
        // (or leaking it, since a closed session is no longer in `sessions`).
        if (s.closed || s.stopRequested) {
          s.stopRequested = false;
          if (res && res.ok) { try { window.huddle.terminal.kill(res.id); } catch {} }
          return false;
        }
        if (!res || !res.ok) {
          s.term.write(`\r\n\x1b[31m[terminal] ${res && res.error ? res.error : 'failed to start shell'}\x1b[0m\r\n`);
          return false;
        }
        s.ptyId = res.id;
        s.unsubData = window.huddle.terminal.onData((p) => { if (p.id === s.ptyId) s.term.write(p.data); });
        s.unsubExit = window.huddle.terminal.onExit((p) => {
          if (p.id !== s.ptyId) return;
          s.term.write('\r\n\x1b[90m[process exited — press any key to start a new shell]\x1b[0m\r\n');
          cleanupSubs(s);
          s.ptyId = null;
        });
        if (s.bootWantsClaude) launchClaude(s);
        return true;
      } catch (err) {
        if (!s.closed) s.term.write(`\r\n\x1b[31m[terminal] ${err && err.message ? err.message : 'failed to start shell'}\x1b[0m\r\n`);
        return false;
      }
    })();
    try { return await s.bootPromise; }
    finally { s.bootPromise = null; s.bootWantsClaude = false; }
  }

  function killSessionShell(s) {
    cleanupSubs(s);
    if (s.ptyId) { try { window.huddle?.terminal?.kill(s.ptyId); } catch {} s.ptyId = null; }
  }

  // --- tab management ---------------------------------------------

  function activate(s) {
    if (!s) return;
    active = s;
    for (const other of sessions) {
      const on = other === s;
      other.mountEl.classList.toggle('hidden', !on);
      other.chipEl.classList.toggle('is-active', on);
    }
    // Defer fit/focus until the newly-shown mount has a size. Re-check that
    // s is still the active, non-closed tab: it may have been switched away
    // or closed (and its term disposed) in the intervening frame.
    requestAnimationFrame(() => {
      if (s.closed || s !== active) return;
      fitSession(s);
      s.term && s.term.focus();
    });
  }

  function newTab(mode) {
    if (sessions.length >= MAX_TABS) return null;
    const s = makeSession();
    activate(s);
    ensureSession(s, mode);
    return s;
  }

  function closeSession(s) {
    if (!s) return;
    // Mark closed first so an in-flight boot kills its shell on resolve
    // instead of wiring it to the term we're about to dispose.
    s.closed = true;
    killSessionShell(s);
    try { s.term && s.term.dispose(); } catch {}
    const i = sessions.indexOf(s);
    if (i >= 0) sessions.splice(i, 1);
    try { s.mountEl.remove(); } catch {}
    try { s.chipEl.remove(); } catch {}
    updateNewTabBtn();

    if (active === s) {
      active = null;
      // Activate a neighbour (prefer the one that took this slot), or spin
      // up a fresh tab so the panel always shows a live terminal.
      const next = sessions[i] || sessions[i - 1] || sessions[0];
      if (next) activate(next);
      else newTab();
    }
  }

  // --- actions -----------------------------------------------------

  // Show the panel and ensure the active tab has a live shell (optionally
  // launching Claude). Single path for both the rail "open" and the "Start
  // Claude Code" button, so their fit/focus sequencing can't drift. The
  // target session is captured, so switching tabs mid-boot can't make us
  // fit/focus the wrong one.
  function revealAndEnsure(mode) {
    if (!root) buildDom();
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');
    if (!active) { newTab(mode); return; }
    const s = active;
    requestAnimationFrame(async () => {
      const ok = await ensureSession(s, mode);
      if (ok && s === active && !s.closed && s.term) { fitSession(s); s.term.focus(); }
    });
  }

  function open(mode) { revealAndEnsure(mode); }
  function startClaude() { revealAndEnsure('claude'); }

  // "Stop" — kill the active tab's shell (and any `claude` in it); the tab
  // stays open and the next keystroke / "Start Claude Code" respawns. If the
  // shell is still booting, flag it so the boot kills the shell on resolve
  // rather than leaving it running.
  function stopActiveShell() {
    const s = active;
    if (!s) return;
    if (s.ptyId) {
      killSessionShell(s);
    } else if (s.bootPromise) {
      s.stopRequested = true;
      s.bootWantsClaude = false;
    } else {
      return;
    }
    if (s.term) s.term.write('\r\n\x1b[90m[stopped — press any key to start a new shell]\x1b[0m\r\n');
  }

  function close() {
    if (!root) return;
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    // Persist all tabs + shells across close so reopening resumes them.
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

  // Kill every shell if the window is torn down (belt-and-braces; main also
  // kills ptys when the renderer is destroyed).
  window.addEventListener('beforeunload', () => { for (const s of sessions) killSessionShell(s); });
})();
