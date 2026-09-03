/* ── three people the roster held twice, and the twelve records around them ──
   ──────────────────────────────────────────────────────────────────────────
   The operator asked whether the driver record holds duplicates. It holds
   three that were checked one at a time against production, and a great many
   near-misses that are two different men. This file is the guard on both
   halves, because a merge mechanism is only as good as the merges it REFUSES.

   Everything asserted here is measured. The 395 names the shipped rule is run
   over are the real ones — test/fixtures/roster_395.json is
   /api/drivers/directory?days=3660 on 2026-09-03, verbatim, with the
   person_key production folded each row on. The trip counts, distances,
   payouts and money below are the figures those same rows carry, so the
   before/after arithmetic is the fleet's own and not a model of it.

   Four things are held down:

     1. The register is a LIST, not a rule. Run over all 395 real names it
        joins exactly three pairs and no fourth. If it ever joins a fourth, the
        rule generalised and this test says which pair it reached.
     2. The pairs proven to be two people stay two people — including the two
        the product already pins elsewhere (test/roster_twin.test.mjs holds
        "Muhammad Khalid Gul" apart from "Muhammad Khalid" at the UI rule; this
        holds them apart at the key).
     3. The merge COMBINES work rather than hiding it. The surviving row
        carries both records' trips, distance, payout and money, and the union
        of their working days — never one account's figure standing in for the
        person's.
     4. The SQL and the JS cannot drift. sql/schema_v53.sql is generated from
        api/identity_map.js; the value the database stores is compared against
        the value the JS computes, row by row, over the whole real roster. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';
import { MERGES, REFUSED, ALIAS_KEY, foldName, mergedIds, canonicalName }
  from '../api/identity_map.js';
import { personKey, personKeyStored, personFold, custodyNames, custodyRefs,
  custodyCountOverWindow, custodyOverWindow } from '../api/custody_sql.js';
import { render } from '../bin/gen-schema-v53.mjs';
import { SCHEMA_FILES } from '../src/schema_files.js';
import { driverRoutes } from '../api/driver_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const FX = JSON.parse(readFileSync(new URL('./fixtures/roster_395.json', import.meta.url), 'utf8'));

/* ══ 1. the register, before any database is involved ══════════════════ */
console.log('\nthe register is a list somebody wrote down, with its reasons');

check('it holds exactly the three pairs a human verified', MERGES.length === 3,
  MERGES.map((m) => m.key).join(', '));
check('every entry names the record that survives and the record folded into it',
  MERGES.every((m) => m.keep.id && m.merge.id && m.keep.id !== m.merge.id));
check('every entry carries the channel of both records, so the shape is legible',
  MERGES.every((m) => m.keep.channel && m.merge.channel));
check('every entry carries the measurement that decided it',
  MERGES.every((m) => m.evidence.length > 300 && m.verified === '2026-09-03'));
check('and the caveat — what could not be established',
  MERGES.every((m) => m.caveat && m.caveat.length > 40));
/* The key must be a name that already exists, not one the register invented:
   the surviving record's key does not move, so nothing else in the database
   has to move with it. */
check('the canonical key is the surviving record\'s own folded name, unchanged',
  MERGES.every((m) => m.key === foldName(m.keep.name)),
  MERGES.map((m) => `${m.key} vs ${foldName(m.keep.name)}`).join('; '));
check('…and is what production already stores for that record',
  MERGES.every((m) => FX.rows.find((r) => r.id === m.keep.id)?.person_key === m.key
    || FX.rows.find((r) => r.id === m.keep.id)?.person_key == null),
  'a key that disagreed with production would move a record nobody asked to move');
check('both sides of every pair are real ids on the production roster',
  MERGES.every((m) => FX.rows.some((r) => r.id === m.keep.id)
                   && FX.rows.some((r) => r.id === m.merge.id)));

check('the refusals are recorded too, with why', REFUSED.length === 3
  && REFUSED.every((r) => r.why.length > 60));
const refusedIds = new Set(REFUSED.flatMap((r) => [r.a.id, r.b.id]));
check('and no id is in both lists', [...ALIAS_KEY.keys()].every((id) => !refusedIds.has(id)));

check('asked about either half of a pair, it answers both ids',
  MERGES.every((m) => mergedIds(m.keep.id).join() === mergedIds(m.merge.id).join()
    && mergedIds(m.merge.id).length === 2));
check('asked about anybody else, it answers only them',
  mergedIds('76ede4ae-768b-4126-804b-0b5c88043682').length === 1
  && canonicalName('76ede4ae-768b-4126-804b-0b5c88043682') === null,
  'a register that answers for an id it was not told about is a rule in disguise');

/* ══ 2. the schema file cannot drift from the register ════════════════ */
console.log('\nthe stored column is generated from that same list');

check('sql/schema_v53.sql is byte-for-byte what bin/gen-schema-v53.mjs emits',
  readFileSync(new URL('../sql/schema_v53.sql', import.meta.url), 'utf8') === render(),
  'run: node bin/gen-schema-v53.mjs');
/* "Last" was how this read when v53 was the newest file, and that made the
   assertion about the length of a list rather than about the dependency. What
   it actually needs is that v53 runs AFTER every file that creates a
   person_key column — it replaces that column, and replacing a column that
   does not exist yet silently does nothing. A later migration is free to
   exist; it just may not come between them. */
const at = (f) => SCHEMA_FILES.indexOf(f);
const body = (f) => readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8')
  .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
/* Found, not listed. A hardcoded ['schema_v20.sql', …] is right until the day
   a new file adds person_key to a seventh table and this assertion goes on
   passing without having looked at it. */
const DEFINES_KEY = SCHEMA_FILES.filter((f) => f !== 'schema_v53.sql'
  && /person_key\s+text\s+GENERATED ALWAYS AS/i.test(body(f).replace(/\s+/g, ' ')));
check('there is more than one file defining the column, so this found them',
  DEFINES_KEY.length >= 3, DEFINES_KEY.join(' '));
check('the register migration runs after every file that defines the column',
  DEFINES_KEY.every((f) => at(f) < at('schema_v53.sql')),
  DEFINES_KEY.map((f) => `${f}@${at(f)}`).join(' ') + ` v53@${at('schema_v53.sql')}`);
/* And nothing may rebuild person_key after it, or the register's CASE is
   dropped again by a later ADD COLUMN and the merge silently comes undone. */
const REBUILDS = /ADD COLUMN person_key|GENERATED ALWAYS AS[\s\S]{0,200}?STORED/;
const after53 = SCHEMA_FILES.slice(at('schema_v53.sql') + 1);
check('and no migration after it rebuilds the column',
  after53.every((f) => !REBUILDS.test(body(f))),
  `checked ${after53.length}: ${after53.join(', ') || 'none'}`);
/* The name fold itself is untouched. If personFold ever learns about ids, the
   rule has widened and every name in the fleet is exposed to it. */
check('personFold is still the NAME rule and knows nothing about any id',
  !/[0-9a-f]{8}-[0-9a-f]{4}/.test(personFold('driver_name'))
  && !personFold('driver_name').includes('CASE'),
  personFold('driver_name'));
check('the register reaches the key through personKey, which has the id',
  MERGES.every((m) => personKey().includes(`'${m.merge.id}'`)));

await applySchema(db);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

/* ══ 3. the rule, run over all 395 real names ═════════════════════════ */
console.log('\nthe rule over the whole real roster: every pair it newly joins');

/* Every name in the directory, given to the database exactly as production
   holds it, so the generated column answers on the real distribution. Where
   production reports a person_key that is what the trip rows fold to (a Yango
   record whose trip name is a different word order from its display name is
   the reason the two can differ); where it reports none, the display name is
   all there is. */
let n = 0;
for (const r of FX.rows) {
  await q(`INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, requested_at, status)
           VALUES ('uber', $1, 'ecosine', $2, $3, now(), 'completed')`,
    [`fx${n++}`, r.id, r.person_key || r.name]);
}
const stored = await q(`SELECT driver_ext_id AS id, driver_name AS nm, person_key FROM trip WHERE external_id LIKE 'fx%'`);
check('all 395 production records are loaded', stored.length === 395, String(stored.length));

/* The fold BEFORE the change is the fold with the register taken out: the
   plain name rule, which is exactly what personFold still is. */
const before = new Map(), after = new Map();
for (const r of stored) {
  const b = foldName(r.nm) || r.id;
  const a = r.person_key || r.id;
  (before.get(b) || before.set(b, []).get(b)).push(r);
  (after.get(a) || after.set(a, []).get(a)).push(r);
}
const newlyJoined = [];
for (const [k, group] of after) {
  if (group.length < 2) continue;
  if (new Set(group.map((r) => foldName(r.nm) || r.id)).size < 2) continue;  // already one before
  newlyJoined.push({ key: k, ids: group.map((r) => r.id).sort() });
}
newlyJoined.sort((a, b) => a.key.localeCompare(b.key));
console.log('   ' + (newlyJoined.length ? newlyJoined.map((p) =>
  `${JSON.stringify(p.key)} <= ${p.ids.join('  +  ')}`).join('\n   ') : '(none)'));

const wantJoined = MERGES.map((m) => ({ key: m.key, ids: [m.keep.id, m.merge.id].sort() }))
  .sort((a, b) => a.key.localeCompare(b.key));
check('over all 395 real names it joins EXACTLY the three verified pairs, and no fourth',
  JSON.stringify(newlyJoined) === JSON.stringify(wantJoined),
  `got ${JSON.stringify(newlyJoined)}`);
check('the number of distinct people it reports falls by exactly three',
  before.size - after.size === 3, `${before.size} → ${after.size}`);

console.log('\nand what it must never join');
for (const r of REFUSED) {
  const a = stored.find((x) => x.id === r.a.id), b = stored.find((x) => x.id === r.b.id);
  check(`"${r.a.name}" and "${r.b.name}" are still two people`,
    !!a && !!b && a.person_key !== b.person_key,
    `${a?.person_key} vs ${b?.person_key}`);
}
/* The widening that was considered and rejected. Sorting the folded words
   catches two of the three pairs and, on TODAY'S roster only, nothing else —
   but it is a rule about names, so it would fire on a name nobody has looked
   at. It must not be what shipped. */
const sortedWords = (s) => foldName(s).split(' ').sort().join(' ');
check('the fold does NOT sort words — the rejected widening is not in the product',
  stored.some((r) => r.person_key !== sortedWords(r.nm)),
  'person_key is word-order-insensitive, which merges names nobody has checked');
check('…and that widening would still have missed the third pair, so it was never enough',
  sortedWords('Shehzad Ahmad Ghulam Muhammad') !== sortedWords('Shehzad Ahmed Ghulam Muhammad'));

/* ══ 4. the stored column and the JS agree, row by row ════════════════ */
console.log('\nthe four definitions of a person still answer the same thing');

const [{ differ }] = await q(
  `SELECT count(*)::int AS differ FROM trip t
    WHERE ${personKeyStored('t')} IS DISTINCT FROM ${personKey('t.driver_ext_id', 't.driver_name')}`);
check('the stored key equals the computed key on every one of the 395 rows',
  differ === 0, `${differ} row(s) differ`);
const jsDiff = stored.filter((r) => r.person_key !== (ALIAS_KEY.get(r.id) || foldName(r.nm)));
check('…and both equal what api/identity_map.js computes in Node',
  jsDiff.length === 0, jsDiff.slice(0, 3).map((r) => `${r.id}: ${r.person_key}`).join('; '));

/* Every table that carries the column has to carry the same answer, or a
   person's money and a person's work end up under two different keys. */
const TABLES = [
  ['driver_platform_state', 'full_name'],
  ['vehicle_driver_day', 'driver_name'],
  ['money_event', 'driver_name'],
  ['driver_statement_day', 'driver_name'],
  ['driver_payout_day', 'driver_name'],
];
const M = MERGES[0];
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state)
         VALUES ('yango',$1,'ecosine',$2,'active'),('uber',$3,'ecosine',$4,'active')`,
  [M.merge.id, M.merge.name, M.keep.id, M.keep.name]);
await q(`INSERT INTO vehicle_driver_day (plate, day, platform, driver_ext_id, driver_name, fleet_id, trips)
         VALUES ('L36397', date '2026-08-20','yango',$1,$2,'ecosine',2),
                ('L36397', date '2026-08-21','uber', $3,$4,'ecosine',9)`,
  [M.merge.id, M.merge.name, M.keep.id, M.keep.name]);
await q(`INSERT INTO money_event (source, platform, fleet_id, kind, driver_ext_id, driver_name,
           period_start, period_end, amount)
         VALUES ('yango','yango','ecosine','payout',$1,$2, date '2026-08-20', date '2026-08-20', 50),
                ('uber','uber','ecosine','payout',$3,$4, date '2026-08-21', date '2026-08-21', 90)`,
  [M.merge.id, M.merge.name, M.keep.id, M.keep.name]);
await q(`INSERT INTO driver_statement_day (platform, fleet_id, driver_ext_id, driver_name, day,
           net, tips, salik, cash, source, pseudo)
         VALUES ('yango','ecosine',$1,$2, date '2026-08-20', 50,0,0,0,'x',false),
                ('uber','ecosine',$3,$4, date '2026-08-21', 90,0,0,0,'x',false)`,
  [M.merge.id, M.merge.name, M.keep.id, M.keep.name]);
await q(`INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
           period_start, period_end, earnings, cash_earnings)
         VALUES ('yango','ecosine',$1,$2, date '2026-08-20', date '2026-08-20', date '2026-08-20', 50, 0),
                ('uber','ecosine',$3,$4, date '2026-08-21', date '2026-08-21', date '2026-08-21', 90, 0)`,
  [M.merge.id, M.merge.name, M.keep.id, M.keep.name]);

for (const [table, nameCol] of TABLES) {
  const rows = await q(`SELECT driver_ext_id AS id, ${nameCol} AS nm, person_key FROM ${table}
                        WHERE driver_ext_id IN ($1,$2)`, [M.keep.id, M.merge.id]);
  check(`${table} folds both records of a merged pair onto one key`,
    rows.length === 2 && rows[0].person_key === M.key && rows[1].person_key === M.key,
    JSON.stringify(rows));
}
/* And the fold itself is untouched for everybody else, on every table. */
const [{ bad }] = await q(
  `SELECT count(*)::int AS bad FROM trip t
    WHERE t.driver_ext_id NOT IN (${MERGES.map((_, i) => `$${i + 1}`).join(',')})
      AND t.person_key IS DISTINCT FROM ${personFold('t.driver_name')}`,
  MERGES.map((m) => m.merge.id));
check('every record NOT in the register still keys on its name and nothing else',
  bad === 0, `${bad} row(s) changed that nobody asked to change`);


/* ══ 4b. the migration on a database that already holds the old keys ══
   ─────────────────────────────────────────────────────────────────────────
   Postgres 16 cannot change a generated column's expression, so v53 drops the
   column and re-adds it. A migration proven only against an empty database is
   not proven: production has a quarter of a million trip rows already carrying
   the OLD key, and every one of them has to come out the other side either
   re-keyed (the three) or untouched (the rest), with the indexes back. */
console.log('\nthe migration, run against rows that already carry the old key');
{
  const old = new PGlite();
  const qo = (t, p = []) => old.query(t, p).then((r) => r.rows);
  const FILES = SCHEMA_FILES.filter((f) => f !== 'schema_v53.sql');
  for (const f of FILES) await old.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8'));
  await qo(`INSERT INTO fleet (id,name) VALUES ('ecosine','E') ON CONFLICT DO NOTHING`);
  const P = MERGES[0];
  await qo(`INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, requested_at, status)
            VALUES ('uber','o1','ecosine',$1,$2, now(),'completed'),
                   ('yango','o2','ecosine',$3,$4, now(),'completed'),
                   ('uber','o3','ecosine','76ede4ae-768b-4126-804b-0b5c88043682','Muhammad Khalid', now(),'completed')`,
    [P.keep.id, P.keep.name, P.merge.id, P.merge.name]);
  const pre = Object.fromEntries((await qo(`SELECT external_id, person_key FROM trip`))
    .map((r) => [r.external_id, r.person_key]));
  check('before the migration the duplicate keys as its own spelling',
    pre.o1 === 'aliyan khalil' && pre.o2 === 'khalil aliyan', JSON.stringify(pre));

  await old.exec(readFileSync(new URL('../sql/schema_v53.sql', import.meta.url), 'utf8'));
  const post = Object.fromEntries((await qo(`SELECT external_id, person_key FROM trip`))
    .map((r) => [r.external_id, r.person_key]));
  check('after it, the existing rows are re-keyed in place — no backfill, no job',
    post.o1 === 'aliyan khalil' && post.o2 === 'aliyan khalil', JSON.stringify(post));
  check('…and a row nobody asked to move did not move',
    post.o3 === pre.o3 && post.o3 === 'muhammad khalid', String(post.o3));
  check('…and no trip was lost to the column rebuild',
    (await qo(`SELECT count(*)::int c FROM trip`))[0].c === 3);
  const idx = (await qo(`SELECT indexname FROM pg_indexes WHERE tablename='trip'`)).map((r) => r.indexname);
  check('the indexes the DROP took with it are back, including the covering one',
    idx.includes('trip_person_key_idx') && idx.includes('trip_econ_day_idx'), idx.join(', '));
  /* And it must be safe to run twice — the boot ledger skips a file whose
     hash it has seen, but the file itself is what correctness rests on. */
  await old.exec(readFileSync(new URL('../sql/schema_v53.sql', import.meta.url), 'utf8'));
  const again = (await qo(`SELECT external_id, person_key FROM trip ORDER BY external_id`));
  check('running it a second time changes nothing and rewrites nothing',
    again.map((r) => r.person_key).join('|') === 'aliyan khalil|aliyan khalil|muhammad khalid',
    JSON.stringify(again));
  await old.close();
}

/* ══ 5. the merge combines the work rather than hiding it ═════════════
   ─────────────────────────────────────────────────────────────────────────
   A merge that made one record disappear would be worse than the duplicate:
   the fleet would lose 28 trips, 410 km and AED 9,632 and nothing on any page
   would say so. So the twelve records this question is about are rebuilt at
   the size production reports them — every trip count, distance, payout and
   money figure below is read off /api/drivers/directory?days=3660 on
   2026-09-03 — and the directory is asked what it makes of them.

   The day layouts are the measured ones too: all ten of the Yango record's
   days are days the Uber record also drove ("on all 10 shared days the plate
   set is identical"), and the hotel record's eight days are the seven the Uber
   record was on the car plus the one it was not (2026-08-12). That is why
   `days` must be a UNION and not a sum or a max, and this is where it shows. */
console.log('\nthe twelve records, at the size production reports them');

const db2 = new PGlite();
const q2 = (t, p = []) => db2.query(t, p).then((r) => r.rows);
await applySchema(db2);
await q2(`INSERT INTO fleet (id,name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

const span = (n, from = 0) => Array.from({ length: n }, (_, i) => from + i);

/* Read from production 2026-09-03. `dayOffsets` are days from 2025-04-05. */
const REC = [
  { id: '5f16534e-68be-451b-b057-3e3d948e868b', name: 'Aliyan khalil', pf: 'uber', plate: 'L36397',
    trips: 3950, completed: 3550, km: 55497, days: span(429),
    payout: 37417, payoutDays: 210, money: 37521, moneyDays: 207, mpd: 7, src: 'statement' },
  { id: '7fc8da91fc4a44c185e8d6d918db3e6b', name: 'Khalil Aliyan', pf: 'yango', plate: 'L36397',
    trips: 20, completed: 17, km: 274, days: span(10), revenue: 1099,
    payout: 8533, payoutDays: 116, money: 1099, moneyDays: 10, mpd: 1, src: 'fares' },

  { id: '9d396a20-454b-4a7e-91ae-9de8f9aa8942', name: 'Moses Arthur', pf: 'uber', plate: 'L10595',
    trips: 539, completed: 480, km: 6703, days: span(64),
    payout: 687, payoutDays: 203, money: 158, moneyDays: 203, mpd: 7, src: 'statement' },
  /* Bolt files no trips at all — fleet-wide, not just here — so this record is
     a platform standing and nothing else. Its zero is a property of the feed. */
  { id: 'ab2aec60-56ff-48e2-85c0-3591f6f29aa3', name: 'Arthur Moses', pf: 'bolt', plate: 'L10595',
    trips: 0, standing: { state: 'deactivated', can_earn: false } },

  { id: 'f6253b6e-fca4-41cf-99c1-6c2f3e2e67b2', name: 'Shehzad Ahmad Ghulam Muhammad', pf: 'uber',
    plate: 'L46208', trips: 1782, completed: 1441, km: 17120, days: span(306),
    payout: 7382, payoutDays: 210, money: 8246, moneyDays: 207, mpd: 7, src: 'statement' },
  { id: '67483c64055e070d7910010a', name: 'Shehzad Ahmed Ghulam Muhammad', pf: 'hotel',
    plate: 'L46208', trips: 8, completed: 8, km: 136, days: [...span(7), 400], revenue: 635,
    money: 635, moneyDays: 8, mpd: 1, src: 'fares', compliance: true },

  /* The three pairs that came back as two people, at their real size, so the
     row count below is a count of this fleet and not of a sample. */
  { id: 'd9b2de76-b535-4b23-a714-7e31724e50d2', name: 'Muhammad Naeem Khan', pf: 'uber',
    plate: 'L46201', trips: 1228, completed: 1111, km: 16634, days: span(110) },
  { id: 'd31e25fa-dc28-424c-a6e5-c2cbcf516870', name: 'Mohammad Naeem Khan', pf: 'uber',
    plate: 'L46172', trips: 960, completed: 874, km: 9663, days: span(192) },
  { id: '4d4eb2c1-f64c-48c2-8167-32d887cecfd2', name: 'Muhammad Khalid Gul', pf: 'uber',
    plate: 'L94178', trips: 1737, completed: 1555, km: 21718, days: span(233) },
  { id: '76ede4ae-768b-4126-804b-0b5c88043682', name: 'Muhammad Khalid', pf: 'uber',
    plate: 'L44284', trips: 4407, completed: 3741, km: 49683, days: span(298) },
  { id: 'b7511fa7-cbdf-4373-8539-c7ae020c31e2', name: 'Sanaullah Sher Zamin', pf: 'uber',
    plate: 'L75125', trips: 2348, completed: 2044, km: 26061, days: span(268) },
  { id: '67483c64055e070d79100114', name: 'Sana Ullah Sher Zamin', pf: 'hotel',
    trips: 0, compliance: true },
];

for (const r of REC) {
  if (r.trips) {
    /* Distance and fare are split as integers with the remainder spread over
       the first rows, so the column sums to the production figure exactly
       rather than to within rounding of it. */
    await q2(
      `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate,
                         requested_at, ended_at, status, distance_km, price)
       SELECT $1, $2 || g, 'ecosine', $3, $4, $5,
              ((DATE '2025-04-05' + ($6::int[])[((g-1) % array_length($6::int[],1)) + 1])::timestamp
                 + interval '8 hour') AT TIME ZONE 'Asia/Dubai',
              ((DATE '2025-04-05' + ($6::int[])[((g-1) % array_length($6::int[],1)) + 1])::timestamp
                 + interval '8 hour 20 min') AT TIME ZONE 'Asia/Dubai',
              CASE WHEN g <= $7 THEN 'completed' ELSE 'canceled' END,
              ($8::int / $9::int) + CASE WHEN g <= ($8::int % $9::int) THEN 1 ELSE 0 END,
              CASE WHEN $10::int IS NULL THEN NULL
                   ELSE ($10::int / $9::int) + CASE WHEN g <= ($10::int % $9::int) THEN 1 ELSE 0 END END
         FROM generate_series(1, $9::int) g`,
      [r.pf, `${r.id}:`, r.id, r.name, r.plate, r.days, r.completed, r.km, r.trips, r.revenue ?? null]);
  }
  if (r.payout) {
    await q2(
      `INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
                                      period_start, period_end, earnings, cash_earnings)
       SELECT $1, 'ecosine', $2, $3, DATE '2025-04-05' + (g-1),
              DATE '2025-04-05' + (g-1), DATE '2025-04-05' + (g-1),
              ($4::int / $5::int) + CASE WHEN g <= ($4::int % $5::int) THEN 1 ELSE 0 END, 0
         FROM generate_series(1, $5::int) g`,
      [r.pf, r.id, r.name, r.payout, r.payoutDays]);
  }
  if (r.money) {
    await q2(
      `INSERT INTO driver_day (driver_ext_id, day, fleet_id, money, money_source, money_period_days)
       SELECT $1, DATE '2025-04-05' + (g-1), 'ecosine',
              ($2::int / $3::int) + CASE WHEN g <= ($2::int % $3::int) THEN 1 ELSE 0 END, $4, $5
         FROM generate_series(1, $3::int) g`,
      [r.id, r.money, r.moneyDays, r.src, r.mpd]);
  }
  if (r.standing) {
    await q2(`INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name,
                state, can_earn, plate) VALUES ($1,$2,'egari',$3,$4,$5,$6)`,
      [r.pf, r.id, r.name, r.standing.state, r.standing.can_earn, r.plate]);
  }
  if (r.compliance) {
    await q2(`INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, state,
                licence_no, licence_expires) VALUES ($1,$2,'ecosine',$3,'active','123456', DATE '2026-01-01')`,
      [r.pf, r.id, r.name]);
  }
}

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
driverRoutes(app, { q: q2, wrap });
const server = app.listen(0);
const get = async (p) => (await fetch(`http://127.0.0.1:${server.address().port}${p}`)).json();

const WIN = 'from=2025-04-01&to=2026-09-03';
const dir = await get(`/api/drivers/directory?${WIN}`);
const row = (id) => dir.find((r) => (r.ids || []).includes(id));

console.log('\nthe row count: twelve records, nine people');
check('twelve platform records went in', REC.length === 12);
check('and the directory lists nine people — three fewer, one per verified pair',
  dir.length === 9, `${dir.length} rows: ${dir.map((r) => r.driver_name).join(' | ')}`);
/* The same subtraction, on the whole real roster rather than on twelve rows:
   the fixture at the top of this file is all 395 of production's directory
   rows, and folding it with the register gives 392. */
{
  const key = (r, reg) => (reg ? ALIAS_KEY.get(r.id) : null) || r.person_key || foldName(r.name);
  const count = (reg) => new Set(FX.rows.map((r) => key(r, reg))).size;
  check('over the real 395-row roster the directory goes from 395 rows to 392',
    count(false) === 395 && count(true) === 392, `${count(false)} → ${count(true)}`);
}

console.log('\nnothing was lost: the surviving row carries both records');
const PAIRS = [
  { keep: REC[0], gone: REC[1], days: 429,
    want: { trips: 3970, completed: 3567, km: 55771, payout: 45950, money: 38620,
            money_days: 217, money_period_days: 7, money_source: 'mixed', revenue: 1099 } },
  { keep: REC[2], gone: REC[3], days: 64,
    want: { trips: 539, completed: 480, km: 6703, payout: 687, money: 158,
            money_days: 203, money_period_days: 7, money_source: 'statement', revenue: 0 } },
  { keep: REC[4], gone: REC[5], days: 307,
    want: { trips: 1790, completed: 1449, km: 17256, payout: 7382, money: 8881,
            money_days: 215, money_period_days: 7, money_source: 'mixed', revenue: 635 } },
];
for (const p of PAIRS) {
  const r = row(p.keep.id);
  const label = `${p.keep.name} + ${p.gone.name}`;
  check(`${label}: one row, holding both accounts`,
    !!r && r.ids.length === 2 && r.ids.includes(p.gone.id) && row(p.gone.id) === r,
    JSON.stringify(r?.ids));
  if (!r) continue;
  for (const [k, v] of Object.entries(p.want)) {
    const ok = typeof v === 'string' ? r[k] === v : Number(r[k]) === Number(v);
    const parts = [p.keep[k], p.gone[k]].map((x) => (x == null ? 'none' : x)).join(' + ');
    check(`  …${k} = ${JSON.stringify(v)}  [${parts}]`, ok, `got ${JSON.stringify(r[k])}`);
  }
  /* Days is the one figure that is neither a sum nor a max. */
  check(`  …days = ${p.days}, the UNION of both records' working days`,
    r.days === p.days,
    `got ${r.days} (sum would be ${(p.keep.days?.length || 0) + (p.gone.days?.length || 0)}, `
    + `max would be ${Math.max(p.keep.days?.length || 0, p.gone.days?.length || 0)})`);
  check('  …and both channels are named on it',
    (r.platforms || []).includes(p.keep.pf) || (r.platforms || []).includes(p.gone.pf),
    JSON.stringify(r.platforms));
}
/* The whole point of the last pair: the standing that only the Bolt record
   held is now readable on the person who holds it. */
{
  const r = row(REC[2].id);
  check('the deactivated Bolt account is now visible on the man it belongs to',
    r.platform_state === 'deactivated' && r.can_earn === false && r.state_plate === 'L10595',
    JSON.stringify({ s: r.platform_state, c: r.can_earn, p: r.state_plate }));
}
/* And the arithmetic, once, over the whole directory: a merge must not change
   the fleet's totals at all. */
{
  const sum = (f) => REC.reduce((a, r) => a + (Number(r[f]) || 0), 0);
  const got = (f) => dir.reduce((a, r) => a + (Number(r[f]) || 0), 0);
  check('the fleet still has every trip it had — 16,979 across nine rows',
    got('trips') === sum('trips') && got('trips') === 16979, `${got('trips')} vs ${sum('trips')}`);
  check('every kilometre — 203,489', got('km') === sum('km') && got('km') === 203489,
    `${got('km')} vs ${sum('km')}`);
  check('every dirham of payout — 54,019', got('payout') === sum('payout'),
    `${got('payout')} vs ${sum('payout')}`);
  check('and every dirham of money — 47,659', got('money') === sum('money'),
    `${got('money')} vs ${sum('money')}`);
}

console.log('\nthe pairs that are two people are still two rows');
for (const r of REFUSED) {
  const a = row(r.a.id), b = row(r.b.id);
  check(`"${r.a.name}" and "${r.b.name}" have a row each`,
    !!a && !!b && a !== b && a.ids.length === 1 && b.ids.length === 1,
    JSON.stringify([a?.ids, b?.ids]));
}
{
  const gul = row('4d4eb2c1-f64c-48c2-8167-32d887cecfd2');
  const khalid = row('76ede4ae-768b-4126-804b-0b5c88043682');
  check('…and neither took the other\'s work: 1,737 trips and 4,407, not 6,144 on one row',
    gul.trips === 1737 && khalid.trips === 4407, `${gul?.trips} / ${khalid?.trips}`);
}

console.log('\nopening either record opens the same person');
for (const m of MERGES) {
  const a = await get(`/api/driver/profile?id=${m.keep.id}&${WIN}`);
  const b = await get(`/api/driver/profile?id=${m.merge.id}&${WIN}`);
  check(`${m.keep.name}: the surviving id resolves to both accounts`,
    (a.ids || []).length === 2 && a.ids.includes(m.merge.id), JSON.stringify(a.ids));
  /* The direction production gets wrong today: opening the Yango record shows
     a 429-day veteran as a 20-trip newcomer, and opening the Bolt record 404s. */
  check(`${m.merge.name}: the duplicate id resolves to the same two accounts`,
    (b.ids || []).length === 2 && b.ids.includes(m.keep.id), JSON.stringify(b.ids));
  check('  …and both pages report the same span, so neither halves the person',
    a.span?.trips === b.span?.trips && a.span?.days_worked === b.span?.days_worked,
    JSON.stringify([a.span?.trips, b.span?.trips]));
}
/* A refused pair must NOT resolve to each other, through this route or any
   other. This is the assertion that would have caught an over-merge. */
for (const r of REFUSED) {
  const a = await get(`/api/driver/profile?id=${r.a.id}&${WIN}`);
  check(`profile(${r.a.name}) does not swallow ${r.b.name}`,
    !(a.ids || []).includes(r.b.id), JSON.stringify(a.ids));
}

/* ══ 6. the vehicle side: one man is not two custodians ═══════════════
   The evidence for the third pair reported the cost of getting this wrong: the
   L46208 vehicle page booked 34 handovers in August with a worst gap of 18.9
   hours, attributed between a real co-driver and the hotel record — idle time
   invented by a key change that never happened. So the custody helpers fold on
   the person too, and this is what says so. */
console.log('\nthe vehicle page counts people, not platform accounts');
{
  const M0 = MERGES[0];
  await q2(`INSERT INTO vehicle_driver_day (plate, day, platform, driver_ext_id, driver_name,
              fleet_id, trips, is_primary)
            VALUES ('L36397', DATE '2026-08-20','uber', $1,$2,'ecosine',9,true),
                   ('L36397', DATE '2026-08-20','yango',$3,$4,'ecosine',2,false),
                   ('L36397', DATE '2026-08-20','uber', $5,$6,'ecosine',7,false)`,
    [M0.keep.id, M0.keep.name, M0.merge.id, M0.merge.name,
     '37723dc3-0000-4000-8000-000000000001', 'Raja Nouman Ahmed']);
  const [c] = await q2(`SELECT ${custodyNames("'L36397'", "DATE '2026-08-20'")} AS names,
                               ${custodyRefs("'L36397'", "DATE '2026-08-20'")} AS refs,
                               ${custodyCountOverWindow("'L36397'", "DATE '2026-08-01'", "DATE '2026-08-31'")} AS n,
                               ${custodyOverWindow("'L36397'", "DATE '2026-08-01'", "DATE '2026-08-31'")} AS top`);
  check('three custody rows, two people — the day names each of them once',
    c.names === 'Aliyan khalil, Raja Nouman Ahmed', JSON.stringify(c.names));
  check('…and offers two clickable people, not three accounts',
    (c.refs || []).length === 2 && c.refs.some((r) => r.id === M0.keep.id)
    && !c.refs.some((r) => r.id === M0.merge.id), JSON.stringify(c.refs));
  check('…and the window count says two drivers held this car, not three',
    c.n === 2, String(c.n));
  check('…and neither person\'s days are split across two rows of the top list',
    (c.top || []).length === 2, JSON.stringify(c.top));
  /* The control: the co-driver is a real second human and must survive all of
     it. A fold that made this car single-custody would be the over-merge this
     product is built to avoid. */
  check('the car\'s genuine second human is still there',
    (c.refs || []).some((r) => r.name === 'Raja Nouman Ahmed'));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
