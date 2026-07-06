-- Custom integrations platform, part 1: inbound webhooks.
--
-- A `team_integrations` row is a team-scoped integration the whole team
-- shares — starting with kind='inbound_webhook': an endpoint external
-- services (GitHub, Sentry, anything that can POST JSON) hit to post a
-- message into a channel. This is deliberately TEAM-scoped, unlike
-- user_integrations (per-user credentials for unfurls-as-you): an inbound
-- event posts on the team's behalf into a shared channel, so its config
-- belongs to the team, mirroring team_jira_board.
--
-- Trust model:
--   * Config rows are readable/updatable/deletable by any team member
--     (same open-membership model as team_jira_board / channels).
--   * CREATION goes through the create_team_integration RPC only (no
--     INSERT policy) so the webhook secret is generated server-side,
--     stored where clients can't read it, and returned to the caller
--     exactly once.
--   * Secrets live in `team_integration_secrets`, a table with RLS
--     enabled and NO policies — only the service role (the
--     integration-inbound Edge Function) can read them. The secret is
--     stored raw, not hashed, because GitHub-style senders authenticate
--     by HMAC-signing the payload (x-hub-signature-256) and verifying a
--     signature requires the original secret. The deny-all table is the
--     protection boundary, exactly like the LiveKit keys living only in
--     Edge Function secrets.
--   * Inbound messages are inserted by the Edge Function via the service
--     role with author_id = NULL and app_integration_id set. Clients can
--     never forge one: the messages INSERT policy requires
--     author_id = auth.uid(), and the author trigger below strips
--     app_integration_id from any client-side insert.

-- ---------------------------------------------------------------------
-- 1. Integration config (team-visible, no secrets here)
-- ---------------------------------------------------------------------

create table public.team_integrations (
  id uuid primary key default gen_random_uuid(),
  team_id text not null references public.teams(id) on delete cascade,
  -- 'outbound_action' is reserved for the slash-command → HTTP follow-up;
  -- included in the check now so adding it later needs no migration.
  kind text not null check (kind in ('inbound_webhook', 'outbound_action')),
  name text not null check (length(name) between 1 and 80),
  -- Channel inbound events post into. Nullable at the type level (outbound
  -- actions won't need one); the create RPC enforces it for inbound.
  -- MATCH SIMPLE means the composite FK is skipped while channel_id is null.
  channel_id text,
  -- Free-form per-kind config: { preset: 'github'|'sentry'|null,
  -- template: '...' } for inbound webhooks. No secrets — team-readable.
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (team_id, channel_id) references public.channels(team_id, id) on delete cascade
);

create index team_integrations_team_idx on public.team_integrations(team_id);

alter table public.team_integrations enable row level security;

create policy team_integrations_read on public.team_integrations
  for select to authenticated using (public.is_team_member(team_id));

-- UPDATE: any team member may rename / retarget / toggle / reconfigure.
-- WITH CHECK re-validates the row they produce: still their team, and the
-- target channel (when set) is one THEY can see — so a member can't point
-- an integration at a private channel they aren't in.
create policy team_integrations_update on public.team_integrations
  for update to authenticated
  using (public.is_team_member(team_id))
  with check (
    public.is_team_member(team_id)
    and (channel_id is null or public.can_see_channel(team_id, channel_id))
  );

create policy team_integrations_delete on public.team_integrations
  for delete to authenticated using (public.is_team_member(team_id));

-- No INSERT policy: creation is RPC-only (see create_team_integration).

create or replace function public.touch_team_integrations()
returns trigger language plpgsql
set search_path = public as $$
begin
  new.updated_at := now();
  -- Immutable columns: identity and provenance survive any member edit.
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.team_id := old.team_id;
    new.kind := old.kind;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  return new;
end$$;

create trigger team_integrations_touch
  before insert or update on public.team_integrations
  for each row execute function public.touch_team_integrations();

-- ---------------------------------------------------------------------
-- 2. Secrets: service-role-only side table
-- ---------------------------------------------------------------------

create table public.team_integration_secrets (
  integration_id uuid primary key references public.team_integrations(id) on delete cascade,
  secret text not null,
  created_at timestamptz not null default now()
);

-- RLS on with NO policies = deny-all for anon/authenticated; the service
-- role bypasses RLS. Belt and braces: also revoke the schema-default
-- table grants so even a future accidental policy can't be reached by a
-- role without table privileges.
alter table public.team_integration_secrets enable row level security;
revoke all on public.team_integration_secrets from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Creation RPC — generates + returns the secret exactly once
-- ---------------------------------------------------------------------

-- pgcrypto for gen_random_bytes. Supabase installs extensions into the
-- `extensions` schema; idempotent if it's already enabled.
create extension if not exists pgcrypto with schema extensions;

create or replace function public.create_team_integration(
  p_team_id text,
  p_kind text,
  p_name text,
  p_channel_id text,
  p_config jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer
set search_path = public, extensions as $$
declare
  v_secret text;
  v_row public.team_integrations;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_team_member(p_team_id) then
    raise exception 'not a member of this team';
  end if;
  -- Only the implemented kind for now; widen when outbound actions land.
  if p_kind <> 'inbound_webhook' then
    raise exception 'unsupported integration kind: %', p_kind;
  end if;
  -- Inbound webhooks must target a channel the creator can see.
  if p_channel_id is null or not public.can_see_channel(p_team_id, p_channel_id) then
    raise exception 'channel not found or not visible';
  end if;
  if p_config is not null and jsonb_typeof(p_config) <> 'object' then
    raise exception 'config must be a JSON object';
  end if;

  -- 24 random bytes → 48 hex chars; 'hd_' prefix makes leaked secrets
  -- greppable/identifiable (same reasoning as sk_/ghp_ style prefixes).
  v_secret := 'hd_' || encode(extensions.gen_random_bytes(24), 'hex');

  insert into public.team_integrations (team_id, kind, name, channel_id, config, created_by)
  values (p_team_id, p_kind, trim(p_name), p_channel_id, coalesce(p_config, '{}'::jsonb), auth.uid())
  returning * into v_row;

  insert into public.team_integration_secrets (integration_id, secret)
  values (v_row.id, v_secret);

  -- The ONLY time the secret crosses to a client. The UI shows it once
  -- ("copy it now"); afterwards it's service-role-only. Rotation = delete
  -- the integration and create a new one.
  return jsonb_build_object('integration', to_jsonb(v_row), 'secret', v_secret);
end$$;

-- Same grant hygiene as the membership helpers (PR #306): kill the
-- default PUBLIC EXECUTE, re-grant to the roles that legitimately call it.
revoke execute on function public.create_team_integration(text, text, text, text, jsonb) from public;
grant execute on function public.create_team_integration(text, text, text, text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 4. App-authored messages
-- ---------------------------------------------------------------------

-- An inbound event posts as the INTEGRATION, not a person: author_id NULL
-- (already nullable — it's `on delete set null` for deleted accounts),
-- author_name = the integration's display name, and app_integration_id
-- marking it as an app message so the renderer shows an app badge instead
-- of a person. ON DELETE SET NULL keeps history readable after the
-- integration is deleted (author_name is a denormalized snapshot).
alter table public.messages
  add column app_integration_id uuid references public.team_integrations(id) on delete set null;

-- Spoof guard: the messages INSERT policy pins author_id = auth.uid(), but
-- nothing would stop a member setting app_integration_id on their OWN
-- message to cosplay as an app. The author trigger already runs
-- SECURITY DEFINER before every insert — extend it to strip the flag from
-- any authenticated (client) insert. Service-role inserts have
-- auth.uid() IS NULL and keep it. Body restated from 20260507005000
-- (+ search_path pinned by 20260628000000, restated here).
create or replace function public.set_message_author_from_profile()
returns trigger language plpgsql security definer
set search_path = public as $$
declare
  prof record;
begin
  if auth.uid() is not null then
    new.app_integration_id := null;
  end if;
  select name, color into prof from public.profiles where user_id = new.author_id;
  if prof.name is not null then
    new.author_name := prof.name;
    new.author_color := prof.color;
  end if;
  return new;
end;
$$;

-- App messages have author_id NULL, so messages_delete_own can never match
-- them — without this, a runaway webhook's spam would be undeletable by
-- anyone. Any team member may clean up an app message in a channel they
-- can see: consistent with any member being able to create/delete the
-- integration itself.
create policy messages_delete_app on public.messages
  for delete to authenticated
  using (
    app_integration_id is not null
    and public.is_team_member(team_id)
    and public.can_see_channel(team_id, channel_id)
  );

-- Edits can't relabel a message as (or un-flag) an app message: pin
-- app_integration_id alongside the other immutable columns. Body restated
-- from 20260625120000, with one behavioral fix:
--
-- ON DELETE SET NULL is implemented by Postgres as an UPDATE on the
-- referencing row, so it runs THROUGH this trigger — and the 20260625
-- version's unconditional `new.author_id := old.author_id` silently
-- reverted the FK's nulling, leaving messages pointing at deleted
-- auth.users rows (verified: deleting a user left author_id dangling).
-- app_integration_id has the same FK shape. Fix: nullable FK columns may
-- transition to NULL (the referential action; for a client, worst case is
-- orphaning their OWN message — RLS blocks updating anyone else's, and
-- author_name stays pinned so nothing can be relabeled) but never to a
-- different non-null value.
create or replace function public.messages_lock_immutable_cols()
returns trigger language plpgsql
set search_path = public as $$
begin
  new.id           := old.id;
  new.team_id      := old.team_id;
  new.channel_id   := old.channel_id;
  new.parent_id    := old.parent_id;
  if new.author_id is not null then
    new.author_id := old.author_id;
  end if;
  if new.app_integration_id is not null then
    new.app_integration_id := old.app_integration_id;
  end if;
  new.author_name  := old.author_name;
  new.author_color := old.author_color;
  new.ts           := old.ts;
  new.ai_generated := old.ai_generated;
  return new;
end;
$$;

-- Heal rows a past account deletion left dangling under the old trigger
-- (author_id pointing at a deleted auth.users row). Must run AFTER the
-- replace above — this UPDATE goes through the trigger, and the old body
-- would have pinned the value right back.
update public.messages m
   set author_id = null
 where m.author_id is not null
   and not exists (select 1 from auth.users u where u.id = m.author_id);
