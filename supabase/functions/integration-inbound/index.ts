// Generic inbound-webhook receiver: external services (GitHub, Sentry,
// anything that can POST JSON) hit this endpoint and their event lands as
// an app-authored message in the integration's channel.
//
// URL shape:  POST /functions/v1/integration-inbound/<integration_id>
//             (?id=<integration_id> also accepted)
//
// Trust model (companion migration 20260706130000_huddle_team_integrations):
//   * The integration id routes; the SECRET authenticates. Secrets live in
//     team_integration_secrets — RLS deny-all, service-role readable only —
//     and are verified here with a constant-time compare. Three schemes,
//     covering how real senders actually authenticate:
//       1. `x-webhook-secret: <secret>` header       (generic senders)
//       2. `?secret=<secret>` query param            (senders w/o headers)
//       3. `x-hub-signature-256: sha256=<hmac>`      (GitHub: HMAC of the
//          raw body keyed by the secret — why the secret is stored raw)
//   * Messages are inserted with the service role: author_id NULL,
//     author_name = the integration's display name, app_integration_id set.
//     Clients can't forge that shape (messages INSERT policy pins
//     author_id = auth.uid(); the author trigger strips app_integration_id
//     from client inserts).
//   * Unknown id, disabled integration, and bad secret all return 404 so
//     probing can't distinguish "exists but wrong secret" from "gone".
//
// Formatting: config.preset picks a built-in formatter ('github',
// 'sentry'); otherwise config.template is applied — a {{ path.to.field }}
// substitution walked against the payload with a whitelist path grammar
// (never evaluated); otherwise a generic fallback. All bodies are
// length-capped: chat markdown is the output, so worst case is ugly text,
// never script.
//
// Required Edge Function secrets (auto-injected by the platform):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Deploy:  supabase functions deploy integration-inbound --no-verify-jwt
//          (--no-verify-jwt: senders are external services, not Supabase
//          sessions; the webhook secret is the auth.)

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, json } from '../_shared/cors.ts';
import { timingSafeEqual } from '../_shared/webhook.ts';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

const MAX_BODY_BYTES = 512 * 1024; // webhook payloads are small; cap hard
const MAX_MESSAGE_CHARS = 4000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function isAuthorized(req: Request, url: URL, rawBody: string, secret: string): Promise<boolean> {
  const header = req.headers.get('x-webhook-secret');
  if (header) return timingSafeEqual(header, secret);
  const qp = url.searchParams.get('secret');
  if (qp) return timingSafeEqual(qp, secret);
  const ghSig = req.headers.get('x-hub-signature-256');
  if (ghSig?.startsWith('sha256=')) {
    const expected = await hmacSha256Hex(secret, rawBody);
    return timingSafeEqual(ghSig.slice('sha256='.length).toLowerCase(), expected);
  }
  return false;
}

// ---------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------

// Resolve "path.like.this" (segments: word chars / dashes / array indexes)
// against the payload. A pure data walk — nothing is ever evaluated.
// deno-lint-ignore no-explicit-any
function resolvePath(payload: any, path: string): string {
  let cur: unknown = payload;
  for (const seg of path.split('.')) {
    if (!/^[\w-]+$/.test(seg)) return '';
    if (cur === null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === undefined || cur === null) return '';
  if (typeof cur === 'object') return JSON.stringify(cur).slice(0, 300);
  return String(cur).slice(0, 1000);
}

// deno-lint-ignore no-explicit-any
function applyTemplate(template: string, payload: any): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path) => resolvePath(payload, path));
}

// GitHub events → one readable line. The event name rides the
// x-github-event header, not the payload.
// deno-lint-ignore no-explicit-any
function formatGithub(event: string, p: any): string {
  const repo = p?.repository?.full_name || '';
  switch (event) {
    case 'ping':
      return `🔌 GitHub webhook connected${repo ? ` for **${repo}**` : ''}.`;
    case 'workflow_run': {
      if (p?.action !== 'completed') return ''; // skip requested/in_progress noise
      const r = p.workflow_run || {};
      const icon = r.conclusion === 'success' ? '✅' : r.conclusion === 'cancelled' ? '⚪' : '❌';
      return `${icon} CI **${r.name || 'workflow'}** ${r.conclusion || 'finished'} on \`${r.head_branch || '?'}\`${repo ? ` in ${repo}` : ''}\n${r.html_url || ''}`;
    }
    case 'pull_request': {
      const pr = p?.pull_request || {};
      const action = p?.action === 'closed' ? (pr.merged ? 'merged' : 'closed') : p?.action;
      if (!['opened', 'reopened', 'ready_for_review', 'merged', 'closed'].includes(action)) return '';
      const icon = action === 'merged' ? '🟣' : action === 'closed' ? '🔴' : '🟢';
      return `${icon} PR #${pr.number} ${action}: **${pr.title || ''}** by ${pr.user?.login || '?'}\n${pr.html_url || ''}`;
    }
    case 'issues': {
      if (!['opened', 'closed', 'reopened'].includes(p?.action)) return '';
      const is = p.issue || {};
      return `🐛 Issue #${is.number} ${p.action}: **${is.title || ''}** by ${is.user?.login || '?'}\n${is.html_url || ''}`;
    }
    case 'push': {
      const commits = Array.isArray(p?.commits) ? p.commits : [];
      if (!commits.length) return ''; // tag pushes / branch deletes
      const branch = String(p.ref || '').replace('refs/heads/', '');
      const lines = commits.slice(0, 5).map((c: { message?: string }) =>
        `• ${String(c.message || '').split('\n')[0]}`);
      if (commits.length > 5) lines.push(`… and ${commits.length - 5} more`);
      return `📌 ${p.pusher?.name || '?'} pushed ${commits.length} commit${commits.length === 1 ? '' : 's'} to \`${branch}\`${repo ? ` in ${repo}` : ''}\n${lines.join('\n')}`;
    }
    default:
      return ''; // unhandled event types are dropped, not spammed
  }
}

// Sentry issue-alert / webhook payloads (both legacy and new shapes).
// deno-lint-ignore no-explicit-any
function formatSentry(p: any): string {
  const issue = p?.data?.issue || p?.data?.event || {};
  const title = issue.title || p?.message || 'Sentry event';
  const url = issue.web_url || p?.url || '';
  const culprit = issue.culprit || '';
  return `🚨 **${title}**${culprit ? `\n\`${culprit}\`` : ''}${url ? `\n${url}` : ''}`;
}

// deno-lint-ignore no-explicit-any
function formatMessage(req: Request, config: any, payload: any): string {
  const preset = config?.preset;
  if (preset === 'github') {
    return formatGithub(req.headers.get('x-github-event') || '', payload);
  }
  if (preset === 'sentry') return formatSentry(payload);
  if (typeof config?.template === 'string' && config.template.trim()) {
    return applyTemplate(config.template, payload);
  }
  // Generic fallback: whatever common "title-ish" field exists, else a
  // trimmed JSON snippet so the event is at least inspectable in-channel.
  const title = payload?.title || payload?.message || payload?.text || payload?.summary;
  if (typeof title === 'string' && title.trim()) return title;
  return '```json\n' + JSON.stringify(payload, null, 2).slice(0, 1500) + '\n```';
}

// ---------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = new URL(req.url);
  // Path: /integration-inbound/<id>; query ?id= as fallback.
  const segs = url.pathname.split('/').filter(Boolean);
  const id = (segs[segs.length - 1] !== 'integration-inbound' ? segs[segs.length - 1] : '')
    || url.searchParams.get('id') || '';
  if (!UUID_RE.test(id)) return json({ error: 'not found' }, 404);

  // Raw body FIRST (HMAC needs the exact bytes), with a hard size cap.
  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return json({ error: 'payload too large' }, 413);

  const { data: integ, error } = await admin
    .from('team_integrations')
    .select('id, team_id, kind, name, channel_id, config, enabled, team_integration_secrets(secret)')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('[integration-inbound] lookup failed', error);
    return json({ error: 'internal' }, 500);
  }
  const secret = integ?.team_integration_secrets?.secret
    ?? integ?.team_integration_secrets?.[0]?.secret; // embed shape differs by relationship detection
  if (!integ || !integ.enabled || integ.kind !== 'inbound_webhook' || !integ.channel_id || !secret) {
    return json({ error: 'not found' }, 404);
  }
  if (!(await isAuthorized(req, url, rawBody, secret))) {
    return json({ error: 'not found' }, 404);
  }

  // deno-lint-ignore no-explicit-any
  let payload: any = {};
  try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch { payload = { text: rawBody.slice(0, 1500) }; }

  const body = formatMessage(req, integ.config, payload).trim().slice(0, MAX_MESSAGE_CHARS);
  // Formatters return '' for event types the channel shouldn't hear about
  // (CI in_progress, unhandled GitHub events). Acknowledge without posting
  // so the sender doesn't retry.
  if (!body) return json({ ok: true, skipped: true }, 202);

  const { error: insErr } = await admin.from('messages').insert({
    team_id: integ.team_id,
    channel_id: integ.channel_id,
    parent_id: null,
    author_id: null,
    author_name: integ.name,
    body,
    attachments: [],
    mentions: [],
    app_integration_id: integ.id,
  });
  if (insErr) {
    console.error('[integration-inbound] insert failed', insErr);
    return json({ error: 'internal' }, 500);
  }
  return json({ ok: true }, 202);
});
