// Drawing overlay attached to a screen-share <video>. Each shared screen
// (local or remote) has its own canvas keyed by `streamId`. Strokes are
// captured locally and shipped to the server, which broadcasts them to peers
// who replay them on their matching canvas.
//
// Coordinates are normalized 0..1 in the video's intrinsic space so that
// strokes line up regardless of each viewer's tile size.
//
// Per-user live cursors are rendered as DOM elements overlaid on the same
// host as the canvas. They appear whenever a remote peer is mid-stroke and
// disappear on the stroke's `end` event. Each cursor is colored to match
// the stroke and tagged with the peer's name (Slack-huddle-style).

// Auto-assigned color palette keyed by deterministic hash of user identity.
// Picked for contrast over screen content (no near-white, no dim).
const DRAW_USER_PALETTE = [
  '#FF3B30', // red
  '#34C759', // green
  '#007AFF', // blue
  '#FF9500', // orange
  '#AF52DE', // purple
  '#FF2D55', // pink
  '#00C7BE', // teal
];

function colorForUser(uid) {
  if (!uid) return DRAW_USER_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < uid.length; i++) {
    hash = ((hash << 5) - hash + uid.charCodeAt(i)) | 0;
  }
  return DRAW_USER_PALETTE[Math.abs(hash) % DRAW_USER_PALETTE.length];
}

// Inline pen-cursor SVG used for remote cursors. `currentColor` lets the
// CSS color (set per-cursor to match the stroke color) drive the fill.
const REMOTE_CURSOR_SVG = `
<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
  <path d="M3 21l4-1 13-13a2.5 2.5 0 0 0-3.5-3.5L3.5 16.5 3 21z"/>
</svg>`;

class DrawingLayer {
  constructor({ streamId, send, isOwner, localUserId, nameForUser }) {
    this.streamId = streamId;
    this.send = send; // (stroke) => void  — broadcast a stroke event.
    this.isOwner = isOwner; // owner of the shared screen; non-owners can also draw.
    this.localUserId = localUserId || null;
    // Callback used to render remote cursors with a friendly name. Falls
    // back to the bare user id when not provided (keeps the layer usable
    // outside the main call context, e.g. in tests).
    this.nameForUser = typeof nameForUser === 'function' ? nameForUser : (uid) => uid;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'draw-canvas';
    this.ctx = this.canvas.getContext('2d');
    this.tool = 'pen';
    // Initial color is auto-assigned from the per-user palette so multiple
    // collaborators draw in distinguishable colors by default. The toolbar
    // color picker can override at any time via setColor().
    this.color = colorForUser(this.localUserId);
    this.size = 4;
    this.drawing = false;
    this.last = null;
    this.history = []; // strokes (for re-rasterizing on resize)
    this._cssSize = { w: 0, h: 0 }; // cached canvas CSS dimensions; updated on resize.
    // Remote cursors keyed by user id. Live as DOM nodes alongside the canvas
    // (in the same host element) so they layer over the share at the right
    // position and follow any parent transform (e.g. zoom on a spotlighted
    // screen tile).
    this.remoteCursors = new Map();
    this._cursorHost = null; // resolved in attach()
    this._bind();
  }

  attach(tile) {
    // Append the canvas to .tile-content when present so a CSS transform on
    // that wrapper (used for zoom/pan on spotlighted screens) scales the
    // canvas in lockstep with the video. Falls back to the tile root for
    // non-screen consumers (e.g. whiteboards) that don't wrap their video.
    const host = tile.querySelector('.tile-content') || tile;
    host.appendChild(this.canvas);
    this._cursorHost = host;
    this.tile = tile;
    new ResizeObserver(() => this._sizeToTile()).observe(tile);
    this._sizeToTile();
  }

  setActive(active) {
    this.tile.classList.toggle('annotating', active);
  }

  setTool(tool) { this.tool = tool; }
  setColor(c) { this.color = c; }
  setSize(s) { this.size = s; }

  _sizeToTile() {
    const r = this.tile.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = r.width * dpr;
    this.canvas.height = r.height * dpr;
    this.canvas.style.width = r.width + 'px';
    this.canvas.style.height = r.height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._cssSize.w = r.width;
    this._cssSize.h = r.height;
    this._redraw();
  }

  _bind() {
    // Pointer events fire frequently — read the bounding rect lazily and only
    // when one actually arrives (not in inner draw loops).
    const toLocal = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      this.drawing = true;
      this.canvas.setPointerCapture(e.pointerId);
      const p = toLocal(e);
      this.last = p;
      this._emit({ action: 'begin', x: p.x, y: p.y, tool: this.tool, color: this.color, size: this.size });
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.drawing) return;
      const p = toLocal(e);
      this._emit({ action: 'move', x: p.x, y: p.y, tool: this.tool, color: this.color, size: this.size });
      this.last = p;
    });
    const end = (e) => {
      if (!this.drawing) return;
      this.drawing = false;
      const p = e ? toLocal(e) : this.last || { x: 0, y: 0 };
      this._emit({ action: 'end', x: p.x, y: p.y, tool: this.tool, color: this.color, size: this.size });
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointerleave', end);
  }

  // Local stroke emission: optimistically rasterize, then broadcast. Does
  // NOT show a remote cursor — the local user already has a native pointer
  // cursor (CSS crosshair) over the canvas.
  _emit(stroke) {
    this._ingest(stroke);
    if (this.send) this.send(stroke);
  }

  // Apply a stroke arriving from a peer. Rasterizes the stroke onto the
  // canvas and updates that peer's floating cursor position/visibility.
  applyRemote(stroke, from) {
    this._ingest(stroke);
    if (from && from !== this.localUserId) {
      this._updateRemoteCursor(from, stroke);
    }
  }

  // Pure rasterization + history append, shared between _emit and applyRemote.
  _ingest(stroke) {
    this.history.push(stroke);
    this._drawStroke(stroke);
  }

  clearAll(broadcast = true) {
    this.history = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (broadcast && this.send) this.send({ action: 'clear' });
    // Clear all remote cursors too — a clear typically means "wipe and
    // start over", and stale cursors over a blank canvas look broken.
    for (const uid of [...this.remoteCursors.keys()]) this._hideRemoteCursor(uid);
  }

  _redraw() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    let prev = null;
    for (const s of this.history) {
      this._drawStroke(s, prev);
      prev = s;
    }
  }

  _drawStroke(s) {
    if (s.action === 'clear') {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    // Use cached CSS size — getBoundingClientRect() in this hot path causes
    // a synchronous layout flush, which dominates cost on long histories.
    const w = this._cssSize.w, h = this._cssSize.h;
    const x = s.x * w, y = s.y * h;
    if (s.action === 'begin') {
      this._cursor = { x, y, color: s.color, size: s.size, tool: s.tool };
      if (s.tool === 'eraser') {
        this.ctx.globalCompositeOperation = 'destination-out';
      } else {
        this.ctx.globalCompositeOperation = 'source-over';
      }
      this.ctx.beginPath();
      this.ctx.moveTo(x, y);
      return;
    }
    if (s.action === 'move' && this._cursor) {
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.strokeStyle = s.color;
      this.ctx.lineWidth = s.size;
      this.ctx.lineTo(x, y);
      this.ctx.stroke();
      this._cursor.x = x; this._cursor.y = y;
      return;
    }
    if (s.action === 'end' && this._cursor) {
      if (s.tool === 'arrow') {
        this._drawArrowhead(this._cursor.x, this._cursor.y, x, y, s.color, s.size);
      }
      this._cursor = null;
      this.ctx.globalCompositeOperation = 'source-over';
    }
  }

  _drawArrowhead(x1, y1, x2, y2, color, size) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const len = Math.max(8, size * 3);
    this.ctx.fillStyle = color;
    this.ctx.beginPath();
    this.ctx.moveTo(x2, y2);
    this.ctx.lineTo(x2 - len * Math.cos(angle - Math.PI / 7), y2 - len * Math.sin(angle - Math.PI / 7));
    this.ctx.lineTo(x2 - len * Math.cos(angle + Math.PI / 7), y2 - len * Math.sin(angle + Math.PI / 7));
    this.ctx.closePath();
    this.ctx.fill();
  }

  // --- Remote cursors -----------------------------------------------------
  //
  // A remote peer's cursor follows their pen position while they're drawing
  // (begin → moves → end). On `end` we hide it; the next `begin` brings it
  // back. We piggyback on existing stroke events so no new wire protocol is
  // needed — `from` arrives in the broadcast envelope (see api.js sendDraw).

  _updateRemoteCursor(uid, stroke) {
    if (stroke.action === 'clear') {
      // A clear wipes the canvas for everyone — drop every remote cursor
      // too so stale pen icons don't linger over an empty drawing surface.
      for (const id of [...this.remoteCursors.keys()]) this._hideRemoteCursor(id);
      return;
    }
    if (stroke.action === 'end') {
      this._hideRemoteCursor(uid);
      return;
    }
    if (stroke.action === 'begin' || stroke.action === 'move') {
      this._showRemoteCursor(uid, stroke);
    }
  }

  _showRemoteCursor(uid, stroke) {
    let cursor = this.remoteCursors.get(uid);
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.className = 'remote-cursor';
      cursor.dataset.userId = uid;
      const pen = document.createElement('div');
      pen.className = 'remote-cursor-pen';
      pen.innerHTML = REMOTE_CURSOR_SVG;
      cursor.appendChild(pen);
      const label = document.createElement('div');
      label.className = 'remote-cursor-name';
      // Name + color are stable for the lifetime of one stroke (cursor is
      // recreated on the next `begin`). Set them only on creation so the
      // pointermove hot path is a pure position update — no querySelector,
      // no textContent or style writes per move.
      label.textContent = this.nameForUser(uid);
      cursor.appendChild(label);
      if (stroke.color) cursor.style.color = stroke.color;
      (this._cursorHost || this.tile).appendChild(cursor);
      this.remoteCursors.set(uid, cursor);
    }
    // Position via percentages so the cursor tracks the canvas's normalized
    // 0..1 stroke space — works through any parent transform (zoom/pan).
    cursor.style.left = `${stroke.x * 100}%`;
    cursor.style.top = `${stroke.y * 100}%`;
  }

  _hideRemoteCursor(uid) {
    const cursor = this.remoteCursors.get(uid);
    if (cursor) {
      cursor.remove();
      this.remoteCursors.delete(uid);
    }
  }
}

window.DrawingLayer = DrawingLayer;
window.colorForUser = colorForUser;
