/* Eighty-five vehicles that all stopped at the same minute are one fault.
   ─────────────────────────────────────────────────────────────────────────
   Measured on production 2026-09-02: 89 stale_tracker findings, of which 85
   were CABMAN, and 47 of those last reported inside the single hour
   2026-08-31 08:00 with another ten in the hour before it. The live feed
   agreed — CABMAN carried 130 vehicles and 26 of them had reported that hour.

   That is not eighty-five dead devices. It is one feed going quiet, printed
   eighty-five times, each copy telling an operator to "Check the device" — and
   burying the four FMS units that really had failed, one of them dark for 641
   hours, in a list of eighty-five it could not be told apart from.

   So the rule groups by the hour vehicles were last seen, and what this file
   asserts is the boundary: a crowd is the feed, a straggler is the device, and
   neither answer is allowed to eat the other. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { pool } from '../src/db.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* The rule reads and writes through pool.query and nothing else, so this is
   the real rule against a real database rather than a copy of its arithmetic. */
pool.query = (t, p) => db.query(t, p);
const { computeInsights } = await import('../src/insights.js');

const H = 36e5;
const fix = (plate, source, hoursAgo) => q(
  `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status)
   VALUES ($1, 'ecosine', $2, $3::timestamptz, $3::timestamptz, 25.2, 55.3, 0, 'Stopped')`,
  [source, plate, new Date(Date.now() - hoursAgo * H).toISOString()]);

/* Nine CABMAN units that stopped together — 40 hours ago, give or take the
   minutes a poll cycle spreads them over, all inside one hour. */
for (let i = 0; i < 9; i++) await fix(`L-TOGETHER-${i}`, 'cabman', 40 + i * 0.05);
/* One CABMAN unit that stopped on its own, two days before them. */
await fix('L-ALONE', 'cabman', 88);
/* Two FMS units, dark at different times: below the threshold, so each is its
   own device however close together they fall. */
await fix('L-FMS-1', 'fms', 30);
await fix('L-FMS-2', 'fms', 30.1);
/* And one reporting normally, which must not appear at all. */
await fix('L-LIVE', 'cabman', 0.2);

await computeInsights({});
const found = await q(`SELECT code, entity_id, severity, title, detail, action, metric, fleet_id
                       FROM insight WHERE code IN ('stale_tracker', 'tracker_feed_dark')
                       ORDER BY code, entity_id`);
const feed = found.filter((r) => r.code === 'tracker_feed_dark');
const single = found.filter((r) => r.code === 'stale_tracker');

console.log('\nvehicles that went dark together are one finding');
check('the crowd is reported once, not nine times', feed.length === 1,
  JSON.stringify(feed.map((r) => r.entity_id)));
check('…against the feed rather than a vehicle', feed[0]?.entity_id?.startsWith('cabman:'),
  String(feed[0]?.entity_id));
check('…counting them', Number(feed[0]?.metric) === 9, String(feed[0]?.metric));
check('…naming the feed as a person writes it, not as a database key',
  /CABMAN/.test(feed[0]?.title || '') && !/cabman/.test(feed[0]?.title || ''), feed[0]?.title);
check('…and sending the operator to the integration before the vehicles',
  /integration/.test(feed[0]?.action || '') && /before checking any of the vehicles/.test(feed[0]?.action || ''),
  feed[0]?.action);
/* The plates have to be in it: "nine trackers stopped" that does not say which
   nine is a finding nobody can act on. */
check('…and listing the plates it is about',
  /L-TOGETHER-0/.test(feed[0]?.detail || ''), feed[0]?.detail?.slice(0, 120));

console.log('\nand a vehicle that stopped on its own is still its own finding');
check('the straggler survives', single.some((r) => r.entity_id === 'L-ALONE'),
  JSON.stringify(single.map((r) => r.entity_id)));
check('…and says so, rather than repeating the feed-level guess',
  /No other vehicle on this feed stopped at the same time/.test(
    single.find((r) => r.entity_id === 'L-ALONE')?.detail || ''),
  single.find((r) => r.entity_id === 'L-ALONE')?.detail?.slice(0, 100));
check('nobody in the crowd is also reported individually',
  !single.some((r) => r.entity_id.startsWith('L-TOGETHER')),
  JSON.stringify(single.map((r) => r.entity_id)));
/* Two is not a crowd. Cars are parked together all the time; the threshold is
   what stops this rule from turning every quiet weekend into an outage. */
check('two vehicles sharing an hour are two devices, not a feed',
  single.some((r) => r.entity_id === 'L-FMS-1') && single.some((r) => r.entity_id === 'L-FMS-2')
  && !feed.some((r) => r.entity_id.startsWith('fms:')),
  JSON.stringify(found.map((r) => [r.code, r.entity_id])));
check('a vehicle reporting normally is in neither list',
  !found.some((r) => r.entity_id === 'L-LIVE'), JSON.stringify(found.map((r) => r.entity_id)));

/* The boundary the first version of this rule fell off: an outage that starts
   at 07:58 puts some of its vehicles in one clock hour and some in the next,
   and bucketing on the hour split a nine-vehicle cluster into seven and two.
   Clustering by proximity has no edge to fall off, so this seeds one straddling
   a boundary deliberately. */
console.log('\nan outage that straddles the top of an hour is still one outage');
{
  const base = new Date();
  base.setUTCMinutes(2, 0, 0);                 // just past the hour
  for (let i = 0; i < 7; i++) {
    await q(`INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status)
             VALUES ('cabman', 'egari', $1, $2::timestamptz, $2::timestamptz, 25.2, 55.3, 0, 'Stopped')`,
    [`L-EDGE-${i}`, new Date(base.getTime() - 40 * H - i * 4 * 60000).toISOString()]);
  }
  await computeInsights({});
  const edge = await q(
    `SELECT entity_id, metric FROM insight
      WHERE code = 'tracker_feed_dark' AND fleet_id = 'egari'`);
  check('seven vehicles spanning two clock hours are one finding', edge.length === 1,
    JSON.stringify(edge.map((r) => [r.entity_id, r.metric])));
  check('…covering all seven', Number(edge[0]?.metric) === 7, String(edge[0]?.metric));
  const solo = await q(
    `SELECT entity_id FROM insight WHERE code = 'stale_tracker' AND entity_id LIKE 'L-EDGE%'`);
  check('…and none of them reported twice', solo.length === 0,
    JSON.stringify(solo.map((r) => r.entity_id)));
}

console.log('\nand it is still one finding on the next run');
await computeInsights({});
const again = await q(`SELECT count(*)::int n FROM insight WHERE code = 'tracker_feed_dark'`);
check('a feed that is still dark is the same finding, not a second one',
  again[0].n === 1, String(again[0].n));

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
