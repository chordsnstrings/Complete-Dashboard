/* THE REGISTER, AND THE TWO CLAIMS A LIST MUST NOT MAKE.
   ──────────────────────────────────────────────────────────────────────────
   1. A CAPPED LIST WHOSE TOTALS ARE THE LIST'S. #payouts shipped reading
      "AED 319,015 · 6 transfers on 2 dates" over a register of 217 transfers
      and AED 3.46m, because the route returned a slice and the page added up
      what it was given. Here the totals are computed over the WHOLE window in
      SQL and the response says how many rows it is showing of how many exist —
      and says it only when it is true, never implied by a count that happens
      to equal the cap.

   2. A MISSING PHOTOGRAPH THAT LOOKS LIKE A MISSING PHOTOGRAPH. Retention is
      twelve months and the entry is permanent, so three states have to be
      distinguishable: a receipt still held, one held until a date and since
      removed, and a type that never has one because it records a decision or a
      period figure. Collapsing those makes an expired proof read as an entry
      nobody ever documented.

   Verification rows are INCLUDED in the list and flagged, and excluded from
   every total. They exist so this repo's production ritual can fill a modal
   without recording a real debt, and a row hidden everywhere is a row nobody
   can audit. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { get } = await mountAll(db);

await q(`INSERT INTO driver (id, full_name) VALUES (7,'Register Subject')`);
const add = (type, dir, book, amt, o = {}) => q(
  `INSERT INTO driver_ledger
     (person_id, person_name, resolved_from, type_code, direction, book, amount,
      effective_on, entered_by, note, entry_source, receipt_sha)
   VALUES (7,'Register Subject','human:ahsan',$1,$2,$3,$4,$5::date,'ahsan',$6,$7,$8)`,
  [type, dir, book, amt, o.on || '2026-09-10', o.note || 'n', o.src || 'manual', o.sha || null]);

await add('cash_advance', 1, 'advance', 5000, { sha: 'a'.repeat(64) });
await add('repayment', -1, 'advance', -1500, { sha: 'b'.repeat(64) });
await add('salik', 1, 'deduction', 300);
await add('salary', -1, 'pay', -3500);
await add('cash_advance', 1, 'advance', 99999, { src: 'verification' });
/* One receipt still held, one already expired. */
await q(`INSERT INTO driver_ledger_receipt (sha256, bytes, content_type, byte_len, expires_on)
         VALUES ($1,'\\x00','image/jpeg',1,'2027-09-21')`, ['a'.repeat(64)]);

const r = (await get('/api/ledger/entries')).body;

check('every entry is listed, verification included', r.entries.length === 5, String(r.entries.length));
check('and the verification row is flagged rather than hidden',
  r.entries.filter((e) => e.entry_source === 'verification').length === 1);
check('the totals EXCLUDE it', r.totals.advance === 3500, String(r.totals.advance));
check('and say so, rather than leaving a reader to assume either way',
  r.totals.excludes_verification === true && r.totals.verification_rows === 1);
check('each book totals separately — a deduction is not an advance',
  r.totals.deduction === 300 && r.totals.pay === -3500, JSON.stringify(r.totals));
check('the row count is of everything in the window', r.totals.rows === 5, String(r.totals.rows));
check('nothing claims to be capped when it is not', r.listed_why === null, String(r.listed_why));

/* ── the three receipt states ────────────────────────────────────────────── */
const byType = Object.fromEntries(r.entries.map((e) => [`${e.type_code}:${e.amount}`, e]));
check('a held receipt says it is held',
  byType['cash_advance:5000'].receipt.held === true
  && byType['cash_advance:5000'].receipt.sha256 === 'a'.repeat(64));
check('a receipt whose bytes are gone is NOT reported as never taken',
  byType['repayment:-1500'].receipt.held === false
  && /passed its twelve-month retention/i.test(byType['repayment:-1500'].receipt.absent_reason),
  byType['repayment:-1500'].receipt.absent_reason);
check('and a type that never has one says THAT instead',
  /records a decision or a period figure/i.test(byType['salik:300'].receipt.absent_reason),
  byType['salik:300'].receipt.absent_reason);

/* ── filters ─────────────────────────────────────────────────────────────── */
const adv = (await get('/api/ledger/entries?book=advance')).body;
check('filtering by book narrows both the list and the totals',
  adv.entries.length === 3 && adv.totals.advance === 3500 && adv.totals.deduction === null,
  JSON.stringify(adv.totals));
const win = (await get('/api/ledger/entries?from=2026-09-11')).body;
check('a window that excludes everything returns an empty list and null totals',
  win.entries.length === 0 && win.totals.rows === 0 && win.totals.advance === null,
  JSON.stringify(win.totals));
const nobody = (await get('/api/ledger/entries?person_id=999')).body;
check('a person with no entries is an empty register, not an error',
  nobody.entries.length === 0 && nobody.totals.rows === 0);

/* ── the cap says so ─────────────────────────────────────────────────────── */
for (let i = 0; i < 205; i += 1) {
  // eslint-disable-next-line no-await-in-loop
  await add('salik', 1, 'deduction', 1, { on: '2026-08-01' });
}
const big = (await get('/api/ledger/entries')).body;
check('a long register is capped', big.entries.length === 200, String(big.entries.length));
check('and says how many of how many, with the totals over all of them',
  /showing the 200 most recent of 210/.test(big.listed_why || ''), big.listed_why);
check('the totals are over the whole window, not over the page',
  big.totals.deduction === 505, String(big.totals.deduction));

console.log(`\n${fail ? '✗' : '✓'} ledger_register: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
