/* THE ASSISTANT'S CALENDAR — a person's words about time, turned into two
   Dubai dates, with every assumption said out loud.
   ──────────────────────────────────────────────────────────────────────────
   The chat assistant (api/agent_routes.js) is not allowed to work out dates
   itself. A model asked "last week" on a Monday has three defensible answers
   (the Monday-to-Sunday week just finished, the seven days ending yesterday,
   the seven days ending today) and will pick one silently; asked "December"
   in October it may pick the December that has not happened. Every figure it
   then fetches is a correct figure for the wrong days, which is the failure a
   reader cannot see. So the dates come from here, deterministically, on the
   same Dubai calendar api/window.js gives every page, and the answer carries
   the sentence that says which reading was taken — the chat shows it under
   the answer, so a wrong reading is one glance from being caught.

   What it will not do is guess between readings that differ by more than a
   convention. "1/10" is the 1st of October on this roster's calendar (day
   first, as the UAE writes it) and is said to be; a text it cannot read at
   all comes back unclear, and the assistant asks.

   Days that have not happened are cut off at today and the cut is said — a
   month cannot report days it has not had, the rule api/window.js already
   follows for every page. */
import { dubaiDay } from './window.js';

const DAY_MS = 864e5;
const parse = (d) => new Date(`${d}T00:00:00Z`);
const iso = (dt) => dt.toISOString().slice(0, 10);
export const shiftDay = (d, n) => iso(new Date(parse(d).getTime() + n * DAY_MS));
const dow = (d) => (parse(d).getUTCDay() + 6) % 7;            // 0 = Monday
const weekStart = (d) => shiftDay(d, -dow(d));
const monthEnd = (y, m) => { const x = new Date(Date.UTC(y, m, 1)); x.setUTCDate(0); return iso(x); };
const pad = (n) => String(n).padStart(2, '0');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];
const MONTH_OF = (w) => {
  const s = String(w || '').toLowerCase().replace(/\.$/, '');
  if (s.length < 3) return null;
  const i = MONTHS.findIndex((m) => m === s || (s.length >= 3 && m.startsWith(s)) || (s === 'sept' && m === 'september'));
  return i >= 0 ? i + 1 : null;
};
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_OF = (w) => {
  const s = String(w || '').toLowerCase();
  if (s.length < 3) return null;
  const i = DAYS.findIndex((d) => d === s || d.startsWith(s) || `${d}s` === s);
  return i >= 0 ? i : null;
};
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fourteen: 14, thirty: 30, ninety: 90 };

/* "Mon 28 Sep 2026", "28 Sep – 4 Oct 2026", "1–31 Oct 2026". */
const D_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const M_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function rangeLabel(from, to) {
  const a = parse(from); const b = parse(to);
  const day = (x) => `${D_SHORT[(x.getUTCDay() + 6) % 7]} ${x.getUTCDate()} ${M_SHORT[x.getUTCMonth()]}`;
  if (from === to) return `${day(a)} ${a.getUTCFullYear()}`;
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${day(a)} ${a.getUTCFullYear()} – ${day(b)} ${b.getUTCFullYear()}`;
  return `${day(a)} – ${day(b)} ${b.getUTCFullYear()}`;
}

/* A day written as words or digits: "1 oct", "oct 1", "1st october 2026",
   "2026-10-01", "1/10", "1/10/2026". Returns { d, said } or null, where said
   is the assumption the reading needed (a year filled in, a day-first slash). */
function readDay(s, today) {
  /* "Thursday 1 October 2026": the weekday adds nothing a date does not say
     (and, wrong, would only contradict it), so it is dropped before reading. */
  const t = s.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ')
    .replace(/^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\s+/, '');
  const thisYear = Number(today.slice(0, 4));
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return mk(+m[1], +m[2], +m[3], null);
  m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(t);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    return mk(y, +m[2], +m[1], `${m[1]}/${m[2]} read day first, as dates are written in the UAE`);
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z.]+)(?: (\d{4}))?$/.exec(t);
  if (m && MONTH_OF(m[2])) return mk(m[3] ? +m[3] : null, MONTH_OF(m[2]), +m[1], null);
  m = /^([a-z.]+) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(t);
  if (m && MONTH_OF(m[1])) return mk(m[3] ? +m[3] : null, MONTH_OF(m[1]), +m[2], null);
  return null;

  function mk(y, mo, d, said) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    let year = y;
    let note = said;
    if (year == null) {
      /* No year: the most recent such day that is not in the future. */
      year = thisYear;
      if (`${year}-${pad(mo)}-${pad(d)}` > today) year -= 1;
      note = [note, year !== thisYear ? `no year given, so ${year} — the most recent one that has happened` : null]
        .filter(Boolean).join('; ') || null;
    }
    if (d > Number(monthEnd(year, mo).slice(8))) return null;
    return { d: `${year}-${pad(mo)}-${pad(d)}`, said: note };
  }
}

const out = (from, to, today, notes = [], extra = {}) => {
  const said = [...notes];
  let f = from; let t = to;
  if (f > today) return { ok: false, why: `${rangeLabel(from, to)} has not happened yet — today is ${rangeLabel(today, today)}.` };
  if (t > today) { said.push(`cut at today (${rangeLabel(today, today)}): later days have not happened`); t = today; }
  if (f > t) [f, t] = [t, f];
  const partial = t === today;
  if (partial) said.push('today is still running, so today’s figures are so far, not final');
  return { ok: true, from: f, to: t, days: Math.round((parse(t) - parse(f)) / DAY_MS) + 1,
    label: rangeLabel(f, t), partial, assumption: said.filter(Boolean).join('; ') || null, ...extra };
};

/**
 * Resolve a person's words into a Dubai date range.
 * @returns {{ok:true, from, to, days, label, partial, assumption} | {ok:false, why, options?}}
 */
export function resolvePeriod(text, now = Date.now()) {
  const today = dubaiDay(new Date(now));
  const raw = String(text || '').trim();
  const s = raw.toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').replace(/[?!]$/, '').trim();
  if (!s) return { ok: false, why: 'no time was named' };
  const y0 = Number(today.slice(0, 4));
  const m0 = Number(today.slice(5, 7));

  /* Explicit ranges first: "1 oct to 7 oct", "2026-10-01 - 2026-10-07",
     "between 1 sep and 15 sep", "from 3 sep until 9 sep", "1-7 oct". */
  {
    const r = /^(?:from |between )?(.+?) (?:to|until|till|through|and|-|–) (.+)$/.exec(s);
    if (r && !/^(last|past|previous|this)\b/.test(s)) {
      let a = readDay(r[1], today); let b = readDay(r[2], today);
      /* "1 to 7 oct": the month and year written once, on the second date. */
      if (!a && b && /^\d{1,2}(?:st|nd|rd|th)?$/.test(r[1].trim())) {
        a = { d: `${b.d.slice(0, 8)}${pad(parseInt(r[1], 10))}`, said: null };
      }
      if (a && b) return out(a.d, b.d, today, [a.said, b.said]);
    }
    const r2 = /^(\d{1,2})\s*[-–]\s*(\d{1,2}) ([a-z.]+)(?: (\d{4}))?$/.exec(s);
    if (r2 && MONTH_OF(r2[3])) {
      const b = readDay(`${r2[2]} ${r2[3]}${r2[4] ? ` ${r2[4]}` : ''}`, today);
      if (b) return out(`${b.d.slice(0, 8)}${pad(+r2[1])}`, b.d, today, [b.said]);
    }
  }
  /* "since 1 sep", "from 1 sep" — to today. */
  {
    const r = /^(?:since|from|starting|after) (.+)$/.exec(s);
    if (r) {
      const a = readDay(r[1], today);
      if (a) return out(a.d, today, today, [a.said, 'from that day up to today']);
      const mo = MONTH_OF(r[1].split(' ')[0]);
      if (mo) {
        const y = /\d{4}/.test(r[1]) ? Number(/\d{4}/.exec(r[1])[0]) : (mo > m0 ? y0 - 1 : y0);
        return out(`${y}-${pad(mo)}-01`, today, today, ['from the start of that month up to today']);
      }
    }
  }

  /* The future is a different answer from "unreadable": it is perfectly
     clear, and there is nothing to measure in it. */
  if (/^(?:tomorrow|next (?:week|month|year|quarter|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday))$/.test(s)) {
    return { ok: false, future: true, why: `"${raw}" has not happened yet, so there is nothing measured for it. `
      + 'For what is expected, ask about the month target, which projects the month from its pace so far.' };
  }

  switch (s) {
    case 'today': case 'now': case 'so far today': case 'this morning': case 'tonight': case 'this evening':
      return out(today, today, today);
    case 'yesterday': case 'last night':
      return out(shiftDay(today, -1), shiftDay(today, -1), today);
    case 'day before yesterday': case 'the day before yesterday':
      return out(shiftDay(today, -2), shiftDay(today, -2), today);
    case 'this week': case 'week so far': case 'week to date': case 'wtd':
      return out(weekStart(today), today, today, ['this week runs Monday to Sunday']);
    case 'last week': case 'previous week': case 'past week':
      return out(shiftDay(weekStart(today), -7), shiftDay(weekStart(today), -1), today,
        ['last week = the last full Monday-to-Sunday week; say "last 7 days" for the seven days up to today']);
    case 'week before last': case 'the week before last':
      return out(shiftDay(weekStart(today), -14), shiftDay(weekStart(today), -8), today,
        ['the full Monday-to-Sunday week before last week']);
    case 'this month': case 'month so far': case 'month to date': case 'mtd':
      return out(`${today.slice(0, 7)}-01`, today, today);
    case 'last month': case 'previous month': {
      const p = shiftDay(`${today.slice(0, 7)}-01`, -1);
      return out(`${p.slice(0, 7)}-01`, p, today);
    }
    case 'this year': case 'year so far': case 'year to date': case 'ytd':
      return out(`${y0}-01-01`, today, today);
    case 'last year': case 'previous year':
      return out(`${y0 - 1}-01-01`, `${y0 - 1}-12-31`, today);
    case 'this quarter': case 'quarter to date': case 'qtd': {
      const q = Math.floor((m0 - 1) / 3) * 3 + 1;
      return out(`${y0}-${pad(q)}-01`, today, today);
    }
    case 'last quarter': case 'previous quarter': {
      let q = Math.floor((m0 - 1) / 3) * 3 + 1 - 3; let y = y0;
      if (q < 1) { q += 12; y -= 1; }
      return out(`${y}-${pad(q)}-01`, monthEnd(y, q + 2), today);
    }
    case 'this weekend': case 'last weekend': case 'the weekend': case 'weekend': {
      /* The UAE weekend is Saturday and Sunday (since 2022). "The weekend"
         asked midweek is the one just gone; asked on the Saturday or Sunday,
         this one so far. */
      const d = dow(today);
      const sat = d >= 5 && s !== 'last weekend' ? shiftDay(today, 5 - d) : shiftDay(weekStart(today), -2);
      return out(sat, shiftDay(sat, 1), today, ['the weekend is Saturday and Sunday, as in the UAE']);
    }
    case 'all time': case 'ever': case 'since the start': case 'since we started': case 'everything':
      return out('2025-01-01', today, today, ['everything this dashboard holds, from 2025']);
    default: break;
  }

  /* "last 7 days", "past 2 weeks", "last three months": a rolling window
     ending today, the same reading the dashboard's "last N days" uses. */
  {
    const r = /^(?:the )?(?:last|past|previous) (\d+|[a-z]+) (day|days|week|weeks|month|months)$/.exec(s);
    if (r) {
      const n = /^\d+$/.test(r[1]) ? Number(r[1]) : WORD_NUM[r[1]];
      if (n && n > 0 && n <= 1000) {
        const unit = r[2].replace(/s$/, '');
        const days = unit === 'day' ? n : unit === 'week' ? n * 7 : null;
        if (days) return out(shiftDay(today, -(days - 1)), today, today, [`the ${days} days up to and including today`]);
        /* months: the same day n months back, plus one. */
        const back = new Date(Date.UTC(y0, m0 - 1 - n, Number(today.slice(8))));
        return out(shiftDay(iso(back), 1), today, today, [`the ${n} month${n === 1 ? '' : 's'} up to and including today`]);
      }
    }
  }
  /* "3 days ago", "a week ago", "two weeks ago": that one day. */
  {
    const r = /^(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten) (day|days|week|weeks) ago$/.exec(s);
    if (r) {
      const n = /^\d+$/.test(r[1]) ? Number(r[1]) : (r[1] === 'a' || r[1] === 'an' ? 1 : WORD_NUM[r[1]]);
      const back = r[2].startsWith('week') ? n * 7 : n;
      const d = shiftDay(today, -back);
      return out(d, d, today, [`the single day ${back} day${back === 1 ? '' : 's'} before today`]);
    }
  }
  /* "q3", "q3 2026", "2026 q3" */
  {
    const r = /^(?:q([1-4])(?: (\d{4}))?|(\d{4}) q([1-4]))$/.exec(s);
    if (r) {
      const q = Number(r[1] || r[4]);
      let y = Number(r[2] || r[3] || y0);
      const start = (q - 1) * 3 + 1;
      const notes = [];
      if (!r[2] && !r[3] && `${y}-${pad(start)}-01` > today) { y -= 1; notes.push(`no year given, so ${y}`); }
      return out(`${y}-${pad(start)}-01`, monthEnd(y, start + 2), today, notes);
    }
  }
  /* A year on its own: "2025". */
  if (/^\d{4}$/.test(s)) return out(`${s}-01-01`, `${s}-12-31`, today);
  /* A month: "september", "sept 2026", "in august", "the month of may". */
  {
    const t = s.replace(/^(?:in |during |for |the month of |month of )/, '');
    const r = /^([a-z.]+)(?: (\d{4}))?$/.exec(t);
    if (r && MONTH_OF(r[1])) {
      const mo = MONTH_OF(r[1]);
      let y = r[2] ? Number(r[2]) : y0;
      const notes = [];
      if (!r[2] && `${y}-${pad(mo)}-01` > today) { y -= 1; notes.push(`no year given, so ${MONTHS[mo - 1][0].toUpperCase()}${MONTHS[mo - 1].slice(1)} ${y} — the most recent one`); }
      return out(`${y}-${pad(mo)}-01`, monthEnd(y, mo), today, notes);
    }
  }
  /* A weekday: "monday", "on tuesday", "last friday" — the most recent one
     before today. Today's own weekday name means today only when said as
     "this" ("this monday" on a Monday). */
  {
    const r = /^(?:on |last |this |past )?([a-z]+)$/.exec(s);
    if (r && DAY_OF(r[1]) != null) {
      const want = DAY_OF(r[1]);
      const d = dow(today);
      if (s.startsWith('this ') && want === d) return out(today, today, today);
      let back = (d - want + 7) % 7;
      if (back === 0) back = 7;
      return out(shiftDay(today, -back), shiftDay(today, -back), today,
        [`the most recent ${DAYS[want][0].toUpperCase()}${DAYS[want].slice(1)} before today`]);
    }
  }
  /* "week of 28 sep" — the Monday-to-Sunday week containing it. */
  {
    const r = /^(?:the )?week (?:of|starting|beginning|commencing) (.+)$/.exec(s);
    if (r) {
      const a = readDay(r[1], today);
      if (a) return out(weekStart(a.d), shiftDay(weekStart(a.d), 6), today, [a.said, 'the Monday-to-Sunday week containing that day']);
    }
  }
  /* A single day. */
  {
    const a = readDay(s.replace(/^(?:on |the )/, ''), today);
    if (a) return out(a.d, a.d, today, [a.said]);
  }
  return { ok: false, why: `"${raw}" is not a time this assistant can read with confidence`,
    options: ['today', 'yesterday', 'last week (Mon–Sun)', 'last 7 days', 'this month', 'last month'] };
}

/* THE SAME SPAN, EARLIER — "the same day last week", "the same days last
   month", "the week before", "the same period last year". A comparison is
   only fair between like spans, and a model asked for one will compute the
   dates itself unless the calendar does it: on the rehearsal of 2026-10-09
   "the same day last week" came back as yesterday.

     by 'day' | 'week'   every day moved n days / n weeks
     by 'month'          the same calendar days n months earlier; a whole
                         month stays a whole month (September → August, all
                         31 days), and 1–9 October becomes 1–9 September
     by 'year'           the same dates n years earlier
     by 'period'         the span of the same length immediately before
                         (n times), which is what "the previous period" means
                         on every page that compares (api/window.js). */
export function shiftRange(from, to, by, n = -1, now = Date.now()) {
  const today = dubaiDay(new Date(now));
  const len = Math.round((parse(to) - parse(from)) / DAY_MS) + 1;
  const k = Number.isInteger(Number(n)) && Number(n) !== 0 ? Number(n) : -1;
  let f; let t; let said;
  const moveMonths = (d, m) => {
    const y = Number(d.slice(0, 4)); const mo = Number(d.slice(5, 7)) - 1 + m;
    const yy = y + Math.floor(mo / 12); const mm = ((mo % 12) + 12) % 12 + 1;
    const last = Number(monthEnd(yy, mm).slice(8));
    return `${yy}-${pad(mm)}-${pad(Math.min(Number(d.slice(8)), last))}`;
  };
  if (by === 'day' || by === 'week') {
    const step = (by === 'week' ? 7 : 1) * k;
    f = shiftDay(from, step); t = shiftDay(to, step);
    said = `the same ${len === 1 ? 'day' : `${len} days`} ${Math.abs(k)} ${by}${Math.abs(k) === 1 ? '' : 's'} ${k < 0 ? 'earlier' : 'later'}`;
  } else if (by === 'month') {
    const whole = from.slice(8) === '01' && to === monthEnd(Number(to.slice(0, 4)), Number(to.slice(5, 7))) && from.slice(0, 7) === to.slice(0, 7);
    f = moveMonths(from, k);
    t = whole ? monthEnd(Number(f.slice(0, 4)), Number(f.slice(5, 7))) : moveMonths(to, k);
    said = whole ? 'the whole month' : 'the same days of the month';
    said += ` ${Math.abs(k)} month${Math.abs(k) === 1 ? '' : 's'} ${k < 0 ? 'earlier' : 'later'}`;
  } else if (by === 'year') {
    f = moveMonths(from, 12 * k); t = moveMonths(to, 12 * k);
    said = `the same dates ${Math.abs(k)} year${Math.abs(k) === 1 ? '' : 's'} ${k < 0 ? 'earlier' : 'later'}`;
  } else {
    const back = len * Math.abs(k);
    f = shiftDay(from, k < 0 ? -back : back); t = shiftDay(to, k < 0 ? -back : back);
    said = `the ${len} day${len === 1 ? '' : 's'} ${k < 0 ? 'just before' : 'just after'}`;
  }
  return out(f, t, today, [said]);
}
