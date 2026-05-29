// Calendar tool. Owns:
//   - The calendar drawer (upcoming-events list, mirrors saved-drawer
//     pattern visually).
//   - The schedule-call modal (title, channel, time, duration).
//   - ICS subscription cache: pulls user-pasted .ics URLs through the
//     main-process ics-fetch IPC, parses them via window.HuddleICS,
//     and merges the resulting events into the same upcoming-list
//     used by internal scheduled_calls.
//
// Wiring (done from app.js):
//   const cal = new HuddleCalendar({ huddle, hooks });
//   cal.bindElements({ drawer, list, scheduleBtn, ... });
//   await cal.start();           // initial load + realtime subscribe
//   cal.openDrawer() / closeDrawer()
//   cal.openScheduleModal({ defaultChannelId })
//   await cal.stop();            // teardown realtime + polling

(function () {
  // 15 minutes between ICS refresh polls. Chosen to roughly match
  // Google/Apple's published cadence for `webcal://` clients —
  // shorter means we waste user CPU + fetch budget; longer means
  // edits to a subscribed external calendar take too long to show.
  const ICS_POLL_MS = 15 * 60 * 1000;
  const SCHEDULE_DEFAULT_DURATION_MIN = 30;
  const UPCOMING_HORIZON_DAYS = 14;
  const ICS_MAX_HORIZON_MS = UPCOMING_HORIZON_DAYS * 24 * 60 * 60 * 1000;

  class HuddleCalendar {
    constructor({ huddle, hooks = {} }) {
      this.huddle = huddle;
      this.hooks = hooks;            // { onScheduled, getChannels, postIcsToChannel, currentChannelId }
      this._scheduled = new Map();    // id -> ScheduledCall (internal)
      this._icsEvents = new Map();    // sourceUrl -> [parsedEvent]
      this._subscriptions = [];       // [{ name, url }] from user_integrations.settings.calendar.subscriptions
      this._unsubscribeRealtime = null;
      this._icsTimer = null;
      this._els = {};
      this._modalEls = {};
      this._open = false;
    }

    bindElements({ drawer, list, scheduleBtn, closeBtn, modal, modalForm,
                   modalTitle, modalChannel, modalDate, modalTime,
                   modalDuration, modalDescription, modalCancel, modalSave }) {
      this._els = { drawer, list, scheduleBtn, closeBtn };
      this._modalEls = { modal, modalForm, modalTitle, modalChannel, modalDate,
                         modalTime, modalDuration, modalDescription, modalCancel, modalSave };
      if (closeBtn) closeBtn.onclick = () => this.closeDrawer();
      if (scheduleBtn) scheduleBtn.onclick = () => this.openScheduleModal();
      if (modalCancel) modalCancel.onclick = () => this.closeScheduleModal();
      if (modalForm) modalForm.onsubmit = (e) => { e.preventDefault(); this._submitSchedule(); };
    }

    async start({ subscriptions = [] } = {}) {
      this._subscriptions = Array.isArray(subscriptions) ? subscriptions.slice() : [];
      // Internal first (fast Supabase round-trip), external in parallel.
      const internalLoad = this._loadScheduled();
      const externalLoad = this._refreshAllSubscriptions();
      await internalLoad;            // gate render on the cheap one
      this._notifyChange();
      this._render();
      externalLoad.then(() => this._render()).catch(() => {});
      this._startRealtime();
      this._startIcsPolling();
    }

    async stop() {
      // Await the realtime unsubscribe so the WebSocket handshake
      // completes before the next subscription opens on team-switch.
      // Fire-and-forget would leak a server-side subscription per
      // hot-reload / re-login.
      if (this._unsubscribeRealtime) {
        const u = this._unsubscribeRealtime;
        this._unsubscribeRealtime = null;
        try { await u(); } catch {}
      }
      if (this._icsTimer) { clearInterval(this._icsTimer); this._icsTimer = null; }
      this._scheduled.clear();
      this._icsEvents.clear();
    }

    // External callers can hand in a refreshed subscription list (e.g.
    // when the user adds one in Settings); we re-pull all of them and
    // re-render. Cheap: a few fetches in parallel.
    async setSubscriptions(subscriptions) {
      this._subscriptions = Array.isArray(subscriptions) ? subscriptions.slice() : [];
      // Drop any cache entries for URLs that are no longer subscribed.
      const live = new Set(this._subscriptions.map((s) => s.url));
      for (const url of [...this._icsEvents.keys()]) {
        if (!live.has(url)) this._icsEvents.delete(url);
      }
      await this._refreshAllSubscriptions();
      this._render();
    }

    openDrawer() {
      if (!this._els.drawer) return;
      this._els.drawer.classList.remove('hidden');
      this._els.drawer.setAttribute('aria-hidden', 'false');
      this._open = true;
      this._render();
    }

    closeDrawer() {
      if (!this._els.drawer) return;
      this._els.drawer.classList.add('hidden');
      this._els.drawer.setAttribute('aria-hidden', 'true');
      this._open = false;
    }

    isOpen() { return this._open; }

    // ----- Schedule modal -------------------------------------------------

    openScheduleModal({ defaultChannelId } = {}) {
      const m = this._modalEls;
      if (!m.modal) return;
      m.modal.classList.remove('hidden');
      m.modalTitle.value = '';
      m.modalDescription.value = '';
      m.modalDuration.value = String(SCHEDULE_DEFAULT_DURATION_MIN);
      // Default time = next 5-minute boundary, at least 5 min in the
      // future. Avoids "schedule for 13:42:17" when the user pops the
      // modal without thinking about exact times.
      const now = new Date(Date.now() + 5 * 60 * 1000);
      const rounded = new Date(Math.ceil(now.getTime() / (5 * 60 * 1000)) * 5 * 60 * 1000);
      m.modalDate.value = formatDateInputValue(rounded);
      m.modalTime.value = formatTimeInputValue(rounded);
      // Repopulate channels (fresh in case the user joined/left some).
      this._populateChannelsSelect(defaultChannelId || this.hooks.currentChannelId?.());
      // Focus title field for fast keyboard entry.
      setTimeout(() => m.modalTitle.focus(), 0);
    }

    closeScheduleModal() {
      const m = this._modalEls;
      if (!m.modal) return;
      m.modal.classList.add('hidden');
    }

    _populateChannelsSelect(defaultChannelId) {
      const sel = this._modalEls.modalChannel;
      if (!sel) return;
      sel.innerHTML = '';
      const channels = (this.hooks.getChannels?.() || []).filter((c) => c.type !== 'dm');
      for (const ch of channels) {
        const opt = document.createElement('option');
        opt.value = ch.id;
        opt.textContent = `# ${ch.name}`;
        sel.appendChild(opt);
      }
      if (defaultChannelId) sel.value = defaultChannelId;
    }

    async _submitSchedule() {
      const m = this._modalEls;
      const title = (m.modalTitle.value || '').trim();
      const channelId = m.modalChannel.value;
      const dateStr = m.modalDate.value;
      const timeStr = m.modalTime.value;
      const durationMin = parseInt(m.modalDuration.value, 10);
      const description = (m.modalDescription.value || '').trim();
      if (!title) { m.modalTitle.focus(); return; }
      if (!channelId) { m.modalChannel.focus(); return; }
      if (!dateStr || !timeStr) { m.modalDate.focus(); return; }
      if (!Number.isFinite(durationMin) || durationMin <= 0) {
        m.modalDuration.focus(); return;
      }
      // Combine date + time inputs as local time. <input type=date> +
      // <input type=time> are explicitly local per HTML spec, so this
      // matches what the user sees.
      const startsAt = new Date(`${dateStr}T${timeStr}:00`);
      if (isNaN(startsAt.getTime())) { m.modalDate.focus(); return; }
      m.modalSave.disabled = true;
      try {
        const created = await this.huddle.createScheduledCall({
          channelId, title, description, startsAt, durationMin,
        });
        // Local insert is also fed by the realtime listener, but
        // doing it here too means the modal closes onto a drawer
        // that already shows the new row (no flicker waiting for
        // the round-trip).
        this._scheduled.set(created.id, created);
        this._notifyChange();
        this.closeScheduleModal();
        this._render();
        // Best-effort: post an .ics attachment to the channel so
        // participants can drag it into their external calendar. A
        // failure here doesn't undo the schedule (it's still in
        // Supabase + the in-app Calendar drawer).
        try { await this.hooks.postIcsToChannel?.(created); }
        catch (err) { console.warn('postIcsToChannel failed', err); }
        this.hooks.onScheduled?.(created);
      } catch (err) {
        console.warn('createScheduledCall failed', err);
        alert('Could not schedule call: ' + (err?.message || err));
      } finally {
        m.modalSave.disabled = false;
      }
    }

    // ----- Internal scheduled-calls (Supabase) ---------------------------

    async _loadScheduled() {
      const rows = await this.huddle.loadScheduledCalls();
      this._scheduled.clear();
      for (const r of rows) this._scheduled.set(r.id, r);
    }

    _startRealtime() {
      if (!this.huddle.subscribeScheduledCalls) return;
      this._unsubscribeRealtime = this.huddle.subscribeScheduledCalls((evt) => {
        if (evt.eventType === 'DELETE') {
          if (evt.oldId) this._scheduled.delete(evt.oldId);
        } else if (evt.row) {
          // INSERT or UPDATE — set() handles both.
          this._scheduled.set(evt.row.id, evt.row);
        }
        this._notifyChange();
        this._render();
      });
    }

    // Single point of "scheduled-call map mutated" notification, fired
    // from realtime events + local inserts + local deletes. Lets the
    // host wire the sidebar badge (or any other consumer) to the
    // actual map state instead of only the local-insert path.
    _notifyChange() {
      try { this.hooks.onChange?.(this._scheduled.size); } catch {}
    }

    // ----- ICS subscriptions (external calendars) -----------------------

    _startIcsPolling() {
      if (this._icsTimer) clearInterval(this._icsTimer);
      this._icsTimer = setInterval(() => {
        this._refreshAllSubscriptions().then(() => this._render()).catch(() => {});
      }, ICS_POLL_MS);
    }

    async _refreshAllSubscriptions() {
      if (!this._subscriptions.length) return;
      // Fan out in parallel; one slow / failing feed mustn't gate the others.
      await Promise.allSettled(this._subscriptions.map((s) => this._refreshOne(s)));
    }

    async _refreshOne(sub) {
      if (!window.huddle?.icsFetch || !window.HuddleICS) return;
      try {
        const res = await window.huddle.icsFetch(sub.url);
        if (!res?.ok || typeof res.body !== 'string') {
          console.warn('[calendar] ics-fetch failed', sub.url, res?.error || res?.status);
          return;
        }
        // Cap at a 14-day forward horizon — subscription feeds often
        // cover years; we don't want to drag thousands of historical
        // events into the upcoming list. The cutoff is also passed
        // into parse() so RRULE expansion stops at the same boundary
        // (a weekly meeting expanded for years would balloon memory).
        const cutoff = Date.now() + ICS_MAX_HORIZON_MS;
        const parsed = window.HuddleICS.parse(res.body, { expandUntil: new Date(cutoff) });
        const horizon = (parsed.events || []).filter((e) =>
          e.start && e.start.getTime() >= Date.now() - 60 * 60 * 1000
                  && e.start.getTime() <= cutoff,
        );
        // Stamp source name so the UI can label rows by feed.
        for (const ev of horizon) ev._source = sub.name || sub.url;
        this._icsEvents.set(sub.url, horizon);
      } catch (err) {
        console.warn('[calendar] ics-fetch threw', sub.url, err);
      }
    }

    // ----- Render --------------------------------------------------------

    // Combines internal scheduled calls + cached ICS events into one
    // chronological list. Rendered on every change; cheap because the
    // combined list is bounded (~weeks of events = dozens of rows).
    // Public: combined internal-scheduled + external-ICS entries,
    // sorted by start. Used by both the legacy list drawer (_render
    // below) and the v2 week-grid view in renderer/calendar-grid.js.
    listEvents() {
      const entries = [];
      for (const sc of this._scheduled.values()) {
        entries.push({
          kind: 'huddle', id: 'h:' + sc.id,
          start: sc.startsAt, durationMin: sc.durationMin,
          title: sc.title, sub: '', source: '',
          channelId: sc.channelId,
          ownedByMe: sc.createdBy === this.huddle?.peerId,
          ref: sc,
        });
      }
      for (const evs of this._icsEvents.values()) {
        for (const e of evs) {
          if (!e.start) continue;
          entries.push({
            kind: 'ics', id: 'i:' + (e.uid || (e._source + ':' + e.start.toISOString())),
            start: e.start, durationMin: e.end ? Math.max(0, Math.round((e.end - e.start) / 60000)) : 0,
            title: e.title || '(untitled)',
            sub: e.location || '', source: e._source || '',
            allDay: e.allDay,
          });
        }
      }
      entries.sort((a, b) => a.start - b.start);
      return entries;
    }

    // Lightweight observer for grid view rerenders. The legacy drawer
    // re-renders inline; the grid subscribes via onChange to repaint
    // when scheduled/ICS data shifts (new event, ICS poll, realtime
    // delete, etc.). Returns an unsubscribe fn.
    subscribe(fn) {
      if (!this._subscribers) this._subscribers = new Set();
      this._subscribers.add(fn);
      return () => this._subscribers.delete(fn);
    }

    _emitChange() {
      if (!this._subscribers) return;
      for (const fn of this._subscribers) {
        try { fn(); } catch (e) { console.error('[calendar] subscriber failed:', e); }
      }
    }

    _render() {
      const list = this._els.list;
      // _emitChange() runs even when the legacy drawer isn't bound
      // (grid view can be the only consumer).
      this._emitChange();
      if (!list) return;
      const entries = this.listEvents();
      list.innerHTML = '';
      if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'cal-empty';
        empty.textContent = 'Nothing scheduled. Use “Schedule call” to add one.';
        list.appendChild(empty);
        return;
      }
      let lastDay = '';
      for (const e of entries) {
        const dayLabel = formatDayHeader(e.start);
        if (dayLabel !== lastDay) {
          const h = document.createElement('div');
          h.className = 'cal-day-header';
          h.textContent = dayLabel;
          list.appendChild(h);
          lastDay = dayLabel;
        }
        list.appendChild(this._renderRow(e));
      }
    }

    _renderRow(e) {
      const row = document.createElement('div');
      row.className = 'cal-row cal-row-' + e.kind;
      const time = document.createElement('div');
      time.className = 'cal-row-time';
      time.textContent = e.allDay ? 'All day' : formatTimeShort(e.start);
      const body = document.createElement('div');
      body.className = 'cal-row-body';
      const title = document.createElement('div');
      title.className = 'cal-row-title';
      title.textContent = e.title;
      body.appendChild(title);
      const meta = document.createElement('div');
      meta.className = 'cal-row-meta';
      const metaParts = [];
      if (e.kind === 'huddle' && e.durationMin) metaParts.push(`${e.durationMin} min`);
      if (e.kind === 'ics' && e.source) metaParts.push(e.source);
      if (e.kind === 'ics' && e.sub) metaParts.push(e.sub);
      meta.textContent = metaParts.join(' · ');
      if (metaParts.length) body.appendChild(meta);
      row.appendChild(time);
      row.appendChild(body);
      // Internal Huddles get an inline "Join" button when they're
      // imminent (started within the last hour or starting in the
      // next 15 min). External ICS rows are display-only.
      if (e.kind === 'huddle') {
        const startTs = e.start.getTime();
        const now = Date.now();
        const imminent = (startTs - now <= 15 * 60 * 1000) && (now - startTs <= 60 * 60 * 1000);
        if (imminent && this.hooks.openCallChannel) {
          const join = document.createElement('button');
          join.className = 'cal-row-join';
          join.textContent = 'Join';
          join.onclick = () => this.hooks.openCallChannel(e.channelId);
          row.appendChild(join);
        }
        if (e.ownedByMe && this.hooks.confirmDelete !== false) {
          const del = document.createElement('button');
          del.className = 'cal-row-del';
          del.title = 'Cancel scheduled call';
          del.setAttribute('aria-label', 'Cancel scheduled call');
          del.textContent = '×';
          del.onclick = async () => {
            if (!confirm(`Cancel “${e.title}”?`)) return;
            try {
              await this.huddle.deleteScheduledCall(e.ref.id);
              this._scheduled.delete(e.ref.id);
              this._notifyChange();
              this._render();
            } catch (err) {
              console.warn('deleteScheduledCall failed', err);
              alert('Could not cancel: ' + (err?.message || err));
            }
          };
          row.appendChild(del);
        }
      }
      return row;
    }
  }

  // ---------------------------------------------------------------------------
  // Date formatters. Using Intl.DateTimeFormat with default locale so
  // a user in a non-en-US locale sees their conventional formats.
  // ---------------------------------------------------------------------------

  const DAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

  function formatDayHeader(d) {
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
    if (sameDay(d, today)) return 'Today';
    if (sameDay(d, tomorrow)) return 'Tomorrow';
    return DAY_FMT.format(d);
  }
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate();
  }
  function formatTimeShort(d) { return TIME_FMT.format(d); }

  // <input type=date> wants `YYYY-MM-DD`; <input type=time> wants
  // `HH:mm`. Both in local time per HTML spec. Pad zeros explicitly
  // because toISOString() would coerce to UTC and shift the day.
  function formatDateInputValue(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  function formatTimeInputValue(d) {
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  }

  window.HuddleCalendar = HuddleCalendar;
})();
