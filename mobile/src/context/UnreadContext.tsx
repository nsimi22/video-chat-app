import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { getProfile, type Message } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import { useMutedChannels } from '@/context/MutedChannelsContext';

// Per-channel unread counter, fed by a single team-wide postgres_changes
// subscription on public.messages. In-memory only — matches the desktop
// renderer's model (renderer/app.js, `state.unread`). Backgrounding the
// app or signing out drops the counts; persistence + cross-device sync
// is a separate, bigger feature (would need a new channel_read_state
// table + an RPC, kept out of scope here).
//
// "Loud" vs "regular":
//   - Loud: DMs (channel id starts with `dm:` / `gdm:`), any message
//     whose `mentions` array carries our display name, or the
//     broadcast sentinels `@here` / `@channel`.
//   - Regular: everything else — counts toward the badge count but
//     renders in the muted style.
//
// We deliberately skip thread replies (m.parent_id != null) and our
// own messages — the desktop sidebar makes the same call and a user
// double-bumping their own send would be a poor experience.

export type UnreadEntry = { count: number; loud: boolean };

type State = {
  unreadFor: (channelId: string) => UnreadEntry | null;
  // Channel screen calls this on focus with its id, and on blur with
  // null. Setting an active channel clears its existing unread (the
  // act of opening it = reading it) and suppresses further bumps
  // while the user is still in the channel.
  //
  // Accepts a functional update form so blur cleanups can clear
  // *only* if they're still the active channel — React Navigation 7
  // (which expo-router rides on) can fire a newly-focused screen's
  // effect before the blurring screen's cleanup, and a naive
  // `setActiveChannel(null)` on blur would then wipe out the newer
  // registration.
  setActiveChannel: (arg: string | null | ((prev: string | null) => string | null)) => void;
  // Sum of LOUD unread counts across all channels. Drives the
  // Channels tab's badge (the icon-tray indicator on the bottom tab
  // bar), separate from per-row badges so a busy non-loud channel
  // doesn't claim the tab icon.
  totalLoud: number;
};

const Ctx = createContext<State | undefined>(undefined);

function isDmChannelId(channelId: string): boolean {
  return channelId.startsWith('dm:') || channelId.startsWith('gdm:');
}

export function UnreadProvider({ children }: { children: React.ReactNode }) {
  const { activeTeam, userId } = useAuth();
  // Muted channels suppress bumps entirely (no count, no badge, no
  // contribution to totalLoud). isMuted is callback-stable (useCallback
  // with []) so reading it inside the realtime handler doesn't force a
  // resubscribe every time the user toggles a mute.
  const { isMuted } = useMutedChannels();
  const [unread, setUnread] = useState<Map<string, UnreadEntry>>(new Map());
  // Display name used for @mention matching. mentions is stored as
  // resolved names (see renderer/api.js extractMentions), so we
  // compare against this string lowercased. Kept in a ref so the
  // realtime subscription doesn't tear down + re-establish (and
  // potentially miss bumps in the gap) when the profile fetch
  // resolves a moment after mount.
  const myNameRef = useRef<string | null>(null);
  // Active-channel id tracked via ref so the realtime handler reads
  // the current value without re-subscribing on every focus change.
  const activeChannelRef = useRef<string | null>(null);

  // Fetch our own profile once per signed-in user so we can match
  // mentions. Loud-mention detection silently degrades to dms-only
  // while this is in flight — acceptable since mention matching
  // can't possibly be right before we know our own name anyway.
  useEffect(() => {
    if (!userId) { myNameRef.current = null; return; }
    let cancelled = false;
    getProfile(userId)
      .then((p) => { if (!cancelled) myNameRef.current = p?.name ?? null; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [userId]);

  // Reset unread state whenever the user signs out or switches teams —
  // counts belong to one (user, team) pair, mixing them would be wrong.
  useEffect(() => {
    setUnread(new Map());
    activeChannelRef.current = null;
  }, [activeTeam?.id, userId]);

  const setActiveChannel = useCallback(
    (arg: string | null | ((prev: string | null) => string | null)) => {
      const nextChannel = typeof arg === 'function' ? arg(activeChannelRef.current) : arg;
      activeChannelRef.current = nextChannel;
      if (nextChannel) {
        // Reading clears. Skip the state update when the entry was
        // already absent so we don't trigger a no-op re-render of
        // every UnreadBadge consumer.
        setUnread((prev) => {
          if (!prev.has(nextChannel)) return prev;
          const next = new Map(prev);
          next.delete(nextChannel);
          return next;
        });
      }
    },
    [],
  );

  // Single team-wide subscription that fans out into per-channel
  // counters. Mirrors how the desktop's MessageBus listens once at
  // the team level and lets the renderer decide which channel each
  // incoming message belongs to.
  useEffect(() => {
    if (!activeTeam?.id || !userId) return;
    const teamId = activeTeam.id;
    const channel = supabase
      .channel(`db:messages:unread:${teamId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `team_id=eq.${teamId}` },
        (payload) => {
          const m = payload.new as Message;
          // Thread replies live under a parent message; the channel
          // list never surfaces them, so they shouldn't trigger a
          // banner here either.
          if (m.parent_id) return;
          // Self-sends — the user just hit Send; bumping their own
          // unread would flash a 1 next to a channel they're staring at.
          if (m.author_id === userId) return;
          // Currently-viewed channel: reading-as-it-arrives, no bump.
          if (m.channel_id === activeChannelRef.current) return;
          // Muted channel: user explicitly silenced this room. Skip
          // the bump entirely — no count, no dot, no contribution to
          // the tab's loud badge. Mute is a stronger signal than
          // DM/mention; even an @-mention in a muted channel is
          // suppressed (matches Slack semantics).
          if (isMuted(m.channel_id)) return;
          const mentions = m.mentions || [];
          const lowerName = myNameRef.current?.toLowerCase() ?? null;
          const mentionsMe = !!lowerName && mentions.some((n) => n.toLowerCase() === lowerName);
          const broadcast = mentions.includes('@here') || mentions.includes('@channel');
          const loud = isDmChannelId(m.channel_id) || mentionsMe || broadcast;
          setUnread((prev) => {
            const next = new Map(prev);
            const cur = next.get(m.channel_id);
            next.set(m.channel_id, {
              count: (cur?.count ?? 0) + 1,
              // Stay loud once any loud message has landed in this
              // channel — a single mention shouldn't be hidden behind
              // a wall of subsequent plain-channel chatter.
              loud: !!cur?.loud || loud,
            });
            return next;
          });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeTeam?.id, userId]);

  const unreadFor = useCallback((channelId: string) => unread.get(channelId) ?? null, [unread]);

  // Sum of loud unreads, recomputed only when the map identity flips
  // (every bump or clear builds a new Map so React sees the change).
  const totalLoud = useMemo(() => {
    let n = 0;
    for (const entry of unread.values()) {
      if (entry.loud) n += entry.count;
    }
    return n;
  }, [unread]);

  const value = useMemo<State>(() => ({ unreadFor, setActiveChannel, totalLoud }), [unreadFor, setActiveChannel, totalLoud]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUnread(): State {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUnread must be used within UnreadProvider');
  return v;
}
