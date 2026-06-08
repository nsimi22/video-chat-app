// Reconciles a finished LiveKit egress back into public.call_recordings.
//
// LiveKit posts egress lifecycle webhooks (egress_started, egress_updated,
// egress_ended) signed with the LiveKit API key/secret. We only care about
// terminal events: on egress_ended we look the recording up by egress_id
// and flip it to 'completed' (file is in the `uploads` bucket at the
// storage_path we set when starting) or 'failed', and stamp ended_at.
//
// We deliberately do NOT generate the AI recap here. The recap reuses the
// renderer's existing summarize path (per-user API keys in
// user_integrations, calls gated through the desktop fetch-proxy) and the
// in-call transcript buffer — neither of which exists server-side. The
// renderer watches call_recordings via realtime and posts the "Meeting
// Recap" message when it sees the row go 'completed' (see api.js /
// finalizeCallTranscript). This function's job is purely status + file
// reconciliation.
//
// Auth: LiveKit signs the webhook body as a JWT in the Authorization
// header. We verify it with the WebhookReceiver (same API secret as
// livekit-token). The function is deployed --no-verify-jwt so Supabase
// doesn't reject the non-Supabase token; the WebhookReceiver IS the auth.
//
// Required secrets: LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
//   SUPABASE_URL (auto), SUPABASE_SERVICE_ROLE_KEY.
//
// Deploy:  supabase functions deploy livekit-egress-webhook --no-verify-jwt
// Then point the LiveKit project's egress webhook URL at this function.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { EgressStatus, WebhookReceiver } from 'npm:livekit-server-sdk@2.9.0';
import { json } from '../_shared/cors.ts';

const receiver = new WebhookReceiver(
  Deno.env.get('LIVEKIT_API_KEY')!,
  Deno.env.get('LIVEKIT_API_SECRET')!,
);

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// Resolve EgressInfo.status to its canonical enum NAME. The SDK deserialises
// the protobuf, so `status` arrives as the numeric EgressStatus value (e.g.
// 3) — not the "EGRESS_COMPLETE" string the proto-JSON wire format uses.
// Map both: a number indexes the EgressStatus enum; a string is already the
// name (defensive, in case a future SDK hands back the JSON name directly).
function egressStatusName(status: unknown): string {
  if (typeof status === 'number') return EgressStatus[status] ?? String(status);
  if (typeof status === 'string') return status;
  return String(status ?? '');
}

// LiveKit egress status enum values that mean the egress is finished.
const TERMINAL_OK = 'EGRESS_COMPLETE';
const TERMINAL_FAIL = new Set(['EGRESS_FAILED', 'EGRESS_ABORTED', 'EGRESS_LIMIT_REACHED']);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // WebhookReceiver verifies the signed body against the API secret and
  // returns the typed event. A bad/absent signature throws -> 401.
  let event;
  try {
    const bodyText = await req.text();
    const authHeader = req.headers.get('Authorization') ?? '';
    event = await receiver.receive(bodyText, authHeader);
  } catch (err) {
    return json({ error: 'invalid webhook signature', detail: String((err as Error)?.message || err) }, 401);
  }

  if (event.event !== 'egress_ended' && event.event !== 'egress_updated') {
    return json({ ok: true, skipped: event.event });
  }

  const info = event.egressInfo;
  const egressId = info?.egressId;
  if (!egressId) return json({ ok: true, skipped: 'no egressId' });

  // Only act on a terminal status; egress_updated also fires for benign
  // progress transitions we don't persist.
  const statusName = egressStatusName(info?.status);
  const isOk = statusName === TERMINAL_OK;
  const isFail = TERMINAL_FAIL.has(statusName);
  if (!isOk && !isFail) return json({ ok: true, skipped: `non-terminal ${statusName}` });

  const update: Record<string, unknown> = {
    status: isOk ? 'completed' : 'failed',
    ended_at: new Date().toISOString(),
  };
  if (isFail && info?.error) update.error = String(info.error);

  const { error } = await admin
    .from('call_recordings')
    .update(update)
    .eq('egress_id', egressId)
    // Don't clobber a row that was already finalised by a duplicate webhook.
    .in('status', ['starting', 'recording', 'stopping']);
  if (error) return json({ error: 'db update failed', detail: error.message }, 500);

  return json({ ok: true, egressId, status: update.status });
});
