/* THE TWO NEW PAYOUT ROUTES — the live per-day ask, and the read-only
   reconciliation of each wire against our own figure for the week it settles.
   ═══════════════════════════════════════════════════════════════════════════
   WHAT THESE ROUTES WERE BUILT TO CORRECT, so the assertions below have a
   subject. The Payouts page printed that this register and Bank reconciliation
   were "7.1% apart", citing our 110,962.09 for the week 7–13 Sep 2026 against
   a wire of 103,567.54. Both figures are real and they are not the same week:
   103,567.54 was paid on Monday 2026-09-07, and a Monday wire settles the
   Mon–Sun week that ENDED THE DAY BEFORE, so it settles 31 Aug – 6 Sep. The
   wire that settles 7–13 Sep is 111,179.66, paid on Monday 2026-09-14, and
   111,179.66 - 110,962.09 = 217.57, which is 0.20%. Seven percent was a
   wrong-week comparison, printed as a fact about the books.

   So the fixture below is the real, measured week. Every figure in it was
   taken live from Uber on 2026-09-17:

     Ecosine, Mon 2026-09-14 — the statement, which closes exactly
       opening 111,279.92 + earnings 20,816.90 + refunds 1,290.28
               - payouts 115,362.76 = closing 18,024.34
       where payouts 115,362.76 = cash 4,183.10 + wire 111,179.66
     Ecosine, Mon 2026-09-07 — opening 103,567.54, wire -103,567.54,
       cash -2,816.65, closing 14,199.06, earnings 15,985.57
     our own figure for 7–13 Sep, the seven daily bank_payout figures
       /api/reconcile prints (each sum(driver_payout_day.earnings) for a day):
       14,324.61 + 15,770.41 + 17,192.37 + 16,612.39 + 17,532.04 + 15,726.00
       + 13,804.27 = 110,962.09

   THE SECOND FALSE CLAIM these routes retire is "the transfer equals the
   previous week's closing balance TO THE FILS, proven over two consecutive
   weeks". Three Ecosine Mondays are now measurable and the equality holds on
   one of them:

     2026-08-17  opening 57,791.73   wire 57,810.41   wire 18.68 ABOVE opening
     2026-09-07  opening 103,567.54  wire 103,567.54  exact
     2026-09-14  opening 111,279.92  wire 111,179.66  wire 100.26 BELOW opening

   The CADENCE is sound and is not in question; only the equality was
   overstated, from a sample of two that happened to include the one Monday
   where it was true. So balance_check reports a DIFFERENCE, and §7 asserts all
   three of those differences come out of the route rather than one of them.

   UBER IS NEVER CALLED FROM HERE. The live ask is reached through the routes'
   `uber` dependency, which api/server.js does not pass — production always
   gets the real src/sources/uber_payout.js oneDay(). A test that called Uber
   would be a test of Uber's limiter, would need a credential inside the
   checkout, and would be red whenever the network was. */
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { payoutRoutes } from '../api/payout_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ══ 0. THE IMPORT-GRAPH RISK, CHECKED RATHER THAN ASSUMED ════════════════
   api/payout_routes.js now imports src/sources/uber_payout.js, src/sources/
   uber.js and src/settings.js, and all three reach src/db.js — which
   constructs a pg.Pool at module scope. test/mount.mjs discovers and imports
   every api/*_routes.js file, so if that construction threw, or connected
   eagerly, or hung, EVERY route test in this directory would die at load with
   an error naming none of this.

   It does not: src/db.js only builds the pool object (no connection is opened
   until a query is issued) and src/rollup.js and src/sources/ledger.js already
   put it in the harness's graph, so this adds no new class of import. api/
   probe.js reaches Uber from this same process by the same route. Asserted
   here anyway, first, because "it should be fine" is how a load-time failure
   gets attributed to whichever assertion happens to run first. If this ever
   goes red the fix is a lazy import() inside the handler. */
check('importing the routes pulls in the collector’s Uber module without exploding',
  typeof payoutRoutes === 'function');

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

/* platform_account_day.checked_at is sql/schema_v74.sql. It is asserted rather
   than assumed because this route selects the column by name: if the migration
   is not registered in src/schema_files.js the reconcile query 500s, and a
   test that quietly worked around that would hide the missing migration. */
const cols = await q(
  `SELECT column_name FROM information_schema.columns
    WHERE table_name = 'platform_account_day'`);
check('the replayed schema carries platform_account_day.checked_at (schema_v74)',
  cols.some((c) => c.column_name === 'checked_at'),
  cols.map((c) => c.column_name).join(', '));

/* ── the fixture ────────────────────────────────────────────────────────── */
const payout = (o) => q(
  `INSERT INTO platform_payout (platform, fleet_id, payout_ext_id, paid_on, amount,
                                currency, period_start, period_end, method, source)
   VALUES ($1,$2,$3,$4::date,$5,'AED',$6::date,$7::date,'bank',$8)`,
  [o.platform, o.fleet, o.id, o.day, o.amount, o.from || null, o.to || null,
    o.source || 'test']);

const dayRow = (o) => q(
  `INSERT INTO platform_account_day (platform, fleet_id, day, currency, basis,
     opening_balance, closing_balance, earnings, refunds_expenses, cash_collected,
     bank_transferred, checked_at)
   VALUES ($1,$2,$3::date,'AED',$4,$5,$6,$7,$8,$9,$10,$11::timestamptz)`,
  [o.platform, o.fleet, o.day, o.basis, o.open ?? null, o.close ?? null,
    o.earnings ?? null, o.refunds ?? null, o.cash ?? null,
    o.bank === undefined ? null : o.bank, o.checked || null]);

const driverDay = (fleet, day, driver, earnings) => q(
  `INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
     period_start, period_end, period_days, earnings, currency)
   VALUES ('uber',$1,$2,$3,$4::date,'2026-09-07','2026-09-13',7,$5,'AED')`,
  [fleet, driver, `Driver ${driver}`, day, earnings]);

/* The three measured Ecosine Mondays, as wires. */
await payout({ platform: 'uber', fleet: 'ecosine', id: 'ecosine:2026-09-14',
  day: '2026-09-14', amount: 111179.66, from: '2026-09-07', to: '2026-09-13',
  source: 'REPORT_TYPE_PAYMENTS_ORGANIZATION (one-day window)' });
await payout({ platform: 'uber', fleet: 'ecosine', id: 'ecosine:2026-09-07',
  day: '2026-09-07', amount: 103567.54, from: '2026-08-31', to: '2026-09-06',
  source: 'REPORT_TYPE_PAYMENTS_ORGANIZATION (one-day window)' });
await payout({ platform: 'uber', fleet: 'ecosine', id: 'ecosine:2026-08-17',
  day: '2026-08-17', amount: 57810.41, from: '2026-08-10', to: '2026-08-16',
  source: 'REPORT_TYPE_PAYMENTS_ORGANIZATION (one-day window)' });
/* Egari's Monday: a stated period with no driver-day rows behind it, which is
   a different absence from Bolt's and must not read as the same one. */
await payout({ platform: 'uber', fleet: 'egari', id: 'egari:2026-09-14',
  day: '2026-09-14', amount: 48210.33, from: '2026-09-07', to: '2026-09-13',
  source: 'REPORT_TYPE_PAYMENTS_ORGANIZATION (one-day window)' });
/* BOLT NEVER STATES A PERIOD. This row is the one whose comparison must come
   back NULL WITH A REASON and never as a zero. */
await payout({ platform: 'bolt', fleet: 'ecosine', id: '2210441', day: '2026-09-05',
  amount: 3184.22, source: 'fleetOwnerPortal/getPayouts' });
/* Outside every window below, so the window filter is exercised rather than
   assumed. */
await payout({ platform: 'bolt', fleet: 'ecosine', id: '1900001', day: '2024-12-30',
  amount: 500, source: 'fleetOwnerPortal/getPayouts' });

await dayRow({ platform: 'uber', fleet: 'ecosine', day: '2026-09-14', basis: 'statement',
  open: 111279.92, close: 18024.34, earnings: 20816.90, refunds: 1290.28,
  cash: -4183.10, bank: -111179.66, checked: '2026-09-17T06:30:00Z' });
await dayRow({ platform: 'uber', fleet: 'ecosine', day: '2026-09-07', basis: 'statement',
  open: 103567.54, close: 14199.06, earnings: 15985.57, cash: -2816.65,
  bank: -103567.54 });
await dayRow({ platform: 'uber', fleet: 'ecosine', day: '2026-08-17', basis: 'statement',
  open: 57791.73, earnings: 12000, bank: -57810.41 });
/* A statement day with no wire on it, inside the narrow window §6 uses. */
await dayRow({ platform: 'uber', fleet: 'ecosine', day: '2026-09-05', basis: 'statement',
  open: 60000, close: 75000, earnings: 15000, bank: 0 });
await dayRow({ platform: 'uber', fleet: 'egari', day: '2026-09-09', basis: 'statement',
  open: 20000, close: 34000, earnings: 14000, bank: 0 });
/* A YANGO ledger row on a day nobody has asked Uber about. It must not make
   2026-09-03 look checked: the gap query is per platform, and a day one
   provider published is not a day another provider was asked about. */
await dayRow({ platform: 'yango', fleet: 'ecosine', day: '2026-09-03', basis: 'ledger',
  earnings: 184.4, cash: 61 });
/* AND A LEDGER ROW ON UBER'S OWN PLATFORM, which is the same distinction with
   the platform filter removed. basis is 'statement' | 'ledger': a statement is
   the provider's own opening and closing balance, a ledger row is summed by us
   from that provider's dated rows and has no balance in it at all. Only the
   first is somebody having asked Uber about the day, so only the first may
   take a day off the unchecked list. Without this row the basis predicate can
   be deleted from the gap query and every assertion in this file still passes
   — measured, by deleting it. */
await dayRow({ platform: 'uber', fleet: 'ecosine', day: '2026-09-02', basis: 'ledger',
  earnings: 9100.5, cash: -1400 });

/* OUR OWN FIGURE for the week Monday 2026-09-14 settles, day by day, exactly
   as /api/reconcile reads it. Two drivers per day so driver_days (14) and
   days_with_rows (7) are different numbers — the basis sentence names both and
   a fixture with one driver a day could not tell them apart. */
const WEEK = {
  '2026-09-07': 14324.61, '2026-09-08': 15770.41, '2026-09-09': 17192.37,
  '2026-09-10': 16612.39, '2026-09-11': 17532.04, '2026-09-12': 15726.00,
  '2026-09-13': 13804.27,
};
for (const [day, total] of Object.entries(WEEK)) {
  await driverDay('ecosine', day, 'u-1', Math.round((total - 100) * 100) / 100);
  await driverDay('ecosine', day, 'u-2', 100);
}

const m = await mountAll(db);
check('the whole API still mounts with the collector’s Uber module in the graph',
  m.mounted.some((x) => x.startsWith('payout_routes.js')), m.mounted.join(' '));

const post = async (port, path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; }
  catch { return { status: r.status, body: null, raw: text.slice(0, 160) }; }
};

/* ══ 1. reconcile: the arithmetic, on the week that was measured ══════════ */
console.log('\nreconcile puts each wire against our own figure for the week it settles');
const wide = (await m.get('/api/finance/payouts/reconcile?from=2026-09-01&to=2026-09-30')).body;
{
  const r = wide.rows.find((x) => x.platform === 'uber' && x.paid_on === '2026-09-14'
    && x.fleet_id === 'ecosine');
  check('the route answers and finds the Monday wire', !!r, JSON.stringify(wide.rows?.map((x) => x.paid_on)));
  check('the wire is the measured 111,179.66', r?.wire === 111179.66, String(r?.wire));
  check('it names the week it settles: 7–13 Sep, the week that ENDED the day before',
    r?.period_start === '2026-09-07' && r?.period_end === '2026-09-13',
    `${r?.period_start} – ${r?.period_end}`);
  /* The whole point of the exercise. */
  check('our own figure for that week is 110,962.09', r?.calculated === 110962.09, String(r?.calculated));
  check('the difference is AED 217.57, not 7,394.55', r?.delta === 217.57, String(r?.delta));
  check('…which is 0.20%, and is nowhere near 7.1%', r?.delta_pct === 0.2, String(r?.delta_pct));
  check('the basis names the source, the window and the day count rather than a label',
    /driver_payout_day\.earnings/.test(r?.calculated_basis || '')
    && /2026-09-07 to 2026-09-13/.test(r?.calculated_basis || '')
    && /7 of 7 days/.test(r?.calculated_basis || '')
    && /14 driver-days/.test(r?.calculated_basis || ''),
    r?.calculated_basis);
  /* balance_delta is a difference and not an equality test — see §7. */
  check('the wire is 100.26 BELOW that Monday’s opening balance',
    r?.opening_balance === 111279.92 && r?.balance_delta === -100.26,
    `${r?.opening_balance} / ${r?.balance_delta}`);
  check('a day a person verified carries when, and it is not collected_at',
    r?.checked_at != null, String(r?.checked_at));
  /* A JOIN THAT CAN MULTIPLY A MONEY ROW IS THE WORST KIND OF DEFECT ON THIS
     PAGE: the duplicate is a plausible transfer with a plausible date, and the
     total is simply wrong. Two joins hang off each payout row here, and this
     asserts the arithmetic they are allowed to do — one row out per row in.
     (Under platform_account_day's primary key (platform, fleet_id, day) the
     statement join cannot multiply today; the assertion is over the ROUTE, so
     it still holds if a future schema relaxes that key.) */
  check('each transfer appears exactly once, whatever the joins find',
    wide.rows.length === 4
    && new Set(wide.rows.map((x) => `${x.platform}/${x.fleet_id}/${x.paid_on}`)).size === 4,
    JSON.stringify(wide.rows.map((x) => `${x.platform}/${x.fleet_id}/${x.paid_on}`)));
}

/* ══ 2. THE BOLT ROW: null with a reason, and never a zero ════════════════ */
console.log('\na provider that states no period gets no comparison, and no zero');
{
  const b = wide.rows.find((x) => x.platform === 'bolt');
  check('Bolt’s transfer is in the answer with its amount', b && b.wire === 3184.22, JSON.stringify(b));
  check('it states no period, and none is invented for it',
    b?.period_start === null && b?.period_end === null, `${b?.period_start} – ${b?.period_end}`);
  /* The exact defect the house rule forbids: a figure nobody could measure
     rendered as 0 in a column of figures somebody did. */
  check('calculated is NULL, not 0', b?.calculated === null, JSON.stringify(b?.calculated));
  check('delta is NULL, not 0', b?.delta === null, JSON.stringify(b?.delta));
  check('delta_pct is NULL, not 0', b?.delta_pct === null, JSON.stringify(b?.delta_pct));
  check('and the reason names the provider and says what is missing',
    /bolt/i.test(b?.calculated_basis || '')
    && /does not state which period/i.test(b?.calculated_basis || '')
    && /not a difference of zero/i.test(b?.calculated_basis || ''), b?.calculated_basis);

  /* THE OTHER ABSENCE, which must not be described in the same words. Egari's
     Monday names its week and we hold no driver-day rows for it. "This
     provider never says" and "we have not collected it" are different
     sentences and only one of them is true of each row. */
  const e = wide.rows.find((x) => x.platform === 'uber' && x.fleet_id === 'egari');
  check('Egari’s wire names a period but has nothing stored to compare against',
    e?.period_start === '2026-09-07' && e?.calculated === null && e?.delta === null,
    JSON.stringify([e?.period_start, e?.calculated, e?.delta]));
  check('…and its reason is the collection gap, not Bolt’s "never states a period"',
    /no driver_payout_day rows are stored/.test(e?.calculated_basis || '')
    && !/does not state which period/.test(e?.calculated_basis || ''), e?.calculated_basis);
}

/* ══ 3. totals over two different populations, said out loud ══════════════ */
console.log('\nthe totals do not quietly compare two different populations');
{
  const t = wide.totals;
  check('wire totals every transfer in the window',
    t.wire === 266141.75, String(t.wire));
  check('calculated covers only the row that can be compared',
    t.calculated === 110962.09 && t.comparable_rows === 1 && t.rows === 4,
    JSON.stringify(t));
  check('delta is the difference over those same rows', t.delta === 217.57, String(t.delta));
  check('and the wire for those rows travels beside it, so nobody subtracts across the two',
    t.wire_comparable === 111179.66 && /different populations/.test(t.basis), JSON.stringify(t));
  check('the 2024 transfer is outside the window and is not in the total',
    !wide.rows.some((x) => x.paid_on === '2024-12-30'));
}

/* ══ 4. the note carries the corrected figure, not the wrong-week one ═════ */
console.log('\nthe response states the measured difference, and retires the 7.1%');
{
  check('reconcile’s note gives 217.57 and 0.20%',
    /217\.57/.test(wide.note) && /0\.20%/.test(wide.note), wide.note);
  check('…and says which way delta points, so a sign is not guessed at',
    /wire MINUS our figure/i.test(wide.note), wide.note);
  const reg = (await m.get('/api/finance/payouts?from=2026-09-01&to=2026-09-30')).body;
  check('the register’s note names the right wire, the right week and the right difference',
    /111,179\.66/.test(reg.note) && /110,962\.09/.test(reg.note)
    && /217\.57/.test(reg.note) && /0\.20%/.test(reg.note), reg.note);
  /* The retraction is kept rather than deleted: a reader who remembers the
     old figure needs to be told it was wrong and why, or they will assume the
     page has silently changed its mind. */
  check('…and says outright where the old 7.1% came from',
    /7\.1%/.test(reg.note) && /PREVIOUS\s+week/i.test(reg.note), reg.note);
  /* The second false claim, in the coverage block the page prints under Uber. */
  const uber = reg.coverage.find((c) => c.platform === 'uber');
  check('the cadence no longer claims the wire equals the opening balance to the fils',
    !/to the fils/i.test(uber.cadence), uber.cadence);
  check('…and gives the three measured Mondays instead',
    /18\.68/.test(uber.cadence) && /100\.26/.test(uber.cadence), uber.cadence);
}

/* ══ 5. unchecked: the days nobody has asked about ════════════════════════
   A window entirely in the past on purpose. The query stops at yesterday on
   the fleet's calendar, so a window reaching today would make the expected set
   a function of the day the suite runs — which is the collision
   docs/COVERAGE.md warns about under "a fixture keyed to now() and a fixture
   keyed to a fixed date drift past each other". */
console.log('\nunchecked names the days nobody has asked Uber about, and nothing else');
{
  const narrow = (await m.get('/api/finance/payouts/reconcile?from=2026-09-01&to=2026-09-10')).body;
  const eco = narrow.unchecked.find((u) => u.fleet_id === 'ecosine');
  const egari = narrow.unchecked.find((u) => u.fleet_id === 'egari');
  check('both fleets are reported, and only Uber',
    narrow.unchecked.length === 2 && narrow.unchecked.every((u) => u.platform === 'uber'),
    JSON.stringify(narrow.unchecked.map((u) => `${u.platform}/${u.fleet_id}`)));
  check('Ecosine’s list is exactly the days with no statement row',
    (eco?.days || []).join(',') === ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
      '2026-09-06', '2026-09-08', '2026-09-09', '2026-09-10'].join(','), (eco?.days || []).join(','));
  /* The half that would be a lie: a day we DID ask about appearing as a day
     nobody asked about. */
  check('…and never a day that has one', !eco.days.includes('2026-09-05')
    && !eco.days.includes('2026-09-07'), eco.days.join(','));
  check('Egari is counted separately, against its own statement day',
    egari.days.length === 9 && !egari.days.includes('2026-09-09'), egari.days.join(','));
  check('the count travels with the list', eco.count === eco.days.length);
  /* Yango published a ledger row on 2026-09-03 and that is not somebody
     asking Uber about 2026-09-03. */
  check('another provider’s row on a day does not make that day checked for Uber',
    eco.days.includes('2026-09-03'), eco.days.join(','));
  /* And the same distinction inside one platform. A 'ledger' row is a sum we
     built from the provider's dated rows; a 'statement' row is the provider's
     own document. Only the second is somebody having asked. */
  check('a ledger row for Uber is not a statement and does not count as asking',
    eco.days.includes('2026-09-02'), eco.days.join(','));
  check('Bolt and Yango are not listed at all — neither publishes a daily statement',
    !narrow.unchecked.some((u) => u.platform === 'bolt' || u.platform === 'yango'));
  check('the reason is the true one, and is the sentence the page has to print',
    /cannot be reported as a day with no transfer/.test(eco.why)
    && /no measurement/.test(eco.why), eco.why);
  check('a fleet filter narrows it', (await m.get(
    '/api/finance/payouts/reconcile?from=2026-09-01&to=2026-09-10&fleet=egari'))
    .body.unchecked.length === 1);
}

/* ══ 6. the three measured Mondays, out of the route ══════════════════════
   The claim being retired is "the transfer equals the previous week's closing
   balance to the fils, proven over two consecutive weeks". Asserted here as
   what it actually is: three differences, one of which is zero. */
console.log('\nthe wire is near the opening balance and is not equal to it');
{
  const b = (await m.get('/api/finance/payouts/reconcile'
    + '?from=2026-08-01&to=2026-09-30&platform=uber&fleet=ecosine')).body;
  const on = (d) => b.rows.find((x) => x.paid_on === d);
  check('2026-08-17: the wire was 18.68 ABOVE the opening balance',
    on('2026-08-17')?.balance_delta === 18.68, String(on('2026-08-17')?.balance_delta));
  check('2026-09-07: the two were identical', on('2026-09-07')?.balance_delta === 0,
    String(on('2026-09-07')?.balance_delta));
  check('2026-09-14: the wire was 100.26 BELOW it',
    on('2026-09-14')?.balance_delta === -100.26, String(on('2026-09-14')?.balance_delta));
  check('so one Monday in three, and the note does not call it a check that should be zero',
    /difference to look at and not/i.test(b.note), b.note);
}

/* ══ 7. verify: the refusals, on the REAL mounted app ═════════════════════
   These four all refuse before any credential is touched, so they run against
   the application as mounted rather than against a stub — which is the point:
   a refusal that only happens in a test harness is not a refusal. */
console.log('\nverify refuses by name, and refuses before it spends the limiter');
{
  const six = await post(m.port, '/api/finance/payouts/verify', {
    fleet: 'ecosine',
    days: ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14'],
  });
  check('six days is refused outright', six.status === 400, String(six.status));
  check('…the error names the count and the cap rather than saying "too many"',
    /named 6 days/.test(six.body?.error || '') && /cap is 5/.test(six.body?.error || ''),
    six.body?.error);
  /* Silent truncation is the failure this refusal exists to prevent: five of
     six answered under a request that named six reads as "we checked
     everything". */
  check('…every one of the six is named, so none of them reads as checked',
    six.body?.refused?.length === 6
    && six.body.refused.map((r) => r.day).join(',').includes('2026-09-14'),
    JSON.stringify(six.body?.refused?.map((r) => r.day)));
  check('…and nothing was answered about any day', six.body?.days?.length === 0);

  const alien = await post(m.port, '/api/finance/payouts/verify',
    { fleet: 'atlantis', days: ['2026-09-14'] });
  check('an unknown fleet is refused by name', alien.status === 400
    && /"atlantis" is not a fleet/.test(alien.body?.error || ''), alien.body?.error);
  check('…and the refusal names the fleets that do exist, rather than falling back to one',
    /ecosine and egari/.test(alien.body?.error || ''), alien.body?.error);

  const none = await post(m.port, '/api/finance/payouts/verify', { fleet: 'ecosine', days: [] });
  check('a request naming no days is refused rather than given a default window',
    none.status === 400 && /no days were named/.test(none.body?.error || ''), none.body?.error);

  /* A malformed date never reaches a provider — see §9 for the proof that it
     does not, which needs the stub to be able to say what it was asked. */
  const bad = await post(m.port, '/api/finance/payouts/verify',
    { fleet: 'ecosine', days: ['2026-13-45'] });
  check('a malformed date is refused and the request still answers',
    bad.status === 200 && bad.body?.refused?.length === 1
    && bad.body.refused[0].day === '2026-13-45', JSON.stringify(bad.body?.refused));
  check('…with the reason a bad date is dangerous rather than merely invalid',
    /report for some other day/.test(bad.body?.refused?.[0]?.why || ''),
    bad.body?.refused?.[0]?.why);
  check('…and no day was answered about', bad.body?.days?.length === 0);
}

/* ══ 8. verify against a stubbed provider ════════════════════════════════
   Uber replaced at the routes' own dependency. The stub records every call, so
   the assertions below can be about WHAT WAS ASKED and not only about what
   came back — which is the only way to prove a malformed date was not sent and
   that two reports were never in flight at once. */
const calls = [];
let live = 0, maxLive = 0;
const script = new Map();
const stub = {
  async orgFor(fleet) {
    /* Only Ecosine is configured here, so §10 can assert the refusal a fleet
       with no credential gets — and can assert it is not an answer about the
       other fleet. */
    return fleet === 'ecosine' ? { fleet: 'ecosine', orgUuid: 'test-org' } : null;
  },
  async oneDay(org, day, opts) {
    calls.push({ fleet: org.fleet, day, live: opts?.live });
    live += 1; maxLive = Math.max(maxLive, live);
    try {
      const s = script.get(day);
      return typeof s === 'function' ? await s() : (s || { why: 'the fixture scripted no answer' });
    } finally { live -= 1; }
  },
};
const app2 = express();
app2.use(express.json());
payoutRoutes(app2, { ...m.deps, uber: stub });
const srv2 = app2.listen(0);
srv2.keepAliveTimeout = 0;
const port2 = srv2.address().port;

/* Uber's own answer for Ecosine, Mon 2026-09-14, exactly as the report gives
   it — the wire NEGATIVE, because from the account's point of view it leaves. */
script.set('2026-09-14', () => ({
  missing: [], stored: true, checked_at: new Date().toISOString(),
  row: {
    platform: 'uber', fleet_id: 'ecosine', day: '2026-09-14', basis: 'statement',
    opening_balance: 111279.92, closing_balance: 18024.34, earnings: 20816.90,
    refunds_expenses: 1290.28, cash_collected: -4183.10, bank_transferred: -111179.66,
    tips: 312.5, taxes: -44.2,
  },
}));
/* A day Uber did not wire: the cell is BLANK and the mapper maps a blank cell
   to 0, which is a measurement. */
script.set('2026-09-15', () => ({
  missing: [], stored: true,
  row: {
    platform: 'uber', fleet_id: 'ecosine', day: '2026-09-15', basis: 'statement',
    opening_balance: 18024.34, closing_balance: 34000.11, earnings: 16500.2,
    refunds_expenses: 0, cash_collected: -2900.5, bank_transferred: 0,
    tips: 210, taxes: -12,
  },
}));
/* A DAY WHOSE ASK WRITES, which is how the ORDER of the read and the ask is
   made observable. oneDay() stores what Uber said — that is the real
   behaviour, not an artefact of this stub — so stored_before can only be "what
   the register held before the operator pressed the button" if it is read
   first. Read afterwards it would echo the row the ask just wrote, and the
   answer would say the figure was already there when it was not. */
script.set('2026-09-09', async () => {
  await q(
    `INSERT INTO platform_payout (platform, fleet_id, payout_ext_id, paid_on, amount,
                                  currency, period_start, period_end, method, source)
     VALUES ('uber','ecosine','ecosine:2026-09-09','2026-09-09'::date, 9999.99, 'AED',
             NULL, NULL, 'bank', 'written by the ask itself')`);
  return { missing: [], stored: true, row: {
    platform: 'uber', fleet_id: 'ecosine', day: '2026-09-09', basis: 'statement',
    opening_balance: 47693.72, closing_balance: 64029.20, earnings: 19426.04,
    refunds_expenses: 0, cash_collected: -3229.91, bank_transferred: -9999.99,
    tips: 0, taxes: 0,
  } };
});
/* The limiter, which is a fact about this minute. */
script.set('2026-09-16', () => ({ throttled: true,
  why: 'Code: rate-limited, Message: Payment report generation limit reached' }));
/* A day the provider simply has nothing for, which is a fact about the day. */
script.set('2026-09-13', () => ({ why: 'the report generated and contains no rows' }));

console.log('\nverify asks Uber one day at a time and reports what it said');
{
  const r = await post(port2, '/api/finance/payouts/verify',
    { fleet: 'ecosine', days: ['2026-09-14', '2026-09-15'] });
  check('the route answers', r.status === 200, String(r.status));
  const d = r.body.days.find((x) => x.day === '2026-09-14');
  check('the live flag is set, which is what stamps checked_at',
    calls.filter((c) => c.day === '2026-09-14').every((c) => c.live === true),
    JSON.stringify(calls));
  check('Uber’s own figures come back with Uber’s own signs',
    d?.uber?.bank_transferred === -111179.66 && d?.uber?.opening_balance === 111279.92
    && d?.uber?.cash_collected === -4183.10, JSON.stringify(d?.uber));
  /* The one transformation this route makes, and the note has to say so. */
  check('wire is the ABSOLUTE value of that, because the money leaves the account',
    d?.wire === 111179.66, String(d?.wire));
  check('the note says the sign is Uber’s and the absolute value is ours',
    /signs it NEGATIVE|signs NEGATIVE|NEGATIVE because/i.test(r.body?.note || '')
    && /absolute value/i.test(r.body?.note || ''), r.body?.note);
  /* Optional chaining throughout, and not laziness: a mutation that makes one
     of these come back null must produce a failed ASSERTION, not a TypeError.
     test/run-all.mjs reports a file that dies as "0 passed, NO TALLY
     REPORTED", which reads as a harness fault rather than as the defect the
     mutation introduced — measured here, by reverting Math.abs() off the wire
     and watching this file die instead of fail. */
  check('it names the week the wire settles, from the collector’s own function',
    d.settles?.period_start === '2026-09-07' && d.settles?.period_end === '2026-09-13',
    JSON.stringify(d.settles));
  check('our figure for that week, and the difference, come back with it',
    d.calculated?.value === 110962.09 && d.delta?.value === 217.57 && d.delta?.pct === 0.2,
    JSON.stringify([d.calculated?.value, d.delta]));
  check('the register already held this wire, and the answer says so',
    d.stored_before?.wire === 111179.66 && d.stored_before?.had_statement === true,
    JSON.stringify(d.stored_before));
  check('balance_check reports the difference and does not assert an equality',
    d.balance_check?.difference === -100.26
    && !/should (be )?equal/i.test(d.balance_check?.note || ''),
    JSON.stringify(d.balance_check));
  check('…and its note carries all three measured Mondays, not the two that agreed',
    /18\.68/.test(d.balance_check?.note || '') && /100\.26/.test(d.balance_check?.note || ''),
    d.balance_check?.note);

  /* THE QUIET DAY. Uber leaves the bank cell blank and the mapper reads a
     blank cell as 0 — a measured day with no transfer, which must not grow a
     settles/period/delta out of nothing. */
  const quiet = r.body.days.find((x) => x.day === '2026-09-15');
  check('a day with an empty bank cell reports a wire of 0, which is a measurement',
    quiet?.wire === 0, String(quiet?.wire));
  check('…and no period, no comparison and no balance check are invented for it',
    quiet?.settles === null && quiet?.calculated === null && quiet?.delta === null
    && quiet?.balance_check === null, JSON.stringify(quiet));
  check('…and it carries no reason, because nothing failed', quiet?.why === null, quiet?.why);
  check('a day we did not already hold says so, rather than reporting a stored zero',
    quiet?.stored_before?.wire === null && quiet?.stored_before?.had_statement === false,
    JSON.stringify(quiet?.stored_before));

  /* THE READ HAPPENS BEFORE THE ASK, and that ordering is the whole meaning of
     the field. The scripted ask for 2026-09-09 writes a transfer of 9,999.99
     into platform_payout itself — which is what the real oneDay() does — so if
     stored_before were read afterwards it would come back 9999.99 and the
     answer would claim the register already held a wire it had just written. */
  const w = await post(port2, '/api/finance/payouts/verify',
    { fleet: 'ecosine', days: ['2026-09-09'] });
  const wrote = w.body?.days?.[0];
  check('stored_before is what the register held BEFORE the ask, not after it',
    wrote?.stored_before?.wire === null, JSON.stringify(wrote?.stored_before));
  check('…and the ask really did write, so that null was not free',
    (await q(`SELECT amount FROM platform_payout WHERE payout_ext_id = 'ecosine:2026-09-09'`))
      .map((x) => Number(x.amount))[0] === 9999.99);
  check('…and asking the same day again now reports it as already held',
    (await post(port2, '/api/finance/payouts/verify',
      { fleet: 'ecosine', days: ['2026-09-09'] })).body?.days?.[0]?.stored_before?.wire === 9999.99);
}

/* ══ 9. THE FAILURE PATH: a reason, and nulls — never a zero ══════════════ */
console.log('\na day that could not be asked carries the true reason and no numbers');
{
  const r = await post(port2, '/api/finance/payouts/verify',
    { fleet: 'ecosine', days: ['2026-09-16', '2026-09-13'] });
  const shut = r.body.days.find((x) => x.day === '2026-09-16');
  const empty = r.body.days.find((x) => x.day === '2026-09-13');

  check('the limiter is named as a fact about now, not about the day',
    /limiter is shut/i.test(shut?.why || '') && /not about 2026-09-16/.test(shut?.why || ''),
    shut?.why);
  /* Every number, checked for null explicitly rather than falsily: 0 is falsy
     and 0 is exactly the value this rule forbids here. */
  const nulls = ['uber', 'wire', 'settles', 'calculated', 'delta', 'balance_check'];
  check('every figure on a failed day is null',
    nulls.every((k) => shut?.[k] === null), JSON.stringify(nulls.map((k) => [k, shut?.[k]])));
  check('…and not one of them is 0', !nulls.some((k) => shut?.[k] === 0));
  check('nothing was stored for it', shut?.stored === false);
  check('…but the row still says it was asked', shut?.asked === true);

  /* The two sentences the brief insists cannot both be true at once. */
  check('"no statement for this day" is a different sentence from "the limiter is shut"',
    /contains no rows/.test(empty?.why || '') && !/limiter/i.test(empty?.why || ''), empty?.why);
  check('…and it too carries nulls rather than zeros',
    nulls.every((k) => empty?.[k] === null), JSON.stringify(empty));
  check('the note says a failed day carries its reason and no numbers',
    /no numbers at all/.test(r.body?.note || ''), r.body?.note);
}

/* ══ 10. one ask at a time, and the malformed date that never left ════════ */
console.log('\nUber is asked one day at a time, and only about days that are days');
{
  const before = calls.length;
  const r = await post(port2, '/api/finance/payouts/verify', {
    fleet: 'ecosine',
    /* '2026-02-30' is the one that matters here and it is chosen deliberately:
       it is the right SHAPE, it is not a day, and it sorts BEFORE today — so
       the only guard that can stop it is the round trip through Date. The
       other two are caught twice over, by that guard and by the
       still-in-progress guard, and a value two guards catch proves neither of
       them. Measured: with the shape guard disabled, '2026-13-45' and
       'yesterday please' are both still refused and only this one reaches the
       provider. */
    days: ['2026-09-14', '2026-02-30', 'yesterday please', '2026-09-14', '2026-09-15'],
  });
  const askedDays = calls.slice(before).map((c) => c.day);
  check('only the well-formed days reached the provider',
    askedDays.join(',') === '2026-09-14,2026-09-15', askedDays.join(','));
  check('the malformed dates are named in the answer rather than dropped',
    r.body?.refused?.some((x) => x.day === '2026-02-30')
    && r.body?.refused?.some((x) => x.day === 'yesterday please'),
    JSON.stringify(r.body));
  /* A duplicate would spend a report from a limiter this tight to return a row
     we already have. */
  check('a day named twice is asked once, and the repeat is named',
    askedDays.filter((d) => d === '2026-09-14').length === 1
    && r.body?.refused?.some((x) => /twice/.test(x.why)), JSON.stringify(r.body?.refused));
  /* Three payment reports in flight is what shut Uber's limiter for minutes
     and cut a collector run to 4 of 8 days. The stub counts overlap directly,
     so this is a measurement rather than a reading of the source. */
  check('no two reports were ever in flight at once', maxLive === 1, String(maxLive));

  const future = await post(port2, '/api/finance/payouts/verify',
    { fleet: 'ecosine', days: ['2099-01-01'] });
  check('a day that has not finished is refused, so a partial is never stored as final',
    future.body?.refused?.length === 1
    && /still in progress|not finished/.test(future.body?.refused?.[0]?.why || ''),
    JSON.stringify(future.body?.refused));

  const noOrg = await post(port2, '/api/finance/payouts/verify',
    { fleet: 'egari', days: ['2026-09-14'] });
  check('a fleet with no Uber credential is refused rather than answered about the other one',
    noOrg.status === 400 && /no Uber organisation is configured for the egari fleet/
      .test(noOrg.body?.error || ''), noOrg.body?.error);
  check('…and nothing was asked of Uber for it',
    !calls.some((c) => c.fleet === 'egari'));
}

/* ══ 11. the in-process guard against two live asks ═══════════════════════
   Not the same claim as §10. That one proves one REQUEST does not overlap
   itself; this proves two REQUESTS do not overlap each other, which is the
   shape that actually shut Uber's limiter — an operator clicking twice. */
console.log('\na second live ask is refused honestly rather than raced into the limiter');
{
  let release;
  const gate = new Promise((r) => { release = r; });
  script.set('2026-09-12', async () => {
    await gate;
    return { why: 'the report generated and contains no rows' };
  });
  const first = post(port2, '/api/finance/payouts/verify',
    { fleet: 'ecosine', days: ['2026-09-12'] });
  /* Let the first request reach the provider before the second arrives. */
  await new Promise((r) => setTimeout(r, 60));
  const second = await post(port2, '/api/finance/payouts/verify',
    { fleet: 'ecosine', days: ['2026-09-11'] });
  check('the second caller is told an ask is running', second.status === 409,
    String(second.status));
  check('…in words that name the limiter as the reason, not "busy"',
    /a live ask is already running/.test(second.body?.error || '')
    && /limiter/.test(second.body?.error || ''), second.body?.error);
  check('…and is told plainly that nothing was asked on its behalf',
    /Nothing was asked of Uber/.test(second.body?.error || '')
    && second.body?.days?.length === 0, second.body?.error);
  check('…and the day it wanted is named rather than silently dropped',
    second.body?.refused?.some((x) => x.day === '2026-09-11'),
    JSON.stringify(second.body?.refused));
  check('the second request never reached the provider',
    !calls.some((c) => c.day === '2026-09-11'));
  release();
  await first;
  check('and the flag is released, so the next ask goes through',
    (await post(port2, '/api/finance/payouts/verify',
      { fleet: 'ecosine', days: ['2026-09-13'] })).status === 200);

  /* THE RELEASE HAS TO SURVIVE A THROW. A flag left set by an exception wedges
     this route shut until the process restarts, which is a worse failure than
     the concurrent ask it prevents — so the throw is injected rather than
     reasoned about. */
  script.set('2026-09-10', () => { throw new Error('socket hang up'); });
  const boom = await post(port2, '/api/finance/payouts/verify',
    { fleet: 'ecosine', days: ['2026-09-10'] });
  check('a provider that throws becomes a reason on the day, not a 500',
    boom.status === 200 && /socket hang up/.test(boom.body?.days?.[0]?.why || ''),
    JSON.stringify(boom.body));
  check('…and the route is still open afterwards',
    (await post(port2, '/api/finance/payouts/verify',
      { fleet: 'ecosine', days: ['2026-09-13'] })).status === 200);
}

/* CLOSE BOTH SERVERS AND THE DATABASE, AND EXIT EXPLICITLY.
   ─────────────────────────────────────────────────────────────────────────
   mountAll calls app.listen(0) and deliberately sets keepAliveTimeout = 0 so
   idle sockets are never reaped, which is right for a process about to end and
   fatal for one waiting to; PGlite holds its own handles besides. Without this
   the file prints its tally and never exits, test/run-all.mjs SIGKILLs it at
   300 s, and it arrives in `npm test` as a FAILING file with every one of its
   assertions passing. Two servers here, not one — the stubbed app is a second
   listener and would hold the process open on its own. */
srv2.close();
m.server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
