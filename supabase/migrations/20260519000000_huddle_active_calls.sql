-- Active calls registry. One row per ongoing call in a channel, used purely
-- to drive push notifications when a call starts — the actual call state
-- still lives in Supabase Realtime presence (which clients cannot reach
-- from Postgres webhooks).
--
-- Lifecycle:
--   - Joining a call upserts (team_id, channel_id) with last_active_at = now().
--     A new INSERT fires the `notify-on-call` webhook → push fan-out.
--     An UPSERT that hits an existing row updates the heartbeat only — no
--     push, so latecomers joining an ongoing call don't re-ring everyone.
--   - Every participant heartbeats while in the call (renews last_active_at),
--     so an actually-ongoing call's row stays "fresh".
--   - On the next call attempt, the client sweeps rows older than 5 minutes
--     before its upsert. If the previous call ended without a graceful
--     cleanup, the stale row is deleted (no webhook on DELETE) and the new
--     INSERT fires a fresh push — exactly what we want.
--
-- Why not a DELETE-on-leave? It's racy: client A leaves while B is still in
-- the call, B's next heartbeat would INSERT (because the row is gone) and
-- re-fire the push to people who already heard about it. The "let the row
-- live until it's stale" model is simpler and correct.

create table if not exists public.active_calls (
  team_id text not null references public.teams(id) on delete cascade,
  channel_id text not null,
  started_by uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  primary key (team_id, channel_id),
  foreign key (team_id, channel_id) references public.channels(team_id, id) on delete cascade
);

create index if not exists active_calls_last_active_idx
  on public.active_calls(last_active_at);

alter table public.active_calls enable row level security;

-- Read: anyone who can see the channel sees its active-call row. The chat
-- header can render a "📞 ongoing" hint by joining this against the channel
-- list (future enhancement; harmless to allow now).
drop policy if exists active_calls_read on public.active_calls;
create policy active_calls_read on public.active_calls for select to authenticated
  using (public.can_see_channel(team_id, channel_id));

-- Insert: any team member with channel access can announce a call, and the
-- row must be self-attributed (started_by = auth.uid()).
drop policy if exists active_calls_insert on public.active_calls;
create policy active_calls_insert on public.active_calls for insert to authenticated
  with check (
    started_by = auth.uid()
    and public.is_team_member(team_id)
    and public.can_see_channel(team_id, channel_id)
  );

-- Update: any team member with channel access can heartbeat. Restricting to
-- started_by would mean a call started by someone who then left can't be
-- kept alive by the remaining participants — and the row's "freshness" is
-- the only signal we have that the call is still happening.
drop policy if exists active_calls_update on public.active_calls;
create policy active_calls_update on public.active_calls for update to authenticated
  using (
    public.is_team_member(team_id)
    and public.can_see_channel(team_id, channel_id)
  )
  with check (
    public.is_team_member(team_id)
    and public.can_see_channel(team_id, channel_id)
  );

-- Delete: any team member with channel access. Used for the stale-sweep
-- before announcing — the sweeping client typically doesn't own the stale
-- row, so an owner-only delete policy would silently fail.
drop policy if exists active_calls_delete on public.active_calls;
create policy active_calls_delete on public.active_calls for delete to authenticated
  using (
    public.is_team_member(team_id)
    and public.can_see_channel(team_id, channel_id)
  );

-- Realtime publication so a future "show ongoing call indicator in the
-- channel list" feature can react live. Not strictly required for push.
alter publication supabase_realtime add table public.active_calls;
