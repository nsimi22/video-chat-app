import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fetchMessages, type Message } from '@/lib/api';

// Loads paginated message history for a channel and keeps it live via a
// postgres_changes subscription on public.messages (INSERT/UPDATE/DELETE),
// scoped to the channel. Mirrors the desktop renderer's chat subscription.
export function useChannelMessages(teamId: string, channelId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const oldestTs = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setLoading(true);
    setHasMore(true);
    oldestTs.current = null;

    fetchMessages(teamId, channelId).then((rows) => {
      if (!active) return;
      setMessages(rows);
      oldestTs.current = rows[0]?.ts ?? null;
      setHasMore(rows.length >= 50);
      setLoading(false);
    });

    const channel = supabase
      .channel(`db:messages:${channelId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `channel_id=eq.${channelId}` },
        (payload) => {
          if (!active) return;
          if (payload.eventType === 'INSERT') {
            const m = payload.new as Message;
            if (m.parent_id) return; // thread replies handled in the thread view
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          } else if (payload.eventType === 'UPDATE') {
            const m = payload.new as Message;
            setMessages((prev) => prev.map((x) => (x.id === m.id ? m : x)));
          } else if (payload.eventType === 'DELETE') {
            const id = (payload.old as { id: string }).id;
            setMessages((prev) => prev.filter((x) => x.id !== id));
          }
        },
      )
      .subscribe();

    return () => {
      active = false;
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
