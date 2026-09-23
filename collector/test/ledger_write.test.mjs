/* THE WRITE PATH, AND THE DRY RUN THAT IS THE SAME CODE ROLLED BACK.
   ──────────────────────────────────────────────────────────────────────────
   CLAUDE.md requires a deployment to be verified on production with "every
   modal filled". Against a debt book that ritual writes permanent rows against
   real named people every time somebody checks the form works — and an
   append-only table has no way to tidy them up, only to reverse them, which a
   later reader cannot tell from a genuine correction.

   A preview that SIMULATED the write would prove nothing: the thing most
   likely to reject a row is the database itself, since sql/schema_v78.sql ties
   the sign to the type through a composite foreign key. A simulation would
   have to reimplement that rule and could then disagree with it. So the dry
   run executes the real statements against the real constraints and rolls
   back. What it reports is what would have happened, because it is what did.

   THE CALLER SENDS A MAGNITUDE, NEVER A SIGN, and the assertions below pin
   that: the direction comes from the registry, so the entire class of
   wrong-way-round entries cannot reach the database at all. A negative amount
   is refused by name rather than negated, because somebody sending one has
   misunderstood something and silently fixing it teaches them nothing. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { clearIdentityLinkCache } from '../api/identity_links.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
clearIdentityLinkCache();
const { port } = await mountAll(db);

const post = async (body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/ledger/entry`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const rows = async () => (await q(`SELECT count(*)::int n FROM driver_ledger`))[0].n;
const base = {
  platform: 'uber', ext_id: 'U-100', person_name: 'Tariq Afzal',
  type_code: 'cash_advance', amount: 4500, settles_via: 'cash',
  /* cash_advance requires proof — money physically changed hands. The digest
     is all the entry holds; deliberately NOT a foreign key, because the receipt
     expires at twelve months and the entry is permanent, so the row must be
     able to outlive its photograph. */
  receipt_sha: 'a'.repeat(64),
  effective_on: '2026-09-15', entered_by: 'ahsan', note: 'monthly advance, cash at the office',
};

/* ── the dry run is the default, and it writes nothing ───────────────────── */
const dry = await post(base);
check('a request with no dry_run flag PREVIEWS rather than writes',
  dry.body.ok === true && dry.body.dry_run === true && dry.body.wrote === false,
  JSON.stringify(dry.body).slice(0, 200));
check('and nothing reached the ledger', await rows() === 0, String(await rows()));
check('nor was a person left behind by the rolled-back resolve',
  (await q(`SELECT count(*)::int n FROM driver`))[0].n === 0);
check('the preview says plainly that nothing was written',
  /Nothing was written/i.test(dry.body.note || ''), dry.body.note);
check('it applied the sign from the TYPE, not from the caller',
  dry.body.entry.amount === 4500 && dry.body.entry.direction === 1,
  JSON.stringify([dry.body.entry.amount, dry.body.entry.direction]));
check('it reports the balance the entry would produce',
  dry.body.balances.after.advance === 4500, JSON.stringify(dry.body.balances));
/* "AED 4500.00" became "AED 4,500.00" on 2026-09-23, deliberately: the sentence
   is now printed through src/util.js aedText, which prints money the way every
   page does — two decimals AND a separator. */
check('and assembles the sentence the screen prints before saving',
  /ahsan is recording cash advance of AED 4,500\.00 to Tariq Afzal/i.test(dry.body.sentence)
  && /advance book moves from AED 0\.00 to AED 4,500\.00/i.test(dry.body.sentence),
  dry.body.sentence);

/* ── the real write ──────────────────────────────────────────────────────── */
const real = await post({ ...base, dry_run: false });
check('dry_run:false writes, and says it did',
  real.body.ok === true && real.body.wrote === true && real.body.entry.id > 0,
  JSON.stringify(real.body.entry).slice(0, 160));
check('one row landed', await rows() === 1);
check('the person was minted and recorded on the row',
  (await q(`SELECT person_id, person_name, resolved_from FROM driver_ledger`))[0].person_name === 'Tariq Afzal');
check('and an audit row was written beside it',
  (await q(`SELECT count(*)::int n FROM driver_ledger_audit WHERE outcome='accepted'`))[0].n >= 1);

/* ── a magnitude, never a sign ───────────────────────────────────────────── */
const neg = await post({ ...base, amount: -4500, allow_duplicate: true });
check('a NEGATIVE amount is refused by name, not silently negated',
  neg.status === 400 && /positive magnitude/i.test(JSON.stringify(neg.body.refused)),
  JSON.stringify(neg.body.refused));
const rep = await post({ ...base, type_code: 'repayment', amount: 1500, note: 'paid back in cash' });
check('a repayment sent as a POSITIVE magnitude is stored negative',
  rep.body.entry.amount === -1500 && rep.body.entry.direction === -1,
  JSON.stringify([rep.body.entry.amount, rep.body.entry.direction]));
check('and nets the advance down on the same book',
  rep.body.balances.after.advance === 3000, JSON.stringify(rep.body.balances));

/* ── the refusals, each naming what is wrong in words ────────────────────── */
const who = await post({ ...base, entered_by: 'somebody else' });
check('an unlisted supervisor is refused and the four are named',
  who.status === 400 && /ahsan, haseeb, hossam, shohaib/.test(JSON.stringify(who.body.refused)),
  JSON.stringify(who.body.refused));
check('and the refusal says this is attribution, not authentication',
  /attribution and not authentication/i.test(JSON.stringify(who.body.refused)));
const noNote = await post({ ...base, note: '' });
check('an entry with no note is refused', noNote.status === 400
  && /note is required/i.test(JSON.stringify(noNote.body.refused)));
const badType = await post({ ...base, type_code: 'made_up' });
check('an unknown type is refused and the real ones are listed',
  /is not a type this ledger holds/i.test(JSON.stringify(badType.body.refused)),
  JSON.stringify(badType.body.refused).slice(0, 160));
const noProof = await post({ ...base, receipt_sha: undefined, type_code: 'cash_deposit',
  amount: 200, note: 'cash handed in' });
check('a type that needs a photograph is refused without one',
  /requires a photograph/i.test(JSON.stringify(noProof.body.refused)),
  JSON.stringify(noProof.body.refused).slice(0, 140));
const exempt = await post({ ...base, type_code: 'salary', amount: 3500,
  period_start: '2026-09-01', period_end: '2026-09-30', settles_via: 'bank',
  note: 'September salary, all in', dry_run: false });
check('a type exempt from proof is accepted without one',
  exempt.body.ok === true, JSON.stringify(exempt.body.refused || exempt.body.entry));
check('and lands in the pay book, not the advance book',
  exempt.body.entry.book === 'pay' && exempt.body.balances.after.pay === -3500,
  JSON.stringify(exempt.body.balances));

/* ── the duplicate guard ─────────────────────────────────────────────────── */
const dup = await post({ ...base, dry_run: false });
check('a same person, same type, same amount, same day entry is refused',
  dup.status === 400 && /already has a/i.test(JSON.stringify(dup.body.refused)),
  JSON.stringify(dup.body.refused).slice(0, 170));
check('and the refusal names who entered the first one and when',
  /entered by ahsan/i.test(JSON.stringify(dup.body.refused)));
const dupOk = await post({ ...base, dry_run: false, allow_duplicate: true });
check('allow_duplicate lets a genuine second one through', dupOk.body.ok === true);

/* ── a database refusal reaches the operator, not a 500 ──────────────────── */
const badPeriod = await post({ ...base, period_start: '2026-09-30', period_end: '2026-09-01' });
check('an inverted period is refused with the reason, not a 500',
  badPeriod.status === 400 && /ends \(2026-09-01\) before it starts/i.test(
    JSON.stringify(badPeriod.body.refused)), JSON.stringify(badPeriod.body.refused));

/* ── verification rows exist and never reach a balance ───────────────────── */
const ver = await post({ ...base, dry_run: false, entry_source: 'verification',
  amount: 99999, allow_duplicate: true, note: 'proving the modal, not a real debt' });
check('a verification entry can be written', ver.body.ok === true);
/* Two cash advances of 4,500 were WRITTEN — the first and the allow_duplicate
   one. The 1,500 repayment above was a dry run and never landed, which is the
   point of it. So the live advance book is 9,000, and the 99,999 verification
   row must not appear in it. */
const bal = (await q(`SELECT round(sum(amount)::numeric,2) AS b FROM driver_ledger
                       WHERE book='advance' AND entry_source <> 'verification'`))[0].b;
check('and does not reach a balance that excludes it', Number(bal) === 9000, String(bal));
const withVer = (await q(`SELECT round(sum(amount)::numeric,2) AS b FROM driver_ledger
                           WHERE book='advance'`))[0].b;
check('while a sum that forgets to exclude it is visibly wrong',
  Number(withVer) === 108999, String(withVer));

console.log(`\n${fail ? '✗' : '✓'} ledger_write: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
