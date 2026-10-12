/* Shajahan Machilakath: the operator's ruling of 2026-10-12, on the spine.
   ──────────────────────────────────────────────────────────────────────────
   The bottom-45 driver report listed the Bolt "shajahan Mk" (#3) and the Uber
   "Shajahan Machilakath Machilakath" (#33) and flagged them — one car, L19262,
   a matching first name, never linked — rather than merging on a name. The
   operator: "the duplicate is a duplicate". api/identity_map.js carries it as
   the last HAND_MERGES entry (key 'shajahan machilakath'); sql/schema_v53.sql
   is regenerated from it. The Drivers page groups by the person spine, which
   folds two person rows only while neither carries money, and the Uber row
   carries his statements — so sql/schema_v105.sql is the recorded merge, the
   same statements sql/schema_v102.sql runs, for this one person.

   Proved by revert, each run against this file:
     (a) v105's body a no-op (RETURN before the loop): 6 of 12 fail — the
         fold, the accounts, the books, the SMS and cash rule, the audit row,
         and the refusal (nothing is refused when nothing runs).
     (b) v105's list keyed 'shajahan mk' (v102's key): 2 of 12 fail — the
         drift check, and the audit row's key. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { MERGES } from '../api/identity_map.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const V105 = readFileSync(new URL('../sql/schema_v105.sql', import.meta.url), 'utf8');

/* ══ 1. v105's list is the register's entry ══════════════════════════════ */
console.log('\nthe person v105 folds is the register\'s ruling of 2026-10-12');
const LIST = JSON.parse(V105.slice(V105.indexOf('$list$') + 6, V105.lastIndexOf('$list$')));
const es = MERGES.filter((m) => m.key === 'shajahan machilakath');
const want = es.length ? [{
  k: 'shajahan machilakath', keep: es[0].keep.id,
  alias: [...new Set(es.flatMap((m) => m.merge.ids || [m.merge.id]))].sort(),
  words: [...new Set(es.map((m) => m.ruling?.words))].sort(),
}] : [];
check('one person: the Uber survivor, both Bolt accounts, the operator\'s words',
  JSON.stringify(LIST) === JSON.stringify(want) && LIST[0]?.words[0] === 'the duplicate is a duplicate',
  JSON.stringify(LIST));
check('…ruled on 2026-10-12, by the operator, over no contradiction',
  es.length === 1 && es[0].verified === '2026-10-12' && es[0].ruling.by === 'operator' && es[0].contradictions.length === 0);
check('…and nothing in the register still carries the key v102 used for his Bolt accounts',
  !MERGES.some((m) => m.key === 'shajahan mk'));

/* ══ 2. v105 on production's shape ════════════════════════════════════════ */
const P = LIST[0];
const UBER = P.keep, [BOLT_B, BOLT_A] = [P.alias.find((a) => !/^\d+$/.test(a)), P.alias.find((a) => /^\d+$/.test(a))];
const db = new PGlite();
await applySchema(db);   // v105 runs here too, on an empty spine
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
check('on a fresh database v105 runs and moves nothing',
  (await q(`SELECT count(*)::int n FROM driver_ledger_audit`))[0].n === 0);

console.log('\nhis Uber row and the row v102 made of his Bolt accounts, money on both');
await q(`INSERT INTO driver (id, full_name, cash_rule) VALUES
  (701, 'Shajahan Machilakath Machilakath', NULL), (702, 'shajahan Mk', 'net_against_pay'),
  (800, 'Control Person', NULL)`);
await q(`SELECT setval(pg_get_serial_sequence('driver','id'), 900)`);
const acct = (plat, id, pid) => q(
  `INSERT INTO driver_platform_id (platform, external_id, driver_id, basis, linked_by)
   VALUES ($1,$2,$3,'account','spine')`, [plat, id, pid]);
await acct('uber', UBER, 701);
await acct('bolt', BOLT_A, 702);
await acct('bolt', BOLT_B, 702);
await acct('uber', '7654321', 800);
const led = (pid, type, dir, book, amt, ext) => q(
  `INSERT INTO driver_ledger (person_id, person_name, resolved_from, acct_platform, acct_ext_id,
                              type_code, direction, book, amount, effective_on, entered_by, note)
   VALUES ($1,'as entered','account','uber',$2,$3,$4,$5,$6,'2026-10-01','ahsan','test')`,
  [pid, ext, type, dir, book, amt]);
await led(701, 'cash_advance', 1, 'advance', 600, UBER);
await led(701, 'traffic_fine', 1, 'deduction', 90, UBER);
await led(702, 'cash_advance', 1, 'advance', 150, BOLT_A);
await led(800, 'cash_advance', 1, 'advance', 999, '7654321');
await q(`INSERT INTO sms_outbox (kind, dedupe_key, person_id, status)
         VALUES ('cash_deposit','cash:702:2026-10-01',702,'sent')`);
const books = async (pid) => Object.fromEntries((await q(
  `SELECT book, sum(amount)::float8 AS s FROM driver_ledger WHERE person_id = $1 GROUP BY book ORDER BY book`,
  [pid])).map((r) => [r.book, r.s]));
const ids = async () => (await q(`SELECT id::int FROM driver_ledger ORDER BY id`)).map((r) => r.id).join();
const beforeIds = await ids();

await db.exec(V105);
check('the Bolt row is gone and his Uber row stays',
  (await q(`SELECT id::int FROM driver WHERE id IN (701, 702) ORDER BY id`)).map((r) => r.id).join() === '701');
{
  const on = Object.fromEntries((await q(`SELECT external_id, driver_id::int AS pid FROM driver_platform_id
    WHERE external_id = ANY($1::text[])`, [[UBER, BOLT_A, BOLT_B]])).map((r) => [r.external_id, r.pid]));
  check('all three accounts on his one row', Object.values(on).length === 3 && Object.values(on).every((p) => p === 701),
    JSON.stringify(on));
}
check('no ledger entry lost or added; his books are the two rows\' added',
  (await ids()) === beforeIds && JSON.stringify(await books(701)) === '{"advance":750,"deduction":90}',
  JSON.stringify(await books(701)));
check('his SMS history and the Bolt row\'s cash rule came with him',
  (await q(`SELECT person_id::int p FROM sms_outbox`))[0].p === 701
  && (await q(`SELECT cash_rule FROM driver WHERE id = 701`))[0].cash_rule === 'net_against_pay');
const audit = await q(`SELECT outcome, payload FROM driver_ledger_audit WHERE action = 'person_merge'`);
check('one accepted audit row, via v105, naming the ruling, saying how to undo it',
  audit.length === 1 && audit[0].outcome === 'accepted' && audit[0].payload.via === 'sql/schema_v105.sql'
  && audit[0].payload.ruling?.on === '2026-10-12' && audit[0].payload.key === 'shajahan machilakath'
  && /move these entry/.test(audit[0].payload.reversible_by || ''), JSON.stringify(audit[0]?.payload || null).slice(0, 300));
check('the control person is untouched', JSON.stringify(await books(800)) === '{"advance":999}');
const snap = async () => JSON.stringify([await q(`SELECT * FROM driver ORDER BY id`),
  await q(`SELECT platform, external_id, driver_id FROM driver_platform_id ORDER BY 1, 2`),
  await q(`SELECT id, person_id FROM driver_ledger ORDER BY id`),
  await q(`SELECT count(*) FROM driver_ledger_audit`)]);
const once = await snap();
await db.exec(V105);
check('a replay moves nothing and writes no second audit row', (await snap()) === once);

console.log('\nan opening of one kind on both rows: refused, not merged');
{
  const d2 = new PGlite();
  await applySchema(d2);
  const q2 = (t, p = []) => d2.query(t, p).then((r) => r.rows);
  await q2(`INSERT INTO driver (id, full_name) VALUES (701, 'Shajahan Machilakath Machilakath'), (702, 'shajahan Mk')`);
  await q2(`INSERT INTO driver_platform_id (platform, external_id, driver_id, basis, linked_by)
            VALUES ('uber',$1,701,'account','spine'), ('bolt',$2,702,'account','spine')`, [UBER, BOLT_A]);
  for (const [pid, ext] of [[701, UBER], [702, BOLT_A]]) {
    await q2(`INSERT INTO driver_ledger (person_id, person_name, resolved_from, acct_platform, acct_ext_id,
                type_code, direction, book, amount, effective_on, entered_by, note)
              VALUES ($1,'x','account','uber',$2,'cash_opening',1,'cash',100,'2026-10-01','ahsan','t')`, [pid, ext]);
  }
  await d2.exec(V105);
  const r = await q2(`SELECT outcome, why FROM driver_ledger_audit WHERE action = 'person_merge'`);
  check('both rows stay, one refused audit row says why', (await q2(`SELECT count(*)::int n FROM driver`))[0].n === 2
    && r.length === 1 && r[0].outcome === 'refused' && /opening/.test(r[0].why), JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
