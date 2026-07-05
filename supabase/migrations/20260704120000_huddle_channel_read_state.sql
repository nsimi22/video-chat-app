-- Per-user, per-channel read bookmark: when did this user last look at
-- this channel?
--
-- Before this table the app had exactly one durable read marker (the
-- global profiles.mentions_last_read_at bookmark) and kept per-channel
-- unread counts only in renderer memory, so every reload wiped them.
-- This table gives two things a real anchor:
--   - the /catchup AI digest ("everything since you last looked, per
--     channel") reads last_read_at as its per-channel window start;
--   - sidebar unread badges survive reloads (the renderer seeds
--     unread from messages newer than last_read_at at sign-in).
--
-- One row per (team, channel, user); the renderer upserts now() every
-- time the user views a channel while focused. Rows cascade with the
-- channel (and the user) so deletions don't strand bookmarks.

create table if not exists public.channel_read_state (
  team_id text not null,
  channel_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (team_id, channel_id, user_id),
  foreign key (team_id, channel_id) references public.channels(team_id, id) on delete cascade
);

-- The renderer always loads "all my bookmarks for this team" in one
-- query at sign-in and before a /catchup run.
create index if not exists channel_read_state_user_idx
  on public.channel_read_state(user_id, team_id);

alter table public.channel_read_state enable row level security;

-- Bookmarks are strictly personal: nobody can read (or infer) when a
-- teammate last viewed a channel.
create policy channel_read_state_read on public.channel_read_state for select to authenticated
  using (user_id = auth.uid());

-- Insert: own rows only, and only for channels the user can currently
-- see — a client can't plant bookmarks (and later read timestamps
-- back) for private channels it isn't a member of.
create policy channel_read_state_insert on public.channel_read_state for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.can_see_channel(team_id, channel_id)
  );

-- Update: only last_read_at ever moves; the identifying columns are the
-- PK. Owner-only on both sides.
create policy channel_read_state_update on public.channel_read_state for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy channel_read_state_delete on public.channel_read_state for delete to authenticated
  using (user_id = auth.uid());
