-- Polls live on the messages row: meta.poll = { question, multi,
-- options: [{id, text}], votes: {optionId: [userId,...]}, closed_at }.
-- Voting mirrors the toggle_message_reaction pattern
-- (20260520000000_huddle_toggle_message_reaction_rpc.sql): the
-- messages_update_own RLS policy means voters can't UPDATE someone
-- else's poll message directly, so votes route through a
-- security-definer RPC. The UPDATE rides the existing messages
-- realtime subscription — no new tables or channels.
--
-- One improvement over the reactions template: `for update` locks the
-- row across the read-modify-write, so two simultaneous voters can't
-- lost-update each other's vote (reactions tolerates that race; poll
-- tallies shouldn't).

create or replace function public.toggle_poll_vote(p_message_id uuid, p_option_id text)
returns void language plpgsql security definer as $$
declare
  msg record;
  v_uid uuid := auth.uid();
  v_poll jsonb;
  v_votes jsonb;
  v_had boolean;
  v_key text;
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  if p_option_id is null or length(p_option_id) = 0 then
    raise exception 'option required' using errcode = '22023';
  end if;

  select team_id, channel_id, meta into msg
    from public.messages where id = p_message_id for update;
  if not found then
    raise exception 'message not found' using errcode = 'P0001';
  end if;
  if not public.can_see_channel(msg.team_id, msg.channel_id) then
    raise exception 'not a channel member' using errcode = '42501';
  end if;

  v_poll := msg.meta -> 'poll';
  if v_poll is null then
    raise exception 'not a poll' using errcode = '22023';
  end if;
  if v_poll ->> 'closed_at' is not null then
    raise exception 'poll closed' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from jsonb_array_elements(coalesce(v_poll -> 'options', '[]'::jsonb)) o
    where o ->> 'id' = p_option_id
  ) then
    raise exception 'unknown option' using errcode = '22023';
  end if;

  v_votes := coalesce(v_poll -> 'votes', '{}'::jsonb);
  -- jsonb arrays of uuids are stringly-typed; compare/manipulate as
  -- text to stay consistent with what the clients read.
  v_had := coalesce(v_votes -> p_option_id, '[]'::jsonb) @> to_jsonb(v_uid::text);

  if not coalesce((v_poll ->> 'multi')::boolean, false) then
    -- Single-choice: clear this user's vote from every option first,
    -- so voting B after A is a switch, not a second vote.
    for v_key in select jsonb_object_keys(v_votes) loop
      v_votes := jsonb_set(v_votes, array[v_key], (v_votes -> v_key) - v_uid::text);
    end loop;
  elsif v_had then
    v_votes := jsonb_set(v_votes, array[p_option_id], (v_votes -> p_option_id) - v_uid::text);
  end if;

  -- v_had means this click is an un-vote (already cleared above);
  -- otherwise add the vote.
  if not v_had then
    v_votes := jsonb_set(v_votes, array[p_option_id],
      coalesce(v_votes -> p_option_id, '[]'::jsonb) || to_jsonb(v_uid::text));
  end if;

  -- Drop empty arrays to keep the blob tidy (mirrors reactions).
  for v_key in select jsonb_object_keys(v_votes) loop
    if jsonb_array_length(v_votes -> v_key) = 0 then
      v_votes := v_votes - v_key;
    end if;
  end loop;

  update public.messages
     set meta = jsonb_set(meta, '{poll,votes}', v_votes)
   where id = p_message_id;
end;
$$;

revoke all on function public.toggle_poll_vote(uuid, text) from public;
grant execute on function public.toggle_poll_vote(uuid, text) to authenticated;

-- Author-only: freeze the poll. The card renders final results once
-- closed_at is set; toggle_poll_vote rejects further votes.
create or replace function public.close_poll(p_message_id uuid)
returns void language plpgsql security definer as $$
declare
  msg record;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  select author_id, meta into msg
    from public.messages where id = p_message_id for update;
  if not found then
    raise exception 'message not found' using errcode = 'P0001';
  end if;
  if msg.author_id is distinct from v_uid then
    raise exception 'only the poll author can close it' using errcode = '42501';
  end if;
  if msg.meta -> 'poll' is null then
    raise exception 'not a poll' using errcode = '22023';
  end if;
  update public.messages
     set meta = jsonb_set(meta, '{poll,closed_at}', to_jsonb(now()))
   where id = p_message_id;
end;
$$;

revoke all on function public.close_poll(uuid) from public;
grant execute on function public.close_poll(uuid) to authenticated;
