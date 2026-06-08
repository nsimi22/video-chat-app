// Starts / stops a server-side LiveKit RoomComposite egress for a channel
// call and tracks it in public.call_recordings.
//
// Trust model — identical boundary to livekit-token:
//   1. Caller presents a valid Supabase session (Authorization: Bearer <jwt>).
//   2. Caller must be able to see the target channel (can_see_channel RPC,
//      the same helper RLS uses), run as the caller so auth.uid() is theirs.
//   3. Only then do we touch LiveKit (with the API secret that never leaves
//      this function) and write call_recordings via the service role.
//
// Room name matches livekit-token: `call:<team_id>:<channel_id>`, so the
// egress composites exactly the room desktop + mobile already join.
//
// Egress output: a single MP4 (RoomComposite, "speaker" layout) uploaded to
// the PRIVATE `recordings` Supabase Storage bucket over its S3-compatible
// endpoint. Supabase Storage speaks S3, so LiveKit's built-in S3Upload
// targets it directly — no extra relay. The object key is
// `recordings/<team>/<channel>/<recordingId>.mp4`; the renderer resolves a
// short-lived signed URL on demand (storage.from('recordings').createSignedUrl)
// rather than a permanent public link, so a private channel's recording can't
// leak to anyone holding an old URL (see migration 20260608130000).
//
// Actions (POST body { action, team_id, channel_id }):
//   action='start' -> insert call_recordings(status='starting'), start the
//                     egress, store egress_id, flip to 'recording'.
//   action='stop'  -> flip the active row to 'stopping', stop the egress.
//                     The completed file + final status are reconciled by
//                     the livekit-egress-webhook companion (or, if no
//                     webhook is configured, the row stays 'stopping' until
//                     a webhook/cron sweeps it — see PR notes).
//   action='submit-transcript' -> store the caller's live caption transcript
//                     snapshot on the active/most-recent recording row so the
//                     webhook can build the AI recap server-side (the
//                     transcript only exists in the starter's client). Caller
//                     must be the recording's starter; service-role writes the
//                     transcript column. Submitted on the stop/leave
//                     transition (see app.js onRecordingState).
//
// Required Edge Function secrets (document as infra assumptions):
//   LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET   (shared w/ livekit-token)
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (anon auto-injected)
//   EGRESS_S3_ACCESS_KEY, EGRESS_S3_SECRET_KEY  — Storage S3 access keys
//   EGRESS_S3_BUCKET   (default 'recordings' — the private bucket)
//   EGRESS_S3_REGION   (default 'us-east-1' — Supabase Storage ignores it
//                       but the S3 protocol requires a value)
//   EGRESS_S3_ENDPOINT — Storage S3 endpoint,
//                        e.g. https://<ref>.supabase.co/storage/v1/s3
//
// Deploy:  supabase functions deploy recording-egress

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
} from 'npm:livekit-server-sdk@2.9.0';
import { corsHeaders, json } from '../_shared/cors.ts';

const LIVEKIT_URL = Deno.env.get('LIVEKIT_URL')!;
const LIVEKIT_API_KEY = Deno.env.get('LIVEKIT_API_KEY')!;
const LIVEKIT_API_SECRET = Deno.env.get('LIVEKIT_API_SECRET')!;

const S3_BUCKET = Deno.env.get('EGRESS_S3_BUCKET') ?? 'recordings';
const S3_REGION = Deno.env.get('EGRESS_S3_REGION') ?? 'us-east-1';
const S3_ENDPOINT = Deno.env.get('EGRESS_S3_ENDPOINT') ?? '';
const S3_ACCESS_KEY = Deno.env.get('EGRESS_S3_ACCESS_KEY') ?? '';
const S3_SECRET_KEY = Deno.env.get('EGRESS_S3_SECRET_KEY') ?? '';

// Service-role client for the call_recordings writes (clients have SELECT
// only — see the migration). Reused across requests; it carries no session.
const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'missing bearer token' }, 401);

  let body: { action?: string; team_id?: string; channel_id?: string; recording_id?: string; transcript?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const action = body.action?.trim();
  const teamId = body.team_id?.trim();
  const channelId = body.channel_id?.trim();
  if (action !== 'start' && action !== 'stop' && action !== 'submit-transcript') {
    return json({ error: "action must be 'start', 'stop', or 'submit-transcript'" }, 400);
  }
  if (!teamId || !channelId) return json({ error: 'team_id and channel_id are required' }, 400);

  // Verify the session + membership AS THE CALLER, so RLS and the SECURITY
  // DEFINER helper see the caller's auth.uid() — identical to livekit-token.
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) return json({ error: 'invalid session' }, 401);
  const user = userData.user;

  const { data: canSee, error: rpcErr } = await supabase.rpc('can_see_channel', {
    t: teamId,
    c: channelId,
  });
  if (rpcErr) return json({ error: 'authorization check failed', detail: rpcErr.message }, 500);
  if (canSee !== true) return json({ error: 'not a member of this channel' }, 403);

  const room = `call:${teamId}:${channelId}`;
  const egressClient = new EgressClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

  if (action === 'submit-transcript') {
    return await handleSubmitTranscript(teamId, channelId, user.id, body.recording_id?.trim(), body.transcript);
  }
  if (action === 'stop') {
    return await handleStop(teamId, channelId, egressClient);
  }
  return await handleStart(teamId, channelId, room, user.id, egressClient);
});

async function handleStart(
  teamId: string,
  channelId: string,
  room: string,
  startedBy: string,
  egressClient: EgressClient,
): Promise<Response> {
  // Claim the single active slot by inserting first. The partial unique
  // index (call_recordings_one_active_per_room) makes a concurrent second
  // Record click fail here with a unique violation — we treat that as
  // "already recording" and return the live row instead of spawning a
  // second egress.
  const { data: row, error: insertErr } = await admin
    .from('call_recordings')
    .insert({ team_id: teamId, channel_id: channelId, started_by: startedBy, status: 'starting' })
    .select()
    .single();

  if (insertErr) {
    // 23505 = unique_violation -> an active recording already exists.
    if (insertErr.code === '23505') {
      const { data: existing } = await admin
        .from('call_recordings')
        .select('*')
        .eq('team_id', teamId)
        .eq('channel_id', channelId)
        .in('status', ['starting', 'recording', 'stopping'])
        .maybeSingle();
      return json({ ok: true, already: true, recording: existing ?? null });
    }
    return json({ error: 'could not create recording row', detail: insertErr.message }, 500);
  }

  // Object key inside the bucket. Pinning to the row id keeps it unique
  // and lets the recap link resolve straight off storage_path.
  const storagePath = `recordings/${teamId}/${channelId}/${row.id}.mp4`;

  const output = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath: storagePath,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey: S3_ACCESS_KEY,
        secret: S3_SECRET_KEY,
        bucket: S3_BUCKET,
        region: S3_REGION,
        endpoint: S3_ENDPOINT,
        // Supabase Storage's S3 gateway requires path-style addressing
        // (bucket in the path, not the host); virtual-host style 404s.
        forcePathStyle: true,
      }),
    },
  });

  try {
    const info = await egressClient.startRoomCompositeEgress(
      room,
      { file: output },
      // "speaker" focuses the active speaker — the most useful single-file
      // layout for a recap; "grid" is the alternative if a team prefers it.
      { layout: 'speaker' },
    );
    await admin
      .from('call_recordings')
      .update({ egress_id: info.egressId, status: 'recording', storage_path: storagePath })
      .eq('id', row.id);
    return json({ ok: true, recording: { ...row, egress_id: info.egressId, status: 'recording', storage_path: storagePath } });
  } catch (err) {
    // Egress failed to start — mark the row failed so the active-slot index
    // frees up and the UI can drop the "starting…" state.
    const msg = String((err as Error)?.message || err);
    await admin
      .from('call_recordings')
      .update({ status: 'failed', error: msg, ended_at: new Date().toISOString() })
      .eq('id', row.id);
    return json({ error: 'failed to start egress', detail: msg }, 502);
  }
}

async function handleStop(
  teamId: string,
  channelId: string,
  egressClient: EgressClient,
): Promise<Response> {
  const { data: row } = await admin
    .from('call_recordings')
    .select('*')
    .eq('team_id', teamId)
    .eq('channel_id', channelId)
    .in('status', ['starting', 'recording'])
    .order('started_at', { ascending: false })
    .maybeSingle();

  if (!row) return json({ ok: true, already_stopped: true });

  // Flip to 'stopping' first so every participant's indicator updates the
  // moment Stop is clicked, before the LiveKit round-trip.
  await admin.from('call_recordings').update({ status: 'stopping' }).eq('id', row.id);

  if (row.egress_id) {
    try {
      await egressClient.stopEgress(row.egress_id);
    } catch (err) {
      // Stop failing (egress already ended, etc.) shouldn't strand the row
      // in 'stopping' — record the error and let reconciliation finalise it.
      console.error('stopEgress failed', err);
    }
  }
  // The completed file + 'completed' status are reconciled when LiveKit
  // fires its egress_ended webhook (see livekit-egress-webhook in the PR
  // notes). Without a webhook the row stays 'stopping' until swept.
  return json({ ok: true, recording: { ...row, status: 'stopping' } });
}

// Store the starter's caption-transcript snapshot on the recording row so the
// webhook can build the AI recap server-side. The transcript lives only in the
// starter's client (app.js state.cc.lines); they POST it here on the
// stop/leave transition. The membership check already ran for the caller in
// the handler; here we additionally require that the caller is the recording's
// starter (started_by) so a non-starter member can't overwrite the transcript.
//
// We target the most-recent recording in the channel rather than only an
// in-flight one: by the time the renderer submits (on the stop transition or
// during leave-call teardown) the webhook may already have flipped the row to
// 'completed'. recording_id pins the exact row when the client knows it; we
// fall back to the latest row for the channel otherwise.
async function handleSubmitTranscript(
  teamId: string,
  channelId: string,
  callerId: string,
  recordingId: string | undefined,
  transcript: string | undefined,
): Promise<Response> {
  if (typeof transcript !== 'string') {
    return json({ error: 'transcript (string) is required' }, 400);
  }
  // Cap the stored transcript so a runaway client can't bloat the row. ~200k
  // chars is far longer than any realistic captioned call and still well
  // within the summariser's input budget after truncation in the webhook.
  const trimmed = transcript.slice(0, 200_000);

  let query = admin
    .from('call_recordings')
    .select('*')
    .eq('team_id', teamId)
    .eq('channel_id', channelId);
  query = recordingId
    ? query.eq('id', recordingId)
    : query.order('started_at', { ascending: false }).limit(1);
  const { data: row } = await query.maybeSingle();

  if (!row) return json({ ok: true, skipped: 'no recording row' });
  // Only the starter may submit the transcript for their recording. started_by
  // is null only after the starter's account was deleted, in which case there's
  // no live client to submit anyway.
  if (row.started_by !== callerId) {
    return json({ error: 'only the recording starter may submit a transcript' }, 403);
  }
  // Don't clobber a transcript already stored (e.g. a duplicate submit from a
  // second client of the same user, or a stop-then-leave double fire).
  if (row.transcript) return json({ ok: true, already: true, recording_id: row.id });

  const { error } = await admin
    .from('call_recordings')
    .update({ transcript: trimmed })
    .eq('id', row.id)
    // Atomic guard: only the first submit wins, mirroring the recap claim.
    .is('transcript', null);
  if (error) return json({ error: 'could not store transcript', detail: error.message }, 500);
  return json({ ok: true, recording_id: row.id });
}
