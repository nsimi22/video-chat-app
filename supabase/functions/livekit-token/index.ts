// Mints a LiveKit access token for a channel call.
//
// Trust model (the mobile equivalent of the desktop fetch-proxy boundary):
//   1. The caller must present a valid Supabase session (Authorization: Bearer <jwt>).
//   2. The caller must be able to see the target channel — we re-use the
//      existing `can_see_channel(t text, c text)` SQL helper, which already
//      powers RLS on messages.
//   3. Only then do we sign a LiveKit JWT (server-side, with the API secret
//      that never leaves this function).
//
// Room name == the Supabase Realtime call topic `call:<team_id>:<channel_id>`
// so presence and media stay aligned and a future desktop migration can reuse it.
//
// Required Edge Function secrets:
//   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
//   SUPABASE_URL, SUPABASE_ANON_KEY  (auto-injected by the platform)
//
// Deploy:  supabase functions deploy livekit-token
// Local:   supabase functions serve livekit-token --env-file supabase/.env.local

// Use Supabase Edge Runtime's native npm specifier — esm.sh's shim of
// livekit-server-sdk's JWT-signing crypto path can exceed the boot
// timeout and surfaces as BOOT_ERROR.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { AccessToken } from 'npm:livekit-server-sdk@2.9.0';
import { corsHeaders, json } from '../_shared/cors.ts';

const LIVEKIT_URL = Deno.env.get('LIVEKIT_URL')!;
const LIVEKIT_API_KEY = Deno.env.get('LIVEKIT_API_KEY')!;
const LIVEKIT_API_SECRET = Deno.env.get('LIVEKIT_API_SECRET')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'missing bearer token' }, 401);

  let body: { team_id?: string; channel_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const teamId = body.team_id?.trim();
  const channelId = body.channel_id?.trim();
  if (!teamId || !channelId) return json({ error: 'team_id and channel_id are required' }, 400);

  // Verify the session and run the membership check as the caller (so RLS and
  // the SECURITY DEFINER helper see auth.uid()).
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'invalid session' }, 401);
  const user = userData.user;

  // public.can_see_channel(t text, c text) — positional params named t/c.
  const { data: canSee, error: rpcErr } = await supabase.rpc('can_see_channel', {
    t: teamId,
    c: channelId,
  });
  if (rpcErr) return json({ error: 'authorization check failed', detail: rpcErr.message }, 500);
  if (canSee !== true) return json({ error: 'not a member of this channel' }, 403);

  const room = `call:${teamId}:${channelId}`;

  // Look up the display name so LiveKit participants show a friendly label.
  const { data: profile } = await supabase.from('profiles').select('name').eq('user_id', user.id).maybeSingle();

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: user.id,
    name: profile?.name ?? user.email ?? 'Guest',
    ttl: '2h',
  });
  at.addGrant({
    room,
    roomJoin: true,
    canPublish: true, // camera + mic
    canPublishData: true,
    canSubscribe: true,
    // Receive-only MVP: clients don't publish screen share. Tighten further if needed:
    // canPublishSources: [TrackSource.CAMERA, TrackSource.MICROPHONE],
  });

  return json({ token: await at.toJwt(), url: LIVEKIT_URL, room });
});
