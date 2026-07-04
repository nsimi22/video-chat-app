// Flushes due scheduled messages and message reminders.
//
// Meant to run on a schedule (pg_cron → pg_net POST, once a minute — see
// the huddle_scheduled_and_reminders_cron migration) so items fire even
// when the author's app is closed. Open desktop clients also flush on a
// timer; both claim each row with an atomic status flip, so a row is only
// ever delivered once regardless of which path wins.
//
// Uses the service role. Auth is a shared secret (same pattern as
// notify-on-message), so deploy with:
//   supabase functions deploy flush-scheduled --no-verify-jwt
// and set FLUSH_SECRET (falls back to NOTIFY_WEBHOOK_SECRET).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { json } from '../_shared/cors.ts';

const EXPO_PUSH = 'https://exp.host/--/api/v2/push/send';
const EXPO_TOKEN_RE = /^Ex(?:ponent|po)PushToken\[[^\]]+\]$/;
const SECRET = Deno.env.get('FLUSH_SECRET') ?? Deno.env.get('NOTIFY_WEBHOOK_SECRET') ?? '';

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

// Claim a row by flipping its status only if still pending; returns true to
// exactly one caller, so message delivery never duplicates.
async function claim(table: string, id: string, next: string): Promise<boolean> {
  const { data } = await admin.from(table).update({ status: next })
    .eq('id', id).eq('status', 'pending').select('id').maybeSingle();
  return !!data;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const provided = req.headers.get('x-webhook-secret') ?? '';
  if (!SECRET || !timingSafeEqual(provided, SECRET)) return json({ error: 'unauthorized' }, 401);

  const nowIso = new Date().toISOString();
  let messagesSent = 0;
  let remindersFired = 0;

  // --- Scheduled messages ---
  const { data: dueMsgs } = await admin.from('scheduled_messages')
    .select('*').eq('status', 'pending').lte('send_at', nowIso).limit(200);
  // Resolve every author's name/color up front — one query for the batch
  // instead of one per message.
  const authorIds = [...new Set((dueMsgs ?? []).map((r) => r.author_id))];
  const profileById = new Map<string, { name?: string; color?: string }>();
  if (authorIds.length) {
    const { data: profs } = await admin.from('profiles').select('user_id, name, color').in('user_id', authorIds);
    for (const p of profs ?? []) profileById.set(p.user_id, p);
  }
  for (const row of dueMsgs ?? []) {
    if (!(await claim('scheduled_messages', row.id, 'sent'))) continue;
    const prof = profileById.get(row.author_id);
    const { data: inserted, error } = await admin.from('messages').insert({
      team_id: row.team_id, channel_id: row.channel_id, parent_id: row.parent_id,
      author_id: row.author_id, author_name: prof?.name ?? 'Someone', author_color: prof?.color ?? null,
      body: row.body ?? '', attachments: row.attachments ?? [],
    }).select('id').single();
    if (error) {
      await admin.from('scheduled_messages').update({ status: 'failed', error: String(error.message) }).eq('id', row.id);
      continue;
    }
    await admin.from('scheduled_messages').update({ sent_message_id: inserted.id }).eq('id', row.id);
    messagesSent++;
  }

  // --- Reminders ---
  const { data: dueRems } = await admin.from('message_reminders')
    .select('*').eq('status', 'pending').lte('remind_at', nowIso).limit(200);
  // One device-token query for every user with a due reminder, grouped in
  // memory, instead of a query per reminder.
  const remUserIds = [...new Set((dueRems ?? []).map((r) => r.user_id))];
  const tokensByUser = new Map<string, string[]>();
  if (remUserIds.length) {
    const { data: tokenRows } = await admin.from('device_tokens').select('user_id, token').in('user_id', remUserIds);
    for (const t of tokenRows ?? []) {
      if (typeof t.token !== 'string' || !EXPO_TOKEN_RE.test(t.token)) continue;
      const list = tokensByUser.get(t.user_id) ?? [];
      list.push(t.token);
      tokensByUser.set(t.user_id, list);
    }
  }
  const pushes: Array<{ to: string; title: string; body: string; sound: string; data: unknown }> = [];
  for (const r of dueRems ?? []) {
    if (!(await claim('message_reminders', r.id, 'fired'))) continue;
    remindersFired++;
    for (const token of tokensByUser.get(r.user_id) ?? []) {
      pushes.push({
        to: token, title: '⏰ Reminder',
        body: r.note || 'You asked to be reminded about a message.',
        sound: 'default',
        data: { teamId: r.team_id, channelId: r.channel_id, messageId: r.message_id },
      });
    }
  }
  for (let i = 0; i < pushes.length; i += 100) {
    try {
      await fetch(EXPO_PUSH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(pushes.slice(i, i + 100)),
      });
    } catch (err) { console.error('reminder push failed', err); }
  }

  return json({ ok: true, messagesSent, remindersFired });
});
