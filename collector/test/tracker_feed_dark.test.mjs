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
/* The straggler's detail has to carry the EVIDENCE, not the conclusion. It
   used to read "No other vehicle on this feed stopped at the same time, so
   this is the vehicle rather than the feed" — a sentence that is trivially
   true on a feed where every vehicle is dark, and which production printed 85
   times over one CABMAN outage. What separates a dead device from a dead
   integration is how many cars on the same feed are still reporting, so that
   is what the sentence now says. Here exactly one is (L-LIVE), and one is
   thin: the finding is required to admit that rather than assert the device. */
{
  const d = single.find((r) => r.entity_id === 'L-ALONE')?.detail || '';
  check('…and says what is still reporting on the same feed, rather than asserting the device',
    /other vehicle/.test(d) && /still reporting/.test(d), d.slice(0, 120));
  check('…and calls one survivor thin evidence rather than proof',
    /thin evidence/.test(d), d.slice(0, 120));
}
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
/* Counted per FLEET, because the boundary block above seeded a second, real
   outage on egari — two feeds quiet at two different moments are two findings,
   and an assertion counting every row in the table would call that the
   duplication it is here to catch. What must not change on a re-run is the
   count for the fleet whose outage is still the same outage. */
const before = await q(
  `SELECT fleet_id, count(*)::int n FROM insight WHERE code = 'tracker_feed_dark'
    GROUP BY 1 ORDER BY 1`);
await computeInsights({});
const again = await q(
  `SELECT fleet_id, count(*)::int n FROM insight WHERE code = 'tracker_feed_dark'
    GROUP BY 1 ORDER BY 1`);
check('the ecosine outage is one finding, not two',
  again.find((r) => r.fleet_id === 'ecosine')?.n === 1,
  JSON.stringify(again));
check('…and a re-run adds nothing anywhere',
  JSON.stringify(before) === JSON.stringify(again),
  `${JSON.stringify(before)} → ${JSON.stringify(again)}`);

/* ── and the idle rule must not call those same cars powered ──────────────
   Production carried 78 idle_vehicle findings whose detail read "The tracker
   reported as recently as 2026-08-31 06:49, so the vehicle is present and
   powered" — and 59 of those plates are the CABMAN outage this file reports as
   tracker_feed_dark. One action list, two rules, opposite claims about the
   same cars on the same evidence. A car whose FEED stopped is not an idle car;
   it is an invisible one, and the finding that covers it already exists. */
console.log('\nthe idle rule leaves the dark ones to the feed finding');
{
  /* Seed the crowd fresh enough to pass the idle rule's 48h window but old
     enough to be a dead feed: 40 hours, nine plates, one hour, one source —
     and no trips at all, so idle_vehicle would otherwise take every one. */
  const idle = await q(
    `SELECT entity_id FROM insight WHERE code = 'idle_vehicle' ORDER BY entity_id`);
  const names = idle.map((r) => r.entity_id);
  check('no plate in the dark cluster is also reported as an idle vehicle',
    !names.some((p2) => String(p2).startsWith('L-TOGETHER')),
    JSON.stringify(names.slice(0, 12)));
  /* And the exclusion has to be surgical. L-LIVE reported twelve minutes ago
     and has never earned, which is exactly what an idle vehicle is — if the
     dark-feed guard swallowed it too, the rule would have been silenced
     rather than corrected. */
  check('a car reporting now and earning nothing is still an idle vehicle',
    names.includes('L-LIVE'), JSON.stringify(names.slice(0, 12)));
  /* And the sentence: a fix hours old must not license a claim about now. */
  const powered = await q(
    `SELECT entity_id, detail FROM insight WHERE code = 'idle_vehicle'
       AND detail LIKE '%present and powered%'`);
  const stale = [];
  for (const r of powered) {
    const [t] = await q(
      `SELECT max(captured_at) AS at FROM telemetry_snapshot WHERE plate = $1`, [r.entity_id]);
    if (t && (Date.now() - new Date(t.at)) / 36e5 > 6) stale.push(r.entity_id);
  }
  check('“present and powered” is claimed only from a fix under six hours old',
    stale.length === 0, JSON.stringify(stale.slice(0, 8)));
}

/* One integration, two fleets, one hour.
   ─────────────────────────────────────────────────────────────────────────
   CABMAN serves both fleets, so the ordinary shape of it failing is both
   fleets going dark at the same moment. entity_id was `${source}:${hour}` and
   put()'s arbiter is (code, entity_type, entity_id, window_start, window_end)
   with fleet_id in the SET list — so the second cluster did not become a
   second finding. It overwrote the first and flipped fleet_id to its own, and
   one fleet's outage left the board. The block above only caught it on the
   days the clock happened to put both clusters in the same hour, which is why
   this seeds the collision deliberately rather than waiting for it. */
console.log('\ntwo fleets dark on the same feed in the same hour are two findings');
{
  const at = new Date(Date.now() - 50 * H);
  at.setUTCMinutes(10, 0, 0);
  const seed = (fleet, i) => q(
    `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status)
     VALUES ('cabman', $1, $2, $3::timestamptz, $3::timestamptz, 25.2, 55.3, 0, 'Stopped')`,
    [fleet, `L-${fleet.toUpperCase()}-PAIR-${i}`, new Date(at.getTime() + i * 60000).toISOString()]);
  for (let i = 0; i < 6; i++) { await seed('ecosine', i); await seed('egari', i + 20); }
  await computeInsights({});
  const both = await q(
    `SELECT fleet_id, entity_id, metric FROM insight
      WHERE code = 'tracker_feed_dark' AND entity_id LIKE '%${at.toISOString().slice(0, 13)}%'
      ORDER BY fleet_id`);
  check('both fleets are reported, not just whichever was written last',
    both.length === 2 && both[0].fleet_id === 'ecosine' && both[1].fleet_id === 'egari',
    JSON.stringify(both));
  check('…and the key says which fleet, so neither can overwrite the other',
    both.every((r) => r.entity_id.includes(r.fleet_id)), JSON.stringify(both.map((r) => r.entity_id)));
}

/* And the case the old sentence got exactly backwards: a feed on which
   NOTHING is reporting. Below FEED_DARK_MIN there is no tracker_feed_dark
   finding to carry the news, so the per-vehicle findings are the only place it
   can be said — and each of them used to say "this is the vehicle rather than
   the feed" while the feed was the only thing it could be. */
console.log('\nand a feed with nothing left reporting is not four broken devices');
{
  for (let i = 0; i < 4; i++) {
    await q(`INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status)
             VALUES ('sixt', 'egari', $1, $2::timestamptz, $2::timestamptz, 25.2, 55.3, 0, 'Stopped')`,
    [`L-ALLDARK-${i}`, new Date(Date.now() - (60 + i * 3) * H).toISOString()]);
  }
  await computeInsights({});
  const dark = await q(
    `SELECT entity_id, detail, action FROM insight
      WHERE code = 'stale_tracker' AND entity_id LIKE 'L-ALLDARK%' ORDER BY entity_id`);
  check('all four are still reported — silence is not an answer either', dark.length === 4,
    String(dark.length));
  check('…and none of them claims to be the vehicle rather than the feed',
    dark.every((r) => /Every vehicle/.test(r.detail) && /more likely the integration/.test(r.detail)),
    dark[0]?.detail?.slice(0, 140));
  check('…and the action sends the operator to the integration first',
    dark.every((r) => /integration first/.test(r.action)), dark[0]?.action?.slice(0, 120));
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
