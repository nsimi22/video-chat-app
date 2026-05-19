// Internal scheduled-calls API — mirror of renderer/api.js
// (loadScheduledCalls / createScheduledCall / deleteScheduledCall /
// subscribeScheduledCalls). Same Supabase table + RLS as desktop, so
// scheduling from mobile shows up on desktop via realtime and vice versa.

import { supabase } from './supabase';

export type ScheduledCall = {
  id: string;
  teamId: string;
  channelId: string;
  createdBy: string;
  title: string;
  description: string;
  startsAt: Date;
  durationMin: number;
  createdAt: Date;
  updatedAt: Date;
};

type Row = {
  id: string;
  team_id: string;
  channel_id: string;
  created_by: string;
  title: string;
  description: string | null;
  starts_at: string;
  duration_min: number;
  created_at: string;
  updated_at: string;
};

function marshal(row: Row): ScheduledCall {
  return {
    id: row.id,
    teamId: row.team_id,
    channelId: row.channel_id,
    createdBy: row.created_by,
    title: row.title,
    description: row.description ?? '',
    startsAt: new Date(row.starts_at),
    durationMin: row.duration_min,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

// Default `from` = 1h ago so a call that just started still shows up
// (people often rejoin a just-started scheduled call). Matches the
// desktop default.
export async function loadScheduledCalls(
  teamId: string,
  { from = new Date(Date.now() - 60 * 60 * 1000), limit = 500 }: { from?: Date; limit?: number } = {},
): Promise<ScheduledCall[]> {
  const { data, error } = await supabase
    .from('scheduled_calls')
    .select('*')
    .eq('team_id', teamId)
    .gte('starts_at', from.toISOString())
    .order('starts_at', { ascending: true })
    .limit(limit);
  if (error) {
    console.warn('loadScheduledCalls failed', error.message, error.details ?? '', error.hint ?? '', error.code ?? '');
    return [];
  }
  return ((data ?? []) as Row[]).map(marshal);
}

export async function createScheduledCall(args: {
  teamId: string;
  channelId: string;
  createdBy: string;
  title: string;
  description?: string;
  startsAt: Date;
  durationMin?: number;
}): Promise<ScheduledCall> {
  if (isNaN(args.startsAt.getTime())) throw new Error('invalid startsAt');
  const { data, error } = await supabase
    .from('scheduled_calls')
    .insert({
      team_id: args.teamId,
      channel_id: args.channelId,
      created_by: args.createdBy,
      title: args.title,
      description: args.description ?? '',
      starts_at: args.startsAt.toISOString(),
      duration_min: args.durationMin ?? 30,
    })
    .select()
    .single();
  if (error) throw error;
  return marshal(data as Row);
}

export async function deleteScheduledCall(id: string): Promise<void> {
  const { error } = await supabase.from('scheduled_calls').delete().eq('id', id);
  if (error) throw error;
}

export type ScheduledCallEvent =
  | { kind: 'upsert'; row: ScheduledCall }
  | { kind: 'delete'; id: string };

// Realtime fan-in matching desktop's `scheduled_calls:<teamId>` channel.
// Returns a cleanup fn the caller invokes on unmount.
export function subscribeScheduledCalls(
  teamId: string,
  handler: (evt: ScheduledCallEvent) => void,
): () => void {
  const ch = supabase
    .channel(`scheduled_calls:${teamId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'scheduled_calls', filter: `team_id=eq.${teamId}` },
      (payload) => {
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string } | null)?.id;
          if (id) handler({ kind: 'delete', id });
        } else if (payload.new) {
          handler({ kind: 'upsert', row: marshal(payload.new as Row) });
        }
      },
    )
    .subscribe();
  return () => {
    supabase.removeChannel(ch);
  };
}
