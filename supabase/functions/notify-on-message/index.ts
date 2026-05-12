// Sends Expo push notifications when a message is inserted.
//
// Wire this up as a Supabase Database Webhook:
//   Table: public.messages   Events: INSERT   Type: HTTP Request -> this function
// (or call it from an AFTER INSERT trigger via pg_net). The payload is the
// standard Supabase webhook shape: { type: 'INSERT', record: <row>, ... }.
//
// MVP policy to avoid spam: only notify for direct messages and explicit
// @-mentions. Channel-wide notifications come later (with per-user prefs).
//
// Uses the service role to read channel_members / profiles / device_tokens.
// Required secret: SUPABASE_SERVICE_ROLE_KEY (SUPABASE_URL is auto-injected).
//
// Deploy:  supabase functions deploy notify-on-message --no-verify-jwt

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

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let payload: { type?: string; record?: MessageRow };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (payload.type !== 'INSERT' || !payload.record) return json({ ok: true, skipped: 'not an insert' });

  const msg = payload.record;

  // Resolve recipients.
  let recipientIds: string[] = [];
  let isDm = false;

  const { data: channel } = await admin.from('channels').select('type, name').eq('team_id', msg.team_id).eq('id', msg.channel_id).maybeSingle();

  if (channel?.type === 'dm') {
    isDm = true;
    const { data: members } = await admin.from('channel_members').select('user_id').eq('team_id', msg.team_id).eq('channel_id', msg.channel_id);
    recipientIds = (members ?? []).map((m) => m.user_id).filter((id) => id !== msg.author_id);
  } else if (msg.mentions?.length) {
    recipientIds = msg.mentions.filter((id) => id !== msg.author_id);
  } else {
    return json({ ok: true, skipped: 'no dm/mention recipients' });
  }
  if (!recipientIds.length) return json({ ok: true, skipped: 'empty recipient set' });

  const { data: author } = await admin.from('profiles').select('name').eq('user_id', msg.author_id).maybeSingle();
  const authorName = author?.name ?? 'Someone';

  const { data: tokens } = await admin.from('device_tokens').select('token').in('user_id', recipientIds);
  const to = (tokens ?? []).map((t) => t.token).filter((t) => typeof t === 'string' && t.startsWith('ExponentPushToken'));
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
  const chunks: typeof messages[] = [];
  for (let i = 0; i < messages.length; i += 100) chunks.push(messages.slice(i, i + 100));

  for (const chunk of chunks) {
    await fetch(EXPO_PUSH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(chunk),
    }).catch(() => {});
  }

  return json({ ok: true, sent: to.length });
});
