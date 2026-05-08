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

      this.canvas = document.createElement('canvas');
      this.canvas.className = 'infinite-canvas';
      tile.appendChild(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this._fitCanvas();
      this._wirePointerEvents();
      this._wireKeyboardPan();
      this._wireWheelZoom();
      this._resizeObs = new ResizeObserver(() => this._fitCanvas());
      this._resizeObs.observe(tile);
    }

    setTool(t) { this.tool = t; }
    setColor(c) { this.color = c; }
    setSize(s) { this.size = s; }
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
        cur.points.push([stroke.x, stroke.y]);
        // Incremental render of just the new segment for liveness.
        this._renderIncrementalSegment(cur);
        return;
      }
      if (stroke.action === 'end') {
        const cur = this._remoteStrokes.get(stroke.uuid);
        if (!cur) return;
        cur.points.push([stroke.x, stroke.y]);
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

    clearAll(/*broadcast*/) {
      this.strokes = [];
      this._render();
    }

    // ---- Internal: rendering -------------------------------------------

    _fitCanvas() {
      const r = this.tile.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
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
      // Falls back to a full _render on any complication (eraser,
      // arrow head, very first point).
      if (!stroke.points || stroke.points.length < 2) { this._render(); return; }
      if (stroke.tool === 'eraser' || stroke.tool === 'arrow') { this._render(); return; }
      const [a, b] = [stroke.points[stroke.points.length - 2], stroke.points[stroke.points.length - 1]];
      this.ctx.save();
      this.ctx.scale(this.viewport.scale, this.viewport.scale);
      this.ctx.translate(-this.viewport.x, -this.viewport.y);
      this.ctx.strokeStyle = stroke.color;
      this.ctx.lineWidth = stroke.size;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.beginPath();
      this.ctx.moveTo(a[0], a[1]);
      this.ctx.lineTo(b[0], b[1]);
      this.ctx.stroke();
      this.ctx.restore();
    }

    _drawStroke(stroke) {
      const points = stroke.points;
      if (!points || points.length === 0) return;
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.strokeStyle = stroke.color || '#ff3b30';
      this.ctx.lineWidth = stroke.size || 4;
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
        if (this._panMode || e.button === 1 /* middle mouse */ || e.shiftKey) {
          this._startPan(e);
          return;
        }
        const p = this._clientToWorld(e.clientX, e.clientY);
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
        if (!this._currentStroke) return;
        const p = this._clientToWorld(e.clientX, e.clientY);
        this._currentStroke.points.push([p.x, p.y]);
        this._renderIncrementalSegment(this._currentStroke);
        this.send?.({
          action: 'move', uuid: this._currentStroke.uuid,
          x: p.x, y: p.y, tool: this.tool, color: this.color, size: this.size,
        });
      });
      const end = (e) => {
        if (this._panning) { this._endPan(); return; }
        if (!this._currentStroke) return;
        const p = e ? this._clientToWorld(e.clientX, e.clientY) : null;
        if (p) {
          this._currentStroke.points.push([p.x, p.y]);
          this.send?.({
            action: 'end', uuid: this._currentStroke.uuid,
            x: p.x, y: p.y, tool: this.tool, color: this.color, size: this.size,
          });
        }
        this.strokes.push(this._currentStroke);
        const finished = this._currentStroke;
        this._currentStroke = null;
        // Eraser strokes need a full re-render because incremental
        // destination-out was applied; switching back to
        // source-over leaves no trace of the cuts on the cached
        // canvas.
        if (finished.tool === 'eraser') this._render();
        // Notify the host so it can persist the polyline.
        this._strokeFinished?.(finished);
      };
      this.canvas.addEventListener('pointerup', end);
      this.canvas.addEventListener('pointercancel', end);
      this.canvas.addEventListener('pointerleave', end);
    }

    onStrokeFinished(cb) { this._strokeFinished = cb; }

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
    _endPan() {
      this._panning = null;
      this.canvas.style.cursor = '';
    }

    _wireKeyboardPan() {
      // Hold space to enter pan mode (cursor change + click-drag
      // pans instead of drawing). Released to draw again.
      const onKeyDown = (e) => {
        if (e.code === 'Space' && !e.repeat && document.activeElement !== this.canvas) {
          // Don't hijack space inside a textarea (sticky note text).
          const tag = (document.activeElement?.tagName || '').toLowerCase();
          if (tag === 'textarea' || tag === 'input') return;
          this._panMode = true;
          this.canvas.style.cursor = 'grab';
          e.preventDefault();
        }
      };
      const onKeyUp = (e) => {
        if (e.code === 'Space') {
          this._panMode = false;
          if (!this._panning) this.canvas.style.cursor = '';
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
      if (this._keyDown) document.removeEventListener('keydown', this._keyDown);
      if (this._keyUp) document.removeEventListener('keyup', this._keyUp);
      this.canvas.remove();
    }
  }

  window.InfiniteCanvas = InfiniteCanvas;
})();
