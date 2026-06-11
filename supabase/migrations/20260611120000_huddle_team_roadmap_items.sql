-- Ad-hoc roadmap items: team-shared bars on the board's roadmap/timeline
-- view that are NOT Jira issues — ideas and deliverables the team adds on
-- the fly ("add a bar anywhere"). Jira epics render alongside these from
-- the live API; only the ad-hoc items need persistence, so this table is
-- intentionally small and team-editable (any member may add/edit/remove,
-- mirroring team_jira_board's "any member can set it" model — a shared
-- planning surface, not per-owner content).
create table public.team_roadmap_items (
  id uuid primary key default gen_random_uuid(),
  team_id text not null references public.teams(id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  -- Both dates optional: null start = undated (sorts last), null end =
  -- open-ended bar. The renderer treats date-less items like Jira epics
  -- without a due date ("unscheduled" treatment) rather than hiding them.
  start_date date,
  end_date date,
  -- Optional accent token name (e.g. 'accent-2'); the renderer falls back
  -- to its default ad-hoc styling when null/unknown.
  color text,
  notes text,
  -- Stamped server-side by the trigger below from auth.uid(); clients
  -- don't send either.
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_date is null or end_date is null or end_date >= start_date)
);

create index team_roadmap_items_team_idx
  on public.team_roadmap_items(team_id, start_date);

alter table public.team_roadmap_items enable row level security;

-- Any team member may read / add / edit / remove items. Attribution
-- (created_by / updated_by) is stamped server-side by the trigger below
-- from auth.uid(), so it's deliberately kept out of WITH CHECK: enforcing
-- `updated_by = auth.uid()` here would reject an UPDATE that doesn't
-- re-send the column, and keeping the check to just membership makes it
-- independent of trigger ordering (same rationale as team_jira_board).
create policy team_roadmap_items_read on public.team_roadmap_items
  for select to authenticated using (public.is_team_member(team_id));
create policy team_roadmap_items_insert on public.team_roadmap_items
  for insert to authenticated
  with check (public.is_team_member(team_id));
create policy team_roadmap_items_update on public.team_roadmap_items
  for update to authenticated
  using (public.is_team_member(team_id))
  with check (public.is_team_member(team_id));
create policy team_roadmap_items_delete on public.team_roadmap_items
  for delete to authenticated using (public.is_team_member(team_id));

-- Stamp updated_at and the writer's id on every write; stamp created_by
-- once on insert. auth.uid() is null under the service role / server
-- contexts — leave any supplied value untouched there.
create or replace function public.touch_team_roadmap_items()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  if auth.uid() is not null then
    new.updated_by = auth.uid();
    if tg_op = 'INSERT' then
      new.created_by = auth.uid();
    end if;
  end if;
  return new;
end;
$$;
create trigger team_roadmap_items_touch
before insert or update on public.team_roadmap_items
for each row execute function public.touch_team_roadmap_items();

-- The renderer's realtime listener filters on team_id=eq.<team>. With the
-- default replica identity, DELETE payloads carry only the primary key, so
-- they'd never match the filter and teammates would never see a bar removed
-- live. Full replica identity puts team_id in the old-row image; the table
-- is tiny (dozens of rows per team) so the WAL cost is negligible.
alter table public.team_roadmap_items replica identity full;

-- Realtime: postgres_changes filtered by RLS — team members get live
-- updates as bars are added / edited / removed.
alter publication supabase_realtime add table public.team_roadmap_items;
