/* THE CLOSED LOOP, AND THE LIST THAT OPENS IT.
   ──────────────────────────────────────────────────────────────────────────
   People are minted lazily, by the first entry recorded against them. That is
   the right design — sql/schema_v77.sql argues it — but it left the system
   unable to start. Every entry screen listed drivers from /api/ledger/exposure,
   which reads `driver`; `driver` is empty until somebody records an entry; and
   an entry cannot be recorded against somebody the picker will not offer. The
   first live read of production said so in five zeroes:

       people on the ledger      : 0
       measurable exposure       : 0
       ...

   None of the 270 test files could see it, because every one of them seeds a
   person before asking anything. So this file asserts the thing they all
   assumed: that the list a picker reads is NOT the list of people who already
   have a balance, and that somebody with no ledger history at all is offerable.

   THE SECOND LIST CARRIES NO PERSON ID, DELIBERATELY. A roster account has no
   person yet; handing the page a fabricated id would mean the page choosing
   who somebody is. It sends the ACCOUNT, and api/ledger_person.js resolves and
   mints inside the same transaction as the entry — so the identity decision is
   taken once, by the resolver, with the merge register in hand. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { get } = await mountAll(db);

/* ── AN EMPTY LEDGER STILL OFFERS THE ROSTER ─────────────────────────────
   The assertion the live read needed and no fixture made. */
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, full_name, state)
         VALUES ('uber','U-100','Rashid Malik','active'),
                ('bolt','B-200','Nadia Omar','active')`);
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, phone)
         VALUES ('yango','Y-300','Samir Haq','+9715550300')`);

const cold = (await get('/api/ledger/people')).body;
check('with nobody on the ledger, the roster is still offerable',
  cold.people.length === 3, JSON.stringify({ n: cold.people.length, known: cold.known, unmapped: cold.unmapped }));
check('and all three are marked as not yet on the ledger',
  cold.people.every((p) => p.on_the_ledger === false && p.person_id === null),
  JSON.stringify(cold.people));
check('each one carries the account a write would resolve through',
  cold.people.every((p) => p.platform && p.ext_id), JSON.stringify(cold.people));
check('the counts are stated rather than left to be derived from the array',
  cold.known === 0 && cold.unmapped === 3, JSON.stringify({ known: cold.known, unmapped: cold.unmapped }));
check('and the response says WHY the first list is empty, in plain English',
  /minted by the first entry/i.test(cold.note || ''), cold.note);

/* ── A PERSON WHO EXISTS APPEARS ONCE, ON THE KNOWN SIDE ONLY ──────────── */
const [p1] = await q(`INSERT INTO driver (full_name, created_by, cash_rule)
                      VALUES ('Rashid Malik','ahsan','deposit_all') RETURNING id`);
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, display_name, basis)
         VALUES ('uber','U-100',$1,'Rashid Malik','account')`, [p1.id]);

const warm = (await get('/api/ledger/people')).body;
check('mapping an account moves that person across, it does not duplicate them',
  warm.people.length === 3 && warm.known === 1 && warm.unmapped === 2,
  JSON.stringify({ n: warm.people.length, known: warm.known, unmapped: warm.unmapped }));
check('the mapped account no longer appears as an unclaimed roster row',
  warm.people.filter((p) => p.ext_id === 'U-100').length === 1,
  JSON.stringify(warm.people.filter((p) => p.ext_id === 'U-100')));
const rashid = warm.people.find((p) => p.name === 'Rashid Malik');
check('and comes back with a real person id a write can address directly',
  rashid && rashid.person_id === Number(p1.id) && rashid.on_the_ledger === true,
  JSON.stringify(rashid));
check('carrying the cash rule, which decides what the deposit screen asks of them',
  rashid.cash_rule === 'deposit_all', String(rashid?.cash_rule));
check('and how many accounts fold onto them, so one person is visibly one person',
  rashid.accounts === 1, String(rashid?.accounts));

/* ── A PERSON WITH NO ACCOUNT AT ALL IS STILL OFFERABLE ──────────────────
   Requirement 7: advances are given to the PERSON. A first-week hire paid a
   salary advance exists in no provider's records — api/driver_routes.js:176
   answers null for them — and must still be pickable, or the screen cannot do
   the thing it was built for. */
const [solo] = await q(`INSERT INTO driver (full_name, created_by, created_note)
                        VALUES ('Brand New Hire','ahsan','first week') RETURNING id`);
const withSolo = (await get('/api/ledger/people')).body;
const hire = withSolo.people.find((p) => p.name === 'Brand New Hire');
check('somebody with no platform account at all is offered',
  hire != null, JSON.stringify(withSolo.people.map((p) => p.name)));
check('with a person id, because they already exist',
  hire && hire.person_id === Number(solo.id) && hire.on_the_ledger === true, JSON.stringify(hire));
check('and no account, stated as zero rather than hidden',
  hire.accounts === 0 && hire.ext_id === null, JSON.stringify(hire));

/* ── A DETACHED MAPPING RELEASES THE ACCOUNT BACK TO THE ROSTER ──────────
   driver_platform_id carries detached_at precisely so a wrong merge can be
   undone. If this list ignored it, the account would be invisible on both
   sides — claimed by a person who no longer holds it, and filtered out of the
   roster by the same row. */
await q(`UPDATE driver_platform_id SET detached_at = now(), detached_reason = 'wrong person'
          WHERE external_id = 'U-100'`);
const detached = (await get('/api/ledger/people')).body;
check('a detached account returns to the unclaimed side rather than vanishing',
  detached.people.filter((p) => p.ext_id === 'U-100' && p.on_the_ledger === false).length === 1,
  JSON.stringify(detached.people.filter((p) => p.ext_id === 'U-100')));
check('and the person they were detached from is still listed, now with no accounts',
  detached.people.find((p) => p.person_id === Number(p1.id))?.accounts === 0,
  JSON.stringify(detached.people.find((p) => p.person_id === Number(p1.id))));

/* ── A ROSTER ROW WITH NO NAME IS NOT OFFERED ────────────────────────────
   A picker entry reading "(null)" is a row an operator cannot identify, and
   choosing it would record real money against an account nobody recognised. */
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, full_name, state)
         VALUES ('uber','U-NONAME',NULL,'active')`);
const nameless = (await get('/api/ledger/people')).body;
check('a roster row with no name is left out rather than offered unidentifiable',
  !nameless.people.some((p) => p.ext_id === 'U-NONAME'),
  JSON.stringify(nameless.people.filter((p) => p.ext_id === 'U-NONAME')));

/* ── THE SAME ACCOUNT IN BOTH ROSTER TABLES IS ONE ROW ─────────────────── */
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, phone)
         VALUES ('bolt','B-200','Nadia Omar','+9715550200')`);
const dupe = (await get('/api/ledger/people')).body;
check('an account filed in both roster tables is offered once, not twice',
  dupe.people.filter((p) => p.ext_id === 'B-200').length === 1,
  JSON.stringify(dupe.people.filter((p) => p.ext_id === 'B-200')));

console.log(`\n${fail ? '✗' : '✓'} ledger_people: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
