/* FOLDING TWO PEOPLE INTO ONE, AND MOVING THE MONEY WITH THEM.
   ══════════════════════════════════════════════════════════════════════════
   src/persons.js folds two person rows freely while NEITHER carries a ledger
   entry — the link was confirmed by a human, which is the review. The moment
   either carries money it stops, because re-pointing a balance is not a side
   effect a sweep that runs every half hour may have. This is the operation it
   leaves them for, and the operator chose its shape: "Move the rows, log the
   merge."

   So one balance afterwards, not a query that adds two together. Which makes
   four things load-bearing:

   1. THE ENTRIES MOVE. If they did not, the survivor's balance would be wrong
      by exactly the amount that used to sit on the other record — and the
      dropped person would be gone, so nothing would show where it went.

   2. THE AUDIT ROW NAMES EVERY ENTRY THAT MOVED. A merge made in error is
      undone by reading that row. Without the list, undoing it means guessing
      which of the survivor's entries used to be somebody else's.

   3. THE EVIDENCE ON EACH ENTRY DOES NOT MOVE. acct_ext_id records the account
      the money was recorded THROUGH and person_name records what the operator
      saw on screen. Both stay true whatever is later decided about identity,
      and rewriting them would make the audit trail agree with a decision taken
      afterwards — the one thing an audit trail must not do.

   4. THE DRY RUN IS THE DEFAULT, as everywhere else in this ledger. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { get, port } = await mountAll(db);
const post = async (body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/person/merge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

await q(`INSERT INTO driver (id, full_name) VALUES (1,'Tariq Afzal Said Afzal'), (2,'Tariq Afzal Afzal')`);
await q(`SELECT setval(pg_get_serial_sequence('driver','id'), (SELECT max(id) FROM driver))`);
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, basis)
         VALUES ('uber','U-T',1,'human'), ('bolt','B-T',2,'human')`);
const entry = (pid, name, type, dir, book, amt, acct) => q(
  `INSERT INTO driver_ledger
     (person_id, person_name, resolved_from, acct_platform, acct_ext_id, type_code, direction,
      book, amount, effective_on, entered_by, note)
   VALUES ($1,$2,'human:ahsan',$3,$4,$5,$6,$7,$8,'2026-09-10','ahsan','n') RETURNING id`,
  [pid, name, acct === 'U-T' ? 'uber' : 'bolt', acct, type, dir, book, amt]);
const [e1] = await entry(1, 'Tariq Afzal Said Afzal', 'cash_advance', 1, 'advance', 3000, 'U-T');
const [e2] = await entry(2, 'Tariq Afzal Afzal', 'cash_advance', 1, 'advance', 500, 'B-T');
const [e3] = await entry(2, 'Tariq Afzal Afzal', 'repayment', -1, 'advance', -200, 'B-T');

const bal = async (id) => Number((await q(
  `SELECT coalesce(sum(amount),0) AS t FROM driver_ledger WHERE person_id=$1`, [id]))[0].t);

/* ── the preview, read-only ──────────────────────────────────────────────── */
const pv = (await get('/api/person/merge?keep=1&drop=2')).body;
check('the preview says what each person is and what they carry',
  pv.keep.balance === 3000 && pv.drop.balance === 300 && pv.drop.entries === 2,
  JSON.stringify({ keep: pv.keep, drop: pv.drop }));
check('and names the accounts that would move', pv.drop.accounts.includes('B-T'),
  JSON.stringify(pv.drop.accounts));
check('reading it writes nothing', await bal(2) === 300);

/* ── the refusals ────────────────────────────────────────────────────────── */
const noBy = await post({ keep: 1, drop: 2, why: 'the same man' });
check('a merge with nobody attached to it is refused',
  /attribution and not authentication/.test(JSON.stringify(noBy.body.refused)),
  JSON.stringify(noBy.body.refused));
const noWhy = await post({ keep: 1, drop: 2, by: 'ahsan', why: '' });
check('and one with no reason is refused — the reason IS the record',
  /why this driver's balance changed/.test(JSON.stringify(noWhy.body.refused)),
  JSON.stringify(noWhy.body.refused));
const same = await post({ keep: 1, drop: 1, by: 'ahsan', why: 'x y z' });
check('merging somebody with themselves is refused',
  /same person/.test(JSON.stringify(same.body.refused)));
const ghost = await post({ keep: 1, drop: 99, by: 'ahsan', why: 'the same man' });
check('a person who does not exist is refused by id',
  /no person with id 99/.test(JSON.stringify(ghost.body.refused)), JSON.stringify(ghost.body.refused));
check('nothing was written by any refusal', await bal(1) === 3000 && await bal(2) === 300);

/* ── 4. THE DRY RUN IS THE DEFAULT ───────────────────────────────────────── */
const dry = await post({ keep: 1, drop: 2, by: 'ahsan', why: 'same phone, same car, one man' });
check('a request with no dry_run flag PREVIEWS rather than merging',
  dry.body.ok === true && dry.body.dry_run === true, JSON.stringify(dry.body.dry_run));
check('and it reports what WOULD move, in the conditional',
  dry.body.moved_entries === 2 && /^Would fold/.test(dry.body.sentence), dry.body.sentence);
check('with both people still there afterwards',
  (await q(`SELECT count(*)::int n FROM driver`))[0].n === 2 && await bal(2) === 300);

/* ── the merge ───────────────────────────────────────────────────────────── */
const done = await post({ keep: 1, drop: 2, by: 'ahsan',
  why: 'same phone and the same car on 119 days', dry_run: false });
check('the merge reports what it moved', done.body.moved_entries === 2
  && done.body.moved_amount === 300, JSON.stringify(done.body).slice(0, 200));

/* ── 1. THE ENTRIES MOVE ─────────────────────────────────────────────────── */
check('the survivor now carries ONE balance, not two that need adding up',
  await bal(1) === 3300, String(await bal(1)));
check('and the dropped person is gone',
  (await q(`SELECT count(*)::int n FROM driver WHERE id=2`))[0].n === 0);
check('their accounts moved too', (await q(
  `SELECT driver_id FROM driver_platform_id WHERE external_id='B-T'`))[0].driver_id == 1);

/* ── 3. THE EVIDENCE ON EACH ENTRY DOES NOT ─────────────────────────────── */
const moved = (await q(`SELECT * FROM driver_ledger WHERE id=$1`, [e2.id]))[0];
check('the account the money was recorded THROUGH is untouched',
  moved.acct_ext_id === 'B-T', String(moved.acct_ext_id));
check('and so is the name the operator saw when they recorded it',
  moved.person_name === 'Tariq Afzal Afzal', String(moved.person_name));

/* ── 2. THE AUDIT ROW NAMES EVERY ENTRY THAT MOVED ──────────────────────── */
const [audit] = await q(`SELECT * FROM driver_ledger_audit WHERE action='person_merge'`);
check('the merge is recorded permanently', audit != null);
check('naming who did it and why, in their words',
  audit.actor === 'ahsan' && /119 days/.test(audit.why || ''), audit.why);
const moveIds = (audit.payload.entries_moved || []).map((m) => m.id).sort();
check('and listing EVERY entry that moved, so it can be undone by reading it',
  moveIds.length === 2 && moveIds.includes(Number(e2.id)) && moveIds.includes(Number(e3.id)),
  JSON.stringify(audit.payload.entries_moved));
check('with the accounts that moved beside them',
  (audit.payload.accounts_moved || []).includes('B-T'), JSON.stringify(audit.payload.accounts_moved));
check('and it says how to reverse it rather than leaving that to be worked out',
  /move these entry ids back/.test(audit.payload.reversible_by || ''), audit.payload.reversible_by);
check('the entry the survivor already had is NOT in the moved list',
  !moveIds.includes(Number(e1.id)), JSON.stringify(moveIds));

console.log(`\n${fail ? '✗' : '✓'} person_merge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
