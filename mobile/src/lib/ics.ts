// Minimal iCalendar (RFC 5545) parser — port of renderer/ics.js.
// Scope intentionally narrow: read VEVENTs out of subscribed feeds so the
// Calendar tab can merge them with internal scheduled_calls. VTIMEZONE /
// VTODO are out of scope (see desktop file for rationale).
//
// Recurrence support (kept in lockstep with renderer/ics.js — if you fix a
// bug here, check the desktop file too):
//   - Expanded: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT,
//     UNTIL, BYDAY (weekly), BYMONTHDAY (monthly), EXDATE, and
//     RECURRENCE-ID overrides (a moved occurrence replaces the generated
//     one instead of appearing twice).
//   - Not expanded: BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR, the numeric
//     BYDAY prefix like "1MO". Events with unsupported rules emit a
//     single DTSTART so they remain visible.
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
  // Video-meeting join link + provider label derived from the VEVENT (Teams
  // X- prop, CONFERENCE, or a provider URL scraped from any property). Empty
  // strings when the event carries no recognisable meeting link.
  meetingUrl: string;
  provider: string;
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

// Video-meeting providers we recognise in subscribed feeds. Each URL pattern
// is domain-anchored so a given link classifies as at most one provider.
// Non-global (no `/g`) so `.exec` has no lastIndex state between calls.
// Lockstep with renderer/ics.js MEETING_PROVIDERS.
const MEETING_PROVIDERS: { name: string; re: RegExp }[] = [
  { name: 'Teams', re: /https?:\/\/[^\s"'<>]*teams\.(?:microsoft\.com|live\.com)\/[^\s"'<>]*/i },
  { name: 'Zoom', re: /https?:\/\/[^\s"'<>]*zoom\.us\/[^\s"'<>]*/i },
  { name: 'Meet', re: /https?:\/\/meet\.google\.com\/[^\s"'<>]*/i },
  { name: 'Webex', re: /https?:\/\/[^\s"'<>]*\.webex\.com\/[^\s"'<>]*/i },
];

// Pull a join link + provider label out of a parsed VEVENT. Teams exports a
// dedicated X- property holding the canonical URL, so we trust that over
// scraping the body. Otherwise we scan the most authoritative fields first
// (URL / LOCATION / DESCRIPTION), then EVERY remaining property value — the
// all-properties fallback matters for meetings you were INVITED to (vs
// organised): the invitee copy frequently carries the join link in CONFERENCE
// (RFC 7986), X-GOOGLE-CONFERENCE (Meet), or a vendor X- prop rather than in
// LOCATION/DESCRIPTION. Provider regexes are domain-anchored, so scanning
// unrelated properties can't produce a false positive.
// Lockstep with renderer/ics.js deriveMeeting.
function deriveMeeting(ev: IcsEvent): { meetingUrl: string; provider: string } {
  const raw = ev.raw || {};
  const teamsProp = raw['X-MICROSOFT-SKYPETEAMSMEETINGURL']
    || raw['X-MICROSOFT-ONLINEMEETINGEXTERNALLINK'];
  if (teamsProp && /^https?:\/\//i.test(teamsProp.trim())) {
    return { meetingUrl: teamsProp.trim(), provider: 'Teams' };
  }
  const preferredKeys = ['URL', 'LOCATION', 'DESCRIPTION'];
  const rest = Object.keys(raw)
    .filter((k) => !preferredKeys.includes(k))
    .map((k) => raw[k]);
  for (const field of [ev.url, ev.location, ev.description, ...rest]) {
    if (!field) continue;
    for (const { name, re } of MEETING_PROVIDERS) {
      const m = re.exec(field);
      if (m) {
        // Trailing sentence punctuation can glue onto a body-buried URL; strip
        // it (real query strings don't end in these chars).
        return { meetingUrl: m[0].replace(/[.,;)\]]+$/, ''), provider: name };
      }
    }
  }
  return { meetingUrl: '', provider: '' };
}

export function parseIcs(text: string, opts?: ParseIcsOptions): { events: IcsEvent[] } {
  const out: { events: IcsEvent[] } = { events: [] };
  if (typeof text !== 'string' || !text.length) return out;
  const expandUntil = opts?.expandUntil instanceof Date ? opts.expandUntil : null;
  const lines = unfoldLines(text);
  let inEvent = false;
  let cur: IcsEvent | null = null;
  // RECURRENCE-ID of the VEVENT being parsed (null = master/standalone).
  // Overrides are deferred so they can replace generated occurrences no
  // matter where they appear in the feed relative to their master.
  // `candidates` holds every plausible instant for the named occurrence —
  // feeds sometimes express RECURRENCE-ID in a different form than the
  // master's DTSTART (floating vs TZID vs UTC), and a single-instant
  // comparison would miss those, leaving the moved meeting rendered twice.
  let curRecur: { primaryMs: number; candidates: number[] } | null = null;
  const masters: IcsEvent[] = [];
  const overrides: { ev: IcsEvent; primaryMs: number; candidates: number[] }[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === 'BEGIN:VEVENT') {
      inEvent = true;
      curRecur = null;
      cur = {
        uid: '', title: '', description: '', location: '', url: '',
        start: null, end: null, allDay: false, rrule: '',
        meetingUrl: '', provider: '', exdate: [], raw: {},
      };
      continue;
    }
    if (trimmed === 'END:VEVENT') {
      if (cur && cur.start) {
        // Derive once here on the master/override; expandSeries spreads
        // `...event`, so generated occurrences inherit the link.
        const meeting = deriveMeeting(cur);
        cur.meetingUrl = meeting.meetingUrl;
        cur.provider = meeting.provider;
        if (curRecur !== null) overrides.push({ ev: cur, ...curRecur });
        else masters.push(cur);
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
      case 'RECURRENCE-ID': {
        const candidates = dateTimeCandidates(cl.value, cl.params);
        if (candidates.length) curRecur = { primaryMs: candidates[0], candidates };
        break;
      }
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
  for (const m of masters) {
    if (m.rrule) {
      for (const occ of expandSeries(m, expandUntil)) out.events.push(occ);
    } else {
      out.events.push(m);
    }
  }
  if (overrides.length) {
    // A RECURRENCE-ID override replaces the generated occurrence it names
    // (RFC 5545 §3.8.4.4) — drop the original so a moved meeting doesn't
    // render twice. Match on the master's UID (kept in raw.UID across
    // expansion) + ANY plausible instant of the named occurrence (covers
    // feeds whose override form differs from the master DTSTART's).
    const ovByUid = new Map<string, Set<number>>();
    for (const o of overrides) {
      const uid = o.ev.uid;
      if (!ovByUid.has(uid)) ovByUid.set(uid, new Set());
      for (const c of o.candidates) ovByUid.get(uid)!.add(c);
    }
    out.events = out.events.filter((e) => {
      const set = ovByUid.get(e.raw?.UID || e.uid);
      return !(set && e.start && set.has(e.start.getTime()));
    });
    for (const o of overrides) {
      // Suffix like recurring instances so list keys stay unique even
      // though the override shares the master's bare UID.
      out.events.push({
        ...o.ev,
        uid: `${o.ev.uid}/${new Date(o.primaryMs).toISOString()}`,
        _recurringInstance: true,
      });
    }
  }
  return out;
}

// Every plausible instant for a date-time string whose form may not match
// the master DTSTART's: as-parsed (honoring TZID/Z/floating), plus the
// floating-local and UTC readings of the same wall-clock fields. Used for
// RECURRENCE-ID matching only — display always uses the as-parsed instant.
function dateTimeCandidates(value: string, params?: Record<string, string>): number[] {
  const out: number[] = [];
  const p = parseDate(value, params);
  if (p) out.push(p.date.getTime());
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec((value || '').trim());
  if (m) {
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), dd = parseInt(m[3], 10);
    const hh = parseInt(m[4], 10), mm = parseInt(m[5], 10), ss = parseInt(m[6], 10);
    out.push(new Date(y, mo - 1, dd, hh, mm, ss).getTime()); // floating-local reading
    out.push(Date.UTC(y, mo - 1, dd, hh, mm, ss));           // UTC reading
  }
  return [...new Set(out)];
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
        // Use setDate to add a day rather than a fixed 24h offset — DST
        // transitions make days 23 or 25 hours long and the arithmetic
        // version cuts off / over-includes occurrences on those nights.
        if (p.allDay) {
          const next = new Date(p.date);
          next.setDate(next.getDate() + 1);
          out.until = new Date(next.getTime() - 1);
        } else {
          out.until = p.date;
        }
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
  // When EXDATE excludes every occurrence (or COUNT=0 paths slip through),
  // return an empty array — re-emitting the bare event would violate
  // RFC 5545 §3.8.5.1. The "rule failed to parse" fallback is handled
  // upstream by the early `return [event]` when parseRrule returns null.
  return out;
}

// Expand an INTERNAL scheduled call's recurrence into occurrence start
// instants, reusing the same engine that expands subscribed .ics feeds — so a
// recurring Huddle and a recurring Google/Outlook event behave identically.
// Desktop does the same (renderer/calendar.js listEvents). Returns [start] for
// a non-recurring call (empty rrule → expandSeries early-returns the master).
export function expandRecurringStarts(
  master: { start: Date; end: Date | null; rrule: string; exdate: number[]; uid: string },
  horizon: Date,
): Date[] {
  const ev: IcsEvent = {
    uid: master.uid,
    title: '',
    description: '',
    location: '',
    url: '',
    start: master.start,
    end: master.end,
    allDay: false,
    rrule: master.rrule,
    exdate: master.exdate,
    meetingUrl: '',
    provider: '',
    raw: {},
  };
  return expandSeries(ev, horizon)
    .map((o) => o.start)
    .filter((d): d is Date => !!d);
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
    // Sort ascending so BYMONTHDAY=31,1 yields 1st before 31st within a
    // month — order matters for COUNT and for the calendar list which
    // assumes chronological iteration.
    const bymonthday = rule.bymonthday?.length
      ? [...rule.bymonthday].sort((a, b) => a - b)
      : [start.getDate()];
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

// Outlook/Exchange feeds emit WINDOWS timezone names in TZID (e.g.
// "Mountain Standard Time"), which Intl can't resolve. Map the common ones
// to IANA before resolution — without this, every Outlook event falls back
// to floating and renders at the author's wall-clock hour, not the
// viewer's. Subset of CLDR's windowsZones.xml covering the zones a feed is
// realistically authored in. Kept in lockstep with renderer/ics.js.
const WINDOWS_TZ: Record<string, string> = {
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time': 'America/Denver',
  'Mountain Standard Time (Mexico)': 'America/Chihuahua',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'Eastern Standard Time': 'America/New_York',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'SA Pacific Standard Time': 'America/Bogota',
  'Venezuela Standard Time': 'America/Caracas',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'UTC': 'UTC',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'GTB Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Kiev',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Russian Standard Time': 'Europe/Moscow',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Arab Standard Time': 'Asia/Riyadh',
  'Arabian Standard Time': 'Asia/Dubai',
  'Iran Standard Time': 'Asia/Tehran',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Kathmandu',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'W. Australia Standard Time': 'Australia/Perth',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

// Convert a wall-clock time in an IANA timezone to an absolute instant.
// Two-pass offset estimation via Intl (the second pass nails times near a
// DST transition). Returns null when the runtime can't resolve the zone —
// the caller falls back to treating the time as floating-local, which is
// the old behavior.
function zonedToUtc(
  y: number, mo: number, dd: number, hh: number, mm: number, ss: number,
  timeZone: string,
): Date | null {
  const zone = WINDOWS_TZ[timeZone] ?? timeZone;
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return null; // unknown TZID or no Intl timezone data on this runtime
  }
  const wallUtc = Date.UTC(y, mo - 1, dd, hh, mm, ss);
  const offsetAt = (utcMs: number): number => {
    const parts: Record<string, string> = {};
    for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
    const asUtc = Date.UTC(
      parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10),
      parseInt(parts.hour, 10) % 24, parseInt(parts.minute, 10), parseInt(parts.second, 10),
    );
    return asUtc - utcMs;
  };
  let utc = wallUtc - offsetAt(wallUtc);
  utc = wallUtc - offsetAt(utc);
  return new Date(utc);
}

// §3.3.4/3.3.5: YYYYMMDD (all-day) or YYYYMMDDTHHMMSS[Z]. TZID-qualified
// times are converted from their zone to the device's local time (falling
// back to floating when the zone can't be resolved), so events authored in
// other timezones land at the right local hour. Round-trip-check the
// calendar fields to refuse silent JS Date overflow (e.g. Feb 30 → Mar 2).
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
    // The wall-clock fields are valid; if a TZID names the zone they're
    // in, convert to the real instant so the event renders at the right
    // local hour for this user.
    if (params?.TZID) {
      const zoned = zonedToUtc(y, mo, dd, hh, mm, ss, params.TZID);
      if (zoned) d = zoned;
    }
  }
  return { date: d, allDay: false };
}
