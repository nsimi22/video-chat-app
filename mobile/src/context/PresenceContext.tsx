import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { getProfile } from '@/lib/api';
import { teamTopic } from '@/lib/topics';
import { useAuth } from '@/context/AuthContext';
import type { PresenceStatus } from '@/theme';

// Team presence over the `team:<team_id>` realtime topic — the same topic
// desktop tracks on ({ name, color, online_at }, renderer/api.js). Mobile
// adds a `status` field (active / away / busy) for the You-tab presence
// selector; desktop currently ignores it and just shows online/offline,
// so the extra key is forward-compatible, not a protocol break.
//
// This provider owns the ONE channel instance for the topic. Phoenix
// allows a single join per topic per socket, so the chat screen's typing
// broadcast goes through sendTyping()/onTyping() here instead of creating
// its own channel (which would race this one for the topic).

export type TypingPayload = { from: string; name: string; channelId: string };

type State = {
  // userId -> presence status for everyone currently tracked on the topic.
  // Absent key = offline.
  statuses: Record<string, PresenceStatus>;
  myStatus: PresenceStatus;
  setMyStatus: (s: PresenceStatus) => void;
  sendTyping: (payload: TypingPayload) => void;
  // Register a typing listener; returns unsubscribe. Callbacks are fanned
  // out from a single broadcast binding attached before subscribe.
  onTyping: (cb: (payload: TypingPayload) => void) => () => void;
};

const Ctx = createContext<State | undefined>(undefined);

export function PresenceProvider({ children }: { children: React.ReactNode }) {
  const { activeTeam, userId } = useAuth();
  const [statuses, setStatuses] = useState<Record<string, PresenceStatus>>({});
  const [myStatus, setMyStatusState] = useState<PresenceStatus>('active');
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const typingCbs = useRef<Set<(p: TypingPayload) => void>>(new Set());
  const myStatusRef = useRef<PresenceStatus>('active');
  const subscribedRef = useRef(false);
  // Last name/color we tracked with. setMyStatus re-tracks from this ref —
  // reading presenceState() instead would race the initial track's server
  // round-trip and could blank the user's name for every peer.
  const myMetaRef = useRef<{ name: string; color: string | null } | null>(null);

  useEffect(() => {
    if (!activeTeam?.id || !userId) return;
    let active = true;
    subscribedRef.current = false;
    const ch = supabase.channel(teamTopic(activeTeam.id), {
      config: { presence: { key: userId }, broadcast: { self: false }, private: true },
    });

    const readState = () => {
      if (!active) return;
      const state = ch.presenceState<{ status?: string }>();
      const next: Record<string, PresenceStatus> = {};
      for (const [key, metas] of Object.entries(state)) {
        const s = metas[metas.length - 1]?.status;
        next[key] = s === 'away' || s === 'brb' || s === 'unavailable' ? s : 'active';
      }
      setStatuses(next);
    };

    // All bindings attached before subscribe — realtime-js rejects
    // presence callbacks added afterwards.
    ch.on('presence', { event: 'sync' }, readState);
    ch.on('presence', { event: 'join' }, readState);
    ch.on('presence', { event: 'leave' }, readState);
    ch.on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (!payload?.channelId || payload.from === userId) return;
      typingCbs.current.forEach((cb) => cb(payload as TypingPayload));
    });

    ch.subscribe(async (status) => {
      if (status !== 'SUBSCRIBED' || !active) return;
      subscribedRef.current = true;
      // Track with the desktop-compatible payload. Profile fetch is
      // best-effort — presence without a name still beats no presence.
      let name = '';
      let color: string | null = null;
      try {
        const p = await getProfile(userId);
        name = p?.name ?? '';
        color = p?.color ?? null;
      } catch {}
      if (!active) return;
      myMetaRef.current = { name, color };
      // myStatusRef (not a captured value) so a status picked while the
      // profile fetch was in flight still rides this initial track.
      ch.track({ name, color, online_at: new Date().toISOString(), status: myStatusRef.current }).catch(() => {});
    });
    channelRef.current = ch;

    return () => {
      active = false;
      subscribedRef.current = false;
      channelRef.current = null;
      myMetaRef.current = null;
      setStatuses({});
      supabase.removeChannel(ch);
    };
  }, [activeTeam?.id, userId]);

  const setMyStatus = useCallback((s: PresenceStatus) => {
    myStatusRef.current = s;
    setMyStatusState(s);
    const ch = channelRef.current;
    // Skip the immediate re-track until the initial profile track has run
    // (myMetaRef set) — tracking now would broadcast an empty name to every
    // peer, and the pending initial track already carries the new status
    // via myStatusRef.
    if (ch && subscribedRef.current && myMetaRef.current) {
      ch.track({
        ...myMetaRef.current,
        online_at: new Date().toISOString(),
        status: s,
      }).catch(() => {});
    }
  }, []);

  const sendTyping = useCallback((payload: TypingPayload) => {
    const ch = channelRef.current;
    if (!ch || !subscribedRef.current) return;
    ch.send({ type: 'broadcast', event: 'typing', payload });
  }, []);

  const onTyping = useCallback((cb: (p: TypingPayload) => void) => {
    typingCbs.current.add(cb);
    return () => { typingCbs.current.delete(cb); };
  }, []);

  const value = useMemo<State>(
    () => ({ statuses, myStatus, setMyStatus, sendTyping, onTyping }),
    [statuses, myStatus, setMyStatus, sendTyping, onTyping],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePresence(): State {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePresence must be used within PresenceProvider');
  return v;
}
