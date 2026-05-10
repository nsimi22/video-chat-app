-- Saved messages: per-user bookmarks with arbitrary user-defined labels.
--
-- Each row is owned by exactly one user (the saver) and references a
-- single message; the (user_id, message_id) primary key enforces "save
-- once per user". Saves cascade-delete with the underlying message so
-- a deleted message doesn't leave dangling rows in users' Saved panels.
--
-- Labels are stored as a free-form text[] so the user can compose any
-- folder/tag structure they want without an extra join table — Slack-
-- style "Reminders / References / Memes" plus anything else they
-- invent. The chip rail in the renderer derives the label set from
-- DISTINCT unnest(labels), so there's no separate labels table to
-- migrate or garbage-collect.

create table if not exists public.saved_messages (
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id text not null references public.teams(id) on delete cascade,
  channel_id text not null,
  message_id uuid not null references public.messages(id) on delete cascade,
  labels text[] not null default '{}',
  saved_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

create index if not exists saved_messages_user_recent_idx
  on public.saved_messages(user_id, saved_at desc);
create index if not exists saved_messages_user_labels_gin
  on public.saved_messages using gin (user_id, labels);

alter table public.saved_messages enable row level security;

-- Users only ever see their own saves. The save itself records that
-- the user could see the message at save time; we don't re-check
-- channel visibility on every read because the message FK + RLS on
-- messages already gates content access (a saver who loses access to
-- a private channel will get back the saved-row metadata but the
-- message body select will be filtered).
create policy saved_messages_read on public.saved_messages for select to authenticated
  using (user_id = auth.uid());

-- Insert: must be saving for yourself, and must be able to see the
-- channel right now. Stops a malicious client from creating saved
-- rows referencing channels they don't have access to (which would
-- light up someone else's Saved panel via realtime if our filter
-- logic ever drifted).
create policy saved_messages_insert on public.saved_messages for insert to authenticated
  with check (
    user_id = auth.uid()
    and public.can_see_channel(team_id, channel_id)
  );

-- Update: only labels move; user_id is part of the PK and team/channel
-- shouldn't change for an existing save. Owner-only.
create policy saved_messages_update on public.saved_messages for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy saved_messages_delete on public.saved_messages for delete to authenticated
  using (user_id = auth.uid());

-- Realtime: postgres_changes on this table will be filtered by the
-- saved_messages_read policy at subscribe time, so each user sees only
-- their own row mutations even though the publication is global.
alter publication supabase_realtime add table public.saved_messages;
