// Minimal iCalendar (RFC 5545) parser — port of renderer/ics.js (parse-only).
// Scope intentionally narrow: read VEVENTs out of subscribed feeds so the
// Calendar tab can merge them with internal scheduled_calls. Recurrence /
// VTIMEZONE / VTODO are out of scope (see desktop file for rationale).
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
  raw: Record<string, string>;
};

export function parseIcs(text: string): { events: IcsEvent[] } {
  const out: { events: IcsEvent[] } = { events: [] };
  if (typeof text !== 'string' || !text.length) return out;
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
        start: null, end: null, allDay: false, rrule: '', raw: {},
      };
      continue;
    }
    if (trimmed === 'END:VEVENT') {
      if (cur && cur.start) out.events.push(cur);
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
