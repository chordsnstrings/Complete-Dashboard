/* Can you actually open the thing the page just named?
   ─────────────────────────────────────────────────────────────────────────
   This product's whole claim is that a number on one page can be checked on
   another. test/interlinking.test.mjs reads the source and asks whether a
   column that names an entity RENDERS a link. That catches a dead cell. It
   cannot catch the two failures that matter more:

     1. The link is rendered, and the page behind it 404s — because the id the
        list returned is not the id the detail route resolves. A driver page
        that opens on nothing is worse than a name that was never a link: the
        reader concludes the person has no data rather than that we lost them.

     2. The link is rendered, the page loads, and it is empty — the detail
        route answers 200 with zeros for an entity the list said had 40 trips.
        A confident empty page is a lie the reader has no way to detect.

   So this crawls. It seeds a fleet, calls every list endpoint, harvests every
   (entity, id) the UI would build a link from, and opens every one of them
   through the real detail routes. Then it does the opposite: asks an id that
   does not exist and requires an honest 404 rather than an empty success. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { seedFleet, PLATES } from './fixture.mjs';
import { rebuildCustody } from '../src/custody.js';
import { mountAll, declaredRoutes } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
await seedFleet(db);
await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });
const { get, server } = await mountAll(db);
const WIN = 'from=2026-08-01&to=2026-08-31';

/* ── harvest ────────────────────────────────────────────────────────────
   Which JSON keys the UI turns into which kind of link. Taken from the render
   layer's own vocabulary: entity('driver', r.driver_ext_id, …) and friends. */
const DRIVER_KEYS = new Set(['driver_ext_id', 'driver_id', 'current_driver_id', 'top_driver_id']);
const PLATE_KEYS = new Set(['plate', 'main_plate', 'vehicle_plate']);
const drivers = new Set(), plates = new Set();
const harvest = (o) => {
  if (o == null || typeof o !== 'object') return;
  if (Array.isArray(o)) return o.forEach(harvest);
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === 'string' && v.trim()) {
      if (DRIVER_KEYS.has(k)) drivers.add(v);
      if (PLATE_KEYS.has(k)) plates.add(v);
    }
    // The {name, id} pairs the custody helpers return.
    if (k === 'driver_refs' && Array.isArray(v)) v.forEach((r) => r?.id && drivers.add(r.id));
    if (k === 'held_by' && v?.id) drivers.add(v.id);
    if (k === 'vehicle' && v?.plate) plates.add(v.plate);
    if (k === 'plate_list' && Array.isArray(v)) v.forEach((p) => p && plates.add(p));
    if (k === 'plates' && Array.isArray(v)) v.forEach((p) => typeof p === 'string' && plates.add(p));
    if (k === 'ids' && Array.isArray(v)) v.forEach((i) => typeof i === 'string' && drivers.add(i));
    harvest(v);
  }
};

const LIST_ARGS = { '/api/mix': 'by=payment', '/api/mix/detail': 'by=product',
  '/api/tiers/mix': 'by=daypart', '/api/day': 'day=2026-08-05', '/api/slot': 'dow=2&hour=19',
  '/api/corporate/approach': 'by=driver', '/api/corporate/leakage': 'kind=complimentary' };
/* Only the LIST routes — the ones a reader arrives at without already knowing
   an id. A detail route needs one, which is the thing being harvested. */
const isDetail = (r) => /\/api\/(driver|vehicle|segment|corporate\/property|schema\/raw-values|track|map\/journey|drivers\/:)/.test(r)
  && !/\/api\/(drivers|vehicles)\//.test(r);
for (const route of declaredRoutes()) {
  if (isDetail(route) || route.includes(':')) continue;
  const extra = LIST_ARGS[route] ? `&${LIST_ARGS[route]}` : '';
  const { status, body } = await get(`${route}?${WIN}${extra}`);
  if (status >= 400 || body == null) continue;
  harvest(body);
}
check('the list pages name people to open', drivers.size > 0, String(drivers.size));
check('and vehicles to open', plates.size > 0, String(plates.size));

/* ── every harvested id must open ───────────────────────────────────── */
/* The detail routes, discovered rather than listed, so a new tab on either
   page is crawled without anyone remembering to add it here — and a route
   named here that does not exist cannot masquerade as a broken link. The
   earlier hand-written version listed /api/vehicle/compliance, which has never
   existed, and reported it as five dead vehicles. */
const detailPages = (prefix) => declaredRoutes()
  .filter((r) => r.startsWith(prefix) && !r.includes(':')).sort();
const DRIVER_PAGES = detailPages('/api/driver/');
const VEHICLE_PAGES = detailPages('/api/vehicle/');
check('the crawl covers every per-driver page the app declares', DRIVER_PAGES.length >= 10,
  DRIVER_PAGES.join(' '));
check('and every per-vehicle page', VEHICLE_PAGES.length >= 8, VEHICLE_PAGES.join(' '));

const deadDriver = [], deadVehicle = [];
for (const id of drivers) {
  for (const page of DRIVER_PAGES) {
    const extra = page === '/api/driver/vehicles' ? `&driver=${encodeURIComponent(id)}` : '';
    const { status } = await get(`${page}?id=${encodeURIComponent(id)}&${WIN}${extra}`);
    if (status !== 200) deadDriver.push(`${page}?id=${id} → ${status}`);
  }
}
for (const plate of plates) {
  for (const page of VEHICLE_PAGES) {
    const { status } = await get(`${page}?plate=${encodeURIComponent(plate)}&${WIN}`);
    if (status !== 200) deadVehicle.push(`${page}?plate=${plate} → ${status}`);
  }
}
check('every driver a list names opens on every one of their pages',
  deadDriver.length === 0, deadDriver.slice(0, 8).join('\n      '));
check('every vehicle a list names opens on every one of its pages',
  deadVehicle.length === 0, deadVehicle.slice(0, 8).join('\n      '));

/* ── and the page is not empty when the list said it was busy ────────── */
{
  const dir = (await get(`/api/drivers/directory?${WIN}`)).body || [];
  const busy = dir.filter((r) => (r.trips || 0) > 0);
  const hollow = [];
  for (const r of busy) {
    const id = r.ids?.[0] || r.driver_ext_id;
    const k = (await get(`/api/driver/kpis?id=${encodeURIComponent(id)}&${WIN}`)).body;
    if (!k || (k.trips || 0) === 0) hollow.push(`${r.driver_name} (${id}): directory ${r.trips}, page ${k?.trips}`);
  }
  check('a driver the directory says drove has trips on their own page',
    hollow.length === 0, hollow.slice(0, 6).join('\n      '));

  const vdir = (await get(`/api/vehicles/directory?${WIN}`)).body || [];
  const hollowV = [];
  for (const r of vdir.filter((x) => (x.trips || 0) > 0)) {
    const k = (await get(`/api/vehicle/kpis?plate=${encodeURIComponent(r.plate)}&${WIN}`)).body;
    if (!k || (k.trips || 0) === 0) hollowV.push(`${r.plate}: directory ${r.trips}, page ${k?.trips}`);
  }
  check('a vehicle the directory says worked has trips on its own page',
    hollowV.length === 0, hollowV.slice(0, 6).join('\n      '));
}

/* ── the opposite: an id nobody has must be refused, not answered ────── */
{
  const unknown = [];
  for (const page of DRIVER_PAGES) {
    const extra = page === '/api/driver/vehicles' ? '&driver=no-such-person' : '';
    const { status, body } = await get(`${page}?id=no-such-person&${WIN}${extra}`);
    if (status !== 404) unknown.push(`${page} → ${status} ${JSON.stringify(body).slice(0, 60)}`);
  }
  check('an unknown driver is refused rather than answered with zeros',
    unknown.length === 0, unknown.join('\n      '));

  const unknownV = [];
  for (const page of VEHICLE_PAGES) {
    const { status } = await get(`${page}?plate=NOSUCHPLATE&${WIN}`);
    if (status !== 404) unknownV.push(`${page} → ${status}`);
  }
  check('an unknown vehicle is refused rather than answered with zeros',
    unknownV.length === 0, unknownV.join('\n      '));

  const { status: segStatus } = await get('/api/segment?plate=NOSUCHPLATE&at=2026-08-05T10:00:00Z');
  check('a segment that does not exist is refused', segStatus === 404, String(segStatus));
  const { status: dayStatus } = await get('/api/day?day=not-a-day');
  check('a malformed day is a 400, not a 500 and not an empty day', dayStatus === 400, String(dayStatus));
}

/* ── a plate written the way a human writes it still opens ───────────── */
{
  const p = PLATES[0];
  const shapes = [p, p.toLowerCase(), `${p.slice(0, 1)} ${p.slice(1)}`, `${p.slice(0, 1)}-${p.slice(1)}`];
  const bad = [];
  for (const shape of shapes) {
    const { status } = await get(`/api/vehicle/profile?plate=${encodeURIComponent(shape)}&${WIN}`);
    if (status !== 200) bad.push(`${shape} → ${status}`);
  }
  check('a plate typed with a space, a dash or in lower case reaches the same vehicle',
    bad.length === 0, bad.join(', '));
}

/* ── the other four things this app makes addressable ─────────────────── */
/* A driver and a vehicle are the obvious two. A corporate property, an
   occupancy segment, a day and a weekday-hour slot are also pages you can send
   somebody, and each is reached by a link built from a list. */
{
  const props = (await get(`/api/corporate/properties?${WIN}`)).body || [];
  const ids = (Array.isArray(props) ? props : props.rows || [])
    .map((r) => r.partner_id).filter(Boolean);
  const dead = [];
  for (const id of ids.slice(0, 10)) {
    const { status } = await get(`/api/corporate/property?id=${encodeURIComponent(id)}&${WIN}`);
    if (status !== 200) dead.push(`${id} → ${status}`);
  }
  // Not `ids.length === 0 ||` — a fixture with no properties in it would make
  // this pass by having nothing to check, which is how a crawl stops crawling.
  check('every corporate property the list names opens',
    ids.length > 0 && dead.length === 0, `${ids.length} properties; ${dead.join(', ')}`);
  const { status } = await get(`/api/corporate/property?id=no-such-partner&${WIN}`);
  check('and an unknown one is refused', status === 404, String(status));
}
{
  const segs = (await get(`/api/segments?${WIN}`)).body;
  const rows = (segs.rows || []).slice(0, 12);
  const dead = [];
  for (const r of rows) {
    const { status } = await get(
      `/api/segment?plate=${encodeURIComponent(r.plate)}&at=${encodeURIComponent(r.started_at)}`);
    if (status !== 200) dead.push(`${r.plate}@${r.started_at} → ${status}`);
  }
  check('every segment in the list opens on its own page',
    rows.length > 0 && dead.length === 0, `${rows.length} tried; ${dead.join(', ')}`);
  /* The address is (plate, started_at). The list returns started_at as an ISO
     string and the page passes it straight back, so any drift in how Postgres
     renders that timestamp breaks every link at once — which is why this
     round-trips the value rather than constructing one. */
}
{
  const daily = (await get(`/api/trips/daily?${WIN}`)).body || [];
  const days = daily.map((r) => String(r.d).slice(0, 10)).slice(0, 10);
  const dead = [];
  for (const day of days) {
    const { status, body } = await get(`/api/day?day=${day}`);
    if (status !== 200 || !body?.headline) dead.push(`${day} → ${status}`);
  }
  check('every day on the demand chart opens as a day page',
    days.length > 0 && dead.length === 0, dead.join(', '));
}
{
  /* Every cell of the heatmap is a link. A cell with no work still has to open
     — it is the one an operator clicks to ask why nobody covers it. */
  const dead = [];
  for (const [dow, hour] of [[0, 3], [2, 19], [5, 17], [6, 4]]) {
    const { status, body } = await get(`/api/slot?dow=${dow}&hour=${hour}&${WIN}`);
    if (status !== 200 || !body?.headline) dead.push(`${dow}/${hour} → ${status}`);
  }
  check('every weekday-hour cell opens, including the empty ones', dead.length === 0, dead.join(', '));
  const { status: bad } = await get(`/api/slot?dow=9&hour=99&${WIN}`);
  check('and a cell that cannot exist is refused rather than answered', bad === 400, String(bad));
}

console.log(`\n  ${drivers.size} people and ${plates.size} vehicles harvested from the list pages, `
  + `each opened on ${DRIVER_PAGES.length}/${VEHICLE_PAGES.length} of their own pages`);
console.log(`\n${pass} passed, ${fail} failed`);
server.close(); await db.close();
process.exit(fail ? 1 : 0);
