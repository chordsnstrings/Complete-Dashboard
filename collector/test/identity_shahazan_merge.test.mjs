/* Mohammad Shahin Mohammad Shahazanan: the operator's ruling of 2026-10-15.
   ──────────────────────────────────────────────────────────────────────────
   The bottom-45 driver report (14 Sep – 13 Oct) listed the Bolt "Mohammad
   Shahin Mohammad Shahazan" (#1) and the Uber "Mohammad Shahin Mohammad
   Shahazanan" (#42) and flagged them — one car, names a letter apart, never
   linked. Measured over both whole histories: the same five cars in the same
   order on the same dates, never two cars at once. The operator: "Yes merge".
   api/identity_map.js links the Bolt account onto the key the roster had
   already given his Uber and hotel records (the last HAND_MERGES entry);
   sql/schema_v53.sql is regenerated from it; sql/schema_v108.sql is the
   recorded merge of the person spine, v105's statements for this one person.

   The register keeps his HOTEL record as the key's survivor (it is flat: the
   Uber account is already an alias there), but the person row that survives
   the fold is the one holding his UBER account, which carries his trips — so
   the drift check below is about the ids, not about which one the register
   calls kept.

   Proved by revert, each run against this file: see FIX-STATUS ID-7. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { MERGES } from '../api/identity_map.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const V108 = readFileSync(new URL('../sql/schema_v108.sql', import.meta.url), 'utf8');
const KEY = 'mohammad shahin mohammad shahazanan';

/* ══ 1. v108's list is the register's key ════════════════════════════════ */
console.log('\nthe person v108 folds is the register\'s ruling of 2026-10-15');
const LIST = JSON.parse(V108.slice(V108.indexOf('$list$') + 6, V108.lastIndexOf('$list$')));
const onKey = MERGES.filter((m) => m.key === KEY);
const ruled = onKey.filter((m) => m.ruling);
const keyIds = [...new Set(onKey.flatMap((m) => [m.keep.id, ...(m.merge.ids || [m.merge.id])]))].sort();
const uberId = onKey.flatMap((m) => [m.keep, m.merge]).find((x) => x.channel === 'uber')?.id;
check('v108 names exactly the ids the register puts on this key, keeping the row with his Uber account',
  LIST.length === 1 && LIST[0].k === KEY && LIST[0].keep === uberId
    && JSON.stringify([LIST[0].keep, ...LIST[0].alias].sort()) === JSON.stringify(keyIds),
  JSON.stringify([LIST, keyIds, uberId]));
check('…with the operator\'s words, "Yes merge"', JSON.stringify(LIST[0]?.words) === JSON.stringify(['Yes merge'])
  && ruled.length === 1 && ruled[0].ruling.words === 'Yes merge');
check('…ruled on 2026-10-15, by the operator, over no contradiction, linking the Bolt account 6628697',
  ruled[0]?.verified === '2026-10-15' && ruled[0]?.ruling.by === 'operator' && ruled[0]?.contradictions.length === 0
    && ruled[0]?.merge.id === '6628697');
check('…and the Bolt account sits under no other key', MERGES.filter((m) => (m.merge.ids || [m.merge.id]).includes('6628697') || m.keep.id === '6628697').every((m) => m.key === KEY));

/* ══ 2. v105 on production's shape ════════════════════════════════════════ */
const P = LIST[0];
const UBER = P.keep, HOTEL = P.alias.find((a) => /^[0-9a-f]{24}$/.test(a)), BOLT = P.alias.find((a) => /^\d+$/.test(a));
const db = new PGlite();
await applySchema(db);   // v108 runs here too, on an empty spine
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
check('on a fresh database v108 runs and moves nothing',
  (await q(`SELECT count(*)::int n FROM driver_ledger_audit`))[0].n === 0);

console.log('\nproduction\'s shape: his Uber + hotel row (99) and his Bolt row (223), money on both');
await q(`INSERT INTO driver (id, full_name, cash_rule) VALUES
  (701, 'Mohammad Shahin Mohammad Shahazanan', NULL), (702, 'Mohammad Shahin Mohammad Shahazan', 'net_against_pay'),
  (800, 'Control Person', NULL)`);
await q(`SELECT setval(pg_get_serial_sequence('driver','id'), 900)`);
const acct = (plat, id, pid) => q(
  `INSERT INTO driver_platform_id (platform, external_id, driver_id, basis, linked_by)
   VALUES ($1,$2,$3,'account','spine')`, [plat, id, pid]);
await acct('uber', UBER, 701);
await acct('hotel', HOTEL, 701);
await acct('bolt', BOLT, 702);
await acct('uber', '7654321', 800);
const led = (pid, type, dir, book, amt, ext) => q(
  `INSERT INTO driver_ledger (person_id, person_name, resolved_from, acct_platform, acct_ext_id,
                              type_code, direction, book, amount, effective_on, entered_by, note)
   VALUES ($1,'as entered','account','uber',$2,$3,$4,$5,$6,'2026-10-01','ahsan','test')`,
  [pid, ext, type, dir, book, amt]);
await led(701, 'cash_advance', 1, 'advance', 600, UBER);
await led(701, 'traffic_fine', 1, 'deduction', 90, UBER);
await led(702, 'cash_advance', 1, 'advance', 150, BOLT);
await led(800, 'cash_advance', 1, 'advance', 999, '7654321');
await q(`INSERT INTO sms_outbox (kind, dedupe_key, person_id, status)
         VALUES ('cash_deposit','cash:702:2026-10-01',702,'sent')`);
const books = async (pid) => Object.fromEntries((await q(
  `SELECT book, sum(amount)::float8 AS s FROM driver_ledger WHERE person_id = $1 GROUP BY book ORDER BY book`,
  [pid])).map((r) => [r.book, r.s]));
const ids = async () => (await q(`SELECT id::int FROM driver_ledger ORDER BY id`)).map((r) => r.id).join();
const beforeIds = await ids();

await db.exec(V108);
check('the Bolt row is gone and his Uber row stays',
  (await q(`SELECT id::int FROM driver WHERE id IN (701, 702) ORDER BY id`)).map((r) => r.id).join() === '701');
{
  const on = Object.fromEntries((await q(`SELECT external_id, driver_id::int AS pid FROM driver_platform_id
    WHERE external_id = ANY($1::text[])`, [[UBER, HOTEL, BOLT]])).map((r) => [r.external_id, r.pid]));
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
check('one accepted audit row, via v108, naming the ruling, saying how to undo it',
  audit.length === 1 && audit[0].outcome === 'accepted' && audit[0].payload.via === 'sql/schema_v108.sql'
  && audit[0].payload.ruling?.on === '2026-10-15' && audit[0].payload.key === KEY
  && /move these entry/.test(audit[0].payload.reversible_by || ''), JSON.stringify(audit[0]?.payload || null).slice(0, 300));
check('the control person is untouched', JSON.stringify(await books(800)) === '{"advance":999}');
const snap = async () => JSON.stringify([await q(`SELECT * FROM driver ORDER BY id`),
  await q(`SELECT platform, external_id, driver_id FROM driver_platform_id ORDER BY 1, 2`),
  await q(`SELECT id, person_id FROM driver_ledger ORDER BY id`),
  await q(`SELECT count(*) FROM driver_ledger_audit`)]);
const once = await snap();
await db.exec(V108);
check('a replay moves nothing and writes no second audit row', (await snap()) === once);

console.log('\nan opening of one kind on both rows: refused, not merged');
{
  const d2 = new PGlite();
  await applySchema(d2);
  const q2 = (t, p = []) => d2.query(t, p).then((r) => r.rows);
  await q2(`INSERT INTO driver (id, full_name) VALUES (701, 'Mohammad Shahin Mohammad Shahazanan'), (702, 'Mohammad Shahin Mohammad Shahazan')`);
  await q2(`INSERT INTO driver_platform_id (platform, external_id, driver_id, basis, linked_by)
            VALUES ('uber',$1,701,'account','spine'), ('bolt',$2,702,'account','spine')`, [UBER, BOLT]);
  for (const [pid, ext] of [[701, UBER], [702, BOLT]]) {
    await q2(`INSERT INTO driver_ledger (person_id, person_name, resolved_from, acct_platform, acct_ext_id,
                type_code, direction, book, amount, effective_on, entered_by, note)
              VALUES ($1,'x','account','uber',$2,'cash_opening',1,'cash',100,'2026-10-01','ahsan','t')`, [pid, ext]);
  }
  await d2.exec(V108);
  const r = await q2(`SELECT outcome, why FROM driver_ledger_audit WHERE action = 'person_merge'`);
  check('both rows stay, one refused audit row says why', (await q2(`SELECT count(*)::int n FROM driver`))[0].n === 2
    && r.length === 1 && r[0].outcome === 'refused' && /opening/.test(r[0].why), JSON.stringify(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
