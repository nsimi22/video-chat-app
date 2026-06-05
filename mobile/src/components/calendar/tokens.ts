// Calendar design tokens — ported from Claude Design's `Huddle Calendar.html`
// prototype (calendar-screens.jsx). The dark iCal-inspired surface palette
// here intentionally overrides parts of the global @/theme `colors` so the
// calendar surfaces match the design's pure-black background and tighter
// hairlines. Keep it scoped to calendar components — don't reuse globally.

export const C = {
  bg: '#000',
  surface1: '#0E0E11',
  surface2: '#1A1A1E',
  surface3: '#26262C',
  hair: 'rgba(255,255,255,0.07)',
  text: '#fff',
  text2: 'rgba(255,255,255,0.55)',
  text3: 'rgba(255,255,255,0.32)',
  accent: '#4A8BF5',
  red: '#FF453A',
  green: '#30D158',
} as const;

// Calendar layout constants — single source so Week + 3-day + Month + Detail
// stay aligned without drift.
export const HOUR_PX = 56;
export const DAY_START = 0;  // 24h scrollable timeline (prototype was 7–19,
export const DAY_END = 24;   // but real users schedule outside business hours)
export const DAY_BUSINESS_START = 7;  // initial scroll anchor

// Channel palette + deterministic fallback.
//
// The prototype hard-codes a small map keyed by channel slug (`design`,
// `general`, `feature-requests`, `feedback`, `random`, `personal`). Real
// channels don't carry a color column, so we seed the well-known names
// and hash everything else into the same palette so colors stay stable
// across sessions for any channel.
const SEED: Record<string, string> = {
  general: '#4A8BF5',
  design: '#BF5AF2',
  'feature-requests': '#FF9F0A',
  feedback: '#FF375F',
  random: '#30D158',
  personal: '#5AC8FA',
};

const PALETTE = [
  '#4A8BF5', // blue (brand)
  '#BF5AF2', // purple
  '#FF9F0A', // orange
  '#FF375F', // pink
  '#30D158', // green
  '#5AC8FA', // teal
  '#FFD60A', // yellow
  '#FF6B6B', // coral
];

// Stable djb2-like hash on the channel id so the same channel always
// resolves to the same color regardless of which device renders it.
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function channelColor(idOrName: string): string {
  const key = (idOrName || '').toLowerCase().trim();
  if (SEED[key]) return SEED[key];
  return PALETTE[hash(key) % PALETTE.length];
}

// DM channels in renderer/api.js look like `dm:<a>::<b>` — surface a
// teal personal color for any DM regardless of the other party's id.
export function channelColorForChannel(id: string, type?: string): string {
  if (type === 'dm' || id.startsWith('dm:') || id.startsWith('gdm:')) return SEED.personal;
  return channelColor(id);
}

// 12am, 1am, …, 11pm, 12am. Pure-iCal "8 AM" style (no minute when on-hour).
export function fmtHourLabel(h: number): string {
  const ampm = h >= 12 && h < 24 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12} ${ampm}`;
}

// "9:30 AM" / "2 PM" — minute omitted if zero. Matches prototype fmtTime().
export function fmtTime(d: Date): string {
  const hh = d.getHours();
  const mm = d.getMinutes();
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const h12 = ((hh + 11) % 12) + 1;
  return mm === 0 ? `${h12} ${ampm}` : `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
}

// Decimal hour for absolute positioning on the timeline (e.g. 9:30 → 9.5).
export function hourOf(d: Date): number {
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

// Does an all-day ICS event cover this day? All-day spans are
// [DTSTART, DTEND) with DTEND exclusive per RFC 5545 §3.6.1 (a one-day
// event on the 5th has DTEND on the 6th). Missing or non-compliant DTEND
// (== DTSTART) renders as a single day.
export function icsAllDayOnDay(
  e: { start: Date | null; end: Date | null; allDay: boolean },
  day: Date,
): boolean {
  if (!e.allDay || !e.start) return false;
  const d = startOfDay(day).getTime();
  const s = startOfDay(e.start).getTime();
  if (!e.end) return d === s;
  const endEx = Math.max(startOfDay(e.end).getTime(), s + 1);
  return d >= s && d < endEx;
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
