-- Sticky notes on the whiteboard. One row per note; position is stored
-- as fractional canvas coordinates (0..1) so the same note renders
-- consistently across viewers with different tile sizes — same scheme
-- the drawing layer uses for stroke points.
--
-- Updates (text edits, drag-moves) overwrite the row in place via
-- author_id-gated UPDATE; deletes are gated to the author OR any
-- channel member, matching how strokes_delete is permissive.

create table public.whiteboard_notes (
  id uuid primary key default gen_random_uuid(),
  whiteboard_id uuid not null references public.whiteboards(id) on delete cascade,
  team_id text not null,
  channel_id text not null,
  author_id uuid references auth.users(id) on delete set null,
  -- Fractional position (0..1) and size; multiplied by the tile's
  -- bounding rect at render time.
  x double precision not null check (x >= 0 and x <= 1),
  y double precision not null check (y >= 0 and y <= 1),
  w double precision not null default 0.18 check (w > 0 and w <= 1),
  h double precision not null default 0.18 check (h > 0 and h <= 1),
  text text not null default '' check (char_length(text) <= 2000),
  color text not null default '#ffd866',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (team_id, channel_id) references public.channels(team_id, id) on delete cascade
);
create index whiteboard_notes_board_idx on public.whiteboard_notes(whiteboard_id, created_at);

alter table public.whiteboard_notes enable row level security;

create policy notes_read on public.whiteboard_notes for select to authenticated
  using (public.can_see_channel(team_id, channel_id));
create policy notes_insert on public.whiteboard_notes for insert to authenticated
  with check (author_id = auth.uid() and public.can_see_channel(team_id, channel_id));
-- Anyone in the channel can move/edit a note (collaborative whiteboard
-- model — same permissiveness as strokes_delete).
create policy notes_update on public.whiteboard_notes for update to authenticated
  using (public.can_see_channel(team_id, channel_id))
  with check (public.can_see_channel(team_id, channel_id));
create policy notes_delete on public.whiteboard_notes for delete to authenticated
  using (public.can_see_channel(team_id, channel_id));
