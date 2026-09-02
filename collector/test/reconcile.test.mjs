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
import { readFileSync } from 'node:fs';
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

console.log('\ncoverage: two sides that reach back different distances');

/* The failure this page shipped with, caught the moment it met production
   data. The statement surface reaches back weeks; the payout record reaches
   back months. Compared whole-month against whole-month, August held one week
   of statement against a full month of bank payouts and reported the platform
   overpaying by 1,449% — a number with no meaning, on the page whose entire
   job is telling the operator whether the money is right.

   The delta is therefore measured over the days BOTH sides describe. The full
   bank figure stays in the row, because that is the month's real money. */
{
  // A month with payouts every day and statement rows for only two of them.
  for (const d of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']) {
    await pay(`2026-06-${d}`, 500);
  }
  await stmt('2026-06-01', 400, 8, 4, 80, 'uber_rest');
  await stmt('2026-06-02', 400, 8, 4, 80, 'uber_rest');

  const r = await get('/api/reconcile');
  const jun = r.body.rows.find((x) => x.m === '2026-06');
  check('the row still reports the whole month of bank money',
    jun.bank_payout === 5000, String(jun.bank_payout));
  check('and names the part of it the comparison could test',
    jun.bank_covered === 1000, String(jun.bank_covered));
  /* expected = (400+400) + 16 + 8 − 160 = 664, against 1000 of covered bank. */
  check('the delta compares like with like', jun.delta === 336, String(jun.delta));
  check('so a partly-covered month reads as a percentage, not a catastrophe',
    Math.abs(jun.delta_pct) < 100, String(jun.delta_pct));
  check('a whole-month comparison would have said something absurd',
    Math.round(((5000 - 664) / 664) * 100) > 600, 'guard: the old arithmetic really was that wrong');
  check('the totals carry the covered figure too',
    r.body.totals.bank_covered != null && r.body.totals.bank_covered <= r.body.totals.bank_payout,
    JSON.stringify([r.body.totals.bank_covered, r.body.totals.bank_payout]));
}

console.log('\ncoverage: two sides that name different PEOPLE on the same day');

/* The fault the day-level fix left behind, and the one the operator actually
   met. A covered day is not a comparable day: the statement names SOME of the
   fleet's drivers and the bank figure for that day names ALL of them. August
   2026 held AED 18,116 of on-trip net for fifty-three drivers beside AED
   35,858 of bank money covering a hundred and eighty-nine, and the page called
   the difference a 153% gap. Nothing was missing. The two sides were answering
   about different people. */
const stmtFor = (name, id, day, net, tips, salik, cash) => db.query(
  `INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day,
     net, tips, salik, cash, source, pseudo)
   VALUES ('uber', 'ecosine', $1, $2, $3, $4, $5, $6, $7, 'uber_rest', false)`,
  [name, id, day, net, tips, salik, cash]);
const payFor = (name, id, day, earnings) => db.query(
  `INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
     period_start, period_end, earnings, cash_earnings)
   VALUES ('uber', 'ecosine', $1, $2, $3, $3, $3, $4, 0)`, [id, name, day, earnings]);
{
  // One day, three drivers paid, one of them on the statement.
  await payFor('Bilal Haq', 'u-bilal', '2026-05-10', 500);
  await payFor('Carla Diaz', 'u-carla', '2026-05-10', 400);
  await payFor('Dan Osei', 'u-dan', '2026-05-10', 300);
  await stmtFor('Bilal Haq', 'u-bilal', '2026-05-10', 380, 10, 6, 40);

  const may = (await get('/api/reconcile')).body.rows.find((x) => x.m === '2026-05');
  check('the row still reports the whole month of bank money',
    Number(may.bank_payout) === 1200, String(may.bank_payout));
  check('and the whole month of on-trip net', Number(may.ontrip_net) === 380,
    String(may.ontrip_net));
  // 380 + 10 + 6 − 40 = 356, against Bilal's own 500 — not against all 1,200.
  check('the comparison is per driver-day, not per day',
    may.expected_covered === 356 && may.bank_covered === 500,
    JSON.stringify([may.expected_covered, may.bank_covered]));
  check('so the delta is the difference of exactly those two figures',
    may.delta === 144 && Math.abs(may.delta_pct - 40.4) < 0.05,
    JSON.stringify([may.delta, may.delta_pct]));
  check('and the row says how much of the day it could speak for',
    may.matched_drivers === 1 && may.bank_drivers === 3 && may.matched_days === 1
    && may.matched_pairs === 1 && may.ontrip_drivers === 1, JSON.stringify(may));
  check('comparing the whole covered day would have said something absurd',
    Math.round(((1200 - 356) / 356) * 100) > 200,
    'guard: the day-level comparison really was that wrong');
}

console.log('\none human, two platform accounts');

/* src/rollup.js folds a person's several Uber accounts into ONE statement row
   and keeps one of their ids, so joining the two sides on driver_ext_id would
   drop the other account's payouts and re-open the same gap under a different
   name. The join key is personKey — the fold the driver and vehicle pages
   already resolve people by — so the two accounts land on the one person. */
{
  await payFor('Sara  Ghulam Qadir', 'u-sara-a', '2026-04-05', 200);
  await payFor('sara ghulam qadir', 'u-sara-b', '2026-04-05', 150);
  await stmtFor('Sara Ghulam Qadir', 'u-sara-a', '2026-04-05', 300, 0, 0, 0);

  const apr = (await get('/api/reconcile')).body.rows.find((x) => x.m === '2026-04');
  check('both accounts count as the one person the statement names',
    apr.bank_covered === 350 && apr.matched_drivers === 1 && apr.bank_drivers === 1,
    JSON.stringify([apr.bank_covered, apr.matched_drivers, apr.bank_drivers]));
  check('and the delta is measured against both halves of their money',
    apr.expected_covered === 300 && apr.delta === 50,
    JSON.stringify([apr.expected_covered, apr.delta]));
  check('an id join would have compared against 200 and invented a shortfall',
    apr.bank_covered !== 200, 'guard: the id join is the tempting wrong answer');
}

console.log('\nthe scope is stated, not implied');

/* The page carrying this kept the dashboard's range selector on screen while
   the endpoint ignored it, so "Last 30 days" sat above a trips figure counting
   every trip the fleet has ever taken and a table running Aug 2025 to Aug 2026.
   The answer was right and the label was a lie. */
{
  const all = (await get('/api/reconcile')).body;
  check('the month view says it covers every month on record',
    all.scope.kind === 'all-time' && /every month/.test(all.scope.label),
    JSON.stringify(all.scope));
  check('and names the span its rows actually run over',
    all.scope.from === '2026-04-01' && all.scope.to === '2026-08-31'
    && all.scope.rows === all.rows.length, JSON.stringify(all.scope));

  const windowed = (await get('/api/reconcile?from=2026-08-01&to=2026-08-31')).body;
  check('a window a caller passes changes nothing — and the answer still says so',
    windowed.scope.kind === 'all-time' && windowed.rows.length === all.rows.length,
    JSON.stringify([windowed.scope.kind, windowed.rows.length, all.rows.length]));
  check('the totals are the sum of the rows below them, one scope for both',
    windowed.totals.trips === all.totals.trips
    && windowed.totals.bank_payout === all.totals.bank_payout,
    JSON.stringify([windowed.totals.trips, all.totals.trips]));

  const drill = (await get('/api/reconcile?month=2026-08')).body;
  check('a drill says it covers that month and nothing else',
    drill.scope.kind === 'month' && drill.scope.from === '2026-08-01'
    && drill.scope.to === '2026-08-31', JSON.stringify(drill.scope));
  check('the totals carry both sides of what was compared',
    all.totals.expected_covered != null && all.totals.bank_covered != null
    && all.totals.matched_pairs > 0,
    JSON.stringify([all.totals.expected_covered, all.totals.bank_covered,
      all.totals.matched_pairs]));
  check('and the headline gap is the difference of exactly those two',
    Math.abs(all.totals.delta - (all.totals.bank_covered - all.totals.expected_covered)) < 0.01,
    JSON.stringify([all.totals.delta, all.totals.bank_covered, all.totals.expected_covered]));
}

console.log('\nthe page cannot offer a control the endpoint does not honour');

{
  const appSrc = readFileSync('api/public/app.js', 'utf8');
  const uiSrc = readFileSync('api/public/reconcile.js', 'utf8');
  /* The three lists moved from the shell into api/public/data.js, because
     href() has to agree with them: an address must not carry a filter its
     destination page hides. The shell still does the hiding — it reads
     hidesRange()/hidesChannel() from there — so both halves are checked. */
  const dataSrc = readFileSync('api/public/data.js', 'utf8');
  check('the reconciliation view hides the range selector',
    /NO_RANGE = \[[^\]]*'reconcile'/.test(dataSrc)
    && /#fRange/.test(appSrc) && /hidesRange/.test(appSrc));
  check('while keeping the platform and fleet filters it does honour',
    !/NO_FILTER = \[[^\]]*'reconcile'/.test(dataSrc)
    && !/NO_PLATFORM_FLEET = \[[^\]]*'reconcile'/.test(dataSrc));
  check('and the page asks for nothing but month, platform and fleet',
    !/\bfrom=|\bdays=|state\.days/.test(uiSrc));
  check('the gap is presented as the difference of two named figures',
    /banked against/.test(uiSrc) && /expected_covered/.test(uiSrc));
  check('a row with no shared driver-day says so rather than showing a zero',
    /no driver-day on both sides/.test(uiSrc));
  check('and the note tells the truth about how far the on-trip side reaches',
    /current payment period/i.test(uiSrc) && !/last six months/.test(uiSrc),
    'the surface serves the current period, not six months');
}

/* ── days that have not happened, and a percentage over nearly nothing ────
   Two ways this page published arithmetic as fact.

   Uber's payout periods are weekly and driver_payout_day spreads a period
   evenly over ITS days, so on the 25th the table already holds rows for the
   26th through the 30th. Production served all five as reconciled days —
   byte-identical to the 25th except trips:null — and summed them into the
   month tiles.

   And on 2026-08-17 and 08-18, expected_covered was −9.91 against a
   bank_covered of 5,820.67, so delta_pct came back 58,835.3% in a column of
   single digits. */
console.log('\ndays that have not happened yet');

{
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const [y, m] = today.split('-');
  const month = `${y}-${m}`;
  const dayIn = (offset) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  /* Only run where the accrual can actually land inside the current month —
     on the 30th, "three days from now" is next month and there is nothing to
     assert here. */
  const ahead = dayIn(3);
  if (ahead.slice(0, 7) === month) {
    await stmt(today, 400, 0, 0, 0, 'uber_rest');
    await pay(today, 380);
    // The forward projection of the same payout period.
    await pay(ahead, 380);
    await db.query(
      `INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day,
         net, tips, salik, cash, source, pseudo)
       VALUES ('uber','ecosine','Amina Rashid','u-amina',$1,400,0,0,0,'uber_rest',false)`,
      [ahead]);

    const d = (await get(`/api/reconcile?month=${month}`)).body;
    const future = d.rows.find((r) => r.d === ahead);
    const now = d.rows.find((r) => r.d === today);
    check('a row for a day that has not happened is marked as an accrual',
      future?.accrual === true, JSON.stringify(future));
    check('and today is not', now?.accrual === false, JSON.stringify(now && now.accrual));
    check('an accrued day carries no delta — both sides of it are the same projection',
      future?.delta === null && future?.delta_pct === null, JSON.stringify(future));
    check('the money is still shown rather than deleted, because it was reported',
      Number(future?.bank_payout) === 380, String(future?.bank_payout));
    check('but the month tiles exclude it, where they used to be inflated by it',
      Number(d.totals.bank_payout) === Number(
        d.rows.filter((r) => !r.accrual).reduce((a, r) => a + (Number(r.bank_payout) || 0), 0)),
      JSON.stringify({ tile: d.totals.bank_payout, accrued: future?.bank_payout }));
    check('and the count of excluded rows is stated rather than left to be noticed',
      d.totals.accrual_rows >= 1, String(d.totals.accrual_rows));
  } else {
    check('accrual check skipped — today is too near the month end to place a future day',
      true, ahead);
  }
}

console.log('\na percentage needs a base worth dividing by');

{
  /* The exact production shape: a tiny NEGATIVE expectation under a real bank
     payout. 5830.58 / 9.91 is 58,835%, and it was printed. */
  await stmt('2026-06-17', -9.91, 0, 0, 0, 'uber_rest');
  await pay('2026-06-17', 5820.67);
  await stmt('2026-06-18', 400, 10, 0, 20, 'uber_rest');
  await pay('2026-06-18', 420);
  const d = (await get('/api/reconcile?month=2026-06')).body;
  const bad = d.rows.find((r) => r.d === '2026-06-17');
  const good = d.rows.find((r) => r.d === '2026-06-18');
  check('a delta over a negative expectation reports no percentage',
    bad && bad.delta != null && bad.delta_pct === null,
    JSON.stringify({ delta: bad?.delta, pct: bad?.delta_pct, base: bad?.expected_covered }));
  check('the delta itself survives — the money is real, the ratio is not',
    Number(bad?.delta) > 5000, String(bad?.delta));
  check('a healthy day still reports its percentage',
    good && good.delta_pct != null, JSON.stringify({ pct: good?.delta_pct }));
  check('and no row in the month carries a percentage above 1000',
    d.rows.every((r) => r.delta_pct == null || Math.abs(r.delta_pct) <= 1000),
    JSON.stringify(d.rows.filter((r) => r.delta_pct != null).map((r) => [r.d, r.delta_pct])));
}

/* ── the bank side is a SEMI-join, not a join ─────────────────────────────
   The covered figures ask "what did the bank pay on days a statement covers".
   That was written as a correlated EXISTS against a CTE, which carries no
   index — Postgres re-scanned the whole statement fold once per payout row,
   and /api/reconcile answered in 10.0 seconds cold on production, on every
   window, because the endpoint is all-time whatever range it is given.
   bin/render-audit.mjs escalated it from "slow-panel" to "blank-page: no kpi,
   table, chart or panel" when the page's settle window expired first.

   The rewrite is a join over the DISTINCT (platform, day) pairs. The DISTINCT
   is the whole difference between a semi-join and a fan-out, and the fixture
   above cannot tell them apart because it has one statement row per day — so
   this seeds a day carrying THREE, where a plain join multiplies the payout by
   three and the covered total silently triples. */
{
  /* The month already carries a covered day of its own, so the assertions are
     on the DELTA this one day adds — an absolute total would be a test of the
     fixture above rather than of the join. */
  const before = ((await get('/api/reconcile')).body.rows || [])
    .find((x) => x.m === '2026-05' && x.platform === '*') || {};
  const day = '2026-05-12';
  for (const who of ['Amina Rashid', 'Bilal Noor', 'Chandra Rao']) {
    await db.query(
      `INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day,
         net, tips, salik, cash, source, pseudo)
       VALUES ('uber', 'ecosine', $1, $2, $3, 100, 0, 0, 0, 'uber_rest', false)`,
      [who, who === 'Amina Rashid' ? 'u-fanout' : `u-${who.split(' ')[0].toLowerCase()}`, day]);
  }
  /* ONE payout row on that day, for one of the three. */
  await db.query(
    `INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
       period_start, period_end, earnings, cash_earnings)
     VALUES ('uber', 'ecosine', 'u-fanout', 'Amina Rashid', $1, $1, $1, 210, 0)`, [day]);

  const after = ((await get('/api/reconcile')).body.rows || [])
    .find((x) => x.m === '2026-05' && x.platform === '*');
  const grew = (f) => Number(after?.[f] || 0) - Number(before[f] || 0);
  check('the month with three statement rows on one day is reported', !!after,
    JSON.stringify(before));
  /* 210 once. A plain join over the three statement rows adds 630. */
  check('the bank side counts each payout once, not once per statement row',
    after && Math.abs(grew('bank_covered') - 210) < 0.01,
    `bank_covered ${before.bank_covered} → ${after?.bank_covered}, `
    + `a rise of ${grew('bank_covered')} — 630 means the semi-join became a fan-out`);
  check('…and one payout matching one statement row is one pair',
    grew('matched_pairs') === 1,
    `matched_pairs ${before.matched_pairs} → ${after?.matched_pairs}`);
  /* The expected side is joined on the PERSON as well as the day, so the two
     drivers the bank did not pay that day add nothing: one row, 100 net. */
  check('the statement side counts only the person the bank paid',
    after && Math.abs(grew('expected_covered') - 100) < 0.01,
    `expected_covered ${before.expected_covered} → ${after?.expected_covered}`);
}

/* ── a month's gap is measured over days that have HAPPENED ───────────────
   The day grain has excluded Uber's forward projection since the accrual flag
   went in, and the month column names the accrued part beside itself. The two
   COVERED figures — the ones the delta is the difference of — were computed
   over every row in the month, future included, so a month row and the day
   view it drills into measured the same gap over different spans.

   Measured on production 2026-09-02: September's month row reported the gap
   over six days, four of them dated 3-6 September, carrying AED 26,852.52 of
   bank_covered and AED 12,542.96 of expected_covered that nobody had earned
   yet. Clicking the row measured two days. The two views of one month
   disagreed by AED 14,309.56 and neither said why. */
console.log('\nthe month grain measures what has happened, like the day grain');

{
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const month = today.slice(0, 7);
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3);
  const ahead = d.toISOString().slice(0, 10);
  if (ahead.slice(0, 7) === month) {
    /* The fixture the accrual block above already laid down: one driver, one
       statement day and one payout row on today, and the same pair on a day
       three days out — the forward projection of the open weekly period. */
    const all = (await get('/api/reconcile')).body;
    const row = all.rows.find((r) => r.m === month);
    const day = (await get(`/api/reconcile?month=${month}`)).body;
    const settled = day.rows.filter((r) => !r.accrual);
    check('the month column still reports every dirham reported, future included',
      Number(row.bank_payout) === 760 && row.expected_payout === 800,
      JSON.stringify([row.bank_payout, row.expected_payout]));
    check('but the two figures the gap is made of stop at today',
      row.expected_covered === 400 && row.bank_covered === 380,
      JSON.stringify([row.expected_covered, row.bank_covered]));
    check('so the month row and the day view measure the same span',
      row.matched_days === settled.filter((r) => r.matched_days).length
      && row.matched_days === 1, JSON.stringify([row.matched_days,
        settled.filter((r) => r.matched_days).length]));
    check('and the month gap equals the settled days it drills into',
      Math.abs(row.delta - settled.reduce((a2, r) => a2 + (r.delta || 0), 0)) < 0.01,
      JSON.stringify([row.delta, settled.map((r) => [r.d, r.delta])]));
    check('counting the projection would have inflated the gap by half again',
      Math.abs((760 - 800) - row.delta) > 1,
      'guard: whole-month covered figures really did include the future');
  } else {
    check('month-accrual check skipped — today is too near the month end', true, ahead);
  }
}

/* ── which report window a figure was measured over ───────────────────────
   Both money tables spread a provider's report evenly across the days it
   covers and record the divisor (sql/schema_v23.sql, sql/schema_v44.sql). The
   endpoint dropped that on the floor, so a seventh of a week and a measured
   day printed identically.

   That is not cosmetic. src/sources/uber.js asks the payout surface day by day
   only as far back as EARNER_DAY_HORIZON = 200 days, and on 2026-09-02 that
   lands on 2026-02-14: February's payout column carries AED 3,799.61 on each
   of 9-14 February (one weekly report, spread) and AED 25,998.71 on the 15th
   (that day, measured). The week was reported once as AED 26,597.27 and its
   resolved days sum to AED 48,796.37. Until the resolution stops mixing the
   two grids the least this page can do is say that the row does. */
console.log('\nthe report window a figure was measured over');

const stmtSpread = (day, net, days) => db.query(
  `INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day,
     net, tips, salik, cash, source, pseudo, period_days)
   VALUES ('uber', 'ecosine', 'Amina Rashid', 'u-amina', $1, $2, 0, 0, 0, 'uber_rest', false, $3)`,
  [day, net, days]);
const paySpread = (day, earnings, days) => db.query(
  `INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
     period_start, period_end, period_days, earnings, cash_earnings)
   VALUES ('uber', 'ecosine', 'u-amina', 'Amina Rashid', $1, $1, $1, $3, $2, 0)`,
  [day, earnings, days]);
{
  // A week of statement, filed as one 7-day report and spread across its days.
  for (let i = 9; i <= 15; i += 1) {
    await stmtSpread(`2026-03-${String(i).padStart(2, '0')}`, 100, 7);
    // The payout side: six days of the same weekly report…
    if (i < 15) await paySpread(`2026-03-${String(i).padStart(2, '0')}`, 110, 7);
  }
  // …and one day the collector's daily grid actually reached. This is the seam.
  await paySpread('2026-03-15', 800, 1);

  const mar = (await get('/api/reconcile')).body.rows.find((r) => r.m === '2026-03');
  check('the on-trip side names the report window behind it',
    mar.expected_period_days === 7 && mar.expected_period_days_min === 7,
    JSON.stringify([mar.expected_period_days_min, mar.expected_period_days]));
  check('and the bank side says it MIXES a measured day with a spread week',
    mar.bank_period_days === 7 && mar.bank_period_days_min === 1,
    JSON.stringify([mar.bank_period_days_min, mar.bank_period_days]));

  const days = (await get('/api/reconcile?month=2026-03')).body.rows;
  const spread = days.find((r) => r.d === '2026-03-14');
  const measured = days.find((r) => r.d === '2026-03-15');
  check('a day carries its own basis, not the month\u2019s',
    spread.bank_period_days === 7 && measured.bank_period_days === 1,
    JSON.stringify([spread.bank_period_days, measured.bank_period_days]));
  check('the seam is visible as two bases on neighbouring days, not as a fault',
    spread.bank_period_days !== measured.bank_period_days
    && Number(measured.bank_payout) > Number(spread.bank_payout) * 5,
    JSON.stringify([spread.bank_payout, measured.bank_payout]));
  check('a row nothing reported a window for says so with null, not 1',
    days.find((r) => r.d === '2026-03-20').bank_period_days === null,
    JSON.stringify(days.find((r) => r.d === '2026-03-20')));
}

/* ── the caption that under-fired ─────────────────────────────────────────
   "N days here repeat the figures of the day before" is the sentence that
   stops a reader reconciling one seventh of a week seven times. It demanded
   the bank column AND the on-trip column repeat together — and the two sides
   are collected on different grids, so the moment the payout side gains a
   daily measurement the statement beside it is still a seventh of a week and
   the caption goes quiet on exactly the rows that need it.

   The rows below are September 2026 as production served it on 2026-09-02:
   one weekly statement across six days, with daily payout measurements on the
   first two. Five days repeat the expected side; the caption said three. On
   February 2026 the same rule counted six where eighteen days repeat. */
console.log('\nthe repeat caption counts either side, not both');

{
  /* Imported rather than re-implemented: the caption is the page's rule, and a
     test carrying its own copy would keep passing while the page under-fired.
     Guarded so the run before the fix reports a missing rule as a failure
     rather than an exception. */
  const mod = await import('../api/public/reconcile.js');
  const spreadRuns = typeof mod.spreadRuns === 'function' ? mod.spreadRuns
    : () => ({ expected: 0, bank: 0, either: 0 });
  const sep = [
    { d: '2026-09-01', expected_payout: 3135.73, bank_payout: 19581.44 },
    { d: '2026-09-02', expected_payout: 3135.73, bank_payout: 8902.19 },
    { d: '2026-09-03', expected_payout: 3135.73, bank_payout: 6757.56 },
    { d: '2026-09-04', expected_payout: 3135.73, bank_payout: 6757.56 },
    { d: '2026-09-05', expected_payout: 3135.73, bank_payout: 6757.56 },
    { d: '2026-09-06', expected_payout: 3135.73, bank_payout: 6757.56 },
  ];
  const runs = spreadRuns(sep);
  const bothSides = sep.filter((r, i) => i > 0
    && r.bank_payout === sep[i - 1].bank_payout
    && r.expected_payout === sep[i - 1].expected_payout).length;
  check('every day after the first repeats the expected side',
    runs.expected === 5, String(runs.expected));
  check('and the bank side repeats only where the daily grid has not reached',
    runs.bank === 3, String(runs.bank));
  check('so the caption fires on five days, not the three both sides share',
    runs.either === 5 && bothSides === 3, JSON.stringify([runs.either, bothSides]));

  const blanks = [
    { d: '2026-04-01', expected_payout: null, bank_payout: null },
    { d: '2026-04-02', expected_payout: null, bank_payout: null },
  ];
  check('two blank days repeat nothing — they are two absences, not one report',
    spreadRuns(blanks).either === 0, JSON.stringify(spreadRuns(blanks)));

  const uiSrc2 = readFileSync('api/public/reconcile.js', 'utf8');
  check('and the sentence names which side repeated, since they can differ',
    /on the expected side/.test(uiSrc2) && /on the bank side/.test(uiSrc2));
  check('the page prints the report window beside the money it qualifies',
    /bank_period_days/.test(uiSrc2) && /expected_period_days/.test(uiSrc2)
    && /reports mixed/.test(uiSrc2));
}

/* ── a colour that never varies is not a colour ──────────────────────────
   The endpoint's own note states a floor: Uber's supplier breakdown does not
   itemise the reimbursements — Salik, surcharges, airport fees — that the
   payout already contains, so on a month served only by GraphQL the expected
   side is missing money the bank side has, and the note puts that at 12-14%.
   A row whose salik column is empty is exactly such a month.

   Read from production 2026-09-02, every settled month was red: 12.8, 13.4,
   14.0, 14.2, 21.2, 28.2 per cent. Four of the six sat inside the band the
   page itself calls a floor, so red separated nothing — which is the one thing
   a colour has to do.

   Asserted on the RULE, in the module, rather than through a browser: the
   tone is a pure function of the row and testing it needs no DOM. */
console.log('\nthe gap is not coloured as a fault inside the floor the page documents');
{
  const mod = await import('../api/public/reconcile.js');
  const cls = (html) => (String(html).match(/class="pill([^"]*)"/) || [, ''])[1].trim();
  const title = (html) => (String(html).match(/title="([^"]*)"/) || [, ''])[1];
  const col = { render: mod.deltaPill };
  {
    const row = (delta_pct, salik) => ({ delta: 1000, delta_pct, salik, statement_partial: false });
    check('a month with no salik at the top of the documented floor is not red',
      cls(col.render(row(14.2, null))) === 'warn', cls(col.render(row(14.2, null))));
    check('…and one just past it is',
      cls(col.render(row(21.2, null))) === 'bad', cls(col.render(row(21.2, null))));
    check('…and the amber one says why it is amber',
      /floor at 12-14%/.test(title(col.render(row(14.2, null)))),
      title(col.render(row(14.2, null))));
    /* The floor is a consequence of salik being unseen. A month that HAS a
       salik figure has no such excuse and is judged as before. */
    check('a month that reports salik is judged at the ordinary thresholds',
      cls(col.render(row(14.2, 1441))) === 'bad', cls(col.render(row(14.2, 1441))));
    check('…and a month that agrees closely is still green either way',
      cls(col.render(row(0.7, null))) === 'ok' && cls(col.render(row(0.7, 1441))) === 'ok',
      `${cls(col.render(row(0.7, null)))} / ${cls(col.render(row(0.7, 1441)))}`);
    /* An open report period is the other reason a delta is not a discrepancy:
       one side is a weekly report spread evenly and the other has measured the
       days that happened, so cutting both at today compares an average against
       a measurement. Production 2026-09-02 read +111.2% on driver-days where
       both sides describe the same 229 people. */
    check('a month still inside an open report period is grey, not red',
      cls(col.render({ delta: 16431, delta_pct: 111.2, salik: 1262, period_cut: true })) === 'dim',
      cls(col.render({ delta: 16431, delta_pct: 111.2, salik: 1262, period_cut: true })));
    check('…and says the two halves were cut where only one has a measurement',
      /average against a measurement/.test(
        title(col.render({ delta: 16431, delta_pct: 111.2, salik: 1262, period_cut: true }))),
      title(col.render({ delta: 16431, delta_pct: 111.2, salik: 1262, period_cut: true })));
    check('…while a closed month with the same size is still judged',
      cls(col.render({ delta: 16431, delta_pct: 111.2, salik: 1262, period_cut: false })) === 'bad',
      cls(col.render({ delta: 16431, delta_pct: 111.2, salik: 1262, period_cut: false })));
    /* And the horizon marking still wins: a month the provider will no longer
       answer about is grey whatever its size, floor or no floor. */
    check('a partial month stays grey rather than taking a floor colour',
      cls(col.render({ delta: 1000, delta_pct: 81.4, salik: null, statement_partial: true,
        days_in_horizon: 7, days_total: 28 })) === 'dim',
      cls(col.render({ delta: 1000, delta_pct: 81.4, salik: null, statement_partial: true,
        days_in_horizon: 7, days_total: 28 })));
  }
}

/* ── the accrued slice is counted in days, like the column beside it ──────
   accrual_days was count(*) over driver_payout_day, which is one row per
   DRIVER per day. Production showed accrual_days 948 beside payout_days 6 —
   two columns of the same row counting different things under names that read
   alike, and the page rendering the larger one as a quantity of days. */
console.log('\nthe accrued days are days');
{
  /* The DUBAI day, because /api/reconcile bounds its accrual on the Dubai day
     and the block above seeds against the Dubai day too.
     ─────────────────────────────────────────────────────────────────────────
     This computed its month and its offsets in UTC. For twenty hours a day the
     two calendars agree and it passed; for the four hours after 20:00 UTC the
     Dubai date is a day ahead, so this block's "+3" and the earlier block's
     "+3" stopped naming the same day and the union of accrued days went from
     two to three. Measured at 2026-09-02 20:55Z: accrual_days 3, expected 2 —
     a test that only holds while the process clock happens to agree with the
     fleet's, in a file whose whole subject is which days count. */
  const dubaiDay = (offset = 0) => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const m = dubaiDay().slice(0, 7);
  const ahead = dubaiDay(3);
  if (ahead.slice(0, 7) === m) {
    /* Three drivers, two future days: six rows, two days. count(*) answers 6
       and only a DISTINCT count answers 2. The day three out is the one the
       block above already seeded, so the union across both is still two. */
    for (const who of ['a', 'b', 'c']) {
      for (const off of [2, 3]) {
        const d = dubaiDay(off);
        await db.query(
          `INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
             period_start, period_end, earnings, cash_earnings)
           VALUES ('uber','ecosine',$2,$2,$1,$1,$1,100,0)`, [d, `acc-${who}`]);
      }
    }
    const all = (await get('/api/reconcile')).body;
    const row = all.rows.find((r) => r.m === m);
    check('the accrued slice counts days, not driver-days',
      row && row.accrual_days === 2, JSON.stringify(row && [row.accrual_days, row.payout_days]));
    check('…and it is never larger than the payout days it is part of',
      row && row.accrual_days <= row.payout_days,
      JSON.stringify(row && [row.accrual_days, row.payout_days]));
    check('…while the money it names is the whole of those rows, not one of them',
      row && Number(row.bank_accrued) >= 600,
      JSON.stringify(row && row.bank_accrued));
  } else {
    check('accrual-day check skipped — three days from now is next month', true, ahead);
  }
}

/* ── a month the provider will no longer answer about is not a bad month ──
   Uber's earner-payments surface serves a rolling window measured at about
   192 days, so the statement half of this page gets thinner the further back a
   row reaches. A month with NO statement already says "outside Uber's 192-day
   window"; a month STRADDLING the edge said nothing, and its delta was printed
   in the same red as a settled month's.

   Measured on production 2026-09-02, where the edge falls on 22 February —
   February's expected side steps at exactly that date:

     9-15 Feb   expected  3,687/day   bank  3,800/day
     16-22 Feb  expected  8,894/day   bank 25,000/day
     23-28 Feb  expected 19,571/day   bank 24,000/day

   with the SAME 216 drivers on both sides throughout, so it is not a
   population difference and not an arithmetic fault. February read +81.4%
   beside settled months at +13%, and an operator reading that would go looking
   for AED 189,000 that was never missing. Nothing can re-fetch those
   statements; the only honest fix is to stop calling it a discrepancy. */
console.log('\na month outside the statement window says so');

{
  /* The fixture months all sit inside the rolling window, so the two branches
     that matter — wholly outside, and straddling the edge — would never fire.
     Seeded relative to the edge rather than at fixed dates, because the edge
     moves forward every day and a hardcoded February stops being the straddler
     the moment the calendar turns. */
  const horizon = (await get('/api/reconcile')).body.statement_horizon;
  const edgeDate = new Date(`${horizon.from}T12:00:00Z`);
  const at = (offsetDays) => {
    const d = new Date(edgeDate.getTime() + offsetDays * 864e5);
    return d.toISOString().slice(0, 10);
  };
  /* Two days inside the edge's own month and two before it, so that month
     straddles; and a month a good way behind it, which cannot. */
  await stmt(at(2), 400, 0, 0, 0, 'uber_rest');
  await pay(at(2), 420);
  await stmt(at(-3), 100, 0, 0, 0, 'uber_rest');
  await pay(at(-3), 380);
  await stmt(at(-70), 90, 0, 0, 0, 'uber_rest');
  await pay(at(-70), 350);

  const all = (await get('/api/reconcile')).body;
  const straddleMonth = horizon.from.slice(0, 7);
  const outsideMonth = at(-70).slice(0, 7);
  check('the month holding the edge is present to be judged',
    all.rows.some((r) => r.m === straddleMonth), straddleMonth);
  check('and a month behind it is too',
    all.rows.some((r) => r.m === outsideMonth), outsideMonth);
  check('the response names the edge rather than leaving 192 to be worked out',
    all.statement_horizon && all.statement_horizon.days === 192
    && /^\d{4}-\d{2}-\d{2}$/.test(String(all.statement_horizon.from)),
    JSON.stringify(all.statement_horizon));

  const edge = all.statement_horizon.from;
  for (const r of all.rows) {
    const first = `${r.m}-01`;
    const last = `${r.m}-31`;
    /* Entirely before the edge, entirely after, or straddling it — the flag
       has to agree with the dates in all three cases, not just the easy two. */
    if (last < edge) {
      check(`${r.m} is wholly outside the window and says so`,
        r.statement_partial === true && r.days_in_horizon === 0,
        JSON.stringify([r.days_in_horizon, r.days_total, r.statement_partial]));
    } else if (first >= edge) {
      check(`${r.m} is wholly inside the window and claims nothing`,
        r.statement_partial === false && r.days_in_horizon === r.days_total,
        JSON.stringify([r.days_in_horizon, r.days_total, r.statement_partial]));
    } else {
      check(`${r.m} straddles the edge and reports the fraction`,
        r.statement_partial === true
        && r.days_in_horizon > 0 && r.days_in_horizon < r.days_total,
        JSON.stringify([r.days_in_horizon, r.days_total, r.statement_partial]));
    }
  }

  /* The count must be a real count of days, not the month length or a
     constant: February's 7-of-28 is the entire content of the claim. */
  const straddler = all.rows.find((r) => r.statement_partial
    && r.days_in_horizon > 0 && r.days_in_horizon < r.days_total);
  if (straddler) {
    const [y, mo] = straddler.m.split('-').map(Number);
    const len = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    let expect = 0;
    for (let i = 1; i <= len; i++) {
      if (`${straddler.m}-${String(i).padStart(2, '0')}` >= edge) expect++;
    }
    check('…and the fraction is the days themselves, counted',
      straddler.days_in_horizon === expect && straddler.days_total === len,
      JSON.stringify([straddler.m, straddler.days_in_horizon, expect, straddler.days_total, len]));
  } else {
    check('no month straddles the edge today, so there is nothing to count',
      true, `edge ${edge}`);
  }

  /* A day is in or out; there is no fraction of a day. */
  const drill = (await get(`/api/reconcile?month=${all.rows[all.rows.length - 1].m}`)).body;
  check('a day is wholly in or wholly out, never a fraction',
    drill.rows.every((r) => r.days_total === 1 && (r.days_in_horizon === 0 || r.days_in_horizon === 1)),
    JSON.stringify(drill.rows.slice(0, 3).map((r) => [r.d, r.days_in_horizon, r.days_total])));
  check('…and its flag agrees with the edge',
    drill.rows.every((r) => r.statement_partial === (r.d < edge)),
    JSON.stringify(drill.rows.filter((r) => r.statement_partial !== (r.d < edge)).slice(0, 3)));
}

/* ── the headline must not sum the rows the page greyed ──────────────────
   This endpoint marks two kinds of row as not comparable and the page renders
   both grey: statement_partial (Uber will no longer serve part of that month's
   statement) and period_cut (the compared span cuts an open report period, so
   one side is an average and the other a measurement). The total at the top
   summed them anyway.

   Measured on production 2026-09-02, after the backfill filled February's bank
   side while its statement side stayed retention-limited:

     headline as shipped   expected 1,856,354  bank 2,380,282  gap 28.2%
     comparable months     expected 1,685,795  bank 1,975,176  gap 17.2%

   Eleven points, from two rows the page had already told the reader not to
   read as a discrepancy — February at a 139% gap that is the provider
   declining to answer, and September's open week. */
console.log('\nthe headline is measured over the rows it says are comparable');

{
  const all = (await get('/api/reconcile')).body;
  const rows = all.rows.filter((r) => r.delta != null);
  const grey = rows.filter((r) => r.statement_partial || r.period_cut);
  const good = rows.filter((r) => !r.statement_partial && !r.period_cut);

  check('the endpoint says how many rows it left out of the gap',
    all.totals.not_comparable_rows === grey.length,
    JSON.stringify([all.totals.not_comparable_rows, grey.length]));
  check('…and why, rather than dropping them silently',
    grey.length === 0 || (Array.isArray(all.totals.not_comparable_reasons)
      && all.totals.not_comparable_reasons.length > 0),
    JSON.stringify(all.totals.not_comparable_reasons));
  check('the rows it counted are exactly the comparable ones',
    all.totals.reconciled_rows === good.length,
    JSON.stringify([all.totals.reconciled_rows, good.length]));

  /* The load-bearing one: the two halves the Gap tile divides must cover the
     same rows the gap is measured over, or the tile disagrees with the
     percentage printed inside it. */
  const sum = (list, k) => Math.round(list.reduce((a, r) => a + (Number(r[k]) || 0), 0) * 100) / 100;
  check('expected_covered covers the comparable rows and no others',
    Math.abs((all.totals.expected_covered || 0) - sum(good, 'expected_covered')) < 0.05,
    JSON.stringify([all.totals.expected_covered, sum(good, 'expected_covered')]));
  check('…and so does bank_covered',
    Math.abs((all.totals.bank_covered || 0) - sum(good, 'bank_covered')) < 0.05,
    JSON.stringify([all.totals.bank_covered, sum(good, 'bank_covered')]));
  check('…so the gap is the difference of the two figures beside it',
    all.totals.delta == null
    || Math.abs(all.totals.delta - ((all.totals.bank_covered || 0) - (all.totals.expected_covered || 0))) < 0.05,
    JSON.stringify([all.totals.delta, all.totals.bank_covered, all.totals.expected_covered]));

  /* And a greyed row is still SHOWN — excluding it from the gap must not
     delete the money it reported, which is real and was really wired. */
  if (grey.length) {
    check('a row left out of the gap still reports its own money',
      grey.every((r) => r.bank_payout != null || r.expected_payout != null),
      JSON.stringify(grey.map((r) => [r.m, r.bank_payout])));
  } else {
    check('no row is currently outside the comparison', true, 'nothing greyed today');
  }
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
