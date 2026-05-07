-- Per Copilot review on PR #22: whiteboard_notes inherited the same
-- redundant team_id/channel_id columns + client-trusted RLS that was
-- already fixed for whiteboard_strokes in
-- 20260507005000_huddle_review_fixes.sql. Mirror that fix here:
-- drop the extra columns and rebase RLS on an EXISTS join to the
-- parent whiteboards row, which is the actual source of truth for
-- channel membership.

drop policy if exists notes_read on public.whiteboard_notes;
drop policy if exists notes_insert on public.whiteboard_notes;
drop policy if exists notes_update on public.whiteboard_notes;
drop policy if exists notes_delete on public.whiteboard_notes;

alter table public.whiteboard_notes drop column if exists team_id;
alter table public.whiteboard_notes drop column if exists channel_id;

create policy notes_read on public.whiteboard_notes for select to authenticated
  using (exists (
    select 1 from public.whiteboards w
    where w.id = whiteboard_notes.whiteboard_id
      and public.can_see_channel(w.team_id, w.channel_id)
  ));
create policy notes_insert on public.whiteboard_notes for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.whiteboards w
      where w.id = whiteboard_notes.whiteboard_id
        and public.can_see_channel(w.team_id, w.channel_id)
    )
  );
create policy notes_update on public.whiteboard_notes for update to authenticated
  using (exists (
    select 1 from public.whiteboards w
    where w.id = whiteboard_notes.whiteboard_id
      and public.can_see_channel(w.team_id, w.channel_id)
  ))
  with check (exists (
    select 1 from public.whiteboards w
    where w.id = whiteboard_notes.whiteboard_id
      and public.can_see_channel(w.team_id, w.channel_id)
  ));
create policy notes_delete on public.whiteboard_notes for delete to authenticated
  using (exists (
    select 1 from public.whiteboards w
    where w.id = whiteboard_notes.whiteboard_id
      and public.can_see_channel(w.team_id, w.channel_id)
  ));
