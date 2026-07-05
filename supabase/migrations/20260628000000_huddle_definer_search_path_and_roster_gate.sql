-- Security hardening for SECURITY DEFINER functions and private-channel
-- roster visibility. Three independent tightenings, all backwards compatible.

-- (1) Pin search_path on the SECURITY DEFINER functions that were missing it.
--
-- A SECURITY DEFINER function runs as its owner (the Supabase admin/superuser
-- role). Without an explicit search_path it resolves unqualified names using
-- the *caller's* search_path, so a caller who prepends a schema they control
-- can shadow a table/function the body references and have it run with owner
-- privileges (the standard `function_search_path_mutable` advisory). The
-- later functions (share_a_team, get_profile, find/join_dm_by_member_sig,
-- toggle_whiteboard_note_vote) already pin `set search_path = public`; these
-- earlier ones did not. Using ALTER FUNCTION so we don't have to restate the
-- bodies (and risk drift).
alter function public.is_team_member(text) set search_path = public;
alter function public.is_channel_member(text, text) set search_path = public;
alter function public.on_team_after_insert() set search_path = public;
alter function public.on_channel_after_insert() set search_path = public;
alter function public.on_auth_user_created() set search_path = public;
alter function public.set_message_author_from_profile() set search_path = public;
alter function public.set_message_pin(uuid, boolean) set search_path = public;
alter function public.toggle_message_reaction(uuid, text) set search_path = public;
alter function public.toggle_poll_vote(uuid, text) set search_path = public;
alter function public.close_poll(uuid) set search_path = public;

-- (2) Deny anon EXECUTE on the read-only membership helpers.
--
-- They were created with no grant management, so they carry the Postgres
-- default GRANT EXECUTE TO PUBLIC. `anon` is a member of PUBLIC, so revoking
-- only `from anon` is a no-op (the PUBLIC grant remains) — revoke from PUBLIC
-- and re-grant to the roles that legitimately call them. Every RLS policy that
-- invokes these helpers is `to authenticated`, and no anon/role-unqualified
-- policy references them, so anon loses nothing it could use; service_role is
-- kept for edge functions. Defense in depth (can_see_channel already returns
-- false when auth.uid() is null after the PR-283 rewrite).
revoke execute on function public.is_team_member(text) from public;
revoke execute on function public.is_channel_member(text, text) from public;
revoke execute on function public.can_see_channel(text, text) from public;
grant execute on function public.is_team_member(text) to authenticated, service_role;
grant execute on function public.is_channel_member(text, text) to authenticated, service_role;
grant execute on function public.can_see_channel(text, text) to authenticated, service_role;

-- (3) Gate channel_members reads on channel visibility, not just team
--     membership.
--
-- The original policy let any team member SELECT * from channel_members for
-- the whole team — leaking the id and full member list of every *private*
-- channel (e.g. an `hr-layoffs` channel's existence and participants) to
-- people who can't read its messages. channels_read already hides private
-- channels from non-members; align the roster with that. can_see_channel is
-- strictly tighter than is_team_member here: public channels have no member
-- rows anyway, and private/DM rosters become members-only.
drop policy if exists channel_members_read on public.channel_members;
create policy channel_members_read on public.channel_members for select to authenticated
  using (public.can_see_channel(team_id, channel_id));
