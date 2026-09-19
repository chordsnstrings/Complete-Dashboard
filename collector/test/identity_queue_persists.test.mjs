/* THE REVIEW QUEUE EMPTIED ITSELF EVERY OTHER RUN.
   ═══════════════════════════════════════════════════════════════════════════
   MEASURED against one fixture, running refreshIdentityLinks three times:

     run 1   proposed 1, withdrawn 0   queue holds 1
     run 2   proposed 0, withdrawn 1   queue EMPTY
     run 3   proposed 1, withdrawn 0   queue holds 1

   So #same-person showed a reviewer 123 pairs or none depending on which side
   of a collector cycle they happened to open it, and `first_seen_at` reset on
   every other pass. Observed live on 2026-09-19: 123 pending before a deploy,
   0 pending after the restart that followed it.

   THE CAUSE is that `skipPairs` is built from every row in
   driver_identity_link, pending ones included — which is right, since a pair
   already proposed must not be proposed twice. The rules therefore return
   nothing for those pairs, `fresh` is empty, and the `keep` list that the
   withdrawal DELETE spares never mentioned them.

   The comment above that DELETE has always read: "a proposal nobody has
   answered yet is not a link the rule stopped supporting; deleting it every
   run would empty the review queue between passes." The intent was written
   down and the code did the opposite. Both rules report their skipped pairs
   now, and a pair skipped because it is ALREADY PROPOSED is kept.

   A withdrawal that SHOULD happen still does: §2 removes the roster row the
   proposal was built from and the proposal goes with it. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { refreshIdentityLinks } from '../src/identity_link.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const pending = async () => (await q(
  `SELECT count(*)::int n FROM driver_identity_link
    WHERE confirmed_at IS NULL AND NOT rejected`))[0].n;

/* One pair the cross-channel name rule proposes: the same name on two channels. */
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, phone)
         VALUES ('uber','U1','Arthur Moses', NULL), ('bolt','B1','Moses Arthur', NULL)`);

console.log('\na proposal survives every later run until somebody answers it');
await refreshIdentityLinks(db);
const after1 = await pending();
check('the first run proposes the pair', after1 === 1, String(after1));
await refreshIdentityLinks(db);
const after2 = await pending();
/* THE ASSERTION. This came back 0 before the fix. */
check('…and the second run does NOT withdraw it', after2 === 1, `${after2} pending after run 2`);
await refreshIdentityLinks(db);
check('…nor the third', (await pending()) === 1);

/* A human's verdict is what takes it out of the queue, and it must stick. */
await q(`UPDATE driver_identity_link SET rejected = true, rejected_reason = 'two brothers'`);
await refreshIdentityLinks(db);
const rej = await q(`SELECT rejected, rejected_reason FROM driver_identity_link`);
check('a rejection survives a refresh rather than being re-proposed',
  rej.length === 1 && rej[0].rejected === true, JSON.stringify(rej));

/* ── 2. and a proposal the rule really did stop making is still withdrawn ── */
console.log('\na proposal the rule stopped supporting is still withdrawn');
await q(`DELETE FROM driver_identity_link`);
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, phone)
         VALUES ('uber','U2','Nadia Haddad', NULL), ('bolt','B2','Haddad Nadia', NULL)`);
await refreshIdentityLinks(db);
check('the new pair is proposed', (await pending()) >= 1);
/* The roster row goes; the rule can no longer see the pair at all. */
await q(`DELETE FROM driver_compliance WHERE driver_ext_id = 'B2'`);
await q(`DELETE FROM trip WHERE driver_ext_id = 'B2'`);
await refreshIdentityLinks(db);
const left = await q(`SELECT alias_ext_id FROM driver_identity_link WHERE alias_ext_id IN ('U2','B2')`);
check('…and once its roster row is gone, so is the proposal',
  left.length === 0, JSON.stringify(left));

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
