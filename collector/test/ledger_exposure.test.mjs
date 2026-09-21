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
