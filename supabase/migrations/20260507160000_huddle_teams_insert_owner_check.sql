-- Tighten public.teams INSERT policy + make created_by required.
--
-- The previous teams_insert policy (`with check (true)`) let any
-- authenticated user create a team row with an arbitrary `created_by`.
-- That's two problems combined:
--
--   1. Spoofing — a malicious client could insert teams attributing
--      authorship to another user.
--   2. Self-lockout — the broadened teams_read_member SELECT policy
--      added in 20260507150000_*.sql lets the row's `created_by` see
--      it during INSERT ... RETURNING. If the client inserts with
--      created_by = NULL or someone else's UID, the freshly-created
--      row is invisible to its supposed creator and the visibility
--      window the broadened policy was meant to provide doesn't
--      fire — RETURNING fails with the same RLS error we just fixed.
--
-- Require created_by = auth.uid() at the policy level and NOT NULL
-- at the column level so neither path is reachable.

drop policy if exists teams_insert on public.teams;
create policy teams_insert on public.teams for insert to authenticated
  with check (created_by = auth.uid());

alter table public.teams alter column created_by set not null;
