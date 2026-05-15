-- Scheduled calls: per-team agenda of upcoming Huddle calls. Each row
-- ties a calendar event (title, starts_at, duration) to a specific
-- channel; any team member sees the team's full schedule even if they
-- aren't a member of the target channel (useful for "team agenda"
-- visibility — they still can't join unless they have channel access).
-- The renderer pairs this with its own ICS-subscription cache so a
-- unified "Upcoming" view can include both internal scheduled Huddles
-- and external calendar events the user has subscribed to.

create table if not exists public.scheduled_calls (
  id uuid primary key default gen_random_uuid(),
  team_id text not null references public.teams(id) on delete cascade,
  channel_id text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  title text not null check (length(title) between 1 and 200),
  description text not null default '',
  starts_at timestamptz not null,
  duration_min int not null default 30 check (duration_min > 0 and duration_min <= 1440),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (team_id, channel_id) references public.channels(team_id, id) on delete cascade
);

create index if not exists scheduled_calls_team_starts_idx
  on public.scheduled_calls(team_id, starts_at);
create index if not exists scheduled_calls_channel_starts_idx
  on public.scheduled_calls(team_id, channel_id, starts_at);

alter table public.scheduled_calls enable row level security;

-- Read: any team member sees the team's schedule, regardless of which
-- channel the call is in. People often need to see the full agenda
-- even for channels they're not a member of (the row only exposes
-- title + time + channel name; private channel content stays gated).
create policy scheduled_calls_read on public.scheduled_calls for select to authenticated
  using (
    exists (
      select 1 from public.team_members tm
      where tm.team_id = scheduled_calls.team_id and tm.user_id = auth.uid()
    )
  );

-- Insert: must be a team member, must be self-attributed, and must
-- have access to the target channel (no scheduling into private
-- channels you're not in — the channel-list dropdown in the renderer
-- already filters these out, this is the server-side belt).
create policy scheduled_calls_insert on public.scheduled_calls for insert to authenticated
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.team_members tm
      where tm.team_id = scheduled_calls.team_id and tm.user_id = auth.uid()
    )
    and public.can_see_channel(team_id, channel_id)
  );

-- Update / delete: owner AND still a team member. A user removed
-- from the team shouldn't be able to retroactively edit / cancel a
-- call they scheduled while they were a member. Title/time edits
-- flip the updated_at via the trigger below so a future ICS-export
-- with sequence numbers can spot revisions.
create policy scheduled_calls_update on public.scheduled_calls for update to authenticated
  using (
    created_by = auth.uid()
    and exists (
      select 1 from public.team_members tm
      where tm.team_id = scheduled_calls.team_id and tm.user_id = auth.uid()
    )
  )
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.team_members tm
      where tm.team_id = scheduled_calls.team_id and tm.user_id = auth.uid()
    )
  );

create policy scheduled_calls_delete on public.scheduled_calls for delete to authenticated
  using (
    created_by = auth.uid()
    and exists (
      select 1 from public.team_members tm
      where tm.team_id = scheduled_calls.team_id and tm.user_id = auth.uid()
    )
  );

-- Realtime: postgres_changes filtered by RLS. Members of the team get
-- live updates as schedules are added / removed; non-members never
-- see the row mutations.
alter publication supabase_realtime add table public.scheduled_calls;

create or replace function public.touch_scheduled_calls_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end$$;

drop trigger if exists scheduled_calls_touch on public.scheduled_calls;
create trigger scheduled_calls_touch
  before update on public.scheduled_calls
  for each row execute function public.touch_scheduled_calls_updated_at();
