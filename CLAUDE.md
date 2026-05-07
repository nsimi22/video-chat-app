# Working with Huddle

## Workflow

**Always work in pull requests.** Even for solo work or small changes,
land code through a feature branch + PR so we get a code review and a
clean trail. Never push directly to `main`.

Standard flow for any change:

```bash
git checkout main && git pull origin main
git checkout -b <descriptive-branch-name>
# ... edits + commits ...
git push -u origin <descriptive-branch-name>
# then open a PR via the GitHub MCP tool, default to draft
```

If a piece of work is already on `main` by mistake, leave it alone — do
not force-push or rewrite history. Open the next change as a PR.

## Repo facts worth knowing

- Backend is **Supabase** (auth + Postgres + Realtime + Storage). The
  project ref is `jwqvrdgjpftjiwvgdrck`. Apply schema changes via
  Supabase migrations and check the SQL into `supabase/migrations/`.
- Renderer talks to third-party APIs through a `fetch-proxy` IPC in
  `main.js` to bypass CORS and gate hosts. New integrations go through
  the same path; add a RegExp for the host to `ALLOWED_PROXY_HOSTS`
  (the array is checked with `.test()`, so plain strings would throw).
- Per-user API keys live in `public.user_integrations.settings` (JSONB,
  RLS-gated). The Settings panel (`⚙` in the sidebar) is the one place
  to surface new keys — do not add env vars for new runtime API keys.
  (The existing `TENOR_API_KEY` env-var fallback is grandfathered for
  back-compat and not a model to copy.)
- Releases are cut by tagging `vX.Y.Z` on `main`; the
  `.github/workflows/release.yml` workflow builds Mac/Windows/Linux
  installers and uploads to GitHub Releases.
