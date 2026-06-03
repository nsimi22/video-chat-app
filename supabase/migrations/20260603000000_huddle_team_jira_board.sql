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
  columns jsonb not null default '[]'::jsonb check (jsonb_typeof(columns) = 'array'),
  -- Stamped server-side by the trigger below from auth.uid(); clients
  -- don't need to send it.
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.team_jira_board enable row level security;

-- Any team member may read the shared board config.
create policy team_jira_board_read on public.team_jira_board
  for select to authenticated using (public.is_team_member(team_id));

-- Any team member may set / replace it. Attribution (updated_by) is stamped
-- server-side by the trigger below from auth.uid(), so it's deliberately
-- kept out of WITH CHECK: enforcing `updated_by = auth.uid()` here would
-- reject an UPDATE that doesn't re-send the column (the row would keep the
-- previous writer's id and fail the check). Keeping the check to just
-- membership also makes it independent of trigger ordering.
create policy team_jira_board_insert on public.team_jira_board
  for insert to authenticated
  with check (public.is_team_member(team_id));
create policy team_jira_board_update on public.team_jira_board
  for update to authenticated
  using (public.is_team_member(team_id))
  with check (public.is_team_member(team_id));
create policy team_jira_board_delete on public.team_jira_board
  for delete to authenticated using (public.is_team_member(team_id));

-- Stamp updated_at and the writer's id on every write. Sourcing updated_by
-- from auth.uid() server-side keeps attribution accurate and unspoofable
-- without the client having to send it. auth.uid() is null under the
-- service role / server contexts — leave any supplied value untouched there.
create or replace function public.touch_team_jira_board()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  if auth.uid() is not null then
    new.updated_by = auth.uid();
  end if;
  return new;
end;
$$;
create trigger team_jira_board_touch
before insert or update on public.team_jira_board
for each row execute function public.touch_team_jira_board();
