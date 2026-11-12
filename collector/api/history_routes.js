/* The series behind a page's hero tile, in one request.
   ─────────────────────────────────────────────────────────────────────────
   GET /api/history?page=<page>[&metrics=a,b][&from=&to= | &days= | &period=]
                   [&fleet=][&platform=][&id=<account>][&start=HH:MM]

   The Arkiv redesign puts a sparkline under the hero figure of a page
   (docs/UI-REDESIGN-PLAN.md §3, "glanceTile … spark"). Five pages already
   draw theirs from a series their own payload carries — #overview and #demand
   from /api/trips/daily and the hourly profile, #finance from
   /api/finance/daily, #reconcile from its months, #causes from the monthly
   trend. Three could not, and the plan said so in as many words:

     #online-time  "The Late sparkline … needs one /api/online-time request
                    per day (15 per page load), or a history endpoint that
                    does not exist. Drop it unless that endpoint is built."
     #performer    "The weekly-money sparkline in the hero: it needs one
                    economics request per past week and there is no history
                    endpoint."
     #deposits     "The sparkline on 'Drivers carrying a ceiling': the payload
                    holds no series for it."

   and a fourth, #cancellations, was marked "needs a per-day series added to
   /api/cancellations … needs a new endpoint". This is that endpoint. A page
   names itself and, optionally, which of its series it wants; the answer is
   every one of them, over the window, in one round trip — so a page makes at
   most one request more than it did.

   THREE RULES, each the house principle applied to a line on a tile.

   1. ROLL-UPS ONLY. Every series is read from a table the collector refreshes
      (rollup_day, driver_day, and the two v119 added for exactly this,
      driver_first_online and cash_fare_day), never by aggregating a raw feed
      on a page load. A sparkline is decoration on a figure the page already
      paid for; it must not cost what the figure cost. The response cache
      (api/cache.js) keys it on the full URL and the data version like every
      other read.

   2. A POINT THAT WAS NOT MEASURED IS NULL WITH ITS REASON. Each point is
      `{ d, v, why }`. `v` null means the line breaks there (charts.js spark
      draws a null as a GAP, SPEC §5) and `why` says what is missing, in a
      sentence that is true of that day: today still being collected, a day
      the roll-up has not been built for, a day no booking channel reported
      anything, a day before Uber's timeline record begins. Never a zero
      standing in for any of those. A whole series that cannot be drawn is
      `absent` with its reason and carries no points.

   3. THE SAME FIGURE AS THE TILE IT SITS UNDER, OR IT SAYS WHERE IT DIFFERS.
      Late is counted the way /api/online-time counts it (the same people,
      folded the same way, the same minute arithmetic); cancellations are the
      outcome /api/cancellations totals; the cash ceiling is the sum
      /api/ledger/exposure makes, over the people the ledger lists. The one
      exception is named in its own `basis`: a person's weekly money comes
      from the driver-day record, which takes the platform statement where
      one covers the day and the trip fares where none does, while the
      #performer hero is the economics ledger's per-channel choice — so a
      week that ledger counts on a payout can differ, and the response says
      so rather than letting a reader assume otherwise.

   The fleet chip is honoured by every series (and the channel chip where the
   series has channels). Pages that hide the chips (#online-time, #deposits)
   simply never send them. */
import { winDays } from './window.js';
import { dubaiIso } from '../src/util.js';
import { startMinutes } from './online_routes.js';
import { TIMELINE_FROM } from './online_hours_routes.js';

const TZ = 'Asia/Dubai';
const ISO = /^\d{4}-\d{2}-\d{2}$/;
/* More than a year of days and two years of weeks: wider than any span a page
   asks for (the range picker's longest window is 365 days), so a page is never
   cut, while an open window cannot ask for 36,000 empty points. When the span
   IS cut the response says so in `cut`. */
export const DAY_CAP = 400;
export const WEEK_CAP = 104;

/* ── calendar arithmetic on Dubai day strings ───────────────────────────── */
const at0 = (d) => new Date(`${d}T00:00:00Z`);
export const addDays = (d, n) => { const x = at0(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const mondayOf = (d) => { const x = at0(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x.toISOString().slice(0, 10); };
const daysFrom = (a, b) => Math.round((at0(b) - at0(a)) / 864e5);
const num = (v) => (v == null || v === '' ? null : Number(v));
const r2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
/* The Dubai day an instant falls on — the day a roll-up pass ran on. A day is
   complete in a table only when the pass that built it began AFTER the day
   ended, i.e. on a later Dubai day. */
const dayOf = (ts) => (ts ? dubaiIso(new Date(ts)) : null);
const ddmmm = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB',
  { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/* ── what each series is ───────────────────────────────────────────────── */
/* `basis` is printed by the page beside the line (the tile's tooltip), so it
   is written for the operator: what the line counts, from where, and where it
   can part company with the figure above it. */
export const METRICS = {
  bookings: { grain: 'day', label: 'Bookings', unit: 'bookings', source: 'rollup_day', col: 'bookings',
    basis: 'Bookings per Dubai day on every booking channel (telematics journeys excluded), from the day roll-up — the series /api/trips/daily serves. Complete days only.' },
  completed: { grain: 'day', label: 'Completed', unit: 'bookings', source: 'rollup_day', col: 'completed',
    basis: 'Bookings that completed, per Dubai day, from the day roll-up. Complete days only.' },
  cancelled: { grain: 'day', label: 'Cancellations', unit: 'bookings', source: 'rollup_day', col: 'not_completed',
    basis: 'Bookings that did not complete (outcome not_completed), per Dubai day, from the day roll-up — the outcome /api/cancellations totals over its window. Complete days only.' },
  km: { grain: 'day', label: 'Distance', unit: 'km', source: 'rollup_day', col: 'km',
    basis: 'Booked distance per Dubai day over the bookings that carry one, from the day roll-up. Complete days only.' },
  revenue: { grain: 'day', label: 'Trip value', unit: 'AED', source: 'rollup_day', col: 'revenue',
    basis: 'Fares on priced bookings per Dubai day, from the day roll-up. Complete days only.' },
  late: { grain: 'day', label: 'Late', unit: 'people', source: 'driver_first_online',
    basis: 'People whose first ONLINE event on Uber’s timeline that day came after the expected start — counted the way /api/online-time counts its Late tile: everyone holding an Uber account on the roster plus anyone who drove Uber that day, folded to the person, judged on the minute. From driver_first_online, built after each collection. Complete days only.' },
  money: { grain: 'week', label: 'Money', unit: 'AED', source: 'driver_day',
    basis: 'This person’s money per Monday-to-Sunday week from the driver-day record (driver_day.money): the platform statement’s net where a statement covers the day, the trip fares where none does — every account folded into the person. The hero figure above is the economics ledger’s choice per channel, so a week it counts on a payout can differ from this line. Whole weeks only.' },
  cash_ceiling: { grain: 'week', label: 'Ceiling on cash outstanding', unit: 'AED', source: 'cash_fare_day',
    basis: 'Every cash fare on record by the end of each week, over the people the ledger lists — the ceiling the hero states, cut at each week’s end (the last point is as of the roll-up’s last build). A running total: it only rises, and how steeply is how much cash came in.' },
  cash_carriers: { grain: 'week', label: 'Drivers carrying a ceiling', unit: 'drivers', source: 'cash_fare_day',
    basis: 'People on the ledger with a valued cash fare on record by the end of each week — the tile’s count, cut at each week’s end.' },
};

/* Which series each page's tiles carry, its grain, and the span it draws when
   it names no window. */
export const PAGES = {
  'online-time': { grain: 'day', span: 14, metrics: ['late'] },
  performer: { grain: 'week', span: 12, metrics: ['money'], needs: 'id' },
  deposits: { grain: 'week', span: 12, metrics: ['cash_ceiling', 'cash_carriers'] },
  cancellations: { grain: 'day', span: 30, metrics: ['cancelled'] },
  /* #overview draws its four from /api/trips/daily, which it fetches anyway;
     answered here too so any page can have the same line from the same table
     without fetching the whole daily payload. */
  overview: { grain: 'day', span: 30, metrics: ['bookings', 'km', 'revenue', 'completed'] },
};

const TODAY_WHY = 'today is still being collected, so it is not drawn as a finished day';
const notBuiltWhy = (what, ts) => `the ${what} was last built ${ts ? `on ${ddmmm(dayOf(ts))}` : 'before this'}, `
  + 'before this day was over — it is not drawn until a pass has run after it';

/* THE WINDOW. A page that names none gets its own span ending today. A window
   reaching past today is cut at today — the future holds no history — and one
   wider than the cap keeps its most recent end. */
export function historyWindow(req, P, today) {
  const named = ['from', 'to', 'day', 'days', 'period'].some((k) => req.query[k] != null && req.query[k] !== '');
  let [from, to] = named ? winDays(req) : [null, null];
  if (!named) {
    to = today;
    from = P.grain === 'week' ? addDays(mondayOf(today), -7 * (P.span - 1)) : addDays(today, -(P.span - 1));
  }
  if (to > today) to = today;
  if (from > to) return { from, to, future: true, cut: null };
  let cut = null;
  if (P.grain === 'week') {
    const weeks = daysFrom(mondayOf(from), mondayOf(to)) / 7 + 1;
    if (weeks > WEEK_CAP) {
      from = addDays(mondayOf(to), -7 * (WEEK_CAP - 1));
      cut = `the span asked for holds ${weeks} weeks; the history answers the last ${WEEK_CAP}`;
    }
  } else {
    const days = daysFrom(from, to) + 1;
    if (days > DAY_CAP) {
      from = addDays(to, -(DAY_CAP - 1));
      cut = `the span asked for holds ${days} days; the history answers the last ${DAY_CAP}`;
    }
  }
  return { from, to, future: false, cut };
}

/* Absent: the whole series, with its reason and no points. */
const absentSeries = (metric, why) => ({ metric, ...meta(metric), absent: why, points: [], measured: 0, of: 0 });
function meta(metric) {
  const m = METRICS[metric];
  return { label: m.label, unit: m.unit, grain: m.grain, source: m.source, basis: m.basis };
}
const finish = (metric, points, extra = {}) => ({
  metric, ...meta(metric), absent: null, ...extra, points,
  measured: points.filter((p) => p.v != null).length, of: points.length,
});

/* When a rollup_state pass last finished, and whether it finished well. The
   row says 'running' while a pass is in flight and keeps the PREVIOUS finish
   meanwhile, which is the conservative answer for "built through which day".
   A pass that FAILED stamps finished_at too (src/rollup.js runOne), so its
   time says nothing about what the table holds: the table is whatever the
   last good pass wrote, from a time this row no longer records. */
async function passFinished(q, name) {
  const [r] = await q(`SELECT status, finished_at, error FROM rollup_state WHERE name = $1`, [name]);
  return r?.finished_at ? { at: r.finished_at, failed: r.status === 'error' } : null;
}
const FAILED_WHY = (what) => `the ${what}'s last pass failed, so what it holds may be a pass behind and the day it `
  + 'was last built is not known — the line is drawn again once a pass succeeds';
async function buildOf(q, name) {
  const [r] = await q(`SELECT read_at, built_from::text AS built_from FROM history_rollup_build WHERE name = $1`, [name]);
  return r ? { read_at: r.read_at, built_from: String(r.built_from).slice(0, 10) } : null;
}

/* ── rollup_day: bookings, completed, cancellations, distance, trip value ── */
/* A DAY NOBODY COLLECTED IS NOT A DAY NOBODY BOOKED, and the cheap way to tell.
   /api/trips/daily judges collection from source_day_coverage, a view that
   groups the WHOLE trip table on every request (the audit of 2026-11-12 found
   its percentile among the slowest statements on production). This reads
   only the roll-up: the unfiltered row of a day says whether ANY booking
   channel reported anything, and a filtered row that is missing on a day the
   fleet did report cannot say whether that channel was quiet or not
   collected — so it is not drawn as zero; it is drawn as a gap and says
   exactly that. A filtered row that exists is a channel that reported, and
   its zero cancellations are a real zero. */
async function rollupDaySeries(q, metrics, { from, to, today, platform, fleet }) {
  if (platform === 'fms') {
    const why = 'FMS is the trackers\u2019 feed, not a booking channel — it records journeys, never bookings, so this line has nothing to count';
    return Object.fromEntries(metrics.map((m) => [m, absentSeries(m, why)]));
  }
  const pass = await passFinished(q, 'rollup_day');
  if (!pass || pass.failed) {
    const why = pass ? FAILED_WHY('day roll-up')
      : 'the day roll-up has not been built yet — the collector builds it after each collection run';
    return Object.fromEntries(metrics.map((m) => [m, absentSeries(m, why)]));
  }
  const finished = pass.at;
  const builtTo = dayOf(finished);
  const rows = await q(
    `WITH cal AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d)
     SELECT to_char(cal.d, 'YYYY-MM-DD') AS d,
            a.bookings AS all_bookings, a.telematics AS all_telematics,
            m.bookings, m.completed, m.not_completed, m.km, m.revenue
       FROM cal
       LEFT JOIN rollup_day a ON a.day = cal.d AND a.platform = '*' AND a.fleet_id = '*'
       LEFT JOIN rollup_day m ON m.day = cal.d AND m.platform = coalesce($3, '*') AND m.fleet_id = coalesce($4, '*')
      ORDER BY cal.d`, [from, to, platform, fleet]);
  const filtered = !!(platform || fleet);
  const what = platform && fleet ? 'channel and fleet' : platform ? 'channel' : 'fleet';
  const out = {};
  for (const metric of metrics) {
    const col = METRICS[metric].col;
    const points = rows.map((r) => {
      const p = { d: r.d, v: null, why: null };
      if (r.d >= today) p.why = TODAY_WHY;
      else if (r.d >= builtTo) p.why = notBuiltWhy('day roll-up', finished);
      else if (!num(r.all_bookings)) {
        p.why = 'no booking channel reported anything on this day'
          + (num(r.all_telematics) ? ' — only the telematics feed did' : '');
      } else if (filtered && !num(r.bookings)) {
        p.why = `no booking in this ${what} on this day, while the fleet's other channels reported — a quiet day and a day `
          + `this ${what} was not collected look the same in the roll-up, so it is not drawn as zero`;
      } else if (r[col] == null) {
        /* Reachable for the two measures a booking may not carry. A count on a
           row that exists is never null, so the third wording is a guard that
           names the table rather than borrowing a sentence about fares. */
        p.why = col === 'km' ? 'no booking on this day carries a distance'
          : col === 'revenue' ? 'no booking on this day carries a price'
            : 'the day roll-up holds no count for this day';
      } else p.v = col === 'km' || col === 'revenue' ? r2(r[col]) : Number(r[col]);
      return p;
    });
    out[metric] = finish(metric, points, { built: { rollup_day: finished } });
  }
  return out;
}

/* ── #online-time: Late, for any expected start ─────────────────────────── */
/* The people are /api/online-time's (api/online_routes.js): everyone holding
   an Uber account on driver_platform_state, plus — per day — anyone who drove
   Uber that day, each folded to the person by the stored key (an account
   nobody named keys on itself). A person's first online instant is the
   earliest over the accounts that put them on the page that day. Late is
   that instant's Dubai minute AFTER the start — the page's `onlineMin >
   start` — and a person with no ONLINE event that day is never late, they are
   one of the page's grey states.

   Who drove comes from driver_day, the roll-up of the same trips the page
   reads (trips > 0 with uber among the day's platforms), so the series reads
   no raw table at all. */
const START_WHY = (raw) => (String(raw ?? '').trim() === ''
  ? 'No start time was set, so nobody is marked late or on time.'
  : `"${String(raw).trim().slice(0, 20)}" is not a time this page can read. Give it as HH:MM on a 24-hour clock — `
    + '06:00, not 6am — and nobody is judged until it can be.');

async function lateSeries(q, { from, to, today, fleet, platform, startRaw }) {
  const start = startMinutes(startRaw);
  if (start == null) return absentSeries('late', START_WHY(startRaw));
  if (platform && platform !== 'uber') {
    return absentSeries('late', `Late is judged on Uber's timeline — the only feed here that reports anybody coming online — so a ${platform} filter leaves nobody to judge`);
  }
  const build = await buildOf(q, 'driver_first_online');
  if (!build) {
    return absentSeries('late', 'the first-online roll-up has not been built yet — the collector builds it after each collection run, and in full at boot and every night');
  }
  /* HOW FAR THE TIMELINE HAD BEEN READ when the roll-up last read it. A day is
     final only once every fleet's timeline run has passed its end: Uber's
     timeline is fetched every three hours, two days at a time, so the evening
     of the last day can still be arriving. Per fleet, with a run that names no
     fleet counting for all of them, and the earliest fleet deciding. */
  const runs = await q(
    `SELECT fleet_id, max(finished_at) AS at FROM collection_run
      WHERE source = 'uber_timeline' AND status <> 'error' AND finished_at <= $1::timestamptz
        AND ($2::text IS NULL OR fleet_id = $2 OR fleet_id IS NULL)
      GROUP BY fleet_id`, [build.read_at, fleet]);
  const anyFleet = runs.find((r) => r.fleet_id == null)?.at || null;
  const perFleet = runs.filter((r) => r.fleet_id != null)
    .map((r) => Math.max(new Date(r.at).getTime(), anyFleet ? new Date(anyFleet).getTime() : 0));
  const readTo = perFleet.length ? new Date(Math.min(...perFleet)) : (anyFleet ? new Date(anyFleet) : null);
  const readDay = readTo ? dubaiIso(readTo) : null;

  const rows = await q(
    `WITH cal AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d),
     roster AS (
       SELECT DISTINCT coalesce(nullif(person_key, ''), driver_ext_id) AS pk, driver_ext_id AS acct
         FROM driver_platform_state
        WHERE platform = 'uber' AND coalesce(btrim(driver_ext_id), '') <> ''
          AND ($4::text IS NULL OR fleet_id = $4)),
     drove AS (
       SELECT DISTINCT day AS d, coalesce(nullif(person_key, ''), driver_ext_id) AS pk, driver_ext_id AS acct
         FROM driver_day
        WHERE day BETWEEN $1::date AND $2::date AND trips > 0 AND 'uber' = ANY(platforms)
          AND ($4::text IS NULL OR fleet_id = $4)),
     pd AS (SELECT cal.d, r.pk, r.acct FROM cal CROSS JOIN roster r
            UNION SELECT d, pk, acct FROM drove),
     firsts AS (
       SELECT pd.d, pd.pk, min(f.first_online_at) AS first_at
         FROM pd JOIN driver_first_online f
           ON f.platform = 'uber' AND f.driver_ext_id = pd.acct AND f.day = pd.d
        GROUP BY 1, 2),
     seen AS (
       SELECT day AS d, count(*)::int AS accounts FROM driver_first_online
        WHERE platform = 'uber' AND day BETWEEN $1::date AND $2::date
          AND ($4::text IS NULL OR fleet_id = $4)
        GROUP BY 1)
     SELECT to_char(cal.d, 'YYYY-MM-DD') AS d,
            count(f.pk)::int AS reported,
            count(f.pk) FILTER (WHERE (extract(hour FROM f.first_at AT TIME ZONE '${TZ}') * 60
                                       + extract(minute FROM f.first_at AT TIME ZONE '${TZ}')) > $3::int)::int AS late,
            coalesce(max(seen.accounts), 0)::int AS accounts_seen
       FROM cal
       LEFT JOIN firsts f ON f.d = cal.d
       LEFT JOIN seen ON seen.d = cal.d
      GROUP BY cal.d ORDER BY cal.d`, [from, to, start, fleet]);

  const points = rows.map((r) => {
    const p = { d: r.d, v: null, why: null };
    if (r.d >= today) p.why = `${TODAY_WHY} — Uber's timeline arrives every three hours, so today's figure is the tile's, not a finished day`;
    else if (r.d < TIMELINE_FROM) p.why = `Uber's timeline record here begins on ${ddmmm(TIMELINE_FROM)}; nothing before it was kept, and Uber's own window is 31 days`;
    else if (r.d < build.built_from) p.why = `the first-online roll-up has been built back to ${ddmmm(build.built_from)} so far; the nightly full pass builds the days before it`;
    else if (!readDay || r.d >= readDay) {
      p.why = readTo
        ? `Uber's timeline had been read only to ${ddmmm(readDay)} when the roll-up last ran, so this day's last online events may still be arriving`
        : 'no Uber timeline run had finished when the roll-up last ran, so this day has not been read';
    } else if (!r.accounts_seen) p.why = 'no Uber account has an online event on this day — the timeline did not reach it, so nobody can be judged late or on time';
    else { p.v = r.late; p.reported = r.reported; }
    return p;
  });
  const hh = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
  return finish('late', points, { expected_start: hh, built: { driver_first_online: build.read_at, timeline_read_to: readTo } });
}

/* ── #performer: one person's money, week by week ───────────────────────── */
async function moneySeries(q, { from, to, today, fleet, platform, id }) {
  const pass = await passFinished(q, 'driver_day');
  if (!pass) return absentSeries('money', 'the driver-day roll-up has not been built yet — the collector builds it after each collection run');
  if (pass.failed) return absentSeries('money', FAILED_WHY('driver-day roll-up'));
  const finished = pass.at;
  /* The person, by the stored fold, so a second account's weeks are this
     person's weeks — the economics row the hero reads folds the same way. */
  const [who] = await q(
    `SELECT person_key FROM driver_day WHERE driver_ext_id = $1
      ORDER BY (person_key IS NULL OR person_key = ''), day DESC LIMIT 1`, [id]);
  if (!who) return absentSeries('money', 'no day record holds this account — the driver-day roll-up has never seen it, so it has no weeks to draw');
  const byPerson = who.person_key != null && who.person_key !== '';
  const w0 = mondayOf(from), w1 = mondayOf(to);
  const rows = await q(
    `WITH w AS (SELECT generate_series($1::date, $2::date, interval '7 days')::date AS wk),
     acc AS (
       SELECT DISTINCT driver_ext_id FROM driver_day
        WHERE ${byPerson ? 'person_key = $3' : 'driver_ext_id = $3'}
          AND ($5::text IS NULL OR $5 = ANY(platforms))),
     dd AS (
       SELECT d.day, d.trips, d.money, d.money_source FROM driver_day d
        WHERE d.driver_ext_id IN (SELECT driver_ext_id FROM acc)
          AND d.day BETWEEN $1::date AND ($2::date + 6)
          AND ($4::text IS NULL OR d.fleet_id = $4))
     SELECT to_char(w.wk, 'YYYY-MM-DD') AS d,
            sum(dd.money) AS money,
            count(dd.money)::int AS money_days,
            coalesce(sum(dd.trips), 0)::int AS bookings,
            count(dd.day) FILTER (WHERE dd.trips > 0)::int AS worked_days,
            array_remove(array_agg(DISTINCT dd.money_source) FILTER (WHERE dd.money IS NOT NULL), NULL) AS sources
       FROM w LEFT JOIN dd ON dd.day BETWEEN w.wk AND w.wk + 6
      GROUP BY w.wk ORDER BY w.wk`, [w0, w1, byPerson ? who.person_key : id, fleet, platform]);
  const builtTo = dayOf(finished);
  const points = rows.map((r) => {
    const end = addDays(r.d, 6);
    const p = { d: r.d, v: null, why: null };
    if (end >= today) {
      const n = Math.min(7, daysFrom(r.d, today) + 1);
      p.why = `this week is still running — ${n} of its 7 days so far`;
    } else if (end >= builtTo) p.why = notBuiltWhy('driver-day roll-up', finished).replace('this day was', 'this week was');
    else if (r.money == null) {
      p.why = r.bookings
        ? `${r.bookings} booking${r.bookings === 1 ? '' : 's'} this week, and no statement or priced fare covers ${r.bookings === 1 ? 'it' : 'them'} yet`
        : 'no booking and no money on record for this person this week';
    } else {
      p.v = r2(r.money);
      p.money_days = r.money_days;
      p.sources = r.sources || [];
    }
    return p;
  });
  return finish('money', points, { person: byPerson ? 'folded' : 'account', built: { driver_day: finished } });
}

/* ── #deposits: the cash ceiling and who carries one, cut at each week ──── */
/* The people are the ledger's: the person spine (`driver`, with a name — the
   directory /api/ledger/people lists only named people) and its attached
   accounts (driver_platform_id, detached_at IS NULL), exactly the join
   /api/ledger/exposure's `taken` CTE makes before #deposits sums the hero. A
   cash trip on an account the spine has not attached reaches nobody's ceiling
   there, and reaches none here. */
async function cashSeries(q, metrics, { from, to, today, fleet, platform }) {
  const build = await buildOf(q, 'cash_fare_day');
  const none = (why) => Object.fromEntries(metrics.map((m) => [m, absentSeries(m, why)]));
  if (!build) return none('the cash-fare roll-up has not been built yet — the collector builds it after each collection run, and in full at boot and every night');
  /* A running total needs every cash fare since the first. A table built back
     only part of the way would draw a ceiling that starts at the wrong height
     and a carrier count that starts too low — wrong at every point, not just
     the early ones — so it is not drawn until the full pass has run. */
  if (build.built_from > '1900-01-01') {
    return none(`the cash-fare roll-up has been built back to ${ddmmm(build.built_from)} only, and a running total needs every cash fare since the first; the nightly full pass builds the rest`);
  }
  const readDay = dayOf(build.read_at);
  const rows = await q(
    `WITH w AS (SELECT generate_series($1::date, $2::date, interval '7 days')::date AS wk),
     c AS (
       SELECT a.driver_id, cf.day, cf.value
         FROM cash_fare_day cf
         JOIN driver_platform_id a ON a.external_id = cf.driver_ext_id AND a.detached_at IS NULL
         JOIN driver dr ON dr.id = a.driver_id AND coalesce(dr.full_name, '') <> ''
        WHERE ($3::text IS NULL OR cf.fleet_id = $3) AND ($4::text IS NULL OR cf.platform = $4))
     SELECT to_char(w.wk, 'YYYY-MM-DD') AS d,
            to_char(least(w.wk + 6, $5::date), 'YYYY-MM-DD') AS as_of,
            (SELECT sum(c.value) FROM c WHERE c.day <= least(w.wk + 6, $5::date)) AS ceiling,
            (SELECT count(DISTINCT c.driver_id) FROM c
              WHERE c.value IS NOT NULL AND c.day <= least(w.wk + 6, $5::date))::int AS carriers
       FROM w ORDER BY w.wk`, [mondayOf(from), mondayOf(to), fleet, platform, today]);
  const out = {};
  for (const metric of metrics) {
    const points = rows.map((r) => {
      const p = { d: r.d, as_of: r.as_of, v: null, why: null };
      /* A stock as of a day the roll-up has not read is the stock as of the
         last read, drawn flat — which would claim no cash came in. */
      if (r.as_of > readDay) p.why = `the cash-fare roll-up was last built on ${ddmmm(readDay)}, before this week's end`;
      else if (r.ceiling == null) p.why = `no valued cash fare is on record for anyone here by ${ddmmm(r.as_of)}`;
      else p.v = metric === 'cash_ceiling' ? r2(r.ceiling) : Number(r.carriers);
      return p;
    });
    out[metric] = finish(metric, points, { as_of: build.read_at, built: { cash_fare_day: build.read_at } });
  }
  return out;
}

export function historyRoutes(app, { q, wrap }) {
  app.get('/api/history', wrap(async (req, res) => {
    const page = String(req.query.page || '');
    const P = PAGES[page];
    if (!P) {
      return res.status(400).json({ error: 'page must name a page whose hero carries a history',
        pages: Object.keys(PAGES) });
    }
    const asked = req.query.metrics
      ? [...new Set(String(req.query.metrics).split(',').map((s) => s.trim()).filter(Boolean))]
      : P.metrics;
    const bad = asked.filter((m) => !P.metrics.includes(m));
    if (!asked.length || bad.length) {
      return res.status(400).json({ error: `#${page} carries no series called ${bad.join(', ') || '(nothing)'}`,
        metrics: P.metrics });
    }
    const id = String(req.query.id || '').trim();
    if (P.needs === 'id' && !id) {
      return res.status(400).json({ error: `#${page} is one person's page — name the account with ?id=` });
    }
    const today = dubaiIso();
    const fleet = req.query.fleet ? String(req.query.fleet) : null;
    const platform = req.query.platform ? String(req.query.platform) : null;
    const w = historyWindow(req, P, today);
    const base = { page, grain: P.grain, from: w.from, to: w.to, today, fleet, platform, cut: w.cut };
    if (w.future) {
      const why = 'the window asked for begins after today, so it holds no history yet';
      return res.json({ ...base, series: Object.fromEntries(asked.map((m) => [m, absentSeries(m, why)])) });
    }
    const ctx = { ...w, today, fleet, platform, id, startRaw: req.query.start };
    const series = {};
    const day = asked.filter((m) => METRICS[m].source === 'rollup_day');
    const cash = asked.filter((m) => METRICS[m].source === 'cash_fare_day');
    const parts = await Promise.all([
      day.length ? rollupDaySeries(q, day, ctx) : null,
      cash.length ? cashSeries(q, cash, ctx) : null,
      asked.includes('late') ? lateSeries(q, ctx).then((s) => ({ late: s })) : null,
      asked.includes('money') ? moneySeries(q, ctx).then((s) => ({ money: s })) : null,
    ]);
    for (const p of parts) if (p) Object.assign(series, p);
    /* In the order asked, so a page reading Object.values gets its own order. */
    res.json({ ...base, series: Object.fromEntries(asked.map((m) => [m, series[m]])) });
  }));
}
