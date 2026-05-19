// Announces "a call is happening here" to the `active_calls` table, which the
// notify-on-call Edge Function watches to fan out push notifications.
//
// Lifecycle, mirrored on every client that joins a call (mobile + desktop):
//   1. Sweep stale rows older than STALE_AFTER_MS (best-effort delete).
//   2. Upsert (team_id, channel_id) with last_active_at = now.
//      - A fresh INSERT fires the webhook → push fan-out.
//      - A conflict (UPDATE of last_active_at) doesn't fire the webhook, so
//        latecomers joining an ongoing call don't re-ring everyone.
//   3. Heartbeat every HEARTBEAT_MS, renewing last_active_at, so the row
//      doesn't become "stale" while the call is actually ongoing.
//   4. On leave, stop the heartbeat. We DO NOT delete the row — see the
//      migration comment for why: a delete-on-leave races with other
//      participants' heartbeats and causes re-ring spam.

import { supabase } from './supabase';

const STALE_AFTER_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;

export type CallAnnouncer = {
  start: () => Promise<void>;
  stop: () => void;
};

export function createCallAnnouncer(opts: {
  teamId: string;
  channelId: string;
  startedBy: string;
}): CallAnnouncer {
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  async function announce() {
    // Stale-sweep: any team member with channel access can delete (RLS).
    // Best-effort — if we lose the race to another joiner, that's fine,
    // exactly one of us will INSERT and fire the webhook.
    const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString();
    try {
      await supabase
        .from('active_calls')
        .delete()
        .eq('team_id', opts.teamId)
        .eq('channel_id', opts.channelId)
        .lt('last_active_at', staleBefore);
    } catch (err) {
      // Sweep failing is non-fatal — the upsert below still gives us a
      // valid heartbeat, we just might not re-announce a recently-ended
      // call until the next attempt.
      console.warn('[call-announce] stale sweep failed', err);
    }

    // Upsert. INSERT fires the webhook, UPDATE is a silent heartbeat.
    try {
      await supabase.from('active_calls').upsert(
        {
          team_id: opts.teamId,
          channel_id: opts.channelId,
          started_by: opts.startedBy,
          last_active_at: new Date().toISOString(),
        },
        { onConflict: 'team_id,channel_id' },
      );
    } catch (err) {
      // If the upsert itself fails (e.g. RLS denial because the user lost
      // channel access between the realtime subscribe and the SQL write),
      // the call still works locally — push fan-out just won't happen.
      console.warn('[call-announce] announce failed', err);
    }
  }

  async function heartbeatTick() {
    if (stopped) return;
    try {
      await supabase
        .from('active_calls')
        .update({ last_active_at: new Date().toISOString() })
        .eq('team_id', opts.teamId)
        .eq('channel_id', opts.channelId);
    } catch (err) {
      console.warn('[call-announce] heartbeat failed', err);
    }
  }

  return {
    start: async () => {
      await announce();
      heartbeat = setInterval(() => { void heartbeatTick(); }, HEARTBEAT_MS);
    },
    stop: () => {
      stopped = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    },
  };
}
