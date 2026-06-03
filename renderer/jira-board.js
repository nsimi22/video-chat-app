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

  // Build ordered column descriptors from the statuses present in the
  // returned issues. Real Jira boards have arbitrary status names; we
  // surface exactly the ones in play, ordered To Do → In Progress → Done.
  function deriveColumns(issues) {
    const seen = new Map();
    for (const t of issues) {
      if (!seen.has(t.status)) seen.set(t.status, { id: t.status, name: t.status, cat: t.cat });
    }
    const cols = [...seen.values()];
    cols.sort((a, b) => (CAT_ORDER[a.cat] ?? 1) - (CAT_ORDER[b.cat] ?? 1));
    for (const c of cols) c.accent = statusColor(c.cat, c.name);
    // Guarantee a stable spine even when a category is empty so cards
    // always have somewhere to be dragged.
    if (!cols.length) {
      return [
        { id: 'To Do', name: 'To Do', cat: 'new', accent: statusColor('new') },
        { id: 'In Progress', name: 'In Progress', cat: 'indeterminate', accent: statusColor('indeterminate') },
        { id: 'Done', name: 'Done', cat: 'done', accent: statusColor('done') },
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
    _descCache: new Map(), // issue key -> loaded description text
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

    const tickets = board.issues.filter((t) => t.status === col.id && matches(t));
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

  function onDrop(toStatus) {
    const key = board.dragKey;
    board.dragKey = null; board.overCol = null;
    if (!key) return;
    const t = board.issues.find((x) => x.key === key);
    if (!t || t.status === toStatus) { renderColumns(); return; }
    const fromCol = board.columns.find((c) => c.id === t.status);
    const toCol = board.columns.find((c) => c.id === toStatus);
    const fromStatus = t.status, fromCat = t.cat;

    board.confirming = { key, col: toStatus };
    t.status = toStatus; t.cat = toCol?.cat || t.cat; // optimistic
    renderColumns();

    transition(key, toStatus).then(() => {
      board.confirming = null;
      renderColumns();
      toast('success', `${key} moved to ${toCol?.name || toStatus}.`);
    }).catch((err) => {
      board.confirming = null;
      t.status = fromStatus; t.cat = fromCat; // revert
      renderColumns();
      toast('error', `${err?.message || err}`.slice(0, 160), () => { board.dragKey = key; onDrop(toStatus); });
    });
  }

  // Resolve the target status name to one of the issue's available
  // workflow transitions, then execute it. Throws if no transition leads
  // to the requested status (e.g. blocked / wrong workflow) so the caller
  // can revert + surface a rejection toast.
  async function transition(key, toStatus) {
    const client = ctx.getClient();
    const transitions = await client.listTransitions(key);
    const want = String(toStatus).toLowerCase();
    const match = transitions.find((tr) => (tr.to?.name || '').toLowerCase() === want)
      || transitions.find((tr) => (tr.name || '').toLowerCase() === want);
    if (!match) throw new Error(`No workflow transition from this status to "${toStatus}".`);
    await client.transitionIssue({ key, transitionId: match.id });
  }

  // ── card detail ──
  async function openDetail(key) {
    board.detailKey = key;
    renderDetail();
  }
  async function renderDetail() {
    if (!drawer) return;
    drawer.panel.querySelector('.jb-detail')?.remove();
    if (!board.detailKey) return;
    const t = board.issues.find((x) => x.key === board.detailKey);
    if (!t) return;
    const client = ctx.getClient();
    const col = board.columns.find((c) => c.id === t.status) || { name: t.status, cat: t.cat };

    const close = () => { board.detailKey = null; renderDetail(); };
    const head = h('div.jb-detail-head',
      null,
      typeIcon(t.type, 20),
      h('span.mono.jb-key-mid', null, t.key),
      h('div', { style: { flex: '1' } }),
      h('button.solid.jb-open-jira', { onclick: () => openInJira(t.key) }, icon('external', 14), h('span', null, 'Open in Jira')),
      iconBtn('x', 17, 'Close', close),
    );
    const descBox = h('p.jb-detail-desc', null, 'Loading…');
    const grid = h('div.jb-detail-grid',
      null,
      detailLabel('Status'), statusEditor(t, col),
      detailLabel('Assignee'), assigneeEditor(t),
      detailLabel('Priority'), priorityEditor(t),
      detailLabel('Type'), h('div.jb-detail-val', null, t.type),
      detailLabel('Labels'), labelsEditor(t),
    );
    // Description stays read-only here — rich text is ADF; "Edit with AI"
    // hands the change to the assistant, which calls jira_update_issue.
    const descHead = h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      detailLabel('Description'),
      h('div', { style: { flex: '1' } }),
      h('button.jb-link', {
        title: 'Edit the description with Huddle AI',
        onclick: () => window.HuddleAIPanel?.open?.(`Update the description of ${t.key} to: `),
      }, icon('sparkles', 13), h('span', null, 'Edit with AI')),
    );
    const body = h('div.jb-detail-body',
      null,
      titleEditor(t),
      grid,
      descHead,
      descBox,
    );
    const foot = h('div.jb-detail-foot',
      null,
      h('button.solid.jb-foot-btn', { onclick: () => copyLink(t.key) }, icon('link', 15), h('span', null, 'Copy link')),
      h('div', { style: { flex: '1' } }),
      h('span.mono.jb-detail-site', null, jiraSite()),
    );
    const detail = h('div.jb-detail', null, head, body, foot);
    drawer.panel.append(detail);

    // Lazy-load the full description (ADF → text), cached per key so
    // reopening a ticket (or a re-render while the detail is open)
    // doesn't re-hit the network. Cache is dropped on board reload.
    if (board._descCache.has(t.key)) {
      descBox.textContent = board._descCache.get(t.key);
    } else {
      try {
        const full = await client.getIssue(t.key, { full: true });
        // Sync labels from the authoritative per-ticket fetch in case they
        // changed since board load; the labels editor reads t.labels on the
        // next render. (Board load already includes labels via BOARD_FIELDS.)
        if (Array.isArray(full?.fields?.labels)) t.labels = full.fields.labels;
        const text = window.jiraAdfToText ? window.jiraAdfToText(full?.fields?.description) : '';
        const out = (text || '').trim() || 'No description.';
        board._descCache.set(t.key, out);
        descBox.textContent = out;
      } catch {
        descBox.textContent = 'Could not load the description.';
      }
    }
  }
  function detailLabel(text) { return h('span.jb-detail-lbl', null, text); }

  /* ─────────────── inline field editors (write via Jira API) ─────────────── */
  const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];

  // Optimistic edit: apply() mutates the local issue, persist() calls Jira.
  // On failure revert() restores. Re-renders the detail + board card both
  // ways so the two stay in sync. Mirrors the drag-to-transition onDrop path.
  async function commitEdit({ apply, revert, persist, okMsg }) {
    apply();
    renderDetail(); renderColumns();
    try {
      await persist();
      toast('success', okMsg);
    } catch (err) {
      revert();
      renderDetail(); renderColumns();
      toast('error', `${err?.message || err}`.slice(0, 160));
    }
  }

  // A .jb-dd dropdown whose options are produced by loadOptions() on first
  // open (sync or async) — reuses the toolbar dropdown's markup/CSS.
  function lazyDropdown(triggerKids, loadOptions, onSelect) {
    const wrap = h('div.jb-dd');
    const btn = h('button.jb-dd-btn', null, ...triggerKids, icon('chevronDown', 14, 'var(--text-faint)'));
    let menu = null;
    function close() { if (menu) { menu.remove(); menu = null; } document.removeEventListener('mousedown', outside); }
    function outside(e) { if (!wrap.contains(e.target)) close(); }
    async function openMenu() {
      btn.disabled = true;
      let options;
      try { options = await loadOptions(); }
      catch (err) { toast('error', `${err?.message || err}`.slice(0, 160)); btn.disabled = false; return; }
      btn.disabled = false;
      menu = h('div.jb-dd-menu');
      (options || []).forEach((o) => menu.append(h('button.jb-dd-item', { onclick: () => { close(); onSelect(o.value, o); } },
        o.user ? avatar(o.user, 20) : o.icon ? icon(o.icon, 15, 'var(--text-faint)') : h('span', { style: { width: '20px' } }),
        h('span', { style: { flex: '1' } }, o.label))));
      wrap.append(menu);
      document.addEventListener('mousedown', outside);
    }
    btn.addEventListener('click', () => (menu ? close() : openMenu()));
    wrap.append(btn);
    return wrap;
  }

  function changeStatus(t, transitionId, toName) {
    const prevStatus = t.status, prevCat = t.cat;
    const toCol = board.columns.find((c) => (c.name || '').toLowerCase() === (toName || '').toLowerCase());
    commitEdit({
      apply: () => { if (toName) { t.status = toName; t.cat = toCol?.cat || t.cat; } },
      revert: () => { t.status = prevStatus; t.cat = prevCat; },
      persist: () => ctx.getClient().transitionIssue({ key: t.key, transitionId }),
      okMsg: `${t.key} → ${toName}.`,
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
      () => Promise.resolve(client.listAssignableUsers(activeProject())).then((us) => [
        { value: null, label: 'Unassign', icon: 'x' },
        ...(us || []).map((u) => ({ value: u.accountId, label: u.displayName, user: { id: u.accountId, name: u.displayName, email: u.emailAddress || '' } })),
      ]),
      (accountId, o) => changeAssignee(t, accountId, o?.label));
  }
  function priorityEditor(t) {
    return lazyDropdown([priorityIcon(t.priority, 16), h('span', { style: { marginLeft: '6px' } }, prioMeta(t.priority).label)],
      () => Promise.resolve(PRIORITIES.map((p) => ({ value: p, label: p }))),
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
        style: { width: '100%', font: 'inherit', fontWeight: '600', background: 'var(--bg-2)', border: '1px solid var(--accent-2)', borderRadius: '8px', color: 'var(--text)', padding: '6px 10px', boxSizing: 'border-box' },
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

  function jiraSite() { return (ctx.getSettings()?.jira?.host || '').replace(/^https?:\/\//, ''); }
  function openInJira(key) {
    const client = ctx.getClient();
    if (client?.isConfigured()) window.open(client.issueUrl(key), '_blank', 'noopener');
  }
  function copyLink(key) {
    const client = ctx.getClient();
    if (client?.isConfigured() && navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(client.issueUrl(key)).then(() => toast('success', 'Link copied to clipboard.'));
    }
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

    const head = h('div.jb-drawer-head',
      null,
      icon('kanban', 20, 'var(--accent-2)'),
      h('span.jb-drawer-title', null, 'Board'),
      project && client?.isConfigured() && h('span.mono.jb-drawer-chip', null, project),
      h('div', { style: { flex: '1' } }),
      project && client?.isConfigured() && h('button.solid.jb-open-jira', { onclick: () => openBoardInJira() }, icon('external', 14), h('span', null, 'Open in Jira')),
      iconBtn('x', 18, 'Close board', closeDrawer),
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

  async function loadBoard(isRefresh) {
    const client = ctx.getClient();
    const project = activeProject();
    if (!client?.isConfigured() || !project) return;
    board._descCache.clear(); // descriptions may have changed since last load
    board.loading = true;
    if (isRefresh) rerenderToolbar();
    renderColumns();
    try {
      const jql = `project = "${project}" ORDER BY status ASC, updated DESC`;
      // Explicit field list = the card/detail fields PLUS `labels` (which
      // BRIEF omits), minus `description` (too heavy across 100 issues).
      const res = await client.searchIssues(jql, 100, { fields: BOARD_FIELDS });
      board.issues = (res?.issues || []).map(mapIssue);
      board.columns = deriveColumns(board.issues);
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
