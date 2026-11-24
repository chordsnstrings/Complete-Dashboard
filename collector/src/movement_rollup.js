/* One driver's movement per Dubai day, kept (2026-11-24, the operator's step B).
   ──────────────────────────────────────────────────────────────────────────
   "Driver page shows pick up drop off territory. but doesn't show where the
   driver spent time or roamed around … complete view for the duration
   selected."

   The day page already knows how to answer that for ONE day: which car was
   the driver's and when (custody), the fixes inside those hours from one
   tracker per car, and what the car was doing between each pair of fixes
   (api/driver_day_core.js, api/day_movement.js). It costs 2.4–4.4 s a call on
   production (four drivers, 22 Nov, measured 2026-11-24), so a range cannot
   be built on request. This module runs the SAME functions for every person
   who worked a day and keeps the answer (sql/schema_v129.sql), so the range
   view and the day page can never classify the same minute two ways.

   What each minute is
   ───────────────────
   Between two fixes of the same car and tracker, intervalState() says what the
   car was doing: a passenger aboard, moving with the seat empty, moving with
   the seat unreported (never counted as empty), or stopped — and a quiet
   parked tracker (CABMAN's 66-minute heartbeat, FMS's 30) is a stop, marked
   inferred. A silence longer than that is not counted at all.

   What the DRIVER was doing at that minute comes from the records that know:
   on a job from a booking's request to its end; otherwise Uber's live status
   (online / on trip / offline); before the live feed's first word that day,
   the log-in record's online spans — the same order the day page's custody
   uses. "Waiting" is stopped while online and on no job; "parked offline" is
   stopped with no working status at all.

   Where
   ─────
   Every interval is split half to the cell of its first fix and half to the
   cell of its second, on the half-kilometre grid place_cell names
   (round(lat/0.005)). At CABMAN's 20 seconds both ends are the same cell; at
   FMS's six minutes a drive crosses several and the halves are an honest
   approximation, said in the route's basis.

   Pickups and drop-offs, placed
   ─────────────────────────────
   Uber and Bolt bookings carry no coordinates through the API (COVERAGE).
   A position is found, in this order, and `basis` names the rung:
     uber_stage   Uber's own job stage (DJ_PICKUP, DJ_COMPLETED in the driver
                  timeline) — the exact moment — and the car's fix nearest it,
                  within five minutes;
     booking      the booking's own coordinates (hotel, Yango, Bolt orders);
     seat         the first (pickup) or last (drop-off) fix with the seat
                  occupied inside the booking — CABMAN's flag, FMS's count;
     trip_end     a completed booking's end time and the fix nearest it,
                  within five minutes (drop-offs only: a request time is not a
                  pickup time).
   Pickups and drop-offs are counted over COMPLETED bookings — a booking
   nobody rode has neither. */
import { intervalState } from '../api/day_movement.js';
import { km } from '../api/where_routes.js';
import { dayTrips, dayOnline, dayMovement, MOVEMENT_FLOOR_DAY } from '../api/driver_day_core.js';
import { driverScope, PKEY } from '../api/driver_routes.js';
import { log } from './log.js';

export const CELL_DEG = 0.005;
export const POINT_TOLERANCE_S = 300;
/* The backfill stops at the day live collection began. */
export const FLOOR_DAY = MOVEMENT_FLOOR_DAY;

const ms = (t) => new Date(t).getTime();
const cellOf = (f) => [Math.round(f.lat / CELL_DEG), Math.round(f.lng / CELL_DEG)];

/** What the driver was doing at each minute of the day: 'ontrip', 'online'
    or null (offline, or nothing knows). Pure. */
export function minuteStatus({ statusAll = [], online = [], trips = [], limit = 1440 }) {
  const st = new Array(1440).fill(null);
  const paint = (s, e, v) => { for (let m = Math.max(0, s); m < Math.min(1440, e); m += 1) st[m] = v; };
  const liveStart = statusAll.length ? statusAll[0].s : 1440;
  for (const o of online) {
    if (o.s >= liveStart) continue;
    /* A log-in span that ran to midnight only because no later event arrived
       is a claim, not a spell (the day page's custody rule): its start only. */
    paint(o.s, Math.min(liveStart, o.open_ended && o.closed_by === 'day' ? o.s : o.e), 'online');
  }
  for (const x of statusAll) if (x.status !== 'offline') paint(x.s, x.e, x.status === 'ontrip' ? 'ontrip' : 'online');
  for (const t of trips) {
    if (t.s == null) continue;
    paint(t.s, t.e == null ? t.s + 1 : (t.past_midnight ? 1440 : Math.max(t.e, t.s + 1)), 'ontrip');
  }
  for (let m = Math.max(0, limit); m < 1440; m += 1) st[m] = null;
  return st;
}

/** The day's minutes and km, in total and per cell, from the fixes the day
    page keeps (custody-filtered, one tracker per car). Pure. */
export function rollupMovement({ fixes = [], status }) {
  const zero = () => ({ stopped_min: 0, moving_empty_min: 0, moving_seat_unknown_min: 0, with_passenger_min: 0,
    online_min: 0, ontrip_min: 0, wait_min: 0, offline_min: 0, km: 0, km_with_passenger: 0, fixes: 0 });
  const cells = new Map();
  const cell = (f) => {
    const [la, ln] = cellOf(f); const k = `${la}:${ln}`;
    if (!cells.has(k)) cells.set(k, { cell_lat: la, cell_lng: ln, ...zero() });
    return cells.get(k);
  };
  const t = { ...zero(), parked_quiet_min: 0, parked_offline_min: 0 };
  const seen = new Array(1440).fill(false);
  const byCar = new Map();
  for (const f of fixes) {
    const k = `${f.plate}|${f.source}`;
    if (!byCar.has(k)) byCar.set(k, []);
    byCar.get(k).push(f);
    cell(f).fixes += 1;
  }
  t.fixes = fixes.length;
  for (const fs of byCar.values()) {
    fs.sort((a, b) => ms(a.at) - ms(b.at));
    for (let i = 1; i < fs.length; i += 1) {
      const a = fs[i - 1]; const b = fs[i];
      const iv = intervalState(a, b);
      if (!iv) continue;
      const dur = (ms(b.at) - ms(a.at)) / 60000;
      if (!(dur > 0)) continue;
      const dist = iv.inferred ? 0 : km(a, b);
      /* The driver's status over the interval, minute by minute; an interval
         inside one minute takes that minute's. */
      let on = 0; let trip = 0; let off = 0;
      const m0 = a.m; const m1 = Math.max(a.m + 1, b.m);
      for (let m = m0; m < m1 && m < 1440; m += 1) {
        const s = status[m];
        if (s === 'ontrip') trip += 1; else if (s === 'online') on += 1; else off += 1;
        seen[m] = true;
      }
      const n = on + trip + off || 1;
      const kind = iv.state === 'engaged' ? 'with_passenger_min'
        : iv.state === 'available' ? (iv.seat === false ? 'moving_empty_min' : 'moving_seat_unknown_min')
          : 'stopped_min';
      const add = (o, w) => {
        o[kind] += dur * w;
        o.online_min += dur * w * ((on + trip) / n);
        o.ontrip_min += dur * w * (trip / n);
        o.offline_min += dur * w * (off / n);
        if (kind === 'stopped_min') o.wait_min += dur * w * (on / n);
        o.km += dist * w;
        if (kind === 'with_passenger_min') o.km_with_passenger += dist * w;
      };
      add(cell(a), 0.5); add(cell(b), 0.5); add(t, 1);
      if (iv.inferred) t.parked_quiet_min += dur;
      if (kind === 'stopped_min') t.parked_offline_min += dur * (off / n);
    }
  }
  const seenMin = seen.filter(Boolean).length;
  let onlineMin = 0; let ontripMin = 0; let unseen = 0;
  for (let m = 0; m < 1440; m += 1) {
    if (status[m]) { onlineMin += 1; if (!seen[m]) unseen += 1; }
    if (status[m] === 'ontrip') ontripMin += 1;
  }
  const r1 = (x) => Math.round(x * 10) / 10;
  const day = {
    online_min: onlineMin, ontrip_min: ontripMin, seen_min: seenMin, unseen_online_min: unseen,
    stopped_min: Math.round(t.stopped_min), parked_quiet_min: Math.round(t.parked_quiet_min),
    moving_empty_min: Math.round(t.moving_empty_min), moving_seat_unknown_min: Math.round(t.moving_seat_unknown_min),
    with_passenger_min: Math.round(t.with_passenger_min), wait_min: Math.round(t.wait_min),
    parked_offline_min: Math.round(t.parked_offline_min), km: r1(t.km), km_with_passenger: r1(t.km_with_passenger),
    fixes: t.fixes,
  };
  const out = [...cells.values()].map((c) => Object.fromEntries(Object.entries(c)
    .map(([k, v]) => [k, k === 'cell_lat' || k === 'cell_lng' || k === 'fixes' ? v : Math.round(v * 100) / 100])));
  return { day, cells: out };
}

/** Pickups and drop-offs with a position, each with the rung that placed it.
    Pure. `trips` are the day's bookings (dayTrips) with their coordinates
    merged in; `stages` Uber's DJ_PICKUP / DJ_COMPLETED rows for the keys. */
export function placePoints({ trips = [], stages = [], fixes = [], tolS = POINT_TOLERANCE_S }) {
  const sorted = [...fixes].sort((a, b) => ms(a.at) - ms(b.at));
  const nearest = (at, plate) => {
    const want = ms(at); let best = null;
    for (const f of sorted) {
      if (plate && f.plate !== plate) continue;
      const g = Math.abs(ms(f.at) - want) / 1000;
      if (g <= tolS && (!best || g < best.g)) best = { g, f };
    }
    return best;
  };
  const stageOf = new Map();
  for (const s of stages) {
    if (!s.job_ext_id) continue;
    const k = `${s.job_ext_id}|${s.state}`;
    if (!stageOf.has(k) || ms(s.at) < ms(stageOf.get(k).at)) stageOf.set(k, s);
  }
  const ok = (v) => v != null && Number.isFinite(Number(v)) && Number(v) !== 0;
  const points = [];
  let pickups = 0; let pickupsPlaced = 0; let dropoffs = 0; let dropoffsPlaced = 0;
  for (const t of trips) {
    if (t.outcome !== 'completed') continue;
    pickups += 1; dropoffs += 1;
    const inTrip = sorted.filter((f) => (!t.plate || f.plate === t.plate)
      && ms(f.at) >= ms(t.requested_at) && (t.ended_at == null || ms(f.at) <= ms(t.ended_at)));
    const aboard = inTrip.filter((f) => f.passenger === true);
    const put = (kind, p) => points.push({ platform: t.platform, external_id: t.external_id, kind, ...p });
    /* the pickup */
    const sp = stageOf.get(`${t.external_id}|DJ_PICKUP`);
    const np = sp ? nearest(sp.at, t.plate) : null;
    const pu = np ? { at: new Date(sp.at).toISOString(), lat: np.f.lat, lng: np.f.lng, basis: 'uber_stage', gap_s: Math.round(np.g) }
      : ok(t.pickup_lat) && ok(t.pickup_lng) ? { at: null, lat: Number(t.pickup_lat), lng: Number(t.pickup_lng), basis: 'booking', gap_s: null }
        : aboard.length ? { at: aboard[0].at, lat: aboard[0].lat, lng: aboard[0].lng, basis: 'seat', gap_s: null } : null;
    if (pu) { put('pickup', pu); pickupsPlaced += 1; }
    /* the drop-off */
    const sd = stageOf.get(`${t.external_id}|DJ_COMPLETED`);
    const nd = sd ? nearest(sd.at, t.plate) : null;
    const ne = !nd && t.ended_at ? nearest(t.ended_at, t.plate) : null;
    const last = aboard[aboard.length - 1];
    const dr = nd ? { at: new Date(sd.at).toISOString(), lat: nd.f.lat, lng: nd.f.lng, basis: 'uber_stage', gap_s: Math.round(nd.g) }
      : ok(t.dropoff_lat) && ok(t.dropoff_lng) ? { at: null, lat: Number(t.dropoff_lat), lng: Number(t.dropoff_lng), basis: 'booking', gap_s: null }
        : last ? { at: last.at, lat: last.lat, lng: last.lng, basis: 'seat', gap_s: null }
          : ne ? { at: new Date(t.ended_at).toISOString(), lat: ne.f.lat, lng: ne.f.lng, basis: 'trip_end', gap_s: Math.round(ne.g) } : null;
    if (dr) { put('dropoff', dr); dropoffsPlaced += 1; }
  }
  return { points, counts: { pickups, pickups_placed: pickupsPlaced, dropoffs, dropoffs_placed: dropoffsPlaced } };
}

/** The people who worked a Dubai day: anyone with a booking that day or a
    working status from Uber's live feed, on the spine. */
export async function personsForDay(q, day) {
  const rows = await q(
    `WITH ids AS (
       SELECT DISTINCT driver_ext_id AS id FROM trip
        WHERE requested_at >= (($1::date)::timestamp AT TIME ZONE 'Asia/Dubai')
          AND requested_at <  (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
          AND coalesce(btrim(driver_ext_id), '') <> '' AND platform <> 'fms'
       UNION
       SELECT DISTINCT driver_ext_id FROM driver_status_event
        WHERE at >= (($1::date)::timestamp AT TIME ZONE 'Asia/Dubai')
          AND at <  (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
          AND status <> 'offline')
     SELECT DISTINCT p.driver_id AS person_id
       FROM ids JOIN driver_platform_id p ON p.external_id = ids.id AND p.detached_at IS NULL
      WHERE p.driver_id IS NOT NULL
      ORDER BY 1`, [day]);
  return rows.map((r) => Number(r.person_id));
}

/** Build and store one person-day. Returns the day row, or null where the
    person could not be resolved. */
export async function buildPersonDay(q, { personId, day, resolve, now = null }) {
  const d = await resolve({ query: { person: String(personId) } });
  if (!d || d.unresolvable || !(d.keys || []).length) return null;
  const trips = await dayTrips(q, d.keys, day, PKEY);
  const online = await dayOnline(q, d.keys, day);
  const mv = await dayMovement(q, { d, day, trips, online, PKEY, now });
  const status = minuteStatus({ statusAll: mv.statusAll, online, trips, limit: mv.isToday ? mv.limit : 1440 });
  const { day: row, cells } = rollupMovement({ fixes: mv.fixes, status });
  let coords = [];
  if (trips.length) {
    coords = await q(
      `SELECT platform, external_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng FROM trip
        WHERE (platform, external_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [trips.map((t) => t.platform), trips.map((t) => t.external_id)]);
  }
  const co = new Map(coords.map((c) => [`${c.platform}|${c.external_id}`, c]));
  const stages = trips.some((t) => t.platform === 'uber') ? await q(
    `SELECT job_ext_id, state, at FROM driver_timeline_event
      WHERE driver_ext_id = ANY($1) AND kind = 'job' AND state IN ('DJ_PICKUP', 'DJ_COMPLETED')
        AND at >= (($2::date)::timestamp AT TIME ZONE 'Asia/Dubai')
        AND at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai') + interval '6 hours'`, [d.keys, day]) : [];
  const { points, counts } = placePoints({
    trips: trips.map((t) => ({ ...t, ...(co.get(`${t.platform}|${t.external_id}`) || {}) })), stages, fixes: mv.fixes });
  const plates = [...new Set(mv.fixes.map((f) => f.plate))].sort();
  const sources = [...new Set(mv.fixes.map((f) => f.source))].sort();
  const full = { ...row, ...counts, plates, sources, absent: mv.movement.absent || null, partial: !!mv.isToday };
  await q(`DELETE FROM driver_move_cell WHERE person_id = $1 AND day = $2::date`, [personId, day]);
  await q(`DELETE FROM driver_move_point WHERE person_id = $1 AND day = $2::date`, [personId, day]);
  if (cells.length) {
    const cols = ['cell_lat', 'cell_lng', 'stopped_min', 'moving_empty_min', 'moving_seat_unknown_min', 'with_passenger_min',
      'online_min', 'ontrip_min', 'wait_min', 'offline_min', 'km', 'km_with_passenger', 'fixes'];
    for (let i = 0; i < cells.length; i += 200) {
      const chunk = cells.slice(i, i + 200);
      const vals = []; const params = [personId, day];
      chunk.forEach((c) => {
        vals.push(`($1, $2::date, ${cols.map((k) => { params.push(c[k]); return `$${params.length}`; }).join(', ')})`);
      });
      await q(`INSERT INTO driver_move_cell (person_id, day, ${cols.join(', ')}) VALUES ${vals.join(', ')}`, params);
    }
  }
  for (const p of points) {
    await q(`INSERT INTO driver_move_point (person_id, day, platform, external_id, kind, at, lat, lng, basis, gap_s)
             VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
    [personId, day, p.platform, p.external_id, p.kind, p.at, p.lat, p.lng, p.basis, p.gap_s]);
  }
  const dcols = ['plates', 'sources', 'online_min', 'ontrip_min', 'seen_min', 'unseen_online_min', 'stopped_min', 'parked_quiet_min',
    'moving_empty_min', 'moving_seat_unknown_min', 'with_passenger_min', 'wait_min', 'parked_offline_min', 'km', 'km_with_passenger',
    'fixes', 'pickups', 'pickups_placed', 'dropoffs', 'dropoffs_placed', 'absent', 'partial'];
  await q(
    `INSERT INTO driver_move_day (person_id, day, ${dcols.join(', ')}, built_at)
     VALUES ($1, $2::date, ${dcols.map((_, i) => `$${i + 3}`).join(', ')}, now())
     ON CONFLICT (person_id, day) DO UPDATE SET ${dcols.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, built_at = now()`,
    [personId, day, ...dcols.map((k) => full[k])]);
  return full;
}

/** Every person who worked `day`, one at a time (the database is shared with
    the collectors; one person-day is a handful of indexed reads). */
export async function buildDay(q, { day, now = null, resolve = null }) {
  const r = resolve || driverScope({ q, wrap: (f) => f }).resolve;
  const persons = await personsForDay(q, day);
  let built = 0; let failed = 0;
  for (const personId of persons) {
    try { if (await buildPersonDay(q, { personId, day, resolve: r, now })) built += 1; } catch (e) {
      failed += 1;
      log.warn('movement', `person-day failed`, { person: personId, day, err: String(e.message || e).slice(0, 160) });
    }
  }
  return { day, persons: persons.length, built, failed };
}

const dubaiDay = (t) => new Date(t + 4 * 3600000).toISOString().slice(0, 10);
const prevDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

/** The hourly pass: today always; yesterday at 00:47 and 03:47 Dubai (late
    timeline and tracker rows land after midnight); and from 00:47 to 05:47
    only, `backfillDays` older days per pass walking back from the cursor to
    FLOOR_DAY — eighteen a night, so the ~95 days to the floor take about
    five nights. */
export async function movementRollupTick(q, { now = Date.now(), backfillDays = 3 } = {}) {
  const today = dubaiDay(now);
  const hour = new Date(now + 4 * 3600000).getUTCHours();
  const done = [];
  done.push(await buildDay(q, { day: today, now }));
  if (hour <= 5) {
    if (hour === 0 || hour === 3) done.push(await buildDay(q, { day: prevDay(today), now }));
    const [cur] = await q(`SELECT value FROM source_state WHERE source = 'movement_rollup' AND fleet_id = '-' AND key = 'backfilled_to'`);
    let next = cur?.value ? prevDay(cur.value) : prevDay(prevDay(today));
    for (let i = 0; i < backfillDays && next >= FLOOR_DAY; i += 1) {
      done.push(await buildDay(q, { day: next, now }));
      await q(`INSERT INTO source_state (source, fleet_id, key, value, updated_at) VALUES ('movement_rollup', '-', 'backfilled_to', $1, now())
               ON CONFLICT (source, fleet_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [next]);
      next = prevDay(next);
    }
  }
  return done;
}
