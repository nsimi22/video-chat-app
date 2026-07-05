-- Harden the scheduled_messages UPDATE policy.
--
-- The original policy allowed an author to set any of their rows to any
-- status, including flipping an already sent/failed/canceled row back to
-- 'pending' — which the flushers (both the client and the cron) would then
-- re-deliver, i.e. a self-inflicted double-send. Forbid updates that leave
-- the row 'pending': every legitimate transition (claim pending→sent,
-- cancel, mark failed, stamp sent_message_id) moves it OUT of pending, so
-- this blocks only the resurrection path.
--
-- We intentionally keep USING as author-only (no can_see_channel): a user
-- who has left the target channel must still be able to CANCEL a pending
-- send so it doesn't fire (the service-role flush ignores RLS and would
-- deliver it otherwise). Creation is already gated on channel visibility by
-- the INSERT policy, and the channel is immutable in practice.

drop policy if exists scheduled_messages_update on public.scheduled_messages;
create policy scheduled_messages_update on public.scheduled_messages for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid() and status <> 'pending');
