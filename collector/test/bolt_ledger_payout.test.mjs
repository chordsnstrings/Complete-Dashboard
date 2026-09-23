/* THE BOLT PAYOUT THAT REACHED THE BANK AND NOT THE PAGE.
   ═══════════════════════════════════════════════════════════════════════════
   Reported by the operator on 2026-09-23: "monday 21st had bolt payout as
   well. fix everything related to this."

   Production held Bolt payouts up to Monday 14 September and none for the
   21st. Nothing on our side dropped it — getPayouts' raw list length equalled
   its count of rows with a valid `finished` stamp (Egari 87 of 87), so Bolt's
   list simply did not contain it. getPayouts LAGS: the 14 September payout was
   absent from it on the 16th and present by the 21st.

   Bolt's balance ledger does not lag. Measured on production the same morning,
   getFleetBalanceDetails asked about ONE day at a time:

       day          Ecosine "Weekly payout"   Egari "Weekly payout"
       2026-09-14       2,490.95                  832.25    = getPayouts, to the fil
       2026-09-20        none                      none
       2026-09-21       1,275.14                  619.18    ← the missing payout
       2026-09-22        none                      none

   Every figure below is one of those. The guarantee this file exists for is
   the one that fails silently if it breaks: the same money must NEVER be
   counted twice once the lagging list catches up. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { createRequire } from 'node:module';
import { ledgerDay, ledgerRow, nextPayoutOn, BANK_PAYOUT_TITLES, LEDGER_DAYS } from '../src/sources/bolt_balance.js';

/* node-postgres's OWN parameter encoder — what production actually sends. The
   suite runs on PGlite, which encodes a JSONB parameter from the column type
   and so accepted an array production rejected (2026-09-23). */
const { prepareValue } = createRequire(import.meta.url)('pg/lib/utils');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const r2 = (n) => Math.round(Number(n) * 100) / 100;

/* ══ 1. one day of the ledger, off the shape Bolt actually sends ═══════════ */
console.log('\nreading a ledger day — the real 15–23 September statements');
const EGARI = { currency: 'AED',
  starting_balance_item: { title: 'Starting balance', value: 81.13 },
  ending_balance_item: { title: 'Final balance', value: -34.16 },
  earnings_items: { earning_in_app: { title: 'In-app earnings', value: 1358 }, tips: { title: 'Rider tips', value: 5 },
    cancellation_fees: { title: 'Cancellation fees', value: 15.6 }, rider_cash_discount: { title: 'Rider cash discount', value: 68 } },
  expenses_items: { payouts: { title: 'Weekly payout', value: 619.18 }, commissions_in_app: { title: 'In-app commission', value: 323.0063 },
    commissions_cash: { title: 'Cash commission', value: 359.7038 }, booking_fees: { title: 'Booking fees', value: 260 } },
  cash_in_hand_item: { title: 'Cash payments to drivers', value: 1457 } };
const ECOSINE = { currency: 'AED',
  starting_balance_item: { title: 'Starting balance', value: 387.78 },
  ending_balance_item: { title: 'Final balance', value: 1019.4 },
  earnings_items: { earning_in_app: { title: 'In-app earnings', value: 3542.5 }, tips: { title: 'Rider tips', value: 24 },
    cancellation_fees: { title: 'Cancellation fees', value: 15.6 }, rider_cash_discount: { title: 'Rider cash discount', value: 105 } },
  expenses_items: { payouts: { title: 'Weekly payout', value: 1275.14 }, commissions_in_app: { title: 'In-app commission', value: 825.8254 },
    commissions_cash: { title: 'Cash commission', value: 509.5126 }, booking_fees: { title: 'Booking fees', value: 445 } },
  cash_in_hand_item: { title: 'Cash payments to drivers', value: 2057 } };
{
  const e = ledgerDay(EGARI); const c = ledgerDay(ECOSINE);
  check('Egari’s weekly payout reads 619.18', e.payout === 619.18, String(e.payout));
  check('Ecosine’s weekly payout reads 1,275.14', c.payout === 1275.14, String(c.payout));
  check('both statements balance: starting + earnings − expenses = final, to the fil',
    e.balances === true && c.balances === true, `${e.balances} ${c.balances}`);
  check('cash handed to drivers is NOT a term in that sum — it never passed through the balance',
    ledgerDay({ ...EGARI, cash_in_hand_item: { value: 999999 } }).balances === true);
  check('the payout names the line it came from', e.payout_lines?.[0]?.title === 'Weekly payout');
  check('a statement that does NOT balance is stored and flagged, never corrected',
    ledgerDay({ ...EGARI, ending_balance_item: { value: 5 } }).balances === false);
}
{
  const d = ledgerDay({ currency: 'AED', expenses_items: {
    payouts: { title: 'Weekly payout', value: 100 },
    instant: { title: 'Instant cashout', value: 25 },
    tax: { title: 'Tax authority payout', value: 40 } } });
  check('an instant cashout is money to the fleet’s bank and is added', d.payout === 125, String(d.payout));
  check('a TAX AUTHORITY payout is not — it never reaches the fleet’s account',
    !d.payout_lines.some((l) => /tax/i.test(l.title)), JSON.stringify(d.payout_lines));
  check('the bank-payout titles are exactly the two the glossary says reach the fleet',
    BANK_PAYOUT_TITLES.join('|') === 'weekly payout|instant cashout');
  const none = ledgerDay({ currency: 'AED', expenses_items: { booking_fees: { title: 'Booking fees', value: 260 } } });
  check('a day with no payout line is NULL, not 0 — "none measured" is not "paid nothing"',
    none.payout === null, String(none.payout));
}
check('Bolt’s next_payout_date 1790539200 is MONDAY 28 September in Dubai, not the 27th in UTC',
  nextPayoutOn(1790539200) === '2026-09-28', String(nextPayoutOn(1790539200)));
check('a missing or nonsense date is null', nextPayoutOn(null) === null && nextPayoutOn(0) === null);
check('the collector re-reads a whole payout week and a day', LEDGER_DAYS === 8);

console.log('\nthe row the collector writes is JSON as node-postgres sends it, not only as PGlite does');
{
  const JSONB = ['payout_lines', 'earnings', 'expenses'];
  for (const [name, day, L] of [['payout day', '2026-09-21', ledgerDay(ECOSINE)],
    ['no-payout day', '2026-09-22', ledgerDay({ ...EGARI, expenses_items: { booking_fees: { title: 'Booking fees', value: 260 } } })]]) {
    const row = ledgerRow('bolt', 'ecosine', day, L);
    const bad = JSONB.filter((k) => {
      const wire = prepareValue(row[k]);
      if (wire === null) return false;
      try { JSON.parse(wire); return false; } catch { return true; }
    });
    check(`${name}: every JSONB column is valid JSON on the node-postgres wire`, bad.length === 0,
      bad.map((k) => `${k}=${String(prepareValue(row[k])).slice(0, 60)}`).join(' '));
  }
  const row = ledgerRow('bolt', 'ecosine', '2026-09-21', ledgerDay(ECOSINE));
  check('…and it still says the same thing once parsed back',
    JSON.parse(row.payout_lines)[0]?.value === 1275.14 && JSON.parse(row.expenses).payouts?.value === 1275.14
    && row.payout === 1275.14 && row.day === '2026-09-21' && row.fleet_id === 'ecosine', JSON.stringify(row));
  check('a day with no payout stores payout_lines as NULL, not the string "null"',
    ledgerRow('bolt', 'egari', '2026-09-22', ledgerDay({ currency: 'AED' })).payout_lines === null);
}

/* ══ 2. the page, over a real schema ═══════════════════════════════════════ */
const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const reg = (fleet, id, day, amount) => q(
  `INSERT INTO platform_payout (platform, fleet_id, payout_ext_id, paid_on, amount, currency, method, source)
   VALUES ('bolt', $1, $2, $3::date, $4, 'AED', 'bank', 'fleetOwnerPortal/getPayouts')`, [fleet, id, day, amount]);
const led = (fleet, day, payout) => q(
  `INSERT INTO platform_balance_day (platform, fleet_id, day, currency, payout, balances)
   VALUES ('bolt', $1, $2::date, 'AED', $3, true)
   ON CONFLICT (platform, fleet_id, day) DO UPDATE SET payout = EXCLUDED.payout`, [fleet, day, payout]);

/* What production held on the morning of 2026-09-23: the register up to the
   14th, and the ledger showing both the 14th (the same money) and the 21st. */
await reg('ecosine', '1001', '2026-09-14', 2490.95);
await reg('egari', '2001', '2026-09-14', 832.25);
await led('ecosine', '2026-09-14', 2490.95);
await led('egari', '2026-09-14', 832.25);
await led('ecosine', '2026-09-20', null);
await led('ecosine', '2026-09-21', 1275.14);
await led('egari', '2026-09-21', 619.18);
await q(`INSERT INTO platform_balance_now (platform, fleet_id, currency, current_balance, next_payout_on)
         VALUES ('bolt','ecosine','AED',1019.40,'2026-09-28'), ('bolt','egari','AED',-34.16,'2026-09-28')`);

const m = await mountAll(db);
const get = (p) => m.get(p).then((r) => r.body);

console.log('\nthe 21st is on the page, and nothing is counted twice');
{
  const d = await get('/api/finance/payouts');
  const rows = (d.payouts || []).filter((r) => r.platform === 'bolt');
  const on = (fleet, day) => rows.filter((r) => r.fleet_id === fleet && String(r.paid_on).slice(0, 10) === day);
  check('THE 21 SEPTEMBER PAYOUT IS SHOWN for Ecosine, at 1,275.14',
    on('ecosine', '2026-09-21').length === 1 && r2(on('ecosine', '2026-09-21')[0].amount) === 1275.14,
    JSON.stringify(on('ecosine', '2026-09-21')));
  check('…and for Egari, at 619.18',
    on('egari', '2026-09-21').length === 1 && r2(on('egari', '2026-09-21')[0].amount) === 619.18);
  check('…marked as coming from the balance ledger, not Bolt’s payout list',
    on('ecosine', '2026-09-21')[0]?.listed_by_provider === false
    && on('ecosine', '2026-09-21')[0]?.basis === 'balance-ledger');
  check('the 14th appears ONCE per fleet — the ledger’s copy of it is suppressed',
    on('ecosine', '2026-09-14').length === 1 && on('egari', '2026-09-14').length === 1,
    `${on('ecosine', '2026-09-14').length} ${on('egari', '2026-09-14').length}`);
  check('…and the one shown is the register’s, which names Bolt’s own payout id',
    on('ecosine', '2026-09-14')[0]?.listed_by_provider === true
    && on('ecosine', '2026-09-14')[0]?.payout_ext_id === '1001');
  check('a ledger day with no payout line is not a transfer', on('ecosine', '2026-09-20').length === 0);
  const t = (fleet) => (d.totals || []).find((x) => x.platform === 'bolt' && x.fleet_id === fleet);
  check('Ecosine’s total is the 14th plus the 21st, once each: 3,766.09',
    r2(t('ecosine')?.total) === 3766.09, String(t('ecosine')?.total));
  check('…and the page can say how much of it rests on the ledger alone',
    t('ecosine')?.unlisted_transfers === 1 && r2(t('ecosine')?.unlisted_total) === 1275.14,
    JSON.stringify(t('ecosine')));
  check('the record’s latest Bolt date is now the 21st, not the 14th',
    (d.coverage || []).find((c) => c.platform === 'bolt')?.record_span
      ?.every((s) => String(s.latest).slice(0, 10) === '2026-09-21'),
    JSON.stringify((d.coverage || []).find((c) => c.platform === 'bolt')?.record_span));
}

console.log('\nwhen Bolt’s list catches up, the ledger row steps aside');
{
  await reg('ecosine', '1002', '2026-09-21', 1275.14);
  const d = await get('/api/finance/payouts');
  const rows = (d.payouts || []).filter((r) => r.platform === 'bolt' && r.fleet_id === 'ecosine'
    && String(r.paid_on).slice(0, 10) === '2026-09-21');
  check('the 21st is shown ONCE, now from Bolt’s list', rows.length === 1 && rows[0].listed_by_provider === true,
    JSON.stringify(rows));
  const t = (d.totals || []).find((x) => x.platform === 'bolt' && x.fleet_id === 'ecosine');
  check('the total did not move — the same money, one book instead of the other',
    r2(t?.total) === 3766.09 && t?.unlisted_transfers === 0, JSON.stringify(t));
}

console.log('\nthe same money filed on a neighbouring day is still the same money');
{
  /* Bolt's `finished` stamp can land a day off the day the ledger debits. */
  await led('egari', '2026-09-28', 700.00);
  await reg('egari', '2002', '2026-09-29', 700.00);
  const d = await get('/api/finance/payouts');
  const eg = (d.payouts || []).filter((r) => r.platform === 'bolt' && r.fleet_id === 'egari');
  check('a register row one day later for the SAME amount suppresses the ledger’s',
    eg.filter((r) => Math.abs(Number(r.amount) - 700) < 0.01).length === 1,
    JSON.stringify(eg.map((r) => [String(r.paid_on).slice(0, 10), r.amount, r.basis])));
  await led('egari', '2026-10-05', 500.00);
  await reg('egari', '2003', '2026-10-06', 480.00);
  const d2 = await get('/api/finance/payouts');
  const eg2 = (d2.payouts || []).filter((r) => r.platform === 'bolt' && r.fleet_id === 'egari');
  check('…but a DIFFERENT amount a day apart is two payouts, and both are shown',
    eg2.some((r) => r.basis === 'balance-ledger' && Math.abs(Number(r.amount) - 500) < 0.01)
    && eg2.some((r) => r.basis === 'register' && Math.abs(Number(r.amount) - 480) < 0.01),
    JSON.stringify(eg2.map((r) => [String(r.paid_on).slice(0, 10), r.amount, r.basis])));
}

console.log('\nBolt’s own words, and the cadence counted rather than remembered');
{
  const d = await get('/api/finance/payouts');
  const bolt = (d.coverage || []).find((c) => c.platform === 'bolt');
  check('the cadence line carries no stale "175"', !/175/.test(bolt?.cadence || ''), bolt?.cadence);
  check('…and no longer claims Bolt publishes no cadence', !/publishes no cadence/i.test(bolt?.cadence || ''));
  const [live] = await q(`SELECT count(*)::int n FROM platform_payout WHERE platform='bolt'`);
  check('…it counts the whole record, both books, as it stands now',
    /\d+ of \d+/.test(bolt?.cadence || '') && Number((bolt.cadence.match(/of (\d+)/) || [])[1]) >= live.n,
    bolt?.cadence);
  const eco = (bolt?.balance || []).find((b) => b.fleet_id === 'ecosine');
  check('Bolt’s balance statement is carried per fleet',
    r2(eco?.current_balance) === 1019.4 && String(eco?.next_payout_on).slice(0, 10) === '2026-09-28',
    JSON.stringify(eco));
}

console.log('\na Monday behind Bolt’s next payout date with nothing seen is said out loud');
{
  const d = await get('/api/finance/payouts');
  const bolt = (d.coverage || []).find((c) => c.platform === 'bolt');
  check('with the 21st seen for both fleets, nothing is flagged',
    (bolt?.expected_missing || []).length === 0, JSON.stringify(bolt?.expected_missing));
  /* A fleet whose Monday never came — Bolt has skipped Egari 4 times in 91. */
  const db2 = new PGlite(); await applySchema(db2);
  const q2 = (t, p = []) => db2.query(t, p).then((r) => r.rows);
  await q2(`INSERT INTO platform_payout (platform, fleet_id, payout_ext_id, paid_on, amount, currency, method, source)
            VALUES ('bolt','egari','9','2026-09-14',832.25,'AED','bank','x')`);
  await q2(`INSERT INTO platform_balance_now (platform, fleet_id, currency, current_balance, next_payout_on)
            VALUES ('bolt','egari','AED',-34.16,'2026-09-28')`);
  const m2 = await mountAll(db2);
  const b2 = ((await m2.get('/api/finance/payouts')).body.coverage || []).find((c) => c.platform === 'bolt');
  const miss = b2?.expected_missing || [];
  check('a Monday behind Bolt’s next payout date with no payout seen IS flagged',
    miss.length === 1 && miss[0].expected_on === '2026-09-21', JSON.stringify(miss));
  /* What production said on 2026-09-23 while the ledger write was failing:
     "in either of Bolt's books … check the bank statement". Not the true
     reason — Bolt's ledger held the payout; WE had not stored it. */
  check('with the ledger day never stored, it names our collection gap — not Bolt, not the bank',
    miss[0]?.ledger_read === false && /not been stored/.test(miss[0]?.says || '')
    && /gap in our collection/.test(miss[0]?.says || '') && !/bank statement/.test(miss[0]?.says || ''),
    miss[0]?.says);
  check('the date in the sentence is a date, not "Mon Sep 28"',
    /next payout as 2026-09-28,/.test(miss[0]?.says || ''), miss[0]?.says);
  await q2(`INSERT INTO platform_balance_day (platform, fleet_id, day, currency, payout, balances)
            VALUES ('bolt','egari','2026-09-21','AED',NULL,true)`);
  const b3 = ((await m2.get('/api/finance/payouts')).body.coverage || []).find((c) => c.platform === 'bolt');
  const miss3 = b3?.expected_missing || [];
  check('with the ledger day read and no transfer on it, it asks for the bank statement',
    miss3.length === 1 && miss3[0].ledger_read === true && /was read and carries no bank transfer/.test(miss3[0].says)
    && /bank statement/.test(miss3[0].says) && /skipped/.test(miss3[0].says), JSON.stringify(miss3));
}

console.log('\nthe collector and the log, read from source');
{
  const src = readFileSync(new URL('../src/sources/bolt.js', import.meta.url), 'utf8');
  check('the ledger is asked about ONE day at a time — start and end are the same day',
    /getFleetBalanceDetails'[\s\S]{0,80}start_date: day, end_date: day/.test(src));
  check('a ledger failure cannot fail the payout run — it sits in its own function',
    /await pullBalance\(c, at, fails\)/.test(src) && /async function pullBalance/.test(src));
  check('collected_at is never written, so it keeps the first time a day was stored',
    !/platform_balance_day[\s\S]{0,40}collected_at/.test(src.slice(src.indexOf('async function pullBalance'))));
  const bal = src.slice(src.indexOf('async function pullBalance'), src.indexOf('export async function collect'));
  check('the ledger row is built by ledgerRow, so its JSONB columns are strings',
    /rows\.push\(ledgerRow\(SRC, c\.fleet, day, L\)\)/.test(bal) && !/payout_lines: L\.payout_lines/.test(bal));
  check('a failed ledger store is named as one, inside pullBalance — not left to read as "payouts <fleet>"',
    /try \{\s*await upsertMany\('platform_balance_day'/.test(bal) && /but not stored: /.test(bal));
  check('"no orders in window" is decided on what was COLLECTED, not on an array the sink emptied',
    /const collectedTotal = \(chunks \|\| \[\]\)\.reduce/.test(src) && /answered && !collectedTotal/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
