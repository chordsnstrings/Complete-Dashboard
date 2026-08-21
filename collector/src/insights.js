// Insight engine — turns the collected data into ranked, actionable findings.
// Every insight answers three questions: what is true, what it costs, what to do.
// Rules are deliberately conservative: we would rather miss a weak signal than
// hand an operator a confident-sounding number we can't defend.
import { pool, upsert } from './db.js';
import { log } from './log.js';

const q = (t, p) => pool.query(t, p).then((r) => r.rows);
const money = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);

// Assumed daily holding cost per vehicle (depreciation + insurance + permit + finance).
// Used only to size the "idle capital" impact; tune in settings later.
const VEHICLE_DAY_COST_AED = Number(process.env.VEHICLE_DAY_COST_AED || 120);

async function put(row) {
  await upsert('insight', { ...row, computed_at: new Date().toISOString() },
    ['code', 'entity_type', 'entity_id', 'window_start', 'window_end']);
}

/* ─────────────────── 1. Idle vehicles: capital earning nothing ─────────────────── */
async function idleVehicles(from, to) {
  const rows = await q(
    `WITH seen AS (
       SELECT plate, fleet_id, max(captured_at) last_seen
       FROM telemetry_snapshot WHERE plate IS NOT NULL GROUP BY plate, fleet_id),
     earned AS (
       SELECT plate, count(*)::int trips, coalesce(sum(price),0) revenue, max(requested_at) last_trip
       FROM trip WHERE requested_at BETWEEN $1 AND $2 AND plate IS NOT NULL GROUP BY plate)
     SELECT s.plate, s.fleet_id, s.last_seen, coalesce(e.trips,0) trips,
            coalesce(e.revenue,0) revenue, e.last_trip
     FROM seen s LEFT JOIN earned e USING (plate)
     WHERE coalesce(e.trips,0) = 0
     ORDER BY s.last_seen DESC`, [from, to]);
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 864e5));
  for (const r of rows) {
    await put({
      code: 'idle_vehicle', severity: 'critical', category: 'utilisation',
      entity_type: 'vehicle', entity_id: r.plate, fleet_id: r.fleet_id,
      title: `${r.plate} earned nothing in ${days} days`,
      detail: `The tracker is alive (last fix ${new Date(r.last_seen).toISOString().slice(0, 16).replace('T', ' ')}) but no trip on any platform in this window. The car exists, is being paid for, and is not producing.`,
      action: `Confirm it is not in workshop//reserve. If roadworthy, assign a driver or take it off the fleet cost base.`,
      impact_aed: money(days * VEHICLE_DAY_COST_AED), metric: 0,
      window_start: from, window_end: to,
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
      title: `${r.full_name || r.driver_ext_id}'s licence ${gone ? 'has expired' : 'expires soon'} (${r.licence_expires})`,
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
     km AS (
       SELECT plate, sum(distance_km) km FROM trip
       WHERE requested_at BETWEEN $1 AND $2 AND plate IS NOT NULL GROUP BY plate)
     SELECT ev.plate, ev.events, ev.overspeed, ev.harsh_brake, km.km,
            (ev.events::float / nullif(km.km,0) * 100) per100
     FROM ev JOIN km USING (plate)
     WHERE km.km > 50 ORDER BY per100 DESC NULLS LAST LIMIT 25`, [from, to]);
  if (!rows.length) return 0;
  const vals = rows.map((r) => r.per100).filter(Boolean).sort((a, b) => a - b);
  const med = vals[Math.floor(vals.length / 2)] || 0;
  let n = 0;
  for (const r of rows) {
    if (!r.per100 || r.per100 < med * 2) continue;   // only the clear outliers
    await put({
      code: 'unsafe_driving', severity: 'warning', category: 'safety',
      entity_type: 'vehicle', entity_id: r.plate,
      title: `${r.plate}: ${r.per100.toFixed(1)} harsh events per 100km — ${(r.per100 / (med || 1)).toFixed(1)}× fleet median`,
      detail: `${r.events} events over ${Math.round(r.km)}km (${r.overspeed} overspeed, ${r.harsh_brake} harsh braking). Sustained harsh driving predicts both collisions and tyre/brake spend.`,
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
      detail: `${Math.round(r.dead)}km unpaid approach against ${Math.round(r.paid)}km of fare distance across ${r.trips} trips. Empty kilometres burn energy, tyres and driver hours with no revenue.`,
      action: `Look at where this car waits. Staging it closer to its usual pickups cuts the approach leg directly.`,
      impact_aed: null, metric: r.ratio, window_start: from, window_end: to,
    });
    n++;
  }
  return n;
}

/* ─────────────────── 6. Demand trend: is the business shrinking? ─────────────────── */
async function volumeTrend() {
  const rows = await q(
    `SELECT date_trunc('month', requested_at)::date m, count(*)::int trips,
            count(distinct driver_ext_id)::int drivers, count(distinct plate)::int vehicles
     FROM trip WHERE requested_at > now() - interval '18 months'
     GROUP BY 1 ORDER BY 1`);
  if (rows.length < 2) return 0;
  const full = rows.slice(0, -1);                     // drop the partial current month
  if (full.length < 2) return 0;
  const first = full[0], last = full[full.length - 1];
  const change = (last.trips - first.trips) / (first.trips || 1);
  if (Math.abs(change) < 0.15) return 0;
  const down = change < 0;
  await put({
    code: 'volume_trend', severity: down ? 'critical' : 'good', category: 'demand',
    entity_type: 'fleet', entity_id: 'all',
    title: `Trip volume ${down ? 'down' : 'up'} ${Math.abs(Math.round(change * 100))}% since ${first.m}`,
    detail: `${first.m}: ${first.trips} trips with ${first.drivers} drivers on ${first.vehicles} vehicles → ${last.m}: ${last.trips} trips with ${last.drivers} drivers on ${last.vehicles} vehicles.`,
    action: down
      ? `Separate the two causes before reacting: fewer drivers supplying, or less demand per driver. The fix is different for each.`
      : `Check the supply side can hold this — utilisation and driver hours are the constraint.`,
    impact_aed: null, metric: change,
    window_start: first.m, window_end: last.m,
  });
  return 1;
}

/* ─────────────────── 7. Stale trackers: blind spots in the fleet ─────────────────── */
async function staleTelemetry() {
  const rows = await q(
    `SELECT DISTINCT ON (plate) plate, fleet_id, source, captured_at, polled_at
     FROM telemetry_snapshot ORDER BY plate, polled_at DESC`);
  let n = 0;
  for (const r of rows) {
    const ageH = (Date.now() - new Date(r.captured_at)) / 36e5;
    if (ageH < 24) continue;
    await put({
      code: 'stale_tracker', severity: ageH > 72 ? 'critical' : 'warning', category: 'data',
      entity_type: 'vehicle', entity_id: r.plate, fleet_id: r.fleet_id,
      title: `${r.plate} has not reported a position for ${Math.round(ageH)}h`,
      detail: `Last fix from ${r.source} at ${new Date(r.captured_at).toISOString().slice(0, 16).replace('T', ' ')}. Either the vehicle is off the road or the tracker has failed — and while it is dark, nothing about this car can be verified.`,
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
    `SELECT platform, fleet_id, count(*)::int total,
            sum((status ILIKE '%cancel%')::int)::int cancels,
            (sum((status ILIKE '%cancel%')::int)::float/nullif(count(*),0)) rate,
            avg(price) avg_price
     FROM trip WHERE requested_at BETWEEN $1 AND $2
     GROUP BY platform, fleet_id HAVING count(*) > 50`, [from, to]);
  let n = 0;
  for (const r of rows) {
    if (!r.rate || r.rate < 0.10) continue;
    await put({
      code: 'cancellation_rate', severity: r.rate > 0.15 ? 'critical' : 'warning', category: 'revenue',
      entity_type: 'platform', entity_id: r.platform, fleet_id: r.fleet_id,
      title: `${Math.round(r.rate * 100)}% of ${r.platform} jobs cancel (${r.cancels} of ${r.total})`,
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
        ? `Rain forecast ${r.day} (${rain}mm) — demand spikes, so do collisions`
        : `Extreme heat ${r.day} (${heat}°C) — EV range and AC load both suffer`,
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

/* ─────────────────── runner ─────────────────── */
export async function computeInsights({ from, to } = {}) {
  const end = to || new Date().toISOString().slice(0, 10);
  const start = from || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const jobs = [
    ['idle_vehicle', () => idleVehicles(start, end)],
    ['low_utilisation', () => lowUtilisation(start, end)],
    ['licence', () => licenceRisk()],
    ['unsafe_driving', () => unsafeDriving(start, end)],
    ['deadhead', () => deadhead(start, end)],
    ['volume_trend', () => volumeTrend()],
    ['stale_tracker', () => staleTelemetry()],
    ['cancellations', () => cancellations(start, end)],
    ['weather', () => weatherOutlook()],
    ['partner_mix', () => partnerMix(start, end)],
  ];
  const out = {};
  for (const [name, fn] of jobs) {
    try { out[name] = await fn(); }
    catch (e) { out[name] = `err: ${String(e).slice(0, 80)}`; log.error('insights', name, { err: String(e) }); }
  }
  log.info('insights', 'computed', out);
  return out;
}
