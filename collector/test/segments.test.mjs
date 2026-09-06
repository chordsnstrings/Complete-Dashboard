/* occupancy_segment must hold the CURRENT reading, not every reading ever made.
   ─────────────────────────────────────────────────────────────────────────
   The write in src/reconcile.js was an upsert keyed on (plate, started_at) and
   nothing else, so the table accumulated the output of every pass that has ever
   run. Two passes that disagree about where a journey starts do not collide on
   that key, so both rows survived — and on production on 2026-09-05, over
   2026-08-20..2026-09-05, 2,102 of 3,511 rows (59.9 percent, 51,401 of 82,639
   km) were intervals lying strictly inside a longer segment on the same plate.
   All 2,102 shared one shape: the same end as the row containing them and a
   later start, which is a pass whose window opened mid-journey recording the
   tail of it as a journey of its own.

   The property that makes that impossible, and the reason the fix exists: two
   rows for one plate may not overlap in time. A plate is in one place at one
   time, so an overlap is not two journeys — it is two answers to the same
   question, and #unauthorized was counting both.

   Driven through reconcile() rather than through the shape of the SQL, because
   the shape was never the problem: what has to hold is what the WRITE leaves
   behind after passes with different windows have run over the same telemetry.

   One assertion deliberately not made here: running the identical window twice
   over unchanged telemetry. That was already stable through the primary key
   before this fix, so it pins nothing — it passes with the fix reverted. The
   pass that has to be pinned is the one whose ANSWER CHANGED, below. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* reconcile() takes a client out of the pool for its transaction, so patching
   pool.query alone is not enough. BEGIN/COMMIT/ROLLBACK are forwarded rather
   than swallowed — the delete and the insert being one transaction is part of
   what is being tested. */
const dbmod = await import('../src/db.js');
dbmod.pool.query = (t, p) => db.query(t, p);
dbmod.pool.connect = async () => ({ query: (t, p) => db.query(t, p), release: () => {} });

const { reconcile } = await import('../src/reconcile.js');

const at = (day, min) => `2026-08-${day}T${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}:00Z`;
const same = (ts, iso) => ts != null && +new Date(ts) === +new Date(iso);
const fix = (plate, day, min, occupied) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, lat, lng,
     ignition, seat_occupied, speed, odometer, polled_at)
   VALUES ('cabman', $1, 'ecosine', $2::timestamptz, $3, $4, $5, $5, $6, $7, $2::timestamptz)`,
  [plate, at(day, min), 25.1 + min * 0.004, 55.2 + min * 0.004, occupied, occupied ? 45 : 0, 1000 + min]);

/* L44305 runs one journey on the 14th, bounded by observed empty fixes an hour
   either side so it can be judged rather than refused. L44306 runs one on the
   13th and produces no fix at all on the 14th — it is the plate a pass over the
   14th knows nothing about, and its row is the one a too-wide DELETE would take
   with it. */
await fix('L44305', '14', 0, false);
await fix('L44305', '14', 60, false);
for (let m = 120; m <= 160; m += 5) await fix('L44305', '14', m, true);
await fix('L44305', '14', 220, false);
await fix('L44305', '14', 280, false);

await fix('L44306', '13', 0, false);
for (let m = 60; m <= 100; m += 5) await fix('L44306', '13', m, true);
await fix('L44306', '13', 160, false);

const WIDE = { from: '2026-08-13T00:00:00Z', to: '2026-08-14T23:59:59Z' };
const rows = () => q(`SELECT plate, started_at, ended_at, verdict, fixes
                        FROM occupancy_segment ORDER BY plate, started_at`);

/* The invariant, as a query rather than as a count: any two rows on one plate
   whose intervals intersect. Written over the whole table so it holds no matter
   which pass wrote what. */
const overlaps = () => q(
  `SELECT a.plate, a.started_at a_start, a.ended_at a_end, b.started_at b_start, b.ended_at b_end
     FROM occupancy_segment a JOIN occupancy_segment b
       ON a.plate = b.plate AND a.started_at < b.started_at
      AND coalesce(a.ended_at, a.started_at) > b.started_at`);

console.log('\ntwo passes, one journey');

await reconcile(WIDE);
const afterWide = await rows();
check('the wide pass records both plates', afterWide.length === 2, JSON.stringify(afterWide.map((r) => r.plate)));
const whole = afterWide.find((r) => r.plate === 'L44305');
check('…and L44305 as one journey from its first occupied fix',
  whole && same(whole.started_at, at('14', 120)), whole?.started_at);

/* A later pass whose window opens INSIDE that journey. This is the production
   shape: `from` is a clock offset back from now (src/run.js:114), so it lands
   wherever it lands, and 2,102 rows are the tails it cut. */
await reconcile({ from: at('14', 130), to: '2026-08-14T23:59:59Z' });

const afterNarrow = await rows();
const ov = await overlaps();
check('no two segments on one plate overlap in time', ov.length === 0, JSON.stringify(ov));
check('the journey is still one row, not one row per pass',
  afterNarrow.filter((r) => r.plate === 'L44305').length === 1,
  JSON.stringify(afterNarrow.filter((r) => r.plate === 'L44305').map((r) => [r.started_at, r.ended_at])));
/* And it is the row built from MORE telemetry that survived. A DELETE wide
   enough to reach the straddling journey would have replaced the whole reading
   with the truncated one, which is a data-loss bug wearing a fix's clothes. */
check('…and the surviving row is the whole journey, not the truncated tail',
  afterNarrow.some((r) => r.plate === 'L44305' && same(r.started_at, at('14', 120))),
  JSON.stringify(afterNarrow.map((r) => [r.plate, r.started_at])));


/* THE PLATE HALF OF THE DELETE'S SCOPE, which nothing above pins.
   ─────────────────────────────────────────────────────────────────────────
   Every assertion so far passes with `plate = ANY($1)` removed from the window
   DELETE entirely — verified by removing it — because the two fixture plates
   are separated by the WINDOW, not by the plate list, so the window guard alone
   saves them. That left the more dangerous half of the scope untested: the
   DELETE runs over `plates`, built from the cabman fixes this pass returned, and
   src/reconcile.js's own comment promises it "CANNOT reach a plate that produced
   no fix in the window — a device that was offline leaves no evidence, and
   evidence we did not look at is not evidence we may retract."

   That promise needs a plate holding a segment INSIDE the window which produces
   no fix on this pass, which is what a tracker going dark looks like: the
   journey is already recorded, and the telemetry behind it is no longer
   returned. Delete the fixes and re-run. A plate-blind DELETE takes the row and
   writes nothing back, which is not a de-duplication but a silent erasure of a
   journey the fleet actually made. */
{
  await fix('L44307', '14', 300, false);
  for (let m = 320; m <= 360; m += 5) await fix('L44307', '14', m, true);
  await fix('L44307', '14', 420, false);
  /* A SECOND plate reporting in the same window, and it is load-bearing:
     writeWindow returns early on an empty plate list, so a pass in which the
     dark plate is the ONLY plate never issues the DELETE at all and proves
     nothing. This one keeps the pass non-empty, so the DELETE really runs and
     the question becomes whether its plate list is what stops it. */
  await fix('L44308', '14', 300, false);
  for (let m = 330; m <= 370; m += 5) await fix('L44308', '14', m, true);
  await fix('L44308', '14', 430, false);
  const LATE = { from: at('14', 290), to: '2026-08-14T23:59:59Z' };
  await reconcile(LATE);
  const before = (await rows()).filter((r) => r.plate === 'L44307');
  check('a plate that reported is recorded in the window', before.length === 1,
    JSON.stringify(before));
  check('…and so is the plate beside it that keeps the next pass non-empty',
    (await rows()).some((r) => r.plate === 'L44308'));

  /* The tracker goes dark: the journey stands, the telemetry behind it stops
     being returned, so the next pass over the same window sees nothing for it. */
  await q(`DELETE FROM telemetry_snapshot WHERE plate = 'L44307'`);
  await reconcile(LATE);
  const after = (await rows()).filter((r) => r.plate === 'L44307');
  check('a plate that reported nothing this pass keeps the journey it already had',
    after.length === 1 && same(after[0].started_at, before[0]?.started_at),
    `${JSON.stringify(after)} was ${JSON.stringify(before)}`);
  /* And the pass that DID cover a plate is still authoritative for it — the
     scope is narrowed, not disabled. */
  const others = (await rows()).filter((r) => r.plate === 'L44308');
  check('…while the plate that did report is still deduplicated to one row',
    others.length === 1, JSON.stringify(others));
}
/* The other half of the scope. The pass over the 14th produced no fix for
   L44306 and therefore knows nothing about it; a pass may only retract what it
   has just re-derived. */
check('a plate the pass saw no telemetry for keeps its segment',
  afterNarrow.some((r) => r.plate === 'L44306'), JSON.stringify(afterNarrow.map((r) => r.plate)));

console.log('\nthe same window, judged again on changed evidence');

/* Late-arriving telemetry is why a second pass over the same window can reach a
   different answer: the first two fixes of the journey turn out to show an
   empty seat, so the journey now begins at 02:15 rather than 02:00. Under the
   old write the 02:00 row had no key for the new one to collide with and stayed
   beside it — the same window, judged twice, leaving more journeys behind than
   the fleet ran. */
await q(`UPDATE telemetry_snapshot SET seat_occupied = false, speed = 0
          WHERE plate = 'L44305'
            AND captured_at IN ($1::timestamptz, $2::timestamptz, $3::timestamptz)`,
  [at('14', 120), at('14', 125), at('14', 130)]);

const before = (await rows()).filter((r) => r.plate === 'L44305').length;
await reconcile(WIDE);
const after = (await rows()).filter((r) => r.plate === 'L44305');
check('a second pass over the same window leaves the row count unchanged',
  after.length === before, `${before} -> ${after.length}`);
check('…and what it leaves is the answer this pass reached, not the last one too',
  after.length === 1 && same(after[0].started_at, at('14', 135)),
  JSON.stringify(after.map((r) => [r.started_at, r.ended_at])));
check('the no-overlap invariant survives the re-judgement',
  (await overlaps()).length === 0, JSON.stringify(await overlaps()));

/* The window is a bound in both directions: a pass over the 14th must not
   retract the 13th, on any plate. */
check('a segment outside the window is untouched',
  (await rows()).some((r) => r.plate === 'L44306' && same(r.started_at, at('13', 60))),
  JSON.stringify((await rows()).map((r) => [r.plate, r.started_at])));

/* ── the one-off retraction of what earlier passes already left behind ────
   The reconciler above only sweeps the window it was handed, and the oldest of
   these fragments fall outside any window it will ever run, so sql/schema_v61
   removes them once. Exercised by clearing its schema_once row and replaying
   the file, which is exactly what a fresh database does on boot. */
console.log('\nthe one-off retraction of what earlier passes left behind');

const seg = (plate, s0, s1) => q(
  `INSERT INTO occupancy_segment (plate, fleet_id, started_at, ended_at, verdict, verdict_reason)
   VALUES ($1, 'ecosine', $2::timestamptz, $3::timestamptz, 'unauthorized', 'fixture')`,
  [plate, s0, s1]);
await q('DELETE FROM occupancy_segment');
// A journey recorded whole, the truncated tail an earlier pass left beside it,
// a tail of that tail, the next real journey on the same plate, and one on
// another plate that happens to run at the same time.
await seg('L44305', at('14', 120), at('14', 160));
await seg('L44305', at('14', 130), at('14', 160));
await seg('L44305', at('14', 145), at('14', 160));
await seg('L44305', at('14', 200), at('14', 230));
await seg('L44306', at('14', 130), at('14', 160));

const replayV61 = async () => {
  await q(`DELETE FROM schema_once WHERE name = 'v61_drop_superseded_segments'`);
  await db.exec(readFileSync(new URL('../sql/schema_v61.sql', import.meta.url), 'utf8'));
};
await replayV61();

const left = await rows();
check('the retraction leaves one row per journey',
  left.length === 3, JSON.stringify(left.map((r) => [r.plate, r.started_at])));
check('…the row it keeps is the longest reading of the journey',
  left.some((r) => r.plate === 'L44305' && same(r.started_at, at('14', 120))
    && !left.some((o) => o.plate === 'L44305' && same(o.started_at, at('14', 130)))),
  JSON.stringify(left.map((r) => [r.plate, r.started_at])));
check('…a chain of fragments goes in one statement, not one deep per replay',
  !left.some((r) => same(r.started_at, at('14', 145))));
check('…the next journey on the same plate is not a fragment and stays',
  left.some((r) => r.plate === 'L44305' && same(r.started_at, at('14', 200))));
check('…and another plate running at the same time is not a duplicate of it',
  left.some((r) => r.plate === 'L44306'));
check('the table it leaves satisfies the invariant', (await overlaps()).length === 0);

// Replaying the file on a table the reconciler has since refilled must do
// nothing at all — that is what the schema_once guard is for, and schema_v8
// records what happens when a one-time data change runs on every boot.
await seg('L44305', at('14', 210), at('14', 225));
await db.exec(readFileSync(new URL('../sql/schema_v61.sql', import.meta.url), 'utf8'));
check('a replayed migration is a no-op, even on rows that would match it',
  (await rows()).length === 4, JSON.stringify((await rows()).map((r) => [r.plate, r.started_at])));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
