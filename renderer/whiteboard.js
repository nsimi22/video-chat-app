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
    // Sticky notes: id -> { el, textarea, handle, data } where data is
    // { id, x, y, w, h, text, color }. Positions are absolute world
    // coords (~ pixels at scale 1) since the v0.6.0 infinite-canvas
    // migration. The renderer projects them through the canvas's
    // viewport at render time so notes pan/zoom along with strokes.
    this.notes = new Map();
    this._noteSaveTimers = new Map(); // id -> setTimeout, debounce text saves
    // Container for sticky-note DOM elements. Sized to the tile and
    // pointer-events: none for the empty area so it doesn't shadow
    // the canvas; individual notes opt back in to pointer events.
    // Created lazily in start() once the tile is attached.
    this.notesLayer = null;
    // Scratch state: reposition-on-pan/zoom queues a single rAF.
    this._noteRafPending = false;
  }

  async start() {
    // Build the InfiniteCanvas (replaces the old DrawingLayer for
    // whiteboards — DrawingLayer is still used by screen-share
    // annotations). Drawing always emits absolute world coords;
    // pan/zoom only mutate the canvas viewport, not the strokes.
    this.canvas = new window.InfiniteCanvas({
      tile: this.tile,
      send: (stroke) => this._onLocalStroke(stroke),
    });
    this.canvas.onStrokeFinished((polyline) => this._persistFinishedStroke(polyline));
    this.canvas.onViewportChange(() => this._scheduleNoteReposition());

    // Sticky notes ride above the canvas in their own absolutely-
    // positioned layer; viewport changes recompute their CSS rects.
    this.notesLayer = document.createElement('div');
    this.notesLayer.className = 'wb-notes-layer';
    this.tile.appendChild(this.notesLayer);

    // Subscribe to live broadcast first so we don't miss strokes / notes
    // drawn between the DB fetch and the subscribe. The dedup Set below
    // catches any overlap with replayed history.
    await this.huddle.ensureWhiteboardChannel(
      this.whiteboardId,
      (payload) => {
        if (payload.from === this.huddle.peerId) return; // ignore self echoes
        const stroke = payload.stroke;
        this.canvas.applyRemote(stroke);
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
        if (!polyline) continue;
        if (polyline.uuid && this._paintedUuids.has(polyline.uuid)) continue;
        if (polyline.uuid) this._paintedUuids.add(polyline.uuid);
        if (polyline.action === 'clear') { this.canvas.clearAll(); continue; }
        // History rows already store the full polyline shape the
        // canvas wants — feed it directly instead of replaying via
        // begin/move/end, which is unnecessary work for the pure-
        // render-from-DB path.
        this.canvas.addPersistedStroke(polyline);
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
  // Default placement is the centre of the current viewport in
  // world coords, so notes drop wherever the user is looking
  // rather than at world (0,0) when zoomed/panned.
  async addNote(opts = {}) {
    if (typeof crypto === 'undefined' || !crypto.randomUUID) {
      throw new Error('crypto.randomUUID unavailable; cannot create note');
    }
    const id = crypto.randomUUID();
    const vp = this.canvas?.getViewport() || { x: 0, y: 0, scale: 1 };
    const r = this.tile.getBoundingClientRect();
    const w = 180; // world units; matches the legacy 0.18 × 0.18 of a 1000-unit tile
    const h = 180;
    const x = opts.x ?? (vp.x + (r.width / vp.scale) / 2 - w / 2);
    const y = opts.y ?? (vp.y + (r.height / vp.scale) / 2 - h / 2);
    const note = { id, x, y, w, h, text: '', color: '#ffd866' };
    this._renderNote(note, { focus: true });
    this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'create', note });
    try {
      await this.huddle.createWhiteboardNote(this.whiteboardId, note);
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
    // Don't overwrite the textarea while the local user is typing in
    // it — that yanks the cursor to the end and wipes any in-progress
    // edit. The remote text is already in entry.data; the textarea
    // re-syncs from data on next blur or full re-render.
    if (patch.text !== undefined && entry.textarea && document.activeElement !== entry.textarea) {
      entry.textarea.value = patch.text;
    }
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
    (this.notesLayer || this.tile).appendChild(el);

    const entry = { el, textarea: ta, handle, data: { ...note } };
    this.notes.set(note.id, entry);
    this._positionNote(entry);
    this._wireNoteHandlers(entry);
    if (focus) setTimeout(() => ta.focus(), 0);
  }

  _positionNote(entry) {
    const { el, data } = entry;
    // Notes live in world coords; project through the canvas's
    // viewport so they pan/zoom along with strokes. Fractional CSS
    // units (px) instead of % because the world rect can extend
    // beyond the visible tile.
    const vp = this.canvas?.getViewport() || { x: 0, y: 0, scale: 1 };
    el.style.left = `${(data.x - vp.x) * vp.scale}px`;
    el.style.top = `${(data.y - vp.y) * vp.scale}px`;
    el.style.width = `${data.w * vp.scale}px`;
    el.style.height = `${data.h * vp.scale}px`;
  }

  // Reposition every note when the canvas viewport changes. Wrap
  // in rAF so a stream of mousemove pan events doesn't trigger
  // a layout per frame.
  _scheduleNoteReposition() {
    if (this._noteRafPending) return;
    this._noteRafPending = true;
    requestAnimationFrame(() => {
      this._noteRafPending = false;
      for (const entry of this.notes.values()) this._positionNote(entry);
    });
  }

  _wireNoteHandlers(entry) {
    const { el, textarea, handle, data } = entry;

    // Drag from the handle (top strip) to reposition. window-level
    // mousemove / mouseup are attached on mousedown and removed on
    // mouseup so we don't leak N listeners into the global firehose
    // for every note created in the session. Body scrolling + text
    // editing stay alive because the textarea sits below the handle
    // and isn't part of the drag surface.
    let dragStart = null;
    const onMouseMove = (e) => {
      if (!dragStart) return;
      // Drag distance in CLIENT pixels divided by the canvas
      // scale = world units of movement. Notes can land anywhere
      // — there's no clamping to the visible tile because the
      // world is unbounded.
      const scale = dragStart.scale || 1;
      data.x = dragStart.origX + (e.clientX - dragStart.x) / scale;
      data.y = dragStart.origY + (e.clientY - dragStart.y) / scale;
      this._positionNote(entry);
    };
    const onMouseUp = () => {
      if (!dragStart) return;
      dragStart = null;
      el.classList.remove('dragging');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      this._broadcastUpdate(data.id, { x: data.x, y: data.y });
      this._persistUpdate(data.id, { x: data.x, y: data.y });
    };
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('wb-note-close')) return;
      e.preventDefault();
      const vp = this.canvas?.getViewport() || { scale: 1 };
      dragStart = {
        x: e.clientX, y: e.clientY,
        origX: data.x, origY: data.y,
        scale: vp.scale,
      };
      el.classList.add('dragging');
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
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

  // Returns the persist-update promise so callers (specifically
  // stop()) can await all flushes finishing before tearing down
  // the realtime channel + auth context.
  _flushNoteSave(id) {
    const t = this._noteSaveTimers.get(id);
    if (!t) return Promise.resolve();
    clearTimeout(t);
    this._noteSaveTimers.delete(id);
    const entry = this.notes.get(id);
    if (!entry) return Promise.resolve();
    return this._persistUpdate(id, { text: entry.data.text });
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

  // Live stroke from the local user — broadcast each begin/move/end
  // event for liveness. The InfiniteCanvas owns the polyline buffer
  // and notifies us on `end` via onStrokeFinished, which is where
  // we persist (see _persistFinishedStroke).
  _onLocalStroke(stroke) {
    this.huddle.sendWhiteboardStroke(this.whiteboardId, stroke);
  }

  _persistFinishedStroke(polyline) {
    if (!polyline?.uuid) return;
    this._paintedUuids.add(polyline.uuid);
    if (!polyline.points || polyline.points.length < 1) return;
    this.huddle.persistWhiteboardStroke(this.whiteboardId, polyline)
      .catch((err) => console.warn('[whiteboard] persist failed', err));
  }

  async clear() {
    this.canvas.clearAll();
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

  setTool(t) { this.canvas?.setTool(t); }
  setColor(c) { this.canvas?.setColor(c); }
  setSize(s) { this.canvas?.setSize(s); }
  zoomIn() { this.canvas?.zoomIn(); }
  zoomOut() { this.canvas?.zoomOut(); }
  resetViewport() { this.canvas?.resetViewport(); }

  async stop() {
    // Flush + AWAIT any pending debounced note text saves before
    // tearing down the channel. Without the await, the persist
    // promises raced closeWhiteboardChannel + the higher-level
    // huddle.stop() in teardownTeam, and a slow network could
    // close the realtime socket / drop auth before the writes
    // landed — losing the user's last keystrokes.
    const pending = [...this._noteSaveTimers.keys()].map((id) => this._flushNoteSave(id));
    if (pending.length) await Promise.allSettled(pending);
    this.huddle.closeWhiteboardChannel(this.whiteboardId);
    this.canvas?.destroy();
    this.canvas = null;
    if (this.tile?.parentElement) this.tile.remove();
  }
}


window.WhiteboardSession = WhiteboardSession;
