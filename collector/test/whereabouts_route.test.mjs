/* GET /api/vehicle/whereabouts — where the car was, every minute of a day,
   through the real route on an in-process Postgres (WHR, 2026-11-16).
   ──────────────────────────────────────────────────────────────────────────
   test/whereabouts_segmenter.test.mjs holds the arithmetic on synthetic
   fixes. This holds what only the route can get wrong: which rows it reads
   and how it reads them.

     §1  a day: the evening before is read (a stay carried in says since
         when), a 0,0 lost lock is no position, an 'uber' status row is no
         position, the gazetteer names the ground, an FMS journey inside a
         drive gives its distance;
     §2  bookings: only COMPLETED ones (never "not_completed", never a
         cancellation) fill a quiet stretch; a pickup named by its address
         (place_area), a drop-off by its coordinates (the gazetteer); and all
         of it only in `with_bookings` — the tracker's own account carries
         none — which the manifest withholds from a role holding bookings as
         totals (Fleet technician), through the real shaper;
     §3  a tracker dead for days says since when; a car with no tracker says
         so; a week reads both sides of midnight the same;
     §4  refusals: a bad day, a day to come, more than a week, no such car.

   Synthetic data only. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { CELL } from '../src/places.js';
import { shapeBody } from '../api/access/shape.js';
import { ROLES } from '../api/public/access_model.js';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const HOME = { lat: 25.2, lng: 55.3 };
const WORK = { lat: 25.25, lng: 55.35 };
for (const [p, area] of [[HOME, 'Home Quarter'], [WORK, 'Work Quarter']]) {
  await q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations)
           VALUES ($1, $2, $3, 40, 1, 40)`, [Math.round(p.lat / CELL), Math.round(p.lng / CELL), area]);
}
const D = '2026-10-10';
const PREV = '2026-10-09';
const ts = (day, hm) => `${day}T${hm}:00+04:00`;
const fix = (plate, at, { lat, lng }, source = 'fms') => q(
  `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status)
   VALUES ($1, 'ecosine', $2, $3::timestamptz, $3::timestamptz, $4, $5, 0, 'Stopped')`, [source, plate, at, lat, lng]);
const every = async (plate, day, from, to, step, place, source = 'fms') => {
  const [fh, fm] = from.split(':').map(Number); const [th, tm] = to.split(':').map(Number);
  for (let m = fh * 60 + fm; m <= th * 60 + tm; m += step) {
    await fix(plate, ts(day, `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`), place, source);
  }
};
const mid = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });

// WCAR (FMS): home the evening before and the night; quiet 01:00–05:00;
// a drive to work 07:00–07:30; work until 12:00; silent until 13:00, then home.
await every('WCAR', PREV, '20:00', '23:50', 10, HOME);
await every('WCAR', D, '00:00', '01:00', 10, HOME);
await every('WCAR', D, '05:00', '07:00', 10, HOME);
for (let k = 1; k < 6; k += 1) await fix('WCAR', ts(D, `07:${String(k * 5).padStart(2, '0')}`), mid(HOME, WORK, k / 6));
await every('WCAR', D, '07:30', '12:00', 10, WORK);
await every('WCAR', D, '13:00', '23:50', 10, HOME);
await fix('WCAR', ts('2026-10-11', '00:00'), HOME);
// A lost lock at 09:00 and an Uber status row (no position) at 10:00.
await q(`INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng)
         VALUES ('fms', 'ecosine', 'WCAR', $1::timestamptz, $1::timestamptz, 0, 0)`, [ts(D, '09:05')]);
await q(`INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, status)
         VALUES ('uber', 'ecosine', 'WCAR', $1::timestamptz, $1::timestamptz, 'ONLINE')`, [ts(D, '10:00')]);
// FMS's own journey for the morning drive.
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, ended_at, distance_km, status)
         VALUES ('fms', 'WCAR|j1', 'ecosine', 'WCAR', $1::timestamptz, $2::timestamptz, 6.2, 'completed')`,
[ts(D, '07:01'), ts(D, '07:29')]);
// Bookings in the noon silence: one completed (pickup by address, drop-off by
// coordinates), one "not_completed" (contains "completed" — the trap), one cancelled.
const trip = (id, status, from, to, extra = {}) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at,
                     duration_s, status, pickup_addr, dropoff_lat, dropoff_lng)
   VALUES ('uber', $1, 'ecosine', 'WCAR', 'd1', 'A Driver', $2::timestamptz, $3::timestamptz, $4, $5, $6, $7, $8)`,
  [id, ts(D, from), ts(D, to), extra.duration_s ?? 1200, status, extra.pickup_addr ?? null,
    extra.dropoff_lat ?? null, extra.dropoff_lng ?? null]);
await trip('b-ok', 'completed', '12:10', '12:40', { pickup_addr: '12 Some Street - Pickup Town - Dubai - United Arab Emirates',
  dropoff_lat: HOME.lat, dropoff_lng: HOME.lng });
await trip('b-not', 'not_completed', '12:15', '12:30');
await trip('b-cxl', 'rider_cancelled', '12:45', '12:50');
// DEAD (CABMAN): one fix five days before. NOFIX: a booking, never a position.
await fix('DEAD', ts('2026-10-05', '14:20'), HOME, 'cabman');
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, status)
         VALUES ('uber', 'nf1', 'ecosine', 'NOFIX', $1::timestamptz, 'completed')`, [ts(D, '09:00')]);

const { get } = await mountAll(db);
const kinds = (segs) => segs.map((s) => (s.kind === 'quiet' ? `quiet:${s.quiet}` : s.kind)).join(' ');
const tiles = (d, segs = d.segments) => {
  let m = 0;
  for (const s of segs) { if (s.start_min !== m) return false; m = s.end_min; }
  return m === d.minutes;
};

console.log('\n§1 a day, read from the tracker');
const r = await get(`/api/vehicle/whereabouts?plate=WCAR&day=${D}`);
const day = r.body?.days?.[0];
{
  check('200, one day, every minute of it accounted for', r.status === 200 && r.body.days.length === 1
    && day.minutes === 1440 && tiles(day), JSON.stringify(r.body).slice(0, 300));
  check('the tracker read is FMS, with its fixes counted', day.tracker?.source === 'fms' && day.tracker.fixes > 100,
    JSON.stringify(day.tracker));
  check('stay (carried in), parked-quiet, stay, drive, stay, moved, stay', kinds(day.segments)
    === 'stay quiet:parked stay drive stay quiet:moved stay', kinds(day.segments));
  check('the evening before is read: the night’s stay says since when', day.stays[0]?.carried_in === true
    && new Date(day.stays[0].since).toISOString() === new Date(ts(PREV, '20:00')).toISOString(), JSON.stringify(day.stays[0]));
  const parked = day.segments.find((s) => s.quiet === 'parked');
  check('01:00–05:00 is parked with the tracker quiet, inferred, at home', parked?.from === '01:00' && parked.to === '05:00'
    && parked.basis === 'inferred' && parked.area === 'Home Quarter', JSON.stringify(parked));
  const drive = day.segments.find((s) => s.kind === 'drive');
  check('the drive names both ends from the gazetteer', drive?.from_area === 'Home Quarter' && drive.to_area === 'Work Quarter',
    JSON.stringify(drive));
  check('…and takes FMS’s journey distance, saying so', drive?.km === 6.2 && drive.km_basis === 'fms_journey', JSON.stringify(drive));
  const work = day.segments.find((s) => s.kind === 'stay' && s.area === 'Work Quarter');
  check('the 09:05 lost lock (0,0) is no position: the work stay is unbroken', work?.from === '07:30' && work.to === '12:00',
    JSON.stringify(work));
  check('the tracker’s own account carries no booking and no anchors', !('anchors' in day)
    && !day.segments.some((s) => s.quiet === 'booking' || s.booking), kinds(day.segments));
  const c = day.coverage;
  check('coverage: three figures adding to 1,440 minutes', c.positioned_min + c.inferred_min + c.unknown_min === 1440
    && c.inferred_min === 240 && c.unknown_min === 60, JSON.stringify(c));
  check('the rules travel with the answer', r.body.rules?.stay_radius_m === 150 && r.body.rules.parked_cadence_min.cabman === 70
    && /half-kilometre cell/.test(r.body.area_why || ''), JSON.stringify(r.body.rules));
}

console.log('\n§2 bookings: completed only, and only where bookings may be seen');
{
  const wb = day.with_bookings;
  check('one booking seen that day — not the "not_completed", not the cancellation', wb?.bookings === 1, JSON.stringify(wb?.bookings));
  check('the noon silence splits round it', kinds(wb.segments) === 'stay quiet:parked stay drive stay quiet:moved quiet:booking quiet:moved stay',
    kinds(wb.segments));
  const bk = wb.segments.find((s) => s.quiet === 'booking');
  check('the booking is 12:10–12:40, from a booking, never a fix', bk?.from === '12:10' && bk.to === '12:40'
    && bk.basis === 'inferred' && /from a booking, not a tracker fix/.test(bk.say), JSON.stringify(bk));
  check('its pickup is named from the address, its drop-off from the coordinates', bk?.from_area === 'Pickup Town'
    && bk.to_area === 'Home Quarter', JSON.stringify(bk));
  check('both ends anchor the car (pickup by the trip’s duration)', wb.anchors.length === 2 && wb.anchors[0].time === '12:20'
    && wb.anchors[1].time === '12:40' && wb.anchors.every((a) => a.basis === 'booking'), JSON.stringify(wb.anchors));
  check('no driver is named anywhere in the answer', !JSON.stringify(r.body).includes('A Driver'));
  check('coverage with bookings counts the 30 minutes as inferred', wb.coverage.inferred_min === 270
    && r.body.coverage_with_bookings.inferred_min === 270 && r.body.coverage.inferred_min === 240, JSON.stringify(wb.coverage));
  // Through the real shaper, with each role's real levels.
  const manifest = JSON.parse(readFileSync('api/access/manifest.json', 'utf8'));
  const entry = manifest.find((e) => e.method === 'GET' && e.path === '/api/vehicle/whereabouts');
  const levels = (code) => ROLES.find((x) => x.code === code).levels;
  const tec = shapeBody(JSON.parse(JSON.stringify(r.body)), entry, levels('TEC'));
  check('a Fleet technician (bookings as totals) gets the tracker’s day without the jobs', tec.body.days[0].with_bookings == null
    && tec.body.coverage_with_bookings == null && tec.withheld.BK === 'A' && tec.body.days[0].segments.length === day.segments.length,
  JSON.stringify(tec.withheld));
  const dsp = shapeBody(JSON.parse(JSON.stringify(r.body)), entry, levels('DSP'));
  check('a Dispatcher (bookings in full) gets both', dsp.body.days[0].with_bookings?.anchors?.length === 2, JSON.stringify(dsp.withheld));
}

console.log('\n§3 a dead tracker, no tracker, a week');
{
  const dead = (await get(`/api/vehicle/whereabouts?plate=DEAD&day=${D}`)).body.days[0];
  check('a tracker silent for days: the whole day is "no reading since"', dead.segments.length === 1
    && dead.segments[0].quiet === 'silent' && /No reading since 2026-10-05 14:20/.test(dead.segments[0].say),
  JSON.stringify(dead.segments));
  const none = (await get(`/api/vehicle/whereabouts?plate=NOFIX&day=${D}`)).body.days[0];
  check('a car whose tracker never reported says so', none.segments[0]?.quiet === 'no_tracker'
    && none.coverage.unknown_min === 1440, JSON.stringify(none.segments));
  const wk = (await get(`/api/vehicle/whereabouts?plate=WCAR&from=${PREV}&to=${D}`)).body;
  const [a, b] = wk.days;
  check('a week: one entry per day, each accounted for', wk.days.length === 2 && tiles(a) && tiles(b),
    JSON.stringify(wk.days.map((x) => x.day)));
  check('…the stay across midnight ends at 24:00 and resumes at 00:00 in the same place',
    a.segments[a.segments.length - 1].to === '24:00' && b.segments[0].from === '00:00'
    && a.segments[a.segments.length - 1].area === b.segments[0].area, `${kinds(a.segments)} | ${kinds(b.segments)}`);
  check('…and the week’s coverage is the sum of its days', wk.coverage.minutes === 2880
    && wk.coverage.positioned_min === a.coverage.positioned_min + b.coverage.positioned_min, JSON.stringify(wk.coverage));
  const today = await get('/api/vehicle/whereabouts?plate=WCAR');
  check('no day asked is today, still running', today.status === 200 && today.body.days[0].running === true
    && today.body.days[0].minutes < 1440 + 1, JSON.stringify(today.body.days?.[0]?.day));
}

console.log('\n§4 refusals');
{
  const bad = await get('/api/vehicle/whereabouts?plate=WCAR&day=10-10-2026');
  check('a day it cannot read is refused', bad.status === 400 && /YYYY-MM-DD/.test(bad.body.error), JSON.stringify(bad.body));
  const future = await get('/api/vehicle/whereabouts?plate=WCAR&day=2099-01-01');
  check('a day still to come is refused, not drawn as unknown', future.status === 400 && /still to come/.test(future.body.error),
    JSON.stringify(future.body));
  const long = await get('/api/vehicle/whereabouts?plate=WCAR&from=2026-10-01&to=2026-10-10');
  check('more than a week at a time is refused', long.status === 400 && /at most 7 days/.test(long.body.error), JSON.stringify(long.body));
  const nope = await get(`/api/vehicle/whereabouts?plate=NOSUCH&day=${D}`);
  check('a plate nothing knows is 404', nope.status === 404, JSON.stringify(nope.body));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
