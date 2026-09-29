/* THE OPERATOR'S RULING ON ALI ABBAS AHMED — one man, one row, everywhere.
   ══════════════════════════════════════════════════════════════════════════
   2026-09-29, the operator, looking at the Drivers page: "both of them are the
   same people". Production's /api/drivers/directory for 2026-08-31..09-29 had
   him on two rows:

       "Ali Abbas Ahmed"       uber  9e9060e7…            42 trips, 3,516 ever
       "Ali Abbas Faiz Ahmed"  bolt  6623821 + b17bcd50…   5 trips,   535 ever

   both Egari, both on L25054. TWO mechanisms kept them apart, and a fix to one
   of them leaves the page exactly as it was, so this file holds down both:

   1. THE REGISTER. api/identity_map.js held the pair in PENDING over a
      single-trip contradiction on 2025-08-31, so person_key — the stored
      column every rollup groups by, generated into sql/schema_v53.sql — filed
      the Bolt trips under "ali abbas faiz ahmed". The ruling moves the pair to
      HAND_MERGES, as the Sana ruling did, keeping the contradiction date and
      naming the ruling made over it. §1 and §2.

   2. THE PERSON SPINE. The directory, the driver page, the money ledger and
      the texts group by driver + driver_platform_id (src/persons.js), and
      there the two records were two PERSON ROWS, 101 and 115. The spine joins
      them from the register on its next pass only while neither carries a
      ledger entry — money stops it, deliberately — so sql/schema_v93.sql makes
      the recorded merge api/person_merge_routes.js would have made. §3 builds
      the spine from nothing; §4 is production's shape, two person rows with
      money on both; §5 is the one case the migration must refuse.

   ── REVERT PROOFS, run 2026-09-29 against this file ──────────────────────
   Each was reverted on its own, this file run, the failures read, and the
   change restored:

     (a) api/identity_map.js + sql/schema_v53.sql back to the commit before
         the ruling (the pair in PENDING, the stored column built without
         it): 23 of 52 fail. §1 15 — the Bolt ids resolve to nobody, personOf
         says "ali abbas faiz ahmed", the pair is still held back, the
         held-back list reads five. §2 3 — both Bolt ids store "ali abbas faiz
         ahmed", and the replay over the previous column leaves them there.
         §3 4 — the spine makes three persons and the directory three rows,
         "Ali Abbas Ahmed" (3 trips) beside two "Ali Abbas Faiz Ahmed" rows.
         §4 1 — without the register the spine sees two components, so it
         never even reaches the money check.
     (b) the assertRegister ruling guard removed: 2 fail — an applied
         contradiction with no ruling, and a ruling over the wrong date, both
         load.
     (c) sql/schema_v93.sql emptied: 16 fail. §4 13 — person 115 survives
         with its accounts, entries, audit row and text, no merge row is
         written, the spine still reports needs_merge, and the directory
         shows production's two rows exactly: "Ali Abbas Ahmed" [9e9060e7…]
         and "Ali Abbas Faiz Ahmed" [6623821, b17bcd50…]. §5 3 — no refusal.
     (d) the opening-clash refusal removed from v93: 4 fail — both cash
         openings land on 101 and person 115 is deleted.
     (e) the NOT EXISTS guard on the refused audit row removed: 1 fails — the
         replay stacks a second refusal (2 rows).
     (f) `AND detached_at IS NULL` added to v93's driver_platform_id UPDATE:
         the migration throws — 'update or delete on table "driver" violates
         foreign key constraint "driver_platform_id_driver_id_fkey"' — and
         the file dies at §4's first exec.
     (g) the sms_outbox UPDATE removed from v93: 1 fails — the text already
         sent to 115 points at a person id that no longer exists.
     (h) the WHEN-count half of v53's guard neutralised (`/ 5 = 170` set to
         168, the previous register's count, so only the last-alias probe
         decides): 2 fail — and the one that matters is the replay, which
         SKIPS the rebuild and leaves both Bolt ids on "ali abbas faiz ahmed".
         That is production's path exactly: this ruling does not move the
         last alias id, so the count is the only thing that rebuilds it. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { MERGES, PENDING, PENDING_ALIAS_KEY, ALIAS_KEY, mergedIds, canonicalName,
  mergedPlatforms, personOf, identityCase } from '../api/identity_map.js';
import { refreshPersons } from '../src/persons.js';
import { refreshLifetime } from '../src/rollup.js';
import { driverRoutes } from '../api/driver_routes.js';
import { clearIdentityLinkCache } from '../api/identity_links.js';
import { clearPersonMapCache } from '../api/person_map.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const KEY = 'ali abbas ahmed';
const KEEP = '9e9060e7-0b8c-4f3b-8cd7-165d5eac55cd';
const BOLT = '6623821';
const BOLT2 = 'b17bcd50-e20b-4055-80d8-468131188397';
const THREE = [KEEP, BOLT, BOLT2].sort();
const SRC = readFileSync(new URL('../api/identity_map.js', import.meta.url), 'utf8');
const V93 = readFileSync(new URL('../sql/schema_v93.sql', import.meta.url), 'utf8');
const sorted = (a) => JSON.stringify([...a].sort());

/* ══ 1. the register ════════════════════════════════════════════════════ */
console.log('\nthe register: the pair is applied, on the ruling, with its evidence kept');

const entries = MERGES.filter((m) => m.key === KEY);
const entry = entries[0];
check('the pair is applied — exactly one MERGES entry on the key', entries.length === 1,
  String(entries.length));
check('both Bolt ids resolve to the Uber person\'s key',
  ALIAS_KEY.get(BOLT) === KEY && ALIAS_KEY.get(BOLT2) === KEY,
  `${ALIAS_KEY.get(BOLT)} / ${ALIAS_KEY.get(BOLT2)}`);
check('…and the Uber record keeps its own key — nothing moves but the alias',
  !ALIAS_KEY.has(KEEP) && personOf(KEEP, 'Ali Abbas Ahmed') === KEY);
check('personOf answers the survivor\'s key for a Bolt id filed under the long name',
  personOf(BOLT, 'Ali Abbas Faiz Ahmed') === KEY && personOf(BOLT2, 'Ali Abbas Faiz Ahmed') === KEY,
  `${personOf(BOLT, 'Ali Abbas Faiz Ahmed')}`);
check('asked from any of the three ids, the person is all three',
  [KEEP, BOLT, BOLT2].every((id) => sorted(mergedIds(id)) === JSON.stringify(THREE)),
  JSON.stringify(mergedIds(BOLT)));
check('…filed under the survivor\'s name, on both channels',
  canonicalName(BOLT) === 'Ali Abbas Ahmed' && sorted(mergedPlatforms(KEEP)) === '["bolt","uber"]',
  `${canonicalName(BOLT)} ${JSON.stringify(mergedPlatforms(KEEP))}`);
check('the SQL the stored column is generated from carries both Bolt ids',
  identityCase('x', 'y').includes(`WHEN '${BOLT}' THEN '${KEY}'`)
  && identityCase('x', 'y').includes(`WHEN '${BOLT2}' THEN '${KEY}'`));
check('the pair is no longer held back', !PENDING.some((m) => m.key === KEY)
  && !PENDING_ALIAS_KEY.has(BOLT) && !PENDING_ALIAS_KEY.has(BOLT2));

/* The ruling changes whether the pair is applied and NOTHING else: the
   sweep's figures are the reason it was proposed, and the contradiction is
   what the ruling was made over. Deleting either would leave a later reader
   nothing to check the ruling against. */
check('the contradiction date is kept, next to the ruling made over it',
  JSON.stringify(entry?.contradictions) === '["2025-08-31"]'
  && JSON.stringify(entry?.ruling?.over) === '["2025-08-31"]'
  && entry?.ruling?.on === '2026-09-29' && entry?.ruling?.by === 'operator'
  && entry?.ruling?.words === 'both of them are the same people',
  JSON.stringify({ c: entry?.contradictions, r: entry?.ruling }));
check('…and the evidence says both, in words',
  /RULED BY THE OPERATOR, 2026-09-29/.test(entry?.evidence || '')
  && /both of them are the same people/.test(entry?.evidence || '')
  && /2025-08-31/.test(entry?.evidence || '') && /2025-08-31/.test(entry?.caveat || ''));
check('the shared-history sweep\'s figures are carried unchanged',
  JSON.stringify(entry?.plates) === '["L36125","L58905","L85082"]'
  && JSON.stringify(entry?.days) === '{"shared":173,"interleaved":144,"alias":239,"keep":381}'
  && JSON.stringify(entry?.trips) === '{"alias":520,"onSharedCars":520}',
  JSON.stringify({ p: entry?.plates, d: entry?.days, t: entry?.trips }));
check('it entered the way the Sana ruling did — a hand merge dated the ruling day',
  entry?.verified === '2026-09-29' && !('basis' in (entry || {}))
  && MERGES.indexOf(entry) === MERGES.findIndex((m) => m.key === 'sanaullah sher zamin') + 1,
  `at ${MERGES.indexOf(entry)}`);

/* The other four held-back pairs are not the operator's ruling and must not
   move with it. Pinned by key AND date, so moving one of them — or quietly
   dropping a contradiction date — reads here as what it is. */
check('the other four held-back pairs are exactly as they were',
  JSON.stringify(PENDING.map((m) => [m.key, m.contradictions])) === JSON.stringify([
    ['soaieed alom ali', ['2025-05-03']],
    ['tariq afzal', ['2026-06-10']],
    ['fayed ali muhammad', ['2025-12-21', '2025-12-23']],
    ['hammad ahmad', ['2025-07-02']],
  ]), JSON.stringify(PENDING.map((m) => [m.key, m.contradictions])));

/* The filter that kept contradicted pairs out of MERGES applies to CANDIDATES
   only, and HAND_MERGES has none — so the guard at import is what now stops
   a contradicted pair being pasted in without a ruling. */
const loadsWith = async (from, to) => {
  const src = SRC.replace(from, to);
  if (src === SRC) return new Error(`the test's own edit did not apply: ${String(from).slice(0, 60)}`);
  try {
    await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
    return null;
  } catch (e) { return e; }
};
const RULING = /    ruling: \{ by: 'operator', on: '2026-09-29', words: 'both of them are the same people',\n      over: \['2025-08-31'\] \},\n/;
/* The control: a harmless edit of the same span loads. Without it, the two
   checks below could pass because ANY edit through this door breaks the
   import — a guard proved by a harness that cannot load anything. */
check('the module loads with a harmless edit of the same span — the control for the two below',
  (await loadsWith("over: ['2025-08-31'] }", "over: ['2025-08-31']  }")) === null);
{
  const e = await loadsWith(RULING, '');
  check('an applied contradiction with NO ruling does not load',
    e instanceof Error && /no ruling made over it/.test(e.message), String(e?.message).slice(0, 120));
}
{
  const e = await loadsWith("over: ['2025-08-31'] }", "over: ['2025-08-30'] }");
  check('…nor does a ruling made over a different date than the one the entry carries',
    e instanceof Error && /no ruling made over it/.test(e.message), String(e?.message).slice(0, 120));
}

/* ══ 2. the stored person_key ═══════════════════════════════════════════ */
console.log('\nthe stored column: every trip of his files under one key');

const a = new PGlite();
await applySchema(a);
const qa = (t, p = []) => a.query(t, p).then((r) => r.rows);
await qa(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
let tn = 0;
const trip = (q, platform, id, name, at, plate = 'L25054') => q(
  `INSERT INTO trip (platform, fleet_id, external_id, driver_ext_id, driver_name, plate,
                     requested_at, ended_at, status, distance_km)
   VALUES ($1,'egari',$2,$3,$4,$5,$6::timestamptz,$6::timestamptz + interval '20 min','completed',9)`,
  [platform, `t${++tn}`, id, name, plate, at]);
/* In the window (2026-09-19..26, as on production) and before it, so the
   "ever" column has something the window does not. */
const seedTrips = async (q) => {
  for (const d of ['2026-09-19', '2026-09-21', '2026-09-26']) {
    await trip(q, 'uber', KEEP, 'Ali Abbas Ahmed', `${d}T09:00:00+04`);
  }
  await trip(q, 'uber', KEEP, 'Ali Abbas Ahmed', '2026-06-02T09:00:00+04');
  await trip(q, 'bolt', BOLT, 'Ali Abbas Faiz Ahmed', '2026-09-19T13:00:00+04');
  await trip(q, 'bolt', BOLT, 'Ali Abbas Faiz Ahmed', '2026-09-26T13:00:00+04');
  await trip(q, 'bolt', BOLT2, 'Ali Abbas Faiz Ahmed', '2026-06-03T13:00:00+04');
  /* THE CONTROL: another account filed under the SAME long name. The register
     is a list of ids, never a name rule, so this one is not him. */
  await trip(q, 'bolt', '1234567', 'Ali Abbas Faiz Ahmed', '2026-09-20T13:00:00+04', 'L99999');
};
await seedTrips(qa);
const keys = Object.fromEntries((await qa(
  `SELECT driver_ext_id AS id, min(person_key) AS k FROM trip GROUP BY 1`)).map((r) => [r.id, r.k]));
check('both Bolt ids store the Uber person\'s key',
  keys[BOLT] === KEY && keys[BOLT2] === KEY, JSON.stringify(keys));
check('…and the Uber record stores its own', keys[KEEP] === KEY, String(keys[KEEP]));
check('a different account under the same long name is NOT folded — ids, not names',
  keys['1234567'] === 'ali abbas faiz ahmed', String(keys['1234567']));

/* PRODUCTION'S PATH, which a fresh database cannot see. Production's column
   was built from the previous register, and v53 skips a table whose column
   already "carries the register" — judged by two probes: the LAST alias id in
   MERGES, and the count of WHEN clauses. This ruling appends to HAND_MERGES,
   which is the MIDDLE of MERGES, so the last alias id is FROM_ROSTER's tail
   both before and after: the first probe matches either way, and only the
   count (168 → 170) makes production rebuild. So: build the column from the
   previous register — this file's v53 minus the pair's two WHEN clauses, its
   count put back — and replay the real v53 over it. */
{
  const V53 = readFileSync(new URL('../sql/schema_v53.sql', import.meta.url), 'utf8');
  const whenLine = (id) => `         WHEN '${id}' THEN '${KEY}'\n`;
  const count = Number((V53.match(/\/ 5 = (\d+)\);/) || [])[1]);
  const previous = V53.replace(whenLine(BOLT), '').replace(whenLine(BOLT2), '')
    .replace(`/ 5 = ${count});`, `/ 5 = ${count - 2});`);
  const stored = async () => Object.fromEntries((await qa(
    `SELECT driver_ext_id AS id, min(person_key) AS k FROM trip WHERE driver_ext_id = ANY($1::text[])
      GROUP BY 1`, [[BOLT, BOLT2]])).map((r) => [r.id, r.k]));
  check('the previous register\'s file is the real one minus exactly the pair',
    previous !== V53 && count === 170 && !previous.includes(`'${BOLT}'`) && !previous.includes(`'${BOLT2}'`),
    `count ${count}`);
  await a.exec(previous);
  const was = await stored();
  check('…and a column built from it files the Bolt trips apart, as production\'s did',
    was[BOLT] === 'ali abbas faiz ahmed' && was[BOLT2] === 'ali abbas faiz ahmed', JSON.stringify(was));
  await a.exec(V53);
  const now = await stored();
  check('replaying the regenerated v53 over that column rebuilds it — the WHEN count fires',
    now[BOLT] === KEY && now[BOLT2] === KEY, JSON.stringify(now));
}

/* ══ 3. the spine and the page, built from nothing ══════════════════════ */
console.log('\nthe spine from nothing: one person, one directory row');

const mount = (q) => {
  const app = express();
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
  driverRoutes(app, { q, wrap });
  const server = app.listen(0);
  const get = async (p) => (await fetch(`http://127.0.0.1:${server.address().port}${p}`)).json();
  return { get, close: () => server.close() };
};
const WINDOW = '/api/drivers/directory?from=2026-08-31&to=2026-09-29';
const hisRows = (rows) => rows.filter((r) => (r.ids || []).some((i) => THREE.includes(i)));

clearIdentityLinkCache(); clearPersonMapCache();
await refreshPersons(a);
await refreshLifetime(a);
clearPersonMapCache();
const onA = await qa(`SELECT external_id, driver_id FROM driver_platform_id WHERE detached_at IS NULL`);
const pidsA = new Set(onA.filter((r) => THREE.includes(r.external_id)).map((r) => Number(r.driver_id)));
check('the spine places all three accounts on ONE person', pidsA.size === 1
  && onA.filter((r) => THREE.includes(r.external_id)).length === 3, JSON.stringify(onA));
check('…and the same-named control on a different one',
  !pidsA.has(Number(onA.find((r) => r.external_id === '1234567')?.driver_id)));
{
  const [p] = await qa(`SELECT full_name FROM driver WHERE id = $1`, [[...pidsA][0]]);
  check('…named as the register names him', p?.full_name === 'Ali Abbas Ahmed', p?.full_name);
}
{
  const srv = mount(qa);
  const rows = hisRows(await srv.get(WINDOW));
  check('the Drivers page lists him ONCE', rows.length === 1,
    JSON.stringify(rows.map((r) => [r.driver_name, r.ids])));
  check('…with every account, the trips of both summed, and the lifetime of both',
    rows.length === 1 && sorted(rows[0].ids) === JSON.stringify(THREE)
    && rows[0].trips === 5 && rows[0].lifetime_trips === 7
    && sorted(rows[0].platforms) === '["bolt","uber"]',
    JSON.stringify(rows.map((r) => ({ ids: r.ids, trips: r.trips, ever: r.lifetime_trips, p: r.platforms }))));
  srv.close();
}

/* ══ 4. production's shape: two person rows, money on both ══════════════ */
console.log('\nproduction\'s shape: persons 101 and 115, money on both, joined by v93');

const b = new PGlite();
await applySchema(b);
const qb = (t, p = []) => b.query(t, p).then((r) => r.rows);
await qb(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
await seedTrips(qb);
await qb(`INSERT INTO driver (id, full_name) VALUES
            (101, 'Ali Abbas Ahmed'), (115, 'Ali Abbas Faiz Ahmed'), (200, 'Control Person')`);
await qb(`SELECT setval(pg_get_serial_sequence('driver','id'), 300)`);
await qb(`UPDATE driver SET cash_rule = 'net_against_pay' WHERE id = 115`);
await qb(`INSERT INTO driver_platform_id (platform, external_id, driver_id, display_name, basis, linked_by)
          VALUES ('uber', $1, 101, 'Ali Abbas Ahmed', 'account', 'spine'),
                 ('bolt', $2, 115, 'Ali Abbas Faiz Ahmed', 'account', 'spine'),
                 ('bolt', $3, 115, 'Ali Abbas Faiz Ahmed', 'link', 'spine'),
                 ('bolt', '1234567', 200, 'Ali Abbas Faiz Ahmed', 'account', 'spine')`,
[KEEP, BOLT, BOLT2]);
/* A DETACHED account on 115. It still carries a foreign key to the person, so
   a merge that moved only live rows could not delete 115 at all. */
await qb(`INSERT INTO driver_platform_id (platform, external_id, driver_id, basis, linked_by,
                                          detached_at, detached_reason)
          VALUES ('bolt', '7000001', 115, 'account', 'spine', now(), 'test: closed account')`);
const led = (pid, name, type, dir, book, amt, acct) => qb(
  `INSERT INTO driver_ledger (person_id, person_name, resolved_from, acct_platform, acct_ext_id,
                              type_code, direction, book, amount, effective_on, entered_by, note)
   VALUES ($1,$2,'account',$3,$4,$5,$6,$7,$8,'2026-09-22','ahsan','test') RETURNING id`,
  [pid, name, acct === KEEP ? 'uber' : 'bolt', acct, type, dir, book, amt]);
/* An advance and a cash deposit on the Uber person; on the Bolt person an
   opening cash position, an advance, a repayment and a deduction — every book
   the ledger has, so a merge that dropped one kind would show here. */
await led(101, 'Ali Abbas Ahmed', 'cash_advance', 1, 'advance', 1000, KEEP);
await led(101, 'Ali Abbas Ahmed', 'cash_deposit', -1, 'cash', -250, KEEP);
await led(115, 'Ali Abbas Faiz Ahmed', 'cash_opening', 1, 'cash', 300, BOLT);
await led(115, 'Ali Abbas Faiz Ahmed', 'salary_advance', 1, 'advance', 500, BOLT);
await led(115, 'Ali Abbas Faiz Ahmed', 'repayment', -1, 'advance', -100, BOLT);
await led(115, 'Ali Abbas Faiz Ahmed', 'traffic_fine', 1, 'deduction', 200, BOLT2);
await led(200, 'Control Person', 'cash_advance', 1, 'advance', 700, '1234567');
await qb(`INSERT INTO driver_ledger_audit (actor, action, outcome, why, person_id)
          VALUES ('ahsan','entry','accepted','test row on 101',101),
                 ('ahsan','entry','accepted','test row on 115',115)`);
await qb(`INSERT INTO sms_outbox (kind, dedupe_key, person_id, status)
          VALUES ('cash_deposit','cash:101:2026-09-22',101,'sent'),
                 ('cash_deposit','cash:115:2026-09-22',115,'sent')`);

const ledger = () => qb(`SELECT id::int, person_id::int AS pid, person_name, acct_ext_id, type_code,
                                book, amount::float8 AS amount
                           FROM driver_ledger ORDER BY id`);
const before = await ledger();
const byBook = (rows, pids) => rows.filter((r) => pids.includes(r.pid)).reduce(
  (o, r) => ({ ...o, [r.book]: +((o[r.book] || 0) + r.amount).toFixed(2) }), {});
const from115 = before.filter((r) => r.pid === 115).map((r) => r.id);

/* The measurement that makes v93 necessary: with money on both, the spine —
   given the new register — sees ONE component on TWO persons and stops. */
clearIdentityLinkCache(); clearPersonMapCache();
const t0 = await refreshPersons(b);
const both = await qb(`SELECT id::int FROM driver WHERE id IN (101, 115) ORDER BY id`);
check('the register alone does NOT join two person rows that carry money — the spine stops',
  t0.needs_merge >= 1 && both.length === 2, JSON.stringify({ needs_merge: t0.needs_merge, both }));

const snapshot = async () => JSON.stringify({
  driver: await qb(`SELECT id::int, full_name, cash_rule FROM driver ORDER BY id`),
  accts: await qb(`SELECT platform, external_id, driver_id::int, detached_at IS NOT NULL AS det
                     FROM driver_platform_id ORDER BY platform, external_id`),
  ledger: await ledger(),
  audit: await qb(`SELECT id::int, person_id::int, action, outcome FROM driver_ledger_audit ORDER BY id`),
  sms: await qb(`SELECT id::int, person_id::int FROM sms_outbox ORDER BY id`),
});

await b.exec(V93);
const after = await ledger();
check('person 115 is gone and 101 survives', (await qb(
  `SELECT id::int FROM driver WHERE id IN (101, 115)`)).map((r) => r.id).join() === '101');
{
  const acc = await qb(`SELECT external_id, driver_id::int AS pid, detached_at IS NOT NULL AS det
                          FROM driver_platform_id WHERE external_id = ANY($1::text[]) ORDER BY 1`,
  [[...THREE, '7000001']]);
  check('every account of his — the detached one too — is on 101',
    acc.length === 4 && acc.every((r) => r.pid === 101), JSON.stringify(acc));
  check('…and the detached one is still detached', acc.find((r) => r.external_id === '7000001')?.det === true);
}
check('no ledger entry is lost or added — the same ids, the same count',
  JSON.stringify(after.map((r) => r.id)) === JSON.stringify(before.map((r) => r.id)),
  `${before.length} → ${after.length}`);
check('every entry that was on 115 is on 101 now',
  from115.length === 4 && from115.every((id) => after.find((r) => r.id === id)?.pid === 101),
  JSON.stringify(after.filter((r) => from115.includes(r.id))));
check('the survivor\'s books are the two persons\' books added, book by book — nothing doubled',
  JSON.stringify(byBook(after, [101])) === JSON.stringify(byBook(before, [101, 115]))
  && JSON.stringify(byBook(after, [101])) === '{"advance":1400,"cash":50,"deduction":200}',
  `${JSON.stringify(byBook(before, [101, 115]))} → ${JSON.stringify(byBook(after, [101]))}`);
check('the evidence on each entry does not move: amount, account and the name on screen',
  after.every((r) => {
    const w = before.find((x) => x.id === r.id);
    return w && w.amount === r.amount && w.acct_ext_id === r.acct_ext_id
      && w.person_name === r.person_name && w.type_code === r.type_code;
  }));
check('somebody else\'s money is untouched',
  JSON.stringify(after.filter((r) => r.pid === 200)) === JSON.stringify(before.filter((r) => r.pid === 200)));
{
  const au = await qb(`SELECT person_id::int AS pid, why FROM driver_ledger_audit WHERE action = 'entry'`);
  check('the audit rows follow the person', au.every((r) => r.pid === 101), JSON.stringify(au));
  const sms = await qb(`SELECT person_id::int AS pid FROM sms_outbox ORDER BY id`);
  check('…and so do the texts already sent — nothing points at a deleted person',
    sms.every((r) => r.pid === 101), JSON.stringify(sms));
  const [rule] = await qb(`SELECT cash_rule FROM driver WHERE id = 101`);
  check('the cash rule 115 carried is carried, since 101 had none', rule?.cash_rule === 'net_against_pay',
    String(rule?.cash_rule));
}
const merges = await qb(`SELECT actor, why, person_id::int AS pid, payload FROM driver_ledger_audit
                          WHERE action = 'person_merge' ORDER BY id`);
{
  const m = merges[0];
  const p = m?.payload || {};
  check('ONE audit row records the merge, against the survivor, naming the ruling',
    merges.length === 1 && m.pid === 101 && p.keep === 101 && p.drop === 115
    && p.via === 'sql/schema_v93.sql' && p.ruling?.words === 'both of them are the same people'
    && JSON.stringify(p.ruling?.over) === '["2025-08-31"]',
    JSON.stringify(merges));
  check('…naming every entry that moved, with its amount, so it can be undone by reading it',
    sorted((p.entries_moved || []).map((e) => e.id)) === sorted(from115)
    && p.moved_amount === 900
    && (p.entries_moved || []).every((e) => e.amount != null && e.book && e.type && e.on),
    JSON.stringify(p.entries_moved));
  check('…and every account, audit row and text that moved',
    (p.accounts_moved || []).length === 3
    && sorted((p.accounts_moved || []).map((x) => x.ext_id)) === sorted([BOLT, BOLT2, '7000001'])
    && (p.audit_rows_moved || []).length === 1 && (p.sms_rows_moved || []).length === 1,
    JSON.stringify({ a: p.accounts_moved, au: p.audit_rows_moved, s: p.sms_rows_moved }));
  check('…in a sentence a person can read',
    /Ali Abbas Faiz Ahmed folded into Ali Abbas Ahmed/.test(m?.why || '')
    && /Moved 3 account\(s\) and 4 ledger entries worth 900/.test(m?.why || ''), m?.why);
}

/* A replay moves nothing and writes nothing — the ledger skips a sha it has
   seen, but a file that is only safe because it is skipped is one restore
   away from doubling a balance. */
const once = await snapshot();
await b.exec(V93);
check('replayed, v93 is a no-op — no row anywhere changes, no second audit row',
  (await snapshot()) === once);

/* And the spine, run with the new register over the merged table, agrees. */
clearIdentityLinkCache(); clearPersonMapCache();
const t1 = await refreshPersons(b);
await refreshLifetime(b);
clearPersonMapCache();
check('the spine\'s next pass finds nothing left to merge and mints nobody',
  t1.needs_merge === 0 && t1.minted === 0
  && (await qb(`SELECT count(*)::int n FROM driver WHERE id IN (101, 115)`))[0].n === 1,
  JSON.stringify(t1));
{
  const srv = mount(qb);
  const rows = hisRows(await srv.get(WINDOW));
  check('the Drivers page lists him ONCE — 101, both channels, trips of both',
    rows.length === 1 && sorted(rows[0].ids) === JSON.stringify(THREE) && rows[0].trips === 5
    && rows[0].lifetime_trips === 7,
    JSON.stringify(rows.map((r) => ({ n: r.driver_name, ids: r.ids, trips: r.trips, ever: r.lifetime_trips }))));
  srv.close();
}

/* ══ 5. the one case it must refuse ═════════════════════════════════════ */
console.log('\nan opening on both person rows: refused, recorded, left for a person');

/* /api/ledger/exposure reads the LATEST cash_opening per person and the
   driver register SUMS them, so two openings on one person are one lost or
   one doubled depending on the page. A migration cannot know which opening is
   right, so it must not pick. */
const c = new PGlite();
await applySchema(c);
const qc = (t, p = []) => c.query(t, p).then((r) => r.rows);
await qc(`INSERT INTO driver (id, full_name) VALUES (101, 'Ali Abbas Ahmed'), (115, 'Ali Abbas Faiz Ahmed')`);
await qc(`INSERT INTO driver_platform_id (platform, external_id, driver_id, basis, linked_by)
          VALUES ('uber', $1, 101, 'account', 'spine'), ('bolt', $2, 115, 'account', 'spine'),
                 ('bolt', $3, 115, 'link', 'spine')`, [KEEP, BOLT, BOLT2]);
for (const [pid, amt] of [[101, 400], [115, 300]]) {
  await qc(`INSERT INTO driver_ledger (person_id, person_name, resolved_from, type_code, direction, book,
                                       amount, effective_on, entered_by, note)
            VALUES ($1,'x','account','cash_opening',1,'cash',$2,'2026-09-22','ahsan','test')`, [pid, amt]);
}
await c.exec(V93);
{
  const ppl = await qc(`SELECT id::int FROM driver ORDER BY id`);
  const led2 = await qc(`SELECT person_id::int AS pid FROM driver_ledger ORDER BY id`);
  const acc = await qc(`SELECT external_id, driver_id::int AS pid FROM driver_platform_id ORDER BY 1`);
  check('both person rows remain', ppl.map((r) => r.id).join() === '101,115', JSON.stringify(ppl));
  check('…each opening stays where it was recorded', led2.map((r) => r.pid).join() === '101,115',
    JSON.stringify(led2));
  check('…and no account moved', acc.filter((r) => r.pid === 115).length === 2, JSON.stringify(acc));
  const ref = await qc(`SELECT why, payload FROM driver_ledger_audit
                         WHERE action = 'person_merge' AND outcome = 'refused'`);
  check('a REFUSED audit row says why, naming both openings',
    ref.length === 1 && (ref[0].payload?.openings_on_both || []).length === 2
    && /both carry an opening of the same kind/.test(ref[0].why)
    && /POST \/api\/person\/merge/.test(ref[0].why), JSON.stringify(ref));
  await c.exec(V93);
  const again = await qc(`SELECT count(*)::int n FROM driver_ledger_audit WHERE action = 'person_merge'`);
  check('…once — a replay does not stack a second refusal', again[0].n === 1, String(again[0].n));
}
/* An opening on ONE side only is not a clash: nothing is doubled by moving
   it, and §4 already folds exactly that (115 carried the only cash_opening). */
check('an opening on one side only did not block §4 (the control for §5)',
  after.filter((r) => r.type_code === 'cash_opening').length === 1 && merges.length === 1);

console.log(`\n${fail ? '✗' : '✓'} identity_ruling_ali_abbas: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
