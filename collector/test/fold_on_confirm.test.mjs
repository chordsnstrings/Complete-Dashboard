/* CONFIRMING A PAIR FOLDS IT NOW, NOT IN HALF AN HOUR.
   ══════════════════════════════════════════════════════════════════════════
   THE DEFECT, reported by the operator 2026-09-21. They answered 93 pairs on
   #same-person, went back to the drivers page, and still saw one man as two
   rows — WISAL MUHAMMAD IRSHAD MUHAMMAD with three accounts and 6,892 trips,
   and 'wisal muhammad' with one account and none.

   Nothing was broken. Every confirmation was stored, the link
   122e8a0195…(yango) → 64686123…(uber) was confirmed, and the link layer put
   all four of his accounts in ONE component. What had not happened was the
   rebuild: src/persons.js turns components into person rows and runs on the
   collector's thirty-minute cycle. Measured at that moment — 407 people on the
   spine, 349 once it next ran. Fifty-eight folds already earned and invisible.

   So the merge worked and the page said it had not, which is worse than a
   merge that fails: the operator's next move is to do it again.

   Three things this file holds down.

   1. A CONFIRMATION FOLDS IN THE SAME REQUEST. The reviewer sees the answer
      before they look away.

   2. MONEY STILL STOPS IT. An empty person is safe to fold; one carrying a
      ledger entry is not, because folding moves a balance — that is an
      operation somebody authorises and which is recorded (/api/person/merge).
      The immediate path must not become a way around that.

   3. A FAILED FOLD IS A DELAY, NOT A LOST DECISION. The confirmation is
      already stored and the half-hourly pass still applies it. What must never
      happen is silence, because "it did nothing" is the impression this whole
      change exists to remove. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshPersons } from '../src/persons.js';
import { clearIdentityLinkCache } from '../api/identity_links.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { port } = await mountAll(db);
const decide = async (alias, verdict, by = 'ahsan') => {
  const r = await fetch(`http://127.0.0.1:${port}/api/same-person/decide`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ alias_ext_id: alias, verdict, by }),
  });
  return { status: r.status, body: await r.json() };
};
const people = async () => (await q(`SELECT count(*)::int n FROM driver`))[0].n;

/* Wisal's exact shape: four accounts across four channels. */
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, full_name, state) VALUES
  ('uber','W-UBER','Wisal Muhammad Muhammad','active'),
  ('bolt','W-BOLT','Wisal Muhammad Irshah Muhammad','active'),
  ('yango','W-YANGO','wisal muhammad','active'),
  ('uber','F-1','Farah Noor','active'),
  ('bolt','F-2','FARAH NOOR','active')`);
/* uber↔bolt already confirmed; the yango one is the proposal under review. */
await q(`INSERT INTO driver_identity_link
   (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
    canonical_name, canonical_key, basis, evidence, confirmed_at, confirmed_by)
   VALUES ('W-BOLT','bolt','Wisal Muhammad Irshah Muhammad','W-UBER','uber',
           'Wisal Muhammad Muhammad','wisal muhammad','shared_car_name',
           'the same car on 119 days', now(), 'ahsan')`);
await q(`INSERT INTO driver_identity_link
   (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
    canonical_name, canonical_key, basis, evidence)
   VALUES ('W-YANGO','yango','wisal muhammad','W-UBER','uber','Wisal Muhammad Muhammad',
           'wisal muhammad','same_name','both channels file this driver as the same name'),
          ('F-2','bolt','FARAH NOOR','F-1','uber','Farah Noor','farah noor',
           'same_name','both channels file this driver as the same name')`);
clearIdentityLinkCache();
await refreshPersons(db);

const before = await people();
check('the spine starts with the yango account on its own person',
  (await q(`SELECT count(DISTINCT driver_id)::int n FROM driver_platform_id
             WHERE external_id IN ('W-UBER','W-BOLT','W-YANGO')`))[0].n === 2,
  `${(await q(`SELECT count(DISTINCT driver_id)::int n FROM driver_platform_id WHERE external_id IN ('W-UBER','W-BOLT','W-YANGO')`))[0].n} persons`);

/* ── 1. THE ASSERTION THIS FILE EXISTS FOR ──────────────────────────────── */
const yes = await decide('W-YANGO', 'same');
check('confirming folds the component in the SAME request',
  (await q(`SELECT count(DISTINCT driver_id)::int n FROM driver_platform_id
             WHERE external_id IN ('W-UBER','W-BOLT','W-YANGO')`))[0].n === 1,
  JSON.stringify(yes.body.spine));
check('and the spine loses the duplicate person row',
  await people() === before - 1, `${await people()} vs ${before - 1}`);
check('the response says what it folded, rather than leaving the reader to reload',
  yes.body.spine && yes.body.spine.folded === 1, JSON.stringify(yes.body.spine));
check('and the effect sentence says it happened immediately',
  /folded 2 records into one immediately/.test(yes.body.effect || ''), yes.body.effect);

/* ── 2. MONEY STILL STOPS IT ────────────────────────────────────────────── */
const [farah] = await q(`SELECT driver_id FROM driver_platform_id WHERE external_id='F-1'`);
await q(`INSERT INTO driver_ledger
     (person_id, person_name, resolved_from, type_code, direction, book, amount,
      effective_on, entered_by, note)
   VALUES ($1,'Farah Noor','human:ahsan','cash_advance',1,'advance',900,
           '2026-09-10','ahsan','an advance that must not move by itself')`, [farah.driver_id]);
const now2 = await people();
const withMoney = await decide('F-2', 'same');
check('a confirmation whose records carry money does NOT fold here',
  await people() === now2, `${await people()} vs ${now2}`);
check('it says so, naming the balance as the reason',
  withMoney.body.spine && withMoney.body.spine.needs_merge === true
  && /moves a balance/.test(withMoney.body.spine.why || ''), JSON.stringify(withMoney.body.spine));
check('and points at the operation that does it properly',
  /person\/merge/.test(withMoney.body.spine.why || ''), withMoney.body.spine.why);
check('the entry has not moved', (await q(`SELECT person_id FROM driver_ledger`))[0].person_id == farah.driver_id);
check('the confirmation is still STORED, so the collector will apply it',
  (await q(`SELECT confirmed_at FROM driver_identity_link WHERE alias_ext_id='F-2'`))[0].confirmed_at != null);

/* ── 3. A VERDICT THAT IS NOT "same" FOLDS NOTHING ─────────────────────── */
const n3 = await people();
const no = await decide('F-2', 'different');
check('ruling two records apart folds nobody', await people() === n3);
check('and reports no spine action at all', no.body.spine == null, JSON.stringify(no.body.spine));

console.log(`\n${fail ? '✗' : '✓'} fold_on_confirm: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
