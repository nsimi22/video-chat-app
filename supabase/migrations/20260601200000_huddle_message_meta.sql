-- Generic JSONB metadata column on messages.
--
-- The first consumer is the meeting-thread feature: a "Call started"
-- message is posted at call start with meta.meeting_root=true and
-- meta.started_at=<iso>. The renderer renders meeting-root messages
-- specially (treat them as a thread anchor + show a Notes panel
-- during the call). The same column is intentionally generic so
-- future system-message kinds (release notes, integration events)
-- don't need their own column.
--
-- A partial GIN index on the meeting_root flag keeps joiner-side
-- lookup ("what's the active meeting root for this channel?") cheap
-- without indexing the whole jsonb column.

alter table public.messages
  add column if not exists meta jsonb not null default '{}'::jsonb;

create index if not exists messages_meta_meeting_root_idx
  on public.messages (team_id, channel_id, ts desc)
  where (meta->>'meeting_root') = 'true';
