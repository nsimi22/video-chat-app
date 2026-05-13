// Minimal Jira Cloud client for mobile — just the unfurl read path.
// Native fetch isn't subject to CORS, so we hit api.atlassian.net directly
// (the desktop routes through fetch-proxy because the renderer IS subject to
// CORS). Auth is Basic email:token; the same credentials the desktop's
// Settings panel stores in public.user_integrations.settings.jira.

import type { JiraSettings } from './integrations';

// Tiny base64 encoder. RN doesn't ship a global btoa and we don't want to
// pull in `base-64` just for this one Authorization header. UTF-8 safe via
// encodeURIComponent → byte-string round-trip.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function b64(input: string): string {
  const str = unescape(encodeURIComponent(input));
  let out = '';
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i);
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) : 0;
    out += B64[a >> 2];
    out += B64[((a & 0x3) << 4) | (b >> 4)];
    out += i + 1 < str.length ? B64[((b & 0xf) << 2) | (c >> 6)] : '=';
    out += i + 2 < str.length ? B64[c & 0x3f] : '=';
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
  text.replace(URL_RE, (_, host: string, key: string) => { out.set(key, host); return _; });
  text.replace(KEY_RE, (_, key: string) => {
    if (out.has(key)) return _;
    if (KEY_BLOCKLIST.has(key)) return _;
    out.set(key, defaultHost);
    return _;
  });
  return [...out.entries()].map(([key, host]) => ({ key, host }));
}
