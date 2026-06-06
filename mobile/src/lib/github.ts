// Minimal GitHub REST client for mobile — just the unfurl read path. Native
// fetch isn't subject to CORS, so we hit api.github.com directly with the
// PAT stored in user_integrations.settings.github.token (same row + column
// as the desktop's GitHub integration).

import type { GithubSettings } from './integrations';

export type GithubIssue = {
  number: number;
  title: string;
  state: 'open' | 'closed';
  // 'pull_request' is only present on PRs; we surface it as `kind`.
  pull_request?: { merged_at?: string | null; html_url?: string } | null;
  // For PRs, the issues endpoint doesn't return merged status directly; we
  // infer "merged" from `state === 'closed'` + an explicit fetch of the PR
  // resource when present. Keeping it simple here — open/closed is enough
  // for an unfurl.
  user?: { login?: string; avatar_url?: string } | null;
  assignee?: { login?: string; avatar_url?: string } | null;
  html_url: string;
  // Repo path comes from the URL we asked for; we re-attach it for the card.
  owner: string;
  repo: string;
};

export function githubIsConfigured(s: GithubSettings | null): s is Required<GithubSettings> {
  return !!(s && s.token);
}

export async function fetchGithubIssueOrPull(
  s: GithubSettings,
  owner: string,
  repo: string,
  number: string | number,
): Promise<GithubIssue | null> {
  if (!githubIsConfigured(s)) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(number))}`, {
      headers: {
        Authorization: `Bearer ${s.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    return { ...json, owner, repo };
  } catch {
    return null;
  }
}

// --- AI tool read path -------------------------------------------------------
// Read helpers for the Huddle AI tools layer (src/lib/ai-tools.ts): a fuller
// single issue/PR fetch (with body) and a repo issue/PR search, so the model can
// summarize a specific ticket or answer "what's open?"-style questions.

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

export type GithubIssueDetail = {
  kind: 'issue' | 'pull request';
  number: number;
  title: string;
  state: string;
  url: string;
  author: string | null;
  assignee: string | null;
  labels: string[];
  comments: number;
  created: string | null;
  updated: string | null;
  body: string;
};

function marshalGithubIssue(json: any, owner: string, repo: string): GithubIssueDetail {
  const body = typeof json.body === 'string' ? json.body : '';
  return {
    kind: json.pull_request ? 'pull request' : 'issue',
    number: json.number,
    title: json.title || '',
    state: json.state || '',
    url: json.html_url || `https://github.com/${owner}/${repo}/issues/${json.number}`,
    author: json.user?.login || null,
    assignee: json.assignee?.login || null,
    labels: Array.isArray(json.labels) ? json.labels.map((l: any) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [],
    comments: json.comments ?? 0,
    created: json.created_at || null,
    updated: json.updated_at || null,
    // Cap the body so a giant issue can't blow the tool-result token budget.
    body: body.length > 6000 ? `${body.slice(0, 6000)}\n…(truncated)` : body,
  };
}

export async function fetchGithubIssueDetail(
  s: GithubSettings,
  owner: string,
  repo: string,
  number: string | number,
): Promise<GithubIssueDetail> {
  if (!githubIsConfigured(s)) throw new Error('GitHub is not configured.');
  const res = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(number))}`,
    { headers: GH_HEADERS(s.token) },
  );
  if (!res.ok) throw new Error(`GitHub get ${owner}/${repo}#${number} failed (${res.status})`);
  return marshalGithubIssue(await res.json(), owner, repo);
}

export type GithubSearchHit = { number: number; title: string; state: string; kind: 'issue' | 'pull request'; url: string; repo: string };

// Search issues and PRs via the GitHub search API. `query` is a raw GitHub
// search expression; callers typically scope it with `repo:owner/name`.
export async function searchGithubIssues(s: GithubSettings, query: string, max = 10): Promise<GithubSearchHit[]> {
  if (!githubIsConfigured(s)) throw new Error('GitHub is not configured.');
  const res = await fetch(
    `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=${Math.min(Math.max(Number(max) || 10, 1), 25)}`,
    { headers: GH_HEADERS(s.token) },
  );
  if (!res.ok) throw new Error(`GitHub search failed (${res.status})`);
  const json = await res.json();
  return (json.items || []).map((it: any): GithubSearchHit => {
    const m = /github\.com\/([^/]+)\/([^/]+)\//.exec(it.html_url || '');
    return {
      number: it.number,
      title: it.title || '',
      state: it.state || '',
      kind: it.pull_request ? 'pull request' : 'issue',
      url: it.html_url || '',
      repo: m ? `${m[1]}/${m[2]}` : '',
    };
  });
}

// --- Auto-unfurl extractors ------------------------------------------------
// Same regexes as renderer/github.js — both clients pick up the same set.

const URL_RE = /https:\/\/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/(?:issues|pull)\/(\d+)/g;
// Don't allow `/` immediately before the owner (avoids matching path
// fragments that look like refs).
const REF_RE = /(^|[^a-zA-Z0-9._/-])([a-zA-Z0-9][a-zA-Z0-9._-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)#(\d+)\b/g;

export type GithubRef = { owner: string; repo: string; number: string };

export function extractGithubRefs(text: string): GithubRef[] {
  if (!text) return [];
  const seen = new Map<string, GithubRef>();
  for (const m of text.matchAll(URL_RE)) {
    const owner = m[1], repo = m[2], number = m[3];
    seen.set(`${owner}/${repo}#${number}`, { owner, repo, number });
  }
  for (const m of text.matchAll(REF_RE)) {
    const owner = m[2], repo = m[3], number = m[4];
    const k = `${owner}/${repo}#${number}`;
    if (!seen.has(k)) seen.set(k, { owner, repo, number });
  }
  return [...seen.values()];
}
