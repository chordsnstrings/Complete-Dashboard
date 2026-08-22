/* ── the playbook's new-driver ramp ────────────────────────────────────────
   "Where these idle vehicles get a driver, expect N bookings" is the number
   this page exists to produce, and it rests on one measurement: what a
   genuinely new driver actually did in their first whole month.

   It used to be computed by self-joining trip_norm to itself over the entire
   history on a regex-folded name — 175,000 rows folded on each side — which
   was most of this endpoint's eleven seconds. It also folded names its own
   way, lowercase and whitespace but not a repeated word, making it the fifth
   definition of "the same person" here and the second that disagreed: "Najeeb
   Ullah Khan Khan" was a separate hire with his own ramp.

   It reads rollup_person_month now, which is that shape already and is keyed on
   the one stored fold. These tests pin what the change must not have altered:
   the number, and who counts as one person. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { refreshRollups } from '../src/rollup.js';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

let n = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, distance_km, status, price)
   VALUES ('uber',$1,'ecosine',$2,$3,$4,$5,10,'completed',$6)`,
  [`p${n++}`, o.plate || 'L100', o.drv || 'd-1', o.name, o.at, o.price ?? 40]);

/* Three drivers whose first whole month is inside the last six, doing 4, 6 and
   8 bookings — a median of 6, checkable by hand. The window is anchored on the
   latest day in the record, so the fixture is written relative to a fixed
   "today" the fixture itself establishes. */
const day = (monthsAgo, d) => {
  const t = new Date();
  t.setUTCDate(1); t.setUTCMonth(t.getUTCMonth() - monthsAgo); t.setUTCDate(d);
  return `${t.toISOString().slice(0, 10)}T09:00:00+04:00`;
};
const seed = async (name, monthsAgo, count, drv) => {
  for (let i = 0; i < count; i++) await trip({ name, drv, at: day(monthsAgo, i + 1) });
};
await seed('Alpha One', 3, 4, 'd-a');
await seed('Beta Two', 2, 6, 'd-b');
await seed('Gamma Three', 2, 8, 'd-c');
// Someone whose first month is the CURRENT one — partial, and must be excluded
// or a driver who started on the 28th looks like a bad hire.
await seed('Delta Four', 0, 1, 'd-d');
// And a long-standing driver, whose first month is outside the six-month window.
await seed('Epsilon Five', 11, 30, 'd-e');
await seed('Epsilon Five', 1, 12, 'd-e');
/* The fold case: the same human, spelled with a duplicated word, on a later
   month. If the fold works they are ONE person whose first month is the early
   one; if it does not, the second spelling is a brand-new hire with a
   flattering ramp. */
/* Zeta's first month is deliberately OUTSIDE the six-month window, so a
   working fold leaves them out of the cohort entirely. If the fold failed,
   "Zeta Six Six" would be a brand-new hire whose first whole month is last
   month with twenty bookings — a fourth cohort member with a ramp three times
   the median, dragging the number this whole page rests on. The test can tell
   the two apart, which is the point of the case. */
await seed('Zeta Six', 11, 5, 'd-f');
await seed('Zeta Six Six', 1, 20, 'd-f2');

await refreshRollups({ db });

/* mountAll already imports and mounts every api/*_routes.js, so playbookRoutes
   is live without any source slicing — mountSource is for the routes that are
   declared inline in server.js and cannot be imported. */
const { server, get } = await mountAll(db, { serverRoutes: false });
const { readFileSync } = await import('node:fs');
const src = readFileSync('api/playbook_routes.js', 'utf8');

const r = await get('/api/playbook');
check('the playbook answers', r.status === 200, `${r.status} ${r.raw || ''}`);
const ramp = r.body?.fleet?.new_driver_first_month;
const measured = r.body?.fleet?.new_drivers_measured;

console.log('\nplaybook: who counts as a new driver');

check('the median is over the drivers whose first WHOLE month is in the window',
  ramp === 6, `median=${ramp} (expected 6, the median of 4/6/8)`);
check('and counts exactly those three, not the partial month or the veteran',
  measured === 3, `measured=${measured}`);

console.log('\nplaybook: one human, one ramp');

/* "Zeta Six" and "Zeta Six Six" are the same person under the shared fold, so
   their first month is the earlier one and the 20-booking month is not a new
   hire. Counting them separately would add a fourth "new driver" with a ramp
   three times the median and drag the number the whole page rests on. */
const zeta = await q(
  `SELECT person_key, count(*)::int months, min(month) AS joined
   FROM rollup_person_month WHERE person_key LIKE 'zeta%' GROUP BY 1`);
check('a duplicated name part is the same person, not a second hire',
  zeta.length === 1, JSON.stringify(zeta.map((z) => z.person_key)));

/* And the guard that makes the above true rather than coincidental: the fold
   the playbook relies on is the stored one, not another local copy. */
check('the ramp reads the shared rollup rather than folding names itself',
  /FROM rollup_person_month/.test(src)
  && !/regexp_replace\(btrim\(driver_name\)/.test(src),
  src.match(/regexp_replace\([^)]*\)/)?.[0] || '');

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
