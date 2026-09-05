/* Eleven months where one fleet had every fare and the other had none.
   ─────────────────────────────────────────────────────────────────────────
   Measured on production, 5 September 2026, per calendar month, Uber only,
   counting bookings that could carry a fare at all:

     month      ecosine priced        egari priced
     2025-09    18,195 / 18,211       0 / 7,233
     2025-12    17,158 / 17,174       0 / 6,716
     2026-04     4,072 /  4,072       0 / 1,793
     2026-07     6,000 /  6,000       0 / 2,598

   Egari's reports are not refused. The weeks that were finally asked for came
   back full — Egari's August went from 0% to 74.8% in the hours a resumed
   backfill spent on it. Nothing had ever asked, because collect() ran one
   whole pass per org: Egari's fare walk sat behind Ecosine's ~105 weekly
   windows, each a report costing about a minute plus a paced sleep, in a
   worker that restarts whenever the app deploys. Job 50 died at Ecosine week
   51 and had to be resumed to reach Egari at all.

   The fix is the ORDER, and this file holds the order down. It asserts the
   property that makes it a fix rather than a reshuffle: at every point in the
   sequence the two fleets are level, so a run cut short anywhere leaves them
   equally far back instead of one complete and one empty. */
import { fareWeeks, fareTasks } from '../src/sources/uber.js';
import { iso } from '../src/util.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const FROM = new Date('2026-06-01T00:00:00Z');
const TO = new Date('2026-09-04T09:00:00Z');   // Friday, mid-week
const ORGS = [{ fleet: 'ecosine' }, { fleet: 'egari' }];

console.log('\nthe weeks, once, for both fleets');

const weeks = fareWeeks(FROM, TO);
check('every week the range touches is asked for',
  weeks.length === 14, `${weeks.length} weeks`);
check('exactly one of them is the running week',
  weeks.filter((w) => w.isOpen).length === 1,
  JSON.stringify(weeks.filter((w) => w.isOpen).map((w) => iso(w.start))));
check('and it is first',
  weeks[0].isOpen === true && iso(weeks[0].start) === '2026-08-31',
  `${iso(weeks[0].start)}..${iso(weeks[0].end)}`);
check('the closed ones follow it newest first',
  weeks.slice(1).every((w, i, a) => i === 0 || a[i - 1].start > w.start),
  JSON.stringify(weeks.slice(1, 4).map((w) => iso(w.start))));
check('…so a truncated walk keeps the weeks a reader is looking at',
  iso(weeks[1].start) === '2026-08-24' && iso(weeks.at(-1).start) === '2026-06-01',
  `${iso(weeks[1].start)} … ${iso(weeks.at(-1).start)}`);

console.log('\nand the two fleets go through them together');

const tasks = [...fareTasks(ORGS, weeks)];
check('every fleet is asked about every week',
  tasks.length === weeks.length * ORGS.length,
  `${tasks.length} against ${weeks.length} × ${ORGS.length}`);

/* THE property. Walk the sequence one task at a time and count what each
   fleet has been asked. If a job dies at step n, this is what each fleet has.
   A per-org walk fails this at step 15 — Ecosine 14, Egari 1 — and kept
   failing it for eleven months. */
const asked = new Map(ORGS.map((o) => [o.fleet, 0]));
let worst = 0, worstAt = -1;
tasks.forEach((t, i) => {
  asked.set(t.o.fleet, asked.get(t.o.fleet) + 1);
  const counts = [...asked.values()];
  const spread = Math.max(...counts) - Math.min(...counts);
  if (spread > worst) { worst = spread; worstAt = i; }
});
check('at no point is one fleet more than one week ahead of the other',
  worst <= 1,
  `worst spread ${worst}, first reached at task ${worstAt + 1} of ${tasks.length}`);

/* The same statement from the other end: cut the sequence anywhere. */
const cutAt = 7;
const cut = tasks.slice(0, cutAt);
const byFleet = ORGS.map((o) => cut.filter((t) => t.o.fleet === o.fleet).length);
check(`a run cut short after ${cutAt} reports leaves both fleets with weeks`,
  byFleet.every((n) => n > 0) && Math.max(...byFleet) - Math.min(...byFleet) <= 1,
  JSON.stringify(Object.fromEntries(ORGS.map((o, i) => [o.fleet, byFleet[i]]))));
check('…and the weeks it leaves them are the newest ones, for both',
  ORGS.every((o) => iso(cut.find((t) => t.o.fleet === o.fleet).w.start) === '2026-08-31'),
  'the running week is first in the sequence for every fleet, not only the first');

console.log('\nthe order is stable, because a resumed job must re-ask in it');

/* The checkpoint is keyed on fleet and window, so a resumed job skips what it
   finds and continues. That only lands on the right windows if the sequence a
   second attempt generates is the sequence the first one walked. */
const again = [...fareTasks(ORGS, fareWeeks(FROM, TO))];
check('two runs over the same range produce the same sequence',
  again.length === tasks.length
  && again.every((t, i) => t.o.fleet === tasks[i].o.fleet && +t.w.start === +tasks[i].w.start),
  'a sequence that varies between attempts makes the checkpoint describe windows it did not walk');

console.log('\nand one fleet is still one fleet');

const solo = [...fareTasks([{ fleet: 'ecosine' }], weeks)];
check('a run narrowed to one fleet walks the weeks once',
  solo.length === weeks.length && solo.every((t) => t.o.fleet === 'ecosine'),
  `${solo.length} tasks`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
