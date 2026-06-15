import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { getProfile } from '@/lib/api';
import { callTopic } from '@/lib/topics';
import { useAuth } from '@/context/AuthContext';
import { useCall } from '@/context/CallContext';

// Per-call Supabase Realtime channel for the ephemeral "call-plane" signals
// that don't ride the media tracks: raise-hand, emoji reactions, and mic/cam
// mute-state. Desktop subscribes the exact same topic (`call:<team>:<channel>`)
// and event/payload shapes (renderer/api.js _joinCallInner + send* helpers), so
// these interop live between mobile and desktop participants.
//
// Lives as a child of CallProvider so it can mirror the activeCall lifecycle:
// the channel comes up when a call starts and tears down on endCall / switch.
// It deliberately does NOT reuse PresenceContext's team channel — that's a
// team-wide, always-on topic with the wrong scope and lifetime.

export type ReactionPayload = { from: string; emoji: string };
export type MediaState = { micOn: boolean; camOn: boolean };

type State = {
  // userIds with a raised hand, including self. Tile overlays match against
  // this by the participant's identity base (see callIdentityBase).
  raisedHands: Set<string>;
  myHandRaised: boolean;
  toggleRaiseHand: () => void;
  // Broadcast an emoji reaction (and mirror locally so the sender sees it).
  sendReaction: (emoji: string) => void;
  // Subscribe to reactions (self + remote); returns an unsubscribe fn.
  onReaction: (cb: (p: ReactionPayload) => void) => () => void;
  // Remote peers' mic/cam state, keyed by userId. Mainly a desktop-parity
  // safeguard — LiveKit also exposes publication.isMuted.
  peerMediaState: Record<string, MediaState>;
  broadcastMuteState: (micOn: boolean, camOn: boolean) => void;
};

// LiveKit hands the local participant identity `user.id`; only desktop screen
// popouts append a `::popout::<uuid>` suffix (see livekit-token edge fn). Strip
// it so tile overlays match the bare userId used as the broadcast `from`.
export function callIdentityBase(identity: string): string {
  return identity.split('::')[0];
}

const Ctx = createContext<State | undefined>(undefined);

export function CallSignalsProvider({ children }: { children: React.ReactNode }) {
  const { activeTeam, userId } = useAuth();
  const { activeCall } = useCall();
  const channelId = activeCall?.channelId ?? null;

  const [remoteRaised, setRemoteRaised] = useState<Set<string>>(new Set());
  const [myHandRaised, setMyHandRaised] = useState(false);
  const [peerMediaState, setPeerMediaState] = useState<Record<string, MediaState>>({});

  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  // `subscribed` is state (not a ref) so that when the channel finishes
  // subscribing, broadcastMuteState is recreated and CallView's mute-state
  // effect re-runs to send the initial state — a ref wouldn't re-render.
  const [subscribed, setSubscribed] = useState(false);
  const reactionCbs = useRef<Set<(p: ReactionPayload) => void>>(new Set());

  useEffect(() => {
    if (!activeTeam?.id || !userId || !channelId) {
      // No active call → clear call-scoped state so nothing leaks into the
      // next call (this provider outlives individual calls).
      setRemoteRaised(new Set());
      setMyHandRaised(false);
      setPeerMediaState({});
      setSubscribed(false);
      return;
    }
    let active = true;
    setSubscribed(false);
    // Reset call-scoped state when (re)joining a call/channel.
    setRemoteRaised(new Set());
    setMyHandRaised(false);
    setPeerMediaState({});

    const ch = supabase.channel(callTopic(activeTeam.id, channelId), {
      config: { presence: { key: userId }, broadcast: { self: false, ack: false }, private: true },
    });

    // Prune signal state for peers who leave the call (mirrors desktop's
    // presence-sync cleanup so a stale raised hand / mute pip can't linger).
    const prune = () => {
      if (!active) return;
      const present = new Set(Object.keys(ch.presenceState()));
      setRemoteRaised((prev) => {
        const next = new Set([...prev].filter((id) => present.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setPeerMediaState((prev) => {
        const next: Record<string, MediaState> = {};
        for (const [id, st] of Object.entries(prev)) if (present.has(id)) next[id] = st;
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
    };

    // Bindings must be attached before subscribe() — realtime-js rejects
    // presence callbacks added afterwards.
    ch.on('presence', { event: 'sync' }, prune);
    ch.on('presence', { event: 'leave' }, prune);
    ch.on('broadcast', { event: 'raise-hand' }, ({ payload }) => {
      if (!payload?.from || payload.from === userId) return;
      setRemoteRaised((prev) => {
        const next = new Set(prev);
        if (payload.raised) next.add(payload.from);
        else next.delete(payload.from);
        return next;
      });
    });
    ch.on('broadcast', { event: 'mute-state' }, ({ payload }) => {
      if (!payload?.from) return;
      setPeerMediaState((prev) => ({
        ...prev,
        [payload.from]: { micOn: !!payload.micOn, camOn: !!payload.camOn },
      }));
    });
    ch.on('broadcast', { event: 'reaction' }, ({ payload }) => {
      if (!payload?.from || !payload?.emoji) return;
      reactionCbs.current.forEach((cb) => cb(payload as ReactionPayload));
    });

    ch.subscribe(async (status) => {
      if (status !== 'SUBSCRIBED' || !active) return;
      setSubscribed(true);
      // Track presence so desktop's pre-join "Join call · N" count and its
      // _callPeerInfo name/color fallback include this mobile participant.
      let name = '';
      let color: string | null = null;
      try {
        const p = await getProfile(userId);
        name = p?.name ?? '';
        color = p?.color ?? null;
      } catch {}
      if (!active) return;
      ch.track({ name, color, online_at: new Date().toISOString() }).catch(() => {});
    });
    channelRef.current = ch;

    return () => {
      active = false;
      channelRef.current = null;
      supabase.removeChannel(ch);
    };
  }, [activeTeam?.id, userId, channelId]);

  const toggleRaiseHand = useCallback(() => {
    if (!userId) return;
    const raised = !myHandRaised;
    setMyHandRaised(raised);
    // Side effect kept out of the state updater (updaters must stay pure).
    const ch = channelRef.current;
    if (ch && subscribed) {
      ch.send({ type: 'broadcast', event: 'raise-hand', payload: { from: userId, raised } });
    }
  }, [userId, myHandRaised, subscribed]);

  const sendReaction = useCallback(
    (emoji: string) => {
      const ch = channelRef.current;
      if (!userId) return;
      // self:false on the channel, so mirror locally for the sender's own tile.
      reactionCbs.current.forEach((cb) => cb({ from: userId, emoji }));
      if (ch && subscribed) {
        ch.send({ type: 'broadcast', event: 'reaction', payload: { from: userId, emoji } });
      }
    },
    [userId, subscribed],
  );

  const onReaction = useCallback((cb: (p: ReactionPayload) => void) => {
    reactionCbs.current.add(cb);
    return () => { reactionCbs.current.delete(cb); };
  }, []);

  const broadcastMuteState = useCallback(
    (micOn: boolean, camOn: boolean) => {
      const ch = channelRef.current;
      if (!ch || !subscribed || !userId) return;
      ch.send({ type: 'broadcast', event: 'mute-state', payload: { from: userId, micOn, camOn } });
    },
    [userId, subscribed],
  );

  const raisedHands = useMemo(() => {
    if (!myHandRaised || !userId) return remoteRaised;
    const next = new Set(remoteRaised);
    next.add(userId);
    return next;
  }, [remoteRaised, myHandRaised, userId]);

  const value = useMemo<State>(
    () => ({
      raisedHands,
      myHandRaised,
      toggleRaiseHand,
      sendReaction,
      onReaction,
      peerMediaState,
      broadcastMuteState,
    }),
    [raisedHands, myHandRaised, toggleRaiseHand, sendReaction, onReaction, peerMediaState, broadcastMuteState],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCallSignals(): State {
  const v = useContext(Ctx);
  if (!v) throw new Error('useCallSignals must be used within CallSignalsProvider');
  return v;
}
