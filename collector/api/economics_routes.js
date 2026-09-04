/* Unit economics: what one asset, and one person, is worth per day.
   ─────────────────────────────────────────────────────────────────────────
   Every money surface in this product until now answered either "what did the
   fleet take in" (the Revenue page, per channel) or "what did THIS car make"
   (the vehicle page, one plate at a time). Neither answers the question an
   operator actually opens a dashboard to ask:

       which of my assets earn, which of my people earn, and which do neither

   That is a RANKING, and a ranking cannot be built one entity at a time. The
   attribution that puts Uber's weekly driver payout onto the vehicle that
   earned it — api/attribution_sql.js — was written with a plate bound into it
   and used only by /api/vehicle/kpis. Asking it for the whole fleet meant 140
   requests, four seconds each, and the answer still could not be sorted.

   These two endpoints are that same arithmetic, unbound, so the fleet arrives
   as one sortable table with a rate on every row.

   ── What the rates are, and are not ──────────────────────────────────────
   There is no cost table in this database. No fuel, no lease, no insurance
   premium, no salary, no maintenance. So nothing here is a margin and nothing
   here is a profit, and the words are avoided deliberately:

     MONEY IN     per plate or per person: fares where the channel reports one,
                  attributed net payout where it does not, chosen per platform
                  by the same rule the Revenue page and /api/kpis use
                  (api/income_sql.js). Never both for one platform — a payout
                  is what is left of those same fares after commission.

     PER DAY      money in / the days that asset or person actually EARNED. Not
                  calendar days: a car parked for a fortnight has not earned a
                  worse daily rate, it has earned on fewer days, and those are
                  different problems with different remedies. The idle days are
                  reported beside it as their own number.

     PER KM       money in / booked distance. Comparable WITHIN a channel and
                  misleading across them, because Uber's figure is net of
                  commission and the hotel channel's is a gross fare. Stated on
                  the page rather than silently blended.

   "Losing money" therefore means one thing only here: an asset or a person
   consuming time — and, for a vehicle, insurance and registration that are
   being paid for whether or not it moves — while producing little or nothing.
   It does not mean a negative contribution, because a contribution cannot be
   computed from what this database holds. */

import { attributedEarnings, unattributedEarnings } from './attribution_sql.js';
import { fleetIncome, chooseBasis } from './income_sql.js';
import { vehiclesOverWindow } from './custody_sql.js';
/* The alerts-per-distance rule, in one place. Both tables on this page carry a
   safety rate and both were dividing a partial numerator by a whole-window
   denominator; the module says why, and what the covered-day rule assumes. */
import { alertCoverage, alertRate, alertRateReason, drivingCount,
  deviceCount } from './alert_coverage_sql.js';
/* A pg DATE, as the day it holds. Imported rather than re-typed here because
   this trap has already cost this product one production sentence and there
   should be exactly one function that knows the answer. No cycle: ledger.js
   reaches only src/db.js and src/log.js, and api/server.js and test/mount.mjs
   already import it. */
import { isoDay } from '../src/sources/ledger.js';

/* A day as this product writes days everywhere else. */
const dayLabel = (v) => (v == null ? '—'
  : new Date(`${String(v).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dubai' }));

const n = (v) => (v == null ? null : Number(v));
const round = (v, d = 2) => (v == null || !Number.isFinite(Number(v))
  ? null : Math.round(Number(v) * 10 ** d) / 10 ** d);
/* A rate with a zero denominator is not zero and not infinity — it is a
   question that was not asked of anything. Absence renders as an em-dash with
   a reason, so it has to arrive as null rather than as 0. */
const rate = (num, den, d = 2) => (den > 0 && num != null ? round(num / den, d) : null);

export function economicsRoutes(app, { q, wrap, range }) {
  /* The window as whole Dubai days, for the per-day denominators and for the
     idle-day arithmetic. `range` already validated it. */
  const spanDays = (from, to) => Math.max(1, Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1);

  /* When money begins.
     ─────────────────────────────────────────────────────────────────────
     Bank payouts exist from February 2026 and Uber will not serve earlier —
     54 weekly windows were asked and answered empty. Every booking before that
     day is real work that no money will ever be attached to. A year-long view
     of earnings therefore falls off a cliff that is a property of the EXPORT
     and not of the business, and a reader who is not told that reads a
     collapse.

     Measured rather than hardcoded, so the sentence stays true as the record
     grows, and reported with the count of bookings it leaves dark. */
  const moneyCoverage = async (from, to) => {
    /* to_char, not a bare min(day). A DATE arrives from the driver as a JS Date
       whose String() is "Sat Aug 01 2026 …", so slicing ten characters off it
       produced "Sat Aug 01" — which then went back into the next query as a
       date literal and took the whole endpoint down with "invalid input syntax
       for type date". The column is formatted where it is read. */
    const [span] = await q(
      `SELECT to_char(min(day), 'YYYY-MM-DD') first_day,
              to_char(max(day), 'YYYY-MM-DD') last_day
       FROM driver_payout_day`);
    const first = span?.first_day || null;
    /* Asked only when the window can contain a dark day at all, and clamped to
       the part of it that can.
       ────────────────────────────────────────────────────────────────────
       This ran unconditionally and bounded only by the window, so a request
       whose window starts after the first payout still scanned every trip in
       it to count a set the dates already prove empty — and one whose window
       does reach back scanned the whole window rather than the part before the
       money starts. `local_day < first` is exactly `local_day <= first - 1` on
       a date, so the clamp is the same set of rows; `from < first` compares
       two 'YYYY-MM-DD' strings, which for that shape is chronological order
       (api/window.js returns them). Measured at 365 days: 192ms to 8ms, and
       zero at the shorter windows where it was already returning nothing. */
    const [dark] = (first && from < first)
      ? await q(
        `SELECT count(*)::int bookings,
                count(DISTINCT local_day)::int days
         FROM trip_norm
         WHERE local_day BETWEEN $1::date AND least($2::date, $3::date - 1)
           AND is_booking`, [from, to, first])
      : [{ bookings: 0, days: 0 }];
    return {
      first_payout_day: first,
      last_payout_day: span?.last_day || null,
      /* Bookings inside the REQUESTED window that predate any payout. Zero on
         a recent window, which is the common case and the reason this is a
         count rather than a permanent banner. */
      unpayable_bookings: dark?.bookings ?? 0,
      unpayable_days: dark?.days ?? 0,
      note: first
        /* `first` is an ISO day. Written into a sentence a person reads, it
           was the only date in the product still rendered as 2026-02-06. */
        ? `Bank payouts exist from ${dayLabel(first)}. Uber's earnings API serves nothing earlier, `
          + 'so bookings before that date carry no money and never will.'
        : 'No payout has been collected yet, so nothing here has money attached.',
    };
  };

  /* ── the asset ledger ──────────────────────────────────────────────────
     One row per plate, including plates that took nothing: a vehicle earning
     zero is the row this page exists for, and building the table FROM the trip
     table would drop exactly those.

     The plate register is the same recursive index skip the vehicle directory
     uses, and for the same reason — the distinct values of an indexed column
     are what a B-tree already holds, so this descends the index once per plate
     instead of once per trip. See api/vehicle_routes.js. */
  app.get('/api/economics/assets', wrap(async (req, res) => {
    const p = range(req);
    const [from, to] = p;
    const windowDays = spanDays(from, to);
    /* Which days the ALERT FEED covered, asked before anything else because
       both halves of alerts_per_100km are narrowed to them. Not filtered by
       fleet: this endpoint counts alerts for every plate it lists regardless
       of the fleet chip, and coverage has to match the numerator it divides.
       See api/alert_coverage_sql.js for why this exists and what it assumes. */
    const cov = await alertCoverage(q, from, to);
    const pd = [...p, cov.days];

    const [work, attributed, decor, unatt, coverage] = await Promise.all([
      /* The work, at BOTH grains, from ONE scan of the trip table.
         ──────────────────────────────────────────────────────────────────
         Two things have to be known about a plate and they are not the same
         shape. The distinct-day counts — days earning, days moved, and
         therefore idle days — cannot be summed across per-platform rows, so
         they must be asked at plate grain. The income rule needs bookings,
         priced bookings and fares PER CHANNEL, because it chooses between a
         fare and a payout one channel at a time.

         Written as two statements this scanned the window's trips twice, and
         over a year that is the difference between a page and a gateway
         timeout. `w` is referenced by both aggregates below, which is what
         makes Postgres materialise it instead of inlining it twice: the trips
         are read once, narrowed to nine columns, and aggregated two ways.

         Bookings and telematics journeys stay apart throughout. An FMS row is
         the same physical journey a ride platform already reported, and
         counting both showed cars doing three times the work they did. */
      /* `trip`, not `trip_norm`, and the STORED fold rather than the computed
         one. This was the regression.
         ──────────────────────────────────────────────────────────────────
         personKey() over the view expands to two nested regexp_replace per
         row — the exact expression sql/schema_v20.sql measured at 2,434ms
         against 129ms for the stored column, and stored on `trip` for that
         reason. The view cannot expose it: v18 rebuilt trip_norm's frozen
         `SELECT t.*` two migrations before v20 added the column, so a query
         that reads the view has no choice but to fold again. Reading the base
         table does. Measured here at production shape (279,289 trips), this
         CTE alone: 3,196ms of the 3,911ms the query took at 365 days.
         The four view expressions this query uses are inlined verbatim from
         sql/schema_v18.sql:47-88 — same values, no view to fold behind. */
      q(`WITH w AS (
           SELECT t.plate, t.platform,
                  (t.requested_at AT TIME ZONE 'Asia/Dubai')::date AS local_day,
                  (t.platform <> 'fms') AS is_booking,
                  (t.price IS NOT NULL
                   AND lower(coalesce(t.payment_type, '')) NOT IN
                       ('foc-complimentary', 'foc', 'complimentary')) AS has_fare,
                  (t.distance_km IS NOT NULL AND t.distance_km > 0
                   AND t.distance_km < 500) AS has_distance,
                  t.price, t.distance_km, t.requested_at, t.fleet_id,
                  coalesce(nullif(t.person_key, ''), t.driver_ext_id) AS person
           FROM trip t
           WHERE (t.requested_at AT TIME ZONE 'Asia/Dubai')::date
                   BETWEEN $1::date AND $2::date
             AND ($3::text IS NULL OR t.platform=$3) AND ($4::text IS NULL OR t.fleet_id=$4)
             AND t.plate IS NOT NULL AND t.plate <> ''
         ),
         per_plate AS (
           SELECT plate,
                  count(*) FILTER (WHERE is_booking)::int bookings,
                  count(*) FILTER (WHERE NOT is_booking)::int telematics_journeys,
                  count(DISTINCT local_day) FILTER (WHERE is_booking)::int days_earning,
                  count(DISTINCT local_day)::int days_moved,
                  round(sum(distance_km) FILTER (WHERE is_booking AND has_distance)::numeric,0) km,
                  /* The SAME distance, narrowed to the days the alert feed was
                     up. It is the only denominator alerts_per_100km may have:
                     dividing every alert this plate triggered by every km it
                     drove made a car's safety improve whenever the window was
                     widened over the feed's 73-day hole. Kept beside the km
                     column rather than replacing it — money per km is a
                     question about the whole window and must not be
                     narrowed. */
                  round(sum(distance_km) FILTER (WHERE is_booking AND has_distance
                        AND local_day = ANY($5::date[]))::numeric,0) alert_km,
                  count(*) FILTER (WHERE is_booking AND has_distance)::int measured_bookings,
                  count(DISTINCT person)::int drivers,
                  max(requested_at) FILTER (WHERE is_booking) last_trip,
                  min(fleet_id) fleet_id
           FROM w GROUP BY 1
         ),
         per_channel AS (
           SELECT plate, platform,
                  count(*)::int bookings,
                  count(*) FILTER (WHERE has_fare)::int priced_bookings,
                  round(sum(price) FILTER (WHERE has_fare)::numeric,2) fares,
                  round(sum(distance_km) FILTER (WHERE has_distance)::numeric,0) km,
                  count(DISTINCT local_day)::int booking_days
           FROM w WHERE is_booking GROUP BY 1,2
         ),
         /* Rolled to one row per plate FIRST and then joined, never as a
            correlated subquery over per_channel: written that way the planner
            re-scanned the channel set once per plate, which on a 240-plate
            fleet was a quarter of a million comparisons and cost more than the
            second table scan this merge was made to save. */
         per_channel_agg AS (
           SELECT plate, jsonb_agg(j) AS channels
           FROM (SELECT plate, to_jsonb(c) - 'plate' AS j FROM per_channel c) x
           GROUP BY plate
         )
         /* The per-channel rows travel nested inside their plate's row rather
            than as a second result set, so the two grains cannot arrive
            describing different windows. */
         SELECT p.*, a.channels
         FROM per_plate p LEFT JOIN per_channel_agg a USING (plate)`, pd),

      /* The other numerator: weekly driver payouts placed on the vehicle-days
         their driver was actually holding. Unbound this time — every plate at
         once, which is the whole point of this endpoint. */
      /* Narrowed by bound parameters on the OUTER query rather than by
         interpolating a predicate into the shared template. attribution_sql
         offers a platformFilter hole, and a hole that takes a raw SQL fragment
         is a hole somebody eventually puts a query parameter through. The
         columns are already on the attributed rows; $3 and $4 are the same
         platform and fleet the rest of this endpoint binds. */
      q(`SELECT att.plate, att.platform,
                round(sum(att.attributed)::numeric,2) payouts,
                count(DISTINCT att.day)::int payout_days,
                count(DISTINCT att.driver_ext_id)::int payout_drivers,
                bool_or(att.basis = 'even') any_even_split
         FROM (${attributedEarnings()}) att
         WHERE ($3::text IS NULL OR att.platform = $3)
           AND ($4::text IS NULL OR att.fleet_id = $4)
         GROUP BY 1,2`, p),

      /* Everything that is true of the asset rather than of its work: what it
         is, whether its papers are current, whether the tracker still hears
         from it, and who is holding it. Small tables, joined onto the plate
         register so a vehicle with no trips at all still gets a row. */
      q(`WITH RECURSIVE driven AS (
           (SELECT min(plate) AS plate FROM trip WHERE plate IS NOT NULL AND plate <> '')
           UNION ALL
           SELECT (SELECT min(x.plate) FROM trip x WHERE x.plate > d.plate)
             FROM driven d WHERE d.plate IS NOT NULL
         ),
         plates AS (
           SELECT plate FROM driven WHERE plate IS NOT NULL
           UNION SELECT plate FROM telemetry_snapshot
           UNION SELECT plate FROM vehicle_document WHERE plate IS NOT NULL
         ),
         tel AS (
           /* A tracker with no satellite lock reports 0,0 — the null island in
              the Gulf of Guinea, four and a half thousand kilometres from
              Dubai. Three vehicles on this fleet were doing it, and one is
              enough: a map framed to contain both Dubai and the Atlantic draws
              the entire real fleet as a single pixel. A fix that cannot be
              true is not a fix, so it is dropped here rather than drawn.
              The captured_at stays — the tracker DID report, and when it last
              reported is a separate fact from where. */
           SELECT DISTINCT ON (plate) plate, captured_at last_fix, status,
                  CASE WHEN abs(coalesce(lat,0)) < 0.5 AND abs(coalesce(lng,0)) < 0.5
                       THEN NULL ELSE lat END AS lat,
                  CASE WHEN abs(coalesce(lat,0)) < 0.5 AND abs(coalesce(lng,0)) < 0.5
                       THEN NULL ELSE lng END AS lng
           FROM telemetry_snapshot ORDER BY plate, captured_at DESC
         ),
         doc AS (
           SELECT plate, min(expires_at) soonest_expiry
           FROM vehicle_document WHERE expires_at IS NOT NULL GROUP BY plate
         ),
         al AS (
           /* Restricted to the covered days, which is a no-op on the count —
              there are no alerts on a day with no alerts — and is written out
              anyway so the numerator and the denominator name the same set of
              days rather than agreeing by accident. */
           SELECT plate, ${drivingCount()} alerts, ${deviceCount()} device_alerts
           FROM alert
           WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
             AND (occurred_at AT TIME ZONE 'Asia/Dubai')::date = ANY($3::date[])
           GROUP BY plate
         )
         SELECT p.plate,
                coalesce(v.make, vp.make) make, coalesce(v.model, vp.model) model,
                coalesce(v.year, vp.year) AS year,
                coalesce(v.fleet_id, vp.fleet_id) fleet_id,
                tel.last_fix, tel.status, tel.lat, tel.lng,
                /* Eleven minutes here, thirty in server.js FIX_FRESH, which /api/live
                 and /api/kpis use. Measured on production the two feeds differ
                 enough that neither number fits both — FMS reports every ~5 min,
                 CABMAN sits at a median of 43 — so the pages state which rule
                 they applied rather than one being quietly imposed on both. */
              (now() - tel.last_fix > interval '11 minutes') stale,
                doc.soonest_expiry,
                (doc.soonest_expiry::date - now()::date) doc_days_left,
                coalesce(al.alerts,0) alerts,
                /* Carried out, not merely computed: a row that reaches
                   alertRate() with device undefined rates a hardware-only
                   plate at 0.0 again. */
                coalesce(al.device_alerts,0) device_alerts,
                cd.driver_name current_driver, cd.driver_ext_id current_driver_id,
                cd.as_of driver_as_of
         FROM plates p
         LEFT JOIN tel ON tel.plate = p.plate
         LEFT JOIN doc ON doc.plate = p.plate
         LEFT JOIN al  ON al.plate  = p.plate
         LEFT JOIN vehicle v ON v.plate = p.plate
         LEFT JOIN vehicle_profile vp ON vp.plate = p.plate
         LEFT JOIN vehicle_current_driver cd ON cd.plate = p.plate`, [from, to, cov.days]),

      /* Payout periods that reach no vehicle at all, because their driver has
         no custody day inside the period. Reported rather than dropped: the
         rows below sum to LESS than the fleet's money, and a reader who adds
         the column up and gets a smaller number has no way to tell which of
         the two figures is wrong. */
      /* Wrapped so the platform filter is bound rather than interpolated, for
         the same reason as above. A FLEET filter deliberately does not reach
         this: an unplaced payout is one whose driver held no vehicle inside
         the period, so there is no custody row to read a fleet from, and
         narrowing it would silently report the whole fleet's remainder against
         one of them. When a fleet is chosen the figure is withheld with its
         reason instead. */
      q(`SELECT u.* FROM (${unattributedEarnings()}) u
         WHERE ($3::text IS NULL OR u.platform = $3)`, [from, to, p[2]]),

      moneyCoverage(from, to),
    ]);

    const byPlate = new Map();
    const row = (plate) => {
      if (!byPlate.has(plate)) {
        byPlate.set(plate, { plate, platforms: new Map(), bookings: 0, telematics_journeys: 0,
          days_earning: 0, days_moved: 0, km: null, alert_km: null,
          measured_bookings: 0, drivers: 0,
          /* null, not 0: only the plates with no booking in the window are
             folded over the whole record, so a zero on a working car would be
             a measurement nobody took. */
          last_trip: null, last_booking_ever: null, bookings_ever: null, fleet_id: null });
      }
      return byPlate.get(plate);
    };
    for (const d of decor) Object.assign(row(d.plate), d, { fleet_id: d.fleet_id || null });
    for (const w of work) {
      const r = row(w.plate);
      Object.assign(r, {
        bookings: w.bookings, telematics_journeys: w.telematics_journeys,
        days_earning: w.days_earning, days_moved: w.days_moved,
        km: n(w.km), alert_km: n(w.alert_km),
        measured_bookings: w.measured_bookings, drivers: w.drivers,
        last_trip: w.last_trip, fleet_id: r.fleet_id || w.fleet_id,
      });
    }
    /* WHEN DID THIS CAR LAST EARN — over the whole record, not the window.
       ─────────────────────────────────────────────────────────────────────
       last_trip comes out of `w`, which is bounded by the window, so on the
       "Held, insured, earning nothing" panel it is null for every row BY
       CONSTRUCTION: a vehicle is on that list precisely because it took no
       booking in the window. The column therefore pruned itself and printed
       one sentence in its place — "none of these vehicles has ever taken a
       booking on any channel" — a claim about ALL TIME derived from a
       ninety-day query, and false for any of those 27 cars that earned in the
       months before it. The question in front of that list is how long the car
       has been idle, and a window containing no trips cannot answer it.

       Asked ONLY of the plates that need it — the ones with no booking in the
       window — and after the aggregation above, which is what knows who they
       are. Written as a whole-table GROUP BY first, and test/economics_cost
       .test.mjs caught it: a one-day window then cost as much as a month,
       because the fold read every trip either way. Bounded like this it is a
       handful of lookups on trip (plate, requested_at) — 27 of them on
       production — and a narrow window stays narrow.

       Unfiltered by platform and fleet on purpose, like the roster's own
       `ever` fold: "has this car ever earned" is not a question about the
       chips above the page. */
    const cold = [...byPlate.values()].filter((r) => !r.bookings).map((r) => r.plate);
    if (cold.length) {
      for (const e of await q(
        `SELECT plate,
                max(requested_at) FILTER (WHERE platform <> 'fms') AS last_booking_ever,
                count(*) FILTER (WHERE platform <> 'fms')::int      AS bookings_ever
           FROM trip
          WHERE plate = ANY($1)
          GROUP BY 1`, [cold])) {
        const r = byPlate.get(e.plate);
        if (!r) continue;
        r.last_booking_ever = e.last_booking_ever;
        r.bookings_ever = e.bookings_ever || 0;
      }
      /* A cold plate the fold returned no row for has genuinely never carried
         a booking — GROUP BY produces nothing for it — and that is a zero we
         measured rather than an absence. */
      for (const plate of cold) {
        const r = byPlate.get(plate);
        if (r && r.bookings_ever == null) r.bookings_ever = 0;
      }
    }
    /* One entry per (plate, platform), carrying whichever of the two kinds of
       money that channel reports. chooseBasis then decides which to believe,
       exactly as it does for the fleet and for one vehicle. */
    const plat = (r, name) => {
      if (!r.platforms.has(name)) {
        r.platforms.set(name, { platform: name, bookings: 0, priced_bookings: 0, fares: null,
          km: null, booking_days: 0, payouts: null, payout_days: 0 });
      }
      return r.platforms.get(name);
    };
    for (const w of work) {
      for (const c of (w.channels || [])) {
        Object.assign(plat(row(w.plate), c.platform), {
          bookings: c.bookings, priced_bookings: c.priced_bookings,
          fares: n(c.fares), km: n(c.km), booking_days: c.booking_days,
        });
      }
    }
    for (const a of attributed) {
      Object.assign(plat(row(a.plate), a.platform), {
        payouts: n(a.payouts), payout_days: a.payout_days,
      });
      row(a.plate).any_even_split = row(a.plate).any_even_split || a.any_even_split;
    }

    const rows = [...byPlate.values()].map((r) => {
      const pf = [...r.platforms.values()];
      const income = fleetIncome(pf, windowDays);
      const money = income.accounted;
      /* The raw attribution, before the income rule chooses between a channel's
         fare and its payout. Kept as its own field because the two answer
         different questions and only one of them reconciles.

         `payouts` below is the CHOSEN figure: a channel that prices its trips
         contributes its fares and its payout is dropped, or the same money
         would be counted nearly twice. That makes the chosen column correct as
         income and useless as a check — it does not sum to what the platforms
         paid. This does: every plate's attributed, plus the periods that
         reached no plate at all, is the payout total. test/economics.test.mjs
         asserts exactly that. */
      const attributedAll = round(pf.reduce((a, x) => a + (Number(x.payouts) || 0), 0), 2) || null;
      /* Idle days are calendar days on which the tracker and every platform
         agree the asset did nothing at all. Counted against the window, not
         against the days it worked, because the question is what the fleet
         paid to keep it for and got nothing back. */
      const idleDays = Math.max(0, windowDays - (r.days_moved || 0));
      return {
        plate: r.plate,
        fleet_id: r.fleet_id || null,
        make: r.make || null, model: r.model || null, year: r.year ?? null,
        bookings: r.bookings, telematics_journeys: r.telematics_journeys,
        km: r.km, measured_bookings: r.measured_bookings,
        /* The distance the safety rate was taken over, beside the distance the
           money rates were: they differ by every kilometre driven on a day the
           alert feed was dark, and a reader has to be able to see that. */
        alert_km: r.alert_km ?? null,
        days_earning: r.days_earning, days_moved: r.days_moved, idle_days: idleDays,
        window_days: windowDays,
        drivers: r.drivers,
        money, fares: income.accounted_fares, payouts: income.accounted_payouts,
        attributed: attributedAll,
        money_platforms: income.accounted_platforms,
        /* The three rates the operator asked for, each null rather than zero
           when its denominator is missing. */
        aed_per_earning_day: rate(money, r.days_earning),
        aed_per_km: rate(money, r.km),
        aed_per_booking: rate(money, r.bookings),
        /* And the one that says what the idleness costs: the money this asset
           would have made on its idle days at its OWN daily rate. Not a loss —
           nobody was billed for it — but the size of the opportunity, computed
           from this car's own performance rather than from a fleet average
           that a poor performer would never have reached. */
        forgone_at_own_rate: r.days_earning && money
          ? round((money / r.days_earning) * idleDays, 0) : null,
        alerts: r.alerts ?? 0,
        /* Over the days the ALERT FEED covered, not over the window.
           ─────────────────────────────────────────────────────────────────
           This was rate((r.alerts ?? 0) * 100, r.km, 1) — every alert divided
           by every kilometre — and it made a car's safety improve whenever the
           range was widened. On production 2026-09-02 the fleet figure this
           column rolls up to read 69.7 per 100 km at 16 days and 41.5 at 30,
           off the identical 69,338 alerts, because the feed's 73-day hole
           (2026-06-06 → 2026-08-17) contributed distance and nothing else.
           Null rather than 0 when the feed covered none of the window: see
           `alert_coverage` on the response for which days those were. */
        /* telematics_journeys is on this row already and is the discriminator
           between a clean car and a car nothing was watching: 30 of the 228
           plates at days=30 print a rate of 0 with no telematics journey at
           all, 39,843 km between them and not one alert row, and sorting the
           column put them above the 66 cars the feed does cover. */
        alerts_per_100km: alertRate(r.alerts ?? 0, r.alert_km, cov, 1,
          { device: r.device_alerts, tracked: r.telematics_journeys ?? null }),
        alerts_per_100km_absent: alertRateReason(r.alert_km, cov,
          { alerts: r.alerts ?? 0, device: r.device_alerts,
            tracked: r.telematics_journeys ?? null }),
        device_alerts: r.device_alerts ?? 0,
        any_even_split: !!r.any_even_split,
        soonest_expiry: r.soonest_expiry ?? null,
        doc_days_left: r.doc_days_left ?? null,
        last_trip: r.last_trip ?? null,
        /* Beside last_trip, not instead of it: one is "last earned in the
           window you are looking at" and the other is "last earned at all". */
        last_booking_ever: r.last_booking_ever ?? null,
        bookings_ever: r.bookings_ever ?? null,
        days_since_last_booking: r.last_booking_ever
          ? Math.floor((Date.now() - Date.parse(r.last_booking_ever)) / 864e5) : null,
        last_fix: r.last_fix ?? null,
        stale: r.stale ?? null, status: r.status ?? null,
        lat: r.lat ?? null, lng: r.lng ?? null,
        current_driver: r.current_driver ?? null,
        current_driver_id: r.current_driver_id ?? null,
        driver_as_of: r.driver_as_of ?? null,
        /* Three states, and the middle one is the interesting one. A car that
           moved without earning burned a day of custody, a tracker subscription
           and whatever the papers cost, and produced nothing. */
        band: money > 0 ? 'earning' : (r.days_moved > 0 || r.bookings > 0) ? 'moved_unpaid' : 'still',
      };
    }).sort((a, b) => (b.money ?? 0) - (a.money ?? 0) || a.plate.localeCompare(b.plate));

    /* Which CHANNEL yields most per kilometre.
       ─────────────────────────────────────────────────────────────────────
       The same per-(plate, platform) rows, rolled the other way. It answers the
       half of "which areas earn us money" that is not about a car or a person,
       and it is the one comparison on this page that must carry a warning: the
       Uber figure is a payout, net of the platform's commission, and the hotel
       figure is the gross fare a guest was charged. A ratio between them is not
       a like-for-like yield, and chooseBasis records which of the two each row
       is so the page can say so on the row itself. */
    const chan = new Map();
    for (const r of byPlate.values()) {
      for (const x of r.platforms.values()) {
        const c = chan.get(x.platform) || { platform: x.platform, bookings: 0,
          priced_bookings: 0, booking_days: 0, fares: null, km: null, payouts: null,
          payout_days: 0, vehicles: 0 };
        c.bookings += x.bookings; c.priced_bookings += x.priced_bookings;
        c.booking_days = Math.max(c.booking_days, x.booking_days);
        c.payout_days = Math.max(c.payout_days, x.payout_days);
        if (x.fares != null) c.fares = (c.fares || 0) + x.fares;
        if (x.km != null) c.km = (c.km || 0) + x.km;
        if (x.payouts != null) c.payouts = (c.payouts || 0) + x.payouts;
        if (x.bookings || x.payouts) c.vehicles += 1;
        chan.set(x.platform, c);
      }
    }
    const byPlatform = [...chan.values()].map((c) => {
      chooseBasis(c, windowDays);
      return { ...c, fares: round(c.fares), payouts: round(c.payouts), km: round(c.km, 0),
        money: round(c.best), aed_per_km: rate(c.best, c.km) };
    }).sort((a, b) => (b.money ?? 0) - (a.money ?? 0));

    const sum = (f) => round(rows.reduce((a, r) => a + (Number(f(r)) || 0), 0), 2);
    const placed = sum((r) => r.money);
    const attributedAll = sum((r) => r.attributed);
    /* NOT the fleet's income, and it took two passes to establish why.
       ─────────────────────────────────────────────────────────────────────
       The first attempt recomputed a "fleet total" from byPlatform, on the
       theory that the gap against /api/revenue was chooseBasis running per
       plate here and once per channel there. It came out identical to the
       per-plate sum, which disproved that: the basis rule is not the cause.

       Measured per channel on production, same window, same instant:

           Uber payouts    revenue 404,599.46   assets 406,053.06
           Yango payouts   revenue   5,612.20   assets   1,590.33

       The two endpoints ATTRIBUTE the same driver_payout_day rows differently
       — this one walks them through vehicle custody to reach a plate, and a
       payout it cannot place is reported separately as `unplaced_payouts`.
       Yango's 4,022 missing here is most of that unplaced figure. Uber's
       going the other way is the part still unexplained.

       So no total is invented here. The page fetches /api/kpis and compares
       against the number Finance actually shows, which cannot drift from it
       because it IS it. */
    /* Withheld under a fleet filter rather than narrowed — see the query. */
    const unplaced = p[3] ? null
      : round((unatt || []).reduce((a, r) => a + Number(r.earnings || 0), 0), 2);
    const earningDays = rows.reduce((a, r) => a + r.days_earning, 0);

    res.json({
      window: [from, to],
      window_days: windowDays,
      /* Which days the safety column was measured over, and the assumption
         that decided them. The Alerts /100km column is about these days and
         no others, and the page is expected to say so. */
      alert_coverage: cov,
      rows,
      by_platform: byPlatform,
      totals: {
        vehicles: rows.length,
        earning: rows.filter((r) => r.band === 'earning').length,
        moved_unpaid: rows.filter((r) => r.band === 'moved_unpaid').length,
        still: rows.filter((r) => r.band === 'still').length,
        /* Assets earning nothing while their papers are still current — the
           fleet is paying to keep them road-legal and getting nothing back.
           This is as close to "losing money" as this database can honestly
           get, and it is a set of names rather than a figure. */
        idle_but_documented: rows.filter((r) => !r.money && r.doc_days_left != null
          && r.doc_days_left >= 0).length,
        money: placed,
        fares: sum((r) => r.fares), payouts: sum((r) => r.payouts),
        attributed: attributedAll,
        km: sum((r) => r.km), bookings: rows.reduce((a, r) => a + r.bookings, 0),
        earning_vehicle_days: earningDays,
        idle_vehicle_days: rows.reduce((a, r) => a + r.idle_days, 0),
        aed_per_earning_day: rate(placed, earningDays),
        aed_per_km: rate(placed, sum((r) => r.km)),
        aed_per_booking: rate(placed, rows.reduce((a, r) => a + r.bookings, 0)),
        /* The idle days, priced at each asset's OWN daily rate rather than at a
           fleet average a weak performer would never have reached. Not a loss —
           nobody was billed for it — and the wording on the page has to keep
           saying so. It is the size of the gap between what the fleet holds and
           what the fleet works. */
        forgone_at_own_rate: sum((r) => r.forgone_at_own_rate) || null,
        /* The part of the payout that reached no vehicle at all, because its
           driver held none inside the period. Measured against the ATTRIBUTED
           total rather than against money in, so the two visibly partition one
           set of periods: attributed + unplaced is what the platforms paid. */
        unplaced_payouts: unplaced || null,
        unplaced_pct: unplaced != null && attributedAll + unplaced > 0
          ? round((unplaced / (attributedAll + unplaced)) * 100, 1) : null,
        unplaced_note: p[3]
          ? 'An unplaced payout belongs to a driver who held no vehicle in that period, '
            + 'so there is no custody row to read a fleet from — the figure is withheld '
            + 'rather than reported against one fleet.'
          : null,
      },
      coverage,
    });
  }));

  /* ── the people ledger ─────────────────────────────────────────────────
     The mirror of the table above, and it needs a different join: a payout is
     already keyed on a driver, so nothing has to be attributed to reach a
     person. What DOES have to be resolved is identity — the same human holds
     an Uber id and a Yango id, and summing per account ranks somebody who did
     half the work twice above somebody who did all of it once.

     Folded on the canonical name, the same fold the driver directory and
     vehicle_driver_day use, so a person's row here and their own page agree. */
  app.get('/api/economics/drivers', wrap(async (req, res) => {
    const p = range(req);
    const [from, to] = p;
    const windowDays = spanDays(from, to);
    /* The days the alert feed covered, and therefore the only days this page's
       Alerts /100km column may be measured over. Fleet-wide rather than per
       person for the reason api/alert_coverage_sql.js gives: a careful driver
       having a clean day is not the feed going dark, and reading it as one
       would throw away exactly the distance that proves they were careful. */
    const cov = await alertCoverage(q, from, to);
    const pd = [...p, cov.days];
    /* The key rows are GROUPED by, and it must be an ADDRESS as well as a key.
       personKey() answers the folded NAME wherever there is one, which is the
       right thing to group on and the wrong thing to hand back: the driver
       pages resolve a provider id or a `name:<fold>` key, and neither of those
       is "muhammad khalid", so every person this ledger named opened on a 404.
       This is the synthesised key the driver directory already uses, built from
       the STORED fold on trip rather than from a regex over every row — the
       same value, and the difference between 4 seconds and 41.

       Read off `trip` alone. It used to be built across JOIN_TRIP — a self
       join of trip to trip_norm purely to reach person_key, which the view
       cannot expose — and that join carried NO window predicate on its `trip`
       side, because the window sits on the view's side and Postgres cannot
       infer it across an equijoin on (platform, external_id). So a seven-day
       question hashed the whole table exactly as a year-long one did:
       measured here at production shape, `Seq Scan on trip t (rows=279,289,
       Buffers: shared hit=47,327)` identically at every window, 46% of the
       query's page traffic. person_key is a column of `trip`, so there was
       never anything to join TO. */
    const PK = `coalesce(nullif(btrim(t.driver_ext_id), ''), 'name:' || t.person_key)`;

    const [pay, avail, work, who, custody, tele, held, coverage] = await Promise.all([
      /* What each account was actually paid, at day grain with the overlapping
         report windows already resolved — never driver_performance directly,
         where one driver's twenty-eight weeks were held as sixty-seven rows.
         See sql/schema_v23.sql. */
      q(`SELECT driver_ext_id, max(driver_name) driver_name,
                array_agg(DISTINCT platform) platforms,
                min(fleet_id) fleet_id,
                round(sum(earnings)::numeric,2) payouts,
                round(sum(cash_earnings)::numeric,2) cash,
                count(DISTINCT day)::int payout_days,
                round(sum(trips)::numeric,0)::int reported_trips,
                round(sum(distance_km)::numeric,0) reported_km,
                round(sum(hours_online)::numeric,1) hours_online
         FROM driver_payout_day
         WHERE day BETWEEN $1::date AND $2::date
           AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)
         GROUP BY 1`, p),

      /* AVAILABILITY WE MEASURED OURSELVES.
         ─────────────────────────────────────────────────────────────────
         The comment below on aed_per_hour_online used to say this was "the
         rate an operator most wants and the one this fleet cannot have",
         because Uber's payout rows carry no hours and Uber is nine bookings in
         ten. That stopped being true the day the availability collector
         landed: driver_day.online_min is our own measurement of when each
         person was logged in and dispatchable, and it exists for every fleet
         and every channel because it comes from the supplier session rather
         than from a payout statement.

         Kept SEPARATE from the platform figure rather than merged into it. A
         platform's reported hours and our observed availability are two
         different measurements — one is what Yango says it paid for, the other
         is what Uber's own timeline shows — and quietly adding them would
         produce a denominator that is neither. */
      q(`SELECT driver_ext_id,
                round(sum(online_min)::numeric / 60, 1) AS measured_hours_online,
                round(sum(idle_online_min)::numeric / 60, 1) AS measured_idle_h,
                count(*)::int AS availability_days
           FROM driver_day
          WHERE day BETWEEN $1::date AND $2::date
            AND online_min IS NOT NULL
            /* $3 is the platform chip. Every other query here binds it, and
               leaving it out made Postgres refuse the statement outright —
               "could not determine data type of parameter $3", because a
               placeholder below the highest-numbered one still has to be
               inferable. driver_day carries the platforms a person worked that
               day as an array, so honouring the chip here is also correct:
               narrowing the page to one channel should narrow the availability
               to the people who worked it. */
            AND ($3::text IS NULL OR $3 = ANY(platforms))
            AND ($4::text IS NULL OR fleet_id = $4)
          GROUP BY 1`, p),

      /* What they drove. Keyed on the stored person fold as a GROUP BY, never
         as a WHERE predicate — written as a predicate it matches the partial
         index's own definition, the planner takes the index and then fetches
         the heap row for essentially every row in the table, and this kind of
         query went from 4.3s to 41s. */
      /* The view's four resolved columns are inlined verbatim from
         sql/schema_v18.sql:47-88 — is_booking, outcome, local_day, has_fare
         and has_distance — so this is the same set of rows carrying the same
         values, read from the table the window predicate can actually narrow. */
      q(`WITH w AS (
           SELECT ${PK} AS pk, t.driver_name, t.platform, t.plate, t.price,
                  t.distance_km, t.requested_at, t.fleet_id,
                  (t.platform <> 'fms') AS is_booking,
                  CASE
                    WHEN t.platform = 'fms' THEN NULL
                    WHEN t.status IS NULL THEN NULL
                    WHEN lower(btrim(t.status)) IN ('completed', 'finished', 'complete',
                                                    'closed', 'delivered') THEN 'completed'
                    WHEN t.status ILIKE '%cancel%'
                      OR lower(btrim(t.status)) IN ('client_did_not_show', 'driver_did_not_respond',
                                                    'driver_rejected', 'rejected', 'expired',
                                                    'failed', 'no_show') THEN 'not_completed'
                    ELSE 'other'
                  END AS outcome,
                  (t.requested_at AT TIME ZONE 'Asia/Dubai')::date AS local_day,
                  (t.price IS NOT NULL
                   AND lower(coalesce(t.payment_type, '')) NOT IN
                       ('foc-complimentary', 'foc', 'complimentary')) AS has_fare,
                  (t.distance_km IS NOT NULL AND t.distance_km > 0
                   AND t.distance_km < 500) AS has_distance
           FROM trip t
           WHERE (t.requested_at AT TIME ZONE 'Asia/Dubai')::date
                   BETWEEN $1::date AND $2::date
             AND ($3::text IS NULL OR t.platform=$3) AND ($4::text IS NULL OR t.fleet_id=$4)
             AND coalesce(btrim(t.driver_name), '') <> ''
         )
         SELECT pk AS driver_ext_id, max(driver_name) driver_name,
                count(*) FILTER (WHERE is_booking)::int bookings,
                count(*) FILTER (WHERE outcome = 'completed')::int completed,
                count(*) FILTER (WHERE outcome IS NOT NULL)::int bookable,
                /* The DAYS, not a count of them. This query groups on PK, which is
                   the ACCOUNT (a provider id where there is one), so a person
                   holding two platform accounts gets two rows — and the JS
                   below folds those rows together by person. Summing two
                   per-account counts then counts a day worked on both
                   platforms twice: KASHIF ALI AYYUB KHAN, who holds a Uber id
                   and a hotel id, reported days_worked 13 inside a SEVEN-day
                   window, which is what made him the only driver on earth to
                   pass an "at least 10 days driven" gate at days=7 — and so
                   the only row on BOTH the best-earning and worst-earning
                   lists at once. A union cannot double-count; a sum can. */
                array_agg(DISTINCT local_day) AS worked_days,
                round(sum(distance_km) FILTER (WHERE is_booking AND has_distance)::numeric,0) km,
                /* The same distance, narrowed to the days the alert feed was
                   up — the only denominator alerts_per_100km may have. Beside
                   the whole-window km, never instead of it: money per km is a
                   question about the window and must not be narrowed. */
                round(sum(distance_km) FILTER (WHERE is_booking AND has_distance
                      AND local_day = ANY($5::date[]))::numeric,0) alert_km,
                round(sum(price) FILTER (WHERE has_fare)::numeric,2) fares,
                count(*) FILTER (WHERE has_fare)::int priced_bookings,
                count(DISTINCT plate) FILTER (WHERE plate IS NOT NULL AND plate <> '')::int vehicles,
                array_agg(DISTINCT platform) platforms,
                min(fleet_id) fleet_id,
                max(requested_at) last_trip
         FROM w GROUP BY 1`, pd),

      /* Standing, so a person earning nothing can be told apart from a person
         who is not ALLOWED to earn — opposite remedies, and the money column
         cannot tell them apart on its own.

         Two tables, unioned rather than joined. Both are keyed on
         (platform, driver_ext_id), so a full outer join on the id alone
         multiplies a driver with two platform rows into four, and every
         aggregate downstream inherits the duplication. Projected to one shape
         and folded on the person in JS instead. */
      q(`SELECT full_name, state, licence_expires,
                (licence_expires - now()::date) licence_days_left,
                NULL::text platform_state, NULL::boolean can_earn
         FROM driver_compliance WHERE coalesce(btrim(full_name), '') <> ''
         UNION ALL
         SELECT full_name, NULL, NULL::date, NULL::int, state, can_earn
         FROM driver_platform_state WHERE coalesce(btrim(full_name), '') <> ''`),

      /* Harsh-driving events belong to a vehicle, and are this person's only
         on the days they held it. DISTINCT on (plate, day) first:
         vehicle_driver_day carries one row per platform, so a driver running
         two apps on one car in one day would count every event twice. */
      q(`WITH held AS (
           SELECT DISTINCT driver_ext_id, plate, day FROM vehicle_driver_day
           WHERE day BETWEEN $1::date AND $2::date
         )
         /* The window predicate on alert is REDUNDANT and that is the point.
            The join already forces a.occurred_at's Dubai day to equal an h.day
            that is inside the window, so no row's fate changes — but written
            only as a join condition it is not a predicate the planner can push
            down, and alert was read whole at every window: rows=56,249
            identically at 7, 30, 90 and 365 days. Spelled out, it matches
            alert_local_day_idx (sql/schema_v27.sql:21) exactly. */
         /* Narrowed to the covered days as well, which changes no count — a
            day with no alerts contributes none — but keeps the numerator and
            the denominator naming the same set of days explicitly rather than
            by coincidence. */
         SELECT h.driver_ext_id, ${drivingCount('a.alert_type')} alerts,
                ${deviceCount('a.alert_type')} device_alerts
         FROM alert a
         JOIN held h ON h.plate = a.plate
          AND (a.occurred_at AT TIME ZONE 'Asia/Dubai')::date = h.day
         WHERE (a.occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
           AND (a.occurred_at AT TIME ZONE 'Asia/Dubai')::date = ANY($3::date[])
         GROUP BY 1`, [from, to, cov.days]),

      /* Whether the telematics feed saw this person's cars at all.
         ─────────────────────────────────────────────────────────────────
         Alerts /100km on this ledger printed a confident 0 for 26 of 309 rows
         at days=30 — Zahid Khan Khan over 2,788 km, Imran Hussain Islam over
         225 bookings — and sorting the column ranked exactly those people the
         safest in the fleet, against a fleet rate of 86.4 per 100 km. Their
         cars are on no telematics feed: alerts come from FMS, alert_km comes
         from the trip table, so an untracked car supplies a full denominator
         and an empty numerator.

         alerts 0 AND device_alerts 0 was the only discriminator this response
         carried, and it cannot tell "no tracker" from "drove cleanly" — it
         would blank a genuinely alert-free driver on a watched car. The asset
         ledger has told the two apart since it was written, with
         telematics_journeys; this is the same count, folded onto the person
         through the days they actually held the plate.

         Same custody shape as the alert query above, and DISTINCT for the same
         reason: vehicle_driver_day carries one row per platform, so a driver
         running two apps on one car in one day would count its journeys twice.
         The window predicate on trip is redundant against the join and is
         spelled out so the planner can push it down — the identical fix the
         alert join above records. */
      q(`WITH held AS (
           SELECT DISTINCT driver_ext_id, plate, day FROM vehicle_driver_day
           WHERE day BETWEEN $1::date AND $2::date
         )
         SELECT h.driver_ext_id, count(*)::int telematics_journeys
         FROM trip t
         JOIN held h ON h.plate = t.plate
          AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date = h.day
         WHERE t.platform = 'fms'
           AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
         GROUP BY 1`, [from, to]),

      /* Which cars each person actually held, busiest first and capped at
         three. A ledger that names a driver and not their vehicle is the dead
         end this codebase has a rule against: a person earning nothing is a
         question about an asset, and the asset has to be one click away.
         test/completeness.test.mjs is what enforces it. */
      q(`SELECT driver_ext_id, ${vehiclesOverWindow('d.driver_ext_id')} AS plates
         FROM (SELECT DISTINCT driver_ext_id FROM vehicle_driver_day
               WHERE day BETWEEN $1::date AND $2::date) d`, [from, to]),

      moneyCoverage(from, to),
    ]);

    /* The canonical name is the fold key. Two accounts under one spelling are
       one person; an account nobody named keys on its own id, which keeps it
       visible rather than merging every unnamed account into one ghost. */
    const canon = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
      .replace(/\b(\w+)( \1)+\b/g, '$1');
    const alerts = new Map(custody.map((a) => [a.driver_ext_id, a.alerts]));
    /* The hardware half, folded onto the person exactly as the driving half is.
       Without it every person reaches alertRate() with device undefined, and a
       driver whose only alerts are their tracker losing power rates 0.0 — the
       very number this change exists to stop printing. */
    const devAlerts = new Map(custody.map((a) => [a.driver_ext_id, a.device_alerts]));
    const plateRefs = new Map(held.filter((h) => h.plates).map((h) => [h.driver_ext_id, h.plates]));
    /* One standing per person, merged across both tables and across a person's
       platform rows. The soonest licence expiry wins — a driver legal on one
       platform and expired on another is expired — and any single "cannot
       earn" is the answer for the whole person, for the same reason. */
    const standing = new Map();
    for (const s of who) {
      const k = canon(s.full_name);
      if (!k) continue;
      const cur = standing.get(k);
      if (!cur) { standing.set(k, { ...s }); continue; }
      if (s.licence_days_left != null
        && (cur.licence_days_left == null || s.licence_days_left < cur.licence_days_left)) {
        cur.licence_days_left = s.licence_days_left; cur.licence_expires = s.licence_expires;
      }
      cur.state = cur.state || s.state;
      cur.platform_state = cur.platform_state || s.platform_state;
      cur.can_earn = cur.can_earn === false ? false : (cur.can_earn ?? s.can_earn);
    }

    const people = new Map();
    const person = (name, id) => {
      const k = canon(name) || `id:${id}`;
      if (!people.has(k)) {
        people.set(k, { key: k, driver_name: name || id, driver_ext_id: id, ids: [],
          platforms: new Set(), payouts: null, cash: null, payout_days: 0,
          bookings: 0, completed: 0, bookable: 0, days_worked: 0, worked: new Set(),
          km: 0, alert_km: 0, fares: 0,
          priced_bookings: 0, vehicles: 0, plates: [], alerts: 0, reported_km: 0,
          hours_online: null,
          measured_hours_online: null, measured_idle_h: null, availability_days: 0,
          fleet_id: null, last_trip: null });
      }
      const r = people.get(k);
      if (id && !r.ids.includes(id)) r.ids.push(id);
      // The fullest spelling is usually the right one to show.
      if ((name || '').length > (r.driver_name || '').length) r.driver_name = name;
      return r;
    };
    const add = (a, b) => (b == null ? a : (a == null ? Number(b) : a + Number(b)));

    for (const w of work) {
      const r = person(w.driver_name, w.driver_ext_id);
      r.bookings += w.bookings; r.completed += w.completed; r.bookable += w.bookable;
      /* A genuine union. The premise this line used to carry — "the query
         above is already grouped on the person fold, so this only ever adds
         the one row a person has" — was wrong: it groups on PK, the account.
         Anyone with two provider ids arrives here twice. */
      /* isoDay, not String(d).slice(0, 10). `worked_days` is the
         `array_agg(DISTINCT local_day)` above — a date[], OID 1182, never
         wrapped in to_char — and node-postgres parses that into JS Dates:
         getTypeParser(1182, 'text')('{2026-08-21,2026-08-22}') returns Dates
         here, and String(thatDate).slice(0, 10) is "Fri Aug 21", the first ten
         characters of a Date toString. That is the same failure that shipped
         to production in src/sources/ledger.js and printed "covering days up
         to Fri Aug 21" on the Data-sources page.

         The COUNT this Set feeds (r.days_worked, below) was nonetheless right,
         and it was right by luck rather than by construction: dropping the
         year leaves (weekday, month, day), and that stays injective only while
         the data is short enough. It is today — the 702 days this fleet holds,
         2024-10-01..2026-09-02 per source_day_coverage, enumerate to 702
         distinct keys, 0 collisions — but the first collision lands once the
         span reaches 2192 days ("Tue Oct 01" is both 2024-10-01 and
         2030-10-01), and api/window.js accepts `days` up to 3660. From that
         day on, a person whose two accounts each worked one of the colliding
         days would quietly lose a day worked. The Set is also one res.json
         away from showing a reader "Fri Aug 21". */
      (w.worked_days || []).forEach((d) => r.worked.add(isoDay(d)));
      r.km += Number(w.km || 0);
      r.alert_km += Number(w.alert_km || 0);
      r.fares = add(r.fares, w.fares) ?? 0;
      r.priced_bookings += w.priced_bookings;
      r.vehicles = Math.max(r.vehicles, w.vehicles);
      (w.platforms || []).forEach((x) => r.platforms.add(x));
      r.fleet_id = r.fleet_id || w.fleet_id;
      if (!r.last_trip || w.last_trip > r.last_trip) r.last_trip = w.last_trip;
    }
    for (const y of pay) {
      const r = person(y.driver_name, y.driver_ext_id);
      r.payouts = add(r.payouts, y.payouts);
      r.cash = add(r.cash, y.cash);
      r.payout_days = Math.max(r.payout_days, y.payout_days);
      r.reported_km += Number(y.reported_km || 0);
      r.hours_online = add(r.hours_online, y.hours_online);
      (y.platforms || []).forEach((x) => r.platforms.add(x));
      r.fleet_id = r.fleet_id || y.fleet_id;
      r.alerts += alerts.get(y.driver_ext_id) || 0;
      r.device_alerts = (r.device_alerts || 0) + (devAlerts.get(y.driver_ext_id) || 0);
    }
    /* Our own measurement, folded onto the same person.
       ─────────────────────────────────────────────────────────────────────
       People here are keyed by the canonicalised NAME with an `ids` array,
       because one human holds several platform accounts — so an availability
       row keyed on a single account id has to be routed through an index built
       from those arrays, not looked up directly. Two accounts belonging to one
       person are summed, which is the rule every other figure on this endpoint
       already follows. */
    const byAccount = new Map();
    for (const r of people.values()) for (const id of r.ids) byAccount.set(id, r);
    for (const a of avail) {
      const r = byAccount.get(a.driver_ext_id);
      if (!r) continue;
      r.measured_hours_online = add(r.measured_hours_online, a.measured_hours_online);
      r.measured_idle_h = add(r.measured_idle_h, a.measured_idle_h);
      /* Summed, not maxed: two accounts online on the same day is two accounts
         of availability. Days is a count of account-days for that reason and
         is only used to say whether there is any measurement at all. */
      r.availability_days = (r.availability_days || 0) + (a.availability_days || 0);
    }

    // Alerts for accounts that appear in the work set but took no payout.
    for (const r of people.values()) {
      if (r.alerts || r.device_alerts) continue;
      r.alerts = r.ids.reduce((a, id) => a + (alerts.get(id) || 0), 0);
      r.device_alerts = r.ids.reduce((a, id) => a + (devAlerts.get(id) || 0), 0);
    }

    /* Journeys the telematics feed recorded on the cars this person held,
       summed across their accounts the way every other figure here is.
       ─────────────────────────────────────────────────────────────────────
       NULL, not 0, for a person no custody row places in any vehicle in this
       window: "the feed never saw their car" and "we do not know which car
       they were in" are two different absences, and only the first one says
       anything about safety. custodied is the set of accounts vehicle_driver_day
       actually holds a day for — the same query that supplies the plate links
       below, so the two cannot disagree about who has a custody record. */
    const teleBy = new Map(tele.map((t) => [t.driver_ext_id, t.telematics_journeys]));
    const custodied = new Set(held.map((h) => h.driver_ext_id));
    for (const r of people.values()) {
      r.telematics_journeys = r.ids.some((id) => custodied.has(id))
        ? r.ids.reduce((a, id) => a + (teleBy.get(id) || 0), 0)
        : null;
    }

    const rows = [...people.values()].map((r) => {
      const st = standing.get(r.key) || {};
      /* Fares and payouts are added here, unlike on a vehicle row, because a
         person's fares come from the hotel channel and their payouts from Uber
         — different rides on different channels. Within one channel they are
         never both present: no platform this fleet works reports both. */
      const money = round((r.payouts || 0) + (r.fares || 0), 2) || null;
      r.days_worked = r.worked.size;
    const idleDays = Math.max(0, windowDays - r.days_worked);
      return {
        driver_ext_id: r.ids[0] || r.driver_ext_id || null,
        driver_name: r.driver_name,
        ids: r.ids,
        accounts: r.ids.length,
        platforms: [...r.platforms].sort(),
        fleet_id: r.fleet_id,
        money, payouts: r.payouts, fares: r.fares || null, cash: r.cash,
        bookings: r.bookings, completed: r.completed,
        completion_pct: r.bookable ? round((r.completed / r.bookable) * 100, 0) : null,
        km: r.km || null, vehicles: r.vehicles,
        /* The distance the safety rate was taken over. It is smaller than km
           by every kilometre this person drove on a day the alert feed was
           dark, and the page prints both so the difference is visible. */
        alert_km: r.alert_km || null,
        /* The cars, named and openable, merged across the person's accounts
           and re-capped at three so a two-account driver does not get six. */
        plates: [...new Map(r.ids.flatMap((id) => plateRefs.get(id) || [])
          .map((x) => [x.plate, x])).values()]
          .sort((a, b) => b.days - a.days).slice(0, 3),
        days_worked: r.days_worked, payout_days: r.payout_days,
        idle_days: idleDays, window_days: windowDays,
        aed_per_day_worked: rate(money, r.days_worked),
        aed_per_booking: rate(money, r.bookings),
        aed_per_km: rate(money, r.km),
        bookings_per_day: rate(r.bookings, r.days_worked, 1),
        /* Per hour online is the rate an operator most wants and the one this
           fleet cannot have: Uber's payout rows carry no hours at all, and Uber
           is nine bookings in ten. Null rather than a zero, with the reason
           carried on the response so the column can say why it is empty. */
        /* The platform's own figure, kept as it was — on this fleet it is the
           Yango handful, because Uber's payout rows carry no hours. */
        aed_per_hour_online: rate(money, r.hours_online),
        hours_online: r.hours_online,
        /* Ours, from the supplier session rather than from a payout statement,
           so it exists for every channel. This is the honest denominator: a
           day worked can be one job or fourteen hours logged in, and dividing
           by it calls those the same day. */
        measured_hours_online: r.measured_hours_online,
        measured_idle_h: r.measured_idle_h,
        availability_days: r.availability_days || 0,
        aed_per_measured_hour: rate(money, r.measured_hours_online),
        alerts: r.alerts,
        /* Over the days the ALERT FEED covered, not over the window.
           ─────────────────────────────────────────────────────────────────
           This was rate(r.alerts * 100, r.km, 1): a numerator that stops at
           the feed's last good day divided by a denominator that runs to the
           edge of the window. On production 2026-09-02 that arithmetic made
           the fleet roll-up of this column fall from 69.7 per 100 km at 16
           days to 41.5 at 30 — off the identical 69,338 alerts — because the
           feed's 73-day hole contributed distance and nothing else. */
        alerts_per_100km: alertRate(r.alerts, r.alert_km, cov, 1,
          { device: r.device_alerts, tracked: r.telematics_journeys }),
        alerts_per_100km_absent: alertRateReason(r.alert_km, cov,
          { alerts: r.alerts, device: r.device_alerts,
            tracked: r.telematics_journeys }),
        device_alerts: r.device_alerts ?? 0,
        /* Beside the rate rather than instead of it, so a reader can see WHY
           it is absent: 0 here is a car nothing was watching, null is a person
           no custody row places in a car at all. */
        telematics_journeys: r.telematics_journeys,
        state: st.state ?? null,
        platform_state: st.platform_state ?? null,
        can_earn: st.can_earn ?? null,
        licence_expires: st.licence_expires ?? null,
        licence_days_left: st.licence_days_left ?? null,
        last_trip: r.last_trip,
        band: money > 0 ? 'earning' : r.bookings > 0 ? 'drove_unpaid' : 'idle',
      };
    }).sort((a, b) => (b.money ?? 0) - (a.money ?? 0)
      || String(a.driver_name).localeCompare(String(b.driver_name)));

    const sum = (f) => round(rows.reduce((a, r) => a + (Number(f(r)) || 0), 0), 2);
    const money = sum((r) => r.money);
    const workedDays = rows.reduce((a, r) => a + r.days_worked, 0);
    const withHours = rows.filter((r) => r.hours_online > 0).length;
    /* The people an availability window was actually collected for. Every rate
       whose denominator is measured hours is summed over exactly these. */
    const withAvail = rows.filter((r) => r.measured_hours_online > 0);
    const msum = (f) => round(withAvail.reduce((a, r) => a + (Number(f(r)) || 0), 0), 2);

    res.json({
      window: [from, to],
      window_days: windowDays,
      /* Which days the Alerts /100km column was measured over, and the
         assumption that decided them — the same record the vehicle ledger and
         /api/kpis carry, from the same module. */
      alert_coverage: cov,
      rows,
      totals: {
        people: rows.length,
        earning: rows.filter((r) => r.band === 'earning').length,
        drove_unpaid: rows.filter((r) => r.band === 'drove_unpaid').length,
        idle: rows.filter((r) => r.band === 'idle').length,
        money, payouts: sum((r) => r.payouts), fares: sum((r) => r.fares),
        bookings: rows.reduce((a, r) => a + r.bookings, 0),
        km: sum((r) => r.km),
        worked_days: workedDays,
        aed_per_day_worked: rate(money, workedDays),
        /* The honest denominator, where we have it. A day worked can be one
           job or fourteen hours logged in, and dividing by it calls those the
           same day. Null when nothing has been measured yet rather than zero,
           so a page can say "not collected" instead of drawing a rate of
           infinity. */
        measured_hours_online: sum((r) => r.measured_hours_online) || null,
        measured_idle_h: sum((r) => r.measured_idle_h) || null,
        /* Numerator and denominator must describe the SAME people. Availability
           is measured for 90 of 249 here, and dividing everybody's money by
           those 90 people's hours reads 17% high (AED 20.26 against 17.28 on
           the 30 days to 2026-08-28) because it credits the hours of 90 with
           the earnings of 249. Money from the measured people only. */
        measured_money: withAvail.length ? round(msum((r) => r.money), 2) : null,
        aed_per_measured_hour: rate(msum((r) => r.money), msum((r) => r.measured_hours_online)),
        people_with_availability: withAvail.length,
        aed_per_booking: rate(money, rows.reduce((a, r) => a + r.bookings, 0)),
        aed_per_km: rate(money, sum((r) => r.km)),
        /* How many people an hourly rate could be computed for at all. On this
           fleet it is the Yango handful, and the page says so rather than
           drawing an empty column. */
        people_with_hours: withHours,
        hours_note: withHours
          ? `${withHours} of ${rows.length} people have any online hours reported — `
            + 'Uber sends none, so an hourly rate exists only for the rest.'
          : 'No platform on this fleet reports online hours, so there is no hourly rate to compute.',
      },
      coverage,
    });
  }));
}
