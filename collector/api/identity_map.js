/* ── the merge register: identities a human verified, one pair at a time ─────
   ──────────────────────────────────────────────────────────────────────────
   Two lists live here. MERGES is APPLIED: three pairs the database already
   folds, because sql/schema_v53.sql is generated from it and stores the answer
   in person_key. PENDING is VERIFIED BUT NOT APPLIED: fifty more pairs
   measured the same way on 2026-09-05, held out of the SQL until the migration
   that can rebuild the stored column exists. The long comment above PENDING
   says what was measured, where the line was drawn, and what promotes it.

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

/* An id is a provider's, and providers issue FOUR shapes, not the three this
   comment used to name.
   ─────────────────────────────────────────────────────────────────────────
   The fourth is a plain decimal numeral, and it is the commonest id the Bolt
   feed writes: of the 672 distinct driver ids on production's roster today
   (/api/drivers/directory, every row's `ids`, read 2026-09-05) 304 are dashed
   UUIDs, 224 are seven-digit numerals, 132 are 24-hex ObjectIds and 12 are 32
   hex without dashes. Every one of the 224 numerals belongs to a record whose
   trips are Bolt's — 8361571, 6598721, 7416305 — and they run from 6585207 to
   9593757, so a Bolt id is a counter and not a hash.

   The old pattern accepted none of them, and assertRegister() below runs at
   IMPORT: the first Bolt id written into either list would have thrown while
   api/identity_map.js was still loading, taking down every route that imports
   it rather than failing a test. Since fifty of the fifty-three pairs in this
   file have a Bolt numeral on the alias side, that was the first thing in the
   way. The width is deliberate — four to twelve digits, because 8361571 is
   seven today and a counter that reaches eight digits is not a new id shape —
   and it is still a shape rather than a promise: the register's ids are
   interpolated into SQL as literals, so what is not one of these four does not
   load. */
const ID = /^[0-9]{4,12}$|^[0-9a-f]{24}$|^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/* ── fifty more pairs: one man filed twice, verified and NOT YET APPLIED ─────
   ──────────────────────────────────────────────────────────────────────────
   The defect, in the numbers this product prints. Measured on production
   2026-09-05: /api/kpis?from=2026-08-07&to=2026-09-05 answers drivers 173 and
   drivers_seen 173, /api/roster answers totals.working 173, and
   /api/drivers/directory returns exactly 173 rows carrying a trip in that
   window. Fifty of those rows are a second account belonging to a man the same
   list already holds, so the headcount on the Overview band is 173 where the
   people are 123 — two fifths too many. /api/drivers/cross-platform, the one
   endpoint whose job is to notice a person on two platforms, is defeated by
   the same thing, because it groups by person_key and person_key is the folded
   name.

   It shows up on a man's own page, which is where it costs something. Rashid
   Iqbal drove 243 trips for AED 11,911 on the Uber record 5cf88be8… in that
   window and 13 more for AED 898 on the Bolt record 7842555; his page shows
   one of those two and files the other under a name one word longer. Across
   these fifty pairs the alias records carry 507 trips and AED 18,271 of fares
   in that window, filed beside the man who earned them rather than with him.

   ── the shape, and why the name fold must not learn it ───────────────────
   Bolt and the hotel channel file a man's whole chain — his own name, his
   father's, his grandfather's — where Uber files the short form he signed up
   with. "Rashid Iqbal Muhammad" on Uber is "Rashid Iqbal Dost Muhammad" on
   Bolt; "Asad Khan" is "Asad Khan Hakim Khan"; "Bakht Zada Sharif" is "Bakht
   Zada Bakht Sharif". A rule wide enough to join a name to a longer name that
   contains it is wide enough to join a father to his son, and this roster has
   exactly that: "Muhammad Khalid" against "Muhammad Khalid Younas Gul" fits
   the shape perfectly and is two men on two cars. So personFold stays the name
   rule it is, and this stays a list of ids.

   ── what was measured, on all 173 working records ────────────────────────
   Every pair of records was put through four tests, and a pair is on this list
   only if it passed all four.

   FIRST, the two records file trips on channels that do not overlap. All fifty
   are cross-channel; not one same-channel pair survives, which is what one
   would expect of a man who signed up twice on two apps rather than twice on
   one.

   SECOND, the name shape: the shorter name is an ordered subsequence of the
   longer with at least two tokens matching exactly and at most one token
   differing by a single character, so "Ijaz Ahmed Khan" reaches "Ijaz Ahmad
   Ashiq Khan" and nothing reaches a name that merely shares a word.

   THIRD, they were in the same car on the same day, and on at least one of
   those days the two accounts' trips INTERLEAVE inside the day on that plate
   rather than following one another.

   FOURTH — and this is the one that does the work — no day has the two records
   working a shift in DIFFERENT cars at overlapping times.

   The fourth test is the whole safety property, and the third one on its own
   is not enough. That was measured rather than assumed. "Aliyan khalil" and
   "Raja Nouman Ahmed" are two different men on one car, and this file's own
   first entry rests on them being different: they interleave on L36397 on 145
   separate days, which is more same-car interleaving than 47 of the fifty
   pairs below have. What separates them is that on 54
   further days they were driving different cars at overlapping times, which
   one man cannot do. Run over the 65 pairs the name shape proposes, the fourth
   test is what refuses "Muhammad Khalid" against "Muhammad Khalid Gul" (117
   days in two cars at once), against "Muhammad Khalifa Afzal Khalid" (21) and
   against "Muhammad Khalid Younas Gul" (15).

   ── where the line was drawn, and why there ──────────────────────────────
   The name shape proposes 65 pairs. Fifty are here. The fifteen that are not:

     - eleven where the two records worked a SHIFT in two different cars at
       overlapping times on at least one day — two or more trips spread over
       hours, which is a day's work and not a stray row. Muhammad Khalid
       against Muhammad Khalid Gul (117 such shift days), against Muhammad
       Khalifa Afzal Khalid (16) and against Muhammad Khalid Younas Gul (6); Siyad
       Kallyanathoppil Paramba Razak (12); Muhammad Naqeeb Nasir Gull (5);
       Muhammad Asif Amir Zada (2); and one day each for Zubair Khan Shaukat
       Ali, Zeeshan Ahmed Wazeer Ur Rahman, Muhammad Ali Maqsood Ahmad Tariq
       Bajwa, Hassan Munawar Ahmed Shaad and Saddam Hussain Muhammad Islam.
     - two where every contradiction is a single trip but there are too many of
       them to read as stray rows: Umer Naveed Abdul Qadir, 3 over 78 shared
       days, and Edwin Nyasani Mandere, 1 over 31.
     - "Umair Ahmad" on Bolt against "Umair Ahmad Gul" on Uber, which meets
       every test except weight: the two records were in one car on 4 of the
       Bolt record's 44 working days and only 5 of its 77 trips are on a plate
       the Uber record ever held. That is not the shape of one man with two
       apps; it is two men who once shared a car.
     - and the Bolt record of Md Anwar Hossain against the hotel record of the
       same name, which never shared a day with it. Nothing is lost by that
       one: both fold onto the Uber record "Md Anwar Jelany" on their own
       evidence, so the man is whole either way.

   Where a contradiction survived on a pair that IS here, it is a single trip —
   five pairs and six days in all, each one trip on another plate inside the
   surviving record's own working span. A single trip is one feed row's vehicle
   field; a shift is a man's day. The three the audit asked about by name are
   in that group and were read row by row: fahad ali on 2026-08-21 (Uber L12615
   04:29→14:27, a Bolt trip on the same L12615 at 11:51, and one hotel booking
   on L12617 at 12:35, 44 minutes after it — sequential, not simultaneous);
   hammad ahmad on 2026-08-28 (Uber L39416 then L44259 15:22→18:27, a Bolt trip
   on that same L44259 at 18:26, and a hotel booking on L44284 at 00:39 Dubai
   before the shift began); soaieed alom on 2026-08-25 (Uber L46185 all day,
   hotel and Bolt rows on that same L46185 inside it, and one hotel booking on
   L45255 at 23:28 Dubai, 41 minutes after his last Uber trip). None of the
   three is two men in two cars at once; all three are one man whose last or
   first job of the day is filed against the fleet's other car.

   ── the cost of getting one wrong ────────────────────────────────────────
   Folding two men into one is worse than leaving one man in two rows, because
   the page names him: his trips, his earnings and his safety events are then
   shown as somebody else's. That is why the list is a list, why the fourth
   test refuses fifteen pairs the shape proposed, and why the guard below
   re-checks the figures every entry carries at import rather than trusting
   that they were checked once.

   ── why these fifty are NOT applied ──────────────────────────────────────
   person_key is a GENERATED ALWAYS column and sql/schema_v53.sql builds its
   expression from MERGES above. Everything that counts people from the stored
   column — /api/kpis is one — would keep answering 173 while everything that
   computes the fold per row through personKey() answered 123, and a product
   that contradicts itself across two pages is worse than one that is honestly
   wrong on both. So identityCase() below still emits MERGES and only MERGES,
   the stored column and the computed key still agree, and these fifty change
   nothing until one of two things lands, neither of them in this file:

     - a new numbered migration that rebuilds person_key from MERGES.concat(
       PENDING) the way sql/schema_v53.sql rebuilt it from MERGES, registered
       in src/schema_files.js; or
     - personKeyStored() in api/custody_sql.js wrapping the stored column in
       identityCase(), which needs no migration at all and is where the two
       paths would stop being able to disagree.

   Until then the roster twin note is the only thing on any page that tells an
   operator two rows might be one man, and api/public/roster.js:210 gives a
   twin only to a record that has produced nothing — `twin: hasDriven(r) ? null
   : twinFor(r, drove)`. Every one of these fifty pairs is two records that
   BOTH drove in the window, so not one of them carries a note. That gate is in
   a file this change does not own. */

/* ── the entry, and the sentence it carries ──────────────────────────────
   The three applied entries above each carry a paragraph a person wrote after
   reading production for that pair. Fifty paragraphs would be fifty chances to
   paste the wrong number into the one place a later reader trusts, so a
   pending entry carries the FIGURES instead and the sentence is composed from
   them here, once. Nothing in the text is free prose: every number in it is a
   field of the entry beside it, and the guard below re-checks the fields.

   The branches matter as much as the numbers. A sentence that reads "no day
   has the two records in different cars at overlapping times" is true of the
   forty-five clean pairs and FALSE of the five that carry a single-trip day,
   so those five say what they carry and where. Same for the trips: "every one
   of the alias record's trips" is true of thirty-eight of the fifty and not of
   the other twelve, which name the shortfall instead. */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const evidenceFor = (m) => {
  const cars = m.plates.length === 1
    ? `one car, ${m.plates[0]}`
    : `${m.plates.length} cars — ${m.plates.join(', ')} — which they moved between together`;
  const trips = m.trips.onSharedCars === m.trips.alias
    ? `Every one of the alias record's ${m.trips.alias} trips is on a plate the surviving record also held.`
    : `${m.trips.onSharedCars} of the alias record's ${m.trips.alias} trips are on plates the surviving `
      + 'record also held; the rest are on cars it never shared, which bounds how much of this person\'s '
      + 'work the merge moves, not whether the two records are him.';
  const clash = m.contradictions.length === 0
    ? 'No day has the two records in different cars at overlapping times — the test that tells two men '
      + 'sharing a car from one man running two accounts, and it is clean on this pair.'
    : `${plural(m.contradictions.length, 'day', 'days')} — ${m.contradictions.join(', ')} — carries a single `
      + 'alias trip on another plate inside the surviving record\'s own working span. One trip is one feed '
      + 'row\'s vehicle field; what would say two men is a SHIFT in another car, two trips or more spread '
      + 'over hours while the other record worked, and this pair has no such day.';
  return `The channels they file trips on do not overlap — ${m.keep.channel} against ${m.merge.channel} — `
    + `so this is not two records on one feed. They were on the same plate on ${m.days.shared} of the alias `
    + `record's ${m.days.alias} working days, on ${cars}, and on ${m.days.interleaved} of those days the two `
    + 'accounts\' trips interleave inside the day on that plate rather than following one another, which is '
    + `one man with two apps open and not a handover. ${trips} ${clash}`;
};

/* What the evidence above is NOT. Stated per entry rather than once at the top
   of the list, because a reader who opens one entry to check a name reads that
   entry and not the list's header. */
const caveatFor = (m) => (m.days.shared < 10
  ? `Thin: the two records were in one car on ${plural(m.days.shared, 'day', 'days')}, so what is above is `
    + 'the whole of the evidence rather than a sample of it. '
  : '')
  + 'The identity documents were not used: no licence number and no Emirates ID was compared on any pair '
  + 'in this list, so nothing here rests on them. The custody underneath is a day, a plate and a channel '
  + 'per record with a first and a last trip time, so two accounts inside one day are read at that grain '
  + 'and not trip by trip, and the plate on a row is what the feed put there.';

const pending = (m) => Object.freeze({
  ...m, verified: '2026-09-05', evidence: evidenceFor(m), caveat: caveatFor(m),
});

/* ── the fifty, busiest shared history first ─────────────────────────────
   `keep` is the record that survives and `merge` is the record folded into it,
   as above — except that `merge` carries ids, plural, because an alias is
   often two provider records already: a Bolt numeral and the hotel ObjectId
   filed under the same long name. Mapping one of them and not the other would split the
   man a third way rather than a second. `channel` on each side is the channels
   that record files TRIPS on; an id in the list may belong to a record of
   another channel that has filed none. */
export const PENDING = Object.freeze([
  pending({
    key: 'shehzad ahmad ghulam muhammad',
    keep:  { id: 'f6253b6e-fca4-41cf-99c1-6c2f3e2e67b2', name: 'Shehzad Ahmad Ghulam Muhammad', channel: 'uber,hotel' },
    merge: { ids: ['6612891'],
             name: 'Shehzad Ahmed Ghulam Muhammad', channel: 'bolt' },
    plates: ['L36561', 'L39421', 'L40948', 'L41452', 'L46208', 'L76092', 'L96768'],
    days: { shared: 309, interleaved: 309, alias: 361, keep: 309 },
    trips: { alias: 2108, onSharedCars: 2012 },
    contradictions: [],
  }),
  pending({
    key: 'aliyan khalil',
    keep:  { id: '5f16534e-68be-451b-b057-3e3d948e868b', name: 'Aliyan khalil', channel: 'uber,yango' },
    merge: { ids: ['6598721', '67483c64055e070d791000d2'],
             name: 'Raja Aliyan Khalil Raja Khalil Ahmed', channel: 'bolt' },
    plates: ['L36397', 'L40561', 'L46174'],
    days: { shared: 192, interleaved: 163, alias: 265, keep: 431 },
    trips: { alias: 512, onSharedCars: 368 },
    contradictions: [],
  }),
  pending({
    key: 'mohammed hasan chowdhury',
    keep:  { id: '455ab44a-21b8-4dfe-9cc7-de929e10adea', name: 'Mohammed Hasan Chowdhury', channel: 'uber' },
    merge: { ids: ['6611093', 'f09cb675-9984-4546-b109-1b141e8467be'],
             name: 'Mohammed Hasan Tarek Chowdhury Anwar Hossain Chowdhury', channel: 'bolt' },
    plates: ['L19312', 'L55132', 'L60853'],
    days: { shared: 185, interleaved: 136, alias: 225, keep: 403 },
    trips: { alias: 473, onSharedCars: 473 },
    contradictions: [],
  }),
  pending({
    key: 'bakht zada sharif',
    keep:  { id: 'a4d29a55-9597-4a51-b5a1-19e449f239b6', name: 'Bakht Zada Sharif', channel: 'uber' },
    merge: { ids: ['7416305', '6a423abb13880329d04e1999'],
             name: 'Bakht Zada Bakht Sharif', channel: 'bolt,hotel' },
    plates: ['L36395', 'L78469'],
    days: { shared: 183, interleaved: 163, alias: 183, keep: 407 },
    trips: { alias: 333, onSharedCars: 333 },
    contradictions: [],
  }),
  pending({
    key: 'soaieed alom ali',
    keep:  { id: 'fb7c2c86-4ba0-41d6-b73f-6e9dd77b08ff', name: 'Soaieed Alom Ali', channel: 'uber' },
    merge: { ids: ['67483c64055e070d791000cf', '6639200'],
             name: 'SOAIEED ALOM MIHIN JINNAT ALI', channel: 'hotel,bolt' },
    plates: ['L44251', 'L46183', 'L46185', 'L78485', 'L82907'],
    days: { shared: 175, interleaved: 129, alias: 238, keep: 444 },
    trips: { alias: 420, onSharedCars: 311 },
    contradictions: ['2025-05-03'],
  }),
  pending({
    key: 'ali abbas ahmed',
    keep:  { id: '9e9060e7-0b8c-4f3b-8cd7-165d5eac55cd', name: 'Ali Abbas Ahmed', channel: 'uber' },
    merge: { ids: ['6623821', 'b17bcd50-e20b-4055-80d8-468131188397'],
             name: 'Ali Abbas Faiz Ahmed', channel: 'bolt' },
    plates: ['L36125', 'L58905', 'L85082'],
    days: { shared: 173, interleaved: 144, alias: 239, keep: 381 },
    trips: { alias: 520, onSharedCars: 520 },
    contradictions: ['2025-08-31'],
  }),
  pending({
    key: 'shah khalid ul haq',
    keep:  { id: 'b226df8e-d251-47ce-9654-a86e009cfbf0', name: 'Shah Khalid Ul Haq', channel: 'uber' },
    merge: { ids: ['689df8813c9838d4b3a6d590', '7749606'],
             name: 'Shah Khalid Fayaz Ul Haq', channel: 'hotel,bolt' },
    plates: ['L44295', 'L45255'],
    days: { shared: 160, interleaved: 121, alias: 163, keep: 280 },
    trips: { alias: 425, onSharedCars: 425 },
    contradictions: [],
  }),
  pending({
    key: 'hamza rizwan ahmed',
    keep:  { id: 'aeedc098-28fa-4d66-9c93-10a5d5cb34e8', name: 'Hamza Rizwan Ahmed', channel: 'uber' },
    merge: { ids: ['6623671', '67483c64055e070d791000d1'],
             name: 'Hamza Rizwan Tanveer Ahmed', channel: 'bolt,hotel' },
    plates: ['L39421', 'L45227', 'L46173', 'L93342', 'L96093'],
    days: { shared: 152, interleaved: 127, alias: 227, keep: 339 },
    trips: { alias: 501, onSharedCars: 394 },
    contradictions: [],
  }),
  pending({
    key: 'muhammad ashraf bakhsh',
    keep:  { id: 'f162cd70-310a-475a-b21f-55a7eafffaf4', name: 'Muhammad Ashraf Bakhsh', channel: 'uber' },
    merge: { ids: ['6615869', '67483c64055e070d79100119'],
             name: 'Muhammad Ashraf Ellahi Bakhsh', channel: 'bolt' },
    plates: ['L36397', 'L45240', 'L46162', 'L64921', 'L78462'],
    days: { shared: 143, interleaved: 120, alias: 203, keep: 268 },
    trips: { alias: 619, onSharedCars: 562 },
    contradictions: [],
  }),
  pending({
    key: 'rashid iqbal muhammad',
    keep:  { id: '5cf88be8-3b56-4b31-9174-6d4dc0c12cae', name: 'Rashid Iqbal Muhammad', channel: 'uber' },
    merge: { ids: ['7842555', '6429fe4e-efae-43c8-94a2-09088d22993d'],
             name: 'Rashid Iqbal Dost Muhammad', channel: 'bolt' },
    plates: ['L36485'],
    days: { shared: 140, interleaved: 121, alias: 141, keep: 337 },
    trips: { alias: 214, onSharedCars: 214 },
    contradictions: [],
  }),
  pending({
    key: 'atif khan',
    keep:  { id: '8010cb10-421a-498a-bad4-236c1731d887', name: 'Atif Khan Khan', channel: 'uber' },
    merge: { ids: ['7196091', '67483c64055e070d7910011b'],
             name: 'Atif Khan Karim Khan', channel: 'bolt' },
    plates: ['L41443', 'L44305', 'L45199', 'L45235', 'L64921'],
    days: { shared: 136, interleaved: 95, alias: 138, keep: 344 },
    trips: { alias: 191, onSharedCars: 191 },
    contradictions: [],
  }),
  pending({
    key: 'tariq afzal',
    keep:  { id: '7e96cb47-f2d4-4f96-9019-0ee79eb0117d', name: 'Tariq Afzal Afzal', channel: 'uber' },
    merge: { ids: ['69f7e655aab1412c83a9c6d4d58aa122', '7308211'],
             name: 'Tariq Afzal Said Afzal', channel: 'yango,bolt' },
    plates: ['L37810', 'L46174'],
    days: { shared: 133, interleaved: 105, alias: 134, keep: 411 },
    trips: { alias: 176, onSharedCars: 176 },
    contradictions: ['2026-06-10'],
  }),
  pending({
    key: 'fayed ali muhammad',
    keep:  { id: 'cb5359cf-9f1f-4fcc-aee7-f79e892e78c7', name: 'Fayed Ali Muhammad', channel: 'uber' },
    merge: { ids: ['6780293', '2a1d4e30-e10f-4f47-a610-faae8c94d125'],
             name: 'Fayed Ali Taj Muhammad', channel: 'bolt' },
    plates: ['L36125', 'L52144', 'L54118', 'L55132'],
    days: { shared: 133, interleaved: 125, alias: 166, keep: 267 },
    trips: { alias: 481, onSharedCars: 481 },
    contradictions: ['2025-12-21', '2025-12-23'],
  }),
  pending({
    key: 'mohammed selim shafiqur rahman',
    keep:  { id: '0a6eb545-aa3b-4441-882c-34204df3d451', name: 'Mohammed Selim Shafiqur Rahman', channel: 'uber' },
    merge: { ids: ['6585207', '936e2fba-63a9-4d3e-9b93-0368e028e0fb'],
             name: 'Mohammed Selim Miah Shafiqur Rahman', channel: 'bolt' },
    plates: ['L19261', 'L19312', 'L19314', 'L55132', 'L59829', 'L63271'],
    days: { shared: 132, interleaved: 121, alias: 186, keep: 342 },
    trips: { alias: 357, onSharedCars: 357 },
    contradictions: [],
  }),
  pending({
    key: 'noor zaman shah',
    keep:  { id: '2e513517-3ba0-48e8-9349-3885724c4505', name: 'Noor Zaman Shah', channel: 'uber' },
    merge: { ids: ['6781868', '67483c64055e070d7910011f'],
             name: 'Noor Zaman Qaam Shah', channel: 'bolt,hotel' },
    plates: ['L36561', 'L41443', 'L75104', 'L76099', 'L77062', 'L95161'],
    days: { shared: 125, interleaved: 108, alias: 154, keep: 356 },
    trips: { alias: 292, onSharedCars: 238 },
    contradictions: [],
  }),
  pending({
    key: 'nalini chakrapani',
    keep:  { id: 'e5ab224b-734b-42db-9163-fbe11b70517c', name: 'Nalini Chakrapani Chakrapani', channel: 'uber' },
    merge: { ids: ['6611156', 'c89b7bc2-e3ff-468f-b84a-f258628d4edc'],
             name: 'Nalini Chakrapani Giri Chakrapani', channel: 'bolt' },
    plates: ['L59829', 'L61758'],
    days: { shared: 120, interleaved: 106, alias: 188, keep: 470 },
    trips: { alias: 379, onSharedCars: 379 },
    contradictions: [],
  }),
  pending({
    key: 'muhammad mussa jhang',
    keep:  { id: '5e51b1a2-815b-457e-9c5f-7bbdf1ec2dba', name: 'Muhammad Mussa Jhang', channel: 'uber' },
    merge: { ids: ['8000520', '40d9e2c4-b309-4cad-aa45-111529001b0b'],
             name: 'Muhammad Mussa Haji Alif Jhang', channel: 'bolt' },
    plates: ['L18379', 'L19262', 'L54118'],
    days: { shared: 120, interleaved: 117, alias: 120, keep: 211 },
    trips: { alias: 305, onSharedCars: 305 },
    contradictions: [],
  }),
  pending({
    key: 'wisal muhammad',
    keep:  { id: '64686123-8389-4a9e-82f1-0287e936239b', name: 'Wisal Muhammad Muhammad', channel: 'uber' },
    merge: { ids: ['6610938'],
             name: 'Wisal Muhammad Irshah Muhammad', channel: 'bolt' },
    plates: ['L20048', 'L27045', 'L44251'],
    days: { shared: 119, interleaved: 91, alias: 183, keep: 507 },
    trips: { alias: 306, onSharedCars: 306 },
    contradictions: [],
  }),
  pending({
    key: 'hammad ahmad',
    keep:  { id: 'd454e6b8-6d69-469e-91a5-37c174dac8fd', name: 'Hammad Ahmad Ahmad', channel: 'uber' },
    merge: { ids: ['7523458', '68766cd503051f14d95a81fb'],
             name: 'Hammad Ahmad Aftab Ahmad', channel: 'bolt,hotel' },
    plates: ['L36374', 'L39416', 'L40547', 'L44259', 'L44284', 'L45227', 'L78469'],
    days: { shared: 115, interleaved: 79, alias: 121, keep: 367 },
    trips: { alias: 255, onSharedCars: 254 },
    contradictions: ['2025-07-02'],
  }),
  pending({
    key: 'najeeb ullah khan',
    keep:  { id: '00b3e873-1399-4db2-a781-1eb432fd8b9f', name: 'Najeeb Ullah Khan Khan', channel: 'uber' },
    merge: { ids: ['7554575'],
             name: 'Najeeb Ullah Khan Sabeel Khan', channel: 'bolt' },
    plates: ['L40971'],
    days: { shared: 108, interleaved: 84, alias: 118, keep: 330 },
    trips: { alias: 153, onSharedCars: 153 },
    contradictions: [],
  }),
  pending({
    key: 'shahab ali hayat',
    keep:  { id: '05a7d342-a3f9-4343-b8a5-89c72f0d87aa', name: 'Shahab Ali Hayat', channel: 'uber' },
    merge: { ids: ['7490578'],
             name: 'Shahab Ali Shaukat Hayat', channel: 'bolt' },
    plates: ['L45205'],
    days: { shared: 107, interleaved: 88, alias: 108, keep: 341 },
    trips: { alias: 144, onSharedCars: 144 },
    contradictions: [],
  }),
  pending({
    key: 'asad khan',
    keep:  { id: '0dcd3bb3-ed9b-41d2-a392-ac272bfe9e9d', name: 'Asad Khan Khan', channel: 'uber' },
    merge: { ids: ['6620276', '67483c64055e070d791000ea'],
             name: 'Asad Khan Hakim Khan', channel: 'bolt,hotel' },
    plates: ['L37810', 'L46173', 'L76098'],
    days: { shared: 106, interleaved: 98, alias: 149, keep: 234 },
    trips: { alias: 418, onSharedCars: 418 },
    contradictions: [],
  }),
  pending({
    key: 'md muhmudul hasan',
    keep:  { id: '86e2349e-e8cd-41b0-8712-3591d46f9c64', name: 'Md muhmudul Hasan', channel: 'uber' },
    merge: { ids: ['6615016', '67483c64055e070d79100130'],
             name: 'Md Mahmudul Hasan', channel: 'bolt,hotel' },
    plates: ['L44280', 'L45243', 'L46185', 'L82923'],
    days: { shared: 106, interleaved: 84, alias: 165, keep: 366 },
    trips: { alias: 303, onSharedCars: 303 },
    contradictions: [],
  }),
  pending({
    key: 'muhammad nazir khan',
    keep:  { id: 'cc12b6f3-7ce0-4dae-afcd-4454dd36a401', name: 'Muhammad Nazir Khan', channel: 'uber' },
    merge: { ids: ['7841816', 'f3aded68-1b7d-4903-9837-2a6981e83083'],
             name: 'Muhammad Nazir Zarin Khan', channel: 'bolt' },
    plates: ['L38439'],
    days: { shared: 99, interleaved: 71, alias: 107, keep: 331 },
    trips: { alias: 170, onSharedCars: 170 },
    contradictions: [],
  }),
  pending({
    key: 'mehran said ghani',
    keep:  { id: '8978cc79-d8f7-4e0f-acd1-9c94953545bc', name: 'Mehran Said Ghani', channel: 'uber' },
    merge: { ids: ['8196123', '74eac830-64ff-4ca6-8902-f8342805ef4d'],
             name: 'Mehran Said Ihsan Ghani', channel: 'bolt' },
    plates: ['L19261', 'L19312', 'L63271'],
    days: { shared: 98, interleaved: 81, alias: 99, keep: 241 },
    trips: { alias: 220, onSharedCars: 220 },
    contradictions: [],
  }),
  pending({
    key: 'zahid khan',
    keep:  { id: 'c33cc3d6-77d2-4e13-a916-f08a89daf2bb', name: 'Zahid Khan Khan', channel: 'uber' },
    merge: { ids: ['6616272', '67483c64055e070d791000f4'],
             name: 'Zahid Khan Afridi Mohabbat Khan', channel: 'bolt,hotel' },
    plates: ['L40759', 'L45227', 'L64009', 'L64921', 'L77059', 'L81970'],
    days: { shared: 94, interleaved: 76, alias: 152, keep: 288 },
    trips: { alias: 267, onSharedCars: 267 },
    contradictions: [],
  }),
  pending({
    key: 'muhammad toussef bangash',
    keep:  { id: '81cf7546-94b0-43ab-8952-cc3fbb7b88f2', name: 'Muhammad Toussef Bangash', channel: 'uber' },
    merge: { ids: ['8240779', 'decaa9ec-2f1a-483f-8be5-62f48f97b887'],
             name: 'Muhammad Touseef Shakeel Muhammad Bangash', channel: 'bolt' },
    plates: ['L19262', 'L57948', 'L64998'],
    days: { shared: 93, interleaved: 77, alias: 93, keep: 264 },
    trips: { alias: 357, onSharedCars: 357 },
    contradictions: [],
  }),
  pending({
    key: 'ahmed tarig mohamed',
    keep:  { id: '7411d0fa-79c4-4b79-a3a6-f870948c1f7e', name: 'Ahmed Tarig Mohamed', channel: 'uber' },
    merge: { ids: ['8326835', '693a7a9f8c482942eaaec5c0'],
             name: 'Ahmed Tarig Suliman Mohamed', channel: 'bolt' },
    plates: ['L45232', 'L91248'],
    days: { shared: 87, interleaved: 68, alias: 88, keep: 238 },
    trips: { alias: 159, onSharedCars: 159 },
    contradictions: [],
  }),
  pending({
    key: 'imran hussain islam',
    keep:  { id: 'db0ba25e-4170-4fb3-a705-7a115875ac4f', name: 'Imran Hussain Islam', channel: 'uber' },
    merge: { ids: ['8362618', '6940219e8c482942eaaeffbe'],
             name: 'Imran Hussain Muhammad Islam', channel: 'bolt,hotel' },
    plates: ['L45249', 'L64921', 'L75122', 'L78465'],
    days: { shared: 79, interleaved: 66, alias: 82, keep: 198 },
    trips: { alias: 315, onSharedCars: 315 },
    contradictions: [],
  }),
  pending({
    key: 'ijaz ahmed khan',
    keep:  { id: 'd144a02a-3154-4042-8dff-68f4d4c69c58', name: 'Ijaz Ahmed Khan', channel: 'uber' },
    merge: { ids: ['7399836', '5d8e0b4033cf40f9943b5209b6e35341', '69b9815fcc90e854f1e5171c'],
             name: 'Ijaz Ahmad Ashiq Khan', channel: 'bolt' },
    plates: ['L46172', 'L73536'],
    days: { shared: 67, interleaved: 53, alias: 71, keep: 345 },
    trips: { alias: 84, onSharedCars: 84 },
    contradictions: [],
  }),
  pending({
    key: 'bashir ahmad amin',
    keep:  { id: '369dd9c1-ae0a-4526-8d46-d91a8c217121', name: 'Bashir Ahmad Amin', channel: 'uber' },
    merge: { ids: ['8483922', 'a41efffe-2f84-43ad-8f92-f50f755a1d55'],
             name: 'Bashir Ahmad', channel: 'bolt' },
    plates: ['L19261', 'L57952', 'L72481'],
    days: { shared: 65, interleaved: 42, alias: 68, keep: 197 },
    trips: { alias: 130, onSharedCars: 130 },
    contradictions: [],
  }),
  pending({
    key: 'fahad ali',
    keep:  { id: 'ec17d708-7879-42fc-90ec-6d19f01677fb', name: 'Fahad Ali Ali', channel: 'uber' },
    merge: { ids: ['6610649', '67483c64055e070d791000dd'],
             name: 'Fahad Ali Amjad Ali', channel: 'bolt,hotel' },
    plates: ['L12615', 'L77059'],
    days: { shared: 65, interleaved: 59, alias: 146, keep: 149 },
    trips: { alias: 475, onSharedCars: 471 },
    contradictions: [],
  }),
  pending({
    key: 'faiz muhammad',
    keep:  { id: 'b8bbe67f-ce9f-4e76-bd86-406b7c80b007', name: 'Faiz Muhammad Muhammad', channel: 'uber' },
    merge: { ids: ['7009554', '67483c64055e070d791000e7'],
             name: 'Faiz Muhammad Nazar Muhammad', channel: 'bolt' },
    plates: ['L41452', 'L45240', 'L46162', 'L76092', 'L89569'],
    days: { shared: 62, interleaved: 49, alias: 73, keep: 325 },
    trips: { alias: 96, onSharedCars: 96 },
    contradictions: [],
  }),
  pending({
    key: 'umair khan shah',
    keep:  { id: '5b00efc9-f834-484e-93c2-552dd234de98', name: 'Umair Khan Shah', channel: 'uber' },
    merge: { ids: ['7547646', '68766d2903051f14d95a8202'],
             name: 'Umair Khan Muzamil Shah', channel: 'bolt,hotel' },
    plates: ['L40971', 'L41443', 'L46208', 'L76092', 'L77059'],
    days: { shared: 55, interleaved: 35, alias: 55, keep: 351 },
    trips: { alias: 81, onSharedCars: 81 },
    contradictions: [],
  }),
  pending({
    key: 'md anwar jelany',
    keep:  { id: '73a665de-dd27-4c8b-a6ff-6c565cfe6116', name: 'Md Anwar Jelany', channel: 'uber' },
    merge: { ids: ['6623895'],
             name: 'Md Anwar Hossain Md Abdul Kader Jelany Anwar Hossain Md Abdul Kader Jelany', channel: 'bolt' },
    plates: ['L40561', 'L44289', 'L89569'],
    days: { shared: 54, interleaved: 42, alias: 97, keep: 363 },
    trips: { alias: 156, onSharedCars: 141 },
    contradictions: [],
  }),
  pending({
    key: 'simon leonard mirano',
    keep:  { id: 'af95b655-7caf-43d5-920b-3ad907bbb3fb', name: 'Simon Leonard Mirano', channel: 'uber' },
    merge: { ids: ['8773066'],
             name: 'SIMON LEONARD SANMOCTE MIRANO', channel: 'bolt' },
    plates: ['L77062'],
    days: { shared: 52, interleaved: 39, alias: 52, keep: 149 },
    trips: { alias: 64, onSharedCars: 64 },
    contradictions: [],
  }),
  pending({
    key: 'muhammad tayyab hussain',
    keep:  { id: 'c2470970-75a8-44d4-af6c-a3237ac73908', name: 'Muhammad Tayyab Hussain', channel: 'uber' },
    merge: { ids: ['8636674', '9b2a5734-0272-44d8-bb0b-48d73fe82b3d'],
             name: 'Muhammad Tayyab Karamat Hussain', channel: 'bolt' },
    plates: ['L52132'],
    days: { shared: 51, interleaved: 37, alias: 51, keep: 169 },
    trips: { alias: 79, onSharedCars: 79 },
    contradictions: [],
  }),
  pending({
    key: 'raja nouman ahmed',
    keep:  { id: '37723dc3-b5f7-49ce-9c80-495bf5a2b49b', name: 'Raja Nouman Ahmed', channel: 'uber' },
    merge: { ids: ['7633809'],
             name: 'Raja Nouman Khalil Raja Khalil Ahmed', channel: 'bolt' },
    plates: ['L36397'],
    days: { shared: 46, interleaved: 36, alias: 46, keep: 312 },
    trips: { alias: 63, onSharedCars: 63 },
    contradictions: [],
  }),
  pending({
    key: 'muhammad khalid gul',
    keep:  { id: '4d4eb2c1-f64c-48c2-8167-32d887cecfd2', name: 'Muhammad Khalid Gul', channel: 'uber' },
    merge: { ids: ['6623737', '67483c64055e070d791000f2'],
             name: 'MUHAMMAD KHALID YOUNAS GUL', channel: 'bolt' },
    plates: ['L12615', 'L39421', 'L45240', 'L94178'],
    days: { shared: 35, interleaved: 26, alias: 99, keep: 235 },
    trips: { alias: 151, onSharedCars: 151 },
    contradictions: [],
  }),
  pending({
    key: 'adnan ahmad khan',
    keep:  { id: '5b7928cd-4843-4b28-8b3e-8085a10ee04c', name: 'Adnan Ahmad khan', channel: 'uber' },
    merge: { ids: ['8658459', 'a37d36e7-75e6-4aeb-a093-faf9111d11c7'],
             name: 'Adnan Ahmad Khan Maidet Khan', channel: 'bolt' },
    plates: ['L59841', 'L64998'],
    days: { shared: 34, interleaved: 25, alias: 34, keep: 162 },
    trips: { alias: 52, onSharedCars: 52 },
    contradictions: [],
  }),
  pending({
    key: 'hamza khan',
    keep:  { id: '12293989-e71b-4ff1-9e99-85274479fab1', name: 'Hamza Khan Khan', channel: 'uber' },
    merge: { ids: ['6633453', '67483c64055e070d791000ed'],
             name: 'Hamza Khan Naeem Khan', channel: 'bolt' },
    plates: ['L44286', 'L46172', 'L46201', 'L82907'],
    days: { shared: 33, interleaved: 14, alias: 61, keep: 220 },
    trips: { alias: 74, onSharedCars: 64 },
    contradictions: [],
  }),
  pending({
    key: 'anoj gautam',
    keep:  { id: 'c09bfab8-613d-45f6-9ceb-79d635805f60', name: 'Anoj Gautam', channel: 'uber' },
    merge: { ids: ['9065412', '6a18233a284c6a435463e10a'],
             name: 'Anoj Gautam Mohan Bahadur', channel: 'bolt' },
    plates: ['L36374', 'L75125', 'L96093'],
    days: { shared: 32, interleaved: 22, alias: 32, keep: 105 },
    trips: { alias: 45, onSharedCars: 45 },
    contradictions: [],
  }),
  pending({
    key: 'muhammad naseem sadiq',
    keep:  { id: '06ff6c9d-f076-4b33-8240-f1c2ed3bf215', name: 'Muhammad Naseem Sadiq', channel: 'uber' },
    merge: { ids: ['6623877', '67483c64055e070d791000f3'],
             name: 'Muhammad Naseem Khan Muhammad Sadiq', channel: 'bolt,hotel' },
    plates: ['L12617', 'L46173'],
    days: { shared: 18, interleaved: 11, alias: 42, keep: 87 },
    trips: { alias: 81, onSharedCars: 26 },
    contradictions: [],
  }),
  pending({
    key: 'syed arshad shah',
    keep:  { id: '9c0d754c-18cc-4998-9a07-d527a509236d', name: 'Syed Arshad Shah', channel: 'uber' },
    merge: { ids: ['9374689', '6a7ac834d87732ee9b1fb6e1'],
             name: 'Syed Arshad Abbas Naqvi Syed Imdad Hussain shah', channel: 'bolt,hotel' },
    plates: ['L44305'],
    days: { shared: 12, interleaved: 9, alias: 12, keep: 51 },
    trips: { alias: 17, onSharedCars: 17 },
    contradictions: [],
  }),
  pending({
    key: 'zohaib khan usman',
    keep:  { id: '9950b892-52b1-487f-a8a3-31a31e491986', name: 'Zohaib Khan Usman', channel: 'uber' },
    merge: { ids: ['7883474', '98c7a061-d9f3-4e14-95ec-7eecec823af2'],
             name: 'Zohaib Khan Muhammad Usman', channel: 'bolt' },
    plates: ['L36125', 'L57952'],
    days: { shared: 12, interleaved: 9, alias: 12, keep: 209 },
    trips: { alias: 13, onSharedCars: 13 },
    contradictions: [],
  }),
  pending({
    key: 'ali rahman karim',
    keep:  { id: 'ae28ff72-760c-4259-815a-6c9fef953d46', name: 'Ali Rahman Karim', channel: 'uber' },
    merge: { ids: ['8789306', '67483c64055e070d791000ec'],
             name: 'ALI REHMAN RIAZ KARIM', channel: 'bolt,hotel' },
    plates: ['L12617'],
    days: { shared: 9, interleaved: 7, alias: 10, keep: 84 },
    trips: { alias: 13, onSharedCars: 12 },
    contradictions: [],
  }),
  pending({
    key: 'muhammad sheraz muhammad',
    keep:  { id: 'd4862a73-6317-4fa8-ad19-8c7a95e9e74d', name: 'Muhammad sheraz Muhammad', channel: 'uber' },
    merge: { ids: ['9120542', '26d509ca-2716-4dbc-9286-95e4640f33ef'],
             name: 'Muhammad Sheraz Amir Muhammad', channel: 'bolt' },
    plates: ['L18379'],
    days: { shared: 9, interleaved: 3, alias: 9, keep: 93 },
    trips: { alias: 10, onSharedCars: 10 },
    contradictions: [],
  }),
  pending({
    key: 'md anwar jelany',
    keep:  { id: '73a665de-dd27-4c8b-a6ff-6c565cfe6116', name: 'Md Anwar Jelany', channel: 'uber' },
    merge: { ids: ['67483c64055e070d791000d4'],
             name: 'MD ANWAR HOSSAIN MD ABDUL KADER JELANY', channel: 'hotel' },
    plates: ['L89569'],
    days: { shared: 3, interleaved: 1, alias: 3, keep: 363 },
    trips: { alias: 3, onSharedCars: 3 },
    contradictions: [],
  }),
  pending({
    key: 'muhammed nabeel thotty',
    keep:  { id: '03327ed4-85eb-4573-bdcd-03d79f308ac7', name: 'Muhammed Nabeel Thotty', channel: 'uber' },
    merge: { ids: ['9593757', '292b8810-08ef-4305-8374-759af09384b3'],
             name: 'Muhammed nabeel Thotty abdulkhader ABD', channel: 'bolt' },
    plates: ['L85082'],
    days: { shared: 3, interleaved: 2, alias: 3, keep: 4 },
    trips: { alias: 3, onSharedCars: 3 },
    contradictions: [],
  }),
  pending({
    key: 'rana jahanzaib akbar',
    keep:  { id: '41e79149-9b9b-4c04-a3d9-5677be879ddd', name: 'Rana Jahanzaib Akbar', channel: 'uber,bolt' },
    merge: { ids: ['6a4f617fb3b4e99c0391a663'],
             name: 'Rana jahanzaib Akbar Muhammad Akbar', channel: 'hotel' },
    plates: ['L64009'],
    days: { shared: 1, interleaved: 1, alias: 1, keep: 104 },
    trips: { alias: 1, onSharedCars: 1 },
    contradictions: [],
  }),
]);

/* ── the guard, run at import ─────────────────────────────────────────────
   A register that loads a malformed entry is a register nobody re-reads. It
   runs over BOTH lists, because an entry in PENDING is one migration away from
   being an entry in MERGES and a malformed one should fail now rather than
   then. On the pending entries it also re-checks the four tests the list was
   drawn by — same car on some day, interleaving on at least one of them, a
   contradiction rate at or under one day in fifty, and the two records meeting
   on a car on at least a quarter of the alias record's working days — so a
   fifty-first entry added by hand that does not meet them does not load.

   Two things changed shape when the second list arrived, and both are
   deliberate. A KEEP id may now appear in more than one entry: "Md Anwar
   Jelany" has two alias records, one on Bolt and one on the hotel channel, and
   both fold onto him. A MERGE id still may not, anywhere, on either list —
   that is the rule that keeps the answer single-valued. And an ALIAS is now a
   set of ids rather than one, because the same long name is often filed by two
   providers at once. */
const mergeIdsOf = (m) => (m.merge?.ids || [m.merge?.id]).filter(Boolean);

function assertRegister() {
  const seen = new Map();           // merge-side ids, across both lists
  const kept = new Map();           // keep-side ids, which may repeat
  for (const [m, list] of [...MERGES.map((x) => [x, 'MERGES']), ...PENDING.map((x) => [x, 'PENDING'])]) {
    const where = `${m.keep?.name} / ${m.merge?.name}`;
    const ids = mergeIdsOf(m);
    if (!ID.test(m.keep?.id || '')) throw new Error(`identity_map: bad keep id for ${where}`);
    if (!ids.length) throw new Error(`identity_map: ${where} names no record to merge`);
    for (const id of ids) {
      if (!ID.test(id)) throw new Error(`identity_map: bad merge id ${JSON.stringify(id)} for ${where}`);
      if (id === m.keep.id) throw new Error(`identity_map: ${where} merges a record into itself`);
      if (seen.has(id)) throw new Error(`identity_map: ${id} appears twice (${seen.get(id)} and ${where})`);
      seen.set(id, where);
    }
    if (m.key !== foldName(m.keep.name)) {
      throw new Error(`identity_map: ${where} claims key ${JSON.stringify(m.key)}, `
        + `but the surviving record folds to ${JSON.stringify(foldName(m.keep.name))}`);
    }
    /* An identity nobody wrote down the reason for is an identity nobody can
       check later, and this list is exactly the thing a later reader has to be
       able to check. */
    if (!m.evidence || m.evidence.length < 120) throw new Error(`identity_map: ${where} has no evidence`);
    if (!m.verified) throw new Error(`identity_map: ${where} has no verification date`);
    if (list === 'PENDING') assertMeasured(m, where);
    kept.set(m.keep.id, where);
  }
  /* A chain — A merged into B, B merged into C — would make the answer depend
     on the order the CASE is written in. Flat, or it does not load. */
  for (const [id, where] of kept) {
    if (seen.has(id)) {
      throw new Error(`identity_map: ${id} is both kept (${where}) and merged (${seen.get(id)})`
        + ' — the register must be flat');
    }
  }
  /* The refusals are about PAIRS, not about ids, and the check used to be
     about ids: no id could appear in both a merge and a refusal. That was
     right while the merges were three and is wrong now. "Muhammad Khalid Gul"
     is refused against "Muhammad Khalid" AND is the surviving record of a
     pending entry that folds "Muhammad Khalid Younas Gul" onto him — two
     different statements about two different pairs, and the id-level check
     would have refused the second because of the first. What must never
     happen is the two halves of a refused pair coming out with the same key,
     so that is what is checked. */
  const keyOf = (id) => [...MERGES, ...PENDING].find(
    (m) => m.keep.id === id || mergeIdsOf(m).includes(id))?.key ?? null;
  for (const r of REFUSED) {
    const [a, b] = [keyOf(r.a.id), keyOf(r.b.id)];
    if (a !== null && a === b) {
      throw new Error(`identity_map: ${r.a.name} and ${r.b.name} are REFUSED as two people, `
        + `but the register folds both onto ${JSON.stringify(a)}`);
    }
  }
}

/* The figures a pending entry carries are the reason it is on the list, so
   they are checked rather than read. Each of these is one of the four tests
   from the comment above, in the same order. */
function assertMeasured(m, where) {
  const d = m.days || {}, t = m.trips || {};
  const n = (x) => Number.isInteger(x) && x >= 0;
  if (!n(d.shared) || !n(d.interleaved) || !n(d.alias) || !n(t.alias) || !n(t.onSharedCars)) {
    throw new Error(`identity_map: ${where} is missing the measurements it was accepted on`);
  }
  if (!m.plates?.length) throw new Error(`identity_map: ${where} names no shared car`);
  if (d.shared < 1) throw new Error(`identity_map: ${where} was never in one car with the record it merges`);
  if (d.interleaved < 1) {
    throw new Error(`identity_map: ${where} has no day where the two accounts' trips interleave in one car`);
  }
  if (d.interleaved > d.shared || t.onSharedCars > t.alias) {
    throw new Error(`identity_map: ${where} counts more interleaved days or shared-car trips than it has`);
  }
  if (m.contradictions.length > d.shared * 0.02) {
    throw new Error(`identity_map: ${where} contradicts itself on ${m.contradictions.length} of `
      + `${d.shared} shared-car days — too often to read as a stray feed row`);
  }
  if (d.shared < d.alias * 0.25) {
    throw new Error(`identity_map: ${where} shared a car on ${d.shared} of the alias record's `
      + `${d.alias} working days — too little to be one man with two accounts`);
  }
  if (m.keep.channel.split(',').some((c) => m.merge.channel.split(',').includes(c))) {
    throw new Error(`identity_map: ${where} files trips on a channel both records share`);
  }
}
assertRegister();

/** alias id → the person key it resolves to. Empty for every other id. */
export const ALIAS_KEY = Object.freeze(new Map(MERGES.map((m) => [m.merge.id, m.key])));

/** The same thing for the pending fifty, and it is NOT wired to anything.
    ─────────────────────────────────────────────────────────────────────────
    It exists so the migration that applies them, or a reader checking one
    against production, does not have to walk the list to find out which ids
    would move and where. Nothing in api/ consults it: ALIAS_KEY above is what
    /api/driver/* resolves by and identityCase() below is what the SQL carries,
    and both still answer for the three applied pairs only, so the stored
    person_key column and the key this module computes cannot disagree. */
export const PENDING_ALIAS_KEY = Object.freeze(new Map(
  PENDING.flatMap((m) => mergeIdsOf(m).map((id) => [id, m.key]))));

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
