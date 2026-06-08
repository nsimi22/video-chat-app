-- Cloud call recording + auto meeting notes.
--
-- A `call_recordings` row tracks one server-side LiveKit RoomComposite
-- egress for a channel's call. The `recording-egress` Edge Function owns
-- the lifecycle: it inserts the row (status='starting') when a participant
-- toggles Record on, flips it to 'recording' once LiveKit confirms the
-- egress is live, and finalises it ('completed' / 'failed') when the
-- egress stops and the MP4 has landed in the `uploads` Storage bucket.
--
-- The clients NEVER write this table directly (LiveKit egress runs
-- server-side and the storage_path / status transitions are only known to
-- the function holding the LIVEKIT + S3 secrets). RLS therefore grants
-- channel members SELECT only — reads power the "● Recording" pill that
-- every participant sees, and the post-call recap reads back the row to
-- embed the download link. All writes go through the SECURITY DEFINER
-- service-role path in the function, which bypasses RLS.
--
-- "Only one active recording per room" is enforced by a partial unique
-- index on (team_id, channel_id) for in-flight statuses, so a second
-- participant's Record click can't spawn a parallel egress — the insert
-- collides and the function treats the existing row as the live one.

create table if not exists public.call_recordings (
  id uuid primary key default gen_random_uuid(),
  team_id text not null references public.teams(id) on delete cascade,
  channel_id text not null,
  -- The participant who toggled Record on. Kept even after they leave so
  -- the recap can attribute "Recording started by …".
  started_by uuid not null references auth.users(id) on delete set null,
  -- LiveKit's egress id — lets the stop path target the exact egress and
  -- lets webhooks (if wired) reconcile by id rather than by room name.
  egress_id text,
  status text not null default 'starting'
    check (status in ('starting', 'recording', 'stopping', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- Object key inside the `uploads` bucket (e.g.
  -- `recordings/<team>/<channel>/<id>.mp4`). Null until the egress
  -- finishes uploading. The renderer turns it into a public URL via
  -- storage.from('uploads').getPublicUrl(storage_path).
  storage_path text,
  -- AI meeting recap, populated when the recording finishes and the
  -- transcript pipeline produces a summary. recap_posted_message_id
  -- points at the "Meeting Recap" message so we don't double-post.
  recap text,
  recap_posted_message_id uuid,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (team_id, channel_id) references public.channels(team_id, id) on delete cascade
);

create index if not exists call_recordings_team_channel_idx
  on public.call_recordings(team_id, channel_id, started_at desc);

-- At most one in-flight recording per room. 'completed'/'failed' rows are
-- excluded so a channel can be recorded again after a prior recording
-- finishes; the active statuses collide, which is exactly the
-- single-recording-per-room guard the spec calls for.
create unique index if not exists call_recordings_one_active_per_room
  on public.call_recordings(team_id, channel_id)
  where status in ('starting', 'recording', 'stopping');

alter table public.call_recordings enable row level security;

-- Read: channel members only. Mirrors scheduled_calls / messages — a
-- recording of a private channel's call must not leak (status, storage
-- link, or recap) to non-members. is_team_member is required alongside
-- can_see_channel because the latter returns true for any public channel
-- regardless of team membership.
create policy call_recordings_read on public.call_recordings for select to authenticated
  using (
    public.is_team_member(team_id)
    and public.can_see_channel(team_id, channel_id)
  );

-- No INSERT/UPDATE/DELETE policies: clients can't write. The
-- recording-egress function uses the service role (RLS-exempt) for every
-- mutation, so the only client-reachable verb is SELECT above.

-- Realtime: postgres_changes filtered by RLS. Every participant who can
-- see the channel gets a live INSERT/UPDATE as the recording starts,
-- goes live, and completes — that's what drives the shared "Recording"
-- indicator without a bespoke broadcast event.
alter publication supabase_realtime add table public.call_recordings;

create or replace function public.touch_call_recordings_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end$$;

drop trigger if exists call_recordings_touch on public.call_recordings;
create trigger call_recordings_touch
  before update on public.call_recordings
  for each row execute function public.touch_call_recordings_updated_at();
