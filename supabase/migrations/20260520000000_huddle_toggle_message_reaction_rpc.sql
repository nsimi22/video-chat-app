-- Reactions on someone else's message were silently dropped by the
-- messages_update_own RLS policy (only the author can UPDATE a row).
-- The client's read-modify-write looked like it succeeded but the
-- UPDATE matched zero rows, so realtime never fired and the UI stayed
-- flat. Route the toggle through a security-definer RPC instead,
-- mirroring the set_message_pin pattern from
-- 20260509000000_huddle_message_pins.sql.
--
-- Bonus: this also fixes the TOCTOU race in the client-side toggle —
-- two simultaneous reactors no longer clobber each other because the
-- read-modify-write happens inside a single SQL statement under the
-- function's transaction.

create or replace function public.toggle_message_reaction(p_message_id uuid, p_emoji text)
returns void language plpgsql security definer as $$
declare
  msg record;
  v_uid uuid := auth.uid();
  v_reactions jsonb;
  v_list jsonb;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_emoji is null or length(p_emoji) = 0 then
    raise exception 'emoji required' using errcode = '22023';
  end if;

  select team_id, channel_id, reactions into msg
    from public.messages where id = p_message_id;
  if not found then
    raise exception 'message not found' using errcode = 'P0001';
  end if;
  if not public.can_see_channel(msg.team_id, msg.channel_id) then
    raise exception 'not a channel member' using errcode = '42501';
  end if;

  v_reactions := coalesce(msg.reactions, '{}'::jsonb);
  v_list := coalesce(v_reactions -> p_emoji, '[]'::jsonb);

  -- jsonb arrays of uuids are stringly-typed (Postgres stores them as
  -- text inside the jsonb). Compare/manipulate as text to stay
  -- consistent with what the clients write.
  if v_list @> to_jsonb(v_uid::text) then
    -- Already reacted — remove. `-` on a jsonb array drops every
    -- matching element by value.
    v_list := v_list - v_uid::text;
  else
    v_list := v_list || to_jsonb(v_uid::text);
  end if;

  if jsonb_array_length(v_list) = 0 then
    v_reactions := v_reactions - p_emoji;
  else
    v_reactions := jsonb_set(v_reactions, array[p_emoji], v_list);
  end if;

  update public.messages
     set reactions = v_reactions
   where id = p_message_id;
end;
$$;

revoke all on function public.toggle_message_reaction(uuid, text) from public;
grant execute on function public.toggle_message_reaction(uuid, text) to authenticated;
