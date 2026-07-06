-- Follow-up to 20260628000000_huddle_definer_search_path_and_roster_gate.
--
-- That migration revoked EXECUTE on the membership helpers from PUBLIC on
-- the assumption that anon's access came only through the Postgres default
-- PUBLIC grant. On Supabase, ALTER DEFAULT PRIVILEGES additionally grants
-- EXECUTE directly to anon/authenticated/service_role on every new function,
-- so the helpers still carried an explicit anon=X grant (verified in
-- pg_proc.proacl) and anon could call them via /rest/v1/rpc/*. Revoke the
-- direct grant to complete the lockdown.
revoke execute on function public.is_team_member(text) from anon;
revoke execute on function public.is_channel_member(text, text) from anon;
revoke execute on function public.can_see_channel(text, text) from anon;
