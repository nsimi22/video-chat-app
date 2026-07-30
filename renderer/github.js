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

    async _request(path, { method = 'GET', body = null, accept } = {}) {
      if (!this.isConfigured()) {
        throw new Error('GitHub is not configured. Open Settings and add a Personal Access Token.');
      }
      const res = await window.huddle.fetchProxy({
        url: `https://api.github.com${path}`,
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          // `accept` lets specific endpoints opt into media types like
          // `application/vnd.github.text-match+json` (search highlighting)
          // without flipping the default for every other call.
          'Accept': accept || 'application/vnd.github+json',
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

    // /repos/.../pulls/{n} — the *pull* resource (distinct from the issue
    // resource getIssueOrPull returns). Only this endpoint carries the
    // review/merge fields we care about: `draft`, `mergeable` (true/false/
    // null while GitHub computes it async), `mergeable_state`, `head.sha`,
    // and `requested_reviewers` / `requested_teams`.
    getPull(owner, repo, number) {
      return this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}`);
    }

    // Combined CI signal for a commit. GitHub has two overlapping systems:
    // the legacy commit *statuses* API (Travis-era, still used by many
    // integrations) and the newer *check runs* (GitHub Actions, etc.). A PR
    // can have either or both, so we fetch both and roll them together.
    // per_page=100: both endpoints default to 30. Beyond the counts, the
    // combined-status response also carries an authoritative `state` that
    // spans every page (see rollupChecks) — but we still want the fuller
    // page so the passed/total tally shown on the pill is accurate.
    getCombinedStatus(owner, repo, ref) {
      return this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/status?per_page=100`);
    }

    getCheckRuns(owner, repo, ref) {
      return this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`);
    }

    // One page (100) of reviews is plenty for an unfurl — a PR with >100
    // review events is pathological, and we only need the latest verdict
    // per reviewer anyway.
    getPullReviews(owner, repo, number) {
      return this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}/reviews?per_page=100`);
    }

    // Fetch everything the PR card needs beyond the issue shape — merge
    // state, CI rollup, and review decision — and normalize it into one
    // small object the renderer can paint without knowing GitHub's API
    // quirks. Sub-fetches run in parallel off the pull's head SHA; any that
    // fail (e.g. the token can't read checks) degrade to an 'unknown'
    // sub-status rather than failing the whole card.
    async getPullSummary(owner, repo, number) {
      const pull = await this.getPull(owner, repo, number);
      const sha = pull?.head?.sha;
      const [status, checkRuns, reviews] = await Promise.all([
        sha ? this.getCombinedStatus(owner, repo, sha).catch(() => null) : null,
        sha ? this.getCheckRuns(owner, repo, sha).catch(() => null) : null,
        this.getPullReviews(owner, repo, number).catch(() => null),
      ]);
      return {
        draft: !!pull?.draft,
        mergeable: pull?.mergeable ?? null,
        mergeableState: pull?.mergeable_state || 'unknown',
        checks: rollupChecks(status, checkRuns),
        review: rollupReview(reviews, pull),
      };
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

    // --- Repo introspection (used by the /ai-ticket tool loop) ----------
    //
    // These four methods give the AI a tight, indexed view of a repo:
    // search code by keyword, search issues/PRs, read a specific file,
    // list recent commits. All are scoped to a single repo passed in as
    // `owner/name`; bad shapes throw before issuing the request so the
    // tool surface fails loudly during prompt-engineering rather than
    // returning an opaque GitHub 422.

    static parseRepoSlug(slug) {
      const m = /^([a-zA-Z0-9._-]+)\/([a-zA-Z0-9._-]+)$/.exec((slug || '').trim());
      if (!m) throw new Error(`bad repo slug "${slug}" — expected "owner/name"`);
      return { owner: m[1], repo: m[2] };
    }

    // GitHub code search; results are file-level. q is a raw search
    // expression — we add `repo:owner/name` ourselves so callers can
    // pass plain keywords. Returns up to `limit` of {path, snippet}.
    async searchCode(slug, q, { limit = 8 } = {}) {
      const { owner, repo } = GitHubClient.parseRepoSlug(slug);
      // URLSearchParams handles the percent-encoding rules correctly —
      // GitHub also accepts the over-encoded `repo%3Afoo%2Fbar` shape,
      // but the cleaner form keeps the URL grep-friendly in proxy logs.
      const params = new URLSearchParams({ q: `${q} repo:${owner}/${repo}`, per_page: String(limit) });
      // text-match media type is required for `text_matches` to populate;
      // without it GitHub returns just file metadata and the AI has to
      // burn a read_file call per result to see if a hit is meaningful.
      const json = await this._request(`/search/code?${params.toString()}`, {
        accept: 'application/vnd.github.text-match+json',
      });
      return (json?.items || []).slice(0, limit).map((it) => ({
        path: it.path,
        url: it.html_url,
        snippet: (it.text_matches?.[0]?.fragment || it.name || '').slice(0, 240),
      }));
    }

    // /search/issues spans both issues and PRs (PRs have a pull_request
    // key in the result). Useful for the AI to spot duplicate or related
    // tickets before drafting a new one.
    async searchIssues(slug, q, { limit = 8 } = {}) {
      const { owner, repo } = GitHubClient.parseRepoSlug(slug);
      const params = new URLSearchParams({ q: `${q} repo:${owner}/${repo}`, per_page: String(limit) });
      const json = await this._request(`/search/issues?${params.toString()}`);
      return (json?.items || []).slice(0, limit).map((it) => ({
        number: it.number,
        title: it.title,
        state: it.state,
        kind: it.pull_request ? 'pull_request' : 'issue',
        url: it.html_url,
        body: (it.body || '').slice(0, 400),
      }));
    }

    // GET /repos/{o}/{r}/contents/{path} returns the file as
    // base64-encoded `content`. We decode + line-slice here so the
    // tool result stays inside a token budget regardless of file size.
    async readFile(slug, path, { lineStart, lineEnd, maxLines = 200 } = {}) {
      const { owner, repo } = GitHubClient.parseRepoSlug(slug);
      const segments = (path || '').replace(/^\/+/, '').split('/').filter(Boolean);
      // Reject `..` segments outright. GitHub normalizes them server-
      // side and either 404s or returns a different file, both of
      // which surface as opaque tool errors. Failing here returns a
      // clear message the model can correct.
      if (segments.length === 0) throw new Error('empty path');
      if (segments.some((s) => s === '..' || s === '.')) {
        throw new Error(`path "${path}" contains traversal segments — pass a repo-relative path`);
      }
      const safePath = segments.map(encodeURIComponent).join('/');
      const json = await this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${safePath}`);
      if (!json || json.type !== 'file' || typeof json.content !== 'string') {
        throw new Error(`not a file: ${path}`);
      }
      // atob alone treats each base64-decoded byte as one character, so
      // UTF-8 multi-byte sequences (anything non-ASCII in comments or
      // strings) end up mangled. Round-trip via Uint8Array → TextDecoder
      // so the AI sees the file the way the editor would.
      const binary = atob(json.content.replace(/\n/g, ''));
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const decoded = new TextDecoder().decode(bytes);
      const lines = decoded.split('\n');
      let start = Math.max(1, lineStart || 1);
      let end = Math.min(lines.length, lineEnd || start + maxLines - 1);
      if (end - start + 1 > maxLines) end = start + maxLines - 1;
      const slice = lines.slice(start - 1, end).join('\n');
      // truncated = "we omitted content the caller might have wanted".
      // A user-supplied range is intentional, so leading/trailing skip
      // there isn't truncation. Flag when the maxLines cap actually
      // clipped the range — either there was no explicit lineEnd (we
      // stopped short of the file) OR an explicit lineEnd was requested
      // past the line we could return. Without the second case an
      // oversized explicit range got silently clipped while reporting
      // truncated:false, so the model believed it had the full range.
      const truncated = end < lines.length && (lineEnd == null || lineEnd > end);
      return {
        path: json.path,
        sha: json.sha,
        totalLines: lines.length,
        rangeStart: start,
        rangeEnd: end,
        truncated,
        content: slice,
      };
    }

    async listRecentCommits(slug, { limit = 10, path } = {}) {
      const { owner, repo } = GitHubClient.parseRepoSlug(slug);
      const params = new URLSearchParams({ per_page: String(Math.min(limit, 25)) });
      if (path) params.set('path', path);
      const json = await this._request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?${params.toString()}`);
      return (json || []).map((c) => ({
        sha: c.sha?.slice(0, 8) || '',
        message: (c.commit?.message || '').split('\n', 1)[0].slice(0, 200),
        author: c.commit?.author?.name || c.author?.login || '',
        date: c.commit?.author?.date || '',
      }));
    }

    htmlUrl(owner, repo, number) {
      return `https://github.com/${owner}/${repo}/issues/${number}`;
    }
  }

  // Fold commit statuses + check runs into a single pass/fail/pending tally.
  // A check counts as failed if it finished with a bad conclusion, pending
  // if it hasn't finished, passed otherwise. `rollup` is failure > pending >
  // success > none, matching how GitHub gates the merge button.
  function rollupChecks(status, checkRuns) {
    let passed = 0, failed = 0, pending = 0;
    // Legacy commit statuses: each context reports success | pending |
    // failure | error.
    for (const s of status?.statuses || []) {
      if (s.state === 'success') passed++;
      else if (s.state === 'failure' || s.state === 'error') failed++;
      else pending++; // 'pending'
    }
    // Check runs: `status` is queued | in_progress | completed; only when
    // completed does `conclusion` mean anything. neutral/skipped don't
    // block a merge, so they count as passed rather than failed.
    for (const r of checkRuns?.check_runs || []) {
      if (r.status !== 'completed') { pending++; continue; }
      if (['success', 'neutral', 'skipped'].includes(r.conclusion)) passed++;
      else failed++; // failure | timed_out | cancelled | action_required | stale
    }
    const total = passed + failed + pending;
    // The combined-status endpoint returns an authoritative rollup across
    // ALL legacy statuses — including any on pages we didn't fetch — so trust
    // its `state` for the verdict rather than only our per-context tally.
    // Guard on total_count: a commit with zero statuses reports state:
    // 'pending' by default, which would wrongly stall a check-runs-only
    // (GitHub Actions) PR whose runs all passed.
    const hasStatuses = (status?.total_count || 0) > 0;
    let rollup;
    if (failed || (hasStatuses && status.state === 'failure')) rollup = 'failure';
    else if (pending || (hasStatuses && status.state === 'pending')) rollup = 'pending';
    else if (total) rollup = 'success';
    else rollup = 'none';
    return { rollup, passed, failed, pending, total };
  }

  // Reduce the review timeline to a single decision. GitHub only counts each
  // reviewer's *latest* actionable verdict, so we walk the list (returned in
  // chronological order) and keep the last APPROVED / CHANGES_REQUESTED per
  // author; DISMISSED clears their prior verdict; COMMENTED never counts.
  // "Review required" mirrors branch-protection intent: reviewers are
  // requested (or none have weighed in) and nobody has approved.
  function rollupReview(reviews, pull) {
    const latest = new Map(); // author login -> APPROVED | CHANGES_REQUESTED
    for (const rv of reviews || []) {
      const login = rv.user?.login;
      if (!login) continue;
      if (rv.state === 'APPROVED' || rv.state === 'CHANGES_REQUESTED') latest.set(login, rv.state);
      else if (rv.state === 'DISMISSED') latest.delete(login);
      // COMMENTED / PENDING: ignored
    }
    let approvals = 0, changesRequested = 0;
    for (const state of latest.values()) {
      if (state === 'APPROVED') approvals++;
      else changesRequested++;
    }
    const reviewersRequested = (pull?.requested_reviewers?.length || 0) + (pull?.requested_teams?.length || 0);
    let decision;
    if (changesRequested) decision = 'changes_requested';
    else if (approvals) decision = 'approved';
    else if (reviewersRequested || latest.size === 0) decision = 'review_required';
    else decision = 'none';
    return { decision, approvals, changesRequested, reviewersRequested };
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
