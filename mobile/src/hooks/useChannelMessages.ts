import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { fetchMessages, type Message } from '@/lib/api';

// Loads paginated message history for a channel and keeps it live via a
// postgres_changes subscription on public.messages. Channel `id` is only unique
// per team (composite PK), so — like the desktop renderer — we subscribe with a
// team_id filter and narrow to this channel client-side.
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
      .channel(`db:messages:${teamId}:${channelId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'messages', filter: `team_id=eq.${teamId}` },
        (payload) => {
          if (!active) return;
          if (payload.eventType === 'INSERT') {
            const m = payload.new as Message;
            if (m.channel_id !== channelId || m.parent_id) return; // other channel / thread reply
            setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
          } else if (payload.eventType === 'UPDATE') {
            const m = payload.new as Message;
            if (m.channel_id !== channelId) return;
            setMessages((prev) => prev.map((x) => (x.id === m.id ? m : x)));
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id: string; channel_id?: string };
            // DELETE payloads only carry replica-identity columns; id is the PK.
            setMessages((prev) => prev.filter((x) => x.id !== old.id));
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
