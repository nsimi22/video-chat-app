-- Recurrence for internal scheduled calls. Additive + backward
-- compatible: existing single-shot calls keep rrule = '' and expand to
-- exactly themselves, so nothing changes for them.
--
--   rrule  — an RFC 5545 RRULE body (no "RRULE:" prefix), e.g.
--            'FREQ=WEEKLY;BYDAY=MO'. Empty string = non-recurring.
--            Expanded client-side by the same HuddleICS engine that
--            expands subscribed ICS feeds, so there's one recurrence
--            implementation for both internal and external events.
--   exdate — excluded occurrence start instants (cancel-one-occurrence):
--            a "skip this week's standup" drops its start into this array
--            rather than deleting the whole series.

alter table public.scheduled_calls
  add column if not exists rrule text not null default '',
  add column if not exists exdate timestamptz[] not null default '{}';

-- Guard rail: keep rrule bounded so a pathological value can't bloat the
-- row. Real RRULE bodies are well under this.
alter table public.scheduled_calls
  drop constraint if exists scheduled_calls_rrule_len;
alter table public.scheduled_calls
  add constraint scheduled_calls_rrule_len check (length(rrule) <= 500);
