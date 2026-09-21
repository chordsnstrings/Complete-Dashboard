/* THE PERSON SPINE — one row per human, and the name rule it refuses.
   ══════════════════════════════════════════════════════════════════════════
   Measured on production 2026-09-21: four surfaces, four answers to "how many
   drivers", over the same 800 accounts.

       /api/drivers/directory      347   register + links + a NAME match
       /api/compliance/drivers     437   accounts, not people
       /api/ledger/people          508   accounts, not people
       /api/ledger/exposure          0   only persons the money ledger minted

   None of them is a count of human beings. This file holds down the one that
   is, and the three properties that make it trustworthy.

   1. IT IS BUILT FROM REVIEWED DECISIONS ONLY. The register, and links that
      are conclusive (a phone, an email — those are IDENTIFIERS) or confirmed
      by a person. A similar NAME is none of those. The directory folded on one
      anyway, through `byName`, and that rule alone made 92 of its 347 rows —
      44 supported by a matching phone, 37 with no evidence either way, and
      NINE CONTRADICTED by different phone numbers on the records it joined.
      CLAUDE.md forbids it in as many words.

   2. IT NEVER DETACHES. driver_ledger keys on person_id, so moving an account
      off a person moves money. That is an operation somebody authorises, not a
      side effect of a sweep that runs every half hour.

   3. IT IS IDEMPOTENT. Run it three times and the third run mints nobody —
      the same property test/identity_queue_persists.test.mjs exists for, after
      the link refresh was found to withdraw its own proposals every second
      pass. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { refreshPersons } from '../src/persons.js';
import { clearIdentityLinkCache } from '../api/identity_links.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const people = async () => (await q(`SELECT count(*)::int n FROM driver`))[0].n;
const acctsOf = async (id) => (await q(
  `SELECT external_id FROM driver_platform_id WHERE driver_id=$1 AND detached_at IS NULL
    ORDER BY external_id`, [id])).map((r) => r.external_id);

/* ── a roster across all three tables ────────────────────────────────────
   One account in each, because 302 of production's 800 appear ONLY in trip —
   a driver who took bookings and was never filed on a roster still has to be
   somebody, and a spine built from the roster tables alone would lose them. */
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, full_name, state)
         VALUES ('uber','U-1','Imran Shah','active'),
                ('bolt','B-1','Imran Shah Akbar','active')`);
/* Y-1 is filed under EXACTLY the name the linked ALIAS carries — 'Imran Shah',
   not the canonical 'Imran Shah Akbar'. That is the shape byName folds on: the
   map is keyed by the alias's folded name, so any account whose own folded name
   equals it inherits the person, with nobody having reviewed it. It made 92 of
   the directory's 347 rows. A fixture naming Y-1 anything else cannot catch a
   spine that folds on names, which is what the first version of this file did. */
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, phone)
         VALUES ('yango','Y-1','Imran Shah','+9715550001'),
                ('uber','U-2','Farah Noor','+9715550002')`);
await q(`INSERT INTO trip (platform, fleet_id, external_id, driver_ext_id, driver_name, plate,
                           requested_at, ended_at, status)
         VALUES ('hotel','ecosine','t1','H-1','Somebody Only In Trips','L1',
                 '2026-09-01T09:00:00Z','2026-09-01T09:20:00Z','completed')`);

/* One CONFIRMED link: U-1 → B-1. A reviewed decision, so the spine applies it. */
await q(`INSERT INTO driver_identity_link
   (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
    canonical_name, canonical_key, basis, evidence, confirmed_at, confirmed_by)
   VALUES ('U-1','uber','Imran Shah','B-1','bolt','Imran Shah Akbar',
           'imran shah akbar','similar_name','the shorter name inside the longer',
           now(),'ahsan')`);
clearIdentityLinkCache();

/* ── the dry run writes nothing ──────────────────────────────────────────── */
const dry = await refreshPersons(db, { dryRun: true });
check('a dry run counts what it would do and writes nothing',
  dry.dry_run === true && dry.components > 0 && await people() === 0,
  JSON.stringify(dry));

/* ── the real pass ───────────────────────────────────────────────────────── */
const t1 = await refreshPersons(db);
check('every account is placed', t1.accounts === 5, JSON.stringify(t1));
check('and the confirmed link folds two of them into one person',
  t1.components === 4 && t1.minted === 4, JSON.stringify(t1));
check('so the spine holds four people over five accounts', await people() === 4);

const [imran] = await q(`SELECT id FROM driver WHERE full_name = 'Imran Shah Akbar'`);
check('the linked pair sits on one person', imran != null && (await acctsOf(imran.id)).length === 2,
  JSON.stringify(imran && await acctsOf(imran.id)));
check('named by the LONGER filed name, which is the one documents match',
  imran != null, 'no person carries the fuller name');
check('a driver who appears only in trip is still somebody',
  (await q(`SELECT 1 FROM driver_platform_id WHERE external_id='H-1'`)).length === 1);
check('each account records WHICH decision placed it',
  (await q(`SELECT basis FROM driver_platform_id WHERE external_id='U-1'`))[0].basis === 'link',
  JSON.stringify(await q(`SELECT external_id, basis FROM driver_platform_id ORDER BY external_id`)));

/* ── THE NAME RULE IS REFUSED ────────────────────────────────────────────
   Y-1 is filed under EXACTLY the same folded name as the linked pair — the
   shape that made 92 of the directory's rows. No link names it and the
   register does not either, so the spine must leave it alone. This is the
   assertion the whole file exists for. */
check('an account sharing a name with a linked pair is NOT folded onto them',
  !(await acctsOf(imran.id)).includes('Y-1'), JSON.stringify(await acctsOf(imran.id)));
check('it is its own person until somebody reviews it',
  (await q(`SELECT count(*)::int n FROM driver_platform_id WHERE external_id='Y-1'
             AND driver_id <> $1`, [imran.id]))[0].n === 1);

/* ── IDEMPOTENT ──────────────────────────────────────────────────────────── */
const before = await people();
const t2 = await refreshPersons(db);
const t3 = await refreshPersons(db);
check('running it again mints nobody', await people() === before,
  `${await people()} vs ${before}`);
check('and attaches nothing new', t2.attached === 0 && t3.attached === 0,
  JSON.stringify({ t2: t2.attached, t3: t3.attached }));
check('it reports what it found already in place rather than silently skipping',
  t3.already === 5, String(t3.already));

/* ── A NEW CONFIRMED LINK IS PICKED UP, WITHOUT DETACHING ANYTHING ───────── */
await q(`INSERT INTO driver_identity_link
   (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
    canonical_name, canonical_key, basis, evidence, confirmed_at, confirmed_by)
   VALUES ('Y-1','yango','Imran Shah','B-1','bolt','Imran Shah Akbar',
           'imran shah akbar','shared_phone','same number on both records',
           now(),'haseeb')`);
clearIdentityLinkCache();
const t4 = await refreshPersons(db);
check('a link confirmed later folds that account onto the existing person',
  (await acctsOf(imran.id)).includes('Y-1'), JSON.stringify(await acctsOf(imran.id)));
check('and the duplicate person row goes, so the count is right',
  await people() === before - 1 && t4.folded === 1,
  `${await people()} vs ${before - 1}, folded ${t4.folded}`);
check('all three accounts now sit on ONE person',
  (await q(`SELECT count(DISTINCT driver_id)::int n FROM driver_platform_id
             WHERE external_id = ANY($1::text[]) AND detached_at IS NULL`,
  [['U-1', 'B-1', 'Y-1']]))[0].n === 1);

/* ── BUT NOT WHEN THERE IS MONEY ON EITHER SIDE ──────────────────────────
   The whole reason to be careful about folding is that driver_ledger keys on
   person_id. So money is the test: an empty person is safe to fold, one
   carrying an entry is not, and the second is left for an authorised merge
   that moves the rows and records that it did. */
const [lone] = await q(`SELECT id FROM driver WHERE full_name = 'Farah Noor'`);
await q(`INSERT INTO driver_ledger
     (person_id, person_name, resolved_from, type_code, direction, book, amount,
      effective_on, entered_by, note)
   VALUES ($1,'Farah Noor','human:ahsan','cash_advance',1,'advance',500,
           '2026-09-10','ahsan','an advance that must not move by itself')`, [lone.id]);
await q(`INSERT INTO driver_identity_link
   (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
    canonical_name, canonical_key, basis, evidence, confirmed_at, confirmed_by)
   VALUES ('U-2','uber','Farah Noor','H-1','hotel','Somebody Only In Trips',
           'somebody only in trips','shared_phone','same number on both records',
           now(),'ahsan')`);
clearIdentityLinkCache();
const nowN = await people();
const t5 = await refreshPersons(db);
check('a component whose person carries an entry is NOT folded by the sweep',
  await people() === nowN && t5.folded === 0,
  `${await people()} vs ${nowN}, folded ${t5.folded}`);
check('it is counted as needing an authorised merge instead',
  t5.needs_merge === 1, String(t5.needs_merge));
check('and the entry has not moved',
  (await q(`SELECT person_id FROM driver_ledger`))[0].person_id == lone.id);

/* ── A DEGRADED IDENTITY READ REFUSES ────────────────────────────────────── */
clearIdentityLinkCache();
const refused = await refreshPersons({
  query: (t, p) => (/driver_identity_link/.test(t)
    ? Promise.reject(new Error('statement timeout'))
    : db.query(t, p)),
});
check('a degraded identity layer REFUSES rather than minting one person per account',
  refused.refused === true, JSON.stringify(refused));
check('and says what it would have done wrong',
  /mint a separate person for every account/.test(refused.why || ''), refused.why);

console.log(`\n${fail ? '✗' : '✓'} persons_spine: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
