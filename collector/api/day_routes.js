/* One day, from every source that saw it.
   ──────────────────────────────────────────────────────────────────────────
   Clicking a bar on the demand chart used to open a modal titled "Trips on
   14 August" that contained a driver leaderboard — not trips, and not the day
   in any sense a person would recognise. It also could not be linked to, which
   for the one artefact somebody actually wants to send a colleague ("look at
   what happened on the 14th") is the wrong shape entirely.

   A day is now an address, and it holds what a day actually consisted of:
   bookings and the telematics journeys behind them, the hours they fell in,
   who drove and what they drove, the safety events, the unexplained occupancy,
   the weather and the calendar — and, critically, WHETHER EVERY SOURCE WAS
   COLLECTING. A quiet Tuesday and a Tuesday nobody fetched produce the same
   chart, and only this page can tell them apart. */
import { custodyNames, custodyRefs } from './custody_sql.js';
import { fleetIncome } from './income_sql.js';

const round = (v, d = 1) => (v == null || !Number.isFinite(Number(v)) ? null
  : Math.round(Number(v) * 10 ** d) / 10 ** d);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))
  && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime());

export function dayRoutes(app, { q, wrap }) {
  app.get('/api/day', wrap(async (req, res) => {
    const day = req.query.day;
    if (!isDay(day)) return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    const p = [day];

    // Dubai-local bounds for the tables that are keyed on a timestamp rather
    // than on trip_ext's local_day.
    const T0 = `($1::date::timestamp AT TIME ZONE 'Asia/Dubai')`;
    const T1 = `(($1::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')`;
    const D = `local_day = $1::date`;
    // Both the alert and the segment tables are keyed on a timestamp, and this
    // page is one Dubai day — so custody is looked up on that day, not on the
    // UTC one the raw timestamp would cast to.
    const SEG_DAY = `$1::date`;

    const [
      headline, hours, platforms, drivers, vehicles, tiers, settlement,
      alerts, alertsByVehicle, segments, coverage, context, neighbours, corridors, totalsRow,
    ] = await Promise.all([
      q(`SELECT count(*) FILTER (WHERE is_booking)::int bookings,
                count(*) FILTER (WHERE NOT is_booking)::int telematics,
                count(*) FILTER (WHERE outcome = 'completed')::int completed,
                count(*) FILTER (WHERE outcome = 'not_completed')::int not_completed,
                count(*) FILTER (WHERE outcome IS NOT NULL)::int bookable,
                count(*) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary)::int priced,
                sum(price) FILTER (WHERE NOT is_complimentary) revenue,
                sum(distance_km) FILTER (WHERE has_distance AND is_booking) booked_km,
                sum(distance_km) FILTER (WHERE has_distance AND NOT is_booking) telematics_km,
                count(DISTINCT driver_name) FILTER (WHERE driver_name IS NOT NULL)::int drivers,
                count(DISTINCT plate) FILTER (WHERE nullif(btrim(plate), '') IS NOT NULL)::int vehicles,
                min(requested_at) first_at, max(requested_at) last_at
         FROM trip_ext WHERE ${D}`, p),
      q(`SELECT local_hour AS hour, count(*) FILTER (WHERE is_booking)::int bookings,
                count(*) FILTER (WHERE NOT is_booking)::int telematics,
                count(*) FILTER (WHERE outcome = 'not_completed')::int cancelled
         FROM trip_ext WHERE ${D} GROUP BY 1 ORDER BY 1`, p),
      q(`SELECT platform, count(*)::int n,
                count(*) FILTER (WHERE outcome = 'completed')::int completed,
                count(*) FILTER (WHERE outcome IS NOT NULL)::int bookable,
                sum(price) FILTER (WHERE NOT is_complimentary) revenue,
                round(sum(distance_km) FILTER (WHERE has_distance)::numeric, 0) km
         FROM trip_ext WHERE ${D} GROUP BY 1 ORDER BY n DESC`, p),
      q(`SELECT driver_name, max(driver_ext_id) driver_ext_id, count(*)::int trips,
                count(*) FILTER (WHERE outcome = 'not_completed')::int cancelled,
                sum(price) FILTER (WHERE NOT is_complimentary) revenue,
                round(sum(distance_km) FILTER (WHERE has_distance)::numeric, 0) km,
                array_agg(DISTINCT platform) platforms,
                array_remove(array_agg(DISTINCT plate), NULL) plates,
                min(requested_at) first_trip, max(requested_at) last_trip
         FROM trip_ext WHERE ${D} AND is_booking AND driver_name IS NOT NULL
         GROUP BY driver_name ORDER BY trips DESC LIMIT 120`, p),
      q(`SELECT t.plate, count(*) FILTER (WHERE t.is_booking)::int bookings,
                count(*) FILTER (WHERE NOT t.is_booking)::int telematics,
                round(sum(t.distance_km) FILTER (WHERE t.has_distance)::numeric, 0) km,
                count(DISTINCT t.driver_name)::int drivers,
                -- "This car did 1 journey and 0 bookings" is the row on this
                -- page most likely to start a conversation, and it named no
                -- one to have it with.
                ${custodyNames('t.plate', SEG_DAY)} AS driver_names,
                ${custodyRefs('t.plate', SEG_DAY)} AS driver_refs,
                sum(t.price) FILTER (WHERE NOT t.is_complimentary) revenue
         FROM trip_ext t WHERE ${D} AND t.plate IS NOT NULL
         GROUP BY t.plate ORDER BY bookings DESC, telematics DESC LIMIT 120`, p),
      q(`SELECT uber_tier AS tier, count(*)::int n FROM trip_ext
         WHERE ${D} AND uber_tier IS NOT NULL GROUP BY 1 ORDER BY n DESC`, p),
      q(`SELECT settlement_class, count(*)::int n,
                sum(price) FILTER (WHERE NOT is_complimentary) revenue
         FROM trip_ext WHERE ${D} AND settlement_class IS NOT NULL GROUP BY 1 ORDER BY n DESC`, p),
      /* Grouped by type for the shape of the day, and by (type, plate) for the
         part an operations person can act on. A harsh-braking count with no
         driver attached is a statistic; the same count against a named person
         who held that car is a conversation to have tomorrow morning. */
      q(`SELECT alert_type, count(*)::int n, count(DISTINCT plate)::int plates,
                array_remove(array_agg(DISTINCT plate), NULL) AS on_plates
         FROM alert a WHERE occurred_at >= ${T0} AND occurred_at < ${T1}
         GROUP BY 1 ORDER BY n DESC`, p),
      q(`SELECT plate, count(*)::int n,
                count(*) FILTER (WHERE alert_type ILIKE '%brake%')::int harsh_brake,
                count(*) FILTER (WHERE alert_type ILIKE '%accel%')::int harsh_accel,
                count(*) FILTER (WHERE alert_type ILIKE '%turn%')::int sharp_turn,
                count(*) FILTER (WHERE alert_type ILIKE '%speed%')::int overspeed,
                ${custodyNames('a.plate', SEG_DAY)} AS drivers,
                ${custodyRefs('a.plate', SEG_DAY)} AS driver_refs
         FROM alert a WHERE occurred_at >= ${T0} AND occurred_at < ${T1}
           AND plate IS NOT NULL
         GROUP BY 1 ORDER BY n DESC LIMIT 40`, p),
      q(`SELECT plate, started_at, ended_at, duration_min, distance_km, verdict,
                verdict_reason, nearest_platform, nearest_gap_min,
                ${custodyNames('o.plate', SEG_DAY)} AS drivers,
                ${custodyRefs('o.plate', SEG_DAY)} AS driver_refs
         FROM occupancy_segment o
         WHERE started_at >= ${T0} AND started_at < ${T1}
         ORDER BY CASE verdict WHEN 'unauthorized' THEN 0 WHEN 'unverifiable' THEN 1 ELSE 2 END,
                  started_at LIMIT 60`, p),
      // Did every source that normally reports actually report on this day?
      q(`WITH normal AS (
           SELECT source, percentile_cont(0.5) WITHIN GROUP (ORDER BY rows) AS median_rows,
                  min(day) AS first_day, max(day) AS last_day
           FROM source_day_coverage GROUP BY source
         )
         SELECT n.source, coalesce(c.rows, 0)::int rows, round(n.median_rows) AS median_rows,
                n.first_day, n.last_day,
                ($1::date BETWEEN n.first_day AND n.last_day) AS inside_span
         FROM normal n LEFT JOIN source_day_coverage c
           ON c.source = n.source AND c.day = $1::date
         ORDER BY n.source`, p),
      q(`SELECT w.temp_max, w.temp_min, w.precipitation, w.wind_max,
                c.hijri_date, c.hijri_month, c.is_ramadan, c.is_holiday, c.holiday_name,
                c.sunrise, c.sunset
         FROM (SELECT $1::date AS d) x
         LEFT JOIN weather_daily w ON w.day = x.d
         LEFT JOIN calendar_day  c ON c.day = x.d`, p),
      // The seven days around it, so the day has something to be read against.
      q(`SELECT local_day AS day, count(*) FILTER (WHERE is_booking)::int bookings
         FROM trip_ext WHERE local_day BETWEEN $1::date - 7 AND $1::date + 7
         GROUP BY 1 ORDER BY 1`, p),
      q(`SELECT coalesce(nullif(btrim(split_part(pickup_addr, ' - ', 2)), ''), '(unrecorded)') AS from_area,
                coalesce(nullif(btrim(split_part(dropoff_addr, ' - ', 2)), ''), '(unrecorded)') AS to_area,
                count(*)::int trips
         FROM trip_ext WHERE ${D} AND (pickup_addr IS NOT NULL OR dropoff_addr IS NOT NULL)
         GROUP BY 1, 2 ORDER BY trips DESC LIMIT 20`, p),
      /* The real sizes of the two capped lists above. Counted rather than
         inferred from the returned arrays, which are exactly the caps. */
      q(`SELECT (SELECT count(DISTINCT plate)::int FROM alert
                  WHERE occurred_at >= ${T0} AND occurred_at < ${T1} AND plate IS NOT NULL) AS alert_plates,
                (SELECT count(*)::int FROM occupancy_segment
                  WHERE started_at >= ${T0} AND started_at < ${T1}) AS segments`, p),
    ]);
    const totals = totalsRow[0] || {};

    const h = headline[0] || {};
    const near = neighbours.map((n) => ({ day: String(n.day).slice(0, 10), bookings: n.bookings }));
    const others = near.filter((n) => n.day !== day).map((n) => n.bookings).sort((a, b) => a - b);
    const median = others.length ? others[Math.floor(others.length / 2)] : null;

    /* A source that normally reports and reported nothing today is the single
       most important thing on this page: every rate below is computed over
       whatever did land, and if a source is missing they are all understated.
       Reported before the numbers, not as a footnote. */
    const silent = coverage.filter((c) => c.inside_span && c.rows === 0 && Number(c.median_rows) > 0);
    const thin = coverage.filter((c) => c.inside_span && c.rows > 0
      && Number(c.median_rows) > 0 && c.rows < Number(c.median_rows) * 0.3);

    /* What the day brought in, both channels. `revenue` here is the fares on
       that day's trips, and Uber prices nothing per trip — so a day the fleet
       ran nine hundred bookings showed the price of the few hotel ones.

       A payout is weekly, which is why no day page could show one before:
       driver_payout_day spreads each statement across the days it covers
       (sql/schema_v23.sql), so a single day now has a share of it. That share
       is an ESTIMATE — a driver does not earn a seventh of their week each day
       — and the page says so. It is the right estimate for "what did this day
       bring in" and it is exactly wrong for "what did this driver earn on
       Tuesday", which is why nothing here reports per-driver day pay. */
    const payByPlat = await q(
      `SELECT platform, round(sum(earnings)::numeric,2) payouts,
              count(DISTINCT day)::int payout_days
       FROM driver_payout_day WHERE day = $1::date GROUP BY 1`, p);
    /* And the operator's own import, which is the only money that exists for
       the months the platform APIs no longer serve.
       ─────────────────────────────────────────────────────────────────────
       driver_payout_day is built from the Uber earner breakdown, which reaches
       back about 192 days. Before that there is no payout row, so this page
       reported a day the fleet worked as having brought in nothing at all:
       /api/day?day=2025-09-01 answered accounted null and revenue null, while
       driver_statement_day held AED 31,510.86 for that date across 138 rows.

       Read into statement_net, which fleetIncome already defines and this
       route simply never filled. It rides BESIDE the chosen basis and is never
       added into `accounted` — adding a statement to a platform already
       counted on its fares or its payout would count the same trips twice,
       which is the rule income_sql.js states and this obeys rather than
       widens. So a day inside the payout horizon is unchanged, and a day
       outside it stops claiming the fleet earned nothing. */
    const stmtByPlat = await q(
      `SELECT platform, round(sum(net)::numeric,2) statement_net
       FROM driver_statement_day
       WHERE day = $1::date AND source = 'ledger' AND net IS NOT NULL
       GROUP BY 1`, p);
    const byPlat = new Map();
    const plat = (name) => {
      if (!byPlat.has(name)) {
        byPlat.set(name, { platform: name, bookings: 0, booking_days: 0, priced_bookings: 0,
          fares: null, payouts: null, payout_days: 0, statement_net: null });
      }
      return byPlat.get(name);
    };
    for (const r of platforms) Object.assign(plat(r.platform), {
      bookings: r.n, priced_bookings: r.revenue == null ? 0 : r.n,
      fares: r.revenue == null ? null : Number(r.revenue) });
    for (const y of payByPlat) Object.assign(plat(y.platform), {
      payouts: y.payouts == null ? null : Number(y.payouts),
      payout_days: y.payout_days ?? 0 });
    for (const y of stmtByPlat) Object.assign(plat(y.platform), {
      statement_net: y.statement_net == null ? null : Number(y.statement_net) });
    const income = fleetIncome([...byPlat.values()], 1);

    res.json({
      day,
      headline: {
        ...h,
        ...income,
        /* The estimate is labelled where it is produced, not where it is drawn:
           a caller reading this endpoint directly needs it as much as the page
           does. */
        payout_basis: income.accounted_payouts
          ? 'a share of each weekly platform statement, spread evenly across the days it covers'
          : null,
        revenue: h.priced ? round(h.revenue, 0) : null,
        avg_fare: h.priced ? round(Number(h.revenue) / h.priced, 2) : null,
        booked_km: round(h.booked_km, 0),
        telematics_km: round(h.telematics_km, 0),
        completion_pct: h.bookable ? round((h.completed / h.bookable) * 100, 1) : null,
      },
      // How this day sits against the fortnight around it.
      versus_neighbours: {
        median_bookings: median,
        delta_pct: median ? round(((h.bookings - median) / median) * 100, 1) : null,
        series: near,
      },
      hours,
      platforms: platforms.map((r) => ({ ...r, revenue: round(r.revenue, 0),
        completion_pct: r.bookable ? round((r.completed / r.bookable) * 100, 1) : null })),
      drivers: drivers.map((r) => ({ ...r, revenue: round(r.revenue, 0) })),
      vehicles: vehicles.map((r) => ({ ...r, revenue: round(r.revenue, 0) })),
      tiers,
      settlement: settlement.map((r) => ({ ...r, revenue: round(r.revenue, 0) })),
      alerts,
      alertsByVehicle,
      segments,
      /* How many there ACTUALLY are, beside the capped lists above.
         ─────────────────────────────────────────────────────────────────
         The vehicle-alert table stops at 40 rows and the occupancy table at
         60, and neither said so: a day with 140 flagged vehicles rendered
         exactly the same page as a day with 40. A cap the reader cannot see
         is a wrong total, because they will read the last row as the last
         one there is. */
      capped: {
        alerts_by_vehicle: Number(totals?.alert_plates ?? alertsByVehicle.length),
        segments: Number(totals?.segments ?? segments.length),
      },
      corridors: corridors.filter((c) => c.from_area !== '(unrecorded)' || c.to_area !== '(unrecorded)'),
      coverage,
      collection: {
        silent: silent.map((c) => ({ source: c.source, normally: Number(c.median_rows) })),
        thin: thin.map((c) => ({ source: c.source, rows: c.rows, normally: Number(c.median_rows) })),
        // The sentence a reader needs before they believe any number above it.
        warning: silent.length
          ? `${silent.map((c) => c.source).join(', ')} collected nothing on this day and normally `
            + `report around ${silent.map((c) => Math.round(Number(c.median_rows))).join('/')} rows. `
            + 'Every figure on this page is over what did land, so all of them are understated.'
          : thin.length
            ? `${thin.map((c) => c.source).join(', ')} reported far less than usual on this day, so the `
              + 'figures here may be incomplete rather than low.'
            : null,
      },
      context: context[0] || null,
    });
  }));
}
