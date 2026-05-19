// Audio-only WebRTC mesh for mobile calls.
//
// Drop-in replacement for the LiveKit SFU client. Same Supabase Realtime
// topic (`call:<team>:<channel>`) and signaling shape as the desktop renderer
// (renderer/webrtc.js + renderer/api.js), so a mobile peer and a desktop peer
// can join the same call and hear each other.
//
// Each peer holds one RTCPeerConnection per other peer (mesh topology); fine
// for audio-only up through ~6-8 participants. Politeness for perfect
// negotiation is derived from `myPeerId > remoteId` — the two ends always
// disagree, which is what prevents offer collisions from deadlocking.

import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
  mediaDevices,
  MediaStream,
} from 'react-native-webrtc';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { callTopic } from './topics';
import { fetchIceServers, type IceServer } from './iceServers';
import { createCallAnnouncer, type CallAnnouncer } from './call-announce';

// react-native-webrtc's connection-state values per spec. We model it as a
// union of literals rather than importing the DOM lib's RTCPeerConnectionState
// (which isn't in scope under the React Native TS lib config).
export type ConnectionState =
  | 'new'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed'
  | 'closed';

export type PeerInfo = {
  id: string;
  name?: string;
  color?: string;
  micOn: boolean;
  connectionState: ConnectionState;
};

export type MeshState = {
  peers: PeerInfo[];
  micOn: boolean;
  // True once we've subscribed to the call channel and acquired the mic.
  // The UI uses this to stop showing the "Connecting…" spinner.
  joined: boolean;
  // True when we were joined and then lost the realtime channel — supabase-js
  // is auto-reconnecting in the background. UI should show a "Reconnecting…"
  // banner without unmounting the call.
  reconnecting: boolean;
};

// Categorise failures so the UI can branch (permission UX vs. generic retry).
export type MeshErrorKind =
  | 'permission_denied'   // user said no to the mic prompt; recoverable via Settings
  | 'no_microphone'       // device has no mic / hardware unavailable
  | 'realtime_failed'     // Supabase Realtime subscribe / RLS failure
  | 'unknown';

export class MeshError extends Error {
  kind: MeshErrorKind;
  constructor(kind: MeshErrorKind, message: string) {
    super(message);
    this.name = 'MeshError';
    this.kind = kind;
  }
}

// SDP + ICE-candidate payloads round-trip through Supabase Realtime as JSON.
// We pin our own shapes here so the wire format is independent of which
// WebRTC implementation either end happens to use — the desktop sends DOM
// shapes (sdp optional, type a strict union), react-native-webrtc's toJSON()
// is laxer (sdp required, type `string | null`). The intersection that
// works on both ends is what we accept here.
type DescriptionWire = { type: 'offer' | 'answer' | 'pranswer' | 'rollback'; sdp: string };
type CandidateWire = { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

type SignalPayload = {
  description?: DescriptionWire;
  candidate?: CandidateWire;
};

type MeshOptions = {
  teamId: string;
  channelId: string;
  myPeerId: string;
  myName: string;
  myColor: string;
};

// Resolve perfect-negotiation politeness the same way the desktop mesh does so
// the two ends always disagree (one polite, one impolite) regardless of who
// connects first.
const isPolite = (mine: string, other: string) => mine > other;

// Narrow the rn-webrtc instance shapes into the strict wire types we expect
// the other side to round-trip. rn-webrtc types `type` as `string | null`;
// in practice a freshly-set local description always has a real sdp type.
function descriptionToWire(d: RTCSessionDescription): DescriptionWire {
  return { type: (d.type ?? 'offer') as DescriptionWire['type'], sdp: d.sdp };
}
function candidateToWire(c: RTCIceCandidate): CandidateWire {
  return { candidate: c.candidate, sdpMid: c.sdpMid ?? null, sdpMLineIndex: c.sdpMLineIndex ?? null };
}

// react-native-webrtc's RTCPeerConnection still exposes events via the legacy
// "on*" property pattern (rather than addEventListener), and its TS types use
// looser/older signatures than the DOM. The helper centralises the casts so
// the rest of the class can read normally.
type RNRTCPeerConnection = RTCPeerConnection & {
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null;
  onnegotiationneeded: (() => void | Promise<void>) | null;
  ontrack: ((e: { streams: MediaStream[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  connectionState: ConnectionState;
  signalingState: string;
  localDescription: RTCSessionDescription | null;
};

class PeerConn {
  remoteId: string;
  polite: boolean;
  pc: RNRTCPeerConnection;
  makingOffer = false;
  ignoreOffer = false;
  private sendSignal: (payload: SignalPayload) => void;
  private onTrack: (stream: MediaStream) => void;
  private onState: (state: ConnectionState) => void;

  constructor(opts: {
    remoteId: string;
    polite: boolean;
    iceServers: IceServer[];
    sendSignal: (payload: SignalPayload) => void;
    onTrack: (stream: MediaStream) => void;
    onState: (state: ConnectionState) => void;
  }) {
    this.remoteId = opts.remoteId;
    this.polite = opts.polite;
    this.sendSignal = opts.sendSignal;
    this.onTrack = opts.onTrack;
    this.onState = opts.onState;
    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers }) as RNRTCPeerConnection;

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal({ candidate: candidateToWire(e.candidate) });
    };

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        // Modern setLocalDescription() without an argument auto-creates the
        // right offer/answer based on signalingState. RN-WebRTC supports it
        // in current versions; cast through unknown because its TS types
        // still require an explicit arg.
        await (this.pc as unknown as { setLocalDescription: () => Promise<void> }).setLocalDescription();
        if (this.pc.localDescription) this.sendSignal({ description: descriptionToWire(this.pc.localDescription) });
      } catch (err) {
        console.warn('[mesh] negotiation failed', err);
      } finally {
        this.makingOffer = false;
      }
    };

    this.pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (stream) this.onTrack(stream);
    };

    this.pc.onconnectionstatechange = () => {
      this.onState(this.pc.connectionState);
    };
  }

  async handleSignal(payload: SignalPayload) {
    try {
      if (payload.description) {
        const desc = payload.description;
        const offerCollision =
          desc.type === 'offer' &&
          (this.makingOffer || this.pc.signalingState !== 'stable');
        this.ignoreOffer = !this.polite && offerCollision;
        if (this.ignoreOffer) return;
        await this.pc.setRemoteDescription(new RTCSessionDescription({ type: desc.type, sdp: desc.sdp }));
        if (desc.type === 'offer') {
          // We're audio-only on mobile. Before sending our answer, mark any
          // video transceivers the remote offered as `inactive`. The remote
          // honors that direction and stops encoding/sending video on this
          // peer connection, so a desktop peer with a camera doesn't burn
          // the mobile user's downlink on frames we'd just discard. Keeps
          // audio intact on a flaky cellular link.
          this.refuseInboundVideo();
          await (this.pc as unknown as { setLocalDescription: () => Promise<void> }).setLocalDescription();
          if (this.pc.localDescription) this.sendSignal({ description: descriptionToWire(this.pc.localDescription) });
        }
      } else if (payload.candidate) {
        try {
          await this.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.warn('[mesh] signal error', err);
    }
  }

  addLocalStream(stream: MediaStream) {
    for (const t of stream.getTracks()) this.pc.addTrack(t, stream);
  }

  // Refuse video on any transceiver the remote opened. Setting
  // direction='inactive' on the receiving side tells the peer (per WebRTC
  // spec) to stop sending RTP on that m-section, so audio quality is not
  // squeezed by video bytes we'd never render.
  private refuseInboundVideo() {
    for (const t of this.pc.getTransceivers()) {
      if (t.receiver?.track?.kind === 'video' && t.direction !== 'inactive') {
        try { t.direction = 'inactive'; }
        catch (err) { console.warn('[mesh] could not refuse video', err); }
      }
    }
  }

  close() {
    // Null the on* handlers before closing so their closures (which retain
    // `this` and via it the Mesh + listener set) can be GC'd even if
    // react-native-webrtc's native side still has the PC pinned in its
    // internal _pcId map briefly.
    this.pc.onicecandidate = null;
    this.pc.onnegotiationneeded = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
  }
}

export class Mesh {
  private opts: MeshOptions;
  private channel: RealtimeChannel | null = null;
  private peers = new Map<string, PeerConn>();
  // Peer metadata sourced from presence (name/color) + mute-state broadcasts
  // + the WebRTC connection state. Kept separately from `peers` so we can
  // emit a snapshot to subscribers without touching the PCs.
  private peerInfo = new Map<string, PeerInfo>();
  private localStream: MediaStream | null = null;
  private iceServers: IceServer[] = [];
  private _micOn = true;
  private _joined = false;
  private _reconnecting = false;
  private listeners = new Set<(s: MeshState) => void>();
  private disposed = false;
  // Drives the `active_calls` table heartbeat that powers push notifications.
  // Separate from the realtime channel because Postgres webhooks can't read
  // realtime presence — we have to give them a row to watch.
  private announcer: CallAnnouncer | null = null;

  constructor(opts: MeshOptions) {
    this.opts = opts;
  }

  subscribe(fn: (s: MeshState) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  private snapshot(): MeshState {
    return {
      peers: [...this.peerInfo.values()],
      micOn: this._micOn,
      joined: this._joined,
      reconnecting: this._reconnecting,
    };
  }

  private emit() {
    const s = this.snapshot();
    for (const fn of this.listeners) fn(s);
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new MeshError('unknown', 'mesh disposed');
    // Order matters: acquire ICE first (network call, may take a beat) and
    // mic second (permission prompt). Subscribing to realtime LAST means we
    // can't receive a 'signal' before we're ready to handle it.
    this.iceServers = await fetchIceServers();
    try {
      this.localStream = await mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      // RN-WebRTC mirrors the W3C MediaStreamError names. NotAllowedError /
      // PermissionDeniedError = user said no. NotFoundError = no mic
      // hardware. Other errors fall through as generic.
      const name = (err as { name?: string } | null)?.name ?? '';
      const message = err instanceof Error ? err.message : String(err);
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || /denied|permission/i.test(message)) {
        throw new MeshError('permission_denied', 'Microphone permission denied');
      }
      if (name === 'NotFoundError' || /not.*found|no.*microphone/i.test(message)) {
        throw new MeshError('no_microphone', 'No microphone available');
      }
      throw new MeshError('unknown', message);
    }

    const topic = callTopic(this.opts.teamId, this.opts.channelId);
    const ch = supabase.channel(topic, {
      config: {
        presence: { key: this.opts.myPeerId },
        broadcast: { self: false, ack: false },
        private: true,
      },
    });

    ch.on('presence', { event: 'sync' }, () => {
      const state = ch.presenceState() as Record<
        string,
        Array<{ name?: string; color?: string }>
      >;
      const seen = new Set<string>();
      let newPeerJoined = false;
      for (const key of Object.keys(state)) {
        seen.add(key);
        if (key === this.opts.myPeerId) continue;
        const meta = state[key][0] ?? {};
        const existing = this.peerInfo.get(key);
        if (!existing) {
          this.peerInfo.set(key, {
            id: key,
            name: meta.name,
            color: meta.color,
            micOn: true,
            connectionState: 'new',
          });
          newPeerJoined = true;
        } else {
          // Refresh name/color in case the peer updated their profile mid-call.
          existing.name = meta.name ?? existing.name;
          existing.color = meta.color ?? existing.color;
        }
        // Either way, make sure a PC exists for this peer — ensurePeer is
        // idempotent and adds the local audio track on first call so the
        // initial offer/answer exchange already carries our send direction
        // (no second renegotiation just to publish our mic).
        this.ensurePeer(key);
      }
      for (const id of [...this.peerInfo.keys()]) {
        if (!seen.has(id)) this.dropPeer(id);
      }
      // Re-broadcast our mute state so a late joiner sees the right mic
      // icon. The call channel is `broadcast: { self: false }` so this
      // never echoes; it costs one packet per new peer. Without it, a
      // peer who joined after we muted would render us as un-muted until
      // we toggled again.
      if (newPeerJoined && this.channel) this.publishMuteState();
      this.emit();
    });

    ch.on('broadcast', { event: 'signal' }, ({ payload }) => {
      const msg = payload as { from: string; to: string; payload: SignalPayload };
      if (msg.to !== this.opts.myPeerId) return;
      this.ensurePeer(msg.from).handleSignal(msg.payload);
    });

    ch.on('broadcast', { event: 'mute-state' }, ({ payload }) => {
      const msg = payload as { from: string; micOn: boolean };
      const info = this.peerInfo.get(msg.from);
      if (!info) return;
      info.micOn = !!msg.micOn;
      this.emit();
    });

    await new Promise<void>((resolve, reject) => {
      // Belt-and-braces initial timeout — Realtime's subscribe() doesn't time
      // out internally, so a denied RLS / network hiccup mid-handshake would
      // otherwise hang forever and leave the UI stuck on "Connecting…".
      // The single subscribe() callback handles both initial connect and
      // subsequent reconnect cycles: `initialSettled` gates which path runs.
      let initialSettled = false;
      const initialDone = (ok: boolean, err?: unknown) => {
        if (initialSettled) return;
        initialSettled = true;
        clearTimeout(timer);
        if (ok) resolve();
        else {
          try { ch.unsubscribe(); } catch { /* already gone */ }
          const message = err instanceof Error ? err.message : String(err ?? 'subscribe failed');
          reject(err instanceof MeshError ? err : new MeshError('realtime_failed', message));
        }
      };
      const timer = setTimeout(() => initialDone(false, new Error('Couldn’t reach the call server')), 12000);

      ch.subscribe(async (status, err) => {
        if (status === 'SUBSCRIBED') {
          try {
            const trackResult = await ch.track({
              name: this.opts.myName,
              color: this.opts.myColor,
              online_at: new Date().toISOString(),
            });
            if (trackResult !== 'ok') {
              if (!initialSettled) initialDone(false, new Error('presence track ' + trackResult));
              return;
            }
          } catch (e) {
            if (!initialSettled) initialDone(false, e);
            return;
          }
          if (!initialSettled) {
            initialDone(true);
          } else if (!this.disposed) {
            // Reconnected after a mid-call drop. supabase-js re-established
            // the channel for us; tear down all PCs (their ICE/DTLS state is
            // stale relative to the peers' new view of the call) and let the
            // presence-sync handler rebuild them.
            this.rebuildAfterReconnect();
          }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          if (!initialSettled) {
            initialDone(false, err ?? new Error('realtime ' + status));
          } else if (!this.disposed) {
            // Mid-call drop. Flag reconnecting so the UI shows a banner;
            // supabase-js will retry and the SUBSCRIBED branch above
            // takes over from there.
            if (!this._reconnecting) {
              this._reconnecting = true;
              this.emit();
            }
          }
        }
      });
    });

    this.channel = ch;
    this._joined = true;
    this.emit();

    // Announce on the `active_calls` table so the notify-on-call webhook
    // fires push notifications to everyone in the channel. Fire-and-forget;
    // if it fails we still want the call to work locally.
    this.announcer = createCallAnnouncer({
      teamId: this.opts.teamId,
      channelId: this.opts.channelId,
      startedBy: this.opts.myPeerId,
    });
    this.announcer.start().catch((err) => console.warn('[mesh] announce failed', err));
  }

  // Mid-call realtime reconnect: drop every peer connection so we can
  // re-negotiate from scratch on the next presence sync. Keeping the old
  // PCs would mean the peers' ICE candidates from before the gap are still
  // mapped to closed UDP tuples — audio appears stuck even though Realtime
  // is back. Far cleaner to start fresh; the bandwidth cost of one extra
  // SDP exchange per peer is invisible vs. the user-visible silence.
  private rebuildAfterReconnect() {
    for (const conn of this.peers.values()) conn.close();
    this.peers.clear();
    // peerInfo (UI-visible roster) is left in place so the call screen
    // doesn't flicker to empty during the reconnect; entries are reconciled
    // when the presence-sync event fires moments later.
    this._reconnecting = false;
    this.emit();
  }

  private ensurePeer(remoteId: string): PeerConn {
    let conn = this.peers.get(remoteId);
    if (conn) return conn;
    conn = new PeerConn({
      remoteId,
      polite: isPolite(this.opts.myPeerId, remoteId),
      iceServers: this.iceServers,
      sendSignal: (payload) => this.sendSignal(remoteId, payload),
      onTrack: () => {
        // RN-WebRTC plays remote audio tracks through the active audio session
        // automatically — no <RTCView> needed for audio. We just note that
        // media is flowing; the UI infers "speaking" from connectionState.
      },
      onState: (state) => {
        const info = this.peerInfo.get(remoteId);
        if (info) {
          info.connectionState = state;
          this.emit();
        }
      },
    });
    this.peers.set(remoteId, conn);
    if (!this.peerInfo.has(remoteId)) {
      this.peerInfo.set(remoteId, {
        id: remoteId,
        micOn: true,
        connectionState: 'new',
      });
      this.emit();
    }
    // Attach our local audio at creation so the very first offer/answer
    // already carries our send direction. addTrack fires
    // onnegotiationneeded once we exit this turn of the event loop, which
    // perfect-negotiation glare-resolves against any inbound offer from
    // the same peer arriving in parallel.
    if (this.localStream) conn.addLocalStream(this.localStream);
    return conn;
  }

  private dropPeer(remoteId: string) {
    const conn = this.peers.get(remoteId);
    if (conn) {
      conn.close();
      this.peers.delete(remoteId);
    }
    this.peerInfo.delete(remoteId);
  }

  private sendSignal(to: string, payload: SignalPayload) {
    this.channel?.send({
      type: 'broadcast',
      event: 'signal',
      payload: { from: this.opts.myPeerId, to, payload },
    });
  }

  toggleMic(): boolean {
    if (!this.localStream) return this._micOn;
    const next = !this._micOn;
    for (const t of this.localStream.getAudioTracks()) t.enabled = next;
    this._micOn = next;
    this.publishMuteState();
    this.emit();
    return next;
  }

  private publishMuteState() {
    this.channel?.send({
      type: 'broadcast',
      event: 'mute-state',
      payload: { from: this.opts.myPeerId, micOn: this._micOn, camOn: false },
    });
  }

  async disconnect(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // Stop the active_calls heartbeat. We deliberately don't delete the row
    // — see call-announce.ts / the migration comment: a delete-on-leave
    // races other participants' heartbeats and would re-fire the push.
    // The row goes stale 5 min after the last heartbeat and the next call
    // attempt sweeps it.
    if (this.announcer) {
      this.announcer.stop();
      this.announcer = null;
    }
    for (const conn of this.peers.values()) conn.close();
    this.peers.clear();
    this.peerInfo.clear();
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop();
      this.localStream = null;
    }
    if (this.channel) {
      try { await this.channel.unsubscribe(); } catch { /* already gone */ }
      this.channel = null;
    }
    this._joined = false;
    this.emit();
  }
}
