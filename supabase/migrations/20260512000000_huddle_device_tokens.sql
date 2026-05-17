-- Device push tokens for the native mobile app (Expo push).
--
-- One row per (device) token. A user can have several devices, and a
-- single device can re-register with a new token, so `token` is the
-- primary key and `user_id` is just an owned column. Rows cascade-delete
-- with the user. The `notify-on-message` Edge Function reads this table
-- with the service role to fan out push notifications; clients only ever
-- see/write their own rows (RLS below).
--
-- The desktop Electron app does not use this table.

create table if not exists public.device_tokens (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('ios', 'android', 'web')),
  updated_at timestamptz not null default now()
);

create index if not exists device_tokens_user_idx on public.device_tokens(user_id);

alter table public.device_tokens enable row level security;

-- Owner-only: a user can see, register, refresh, and delete only their
-- own device tokens. The Edge Function uses the service role, which
-- bypasses RLS.
drop policy if exists device_tokens_select_own on public.device_tokens;
create policy device_tokens_select_own on public.device_tokens
  for select using (auth.uid() = user_id);

drop policy if exists device_tokens_insert_own on public.device_tokens;
create policy device_tokens_insert_own on public.device_tokens
  for insert with check (auth.uid() = user_id);

drop policy if exists device_tokens_update_own on public.device_tokens;
create policy device_tokens_update_own on public.device_tokens
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists device_tokens_delete_own on public.device_tokens;
create policy device_tokens_delete_own on public.device_tokens
  for delete using (auth.uid() = user_id);
