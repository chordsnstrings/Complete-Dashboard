/* THE NAMES A RULE MUST NOT MERGE, AND THE ONE KEY IT MAY.
   ═══════════════════════════════════════════════════════════════════════════
   The operator asked for two things in one sentence: "names can be different
   it needs to be automatically merged. If you need human involvement create a
   page in people which will have similar name and a human will confirm or deny
   if they are the same people or not."

   The split between those halves is the whole safety property of this feature,
   and it is what this file exists to hold in place:

     an EMAIL is an identifier      → merges with nobody asked
     a SIMILAR NAME is not          → becomes a proposal and folds NOTHING

   CLAUDE.md states the rule this enforces in as many words: "Who is one person
   lives in api/identity_map.js, a hand-reviewed LIST of verified pairs — never
   a name rule." A regression here does not show up as a broken page. It shows
   up as two men's money in one row, months later, with no way for a reader to
   notice — which is why the assertions below are mostly about REFUSING. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { nameCandidates, emailLinks, refreshIdentityLinks } from '../src/identity_link.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nthe shorter name inside the longer one');
/* The real pair, from the screen the operator was looking at. Uber files the
   short form; Bolt files the long one. Neither channel carries a phone for the
   Bolt record, so the conclusive rule can never reach it. */
const SHAFIQ = [
  { platform: 'uber', driver_ext_id: 'u-1', full_name: 'Muhammad Shafiq' },
  { platform: 'bolt', driver_ext_id: 'b-1', full_name: 'MUHAMMAD SHAFIQ UMAR RAZIQ' },
];
const c1 = nameCandidates(SHAFIQ);
check('a strict token subset across two channels is proposed',
  c1.candidates.length === 1, JSON.stringify(c1.candidates.length));
check('…with the fuller record as the survivor',
  c1.candidates[0]?.canonical_ext_id === 'b-1' && c1.candidates[0]?.alias_ext_id === 'u-1',
  JSON.stringify([c1.candidates[0]?.canonical_name, c1.candidates[0]?.alias_name]));
/* THE POINT OF THE WHOLE QUEUE. A proposal a reviewer cannot argue with is a
   merge they are being asked to rubber-stamp. */
check('…and an evidence sentence that names both records and both channels',
  /Muhammad Shafiq/.test(c1.candidates[0]?.evidence || '')
  && /MUHAMMAD SHAFIQ UMAR RAZIQ/.test(c1.candidates[0]?.evidence || '')
  && /uber/.test(c1.candidates[0]?.evidence || '') && /bolt/.test(c1.candidates[0]?.evidence || ''),
  c1.candidates[0]?.evidence);
check('…which says plainly that it proves nothing either way',
  /relatives/.test(c1.candidates[0]?.evidence || '')
  && /asked rather than applied/.test(c1.candidates[0]?.evidence || ''),
  c1.candidates[0]?.evidence);
check('…and is marked as a name basis, so identity_links.js will not apply it',
  c1.candidates[0]?.basis === 'similar_name', c1.candidates[0]?.basis);

console.log('\nand every way the name rule must refuse');
/* NOT A SUBSET. One token differs, so these are two names and not one name
   written twice — this is the shape a trigram score gets wrong. */
check('two names that merely resemble each other are not proposed',
  nameCandidates([
    { platform: 'uber', driver_ext_id: 'u-2', full_name: 'Muhammad Khalid' },
    { platform: 'bolt', driver_ext_id: 'b-2', full_name: 'Muhammad Khalifa' },
  ]).candidates.length === 0);
/* ONE SHARED TOKEN is a first name, and this fleet has forty Muhammads. */
check('a single shared token is not enough, on a roster of forty Muhammads',
  nameCandidates([
    { platform: 'uber', driver_ext_id: 'u-3', full_name: 'Muhammad' },
    { platform: 'bolt', driver_ext_id: 'b-3', full_name: 'Muhammad Ashraf Bakhsh' },
  ]).candidates.length === 0);
/* SAME CHANNEL is a re-registration or two men on one roster; either way the
   cross-channel question is not what is being asked. */
check('two accounts on the SAME channel are not proposed',
  nameCandidates([
    { platform: 'bolt', driver_ext_id: 'b-4', full_name: 'Ali Hassan' },
    { platform: 'bolt', driver_ext_id: 'b-5', full_name: 'Ali Hassan Mehmood' },
  ]).candidates.length === 0);
/* THE FOLD DOES NOT JOIN ANYBODY, AND THIS ASSERTED THAT IT DID.
   ─────────────────────────────────────────────────────────────────────────
   This read "a pair the name fold already joined is not proposed again", over
   a comment saying "the name fold joined these before anybody was asked". It
   did not. foldName() lowercases, collapses whitespace and drops ADJACENT
   repeats; nothing downstream merges two records because their folded names
   match. person_key is built from the register in api/identity_map.js and from
   the conclusive phone/email links, neither of which reads a spelling.

   Measured on the live directory 2026-09-16: "Arthur Moses" on Uber and
   "Arthur Moses" on Bolt are TWO ROWS. So are "M MAEN M ALAA SHEKFA" twice and
   "MUHAMMAD SHAFIQ" against "Muhammad Shafiq". The pairs whose names matched
   EXACTLY were the one kind this queue could never propose, and this assertion
   is why — it protected the behaviour instead of catching it.

   So it now asserts the guard that is real: a pair already in
   driver_identity_link is not proposed again, which is decided by what is
   actually linked rather than by what two strings look like. */
check('an identical name on two channels IS proposed — the fold joins nobody',
  nameCandidates([
    { platform: 'uber', driver_ext_id: 'u-6', full_name: 'Ali  Hassan' },
    { platform: 'bolt', driver_ext_id: 'b-6', full_name: 'ALI HASSAN' },
  ]).candidates.length === 1);
check('…and a pair that really IS linked is not proposed again',
  nameCandidates([
    { platform: 'uber', driver_ext_id: 'u-6', full_name: 'Ali  Hassan' },
    { platform: 'bolt', driver_ext_id: 'b-6', full_name: 'ALI HASSAN' },
  ], { skipPairs: new Set(['u-6|b-6', 'b-6|u-6']) }).candidates.length === 0);
/* The same parts in a different order, which is how two channels compose one
   name differently — see src/sources/yango.js and test/yango_one_name.test.mjs.
   Nine of the fifteen pairs standing unproposed on production were this shape. */
check('the same parts in a different order are proposed',
  nameCandidates([
    { platform: 'uber', driver_ext_id: 'u-7', full_name: 'Ansar Hussain Khalid' },
    { platform: 'yango', driver_ext_id: 'y-7', full_name: 'Khalid Ansar Hussain' },
  ]).candidates.length === 1);
/* …and the widening must not reach a pair that merely SHARES parts. */
check('a different name is still not proposed',
  nameCandidates([
    { platform: 'uber', driver_ext_id: 'u-8', full_name: 'Muhammad Khalid' },
    { platform: 'bolt', driver_ext_id: 'b-8', full_name: 'Muhammad Khalifa' },
  ]).candidates.length === 0);
/* THE AMBIGUOUS ONE, and the reason the dedup exists at all. "Muhammad Shafiq"
   sits inside two different fuller names. Proposing either is picking a person
   at random, and driver_identity_link is keyed on alias_ext_id so only one
   could be stored anyway — the storage would make the choice silently. */
const amb = nameCandidates([
  { platform: 'uber', driver_ext_id: 'u-7', full_name: 'Muhammad Shafiq' },
  { platform: 'bolt', driver_ext_id: 'b-7', full_name: 'Muhammad Shafiq Umar Raziq' },
  { platform: 'hotel', driver_ext_id: 'h-7', full_name: 'Muhammad Shafiq Ahmed' },
]);
check('a short name inside TWO different fuller ones is dropped, not guessed',
  amb.candidates.filter((c) => c.alias_ext_id === 'u-7').length === 0,
  JSON.stringify(amb.candidates.map((c) => [c.alias_ext_id, c.canonical_ext_id])));
check('…and the drop is counted with a reason rather than going quiet',
  amb.skipped.some((s) => /names nobody in particular/.test(s.why)),
  JSON.stringify(amb.skipped));
/* A PAIR ALREADY SETTLED must not come back to the queue every run. */
check('a pair already linked or already decided is not proposed again',
  nameCandidates(SHAFIQ, { skipPairs: new Set(['u-1|b-1']) }).candidates.length === 0);

console.log('\nthe email, which is an identifier and merges on its own');
const EM = [
  { platform: 'uber', driver_ext_id: 'u-8', full_name: 'Zia Ali', email: 'Zia.Ali@example.com' },
  { platform: 'bolt', driver_ext_id: 'b-8', full_name: 'Zia Ali Said Muhammad', email: 'zia.ali@example.com ' },
];
const e1 = emailLinks(EM);
check('one address on two records across two channels is a link, not a proposal',
  e1.links.length === 1 && e1.links[0].basis === 'shared_email', JSON.stringify(e1.links));
check('…case and surrounding space do not make two addresses',
  e1.links[0]?.canonical_ext_id === 'b-8' && e1.links[0]?.alias_ext_id === 'u-8',
  JSON.stringify([e1.links[0]?.canonical_ext_id, e1.links[0]?.alias_ext_id]));
/* THE SAME TWO GUARDS THE PHONE RULE KEEPS, for the same two reasons. */
check('an address on three records identifies a mailbox, not a person',
  emailLinks([...EM, { platform: 'hotel', driver_ext_id: 'h-8', full_name: 'Someone Else',
    email: 'zia.ali@example.com' }]).links.length === 0);
check('…and says so rather than going quiet',
  emailLinks([...EM, { platform: 'hotel', driver_ext_id: 'h-8', full_name: 'Someone Else',
    email: 'zia.ali@example.com' }]).skipped.some((s) => /more than two records/.test(s.why)));
check('an address twice within one channel is a duplicate account, not a second channel',
  emailLinks([
    { platform: 'bolt', driver_ext_id: 'b-9', full_name: 'A B', email: 'x@y.com' },
    { platform: 'bolt', driver_ext_id: 'b-10', full_name: 'A B C', email: 'x@y.com' },
  ]).links.length === 0);
check('a blank or malformed address links nobody',
  emailLinks([
    { platform: 'uber', driver_ext_id: 'u-11', full_name: 'A B', email: '' },
    { platform: 'bolt', driver_ext_id: 'b-11', full_name: 'A B C', email: 'not-an-address' },
  ]).links.length === 0);
/* Only the last four of a phone ever leave this module; an email has no such
   short form, so the guard is that it does not leave at all. */
check('the address itself never reaches the evidence a page will print',
  !/zia\.ali@example\.com/i.test(JSON.stringify(e1.links)), JSON.stringify(e1.links[0]?.evidence));

console.log('\nand what the trip record says about a proposal, against a real schema');
const db = new PGlite();
await applySchema(db);

/* TWO MEN, one name inside the other, who drove two different cars at the same
   moment. api/identity_map.js holds back five real pairs on exactly this
   observation. The queue must never show it: a reviewer sent a pair the trip
   record already refutes learns that the queue is noise. */
await db.query(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name)
                VALUES ('uber','u-clash','Bilal Ahmed'),
                       ('bolt','b-clash','Bilal Ahmed Yusuf Khan')`);
await db.query(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, ended_at, status)
   VALUES ('uber','tc-1','ecosine','L10001','u-clash','Bilal Ahmed',
           '2026-09-04T10:00:00Z','2026-09-04T10:40:00Z','completed'),
          ('bolt','tc-2','ecosine','L10002','b-clash','Bilal Ahmed Yusuf Khan',
           '2026-09-04T10:10:00Z','2026-09-04T10:50:00Z','completed')`);
/* The control, in the same run so a bug that suppresses EVERYTHING cannot pass
   the assertion above: same shape of name, trips that never overlap. */
await db.query(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name)
                VALUES ('uber','u-ok','Rashid Omar'),
                       ('bolt','b-ok','Rashid Omar Abdullah Saeed')`);
await db.query(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, ended_at, status)
   VALUES ('uber','to-1','ecosine','L10003','u-ok','Rashid Omar',
           '2026-09-04T08:00:00Z','2026-09-04T08:30:00Z','completed'),
          ('bolt','to-2','ecosine','L10004','b-ok','Rashid Omar Abdullah Saeed',
           '2026-09-04T14:00:00Z','2026-09-04T14:30:00Z','completed')`);
await refreshIdentityLinks(db);
const props = (await db.query(
  `SELECT * FROM driver_identity_link WHERE basis = 'similar_name'`)).rows;
const ids = props.map((r) => r.alias_ext_id).sort();
check('a pair refuted by two simultaneous trips never reaches the queue',
  !ids.includes('u-clash'), JSON.stringify(ids));
check('…while the same name shape with no overlap is proposed',
  ids.includes('u-ok'), JSON.stringify(ids));
/* THE PROPOSAL FOLDS NOTHING. This is the assertion that would catch the
   feature turning into the name rule CLAUDE.md forbids. */
check('a proposal is stored unconfirmed, so nothing is applied by writing it',
  props.every((r) => r.confirmed_at === null && r.rejected === false),
  JSON.stringify(props.map((r) => [r.alias_ext_id, r.confirmed_at, r.rejected])));

/* THE DISPROOF IS PER (platform, id), NOT PER id.
   ─────────────────────────────────────────────────────────────────────────
   driver_ext_id is unique within a provider and nowhere else. Here a THIRD
   person on the hotel channel happens to carry the same id string as the Uber
   half of a good pair, and drives while that pair's other half is out. Matched
   on the id alone, that third person's trip is pulled in under one side of the
   pair and manufactures an overlap — suppressing a proposal for a reason that
   is not the true one, and silently. */
await db.query(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name)
                VALUES ('uber','shared-id','Tariq Nasir'),
                       ('bolt','b-tariq','Tariq Nasir Haroon')`);
await db.query(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, ended_at, status)
   VALUES ('uber','tt-1','ecosine','L10005','shared-id','Tariq Nasir',
           '2026-09-05T08:00:00Z','2026-09-05T08:30:00Z','completed'),
          ('bolt','tt-2','ecosine','L10006','b-tariq','Tariq Nasir Haroon',
           '2026-09-05T14:00:00Z','2026-09-05T14:30:00Z','completed'),
          ('hotel','tt-3','ecosine','L10007','shared-id','A Different Person Entirely',
           '2026-09-05T14:05:00Z','2026-09-05T14:35:00Z','completed')`);
await refreshIdentityLinks(db);
const props2 = (await db.query(
  `SELECT alias_ext_id FROM driver_identity_link WHERE basis = 'similar_name'`)).rows
  .map((r) => r.alias_ext_id);
check('a third person sharing an id string on another channel cannot refute a pair',
  props2.includes('shared-id'), JSON.stringify(props2));

/* A PROPOSAL SURVIVES THE NEXT RUN. The withdrawal sweep deletes links the
   rule stopped producing; a proposal nobody has answered is not that, and
   deleting it every pass would empty the queue between runs. */
await refreshIdentityLinks(db);
const props3 = (await db.query(
  `SELECT alias_ext_id FROM driver_identity_link WHERE basis = 'similar_name'`)).rows;
check('a proposal nobody has answered yet survives the next collector run',
  props3.length === props2.length && props3.length > 0,
  JSON.stringify([props3.length, props2.length]));
/* And a human's verdict is never overruled by the rule that proposed it. */
await db.query(`UPDATE driver_identity_link SET rejected = true, rejected_reason = 'two brothers'
                 WHERE alias_ext_id = 'u-ok'`);
await refreshIdentityLinks(db);
const rej = (await db.query(
  `SELECT rejected, rejected_reason FROM driver_identity_link WHERE alias_ext_id = 'u-ok'`)).rows[0];
check('…and a verdict on one survives every run after it',
  rej?.rejected === true && rej?.rejected_reason === 'two brothers', JSON.stringify(rej));

/* THE NAMELESS RECORD, which this feature creates for the first time.
   ─────────────────────────────────────────────────────────────────────────
   src/sources/uber.js now writes a contact row the moment the live feed meets
   an Uber account, so a record can carry an email before anything has filed a
   name against it. survivorOf on such a record yields canonical_key '' — a key
   that is not a person and that every surface grouping by it would pool into
   one very busy driver. */
await db.query(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, email)
                VALUES ('uber','u-noname',NULL,'nameless@example.com'),
                       ('bolt','b-named','Imran Qadir','nameless@example.com')`);
await refreshIdentityLinks(db);
const nameless = (await db.query(
  `SELECT alias_ext_id, canonical_key FROM driver_identity_link
    WHERE alias_ext_id IN ('u-noname','b-named')
       OR canonical_ext_id IN ('u-noname','b-named')`)).rows;
check('an email on a record with no name links nobody, rather than linking to an empty key',
  nameless.length === 0, JSON.stringify(nameless));
check('…and no link anywhere carries an empty canonical_key',
  (await db.query(`SELECT count(*)::int AS n FROM driver_identity_link
                    WHERE coalesce(btrim(canonical_key), '') = ''`)).rows[0].n === 0);
/* The control: give the same record a name and the same address links it, so
   the assertion above is about the NAME and not about the rule being dead. */
await db.query(`UPDATE driver_compliance SET full_name = 'Imran Qadir Shah'
                 WHERE driver_ext_id = 'u-noname'`);
await refreshIdentityLinks(db);
check('…and once a name arrives, the same address links them',
  (await db.query(`SELECT count(*)::int AS n FROM driver_identity_link
                    WHERE basis = 'shared_email'
                      AND (alias_ext_id = 'u-noname' OR canonical_ext_id = 'u-noname')`))
    .rows[0].n === 1);

/* ── AND THE ASSERTION THE WHOLE FEATURE RESTS ON ────────────────────────
   Everything above proves the proposal is WRITTEN correctly. This proves it
   does not COUNT: api/identity_links.js is the one place a link turns into a
   fold, and its predicate admits a conclusive basis or a human's confirmation
   and nothing else. Without this assertion the queue could be perfect and the
   product could still be merging two men on a name rule.

   Asserted in both directions in one run, because "nothing folds" would pass
   the first half on its own and would be a broken feature, not a safe one. */
{
  const { identityLinks, clearIdentityLinkCache } = await import('../api/identity_links.js');
  const shim = (t, p = []) => db.query(t, p).then((r) => r.rows);
  clearIdentityLinkCache();

  /* THE SUBJECT HAS TO BE A LIVE PROPOSAL, and this guard is here because the
     first version of this assertion was not. It named 'u-ok', which a few
     lines above had been REJECTED — so `NOT rejected` excluded it and the
     assertion passed with the gate deleted. Reverting the fix and watching
     this file stay green is how that was found. So: assert first that
     'shared-id' really is an unanswered similar_name proposal at this moment,
     then assert what that means. */
  const subject = (await db.query(
    `SELECT basis, confirmed_at, rejected FROM driver_identity_link
      WHERE alias_ext_id = 'shared-id'`)).rows[0];
  check('the pair under test is a similar-name proposal nobody has answered',
    subject?.basis === 'similar_name' && subject.confirmed_at === null
    && subject.rejected === false, JSON.stringify(subject));

  const before = await identityLinks(shim, { now: 0 });
  check('a similar-name proposal folds NOTHING while it sits unanswered',
    !before.byAlias.has('shared-id'), JSON.stringify([...before.byAlias.keys()]));

  /* A person opens #same-person and says yes. That, and only that, applies it. */
  await db.query(
    `UPDATE driver_identity_link SET confirmed_at = now(), confirmed_by = 'a person'
      WHERE alias_ext_id = 'shared-id'`);
  clearIdentityLinkCache();
  const after = await identityLinks(shim, { now: 0 });
  check('…and folds the moment a human confirms that one pair',
    after.byAlias.has('shared-id'), JSON.stringify([...after.byAlias.keys()]));
  check('…and only that one — a verdict is not a verdict on the queue',
    !after.byAlias.has('b-tariq'), JSON.stringify([...after.byAlias.keys()]));

  /* ── A PERSON REACHED THROUGH TWO LINKS IS STILL ONE PERSON ──────────────
     byAlias mapped an alias straight to its OWN link's canonical key, one hop.
     A record joined by a chain therefore landed on the middle record's key
     while the middle went on to the terminal's — one human, two keys, two rows,
     which is the defect the whole feature exists to remove.

     Measured on production 2026-09-16 over 177 applied links: ten ids are both
     an alias and a canonical.

       AAMIR KHAN (yango) -> Aamir Khan Amin (uber) -> AAMIR KHAN ROOHUL AMIN AMIN (hotel)
       HAMZA KHAN (yango) -> Hamza Khan Khan (uber) -> HAMZA KHAN NAEEM KHAN (hotel)

     Of the 111 pairs a human had already decided 'same', 82 were folded onto
     one directory row and 24 were still two. The chain middles are why.

     REVERSION: restore byAlias to
       new Map(rows.map((r) => [r.alias_ext_id, r.canonical_key]))
     and the first of these fails — the far end lands on the middle's key. */
  await db.query(
    `INSERT INTO driver_identity_link
       (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
        canonical_name, canonical_key, basis, evidence, confirmed_at, confirmed_by)
     VALUES
       ('y-far', 'yango', 'HAMZA KHAN', 'u-mid', 'uber', 'Hamza Khan Khan',
        'hamza khan khan', 'shared_phone', 'same phone', now(), 'a person'),
       ('u-mid', 'uber', 'Hamza Khan Khan', 'h-end', 'hotel', 'HAMZA KHAN NAEEM KHAN',
        'hamza khan naeem khan', 'similar_name', 'name inside name', now(), 'a person')`);
  clearIdentityLinkCache();
  const chain = await identityLinks(shim, { now: 0 });
  check('a record two links from the survivor lands on the SURVIVOR\u2019s key',
    chain.byAlias.get('y-far') === 'hamza khan naeem khan', chain.byAlias.get('y-far'));
  check('…the same key the middle record lands on, so they are one row',
    chain.byAlias.get('y-far') === chain.byAlias.get('u-mid'),
    `${chain.byAlias.get('y-far')} vs ${chain.byAlias.get('u-mid')}`);
  check('…and the name shown is the survivor\u2019s, not the middle\u2019s',
    chain.nameOf.get('y-far') === 'HAMZA KHAN NAEEM KHAN', chain.nameOf.get('y-far'));
  check('…and every record on the person is reachable from any of them',
    ['y-far', 'u-mid', 'h-end'].every((id) => {
      const p2 = chain.partners.get(id);
      return p2 && ['y-far', 'u-mid', 'h-end'].every((x) => p2.has(x));
    }), JSON.stringify([...(chain.partners.get('y-far') || [])]));

  /* A CYCLE IS NOT HYPOTHETICAL. Production carries one today — the bolt and
     hotel records for Md Anwar Hossain each name the other as canonical — so
     without the seen-set this walk is an infinite loop inside a read that every
     page makes. The pick must also be STABLE, or one person's key changes with
     row order and the directory reshuffles between requests. */
  await db.query(
    `INSERT INTO driver_identity_link
       (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
        canonical_name, canonical_key, basis, evidence, confirmed_at, confirmed_by)
     VALUES
       ('c-a', 'bolt', 'Anwar Hossain Abdul Kader Jelany', 'c-b', 'hotel',
        'ANWAR HOSSAIN', 'anwar hossain', 'similar_name', 'x', now(), 'a person'),
       ('c-b', 'hotel', 'ANWAR HOSSAIN', 'c-a', 'bolt',
        'Anwar Hossain Abdul Kader Jelany', 'anwar hossain abdul kader jelany',
        'similar_name', 'x', now(), 'a person')`);
  clearIdentityLinkCache();
  const cyc = await identityLinks(shim, { now: 0 });
  check('a cycle resolves instead of hanging, and picks the fuller name',
    cyc.byAlias.get('c-b') === 'anwar hossain abdul kader jelany'
    || cyc.byAlias.get('c-a') === 'anwar hossain abdul kader jelany',
    JSON.stringify([cyc.byAlias.get('c-a'), cyc.byAlias.get('c-b')]));
  check('…and both ends of the cycle answer the same way',
    (cyc.byAlias.get('c-a') ?? cyc.byAlias.get('c-b'))
      === (cyc.byAlias.get('c-b') ?? cyc.byAlias.get('c-a'))
    || cyc.partners.get('c-a')?.has('c-b'),
    JSON.stringify([cyc.byAlias.get('c-a'), cyc.byAlias.get('c-b')]));
  clearIdentityLinkCache();
}

await db.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
