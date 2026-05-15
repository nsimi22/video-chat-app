// WebRTC mesh manager.
//
// Topology: full mesh — every peer holds one RTCPeerConnection per other
// peer. Signaling rides on a Supabase Realtime broadcast channel; this
// module no longer talks to a WebSocket. Instead a MeshClient wraps a
// `HuddleClient` (from api.js) which owns the realtime channel + chat
// persistence; MeshClient adds camera/microphone, screen sharing, and
// peer-connection lifecycle on top.
//
// Public API (mostly identical to the previous WebSocket-based MeshClient
// so chat.js and app.js can keep their existing listeners):
//   - peerInfo, remoteScreenLabels, peerId, name, color, teamMeta, url
//   - setCamera, toggleMic, toggleCam
//   - addScreen, removeScreen, screenStreams
//   - chat passthroughs: sendMessage, editMessage, deleteMessage,
//     toggleReaction, sendTyping, loadHistory, createChannel, createDm,
//     deleteChannel, searchMessages, uploadFile
//   - disconnect()
//   - events: welcome, connected, peer-joined, peer-left, signal, track,
//     remote-stream-ended, screen-announce, screen-stop, draw, typing,
//     chat-message, chat-update, chat-message-deleted, chat-channel-added,
//     chat-channel-removed

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

// Cap concurrent screen shares across the call (local + remote combined).
// Enforced optimistically per-client; a brief overshoot is possible if two
// peers start sharing simultaneously, which is acceptable for a soft limit.
const MAX_CONCURRENT_SCREENS = 3;

// Outbound screen-share quality tiers. The mesh duplicates each share's
// upload once per viewer, so per-peer caps multiply quickly — these tiers
// throttle each copy as the call grows. Cameras are left at their default
// encodings; faces benefit from steady quality and don't dominate the wire
// the way 1080p screen content does.
const SCREEN_ENCODING_TIERS = [
  { maxPeers: 1,        maxBitrate: 2_500_000, maxFramerate: 30 },
  { maxPeers: 3,        maxBitrate: 1_200_000, maxFramerate: 24 },
  { maxPeers: Infinity, maxBitrate:   600_000, maxFramerate: 15 },
];

function pickScreenEncoding(peerCount) {
  return SCREEN_ENCODING_TIERS.find((t) => peerCount <= t.maxPeers);
}

class PeerConn {
  constructor({ remoteId, signal, polite, onTrack, onScreenStop }) {
    this.remoteId = remoteId;
    this.polite = polite;
    this.signal = signal;
    this.onTrack = onTrack;
    this.onScreenStop = onScreenStop;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onicecandidate = (e) => { if (e.candidate) signal({ candidate: e.candidate }); };
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        signal({ description: this.pc.localDescription });
      } catch (err) { console.error('negotiation error', err); }
      finally { this.makingOffer = false; }
    };
    this.pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      onTrack(stream, e.track, this.remoteId);
      stream.onremovetrack = () => {
        if (stream.getTracks().length === 0) onScreenStop(this.remoteId, stream.id);
      };
    };
  }

  async handleSignal(payload) {
    const { description, candidate } = payload;
    try {
      if (description) {
        const offerCollision = description.type === 'offer'
          && (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await this.pc.setLocalDescription();
          this.signal({ description: this.pc.localDescription });
        }
      } else if (candidate) {
        try { await this.pc.addIceCandidate(candidate); }
        catch (err) { if (!this.ignoreOffer) throw err; }
      }
    } catch (err) { console.error('signal error', err); }
  }

  addStream(stream) { for (const t of stream.getTracks()) this.pc.addTrack(t, stream); }
  removeStream(stream) {
    for (const sender of this.pc.getSenders()) {
      if (sender.track && stream.getTracks().includes(sender.track)) {
        try { this.pc.removeTrack(sender); } catch {}
      }
    }
  }
  close() { try { this.pc.close(); } catch {} }
}

class MeshClient extends EventTarget {
  constructor(huddle) {
    super();
    this.huddle = huddle;
    this.peers = new Map();             // remoteId -> PeerConn
    this.cameraStream = null;
    // The unprocessed getUserMedia stream. When blur is off it's the
    // same MediaStream as `cameraStream`; when blur is on it's kept
    // alive separately as the audio source + the blur pipeline's
    // input. Tracked so toggling blur mid-call doesn't need a fresh
    // getUserMedia (which would re-prompt for camera access on some
    // platforms and reset capture settings).
    this._rawStream = null;
    this._blurOn = false;
    this._blurPipeline = null;
    // Local mic/cam state mirrors the actual track.enabled values.
    // Broadcast to peers (via huddle.sendMuteState) whenever it changes
    // so remote tiles can show a mic-off icon / cam-off avatar overlay
    // — receivers can't infer this from media (a disabled track sends
    // silence / black frames, not "no track").
    this._micOn = true;
    this._camOn = true;
    this._screenStreams = new Map();    // streamId -> { stream, label }
    this._pendingScreens = 0;           // shares awaiting getUserMedia, counted toward the cap

    // Track bound handlers so disconnect() can detach them — calls are
    // on-demand now, so a new MeshClient is constructed every time the
    // user clicks Start/Join. Without removeEventListener the handlers
    // accumulate on the long-lived HuddleClient and create zombie
    // peer connections + signaling on subsequent calls.
    this._bound = [];
    const wire = (event, handler) => {
      huddle.addEventListener(event, handler);
      this._bound.push([event, handler]);
    };

    // Forward events from the HuddleClient so external listeners
    // attached to the mesh keep working unchanged.
    const FORWARD = [
      'welcome', 'connected', 'peer-joined', 'peer-left',
      'screen-announce', 'screen-stop', 'draw', 'typing',
      'raise-hand', 'reaction', 'mute-state',
      'chat-message', 'chat-update', 'chat-message-deleted',
      'chat-channel-added', 'chat-channel-removed',
      'saved-message-added', 'saved-message-updated', 'saved-message-removed',
    ];
    for (const ev of FORWARD) {
      wire(ev, (e) => this.dispatchEvent(new CustomEvent(ev, { detail: e.detail })));
    }

    // Signaling: route inbound signals into the matching PeerConn, and
    // add the local camera/screens to any peer that joins. Politeness
    // (perfect-negotiation glare resolver) must be derived the same way
    // on every path that can create a PeerConn — `this.peerId > remoteId`
    // — so the two ends always disagree (one polite, one impolite) and
    // `_ensurePeer`'s "first creator wins" cache can't flip it. Hard-coding
    // `polite: true` here made both peers polite, so a join-time offer
    // collision was never backed off and the connection could end up
    // one-way.
    wire('signal', (e) => {
      const { from, payload } = e.detail;
      this._ensurePeer(from, this.peerId > from).then((conn) => conn.handleSignal(payload));
    });
    wire('peer-joined', (e) => {
      this._ensurePeer(e.detail.id, this.peerId > e.detail.id).then((conn) => {
        if (this.cameraStream) conn.addStream(this.cameraStream);
        for (const { stream } of this._screenStreams.values()) conn.addStream(stream);
        this._applyScreenEncodings();
      });
      // Re-broadcast our current mic/cam state so the joining peer
      // catches up without us having to maintain a per-peer message
      // queue. Channel-wide broadcast is fine — existing peers ignore
      // it (they already had the right value).
      if (this.cameraStream) this.huddle.sendMuteState(this._micOn, this._camOn);
    });
    wire('peer-left', (e) => {
      this._dropPeer(e.detail);
      this._applyScreenEncodings();
    });
  }

  // Bootstrap WebRTC peer connections to everyone already in the call
  // when this MeshClient is constructed. We can't rely on the
  // peer-joined event for them: the call channel's initial presence
  // sync fires from inside huddle.joinCall(), so by the time MeshClient
  // is created (and its listeners attached) those events are already
  // gone. Iterate the snapshot the HuddleClient holds in
  // `callPeerInfo` and fan out to each.
  bootstrapExistingPeers() {
    if (!this.huddle.callPeerInfo) return;
    for (const peer of this.huddle.callPeerInfo.values()) {
      this._ensurePeer(peer.id, this.peerId > peer.id).then((conn) => {
        if (this.cameraStream) conn.addStream(this.cameraStream);
        for (const { stream } of this._screenStreams.values()) conn.addStream(stream);
        this._applyScreenEncodings();
      });
    }
  }

  // --- Pass-through accessors so callers can read from `mesh` directly ----
  get peerId() { return this.huddle.peerId; }
  get name() { return this.huddle.name; }
  get color() { return this.huddle.color; }
  get peerInfo() { return this.huddle.peerInfo; }
  get remoteScreenLabels() { return this.huddle.remoteScreenLabels; }
  get teamMeta() { return this.huddle.team; }
  get url() { return this.huddle.url; }
  get screenStreams() { return this._screenStreams; }
  get raisedHands() { return this.huddle.raisedHands; }

  // --- Chat passthroughs --------------------------------------------------
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

  // --- WebRTC peer-connection lifecycle -----------------------------------
  async _ensurePeer(remoteId, polite) {
    let conn = this.peers.get(remoteId);
    if (conn) return conn;
    conn = new PeerConn({
      remoteId, polite,
      signal: (payload) => this.huddle.sendSignal(remoteId, payload),
      onTrack: (stream, track, fromId) =>
        this.dispatchEvent(new CustomEvent('track', { detail: { stream, track, fromId } })),
      onScreenStop: (fromId, streamId) =>
        this.dispatchEvent(new CustomEvent('remote-stream-ended', { detail: { fromId, streamId } })),
    });
    this.peers.set(remoteId, conn);
    return conn;
  }

  _dropPeer(remoteId) {
    const c = this.peers.get(remoteId);
    if (!c) return;
    c.close();
    this.peers.delete(remoteId);
  }

  // --- Media: camera + screens -------------------------------------------
  // Acquires a fresh camera + mic stream, runs it through the blur
  // pipeline if `_blurOn` is set, and pushes the resulting "published"
  // stream to every peer. Callers can pre-set `_blurOn` via
  // setBlurBackground() before this runs (the no-stream branch over
  // there just stashes the preference); the pipeline then starts as
  // part of camera setup so the first frame peers receive is already
  // blurred.
  async setCamera(constraints = { video: true, audio: true }) {
    // Tear down any prior streams + pipeline. Remove the published
    // stream from peers BEFORE stopping tracks so we don't briefly
    // double-send (the addStream below would otherwise stack on top
    // of stale senders).
    if (this.cameraStream) {
      for (const conn of this.peers.values()) conn.removeStream(this.cameraStream);
    }
    if (this._blurPipeline) { this._blurPipeline.stop(); this._blurPipeline = null; }
    if (this._rawStream) for (const t of this._rawStream.getTracks()) t.stop();

    const raw = await navigator.mediaDevices.getUserMedia(constraints);
    this._rawStream = raw;

    let published = raw;
    if (this._blurOn && window.BlurPipeline?.isAvailable()) {
      try {
        this._blurPipeline = new window.BlurPipeline();
        published = await this._blurPipeline.start(raw);
      } catch (err) {
        console.warn('[mesh] blur pipeline start failed, publishing raw camera', err);
        this._blurPipeline = null;
        this._blurOn = false;
        published = raw;
      }
    }

    this.cameraStream = published;
    // Sync local state from the actual tracks (a constraints set with
    // audio:false would leave us "muted" from the start — reflect that
    // truthfully so the broadcast doesn't lie).
    this._micOn = !!published.getAudioTracks()[0]?.enabled;
    this._camOn = !!published.getVideoTracks()[0]?.enabled;
    for (const conn of this.peers.values()) conn.addStream(published);
    this.huddle.sendMuteState(this._micOn, this._camOn);
    return published;
  }

  get blurOn() { return this._blurOn; }

  // Toggle background blur. If the camera isn't live yet this just
  // records the preference and setCamera() applies it; otherwise we
  // swap the outbound video track on every peer connection via
  // replaceTrack() so the change is renegotiation-free. Emits
  // `camera-stream-changed` so the local self-cam tile can re-point
  // its <video>.srcObject at the new stream.
  async setBlurBackground(on) {
    on = !!on;
    if (!this._rawStream) {
      this._blurOn = on;
      return;
    }
    if (this._blurOn === on) return;

    const prevPublished = this.cameraStream;
    const prevPipeline = this._blurPipeline;

    let newPublished;
    let newPipeline = null;
    if (on) {
      if (!window.BlurPipeline?.isAvailable()) {
        throw new Error('Blur pipeline is not available');
      }
      newPipeline = new window.BlurPipeline();
      newPublished = await newPipeline.start(this._rawStream);
    } else {
      newPublished = this._rawStream;
    }

    // Carry the cam-on flag across the swap. The canvas-derived
    // track starts enabled regardless of the raw track's state, so
    // without this a user who muted their camera and then toggled
    // blur would have their cam silently re-enabled.
    const prevVideoTrack = prevPublished?.getVideoTracks()[0];
    const newVideoTrack = newPublished.getVideoTracks()[0];
    if (newVideoTrack && prevVideoTrack && newVideoTrack !== prevVideoTrack) {
      newVideoTrack.enabled = prevVideoTrack.enabled;
    }

    // replaceTrack swaps the source feeding each sender without a
    // new SDP exchange. Screen-share senders carry their own tracks
    // (not equal to the previous published video track) and are
    // skipped naturally by the identity check.
    if (prevVideoTrack !== newVideoTrack) {
      for (const conn of this.peers.values()) {
        for (const sender of conn.pc.getSenders()) {
          if (sender.track === prevVideoTrack) {
            try { await sender.replaceTrack(newVideoTrack); }
            catch (err) { console.warn('[mesh] replaceTrack failed', err); }
          }
        }
      }
    }
    this.cameraStream = newPublished;
    this._blurPipeline = newPipeline;
    this._blurOn = on;

    // Dispatch BEFORE stopping the prior pipeline so the local self-cam
    // tile re-points its <video>.srcObject at the new stream first —
    // otherwise the canvas track ends while the tile is still rendering
    // it, briefly freezing the local preview. Peers don't care about
    // ordering here (replaceTrack above already pointed their senders
    // at the new track); this is purely a local-UX fix.
    this.dispatchEvent(new CustomEvent('camera-stream-changed', {
      detail: { stream: newPublished },
    }));

    if (prevPipeline) prevPipeline.stop();
  }
  toggleMic() {
    if (!this.cameraStream) return false;
    const t = this.cameraStream.getAudioTracks()[0];
    if (!t) return false;
    t.enabled = !t.enabled;
    this._micOn = t.enabled;
    this.huddle.sendMuteState(this._micOn, this._camOn);
    return t.enabled;
  }
  toggleCam() {
    if (!this.cameraStream) return false;
    const t = this.cameraStream.getVideoTracks()[0];
    if (!t) return false;
    t.enabled = !t.enabled;
    this._camOn = t.enabled;
    this.huddle.sendMuteState(this._micOn, this._camOn);
    return t.enabled;
  }

  get activeScreenCount() {
    return this._screenStreams.size + this._pendingScreens + this.huddle.remoteScreenLabels.size;
  }

  async addScreen(sourceId, label) {
    if (this.activeScreenCount >= MAX_CONCURRENT_SCREENS) {
      throw new Error(`Screen-share limit reached (${MAX_CONCURRENT_SCREENS} max).`);
    }
    // Reserve a slot before awaiting getUserMedia so rapid concurrent calls
    // (e.g. double-clicks on picker tiles) can't all pass the check.
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
    this._screenStreams.set(stream.id, { stream, label });
    this.huddle.sendScreenAnnounce(stream.id, label);
    for (const conn of this.peers.values()) conn.addStream(stream);
    this._applyScreenEncodings();
    const v = stream.getVideoTracks()[0];
    if (v) v.addEventListener('ended', () => this.removeScreen(stream.id));
    else this.removeScreen(stream.id);
    return stream;
  }
  removeScreen(streamId) {
    const entry = this._screenStreams.get(streamId);
    if (!entry) return;
    for (const t of entry.stream.getTracks()) t.stop();
    for (const conn of this.peers.values()) conn.removeStream(entry.stream);
    this._screenStreams.delete(streamId);
    this.huddle.sendScreenStop(streamId);
  }

  // Walk every peer connection and set the outbound bitrate/framerate
  // cap for each screen-share track sender to match the current viewer
  // count. Cameras are skipped — the per-tier matching uses identity on
  // the screen tracks themselves. Best-effort: if setParameters rejects
  // (e.g. negotiation hasn't completed yet on a brand-new peer) we log
  // and move on; the next event-driven call will retry.
  //
  // Coalesce synchronous bursts (e.g. bootstrapExistingPeers fires once
  // per peer) into a single microtask so we don't fan out N concurrent
  // setParameters calls per sender — those race on transactionId and
  // emit spurious warnings.
  _applyScreenEncodings() {
    if (this._encodingApplyPending) return;
    this._encodingApplyPending = Promise.resolve().then(async () => {
      this._encodingApplyPending = null;
      if (this._screenStreams.size === 0 || this.peers.size === 0) return;
      const tier = pickScreenEncoding(this.peers.size);
      // Video tracks only. Screen captures are created with audio:false today,
      // but filtering defensively here means a future change to capture audio
      // can't accidentally feed an audio sender bitrate caps it doesn't honor.
      const screenTracks = new Set();
      for (const { stream } of this._screenStreams.values()) {
        for (const t of stream.getVideoTracks()) screenTracks.add(t);
      }
      const updates = [];
      for (const conn of this.peers.values()) {
        for (const sender of conn.pc.getSenders()) {
          if (!sender.track || !screenTracks.has(sender.track)) continue;
          updates.push((async () => {
            let params;
            try { params = sender.getParameters(); }
            catch (err) { console.warn('[screen-quality] getParameters failed', err); return; }
            // Per spec the number of encodings is fixed at sender-create time;
            // adding to an empty list throws InvalidModificationError. Pre-
            // negotiation getParameters() can briefly return an empty list,
            // so just skip and let the next event-driven call retry.
            if (!params.encodings || params.encodings.length === 0) return;
            params.encodings[0].maxBitrate = tier.maxBitrate;
            params.encodings[0].maxFramerate = tier.maxFramerate;
            try { await sender.setParameters(params); }
            catch (err) { console.warn('[screen-quality] setParameters failed', err); }
          })());
        }
      }
      await Promise.allSettled(updates);
    });
  }

  // Signaling for drawing strokes; renderer calls this as it strokes.
  sendDraw(streamId, stroke) { this.huddle.sendDraw(streamId, stroke); }

  sendRaiseHand(raised) { this.huddle.sendRaiseHand(raised); }
  sendReaction(emoji) { this.huddle.sendReaction(emoji); }

  // Drops the WebRTC + media surface only. Leaving a call must not
  // tear down the HuddleClient (chat realtime, team presence, etc.) —
  // the user stays signed into the team. Full sign-out happens via
  // huddle.stop() called separately by the orchestrator.
  //
  // Detaches every event listener registered on the long-lived
  // HuddleClient: a new MeshClient is constructed each time the user
  // starts/joins a call, so without explicit teardown the handlers
  // accumulate and rejoining a call creates zombie PeerConns +
  // duplicate signal routing.
  disconnect() {
    for (const id of [...this._screenStreams.keys()]) this.removeScreen(id);
    if (this._blurPipeline) { this._blurPipeline.stop(); this._blurPipeline = null; }
    // Stop the raw stream's tracks too — when blur was on the
    // cameraStream below is a composite (canvas video + raw audio),
    // stopping it ends the canvas track but leaves the raw video
    // track running (the camera light would stay on).
    if (this._rawStream) {
      for (const t of this._rawStream.getTracks()) t.stop();
      this._rawStream = null;
    }
    if (this.cameraStream) {
      for (const t of this.cameraStream.getTracks()) t.stop();
      this.cameraStream = null;
    }
    for (const conn of this.peers.values()) conn.close();
    this.peers.clear();
    for (const [event, handler] of this._bound) {
      try { this.huddle.removeEventListener(event, handler); } catch {}
    }
    this._bound = [];
  }
}

window.MeshClient = MeshClient;
window.MAX_CONCURRENT_SCREENS = MAX_CONCURRENT_SCREENS;
