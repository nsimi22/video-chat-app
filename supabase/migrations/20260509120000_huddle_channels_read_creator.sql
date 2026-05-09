-- Bug: creating a DM (or any private) channel with a normal supabase-js
-- upsert/insert call ships PostgREST a `Prefer: return=representation`
-- header, which adds an implicit RETURNING. Postgres re-evaluates the
-- new row through `channels_read` USING — but the AFTER trigger that
-- adds the creator to channel_members hasn't run yet at RETURNING time,
-- so for type = 'dm' or 'private' the policy returns FALSE and the
-- whole INSERT rejects with SQLSTATE 42501. The error message names
-- "channels", which is misleading: the WITH CHECK on the INSERT itself
-- is satisfied; the failure is on the read-back's USING.
--
-- Fix: a creator should always be able to see channels they just
-- created. Add `created_by = auth.uid()` to the OR clause of
-- channels_read. Strictly more permissive, and it only widens visibility
-- for channels the caller created — a sound invariant the original
-- policy implicitly assumed via the AFTER trigger but couldn't enforce
-- at RETURNING time.
--
-- Reproduces by inserting type='dm' under any team member's JWT with a
-- RETURNING clause; verified that the bare INSERT (without RETURNING)
-- succeeds, narrowing the regression to the read-back path.
drop policy if exists channels_read on public.channels;
create policy channels_read on public.channels for select to authenticated
  using (
    public.is_team_member(team_id) and (
      type = 'public'
      or public.is_channel_member(team_id, id)
      or created_by = auth.uid()
    )
  );
