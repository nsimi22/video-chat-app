// Sends Expo push notifications when a call starts.
//
// Wired up as a Supabase Database Webhook on public.active_calls INSERT.
// Configure ONLY INSERT — heartbeat UPDATEs must not re-fire the push, or
// every participant joining an ongoing call would ring everyone again.
//
// Recipient policy: everyone who can see the channel, minus the caller.
//   - DMs: the other member(s)
//   - Public/private channels: every member except the caller
// Falls back to "every team member" only for public channels with no
// explicit membership rows, mirroring notify-on-message's behaviour.
//
// Required secrets:
//   SUPABASE_SERVICE_ROLE_KEY  (SUPABASE_URL is auto-injected)
//   NOTIFY_WEBHOOK_SECRET      shared with notify-on-message
//
// Deploy:  supabase functions deploy notify-on-call --no-verify-jwt
// Then add a Database Webhook on public.active_calls (INSERT only) with
// an `x-webhook-secret: <NOTIFY_WEBHOOK_SECRET>` header.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { json } from '../_shared/cors.ts';

type ActiveCallRow = {
  team_id: string;
  channel_id: string;
  started_by: string;
  started_at: string;
  last_active_at: string;
};

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';
const WEBHOOK_SECRET = Deno.env.get('NOTIFY_WEBHOOK_SECRET') ?? '';
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

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const provided = req.headers.get('x-webhook-secret') ?? '';
  if (!WEBHOOK_SECRET || !timingSafeEqual(provided, WEBHOOK_SECRET)) {
    return json({ error: 'unauthorized' }, 401);
  }

  let payload: { type?: string; record?: ActiveCallRow };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (payload.type !== 'INSERT' || !payload.record) {
    // Configure the webhook to fire only on INSERT; if we get an UPDATE/DELETE
    // here it's a misconfiguration. 200 so the webhook isn't retried forever.
    return json({ ok: true, skipped: 'not an insert' });
  }

  const call = payload.record;

  const { data: channel } = await admin
    .from('channels')
    .select('type, name')
    .eq('team_id', call.team_id)
    .eq('id', call.channel_id)
    .maybeSingle();

  // Same channel-vs-team membership resolution notify-on-message uses, so a
  // call started in a private channel doesn't leak a ring to non-members.
  const { data: channelMembers } = await admin
    .from('channel_members')
    .select('user_id')
    .eq('team_id', call.team_id)
    .eq('channel_id', call.channel_id);
  const channelMemberIds = new Set((channelMembers ?? []).map((m) => m.user_id));

  let recipientIds: string[];
  if (channelMemberIds.size > 0) {
    recipientIds = [...channelMemberIds].filter((id) => id !== call.started_by);
  } else {
    // Public channel without explicit membership: ring every team member.
    const { data: teamMembers } = await admin
      .from('team_members')
      .select('user_id')
      .eq('team_id', call.team_id);
    recipientIds = (teamMembers ?? [])
      .map((m) => m.user_id)
      .filter((id) => id !== call.started_by);
  }
  if (!recipientIds.length) return json({ ok: true, skipped: 'no recipients' });

  const { data: starter } = await admin
    .from('profiles')
    .select('name')
    .eq('user_id', call.started_by)
    .maybeSingle();
  const starterName = starter?.name ?? 'Someone';

  const isDm = channel?.type === 'dm';
  const channelName = channel?.name ?? 'channel';

  const { data: tokenRows } = await admin
    .from('device_tokens')
    .select('token')
    .in('user_id', recipientIds);
  const to = (tokenRows ?? [])
    .map((t) => t.token)
    .filter((t): t is string => typeof t === 'string' && EXPO_TOKEN_RE.test(t));
  if (!to.length) return json({ ok: true, skipped: 'no device tokens' });

  const title = isDm
    ? `${starterName} is calling…`
    : `${starterName} started a call`;
  const body = isDm ? '' : `in #${channelName}`;

  const messages = to.map((token) => ({
    to: token,
    title,
    body,
    sound: 'default',
    // The `type: 'call'` tag is what the client's notification-tap handler
    // keys off to route into the call screen rather than the channel.
    // channelName lets us put the right title on the call screen even if
    // the user has never opened that channel before.
    data: {
      type: 'call',
      teamId: call.team_id,
      channelId: call.channel_id,
      channelName,
    },
    // Higher priority + interruption level so the OS treats this like a
    // ring rather than a routine message notification.
    priority: 'high',
    _displayInForeground: true,
  }));

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
      const body = await resp.json().catch(() => null) as {
        data?: Array<{ status?: string; details?: { error?: string } }>;
      } | null;
      const tickets = body?.data ?? [];
      tickets.forEach((ticket, idx) => {
        if (ticket?.status === 'ok') sent++;
        else if (ticket?.details?.error === 'DeviceNotRegistered') deadTokens.push(chunk[idx].to);
      });
    } catch (err) {
      console.error('expo push request failed', err);
    }
  }

  if (deadTokens.length) {
    await admin.from('device_tokens').delete().in('token', deadTokens).then(undefined, () => {});
  }

  return json({ ok: true, requested: to.length, sent, pruned: deadTokens.length });
});
