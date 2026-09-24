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
await add('damage', 1, 'deduction', 750, { sha: 'c'.repeat(64) });
/* THREE RECEIPT SHAPES, because the route has to tell them apart:
   'a' — a row, in date: served.
   'c' — a row whose retention has PASSED. The bytes are still in the table
         (nothing deletes them) but GET /api/ledger/receipt/:sha answers 410,
         so the register must not offer a link.
   'b' — a digest on the entry with NO row at all. Measured 2026-09-22,
         `grep -rn "DELETE FROM driver_ledger_receipt"` over src/, api/ and
         bin/ returns nothing, so this is NOT an expired receipt: it is one
         whose bytes were never stored. This file used to assert the opposite
         and pinned a sentence that was not true. */
await q(`INSERT INTO driver_ledger_receipt (sha256, bytes, content_type, byte_len, expires_on)
         VALUES ($1,'\\x00','image/jpeg',1,'2027-09-21')`, ['a'.repeat(64)]);
await q(`INSERT INTO driver_ledger_receipt (sha256, bytes, content_type, byte_len, expires_on)
         VALUES ($1,'\\x00','image/jpeg',1,'2025-01-31')`, ['c'.repeat(64)]);

const r = (await get('/api/ledger/entries')).body;

check('every entry is listed, verification included', r.entries.length === 6, String(r.entries.length));
check('and the verification row is flagged rather than hidden',
  r.entries.filter((e) => e.entry_source === 'verification').length === 1);
check('the totals EXCLUDE it', r.totals.advance === 3500, String(r.totals.advance));
check('and say so, rather than leaving a reader to assume either way',
  r.totals.excludes_verification === true && r.totals.verification_rows === 1);
check('each book totals separately — a deduction is not an advance',
  r.totals.deduction === 1050 && r.totals.pay === -3500, JSON.stringify(r.totals));
check('the row count is of everything in the window', r.totals.rows === 6, String(r.totals.rows));
check('nothing claims to be capped when it is not', r.listed_why === null, String(r.listed_why));

/* ── THE FOUR RECEIPT STATES, each with the TRUE reason ──────────────────
   This block asserted three and one of the three was a lie: an entry whose
   digest has no receipt row was described as having "passed its twelve-month
   retention and been removed", when nothing in this system deletes a receipt.
   And the genuinely expired case was not covered at all, which is how it came
   to ship reporting held:true and rendering a link that answers 410. */
const byType = Object.fromEntries(r.entries.map((e) => [`${e.type_code}:${e.amount}`, e]));
check('a receipt in date is held, and carries its digest',
  byType['cash_advance:5000'].receipt.held === true
  && byType['cash_advance:5000'].receipt.expired === false
  && byType['cash_advance:5000'].receipt.sha256 === 'a'.repeat(64));

/* THE ONE THAT MATTERS MOST. held:true on an expired receipt put a live
   "photograph" link on the page for a file the API refuses with 410. */
const exp = byType['damage:750'].receipt;
check('a receipt PAST its retention is NOT held, so nothing links to it',
  exp.held === false && exp.expired === true, JSON.stringify(exp));
check('and it says it was held until a date rather than never taken',
  /held until 2025-01-31/.test(exp.absent_reason)
  && /no longer serves it/.test(exp.absent_reason), exp.absent_reason);

/* THE CORRECTED ONE. */
const never = byType['repayment:-1500'].receipt;
check('a digest with no stored bytes says it was NEVER SAVED, not removed',
  never.held === false && never.expired === false
  && /never\s+saved rather than removed/.test(never.absent_reason.replace(/\s+/g, ' ')),
  never.absent_reason);
check('and it does not claim a retention that nothing in this system enforces',
  !/passed its twelve-month retention/i.test(never.absent_reason), never.absent_reason);

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
/* A named period is resolved to its dates, as every windowed route does —
   #charging sent period=month and was answered with the whole record. */
{
  const { periodWindow } = await import('../api/window.js');
  const m = (await get('/api/ledger/entries?period=month')).body;
  const [mf, mt] = periodWindow('month');
  check('period=month is answered over this month\'s dates, not the whole record',
    m.from === mf && m.to === mt, JSON.stringify([m.from, m.to, mf, mt]));
  const both = (await get('/api/ledger/entries?period=month&from=2026-09-11')).body;
  check('…explicit dates still win over a period', both.from === '2026-09-11' && both.entries.length === 0,
    JSON.stringify([both.from, both.to]));
  const none = (await get('/api/ledger/entries')).body;
  check('…and no window at all is still the whole record', none.from === null && none.to === null);
}
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
  /showing the 200 most recent of 211/.test(big.listed_why || ''), big.listed_why);
check('the totals are over the whole window, not over the page',
  big.totals.deduction === 1255, String(big.totals.deduction));

/* ── ONE TYPE, WITH ITS TOTALS STILL COMPUTED IN SQL ─────────────────────
   #charging asks about charging advances alone, and the tempting shape is for
   the page to pull book=advance and filter the ARRAY. That recomputes the
   headline from the 200-row cap this route returns — the exact defect the top
   of this file describes, where #payouts read "AED 319,015 · 6 transfers" over
   a register of 217 and AED 3.46m.

   So the filter is the route's, and these assertions are what hold it there:
   the totals and the per-person rollup must both move when the type is named,
   and both must be computed over the whole window rather than over the list. */
await add('charging_advance', 1, 'advance', 2400, { sha: 'c'.repeat(64), on: '2026-09-04' });
await q(`INSERT INTO driver (id, full_name) VALUES (8,'Second Subject')`);
await q(`INSERT INTO driver_ledger
     (person_id, person_name, resolved_from, type_code, direction, book, amount,
      effective_on, entered_by, note, entry_source, receipt_sha)
   VALUES (8,'Second Subject','human:ahsan','charging_advance',1,'advance',600,
           '2026-09-06','haseeb','n','manual',$1),
          (8,'Second Subject','human:ahsan','repayment',-1,'advance',-100,
           '2026-09-07','haseeb','n','manual',$1),
          (8,'Second Subject','human:ahsan','charging_advance',1,'advance',99999,
           '2026-09-08','haseeb','n','verification',$1)`, ['d'.repeat(64)]);

const chg = (await get('/api/ledger/entries?type_code=charging_advance')).body;
check('naming a type filters the register to it',
  chg.entries.every((e) => e.type_code === 'charging_advance'),
  JSON.stringify(chg.entries.map((e) => e.type_code)));
check('and echoes which type it answered about',
  chg.type_code === 'charging_advance', String(chg.type_code));
check('the advance total is that TYPE\'s, not the whole book\'s',
  chg.totals.advance === 3000, `${chg.totals.advance} (2400 + 600, and NOT the 5000 cash advance `
  + 'or the -1500 repayment that share the advance book)');
check('and the verification row is still excluded from it',
  chg.totals.verification_rows === 1 && chg.totals.advance === 3000,
  JSON.stringify(chg.totals));

/* ── THE PER-PERSON ROLLUP ─────────────────────────────────────────────── */
check('the register carries a per-person rollup',
  Array.isArray(chg.by_person) && chg.by_person.length === 2,
  JSON.stringify(chg.by_person));
const sub2 = chg.by_person.find((r) => r.person_id === 8);
check('each person\'s net is their own, in SQL rather than from the list',
  sub2 && sub2.net === 600 && sub2.out === 600, JSON.stringify(sub2));
check('and a verification row advances nobody anything',
  sub2.entries === 1, `${sub2 && sub2.entries} entries — the 99999 verification row must not count`);
check('the rollup is ordered by what is owed, largest first',
  chg.by_person[0].net >= chg.by_person[chg.by_person.length - 1].net,
  JSON.stringify(chg.by_person.map((r) => r.net)));
check('it carries an account id so a name on the page can open the person',
  chg.by_person.every((r) => 'ext_id' in r), JSON.stringify(chg.by_person[0]));

/* MONEY OUT AND MONEY BACK ARE SEPARATE COLUMNS, never one net figure alone:
   a driver advanced 600 and repaid 100 is a different conversation from one
   advanced 500 and repaid nothing, and a single net of 500 makes them look
   identical. */
const book = (await get('/api/ledger/entries?book=advance')).body;
const sub2b = book.by_person.find((r) => r.person_id === 8);
check('out and back are reported apart, not collapsed into the net',
  sub2b.out === 600 && sub2b.back === 100 && sub2b.net === 500, JSON.stringify(sub2b));

/* ── AN UNKNOWN TYPE IS REFUSED, NOT ANSWERED EMPTY ────────────────────── */
const bogus = await get('/api/ledger/entries?type_code=charging_advnace');
check('a misspelled type is REFUSED rather than answered with an empty register',
  bogus.status === 400, String(bogus.status));
check('because an empty register looks exactly like a type nobody has used',
  /look exactly like a type nobody has used/.test(JSON.stringify(bogus.body)),
  JSON.stringify(bogus.body).slice(0, 160));
check('and the refusal lists the types that DO exist',
  Array.isArray(bogus.body.types) && bogus.body.types.includes('charging_advance'),
  JSON.stringify(bogus.body.types || []).slice(0, 120));

console.log(`\n${fail ? '✗' : '✓'} ledger_register: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
