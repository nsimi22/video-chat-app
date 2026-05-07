-- Profile cards: add `bio` + `avatar_url` to profiles, an RPC that
-- returns the full profile + the requester's view of email (gated to
-- shared-team peers), and an `avatars` storage bucket for uploads.

alter table public.profiles
  add column if not exists bio text check (bio is null or char_length(bio) <= 280),
  add column if not exists avatar_url text;

-- Helper: do these two users share at least one team? Used to gate
-- email exposure in get_profile — non-teammates shouldn't be able to
-- harvest emails by iterating uuids.
create or replace function public.share_a_team(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.team_members ma
    join public.team_members mb on mb.team_id = ma.team_id
    where ma.user_id = a and mb.user_id = b
  );
$$;

revoke all on function public.share_a_team(uuid, uuid) from public, anon;
grant execute on function public.share_a_team(uuid, uuid) to authenticated;

-- Full-profile lookup. name/color/bio/avatar_url are already readable
-- to all authenticated users via the profiles_read policy, so this
-- RPC just unifies the fetch into one round trip and adds the
-- teammate-gated email field.
create or replace function public.get_profile(p_user_id uuid)
returns table (
  user_id uuid,
  name text,
  color text,
  bio text,
  avatar_url text,
  email text
)
language sql
stable
security definer
set search_path = public, auth
as $$
  select
    p.user_id,
    p.name,
    p.color,
    p.bio,
    p.avatar_url,
    case
      when auth.uid() = p.user_id then u.email
      when public.share_a_team(auth.uid(), p.user_id) then u.email
      else null
    end as email
  from public.profiles p
  left join auth.users u on u.id = p.user_id
  where p.user_id = p_user_id;
$$;

revoke all on function public.get_profile(uuid) from public, anon;
grant execute on function public.get_profile(uuid) to authenticated;

-- Public storage bucket for avatar images. Public read so the
-- renderer can drop the URL straight into <img src>; uploads gated
-- to the owner's `<uuid>/...` folder.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatars: public read"
  on storage.objects for select
  to public
  using (bucket_id = 'avatars');

create policy "avatars: own folder insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars: own folder update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars: own folder delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
