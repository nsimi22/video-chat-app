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
