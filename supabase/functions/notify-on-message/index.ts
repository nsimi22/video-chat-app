// Sends Expo push notifications when a message is inserted.
//
// Wire this up as a Supabase Database Webhook:
//   Table: public.messages   Events: INSERT   Type: HTTP Request -> this function
// (or call it from an AFTER INSERT trigger via pg_net). The payload is the
// standard Supabase webhook shape: { type: 'INSERT', record: <row>, ... }.
//
// MVP policy to avoid spam: only notify for direct messages and explicit
// @-mentions, and only to users who can actually see the channel. Channel-wide
// notifications come later (with per-user prefs).
//
// Uses the service role to read channel_members / profiles / device_tokens.
// Required secrets:
//   SUPABASE_SERVICE_ROLE_KEY  (SUPABASE_URL is auto-injected)
//   NOTIFY_WEBHOOK_SECRET      shared secret; the function is deployed with
//                              --no-verify-jwt, so this header is the auth.
//
// Deploy:  supabase functions deploy notify-on-message --no-verify-jwt
// Then add an `x-webhook-secret: <NOTIFY_WEBHOOK_SECRET>` header to the webhook.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { json } from '../_shared/cors.ts';

type MessageRow = {
  id: string;
  team_id: string;
  channel_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  mentions: string[] | null;
};

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';
const WEBHOOK_SECRET = Deno.env.get('NOTIFY_WEBHOOK_SECRET') ?? '';

// Accept both the legacy and current Expo push-token shapes.
const EXPO_TOKEN_RE = /^Ex(?:ponent|po)PushToken\[[^\]]+\]$/;

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Mirror of HuddleClient.isDndActive on the server: is this user currently
// heads-down? `presence` is user_integrations.settings.presence, mirrored
// from the desktop client. Absent/empty = available. Kept deliberately in
// sync with the renderer's _outsideWorkingHours logic.
// deno-lint-ignore no-explicit-any
function isDndNow(presence: any): boolean {
  if (!presence) return false;
  const until = presence.dndUntil;
  if (until === 'forever') return true;
  if (typeof until === 'number' && until > Date.now()) return true;
  const wh = presence.workingHours;
  if (wh && wh.enabled) {
    try {
      const now = wh.tz
        ? new Date(new Date().toLocaleString('en-US', { timeZone: wh.tz }))
        : new Date();
      const day = now.getDay();
      if (Array.isArray(wh.days) && wh.days.length && !wh.days.includes(day)) return true;
      const mins = now.getHours() * 60 + now.getMinutes();
      const [sh, sm] = String(wh.start || '09:00').split(':').map(Number);
      const [eh, em] = String(wh.end || '17:00').split(':').map(Number);
      if (mins < sh * 60 + sm || mins >= eh * 60 + em) return true;
    } catch { /* bad tz → treat as available */ }
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // The function runs with --no-verify-jwt; gate it on a shared secret so a
  // random internet client can't trigger push fan-out.
  const provided = req.headers.get('x-webhook-secret') ?? '';
  if (!WEBHOOK_SECRET || !timingSafeEqual(provided, WEBHOOK_SECRET)) {
    return json({ error: 'unauthorized' }, 401);
  }

  let payload: { type?: string; record?: MessageRow };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (payload.type !== 'INSERT' || !payload.record) return json({ ok: true, skipped: 'not an insert' });

  const msg = payload.record;

  const { data: channel } = await admin
    .from('channels')
    .select('type, name')
    .eq('team_id', msg.team_id)
    .eq('id', msg.channel_id)
    .maybeSingle();

  // Channel membership is the source of truth for who may receive a push.
  const { data: members } = await admin
    .from('channel_members')
    .select('user_id')
    .eq('team_id', msg.team_id)
    .eq('channel_id', msg.channel_id);
  const memberIds = new Set((members ?? []).map((m) => m.user_id));

  const isDm = channel?.type === 'dm';
  let recipientIds: string[];
  if (isDm) {
    recipientIds = [...memberIds].filter((id) => id !== msg.author_id);
  } else if (msg.mentions?.length) {
    // For private channels, channel_members is the gate. For public channels
    // there are no member rows, so fall back to "any team member who was
    // mentioned" — but never notify someone who isn't on the channel when the
    // channel does have a membership list.
    const hasMemberList = memberIds.size > 0;
    recipientIds = msg.mentions.filter(
      (id) => id !== msg.author_id && (!hasMemberList || memberIds.has(id)),
    );
  } else {
    return json({ ok: true, skipped: 'no dm/mention recipients' });
  }
  if (!recipientIds.length) return json({ ok: true, skipped: 'empty recipient set' });

  // Respect Do Not Disturb / working hours: drop recipients who are heads-
  // down right now. Prefs live in user_integrations.settings.presence,
  // mirrored from the desktop client; a missing row means "available".
  const { data: prefRows } = await admin
    .from('user_integrations')
    .select('user_id, settings')
    .in('user_id', recipientIds);
  const dndSet = new Set(
    (prefRows ?? [])
      .filter((r) => isDndNow((r.settings ?? {}).presence))
      .map((r) => r.user_id),
  );
  recipientIds = recipientIds.filter((id) => !dndSet.has(id));
  if (!recipientIds.length) return json({ ok: true, skipped: 'all recipients in DND' });

  const { data: author } = await admin.from('profiles').select('name').eq('user_id', msg.author_id).maybeSingle();
  const authorName = author?.name ?? 'Someone';

  const { data: tokenRows } = await admin.from('device_tokens').select('token').in('user_id', recipientIds);
  const to = (tokenRows ?? []).map((t) => t.token).filter((t): t is string => typeof t === 'string' && EXPO_TOKEN_RE.test(t));
  if (!to.length) return json({ ok: true, skipped: 'no device tokens' });

  const title = isDm ? authorName : `${authorName} in #${channel?.name ?? 'channel'}`;
  const preview = (msg.body || 'Sent an attachment').slice(0, 140);

  const messages = to.map((token) => ({
    to: token,
    title,
    body: preview,
    sound: 'default',
    data: { teamId: msg.team_id, channelId: msg.channel_id, messageId: msg.id, parentId: msg.parent_id },
  }));

  // Expo accepts up to 100 messages per request.
  const deadTokens: string[] = [];
  let sent = 0;
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    try {
      const resp = await fetch(EXPO_PUSH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk),
      });
      if (!resp.ok) {
        console.error('expo push http error', resp.status, await resp.text().catch(() => ''));
        continue;
      }
      const body = await resp.json().catch(() => null) as { data?: Array<{ status?: string; details?: { error?: string } }> } | null;
      const tickets = body?.data ?? [];
      tickets.forEach((ticket, idx) => {
        if (ticket?.status === 'ok') sent++;
        else if (ticket?.details?.error === 'DeviceNotRegistered') deadTokens.push(chunk[idx].to);
      });
    } catch (err) {
      console.error('expo push request failed', err);
    }
  }

  // Garbage-collect tokens Expo says are gone so we stop wasting sends on them.
  if (deadTokens.length) {
    await admin.from('device_tokens').delete().in('token', deadTokens).then(undefined, () => {});
  }

  return json({ ok: true, requested: to.length, sent, pruned: deadTokens.length });
});
