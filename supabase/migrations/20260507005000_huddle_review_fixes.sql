-- Review feedback (Copilot review on PR #1) — bundled DB-side fixes.

-- (4) whiteboards_delete: don't let team members outside a private channel
--     delete its whiteboard. Restrict to the creator who can also still see
--     the channel.
drop policy if exists whiteboards_delete on public.whiteboards;
create policy whiteboards_delete on public.whiteboards for delete to authenticated
  using (created_by = auth.uid() and public.can_see_channel(team_id, channel_id));

-- (5) whiteboard_strokes had redundant team_id/channel_id columns that
--     weren't constrained to match the referenced whiteboard. A client
--     could insert strokes whose team/channel they could see while
--     pointing whiteboard_id at someone else's board. Drop the redundant
--     columns and rebase the policies on a JOIN to whiteboards.
drop policy if exists strokes_read on public.whiteboard_strokes;
drop policy if exists strokes_insert on public.whiteboard_strokes;
drop policy if exists strokes_delete on public.whiteboard_strokes;

alter table public.whiteboard_strokes drop column if exists team_id;
alter table public.whiteboard_strokes drop column if exists channel_id;

create policy strokes_read on public.whiteboard_strokes for select to authenticated
  using (exists (
    select 1 from public.whiteboards w
    where w.id = whiteboard_strokes.whiteboard_id
      and public.can_see_channel(w.team_id, w.channel_id)
  ));
create policy strokes_insert on public.whiteboard_strokes for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.whiteboards w
      where w.id = whiteboard_strokes.whiteboard_id
        and public.can_see_channel(w.team_id, w.channel_id)
    )
  );
create policy strokes_delete on public.whiteboard_strokes for delete to authenticated
  using (exists (
    select 1 from public.whiteboards w
    where w.id = whiteboard_strokes.whiteboard_id
      and public.can_see_channel(w.team_id, w.channel_id)
  ));

-- (6) Realtime broadcast: gate `whiteboard:*` traffic on team membership by
--     putting whiteboards inside the existing `team:<id>:*` namespace.
--     Also future-proof: any sub-topic under `team:<id>:*` is allowed iff
--     the user is a member of <id>. Drops reliance on UUID secrecy.
drop policy if exists realtime_broadcast_read on realtime.messages;
drop policy if exists realtime_broadcast_write on realtime.messages;
create policy realtime_broadcast_read on realtime.messages for select to authenticated using (
  case
    when realtime.topic() ~ '^team:[a-z0-9_-]+(:|$)' then
      public.is_team_member(substring(realtime.topic() from '^team:([a-z0-9_-]+)'))
    when realtime.topic() like 'screen:%' then true
    else false
  end
);
create policy realtime_broadcast_write on realtime.messages for insert to authenticated with check (
  case
    when realtime.topic() ~ '^team:[a-z0-9_-]+(:|$)' then
      public.is_team_member(substring(realtime.topic() from '^team:([a-z0-9_-]+)'))
    when realtime.topic() like 'screen:%' then true
    else false
  end
);

-- (7) messages.author_name / author_color are client-supplied. A trusted
--     trigger overrides them with the values from the user's profile so a
--     malicious client can't spoof someone else's identity.
create or replace function public.set_message_author_from_profile()
returns trigger language plpgsql security definer as $$
declare
  prof record;
begin
  select name, color into prof from public.profiles where user_id = new.author_id;
  if prof.name is not null then
    new.author_name := prof.name;
    new.author_color := prof.color;
  end if;
  return new;
end;
$$;

drop trigger if exists messages_set_author_before_insert on public.messages;
drop trigger if exists messages_set_author_before_update on public.messages;
create trigger messages_set_author_before_insert
before insert on public.messages
for each row execute function public.set_message_author_from_profile();
create trigger messages_set_author_before_update
before update on public.messages
for each row execute function public.set_message_author_from_profile();
