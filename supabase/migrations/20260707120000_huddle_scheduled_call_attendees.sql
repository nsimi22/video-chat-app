-- RSVPs for scheduled calls. Open-RSVP model: any team member who can
-- see the underlying call (i.e. passes scheduled_calls_read) may set
-- their own going / maybe / declined status. There is no separate
-- invitee list — a row exists only once a user has actually responded,
-- which keeps the attendee set == the people who engaged with the event.
--
-- Visibility deliberately mirrors scheduled_calls: an RSVP on a call in
-- a private channel is only visible to people who can see that channel,
-- so "who's coming to the leadership sync" never leaks to the wider team.

create table if not exists public.scheduled_call_attendees (
  call_id uuid not null references public.scheduled_calls(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'going' check (status in ('going', 'maybe', 'declined')),
  responded_at timestamptz not null default now(),
  primary key (call_id, user_id)
);

create index if not exists scheduled_call_attendees_call_idx
  on public.scheduled_call_attendees(call_id);

alter table public.scheduled_call_attendees enable row level security;

-- Read: anyone who can see the underlying call can see who's responded.
-- The is_team_member guard matters because can_see_channel returns true
-- for any public channel regardless of team membership (same reasoning
-- as scheduled_calls_read).
create policy scheduled_call_attendees_read on public.scheduled_call_attendees
  for select to authenticated
  using (
    exists (
      select 1 from public.scheduled_calls sc
      where sc.id = scheduled_call_attendees.call_id
        and public.is_team_member(sc.team_id)
        and public.can_see_channel(sc.team_id, sc.channel_id)
    )
  );

-- Insert: only your own row, and only for a call you can see. Mirrors
-- the scheduled_calls_insert channel-access belt so you can't RSVP into
-- a private channel you're not a member of.
create policy scheduled_call_attendees_insert on public.scheduled_call_attendees
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.scheduled_calls sc
      where sc.id = scheduled_call_attendees.call_id
        and public.is_team_member(sc.team_id)
        and public.can_see_channel(sc.team_id, sc.channel_id)
    )
  );

-- Update / delete: only your own RSVP. (Re-checking channel access on
-- update/delete isn't necessary — you can always retract or amend your
-- own response even if you've since lost channel access.)
create policy scheduled_call_attendees_update on public.scheduled_call_attendees
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy scheduled_call_attendees_delete on public.scheduled_call_attendees
  for delete to authenticated
  using (user_id = auth.uid());

-- Realtime: RLS-filtered postgres_changes so an open drawer repaints as
-- teammates RSVP. Only rows the viewer can select are delivered.
alter publication supabase_realtime add table public.scheduled_call_attendees;

-- Bump responded_at whenever a status changes (going -> maybe, etc.) so
-- the client can order / show "last responded" without trusting a
-- client-sent timestamp.
create or replace function public.touch_scheduled_call_attendees_responded_at()
returns trigger language plpgsql as $$
begin
  new.responded_at := now();
  return new;
end$$;

drop trigger if exists scheduled_call_attendees_touch on public.scheduled_call_attendees;
create trigger scheduled_call_attendees_touch
  before update on public.scheduled_call_attendees
  for each row execute function public.touch_scheduled_call_attendees_responded_at();
