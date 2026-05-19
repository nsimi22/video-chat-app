// Minimal Jira Cloud client for mobile — just the unfurl read path.
// Native fetch isn't subject to CORS, so we hit api.atlassian.net directly
// (the desktop routes through fetch-proxy because the renderer IS subject to
// CORS). Auth is Basic email:token; the same credentials the desktop's
// Settings panel stores in public.user_integrations.settings.jira.

import type { JiraSettings } from './integrations';

// Tiny base64 encoder. RN doesn't ship a global btoa and we don't want to
// pull in `base-64` just for this one Authorization header. UTF-8 bytes via
// TextEncoder (Hermes ships it) — avoids the deprecated unescape() hack.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 0x3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 0xf) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 0x3f] : '=';
  }
  return out;
}

// Compact field set — title + the metadata an unfurl card actually shows.
const FIELDS = 'summary,status,assignee,issuetype,priority,reporter';

export type JiraIssue = {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { colorName?: string; key?: string } };
    assignee?: { displayName?: string; avatarUrls?: Record<string, string> } | null;
    issuetype?: { name?: string; iconUrl?: string };
    priority?: { name?: string };
    reporter?: { displayName?: string };
  };
  host: string; // <host>.atlassian.net (no scheme)
};

export function jiraIsConfigured(s: JiraSettings | null): s is Required<JiraSettings> {
  return !!(s && s.host && s.email && s.token);
}

function normHost(host: string): string {
  return String(host || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function jiraIssueUrl(host: string, key: string): string {
  return `https://${normHost(host)}/browse/${encodeURIComponent(key)}`;
}

// Create a new Jira issue via REST API v3. Used by /ai-ticket. Description is
// converted to ADF (Atlassian Document Format) — required since v3; plain text
// isn't accepted by /rest/api/3/issue.
export async function createJiraIssue(
  s: JiraSettings,
  projectKey: string,
  summary: string,
  description: string,
  issueType: string = 'Task',
): Promise<{ key: string; url: string }> {
  if (!jiraIsConfigured(s)) throw new Error('Jira is not configured.');
  if (!projectKey) throw new Error('Jira default project key not set in Settings.');
  const host = normHost(s.host);
  const adf = {
    type: 'doc',
    version: 1,
    content: description
      .split(/\n\n+/)
      .map((para) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: para }],
      })),
  };
  const auth = b64(`${s.email}:${s.token}`);
  const res = await fetch(`https://${host}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        summary,
        description: adf,
        issuetype: { name: issueType },
      },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const j = JSON.parse(text);
      detail = j.errorMessages?.join('; ') || Object.values(j.errors || {}).join('; ') || text;
    } catch {}
    throw new Error(`Jira create failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = JSON.parse(text);
  return { key: json.key, url: jiraIssueUrl(host, json.key) };
}

export async function fetchJiraIssue(s: JiraSettings, key: string, hostOverride?: string): Promise<JiraIssue | null> {
  if (!jiraIsConfigured(s)) return null;
  const host = normHost(hostOverride || s.host);
  const url = `https://${host}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(FIELDS)}`;
  const auth = b64(`${s.email}:${s.token}`);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return { key: json.key, fields: json.fields ?? {}, host };
  } catch {
    return null;
  }
}

// --- Auto-unfurl extractors ------------------------------------------------
// Same regexes as the desktop's renderer/jira.js so the two clients pick up
// the exact same set of references from a message body.

const KEY_RE = /\b([A-Z][A-Z0-9_]{1,9}-\d+)\b/g;
const URL_RE = /https:\/\/([a-z0-9-]+)\.atlassian\.net\/browse\/([A-Z][A-Z0-9_]{1,9}-\d+)/gi;

// Common acronyms that look like ticket keys but almost never are. Same list
// the desktop client uses.
const KEY_BLOCKLIST = new Set([
  'GET-2', 'POST-2', 'HTTP-2', 'IPV-4', 'IPV-6',
]);

export type JiraRef = { key: string; host?: string };

export function extractJiraRefs(text: string, defaultHost?: string): JiraRef[] {
  if (!text) return [];
  const out = new Map<string, string | undefined>();
  for (const m of text.matchAll(URL_RE)) {
    out.set(m[2], m[1]);
  }
  for (const m of text.matchAll(KEY_RE)) {
    const key = m[1];
    if (out.has(key) || KEY_BLOCKLIST.has(key)) continue;
    out.set(key, defaultHost);
  }
  return [...out.entries()].map(([key, host]) => ({ key, host }));
}
