// Jira Cloud REST client.
//
// Atlassian Cloud's REST API doesn't allow direct browser CORS requests, so
// every call goes through window.huddle.fetchProxy (a tiny IPC bridge in
// main.js that does the network call from Node). The client stores no state
// of its own; settings are passed in by the caller.
//
// Exposed surface:
//   - JiraClient(settings) — constructs from { host, email, token }
//   - getIssue(key) -> issue meta
//   - searchIssues(jql) -> [issue]
//   - listProjects() -> [{key, name}]
//   - listIssueTypes(projectKey) -> [{name, ...}]
//   - createIssue({projectKey, summary, description, issueType, assignee?})
//
// Plus stand-alone helpers: extractKeys/parseJiraUrl for auto-unfurl.

(function () {
  // Two field lists. Brief is what the unfurl card + status pills
  // need; full adds description / labels / timestamps for the AI
  // tools. Splitting keeps every chat unfurl from pulling a full
  // ticket body, which is wasteful on tickets with long ADF
  // descriptions (10x payload on the bad cases).
  const ISSUE_FIELDS_BRIEF = 'summary,status,assignee,issuetype,priority,reporter';
  const ISSUE_FIELDS_FULL  = `${ISSUE_FIELDS_BRIEF},description,labels,updated,created`;

  class JiraClient {
    constructor(settings) {
      const host = String(settings?.host || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
      this.host = host;
      this.email = settings?.email || '';
      this.token = settings?.token || '';
    }

    isConfigured() {
      return !!(this.host && this.email && this.token);
    }

    _baseUrl() { return `https://${this.host}`; }

    async _request(pathAndQuery, { method = 'GET', body = null } = {}) {
      if (!this.isConfigured()) throw new Error('Jira is not configured. Open settings and add host/email/token.');
      const auth = btoa(`${this.email}:${this.token}`);
      const res = await window.huddle.fetchProxy({
        url: this._baseUrl() + pathAndQuery,
        method,
        headers: {
          'Authorization': `Basic ${auth}`,
          'Accept': 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : null,
      });
      if (!res || !res.ok) {
        const detail = res?.body ? safeParseError(res.body) : (res?.error || 'request failed');
        throw new Error(`Jira ${method} ${pathAndQuery}: ${res?.status || 0} ${detail}`);
      }
      try { return JSON.parse(res.body); } catch { return null; }
    }

    // `full: true` pulls description + labels + timestamps for AI
    // consumption; the unfurl path leaves it false to keep the
    // payload tiny on every chat-render lookup. `fields` overrides
    // both presets with an explicit list (the board's date fetch).
    getIssue(key, { full = false, fields = null } = {}) {
      const fieldList = fields || (full ? ISSUE_FIELDS_FULL : ISSUE_FIELDS_BRIEF);
      return this._request(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fieldList)}`);
    }
    // `fields` overrides the brief/full preset with an explicit comma-
    // separated field list — used by the board, which needs `labels`
    // (absent from BRIEF) but not the heavy `description` (in FULL).
    // `pageToken` continues a previous page (the /search/jql endpoint
    // serves at most ~100 issues per request and signals more via
    // nextPageToken in the response).
    searchIssues(jql, max = 20, { full = false, fields = null, pageToken = null } = {}) {
      const fieldList = fields || (full ? ISSUE_FIELDS_FULL : ISSUE_FIELDS_BRIEF);
      const q = `jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=${encodeURIComponent(fieldList)}`
        + (pageToken ? `&nextPageToken=${encodeURIComponent(pageToken)}` : '');
      return this._request(`/rest/api/3/search/jql?${q}`);
    }
    // Walk nextPageToken until `max` issues or the last page. One page is
    // one request, so this stays a single round-trip for small projects.
    async searchIssuesAll(jql, max = 500, opts = {}) {
      const issues = [];
      let pageToken = null;
      while (issues.length < max) {
        const res = await this.searchIssues(jql, Math.min(100, max - issues.length), { ...opts, pageToken });
        const page = res?.issues || [];
        issues.push(...page);
        if (!res?.nextPageToken || page.length === 0) break;
        pageToken = res.nextPageToken;
      }
      return { issues };
    }
    // The /search/jql endpoint dropped the `total` field; this is the
    // sanctioned way to get a match count for a JQL query.
    approximateCount(jql) {
      return this._request(`/rest/api/3/search/approximate-count`, { method: 'POST', body: { jql } })
        .then((r) => (typeof r?.count === 'number' ? r.count : null));
    }
    listProjects() {
      return this._request(`/rest/api/3/project/search?maxResults=100`).then((r) => r.values || []);
    }
    listIssueTypes(projectKey) {
      // Cheap-and-cheerful: pull the project's `issueTypes` directly.
      return this._request(`/rest/api/3/project/${encodeURIComponent(projectKey)}`).then((p) => p.issueTypes || []);
    }
    // Users assignable to issues in a project, for the board's assignee
    // picker. `query` type-ahead filters by name/email; empty lists the
    // first page. Returns [{ accountId, displayName, avatarUrls, emailAddress }].
    listAssignableUsers(projectKey, query = '') {
      const q = `project=${encodeURIComponent(projectKey)}&query=${encodeURIComponent(query)}&maxResults=50`;
      return this._request(`/rest/api/3/user/assignable/search?${q}`).then((r) => Array.isArray(r) ? r : []);
    }
    // Global priority scheme (e.g. Highest/High/Medium/Low/Lowest) for the
    // board's priority picker. Returns [{ id, name, iconUrl }].
    listPriorities() {
      return this._request(`/rest/api/3/priority`).then((r) => Array.isArray(r) ? r : []);
    }
    // All field definitions (system + custom). The roadmap uses this to
    // locate Jira Cloud's "Start date" custom field, whose id varies per
    // site (commonly customfield_10015). Returns [{ id, name, schema, ... }].
    listFields() {
      return this._request(`/rest/api/3/field`).then((r) => Array.isArray(r) ? r : []);
    }
    // The project's real Agile-board column layout, so the kanban can mirror
    // Jira exactly (columns persist even when empty — e.g. an unused
    // "Ready for Release"). Returns [{ name, statuses: [{ name, cat }] }] in
    // Jira's column order, or null when the project has no board the user
    // can see (caller falls back to deriving columns from live statuses).
    async getBoardConfig(projectKey) {
      const boards = await this._request(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&maxResults=1`);
      const boardId = boards?.values?.[0]?.id;
      if (!boardId) return null;
      const [cfg, statuses] = await Promise.all([
        this._request(`/rest/agile/1.0/board/${boardId}/configuration`),
        this._request(`/rest/api/3/status`), // id -> name/category map
      ]);
      const byId = new Map((Array.isArray(statuses) ? statuses : [])
        .map((s) => [String(s.id), { name: s.name, cat: s.statusCategory?.key || 'new' }]));
      const cols = (cfg?.columnConfig?.columns || [])
        .map((c) => ({ name: c.name, statuses: (c.statuses || []).map((s) => byId.get(String(s.id))).filter(Boolean) }))
        .filter((c) => c.statuses.length); // a column with no mapped statuses can't hold or receive cards
      return cols.length ? cols : null;
    }
    async createIssue({ projectKey, summary, description, issueType, assigneeAccountId }) {
      const body = {
        fields: {
          project: { key: projectKey },
          summary,
          issuetype: { name: issueType || 'Task' },
          ...(description ? { description: toAdf(description) } : {}),
          ...(assigneeAccountId ? { assignee: { accountId: assigneeAccountId } } : {}),
        },
      };
      return this._request(`/rest/api/3/issue`, { method: 'POST', body });
    }
    // Update ticket fields. Empty/undefined values are skipped so the
    // caller can pass a sparse patch (e.g., { key, summary } to only
    // rename). Description goes through toAdf since Jira Cloud's v3
    // PUT requires the same ADF shape as create.
    async updateIssue({ key, summary, description, assigneeAccountId, labels, priorityName, duedate, extraFields }) {
      const fields = {};
      if (summary != null) fields.summary = String(summary);
      if (description != null) fields.description = toAdf(description);
      if (assigneeAccountId !== undefined) {
        // null clears the assignee, undefined is skip. Jira's API uses
        // `accountId: null` for the unassign path.
        fields.assignee = assigneeAccountId === null ? { accountId: null } : { accountId: assigneeAccountId };
      }
      if (Array.isArray(labels)) fields.labels = labels.map(String);
      if (priorityName) fields.priority = { name: priorityName };
      // null clears the due date, undefined is skip (same contract as assignee).
      if (duedate !== undefined) fields.duedate = duedate;
      // Raw field-id → value pairs, for fields whose ids vary per site
      // (the roadmap's "Start date" custom field).
      if (extraFields && typeof extraFields === 'object') Object.assign(fields, extraFields);
      if (Object.keys(fields).length === 0) {
        throw new Error('updateIssue: no fields to update');
      }
      // PUT returns 204 on success — _request returns null for an empty
      // body, which is fine; we only care that no error was thrown.
      await this._request(`/rest/api/3/issue/${encodeURIComponent(key)}`, { method: 'PUT', body: { fields } });
      return { key };
    }
    // Append a comment. Body is plain text — converted to ADF for the
    // v3 API. Returns the created comment's id + URL-friendly self.
    async addComment({ key, body }) {
      const payload = { body: toAdf(String(body || '')) };
      return this._request(
        `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
        { method: 'POST', body: payload },
      );
    }
    // List the workflow transitions available to the caller for an
    // issue. AI calls this before transition_issue so it can map a
    // human-friendly state name (e.g. "Done") to the workflow's
    // transition id, which varies per project.
    listTransitions(key) {
      return this._request(`/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)
        .then((r) => r?.transitions || []);
    }
    async transitionIssue({ key, transitionId, comment }) {
      const payload = { transition: { id: String(transitionId) } };
      if (comment) {
        payload.update = { comment: [{ add: { body: toAdf(String(comment)) } }] };
      }
      await this._request(
        `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
        { method: 'POST', body: payload },
      );
      return { key, transitionId };
    }
    issueUrl(key) { return `${this._baseUrl()}/browse/${key}`; }
    // Portable project landing URL. `/browse/<PROJECTKEY>` redirects to
    // the project on both Jira Cloud and Server/DC, unlike the Cloud-only
    // `/jira/software/projects/<KEY>/boards` next-gen path.
    projectUrl(projectKey) { return `${this._baseUrl()}/browse/${projectKey}`; }
  }

  function safeParseError(body) {
    try {
      const j = JSON.parse(body);
      if (j.errorMessages?.length) return j.errorMessages.join('; ');
      if (j.errors) return Object.entries(j.errors).map(([k, v]) => `${k}: ${v}`).join('; ');
      return body.slice(0, 200);
    } catch { return body.slice(0, 200); }
  }

  // Walk an Atlassian Document Format tree to plain-text Markdown: headings
  // become '## …', list items '- …', and paragraphs/code/quotes keep their
  // line breaks. Link href and mention metadata are still dropped (lossy);
  // nested lists flatten to a single level. Consumers (the board description
  // view, AI tools) render or read this as light Markdown, and toAdf parses
  // the same '## '/'- ' back into ADF nodes. Always returns a string.
  function adfToText(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(adfToText).join('');
    if (node.type === 'text' && typeof node.text === 'string') return node.text;
    if (node.type === 'hardBreak' || node.type === 'rule') return '\n';
    const children = adfToText(node.content || []);
    // Preserve structure as ATX markdown so the board renders headings /
    // bullets, and toAdf round-trips them back to real ADF nodes on save.
    if (node.type === 'heading') {
      const txt = children.trim();
      if (!txt) return '';
      const lvl = Math.min(6, Math.max(1, node.attrs?.level || 2));
      return '#'.repeat(lvl) + ' ' + txt + '\n';
    }
    if (node.type === 'listItem') {
      const txt = children.trim();
      return txt ? '- ' + txt + '\n' : '';
    }
    // paragraph / code / quote / task all close with a newline so the doc
    // collapses back to text that reads roughly like the original.
    if (['paragraph', 'codeBlock', 'blockquote', 'taskItem'].includes(node.type)) {
      return children + '\n';
    }
    return children;
  }

  // Convert markdown -> Atlassian Document Format (the only description
  // format Jira Cloud's v3 API accepts). The /ai-ticket flow ships rich
  // markdown (## headings, - [ ] task lists, **bold**, [links](url)); the
  // earlier paragraph-only converter rendered all of that as literal
  // characters in the ticket. This handles the structures we actually
  // emit — anything outside the supported set falls back to a paragraph
  // with hardBreaks rather than throwing, so a malformed AI response
  // still produces a usable ticket.
  function toAdf(text) {
    const lines = String(text == null ? '' : text).split('\n');
    const blocks = [];
    let i = 0;
    let idSeq = 0;
    const nextId = () => `huddle-${Date.now().toString(36)}-${++idSeq}`;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      // ATX heading: # … ###### (cap level at 6 per ADF spec)
      const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) {
        blocks.push({ type: 'heading', attrs: { level: h[1].length }, content: parseInline(h[2]) });
        i++; continue;
      }

      // Fenced code block: ```lang\n…\n```
      const fence = /^```(\w+)?\s*$/.exec(line);
      if (fence) {
        const lang = fence[1] || null;
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) i++; // skip closing fence
        blocks.push({
          type: 'codeBlock',
          ...(lang ? { attrs: { language: lang } } : {}),
          content: buf.length ? [{ type: 'text', text: buf.join('\n') }] : [],
        });
        continue;
      }

      // Task list: consecutive `- [ ]` / `- [x]` lines (one taskList per run)
      if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(line)) {
        const items = [];
        while (i < lines.length) {
          const m = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/.exec(lines[i]);
          if (!m) break;
          items.push({
            type: 'taskItem',
            attrs: { localId: nextId(), state: m[1].toLowerCase() === 'x' ? 'DONE' : 'TODO' },
            content: parseInline(m[2]),
          });
          i++;
        }
        blocks.push({ type: 'taskList', attrs: { localId: nextId() }, content: items });
        continue;
      }

      // Bullet list (ignores task-list lines; those were caught above)
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (i < lines.length) {
          if (/^\s*[-*]\s+\[[ xX]\]\s+/.test(lines[i])) break;
          const m = /^\s*[-*]\s+(.+)$/.exec(lines[i]);
          if (!m) break;
          items.push({ type: 'listItem', content: [{ type: 'paragraph', content: parseInline(m[1]) }] });
          i++;
        }
        blocks.push({ type: 'bulletList', content: items });
        continue;
      }

      // Ordered list. Honor the first item's number as the starting
      // index so `3. foo\n4. bar` renders as 3, 4 in Jira instead of
      // resetting to 1 (matters for partial-list snippets the AI
      // sometimes emits when extending an existing numbered section).
      if (/^\s*\d+\.\s+/.test(line)) {
        const startMatch = /^\s*(\d+)\.\s+/.exec(line);
        const start = startMatch ? parseInt(startMatch[1], 10) || 1 : 1;
        const items = [];
        while (i < lines.length) {
          const m = /^\s*\d+\.\s+(.+)$/.exec(lines[i]);
          if (!m) break;
          items.push({ type: 'listItem', content: [{ type: 'paragraph', content: parseInline(m[1]) }] });
          i++;
        }
        blocks.push({ type: 'orderedList', attrs: { order: start }, content: items });
        continue;
      }

      // Paragraph: collect contiguous non-blank, non-block-starter lines.
      // Single newlines inside the run become hardBreaks (so a multi-line
      // sentence reads as one paragraph in Jira, matching how it reads
      // in the source).
      const para = [];
      while (i < lines.length) {
        const ln = lines[i];
        if (!ln.trim()) break;
        if (/^(#{1,6}\s+|```|\s*[-*]\s+|\s*\d+\.\s+)/.test(ln)) break;
        para.push(ln);
        i++;
      }
      const inline = [];
      para.forEach((p, idx) => {
        if (idx > 0) inline.push({ type: 'hardBreak' });
        inline.push(...parseInline(p));
      });
      blocks.push({ type: 'paragraph', content: inline });
    }

    // Jira accepts an empty doc, but every ADF parser we hit prefers at
    // least a placeholder paragraph — emit one so an empty description
    // still round-trips cleanly.
    if (blocks.length === 0) blocks.push({ type: 'paragraph', content: [] });
    return { type: 'doc', version: 1, content: blocks };
  }

  // Inline tokenizer for ADF marks. Recognized: `code`, **bold**, *italic*,
  // [text](url). Walks left-to-right, claiming the first match at each
  // position so `**foo**` doesn't get partially eaten by the italic rule.
  // Marks compose: **`foo`** stacks `code` + `strong` on the same text
  // node. Unknown punctuation is plain text.
  function parseInline(text) {
    if (!text) return [];
    return parseInlineImpl(String(text), []);
  }

  function withMark(node, mark) {
    if (node.type !== 'text') return node;
    const marks = (node.marks || []).slice();
    if (!marks.some((m) => m.type === mark.type)) marks.push(mark);
    return { ...node, marks };
  }

  function parseInlineImpl(text, _depth) {
    const out = [];
    let buf = '';
    const flush = () => { if (buf) { out.push({ type: 'text', text: buf }); buf = ''; } };
    let i = 0;
    while (i < text.length) {
      const ch = text[i];

      // `code` — literal, no nested parsing
      if (ch === '`') {
        const end = text.indexOf('`', i + 1);
        if (end > i + 1) {
          flush();
          out.push({ type: 'text', text: text.slice(i + 1, end), marks: [{ type: 'code' }] });
          i = end + 1;
          continue;
        }
      }

      // **bold** — must be at least one char between, and the closing **
      // can't be the start of a longer ****…
      if (ch === '*' && text[i + 1] === '*') {
        const end = text.indexOf('**', i + 2);
        if (end > i + 2) {
          flush();
          for (const node of parseInlineImpl(text.slice(i + 2, end))) {
            out.push(withMark(node, { type: 'strong' }));
          }
          i = end + 2;
          continue;
        }
      }

      // *italic* — single asterisk, but not part of ** (handled above first)
      if (ch === '*') {
        const end = text.indexOf('*', i + 1);
        if (end > i + 1 && text[end + 1] !== '*') {
          flush();
          for (const node of parseInlineImpl(text.slice(i + 1, end))) {
            out.push(withMark(node, { type: 'em' }));
          }
          i = end + 1;
          continue;
        }
      }

      // [text](url) — recurse into the bracket contents so nested
      // marks survive (e.g. `[**foo** _bar_](url)` renders as a link
      // whose visible text mixes bold + italic, instead of literal
      // asterisks/underscores).
      if (ch === '[') {
        const m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
        if (m) {
          flush();
          const linkMark = { type: 'link', attrs: { href: m[2] } };
          for (const node of parseInlineImpl(m[1])) {
            out.push(withMark(node, linkMark));
          }
          i += m[0].length;
          continue;
        }
      }

      buf += ch;
      i++;
    }
    flush();
    return out;
  }

  // -------------------------------------------------------------------------
  // Auto-unfurl helpers
  //
  // Detect Jira keys (PROJ-123) and Jira URLs in chat text. Keys are word-
  // boundary sensitive — `FOOBAR-1234` matches but `EMAIL-1` inside an
  // address doesn't, and we exclude common false positives.
  // -------------------------------------------------------------------------

  const KEY_RE = /\b([A-Z][A-Z0-9_]{1,9}-\d+)\b/g;
  const URL_RE = /https:\/\/([a-z0-9-]+)\.atlassian\.net\/browse\/([A-Z][A-Z0-9_]{1,9}-\d+)/gi;

  // Words that match the key pattern but should never be unfurled.
  const KEY_BLOCKLIST = new Set([
    'COVID-19', 'GPT-4', 'GPT-3', 'GPT-5', 'IPV-4', 'IPV-6', 'UTF-8', 'UTF-16',
    'AES-256', 'SHA-1', 'SHA-256', 'HTTP-2', 'HTTP-1', 'HTTPS-1',
  ]);

  function extractKeys(text, defaultHost) {
    if (!text) return [];
    const out = new Map(); // key -> host (or null for default)
    text.replace(URL_RE, (_, host, key) => { out.set(key, host); return _; });
    text.replace(KEY_RE, (_, key) => {
      if (out.has(key)) return _;
      if (KEY_BLOCKLIST.has(key)) return _;
      out.set(key, defaultHost || null);
      return _;
    });
    return [...out.entries()].map(([key, host]) => ({ key, host }));
  }

  window.JiraClient = JiraClient;
  window.jiraExtractKeys = extractKeys;
  window.jiraAdfToText = adfToText;
})();
