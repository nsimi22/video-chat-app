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
--
-- Implemented as a single EXISTS rather than delegating to
-- is_team_member/is_channel_member: those helpers are themselves SECURITY
-- DEFINER (non-inlinable), so calling them per row inside an RLS-gated scan
-- added a nested context switch for every candidate message. Running with
-- definer rights here we can read team_members/channel_members directly. The
-- membership predicates below are the same as those helpers' bodies
-- (verified against the initial schema).
create or replace function public.can_see_channel(t text, c text)
returns boolean language sql security definer stable
set search_path = public as $$
  select exists (
    select 1
      from public.channels ch
     where ch.team_id = t
       and ch.id = c
       and case
             when ch.type = 'public' then exists (
               select 1 from public.team_members tm
                where tm.team_id = t and tm.user_id = auth.uid()
             )
             else exists (
               select 1 from public.channel_members cm
                where cm.team_id = t and cm.channel_id = c and cm.user_id = auth.uid()
             )
           end
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
returns trigger language plpgsql
set search_path = public as $$
begin
  -- These define the message's identity/placement and provenance and must
  -- never change on an edit. Author edits may only touch
  -- body/attachments/edited_ts/reactions/meta/pinned_*.
  new.id           := old.id;           -- primary key
  new.team_id      := old.team_id;
  new.channel_id   := old.channel_id;
  new.parent_id    := old.parent_id;    -- can't re-thread or de-thread a message
  new.author_id    := old.author_id;
  -- author_name/author_color are denormalized author snapshots; leaving them
  -- writable let an author relabel their own message to impersonate someone
  -- else even with author_id pinned.
  new.author_name  := old.author_name;
  new.author_color := old.author_color;
  new.ts           := old.ts;
  new.ai_generated := old.ai_generated;
  return new;
end;
$$;

drop trigger if exists messages_lock_immutable_cols on public.messages;
create trigger messages_lock_immutable_cols
  before update on public.messages
  for each row execute function public.messages_lock_immutable_cols();
