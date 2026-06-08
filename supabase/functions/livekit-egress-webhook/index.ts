// Reconciles a finished LiveKit egress back into public.call_recordings AND
// posts the "Meeting Recap" message server-side.
//
// LiveKit posts egress lifecycle webhooks (egress_started, egress_updated,
// egress_ended) signed with the LiveKit API key/secret. We only care about
// terminal events: on egress_ended we look the recording up by egress_id and
// flip it to 'completed' (file is in the PRIVATE `recordings` bucket at the
// storage_path we set when starting) or 'failed', and stamp ended_at.
//
// Why the recap is posted HERE (not in the renderer, as the original PR did):
// the starter's client posted the recap on the realtime 'completed' event, so
// if they left the call before egress finished BOTH the recording recap and
// the transcript recap were lost, and multiple clients of the same user could
// double-post. Moving it server-side makes the recap survive the starter
// leaving and lets us dedup atomically.
//
// Recap pipeline (on a successful 'completed'):
//   1. Atomically CLAIM the recap: update call_recordings set
//      recap_posted_message_id = <generated uuid> where id = $1 and
//      recap_posted_message_id is null returning *. If no row comes back,
//      another path (duplicate webhook / second pod) already claimed it — skip.
//      We pre-generate the message id so the claim and the messages insert use
//      the same id, keeping "claim" and "post" consistent without a 2-phase
//      dance. (If the subsequent insert fails we clear the claim so a retry
//      can re-post — see below.)
//   2. Read the stored transcript (recording-egress submit-transcript) + the
//      starter's AI provider/key from user_integrations (service role).
//   3. Call the AI provider DIRECTLY from Deno (edge functions have network
//      egress and are NOT subject to the renderer fetch-proxy / CSP). Mirrors
//      renderer/ai.js: Anthropic /v1/messages or OpenRouter chat/completions.
//   4. Mint a short-lived signed URL for the recording and post the recap as a
//      messages row via the service role, shaped like the renderer's AI
//      messages (author = starter, ai_generated, robot styling client-side).
//
// Graceful fallbacks: no transcript -> link-only recap; no AI key -> link-only
// recap (no summary); AI call fails -> link-only recap (we still want the
// link in the channel). A 'failed' egress posts nothing.
//
// Auth: LiveKit signs the webhook body as a JWT in the Authorization header.
// We verify it with the WebhookReceiver (same API secret as livekit-token).
// The function is deployed --no-verify-jwt so Supabase doesn't reject the
// non-Supabase token; the WebhookReceiver IS the auth.
//
// Required secrets: LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
//   SUPABASE_URL (auto), SUPABASE_SERVICE_ROLE_KEY.
//   RECORDINGS_BUCKET (default 'recordings'), RECORDING_SIGNED_URL_TTL
//   (seconds, default 604800 = 7d — long enough that the link in the recap
//   message stays usable for a week; clicking later regenerates it via the
//   renderer's recordingSignedUrl, so expiry is graceful).
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

const RECORDINGS_BUCKET = Deno.env.get('RECORDINGS_BUCKET') ?? 'recordings';
const SIGNED_URL_TTL = Number(Deno.env.get('RECORDING_SIGNED_URL_TTL') ?? '604800') || 604800;

// Default models mirror renderer/ai.js so a server-generated recap matches what
// the client would have produced. Kept in sync manually (two small constants).
const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-4-7';
const OPENROUTER_DEFAULT_MODEL = 'anthropic/claude-opus-4-7';

// Same prompt the renderer used for postMeetingRecap, so recaps read the same
// whether posted by the (now removed) client path or here.
const RECAP_SYSTEM =
  "You are summarising a recorded team call. Produce a concise meeting recap (under 200 words) in markdown: 2-3 bullets of key points, then a 'Decisions' section if any were made, then 'Action items' (with owners if you can infer them). The transcript is rough speech-to-text — fix obvious recognition errors silently and don't quote raw lines.";

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

  // Reconcile status. Returning the row lets us drive the recap without a
  // second read. Don't clobber a row already finalised by a duplicate webhook.
  const { data: rows, error } = await admin
    .from('call_recordings')
    .update(update)
    .eq('egress_id', egressId)
    .in('status', ['starting', 'recording', 'stopping'])
    .select();
  if (error) return json({ error: 'db update failed', detail: error.message }, 500);

  // No row updated: either an unknown egress or a duplicate webhook that lost
  // the race. The recap (if any) was already handled by the winning call.
  if (!rows?.length) return json({ ok: true, egressId, status: update.status, reconciled: false });
  const recording = rows[0];

  if (isFail) return json({ ok: true, egressId, status: 'failed' });

  // Success: post the recap. Failures here shouldn't 500 the webhook (LiveKit
  // would retry and we'd re-run reconciliation pointlessly) — log + return ok.
  try {
    const result = await postRecap(recording);
    return json({ ok: true, egressId, status: 'completed', recap: result });
  } catch (err) {
    console.error('postRecap failed', err);
    return json({ ok: true, egressId, status: 'completed', recap: 'error' });
  }
});

type RecordingRow = {
  id: string;
  team_id: string;
  channel_id: string;
  started_by: string | null;
  storage_path: string | null;
  transcript: string | null;
  recap_posted_message_id: string | null;
};

// Build + post the Meeting Recap. Atomic claim first (so duplicate webhooks /
// concurrent pods can't double-post), then summarise + insert.
async function postRecap(recording: RecordingRow): Promise<string> {
  // 1. Atomic claim. Pre-generate the message id so the claim value and the
  //    messages.id are the same row. `where recap_posted_message_id is null`
  //    means only the first caller flips it; everyone else gets zero rows.
  const messageId = crypto.randomUUID();
  const { data: claimed, error: claimErr } = await admin
    .from('call_recordings')
    .update({ recap_posted_message_id: messageId })
    .eq('id', recording.id)
    .is('recap_posted_message_id', null)
    .select('id')
    .maybeSingle();
  if (claimErr) {
    console.error('recap claim failed', claimErr);
    return 'claim-error';
  }
  if (!claimed) return 'already-posted'; // someone else won the claim — skip.

  // 2. Resolve the recording link (signed, short-lived) and the AI summary.
  const link = await signedRecordingUrl(recording.storage_path);
  const summary = await summariseTranscript(recording);

  // 3. Look up the starter's profile so the message carries a sensible author
  //    label/color (mirrors the renderer's _insertMessage which stamps
  //    author_name/author_color from the local user). Fall back gracefully if
  //    the starter's account was deleted (started_by null).
  let authorName = 'Huddle';
  let authorColor: string | null = null;
  if (recording.started_by) {
    const { data: profile } = await admin
      .from('profiles')
      .select('name, color')
      .eq('user_id', recording.started_by)
      .maybeSingle();
    if (profile?.name) authorName = profile.name;
    authorColor = (profile as { color?: string } | null)?.color ?? null;
  }

  // Post under the meeting thread if this channel has an active meeting root,
  // matching where the client used to post. Best-effort: a missing root just
  // drops the recap into the channel feed.
  const parentId = await findMeetingRoot(recording.team_id, recording.channel_id);

  const body = renderRecapBody({ link, summary });

  // 4. Insert the message with the pre-claimed id, shaped like the renderer's
  //    sendAiMessage (ai_generated + ai_model so the client renders the robot
  //    avatar / model badge). author_id = starter so RLS/accountability match.
  const { error: insErr } = await admin.from('messages').insert({
    id: messageId,
    team_id: recording.team_id,
    channel_id: recording.channel_id,
    parent_id: parentId,
    author_id: recording.started_by,
    author_name: authorName,
    author_color: authorColor,
    body,
    attachments: [],
    reactions: {},
    mentions: [],
    ai_generated: true,
    ai_model: summary.model,
  });
  if (insErr) {
    // The claim succeeded but the post didn't — release it so a LiveKit retry
    // (or a manual reconciliation) can re-attempt instead of silently leaving
    // the channel with no recap.
    console.error('recap insert failed, releasing claim', insErr);
    await admin
      .from('call_recordings')
      .update({ recap_posted_message_id: null })
      .eq('id', recording.id)
      .eq('recap_posted_message_id', messageId);
    return 'insert-error';
  }

  // Persist the human-readable recap text on the row too (the original schema
  // reserves `recap` for this), so it's queryable without re-reading messages.
  await admin.from('call_recordings').update({ recap: body }).eq('id', recording.id);
  return summary.text ? 'posted-with-summary' : 'posted-link-only';
}

// Mint a short-lived signed URL for the private recording object. Null when the
// file never landed (storage_path unset). The renderer regenerates a fresh URL
// on click (recordingSignedUrl), so even if this one expires the recap link
// stays usable for channel members.
async function signedRecordingUrl(storagePath: string | null): Promise<string | null> {
  if (!storagePath) return null;
  const { data, error } = await admin.storage
    .from(RECORDINGS_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL);
  if (error) {
    console.error('createSignedUrl failed', error);
    return null;
  }
  return data?.signedUrl ?? null;
}

// Render the recap message body. Mirrors the renderer's postMeetingRecap output
// so existing message styling/parsing stays consistent.
function renderRecapBody({ link, summary }: { link: string | null; summary: { text: string } }): string {
  const parts = ['**🎥 Meeting Recap**', ''];
  if (link) parts.push(`📼 [Recording](${link})`, '');
  else parts.push('_Recording is still processing — the link will be available shortly._', '');
  if (summary.text) parts.push(summary.text);
  else parts.push('_No AI summary was generated (no transcript captured, or no AI key configured for the recording starter)._');
  return parts.join('\n');
}

// Summarise the stored transcript with the STARTER'S AI provider/key (read
// from user_integrations via the service role). Returns { text, model } with
// text='' on any miss (no transcript, no key, provider error) so the caller
// degrades to a link-only recap. model is recorded for the ai_model badge.
async function summariseTranscript(recording: RecordingRow): Promise<{ text: string; model: string | null }> {
  const transcript = (recording.transcript || '').trim();
  if (!transcript) return { text: '', model: null };
  if (!recording.started_by) return { text: '', model: null };

  const { data: row } = await admin
    .from('user_integrations')
    .select('settings')
    .eq('user_id', recording.started_by)
    .maybeSingle();
  const ai = (row?.settings as { ai?: AiSettings } | null)?.ai ?? {};

  const provider = ai.provider === 'openrouter' ? 'openrouter' : 'anthropic';
  const key = provider === 'anthropic' ? (ai.anthropicKey || '') : (ai.openrouterKey || '');
  if (!key) return { text: '', model: null }; // no key -> link-only recap.

  const model = provider === 'anthropic'
    ? (ai.anthropicModel || ANTHROPIC_DEFAULT_MODEL)
    : (ai.openrouterModel || OPENROUTER_DEFAULT_MODEL);

  try {
    const text = provider === 'anthropic'
      ? await anthropicChat(key, model, RECAP_SYSTEM, transcript)
      : await openrouterChat(key, model, RECAP_SYSTEM, transcript);
    return { text: text.trim(), model };
  } catch (err) {
    console.error('AI summarise failed', err);
    return { text: '', model: null };
  }
}

type AiSettings = {
  provider?: string;
  anthropicKey?: string;
  anthropicModel?: string;
  openrouterKey?: string;
  openrouterModel?: string;
};

// Direct Anthropic /v1/messages call (no tools, single turn). Mirrors
// renderer/ai.js _anthropicChat minus the tool-use loop the recap doesn't need.
async function anthropicChat(key: string, model: string, system: string, user: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return (j.content || []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('\n');
}

// Direct OpenRouter chat/completions call. Mirrors renderer/ai.js
// _openrouterChat minus tools.
async function openrouterChat(key: string, model: string, system: string, user: string): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'content-type': 'application/json',
      'X-Title': 'Huddle',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.choices?.[0]?.message?.content || '';
}

// Find the active meeting-root message for this channel so the recap threads
// under it (matching the renderer's behaviour). Best-effort: returns null if
// none in the last 12h or on any error. Mirrors api.js fetchActiveMeetingRoot.
async function findMeetingRoot(teamId: string, channelId: string): Promise<string | null> {
  const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  try {
    const { data } = await admin
      .from('messages')
      .select('id')
      .eq('team_id', teamId)
      .eq('channel_id', channelId)
      .gte('ts', cutoff)
      .filter('meta->>meeting_root', 'eq', 'true')
      .order('ts', { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.id ?? null;
  } catch {
    return null;
  }
}
