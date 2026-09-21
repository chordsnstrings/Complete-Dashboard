/* Resolving a human being ONCE, and refusing rather than guessing.
   ──────────────────────────────────────────────────────────────────────────
   api/ledger_person.js turns "the account the operator clicked" into a person
   id at write time and stamps the row with what decided it. Four behaviours
   carry the whole design, and each one has a failure that costs real money:

   ALREADY MAPPED wins over everything. A mapping that exists is a decision
   already taken; re-deriving it on every write is exactly the volatility
   sql/schema_v77.sql exists to escape.

   A SIBLING THAT IS MAPPED pulls the new account onto the same person, so a
   repayment entered against a driver's Bolt record reduces the balance their
   Uber advance created. Without it one human carries two balances and neither
   is right.

   NOBODY KNOWN mints a person. A new hire has no provider record at all —
   api/driver_routes.js:176 answers null for them — so a salary advance in
   their first week would otherwise have nothing to key on.

   A DEGRADED IDENTITY MAP IS A REFUSAL. api/identity_links.js:74-83 catches
   its own query failure and returns an EMPTY map, cached thirty seconds —
   honest for a directory, a silent un-merge for money. If this resolver
   quietly fell through to "nobody knows them" it would mint a SECOND person
   for somebody who already has one, splitting a balance in two with neither
   half right, and nothing on any screen would look wrong.

   NO NAME MATCHING, EVER, and the last block asserts it. The register holds
   back five pairs that carry simultaneous trips in two cars; a resolver that
   folded on a name would merge two brothers' debts at the moment money was
   recorded against one of them. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { resolvePerson, siblingIds } from '../api/ledger_person.js';
import { clearIdentityLinkCache, identityLinks } from '../api/identity_links.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const people = async () => (await q(`SELECT count(*)::int n FROM driver`))[0].n;

/* ── 3. nobody knows them: a person is minted ────────────────────────────── */
clearIdentityLinkCache();
const first = await resolvePerson(q, { platform: 'uber', extId: 'U-1', name: 'Amir Hassan', by: 'ahsan' });
check('an unknown account mints a person', first.created === true && first.person_id > 0,
  JSON.stringify(first));
check('and the account is mapped to them', (await q(
  `SELECT driver_id FROM driver_platform_id WHERE platform='uber' AND external_id='U-1'`
))[0]?.driver_id == first.person_id);
check('the person carries the name the operator saw',
  (await q(`SELECT full_name FROM driver WHERE id=$1`, [first.person_id]))[0].full_name === 'Amir Hassan');
check('and a note saying why they were minted',
  /no other account is known/.test((await q(
    `SELECT created_note FROM driver WHERE id=$1`, [first.person_id]))[0].created_note));

/* ── 1. already mapped wins, and mints nothing ───────────────────────────── */
const before = await people();
const again = await resolvePerson(q, { platform: 'uber', extId: 'U-1', name: 'AMIR HASSAN', by: 'haseeb' });
check('resolving the same account again returns the same person',
  again.person_id === first.person_id && again.created === false, JSON.stringify(again));
check('and mints nobody', await people() === before, `${await people()} vs ${before}`);
check('a differently-spelled name on the same account does NOT rename the person',
  (await q(`SELECT full_name FROM driver WHERE id=$1`, [first.person_id]))[0].full_name === 'Amir Hassan');

/* ── 2. a sibling the LINK TABLE names, confirmed by a human ─────────────── */
await q(`INSERT INTO driver_identity_link
   (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
    canonical_name, canonical_key, basis, evidence, confirmed_at, confirmed_by)
   VALUES ('B-1','bolt','Amir H','U-1','uber','Amir Hassan','amir hassan',
           'shared_phone','same phone on both roster rows', now(), 'ahsan')`);
clearIdentityLinkCache();
const sib = await resolvePerson(q, { platform: 'bolt', extId: 'B-1', name: 'Amir H', by: 'ahsan' });
check('an account the link table ties to a mapped one joins that person',
  sib.person_id === first.person_id && sib.created === false, JSON.stringify(sib));
check('and the row records WHICH decision attached it',
  /^link:/.test(sib.resolved_from), sib.resolved_from);
check('one person now holds both accounts',
  (await q(`SELECT count(*)::int n FROM driver_platform_id WHERE driver_id=$1`,
    [first.person_id]))[0].n === 2);
check('still nobody new was minted', await people() === before);

/* ── the refusal, which is the assertion that matters most ──────────────── */
/* COLD CACHE, deliberately. identityLinks holds a good map for thirty seconds,
   and while it does a database failure genuinely does not matter — the resolver
   is working from an answer it already has. The refusal only applies when the
   map has to be built and cannot be, so the cache is cleared to reach that
   path. Without this line the test passes against a resolver with no guard at
   all, which is how the first version of it was written. */
clearIdentityLinkCache();
const r = await resolvePerson(
  (t, p) => (/* every query fails the way a statement timeout would */
    /driver_identity_link/.test(t) ? Promise.reject(new Error('statement timeout')) : q(t, p)),
  { platform: 'yango', extId: 'Y-9', name: 'Somebody New', by: 'ahsan', links: null });
check('a degraded identity layer REFUSES rather than minting a duplicate',
  r.refused === true, JSON.stringify(r));
check('and says why, naming the split balance it would have caused',
  /splits a balance in two/i.test(r.why || ''), r.why);
check('nothing was written by the refused call',
  await people() === before && (await q(
    `SELECT count(*)::int n FROM driver_platform_id WHERE external_id='Y-9'`))[0].n === 0);

/* ── A FAILURE IS NEVER CACHED ───────────────────────────────────────────
   Caching one would hold thirty seconds of "nobody is linked to anybody" over
   every money surface after a single statement timeout — and worse, the
   resolver's own refusal would clear on the second call, because the cached
   map reads as a clean empty one. The refusal above passes with or without
   this rule, so it needs its own assertion: proved by reverting the `if (ok)`
   and watching THIS block go red while the refusal stays green. */
clearIdentityLinkCache();
const failed = await identityLinks((t, p) =>
  (/driver_identity_link/.test(t) ? Promise.reject(new Error('statement timeout')) : q(t, p)));
check('a failed link read is marked, not passed off as an empty one',
  failed.ok === false, JSON.stringify({ ok: failed.ok, rows: failed.rows?.length }));
const after = await identityLinks(q);
check('and the next read rebuilds rather than serving the failure from cache',
  after.ok === true && after.rows.length > 0,
  JSON.stringify({ ok: after.ok, rows: after.rows?.length }));
check('so a resolver called after a transient failure sees the real links',
  after.byAlias.get('B-1') != null, JSON.stringify([...after.byAlias]));

/* ── no name matching, at all ────────────────────────────────────────────── */
clearIdentityLinkCache();
const twin = await resolvePerson(q, { platform: 'uber', extId: 'U-2', name: 'Amir Hassan', by: 'ahsan' });
check('an identical NAME on an unrelated account is a different person',
  twin.person_id !== first.person_id && twin.created === true, JSON.stringify(twin));
check('because nothing in the resolver reads a name to decide identity',
  !/foldName|canonName|personOf\(/.test(
    (await import('node:fs')).readFileSync(new URL('../api/ledger_person.js', import.meta.url), 'utf8')));

/* ── siblingIds unions both sources and excludes the id itself ───────────── */
const s1 = siblingIds('U-1', { byAlias: new Map([['B-1', 'amir hassan']]),
  byName: new Map([['amir hassan', ['U-1', 'B-1']]]), nameOf: new Map() });
check('siblingIds never returns the id it was asked about', !s1.includes('U-1'), JSON.stringify(s1));

/* ── a person with no platform account at all, which requirement 7 needs ── */
const [solo] = await q(
  `INSERT INTO driver (full_name, created_by, created_note)
   VALUES ('Brand New Hire','ahsan','first week, no platform account') RETURNING id`);
check('a person can exist with no account, for a first-week salary advance',
  (await q(`SELECT count(*)::int n FROM driver_platform_id WHERE driver_id=$1`, [solo.id]))[0].n === 0);

/* ── MINTING SOMEBODY THE REGISTER ALREADY KNOWS ─────────────────────────
   The path nothing reached until the first live read of the empty ledger, and
   the one a large slice of the fleet takes on its FIRST entry.

   Step 3 does not only mint a person: it attaches, in the same breath, every
   sibling account the identity layer already names, so that a second entry
   made against the sibling an hour later cannot mint a second person for the
   same human. Those sibling rows are pulled out of the roster tables — and the
   statement doing the pulling selected `driver_name` from
   driver_platform_state, a column that table has never had. It is `full_name`
   there and `full_name` in driver_compliance; `driver_name` belongs to trip,
   money_event and the day rollups.

   So the whole of step 3 threw `column "driver_name" does not exist`, the
   transaction rolled back, and the entry was never written — for exactly the
   people the merge register was built to hold together. api/identity_map.js
   applies 130 entries over 124 people, every one of which reaches this branch
   the first time money is recorded against them while their sibling is still
   unmapped.

   Every earlier case in this file walks past it: an account with no siblings
   at all skips the loop, and an account whose sibling IS mapped returns at
   step 2 before ever reaching the mint. It needed a third shape — siblings
   named, none of them mapped — and that shape is the common one on a ledger
   with nobody on it yet.

   Proved by reverting `full_name` to `driver_name` in api/ledger_person.js and
   watching these four go red. */
clearIdentityLinkCache();
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, full_name, state)
         VALUES ('bolt','B-77','Kareem S','active')`);
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, phone)
         VALUES ('yango','Y-77','Kareem Sayed','+9715550077')`);
await q(`INSERT INTO driver_identity_link
   (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
    canonical_name, canonical_key, basis, evidence, confirmed_at, confirmed_by)
   VALUES ('B-77','bolt','Kareem S','U-77','uber','Kareem Sayed','kareem sayed',
           'shared_phone','same phone on both roster rows', now(), 'ahsan'),
          ('Y-77','yango','Kareem Sayed','U-77','uber','Kareem Sayed','kareem sayed',
           'shared_phone','same phone on both roster rows', now(), 'ahsan')`);
clearIdentityLinkCache();

const twoSibs = await resolvePerson(
  q, { platform: 'uber', extId: 'U-77', name: 'Kareem Sayed', by: 'ahsan' });
check('minting somebody whose siblings are named but unmapped does not throw',
  twoSibs.refused !== true && twoSibs.created === true, JSON.stringify(twoSibs));
check('and the note counts the siblings the identity layer named',
  /2 sibling account\(s\)/.test((await q(
    `SELECT created_note FROM driver WHERE id=$1`, [twoSibs.person_id]))[0]?.created_note || ''),
  (await q(`SELECT created_note FROM driver WHERE id=$1`, [twoSibs.person_id]))[0]?.created_note);
check('all three accounts land on the one person, in the same breath as the mint',
  (await q(`SELECT count(*)::int n FROM driver_platform_id WHERE driver_id=$1`,
    [twoSibs.person_id]))[0].n === 3,
  JSON.stringify(await q(
    `SELECT platform, external_id, basis FROM driver_platform_id WHERE driver_id=$1
      ORDER BY external_id`, [twoSibs.person_id])));
check('each attached sibling carries the roster name and says what attached it',
  (await q(`SELECT external_id, display_name, basis FROM driver_platform_id
             WHERE driver_id=$1 AND basis LIKE 'sibling-of:%' ORDER BY external_id`,
  [twoSibs.person_id])).every((r) => r.display_name && r.basis === 'sibling-of:U-77'),
  JSON.stringify(await q(`SELECT external_id, display_name, basis FROM driver_platform_id
                           WHERE driver_id=$1 AND basis LIKE 'sibling-of:%'`, [twoSibs.person_id])));
/* And the point of doing it in the same breath: the sibling resolves to the
   person who already exists, rather than minting a second one. */
const later = await resolvePerson(q, { platform: 'bolt', extId: 'B-77', name: 'Kareem S', by: 'haseeb' });
check('an entry against the sibling an hour later finds the same person',
  later.person_id === twoSibs.person_id && later.created === false, JSON.stringify(later));

console.log(`\n${fail ? '✗' : '✓'} ledger_resolve_person: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
