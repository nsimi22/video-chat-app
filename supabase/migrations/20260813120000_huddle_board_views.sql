-- Per-user board views: saved, fully customizable layouts over the team's
-- Jira board. The team's *project* selection stays shared in
-- public.team_jira_board (one board, one project, everyone sees the same
-- tickets); this table holds how each person wants that board *rendered* —
-- their own columns, card fields, grouping, sorting and filters.
--
-- Ownership model (deliberately different from team_jira_board /
-- team_roadmap_items, which are "any member may edit" shared surfaces):
-- a view belongs to exactly one person. It is private by default, and its
-- owner may flip `shared` to publish it to the team read-only. Teammates
-- can select a shared view and duplicate it into their own, but only the
-- owner can edit or delete the original.
--
-- Nothing here is required: with no rows (or with the built-in "Default
-- board" selected) the renderer derives columns from Jira exactly as it
-- did before this table existed.
create table public.board_views (
  id uuid primary key default gen_random_uuid(),
  team_id text not null references public.teams(id) on delete cascade,
  -- The view's owner. Defaulted from auth.uid() rather than stamped in the
  -- touch trigger: ownership is the security boundary here, so it has to be
  -- in the INSERT policy's WITH CHECK, and a column default keeps that
  -- independent of trigger ordering. Clients never send it.
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 60),
  -- The Jira project key the view's columns were built against. Views are
  -- offered only on the board for their project — a column list naming
  -- another project's statuses would be meaningless.
  project_key text not null check (length(project_key) between 1 and 60),
  -- false = private to the owner; true = readable by the whole team.
  shared boolean not null default false,
  -- The layout itself. Free-form JSONB so the renderer can grow new knobs
  -- without a migration; an empty object means "all defaults", i.e. the
  -- Jira-derived board. Shape (all keys optional, see renderer/jira-board.js):
  --   { v: 1,
  --     view: 'kanban' | 'timeline' | 'feed',
  --     -- `color` is a bare design-token NAME ('good', 'warn', …), never
  --     -- raw CSS; the renderer wraps it as var(--<name>).
  --     columns: [{ name, statuses: [..], hidden, wip, color, cat }],
  --     hideUnmapped: bool,   -- drop statuses no column claims
  --     filter: 'all' | 'mine' | '<jira accountId>',
  --     types: [..], priorities: [..], labels: [..], query: '',
  --     swimlane: 'none' | 'assignee' | 'priority' | 'type',
  --     sort: 'default' | 'priority' | 'key' | 'summary' | 'assignee',
  --     card: { key, type, priority, labels, assignees, status } }
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The renderer's read path: "my views + the team's shared views, for the
-- project the board is on".
create index board_views_team_project_idx
  on public.board_views(team_id, project_key);
create index board_views_owner_idx
  on public.board_views(owner_id);

alter table public.board_views enable row level security;

-- Read: your own views always; everyone else's only once shared. The
-- team-membership gate applies to shared rows so a published view never
-- escapes the team.
create policy board_views_read on public.board_views
  for select to authenticated
  using (owner_id = auth.uid() or (shared and public.is_team_member(team_id)));

-- Write: only for yourself, and only inside a team you belong to. The
-- owner_id predicate is what keeps one member from planting a view in
-- someone else's list.
create policy board_views_insert on public.board_views
  for insert to authenticated
  with check (owner_id = auth.uid() and public.is_team_member(team_id));
create policy board_views_update on public.board_views
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());
create policy board_views_delete on public.board_views
  for delete to authenticated
  using (owner_id = auth.uid());

-- Stamp updated_at on every write, and pin the ownership/creation audit
-- columns on UPDATE so a view can't be re-homed to another user (or have
-- its created_at rewritten) by sending different values. auth.uid() is
-- null under the service role / server contexts — leave the supplied
-- values untouched there.
create or replace function public.touch_board_views()
returns trigger language plpgsql
set search_path = public as $$
begin
  new.updated_at = now();
  if tg_op = 'UPDATE' then
    new.owner_id = old.owner_id;
    new.created_at = old.created_at;
  end if;
  return new;
end;
$$;
create trigger board_views_touch
before insert or update on public.board_views
for each row execute function public.touch_board_views();

-- The renderer's realtime listener filters on team_id=eq.<team>. With the
-- default replica identity a DELETE payload carries only the primary key,
-- so it would never match that filter and a teammate would never see a
-- shared view disappear. The table is tiny (a handful of rows per person),
-- so the extra WAL is negligible.
alter table public.board_views replica identity full;

-- Realtime: postgres_changes is RLS-filtered per subscriber, so a private
-- view's changes only ever reach its owner; shared ones reach the team.
alter publication supabase_realtime add table public.board_views;
