-- Message pinning. Any channel member can pin / unpin any message in a
-- channel they can see; the existing messages_update_own RLS only lets
-- authors mutate their own rows, so we route pin toggles through a
-- security-definer RPC instead of loosening the policy. The function
-- enforces channel visibility and writes pinned_at + pinned_by; the
-- existing realtime UPDATE subscription on public.messages already
-- broadcasts the change to all team members.

alter table public.messages
  add column if not exists pinned_at timestamptz,
  add column if not exists pinned_by uuid references auth.users(id) on delete set null;

create index if not exists messages_channel_pinned_idx
  on public.messages(team_id, channel_id, pinned_at)
  where pinned_at is not null;

create or replace function public.set_message_pin(p_message_id uuid, p_pin boolean)
returns void language plpgsql security definer as $$
declare
  msg record;
begin
  select team_id, channel_id into msg from public.messages where id = p_message_id;
  if not found then
    raise exception 'message not found' using errcode = 'P0001';
  end if;
  if not public.can_see_channel(msg.team_id, msg.channel_id) then
    raise exception 'not a channel member' using errcode = '42501';
  end if;
  if p_pin then
    update public.messages
       set pinned_at = now(), pinned_by = auth.uid()
     where id = p_message_id;
  else
    update public.messages
       set pinned_at = null, pinned_by = null
     where id = p_message_id;
  end if;
end;
$$;

revoke all on function public.set_message_pin(uuid, boolean) from public;
grant execute on function public.set_message_pin(uuid, boolean) to authenticated;
