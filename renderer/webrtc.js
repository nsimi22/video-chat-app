// WebRTC mesh manager.
//
// Topology: full mesh — every peer holds one RTCPeerConnection per other peer.
// Media: each peer owns one camera/mic stream and N screen-share streams.
// To support sharing more than one screen at a time we use addTransceiver per
// stream and label tracks via a `screen-announce` signaling message that maps
// streamId -> human name. Renegotiation is automatic via onnegotiationneeded.
//
// We follow the "polite peer" pattern (perfect negotiation) so simultaneous
// offers don't deadlock.

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

class PeerConn {
  constructor({ remoteId, signal, polite, onTrack, onScreenStop }) {
    this.remoteId = remoteId;
    this.polite = polite;
    this.signal = signal; // (payload) => void  — relay through signaling server.
    this.onTrack = onTrack;
    this.onScreenStop = onScreenStop;
    this.makingOffer = false;
    this.ignoreOffer = false;

    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.onicecandidate = (e) => {
      if (e.candidate) signal({ candidate: e.candidate });
    };
    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        signal({ description: this.pc.localDescription });
      } catch (err) {
        console.error('negotiation error', err);
      } finally {
        this.makingOffer = false;
      }
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
    } catch (err) {
      console.error('signal error', err);
    }
  }

  addStream(stream) {
    for (const track of stream.getTracks()) this.pc.addTrack(track, stream);
  }

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
  constructor({ url, name, color }) {
    super();
    this.url = url;
    this.name = name;
    this.color = color;
    this.peerId = null;
    this.peers = new Map(); // remoteId -> PeerConn
    this.peerInfo = new Map(); // remoteId -> {name, color}
    this.cameraStream = null;
    this.screenStreams = new Map(); // streamId -> {stream, label}
    this.remoteScreenLabels = new Map(); // streamId -> label/name
    this.ws = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this.ws.send(JSON.stringify({ type: 'hello', name: this.name, color: this.color }));
      };
      this.ws.onerror = (e) => reject(e);
      this.ws.onclose = () => this.dispatchEvent(new CustomEvent('disconnected'));
      this.ws.onmessage = (ev) => {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch (err) {
          console.warn('[mesh] dropped malformed signaling message', err);
          return;
        }
        if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
        switch (m.type) {
          case 'welcome':
            this.peerId = m.peerId;
            for (const p of m.peers) this.peerInfo.set(p.id, p);
            // Seed labels for screens that were already being shared before we joined.
            for (const s of m.activeScreens || []) {
              this.remoteScreenLabels.set(s.streamId, { label: s.label, fromName: s.fromName, from: s.from });
            }
            this.dispatchEvent(new CustomEvent('welcome', { detail: m }));
            resolve();
            break;
          case 'peer-joined':
            this.peerInfo.set(m.peer.id, m.peer);
            this.dispatchEvent(new CustomEvent('peer-joined', { detail: m.peer }));
            // The newer peer is the impolite one; existing peers are polite.
            this._ensurePeer(m.peer.id, /*polite*/ true).then((conn) => {
              if (this.cameraStream) conn.addStream(this.cameraStream);
              for (const { stream } of this.screenStreams.values()) conn.addStream(stream);
            });
            break;
          case 'peer-left':
            this._dropPeer(m.peerId);
            this.dispatchEvent(new CustomEvent('peer-left', { detail: m.peerId }));
            break;
          case 'signal': {
            // Polite if our id sorts higher than theirs (deterministic tiebreak).
            const polite = this.peerId > m.from;
            this._ensurePeer(m.from, polite).then((conn) => conn.handleSignal(m.payload));
            break;
          }
          case 'screen-announce':
            this.remoteScreenLabels.set(m.streamId, { label: m.label, fromName: m.fromName, from: m.from });
            this.dispatchEvent(new CustomEvent('screen-announce', { detail: m }));
            break;
          case 'screen-stop':
            this.remoteScreenLabels.delete(m.streamId);
            this.dispatchEvent(new CustomEvent('screen-stop', { detail: m }));
            break;
          case 'draw':
            this.dispatchEvent(new CustomEvent('draw', { detail: m }));
            break;
          case 'chat-history':
          case 'chat-message':
          case 'chat-update':
          case 'typing':
            this.dispatchEvent(new CustomEvent(m.type, { detail: m }));
            break;
        }
      };
    });
  }

  send(obj) { this.ws.send(JSON.stringify(obj)); }

  async _ensurePeer(remoteId, polite) {
    let conn = this.peers.get(remoteId);
    if (conn) return conn;
    conn = new PeerConn({
      remoteId,
      polite,
      signal: (payload) => this.send({ type: 'signal', to: remoteId, payload }),
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
    this.peerInfo.delete(remoteId);
  }

  // Media management ---------------------------------------------------------

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
    const track = this.cameraStream.getAudioTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    return track.enabled;
  }

  toggleCam() {
    if (!this.cameraStream) return false;
    const track = this.cameraStream.getVideoTracks()[0];
    if (!track) return false;
    track.enabled = !track.enabled;
    return track.enabled;
  }

  // Add an additional screen share. Multiple may be active simultaneously.
  async addScreen(sourceId, label) {
    // chromeMediaSource constraints are how Electron's desktopCapturer hands us a screen/window.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 30,
        },
      },
    });
    this.screenStreams.set(stream.id, { stream, label });
    // Announce BEFORE adding tracks so the metadata broadcast is enqueued on
    // the WebSocket ahead of the renegotiation traffic. Receivers can then
    // identify the inbound track as a screen share rather than a camera.
    this.send({ type: 'screen-announce', streamId: stream.id, label });
    for (const conn of this.peers.values()) conn.addStream(stream);
    // When the user stops sharing via OS UI, clean up. Defensive guard in
    // case the platform handed us a video-less stream.
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.addEventListener('ended', () => this.removeScreen(stream.id));
    } else {
      console.warn('[mesh] screen stream has no video track; cleaning up');
      this.removeScreen(stream.id);
    }
    return stream;
  }

  removeScreen(streamId) {
    const entry = this.screenStreams.get(streamId);
    if (!entry) return;
    for (const t of entry.stream.getTracks()) t.stop();
    for (const conn of this.peers.values()) conn.removeStream(entry.stream);
    this.screenStreams.delete(streamId);
    this.send({ type: 'screen-stop', streamId });
  }

  // Clean teardown — used by the Leave button.
  disconnect() {
    for (const id of [...this.screenStreams.keys()]) this.removeScreen(id);
    if (this.cameraStream) {
      for (const t of this.cameraStream.getTracks()) t.stop();
      this.cameraStream = null;
    }
    for (const conn of this.peers.values()) conn.close();
    this.peers.clear();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try { this.ws.close(); } catch {}
    }
  }
}

window.MeshClient = MeshClient;
