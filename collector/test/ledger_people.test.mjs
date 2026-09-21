/* WHO THE MONEY PICKER MAY OFFER — people, not accounts.
   ══════════════════════════════════════════════════════════════════════════
   THE DEFECT, measured on production 2026-09-21. This endpoint listed
   ACCOUNTS: 508 of them, while #drivers showed 347 people over the same
   roster. So a supervisor could record a charging advance against 'Tariq Afzal
   Afzal' today and 'Tariq Afzal Said Afzal' tomorrow — one man, two balances,
   each looking perfectly reasonable, and nothing on screen showing the error.
   The same defect in the other direction pools two men's debts into one.

   Four surfaces answered "how many drivers" four ways — 347, 437, 508, 0 —
   because five different things decided who a person is and no two surfaces
   consulted the same combination.

   src/persons.js now materialises one row per human into driver +
   driver_platform_id, built from REVIEWED DECISIONS ONLY, and this endpoint
   reads it. What this file holds down:

   1. ONE ROW PER PERSON, carrying every account they hold — so the same human
      cannot be picked twice under two spellings.
   2. THE COUNT IS THE SPINE'S. Not a count of accounts, and not a second fold
      computed here that could drift from the directory's.
   3. AN EMPTY SPINE SAYS SO. Before the collector has built it there is nobody
      to offer, and that must read as "not built yet", never as "this fleet has
      no drivers".
   4. A DEGRADED READ IS NOT AN EMPTY ROSTER. 503 with a reason, because a
      picker with nobody in it looks identical to a fleet that has hired
      nobody. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshPersons } from '../src/persons.js';
import { clearIdentityLinkCache } from '../api/identity_links.js';
import { clearPersonMapCache } from '../api/person_map.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { get } = await mountAll(db);
const people = async () => { clearPersonMapCache(); return (await get('/api/ledger/people')).body; };

/* ── 3. AN EMPTY SPINE SAYS SO ───────────────────────────────────────────
   The assertion the live read needed and no fixture made: before the spine is
   built there is nobody to offer, and the reason must distinguish "not built"
   from "nobody works here". */
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, full_name, state)
         VALUES ('uber','U-100','Rashid Malik','active'),
                ('bolt','B-100','Rashid Malik Iqbal','active'),
                ('yango','Y-300','Samir Haq','active')`);
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, phone)
         VALUES ('uber','U-100','Rashid Malik','+9715550100'),
                ('bolt','B-100','Rashid Malik Iqbal','+9715550100')`);

const cold = await people();
check('before the spine is built the picker offers nobody',
  cold.people.length === 0, JSON.stringify(cold.people));
check('and says it has not been built, never that the fleet has no drivers',
  /spine is empty/i.test(cold.note || '') && /until it has run once/i.test(cold.note || ''),
  cold.note);
check('the roster accounts waiting to be placed are COUNTED, not hidden',
  cold.unplaced_accounts === 3, String(cold.unplaced_accounts));
check('with a reason saying nobody is left out on purpose',
  /Nobody is hidden on purpose/.test(cold.unplaced_reason || ''), cold.unplaced_reason);

/* ── build it ────────────────────────────────────────────────────────────
   U-100 and B-100 are one man — a CONFIRMED shared_phone link, which is a
   reviewed decision. Y-300 is somebody else. */
await q(`INSERT INTO driver_identity_link
   (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
    canonical_name, canonical_key, basis, evidence, confirmed_at, confirmed_by)
   VALUES ('U-100','uber','Rashid Malik','B-100','bolt','Rashid Malik Iqbal',
           'rashid malik iqbal','shared_phone','the same number on both records',
           now(),'ahsan')`);
clearIdentityLinkCache();
await refreshPersons(db);

const warm = await people();
check('the picker now offers people', warm.people.length === 2,
  JSON.stringify(warm.people.map((p) => p.name)));

/* ── 1. ONE ROW PER PERSON ───────────────────────────────────────────────
   THE ASSERTION THIS FILE EXISTS FOR. Two accounts, two spellings, one man —
   and he must be offerable exactly once, or he gets two balances. */
const rashid = warm.people.filter((p) => /Rashid/i.test(p.name || ''));
check('a man holding two accounts under two spellings is offered ONCE',
  rashid.length === 1, `${rashid.length}: ${JSON.stringify(rashid.map((p) => p.name))}`);
check('and the row carries both of his accounts',
  rashid[0].accounts === 2 && rashid[0].account_ids.length === 2,
  JSON.stringify(rashid[0].account_ids));
check('so a write can be addressed through either of them',
  rashid[0].account_ids.includes('U-100') && rashid[0].account_ids.includes('B-100'),
  JSON.stringify(rashid[0].account_ids));
check('the platforms he works are listed, which is what tells two namesakes apart',
  rashid[0].platforms.includes('uber') && rashid[0].platforms.includes('bolt'),
  JSON.stringify(rashid[0].platforms));
check('every row is addressable by a person id — there is no second class',
  warm.people.every((p) => p.person_id != null && p.on_the_ledger === true),
  JSON.stringify(warm.people.map((p) => [p.name, p.person_id])));

/* ── 2. THE COUNT IS THE SPINE'S ─────────────────────────────────────────
   Not a count of accounts, and not a second fold computed in this route that
   could drift from the directory's. */
const [{ n: spine }] = await q(`SELECT count(*)::int n FROM driver`);
check('the count is exactly the number of rows in the spine',
  warm.known === spine && warm.people.length === spine, `${warm.known} vs ${spine}`);
check('and the account total is stated beside it, so the two cannot be confused',
  warm.accounts === 3, String(warm.accounts));
check('the note says both numbers, and that one table produces them',
  /2 people across 3 platform accounts/.test(warm.note || '')
  && /one table/.test(warm.note || ''), warm.note);
check('nothing is left waiting once the spine has run',
  warm.unplaced_accounts === 0 && warm.unplaced_reason === null,
  JSON.stringify({ u: warm.unplaced_accounts, r: warm.unplaced_reason }));

/* ── a person with no platform account at all ────────────────────────────
   Requirement 7: advances are given to the PERSON. A first-week hire exists in
   no provider's records and must still be pickable. */
await q(`INSERT INTO driver (full_name, created_by, created_note)
         VALUES ('Brand New Hire','ahsan','first week, no platform account')`);
const withSolo = await people();
const hire = withSolo.people.find((p) => p.name === 'Brand New Hire');
check('somebody with no platform account at all is offered', hire != null,
  JSON.stringify(withSolo.people.map((p) => p.name)));
check('with no account, stated as zero rather than hidden',
  hire.accounts === 0 && hire.ext_id === null, JSON.stringify(hire));

/* ── a detached account leaves the person ────────────────────────────────
   driver_platform_id carries detached_at so a wrong merge can be undone. */
await q(`UPDATE driver_platform_id SET detached_at = now(), detached_reason = 'wrong person'
          WHERE external_id = 'B-100'`);
const detached = await people();
const r2 = detached.people.find((p) => /Rashid/i.test(p.name || ''));
check('a detached account stops counting against the person it was on',
  r2.accounts === 1 && !r2.account_ids.includes('B-100'), JSON.stringify(r2.account_ids));
check('and is reported as waiting to be placed again',
  detached.unplaced_accounts === 1, String(detached.unplaced_accounts));

/* ── 4. A DEGRADED READ IS NOT AN EMPTY ROSTER ───────────────────────────── */
clearPersonMapCache();
const broken = await mountAll(await (async () => {
  const d2 = new PGlite(); await applySchema(d2); return d2;
})());
/* The spine table is absent from nothing here, so the failure is forced at the
   query itself — the same way test/ledger_resolve_person.test.mjs forces a
   degraded identity read rather than trusting a shape check. */
const { personMap } = await import('../api/person_map.js');
clearPersonMapCache();
const degraded = await personMap((t) => (/FROM driver\b/.test(t)
  ? Promise.reject(new Error('statement timeout')) : q(t)));
check('a failed spine read is MARKED, not passed off as an empty roster',
  degraded.ok === false, JSON.stringify({ ok: degraded.ok, n: degraded.person.size }));
clearPersonMapCache();
const after = await personMap(q);
check('and the next read rebuilds rather than serving the failure from cache',
  after.ok === true && after.person.size > 0,
  JSON.stringify({ ok: after.ok, n: after.person.size }));
void broken;

console.log(`\n${fail ? '✗' : '✓'} ledger_people: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
