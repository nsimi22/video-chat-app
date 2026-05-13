-- Each user can belong to at most one team. Without this, accidental
-- double-joins surfaced as duplicate entries on the team picker.

-- Collapse any user with multiple memberships to a single row: keep
-- the earliest joined_at, tie-break on team_id.
delete from public.team_members tm
using public.team_members other
where other.user_id = tm.user_id
  and (other.joined_at, other.team_id) < (tm.joined_at, tm.team_id);

alter table public.team_members
  add constraint team_members_one_team_per_user unique (user_id);

-- The constraint above implies a unique index on (user_id); the
-- original non-unique index from the initial schema is now redundant.
drop index if exists public.team_members_user_idx;
