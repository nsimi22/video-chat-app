-- Realtime broadcast policies for the new on-demand call topic
-- `call:<team_id>:<channel_id>`. Calls are scoped per channel/DM, so
-- we gate on `can_see_channel(team, channel)` — that already handles
-- public/private/dm visibility.
--
-- Channel ids include slugs like `general` and DM ids like
-- `dm:<uuidA>::<uuidB>`, so the regex captures the team_id (slug
-- pattern) and treats everything after the second `:` as the channel
-- id. Any well-formed slug or DM id flows through unchanged.

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
    when realtime.topic() like 'screen:%' then true
    else false
  end
);
