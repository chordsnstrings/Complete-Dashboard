/* The person a debt is keyed on, and the two rules that decide what a balance
   MEANS for that person.
   ──────────────────────────────────────────────────────────────────────────
   sql/schema_v77.sql adopts the `driver` / `driver_platform_id` pair that
   sql/schema.sql:28-43 declared and nothing ever wired up, and gives it the
   three things the advance ledger needs: a person who can exist before any
   platform account does, a per-person cash rule, and a per-person pay basis.

   What this file guards is not that the columns exist — a typo would be found
   the first time a route read one. It guards the two CHECK constraints, and it
   guards them because both encode a distinction that produces a WRONG NUMBER
   rather than an error when it is lost.

   cash_rule: counting undeposited cash as exposure AND deducting the same cash
   from a person's pay charges them twice for one sum of money. Which of the
   two is right is decided by this column alone, and a third value nobody has
   defined — or a typo'd one — would silently pick neither.

   pay_basis: the operator's instruction is that this system RECORDS what
   payroll decided and never calculates it. The basis is a label that explains
   a recorded figure. An undeclared value here is a pay arrangement no screen
   knows how to caption.

   NULL is permitted in both, deliberately, and is the reason the third
   assertion block exists: "nobody has said yet" is a real state, and the house
   rule is that it renders ABSENT WITH A REASON rather than defaulting to
   whichever value happens to be first. A NOT NULL here would have forced the
   import to invent one.

   PROVED BY REVERTING: drop either CHECK constraint from sql/schema_v77.sql and
   the matching block below goes red. A test that passes against the unchanged
   file has proved nothing. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { SCHEMA_FILES } from '../src/schema_files.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
/* Replayed in the SAME ORDER src/db.js replays them, from empty, because an
   ALTER in v77 against a table created in schema.sql only works if every file
   between them applied. This is also the cheapest guard there is that a new
   schema file does not break the boot. */
let applied = 0;
for (const f of SCHEMA_FILES) {
  try { await db.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8')); applied++; }
  catch (e) { console.log(`  ✗ ${f} did not apply: ${String(e.message).slice(0, 200)}`); fail++; }
}
check('every schema file replays from an empty database', applied === SCHEMA_FILES.length,
  `${applied}/${SCHEMA_FILES.length}`);

const refuses = async (sql) => {
  try { await db.query(sql); return false; } catch { return true; }
};
const accepts = async (sql) => {
  try { await db.query(sql); return true; } catch (e) { console.log(`     ${String(e.message).slice(0, 160)}`); return false; }
};

/* ── a person before any account ──────────────────────────────────────────
   The case that made a new key necessary: somebody in their first week, or on
   a salary only, who exists in no provider's records. api/driver_routes.js:176
   returns null for such an id, so before this table there was nothing to hang
   a salary advance on. */
check('a person can be created with no platform account at all',
  await accepts(`INSERT INTO driver (full_name, created_by, created_note)
                 VALUES ('New Hire', 'ahsan', 'first week, no platform account yet')`));

const [newHire] = (await db.query(
  `SELECT id, created_at IS NOT NULL AS stamped FROM driver WHERE full_name = 'New Hire'`)).rows;
check('that person gets an id this building owns', Number.isFinite(Number(newHire?.id)));
check('and a creation instant, unasked', newHire?.stamped === true);

/* ── the cash rule ────────────────────────────────────────────────────────── */
check('cash_rule accepts deposit_all',
  await accepts(`INSERT INTO driver (full_name, cash_rule) VALUES ('Deposits All', 'deposit_all')`));
check('cash_rule accepts net_against_pay',
  await accepts(`INSERT INTO driver (full_name, cash_rule) VALUES ('Nets It', 'net_against_pay')`));
check('cash_rule accepts NULL — "nobody has said" is a real state',
  await accepts(`INSERT INTO driver (full_name, cash_rule) VALUES ('Unstated', NULL)`));
check('cash_rule REFUSES a value nothing defines',
  await refuses(`INSERT INTO driver (full_name, cash_rule) VALUES ('Bad', 'keeps_some')`));
check('cash_rule refuses a near-miss spelling',
  await refuses(`INSERT INTO driver (full_name, cash_rule) VALUES ('Bad2', 'deposit-all')`));

/* ── the pay basis ────────────────────────────────────────────────────────── */
for (const v of ['fixed_salary', 'commission', 'salary_plus_incentive', 'other']) {
  check(`pay_basis accepts ${v}`,
    await accepts(`INSERT INTO driver (full_name, pay_basis) VALUES ('P ${v}', '${v}')`));
}
check('pay_basis accepts NULL',
  await accepts(`INSERT INTO driver (full_name, pay_basis) VALUES ('P null', NULL)`));
check('pay_basis REFUSES an undeclared arrangement',
  await refuses(`INSERT INTO driver (full_name, pay_basis) VALUES ('P bad', '30_percent')`));

/* ── NO RATE IS STORED, and that is a design decision, not an omission ─────
   A stored rate beside a revenue figure invites a reader to multiply and to
   expect the recorded pay to match it. It will not, because deductions apply
   and because payroll may simply have decided otherwise — and the page would
   then be contradicting itself in front of somebody whose wages are its
   subject. If a rate column is ever added, this assertion is where the
   argument for it has to be made. */
const driverCols = (await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name = 'driver'`
)).rows.map((r) => r.column_name);
check('no commission RATE is stored on the person',
  !driverCols.some((c) => /rate|percent|pct|commission_/.test(c)),
  driverCols.join(','));

/* ── the account map, and the basis that resolved it ──────────────────────
   api/identity_links.js:74-83 answers a failed query with an EMPTY map, and
   src/identity_link.js:605-610 withdraws unconfirmed links on every collector
   run. Both are correct for a directory and both are a silent un-merge for
   money. A stored basis is what survives them. */
check('an account attaches to a person, carrying the basis that decided it',
  await accepts(`INSERT INTO driver_platform_id (platform, external_id, driver_id, display_name, basis, linked_by)
                 VALUES ('uber', 'uber-123', ${newHire.id}, 'New Hire', 'human:ahsan', 'ahsan')`));

/* The hotel channel files a blank driver_ext_id, so api/driver_routes.js:286
   addresses those people by 'name:' || CANON(driver_name). Storing that string
   as an account is what lets a hotel-only person be reachable at all; RESOLVING
   through it at read time is what schema_v77 refuses to do. */
check('a synthesised hotel name: key stores as an account like any other',
  await accepts(`INSERT INTO driver_platform_id (platform, external_id, driver_id, display_name, basis, linked_by)
                 VALUES ('hotel', 'name:new hire', ${newHire.id}, 'NEW HIRE', 'human:ahsan', 'ahsan')`));

const [acct] = (await db.query(
  `SELECT count(*)::int AS n FROM driver_platform_id WHERE driver_id = ${newHire.id}`)).rows;
check('one person now holds both accounts', acct?.n === 2, String(acct?.n));

/* A detach is not a delete: the entries that resolved through this account
   must still read after it is closed. */
check('an account detaches with a reason rather than disappearing',
  await accepts(`UPDATE driver_platform_id SET detached_at = now(),
                        detached_reason = 'phone was reassigned'
                  WHERE external_id = 'name:new hire'`));
const [live] = (await db.query(
  `SELECT count(*)::int AS n FROM driver_platform_id
    WHERE driver_id = ${newHire.id} AND detached_at IS NULL`)).rows;
check('a detached account no longer resolves, and the row survives', live?.n === 1, String(live?.n));

/* One account may belong to at most one person. A chain would be an ambiguity
   and this table's whole claim is that it produces none — the same argument
   driver_identity_link makes for its own primary key in sql/schema_v65.sql. */
check('one account cannot be claimed by two people',
  await refuses(`INSERT INTO driver_platform_id (platform, external_id, driver_id)
                 VALUES ('uber', 'uber-123', ${newHire.id})`));

console.log(`\n${fail ? '✗' : '✓'} ledger_person: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
