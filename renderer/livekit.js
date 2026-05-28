// LiveKit transport — sole call client on desktop.
//
// The mobile app is LiveKit-only, so desktop joining the same room
// is the only way the two ends can see each other in a call. The
// hand-rolled WebRTC mesh that used to live in renderer/webrtc.js
// has been removed; this is now the only path.
//
// Event mapping (LiveKit → renderer-shaped event):
//   participantConnected     → peer-joined { id, name, color }
//   participantDisconnected  → peer-left   (remoteId string)
//   trackSubscribed (remote) → track       { stream, track, fromId }
//                              (we synthesize one MediaStream per
//                              remote participant so the renderer's
//                              tile machinery — which keys off
//                              stream.id — keeps working without
//                              changes)
//   localTrackPublished /    →
//   localTrackUnpublished /  → mute-state  { from, micOn, camOn }
//   trackMuted / trackUnmuted
//
// huddle.joinCall(channelId) is still called alongside room.connect:
// it tracks team-side presence on the call topic so other team
// members see the "Join call · N" lurker pill. The LiveKit room
// handles the media plane (peer-joined / peer-left / track) directly.

(function () {
  const LK = window.LivekitClient;
  if (!LK) {
    console.warn('[livekit] LivekitClient global is missing; vendor/livekit.js may not have loaded');
    return;
  }

  // Cap concurrent screen shares across the call (local + remote combined).
  // Enforced optimistically per-client; a brief overshoot is possible if two
  // peers start sharing simultaneously, which is acceptable for a soft limit.
  // Exposed on window so the renderer's source-picker guard
  // (renderer/app.js:openSourcePicker) can compare against it without
  // reaching back into this module — same shape the deleted webrtc.js used.
  const MAX_CONCURRENT_SCREENS = 3;

  // Per-participant synthesized MediaStream cache. LiveKit gives us
  // individual MediaStreamTracks per `trackSubscribed`; the renderer's
  // onTrack handler in app.js keys tiles off stream.id, so we keep one
  // MediaStream per identity and add audio + video tracks to it as
  // they arrive. Re-emitting 'track' for the second track is fine —
  // the renderer dedupes via pendingStreams.has(stream.id).
  function makeParticipantStreamCache() {
    const byIdentity = new Map(); // identity -> MediaStream
    return {
      get(identity) {
        let s = byIdentity.get(identity);
        if (!s) {
          s = new MediaStream();
          byIdentity.set(identity, s);
        }
        return s;
      },
      drop(identity) {
        const s = byIdentity.get(identity);
        if (s) for (const t of s.getTracks()) s.removeTrack(t);
        byIdentity.delete(identity);
      },
      clear() {
        for (const s of byIdentity.values()) {
          for (const t of s.getTracks()) s.removeTrack(t);
        }
        byIdentity.clear();
      },
    };
  }

  class LivekitCallClient extends EventTarget {
    constructor(huddle) {
      super();
      this.huddle = huddle;
      this.room = null;
      this.cameraStream = null; // composite local MediaStream for the self-cam tile
      this._micOn = true;
      this._camOn = true;
      this._streams = makeParticipantStreamCache();
      // Background-blur state. _rawTrack is a long-lived clone of the
      // LK-published raw camera track — needed because replaceTrack
      // stops the previous MediaStreamTrack, and a stopped track can
      // never resume. Cloning lets us swap back to a still-live source
      // when blur is toggled off.
      this._blurOn = false;
      this._blurPipeline = null;
      this._rawTrack = null;
      // Local screen shares. addScreen returns a real MediaStream the
      // renderer can attach to a tile, and removeScreen can clean up by
      // id. `_pendingScreens` reserves a slot while getUserMedia is in
      // flight so rapid concurrent calls don't all pass the MAX cap check.
      this._screenStreams = new Map(); // streamId -> { stream, label, publication }
      this._pendingScreens = 0;
      // Remote screen tracks indexed by track sid so trackUnsubscribed
      // (and participantDisconnected if it races ahead of per-track
      // unsubscribes) can find the MediaStream and tear the tile down.
      // Value carries the participant identity so we can clean up all
      // of a leaving participant's screens at once.
      this._remoteScreens = new Map(); // trackSid -> { stream, fromId }

      this._bound = [];
      const wire = (event, handler) => {
        huddle.addEventListener(event, handler);
        this._bound.push([event, handler]);
      };
      // Pass-through events from the HuddleClient so listeners attached
      // to this client receive call-channel broadcasts (raise-hand,
      // reactions, mute-state) and chat events. Media-plane events
      // (peer-joined / peer-left / track / active-speaker) are NOT in
      // this list — they come from the LiveKit room directly.
      const FORWARD = [
        'welcome', 'connected',
        'screen-announce', 'screen-stop', 'draw', 'typing',
        'raise-hand', 'reaction', 'mute-state',
        'chat-message', 'chat-update', 'chat-message-deleted',
        'chat-channel-added', 'chat-channel-removed',
        'saved-message-added', 'saved-message-updated', 'saved-message-removed',
      ];
      for (const ev of FORWARD) {
        wire(ev, (e) => this.dispatchEvent(new CustomEvent(ev, { detail: e.detail })));
      }
    }

    // --- Pass-through accessors -------------------------------------------
    get peerId() { return this.huddle.peerId; }
    get name() { return this.huddle.name; }
    get color() { return this.huddle.color; }
    get peerInfo() { return this.huddle.peerInfo; }
    get remoteScreenLabels() { return this.huddle.remoteScreenLabels; }
    get teamMeta() { return this.huddle.team; }
    get url() { return this.huddle.url; }
    get raisedHands() { return this.huddle.raisedHands; }
    get screenStreams() { return this._screenStreams; }
    get blurOn() { return this._blurOn; }

    // --- Chat passthroughs ------------------------------------------------
    sendMessage(args)        { return this.huddle.sendMessage(args); }
    sendAiMessage(args)      { return this.huddle.sendAiMessage(args); }
    editMessage(id, text)    { return this.huddle.editMessage(id, text); }
    deleteMessage(id)        { return this.huddle.deleteMessage(id); }
    pinMessage(id, pin)      { return this.huddle.pinMessage(id, pin); }
    loadPinnedMessages(c)    { return this.huddle.loadPinnedMessages(c); }
    pinnedMessageCount(c)    { return this.huddle.pinnedMessageCount(c); }
    saveMessage(args)        { return this.huddle.saveMessage(args); }
    unsaveMessage(id)        { return this.huddle.unsaveMessage(id); }
    loadSavedMessages(opts)  { return this.huddle.loadSavedMessages(opts); }
    toggleReaction(id, e)    { return this.huddle.toggleReaction(id, e); }
    sendTyping(c, p)         { return this.huddle.sendTyping(c, p); }
    loadHistory(c, opts)     { return this.huddle.loadHistory(c, opts); }
    createChannel(args)      { return this.huddle.createChannel(args); }
    createDm(userId, name)   { return this.huddle.createDm(userId, name); }
    deleteChannel(id)        { return this.huddle.deleteChannel(id); }
    searchMessages(q, c)     { return this.huddle.searchMessages(q, c); }
    uploadFile(f)            { return this.huddle.uploadFile(f); }

    // --- Call-channel passthroughs (raise-hand + reactions ride the
    //     huddle broadcast like chat events). Drawing on a shared screen
    //     calls state.huddle.sendDraw directly from app.js, so it isn't
    //     mirrored here.
    sendRaiseHand(r)  { return this.huddle.sendRaiseHand(r); }
    sendReaction(e)   { return this.huddle.sendReaction(e); }
    get activeScreenCount() {
      return this._screenStreams.size + this._pendingScreens + this.huddle.remoteScreenLabels.size;
    }

    // --- Screen share -----------------------------------------------------
    //
    // Local: Electron desktopCapturer getUserMedia → publish as LK
    // ScreenShare source with the user-facing label as the publication
    // name. Multi-screen works because publishTrack creates an
    // additional publication each call (setScreenShareEnabled only
    // manages a single LK-tracked screen, which would cap us at 1).
    //
    // Remote: trackSubscribed with source=ScreenShare lands a screen
    // track; we wrap it in its own MediaStream (separate from the
    // participant's camera stream) and populate huddle.remoteScreenLabels
    // locally so the renderer's onTrack lookup matches by stream.id.
    // LK's track.source classifies camera vs screen directly — no
    // separate cross-client announce broadcast is needed.

    async addScreen(sourceId, label) {
      if (!this.room) throw new Error('addScreen before connect');
      if (this.activeScreenCount >= MAX_CONCURRENT_SCREENS) {
        throw new Error(`Screen-share limit reached (${MAX_CONCURRENT_SCREENS} max).`);
      }
      // Reserve a slot before awaiting getUserMedia so two quick clicks
      // can't both pass the check.
      this._pendingScreens++;
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30,
            },
          },
        });
      } finally {
        this._pendingScreens--;
      }
      const screenTrack = stream.getVideoTracks()[0];
      if (!screenTrack) {
        for (const t of stream.getTracks()) t.stop();
        throw new Error('screen capture returned no video track');
      }
      let publication;
      try {
        publication = await this.room.localParticipant.publishTrack(screenTrack, {
          source: LK.Track.Source.ScreenShare,
          name: label,
        });
      } catch (err) {
        for (const t of stream.getTracks()) t.stop();
        throw err;
      }
      // Stamp the LK trackSid as a cross-client share id. The renderer
      // (shareIdFor in app.js) reads this for tile / draw-layer keys so
      // drawing strokes from this side match the same key on remote
      // receivers (who also stash trackSid in _onTrackSubscribed).
      stream.__huddleShareId = publication.trackSid;
      // Drawing strokes ride a per-screen Supabase channel named
      // `screen:${shareId}`. Open it eagerly here (and again on the
      // receiver side in _onTrackSubscribed) so the first sendDraw
      // broadcast from app.js lands on a channel both ends are
      // subscribed to.
      if (publication.trackSid) {
        this.huddle._ensureScreenChannel(publication.trackSid).catch(() => {});
      }
      this._screenStreams.set(stream.id, { stream, label, publication });
      // OS-level "stop sharing" indicator ends the track; route that
      // back through removeScreen so the publication is unpublished
      // and tiles drop on every client.
      screenTrack.addEventListener('ended', () => this.removeScreen(stream.id));
      return stream;
    }

    async removeScreen(streamId) {
      const entry = this._screenStreams.get(streamId);
      if (!entry) return;
      this._screenStreams.delete(streamId);
      try {
        if (entry.publication?.track) {
          await this.room?.localParticipant.unpublishTrack(entry.publication.track);
        }
      } catch (err) {
        console.warn('[livekit] unpublishTrack failed', err);
      }
      for (const t of entry.stream.getTracks()) {
        try { t.stop(); } catch {}
      }
      // Dispatch a local `screen-stop` so the sender's own tile
      // (keyed by `screen:${shareId}`) gets torn down by onScreenStop.
      // Without this the local tile lingers with a frozen last frame
      // — remote tiles drop naturally via TrackUnsubscribed.
      const shareId = entry.stream.__huddleShareId || entry.stream.id;
      this.dispatchEvent(new CustomEvent('screen-stop', {
        detail: { from: this.peerId, streamId: shareId },
      }));
    }

    // --- Background blur --------------------------------------------------
    //
    // Same MediaPipe-driven pipeline mesh uses (renderer/blur-pipeline.js).
    // The pipeline takes a MediaStream in and emits a canvas-derived
    // MediaStream out; we wire that canvas track into LK by calling
    // `LocalVideoTrack.replaceTrack(canvasTrack)` — LK's equivalent of
    // mesh's per-sender replaceTrack. Going back to raw means another
    // replaceTrack with our cloned raw source.
    //
    // Deferred (Phase 2.1 if it ever matters): re-running the pipeline
    // after `flipCamera` / `restartTrack`. The current code holds a clone
    // of the *original* raw track; switching cameras would create a new
    // underlying source that we wouldn't be piping through the pipeline.
    // The user has flagged flip-camera as broken regardless, so this
    // ordering is fine for now.
    async setBlurBackground(on) {
      on = !!on;
      if (this._blurOn === on) return;
      if (!this.room) {
        // Camera not up yet — record the preference; the next setCamera
        // or applyPersistedBlurPreference loop will re-call us.
        this._blurOn = on;
        return;
      }
      const camPub = this.room.localParticipant.getTrackPublication(LK.Track.Source.Camera);
      const lkTrack = camPub?.videoTrack;
      if (!lkTrack) {
        this._blurOn = on;
        return;
      }

      if (on) {
        if (!window.BlurPipeline?.isAvailable()) {
          throw new Error('Blur pipeline is not available');
        }
        // Snapshot a long-lived clone of the raw camera track. We clone
        // (a) so LK can stop "its" track when replaceTrack swaps in the
        // canvas, without ending our copy; (b) only once per call, so
        // repeated blur on/off cycles don't accumulate live clones.
        if (!this._rawTrack || this._rawTrack.readyState === 'ended') {
          this._rawTrack = lkTrack.mediaStreamTrack.clone();
        }
        const rawStream = new MediaStream([this._rawTrack]);
        const pipeline = new window.BlurPipeline();
        let blurredStream;
        try {
          blurredStream = await pipeline.start(rawStream);
        } catch (err) {
          try { pipeline.stop(); } catch {}
          throw err;
        }
        const canvasTrack = blurredStream.getVideoTracks()[0];
        if (!canvasTrack) {
          try { pipeline.stop(); } catch {}
          throw new Error('blur pipeline returned no video track');
        }
        try {
          await lkTrack.replaceTrack(canvasTrack);
        } catch (err) {
          try { pipeline.stop(); } catch {}
          throw err;
        }
        this._blurPipeline = pipeline;
        this._blurOn = true;
      } else {
        if (this._rawTrack && this._rawTrack.readyState !== 'ended') {
          // Pass a fresh clone — LK may stop the track it accepts here,
          // and we want _rawTrack to stay alive in case the user toggles
          // blur back on without leaving the call.
          try {
            await lkTrack.replaceTrack(this._rawTrack.clone());
          } catch (err) {
            console.warn('[livekit] replaceTrack(raw) failed', err);
          }
        }
        if (this._blurPipeline) {
          try { this._blurPipeline.stop(); } catch {}
          this._blurPipeline = null;
        }
        this._blurOn = false;
      }

      // The self-cam tile binds <video>.srcObject to this.cameraStream.
      // Swapping the publication's underlying track changes the
      // MediaStream identity our composite reports, so refresh + dispatch
      // camera-stream-changed for the renderer to re-point its srcObject.
      this._refreshLocalCameraStream();
    }

    // --- Connect / disconnect ---------------------------------------------
    //
    // joinCall(channelId) on the HuddleClient is the team-side presence
    // hook (it broadcasts "this user is on the call channel" to other
    // team members so the lurker UI updates). Call it before connecting
    // the LiveKit room so presence is accurate even if the LK connect
    // takes a moment.
    async connect(channelId, opts = {}) {
      const team = this.huddle.team;
      if (!team?.id || !channelId) throw new Error('connect: team + channelId required');
      // `purpose: 'screen-popout'` flags this connection as a subscribe-
      // only popout client. The edge function mints a token under a
      // suffixed identity (so the main window's connection isn't kicked
      // on identity collision) and strips publish grants. The popout
      // also short-circuits camera/mic enable below.
      const purpose = opts.purpose || null;
      this._purpose = purpose;
      const { data, error } = await this.huddle.supabase.functions.invoke('livekit-token', {
        body: { team_id: team.id, channel_id: channelId, ...(purpose ? { purpose } : {}) },
      });
      if (error) throw new Error(`livekit-token failed: ${error.message || error}`);
      if (!data?.token || !data?.url) throw new Error('livekit-token returned no token');

      const room = new LK.Room({
        adaptiveStream: true,
        dynacast: true,
      });
      this.room = room;
      this._wireRoomEvents(room);

      await room.connect(data.url, data.token);
      // Pull existing remote participants into the renderer right away
      // — participantConnected only fires for joins AFTER our connect
      // resolves, so anyone already in the room would be invisible
      // without this bootstrap.
      for (const remote of room.remoteParticipants.values()) {
        this._onParticipantConnected(remote);
        for (const pub of remote.trackPublications.values()) {
          if (pub.isSubscribed && pub.track) this._onTrackSubscribed(pub.track, pub, remote);
        }
      }

      if (purpose !== 'screen-popout') {
        await room.localParticipant.setMicrophoneEnabled(true);
        await room.localParticipant.setCameraEnabled(true);
        this._refreshLocalCameraStream();
      }
    }

    _wireRoomEvents(room) {
      const RE = LK.RoomEvent;
      room.on(RE.ParticipantConnected, (p) => this._onParticipantConnected(p));
      room.on(RE.ParticipantDisconnected, (p) => this._onParticipantDisconnected(p));
      room.on(RE.TrackSubscribed, (track, pub, participant) => this._onTrackSubscribed(track, pub, participant));
      room.on(RE.TrackUnsubscribed, (track, pub, participant) => this._onTrackUnsubscribed(track, pub, participant));
      // Local mute state changes — keep _micOn/_camOn truthful and
      // broadcast over the huddle so remote peers can update their
      // tile overlays.
      room.on(RE.LocalTrackPublished, (pub) => this._syncLocalMuteFromPub(pub));
      room.on(RE.LocalTrackUnpublished, (pub) => this._syncLocalMuteFromPub(pub));
      room.on(RE.TrackMuted, (pub, participant) => {
        if (participant.isLocal) this._syncLocalMuteFromPub(pub);
      });
      room.on(RE.TrackUnmuted, (pub, participant) => {
        if (participant.isLocal) this._syncLocalMuteFromPub(pub);
      });
      // LK applies its own audio-level threshold server-side; an empty
      // array means nobody is above it (silence). Re-emit as a single
      // 'active-speaker' event keyed by identity so the renderer can
      // light up exactly one tile without running a per-pc getStats()
      // poll loop.
      room.on(RE.ActiveSpeakersChanged, (speakers) => {
        const top = speakers[0];
        this.dispatchEvent(new CustomEvent('active-speaker', {
          detail: { peerId: top ? top.identity : null },
        }));
      });
      room.on(RE.Disconnected, () => {
        // Disconnected fires both when WE call room.disconnect() (graceful
        // leave) and when the SFU drops us (auth expired, network gone).
        // Only surface the latter — the graceful path is already a
        // user-initiated teardown via leaveCall.
        if (this._closing) return;
        this.dispatchEvent(new CustomEvent('connection-failed', { detail: { reason: 'livekit disconnected' } }));
      });
    }

    // Popout (subscribe-only) clients suffix their LK identity with
    // `::popout::<uuid>` (see supabase/functions/livekit-token/index.ts).
    // They join the same room as a parallel subscriber so a screen-share
    // tile can pop out into its own BrowserWindow without colliding on
    // identity. From the rest of the call's POV they're not real
    // participants — filter them out of peer-joined / peer-left so the
    // roster, tiles, and presence pings ignore them entirely.
    _isPopoutIdentity(identity) {
      return typeof identity === 'string' && identity.includes('::popout::');
    }

    _onParticipantConnected(p) {
      if (this._isPopoutIdentity(p.identity)) return;
      this.dispatchEvent(new CustomEvent('peer-joined', {
        detail: { id: p.identity, name: p.name || p.identity, color: null },
      }));
      // The new joiner doesn't see our current mic/cam state — LK carries
      // an isMuted flag on each publication, but the renderer reads from
      // huddle.peerMediaState which is only populated by mute-state
      // broadcasts on the call channel. Re-emit our state so their tile
      // overlay shows the right icons without waiting for our next toggle.
      if (this.room?.localParticipant) {
        this.huddle.sendMuteState(this._micOn, this._camOn);
      }
    }

    _onParticipantDisconnected(p) {
      if (this._isPopoutIdentity(p.identity)) return;
      // Tear down any screen-share tiles for this participant before the
      // peer-left handler removes their main tile. LK *should* fire
      // TrackUnsubscribed for each publication before
      // ParticipantDisconnected, but the SDK doesn't guarantee that
      // order — and a missed cleanup leaves the screen tile orphaned
      // with a dead <video> until reload.
      for (const trackSid of [...this._remoteScreens.keys()]) {
        if (this._remoteScreens.get(trackSid)?.fromId === p.identity) {
          this._dropRemoteScreen(trackSid);
        }
      }
      this._streams.drop(p.identity);
      this.dispatchEvent(new CustomEvent('peer-left', { detail: p.identity }));
    }

    // Shared teardown for a remote screen track — used both when LK
    // sends TrackUnsubscribed and when ParticipantDisconnected races
    // ahead of per-track unsubscribes. Idempotent; safe to call twice.
    _dropRemoteScreen(trackSid) {
      const entry = this._remoteScreens.get(trackSid);
      if (!entry) return;
      this._remoteScreens.delete(trackSid);
      const shareId = entry.stream.__huddleShareId || entry.stream.id;
      this.huddle.remoteScreenLabels.delete(shareId);
      this.dispatchEvent(new CustomEvent('remote-stream-ended', {
        detail: { fromId: entry.fromId, streamId: shareId },
      }));
    }

    _onTrackSubscribed(track, pub, participant) {
      const mediaStreamTrack = track.mediaStreamTrack;
      // Defensive null-check — TrackSubscribed normally hands us a
      // mediaStreamTrack, but the SDK leaves it nullable in the type
      // signature. Skip rather than dispatch an empty stream that would
      // render as a frozen black tile.
      if (!mediaStreamTrack) return;
      if (track.source === LK.Track.Source.ScreenShare) {
        // Each remote screen gets its own MediaStream so the renderer's
        // tile keying treats it as a distinct surface from the
        // participant's camera. Stamp the trackSid as the share id so
        // drawing strokes from the sender (also keyed by trackSid via
        // their __huddleShareId stamp in addScreen) match.
        const stream = new MediaStream();
        stream.addTrack(mediaStreamTrack);
        if (pub.trackSid) stream.__huddleShareId = pub.trackSid;
        // Populate huddle.remoteScreenLabels locally so the renderer's
        // onTrack lookup classifies this as a screen instead of waiting
        // for the (never-arriving) camera-vs-screen commit timer.
        // Keyed by the share id (= trackSid) to stay consistent with
        // the tile / draw-layer key the renderer uses.
        const shareId = stream.__huddleShareId || stream.id;
        this.huddle.remoteScreenLabels.set(shareId, {
          label: pub.trackName || 'Screen',
          fromName: participant.name || participant.identity,
          from: participant.identity,
        });
        if (pub.trackSid) {
          this._remoteScreens.set(pub.trackSid, { stream, fromId: participant.identity });
          // Pre-subscribe to the sender's drawing channel so their
          // strokes flow through to onRemoteDraw. Mesh receivers do
          // this on the screen-announce broadcast (api.js:291); the
          // LK transport handles screen-announce locally so we wire
          // the subscription directly.
          this.huddle._ensureScreenChannel(pub.trackSid).catch(() => {});
        }
        this.dispatchEvent(new CustomEvent('track', {
          detail: { stream, track: mediaStreamTrack, fromId: participant.identity },
        }));
        return;
      }
      // Camera (default) — share one MediaStream per participant so
      // audio + video subscribed separately land in the same tile.
      const stream = this._streams.get(participant.identity);
      if (!stream.getTracks().includes(mediaStreamTrack)) {
        stream.addTrack(mediaStreamTrack);
      }
      this.dispatchEvent(new CustomEvent('track', {
        detail: { stream, track: mediaStreamTrack, fromId: participant.identity },
      }));
    }

    _onTrackUnsubscribed(track, pub, participant) {
      if (track.source === LK.Track.Source.ScreenShare) {
        if (pub.trackSid) this._dropRemoteScreen(pub.trackSid);
        return;
      }
      // Camera — leave the per-participant MediaStream in place and let
      // the <video> element naturally stop rendering the unsubscribed
      // track. peer-left from participantDisconnected does the full
      // tile teardown.
      const stream = this._streams.get(participant.identity);
      const mediaStreamTrack = track.mediaStreamTrack;
      if (mediaStreamTrack) stream.removeTrack(mediaStreamTrack);
    }

    _syncLocalMuteFromPub(pub) {
      const source = pub.source || pub.track?.source;
      // LiveKit's Track.Source enum: Microphone / Camera / ScreenShare / Unknown
      if (source === LK.Track.Source.Microphone) {
        this._micOn = !pub.isMuted;
      } else if (source === LK.Track.Source.Camera) {
        this._camOn = !pub.isMuted;
        this._refreshLocalCameraStream();
      } else {
        return;
      }
      this.huddle.sendMuteState(this._micOn, this._camOn);
    }

    // Mesh exposes a single `cameraStream` MediaStream that the renderer
    // binds to the self-cam <video>.srcObject. LiveKit gives us the
    // local tracks individually — bundle them so consumers don't change.
    _refreshLocalCameraStream() {
      if (!this.room) return;
      const lp = this.room.localParticipant;
      const camPub = lp.getTrackPublication(LK.Track.Source.Camera);
      const micPub = lp.getTrackPublication(LK.Track.Source.Microphone);
      const stream = new MediaStream();
      const camTrack = camPub?.track?.mediaStreamTrack;
      const micTrack = micPub?.track?.mediaStreamTrack;
      if (camTrack) stream.addTrack(camTrack);
      if (micTrack) stream.addTrack(micTrack);
      const prev = this.cameraStream;
      this.cameraStream = stream;
      // Mirror the camera-stream-changed event so the self-cam tile
      // re-points its srcObject when the published stream identity
      // changes (e.g. setCameraEnabled flipped on, fresh track).
      if (!prev || prev.id !== stream.id) {
        this.dispatchEvent(new CustomEvent('camera-stream-changed', { detail: { stream } }));
      }
    }

    // setCamera surfaces a single MediaStream (camera + mic combined)
    // for the self-cam tile; LiveKit owns getUserMedia internally so
    // we just toggle publication and bundle the resulting tracks.
    async setCamera(constraints = { video: true, audio: true }) {
      if (!this.room) throw new Error('setCamera before connect');
      await this.room.localParticipant.setMicrophoneEnabled(!!constraints.audio);
      await this.room.localParticipant.setCameraEnabled(!!constraints.video);
      this._refreshLocalCameraStream();
      return this.cameraStream;
    }

    toggleMic() {
      if (!this.room) return false;
      const next = !this._micOn;
      // Fire-and-forget on the promise. _syncLocalMuteFromPub will
      // emit mute-state when the publication state actually flips.
      this.room.localParticipant.setMicrophoneEnabled(next).catch((err) => console.warn('[livekit] toggleMic', err));
      return next;
    }

    toggleCam() {
      if (!this.room) return false;
      const next = !this._camOn;
      this.room.localParticipant.setCameraEnabled(next).catch((err) => console.warn('[livekit] toggleCam', err));
      return next;
    }

    disconnect() {
      // Signal the Disconnected handler that the upcoming room.disconnect
      // is intentional, so it doesn't fire a spurious connection-failed
      // event that would re-enter leaveCall with a misleading banner.
      this._closing = true;
      // Stop any active local screen captures before we close the room —
      // unpublishTrack would error on a disconnected room and OS-level
      // capture indicators must go away regardless.
      for (const entry of this._screenStreams.values()) {
        for (const t of entry.stream.getTracks()) {
          try { t.stop(); } catch {}
        }
      }
      this._screenStreams.clear();
      this._remoteScreens.clear();
      if (this._blurPipeline) {
        try { this._blurPipeline.stop(); } catch {}
        this._blurPipeline = null;
      }
      if (this._rawTrack) {
        try { this._rawTrack.stop(); } catch {}
        this._rawTrack = null;
      }
      this._blurOn = false;
      if (this.room) {
        try { this.room.disconnect(); } catch (err) { console.warn('[livekit] disconnect', err); }
        this.room = null;
      }
      this._streams.clear();
      this.cameraStream = null;
      for (const [event, handler] of this._bound) {
        try { this.huddle.removeEventListener(event, handler); } catch {}
      }
      this._bound = [];
    }
  }

  window.LivekitCallClient = LivekitCallClient;
  window.MAX_CONCURRENT_SCREENS = MAX_CONCURRENT_SCREENS;
})();
