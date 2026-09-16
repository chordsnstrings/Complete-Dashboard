/* THE PAYOUT REGISTER — what each platform actually transferred, by date.
   ═══════════════════════════════════════════════════════════════════════════
   Asked for in these words: "find out other payout end points for bolt and
   yango and create a payout tab under finance and have it exactly on the date
   basis."

   Three facts were measured on production on 2026-09-16 and everything here
   defends one of them:

     UBER dates its transfer if, and only if, you ask one day at a time. Over
     five consecutive one-day organisation payment reports for Ecosine, the
     bank column was populated on exactly one of them —

       Mon 2026-09-07  earnings 15,985.57  cash -2,816.65  BANK -103,567.54
       Tue 2026-09-08  earnings 18,127.27  cash -2,902.50  BANK (empty)
       Wed 2026-09-09  earnings 19,426.04  cash -3,229.91  BANK (empty)
       Thu 2026-09-10  earnings 18,713.33  cash -3,460.75  BANK (empty)
       Fri 2026-09-11  earnings 21,066.24  cash -4,135.73  BANK (empty)

     and the balances chain across all five without a gap. An EMPTY bank cell
     is a measured nothing; an ABSENT bank column would be a provider change.
     The two must not map to the same value, which is what most of the mapper
     assertions below are about.

     BOLT dates every transfer on its own: 89 payouts over 89 distinct days for
     Ecosine back to 2024-12-30, each with `finished` as a unix second.

     YANGO PUBLISHES NO TRANSFER AT ALL. Its ledger is a driver-account ledger,
     and the three categories in it that mention a bank sit in a group Yango
     itself names "Payouts from account balance to contractors" — the park
     paying its own drivers. So the register must render Yango absent WITH THE
     REASON, and never as a zero: a zero would be a figure nobody measured
     sitting in a column of figures somebody did, and this product's house rule
     forbids exactly that.

   The route half is asserted against a real Postgres through the mounted app,
   because the failure that matters is SQL and no amount of reading it would
   catch a wrong join. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { payoutRow } from '../src/sources/bolt.js';
import { money, pathKey, COLUMNS } from '../src/sources/uber_payout.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ══ 1. Uber's cell reader: empty, absent and a thousands separator ═══════ */
console.log('an empty cell and a missing column are different facts');
{
  /* Uber leaves the bank column BLANK on a day with no transfer — measured on
     four of the five days above. Blank means the movement did not happen, so
     it is a measured zero. */
  check('a blank cell is a measured zero', money('') === 0, String(money('')));
  check('…and so is a blank with spaces around it', money('   ') === 0, String(money('   ')));
  /* A column that is not in the header at all has not been measured, and
     mapping it to 0 would report a provider change as a quiet day. */
  check('an absent column is null, not zero', money(null) === null, String(money(null)));
  check('and undefined is too', money(undefined) === null, String(money(undefined)));
  /* The report is a CSV of formatted money. parseFloat('103,567.54') is 103. */
  check('the thousands separator does not truncate the figure',
    money('-103,567.54') === -103567.54, String(money('-103,567.54')));
  check('a plain figure survives', money('15985.57') === 15985.57, String(money('15985.57')));
  /* Something that is neither blank nor a number is not a zero either. */
  check('a non-numeric cell is null rather than zero',
    money('n/a') === null, String(money('n/a')));
}

console.log('\nUber writes the same column path two ways in one header row');
{
  /* Both spellings are from the live report: 'Payouts : Cash collected' has
     spaces around the colon and 'Total earnings:Tip' does not. */
  check('the spaced and unspaced spellings key to the same thing',
    pathKey('Payouts : Transferred To Bank Account') === pathKey('Payouts:Transferred To Bank Account'),
    pathKey('Payouts : Transferred To Bank Account'));
  check('and the mapper is keyed on that squeezed form',
    COLUMNS.bank_transferred === 'payouts:transferred to bank account',
    COLUMNS.bank_transferred);
  check('the column names really are the ones the report sent',
    pathKey('Payouts : Cash collected') === COLUMNS.cash_collected
    && pathKey('Start of period balance') === COLUMNS.opening_balance
    && pathKey('End of period balance') === COLUMNS.closing_balance
    && pathKey('Total earnings') === COLUMNS.earnings);
}

/* ══ 2. Bolt's mapper ════════════════════════════════════════════════════ */
console.log('\nBolt dates each payout itself, and the date is the fleet’s');
{
  /* 2026-09-07T22:30:00Z is 02:30 on the EIGHTH in Dubai. A plain
     toISOString().slice(0,10) files it on the seventh, which is the wrong
     date on the one page whose entire requirement is the right one. */
  const late = payoutRow({ id: 2210441, sum: 3184.22, currency: 'aed',
    finished: Date.parse('2026-09-07T22:30:00Z') / 1000 }, 'ecosine');
  check('a payout landing after 20:00 UTC is filed on the NEXT Dubai day',
    late.paid_on === '2026-09-08', late.paid_on);
  const early = payoutRow({ id: 7, sum: 100, currency: 'aed',
    finished: Date.parse('2026-09-07T06:00:00Z') / 1000 }, 'ecosine');
  check('…and one inside the same UTC day is not moved', early.paid_on === '2026-09-07', early.paid_on);

  check('the provider’s own id is the key, so a re-run updates rather than duplicates',
    late.payout_ext_id === '2210441');
  check('the currency is normalised from Bolt’s lowercase', late.currency === 'AED', late.currency);
  /* platform_payout's claim is "this much reached the bank". Uber files its
     transfers negative; if Bolt's rows were signed differently the first query
     touching both would sum them wrongly. */
  check('the amount is positive, whatever sign arrives',
    payoutRow({ id: 8, sum: -500, finished: 1757000000 }, 'ecosine').amount === 500);
  /* Bolt does not say what a payout settles. Writing the payout's own date
     into both period columns would put an invented fact in the column whose
     whole job is to say what is known. */
  check('the period is left unstated rather than invented',
    late.period_start === null && late.period_end === null);

  /* Rows that fail the table's claim are dropped, not written as zero or as an
     undated row — the newest payout genuinely has no `finished` while it is
     still in flight. */
  check('a payout still in flight is dropped',
    payoutRow({ id: 9, sum: 100, finished: null }, 'ecosine') === null);
  check('a payout with no amount is dropped',
    payoutRow({ id: 10, sum: null, finished: 1757000000 }, 'ecosine') === null);
  check('a payout with no id is dropped, because nothing could key it',
    payoutRow({ id: null, sum: 100, finished: 1757000000 }, 'ecosine') === null);
  /* A zero or a millisecond stamp read as seconds both land in 1970. */
  check('a stamp before 2010 is not a date and is dropped',
    payoutRow({ id: 11, sum: 100, finished: 0 }, 'ecosine') === null
    && payoutRow({ id: 12, sum: 100, finished: 1 }, 'ecosine') === null);
}

/* ══ 3. the route, against a real database ═══════════════════════════════ */
const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);

const payout = (o) => q(
  `INSERT INTO platform_payout (platform, fleet_id, payout_ext_id, paid_on, amount,
                                currency, period_start, period_end, method, source)
   VALUES ($1,$2,$3,$4::date,$5,$6,$7::date,$8::date,$9,$10)`,
  [o.platform, o.fleet, o.id, o.day, o.amount, o.currency || 'AED',
    o.from || null, o.to || null, o.method || 'bank', o.source || 'test']);

const dayRow = (o) => q(
  `INSERT INTO platform_account_day (platform, fleet_id, day, currency, basis,
     opening_balance, closing_balance, earnings, refunds_expenses, cash_collected,
     bank_transferred, commission, tips, taxes)
   VALUES ($1,$2,$3::date,'AED',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  [o.platform, o.fleet, o.day, o.basis, o.open ?? null, o.close ?? null, o.earnings ?? null,
    o.refunds ?? null, o.cash ?? null, o.bank === undefined ? null : o.bank,
    o.commission ?? null, o.tips ?? null, o.taxes ?? null]);

/* Uber's measured week, as the one-day reports returned it. */
await payout({ platform: 'uber', fleet: 'ecosine', id: 'ecosine:2026-09-07',
  day: '2026-09-07', amount: 103567.54, from: '2026-08-31', to: '2026-09-06',
  source: 'REPORT_TYPE_PAYMENTS_ORGANIZATION (one-day window)' });
await payout({ platform: 'bolt', fleet: 'ecosine', id: '2210441', day: '2026-09-07',
  amount: 3184.22, source: 'fleetOwnerPortal/getPayouts' });
await payout({ platform: 'bolt', fleet: 'egari', id: '2210442', day: '2026-09-05',
  amount: 1290.15, source: 'fleetOwnerPortal/getPayouts' });
/* Outside the window every assertion below uses, so the window filter is
   actually exercised rather than assumed. */
await payout({ platform: 'bolt', fleet: 'ecosine', id: '1900001', day: '2024-12-30',
  amount: 500, source: 'fleetOwnerPortal/getPayouts' });

await dayRow({ platform: 'uber', fleet: 'ecosine', day: '2026-09-07', basis: 'statement',
  open: 103567.54, close: 14199.06, earnings: 15985.57, cash: -2816.65, bank: -103567.54 });
/* THE DAY WITH AN EMPTY BANK CELL. Stored as 0 — a measured nothing. */
await dayRow({ platform: 'uber', fleet: 'ecosine', day: '2026-09-08', basis: 'statement',
  open: 14199.06, close: 30531.51, earnings: 18127.27, cash: -2902.50, bank: 0 });
/* Yango's day, summed from its ledger. bank_transferred stays NULL. */
await dayRow({ platform: 'yango', fleet: 'ecosine', day: '2026-09-07', basis: 'ledger',
  earnings: 184.4, cash: 61, commission: -49.62, tips: 3.5, taxes: -12 });

const { get } = await mountAll(db);

console.log('\nthe register answers with transfers, not with derived earnings');
{
  const r = await get('/api/finance/payouts?from=2026-09-01&to=2026-09-30');
  check('the route answers', r.status === 200, String(r.status));
  const b = r.body;
  check('three transfers land in the window, and the 2024 one does not',
    b.payouts.length === 3, JSON.stringify(b.payouts.map((p) => p.paid_on)));
  check('Uber’s Monday wire is there at the measured figure',
    b.payouts.some((p) => p.platform === 'uber' && p.paid_on.toISOString?.().slice(0, 10) === '2026-09-07'
      || (p.platform === 'uber' && String(p.paid_on).slice(0, 10) === '2026-09-07'
        && Number(p.amount) === 103567.54)),
    JSON.stringify(b.payouts.find((p) => p.platform === 'uber')));
  /* The period Uber's wire settles is the week that ENDED the day before, and
     it is stored because it is knowable. Bolt's is not stated and must stay
     null rather than being filled with the payout's own date. */
  const uber = b.payouts.find((p) => p.platform === 'uber');
  const bolt = b.payouts.find((p) => p.platform === 'bolt');
  check('Uber’s transfer names the week it settles',
    String(uber.period_start).slice(0, 10) === '2026-08-31'
    && String(uber.period_end).slice(0, 10) === '2026-09-06',
    `${uber.period_start} – ${uber.period_end}`);
  check('Bolt’s does not, and is not given one',
    bolt.period_start === null && bolt.period_end === null,
    `${bolt.period_start} – ${bolt.period_end}`);
}

console.log('\nthe whole record travels beside the window, so a window is not read as a provider');
{
  const r = await get('/api/finance/payouts?from=2026-09-01&to=2026-09-30');
  const bolt = r.body.coverage.find((c) => c.platform === 'bolt');
  const span = bolt.record_span.find((s) => s.fleet_id === 'ecosine');
  check('Bolt’s record reaches back past the window',
    String(span.earliest).slice(0, 10) === '2024-12-30', String(span.earliest));
  check('…while the window total counts only what is in the window',
    Number(bolt.in_window.find((t) => t.fleet_id === 'ecosine').total) === 3184.22,
    JSON.stringify(bolt.in_window));
}

console.log('\nYango is absent WITH THE REASON, and never as a zero');
{
  const r = await get('/api/finance/payouts?from=2026-09-01&to=2026-09-30');
  const y = r.body.coverage.find((c) => c.platform === 'yango');
  check('Yango is named rather than left out of the answer', !!y);
  check('it is marked as publishing no transfer', y.publishes_payouts === false);
  check('it carries no total at all, not a total of zero',
    y.in_window.length === 0 && y.record_span.length === 0, JSON.stringify(y));
  /* The exact failure this product exists to prevent: a reason that is not the
     true one. "No data" and "not collected yet" would both be false here. */
  check('the reason names the group Yango itself puts those categories in',
    /Payouts from account balance to contractors/.test(y.absent || ''), y.absent);
  check('…and does not claim it is a collection gap',
    !/gap in collection|check the credential/i.test(y.absent || ''), y.absent);
  /* And the other half of the same distinction: a provider that DOES publish
     and has nothing stored must read as a gap to fix, not as a fact about the
     provider. Asked over a window with no rows in it at all. */
  const r2 = await get('/api/finance/payouts?from=2025-01-01&to=2025-01-31&platform=uber');
  const u = r2.body.coverage.find((c) => c.platform === 'uber');
  check('a provider that publishes and has rows elsewhere is not called a gap',
    u.absent === null, u.absent);
}

console.log('\nan empty bank cell and an unpublished one stay different all the way out');
{
  const r = await get('/api/finance/payouts?from=2026-09-01&to=2026-09-30');
  const days = r.body.days;
  const wired = days.find((d) => d.platform === 'uber' && String(d.day).slice(0, 10) === '2026-09-07');
  const quiet = days.find((d) => d.platform === 'uber' && String(d.day).slice(0, 10) === '2026-09-08');
  const yango = days.find((d) => d.platform === 'yango');
  check('the day Uber wired carries the figure',
    Number(wired.bank_transferred) === -103567.54, String(wired.bank_transferred));
  check('the day it did not carries a measured zero',
    quiet.bank_transferred !== null && Number(quiet.bank_transferred) === 0,
    String(quiet.bank_transferred));
  check('and Yango’s carries null, because Yango publishes no such column',
    yango.bank_transferred === null, String(yango.bank_transferred));
  /* basis is what lets a page say which rows can be checked against
     themselves. Uber publishes balances; our Yango sum has none. */
  check('the provider’s own statement is marked as one', wired.basis === 'statement');
  check('and a sum of dated rows is marked as a sum', yango.basis === 'ledger');
  check('Uber’s balances chain from one day to the next',
    Number(wired.closing_balance) === Number(quiet.opening_balance),
    `${wired.closing_balance} vs ${quiet.opening_balance}`);
  check('Yango has no balance to chain, and claims none',
    yango.opening_balance === null && yango.closing_balance === null);
  /* The commission Yango's ledger turned out to carry, which src/sources/
     yango.js says in as many words cannot be measured. */
  check('Yango’s platform fee reaches the page',
    Number(yango.commission) === -49.62, String(yango.commission));
  check('…and Uber’s is null, because Uber nets it off before the money arrives',
    wired.commission === null, String(wired.commission));
}

console.log('\nthe response says outright that this is not reconciliation’s figure');
{
  const r = await get('/api/finance/payouts?from=2026-09-01&to=2026-09-30');
  check('the note names the page it would otherwise be read as contradicting',
    /Bank reconciliation/i.test(r.body.note || ''), r.body.note);
  check('…and gives the measured size of the difference',
    /7\.1%/.test(r.body.note || ''), r.body.note);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
