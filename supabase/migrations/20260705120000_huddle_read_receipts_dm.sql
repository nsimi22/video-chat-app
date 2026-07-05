-- Read receipts ("Seen by") for direct messages and group DMs.
--
-- channel_read_state was introduced owner-only: you could read your own
-- last_read_at but nobody else's. "Seen by" needs the members of a DM to
-- see each other's read position. We scope that relaxation strictly to
-- dm-type channels (1:1 and group DMs) — public/private channel read
-- state stays private, so this never becomes channel-wide surveillance.
--
-- Additive: the original owner-only SELECT policy stays (so you still read
-- your own rows in every channel); this second permissive policy ORs in
-- "any row of a dm channel I belong to". The membership check runs as the
-- calling user via the existing is_channel_member SECURITY DEFINER helper.

create policy channel_read_state_read_dm on public.channel_read_state for select to authenticated
  using (
    exists (
      select 1 from public.channels c
      where c.team_id = channel_read_state.team_id
        and c.id = channel_read_state.channel_id
        and c.type = 'dm'
    )
    and public.is_channel_member(team_id, channel_id)
  );

-- Live "Seen" updates: publish row changes so a peer marking the DM read
-- updates the sender's receipt without a poll. postgres_changes still
-- applies the SELECT policies above, so subscribers only receive rows they
-- are allowed to read.
alter publication supabase_realtime add table public.channel_read_state;
