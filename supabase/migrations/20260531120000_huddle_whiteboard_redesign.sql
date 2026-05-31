-- Whiteboard redesign: sticky-note voting + titled frames.
--
-- 1. Add an upvote model to whiteboard_notes. A simple `votes` integer
--    plus a `voted_by` text[] of user-id strings — same shape we use
--    for message reactions in lighter-weight tables. Keeping the count
--    denormalised in `votes` avoids a join on every render; the array
--    is the source of truth for "did the current user vote already?"
--    so the client can render the filled / hollow vote arrow without
--    a second roundtrip.
--
--    Also introduce a `color_key` slug ("butter" / "rose" / "sky" /
--    "mint" / "lilac") for the new pastel sticky palette. The legacy
--    `color` hex column stays so older clients keep rendering — the
--    new client prefers `color_key` when present and falls back to
--    `color` otherwise.
--
-- 2. New `whiteboard_frames` table — titled background regions on the
--    canvas ("Permissions", "Chat polish", etc. in the design). RLS
--    mirrors the whiteboard_notes pattern: visible to anyone who can
--    see the channel, writable by anyone in the channel (same
--    collaborative permissiveness as strokes/notes).

-- Sticky-note voting
alter table public.whiteboard_notes
  add column if not exists votes integer not null default 0 check (votes >= 0),
  add column if not exists voted_by text[] not null default '{}'::text[],
  add column if not exists color_key text;

create index if not exists whiteboard_notes_voted_by_idx
  on public.whiteboard_notes using gin (voted_by);

-- Titled frames (background regions). Coords are world units, same
-- system as whiteboard_strokes + whiteboard_notes post-infinite-canvas
-- migration (~ 1 unit = 1 px at scale 1).
create table if not exists public.whiteboard_frames (
  id uuid primary key default gen_random_uuid(),
  whiteboard_id uuid not null references public.whiteboards(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  x double precision not null,
  y double precision not null,
  w double precision not null check (w > 0),
  h double precision not null check (h > 0),
  title text not null default '' check (char_length(title) <= 200),
  -- One of the design's tint slugs (accent / live / online / away)
  -- or a hex string. The client knows how to render either.
  tint text not null default 'accent',
  dashed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists whiteboard_frames_board_idx
  on public.whiteboard_frames(whiteboard_id, created_at);

alter table public.whiteboard_frames enable row level security;

create policy frames_read on public.whiteboard_frames for select to authenticated
  using (exists (
    select 1 from public.whiteboards w
    where w.id = whiteboard_frames.whiteboard_id
      and public.can_see_channel(w.team_id, w.channel_id)
  ));
create policy frames_insert on public.whiteboard_frames for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.whiteboards w
      where w.id = whiteboard_frames.whiteboard_id
        and public.can_see_channel(w.team_id, w.channel_id)
    )
  );
create policy frames_update on public.whiteboard_frames for update to authenticated
  using (exists (
    select 1 from public.whiteboards w
    where w.id = whiteboard_frames.whiteboard_id
      and public.can_see_channel(w.team_id, w.channel_id)
  ))
  with check (exists (
    select 1 from public.whiteboards w
    where w.id = whiteboard_frames.whiteboard_id
      and public.can_see_channel(w.team_id, w.channel_id)
  ));
create policy frames_delete on public.whiteboard_frames for delete to authenticated
  using (exists (
    select 1 from public.whiteboards w
    where w.id = whiteboard_frames.whiteboard_id
      and public.can_see_channel(w.team_id, w.channel_id)
  ));

-- Toggle-vote RPC. Adding/removing a vote in one round-trip keeps the
-- count denormalised correctly without a read-modify-write race.
-- Returns the new vote count + whether the caller currently has a
-- vote on this note so the client can render its toggled state.
create or replace function public.toggle_whiteboard_note_vote(p_note_id uuid)
returns table (votes integer, mine boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid text := auth.uid()::text;
  v_now_voted boolean;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'auth required';
  end if;

  -- Atomic toggle: array_remove if present else array_append, with a
  -- corresponding count delta. Single UPDATE so the row is locked for
  -- the duration of the read-modify-write.
  update public.whiteboard_notes n
  set
    voted_by = case
      when v_uid = any(n.voted_by) then array_remove(n.voted_by, v_uid)
      else array_append(n.voted_by, v_uid)
    end,
    votes = case
      when v_uid = any(n.voted_by) then greatest(0, n.votes - 1)
      else n.votes + 1
    end,
    updated_at = now()
  where n.id = p_note_id
    and exists (
      select 1 from public.whiteboards w
      where w.id = n.whiteboard_id
        and public.can_see_channel(w.team_id, w.channel_id)
    )
  returning (v_uid = any(voted_by)), n.votes
    into v_now_voted, v_count;

  if v_count is null then
    raise exception 'note not found or not visible';
  end if;

  votes := v_count;
  mine := v_now_voted;
  return next;
end;
$$;

grant execute on function public.toggle_whiteboard_note_vote(uuid) to authenticated;
