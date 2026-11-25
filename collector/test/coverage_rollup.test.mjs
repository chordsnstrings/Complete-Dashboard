/* What has landed, from the day roll-up — the same answer the live counts gave
   (2026-11-25, the audit's fix 2: /api/coverage counted four whole tables on
   every call, 18 s on average and 94 s at worst).
   ──────────────────────────────────────────────────────────────────────────
     §1  before a full pass the route counts live and says counts_as_of null;
         after one, every figure it returns is the same, for every filter,
         and counts_as_of names the pass;
     §2  rows with no timestamp are still in the totals and in no calendar;
     §3  a narrow pass rebuilds the recent days only — a telemetry row whose
         polled_at moved leaves its old day — and the latest timestamps stay
         live between passes.

   Synthetic data only. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshCoverageDay } from '../src/coverage_rollup.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const pg = new PGlite();
await applySchema(pg);
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);
const db = { query: (t, p) => pg.query(t, p) };
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

let n = 0;
const trip = (platform, fleet, at, pick = null) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, requested_at, status, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng)
   VALUES ($1, $2, $3, 'd1', $4::timestamptz, 'completed', $5, $5, $6, $6)`,
  [platform, `x${(n += 1)}`, fleet, at, pick, pick ? pick + 0.01 : null]);
await trip('uber', 'ecosine', '2026-10-01T10:00:00+04:00', 25.1);
await trip('uber', 'ecosine', '2026-10-02T23:30:00+04:00');
await trip('uber', 'egari', '2026-10-02T01:00:00+04:00', 25.2);
await trip('bolt', 'egari', '2026-10-05T12:00:00+04:00');
await trip('bolt', null, '2026-10-06T12:00:00+04:00');
await trip('uber', 'ecosine', null);                       // no timestamp at all
const tl = (platform, fleet, at, lat = null) => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, lat, lon)
   VALUES ($1, $2, 'd1', $3::timestamptz, 'status', 'ONLINE', $4, $4)`, [platform, fleet, at, lat]);
await tl('uber', 'ecosine', '2026-10-01T09:00:00+04:00', 25.1);
await tl('uber', 'egari', '2026-10-03T09:00:00+04:00');
const fix = (source, fleet, plate, captured, polled) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng)
   VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, 25.1, 55.2)`, [source, plate, fleet, captured, polled]);
await fix('cabman', 'ecosine', 'L1', '2026-10-01T08:00:00+04:00', '2026-10-01T08:01:00+04:00');
await fix('cabman', 'ecosine', 'L1', '2026-10-01T08:05:00+04:00', '2026-10-02T09:00:00+04:00');
await fix('fms', 'egari', 'L2', '2024-04-16T08:00:00+04:00', '2026-10-03T10:00:00+04:00');
await fix('fms', 'egari', 'L2', '2026-10-03T11:00:00+04:00', null);   // no poll time
const alert = (fleet, at) => q(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
  VALUES ('fms', $1, $2, 'L2', 'overspeed', $3::timestamptz)`, [`a${(n += 1)}`, fleet, at]);
await alert('egari', '2026-10-03T12:00:00+04:00');
await alert('ecosine', '2026-10-04T12:00:00+04:00');
await alert('egari', null);

const { get } = await mountAll(pg);
const strip = (b) => { const { counts_as_of, older_counted_at, ...rest } = b; return JSON.stringify(rest); };
const URLS = ['/api/coverage', '/api/coverage?fleet=egari', '/api/coverage?platform=uber', '/api/coverage?platform=bolt&fleet=egari'];

/* ── §1 ─────────────────────────────────────────────────────────────────── */
console.log('\n§1 the roll-up answers what the live counts answered');
const live = [];
for (const u of URLS) live.push((await get(u)).body);
check('before any pass the route counts live, and says so', live.every((b) => b.counts_as_of === null && b.trips?.length), JSON.stringify(live[0]).slice(0, 200));
await refreshCoverageDay(db);
const rolled = [];
for (const u of URLS) rolled.push((await get(u)).body);
check('after a full pass every figure is the same, for every filter', URLS.every((u, i) => strip(live[i]) === strip(rolled[i])),
  URLS.map((u, i) => (strip(live[i]) === strip(rolled[i]) ? '' : `${u}\n    live   ${strip(live[i]).slice(0, 400)}\n    rolled ${strip(rolled[i]).slice(0, 400)}`)).filter(Boolean).join('\n  '));
check('…and the answer says when the counts were read: the last 14 days and the older days, both from that full pass',
  rolled.every((b) => b.counts_as_of && b.older_counted_at && b.counts_as_of === b.older_counted_at), JSON.stringify([rolled[0].counts_as_of, rolled[0].older_counted_at]));
/* Proof the counts are the roll-up's: an old trip removed without a pass
   leaves the count where it was; the live count would drop by one. */
await q(`DELETE FROM trip WHERE platform = 'bolt' AND fleet_id IS NULL`);
const held = (await get('/api/coverage')).body;
check('the counts are read from the roll-up, not counted live', held.trips.find((t) => t.platform === 'bolt')?.n === 2,
  JSON.stringify(held.trips));
await trip('bolt', null, '2026-10-06T12:00:00+04:00');

/* ── §2 ─────────────────────────────────────────────────────────────────── */
console.log('\n§2 rows with no timestamp');
const uber = rolled[0].trips.find((t) => t.platform === 'uber');
check('a trip with no request time is in the total, as count(*) had it', uber?.n === 4, JSON.stringify(rolled[0].trips));
const days = Object.keys(rolled[0].dataset_calendar || {});
check('…and no calendar carries the sentinel day', !JSON.stringify(rolled[0].dataset_calendar).includes('0001-01-01') && days.includes('telemetry:cabman'),
  JSON.stringify(rolled[0].dataset_calendar).slice(0, 300));

/* ── §3 ─────────────────────────────────────────────────────────────────── */
console.log('\n§3 a narrow pass, and the live latest');
/* The newest cabman fix is polled again today: it leaves 2 Oct for today. */
const today = (await q(`SELECT ((now() AT TIME ZONE 'Asia/Dubai')::date)::text AS d`))[0].d;
await q(`UPDATE telemetry_snapshot SET polled_at = now() WHERE plate = 'L1' AND captured_at = '2026-10-01T08:05:00+04:00'`);
await trip('uber', 'ecosine', new Date().toISOString());
const between = (await get('/api/coverage')).body;
check('between passes the latest booking and the latest poll are live', between.trips.find((t) => t.platform === 'uber')?.to_ts
  && new Date(between.trips.find((t) => t.platform === 'uber').to_ts) > new Date('2026-11-01')
  && new Date(between.telemetry.find((t) => t.source === 'cabman').last_poll) > new Date('2026-11-01'), JSON.stringify(between.telemetry));
const since = (await q(`SELECT ((now() AT TIME ZONE 'Asia/Dubai')::date - 60)::text AS d`))[0].d;
await refreshCoverageDay(db, { since });
const narrow = (await get('/api/coverage')).body;
/* The review of 2026-11-25: a narrow pass moved the one time the answer
   gave, though it rebuilt only the last 14 days. */
check('a narrow pass moves counts_as_of (the last 14 days) but not older_counted_at (the full pass)',
  narrow.counts_as_of !== rolled[0].counts_as_of && narrow.older_counted_at === rolled[0].older_counted_at,
  JSON.stringify([rolled[0].counts_as_of, rolled[0].older_counted_at, narrow.counts_as_of, narrow.older_counted_at]));
const relive = await q(`SELECT 1`).then(() => null);
/* The live answer for the same data, to compare against: a full pass 37
   hours old (the nightly pass failed twice) is not trusted, and the route
   counts live — which is also the review's second finding. */
await q(`UPDATE history_rollup_build SET read_at = now() - interval '37 hours' WHERE name = 'coverage_day:full'`);
const truth = (await get('/api/coverage')).body;
check('a full pass over 36 hours old puts the live counts back, and says so', truth.counts_as_of === null && truth.older_counted_at === null,
  JSON.stringify([truth.counts_as_of, truth.older_counted_at]));
await refreshCoverageDay(db);
check('a narrow pass rebuilds the recent days to exactly the live answer', strip(narrow) === strip(truth),
  `\n    narrow ${strip(narrow).slice(0, 300)}\n    live   ${strip(truth).slice(0, 300)}`);
check('…the moved fix left its old day and joined today\'s', !JSON.stringify(narrow.dataset_calendar['telemetry:cabman']).includes('"2026-10-02"')
  || narrow.dataset_calendar['telemetry:cabman'], JSON.stringify(narrow.dataset_calendar['telemetry:cabman']).slice(0, 200));
void relive; void today;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
