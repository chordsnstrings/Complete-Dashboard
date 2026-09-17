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
import { settlesWeek } from '../src/sources/uber_payout.js';
import { weekdayOf } from '../api/public/payouts.js';
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

/* ══ 1b. THE DUBAI WEEKDAY, WHICH NOTHING HERE COULD SEE ═══════════════════
   This file INSERTed period_start by hand and asserted the route echoed it, so
   it proved the column round-trips and nothing about the code that fills it.
   Mutating the collector's weekday test from === 1 to === 9 left the suite
   green at 44 of 44 — a test that cannot see a total mutation of the thing it
   is meant to guard.

   The defect it could not see: `new Date(day + 'T00:00:00+04:00')` is the right
   INSTANT for Dubai midnight and is 20:00 on the PREVIOUS UTC day, so
   getUTCDay() answered the day before. On 2026-09-07 — a Monday, carrying
   Ecosine's AED 103,567.54 — it returned 0. The branch was false on every real
   wire, so every Monday payout was stored with a null period and the page said
   "this provider does not say which period a transfer settles", which is false
   for Uber and true for nobody. Both halves are asserted here directly. */
console.log('\nthe weekday of a Dubai date is the weekday of the DATE, not of an instant');
{
  /* The exact wire this module was built to capture. */
  const mon = settlesWeek('2026-09-07');
  check('a Monday wire names the Mon–Sun week that ended the day before',
    mon.period_start === '2026-08-31' && mon.period_end === '2026-09-06',
    JSON.stringify(mon));
  /* The mirror failure, which was LIVE: the old expression fired on a Dubai
     Tuesday, where it would have stamped a Tue–Mon span — the invented period
     the collector's own comment forbids. */
  check('a Tuesday names no period rather than an invented one',
    Object.keys(settlesWeek('2026-09-08')).length === 0, JSON.stringify(settlesWeek('2026-09-08')));
  check('…and so does the Sunday before it',
    Object.keys(settlesWeek('2026-09-06')).length === 0, JSON.stringify(settlesWeek('2026-09-06')));
  check('a date that does not parse names no period and does not throw',
    Object.keys(settlesWeek('not-a-date')).length === 0);
  /* The page half had the identical defect, and its output was worse because
     it was in the headline: the tile read "every one of them a Sunday" four
     rows above a coverage row saying "Uber wires on a Monday". */
  check('the page names the same weekday the collector does',
    weekdayOf('2026-09-07') === 'Monday', String(weekdayOf('2026-09-07')));
  check('…and does not shift any date back one day',
    weekdayOf('2026-09-08') === 'Tuesday' && weekdayOf('2026-08-31') === 'Monday'
    && weekdayOf('2026-09-06') === 'Sunday',
    [weekdayOf('2026-09-08'), weekdayOf('2026-08-31'), weekdayOf('2026-09-06')].join(', '));
  /* The two must agree by construction, not by coincidence: a page that names
     Monday over a row the collector left periodless is the contradiction this
     whole block exists to make impossible. */
  check('the two agree: every date the page calls Monday, the collector gives a period',
    ['2026-09-07', '2026-08-31', '2026-08-24', '2026-09-14', '2026-06-01'].every((d) =>
      (weekdayOf(d) === 'Monday') === (settlesWeek(d).period_start !== undefined)));
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

const { get, server } = await mountAll(db);

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

console.log('\nthe two tables agree about one wire, including its sign');
{
  /* THE ROUND TRIP, asserted across both tables rather than in each separately.
     platform_account_day keeps the PROVIDER's sign — Uber writes a payout
     negative because it leaves the account — and platform_payout keeps the
     TABLE's sign, positive, because its claim is "this much reached the bank"
     and Bolt fills the same column positive. Each table was already checked on
     its own above, and neither check would notice if one of them flipped: the
     relationship between them is the thing that has to hold, so it is the
     thing asserted. */
  const r = await get('/api/finance/payouts?from=2026-09-01&to=2026-09-30');
  const wire = r.body.payouts.find((x) => x.platform === 'uber');
  const day = r.body.days.find((d) => d.platform === 'uber'
    && String(d.day).slice(0, 10) === String(wire.paid_on).slice(0, 10));
  check('the transfer is filed on the same day the statement shows it leaving',
    !!day, String(wire.paid_on));
  check('the statement keeps Uber’s negative and the register keeps the table’s positive',
    Number(day.bank_transferred) < 0 && Number(wire.amount) > 0
    && Math.abs(Number(day.bank_transferred)) === Number(wire.amount),
    `${day.bank_transferred} vs ${wire.amount}`);
  /* The other direction, which is the one that would put an imaginary wire on
     the page: a day whose bank column is a measured ZERO must produce no row
     in the register at all. Four days in five are that day. */
  const quiet = r.body.days.find((d) => d.platform === 'uber'
    && Number(d.bank_transferred) === 0);
  check('a day Uber did not wire produces no transfer row, not a transfer of zero',
    !r.body.payouts.some((x) => x.platform === 'uber'
      && String(x.paid_on).slice(0, 10) === String(quiet.day).slice(0, 10)),
    String(quiet.day));
}

console.log('\nno provider both states a total and gives a reason for having none');
{
  /* The two halves of `coverage` answer the same question and a provider that
     filled in both would be saying "here is the figure" and "there is no
     figure, and here is why" in one object. A page rendering the reason beside
     a number is exactly the plausible-but-wrong explanation this product
     forbids, and it is one line to make impossible. */
  const r = await get('/api/finance/payouts?from=2026-09-01&to=2026-09-30');
  const both = r.body.coverage.filter((c) => c.absent && c.in_window.length);
  check('a reason and a total are mutually exclusive', both.length === 0,
    JSON.stringify(both.map((c) => c.platform)));
  /* And the complement: every provider in the answer says one or the other.
     Silence is the third state, and it is the one that renders as a zero. */
  const silent = r.body.coverage.filter((c) => !c.absent && !c.in_window.length);
  check('and every provider named says one or the other, never neither',
    silent.length === 0, JSON.stringify(silent.map((c) => c.platform)));
}

console.log('\nthe response says outright that this is not reconciliation’s figure');
{
  const r = await get('/api/finance/payouts?from=2026-09-01&to=2026-09-30');
  check('the note names the page it would otherwise be read as contradicting',
    /Bank reconciliation/i.test(r.body.note || ''), r.body.note);
  /* THIS ASSERTION USED TO READ /7\.1%/ AND IT HAD STOPPED CHECKING ANYTHING.
     ─────────────────────────────────────────────────────────────────────────
     THE DEFECT. The note's measured difference is now 0.20%: the old 7.1%
     compared the week of 7-13 Sep against the wire paid on 7 Sep, which by the
     Monday cadence settles 31 Aug - 6 Sep. When the note was corrected it kept
     the string "7.1%" inside the sentence that RETRACTS it — so this assertion
     went on passing, under a label saying it checks the measured size of the
     difference, while matching a figure the same sentence calls wrong. It
     would still have passed if 0.20% had been dropped entirely. CLAUDE.md's
     rule is that prose nobody checks is prose that lies; this was a check that
     had quietly stopped checking.

     Two assertions now, because one of them alone has a hole: the first pins
     the figure that is true, and the second allows the retraction to keep
     naming the old number ONLY while it is marked as retracted. */
  check('…and gives the measured size of the difference',
    /0\.20%/.test(r.body.note || ''), r.body.note);
  check('…and any mention of the old 7.1% is marked as the retracted figure',
    !/7\.1%/.test(r.body.note || '')
    || /used to|retract|mistake|previous|before it/i.test(r.body.note || ''), r.body.note);
}

/* CLOSE THE SERVER AND THE DATABASE, AND EXIT EXPLICITLY.
   ─────────────────────────────────────────────────────────────────────────
   Without this the file printed "44 passed, 0 failed" and then NEVER EXITED —
   confirmed by leaving it running for eleven minutes after its last line.
   mountAll calls app.listen(0) and deliberately sets keepAliveTimeout = 0 so
   that idle sockets are never reaped, which is right for a process that is
   about to end and fatal for one that is waiting to; PGlite holds its own
   handles besides. test/run-all.mjs SIGKILLs a file at 300 s and reports the
   kill as `TIMED OUT ... and was killed`, with the tally deliberately thrown
   away — so this file, with every one of its assertions passing, would have
   arrived in `npm test` as a FAILING file five minutes later. Every other
   mounted-route test in this directory ends exactly this way. */
server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
