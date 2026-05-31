// WhiteboardView — the design-handoff whiteboard redesign (2026-05-31).
//
// Single full-feature view that the Huddle redesign calls for:
//   • Header: board icon + title + #channel + editor avatars + N editing + Export.
//   • Dotted-grid canvas with pan/zoom (delegates ink to InfiniteCanvas).
//   • Left vertical tool palette (cursor / sticky / pen / arrow / rect / ellipse
//     / text / eraser) + 4-swatch ink palette / 5-swatch pastel sticky palette
//     + undo + clear.
//   • Pastel sticky notes with folded corner, author chip, vote pill, faint
//     deterministic rotation; click selects, double-click edits, dragged from
//     anywhere outside the editable text; selecting reveals a contextual
//     color-picker + delete toolbar.
//   • Titled background "frames" (Permissions / Chat polish / …). Click the
//     header chip to rename; drag to move. Created via a header "+ Frame"
//     affordance — the design's seed content is mock; the view supports
//     production CRUD with an empty board by default.
//   • Live ghost cursors via realtime broadcasts, throttled to ~20 Hz.
//   • Bottom-right minimap (frames + notes + the current viewport rect) +
//     zoom-out / pct / zoom-in / fit-to-view.
//   • "Click anywhere to drop a sticky note" hint pill while the sticky tool
//     is active.
//
// Mount modes:
//   • 'stage' — full-fill of a stage-area mount node, replaces the chat area.
//   • 'tile'  — fits inside a tile container, header collapses + the minimap
//                hides; everything else still works.
//
// The view talks directly to the huddle api (api.js) for persistence + the
// realtime broadcast channel. It supersedes WhiteboardSession's DOM —
// WhiteboardSession is no longer wired by app.js after this redesign, but
// is kept for the popout path until that's migrated.

(function () {
  const STICKY = {
    butter: { bg: '#f0cf78', tx: '#3c2e08', fold: '#dcb95f', dot: '#e7c25f' },
    rose:   { bg: '#eea7ba', tx: '#421421', fold: '#dd93a7', dot: '#e58fa6' },
    sky:    { bg: '#a3cbef', tx: '#10283f', fold: '#8db8de', dot: '#86bbe6' },
    mint:   { bg: '#9ed7b3', tx: '#0d2c1c', fold: '#89c6a0', dot: '#81cd9c' },
    lilac:  { bg: '#c2b2ee', tx: '#251a45', fold: '#ad9ce0', dot: '#b3a2ec' },
  };
  const STICKY_ORDER = ['butter', 'rose', 'sky', 'mint', 'lilac'];
  const NOTE_W = 154;
  const NOTE_H = 134;
  const TEXT_W = 220;
  const TEXT_H = 44;
  // Sentinel slug stored in `color_key` so text blocks ride the existing
  // whiteboard_notes table without a schema change. Anything not in
  // STICKY_ORDER renders as plain text.
  const TEXT_KIND = '_text';

  const FRAME_TINTS = {
    accent: 'var(--accent)',
    live:   'var(--live, #2ec4b6)',
    online: 'var(--online, #34c759)',
    away:   'var(--away, #f5a524)',
  };

  const TOOLS = [
    { id: 'cursor',  icon: 'cursor',     label: 'Select  ·  V' },
    { id: 'sticky',  icon: 'stickyNote', label: 'Sticky note  ·  S' },
    { id: 'pen',     icon: 'pen',        label: 'Pen  ·  P' },
    { id: 'arrow',   icon: 'arrowTool',  label: 'Arrow' },
    { id: 'rect',    icon: 'square',     label: 'Rectangle' },
    { id: 'ellipse', icon: 'circle',     label: 'Ellipse' },
    { id: 'text',    icon: 'text',       label: 'Text (coming soon)' },
    { id: 'eraser',  icon: 'eraser',     label: 'Eraser' },
  ];

  // Map a tool id to whatever the InfiniteCanvas understands. The canvas
  // already handles pen / arrow / rect / ellipse / eraser and a 'select'
  // tool that drags strokes around.
  const TOOL_TO_CANVAS = {
    cursor: 'select',
    sticky: 'select', // sticky doesn't touch the ink layer
    pen: 'pen',
    arrow: 'arrow',
    rect: 'rect',
    ellipse: 'ellipse',
    text: 'select',
    eraser: 'eraser',
  };

  // Resolve an oklch / var() / hex color string into a concrete rgb / hex
  // the browser can paint with. Falls back to the input.
  function resolveColor(c) {
    if (!c) return '#0a84ff';
    if (typeof c === 'string' && c.startsWith('var(')) {
      const name = c.slice(4, -1).trim();
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || '#0a84ff';
    }
    return c;
  }

  function h(tag, opts = {}, ...children) {
    const el = document.createElement(tag);
    if (opts.class) el.className = opts.class;
    if (opts.id) el.id = opts.id;
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) el.setAttribute(k, v);
    if (opts.style) Object.assign(el.style, opts.style);
    if (opts.text != null) el.textContent = opts.text;
    if (opts.html) el.innerHTML = opts.html;
    if (opts.on) for (const [evt, fn] of Object.entries(opts.on)) el.addEventListener(evt, fn);
    for (const c of children) {
      if (c == null || c === false) continue;
      el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function iconEl(name, size = 16) {
    const span = document.createElement('span');
    span.className = 'wbv-ico';
    span.style.width = size + 'px';
    span.style.height = size + 'px';
    span.innerHTML = window.HuddleIcons?.[name] || '';
    // Re-size the inline SVG to the requested size.
    const svg = span.querySelector('svg');
    if (svg) { svg.setAttribute('width', size); svg.setAttribute('height', size); }
    return span;
  }

  // Deterministic small rotation from a string id — so the same note always
  // tilts the same way without storing it in the DB.
  function rotFromId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    const t = ((h >>> 0) % 1000) / 1000; // 0..1
    return (t * 5.0) - 2.5; // -2.5..+2.5 deg
  }

  function hashHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return (h >>> 0) % 360;
  }

  function initialsFor(name) {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Label shown next to the avatar on a sticky note. The design used
  // 2-letter shorts (Rb / Ns) but in production the user's first name
  // reads better than an abbreviation. Falls back to initials when no
  // name is available.
  function shortNameFor(name) {
    if (!name) return '?';
    const first = name.trim().split(/\s+/)[0];
    return first || initialsFor(name);
  }

  class WhiteboardView {
    constructor({ huddle, channelId, whiteboard, mount, mode = 'stage', title = '', onClose }) {
      this.huddle = huddle;
      this.channelId = channelId;
      this.whiteboard = whiteboard;
      this.whiteboardId = whiteboard.id;
      this.mount = mount;
      this.mode = mode; // 'stage' | 'tile'
      this.boardTitle = whiteboard.title || title || 'Whiteboard';
      this.onClose = onClose;

      this.tool = 'sticky';     // matches the design's default
      this.drawColor = 'var(--accent)';
      this.stickyColor = 'butter';

      this.notes = new Map();   // id -> { data, el, textarea, handle, ... }
      this.frames = new Map();  // id -> { data, el, titleEl, ... }
      this.cursors = new Map(); // peerId -> { data, el }
      this.editingNote = null;
      this.selectedNote = null;
      this._paintedStrokeUuids = new Set();
      this._frameDrag = null;
      this._noteDrag = null;
      this._noteSaveTimers = new Map();
      this._cursorLastSentAt = 0;
      this._myCursorSeq = 0;
      this._destroyed = false;

      this._build();
    }

    // ────────────────────────────────────────────────────────────
    // DOM scaffold
    // ────────────────────────────────────────────────────────────
    _build() {
      const root = h('div', { class: 'wbv-root' + (this.mode === 'tile' ? ' wbv-mode-tile' : ' wbv-mode-stage') });
      this.root = root;

      // ── Header ─────────────────────────────────────────────────
      const header = h('div', { class: 'wbv-header' });
      header.appendChild(iconEl('board', 19));
      const titleEl = h('span', { class: 'wbv-title', text: this.boardTitle });
      titleEl.title = 'Click to rename the board';
      titleEl.addEventListener('click', () => this._renameBoard());
      header.appendChild(titleEl);
      this.titleEl = titleEl;

      const channelHint = h('span', { class: 'wbv-channel-hint mono', text: this._channelLabel() });
      header.appendChild(channelHint);
      this.channelHint = channelHint;

      header.appendChild(h('span', { class: 'wbv-spacer' }));

      const editors = h('div', { class: 'wbv-editors' });
      header.appendChild(editors);
      this.editorsEl = editors;
      const editorCount = h('span', { class: 'wbv-editing-label', text: '' });
      header.appendChild(editorCount);
      this.editorCountEl = editorCount;

      // "+ Frame" affordance — the design seeds frames as mock data; in
      // prod we let session leads stamp one with a click.
      const addFrameBtn = h('button', { class: 'wbv-btn wbv-btn-ghost', attrs: { title: 'Add a titled frame to organise notes' } });
      addFrameBtn.appendChild(iconEl('frame', 14));
      addFrameBtn.appendChild(h('span', { text: 'Frame' }));
      addFrameBtn.addEventListener('click', () => this._addFrameAtViewportCenter());
      header.appendChild(addFrameBtn);

      const exportBtn = h('button', { class: 'wbv-btn wbv-btn-solid', attrs: { title: 'Export as PNG' } });
      exportBtn.appendChild(iconEl('download', 14));
      exportBtn.appendChild(h('span', { text: 'Export' }));
      exportBtn.addEventListener('click', () => this._exportPng());
      header.appendChild(exportBtn);

      const closeBtn = h('button', { class: 'wbv-btn wbv-btn-ghost wbv-close', attrs: { title: 'Close whiteboard', 'aria-label': 'Close whiteboard' } });
      closeBtn.appendChild(iconEl('x', 14));
      closeBtn.addEventListener('click', () => this.onClose?.());
      header.appendChild(closeBtn);

      root.appendChild(header);

      // ── Board area ─────────────────────────────────────────────
      const board = h('div', { class: 'wbv-board' });
      this.boardEl = board;
      root.appendChild(board);

      // Canvas tile — wraps InfiniteCanvas. The canvas constructor needs
      // a `tile` host element; we give it the board so it sizes to the
      // full available area.
      const canvasHost = h('div', { class: 'wbv-canvas-host' });
      board.appendChild(canvasHost);
      this.canvasHost = canvasHost;

      // Frames + notes + cursors layer (rides above the canvas in screen
      // coords; positioning code projects through the InfiniteCanvas
      // viewport on every pan/zoom).
      const worldLayer = h('div', { class: 'wbv-world-layer' });
      board.appendChild(worldLayer);
      this.worldLayer = worldLayer;

      // Tool palette
      board.appendChild(this._buildToolPalette());

      // Sticky-tool hint pill
      this.hintPill = h('div', { class: 'wbv-hint-pill' });
      this.hintPill.appendChild(h('span', { class: 'wbv-hint-swatch' }));
      this.hintPill.appendChild(h('span', { text: 'Click anywhere to drop a sticky note' }));
      board.appendChild(this.hintPill);
      this._refreshHintSwatch();

      // Bottom-right cluster: minimap + zoom
      if (this.mode === 'stage') board.appendChild(this._buildMinimapCluster());
      else board.appendChild(this._buildZoomCluster());

      this.mount.appendChild(root);

      // Mount the InfiniteCanvas now that the host is in the DOM.
      this.canvas = new window.InfiniteCanvas({
        tile: canvasHost,
        send: (stroke) => this._broadcastStroke(stroke),
      });
      this.canvas.onStrokeFinished((p) => this._persistFinishedStroke(p));
      this.canvas.onStrokeErased((uuid) => this._eraseStroke(uuid));
      this.canvas.onStrokeMoved((uuid, p) => this._moveStroke(uuid, p));
      this.canvas.onViewportChange(() => this._onViewportChange());
      this.canvas.setColor(resolveColor(this.drawColor));
      this.canvas.setTool(TOOL_TO_CANVAS[this.tool]);

      // Capture sticky-drop clicks on the board background BEFORE the
      // InfiniteCanvas pointerdown handler. Use capture phase so we run
      // first and stopPropagation when the sticky tool is active.
      board.addEventListener('pointerdown', (e) => this._onBoardPointerDown(e), true);
      board.addEventListener('pointermove', (e) => this._onBoardPointerMove(e), false);
      board.addEventListener('keydown', (e) => this._onKeyDown(e));
      board.tabIndex = -1;

      // Document-level keys — tools, esc, delete.
      this._docKeyHandler = (e) => this._onDocKeyDown(e);
      document.addEventListener('keydown', this._docKeyHandler);

      // Throttle cursor broadcasts off raw pointermove on the board.
      this._onCursorMove = (e) => this._maybeBroadcastCursor(e);
      board.addEventListener('pointermove', this._onCursorMove);

      // Initial data + realtime wire-up.
      this._loadAndSubscribe();
    }

    _channelLabel() {
      // The chat layer owns channel-meta; just emit a hash + id when we
      // can't get a name. Keeps the header readable in popout / preview
      // modes where the chat module isn't mounted.
      try {
        const ch = window.HUDDLE_STATE?.channelMeta?.get(this.channelId);
        if (ch) return `#${ch.name || this.channelId}`;
      } catch {}
      return `#${this.channelId}`;
    }

    _buildToolPalette() {
      const palette = h('div', { class: 'wbv-palette' });
      this.paletteEl = palette;

      this.toolButtons = new Map();
      for (const t of TOOLS) {
        const b = h('button', { class: 'wbv-tool', attrs: { title: t.label, 'data-tool': t.id, 'aria-label': t.label } });
        b.appendChild(iconEl(t.icon, 18));
        b.addEventListener('click', () => this.setTool(t.id));
        palette.appendChild(b);
        this.toolButtons.set(t.id, b);
      }
      palette.appendChild(h('div', { class: 'wbv-palette-sep' }));

      const swatchWrap = h('div', { class: 'wbv-swatches' });
      palette.appendChild(swatchWrap);
      this.swatchWrap = swatchWrap;
      this._renderSwatches();

      palette.appendChild(h('div', { class: 'wbv-palette-sep' }));

      const undoBtn = h('button', { class: 'wbv-tool wbv-tool-slim', attrs: { title: 'Undo', 'aria-label': 'Undo' } });
      undoBtn.appendChild(iconEl('undo', 17));
      undoBtn.addEventListener('click', () => this.undo());
      palette.appendChild(undoBtn);

      const clearBtn = h('button', { class: 'wbv-tool wbv-tool-slim', attrs: { title: 'Clear board', 'aria-label': 'Clear board' } });
      clearBtn.appendChild(iconEl('trash', 17));
      clearBtn.addEventListener('click', () => this.clearAll());
      palette.appendChild(clearBtn);

      this._refreshToolButtons();
      return palette;
    }

    _renderSwatches() {
      this.swatchWrap.innerHTML = '';
      if (this.tool === 'sticky') {
        for (const k of STICKY_ORDER) {
          const c = STICKY[k].dot;
          const b = h('button', {
            class: 'wbv-swatch wbv-swatch-sticky' + (k === this.stickyColor ? ' is-on' : ''),
            style: { background: c },
            attrs: { title: k, 'aria-label': `Sticky color: ${k}` },
          });
          b.addEventListener('click', () => { this.stickyColor = k; this._renderSwatches(); this._refreshHintSwatch(); });
          this.swatchWrap.appendChild(b);
        }
      } else {
        const colors = ['var(--accent)', 'var(--live, #2ec4b6)', 'var(--online, #34c759)', 'var(--away, #f5a524)'];
        for (const c of colors) {
          const b = h('button', {
            class: 'wbv-swatch' + (c === this.drawColor ? ' is-on' : ''),
            style: { background: c },
            attrs: { 'aria-label': `Ink color ${c}` },
          });
          b.addEventListener('click', () => { this.drawColor = c; this.canvas.setColor(resolveColor(c)); this._renderSwatches(); });
          this.swatchWrap.appendChild(b);
        }
      }
    }

    _refreshHintSwatch() {
      const sw = this.hintPill?.querySelector('.wbv-hint-swatch');
      if (sw) sw.style.background = STICKY[this.stickyColor].dot;
    }

    _refreshToolButtons() {
      for (const [id, btn] of this.toolButtons) {
        btn.classList.toggle('is-active', id === this.tool);
      }
      this.hintPill?.classList.toggle('is-visible', this.tool === 'sticky');
      this.boardEl?.classList.toggle('wbv-tool-sticky', this.tool === 'sticky');
      this.boardEl?.classList.toggle('wbv-tool-eraser', this.tool === 'eraser');
    }

    _buildMinimapCluster() {
      const wrap = h('div', { class: 'wbv-cluster' });
      this.minimapEl = h('div', { class: 'wbv-minimap' });
      this.minimapSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.minimapSvg.setAttribute('width', '184');
      this.minimapSvg.setAttribute('height', '116');
      this.minimapEl.appendChild(this.minimapSvg);
      wrap.appendChild(this.minimapEl);
      wrap.appendChild(this._buildZoomCluster());
      return wrap;
    }

    _buildZoomCluster() {
      const z = h('div', { class: 'wbv-zoom' });
      const out = h('button', { class: 'wbv-zoom-btn', attrs: { title: 'Zoom out', 'aria-label': 'Zoom out' } });
      out.appendChild(iconEl('zoomOut', 17));
      out.addEventListener('click', () => this.canvas?.zoomOut());
      z.appendChild(out);
      this.zoomPctBtn = h('button', { class: 'wbv-zoom-pct mono', text: '100%', attrs: { title: 'Zoom to fit' } });
      this.zoomPctBtn.addEventListener('click', () => this._fitToContent());
      z.appendChild(this.zoomPctBtn);
      const inn = h('button', { class: 'wbv-zoom-btn', attrs: { title: 'Zoom in', 'aria-label': 'Zoom in' } });
      inn.appendChild(iconEl('zoomIn', 17));
      inn.addEventListener('click', () => this.canvas?.zoomIn());
      z.appendChild(inn);
      z.appendChild(h('div', { class: 'wbv-zoom-sep' }));
      const fit = h('button', { class: 'wbv-zoom-btn', attrs: { title: 'Zoom to fit content', 'aria-label': 'Zoom to fit content' } });
      fit.appendChild(iconEl('expand', 16));
      fit.addEventListener('click', () => this._fitToContent());
      z.appendChild(fit);
      return z;
    }

    // ────────────────────────────────────────────────────────────
    // Data + realtime
    // ────────────────────────────────────────────────────────────
    async _loadAndSubscribe() {
      try {
        // Subscribe to the team-scoped broadcast first so any in-flight
        // strokes / notes / frames / votes / cursors aren't missed
        // between the DB fetch and the subscribe. Dedup sets below
        // suppress double-paints when history replay races a live
        // event.
        await this.huddle.ensureWhiteboardChannel(
          this.whiteboardId,
          (p) => this._onRemoteStroke(p),
          (p) => this._onRemoteNote(p),
          {
            onFrame: (p) => this._onRemoteFrame(p),
            onVote: (p) => this._onRemoteVote(p),
            onCursor: (p) => this._onRemoteCursor(p),
          },
        );
      } catch (err) { console.warn('[wbv] subscribe failed', err); }

      try {
        const rows = await this.huddle.fetchWhiteboardStrokes(this.whiteboardId);
        for (const row of rows) {
          const polyline = row.data;
          if (!polyline) continue;
          if (polyline.uuid && this._paintedStrokeUuids.has(polyline.uuid)) continue;
          if (polyline.uuid) this._paintedStrokeUuids.add(polyline.uuid);
          if (polyline.action === 'clear') { this.canvas.clearAll(); continue; }
          this.canvas.addPersistedStroke(polyline);
        }
      } catch (err) { console.warn('[wbv] strokes fetch failed', err); }

      try {
        const noteRows = await this.huddle.fetchWhiteboardNotes(this.whiteboardId);
        for (const n of noteRows) this._renderNote(this._normalizeNote(n));
      } catch (err) { console.warn('[wbv] notes fetch failed', err); }

      try {
        const frameRows = await this.huddle.fetchWhiteboardFrames(this.whiteboardId);
        for (const f of frameRows) this._renderFrame(f);
      } catch (err) { console.warn('[wbv] frames fetch failed', err); }

      this._onViewportChange();
    }

    _normalizeNote(row) {
      const myId = this.huddle.peerId;
      const voted = Array.isArray(row.voted_by) && row.voted_by.includes(myId);
      // Text blocks carry the TEXT_KIND sentinel in color_key; preserve
      // it as-is so _renderNote routes to _renderTextBlock instead of
      // mapping to a default pastel.
      const slug = row.color_key === TEXT_KIND
        ? TEXT_KIND
        : (row.color_key && STICKY[row.color_key] ? row.color_key : (this._slugFromHex(row.color) || 'butter'));
      return {
        id: row.id,
        x: row.x, y: row.y, w: row.w || NOTE_W, h: row.h || NOTE_H,
        text: row.text || '',
        color_key: slug,
        author_id: row.author_id,
        votes: row.votes || 0,
        mine: voted,
      };
    }

    _slugFromHex(hex) {
      if (!hex) return null;
      const low = hex.toLowerCase();
      for (const k of STICKY_ORDER) if (STICKY[k].bg.toLowerCase() === low || STICKY[k].dot.toLowerCase() === low) return k;
      return null;
    }

    // ────────────────────────────────────────────────────────────
    // Tool + canvas plumbing
    // ────────────────────────────────────────────────────────────
    setTool(t) {
      this.tool = t;
      const canvasTool = TOOL_TO_CANVAS[t] || 'select';
      this.canvas?.setTool(canvasTool);
      this._renderSwatches();
      this._refreshToolButtons();
    }

    undo() {
      // Pop the most recent local stroke, if any. The canvas owns its own
      // undo stack of finished strokes — call it through removeStroke +
      // a delete-stroke broadcast.
      if (!this._localStrokeUuids || !this._localStrokeUuids.length) return;
      const uuid = this._localStrokeUuids.pop();
      this.canvas?.removeStroke(uuid);
      this._paintedStrokeUuids.add(uuid);
      this.huddle.sendWhiteboardStroke(this.whiteboardId, { action: 'delete-stroke', uuid });
      this.huddle.deleteWhiteboardStrokeByUuid(this.whiteboardId, uuid)
        .catch((err) => console.warn('[wbv] undo persist-delete failed', err));
    }

    async clearAll() {
      if (!confirm('Clear the whiteboard for everyone? This cannot be undone.')) return;
      this.canvas?.clearAll();
      this.huddle.sendWhiteboardStroke(this.whiteboardId, { action: 'clear' });
      for (const id of [...this.notes.keys()]) {
        this._removeNoteEl(id);
        this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'delete', id });
      }
      for (const id of [...this.frames.keys()]) {
        this._removeFrameEl(id);
        this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'delete', id });
        try { await this.huddle.deleteWhiteboardFrame(id); } catch {}
      }
      try { await this.huddle.clearWhiteboard(this.whiteboardId); }
      catch (err) { console.warn('[wbv] clear failed', err); }
    }

    _broadcastStroke(stroke) {
      this.huddle.sendWhiteboardStroke(this.whiteboardId, stroke);
    }

    _persistFinishedStroke(polyline) {
      if (!polyline?.uuid) return;
      this._paintedStrokeUuids.add(polyline.uuid);
      this._localStrokeUuids = this._localStrokeUuids || [];
      this._localStrokeUuids.push(polyline.uuid);
      if (this._localStrokeUuids.length > 50) this._localStrokeUuids.shift();
      this.huddle.persistWhiteboardStroke(this.whiteboardId, polyline)
        .catch((err) => console.warn('[wbv] persist failed', err));
    }

    _eraseStroke(uuid) {
      if (!uuid) return;
      this._paintedStrokeUuids.add(uuid);
      this.huddle.sendWhiteboardStroke(this.whiteboardId, { action: 'delete-stroke', uuid });
      this.huddle.deleteWhiteboardStrokeByUuid(this.whiteboardId, uuid)
        .catch((err) => console.warn('[wbv] erase persist failed', err));
    }

    _moveStroke(uuid, polyline) {
      this.huddle.deleteWhiteboardStrokeByUuid(this.whiteboardId, uuid)
        .then(() => this.huddle.persistWhiteboardStroke(this.whiteboardId, polyline))
        .catch((err) => console.warn('[wbv] move persist failed', err));
    }

    _onRemoteStroke(payload) {
      if (payload.from === this.huddle.peerId) return;
      const stroke = payload.stroke;
      if (stroke?.action === 'delete-stroke' && stroke.uuid) {
        this.canvas.removeStroke(stroke.uuid);
        this._paintedStrokeUuids.add(stroke.uuid);
        return;
      }
      this.canvas.applyRemote(stroke);
      if (stroke.action === 'end' && stroke.uuid) this._paintedStrokeUuids.add(stroke.uuid);
    }

    // ────────────────────────────────────────────────────────────
    // Notes (sticky)
    // ────────────────────────────────────────────────────────────
    _onBoardPointerDown(e) {
      // Capture-phase. Intervene for tools that stamp something at the
      // click point (sticky, text). Ignore clicks on existing widgets so
      // the user can still select / drag / use the toolbar / etc.
      if (this.tool !== 'sticky' && this.tool !== 'text') return;
      if (e.target.closest('.wbv-note, .wbv-text, .wbv-frame, .wbv-palette, .wbv-cluster, .wbv-hint-pill, .wbv-header, .wbv-cursor, .wbv-note-toolbar')) return;
      e.stopPropagation();
      e.preventDefault();
      const w = this._clientToWorld(e.clientX, e.clientY);
      if (this.tool === 'sticky') this._addNoteAt(w.x - NOTE_W / 2, w.y - NOTE_H / 2);
      else this._addTextAt(w.x - TEXT_W / 2, w.y - TEXT_H / 2);
    }

    _onBoardPointerMove() {
      // Reserved for future hover effects; cursor broadcast handled
      // separately so its throttle is independent.
    }

    async _addNoteAt(x, y) {
      const id = crypto.randomUUID();
      const note = {
        id, x, y, w: NOTE_W, h: NOTE_H,
        text: '',
        color_key: this.stickyColor,
        author_id: this.huddle.peerId,
        votes: 0, mine: false,
      };
      this._renderNote(note, { focus: true });
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'create', note });
      try {
        await this.huddle.createWhiteboardNote(this.whiteboardId, {
          id, x, y, w: NOTE_W, h: NOTE_H, text: '',
          color: STICKY[this.stickyColor].bg,
          color_key: this.stickyColor,
        });
      } catch (err) { console.warn('[wbv] note create failed', err); }
      // After dropping, switch back to cursor so subsequent clicks
      // select/move the note instead of stacking new ones.
      this.setTool('cursor');
    }

    async _addTextAt(x, y) {
      const id = crypto.randomUUID();
      const note = {
        id, x, y, w: TEXT_W, h: TEXT_H,
        text: '', color_key: TEXT_KIND,
        author_id: this.huddle.peerId,
        votes: 0, mine: false,
      };
      this._renderNote(note, { focus: true });
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'create', note });
      try {
        await this.huddle.createWhiteboardNote(this.whiteboardId, {
          id, x, y, w: TEXT_W, h: TEXT_H, text: '',
          color: 'transparent', color_key: TEXT_KIND,
        });
      } catch (err) { console.warn('[wbv] text create failed', err); }
      this.setTool('cursor');
    }

    _renderNote(note, { focus = false } = {}) {
      if (this.notes.has(note.id)) { this._applyNotePatch(note); return; }
      // Text blocks ride the same DB table as stickies (kind sentinel
      // in color_key) but render as plain text — no card, no folded
      // corner, no vote pill. Route them to a separate path so the
      // sticky path stays simple.
      if (note.color_key === TEXT_KIND) return this._renderTextBlock(note, { focus });
      const slug = note.color_key && STICKY[note.color_key] ? note.color_key : 'butter';
      const palette = STICKY[slug];
      const rot = rotFromId(note.id);
      const el = h('div', { class: 'wbv-note', attrs: { 'data-note-id': note.id, tabindex: '0' } });
      el.style.setProperty('--wbv-note-bg', palette.bg);
      el.style.setProperty('--wbv-note-tx', palette.tx);
      el.style.setProperty('--wbv-note-fold', palette.fold);
      el.style.setProperty('--wbv-note-rot', rot.toFixed(2) + 'deg');

      const card = h('div', { class: 'wbv-note-card' });
      const fold = h('span', { class: 'wbv-note-fold' });
      card.appendChild(fold);

      const text = h('div', { class: 'wbv-note-text', attrs: { contenteditable: 'false', spellcheck: 'false' } });
      text.textContent = note.text || '';
      card.appendChild(text);

      const footer = h('div', { class: 'wbv-note-footer' });
      const author = h('span', { class: 'wbv-note-author' });
      const avatar = h('span', { class: 'wbv-note-avatar' });
      avatar.textContent = '';
      author.appendChild(avatar);
      const authorName = h('span', { class: 'wbv-note-author-name', text: '' });
      author.appendChild(authorName);
      footer.appendChild(author);

      const vote = h('button', { class: 'wbv-note-vote', attrs: { title: 'Upvote' } });
      // Thumbs-up glyph (feather "thumbs-up"): the hollow stroke is the
      // not-yet-voted state; _refreshVoteStyle swaps fill to currentColor
      // when the caller's vote is on.
      vote.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.3a2 2 0 0 0 2-1.7l1.4-9a2 2 0 0 0-2-2.3z"/><path d="M7 22V11H3v11z"/></svg>';
      const voteCount = h('span', { text: String(note.votes || 0) });
      vote.appendChild(voteCount);
      vote.addEventListener('click', (e) => { e.stopPropagation(); this._toggleVote(note.id); });
      footer.appendChild(vote);

      card.appendChild(footer);
      el.appendChild(card);

      // Contextual color/delete toolbar (only when selected, not editing).
      const toolbar = h('div', { class: 'wbv-note-toolbar' });
      for (const k of STICKY_ORDER) {
        const sw = h('button', { class: 'wbv-note-toolbar-swatch', style: { background: STICKY[k].dot }, attrs: { title: k } });
        sw.addEventListener('click', (e) => { e.stopPropagation(); this._setNoteColor(note.id, k); });
        toolbar.appendChild(sw);
      }
      toolbar.appendChild(h('span', { class: 'wbv-note-toolbar-sep' }));
      const del = h('button', { class: 'wbv-note-toolbar-del', attrs: { title: 'Delete note' } });
      del.appendChild(iconEl('trash', 14));
      del.addEventListener('click', (e) => { e.stopPropagation(); this._deleteNote(note.id); });
      toolbar.appendChild(del);
      el.appendChild(toolbar);

      this.worldLayer.appendChild(el);

      const entry = { data: { ...note }, el, textEl: text, voteEl: vote, voteCountEl: voteCount, authorNameEl: authorName, avatarEl: avatar };
      this.notes.set(note.id, entry);
      this._wireNoteHandlers(entry);
      this._positionNote(entry);
      this._refreshVoteStyle(entry);
      this._resolveAuthor(entry);
      if (focus) {
        this._selectNote(note.id);
        this._beginEditNote(note.id);
      }
    }

    _applyNotePatch(patch) {
      const entry = this.notes.get(patch.id);
      if (!entry) return;
      Object.assign(entry.data, patch);
      if (patch.text != null && entry.textEl && document.activeElement !== entry.textEl) {
        entry.textEl.textContent = patch.text;
      }
      if (patch.color_key && STICKY[patch.color_key]) {
        const p = STICKY[patch.color_key];
        entry.el.style.setProperty('--wbv-note-bg', p.bg);
        entry.el.style.setProperty('--wbv-note-tx', p.tx);
        entry.el.style.setProperty('--wbv-note-fold', p.fold);
      }
      if (entry.kind !== 'text') {
        if (patch.votes != null) entry.voteCountEl.textContent = String(patch.votes);
        if (patch.mine != null || patch.votes != null) this._refreshVoteStyle(entry);
      }
      if (patch.x != null || patch.y != null || patch.w != null || patch.h != null) this._positionNote(entry);
    }

    // ── Text block (lightweight kind of note: no card, no votes) ──
    _renderTextBlock(note, { focus = false } = {}) {
      const el = h('div', { class: 'wbv-text', attrs: { 'data-note-id': note.id, tabindex: '0' } });
      const text = h('div', { class: 'wbv-text-input', attrs: { contenteditable: 'false', spellcheck: 'false' } });
      text.textContent = note.text || '';
      el.appendChild(text);
      this.worldLayer.appendChild(el);
      const entry = { data: { ...note }, el, textEl: text, kind: 'text' };
      this.notes.set(note.id, entry);
      this._wireNoteHandlers(entry); // same drag handlers; text edits below
      this._positionNote(entry);
      if (focus) {
        this._selectNote(note.id);
        this._beginEditNote(note.id);
      }
    }

    _positionNote(entry) {
      const vp = this.canvas?.getViewport() || { x: 0, y: 0, scale: 1 };
      const { el, data } = entry;
      el.style.left = ((data.x - vp.x) * vp.scale) + 'px';
      el.style.top = ((data.y - vp.y) * vp.scale) + 'px';
      if (entry.kind === 'text') {
        // Text blocks size to content (no fixed w/h) so adding lines
        // grows the selection border with the text instead of clipping
        // past the seeded TEXT_W/TEXT_H. Apply the zoom via a CSS
        // transform on the inner text so font/spacing scale visually.
        el.style.width = '';
        el.style.height = '';
        el.style.minWidth = '';
        el.style.transform = `scale(${vp.scale})`;
        el.style.transformOrigin = '0 0';
      } else {
        // Sticky notes: fixed width (per design), but height grows with
        // content. Setting an explicit height clipped long notes; switch
        // to min-height so the card matches the design's seed size when
        // empty but auto-expands as the user types.
        el.style.width = (data.w * vp.scale) + 'px';
        el.style.height = '';
        el.style.minHeight = (data.h * vp.scale) + 'px';
        // Cap the inner-text scale so a deeply zoomed-out note still
        // reads, but a zoomed-in note feels bigger.
        el.style.setProperty('--wbv-note-zoom', vp.scale.toFixed(2));
      }
    }

    _refreshVoteStyle(entry) {
      const mine = !!entry.data.mine;
      entry.voteEl.classList.toggle('is-mine', mine);
      // Thumbs-up has two paths (palm + thumb); fill both so the toggle
      // reads cleanly. The previous single-path triangle queried only
      // the first <path>, which is why the user saw "icon doesn't stick".
      entry.voteEl.querySelectorAll('svg path').forEach((p) => p.setAttribute('fill', mine ? 'currentColor' : 'none'));
    }

    async _resolveAuthor(entry) {
      try {
        const profile = await this.huddle.getProfile(entry.data.author_id);
        if (this._destroyed) return;
        const name = profile?.name || profile?.email || 'Unknown';
        // Show the author's first name next to the avatar. The design
        // mock used 2-letter shorts, but those get cut off for real
        // names and read worse than "Nick".
        entry.authorNameEl.textContent = shortNameFor(name);
        const hue = hashHue(entry.data.author_id || name);
        entry.avatarEl.style.background = `oklch(0.62 0.14 ${hue})`;
        entry.avatarEl.textContent = '';
      } catch {
        entry.authorNameEl.textContent = '?';
      }
    }

    _wireNoteHandlers(entry) {
      const { el, textEl, data } = entry;

      // Click → select. Double-click → edit. Drag (from non-text) → move.
      el.addEventListener('click', (e) => {
        if (this.editingNote === data.id) return; // editing text — ignore
        e.stopPropagation();
        this._selectNote(data.id);
      });
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this._selectNote(data.id);
        this._beginEditNote(data.id);
      });

      el.addEventListener('pointerdown', (e) => {
        if (this.editingNote === data.id) return;
        if (this.tool === 'sticky') return; // sticky tool stamps new notes; don't grab existing ones
        // Don't start dragging from inside the contextual toolbar
        // (color swatches / delete) or the vote pill — those have their
        // own click handlers and a tiny pointer drift would otherwise
        // burn a spurious "moved" persist.
        if (e.target.closest('.wbv-note-toolbar, .wbv-note-vote')) return;
        e.stopPropagation();
        e.preventDefault();
        const vp = this.canvas?.getViewport() || { scale: 1 };
        const start = {
          clientX: e.clientX, clientY: e.clientY,
          origX: data.x, origY: data.y,
          scale: vp.scale,
        };
        this._noteDrag = { id: data.id, start, moved: false };
        el.setPointerCapture?.(e.pointerId);
        const onMove = (ev) => {
          const dx = (ev.clientX - start.clientX) / start.scale;
          const dy = (ev.clientY - start.clientY) / start.scale;
          if (Math.abs(dx) + Math.abs(dy) > 1) this._noteDrag.moved = true;
          data.x = start.origX + dx;
          data.y = start.origY + dy;
          this._positionNote(entry);
          this._scheduleMinimapRender();
        };
        const onUp = () => {
          el.removeEventListener('pointermove', onMove);
          el.removeEventListener('pointerup', onUp);
          el.removeEventListener('pointercancel', onUp);
          if (this._noteDrag?.moved) {
            this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'update', note: { id: data.id, x: data.x, y: data.y } });
            this.huddle.updateWhiteboardNote(data.id, { x: data.x, y: data.y })
              .catch((err) => console.warn('[wbv] note move persist failed', err));
          }
          this._noteDrag = null;
        };
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
      });

      // Text edits — broadcast immediately, debounce DB.
      textEl.addEventListener('input', () => {
        data.text = textEl.innerText.trim();
        this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'update', note: { id: data.id, text: data.text } });
        clearTimeout(this._noteSaveTimers.get(data.id));
        const t = setTimeout(() => {
          this.huddle.updateWhiteboardNote(data.id, { text: data.text })
            .catch((err) => console.warn('[wbv] note text save failed', err));
        }, 500);
        this._noteSaveTimers.set(data.id, t);
      });
      textEl.addEventListener('blur', () => this._endEditNote(data.id));
      textEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); this._endEditNote(data.id); }
      });
    }

    _selectNote(id) {
      if (this.selectedNote === id) return;
      const prev = this.selectedNote && this.notes.get(this.selectedNote);
      if (prev) prev.el.classList.remove('is-selected');
      this.selectedNote = id;
      const next = id && this.notes.get(id);
      if (next) next.el.classList.add('is-selected');
    }

    _beginEditNote(id) {
      const entry = this.notes.get(id);
      if (!entry) return;
      this.editingNote = id;
      entry.el.classList.add('is-editing');
      entry.textEl.setAttribute('contenteditable', 'true');
      entry.textEl.focus();
      // place caret at end
      const r = document.createRange(); r.selectNodeContents(entry.textEl); r.collapse(false);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    }

    _endEditNote(id) {
      const entry = this.notes.get(id);
      if (!entry || this.editingNote !== id) return;
      this.editingNote = null;
      entry.el.classList.remove('is-editing');
      entry.textEl.setAttribute('contenteditable', 'false');
      // Empty notes get auto-deleted to match Miro/FigJam behavior.
      const text = entry.textEl.innerText.trim();
      if (!text) this._deleteNote(id);
      else {
        this.huddle.updateWhiteboardNote(id, { text })
          .catch((err) => console.warn('[wbv] final note text save failed', err));
      }
    }

    _setNoteColor(id, slug) {
      if (!STICKY[slug]) return;
      const entry = this.notes.get(id);
      if (!entry) return;
      entry.data.color_key = slug;
      const p = STICKY[slug];
      entry.el.style.setProperty('--wbv-note-bg', p.bg);
      entry.el.style.setProperty('--wbv-note-tx', p.tx);
      entry.el.style.setProperty('--wbv-note-fold', p.fold);
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'update', note: { id, color_key: slug } });
      this.huddle.updateWhiteboardNote(id, { color_key: slug, color: p.bg })
        .catch((err) => console.warn('[wbv] color save failed', err));
    }

    _removeNoteEl(id) {
      const entry = this.notes.get(id);
      if (!entry) return;
      entry.el.remove();
      this.notes.delete(id);
      if (this.selectedNote === id) this.selectedNote = null;
      if (this.editingNote === id) this.editingNote = null;
      clearTimeout(this._noteSaveTimers.get(id));
      this._noteSaveTimers.delete(id);
      this._scheduleMinimapRender();
    }

    async _deleteNote(id) {
      this._removeNoteEl(id);
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'delete', id });
      try { await this.huddle.deleteWhiteboardNote(id); }
      catch (err) { console.warn('[wbv] note delete failed', err); }
    }

    async _toggleVote(id) {
      const entry = this.notes.get(id);
      if (!entry) return;
      // Optimistic flip — render the new state immediately so the
      // button "sticks" even if the network is slow.
      entry.data.mine = !entry.data.mine;
      entry.data.votes = Math.max(0, entry.data.votes + (entry.data.mine ? 1 : -1));
      entry.voteCountEl.textContent = String(entry.data.votes);
      this._refreshVoteStyle(entry);
      this.huddle.sendWhiteboardVote(this.whiteboardId, { id, votes: entry.data.votes, mine: entry.data.mine });
      try {
        const res = await this.huddle.toggleWhiteboardNoteVote(id);
        // Reconcile with server truth in case multiple votes raced.
        entry.data.votes = res.votes;
        entry.data.mine = res.mine;
        entry.voteCountEl.textContent = String(res.votes);
        this._refreshVoteStyle(entry);
      } catch (err) {
        // Keep the optimistic state. The most common failure here is
        // the toggle_whiteboard_note_vote RPC not existing yet (the
        // 2026-05-31 migration ships it but hasn't been applied on
        // every environment). Rolling back made the icon flicker
        // back to unselected, which read as "doesn't stick." Logging
        // the error is enough; the local state survives until the
        // user reloads, and once the migration lands the reconcile
        // path takes over.
        console.warn('[wbv] vote toggle persist failed (keeping local state)', err);
      }
    }

    _onRemoteNote(payload) {
      if (payload.from === this.huddle.peerId) return;
      if (payload.action === 'create' && payload.note) this._renderNote(this._normalizeNote(payload.note));
      else if (payload.action === 'update' && payload.note) this._applyNotePatch(this._normalizeNote(payload.note));
      else if (payload.action === 'delete' && payload.id) this._removeNoteEl(payload.id);
    }

    _onRemoteVote(payload) {
      if (payload.from === this.huddle.peerId) return;
      const entry = this.notes.get(payload.id);
      if (!entry) return;
      entry.data.votes = payload.votes ?? entry.data.votes;
      entry.voteCountEl.textContent = String(entry.data.votes);
      // `mine` from a peer doesn't apply to me — leave my own flag alone.
    }

    // ────────────────────────────────────────────────────────────
    // Frames
    // ────────────────────────────────────────────────────────────
    async _addFrameAtViewportCenter() {
      const vp = this.canvas?.getViewport() || { x: 0, y: 0, scale: 1 };
      const r = this.boardEl.getBoundingClientRect();
      const cx = (r.width / 2 - 0) / vp.scale + vp.x;
      const cy = (r.height / 2 - 0) / vp.scale + vp.y;
      const w = 380, h = 460;
      const frame = {
        id: crypto.randomUUID(),
        x: cx - w / 2, y: cy - h / 2, w, h,
        title: 'Untitled frame', tint: 'accent', dashed: false,
      };
      this._renderFrame(frame, { editTitle: true });
      this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'create', frame });
      try { await this.huddle.createWhiteboardFrame(this.whiteboardId, frame); }
      catch (err) { console.warn('[wbv] frame create failed', err); }
    }

    _renderFrame(frame, { editTitle = false } = {}) {
      if (this.frames.has(frame.id)) { this._applyFramePatch(frame); return; }
      const tintVar = FRAME_TINTS[frame.tint] || FRAME_TINTS.accent;
      const el = h('div', { class: 'wbv-frame' + (frame.dashed ? ' wbv-frame-dashed' : ''), attrs: { 'data-frame-id': frame.id } });
      el.style.setProperty('--wbv-frame-tint', tintVar);

      const chip = h('div', { class: 'wbv-frame-chip' });
      const dot = h('span', { class: 'wbv-frame-dot' });
      chip.appendChild(dot);
      const titleEl = h('span', { class: 'wbv-frame-title', text: frame.title || 'Untitled frame', attrs: { spellcheck: 'false' } });
      chip.appendChild(titleEl);
      const del = h('button', { class: 'wbv-frame-del', attrs: { title: 'Delete frame', 'aria-label': 'Delete frame' } });
      del.appendChild(iconEl('x', 12));
      del.addEventListener('click', (e) => { e.stopPropagation(); this._deleteFrame(frame.id); });
      chip.appendChild(del);
      el.appendChild(chip);

      this.worldLayer.insertBefore(el, this.worldLayer.firstChild); // behind notes
      const entry = { data: { ...frame }, el, titleEl, chipEl: chip };
      this.frames.set(frame.id, entry);
      this._positionFrame(entry);
      this._wireFrameHandlers(entry);
      if (editTitle) {
        titleEl.setAttribute('contenteditable', 'true');
        titleEl.focus();
        const r = document.createRange(); r.selectNodeContents(titleEl);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      }
      this._scheduleMinimapRender();
    }

    _positionFrame(entry) {
      const vp = this.canvas?.getViewport() || { x: 0, y: 0, scale: 1 };
      const { el, data } = entry;
      el.style.left = ((data.x - vp.x) * vp.scale) + 'px';
      el.style.top = ((data.y - vp.y) * vp.scale) + 'px';
      el.style.width = (data.w * vp.scale) + 'px';
      el.style.height = (data.h * vp.scale) + 'px';
    }

    _wireFrameHandlers(entry) {
      const { el, titleEl, chipEl, data } = entry;

      // Drag the title chip to move the whole frame.
      chipEl.addEventListener('pointerdown', (e) => {
        if (e.target === titleEl && titleEl.getAttribute('contenteditable') === 'true') return;
        if (e.target.closest('.wbv-frame-del')) return;
        e.stopPropagation();
        e.preventDefault();
        const vp = this.canvas?.getViewport() || { scale: 1 };
        const start = { clientX: e.clientX, clientY: e.clientY, origX: data.x, origY: data.y, scale: vp.scale };
        chipEl.setPointerCapture?.(e.pointerId);
        const onMove = (ev) => {
          data.x = start.origX + (ev.clientX - start.clientX) / start.scale;
          data.y = start.origY + (ev.clientY - start.clientY) / start.scale;
          this._positionFrame(entry);
          this._scheduleMinimapRender();
        };
        const onUp = () => {
          chipEl.removeEventListener('pointermove', onMove);
          chipEl.removeEventListener('pointerup', onUp);
          chipEl.removeEventListener('pointercancel', onUp);
          this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'update', frame: { id: data.id, x: data.x, y: data.y } });
          this.huddle.updateWhiteboardFrame(data.id, { x: data.x, y: data.y })
            .catch((err) => console.warn('[wbv] frame move persist failed', err));
        };
        chipEl.addEventListener('pointermove', onMove);
        chipEl.addEventListener('pointerup', onUp);
        chipEl.addEventListener('pointercancel', onUp);
      });

      titleEl.addEventListener('dblclick', () => { titleEl.setAttribute('contenteditable', 'true'); titleEl.focus(); });
      titleEl.addEventListener('blur', () => {
        titleEl.setAttribute('contenteditable', 'false');
        const newTitle = titleEl.textContent.trim() || 'Untitled frame';
        if (newTitle !== data.title) {
          data.title = newTitle;
          titleEl.textContent = newTitle;
          this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'update', frame: { id: data.id, title: newTitle } });
          this.huddle.updateWhiteboardFrame(data.id, { title: newTitle })
            .catch((err) => console.warn('[wbv] frame title save failed', err));
        }
      });
      titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); titleEl.blur(); } });
    }

    _applyFramePatch(patch) {
      const entry = this.frames.get(patch.id);
      if (!entry) return;
      Object.assign(entry.data, patch);
      if (patch.title != null && document.activeElement !== entry.titleEl) entry.titleEl.textContent = patch.title;
      if (patch.tint) entry.el.style.setProperty('--wbv-frame-tint', FRAME_TINTS[patch.tint] || FRAME_TINTS.accent);
      if (patch.dashed != null) entry.el.classList.toggle('wbv-frame-dashed', !!patch.dashed);
      if (patch.x != null || patch.y != null || patch.w != null || patch.h != null) this._positionFrame(entry);
    }

    _removeFrameEl(id) {
      const entry = this.frames.get(id);
      if (!entry) return;
      entry.el.remove();
      this.frames.delete(id);
      this._scheduleMinimapRender();
    }

    async _deleteFrame(id) {
      this._removeFrameEl(id);
      this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'delete', id });
      try { await this.huddle.deleteWhiteboardFrame(id); }
      catch (err) { console.warn('[wbv] frame delete failed', err); }
    }

    _onRemoteFrame(payload) {
      if (payload.from === this.huddle.peerId) return;
      if (payload.action === 'create' && payload.frame) this._renderFrame(payload.frame);
      else if (payload.action === 'update' && payload.frame) this._applyFramePatch(payload.frame);
      else if (payload.action === 'delete' && payload.id) this._removeFrameEl(payload.id);
    }

    // ────────────────────────────────────────────────────────────
    // Ghost cursors
    // ────────────────────────────────────────────────────────────
    _maybeBroadcastCursor(e) {
      const now = performance.now();
      if (now - this._cursorLastSentAt < 50) return; // ~20Hz
      this._cursorLastSentAt = now;
      const w = this._clientToWorld(e.clientX, e.clientY);
      this.huddle.sendWhiteboardCursor(this.whiteboardId, { x: w.x, y: w.y, t: now });
    }

    async _onRemoteCursor(payload) {
      if (payload.from === this.huddle.peerId) return;
      const peerId = payload.from;
      const c = payload.cursor;
      if (!c) return;
      let entry = this.cursors.get(peerId);
      if (!entry) {
        const el = h('div', { class: 'wbv-cursor' });
        el.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M5 3l6.5 16 2-6.5 6.5-2z"/></svg>';
        const label = h('span', { class: 'wbv-cursor-label', text: '…' });
        el.appendChild(label);
        const hue = hashHue(peerId);
        const color = `oklch(0.7 0.16 ${hue})`;
        el.style.color = color;
        label.style.background = color;
        this.worldLayer.appendChild(el);
        entry = { el, label, lastSeen: Date.now() };
        this.cursors.set(peerId, entry);
        // Resolve name (best-effort).
        try {
          const p = await this.huddle.getProfile(peerId);
          if (!this._destroyed) label.textContent = (p?.name || 'Guest').split(/\s+/)[0];
        } catch {}
      }
      entry.data = c;
      entry.lastSeen = Date.now();
      this._positionCursor(entry);
      // GC stale cursors every couple of seconds.
      if (!this._cursorGcTimer) {
        this._cursorGcTimer = setInterval(() => this._gcCursors(), 2500);
      }
    }

    _positionCursor(entry) {
      const vp = this.canvas?.getViewport() || { x: 0, y: 0, scale: 1 };
      entry.el.style.left = ((entry.data.x - vp.x) * vp.scale) + 'px';
      entry.el.style.top = ((entry.data.y - vp.y) * vp.scale) + 'px';
    }

    _gcCursors() {
      const cutoff = Date.now() - 10_000;
      for (const [id, entry] of this.cursors) {
        if (entry.lastSeen < cutoff) {
          entry.el.remove();
          this.cursors.delete(id);
        }
      }
      if (!this.cursors.size && this._cursorGcTimer) {
        clearInterval(this._cursorGcTimer);
        this._cursorGcTimer = null;
      }
    }

    // ────────────────────────────────────────────────────────────
    // Viewport / minimap / projection
    // ────────────────────────────────────────────────────────────
    _onViewportChange() {
      // Re-project everything that lives in world coords.
      for (const entry of this.notes.values()) this._positionNote(entry);
      for (const entry of this.frames.values()) this._positionFrame(entry);
      for (const entry of this.cursors.values()) this._positionCursor(entry);
      this._refreshZoomLabel();
      this._scheduleMinimapRender();
    }

    _refreshZoomLabel() {
      const vp = this.canvas?.getViewport() || { scale: 1 };
      if (this.zoomPctBtn) this.zoomPctBtn.textContent = `${Math.round((vp.scale || 1) * 100)}%`;
    }

    _scheduleMinimapRender() {
      if (this._minimapRaf || !this.minimapSvg) return;
      this._minimapRaf = requestAnimationFrame(() => {
        this._minimapRaf = null;
        this._renderMinimap();
      });
    }

    _renderMinimap() {
      if (!this.minimapSvg) return;
      const W = 184, H = 116, PAD = 6;
      // Compute world bbox from all content + the visible viewport, so
      // the minimap stays centred on the action even when there's no
      // content yet.
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const consume = (x, y, w = 0, h = 0) => {
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x + w > maxX) maxX = x + w; if (y + h > maxY) maxY = y + h;
      };
      for (const e of this.frames.values()) consume(e.data.x, e.data.y, e.data.w, e.data.h);
      for (const e of this.notes.values()) consume(e.data.x, e.data.y, e.data.w, e.data.h);
      const vp = this.canvas?.getViewport() || { x: 0, y: 0, scale: 1 };
      const r = this.boardEl.getBoundingClientRect();
      const vis = { x: vp.x, y: vp.y, w: r.width / vp.scale, h: r.height / vp.scale };
      consume(vis.x, vis.y, vis.w, vis.h);
      if (minX === Infinity) { minX = 0; minY = 0; maxX = 1000; maxY = 700; }
      const ww = Math.max(100, maxX - minX), hh = Math.max(100, maxY - minY);
      const s = Math.min((W - PAD * 2) / ww, (H - PAD * 2) / hh);
      const ox = PAD + ((W - PAD * 2) - ww * s) / 2 - minX * s;
      const oy = PAD + ((H - PAD * 2) - hh * s) / 2 - minY * s;

      // Build the SVG.
      let svgInner = '';
      for (const e of this.frames.values()) {
        const { data } = e;
        svgInner += `<rect x="${data.x * s + ox}" y="${data.y * s + oy}" width="${Math.max(2, data.w * s)}" height="${Math.max(2, data.h * s)}" rx="4" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.18)" stroke-width="1"/>`;
      }
      for (const e of this.notes.values()) {
        const { data } = e;
        const c = STICKY[data.color_key]?.dot || '#ffd866';
        svgInner += `<rect x="${data.x * s + ox}" y="${data.y * s + oy}" width="${Math.max(2, data.w * s)}" height="${Math.max(2, data.h * s)}" rx="2" fill="${c}"/>`;
      }
      // Viewport rect.
      svgInner += `<rect x="${vis.x * s + ox}" y="${vis.y * s + oy}" width="${vis.w * s}" height="${vis.h * s}" fill="rgba(10,132,255,0.18)" stroke="var(--accent, #0a84ff)" stroke-width="1.5" rx="3"/>`;
      this.minimapSvg.innerHTML = svgInner;
    }

    _fitToContent() {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const consume = (x, y, w = 0, h = 0) => {
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x + w > maxX) maxX = x + w; if (y + h > maxY) maxY = y + h;
      };
      for (const e of this.frames.values()) consume(e.data.x, e.data.y, e.data.w, e.data.h);
      for (const e of this.notes.values()) consume(e.data.x, e.data.y, e.data.w, e.data.h);
      if (minX === Infinity) { this.canvas?.resetViewport(); return; }
      const pad = 80;
      const ww = (maxX - minX) + pad * 2;
      const hh = (maxY - minY) + pad * 2;
      const r = this.boardEl.getBoundingClientRect();
      const s = Math.min(r.width / ww, r.height / hh, 2);
      const ns = Math.max(0.1, s);
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const vpx = cx - (r.width / ns) / 2;
      const vpy = cy - (r.height / ns) / 2;
      this.canvas?.setViewport({ x: vpx, y: vpy, scale: ns });
    }

    _clientToWorld(cx, cy) {
      const r = this.boardEl.getBoundingClientRect();
      const vp = this.canvas?.getViewport() || { x: 0, y: 0, scale: 1 };
      return { x: vp.x + (cx - r.left) / vp.scale, y: vp.y + (cy - r.top) / vp.scale };
    }

    // ────────────────────────────────────────────────────────────
    // Keyboard
    // ────────────────────────────────────────────────────────────
    _onDocKeyDown(e) {
      if (this._destroyed) return;
      // Don't capture keys when the user is typing into a non-board
      // input (chat composer, command palette, …). The contenteditable
      // note text below opts in via _onKeyDown.
      const t = e.target;
      const inForm = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (inForm) return;
      if (!this.mount.contains(e.target) && this.mode === 'tile') return;
      const k = e.key.toLowerCase();
      if (k === 'v') this.setTool('cursor');
      else if (k === 's') this.setTool('sticky');
      else if (k === 'p') this.setTool('pen');
      else if (k === 'e') this.setTool('eraser');
      else if (k === 'r') this.setTool('rect');
      else if (k === 'o') this.setTool('ellipse');
      else if (k === 'a') this.setTool('arrow');
      else if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); this.undo(); }
      else if (k === 'delete' || k === 'backspace') {
        if (this.selectedNote && !this.editingNote) { e.preventDefault(); this._deleteNote(this.selectedNote); }
      }
      else if (k === 'escape') {
        if (this.editingNote) this._endEditNote(this.editingNote);
        else this._selectNote(null);
      }
    }
    _onKeyDown() { /* board-level — currently inert; doc handler covers everything */ }

    // ────────────────────────────────────────────────────────────
    // Header bits
    // ────────────────────────────────────────────────────────────
    async _renameBoard() {
      const next = prompt('Rename whiteboard', this.boardTitle);
      if (next == null) return;
      const trimmed = next.trim() || 'Whiteboard';
      this.boardTitle = trimmed;
      this.titleEl.textContent = trimmed;
      // Persist if the API supports it; not in scope to add a column,
      // so we just emit through realtime so peers in this session see
      // the change.
      try {
        if (this.huddle.updateWhiteboardTitle) await this.huddle.updateWhiteboardTitle(this.whiteboardId, trimmed);
      } catch (err) { console.warn('[wbv] rename persist failed', err); }
    }

    _exportPng() {
      // Export the visible board as a PNG via dom-to-canvas of the
      // ink layer + a rasterised version of frames/notes. Lightweight
      // fallback: just dump the InfiniteCanvas as-is. Anything fancier
      // (full-world export) belongs in a follow-up.
      try {
        const url = this.canvas?.toDataURL?.() || this.canvasHost.querySelector('canvas')?.toDataURL?.('image/png');
        if (!url) { alert('Export not supported in this build.'); return; }
        const a = document.createElement('a');
        a.href = url;
        a.download = `whiteboard-${this.whiteboardId.slice(0, 8)}.png`;
        document.body.appendChild(a); a.click(); a.remove();
      } catch (err) { console.warn('[wbv] export failed', err); }
    }

    updateEditors(editors) {
      // editors: array of { user_id, name, color } — caller passes in
      // the presence roster for this whiteboard's channel.
      this.editorsEl.innerHTML = '';
      const max = 4;
      const list = (editors || []).slice(0, max);
      for (const e of list) {
        const a = h('span', { class: 'wbv-editor-avatar', attrs: { title: e.name || 'Editor' } });
        a.textContent = initialsFor(e.name || '?').slice(0, 2);
        const hue = hashHue(e.user_id || e.name || '');
        a.style.background = `oklch(0.62 0.14 ${hue})`;
        this.editorsEl.appendChild(a);
      }
      const total = editors?.length || 0;
      this.editorCountEl.textContent = total ? `${total} editing` : '';
    }

    // ────────────────────────────────────────────────────────────
    // Lifecycle
    // ────────────────────────────────────────────────────────────
    async destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      // Flush + await any pending note-text saves.
      const pending = [];
      for (const [id, t] of this._noteSaveTimers) {
        clearTimeout(t);
        const entry = this.notes.get(id);
        if (entry) pending.push(this.huddle.updateWhiteboardNote(id, { text: entry.data.text }).catch(() => {}));
      }
      this._noteSaveTimers.clear();
      if (pending.length) await Promise.allSettled(pending);
      if (this._cursorGcTimer) { clearInterval(this._cursorGcTimer); this._cursorGcTimer = null; }
      document.removeEventListener('keydown', this._docKeyHandler);
      try { this.canvas?.destroy(); } catch {}
      this.huddle.closeWhiteboardChannel(this.whiteboardId);
      this.root.remove();
      this.notes.clear();
      this.frames.clear();
      this.cursors.clear();
    }
  }

  window.WhiteboardView = WhiteboardView;
})();
