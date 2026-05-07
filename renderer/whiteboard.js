// Per-channel collaborative whiteboard.
//
// One canvas, many peers; live strokes via Realtime broadcast and persistent
// state in Postgres. The actual drawing primitives are reused from
// drawing.js (the same surface used to annotate shared screens), so the
// pen/arrow/eraser/color/size controls all behave identically.
//
// Wire shape:
//   - LIVE      strokes (begin/move/end) broadcast over a team-scoped topic
//                so connected peers see drawing as it happens.
//   - PERSIST   completed strokes are accumulated client-side and saved as
//                a single polyline row on stroke `end`. Cuts DB writes by
//                ~50x vs. one row per pointer event.
//   - REPLAY    on open, fetch all rows ordered by id and replay each
//                polyline through the DrawingLayer.
//   - DEDUP     each stroke gets a client-generated uuid that travels with
//                both the live broadcast and the persisted polyline. The
//                receiver records uuids it has already painted live; when
//                history replay produces the same uuid it's skipped. This
//                handles the unavoidable race between subscribing to the
//                broadcast and fetching history (a stroke can complete in
//                between and otherwise be painted twice).
//   - CLEAR     local: layer.clearAll(); broadcast: a {action:'clear'}
//                stroke; persistent: delete every row for this whiteboard.

class WhiteboardSession {
  constructor({ huddle, channelId, whiteboard, tile }) {
    this.huddle = huddle;
    this.channelId = channelId;
    this.whiteboardId = whiteboard.id;
    this.tile = tile;
    this.layer = null;
    this._currentStroke = null;     // local in-progress stroke + its uuid
    this._paintedUuids = new Set(); // strokes painted live; replay skips matches
    // Sticky notes: id -> { el, data }. data = { id, x, y, w, h, text, color }.
    // Positions are fractional (0..1) of the tile bounding rect, so notes
    // render consistently across viewers with different tile sizes — same
    // scheme strokes use for points.
    this.notes = new Map();
    this._noteSaveTimers = new Map(); // id -> setTimeout, debounce text saves
  }

  async start() {
    // Drawing layer: identical to the screen-share annotation overlay, but
    // attached to a tile that has no underlying <video>.
    this.layer = new DrawingLayer({
      streamId: this.whiteboardId,
      isOwner: true,
      send: (stroke) => this._onLocalStroke(stroke),
    });
    this.layer.attach(this.tile);
    this.layer.setActive(true);

    // Subscribe to live broadcast first so we don't miss strokes / notes
    // drawn between the DB fetch and the subscribe. The dedup Set below
    // catches any overlap with replayed history.
    await this.huddle.ensureWhiteboardChannel(
      this.whiteboardId,
      (payload) => {
        if (payload.from === this.huddle.peerId) return; // ignore self echoes
        const stroke = payload.stroke;
        this.layer.applyRemote(stroke);
        if (stroke.action === 'end' && stroke.uuid) this._paintedUuids.add(stroke.uuid);
      },
      (payload) => {
        if (payload.from === this.huddle.peerId) return;
        this._applyRemoteNote(payload);
      },
    );

    // Replay strokes.
    try {
      const rows = await this.huddle.fetchWhiteboardStrokes(this.whiteboardId);
      for (const row of rows) {
        const polyline = row.data;
        if (polyline?.uuid && this._paintedUuids.has(polyline.uuid)) continue;
        if (polyline?.uuid) this._paintedUuids.add(polyline.uuid);
        replayPolyline(this.layer, polyline);
      }
    } catch (err) {
      console.warn('[whiteboard] history fetch failed', err);
    }

    // Replay notes.
    try {
      const noteRows = await this.huddle.fetchWhiteboardNotes(this.whiteboardId);
      for (const row of noteRows) this._renderNote(row);
    } catch (err) {
      console.warn('[whiteboard] notes fetch failed', err);
    }
  }

  // -- Sticky notes ---------------------------------------------------

  // Add a note at the given fractional (0..1) tile-relative coords.
  // Renders, persists, and broadcasts so other peers see it live.
  // Default placement is the visible center.
  async addNote({ x = 0.4, y = 0.4 } = {}) {
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const note = { id, x, y, w: 0.18, h: 0.18, text: '', color: '#ffd866' };
    this._renderNote(note, { focus: true });
    this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'create', note });
    try {
      await this.huddle.createWhiteboardNote(this.whiteboardId, this.channelId, note);
    } catch (err) {
      console.warn('[whiteboard] note create failed', err);
    }
  }

  _applyRemoteNote(payload) {
    if (payload.action === 'create' && payload.note) this._renderNote(payload.note);
    else if (payload.action === 'update' && payload.note) this._applyRemoteUpdate(payload.note);
    else if (payload.action === 'delete' && payload.id) this._removeNoteEl(payload.id);
  }

  _applyRemoteUpdate(patch) {
    const entry = this.notes.get(patch.id);
    if (!entry) return;
    Object.assign(entry.data, patch);
    if (patch.text !== undefined && entry.textarea) entry.textarea.value = patch.text;
    if (patch.x !== undefined || patch.y !== undefined || patch.w !== undefined || patch.h !== undefined) {
      this._positionNote(entry);
    }
  }

  _renderNote(note, { focus = false } = {}) {
    if (this.notes.has(note.id)) {
      this._applyRemoteUpdate(note);
      return;
    }
    const el = document.createElement('div');
    el.className = 'wb-note';
    el.dataset.noteId = note.id;
    el.style.background = note.color || '#ffd866';
    const handle = document.createElement('div');
    handle.className = 'wb-note-handle';
    handle.title = 'Drag to move';
    const close = document.createElement('button');
    close.className = 'wb-note-close';
    close.title = 'Delete note';
    close.textContent = '×';
    handle.appendChild(close);
    const ta = document.createElement('textarea');
    ta.className = 'wb-note-text';
    ta.placeholder = 'Type a note…';
    ta.value = note.text || '';
    el.append(handle, ta);
    this.tile.appendChild(el);

    const entry = { el, textarea: ta, handle, data: { ...note } };
    this.notes.set(note.id, entry);
    this._positionNote(entry);
    this._wireNoteHandlers(entry);
    if (focus) setTimeout(() => ta.focus(), 0);
  }

  _positionNote(entry) {
    const { el, data } = entry;
    el.style.left = `${data.x * 100}%`;
    el.style.top = `${data.y * 100}%`;
    el.style.width = `${data.w * 100}%`;
    el.style.height = `${data.h * 100}%`;
  }

  _wireNoteHandlers(entry) {
    const { el, textarea, handle, data } = entry;

    // Drag from the handle (top strip) to reposition. Body scrolling +
    // text editing stay alive because the textarea sits below the
    // handle and isn't part of the drag surface.
    let dragStart = null;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('wb-note-close')) return;
      e.preventDefault();
      const rect = this.tile.getBoundingClientRect();
      dragStart = {
        x: e.clientX, y: e.clientY,
        origX: data.x, origY: data.y,
        rectW: rect.width, rectH: rect.height,
      };
      el.classList.add('dragging');
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragStart) return;
      const dx = (e.clientX - dragStart.x) / dragStart.rectW;
      const dy = (e.clientY - dragStart.y) / dragStart.rectH;
      data.x = Math.max(0, Math.min(1 - data.w, dragStart.origX + dx));
      data.y = Math.max(0, Math.min(1 - data.h, dragStart.origY + dy));
      this._positionNote(entry);
    });
    window.addEventListener('mouseup', () => {
      if (!dragStart) return;
      dragStart = null;
      el.classList.remove('dragging');
      // Persist + broadcast the final position. Drag-while-typing on
      // remote viewers' textareas was already handled by
      // _applyRemoteUpdate not touching textarea.value when only x/y
      // changed.
      this._broadcastUpdate(data.id, { x: data.x, y: data.y });
      this._persistUpdate(data.id, { x: data.x, y: data.y });
    });

    // Text edits: broadcast immediately for liveness, debounce the DB
    // write so we're not POSTing on every keystroke.
    textarea.addEventListener('input', () => {
      data.text = textarea.value;
      this._broadcastUpdate(data.id, { text: data.text });
      this._scheduleNoteSave(data.id, { text: data.text });
    });
    textarea.addEventListener('blur', () => this._flushNoteSave(data.id));

    // Close (×) — broadcast + delete row + remove el.
    handle.querySelector('.wb-note-close').addEventListener('click', async (e) => {
      e.stopPropagation();
      this._removeNoteEl(data.id);
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'delete', id: data.id });
      try { await this.huddle.deleteWhiteboardNote(data.id); }
      catch (err) { console.warn('[whiteboard] note delete failed', err); }
    });
  }

  _scheduleNoteSave(id, patch) {
    clearTimeout(this._noteSaveTimers.get(id));
    const timer = setTimeout(() => this._persistUpdate(id, patch), 500);
    this._noteSaveTimers.set(id, timer);
  }

  _flushNoteSave(id) {
    const t = this._noteSaveTimers.get(id);
    if (!t) return;
    clearTimeout(t);
    this._noteSaveTimers.delete(id);
    const entry = this.notes.get(id);
    if (entry) this._persistUpdate(id, { text: entry.data.text });
  }

  async _persistUpdate(id, patch) {
    try { await this.huddle.updateWhiteboardNote(id, patch); }
    catch (err) { console.warn('[whiteboard] note update failed', err); }
  }

  _broadcastUpdate(id, patch) {
    this.huddle.sendWhiteboardNote(this.whiteboardId, {
      action: 'update', note: { id, ...patch },
    });
  }

  _removeNoteEl(id) {
    const entry = this.notes.get(id);
    if (!entry) return;
    entry.el.remove();
    this.notes.delete(id);
    clearTimeout(this._noteSaveTimers.get(id));
    this._noteSaveTimers.delete(id);
  }

  // Live stroke from the local user — broadcast immediately, accumulate for
  // persistence, and rely on the DrawingLayer to have already painted it.
  // Each stroke gets a uuid generated at `begin` and propagated through
  // `move`/`end` plus the persisted polyline so receivers can dedup.
  _onLocalStroke(stroke) {
    if (stroke.action === 'begin') {
      const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this._currentStroke = {
        uuid,
        tool: stroke.tool, color: stroke.color, size: stroke.size,
        points: [[stroke.x, stroke.y]],
      };
      this.huddle.sendWhiteboardStroke(this.whiteboardId, { ...stroke, uuid });
    } else if (stroke.action === 'move' && this._currentStroke) {
      this._currentStroke.points.push([stroke.x, stroke.y]);
      this.huddle.sendWhiteboardStroke(this.whiteboardId, { ...stroke, uuid: this._currentStroke.uuid });
    } else if (stroke.action === 'end' && this._currentStroke) {
      const polyline = this._currentStroke;
      this._currentStroke = null;
      this.huddle.sendWhiteboardStroke(this.whiteboardId, { ...stroke, uuid: polyline.uuid });
      // Remember our own stroke so we don't double-paint it on reload.
      this._paintedUuids.add(polyline.uuid);
      if (polyline.points.length >= 1) {
        this.huddle.persistWhiteboardStroke(this.whiteboardId, polyline)
          .catch((err) => console.warn('[whiteboard] persist failed', err));
      }
    }
  }

  async clear() {
    this.layer.clearAll(/*broadcast*/ false);
    this.huddle.sendWhiteboardStroke(this.whiteboardId, { action: 'clear' });
    this._paintedUuids.clear();
    // Sticky notes are part of the canvas state — clearing should
    // wipe both. Tell remote viewers explicitly so they drop their
    // local DOM nodes; clearWhiteboard() in api.js drops the rows.
    for (const id of [...this.notes.keys()]) {
      this._removeNoteEl(id);
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'delete', id });
    }
    try { await this.huddle.clearWhiteboard(this.whiteboardId); }
    catch (err) { console.warn('[whiteboard] clear failed', err); }
  }

  setTool(t) { this.layer?.setTool(t); }
  setColor(c) { this.layer?.setColor(c); }
  setSize(s) { this.layer?.setSize(s); }

  stop() {
    this.huddle.closeWhiteboardChannel(this.whiteboardId);
    if (this.tile?.parentElement) this.tile.remove();
  }
}

// Replay a saved polyline by feeding the DrawingLayer the same begin/move/end
// events it sees during live drawing. Keeps all rendering in one code path.
function replayPolyline(layer, polyline) {
  if (!polyline) return;
  if (polyline.action === 'clear') { layer.applyRemote({ action: 'clear' }); return; }
  const { tool, color, size, points } = polyline;
  if (!Array.isArray(points) || points.length === 0) return;
  layer.applyRemote({ action: 'begin', x: points[0][0], y: points[0][1], tool, color, size });
  for (let i = 1; i < points.length; i++) {
    layer.applyRemote({ action: 'move', x: points[i][0], y: points[i][1], tool, color, size });
  }
  const last = points[points.length - 1];
  layer.applyRemote({ action: 'end', x: last[0], y: last[1], tool, color, size });
}

window.WhiteboardSession = WhiteboardSession;
