-- Close the DM read-leak via channel_members_insert_self.
--
-- The policy (from 20260506233100, extended by 20260513000000) has three OR
-- branches. Branch 1 — `user_id = auth.uid()` — is over-permissive: it lets
-- any team member self-insert into any channel given the id. For 1:1 DMs the
-- id is deterministic from the user pair via `public.dm_id(a, b)` and the
-- pair's UUIDs are readable through the open `profiles_read` policy, so a
-- third party C can construct `dm:A::B`, self-insert, and read the DM
-- history (channels_read / messages_read both gate on channel_members
-- membership, which C now satisfies).
--
-- Replace branch 1 with two narrower clauses:
--   1a. Self-join a `public` channel (the legitimate "join general / random"
--       flow).
--   1b. Self-insert into a 1:1 DM whose id encodes us as one of the two
--       parties. We use an anchored regex matching the exact output of
--       dm_id (`'dm:' || sorted_uuid_a::text || '::' || sorted_uuid_b::text`),
--       then extract the two UUIDs by fixed-offset substring (positions 4-39
--       and 42-77 — `::` is two chars at 40-41). Anchored regex prevents any
--       drift from dm_id from sneaking malformed ids past the check.
-- Branches 2 (creator-adds-anyone) and 3 (dm-member-adds-teammate) are kept
-- as-is.
--
-- The gdm "rejoin a channel I left" flow used to lean on branch 1; it now
-- routes through public.join_dm_by_member_sig (see below), which already
-- gates intent via `auth.uid() = any(string_to_array(sig, ','))`.
drop policy if exists channel_members_insert_self on public.channel_members;
create policy channel_members_insert_self on public.channel_members for insert to authenticated
  with check (
    public.is_team_member(team_id) and (
      -- 1a: self-join a public channel.
      (user_id = auth.uid()
       and exists (
         select 1 from public.channels c
         where c.team_id = channel_members.team_id
           and c.id = channel_members.channel_id
           and c.type = 'public'
       ))
      -- 1b: self-insert into a 1:1 DM whose id encodes us. Regex anchors
      -- shape; substring(...) at positions 4 and 42 extracts the two UUIDs.
      or (user_id = auth.uid()
       and channel_members.channel_id ~ '^dm:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}::[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and auth.uid()::text in (
         substring(channel_members.channel_id from 4 for 36),
         substring(channel_members.channel_id from 42 for 36)
       ))
      -- 2 (unchanged): creator may add anyone to the channel they made.
      or exists (
        select 1 from public.channels ch
        where ch.team_id = channel_members.team_id
          and ch.id = channel_members.channel_id
          and ch.created_by = auth.uid()
      )
      -- 3 (unchanged): a current member of a DM may add another teammate.
      or (
        public.is_channel_member(channel_members.team_id, channel_members.channel_id)
        and exists (
          select 1 from public.channels ch
          where ch.team_id = channel_members.team_id
            and ch.id = channel_members.channel_id
            and ch.type = 'dm'
        )
        and exists (
          select 1 from public.team_members tm
          where tm.team_id = channel_members.team_id
            and tm.user_id = channel_members.user_id
        )
      )
    )
  );

-- Replace find_dm_by_member_sig with join_dm_by_member_sig. The renderer's
-- "open a gdm I'm not currently a member of" flow used to do a lookup via
-- find_dm_by_member_sig and then self-insert through channel_members RLS
-- branch 1. With branch 1 narrowed, that self-insert no longer authorizes,
-- so we fold the lookup and the membership write into a single SECURITY
-- DEFINER call. The auth.uid()-in-sig gate (same one find_ enforced) is
-- still the intent check.
drop function if exists public.find_dm_by_member_sig(text, text);

create or replace function public.join_dm_by_member_sig(t text, sig text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid text;
begin
  if uid is null then return null; end if;
  -- Team-membership gate: SECURITY DEFINER bypasses channel_members_insert_self
  -- (which checks is_team_member as a precondition on every branch), so we
  -- have to enforce it ourselves. Without this, a user who was removed from
  -- the team but still holds a valid JWT could rejoin any gdm they were once
  -- a party to and read its history (channel_members membership unblocks
  -- can_see_channel for type='dm', which messages_read keys off).
  if not public.is_team_member(t) then return null; end if;
  -- Intent gate: caller must be a party to the requested sig. Without this
  -- a team member could brute-force teammate-UUID combinations and discover
  -- gdm ids they aren't in.
  if not (uid::text = any(string_to_array(sig, ','))) then return null; end if;
  select id into cid
    from public.channels
   where team_id = t and type = 'dm' and member_sig = sig
   limit 1;
  if cid is null then return null; end if;
  -- Self-insert atomically. ON CONFLICT covers "we're already a member"
  -- and "another tab won the race". SECURITY DEFINER bypasses the
  -- channel_members_insert_self check we just tightened, which is the
  -- whole point of the function.
  insert into public.channel_members (team_id, channel_id, user_id)
    values (t, cid, uid)
    on conflict do nothing;
  return cid;
end;
$$;
revoke all on function public.join_dm_by_member_sig(text, text) from public, anon;
grant execute on function public.join_dm_by_member_sig(text, text) to authenticated;
