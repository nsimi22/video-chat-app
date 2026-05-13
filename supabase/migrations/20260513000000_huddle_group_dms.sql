-- Group DMs: let any existing member of a DM channel add more people to it.
--
-- A "group DM" is just a `type = 'dm'` channel with 3+ rows in
-- channel_members and a non-pair id (`gdm:<uuid>` instead of
-- `dm:<uuid_a>::<uuid_b>`). Everything else — visibility (`can_see_channel`),
-- message RLS, realtime topics, calls — already keys off membership and has no
-- two-person assumption, so creating a group DM works under the existing
-- policies (the creator can already seed members at creation time).
--
-- The one gap is *adding people after creation*: the old
-- `channel_members_insert_self` only let you add yourself, or — if you created
-- the channel — anyone. For group DMs we want any current member to be able to
-- pull in another teammate. Add that branch; the channel must be a DM (so
-- private channels stay creator-managed) and the new user must already be on
-- the team. The first two branches below are unchanged from the initial schema.

drop policy if exists channel_members_insert_self on public.channel_members;
create policy channel_members_insert_self on public.channel_members for insert to authenticated
  with check (
    public.is_team_member(team_id) and (
      user_id = auth.uid()
      or exists (
        select 1 from public.channels ch
        where ch.team_id = team_id and ch.id = channel_id and ch.created_by = auth.uid()
      )
      -- New: any current member of a DM channel may add another teammate to it.
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
