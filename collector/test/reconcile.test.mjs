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

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
