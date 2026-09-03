/* ── the merge register: three identities a human verified, and nothing else ──
   ──────────────────────────────────────────────────────────────────────────
   personFold (api/custody_sql.js) decides that two RECORDS are one human from
   the name alone. It collapses case, runs of whitespace and an adjacent
   repeated word — the noise the feeds actually produce — and it must never
   learn to do more than that, because every widening it could learn is a rule
   that will one day fire on two names nobody has looked at.

   That was measured rather than assumed. The one widening that would catch two
   of the three pairs below — sort the folded words, so "Khalil Aliyan" keys the
   same as "Aliyan khalil" — was run over all 395 real names from
   /api/drivers/directory?days=3660 on 2026-09-03. Today it joins exactly the
   two pairs we want and nothing else. That is a fact about today's roster and
   not about the rule: "Gul Muhammad Khalid" and "Muhammad Khalid Gul" are both
   ordinary Dubai names, the fold's own test file pins "Muhammad Khalid Gul" and
   "Muhammad Khalid" apart as two men on two cars, and a rule that merges on
   word order would join the first pair the moment a roster contained it. It
   also cannot see the third pair at all: "Ahmad" against "Ahmed" is a
   transliteration, and any rule loose enough to fold those two folds every
   Ahmad in the fleet into every Ahmed.

   So the merge is not a rule. It is a LIST — this file — of pairs a person
   checked one at a time against production, id to id. It generalises to
   nothing: a name it has not been told about is two people, which is the
   default this product is built to be wrong in the direction of.

   ── what keeps it honest ────────────────────────────────────────────────
   1. Every entry carries the id, the channel, the shared plate and the
      measurement that decided it. An entry with no evidence line does not
      load — assertRegister() below throws at import.
   2. REFUSED lists the pairs that were investigated and came back as two
      people. test/identity_merge.test.mjs asserts none of them is ever joined,
      by this register or by the fold, so a later edit cannot quietly add one.
   3. The register is the ONLY source of the SQL: sql/schema_v53.sql generates
      person_key through identityCase(), and test/identity_merge.test.mjs
      compares the value the database stores against the value this file
      computes, row by row, so the file and the schema cannot drift.

   ── where the merge lands ───────────────────────────────────────────────
   On person_key, which is what every surface in this product already groups
   people by — trips, custody, platform standing, earnings components,
   statements and payouts. The canonical key of all three pairs is the folded
   name of the SURVIVING record, unchanged, so no key in the system moves
   except the alias record's, which moves onto the survivor. The alias record's
   work is then counted with the survivor's rather than beside it. */

/* An id is a provider's, and providers issue three shapes: a dashed UUID
   (Uber, Bolt), a 24-hex ObjectId (hotel), 32 hex without dashes (Yango). The
   register's ids are interpolated into SQL as literals, so the shape is
   enforced rather than trusted. */
const ID = /^[0-9a-f]{24}$|^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/* The fold, in JS, character for character what personFold emits in SQL:
   lowercase, collapse runs of whitespace, trim, collapse an adjacent repeated
   word. Kept here so this module can answer a key without a database — the
   authority remains the SQL, and test/person_key.test.mjs compares them. */
export const foldName = (s) => String(s == null ? '' : s)
  .toLowerCase().replace(/\s+/g, ' ').trim()
  .replace(/(\b\w+)( \1)+/g, '$1');

/* ── the register ────────────────────────────────────────────────────────
   `keep` is the record that survives; `merge` is the record folded into it.
   `key` is the folded name of `keep` and is asserted below to be exactly that,
   so an entry cannot invent a key that belongs to neither record. */
export const MERGES = Object.freeze([
  {
    key: 'aliyan khalil',
    keep:  { id: '5f16534e-68be-451b-b057-3e3d948e868b', name: 'Aliyan khalil', channel: 'uber' },
    merge: { id: '7fc8da91fc4a44c185e8d6d918db3e6b', name: 'Khalil Aliyan',  channel: 'yango' },
    plate: 'L36397',
    verified: '2026-09-03',
    evidence:
      'Different channels (uber vs yango), one plate: every one of the yango '
      + 'record\'s 20 trips is on L36397, which the uber record has held for '
      + '429 days, and on all 10 shared days the plate set is identical. The '
      + 'handover gap discriminates: uber<->yango changes of hands on L36397 '
      + 'have a minimum of 0.9 min and seven under 9 min, against a minimum of '
      + '26.6 min over 28 changes between the uber record and the plate\'s '
      + 'genuine second human (Raja Nouman Ahmed). Five of the eight tightest '
      + 'switches end and restart at the same address — 52 seconds between '
      + '"Index Tower, Gate Avenue" and "Index Tower - Happiness St" on '
      + '2026-09-01. Mechanism: src/sources/yango.js writes one yango id under '
      + 'two word orders (trip.driver_name from o.driver_full_name at line 97, '
      + 'driver_performance.driver_name as `${first_name} ${last_name}` at line '
      + '127); directly observed on the control account 69f7e655… whose stored '
      + 'person_key and displayed name are the same two names reversed. '
      + 'Production /api/driver/profile?id=5f16534e… already returns both ids.',
    caveat:
      '5 of the 20 yango trips sit nearer the co-driver\'s shift than the '
      + 'survivor\'s (nearest-neighbour: 15 to the survivor, 5 to Raja). That '
      + 'bounds attribution — 20 trips of 3,970, 274 km of 55,771 — not identity.',
  },
  {
    key: 'moses arthur',
    keep:  { id: '9d396a20-454b-4a7e-91ae-9de8f9aa8942', name: 'Moses Arthur', channel: 'uber' },
    merge: { id: 'ab2aec60-56ff-48e2-85c0-3591f6f29aa3', name: 'Arthur Moses', channel: 'bolt' },
    plate: 'L10595',
    verified: '2026-09-03',
    evidence:
      'Not two Uber records — bolt and uber both issue dashed UUIDs. '
      + '/api/driver/profile?id=ab2aec60… returns platforms ["bolt"], one '
      + 'standing row, state "deactivated by fleet", can_earn false, plate '
      + 'L10595. Bolt files no trips at all: /api/drivers/directory?platform='
      + 'bolt returns 70 rows summing to 0 trips, and /api/segments lists the '
      + 'trip channels as hotel,uber,yango. So the zero is a property of the '
      + 'feed, not of a person. The fleet\'s ordinary one-human shape is '
      + 'exactly this: of the 11 bolt-standing people with any driving history, '
      + '10 hold an Uber id carrying the trips and a separate Bolt id carrying '
      + 'the standing, and all 9 that name a plate name one that same human '
      + 'drove on Uber. The uber record drove L10595 for 37 days and 297 trips '
      + 'to 2026-02-25, its last trip ever; of 35 plates in the bolt roster '
      + 'only this account is pinned to L10595.',
    caveat:
      'driver_platform_state is a one-week snapshot (oldest observation '
      + '2026-08-26), so the L10595 pin cannot be dated against the Jan-Feb '
      + 'custody. No licence exists on either side to compare: neither id '
      + 'appears in the 132 rows of /api/compliance/drivers.',
  },
  {
    key: 'shehzad ahmad ghulam muhammad',
    keep:  { id: 'f6253b6e-fca4-41cf-99c1-6c2f3e2e67b2', name: 'Shehzad Ahmad Ghulam Muhammad', channel: 'uber' },
    merge: { id: '67483c64055e070d7910010a',            name: 'Shehzad Ahmed Ghulam Muhammad', channel: 'hotel' },
    plate: 'L46208',
    verified: '2026-09-03',
    evidence:
      'Uber UUID against a hotel ObjectId — the filed-twice shape, not two '
      + 'records on one channel. The hotel record\'s entire existence is one '
      + 'vehicle, L46208, 8 days and 8 trips between 2026-08-06 and 2026-08-30, '
      + 'inside the uber record\'s 33-day custody of that same plate '
      + '(2026-07-29..2026-09-01), which is also its current standing plate. '
      + 'Not one of the 8 hotel bookings starts inside any of the uber '
      + 'record\'s 1,782 trips. The one tight coupling is continuous rather '
      + 'than a handover: 2026-08-21, hotel drops at "11 - 9 12B St - Al Raffa" '
      + 'and the next uber trip starts 7m38s later at "Smana Hotel Al Raffa '
      + '37th St". All 8 hotel bookings land in the Bur Dubai cluster that is '
      + 'the uber record\'s top territory (Al Raffa 237 pickups over 306 days). '
      + 'The channel does this systematically: of the 30 hotel ObjectIds with '
      + 'trips, 27 have a >=2-token Uber name-twin and 14 sit on that twin\'s '
      + 'plate.',
    caveat:
      'The licence test is unavailable, not passed. The uber record has no '
      + 'compliance row at all; the hotel row carries licence 123456 and expiry '
      + '2026-01-01, the placeholder 94 of 94 dated rows carry. Naive interval '
      + 'arithmetic on hotel ended_at "finds" 5 overlaps and all are artefacts '
      + '— ended_at is a booking close (7.18 km in 49 seconds on 2026-08-06) '
      + 'and duration_s is null on all 8 rows.',
  },
]);

/* ── the pairs that came back as TWO people ──────────────────────────────
   Here so the guard can name them. A merge that would join any of these is a
   bug in the register, and the test says so rather than the reviewer noticing.
   Two of the three are pinned elsewhere as well — test/roster_twin.test.mjs
   holds the Khalid pair apart at the UI rule — and the duplication is the
   point: this list is about ids, that one is about names. */
export const REFUSED = Object.freeze([
  {
    a: { id: 'd9b2de76-b535-4b23-a714-7e31724e50d2', name: 'Muhammad Naeem Khan', plate: 'L46201' },
    b: { id: 'd31e25fa-dc28-424c-a6e5-c2cbcf516870', name: 'Mohammad Naeem Khan', plate: 'L46172' },
    why: '241 simultaneous trips in two different cars across 70 days; zero '
       + 'shared plates over 303 driver-days; both Uber, both active the same weeks.',
  },
  {
    a: { id: '4d4eb2c1-f64c-48c2-8167-32d887cecfd2', name: 'Muhammad Khalid Gul', plate: 'L94178' },
    b: { id: '76ede4ae-768b-4126-804b-0b5c88043682', name: 'Muhammad Khalid',     plate: 'L90721' },
    why: '77 simultaneous trips on two plates; both Uber, both active since '
       + '2025-04-05. Pinned at the UI rule by test/roster_twin.test.mjs too.',
  },
  {
    a: { id: 'b7511fa7-cbdf-4373-8539-c7ae020c31e2', name: 'Sanaullah Sher Zamin',  plate: 'L20048' },
    b: { id: '67483c64055e070d79100114',            name: 'Sana Ullah Sher Zamin', plate: null },
    why: 'UNDECIDABLE, which is not a merge. The hotel record has 0 trips, 0 '
       + 'custody rows and 0 money, so no shared vehicle-day and no simultaneity '
       + 'can be measured either way; the only identifier on it (Emirates ID '
       + '784-2000-3168092-7) has no counterpart to compare. "Sher Zamin" is a '
       + 'patronymic and two brothers would file identically. Settled by a phone '
       + 'call, not by this file.',
  },
]);

/* ── the guard, run at import ─────────────────────────────────────────────
   A register that loads a malformed entry is a register nobody re-reads. */
function assertRegister() {
  const seen = new Map();
  for (const m of MERGES) {
    const where = `${m.keep?.name} / ${m.merge?.name}`;
    if (!ID.test(m.keep?.id || '')) throw new Error(`identity_map: bad keep id for ${where}`);
    if (!ID.test(m.merge?.id || '')) throw new Error(`identity_map: bad merge id for ${where}`);
    if (m.keep.id === m.merge.id) throw new Error(`identity_map: ${where} merges a record into itself`);
    if (m.key !== foldName(m.keep.name)) {
      throw new Error(`identity_map: ${where} claims key ${JSON.stringify(m.key)}, `
        + `but the surviving record folds to ${JSON.stringify(foldName(m.keep.name))}`);
    }
    /* An identity nobody wrote down the reason for is an identity nobody can
       check later, and this list is exactly the thing a later reader has to be
       able to check. */
    if (!m.evidence || m.evidence.length < 120) throw new Error(`identity_map: ${where} has no evidence`);
    if (!m.verified) throw new Error(`identity_map: ${where} has no verification date`);
    for (const id of [m.keep.id, m.merge.id]) {
      if (seen.has(id)) throw new Error(`identity_map: ${id} appears twice (${seen.get(id)} and ${where})`);
      seen.set(id, where);
    }
  }
  /* A chain — A merged into B, B merged into C — would make the answer depend
     on the order the CASE is written in. Flat, or it does not load. */
  for (const m of MERGES) {
    if (MERGES.some((o) => o.merge.id === m.keep.id)) {
      throw new Error(`identity_map: ${m.keep.id} is both kept and merged — the register must be flat`);
    }
  }
  const refused = new Set(REFUSED.flatMap((r) => [r.a.id, r.b.id]));
  for (const id of seen.keys()) {
    if (refused.has(id)) throw new Error(`identity_map: ${id} is in both MERGES and REFUSED`);
  }
}
assertRegister();

/** alias id → the person key it resolves to. Empty for every other id. */
export const ALIAS_KEY = Object.freeze(new Map(MERGES.map((m) => [m.merge.id, m.key])));

/** Both ids of a pair, given either of them; just the id given, otherwise. */
export function mergedIds(id) {
  const m = MERGES.find((x) => x.keep.id === id || x.merge.id === id);
  return m ? [m.keep.id, m.merge.id] : [id];
}

/** The name the merged person is filed under — the surviving record's. */
export function canonicalName(id) {
  const m = MERGES.find((x) => x.keep.id === id || x.merge.id === id);
  return m ? m.keep.name : null;
}

/** Both spellings of a merged person, so a driver page can match rows filed
    under either. Empty for an id the register has never been told about. */
export function mergedNames(id) {
  const m = MERGES.find((x) => x.keep.id === id || x.merge.id === id);
  return m ? [m.keep.name, m.merge.name] : [];
}

/** The channels the pair's two records live on. The Bolt record in the
    register holds no trip and no compliance row — only a platform standing —
    so a page that derives the channel list from measured work alone would drop
    the very fact the merge exists to surface (an account the fleet
    deactivated). */
export function mergedPlatforms(id) {
  const m = MERGES.find((x) => x.keep.id === id || x.merge.id === id);
  return m ? [m.keep.channel, m.merge.channel] : [];
}

/** The person key for one record, in JS: the register first, then the fold. */
export const personOf = (id, name) => ALIAS_KEY.get(id) || foldName(name) || null;

/* ── the SQL ─────────────────────────────────────────────────────────────
   One emitter, used by api/custody_sql.js for the computed key and quoted
   into sql/schema_v53.sql for the stored one, so the two cannot disagree
   about who a person is. Ids are validated above and the keys are folded
   names — lowercase letters, digits and single spaces — but both are escaped
   anyway: a literal built by concatenation is a literal somebody will later
   build from something else. */
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** `fallback`, except for the ids in the register, which answer their person. */
export const identityCase = (idCol, fallback) =>
  `CASE ${idCol}\n`
  + MERGES.map((m) => `         WHEN ${lit(m.merge.id)} THEN ${lit(m.key)}`).join('\n')
  + `\n         ELSE ${fallback} END`;

/** The register as a comment block, so the schema file carries its own reasons. */
export const registerComment = () => MERGES.map((m) =>
  `-- ${m.merge.id} (${m.merge.channel} "${m.merge.name}")\n`
  + `--   -> ${m.keep.id} (${m.keep.channel} "${m.keep.name}") = ${lit(m.key)}\n`
  + `--   verified ${m.verified} on plate ${m.plate}`).join('\n');
