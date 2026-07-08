// RRULE helpers shared by the schedule sheet (build + edit-mode parse) and the
// event detail screen (human label). Kept lockstep with renderer/calendar.js
// buildRrule / rruleToRepeat: weekly anchors BYDAY to the start's weekday and
// monthly anchors BYMONTHDAY to its day-of-month so the ICS expandSeries engine
// (shared by desktop + mobile) reproduces the intended cadence.

export type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export const REPEAT_OPTIONS: { id: Repeat; label: string }[] = [
  { id: 'none', label: 'Never' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekdays', label: 'Weekdays' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'monthly', label: 'Monthly' },
];

const RRULE_WEEKDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function buildRrule(repeat: Repeat, startsAt: Date): string {
  switch (repeat) {
    case 'daily': return 'FREQ=DAILY';
    case 'weekdays': return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'weekly': return `FREQ=WEEKLY;BYDAY=${RRULE_WEEKDAY[startsAt.getDay()]}`;
    case 'monthly': return `FREQ=MONTHLY;BYMONTHDAY=${startsAt.getDate()}`;
    default: return '';
  }
}

export function rruleToRepeat(rrule: string): Repeat {
  if (!rrule) return 'none';
  const s = rrule.toUpperCase();
  if (/FREQ=DAILY/.test(s)) return 'daily';
  if (/FREQ=WEEKLY/.test(s)) return /BYDAY=MO,TU,WE,TH,FR/.test(s) ? 'weekdays' : 'weekly';
  if (/FREQ=MONTHLY/.test(s)) return 'monthly';
  return 'none';
}

// Human label for a scheduled_calls.rrule body — empty string when it doesn't
// recur, so callers can hide the row.
export function formatRrule(rrule: string): string {
  switch (rruleToRepeat(rrule)) {
    case 'daily': return 'Every day';
    case 'weekdays': return 'Every weekday';
    case 'weekly': return 'Every week';
    case 'monthly': return 'Every month';
    default: return rrule ? 'Repeats' : '';
  }
}
