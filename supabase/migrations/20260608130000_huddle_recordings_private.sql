-- Private call recordings + server-side recap plumbing.
--
-- Follow-up to 20260608120000_huddle_call_recordings.sql. Two changes:
--
--   1. A PRIVATE `recordings` storage bucket. The original feature wrote the
--      egress MP4 to the public `uploads` bucket and the recap embedded a
--      permanent getPublicUrl — so anyone with the link could fetch a private
--      channel's recording. Here the MP4 lands in a `public = false` bucket
--      and reads are gated by storage.objects RLS: a user may SELECT an object
--      only if they can see the channel of the matching call_recordings row.
--      Writes stay service-role only (the egress S3 upload uses the service
--      key; no INSERT/UPDATE/DELETE policy is granted to authenticated users),
--      mirroring the "clients never write" model of call_recordings itself.
--      The renderer mints a short-lived createSignedUrl on demand instead of a
--      permanent public link (see renderer/api.js recordingSignedUrl).
--
--   2. A `transcript` column on call_recordings so the recap can be generated
--      server-side. The live caption transcript only exists in the starter's
--      client (app.js state.cc.lines); the starter submits a snapshot via the
--      recording-egress `submit-transcript` action (service-role write) on the
--      stop/leave transition. The livekit-egress-webhook then reads it back on
--      `completed`, summarises it with the starter's AI key, and posts the
--      recap server-side — so the recap survives the starter leaving the call.

-- 1a. Private bucket. public = false means getPublicUrl yields a URL that 401s;
--     only createSignedUrl (service or RLS-authorised) or the S3 service path
--     can read objects. id/name 'recordings' matches the EGRESS_S3_BUCKET
--     default the recording-egress function now uses.
insert into storage.buckets (id, name, public)
values ('recordings', 'recordings', false)
on conflict (id) do nothing;

-- 1b. Read policy. An authenticated user may read a recordings object iff a
--     call_recordings row exists whose storage_path equals this object's name
--     AND the user can see that recording's channel. We reuse the exact
--     membership predicate the call_recordings SELECT policy uses
--     (is_team_member + can_see_channel) so storage access can never be looser
--     than table access — a private channel's recording stays members-only.
--
--     storage.objects RLS runs as the requesting user, so auth.uid() inside
--     is_team_member/can_see_channel resolves to them. The join key is
--     call_recordings.storage_path, which the egress function sets to the same
--     object key it uploads to (recordings/<team>/<channel>/<id>.mp4).
create policy recordings_read_channel_members on storage.objects for select to authenticated
  using (
    bucket_id = 'recordings'
    and exists (
      select 1
        from public.call_recordings cr
       where cr.storage_path = storage.objects.name
         and public.is_team_member(cr.team_id)
         and public.can_see_channel(cr.team_id, cr.channel_id)
    )
  );

-- No INSERT/UPDATE/DELETE policies on the recordings bucket: the egress S3
-- upload authenticates with the Storage S3 access keys (service-role grade,
-- RLS-exempt), so authenticated clients can't write or tamper with recordings.

-- 2. Transcript snapshot for the server-side recap. Populated by
--    recording-egress (action='submit-transcript') via the service role; the
--    livekit-egress-webhook reads it on `completed` to build the AI recap.
--    Nullable: a recording with captions off (or a starter who left before
--    submitting) simply yields a link-only recap. Stored as text — the
--    flattened "Name: line" transcript the renderer already builds — rather
--    than structured JSON, because that's exactly what the summariser prompt
--    consumes and keeps the column trivially human-readable.
alter table public.call_recordings
  add column if not exists transcript text;
