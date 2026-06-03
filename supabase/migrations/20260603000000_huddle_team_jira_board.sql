-- Shared, team-wide Jira board config. One row per team naming the Jira
-- project the team's board tracks, so everyone in the team sees the same
-- board instead of each user picking their own.
--
-- Per-user Jira *credentials* stay private in public.user_integrations
-- (RLS-locked to the owner). This table holds only the shared *selection*
-- (which project / board / column order) — not sensitive — so any team
-- member can read or set it, mirroring how any member can create channels.
--
-- The renderer keeps user_integrations.settings.jira.defaultProject as a
-- per-user fallback; a row here, when present, takes precedence.
create table public.team_jira_board (
  team_id text primary key references public.teams(id) on delete cascade,
  -- Jira project key (e.g. "HUD"). Bare key, not an issue key.
  project_key text not null check (length(project_key) between 1 and 60),
  -- Optional Jira site host (e.g. "acme.atlassian.net"), for display only;
  -- the authoritative host per user lives in their credential row.
  site text,
  -- Optional human label for the board (e.g. "HUD Sprint 24").
  board_name text,
  -- Optional pinned column mapping/order. Empty array = derive columns
  -- from the issues' live statuses (the current renderer behavior). Stored
  -- as JSONB so a team can pin columns later without another migration.
  columns jsonb not null default '[]'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.team_jira_board enable row level security;

-- Any team member may read the shared board config.
create policy team_jira_board_read on public.team_jira_board
  for select to authenticated using (public.is_team_member(team_id));

-- Any team member may set / replace it; updated_by must be the caller so
-- the "last edited by" attribution can't be spoofed.
create policy team_jira_board_insert on public.team_jira_board
  for insert to authenticated
  with check (public.is_team_member(team_id) and updated_by = auth.uid());
create policy team_jira_board_update on public.team_jira_board
  for update to authenticated
  using (public.is_team_member(team_id))
  with check (public.is_team_member(team_id) and updated_by = auth.uid());
create policy team_jira_board_delete on public.team_jira_board
  for delete to authenticated using (public.is_team_member(team_id));

-- Keep updated_at fresh on every write (mirrors touch_user_integrations).
create or replace function public.touch_team_jira_board()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger team_jira_board_touch
before update on public.team_jira_board
for each row execute function public.touch_team_jira_board();
