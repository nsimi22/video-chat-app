import { supabase } from './supabase';
import type { AiSettings } from './ai';

// Per-user integration credentials live in public.user_integrations.settings
// (JSONB, RLS-gated to the row's user). The desktop writes them via its
// Settings panel; mobile reads the same row.
//
// Settings shape (informal, matches the desktop renderer):
//   {
//     jira:   { host, email, token, defaultProject? },
//     github: { token },
//     ai:     { provider, anthropicKey, anthropicModel, openrouterKey, openrouterModel },
//     aiTicket: { context?, githubRepo? },
//   }

export type JiraSettings = { host?: string; email?: string; token?: string; defaultProject?: string };
export type GithubSettings = { token?: string };
export type AiTicketSettings = { context?: string; githubRepo?: string };
export type GiphySettings = { key?: string };
export type CalendarSubscription = { name: string; url: string };
export type CalendarSettings = { subscriptions?: CalendarSubscription[] };

type Cache = {
  userId: string;
  loadedAt: number;
  jira: JiraSettings | null;
  github: GithubSettings | null;
  ai: AiSettings | null;
  aiTicket: AiTicketSettings | null;
  giphy: GiphySettings | null;
  calendar: CalendarSettings | null;
};

let cache: Cache | null = null;
const CACHE_TTL_MS = 5 * 60_000; // 5 min — refreshes on next chat open

async function load(userId: string): Promise<Cache> {
  const { data } = await supabase
    .from('user_integrations')
    .select('settings')
    .eq('user_id', userId)
    .maybeSingle();
  const settings = (data?.settings ?? {}) as {
    jira?: JiraSettings;
    github?: GithubSettings;
    ai?: AiSettings;
    aiTicket?: AiTicketSettings;
    giphy?: GiphySettings;
    calendar?: CalendarSettings;
  };
  return {
    userId,
    loadedAt: Date.now(),
    jira: settings.jira ?? null,
    github: settings.github ?? null,
    ai: settings.ai ?? null,
    aiTicket: settings.aiTicket ?? null,
    giphy: settings.giphy ?? null,
    calendar: settings.calendar ?? null,
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

export async function getAiSettings(userId: string): Promise<AiSettings | null> {
  const c = await get(userId);
  return c.ai;
}

export async function getAiTicketSettings(userId: string): Promise<AiTicketSettings | null> {
  const c = await get(userId);
  return c.aiTicket;
}

export async function getGiphyKey(userId: string): Promise<string | null> {
  const c = await get(userId);
  return c.giphy?.key || null;
}

// Read-only on mobile — the desktop Settings panel is the one place that
// adds/edits subscriptions. Mobile fetches each .ics URL directly (no CORS
// on RN) and merges results into the Calendar tab.
export async function getCalendarSubscriptions(userId: string): Promise<CalendarSubscription[]> {
  const c = await get(userId);
  const subs = c.calendar?.subscriptions;
  if (!Array.isArray(subs)) return [];
  return subs.filter((s): s is CalendarSubscription =>
    !!s && typeof s.url === 'string' && s.url.length > 0,
  );
}

// Force a reload on next get() — call after the user edits their settings.
export function invalidateIntegrations() {
  cache = null;
}
