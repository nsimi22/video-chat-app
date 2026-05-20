import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { supabase } from '@/lib/supabase';
import { fetchMessages, fetchMessagesSince, type Message } from '@/lib/api';

// Loads paginated message history for a channel and keeps it live via a
// postgres_changes subscription on public.messages. Channel `id` is only unique
// per team (composite PK), so — like the desktop renderer — we subscribe with a
// team_id filter and narrow to this channel client-side.
//
// Supabase postgres_changes is at-most-once: any INSERT that fires while the
// websocket is reconnecting is silently dropped. Mobile is doubly exposed
// because the WS is torn down every time the app backgrounds. We therefore
// run a catch-up query (a) when the channel re-SUBSCRIBES after a transient
// drop and (b) when AppState returns to 'active', then merge by message id
// (the existing INSERT dedupe handles realtime/catch-up overlap).
export function useChannelMessages(teamId: string, channelId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const oldestTs = useRef<string | null>(null);
  const latestTs = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setLoading(true);
    setHasMore(true);
    oldestTs.current = null;
    latestTs.current = null;
    let firstSubscribe = true;

    fetchMessages(teamId, channelId)
      .then((rows) => {
        if (!active) return;
        setMessages(rows);
        oldestTs.current = rows[0]?.ts ?? null;
        latestTs.current = rows[rows.length - 1]?.ts ?? null;
        setHasMore(rows.length >= 50);
        setLoading(false);
      })
      .catch((e) => {
        if (!active) return;
        console.warn('fetchMessages failed', e);
        setHasMore(false);
        setLoading(false);
      });

    const catchUp = async () => {
      if (!active || !latestTs.current) return;
      try {
        const since = latestTs.current;
        const rows = await fetchMessagesSince(teamId, channelId, since);
        if (!active || rows.length === 0) return;
        setMessages((prev) => {
          const have = new Set(prev.map((m) => m.id));
          const adds = rows.filter((m) => !m.parent_id && !have.has(m.id));
          if (adds.length === 0) return prev;
          return [...prev, ...adds];
        });
        const newest = rows[rows.length - 1]?.ts;
        if (newest && newest > (latestTs.current ?? '')) latestTs.current = newest;
      } catch (e) {
        console.warn('chat catch-up failed', e);
      }
    };

    const channel = supabase
      .channel(`db:messages:${teamId}:${channelId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `team_id=eq.${teamId}` },
        (payload) => {
          if (!active) return;
          if (payload.eventType === 'INSERT') {
            const m = payload.new as Message;
            if (m.channel_id !== channelId || m.parent_id) return; // other channel / thread reply
            if (m.ts && m.ts > (latestTs.current ?? '')) latestTs.current = m.ts;
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          } else if (payload.eventType === 'UPDATE') {
            const m = payload.new as Message;
            if (m.channel_id !== channelId) return;
            if (m.ts && m.ts > (latestTs.current ?? '')) latestTs.current = m.ts;
            setMessages((prev) => prev.map((x) => (x.id === m.id ? m : x)));
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id: string; channel_id?: string };
            // DELETE payloads only carry replica-identity columns; id is the PK.
            setMessages((prev) => prev.filter((x) => x.id !== old.id));
          }
        },
      )
      .subscribe((status) => {
        if (status !== 'SUBSCRIBED') return;
        if (firstSubscribe) {
          firstSubscribe = false;
          return;
        }
        // Reconnect after a transient drop — fill any gap.
        catchUp();
      });

    // Belt-and-suspenders: the WS sometimes auto-reconnects silently
    // *before* the SUBSCRIBED callback observes it (notably when iOS
    // brings the app back from a long background). Re-run catch-up
    // when AppState returns to 'active'.
    const onAppStateChange = (state: AppStateStatus) => {
      if (state === 'active') catchUp();
    };
    const appStateSub = AppState.addEventListener('change', onAppStateChange);

    return () => {
      active = false;
      appStateSub.remove();
      supabase.removeChannel(channel);
    };
  }, [teamId, channelId]);

  const loadOlder = useCallback(async () => {
    if (!hasMore || !oldestTs.current) return;
    const older = await fetchMessages(teamId, channelId, oldestTs.current);
    if (older.length) {
      setMessages((prev) => [...older, ...prev]);
      oldestTs.current = older[0].ts;
    }
    if (older.length < 50) setHasMore(false);
  }, [teamId, channelId, hasMore]);

  return { messages, loading, hasMore, loadOlder };
}
