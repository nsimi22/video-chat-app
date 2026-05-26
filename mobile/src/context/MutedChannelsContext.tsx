import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { loadMutedChannels, saveMutedChannels } from '@/lib/mutedChannels';

// Per-device muted-channels store, persisted to SecureStore so the
// preference survives app restarts. Mute means "don't surface unread
// for this channel": the UnreadContext reads from here and skips bumps
// for muted channels entirely. Desktop has its own client-side mute
// (renderer/app.js isChannelMuted); cross-device sync would need a new
// table and is out of scope here.

type State = {
  isMuted: (channelId: string) => boolean;
  toggle: (channelId: string) => void;
  // Render-trigger value used by the unread provider so it can read
  // through to isMuted at INSERT time without subscribing the entire
  // realtime handler effect to context changes.
  mutedSet: Set<string>;
};

const Ctx = createContext<State | undefined>(undefined);

export function MutedChannelsProvider({ children }: { children: React.ReactNode }) {
  const [muted, setMuted] = useState<Set<string>>(() => new Set());
  // Ref mirror so callers (UnreadProvider's INSERT handler, mostly)
  // can read the current set without their useEffect deps tearing
  // down + re-subscribing every time a user toggles a mute.
  const mutedRef = useRef<Set<string>>(muted);

  // Initial load — async; surface as a no-op until it resolves so
  // callers don't have to gate on a loading flag. Worst case: a
  // muted channel briefly registers an unread bump on app launch
  // before the load completes, then clears itself once active. The
  // user-visible window is ≤100ms in practice.
  useEffect(() => {
    let cancelled = false;
    loadMutedChannels().then((s) => {
      if (cancelled) return;
      mutedRef.current = s;
      setMuted(s);
    });
    return () => { cancelled = true; };
  }, []);

  const isMuted = useCallback((channelId: string) => mutedRef.current.has(channelId), []);

  const toggle = useCallback((channelId: string) => {
    setMuted((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      mutedRef.current = next;
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
