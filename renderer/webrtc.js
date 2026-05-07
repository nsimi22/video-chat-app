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
    this._screenStreams = new Map();    // streamId -> { stream, label }

    // Forward events from the HuddleClient so external listeners attached
    // to the mesh keep working unchanged.
    const FORWARD = [
      'welcome', 'connected', 'peer-joined', 'peer-left',
      'screen-announce', 'screen-stop', 'draw', 'typing',
      'chat-message', 'chat-update', 'chat-message-deleted',
      'chat-channel-added', 'chat-channel-removed',
    ];
    for (const ev of FORWARD) {
      huddle.addEventListener(ev, (e) => this.dispatchEvent(new CustomEvent(ev, { detail: e.detail })));
    }

    // Signaling: route inbound signals into the matching PeerConn, and add
    // the local camera/screens to any peer that joins.
    huddle.addEventListener('signal', (e) => {
      const { from, payload } = e.detail;
      const polite = this.peerId > from;
      this._ensurePeer(from, polite).then((conn) => conn.handleSignal(payload));
    });
    huddle.addEventListener('peer-joined', (e) => {
      this._ensurePeer(e.detail.id, /*polite*/ true).then((conn) => {
        if (this.cameraStream) conn.addStream(this.cameraStream);
        for (const { stream } of this._screenStreams.values()) conn.addStream(stream);
      });
    });
    huddle.addEventListener('peer-left', (e) => this._dropPeer(e.detail));
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

  // --- Chat passthroughs --------------------------------------------------
  sendMessage(args)        { return this.huddle.sendMessage(args); }
  sendAiMessage(args)      { return this.huddle.sendAiMessage(args); }
  editMessage(id, text)    { return this.huddle.editMessage(id, text); }
  deleteMessage(id)        { return this.huddle.deleteMessage(id); }
  toggleReaction(id, e)    { return this.huddle.toggleReaction(id, e); }
  sendTyping(c, p)         { return this.huddle.sendTyping(c, p); }
  loadHistory(c, opts)     { return this.huddle.loadHistory(c, opts); }
  createChannel(args)      { return this.huddle.createChannel(args); }
  createDm(name)           { return this.huddle.createDm(name); }
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
  async setCamera(constraints = { video: true, audio: true }) {
    if (this.cameraStream) {
      for (const t of this.cameraStream.getTracks()) t.stop();
      for (const conn of this.peers.values()) conn.removeStream(this.cameraStream);
    }
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.cameraStream = stream;
    for (const conn of this.peers.values()) conn.addStream(stream);
    return stream;
  }
  toggleMic() {
    if (!this.cameraStream) return false;
    const t = this.cameraStream.getAudioTracks()[0];
    if (!t) return false; t.enabled = !t.enabled; return t.enabled;
  }
  toggleCam() {
    if (!this.cameraStream) return false;
    const t = this.cameraStream.getVideoTracks()[0];
    if (!t) return false; t.enabled = !t.enabled; return t.enabled;
  }

  async addScreen(sourceId, label) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 1920, maxHeight: 1080, maxFrameRate: 30,
        },
      },
    });
    this._screenStreams.set(stream.id, { stream, label });
    this.huddle.sendScreenAnnounce(stream.id, label);
    for (const conn of this.peers.values()) conn.addStream(stream);
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

  // Signaling for drawing strokes; renderer calls this as it strokes.
  sendDraw(streamId, stroke) { this.huddle.sendDraw(streamId, stroke); }

  // Drops the WebRTC + media surface only. Leaving a call must not
  // tear down the HuddleClient (chat realtime, team presence, etc.) —
  // the user stays signed into the team. Full sign-out happens via
  // huddle.stop() called separately by the orchestrator.
  disconnect() {
    for (const id of [...this._screenStreams.keys()]) this.removeScreen(id);
    if (this.cameraStream) {
      for (const t of this.cameraStream.getTracks()) t.stop();
      this.cameraStream = null;
    }
    for (const conn of this.peers.values()) conn.close();
    this.peers.clear();
  }
}

window.MeshClient = MeshClient;
