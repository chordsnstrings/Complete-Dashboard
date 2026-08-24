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

import { peopleCount, personKey, peopleCountStored, JOIN_TRIP } from './custody_sql.js';
import { win, winDays } from './window.js';
import { attributedEarnings, unattributedEarnings } from './attribution_sql.js';
import { fleetIncome } from './income_sql.js';

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
    res.json(await q(
      `WITH plates AS (
         SELECT DISTINCT plate FROM (
           SELECT plate FROM trip WHERE plate IS NOT NULL AND plate <> ''
           UNION SELECT plate FROM telemetry_snapshot
           UNION SELECT plate FROM vehicle_document WHERE plate IS NOT NULL
         ) s
       ),
       t AS (
         /* Bookings and telematics journeys counted apart, and distance guarded.
            Summing them showed a 2-3.5x overcount as "trips" and rendered a
            193,027 km odometer row as 1.6 million km against one car. */
         /* Every column qualified: trip_norm is SELECT t.* over trip, so the
            join puts two of each base column in scope and an unqualified one is
            ambiguous. Postgres rejects the statement rather than choosing, which
            is the good outcome and how this was caught. */
         SELECT n.plate,
                count(*) FILTER (WHERE n.is_booking)::int trips,
                count(*) FILTER (WHERE NOT n.is_booking)::int telematics_journeys,
                count(DISTINCT n.local_day) FILTER (WHERE n.is_booking)::int days,
                count(DISTINCT n.local_day)::int days_moved,
                round(sum(n.distance_km) FILTER (WHERE n.is_booking AND n.has_distance)::numeric,0) km,
                round(sum(n.distance_km) FILTER (WHERE NOT n.is_booking AND n.has_distance)::numeric,0) telematics_km,
                round(sum(n.price) FILTER (WHERE n.has_fare)::numeric,0) revenue,
                count(*) FILTER (WHERE n.has_fare)::int priced_trips,
                /* The stored fold, via the base table. Computed per row this
                   was the directory's whole cost over a wide window: 76 seconds
                   across the full record. See peopleCountStored. */
                ${peopleCountStored()}::int drivers,
                count(DISTINCT n.platform)::int platforms,
                max(n.requested_at) FILTER (WHERE n.is_booking) last_trip,
                max(n.requested_at) last_movement,
                min(n.fleet_id) fleet_id
         FROM trip_norm n ${JOIN_TRIP}
         WHERE n.local_day BETWEEN $1::date AND $2::date AND n.plate IS NOT NULL AND n.plate <> ''
         GROUP BY n.plate
       ),
       tel AS (
         SELECT DISTINCT ON (plate) plate, captured_at last_fix, polled_at, status, speed
         FROM telemetry_snapshot ORDER BY plate, captured_at DESC
       ),
       doc AS (
         SELECT plate, min(expires_at) soonest_expiry, count(*)::int docs
         FROM vehicle_document WHERE expires_at IS NOT NULL GROUP BY plate
       ),
       al AS (
         SELECT plate, count(*)::int alerts FROM alert
         WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
         GROUP BY plate
       )
       SELECT p.plate,
              coalesce(t.trips,0) trips,
              coalesce(t.telematics_journeys,0) telematics_journeys,
              coalesce(t.days,0) days, coalesce(t.days_moved,0) days_moved,
              t.km, t.telematics_km, t.revenue, coalesce(t.priced_trips,0) priced_trips,
              coalesce(t.drivers,0) drivers, coalesce(t.platforms,0) platforms,
              t.last_trip, t.last_movement,
              coalesce(t.fleet_id, v.fleet_id, vp.fleet_id) fleet_id,
              coalesce(v.make, vp.make) make, coalesce(v.model, vp.model) model,
              coalesce(v.year, vp.year) AS year,
              tel.last_fix, tel.status, tel.speed,
              /* Staleness is a property of the FIX, not of our poll. CABMAN
                 re-sends every vehicle's last position on every cycle, so a
                 tracker dead for a year still got a fresh polled_at. */
              (now() - tel.last_fix > interval '11 minutes') stale,
              round(extract(epoch FROM now() - tel.last_fix) / 60)::int fix_age_min,
              doc.soonest_expiry, (doc.soonest_expiry::date - now()::date) doc_days_left,
              coalesce(al.alerts,0) alerts,
              -- The id as well as the name: the page names a person and could
              -- not link to them because the id was dropped here.
              cd.driver_name current_driver, cd.driver_ext_id current_driver_id, cd.as_of driver_as_of
       FROM plates p
       LEFT JOIN t   ON t.plate = p.plate
       LEFT JOIN tel ON tel.plate = p.plate
       LEFT JOIN doc ON doc.plate = p.plate
       LEFT JOIN al  ON al.plate = p.plate
       LEFT JOIN vehicle v ON v.plate = p.plate
       LEFT JOIN vehicle_profile vp ON vp.plate = p.plate
       LEFT JOIN vehicle_current_driver cd ON cd.plate = p.plate
       ORDER BY coalesce(t.trips,0) DESC, p.plate
       LIMIT 500`, [from, to]));
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
    const [span] = await q(
      `SELECT min(requested_at) first_trip, max(requested_at) last_trip, count(*)::int trips,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)::int days_worked,
              ${peopleCount()}::int drivers
       FROM trip WHERE ${TW}`, p);
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
       FROM trip_norm WHERE ${TW}`, p);
    const [u] = await q(
      `SELECT round(avg(utilisation)::numeric,3) utilisation,
              round(sum(hours_online)::numeric,1) hours_online,
              round(sum(hours_on_trip)::numeric,1) hours_on_trip,
              round(avg(earnings_per_hour)::numeric,2) earnings_per_hour,
              round(avg(trips_per_online_hour)::numeric,2) trips_per_online_hour
       FROM vehicle_utilisation
       WHERE plate = $3 AND period_start >= $1::date AND period_end <= $2::date`, p);
    const [a] = await q(
      `SELECT count(*)::int alerts FROM alert WHERE plate = $3 AND occurred_at BETWEEN $1 AND $2`, p);
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
       earned AS (
         SELECT DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day
         FROM trip WHERE ${TW})
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
      alerts_per_100km: t.km > 0 ? +((a.alerts / t.km) * 100).toFixed(1) : null,
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
      `SELECT started_at, ended_at, duration_min, distance_km, top_speed, fixes,
              verdict, matched_platform, low_confidence,
              start_lat, start_lng, end_lat, end_lng
       FROM occupancy_segment WHERE plate = $3 AND started_at BETWEEN $1 AND $2
       ORDER BY started_at DESC LIMIT 200`, p);
    const byVerdict = await q(
      `SELECT coalesce(verdict,'unknown') verdict, count(*)::int n,
              round(sum(distance_km)::numeric,0) km, round(sum(duration_min)::numeric,0) AS minutes
       FROM occupancy_segment WHERE plate = $3 AND started_at BETWEEN $1 AND $2
       GROUP BY 1 ORDER BY n DESC`, p);
    const days = await q(
      `SELECT (captured_at AT TIME ZONE 'Asia/Dubai')::date AS day, count(*)::int fixes
       FROM telemetry_snapshot WHERE plate = $3 AND captured_at BETWEEN $1 AND $2
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
    const byType = await q(
      `SELECT alert_type, count(*)::int n, max(occurred_at) latest
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
    const byDriver = await q(
      `WITH custody AS (
         SELECT DISTINCT ON (day) day, driver_ext_id, driver_name, km
         FROM vehicle_driver_day
         WHERE plate = $3 AND day BETWEEN $1::date AND $2::date
         ORDER BY day, is_primary DESC, trips DESC NULLS LAST
       ),
       per_day AS (
         SELECT (occurred_at AT TIME ZONE 'Asia/Dubai')::date AS day, count(*)::int n
         FROM alert WHERE plate = $3 AND occurred_at BETWEEN $1 AND $2 GROUP BY 1
       )
       SELECT coalesce(c.driver_name,'unattributed') driver_name,
              max(c.driver_ext_id) driver_ext_id,
              sum(pd.n)::int n, round(sum(c.km)::numeric,0) km
       FROM per_day pd LEFT JOIN custody c ON c.day = pd.day
       GROUP BY 1 ORDER BY n DESC LIMIT 20`, p);
    const daily = await q(
      `SELECT (occurred_at AT TIME ZONE 'Asia/Dubai')::date AS day, count(*)::int alerts
       FROM alert WHERE plate = $3 AND occurred_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, p);
    const recent = await q(
      `SELECT alert_type, occurred_at, location, lat, lng, video_url
       FROM alert WHERE plate = $3 AND occurred_at BETWEEN $1 AND $2
       ORDER BY occurred_at DESC LIMIT 100`, p);
    res.json({ by_type: byType, by_driver: byDriver, daily, recent });
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
  app.get('/api/vehicle/trips', withVehicle(async (req, res, plate, p) => res.json(await q(
    `SELECT platform, external_id, requested_at, ended_at, driver_name, driver_ext_id,
            pickup_addr, dropoff_addr, distance_km, duration_s, status, product,
            payment_type, price, currency
     FROM trip WHERE ${TW}
     ORDER BY requested_at DESC LIMIT ${Math.min(+req.query.limit || 200, 1000)}`, p))));
}
