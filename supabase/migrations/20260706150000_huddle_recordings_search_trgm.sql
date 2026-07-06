-- Index the Recordings-library search (recordings.js → searchRecordings).
--
-- The search is a leading-wildcard ILIKE over recap + transcript, fired on
-- every debounced keystroke. call_recordings only had the
-- (team_id, channel_id, started_at) btree, which cannot serve a substring
-- match — so each keystroke seq-scanned and de-TOASTed every transcript in
-- the team (hour-long calls are hundreds of KB each; latency grows with
-- total recorded hours). pg_trgm GIN indexes serve %q% ILIKE directly.
create extension if not exists pg_trgm with schema extensions;

create index if not exists call_recordings_recap_trgm
  on public.call_recordings using gin (recap extensions.gin_trgm_ops);
create index if not exists call_recordings_transcript_trgm
  on public.call_recordings using gin (transcript extensions.gin_trgm_ops);
