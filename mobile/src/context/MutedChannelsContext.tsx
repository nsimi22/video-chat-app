import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { loadMutedChannels, saveMutedChannels } from '@/lib/mutedChannels';

// Per-device muted-channels store, persisted to SecureStore so the
// preference survives app restarts. Mute means "don't surface unread
// for this channel": the UnreadContext reads from here and skips bumps
// for muted channels entirely. Desktop has its own client-side mute
// (renderer/app.js isChannelMuted); cross-device sync would need a new
// table and is out of scope here.

type State = {
  // Reactive accessor — depends on `muted` state, so consumers that
  // render based on mute state (the row UI, the audit effect in
  // UnreadProvider that clears existing unreads when a channel is
  // muted) re-render when toggle() fires.
  //
  // For non-rendering reads (the realtime INSERT handler in
  // UnreadProvider) consumers snapshot this into a ref to avoid
  // re-subscribing the WebSocket on every toggle.
  isMuted: (channelId: string) => boolean;
  toggle: (channelId: string) => void;
  // Raw set exposed so dependent effects can subscribe to changes via
  // useEffect([mutedSet, …]) — needed by the auto-clear effect in
  // UnreadProvider.
  mutedSet: Set<string>;
};

const Ctx = createContext<State | undefined>(undefined);

export function MutedChannelsProvider({ children }: { children: React.ReactNode }) {
  // Lazy initializer keeps the empty-Set allocation off every
  // subsequent render after the first.
  const [muted, setMuted] = useState<Set<string>>(() => new Set());

  // Initial load — async; surface as a no-op until it resolves so
  // callers don't have to gate on a loading flag. UnreadProvider's
  // auto-clear effect catches any unread that briefly accumulated for
  // a muted channel between mount and load.
  useEffect(() => {
    let cancelled = false;
    loadMutedChannels().then((s) => {
      if (cancelled) return;
      setMuted(s);
    });
    return () => { cancelled = true; };
  }, []);

  // Reactive — re-renders on every toggle. Consumers that need a
  // stable handle for non-rendering reads (subscription handlers,
  // long-lived effects) should mirror this into a ref themselves.
  const isMuted = useCallback((channelId: string) => muted.has(channelId), [muted]);

  const toggle = useCallback((channelId: string) => {
    setMuted((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      // Fire-and-forget persistence — the in-memory state is the
      // source of truth this session and reload picks the persisted
      // value back up. A failed write logs in the helper and the
      // user retoggles if it really matters.
      saveMutedChannels(next).catch(() => {});
      return next;
    });
  }, []);

  const value = useMemo<State>(() => ({ isMuted, toggle, mutedSet: muted }), [isMuted, toggle, muted]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMutedChannels(): State {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMutedChannels must be used within MutedChannelsProvider');
  return v;
}
