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
//
// Share to call: while in a call, the active tab's OUTPUT can be broadcast
// to the other participants (Supabase Realtime, see the terminal-share
// methods in api.js). Receivers get a read-only viewer tab — their
// keystrokes are never wired anywhere near the host's shell; the transport
// itself has no viewer-input event. app.js relays the call-channel
// announce/stop events into remoteShareStarted/remoteShareStopped below.
(function () {
  // Keep in sync with TERMINAL_MAX_PTYS_PER_WINDOW in main.js — the main
  // process caps concurrent shells per window, so the tab count matches.
  const MAX_TABS = 8;

  let root = null;
  let tabsBar = null;
  let newTabBtn = null;
  let mountsWrap = null;
  let resizeObs = null;
  let startBtn = null;
  let stopBtn = null;
  let shareBtn = null;

  const sessions = []; // tab order (local shells + remote viewers)
  const viewers = new Map(); // shareId -> viewer session (subset of sessions)
  let active = null;
  let seq = 0;

  function svg(name) {
    return (window.HuddleIcons && window.HuddleIcons[name]) || '';
  }

  function engineReady() {
    return !!(window.huddle && window.huddle.terminal && typeof window.Terminal === 'function');
  }

  // Shared look for host + viewer terminals; callers add their own
  // interaction flags (cursorBlink / disableStdin).
  function makeTerm(extra) {
    return new window.Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace',
      fontSize: 13,
      convertEol: false,
      theme: { background: '#0b0e14', foreground: '#d5d8df' },
      ...extra,
    });
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
        <button class="huddle-terminal-share" type="button"><span>Share to call</span></button>
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

    startBtn = root.querySelector('.huddle-terminal-start');
    stopBtn  = root.querySelector('.huddle-terminal-stop');
    shareBtn = root.querySelector('.huddle-terminal-share');
    root.querySelector('.huddle-ai-close').addEventListener('click', close);
    startBtn.addEventListener('click', startClaude);
    stopBtn.addEventListener('click', stopActiveShell);
    shareBtn.addEventListener('click', toggleShareActive);

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

  // The pty cap applies to local shells only — viewer tabs hold no pty.
  function localTabCount() {
    return sessions.reduce((n, s) => n + (s.viewer ? 0 : 1), 0);
  }

  function updateNewTabBtn() {
    if (newTabBtn) newTabBtn.disabled = localTabCount() >= MAX_TABS;
  }

  // --- session (one tab) ------------------------------------------

  function makeSession(opts) {
    const title = opts?.label || `Terminal ${++seq}`;
    const s = {
      viewer: !!opts?.viewer, // read-only view of a teammate's share (no pty)
      shareId: null,          // viewer: the share being watched
      gotSnapshot: false,     // viewer: catch-up snapshot applied
      gotData: false,         // viewer: any snapshot/frame arrived (join succeeded)
      joinRetries: 0,         // viewer: re-join attempts made so far
      joinTimer: null,        // viewer: pending join-retry timer
      ended: false,           // viewer: host stopped the share
      share: null,            // host: { id, buf, timer } while broadcasting
      sharePending: false,    // host: a share start is mid-flight (re-entrancy guard)
      serialize: null,        // host: SerializeAddon for late-joiner snapshots
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
    s.mountEl.className = 'huddle-terminal-mount hidden' + (s.viewer ? ' is-viewer' : '');
    mountsWrap.appendChild(s.mountEl);

    s.chipEl = document.createElement('div');
    s.chipEl.className = 'huddle-terminal-tab' + (s.viewer ? ' is-viewer' : '');
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

  // Run cb once the layout has truly settled: after web fonts resolve (so
  // xterm measures the real cell width, not a fallback) and two animation
  // frames (so the just-shown panel's dimensions are final). Used before
  // launching claude, whose one-shot welcome banner is static output that
  // never reflows on resize — it MUST be drawn at the final width.
  function whenSettled(cb) {
    const go = () => requestAnimationFrame(() => requestAnimationFrame(cb));
    const fonts = document.fonts && document.fonts.ready;
    if (fonts && typeof fonts.then === 'function') fonts.then(go, go);
    else go();
  }

  function launchClaude(s) {
    if (s.ptyId) window.huddle.terminal.write(s.ptyId, 'claude\r');
  }

  // Ensure session `s` has a live shell. `mode==='claude'` launches Claude
  // Code once the shell is up. Concurrent claude-mode callers fold into the
  // single bootWantsClaude flag so a double-click can't launch it twice.
  async function ensureSession(s, mode) {
    // Viewer tabs have no shell to ensure — they render a remote stream.
    if (s.viewer) return !!s.term;
    if (!engineReady()) {
      if (s.mountEl) s.mountEl.innerHTML = '<div class="huddle-terminal-unavailable">Terminal engine unavailable in this build.</div>';
      return false;
    }
    if (!s.term) {
      s.term = makeTerm({ cursorBlink: true });
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
        s.unsubData = window.huddle.terminal.onData((p) => {
          if (p.id !== s.ptyId) return;
          s.term.write(p.data);
          // Mirror output to call participants while this tab is shared.
          if (s.share) queueShareFrame(s, p.data);
        });
        s.unsubExit = window.huddle.terminal.onExit((p) => {
          if (p.id !== s.ptyId) return;
          s.term.write('\r\n\x1b[90m[process exited — press any key to start a new shell]\x1b[0m\r\n');
          cleanupSubs(s);
          s.ptyId = null;
        });
        // Rough-fit immediately so a plain shell is close, then re-fit once
        // the layout has truly settled and only THEN launch claude — its
        // welcome banner is static output drawn once at start, so the pty
        // must be at its final width before `claude` runs or the banner is
        // stuck too wide and overflows the panel. bootWantsClaude persists
        // (it's consumed here, not reset in the finally) so a claude request
        // that arrived mid-boot still fires.
        fitSession(s);
        whenSettled(() => {
          if (s.closed || !s.ptyId) return;
          fitSession(s);
          if (s.bootWantsClaude) { s.bootWantsClaude = false; launchClaude(s); }
        });
        return true;
      } catch (err) {
        if (!s.closed) s.term.write(`\r\n\x1b[31m[terminal] ${err && err.message ? err.message : 'failed to start shell'}\x1b[0m\r\n`);
        return false;
      }
    })();
    // Note: bootWantsClaude is NOT reset here — it's consumed by the
    // whenSettled callback above (which fires after this returns), so a
    // claude launch deferred for settle isn't dropped.
    try { return await s.bootPromise; }
    finally { s.bootPromise = null; }
  }

  function killSessionShell(s) {
    cleanupSubs(s);
    if (s.ptyId) { try { window.huddle?.terminal?.kill(s.ptyId); } catch {} s.ptyId = null; }
  }

  // --- share to call (host side) -----------------------------------

  const SHARE_FLUSH_MS = 50;        // coalesce pty chunks into ~20 frames/s
  const SHARE_MAX_BUF = 24 * 1024;  // …but flush a burst before it outgrows a broadcast message
  const SNAPSHOT_SCROLLBACK = 200;  // lines of history a late joiner gets

  // Narrow send-only facade exposed by app.js — the panel never touches
  // the HuddleClient itself; inbound events are relayed in by app.js.
  function shareApi() { return window.huddleApp?.terminalShare || null; }
  function inCall() { return !!window.huddleApp?.getActiveCallChannelId?.(); }

  function notice(s, text, color = '36') {
    if (!s.closed && s.term) s.term.write(`\r\n\x1b[${color}m[share] ${text}\x1b[0m\r\n`);
  }

  // Remote-controlled strings (teammate display names) get written into a
  // local xterm — strip control/escape characters so a crafted name can't
  // inject escape sequences into the viewer's terminal.
  function sanitizeRemoteText(text, fallback) {
    const clean = String(text || '').replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
    return clean || fallback;
  }

  async function toggleShareActive() {
    const s = active;
    if (!s || s.viewer) return;
    if (s.share) { await unshareSession(s); updateHeaderButtons(); return; }
    // Re-entrancy guard: two fast clicks must not start two shares (the
    // second would leak, since s.share only ends up holding one id).
    if (s.sharePending) return;
    const api = shareApi();
    if (!api || !inCall()) { notice(s, 'join a call first', '33'); return; }
    s.sharePending = true;
    try {
      if (!s.term && !(await ensureSession(s))) return;
      // Serialize addon renders the current screen+scrollback for late
      // joiners. Loaded lazily on first share; harmless if the vendor file
      // is missing (joiners then start from live output only).
      const SA = window.SerializeAddon?.SerializeAddon;
      if (SA && !s.serialize) { s.serialize = new SA(); s.term.loadAddon(s.serialize); }
      const shareId = crypto.randomUUID();
      try {
        await api.start(shareId);
      } catch (err) {
        notice(s, err?.message || 'failed to start sharing', '31');
        return;
      }
      // The tab may have been closed/stopped during the awaits above.
      // Don't wire a share onto a dead session — retract the one we just
      // announced so viewers don't watch a stream that never flows.
      if (s.closed) { try { await api.stop(shareId); } catch {} return; }
      s.share = { id: shareId, buf: '', timer: null };
      s.chipEl.classList.add('is-shared');
      notice(s, 'broadcasting this terminal to the call (read-only for viewers)');
    } finally {
      s.sharePending = false;
      updateHeaderButtons();
    }
  }

  // Reset the host-side share state on `s` (timer, flag, chip badge) —
  // shared by the user toggling off, the tab closing, and the call
  // ending, so the three teardown paths can't drift.
  function clearLocalShare(s) {
    const share = s.share;
    if (!share) return null;
    s.share = null;
    if (share.timer) clearTimeout(share.timer);
    s.chipEl.classList.remove('is-shared');
    return share;
  }

  async function unshareSession(s, { silent } = {}) {
    const share = clearLocalShare(s);
    if (!share) return;
    try { await shareApi()?.stop(share.id); } catch {}
    if (!silent) notice(s, 'stopped sharing');
  }

  function queueShareFrame(s, data) {
    const share = s.share;
    share.buf += data;
    if (share.buf.length >= SHARE_MAX_BUF) { flushShare(s); return; }
    if (!share.timer) share.timer = setTimeout(() => flushShare(s), SHARE_FLUSH_MS);
  }

  function flushShare(s) {
    const share = s.share;
    if (!share) return;
    if (share.timer) { clearTimeout(share.timer); share.timer = null; }
    if (!share.buf) return;
    const data = share.buf;
    share.buf = '';
    shareApi()?.frame(share.id, data, s.term.cols, s.term.rows);
  }

  // A viewer joined one of our shares — answer with a snapshot so they
  // see the current screen instead of a blank terminal until new output.
  // Relayed in by app.js from the client's terminal-join event.
  function onShareJoin(d) {
    const s = sessions.find((x) => x.share && x.share.id === d?.shareId);
    if (!s || !d?.from) return;
    let snap = '';
    try { snap = s.serialize ? s.serialize.serialize({ scrollback: SNAPSHOT_SCROLLBACK }) : ''; } catch {}
    shareApi()?.snapshot(s.share.id, d.from, snap, s.term.cols, s.term.rows);
  }

  // --- watching a remote share (viewer side) ------------------------

  // app.js relays terminal-announce here. Creates a read-only viewer tab
  // (no pty, keystrokes wired nowhere) and subscribes to the share's
  // frame channel. Does NOT steal focus or open the panel — app.js
  // toasts, and the tab is waiting when the user opens Terminal.
  function remoteShareStarted(d) {
    if (!d?.shareId || viewers.has(d.shareId)) return;
    if (typeof window.Terminal !== 'function') return;
    const api = shareApi();
    if (!api) return;
    if (!root) buildDom();
    const who = sanitizeRemoteText(d.fromName, 'a teammate');
    const s = makeSession({ viewer: true, label: `${who}'s terminal` });
    s.shareId = d.shareId;
    // Fixed at the host's dims (synced from frame/snapshot payloads) —
    // no FitAddon: reflowing someone else's escape stream to our width
    // would garble it. The mount scrolls if the viewport is smaller.
    s.term = makeTerm({ disableStdin: true, cursorBlink: false });
    s.term.open(s.mountEl);
    s.term.write(`\x1b[36m[watching ${who}'s terminal — read-only]\x1b[0m\r\n`);
    viewers.set(d.shareId, s);
    sendJoin(s);
    if (!active) activate(s);
  }

  // `join` is a best-effort broadcast; the host answers with a snapshot.
  // If it's dropped and the host is idle, we'd sit blank forever — so
  // re-join a couple of times until any data arrives (cleared in
  // markViewerData). Matches the app's other best-effort signalling but
  // with a bounded retry for the one case where silence is indefinite.
  const JOIN_RETRY_MS = 1500;
  const JOIN_MAX_RETRIES = 3;
  function sendJoin(s) {
    if (s.ended || s.closed) return;
    Promise.resolve(shareApi()?.join(s.shareId)).catch((err) => {
      notice(s, `couldn't subscribe: ${err?.message || err}`, '31');
    });
    if (s.joinTimer) clearTimeout(s.joinTimer);
    s.joinTimer = setTimeout(() => {
      s.joinTimer = null;
      if (s.gotData || s.ended || s.closed || s.joinRetries >= JOIN_MAX_RETRIES) return;
      s.joinRetries++;
      sendJoin(s);
    }, JOIN_RETRY_MS);
  }

  // First snapshot/frame → the join landed; stop retrying.
  function markViewerData(s) {
    if (s.gotData) return;
    s.gotData = true;
    if (s.joinTimer) { clearTimeout(s.joinTimer); s.joinTimer = null; }
  }

  function remoteShareStopped(d) {
    const s = viewers.get(d?.shareId);
    if (s) endViewer(s);
  }

  // Keep the viewer term at the host's dimensions. Dims arrive over the
  // network — validate + bound them so a malformed/hostile broadcast
  // can't force a degenerate or enormous resize.
  function syncViewerDims(s, cols, rows) {
    if (!s.term || !Number.isInteger(cols) || !Number.isInteger(rows)) return;
    if (cols < 2 || rows < 2 || cols > 500 || rows > 300) return;
    if (s.term.cols === cols && s.term.rows === rows) return;
    try { s.term.resize(cols, rows); } catch {}
  }

  // Relayed in by app.js from the client's terminal-frame event.
  function onViewerFrame(d) {
    const s = viewers.get(d?.shareId);
    if (!s || s.ended || s.closed) return;
    markViewerData(s);
    syncViewerDims(s, d.cols, d.rows);
    if (d.data) s.term.write(d.data);
  }

  // Relayed in by app.js, which already filtered out snapshots addressed
  // to other joiners (applying someone else's would reset a view that's
  // already streaming).
  function onViewerSnapshot(d) {
    const s = viewers.get(d?.shareId);
    if (!s || s.ended || s.closed || s.gotSnapshot) return;
    // A snapshot (even empty) means the join reached the host — stop
    // retrying. An empty one (host has no serialize addon) we don't apply,
    // or we'd reset and wipe the live frames already shown.
    markViewerData(s);
    if (!d.data) return;
    s.gotSnapshot = true;
    try { s.term.reset(); } catch {}
    syncViewerDims(s, d.cols, d.rows);
    s.term.write(d.data);
  }

  // Share over (host stopped, or the call ended). Keep the tab so the
  // viewer can still scroll back; they close it with its ✕.
  function endViewer(s) {
    if (s.ended) return;
    s.ended = true;
    if (s.joinTimer) { clearTimeout(s.joinTimer); s.joinTimer = null; }
    Promise.resolve(shareApi()?.leave(s.shareId)).catch(() => {});
    if (!s.closed && s.term) s.term.write('\r\n\x1b[90m[share ended]\x1b[0m\r\n');
  }

  // Call torn down (api.js already closed every frame channel and sent
  // terminal-stop for our hosted shares) — reset both sides' UI state.
  function callEnded() {
    for (const s of sessions) {
      if (clearLocalShare(s)) notice(s, 'stopped sharing (call ended)');
    }
    for (const s of viewers.values()) endViewer(s);
    updateHeaderButtons();
  }

  // --- tab management ---------------------------------------------

  // Header buttons act on the active tab; recompute whenever it changes.
  // Claude/Stop are meaningless on a read-only viewer tab; Share flips
  // between share/unshare and needs a live call to enable.
  function updateHeaderButtons() {
    if (!shareBtn) return;
    const s = active;
    const viewer = !!s?.viewer;
    startBtn.disabled = viewer;
    stopBtn.disabled = viewer;
    const sharing = !!s?.share;
    shareBtn.querySelector('span').textContent = sharing ? 'Stop sharing' : 'Share to call';
    shareBtn.classList.toggle('is-sharing', sharing);
    shareBtn.disabled = viewer || (!sharing && !inCall());
    shareBtn.title = viewer ? 'This tab is already a shared view'
      : sharing ? 'Stop broadcasting this tab to the call'
      : inCall() ? "Broadcast this tab's output to everyone on the call (read-only)"
      : 'Join a call to share this terminal';
  }

  function activate(s) {
    if (!s) return;
    active = s;
    for (const other of sessions) {
      const on = other === s;
      other.mountEl.classList.toggle('hidden', !on);
      other.chipEl.classList.toggle('is-active', on);
    }
    updateHeaderButtons();
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
    if (localTabCount() >= MAX_TABS) return null;
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
    if (s.viewer) {
      viewers.delete(s.shareId);
      endViewer(s);
    } else if (s.share) {
      unshareSession(s, { silent: true });
    }
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
    updateHeaderButtons();
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
    if (!s || s.viewer) return;
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

  // Everything after `toggle` is a relay target: app.js wires the
  // HuddleClient's terminal-share events at client creation and forwards
  // them here (the panel never touches the client itself).
  window.HuddleTerminalPanel = {
    open, close, toggle,
    remoteShareStarted, remoteShareStopped, callEnded,
    onShareJoin, onViewerFrame, onViewerSnapshot,
  };

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
