import { supabase } from './supabase';

// Per-user integration credentials live in public.user_integrations.settings
// (JSONB, RLS-gated to the row's user). The desktop writes them via its
// Settings panel; mobile reads the same row.
//
// Settings shape (informal, matches the desktop renderer):
//   {
//     jira:   { host: 'acme.atlassian.net', email: '...', token: '...' },
//     github: { token: '<PAT>' },
//     ...
//   }

export type JiraSettings = { host?: string; email?: string; token?: string };
export type GithubSettings = { token?: string };

type Cache = {
  userId: string;
  loadedAt: number;
  jira: JiraSettings | null;
  github: GithubSettings | null;
};

let cache: Cache | null = null;
const CACHE_TTL_MS = 5 * 60_000; // 5 min — refreshes on next chat open

async function load(userId: string): Promise<Cache> {
  const { data } = await supabase
    .from('user_integrations')
    .select('settings')
    .eq('user_id', userId)
    .maybeSingle();
  const settings = (data?.settings ?? {}) as { jira?: JiraSettings; github?: GithubSettings };
  return {
    userId,
    loadedAt: Date.now(),
    jira: settings.jira ?? null,
    github: settings.github ?? null,
  };
}

async function get(userId: string): Promise<Cache> {
  if (cache && cache.userId === userId && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  cache = await load(userId);
  return cache;
}

export async function getJiraSettings(userId: string): Promise<JiraSettings | null> {
  const c = await get(userId);
  return c.jira;
}

export async function getGithubSettings(userId: string): Promise<GithubSettings | null> {
  const c = await get(userId);
  return c.github;
}

// Force a reload on next get() — call after the user edits their settings.
export function invalidateIntegrations() {
  cache = null;
}
