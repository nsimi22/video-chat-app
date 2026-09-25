-- Quote reply (#351): a message can reference the message it quotes.
--
-- Deliberately a plain uuid with no foreign key. With `references
-- messages(id) on delete set null`, deleting a quoted message would
-- cascade an UPDATE onto every quoting row — firing the messages
-- before-update triggers (author re-stamp, immutable-column lock) and
-- broadcasting realtime UPDATEs that clients treat as edits. With plain
-- `references` (no action) the delete would fail outright. A dangling id
-- is handled client-side ("Original message unavailable"), and the
-- preview is always read through messages RLS, so quoting never exposes
-- a message the viewer can't already see.
--
-- Nullable, no default: a metadata-only change in Postgres. lock_timeout
-- keeps the brief ACCESS EXCLUSIVE lock from queueing chat traffic behind
-- a long-running query — fail fast and retry instead.
set lock_timeout = '5s';

alter table public.messages
  add column if not exists quoted_message_id uuid;

comment on column public.messages.quoted_message_id is
  'Message this one quotes (Quote reply). No FK by design — see migration 20260925180000.';
