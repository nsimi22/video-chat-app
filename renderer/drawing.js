// Drawing overlay attached to a screen-share <video>. Each shared screen
// (local or remote) has its own canvas keyed by `streamId`. Strokes are
// captured locally and shipped to the server, which broadcasts them to peers
// who replay them on their matching canvas.
//
// Coordinates are normalized 0..1 in the video's intrinsic space so that
// strokes line up regardless of each viewer's tile size.
class DrawingLayer {
  constructor({ streamId, send, isOwner }) {
    this.streamId = streamId;
    this.send = send; // (stroke) => void  — broadcast a stroke event.
    this.isOwner = isOwner; // owner of the shared screen; non-owners can also draw.
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'draw-canvas';
    this.ctx = this.canvas.getContext('2d');
    this.tool = 'pen';
    this.color = '#ff3b30';
    this.size = 4;
    this.drawing = false;
    this.last = null;
    this.history = []; // strokes (for re-rasterizing on resize)
    this._bind();
  }

  attach(tile) {
    tile.appendChild(this.canvas);
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
    this._redraw();
  }

  _bind() {
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

  _emit(stroke) {
    this.applyRemote(stroke);
    if (this.send) this.send(stroke);
  }

  // Apply a stroke received from any peer (or echoed from ourselves).
  applyRemote(stroke) {
    this.history.push(stroke);
    this._drawStroke(stroke);
  }

  clearAll(broadcast = true) {
    this.history = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (broadcast && this.send) this.send({ action: 'clear' });
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
    const r = this.canvas.getBoundingClientRect();
    const x = s.x * r.width, y = s.y * r.height;
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
}

window.DrawingLayer = DrawingLayer;
