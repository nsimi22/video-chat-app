-- Organizer timezone for scheduled calls. starts_at is an absolute
-- instant (timestamptz), so every viewer already sees it in their own
-- local time. What that loses on a distributed team is the *organizer's*
-- context — "is 9am-my-time a reasonable 6pm for them, or a brutal 2am?".
-- Recording the IANA zone the call was scheduled in lets the UI show the
-- organizer's local time alongside the viewer's when the two differ.
--
-- Additive + backward compatible: empty string means "unknown" (rows
-- created before this column, or a client that couldn't resolve a zone),
-- and the UI simply falls back to viewer-local only.

alter table public.scheduled_calls
  add column if not exists organizer_tz text not null default '';

alter table public.scheduled_calls
  drop constraint if exists scheduled_calls_organizer_tz_len;
alter table public.scheduled_calls
  add constraint scheduled_calls_organizer_tz_len check (length(organizer_tz) <= 64);
