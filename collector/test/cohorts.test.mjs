/* The number and the list are the same arithmetic.
   ─────────────────────────────────────────────────────────────────────────
   A tile says 33 and a drill-down lists 31, and both are defensible: one
   counted rows where `!money && doc_days_left >= 0` and the other wrote a
   second query that said `money IS NULL`. Nothing in either is wrong and the
   product has told the reader two different things about the same set.

   The defence is that there IS only one definition — api/public/cohorts.js —
   and this file proves the pages use it, that every entry is well-formed, and
   that each predicate does what its label says against real payload shapes.

   The shapes below are the ones production actually returns: a driver ledger
   row keyed on `band`, a directory row where `trips` is 0 rather than null, a
   roster row carrying `category`, and the nulls each of them has in the field
   the predicate reads. */
import { COHORTS, membersOf, idOf, accountsOf, cohortOf } from '../api/public/cohorts.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── every entry is complete ─────────────────────────────────────────────── */
const keys = Object.keys(COHORTS);
check('the registry is not empty', keys.length >= 15, `${keys.length}`);
for (const k of keys) {
  const c = COHORTS[k];
  const missing = ['kind', 'source', 'from', 'fromLabel', 'label', 'question', 'why']
    .filter((f) => !c[f]);
  check(`${k} declares everything a page needs`, missing.length === 0 && typeof c.test === 'function',
    missing.join(','));
}
check('every kind is a driver or a vehicle',
  keys.every((k) => ['driver', 'vehicle'].includes(COHORTS[k].kind)),
  keys.filter((k) => !['driver', 'vehicle'].includes(COHORTS[k].kind)).join(','));
check('every source is an api path',
  keys.every((k) => COHORTS[k].source.startsWith('/api/')));
/* A question the reader can answer "yes" to is not a question. Each of these
   is the sentence the page prints under its own title. */
check('every question ends in a question mark',
  keys.every((k) => COHORTS[k].question.trim().endsWith('?')),
  keys.filter((k) => !COHORTS[k].question.trim().endsWith('?')).join(','));
check('an unknown key resolves to nothing rather than throwing', cohortOf('nope') === null);
check('members of an unknown key is an empty list', membersOf('nope', { rows: [{}] }).length === 0);

/* ── the predicates, against the shapes production returns ───────────────── */
/* /api/economics/drivers: three bands, mutually exclusive, plus the fields the
   other driver cohorts read. */
const ledger = { rows: [
  { driver_ext_id: 'd1', driver_name: 'A', ids: ['d1'], band: 'earning', money: 4200,
    measured_hours_online: 190, licence_days_left: 210 },
  { driver_ext_id: 'd2', driver_name: 'B', ids: ['d2'], band: 'drove_unpaid', money: null,
    measured_hours_online: null, licence_days_left: null },
  { driver_ext_id: 'd3', driver_name: 'C', ids: ['d3'], band: 'idle', money: null,
    measured_hours_online: null, licence_days_left: 12 },
  { driver_ext_id: 'd4', driver_name: 'D', ids: ['d4', 'd4b'], band: 'earning', money: 900,
    measured_hours_online: null, licence_days_left: -3 },
] };
const m = (k, p) => membersOf(k, p).map((r) => r.driver_ext_id || r.plate);
check('drove-unpaid is exactly the band', JSON.stringify(m('unit-drove-unpaid', ledger)) === '["d2"]',
  JSON.stringify(m('unit-drove-unpaid', ledger)));
check('earned-nothing is the idle band, not everybody without money',
  JSON.stringify(m('unit-earned-nothing', ledger)) === '["d3"]',
  JSON.stringify(m('unit-earned-nothing', ledger)));
/* The money-per-online-hour denominator: earned, and no hours measured. d2
   has no hours either and must NOT appear — it earned nothing, so it is not
   in the numerator to begin with. */
check('earning-with-no-hours excludes the people who earned nothing',
  JSON.stringify(m('unit-no-hours', ledger)) === '["d4"]',
  JSON.stringify(m('unit-no-hours', ledger)));
check('a licence expiring counts an already-expired one',
  JSON.stringify(m('unit-licence-due', ledger)) === '["d3","d4"]',
  JSON.stringify(m('unit-licence-due', ledger)));
/* A null licence date is not an expiring licence — the bug this shape exists
   to catch is `null < 30` being true in JavaScript. */
check('a null licence date is not counted as expiring',
  !membersOf('unit-licence-due', ledger).some((r) => r.driver_ext_id === 'd2'));

/* /api/economics/assets */
const assets = { rows: [
  { plate: 'P1', band: 'earning', money: 3100, doc_days_left: 40 },
  { plate: 'P2', band: 'moved_unpaid', money: null, doc_days_left: 15 },
  { plate: 'P3', band: 'still', money: null, doc_days_left: 90 },
  { plate: 'P4', band: 'still', money: null, doc_days_left: null },
  { plate: 'P5', band: 'still', money: null, doc_days_left: -6 },
] };
check('insured-and-idle needs a document that has NOT expired',
  JSON.stringify(m('unit-idle-documented', assets)) === '["P2","P3"]',
  JSON.stringify(m('unit-idle-documented', assets)));
check('a car with no document at all is not "insured and idle"',
  !membersOf('unit-idle-documented', assets).some((r) => r.plate === 'P4'));
check('an expired document is not "insured"',
  !membersOf('unit-idle-documented', assets).some((r) => r.plate === 'P5'));
check('moved-unpaid and never-moved partition the non-earners',
  JSON.stringify(m('unit-moved-unpaid', assets)) === '["P2"]'
  && JSON.stringify(m('unit-still', assets)) === '["P3","P4","P5"]');

/* /api/vehicles/directory — a bare array, and `trips` is 0, never null. */
const dir = [
  { plate: 'V1', trips: 42, telematics_journeys: 60, last_fix: '2026-08-28T00:00:00Z', stale: false, doc_days_left: 90 },
  { plate: 'V2', trips: 0, telematics_journeys: 38, last_fix: '2026-08-28T00:00:00Z', stale: false, doc_days_left: 12 },
  { plate: 'V3', trips: 0, telematics_journeys: 0, last_fix: null, stale: null, doc_days_left: null },
  { plate: 'V4', trips: 0, telematics_journeys: 0, last_fix: '2026-07-01T00:00:00Z', stale: true, doc_days_left: 200 },
];
check('moved-with-no-booking is the middle bucket, not every idle car',
  JSON.stringify(m('vehicles-moved-no-booking', dir)) === '["V2"]',
  JSON.stringify(m('vehicles-moved-no-booking', dir)));
check('did-not-move excludes the car that moved without a booking',
  JSON.stringify(m('vehicles-still', dir)) === '["V3","V4"]',
  JSON.stringify(m('vehicles-still', dir)));
/* The two tracker cohorts are different claims and must not overlap: a car
   nothing has ever reported is not "a tracker that has gone quiet". */
check('untracked is only the car with no fix at all',
  JSON.stringify(m('vehicles-untracked', dir)) === '["V3"]');
check('gone-quiet excludes the car that never reported',
  JSON.stringify(m('vehicles-stale', dir)) === '["V4"]');
check('the two tracker cohorts do not overlap',
  m('vehicles-untracked', dir).every((x) => !m('vehicles-stale', dir).includes(x)));
check('documents due counts only a date inside 30 days',
  JSON.stringify(m('vehicles-docs-due', dir)) === '["V2"]');
/* The three buckets on the Vehicles page must sum to the fleet, or the tiles
   above the table do not add up to the table. */
{
  const earning = dir.filter((r) => r.trips > 0).length;
  const moved = membersOf('vehicles-moved-no-booking', dir).length;
  const still = membersOf('vehicles-still', dir).length;
  check('earning + moved-unpaid + still is the whole fleet',
    earning + moved + still === dir.length, `${earning}+${moved}+${still} of ${dir.length}`);
}

/* /api/roster — rows under `people`, bucketed server-side by `category`. */
const roster = { people: [
  { driver_ext_id: 'r1', category: 'working', holding_vehicle_while_blocked: false },
  { driver_ext_id: 'r2', category: 'idle_this_window', holding_vehicle_while_blocked: false },
  { driver_ext_id: 'r3', category: 'never_started', holding_vehicle_while_blocked: false },
  { driver_ext_id: 'r4', category: 'in_pipeline', holding_vehicle_while_blocked: false },
  { driver_ext_id: 'r5', category: 'blocked', holding_vehicle_while_blocked: true },
  { driver_ext_id: 'r6', category: 'blocked', holding_vehicle_while_blocked: false },
  { driver_ext_id: 'r7', category: 'unclassified', holding_vehicle_while_blocked: false },
] };
check('each roster cohort reads the category the server already decided',
  JSON.stringify(m('roster-idle', roster)) === '["r2"]'
  && JSON.stringify(m('roster-never-started', roster)) === '["r3"]'
  && JSON.stringify(m('roster-pipeline', roster)) === '["r4"]'
  && JSON.stringify(m('roster-blocked', roster)) === '["r5","r6"]'
  && JSON.stringify(m('roster-unclassified', roster)) === '["r7"]');
check('holding a car while stopped is a subset of stopped',
  JSON.stringify(m('roster-blocked-holding', roster)) === '["r5"]');
check('the roster categories are mutually exclusive', (() => {
  const seen = new Map();
  for (const k of ['roster-idle', 'roster-never-started', 'roster-pipeline', 'roster-blocked', 'roster-unclassified']) {
    for (const r of membersOf(k, roster)) {
      if (seen.has(r.driver_ext_id)) return false;
      seen.set(r.driver_ext_id, k);
    }
  }
  return true;
})());

/* ── the ids the page hands to the detail endpoint ───────────────────────── */
check('a vehicle is its plate', idOf('vehicle', { plate: 'L46174' }) === 'L46174');
check('a driver is their provider id', idOf('driver', { driver_ext_id: 'd1', ids: ['d1', 'd2'] }) === 'd1');
check('a driver named without an id falls back to the ids array',
  idOf('driver', { ids: ['name:ali rahman'] }) === 'name:ali rahman');
check('every account of a person is gathered, de-duplicated',
  JSON.stringify(accountsOf({ driver_ext_id: 'd1', ids: ['d1', 'd2'] })) === '["d1","d2"]',
  JSON.stringify(accountsOf({ driver_ext_id: 'd1', ids: ['d1', 'd2'] })));
check('a person with no ids array still yields their one account',
  JSON.stringify(accountsOf({ driver_ext_id: 'd9' })) === '["d9"]');

/* ── a predicate that throws must not take the page down ─────────────────── */
{
  const saved = COHORTS['unit-still'].test;
  COHORTS['unit-still'].test = () => { throw new Error('boom'); };
  check('a predicate that throws excludes the row rather than the page',
    membersOf('unit-still', assets).length === 0);
  COHORTS['unit-still'].test = saved;
}

/* ── the pages actually use it ───────────────────────────────────────────── */
/* The point of one definition is defeated the moment a page re-derives a set
   inline. These are the three files whose tiles this replaces. */
for (const [file, key] of [
  ['api/public/economics.js', 'unit-drove-unpaid'],
  ['api/public/vehicle.js', 'vehicles-moved-no-booking'],
  ['api/public/roster.js', 'roster-blocked'],
]) {
  const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  check(`${file.split('/').pop()} links its tiles to the registry`, src.includes(key), '');
}
/* A fare and a payout are different measurements of different money, and for a
   channel that reports both the product drops one of them (chooseBasis, in
   api/economics_routes.js). Added together on a card, they produced "AED 79"
   for the one person on the fleet whose page is titled "drove and was paid
   nothing" — his booking is priced at zero and the 79 is a statement spanning
   31 days. The card states each source separately and totals neither. */
{
  const card = readFileSync(new URL('../api/public/cohort.js', import.meta.url), 'utf8');
  check('the member card never adds a fare to a payout',
    !/payout\s*\+\s*fares|fares\s*\+\s*payout/.test(card));
  check('and labels each with the source it came from',
    card.includes('Paid by statement') && card.includes('Fares charged'));
}
{
  const ui = readFileSync(new URL('../api/public/ui.js', import.meta.url), 'utf8');
  check('a tile carrying a cohort renders as a link', /a\.kpi|tag = to \? 'a'/.test(ui));
  const app = readFileSync(new URL('../api/public/app.js', import.meta.url), 'utf8');
  check('the router has a cohort view', app.includes('V.cohort'));
  check("and titles it rather than falling through to VIEWS[0]", app.includes("state.view === 'cohort'"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
