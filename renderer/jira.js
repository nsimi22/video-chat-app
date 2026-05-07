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
  const ISSUE_FIELDS = 'summary,status,assignee,issuetype,priority,reporter';

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

    getIssue(key) {
      return this._request(`/rest/api/3/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(ISSUE_FIELDS)}`);
    }
    searchIssues(jql, max = 20) {
      const q = `jql=${encodeURIComponent(jql)}&maxResults=${max}&fields=${encodeURIComponent(ISSUE_FIELDS)}`;
      return this._request(`/rest/api/3/search?${q}`);
    }
    listProjects() {
      return this._request(`/rest/api/3/project/search?maxResults=100`).then((r) => r.values || []);
    }
    listIssueTypes(projectKey) {
      // Cheap-and-cheerful: pull the project's `issueTypes` directly.
      return this._request(`/rest/api/3/project/${encodeURIComponent(projectKey)}`).then((p) => p.issueTypes || []);
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
    issueUrl(key) { return `${this._baseUrl()}/browse/${key}`; }
  }

  function safeParseError(body) {
    try {
      const j = JSON.parse(body);
      if (j.errorMessages?.length) return j.errorMessages.join('; ');
      if (j.errors) return Object.entries(j.errors).map(([k, v]) => `${k}: ${v}`).join('; ');
      return body.slice(0, 200);
    } catch { return body.slice(0, 200); }
  }

  // Convert plain text -> Atlassian Document Format (the only description
  // format Jira Cloud's v3 API accepts).
  function toAdf(text) {
    const paragraphs = String(text).split(/\n{2,}/);
    return {
      type: 'doc',
      version: 1,
      content: paragraphs.map((p) => ({
        type: 'paragraph',
        content: p.split('\n').flatMap((line, i, arr) => {
          const seg = line ? [{ type: 'text', text: line }] : [];
          return i < arr.length - 1 ? [...seg, { type: 'hardBreak' }] : seg;
        }),
      })),
    };
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
})();
