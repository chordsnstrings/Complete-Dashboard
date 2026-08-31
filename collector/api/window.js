/* The request window, in one place.
   ─────────────────────────────────────────────────────────────────────────
   Three copies of this lived in server.js, driver_routes.js and
   vehicle_routes.js — near-identical, and drifting. All three read `from` and
   `to` and nothing else.

   That is a problem because the URL a person sees says something different.
   The hash router carries `?days=30`, and the front end translates it into
   from/to before every fetch, so `days` never reaches the server. Ask the API
   directly — from a spreadsheet, a report, a monitoring check, or a debugging
   session — and `?days=30` is not rejected, not defaulted, but silently
   ignored: `from` falls back to 2000-01-01 and the answer is every trip the
   fleet has ever taken, wearing a thirty-day label. On one vehicle that read
   as 2,440 trips and 316 "days worked" inside a thirty-day window, which is
   only obviously wrong because a month has thirty days. The same silence over
   revenue or utilisation would just look like a big number.

   So `days` is honoured here, on the Dubai calendar the rest of the product
   uses, and `from`/`to` still win when given. */

/* Shape AND validity. Two of the three copies this replaces tested only the
   shape, so `from=2026-13-45` — month thirteen, day forty-five — matched the
   regex and was bound straight into SQL, where Postgres rejected the statement
   and the page showed "could not load this view". The round trip through Date
   is what separates a date-shaped string from a date. */
/* A duplicated query parameter arrives as an array — /api/kpis?from=A&from=B
   gives ['A','B'] — and a rejected value falls through to the open window,
   which is every trip ever collected under a thirty-day label. That is the same
   silent-wrong-window failure this file exists to prevent, arriving by a
   different door. The first value wins, which is what a reader typing a URL
   twice would expect and what every proxy in the chain assumes. */
const first = (v) => (Array.isArray(v) ? v[0] : v);

const isDay = (v) => {
  const s = String(first(v) || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// Dubai calendar day for an instant. The fleet's calendar is Dubai's; the
// caller's clock, and the server's UTC session, are not part of the question.
export const dubaiDay = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

/* A `days` window ends TODAY in Dubai and starts days-1 earlier, so `days=1`
   is today and `days=30` is thirty distinct calendar days — matching what the
   front end computes for the same number. An out-of-range or non-numeric
   `days` is ignored rather than clamped to something arbitrary: a caller who
   asked for `days=abc` gets the default window, not a silently invented one. */
export function daysWindow(v, now = Date.now()) {
  // Digits only. Number() would read "1e3" as 1000 and " 30\n" as 30; a query
  // parameter that does not look like a count should not be guessed at.
  if (!/^\d+$/.test(String(first(v) ?? ''))) return null;
  const n = Number(first(v));
  if (!Number.isInteger(n) || n < 1 || n > 3660) return null;
  return [dubaiDay(new Date(now - (n - 1) * 864e5)), dubaiDay(new Date(now))];
}

/* ── calendar periods ─────────────────────────────────────────────────────
   A rolling window and a calendar period are different questions and the
   product only answered the first. "Last 30 days" cannot tell you how August
   went, because on the 12th it is half of July; a board asking "how is this
   month" is not asking for a thirty-day average that straddles two of them.

   So `period` names a real span on the Dubai calendar. `today`, `week` and
   `month` run from the start of the period to TODAY — period-to-date, which is
   the only honest thing to show for a period still running — and the previous_
   forms give the same number of days ending at the same point in the period
   before, so a comparison is like against like rather than a full month
   against a part of one.

   Everything here is computed on Dubai's calendar via dubaiDay, never on the
   server's UTC clock: at 02:00 Dubai those are different dates, and the fleet
   works through that hour. */
const dayMs = 864e5;
const parse = (d) => new Date(`${d}T00:00:00Z`);
const shift = (d, n) => { const x = parse(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/* ISO week: Monday. `getUTCDay()` is Sunday-0, so the offset is (dow+6)%7 —
   which is 0 on a Monday and 6 on a Sunday, rather than the other way round. */
const weekStart = (d) => shift(d, -((parse(d).getUTCDay() + 6) % 7));
const monthStart = (d) => `${d.slice(0, 7)}-01`;

export const PERIODS = ['today', 'yesterday', 'week', 'month', 'quarter', 'year',
  'last_week', 'last_month'];

/* ── a NAMED span, beside the relative ones ───────────────────────────────
   "This month" is the right frame while the month is running and the wrong
   one the moment somebody wants to talk about August. A relative name also
   cannot be sent to anybody: a link saying `period=month` opens on whatever
   month the reader opens it in, so two people reading the same address read
   different data — the same trap the rolling window had, one level up.

   So a span can also be named outright, on the Dubai calendar:

     2026-08     August 2026
     2026-Q3     July to September 2026
     2026        the whole of 2026

   A span that has finished is WHOLE. A span containing today runs to today,
   because a month cannot report days it has not had — the same rule the
   relative names already follow, and the reason `last_month` is whole while
   `month` is to-date.

   Nothing here is clamped to the data: a month before the fleet existed
   returns its own dates and the pages report honestly that they hold nothing
   for it. Clamping would answer a question nobody asked, under a title
   naming the one they did. */
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const QUARTER_RE = /^(\d{4})-[Qq]([1-4])$/;
const YEAR_RE = /^(\d{4})$/;

/* The last day of a month, found by stepping into the next month and back one
   day rather than by a table of lengths — which is the same trick that gets
   February right in a leap year without knowing it is one. */
const monthEnd = (y, m) => {
  const d = new Date(Date.UTC(Number(y), Number(m), 1));
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

/* Every named span this understands, in one place so the parser and the
   validator cannot disagree about what is nameable. */
export function namedWindow(v, now = Date.now()) {
  const name = String(first(v) || '');
  const today = dubaiDay(new Date(now));
  /* A span is truncated only where it CONTAINS today — never where it is
     already over, and never where it has not started. */
  const cap = (from, to) => (to > today ? (from > today ? [from, to] : [from, today]) : [from, to]);

  const mo = MONTH_RE.exec(name);
  if (mo) return cap(`${name}-01`, monthEnd(mo[1], mo[2]));

  const qu = QUARTER_RE.exec(name);
  if (qu) {
    const m0 = (Number(qu[2]) - 1) * 3 + 1;
    return cap(`${qu[1]}-${String(m0).padStart(2, '0')}-01`, monthEnd(qu[1], m0 + 2));
  }

  const yr = YEAR_RE.exec(name);
  if (yr) return cap(`${yr[1]}-01-01`, `${yr[1]}-12-31`);

  return null;
}

/* True for anything `periodWindow` will resolve — a relative name or a named
   span. The front end validates against this rule rather than against the
   relative list alone, so a month in an address survives the round trip. */
export const isPeriod = (v) => PERIODS.includes(String(first(v) || ''))
  || namedWindow(v, Date.now()) != null;

export function periodWindow(v, now = Date.now()) {
  const name = String(first(v) || '');
  if (!PERIODS.includes(name)) return namedWindow(name, now);
  const today = dubaiDay(new Date(now));
  switch (name) {
    case 'today': return [today, today];
    case 'yesterday': { const y = shift(today, -1); return [y, y]; }
    case 'week': return [weekStart(today), today];
    case 'month': return [monthStart(today), today];
    case 'quarter': {
      const m = Number(today.slice(5, 7));
      const q = Math.floor((m - 1) / 3) * 3 + 1;
      return [`${today.slice(0, 4)}-${String(q).padStart(2, '0')}-01`, today];
    }
    case 'year': return [`${today.slice(0, 4)}-01-01`, today];
    /* A WHOLE previous period, not a to-date one: last week and last month are
       finished, so there is nothing to truncate and truncating them would
       throw away days that happened. */
    case 'last_week': { const s2 = shift(weekStart(today), -7); return [s2, shift(s2, 6)]; }
    case 'last_month': {
      const s2 = shift(monthStart(today), -1);
      return [monthStart(s2), s2];
    }
    default: return null;
  }
}

/* The span to compare a window against: the same NUMBER OF DAYS immediately
   before it. For a period-to-date that is the same slice of the period before
   — 1–12 August against 1–12 July — which is the comparison a reader assumes
   when a page says "+21%" and the one that is wrong most often when nobody
   writes it down. */
export function previousWindow([from, to]) {
  const span = Math.round((parse(to) - parse(from)) / dayMs) + 1;
  return [shift(from, -span), shift(from, -1)];
}

/* ── grain ────────────────────────────────────────────────────────────────
   How a window is BUCKETED, which is a separate question from how long it is:
   ninety days can be ninety bars, thirteen, or three, and each answers a
   different question about the same data.

   Left unsaid, it is chosen from the window's own length, because 365 daily
   bars is not a chart and three monthly bars is not a trend. The thresholds
   are where a bar stops being readable, not where the data changes. */
export const GRAINS = ['day', 'week', 'month'];

/* An ABSENT grain means `day`, and that is a compatibility decision rather
   than a default worth arguing about: every caller written before this — the
   product's own pages, a spreadsheet, a monitoring check — asks without a
   grain and expects one row per day. Choosing from the span for them would
   silently reshape a response they already parse, which is the kind of change
   that breaks quietly and elsewhere.

   `grain=auto` is how a caller opts IN to the span-based choice, and it is
   what the dashboard's "Auto grouping" sends. The thresholds are where a bar
   stops being readable, not where the data changes: 365 daily bars is not a
   chart and three monthly bars is not a trend. */
export function autoGrain(from, to) {
  const span = Math.round((parse(to) - parse(from)) / dayMs) + 1;
  if (span <= 45) return 'day';
  if (span <= 300) return 'week';
  return 'month';
}

export function grainOf(req, now = Date.now()) {
  const g = String(first(req?.query?.grain) || '');
  if (GRAINS.includes(g)) return g;
  if (g !== 'auto') return 'day';
  const [from, to] = winDays(req, now);
  return autoGrain(from, to);
}

/* The SQL that buckets a date column at a grain. One expression, used by every
   route that groups over time, so a week means the same thing everywhere it is
   drawn. */
export const bucketSql = (grain, col = 'local_day') => (
  grain === 'month' ? `date_trunc('month', ${col})::date`
    : grain === 'week' ? `date_trunc('week', ${col})::date`
      : `${col}::date`);

/* Calendar-day bounds: `[from, to]` as YYYY-MM-DD, for queries that compare
   against local_day (a date) or apply their own timezone conversion. */
export function winDays(req, now = Date.now()) {
  if (isDay(req.query?.from) || isDay(req.query?.to)) {
    let from = isDay(req.query.from) ? first(req.query.from) : '2000-01-01';
    let to = isDay(req.query.to) ? first(req.query.to) : '2100-01-01';
    if (from > to) [from, to] = [to, from];   // an inverted range is a typo, not an empty set
    return [from, to];
  }
  /* A single `day`, which several routes already take by that name — /api/day
     and /api/map/journey among them. /api/track did not, and silently returned
     every fix it has ever held to a caller who asked for one day: the same
     trap `days` had, one letter apart, on the endpoint next to the one where
     the parameter works. Understood here, it works everywhere. */
  if (isDay(req.query?.day)) return [first(req.query.day), first(req.query.day)];
  /* Before `days`, after explicit dates: a caller who names a period means it,
     and a caller who names both dates and a period has been more specific. */
  return periodWindow(req.query?.period, now)
    || daysWindow(req.query?.days, now)
    || ['2000-01-01', '2100-01-01'];
}

/* Timestamp bounds for tables keyed on a raw timestamptz. The upper bound is
   widened to the end of the day, because a bare date binds as midnight and
   would drop everything that happened on the last day of the window. */
const endOfDay = (d) => (isDay(d) ? `${d} 23:59:59.999` : d);
export function win(req, now = Date.now()) {
  const [from, to] = winDays(req, now);
  return [from, endOfDay(to)];
}

/* Fold a complete day series into week or month buckets.
   ─────────────────────────────────────────────────────────────────────────
   Counts and money sum. Two things do not, and pretending otherwise is how a
   weekly chart starts lying:

     drivers   is a COUNT DISTINCT of people. Summing seven days counts a
               five-day driver five times, which on this fleet turns 118
               people into six hundred. The bucket reports the busiest single
               day instead — a floor, not the answer — and says so in
               `drivers_basis` so a page cannot print it as a headcount.

     the edges are partial. A window ending on a Wednesday ends in a three-day
               week, and drawn beside whole ones that is a collapse the fleet
               did not have. Every bucket carries `days` and `partial`, and the
               chart is expected to mark them.

   `uncollected` is kept as a count rather than a flag: "two of the seven days
   in this week collected nothing" is the fact, and it is the reason a low
   bucket may not be a low week. */
export function foldGrain(rows, grain) {
  if (grain !== 'week' && grain !== 'month') return rows;
  const keyOf = (d) => {
    if (grain === 'month') return `${d.slice(0, 7)}-01`;
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return x.toISOString().slice(0, 10);
  };
  const SUM = ['trips', 'completed', 'cancelled', 'telematics_journeys', 'km', 'revenue',
    'priced_trips'];
  const out = new Map();
  for (const r of rows) {
    const k = keyOf(r.d);
    let b = out.get(k);
    if (!b) {
      b = { d: k, grain, days: 0, partial: false, drivers: 0,
        drivers_basis: 'the busiest single day in this bucket — a floor, because a person works several days',
        uncollected_days: 0, first_day: r.d, last_day: r.d };
      for (const c of SUM) b[c] = null;
      out.set(k, b);
    }
    b.days += 1;
    b.last_day = r.d;
    for (const c of SUM) {
      const v = r[c];
      /* null + 0 is 0, which would report "no fare was collected all week" as
         "the week earned nothing". A bucket stays null until some day in it
         carries a number. */
      if (v == null) continue;
      b[c] = (b[c] == null ? 0 : Number(b[c])) + Number(v);
    }
    b.drivers = Math.max(b.drivers, Number(r.drivers) || 0);
    if (r.uncollected) b.uncollected_days += 1;
  }
  const buckets = [...out.values()];
  for (const b of buckets) {
    const whole = grain === 'week' ? 7
      : new Date(Date.UTC(+b.d.slice(0, 4), +b.d.slice(5, 7), 0)).getUTCDate();
    b.partial = b.days < whole;
    b.of_days = whole;
    b.uncollected = b.uncollected_days > 0 && b.uncollected_days === b.days;
  }
  return buckets;
}
