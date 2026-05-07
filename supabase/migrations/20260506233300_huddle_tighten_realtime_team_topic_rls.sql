-- Replace the previous permissive realtime broadcast policies with ones that
-- gate `team:<id>` topics behind team membership. `screen:<streamId>` stays
-- open: streamIds are random UUIDs only known to peers who already received
-- the screen-announce on their team channel, so leaving them open relies on
-- security-through-obscurity but the team gate above prevents discovery.
drop policy if exists realtime_broadcast_read on realtime.messages;
drop policy if exists realtime_broadcast_write on realtime.messages;

create policy realtime_broadcast_read on realtime.messages for select to authenticated using (
  (
    realtime.topic() ~ '^team:[a-z0-9_-]+$'
    and public.is_team_member(substring(realtime.topic() from 6))
  )
  or realtime.topic() like 'screen:%'
);

create policy realtime_broadcast_write on realtime.messages for insert to authenticated with check (
  (
    realtime.topic() ~ '^team:[a-z0-9_-]+$'
    and public.is_team_member(substring(realtime.topic() from 6))
  )
  or realtime.topic() like 'screen:%'
);
