// Insight engine — turns the collected data into ranked, actionable findings.
// Every insight answers three questions: what is true, what it costs, what to do.
// Rules are deliberately conservative: we would rather miss a weak signal than
// hand an operator a confident-sounding number we can't defend.
import { pool } from './db.js';
import { log } from './log.js';

const SRC = 'insights';
const q = (t, p) => pool.query(t, p).then((r) => r.rows);
const money = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);

/* node-postgres returns DATE and TIMESTAMP columns as JS Date objects, and a
   Date interpolated into a template literal renders as
   "Fri Aug 01 2025 00:00:00 GMT+0000 (Coordinated Universal Time)". That string
   was being STORED as the user-facing title and detail of an insight. Every
   date that reaches a sentence goes through one of these. */
const day = (v) => (v == null ? null : new Date(v).toISOString().slice(0, 10));
const minute = (v) => (v == null ? null : new Date(v).toISOString().slice(0, 16).replace('T', ' '));
const month = (v) => (v == null ? null : new Date(v).toLocaleDateString('en-GB',
  { month: 'long', year: 'numeric', timeZone: 'UTC' }));
const daysAgoFrom = (v) => (v == null ? null : Math.floor((Date.now() - new Date(v).getTime()) / 864e5));

/* Findings are sentences a person reads, and they were writing "expires in 1
   days", "1 drivers were online but completed no trips" and "1 driver(s)
   logged in". */
const s_ = (n, one, many = `${one}s`) => (Math.abs(Number(n)) === 1 ? one : many);

/* Channel names as the dashboard writes them. A finding is a sentence, and it
   was reading "11% of uber jobs cancel". */
const CHANNEL = { uber: 'Uber', yango: 'Yango', bolt: 'Bolt', hotel: 'Hotel', fms: 'FMS telematics' };
const LABEL = (v) => CHANNEL[String(v || '').toLowerCase()] || String(v || '');
const n_ = (n, one, many) => `${n} ${s_(n, one, many)}`;

// Assumed daily holding cost per vehicle (depreciation + insurance + permit + finance).
// Used only to size the "idle capital" impact; tune in settings later.
const VEHICLE_DAY_COST_AED = Number(process.env.VEHICLE_DAY_COST_AED || 120);

/* THE ARBITER HAS TO BE THE INDEX THAT ACTUALLY CATCHES THE ROW.
   ─────────────────────────────────────────────────────────────────────────
   This was upsert('insight', row, [code, entity_type, entity_id, window_start,
   window_end]) — the five-column key — and sql/schema_v15.sql adds two PARTIAL
   unique indexes on (code, entity_type, entity_id) beside it: one for rows
   with no window at all, one for fleet-level verdicts. Postgres arbitrates
   ON CONFLICT against the index you name; a collision on any OTHER unique
   index is an error, not an update.

   And the five-column key can never catch a windowless row anyway: NULLs are
   distinct in a unique index, so every re-run INSERTED, and the partial index
   then rejected it.

   The result, read out of the production collector log on 2026-09-01:

     ERROR [insights] idle_vehicle      duplicate key … "insight_nullwindow_uniq"
     ERROR [insights] vehicle_dormant   duplicate key … "insight_nullwindow_uniq"
     ERROR [insights] licence           duplicate key … "insight_nullwindow_uniq"
     ERROR [insights] volume_trend      duplicate key … "insight_nullwindow_uniq"
     ERROR [insights] stale_tracker     duplicate key … "insight_nullwindow_uniq"
     ERROR [insights] vehicle_documents duplicate key … "insight_nullwindow_uniq"
     ERROR [insights] platform_flags    duplicate key … "insight_fleet_verdict_uniq"

   Seven of the fourteen rules, failing on every run, caught by a per-job
   try/catch that logged and carried on — so the action list simply stopped
   changing for them. That is the whole reason 163 of its 200 findings were
   frozen days in the past under titles written in relative time.

   A row that satisfies BOTH partial indexes is arbitrated on either: they
   share their key columns, so the row they collide with is the same row. */
async function put(row) {
  const r = { ...row, computed_at: new Date().toISOString() };
  const noWindow = r.window_start == null && r.window_end == null;
  const arbiter = r.entity_type === 'fleet'
    ? '(code, entity_type, entity_id) WHERE entity_type = \'fleet\''
    : noWindow
      ? '(code, entity_type, entity_id) WHERE window_start IS NULL AND window_end IS NULL'
      : '(code, entity_type, entity_id, window_start, window_end)';
  const KEY = new Set(['code', 'entity_type', 'entity_id', 'window_start', 'window_end']);
  const cols = Object.keys(r);
  const set = cols.filter((c) => !KEY.has(c)).map((c) => `${c}=EXCLUDED.${c}`);
  await pool.query(
    `INSERT INTO insight (${cols.join(',')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})
     ON CONFLICT ${arbiter} ${set.length ? `DO UPDATE SET ${set.join(', ')}` : 'DO NOTHING'}`,
    cols.map((c) => r[c]));
}

/* ─────────────────── 1. Idle vehicles: capital earning nothing ───────────────────
   Only counts a vehicle as "idle" when its tracker is genuinely reporting now.
   A vehicle dark for weeks is a different problem (see dormantVehicles) and saying
   "the tracker is alive" about a two-year-old fix would be plainly untrue. Uses a
   fixed 14-day earning lookback rather than the collection window, so a 3-day
   incremental run cannot label a car idle after one quiet weekend. */
const IDLE_LOOKBACK_DAYS = 14;

async function idleVehicles() {
  const rows = await q(
    `WITH seen AS (
       SELECT plate, fleet_id, max(captured_at) last_seen
       FROM telemetry_snapshot WHERE plate IS NOT NULL GROUP BY plate, fleet_id),
     earned AS (
       SELECT plate, count(*)::int trips
       FROM trip_norm WHERE requested_at > now() - ($1 || ' days')::interval
         AND is_booking AND plate IS NOT NULL
       GROUP BY plate),
     /* The last trip EVER, unbounded. Reading it out of the 14-day CTE meant a
        NULL там stood for "no trip in the lookback" and the template turned it
        into the absolute claim "No trip has ever been recorded for this plate".
        Live, all 200 rows on the Action list carried that sentence and it was
        false for every one of them — the plate at the top had 81 trips, and one
        of the 23 had 1,039. */
     ever AS (
       SELECT plate, max(requested_at) last_trip, count(*) FILTER (WHERE platform <> 'fms')::int lifetime
       FROM trip WHERE plate IS NOT NULL GROUP BY plate)
     SELECT s.plate, s.fleet_id, s.last_seen, coalesce(e.trips,0) trips,
            ev.last_trip, coalesce(ev.lifetime, 0) AS lifetime
     FROM seen s
     LEFT JOIN earned e USING (plate)
     LEFT JOIN ever ev USING (plate)
     WHERE coalesce(e.trips,0) = 0
       AND s.last_seen > now() - interval '48 hours'     -- tracker genuinely reporting
     ORDER BY s.last_seen DESC`, [String(IDLE_LOOKBACK_DAYS)]);
  for (const r of rows) {
    const lastTrip = r.last_trip
      ? `Its last recorded trip was ${day(r.last_trip)}, ${n_(daysAgoFrom(r.last_trip), 'day')} ago`
        + ` (${r.lifetime} recorded in total).`
      : `No trip has ever been recorded for this plate in the collected data.`;
    await put({
      code: 'idle_vehicle', severity: 'critical', category: 'utilisation',
      entity_type: 'vehicle', entity_id: r.plate, fleet_id: r.fleet_id,
      title: `${r.plate} is reporting but has not earned in ${IDLE_LOOKBACK_DAYS} days`,
      detail: `The tracker reported as recently as ${minute(r.last_seen)}, so the vehicle is present and `
        + `powered — but no booking on any platform in the last ${IDLE_LOOKBACK_DAYS} days. ${lastTrip}`,
      action: `Confirm it is not in workshop or reserve. If roadworthy, assign a driver — otherwise take it off the active cost base.`,
      impact_aed: money(IDLE_LOOKBACK_DAYS * VEHICLE_DAY_COST_AED), metric: 0,
      window_start: null, window_end: null,
    });
  }
  return rows.length;
}

/* ─────────────────── 1b. Dormant vehicles: is this still our car? ─────────────────── */
async function dormantVehicles() {
  const rows = await q(
    `SELECT plate, fleet_id, max(captured_at) last_seen
     FROM telemetry_snapshot WHERE plate IS NOT NULL
     GROUP BY plate, fleet_id
     HAVING max(captured_at) < now() - interval '30 days'
     ORDER BY 3 DESC`);
  for (const r of rows) {
    const days = Math.round((Date.now() - new Date(r.last_seen)) / 864e5);
    await put({
      code: 'vehicle_dormant', severity: 'warning', category: 'data',
      entity_type: 'vehicle', entity_id: r.plate, fleet_id: r.fleet_id,
      title: `${r.plate} has sent no signal for ${n_(days, 'day')}`,
      detail: `Last position ${day(r.last_seen)}. A gap this long usually means the vehicle left the fleet, or the tracker was removed — but it is still carried in the vehicle list, so it quietly inflates every per-vehicle average.`,
      action: `Reconcile against the asset register: retire it, or refit the tracker if the car is still ours.`,
      impact_aed: null, metric: days, window_start: null, window_end: null,
    });
  }
  return rows.length;
}

/* ─────────────────── 2. Low utilisation: online but not earning ─────────────────── */
async function lowUtilisation(from, to) {
  const rows = await q(
    `SELECT plate, vehicle_ext_id, platform, fleet_id, utilisation, hours_online, hours_on_trip,
            earnings, earnings_per_hour, trips
     FROM vehicle_utilisation
     WHERE period_start >= $1 AND period_end <= $2 AND utilisation IS NOT NULL AND hours_online > 5
     ORDER BY utilisation ASC LIMIT 40`, [from, to]);
  if (!rows.length) return 0;
  const med = rows.map((r) => r.utilisation).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  let n = 0;
  for (const r of rows) {
    if (r.utilisation >= 0.20) continue;             // only flag the genuinely poor tail
    const wasted = (r.hours_online || 0) - (r.hours_on_trip || 0);
    const eph = Number(r.earnings_per_hour || 0);
    await put({
      code: 'low_utilisation', severity: 'warning', category: 'utilisation',
      entity_type: 'vehicle', entity_id: r.plate || r.vehicle_ext_id, fleet_id: r.fleet_id,
      title: `${r.plate || r.vehicle_ext_id} earns during only ${Math.round(r.utilisation * 100)}% of its online hours`,
      detail: `Online ${(r.hours_online || 0).toFixed(1)}h but on-trip just ${(r.hours_on_trip || 0).toFixed(1)}h — ${wasted.toFixed(1)}h logged in without a fare. Fleet median is ${Math.round(med * 100)}%.`,
      action: `Check where it waits between jobs. Repositioning to a higher-demand zone is usually worth more than adding online hours.`,
      impact_aed: money(wasted * eph), metric: r.utilisation,
      window_start: from, window_end: to,
    });
    n++;
  }
  return n;
}

/* ─────────────────── 3. Licence expiry: a driver who legally cannot drive ─────────────────── */
async function licenceRisk() {
  // Guard against placeholder data. One operator's records carry an identical
  // "1/1/26" on every driver alongside licence numbers like "123456" — a system
  // default, not nine genuine expiries. Reporting those as compliance breaches
  // would send someone chasing drivers who are probably fine, and would burn the
  // credibility of every real expiry on this page. If one date dominates the
  // population, we raise a data-quality flag instead.
  const [spread] = await q(
    `SELECT count(*)::int total,
            mode() WITHIN GROUP (ORDER BY licence_expires) AS common_date,
            count(*) FILTER (WHERE licence_expires =
              (SELECT mode() WITHIN GROUP (ORDER BY licence_expires) FROM driver_compliance
               WHERE licence_expires IS NOT NULL))::int AS common_n
     FROM driver_compliance WHERE licence_expires IS NOT NULL`);
  const placeholderish = spread && spread.total >= 4 && spread.common_n / spread.total >= 0.5;
  if (placeholderish) {
    await put({
      code: 'licence_data_unreliable', severity: 'warning', category: 'data',
      entity_type: 'fleet', entity_id: 'all',
      title: `Licence expiry dates look like a default, not real records`,
      detail: `${spread.common_n} of ${n_(spread.total, 'driver')} carry the identical expiry `
        + `${spread.common_date}. That pattern is a system default rather than `
        + `${n_(spread.common_n, 'genuine expiry', 'genuine expiries')}, so we are not raising `
        + 'individual compliance alerts against it.',
      action: `Get real licence dates into the source system — until then this fleet has no working licence-expiry check at all, which is the actual risk.`,
      impact_aed: null, metric: spread.common_n / spread.total,
      window_start: null, window_end: null,
    });
    return 1;
  }

  const rows = await q(
    `SELECT platform, driver_ext_id, full_name, phone, licence_no, licence_expires, fleet_id
     FROM driver_compliance
     WHERE licence_expires IS NOT NULL AND licence_expires < (now() + interval '45 days')
     ORDER BY licence_expires ASC LIMIT 100`);
  for (const r of rows) {
    const exp = new Date(r.licence_expires);
    const gone = exp < new Date();
    await put({
      code: gone ? 'licence_expired' : 'licence_expiring',
      severity: gone ? 'critical' : 'warning', category: 'compliance',
      entity_type: 'driver', entity_id: r.driver_ext_id, fleet_id: r.fleet_id,
      title: `${r.full_name || r.driver_ext_id}'s licence ${gone ? 'has expired' : 'expires soon'} (${day(r.licence_expires)})`,
      detail: `Licence ${r.licence_no || '—'} on ${r.platform}. ${gone
        ? 'Every trip driven on an expired licence is uninsured exposure for the company, not just the driver.'
        : 'Renewal windows in the UAE take days, not hours.'}`,
      action: gone ? `Stand the driver down until renewal is evidenced.` : `Chase the renewal now and diarise a re-check.`,
      impact_aed: null, metric: Math.round((exp - new Date()) / 864e5),
      window_start: null, window_end: null,
    });
  }
  return rows.length;
}

/* ─────────────────── 4. Unsafe driving: harsh events per 100km ─────────────────── */
async function unsafeDriving(from, to) {
  const rows = await q(
    `WITH ev AS (
       SELECT plate, count(*)::int events,
              sum((alert_type ILIKE '%speed%')::int)::int overspeed,
              sum((alert_type ILIKE '%brake%')::int)::int harsh_brake
       FROM alert WHERE occurred_at BETWEEN $1 AND $2 AND plate IS NOT NULL GROUP BY plate),
     /* The denominator is TELEMATICS distance, one population, guarded.
        It used to sum the raw trip table, which put a plate's bookings AND its FMS
        twins in the same figure — roughly doubling the distance and therefore
        halving the event rate — and included the odometer-derived rows the
        schema warns about, one of which carries 193,027 km. The alert table
        covers all movement, so telematics distance is the right denominator. */
     km AS (
       SELECT plate, sum(distance_km) km FROM trip_norm
       WHERE requested_at BETWEEN $1 AND $2 AND plate IS NOT NULL
         AND NOT is_booking AND has_distance
       GROUP BY plate),
     rate AS (
       SELECT ev.plate, ev.events, ev.overspeed, ev.harsh_brake, km.km,
              (ev.events::float / nullif(km.km,0) * 100) per100
       FROM ev JOIN km USING (plate) WHERE km.km > 50),
     /* The median over the WHOLE eligible population. It used to be computed in
        JS from the same worst-25 rows the query had already selected, so the
        published multiple was against the median of the worst — far above the
        fleet's — and the threshold that decides who gets flagged was anchored
        to it. */
     med AS (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY per100) AS m FROM rate)
     SELECT rate.*, med.m AS fleet_median, (SELECT count(*)::int FROM rate) AS population
     FROM rate, med ORDER BY per100 DESC NULLS LAST LIMIT 25`, [from, to]);
  if (!rows.length) return 0;
  const med = Number(rows[0].fleet_median) || 0;
  let n = 0;
  for (const r of rows) {
    if (!r.per100 || r.per100 < med * 2) continue;   // only the clear outliers
    await put({
      code: 'unsafe_driving', severity: 'warning', category: 'safety',
      entity_type: 'vehicle', entity_id: r.plate,
      /* "the fleet median" is not one number.
         ─────────────────────────────────────────────────────────────────────
         This rule runs on whatever window the collection pass used, and the
         table keeps every run: one computed_at in production carried
         window_start/window_end spans of 3, 30 and 365 days, so SEVEN
         different values — 106.9, 29.5, 8.8, 196.2 among them — were all
         called "the fleet median", over four different denominators (45
         vehicles, 42, 54, 69). L72481 read 6.5x and L26356 3.8x although
         L26356 has seven times the raw rate: two multiples against two
         different medians, printed in one list as though they ranked.

         Naming the window makes each row true on its own terms, and
         /api/insights can now filter to one window so a list is comparable. */
      title: `${r.plate}: ${r.per100.toFixed(1)} harsh events per 100km — `
        + `${(r.per100 / (med || 1)).toFixed(1)}x the median of ${med.toFixed(1)} `
        + `over ${from} → ${to}`,
      detail: `${r.events} events over ${Math.round(r.km)}km of tracked movement `
        + `(${r.overspeed} overspeed, ${r.harsh_brake} harsh braking, `
        + `${Math.max(0, r.events - r.overspeed - r.harsh_brake)} other). `
        + `The median across all ${n_(r.population, 'vehicle')} with enough distance to judge over `
        + `${from} → ${to} is ${med.toFixed(1)} per 100km. Sustained harsh driving predicts `
        + `both collisions and tyre and brake spend.`,
      action: `Pull the dashcam clips for the worst events and run a coaching conversation with whoever drove this plate.`,
      impact_aed: null, metric: r.per100, window_start: from, window_end: to,
    });
    n++;
  }
  return n;
}

/* ─────────────────── 5. Deadhead: unpaid kilometres to reach the fare ─────────────────── */
async function deadhead(from, to) {
  const rows = await q(
    `SELECT plate, count(*)::int trips, sum(deadhead_km) dead, sum(distance_km) paid,
            (sum(deadhead_km)/nullif(sum(distance_km),0)) ratio, fleet_id
     FROM trip WHERE requested_at BETWEEN $1 AND $2 AND deadhead_km IS NOT NULL AND plate IS NOT NULL
     GROUP BY plate, fleet_id HAVING sum(distance_km) > 30
     ORDER BY ratio DESC NULLS LAST LIMIT 20`, [from, to]);
  let n = 0;
  for (const r of rows) {
    if (!r.ratio || r.ratio < 0.3) continue;
    await put({
      code: 'deadhead_waste', severity: 'warning', category: 'cost',
      entity_type: 'vehicle', entity_id: r.plate, fleet_id: r.fleet_id,
      title: `${r.plate} drives ${Math.round(r.ratio * 100)}km empty for every 100km paid`,
      detail: `${Math.round(r.dead)}km unpaid approach against ${Math.round(r.paid)}km of fare `
        + `distance across ${n_(r.trips, 'trip')}. Empty kilometres burn energy, tyres and `
        + 'driver hours with no revenue.',
      action: `Look at where this car waits. Staging it closer to its usual pickups cuts the approach leg directly.`,
      impact_aed: null, metric: r.ratio, window_start: from, window_end: to,
    });
    n++;
  }
  return n;
}

/* ─────────────────── 6. Demand trend: is the business shrinking? ───────────────────
   Three things were wrong here at once and they compounded into two
   contradictory fleet-wide verdicts sitting live on the same page — "down 32%"
   tagged critical beside "up 18%" tagged good:

     - months were grouped in UTC, so every 00:00-04:00 Dubai trip landed in the
       previous day and the month-boundary trips in the wrong month;
     - months with no COLLECTED rows are simply absent from a GROUP BY, so the
       first and last observed months stepped straight across the Uber 299-day
       hole and the FMS 155-day hole. The comparison was between two months on
       either side of a period nobody fetched;
     - the verdict was keyed on the first and last observed month, which move
       whenever the observed set changes, so a new verdict inserted a new row
       instead of replacing the old one.

   Now: Dubai-local months, a filled calendar, an explicit refusal to compare
   across a month that was not collected, and a key that lets the verdict
   replace itself. */
async function volumeTrend() {
  const rows = await q(
    `WITH cal AS (
       SELECT generate_series(date_trunc('month', now() - interval '17 months'),
                              date_trunc('month', now()), interval '1 month')::date AS m
     ),
     agg AS (
       SELECT local_month AS m, count(*) FILTER (WHERE is_booking)::int trips,
              count(DISTINCT driver_ext_id) FILTER (WHERE driver_ext_id IS NOT NULL)::int drivers,
              count(DISTINCT plate) FILTER (WHERE nullif(btrim(plate), '') IS NOT NULL)::int vehicles
       FROM trip_norm WHERE requested_at > now() - interval '18 months' GROUP BY 1
     ),
     -- Days in each month on which ANY source collected anything.
     cov AS (
       SELECT date_trunc('month', day)::date AS m, count(DISTINCT day)::int collected_days
       FROM source_day_coverage GROUP BY 1
     )
     SELECT to_char(cal.m, 'YYYY-MM-DD') AS m,
            coalesce(agg.trips, 0) AS trips,
            coalesce(agg.drivers, 0) AS drivers,
            coalesce(agg.vehicles, 0) AS vehicles,
            coalesce(cov.collected_days, 0) AS collected_days,
            extract(days FROM (cal.m + interval '1 month' - interval '1 day'))::int AS days_in_month
     FROM cal LEFT JOIN agg ON agg.m = cal.m LEFT JOIN cov ON cov.m = cal.m
     ORDER BY cal.m`);
  if (rows.length < 3) return 0;

  // Drop the partial current month, then keep only months that were collected
  // for at least four fifths of their days. A month collected for six days is
  // not a low month, it is an unobserved one.
  const closed = rows.slice(0, -1);
  const usable = closed.filter((r) => r.collected_days >= r.days_in_month * 0.8);
  if (usable.length < 2) {
    log.info(SRC, 'volume trend skipped — not enough fully collected months',
      { closed: closed.length, usable: usable.length });
    return 0;
  }
  const first = usable[0], last = usable[usable.length - 1];
  // A hole anywhere between the two endpoints makes the comparison meaningless
  // even when both endpoints are complete.
  const between = closed.filter((r) => r.m > first.m && r.m < last.m);
  const holes = between.filter((r) => r.collected_days < r.days_in_month * 0.8);
  if (holes.length) {
    log.info(SRC, 'volume trend skipped — a collection hole sits between the endpoints',
      { from: first.m, to: last.m, holes: holes.map((h) => h.m) });
    return 0;
  }
  const change = (last.trips - first.trips) / (first.trips || 1);
  if (Math.abs(change) < 0.15) return 0;
  const down = change < 0;
  // A driver count of zero means the platform did not attribute the trips, not
  // that nobody drove them; saying "0 drivers" is a claim about the fleet.
  const who = (r) => (r.drivers ? n_(r.drivers, 'driver') : 'an unrecorded number of drivers');
  await put({
    code: 'volume_trend', severity: down ? 'critical' : 'good', category: 'demand',
    entity_type: 'fleet', entity_id: 'all',
    title: `Trip volume ${down ? 'down' : 'up'} ${Math.abs(Math.round(change * 100))}% `
      + `from ${month(first.m)} to ${month(last.m)}`,
    detail: `${month(first.m)}: ${n_(first.trips, 'booking')} with ${who(first)} on `
      + `${n_(first.vehicles, 'vehicle')} `
      + `-> ${month(last.m)}: ${n_(last.trips, 'booking')} with ${who(last)} on `
      + `${n_(last.vehicles, 'vehicle')}. `
      + `Both months were collected on at least ${Math.round(0.8 * 100)}% of their days, and every month `
      + `between them was too — a comparison across a collection hole is not a trend.`,
    action: down
      ? `Separate the two causes before reacting: fewer drivers supplying, or less demand per driver. `
        + `The fix is different for each.`
      : `Check the supply side can hold this — utilisation and driver hours are the constraint.`,
    impact_aed: null, metric: change,
    // NULL window, so the partial unique index in schema_v15 lets this verdict
    // REPLACE the previous one instead of accumulating beside it.
    window_start: null, window_end: null,
  });
  return 1;
}

/* ─────────────────── 7. Stale trackers: recently went dark ───────────────────
   Scoped to 24h–30d. Beyond 30 days it is reported once as `vehicle_dormant`
   (an asset-register question), so the same plate is never flagged twice. */
async function staleTelemetry() {
  const rows = await q(
    `SELECT DISTINCT ON (plate) plate, fleet_id, source, captured_at
     FROM telemetry_snapshot ORDER BY plate, polled_at DESC`);
  let n = 0;
  for (const r of rows) {
    const ageH = (Date.now() - new Date(r.captured_at)) / 36e5;
    if (ageH < 24 || ageH > 24 * 30) continue;            // dormant handled separately
    await put({
      code: 'stale_tracker', severity: ageH > 72 ? 'critical' : 'warning', category: 'data',
      entity_type: 'vehicle', entity_id: r.plate, fleet_id: r.fleet_id,
      title: `${r.plate} has not reported a position for ${Math.round(ageH)}h`,
      detail: `Last fix from ${r.source} at ${minute(r.captured_at)}. Either the vehicle is off the road or the tracker has failed — and while it is dark, nothing about this car can be verified.`,
      action: `Check the device. A dead tracker also disables unauthorised-use detection for this vehicle.`,
      impact_aed: null, metric: ageH, window_start: null, window_end: null,
    });
    n++;
  }
  return n;
}

/* ─────────────────── 8. Cancellations: fares lost at the door ─────────────────── */
async function cancellations(from, to) {
  const rows = await q(
    /* Both sides of this ratio were wrong on Bolt, which is the platform the
       finding fires on most: ILIKE cancel matches none of client_did_not_show,
       driver_did_not_respond or driver_rejected, and the denominator counted
       FMS telematics rows that hardcode 'completed' and cannot be cancelled at
       all. The normalised outcome is NULL for both telematics and for a status
       no platform explains, so a row only enters this ratio if its platform
       actually reported how the trip ended. */
    `SELECT platform, fleet_id,
            count(*) FILTER (WHERE outcome IS NOT NULL)::int total,
            count(*) FILTER (WHERE outcome='not_completed')::int cancels,
            (count(*) FILTER (WHERE outcome='not_completed')::float
             /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0)) rate,
            avg(price) FILTER (WHERE has_fare) avg_price
     FROM trip_norm WHERE requested_at BETWEEN $1 AND $2
     GROUP BY platform, fleet_id
     HAVING count(*) FILTER (WHERE outcome IS NOT NULL) > 50`, [from, to]);
  let n = 0;
  for (const r of rows) {
    if (!r.rate || r.rate < 0.10) continue;
    await put({
      code: 'cancellation_rate', severity: r.rate > 0.15 ? 'critical' : 'warning', category: 'revenue',
      entity_type: 'platform', entity_id: r.platform, fleet_id: r.fleet_id,
      title: `${Math.round(r.rate * 100)}% of ${LABEL(r.platform)} jobs cancel (${r.cancels} of ${r.total})`,
      detail: `Each cancellation still costs the approach drive and the driver's time. At an average fare of AED ${Number(r.avg_price || 0).toFixed(0)}, this is real money leaving before the meter starts.`,
      action: `Split rider- vs driver-initiated cancels. Driver-side is a coaching problem; rider-side is usually ETA or vehicle-match.`,
      impact_aed: money((r.cancels || 0) * Number(r.avg_price || 0) * 0.3),
      metric: r.rate, window_start: from, window_end: to,
    });
    n++;
  }
  return n;
}

/* ─────────────────── 9. Weather ahead: staffing and risk signal ─────────────────── */
async function weatherOutlook() {
  const rows = await q(
    `SELECT day, temp_max, precipitation, wind_max FROM weather_daily
     WHERE is_forecast AND day <= (now() + interval '5 days')::date ORDER BY day`);
  let n = 0;
  for (const r of rows) {
    const rain = Number(r.precipitation || 0), heat = Number(r.temp_max || 0);
    if (rain < 1 && heat < 45) continue;
    await put({
      code: rain >= 1 ? 'weather_rain' : 'weather_heat',
      severity: 'info', category: 'demand', entity_type: 'fleet', entity_id: 'all',
      title: rain >= 1
        ? `Rain forecast ${day(r.day)} (${rain}mm) — demand spikes, so do collisions`
        : `Extreme heat ${day(r.day)} (${heat}°C) — EV range and AC load both suffer`,
      detail: rain >= 1
        ? `Dubai rain reliably lifts ride demand while cutting road grip. Both effects land in the same hours.`
        : `Sustained ${heat}°C drives continuous AC use, which cuts usable EV range and raises mid-shift charging stops.`,
      action: rain >= 1
        ? `Get maximum supply online for this window and brief drivers on following distance.`
        : `Plan charging around the afternoon peak; expect lower effective range per charge.`,
      impact_aed: null, metric: rain >= 1 ? rain : heat,
      window_start: r.day, window_end: r.day,
    });
    n++;
  }
  return n;
}

/* ─────────────────── 10. Partner concentration: dependency risk ─────────────────── */
async function partnerMix(from, to) {
  const rows = await q(
    `SELECT partner_name, count(*)::int trips, sum(price) revenue
     FROM trip WHERE requested_at BETWEEN $1 AND $2 AND partner_name IS NOT NULL
     GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
  const total = rows.reduce((a, r) => a + r.trips, 0);
  if (!total || rows.length < 2) return 0;
  const top = rows[0];
  const share = top.trips / total;
  if (share < 0.4) return 0;
  await put({
    code: 'partner_concentration', severity: 'warning', category: 'revenue',
    entity_type: 'partner', entity_id: top.partner_name,
    title: `${Math.round(share * 100)}% of partner trips come from ${top.partner_name}`,
    detail: `${top.trips} of ${total} partner trips in this window. A single account at this share means its renewal terms effectively set your margin.`,
    action: `Treat this as a key account — and open a second property to dilute the dependency.`,
    impact_aed: money(top.revenue), metric: share,
    window_start: from, window_end: to,
  });
  return 1;
}


/* ─────────────────── 11. Vehicle documents: a car that cannot legally work ───────────────────
   Registration/insurance expiry is the highest-consequence, lowest-ambiguity signal in
   the whole dataset: it is a date, and on the wrong side of it the vehicle is off the road. */
async function vehicleDocuments() {
  const rows = await q(
    `SELECT d.plate, d.doc_type, d.expires_at, d.status, d.fleet_id,
            p.make, p.model, cd.driver_name
     FROM vehicle_document d
     LEFT JOIN vehicle_profile p ON p.platform=d.platform AND p.vehicle_ext_id=d.vehicle_ext_id
     LEFT JOIN vehicle_current_driver cd ON cd.plate = d.plate
     WHERE d.expires_at IS NOT NULL AND d.expires_at < now() + interval '45 days'
     ORDER BY d.expires_at ASC LIMIT 200`);
  for (const r of rows) {
    const days = Math.round((new Date(r.expires_at) - Date.now()) / 864e5);
    const gone = days < 0;
    const who = r.driver_name ? ` Currently driven by ${r.driver_name}.` : '';
    await put({
      code: gone ? 'vehicle_doc_expired' : 'vehicle_doc_expiring',
      severity: gone || days <= 7 ? 'critical' : 'warning', category: 'compliance',
      entity_type: 'vehicle', entity_id: r.plate, fleet_id: r.fleet_id,
      title: gone
        ? `${r.plate}: ${r.doc_type} expired ${n_(Math.abs(days), 'day')} ago`
        : `${r.plate}: ${r.doc_type} expires in ${n_(days, 'day')}`,
      detail: `${r.make || ''} ${r.model || ''}`.trim()
        + ` — ${r.doc_type} valid until ${day(r.expires_at)}.${who}`
        + (gone ? ' A vehicle working on expired documents is uninsured and un-hireable if stopped.'
                : ' Renewal in the UAE is not same-day; leaving it to the last week risks losing the car from service.'),
      action: gone ? `Take it off dispatch until the renewed document is on file.`
                   : `Start the renewal now and re-check before the expiry date.`,
      impact_aed: null, metric: days, window_start: null, window_end: null,
    });
  }
  return rows.length;
}

/* ─────────────────── 12. Platform's own verdict on our drivers ───────────────────
   Uber computes acceptance/cancellation/completion against its own targets and names
   the drivers who miss. That is a second opinion on data we cannot see ourselves. */
async function platformFlags() {
  const rows = await q(
    `SELECT rec_type, period_start, period_end, org_value, target_value, flagged_count, flagged, fleet_id
     FROM platform_recommendation ORDER BY period_end DESC NULLS LAST LIMIT 20`);
  let n = 0;
  for (const r of rows) {
    let flagged = [];
    try { flagged = typeof r.flagged === 'string' ? JSON.parse(r.flagged) : (r.flagged || []); } catch { /* ignore */ }
    if (!flagged.length) continue;
    const kind = r.rec_type || '';
    const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

    if (/TRIP_COMPLETION/.test(kind)) {
      // online, but produced nothing — the sharpest supply-side waste signal there is
      const idle = flagged.filter((f) => Number(f.value) === 0);
      if (!idle.length) continue;
      const hours = idle.reduce((a, f) => a + (f.online_hours || 0), 0);
      await put({
        code: 'drivers_online_no_trips', severity: 'critical', category: 'utilisation',
        entity_type: 'fleet', entity_id: 'all', fleet_id: r.fleet_id,
        title: `${n_(idle.length, 'driver')} ${s_(idle.length, 'was', 'were')} online but completed no trips`,
        detail: `Uber flagged ${n_(idle.length, 'driver')} logged in for about ${hours.toFixed(1)} `
          + `hours in total with zero completed trips (${day(r.period_start)}). Paid-for supply `
          + 'that produced nothing.',
        action: `Check whether they were genuinely available, sitting in a dead zone, or logged in without intending to work.`,
        impact_aed: null, metric: idle.length,
        /* WHO. This is the most severe finding on the list and it rendered with
           no anchors: seven people named in a sentence and identified nowhere,
           under an action ("check whether they were genuinely available") that
           cannot be taken without their ids. Uber's own payload carries them —
           they were being counted and thrown away one line above. */
        refs: JSON.stringify(idle.map((f) => ({
          driver_ext_id: f.driver_ext_id, hours_online: f.online_hours ?? null,
        }))),
        window_start: r.period_start, window_end: r.period_end,
      });
      n++; continue;
    }

    const isAcc = /ACCEPTANCE/.test(kind);
    await put({
      code: isAcc ? 'below_target_acceptance' : 'above_target_cancellation',
      severity: 'warning', category: 'revenue',
      entity_type: 'fleet', entity_id: 'all', fleet_id: r.fleet_id,
      title: isAcc
        ? `${n_(flagged.length, 'driver')} below Uber's acceptance target`
        : `${n_(flagged.length, 'driver')} above Uber's cancellation target`,
      detail: `Fleet sits at ${pct(r.org_value)} against a target of ${pct(r.target_value)} for ${day(r.period_start)} → ${day(r.period_end)}. Uber names ${n_(flagged.length, 'driver')} on the wrong side of it — these are the accounts that drag dispatch priority for everyone.`,
      action: isAcc
        ? `Review why they decline: vehicle mismatch, positioning, or app left on while unavailable.`
        : `Cancellations after acceptance hurt rider trust and cost the approach drive. Coach the named drivers.`,
      impact_aed: null, metric: flagged.length,
      window_start: r.period_start, window_end: r.period_end,
    });
    n++;
  }
  return n;
}

/* ─────────────────── 13. Tips: service quality that shows up in cash ─────────────────── */
async function tipSignal() {
  const rows = await q(
    /* Weeks of resolved statement days, not raw component periods.
       Uber now answers on two surfaces whose report windows overlap, so a sum
       over driver_earnings_component counts some days twice; and the periods
       themselves are no longer one grid — short REST windows beside GraphQL
       weeks — so grouping by them mixed grains inside one ranking.
       driver_statement_day is per driver-day with that already resolved, and
       date_trunc keeps the Monday-anchored week this threshold was set for. */
    `WITH t AS (
       SELECT max(driver_ext_id) AS driver_ext_id, max(driver_name) AS driver_name,
              date_trunc('week', day)::date AS period_start,
              (date_trunc('week', day) + interval '6 days')::date AS period_end,
              sum(tips) AS tips, sum(net) AS fare
       FROM driver_statement_day
       WHERE source <> 'ledger' AND NOT pseudo
       GROUP BY name_key, 3, 4)
     SELECT * FROM t WHERE fare > 200 ORDER BY (coalesce(tips,0)/nullif(fare,0)) ASC LIMIT 40`);
  if (rows.length < 4) return 0;
  const rates = rows.map((r) => Number(r.tips || 0) / Number(r.fare || 1));
  const median = rates.sort((a, b) => a - b)[Math.floor(rates.length / 2)];
  if (median <= 0) return 0;
  let n = 0;
  for (const r of rows) {
    const rate = Number(r.tips || 0) / Number(r.fare || 1);
    if (rate >= median * 0.4) continue;       // only the clear bottom
    await put({
      code: 'low_tip_rate', severity: 'info', category: 'safety',
      entity_type: 'driver', entity_id: r.driver_ext_id,
      title: `${r.driver_name || r.driver_ext_id} earns tips at ${(rate * 100).toFixed(1)}% of fare`,
      detail: `AED ${Number(r.tips || 0).toFixed(0)} tipped on AED ${Number(r.fare).toFixed(0)} of fares, against a fleet median of ${(median * 100).toFixed(1)}%. Tipping is a rider-satisfaction signal that arrives before ratings do, and it is money the fleet never has to share.`,
      action: `Worth a look at vehicle cleanliness and rider interaction before it turns into a ratings problem.`,
      impact_aed: null, metric: rate,
      window_start: r.period_start, window_end: r.period_end,
    });
    n++;
  }
  return n;
}

/* ─────────────────── runner ─────────────────── */
export async function computeInsights({ from, to } = {}) {
  const end = to || new Date().toISOString().slice(0, 10);
  const start = from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  /* Each job WITH THE CODES IT OWNS.
     ─────────────────────────────────────────────────────────────────────────
     A finding is resolved when the rule that emits it ran and did not emit it
     again — and the readers could only infer "ran" from the rows themselves,
     so a rule that ran and found NOTHING left its whole last set standing.
     That is not hypothetical: on production, 35 vehicle_doc_expiring findings
     were frozen at 2026-08-25 while other rules wrote that morning, and their
     titles are relative ("expires in 1 days"), so the list was telling an
     operator to act on a document that had lapsed six days earlier.

     The ownership is written here, beside the job, rather than inferred from a
     grep of the file: a code nobody owns can never be cleared, so the list
     below is the thing that has to be right, and test/insight_freshness
     .test.mjs checks it against the codes the module actually emits. */
  const jobs = [
    ['idle_vehicle', ['idle_vehicle'], () => idleVehicles()],
    ['vehicle_dormant', ['vehicle_dormant'], () => dormantVehicles()],
    ['low_utilisation', ['low_utilisation'], () => lowUtilisation(start, end)],
    ['licence', ['licence_data_unreliable', 'licence_expiring', 'licence_expired'],
      () => licenceRisk()],
    ['unsafe_driving', ['unsafe_driving'], () => unsafeDriving(start, end)],
    ['deadhead', ['deadhead_waste'], () => deadhead(start, end)],
    ['volume_trend', ['volume_trend'], () => volumeTrend()],
    ['stale_tracker', ['stale_tracker'], () => staleTelemetry()],
    ['cancellations', ['cancellation_rate'], () => cancellations(start, end)],
    ['weather', ['weather_rain', 'weather_heat'], () => weatherOutlook()],
    ['partner_mix', ['partner_concentration'], () => partnerMix(start, end)],
    ['vehicle_documents', ['vehicle_doc_expiring', 'vehicle_doc_expired'], () => vehicleDocuments()],
    ['platform_flags', ['drivers_online_no_trips', 'below_target_acceptance',
      'above_target_cancellation'], () => platformFlags()],
    ['tip_signal', ['low_tip_rate'], () => tipSignal()],
  ];
  const out = {};
  for (const [name, codes, fn] of jobs) {
    try {
      out[name] = await fn();
      /* Stamped only on success, and only for the codes this job owns. A job
         that threw has evaluated nothing, so its findings must stand rather
         than vanish the moment a rule starts failing. */
      for (const code of codes) {
        await pool.query(
          `INSERT INTO insight_run (code, ran_at) VALUES ($1, now())
           ON CONFLICT (code) DO UPDATE SET ran_at = EXCLUDED.ran_at`, [code]);
      }
    } catch (e) {
      out[name] = `err: ${String(e).slice(0, 80)}`;
      log.error('insights', name, { err: String(e) });
    }
  }
  /* Prune the copies this run has just made obsolete.
     ─────────────────────────────────────────────────────────────────────────
     The windowed rules key on (code, entity_type, entity_id, window_start,
     window_end), and the window slides: a 30-day lookback recomputed every
     thirty minutes means the same finding about the same vehicle keys
     differently every time and INSERTS instead of replacing. Production held
     29,634 rows describing 204 findings — 99.3% duplicates — and both readers
     de-duplicated at query time with a DISTINCT ON over all of them, four
     times per summary.

     Deleting here keeps exactly the row those readers already serve
     (DISTINCT ON ... ORDER BY computed_at DESC), so no number on any page
     moves; only the sort behind it shrinks. sql/schema_v31.sql does the same
     delete once for the copies that had already accumulated, and explains why
     the surviving set is provably the current answer.

     WRITTEN AS AN ANTI-JOIN, NOT A SELF-JOIN. This was
     `DELETE FROM insight a USING insight b`, which compares every row against
     every other row: at thirty thousand rows that is nine hundred million
     pairs and it exceeded the two-minute statement timeout every time. So the
     prune that was supposed to run after every generation never once
     completed — which is precisely why the table was still 99.3% duplicates
     while this code claimed to be pruning it. DISTINCT ON picks the survivors
     with a single sort, and the tiebreak matches both migrations so the three
     cannot disagree about which copy lives. */
  const pruned = await pool.query(
    `WITH keep AS (
       SELECT DISTINCT ON (code, entity_type, entity_id) id
         FROM insight
        ORDER BY code, entity_type, entity_id, computed_at DESC, id DESC
     )
     DELETE FROM insight i
      WHERE NOT EXISTS (SELECT 1 FROM keep k WHERE k.id = i.id)`);
  out._pruned = pruned.rowCount || 0;
  log.info('insights', 'computed', out);
  return out;
}
