// v2 calendar week-grid view. Replaces the legacy list drawer as the
// rail's "Calendar" destination under [data-ui="v2"]. Pulls combined
// (Supabase scheduled + ICS) events from the existing HuddleCalendar
// instance via window.huddleApp.getCalendar().listEvents() so there's
// only one source of truth for calendar data.
//
// Layout per huddle/calendar.jsx in the Claude Design bundle:
//   - 60px gutter + 7 day columns (Sun..Sat)
//   - 8am–6pm hour rows, 56px/hour
//   - events positioned absolute by (start - 8) * 56px,
//     height = (durationMin / 60) * 56px
//   - today's date number gets the accent fill
//   - now-line on today's column (2px accent + 10px dot)
//   - prev / next / today nav; "New event" opens existing schedule modal
(function () {
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const HOUR_START = 7;      // 7am — covers early stand-ups
  const HOUR_END = 22;       // 10pm — covers late international calls
  const HOUR_HEIGHT = 56;
  const GUTTER = 60;
  let root = null;
  let unsubscribe = null;
  let weekStart = startOfWeek(new Date());
  let nowTimer = null;
  let dragState = null;   // { e, block, startX, startY, moved } while dragging
  let detailsPopover = null;   // open event-details popover element, if any

  function svg(name) {
    return (window.HuddleIcons && window.HuddleIcons[name]) || '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function startOfWeek(d) {
    const r = new Date(d);
    r.setHours(0, 0, 0, 0);
    r.setDate(r.getDate() - r.getDay()); // Sunday-first
    return r;
  }
  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }
  function fmtHourLabel(h) {
    const ap = h >= 12 ? 'PM' : 'AM';
    const hh = h % 12 || 12;
    return `${hh} ${ap}`;
  }
  function fmtMonthYear(d) {
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }
  function hoursFromMidnight(d) {
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  }

  // Categorize an event into one of the design's 4 calendar bands:
  //   team     → channel name matches a team-y keyword (general,
  //              leadership, team, all-hands, standup, sync)
  //   design   → channel name contains "design"
  //   huddle   → other scheduled huddles
  //   personal → ICS feed events (external calendars)
  //
  // Source-of-truth for category-to-color mapping per the design
  // tokens table in the bundle README:
  //   team    = --accent (indigo)
  //   design  = --live   (teal)
  //   huddle  = --online (green)  // current default
  //   personal= --away   (amber)
  const TEAM_KEYWORDS = /\b(team|general|leadership|all-?hands|stand-?up|sync|company)\b/i;
  const DESIGN_KEYWORDS = /\bdesign\b/i;
  function eventCategory(e) {
    if (e.kind !== 'huddle') return 'personal';
    const name = e.channelId ? (window.huddleApp?.getChannelName?.(e.channelId) || '') : '';
    if (DESIGN_KEYWORDS.test(name)) return 'design';
    if (TEAM_KEYWORDS.test(name)) return 'team';
    return 'huddle';
  }
  function eventColor(e) {
    switch (eventCategory(e)) {
      case 'team':     return 'var(--accent)';
      case 'design':   return 'var(--live)';
      case 'personal': return 'var(--away)';
      case 'huddle':
      default:         return 'var(--online)';
    }
  }

  function isLive(e, now) {
    const endMs = e.start.getTime() + (e.durationMin || 0) * 60000;
    return now.getTime() >= e.start.getTime() && now.getTime() <= endMs;
  }

  // ----- DOM ------------------------------------------------------

  function buildDom() {
    root = document.createElement('div');
    root.className = 'huddle-cal-view hidden';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="huddle-cal-header">
        <span class="huddle-cal-header-icon" aria-hidden="true">${svg('calendar')}</span>
        <span class="huddle-cal-month"></span>
        <div class="huddle-cal-nav">
          <button class="huddle-cal-nav-btn" data-nav="prev" title="Previous week" aria-label="Previous week">${svg('chevronLeft')}</button>
          <button class="huddle-cal-nav-btn" data-nav="next" title="Next week" aria-label="Next week">${svg('chevronRight')}</button>
        </div>
        <button class="huddle-cal-today" data-nav="today">Today</button>
        <div class="huddle-cal-spacer"></div>
        <span class="huddle-cal-legend">
          <span class="huddle-cal-legend-item"><span class="huddle-cal-legend-dot" style="background:var(--accent)"></span>Team</span>
          <span class="huddle-cal-legend-item"><span class="huddle-cal-legend-dot" style="background:var(--live)"></span>Design</span>
          <span class="huddle-cal-legend-item"><span class="huddle-cal-legend-dot" style="background:var(--online)"></span>Huddle</span>
          <span class="huddle-cal-legend-item"><span class="huddle-cal-legend-dot" style="background:var(--away)"></span>Personal</span>
        </span>
        <button class="huddle-cal-new-event" title="Schedule a new event">${svg('plus')}<span>New event</span></button>
        <button class="huddle-cal-close" title="Close" aria-label="Close">${svg('x')}</button>
      </div>
      <div class="huddle-cal-days"></div>
      <div class="huddle-cal-grid-wrap">
        <div class="huddle-cal-grid"></div>
      </div>
    `;
    document.body.appendChild(root);

    root.querySelectorAll('[data-nav]').forEach((btn) => {
      btn.addEventListener('click', () => onNav(btn.dataset.nav));
    });
    root.querySelector('.huddle-cal-new-event').addEventListener('click', () => {
      const cal = window.huddleApp?.getCalendar?.();
      cal?.openScheduleModal?.({ defaultChannelId: window.huddleApp?.getActiveChannelId?.() });
    });
    root.querySelector('.huddle-cal-close').addEventListener('click', close);
  }

  function onNav(dir) {
    if (dir === 'today') weekStart = startOfWeek(new Date());
    else if (dir === 'prev') weekStart = addDays(weekStart, -7);
    else if (dir === 'next') weekStart = addDays(weekStart, 7);
    render();
  }

  // ----- Render ---------------------------------------------------

  function render() {
    if (!root) return;
    closeDetails();   // a repaint (nav / realtime) invalidates any open popover
    const now = new Date();
    const monthYearEl = root.querySelector('.huddle-cal-month');
    monthYearEl.textContent = fmtMonthYear(addDays(weekStart, 3));

    // Day-of-week header row
    const daysEl = root.querySelector('.huddle-cal-days');
    daysEl.innerHTML = `<div class="huddle-cal-days-gutter"></div>` + DAY_NAMES.map((name, i) => {
      const d = addDays(weekStart, i);
      const today = sameDay(d, now);
      return `
        <div class="huddle-cal-day-head${today ? ' is-today' : ''}">
          <div class="huddle-cal-day-name">${name}</div>
          <div class="huddle-cal-day-num${today ? ' is-today' : ''}">${d.getDate()}</div>
        </div>
      `;
    }).join('');

    // Grid: hour gutter + day columns. Each column is positioned
    // relative so events use absolute positioning inside it.
    const gridEl = root.querySelector('.huddle-cal-grid');
    const hourRows = [];
    for (let h = HOUR_START; h <= HOUR_END; h++) {
      hourRows.push(`<div class="huddle-cal-hour"><span class="huddle-cal-hour-label">${fmtHourLabel(h)}</span></div>`);
    }
    const gutterHtml = `<div class="huddle-cal-gutter">${hourRows.join('')}</div>`;
    const cols = DAY_NAMES.map((_, di) => {
      const d = addDays(weekStart, di);
      const today = sameDay(d, now);
      const cells = [];
      for (let h = HOUR_START; h <= HOUR_END; h++) {
        cells.push(`<div class="huddle-cal-cell"></div>`);
      }
      let nowLine = '';
      if (today) {
        const h = hoursFromMidnight(now);
        if (h >= HOUR_START && h <= HOUR_END) {
          const top = (h - HOUR_START) * HOUR_HEIGHT;
          nowLine = `
            <div class="huddle-cal-now" style="top:${top}px;" aria-hidden="true">
              <span class="huddle-cal-now-dot"></span>
            </div>`;
        }
      }
      return `
        <div class="huddle-cal-col${today ? ' is-today' : ''}" data-day="${di}">
          ${cells.join('')}
          ${nowLine}
        </div>
      `;
    }).join('');
    gridEl.innerHTML = gutterHtml + cols;

    // Lay out events inside their column.
    const cal = window.huddleApp?.getCalendar?.();
    if (!cal) {
      renderEmpty();
      return;
    }
    const weekEnd = addDays(weekStart, 7);
    // Pass the viewed week's full range so events appear when navigating
    // into the past (calendar history) or beyond the 2-week look-ahead.
    const all = cal.listEvents({ since: weekStart, until: weekEnd });
    const visible = all.filter((e) => e.start >= weekStart && e.start < weekEnd);

    for (const e of visible) {
      const di = e.start.getDay();
      const col = root.querySelector(`.huddle-cal-col[data-day="${di}"]`);
      if (!col) continue;
      const startH = hoursFromMidnight(e.start);
      if (startH + (e.durationMin || 0) / 60 < HOUR_START) continue;
      if (startH > HOUR_END) continue;

      const clampedStart = Math.max(startH, HOUR_START);
      const clampedEnd = Math.min(startH + (e.durationMin || 30) / 60, HOUR_END);
      const top = (clampedStart - HOUR_START) * HOUR_HEIGHT;
      const h = Math.max(20, (clampedEnd - clampedStart) * HOUR_HEIGHT - 3);
      const color = eventColor(e);
      const live = isLive(e, now);
      const block = document.createElement('div');
      block.className = `huddle-cal-event${live ? ' is-live' : ''}`;
      block.style.top = `${top + 1}px`;
      block.style.height = `${h}px`;
      block.style.setProperty('--cal-event-color', color);
      block.dataset.eventId = e.id;
      const timeLabel = e.start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      let meta = e.kind === 'huddle'
        ? (e.ref?.channelId ? `#${escapeHtml(channelLabel(e.ref.channelId))}` : 'Scheduled call')
        : escapeHtml(e.source || 'External');
      // Surface the "going" headcount on internal-call blocks when anyone
      // has RSVP'd, so the week view conveys turnout at a glance.
      if (e.kind === 'huddle' && e.rsvpCounts?.going) meta += ` · ${e.rsvpCounts.going} going`;
      block.innerHTML = `
        <div class="huddle-cal-event-head">
          ${live ? '<span class="huddle-cal-event-live-dot" aria-hidden="true"></span>' : ''}
          <span class="huddle-cal-event-title">${escapeHtml(e.title || '(untitled)')}</span>
        </div>
        ${h > 38 ? `<div class="huddle-cal-event-meta mono">${escapeHtml(timeLabel)} · ${meta}</div>` : ''}
      `;

      // External meetings (Teams/Zoom/Meet/Webex) whose feed carried a
      // join link get a Join button when imminent — same window as the
      // list drawer. window.open routes the URL through the main-process
      // window-open handler → shell.openExternal (default browser / native
      // meeting app). stopPropagation guards against a future block click.
      if (e.kind === 'ics' && e.joinUrl && /^https?:\/\//i.test(e.joinUrl)) {
        const startMs = e.start.getTime();
        const nowMs = now.getTime();
        const imminent = (startMs - nowMs <= 15 * 60 * 1000) && (nowMs - startMs <= 60 * 60 * 1000);
        if (imminent) {
          const join = document.createElement('button');
          join.className = 'huddle-cal-event-join';
          join.type = 'button';
          join.textContent = e.provider ? `Join in ${e.provider}` : 'Join';
          join.title = e.joinUrl;
          join.addEventListener('click', (ev) => {
            ev.stopPropagation();
            try { window.open(e.joinUrl, '_blank', 'noopener'); }
            catch (err) { console.warn('open meeting link failed', err); }
          });
          block.appendChild(join);
        }
      }

      // Owned internal calls: a plain click opens the edit modal, and
      // non-recurring ones are also draggable to reschedule. Dragging a
      // single occurrence of a recurring series isn't supported (it would
      // move the whole series), so those get click-to-edit only.
      if (e.kind === 'huddle' && e.ownedByMe) {
        if (!e.recurring) block.classList.add('is-draggable');
        block.addEventListener('mousedown', (ev) => startDrag(ev, e, block));
      } else {
        // Everything else — external/subscribed meetings and internal
        // calls scheduled by others — opens a details popover on click
        // (with a Join button for external meetings that carry a link).
        // Without this, clicking these blocks did nothing at all.
        block.style.cursor = 'pointer';
        block.addEventListener('click', () => showEventDetails(e, block));
      }
      col.appendChild(block);
    }

    if (!visible.length) renderEmptyOverlay();
  }

  function renderEmpty() {
    const gridEl = root.querySelector('.huddle-cal-grid');
    gridEl.innerHTML = `<div class="huddle-cal-empty">Calendar not initialized.</div>`;
  }
  function renderEmptyOverlay() {
    // optional — leave the empty grid showing; user knows nothing's scheduled
  }

  function channelLabel(id) {
    const li = document.querySelector(`#channels li[data-id="${id}"]`)
      || document.querySelector(`#channels li[data-channel-id="${id}"]`);
    return (li?.querySelector('.ch-name')?.textContent || id || '').trim();
  }

  // ----- Drag-to-reschedule / click-to-edit -----------------------

  function startDrag(ev, e, block) {
    if (ev.button !== 0) return;          // left button only
    ev.preventDefault();
    // Offset of the grab point from the block's top, so on drop the block
    // TOP (== event start) lands under the cursor minus this offset —
    // grabbing the middle of a 1h block doesn't shift the start by 30 min.
    const grabOffsetY = ev.clientY - block.getBoundingClientRect().top;
    dragState = { e, block, startX: ev.clientX, startY: ev.clientY, grabOffsetY, moved: false };
    document.addEventListener('mousemove', onDragMove);
    document.addEventListener('mouseup', onDragEnd);
  }

  function onDragMove(ev) {
    if (!dragState) return;
    const dx = ev.clientX - dragState.startX;
    const dy = ev.clientY - dragState.startY;
    if (!dragState.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      dragState.moved = true;
      dragState.block.classList.add('is-dragging');
    }
    if (dragState.moved) {
      dragState.block.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  }

  function onDragEnd(ev) {
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
    const d = dragState;
    dragState = null;
    if (!d) return;
    d.block.classList.remove('is-dragging');
    d.block.style.transform = '';
    const cal = window.huddleApp?.getCalendar?.();
    // Recurring occurrences aren't draggable; a mousedown on one is always
    // a click → open the series edit modal (snap back if they dragged).
    if (d.e.recurring) {
      if (d.moved) render();
      else cal?.openScheduleModal?.({ editCall: d.e.ref });
      return;
    }
    if (!d.moved) {
      // A click, not a drag → open the edit modal.
      cal?.openScheduleModal?.({ editCall: d.e.ref });
      return;
    }
    const newStart = pointToDate(ev.clientX, ev.clientY - d.grabOffsetY);
    if (!newStart || !d.e.ref) { render(); return; }
    cal?.moveScheduledCall?.(d.e.ref.id, newStart);
  }

  // Map a viewport point to a snapped Date within the visible week grid:
  // column → day, vertical offset → time (15-min snap, clamped to the
  // visible hour band). getBoundingClientRect on the (scrolled) grid
  // already yields content-relative coordinates, so no scrollTop math.
  function pointToDate(clientX, clientY) {
    const gridEl = root && root.querySelector('.huddle-cal-grid');
    if (!gridEl) return null;
    const rect = gridEl.getBoundingClientRect();
    const colW = (rect.width - GUTTER) / 7;
    if (colW <= 0) return null;
    let di = Math.floor((clientX - rect.left - GUTTER) / colW);
    di = Math.max(0, Math.min(6, di));
    let hours = HOUR_START + (clientY - rect.top) / HOUR_HEIGHT;
    hours = Math.round(hours * 4) / 4;                       // snap to 15 min
    // Reject drops outside the visible band rather than silently snapping
    // to 7am/10pm — a small tolerance covers grabbing an event flush
    // against the top/bottom edge.
    const TOL = 0.5;
    if (hours < HOUR_START - TOL || hours > HOUR_END + TOL) return null;
    hours = Math.max(HOUR_START, Math.min(HOUR_END, hours));
    const h = Math.floor(hours);
    const min = Math.round((hours - h) * 60);
    const d = addDays(weekStart, di);
    d.setHours(h, min, 0, 0);
    return d;
  }

  // ----- Event details popover ------------------------------------

  function closeDetails() {
    if (detailsPopover) { detailsPopover.remove(); detailsPopover = null; }
    document.removeEventListener('mousedown', onDocDownForDetails, true);
    document.removeEventListener('keydown', onKeyForDetails, true);
  }
  function onDocDownForDetails(ev) {
    if (detailsPopover && !detailsPopover.contains(ev.target)) closeDetails();
  }
  function onKeyForDetails(ev) { if (ev.key === 'Escape') closeDetails(); }

  // Anchored read-only card for an event you can't edit inline: external
  // meetings and internal calls scheduled by others. Shows the essentials
  // and, for external meetings with a parsed link, a Join button that
  // works at any time (not just when the meeting is imminent).
  function showEventDetails(e, block) {
    closeDetails();
    const pop = document.createElement('div');
    pop.className = 'huddle-cal-details';

    const when = e.start.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
    const dur = e.durationMin ? ` · ${e.durationMin} min` : '';
    const lines = [
      `<div class="huddle-cal-details-title">${escapeHtml(e.title || '(untitled)')}</div>`,
      `<div class="huddle-cal-details-when">${escapeHtml(when)}${escapeHtml(dur)}</div>`,
    ];
    if (e.kind === 'huddle') {
      const chan = e.ref?.channelId ? `#${escapeHtml(channelLabel(e.ref.channelId))}` : 'Scheduled call';
      lines.push(`<div class="huddle-cal-details-meta">${chan}</div>`);
      const c = e.rsvpCounts;
      if (c && (c.going || c.maybe || c.declined)) {
        const parts = [];
        if (c.going) parts.push(`${c.going} going`);
        if (c.maybe) parts.push(`${c.maybe} maybe`);
        if (c.declined) parts.push(`${c.declined} out`);
        lines.push(`<div class="huddle-cal-details-meta">${parts.join(' · ')}</div>`);
      }
    } else {
      const src = escapeHtml(e.source || 'External');
      const prov = e.provider ? ` · ${escapeHtml(e.provider)}` : '';
      lines.push(`<div class="huddle-cal-details-meta">${src}${prov}</div>`);
      if (e.sub) lines.push(`<div class="huddle-cal-details-meta">${escapeHtml(e.sub)}</div>`);
    }
    pop.innerHTML = lines.join('');

    if (e.kind === 'ics' && e.joinUrl && /^https?:\/\//i.test(e.joinUrl)) {
      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'huddle-cal-details-join';
      join.textContent = e.provider ? `Join in ${e.provider}` : 'Join meeting';
      join.addEventListener('click', () => {
        try { window.open(e.joinUrl, '_blank', 'noopener'); }
        catch (err) { console.warn('open meeting link failed', err); }
        closeDetails();
      });
      pop.appendChild(join);
    }

    document.body.appendChild(pop);
    // Position beside the block, flipping/ clamping to stay on-screen.
    const r = block.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let left = r.right + 8;
    if (left + pw > window.innerWidth - 8) left = r.left - pw - 8;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = Math.max(8, Math.min(r.top, window.innerHeight - ph - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    detailsPopover = pop;
    // Defer wiring the dismiss listeners so the opening click doesn't
    // immediately close it.
    setTimeout(() => {
      document.addEventListener('mousedown', onDocDownForDetails, true);
      document.addEventListener('keydown', onKeyForDetails, true);
    }, 0);
  }

  // ----- Open / close ---------------------------------------------

  function open() {
    if (!root) buildDom();
    weekStart = startOfWeek(new Date());
    render();
    root.classList.remove('hidden');
    root.setAttribute('aria-hidden', 'false');

    // Subscribe to calendar updates so the grid repaints when a new
    // event lands, an ICS poll resolves, etc.
    const cal = window.huddleApp?.getCalendar?.();
    if (cal?.subscribe && !unsubscribe) {
      unsubscribe = cal.subscribe(() => render());
    }
    // Tick the now-line once a minute while open.
    if (!nowTimer) nowTimer = setInterval(() => render(), 60 * 1000);
  }

  function close() {
    if (!root) return;
    closeDetails();
    root.classList.add('hidden');
    root.setAttribute('aria-hidden', 'true');
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    if (nowTimer) { clearInterval(nowTimer); nowTimer = null; }
  }

  window.HuddleCalendarGrid = { open, close };

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root && !root.classList.contains('hidden')) {
      close();
    }
  });
})();
