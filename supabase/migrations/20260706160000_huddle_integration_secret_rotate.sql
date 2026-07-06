-- Follow-ups from the PR-307 code review's deferred findings.
--
-- (1) Webhook secret rotation. The integrations UI steers header-less
-- senders (Sentry, cron jobs) toward `?secret=` in the URL, and URLs end
-- up in edge logs / proxies / the sender's own delivery UI. Until now the
-- only response to a leaked secret was delete + recreate, which breaks the
-- sender (new integration id = new URL). Rotation keeps the id/URL and
-- swaps the secret, returned to the caller exactly once — same contract as
-- create_team_integration.
create or replace function public.rotate_team_integration_secret(p_integration_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_team text;
  v_secret text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  select team_id into v_team from public.team_integrations where id = p_integration_id;
  if v_team is null or not public.is_team_member(v_team) then
    raise exception 'integration not found';
  end if;
  v_secret := 'hd_' || encode(extensions.gen_random_bytes(24), 'hex');
  update public.team_integration_secrets
     set secret = v_secret, created_at = now()
   where integration_id = p_integration_id;
  if not found then
    -- Secret row missing (shouldn't happen; created with the integration)
    -- — heal rather than strand the integration secretless.
    insert into public.team_integration_secrets (integration_id, secret)
    values (p_integration_id, v_secret);
  end if;
  return jsonb_build_object('secret', v_secret);
end$$;

-- Grant hygiene (the full #306 lesson): Supabase's default privileges grant
-- EXECUTE both via PUBLIC and DIRECTLY to anon, so revoke both. Also close
-- the same gap on create_team_integration, whose migration only revoked
-- PUBLIC (harmless today — it raises on auth.uid() null — but keep the
-- surface consistent).
revoke execute on function public.rotate_team_integration_secret(uuid) from public, anon;
grant execute on function public.rotate_team_integration_secret(uuid) to authenticated, service_role;
revoke execute on function public.create_team_integration(text, text, text, text, jsonb) from anon;

-- (2) Recordings list payload: the library list renders a ~180-char recap
-- snippet, but _queryRecordings shipped the full recap for up to 100 rows
-- per open/search. A stored generated column lets the list select just the
-- snippet; the detail view still fetches the full row.
alter table public.call_recordings
  add column if not exists recap_snippet text
  generated always as (left(recap, 200)) stored;
