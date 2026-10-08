/* The operator's review of 2026-10-08, on the person spine.
   ──────────────────────────────────────────────────────────────────────────
   api/identity_map.js carries the review's rulings and every rollup keyed on
   person_key follows them. The Drivers page does not: it groups by the person
   spine, which folds two person rows only while neither carries ledger money.
   Measured on production that morning, 35 of the 192 people ruled one person
   still sat on two Drivers-page rows, nearly all with money on both.

   Two migrations finish it, and this file holds both to what they say:

     sql/schema_v101.sql  the Yango "MUHAMMAD KHALID" (8089d680…) moved off the
                          person row it had been folded into — the operator:
                          "unlink these two and put it back in queue". The
                          spine never detaches, so putting the link back in the
                          queue did not split the row.
     sql/schema_v102.sql  every ruled person still on two rows folded onto one,
                          the way sql/schema_v93.sql folded Ali Abbas Ahmed,
                          with an audit row each — and REFUSED where an opening
                          sits on both rows, or the row that would fold holds
                          somebody else's account.

   Proved by revert, each run against this file:
     (a) v102's body emptied (the DO block a no-op): 11 of 29 fail — both
         folds, every audit row, both refusals.
     (b) the foreign-account guard removed from v102: 3 fail — Nadeem's second
         row folds, carrying a stranger's account onto him.
     (c) `AND external_id NOT LIKE 'name:%'` removed: 7 fail — Umar's fold is
         refused over his own synthesised hotel key.
     (d) v101's body emptied: 5 fail — the Yango account stays on Muhammad
         Khalifa Afzal Khalid, the refusal case records nothing, and the two
         "stays there" checks no longer pass by comparing 701 with 701 (they
         did, before this was proved; they now require the move first).
     (e) one person dropped from v102's list: 1 fails — the drift check. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { MERGES } from '../api/identity_map.js';
import { refreshPersons } from '../src/persons.js';
import { clearIdentityLinkCache } from '../api/identity_links.js';
import { clearPersonMapCache } from '../api/person_map.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const sorted = (a) => JSON.stringify([...a].sort());

const V101 = readFileSync(new URL('../sql/schema_v101.sql', import.meta.url), 'utf8');
const V102 = readFileSync(new URL('../sql/schema_v102.sql', import.meta.url), 'utf8');

/* ══ 1. v102's list is the register's ruling, not a copy that drifted ════ */
console.log('\nthe list v102 folds is exactly the people the register says were ruled on 2026-10-08');

const LIST = JSON.parse(V102.slice(V102.indexOf('$list$') + 6, V102.lastIndexOf('$list$')));
const want = [...new Set(MERGES.filter((m) => m.verified === '2026-10-08').map((m) => m.key))].sort()
  .map((k) => {
    const es = MERGES.filter((m) => m.key === k);
    return {
      k, keep: es[0].keep.id,
      alias: [...new Set(es.flatMap((m) => m.merge.ids || [m.merge.id]))].sort(),
      words: [...new Set(es.filter((m) => m.verified === '2026-10-08').map((m) => m.ruling.words))].sort(),
    };
  });
check('192 people, each with the survivor, every alias id on the key, and the ruling\'s words',
  LIST.length === 192 && JSON.stringify(LIST) === JSON.stringify(want),
  `${LIST.length} listed, ${want.length} in the register`
  + (LIST.length === want.length ? '' : `; missing ${want.filter((w) => !LIST.some((l) => l.k === w.k)).map((w) => w.k).slice(0, 3)}`));
check('…including the ones measured on two Drivers-page rows that morning',
  ['shehzad ahmad ghulam muhammad', 'umar ali zarid khan', 'younas khan shah', 'khan akbar khan',
    'sayed kamal sayed', 'alzain alfatih ahmed', 'soaieed alom ali', 'fayed ali muhammad']
    .every((k) => LIST.some((l) => l.k === k)));
check('…and neither account the operator held out appears anywhere in it',
  !V102.includes('6633205') && !V102.includes('8089d680edf14bccb846737205b30520'));

/* ══ 2. v102 on production's shape ═════════════════════════════════════ */
console.log('\nv102: ruled people on two person rows, money on both');

const P = Object.fromEntries(LIST.map((l) => [l.k, l]));
const UMAR = P['umar ali zarid khan'];        // folds: money on both, a detached and a name: account
const YOUNAS = P['younas khan shah'];         // refused: an opening on both rows
const NADEEM = P['muhammad nadeem ajmal'];    // refused: a stranger's account on the row that would fold
const AKBAR = P['khan akbar khan'];           // folds onto the lowest row: the keep is not placed
const SHERAZ = P['sheraz rehman khan'];       // already one row: nothing to do
const STRANGER = 'f0f0f0f0-0000-4000-8000-000000000001';

const db = new PGlite();
await applySchema(db);   // v101 and v102 run here too, on an empty spine: both must be no-ops
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
check('on a fresh database both files run and move nothing',
  (await q(`SELECT count(*)::int n FROM driver_ledger_audit`))[0].n === 0);

await q(`INSERT INTO driver (id, full_name, cash_rule) VALUES
  (501, 'Umar Ali Zarid Khan', NULL), (502, 'Umer Ali Zarid Khan', 'net_against_pay'),
  (511, 'Younas Khan Shah', NULL), (512, 'Younas Khan Islam Shah', NULL),
  (521, 'Muhammad Nadeem Ajmal', NULL), (522, 'Muhammad Nadeem Muhammad Ajmal', NULL),
  (531, 'Khan Akbar', NULL), (532, 'Khan Akbar Khan', NULL),
  (541, 'Sheraz Rehman Khan', NULL),
  (600, 'Control Person', NULL)`);
await q(`SELECT setval(pg_get_serial_sequence('driver','id'), 900)`);
const acct = (plat, id, pid, extra = {}) => q(
  `INSERT INTO driver_platform_id (platform, external_id, driver_id, basis, linked_by, detached_at)
   VALUES ($1,$2,$3,'account','spine',$4)`, [plat, id, pid, extra.detached ? new Date().toISOString() : null]);
await acct('hotel', UMAR.keep, 501);
await acct('uber', UMAR.alias[1], 501);              // 758b9949…
await acct('bolt', UMAR.alias[0], 502);              // 6628957
await acct('bolt', UMAR.alias[2], 502);              // 7859266
await acct('bolt', '7000002', 502, { detached: true });
await acct('hotel', 'name:umer ali zarid khan', 502);
await acct('uber', YOUNAS.keep, 511);
await acct('bolt', YOUNAS.alias[0], 512);
await acct('uber', NADEEM.keep, 521);
await acct('bolt', NADEEM.alias[0], 522);
await acct('uber', STRANGER, 522);
await acct('bolt', AKBAR.alias[1], 531);             // 8519699 — the keep is not placed anywhere
await acct('uber', AKBAR.alias[0], 532);             // 1f1bb8d4…
await acct('uber', SHERAZ.keep, 541);
await acct('bolt', SHERAZ.alias[0], 541);
await acct('uber', '1234567', 600);

const led = (pid, type, dir, book, amt, ext) => q(
  `INSERT INTO driver_ledger (person_id, person_name, resolved_from, acct_platform, acct_ext_id,
                              type_code, direction, book, amount, effective_on, entered_by, note)
   VALUES ($1,'as entered','account','uber',$2,$3,$4,$5,$6,'2026-10-01','ahsan','test')`,
  [pid, ext, type, dir, book, amt]);
await led(501, 'cash_advance', 1, 'advance', 800, UMAR.keep);
await led(502, 'cash_opening', 1, 'cash', 300, UMAR.alias[0]);
await led(502, 'salary_advance', 1, 'advance', 500, UMAR.alias[0]);
await led(502, 'traffic_fine', 1, 'deduction', 120, UMAR.alias[2]);
await led(511, 'cash_opening', 1, 'cash', 400, YOUNAS.keep);
await led(512, 'cash_opening', 1, 'cash', 250, YOUNAS.alias[0]);
await led(521, 'cash_advance', 1, 'advance', 100, NADEEM.keep);
await led(522, 'cash_advance', 1, 'advance', 200, NADEEM.alias[0]);
await led(531, 'cash_advance', 1, 'advance', 60, AKBAR.alias[1]);
await led(532, 'cash_deposit', -1, 'cash', -40, AKBAR.alias[0]);
await led(600, 'cash_advance', 1, 'advance', 700, '1234567');
await q(`INSERT INTO driver_ledger_audit (actor, action, outcome, why, person_id)
         VALUES ('ahsan','entry','accepted','test row on 502',502)`);
await q(`INSERT INTO sms_outbox (kind, dedupe_key, person_id, status)
         VALUES ('cash_deposit','cash:502:2026-10-01',502,'sent')`);

const ledger = () => q(`SELECT id::int, person_id::int AS pid, acct_ext_id, type_code, book,
                               amount::float8 AS amount FROM driver_ledger ORDER BY id`);
const before = await ledger();
const byBook = (rows, pids) => rows.filter((r) => pids.includes(r.pid)).reduce(
  (o, r) => ({ ...o, [r.book]: +((o[r.book] || 0) + r.amount).toFixed(2) }), {});
const snapshot = async () => JSON.stringify({
  driver: await q(`SELECT id::int, full_name, cash_rule FROM driver ORDER BY id`),
  accts: await q(`SELECT platform, external_id, driver_id::int, detached_at IS NOT NULL AS det
                    FROM driver_platform_id ORDER BY platform, external_id`),
  ledger: await ledger(),
  audit: await q(`SELECT id::int, person_id::int, action, outcome FROM driver_ledger_audit ORDER BY id`),
  sms: await q(`SELECT id::int, person_id::int FROM sms_outbox ORDER BY id`),
});

await db.exec(V102);
const after = await ledger();
const persons = async (ids) => (await q(`SELECT id::int FROM driver WHERE id = ANY($1::bigint[]) ORDER BY id`,
  [ids])).map((r) => r.id).join();
const onPerson = async (ids) => Object.fromEntries((await q(
  `SELECT external_id, driver_id::int AS pid FROM driver_platform_id WHERE external_id = ANY($1::text[])`,
  [ids])).map((r) => [r.external_id, r.pid]));
const merges = await q(`SELECT outcome, why, person_id::int AS pid, payload FROM driver_ledger_audit
                         WHERE action = 'person_merge' ORDER BY id`);
const audit = (k, outcome) => merges.filter((m) => m.payload?.key === k && m.outcome === outcome);

console.log('\nUmar Ali Zarid Khan: folded, money and all');
check('his second row is gone and the row holding the register\'s survivor stays',
  (await persons([501, 502])) === '501');
{
  const on = await onPerson([UMAR.keep, ...UMAR.alias, '7000002', 'name:umer ali zarid khan']);
  check('every account of his is on that row — the detached one and the hotel name: key too',
    Object.keys(on).length === 6 && Object.values(on).every((p) => p === 501), JSON.stringify(on));
}
check('no ledger entry is lost or added', sorted(after.map((r) => r.id)) === sorted(before.map((r) => r.id)));
check('the survivor\'s books are the two rows\' books added, book by book',
  JSON.stringify(byBook(after, [501])) === JSON.stringify(byBook(before, [501, 502]))
  && JSON.stringify(byBook(after, [501])) === '{"advance":1300,"cash":300,"deduction":120}',
  JSON.stringify(byBook(after, [501])));
check('the evidence on each entry stays — the account it was recorded through does not move',
  after.every((r) => before.find((b) => b.id === r.id)?.acct_ext_id === r.acct_ext_id));
check('the audit rows, the texts and the cash rule follow him',
  (await q(`SELECT person_id::int p FROM driver_ledger_audit WHERE action = 'entry'`))[0]?.p === 501
  && (await q(`SELECT person_id::int p FROM sms_outbox`))[0]?.p === 501
  && (await q(`SELECT cash_rule FROM driver WHERE id = 501`))[0]?.cash_rule === 'net_against_pay');
{
  const [m] = audit(UMAR.k, 'accepted');
  const p = m?.payload || {};
  check('ONE audit row, on the survivor, naming the ruling\'s words and every entry that moved',
    audit(UMAR.k, 'accepted').length === 1 && m.pid === 501 && p.keep === 501 && p.drop === 502
    && p.via === 'sql/schema_v102.sql'
    && sorted(p.ruling?.words || []) === sorted(['All 27 are the same', 'Yes, all 184'])
    && (p.entries_moved || []).length === 3 && p.moved_amount === 920
    && (p.accounts_moved || []).length === 4,
    JSON.stringify(m));
  check('…in a sentence a person can read',
    /Umer Ali Zarid Khan folded into Umar Ali Zarid Khan \(key 'umar ali zarid khan'\)/.test(m?.why || '')
    && /Moved 4 account\(s\) and 3 ledger entries worth 920/.test(m?.why || ''), m?.why);
}

console.log('\nKhan Akbar: the register\'s survivor has no row yet, so the lowest row survives');
check('532 folds into 531', (await persons([531, 532])) === '531');
check('…with both accounts and both entries',
  Object.values(await onPerson(AKBAR.alias)).every((p) => p === 531)
  && after.filter((r) => r.pid === 531).length === 2);

console.log('\nthe two it must refuse');
check('Younas Khan Shah: an opening on both rows — both rows stay, money untouched',
  (await persons([511, 512])) === '511,512'
  && JSON.stringify(after.filter((r) => [511, 512].includes(r.pid)))
    === JSON.stringify(before.filter((r) => [511, 512].includes(r.pid))));
check('…and the refusal is recorded, once, naming both openings',
  audit(YOUNAS.k, 'refused').length === 1
  && (audit(YOUNAS.k, 'refused')[0].payload?.openings_on_both || []).length === 2
  && /both carry an opening of the same kind/.test(audit(YOUNAS.k, 'refused')[0].why));
check('Muhammad Nadeem Ajmal: a stranger\'s account on the row that would fold — both rows stay',
  (await persons([521, 522])) === '521,522' && (await onPerson([STRANGER]))[STRANGER] === 522);
check('…and the refusal names the stranger\'s account and only it',
  audit(NADEEM.k, 'refused').length === 1
  && JSON.stringify((audit(NADEEM.k, 'refused')[0].payload?.foreign_accounts || [])
    .map((x) => [x.platform, x.ext_id])) === JSON.stringify([['uber', STRANGER]]),
  JSON.stringify(audit(NADEEM.k, 'refused')[0]?.payload?.foreign_accounts));

console.log('\nand what it must leave alone');
check('a person already on one row gets no audit row at all',
  (await persons([541])) === '541' && merges.every((m) => m.payload?.key !== SHERAZ.k));
check('somebody nobody ruled on keeps his row and his money',
  (await persons([600])) === '600'
  && JSON.stringify(after.filter((r) => r.pid === 600)) === JSON.stringify(before.filter((r) => r.pid === 600)));
check('exactly two folds and two refusals were written',
  merges.filter((m) => m.outcome === 'accepted').length === 2
  && merges.filter((m) => m.outcome === 'refused').length === 2, JSON.stringify(merges.map((m) => [m.payload?.key, m.outcome])));

const once = await snapshot();
await db.exec(V102);
check('replayed, v102 is a no-op — no row anywhere changes, no second audit row', (await snapshot()) === once);

/* ══ 3. v101: the Yango MUHAMMAD KHALID taken back off the row ════════ */
console.log('\nv101: the Yango account moves to a person of its own, and stays there');

const KHALIFA = P['muhammad khalifa afzal khalid'];
const YANGO = '8089d680edf14bccb846737205b30520';
const UBER_KHALID = '76ede4ae-768b-4126-804b-0b5c88043682';
const k = new PGlite();
await applySchema(k);
const qk = (t, p = []) => k.query(t, p).then((r) => r.rows);
await qk(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);
await qk(`INSERT INTO driver (id, full_name) VALUES (701, 'Muhammad Khalifa Afzal Khalid')`);
await qk(`SELECT setval(pg_get_serial_sequence('driver','id'), 900)`);
await qk(`INSERT INTO driver_platform_id (platform, external_id, driver_id, display_name, basis, linked_by) VALUES
  ('hotel', $1, 701, 'MUHAMMAD KHALIFA AFZAL KHALID', 'account', 'spine'),
  ('uber',  $2, 701, 'Muhammad Khalid', 'register', 'spine'),
  ('bolt',  $3, 701, 'Muhammad Khalifa', 'register', 'spine'),
  ('yango', $4, 701, 'MUHAMMAD KHALID', 'link', 'spine')`,
[KHALIFA.keep, UBER_KHALID, KHALIFA.alias[0], YANGO]);
await qk(`INSERT INTO driver_ledger (person_id, person_name, resolved_from, acct_platform, acct_ext_id,
                                     type_code, direction, book, amount, effective_on, entered_by, note)
          VALUES (701,'Muhammad Khalid','account','uber',$1,'cash_advance',1,'advance',1000,'2026-10-01','ahsan','test')`,
[UBER_KHALID]);
/* The link, back in the queue as the operator asked: present, unconfirmed. */
await qk(`INSERT INTO driver_identity_link (alias_ext_id, alias_platform, alias_name, canonical_ext_id,
            canonical_platform, canonical_name, canonical_key, basis, evidence)
          VALUES ($1,'yango','MUHAMMAD KHALID',$2,'uber','Muhammad Khalid','muhammad khalid','same_name','test')`,
[YANGO, UBER_KHALID]);
/* Trips on both, so the spine sees both accounts when it runs below. */
await qk(`INSERT INTO trip (platform, fleet_id, external_id, driver_ext_id, driver_name, plate,
                            requested_at, ended_at, status, distance_km)
          VALUES ('uber','ecosine','k1',$1,'Muhammad Khalid','L90721','2026-10-01T08:00:00+04','2026-10-01T08:20:00+04','completed',5),
                 ('yango','ecosine','k2',$2,'MUHAMMAD KHALID','L11111','2026-10-01T08:05:00+04','2026-10-01T08:25:00+04','completed',5)`,
[UBER_KHALID, YANGO]);
const kSnap = async () => JSON.stringify({
  driver: await qk(`SELECT id::int, full_name, created_by FROM driver ORDER BY id`),
  accts: await qk(`SELECT external_id, driver_id::int FROM driver_platform_id ORDER BY external_id`),
  audit: await qk(`SELECT id::int, action, outcome FROM driver_ledger_audit ORDER BY id`),
});

await k.exec(V101);
const yRow = (await qk(`SELECT driver_id::int AS pid FROM driver_platform_id WHERE external_id = $1`, [YANGO]))[0]?.pid;
const [made] = await qk(`SELECT id::int, full_name, created_by FROM driver WHERE id = $1`, [yRow ?? -1]);
check('the Yango account is on a new person, named as Yango files it',
  yRow && yRow !== 701 && made?.full_name === 'MUHAMMAD KHALID' && made?.created_by === 'operator',
  JSON.stringify({ yRow, made }));
check('…and nothing else left 701: hotel, Uber and Bolt, and the money',
  Object.values(await (async () => Object.fromEntries((await qk(
    `SELECT external_id, driver_id::int AS pid FROM driver_platform_id WHERE external_id <> $1`, [YANGO]))
    .map((r) => [r.external_id, r.pid])))()).every((p) => p === 701)
  && (await qk(`SELECT person_id::int p FROM driver_ledger`))[0]?.p === 701);
{
  const [a] = await qk(`SELECT outcome, person_id::int AS pid, payload, why FROM driver_ledger_audit
                         WHERE action = 'person_split'`);
  check('one audit row records it, on the row it left, with the operator\'s words',
    a?.outcome === 'accepted' && a.pid === 701 && a.payload?.from === 701 && a.payload?.to === yRow
    && a.payload?.via === 'sql/schema_v101.sql'
    && a.payload?.ruling?.words === 'unlink these two and put it back in queue'
    && /no money moved/.test(a.why || ''), JSON.stringify(a));
}
const kOnce = await kSnap();
await k.exec(V101);
check('replayed, v101 is a no-op', (await kSnap()) === kOnce);
await k.exec(V102);
check('…and v102, run after it, does not carry the Yango account back',
  yRow !== 701 && (await qk(`SELECT driver_id::int AS pid FROM driver_platform_id WHERE external_id = $1`, [YANGO]))[0]?.pid === yRow);
clearIdentityLinkCache(); clearPersonMapCache();
await refreshPersons(k);
check('…nor does the spine\'s next pass, with the link in the queue unanswered',
  yRow !== 701 && (await qk(`SELECT driver_id::int AS pid FROM driver_platform_id WHERE external_id = $1`, [YANGO]))[0]?.pid === yRow
  && (await qk(`SELECT driver_id::int AS pid FROM driver_platform_id WHERE external_id = $1`, [UBER_KHALID]))[0]?.pid === 701);

console.log('\nv101 refuses when money was recorded through the Yango account');
const r = new PGlite();
await applySchema(r);
const qr = (t, p = []) => r.query(t, p).then((x) => x.rows);
await qr(`INSERT INTO driver (id, full_name) VALUES (701, 'Muhammad Khalifa Afzal Khalid')`);
await qr(`INSERT INTO driver_platform_id (platform, external_id, driver_id, basis, linked_by)
          VALUES ('uber',$1,701,'account','spine'), ('yango',$2,701,'link','spine')`, [UBER_KHALID, YANGO]);
await qr(`INSERT INTO driver_ledger (person_id, person_name, resolved_from, acct_platform, acct_ext_id,
                                     type_code, direction, book, amount, effective_on, entered_by, note)
          VALUES (701,'MUHAMMAD KHALID','account','yango',$1,'cash_advance',1,'advance',150,'2026-10-01','ahsan','test')`,
[YANGO]);
await r.exec(V101);
await r.exec(V101);
check('nothing moves, and the refusal is recorded once, naming the entry',
  (await qr(`SELECT driver_id::int p FROM driver_platform_id WHERE external_id = $1`, [YANGO]))[0]?.p === 701
  && (await qr(`SELECT count(*)::int n FROM driver`))[0].n === 1
  && (await qr(`SELECT count(*)::int n FROM driver_ledger_audit WHERE action = 'person_split' AND outcome = 'refused'
                 AND jsonb_array_length(payload->'entries_through_it') = 1`))[0].n === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
