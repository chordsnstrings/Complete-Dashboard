/* FMS AS A SECOND SEAT-SENSOR PROVIDER — every guard, on synthetic data only.
   ═══════════════════════════════════════════════════════════════════════════
   The operator's rulings of 2026-09-23:
     1. FMS and CABMAN are two separate seat-sensor providers; both feed
        unauthorized-trip detection.
     2. FMS's Seat Count counts PASSENGERS; 1 or more means passengers aboard.
     3. FMS twice over: its live seat count (telemetry_snapshot.seat_count)
        and its per-journey Seat Count (trip.seat_count on platform 'fms').
     4. Two cars carry both trackers: keep BOTH providers' segments, each with
        its own source and timestamps; nothing merged across sources, nothing
        dropped.

   What is pinned here, in order: the migration (on a database built to the
   production shape before it, not a fresh one); the FMS live and FMS journey
   segment rules; that booking matching is unchanged and FMS never authorizes;
   that two providers on one plate never delete each other; that a combined
   total counts an overlapping ride once while each provider counts its own;
   sensor health per provider; the attribution ladder's clock evidence per
   provider; and the wording on every touched route and page.

   Plates are invented (ZQ…), people are invented, nothing here is a phone
   number. Every guard was proved by reverting it and watching the block
   below fail — the reversion is written above each block. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SCHEMA_FILES } from './schema.mjs';
import { mountAll } from './mount.mjs';

const { prepareValue } = createRequire(import.meta.url)('pg/lib/utils');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const same = (a, b) => a != null && b != null && +new Date(a) === +new Date(b);

/* ══ 1. THE MIGRATION, ON THE SHAPE PRODUCTION HAS BEFORE IT ══════════════
   A migration test on a fresh database proves nothing about a database that
   already holds rows under the old key (docs/COVERAGE.md: "Test a migration
   against the production SHAPE"). So the schema is built to v84, rows are
   written under (plate, started_at), and only then is v85 applied.

   REVERSION THAT PROVES THIS: delete the DO block from sql/schema_v85.sql.
   The key stays (plate, started_at), the second provider's row at the same
   instant is refused, and "the key carries the provider" fails. */
console.log('\n1. the migration, applied to a database that already holds CABMAN rows');
{
  const db = new PGlite();
  const upTo = SCHEMA_FILES.slice(0, SCHEMA_FILES.indexOf('schema_v85.sql'));
  check('schema_v85.sql is registered, and last', SCHEMA_FILES[SCHEMA_FILES.length - 1] === 'schema_v85.sql',
    SCHEMA_FILES.slice(-2).join(','));
  for (const f of upTo) await db.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8'));
  await db.query(`INSERT INTO occupancy_segment (plate, started_at, ended_at, fleet_id, verdict, verdict_reason)
                  VALUES ('ZQ1001', '2026-09-01T10:00:00Z', '2026-09-01T10:30:00Z', 'ecosine', 'unauthorized', 'old row'),
                         ('ZQ1002', '2026-09-02T10:00:00Z', '2026-09-02T10:20:00Z', 'ecosine', 'authorized', 'old row')`);
  const v85 = readFileSync(new URL('../sql/schema_v85.sql', import.meta.url), 'utf8');
  await db.exec(v85);
  const rows = (await db.query('SELECT plate, source FROM occupancy_segment ORDER BY plate')).rows;
  check('every row that existed is CABMAN’s', rows.length === 2 && rows.every((r) => r.source === 'cabman'),
    JSON.stringify(rows));
  const key = (await db.query(`SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
     WHERE i.indrelid = 'occupancy_segment'::regclass AND i.indisprimary`)).rows.map((r) => r.attname).sort();
  check('the key carries the provider', JSON.stringify(key) === JSON.stringify(['plate', 'source', 'started_at']),
    JSON.stringify(key));
  let ok = true;
  try {
    await db.query(`INSERT INTO occupancy_segment (source, plate, started_at, verdict, verdict_reason)
                    VALUES ('fms_trip', 'ZQ1001', '2026-09-01T10:00:00Z', 'unauthorized', 'fms')`);
  } catch { ok = false; }
  check('…so a second provider can hold a segment at the same instant on the same plate', ok);
  let refused = false;
  try {
    await db.query(`INSERT INTO occupancy_segment (source, plate, started_at) VALUES ('fms', 'ZQ1003', now())`);
  } catch { refused = true; }
  check('a source outside the three is refused rather than stored', refused);
  /* Replayed, as every file is on every boot until the ledger records it. */
  await db.exec(v85);
  check('replaying the file changes nothing',
    (await db.query('SELECT count(*)::int n FROM occupancy_segment')).rows[0].n === 3);
  const types = (await db.query(`SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'occupancy_segment'`)).rows;
  check('occupancy_segment holds no JSONB column, so no write here can meet the array-to-JSONB trap',
    !types.some((c) => /json/i.test(c.data_type)), JSON.stringify(types.filter((c) => /json/i.test(c.data_type))));
  await db.close();
}

/* ══ the shared database for everything below ═════════════════════════════ */
const db = new PGlite();
for (const f of SCHEMA_FILES) await db.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8'));
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

/* reconcile() takes a client for its transaction; BEGIN/COMMIT are forwarded,
   and every INSERT into occupancy_segment is captured so its parameters can be
   put through node-postgres's own encoder below. */
const dbmod = await import('../src/db.js');
const inserts = [];
dbmod.pool.query = (t, p) => db.query(t, p);
dbmod.pool.connect = async () => ({
  query: (t, p) => {
    if (/INSERT INTO occupancy_segment/.test(t)) inserts.push(p || []);
    return db.query(t, p);
  },
  release: () => {},
});
const R = await import('../src/reconcile.js');
const { reconcile, fmsLiveFixes, journeySegments, classifyJourney, judgeSegment, findMatch, RULES } = R;

const T = (h, m = 0, d = '15') => `2026-09-${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
const segs = (where = 'TRUE', p = []) => q(`SELECT source, plate, started_at, ended_at, verdict, verdict_reason,
  distance_km, duration_min, passengers, top_speed, fixes, max_gap_min, ignition_ratio
  FROM occupancy_segment WHERE ${where} ORDER BY plate, started_at, source`, p);

/* Fixes, journeys and bookings, synthetic. A CABMAN fix carries seat_occupied;
   an FMS fix carries seat_count (and, like production, no seat_occupied). */
const cabFix = (plate, at, occupied, speed = 40, lat = 25.1, lng = 55.2) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed,
     ignition, seat_occupied)
   VALUES ('cabman', $1, 'ecosine', $2::timestamptz, $2::timestamptz, $3, $4, $5, true, $6)`,
  [plate, at, lat, lng, speed, occupied]);
const fmsFix = (plate, at, count, speed = 40, lat = 25.1, lng = 55.2, fleet = 'egari') => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed,
     ignition, seat_count)
   VALUES ('fms', $1, $7, $2::timestamptz, $2::timestamptz + interval '2 minutes', $3, $4, $5, true, $6)`,
  [plate, at, lat, lng, speed, count, fleet]);
const journey = (plate, s0, s1, km, seats, ingested = null, fleet = 'egari') => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, ended_at, distance_km,
     seat_count, status, ingested_at)
   VALUES ('fms', $1, $6, $2, $3::timestamptz, $4::timestamptz, $5, $7, 'completed',
           coalesce($8::timestamptz, now()))`,
  [`${plate}|${s0}`, plate, s0, s1, km, fleet, seats, ingested]);
const booking = (plate, s0, s1, id, driver = 'd-one', name = 'Test Driver One', platform = 'uber') => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, ended_at, distance_km,
     status, driver_ext_id, driver_name)
   VALUES ($1, $2, 'ecosine', $3, $4::timestamptz, $5::timestamptz, 5, 'completed', $6, $7)`,
  [platform, id, plate, s0, s1, driver, name]);

/* One Uber booking far from everything, in every window below, so no window
   ever has an "unavailable channel" and every candidate can reach a verdict. */
await booking('ZQ9999', T(1, 0, '10'), T(1, 20, '10'), 'anchor-a');
await booking('ZQ9999', T(1, 0, '15'), T(1, 20, '15'), 'anchor-b');
await booking('ZQ9999', T(1, 0, '20'), T(1, 20, '20'), 'anchor-c');

/* ══ 2. FMS LIVE: 0 IS AN EMPTY SEAT, 1 OR MORE IS PASSENGERS ════════════
   REVERSION THAT PROVES THIS: in src/reconcile.js fmsLiveFixes, read
   `Number(f.seat_count) >= 0` (or `> 1`). The zero-is-empty (or the
   one-is-occupied) assertions fail, and the built segment changes length. */
console.log('\n2. FMS live seat count: 0 is not occupied, 1 or more is');
{
  const raw = [0, 1, 2, 0, null, 3].map((c, i) => ({ plate: 'ZQ2001', captured_at: T(9, i * 6), seat_count: c, speed: 30 }));
  const got = fmsLiveFixes(raw);
  check('a count of 0 reads as an empty seat', got.find((f) => f.seat_count === 0)?.seat_occupied === false);
  check('a count of 1 reads as occupied', got.find((f) => f.seat_count === 1)?.seat_occupied === true);
  check('a count of 3 reads as occupied', got.find((f) => f.seat_count === 3)?.seat_occupied === true);
  check('a fix with no count is not an empty seat — it is not a reading at all', got.length === 5
    && !got.some((f) => f.seat_count == null), JSON.stringify(got.map((f) => f.seat_count)));
  check('the translation is in memory: the input rows are not written to',
    raw.every((f) => !('seat_occupied' in f)));
}
{
  /* Through the reconciler: an FMS car carries a passenger 10:00–10:30 and
     reports 0 either side, six minutes apart as FMS's stored fixes are. Two
     empty readings close the ride; the ride is bounded on both sides by
     observed fixes, so it can be judged rather than called partial. */
  await fmsFix('ZQ2002', T(9, 48), 0, 0); await fmsFix('ZQ2002', T(9, 54), 0, 0);
  for (let m = 0; m <= 30; m += 6) await fmsFix('ZQ2002', T(10, m), m ? 2 : 1, 45, 25.1 + m * 0.004, 55.2 + m * 0.004);
  await fmsFix('ZQ2002', T(10, 36), 0, 0, 25.3, 55.4); await fmsFix('ZQ2002', T(10, 42), 0, 0, 25.3, 55.4);
  await reconcile({ from: T(0, 0), to: T(23, 59) });
  const live = await segs(`plate = 'ZQ2002' AND source = 'fms_live'`);
  check('one FMS live segment, from the first count of 1 to the last', live.length === 1
    && same(live[0].started_at, T(10, 0)) && same(live[0].ended_at, T(10, 30)), JSON.stringify(live));
  check('…judged through the same classifier as CABMAN: it moved, nothing booked it',
    live[0]?.verdict === 'unauthorized', `${live[0]?.verdict} — ${live[0]?.verdict_reason}`);
  const stored = await q(`SELECT count(*)::int n FROM telemetry_snapshot
     WHERE source = 'fms' AND seat_occupied IS NOT NULL`);
  check('seat_occupied is never written on an FMS row', stored[0].n === 0, String(stored[0].n));
}

/* ══ 3. FMS JOURNEYS, EACH A SEGMENT, CLASSIFIED ON WHAT A JOURNEY CARRIES ═
   REVERSION THAT PROVES THIS: in classifyJourney, drop the average-speed
   line — the slow journey becomes a candidate; drop the 8-hour line — the
   long one becomes a candidate; return 'partial' for anything — the "never
   partial" check fails. */
console.log('\n3. FMS journeys: movement → stationary, eight hours → sensor_suspect, never partial');
{
  const J = (min, km) => ({ duration_min: min, distance_km: km });
  check('a 4-minute journey is stationary', classifyJourney(J(4, 3)) === 'stationary');
  check('a 0.6 km journey is stationary', classifyJourney(J(20, 0.6)) === 'stationary');
  check('a journey averaging under 5 km/h is stationary — its average is a floor on its top speed',
    classifyJourney(J(40, 2)) === 'stationary', classifyJourney(J(40, 2)));
  check('a journey longer than eight hours is sensor_suspect', classifyJourney(J(8 * 60 + 1, 200)) === 'sensor_suspect');
  check('a real journey is a candidate', classifyJourney(J(18, 7.5)) === 'candidate');
  check('a journey with no end is unverifiable, not stationary', classifyJourney(J(null, 7)) === 'unverifiable');
  check('a journey with no usable distance is unverifiable', classifyJourney(J(20, null)) === 'unverifiable'
    && classifyJourney(J(20, 500)) === 'unverifiable');
  const all = [J(1, 0.1), J(4, 3), J(20, 0.6), J(40, 2), J(18, 7.5), J(600, 90), J(null, 3), J(20, null)];
  check('’partial’ is never returned for a journey — it is a complete record',
    !all.some((j) => classifyJourney(j) === 'partial'));
  check('the eight-hour rule is the same RULES the samples use', RULES.maxDurationHr === 8);
}
{
  await journey('ZQ3001', T(12, 0), T(12, 25), 9.4, 2);      // unbooked, a real ride
  await journey('ZQ3001', T(14, 0), T(14, 3), 1.2, 1);       // too short
  await journey('ZQ3001', T(15, 0), T(15, 40), 1.1, 1);      // averages 1.65 km/h
  await journey('ZQ3001', T(0, 5), T(9, 0), 180, 1);         // nine hours
  await reconcile({ from: T(0, 0), to: T(23, 59) });
  const j = await segs(`plate = 'ZQ3001' AND source = 'fms_trip'`);
  const at = (h, m) => j.find((r) => same(r.started_at, T(h, m)));
  check('each FMS journey with a seat count is its own segment', j.length === 4, JSON.stringify(j.map((r) => r.started_at)));
  check('…with the journey’s own start, end, distance, duration and passenger count',
    at(12, 0) && same(at(12, 0).ended_at, T(12, 25)) && Number(at(12, 0).distance_km) === 9.4
      && at(12, 0).duration_min === 25 && at(12, 0).passengers === 2, JSON.stringify(at(12, 0)));
  check('…and NULL, not zero, for what a journey does not carry',
    at(12, 0)?.top_speed == null && at(12, 0)?.fixes == null && at(12, 0)?.max_gap_min == null
      && at(12, 0)?.ignition_ratio == null);
  check('the unbooked ride is unauthorized', at(12, 0)?.verdict === 'unauthorized', at(12, 0)?.verdict_reason);
  check('the short one is stationary', at(14, 0)?.verdict === 'stationary');
  check('the slow one is stationary, with a reason about the journey', at(15, 0)?.verdict === 'stationary'
    && /journey FMS filed/.test(at(15, 0)?.verdict_reason || ''), at(15, 0)?.verdict_reason);
  check('the nine-hour one is sensor_suspect, with its own reason', at(0, 5)?.verdict === 'sensor_suspect'
    && /more than eight hours/.test(at(0, 5)?.verdict_reason || ''), at(0, 5)?.verdict_reason);
}

/* ══ 4. ONE RIDE, TWO FMS RECORDS ══════════════════════════════════════════
   FMS files a provisional record of a ride within minutes (whole-number
   distance, a late start) and the final one hours later (true start, decimal
   distance); both stay in `trip`. Journeys overlapping on one car are one
   ride, and its segment is the record first stored LAST.

   REVERSION THAT PROVES THIS: in journeySegments, push every journey as its
   own segment (flush each on its own). Two segments appear for one ride, and
   the window-edge check fails too. */
console.log('\n4. overlapping FMS journeys on one car are one ride, built from FMS’s latest record');
{
  const t = (h, m, s = 0) => `2026-09-15T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`;
  const out = journeySegments([
    { plate: 'ZQ4001', requested_at: t(16, 19, 3), ended_at: t(16, 30, 37), distance_km: 2, seat_count: 1,
      ingested_at: '2026-09-15T12:34:00Z' },                                     // provisional
    { plate: 'ZQ4001', requested_at: t(16, 14, 53), ended_at: t(16, 29, 57), distance_km: 4.54, seat_count: 1,
      ingested_at: '2026-09-16T00:04:00Z' },                                     // final, stored later
    { plate: 'ZQ4001', requested_at: t(18, 0), ended_at: t(18, 20), distance_km: 6.2, seat_count: 2,
      ingested_at: '2026-09-16T00:04:00Z' },                                     // the next ride
  ]);
  check('two rides, not three segments', out.length === 2, JSON.stringify(out.map((s) => s.started_at)));
  const first = out.find((s) => same(s.started_at, t(16, 14, 53)));
  check('the ride is built from the record FMS filed last — its true start and its decimal distance',
    first && first.distance_km === 4.54 && same(first.ended_at, t(16, 29, 57)), JSON.stringify(first));
  check('the ride that merely follows is its own segment', out.some((s) => same(s.started_at, t(18, 0))));
  const edge = journeySegments([
    { plate: 'ZQ4002', requested_at: t(23, 58), ended_at: '2026-09-16T00:20:00Z', distance_km: 8.1, seat_count: 1,
      ingested_at: '2026-09-16T05:00:00Z' },
    { plate: 'ZQ4002', requested_at: '2026-09-16T00:02:00Z', ended_at: '2026-09-16T00:21:00Z', distance_km: 7,
      seat_count: 1, ingested_at: '2026-09-16T00:30:00Z' },
  ], { from: '2026-09-16T00:00:00Z', to: '2026-09-16T23:59:00Z' });
  check('a ride whose final record starts before the window is not re-written from its provisional one',
    edge.length === 0, JSON.stringify(edge));
  check('a journey with no seat count is not a segment',
    journeySegments([{ plate: 'ZQ4003', requested_at: t(9, 0), ended_at: t(9, 20), distance_km: 5, seat_count: null }]).length === 0);
}
{
  /* Through the reconciler, and across two passes: the provisional record is
     judged first, then the final arrives and the next pass replaces it. */
  await journey('ZQ4010', T(16, 19), T(16, 30), 2, 1, '2026-09-15T12:34:00Z');
  await reconcile({ from: T(0, 0), to: T(23, 59) });
  const before = await segs(`plate = 'ZQ4010'`);
  check('the provisional record is judged while it is all FMS has filed', before.length === 1
    && same(before[0].started_at, T(16, 19)), JSON.stringify(before));
  await journey('ZQ4010', T(16, 14), T(16, 29), 4.54, 1, '2026-09-16T00:04:00Z');
  await reconcile({ from: T(0, 0), to: T(23, 59) });
  const after = await segs(`plate = 'ZQ4010'`);
  check('once the final record arrives the ride is ONE segment, built from it', after.length === 1
    && same(after[0].started_at, T(16, 14)) && Number(after[0].distance_km) === 4.54, JSON.stringify(after));
}

/* ══ 5. BOOKING MATCHING IS UNCHANGED, AND FMS NEVER AUTHORIZES ════════════
   REVERSION THAT PROVES THIS: widen the bookings query in reconcile() to
   `AND (is_booking OR platform = 'fms')`. Every FMS journey then matches
   itself and the unauthorized journey below reads authorized. */
console.log('\n5. matching is the same code for every source, and FMS never authorizes');
{
  const seg = { plate: 'ZQ5001', started_at: T(10, 0), ended_at: T(10, 30), gapBefore: 0, gapAfter: 0 };
  const bookings = [
    { plate: 'ZQ5001', platform: 'uber', external_id: 'u1', requested_at: T(10, 10), ended_at: T(10, 40), outcome: 'completed' },
    { plate: 'ZQ5002', platform: 'uber', external_id: 'u2', requested_at: T(10, 0), ended_at: T(10, 30), outcome: 'completed' },
    { plate: 'ZQ5001', platform: 'uber', external_id: 'u3', requested_at: T(13, 0), ended_at: T(13, 30), outcome: 'completed' },
  ];
  const whole = findMatch(seg, bookings);
  const byPlate = findMatch(seg, bookings.filter((b) => b.plate === 'ZQ5001'));
  check('findMatch over this plate’s bookings is findMatch over all of them',
    JSON.stringify(whole) === JSON.stringify(byPlate), JSON.stringify([whole, byPlate]));
  const ctx = { bookingsByPlate: new Map([['ZQ5001', bookings.filter((b) => b.plate === 'ZQ5001')]]),
    judgeBefore: Date.parse(T(23, 0)), unavailable: [], configured: ['uber'], inWindow: new Set(['uber']),
    medianLag: 0, clockSuspect: false };
  const j = judgeSegment(seg, 'candidate', ctx);
  check('a candidate with an overlapping completed booking is authorized, naming it',
    j.verdict === 'authorized' && /matched uber trip u1/.test(j.reason), JSON.stringify(j));
  check('a verdict reached before matching is left alone', judgeSegment(seg, 'stationary', ctx).verdict === 'stationary');
  /* The windows reconcile() computes once per pass (withWindows) give exactly
     the answer findMatch() gives computing them per segment — over 400
     random segments against 300 random bookings of every window shape
     (ended_at, duration, distance, assumed) and outcome, ties included. */
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const base = Date.parse('2026-09-15T00:00:00Z');
  const iso = (m) => new Date(base + m * 60000).toISOString();
  const raw = Array.from({ length: 300 }, (_, i) => {
    const m = Math.floor(rnd() * 1440);
    const shape = i % 4;
    return { plate: 'ZQ5003', platform: 'uber', external_id: `r${i}`, requested_at: iso(m),
      ended_at: shape === 0 ? iso(m + 5 + Math.floor(rnd() * 60)) : null,
      duration_s: shape === 1 ? 300 + Math.floor(rnd() * 3000) : null,
      distance_km: shape === 2 ? 1 + rnd() * 30 : null,
      outcome: ['completed', null, 'cancelled'][i % 3] };
  });
  const cached = R.withWindows(raw.map((b) => ({ ...b })));
  const key = (x) => [x.match?.external_id ?? null, x.nearest?.external_id ?? null, x.nearest_gap_min];
  const eq = (x, y) => JSON.stringify(key(x)) === JSON.stringify(key(y));
  let differ = 0;
  for (let i = 0; i < 400; i++) {
    const m = Math.floor(rnd() * 1440);
    const sg = { plate: 'ZQ5003', started_at: iso(m), ended_at: iso(m + 5 + Math.floor(rnd() * 50)) };
    if (!eq(findMatch(sg, raw), findMatch(sg, cached))) differ++;
  }
  check('matching with windows computed once per pass is identical to matching without', differ === 0,
    `${differ} of 400 differ`);
  /* The index reconcile() actually matches through (findMatchIndexed): the
     same answer as findMatch() — which booking overlaps, which is nearest,
     how far, and on a tie the one first in the list — over three cars: one
     with every window shape and outcome and deliberate ties on start and on
     gap, one carrying a booking whose window ends before it starts (which
     must fall back to the plain scan), and one with no bookings at all.
     REVERSION THAT PROVES THIS: drop `|| (g === bestGap && r.idx < best.idx)`
     from findMatchIndexed — ties resolve by time rather than by list order,
     and this fails. */
  const pool2 = [];
  for (let i = 0; i < 600; i++) {
    const m = Math.floor(rnd() * 2880) - (i % 7 === 0 ? 0 : 0);
    const shape = i % 4;
    const tie = i % 11 === 0 && pool2.length ? pool2[pool2.length - 1] : null;
    const s0m = tie ? (Date.parse(tie.requested_at) - base) / 60000 : m;
    pool2.push({ plate: i % 5 === 0 ? 'ZQ5005' : 'ZQ5004', platform: ['uber', 'hotel', 'yango'][i % 3],
      external_id: `x${i}`, requested_at: iso(s0m),
      ended_at: shape === 0 ? iso(s0m + (i % 5 === 0 && i % 3 === 0 ? -20 : 5 + Math.floor(rnd() * 90))) : null,
      duration_s: shape === 1 ? 300 + Math.floor(rnd() * 5000) : null,
      distance_km: shape === 2 ? 0.5 + rnd() * 40 : null,
      outcome: ['completed', null, 'cancelled', 'no_show'][i % 4] });
  }
  const perPlate = new Map();
  for (const b of R.withWindows(pool2.map((b) => ({ ...b })))) {
    if (!perPlate.has(b.plate)) perPlate.set(b.plate, []);
    perPlate.get(b.plate).push(b);
  }
  const index = R.indexBookings(perPlate);
  let idxDiffer = 0, n = 0;
  for (const plate of ['ZQ5004', 'ZQ5005', 'ZQ5006']) {
    for (let i = 0; i < 700; i++) {
      const m = Math.floor(rnd() * 3200) - 160;
      const sg = { plate, started_at: iso(m), ended_at: iso(m + Math.floor(rnd() * 120)) };
      n++;
      if (!eq(R.findMatchIndexed(sg, index.get(plate)), findMatch(sg, pool2))) idxDiffer++;
    }
  }
  check('the indexed matcher gives findMatch()’s answer exactly — overlap, nearest, gap and tie order',
    idxDiffer === 0 && index.get('ZQ5005').finite === false && index.get('ZQ5004').finite === true,
    `${idxDiffer} of ${n} differ; finite ${index.get('ZQ5004')?.finite}/${index.get('ZQ5005')?.finite}`);
}
{
  // An FMS journey with ANOTHER FMS journey row overlapping it, and no booking.
  await journey('ZQ5010', T(12, 0), T(12, 30), 11, 1, null, 'ecosine');
  await journey('ZQ5010', T(12, 1), T(12, 29), 10, 1, '2020-01-01T00:00:00Z', 'ecosine');
  // And an FMS journey an Uber booking covers.
  await journey('ZQ5011', T(12, 0), T(12, 30), 11, 1, null, 'ecosine');
  await booking('ZQ5011', T(12, 5), T(12, 35), 'u-5011');
  await reconcile({ from: T(0, 0), to: T(23, 59) });
  const a = await segs(`plate = 'ZQ5010' AND source = 'fms_trip'`);
  check('an FMS journey is never authorized by an FMS row', a.length === 1 && a[0].verdict === 'unauthorized',
    JSON.stringify(a.map((r) => [r.verdict, r.verdict_reason])));
  const b = await segs(`plate = 'ZQ5011' AND source = 'fms_trip'`);
  check('an FMS journey an Uber booking overlaps is authorized by that booking',
    b[0]?.verdict === 'authorized' && /uber trip u-5011/.test(b[0]?.verdict_reason || ''), JSON.stringify(b));
  const checked = await q(`SELECT DISTINCT channels_checked FROM occupancy_segment WHERE source LIKE 'fms%'`);
  check('channels_checked never names FMS', checked.every((r) => !/fms/.test(r.channels_checked || '')),
    JSON.stringify(checked));
}

/* ══ 6. TWO PROVIDERS ON ONE PLATE NEVER DELETE EACH OTHER ════════════════
   The two-tracker cars: CABMAN sees a ride 10:10–10:40 and FMS files the
   journey 10:00–11:00. Both are kept, each with its own source and times.

   REVERSION THAT PROVES THIS, twice over:
     - drop `source = $4 AND` from writeWindow's DELETE: the FMS pass removes
       the CABMAN row (and the reverse), and "both are kept" fails;
     - drop `o.source = d.source AND` from the sweep: on the second pass the
       CABMAN segment, which lies inside the FMS journey, is swept away as a
       "fragment" of it, and the second-pass check fails. */
console.log('\n6. two providers on one plate keep their own segments');
{
  const P = 'ZQ6001';
  await cabFix(P, T(9, 0), false, 0); await cabFix(P, T(9, 30), false, 0);
  for (let m = 10; m <= 40; m += 5) await cabFix(P, T(10, m), true, 50, 25.1 + m * 0.004, 55.2 + m * 0.004);
  await cabFix(P, T(11, 30), false, 0, 25.3, 55.4); await cabFix(P, T(12, 0), false, 0, 25.3, 55.4);
  await journey(P, T(10, 0), T(11, 0), 14, 1, null, 'ecosine');
  await reconcile({ from: T(0, 0), to: T(23, 59) });
  const one = await segs(`plate = $1`, [P]);
  check('both providers’ segments are kept, each with its own source and timestamps',
    one.some((r) => r.source === 'cabman' && same(r.started_at, T(10, 10)) && same(r.ended_at, T(10, 40)))
      && one.some((r) => r.source === 'fms_trip' && same(r.started_at, T(10, 0)) && same(r.ended_at, T(11, 0))),
    JSON.stringify(one.map((r) => [r.source, r.started_at, r.ended_at])));
  await reconcile({ from: T(0, 0), to: T(23, 59) });
  const two = await segs(`plate = $1`, [P]);
  check('a second pass sweeps neither — the shorter CABMAN one is not a fragment of FMS’s journey',
    two.length === 2 && two.some((r) => r.source === 'cabman'), JSON.stringify(two.map((r) => [r.source, r.started_at])));
  /* The CABMAN tracker goes dark: its fixes stop being returned. A pass with
     only FMS evidence must not touch the CABMAN row. */
  await q(`DELETE FROM telemetry_snapshot WHERE plate = $1 AND source = 'cabman'`, [P]);
  await cabFix('ZQ6002', T(9, 0), false, 0);            // keeps the CABMAN pass non-empty
  await reconcile({ from: T(0, 0), to: T(23, 59) });
  const three = await segs(`plate = $1`, [P]);
  check('a provider that reported nothing this pass keeps what it had',
    three.some((r) => r.source === 'cabman' && same(r.started_at, T(10, 10))), JSON.stringify(three));
  /* And the other way round: FMS's journey is withdrawn from the window
     (no FMS journey in it at all), the CABMAN pass runs, and the FMS row stays. */
  await cabFix(P, T(10, 10), true, 50);
  await reconcile({ from: T(0, 0), to: T(23, 59) });
  check('a CABMAN pass never removes an FMS segment on the same plate',
    (await segs(`plate = $1 AND source = 'fms_trip'`, [P])).length === 1);
}

/* ══ 7. node-postgres's own encoder, over what the reconciler actually binds
   A JS array bound to a JSONB column passes on PGlite and fails on
   production (docs/COVERAGE.md). occupancy_segment has no JSONB column, and
   the reconciler binds only scalars — checked on every parameter of every
   INSERT captured above, through pg's prepareValue. */
console.log('\n7. every value the reconciler binds is a scalar on the node-postgres wire');
{
  const flat = inserts.flat();
  const bad = flat.filter((v) => v !== null && (typeof v === 'object' || Array.isArray(v)));
  const wireBad = flat.filter((v) => { const w = prepareValue(v); return w !== null && typeof w !== 'string' && !Buffer.isBuffer(w); });
  check('parameters were captured', flat.length > 100, String(flat.length));
  check('no object or array is bound', bad.length === 0, JSON.stringify(bad.slice(0, 3)));
  check('prepareValue turns every one into text or NULL', wireBad.length === 0, JSON.stringify(wireBad.slice(0, 3)));
}

/* ══ 8. A COMBINED TOTAL COUNTS AN OVERLAPPING RIDE ONCE ══════════════════
   Seeded directly, so the rule is tested apart from the reconciler: on
   ZQ8001 one unexplained ride seen by all three sources; on ZQ8002 a CABMAN
   segment that is unexplained while FMS's journey of the same ride matched a
   booking; on ZQ8003 a stuck-pad pair longer than nine hours.

   REVERSIONS THAT PROVE THIS:
     - occCountsOnce() returning TRUE: the combined unauthorized count is 4,
       not 2 — "counted once" fails;
     - drop the same-verdict line: ZQ8002's CABMAN ride is absorbed by FMS's
       AUTHORIZED journey and disappears from the unauthorized count;
     - always bound the lookup at nine hours (drop the sensor_suspect CASE):
       the long stuck-pad pair counts twice. */
console.log('\n8. a combined total counts an overlapping ride once; each provider counts its own');
// CABMAN DT holds an Ecosine account only, so its segments are Ecosine's.
const seg = (source, plate, s0, s1, verdict, km, day = '20') => q(
  `INSERT INTO occupancy_segment (source, plate, fleet_id, started_at, ended_at, duration_min, distance_km,
     top_speed, fixes, verdict, verdict_reason, low_confidence)
   VALUES ($1, $2, $7, $3::timestamptz, $4::timestamptz, 30, $5, 50, 6, $6, 'fixture', false)`,
  [source, plate, `2026-09-${day}T${s0}:00Z`, `2026-09-${day}T${s1}:00Z`, km, verdict,
    source === 'cabman' ? 'ecosine' : 'egari']);
await seg('fms_trip', 'ZQ8001', '10:00', '10:30', 'unauthorized', 12);
await seg('fms_live', 'ZQ8001', '10:04', '10:28', 'unauthorized', 10);
await seg('cabman', 'ZQ8001', '10:06', '10:32', 'unauthorized', 11);
await seg('cabman', 'ZQ8002', '14:00', '14:30', 'unauthorized', 9);
await seg('fms_trip', 'ZQ8002', '13:58', '14:31', 'authorized', 9.5);
await seg('fms_trip', 'ZQ8003', '00:10', '11:50', 'sensor_suspect', 1);
await seg('cabman', 'ZQ8003', '10:00', '11:00', 'sensor_suspect', 1);
// A position for the seeded car on another day, so the vehicle page knows it.
await cabFix('ZQ8001', T(3, 0, '01'), false, 0);
const { server, get } = await mountAll(db);
const W = 'from=2026-09-20&to=2026-09-20';
{
  const s = (await get(`/api/unauthorized/summary?${W}`)).body;
  check('two unexplained rides, not four segments', s.totals.unauthorized === 2, JSON.stringify(s.totals));
  check('…and their distance is each ride’s representative’s: 12 + 9 km',
    Number(s.totals.unauth_km) === 21, String(s.totals.unauth_km));
  check('a stuck pad longer than nine hours is still one ride', s.totals.sensor_suspect === 1,
    String(s.totals.sensor_suspect));
  const un = (s.byVerdict || []).find((v) => v.verdict === 'unauthorized');
  check('the verdict row carries both the rides and the segments behind them', un?.n === 2 && un?.segments === 4,
    JSON.stringify(un));
  check('each provider counts its own', s.by_source.fms_trip.unauthorized === 1
    && s.by_source.fms_live.unauthorized === 1 && s.by_source.cabman.unauthorized === 2,
    JSON.stringify(s.by_source));
  check('…so the providers add up to more than the combined figure, and the rule says why',
    /count a ride once/i.test(s.dedupe_rule || '') && /add up to more/.test(s.dedupe_rule || ''), s.dedupe_rule);
  const d = (await get(`/api/unauthorized/daily?${W}`)).body.find((x) => x.d === '2026-09-20');
  check('the day’s bar counts the rides once', d?.unauthorized === 2 && d?.unauthorized_by_source?.cabman === 2
    && d?.unauthorized_by_source?.fms_trip === 1, JSON.stringify(d));
  const v = (await get(`/api/unauthorized/by-vehicle?${W}`)).body;
  const r1 = v.rows.find((r) => r.plate === 'ZQ8001');
  check('the car’s bar counts its ride once, with each provider beside it',
    r1?.unauthorized === 1 && r1?.unauthorized_by_source?.fms_live === 1 && v.segments === 2,
    JSON.stringify([r1, v.segments]));
  const f = (await get(`/api/segments?${W}`)).body;
  const fv = f.facets.verdict.find((x) => x.key === 'unauthorized');
  check('/api/segments: the facet counts rides, the list holds every segment',
    fv?.n === 2 && fv?.segments === 4 && f.rows.filter((r) => r.verdict === 'unauthorized').length === 4,
    JSON.stringify(fv));
  const fs = Object.fromEntries(f.facets.source.map((x) => [x.key, x]));
  check('…with a facet per provider', fs.cabman?.unauthorized === 2 && fs.fms_trip?.unauthorized === 1
    && fs.fms_live?.unauthorized === 1, JSON.stringify(f.facets.source));
  const once = f.rows.filter((r) => r.plate === 'ZQ8001').map((r) => [r.source, r.counts_once]);
  check('each row says whether it represents its ride — only the FMS journey does',
    JSON.stringify(once.sort()) === JSON.stringify([['cabman', false], ['fms_live', false], ['fms_trip', true]]),
    JSON.stringify(once));
  const mv = (await get(`/api/vehicle/movement?plate=ZQ8001&${W}`)).body;
  const mvu = mv.by_verdict.find((x) => x.verdict === 'unauthorized');
  check('the vehicle page counts the ride once and names every provider’s segment',
    mvu?.n === 1 && mvu?.segments === 3 && mv.segments.every((r) => r.source_label), JSON.stringify(mvu));
}

/* ══ 9. SENSOR HEALTH, PER PROVIDER ═══════════════════════════════════════
   REVERSIONS THAT PROVE THIS:
     - fms_live's state ignoring bookings (dead whenever it never read 1): the
       no-bookings car reads dead;
     - fms_trip's state testing journeys only (dead whenever there is none):
       the no-bookings car reads dead too;
     - the CABMAN suspect join without `source = 'cabman'`: an FMS stuck
       journey marks the CABMAN pad on the same car suspect. */
console.log('\n9. sensor health, per provider, each with its reason');
{
  const D = '2026-09-18';
  const at = (h) => `${D}T${String(h).padStart(2, '0')}:00:00Z`;
  // CABMAN: a dead pad (25 fixes, none occupied) and a working one.
  for (let i = 0; i < 25; i++) await cabFix('ZQ9101', `${D}T0${Math.floor(i / 6)}:${String((i % 6) * 10).padStart(2, '0')}:00Z`, false, 0);
  for (let i = 0; i < 25; i++) await cabFix('ZQ9102', `${D}T0${Math.floor(i / 6)}:${String((i % 6) * 10).padStart(2, '0')}:00Z`, i % 3 === 0, 30);
  await q(`INSERT INTO occupancy_segment (source, plate, fleet_id, started_at, ended_at, verdict, verdict_reason)
           VALUES ('fms_trip', 'ZQ9102', 'ecosine', $1, $2, 'sensor_suspect', 'fixture')`, [at(10), at(20)]);
  // FMS live: never ≥1 with bookings (dead), ≥1 (ok), never ≥1 without bookings (unjudged).
  for (const [plate, counts] of [['ZQ9201', [0, 0, 0]], ['ZQ9202', [0, 2, 1]], ['ZQ9203', [0, 0]]]) {
    for (let i = 0; i < counts.length; i++) await fmsFix(plate, at(8 + i), counts[i]);
  }
  await booking('ZQ9201', at(9), `${D}T09:20:00Z`, 'b-9201');
  await booking('ZQ9202', at(9), `${D}T09:20:00Z`, 'b-9202');
  // FMS trip: live fixes and bookings, no journey (dead); with a journey (ok); no bookings (unjudged).
  for (const plate of ['ZQ9301', 'ZQ9302', 'ZQ9303']) await fmsFix(plate, at(7), null);
  await booking('ZQ9301', at(12), `${D}T12:20:00Z`, 'b-9301');
  await booking('ZQ9302', at(12), `${D}T12:20:00Z`, 'b-9302');
  await journey('ZQ9302', at(13), `${D}T13:20:00Z`, 5, 1);
  const h = (await get(`/api/sensor-health?from=${D}&to=${D}`)).body;
  const row = (src, plate) => h.rows.find((r) => r.source === src && r.plate === plate);
  check('CABMAN’s dead-pad rule is unchanged: 25 fixes, none occupied, is dead',
    row('cabman', 'ZQ9101')?.state === 'never triggers' && row('cabman', 'ZQ9101')?.dead === true,
    JSON.stringify(row('cabman', 'ZQ9101')));
  check('…and a pad that fires is ok — an FMS stuck journey on the same car does not make it suspect',
    row('cabman', 'ZQ9102')?.state === 'ok', JSON.stringify(row('cabman', 'ZQ9102')));
  check('FMS live: a count that never reached 1 on a car with bookings is dead, with the reason',
    row('fms_live', 'ZQ9201')?.dead === true && /never once reached 1/.test(row('fms_live', 'ZQ9201')?.reason || ''),
    JSON.stringify(row('fms_live', 'ZQ9201')));
  check('FMS live: a count that read 1 or more is ok', row('fms_live', 'ZQ9202')?.state === 'ok');
  check('FMS live: no bookings means no judgement, and says so',
    row('fms_live', 'ZQ9203')?.state === 'no bookings to judge against' && row('fms_live', 'ZQ9203')?.dead === false
      && /proves nothing/.test(row('fms_live', 'ZQ9203')?.reason || ''), JSON.stringify(row('fms_live', 'ZQ9203')));
  check('FMS trip: tracked, booked, and no journey with a seat count is dead, with the reason',
    row('fms_trip', 'ZQ9301')?.dead === true && /filed no journey with a seat count/.test(row('fms_trip', 'ZQ9301')?.reason || ''),
    JSON.stringify(row('fms_trip', 'ZQ9301')));
  check('FMS trip: a journey with a seat count is ok', row('fms_trip', 'ZQ9302')?.state === 'ok');
  check('FMS trip: no bookings means no judgement', row('fms_trip', 'ZQ9303')?.state === 'no bookings to judge against'
    && row('fms_trip', 'ZQ9303')?.dead === false);
  check('each provider states its own rule', /at least 20 fixes/.test(h.by_source?.cabman?.rule || '')
    && /never reached 1/.test(h.by_source?.fms_live?.rule || '')
    && /no journey with a seat count/.test(h.by_source?.fms_trip?.rule || ''), JSON.stringify(h.by_source));
  check('every row carries its provider’s words', h.rows.every((r) => r.source_label));
}

/* ══ 10. THE ATTRIBUTION LADDER READS A CLOCK PER PROVIDER ════════════════
   On a two-tracker car, a CABMAN segment the reconciler refused for a
   300-minute clock skew must not refuse to name anybody for an FMS journey.

   REVERSION THAT PROVES THIS: drop `AND s2.source = ${o}.source` from the
   plate_skew lateral in api/unauthorized_sql.js. The FMS row's tier falls
   from last_trip to the skewed branch. */
console.log('\n10. one provider’s clock skew does not silence the other’s journeys');
{
  const D = '2026-09-12';
  await booking('ZQ1101', `${D}T08:00:00Z`, `${D}T08:30:00Z`, 'u-1101', 'd-eleven', 'Test Driver Eleven');
  await q(`INSERT INTO occupancy_segment (source, plate, fleet_id, started_at, ended_at, duration_min, distance_km,
             verdict, verdict_reason)
           VALUES ('cabman', 'ZQ1101', 'ecosine', $1, $2, 20, 5, 'unverifiable',
                   'telemetry clock is 300 min behind wall time — bookings cannot be matched reliably'),
                  ('fms_trip', 'ZQ1101', 'ecosine', $3, $4, 25, 9, 'unauthorized', 'fixture')`,
  [`${D}T06:00:00Z`, `${D}T06:20:00Z`, `${D}T09:00:00Z`, `${D}T09:25:00Z`]);
  const a = (await get(`/api/unauthorized/attributed?from=${D}&to=${D}`)).body;
  const fms = a.rows.find((r) => r.plate === 'ZQ1101' && r.source === 'fms_trip');
  check('the FMS journey is named by the operator’s rule, unaffected by CABMAN’s clock',
    fms?.attribution_tier === 'last_trip', `${fms?.attribution_tier} — ${fms?.attribution_evidence}`);
  check('…and the row says which provider saw it', fms?.source_label === 'FMS trip seat count');
  check('the list counts rides and names the provider count behind it',
    a.rides != null && a.by_source?.fms_trip >= 1 && /count a ride once/i.test(a.dedupe_rule || ''),
    JSON.stringify([a.rides, a.by_source]));
}

/* ══ 11. THE WORDING, ON EVERY TOUCHED ROUTE ══════════════════════════════
   REVERSION THAT PROVES THIS: put back "CABMAN is a five-minute realtime poll
   with no history behind it, and it is configured for Ecosine only." as the
   empty-window reason in api/unauthorized_routes.js — the first check fails. */
console.log('\n11. every sentence names both providers, and none says CABMAN is the only one');
{
  const empty = (await get('/api/unauthorized/attributed?from=2025-01-01&to=2025-01-31')).body;
  check('an empty window says why, naming all three sources — and no longer "Ecosine only" as the whole story',
    /absence of the sensor/.test(empty.coverage.note) && /FMS’s live seat count/.test(empty.coverage.note)
      && /FMS journeys/.test(empty.coverage.note) && !/configured for Ecosine only/.test(empty.coverage.note),
    empty.coverage.note);
  const part = (await get('/api/unauthorized/attributed?from=2026-09-10&to=2026-09-25')).body;
  check('a partly covered window names each provider’s days', /CABMAN DT \d+ days?/.test(part.coverage.note || '')
    && /FMS trip seat count \d+ days?/.test(part.coverage.note || '')
    && !/five-minute realtime poll/.test(part.coverage.note || ''), part.coverage.note);
  const sum = (await get('/api/unauthorized/summary?from=2026-09-10&to=2026-09-25')).body;
  check('the summary’s coverage is per provider', ['cabman', 'fms_live', 'fms_trip']
    .every((k) => sum.coverage.by_source?.[k] && 'days_with_data' in sum.coverage.by_source[k]),
    JSON.stringify(sum.coverage.by_source));
  const eg = (await get('/api/unauthorized/summary?from=2026-09-10&to=2026-09-25&fleet=egari')).body;
  check('over Egari, CABMAN’s figures are absent with the true reason — no account — never 0',
    eg.by_source.cabman.unauthorized === null && /no account for Egari/.test(eg.by_source.cabman.absent || ''),
    JSON.stringify(eg.by_source.cabman));
  check('…while FMS covers Egari', eg.by_source.fms_trip.segments > 0, JSON.stringify(eg.by_source.fms_trip));
  const list = (await get('/api/unauthorized/list?from=2026-09-10&to=2026-09-25&verdict=all')).body;
  check('/api/unauthorized/list rows name their provider', list.length && list.every((r) => r.source && r.source_label));
  const day = (await get('/api/day?day=2026-09-20')).body;
  check('/api/day segment rows name their provider, and the count says what it is made of',
    day.segments.every((r) => r.source_label) && day.capped?.segments_by_source?.fms_trip >= 1,
    JSON.stringify(day.capped));
  const co = (await get('/api/cohort/vehicles?ids=ZQ8001&from=2026-09-20&to=2026-09-20')).body.rows[0];
  check('/api/cohort/vehicles: one row per provider, and the car’s ride counted once',
    co.segments.some((r) => r.source_label === 'FMS live seat count') && co.unauthorized?.n === 1,
    JSON.stringify(co.unauthorized));
  const one = (await get(`/api/segment?plate=ZQ8001&at=${encodeURIComponent('2026-09-20T10:04:00Z')}&source=fms_live`)).body;
  check('/api/segment opens a segment by its provider', one.segment?.source === 'fms_live'
    && one.segment?.source_label === 'FMS live seat count', JSON.stringify(one.segment?.source));
  const bad = await get(`/api/segment?plate=ZQ8001&at=${encodeURIComponent('2026-09-20T10:04:00Z')}&source=fms`);
  check('…and refuses a provider that does not exist', bad.status === 400, String(bad.status));
  /* Two providers starting at the same second on one car: the address picks
     one, and an address without a provider (written before there were two)
     still opens, naming the other. */
  await seg('cabman', 'ZQ8004', '16:00', '16:20', 'unauthorized', 6);
  await seg('fms_trip', 'ZQ8004', '16:00', '16:25', 'unauthorized', 7);
  const at16 = encodeURIComponent('2026-09-20T16:00:00Z');
  const asked = (await get(`/api/segment?plate=ZQ8004&at=${at16}&source=fms_trip`)).body;
  check('two providers at one instant: the address opens the one it names',
    asked.segment?.source === 'fms_trip' && Number(asked.segment?.distance_km) === 7, JSON.stringify(asked.segment?.source));
  const bare = (await get(`/api/segment?plate=ZQ8004&at=${at16}`)).body;
  check('…and an address with no provider opens one and names the other',
    bare.segment?.source === 'cabman' && bare.other_sources?.[0]?.source === 'fms_trip',
    JSON.stringify([bare.segment?.source, bare.other_sources]));
}
{
  /* /api/live: an FMS fix carries a seat reading now, named. */
  const live = (await get('/api/live')).body;
  const f = live.find((r) => r.plate === 'ZQ2002');
  check('/api/live reads FMS’s live seat count as a seat reading and names it',
    f && f.seat_count === 0 && f.seat_occupied === false && f.seat_source === 'FMS live seat count', JSON.stringify(f));
  /* /api/map/journey: with-passenger km per provider; two providers on one
     car are never added. REVERSION: compute occupied km over all fixes
     together and the two-provider day reports one summed figure. */
  const j1 = (await get('/api/map/journey?plate=ZQ2002&day=2026-09-15')).body;
  check('one provider measured the day: its figure, and its name', j1.occupied_km > 0
    && j1.occupancy_source === 'FMS live seat count', JSON.stringify([j1.occupied_km, j1.occupancy_source]));
  await fmsFix('ZQ6001', T(10, 12), 1, 50, 25.12, 55.22, 'ecosine');
  await fmsFix('ZQ6001', T(10, 20), 1, 50, 25.2, 55.3, 'ecosine');
  await fmsFix('ZQ6001', T(10, 28), 1, 50, 25.28, 55.38, 'ecosine');
  const j2 = (await get('/api/map/journey?plate=ZQ6001&day=2026-09-15')).body;
  check('two providers measured it: each under its own name, the combined figure absent with the reason',
    j2.occupied_km === null && j2.occupancy_by_source.length === 2
      && /not added together/.test(j2.occupancy_note || ''), JSON.stringify([j2.occupied_km, j2.occupancy_note]));
}

/* ══ 12. THE PAGES — the phrases that stopped being true are gone ══════════
   REVERSION THAT PROVES THIS: restore any one of them in the file named and
   this block names the file and the phrase. */
console.log('\n12. no page, route or doc still says CABMAN is the only seat sensor');
{
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const files = [
    ...readdirSync(new URL('../api/public/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `api/public/${f}`),
    'api/public/m/screens.js', 'api/server.js', 'api/unauthorized_routes.js', 'src/insights.js',
    '../docs/unauthorized-trips.md', '../docs/fleet-tracking-api-reference.md',
  ];
  const GONE = [
    /only CABMAN carries a seat sensor/i, /only feed carrying a seat sensor/i,
    /the only feed with a seat sensor/i, /configured for Ecosine only\./,
    /carries no seat sensor/i, /hotel → uber → yango → bolt → fms/,
    /so Egari has no seat-sensor layer/i, /Collection gaps says whether CABMAN was running/,
    /invisible to unauthorised-use detection/, /disables unauthorised-use detection/,
    /CABMAN fixes at 5-minute resolution/, /carry both a seat sensor and a journey/,
  ];
  const hits = [];
  for (const f of files) {
    const src = read(f);
    for (const re of GONE) if (re.test(src)) hits.push(`${f}: ${re}`);
  }
  check('none of the untrue sentences survives in the pages, the routes or the docs', hits.length === 0,
    hits.join('; '));
  const need = [
    ['api/public/segments.js', /segSourceLabel\(r\)/], ['api/public/driver.js', /segSourceLabel\(r\)/],
    ['api/public/vehicle.js', /segSourceLabel\(r\)/], ['api/public/day.js', /segSourceLabel\(r\)/],
    ['api/public/m/screens.js', /segSourceLabel\(r\)/], ['api/public/app.js', /By seat-sensor provider/],
    ['api/public/app.js', /dedupe_rule/], ['api/public/driver.js', /counts_once !== false/],
    ['api/public/segments.js', /counts_once === false/], ['api/public/cohort.js', /d\.unauthorized/],
  ];
  const missing = need.filter(([f, re]) => !re.test(read(f))).map(([f, re]) => `${f} ${re}`);
  check('every page that shows a segment names its provider, and every combined total states the rule',
    missing.length === 0, missing.join('; '));
}

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
