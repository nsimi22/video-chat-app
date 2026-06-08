// Server-authorized "knock to huddle" signaling.
//
// Trust model (mirrors livekit-token/index.ts — the same boundary that gates
// who may mint a call token):
//   1. The caller must present a valid Supabase session (Authorization:
//      Bearer <jwt>); we never trust a client-supplied identity.
//   2. The caller and the target must genuinely share a team — checked both as
//      the caller (re-using the SECURITY DEFINER `is_team_member` helper that
//      already powers realtime RLS) and against `team_members` with the service
//      role for the *target* (a caller can't query another user's membership
//      under RLS, so the service role is the source of truth there).
//   3. Only then do we relay the signal, stamping a TRUSTED `from` = the
//      authenticated user id. Any client-supplied `from` is ignored.
//
// Why an edge function instead of a client broadcast:
//   Knocks used to ride the shared `team:<team_id>` broadcast topic, whose
//   realtime write policy only checks team membership. That let any teammate
//   forge a knock's `from` (impersonation) and ring-bomb arbitrary targets.
//   The companion migration (20260608000000_huddle_knock_signal_topic.sql)
//   moves knocks onto a per-recipient private topic `knock:<user_id>` that
//   NO authenticated client may write — only the service role can. So this
//   function is the only path that can publish a knock, which is what actually
//   prevents forging `from` and unauthorized senders. The recipient keeps a
//   plain client subscription on its own `knock:<self>` topic.
//
// Required Edge Function secrets (all auto-injected by the platform):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//
// Deploy:  supabase functions deploy knock-signal
// Local:   supabase functions serve knock-signal --env-file supabase/.env.local

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// The three signal types, matching the renderer's broadcast event names so the
// recipient's existing `ch.on('broadcast', { event })` handlers fire unchanged.
const KNOCK_TYPES = new Set(['knock', 'knock-response', 'knock-cancel']);

// Lightweight in-memory spam guard. Edge function instances are short-lived and
// not shared across regions, so this is best-effort — a blunt instrument to
// stop a single client hammering knocks in a tight loop, not a hard quota. The
// authoritative anti-abuse property (no forging, teammates only) comes from the
// auth + membership checks below; this just blunts rapid-fire ring-bombing.
const MIN_KNOCK_INTERVAL_MS = 1500;
const lastKnockAt = new Map<string, number>(); // `${from}->${to}` -> epoch ms

// A service-role client is unnecessary for the relay itself (we POST to the
// realtime REST endpoint directly), but we use one for the target-membership
// lookup so it isn't constrained by the caller's RLS.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'missing bearer token' }, 401);

  let body: {
    type?: string;
    team_id?: string;
    to?: string;
    knock_id?: string;
    channel_id?: string;
    accepted?: boolean;
    // NOTE: a `from` here is deliberately ignored — see the trusted stamp below.
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const type = body.type?.trim();
  const teamId = body.team_id?.trim();
  const to = body.to?.trim();
  const knockId = body.knock_id?.trim();
  const channelId = body.channel_id?.trim();
  if (!type || !KNOCK_TYPES.has(type)) return json({ error: 'invalid type' }, 400);
  if (!teamId || !to || !knockId || !channelId) {
    return json({ error: 'team_id, to, knock_id and channel_id are required' }, 400);
  }

  // 1. Authenticate the caller as the *caller* (so RLS + the SECURITY DEFINER
  //    helper resolve auth.uid() to them, exactly like livekit-token does).
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'invalid session' }, 401);
  const from = userData.user.id; // the ONLY trusted identity in this function.

  // A user can't knock themselves; reject early so we never publish a self-ring.
  if (from === to) return json({ error: 'cannot knock yourself' }, 400);

  // 2a. Caller must be a member of the team they claim to knock within.
  const { data: callerIsMember, error: memberErr } = await caller.rpc('is_team_member', { t: teamId });
  if (memberErr) return json({ error: 'authorization check failed', detail: memberErr.message }, 500);
  if (callerIsMember !== true) return json({ error: 'not a member of this team' }, 403);

  // 2b. Target must be a real teammate on the same team. RLS would let the
  //     caller read team_members, but only rows for teams they belong to; we
  //     already proved that above, so a service-role check here is equivalent
  //     and keeps the query independent of the caller's row-level visibility.
  const { data: targetRow, error: targetErr } = await admin
    .from('team_members')
    .select('user_id')
    .eq('team_id', teamId)
    .eq('user_id', to)
    .maybeSingle();
  if (targetErr) return json({ error: 'authorization check failed', detail: targetErr.message }, 500);
  if (!targetRow) return json({ error: 'target is not on this team' }, 403);

  // 3. Best-effort rate limit on the (from -> to) pair. Only throttles the
  //    initial `knock`; responses and cancels must always get through so a
  //    callee can decline / a caller can retract without being rate-limited.
  if (type === 'knock') {
    const key = `${from}->${to}`;
    const now = Date.now();
    const prev = lastKnockAt.get(key) ?? 0;
    if (now - prev < MIN_KNOCK_INTERVAL_MS) {
      return json({ error: 'knocking too fast' }, 429);
    }
    lastKnockAt.set(key, now);
    // Opportunistically prune the map so a long-lived instance can't grow it
    // unbounded across many distinct pairs.
    if (lastKnockAt.size > 5000) {
      for (const [k, t] of lastKnockAt) {
        if (now - t > MIN_KNOCK_INTERVAL_MS) lastKnockAt.delete(k);
      }
    }
  }

  // Look up a friendly display name for the caller. The recipient still
  // prefers its own trusted presence cache for the rendered identity (see
  // onIncomingKnock in app.js); `fromName` is only a fallback for the race
  // where a knock outruns presence sync. It's server-sourced here, so it's no
  // longer attacker-controllable either.
  const { data: profile } = await admin.from('profiles').select('name, color').eq('user_id', from).maybeSingle();

  // Build the payload the recipient expects, with the SERVER-stamped `from`.
  const payload: Record<string, unknown> = {
    to,
    from,
    knockId,
    channelId,
    fromName: profile?.name ?? null,
    fromColor: profile?.color ?? null,
  };
  if (type === 'knock-response') payload.accepted = body.accepted === true;

  // Relay onto the recipient's private knock topic via the Realtime broadcast
  // REST endpoint, authenticated with the service role so it bypasses the
  // realtime write RLS (which forbids client writes to `knock:*`). `private:
  // true` is required for the message to land on a topic gated by RLS.
  const resp = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      messages: [{ topic: `knock:${to}`, event: type, payload, private: true }],
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    console.error('knock relay failed', resp.status, detail);
    return json({ error: 'relay failed', detail }, 502);
  }

  return json({ ok: true });
});
