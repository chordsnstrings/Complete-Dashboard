/* The hours a car stands still between one driver and the next.
   ─────────────────────────────────────────────────────────────────────────
   Every per-day number in this product calls a car "used" on a day two people
   drove it, and says nothing about the hours it sat between them. This is that
   measurement, and the two things it is easy to get wrong are both here:

     · the gap must start when the outgoing driver's last job ENDED, not when
       it was requested — custody stored only the request time until v39, and a
       gap measured from that is one trip's duration too long
     · a car parked for days between drivers is not a slow change-over, and
       letting one of those into the average drowns out every real handover

   The fixture builds both, plus the two shapes that produce a false positive:
   overlapping stints, and the same person twice in a day. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { rebuildCustody } from '../src/custody.js';
import { vehicleRoutes } from '../api/vehicle_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'), ('egari','Egari') ON CONFLICT DO NOTHING`);

let n = 0;
/* `end` is minutes after the request. A row given none carries no ended_at,
   which is the pre-v39 shape and must fall back to the request time. */
const trip = (plate, drv, name, at, { end = 30, platform = 'uber', fleet = 'ecosine' } = {}) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
                     requested_at,ended_at,distance_km,price,status)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,9,40,'completed')`,
  [platform, `h${n++}`, fleet, plate, drv, name, at,
   end == null ? null : new Date(new Date(at).getTime() + end * 60000).toISOString()]);

const D = '2026-08-20';
/* H1 — a clean handover. Alice's last job is requested at 11:00 and ends at
   11:30; Bob's first is requested at 14:00. The gap is 2.5 hours, and a
   measurement that used the request time would call it 3. */
for (const h of [7, 9, 11]) await trip('H1', 'd-alice', 'Alice Ahmed', `${D}T${String(h).padStart(2, '0')}:00:00+04:00`);
await trip('H1', 'd-bob', 'Bob Khan', `${D}T14:00:00+04:00`);

/* H2 — overlapping stints. Carl works until 09:30, Dana's first job was
   requested at 09:00, before he finished. There is no free time here and the
   naive lag() would report a negative one. */
await trip('H2', 'd-carl', 'Carl Said', `${D}T08:00:00+04:00`, { end: 90 });
await trip('H2', 'd-dana', 'Dana Noor', `${D}T09:00:00+04:00`);

/* H3 — the car went out of service. Eve finishes on the 20th, Frank starts on
   the 23rd. Sixty hours is not a change-over. */
await trip('H3', 'd-eve', 'Eve Rahim', `${D}T18:00:00+04:00`, { end: 60 });
await trip('H3', 'd-frank', 'Frank Ali', '2026-08-23T08:00:00+04:00');

/* H4 — one driver, a morning and an evening shift. Not a handover at all. */
await trip('H4', 'd-gina', 'Gina Wu', `${D}T07:00:00+04:00`);
await trip('H4', 'd-gina', 'Gina Wu', `${D}T20:00:00+04:00`);

/* H5 — the same human on two platforms, which custody stores as two rows.
   Folded by person, this is one stint and no handover. */
await trip('H5', 'd-hana', 'Hana Said', `${D}T08:00:00+04:00`);
await trip('H5', 'hana-yg', 'Hana Said', `${D}T15:00:00+04:00`, { platform: 'yango' });

/* H6 — the other fleet, so the chip has something to exclude. */
await trip('H6', 'd-iman', 'Iman Zaki', `${D}T06:00:00+04:00`, { fleet: 'egari' });
await trip('H6', 'd-jay', 'Jay Omar', `${D}T12:00:00+04:00`, { fleet: 'egari' });

/* H7 — a channel that sends no drop-off time at all. The gap has to fall back
   to the last REQUEST, which is one trip too long, and the response has to say
   so rather than folding it into the median silently. */
await trip('H7', 'd-kim', 'Kim Lee', `${D}T08:00:00+04:00`, { end: null });
await trip('H7', 'd-leo', 'Leo Diaz', `${D}T12:00:00+04:00`);

await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });

/* ── the fold itself ─────────────────────────────────────────────────────── */
const vdd = await q(`SELECT plate, driver_name, first_trip_at, last_trip_at, last_end_at
                       FROM vehicle_driver_day WHERE plate = 'H1' ORDER BY first_trip_at`);
check('custody stores the drop-off time', vdd[0]?.last_end_at != null, JSON.stringify(vdd[0]));
check('the end is after the last request', vdd[0] && +new Date(vdd[0].last_end_at) === +new Date(vdd[0].last_trip_at) + 30 * 60000,
  JSON.stringify([vdd[0]?.last_trip_at, vdd[0]?.last_end_at]));

/* ── app under test ──────────────────────────────────────────────────────── */
const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const endOfDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} 23:59:59.999` : d);
vehicleRoutes(app, { q, wrap, endOfDay });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json() }; };

const W = 'from=2026-08-01&to=2026-08-31';
const r = await get(`/api/vehicles/handover?${W}`);
check('handover endpoint answers', r.status === 200, JSON.stringify(r.body).slice(0, 200));
const t = r.body.totals, byPlate = new Map((r.body.plates || []).map((x) => [x.plate, x]));

check('one handover on H1', byPlate.get('H1')?.handovers === 1, JSON.stringify(byPlate.get('H1')));
check('the gap is measured from the drop-off, not the request',
  byPlate.get('H1')?.idle_h === 2.5, `got ${byPlate.get('H1')?.idle_h}`);
check('the outgoing and incoming driver are named',
  byPlate.get('H1')?.worst_from === 'Alice Ahmed' && byPlate.get('H1')?.worst_to === 'Bob Khan',
  JSON.stringify(byPlate.get('H1')));

check('overlapping stints produce no gap', !byPlate.has('H2'), JSON.stringify(byPlate.get('H2')));
check('a multi-day gap is not a handover', !byPlate.has('H3'), JSON.stringify(byPlate.get('H3')));
check('a car parked between drivers is counted separately', t.parked === 1, JSON.stringify(t));
check('its days are reported apart from handover hours', t.parked_days > 2 && t.parked_days < 3, `${t.parked_days}`);
check('two shifts by one driver are not a handover', !byPlate.has('H4'));
check('the same person on two platforms is one custodian', !byPlate.has('H5'));

check('the fleet total counts only the sub-day gaps', t.handovers === 3, JSON.stringify(t));
/* 2.5 on H1 (11:30 → 14:00), 5.5 on H6 (06:30 → 12:00), 4 on H7 (08:00 → 12:00,
   from the request because that channel sent no drop-off). */
check('handover hours sum the counted gaps', t.handover_h === 2.5 + 5.5 + 4, `${t.handover_h}`);
check('plates with a handover are counted', t.plates === 3, `${t.plates}`);
check('the median is a real quantile', t.median_h === 4, `${t.median_h}`);

/* The benchmark is the fleet's own quickest quarter, so it can never exceed
   the hours actually spent and can never be negative. */
check('recoverable hours are bounded by the hours spent',
  t.recoverable_h >= 0 && t.recoverable_h <= t.handover_h, JSON.stringify([t.recoverable_h, t.handover_h]));

/* ── the chips ───────────────────────────────────────────────────────────── */
const eg = (await get(`/api/vehicles/handover?${W}&fleet=egari`)).body;
check('the fleet chip narrows to that fleet', eg.totals.handovers === 1
  && eg.plates.length === 1 && eg.plates[0].plate === 'H6', JSON.stringify(eg.totals));
const ec = (await get(`/api/vehicles/handover?${W}&fleet=ecosine`)).body;
check('the other fleet excludes it', !ec.plates.some((x) => x.plate === 'H6'), JSON.stringify(ec.plates.map((x) => x.plate)));
const ub = (await get(`/api/vehicles/handover?${W}&platform=uber`)).body;
check('the platform chip is honoured', ub.totals.handovers >= 1 && ub.totals.custody_rows <= t.custody_rows,
  JSON.stringify([ub.totals.handovers, ub.totals.custody_rows, t.custody_rows]));

/* ── coverage, stated ────────────────────────────────────────────────────── */
const kim = await q(`SELECT last_end_at, last_trip_at FROM vehicle_driver_day
                      WHERE plate = 'H7' AND driver_ext_id = 'd-kim'`);
check('a stint with no drop-off stores no end time', kim[0]?.last_end_at == null, JSON.stringify(kim[0]));
check('its gap falls back to the last request', byPlate.get('H7')?.idle_h === 4, `${byPlate.get('H7')?.idle_h}`);
check('the response reports how many rows were assumed',
  t.timed_rows < t.custody_rows && t.custody_rows > 0, JSON.stringify([t.timed_rows, t.custody_rows]));

/* A window with nothing in it must answer with zeros rather than nulls the
   page would print as "NaN h". */
const empty = (await get('/api/vehicles/handover?from=2025-01-01&to=2025-01-31')).body;
check('an empty window is zeros, not nulls',
  empty.totals.handovers === 0 && empty.totals.handover_h === 0 && empty.plates.length === 0,
  JSON.stringify(empty.totals));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
