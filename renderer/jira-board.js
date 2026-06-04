// Jira board feature for Huddle — two surfaces:
//   1) In-call overlay — a floating "what we're working on" panel that
//      mirrors the captions dock, showing the team board's In Progress
//      column during a call.
//   2) Kanban drawer  — a full board opened from the left nav, with
//      drag-to-transition, a card detail panel, filters and search.
//
// This is a vanilla-JS port of the Claude Design prototype
// (huddle/jira.jsx). The prototype was React-on-Babel against a future
// OKLCH reskin; here we build plain DOM and lean on the app's existing
// tokens + the real JiraClient (renderer/jira.js) for live data.
//
// Animation rule carried over from the design: only `transform` is ever
// animated for entrances (huddle-fade-up / huddle-pop), never opacity —
// some webview contexts throttle opacity animations and leave panels
// invisible. The visible end-state is always the base style.
(function () {
  const ICON = (name) => window.HuddleIcons?.[name] || '';

  // App-provided bridge. Populated by app.js via init(); defaults keep
  // the module inert (and harmless) if it's ever loaded standalone.
  let ctx = {
    getClient: () => null,          // () -> JiraClient | null
    getSettings: () => ({}),        // () -> settings object
    openSettings: () => {},         // open the Settings modal
    getTeamBoard: () => null,       // () -> team_jira_board row | null
    refreshTeamBoard: async () => null, // re-fetch the team row
    saveTeamBoard: async () => {},  // ({projectKey, site}) -> persist team row
    aiRewrite: async (text) => text, // (current, instruction) -> rewritten text
    popOut: () => {},               // open the board in its own window
    copyText: async () => false,    // (text) -> robust copy-to-clipboard, returns ok
  };

  // The board's active project: the shared team selection wins, falling
  // back to the per-user settings.jira.defaultProject. One helper so the
  // drawer, the in-call overlay, and the toolbar all agree.
  function activeProject() {
    return ctx.getTeamBoard?.()?.project_key || ctx.getSettings()?.jira?.defaultProject || '';
  }

  /* ───────────────────────── tiny DOM helper ───────────────────────── */
  // h('div.cls', { style:{...}, onclick, dataset, html, title }, ...kids)
  function h(spec, props, ...kids) {
    const [tag, ...classes] = String(spec).split('.');
    const el = document.createElement(tag || 'div');
    if (classes.length) el.className = classes.join(' ');
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'class') el.className += ' ' + v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k in el) { try { el[k] = v; } catch { el.setAttribute(k, v); } }
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  // Icon span sized to `size` px, inheriting `color`.
  function icon(name, size = 16, color) {
    const s = h('span.jb-ic', { html: ICON(name) });
    s.style.width = s.style.height = size + 'px';
    if (color) s.style.color = color;
    return s;
  }

  /* ───────────────────────── meta / mapping ───────────────────────── */
  // Jira priority names vary; normalize the common Cloud set onto the
  // four-step severity the design draws.
  function prioMeta(name) {
    const n = String(name || '').toLowerCase();
    if (n.includes('highest') || n === 'urgent' || n.includes('critical') || n.includes('blocker'))
      return { label: 'Urgent', icon: 'chevronsUp', color: 'var(--bad)' };
    if (n.includes('high')) return { label: 'High', icon: 'chevronUp', color: 'var(--warn)' };
    if (n.includes('lowest')) return { label: 'Lowest', icon: 'chevronsDown', color: 'var(--text-faint)' };
    if (n.includes('low')) return { label: 'Low', icon: 'chevronsDown', color: 'var(--text-faint)' };
    return { label: name || 'Medium', icon: 'equal', color: 'var(--accent-2)' };
  }
  // Issue type → glyph + color. Story green, Task/Sub-task blue, Bug red,
  // Epic accent; unknown types fall back to a neutral task tile.
  function typeMeta(name) {
    const n = String(name || '').toLowerCase();
    if (n.includes('bug')) return { icon: 'bug', color: 'var(--bad)' };
    if (n.includes('story')) return { icon: 'bookmark', color: 'var(--good)' };
    if (n.includes('epic')) return { icon: 'star', color: 'var(--accent-2)' };
    return { icon: 'check', color: 'var(--accent-2)' };
  }
  // Column accent + drop-tint by status category. Review-ish columns get
  // the accent treatment to echo the prototype's four-color board.
  function statusColor(cat, name) {
    const c = String(cat || '').toLowerCase();
    if (c === 'done') return 'var(--good)';
    if (c === 'new' || c === 'to do') return 'var(--text-faint)';
    if (/review|qa|test|verify/i.test(name || '')) return 'var(--accent-2)';
    return 'var(--warn)'; // indeterminate / in progress
  }
  const CAT_ORDER = { new: 0, indeterminate: 1, done: 2 };
  // Fields the board list needs. Mirrors what a card/detail render (type,
  // summary, status, priority, assignee) plus `labels` — deliberately
  // without `description`, which is fetched lazily per ticket on open.
  const BOARD_FIELDS = 'summary,status,assignee,issuetype,priority,labels';

  // Normalize a raw Jira issue into the shape the views consume.
  function mapIssue(issue) {
    const f = issue.fields || {};
    const a = f.assignee
      ? [{ id: f.assignee.accountId, name: f.assignee.displayName, email: f.assignee.emailAddress || '' }]
      : [];
    return {
      key: issue.key,
      type: f.issuetype?.name || 'Task',
      summary: f.summary || '(no summary)',
      priority: f.priority?.name || 'Medium',
      assignees: a,
      status: f.status?.name || 'To Do',
      cat: f.status?.statusCategory?.key || 'new',
      labels: Array.isArray(f.labels) ? f.labels : [],
    };
  }

  // Does this column hold the given status? Every column carries
  // `statuses` (the Jira board can group several statuses per column).
  function colHasStatus(col, status) {
    const want = String(status || '').toLowerCase();
    return (col.statuses || [col.id]).some((s) => String(s).toLowerCase() === want);
  }

  // Build ordered column descriptors. When the project's real Agile-board
  // config is available (boardCols), mirror it exactly: Jira's columns, in
  // Jira's order, INCLUDING empty ones (so e.g. "Ready for Release" persists
  // as a drop target), with Jira's status→column grouping. Statuses in play
  // that the config doesn't cover are appended so no card is orphaned.
  // Without a config, fall back to one column per status in play, ordered
  // To Do → In Progress → Done.
  function deriveColumns(issues, boardCols) {
    if (boardCols && boardCols.length) {
      const cols = boardCols.map((c) => ({
        id: c.name,
        name: c.name,
        statuses: c.statuses.map((s) => s.name),
        // Accent the column by its last status's category — for grouped
        // columns that's the "most done" state, matching Jira's tinting.
        cat: c.statuses[c.statuses.length - 1]?.cat || 'new',
      }));
      const covered = new Set(cols.flatMap((c) => c.statuses.map((s) => s.toLowerCase())));
      for (const t of issues) {
        if (covered.has(t.status.toLowerCase())) continue;
        covered.add(t.status.toLowerCase());
        cols.push({ id: t.status, name: t.status, statuses: [t.status], cat: t.cat });
      }
      for (const c of cols) c.accent = statusColor(c.cat, c.name);
      return cols;
    }
    const seen = new Map();
    for (const t of issues) {
      if (!seen.has(t.status)) seen.set(t.status, { id: t.status, name: t.status, statuses: [t.status], cat: t.cat });
    }
    const cols = [...seen.values()];
    cols.sort((a, b) => (CAT_ORDER[a.cat] ?? 1) - (CAT_ORDER[b.cat] ?? 1));
    for (const c of cols) c.accent = statusColor(c.cat, c.name);
    // Guarantee a stable spine even when a category is empty so cards
    // always have somewhere to be dragged.
    if (!cols.length) {
      return [
        { id: 'To Do', name: 'To Do', statuses: ['To Do'], cat: 'new', accent: statusColor('new') },
        { id: 'In Progress', name: 'In Progress', statuses: ['In Progress'], cat: 'indeterminate', accent: statusColor('indeterminate') },
        { id: 'Done', name: 'Done', statuses: ['Done'], cat: 'done', accent: statusColor('done') },
      ];
    }
    return cols;
  }

  /* ───────────────────────── avatars ───────────────────────── */
  // Jira avatar image URLs need auth + cross-origin loads the renderer
  // can't do, so we draw initials on a stable per-person hue instead.
  function hashHue(s) {
    let hsum = 0;
    for (let i = 0; i < (s || '').length; i++) hsum = (hsum * 31 + s.charCodeAt(i)) >>> 0;
    return hsum % 360;
  }
  function initials(name) {
    const parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
  }
  function avatar(user, size = 22) {
    const name = user?.name || 'Unassigned';
    const hue = user?.id || user?.email ? hashHue(user.id || user.email) : 220;
    const el = h('span.jb-avatar', { title: name });
    Object.assign(el.style, {
      width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.42) + 'px',
      background: user ? `hsl(${hue} 52% 42%)` : 'var(--bg-3)',
      color: user ? '#fff' : 'var(--text-faint)',
    });
    el.textContent = user ? initials(name) : '·';
    return el;
  }
  function avatarStack(users, size = 22) {
    const wrap = h('span.jb-avstack');
    (users.length ? users : [null]).slice(0, 3).forEach((u, i) => {
      const a = avatar(u, size);
      if (i) a.style.marginLeft = '-7px';
      wrap.append(a);
    });
    return wrap;
  }

  /* ───────────────────────── shared atoms ───────────────────────── */
  function typeIcon(type, size = 18) {
    const m = typeMeta(type);
    const box = h('span.jb-type', { title: type });
    Object.assign(box.style, {
      width: size + 'px', height: size + 'px', borderRadius: Math.round(size * 0.28) + 'px',
      background: `color-mix(in srgb, ${m.color} 22%, transparent)`,
    });
    box.append(icon(m.icon, Math.round(size * 0.66), m.color));
    return box;
  }
  function priorityIcon(p, size = 15) {
    const m = prioMeta(p);
    return icon(m.icon, size, m.color);
  }
  function statusPill(col, sm) {
    const accent = statusColor(col.cat, col.name);
    const pill = h('span.jb-pill' + (sm ? '.jb-pill-sm' : ''));
    pill.style.color = accent;
    pill.style.background = `color-mix(in srgb, ${accent} 16%, transparent)`;
    const dot = h('span.jb-dot');
    dot.style.background = accent;
    pill.append(dot, document.createTextNode(col.name));
    return pill;
  }
  function label(text) {
    const bug = text === 'bug';
    const el = h('span.jb-label.mono' + (bug ? '.jb-label-bug' : ''));
    el.textContent = text;
    return el;
  }
  function shimmer(w, ht = 12, r = 6) {
    const el = h('span.jb-shimmer');
    Object.assign(el.style, { width: typeof w === 'number' ? w + 'px' : w, height: ht + 'px', borderRadius: r + 'px' });
    return el;
  }

  function notConfigured(compact) {
    return h('div.jb-empty', { style: { padding: compact ? '26px 22px' : '40px' } },
      h('span.jb-empty-ic', { style: compact ? { width: '44px', height: '44px' } : {} }, icon('ticket', compact ? 22 : 28)),
      h('div', null,
        h('div.jb-empty-title', null, 'Connect Jira to see your board'),
        h('p.jb-empty-sub', null, 'Link your Jira site to pull live tickets into Huddle. Your credentials stay in your private row.'),
      ),
      h('button.primary', { onclick: () => ctx.openSettings() }, icon('ticket', 15), h('span', null, 'Connect Jira in Settings')),
      !compact && h('span.jb-empty-meta.mono', null, 'Settings → Integrations → Jira'),
    );
  }

  /* ════════════════════ SURFACE 1 — in-call overlay ════════════════════ */
  let inCall = null; // { root, open }

  function buildInCall() {
    const root = h('section.jb-incall.hidden', { 'aria-label': 'Team board — in progress' });
    document.body.append(root);
    inCall = { root, open: false };
    return inCall;
  }

  function inCallShell(count, refreshing, onRefresh) {
    const head = h('div.jb-incall-head',
      null,
      icon('kanban', 16, 'var(--accent-2)'),
      h('span.jb-incall-title', null, 'In progress'),
      count != null && h('span.jb-count.mono', null, String(count)),
      h('div', { style: { flex: '1' } }),
      iconBtn('refresh', 15, 'Refresh', onRefresh, refreshing),
      iconBtn('x', 15, 'Hide', hideInCall),
    );
    const panel = h('div.jb-incall-panel', null, head);
    return panel;
  }

  function iconBtn(name, size, title, onclick, spinning) {
    const b = h('button.jb-iconbtn', { title, 'aria-label': title, onclick });
    b.append(icon(name, size));
    if (spinning) b.classList.add('jb-spin');
    return b;
  }

  async function renderInCall() {
    if (!inCall) buildInCall();
    await ctx.refreshTeamBoard?.();
    const client = ctx.getClient();
    const project = activeProject();
    inCall.root.innerHTML = '';

    if (!client || !client.isConfigured()) {
      const panel = inCallShell(null, false, () => {});
      panel.append(notConfigured(true));
      inCall.root.append(panel);
      return;
    }
    if (!project) {
      const panel = inCallShell(null, false, () => {});
      panel.append(h('div.jb-empty', { style: { padding: '28px 22px' } },
        h('span.jb-empty-ic', { style: { width: '44px', height: '44px' } }, icon('kanban', 22)),
        h('div.jb-empty-title', null, 'No board picked yet'),
        h('p.jb-empty-sub', null, 'Open the full board to choose a project to track.'),
        h('button.primary', { onclick: () => openDrawer() }, h('span', null, 'Open full board')),
      ));
      inCall.root.append(panel);
      return;
    }

    // loading skeleton
    const loadingPanel = inCallShell(null, false, () => {});
    const loadBody = h('div.jb-incall-body');
    for (let i = 0; i < 4; i++) {
      loadBody.append(h('div.jb-incall-row',
        null,
        shimmer(18, 18, 5),
        h('div', { style: { flex: '1', display: 'flex', flexDirection: 'column', gap: '6px' } }, shimmer(58, 9), shimmer(i % 2 ? '70%' : '88%', 10)),
        shimmer(22, 22, 7),
      ));
    }
    loadingPanel.append(loadBody);
    inCall.root.append(loadingPanel);

    let issues;
    try {
      const jql = `project = "${project}" AND statusCategory = "In Progress" ORDER BY updated DESC`;
      const res = await client.searchIssues(jql, 25);
      issues = (res?.issues || []).map(mapIssue);
    } catch (err) {
      inCall.root.innerHTML = '';
      const panel = inCallShell(0, false, renderInCall);
      panel.append(h('div.jb-empty', { style: { padding: '30px 22px' } },
        h('span.jb-empty-ic', { style: { width: '44px', height: '44px', color: 'var(--bad)' } }, icon('block', 22)),
        h('div.jb-empty-title', null, "Couldn't load the board"),
        h('p.jb-empty-sub', null, String(err?.message || err).slice(0, 140)),
      ));
      inCall.root.append(panel);
      return;
    }

    inCall.root.innerHTML = '';
    const panel = inCallShell(issues.length, false, renderInCall);

    if (!issues.length) {
      panel.append(h('div.jb-empty', { style: { padding: '34px 24px' } },
        h('span.jb-empty-ic.jb-empty-ok', null, icon('check', 24)),
        h('div.jb-empty-title', null, 'Nothing in progress'),
        h('p.jb-empty-sub', null, "The team's board is clear. Nice — you're all caught up."),
        h('button.jb-link', { onclick: () => openDrawer() }, h('span', null, 'Open full board'), icon('arrowRight', 13)),
      ));
      inCall.root.append(panel);
      return;
    }

    const body = h('div.jb-incall-body');
    issues.forEach((t, i) => {
      const row = h('button.jb-incall-row.jb-clickable', {
        onclick: () => openDrawer(t.key),
        style: { animationDelay: `${i * 28}ms` },
      },
        typeIcon(t.type, 18),
        h('div', { style: { flex: '1', minWidth: '0' } },
          h('div.jb-incall-key', null, h('span.mono.jb-key', null, t.key)),
          h('div.jb-incall-summary', { title: t.summary }, t.summary),
        ),
        priorityIcon(t.priority, 15),
        avatar(t.assignees[0], 22),
      );
      row.classList.add('jb-fade');
      body.append(row);
    });
    panel.append(body);
    panel.append(h('div.jb-incall-foot',
      null,
      h('button.ghost.jb-foot-btn', { onclick: () => openDrawer() }, icon('kanban', 15), h('span', null, 'Open board')),
    ));
    inCall.root.append(panel);
  }

  function toggleInCall() {
    if (!inCall) buildInCall();
    inCall.open = !inCall.open;
    inCall.root.classList.toggle('hidden', !inCall.open);
    if (inCall.open) renderInCall();
  }
  function hideInCall() {
    if (!inCall) return;
    inCall.open = false;
    inCall.root.classList.add('hidden');
    // Keep the call-header toggle's pressed state honest when the panel
    // is dismissed from its own X (or when the call ends).
    document.getElementById('btn-board')?.classList.remove('active');
  }
  function isInCallOpen() { return !!inCall?.open; }

  /* ════════════════════ SURFACE 2 — Kanban drawer ════════════════════ */
  let drawer = null; // persistent DOM
  let board = {
    issues: [], columns: [], loading: false, dragKey: null, overCol: null,
    confirming: null, detailKey: null, filter: 'all', query: '', focusKey: null,
    _cols: [], // [{ id, accent, listEl }] rebuilt each renderColumns()
    _descCache: new Map(), // issue key -> loaded description text (success only)
    _descErr: new Set(),   // issue keys whose description fetch FAILED (≠ empty)
  };
  let filterTimer = null; // debounces the board search input

  function buildDrawer() {
    const root = h('div.jb-drawer-root.hidden');
    const backdrop = h('div.jb-drawer-backdrop', { onclick: closeDrawer });
    const panel = h('div.jb-drawer');
    root.append(backdrop, panel);
    document.body.append(root);
    drawer = { root, panel };
    return drawer;
  }

  function toast(type, msg, onRetry) {
    if (!drawer) return;
    drawer.panel.querySelector('.jb-toast')?.remove();
    const err = type === 'error';
    const t = h('div.jb-toast' + (err ? '.jb-toast-err' : ''),
      null,
      h('span.jb-toast-ic', null, icon(err ? 'block' : 'check', 15)),
      h('div', { style: { minWidth: '0' } },
        h('div.jb-toast-title', null, err ? 'Transition rejected' : 'Issue updated'),
        h('div.jb-toast-msg', null, msg),
      ),
      err && onRetry && h('button.solid.jb-toast-retry', { onclick: () => { t.remove(); onRetry(); } }, 'Retry'),
      iconBtn('x', 14, 'Dismiss', () => t.remove()),
    );
    drawer.panel.append(t);
    setTimeout(() => t.remove(), err ? 5000 : 2600);
  }

  // ── card ──
  function kanbanCard(t) {
    const accent = statusColor(t.cat, t.status);
    const card = h('div.jb-card', {
      draggable: !board.confirming,
      title: 'Drag to change status',
    });
    card.style.borderLeftColor = accent;
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', t.key); } catch {}
      board.dragKey = t.key;
      card.classList.add('jb-dragging');
    });
    card.addEventListener('dragend', () => {
      board.dragKey = null; board.overCol = null;
      renderColumns();
    });
    card.addEventListener('click', () => { if (!board.dragKey) openDetail(t.key); });

    if (board.confirming?.key === t.key) {
      card.append(h('div.jb-card-confirm',
        null,
        h('span.jb-spinner'),
        h('span.jb-card-confirm-tx', null, 'Moving…'),
      ));
      card.draggable = false;
    }

    card.append(
      h('div.jb-card-top',
        null,
        typeIcon(t.type, 17),
        h('span.mono.jb-key-dim', null, t.key),
        h('div', { style: { flex: '1' } }),
        priorityIcon(t.priority, 15),
      ),
      h('div.jb-card-summary', null, t.summary),
      h('div.jb-card-foot',
        null,
        h('div.jb-card-labels', null, ...t.labels.slice(0, 4).map(label)),
        avatarStack(t.assignees, 22),
      ),
    );
    return card;
  }

  function matches(t) {
    const f = board.filter;
    const myEmail = (ctx.getSettings()?.jira?.email || '').toLowerCase();
    if (f === 'mine' && !t.assignees.some((a) => (a.email || '').toLowerCase() === myEmail && myEmail)) return false;
    if (f !== 'all' && f !== 'mine' && !t.assignees.some((a) => a.id === f)) return false;
    if (board.query) {
      const hay = (t.key + ' ' + t.summary + ' ' + t.labels.join(' ')).toLowerCase();
      if (!hay.includes(board.query.toLowerCase())) return false;
    }
    return true;
  }

  function kanbanColumn(col) {
    const colEl = h('div.jb-col');
    // dragover must NOT trigger a full re-render — that would rebuild the
    // card DOM mid-drag and kill the drag source. Update the highlight
    // in place instead.
    colEl.addEventListener('dragover', (e) => {
      if (!board.dragKey) return;
      e.preventDefault();
      highlightCol(col.id);
    });
    colEl.addEventListener('drop', (e) => { e.preventDefault(); onDrop(col.id); });

    const tickets = board.issues.filter((t) => colHasStatus(col, t.status) && matches(t));
    const dot = h('span.jb-col-dot'); dot.style.background = col.accent;
    colEl.append(h('div.jb-col-head',
      null,
      dot,
      h('span.jb-col-name', null, col.name),
      h('span.mono.jb-col-count', null, String(tickets.length)),
    ));

    const list = h('div.jb-col-list');
    list.dataset.accent = col.accent;
    if (!tickets.length) {
      list.append(h('div.jb-col-empty', null, icon('kanban', 20), h('span', null, 'No tickets'), h('span.jb-col-empty-sub', null, 'Drag a card here')));
    } else {
      tickets.forEach((t) => list.append(kanbanCard(t)));
    }
    colEl.append(list);
    board._cols.push({ id: col.id, accent: col.accent, listEl: list });
    return colEl;
  }

  // Move the drop highlight to a single column without rebuilding cards.
  function highlightCol(colId) {
    if (board.overCol === colId) return;
    board.overCol = colId;
    for (const c of board._cols) {
      const on = c.id === colId;
      c.listEl.classList.toggle('jb-col-over', on);
      c.listEl.style.borderColor = on ? c.accent : '';
      c.listEl.style.background = on ? `color-mix(in srgb, ${c.accent} 12%, var(--bg-2))` : '';
    }
  }

  function onDrop(colId) {
    const key = board.dragKey;
    board.dragKey = null; board.overCol = null;
    if (!key) return;
    const t = board.issues.find((x) => x.key === key);
    const toCol = board.columns.find((c) => c.id === colId);
    if (!t || !toCol || colHasStatus(toCol, t.status)) { renderColumns(); return; }
    const fromStatus = t.status, fromCat = t.cat;

    board.confirming = { key, col: colId };
    t.status = toCol.statuses[0]; t.cat = toCol.cat; // optimistic; real status resolved below
    renderColumns();

    transitionToColumn(key, toCol).then((landed) => {
      t.status = landed; // the status the workflow actually accepted
      board.confirming = null;
      renderColumns();
      toast('success', `${key} moved to ${toCol.name}.`);
    }).catch((err) => {
      board.confirming = null;
      t.status = fromStatus; t.cat = fromCat; // revert
      renderColumns();
      toast('error', `${err?.message || err}`.slice(0, 160), () => { board.dragKey = key; onDrop(colId); });
    });
  }

  // A Jira board column can group several statuses; resolve the drop by
  // trying the column's statuses in order against the issue's available
  // workflow transitions and applying the first match. Returns the status
  // name actually landed on; throws if the workflow allows none of them so
  // the caller can revert + surface a rejection toast.
  async function transitionToColumn(key, col) {
    const client = ctx.getClient();
    const transitions = await client.listTransitions(key);
    for (const target of (col.statuses || [col.name])) {
      const want = String(target).toLowerCase();
      const match = transitions.find((tr) => (tr.to?.name || '').toLowerCase() === want)
        || transitions.find((tr) => (tr.name || '').toLowerCase() === want);
      if (match) {
        await client.transitionIssue({ key, transitionId: match.id });
        return match.to?.name || target;
      }
    }
    throw new Error(`No workflow transition from this status into "${col.name}".`);
  }

  // ── card detail ──
  async function openDetail(key) {
    board.detailKey = key;
    // Fresh open starts the Edit-with-AI flow clean — never resurrect a
    // stale 'review'/'done' phase (or a stale Undo target) from a prior open.
    delete ewaStore[key];
    renderDetail();
  }
  async function renderDetail() {
    if (!drawer) return;
    drawer.panel.querySelector('.jb-detail')?.remove();
    if (!board.detailKey) return;
    const t = board.issues.find((x) => x.key === board.detailKey);
    if (!t) return;
    const client = ctx.getClient();
    // The detail pill always shows the issue's TRUE status (a board column
    // may group several statuses, so the column name isn't specific enough).
    const col = { name: t.status, cat: t.cat };

    const close = () => { board.detailKey = null; renderDetail(); };
    const head = h('div.jb-detail-head',
      null,
      typeIcon(t.type, 20),
      h('span.mono.jb-key-mid', null, t.key),
      h('div', { style: { flex: '1' } }),
      h('button.solid.jb-open-jira', { onclick: () => openInJira(t.key) }, icon('external', 14), h('span', null, 'Open in Jira')),
      iconBtn('x', 17, 'Close', close),
    );
    const grid = h('div.jb-detail-grid',
      null,
      detailLabel('Status'), statusEditor(t, col),
      detailLabel('Assignee'), assigneeEditor(t),
      detailLabel('Priority'), priorityEditor(t),
      detailLabel('Type'), h('div.jb-detail-val', null, t.type),
      detailLabel('Labels'), labelsEditor(t),
    );
    // Description region hosts the inline "Edit with AI" flow (compose →
    // diff review → apply); mountDescriptionEditor manages its own phases and
    // reads the loaded text from board._descCache, filled just below.
    const descRegion = h('div');
    const body = h('div.jb-detail-body',
      null,
      titleEditor(t),
      grid,
      descRegion,
    );
    const foot = h('div.jb-detail-foot',
      null,
      h('button.solid.jb-foot-btn', { onclick: () => copyLink(t.key) }, icon('link', 15), h('span', null, 'Copy link')),
      h('div', { style: { flex: '1' } }),
      h('span.mono.jb-detail-site', null, jiraSite()),
    );
    const detail = h('div.jb-detail', null, head, body, foot);
    drawer.panel.append(detail);

    const ewaRerender = mountDescriptionEditor(descRegion, t);

    // Lazy-load the full description (ADF → text), cached per key so
    // reopening a ticket (or a re-render while the detail is open) doesn't
    // re-hit the network. The editor shows "Loading…" until the cache fills.
    if (!board._descCache.has(t.key)) {
      board._descErr.delete(t.key);
      try {
        const full = await client.getIssue(t.key, { full: true });
        // Sync labels from the authoritative per-ticket fetch in case they
        // changed since board load; the labels editor reads t.labels on the
        // next render. (Board load already includes labels via BOARD_FIELDS.)
        if (Array.isArray(full?.fields?.labels)) t.labels = full.fields.labels;
        const text = window.jiraAdfToText ? window.jiraAdfToText(full?.fields?.description) : '';
        board._descCache.set(t.key, (text || '').trim());
      } catch {
        // Do NOT cache '' — a failed load must not look like an empty
        // description, or Edit-with-AI could overwrite real unloaded content.
        board._descErr.add(t.key);
      }
      ewaRerender();
    }
  }
  function detailLabel(text) { return h('span.jb-detail-lbl', null, text); }

  /* ─────────────── inline field editors (write via Jira API) ─────────────── */
  const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];

  // Optimistic edit: apply() mutates the local issue, persist() calls Jira.
  // On failure revert() restores. Re-renders the detail + board card both
  // ways so the two stay in sync. Mirrors the drag-to-transition onDrop path.
  async function commitEdit({ apply, revert, persist, okMsg, after }) {
    apply();
    renderDetail(); renderColumns();
    try {
      await persist();
      toast('success', okMsg);
      if (after) after();
    } catch (err) {
      revert();
      renderDetail(); renderColumns();
      toast('error', `${err?.message || err}`.slice(0, 160));
    }
  }

  // A .jb-dd dropdown whose options are produced by loadOptions(query) on
  // open (sync or async) — reuses the toolbar dropdown's markup/CSS. With
  // { searchable }, a pinned search box re-runs loadOptions(query) (debounced)
  // so long lists (assignee) can type-ahead instead of scrolling; loadOptions
  // ignores the query arg for the non-searchable callers (status/priority).
  function lazyDropdown(triggerKids, loadOptions, onSelect, { searchable = false, placeholder = 'Search…' } = {}) {
    const wrap = h('div.jb-dd');
    const btn = h('button.jb-dd-btn', null, ...triggerKids, icon('chevronDown', 14, 'var(--text-faint)'));
    let menu = null, listWrap = null, timer = null;
    function close() { if (menu) { menu.remove(); menu = null; } clearTimeout(timer); document.removeEventListener('mousedown', outside); }
    function outside(e) { if (!wrap.contains(e.target)) close(); }
    function paintRows(options) {
      listWrap.innerHTML = '';
      (options || []).forEach((o) => listWrap.append(h('button.jb-dd-item', { onclick: () => { close(); onSelect(o.value, o); } },
        o.user ? avatar(o.user, 20) : o.icon ? icon(o.icon, 15, 'var(--text-faint)') : h('span', { style: { width: '20px' } }),
        h('span', { style: { flex: '1' } }, o.label))));
      if (!options || !options.length) listWrap.append(h('div.jb-dd-item', { style: { opacity: '.6', cursor: 'default' } }, h('span', { style: { flex: '1' } }, 'No matches')));
    }
    async function runLoad(query) {
      let options;
      try { options = await loadOptions(query); }
      catch (err) { toast('error', `${err?.message || err}`.slice(0, 160)); return; }
      if (menu) paintRows(options);
    }
    async function openMenu() {
      menu = h('div.jb-dd-menu');
      if (searchable) {
        // Pin the search box; scroll only the list below it.
        menu.style.overflow = 'visible'; menu.style.maxHeight = 'none';
        const search = h('input.jb-dd-search', {
          type: 'text', placeholder,
          style: { width: '100%', boxSizing: 'border-box', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)', font: 'inherit', fontSize: '13px', padding: '6px 8px', marginBottom: '4px' },
        });
        search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => runLoad(search.value.trim()), 200); });
        menu.append(search);
        listWrap = h('div.jb-dd-list', { style: { maxHeight: '240px', overflowY: 'auto' } });
        menu.append(listWrap);
        setTimeout(() => search.focus(), 20);
      } else {
        listWrap = menu;
      }
      listWrap.append(h('div.jb-dd-item', { style: { opacity: '.6', cursor: 'default' } }, h('span', { style: { flex: '1' } }, 'Loading…')));
      wrap.append(menu);
      document.addEventListener('mousedown', outside);
      await runLoad('');
    }
    btn.addEventListener('click', () => (menu ? close() : openMenu()));
    wrap.append(btn);
    return wrap;
  }

  function changeStatus(t, transitionId, toName) {
    const prevStatus = t.status, prevCat = t.cat;
    const toCol = board.columns.find((c) => colHasStatus(c, toName));
    commitEdit({
      apply: () => { if (toName) { t.status = toName; t.cat = toCol?.cat || t.cat; } },
      revert: () => { t.status = prevStatus; t.cat = prevCat; },
      persist: () => ctx.getClient().transitionIssue({ key: t.key, transitionId }),
      okMsg: `${t.key} → ${toName}.`,
      // If the new status has no column yet, reload so columns re-derive and
      // the card doesn't vanish into a non-existent column.
      after: () => { if (!toCol) loadBoard(true); },
    });
  }
  function changeAssignee(t, accountId, name) {
    const prev = t.assignees;
    commitEdit({
      apply: () => { t.assignees = accountId ? [{ id: accountId, name: name || 'Assignee', email: '' }] : []; },
      revert: () => { t.assignees = prev; },
      persist: () => ctx.getClient().updateIssue({ key: t.key, assigneeAccountId: accountId }),
      okMsg: accountId ? `${t.key} assigned to ${name}.` : `${t.key} unassigned.`,
    });
  }
  function changePriority(t, name) {
    const prev = t.priority;
    if (name === prev) return;
    commitEdit({
      apply: () => { t.priority = name; },
      revert: () => { t.priority = prev; },
      persist: () => ctx.getClient().updateIssue({ key: t.key, priorityName: name }),
      okMsg: `${t.key} priority → ${name}.`,
    });
  }
  function setLabels(t, labels) {
    const prev = t.labels;
    commitEdit({
      apply: () => { t.labels = labels; },
      revert: () => { t.labels = prev; },
      persist: () => ctx.getClient().updateIssue({ key: t.key, labels }),
      okMsg: `${t.key} labels updated.`,
    });
  }
  function setSummary(t, summary) {
    const prev = t.summary;
    commitEdit({
      apply: () => { t.summary = summary; },
      revert: () => { t.summary = prev; },
      persist: () => ctx.getClient().updateIssue({ key: t.key, summary }),
      okMsg: `${t.key} summary updated.`,
    });
  }

  // ── editable cell builders (read live values off the mapped issue `t`) ──
  function statusEditor(t, col) {
    const client = ctx.getClient();
    return lazyDropdown([statusPill(col)],
      () => Promise.resolve(client.listTransitions(t.key)).then((trs) =>
        (trs || []).map((tr) => ({ value: tr.id, label: tr.to?.name || tr.name, to: tr.to?.name || tr.name, icon: 'flag' }))),
      (id, o) => changeStatus(t, id, o?.to));
  }
  function assigneeEditor(t) {
    const client = ctx.getClient();
    const cur = t.assignees[0] || null;
    return lazyDropdown([avatar(cur, 22), h('span', { style: { marginLeft: '6px' } }, cur?.name || 'Unassigned')],
      (query) => Promise.resolve(client.listAssignableUsers(activeProject(), query || '')).then((us) => [
        // Pin "Unassign" only on the unfiltered list — keep search results clean.
        ...(query ? [] : [{ value: null, label: 'Unassign', icon: 'x' }]),
        // Skip users Jira returns without an accountId (GDPR-stripped / app
        // users) — assigning them would send no field and error on save.
        ...(us || []).filter((u) => u.accountId).map((u) => ({ value: u.accountId, label: u.displayName, user: { id: u.accountId, name: u.displayName, email: u.emailAddress || '' } })),
      ]),
      (accountId, o) => changeAssignee(t, accountId, o?.label),
      { searchable: true, placeholder: 'Search people…' });
  }
  function priorityEditor(t) {
    const client = ctx.getClient();
    return lazyDropdown([priorityIcon(t.priority, 16), h('span', { style: { marginLeft: '6px' } }, prioMeta(t.priority).label)],
      // Pull the project's real priority scheme (custom schemes use different
      // names); fall back to the standard set if the call fails or is empty.
      () => Promise.resolve(client.listPriorities()).then(
        (ps) => (ps && ps.length ? ps.map((p) => ({ value: p.name, label: p.name })) : PRIORITIES.map((p) => ({ value: p, label: p }))),
        () => PRIORITIES.map((p) => ({ value: p, label: p }))),
      (name) => changePriority(t, name));
  }
  function labelsEditor(t) {
    const cell = h('div.jb-card-labels');
    (t.labels || []).forEach((l) => {
      const chip = label(l);
      chip.append(h('button', {
        title: 'Remove label',
        style: { marginLeft: '5px', cursor: 'pointer', background: 'none', border: 'none', color: 'inherit', padding: '0', lineHeight: '1', verticalAlign: 'middle' },
        onclick: () => setLabels(t, t.labels.filter((y) => y !== l)),
      }, icon('x', 10)));
      cell.append(chip);
    });
    const input = h('input', {
      type: 'text', placeholder: '+ label',
      style: { background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: '6px', color: 'var(--text)', font: 'inherit', fontSize: '12px', padding: '2px 6px', width: '84px' },
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const v = input.value.trim();
      if (v && !(t.labels || []).includes(v)) setLabels(t, [...(t.labels || []), v]);
    });
    cell.append(input);
    return cell;
  }
  function titleEditor(t) {
    const titleEl = h('h2.jb-detail-title', { title: 'Click to edit', style: { cursor: 'text' } }, t.summary);
    titleEl.addEventListener('click', () => {
      const input = h('input', {
        type: 'text', value: t.summary,
        // Match .jb-detail-title's box (margin 0 0 16px, 19px/700) so the
        // editor occupies the same space and doesn't overlap the grid below.
        style: { display: 'block', width: '100%', margin: '0 0 16px', font: 'inherit', fontSize: '19px', fontWeight: '700', lineHeight: '1.3', background: 'var(--bg-2)', border: '1px solid var(--accent-2)', borderRadius: '8px', color: 'var(--text)', padding: '6px 10px', boxSizing: 'border-box' },
      });
      titleEl.replaceWith(input);
      input.focus(); input.select();
      let done = false;
      const commit = () => {
        if (done) return; done = true;
        const v = input.value.trim();
        if (v && v !== t.summary) setSummary(t, v); else renderDetail();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { done = true; renderDetail(); }
      });
      input.addEventListener('blur', commit);
    });
    return titleEl;
  }

  /* ───────────── Edit with AI — inline description rewrite ─────────────
     idle → compose → generating → review (diff / clean) → done (undo).
     Anchored to the Description field (never a takeover). The rewrite comes
     from the app bridge (ctx.aiRewrite); Accept persists the new text via
     updateIssue({ description }) (plain text → ADF in JiraClient). */
  const EWA_QUICK = [
    { label: 'Improve writing', instr: 'Improve the writing — clearer, tighter prose. Keep all facts and the section structure.' },
    { label: 'Make concise', instr: 'Make it concise — cut redundancy while keeping the key points and structure.' },
    { label: 'Add acceptance criteria', instr: 'Keep the description and add an "Acceptance Criteria" bulleted checklist, plus an "Out of Scope" section if appropriate.' },
    { label: 'Fix grammar & tone', instr: 'Fix grammar, spelling, and tone. Keep the meaning and structure unchanged.' },
    { label: 'Tighten', instr: 'Tighten every section to its essentials — shorter, punchier prose. Keep the same section headings and order.' },
  ];
  const ewaStore = {};
  function ewaState(key) { return ewaStore[key] || (ewaStore[key] = { phase: 'idle', draft: '', label: '', view: 'diff', prevDesc: null }); }

  // LCS line diff → [{type:'equal'|'add'|'remove', line}].
  function ewaDiffLines(oldText, newText) {
    const a = String(oldText).split('\n'), b = String(newText).split('\n');
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const ops = []; let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ type: 'equal', line: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'remove', line: a[i] }); i++; }
      else { ops.push({ type: 'add', line: b[j] }); j++; }
    }
    while (i < n) ops.push({ type: 'remove', line: a[i++] });
    while (j < m) ops.push({ type: 'add', line: b[j++] });
    return ops;
  }
  function ewaStats(ops) { let add = 0, rem = 0; ops.forEach((o) => { if (o.line.trim()) { if (o.type === 'add') add++; else if (o.type === 'remove') rem++; } }); return { add, rem }; }

  // Markdown line → DOM: **Heading** lines, -/• bullets, **bold** inline.
  function ewaInline(parent, text) {
    String(text).split('**').forEach((p, k) => {
      if (k % 2 === 1) parent.append(h('strong', { style: { color: 'var(--text)', fontWeight: '700' } }, p));
      else if (p) parent.append(document.createTextNode(p));
    });
  }
  function ewaLine(line, color) {
    const s = line.trim();
    if (s === '') return h('div', { style: { height: '9px' } });
    const hStyle = { fontSize: '13.5px', fontWeight: '700', color: 'var(--text)', margin: '13px 0 2px' };
    const atx = /^(#{1,6})\s+(.+?)\s*#*$/.exec(s);          // ## Heading
    if (atx) return h('div', { style: hStyle }, atx[2]);
    if (/^\*\*[^*]+\*\*$/.test(s)) return h('div', { style: hStyle }, s.replace(/^\*\*|\*\*$/g, ''));  // **Heading** (legacy)
    if (/^[-•]\s/.test(s)) {
      const row = h('div', { style: { display: 'flex', gap: '9px', fontSize: '13.8px', lineHeight: '1.6', color, margin: '3px 0' } }, h('span', { style: { color: 'var(--text-faint)', flexShrink: '0' } }, '•'));
      const sp = h('span'); ewaInline(sp, s.replace(/^[-•]\s/, '')); row.append(sp); return row;
    }
    const d = h('div', { style: { fontSize: '13.8px', lineHeight: '1.62', color, margin: '2px 0' } }); ewaInline(d, line); return d;
  }
  function ewaDescBody(text, color) { const w = h('div'); String(text).split('\n').forEach((l) => w.append(ewaLine(l, color || 'var(--text-dim)'))); return w; }
  function ewaDiffView(oldText, newText) {
    const chunks = [];
    ewaDiffLines(oldText, newText).forEach((o) => { const last = chunks[chunks.length - 1]; if (last && last.type === o.type) last.lines.push(o.line); else chunks.push({ type: o.type, lines: [o.line] }); });
    const wrap = h('div');
    chunks.forEach((c) => {
      let lines = c.lines;
      if (c.type !== 'equal') { let s = 0, e = lines.length; while (s < e && lines[s].trim() === '') s++; while (e > s && lines[e - 1].trim() === '') e--; lines = lines.slice(s, e); }
      if (!lines.length) return;
      if (c.type === 'equal') { const box = h('div', { style: { padding: '0 2px' } }); lines.forEach((l) => box.append(ewaLine(l, 'var(--text-dim)'))); wrap.append(box); return; }
      const add = c.type === 'add';
      const box = h('div', { style: { background: `color-mix(in srgb, var(--${add ? 'good' : 'bad'}) 13%, transparent)`, borderLeft: `2px solid var(--${add ? 'good' : 'bad'})`, borderRadius: '0 7px 7px 0', padding: '5px 12px 6px', margin: '5px 0', textDecoration: add ? 'none' : 'line-through' } });
      lines.forEach((l) => box.append(ewaLine(l, add ? 'var(--text)' : 'var(--text-faint)'))); wrap.append(box);
    });
    return wrap;
  }
  function ewaAiMark(size = 22) {
    return h('span', { style: { width: size + 'px', height: size + 'px', borderRadius: '7px', flexShrink: '0', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--accent-dim)', color: 'var(--accent-tx)' } }, icon('sparkles', Math.round(size * 0.6)));
  }
  function ewaBtn(label, { primary, ghost, icon: ic, onClick, title } = {}) {
    const b = h('button', { title: title || '', onclick: onClick, style: { height: '30px', padding: label ? '0 11px' : '0', width: label ? 'auto' : '30px', borderRadius: '8px', fontSize: '12.5px', fontWeight: '600', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '7px', whiteSpace: 'nowrap', cursor: 'pointer', border: primary || ghost ? 'none' : '1px solid var(--border)', background: primary ? 'var(--accent)' : ghost ? 'transparent' : 'var(--bg-2)', color: primary ? '#0b1020' : ghost ? 'var(--text-dim)' : 'var(--text)' } });
    if (ic) b.append(icon(ic, 14));
    if (label) b.append(h('span', null, label));
    return b;
  }

  // Mount the phase-driven description editor into `container`; returns a
  // rerender fn the caller invokes once the description text has loaded.
  function mountDescriptionEditor(container, t) {
    const st = ewaState(t.key);
    const loaded = () => board._descCache.has(t.key);
    const errored = () => board._descErr.has(t.key);
    const desc = () => board._descCache.get(t.key) || '';
    function rerender() { container.innerHTML = ''; container.append(build()); }
    function pickInstr() { const q = EWA_QUICK.find((x) => x.label === st.label); return q ? q.instr : st.label; }

    async function run(instr, label) {
      st.phase = 'generating'; st.label = label; rerender();
      try {
        const out = ((await ctx.aiRewrite(desc(), instr)) || '').trim();
        if (!out) throw new Error('The assistant returned an empty rewrite.');
        st.draft = out; st.phase = 'review'; rerender();
      } catch (err) { st.phase = 'compose'; rerender(); toast('error', `${err?.message || err}`.slice(0, 160)); }
    }
    async function accept() {
      const prev = desc();
      try {
        await ctx.getClient().updateIssue({ key: t.key, description: st.draft });
        st.prevDesc = prev; board._descCache.set(t.key, st.draft); st.draft = ''; st.phase = 'done'; rerender();
        toast('success', `${t.key} description updated.`);
      } catch (err) { toast('error', `${err?.message || err}`.slice(0, 160)); }
    }
    async function undo() {
      if (st.prevDesc == null) { st.phase = 'idle'; rerender(); return; }
      const restore = st.prevDesc;
      try {
        await ctx.getClient().updateIssue({ key: t.key, description: restore });
        board._descCache.set(t.key, restore); st.prevDesc = null; st.phase = 'idle'; rerender();
        toast('success', `${t.key} description restored.`);
      } catch (err) { toast('error', `${err?.message || err}`.slice(0, 160)); }
    }

    function composeBar() {
      const input = h('input', { type: 'text', placeholder: 'Tell Huddle AI how to rewrite this…', style: { flex: '1', border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: '13.5px' } });
      const go = () => { const v = input.value.trim(); if (v) run(v, v); };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); else if (e.key === 'Escape') { st.phase = 'idle'; rerender(); } });
      const chips = h('div', { style: { display: 'flex', gap: '7px', marginTop: '11px', flexWrap: 'wrap' } });
      EWA_QUICK.forEach((q) => chips.append(h('button', { onclick: () => run(q.instr, q.label), style: { fontSize: '12px', fontWeight: '500', color: 'var(--text-dim)', padding: '6px 11px', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-2)', whiteSpace: 'nowrap', cursor: 'pointer' } }, q.label)));
      const box = h('div', { style: { marginTop: '10px', marginBottom: '12px', background: 'var(--bg-2)', border: '1px solid var(--accent-dim)', borderRadius: '11px', padding: '12px', boxShadow: '0 0 0 3px var(--accent-dim)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', marginBottom: '11px' } }, ewaAiMark(22), h('span', { style: { fontSize: '13px', fontWeight: '700' } }, 'Edit description with AI'), h('div', { style: { flex: '1' } }), h('span.mono', { style: { border: '1px solid var(--border)', borderRadius: '5px', padding: '1px 5px', fontSize: '10.5px', color: 'var(--text-faint)' } }, 'esc')),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: '10px', padding: '9px 10px 9px 12px' } }, icon('sparkles', 16), input, ewaBtn('Rewrite', { primary: true, icon: 'send', onClick: go })),
        chips);
      setTimeout(() => input.focus(), 20);
      return box;
    }
    function generatingCard() {
      return h('div', { style: { marginTop: '10px', background: 'var(--bg-2)', border: '1px solid var(--accent-dim)', borderRadius: '11px', padding: '13px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px' } }, ewaAiMark(22), h('span', { style: { fontSize: '13px', fontWeight: '700' } }, 'Huddle AI is rewriting…'),
          st.label && h('span', { style: { fontSize: '11.5px', color: 'var(--accent-tx)', background: 'var(--accent-dim)', padding: '3px 9px', borderRadius: '7px', maxWidth: '170px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, st.label)));
    }
    function reviewCard() {
      const d = desc(); const stats = ewaStats(ewaDiffLines(d, st.draft));
      const seg = h('div', { style: { display: 'flex', gap: '2px', padding: '2px', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: '8px' } });
      const segBtn = (k, lbl) => h('button', { onclick: () => { st.view = k; rerender(); }, style: { fontSize: '11.5px', fontWeight: '600', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', border: 'none', color: st.view === k ? 'var(--text)' : 'var(--text-faint)', background: st.view === k ? 'var(--bg-3)' : 'transparent' } }, lbl);
      seg.append(segBtn('diff', 'Diff'), segBtn('clean', 'New'));
      const refineInput = h('input', { type: 'text', placeholder: 'Refine — e.g. "shorter, add a metrics section"', style: { flex: '1', border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: '13px' } });
      const refineGo = () => { const v = refineInput.value.trim(); if (v) run(v, v); };
      refineInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') refineGo(); });
      return h('div', { style: { marginTop: '10px', background: 'var(--bg-2)', border: '1px solid var(--accent-dim)', borderRadius: '11px', boxShadow: '0 0 0 3px var(--accent-dim)', overflow: 'hidden' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', padding: '11px 12px', borderBottom: '1px solid var(--border)' } }, ewaAiMark(22), h('span', { style: { fontSize: '13px', fontWeight: '700' } }, 'Suggested rewrite'), h('div', { style: { flex: '1' } }), h('span.mono', { style: { fontSize: '11px', color: 'var(--good)' } }, `+${stats.add}`), h('span.mono', { style: { fontSize: '11px', color: 'var(--bad)' } }, `−${stats.rem}`), seg),
        h('div', { style: { padding: '10px 13px', maxHeight: '320px', overflowY: 'auto' } }, st.view === 'diff' ? ewaDiffView(d, st.draft) : ewaDescBody(st.draft)),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', borderTop: '1px solid var(--border)' } }, ewaBtn('Accept', { primary: true, icon: 'check', onClick: accept }), ewaBtn('Discard', { ghost: true, onClick: () => { st.phase = 'idle'; rerender(); } }), h('div', { style: { flex: '1' } }), ewaBtn('Try again', { ghost: true, icon: 'refresh', onClick: () => run(pickInstr(), st.label) })),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', padding: '0 12px 12px' } }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '9px', flex: '1', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: '9px', padding: '8px 9px 8px 11px' } }, icon('pen', 14), refineInput, ewaBtn('', { icon: 'arrowRight', onClick: refineGo }))));
    }

    function build() {
      const wrap = h('div');
      const headRow = h('div', { style: { display: 'flex', alignItems: 'center', minHeight: '28px', marginBottom: '2px' } }, detailLabel('Description'), h('div', { style: { flex: '1' } }));
      // Only offer Edit-with-AI once the real description has loaded — never
      // over a failed/unloaded fetch (which would risk overwriting content).
      if (st.phase === 'idle' && loaded()) headRow.append(h('button', { onclick: () => { st.phase = 'compose'; rerender(); }, style: { display: 'inline-flex', alignItems: 'center', gap: '6px', height: '28px', padding: '0 11px', borderRadius: '8px', fontSize: '12.5px', fontWeight: '600', color: 'var(--accent-tx)', background: 'transparent', border: '1px solid var(--accent-dim)', cursor: 'pointer' } }, icon('sparkles', 14), h('span', null, 'Edit with AI')));
      else if (st.phase === 'done') headRow.append(h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '9px', fontSize: '12px', color: 'var(--accent-tx)' } }, icon('sparkles', 13), h('span', null, 'Edited with AI'), h('span', { style: { color: 'var(--text-faint)' } }, '·'), h('button', { onclick: undo, style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', fontWeight: '600', color: 'var(--text-dim)', cursor: 'pointer', background: 'none', border: 'none' } }, icon('undo', 12), h('span', null, 'Undo'))));
      wrap.append(headRow);
      if (st.phase === 'compose') wrap.append(composeBar());
      else if (st.phase === 'generating') wrap.append(generatingCard());
      else if (st.phase === 'review') wrap.append(reviewCard());
      if (st.phase === 'idle' || st.phase === 'done' || st.phase === 'compose') {
        const dimmed = st.phase === 'compose';
        const box = h('div', { style: { marginTop: dimmed ? '4px' : '9px', padding: dimmed ? '10px 12px' : '0', borderRadius: '11px', border: dimmed ? '1px dashed var(--border)' : 'none', opacity: dimmed ? '0.6' : '1' } });
        if (dimmed) box.append(h('div', { style: { fontSize: '10.5px', fontWeight: '700', letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: '7px' } }, 'Current'));
        if (errored()) box.append(h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, h('span', { style: { color: 'var(--bad)' } }, "Couldn't load the description."), ewaBtn('Retry', { onClick: () => { board._descErr.delete(t.key); openDetail(t.key); } })));
        else if (!loaded()) box.append(h('p', { style: { color: 'var(--text-faint)' } }, 'Loading…'));
        else if (!desc()) box.append(h('p', { style: { color: 'var(--text-faint)' } }, 'No description.'));
        else box.append(ewaDescBody(desc()));
        wrap.append(box);
      }
      return wrap;
    }

    rerender();
    return rerender;
  }

  function jiraSite() { return (ctx.getSettings()?.jira?.host || '').replace(/^https?:\/\//, ''); }
  function openInJira(key) {
    const client = ctx.getClient();
    if (client?.isConfigured()) window.open(client.issueUrl(key), '_blank', 'noopener');
  }
  async function copyLink(key) {
    const client = ctx.getClient();
    if (!client?.isConfigured()) return;
    const url = client.issueUrl(key);
    // Route through the app's robust copyToClipboard (navigator.clipboard with
    // an execCommand fallback). The bare navigator.clipboard.writeText used
    // before silently no-op'd when the renderer had no clipboard binding or
    // the write rejected (unfocused / permission), so nothing was copied.
    let ok = false;
    try { ok = await ctx.copyText(url); }
    catch { ok = false; }
    toast(ok ? 'success' : 'error', ok ? 'Link copied to clipboard.' : `Couldn't copy — ${url}`);
  }

  // ── toolbar ──
  function toolbar() {
    const s = ctx.getSettings()?.jira || {};
    const people = new Map();
    for (const t of board.issues) for (const a of t.assignees) if (a.id) people.set(a.id, a);
    const myEmail = (s.email || '').toLowerCase();
    const filterLabel = board.filter === 'all' ? 'All issues'
      : board.filter === 'mine' ? 'My issues'
        : (people.get(board.filter)?.name || 'Filtered');

    const search = h('div.jb-search',
      null,
      icon('search', 15, 'var(--text-faint)'),
      h('input.jb-search-input', {
        type: 'text', placeholder: 'Search this board…', value: board.query,
        // Debounce the (full column rebuild) filter so typing on a large
        // board doesn't churn the DOM + re-attach handlers per keystroke.
        oninput: (e) => {
          board.query = e.target.value; reflectClear();
          clearTimeout(filterTimer);
          filterTimer = setTimeout(renderColumns, 140);
        },
      }),
    );
    const clearBtn = h('button.jb-search-clear' + (board.query ? '' : '.hidden'), {
      onclick: () => { board.query = ''; search.querySelector('input').value = ''; renderColumns(); reflectClear(); },
    }, icon('x', 14, 'var(--text-faint)'));
    search.append(clearBtn);
    function reflectClear() { clearBtn.classList.toggle('hidden', !board.query); }

    return h('div.jb-toolbar',
      null,
      dropdown('filter', filterLabel, [
        { value: 'all', label: 'All issues', icon: 'people' },
        myEmail && { value: 'mine', label: 'My issues', icon: 'star' },
        ...[...people.values()].map((u) => ({ value: u.id, label: u.name, user: u })),
      ].filter(Boolean), board.filter, (v) => { board.filter = v; rerenderToolbar(); renderColumns(); }),
      search,
      h('div', { style: { flex: '1' } }),
      h('span.mono.jb-toolbar-meta', {
        title: 'Shared team board — click to change the project for everyone',
        style: { cursor: 'pointer' },
        onclick: () => { board._pickProject = true; renderDrawer(); },
      }, `${activeProject()} · ${jiraSite()}`),
      iconBtn('refresh', 17, 'Refresh', () => loadBoard(true), board.loading),
    );
  }

  function dropdown(iconName, labelText, options, value, onSelect) {
    const wrap = h('div.jb-dd');
    const btn = h('button.jb-dd-btn',
      null,
      iconName && icon(iconName, 15, 'var(--text-faint)'),
      h('span.jb-dd-label', null, labelText),
      icon('chevronDown', 14, 'var(--text-faint)'),
    );
    const menu = h('div.jb-dd-menu.hidden');
    options.forEach((o) => {
      const row = h('button.jb-dd-item' + (value === o.value ? '.jb-dd-active' : ''), {
        onclick: () => { close(); onSelect(o.value); },
      },
        o.user ? avatar(o.user, 20) : o.icon ? icon(o.icon, 15, 'var(--text-faint)') : h('span', { style: { width: '20px' } }),
        h('span', { style: { flex: '1' } }, o.label),
        value === o.value && icon('check', 14, 'var(--accent-2)'),
      );
      menu.append(row);
    });
    function open() { menu.classList.remove('hidden'); document.addEventListener('mousedown', outside); }
    function close() { menu.classList.add('hidden'); document.removeEventListener('mousedown', outside); }
    function outside(e) { if (!wrap.contains(e.target)) close(); }
    btn.addEventListener('click', () => menu.classList.contains('hidden') ? open() : close());
    wrap.append(btn, menu);
    return wrap;
  }

  // ── first-run picker ──
  // Synchronous: return the hero + a "Loading projects…" placeholder
  // immediately so the drawer shows the loading state, then fill the
  // list once listProjects() resolves (async in the background).
  function firstRun() {
    const client = ctx.getClient();
    const body = h('div.jb-firstrun');
    const inner = h('div.jb-firstrun-inner',
      null,
      h('div.jb-firstrun-hero',
        null,
        h('span.jb-firstrun-ic', null, icon('kanban', 28)),
        h('h2.jb-firstrun-title', null, 'Pick a project to get started'),
        h('p.jb-firstrun-sub', null, "Jira's connected. Choose a project to pin to this workspace — you can switch anytime from the toolbar."),
      ),
    );
    const listEl = h('div.jb-firstrun-list', null, h('div.jb-col-empty', null, icon('refresh', 20), h('span', null, 'Loading projects…')));
    inner.append(listEl);
    body.append(inner);

    Promise.resolve(client?.listProjects()).then((projects) => {
      listEl.innerHTML = '';
      if (!projects || !projects.length) {
        listEl.append(h('div.jb-col-empty', null, h('span', null, 'No projects found for this account.')));
        return;
      }
      projects.forEach((p) => {
        listEl.append(h('button.jb-firstrun-item', {
          onclick: async () => {
            board._pickProject = false;
            // Always re-render, even if the save fails (network/RLS) — a
            // rejected await must not leave the picker stuck with no feedback.
            try { await ctx.saveTeamBoard({ projectKey: p.key, site: jiraSite() }); }
            catch (err) { console.warn('team board save failed', err); }
            renderDrawer();
          },
        },
          h('span.jb-firstrun-item-ic', null, icon('kanban', 19)),
          h('div', { style: { flex: '1' } },
            h('div.jb-firstrun-item-name', null, p.name),
            h('div.mono.jb-firstrun-item-meta', null, `${p.key} · ${jiraSite()}`),
          ),
          icon('chevronRight', 17, 'var(--text-faint)'),
        ));
      });
    }).catch((err) => {
      listEl.innerHTML = '';
      listEl.append(h('div.jb-col-empty', null, icon('block', 20), h('span', null, String(err?.message || err).slice(0, 120))));
    });
    return body;
  }

  /* ── drawer render orchestration ── */
  function rerenderToolbar() {
    const old = drawer.panel.querySelector('.jb-toolbar');
    if (old) old.replaceWith(toolbar());
  }
  function renderColumns() {
    if (!drawer) return;
    const board$ = drawer.panel.querySelector('.jb-board');
    if (!board$) return;
    board$.innerHTML = '';
    board._cols = [];
    if (board.loading) {
      for (const col of (board.columns.length ? board.columns : deriveColumns([]))) {
        board$.append(skeletonColumn());
      }
      return;
    }
    for (const col of board.columns) board$.append(kanbanColumn(col));
    renderDetail();
  }
  function skeletonColumn() {
    const col = h('div.jb-col');
    col.append(h('div.jb-col-head', null, shimmer(10, 10, 5), shimmer(84, 11)));
    const list = h('div.jb-col-list');
    for (let i = 0; i < 3; i++) {
      list.append(h('div.jb-card.jb-card-skel',
        null,
        h('div.jb-card-top', null, shimmer(17, 17, 5), shimmer(56, 10)),
        shimmer('92%', 11), shimmer('64%', 11),
        h('div.jb-card-foot', null, shimmer(44, 16, 5), h('div', { style: { flex: '1' } }), shimmer(22, 22, 7)),
      ));
    }
    col.append(list);
    return col;
  }

  function renderDrawer() {
    if (!drawer) buildDrawer();
    drawer.panel.innerHTML = '';
    const client = ctx.getClient();
    const project = activeProject();

    const inPopout = document.body.classList.contains('popout-board');
    const head = h('div.jb-drawer-head',
      null,
      icon('kanban', 20, 'var(--accent-2)'),
      h('span.jb-drawer-title', null, 'Board'),
      project && client?.isConfigured() && h('span.mono.jb-drawer-chip', null, project),
      h('div', { style: { flex: '1' } }),
      project && client?.isConfigured() && h('button.solid.jb-open-jira', { onclick: () => openBoardInJira() }, icon('external', 14), h('span', null, 'Open in Jira')),
      // Pop the board into its own window (not shown when already in one).
      !inPopout && iconBtn('popout', 18, 'Open board in its own window', () => ctx.popOut?.()),
      iconBtn('x', 18, inPopout ? 'Close window' : 'Close board', inPopout ? () => window.close() : closeDrawer),
    );
    drawer.panel.append(head);

    if (!client || !client.isConfigured()) {
      drawer.panel.append(notConfigured(false));
      return;
    }
    if (!project || board._pickProject) {
      drawer.panel.append(firstRun());
      return;
    }
    drawer.panel.append(toolbar());
    drawer.panel.append(h('div.jb-board'));
    loadBoard();
  }

  function openBoardInJira() {
    const client = ctx.getClient();
    const project = activeProject();
    // Route through the shared client's /browse/<key> URL — portable
    // across Jira Cloud and Server/DC — rather than the Cloud-only
    // next-gen board path (which 404s on self-hosted instances).
    if (client?.isConfigured() && project) window.open(client.projectUrl(project), '_blank', 'noopener');
  }

  // The project's Agile-board column config, cached per project for the
  // session. Resilience chain: live Agile API → columns cached on the team
  // row → null (deriveColumns falls back to live statuses).
  async function getBoardCols(project) {
    if (board._cfgCache?.project === project) return board._cfgCache.cols;
    let cols = null;
    try { cols = await ctx.getClient().getBoardConfig(project); } catch { cols = null; }
    if (cols) {
      // Persist for resilience — but only when a team row already exists, so
      // we never create a shared pin as a side effect of a per-user fallback.
      const row = ctx.getTeamBoard?.();
      if (row && JSON.stringify(row.columns || null) !== JSON.stringify(cols)) {
        Promise.resolve(ctx.saveTeamBoard?.({ projectKey: project, columns: cols })).catch(() => {});
      }
    } else {
      const cached = ctx.getTeamBoard?.()?.columns;
      if (Array.isArray(cached) && cached.length) cols = cached;
    }
    board._cfgCache = { project, cols };
    return cols;
  }

  async function loadBoard(isRefresh) {
    const client = ctx.getClient();
    const project = activeProject();
    if (!client?.isConfigured() || !project) return;
    board._descCache.clear(); // descriptions may have changed since last load
    board._descErr.clear();
    for (const k in ewaStore) delete ewaStore[k]; // drop stale Edit-with-AI phases
    board.loading = true;
    if (isRefresh) { rerenderToolbar(); board._cfgCache = null; } // re-pull column config on explicit refresh
    renderColumns();
    try {
      const cfgPromise = getBoardCols(project); // in parallel with the search
      const jql = `project = "${project}" ORDER BY status ASC, updated DESC`;
      // Explicit field list = the card/detail fields PLUS `labels` (which
      // BRIEF omits), minus `description` (too heavy across 100 issues).
      const res = await client.searchIssues(jql, 100, { fields: BOARD_FIELDS });
      board.issues = (res?.issues || []).map(mapIssue);
      board.columns = deriveColumns(board.issues, await cfgPromise);
    } catch (err) {
      board.loading = false;
      if (isRefresh) rerenderToolbar();
      const board$ = drawer.panel.querySelector('.jb-board');
      if (board$) {
        board$.innerHTML = '';
        board$.append(h('div.jb-empty', { style: { margin: 'auto' } },
          h('span.jb-empty-ic', { style: { color: 'var(--bad)' } }, icon('block', 28)),
          h('div.jb-empty-title', null, "Couldn't load the board"),
          h('p.jb-empty-sub', null, String(err?.message || err).slice(0, 160)),
          h('button.primary', { onclick: () => loadBoard(true) }, h('span', null, 'Try again')),
        ));
      }
      return;
    }
    board.loading = false;
    if (isRefresh) rerenderToolbar();
    renderColumns();
  }

  async function openDrawer(focusKey) {
    if (!drawer) buildDrawer();
    board.detailKey = null;
    board._pickProject = false;
    board.query = ''; board.filter = 'all';
    drawer.root.classList.remove('hidden');
    drawer.panel.classList.remove('jb-slide'); void drawer.panel.offsetWidth; drawer.panel.classList.add('jb-slide');
    // Clear stale content up front so the panel isn't showing the previous
    // open's board during the (brief) team-row fetch below.
    drawer.panel.innerHTML = '';
    // Pull the shared team selection before deciding first-run vs. board.
    await ctx.refreshTeamBoard?.();
    renderDrawer();
    if (focusKey) openDetail(focusKey);
  }
  function closeDrawer() {
    if (!drawer) return;
    drawer.root.classList.add('hidden');
    board.detailKey = null;
  }
  function toggleDrawer() {
    if (drawer && !drawer.root.classList.contains('hidden')) closeDrawer();
    else openDrawer();
  }

  // Esc closes detail, then drawer.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (drawer && !drawer.root.classList.contains('hidden')) {
      if (board.detailKey) { board.detailKey = null; renderDetail(); }
      else closeDrawer();
    } else if (inCall?.open) {
      hideInCall();
    }
  });

  /* ───────────────────────── public API ───────────────────────── */
  function init(bridge) { ctx = { ...ctx, ...bridge }; }

  window.HuddleJiraBoard = {
    init, openDrawer, closeDrawer, toggleDrawer,
    toggleInCall, hideInCall, isInCallOpen,
    // exposed for app.js to refresh the in-call panel when settings change
    refreshInCall: () => { if (inCall?.open) renderInCall(); },
    // Re-render the drawer if it's open (e.g. a teammate changed the shared
    // board project via realtime) — picks up the new active project.
    reloadDrawer: () => { if (drawer && !drawer.root.classList.contains('hidden')) renderDrawer(); },
  };
})();
