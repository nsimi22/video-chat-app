// Minimal iCalendar (RFC 5545) parser — port of renderer/ics.js.
// Scope intentionally narrow: read VEVENTs out of subscribed feeds so the
// Calendar tab can merge them with internal scheduled_calls. VTIMEZONE /
// VTODO are out of scope (see desktop file for rationale).
//
// Recurrence support (kept in lockstep with renderer/ics.js — if you fix a
// bug here, check the desktop file too):
//   - Expanded: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT,
//     UNTIL, BYDAY (weekly), BYMONTHDAY (monthly), and EXDATE.
//   - Not expanded: BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR, RECURRENCE-ID
//     overrides, the numeric BYDAY prefix like "1MO". Events with
//     unsupported rules emit a single DTSTART so they remain visible.
//
// Mobile-specific note: no buildEvent yet — mobile doesn't auto-post an
// .ics attachment to the channel on schedule (deferred for v1). Add it
// back here if/when that wires up.

export type IcsEvent = {
  uid: string;
  title: string;
  description: string;
  location: string;
  url: string;
  start: Date | null;
  end: Date | null;
  allDay: boolean;
  rrule: string;
  exdate: number[];
  raw: Record<string, string>;
  // True for every occurrence past the first in a recurring series; the
  // first occurrence keeps the bare UID for back-compat with consumers
  // that key off UID. Optional so non-recurring events stay shape-stable.
  _recurringInstance?: boolean;
};

export type ParseIcsOptions = {
  // Cap recurrence expansion at this point. Caller is expected to set
  // this to its display horizon — defaults to ~1 year forward if absent.
  expandUntil?: Date;
};

export function parseIcs(text: string, opts?: ParseIcsOptions): { events: IcsEvent[] } {
  const out: { events: IcsEvent[] } = { events: [] };
  if (typeof text !== 'string' || !text.length) return out;
  const expandUntil = opts?.expandUntil instanceof Date ? opts.expandUntil : null;
  const lines = unfoldLines(text);
  let inEvent = false;
  let cur: IcsEvent | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === 'BEGIN:VEVENT') {
      inEvent = true;
      cur = {
        uid: '', title: '', description: '', location: '', url: '',
        start: null, end: null, allDay: false, rrule: '', exdate: [], raw: {},
      };
      continue;
    }
    if (trimmed === 'END:VEVENT') {
      if (cur && cur.start) {
        if (cur.rrule) {
          for (const occ of expandSeries(cur, expandUntil)) out.events.push(occ);
        } else {
          out.events.push(cur);
        }
      }
      inEvent = false;
      cur = null;
      continue;
    }
    if (!inEvent || !cur) continue;
    const cl = splitContentLine(trimmed);
    if (!cl) continue;
    cur.raw[cl.name] = cl.value;
    switch (cl.name) {
      case 'UID': cur.uid = cl.value; break;
      case 'SUMMARY': cur.title = unescapeText(cl.value); break;
      case 'DESCRIPTION': cur.description = unescapeText(cl.value); break;
      case 'LOCATION': cur.location = unescapeText(cl.value); break;
      case 'URL': cur.url = cl.value; break;
      case 'RRULE': cur.rrule = cl.value; break;
      case 'EXDATE': {
        // EXDATE may carry comma-separated values AND may appear multiple
        // times in one VEVENT — accumulate into the array. raw[] would
        // overwrite, so don't rely on that path for this field.
        for (const v of cl.value.split(',')) {
          const p = parseDate(v.trim(), cl.params);
          if (p) cur.exdate.push(p.date.getTime());
        }
        break;
      }
      case 'DTSTART': {
        const p = parseDate(cl.value, cl.params);
        if (p) { cur.start = p.date; cur.allDay = p.allDay; }
        break;
      }
      case 'DTEND': {
        const p = parseDate(cl.value, cl.params);
        if (p) cur.end = p.date;
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// RRULE expansion (mirrors renderer/ics.js — see that file's RRULE section
// header for the design rationale). DTSTART is always the first occurrence
// even if it doesn't strictly satisfy BYDAY/BYMONTHDAY (RFC 5545 §3.8.5.3).
// Past the first occurrence we suffix the UID with the ISO start so the
// calendar list has a stable per-row key.
// ---------------------------------------------------------------------------

type ParsedRrule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  until?: Date;
  byday?: number[];
  bymonthday?: number[];
};

function parseRrule(s: string): ParsedRrule | null {
  const out: Partial<ParsedRrule> & { _unsupported?: boolean } = {};
  for (const part of String(s || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).toUpperCase();
    const v = part.slice(eq + 1);
    if (k === 'FREQ') {
      const up = v.toUpperCase();
      if (up === 'DAILY' || up === 'WEEKLY' || up === 'MONTHLY' || up === 'YEARLY') {
        out.freq = up;
      }
    } else if (k === 'INTERVAL') {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) out.interval = n;
    } else if (k === 'COUNT') {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) out.count = n;
    } else if (k === 'UNTIL') {
      const p = parseDate(v, {});
      if (p) {
        // RFC 5545 §3.3.10: a date-only UNTIL is inclusive of that whole
        // day. parseDate yields local midnight; bump to last ms of the
        // day so a 10:00 AM occurrence on that date isn't excluded.
        out.until = p.allDay
          ? new Date(p.date.getTime() + 24 * 60 * 60 * 1000 - 1)
          : p.date;
      }
    } else if (k === 'BYDAY') {
      const days = v.split(',').map(parseDayCode).filter((d): d is number => d !== null);
      if (days.length) out.byday = days;
    } else if (k === 'BYMONTHDAY') {
      const vals = v.split(',').map((x) => parseInt(x, 10));
      // Reject negative ("last day of month") and bad input — fall back
      // to single DTSTART rather than silently use the wrong day.
      if (vals.some((n) => !Number.isFinite(n) || n < 1 || n > 31)) {
        out._unsupported = true;
      } else {
        out.bymonthday = vals;
      }
    }
  }
  if (!out.freq) return null;
  if (out._unsupported) return null;
  // BYDAY only implemented for WEEKLY. "1MO" on MONTHLY would mean "first
  // Monday of each month" — we don't generate that, so fall back rather
  // than silently emit on DTSTART's day-of-month.
  if ((out.freq === 'MONTHLY' || out.freq === 'YEARLY') && out.byday?.length) return null;
  // BYMONTHDAY only implemented for MONTHLY. YEARLY+BYMONTHDAY needs a
  // BYMONTH mate to be meaningful; don't pretend.
  if (out.freq === 'YEARLY' && out.bymonthday?.length) return null;
  out.interval = out.interval || 1;
  return out as ParsedRrule;
}

function parseDayCode(code: string): number | null {
  // BYDAY values can be 'MO' or 'MO,1MO,-1FR'. We strip any numeric prefix
  // and treat the rest as a plain weekday — so "1MO" still emits on every
  // Monday rather than disappearing, which beats silence.
  const stripped = String(code || '').replace(/^[+-]?\d+/, '').toUpperCase();
  const map: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  return Object.prototype.hasOwnProperty.call(map, stripped) ? map[stripped] : null;
}

// RFC 5545 default WKST=MO; Monday-based weeks. (For INTERVAL=1 WKST
// doesn't matter; only matters for biweekly+ rules spanning the boundary.)
function startOfMondayWeek(d: Date): Date {
  const out = new Date(d);
  const daysSinceMon = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - daysSinceMon);
  out.setHours(0, 0, 0, 0);
  return out;
}

function expandSeries(event: IcsEvent, horizonDate: Date | null): IcsEvent[] {
  const rule = parseRrule(event.rrule);
  if (!rule || !event.start) return [event];
  const horizonMs = horizonDate
    ? horizonDate.getTime()
    : Date.now() + 365 * 24 * 60 * 60 * 1000;
  const effectiveMs = rule.until
    ? Math.min(horizonMs, rule.until.getTime())
    : horizonMs;
  const exdateSet = new Set(event.exdate);
  const duration = event.end && event.start
    ? event.end.getTime() - event.start.getTime()
    : 0;

  const out: IcsEvent[] = [];
  // `yielded` counts every occurrence the generator produced — drives COUNT
  // and EXDATE skip-but-count. `emitted` drives "is this the first visible
  // instance, get the bare UID?" — without the split, an EXDATE on DTSTART
  // would silently move the bare UID off the series.
  let yielded = 0;
  let emitted = 0;
  for (const occStart of generateOccurrences(event.start, rule, effectiveMs)) {
    if (rule.count && yielded >= rule.count) break;
    if (exdateSet.has(occStart.getTime())) {
      yielded++;
      continue;
    }
    const occEnd = duration > 0 ? new Date(occStart.getTime() + duration) : null;
    const isFirst = emitted === 0;
    out.push({
      ...event,
      uid: isFirst ? event.uid : `${event.uid}/${occStart.toISOString()}`,
      start: occStart,
      end: occEnd,
      _recurringInstance: !isFirst,
    });
    yielded++;
    emitted++;
  }
  return out.length ? out : [event];
}

function* generateOccurrences(
  start: Date,
  rule: ParsedRrule,
  horizonMs: number,
): Generator<Date, void, unknown> {
  // DTSTART is always the first occurrence (RFC 5545 §3.8.5.3).
  yield new Date(start);

  if (rule.freq === 'DAILY') {
    let cur = new Date(start);
    for (let i = 0; i < 10000; i++) {
      cur = new Date(cur);
      cur.setDate(cur.getDate() + rule.interval);
      if (cur.getTime() > horizonMs) return;
      yield cur;
    }
    return;
  }

  if (rule.freq === 'WEEKLY') {
    const byday = rule.byday?.length ? rule.byday : [start.getDay()];
    const weekStart = startOfMondayWeek(start);
    const intervalDays = rule.interval * 7;
    // Sort BYDAYs so within a block we emit Mon → Sun order.
    const sortedDays = byday.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    for (let blockIdx = 0; blockIdx < 5000; blockIdx++) {
      const blockBase = new Date(weekStart);
      blockBase.setDate(weekStart.getDate() + blockIdx * intervalDays);
      if (blockBase.getTime() > horizonMs) return;
      for (const dow of sortedDays) {
        const daysFromMon = (dow + 6) % 7;
        const occ = new Date(blockBase);
        occ.setDate(blockBase.getDate() + daysFromMon);
        occ.setHours(start.getHours(), start.getMinutes(),
                     start.getSeconds(), start.getMilliseconds());
        if (occ.getTime() <= start.getTime()) continue;
        if (occ.getTime() > horizonMs) return;
        yield occ;
      }
    }
    return;
  }

  if (rule.freq === 'MONTHLY') {
    const bymonthday = rule.bymonthday?.length ? rule.bymonthday : [start.getDate()];
    // Start at i=0 so multi-day rules (BYMONTHDAY=1,15 with DTSTART on the
    // 1st) still emit the 15th of the first month. The "occ <= start" skip
    // below removes DTSTART itself, which we already yielded at the top.
    for (let i = 0; i < 1000; i++) {
      const totalMonths = start.getMonth() + i * rule.interval;
      const year = start.getFullYear() + Math.floor(totalMonths / 12);
      const month = ((totalMonths % 12) + 12) % 12;
      for (const dom of bymonthday) {
        // Overflow guard: new Date(2026, 1, 30) silently rolls to Mar 2.
        // Refuse the occurrence so Feb-only rules work.
        const occ = new Date(year, month, dom,
          start.getHours(), start.getMinutes(),
          start.getSeconds(), start.getMilliseconds());
        if (occ.getMonth() !== month) continue;
        if (occ.getTime() <= start.getTime()) continue;
        if (occ.getTime() > horizonMs) return;
        yield occ;
      }
    }
    return;
  }

  if (rule.freq === 'YEARLY') {
    for (let i = 1; i < 100; i++) {
      const occ = new Date(start);
      occ.setFullYear(start.getFullYear() + i * rule.interval);
      // Feb 29 → Mar 1 on non-leap years: drop rather than silently shift.
      if (occ.getDate() !== start.getDate()) continue;
      if (occ.getTime() > horizonMs) return;
      yield occ;
    }
  }
}

// RFC 5545 §3.1 line folding: continuation lines start with a single
// space or tab and must be rejoined before field tokenisation.
function unfoldLines(text: string): string[] {
  const out: string[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

// Reverse of §3.3.11 text escapes. Order matters — unescape \\ last so
// a literal "\\n" doesn't become a real newline.
function unescapeText(s: string): string {
  return s.replace(/\\([nN,;\\])/g, (_, c: string) => {
    if (c === 'n' || c === 'N') return '\n';
    if (c === ',') return ',';
    if (c === ';') return ';';
    return '\\';
  });
}

type ContentLine = { name: string; params: Record<string, string>; value: string };

function splitContentLine(line: string): ContentLine | null {
  const colonIdx = findUnquotedColon(line);
  if (colonIdx === -1) return null;
  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = left.split(';');
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq === -1) continue;
    const k = parts[i].slice(0, eq).toUpperCase();
    let v = parts[i].slice(eq + 1);
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    params[k] = v;
  }
  return { name, params, value };
}

function findUnquotedColon(line: string): number {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) return i;
  }
  return -1;
}

// §3.3.4/3.3.5: YYYYMMDD (all-day) or YYYYMMDDTHHMMSS[Z]. TZID-qualified
// local times are treated as floating. Round-trip-check the calendar
// fields to refuse silent JS Date overflow (e.g. Feb 30 → Mar 2).
function parseDate(
  value: string,
  params?: Record<string, string>,
): { date: Date; allDay: boolean } | null {
  const s = (value || '').trim();
  if (!s) return null;
  const isAllDay = params?.VALUE === 'DATE' || /^\d{8}$/.test(s);
  if (isAllDay) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (!m) return null;
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), dd = parseInt(m[3], 10);
    const d = new Date(y, mo - 1, dd);
    if (
      isNaN(d.getTime()) ||
      d.getFullYear() !== y ||
      d.getMonth() !== mo - 1 ||
      d.getDate() !== dd
    ) return null;
    return { date: d, allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(s);
  if (!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), dd = parseInt(m[3], 10);
  const hh = parseInt(m[4], 10), mm = parseInt(m[5], 10), ss = parseInt(m[6], 10);
  const z = m[7];
  let d: Date;
  if (z) {
    d = new Date(Date.UTC(y, mo - 1, dd, hh, mm, ss));
    if (
      isNaN(d.getTime()) ||
      d.getUTCFullYear() !== y ||
      d.getUTCMonth() !== mo - 1 ||
      d.getUTCDate() !== dd ||
      d.getUTCHours() !== hh ||
      d.getUTCMinutes() !== mm ||
      d.getUTCSeconds() !== ss
    ) return null;
  } else {
    d = new Date(y, mo - 1, dd, hh, mm, ss);
    if (
      isNaN(d.getTime()) ||
      d.getFullYear() !== y ||
      d.getMonth() !== mo - 1 ||
      d.getDate() !== dd ||
      d.getHours() !== hh ||
      d.getMinutes() !== mm ||
      d.getSeconds() !== ss
    ) return null;
  }
  return { date: d, allDay: false };
}
