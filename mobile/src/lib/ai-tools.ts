// AI tool wrappers around mobile's integration clients — the mobile
// counterpart of the desktop renderer/ai-tools.js. Each tool follows the
// Anthropic tool-use shape (`{ name, description, input_schema, run }`) that
// AiClient.chat() consumes; AiClient translates the schema for OpenRouter when
// needed (see src/lib/ai.ts).
//
// These are READ tools — fetch a ticket, search tickets, read a GitHub
// issue/PR, search GitHub. That's all the Huddle AI tab needs to "summarize or
// answer questions from Jira / GitHub." Mutations (comment, transition, create)
// stay in the dedicated board UI and the desktop /ai path; we deliberately keep
// the conversational assistant non-destructive.

import type { ToolDef } from './ai';
import type { JiraSettings, GithubSettings } from './integrations';
import { jiraIsConfigured, fetchJiraIssueDetail, searchJiraIssues } from './jira';
import { githubIsConfigured, fetchGithubIssueDetail, searchGithubIssues } from './github';

// Compact projection of a board-search result row for the model. searchJiraIssues
// returns the heavier JiraBoardIssue; the model only needs the headline fields.
function marshalSearchRow(i: { key: string; fields: any }, host: string) {
  const f = i.fields || {};
  return {
    key: i.key,
    url: `https://${host.replace(/^https?:\/\//, '').replace(/\/$/, '')}/browse/${i.key}`,
    summary: f.summary || '',
    status: f.status?.name || '',
    issueType: f.issuetype?.name || '',
    priority: f.priority?.name || '',
    assignee: f.assignee?.displayName || null,
  };
}

function buildJiraTools(jira: JiraSettings | null): ToolDef[] {
  if (!jiraIsConfigured(jira)) return [];
  // Capture the narrowed (Required) settings as a const so the type guard
  // survives into the tool `run` closures — TS resets parameter narrowing
  // across function boundaries, but not for consts.
  const s = jira;
  return [
    {
      name: 'jira_get_issue',
      description:
        'Fetch a Jira ticket by its key (e.g. "FOO-123"). Returns summary, status, type, priority, assignee, reporter, labels, timestamps, and the full description as plain text. Use this before summarizing or answering questions about a specific ticket.',
      input_schema: {
        type: 'object',
        properties: { key: { type: 'string', description: 'The Jira issue key, e.g. "FOO-123".' } },
        required: ['key'],
      },
      run: async ({ key }) => {
        if (!key) throw new Error('key is required');
        return fetchJiraIssueDetail(s, String(key));
      },
    },
    {
      name: 'jira_search_issues',
      description:
        'Search Jira tickets with a JQL query. Returns up to `max` matching tickets (default 10, max 25). Use this when the user asks about more than one ticket — e.g. "open bugs assigned to me", "tickets in the DAP project updated this week", or to find an epic\'s key by name.',
      input_schema: {
        type: 'object',
        properties: {
          jql: { type: 'string', description: 'A valid JQL query, e.g. "project = DAP AND status = \'In Progress\' ORDER BY updated DESC".' },
          max: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum number of results (default 10).' },
        },
        required: ['jql'],
      },
      run: async ({ jql, max }) => {
        if (!jql) throw new Error('jql is required');
        const limit = Math.min(Math.max(Number(max) || 10, 1), 25);
        const issues = await searchJiraIssues(s, String(jql), limit);
        return { count: issues.length, issues: issues.map((i) => marshalSearchRow(i, s.host)) };
      },
    },
  ];
}

function buildGithubTools(github: GithubSettings | null): ToolDef[] {
  if (!githubIsConfigured(github)) return [];
  const s = github; // narrowed const — see buildJiraTools.
  return [
    {
      name: 'github_get_item',
      description:
        'Fetch a single GitHub issue or pull request, including its body, state, author, labels, and comment count. Use this before summarizing or answering questions about a specific issue/PR.',
      input_schema: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner / org, e.g. "nsimi22".' },
          repo: { type: 'string', description: 'Repository name, e.g. "video-chat-app".' },
          number: { type: 'integer', description: 'The issue or PR number.' },
        },
        required: ['owner', 'repo', 'number'],
      },
      run: async ({ owner, repo, number }) => {
        if (!owner || !repo || !number) throw new Error('owner, repo and number are required');
        return fetchGithubIssueDetail(s, String(owner), String(repo), Number(number));
      },
    },
    {
      name: 'github_search',
      description:
        'Search GitHub issues and pull requests with a raw GitHub search query. Scope it with qualifiers like "repo:owner/name", "is:open", "is:pr", "author:login", "label:bug". Returns up to `max` hits (default 10, max 25). Use for "what PRs are open?"-style questions before drilling in with github_get_item.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'GitHub search expression, e.g. "repo:nsimi22/video-chat-app is:open is:pr".' },
          max: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum number of results (default 10).' },
        },
        required: ['query'],
      },
      run: async ({ query, max }) => {
        if (!query) throw new Error('query is required');
        const hits = await searchGithubIssues(s, String(query), Number(max) || 10);
        return { count: hits.length, results: hits };
      },
    },
  ];
}

// Build the full tool set from whatever integrations the user has configured.
// Returns [] when nothing is configured, so callers can pass the result straight
// through (AiClient treats an empty array as "no tools").
export function buildIntegrationTools(jira: JiraSettings | null, github: GithubSettings | null): ToolDef[] {
  return [...buildJiraTools(jira), ...buildGithubTools(github)];
}
