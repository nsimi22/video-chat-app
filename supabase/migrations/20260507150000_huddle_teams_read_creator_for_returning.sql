-- Broaden the SELECT policy on public.teams so the row created by an
-- INSERT ... RETURNING is visible to the creator. Without this, the
-- supabase-js `.insert(...).select()` chain in joinOrCreateTeam fails
-- with "new row violates row-level security policy for table teams":
-- Postgres evaluates the SELECT policy on the inserted row before the
-- team_after_insert AFTER trigger has had a chance to add the creator
-- to team_members, so is_team_member(id) is still false at RETURNING
-- time. The trigger always adds the creator immediately after, so
-- "creator can read" is functionally equivalent to "member can read"
-- once the statement completes.

drop policy if exists teams_read_member on public.teams;
create policy teams_read_member on public.teams for select to authenticated
  using (public.is_team_member(id) or created_by = auth.uid());
