/* Is the data presented in full?
   ─────────────────────────────────────────────────────────────────────────
   Every fact this product records about a VEHICLE is a fact about a PERSON,
   and the plate alone does not name them. A row that says "L45240 carried a
   passenger with no booking against it" is not something an operations manager
   can act on before breakfast; "L45240, held by Kashif Ali that day" is.

   The static half of this lives in test/interlinking.test.mjs: it reads the
   source and asks whether a column that NAMES an entity LINKS to it. That
   catches a dead-end render. It cannot catch the more common shape — a table
   that never carried the person at all, so there was nothing to link.

   This is the runtime half. It seeds a complete fleet, calls every route the
   application declares, and walks the actual JSON. For every list of rows it
   asks: does a row that names a vehicle also name who was driving it? Does a
   row that names a driver also say what they drove?

   Where the answer is legitimately no, it is written down here with the reason
   — a per-driver page does not need to repeat the driver on every row. An
   endpoint absent from both this file's expectations and its exemptions is a
   failure, so a new list starts out having to justify itself. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { seedFleet, PLATES } from './fixture.mjs';
import { rebuildCustody } from '../src/custody.js';
import { mountAll, declaredRoutes } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const trips = await seedFleet(db);
await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });

const { get, server, mounted } = await mountAll(db);
const WIN = 'from=2026-08-01&to=2026-08-31';
const ARGS = {
  '/api/driver/profile': 'id=u-khalid', '/api/driver/kpis': 'id=u-khalid',
  '/api/driver/daily': 'id=u-khalid', '/api/driver/heatmap': 'id=u-khalid',
  '/api/driver/standing': 'id=u-khalid', '/api/driver/territory': 'id=u-khalid',
  '/api/driver/mix': 'id=u-khalid', '/api/driver/earnings': 'id=u-khalid',
  '/api/driver/quality': 'id=u-khalid', '/api/driver/trips': 'id=u-khalid',
  '/api/driver/custody': 'id=u-khalid', '/api/driver/vehicles': 'driver=u-khalid&id=u-khalid',
  '/api/vehicle/profile': `plate=${PLATES[0]}`, '/api/vehicle/kpis': `plate=${PLATES[0]}`,
  '/api/vehicle/daily': `plate=${PLATES[0]}`, '/api/vehicle/drivers-detail': `plate=${PLATES[0]}`,
  '/api/vehicle/movement': `plate=${PLATES[0]}`, '/api/vehicle/safety': `plate=${PLATES[0]}`, '/api/vehicle/trips': `plate=${PLATES[0]}`,
  '/api/vehicle/mix': `plate=${PLATES[0]}`,
  '/api/vehicle/drivers': `plate=${PLATES[0]}`,
  '/api/track': `plate=${PLATES[0]}`, '/api/map/journey': `plate=${PLATES[0]}&day=2026-08-05`,
  '/api/mix': 'by=payment', '/api/mix/detail': 'by=product',
  '/api/schema/raw-values': 'key=client&platform=hotel',
  '/api/corporate/property': 'id=h1', '/api/corporate/leakage': 'kind=complimentary',
  '/api/corporate/approach': 'by=driver', '/api/tiers/mix': 'by=daypart',
  '/api/day': 'day=2026-08-05', '/api/slot': 'dow=2&hour=19',
  '/api/segment': `plate=${PLATES[0]}&at=2026-08-05T10:00:00Z`,
};

/* A row NAMES a vehicle if it carries a plate as an IDENTITY, not as a count.
   `vehicles: 4` is a number; `plate: 'L45240'` is a thing you can open.

   Checked one level into nested values too, because the shared helpers return
   an object or a list of them — {plate, day} for "the car they are in now",
   [{name, id, days}] for "who ran this car". Keyed on the top-level name alone,
   a row that carries exactly what is being asked for reads as missing it, and
   the test then trains people to add a redundant flat column to silence it. */
const PLATE_KEY = /^(plate|vehicle_plate|plates|plate_list|main_plate|on_plates|vehicle|vehicles_refs)$/;
const DRIVER_KEY = /^(driver_name|driver_names|driver_ext_id|driver_refs|drivers|held_by|full_name|driver|primary_driver|current_driver|top_driver)$/;

/* Does this value NAME something, as opposed to counting it?
   `drivers: 4` and `drivers: [{name, id}]` sit under the same key and mean
   opposite things — one is a statistic, the other is two people you can ring.
   A number is never an identity; a string, or an object or list containing
   one, is. Nested values are read because the shared helpers return shapes
   like {plate, day} and [{name, id, days}], and judging on the key alone made
   a row that carries exactly what is being asked for read as missing it. */
const identity = (v) => {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.some(identity);
  if (typeof v === 'object') return Object.values(v).some(identity);
  return false;
};

/* Lists where the missing side is the page's own subject, and repeating it on
   every row would be noise rather than information. Each entry says why. */
const SUBJECT_IS_THE_DRIVER = [
  '/api/driver/profile', '/api/driver/daily', '/api/driver/trips', '/api/driver/custody',
  '/api/driver/vehicles', '/api/driver/heatmap', '/api/driver/territory', '/api/driver/mix',
  '/api/driver/earnings', '/api/driver/quality', '/api/driver/standing', '/api/driver/kpis',
  '/api/drivers/', '/api/driver/',
];
const SUBJECT_IS_THE_VEHICLE = [
  '/api/vehicle/', '/api/track', '/api/map/journey',
];
/* Lists whose rows are not about one vehicle or one person at all: a partner
   property, a settlement class, a corridor between two areas. A plate column
   there would be a different table. */
const NOT_ABOUT_ONE_ASSET = [
  '/api/corporate/', '/api/settlement', '/api/geo/', '/api/mix', '/api/platforms',
  '/api/status', '/api/coverage', '/api/finance/', '/api/schema/', '/api/settings',
  '/api/alerts/summary', '/api/retention', '/api/forecast', '/api/capacity',
  '/api/trend', '/api/insights', '/api/analyst/', '/api/roster', '/api/tiers/mix',
  '/api/collector', '/api/sensor-health', '/api/live', '/api/day/', '/api/slot',
  '/api/unauthorized/summary', '/api/unauthorized/daily', '/api/trips/', '/api/kpis',
];
const startsAny = (r, list) => list.some((p) => r.startsWith(p));

/* Individual lists, exempted by exact path with the reason. A prefix rule is
   too blunt for these: the rest of the same endpoint is still checked. */
const EXEMPT_LIST = new Set([
  /* The shape of the day, grouped by event type: one row is "38 harsh brakes
     across 4 vehicles", which has no single driver by construction. The
     actionable version is alertsByVehicle beside it, which does name one, and
     that IS checked below. */
  '/api/day.alerts',
]);

const plateNoDriver = [], driverNoVehicle = [], nameNoId = [], broke = [];
let listsSeen = 0;

for (const route of declaredRoutes()) {
  if (ARGS[route] === null) continue;
  const path = route.replace(/:(\w+)/g, 'u-khalid');
  const extra = ARGS[route] ? `&${ARGS[route]}` : '';
  const { status, body } = await get(`${path}?${WIN}${extra}`);
  if (status >= 500) { broke.push(`${route} → ${status}`); continue; }
  if (body == null) continue;

  const walk = (o, at = '') => {
    if (o == null || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      const rows = o.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (rows.length) {
        listsSeen++;
        const keys = new Set(rows.flatMap(Object.keys));
        const namesVehicle = rows.some((r) => Object.entries(r)
          .some(([k, v]) => PLATE_KEY.test(k) && identity(v)));
        const namesDriver = rows.some((r) => Object.entries(r)
          .some(([k, v]) => DRIVER_KEY.test(k) && identity(v)));
        const where = `${route}${at}`;
        if (namesVehicle && !namesDriver && !startsAny(route, SUBJECT_IS_THE_DRIVER)
            && !startsAny(route, NOT_ABOUT_ONE_ASSET) && !EXEMPT_LIST.has(where))
          plateNoDriver.push(`${where}  [${[...keys].slice(0, 10).join(',')}]`);
        /* Exempt on EITHER subject: a vehicle page's rows are about that car,
           and a driver page's compliance records and platform accounts are
           facts about the person rather than about work done in a vehicle —
           there is no plate to name on a licence. */
        if (namesDriver && !namesVehicle
            && !startsAny(route, SUBJECT_IS_THE_VEHICLE)
            && !startsAny(route, SUBJECT_IS_THE_DRIVER)
            && !startsAny(route, NOT_ABOUT_ONE_ASSET))
          driverNoVehicle.push(`${where}  [${[...keys].slice(0, 10).join(',')}]`);
        /* A name with no id beside it cannot be linked, whatever the render
           layer wants to do. driver_refs carries both, so it counts. */
        if ((keys.has('driver_name') || keys.has('full_name'))
            && !keys.has('driver_ext_id') && !keys.has('driver_refs') && !keys.has('id'))
          nameNoId.push(where);
      }
      return o.forEach((x) => walk(x, `${at}[]`));
    }
    for (const [k, v] of Object.entries(o)) walk(v, `${at}.${k}`);
  };
  walk(body);
}

const uniq = (a) => [...new Set(a)];
const show = (a) => `\n      ${uniq(a).join('\n      ')}`;

check('no route breaks against a complete fleet', broke.length === 0, show(broke));
check('every list that names a vehicle can also name who was driving it',
  plateNoDriver.length === 0, show(plateNoDriver));
check('every list that names a driver can also name what they drove',
  driverNoVehicle.length === 0, show(driverNoVehicle));
check('no driver name is returned without an id to open them by',
  nameNoId.length === 0, show(nameNoId));

/* ── the awkward shapes the fixture deliberately contains ──────────────── */
/* Each of these has been broken in this codebase, and each is invisible to a
   fixture built only from happy rows. */
const dir = (await get(`/api/drivers/directory?${WIN}`)).body;
const dana = (dir || []).find((r) => /Dana/.test(r.driver_name || ''));
check('a driver the provider names but never numbers is in the directory', !!dana,
  String((dir || []).length));
check('and is openable, by a key that is not a provider id',
  !!dana && String(dana.ids?.[0] || dana.driver_ext_id || '').startsWith('name:'),
  JSON.stringify(dana?.ids || dana?.driver_ext_id));
const danaId = dana && (dana.ids?.[0] || dana.driver_ext_id);
const danaPage = danaId ? await get(`/api/driver/profile?id=${encodeURIComponent(danaId)}&${WIN}`) : null;
check('and their page opens rather than 404ing', danaPage?.status === 200, String(danaPage?.status));
check('and reports the work they actually did',
  (danaPage?.body?.accounts || []).reduce((a, r) => a + (r.trips || 0), 0) > 0,
  JSON.stringify(danaPage?.body?.accounts));
check('and names the vehicles they held',
  (danaPage?.body?.vehicles || []).length > 0, JSON.stringify(danaPage?.body?.vehicles?.length));

const seg = (await get(`/api/segments?${WIN}&verdict=unauthorized`)).body;
check('an unauthorised journey names the driver who held the car that day',
  (seg?.rows || seg || []).length > 0 && (seg.rows || seg).some((r) => r.drivers),
  JSON.stringify((seg?.rows || seg || [])[0] || {}).slice(0, 160));
check('and carries the id pairs, so a handover day makes both people openable',
  (seg?.rows || seg || []).some((r) => Array.isArray(r.driver_refs) && r.driver_refs.length),
  JSON.stringify((seg?.rows || seg || [])[0]?.driver_refs));

const day = (await get('/api/day?day=2026-08-05')).body;
check('the day page attributes its unexplained occupancy to a person',
  (day.segments || []).every((r) => 'drivers' in r), JSON.stringify((day.segments || [])[0] || {}).slice(0, 120));
check('and breaks harsh driving out per vehicle with the driver attached',
  (day.alertsByVehicle || []).length > 0 && day.alertsByVehicle.every((r) => 'drivers' in r),
  JSON.stringify((day.alertsByVehicle || [])[0] || {}));

const tiers = (await get(`/api/tiers/by-vehicle?${WIN}`)).body;
check('the tier table names who runs each car, not just the car',
  (tiers.vehicles || []).some((v) => (v.driver_refs || []).length),
  JSON.stringify((tiers.vehicles || [])[0]?.driver_refs));

const play = (await get(`/api/playbook?${WIN}`)).body;
const withPlates = (play.actions || []).filter((a) => (a.detail || []).some((d) => d.plate));
check('every playbook action about a vehicle names somebody to ring',
  withPlates.length > 0 && withPlates.every((a) => a.detail.every((d) =>
    d.held_by !== undefined || d.driver_refs !== undefined || d.driver !== undefined)),
  withPlates.map((a) => `${a.id}:${Object.keys(a.detail[0] || {}).join('/')}`).join(' '));

console.log(`\n  ${declaredRoutes().length} routes, ${listsSeen} lists, `
  + `${mounted.length} route modules, over ${trips} trips`);
console.log(`\n${pass} passed, ${fail} failed`);
server.close(); await db.close();
process.exit(fail ? 1 : 0);
