/* IMPORTING HISTORY — propose, then commit only what a human chose.
   ══════════════════════════════════════════════════════════════════════════
   The split between the two routes IS the design:

     /preview  takes NAMES, writes nothing
     /commit   takes PERSON IDS, writes

   THE COMMIT ROUTE DOES NOT ACCEPT A NAME, and that is not an oversight. It
   makes auto-applying a match impossible at the boundary rather than merely
   discouraged by a comment: a row can only be written against somebody a human
   picked from the proposals, because there is no other way to address one.

   api/identity_map.js holds apart five pairs that carry simultaneous trips in
   two cars, two of them one letter apart. A matcher that wrote its own best
   guess would pool two people's debts at the moment money was imported against
   one of them — and an import is precisely when nobody is watching each row.

   ALL OR NOTHING. A half-applied import leaves a register nobody can reason
   about: some balances moved and some did not, and telling which means reading
   the sheet against the ledger row by row.

   AND ONLY THE TYPES A SHEET CAN CARRY. Every other type needs a photograph,
   and a spreadsheet has none — refused at PREVIEW, so nobody discovers it on
   row ninety. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { port } = await mountAll(db);

/* The roster's real shape: two men one token apart, whom api/identity_map.js
   deliberately keeps separate. */
await q(`INSERT INTO driver (id, full_name) VALUES
  (1,'Zubair Khan Shaukat Ali'), (2,'Muhammad Khalid'), (3,'Muhammad Khalid Gul'),
  (4,'Tariq Afzal Said Afzal')`);
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, basis)
  VALUES ('uber','U-1',1,'human'), ('uber','U-4',4,'human')`);

const post = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const rows = async () => (await q(`SELECT count(*)::int n FROM driver_ledger`))[0].n;

/* ── the preview ─────────────────────────────────────────────────────────── */
const pv = await post('/api/ledger/import/preview', { rows: [
  { name: 'Zubair Khan Ali', type_code: 'opening_balance', amount: '4,500.00',
    effective_on: '2026-09-01', note: 'carried in from the 2025 sheet' },
  { name: 'Muhammad Khalid G', type_code: 'opening_balance', amount: '2000',
    effective_on: '2026-09-01', note: 'carried in' },
  { name: 'Nobody At All', type_code: 'opening_balance', amount: '100',
    effective_on: '2026-09-01', note: 'carried in' },
  { name: 'Tariq Afzal Said Afzal', type_code: 'cash_advance', amount: '900',
    effective_on: '2026-09-01', note: 'carried in' },
  { name: 'Tariq Afzal Said Afzal', type_code: 'cash_opening', amount: 'lots',
    effective_on: '2026-13-99', note: '' },
] });

check('the preview answers', pv.status === 200, JSON.stringify(pv.body).slice(0, 120));
check('and writes nothing', await rows() === 0, String(await rows()));
check('it says so rather than leaving it to be assumed',
  /Nothing was written/.test(pv.body.note), pv.body.note);

const e = pv.body.entries;
check('a dropped middle name is matched and offered',
  e[0].match.verdict === 'likely' && e[0].match.person.person_id === 1 && e[0].ready === true,
  JSON.stringify(e[0].match));

/* THE ASSERTION THIS FILE EXISTS FOR. */
check('two candidates a hair apart are AMBIGUOUS and NOT offered',
  e[1].match.verdict === 'ambiguous' && e[1].ready === false, JSON.stringify(e[1].match));
check('and both are returned so a human sees the choice',
  e[1].match.alternatives.length >= 1,
  JSON.stringify(e[1].match.alternatives.map((a) => a.name)));
check('the reason says picking the higher one would be a coin toss',
  /coin toss/.test(e[1].match.why), e[1].match.why);

check('a name nobody on the roster resembles is unmatched, not guessed at',
  e[2].match.verdict === 'none' && e[2].match.person === null && e[2].ready === false);

/* A type that needs a photograph is refused AT PREVIEW. */
check('a type needing proof is refused before anybody types ninety rows',
  /requires a photograph/.test(e[3].problems.join(' ')), JSON.stringify(e[3].problems));
check('and the reason names which types a sheet CAN carry',
  /opening balance, an opening cash position, a period of tolls/.test(e[3].problems.join(' ')));

/* "2026-13-99" passes a shape check — thirteen is two digits and so is
   ninety-nine — and a sheet exported from the wrong locale is exactly where a
   month of 13 comes from. It takes a round-trip through Date to reject it. */
check('a bad amount, an IMPOSSIBLE date and a missing note are each named separately',
  e[4].problems.length >= 3 && e[4].problems.some((p) => /2026-13-99/.test(p)),
  JSON.stringify(e[4].problems));

check('the summary counts the verdicts',
  pv.body.summary.ambiguous === 1 && pv.body.summary.unmatched === 1
  && pv.body.summary.ready === 1, JSON.stringify(pv.body.summary));

/* ── the commit takes IDS, never names ──────────────────────────────────── */
const byName = await post('/api/ledger/import/commit', {
  batch: 'sheet-2026-09', entered_by: 'ahsan',
  rows: [{ name: 'Zubair Khan Shaukat Ali', type_code: 'opening_balance',
    amount: '4500', effective_on: '2026-09-01', note: 'x' }],
});
check('a row addressed by NAME is refused — the route takes ids only',
  byName.status === 400 && /takes person ids and never names/.test(
    JSON.stringify(byName.body.refused)), JSON.stringify(byName.body.refused));
check('and nothing was written', await rows() === 0);

/* ── all or nothing ─────────────────────────────────────────────────────── */
const partial = await post('/api/ledger/import/commit', {
  batch: 'sheet-2026-09', entered_by: 'ahsan',
  rows: [
    { person_id: 1, type_code: 'opening_balance', amount: '4500', effective_on: '2026-09-01', note: 'good' },
    { person_id: 999, type_code: 'opening_balance', amount: '100', effective_on: '2026-09-01', note: 'bad' },
  ],
});
check('one bad row refuses the whole import', partial.status === 400);
check('naming which row', /row 2/.test(JSON.stringify(partial.body.refused)),
  JSON.stringify(partial.body.refused));
check('and the good row was NOT written', await rows() === 0, String(await rows()));
check('the refusal says why all-or-nothing is the rule',
  /half-applied/.test(partial.body.note || ''), partial.body.note);

/* ── a clean commit ─────────────────────────────────────────────────────── */
const ok = await post('/api/ledger/import/commit', {
  batch: 'sheet-2026-09', entered_by: 'ahsan',
  rows: [
    { person_id: 1, type_code: 'opening_balance', amount: '4500', effective_on: '2026-09-01', note: 'carried in' },
    { person_id: 4, type_code: 'cash_opening', amount: '800', effective_on: '2026-09-05', note: 'counted at the office' },
  ],
});
check('a clean import writes every row', ok.body.ok === true && ok.body.wrote === 2,
  JSON.stringify(ok.body));
check('and they land', await rows() === 2);
const stored = await q(`SELECT person_id, type_code, amount, entry_source, import_batch,
                               resolved_from FROM driver_ledger ORDER BY person_id`);
check('each is marked as an import, not as a manual entry',
  stored.every((r) => r.entry_source === 'import'), JSON.stringify(stored));
check('and carries the batch, so one import can be found — and reversed — together',
  stored.every((r) => r.import_batch === 'sheet-2026-09'));
check('the resolver records that a human placed it',
  stored.every((r) => r.resolved_from === 'human:import'));
/* The sign still comes from the type, never from the sheet. */
check('the sign comes from the registry, not the spreadsheet',
  Number(stored[0].amount) === 4500 && Number(stored[1].amount) === 800,
  JSON.stringify(stored.map((r) => r.amount)));

/* And the audit row for the batch itself. */
check('the import is recorded in the audit trail as one act',
  (await q(`SELECT count(*)::int n FROM driver_ledger_audit WHERE action='import'`))[0].n === 1);

/* ── the cap refuses rather than truncates ──────────────────────────────── */
/* 501 SMALL rows. The cap was 2000 and was dead code — 2000 rows of a real
   sheet is several times the 256kb every JSON body in this process shares, so
   body-parser answered 413 and the cap never ran. A limit that cannot fire is
   worse than none, because it reads as a considered bound. */
const big = await post('/api/ledger/import/preview',
  { rows: Array.from({ length: 501 }, () => ({ name: 'x', type_code: 'opening_balance',
    amount: '1', effective_on: '2026-09-01', note: 'xxx' })) });
check('a sheet over the cap is refused entirely, not truncated',
  big.status === 400 && /Refused rather than truncated/.test(big.body.error || ''),
  JSON.stringify(big.body).slice(0, 160));
check('and the cap is one this route can actually reach',
  /500 rows at a time fits inside the 256kb/.test(big.body.error || ''), big.body.error);
/* 500 exactly must still be answered — an off-by-one on a cap is how a sheet
   that fits gets refused. */
const edge = await post('/api/ledger/import/preview',
  { rows: Array.from({ length: 500 }, () => ({ name: 'x', type_code: 'opening_balance',
    amount: '1', effective_on: '2026-09-01', note: 'xxx' })) });
check('and a sheet exactly at the cap is answered', edge.status === 200, String(edge.status));

console.log(`\n${fail ? '✗' : '✓'} ledger_import: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
