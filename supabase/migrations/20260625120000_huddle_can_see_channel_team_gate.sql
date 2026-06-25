-- Tenant-isolation hardening for channel visibility.
--
-- The original `can_see_channel` returned TRUE for any channel of type
-- 'public' with NO team-membership check. "Public" means public *within a
-- team*, not public to every authenticated user — but because default
-- channels have predictable ids ('general'/'random'/'design') and team ids
-- are short enumerable slugs, this let any signed-in user reach another
-- team's public channels through every consumer that gates on
-- `can_see_channel`:
--   • messages_read / messages_insert  (read AND post into other teams)
--   • livekit-token edge fn            (mint a token, join the call)
--   • recording-egress edge fn         (start/stop recordings)
--   • realtime_broadcast + whiteboard/notes/strokes/frames policies
--
-- The fix gates the public branch on team membership. Members of the team
-- still see all of its public channels; non-members lose access they were
-- never supposed to have. Several call sites already carried a redundant
-- `is_team_member(team_id) AND can_see_channel(...)` belt-and-suspenders
-- guard for exactly this reason — those become harmless no-ops now.
--
-- `security definer stable` is preserved from the original definition.
create or replace function public.can_see_channel(t text, c text)
returns boolean language sql security definer stable as $$
  select coalesce(
    (select case when ch.type = 'public' then public.is_team_member(t)
                 else public.is_channel_member(t, c)
            end
       from public.channels ch
      where ch.team_id = t and ch.id = c),
    false
  );
$$;

-- Lock down message edits as well. `messages_update_own` only checked
-- author_id = auth.uid(), so an author could UPDATE their own row to
-- re-target team_id/channel_id into a channel they can't see (bypassing the
-- insert-time can_see_channel check), or flip ai_generated to forge a
-- recap/poll. Re-add the visibility check on both USING and WITH CHECK, and
-- pin the immutable columns to their prior values via a BEFORE UPDATE trigger.
drop policy if exists messages_update_own on public.messages;
create policy messages_update_own on public.messages for update to authenticated
  using (author_id = auth.uid() and public.can_see_channel(team_id, channel_id))
  with check (author_id = auth.uid() and public.can_see_channel(team_id, channel_id));

create or replace function public.messages_lock_immutable_cols()
returns trigger language plpgsql as $$
begin
  -- These define the message's identity/placement and must never change on
  -- an edit. Author edits may only touch body/attachments/edited_ts/etc.
  new.team_id      := old.team_id;
  new.channel_id   := old.channel_id;
  new.author_id    := old.author_id;
  new.ts           := old.ts;
  new.ai_generated := old.ai_generated;
  return new;
end;
$$;

drop trigger if exists messages_lock_immutable_cols on public.messages;
create trigger messages_lock_immutable_cols
  before update on public.messages
  for each row execute function public.messages_lock_immutable_cols();
