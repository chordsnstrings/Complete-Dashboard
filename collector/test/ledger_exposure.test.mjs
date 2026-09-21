/* THE 35% LINE, AND THE FOUR WAYS IT COULD BE WRONG IN SOMEBODY'S FAVOUR.
   ──────────────────────────────────────────────────────────────────────────
   This is the screen a person is refused an advance from, so every way it can
   mislead matters more than the arithmetic.

   1. NUMERATOR AND DENOMINATOR ON DIFFERENT KEYS. docs/COVERAGE.md records it
      from /api/alerts/by-driver: "worse than a plain divisor is a numerator
      and denominator folded on DIFFERENT keys." Before driver_platform_id it
      was unavoidable — advances would resolve through the boundary precedence
      while revenue came off tables keyed on the stored person_key, which never
      carries the link table (COVERAGE.md:480-484). A link-folded person would
      show the whole human's debt over one account's revenue. Both halves are
      now summed over one stored account list, and the first block proves a
      two-account person gets both.

   2. A MISSING CASH TERM RENDERED AS ZERO. The operator's policy counts cash
      the driver is holding INSIDE the 35%. unremitted is a daily figure and no
      remittance is recorded anywhere, so it cannot be accumulated into a
      position — until an opening position is stated or deposits are recorded,
      the cash term is UNKNOWN. Treating it as zero understates exposure, which
      is the direction that gets somebody lent more than they should be.

   3. A ZERO DENOMINATOR AS A ZERO RATIO. Somebody who generated nothing in the
      window has no ratio. That is not 0%.

   4. A FLEET PERCENTAGE. Percentages are personal by instruction. Dividing a
      sum of balances by a sum of revenue folds two different populations — the
      people who owe and the people who earn are not the same set — so the
      fleet figure is a COUNT over the line. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { get } = await mountAll(db);

await q(`INSERT INTO ledger_policy (pct, effective_from, set_by, note)
         VALUES (35.00, '2026-01-01', 'ahsan', 'opening policy')`);

const person = async (id, name, rule = 'deposit_all') =>
  q(`INSERT INTO driver (id, full_name, cash_rule) VALUES ($1,$2,$3)`, [id, name, rule]);
const acct = async (pid, platform, ext) =>
  q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, basis)
     VALUES ($1,$2,$3,'human:ahsan')`, [platform, ext, pid]);
const entry = async (pid, name, type, dir, book, amt, o = {}) =>
  q(`INSERT INTO driver_ledger
       (person_id, person_name, resolved_from, type_code, direction, book, amount,
        effective_on, entered_by, note, entry_source)
     VALUES ($1,$2,'human:ahsan',$3,$4,$5,$6,$7::date,'ahsan',$8,$9)`,
    [pid, name, type, dir, book, amt, o.on || '2026-09-10', o.note || 'test', o.src || 'manual']);
const earn = async (ext, day, amt, cash = 0) =>
  q(`INSERT INTO driver_payout_day
       (platform, driver_ext_id, day, period_start, period_end, earnings, cash_earnings)
     VALUES ('uber',$1,$2::date,$2::date,$2::date,$3,$4)`, [ext, day, amt, cash]);

/* ── 1. ONE PERSON, TWO ACCOUNTS: both halves must see both ─────────────── */
await person(1, 'Two Accounts');
await acct(1, 'uber', 'U-1'); await acct(1, 'bolt', 'B-1');
await earn('U-1', '2026-09-05', 6000, 1000);
await earn('B-1', '2026-09-06', 4000, 500);
await entry(1, 'Two Accounts', 'cash_advance', 1, 'advance', 2500);
await entry(1, 'Two Accounts', 'cash_opening', 1, 'cash', 1000);

const r = (await get('/api/ledger/exposure?from=2026-09-01&to=2026-09-30')).body;
const by = Object.fromEntries((r.people || []).map((p) => [p.name, p]));
const two = by['Two Accounts'];
check('the denominator sums revenue across BOTH the person\'s accounts',
  two?.earned === 10000, String(two?.earned));
check('and says how many accounts contributed, so a missing one is visible',
  two?.accounts === 2 && two?.accounts_with_revenue === 2,
  JSON.stringify([two?.accounts, two?.accounts_with_revenue]));
check('the numerator is advances plus deductions plus cash held',
  two?.owes.total === 3500, JSON.stringify(two?.owes));
check('and the ratio is that over revenue — 3500 of 10000',
  two?.exposure_pct === 35, String(two?.exposure_pct));
check('exactly on the line is not over it', two?.over_policy === false, String(two?.over_policy));
check('the verdict says so in words', /within the 35% line/.test(two?.verdict || ''), two?.verdict);

/* ── over the line ───────────────────────────────────────────────────────── */
await person(2, 'Over The Line');
await acct(2, 'uber', 'U-2');
await earn('U-2', '2026-09-05', 5000, 0);
await entry(2, 'Over The Line', 'cash_advance', 1, 'advance', 2000);
await entry(2, 'Over The Line', 'salik', 1, 'deduction', 300);
await entry(2, 'Over The Line', 'cash_opening', 1, 'cash', 500);
const r2 = (await get('/api/ledger/exposure?from=2026-09-01&to=2026-09-30')).body;
const over = Object.fromEntries(r2.people.map((p) => [p.name, p]))['Over The Line'];
check('deductions count toward exposure alongside advances and cash',
  over?.owes.total === 2800 && over?.exposure_pct === 56, JSON.stringify(over?.owes));
check('over the line is flagged', over?.over_policy === true);
check('and the verdict says an override is needed, not that it is blocked',
  /override is needed/.test(over?.verdict || '') && /Nothing is blocked/.test(over?.verdict || ''),
  over?.verdict);

/* ── PAY IS NOT EXPOSURE ─────────────────────────────────────────────────── */
await entry(2, 'Over The Line', 'salary', -1, 'pay', -3500);
const r3 = (await get('/api/ledger/exposure?from=2026-09-01&to=2026-09-30')).body;
const withPay = Object.fromEntries(r3.people.map((p) => [p.name, p]))['Over The Line'];
check('recording a salary does not reduce what the driver OWES',
  withPay?.owes.total === 2800 && withPay?.exposure_pct === 56, JSON.stringify(withPay?.owes));
check('the pay book is reported beside it, not inside it',
  withPay?.pay_book === -3500, String(withPay?.pay_book));

/* ── 2. A MISSING CASH TERM IS UNKNOWN, NOT ZERO ─────────────────────────── */
await person(3, 'No Cash Stated');
await acct(3, 'uber', 'U-3');
await earn('U-3', '2026-09-05', 8000, 2000);
await entry(3, 'No Cash Stated', 'cash_advance', 1, 'advance', 2000);
const r4 = (await get('/api/ledger/exposure?from=2026-09-01&to=2026-09-30')).body;
const noCash = Object.fromEntries(r4.people.map((p) => [p.name, p]))['No Cash Stated'];
check('a person with no stated cash position has a NULL cash term, not 0',
  noCash?.owes.cash === null, JSON.stringify(noCash?.owes));
check('and the reason says it is unknown rather than nothing',
  /It is not zero/i.test(noCash?.owes.cash_absent_reason || ''), noCash?.owes.cash_absent_reason);
check('so the whole exposure is unmeasured rather than understated',
  noCash?.exposure_pct === null && noCash?.owes.total === null);
check('and the reason names the direction the error would have run in',
  /understate exposure, which is the dangerous direction/i.test(
    noCash?.exposure_absent_reason || ''), noCash?.exposure_absent_reason);
check('the verdict is "not measurable", never a number',
  noCash?.verdict === 'not measurable', noCash?.verdict);

/* ── THE CASH POSITION: STATED, THEN ACCUMULATED FROM THAT DATE ─────────
   The operator: "we will ask the accountant team to update each driver's cash
   position as of the date that they will input. The new ones will take into
   account since that day."

   Three terms. The opening is the one a human states, and it is what makes the
   other two mean anything — without a starting balance there is nothing for
   collections to accumulate ONTO, and they would run from the beginning of the
   record, which for a driver of two years is a number nobody should act on.

   The collected half comes from TRIPS and not from driver_statement_day.
   unremitted, which is the obvious source and cannot be joined to a person:
   it is keyed on a normalised name, and measured on production 2026-09-21 only
   AED 315,771 of AED 1,935,693 — 16.3% — is reachable by id. A cash figure
   silently missing five-sixths of the collections would UNDERSTATE exposure,
   which is the direction that gets somebody lent more than they should be. */
/* $5 carries the id suffix separately from $3, the price. Sharing one
   parameter between a text concatenation and a numeric column makes Postgres
   infer it as text and refuse the INSERT — "you will need to rewrite or cast
   the expression", which is the error this fixture hit first. */
let tripN = 0;
const trip = async (ext, day, price, cash = true) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, requested_at,
                     status, payment_type, price)
   VALUES ('uber', $5, 'ecosine', $1, ($2 || ' 12:00+04')::timestamptz,
           'completed', $4, $3::numeric)`,
  [ext, day, price, cash ? 'cash' : 'card', `t${(tripN += 1)}`]);

await person(10, 'Stated And Since');
await acct(10, 'uber', 'U-10');
await earn('U-10', '2026-09-05', 10000, 0);
/* Stated on the 5th: AED 800 in hand. */
await entry(10, 'Stated And Since', 'cash_opening', 1, 'cash', 800, { on: '2026-09-05' });
/* A cash trip BEFORE the statement — already inside the 800, and must not be
   counted twice. */
await trip('U-10', '2026-09-03', 120);
/* Two after it, one of them unpriced. */
await trip('U-10', '2026-09-08', 200);
await trip('U-10', '2026-09-09', null);
/* And a card trip after it, which is not cash at all. */
await trip('U-10', '2026-09-10', 500, false);
/* AED 300 handed back on the 11th. */
await entry(10, 'Stated And Since', 'cash_deposit', -1, 'cash', -300, { on: '2026-09-11' });

const rc = (await get('/api/ledger/exposure?from=2026-09-01&to=2026-09-30')).body;
const st = Object.fromEntries(rc.people.map((p) => [p.name, p]))['Stated And Since'];
check('the cash position is the stated opening plus what came in, minus what went back',
  st?.owes.cash === 700, JSON.stringify(st?.owes.cash_basis));
check('the opening and its date are reported, not just folded into a total',
  st?.owes.cash_basis.opening === 800 && st?.owes.cash_basis.opening_on === '2026-09-05',
  JSON.stringify(st?.owes.cash_basis));
check('a cash trip BEFORE the stated date is not counted again',
  st?.owes.cash_basis.collected_since === 200, String(st?.owes.cash_basis.collected_since));
check('a card trip after it is not cash',
  st?.owes.cash_basis.collected_trips === 2, String(st?.owes.cash_basis.collected_trips));
check('and the deposit since is subtracted',
  st?.owes.cash_basis.handed_in_since === -300, String(st?.owes.cash_basis.handed_in_since));

/* THE FLOOR. Not every cash trip carries a price — 74.9% did over seven weeks
   on production — so the collected half is what can be PROVED, and a ratio
   built on it errs low. The row says so and by how many trips, rather than
   presenting a floor as a measurement. */
check('an unpriced cash trip makes the figure a stated floor',
  st?.owes.cash_basis.is_a_floor === true, JSON.stringify(st?.owes.cash_basis.is_a_floor));
check('naming how many trips carry no price, and that the exposure errs LOW',
  /1 of 2 cash trips since 2026-09-05 carry no price/.test(st?.owes.cash_basis.floor_reason || '')
  && /errs LOW/.test(st?.owes.cash_basis.floor_reason || ''), st?.owes.cash_basis.floor_reason);
check('the whole exposure is still measurable — a floor is a number, not an absence',
  st?.exposure_pct != null, String(st?.exposure_pct));

/* ── A BALANCE IS A POSITION, AND POSITIONS ARE NOT WINDOWED ────────────
   `from` governs the DENOMINATOR only. What somebody owes today is everything
   ever recorded against them up to the as-of date; bounding it below would
   answer "what did they take during September", which is a different question
   and a smaller number — and the 35% would then be enforced against a fraction
   of the real balance, which is the understating direction again.

   The ratio is deliberately a STOCK over a FLOW: what they hold now, against
   what they generate in a period. */
await person(12, 'Owed From Before');
await acct(12, 'uber', 'U-12');
await earn('U-12', '2026-09-05', 10000, 0);
/* Taken in JULY, long before the window asked about. */
await entry(12, 'Owed From Before', 'cash_advance', 1, 'advance', 3000, { on: '2026-07-02' });
await entry(12, 'Owed From Before', 'cash_opening', 1, 'cash', 500, { on: '2026-07-02' });
const rw = (await get('/api/ledger/exposure?from=2026-09-01&to=2026-09-30')).body;
const ow = Object.fromEntries(rw.people.map((p) => [p.name, p]))['Owed From Before'];
check('an advance taken before the window still counts against them',
  ow?.owes.advance === 3000, JSON.stringify(ow?.owes));
check('and so does a cash position stated before it',
  ow?.owes.cash === 500, String(ow?.owes.cash));
check('so the ratio is a stock over a flow — 3500 held against 10000 generated',
  ow?.exposure_pct === 35, String(ow?.exposure_pct));

/* ── AND WITHOUT AN OPENING, NOTHING ACCUMULATES ────────────────────────── */
await person(11, 'Never Stated');
await acct(11, 'uber', 'U-11');
await earn('U-11', '2026-09-05', 9000, 0);
await trip('U-11', '2026-09-08', 400);
const rn = (await get('/api/ledger/exposure?from=2026-09-01&to=2026-09-30')).body;
const ns = Object.fromEntries(rn.people.map((p) => [p.name, p]))['Never Stated'];
check('cash trips alone do NOT make a position', ns?.owes.cash === null,
  JSON.stringify(ns?.owes.cash));
check('the basis is absent rather than half-built', ns?.owes.cash_basis === null);
check('and the reason says the accounts team states it and from when',
  /accounts team states the position and the date it is as of/i.test(
    ns?.owes.cash_absent_reason || ''), ns?.owes.cash_absent_reason);
check('naming why the statement ledger cannot supply it either',
  /16\.3%/.test(ns?.owes.cash_absent_reason || ''), ns?.owes.cash_absent_reason);

/* ── 3. NO REVENUE IS NOT A ZERO RATIO ───────────────────────────────────── */
await person(4, 'No Revenue');
await acct(4, 'uber', 'U-4');
await entry(4, 'No Revenue', 'cash_advance', 1, 'advance', 1000);
await entry(4, 'No Revenue', 'cash_opening', 1, 'cash', 0.01);
const r5 = (await get('/api/ledger/exposure?from=2026-09-01&to=2026-09-30')).body;
const noRev = Object.fromEntries(r5.people.map((p) => [p.name, p]))['No Revenue'];
check('somebody who earned nothing has no ratio', noRev?.exposure_pct === null);
check('and the reason says a missing denominator, not a zero one',
  /none of this person's linked accounts reported earnings/i.test(
    noRev?.earned_absent_reason || ''), noRev?.earned_absent_reason);

/* A person with no account at all — the first-week salary advance case. */
await person(5, 'Brand New');
await entry(5, 'Brand New', 'salary_advance', 1, 'advance', 1500);
const r6 = (await get('/api/ledger/exposure?from=2026-09-01&to=2026-09-30')).body;
const brand = Object.fromEntries(r6.people.map((p) => [p.name, p]))['Brand New'];
check('a person with no platform account is reported, not dropped', !!brand);
check('with a reason naming why no revenue can be attributed to them',
  /no platform account linked/i.test(brand?.earned_absent_reason || ''),
  brand?.earned_absent_reason);

/* ── 4. NO FLEET PERCENTAGE ──────────────────────────────────────────────── */
check('the fleet figure is a COUNT of people over the line, not a percentage',
  r6.summary.fleet_ratio === null && typeof r6.summary.over_policy === 'number',
  JSON.stringify(r6.summary));
check('and says why a fleet percentage would fold two different populations',
  /not the same set/i.test(r6.summary.fleet_ratio_reason || ''), r6.summary.fleet_ratio_reason);
check('the summary separates measurable from not',
  r6.summary.measurable + r6.summary.not_measurable === r6.summary.people,
  JSON.stringify(r6.summary));

/* ── verification rows never reach the line ──────────────────────────────── */
await entry(1, 'Two Accounts', 'cash_advance', 1, 'advance', 99999, { src: 'verification' });
const r7 = (await get('/api/ledger/exposure?from=2026-09-01&to=2026-09-30')).body;
check('a verification entry does not move anybody\'s exposure',
  Object.fromEntries(r7.people.map((p) => [p.name, p]))['Two Accounts'].exposure_pct === 35);

/* ── the policy in force is the one on the row, not today's ─────────────── */
check('the threshold is reported with the date it took effect',
  r7.policy.pct === 35 && r7.policy.effective_from === '2026-01-01', JSON.stringify(r7.policy));

console.log(`\n${fail ? '✗' : '✓'} ledger_exposure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
