// LiveKit transport — Phase 1 spike (PR #X, see desktop/livekit-spike).
//
// Hand-rolled WebRTC mesh in webrtc.js stays the default; this file
// lets the desktop join a call through a LiveKit SFU instead, so a
// desktop client can finally see a mobile client (which has always
// been LiveKit-only). Selected at startCall time by reading
// localStorage['huddle.useLivekit'] === 'true' — Phase 2 will move
// the toggle into the Settings UI.
//
// Public API matches the subset of MeshClient that the rest of the
// renderer (app.js, chat.js, popout) consumes for a basic camera+mic
// call. Surfaces deliberately deferred to Phase 2:
//   - addScreen / removeScreen / screen-announce / screen-stop
//   - background blur (setBlurBackground, blurOn)
//   - drawing (sendDraw)
//   - raise-hand (sendRaiseHand)
//   - reactions overlay (sendReaction, REACTION_EMOJI floating)
//   - simulcast / per-tier screen encoding bookkeeping
// Those methods exist as no-ops so consumers don't throw; they log a
// one-line "not supported in LiveKit mode" the first time each is hit.
//
// Event mapping (LiveKit → mesh-shaped event):
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
// Identity coexistence note: a user joining via LiveKit also calls
// huddle.joinCall(channelId) to keep team-side presence accurate
// (lurker counts, "Join call · N" pill). Mesh users in the same
// channel will see this user in presence but can't form a PeerConn
// with them — that's expected behavior for the spike. Phase 2 will
// either ship the LiveKit transport to everyone or add a
// transport-aware presence filter.

(function () {
  const LK = window.LivekitClient;
  if (!LK) {
    console.warn('[livekit] LivekitClient global is missing; vendor/livekit.js may not have loaded');
    return;
  }

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
      // Track-mute warnings only fire once per surface so a normal call
      // doesn't spam the console while the user is exploring features
      // that aren't ported yet.
      this._warnedMissing = new Set();

      this._bound = [];
      const wire = (event, handler) => {
        huddle.addEventListener(event, handler);
        this._bound.push([event, handler]);
      };
      // Pass-through events from the HuddleClient so listeners attached
      // to this client receive them just like they would from MeshClient.
      // Media-plane events (peer-joined / peer-left / track) are NOT in
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

    // --- Pass-through accessors (match MeshClient public API) -------------
    get peerId() { return this.huddle.peerId; }
    get name() { return this.huddle.name; }
    get color() { return this.huddle.color; }
    get peerInfo() { return this.huddle.peerInfo; }
    get remoteScreenLabels() { return this.huddle.remoteScreenLabels; }
    get teamMeta() { return this.huddle.team; }
    get url() { return this.huddle.url; }
    get raisedHands() { return this.huddle.raisedHands; }
    get screenStreams() { return new Map(); } // none in Phase 1
    get blurOn() { return false; }            // none in Phase 1

    // --- Chat passthroughs (verbatim mirror of MeshClient) ----------------
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

    // --- Phase-2 stubs (logged once, then silent) -------------------------
    addScreen()       { this._warnOnce('addScreen'); return Promise.reject(new Error('Screen share is not supported in the LiveKit spike yet')); }
    removeScreen()    { this._warnOnce('removeScreen'); }
    setBlurBackground() { this._warnOnce('setBlurBackground'); return Promise.resolve(); }
    sendDraw()        { /* whiteboard rides on huddle, not mesh; safe no-op */ }
    sendRaiseHand(r)  { return this.huddle.sendRaiseHand(r); }
    sendReaction(e)   { return this.huddle.sendReaction(e); }
    get activeScreenCount() { return this.huddle.remoteScreenLabels.size; }

    _warnOnce(name) {
      if (this._warnedMissing.has(name)) return;
      this._warnedMissing.add(name);
      console.warn(`[livekit] ${name}() is a no-op in the Phase 1 spike (mesh-only feature)`);
    }

    // --- Connect / disconnect ---------------------------------------------
    //
    // joinCall(channelId) on the HuddleClient is the team-side presence
    // hook (it broadcasts "this user is on the call channel" to other
    // team members so the lurker UI updates). Call it before connecting
    // the LiveKit room so presence is accurate even if the LK connect
    // takes a moment.
    async connect(channelId) {
      const team = this.huddle.team;
      if (!team?.id || !channelId) throw new Error('connect: team + channelId required');
      const { data, error } = await this.huddle.supabase.functions.invoke('livekit-token', {
        body: { team_id: team.id, channel_id: channelId },
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

      await room.localParticipant.setMicrophoneEnabled(true);
      await room.localParticipant.setCameraEnabled(true);
      this._refreshLocalCameraStream();
    }

    _wireRoomEvents(room) {
      const RE = LK.RoomEvent;
      room.on(RE.ParticipantConnected, (p) => this._onParticipantConnected(p));
      room.on(RE.ParticipantDisconnected, (p) => this._onParticipantDisconnected(p));
      room.on(RE.TrackSubscribed, (track, pub, participant) => this._onTrackSubscribed(track, pub, participant));
      room.on(RE.TrackUnsubscribed, (track, pub, participant) => this._onTrackUnsubscribed(track, pub, participant));
      // Local mute state changes — keep _micOn/_camOn truthful and
      // broadcast over the huddle so mesh-mode peers (and future
      // LK-mode peers) can update their tile overlays.
      room.on(RE.LocalTrackPublished, (pub) => this._syncLocalMuteFromPub(pub));
      room.on(RE.LocalTrackUnpublished, (pub) => this._syncLocalMuteFromPub(pub));
      room.on(RE.TrackMuted, (pub, participant) => {
        if (participant.isLocal) this._syncLocalMuteFromPub(pub);
      });
      room.on(RE.TrackUnmuted, (pub, participant) => {
        if (participant.isLocal) this._syncLocalMuteFromPub(pub);
      });
      room.on(RE.Disconnected, () => {
        // Surface unexpected disconnects to the renderer so it can
        // clean up state (similar to mesh's connection-failure path).
        this.dispatchEvent(new CustomEvent('connection-failed', { detail: { reason: 'livekit disconnected' } }));
      });
    }

    _onParticipantConnected(p) {
      this.dispatchEvent(new CustomEvent('peer-joined', {
        detail: { id: p.identity, name: p.name || p.identity, color: null },
      }));
    }

    _onParticipantDisconnected(p) {
      this._streams.drop(p.identity);
      this.dispatchEvent(new CustomEvent('peer-left', { detail: p.identity }));
    }

    _onTrackSubscribed(track, pub, participant) {
      // Wrap the LiveKit track in a per-participant synthesized
      // MediaStream so the renderer's onTrack handler (which keys
      // tiles off stream.id) only creates one tile per remote
      // participant instead of one per track.
      const stream = this._streams.get(participant.identity);
      const mediaStreamTrack = track.mediaStreamTrack;
      if (mediaStreamTrack && !stream.getTracks().includes(mediaStreamTrack)) {
        stream.addTrack(mediaStreamTrack);
      }
      this.dispatchEvent(new CustomEvent('track', {
        detail: { stream, track: mediaStreamTrack, fromId: participant.identity },
      }));
    }

    _onTrackUnsubscribed(track, pub, participant) {
      const stream = this._streams.get(participant.identity);
      const mediaStreamTrack = track.mediaStreamTrack;
      if (mediaStreamTrack) stream.removeTrack(mediaStreamTrack);
      // No event emitted — the renderer's tile keeps the stream object
      // and the <video> element naturally stops showing the track.
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

    // setCamera mirrors MeshClient's API for callers, but LiveKit
    // owns getUserMedia internally — we just toggle publication.
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

    bootstrapExistingPeers() {
      // No-op on LiveKit — connect() already iterated remoteParticipants
      // before resolving. Kept for API parity with MeshClient.
    }

    disconnect() {
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

  // Feature-flag readout. Phase 2 will move this into the Settings panel;
  // for the spike a localStorage toggle is enough — flip it in DevTools:
  //   localStorage.setItem('huddle.useLivekit', 'true')
  window.huddleUseLivekit = function huddleUseLivekit() {
    try { return localStorage.getItem('huddle.useLivekit') === 'true'; }
    catch { return false; }
  };
  window.LivekitCallClient = LivekitCallClient;
})();
