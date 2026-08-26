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
         FROM per_plate p LEFT JOIN per_channel_agg a USING (plate)`, p),

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
           SELECT plate, count(*)::int alerts FROM alert
           WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
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
                cd.driver_name current_driver, cd.driver_ext_id current_driver_id,
                cd.as_of driver_as_of
         FROM plates p
         LEFT JOIN tel ON tel.plate = p.plate
         LEFT JOIN doc ON doc.plate = p.plate
         LEFT JOIN al  ON al.plate  = p.plate
         LEFT JOIN vehicle v ON v.plate = p.plate
         LEFT JOIN vehicle_profile vp ON vp.plate = p.plate
         LEFT JOIN vehicle_current_driver cd ON cd.plate = p.plate`, [from, to]),

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
          days_earning: 0, days_moved: 0, km: null, measured_bookings: 0, drivers: 0,
          last_trip: null, fleet_id: null });
      }
      return byPlate.get(plate);
    };
    for (const d of decor) Object.assign(row(d.plate), d, { fleet_id: d.fleet_id || null });
    for (const w of work) {
      const r = row(w.plate);
      Object.assign(r, {
        bookings: w.bookings, telematics_journeys: w.telematics_journeys,
        days_earning: w.days_earning, days_moved: w.days_moved,
        km: n(w.km), measured_bookings: w.measured_bookings, drivers: w.drivers,
        last_trip: w.last_trip, fleet_id: r.fleet_id || w.fleet_id,
      });
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
        alerts_per_100km: rate((r.alerts ?? 0) * 100, r.km, 1),
        any_even_split: !!r.any_even_split,
        soonest_expiry: r.soonest_expiry ?? null,
        doc_days_left: r.doc_days_left ?? null,
        last_trip: r.last_trip ?? null, last_fix: r.last_fix ?? null,
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
    /* Withheld under a fleet filter rather than narrowed — see the query. */
    const unplaced = p[3] ? null
      : round((unatt || []).reduce((a, r) => a + Number(r.earnings || 0), 0), 2);
    const earningDays = rows.reduce((a, r) => a + r.days_earning, 0);

    res.json({
      window: [from, to],
      window_days: windowDays,
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

    const [pay, work, who, custody, held, coverage] = await Promise.all([
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
                round(sum(price) FILTER (WHERE has_fare)::numeric,2) fares,
                count(*) FILTER (WHERE has_fare)::int priced_bookings,
                count(DISTINCT plate) FILTER (WHERE plate IS NOT NULL AND plate <> '')::int vehicles,
                array_agg(DISTINCT platform) platforms,
                min(fleet_id) fleet_id,
                max(requested_at) last_trip
         FROM w GROUP BY 1`, p),

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
         SELECT h.driver_ext_id, count(*)::int alerts
         FROM alert a
         JOIN held h ON h.plate = a.plate
          AND (a.occurred_at AT TIME ZONE 'Asia/Dubai')::date = h.day
         WHERE (a.occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
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
          bookings: 0, completed: 0, bookable: 0, days_worked: 0, worked: new Set(), km: 0, fares: 0,
          priced_bookings: 0, vehicles: 0, plates: [], alerts: 0, reported_km: 0,
          hours_online: null,
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
      (w.worked_days || []).forEach((d) => r.worked.add(String(d).slice(0, 10)));
      r.km += Number(w.km || 0);
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
    }
    // Alerts for accounts that appear in the work set but took no payout.
    for (const r of people.values()) {
      if (r.alerts) continue;
      r.alerts = r.ids.reduce((a, id) => a + (alerts.get(id) || 0), 0);
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
        aed_per_hour_online: rate(money, r.hours_online),
        hours_online: r.hours_online,
        alerts: r.alerts, alerts_per_100km: rate(r.alerts * 100, r.km, 1),
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

    res.json({
      window: [from, to],
      window_days: windowDays,
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
