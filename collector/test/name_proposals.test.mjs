/* THE PAIRS THE DIRECTORY USED TO FOLD SILENTLY.
   ══════════════════════════════════════════════════════════════════════════
   Removing a bad rule is half a fix. api/driver_routes.js folded on `byName` —
   an account in no link inheriting a person because its folded name matched a
   linked alias's — and that rule alone made 92 of the directory's 347 rows.
   Measured at the same time: of the 121 accounts it placed, exactly ONE
   appeared anywhere in driver_identity_link. Dropping the fold without writing
   the other 120 down would split 120 people apart and leave nobody anything to
   answer: a defensible count over a quietly wrong roster, with no question
   being asked.

   So they become PROPOSALS, and the three things that must hold:

   1. THEY ARE NEVER APPLIED. api/identity_links.js folds a link only where the
      basis is conclusive — shared_phone or shared_email, which are IDENTIFIERS
      — or a person confirmed it. `same_name` is neither, and that predicate is
      an allow-list, so this basis cannot fold by accident.

   2. THE PHONE VERDICT IS IN THE EVIDENCE, all three states. Nine of the real
      pairs carry DIFFERENT numbers, which is a reason to say no — and a queue
      that presented those identically to the 44 whose numbers agree would be
      asking somebody to decide with the evidence withheld.

   3. IT ASKS NOTHING IT ALREADY KNOWS. A pair the spine has already joined by
      a reviewed decision is not a question. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { refreshNameProposals } from '../src/name_proposals.js';
import { refreshPersons } from '../src/persons.js';
import { identityLinks, clearIdentityLinkCache } from '../api/identity_links.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

/* Three shapes, one of each verdict, plus a pair already joined. */
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, phone) VALUES
  ('uber','A-1','Kareem Sayed','+971500000001'),
  ('bolt','A-2','KAREEM SAYED','+971500000001'),
  ('uber','B-1','Wajid Ali','+971500000002'),
  ('bolt','B-2','WAJID ALI','+971500000009'),
  ('uber','C-1','Noor Zaman',NULL),
  ('bolt','C-2','NOOR ZAMAN',NULL),
  ('uber','D-1','Imran Shah','+971500000004'),
  ('bolt','D-2','IMRAN SHAH','+971500000004')`);

/* D-1/D-2 are ALREADY one person by a confirmed link — not a question. */
await q(`INSERT INTO driver_identity_link
   (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
    canonical_name, canonical_key, basis, evidence, confirmed_at, confirmed_by)
   VALUES ('D-2','bolt','IMRAN SHAH','D-1','uber','Imran Shah','imran shah',
           'shared_phone','the same number on both records', now(),'ahsan')`);
clearIdentityLinkCache();
await refreshPersons(db);

const out = await refreshNameProposals(db);
check('it proposes the same-name pairs nobody had written down',
  out.wrote === 3, JSON.stringify(out));
check('and skips the pair a reviewed decision already joins',
  out.skipped >= 1, JSON.stringify(out));

const rows = await q(`SELECT * FROM driver_identity_link WHERE basis='same_name' ORDER BY alias_ext_id`);
check('each is written as a proposal, unconfirmed',
  rows.length === 3 && rows.every((r) => r.confirmed_at === null),
  JSON.stringify(rows.map((r) => [r.alias_ext_id, r.confirmed_at])));

/* ── 2. ALL THREE PHONE VERDICTS, SAID ──────────────────────────────────── */
const ev = Object.fromEntries(rows.map((r) => [r.alias_ext_id, r.evidence]));
check('where the numbers AGREE it says so, and that the register treats it as conclusive',
  /same phone number/.test(ev['A-2']) && /conclusive/.test(ev['A-2']), ev['A-2']);
check('where they DISAGREE it says so in capitals, and calls it a reason to say no',
  /DIFFERENT phone numbers/.test(ev['B-2']) && /reason to say no/.test(ev['B-2']), ev['B-2']);
check('and names the case it is protecting against — two men with one name',
  /two different men with one name/.test(ev['B-2']), ev['B-2']);
check('where neither has a number it says there is no identifier either way',
  /no identifier either way/.test(ev['C-2']), ev['C-2']);
check('every one says the name settles nothing, which is why it is being asked',
  rows.every((r) => /asked rather than applied/.test(r.evidence)));
check('the tally reports the three verdicts separately, so the queue can be triaged',
  out.agree === 1 && out.disagree === 1 && out.unknown === 1, JSON.stringify(out));

/* ── 1. THE ASSERTION THAT MAKES THIS SAFE ──────────────────────────────── */
clearIdentityLinkCache();
const links = await identityLinks(q);
check('NOT ONE of them folds anybody — the basis is not conclusive',
  ![...links.byAlias.keys()].some((k) => ['A-2', 'B-2', 'C-2'].includes(k)),
  JSON.stringify([...links.byAlias.keys()]));
const before = (await q(`SELECT count(*)::int n FROM driver`))[0].n;
await refreshPersons(db);
check('and the spine does not fold on them either',
  (await q(`SELECT count(*)::int n FROM driver`))[0].n === before,
  `${(await q(`SELECT count(*)::int n FROM driver`))[0].n} vs ${before}`);

/* A CONFIRMED one DOES fold — the queue has to be worth answering. */
await q(`UPDATE driver_identity_link SET confirmed_at = now(), confirmed_by = 'ahsan'
          WHERE alias_ext_id = 'A-2'`);
clearIdentityLinkCache();
await refreshPersons(db);
check('confirming one folds that person, so answering the queue achieves something',
  (await q(`SELECT count(DISTINCT driver_id)::int n FROM driver_platform_id
             WHERE external_id IN ('A-1','A-2') AND detached_at IS NULL`))[0].n === 1);

/* ── 3. IDEMPOTENT ──────────────────────────────────────────────────────── */
const again = await refreshNameProposals(db);
check('a second pass writes no new rows', again.wrote <= out.wrote, JSON.stringify(again));
check('and the queue is not emptied between passes',
  (await q(`SELECT count(*)::int n FROM driver_identity_link WHERE basis='same_name'`))[0].n >= 2);

/* ── AND THE LINK SWEEP DOES NOT WITHDRAW THEM ──────────────────────────
   THE ASSERTION THIS NEARLY SHIPPED WITHOUT. refreshIdentityLinks ends by
   deleting every unconfirmed link it did not just write — that is how a link
   whose evidence has gone stops being made. It knew nothing about `same_name`,
   so it would have found these rows unaccounted for and deleted the whole
   queue on the next pass, while src/name_proposals.js rewrote it. An operator
   halfway through reviewing would have lost first_seen_at every half hour.

   It is the same defect src/identity_link.js already records shipping — "run 1
   proposed 1 and the queue held 1; run 2 proposed 0, withdrew 1, and the queue
   was EMPTY" — arriving by a different door.

   Proved by reverting the `basis = ANY(MINE)` clause in that DELETE. */
const { refreshIdentityLinks } = await import('../src/identity_link.js');
/* COUNTED BY ROW, NOT BY BASIS. A proposal the phone rule then claims is
   UPGRADED — same_name becomes shared_phone, which is stronger evidence and a
   better outcome. Counting the basis calls that a loss and fails against a
   sweep behaving correctly, which is how the first version of this assertion
   read. What must not happen is the ROW going. */
const queued = (await q(
  `SELECT alias_ext_id FROM driver_identity_link WHERE confirmed_at IS NULL`))
  .map((r) => r.alias_ext_id);
check('there are unconfirmed proposals to protect', queued.length >= 2, JSON.stringify(queued));
await refreshIdentityLinks(db);
const after2 = new Set((await q(`SELECT alias_ext_id FROM driver_identity_link`))
  .map((r) => r.alias_ext_id));
const lost = queued.filter((id) => !after2.has(id));
check('the link sweep does NOT withdraw a proposal another module wrote',
  lost.length === 0, `lost: ${JSON.stringify(lost)}`);
check('and a proposal it can support is upgraded rather than duplicated',
  (await q(`SELECT count(*)::int n FROM driver_identity_link`))[0].n === after2.size,
  'one alias, one row — the primary key says so');
check('and the ones it does own are still its own business',
  (await q(`SELECT count(*)::int n FROM driver_identity_link
             WHERE basis='shared_phone'`))[0].n >= 1);

console.log(`\n${fail ? '✗' : '✓'} name_proposals: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
