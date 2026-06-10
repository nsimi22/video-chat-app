// AI tool wrappers around external integrations (Jira so far).
//
// Each tool follows Anthropic's tool-use shape — `{ name, description,
// input_schema, run }` — and AiClient (renderer/ai.js) translates the
// schema for OpenRouter when needed. The tools execute in the renderer
// over the same fetchProxy IPC the rest of the integration uses, so
// they inherit auth handling and the host allowlist for free.
//
// Tools are intentionally narrow: each maps to a single Jira REST call.
// We expose the model just enough to read a ticket, post a comment,
// patch fields, list workflow transitions, and trigger one. The
// summary/output strings are tuned for what the model needs to reason
// about — not for what the user sees.

(function () {
  // Marshal an issue into a compact JSON-friendly object. Adf bodies
  // are flattened to plain text so the model can read them without
  // having to learn the ADF schema.
  function marshalIssue(issue, host) {
    if (!issue) return null;
    const f = issue.fields || {};
    return {
      key: issue.key,
      url: host ? `https://${host}/browse/${issue.key}` : undefined,
      summary: f.summary || '',
      status: f.status?.name || '',
      issueType: f.issuetype?.name || '',
      priority: f.priority?.name || '',
      assignee: f.assignee
        ? { accountId: f.assignee.accountId, name: f.assignee.displayName, email: f.assignee.emailAddress }
        : null,
      reporter: f.reporter
        ? { accountId: f.reporter.accountId, name: f.reporter.displayName }
        : null,
      labels: Array.isArray(f.labels) ? f.labels : [],
      created: f.created || null,
      updated: f.updated || null,
      description: window.jiraAdfToText ? window.jiraAdfToText(f.description) : (f.description ? '(description present, viewer unavailable)' : ''),
    };
  }

  // Build the Jira tool set against a configured JiraClient. Returns
  // an empty array when Jira isn't set up so callers can spread the
  // result unconditionally.
  function buildJiraTools(jira) {
    if (!jira || !jira.isConfigured()) return [];
    return [
      {
        name: 'jira_get_issue',
        description: 'Fetch a Jira ticket by its key (e.g., "FOO-123"). Returns summary, status, assignee, description, labels, and timestamps. Use this before summarizing or updating a ticket.',
        input_schema: {
          type: 'object',
          properties: { key: { type: 'string', description: 'The Jira issue key, e.g. "FOO-123".' } },
          required: ['key'],
        },
        async run({ key }) {
          if (!key) throw new Error('key is required');
          const issue = await jira.getIssue(key, { full: true });
          return marshalIssue(issue, jira.host);
        },
      },
      {
        name: 'jira_search_issues',
        description: 'Search Jira tickets with a JQL query. Returns up to `max` results (default 10, max 25). Use this when the user asks about more than one ticket — e.g. "open bugs assigned to me", "tickets updated this week".',
        input_schema: {
          type: 'object',
          properties: {
            jql: { type: 'string', description: 'A valid JQL query string, e.g. "project = FOO AND status = \'In Progress\'".' },
            max: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum number of results to return.' },
          },
          required: ['jql'],
        },
        async run({ jql, max }) {
          const r = await jira.searchIssues(jql, Math.min(Number(max) || 10, 25), { full: true });
          const issues = (r?.issues || []).map((i) => marshalIssue(i, jira.host));
          // /search/jql no longer returns `total`; fetch the real match
          // count separately so the model isn't told the capped page size
          // is the whole result set. Fall back to the page size on error.
          const total = await jira.approximateCount(jql).catch(() => null);
          return { total: total ?? issues.length, issues };
        },
      },
      {
        name: 'jira_add_comment',
        description: 'Append a plain-text comment to a Jira ticket. Use for notes, status updates, or replying to context the user supplied. Markdown / formatting is converted to ADF automatically — pass the prose as plain text.',
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The Jira issue key to comment on.' },
            body: { type: 'string', description: 'The comment text. Plain text; line breaks preserved.' },
          },
          required: ['key', 'body'],
        },
        async run({ key, body }) {
          if (!key || !body) throw new Error('key and body are required');
          const c = await jira.addComment({ key, body });
          return { key, commentId: c?.id || null, ok: true };
        },
      },
      {
        name: 'jira_update_issue',
        description: 'Patch fields on an existing Jira ticket. Pass only the fields you want to change. Use jira_get_issue first if you need to see current values. To unassign a ticket, pass assigneeAccountId: null.',
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string', description: 'The Jira issue key to update.' },
            summary: { type: 'string', description: 'New summary / title.' },
            description: { type: 'string', description: 'New description (plain text; converted to ADF). Replaces the existing body — do not pass when adding a comment.' },
            assigneeAccountId: { type: ['string', 'null'], description: 'Atlassian account id to assign. Use null to unassign.' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Replace the full label set. Pass [] to clear.' },
            priorityName: { type: 'string', description: 'Priority name, e.g. "High". Skip unless the user explicitly asked for a priority change.' },
          },
          required: ['key'],
        },
        async run({ key, ...rest }) {
          if (!key) throw new Error('key is required');
          await jira.updateIssue({ key, ...rest });
          return { key, ok: true, fieldsChanged: Object.keys(rest) };
        },
      },
      {
        name: 'jira_list_transitions',
        description: 'List the workflow transitions currently available on a Jira ticket — e.g. "In Progress" → "Done". Use this BEFORE jira_transition_issue to find the correct transitionId for the target state, since transition ids vary per project workflow.',
        input_schema: {
          type: 'object',
          properties: { key: { type: 'string', description: 'The Jira issue key.' } },
          required: ['key'],
        },
        async run({ key }) {
          if (!key) throw new Error('key is required');
          const t = await jira.listTransitions(key);
          return t.map((tr) => ({ id: tr.id, name: tr.name, to: tr.to?.name || null }));
        },
      },
      {
        name: 'jira_transition_issue',
        description: 'Move a Jira ticket to a new workflow state. Must use a transitionId from jira_list_transitions — name lookups vary per workflow. Optional comment is appended atomically with the transition.',
        input_schema: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            transitionId: { type: 'string', description: 'Transition id from jira_list_transitions.' },
            comment: { type: 'string', description: 'Optional plain-text comment posted with the transition.' },
          },
          required: ['key', 'transitionId'],
        },
        async run({ key, transitionId, comment }) {
          if (!key || !transitionId) throw new Error('key and transitionId are required');
          await jira.transitionIssue({ key, transitionId, comment });
          return { key, transitionId, ok: true };
        },
      },
    ];
  }

  // GitHub repo read tools, scoped to a single `repoSlug` ("owner/name").
  // Shared by chat.js's /ai-ticket loop and the AI panel so both ground the
  // model in the same repo. Built only when a GitHubClient + repo slug are
  // available; each tool caps its own output (limits, snippet/body slicing,
  // readFile line caps) so the iteration budget translates to a bounded
  // token cost. (Moved here from chat.js so the AI panel can reuse it.)
  function buildGithubTicketTools(github, repoSlug) {
    if (!github || !github.isConfigured?.() || !repoSlug) return [];
    return [
      {
        name: 'search_code',
        description: 'Search code in the configured GitHub repo by keyword or phrase. Returns up to 8 file matches with the path and a short snippet. Use this to find files relevant to the ticket BEFORE calling read_file. The query is a raw GitHub code-search expression — quote phrases for literal matches.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Code search query, e.g. "channel_members upsert" or "function buildTicketSystemPrompt".' },
          },
          required: ['query'],
        },
        run: async ({ query }) => github.searchCode(repoSlug, query, { limit: 8 }),
      },
      {
        name: 'read_file',
        description: 'Read a file from the configured GitHub repo. Returns up to 200 lines (or the requested line range). Pair with search_code: search first to find the right path, then read.',
        input_schema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path relative to the repo root, e.g. "renderer/chat.js".' },
            line_start: { type: 'integer', description: 'Optional 1-based line to start reading from.' },
            line_end: { type: 'integer', description: 'Optional 1-based last line to include. Capped at line_start + 199 regardless.' },
          },
          required: ['path'],
        },
        run: async ({ path, line_start, line_end }) =>
          github.readFile(repoSlug, path, { lineStart: line_start, lineEnd: line_end }),
      },
      {
        name: 'search_issues',
        description: 'Search issues and pull requests in the configured GitHub repo. Useful for spotting duplicate or related tickets before drafting a new one. Returns up to 8 results with title, state, and a body snippet.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Issue/PR search query, e.g. "RLS dm policy" or "is:open author:nsimi22".' },
          },
          required: ['query'],
        },
        run: async ({ query }) => github.searchIssues(repoSlug, query, { limit: 8 }),
      },
      {
        name: 'list_recent_commits',
        description: 'List recent commit titles for the configured GitHub repo. Useful to see what has changed lately or to scope by a specific path.',
        input_schema: {
          type: 'object',
          properties: {
            limit: { type: 'integer', description: 'How many commits to return (default 10, max 25).' },
            path: { type: 'string', description: 'Optional repo-relative path filter, e.g. "renderer/chat.js".' },
          },
        },
        run: async ({ limit, path }) => github.listRecentCommits(repoSlug, { limit, path }),
      },
    ];
  }

  window.HuddleAiTools = { buildJiraTools, buildGithubTicketTools };
})();
