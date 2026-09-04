/* Per-vehicle detail API — the asset's own set of pages.
   ─────────────────────────────────────────────────────────────────────────
   A vehicle is easier to identify than a driver: the licence plate is the join
   key across every source, and every collector normalises it the same way
   (uppercase, no spaces or dashes). So there is no identity resolution here —
   only the normalisation, applied once, so a plate typed as "L 46174" or
   "l-46174" reaches the same asset.

   What makes the vehicle view worth its own pages is that four different
   systems describe the same car and none of them agree on scope: the ride
   platforms know its trips, the telematics box knows where it physically was,
   the fleet portal knows its documents, and only the combination answers
   "is this asset earning, and is it legal to be on the road". */

import { peopleCount, personKey } from './custody_sql.js';
import { win, winDays } from './window.js';
import { attributedEarnings, unattributedEarnings } from './attribution_sql.js';
import { fleetIncome } from './income_sql.js';
/* The alerts-per-distance rule, shared with the fleet headline, both economics
   ledgers and the driver page. See api/alert_coverage_sql.js. */
import { alertCoverage, alertRate, alertRateReason, drivingCount,
  deviceCount, DEVICE_FAULT_SQL } from './alert_coverage_sql.js';

const normPlate = (s) => String(s || '').toUpperCase().replace(/[\s-]+/g, '');

export function vehicleRoutes(app, { q, wrap, endOfDay }) {

  // `$1..$2` window, `$3` plate — same argument order in every query below.
  const TW = `plate = $3 AND requested_at BETWEEN $1 AND $2`;

  const withVehicle = (fn) => wrap(async (req, res) => {
    const plate = normPlate(req.query.plate);
    if (!plate) return res.status(400).json({ error: 'plate required' });
    const [seen] = await q(
      `SELECT 1 FROM (
         SELECT plate FROM trip WHERE plate = $1
         UNION ALL SELECT plate FROM telemetry_snapshot WHERE plate = $1
         UNION ALL SELECT plate FROM vehicle_driver_day WHERE plate = $1
         UNION ALL SELECT plate FROM vehicle_document WHERE plate = $1
       ) s LIMIT 1`, [plate]);
    if (!seen) return res.status(404).json({ error: 'vehicle not found' });
    return fn(req, res, plate, [...win(req), plate]);
  });

  /* ── directory ─────────────────────────────────────────────────────────
     Every plate we hold anything about, including ones with no trips in the
     window — an asset that earned nothing is exactly the one worth seeing. */
  app.get('/api/vehicles/directory', wrap(async (req, res) => {
    const [from, to] = winDays(req);
    /* The days the alert feed covered. The Per 100 km column on this table was
       computed in the browser as alerts / km, which is the same 16-day
       numerator over a 30-day denominator the fleet headline had: on production
       2026-09-02 that arithmetic halved as the window widened across the feed's
       73-day hole. The rate is computed here now, from the same module the
       vehicle page uses, so the directory and the page a row opens agree. */
    const cov = await alertCoverage(q, from, to);
    const rows = await q(
      `WITH RECURSIVE driven AS (
         /* Which plates has this fleet ever put on the road? The question has
            no window in it and never can — a car that last earned in March is
            a row on this page and a car that has never earned is a different
            row — so asked plainly it reads every trip the fleet has ever
            taken, a third of a gigabyte of them at production's row count, to
            learn two hundred and fifty short strings. The collector is writing
            to that table while the page loads, which leaves the visibility map
            stale, so even the index on plate cannot be read on its own and the
            planner falls back to the heap.

            The driver directory answers its own unbounded question from a
            precomputed table, because "when did this person last drive" is a
            maximum over every row and no index can skip to it. This one is not
            that question. The distinct values of an indexed column are what a
            B-tree already holds, in order, so the register descends
            trip_plate_idx once per plate instead of once per trip: a few
            hundred pages rather than forty thousand, with nothing to refresh,
            nothing to fall back to, and nothing that can drift.

            The trip table is aliased x here, not t, because t is the name the
            shared join in custody_sql gives it everywhere else in this API.
            Two relations answering to one name in a single statement is how a
            join condition quietly points at the wrong one, and this file has
            been bitten by that already. */
         (SELECT min(plate) AS plate FROM trip WHERE plate IS NOT NULL AND plate <> '')
         UNION ALL
         SELECT (SELECT min(x.plate) FROM trip x WHERE x.plate > d.plate)
           FROM driven d WHERE d.plate IS NOT NULL
       ),
       plates AS (
         /* UNION already answers DISTINCT; the register is a set. */
         SELECT plate FROM driven WHERE plate IS NOT NULL
         UNION SELECT plate FROM telemetry_snapshot
         UNION SELECT plate FROM vehicle_document WHERE plate IS NOT NULL
       ),
       by_account AS (
         /* Bookings and telematics journeys counted apart, and distance guarded.
            Summing them showed a 2-3.5x overcount as "trips" and rendered a
            193,027 km odometer row as 1.6 million km against one car. */
         /* One vehicle, one day, one platform, one account: the grain every
            question below is really asked at, and a window holds several times
            fewer of these than it holds trips.

            Reducing first is what pays for the head-count. Two records are one
            human only after the account fold, and the fold is two nested
            regexes — nineteen twentieths of the cost if it runs on every trip
            in a year. The stored column holds that exact value, but reaching
            it means joining the base table, because trip_norm is SELECT t.*
            and a view's column list is frozen at its creation; that join is a
            second sequential read of the whole trip table, and over a wide
            window it was doubling the bytes this request reads in order to
            fetch one text column. Folded here instead, once per surviving row,
            it costs neither. */
         SELECT n.plate, n.local_day, n.platform, n.driver_ext_id, n.driver_name,
                count(*) FILTER (WHERE n.is_booking)::int trips,
                count(*) FILTER (WHERE NOT n.is_booking)::int telematics_journeys,
                sum(n.distance_km) FILTER (WHERE n.is_booking AND n.has_distance) km,
                sum(n.distance_km) FILTER (WHERE NOT n.is_booking AND n.has_distance) telematics_km,
                sum(n.price) FILTER (WHERE n.has_fare) revenue,
                count(*) FILTER (WHERE n.has_fare)::int priced_trips,
                max(n.requested_at) FILTER (WHERE n.is_booking) last_trip,
                max(n.requested_at) last_movement,
                min(n.fleet_id) fleet_id
         FROM trip_norm n
         WHERE n.local_day BETWEEN $1::date AND $2::date AND n.plate IS NOT NULL AND n.plate <> ''
         GROUP BY n.plate, n.local_day, n.platform, n.driver_ext_id, n.driver_name
       ),
       work AS (
         /* The counts and the money add up across those rows; the DISTINCT
            questions — how many days, how many platforms, how many people —
            are asked of the grain that already carries them. A day counts as
            worked when any account booked on it, which is what the test on
            trips says. */
         SELECT a.plate,
                sum(a.trips)::int trips,
                sum(a.telematics_journeys)::int telematics_journeys,
                count(DISTINCT a.local_day) FILTER (WHERE a.trips > 0)::int days,
                count(DISTINCT a.local_day)::int days_moved,
                round(sum(a.km)::numeric,0) km,
                round(sum(a.telematics_km)::numeric,0) telematics_km,
                round(sum(a.revenue)::numeric,0) revenue,
                sum(a.priced_trips)::int priced_trips,
                count(DISTINCT ${personKey('a.driver_ext_id', 'a.driver_name')})::int drivers,
                count(DISTINCT a.platform)::int platforms,
                max(a.last_trip) last_trip,
                max(a.last_movement) last_movement,
                min(a.fleet_id) fleet_id
         FROM by_account a
         GROUP BY a.plate
       ),
       /* The same work again, one CHANNEL at a time, because the income rule
          chooses between a fare and a payout one channel at a time and cannot
          be applied to a plate total. Off by_account rather than off the trip
          table: reading the window twice to ask the same question at a second
          grain is exactly the cost this query was rewritten to remove, and a
          CTE referenced by two aggregates is materialised once and read twice.
          The identical shape /api/economics/assets uses.

          Nested on the plate row rather than returned as a second result set,
          so the two grains cannot arrive describing different windows. */
       chan AS (
         SELECT c.plate, jsonb_agg(jsonb_build_object(
                  'platform', c.platform, 'bookings', c.bookings,
                  'priced_bookings', c.priced_bookings, 'fares', c.fares,
                  'booking_days', c.booking_days)) channels
         FROM (
           SELECT a.plate, a.platform,
                  sum(a.trips)::int bookings,
                  sum(a.priced_trips)::int priced_bookings,
                  round(sum(a.revenue)::numeric,2) fares,
                  count(DISTINCT a.local_day) FILTER (WHERE a.trips > 0)::int booking_days
           FROM by_account a GROUP BY 1,2
         ) c
         /* An FMS row is a telematics twin, not a booking, and it carries no
            fare — so it is not a money channel and must not become one. */
         WHERE c.bookings > 0
         GROUP BY 1
       ),
       tel AS (
         SELECT DISTINCT ON (plate) plate, captured_at last_fix, polled_at, status, speed
         FROM telemetry_snapshot ORDER BY plate, captured_at DESC
       ),
       doc AS (
         SELECT plate, min(expires_at) soonest_expiry, count(*)::int docs
         FROM vehicle_document WHERE expires_at IS NOT NULL GROUP BY plate
       ),
       /* Driving events and hardware faults counted apart. Main Power Lost is
          the tracker complaining about its own wiring, and ranking cars on the
          total made L26356 look 74% worse than it drives (530 against 304 per
          100 km) while L38439 and L39421 — whose alerts are 100% device fault
          and who therefore have no driving measurement at all — sat at the top
          of the page as the two cleanest cars in the fleet. */
       al AS (
         SELECT plate, ${drivingCount()} alerts, ${deviceCount()} device_alerts
         FROM alert
         WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
         GROUP BY plate
       ),
       /* What each car was PAID, not only what its riders were charged.
          ─────────────────────────────────────────────────────────────────────
          This table's money column was sum(trip.price) and nothing else, and
          Uber's trip export carries no fare column at all. Measured on
          production over thirty days: 108 of 140 vehicles showed no money
          whatsoever, on the page whose job is to rank assets by what they
          earn. The other 32 are the hotel channel's cars.

          The money exists — it is simply not a fare. driver_payout_day knows
          what each DRIVER was paid and vehicle_driver_day knows which car they
          were in, so the same attribution the single-vehicle page has always
          used (api/attribution_sql.js) answers it per plate. /api/economics/
          assets already aggregates it exactly this way at fleet scale, so this
          is the proven shape rather than a new one.

          Kept in its own column beside the fares: a fare is what a rider was
          charged for one trip and this is a share of a net weekly payout after
          commission. Adding them would produce a number that is neither.

          This aggregate is the RAW attribution — every channel's payout,
          including the channels whose money the Fares column already carries.
          It ships under the name attributed, and the payout on the response is
          the figure api/income_sql.js CHOOSES per channel, folded below. Note
          the absence of back-ticks in this comment: it lives inside a JS
          template literal, and one would end the query here. */
       attr AS (
         /* One evaluation of the attribution, read twice below — the plate
            total and the per-channel split are two grains of the same rows,
            and this is the expensive fragment in the statement. */
         SELECT plate, platform, day, attributed, basis
         FROM (${attributedEarnings()}) a
       ),
       pay AS (
         SELECT att.plate,
                round(sum(att.attributed)::numeric,2) payout,
                count(DISTINCT att.day)::int payout_days,
                bool_or(att.basis = 'even') AS payout_even_split
         FROM attr att
         GROUP BY 1
       ),
       pay_chan AS (
         SELECT c.plate, jsonb_agg(jsonb_build_object(
                  'platform', c.platform, 'payouts', c.payouts,
                  'payout_days', c.payout_days, 'even_split', c.even_split)) channels
         FROM (
           SELECT att.plate, att.platform,
                  round(sum(att.attributed)::numeric,2) payouts,
                  count(DISTINCT att.day)::int payout_days,
                  bool_or(att.basis = 'even') even_split
           FROM attr att GROUP BY 1,2
         ) c
         GROUP BY 1
       )
       SELECT p.plate,
              coalesce(w.trips,0) trips,
              coalesce(w.telematics_journeys,0) telematics_journeys,
              coalesce(w.days,0) days, coalesce(w.days_moved,0) days_moved,
              w.km, w.telematics_km, w.revenue, coalesce(w.priced_trips,0) priced_trips,
              pay.payout, coalesce(pay.payout_days,0) payout_days, pay.payout_even_split,
              /* The two grains that let api/income_sql.js choose per channel.
                 Nested, so a reader of one row has the whole basis in hand. */
              chan.channels fare_channels, pay_chan.channels payout_channels,
              coalesce(w.drivers,0) drivers, coalesce(w.platforms,0) platforms,
              w.last_trip, w.last_movement,
              coalesce(w.fleet_id, v.fleet_id, vp.fleet_id) fleet_id,
              coalesce(v.make, vp.make) make, coalesce(v.model, vp.model) model,
              coalesce(v.year, vp.year) AS year,
              tel.last_fix, tel.status, tel.speed,
              /* Staleness is a property of the FIX, not of our poll. CABMAN
                 re-sends every vehicle's last position on every cycle, so a
                 tracker dead for a year still got a fresh polled_at. */
              /* Eleven minutes here, thirty in server.js FIX_FRESH, which /api/live
                 and /api/kpis use. Measured on production the two feeds differ
                 enough that neither number fits both — FMS reports every ~5 min,
                 CABMAN sits at a median of 43 — so the pages state which rule
                 they applied rather than one being quietly imposed on both. */
              (now() - tel.last_fix > interval '11 minutes') stale,
              round(extract(epoch FROM now() - tel.last_fix) / 60)::int fix_age_min,
              doc.soonest_expiry, (doc.soonest_expiry::date - now()::date) doc_days_left,
              coalesce(al.alerts,0) alerts,
              /* Carried out of the CTE, not just computed in it. Without this
                 the row reaches alertRate() with device undefined, and a plate
                 whose alerts are 100% hardware rates 0.0 again — which is the
                 exact bug, wearing the fix as a disguise. */
              coalesce(al.device_alerts,0) device_alerts,
              -- The id as well as the name: the page names a person and could
              -- not link to them because the id was dropped here.
              cd.driver_name current_driver, cd.driver_ext_id current_driver_id, cd.as_of driver_as_of
       FROM plates p
       LEFT JOIN work w ON w.plate = p.plate
       LEFT JOIN pay ON pay.plate = p.plate
       LEFT JOIN chan ON chan.plate = p.plate
       LEFT JOIN pay_chan ON pay_chan.plate = p.plate
       LEFT JOIN tel ON tel.plate = p.plate
       LEFT JOIN doc ON doc.plate = p.plate
       LEFT JOIN al  ON al.plate = p.plate
       LEFT JOIN vehicle v ON v.plate = p.plate
       LEFT JOIN vehicle_profile vp ON vp.plate = p.plate
       LEFT JOIN vehicle_current_driver cd ON cd.plate = p.plate
       ORDER BY coalesce(w.trips,0) DESC, p.plate
       LIMIT 500`, [from, to]);
    /* The distance the safety rate is allowed to have, asked SEPARATELY rather
       than as another aggregate inside the query above.
       ─────────────────────────────────────────────────────────────────────
       Its own statement because test/vehicle_directory.test.mjs reads that
       query out of this file and replays it against a hand-written copy to
       prove the two agree — it finds the query by its `, [from, to]) binding
       and cannot substitute an interpolation, so a fifth parameter there turns
       the equivalence check into a parse error rather than a comparison. The
       arithmetic is identical either way and the rule still lives in exactly
       one place; only the round trip is separate. */
    const km = await q(
      `SELECT plate, round(sum(distance_km)
                FILTER (WHERE is_booking AND has_distance)::numeric,0) alert_km
         FROM trip_norm
        WHERE local_day BETWEEN $1::date AND $2::date
          AND local_day = ANY($3::date[])
          AND plate IS NOT NULL AND plate <> ''
        GROUP BY plate`, [from, to, cov.days]);
    const alertKm = new Map(km.map((r) => [r.plate, r.alert_km == null ? null : Number(r.alert_km)]));

    /* ── the two kinds of money, per channel, so neither is counted twice ──
       The Payout column was `pay.payout` above — sum(attributed) over EVERY
       channel — while the Fares column beside it carried the fares of the
       channels that price per trip. Yango does both: it reports a fare on
       every booking AND pays the driver weekly. So the same money appeared in
       both cells of the same row, which is the one thing api/income_sql.js
       exists to prevent.

       Measured on production 2026-09-02, the same plate in the same window on
       two pages:

         /api/vehicles/directory?days=2   L36397 payout 1,700.03 (1,899.58 by
                                          the time the Dubai day had filled)
         /api/economics/assets?days=2     L36397 payouts 1,601.17,
                                          attributed 1,677.17, fares 66

       and fleet-wide the directory's payout column summed to the economics
       `attributed` total to the cent — 60,157.28 against 59,893.28 of chosen
       payout, AED 264 of Yango money in two columns at once. Small only
       because Yango is 7 of 1,003 bookings; the rule is not.

       chooseBasis picks one figure per channel, exactly as
       /api/economics/assets does per plate and /api/vehicle/kpis does for one
       car. The channel rows ride nested on each plate's row (`fare_channels`
       and `payout_channels` above) rather than arriving from statements of
       their own: asking the window a second time to answer the same question
       at a second grain is the cost this query was rewritten to remove. */
    /* Whole Dubai days, inclusive — the denominator chooseBasis measures a
       channel's payout coverage against. Date.parse on a bare 'YYYY-MM-DD' is
       UTC midnight for both ends, so the subtraction is exact. String(aDate)
       would give "Sat Aug 01 2026" and never reach this far. */
    const windowDays = Math.max(1, Math.round(
      (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1);
    const num = (v) => (v == null ? null : Number(v));
    const channelsOf = (r) => {
      const m = new Map();
      const at = (name) => {
        if (!m.has(name)) {
          m.set(name, { platform: name, bookings: 0, priced_bookings: 0, fares: null,
            booking_days: 0, payouts: null, payout_days: 0, even_split: false });
        }
        return m.get(name);
      };
      for (const c of (r.fare_channels || [])) {
        Object.assign(at(c.platform), { bookings: c.bookings, priced_bookings: c.priced_bookings,
          fares: num(c.fares), booking_days: c.booking_days });
      }
      for (const c of (r.payout_channels || [])) {
        Object.assign(at(c.platform), { payouts: num(c.payouts),
          payout_days: c.payout_days ?? 0, even_split: !!c.even_split });
      }
      return [...m.values()];
    };

    /* `payout_days` has to describe the figure printed beside it, which is the
       union of the days the CHOSEN channels paid over — not the sum of their
       day counts, and not the raw all-channel count above. Two shapes give it
       exactly for nothing: one chosen channel is its own day count, and every
       paying channel chosen is the count `pay` already made. A mixed basis
       across three or more paying channels on ONE plate is neither, and no
       fleet here has produced it yet — so it is asked for rather than
       estimated, once, for only the plates that need it. */
    const basisOf = (r) => {
      const pf = channelsOf(r);
      const income = fleetIncome(pf, windowDays);
      return {
        income,
        chosenPay: pf.filter((c) => c.basis === 'payout' || c.basis === 'partial_payout'),
        chosenFare: pf.filter((c) => c.basis === 'fares' || c.basis === 'partial_fares'),
        paying: pf.filter((c) => c.payouts != null),
      };
    };
    const chosen = new Map(rows.map((r) => [r.plate, basisOf(r)]));
    const mixed = rows.filter((r) => {
      const b = chosen.get(r.plate);
      return b.chosenPay.length >= 2 && b.chosenPay.length < b.paying.length;
    });
    const mixedDays = new Map();
    if (mixed.length) {
      const pairs = mixed.flatMap((r) => chosen.get(r.plate).chosenPay
        .map((c) => [r.plate, c.platform]));
      for (const d of await q(
        `SELECT att.plate, count(DISTINCT att.day)::int payout_days
         FROM (${attributedEarnings()}) att
         JOIN unnest($3::text[], $4::text[]) AS k(plate, platform)
           ON k.plate = att.plate AND k.platform = att.platform
         GROUP BY 1`,
        [from, to, pairs.map((x) => x[0]), pairs.map((x) => x[1])])) {
        mixedDays.set(d.plate, d.payout_days);
      }
    }

    /* The rate, and enough beside it for the column to say which days it is
       about. The whole coverage record is not repeated onto 500 rows; the two
       counts it takes to write "22 of 30 days" are. */
    res.json(rows.map((row) => {
      /* The nested channel rows are the working, not the answer. Dropped here
         rather than shipped: 500 plates carrying every channel's coverage
         fields is a page of JSON nobody reads, and the two figures they decide
         are on the row already. */
      const { fare_channels: _f, payout_channels: _p, ...r } = row;
      const ak = alertKm.get(r.plate) ?? null;
      const { income, chosenPay, chosenFare, paying } = chosen.get(r.plate);
      const payDays = chosenPay.length === 0 ? 0
        : chosenPay.length === 1 ? chosenPay[0].payout_days
          : chosenPay.length === paying.length ? (r.payout_days || 0)
            : (mixedDays.get(r.plate) ?? 0);
      return {
        ...r,
        /* Both halves of the money, each counted on ONE basis. `revenue` is
           the fares of the channels believed on their fares and `payout` the
           attributed pay of the channels believed on their payout, so the two
           cells of a row are disjoint and a reader may add them. They are the
           identical fields /api/economics/assets returns for the same plate
           and window, and test/vehicle_payout_basis.test.mjs requires that. */
        revenue: income.accounted_fares,
        /* Priced bookings BEHIND that figure, not every priced booking on the
           car: the count annotates the money, and a channel whose fares were
           dropped for its payout must not lend it bookings. */
        priced_trips: chosenFare.reduce((a, c) => a + (c.priced_bookings || 0), 0),
        payout: income.accounted_payouts,
        payout_days: payDays,
        payout_even_split: chosenPay.some((c) => c.even_split),
        /* The raw attribution keeps its own name beside the chosen figure. It
           is the only one that RECONCILES — every plate's attributed, plus the
           periods that reached no plate, is what the platforms paid — and it
           is what this column used to hold. */
        /* A number, like the chosen figure beside it: PG hands a NUMERIC back
           as a string, and a column a reader may subtract from another must
           not arrive as one of each. */
        attributed: num(r.payout),
        attributed_days: r.payout_days || 0,
        /* Which channels each half came from, so the column can say it. */
        fares_platforms: chosenFare.map((c) => c.platform).sort(),
        payout_platforms: chosenPay.map((c) => c.platform).sort(),
        alert_km: ak,
        alerts_per_100km: alertRate(r.alerts, ak, cov, 1, { device: r.device_alerts }),
        alerts_per_100km_absent: alertRateReason(ak, cov,
          { alerts: r.alerts, device: r.device_alerts }),
        device_alerts: r.device_alerts ?? 0,
        alert_days: cov.covered_days, alert_window_days: cov.window_days,
      };
    }));
  }));

  /* ── the hours between drivers ──────────────────────────────────────────
     A vehicle is the expensive thing on this fleet and roughly one vehicle-day
     in eight has more than one driver on it. Both of those drivers "worked
     that day", so every per-day number in this product reports the car as
     used — while the asset itself stood still between the two of them.

     A handover gap is measured from the moment the outgoing driver's last job
     ENDED to the moment the incoming driver's first job was requested. The end
     matters: custody only ever stored max(requested_at), so a gap measured
     from that silently swallows the whole duration of the last trip. See
     sql/schema_v39.sql, which adds the drop-off time to the fold.

     Two kinds of gap, kept apart because they are different businesses:
       · under a day  — the change-over itself, which a rota can shorten
       · a day or more — the car went out of service between drivers, which is
         the idle-asset question the directory above already answers
     Reporting one number for both would let a single car parked for a week
     drown out every real handover on the fleet. */
  const HANDOVER_MAX_H = 24;
  app.get('/api/vehicles/handover', wrap(async (req, res) => {
    /* winDays plus the two chips, spelled out rather than threading server.js's
       range() through this module's injected dependencies — the precedent is
       /api/drivers/directory, and a new required dep silently 500s every
       harness that mounts these routes without it. */
    const [from, to] = winDays(req);
    const p = [from, to, req.query.platform || null, req.query.fleet || null];

    /* One stint = one person's work on one plate on one Dubai day. Grouping by
       day splits a shift that crosses midnight in two, which costs nothing:
       only a gap where the PERSON changes is counted, so two consecutive
       stints of the same driver never produce one. */
    const GAPS = `
      WITH stint AS (
        SELECT plate,
               coalesce(nullif(person_key, ''), driver_ext_id) AS person,
               max(driver_name) AS driver_name,
               /* The provider id, kept beside the folded key: the fold is what
                  decides two records are one human, and the id is what a link
                  to that human needs. A page that can only print a name cannot
                  open the person whose shift ran late. */
               min(driver_ext_id) AS person_id,
               min(first_trip_at) AS s,
               max(coalesce(last_end_at, last_trip_at)) AS e
          FROM vehicle_driver_day
         WHERE day BETWEEN $1::date AND $2::date
           AND first_trip_at IS NOT NULL
           AND ($3::text IS NULL OR platform = $3)
           AND ($4::text IS NULL OR fleet_id = $4)
         GROUP BY plate, day, 2
      ),
      ord AS (
        /* prev_end is a RUNNING MAX, not the previous row's end. Two drivers
           whose stints overlap — the same car reported by two platforms, or a
           booking recorded a minute before the last one closed — would
           otherwise produce a gap measured from a stint that had already been
           superseded, and the number would read as free time the car never
           had. */
        SELECT plate, person, driver_name, person_id, s, e,
               lag(person)      OVER w AS prev_person,
               lag(driver_name) OVER w AS prev_name,
               lag(person_id)   OVER w AS prev_id,
               max(e) OVER (PARTITION BY plate ORDER BY s
                            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
          FROM stint
        WINDOW w AS (PARTITION BY plate ORDER BY s)
      ),
      gap AS (
        SELECT plate, prev_name AS from_driver, prev_id AS from_id,
               driver_name AS to_driver, person_id AS to_id,
               prev_end AS free_at, s AS taken_at,
               extract(epoch FROM (s - prev_end)) / 3600 AS h
          FROM ord
         WHERE prev_person IS NOT NULL AND prev_person <> person AND s > prev_end
      )`;

    const [tot, plates, cover] = await Promise.all([
      q(`${GAPS}
         SELECT count(*) FILTER (WHERE h < ${HANDOVER_MAX_H})::int              AS handovers,
                count(DISTINCT plate) FILTER (WHERE h < ${HANDOVER_MAX_H})::int AS plates,
                round(sum(h) FILTER (WHERE h < ${HANDOVER_MAX_H})::numeric, 1)  AS handover_h,
                round(percentile_cont(0.5) WITHIN GROUP (ORDER BY h)
                        FILTER (WHERE h < ${HANDOVER_MAX_H})::numeric, 1)       AS median_h,
                round(percentile_cont(0.25) WITHIN GROUP (ORDER BY h)
                        FILTER (WHERE h < ${HANDOVER_MAX_H})::numeric, 1)       AS quick_h,
                round(percentile_cont(0.9) WITHIN GROUP (ORDER BY h)
                        FILTER (WHERE h < ${HANDOVER_MAX_H})::numeric, 1)       AS p90_h,
                count(*) FILTER (WHERE h >= ${HANDOVER_MAX_H})::int             AS parked,
                round((sum(h) FILTER (WHERE h >= ${HANDOVER_MAX_H}))::numeric / 24, 1) AS parked_days
           FROM gap`, p),
      q(`${GAPS}
         SELECT plate,
                count(*)::int AS handovers,
                round(sum(h)::numeric, 1) AS idle_h,
                round(percentile_cont(0.5) WITHIN GROUP (ORDER BY h)::numeric, 1) AS median_h,
                round(max(h)::numeric, 1) AS worst_h,
                (array_agg(from_driver ORDER BY h DESC))[1] AS worst_from,
                (array_agg(from_id     ORDER BY h DESC))[1] AS worst_from_id,
                (array_agg(to_driver   ORDER BY h DESC))[1] AS worst_to,
                (array_agg(to_id       ORDER BY h DESC))[1] AS worst_to_id,
                (array_agg(free_at     ORDER BY h DESC))[1] AS worst_at
           FROM gap
          WHERE h < ${HANDOVER_MAX_H}
          GROUP BY plate
          ORDER BY sum(h) DESC, plate
          LIMIT 200`, p),
      /* How much of this is measured rather than assumed. A stint whose last
         row carries no drop-off time contributes its request time instead, so
         its gap is that trip's duration too long. Stated, not hidden. */
      q(`SELECT count(*)::int AS rows_in,
                count(*) FILTER (WHERE last_end_at IS NOT NULL)::int AS timed
           FROM vehicle_driver_day
          WHERE day BETWEEN $1::date AND $2::date
            AND first_trip_at IS NOT NULL
            AND ($3::text IS NULL OR platform = $3)
            AND ($4::text IS NULL OR fleet_id = $4)`, p),
    ]);

    const t = tot[0] || {};
    const c = cover[0] || { rows_in: 0, timed: 0 };
    const num = (v) => (v == null ? null : Number(v));
    const handovers = num(t.handovers) || 0;
    const quick = num(t.quick_h);
    const total = num(t.handover_h) || 0;
    res.json({
      window: [from, to],
      max_gap_h: HANDOVER_MAX_H,
      totals: {
        handovers,
        plates: num(t.plates) || 0,
        handover_h: total,
        handover_days: Math.round((total / 24) * 10) / 10,
        median_h: num(t.median_h),
        quick_h: quick,
        p90_h: num(t.p90_h),
        parked: num(t.parked) || 0,
        parked_days: num(t.parked_days) || 0,
        /* The fleet's own benchmark, not an invented target: what it would
           recover if every change-over went as fast as its own quickest
           quarter already do. */
        recoverable_h: quick != null && handovers
          ? Math.round(Math.max(0, total - quick * handovers) * 10) / 10 : null,
        timed_rows: c.timed, custody_rows: c.rows_in,
      },
      plates: plates.map((r) => ({
        plate: r.plate,
        handovers: r.handovers,
        idle_h: num(r.idle_h),
        median_h: num(r.median_h),
        worst_h: num(r.worst_h),
        worst_from: r.worst_from, worst_to: r.worst_to, worst_at: r.worst_at,
        /* Both people on the worst gap, in the shape every other list in this
           API uses for a custodian — {name, id} pairs, so the reader can open
           whichever of the two they need to talk to. */
        driver_refs: [{ name: r.worst_from, id: r.worst_from_id },
                      { name: r.worst_to, id: r.worst_to_id }].filter((d) => d.name),
      })),
    });
  }));
  /* ── what this asset is ────────────────────────────────────────────────── */
  app.get('/api/vehicle/profile', withVehicle(async (req, res, plate, p) => {
    const [spec] = await q(
      `SELECT coalesce(v.make, vp.make) make, coalesce(v.model, vp.model) model,
              coalesce(v.year, vp.year) AS year, coalesce(v.color, vp.colour) colour,
              coalesce(v.vin, vp.vin) vin, v.fuel_type, vp.image_url, vp.colour_hex,
              vp.compliance_status, vp.platform, vp.vehicle_ext_id,
              coalesce(v.fleet_id, vp.fleet_id) fleet_id
       FROM (SELECT $1::text AS plate) k
       LEFT JOIN vehicle v ON v.plate = k.plate
       LEFT JOIN vehicle_profile vp ON vp.plate = k.plate`, [plate]);
    /* Bookings and telematics twins, counted apart.
       ─────────────────────────────────────────────────────────────────────
       This read raw "trip", so span.trips was bookings PLUS the FMS journeys
       that are the same physical trips seen by the tracker: L36397 reported
       547 where the car took 325 bookings and the tracker logged 222 twins of
       them. sql/schema_v7.sql sets is_booking = (platform <> 'fms') for
       exactly this, and lines 314, 439 and 461 below already respect it.
       Both figures are returned, because "it moved 222 times without a
       booking" is its own fact and deleting it would be the opposite error. */
    /* …and the ENDS of the span needed the same guard the counts got.
       ─────────────────────────────────────────────────────────────────────
       first_trip and last_trip were min/max over every row, so the last thing
       the TRACKER saw was served under the name of the last thing a rider paid
       for. Measured on production over 365 days: 46 of 227 plates carry an FMS
       row after their last booking — L36395 last earned at 05:07 and this
       endpoint reported 05:12, L44251 04:32 against 04:49, L36485 06:25
       against 06:36 — and a car with no bookings at all in the window reported
       a last_trip of whenever its tracker last reported. That is the same
       widening of the word "trip" that made span.trips read 547 on a car that
       took 325 bookings, and it put this page's "last trip" against idle days
       and utilisation figures that count is_booking.

       The unfiltered value is not deleted: it is the last time the car MOVED,
       which is its own fact, and it keeps the name /api/vehicles/directory
       already gives it (last_movement, beside its own is_booking-filtered
       last_trip) so the two pages describing one car use one word per fact. */
    const [span] = await q(
      `SELECT min(requested_at) FILTER (WHERE is_booking) first_trip,
              max(requested_at) FILTER (WHERE is_booking) last_trip,
              min(requested_at) first_movement, max(requested_at) last_movement,
              count(*) FILTER (WHERE is_booking)::int trips,
              count(*) FILTER (WHERE NOT is_booking)::int telematics_journeys,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)
                FILTER (WHERE is_booking)::int days_worked,
              ${peopleCount()}::int drivers
       FROM trip_norm WHERE ${TW}`, p);
    const [tel] = await q(
      `SELECT captured_at last_fix, polled_at, lat, lng, speed, status, seat_occupied,
              odometer, fuel_level, ignition, source,
              (now() - polled_at > interval '11 minutes') stale
       FROM telemetry_snapshot WHERE plate = $1 ORDER BY captured_at DESC LIMIT 1`, [plate]);
    const documents = await q(
      `SELECT platform, doc_type, status, expires_at,
              (expires_at::date - now()::date) days_left
       FROM vehicle_document WHERE plate = $1 ORDER BY expires_at ASC NULLS LAST`, [plate]);
    const [current] = await q(
      `SELECT driver_name, driver_ext_id, as_of FROM vehicle_current_driver WHERE plate = $1`, [plate]);
    res.json({ plate, spec, span, telemetry: tel || null, documents, current_driver: current || null });
  }));

  /* ── headline numbers ─────────────────────────────────────────────────── */
  app.get('/api/vehicle/kpis', withVehicle(async (req, res, plate, p) => {
    /* Which days the alert feed covered, on the Dubai calendar this product
       keys every day on — winDays, not the timestamp bounds in p.
       ─────────────────────────────────────────────────────────────────────
       Both halves of alerts_per_100km are narrowed to them. It used to be
       every alert on this plate over every kilometre it drove, and on
       production 2026-09-02 that made the same fleet arithmetic read 69.7 per
       100 km at 16 days and 41.5 at 30 off an identical 69,338 alerts: the
       feed had a 73-day hole (2026-06-06 to 2026-08-17) and the days a wider
       window reached into contributed distance and nothing else. A car's
       safety therefore improved every time somebody widened the range. */
    const [covFrom, covTo] = winDays(req);
    const cov = await alertCoverage(q, covFrom, covTo);
    const [t] = await q(
      /* Every aggregate here is guarded, because `plate` is the join key and
         FMS telematics rows carry plates. Their distances are odometer-derived
         and one row can read 193,027 km, so an unguarded sum makes a vehicle's
         "km driven" a number nobody can reconcile with anything. `trips` had
         the same problem in the other direction: an FMS row is the same
         physical journey a ride platform already reported, so counting both
         showed this vehicle doing two to three times the work it did. */
      `SELECT count(*) FILTER (WHERE is_booking)::int trips,
              count(*) FILTER (WHERE NOT is_booking)::int telematics_journeys,
              count(DISTINCT local_day)::int days_worked,
              count(DISTINCT local_day) FILTER (WHERE is_booking)::int days_earning,
              round(sum(distance_km) FILTER (WHERE has_distance AND is_booking)::numeric,0) km,
              /* The same distance, narrowed to the days the alert feed was up:
                 the only denominator alerts_per_100km may have. Beside the
                 whole-window km, never instead of it — revenue per km is a
                 question about the window and must not be narrowed. */
              round(sum(distance_km) FILTER (WHERE has_distance AND is_booking
                    AND local_day = ANY($4::date[]))::numeric,0) alert_km,
              round(avg(distance_km) FILTER (WHERE has_distance AND is_booking)::numeric,1) avg_km,
              count(*) FILTER (WHERE has_distance AND is_booking)::int measured_trips,
              round(sum(price) FILTER (WHERE has_fare)::numeric,2) revenue,
              round(avg(price) FILTER (WHERE has_fare)::numeric,2) avg_fare,
              count(*) FILTER (WHERE has_fare)::int priced_trips,
              /* The distance of the PRICED trips, which is the only denominator
                 revenue per km can honestly have. Dividing the revenue of the
                 eleven trips that carry a fare by the distance of all 232
                 measured ones produced "AED 0.14 per km" on a car earning
                 normally — a number that is not wrong about anything, because
                 its two halves describe different populations. */
              round(sum(distance_km) FILTER (WHERE has_fare AND has_distance)::numeric,0) priced_km,
              -- The matching numerator: revenue over the trips that report BOTH
              -- a fare and a distance, so the per-km figure is checkable.
              round(sum(price) FILTER (WHERE has_fare AND has_distance)::numeric,2) priced_measured_revenue,
              count(*) FILTER (WHERE has_fare AND has_distance)::int priced_measured_trips,
              -- outcome, not status: Bolt reports a completed trip as
              -- 'finished', and FMS telematics rows hardcode 'completed' on
              -- journeys that cannot be cancelled, so a bare status test both
              -- under-counted real completions and padded the denominator.
              round(100.0*count(*) FILTER (WHERE outcome='completed')
                    /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) completion_pct,
              count(*) FILTER (WHERE outcome IS NOT NULL)::int outcome_n,
              -- The numerators, beside the rates. A rate reported with only its
              -- denominator is a figure the reader has to take on trust.
              count(*) FILTER (WHERE outcome='completed')::int completed,
              count(*) FILTER (WHERE outcome='not_completed')::int not_completed,
              round(100.0*count(*) FILTER (WHERE outcome='not_completed')
                    /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) cancel_pct,
              ${peopleCount()}::int drivers,
              count(DISTINCT platform) FILTER (WHERE is_booking)::int platforms
       FROM trip_norm WHERE ${TW}`, [...p, cov.days]);
    const [u] = await q(
      `SELECT round(avg(utilisation)::numeric,3) utilisation,
              round(sum(hours_online)::numeric,1) hours_online,
              round(sum(hours_on_trip)::numeric,1) hours_on_trip,
              round(avg(earnings_per_hour)::numeric,2) earnings_per_hour,
              round(avg(trips_per_online_hour)::numeric,2) trips_per_online_hour
       FROM vehicle_utilisation
       WHERE plate = $3 AND period_start >= $1::date AND period_end <= $2::date`, p);
    /* Narrowed to the covered days too. It changes no count — a day with no
       alerts contributes none — and is written out so the numerator and the
       denominator name the same day set explicitly rather than by luck. */
    const [a] = await q(
      `SELECT ${drivingCount()} alerts, ${deviceCount()} device_alerts FROM alert
       WHERE plate = $3 AND occurred_at BETWEEN $1 AND $2
         AND (occurred_at AT TIME ZONE 'Asia/Dubai')::date = ANY($4::date[])`,
      [...p, cov.days]);
    const [gap] = await q(
      `SELECT extract(epoch from (now() - max(captured_at)))/3600 hours_since_fix,
              count(*)::int fixes
       FROM telemetry_snapshot WHERE plate = $3 AND captured_at BETWEEN $1 AND $2`, p);
    // Idle days: days the tracker reported but no platform recorded a trip —
    // the asset was present and powered, and earned nothing.
    const [idle] = await q(
      `WITH seen AS (
         SELECT DISTINCT (captured_at AT TIME ZONE 'Asia/Dubai')::date AS day
         FROM telemetry_snapshot WHERE plate = $3 AND captured_at BETWEEN $1 AND $2),
       /* A day the tracker twinned a booking is not a day the car earned
          nothing. This read raw "trip", so an FMS twin counted as earning and
          the tile disagreed with the caption printed directly beneath it:
          L26356 showed "Idle days 2" over "5 day(s) with a tracker fix and no
          trip". is_booking is the same predicate the rest of this file uses. */
       earned AS (
         SELECT DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day
         FROM trip_norm WHERE ${TW} AND is_booking)
       SELECT count(*)::int idle_days FROM seen WHERE day NOT IN (SELECT day FROM earned)`, p);
    /* The money this asset actually made. `revenue` above is the sum of the
       FARES on its trips, and on this fleet that is ten hotel bookings out of
       266 — the other 256 are Uber, which prices nothing at trip level and
       pays the DRIVER weekly instead. So the car read as earning AED 525 on
       3,586 km. This is that driver pay, spread across the vehicles its driver
       was actually holding (api/attribution_sql.js).

       Kept as its own field, never folded into `revenue`: a fare is what one
       rider paid for one trip, this is a share of a net weekly payout after
       commission, and adding them would produce a number that is neither. */
    const [att] = await q(
      `SELECT round(sum(attributed)::numeric,2) attributed_earnings,
              count(DISTINCT platform)::int attributed_platforms,
              count(DISTINCT driver_ext_id)::int attributed_drivers,
              bool_or(basis = 'even') AS any_even_split
       FROM (${attributedEarnings({ extra: 'AND vd.plate = $3' })}) att`, p);
    /* And the two of them combined, per platform, which is the number a person
       looking at a car actually wants. Both halves are already here and the
       page showed only the first: a car working mostly Uber led with the fares
       on its handful of hotel bookings.

       Per platform because the two cannot be added for the SAME one — a payout
       is what is left of those same fares after commission. The rule is the one
       /api/kpis and /api/revenue use (api/income_sql.js), so a car's Money in
       is built the same way as the fleet's. */
    const [fareByPlat, attByPlat] = await Promise.all([
      q(`SELECT platform, count(*)::int bookings,
                count(*) FILTER (WHERE has_fare)::int priced_bookings,
                round(sum(price) FILTER (WHERE has_fare)::numeric,2) fares
         FROM trip_norm WHERE ${TW} AND is_booking GROUP BY 1`, p),
      q(`SELECT platform, round(sum(attributed)::numeric,2) payouts,
                count(DISTINCT day)::int payout_days
         FROM (${attributedEarnings({ extra: 'AND vd.plate = $3' })}) att GROUP BY 1`, p),
    ]);
    const byPlat = new Map();
    const plat = (name) => {
      if (!byPlat.has(name)) {
        byPlat.set(name, { platform: name, bookings: 0, booking_days: 0, priced_bookings: 0,
          fares: null, payouts: null, payout_days: 0 });
      }
      return byPlat.get(name);
    };
    const n = (v) => (v == null ? null : Number(v));
    for (const f of fareByPlat) Object.assign(plat(f.platform), {
      bookings: f.bookings, priced_bookings: f.priced_bookings, fares: n(f.fares) });
    for (const y of attByPlat) Object.assign(plat(y.platform), {
      payouts: n(y.payouts), payout_days: y.payout_days ?? 0 });
    const windowDays = Math.round((Date.parse(p[1]) - Date.parse(p[0])) / 86400000) + 1;
    const income = fleetIncome([...byPlat.values()], windowDays);

    res.json({ ...t, ...u, ...a, ...gap, ...idle, ...att, ...income,
      /* Over the days the alert feed covered — see the note at the top of this
         handler for the production numbers this replaces. Null, never 0, for a
         window the feed was dark for: alert_coverage says which days those
         were and the page renders it as "not measured". */
      alerts_per_100km: alertRate(a.alerts, t.alert_km, cov, 1, { device: a.device_alerts }),
      alerts_per_100km_absent: alertRateReason(t.alert_km, cov,
        { alerts: a.alerts, device: a.device_alerts }),
      device_alerts: a.device_alerts ?? 0,
      alert_coverage: cov,
      // Over the priced distance, and from the revenue of the same trips —
      // see priced_measured_revenue above.
      revenue_per_km: t.priced_km > 0 && t.priced_measured_revenue
        ? +(t.priced_measured_revenue / t.priced_km).toFixed(2) : null });
  }));

  /* ── the daily spine ──────────────────────────────────────────────────── */
  app.get('/api/vehicle/daily', withVehicle(async (req, res, plate, p) => res.json(await q(
    `WITH t AS (
       SELECT local_day AS day,
              count(*) FILTER (WHERE is_booking)::int trips,
              count(*) FILTER (WHERE NOT is_booking)::int telematics_journeys,
              -- ILIKE '%cancel%' missed three of Bolt's four failure modes
              -- (client_did_not_show, driver_did_not_respond, driver_rejected).
              count(*) FILTER (WHERE outcome='not_completed')::int cancelled,
              count(*) FILTER (WHERE outcome IS NOT NULL)::int outcome_n,
              -- Guarded: an odometer row on this plate would otherwise put a
              -- six-figure km on a single day of this vehicle's chart.
              round(sum(distance_km) FILTER (WHERE has_distance AND is_booking)::numeric,1) km,
              round(sum(price) FILTER (WHERE has_fare)::numeric,2) revenue,
              ${peopleCount()}::int drivers
       FROM trip_norm WHERE ${TW} GROUP BY 1),
     g AS (
       SELECT (captured_at AT TIME ZONE 'Asia/Dubai')::date AS day, count(*)::int fixes,
              round(max(speed)::numeric,0) top_speed,
              round(avg(fuel_level)::numeric,0) fuel_level
       FROM telemetry_snapshot WHERE plate = $3 AND captured_at BETWEEN $1 AND $2 GROUP BY 1),
     a AS (
       SELECT (occurred_at AT TIME ZONE 'Asia/Dubai')::date AS day, count(*)::int alerts
       FROM alert WHERE plate = $3 AND occurred_at BETWEEN $1 AND $2 GROUP BY 1),
     d AS (
       SELECT day, string_agg(DISTINCT driver_name, ', ') drivers_named
       FROM vehicle_driver_day WHERE plate = $3 AND day BETWEEN $1::date AND $2::date GROUP BY day)
     SELECT coalesce(t.day, g.day, a.day) AS day,
            coalesce(t.trips,0) trips, coalesce(t.cancelled,0) cancelled,
            t.km, t.revenue, coalesce(t.drivers,0) drivers,
            coalesce(g.fixes,0) fixes, g.top_speed, g.fuel_level,
            coalesce(a.alerts,0) alerts, d.drivers_named,
            w.temp_max, c.is_holiday, c.holiday_name
     FROM t FULL OUTER JOIN g ON g.day = t.day
            FULL OUTER JOIN a ON a.day = coalesce(t.day, g.day)
            LEFT JOIN d ON d.day = coalesce(t.day, g.day, a.day)
            LEFT JOIN weather_daily w ON w.day = coalesce(t.day, g.day, a.day)
            LEFT JOIN calendar_day c ON c.day = coalesce(t.day, g.day, a.day)
     ORDER BY 1`, p))));

  /* ── who drove it, day by day ─────────────────────────────────────────── */
  /* Day-by-day custody for one plate, handovers included. Moved here from
     server.js, where it answered 200 for a plate that does not exist while
     every other vehicle route 404s — so a typo rendered as a car that did
     nothing rather than as a car we have never heard of. */
  app.get('/api/vehicle/drivers', withVehicle(async (req, res, plate, p) => res.json(await q(
    `SELECT day, driver_ext_id, driver_name, platform, trips, km, revenue,
            first_trip_at, last_trip_at, is_primary
     FROM vehicle_driver_day
     WHERE plate = $3 AND day BETWEEN $1::date AND $2::date
     ORDER BY day DESC, trips DESC`, [...winDays(req), plate]))));

  app.get('/api/vehicle/drivers-detail', withVehicle(async (req, res, plate, p) => {
    const days = await q(
      `SELECT day, driver_ext_id, driver_name, platform, trips, km, revenue,
              first_trip_at, last_trip_at, is_primary
       FROM vehicle_driver_day WHERE plate = $3 AND day BETWEEN $1::date AND $2::date
       ORDER BY day DESC, trips DESC`, p);
    /* Grouped by PERSON, not by platform record. Uber issues a UUID, Yango
       another, Bolt a third — for the same human — so grouping on
       driver_ext_id listed Muhammad Khalid twice, side by side, with his work
       split between the two rows and neither of them right. Every id they hold
       comes back beside the fold so both spellings stay openable and the row
       can say how many accounts it is standing for. */
    const totals = await q(
      `SELECT ${personKey()} AS person,
              max(driver_name) driver_name,
              (array_agg(DISTINCT driver_ext_id))[1] AS driver_ext_id,
              array_agg(DISTINCT driver_ext_id) AS driver_ids,
              count(DISTINCT day)::int days,
              sum(trips)::int trips, round(sum(km)::numeric,0) km,
              round(sum(revenue)::numeric,0) revenue,
              min(day) first_day, max(day) last_day,
              count(DISTINCT day) FILTER (WHERE is_primary)::int primary_days,
              array_agg(DISTINCT platform) AS platforms
       FROM vehicle_driver_day WHERE plate = $3 AND day BETWEEN $1::date AND $2::date
       GROUP BY 1 ORDER BY trips DESC`, p);
    res.json({ days, totals });
  }));

  /* ── movement: fixes, occupancy segments, unauthorised use ────────────── */
  /* ── where the money came from ──────────────────────────────────────────
     Its own endpoint, and its own page, because the answer has three layers a
     single figure cannot carry: which channel, which driver, and on what
     basis. The fares are measured; the attributed earnings are a share of a
     driver's payout inferred from custody. Showing them in one column would
     hide the difference, so they are returned as separate series and the page
     labels each. */
  app.get('/api/vehicle/earnings', withVehicle(async (req, res, plate, p) => {
    const [byPlatform, attributed, daily, fares] = await Promise.all([
      // Measured fares on this car's own trips, per channel.
      q(`SELECT platform,
                count(*) FILTER (WHERE is_booking)::int bookings,
                count(*) FILTER (WHERE has_fare)::int priced_bookings,
                round(sum(price) FILTER (WHERE has_fare)::numeric,2) fares,
                round(sum(distance_km) FILTER (WHERE has_distance AND is_booking)::numeric,0) km
         FROM trip_norm WHERE ${TW} AND is_booking
         GROUP BY 1 ORDER BY 2 DESC`, p),
      // Attributed driver pay, per channel and per person, with the basis kept
      // so the page can mark an even split as the weaker inference it is.
      q(`SELECT platform, driver_ext_id, max(driver_name) driver_name,
                round(sum(attributed)::numeric,2) attributed,
                round(sum(attributed_cash)::numeric,2) attributed_cash,
                sum(trips)::int trips, round(sum(km)::numeric,0) km,
                count(DISTINCT day)::int days,
                bool_or(basis = 'even') any_even_split,
                min(period_start) first_period, max(period_end) last_period
         FROM (${attributedEarnings({ extra: 'AND vd.plate = $3' })}) att
         GROUP BY 1,2 ORDER BY 4 DESC NULLS LAST`, p),
      // The daily spine, so the two series can be drawn against each other.
      /* `AS day`, not a bare `day`. Postgres reads a bare `day` after an
         expression as an interval qualifier — SELECT n day is the start of
         INTERVAL '1' DAY — so the alias has to be spelled out or the whole
         statement is a syntax error. Same family as the `hour` trap already
         documented in this codebase, and it cost a 500 on this route. */
      q(`WITH f AS (
           SELECT local_day AS day, round(sum(price) FILTER (WHERE has_fare)::numeric,2) AS fares,
                  count(*) FILTER (WHERE is_booking)::int AS bookings
           FROM trip_norm WHERE ${TW} AND is_booking GROUP BY 1),
         a AS (
           SELECT day, round(sum(attributed)::numeric,2) AS attributed
           FROM (${attributedEarnings({ extra: 'AND vd.plate = $3' })}) att GROUP BY 1)
         SELECT coalesce(f.day, a.day) AS day,
                coalesce(f.fares, 0) AS fares, coalesce(f.bookings, 0) AS bookings,
                coalesce(a.attributed, 0) AS attributed
         FROM f FULL OUTER JOIN a ON a.day = f.day
         ORDER BY 1`, p),
      /* What the fares actually cover. A revenue figure over ten of 266
         bookings is not wrong, but it is not the car's revenue either, and the
         page has to be able to say which. */
      q(`SELECT count(*) FILTER (WHERE is_booking)::int bookings,
                count(*) FILTER (WHERE has_fare)::int priced,
                count(DISTINCT platform) FILTER (WHERE is_booking)::int platforms,
                count(DISTINCT platform) FILTER (WHERE has_fare)::int priced_platforms
         FROM trip_norm WHERE ${TW}`, p),
    ]);
    const [cover] = fares;
    const attTotal = attributed.reduce((a, r) => a + Number(r.attributed || 0), 0);
    const fareTotal = byPlatform.reduce((a, r) => a + Number(r.fares || 0), 0);
    res.json({
      plate,
      by_platform: byPlatform,
      attributed,
      daily,
      totals: {
        fares: +fareTotal.toFixed(2),
        attributed: +attTotal.toFixed(2),
        // Deliberately NOT a sum of the two. See attribution_sql.js.
        bookings: cover?.bookings ?? 0,
        priced_bookings: cover?.priced ?? 0,
        fare_coverage_pct: cover?.bookings
          ? Math.round((cover.priced / cover.bookings) * 1000) / 10 : null,
        platforms: cover?.platforms ?? 0,
        priced_platforms: cover?.priced_platforms ?? 0,
      },
      /* The one sentence a reader needs before trusting either number. */
      caveat: cover?.bookings && cover.priced < cover.bookings
        ? `Fares are reported on ${cover.priced} of ${cover.bookings} bookings. `
          + `The rest are channels that price nothing per trip and pay the driver instead — `
          + `their share is the attributed column, inferred from who was holding this vehicle.`
        : null,
    });
  }));

  app.get('/api/vehicle/movement', withVehicle(async (req, res, plate, p) => {
    const segments = await q(
      /* verdict_reason and unavailable_sources are the two fields that make a
         verdict readable — /api/segments returns both and this per-vehicle
         table did not, so the same rows were strictly poorer here than on
         #segments. "Assessed blind" means nothing without naming which channel
         could not be checked. */
      `SELECT started_at, ended_at, duration_min, distance_km, top_speed, fixes,
              verdict, verdict_reason, unavailable_sources, matched_platform,
              low_confidence, max_gap_min, ignition_ratio,
              start_lat, start_lng, end_lat, end_lng
       FROM occupancy_segment WHERE plate = $3 AND started_at BETWEEN $1 AND $2
       ORDER BY started_at DESC LIMIT 200`, p);
    const byVerdict = await q(
      `SELECT coalesce(verdict,'unknown') verdict, count(*)::int n,
              round(sum(distance_km)::numeric,0) km, round(sum(duration_min)::numeric,0) AS minutes
       FROM occupancy_segment WHERE plate = $3 AND started_at BETWEEN $1 AND $2
       GROUP BY 1 ORDER BY n DESC`, p);
    /* Only fixes that can be drawn. The replay picker offered "Aug 25 · 119
       fixes" and /api/map/journey then returned 108 for the same day, because
       that endpoint requires lat IS NOT NULL and this count did not. A fix
       with no coordinate is a poll that came back without a satellite lock;
       counting it here promised a route it could not draw. */
    const days = await q(
      `SELECT (captured_at AT TIME ZONE 'Asia/Dubai')::date AS day, count(*)::int fixes
       FROM telemetry_snapshot
       WHERE plate = $3 AND captured_at BETWEEN $1 AND $2 AND lat IS NOT NULL
       GROUP BY 1 HAVING count(*) >= 3 ORDER BY 1 DESC LIMIT 90`, p);
    // Where it spends its stationary time — depot, driver's home, or a rank.
    const parked = await q(
      `SELECT round(lat::numeric,3) lat, round(lng::numeric,3) lng, count(*)::int fixes
       FROM telemetry_snapshot
       WHERE plate = $3 AND captured_at BETWEEN $1 AND $2 AND coalesce(speed,0) < 2 AND lat IS NOT NULL
       GROUP BY 1,2 HAVING count(*) >= 3 ORDER BY fixes DESC LIMIT 60`, p);
    res.json({ segments, by_verdict: byVerdict, days, parked });
  }));

  /* ── safety ───────────────────────────────────────────────────────────── */
  app.get('/api/vehicle/safety', withVehicle(async (req, res, plate, p) => {
    /* Marked for what each type IS, the same way /api/driver/quality marks it.
       ─────────────────────────────────────────────────────────────────────
       Main Power Lost is the tracker complaining about its own wiring, not
       something anybody did at the wheel, and this list is what the safety tab
       sums into "Harsh events" and reads its "Worst type" off. On L38439 and
       L39421 — 100% device fault — the worst type of harsh driving was the box
       failing. The word list is the server's and lives in
       api/alert_coverage_sql.js; the flag travels so no page carries a copy of
       it. */
    const byType = await q(
      `SELECT alert_type, count(*)::int n, max(occurred_at) latest,
              ${DEVICE_FAULT_SQL('alert_type')} AS device
       FROM alert WHERE plate = $3 AND occurred_at BETWEEN $1 AND $2
       GROUP BY 1 ORDER BY n DESC LIMIT 20`, p);
    // Attributed to whoever held the vehicle that day, so a harsh-driving
    // pattern points at a person rather than at an inanimate object.
    //
    // vehicle_driver_day holds one row per (plate, day, driver, PLATFORM), so a
    // driver working two apps on one day has two rows. Joining alerts straight
    // to it multiplies every event by that row count — the fleet's busiest car
    // reported its 584 events twice, once under each spelling of the same
    // driver's name, and the km column summed a day's distance once per alert.
    // Collapse custody to one row per day first, then count each day's alerts
    // once against it.
    /* The rate needs the driver's km on this plate over the WHOLE window, not
       over the days they happened to trigger an alert.
       ─────────────────────────────────────────────────────────────────────
       sum(c.km) ran over per_day, which only holds days with at least one
       alert, so the denominator was the distance driven on bad days. Aliyan
       khalil came back with km "459" here while /api/vehicle/drivers-detail
       reported 2,459 for the same person on the same plate — and 322 events
       over 459 km is 215.3 per 100 km, printed beside a vehicle rate of 34.
       Custody is aggregated separately over every day held, which is the same
       figure drivers-detail computes. */
    const byDriver = await q(
      `WITH custody AS (
         SELECT DISTINCT ON (day) day, driver_ext_id, driver_name, km
         FROM vehicle_driver_day
         WHERE plate = $3 AND day BETWEEN $1::date AND $2::date
         ORDER BY day, is_primary DESC, trips DESC NULLS LAST
       ),
       /* Split at source, so the person's count is what they DID.
          ─────────────────────────────────────────────────────────────────
          Main Power Lost is the tracker reporting its own power loss. Summed
          in here it made "most events" a ranking of whose car has the worst
          wiring: on the plates whose every alert is a device fault, this
          panel named a driver as the vehicle's worst offender for 87 events
          none of which anybody caused. The word list is the server's, in
          api/alert_coverage_sql.js, and both counts travel so the page can
          say which is which rather than choosing for the reader. */
       per_day AS (
         SELECT (occurred_at AT TIME ZONE 'Asia/Dubai')::date AS day,
                count(*) FILTER (WHERE NOT ${DEVICE_FAULT_SQL('alert_type')})::int n,
                count(*) FILTER (WHERE ${DEVICE_FAULT_SQL('alert_type')})::int device
         FROM alert WHERE plate = $3 AND occurred_at BETWEEN $1 AND $2 GROUP BY 1
       ),
       ev AS (
         SELECT coalesce(c.driver_name,'unattributed') driver_name,
                max(c.driver_ext_id) driver_ext_id, sum(pd.n)::int n,
                sum(pd.device)::int device
         FROM per_day pd LEFT JOIN custody c ON c.day = pd.day
         GROUP BY 1
       ),
       held AS (
         SELECT driver_name, round(sum(km)::numeric,0) booked_km,
                count(*)::int days_held
         FROM custody WHERE driver_name IS NOT NULL GROUP BY 1
       )
       /* by_type summed 1,436 and by_driver 1,381 on the same vehicle in
          production. The 55 missing events are not unattributed — they are the
          tail this LIMIT cut, and nothing said so. The two figures the panel
          needs ride down on the rows, the way /api/alerts/by-driver carries
          its own population: a second query here would replay the alert scan
          and the custody fold to arrive at two numbers. */
       SELECT ev.driver_name, ev.driver_ext_id, ev.n, ev.device AS device_alerts,
              held.booked_km AS km, held.booked_km, held.days_held,
              /* NULL, not 0, when the person's only events were the tracker's
                 own: a rate of 0.00 beside a count of 87 reads as a spotless
                 record on the worst-instrumented car in the fleet. */
              CASE WHEN ev.n = 0 AND ev.device > 0 THEN NULL
                   ELSE round((ev.n * 100.0 / nullif(held.booked_km, 0))::numeric, 2) END AS per_100km,
              CASE WHEN ev.n = 0 AND ev.device > 0
                   THEN 'not measured — every event while this person held the vehicle is the '
                        || 'tracker reporting its own power loss, so nothing here measures driving'
                   ELSE NULL END AS per_100km_absent,
              count(*) OVER ()::int AS _drivers,
              sum(ev.n) OVER ()::int AS _alerts,
              sum(ev.device) OVER ()::int AS _device
       FROM ev LEFT JOIN held ON held.driver_name = ev.driver_name
       ORDER BY ev.n DESC, ev.device DESC LIMIT 20`, p);
    const drvTot = byDriver.length
      ? { drivers: byDriver[0]._drivers, alerts: byDriver[0]._alerts,
          device_alerts: byDriver[0]._device }
      : { drivers: 0, alerts: 0, device_alerts: 0 };
    for (const r of byDriver) { delete r._drivers; delete r._alerts; delete r._device; }
    const daily = await q(
      `SELECT (occurred_at AT TIME ZONE 'Asia/Dubai')::date AS day, count(*)::int alerts
       FROM alert WHERE plate = $3 AND occurred_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, p);
    const recent = await q(
      `SELECT alert_type, occurred_at, location, lat, lng, video_url
       FROM alert WHERE plate = $3 AND occurred_at BETWEEN $1 AND $2
       ORDER BY occurred_at DESC LIMIT 100`, p);
    const [recentTot] = await q(
      `SELECT count(*)::int alerts FROM alert
       WHERE plate = $3 AND occurred_at BETWEEN $1 AND $2`, p);
    res.json({
      by_type: byType, by_driver: byDriver, daily, recent,
      /* Sibling counts rather than a {rows,...} wrapper: this response is
         already an object with four lists in it, and three of them are capped.
         A reader has to be able to tell "this driver had no more events" from
         "the list stopped at twenty". */
      by_driver_total: drvTot.drivers,
      by_driver_shown: byDriver.length,
      by_driver_truncated: drvTot.drivers > byDriver.length,
      by_driver_alerts: drvTot.alerts,
      recent_total: recentTot?.alerts ?? recent.length,
      recent_shown: recent.length,
      recent_truncated: (recentTot?.alerts ?? 0) > recent.length,
    });
  }));

  /* ── how the asset is used: product tier, payment, platform ───────────── */
  app.get('/api/vehicle/mix', withVehicle(async (req, res, plate, p) => {
    /* Same guard, same reason. This groups by platform among other things, so
       an unguarded avg_km put the odometer reading straight into the FMS row
       of a table sitting beside real per-trip distances. */
    const one = (col) => q(
      `SELECT coalesce(${col},'unknown') label, count(*)::int n,
              count(*) FILTER (WHERE is_booking)::int bookings,
              round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue,
              round(avg(distance_km) FILTER (WHERE has_distance)::numeric,1) avg_km,
              count(*) FILTER (WHERE has_distance)::int measured
       FROM trip_norm WHERE ${TW} GROUP BY 1 ORDER BY n DESC LIMIT 20`, p);
    const [product, payment, platform, status] = await Promise.all(
      [one('product'), one('payment_type'), one('platform'), one('status')]);
    const hours = await q(
      `SELECT extract(hour from requested_at AT TIME ZONE 'Asia/Dubai')::int h, count(*)::int trips
       FROM trip WHERE ${TW} GROUP BY 1 ORDER BY 1`, p);
    res.json({ product, payment, platform, status, hours });
  }));

  /* ── the raw trip record ──────────────────────────────────────────────── */
  /* Paged, and honest about it — see the twin in api/driver_routes.js. A bare
     capped array cannot tell a reader whether they are looking at all of the
     evidence or two fifths of it. */
  app.get('/api/vehicle/trips', withVehicle(async (req, res, plate, p) => {
    const limit = Math.min(+req.query.limit || 200, 1000);
    const offset = Math.max(0, +req.query.offset || 0);
    const [rows, [t]] = await Promise.all([
      q(`SELECT platform, external_id, requested_at, ended_at, driver_name, driver_ext_id,
                pickup_addr, dropoff_addr, distance_km, duration_s, status, product,
                payment_type, price, currency
         FROM trip WHERE ${TW}
         ORDER BY requested_at DESC LIMIT ${limit} OFFSET ${offset}`, p),
      q(`SELECT count(*)::int n FROM trip WHERE ${TW}`, p),
    ]);
    const total = t?.n ?? rows.length;
    res.json({ rows, total, shown: rows.length, offset, limit,
      truncated: offset + rows.length < total });
  }));
}
