/* The ledger's constraints, and the one defect they exist to make impossible.
   ──────────────────────────────────────────────────────────────────────────
   A row entered the WRONG WAY ROUND is the worst thing sql/schema_v78.sql can
   carry. It moves a balance by twice the amount, in the direction nobody
   checks, and it looks exactly like a correct row on every screen. A repayment
   recorded as an advance turns AED 3,000 returned into AED 3,000 more owed —
   a 6,000 error against one person, discoverable only by reading the register
   line by line.

   Two constraints stop it and NEITHER is sufficient alone:

     driver_ledger_sign_ck        sign(amount) must equal direction
     driver_ledger_type_fk        (type_code, direction) must be a pair the
                                  registry declares

   With only the first, a writer could pass direction -1 with a cash_advance
   and a negative amount: internally consistent, and wrong. With only the
   second, the direction would be right and the amount's sign free. Both blocks
   below are therefore asserted separately, and both are proved by reverting.

   The second subject is the BOOK. A cash deposit and a loan repayment are both
   negative and they settle different obligations; summed into one figure, a
   driver who handed in their takings reads as having repaid a loan. The book
   column is what keeps them apart, and the last block proves it does.

   PROVED BY REVERTING: drop driver_ledger_type_fk and the composite-key block
   goes red; drop driver_ledger_sign_ck and the sign block goes red. Both were
   run that way before this file was committed. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { SCHEMA_FILES } from '../src/schema_files.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
let applied = 0;
for (const f of SCHEMA_FILES) {
  try { await db.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8')); applied++; }
  catch (e) { console.log(`  ✗ ${f}: ${String(e.message).slice(0, 200)}`); fail++; }
}
check('every schema file replays from empty', applied === SCHEMA_FILES.length, `${applied}/${SCHEMA_FILES.length}`);

const refuses = async (sql, p = []) => {
  try { await db.query(sql, p); return false; } catch { return true; }
};
const accepts = async (sql, p = []) => {
  try { await db.query(sql, p); return true; }
  catch (e) { console.log(`     ${String(e.message).slice(0, 170)}`); return false; }
};

await db.query(`INSERT INTO driver (id, full_name, cash_rule) VALUES (900, 'Ledger Subject', 'deposit_all')`);

/* One place the column list is written, so a test does not drift from the
   table the way prose does. */
const ins = (o) => {
  const row = {
    person_id: 900, person_name: 'Ledger Subject', resolved_from: 'human:ahsan',
    entered_by: 'ahsan', note: 'test entry', effective_on: '2026-09-15', ...o,
  };
  const keys = Object.keys(row);
  return [`INSERT INTO driver_ledger (${keys.join(',')})
           VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, keys.map((k) => row[k])];
};

/* ── the registry seeded, and seeded into four books ─────────────────────── */
const books = (await db.query(
  `SELECT book, count(*)::int n FROM ledger_type GROUP BY book ORDER BY book`)).rows;
check('the type registry seeded into exactly the four books',
  books.map((b) => b.book).join(',') === 'advance,cash,deduction,pay', JSON.stringify(books));
const [{ n: nTypes }] = (await db.query(`SELECT count(*)::int n FROM ledger_type`)).rows;
check('every seeded type carries a note a human can read',
  (await db.query(`SELECT count(*)::int n FROM ledger_type WHERE btrim(note) = ''`)).rows[0].n === 0,
  `${nTypes} types`);
/* The types that may carry no photograph, NAMED rather than counted, so that
   exempting another one has to be a deliberate edit to this line and to the
   rule in the schema beside it: proof is required where money or goods
   physically changed hands, and not required where the row records a decision
   or a period figure, which has no photograph to take. A write-off is on this
   list because no photograph of a decision exists — not because it needs less
   control; its control is an admin gate on the route. */
const noProof = (await db.query(
  `SELECT code FROM ledger_type WHERE NOT needs_proof ORDER BY code`)).rows.map((r) => r.code);
check('only the types that CANNOT have a receipt are exempt from one',
  noProof.join(',') === 'cash_opening,commission,deduction_waived,incentive,opening_balance,salary,salik,writeoff',
  noProof.join(','));

/* ── THE SIGN CONVENTION, ASSERTED OVER THE WHOLE REGISTRY ───────────────
   sql/schema_v78.sql states one rule — POSITIVE increases what the driver owes
   this company — and applies it eighteen times by hand. It got one wrong:
   cash_opening was seeded -1, and an opening cash position is cash the driver
   IS HOLDING, so they owe it. At -1 the whole opening position would have been
   SUBTRACTED from the exposure figure the 35% policy is enforced with, and
   every driver would have started the ledger looking safer than they are by
   twice whatever they were carrying.

   The composite key (type_code, direction) could not catch it: it guarantees
   an ENTRY agrees with its TYPE and says nothing about whether the type is
   right. So the rule is asserted here, by name, and in sql/schema_v79.sql at
   boot. A rule stated in prose and applied by hand eighteen times is a rule
   that will be wrong once. */
const owed = ['cash_advance', 'salary_advance', 'charging_advance', 'opening_balance',
  'cash_opening', 'salik', 'traffic_fine', 'damage', 'pay_out'];
const owing = ['repayment', 'writeoff', 'refund', 'cash_deposit', 'deduction_waived',
  'salary', 'commission', 'incentive', 'reimbursement'];
const dir = Object.fromEntries((await db.query(
  `SELECT code, direction FROM ledger_type`)).rows.map((r) => [r.code, r.direction]));
check('every type that INCREASES what the driver owes is +1',
  owed.every((c) => dir[c] === 1), owed.filter((c) => dir[c] !== 1).join(','));
check('every type that DECREASES it is -1',
  owing.every((c) => dir[c] === -1), owing.filter((c) => dir[c] !== -1).join(','));
check('an opening cash position is a POSITIVE obligation — they are holding our money',
  dir.cash_opening === 1, String(dir.cash_opening));
check('and handing it in is the negative of that', dir.cash_deposit === -1, String(dir.cash_deposit));
check('the two lists name every type in the registry, so a new one cannot slip past',
  owed.length + owing.length === Object.keys(dir).length,
  `${owed.length + owing.length} named vs ${Object.keys(dir).length} in the registry`);

/* ── a correct row ───────────────────────────────────────────────────────── */
check('a cash advance inserts, positive, in the advance book',
  await accepts(...ins({ type_code: 'cash_advance', direction: 1, book: 'advance',
    amount: 5000, settles_via: 'cash' })));

/* ── THE SIGN. amount must agree with direction ──────────────────────────── */
check('an advance with a NEGATIVE amount is refused',
  await refuses(...ins({ type_code: 'cash_advance', direction: 1, book: 'advance', amount: -5000 })));
check('a repayment with a POSITIVE amount is refused',
  await refuses(...ins({ type_code: 'repayment', direction: -1, book: 'advance', amount: 3000 })));
check('a zero amount is refused — it records nothing and would read as an event',
  await refuses(...ins({ type_code: 'cash_advance', direction: 1, book: 'advance', amount: 0 })));

/* ── THE COMPOSITE KEY. direction must be the TYPE's, not the writer's ───
   This is the block the sign check cannot cover: the row below is internally
   consistent — direction -1, amount negative — and claims a cash advance
   REDUCES what the driver owes. Only the registry knows otherwise. */
check('a cash advance claiming direction -1 is refused by the registry',
  await refuses(...ins({ type_code: 'cash_advance', direction: -1, book: 'advance', amount: -5000 })));
check('a repayment claiming direction +1 is refused by the registry',
  await refuses(...ins({ type_code: 'repayment', direction: 1, book: 'advance', amount: 3000 })));
check('a type the registry does not hold is refused',
  await refuses(...ins({ type_code: 'invented_type', direction: 1, book: 'advance', amount: 100 })));

/* ── the other guards ────────────────────────────────────────────────────── */
check('an undeclared settles_via is refused',
  await refuses(...ins({ type_code: 'cash_advance', direction: 1, book: 'advance',
    amount: 100, settles_via: 'venmo' })));
check('an undeclared entry_source is refused',
  await refuses(...ins({ type_code: 'cash_advance', direction: 1, book: 'advance',
    amount: 100, entry_source: 'guess' })));
check('a half-stated period is refused',
  await refuses(...ins({ type_code: 'salary', direction: -1, book: 'pay',
    amount: -3500, period_start: '2026-09-01' })));
check('a period that ends before it starts is refused',
  await refuses(...ins({ type_code: 'salary', direction: -1, book: 'pay',
    amount: -3500, period_start: '2026-09-30', period_end: '2026-09-01' })));
check('a whole period is accepted',
  await accepts(...ins({ type_code: 'salary', direction: -1, book: 'pay', amount: -3500,
    period_start: '2026-09-01', period_end: '2026-09-30', settles_via: 'none' })));

/* ── reversal, not deletion ──────────────────────────────────────────────── */
const [first] = (await db.query(
  `SELECT id FROM driver_ledger WHERE type_code = 'cash_advance' ORDER BY id LIMIT 1`)).rows;
check('a reversal points at the row it undoes',
  await accepts(...ins({ type_code: 'repayment', direction: -1, book: 'advance',
    amount: -5000, reverses_id: first.id, note: 'entered twice by mistake', settles_via: 'none' })));
check('the SAME row cannot be reversed twice',
  await refuses(...ins({ type_code: 'repayment', direction: -1, book: 'advance',
    amount: -5000, reverses_id: first.id, settles_via: 'none' })));

/* ── the books do not mix ────────────────────────────────────────────────
   A cash deposit and a loan repayment are both negative. If a balance summed
   them, a driver who handed in their takings would read as having repaid an
   advance. */
check('a cash deposit lands in the cash book',
  await accepts(...ins({ type_code: 'cash_deposit', direction: -1, book: 'cash',
    amount: -2000, settles_via: 'cash' })));
const bal = Object.fromEntries((await db.query(
  `SELECT book, sum(amount)::float AS bal FROM driver_ledger
    WHERE person_id = 900 AND entry_source <> 'verification' GROUP BY book`
)).rows.map((r) => [r.book, r.bal]));
check('the advance book nets the advance and its reversal to zero', bal.advance === 0, JSON.stringify(bal));
check('the cash deposit did NOT touch the advance book', bal.cash === -2000, JSON.stringify(bal));
check('recorded pay is its own book', bal.pay === -3500, JSON.stringify(bal));

/* ── a verification row exists and is excluded by construction ───────────── */
check('a verification entry can be written',
  await accepts(...ins({ type_code: 'cash_advance', direction: 1, book: 'advance',
    amount: 99999, entry_source: 'verification', note: 'proving the modal, not a real debt' })));
const [{ bal: liveAdv }] = (await db.query(
  `SELECT coalesce(sum(amount), 0)::float AS bal FROM driver_ledger
    WHERE person_id = 900 AND book = 'advance' AND entry_source <> 'verification'`)).rows;
check('and it does not reach a balance that excludes it', liveAdv === 0, String(liveAdv));

/* ── receipts, policy, audit ─────────────────────────────────────────────── */
check('a receipt of an undeclared type is refused',
  await refuses(`INSERT INTO driver_ledger_receipt (sha256, bytes, content_type, byte_len, expires_on)
                 VALUES ('a', '\\x00', 'application/pdf', 1, '2027-09-21')`));
check('a jpeg receipt is accepted, with an expiry',
  await accepts(`INSERT INTO driver_ledger_receipt (sha256, bytes, content_type, byte_len, expires_on)
                 VALUES ('b', '\\x00', 'image/jpeg', 1, '2027-09-21')`));
check('a policy threshold stores with an effective date and who set it',
  await accepts(`INSERT INTO ledger_policy (pct, effective_from, set_by, note)
                 VALUES (35.00, '2026-10-01', 'ahsan', 'opening policy')`));
check('a nonsense threshold is refused',
  await refuses(`INSERT INTO ledger_policy (pct, effective_from, set_by) VALUES (0, '2026-10-01', 'ahsan')`));
check('the policy table keeps history rather than one row',
  await accepts(`INSERT INTO ledger_policy (pct, effective_from, set_by, note)
                 VALUES (45.00, '2026-11-01', 'haseeb', 'raised for the peak season')`));
const [{ n: pol }] = (await db.query(`SELECT count(*)::int n FROM ledger_policy`)).rows;
check('both thresholds survive, so a past decision can be explained', pol === 2, String(pol));
check('an audit row records a REFUSED attempt, not only a successful one',
  await accepts(`INSERT INTO driver_ledger_audit (actor, action, outcome, why, person_id, payload)
                 VALUES ('ahsan', 'insert', 'refused', 'amount above the policy ceiling', 900, '{"amount":20000}'::jsonb)`));
check('an audit outcome outside the two is refused',
  await refuses(`INSERT INTO driver_ledger_audit (actor, action, outcome) VALUES ('ahsan', 'insert', 'maybe')`));

console.log(`\n${fail ? '✗' : '✓'} ledger_entries: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
