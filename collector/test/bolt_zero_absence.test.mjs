/* ── zero is absence on the Bolt feed, not a measurement ───────────────────
   The portal writes 0 for a fare that was never charged and a distance never
   driven. 0 is not NULL, and has_fare in sql/schema_v18.sql is `price IS NOT
   NULL` — so every cancelled ride counted as a priced one.

   Measured on production over 365 days, after 48,210 Bolt orders landed:

     status                                     n   price 0   dist 0
     finished                              10,594         0        0
     driver_did_not_respond                 6,196     6,196    6,196
     client_cancelled                       5,567     5,567    5,567
     driver_rejected                        2,059     2,059    2,059
     driver_cancelled_after_accept          1,017     1,017    1,017
     optional_ride_driver_did_not_respond     908       908      908
     optional_ride_driver_rejected            626       626      626
     client_did_not_show                      310         -        310
     optional_ride_driver_cancelled_after_accept 163      163      163

   /api/kpis reported Bolt's average fare as AED 23.60. Its completed rides
   average AED 60.67. 61% low, because 16,846 of 27,440 rows were zeros in the
   denominator.

   The feed is CONSISTENT about it, which is what makes the rule safe and which
   was checked rather than assumed: of 51 live `finished` rows, none carries a
   zero price or a zero distance, and every one of the 48 non-completions
   carries both. client_did_not_show is the interesting case — the rider IS
   charged — and it comes back with a real price, so nulling only the zeros
   keeps the money. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { readFileSync } from 'node:fs';
import { pivot, portalRow } from '../src/sources/bolt.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nbolt: a fare that was never charged is not a fare of zero');

const C = { fleet: 'egari', companyId: 142897, userId: 174036 };
const FX = JSON.parse(readFileSync('test/fixtures/bolt_order_table.json', 'utf8'));
const rows = pivot(FX.data);
const mapped = rows.map((r) => portalRow(r, C));

/* ── the mapping ─────────────────────────────────────────────────────────── */
const done = mapped.filter((r) => r.status === 'finished');
const gone = mapped.filter((r) => r.status !== 'finished');
check('the fixture carries both kinds of row', done.length > 0 && gone.length > 0,
  `${done.length} finished, ${gone.length} not`);
check('a completed ride keeps its fare and its distance',
  done.every((r) => r.price > 0 && r.distance_km > 0),
  JSON.stringify(done.filter((r) => !(r.price > 0)).map((r) => r.price)));
check('a ride that never happened has NO fare, rather than a fare of zero',
  gone.every((r) => r.price === null || r.price > 0),
  JSON.stringify(gone.map((r) => r.price).filter((p) => p === 0)));
check('and NO distance, rather than a distance of zero',
  gone.every((r) => r.distance_km === null || r.distance_km > 0));
/* The whole point of nulling only the zeros: a no-show is charged, and that
   money must survive. */
const charged = rows.filter((r) => r.status !== 'finished' && Number(r.price) > 0);
check('money genuinely charged on a ride that did not run is kept',
  charged.length === 0
  || charged.every((r) => portalRow(r, C).price === Number(r.price)),
  `${charged.length} such rows in the fixture`);
/* Absence must be null, never undefined: a JSON round-trip drops undefined and
   the column then takes its default rather than NULL. */
check('absence is null, not undefined',
  mapped.every((r) => r.price !== undefined && r.distance_km !== undefined));

/* ── what the view then computes ─────────────────────────────────────────── */
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);

let seq = 0;
const put = (status, price, dist) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, status, price, distance_km, currency)
   VALUES ('bolt',$1,'egari','L00001','d1','D',$2,$3,$4,$5,'AED')`,
  [`b${++seq}`, '2026-08-20T09:00:00Z', status, price, dist]);

/* Production's own proportions, scaled: one priced completion against four
   cancellations, which is roughly 10,594 against 16,846. */
await put('finished', 60.67, 11.5);
await put('client_cancelled', null, null);
await put('driver_did_not_respond', null, null);
await put('driver_rejected', null, null);
await put('optional_ride_driver_rejected', null, null);
/* And the no-show, which carries real money. */
await put('client_did_not_show', 12.5, null);

const [f] = await q(
  `SELECT round(avg(price) FILTER (WHERE is_booking AND has_fare), 2) avg_fare,
          count(*) FILTER (WHERE has_fare)::int priced,
          count(*)::int n FROM trip_norm WHERE platform = 'bolt'`);
check('only the rows that carry money count as priced',
  f.priced === 2 && f.n === 6, JSON.stringify(f));
check('so the average fare is the fare of the rides that were paid for',
  Number(f.avg_fare) === 36.59, String(f.avg_fare));
/* The shipped bug, stated as arithmetic: with the zeros present the same six
   rows average 12.19 instead of 36.59 — a third of the truth, from four rows
   that were never priced at all. */
check('and it is not the average over rides nobody paid for',
  Number(f.avg_fare) !== +(73.17 / 6).toFixed(2), String(f.avg_fare));

/* ── the outcome vocabulary ──────────────────────────────────────────────── */
const out = await q(
  `SELECT outcome, count(*)::int n FROM trip_norm WHERE platform='bolt' GROUP BY 1 ORDER BY 1`);
const byOutcome = Object.fromEntries(out.map((r) => [r.outcome ?? 'null', r.n]));
check('an optional_ride_ variant is a cancellation, not "other"',
  !('other' in byOutcome), JSON.stringify(byOutcome));
check('every non-completion is counted as one',
  byOutcome.not_completed === 5 && byOutcome.completed === 1, JSON.stringify(byOutcome));

/* Each real status the portal serves, one at a time, so a vocabulary change is
   a failing assertion rather than a diluted percentage. */
const VOCAB = [
  ['finished', 'completed'],
  ['driving_with_client', 'other'],          // in progress: not yet an outcome
  ['client_cancelled', 'not_completed'],
  ['driver_cancelled_after_accept', 'not_completed'],
  ['driver_did_not_respond', 'not_completed'],
  ['driver_rejected', 'not_completed'],
  ['client_did_not_show', 'not_completed'],
  ['offer_rejected', 'not_completed'],
  ['optional_ride_driver_did_not_respond', 'not_completed'],
  ['optional_ride_driver_rejected', 'not_completed'],
  ['optional_ride_driver_cancelled_after_accept', 'not_completed'],
];
for (const [status, want] of VOCAB) {
  await q(`INSERT INTO trip (platform, external_id, fleet_id, requested_at, status)
           VALUES ('bolt',$1,'egari','2026-08-21T09:00:00Z',$2)`, [`v-${status}`, status]);
}
const got = await q(
  `SELECT status, outcome FROM trip_norm WHERE external_id LIKE 'v-%' ORDER BY status`);
const map = Object.fromEntries(got.map((r) => [r.status, r.outcome]));
for (const [status, want] of VOCAB) {
  check(`  ${status} -> ${want}`, map[status] === want, `got ${map[status]}`);
}

/* ── the cancellation rate the operator reads ────────────────────────────── */
const [rate] = await q(
  `SELECT round(100.0 * count(*) FILTER (WHERE outcome='not_completed')
                / nullif(count(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) pct
     FROM trip_norm WHERE platform='bolt' AND external_id LIKE 'v-%'`);
/* Of the eleven states the portal serves, one is a completion, one is a ride
   still in progress, and NINE are non-completions — three of them the
   optional_ride_ variants that used to fall into 'other'. driving_with_client
   stays in the denominator because a ride in progress is a booking; it is just
   not yet an outcome. 9 of 11. */
check('the cancellation rate counts every non-completion',
  Number(rate.pct) === 81.8, String(rate.pct));
/* And the three variants are what moves it. Excluding them from the numerator,
   as the shipped view did, gives 6 of 11 — the same shape as production's
   55.8% against the true 61.4%. */
const [without] = await q(
  `SELECT round(100.0 * count(*) FILTER (WHERE outcome='not_completed'
            AND status NOT LIKE 'optional_ride_%')
                / nullif(count(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) pct
     FROM trip_norm WHERE platform='bolt' AND external_id LIKE 'v-%'`);
check('and leaving the optional_ride_ variants out understates it',
  Number(without.pct) < Number(rate.pct),
  `${without.pct} against ${rate.pct}`);

/* ── and the source asks for every state ────────────────────────────────── */
const SRC = readFileSync('src/sources/bolt.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the request no longer carries a hand-kept state list',
  /const PORTAL_STATES = \[\];/.test(SRC),
  'an empty list means every state — measured 402 orders against the six-state list’s 401');
check('and the zeros are nulled at the one place they enter',
  /price: money\(o\.price\)/.test(SRC) && /distance_km: money\(o\.distance\)/.test(SRC));
check('the rule is stated once, not per field',
  (SRC.match(/const money = /g) || []).length === 1);

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
