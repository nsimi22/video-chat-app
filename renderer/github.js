// GitHub REST client — unfurls + create-issue/PR slash commands.
//
// Routes through window.huddle.fetchProxy for consistency with other API
// clients (Jira, AI). GitHub's REST API does support browser CORS, but the
// proxy keeps the auth surface in one place and avoids a fork in our code.
//
// Public surface:
//   - new GitHubClient({ token })
//   - .isConfigured()
//   - .getIssueOrPull(owner, repo, number) -> issue/PR object
//   - .createIssue(owner, repo, { title, body, labels })
//   - .listMyRepos()  // for the create-from-chat picker if we ever need it
//
// Plus stand-alone helpers: extractGitHubRefs / parseRefAtPos.

(function () {
  class GitHubClient {
    constructor({ token } = {}) {
      this.token = token || '';
    }

    isConfigured() { return !!this.token; }

    async _request(path, { method = 'GET', body = null } = {}) {
      if (!this.isConfigured()) {
        throw new Error('GitHub is not configured. Open Settings and add a Personal Access Token.');
      }
      const res = await window.huddle.fetchProxy({
        url: `https://api.github.com${path}`,
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : null,
      });
      if (!res || !res.ok) {
        throw new Error(`GitHub ${method} ${path}: ${res?.status || 0} ${safeError(res?.body) || res?.error || 'request failed'}`);
      }
      try { return JSON.parse(res.body); } catch { return null; }
    }

    // /repos/.../issues/{n} returns both issues and PRs (PRs have a
    // pull_request key). Use this single endpoint and decide rendering
    // based on the returned shape.
    getIssueOrPull(owner, repo, number) {
      return this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(number)}`);
    }

    createIssue(owner, repo, { title, body, labels }) {
      return this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
        method: 'POST',
        body: { title, body: body || '', ...(labels?.length ? { labels } : {}) },
      });
    }

    listMyRepos() {
      // Affiliation defaults are sane: includes orgs the user belongs to.
      return this._request('/user/repos?per_page=100&sort=pushed');
    }

    htmlUrl(owner, repo, number) {
      return `https://github.com/${owner}/${repo}/issues/${number}`;
    }
  }

  function safeError(body) {
    if (!body) return '';
    try {
      const j = JSON.parse(body);
      if (j.message) return j.message + (j.errors ? ` (${j.errors.map((e) => e.message || JSON.stringify(e)).join('; ')})` : '');
      return body.slice(0, 200);
    } catch { return body.slice(0, 200); }
  }

  // ----------------------------------------------------------------------
  // Reference extraction for auto-unfurl
  //
  // Matches:
  //   - https://github.com/<owner>/<repo>/(issues|pull)/<number>
  //   - <owner>/<repo>#<number>           (e.g. anthropics/claude-code#1234)
  //
  // Bare `#123` is intentionally NOT matched — it collides with hashtags,
  // markdown headings, and other meaningful uses of `#`. If we add a
  // "default repo" setting later we can revisit.
  // ----------------------------------------------------------------------

  const URL_RE = /https:\/\/github\.com\/([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)\/(?:issues|pull)\/(\d+)/g;
  const REF_RE = /(^|[^a-zA-Z0-9._/-])([a-zA-Z0-9][a-zA-Z0-9._-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)#(\d+)\b/g;

  function extractGitHubRefs(text) {
    if (!text) return [];
    const seen = new Map(); // key -> {owner, repo, number}
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(text)) !== null) {
      const [_, owner, repo, num] = m;
      seen.set(`${owner}/${repo}#${num}`, { owner, repo, number: num });
    }
    REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(text)) !== null) {
      const owner = m[2], repo = m[3], num = m[4];
      const key = `${owner}/${repo}#${num}`;
      if (!seen.has(key)) seen.set(key, { owner, repo, number: num });
    }
    return [...seen.values()];
  }

  // Parse a single `owner/repo#123` token (used by `/gh` slash command).
  function parseRefAtPos(token) {
    const m = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\/([a-zA-Z0-9][a-zA-Z0-9._-]*)#(\d+)$/.exec(token.trim());
    if (!m) return null;
    return { owner: m[1], repo: m[2], number: m[3] };
  }

  window.GitHubClient = GitHubClient;
  window.githubExtractRefs = extractGitHubRefs;
  window.githubParseRef = parseRefAtPos;
})();
