-- =========================================================================
-- Huddle: schema, RLS, triggers, Realtime publication.
--
-- Identity model: each authenticated Supabase user has a profile (display
-- name + color). They join one or more teams; a team is a Slack-style
-- workspace. Channels live inside a team and are public, private (member
-- list), or DM (two-member private channel keyed by sorted user pair).
-- =========================================================================

-- Profiles --------------------------------------------------------------
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 32),
  color text not null default 'hsl(200 70% 55%)',
  created_at timestamptz not null default now()
);

-- Teams (workspaces) ----------------------------------------------------
create table public.teams (
  id text primary key check (length(id) between 2 and 30 and id !~ '[^a-z0-9_-]'),
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.team_members (
  team_id text not null references public.teams(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_idx on public.team_members(user_id);

-- Channels --------------------------------------------------------------
create table public.channels (
  team_id text not null references public.teams(id) on delete cascade,
  id text not null,
  name text not null,
  topic text not null default '',
  type text not null check (type in ('public', 'private', 'dm')),
  protected boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (team_id, id)
);

create table public.channel_members (
  team_id text not null,
  channel_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (team_id, channel_id, user_id),
  foreign key (team_id, channel_id) references public.channels(team_id, id) on delete cascade
);
create index channel_members_user_idx on public.channel_members(user_id);

-- Messages --------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  team_id text not null,
  channel_id text not null,
  parent_id uuid references public.messages(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  author_name text not null,
  author_color text,
  body text not null default '',
  attachments jsonb not null default '[]'::jsonb,
  reactions jsonb not null default '{}'::jsonb,
  mentions text[] not null default '{}',
  ts timestamptz not null default now(),
  edited_ts timestamptz,
  foreign key (team_id, channel_id) references public.channels(team_id, id) on delete cascade
);
create index messages_channel_ts_idx on public.messages(team_id, channel_id, ts desc);
create index messages_parent_idx on public.messages(parent_id);

-- Visibility helpers ----------------------------------------------------
create or replace function public.is_team_member(t text)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.team_members
    where team_id = t and user_id = auth.uid()
  );
$$;

create or replace function public.is_channel_member(t text, c text)
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.channel_members
    where team_id = t and channel_id = c and user_id = auth.uid()
  );
$$;

create or replace function public.can_see_channel(t text, c text)
returns boolean language sql security definer stable as $$
  select coalesce(
    (select case when ch.type = 'public' then true
                 else public.is_channel_member(t, c)
            end
       from public.channels ch
      where ch.team_id = t and ch.id = c),
    false
  );
$$;

-- Triggers --------------------------------------------------------------
create or replace function public.on_team_after_insert()
returns trigger language plpgsql security definer as $$
declare
  uid uuid := auth.uid();
begin
  if uid is not null then
    insert into public.team_members (team_id, user_id) values (new.id, uid)
      on conflict do nothing;
    insert into public.channels (team_id, id, name, topic, type, protected, created_by) values
      (new.id, 'general', 'general', 'Company-wide announcements and chatter.', 'public', true, uid),
      (new.id, 'random',  'random',  'Non-work banter and water-cooler talk.', 'public', true, uid),
      (new.id, 'design',  'design',  'Mocks, critiques, and design reviews.',  'public', true, uid)
      on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger team_after_insert
after insert on public.teams
for each row execute function public.on_team_after_insert();

create or replace function public.on_channel_after_insert()
returns trigger language plpgsql security definer as $$
declare
  uid uuid := auth.uid();
begin
  if uid is not null and new.type in ('private', 'dm') then
    insert into public.channel_members (team_id, channel_id, user_id)
    values (new.team_id, new.id, uid)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

create trigger channel_after_insert
after insert on public.channels
for each row execute function public.on_channel_after_insert();

create or replace function public.on_auth_user_created()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (user_id, name)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1), 'guest'))
  on conflict do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.on_auth_user_created();

-- RLS -------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.channels enable row level security;
alter table public.channel_members enable row level security;
alter table public.messages enable row level security;

create policy profiles_read on public.profiles for select to authenticated using (true);
create policy profiles_insert_own on public.profiles for insert to authenticated
  with check (user_id = auth.uid());
create policy profiles_update_own on public.profiles for update to authenticated
  using (user_id = auth.uid());

create policy teams_read_member on public.teams for select to authenticated
  using (public.is_team_member(id));
create policy teams_insert on public.teams for insert to authenticated
  with check (true);

create policy team_members_read on public.team_members for select to authenticated
  using (user_id = auth.uid() or public.is_team_member(team_id));
create policy team_members_insert_self on public.team_members for insert to authenticated
  with check (user_id = auth.uid());
create policy team_members_delete_self on public.team_members for delete to authenticated
  using (user_id = auth.uid());

create policy channels_read on public.channels for select to authenticated
  using (public.is_team_member(team_id) and (type = 'public' or public.is_channel_member(team_id, id)));
create policy channels_insert on public.channels for insert to authenticated
  with check (public.is_team_member(team_id) and created_by = auth.uid() and not protected);
create policy channels_delete on public.channels for delete to authenticated
  using (not protected and (
    (type = 'dm' and public.is_channel_member(team_id, id))
    or (type in ('public', 'private') and created_by = auth.uid())
  ));

create policy channel_members_read on public.channel_members for select to authenticated
  using (public.is_team_member(team_id));
create policy channel_members_insert_self on public.channel_members for insert to authenticated
  with check (
    public.is_team_member(team_id) and (
      user_id = auth.uid()
      or exists (
        select 1 from public.channels ch
        where ch.team_id = team_id and ch.id = channel_id and ch.created_by = auth.uid()
      )
    )
  );
create policy channel_members_delete_self on public.channel_members for delete to authenticated
  using (user_id = auth.uid());

create policy messages_read on public.messages for select to authenticated
  using (public.can_see_channel(team_id, channel_id));
create policy messages_insert on public.messages for insert to authenticated
  with check (
    author_id = auth.uid()
    and public.can_see_channel(team_id, channel_id)
  );
create policy messages_update_own on public.messages for update to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());
create policy messages_delete_own on public.messages for delete to authenticated
  using (author_id = auth.uid());

-- Realtime publication --------------------------------------------------
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.channels;
alter publication supabase_realtime add table public.channel_members;
alter publication supabase_realtime add table public.team_members;
alter publication supabase_realtime add table public.profiles;

-- DM helper id --------------------------------------------------------
create or replace function public.dm_id(a uuid, b uuid) returns text language sql immutable as $$
  select 'dm:' || (case when a < b then a::text || '::' || b::text
                                   else b::text || '::' || a::text end);
$$;
