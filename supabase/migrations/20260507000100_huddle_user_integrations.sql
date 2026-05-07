-- Per-user integration settings (Jira host/email/token, Tenor key, future
-- integrations). One row per user; settings is a free-form JSONB so we don't
-- need a migration when we add a new integration. RLS keeps each user
-- locked to their own row.
create table public.user_integrations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_integrations enable row level security;

create policy user_integrations_read_own on public.user_integrations
  for select to authenticated using (user_id = auth.uid());
create policy user_integrations_insert_own on public.user_integrations
  for insert to authenticated with check (user_id = auth.uid());
create policy user_integrations_update_own on public.user_integrations
  for update to authenticated using (user_id = auth.uid());
create policy user_integrations_delete_own on public.user_integrations
  for delete to authenticated using (user_id = auth.uid());

create or replace function public.touch_user_integrations()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger user_integrations_touch
before update on public.user_integrations
for each row execute function public.touch_user_integrations();
