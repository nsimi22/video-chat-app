-- Scheduled messages + per-message reminders.
--
-- Two personal, owner-only tables. A message can be composed now and sent
-- later (scheduled_messages), and any message can be flagged "remind me
-- about this" at a chosen time (message_reminders). Both are flushed by a
-- server cron (flush-scheduled edge function) so they fire even when the
-- author's app is closed; open desktop clients also flush on focus as a
-- fallback, claiming rows atomically via the status flip so the two paths
-- never double-fire.

-- ---- Scheduled messages -----------------------------------------------------
create table if not exists public.scheduled_messages (
  id uuid primary key default gen_random_uuid(),
  team_id text not null references public.teams(id) on delete cascade,
  channel_id text not null,
  parent_id uuid,                       -- thread target, if any
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  send_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','sent','canceled','failed')),
  sent_message_id uuid,                 -- the messages.id once delivered
  error text,
  created_at timestamptz not null default now(),
  foreign key (team_id, channel_id) references public.channels(team_id, id) on delete cascade
);
create index if not exists scheduled_messages_author_idx
  on public.scheduled_messages(author_id, send_at);
-- The flush job scans due, still-pending rows across all users (service role).
create index if not exists scheduled_messages_due_idx
  on public.scheduled_messages(send_at) where status = 'pending';

alter table public.scheduled_messages enable row level security;

-- Strictly personal: you only ever see/manage your own scheduled sends.
create policy scheduled_messages_read on public.scheduled_messages for select to authenticated
  using (author_id = auth.uid());
-- Must schedule as yourself, into a channel you can currently see.
create policy scheduled_messages_insert on public.scheduled_messages for insert to authenticated
  with check (author_id = auth.uid() and public.can_see_channel(team_id, channel_id));
create policy scheduled_messages_update on public.scheduled_messages for update to authenticated
  using (author_id = auth.uid()) with check (author_id = auth.uid());
create policy scheduled_messages_delete on public.scheduled_messages for delete to authenticated
  using (author_id = auth.uid());

alter publication supabase_realtime add table public.scheduled_messages;

-- ---- Message reminders ------------------------------------------------------
create table if not exists public.message_reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  team_id text not null references public.teams(id) on delete cascade,
  channel_id text not null,
  message_id uuid references public.messages(id) on delete cascade,
  note text not null default '',
  remind_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','fired','canceled')),
  created_at timestamptz not null default now()
);
create index if not exists message_reminders_user_idx
  on public.message_reminders(user_id, remind_at);
create index if not exists message_reminders_due_idx
  on public.message_reminders(remind_at) where status = 'pending';

alter table public.message_reminders enable row level security;

create policy message_reminders_read on public.message_reminders for select to authenticated
  using (user_id = auth.uid());
create policy message_reminders_insert on public.message_reminders for insert to authenticated
  with check (user_id = auth.uid());
create policy message_reminders_update on public.message_reminders for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy message_reminders_delete on public.message_reminders for delete to authenticated
  using (user_id = auth.uid());

alter publication supabase_realtime add table public.message_reminders;
