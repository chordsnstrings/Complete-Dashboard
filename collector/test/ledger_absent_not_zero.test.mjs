/* TWO WAYS THIS LEDGER USED TO ANSWER A QUESTION IT HAD NOT BEEN ASKED.
   ══════════════════════════════════════════════════════════════════════════
   Both shipped. Both were found by reading the production responses rather
   than the code, and both are the house rule — "a figure that cannot be
   measured renders ABSENT WITH A REASON, never as zero" — broken in the one
   place where a wrong number changes what somebody is lent.

   ── ONE: NOTHING RECORDED CAME BACK AS NOUGHT ──────────────────────────
   api/ledger_routes.js read `r.advance == null ? 0 : Number(r.advance)` and
   put the result straight on the response. Measured on production
   2026-09-22, person 202 — who has LITERALLY ZERO ledger rows — came back
   `owes.advance: 0, owes.deduction: 0`. A supervisor reading that sees a
   driver who owes nothing. The truth is a driver nobody has written anything
   down about, and those are different facts: the first supports an advance,
   the second means the question has not been researched.

   The arithmetic still needs a number, so the fix is not to make the sums
   null — it is to carry the ROW COUNTS out of SQL, so the response can say
   which of the two it is. A person whose advances genuinely net to zero
   reports 0; a person with no rows reports null and the sentence.

   ── TWO: THE WRONG PARAMETER RETURNED THE WHOLE FLEET ──────────────────
   `personFor()` reads `?person_id=` or `?ext_id=`. Every other route in this
   product spells an account id `?id=`. Measured on production 2026-09-22:

     GET /api/ledger/exposure?id=6616272    -> people: 347   (the whole fleet)
     GET /api/ledger/exposure?ext_id=6616272 -> people: 1, person 202

   Both call sites guard the resolved-to-NOBODY case and neither guarded the
   never-asked case, because from inside they look identical — no person id.
   So a mistyped parameter answered with every driver's balance under a URL
   naming one driver, and nothing said so. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { get } = await mountAll(db);

/* THREE PEOPLE, chosen to separate the two facts this test exists to keep
   apart: one with no rows at all, one whose advances net to exactly zero, and
   one holding a real balance. */
await q(`INSERT INTO driver (id, full_name) VALUES
  (1,'Never Recorded'), (2,'Nets To Zero'), (3,'Owes Money')`);
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, display_name)
         VALUES ('bolt','acct-1',1,'Never Recorded')`);

const add = (person, type, dir, book, amt) => q(
  `INSERT INTO driver_ledger
     (person_id, person_name, resolved_from, type_code, direction, book, amount,
      effective_on, entered_by, note, entry_source)
   VALUES ($1,'x','human:t',$2,$3,$4,$5,'2026-09-10','ahsan','n','manual')`,
  [person, type, dir, book, amt]);

await add(2, 'cash_advance', 1, 'advance', 1000);
await add(2, 'repayment', -1, 'advance', -1000);
await add(3, 'cash_advance', 1, 'advance', 2500);

const people = (b) => Object.fromEntries((b.people || []).map((p) => [p.name, p]));

console.log('\nnothing recorded is not a balance of nought');
const r = (await get('/api/ledger/exposure')).body;
const by = people(r);

check('a person with NO ledger rows reports advance as absent, not 0',
  by['Never Recorded'].owes.advance === null && by['Never Recorded'].owes.deduction === null,
  JSON.stringify(by['Never Recorded'].owes));
check('and says why, in words a supervisor can act on',
  /balance nobody has written down/.test(by['Never Recorded'].owes.books_absent_reason || ''),
  by['Never Recorded'].owes.books_absent_reason);
check('the flag is explicit rather than left to be inferred from a null',
  by['Never Recorded'].owes.books_recorded === false);

/* THE DISCRIMINATING CASE. A sum of zero and no rows both look like "0" to a
   naive coalesce; only the row count separates them, which is why the count
   is carried out of SQL rather than derived from the sum. */
check('a person whose advances NET to zero reports 0 — a real measured balance',
  by['Nets To Zero'].owes.advance === 0, JSON.stringify(by['Nets To Zero'].owes));
check('and is NOT described as unrecorded',
  by['Nets To Zero'].owes.books_recorded === true
  && by['Nets To Zero'].owes.books_absent_reason === null,
  JSON.stringify(by['Nets To Zero'].owes));
check('with the row count that proves the distinction',
  by['Nets To Zero'].owes.advance_rows === 2 && by['Never Recorded'].owes.advance_rows === 0,
  `${by['Nets To Zero'].owes.advance_rows} vs ${by['Never Recorded'].owes.advance_rows}`);
check('and a real balance still reports as itself',
  by['Owes Money'].owes.advance === 2500, JSON.stringify(by['Owes Money'].owes));

console.log('\nasking the wrong question is not asking about nobody');

const all = (await get('/api/ledger/exposure')).body;
check('unfiltered, the route answers about everybody — the baseline',
  all.people.length === 3, String(all.people.length));

const right = (await get('/api/ledger/exposure?ext_id=acct-1')).body;
check('the parameter it DOES read narrows to one person',
  right.people.length === 1 && right.people[0].name === 'Never Recorded',
  JSON.stringify(right.people.map((p) => p.name)));

/* THE DEFECT. `?id=` is the spelling every other route uses; this one does
   not read it, and used to fall through to the whole fleet. */
const wrong = (await get('/api/ledger/exposure?id=acct-1')).body;
check('a parameter it does NOT read returns nobody, not everybody',
  (wrong.people || []).length === 0, `${(wrong.people || []).length} people came back`);
check('and names the parameter it could not use',
  /\?id=/.test(wrong.absent_reason || ''), wrong.absent_reason);
check('and names the two it CAN use, so the caller can correct it',
  /person_id/.test(wrong.absent_reason || '') && /ext_id/.test(wrong.absent_reason || ''),
  wrong.absent_reason);

/* The register does the same, through the same helper. */
const wrongReg = (await get('/api/ledger/entries?id=acct-1')).body;
check('the entries register refuses it the same way',
  wrongReg.totals.rows === 0 && /\?id=/.test(wrongReg.absent_reason || ''),
  JSON.stringify({ rows: wrongReg.totals.rows, why: wrongReg.absent_reason }));

/* AND THE ONE THAT MUST NOT REGRESS: a genuinely unfiltered call is still
   allowed. The fix refuses an UNRECOGNISED identifier, not the absence of one
   — #advances lists the whole fleet on purpose. */
check('while a call naming nobody at all is still the fleet-wide register',
  (await get('/api/ledger/entries')).body.totals.rows === 3,
  String((await get('/api/ledger/entries')).body.totals.rows));

console.log(`\n${fail ? '✗' : '✓'} ledger_absent_not_zero: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
