/* GET /api/overnight — where each car spent the night, through the real
   route on an in-process Postgres (OVN, 2026-11-16).
   ──────────────────────────────────────────────────────────────────────────
   test/overnight_logic.test.mjs holds the choice and the words on synthetic
   fixes. This holds what only the route can get wrong: which rows it reads.

     §1  the fleet-wide night: the population is every plate with a
         positioned fix in the seven days to the window's end (a car silent
         longer is not in the table, and CABMAN's listed cars that sent
         nothing are counted in the population sentence); the evening before
         is read (a stay says since when, as a bound where it is one); a 0,0
         lost lock is no position and an 'uber' row is no tracker fix, so
         neither breaks a parked-quiet night; the gazetteer names the ground;
         unnamed ground is absent with its reason; by_area and counts;
     §2  plates and a range: each car-night says exactly what the fleet table
         says of it; a plate with no position ever is no_tracker; no roster;
     §3  no driver is named anywhere in the body, though the cars carry
         bookings with drivers on them;
     §4  refusals, each a 400 with a reason; last night by default, and
         `running` exactly while its window is open (the cache rule's twin:
         api/cache.js never caches such an answer, test/cache.test.mjs).

   Synthetic data only. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { CELL } from '../src/places.js';
import { clearRosterCache } from '../api/fleet_roster.js';
import { overnightOpen } from '../api/overnight.js';
import { mixedReason } from '../api/access/one_fleet.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const HOME = { lat: 25.2, lng: 55.3 };
const WORK = { lat: 25.25, lng: 55.35 };
const WILD = { lat: 24.9, lng: 55.6 };            // no place_cell: ground the fleet has never named
for (const [p, area] of [[HOME, 'Home Quarter'], [WORK, 'Work Quarter']]) {
  await q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations)
           VALUES ($1, $2, $3, 40, 1, 40)`, [Math.round(p.lat / CELL), Math.round(p.lng / CELL), area]);
}
const N = '2026-10-10';            // the night; its window is 00:00–05:00 on the 11th
const ON = '2026-10-11';
const PREV = '2026-10-09';
const ts = (day, hm) => `${day}T${hm}:00+04:00`;
const fix = (plate, at, { lat, lng }, source = 'fms', fleet = 'ecosine') => q(
  `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status)
   VALUES ($1, $6, $2, $3::timestamptz, $3::timestamptz, $4, $5, 0, 'Stopped')`, [source, plate, at, lat, lng, fleet]);
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const every = async (plate, day, from, to, step, place, source = 'fms', fleet = 'ecosine') => {
  const [fh, fm] = from.split(':').map(Number); const [th, tm] = to.split(':').map(Number);
  for (let m = fh * 60 + fm; m <= th * 60 + tm; m += step) await fix(plate, ts(day, hm(m)), place, source, fleet);
};
const mid = (a, b, f) => ({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f });
const driveFixes = async (plate, day, startHm, a, b, source) => {
  const [h, m0] = startHm.split(':').map(Number);
  for (let k = 1; k < 6; k += 1) await fix(plate, ts(day, hm(h * 60 + m0 + k * 5)), mid(a, b, k / 6), source);
};

// PCAR (CABMAN, egari): home from 15:00 on the 10th, hourly, to 08:00 on the 11th; then to work.
await every('PCAR', N, '15:00', '23:00', 60, HOME, 'cabman', 'egari');
await every('PCAR', ON, '00:00', '08:00', 60, HOME, 'cabman', 'egari');
await driveFixes('PCAR', ON, '08:00', HOME, WORK, 'cabman');
await every('PCAR', ON, '08:30', '20:00', 60, WORK, 'cabman', 'egari');
await every('PCAR', PREV, '00:00', '23:00', 60, HOME, 'cabman', 'egari');
// QCAR (FMS): home 20:00–23:00 every 10 min, quiet until 06:30, then home and a drive.
// A lost lock (0,0) at 02:00 and an Uber status row WITH a position at work at 02:30:
// neither is a tracker fix, so neither may break the parked-quiet night.
await every('QCAR', N, '20:00', '23:00', 10, HOME);
await every('QCAR', ON, '06:30', '07:00', 10, HOME);
await driveFixes('QCAR', ON, '07:00', HOME, WORK, 'fms');
await every('QCAR', ON, '07:30', '11:00', 10, WORK);
await q(`INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng)
         VALUES ('fms', 'ecosine', 'QCAR', $1::timestamptz, $1::timestamptz, 0, 0)`, [ts(ON, '02:00')]);
await q(`INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, status)
         VALUES ('uber', 'ecosine', 'QCAR', $1::timestamptz, $1::timestamptz, $2, $3, 'ONLINE')`, [ts(ON, '02:30'), WORK.lat, WORK.lng]);
// SCAR (CABMAN): last fix five days before — in the week, silent over a day.
await fix('SCAR', ts('2026-10-06', '14:20'), HOME, 'cabman');
// OLD (CABMAN): last fix eleven days before — not in the week, so not in the table.
await fix('OLD', ts('2026-09-30', '09:00'), HOME, 'cabman');
// UCAR (FMS): home at 23:00, at work at 04:30, nothing between — moved unseen.
await every('UCAR', N, '22:00', '23:00', 10, HOME);
await every('UCAR', ON, '04:30', '09:00', 10, WORK);
// WILDCAR (CABMAN): parked all night where the fleet has never named the ground.
await every('WILDCAR', N, '17:00', '23:00', 60, WILD, 'cabman');
await every('WILDCAR', ON, '00:00', '09:00', 60, WILD, 'cabman');
// VCAR (CABMAN): last tracker fix on the 8th; on the night, only Uber's driver app positions it
// (status rows with a position, hourly at work). Uber is not the car's tracker: silent, not parked.
await fix('VCAR', ts('2026-10-08', '14:00'), HOME, 'cabman');
for (let h = 20; h <= 32; h += 1) {
  await q(`INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, status)
           VALUES ('uber', 'ecosine', 'VCAR', $1::timestamptz, $1::timestamptz, $2, $3, 'ONLINE')`,
  [ts(h < 24 ? N : ON, hm((h % 24) * 60)), WORK.lat, WORK.lng]);
}
// UONLY: Uber positions only, all week. LOSTLOCK: FMS rows at 0,0 only. Neither is in the table.
await q(`INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, status)
         VALUES ('uber', 'ecosine', 'UONLY', $1::timestamptz, $1::timestamptz, $2, $3, 'ONLINE')`, [ts(N, '22:00'), WORK.lat, WORK.lng]);
await q(`INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng)
         VALUES ('fms', 'ecosine', 'LOSTLOCK', $1::timestamptz, $1::timestamptz, 0, 0)`, [ts(N, '22:00')]);
// Bookings with a driver on them, in two of the cars: the route must not read or name them.
for (const [id, plate] of [['b1', 'PCAR'], ['b2', 'QCAR']]) {
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status)
           VALUES ('uber', $1, 'ecosine', $2, 'drv-secret-1', 'Synthetic Person', $3::timestamptz, $4::timestamptz, 'completed')`,
  [id, plate, ts(N, '21:10'), ts(N, '21:40')]);
}
// CABMAN's own list of cars: it still lists PCAR, SCAR, WILDCAR and OLD.
/* GONE: a CABMAN plate the roster says departed, still sending fixes into
   telemetry_snapshot — the 108 plates that made the first production answer
   read 215 cars where /api/live lists 136. It must be set aside. */
await every('GONE', ON, '00:00', '05:00', 60, HOME, 'cabman');
await q(`INSERT INTO source_state (source, fleet_id, key, value) VALUES ('cabman', 'ecosine', 'roster', $1)`,
  [JSON.stringify({ polls: 400, plates: {}, listed: ['PCAR', 'SCAR', 'WILDCAR', 'OLD'], departed: ['GONE'], pending: [] })]);
clearRosterCache();

const { get } = await mountAll(db);

console.log('\n§1 the fleet-wide night');
const r = await get(`/api/overnight?night=${N}`);
const n0 = r.body?.nights?.[0] || {};
const car = (p, nn = n0) => (nn.cars || []).find((c) => c.plate === p) || {};
check('200, one night, its window on the 11th', r.status === 200 && r.body.nights.length === 1 && n0.night === N
  && n0.window.on === ON && n0.window.from === '00:00' && n0.window.to === '05:00' && n0.running === false, JSON.stringify(r.body).slice(0, 300));
check('the population is the week’s positioned tracker plates: six cars — not OLD (eleven days dark), not UONLY (Uber only), not LOSTLOCK (0,0 only)',
  JSON.stringify(n0.cars.map((c) => c.plate)) === JSON.stringify(['PCAR', 'QCAR', 'SCAR', 'UCAR', 'VCAR', 'WILDCAR']), JSON.stringify(n0.cars.map((c) => c.plate)));
check('…said in a sentence, with the listed car that sent nothing counted',
  /7 days to 2026-10-11 05:00 Dubai: 6 cars/.test(r.body.population) && /1 of the 4 plates CABMAN still lists sent no positioned fix/.test(r.body.population)
  && r.body.roster.silent_week === 1 && JSON.stringify(r.body.roster.silent_plates) === '["OLD"]', r.body.population);
check('a CABMAN plate the roster set aside (GONE, departed) is not in the table, and the sentence counts it',
  !n0.cars.some((c) => c.plate === 'GONE') && r.body.roster.set_aside === 1
  && /1 plate CABMAN has stopped listing .* is set aside, as on every fleet page/.test(r.body.population), r.body.population);
const P = car('PCAR');
check('PCAR: parked at Home Quarter, seen, on its own fleet', P.status === 'parked' && P.area === 'Home Quarter' && P.basis === 'fixes'
  && P.fleet_id === 'egari' && P.source === 'cabman' && P.minutes_in_window === 300, JSON.stringify(P));
check('…the evening before was read: there since at least 17:00 (the nearest fix before the 18:00 read), until 08:00',
  P.from === '17:00' && P.from_day === N && P.since_at_least === true && P.to === '08:00' && P.to_day === ON && P.to_at_least === false,
  JSON.stringify([P.from, P.from_day, P.since_at_least, P.to, P.to_day]));
const Q = car('QCAR');
check('QCAR: parked at Home Quarter, INFERRED — the lost lock and the Uber row did not break the quiet night',
  Q.status === 'parked' && Q.area === 'Home Quarter' && Q.basis === 'inferred' && Q.inferred_min === 300 && /inferred/.test(Q.how)
  && Q.from === '20:00' && Q.to === '07:00', JSON.stringify(Q));
const S = car('SCAR');
check('SCAR: silent, not parked, with since when', S.status === 'silent' && S.area === null && /No reading since 2026-10-06 14:20/.test(S.reason), JSON.stringify(S));
const V = car('VCAR');
check('VCAR: Uber’s positions are not the tracker — silent since the 8th, not parked at work',
  V.status === 'silent' && V.source === 'cabman' && /No reading since 2026-10-08 14:00/.test(V.reason || ''), JSON.stringify([V.status, V.source, V.area, V.reason]));
const U = car('UCAR');
check('UCAR: unknown — moved while the tracker was silent', U.status === 'unknown' && /Moved while the tracker was silent/.test(U.reason)
  && /Home Quarter at (2026-10-10 )?23:00/.test(U.reason) && /Work Quarter at 04:30/.test(U.reason), U.reason);
const Wc = car('WILDCAR');
check('WILDCAR: parked, area null, with the reason — never a guessed name', Wc.status === 'parked' && Wc.area === null
  && /ground the fleet has never driven near has no name/i.test(Wc.reason) && Math.abs(Wc.lat - WILD.lat) < 0.001, JSON.stringify(Wc));
check('by_area: Home Quarter 2, unnamed 1', JSON.stringify(n0.by_area) === JSON.stringify([{ area: 'Home Quarter', n: 2 }, { area: null, n: 1 }]), JSON.stringify(n0.by_area));
check('counts partition the six', JSON.stringify(n0.counts) === JSON.stringify({ parked: 2, inferred: 1, unknown: 1, silent: 2, no_tracker: 0, moving: 0 }), JSON.stringify(n0.counts));
check('rules and area_why travel with the answer', /00:00–05:00/.test(r.body.rules.window) && /left unnamed rather than guessed/.test(r.body.area_why));

console.log('\n§2 plates and a range');
const pr = await get(`/api/overnight?plates=pcar,QCAR,ZZZ9&from=${PREV}&to=${N}`);
check('200, two nights, three cars each', pr.status === 200 && pr.body.nights.length === 2
  && pr.body.nights.every((x) => x.cars.length === 3), JSON.stringify(pr.body).slice(0, 300));
const pN = pr.body.nights?.[1] || {};
check('each car-night says exactly what the fleet table said of it',
  JSON.stringify(car('PCAR', pN)) === JSON.stringify(P) && JSON.stringify(car('QCAR', pN)) === JSON.stringify(Q),
  `${JSON.stringify(car('PCAR', pN))}\n      ${JSON.stringify(P)}`);
check('a plate with no position ever is no_tracker, with its reason', car('ZZZ9', pN).status === 'no_tracker'
  && /No tracker position has ever been recorded/.test(car('ZZZ9', pN).reason));
check('the night before is its own night: PCAR at home from its fixes on the 9th',
  car('PCAR', pr.body.nights[0]).status === 'parked' && car('PCAR', pr.body.nights[0]).night === PREV, JSON.stringify(car('PCAR', pr.body.nights[0])));
check('the population names the cars asked for, and there is no roster', /The 3 cars asked for \(PCAR, QCAR, ZZZ9\)/.test(pr.body.population)
  && pr.body.roster === null, pr.body.population);

console.log('\n§3 no driver named');
const txt = JSON.stringify(r.body) + JSON.stringify(pr.body);
check('neither answer carries a driver’s name or id', !/Synthetic Person|drv-secret|driver/i.test(txt), txt.match(/.{40}(Synthetic|drv-secret|driver).{40}/i)?.[0]);

console.log('\n§4 refusals, the default, running');
const dubaiNow = new Date(Date.now() + 4 * 3600e3);
const todayD = dubaiNow.toISOString().slice(0, 10);
const yday = new Date(Date.parse(`${todayD}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
for (const [qs, re] of [
  ['night=10-10-2026', /night must be YYYY-MM-DD/],
  [`night=${todayD}`, /has not begun/],
  [`plates=PCAR&from=${yday}&to=${todayD}`, /has not begun/],
  [`plates=${Array.from({ length: 11 }, (_, i) => `L${i + 10}`).join(',')}`, /at most 10 plates/],
  ['plates=PCAR&from=2026-08-01&to=2026-09-15', /at most 31 nights/],
  [`from=${PREV}&to=${N}`, /range of nights is for named plates/],
]) {
  const x = await get(`/api/overnight?${qs}`);
  check(`400 with a reason: ${qs.slice(0, 50)}`, x.status === 400 && re.test(`${x.body?.error} ${x.body?.detail || ''}`), JSON.stringify(x));
}
const def = await get('/api/overnight');
const open = dubaiNow.getUTCHours() < 5;
/* `running` is the WINDOW (to 05:00); the cache rule is the READ (to 12:00,
   review OVN9) — the first draft tied the two together here. */
const read = dubaiNow.getUTCHours() < 12;
check(`no night named: last night (${yday}), ${open ? 'running — its window is still open' : 'closed'}; `
  + `${read ? 'still read to now (never cached)' : 'read to noon (cacheable)'}`,
  def.status === 200 && def.body.nights[0].night === yday && def.body.nights[0].running === open
  && overnightOpen({}) === read, JSON.stringify(def.body.nights?.[0]).slice(0, 200));

/* OVN13: a one-fleet reader is refused this route (manifest 'mixed'); the
   reason must be true of BOTH its uses — the driver pages ask by plate, and
   have no by-area line — not only of the fleet page's table. */
const why = mixedReason({ method: 'GET', path: '/api/overnight' });
check('the one-fleet refusal is true of the driver pages too: read by plate, whichever fleet', /read by plate/.test(why)
  && /driver pages/.test(why) && /by-area line and counts/.test(why), why);

console.log(`\n${pass} passed, ${fail} failed`);
await db.close();
process.exit(fail ? 1 : 0);
