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

// --- Board read path ---------------------------------------------------------
// Mobile port of the desktop board's data layer (renderer/jira.js
// searchIssues / getBoardConfig) over native fetch.

function authHeaders(s: Required<JiraSettings>): Record<string, string> {
  return { Authorization: `Basic ${b64(`${s.email}:${s.token}`)}`, Accept: 'application/json' };
}

// Fields the board list needs — type, summary, status, priority, assignee,
// labels. Deliberately without `description` (fetched lazily on card open).
export const BOARD_FIELDS = 'summary,status,assignee,issuetype,priority,labels';

export type JiraSearchResult = { issues?: JiraBoardIssue[]; nextPageToken?: string };
export type JiraBoardIssue = {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    assignee?: { accountId?: string; displayName?: string } | null;
    issuetype?: { name?: string };
    priority?: { name?: string };
    labels?: string[];
    description?: unknown;
  };
};

// Paginated: /rest/api/3/search/jql serves at most ~100 issues per page,
// so a single request silently truncates bigger projects (whole status
// groups vanished from the board once DAP passed 100 issues). Walk
// nextPageToken until `max` or the last page.
export async function searchJiraIssues(
  s: JiraSettings,
  jql: string,
  max = 500,
  fields = BOARD_FIELDS,
): Promise<JiraBoardIssue[]> {
  if (!jiraIsConfigured(s)) throw new Error('Jira is not configured.');
  const host = normHost(s.host);
  const out: JiraBoardIssue[] = [];
  let pageToken: string | undefined;
  while (out.length < max) {
    const q =
      `jql=${encodeURIComponent(jql)}&maxResults=${Math.min(100, max - out.length)}&fields=${encodeURIComponent(fields)}` +
      (pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(`https://${host}/rest/api/3/search/jql?${q}`, { headers: authHeaders(s) });
    if (!res.ok) throw new Error(`Jira search failed (${res.status})`);
    const json = (await res.json()) as JiraSearchResult;
    const page = json.issues ?? [];
    out.push(...page);
    if (!json.nextPageToken || page.length === 0) break;
    pageToken = json.nextPageToken;
  }
  return out;
}

export type BoardColumnConfig = { name: string; statuses: { name: string; cat: string }[] };

// The project's real Agile-board column layout, so the mobile board can
// mirror Jira exactly (columns persist even when empty). Returns null when
// the project has no board the user can see — caller falls back to deriving
// columns from live statuses.
export async function getJiraBoardConfig(s: JiraSettings, projectKey: string): Promise<BoardColumnConfig[] | null> {
  if (!jiraIsConfigured(s)) return null;
  const host = normHost(s.host);
  const headers = authHeaders(s);
  try {
    const boardsRes = await fetch(
      `https://${host}/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=1`,
      { headers },
    );
    if (!boardsRes.ok) return null;
    const boards = await boardsRes.json();
    const boardId = boards?.values?.[0]?.id;
    if (!boardId) return null;
    const [cfgRes, statusesRes] = await Promise.all([
      fetch(`https://${host}/rest/agile/1.0/board/${boardId}/configuration`, { headers }),
      fetch(`https://${host}/rest/api/3/status`, { headers }), // id -> name/category map
    ]);
    if (!cfgRes.ok || !statusesRes.ok) return null;
    const cfg = await cfgRes.json();
    const statuses = await statusesRes.json();
    const byId = new Map(
      (Array.isArray(statuses) ? statuses : []).map((st: any) => [
        String(st.id),
        { name: st.name as string, cat: (st.statusCategory?.key as string) || 'new' },
      ]),
    );
    const cols: BoardColumnConfig[] = (cfg?.columnConfig?.columns || [])
      .map((c: any) => ({
        name: c.name as string,
        statuses: ((c.statuses || []) as { id: string }[]).map((st) => byId.get(String(st.id))).filter(Boolean) as { name: string; cat: string }[],
      }))
      .filter((c: BoardColumnConfig) => c.statuses.length); // a column with no mapped statuses can't hold cards
    return cols.length ? cols : null;
  } catch {
    return null;
  }
}

// Lazy description fetch for the card detail sheet. Jira v3 returns ADF;
// convert to a flat block list (headings / paragraphs / list items / code /
// quote) so the UI can call out headers and space blocks properly. Inline
// marks (bold, links) are dropped — text content only.
export type AdfBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'p'; text: string }
  | { type: 'li'; ordered: boolean; index: number; depth: number; text: string }
  | { type: 'code'; text: string }
  | { type: 'quote'; text: string };

export async function fetchJiraDescriptionBlocks(s: JiraSettings, key: string): Promise<AdfBlock[] | null> {
  if (!jiraIsConfigured(s)) return null;
  const host = normHost(s.host);
  try {
    const res = await fetch(
      `https://${host}/rest/api/3/issue/${encodeURIComponent(key)}?fields=description`,
      { headers: authHeaders(s) },
    );
    if (!res.ok) return null;
    const json = await res.json();
    const blocks = adfToBlocks(json?.fields?.description);
    return blocks.length ? blocks : null;
  } catch {
    return null;
  }
}

function adfInlineText(node: any): string {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  if (node.type === 'hardBreak') return '\n';
  return Array.isArray(node.content) ? node.content.map(adfInlineText).join('') : '';
}

function adfToBlocks(doc: any): AdfBlock[] {
  const out: AdfBlock[] = [];
  const walk = (node: any, listCtx: { ordered: boolean; depth: number; index: number } | null) => {
    if (!node || typeof node !== 'object') return;
    switch (node.type) {
      case 'heading': {
        const text = adfInlineText(node).trim();
        if (text) out.push({ type: 'heading', level: node.attrs?.level ?? 2, text });
        return;
      }
      case 'paragraph': {
        const text = adfInlineText(node).trim();
        if (!text) return;
        if (listCtx) out.push({ type: 'li', ordered: listCtx.ordered, index: listCtx.index, depth: listCtx.depth, text });
        else out.push({ type: 'p', text });
        return;
      }
      case 'codeBlock': {
        const text = adfInlineText(node);
        if (text.trim()) out.push({ type: 'code', text });
        return;
      }
      case 'blockquote': {
        const text = adfInlineText(node).trim();
        if (text) out.push({ type: 'quote', text });
        return;
      }
      case 'bulletList':
      case 'orderedList': {
        const ordered = node.type === 'orderedList';
        const depth = (listCtx?.depth ?? -1) + 1;
        (node.content ?? []).forEach((li: any, i: number) => {
          // listItem children are paragraphs / nested lists.
          (li?.content ?? []).forEach((child: any) => walk(child, { ordered, depth, index: i + 1 }));
        });
        return;
      }
      default:
        (node.content ?? []).forEach((child: any) => walk(child, listCtx));
    }
  };
  walk(doc, null);
  return out;
}

// --- Board edit path ----------------------------------------------------------
// Mirrors desktop renderer/jira.js: listTransitions / transitionIssue /
// updateIssue (assignee + priority subset) / listAssignableUsers /
// listPriorities.

export type JiraTransition = { id: string; name: string; to?: { name?: string; statusCategory?: { key?: string } } };
export type JiraUser = { accountId: string; displayName: string };
export type JiraPriority = { id: string; name: string };

async function jsonOrThrow(res: Response, what: string) {
  if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
  const text = await res.text().catch(() => '');
  let detail = text;
  try {
    const j = JSON.parse(text);
    detail = j.errorMessages?.join('; ') || Object.values(j.errors || {}).join('; ') || text;
  } catch {}
  throw new Error(`${what} failed (${res.status}): ${detail.slice(0, 200)}`);
}

export async function listJiraTransitions(s: JiraSettings, key: string): Promise<JiraTransition[]> {
  if (!jiraIsConfigured(s)) throw new Error('Jira is not configured.');
  const host = normHost(s.host);
  const res = await fetch(`https://${host}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { headers: authHeaders(s) });
  const json = await jsonOrThrow(res, 'List transitions');
  return json?.transitions ?? [];
}

export async function transitionJiraIssue(s: JiraSettings, key: string, transitionId: string): Promise<void> {
  if (!jiraIsConfigured(s)) throw new Error('Jira is not configured.');
  const host = normHost(s.host);
  const res = await fetch(`https://${host}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    headers: { ...authHeaders(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ transition: { id: String(transitionId) } }),
  });
  await jsonOrThrow(res, 'Transition');
}

// Assignee + priority subset of desktop's updateIssue. `assigneeAccountId:
// null` clears the assignee; undefined skips the field.
export async function updateJiraIssue(
  s: JiraSettings,
  key: string,
  patch: { assigneeAccountId?: string | null; priorityName?: string },
): Promise<void> {
  if (!jiraIsConfigured(s)) throw new Error('Jira is not configured.');
  const fields: Record<string, unknown> = {};
  if (patch.assigneeAccountId !== undefined) fields.assignee = { accountId: patch.assigneeAccountId };
  if (patch.priorityName) fields.priority = { name: patch.priorityName };
  if (!Object.keys(fields).length) return;
  const host = normHost(s.host);
  const res = await fetch(`https://${host}/rest/api/3/issue/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { ...authHeaders(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  await jsonOrThrow(res, 'Update issue');
}

export async function listJiraAssignableUsers(s: JiraSettings, projectKey: string): Promise<JiraUser[]> {
  if (!jiraIsConfigured(s)) throw new Error('Jira is not configured.');
  const host = normHost(s.host);
  const q = `project=${encodeURIComponent(projectKey)}&maxResults=50`;
  const res = await fetch(`https://${host}/rest/api/3/user/assignable/search?${q}`, { headers: authHeaders(s) });
  const json = await jsonOrThrow(res, 'List assignees');
  return Array.isArray(json) ? json.map((u: any) => ({ accountId: u.accountId, displayName: u.displayName })) : [];
}

export async function listJiraPriorities(s: JiraSettings): Promise<JiraPriority[]> {
  if (!jiraIsConfigured(s)) throw new Error('Jira is not configured.');
  const host = normHost(s.host);
  const res = await fetch(`https://${host}/rest/api/3/priority`, { headers: authHeaders(s) });
  const json = await jsonOrThrow(res, 'List priorities');
  return Array.isArray(json) ? json.map((p: any) => ({ id: String(p.id), name: p.name })) : [];
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

// --- AI tool read path -------------------------------------------------------
// A fuller single-issue fetch for the Huddle AI tools layer (src/lib/ai-tools.ts).
// Unlike fetchJiraIssue (compact unfurl fields) this pulls description too and
// flattens ADF to plain text so the model can read a ticket without learning the
// ADF schema — mirrors the desktop renderer/ai-tools.js marshalIssue().

const AI_FIELDS = 'summary,status,assignee,issuetype,priority,reporter,labels,created,updated,description';

export type JiraIssueDetail = {
  key: string;
  url: string;
  summary: string;
  status: string;
  issueType: string;
  priority: string;
  assignee: string | null;
  reporter: string | null;
  labels: string[];
  created: string | null;
  updated: string | null;
  description: string;
};

// Flatten an ADF document to plain text (headings, paragraphs, list items,
// code, quotes). Reuses the block walker the card detail sheet uses.
export function adfToText(doc: unknown): string {
  const blocks = adfToBlocks(doc);
  // Re-emit basic markdown structure (headings, code fences, quotes, lists)
  // rather than flattening everything — the model reads ticket descriptions
  // more accurately when the shape survives.
  return blocks
    .map((b) => {
      if (b.type === 'li') return `${b.ordered ? `${b.index}.` : '-'} ${b.text}`;
      if (b.type === 'heading') return `${'#'.repeat(Math.min(Math.max(b.level, 1), 6))} ${b.text}`;
      if (b.type === 'code') return `\`\`\`\n${b.text}\n\`\`\``;
      if (b.type === 'quote') return `> ${b.text}`;
      return b.text;
    })
    .join('\n')
    .trim();
}

export async function fetchJiraIssueDetail(s: JiraSettings, key: string): Promise<JiraIssueDetail> {
  if (!jiraIsConfigured(s)) throw new Error('Jira is not configured.');
  const host = normHost(s.host);
  const res = await fetch(
    `https://${host}/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(AI_FIELDS)}`,
    { headers: authHeaders(s) },
  );
  const json = await jsonOrThrow(res, `Get issue ${key}`);
  const f = json?.fields ?? {};
  return {
    key: json?.key ?? key,
    url: jiraIssueUrl(host, json?.key ?? key),
    summary: f.summary || '',
    status: f.status?.name || '',
    issueType: f.issuetype?.name || '',
    priority: f.priority?.name || '',
    assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null,
    labels: Array.isArray(f.labels) ? f.labels : [],
    created: f.created || null,
    updated: f.updated || null,
    description: adfToText(f.description),
  };
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
