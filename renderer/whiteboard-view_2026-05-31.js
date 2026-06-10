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
    butter:    { bg: '#f0cf78', tx: '#3c2e08', fold: '#dcb95f', dot: '#e7c25f' },
    rose:      { bg: '#eea7ba', tx: '#421421', fold: '#dd93a7', dot: '#e58fa6' },
    sky:       { bg: '#a3cbef', tx: '#10283f', fold: '#8db8de', dot: '#86bbe6' },
    mint:      { bg: '#9ed7b3', tx: '#0d2c1c', fold: '#89c6a0', dot: '#81cd9c' },
    lilac:     { bg: '#c2b2ee', tx: '#251a45', fold: '#ad9ce0', dot: '#b3a2ec' },
    coral:     { bg: '#f0a3a3', tx: '#421616', fold: '#de9090', dot: '#e88f8f' },
    tangerine: { bg: '#f4c489', tx: '#3f2708', fold: '#e2b075', dot: '#ecb06f' },
    teal:      { bg: '#93d4d0', tx: '#0c2e2c', fold: '#7fc4c0', dot: '#79ccc7' },
    grape:     { bg: '#d3a7e0', tx: '#2e1640', fold: '#c194d0', dot: '#c894d8' },
    slate:     { bg: '#b4c0cc', tx: '#18222c', fold: '#a0aebb', dot: '#9fb0bf' },
  };
  const STICKY_ORDER = ['butter', 'rose', 'sky', 'mint', 'lilac', 'coral', 'tangerine', 'teal', 'grape', 'slate'];
  const NOTE_W = 154;
  const NOTE_H = 134;
  const TEXT_W = 220;
  const TEXT_H = 44;
  // Sentinel slug stored in `color_key` so text blocks ride the existing
  // whiteboard_notes table without a schema change. Anything not in
  // STICKY_ORDER renders as plain text.
  const TEXT_KIND = '_text';
  // Sentinel color_key for an arbitrary (picker-chosen) sticky colour; the
  // actual hex rides in the note's `color` field.
  const CUSTOM_KIND = '_custom';

  // ── Colour helpers (custom sticky colours) ──
  const isHex = (s) => typeof s === 'string' && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(s.trim());
  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(v, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const clamp8 = (n) => Math.max(0, Math.min(255, Math.round(n)));
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((x) => clamp8(x).toString(16).padStart(2, '0')).join('');
  }
  function readableText(hex) {
    const { r, g, b } = hexToRgb(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#1a1a1a' : '#ffffff';
  }
  function shadeHex(hex, f) {
    const { r, g, b } = hexToRgb(hex);
    return rgbToHex(r + f * 255, g + f * 255, b + f * 255);
  }
  // Resolve a note's swatch palette from either a named slug or a custom hex.
  function notePalette(colorKey, colorHex) {
    if (STICKY[colorKey]) return STICKY[colorKey];
    const bg = isHex(colorHex) ? (colorHex[0] === '#' ? colorHex : '#' + colorHex) : STICKY.butter.bg;
    return { bg, tx: readableText(bg), fold: shadeHex(bg, -0.1), dot: bg };
  }

  const FRAME_TINTS = {
    // Original four keys kept so existing frames keep their colour.
    accent: 'var(--accent)',
    live:   'var(--live, #2ec4b6)',
    online: 'var(--online, #34c759)',
    away:   'var(--away, #f5a524)',
    // Extra colours for a fuller FigJam-like palette.
    yellow: '#f5c542',
    red:    '#ff5a5f',
    purple: '#a06bff',
    pink:   '#ff6bd6',
    gray:   '#9aa0a6',
  };

  // URL auto-linking for note/text display. Escapes HTML, then wraps bare
  // http(s) URLs in an accent-coloured anchor. Newlines survive as-is (the
  // note text uses white-space: pre-wrap), so we don't convert them.
  const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,;:!?)\]}'"])/g;
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function linkifyHtml(text) {
    const src = String(text || '');
    let out = '', last = 0;
    src.replace(URL_RE, (url, _g1, idx) => {
      out += escapeHtml(src.slice(last, idx));
      const safe = escapeHtml(url);
      out += `<a class="wbv-link" data-url="${safe}" href="${safe}">${safe}</a>`;
      last = idx + url.length;
      return url;
    });
    out += escapeHtml(src.slice(last));
    return out;
  }

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
      // Per-view UUID so two windows of the same user (main + popout)
      // can tell each other's broadcasts apart. peerId alone is the
      // auth user id, identical across windows; filtering on peerId
      // would silently drop legitimate cross-window updates. Every
      // self-filter check below compares the inbound payload's `from`
      // against this viewId, never against peerId.
      this.viewId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${this.huddle.peerId}-${Math.random().toString(36).slice(2)}`;

      this.tool = 'cursor';     // default to select/cursor, like FigJam
      this.drawColor = 'var(--accent)';
      this.stickyColor = 'butter';

      this.notes = new Map();   // id -> { data, el, textarea, handle, ... }
      this.frames = new Map();  // id -> { data, el, titleEl, ... }
      this.cursors = new Map(); // peerId -> { data, el }
      this.editingNote = null;
      this.selectedNote = null;
      this.selectedFrame = null;
      this._undoStack = [];     // inverse-action closures for Cmd/Ctrl+Z
      this._undoing = false;    // true while an undo runs (suppresses re-push)
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
      const titleEl = h('span', { class: 'wbv-title', text: this.boardTitle, attrs: { spellcheck: 'false' } });
      titleEl.title = 'Click to rename the board';
      titleEl.addEventListener('click', () => this._beginRenameBoard());
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

      // Frame creation now lives in the left tool palette (FigJam-style),
      // not the header — see _buildToolPalette.

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

      // Frame creation lives in the palette (FigJam-style) as a one-shot
      // action rather than a persistent tool mode.
      const frameBtn = h('button', { class: 'wbv-tool', attrs: { title: 'Add a frame', 'aria-label': 'Add a frame' } });
      frameBtn.appendChild(iconEl('frame', 18));
      frameBtn.addEventListener('click', () => this._addFrameAtViewportCenter());
      palette.appendChild(frameBtn);

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
      const isSticky = this.tool === 'sticky';
      const trigger = h('button', { class: 'wbv-toolbar-color wbv-palette-color', attrs: { title: 'Color', 'aria-label': 'Color' } });
      const dot = h('span', { class: 'wbv-toolbar-color-dot' });
      dot.style.background = isSticky ? (STICKY[this.stickyColor]?.dot || this.stickyColor) : resolveColor(this.drawColor);
      trigger.appendChild(dot);
      trigger.appendChild(h('span', { class: 'wbv-toolbar-color-caret' }));
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isSticky) {
          this._openColorPopover(trigger, {
            current: this.stickyColor,
            items: STICKY_ORDER.map((k) => ({ key: k, color: STICKY[k].dot })),
            onPick: (k) => { this.stickyColor = k; dot.style.background = STICKY[k].dot; this._refreshHintSwatch(); },
          });
        } else {
          const inks = [
            { key: 'var(--accent)', color: 'var(--accent)' },
            { key: 'var(--live, #2ec4b6)', color: 'var(--live, #2ec4b6)' },
            { key: 'var(--online, #34c759)', color: 'var(--online, #34c759)' },
            { key: 'var(--away, #f5a524)', color: 'var(--away, #f5a524)' },
            { key: '#ffffff', color: '#ffffff' },
            { key: '#1a1a1a', color: '#1a1a1a' },
          ];
          this._openColorPopover(trigger, {
            current: this.drawColor,
            items: inks,
            onPick: (c) => { this.drawColor = c; this.canvas.setColor(resolveColor(c)); dot.style.background = resolveColor(c); },
            onCustom: (hex) => { this.drawColor = hex; this.canvas.setColor(resolveColor(hex)); dot.style.background = hex; },
          });
        }
      });
      this.swatchWrap.appendChild(trigger);
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
        : (STICKY[row.color_key]
            ? row.color_key
            : (isHex(row.color) ? CUSTOM_KIND : (this._slugFromHex(row.color) || 'butter')));
      return {
        id: row.id,
        x: row.x, y: row.y, w: row.w || NOTE_W, h: row.h || NOTE_H,
        text: row.text || '',
        color_key: slug,
        color: row.color,
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

    // Pop + run the most recent inverse action (strokes, notes, frames —
    // create/delete/move/resize/color all push one). The _undoing guard
    // stops an undo action from pushing its own inverse back onto the stack.
    undo() {
      const fn = this._undoStack.pop();
      if (!fn) return;
      this._undoing = true;
      try { fn(); } catch (err) { console.warn('[wbv] undo failed', err); }
      finally { this._undoing = false; }
    }
    _pushUndo(fn) {
      if (this._undoing) return;
      this._undoStack.push(fn);
      if (this._undoStack.length > 100) this._undoStack.shift();
    }
    // Undo helpers — restore geometry / recreate deleted objects.
    _applyNoteGeom(id, geom) {
      const entry = this.notes.get(id);
      if (!entry) return;
      Object.assign(entry.data, geom);
      this._positionNote(entry);
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'update', note: { id, ...geom } }, this.viewId);
      this.huddle.updateWhiteboardNote(id, geom).catch((e) => console.warn('[wbv] undo note geom failed', e));
    }
    _applyFrameGeom(id, geom) {
      const entry = this.frames.get(id);
      if (!entry) return;
      Object.assign(entry.data, geom);
      this._positionFrame(entry);
      this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'update', frame: { id, ...geom } }, this.viewId);
      this.huddle.updateWhiteboardFrame(id, geom).catch((e) => console.warn('[wbv] undo frame geom failed', e));
    }
    _recreateNoteFromData(data) {
      this._renderNote({ ...data });
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'create', note: data }, this.viewId);
      const persist = (data.color_key === TEXT_KIND)
        ? { id: data.id, x: data.x, y: data.y, w: data.w, h: data.h, text: data.text || '', color_key: TEXT_KIND }
        : { id: data.id, x: data.x, y: data.y, w: data.w, h: data.h, text: data.text || '', color: (STICKY[data.color_key]?.bg) || data.color, color_key: data.color_key };
      this.huddle.createWhiteboardNote(this.whiteboardId, persist).catch((e) => console.warn('[wbv] undo recreate note failed', e));
    }
    _recreateFrameFromData(data) {
      this._renderFrame({ ...data });
      this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'create', frame: data }, this.viewId);
      this.huddle.createWhiteboardFrame(this.whiteboardId, { ...data }).catch((e) => console.warn('[wbv] undo recreate frame failed', e));
    }

    async clearAll() {
      if (!confirm('Clear the whiteboard for everyone? This cannot be undone.')) return;
      this.canvas?.clearAll();
      this.huddle.sendWhiteboardStroke(this.whiteboardId, { action: 'clear' }, this.viewId);
      for (const id of [...this.notes.keys()]) {
        this._removeNoteEl(id);
        this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'delete', id }, this.viewId);
      }
      for (const id of [...this.frames.keys()]) {
        this._removeFrameEl(id);
        this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'delete', id }, this.viewId);
        try { await this.huddle.deleteWhiteboardFrame(id); } catch {}
      }
      try { await this.huddle.clearWhiteboard(this.whiteboardId); }
      catch (err) { console.warn('[wbv] clear failed', err); }
    }

    _broadcastStroke(stroke) {
      this.huddle.sendWhiteboardStroke(this.whiteboardId, stroke, this.viewId);
    }

    _persistFinishedStroke(polyline) {
      if (!polyline?.uuid) return;
      this._paintedStrokeUuids.add(polyline.uuid);
      const uuid = polyline.uuid;
      this._pushUndo(() => {
        this.canvas?.removeStroke(uuid);
        this._paintedStrokeUuids.add(uuid);
        this.huddle.sendWhiteboardStroke(this.whiteboardId, { action: 'delete-stroke', uuid }, this.viewId);
        this.huddle.deleteWhiteboardStrokeByUuid(this.whiteboardId, uuid)
          .catch((e) => console.warn('[wbv] undo stroke delete failed', e));
      });
      this.huddle.persistWhiteboardStroke(this.whiteboardId, polyline)
        .catch((err) => console.warn('[wbv] persist failed', err));
    }

    _eraseStroke(uuid) {
      if (!uuid) return;
      this._paintedStrokeUuids.add(uuid);
      this.huddle.sendWhiteboardStroke(this.whiteboardId, { action: 'delete-stroke', uuid }, this.viewId);
      this.huddle.deleteWhiteboardStrokeByUuid(this.whiteboardId, uuid)
        .catch((err) => console.warn('[wbv] erase persist failed', err));
    }

    _moveStroke(uuid, polyline) {
      this.huddle.deleteWhiteboardStrokeByUuid(this.whiteboardId, uuid)
        .then(() => this.huddle.persistWhiteboardStroke(this.whiteboardId, polyline))
        .catch((err) => console.warn('[wbv] move persist failed', err));
    }

    _onRemoteStroke(payload) {
      if (payload.from === this.viewId) return;
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
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'create', note }, this.viewId);
      this._pushUndo(() => this._deleteNote(id));
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
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'create', note }, this.viewId);
      this._pushUndo(() => this._deleteNote(id));
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
      const palette = notePalette(note.color_key, note.color);
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
      // Single colour dot → popover palette (FigJam-style).
      const colorBtn = h('button', { class: 'wbv-toolbar-color', attrs: { title: 'Color', 'aria-label': 'Color' } });
      const colorDot = h('span', { class: 'wbv-toolbar-color-dot' });
      colorDot.style.background = notePalette(note.color_key, note.color).dot;
      colorBtn.appendChild(colorDot);
      colorBtn.appendChild(h('span', { class: 'wbv-toolbar-color-caret' }));
      colorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = this.notes.get(note.id);
        this._openColorPopover(colorBtn, {
          current: cur?.data?.color_key,
          items: STICKY_ORDER.map((k) => ({ key: k, color: STICKY[k].dot })),
          onPick: (k) => { this._setNoteColor(note.id, k); colorDot.style.background = STICKY[k].dot; },
          onCustom: (hex) => { this._setNoteColorCustom(note.id, hex); colorDot.style.background = hex; },
        });
      });
      toolbar.appendChild(colorBtn);
      toolbar.appendChild(h('span', { class: 'wbv-note-toolbar-sep' }));
      const del = h('button', { class: 'wbv-note-toolbar-del', attrs: { title: 'Delete note' } });
      del.appendChild(iconEl('trash', 14));
      del.addEventListener('click', (e) => { e.stopPropagation(); this._deleteNote(note.id); });
      toolbar.appendChild(del);
      el.appendChild(toolbar);

      // 4 corner resize handles. Stickies stay roughly card-shaped so
      // edge handles read as overkill; corners cover the common cases
      // (pull NW/SE to scale, NE/SW to skew). The handles ride on the
      // OUTER unrotated wrapper so the rotation transform on the card
      // doesn't warp the pointer math — drag delta in screen coords
      // ÷ viewport scale lands directly in world units.
      for (const dir of ['nw', 'ne', 'se', 'sw']) {
        const handle = h('span', {
          class: `wbv-resize-handle is-${dir} wbv-resize-corner`,
          attrs: { 'data-handle': dir, 'aria-hidden': 'true' },
        });
        el.appendChild(handle);
      }

      this.worldLayer.appendChild(el);

      const entry = { data: { ...note }, el, textEl: text, voteEl: vote, voteCountEl: voteCount, authorNameEl: authorName, avatarEl: avatar };
      this.notes.set(note.id, entry);
      this._wireNoteHandlers(entry);
      this._positionNote(entry);
      this._refreshVoteStyle(entry);
      this._resolveAuthor(entry);
      this._renderNoteTextDisplay(entry);
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
        this._renderNoteTextDisplay(entry);
      }
      if (patch.color_key != null || patch.color != null) {
        const p = notePalette(entry.data.color_key, entry.data.color);
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
      // Single east-edge handle — height for text always follows
      // content, so resizing here means "set the wrap width." Pulling
      // it left tightens the wrap; right loosens / lets it stay one
      // line.
      const handle = h('span', {
        class: 'wbv-resize-handle is-e wbv-resize-edge',
        attrs: { 'data-handle': 'e', 'aria-hidden': 'true' },
      });
      el.appendChild(handle);
      this.worldLayer.appendChild(el);
      const entry = { data: { ...note }, el, textEl: text, kind: 'text' };
      this.notes.set(note.id, entry);
      this._wireNoteHandlers(entry); // same drag handlers; text edits below
      this._positionNote(entry);
      this._renderNoteTextDisplay(entry);
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
        // Text blocks have a fixed wrap-width (data.w in world units)
        // and grow vertically with content. The zoom is applied via
        // CSS transform on the outer element so font / spacing scale
        // visually; the inner contenteditable wraps at 100% of the
        // parent's width.
        el.style.width = (data.w || TEXT_W) + 'px';
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
        // Text auto-resizes with the note: a bigger sticky gets bigger text
        // (FigJam-like), scaled off its width vs the default and the zoom.
        const fontPx = Math.max(11, Math.min(30, 13 * (data.w / NOTE_W))) * vp.scale;
        el.style.setProperty('--wbv-note-font', fontPx.toFixed(1) + 'px');
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
      // Open auto-linked URLs in the system browser; don't let the click
      // bubble up to select/drag the note.
      textEl.addEventListener('click', (e) => {
        const a = e.target.closest('a.wbv-link');
        if (!a || this.editingNote === data.id) return;
        e.preventDefault();
        e.stopPropagation();
        if (a.dataset.url) window.open(a.dataset.url, '_blank', 'noopener');
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
        // (color swatches / delete), the vote pill, or a resize
        // handle — those have their own handlers and a tiny pointer
        // drift would otherwise burn a spurious "moved" persist.
        if (e.target.closest('.wbv-note-toolbar, .wbv-note-vote, .wbv-resize-handle, a.wbv-link')) return;
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
            const px = start.origX, py = start.origY;
            this._pushUndo(() => this._applyNoteGeom(data.id, { x: px, y: py }));
            this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'update', note: { id: data.id, x: data.x, y: data.y } }, this.viewId);
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
        this._maybeAutoBullet(textEl);
        data.text = textEl.innerText.trim();
        this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'update', note: { id: data.id, text: data.text } }, this.viewId);
        clearTimeout(this._noteSaveTimers.get(data.id));
        const t = setTimeout(() => {
          this.huddle.updateWhiteboardNote(data.id, { text: data.text })
            .catch((err) => console.warn('[wbv] note text save failed', err));
        }, 500);
        this._noteSaveTimers.set(data.id, t);
      });
      textEl.addEventListener('blur', () => this._endEditNote(data.id));
      textEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); this._endEditNote(data.id); return; }
        if (e.key === 'Enter' && !e.shiftKey) this._maybeContinueBullet(textEl, e);
      });

      // Wire any resize handles the renderer attached (stickies have 4
      // corners, text blocks have an east edge, plain notes have none).
      this._wireNoteResizeHandles(entry);
    }

    // Resize handles for sticky notes + text blocks. Lives next to the
    // frame resize logic conceptually but separated so we can clamp to
    // kind-appropriate floors (stickies hold a 100×100 minimum; text
    // blocks just hold a wrap-width floor — height is content-driven).
    _wireNoteResizeHandles(entry) {
      const { el, data } = entry;
      const isText = entry.kind === 'text';
      const MIN_W = isText ? 80 : 100;
      const MIN_H = isText ? 0 : 100; // text height is always content-driven

      el.querySelectorAll('.wbv-resize-handle').forEach((handle) => {
        handle.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          if (this.editingNote === data.id) return; // never resize while typing
          const dir = handle.dataset.handle; // 'nw' | 'ne' | 'se' | 'sw' | 'e' | …
          const vp = this.canvas?.getViewport() || { scale: 1 };
          const start = {
            clientX: e.clientX, clientY: e.clientY, scale: vp.scale,
            x: data.x, y: data.y, w: data.w, h: data.h,
          };
          handle.setPointerCapture?.(e.pointerId);
          const onMove = (ev) => {
            const dx = (ev.clientX - start.clientX) / start.scale;
            const dy = (ev.clientY - start.clientY) / start.scale;
            let { x, y, w, h } = start;
            if (dir.includes('w')) { x = start.x + dx; w = start.w - dx; }
            if (dir.includes('e')) { w = start.w + dx; }
            if (!isText && dir.includes('n')) { y = start.y + dy; h = start.h - dy; }
            if (!isText && dir.includes('s')) { h = start.h + dy; }
            if (w < MIN_W) {
              if (dir.includes('w')) x = start.x + (start.w - MIN_W);
              w = MIN_W;
            }
            if (!isText && h < MIN_H) {
              if (dir.includes('n')) y = start.y + (start.h - MIN_H);
              h = MIN_H;
            }
            data.x = x; data.y = y; data.w = w; data.h = h;
            this._positionNote(entry);
            this._scheduleMinimapRender();
          };
          const onUp = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            if (start.x !== data.x || start.y !== data.y || start.w !== data.w || start.h !== data.h) {
              const g = { x: start.x, y: start.y, w: start.w, h: start.h };
              this._pushUndo(() => this._applyNoteGeom(data.id, g));
            }
            const patch = { id: data.id, x: data.x, y: data.y, w: data.w, h: data.h };
            this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'update', note: patch }, this.viewId);
            this.huddle.updateWhiteboardNote(data.id, { x: data.x, y: data.y, w: data.w, h: data.h })
              .catch((err) => console.warn('[wbv] note resize persist failed', err));
          };
          handle.addEventListener('pointermove', onMove);
          handle.addEventListener('pointerup', onUp);
          handle.addEventListener('pointercancel', onUp);
        });
      });
    }

    _selectNote(id) {
      if (id && this.selectedFrame) this._selectFrame(null);
      if (this.selectedNote === id) return;
      const prev = this.selectedNote && this.notes.get(this.selectedNote);
      if (prev) prev.el.classList.remove('is-selected');
      this.selectedNote = id;
      const next = id && this.notes.get(id);
      if (next) next.el.classList.add('is-selected');
    }

    // Frame selection — mutually exclusive with note selection. Drives the
    // .is-selected ring + solid resize handles in CSS.
    _selectFrame(id) {
      if (this.selectedFrame === id) return;
      const prev = this.selectedFrame && this.frames.get(this.selectedFrame);
      if (prev) prev.el.classList.remove('is-selected');
      this.selectedFrame = id;
      const next = id && this.frames.get(id);
      if (next) next.el.classList.add('is-selected');
      if (id) this._selectNote(null);
    }

    // Render a note's text either as plain text (while editing, so the
    // caret + typing behave) or with clickable accent links (when idle).
    _renderNoteTextDisplay(entry) {
      if (!entry?.textEl) return;
      const txt = entry.data.text || '';
      if (this.editingNote === entry.data.id) entry.textEl.textContent = txt;
      else entry.textEl.innerHTML = linkifyHtml(txt);
    }

    // Plain text from the start of the contenteditable up to the caret,
    // sliced to the current line — used for auto-bullet detection.
    _caretLinePrefix(el) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return '';
      const r = sel.getRangeAt(0).cloneRange();
      r.setStart(el, 0);
      const text = r.toString();
      return text.slice(text.lastIndexOf('\n') + 1);
    }
    // Typing "- " or "* " at the start of a line becomes a "• " bullet.
    _maybeAutoBullet(el) {
      if (/^[-*]\s$/.test(this._caretLinePrefix(el))) {
        document.execCommand('delete');
        document.execCommand('delete');
        document.execCommand('insertText', false, '• ');
      }
    }
    // Enter on a bullet line continues the list; Enter on an empty bullet
    // exits it.
    _maybeContinueBullet(el, e) {
      const m = this._caretLinePrefix(el).match(/^([•\-*])\s+(.*)$/);
      if (!m) return;
      e.preventDefault();
      if (!m[2].trim()) {
        document.execCommand('delete');
        document.execCommand('delete');
        document.execCommand('insertText', false, '\n');
      } else {
        document.execCommand('insertText', false, '\n• ');
      }
    }

    _beginEditNote(id) {
      const entry = this.notes.get(id);
      if (!entry) return;
      this.editingNote = id;
      entry.el.classList.add('is-editing');
      entry.textEl.setAttribute('contenteditable', 'true');
      // Swap any link markup back to plain text so the caret + typing behave.
      entry.textEl.textContent = entry.data.text || '';
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
        entry.data.text = text;
        this._renderNoteTextDisplay(entry); // re-linkify now that we're idle
        this.huddle.updateWhiteboardNote(id, { text })
          .catch((err) => console.warn('[wbv] final note text save failed', err));
      }
    }

    _setNoteColor(id, slug) {
      if (!STICKY[slug]) return;
      const entry = this.notes.get(id);
      if (!entry) return;
      const prevSlug = entry.data.color_key, prevColor = entry.data.color;
      if (prevSlug !== slug) this._pushUndo(() => {
        if (STICKY[prevSlug]) this._setNoteColor(id, prevSlug);
        else this._setNoteColorCustom(id, prevColor);
      });
      entry.data.color_key = slug;
      const p = STICKY[slug];
      entry.el.style.setProperty('--wbv-note-bg', p.bg);
      entry.el.style.setProperty('--wbv-note-tx', p.tx);
      entry.el.style.setProperty('--wbv-note-fold', p.fold);
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'update', note: { id, color_key: slug } }, this.viewId);
      this.huddle.updateWhiteboardNote(id, { color_key: slug, color: p.bg })
        .catch((err) => console.warn('[wbv] color save failed', err));
    }

    // Arbitrary picker-chosen sticky colour. Stored as color_key='_custom'
    // + a hex in `color`; text colour is derived for contrast.
    _setNoteColorCustom(id, hex) {
      const entry = this.notes.get(id);
      if (!entry || entry.kind === 'text' || !isHex(hex)) return;
      const norm = hex[0] === '#' ? hex : '#' + hex;
      const prevKey = entry.data.color_key, prevColor = entry.data.color;
      if (prevKey !== CUSTOM_KIND || prevColor !== norm) {
        this._pushUndo(() => {
          if (STICKY[prevKey]) this._setNoteColor(id, prevKey);
          else this._setNoteColorCustom(id, prevColor);
        });
      }
      entry.data.color_key = CUSTOM_KIND;
      entry.data.color = norm;
      const p = notePalette(CUSTOM_KIND, norm);
      entry.el.style.setProperty('--wbv-note-bg', p.bg);
      entry.el.style.setProperty('--wbv-note-tx', p.tx);
      entry.el.style.setProperty('--wbv-note-fold', p.fold);
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'update', note: { id, color_key: CUSTOM_KIND, color: norm } }, this.viewId);
      this.huddle.updateWhiteboardNote(id, { color_key: CUSTOM_KIND, color: norm })
        .catch((e) => console.warn('[wbv] custom color save failed', e));
    }

    // FigJam-style colour popover: a single dot in the contextual toolbar
    // opens this grid of swatches (+ optional custom picker). Anchored to
    // the trigger, dismissed on outside-click / Escape.
    _openColorPopover(anchorEl, opts) {
      this._closeColorPopover();
      const pop = h('div', { class: 'wbv-color-pop' });
      const grid = h('div', { class: 'wbv-color-pop-grid' });
      for (const it of opts.items) {
        const b = h('button', {
          class: 'wbv-color-pop-sw' + (it.key === opts.current ? ' is-on' : ''),
          style: { background: it.color },
          attrs: { title: it.key, 'aria-label': it.key },
        });
        b.addEventListener('click', (e) => { e.stopPropagation(); opts.onPick(it.key); this._closeColorPopover(); });
        grid.appendChild(b);
      }
      pop.appendChild(grid);
      if (opts.onCustom) {
        const cw = h('button', { class: 'wbv-color-pop-custom', attrs: { title: 'Custom color' } });
        const ci = h('input', { attrs: { type: 'color' } });
        cw.appendChild(ci);
        cw.appendChild(h('span', { class: 'wbv-color-pop-custom-rainbow' }));
        cw.appendChild(h('span', { text: 'Custom' }));
        cw.addEventListener('click', (e) => { e.stopPropagation(); ci.click(); });
        ci.addEventListener('input', (e) => { e.stopPropagation(); opts.onCustom(e.target.value); });
        ci.addEventListener('change', () => this._closeColorPopover());
        pop.appendChild(cw);
      }
      document.body.appendChild(pop);
      const r = anchorEl.getBoundingClientRect();
      pop.style.left = Math.round(r.left) + 'px';
      pop.style.top = Math.round(r.bottom + 8) + 'px';
      const pr = pop.getBoundingClientRect();
      if (pr.right > window.innerWidth - 8) pop.style.left = Math.max(8, window.innerWidth - 8 - pr.width) + 'px';
      if (pr.bottom > window.innerHeight - 8) pop.style.top = Math.max(8, Math.round(r.top - pr.height - 8)) + 'px';
      this._colorPop = pop;
      const onDoc = (e) => { if (!pop.contains(e.target) && !anchorEl.contains(e.target)) this._closeColorPopover(); };
      const onKey = (e) => { if (e.key === 'Escape') this._closeColorPopover(); };
      setTimeout(() => {
        document.addEventListener('pointerdown', onDoc, true);
        document.addEventListener('keydown', onKey, true);
      }, 0);
      this._colorPopCleanup = () => {
        document.removeEventListener('pointerdown', onDoc, true);
        document.removeEventListener('keydown', onKey, true);
      };
    }
    _closeColorPopover() {
      if (this._colorPopCleanup) { this._colorPopCleanup(); this._colorPopCleanup = null; }
      if (this._colorPop) { this._colorPop.remove(); this._colorPop = null; }
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
      const entry = this.notes.get(id);
      const snap = entry ? { ...entry.data } : null;
      this._removeNoteEl(id);
      this.huddle.sendWhiteboardNote(this.whiteboardId, { action: 'delete', id }, this.viewId);
      if (snap) this._pushUndo(() => this._recreateNoteFromData(snap));
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
      this.huddle.sendWhiteboardVote(this.whiteboardId, { id, votes: entry.data.votes, mine: entry.data.mine }, this.viewId);
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
      if (payload.from === this.viewId) return;
      if (payload.action === 'create' && payload.note) this._renderNote(this._normalizeNote(payload.note));
      else if (payload.action === 'update' && payload.note) this._applyNotePatch(this._normalizeNote(payload.note));
      else if (payload.action === 'delete' && payload.id) this._removeNoteEl(payload.id);
    }

    _onRemoteVote(payload) {
      if (payload.from === this.viewId) return;
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
      this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'create', frame }, this.viewId);
      this._pushUndo(() => this._deleteFrame(frame.id));
      try { await this.huddle.createWhiteboardFrame(this.whiteboardId, frame); }
      catch (err) { console.warn('[wbv] frame create failed', err); }
    }

    _renderFrame(frame, { editTitle = false } = {}) {
      if (this.frames.has(frame.id)) { this._applyFramePatch(frame); return; }
      const tintVar = FRAME_TINTS[frame.tint] || (isHex(frame.tint) ? frame.tint : FRAME_TINTS.accent);
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

      // Frame colour — a single dot opens the popover palette, like notes.
      const ftoolbar = h('div', { class: 'wbv-frame-toolbar' });
      const fColorBtn = h('button', { class: 'wbv-toolbar-color', attrs: { title: 'Color', 'aria-label': 'Color' } });
      const fDot = h('span', { class: 'wbv-toolbar-color-dot' });
      fDot.style.background = FRAME_TINTS[frame.tint] || (isHex(frame.tint) ? frame.tint : FRAME_TINTS.accent);
      fColorBtn.appendChild(fDot);
      fColorBtn.appendChild(h('span', { class: 'wbv-toolbar-color-caret' }));
      fColorBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this._selectFrame(frame.id);
        const cur = this.frames.get(frame.id);
        this._openColorPopover(fColorBtn, {
          current: cur?.data?.tint,
          items: Object.keys(FRAME_TINTS).map((k) => ({ key: k, color: FRAME_TINTS[k] })),
          onPick: (k) => { this._setFrameTint(frame.id, k); fDot.style.background = FRAME_TINTS[k]; },
          onCustom: (hex) => { this._setFrameTint(frame.id, hex); fDot.style.background = hex; },
        });
      });
      ftoolbar.appendChild(fColorBtn);
      el.appendChild(ftoolbar);

      // 8 resize handles (4 corners + 4 edges). Drag a corner to scale
      // both dimensions, an edge to scale one. The frame body itself
      // stays click-through (pointer-events:none in CSS) so drawing
      // inside a frame still works — only the chip + handles capture.
      const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
      for (const dir of HANDLES) {
        const handle = h('span', { class: `wbv-frame-handle is-${dir}`, attrs: { 'data-handle': dir, 'aria-hidden': 'true' } });
        el.appendChild(handle);
      }

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
      const MIN_W = 80, MIN_H = 60; // world units

      // Drag the title chip to move the whole frame.
      chipEl.addEventListener('pointerdown', (e) => {
        // Clicking the title is for renaming, never dragging.
        if (e.target === titleEl) return;
        if (e.target.closest('.wbv-frame-del')) return;
        this._selectFrame(data.id);
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
          if (start.origX !== data.x || start.origY !== data.y) {
            const px = start.origX, py = start.origY;
            this._pushUndo(() => this._applyFrameGeom(data.id, { x: px, y: py }));
          }
          this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'update', frame: { id: data.id, x: data.x, y: data.y } }, this.viewId);
          this.huddle.updateWhiteboardFrame(data.id, { x: data.x, y: data.y })
            .catch((err) => console.warn('[wbv] frame move persist failed', err));
        };
        chipEl.addEventListener('pointermove', onMove);
        chipEl.addEventListener('pointerup', onUp);
        chipEl.addEventListener('pointercancel', onUp);
      });

      // Resize via the 8 edge / corner handles. Each handle's `data-handle`
      // attribute encodes which sides (n/s/e/w) it mutates. Anchoring
      // the OPPOSITE corner means dragging "ne" moves top + right while
      // keeping bottom-left fixed; "s" moves only the bottom edge; etc.
      el.querySelectorAll('.wbv-frame-handle').forEach((handle) => {
        handle.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const dir = handle.dataset.handle; // 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
          const vp = this.canvas?.getViewport() || { scale: 1 };
          const start = {
            clientX: e.clientX, clientY: e.clientY, scale: vp.scale,
            x: data.x, y: data.y, w: data.w, h: data.h,
          };
          handle.setPointerCapture?.(e.pointerId);
          const onMove = (ev) => {
            const dx = (ev.clientX - start.clientX) / start.scale;
            const dy = (ev.clientY - start.clientY) / start.scale;
            let { x, y, w, h } = start;
            // West/east mutate x + w (west keeps the right edge fixed,
            // so x shifts in by dx and w shrinks by the same; east just
            // grows w).
            if (dir.includes('w')) { x = start.x + dx; w = start.w - dx; }
            if (dir.includes('e')) { w = start.w + dx; }
            if (dir.includes('n')) { y = start.y + dy; h = start.h - dy; }
            if (dir.includes('s')) { h = start.h + dy; }
            // Clamp to a floor so the frame can't collapse below its
            // chip. When clamped on the "west" / "north" side, the
            // origin (x or y) has to recompute against the fixed right
            // / bottom edge so the frame doesn't drift.
            if (w < MIN_W) {
              if (dir.includes('w')) x = start.x + (start.w - MIN_W);
              w = MIN_W;
            }
            if (h < MIN_H) {
              if (dir.includes('n')) y = start.y + (start.h - MIN_H);
              h = MIN_H;
            }
            data.x = x; data.y = y; data.w = w; data.h = h;
            this._positionFrame(entry);
            this._scheduleMinimapRender();
          };
          const onUp = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            if (start.x !== data.x || start.y !== data.y || start.w !== data.w || start.h !== data.h) {
              const g = { x: start.x, y: start.y, w: start.w, h: start.h };
              this._pushUndo(() => this._applyFrameGeom(data.id, g));
            }
            const patch = { id: data.id, x: data.x, y: data.y, w: data.w, h: data.h };
            this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'update', frame: patch }, this.viewId);
            this.huddle.updateWhiteboardFrame(data.id, { x: data.x, y: data.y, w: data.w, h: data.h })
              .catch((err) => console.warn('[wbv] frame resize persist failed', err));
          };
          handle.addEventListener('pointermove', onMove);
          handle.addEventListener('pointerup', onUp);
          handle.addEventListener('pointercancel', onUp);
        });
      });

      // Click the title to rename it at any time (single click); the frame
      // gets selected too. Drag-to-move lives on the rest of the chip.
      const beginTitleEdit = () => {
        this._selectFrame(data.id);
        if (titleEl.getAttribute('contenteditable') === 'true') return;
        titleEl.setAttribute('contenteditable', 'true');
        titleEl.focus();
        const r = document.createRange(); r.selectNodeContents(titleEl);
        const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      };
      titleEl.addEventListener('click', (e) => { e.stopPropagation(); beginTitleEdit(); });
      titleEl.addEventListener('blur', () => {
        titleEl.setAttribute('contenteditable', 'false');
        const newTitle = titleEl.textContent.trim() || 'Untitled frame';
        if (newTitle !== data.title) {
          data.title = newTitle;
          titleEl.textContent = newTitle;
          this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'update', frame: { id: data.id, title: newTitle } }, this.viewId);
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
      if (patch.tint) entry.el.style.setProperty('--wbv-frame-tint', FRAME_TINTS[patch.tint] || (isHex(patch.tint) ? patch.tint : FRAME_TINTS.accent));
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

    _setFrameTint(id, tint) {
      const entry = this.frames.get(id);
      if (!entry || (!FRAME_TINTS[tint] && !isHex(tint))) return;
      const prevTint = entry.data.tint;
      if (prevTint !== tint) this._pushUndo(() => this._setFrameTint(id, prevTint));
      entry.data.tint = tint;
      entry.el.style.setProperty('--wbv-frame-tint', FRAME_TINTS[tint] || tint);
      this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'update', frame: { id, tint } }, this.viewId);
      this.huddle.updateWhiteboardFrame(id, { tint })
        .catch((err) => console.warn('[wbv] frame tint save failed', err));
    }

    async _deleteFrame(id) {
      if (this.selectedFrame === id) this.selectedFrame = null;
      const entry = this.frames.get(id);
      const snap = entry ? { ...entry.data } : null;
      this._removeFrameEl(id);
      this.huddle.sendWhiteboardFrame(this.whiteboardId, { action: 'delete', id }, this.viewId);
      if (snap) this._pushUndo(() => this._recreateFrameFromData(snap));
      try { await this.huddle.deleteWhiteboardFrame(id); }
      catch (err) { console.warn('[wbv] frame delete failed', err); }
    }

    _onRemoteFrame(payload) {
      if (payload.from === this.viewId) return;
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
      // Include the sender's peerId inside the cursor payload. The
      // top-level `from` field carries the per-view UUID (so two
      // windows of the same user self-filter correctly), but the
      // receiver still needs the auth user id to look up the profile
      // name + colour. Without this, getProfile got handed a viewId
      // UUID and the label fell back to "Guest".
      this.huddle.sendWhiteboardCursor(
        this.whiteboardId,
        { x: w.x, y: w.y, t: now, userId: this.huddle.peerId },
        this.viewId,
      );
    }

    async _onRemoteCursor(payload) {
      if (payload.from === this.viewId) return;
      const c = payload.cursor;
      if (!c) return;
      // Key cursors by the SENDING VIEW (so two windows of the same
      // user render as two distinct ghosts) but resolve the profile
      // by the user id baked into the cursor payload.
      const ghostKey = payload.from;
      const userId = c.userId || payload.from;
      let entry = this.cursors.get(ghostKey);
      if (!entry) {
        const el = h('div', { class: 'wbv-cursor' });
        el.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M5 3l6.5 16 2-6.5 6.5-2z"/></svg>';
        const label = h('span', { class: 'wbv-cursor-label', text: '…' });
        el.appendChild(label);
        const hue = hashHue(userId);
        const color = `oklch(0.7 0.16 ${hue})`;
        el.style.color = color;
        label.style.background = color;
        this.worldLayer.appendChild(el);
        entry = { el, label, lastSeen: Date.now() };
        this.cursors.set(ghostKey, entry);
        // Resolve name (best-effort).
        try {
          const p = await this.huddle.getProfile(userId);
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
      else if ((e.metaKey || e.ctrlKey) && k === 'z') {
        if (this.editingNote || document.activeElement?.isContentEditable) return; // let native text undo run
        e.preventDefault();
        this.undo();
      }
      else if (k === 'delete' || k === 'backspace') {
        if (this.selectedNote && !this.editingNote) { e.preventDefault(); this._deleteNote(this.selectedNote); }
        else if (this.selectedFrame && !document.activeElement?.isContentEditable) { e.preventDefault(); this._deleteFrame(this.selectedFrame); }
      }
      else if (k === 'escape') {
        if (this.editingNote) this._endEditNote(this.editingNote);
        else { this._selectNote(null); this._selectFrame(null); }
      }
    }
    _onKeyDown() { /* board-level — currently inert; doc handler covers everything */ }

    // ────────────────────────────────────────────────────────────
    // Header bits
    // ────────────────────────────────────────────────────────────
    // Inline board-title rename (contenteditable), mirroring the frame
    // title editor — replaces the old browser prompt() dialog so the flow
    // stays on-canvas and FigJam-like.
    _beginRenameBoard() {
      const el = this.titleEl;
      if (el.getAttribute('contenteditable') === 'true') return;
      el.setAttribute('contenteditable', 'true');
      el.classList.add('is-editing');
      el.focus();
      const r = document.createRange(); r.selectNodeContents(el);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      const finish = (commit) => {
        el.removeEventListener('blur', onBlur);
        el.removeEventListener('keydown', onKey);
        el.setAttribute('contenteditable', 'false');
        el.classList.remove('is-editing');
        if (commit) this._commitRenameBoard(el.textContent);
        else el.textContent = this.boardTitle;
      };
      const onBlur = () => finish(true);
      const onKey = (e) => {
        if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      };
      el.addEventListener('blur', onBlur);
      el.addEventListener('keydown', onKey);
    }
    async _commitRenameBoard(raw) {
      const trimmed = (raw || '').replace(/\s+/g, ' ').trim() || 'Whiteboard';
      this.titleEl.textContent = trimmed;
      if (trimmed === this.boardTitle) return;
      this.boardTitle = trimmed;
      // Persist if the API supports it; peers see it via realtime regardless.
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
