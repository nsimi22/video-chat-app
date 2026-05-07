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

    // Subscribe to live broadcast first so we don't miss strokes drawn
    // between the DB fetch and the subscribe. The dedup Set below catches
    // any overlap with replayed history.
    await this.huddle.ensureWhiteboardChannel(this.whiteboardId, (payload) => {
      if (payload.from === this.huddle.peerId) return; // ignore self echoes
      const stroke = payload.stroke;
      this.layer.applyRemote(stroke);
      // Record completed strokes so a later history replay doesn't paint them again.
      if (stroke.action === 'end' && stroke.uuid) this._paintedUuids.add(stroke.uuid);
    });

    // Replay history.
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
