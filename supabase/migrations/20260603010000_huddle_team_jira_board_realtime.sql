-- Enable Realtime (postgres_changes) for the shared team Jira board so a
-- project change made by one teammate propagates to the others instantly,
-- instead of only on the next board open.
--
-- The read RLS on team_jira_board already restricts rows to team members
-- (public.is_team_member(team_id)), and Realtime honors RLS, so adding the
-- table to the publication does not widen who can see a row.
alter publication supabase_realtime add table public.team_jira_board;
