-- Group-DM dedup + creator-visibility fix.
--
-- Two related defects, both surfaced as "I see two gdms with the same set of
-- people but I only started one":
--
-- (a) channels_read.created_by keeps showing a DM to its creator even after
--     they've left it. That clause was added by 20260509120000 to work around
--     an RLS-with-RETURNING gotcha on private/dm INSERTs (the AFTER trigger
--     that adds the creator to channel_members fires after RETURNING runs).
--     The renderer now systematically avoids RETURNING on DM inserts
--     (createDm uses .upsert() without .select(); createGroupDm uses
--     .insert() without .select()), so the workaround is only needed for
--     type='private'. Restrict it accordingly: a creator who leaves a DM
--     should not keep seeing it in their sidebar.
--
-- (b) createGroupDm dedups against `_myChannelIds` (the renderer's cache of
--     channels we're currently a member of). The cache misses the case where
--     we previously left a matching gdm, and races with realtime updates on
--     double-clicks. There's no database-side guard, so a second `gdm:<uuid>`
--     can be inserted with the same participant set. Add a canonical member-
--     set signature column on channels + a partial unique index so duplicate
--     gdms fail with 23505, and a security-definer lookup so the renderer can
--     find a matching gdm even when RLS would hide it.

-- (a) ----------------------------------------------------------------------
drop policy if exists channels_read on public.channels;
create policy channels_read on public.channels for select to authenticated
  using (
    public.is_team_member(team_id) and (
      type = 'public'
      or public.is_channel_member(team_id, id)
      or (created_by = auth.uid() and type <> 'dm')
    )
  );

-- (b) ----------------------------------------------------------------------
-- Canonical signature for DM-type channels: sorted user_ids of the original
-- member set, joined by commas. Set by the renderer at create time; not
-- maintained on join/leave (the sig identifies the conversation's original
-- participants, so "DM these same people" reopens the existing gdm even
-- after someone has left, which is the behaviour every chat app users
-- expect).
alter table public.channels add column if not exists member_sig text;

-- Backfill for rows that pre-date this migration. Best-effort: we don't have
-- a membership-history table, so the sig here is computed from the *current*
-- channel_members snapshot rather than the original participant set. For
-- legacy gdms whose membership has churned (someone added or removed via
-- addDmMembers / leaveDmChannel) this can diverge from the "original
-- participants" semantics new rows use — concretely, a legacy gdm grown
-- past its original set won't match a future createGroupDm call on the
-- expanded set and could be duplicated. The dedup constraint still holds
-- among all new gdms, and the legacy footprint is small.
--
-- Where multiple existing channels have the same current member set (the
-- bug this migration prevents from recurring), keep the oldest as the
-- canonical and leave the rest with NULL member_sig — the partial unique
-- index below ignores NULLs, so the losers stay legal but won't be found
-- by the dedup lookup.
with channel_sigs as (
  select team_id, channel_id,
         string_agg(user_id::text, ',' order by user_id::text) as sig
    from public.channel_members
   group by team_id, channel_id
),
ranked as (
  select cs.team_id, cs.channel_id, cs.sig,
         row_number() over (partition by c.team_id, cs.sig order by c.created_at) as rn
    from channel_sigs cs
    join public.channels c
      on c.team_id = cs.team_id and c.id = cs.channel_id
   where c.type = 'dm'
)
update public.channels c
   set member_sig = r.sig
  from ranked r
 where c.team_id = r.team_id and c.id = r.channel_id and r.rn = 1;

create unique index if not exists channels_dm_member_sig_uq
  on public.channels (team_id, member_sig)
  where type = 'dm' and member_sig is not null;

-- Lookup helper: returns the channel id whose member_sig matches.
-- SECURITY DEFINER on purpose — the renderer needs to find a matching gdm
-- even when the caller isn't currently in channel_members (e.g. they left
-- and now want to "DM these same people" again), which the channels_read
-- USING clause would otherwise block.
--
-- Gate: the caller's auth.uid() must appear in the requested sig. Without
-- this, a team member could enumerate teammate UUIDs (profiles_read is
-- open to all authenticated callers) and brute-force sorted UUID
-- combinations to discover gdm channel ids they aren't a party to, then
-- self-insert via channel_members_insert_self.user_id = auth.uid() and
-- read the history. With the gate, the lookup only resolves DMs the
-- caller is part of by construction, so it can't be used to escalate
-- visibility beyond what the caller would already see via channels_read
-- when they are/were a member.
create or replace function public.find_dm_by_member_sig(t text, sig text)
returns text
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then return null; end if;
  if not (uid::text = any(string_to_array(sig, ','))) then return null; end if;
  return (
    select id
      from public.channels
     where team_id = t and type = 'dm' and member_sig = sig
     limit 1
  );
end;
$$;
revoke all on function public.find_dm_by_member_sig(text, text) from public, anon;
grant execute on function public.find_dm_by_member_sig(text, text) to authenticated;
