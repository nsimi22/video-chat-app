-- Lock down share_a_team(): granting execute to authenticated lets any
-- logged-in user probe whether two arbitrary uuids share a team by
-- iterating, which is more relationship leakage than the email gate
-- in get_profile actually needs. get_profile is security-definer
-- (runs as the function owner), so it can still call share_a_team
-- internally even after we revoke the public/authenticated grant.

revoke execute on function public.share_a_team(uuid, uuid) from authenticated;
