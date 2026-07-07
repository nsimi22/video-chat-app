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
  // The drawer's "upcoming" list defaults to a 2-week look-ahead.
  const UPCOMING_HORIZON_DAYS = 14;
  // How far back / forward we keep events in memory so the week grid can
  // navigate into the past and further future (≈3 months each way). The
  // drawer stays "upcoming" via listEvents({ since }); this only governs
  // what data is available to page to. Wider = more recurring-feed
  // expansion, hence the bound.
  const CALENDAR_WINDOW_DAYS = 92;
  const CALENDAR_WINDOW_MS = CALENDAR_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  // Forward cap for ICS RRULE expansion + the feed keep-window upper edge.
  const ICS_MAX_HORIZON_MS = CALENDAR_WINDOW_MS;

  class HuddleCalendar {
    constructor({ huddle, hooks = {} }) {
      this.huddle = huddle;
      this.hooks = hooks;            // { onScheduled, getChannels, postIcsToChannel, currentChannelId }
      this._scheduled = new Map();    // id -> ScheduledCall (internal)
      this._attendees = new Map();    // callId -> Map(userId -> 'going'|'maybe'|'declined')
      this._icsEvents = new Map();    // sourceUrl -> [parsedEvent]
      this._subscriptions = [];       // [{ name, url }] from user_integrations.settings.calendar.subscriptions
      this._unsubscribeRealtime = null;
      this._unsubscribeAttendees = null;
      this._icsTimer = null;
      this._els = {};
      this._modalEls = {};
      this._open = false;
      this._editingId = null;    // non-null while the modal is in edit mode
    }

    bindElements({ drawer, list, scheduleBtn, closeBtn, modal, modalForm,
                   modalTitle, modalChannel, modalDate, modalTime,
                   modalDuration, modalRepeat, modalConflict, modalDescription,
                   modalCancel, modalSave, modalDelete }) {
      this._els = { drawer, list, scheduleBtn, closeBtn };
      this._modalEls = { modal, modalForm, modalTitle, modalChannel, modalDate,
                         modalTime, modalDuration, modalRepeat, modalConflict,
                         modalDescription, modalCancel, modalSave, modalDelete };
      if (closeBtn) closeBtn.onclick = () => this.closeDrawer();
      if (scheduleBtn) scheduleBtn.onclick = () => this.openScheduleModal();
      if (modalCancel) modalCancel.onclick = () => this.closeScheduleModal();
      if (modalForm) modalForm.onsubmit = (e) => { e.preventDefault(); this._submitSchedule(); };
      if (modalDelete) modalDelete.onclick = () => this._deleteFromModal();
      // Recompute the availability hint as the slot changes.
      for (const inp of [modalDate, modalTime, modalDuration]) {
        if (inp) inp.addEventListener('input', () => this._checkAvailability());
      }
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
      this._startAttendeeRealtime();
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
      if (this._unsubscribeAttendees) {
        const u = this._unsubscribeAttendees;
        this._unsubscribeAttendees = null;
        try { await u(); } catch {}
      }
      if (this._icsTimer) { clearInterval(this._icsTimer); this._icsTimer = null; }
      this._scheduled.clear();
      this._attendees.clear();
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

    // Opens the schedule modal in one of two modes:
    //   create — no editCall: blank form defaulting to the next 5-min slot.
    //   edit   — editCall (a marshalled scheduled call): prefills the form
    //            and the submit patches instead of inserting.
    openScheduleModal({ defaultChannelId, editCall } = {}) {
      const m = this._modalEls;
      if (!m.modal) return;
      this._editingId = editCall ? editCall.id : null;
      m.modal.classList.remove('hidden');
      // Swap heading + submit label to match the mode.
      const heading = m.modal.querySelector('h2');
      if (heading) heading.textContent = editCall ? 'Edit call' : 'Schedule a call';
      if (m.modalSave) m.modalSave.textContent = editCall ? 'Save changes' : 'Schedule';

      let when;
      if (editCall) {
        m.modalTitle.value = editCall.title || '';
        m.modalDescription.value = editCall.description || '';
        m.modalDuration.value = String(editCall.durationMin || SCHEDULE_DEFAULT_DURATION_MIN);
        when = editCall.startsAt instanceof Date ? editCall.startsAt : new Date(editCall.startsAt);
      } else {
        m.modalTitle.value = '';
        m.modalDescription.value = '';
        m.modalDuration.value = String(SCHEDULE_DEFAULT_DURATION_MIN);
        // Default time = next 5-minute boundary, at least 5 min in the
        // future. Avoids "schedule for 13:42:17" when the user pops the
        // modal without thinking about exact times.
        const now = new Date(Date.now() + 5 * 60 * 1000);
        when = new Date(Math.ceil(now.getTime() / (5 * 60 * 1000)) * 5 * 60 * 1000);
      }
      m.modalDate.value = formatDateInputValue(when);
      m.modalTime.value = formatTimeInputValue(when);
      // Recurrence: reflect the existing rule when editing, else default
      // to non-recurring.
      if (m.modalRepeat) m.modalRepeat.value = editCall ? rruleToRepeat(editCall.rrule) : 'none';
      // Delete button only in edit mode; label reflects series vs single.
      if (m.modalDelete) {
        m.modalDelete.hidden = !editCall;
        m.modalDelete.textContent = (editCall && editCall.rrule) ? 'Delete series' : 'Delete';
      }
      // Repopulate channels (fresh in case the user joined/left some).
      this._populateChannelsSelect(
        editCall ? editCall.channelId : (defaultChannelId || this.hooks.currentChannelId?.()),
      );
      // Prime the availability hint for the initial slot.
      this._checkAvailability();
      // Focus title field for fast keyboard entry.
      setTimeout(() => m.modalTitle.focus(), 0);
    }

    // Availability check for the schedule modal: does the chosen slot
    // overlap anything already on the viewer's own calendar (internal
    // scheduled calls + subscribed ICS feeds)? We can only see the
    // viewer's calendars, so this is a self-conflict warning, not a
    // team-wide free/busy — honest about what the data supports. Recurring
    // series are covered because listEvents() already expands them.
    _checkAvailability() {
      const m = this._modalEls;
      const el = m.modalConflict;
      if (!el) return;
      const setHint = (text, cls) => { el.textContent = text; el.className = 'schedule-conflict' + (cls ? ' ' + cls : ''); };
      const durationMin = parseInt(m.modalDuration.value, 10);
      if (!m.modalDate.value || !m.modalTime.value || !Number.isFinite(durationMin) || durationMin <= 0) {
        setHint('', '');
        return;
      }
      const start = new Date(`${m.modalDate.value}T${m.modalTime.value}:00`);
      if (isNaN(start.getTime())) { setHint('', ''); return; }
      const startMs = start.getTime();
      const endMs = startMs + durationMin * 60000;
      const editingId = this._editingId;
      const conflicts = [];
      // Expand recurring series out to the proposed slot so a conflict with
      // a weekly meeting >14 days out isn't missed (false "no conflicts").
      for (const e of this.listEvents({ until: new Date(endMs) })) {
        if (e.allDay) continue;
        // Ignore the call currently being edited (any of its occurrences).
        if (editingId && e.kind === 'huddle' && e.ref && e.ref.id === editingId) continue;
        const es = e.start.getTime();
        const ee = es + (e.durationMin || 0) * 60000;
        // Half-open overlap test: touching edges (back-to-back) don't clash.
        if (es < endMs && ee > startMs) conflicts.push(e);
      }
      if (!conflicts.length) { setHint('✓ No conflicts on your calendar', 'ok'); return; }
      conflicts.sort((a, b) => a.start - b.start);
      const first = conflicts[0];
      const more = conflicts.length > 1 ? ` +${conflicts.length - 1} more` : '';
      setHint(`⚠ Overlaps “${first.title}” at ${formatTimeShort(first.start)}${more}`, 'warn');
    }

    // Delete the call being edited (whole series if recurring). Fired by
    // the modal's Delete button.
    async _deleteFromModal() {
      const id = this._editingId;
      if (!id) return;
      const sc = this._scheduled.get(id);
      const isSeries = !!(sc && sc.rrule);
      if (!confirm(isSeries ? 'Delete the entire recurring series?' : 'Delete this scheduled call?')) return;
      try {
        await this.huddle.deleteScheduledCall(id);
        this._scheduled.delete(id);
        this._attendees.delete(id);
        this._notifyChange();
        this.closeScheduleModal();
        this._render();
      } catch (err) {
        console.warn('deleteScheduledCall failed', err);
        alert('Could not delete: ' + (err?.message || err));
      }
    }

    closeScheduleModal() {
      const m = this._modalEls;
      if (!m.modal) return;
      m.modal.classList.add('hidden');
      this._editingId = null;   // clear edit mode on cancel/close
    }

    // Reschedule a call to a new start time (used by grid drag-to-move).
    // Optimistic: the local copy + UI move immediately, then persist; a
    // failure rolls the start time back. Duration/channel/title unchanged.
    async moveScheduledCall(id, newStart) {
      const sc = this._scheduled.get(id);
      if (!sc || !(newStart instanceof Date) || isNaN(newStart.getTime())) return;
      const prevStart = sc.startsAt;
      sc.startsAt = newStart;
      this._render();
      try {
        const updated = await this.huddle.updateScheduledCall(id, { startsAt: newStart });
        this._scheduled.set(updated.id, updated);
        this._render();
      } catch (err) {
        console.warn('moveScheduledCall failed', err);
        // Roll back on the LIVE map entry: a realtime UPDATE during the
        // await may have replaced the object `sc` pointed at, so mutating
        // the captured reference would leave the stale time on screen.
        const cur = this._scheduled.get(id);
        if (cur) cur.startsAt = prevStart;
        this._render();
        alert('Could not reschedule: ' + (err?.message || err));
      }
    }

    // Cancel a single occurrence of a recurring call by adding its start
    // instant to the series EXDATE list (the whole series stays). occStartMs
    // is epoch-ms; expandSeries matches EXDATE on exactly that instant.
    async cancelOccurrence(id, occStartMs) {
      const sc = this._scheduled.get(id);
      if (!sc) return;
      const prev = Array.isArray(sc.exdate) ? sc.exdate.slice() : [];
      if (prev.includes(occStartMs)) return;   // already excluded
      const next = prev.concat(occStartMs);
      sc.exdate = next;                          // optimistic
      this._render();
      try {
        const updated = await this.huddle.updateScheduledCall(id, { exdate: next });
        this._scheduled.set(updated.id, updated);
        this._render();
      } catch (err) {
        console.warn('cancelOccurrence failed', err);
        // Roll back on the live map entry (see moveScheduledCall).
        const cur = this._scheduled.get(id);
        if (cur) cur.exdate = prev;
        this._render();
        alert('Could not cancel occurrence: ' + (err?.message || err));
      }
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
      // Recurrence rule built from the Repeat select + the chosen start
      // (weekly/monthly anchor to the start's weekday / day-of-month).
      const repeat = m.modalRepeat ? m.modalRepeat.value : 'none';
      const rrule = buildRrule(repeat, startsAt);
      m.modalSave.disabled = true;
      const editingId = this._editingId;
      try {
        if (editingId) {
          // Edit mode: patch the existing row. No .ics repost — the
          // participants already have the invite; a revision is a
          // future ICS-sequence concern (see the migration note).
          //
          // EXDATE entries are absolute occurrence instants; if the start
          // time or the rule changes, none of them line up with the new
          // occurrences anymore (they'd silently resurrect a cancelled
          // occurrence and linger as dead entries). Reset exdate in that
          // case so the edited series starts from a clean exclusion list.
          const prevSc = this._scheduled.get(editingId);
          const startShifted = !prevSc || !prevSc.startsAt || prevSc.startsAt.getTime() !== startsAt.getTime();
          const ruleChanged = !prevSc || (prevSc.rrule || '') !== rrule;
          const patch = { channelId, title, description, startsAt, durationMin, rrule };
          if (startShifted || ruleChanged) patch.exdate = [];
          const updated = await this.huddle.updateScheduledCall(editingId, patch);
          this._scheduled.set(updated.id, updated);
          this._editingId = null;
          this._notifyChange();
          this.closeScheduleModal();
          this._render();
        } else {
          const created = await this.huddle.createScheduledCall({
            channelId, title, description, startsAt, durationMin, rrule,
            organizerTz: viewerTimeZone(),
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
        }
      } catch (err) {
        console.warn(editingId ? 'updateScheduledCall failed' : 'createScheduledCall failed', err);
        alert((editingId ? 'Could not save changes: ' : 'Could not schedule call: ') + (err?.message || err));
      } finally {
        m.modalSave.disabled = false;
      }
    }

    // ----- Internal scheduled-calls (Supabase) ---------------------------

    async _loadScheduled() {
      // Load the same ~3-month history the ICS feed keeps, so past
      // internal calls are available when paging the grid back. The
      // drawer still filters to upcoming via listEvents({ since }).
      const rows = await this.huddle.loadScheduledCalls({
        from: new Date(Date.now() - CALENDAR_WINDOW_MS),
      });
      this._scheduled.clear();
      this._attendees.clear();
      for (const r of rows) {
        this._scheduled.set(r.id, r);
        // Seed the attendee map from the embedded RSVP rows. Kept in a
        // separate map (not on the call object) so realtime call UPDATEs,
        // which don't carry attendees, never clobber it.
        if (Array.isArray(r.attendees)) {
          const m = new Map();
          for (const a of r.attendees) m.set(a.userId, a.status);
          this._attendees.set(r.id, m);
        }
      }
    }

    _startRealtime() {
      if (!this.huddle.subscribeScheduledCalls) return;
      this._unsubscribeRealtime = this.huddle.subscribeScheduledCalls((evt) => {
        if (evt.eventType === 'DELETE') {
          if (evt.oldId) {
            this._scheduled.delete(evt.oldId);
            this._attendees.delete(evt.oldId);   // drop orphaned RSVPs
          }
        } else if (evt.row) {
          // INSERT or UPDATE — set() handles both. Attendees live in
          // their own map (evt.row carries none), so this never touches
          // RSVP state.
          this._scheduled.set(evt.row.id, evt.row);
        }
        this._notifyChange();
        this._render();
      });
    }

    // Realtime RSVP updates from teammates. Maintains the attendee map in
    // lockstep with the DB; a repaint follows every change so an open
    // drawer/grid reflects who's coming without a manual refresh.
    _startAttendeeRealtime() {
      if (!this.huddle.subscribeCallAttendees) return;
      this._unsubscribeAttendees = this.huddle.subscribeCallAttendees((evt) => {
        if (!evt.callId || !evt.userId) return;
        let m = this._attendees.get(evt.callId);
        if (evt.eventType === 'DELETE') {
          if (m) { m.delete(evt.userId); if (!m.size) this._attendees.delete(evt.callId); }
        } else {
          if (!m) { m = new Map(); this._attendees.set(evt.callId, m); }
          m.set(evt.userId, evt.status);
        }
        this._render();
      });
    }

    // Set (or toggle off) the current user's RSVP on a call. Optimistic:
    // the local map + UI update immediately, then persist; a failure rolls
    // back. Clicking the already-active status clears the RSVP entirely.
    async setRsvp(callId, status) {
      const myId = this.huddle?.peerId;
      if (!myId) return;
      let m = this._attendees.get(callId);
      const prev = m ? m.get(myId) : undefined;
      const clearing = status === null || prev === status;
      // Apply optimistically.
      if (clearing) {
        if (m) { m.delete(myId); if (!m.size) this._attendees.delete(callId); }
      } else {
        if (!m) { m = new Map(); this._attendees.set(callId, m); }
        m.set(myId, status);
      }
      this._render();
      try {
        if (clearing) await this.huddle.clearRsvp(callId);
        else await this.huddle.setRsvp(callId, status);
      } catch (err) {
        console.warn('setRsvp failed', err);
        // Roll back to the prior state.
        let mm = this._attendees.get(callId);
        if (prev === undefined) {
          if (mm) { mm.delete(myId); if (!mm.size) this._attendees.delete(callId); }
        } else {
          if (!mm) { mm = new Map(); this._attendees.set(callId, mm); }
          mm.set(myId, prev);
        }
        this._render();
        alert('Could not update RSVP: ' + (err?.message || err));
      }
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
        // Keep a ~3-month window each way so the grid can page into the
        // past (calendar history) and the further future. Subscription
        // feeds often span years, so we still bound it — the forward
        // cutoff is passed into parse() to stop RRULE expansion at the
        // same boundary (a weekly meeting expanded for years would
        // balloon memory). The drawer still shows only upcoming events;
        // this just makes the history available to navigate to.
        const cutoff = Date.now() + ICS_MAX_HORIZON_MS;
        const floor = Date.now() - CALENDAR_WINDOW_MS;
        const parsed = window.HuddleICS.parse(res.body, { expandUntil: new Date(cutoff) });
        const horizon = (parsed.events || []).filter((e) =>
          e.start && e.start.getTime() >= floor
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
    // Returns entries whose start falls in [since, until). Defaults model
    // the drawer's "upcoming" view (just-started → 2 weeks out); the week
    // grid passes the week it's showing (which can be in the past — that's
    // how calendar history is navigated), and the availability check
    // passes the proposed slot. Recurring series are expanded across the
    // requested range, so occurrences beyond the default 14-day window
    // (forward OR back) appear when a caller asks for them.
    listEvents({ since, until } = {}) {
      const entries = [];
      const myId = this.huddle?.peerId;
      const expand = window.HuddleICS?._internal?.expandSeries;
      const nowUpcoming = Date.now() + UPCOMING_HORIZON_DAYS * 24 * 60 * 60 * 1000;
      // Display bounds.
      const sinceMs = (since instanceof Date) ? since.getTime() : (Date.now() - 60 * 60 * 1000);
      const untilMs = (until instanceof Date) ? until.getTime() : nowUpcoming;
      // Expansion horizon for recurring series must reach the display
      // upper bound, but never fall short of the default upcoming window
      // (so a past-week request still generates today's occurrences).
      const expandHorizon = new Date(Math.max(untilMs, nowUpcoming));
      for (const sc of this._scheduled.values()) {
        const am = this._attendees.get(sc.id);
        const attendees = am ? [...am.entries()].map(([userId, status]) => ({ userId, status })) : [];
        const myRsvp = (am && myId) ? (am.get(myId) || null) : null;
        const rsvpCounts = countRsvp(attendees);
        // One entry per occurrence. RSVPs are per-series (one call row), so
        // every occurrence shares the same attendee counts. `occStart` is
        // carried so a single occurrence can be cancelled via EXDATE.
        const mkEntry = (occStart, recurring) => ({
          kind: 'huddle', id: 'h:' + sc.id + (recurring ? ':' + occStart.toISOString() : ''),
          start: occStart, durationMin: sc.durationMin,
          title: sc.title, sub: '', source: '',
          channelId: sc.channelId,
          ownedByMe: sc.createdBy === myId,
          ref: sc,
          recurring, occStart,
          organizerTz: sc.organizerTz || '',
          attendees, myRsvp, rsvpCounts,
        });
        if (sc.rrule && expand) {
          // Reuse the ICS RRULE engine: build a master event and expand it
          // across the requested range, honouring EXDATE cancellations.
          // The final [since, until) filter below trims occurrences to the
          // displayed window.
          const end = new Date(sc.startsAt.getTime() + (sc.durationMin || 0) * 60000);
          const master = { start: sc.startsAt, end, rrule: sc.rrule, exdate: sc.exdate || [], uid: sc.id };
          for (const occ of expand(master, expandHorizon)) {
            if (occ.start) entries.push(mkEntry(occ.start, true));
          }
        } else {
          entries.push(mkEntry(sc.startsAt, false));
        }
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
            // Deep-link to the external meeting (Teams/Zoom/Meet/Webex)
            // when the feed carried one — powers the "Join in …" button.
            joinUrl: e.meetingUrl || '', provider: e.provider || '',
          });
        }
      }
      // Trim everything (internal singles, expanded occurrences, ICS) to
      // the requested display window, then sort chronologically.
      const inRange = entries.filter((e) => {
        const t = e.start.getTime();
        return t >= sinceMs && t < untilMs;
      });
      inRange.sort((a, b) => a.start - b.start);
      return inRange;
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
      // Local time with a zone abbreviation so a shared screenshot is
      // never ambiguous (e.g. "9:00 AM PDT").
      time.textContent = e.allDay ? 'All day' : formatTimeWithZone(e.start);
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
      if (e.kind === 'huddle' && e.recurring) metaParts.push('↻ repeats');
      // Cross-timezone context: when the call was scheduled in a different
      // zone than the viewer's, show the organizer's local time too so you
      // know whether the slot is civilised for them.
      if (e.kind === 'huddle' && !e.allDay && e.organizerTz && e.organizerTz !== viewerTimeZone()) {
        const organizerTime = formatTimeInZone(e.start, e.organizerTz);
        if (organizerTime) metaParts.push(`organizer ${organizerTime}`);
      }
      if (e.kind === 'ics' && e.source) metaParts.push(e.source);
      if (e.kind === 'ics' && e.sub) metaParts.push(e.sub);
      meta.textContent = metaParts.join(' · ');
      if (metaParts.length) body.appendChild(meta);
      // RSVP block for internal calls: avatar stack of who's going, a
      // counts summary, and Going / Maybe / Out toggles.
      if (e.kind === 'huddle') body.appendChild(this._renderRsvp(e));
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
        if (e.ownedByMe) {
          const edit = document.createElement('button');
          edit.className = 'cal-row-edit';
          edit.title = 'Edit scheduled call';
          edit.setAttribute('aria-label', 'Edit scheduled call');
          edit.textContent = '✎';
          edit.onclick = () => this.openScheduleModal({ editCall: e.ref });
          row.appendChild(edit);
        }
        if (e.ownedByMe && this.hooks.confirmDelete !== false) {
          const del = document.createElement('button');
          del.className = 'cal-row-del';
          del.title = 'Cancel scheduled call';
          del.setAttribute('aria-label', 'Cancel scheduled call');
          del.textContent = '×';
          del.title = e.recurring ? 'Cancel this occurrence' : 'Cancel scheduled call';
          del.onclick = async () => {
            if (e.recurring) {
              // Recurring: cancel only this occurrence (EXDATE). Deleting
              // the whole series is offered from the edit (✎) dialog.
              if (!confirm(`Cancel this occurrence (${formatDayHeader(e.start)})? The rest of the series stays.`)) return;
              await this.cancelOccurrence(e.ref.id, e.occStart.getTime());
              return;
            }
            if (!confirm(`Cancel “${e.title}”?`)) return;
            try {
              await this.huddle.deleteScheduledCall(e.ref.id);
              this._scheduled.delete(e.ref.id);
              this._attendees.delete(e.ref.id);   // keep attendee map in lockstep
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
      // External calendar events (Teams/Zoom/Meet/Webex) get a "Join in …"
      // button whenever the feed carried a meeting link — not gated on
      // imminence, since an external join URL is a static link you may
      // want to open a few minutes early (or paste elsewhere). Internal
      // "Join" stays imminent-gated because it joins a live Huddle call.
      // window.open routes the http(s) URL through the main-process
      // window-open handler → shell.openExternal (default browser / native
      // meeting app); the popup itself is denied, so nothing opens inside
      // Huddle.
      if (e.kind === 'ics' && e.joinUrl && /^https?:\/\//i.test(e.joinUrl)) {
        const join = document.createElement('button');
        join.className = 'cal-row-join';
        join.textContent = e.provider ? `Join in ${e.provider}` : 'Join';
        join.onclick = () => {
          try { window.open(e.joinUrl, '_blank', 'noopener'); }
          catch (err) { console.warn('open meeting link failed', err); }
        };
        row.appendChild(join);
      }
      return row;
    }

    // RSVP UI for one internal call row: optional avatar stack of the
    // "going" crowd, a counts summary, and the three toggle buttons. The
    // avatar stack only renders if the host wired a getMember hook (name +
    // color per user id); otherwise counts alone carry the information.
    _renderRsvp(e) {
      const wrap = document.createElement('div');
      wrap.className = 'cal-rsvp';

      const getMember = this.hooks.getMember;
      if (getMember && e.attendees.length) {
        const going = e.attendees.filter((a) => a.status === 'going').slice(0, 6);
        if (going.length) {
          const stack = document.createElement('div');
          stack.className = 'cal-rsvp-avatars';
          for (const a of going) {
            const m = getMember(a.userId) || {};
            const av = document.createElement('span');
            av.className = 'cal-rsvp-avatar';
            av.style.background = m.color || 'var(--accent)';
            const name = (m.name || '').trim();
            av.textContent = (name || '?').charAt(0).toUpperCase();
            av.title = name || a.userId;
            stack.appendChild(av);
          }
          wrap.appendChild(stack);
        }
      }

      const c = e.rsvpCounts;
      if (c.going || c.maybe || c.declined) {
        const summary = document.createElement('span');
        summary.className = 'cal-rsvp-summary';
        const parts = [];
        if (c.going) parts.push(`${c.going} going`);
        if (c.maybe) parts.push(`${c.maybe} maybe`);
        if (c.declined) parts.push(`${c.declined} out`);
        summary.textContent = parts.join(' · ');
        wrap.appendChild(summary);
      }

      const btns = document.createElement('div');
      btns.className = 'cal-rsvp-btns';
      const mkBtn = (status, label) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cal-rsvp-btn' + (e.myRsvp === status ? ' is-active' : '');
        b.dataset.status = status;
        b.textContent = label;
        // Click the active status to clear; setRsvp toggles.
        b.onclick = () => this.setRsvp(e.ref.id, status);
        return b;
      };
      btns.appendChild(mkBtn('going', 'Going'));
      btns.appendChild(mkBtn('maybe', 'Maybe'));
      btns.appendChild(mkBtn('declined', 'Out'));
      wrap.appendChild(btns);
      return wrap;
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

  // Local time carrying its zone abbreviation, e.g. "9:00 AM PDT".
  const TIME_TZ_FMT = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  function formatTimeWithZone(d) { return TIME_TZ_FMT.format(d); }

  // The same instant rendered in an explicit IANA zone (the organizer's),
  // with that zone's abbreviation. Returns '' if the zone is unusable.
  function formatTimeInZone(d, tz) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short',
      }).format(d);
    } catch { return ''; }
  }

  // The viewer's IANA zone (e.g. "America/Los_Angeles"), or '' if the
  // runtime won't report one. Memoized — the zone is constant for the
  // session, and this is called per event row on every repaint.
  let _viewerTz;
  function viewerTimeZone() {
    if (_viewerTz === undefined) {
      try { _viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }
      catch { _viewerTz = ''; }
    }
    return _viewerTz;
  }

  function countRsvp(attendees) {
    const c = { going: 0, maybe: 0, declined: 0 };
    for (const a of attendees) if (c[a.status] !== undefined) c[a.status]++;
    return c;
  }

  // Repeat-select value <-> RRULE body. Weekly anchors BYDAY to the start's
  // weekday and monthly anchors BYMONTHDAY to its day-of-month, so the rule
  // is self-describing and matches what the HuddleICS engine expands
  // (plain FREQ=MONTHLY without BYMONTHDAY would only emit once).
  const RRULE_WEEKDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  function buildRrule(repeat, startsAt) {
    switch (repeat) {
      case 'daily':    return 'FREQ=DAILY';
      case 'weekdays': return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
      case 'weekly':   return `FREQ=WEEKLY;BYDAY=${RRULE_WEEKDAY[startsAt.getDay()]}`;
      case 'monthly':  return `FREQ=MONTHLY;BYMONTHDAY=${startsAt.getDate()}`;
      default:         return '';
    }
  }
  function rruleToRepeat(rrule) {
    if (!rrule) return 'none';
    const s = rrule.toUpperCase();
    if (/FREQ=DAILY/.test(s)) return 'daily';
    if (/FREQ=WEEKLY/.test(s)) return /BYDAY=MO,TU,WE,TH,FR/.test(s) ? 'weekdays' : 'weekly';
    if (/FREQ=MONTHLY/.test(s)) return 'monthly';
    return 'none';
  }

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
