-- Public-read uploads bucket; per-uid write/delete via storage.objects RLS.
insert into storage.buckets (id, name, public)
values ('uploads', 'uploads', true)
on conflict (id) do nothing;

create policy uploads_read_all on storage.objects for select
  using (bucket_id = 'uploads');

create policy uploads_insert_own_folder on storage.objects for insert to authenticated
  with check (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy uploads_delete_own on storage.objects for delete to authenticated
  using (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Realtime broadcast: open initial policy (will be tightened in next migration).
create policy realtime_broadcast_read on realtime.messages for select to authenticated
  using (
    realtime.topic() like 'team:%'
    or realtime.topic() like 'screen:%'
    or realtime.topic() like 'presence:%'
  );

create policy realtime_broadcast_write on realtime.messages for insert to authenticated
  with check (
    realtime.topic() like 'team:%'
    or realtime.topic() like 'screen:%'
    or realtime.topic() like 'presence:%'
  );
