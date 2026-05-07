// Per-channel collaborative whiteboard.
//
// One canvas, many peers; live strokes via Realtime broadcast and persistent
// state in Postgres. The actual drawing primitives are reused from
// drawing.js (the same surface used to annotate shared screens), so the
// pen/arrow/eraser/color/size controls all behave identically.
//
// Wire shape:
//   - LIVE      strokes (begin/move/end) broadcast over `whiteboard:<id>`
//                so connected peers see drawing as it happens.
//   - PERSIST   completed strokes are accumulated client-side and saved as
//                a single polyline row on stroke `end`. Cuts DB writes by
//                ~50x vs. one row per pointer event.
//   - REPLAY    on open, fetch all rows ordered by id and replay each
//                polyline through the DrawingLayer.
//   - CLEAR     local: layer.clearAll(); broadcast: a {action:'clear'}
//                stroke; persistent: delete every row for this whiteboard.

class WhiteboardSession {
  constructor({ huddle, channelId, whiteboard, tile }) {
    this.huddle = huddle;
    this.channelId = channelId;
    this.whiteboardId = whiteboard.id;
    this.tile = tile;
    this.layer = null;
    this._currentStroke = null;
  }

  async start() {
    // Drawing layer: identical to the screen-share annotation overlay, but
    // attached to a tile that has no underlying <video>.
    this.layer = new DrawingLayer({
      streamId: this.whiteboardId,
      // The DrawingLayer currently disables pointer events unless `active`
      // is set; whiteboards are always active.
      isOwner: true,
      send: (stroke) => this._onLocalStroke(stroke),
    });
    this.layer.attach(this.tile);
    this.layer.setActive(true);

    // Subscribe to live broadcast first so we don't miss strokes drawn
    // between the DB fetch and the subscribe.
    await this.huddle.ensureWhiteboardChannel(this.whiteboardId, (payload) => {
      // Don't double-paint our own strokes — broadcasts use {self:false}
      // but defensive check anyway.
      if (payload.from === this.huddle.peerId) return;
      this.layer.applyRemote(payload.stroke);
    });

    // Replay history.
    try {
      const rows = await this.huddle.fetchWhiteboardStrokes(this.whiteboardId);
      for (const row of rows) replayPolyline(this.layer, row.data);
    } catch (err) {
      console.warn('[whiteboard] history fetch failed', err);
    }
  }

  // Live stroke from the local user — broadcast immediately, accumulate for
  // persistence, and rely on the DrawingLayer to have already painted it.
  _onLocalStroke(stroke) {
    this.huddle.sendWhiteboardStroke(this.whiteboardId, stroke);
    if (stroke.action === 'begin') {
      this._currentStroke = {
        tool: stroke.tool, color: stroke.color, size: stroke.size,
        points: [[stroke.x, stroke.y]],
      };
    } else if (stroke.action === 'move' && this._currentStroke) {
      this._currentStroke.points.push([stroke.x, stroke.y]);
    } else if (stroke.action === 'end' && this._currentStroke) {
      const polyline = this._currentStroke;
      this._currentStroke = null;
      // Single-tap (no movement) leaves a single point; still useful for
      // arrow heads, so persist as long as there's any point at all.
      if (polyline.points.length >= 1) {
        this.huddle.persistWhiteboardStroke(this.whiteboardId, this.channelId, polyline)
          .catch((err) => console.warn('[whiteboard] persist failed', err));
      }
    }
  }

  async clear() {
    this.layer.clearAll(/*broadcast*/ false);
    this.huddle.sendWhiteboardStroke(this.whiteboardId, { action: 'clear' });
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
