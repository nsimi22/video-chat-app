// Whiteboard canvas in absolute world coords with a pan/zoom
// viewport. Replaces DrawingLayer for whiteboard tiles (screen-
// share annotations still use DrawingLayer's fractional model
// since they're locked to the underlying video frame).
//
// World vs viewport:
//   - Strokes are stored as world coords; one world unit ≈ one
//     pixel at scale 1. The migration in
//     20260508060000_huddle_infinite_canvas.sql multiplied the
//     legacy fractional [0..1] values by 1000 so existing
//     whiteboards open with their content in the expected place
//     under the default viewport (0, 0, scale = 1).
//   - The viewport is { x, y, scale } where (x, y) is the world
//     point currently at the canvas's top-left and scale is
//     pixels-per-world-unit. Pan/zoom only mutate the viewport;
//     strokes themselves never move.
//
// Pointer events convert client coords → world via the inverse
// transform. Drawing always emits world coords; remote peers
// receive world coords directly and render them through their
// own viewport.

(function () {
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 8;
  const ZOOM_STEP = 1.2;
  // Eraser nib radius in *screen* pixels, so it feels the same at any zoom.
  const ERASER_PX = 14;
  // Cursor shown while the eraser tool is active — a ring the size of the
  // nib, so you can see what you're about to delete (FigJam does this).
  const ERASER_CURSOR =
    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='30' height='30'><circle cx='15' cy='15' r='14' fill='none' stroke='%23999' stroke-width='1.5'/></svg>\") 15 15, crosshair";

  // Shortest distance from point (px,py) to the segment (ax,ay)→(bx,by).
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // Snap (px,py) onto the nearest 45° ray from (sx,sy), keeping the
  // length — used while Shift is held during a line/arrow drag.
  function snap45(sx, sy, px, py) {
    const dx = px - sx, dy = py - sy;
    const len = Math.hypot(dx, dy);
    if (len === 0) return [px, py];
    const step = Math.PI / 4;
    const ang = Math.round(Math.atan2(dy, dx) / step) * step;
    return [sx + len * Math.cos(ang), sy + len * Math.sin(ang)];
  }

  // Two-point tools carry exactly [start, end]: straight line, arrow, and
  // the box-shapes (rect/ellipse/diamond). Pen/eraser strokes are open
  // polylines of many points.
  const SHAPE_TOOLS = new Set(['rect', 'ellipse', 'diamond']);
  const TWO_POINT_TOOLS = new Set(['line', 'arrow', ...SHAPE_TOOLS]);
  const isTwoPoint = (tool) => TWO_POINT_TOOLS.has(tool);
  const isShape = (tool) => SHAPE_TOOLS.has(tool);

  // Shift-constraint for a two-point drag: a box-shape becomes a perfect
  // square/circle (equal width & height); a line/arrow snaps to 45°.
  function constrainEnd(tool, sx, sy, px, py) {
    if (isShape(tool)) {
      const m = Math.max(Math.abs(px - sx), Math.abs(py - sy));
      return [sx + (px < sx ? -m : m), sy + (py < sy ? -m : m)];
    }
    return snap45(sx, sy, px, py);
  }

  class InfiniteCanvas {
    constructor({ tile, send, isOwner = true }) {
      this.tile = tile;
      this.send = send;
      this.isOwner = isOwner;
      // Drawing tools (driven externally by the toolbar via
      // setTool/setColor/setSize). Defaults match DrawingLayer.
      this.tool = 'pen';
      this.color = '#ff3b30';
      this.size = 4;
      this.viewport = { x: 0, y: 0, scale: 1 };
      // Persisted strokes — kept in memory so a viewport change
      // can re-render the whole canvas. Each entry is the same
      // {tool, color, size, points: [[wx, wy], ...], uuid}
      // shape persistWhiteboardStroke writes to the DB.
      this.strokes = [];
      this._currentStroke = null; // local in-progress
      this._remoteStrokes = new Map(); // uuid -> in-progress remote stroke
      this._panMode = false;
      this._panning = null;
      this._erasing = false; // true while an eraser drag is in progress
      this._lastErasePt = null; // previous eraser-nib position, so a fast drag covers the path
      this._bboxCache = new WeakMap(); // stroke -> [minX,minY,maxX,maxY], for the eraser's cheap reject

      this.canvas = document.createElement('canvas');
      this.canvas.className = 'infinite-canvas';
      this.canvas.style.cursor = 'crosshair';
      tile.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this._fitCanvas();
      this._wirePointerEvents();
      this._wireKeyboardPan();
      this._wireWheelZoom();
      // Coalesce resize ticks to one _fitCanvas per frame — a layout
      // transition (e.g. spotlighting the tile) can fire the observer
      // several times in quick succession, and each _fitCanvas reallocs
      // the canvas bitmap + re-renders every stroke.
      this._resizeObs = new ResizeObserver(() => {
        if (this._fitRaf) return;
        this._fitRaf = requestAnimationFrame(() => { this._fitRaf = null; this._fitCanvas(); });
      });
      this._resizeObs.observe(tile);
    }

    setTool(t) {
      this.tool = t;
      if (!this._panning && !this._panMode) this.canvas.style.cursor = this._toolCursor();
    }
    setColor(c) { this.color = c; }
    setSize(s) { this.size = s; }
    // Idle cursor for the current tool (pan gestures override this while active).
    _toolCursor() { return this.tool === 'eraser' ? ERASER_CURSOR : 'crosshair'; }
    // DrawingLayer parity: toggleAnnotate calls .setActive() to
    // gate pointer events. InfiniteCanvas owns its own canvas
    // element with pointer events always live; the call is a
    // no-op here and exists only so toggleAnnotate doesn't have
    // to special-case whiteboards vs screen tiles.
    setActive(/*active*/) {}
    // clearAll(broadcast) — DrawingLayer signature. Whiteboards
    // call session.clear() which goes through its own DB path;
    // the toolbar's drawClear button delegates to session.clear()
    // for whiteboards before falling back to clearAll(true) for
    // screen annotations. We accept the arg for compatibility but
    // ignore it — the canvas only needs to wipe local strokes.

    // Viewport mutators called by the toolbar buttons.
    zoomIn(centerClient) { this._zoomBy(ZOOM_STEP, centerClient); }
    zoomOut(centerClient) { this._zoomBy(1 / ZOOM_STEP, centerClient); }
    resetViewport() {
      this.viewport = { x: 0, y: 0, scale: 1 };
      this._render();
      this._dispatchViewport();
    }
    onViewportChange(cb) { this._viewportCb = cb; }

    getViewport() { return { ...this.viewport }; }

    // Apply a remote stroke event from another peer. Same shape as
    // the local emit: { action, x, y, tool, color, size, uuid }.
    applyRemote(stroke) {
      if (stroke.action === 'clear') { this.strokes = []; this._render(); return; }
      if (stroke.action === 'begin') {
        this._remoteStrokes.set(stroke.uuid, {
          uuid: stroke.uuid,
          tool: stroke.tool, color: stroke.color, size: stroke.size,
          points: [[stroke.x, stroke.y]],
        });
        return;
      }
      if (stroke.action === 'move') {
        const cur = this._remoteStrokes.get(stroke.uuid);
        if (!cur) return;
        if (isTwoPoint(cur.tool)) {
          // Line/arrow: the live endpoint replaces the previous one.
          if (cur.points.length < 2) cur.points.push([stroke.x, stroke.y]);
          else cur.points[1] = [stroke.x, stroke.y];
          this._render();
          return;
        }
        cur.points.push([stroke.x, stroke.y]);
        // Incremental render of just the new segment for liveness.
        this._renderIncrementalSegment(cur);
        return;
      }
      if (stroke.action === 'end') {
        const cur = this._remoteStrokes.get(stroke.uuid);
        if (!cur) return;
        if (isTwoPoint(cur.tool)) {
          if (cur.points.length < 2) cur.points.push([stroke.x, stroke.y]);
          else cur.points[1] = [stroke.x, stroke.y];
        } else {
          cur.points.push([stroke.x, stroke.y]);
        }
        this._remoteStrokes.delete(stroke.uuid);
        this.strokes.push(cur);
        this._render();
      }
    }

    // Replay a fully-persisted polyline (from history) — adds it to
    // the strokes list and triggers a render. Used by
    // WhiteboardSession.start when fetching history rows.
    addPersistedStroke(stroke) {
      this.strokes.push(stroke);
      this._render();
    }

    // Drop a stroke by uuid (used by undo). Falls back gracefully
    // to a no-op if the uuid isn't in the list (e.g. the stroke
    // hasn't synced yet from the broadcast or was already
    // removed).
    removeStroke(uuid) {
      if (!uuid) return;
      const before = this.strokes.length;
      this.strokes = this.strokes.filter((s) => s.uuid !== uuid);
      if (this.strokes.length !== before) this._render();
    }

    clearAll(/*broadcast*/) {
      this.strokes = [];
      this._render();
    }

    // ---- Internal: rendering -------------------------------------------

    _fitCanvas() {
      const r = this.tile.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      // Bail if nothing that affects the canvas bitmap changed —
      // ResizeObserver can fire spuriously, and a realloc + full
      // re-render here is not cheap on a busy board. devicePixelRatio is
      // in the comparison too: dragging the window to a denser monitor
      // leaves the CSS size identical but needs a re-render to stay crisp.
      if (r.width === this._fitW && r.height === this._fitH && dpr === this._fitDpr) return;
      this._fitW = r.width;
      this._fitH = r.height;
      this._fitDpr = dpr;
      this.canvas.width = Math.max(1, Math.floor(r.width * dpr));
      this.canvas.height = Math.max(1, Math.floor(r.height * dpr));
      this.canvas.style.width = `${r.width}px`;
      this.canvas.style.height = `${r.height}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._render();
    }

    _render() {
      const r = this.canvas.getBoundingClientRect();
      this.ctx.clearRect(0, 0, r.width, r.height);
      this.ctx.save();
      this.ctx.scale(this.viewport.scale, this.viewport.scale);
      this.ctx.translate(-this.viewport.x, -this.viewport.y);
      for (const stroke of this.strokes) this._drawStroke(stroke);
      // In-progress remote strokes are rendered in the same pass.
      for (const cur of this._remoteStrokes.values()) this._drawStroke(cur);
      // The local in-progress stroke is also rendered so the user
      // sees their own ink while drawing.
      if (this._currentStroke) this._drawStroke(this._currentStroke);
      this.ctx.restore();
    }

    _renderIncrementalSegment(stroke) {
      // Cheap path: when a single new point arrives, draw just that
      // segment instead of clearing + re-rendering the whole world.
      // Legacy eraser segments cut through existing pixels via
      // destination-out — same incremental cost as pen — so they
      // share this fast path. Line/arrow move the whole segment each
      // frame (and arrow redraws its head), so they fall through to a
      // full _render() instead.
      if (!stroke.points || stroke.points.length < 2) { this._render(); return; }
      if (isTwoPoint(stroke.tool)) { this._render(); return; }
      const [a, b] = [stroke.points[stroke.points.length - 2], stroke.points[stroke.points.length - 1]];
      this.ctx.save();
      this.ctx.scale(this.viewport.scale, this.viewport.scale);
      this.ctx.translate(-this.viewport.x, -this.viewport.y);
      if (stroke.tool === 'eraser') {
        this.ctx.globalCompositeOperation = 'destination-out';
        this.ctx.lineWidth = (stroke.size || 4) * 2;
      } else {
        this.ctx.globalCompositeOperation = 'source-over';
        this.ctx.lineWidth = stroke.size || 4;
      }
      this.ctx.strokeStyle = stroke.color || '#ff3b30';
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.beginPath();
      this.ctx.moveTo(a[0], a[1]);
      this.ctx.lineTo(b[0], b[1]);
      this.ctx.stroke();
      this.ctx.globalCompositeOperation = 'source-over';
      this.ctx.restore();
    }

    _drawStroke(stroke) {
      const points = stroke.points;
      if (!points || points.length === 0) return;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.strokeStyle = stroke.color || '#ff3b30';
      this.ctx.lineWidth = stroke.size || 4;
      // Box-shapes: rect / ellipse / diamond, sized by the two opposite
      // corners in `points`. Outline in the current colour + a faint fill
      // of the same colour so they read as shapes, not just frames.
      if (isShape(stroke.tool)) {
        if (points.length < 2) return; // a click with no drag yet — nothing to draw
        const a = points[0], b = points[points.length - 1];
        const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
        const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
        this.ctx.globalCompositeOperation = 'source-over';
        this.ctx.lineJoin = 'miter';
        this.ctx.beginPath();
        if (stroke.tool === 'rect') {
          this.ctx.rect(x, y, w, h);
        } else if (stroke.tool === 'ellipse') {
          this.ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
        } else { // diamond
          this.ctx.moveTo(x + w / 2, y);
          this.ctx.lineTo(x + w, y + h / 2);
          this.ctx.lineTo(x + w / 2, y + h);
          this.ctx.lineTo(x, y + h / 2);
          this.ctx.closePath();
        }
        this.ctx.globalAlpha = 0.12;
        this.ctx.fillStyle = stroke.color || '#ff3b30';
        this.ctx.fill();
        this.ctx.globalAlpha = 1;
        this.ctx.stroke();
        return;
      }
      if (stroke.tool === 'eraser') {
        // Eraser cuts through everything by drawing in
        // destination-out. The colour is irrelevant; the stroke
        // width determines the eraser nib.
        this.ctx.globalCompositeOperation = 'destination-out';
        this.ctx.lineWidth = (stroke.size || 4) * 2;
      } else {
        this.ctx.globalCompositeOperation = 'source-over';
      }
      this.ctx.beginPath();
      this.ctx.moveTo(points[0][0], points[0][1]);
      for (let i = 1; i < points.length; i++) {
        this.ctx.lineTo(points[i][0], points[i][1]);
      }
      this.ctx.stroke();
      // Arrow tools draw a small triangle at the last point
      // pointing along the final segment.
      if (stroke.tool === 'arrow' && points.length >= 2) {
        const [px, py] = points[points.length - 2];
        const [qx, qy] = points[points.length - 1];
        const ang = Math.atan2(qy - py, qx - px);
        const head = Math.max(8, (stroke.size || 4) * 3);
        this.ctx.beginPath();
        this.ctx.moveTo(qx, qy);
        this.ctx.lineTo(qx - head * Math.cos(ang - Math.PI / 6), qy - head * Math.sin(ang - Math.PI / 6));
        this.ctx.lineTo(qx - head * Math.cos(ang + Math.PI / 6), qy - head * Math.sin(ang + Math.PI / 6));
        this.ctx.closePath();
        this.ctx.fillStyle = stroke.color;
        this.ctx.fill();
      }
      this.ctx.globalCompositeOperation = 'source-over';
    }

    // ---- Internal: pointer/keyboard input ------------------------------

    _clientToWorld(clientX, clientY) {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: (clientX - r.left) / this.viewport.scale + this.viewport.x,
        y: (clientY - r.top) / this.viewport.scale + this.viewport.y,
      };
    }

    _wirePointerEvents() {
      this.canvas.addEventListener('pointerdown', (e) => {
        const lineish = isTwoPoint(this.tool);
        // Pan via space-hold, middle mouse, or shift-drag — but Shift on a
        // line/arrow means "constrain to 45°", so don't hijack it then.
        if (this._panMode || e.button === 1 || (e.shiftKey && !lineish)) {
          this._startPan(e);
          return;
        }
        const p = this._clientToWorld(e.clientX, e.clientY);
        // Object eraser (FigJam-style): the eraser is not a stroke — it
        // deletes whole strokes its nib passes over. We remove + re-render
        // here; the host broadcasts + persists the deletion via the
        // onStrokeErased callback.
        if (this.tool === 'eraser') {
          this._erasing = true;
          this._lastErasePt = [p.x, p.y];
          this.canvas.setPointerCapture(e.pointerId);
          this._eraseAlong(p.x, p.y, p.x, p.y);
          return;
        }
        const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        this._currentStroke = {
          uuid,
          tool: this.tool, color: this.color, size: this.size,
          points: [[p.x, p.y]],
        };
        this.canvas.setPointerCapture(e.pointerId);
        this.send?.({ action: 'begin', uuid, x: p.x, y: p.y, tool: this.tool, color: this.color, size: this.size });
      });
      this.canvas.addEventListener('pointermove', (e) => {
        if (this._panning) { this._continuePan(e); return; }
        if (this._erasing) {
          const p = this._clientToWorld(e.clientX, e.clientY);
          const a = this._lastErasePt || [p.x, p.y];
          this._eraseAlong(a[0], a[1], p.x, p.y);
          this._lastErasePt = [p.x, p.y];
          return;
        }
        if (!this._currentStroke) return;
        const p = this._clientToWorld(e.clientX, e.clientY);
        if (isTwoPoint(this._currentStroke.tool)) {
          const s = this._currentStroke.points[0];
          const end = e.shiftKey ? constrainEnd(this._currentStroke.tool, s[0], s[1], p.x, p.y) : [p.x, p.y];
          this._currentStroke.points = [s, end];
          this._render();
          this.send?.({
            action: 'move', uuid: this._currentStroke.uuid,
            x: end[0], y: end[1], tool: this._currentStroke.tool, color: this.color, size: this.size,
          });
          return;
        }
        this._currentStroke.points.push([p.x, p.y]);
        this._renderIncrementalSegment(this._currentStroke);
        this.send?.({
          action: 'move', uuid: this._currentStroke.uuid,
          x: p.x, y: p.y, tool: this.tool, color: this.color, size: this.size,
        });
      });
      const end = (e) => {
        if (this._panning) { this._endPan(e); return; }
        if (this._erasing) {
          this._erasing = false;
          this._lastErasePt = null;
          if (e?.pointerId != null) { try { this.canvas.releasePointerCapture(e.pointerId); } catch {} }
          return;
        }
        if (!this._currentStroke) return;
        const lineish = isTwoPoint(this._currentStroke.tool);
        const p = e ? this._clientToWorld(e.clientX, e.clientY) : null;
        if (p) {
          if (lineish) {
            const s = this._currentStroke.points[0];
            const fin = e.shiftKey ? constrainEnd(this._currentStroke.tool, s[0], s[1], p.x, p.y) : [p.x, p.y];
            this._currentStroke.points = [s, fin];
            this.send?.({
              action: 'end', uuid: this._currentStroke.uuid,
              x: fin[0], y: fin[1], tool: this._currentStroke.tool, color: this.color, size: this.size,
            });
          } else {
            this._currentStroke.points.push([p.x, p.y]);
            this.send?.({
              action: 'end', uuid: this._currentStroke.uuid,
              x: p.x, y: p.y, tool: this.tool, color: this.color, size: this.size,
            });
          }
        }
        this.strokes.push(this._currentStroke);
        const finished = this._currentStroke;
        this._currentStroke = null;
        // Release the pointer capture set in pointerdown so other
        // elements can take pointer events again. Implicit release
        // happens on pointerup, but pointercancel/pointerleave
        // paths benefit from being explicit.
        if (e?.pointerId != null) {
          try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
        }
        // Line/arrow: re-render once so the committed straight segment
        // (which was tracked via _render during the drag) is clean.
        if (lineish) this._render();
        // Notify the host so it can persist the polyline.
        this._strokeFinished?.(finished);
      };
      this.canvas.addEventListener('pointerup', end);
      this.canvas.addEventListener('pointercancel', end);
      this.canvas.addEventListener('pointerleave', end);
    }

    onStrokeFinished(cb) { this._strokeFinished = cb; }
    onStrokeErased(cb) { this._strokeErased = cb; }

    // Delete every stroke whose ink comes within the eraser nib of the
    // move path (ax,ay)→(bx,by). The path (not just the two endpoints) is
    // checked so a fast flick can't skip strokes between pointermove
    // events — we sample it at ~one-nib steps. A per-stroke bounding-box
    // reject keeps that cheap even on a busy board. Removes locally +
    // re-renders, then hands each deleted uuid to the host (broadcast +
    // DB delete).
    _eraseAlong(ax, ay, bx, by) {
      if (!this.strokes.length) return;
      const radius = ERASER_PX / this.viewport.scale;
      const dist = Math.hypot(bx - ax, by - ay);
      const steps = Math.max(1, Math.ceil(dist / Math.max(1e-3, radius)));
      const pMinX = Math.min(ax, bx), pMaxX = Math.max(ax, bx);
      const pMinY = Math.min(ay, by), pMaxY = Math.max(ay, by);
      const gone = new Set();
      for (const s of this.strokes) {
        if (!s.uuid || gone.has(s.uuid)) continue;
        const r = radius + (s.size || 4) / 2;
        const bb = this._strokeBbox(s);
        // Cheap reject: the move path's box (expanded by the nib) doesn't
        // reach this stroke's box.
        if (pMinX - r > bb[2] || pMaxX + r < bb[0] || pMinY - r > bb[3] || pMaxY + r < bb[1]) continue;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          if (this._strokeNear(s, ax + t * (bx - ax), ay + t * (by - ay), r)) { gone.add(s.uuid); break; }
        }
      }
      if (!gone.size) return;
      this.strokes = this.strokes.filter((s) => !gone.has(s.uuid));
      this._render();
      for (const uuid of gone) this._strokeErased?.(uuid);
    }

    // Memoised axis-aligned bounding box [minX, minY, maxX, maxY] of a
    // stroke's points. WeakMap-keyed so it's dropped when the stroke is.
    _strokeBbox(stroke) {
      let bb = this._bboxCache.get(stroke);
      if (bb) return bb;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of (stroke.points || [])) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      bb = [minX, minY, maxX, maxY];
      this._bboxCache.set(stroke, bb);
      return bb;
    }

    _strokeNear(stroke, wx, wy, r) {
      const pts = stroke.points;
      if (!pts || !pts.length) return false;
      if (pts.length === 1) return Math.hypot(wx - pts[0][0], wy - pts[0][1]) <= r;
      // Box-shapes are stored as just two opposite corners, so the
      // polyline path is only their diagonal — hit-test the actual area
      // (expanded by the nib) instead, otherwise they're nearly
      // impossible to erase.
      if (isShape(stroke.tool)) {
        const a = pts[0], b = pts[pts.length - 1];
        const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
        const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
        if (stroke.tool === 'rect') {
          return wx >= x - r && wx <= x + w + r && wy >= y - r && wy <= y + h + r;
        }
        const rx = w / 2, ry = h / 2;
        if (rx <= 0 || ry <= 0) return distToSeg(wx, wy, a[0], a[1], b[0], b[1]) <= r;
        const dx = wx - (x + rx), dy = wy - (y + ry);
        if (stroke.tool === 'ellipse') {
          return (dx * dx) / ((rx + r) * (rx + r)) + (dy * dy) / ((ry + r) * (ry + r)) <= 1;
        }
        // diamond — point inside the (expanded) rhombus, L1 norm
        return Math.abs(dx) / (rx + r) + Math.abs(dy) / (ry + r) <= 1;
      }
      for (let i = 1; i < pts.length; i++) {
        if (distToSeg(wx, wy, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= r) return true;
      }
      return false;
    }

    _startPan(e) {
      this._panning = {
        startX: e.clientX, startY: e.clientY,
        origX: this.viewport.x, origY: this.viewport.y,
      };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
    }
    _continuePan(e) {
      if (!this._panning) return;
      const dx = (e.clientX - this._panning.startX) / this.viewport.scale;
      const dy = (e.clientY - this._panning.startY) / this.viewport.scale;
      this.viewport.x = this._panning.origX - dx;
      this.viewport.y = this._panning.origY - dy;
      this._render();
      this._dispatchViewport();
    }
    _endPan(e) {
      this._panning = null;
      this.canvas.style.cursor = this._panMode ? 'grab' : this._toolCursor();
      if (e?.pointerId != null) {
        try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
      }
    }

    _wireKeyboardPan() {
      // Hold space to enter pan mode (cursor change + click-drag
      // pans instead of drawing). Only the canvas the pointer is
      // currently over should react to space — otherwise multiple
      // InfiniteCanvas instances (e.g. main window + popout) all
      // flip into pan mode at once.
      this._hovered = false;
      this.canvas.addEventListener('mouseenter', () => { this._hovered = true; });
      this.canvas.addEventListener('mouseleave', () => {
        this._hovered = false;
        if (this._panMode && !this._panning) {
          this._panMode = false;
          this.canvas.style.cursor = this._toolCursor();
        }
      });
      const onKeyDown = (e) => {
        if (e.code !== 'Space' || e.repeat) return;
        if (!this._hovered) return;
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag === 'textarea' || tag === 'input') return;
        this._panMode = true;
        this.canvas.style.cursor = 'grab';
        e.preventDefault();
      };
      const onKeyUp = (e) => {
        if (e.code === 'Space') {
          this._panMode = false;
          if (!this._panning) this.canvas.style.cursor = this._toolCursor();
        }
      };
      document.addEventListener('keydown', onKeyDown);
      document.addEventListener('keyup', onKeyUp);
      this._keyDown = onKeyDown;
      this._keyUp = onKeyUp;
    }

    _wireWheelZoom() {
      this.canvas.addEventListener('wheel', (e) => {
        // Plain wheel pans; Ctrl/⌘+wheel zooms (matches the
        // browser/macOS pinch-to-zoom convention so trackpad
        // gestures Just Work).
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const factor = Math.exp(-e.deltaY * 0.001);
          this._zoomBy(factor, { clientX: e.clientX, clientY: e.clientY });
          return;
        }
        e.preventDefault();
        // Pan: deltaY scrolls vertically, deltaX horizontally.
        // Divide by scale so a fixed-pixel scroll covers the same
        // perceived distance regardless of zoom level.
        this.viewport.x += e.deltaX / this.viewport.scale;
        this.viewport.y += e.deltaY / this.viewport.scale;
        this._render();
        this._dispatchViewport();
      }, { passive: false });
    }

    _zoomBy(factor, centerClient) {
      const before = centerClient
        ? this._clientToWorld(centerClient.clientX, centerClient.clientY)
        : null;
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.viewport.scale * factor));
      if (next === this.viewport.scale) return;
      this.viewport.scale = next;
      if (before) {
        // Re-pin the world point under the cursor by adjusting
        // viewport so the world→client transform maps `before`
        // back to the same client coords.
        const after = this._clientToWorld(centerClient.clientX, centerClient.clientY);
        this.viewport.x += (before.x - after.x);
        this.viewport.y += (before.y - after.y);
      }
      this._render();
      this._dispatchViewport();
    }

    _dispatchViewport() {
      this._viewportCb?.(this.getViewport());
    }

    destroy() {
      this._resizeObs?.disconnect();
      if (this._fitRaf) cancelAnimationFrame(this._fitRaf);
      if (this._keyDown) document.removeEventListener('keydown', this._keyDown);
      if (this._keyUp) document.removeEventListener('keyup', this._keyUp);
      this.canvas.remove();
    }
  }

  window.InfiniteCanvas = InfiniteCanvas;
})();
