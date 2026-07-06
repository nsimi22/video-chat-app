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
    board: 'kanban',
    ai: 'sparkles',
    terminal: 'terminal',
    recordings: 'film',
    integrations: 'zap',
    settings: 'settings',
  };

  // Single source of truth for view switching. Each "surface" is an
  // overlay/view with a DOM root (open === the root exists without
  // .hidden) plus open/close fns. The base "chat" view and the in-call
  // "calls" tile grid have no surface of their own — showing them just
  // means closing every surface. "settings" stays a popover bridge, not
  // a sticky view (handled in wireClicks).
  const SURFACES = {
    ai: {
      sel: '.huddle-ai-view',
      open: () => window.HuddleAIPanel?.open?.(),
      close: () => window.HuddleAIPanel?.close?.(),
    },
    terminal: {
      sel: '.huddle-terminal-view',
      open: () => window.HuddleTerminalPanel?.open?.(),
      close: () => window.HuddleTerminalPanel?.close?.(),
    },
    recordings: {
      sel: '.huddle-recordings-view',
      open: () => window.HuddleRecordings?.open?.(),
      close: () => window.HuddleRecordings?.close?.(),
    },
    integrations: {
      sel: '.huddle-integrations-view',
      open: () => window.HuddleIntegrations?.open?.(),
      close: () => window.HuddleIntegrations?.close?.(),
    },
    calendar: {
      sel: '.huddle-cal-view',
      // Prefer the v2 grid; fall back to the legacy drawer only if the
      // grid module hasn't loaded. (open() returns undefined, so no ??.)
      open: () => {
        if (window.HuddleCalendarGrid?.open) window.HuddleCalendarGrid.open();
        else document.getElementById('open-calendar')?.click();
      },
      close: () => window.HuddleCalendarGrid?.close?.(),
    },
    board: {
      sel: '.jb-drawer-root',
      open: () => window.HuddleJiraBoard?.openDrawer?.(),
      close: () => window.HuddleJiraBoard?.closeDrawer?.(),
    },
    whiteboard: {
      // Stage-mode whiteboard mounts into #whiteboard-stage (out of
      // call). The chat-header #whiteboard-btn is a toggle, so open/close
      // just click it when the current state needs to flip.
      sel: '#whiteboard-stage',
      open: () => { if (!isSurfaceOpen('whiteboard')) document.getElementById('whiteboard-btn')?.click(); },
      close: () => { if (isSurfaceOpen('whiteboard')) document.getElementById('whiteboard-btn')?.click(); },
    },
  };

  // A surface is open when its root exists and isn't .hidden.
  function isSurfaceOpen(view) {
    const s = SURFACES[view];
    if (!s) return false;
    const el = document.querySelector(s.sel);
    return !!el && !el.classList.contains('hidden');
  }

  // Surfaces the in-call return dock ignores: 'board' is a drawer (not
  // full-cover) and 'whiteboard' is the call-integrated stage. Everything
  // else in SURFACES counts as an overlay hiding the call.
  const DOCK_EXCLUDED_SURFACES = new Set(['board', 'whiteboard']);
  function closeDockOverlays() {
    for (const k of Object.keys(SURFACES)) {
      if (!DOCK_EXCLUDED_SURFACES.has(k) && isSurfaceOpen(k)) SURFACES[k].close();
    }
  }

  // Paint the rail highlight to match exactly one active view.
  function highlightRail(view) {
    document.querySelectorAll('.huddle-rail-item[data-view]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.view === view);
    });
  }

  // THE view-router. Close every surface except the target, open the
  // target (chat / calls have no surface — closing the rest reveals
  // them), then sync the highlight. This is the only place a rail click
  // changes what's on screen; recomputeActiveView() keeps the highlight
  // honest when a surface is dismissed by its own ✕/Esc/backdrop instead.
  function setActiveView(view) {
    for (const k of Object.keys(SURFACES)) {
      if (k !== view && isSurfaceOpen(k)) SURFACES[k].close();
    }
    if (SURFACES[view] && !isSurfaceOpen(view)) SURFACES[view].open();
    highlightRail(view);
  }

  // Derive the active view from what's ACTUALLY visible (DOM truth) so
  // the highlight can't drift: an open overlay wins; else a live,
  // non-minimized call → calls; else the base chat view.
  function recomputeActiveView() {
    // First open surface wins (setActiveView keeps at most one open), in
    // SURFACES declaration order; else a live non-minimized call → calls;
    // else chat. Derived from SURFACES so a new surface needs no edit here.
    let view = Object.keys(SURFACES).find((k) => isSurfaceOpen(k));
    if (!view) {
      view = (document.body.classList.contains('huddle-in-call')
              && !document.body.classList.contains('huddle-call-minimized'))
        ? 'calls' : 'chat';
    }
    highlightRail(view);
  }

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

      // Settings is a popover toggle, not a sticky view: bridge to the
      // legacy element and leave the active highlight untouched.
      if (btn.dataset.action === 'settings') {
        document.getElementById('open-settings')?.click();
        return;
      }

      const view = btn.dataset.view;
      if (!view) return;
      // calls is gated in setupCallsRailItem's capture handler (idle =
      // swallowed); by the time the click reaches here it's valid, so
      // route every view uniformly through the single source of truth.
      setActiveView(view);
    });
  }

  // Custom titlebar (UI v2 design 1.1). Paints the workspace label
  // ("Huddle — <workspace>") from .workspace-name (the sidebar
  // header that app.js writes the team name to on welcome and
  // team-switch), and wires the ⌘K search pill to the command
  // palette. The label re-paints only when the .workspace-name
  // element's text actually mutates — observing the whole document
  // body subtree (the previous approach) fired on every keystroke /
  // typing indicator / reaction render, which is a real perf
  // foot-gun under active chat.
  function wireCustomTitlebar() {
    const labelEl = document.getElementById('huddle-titlebar-label');
    const searchBtn = document.getElementById('huddle-titlebar-search');
    if (searchBtn && !searchBtn.dataset.wired) {
      searchBtn.dataset.wired = '1';
      searchBtn.addEventListener('click', () => {
        window.HuddleCommandPalette?.open?.();
      });
    }
    if (!labelEl) return;
    const teamEl = document.querySelector('.workspace-name');
    const paintLabel = () => {
      const team = teamEl?.textContent?.trim();
      // The initial text is literally "Huddle" — drop the "— Huddle"
      // suffix in that case so the label reads as just "Huddle"
      // before sign-in (otherwise: "Huddle — Huddle").
      labelEl.textContent = (team && team !== 'Huddle') ? `Huddle — ${team}` : 'Huddle';
    };
    paintLabel();
    if (teamEl && 'MutationObserver' in window) {
      // Scope the observer to .workspace-name only. characterData on
      // a small element is cheap; without `subtree` we don't watch
      // anything else.
      new MutationObserver(paintLabel).observe(teamEl, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
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
    // Stamp the OS platform on <body> so CSS can scope the custom
    // titlebar to Mac+Win (Linux falls back to the OS frame). Driven
    // by the preload's `window.huddle.platform` (= process.platform).
    // Safe in legacy mode too — the v2 titlebar CSS gates on
    // [data-ui="v2"] before the platform attribute kicks in.
    const platform = window.huddle?.platform || '';
    if (platform) document.body.dataset.platform = platform;

    // Custom titlebar: paint the workspace label + wire the search
    // pill to open the command palette. The search pill only fires
    // on Mac+Win (the bar is display:none on Linux), so wiring it
    // unconditionally is harmless on Linux — no clicks reach it.
    wireCustomTitlebar();

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


    // The rest of the v2 UI infrastructure only makes sense when
    // [data-ui="v2"] is the active mode. setupCallDock() in
    // particular physically moves the in-call buttons into a new
    // dock div — if that ran in legacy mode (?ui=legacy), the
    // buttons would end up inside a display:none container and
    // become unreachable. Gate the whole v2-only block.
    if (document.documentElement.getAttribute('data-ui') !== 'v2') return;

    // v2 call-view layout: dock mic / cam / share / etc. at the
    // bottom and toggle a body class when in-call so CSS can hide
    // chat + reposition the captions panel.
    setupCallDock();

    // Persistent top dock that surfaces when you nav away from a
    // running call (open AI panel or Calendar grid). Click to
    // return / leave; mirrors mute/cam via existing button bridges.
    setupOverlayCallReturn();

    // Under v2, the legacy calendar drawer (#calendar-drawer) is
    // superseded by the week-grid view. Intercept #open-calendar
    // clicks in the capture phase so the legacy openDrawer()
    // handler never fires; route to the grid instead.
    redirectLegacyCalendar();

    // Wire the call header's "N people · MM:SS" meta — peer count
    // from #tiles[data-kind] DOM and a per-second timer started
    // when body.huddle-in-call is set.
    setupCallMeta();

    // Calls rail item: pulsing live dot when in-call, disabled when
    // idle, and a return-to-call click handler when active.
    setupCallsRailItem();

    // Keep the rail highlight in sync with what's actually on screen,
    // however a surface was opened or dismissed (the single source of
    // truth that replaces the old per-click sticky-active model).
    setupRailViewSync();
  }

  // Mirror body.huddle-in-call onto the Calls rail item:
  //   in-call  → .has-live (pulsing dot) + enabled + return-to-call
  //   idle     → no dot + disabled (no destination yet — Calls view
  //              isn't built; surfacing a click would be a dead end).
  // The return click closes any open v2 overlay so the underlying
  // call tile grid becomes visible — same effect as the existing
  // return-dock back button (.huddle-call-return-back).
  function setupCallsRailItem() {
    const railItem = document.querySelector('.huddle-rail-item[data-view="calls"]');
    if (!railItem) return;
    const apply = () => {
      const inCall = document.body.classList.contains('huddle-in-call');
      railItem.classList.toggle('has-live', inCall);
      railItem.classList.toggle('is-disabled', !inCall);
      if (inCall) railItem.removeAttribute('aria-disabled');
      else railItem.setAttribute('aria-disabled', 'true');
    };
    apply();
    new MutationObserver(apply).observe(document.body, {
      attributes: true, attributeFilter: ['class']
    });
    // Idle: no Calls destination exists, so swallow the click (capture
    // phase) before the bubble-phase router can activate a dead view.
    // In-call: fall through to wireClicks → setActiveView('calls'),
    // which closes any open overlay so the tile grid is on top.
    railItem.addEventListener('click', (e) => {
      if (!document.body.classList.contains('huddle-in-call')) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    }, true);
  }

  // Keep the rail highlight mirroring DOM truth. The router sets the
  // highlight on click, but a surface can also be dismissed by its own
  // ✕/Esc/backdrop, or opened from a non-rail path (command palette,
  // chat-header whiteboard button, call start/end). recomputeActiveView
  // re-derives the highlight from what's actually visible whenever:
  //   • a watched surface root toggles .hidden,
  //   • a lazy overlay root is appended to <body> (first open),
  //   • <body>'s class changes (in-call / minimized → calls vs chat).
  // Deliberately NOT a body-subtree class observer (that fires on every
  // chat render); we watch only the specific roots + body's own class,
  // and coalesce to one rAF so bursts collapse to a single recompute.
  function setupRailViewSync() {
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; recomputeActiveView(); });
    };
    const watched = new WeakSet();
    const watch = (el) => {
      if (!el || watched.has(el)) return;
      watched.add(el);
      new MutationObserver(schedule).observe(el, { attributes: true, attributeFilter: ['class'] });
      schedule();
    };
    // Derive the watched roots from SURFACES (the single source of truth)
    // so registering a new surface there wires this observer too — no
    // parallel hardcoded list to drift out of sync.
    const ROOT_SEL = Object.values(SURFACES).map((s) => s.sel).join(', ');
    // Static root present at load; lazy overlay roots watched as they appear.
    watch(document.getElementById('whiteboard-stage'));
    document.querySelectorAll(ROOT_SEL).forEach(watch);
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node.nodeType === 1 && node.matches?.(ROOT_SEL)) watch(node);
        }
      }
    }).observe(document.body, { childList: true });
    new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    recomputeActiveView();
  }

  // Track call start time + render "N people · MM:SS" while body
  // has .huddle-in-call. Pure DOM-driven, no app.js state coupling.
  function setupCallMeta() {
    const countEl = document.querySelector('.huddle-call-meta-count');
    const timerEl = document.querySelector('.huddle-call-meta-timer');
    if (!countEl || !timerEl) return;
    const tilesEl = document.getElementById('tiles');
    let startedAt = null;
    let tick = null;

    const fmtElapsed = (ms) => {
      const total = Math.floor(ms / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      const mm = String(m).padStart(2, '0');
      const ss = String(s).padStart(2, '0');
      return `${mm}:${ss}`;
    };

    const peerCount = () => {
      // Prefer the truth from the LiveKit room (remote participants + self)
      // — the DOM-tile census below misses mic-only peers and screen-share
      // states (the "1 person" header with four people talking).
      const live = window.huddleApp?.getCallPeerCount?.();
      if (live > 0) return live;
      if (!tilesEl) return 0;
      // Fallback: count camera tiles (own self + remote cams); excludes
      // screen-share + whiteboard tiles and mic-only peers.
      const seen = new Set();
      tilesEl.querySelectorAll('.tile').forEach((t) => {
        const kind = t.dataset.kind;
        if (kind === 'cam' || kind === 'self') {
          const uid = t.dataset.userId || t.dataset.key;
          if (uid) seen.add(uid);
        }
      });
      return seen.size;
    };

    const render = () => {
      const n = peerCount();
      countEl.textContent = `${n} ${n === 1 ? 'person' : 'people'}`;
      if (startedAt) timerEl.textContent = fmtElapsed(Date.now() - startedAt);
      else timerEl.textContent = '00:00';
    };

    const onBodyClass = () => {
      const inCall = document.body.classList.contains('huddle-in-call');
      if (inCall && !startedAt) {
        startedAt = Date.now();
        render();
        if (!tick) tick = setInterval(render, 1000);
      } else if (!inCall && startedAt) {
        startedAt = null;
        if (tick) { clearInterval(tick); tick = null; }
        render();
      }
    };
    onBodyClass();
    new MutationObserver(onBodyClass).observe(document.body, {
      attributes: true, attributeFilter: ['class']
    });
    // Watch tile additions/removals so peer count tracks joins/leaves.
    if (tilesEl) {
      new MutationObserver(render).observe(tilesEl, {
        childList: true, subtree: false,
      });
    }
  }

  function redirectLegacyCalendar() {
    const btn = document.getElementById('open-calendar');
    if (!btn || btn.dataset.v2Intercepted) return;
    btn.dataset.v2Intercepted = '1';
    btn.addEventListener('click', (e) => {
      if (document.documentElement.getAttribute('data-ui') !== 'v2') return;
      if (!window.HuddleCalendarGrid?.open) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      window.HuddleCalendarGrid.open();
    }, true); // capture, before any legacy bubbling handler
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

    const dockIds = ['btn-mic', 'btn-cam', 'btn-blur', 'btn-denoise', 'btn-share', 'btn-hand', 'btn-record', 'btn-react', 'btn-cc', 'btn-leave'];
    // Short labels rendered under each icon-only button per design
    // (CallControl widgets are icon-over-label). Map by id rather than
    // reusing each button's verbose `title` attr ("Toggle microphone"
    // etc.) since the design wants single-word affordances. Leave
    // already has an inline label and skips this map.
    const dockLabels = {
      'btn-mic': 'Mute',
      'btn-cam': 'Camera',
      'btn-blur': 'Blur',
      'btn-denoise': 'Denoise',
      'btn-share': 'Share',
      'btn-hand': 'Raise',
      'btn-record': 'Record',
      'btn-react': 'React',
      'btn-cc': 'Captions',
    };
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
      // Inject the under-icon label as a sibling span. The button keeps
      // its existing event listeners; only its parent changes (here)
      // and a label gets appended to itself (below).
      const labelText = dockLabels[id];
      if (labelText && !btn.querySelector('.huddle-call-dock-label')) {
        const label = document.createElement('span');
        label.className = 'huddle-call-dock-label';
        label.textContent = labelText;
        label.setAttribute('aria-hidden', 'true');
        btn.appendChild(label);
      }
      dock.appendChild(btn);
    }
    stage.appendChild(dock);

    // Sync body classes:
    //   huddle-in-call          = a call is active SOMEWHERE (driven by
    //                             the self-cam tile's existence — that
    //                             tile is created on startCall and
    //                             removed on leaveCall, and persists in
    //                             DOM across channel navigation).
    //   huddle-on-call-channel  = user is currently viewing the call
    //                             channel right now (driven by #tiles
    //                             visibility — gets `.hidden` when the
    //                             user nav's to a non-call channel).
    //
    // Splitting the two so CSS can scope the full call layout (hide
    // chat, show bottom dock) only when ON the call channel; if the
    // user navigates away mid-call, chat stays visible, the bottom
    // dock disappears, and the top return-dock surfaces. Previous
    // implementation used #btn-leave visibility for `huddle-in-call`,
    // but that button is also channel-scoped (renderControls hides it
    // when off-channel), so the body class flipped false on nav-away
    // — breaking the return-dock + Calls-rail "is call active" cues.
    const tilesEl = document.getElementById('tiles');
    const syncBodyClass = () => {
      const inCall = !!tilesEl?.querySelector('.tile[data-kind="self"]');
      document.body.classList.toggle('huddle-in-call', inCall);
    };
    const syncOnChannel = () => {
      const onChannel = tilesEl && !tilesEl.classList.contains('hidden');
      document.body.classList.toggle('huddle-on-call-channel', !!onChannel);
    };
    syncBodyClass();
    syncOnChannel();
    if (tilesEl) {
      // The self-cam tile is added/removed as a child of #tiles, so
      // watch childList. The grid's `.hidden` toggle (channel-scoped)
      // is on attributes — watch separately.
      new MutationObserver(syncBodyClass).observe(tilesEl, {
        childList: true,
      });
      new MutationObserver(syncOnChannel).observe(tilesEl, {
        attributes: true,
        attributeFilter: ['class'],
      });
    }
  }

  // Persistent top dock: appears when an overlay view (AI panel or
  // Calendar grid) is open during an active call. Lets the user
  // hop back to the call or hang up without exiting the overlay.
  // Design source: huddle/app.jsx:CallDock.
  function setupOverlayCallReturn() {
    if (document.querySelector('.huddle-call-return-dock')) return;
    const icon = (name) => (window.HuddleIcons && window.HuddleIcons[name]) || '';
    const dock = document.createElement('div');
    dock.className = 'huddle-call-return-dock hidden';
    dock.innerHTML = `
      <span class="huddle-call-return-live">
        <span class="huddle-call-return-dot"></span>
        <span>Call in <span class="huddle-call-return-channel">#channel</span></span>
      </span>
      <div class="huddle-call-return-spacer"></div>
      <button class="huddle-call-return-mute" type="button" aria-label="Mute" title="Mute">${icon('mic')}</button>
      <button class="huddle-call-return-cam" type="button" aria-label="Camera" title="Camera">${icon('video')}</button>
      <button class="huddle-call-return-back" type="button">${icon('phone')}<span>Return to call</span></button>
      <button class="huddle-call-return-leave" type="button">${icon('phoneOff')}<span>Leave</span></button>
    `;
    document.body.appendChild(dock);

    const channelLabel = dock.querySelector('.huddle-call-return-channel');
    const muteBtnRef = document.getElementById('btn-mic');
    const camBtnRef = document.getElementById('btn-cam');
    const returnMute = dock.querySelector('.huddle-call-return-mute');
    const returnCam = dock.querySelector('.huddle-call-return-cam');

    // Mirror legacy mic/cam state onto the return-dock buttons so
    // the icon (and red "muted" affordance) reflects what's really
    // happening. The click bridges through to #btn-mic / #btn-cam.
    const mirrorMute = () => {
      const muted = !!muteBtnRef?.classList.contains('muted');
      returnMute.classList.toggle('is-muted', muted);
      returnMute.innerHTML = icon(muted ? 'micOff' : 'mic');
    };
    const mirrorCam = () => {
      const off = !!camBtnRef?.classList.contains('muted');
      returnCam.classList.toggle('is-off', off);
      returnCam.innerHTML = icon(off ? 'videoOff' : 'video');
    };
    mirrorMute(); mirrorCam();
    if (muteBtnRef) new MutationObserver(mirrorMute).observe(muteBtnRef, { attributes: true, attributeFilter: ['class'] });
    if (camBtnRef) new MutationObserver(mirrorCam).observe(camBtnRef, { attributes: true, attributeFilter: ['class'] });

    const update = () => {
      const inCall = document.body.classList.contains('huddle-in-call');
      if (!inCall) {
        dock.classList.add('hidden');
        return;
      }
      // On the call channel + no overlay → user is looking AT the
      // call. Hide the return dock.
      const onCallChannel = document.body.classList.contains('huddle-on-call-channel');
      // Any full-cover surface hiding the call → show the return dock.
      // Derived from SURFACES (the single source of truth) so a new view
      // joins automatically — the previous hardcoded ai/cal/term list
      // silently missed every later surface. 'board' (a drawer, not
      // full-cover) and 'whiteboard' (call-integrated stage) keep their
      // pre-existing exclusion.
      const overlayOpen = Object.keys(SURFACES)
        .some((k) => !DOCK_EXCLUDED_SURFACES.has(k) && isSurfaceOpen(k));
      const show = !onCallChannel || overlayOpen;
      dock.classList.toggle('hidden', !show);
      if (show) {
        // The channel-name in chat header is whatever channel the
        // user is currently viewing — that's the right label here
        // (Call in <something else>), but reads weird if same as
        // call. Acceptable trade-off without exposing the inCall
        // channelId.
        const name = document.getElementById('channel-name')?.textContent?.trim() || '';
        channelLabel.textContent = name ? (name.startsWith('#') ? name : `#${name}`) : 'call';
      }
    };

    // Observe body class (in-call + on-call-channel) and re-check
    // on a low-rate tick while in-call so we catch overlay open/
    // close transitions without each module having to ping us.
    let tick = null;
    new MutationObserver(() => {
      update();
      if (document.body.classList.contains('huddle-in-call') && !tick) {
        tick = setInterval(update, 400);
      } else if (!document.body.classList.contains('huddle-in-call') && tick) {
        clearInterval(tick); tick = null;
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    dock.querySelector('.huddle-call-return-mute').addEventListener('click', () => {
      document.getElementById('btn-mic')?.click();
    });
    dock.querySelector('.huddle-call-return-cam').addEventListener('click', () => {
      document.getElementById('btn-cam')?.click();
    });
    dock.querySelector('.huddle-call-return-back').addEventListener('click', () => {
      closeDockOverlays();
      update();
    });
    dock.querySelector('.huddle-call-return-leave').addEventListener('click', () => {
      document.getElementById('btn-leave')?.click();
      closeDockOverlays();
    });

    update();
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
