// Minimal iCalendar (RFC 5545) parser + serializer. Scoped to what
// Huddle needs: read VEVENTs out of subscribed calendar feeds, and
// emit a single-event VCALENDAR for scheduled-call invites.
//
// Recurrence support is intentionally narrow:
//   - Expanded: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT,
//     UNTIL, BYDAY (weekly), BYMONTHDAY (monthly), and EXDATE.
//   - Not expanded: BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR, RECURRENCE-ID
//     overrides, the numeric BYDAY prefix like "1MO" (first Monday).
//     Events with unsupported rules still emit DTSTART so they remain
//     visible — same behaviour as the pre-RRULE-expansion parser.
//
// Other deliberate omissions:
//   - VTIMEZONE / TZID is not resolved — DTSTART/DTEND with TZID are
//     treated as floating local time. UTC ("Z" suffix) and full
//     date-time forms work correctly. All-day VEVENTs (VALUE=DATE) are
//     surfaced with `allDay: true`.
//   - VTODO / VJOURNAL / alarms are skipped — only VEVENT is parsed.
//
// A fully RFC 5545 compliant parser is a few thousand lines; the
// shortcut above covers the patterns Google/Outlook/iCloud actually
// emit for weekly meetings.
//
// Public API on window.HuddleICS:
//   parse(text, opts?) -> { events: [...] }
//     opts.expandUntil   Date — cap recurrence expansion at this point.
//                        Defaults to ~1 year forward.
//   buildEvent({ uid, title, description, startsAt, durationMin,
//                location, url, organizerName, organizerEmail })
//     -> string  (a complete VCALENDAR document)
//   escapeText(s) -> string  (exposed for tests)
(function () {
  // ---------------------------------------------------------------------------
  // Parsing
  // ---------------------------------------------------------------------------

  // RFC 5545 §3.1 line folding: a long line is broken into multiple
  // lines, each continuation prefixed with a single space or tab.
  // Parsers must rejoin them BEFORE field tokenisation, otherwise a
  // folded SUMMARY would lose half its content. CRLF is the canonical
  // separator but some emitters use LF only — accept both.
  function unfoldLines(text) {
    const out = [];
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

  // Reverse of the text escapes in §3.3.11. The order matters:
  // unescape \\ last so a literal "\\n" stays as "\n" (not a newline).
  function unescapeText(s) {
    return s.replace(/\\([nN,;\\])/g, (_, c) => {
      if (c === 'n' || c === 'N') return '\n';
      if (c === ',') return ',';
      if (c === ';') return ';';
      return '\\';
    });
  }

  // "DTSTART;TZID=America/New_York:20260515T130000" splits into
  //   { name: 'DTSTART', params: { TZID: 'America/New_York' }, value: '20260515T130000' }
  // Parameter values can be quoted to allow colons / commas inside;
  // we don't quote anything we emit, but parsing has to handle them
  // because external feeds do.
  function splitContentLine(line) {
    const colonIdx = findUnquotedColon(line);
    if (colonIdx === -1) return null;
    const left = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    const parts = left.split(';');
    const name = parts[0].toUpperCase();
    const params = {};
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

  function findUnquotedColon(line) {
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === ':' && !inQuotes) return i;
    }
    return -1;
  }

  // RFC 5545 §3.3.4/3.3.5: dates are either YYYYMMDD (date-only) or
  // YYYYMMDDTHHMMSS optionally suffixed with Z for UTC. Anything else
  // (including TZID-qualified local times) is treated as floating —
  // we hand back a Date constructed in the local zone, which matches
  // what most users expect for events without an explicit zone.
  //
  // External feeds can be careless: e.g. 20260230 (Feb 30), or a feed
  // with the year/month transposed. The regex catches gross structural
  // breakage, but JS's Date constructor silently overflows out-of-range
  // components (new Date(2026, 1, 30) → March 2). So after constructing
  // we (a) reject Invalid Date and (b) round-trip-check the calendar
  // fields to refuse silent overflow. Anything that fails returns null
  // and the surrounding VEVENT loop drops the event.
  function parseDate(value, params) {
    const s = (value || '').trim();
    if (!s) return null;
    const isAllDay = (params?.VALUE === 'DATE') || /^\d{8}$/.test(s);
    if (isAllDay) {
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
      if (!m) return null;
      const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), dd = parseInt(m[3], 10);
      const d = new Date(y, mo - 1, dd);
      if (isNaN(d.getTime())
          || d.getFullYear() !== y
          || d.getMonth() !== mo - 1
          || d.getDate() !== dd) return null;
      return { date: d, allDay: true };
    }
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(s);
    if (!m) return null;
    const y = parseInt(m[1], 10), mo = parseInt(m[2], 10), dd = parseInt(m[3], 10);
    const hh = parseInt(m[4], 10), mm = parseInt(m[5], 10), ss = parseInt(m[6], 10);
    const z = m[7];
    let d;
    if (z) {
      d = new Date(Date.UTC(y, mo - 1, dd, hh, mm, ss));
      if (isNaN(d.getTime())
          || d.getUTCFullYear() !== y
          || d.getUTCMonth() !== mo - 1
          || d.getUTCDate() !== dd
          || d.getUTCHours() !== hh
          || d.getUTCMinutes() !== mm
          || d.getUTCSeconds() !== ss) return null;
    } else {
      d = new Date(y, mo - 1, dd, hh, mm, ss);
      if (isNaN(d.getTime())
          || d.getFullYear() !== y
          || d.getMonth() !== mo - 1
          || d.getDate() !== dd
          || d.getHours() !== hh
          || d.getMinutes() !== mm
          || d.getSeconds() !== ss) return null;
    }
    return { date: d, allDay: false };
  }

  // ---------------------------------------------------------------------------
  // RRULE expansion
  //
  // The strategy: parse() collects each VEVENT into a "series" object
  // with its raw rrule + exdate array. When the VEVENT ends, if the
  // event carries a parseable RRULE we expand it into N occurrence
  // events (one per yielded start date, bounded by horizon / COUNT /
  // UNTIL / EXDATE). Events without RRULE pass through unchanged so
  // the contract is identical for non-recurring feeds.
  //
  // Per RFC 5545 every occurrence in a series shares the same UID and
  // is uniquely identified by its RECURRENCE-ID. The calendar list UI
  // needs a per-row key, so for everything past the first occurrence
  // we suffix the UID with the ISO start. The first occurrence keeps
  // the bare UID — preserves the exact behaviour of the prior parser
  // for any existing consumer that keys off UID.
  // ---------------------------------------------------------------------------

  function parseRrule(s) {
    const out = {};
    for (const part of String(s || '').split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const k = part.slice(0, eq).toUpperCase();
      const v = part.slice(eq + 1);
      if (k === 'FREQ') out.freq = v.toUpperCase();
      else if (k === 'INTERVAL') {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) out.interval = n;
      } else if (k === 'COUNT') {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) out.count = n;
      } else if (k === 'UNTIL') {
        const p = parseDate(v, {});
        if (p) out.until = p.date;
      } else if (k === 'BYDAY') {
        out.byday = v.split(',').map(parseDayCode).filter((d) => d !== null);
      } else if (k === 'BYMONTHDAY') {
        out.bymonthday = v.split(',')
          .map((x) => parseInt(x, 10))
          .filter((n) => Number.isFinite(n) && n >= 1 && n <= 31);
      }
    }
    if (!out.freq) return null;
    if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(out.freq)) return null;
    out.interval = out.interval || 1;
    return out;
  }

  function parseDayCode(code) {
    // BYDAY values can be 'MO' or 'MO,1MO,-1FR' for "first Monday" /
    // "last Friday". We strip any numeric prefix and treat the rest
    // as a plain weekday — so an event using "1MO" will still emit on
    // every Monday rather than disappearing, which beats silence.
    const stripped = String(code || '').replace(/^[+-]?\d+/, '').toUpperCase();
    const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
    return Object.prototype.hasOwnProperty.call(map, stripped) ? map[stripped] : null;
  }

  // RFC 5545 default WKST=MO; we use Monday-based weeks to compute
  // interval blocks. (For INTERVAL=1 WKST doesn't matter; only matters
  // for biweekly+ rules with BYDAYs spanning the week boundary.)
  function startOfMondayWeek(d) {
    const out = new Date(d);
    const daysSinceMon = (out.getDay() + 6) % 7;
    out.setDate(out.getDate() - daysSinceMon);
    out.setHours(0, 0, 0, 0);
    return out;
  }

  function expandSeries(event, horizonDate) {
    const rule = parseRrule(event.rrule);
    if (!rule) return [event];
    const horizonMs = horizonDate
      ? horizonDate.getTime()
      : Date.now() + 365 * 24 * 60 * 60 * 1000;
    const effectiveMs = rule.until
      ? Math.min(horizonMs, rule.until.getTime())
      : horizonMs;
    const exdateSet = new Set(event.exdate || []);
    const duration = event.end && event.start
      ? event.end.getTime() - event.start.getTime()
      : 0;

    const out = [];
    let yielded = 0;
    for (const occStart of generateOccurrences(event.start, rule, effectiveMs)) {
      if (rule.count && yielded >= rule.count) break;
      // EXDATE matches by exact start instant. Skip the occurrence but
      // still count it toward COUNT per common-implementation behaviour
      // (RFC 5545 §3.8.5.1 is intentionally vague here; this matches
      // what python-dateutil's `rrule.between()` does).
      if (exdateSet.has(occStart.getTime())) {
        yielded++;
        continue;
      }
      const occEnd = duration > 0 ? new Date(occStart.getTime() + duration) : null;
      const isFirst = yielded === 0;
      out.push({
        ...event,
        uid: isFirst ? event.uid : `${event.uid}/${occStart.toISOString()}`,
        start: occStart,
        end: occEnd,
        _recurringInstance: !isFirst,
      });
      yielded++;
    }
    return out.length ? out : [event];
  }

  function* generateOccurrences(start, rule, horizonMs) {
    // DTSTART is always the first occurrence even if it doesn't strictly
    // satisfy BYDAY/BYMONTHDAY (RFC 5545 §3.8.5.3).
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
      const byday = (rule.byday && rule.byday.length)
        ? rule.byday
        : [start.getDay()];
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
      const bymonthday = (rule.bymonthday && rule.bymonthday.length)
        ? rule.bymonthday
        : [start.getDate()];
      for (let i = 1; i < 1000; i++) {
        const totalMonths = start.getMonth() + i * rule.interval;
        const year = start.getFullYear() + Math.floor(totalMonths / 12);
        const month = ((totalMonths % 12) + 12) % 12;
        for (const dom of bymonthday) {
          // Overflow guard: new Date(2026, 1, 30) silently rolls to Mar 2.
          // We refuse the occurrence instead so Feb-only months work.
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
        // Feb 29 → Mar 1 on non-leap years: drop the occurrence rather
        // than silently shift.
        if (occ.getDate() !== start.getDate()) continue;
        if (occ.getTime() > horizonMs) return;
        yield occ;
      }
    }
  }

  function parse(text, opts) {
    const out = { events: [] };
    if (typeof text !== 'string' || !text.length) return out;
    const expandUntil = opts && opts.expandUntil instanceof Date
      ? opts.expandUntil
      : null;
    const lines = unfoldLines(text);
    let inEvent = false;
    let cur = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === 'BEGIN:VEVENT') {
        inEvent = true;
        cur = {
          uid: '', title: '', description: '', location: '', url: '',
          start: null, end: null, allDay: false, rrule: '',
          exdate: [], raw: {},
        };
        continue;
      }
      if (trimmed === 'END:VEVENT') {
        if (cur && cur.start) {
          if (cur.rrule) {
            for (const occ of expandSeries(cur, expandUntil)) {
              out.events.push(occ);
            }
          } else {
            out.events.push(cur);
          }
        }
        inEvent = false;
        cur = null;
        continue;
      }
      if (!inEvent) continue;
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
          // EXDATE may carry comma-separated values, AND may appear
          // multiple times in one VEVENT — we accumulate into the
          // exdate array (raw[] overwrites, which is why we don't rely
          // on that path for this field).
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
  // Serialisation
  // ---------------------------------------------------------------------------

  function escapeText(s) {
    return String(s ?? '')
      .replace(/\\/g, '\\\\')
      .replace(/\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  // RFC 5545 §3.3.5 UTC date-time form: YYYYMMDDTHHMMSSZ. We always
  // emit UTC; clients can re-display in the viewer's local zone. The
  // alternative — TZID + VTIMEZONE block — would require us to ship
  // the IANA tz database, which isn't worth it for outgoing invites.
  function formatUtc(d) {
    return d.getUTCFullYear()
      + pad2(d.getUTCMonth() + 1)
      + pad2(d.getUTCDate())
      + 'T'
      + pad2(d.getUTCHours())
      + pad2(d.getUTCMinutes())
      + pad2(d.getUTCSeconds())
      + 'Z';
  }

  // §3.1 line folding for emission: any content line longer than 75
  // octets is folded by inserting CRLF + space at 75-octet boundaries.
  // We measure octets via TextEncoder so multi-byte UTF-8 (emoji in
  // a SUMMARY) doesn't get split mid-codepoint.
  function fold(line) {
    const enc = new TextEncoder();
    const bytes = enc.encode(line);
    if (bytes.length <= 75) return line;
    const dec = new TextDecoder();
    const out = [];
    let i = 0;
    while (i < bytes.length) {
      // Walk back to a UTF-8 boundary if we'd split a codepoint.
      let chunkEnd = Math.min(i + 75, bytes.length);
      while (chunkEnd > i && (bytes[chunkEnd] & 0xC0) === 0x80) chunkEnd--;
      out.push(dec.decode(bytes.slice(i, chunkEnd)));
      i = chunkEnd;
    }
    return out.join('\r\n ');
  }

  function buildEvent({ uid, title, description = '', startsAt,
                        durationMin = 30, location = '', url = '',
                        organizerName = '', organizerEmail = '' } = {}) {
    if (!(startsAt instanceof Date) || isNaN(startsAt.getTime())) {
      throw new Error('buildEvent: startsAt must be a valid Date');
    }
    const end = new Date(startsAt.getTime() + durationMin * 60 * 1000);
    const stamp = formatUtc(new Date());
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Huddle//Scheduled Call//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${uid || (cryptoRandom() + '@huddle')}`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${formatUtc(startsAt)}`,
      `DTEND:${formatUtc(end)}`,
      `SUMMARY:${escapeText(title || 'Huddle call')}`,
    ];
    if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
    if (location) lines.push(`LOCATION:${escapeText(location)}`);
    if (url) lines.push(`URL:${escapeText(url)}`);
    if (organizerEmail) {
      const cn = organizerName ? `;CN=${escapeText(organizerName)}` : '';
      lines.push(`ORGANIZER${cn}:mailto:${organizerEmail}`);
    }
    lines.push('END:VEVENT', 'END:VCALENDAR');
    // CRLF terminator per spec — some calendar clients silently drop
    // a file using LF-only.
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  function cryptoRandom() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    // Pre-Chromium-91 / non-secure-context fallback. Not used in
    // production Electron but keeps tests under jsdom happy.
    return 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  window.HuddleICS = {
    parse,
    buildEvent,
    escapeText,
    _internal: {
      unfoldLines, parseDate, fold,
      parseRrule, expandSeries, generateOccurrences,
    },
  };
})();
