/* ── a tracker losing power is not a driving style ─────────────────────────
   The alert feed carries five types. Four are things a driver did; the fifth,
   Main Power Lost, is the box on the car complaining about its own wiring.
   api/public/app.js already separated them on the #safety donuts, with the
   comment "charted together they were one number under a heading about harsh
   driving" — and then every RANKING went on using the total.

   Measured on production over the whole alert record before this fix:
     L26356   3,058 alerts, 1,302 of them device faults (42.6%)   530 -> 304
     L85082     467 alerts,   187 device (40.0%)                  687 -> 412
     L86970   3,607 alerts, 1,456 device (40.4%)                  344 -> 205
   and the worst case is the opposite one:
     L38439      56 alerts,    56 device (100%)   ranked 1.4 per 100 km
     L39421      23 alerts,    23 device (100%)   ranked 4.4 per 100 km
   Two cars with NO driving measurement at all sat at the top of the page as
   the fleet's cleanest. That is what these assertions are about: not only that
   the rate falls, but that a rate with nothing behind it goes absent instead of
   going to zero. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { readFileSync } from 'node:fs';
import {
  DEVICE_FAULT_SQL, DRIVING_EVENT_SQL, drivingCount, deviceCount,
  isDeviceFault, alertRate, alertRateReason, DEVICE_FAULT_WORDS,
} from '../api/alert_coverage_sql.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\ndevice faults are not driving events');

/* ── 1. the classifier, and its agreement with the page ──────────────────── */
const DRIVING = ['Sharp Turn', 'Harsh Brake', 'Harsh Acceleration', 'OverSpeed'];
const DEVICE = ['Main Power Lost'];
check('the four driving types are driving', DRIVING.every((t) => !isDeviceFault(t)));
check('Main Power Lost is a device fault', DEVICE.every((t) => isDeviceFault(t)));
/* The safe direction. An unrecognised type is far likelier to be a new
   behaviour event than a new hardware fault, and counting a device fault as
   driving inflates one car's rate where the reverse silently exonerates it. */
check('a type nobody has seen before counts as driving', !isDeviceFault('Seatbelt Unfastened'));
check('and so does a null type', !isDeviceFault(null) && !isDeviceFault(undefined));

/* The client-side donuts and the server-side rankings must not be able to
   disagree about what a device fault is. */
const APP = readFileSync('api/public/app.js', 'utf8');
const m = APP.match(/const DEVICE = \/([^/]+)\/i;/);
check('the page still has its own classifier to agree with', !!m, 'api/public/app.js');
check('and it is word-for-word the shared one',
  m && m[1] === DEVICE_FAULT_WORDS.join('|'), m ? `${m[1]} vs ${DEVICE_FAULT_WORDS.join('|')}` : '');

/* ── 2. the SQL halves partition the feed ────────────────────────────────── */
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);

const DAY = '2026-08-20';
let seq = 0;
const alert = (plate, type, n) => Promise.all(Array.from({ length: n }, () => q(
  `INSERT INTO alert (platform, external_id, plate, fleet_id, alert_type, occurred_at)
   VALUES ('fms',$1,$2,'ecosine',$3,$4::date + interval '9 hours')`,
  [`a${++seq}`, plate, type, DAY])));

/* The three shapes that matter, with production's own proportions. */
await alert('L26356', 'Harsh Brake', 17);      // mixed: 42% device, like the real plate
await alert('L26356', 'Sharp Turn', 6);
await alert('L26356', 'Main Power Lost', 17);
await alert('L38439', 'Main Power Lost', 56);  // 100% device — no driving measurement
await alert('L45243', 'Harsh Brake', 30);      // no box trouble at all
await alert('L45243', 'Sharp Turn', 10);

const split = await q(`SELECT plate, count(*)::int total, ${drivingCount()} driving,
                              ${deviceCount()} device FROM alert GROUP BY plate ORDER BY plate`);
const byPlate = Object.fromEntries(split.map((r) => [r.plate, r]));
check('the two halves add up to the whole, on every plate',
  split.every((r) => r.driving + r.device === r.total), JSON.stringify(split));
check('the mixed plate splits where production says it does',
  byPlate.L26356.driving === 23 && byPlate.L26356.device === 17, JSON.stringify(byPlate.L26356));
check('the all-fault plate has zero driving events',
  byPlate.L38439.driving === 0 && byPlate.L38439.device === 56, JSON.stringify(byPlate.L38439));
check('the healthy plate is untouched',
  byPlate.L45243.driving === 40 && byPlate.L45243.device === 0, JSON.stringify(byPlate.L45243));

/* The predicates are each other's negation over every row, including NULL —
   a WHERE that drops NULL alert_type would lose events from the numerator
   without anything saying so. */
await q(`INSERT INTO alert (platform, external_id, plate, fleet_id, alert_type, occurred_at)
         VALUES ('fms','anull','L45243','ecosine',NULL,$1::date + interval '9 hours')`, [DAY]);
const [part] = await q(`SELECT count(*)::int total,
   count(*) FILTER (WHERE ${DRIVING_EVENT_SQL()})::int d,
   count(*) FILTER (WHERE ${DEVICE_FAULT_SQL()})::int f FROM alert`);
check('the predicates partition the table with nothing left over, NULL included',
  part.d + part.f === part.total, JSON.stringify(part));

/* ── 3. the rate: absent, not zero ───────────────────────────────────────── */
const cov = { measured: true, days: [DAY] };
check('a mixed plate rates on its driving events only',
  alertRate(23, 1000, cov, 1, { device: 17 }) === 2.3,
  String(alertRate(23, 1000, cov, 1, { device: 17 })));
check('an all-fault plate is NOT measured, rather than rated 0',
  alertRate(0, 3900, cov, 1, { device: 56 }) === null,
  String(alertRate(0, 3900, cov, 1, { device: 56 })));
/* The distinction the whole fix turns on: a car that genuinely did nothing
   wrong is a zero, and a car with no measurement is an em-dash. Collapsing
   them is how L38439 came to be the cleanest car in the fleet. */
check('a plate with no alerts at all still rates 0 — that is a real clean record',
  alertRate(0, 3900, cov, 1, { device: 0 }) === 0,
  String(alertRate(0, 3900, cov, 1, { device: 0 })));

const why = alertRateReason(3900, cov, { alerts: 0, device: 56 });
check('and the absence says why, naming the count', /56/.test(why || '') && /power/i.test(why || ''), String(why));
check('the reason does not claim a clean record', !/clean|safe|no events/i.test(why || ''), String(why));
check('a healthy plate has no reason to give',
  alertRateReason(3900, cov, { alerts: 40, device: 0 }) === null);
/* The reasons that were already there must keep working unchanged. */
check('an uncovered window still says so',
  /covered none/.test(alertRateReason(100, { measured: false }) || ''));
check('and no distance still says so',
  /no distance/.test(alertRateReason(0, cov) || ''));

/* ── 4. no ranking is left on the contaminated total ─────────────────────── */
const src = (f) => readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/* Blanked first: every one of these files explains the defect in prose that
   quotes the very expression being searched for. */
const RANKERS = ['api/server.js', 'api/vehicle_routes.js', 'api/economics_routes.js',
  'api/driver_routes.js'];
for (const f of RANKERS) {
  const code = src(f);
  const calls = code.match(/alertRate\([^)]*\)/g) || [];
  check(`${f.split('/').pop()}: every alertRate call passes the device count`,
    calls.length > 0 && calls.every((c) => /device:/.test(c)),
    `${calls.filter((c) => !/device:/.test(c)).join(' | ') || `${calls.length} calls`}`);
  const reasons = code.match(/alertRateReason\([^)]*\)/g) || [];
  check(`${f.split('/').pop()}: and every alertRateReason can explain a hardware-only record`,
    reasons.every((c) => /device:/.test(c)),
    reasons.filter((c) => !/device:/.test(c)).join(' | '));
}

/* ── the half that got away ──────────────────────────────────────────────
   The first deploy of this change computed device_alerts in the CTE and never
   selected it into the outer row, so every row reached alertRate() with
   `device` undefined and the two hardware-only plates rated 0.0 again — the
   original bug, wearing the fix as a disguise, and green on every assertion
   above. A count is only useful where it is READ, so these check the whole
   path: a query that computes the column, a projection that carries it, and a
   response that returns it. */
for (const [f, hint] of [
  ['api/vehicle_routes.js', 'al.device_alerts'],
  ['api/economics_routes.js', 'al.device_alerts'],
]) {
  const code = src(f);
  const cte = (code.match(/\$\{deviceCount\(\)\}\s+device_alerts/g) || []).length;
  const carried = (code.match(/coalesce\(al\.device_alerts,\s*0\)/g) || []).length;
  check(`${f.split('/').pop()}: the CTE that counts it also projects it out`,
    cte === 0 || carried > 0, `${cte} counted, ${carried} carried (looking for ${hint})`);
}
/* And on the driver fold, where the count travels through a Map rather than a
   column — the same defect takes a different shape there. */
const econ = src('api/economics_routes.js');
check('the per-person fold accumulates the device half too',
  /devAlerts/.test(econ) && (econ.match(/devAlerts\.get/g) || []).length >= 2,
  `${(econ.match(/devAlerts\.get/g) || []).length} lookups`);
/* Every endpoint that publishes a rate publishes the count behind its
   absence, so a page can say "not measured, and here is why" rather than
   leaving a reader to wonder at an em-dash. */
for (const f of RANKERS) {
  const code = src(f);
  const rates = (code.match(/alerts_per_100km:|per_100km = /g) || []).length;
  const emits = (code.match(/device_alerts:|fleet_device_alerts:/g) || []).length;
  check(`${f.split('/').pop()}: every rate it returns comes with the device count`,
    rates === 0 || emits >= 1, `${rates} rates, ${emits} counts emitted`);
}

/* The list the page prints is cut to a hundred rows. Cutting on the total let
   a driver whose tracker is failing take one of those places from a driver who
   actually brakes hard, on a page read to choose who to coach. */
check('the top-100 cut is made on driving events',
  /ORDER BY driving_alerts DESC/.test(src('api/server.js')));
check('and the table sorts on them by default',
  /defaultSort: \{ key: 'driving_alerts'/.test(src('api/public/app.js')));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
