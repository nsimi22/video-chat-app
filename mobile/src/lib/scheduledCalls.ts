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

// `from` bounds how far back to load; omit it to load full history (the
// calendar keeps past events visible when scrolling back). The unbounded
// path orders DESCENDING + limit so that if the team ever outgrows the
// row cap it's the *oldest* events that drop, never upcoming ones, then
// reverses back to ascending for callers.
export async function loadScheduledCalls(
  teamId: string,
  { from, limit = 500 }: { from?: Date; limit?: number } = {},
): Promise<ScheduledCall[]> {
  let q = supabase
    .from('scheduled_calls')
    .select('*')
    .eq('team_id', teamId)
    .order('starts_at', { ascending: !!from })
    .limit(limit);
  if (from) q = q.gte('starts_at', from.toISOString());
  const { data, error } = await q;
  if (error) {
    console.warn('loadScheduledCalls failed', error.message, error.details ?? '', error.hint ?? '', error.code ?? '');
    return [];
  }
  const rows = ((data ?? []) as Row[]).map(marshal);
  return from ? rows : rows.reverse();
}

// Single-row lookup by id — used by the detail screen so it doesn't have
// to pull the whole team's history to find one row. Returns null if the
// row doesn't exist (or RLS hid it).
export async function getScheduledCall(id: string): Promise<ScheduledCall | null> {
  const { data, error } = await supabase
    .from('scheduled_calls')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.warn('getScheduledCall failed', error.message, error.code ?? '');
    return null;
  }
  return data ? marshal(data as Row) : null;
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

// --- RSVP / attendees --------------------------------------------------
// Mirror of renderer/api.js setRsvp / clearRsvp / subscribeCallAttendees.
// Same scheduled_call_attendees table + RLS as desktop, so an RSVP from
// mobile shows up on desktop and vice versa.

export type AttendeeStatus = 'going' | 'maybe' | 'declined';
export type Attendee = { userId: string; status: AttendeeStatus };

type AttendeeRow = { call_id?: string; user_id: string; status: AttendeeStatus };

export async function loadAttendees(callId: string): Promise<Attendee[]> {
  const { data, error } = await supabase
    .from('scheduled_call_attendees')
    .select('user_id, status')
    .eq('call_id', callId);
  if (error) {
    console.warn('loadAttendees failed', error.message, error.code ?? '');
    return [];
  }
  return ((data ?? []) as AttendeeRow[]).map((a) => ({ userId: a.user_id, status: a.status }));
}

// RSVP to a call. Upserts the caller's row so calling again just flips the
// status (going -> maybe). The DB trigger stamps responded_at server-side.
export async function setRsvp(callId: string, userId: string, status: AttendeeStatus): Promise<void> {
  const { error } = await supabase
    .from('scheduled_call_attendees')
    .upsert({ call_id: callId, user_id: userId, status }, { onConflict: 'call_id,user_id' });
  if (error) throw error;
}

// Retract an RSVP entirely (removes the row, so the user drops out of the
// counts rather than lingering as "declined").
export async function clearRsvp(callId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from('scheduled_call_attendees')
    .delete()
    .eq('call_id', callId)
    .eq('user_id', userId);
  if (error) throw error;
}

export type AttendeeEvent = {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  callId: string | null;
  userId: string | null;
  status: AttendeeStatus | null;
};

// Realtime fan-in for RSVP changes. The attendees table has no team_id, so
// there's no server-side filter — RLS restricts delivered rows to calls the
// viewer can see (the read policy joins back to scheduled_calls).
export function subscribeCallAttendees(
  teamId: string,
  handler: (evt: AttendeeEvent) => void,
): () => void {
  const ch = supabase
    .channel(`scheduled_call_attendees:${teamId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'scheduled_call_attendees' },
      (payload) => {
        const row = (payload.new && (payload.new as AttendeeRow).call_id ? payload.new : null) as AttendeeRow | null;
        const oldRow = (payload.old ?? null) as AttendeeRow | null;
        handler({
          eventType: payload.eventType as AttendeeEvent['eventType'],
          callId: row?.call_id ?? oldRow?.call_id ?? null,
          userId: row?.user_id ?? oldRow?.user_id ?? null,
          status: row?.status ?? null,
        });
      },
    )
    .subscribe();
  return () => {
    supabase.removeChannel(ch);
  };
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
