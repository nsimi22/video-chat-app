-- Server-authorized knock-to-huddle signaling.
--
-- Background: knock invites (knock / knock-response / knock-cancel) used to
-- ride the shared `team:<team_id>` broadcast topic, filtered client-side by a
-- `to` field. That topic's realtime write policy only checks team membership
-- (see 20260507180000_huddle_call_realtime_rls.sql), so ANY team member could
-- emit a knock broadcast with an arbitrary `from`/`to` — enabling spam /
-- ring-bombing and identity spoofing by forging the payload `from`.
--
-- Fix: knocks now flow through a dedicated per-recipient private topic
-- `knock:<user_id>` and are relayed exclusively by the `knock-signal` edge
-- function using the service role. The function authenticates the caller from
-- their JWT, verifies caller + target genuinely share a team, and stamps a
-- trusted `from` = the authenticated user id. Clients can no longer write
-- knock broadcasts themselves; they only invoke the function and receive on
-- their own `knock:<self>` subscription.
--
-- This migration teaches the realtime broadcast RLS about the new topic:
--   READ  `knock:<id>` — only the user whose id == <id> (you only ever read
--                        knocks addressed to you; nobody can snoop others').
--   WRITE `knock:<id>` — NO authenticated client may insert. The case below
--                        deliberately has no `knock:` write branch, so it
--                        falls through to `false`. Only the service role
--                        (which bypasses RLS) — i.e. the edge function — can
--                        publish into a knock topic. This is what actually
--                        prevents forging `from` and unauthorized senders.
--
-- The pre-existing `team:` and `screen:` branches are reproduced verbatim from
-- 20260507180000 so this migration is a self-contained replacement of both
-- policies (the previous `call:` branch was itself dropped/re-added the same
-- way). User ids are uuids; `[0-9a-f-]+` keeps the topic regex tight so a
-- crafted topic can't smuggle anything past the suffix capture.

drop policy if exists realtime_broadcast_read on realtime.messages;
drop policy if exists realtime_broadcast_write on realtime.messages;

create policy realtime_broadcast_read on realtime.messages for select to authenticated using (
  case
    when realtime.topic() ~ '^team:[a-z0-9_-]+(:|$)' then
      public.is_team_member(substring(realtime.topic() from '^team:([a-z0-9_-]+)'))
    when realtime.topic() ~ '^call:[a-z0-9_-]+:.+$' then
      public.can_see_channel(
        (regexp_match(realtime.topic(), '^call:([a-z0-9_-]+):'))[1],
        substring(realtime.topic() from '^call:[a-z0-9_-]+:(.+)$')
      )
    -- A knock topic is private to a single recipient: you may only read your
    -- own. The relay is service-role, so no authenticated WRITE branch exists.
    when realtime.topic() ~ '^knock:[0-9a-f-]+$' then
      substring(realtime.topic() from '^knock:([0-9a-f-]+)$') = auth.uid()::text
    when realtime.topic() like 'screen:%' then true
    else false
  end
);

create policy realtime_broadcast_write on realtime.messages for insert to authenticated with check (
  case
    when realtime.topic() ~ '^team:[a-z0-9_-]+(:|$)' then
      public.is_team_member(substring(realtime.topic() from '^team:([a-z0-9_-]+)'))
    when realtime.topic() ~ '^call:[a-z0-9_-]+:.+$' then
      public.can_see_channel(
        (regexp_match(realtime.topic(), '^call:([a-z0-9_-]+):'))[1],
        substring(realtime.topic() from '^call:[a-z0-9_-]+:(.+)$')
      )
    -- NOTE: intentionally no `knock:` branch here. Knock publishes are
    -- service-role-only (the knock-signal edge function); authenticated
    -- clients fall through to `false` and cannot forge knocks.
    when realtime.topic() like 'screen:%' then true
    else false
  end
);
