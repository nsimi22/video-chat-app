-- One whiteboard per (team, channel) — created lazily the first time anyone
-- opens it. Strokes are stored as completed polylines (a stroke = begin →
-- moves → end, captured client-side and persisted on stroke end so we don't
-- spam the DB at 60 Hz). On open, the renderer fetches all strokes and
-- replays them through the same DrawingLayer used for screen annotations.
create table public.whiteboards (
  id uuid primary key default gen_random_uuid(),
  team_id text not null,
  channel_id text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (team_id, channel_id) references public.channels(team_id, id) on delete cascade,
  unique (team_id, channel_id)
);

create table public.whiteboard_strokes (
  id bigserial primary key,
  whiteboard_id uuid not null references public.whiteboards(id) on delete cascade,
  team_id text not null,
  channel_id text not null,
  author_id uuid references auth.users(id) on delete set null,
  -- Polyline shape: {tool, color, size, points: [[x,y], ...]}.
  -- "clear" markers also live here as {action: 'clear'}.
  data jsonb not null,
  created_at timestamptz not null default now()
);
create index whiteboard_strokes_board_idx on public.whiteboard_strokes(whiteboard_id, id);

alter table public.whiteboards enable row level security;
alter table public.whiteboard_strokes enable row level security;

create policy whiteboards_read on public.whiteboards for select to authenticated
  using (public.can_see_channel(team_id, channel_id));
create policy whiteboards_insert on public.whiteboards for insert to authenticated
  with check (public.can_see_channel(team_id, channel_id) and created_by = auth.uid());
create policy whiteboards_delete on public.whiteboards for delete to authenticated
  using (created_by = auth.uid() or public.is_team_member(team_id));

create policy strokes_read on public.whiteboard_strokes for select to authenticated
  using (public.can_see_channel(team_id, channel_id));
create policy strokes_insert on public.whiteboard_strokes for insert to authenticated
  with check (author_id = auth.uid() and public.can_see_channel(team_id, channel_id));
-- Anyone in the channel can clear (delete strokes); matches the existing
-- model where any team member can use the canvas.
create policy strokes_delete on public.whiteboard_strokes for delete to authenticated
  using (public.can_see_channel(team_id, channel_id));

-- Allow the realtime broadcast topic `whiteboard:<uuid>` for live strokes.
drop policy if exists realtime_broadcast_read on realtime.messages;
drop policy if exists realtime_broadcast_write on realtime.messages;
create policy realtime_broadcast_read on realtime.messages for select to authenticated using (
  (realtime.topic() ~ '^team:[a-z0-9_-]+$' and public.is_team_member(substring(realtime.topic() from 6)))
  or realtime.topic() like 'screen:%'
  or realtime.topic() like 'whiteboard:%'
);
create policy realtime_broadcast_write on realtime.messages for insert to authenticated with check (
  (realtime.topic() ~ '^team:[a-z0-9_-]+$' and public.is_team_member(substring(realtime.topic() from 6)))
  or realtime.topic() like 'screen:%'
  or realtime.topic() like 'whiteboard:%'
);
