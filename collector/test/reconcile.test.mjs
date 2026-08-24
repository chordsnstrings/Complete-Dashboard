/* ── the reconciliation identity, month by month ───────────────────────────
   /api/reconcile exists so the operator can check the platform's numbers:
   bank payout ≈ on-trip net + tips + salik − cash collected, the identity the
   July 2026 ledger reconciliation proved to 0.7%. These tests are about the
   ways that page could lie: the ledger slice leaking into a displayed figure
   (checking the workbook against itself), an absent statement printing as an
   expected payout of zero (accusing the platform of not paying), the delta
   losing its sign, or the daily drill disagreeing with the month it drills
   into. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const { server, get } = await mountAll(db);

/* ── fixture: one August that reconciles, one July that cannot ──────────── */
// Bookings, and one telematics twin that must not count as a trip.
let n = 0;
const trip = (platform, at) => db.query(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, status)
   VALUES ($1, $2, 'ecosine', 'L100', 'u-amina', 'Amina Rashid', $3, 'completed')`,
  [platform, `t${n++}`, at]);
for (const at of ['2026-08-03T10:00:00+04:00', '2026-08-03T14:00:00+04:00',
  '2026-08-03T19:00:00+04:00', '2026-08-04T09:00:00+04:00', '2026-08-04T18:00:00+04:00']) {
  await trip('uber', at);
}
await trip('fms', '2026-08-03T10:05:00+04:00');
await trip('uber', '2026-07-15T10:00:00+04:00');
await trip('uber', '2026-07-15T15:00:00+04:00');

// The statement view: two API-sourced days, and a ledger day that must never
// surface — the workbook taught the identity and cannot also verify it.
const stmt = (day, net, tips, salik, cash, source) => db.query(
  `INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day,
     net, tips, salik, cash, source, pseudo)
   VALUES ('uber', 'ecosine', 'Amina Rashid', 'u-amina', $1, $2, $3, $4, $5, $6, false)`,
  [day, net, tips, salik, cash, source]);
await stmt('2026-08-03', 370, 10, 12, 80, 'uber_rest');
await stmt('2026-08-04', 296, 0, 8, 60, 'uber_rest');
await stmt('2026-08-03', 99999, 0, 0, 0, 'ledger');

// The bank view: resolved payout days. July has a payout and NO statement, so
// its expected side is unknowable.
const pay = (day, earnings) => db.query(
  `INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
     period_start, period_end, earnings, cash_earnings)
   VALUES ('uber', 'ecosine', 'u-amina', 'Amina Rashid', $1, $1, $1, $2, 0)`,
  [day, earnings]);
await pay('2026-08-03', 300);
await pay('2026-08-04', 250);
await pay('2026-07-15', 400);

console.log('\nthe monthly identity');

const m = (await get('/api/reconcile')).body;
check('the endpoint answers at month grain', m.grain === 'month' && m.month === null,
  JSON.stringify([m.grain, m.month]));
check('and says where the trip counts came from', m.trips_source === 'live', m.trips_source);
const aug = (m.rows || []).find((r) => r.m === '2026-08');
const jul = (m.rows || []).find((r) => r.m === '2026-07');
check('both months are rows', !!aug && !!jul, JSON.stringify((m.rows || []).map((r) => r.m)));
check('trips are bookings only — the telematics twin does not count',
  aug.trips === 5 && jul.trips === 2, JSON.stringify([aug.trips, jul.trips]));

check('the ledger slice never surfaces: on-trip net is the API days alone',
  Number(aug.ontrip_net) === 666, String(aug.ontrip_net));
check('tips, salik and cash sum per month',
  Number(aug.tips) === 10 && Number(aug.salik) === 20 && Number(aug.cash_collected) === 140,
  JSON.stringify([aug.tips, aug.salik, aug.cash_collected]));
// 666 + 10 + 20 − 140 = 556: the identity, computed not asserted.
check('expected payout is net + tips + salik − cash',
  aug.expected_payout === 556, String(aug.expected_payout));
check('the bank side is the payout-day sum', Number(aug.bank_payout) === 550,
  String(aug.bank_payout));
check('delta is bank minus expected, sign preserved',
  aug.delta === -6, String(aug.delta));
check('and is stated as a share of the expectation',
  Math.abs(aug.delta_pct - -1.1) < 0.05, String(aug.delta_pct));

console.log('\nabsence is not zero');

check('a month with a payout and no statement has a null expectation, not 0',
  jul.ontrip_net === null && jul.expected_payout === null && jul.expected_payout !== 0,
  JSON.stringify([jul.ontrip_net, jul.expected_payout]));
check('so its delta is null too — one side of it is unknowable',
  jul.delta === null && jul.delta_pct === null, JSON.stringify([jul.delta, jul.delta_pct]));
check('while its bank payout still shows', Number(jul.bank_payout) === 400,
  String(jul.bank_payout));

check('the totals gap covers only the rows holding both sides',
  m.totals.reconciled_rows === 1 && m.totals.delta === -6,
  JSON.stringify([m.totals.reconciled_rows, m.totals.delta]));
check('while the raw sums cover everything each side reported',
  Number(m.totals.bank_payout) === 950 && m.totals.expected_payout === 556,
  JSON.stringify([m.totals.bank_payout, m.totals.expected_payout]));
check('the response explains the identity in words', /cash collected/.test(m.note || ''),
  String(m.note).slice(0, 60));

console.log('\nthe daily drill');

const d = (await get('/api/reconcile?month=2026-08')).body;
check('the drill answers at day grain for the month asked',
  d.grain === 'day' && d.month === '2026-08', JSON.stringify([d.grain, d.month]));
check('and fills the whole calendar month', (d.rows || []).length === 31,
  String((d.rows || []).length));
const d3 = d.rows.find((r) => r.d === '2026-08-03');
const d4 = d.rows.find((r) => r.d === '2026-08-04');
const d20 = d.rows.find((r) => r.d === '2026-08-20');
check('a day carries the same identity: 370 + 10 + 12 − 80 = 312 expected',
  d3.expected_payout === 312 && Number(d3.bank_payout) === 300 && d3.delta === -12,
  JSON.stringify([d3.expected_payout, d3.bank_payout, d3.delta]));
check('the ledger day is excluded here too', Number(d3.ontrip_net) === 370,
  String(d3.ontrip_net));
check('a delta the other way keeps its positive sign',
  d4.expected_payout === 244 && d4.delta === 6, JSON.stringify([d4.expected_payout, d4.delta]));
check('a day nothing covers is dashes all the way down, never zeros',
  d20.trips === null && d20.ontrip_net === null && d20.expected_payout === null
  && d20.bank_payout === null && d20.delta === null, JSON.stringify(d20));
check('the drill agrees with the month it drills into',
  Math.round(d.rows.reduce((a, r) => a + (Number(r.ontrip_net) || 0), 0)) === 666
  && d.rows.reduce((a, r) => a + (Number(r.bank_payout) || 0), 0) === 550);
check('day trips are that day alone', d3.trips === 3 && d4.trips === 2,
  JSON.stringify([d3.trips, d4.trips]));

console.log('\nfilters and refusals');

const uber = (await get('/api/reconcile?platform=uber')).body;
const uberAug = (uber.rows || []).find((r) => r.m === '2026-08');
check('a platform filter narrows every side to that platform',
  uberAug && uberAug.expected_payout === 556 && Number(uberAug.bank_payout) === 550
  && uberAug.platform === 'uber', JSON.stringify(uberAug));
const bolt = (await get('/api/reconcile?platform=bolt')).body;
check('a platform with nothing on any side answers empty, not a table of zeros',
  Array.isArray(bolt.rows) && bolt.rows.length === 0, String((bolt.rows || []).length));
const bad = await get('/api/reconcile?month=2026-13');
check('a month that is not a month is refused, not passed to the database',
  bad.status === 400, String(bad.status));
const empty2 = (await get('/api/reconcile?month=2031-01')).body;
check('a month before or after the record answers empty rather than 31 blank rows',
  Array.isArray(empty2.rows) && empty2.rows.length === 0, String((empty2.rows || []).length));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
