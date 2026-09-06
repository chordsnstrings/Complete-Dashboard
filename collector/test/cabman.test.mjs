/* CABMAN's roster: which plates the provider still lists, and what the collector
   is allowed to write.
   ──────────────────────────────────────────────────────────────────────────
   Measured on production 2026-09-05, /api/live: 175 CABMAN rows for fleet
   'ecosine', one per plate, and the polled_at column takes exactly four values
   — 43 plates at the poll that had just run, 45 a day and a half earlier, 65 six
   days earlier and 22 seven days earlier. /api/status for the same minute says
   cabman/realtime rows_written 48, status ok. So 132 plates that the poll has
   not returned for between one and seven days are permanently counted as live
   fleet: the vehicle register unions its plate list out of telemetry_snapshot
   and read 273 rows with 171 idle, the Live page showed 25 of those 132 frozen
   at a speed recorded days ago, and the Alerts page divided its events by 264
   tracked vehicles.

   All 132 were already stale:true — measured, 132 of 132 — which is why this
   cannot be fixed in the staleness flag. Stale says a tracker has gone quiet.
   Nothing in the table said the vehicle had left the fleet.

   What is pinned here is the discrimination, in both directions. A plate the
   provider lists once and never again must never be written. A plate that
   misses a single poll — a tracker in a basement, a truncated answer — must
   keep its place, because a car that vanishes from a count with no explanation
   is the same defect as one counted wrongly. And a payload that collapses
   against the roster the collector holds must raise something, since 175 held
   against 48 returned raised nothing at all. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { pool } from '../src/db.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
/* upsertMany writes through pool.connect(), getState/setState through
   pool.query, so both have to point at the throwaway database. */
pool.query = (t, p) => db.query(t, p);
pool.connect = async () => ({
  query: (t, p) => (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(String(t).trim())
    ? Promise.resolve({ rows: [] }) : db.query(t, p)),
  release: () => {},
});
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine', 'Ecosine') ON CONFLICT DO NOTHING`);

process.env.CABMAN_ECOSINE_PASS = 'test-password';
process.env.CABMAN_ECOSINE_ID = '81';
process.env.CABMAN_ECOSINE_USER = 'admin_ecosine';

/* The provider, in the shape the collector reads it. http.js calls the global
   fetch by name at call time, so replacing it is enough. */
let payload = [];
globalThis.fetch = async () => new Response(JSON.stringify({ IVDDataResult: payload }),
  { status: 200, headers: { 'content-type': 'application/json' } });

/* Fixes are minted a few seconds old, not days: the lag guard at the end of
   pullLive raises its own ERROR when the freshest fix in a payload is behind
   the poll, and a test that fed it stale timestamps would be reading that
   error instead of the one it means to assert on. */
let tick = 0;
const gmt = () => new Date(Date.now() - (++tick) * 1000).toISOString().replace('T', ' ').slice(0, 19);
const listing = (plates) => plates.map((p) => ({
  VehicleID: p, gmt: gmt(), lat: 25.2, lng: 55.3, speed: 0,
  state: '0', Status: 'Stopped', SeatSensorValue: '0', odometer: 1000,
}));

/* Every ERROR and WARN the collector raises, kept so the alarm can be asserted
   on rather than eyeballed. */
const raised = [];
const realError = console.error, realWarn = console.warn;
console.error = (...a) => { raised.push({ level: 'error', line: a.join(' ') }); };
console.warn = (...a) => { raised.push({ level: 'warn', line: a.join(' ') }); };
const since = () => raised.length;
const errorsAfter = (n, re) => raised.slice(n).filter((r) => r.level === 'error' && re.test(r.line));

const { pullLive, cabmanRoster } = await import('../src/sources/cabman.js');
const reset = async () => {
  await q('DELETE FROM source_state');
  await q('DELETE FROM telemetry_snapshot');
};
const held = () => q(`SELECT DISTINCT plate FROM telemetry_snapshot WHERE source='cabman'`)
  .then((r) => r.map((x) => x.plate).sort());

/* ── 1. the production shape, rebuilt from what the table already holds ──────
   A roster that has never been kept cannot count polls it did not observe, so
   the first one is seeded out of the rows the old behaviour left behind — each
   plate's last poll against the NEWEST poll in the same table. This is the
   production case at one twentieth of the size: four plates stamped by the poll
   that just ran, six stamped 41 hours earlier, which is the gap the nearest
   phantom cohort actually had. */
{
  await reset();
  /* Plates as normPlate leaves them — uppercase, no separators — so that the
     name in the payload and the name in the table are the same string and the
     assertions are about the roster rather than about plate normalisation. */
  const CURRENT = ['L40001', 'L40002', 'L40003', 'L40004'];
  const FROZEN = ['L41001', 'L41002', 'L41003', 'L41004', 'L41005', 'L41006'];
  const put = (plate, hoursAgo) => q(
    `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status)
     VALUES ('cabman', 'ecosine', $1, $2::timestamptz, $2::timestamptz, 25.2, 55.3, 0, 'Stopped')`,
    [plate, new Date(Date.now() - hoursAgo * 36e5).toISOString()]);
  for (const p of CURRENT) await put(p, 0);
  for (const p of FROZEN) await put(p, 41);

  payload = listing(CURRENT);
  await pullLive();
  const r = await cabmanRoster();

  console.log('\nthe plates the provider has stopped listing');
  check('a plate the poll no longer returns is called departed', 
    FROZEN.every((p) => r.departed.includes(p)),
    `departed ${JSON.stringify(r.departed)}`);
  check('…and every plate the poll still returns keeps its place',
    CURRENT.every((p) => r.listed.includes(p) && !r.departed.includes(p)),
    `listed ${JSON.stringify(r.listed)}`);
  check('the exclusion is stated rather than left as a smaller number',
    typeof r.departed_reason === 'string' && r.departed_reason.length > 20,
    String(r.departed_reason));
  /* The reason is printed over plates that got there two different ways — 288
     missed polls, or a gap measured at seed time — so it may not claim either
     mechanism as if it were the only one. */
  check('…in words that are true of a seeded departure as well as a counted one',
    !/\b288\b/.test(r.departed_reason || ''), String(r.departed_reason));
  check('nothing is deleted: the rows are all still in the table',
    (await held()).length === CURRENT.length + FROZEN.length);
  check('and the caller can tell "none excluded" from "cannot yet say"', r.known === true);
}

/* ── 2. a collector that was down is not a fleet that was sold ───────────────
   The failure the seed is most likely to make: every plate's polled_at is three
   days old because nothing polled, and a rule that measured each plate against
   now() would seed the whole fleet as departed. Measured against the NEWEST
   poll in the same table instead, a uniform outage moves both ends together and
   nobody is departed.

   The car that is absent from the first poll back is what makes the difference
   visible. Under either rule the eleven that answer are members again; only the
   twelfth separates them, and under a now()-based seed it is a car declared no
   longer fleet on the strength of one missed poll after an outage it had
   nothing to do with. */
{
  await reset();
  const ALL = Array.from({ length: 12 }, (_, i) => `L420${String(i).padStart(2, '0')}`);
  for (const p of ALL) {
    await q(`INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status)
             VALUES ('cabman','ecosine',$1,$2::timestamptz,$2::timestamptz,25.2,55.3,0,'Stopped')`,
      [p, new Date(Date.now() - 72 * 36e5).toISOString()]);
  }
  const ABSENT = ALL[ALL.length - 1];
  payload = listing(ALL.slice(0, -1));
  await pullLive();
  const r = await cabmanRoster();
  console.log('\nthree days with no collector is not a fleet leaving');
  check('nobody departs when every plate is equally behind', r.departed.length === 0,
    `departed ${JSON.stringify(r.departed)}`);
  check('…including the one car that misses the first poll back',
    r.listed.includes(ABSENT), `listed ${JSON.stringify(r.listed)}`);
  check('…and the whole fleet is still counted', r.listed.length === ALL.length);
}

/* ── 3. once is not a fleet; one missed poll is ──────────────────────────────
   Twelve plates the provider lists every cycle, one it lists exactly once, and
   one that drops out of a single poll and comes back. The first must never
   reach telemetry_snapshot; the second must never leave it. */
{
  await reset();
  const CORE = Array.from({ length: 12 }, (_, i) => `L430${String(i).padStart(2, '0')}`);
  const ONCE = 'L44001';
  const BASEMENT = 'L45001';

  const poll = async (plates) => { payload = listing(plates); return pullLive(); };
  await poll([...CORE, ONCE, BASEMENT]);          // poll 1
  await poll([...CORE, BASEMENT]);                // poll 2
  const wrote3 = await poll([...CORE, BASEMENT]); // poll 3 — admission
  const afterAdmission = await held();

  console.log('\na plate listed once and never again');
  check('is never written to telemetry_snapshot', !afterAdmission.includes(ONCE),
    `held ${JSON.stringify(afterAdmission)}`);
  check('…and is named as pending rather than dropped in silence',
    (await cabmanRoster()).pending.includes(ONCE));
  check('the plates listed every cycle are written on their third poll',
    CORE.every((p) => afterAdmission.includes(p)) && afterAdmission.includes(BASEMENT),
    `held ${JSON.stringify(afterAdmission)}`);
  check('and the run counts what it wrote, not what it was offered',
    wrote3 === CORE.length + 1, String(wrote3));

  console.log('\na plate that misses one poll');
  const before = since();
  await poll(CORE);                               // poll 4 — BASEMENT absent
  const missed = await cabmanRoster();
  check('keeps its row', (await held()).includes(BASEMENT));
  check('…and keeps its place in the fleet', missed.listed.includes(BASEMENT)
    && !missed.departed.includes(BASEMENT), JSON.stringify(missed.departed));
  check('…and one absence raises no collapse alarm',
    errorsAfter(before, /fewer plates than the roster holds/).length === 0);

  await poll([...CORE, BASEMENT]);                // poll 5 — back
  const back = await cabmanRoster();
  check('and it is written again on the poll it returns',
    back.listed.includes(BASEMENT) && (await held()).includes(BASEMENT));

  /* ── the alarm ────────────────────────────────────────────────────────────
     Thirteen plates held, two returned. On production this was 175 held and 48
     returned and the run recorded status ok with rows_written 48. */
  console.log('\na payload that collapses against the roster');
  const mark = since();
  await poll(CORE.slice(0, 2));                   // poll 6 — 2 of 13
  const fired = errorsAfter(mark, /fewer plates than the roster holds/);
  check('raises an error naming the shortfall', fired.length === 1,
    `errors ${JSON.stringify(raised.slice(mark).map((r) => r.line.slice(0, 90)))}`);
  check('…which carries both sides of the comparison',
    /"returned":2/.test(fired[0]?.line || '') && /"held":13/.test(fired[0]?.line || ''),
    String(fired[0]?.line || ''));
  /* A channel that cries every cycle is a channel nobody reads — the lag guard
     in this same file logged 288 errors a day for a fault that was not there. */
  const mark2 = since();
  await poll(CORE.slice(0, 2));                   // poll 7 — the same collapse
  check('and a collapse that persists unchanged is not re-raised every poll',
    errorsAfter(mark2, /fewer plates than the roster holds/).length === 0);
  /* And nothing is removed on the strength of a truncated payload. */
  check('nor is anything departed on two bad polls',
    (await cabmanRoster()).departed.length === 0);

  /* ── a refusal is not an empty feed ───────────────────────────────────────
     The comment above the status guard in this collector already says it: a
     401 used to produce zero vehicles, the same as a quiet minute, and 85
     stale_tracker findings went out over one credential. The roster is the same
     hazard one layer down — a refused poll that reached the roster would be a
     poll in which the provider listed nobody, which is thirteen plates a day
     from being called sold and a collapse alarm fired against a feed that was
     never asked. So it must not be counted as a poll at all. */
  console.log('\na poll the provider refused');
  const before401 = await cabmanRoster();
  const mark3 = since();
  const ok = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ Message: 'Unauthorized' }),
    { status: 401, headers: { 'content-type': 'application/json' } });
  await pullLive();
  globalThis.fetch = ok;
  const after401 = await cabmanRoster();
  check('is not counted as a poll that listed nobody',
    after401.fleets[0].polls === before401.fleets[0].polls,
    `${before401.fleets[0].polls} → ${after401.fleets[0].polls}`);
  check('…so nothing departs and no alarm is raised against it',
    after401.departed.length === 0
      && errorsAfter(mark3, /fewer plates than the roster holds/).length === 0);
}

console.error = realError; console.warn = realWarn;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
