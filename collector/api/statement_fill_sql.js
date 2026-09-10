/* THE DAY'S OWN MONEY, WHEN THE WEEK'S STATEMENT HAS NOT ARRIVED YET.
   ──────────────────────────────────────────────────────────────────────────
   Uber files this fleet WEEKLY. src/rollup.js:916 divides each statement by
   the days it covers — `p.net / p.days` across
   generate_series(period_start, period_end) — so every Uber day on every page
   is a seventh of a week, and `period_days` is carried beside it so a reader
   knows. That is correct and honest for a week that has CLOSED.

   For a week still running it is neither, and the failure is severe. Measured
   on production 2026-09-10, with the week 7–13 Sept still open:

     31 Aug – 6 Sept (closed)   AED 25,768.69 a day
     7 – 13 Sept     (open)     AED  4,444.39 a day

   an 83% collapse — drawn as six tall bars and then a cliff, on the panel
   whose subject is the money. The fleet's work did not move at all: 675, 787
   and 763 bookings on the 7th, 8th and 9th against 665–820 the week before.
   Two errors compound to produce it. The numerator is whatever Uber has
   settled so far, which lags; and the denominator is the whole seven days,
   three of which have not happened — so the money that HAS been earned is
   spread across days with no work in them.

   ── What we already hold, and it is better ────────────────────────────────
   Uber's per-trip fare is on `trip.price` at Dubai-day grain, for 88–92% of
   bookings (the rest are cancellations, which correctly carry no fare), and
   that gross is the statement's own `fare` line — docs/COVERAGE.md:145 holds
   6/6 fully-priced driver-weeks equal to it to the cent. The statement's net
   is that gross less Uber's commission, and the commission is a CONSTANT this
   fleet can measure rather than a number anyone has to assume.

   Measured over ten closed weeks, 29 June to 6 September 2026:

     net / gross per week   0.7372 0.7458 0.7459 0.7481 0.7484
                            0.7496 0.7497 0.7500 0.7526 0.7449

   a spread of ±1% around 0.7468. And the method was BACKTESTED rather than
   asserted: predicting each closed week's filed net from its own gross times
   the ratio of the weeks BEFORE it is accurate to within 0.42% worst case
   over six consecutive out-of-sample weeks (−0.42, +0.23, −0.16, −0.30,
   +0.39, +0.19). Against that, a smeared open week is 83% low.

   So for a day inside an open statement period this module answers with the
   day's OWN fares at the fleet's own measured commission, and every surface
   that prints it says which of the two bases it used. A closed period keeps
   the statement: that is Uber's own filed number, it reconciles against the
   bank wire, and nothing derived should ever displace it.

   ── What this is NOT ──────────────────────────────────────────────────────
   It is not a forecast. Every figure it produces is built from trips that have
   already happened and fares Uber has already published per trip; the only
   derived quantity is the commission rate, and that is measured, not chosen.
   A day with no trips yet gets no money, not an average.

   It is also not a replacement for asking Uber for daily money. The surfaces
   that might serve that — POST /v1/vehicle-suppliers/transactions and
   analytics-data/query's vs:TotalEarnings — are probed by
   /api/probe/uber/realtime and recorded in docs/COVERAGE.md. If either
   answers, it outranks this. */

/* The fleet's clock, from its one home in src/util.js. Imported rather than
   re-derived: a second `+4 hours` in this file would be a second place for the
   Dubai day to be got wrong, and whether a statement week has closed is
   decided entirely by which day it is here. */
import { dubaiIso } from '../src/util.js';

/* THE OPEN PERIOD, asked WITHOUT the display window.
   ──────────────────────────────────────────────────────────────────────────
   Deliberately unfiltered by from/to. A reader looking at 1–9 September must
   still be told that the 7th, 8th and 9th sit inside a period running to the
   13th — and a query bounded by their window would see a last day of the 9th,
   conclude the period had closed, and print the smear as though it were
   final. The bound belongs to what the reader is looking at; whether a week
   has finished does not. */
export const openStatementSql = () => `
  SELECT platform,
         max(day)::date AS last_day,
         max(period_days)::int AS period_days
    FROM driver_statement_day
   WHERE source <> 'ledger'
     AND ($1::text IS NULL OR platform = $1)
     AND ($2::text IS NULL OR fleet_id = $2)
   GROUP BY 1`;

/* The commission, measured over CLOSED periods only.
   Numerator and denominator over the SAME days by construction — an inner
   join on the day — because a day present on one side and absent on the other
   would move the ratio without either figure being wrong. */
export const commissionSql = () => `
  WITH s AS (
    SELECT platform, day, sum(net) AS net
      FROM driver_statement_day
     WHERE source <> 'ledger'
       AND day BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR platform = $3)
       AND ($4::text IS NULL OR fleet_id = $4)
     GROUP BY 1, 2),
  g AS (
    SELECT platform, local_day AS day, sum(price) AS gross
      FROM trip_norm
     WHERE has_fare AND is_booking
       AND local_day BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR platform = $3)
       AND ($4::text IS NULL OR fleet_id = $4)
     GROUP BY 1, 2)
  SELECT s.platform,
         round(sum(s.net)::numeric, 2)   AS net,
         round(sum(g.gross)::numeric, 2) AS gross,
         count(*)::int                   AS days
    FROM s JOIN g ON g.platform = s.platform AND g.day = s.day
   GROUP BY 1`;

/* BOTH SIDES of each open day: what the smear currently contributes, and the
   gross that will replace it. One query rather than two, because every caller
   needs the pair — the new figure alone cannot correct a window total without
   knowing what it is displacing. A FULL join, so a day with trips and no
   statement row, or a statement row and no trips, still appears; either is a
   real state and neither may silently vanish from an arithmetic correction.

   Small by construction: at most one period, at most its own days. */
export const openDaysSql = () => `
  WITH s AS (
    SELECT platform, day, sum(net) AS net
      FROM driver_statement_day
     WHERE source <> 'ledger'
       AND day BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR platform = $3)
       AND ($4::text IS NULL OR fleet_id = $4)
     GROUP BY 1, 2),
  g AS (
    SELECT platform, local_day AS day, sum(price) AS gross
      FROM trip_norm
     WHERE has_fare AND is_booking
       AND local_day BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR platform = $3)
       AND ($4::text IS NULL OR fleet_id = $4)
     GROUP BY 1, 2)
  SELECT coalesce(s.platform, g.platform) AS platform,
         to_char(coalesce(s.day, g.day), 'YYYY-MM-DD') AS d,
         round(s.net::numeric, 2)   AS statement_net,
         round(g.gross::numeric, 2) AS gross
    FROM s FULL OUTER JOIN g ON g.platform = s.platform AND g.day = s.day`;

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/* Which platforms are mid-period, and over which days.
   `today` is passed rather than read, so a test can put the clock anywhere and
   so this cannot disagree with the Dubai day the rest of the request used. */
export function openPeriods(rows, today) {
  const out = new Map();
  for (const r of rows || []) {
    const last = iso(r.last_day);
    const days = Number(r.period_days) || 1;
    /* A period of ONE day is a day Uber measured, not a week it smeared —
       there is nothing to improve on and nothing to warn about. */
    if (days <= 1 || !last || last < iso(today)) continue;
    const start = new Date(`${last}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    out.set(r.platform, { platform: r.platform, period_days: days,
      open_start: iso(start), open_end: last });
  }
  return out;
}

/* The measured commission, or null with the reason it could not be measured.
   Never a default: a rate nobody measured, applied to real money, is exactly
   the kind of invented figure this product exists not to print. */
export function commissionOf(rows, platform) {
  const r = (rows || []).find((x) => x.platform === platform);
  const gross = r == null ? 0 : Number(r.gross) || 0;
  const net = r == null ? 0 : Number(r.net) || 0;
  if (!r || gross <= 0) {
    return { rate: null, why: 'no closed statement period sits beside a priced day, so this '
      + 'fleet’s commission has never been measured and nothing here will guess it' };
  }
  /* Below 8 days there is not one whole week behind it, and a part-week ratio
     is the same partial-period error this module exists to remove. */
  if ((Number(r.days) || 0) < 8) {
    return { rate: null, days: r.days,
      why: `only ${r.days} closed day(s) carry both a statement and a priced fare — too few to `
        + 'measure a commission from, so the day stays on what the statement says' };
  }
  return { rate: net / gross, days: r.days, net, gross };
}

/* THE SUBSTITUTION, as plain arithmetic a test can run without a database.
   ──────────────────────────────────────────────────────────────────────────
   Returns, per platform, the per-day replacements and the single delta a
   window total has to move by. Both come out of the same loop on purpose: a
   caller that corrected the bars from one calculation and the tile from
   another would be free to disagree with itself, and that drift is the defect
   `/api/finance/daily`'s own reconciliation note was added to catch.

   A day inside the open period contributes `gross × rate` and nothing else. A
   day with no priced trip yet contributes NOTHING rather than an average —
   this is arithmetic over trips that have happened, not a forecast, and the
   difference is the whole reason it is allowed on this page at all. */
export function fillOpenDays({ openDays, periods, rates }) {
  const byDay = new Map();
  /* Per platform as well as in total, because the WINDOW total has to be
     corrected on the platform row that produced it — api/income_sql.js chooses
     one basis per channel, so a delta applied to the wrong channel would move
     a figure that was already right. */
  const byPlatform = new Map();
  /* The derived money in its OWN right, not only as a delta. A caller has to
     be able to say "this much of the total is not a statement" — folding it
     into accounted_statements would put derived money under a name that claims
     Uber filed it. */
  let total = 0;
  let delta = 0, applied = 0;
  for (const r of openDays || []) {
    const per = periods.get(r.platform);
    if (!per) continue;
    /* Per PLATFORM, because the commission is a property of the channel and
       not of the fleet. A channel whose rate could not be measured keeps its
       statement untouched — see commissionOf(), which returns null with a
       reason rather than a default. */
    const rate = rates instanceof Map ? rates.get(r.platform) : rates;
    if (rate == null) continue;
    if (r.d < per.open_start || r.d > per.open_end) continue;
    const was = r.statement_net == null ? 0 : Number(r.statement_net);
    const gross = r.gross == null ? 0 : Number(r.gross);
    /* NULL, not zero, for a day with no priced trip yet.
       ──────────────────────────────────────────────────────────────────────
       The open period runs to the end of its week, so on 2026-09-10 it covers
       the 11th, 12th and 13th — days that have not happened. Returning 0 for
       those states that the fleet earned nothing on them, which is a
       measurement of a day nobody has lived; the house rule is that an
       unmeasurable figure renders absent WITH A REASON and never as zero. The
       smear they carried before is still removed either way — `was` is
       subtracted from the delta below whether or not anything replaces it. */
    const now = gross > 0 ? +(gross * rate).toFixed(2) : null;
    byDay.set(`${r.platform}\u0000${r.d}`, { platform: r.platform, d: r.d, was, gross, now });
    byPlatform.set(r.platform,
      +((byPlatform.get(r.platform) || 0) + ((now ?? 0) - was)).toFixed(2));
    delta += (now ?? 0) - was;
    total += now ?? 0;
    applied++;
  }
  return { byDay, byPlatform, delta: +delta.toFixed(2), total: +total.toFixed(2), applied };
}

/* The sentence every surface prints, built once so the two shells and the two
   endpoints cannot word the same fact differently. */
export function fillNote(per, rate, days) {
  return `Uber files weekly and the week to ${per.open_end} has not closed, so its statement `
    + 'covers only part of what has been earned. These days are instead each day’s own Uber '
    + `fares less Uber’s commission, measured at ${(rate * 100).toFixed(1)}% over the `
    + `${days} closed statement days before it — not a forecast: every fare in it is one Uber `
    + 'has already published against a trip that has already run.';
}

/* THE WHOLE THING, in one call, so the two endpoints cannot do it differently.
   ──────────────────────────────────────────────────────────────────────────
   Two rounds and not one, because the second depends on the first: the
   commission has to be measured over the days BEFORE the open period began,
   and where that boundary falls is what round one establishes. Everything in
   round two is bounded to at most one period, so the cost is two small reads.

   `q` is passed rather than imported — this module is loaded by test/mount.mjs
   with its exports injected as globals, and a database handle reached for at
   module scope is a module that cannot be tested without one. */
export async function resolveOpenFill({ q, from, to, platform, fleet,
  /* Defaulted HERE rather than at the two call sites. Both of them live inside
     the region test/mount.mjs slices out of api/server.js, and server.js's own
     dubaiIso is declared above that region — so a handler that reached for it
     was undefined under the harness and took 23 assertions in
     test/aggregates.test.mjs down with it. A module that needs today's date
     should own how it gets one. */
  today = dubaiIso().slice(0, 10),
  lookbackDays = 56 }) {
  const none = { periods: new Map(), rates: new Map(),
    fill: { byDay: new Map(), byPlatform: new Map(), delta: 0, total: 0, applied: 0 }, notes: [] };
  const periods = openPeriods(await q(openStatementSql(), [platform, fleet]), today);
  if (!periods.size) return none;

  const shift = (d, n) => {
    const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const starts = [...periods.values()].map((p) => p.open_start).sort();
  const cTo = shift(starts[0], -1);
  const cFrom = shift(cTo, -(lookbackDays - 1));

  /* The open days that actually MATTER to this caller: the period, clipped to
     the window being drawn. A window ending before the period began needs none
     of this, and asking anyway would correct days nobody is looking at. */
  const ends = [...periods.values()].map((p) => p.open_end).sort();
  const oFrom = starts[0] > from ? starts[0] : from;
  const oTo = ends[ends.length - 1] < to ? ends[ends.length - 1] : to;
  if (oFrom > oTo) return none;

  const [commRows, openDays] = await Promise.all([
    q(commissionSql(), [cFrom, cTo, platform, fleet]),
    q(openDaysSql(), [oFrom, oTo, platform, fleet]),
  ]);

  const rates = new Map();
  const notes = [];
  for (const per of periods.values()) {
    const c = commissionOf(commRows, per.platform);
    if (c.rate == null) {
      /* Absent WITH the true reason, and the statement is left exactly as it
         was. An unmeasurable commission is a reason to say so, never a reason
         to invent one. */
      notes.push({ platform: per.platform, open_end: per.open_end, rate: null, why: c.why });
      continue;
    }
    rates.set(per.platform, c.rate);
    notes.push({ platform: per.platform, open_end: per.open_end, open_start: per.open_start,
      rate: c.rate, days: c.days, why: fillNote(per, c.rate, c.days) });
  }
  return { periods, rates, notes, fill: fillOpenDays({ openDays, periods, rates }) };
}

/* Move the window total onto the same basis as the days.
   ──────────────────────────────────────────────────────────────────────────
   /api/finance/daily draws bars and prints the tile's own figure beside them
   so a reader can check the two rather than trust them, and it raises a note
   when they drift. Correcting the bars alone would fire that note on every
   open week — the panel accusing itself of the arithmetic it had just been
   taught to do. So the platform row that feeds fleetIncome() moves by the same
   per-platform delta, before the basis is chosen over it. */
export function applyFillToPlatforms(byPlat, fill) {
  if (!fill || !fill.byPlatform || !fill.byPlatform.size) return 0;
  let moved = 0;
  for (const [platform, d] of fill.byPlatform) {
    const row = byPlat.get(platform);
    if (!row || d === 0) continue;
    row.statement_net = +(((row.statement_net == null ? 0 : Number(row.statement_net)) + d)
      .toFixed(2));
    moved += d;
  }
  return +moved.toFixed(2);
}
