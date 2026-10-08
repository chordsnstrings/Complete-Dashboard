/* ── the merge register: identities somebody verified, one pair at a time ────
   ──────────────────────────────────────────────────────────────────────────
   Two lists come out of this file. MERGES is APPLIED — four hundred and sixty
   entries over two hundred and thirty-seven people, which sql/schema_v53.sql is
   generated from, so the database already stores the answer in person_key. PENDING is VERIFIED AND
   DELIBERATELY NOT APPLIED: none since 2026-10-08. It held the pairs that carry a CONTRADICTION, a day on
   which both records took a trip at the same time in different cars, which is
   the one observation that a shared car, a shared route and a shared phone
   cannot explain away — five until the operator's ruling of 2026-09-29, four
   until the review of 2026-10-08 ruled the last of them; all five are at the
   end of HAND_MERGES with the dates they were ruled over.

   Four lists built the four hundred and sixty, and they are kept apart below
   rather than blended, because they are believable for three different
   reasons. The counts in this comment are asserted in
   test/identity_register_counts.test.mjs: they said ninety-three over ninety
   for long enough that CLAUDE.md copied the wrong pair, and then a hundred and
   thirty over a hundred and twenty-four for a week after the register had
   reached a hundred and thirty-one — because the test pinned the header's own
   words rather than the register's size. A register whose own header
   misdescribes it is a register nobody trusts to re-read:

     · 10 in HAND_MERGES, checked one pair at a time against production or
       ruled by the operator. The fourth is a pair this file once REFUSED as
       undecidable and the operator ruled on, 2026-09-22. The fifth is a pair
       the sweep below held back in PENDING over a one-trip contradiction,
       which the operator ruled on, 2026-09-29: "both of them are the same
       people". The sixth to ninth are the other four PENDING held back, ruled
       2026-10-08, and the tenth is one man the register itself had split
       under two keys, re-keyed the same day.
     · 45 in CANDIDATES, from the shared-history sweep — same cars, same days,
       trips interleaving inside the day rather than following one another.
       All forty-five are clean and applied. (The sweep found fifty; the other
       five are HAND_MERGES' fifth to ninth, moved there with their figures and
       their contradiction dates.)
     · 324 in FROM_REVIEW, the operator's review of 2026-10-08, one entry per
       alias account, behind 295 links confirmed on the Same person page and
       never promoted (two accounts held back by name — see its header) and 35
       look-alike pairs measured on completed trips and ruled one by one or in
       groups. Its own header says how each was put.
     · 81 in FROM_ROSTER, from src/identity_link.js, on a phone number the
       roster filed against both records. Three of them name a key CANDIDATES
       had already reached by a different route — the same person found twice
       by two independent methods, which is the strongest reason to believe
       either, so both entries are kept and mergedIds() unions them.

   personFold (api/custody_sql.js) decides that two RECORDS are one human from
   the name alone. It collapses case, runs of whitespace and an adjacent
   repeated word — the noise the feeds actually produce — and it must never
   learn to do more than that, because every widening it could learn is a rule
   that will one day fire on two names nobody has looked at.

   That was measured rather than assumed. The one widening that would catch two
   of the first three pairs below — sort the folded words, so "Khalil Aliyan" keys the
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
   statements and payouts. The canonical key of every entry is the folded
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
   it rather than failing a test. Since fifty of the ninety-eight entries in
   this file have a Bolt numeral on the alias side, that was the first thing in
   the way. The width is deliberate — four to twelve digits, because 8361571 is
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
/* The five a person checked one at a time, id to id, rather than by any rule.
   Three of them are the oldest entries here and predate the roster rule; the
   fourth and fifth are the operator's rulings on 2026-09-22 and 2026-09-29.
   They keep their own name so a reader can see which merges were decided by a
   human looking at a pair.

   ── HOW AN OPERATOR'S RULING ENTERS THIS FILE ───────────────────────────
   One way, twice now: the pair moves HERE, to the end of this list, with the
   ruling as its evidence, from whichever list held it apart — REFUSED for the
   Sana pair, PENDING for the Ali Abbas pair. Nothing about the pair is
   deleted on the way. The fifth entry still carries the sweep's figures and
   the contradiction date it was held back for, and a `ruling` naming who
   decided, when, in what words, and which contradiction dates the ruling was
   made over. assertRegister() below refuses to load an APPLIED entry that
   carries a contradiction without such a ruling, so the filter that used to
   keep contradicted pairs out of MERGES cannot be bypassed by a hand edit
   that simply pastes one into this list.

   ── ORDER IS LOAD-BEARING; APPEND, NEVER PREPEND ────────────────────────
   Held oldest-first by `verified`, and a new entry goes on the END. That is
   not tidiness. MERGES is [...HAND_MERGES, ...CANDIDATES, ...FROM_ROSTER],
   so prepending here shifts MERGES[0] — and three test files bind their
   whole fixture population to MERGES[0] as "the Aliyan Khalil pair". Adding
   the Sana entry at the front of this list moved it to the Sana pair and
   broke 35 assertions across identity_map, identity_merge and
   person_vs_account_counts, none of which was about Sana: they read as
   nineteen counting bugs on the vehicle and finance pages. Those files now
   select their pair by KEY, so the trap is closed on both sides — but the
   chronological order is what a reader of this file should be able to rely
   on, so keep appending. */
const HAND_MERGES = Object.freeze([
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
  {
    key: 'sanaullah sher zamin',
    keep:  { id: 'b7511fa7-cbdf-4373-8539-c7ae020c31e2', name: 'Sanaullah Sher Zamin',  channel: 'uber' },
    merge: { id: '67483c64055e070d79100114',            name: 'Sana Ullah Sher Zamin', channel: 'hotel' },
    plate: 'L20048',
    verified: '2026-09-22',
    evidence:
      'RULED BY THE OPERATOR, which is what its own refusal asked for. This pair '
      + 'sat in REFUSED with the verdict "UNDECIDABLE, which is not a merge… '
      + 'Settled by a phone call, not by this file" — the hotel record carries 0 '
      + 'trips, 0 custody rows and 0 money, so neither a shared vehicle-day nor a '
      + 'simultaneity could be measured in either direction, and "Sher Zamin" is a '
      + 'patronymic two brothers would file identically. Nothing in the data could '
      + 'decide it. On 2026-09-22 the operator did: "sana is active and all the '
      + 'accounts are sana." '
      + 'What it unblocks, measured on production the same day: the uber account '
      + 'holds 240.5 online hours over 19 days and 190 trips in the trailing 31 '
      + 'days, and every one of them was absent from person 51\'s page — which '
      + 'rendered an em dash under the sentence "no channel this driver works '
      + 'publishes availability", while listing the uber account two lines below. '
      + 'The spine had already joined the pair through the shared-phone rule in '
      + 'src/persons.js (both records file +971569637741); this entry makes the '
      + 'register agree with the spine rather than contradict it.',
    caveat:
      'The evidence is a human ruling, not a measurement, and it is recorded as '
      + 'such. If the hotel record ever starts carrying trips, a simultaneity '
      + 'check becomes possible for the first time and should be run.',
  },
  /* Moved here from CANDIDATES, where it was the sixth entry and PENDING's
     second. Its figures are the shared-history sweep's, byte for byte as that
     sweep measured them on 2026-09-05 — they are the reason the pair was ever
     proposed, and a ruling that erased them would leave nothing for a later
     reader to check the ruling against. `contradictions` keeps the one date the
     pair was held back for; `ruling.over` names it as the date the operator
     ruled over, which is what assertRegister() requires of an applied entry
     that carries one. */
  {
    key: 'ali abbas ahmed',
    keep:  { id: '9e9060e7-0b8c-4f3b-8cd7-165d5eac55cd', name: 'Ali Abbas Ahmed', channel: 'uber' },
    merge: { ids: ['6623821', 'b17bcd50-e20b-4055-80d8-468131188397'],
             name: 'Ali Abbas Faiz Ahmed', channel: 'bolt' },
    plates: ['L36125', 'L58905', 'L85082'],
    days: { shared: 173, interleaved: 144, alias: 239, keep: 381 },
    trips: { alias: 520, onSharedCars: 520 },
    contradictions: ['2025-08-31'],
    ruling: { by: 'operator', on: '2026-09-29', words: 'both of them are the same people',
      over: ['2025-08-31'] },
    verified: '2026-09-29',
    evidence:
      'RULED BY THE OPERATOR, 2026-09-29, looking at the Drivers page: "both of them '
      + 'are the same people." This pair sat in PENDING — verified by the '
      + 'shared-history sweep of 2026-09-05 and deliberately not applied — for one '
      + 'reason only: on 2025-08-31 a single trip on the Bolt record sits on another '
      + 'plate inside the Uber record\'s own working span. Everything else the sweep '
      + 'measured points one way. The two records file trips on channels that do not '
      + 'overlap (uber against bolt). They were on the same plate on 173 of the Bolt '
      + 'record\'s 239 working days, across L36125, L58905 and L85082, and on 144 of '
      + 'those days their trips interleave inside the day on that plate — one man '
      + 'with two apps open, not a handover. Every one of the Bolt record\'s 520 '
      + 'trips is on a plate the Uber record also held. One trip on another plate is '
      + 'one feed row\'s vehicle field, not a shift in a second car, and the operator '
      + 'settled what the data could only flag. '
      + 'What it unblocks, read on production /api/drivers/directory for '
      + '2026-08-31..2026-09-29 the same day: the page listed him twice, as spine '
      + 'persons 101 and 115 — "Ali Abbas Ahmed" (uber, 42 trips in the window, '
      + '3,516 ever) and "Ali Abbas Faiz Ahmed" (bolt, ids 6623821 and b17bcd50…, '
      + '5 trips, 535 ever) — both Egari, both with L25054 as their usual vehicle. '
      + 'The register alone does not join the two person rows when either carries '
      + 'money (src/persons.js stops at money), so sql/schema_v93.sql makes the '
      + 'recorded merge that api/person_merge_routes.js would have made.',
    caveat:
      'The contradiction is overruled, not explained: 2025-08-31 stays on this entry '
      + 'so a reader can see exactly what the ruling was made over. Like the Sana '
      + 'entry above, the deciding evidence is a human ruling and is recorded as '
      + 'such. No licence number and no Emirates ID was compared. If a SHIFT in two '
      + 'cars at once ever turns up for this pair — two or more trips spread over '
      + 'hours while the other record worked — that is an observation the ruling '
      + 'did not see, and it goes back to the operator.',
  },
  /* ── four held back by the sweep, ruled 2026-10-08 ─────────────────────
     Moved here from CANDIDATES, where each sat in PENDING over the
     contradiction date it still carries. The operator's review of that day
     (FROM_REVIEW, below, says how it was put) ruled each of these people one
     person; the sweep's figures, plates and dates are kept exactly as the
     2026-09-05 sweep measured them — the Ali Abbas Ahmed entry's precedent. */
  {
    key: 'soaieed alom ali',
    keep:  { id: 'fb7c2c86-4ba0-41d6-b73f-6e9dd77b08ff', name: 'Soaieed Alom Ali', channel: 'uber' },
    merge: { ids: ['67483c64055e070d791000cf', '6639200'],
             name: 'SOAIEED ALOM MIHIN JINNAT ALI', channel: 'hotel,bolt' },
    plates: ['L44251', 'L46183', 'L46185', 'L78485', 'L82907'],
    days: { shared: 175, interleaved: 129, alias: 238, keep: 444 },
    trips: { alias: 420, onSharedCars: 311 },
    contradictions: ['2025-05-03'],
    ruling: { by: 'operator', on: '2026-10-08', words: 'All 27 are the same', over: ['2025-05-03'] },
    verified: '2026-10-08',
    evidence:
      'RULED BY THE OPERATOR, 2026-10-08, going through the duplicate drivers together: the pair was '
      + 'in Part 2, row S1 of the review sheet, with his Bolt and hotel records in Part 1, and the answer was "All 27 are the same". The shared-history sweep of 2026-09-05 '
      + 'verified it (the plates, days and trips above) and held it back for one reason only, the '
      + 'contradiction date it still carries; the Drivers page had already shown these records as one person.',
    caveat:
      'The contradiction is overruled, not explained: its date stays on this entry so a reader can see '
      + 'what the ruling was made over. If a SHIFT in two cars at once turns up for this pair, it goes back '
      + 'to the operator.',
  },
  {
    key: 'fayed ali muhammad',
    keep:  { id: 'cb5359cf-9f1f-4fcc-aee7-f79e892e78c7', name: 'Fayed Ali Muhammad', channel: 'uber' },
    merge: { ids: ['6780293', '2a1d4e30-e10f-4f47-a610-faae8c94d125'],
             name: 'Fayed Ali Taj Muhammad', channel: 'bolt' },
    plates: ['L36125', 'L52144', 'L54118', 'L55132'],
    days: { shared: 133, interleaved: 125, alias: 166, keep: 267 },
    trips: { alias: 481, onSharedCars: 481 },
    contradictions: ['2025-12-21', '2025-12-23'],
    ruling: { by: 'operator', on: '2026-10-08', words: 'All 27 are the same', over: ['2025-12-21', '2025-12-23'] },
    verified: '2026-10-08',
    evidence:
      'RULED BY THE OPERATOR, 2026-10-08, going through the duplicate drivers together: the pair was '
      + 'in Part 2, row S5 of the review sheet, with his Bolt record in Part 1, and the answer was "All 27 are the same". The shared-history sweep of 2026-09-05 '
      + 'verified it (the plates, days and trips above) and held it back for one reason only, the '
      + 'contradiction date it still carries; the Drivers page had already shown these records as one person.',
    caveat:
      'The contradiction is overruled, not explained: its date stays on this entry so a reader can see '
      + 'what the ruling was made over. If a SHIFT in two cars at once turns up for this pair, it goes back '
      + 'to the operator.',
  },
  {
    key: 'tariq afzal',
    keep:  { id: '7e96cb47-f2d4-4f96-9019-0ee79eb0117d', name: 'Tariq Afzal Afzal', channel: 'uber' },
    merge: { ids: ['69f7e655aab1412c83a9c6d4d58aa122', '7308211'],
             name: 'Tariq Afzal Said Afzal', channel: 'yango,bolt' },
    plates: ['L37810', 'L46174'],
    days: { shared: 133, interleaved: 105, alias: 134, keep: 411 },
    trips: { alias: 176, onSharedCars: 176 },
    contradictions: ['2026-06-10'],
    ruling: { by: 'operator', on: '2026-10-08', words: 'Yes, all 184', over: ['2026-06-10'] },
    verified: '2026-10-08',
    evidence:
      'RULED BY THE OPERATOR, 2026-10-08, going through the duplicate drivers together: the pair was '
      + 'in Part 1 of the review sheet, the people already joined on the Drivers page, and the answer was "Yes, all 184". The shared-history sweep of 2026-09-05 '
      + 'verified it (the plates, days and trips above) and held it back for one reason only, the '
      + 'contradiction date it still carries; the Drivers page had already shown these records as one person.',
    caveat:
      'The contradiction is overruled, not explained: its date stays on this entry so a reader can see '
      + 'what the ruling was made over. If a SHIFT in two cars at once turns up for this pair, it goes back '
      + 'to the operator.',
  },
  {
    key: 'hammad ahmad',
    keep:  { id: 'd454e6b8-6d69-469e-91a5-37c174dac8fd', name: 'Hammad Ahmad Ahmad', channel: 'uber' },
    merge: { ids: ['7523458', '68766cd503051f14d95a81fb'],
             name: 'Hammad Ahmad Aftab Ahmad', channel: 'bolt,hotel' },
    plates: ['L36374', 'L39416', 'L40547', 'L44259', 'L44284', 'L45227', 'L78469'],
    days: { shared: 115, interleaved: 79, alias: 121, keep: 367 },
    trips: { alias: 255, onSharedCars: 254 },
    contradictions: ['2025-07-02'],
    ruling: { by: 'operator', on: '2026-10-08', words: 'Yes, all 184', over: ['2025-07-02'] },
    verified: '2026-10-08',
    evidence:
      'RULED BY THE OPERATOR, 2026-10-08, going through the duplicate drivers together: the pair was '
      + 'in Part 1 of the review sheet, the people already joined on the Drivers page, and the answer was "Yes, all 184". The shared-history sweep of 2026-09-05 '
      + 'verified it (the plates, days and trips above) and held it back for one reason only, the '
      + 'contradiction date it still carries; the Drivers page had already shown these records as one person.',
    caveat:
      'The contradiction is overruled, not explained: its date stays on this entry so a reader can see '
      + 'what the ruling was made over. If a SHIFT in two cars at once turns up for this pair, it goes back '
      + 'to the operator.',
  },
  /* One man the register itself had filed under two keys: his Uber trips
     under "amshid khan" (a roster entry keeping e6fd4328) and his hotel
     record, a second Uber account and — by name — his Bolt trips under
     "amshid khan aleem khan" (a roster entry keeping the hotel record). Moved
     here from FROM_ROSTER and re-keyed onto the key that carries his trips. */
  {
    key: 'amshid khan',
    keep:  { id: 'e6fd4328-b270-4e7e-bff8-2c6e0f290a28', name: 'Amshid Khan Khan', channel: 'uber' },
    merge: { ids: ['9c09415b-9aa2-43dc-ac9e-298c3c72ac32', '67483c64055e070d791000e5', '6633456'],
             name: 'AMSHID KHAN ALEEM KHAN', channel: 'uber,hotel,bolt' },
    contradictions: [],
    ruling: { by: 'operator', on: '2026-10-08', words: 'Yes, all 184', over: [] },
    verified: '2026-10-08',
    evidence:
      'RULED BY THE OPERATOR, 2026-10-08 (Part 1 of the review sheet: "Yes, all 184"). The Drivers page '
      + 'showed one person — Uber e6fd4328 (1,606 trips) and 9c09415b, both filed "Amshid Khan Khan"; hotel '
      + '67483c64…e5 and Bolt 6633456 (384 trips), both "AMSHID KHAN ALEEM KHAN"; Yango "AMSHID KHAN" — but '
      + 'the register split him across two keys: the roster entry of 2026-09-07 joined the hotel record and '
      + 'Uber 9c09415b on one phone number ending 0954 under "amshid khan aleem khan", while his trips sat '
      + 'under "amshid khan". This entry carries that phone evidence over and puts every record on the key '
      + 'his 1,606 Uber trips already carry; only the Bolt account\'s 384 trips change key. Completed trips at '
      + 'the same moment in two cars: none.',
    caveat:
      'The two Uber accounts carry the same name and only one has ever filed a trip; nothing measured says '
      + 'why Uber issued him a second id. The phone tail is the roster\'s, from 2026-09-07, and was not re-read.',
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
    a: { id: '8089d680edf14bccb846737205b30520', name: 'MUHAMMAD KHALID', plate: 'none on record' },
    b: { id: '76ede4ae-768b-4126-804b-0b5c88043682', name: 'Muhammad Khalid', plate: 'L90721' },
    why: 'RULED BY THE OPERATOR, 2026-10-08: "HR is right". The HR roster files the Yango account under '
       + 'D034 Muhammad Khalid Younas Gul and the Uber account under D076 Muhammad Khalifa Afzal Khalid. '
       + 'A same-name link confirmed on the Same person page had joined them, so the Drivers page showed '
       + 'one man; the two names fold to the same words, so only this list keeps them apart.',
  },
]);

/* SANA ULLAH SHER ZAMIN WAS HERE, AND IS NOW A MERGE.
   ─────────────────────────────────────────────────────────────────────────
   Its entry read "UNDECIDABLE, which is not a merge… Settled by a phone call,
   not by this file." That is exactly what happened: on 2026-09-22 the operator
   ruled — "sana is active and all the accounts are sana". The pair moved to
   HAND_MERGES with that ruling as its evidence.

   Worth keeping in view, because it is the shape this list is FOR: the two
   entries left above are refused on MEASUREMENT — 241 and 77 simultaneous
   trips in two cars — and no ruling should move them, because the data says
   they are two men. This one was refused on the ABSENCE of measurement, which
   only a human could settle. The difference between those two kinds of refusal
   is the whole reason this file is a list and not a rule. */

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
   another channel that has filed none.

   Forty-five are here now. The sixth, "Ali Abbas Ahmed" against "Ali Abbas
   Faiz Ahmed", was held back over a one-trip contradiction on 2025-08-31 until
   the operator ruled on it, 2026-09-29; the other four held back were ruled
   in the review of 2026-10-08. All five are at the end of HAND_MERGES above —
   figures, plates and contradiction dates unchanged. */
const CANDIDATES = Object.freeze([
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

/* ── the pairs the ROSTER proved, on a phone number both channels filed ────
   Discovered by src/identity_link.js rather than checked one at a time, and
   that difference is why they carry a `basis` and why the evidence names the
   property that makes the rule safe rather than the history of one person.

   Measured over the 289 roster rows on 2026-09-07: 217 distinct phone
   numbers, none on more than two records, none twice within a single channel,
   72 shared across two channels — and 61 of those carrying names no fold can
   reach, because Bolt and the hotel channel file the full legal name while
   Uber drops the middle one. A number that identified a handset rather than a
   person would have to appear on three records or twice in one channel, and
   none does.

   These forty-five are the ones CANDIDATES above does not already hold. The
   twenty-six it does hold are not repeated here — they are the same people,
   found twice by two independent methods, which is the strongest reason to
   believe either.

   Twelve of the forty-five are pairs the name fold ALREADY joins — the two
   channels filed the same name, or one of them doubled a word. They are kept
   anyway: an entry pins the pair id to id, so the answer stops depending on
   two providers going on spelling a man's name the same way. Each of the
   twelve says which it is, below. */

/* One sentence, built rather than repeated forty-five times — the same shape
   pending() above uses, and for the same reason: what differs between these
   entries is two records and four digits, and forty-five copies of the same
   three sentences hide that behind three hundred characters each.

   The last clause is COMPUTED, not asserted. It read "The two names do not
   fold together, so no name rule could have joined them" on every entry, and
   that is false on twelve of the forty-five: "Abidullah Safi" is filed under
   the same name on both channels, and "Sajid Gul Gul Muhammad" folds onto
   "Sajid Gul Muhammad" by the doubled-word rule. Those twelve are redundant
   with the name fold rather than beyond its reach — still true, still worth
   carrying so the id-level answer does not depend on the name, but a register
   that overstates its own evidence is a register a reader stops trusting. */
const rosterEvidence = (m) => {
  const reach = foldName(m.keep.name) === foldName(m.merge.name)
    ? 'The two names already fold together, so this pair was joined without the phone as well; '
      + 'the entry pins it id to id so the answer no longer depends on the spelling.'
    : 'The two names do not fold together, so no name rule could have joined them.';
  return `The roster filed one phone number against both records: ${m.keep.channel} as `
    + `'${m.keep.name}' and ${m.merge.channel} as '${m.merge.name}', ending ${m.phoneTail}. `
    + 'Over the 289 roster rows the number is unambiguous: no phone appears on more than two '
    + 'records and none appears twice within one channel, so it names a person rather than a '
    + `handset. ${reach}`;
};

const fromRoster = (m) => Object.freeze({
  ...m, plate: null, verified: '2026-09-07', basis: 'shared_phone', evidence: rosterEvidence(m),
});

const FROM_ROSTER = Object.freeze([
  fromRoster({
    key: 'abidullah safi',
    keep:  { id: 'dae09063-88a3-432e-b39f-969d8de7992b', name: 'Abidullah Safi', channel: 'uber' },
    merge: { id: '6a5645c839f87dec92ca9386', name: 'Abidullah Safi', channel: 'hotel' },
    phoneTail: '6800',
  }),
  fromRoster({
    key: 'abusaad siddiqui akhlaque ahmad',
    keep:  { id: '68f744f88c482942eaaba18b', name: 'Abusaad Siddiqui Akhlaque Ahmad', channel: 'hotel' },
    merge: { id: 'beada3aa-c836-47d2-9100-feea4b1f31e2', name: 'Abusaad Siddiqui Ahmad', channel: 'uber' },
    phoneTail: '7157',
  }),
  fromRoster({
    key: 'aftab ahmed muhammad sharif altaf',
    keep:  { id: '68905c41d0a931b9d7544982', name: 'Aftab Ahmed Muhammad Sharif Altaf', channel: 'hotel' },
    merge: { id: '78b5741e-1c72-4b56-907f-da18807e5f57', name: 'Aftab Ahmed Altaf', channel: 'uber' },
    phoneTail: '0419',
  }),
  fromRoster({
    key: 'alakbar rahimov',
    keep:  { id: 'cf08a7df-1a9f-450c-92aa-baa8d9da5f7b', name: 'ALAKBAR RAHIMOV', channel: 'uber' },
    merge: { id: '69707aaeb905b635fcc054f3', name: 'Alakbar Rahimov', channel: 'hotel' },
    phoneTail: '6737',
  }),
  fromRoster({
    key: 'ali nawaz muhammad nawaz',
    keep:  { id: '67483c64055e070d791000f0', name: 'ALI NAWAZ MUHAMMAD NAWAZ', channel: 'hotel' },
    merge: { id: '42114339-fce7-448d-a4b5-b22aeea680cf', name: 'Ali Nawaz Nawaz', channel: 'uber' },
    phoneTail: '9092',
  }),
  fromRoster({
    key: 'aman ullah amir mehboob alam',
    keep:  { id: '68766d7d03051f14d95a8209', name: 'Aman Ullah Amir Mehboob Alam', channel: 'hotel' },
    merge: { id: '41b08fe8-4e12-4541-bb74-51c44bd54357', name: 'Amanullah Alam', channel: 'uber' },
    phoneTail: '1767',
  }),
  fromRoster({
    key: 'ansar murtaza butt rashid murtaza',
    keep:  { id: '67483c64055e070d791000e0', name: 'ANSAR MURTAZA BUTT RASHID MURTAZA', channel: 'hotel' },
    merge: { id: '84dea951-8a05-4b19-8b88-072ac72f3d2c', name: 'Ansar Murtaza Butt', channel: 'uber' },
    phoneTail: '7413',
  }),
  fromRoster({
    key: 'edwin nyasani mandere',
    keep:  { id: '6a48ed8f13880329d04ebbbd', name: 'Edwin Nyasani Mandere', channel: 'hotel' },
    merge: { id: '513d8c27-b88d-4c3e-8b20-c74680dede03', name: 'Edwin Mandere', channel: 'uber' },
    phoneTail: '8523',
  }),
  fromRoster({
    key: 'faisal badshah rasool badshah',
    keep:  { id: '67483c64055e070d79100109', name: 'FAISAL BADSHAH RASOOL BADSHAH', channel: 'hotel' },
    merge: { id: '9d1c60ce-e906-4ce7-ac3f-dd33eed89c99', name: 'Faisal Badshah Badshah', channel: 'uber' },
    phoneTail: '3832',
  }),
  fromRoster({
    key: 'farman ullah ghafoor khan',
    keep:  { id: 'de9a4044-c57e-427c-ae06-5bca66873857', name: 'Farman Ullah Ghafoor Khan', channel: 'uber' },
    merge: { id: '690b535b8c482942eaacb83c', name: 'Farman Ullah Ghafoor Khan', channel: 'hotel' },
    phoneTail: '8936',
  }),
  fromRoster({
    key: 'fawad ali khan ayaz muhammad',
    keep:  { id: '67483c64055e070d791000d0', name: 'FAWAD ALI KHAN AYAZ MUHAMMAD', channel: 'hotel' },
    merge: { id: 'df270275-028d-40e7-91c8-5f3b80e3efed', name: 'Fawad Ali Muhammad', channel: 'uber' },
    phoneTail: '2628',
  }),
  fromRoster({
    key: 'hassan talaat kamel abousira',
    keep:  { id: '293f7986-1768-4c56-8317-133ee31d89fb', name: 'Hassan Talaat Kamel Abousira', channel: 'uber' },
    merge: { id: '69046cc38c482942eaac6ee7', name: 'Hassan Talaat Kamel Abousira', channel: 'hotel' },
    phoneTail: '2904',
  }),
  fromRoster({
    key: 'irfan ullah awal ameen',
    keep:  { id: '04c30a0a-1d4f-40f3-b9aa-378ed5ceeee4', name: 'Irfan Ullah Awal Ameen', channel: 'uber' },
    merge: { id: '67483c64055e070d791000f1', name: 'IRFAN ULLAH AWAL AMEEN', channel: 'hotel' },
    phoneTail: '8611',
  }),
  fromRoster({
    key: 'joseph wandera',
    keep:  { id: '1e2311ad-cc26-4e2b-839a-41363ef67672', name: 'Joseph Wandera', channel: 'uber' },
    merge: { id: '68e368e3ff76a73626e0720e', name: 'Joseph Wandera', channel: 'hotel' },
    phoneTail: '4794',
  }),
  fromRoster({
    key: 'kashan malik abdul malik',
    keep:  { id: '67483c64055e070d791000fc', name: 'KASHAN MALIK ABDUL MALIK', channel: 'hotel' },
    merge: { id: 'ec9980b3-9663-43ac-9444-a1fc81675c0a', name: 'Kashan Malik Malik', channel: 'uber' },
    phoneTail: '8907',
  }),
  fromRoster({
    key: 'kashif ali ayyub khan',
    keep:  { id: '84d498cf-a74a-4750-9ac2-5eabdeec3b8d', name: 'Kashif Ali Ayyub khan', channel: 'uber' },
    merge: { id: '67483c64055e070d791000e3', name: 'KASHIF ALI AYYUB KHAN', channel: 'hotel' },
    phoneTail: '3892',
  }),
  fromRoster({
    key: 'kazi fuad ahmed kazi alim ullah',
    keep:  { id: '67483c64055e070d791000ca', name: 'Kazi Fuad Ahmed Kazi Alim Ullah', channel: 'hotel' },
    merge: { id: '8cf0d6e0-5399-4686-81fd-2aa8682ce786', name: 'Kazi Fuad Alim Ullah', channel: 'uber' },
    phoneTail: '2161',
  }),
  fromRoster({
    key: 'majid shah mehboob shah',
    keep:  { id: '67483c64055e070d791000ee', name: 'MAJID SHAH MEHBOOB SHAH', channel: 'hotel' },
    merge: { id: '4963067e-9979-411e-8c66-926ca581a0f2', name: 'Majid Shah Shah', channel: 'uber' },
    phoneTail: '1645',
  }),
  fromRoster({
    key: 'md imran hasan rahi md mostafa',
    keep:  { id: '67483c64055e070d7910012e', name: 'Md Imran Hasan Rahi Md Mostafa', channel: 'hotel' },
    merge: { id: '7edf1e96-da02-4f5a-ae10-5b9a1842c828', name: 'Md Imran Mostafa', channel: 'uber' },
    phoneTail: '5338',
  }),
  fromRoster({
    key: 'maen m alaa shekfa',
    keep:  { id: '67483c64055e070d79100133', name: 'M MAEN M ALAA SHEKFA', channel: 'hotel' },
    merge: { id: 'e4cb0cd6-a078-461b-984a-b7c6fc32a247', name: 'M Maen Shekfa', channel: 'uber' },
    phoneTail: '9775',
  }),
  fromRoster({
    key: 'mohammad naeem adam khan',
    keep:  { id: '67483c64055e070d79100117', name: 'MOHAMMAD NAEEM ADAM KHAN', channel: 'hotel' },
    merge: { id: 'd31e25fa-dc28-424c-a6e5-c2cbcf516870', name: 'Mohammad Naeem Khan', channel: 'uber' },
    phoneTail: '5690',
  }),
  fromRoster({
    key: 'mohammad shahin mohammad shahazanan',
    keep:  { id: '67483c64055e070d79100129', name: 'Mohammad Shahin Mohammad Shahazanan', channel: 'hotel' },
    merge: { id: '47f7edb9-b533-45b9-8f42-2f383b8384bb', name: 'Mohammad Shahin Shahazanan', channel: 'uber' },
    phoneTail: '2825',
  }),
  fromRoster({
    key: 'mohammed alsoos',
    keep:  { id: '67483c64055e070d7910012f', name: 'MOHAMMED A A ALSOOS', channel: 'hotel' },
    merge: { id: 'ba5e864f-6035-469c-97a1-db3e4a087385', name: 'Mohammed Alsous', channel: 'uber' },
    phoneTail: '8559',
  }),
  fromRoster({
    key: 'mohammed musab rahmathulla',
    keep:  { id: '2c085db3-dbb1-48a6-99ca-0af7e5ee3ea5', name: 'Mohammed Musab Rahmathulla', channel: 'uber' },
    merge: { id: '68905130d0a931b9d7544863', name: 'Mohammed Musab Rahmathulla', channel: 'hotel' },
    phoneTail: '3246',
  }),
  fromRoster({
    key: 'moses bale',
    keep:  { id: '628fbdea-1404-4289-a5b5-9bab4dc69cf0', name: 'Moses Bale', channel: 'uber' },
    merge: { id: '68e36905ff76a73626e07220', name: 'Moses Bale', channel: 'hotel' },
    phoneTail: '4909',
  }),
  fromRoster({
    key: 'muhammad abid ali khan noor',
    keep:  { id: '67483c64055e070d791000de', name: 'MUHAMMAD ABID ALI KHAN NOOR NOOR', channel: 'hotel' },
    merge: { id: '0b4d7f5b-086e-4f40-96c6-2e2ffe727214', name: 'Muhammad Abid Khan', channel: 'uber' },
    phoneTail: '2133',
  }),
  fromRoster({
    key: 'muhammad ahmad ghulam qadir',
    keep:  { id: '6a7f3e80d87732ee9b2068a3', name: 'MUHAMMAD AHMAD GHULAM QADIR', channel: 'hotel' },
    merge: { id: '8b6b8f45-eda3-44be-85d8-0d45d9dad64e', name: 'Muhammad Ahmad khan', channel: 'uber' },
    phoneTail: '1075',
  }),
  fromRoster({
    key: 'muhammad amir misree khan',
    keep:  { id: '67483c64055e070d791000d3', name: 'MUHAMMAD AMIR MISREE KHAN', channel: 'hotel' },
    merge: { id: 'b00986ad-2af2-4fac-babd-df87d3cd5a05', name: 'Muhammad Amir Khan', channel: 'uber' },
    phoneTail: '4163',
  }),
  fromRoster({
    key: 'muhammad hanan munir muhammad munir',
    keep:  { id: '688085f5a0bf23d354fd60b0', name: 'Muhammad Hanan Munir Muhammad Munir', channel: 'hotel' },
    merge: { id: '3113020f-f05b-4f77-882b-394cce34efc7', name: 'Muhammad Hanan Munir', channel: 'uber' },
    phoneTail: '3145',
  }),
  fromRoster({
    key: 'muhammad hasham tanveer ahmad khan',
    keep:  { id: '67483c64055e070d791000e2', name: 'MUHAMMAD HASHAM TANVEER TANVEER AHMAD KHAN', channel: 'hotel' },
    merge: { id: '147935b6-3c73-4689-a5f2-3efd07d91c12', name: 'Muhammad Hasham KHAN', channel: 'uber' },
    phoneTail: '0618',
  }),
  fromRoster({
    key: 'muhammad khalifa afzal khalid',
    keep:  { id: '67483c64055e070d79100112', name: 'MUHAMMAD KHALIFA AFZAL KHALID', channel: 'hotel' },
    merge: { id: '76ede4ae-768b-4126-804b-0b5c88043682', name: 'Muhammad Khalid', channel: 'uber' },
    phoneTail: '9547',
  }),
  fromRoster({
    key: 'muhammad sameer shamrez asghar',
    keep:  { id: '67483c64055e070d79100131', name: 'MUHAMMAD SAMEER SHAMREZ ASGHAR', channel: 'hotel' },
    merge: { id: '1f5bbf3c-ba34-4dec-a28a-6af17d241033', name: 'Muhammad Sameer Asghar', channel: 'uber' },
    phoneTail: '3717',
  }),
  fromRoster({
    key: 'nauman hassan shida muhammad',
    keep:  { id: '67483c64055e070d791000f9', name: 'NAUMAN HASSAN SHIDA MUHAMMAD', channel: 'hotel' },
    merge: { id: '8583f89a-6620-4557-a985-4c12bf08b02a', name: 'Nauman Hassan Muhammad', channel: 'uber' },
    phoneTail: '7656',
  }),
  fromRoster({
    key: 'norah chia nsom',
    keep:  { id: '8daae9c7-5a34-4e67-a178-565b92191461', name: 'Norah Chia Nsom', channel: 'uber' },
    merge: { id: '6a18229d284c6a435463e0fb', name: 'Norah chia Nsom', channel: 'hotel' },
    phoneTail: '0823',
  }),
  fromRoster({
    key: 'saad ali akram muhammad akram bhatti',
    keep:  { id: '67483c64055e070d791000d9', name: 'SAAD ALI AKRAM MUHAMMAD AKRAM BHATTI', channel: 'hotel' },
    merge: { id: '69845f36-babb-46b3-ae7d-d39c864bc427', name: 'Saad ali Bhatti', channel: 'uber' },
    phoneTail: '6680',
  }),
  fromRoster({
    key: 'sabbir hossain shahalom',
    keep:  { id: '006e7f5c-f7c4-45f2-bd00-336121105d3f', name: 'Sabbir Hossain Shahalom', channel: 'uber' },
    merge: { id: '67483c64055e070d791000cd', name: 'SABBIR HOSSAIN SHAHALOM', channel: 'hotel' },
    phoneTail: '5536',
  }),
  fromRoster({
    key: 'sajid gul muhammad',
    keep:  { id: '68905711d0a931b9d754492a', name: 'Sajid Gul Gul Muhammad', channel: 'hotel' },
    merge: { id: 'a2692332-5580-4aef-890b-48416e7eeed0', name: 'Sajid Gul Muhammad', channel: 'uber' },
    phoneTail: '7095',
  }),
  fromRoster({
    key: 'sar zamin khan shah bahadar',
    keep:  { id: '69411d3a8c482942eaaf083e', name: 'Sar Zamin Khan Shah Bahadar', channel: 'hotel' },
    merge: { id: '14852992-6178-4043-976e-4dd4e8fc72ad', name: 'Sar Zamin Bahadar', channel: 'uber' },
    phoneTail: '8958',
  }),
  fromRoster({
    key: 'sohib hussein mohamed',
    keep:  { id: '99c3016d-12da-4831-a4c6-7102c696b849', name: 'Sohib Hussein Mohamed', channel: 'uber' },
    merge: { id: '69a6b3ea0c67e9caa6353337', name: 'Sohib Hussein Ahmed', channel: 'hotel' },
    phoneTail: '5270',
  }),
  fromRoster({
    key: 'umar ali zarid khan',
    keep:  { id: '67483c64055e070d791000f8', name: 'Umar Ali Zarid Khan', channel: 'hotel' },
    merge: { id: '758b9949-6042-4c2d-b6f0-aebe8501d5be', name: 'Umar Ali Khan', channel: 'uber' },
    phoneTail: '3801',
  }),
  fromRoster({
    key: 'waseem abbas ghulam nabi',
    keep:  { id: '6911c82f8c482942eaacf939', name: 'Waseem Abbas Ghulam Nabi', channel: 'hotel' },
    merge: { id: '4056c8cc-3c12-41ba-9948-e7e740d67fbe', name: 'Waseem Abbas Nabi', channel: 'uber' },
    phoneTail: '9942',
  }),
  fromRoster({
    key: 'zain ul abideen muhammad irfan',
    keep:  { id: '67483c64055e070d791000df', name: 'ZAIN UL ABIDEEN MUHAMMAD IRFAN', channel: 'hotel' },
    merge: { id: '362aca28-e48d-4c09-bce2-f5fe23266723', name: 'Zain Ul Abideen Irfan', channel: 'uber' },
    phoneTail: '1304',
  }),
  fromRoster({
    key: 'zia ali said muhammad',
    keep:  { id: '67483c64055e070d7910012d', name: 'ZIA ALI SAID MUHAMMAD', channel: 'hotel' },
    merge: { id: '4ce6eea7-ea84-49d9-b6c5-14f67d3f5cc3', name: 'Zia Ali Muhammad', channel: 'uber' },
    phoneTail: '2816',
  }),
  fromRoster({
    key: 'zubair khan shaukat ali',
    keep:  { id: '67483c64055e070d791000e4', name: 'ZUBAIR KHAN SHAUKAT ALI', channel: 'hotel' },
    merge: { id: 'a83f63fc-88bb-4bbd-9ee3-55d5aeb00e8c', name: 'Zubair Khan Ali', channel: 'uber' },
    phoneTail: '1373',
  }),

  /* ── the Yango roster's own thirty-seven, added 2026-09-07 ───────────────
     The same rule and the same evidence as the forty-five above, on a roster
     that grew. Until this day the Yango collector wrote no compliance row at
     all — the console path never did — so its 145 drivers carried no phone
     number and src/identity_link.js could not see one of them. Pointing the
     collector at fleet-api.yango.tech gave them phones, and the rule found
     these the same afternoon.

     They are almost all one shape: Yango files a SHORT name where the hotel
     channel or Uber files the full one — "ABDUL HANNAN" against "ABDUL HANNAN
     MOMIN HUMAYOU", "MUHAMMAD MASOOD" against "MUHAMMAD MASOOD KISHBAR KHAN".
     No fold reaches those, which is exactly why the phone is worth having.

     Three of them attach a Yango id to a person the register already holds,
     and they attach it to the EXISTING keep rather than to the survivor the
     rule proposed: the rule prefers the fuller name and would have made
     "Raja Khalil Ahmed Raja Nouman Khalil" the survivor of a man the register
     already files as "Raja Nouman Ahmed", moving a key that every stored row
     already carries. No key in this database moves except an alias record's.

     One the rule proposed is NOT here. Tariq Afzal is in PENDING — verified,
     and deliberately not applied, over a day on which both records took a trip
     at the same time in two different cars. src/identity_link.js honoured
     REFUSED and not PENDING, so it re-raised a decision somebody had already
     made; that is fixed there, and this is the pair that found it. */
  fromRoster({
    key: 'aamir khan amin',
    keep:  { id: 'efa5df29-c8ac-47d7-9ce2-be046f5d3a0f', name: 'Aamir Khan Amin', channel: 'uber' },
    merge: { id: '1d910e38d0a5451ea5b4c45df2706c5e', name: 'AAMIR KHAN', channel: 'yango' },
    phoneTail: '1863',
  }),
  fromRoster({
    key: 'abdul basit aman',
    keep:  { id: '6d609028-a86c-4cee-92ef-7bae26e0cca8', name: 'Abdul Basit Aman', channel: 'uber' },
    merge: { id: '48de0d9f0a7c493f83724bae1f8dd257', name: 'Abdul Basit Aman', channel: 'yango' },
    phoneTail: '1068',
  }),
  fromRoster({
    key: 'abdul hannan momin humayoun habib momin',
    keep:  { id: '67483c64055e070d79100105', name: 'ABDUL HANNAN MOMIN HUMAYOUN HABIB MOMIN', channel: 'hotel' },
    merge: { id: '1427dd41041346988c05065cee86c47f', name: 'ABDUL HANNAN', channel: 'yango' },
    phoneTail: '0068',
  }),
  fromRoster({
    key: 'abdullah ahmad ullah khan',
    keep:  { id: '67483c64055e070d7910010e', name: 'ABDULLAH AHMAD AHMAD ULLAH KHAN', channel: 'hotel' },
    merge: { id: 'd5eb68b8397a449d82003ddf3faa52fa', name: 'ABDULLAH AHMAD', channel: 'yango' },
    phoneTail: '2848',
  }),
  fromRoster({
    key: 'abu bakar saddique kamil shah',
    keep:  { id: '5779be46aefa4bacaa413aa861219444', name: 'Abu Bakar Saddique Kamil Shah', channel: 'yango' },
    merge: { id: 'd6d4e1cb-296f-4ef5-8270-3653ef546a02', name: 'Abubakar Saddique Shah', channel: 'uber' },
    phoneTail: '9846',
  }),
  fromRoster({
    key: 'ali rahman karim',
    keep:  { id: 'ae28ff72-760c-4259-815a-6c9fef953d46', name: 'Ali Rahman Karim', channel: 'uber' },
    merge: { id: 'd694b0919c1d4b639642771c0119509e', name: 'ALI REHMAN', channel: 'yango' },
    phoneTail: '5370',
  }),
  fromRoster({
    key: 'amir muhammad khan muhammad naeem khan',
    keep:  { id: '1ffc17512bae40d2a6899f35aad12789', name: 'Amir Muhammad Khan Muhammad Naeem Khan', channel: 'yango' },
    merge: { id: 'd9b2de76-b535-4b23-a714-7e31724e50d2', name: 'Muhammad Naeem Khan', channel: 'uber' },
    phoneTail: '7627',
  }),
  fromRoster({
    key: 'amshid khan',
    keep:  { id: 'e6fd4328-b270-4e7e-bff8-2c6e0f290a28', name: 'Amshid Khan Khan', channel: 'uber' },
    merge: { id: 'c7a289421a5848ee9bfacf71b133fc24', name: 'AMSHID KHAN', channel: 'yango' },
    phoneTail: '3517',
  }),
  fromRoster({
    key: 'arbab hassan rab nawaz',
    keep:  { id: '68766dbe03051f14d95a8210', name: 'Arbab Hassan Rab Nawaz', channel: 'hotel' },
    merge: { id: 'ca4b038d57a146698bca6c1b1e0a999a', name: 'Arbab Hassan Rab Nawaz', channel: 'yango' },
    phoneTail: '3944',
  }),
  fromRoster({
    key: 'atif shabir muhammad shabir',
    keep:  { id: '67483c64055e070d791000fe', name: 'ATIF SHABIR MUHAMMAD SHABIR', channel: 'hotel' },
    merge: { id: '6d1b7b15e277440cafcaf9a8e8983f8d', name: 'ATIF SHABIR', channel: 'yango' },
    phoneTail: '3576',
  }),
  fromRoster({
    key: 'bilal ahmad haji rehman',
    keep:  { id: '67483c64055e070d79100106', name: 'BILAL AHMAD HAJI REHMAN', channel: 'hotel' },
    merge: { id: 'ed0cc768ec3d46f4b8932dfbf24f12f3', name: 'BILAL AHMAD', channel: 'yango' },
    phoneTail: '2832',
  }),
  fromRoster({
    key: 'danish rehman haji rehman',
    keep:  { id: '67483c64055e070d79100111', name: 'DANISH REHMAN HAJI REHMAN', channel: 'hotel' },
    merge: { id: '3c0d36fd2caf48fbb45a10e8cf9aab1d', name: 'DANISH REHMAN', channel: 'yango' },
    phoneTail: '1879',
  }),
  fromRoster({
    key: 'durga prasad basyal',
    keep:  { id: '67483c64055e070d791000cb', name: 'DURGA PRASAD BASYAL', channel: 'hotel' },
    merge: { id: '449077790a0e4ac5a64585d4eb68eda1', name: 'DURGA PRASAD', channel: 'yango' },
    phoneTail: '3586',
  }),
  fromRoster({
    key: 'hamza khan',
    keep:  { id: '12293989-e71b-4ff1-9e99-85274479fab1', name: 'Hamza Khan Khan', channel: 'uber' },
    merge: { id: '2948d032d7df4ad4827f611d296430c8', name: 'HAMZA KHAN', channel: 'yango' },
    phoneTail: '2997',
  }),
  fromRoster({
    key: 'ifraz ahmed ghulam ahmed',
    keep:  { id: '68766c6303051f14d95a81ed', name: 'Ifraz Ahmed Ghulam Ahmed', channel: 'hotel' },
    merge: { id: 'd22a7087f9ac42119cbe936749cd0bf1', name: 'Ifraz Ghulam Ahmed Ahmed', channel: 'yango' },
    phoneTail: '4860',
  }),
  fromRoster({
    key: 'mahaz ahmad darwaish khan',
    keep:  { id: 'f1bbe420-bd7f-43e0-b8d4-8ecd5e8f4719', name: 'Mahaz Ahmad Darwaish Khan', channel: 'uber' },
    merge: { id: 'fa7219517bf24cefb719ec1b28e9a913', name: 'MAHAZ AHMAD', channel: 'yango' },
    phoneTail: '4462',
  }),
  fromRoster({
    key: 'mati ullah sharif khan',
    keep:  { id: '67483c64055e070d791000f7', name: 'MATI ULLAH SHARIF KHAN', channel: 'hotel' },
    merge: { id: '735cc1574bfd46de8cfa7ed449d371f8', name: 'Matiullah Khan Sharif Khan', channel: 'yango' },
    phoneTail: '9350',
  }),
  fromRoster({
    key: 'mirza abdullah baig mirza zahid baig',
    keep:  { id: '67483c64055e070d7910010d', name: 'MIRZA ABDULLAH BAIG MIRZA ZAHID BAIG', channel: 'hotel' },
    merge: { id: '9d77089bcf574517850372f447977d30', name: 'MIRZA ABDULLAH', channel: 'yango' },
    phoneTail: '7710',
  }),
  fromRoster({
    key: 'mohammad mokdassel md obaidullah',
    keep:  { id: '67483c64055e070d79100125', name: 'MOHAMMAD MOKDASSEL MD OBAIDULLAH', channel: 'hotel' },
    merge: { id: '4688f7772f494801902447e10c6df649', name: 'MOHAMMAD MOKDASSEL', channel: 'yango' },
    phoneTail: '1516',
  }),
  fromRoster({
    key: 'muhammad masood kishbar khan',
    keep:  { id: '67483c64055e070d791000d7', name: 'MUHAMMAD MASOOD KISHBAR KHAN', channel: 'hotel' },
    merge: { id: 'ffe3cfced8554932a6faf50538e944bf', name: 'MUHAMMAD MASOOD', channel: 'yango' },
    phoneTail: '0546',
  }),
  fromRoster({
    key: 'muhammad nadeem ajmal',
    keep:  { id: '1936ced0-ccd5-4db0-b07f-ab084cee7bd9', name: 'Muhammad Nadeem Ajmal', channel: 'uber' },
    merge: { id: 'e3cd308b2b5f48e19877b924b48bbb9d', name: 'MUHAMMAD NADEEM', channel: 'yango' },
    phoneTail: '5854',
  }),
  fromRoster({
    key: 'muhammad rahim muhammad saleem',
    keep:  { id: '67483c64055e070d79100103', name: 'MUHAMMAD RAHIM MUHAMMAD SALEEM', channel: 'hotel' },
    merge: { id: '97d930a906e74d5d8d6fc25d75c2a128', name: 'MUHAMMAD RAHIM', channel: 'yango' },
    phoneTail: '0606',
  }),
  fromRoster({
    key: 'muhammad shafiq raziq',
    keep:  { id: '011fdd5b-54af-453e-aa17-b6f86c5fe11f', name: 'Muhammad Shafiq Raziq', channel: 'uber' },
    merge: { id: '983dc9bfe04d4bd48729325ddaa42c0d', name: 'Muhammad Shafiq', channel: 'yango' },
    phoneTail: '0250',
  }),
  fromRoster({
    key: 'muhammad zeeshan muhammad shahid',
    keep:  { id: '4d57e153e6ff455782e4954a7862099a', name: 'Muhammad Zeeshan Muhammad Shahid', channel: 'yango' },
    merge: { id: '6589d771-fe78-4c9a-bc9d-686c39a91e4c', name: 'Muhammad Zeeshan Shahid', channel: 'uber' },
    phoneTail: '0663',
  }),
  fromRoster({
    key: 'raja nouman ahmed',
    keep:  { id: '37723dc3-b5f7-49ce-9c80-495bf5a2b49b', name: 'Raja Nouman Ahmed', channel: 'uber' },
    merge: { id: 'cfad6f03a439432e8fa6f9c8fe89edcb', name: 'Raja Khalil Ahmed Raja Nouman Khalil', channel: 'yango' },
    phoneTail: '9927',
  }),
  fromRoster({
    key: 'rakibul alam raihan md shofiqul alam',
    keep:  { id: '67483c64055e070d791000cc', name: 'RAKIBUL ALAM RAIHAN MD SHOFIQUL ALAM', channel: 'hotel' },
    merge: { id: '3629dde64f684e2abdcc0aeb1487632a', name: 'RAKIBUL ALAM RAIHAN', channel: 'yango' },
    phoneTail: '4130',
  }),
  fromRoster({
    key: 'rashid ali haji hussain',
    keep:  { id: '43183d548e3e487b9a5227705ace4719', name: 'Rashid Ali Haji Hussain', channel: 'yango' },
    merge: { id: 'ebe0dcf0-c554-4320-9f36-e61c17713d8d', name: 'Rashid Ali Hussain', channel: 'uber' },
    phoneTail: '3884',
  }),
  fromRoster({
    key: 'rizwan ullah muzamil khan',
    keep:  { id: '67483c64055e070d79100118', name: 'Rizwan Ullah Muzamil Khan', channel: 'hotel' },
    merge: { id: '67352587e6664d86b723b25eb7dbd89e', name: 'RIZWAN ULLAH', channel: 'yango' },
    phoneTail: '1420',
  }),
  fromRoster({
    key: 'roy vellespen ocdol',
    keep:  { id: '3d3e3fa2-2e8c-43a9-8bf0-6b12dc3e26fe', name: 'Roy Vellespen Ocdol', channel: 'uber' },
    merge: { id: 'ba329c7a6ac34245acf074c3250bc555', name: 'ROY VELLESPEN', channel: 'yango' },
    phoneTail: '6778',
  }),
  fromRoster({
    key: 'sajid ayaz ahmed',
    keep:  { id: '67483c64055e070d79100113', name: 'SAJID AYAZ AYAZ AHMED', channel: 'hotel' },
    merge: { id: '13f61bb13eae43c3b0cf5d4af1c736d8', name: 'Sajid Ayaz', channel: 'yango' },
    phoneTail: '6984',
  }),
  fromRoster({
    key: 'sameh talaat abdelmaksoud abdelsamie',
    keep:  { id: '67483c64055e070d7910010f', name: 'SAMEH TALAAT ABDELMAKSOUD ABDELSAMIE', channel: 'hotel' },
    merge: { id: '36b941b820be498c907628b253adb32b', name: 'SAMEH TALAAT', channel: 'yango' },
    phoneTail: '5429',
  }),
  fromRoster({
    key: 'sikandar tariq hussain',
    keep:  { id: '39042c26-8985-4f99-af1c-a990a63834e6', name: 'Sikandar Tariq Hussain', channel: 'uber' },
    merge: { id: 'f7d8a0ff324641b1bc96c649290da826', name: 'Sikandar Tariq', channel: 'yango' },
    phoneTail: '4977',
  }),
  fromRoster({
    key: 'sumon ahmed khan nizam uddin khan',
    keep:  { id: '67483c64055e070d791000c8', name: 'SUMON AHMED KHAN NIZAM UDDIN KHAN', channel: 'hotel' },
    merge: { id: 'cf3a1777da6f49bb814d7cd3ec8f92fd', name: 'SUMON AHMED', channel: 'yango' },
    phoneTail: '9052',
  }),
  fromRoster({
    key: 'umar kayani nasir waheed kayani',
    keep:  { id: '67483c64055e070d791000da', name: 'UMAR KAYANI NASIR WAHEED KAYANI', channel: 'hotel' },
    merge: { id: 'cac5cfedf0df4f90a0086cefc297d535', name: 'UMAR KAYANI', channel: 'yango' },
    phoneTail: '0278',
  }),
  fromRoster({
    key: 'umer naveed abdul qadir',
    keep:  { id: '67483c64055e070d791000db', name: 'UMER NAVEED ABDUL QADIR', channel: 'hotel' },
    merge: { id: '563467d09d3d4f629b8b65e9c67d591f', name: 'Umer Naveed', channel: 'yango' },
    phoneTail: '4406',
  }),
  fromRoster({
    key: 'wajid akbar khan',
    keep:  { id: '00dc098e-2f65-4b6b-9fbd-47305cdb18e0', name: 'Wajid Akbar Khan', channel: 'uber' },
    merge: { id: '5d42345bcf4440df93645a54aedb9bc6', name: 'WAJID AKBAR', channel: 'yango' },
    phoneTail: '0628',
  }),
  fromRoster({
    key: 'zain ali ghulam hassnain',
    keep:  { id: '67483c64055e070d79100120', name: 'ZAIN ALI GHULAM HASSNAIN', channel: 'hotel' },
    merge: { id: 'b14f2b04795c411b8c01b2edc2a37774', name: 'ZAIN ALI GHULAM', channel: 'yango' },
    phoneTail: '3866',
  }),
]);

/* ── what is applied, and what is held back ───────────────────────────────
   A pair with a CONTRADICTION is a day on which both records took a trip at
   the same time, which is the one observation that cannot be explained by one
   person holding two accounts. Five of the fifty carry one or two such days
   against two hundred and more shared ones, and two of those five also share a
   phone. A shared phone is strong and a simultaneous trip is disconfirming,
   and when the two disagree the honest answer is to leave the records apart
   and say so: merging two humans' work and money is the mistake no page can
   help a reader notice, and it is the one this whole register exists to avoid
   making by accident.

   So they stay in PENDING — verified, published, and not applied — and the
   forty-five clean ones join the register.

   Four stay now. The one thing that moves a pair out of here is the one thing
   that moved Sana out of REFUSED: a person who knows the man ruling on it. On
   2026-09-29 the operator looked at "Ali Abbas Ahmed" and "Ali Abbas Faiz
   Ahmed" on two rows of the Drivers page and said "both of them are the same
   people"; that pair is now the fifth HAND_MERGES entry, carrying its
   2025-08-31 contradiction and the ruling made over it. No filter here was
   changed to do that, and none should be: a contradiction still keeps a SWEPT
   pair out, and the guard below keeps a contradicted pair out of MERGES by any
   route but a recorded ruling. */
/* ── the operator's review, 2026-10-08: "go through it together" ──────────
   ═══════════════════════════════════════════════════════════════════════════
   The operator: "There are still drivers who are the same drivers working on
   different platforms but counted as two. it's time we go through it together
   to fix it."

   What was measured first, on production, that morning. The Drivers page
   folded 830 accounts into 348 people, but 295 links confirmed "same" on the
   Same person page (199 of them on 2026-09-21, the rest from 09-14 to 10-08)
   had never been promoted here. A confirmed link folds the directory and the
   driver pages (api/identity_links.js) and does NOT move person_key, so every
   rollup — the Target and Month target pages, the 08:00 email, payouts,
   statements — still counted 184 of those people as two or three. On the
   Month target page that day, 137 "active drivers" were 119 people.

   A second sweep looked for look-alike people nothing had joined: 123 pairs
   of people on the Drivers page whose names share two distinctive words.
   Every completed trip of both was read (/api/driver/trips) and each pair
   measured the way the 2026-09-05 sweep measured its fifty — days in the same
   car, trips interleaving inside the day in that car (one person with two
   apps open, not a handover), and the disproof: a completed trip in each at
   the same moment in two different cars. Only completed trips count; the
   first pass also read cancelled requests and called 90 of them "two cars at
   once" for one man, where the completed trips showed 7.

   The operator was shown every pair on a review sheet, grouped by evidence,
   and ruled, in these words, on these questions (RULED and ASKED below):
     link    Part 1 — the 184 people already joined on the Drivers page   324 entries in all,
     strong  Part 2 — 27 pairs, same car, interleaving, never apart       by the account each
     weak    Part 3 — 4 pairs too thin for a rule; ticked one by one      moves; see the count
     car     Part 4 — 4 records with no trips, standing on the exact car  test for the split
             the other person drives (the other 48 left apart)
   Two accounts were taken back to the operator by name and held out of this
   list: the Bolt "ZAHID KHAN ISMAIL" (6633205), "not sure — leave it", and
   the Yango "MUHAMMAD KHALID" (8089d680…), which the HR roster files under a
   different employee — "HR is right", and that pair is in REFUSED. The four
   pairs PENDING held back, and the one man the register itself had split
   under two keys, are the last entries of HAND_MERGES.

   ── how an entry here is built ──────────────────────────────────────────
   One entry per alias ACCOUNT, so each spelling is its own merge.name and
   mergedNames() can match rows filed under any of them. The survivor is the
   person's existing register entry where there is one; otherwise the account
   whose stored key the person's trips already carry (the directory's
   person_key, which is the seeding row's stored column), so no stored key
   moves except an alias account's. A person whose completed trips put two
   cars at the same moment on some day carries those dates as
   `contradictions`, and the ruling names them in `over`, which is what
   assertRegister() requires — the Ali Abbas Ahmed precedent, applied to the
   stray rows the sheet showed beside each person. */
const REVIEW_ON = '2026-10-08';
const RULED = Object.freeze({
  link: 'Yes, all 184',
  strong: 'All 27 are the same',
  weak: 'ticked as the same person',
  car: 'Join those 4, leave the rest',
});
const ASKED = Object.freeze({
  link: 'should every count treat each of the 184 people already joined on the Drivers page as one person?',
  strong: 'the 27 strong pairs not joined anywhere — are they the same person?',
  weak: 'which of these four weak pairs are the same person?',
  car: 'these records have no trips and stand on the exact car the other person drives — join them?',
});
const BASIS_WORDS = Object.freeze({
  similar_name: 'one name sits inside the other',
  same_name: 'the two names fold to the same words',
  shared_car_name: 'a shared car and a similar name',
  shared_phone: 'one phone number the roster filed against both',
  hr_roster: 'the HR roster',
});
const reviewEvidence = (m) => {
  const head = `${m.merge.channel} record '${m.merge.name}' and ${m.keep.channel} record '${m.keep.name}' are one person. `;
  let how;
  if (m.link) {
    how = `A rule proposed the pair (${BASIS_WORDS[m.link.basis] || m.link.basis.replace(/_/g, ' ')}) and it was `
      + `confirmed "same" on the Same person page${m.link.confirmed ? ` on ${m.link.confirmed}` : ''}; the Drivers page `
      + 'has shown one person since, while the stored key counted the records apart in every total. ';
  } else if (m.standing) {
    how = `The ${m.merge.channel} record has no completed trip, so no trip can confirm or refute it; its platform `
      + `standing (${m.standing.platformState}) is on ${m.standing.plate}, the car the other record drives. `;
  } else {
    const s = m.seen;
    how = `Measured on production on ${REVIEW_ON}, completed trips only: of the ${s.days} days the smaller record `
      + `worked, the two were in the same car on ${s.shared}${s.plates.length ? ` (${s.plates.slice(0, 4).join(', ')}`
        + `${s.plates.length > 4 ? ', …' : ''})` : ''}, their trips interleaving inside the day on ${s.interleaved}, and `
      + `in two cars at the same moment on ${s.atOnce ? `${s.atOnce} trip${s.atOnce === 1 ? '' : 's'}` : 'none'}. `;
  }
  const over = (m.contradictions || []).length
    ? ` The completed trips at the same moment in two cars on ${m.contradictions.join(', ')} are overruled, not `
      + 'explained, and stay on this entry.'
    : '';
  return `${head}${how}Ruled by the operator on ${REVIEW_ON}, asked "${ASKED[m.part]}" — "${RULED[m.part]}".${over}`;
};
const fromReview = (m) => Object.freeze({
  ...m, plate: null, verified: REVIEW_ON, basis: 'review_ruling',
  contradictions: m.contradictions || [],
  ruling: { by: 'operator', on: REVIEW_ON, words: RULED[m.part], over: m.contradictions || [] },
  evidence: reviewEvidence(m),
});

const FROM_REVIEW = Object.freeze([
  fromReview({ key: 'wisal muhammad', part: 'link',
    keep: { id: '64686123-8389-4a9e-82f1-0287e936239b', name: 'Wisal Muhammad Muhammad', channel: 'uber' },
    merge: { id: '67483c64055e070d791000f5', name: 'WISAL MUHAMMAD IRSHAD MUHAMMAD', channel: 'hotel' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'wisal muhammad', part: 'link',
    keep: { id: '64686123-8389-4a9e-82f1-0287e936239b', name: 'Wisal Muhammad Muhammad', channel: 'uber' },
    merge: { id: '122e8a0195354a0090474be38680ca2c', name: 'wisal muhammad', channel: 'yango' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad khalifa afzal khalid', part: 'link',
    keep: { id: '67483c64055e070d79100112', name: 'MUHAMMAD KHALIFA AFZAL KHALID', channel: 'hotel' },
    merge: { id: '6628822', name: 'Muhammad Khalifa Afzal Khalid', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' },
    contradictions: ['2025-10-13', '2025-11-17', '2025-12-07', '2025-12-26'] }),
  fromReview({ key: 'muhammad khalifa afzal khalid', part: 'link',
    keep: { id: '67483c64055e070d79100112', name: 'MUHAMMAD KHALIFA AFZAL KHALID', channel: 'hotel' },
    merge: { id: 'dc2705246ec84c17921d272b0aaf73d3', name: 'MUHAMMAD KHALIFA', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' },
    contradictions: ['2025-10-13', '2025-11-17', '2025-12-07', '2025-12-26'] }),
  fromReview({ key: 'zeeshan ahmad ur rahman', part: 'link',
    keep: { id: '76aa7207-cd18-4498-a9b6-e11d8b45e266', name: 'Zeeshan Ahmad Ur Rahman', channel: 'uber' },
    merge: { id: '6842136', name: 'Zeeshan Ahmed Wazeer Ur Rahman', channel: 'bolt' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' },
    contradictions: ['2025-06-07'] }),
  fromReview({ key: 'zeeshan ahmad ur rahman', part: 'link',
    keep: { id: '76aa7207-cd18-4498-a9b6-e11d8b45e266', name: 'Zeeshan Ahmad Ur Rahman', channel: 'uber' },
    merge: { id: '4517ca6e-8b79-4bd4-8e4d-88c86d5dd6b9', name: 'Zeeshan Ahmed Wazeer Ur Rahman', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' },
    contradictions: ['2025-06-07'] }),
  fromReview({ key: 'muhammad talha faizullah', part: 'link',
    keep: { id: '9efd4d0b-2db7-4f57-88e8-8450e2803f8f', name: 'Muhammad Talha Faizullah', channel: 'uber' },
    merge: { id: '6615331', name: 'Muhammad Talha Faizullah', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad talha faizullah', part: 'link',
    keep: { id: '9efd4d0b-2db7-4f57-88e8-8450e2803f8f', name: 'Muhammad Talha Faizullah', channel: 'uber' },
    merge: { id: '467b94c54718457da9f3d434d3a5390c', name: 'Muhammad Talha Faizullah', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-18' } }),
  fromReview({ key: 'muhammad talha faizullah', part: 'link',
    keep: { id: '9efd4d0b-2db7-4f57-88e8-8450e2803f8f', name: 'Muhammad Talha Faizullah', channel: 'uber' },
    merge: { id: '67483c64055e070d79100126', name: 'MUHAMMAD TALHA FAIZULLAH', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'fawad ali khan ayaz muhammad', part: 'link',
    keep: { id: '67483c64055e070d791000d0', name: 'FAWAD ALI KHAN AYAZ MUHAMMAD', channel: 'hotel' },
    merge: { id: '6639159', name: 'Fawad Ali Khan Ayaz Muhammad', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'umer naveed abdul qadir', part: 'link',
    keep: { id: '67483c64055e070d791000db', name: 'UMER NAVEED ABDUL QADIR', channel: 'hotel' },
    merge: { id: 'b4a7efd8-2808-4058-8595-635918c6bcf2', name: 'Umer Naveed Qadir', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'umer naveed abdul qadir', part: 'link',
    keep: { id: '67483c64055e070d791000db', name: 'UMER NAVEED ABDUL QADIR', channel: 'hotel' },
    merge: { id: '6611555', name: 'Umer Naveed Abdul Qadir', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'ali abbas ahmed', part: 'link',
    keep: { id: '9e9060e7-0b8c-4f3b-8cd7-165d5eac55cd', name: 'Ali Abbas Ahmed', channel: 'uber' },
    merge: { id: '680790c003051f14d956b356', name: 'Ali Abbas Faiz Ahmed', channel: 'hotel' },
    link: { basis: 'shared_phone', confirmed: 'unknown' } }),
  fromReview({ key: 'muhammad asif zada', part: 'link',
    keep: { id: '6ee7b8e2-c47d-46be-ac7b-d0c74c36391c', name: 'Muhammad Asif Zada', channel: 'uber' },
    merge: { id: '6640364', name: 'Muhammad Asif Amir Zada', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad asif zada', part: 'link',
    keep: { id: '6ee7b8e2-c47d-46be-ac7b-d0c74c36391c', name: 'Muhammad Asif Zada', channel: 'uber' },
    merge: { id: '9407cd209754464885335d800596c5ae', name: 'Muhammad Asif Amir Zada', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-18' } }),
  fromReview({ key: 'muhammad asif zada', part: 'link',
    keep: { id: '6ee7b8e2-c47d-46be-ac7b-d0c74c36391c', name: 'Muhammad Asif Zada', channel: 'uber' },
    merge: { id: '67483c64055e070d7910010b', name: 'MUHAMMAD ASIF AMIR ZADA', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mahaz ahmad darwaish khan', part: 'link',
    keep: { id: 'f1bbe420-bd7f-43e0-b8d4-8ecd5e8f4719', name: 'Mahaz Ahmad Darwaish Khan', channel: 'uber' },
    merge: { id: '6616065', name: 'Mahaz Ahmad Darwaish Khan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mahaz ahmad darwaish khan', part: 'link',
    keep: { id: 'f1bbe420-bd7f-43e0-b8d4-8ecd5e8f4719', name: 'Mahaz Ahmad Darwaish Khan', channel: 'uber' },
    merge: { id: '67483c64055e070d791000e1', name: 'MAHAZ AHMAD DARWAISH KHAN', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'wajid ali ameer bakhsh', part: 'link',
    keep: { id: '0a59fd2f-6fcc-497f-b274-4462bbc3ddf3', name: 'Wajid Ali Ameer Bakhsh', channel: 'uber' },
    merge: { id: '6901260', name: 'Wajid Ali Ameer Bakhsh', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'wajid ali ameer bakhsh', part: 'link',
    keep: { id: '0a59fd2f-6fcc-497f-b274-4462bbc3ddf3', name: 'Wajid Ali Ameer Bakhsh', channel: 'uber' },
    merge: { id: 'ffe30d6937114c1282457ed38010d274', name: 'Wajid Ali', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'wajid ali ameer bakhsh', part: 'link',
    keep: { id: '0a59fd2f-6fcc-497f-b274-4462bbc3ddf3', name: 'Wajid Ali Ameer Bakhsh', channel: 'uber' },
    merge: { id: '67483c64055e070d791000dc', name: 'WAJID ALI AMEER BAKHSH', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'aamir khan amin', part: 'link',
    keep: { id: 'efa5df29-c8ac-47d7-9ce2-be046f5d3a0f', name: 'Aamir Khan Amin', channel: 'uber' },
    merge: { id: '6628151', name: 'Aamir Khan Roohul Amin', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' },
    contradictions: ['2025-09-22', '2025-09-23', '2025-09-28', '2025-10-03', '2025-10-08', '2025-10-11', '2025-10-14'] }),
  fromReview({ key: 'aamir khan amin', part: 'link',
    keep: { id: 'efa5df29-c8ac-47d7-9ce2-be046f5d3a0f', name: 'Aamir Khan Amin', channel: 'uber' },
    merge: { id: '67483c64055e070d7910011e', name: 'AAMIR KHAN ROOHUL AMIN AMIN', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-14' },
    contradictions: ['2025-09-22', '2025-09-23', '2025-09-28', '2025-10-03', '2025-10-08', '2025-10-11', '2025-10-14'] }),
  fromReview({ key: 'najeeb ullah khan', part: 'link',
    keep: { id: '00b3e873-1399-4db2-a781-1eb432fd8b9f', name: 'Najeeb Ullah Khan Khan', channel: 'uber' },
    merge: { id: '005211c6d1204ab89ffe0ed358cfa91a', name: 'Sabeel Khan Najeeb Ullah Khan', channel: 'yango' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'najeeb ullah khan', part: 'link',
    keep: { id: '00b3e873-1399-4db2-a781-1eb432fd8b9f', name: 'Najeeb Ullah Khan Khan', channel: 'uber' },
    merge: { id: '69b7cb84cc90e854f1e4ff16', name: 'Najeeb ullah khan', channel: 'hotel' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'zia ali said muhammad', part: 'link',
    keep: { id: '67483c64055e070d7910012d', name: 'ZIA ALI SAID MUHAMMAD', channel: 'hotel' },
    merge: { id: '6640532', name: 'Zia Ali Said Muhammad', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abdul basit ayaz ahmed', part: 'link',
    keep: { id: '89886d77-952a-4df7-b206-8ada3b9afc78', name: 'Abdul Basit Ayaz Ahmed', channel: 'uber' },
    merge: { id: '6611346', name: 'Abdul Basit Ayaz Ahmed', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abdul basit ayaz ahmed', part: 'link',
    keep: { id: '89886d77-952a-4df7-b206-8ada3b9afc78', name: 'Abdul Basit Ayaz Ahmed', channel: 'uber' },
    merge: { id: '02cec98f-25ae-4cb9-9fd5-671920f958ac', name: 'Abdul Basit Ayaz Ahmed', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'siyad kallyanathoppil paramba', part: 'link',
    keep: { id: '12ce7e65-2ce7-4629-b958-17bb7a4e7bb8', name: 'Siyad Kallyanathoppil Paramba', channel: 'uber' },
    merge: { id: '7779693', name: 'Siyad Kallyanathoppil Paramba Razak Kallyanathoppil', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' },
    contradictions: ['2025-10-02', '2025-11-06'] }),
  fromReview({ key: 'siyad kallyanathoppil paramba', part: 'link',
    keep: { id: '12ce7e65-2ce7-4629-b958-17bb7a4e7bb8', name: 'Siyad Kallyanathoppil Paramba', channel: 'uber' },
    merge: { id: '6d175dd8-8d9c-4c88-8399-5b5c8a5efb85', name: 'Siyad Kallyanathoppil Paramba Razak Kallyanathoppil', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' },
    contradictions: ['2025-10-02', '2025-11-06'] }),
  fromReview({ key: 'hussain ansar', part: 'link',
    keep: { id: '5e3b947b-b927-47be-9845-24d6842acf0e', name: 'Hussain Ansar', channel: 'uber' },
    merge: { id: '90f893d3-7595-4743-8efe-62b2815677b7', name: 'Ansar Hussain Khalid', channel: 'uber' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'hussain ansar', part: 'link',
    keep: { id: '5e3b947b-b927-47be-9845-24d6842acf0e', name: 'Hussain Ansar', channel: 'uber' },
    merge: { id: '7624035', name: 'Ansar Hussain Khalid', channel: 'bolt' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'hussain ansar', part: 'link',
    keep: { id: '5e3b947b-b927-47be-9845-24d6842acf0e', name: 'Hussain Ansar', channel: 'uber' },
    merge: { id: '58de23fbd6e14a4389b7557c732ee607', name: 'Khalid Ansar Hussain', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mohammed alsoos', part: 'link',
    keep: { id: '67483c64055e070d7910012f', name: 'MOHAMMED A A ALSOOS', channel: 'hotel' },
    merge: { id: '6628504', name: 'Mohammed A A Alsoos', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' },
    contradictions: ['2026-09-16'] }),
  fromReview({ key: 'mohammed alsoos', part: 'link',
    keep: { id: '67483c64055e070d7910012f', name: 'MOHAMMED A A ALSOOS', channel: 'hotel' },
    merge: { id: '518aacd8fd9347bca83baef90671cb77', name: 'MOHAMMED A A ALSOUS', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' },
    contradictions: ['2026-09-16'] }),
  fromReview({ key: 'abass tanko', part: 'link',
    keep: { id: 'dbbeb72d-716a-4327-8705-f08dae83a240', name: 'Abass Tanko', channel: 'uber' },
    merge: { id: '6598737', name: 'Abass Tanko', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abass tanko', part: 'link',
    keep: { id: 'dbbeb72d-716a-4327-8705-f08dae83a240', name: 'Abass Tanko', channel: 'uber' },
    merge: { id: '41a6094035854fa49079fd38fff276ec', name: 'ABASS TANKO', channel: 'yango' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abass tanko', part: 'link',
    keep: { id: 'dbbeb72d-716a-4327-8705-f08dae83a240', name: 'Abass Tanko', channel: 'uber' },
    merge: { id: '67483c64055e070d7910011c', name: 'ABASS TANKO', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'zain ali ghulam hassnain', part: 'link',
    keep: { id: '67483c64055e070d79100120', name: 'ZAIN ALI GHULAM HASSNAIN', channel: 'hotel' },
    merge: { id: 'fb09dfee-cf6d-4391-8b57-e45e0e9ec743', name: 'Zain Ali Hassnain', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' },
    contradictions: ['2025-11-09', '2025-11-10', '2025-11-11', '2025-11-15'] }),
  fromReview({ key: 'zain ali ghulam hassnain', part: 'link',
    keep: { id: '67483c64055e070d79100120', name: 'ZAIN ALI GHULAM HASSNAIN', channel: 'hotel' },
    merge: { id: '6633916', name: 'Zain Ali Ghulam Hassnain', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' },
    contradictions: ['2025-11-09', '2025-11-10', '2025-11-11', '2025-11-15'] }),
  fromReview({ key: 'asif mehmood abdul qadeer', part: 'link',
    keep: { id: 'e1fb2ce2-8ab3-4897-aa6d-209b91df2fff', name: 'Asif Mehmood Abdul Qadeer', channel: 'uber' },
    merge: { id: '6611368', name: 'Asif Mehmood Abdul Qadeer', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'asif mehmood abdul qadeer', part: 'link',
    keep: { id: 'e1fb2ce2-8ab3-4897-aa6d-209b91df2fff', name: 'Asif Mehmood Abdul Qadeer', channel: 'uber' },
    merge: { id: 'd7cf380a-7777-431f-ac84-78afe493988d', name: 'Asif Mehmood Abdul Qadeer', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abu bakar saddique kamil shah', part: 'link',
    keep: { id: '5779be46aefa4bacaa413aa861219444', name: 'Abu Bakar Saddique Kamil Shah', channel: 'yango' },
    merge: { id: '7399815', name: 'Abu Bakar Siddique Kamil Shah', channel: 'bolt' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'sajid gul muhammad', part: 'link',
    keep: { id: '68905711d0a931b9d754492a', name: 'Sajid Gul Gul Muhammad', channel: 'hotel' },
    merge: { id: '7644369', name: 'Sajid Gul Gul Muhammad', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'sajid gul muhammad', part: 'link',
    keep: { id: '68905711d0a931b9d754492a', name: 'Sajid Gul Gul Muhammad', channel: 'hotel' },
    merge: { id: '072492179a9c45e9b2aa438122615687', name: 'Gul Muhammad Sajid Gul', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'abidullah safi', part: 'link',
    keep: { id: 'dae09063-88a3-432e-b39f-969d8de7992b', name: 'Abidullah Safi', channel: 'uber' },
    merge: { id: '7208744', name: 'Abidullah Safi', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abidullah safi', part: 'link',
    keep: { id: 'dae09063-88a3-432e-b39f-969d8de7992b', name: 'Abidullah Safi', channel: 'uber' },
    merge: { id: '60e3d6c96fd44a5599ba7d326db30f47', name: 'Abidullah Safi', channel: 'yango' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad toussef bangash', part: 'link',
    keep: { id: '81cf7546-94b0-43ab-8952-cc3fbb7b88f2', name: 'Muhammad Toussef Bangash', channel: 'uber' },
    merge: { id: '691d9b128c482942eaad6aa7', name: 'Muhammad Touseef Shakeel Muhammad Bangash', channel: 'hotel' },
    link: { basis: 'shared_phone', confirmed: '2026-09-21' } }),
  fromReview({ key: 'roy vellespen ocdol', part: 'link',
    keep: { id: '3d3e3fa2-2e8c-43a9-8bf0-6b12dc3e26fe', name: 'Roy Vellespen Ocdol', channel: 'uber' },
    merge: { id: '6628167', name: 'Roy Vellespen Ocdol', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'roy vellespen ocdol', part: 'link',
    keep: { id: '3d3e3fa2-2e8c-43a9-8bf0-6b12dc3e26fe', name: 'Roy Vellespen Ocdol', channel: 'uber' },
    merge: { id: '67483c64055e070d79100100', name: 'ROY VELLESPEN OCDOL', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mohd shohidul islam shamsul alam', part: 'link',
    keep: { id: '45be24f8-e15a-4a94-897a-23f52daa16a8', name: 'Mohd Shohidul Islam Shamsul Alam', channel: 'uber' },
    merge: { id: '6611263', name: 'Mohd Shohidul Islam Shamsul Alam', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mohd shohidul islam shamsul alam', part: 'link',
    keep: { id: '45be24f8-e15a-4a94-897a-23f52daa16a8', name: 'Mohd Shohidul Islam Shamsul Alam', channel: 'uber' },
    merge: { id: 'c366fc8a-a007-461a-b06d-256d9c411c85', name: 'Mohd Shohidul Islam Shamsul Alam', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'hammad ahmad', part: 'link',
    keep: { id: 'd454e6b8-6d69-469e-91a5-37c174dac8fd', name: 'Hammad Ahmad Ahmad', channel: 'uber' },
    merge: { id: '4f54b70d5fd54aad8554f8c33ed20d8b', name: 'Hammad Ahmad Aftab Ahmad', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' },
    contradictions: ['2026-07-08'] }),
  fromReview({ key: 'mummer inam ullah', part: 'link',
    keep: { id: '1220e297-7538-4e00-be3d-5275afe760d5', name: 'Mummer Inam Inam Ullah', channel: 'uber' },
    merge: { id: '6610879', name: 'Mummer Inam Inam Ullah', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mummer inam ullah', part: 'link',
    keep: { id: '1220e297-7538-4e00-be3d-5275afe760d5', name: 'Mummer Inam Inam Ullah', channel: 'uber' },
    merge: { id: '4a315dee-2a2d-45b2-b2a1-cda45828ed6e', name: 'Mummer Inam Inam Ullah', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'zahid khan', part: 'link',
    keep: { id: 'c33cc3d6-77d2-4e13-a916-f08a89daf2bb', name: 'Zahid Khan Khan', channel: 'uber' },
    merge: { id: 'c74f4bf5fe2f45bfbd3c42a68857f3f0', name: 'ZAHID KHAN', channel: 'yango' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'zahid khan', part: 'link',
    keep: { id: 'c33cc3d6-77d2-4e13-a916-f08a89daf2bb', name: 'Zahid Khan Khan', channel: 'uber' },
    merge: { id: '3343a680ce234548998464bfd7784cb3', name: 'Zahid Khan Mohabbat Khan', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'mohammed fazlul siddik', part: 'link',
    keep: { id: '70f25511-3dd2-486a-927f-e19d5c2482ca', name: 'Mohammed Fazlul Siddik', channel: 'uber' },
    merge: { id: '6611186', name: 'Mohammed Fazlul Karim Imran Abu Bakar Siddik', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mohammed fazlul siddik', part: 'link',
    keep: { id: '70f25511-3dd2-486a-927f-e19d5c2482ca', name: 'Mohammed Fazlul Siddik', channel: 'uber' },
    merge: { id: '0876b449-12ca-45dd-8f44-262b901a4772', name: 'Mohammed Fazlul Karim Imran Abu Bakar Siddik', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mohamed essam abdelfattah', part: 'link',
    keep: { id: 'e3796787-f3f9-41f9-a299-2e5862cbbf76', name: 'Mohamed Essam Abdelfattah', channel: 'uber' },
    merge: { id: '6818383', name: 'Mohamed Essam Abdelrazek Khalil Abdelfattah', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mohamed essam abdelfattah', part: 'link',
    keep: { id: 'e3796787-f3f9-41f9-a299-2e5862cbbf76', name: 'Mohamed Essam Abdelfattah', channel: 'uber' },
    merge: { id: '208a7776-fc88-4604-ab49-631437b77dd5', name: 'Mohamed Essam Abdelrazek Khalil Abdelfattah', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'mati ullah sharif khan', part: 'link',
    keep: { id: '67483c64055e070d791000f7', name: 'MATI ULLAH SHARIF KHAN', channel: 'hotel' },
    merge: { id: '33cce538-9975-4d96-b770-df1178d2ad5c', name: 'Mati Ulah Khan', channel: 'uber' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mati ullah sharif khan', part: 'link',
    keep: { id: '67483c64055e070d791000f7', name: 'MATI ULLAH SHARIF KHAN', channel: 'hotel' },
    merge: { id: '6781253', name: 'Mati Ullah Sharif Khan', channel: 'bolt' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'wahab ali zada', part: 'link',
    keep: { id: '261a9688-e59e-4b73-bf1a-3bbb2f52a271', name: 'Wahab Ali Zada', channel: 'uber' },
    merge: { id: '7841834', name: 'Wahab Ali Sahib Zada', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'wahab ali zada', part: 'link',
    keep: { id: '261a9688-e59e-4b73-bf1a-3bbb2f52a271', name: 'Wahab Ali Zada', channel: 'uber' },
    merge: { id: '6a4f4253b3b4e99c0391a15e', name: 'WAHAB ALI SAHIB ZADA', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-10-06' } }),
  fromReview({ key: 'wahab ali zada', part: 'link',
    keep: { id: '261a9688-e59e-4b73-bf1a-3bbb2f52a271', name: 'Wahab Ali Zada', channel: 'uber' },
    merge: { id: '72191eb6-9500-4974-a4cc-b8211333e809', name: 'Wahab Ali Sahib Zada', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'harish kumar chand', part: 'link',
    keep: { id: 'f6a10bac-7ea4-4b9a-b37a-a817aad5d7f9', name: 'Harish Kumar Chand', channel: 'uber' },
    merge: { id: '6628149', name: 'Harish Kumar Karam Chand', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'harish kumar chand', part: 'link',
    keep: { id: 'f6a10bac-7ea4-4b9a-b37a-a817aad5d7f9', name: 'Harish Kumar Chand', channel: 'uber' },
    merge: { id: '688a1c98a0bf23d354fda5a7', name: 'Harish Kumar Karam Chand', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-14' } }),
  fromReview({ key: 'ali nawaz muhammad nawaz', part: 'link',
    keep: { id: '67483c64055e070d791000f0', name: 'ALI NAWAZ MUHAMMAD NAWAZ', channel: 'hotel' },
    merge: { id: '6623707', name: 'Ali Nawaz Muhammad Nawaz', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' },
    contradictions: ['2025-10-18'] }),
  fromReview({ key: 'ali nawaz muhammad nawaz', part: 'link',
    keep: { id: '67483c64055e070d791000f0', name: 'ALI NAWAZ MUHAMMAD NAWAZ', channel: 'hotel' },
    merge: { id: '10e01fb59b184ab88dc750704a9bc10e', name: 'ALI NAWAZ', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' },
    contradictions: ['2025-10-18'] }),
  fromReview({ key: 'hamza iqbal sajid iqbal', part: 'link',
    keep: { id: 'a48e26a8-8c0a-41c5-bef8-72802cf1398f', name: 'Hamza Iqbal Sajid Iqbal', channel: 'uber' },
    merge: { id: '7838158', name: 'Hamza Iqbal Sajid Iqbal', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'hamza iqbal sajid iqbal', part: 'link',
    keep: { id: 'a48e26a8-8c0a-41c5-bef8-72802cf1398f', name: 'Hamza Iqbal Sajid Iqbal', channel: 'uber' },
    merge: { id: '68b94a08b0dc20d631c56a68', name: 'Hamza Iqbal Sajid Iqbal', channel: 'hotel' },
    link: { basis: 'shared_phone', confirmed: 'unknown' } }),
  fromReview({ key: 'hamza iqbal sajid iqbal', part: 'link',
    keep: { id: 'a48e26a8-8c0a-41c5-bef8-72802cf1398f', name: 'Hamza Iqbal Sajid Iqbal', channel: 'uber' },
    merge: { id: '48cfb2ac-0ddc-4742-96ed-6b1d2a09c491', name: 'Hamza Iqbal Sajid Iqbal', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad nazir khan', part: 'link',
    keep: { id: 'cc12b6f3-7ce0-4dae-afcd-4454dd36a401', name: 'Muhammad Nazir Khan', channel: 'uber' },
    merge: { id: '6ac3a5d36e0dbece4b47dd5d', name: 'Muhammad Nazir Zarin Khan', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-10-06' } }),
  fromReview({ key: 'muhammad sameer shamrez asghar', part: 'link',
    keep: { id: '67483c64055e070d79100131', name: 'MUHAMMAD SAMEER SHAMREZ ASGHAR', channel: 'hotel' },
    merge: { id: '6620288', name: 'Muhammad Sameer Shamrez Asghar', channel: 'bolt' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad sameer shamrez asghar', part: 'link',
    keep: { id: '67483c64055e070d79100131', name: 'MUHAMMAD SAMEER SHAMREZ ASGHAR', channel: 'hotel' },
    merge: { id: '9b9d8a53b6ea47f5a5b0e5e4ddca9d1f', name: 'muhammad sameer', channel: 'yango' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad shahab abbasi', part: 'link',
    keep: { id: '4e47dd44-842d-48bc-ae66-de5d08c3424d', name: 'Muhammad Shahab Abbasi', channel: 'uber' },
    merge: { id: '6997345', name: 'Muhammad Shahab Abbasi Muhammad Shahzad Abbasi', channel: 'bolt' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad shahab abbasi', part: 'link',
    keep: { id: '4e47dd44-842d-48bc-ae66-de5d08c3424d', name: 'Muhammad Shahab Abbasi', channel: 'uber' },
    merge: { id: '02578759-f32e-41c7-a096-51ebe1c046aa', name: 'Muhammad Shahab Abbasi Muhammad Shahzad Abbasi', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad shahab abbasi', part: 'link',
    keep: { id: '4e47dd44-842d-48bc-ae66-de5d08c3424d', name: 'Muhammad Shahab Abbasi', channel: 'uber' },
    merge: { id: '67483c64055e070d791000ff', name: 'Muhammad Shahab Abbasi Shahzad Abbasi', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'ullal abdul rasheed kotepura', part: 'link',
    keep: { id: '72d2f062-70d0-404a-8b52-00b4534446a2', name: 'Ullal Abdul Rasheed Kotepura', channel: 'uber' },
    merge: { id: '7501194', name: 'Ullah Abdul Rasheed Moosa Moosa Ullal Kotepura', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'ullal abdul rasheed kotepura', part: 'link',
    keep: { id: '72d2f062-70d0-404a-8b52-00b4534446a2', name: 'Ullal Abdul Rasheed Kotepura', channel: 'uber' },
    merge: { id: '68821890a0bf23d354fd700d', name: 'Ullal Abdul Rasheed Moosa Moosa Ullal Kotepura', channel: 'hotel' },
    link: { basis: 'shared_car_name', confirmed: '2026-10-06' } }),
  fromReview({ key: 'ullal abdul rasheed kotepura', part: 'link',
    keep: { id: '72d2f062-70d0-404a-8b52-00b4534446a2', name: 'Ullal Abdul Rasheed Kotepura', channel: 'uber' },
    merge: { id: '1fc71474-5345-46e9-b7d9-3f5a38bbdbf0', name: 'Ullah Abdul Rasheed Moosa Moosa Ullal Kotepura', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'kashif ali ayyub khan', part: 'link',
    keep: { id: '84d498cf-a74a-4750-9ac2-5eabdeec3b8d', name: 'Kashif Ali Ayyub khan', channel: 'uber' },
    merge: { id: '6620158', name: 'Kashif Ali Ayyub Khan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'kashif ali ayyub khan', part: 'link',
    keep: { id: '84d498cf-a74a-4750-9ac2-5eabdeec3b8d', name: 'Kashif Ali Ayyub khan', channel: 'uber' },
    merge: { id: 'a411e6c0e37c42f4869f4b230fc78292', name: 'Kashif Ali', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'arbab hassan rab nawaz', part: 'link',
    keep: { id: '68766dbe03051f14d95a8210', name: 'Arbab Hassan Rab Nawaz', channel: 'hotel' },
    merge: { id: '6d707fcd-fe3d-43f3-b0b9-778c798cacd0', name: 'Arbab Hassan Nawaz', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'arbab hassan rab nawaz', part: 'link',
    keep: { id: '68766dbe03051f14d95a8210', name: 'Arbab Hassan Rab Nawaz', channel: 'hotel' },
    merge: { id: '7605526', name: 'Arbab Hassan Rab Nawaz', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'faisal badshah rasool badshah', part: 'link',
    keep: { id: '67483c64055e070d79100109', name: 'FAISAL BADSHAH RASOOL BADSHAH', channel: 'hotel' },
    merge: { id: '6623598', name: 'Faisal Badshah Rasool Badshah', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' },
    contradictions: ['2026-04-21', '2026-05-01'] }),
  fromReview({ key: 'faisal badshah rasool badshah', part: 'link',
    keep: { id: '67483c64055e070d79100109', name: 'FAISAL BADSHAH RASOOL BADSHAH', channel: 'hotel' },
    merge: { id: 'd43113c2f35f4d7ea618c70845c85247', name: 'BADSHAH FAISAL', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-14' },
    contradictions: ['2026-04-21', '2026-05-01'] }),
  fromReview({ key: 'waqas riaz', part: 'link',
    keep: { id: 'f9ac5f80-275c-4320-b9c5-0535e69dfceb', name: 'Waqas Riaz Riaz', channel: 'uber' },
    merge: { id: '7727920', name: 'Waqas Riaz Muhammad Riaz', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'waqas riaz', part: 'link',
    keep: { id: 'f9ac5f80-275c-4320-b9c5-0535e69dfceb', name: 'Waqas Riaz Riaz', channel: 'uber' },
    merge: { id: 'a604d59c88e94a758ce9a19264fec2dc', name: 'Muhammad Riaz Waqas Riaz', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'aftab ahmed muhammad sharif altaf', part: 'link',
    keep: { id: '68905c41d0a931b9d7544982', name: 'Aftab Ahmed Muhammad Sharif Altaf', channel: 'hotel' },
    merge: { id: '7726833', name: 'Aftab Ahmed Muhammad Sharif Altaf', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'farman ullah ghafoor khan', part: 'link',
    keep: { id: 'de9a4044-c57e-427c-ae06-5bca66873857', name: 'Farman Ullah Ghafoor Khan', channel: 'uber' },
    merge: { id: '8181338', name: 'Farman Ullah Ghafoor Khan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'renato romillano yap', part: 'link',
    keep: { id: '92a7bd85-e275-4582-b792-b1922a2bf9b5', name: 'Renato Romillano Yap', channel: 'uber' },
    merge: { id: 'f6c68bff-3b30-436b-9481-ee0fa4da9958', name: 'Renato Romillano Yap', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'joseph wandera', part: 'link',
    keep: { id: '1e2311ad-cc26-4e2b-839a-41363ef67672', name: 'Joseph Wandera', channel: 'uber' },
    merge: { id: '7976866', name: 'Joseph Wandera', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'ahmed mohamed gadalla', part: 'link',
    keep: { id: '54c5a53d-ca40-4206-8a04-1f63d828e1c1', name: 'Ahmed Mohamed Gadalla', channel: 'uber' },
    merge: { id: '6611279', name: 'Ahmed Mohamed Ramadan Ahmed Gadalla', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'ahmed mohamed gadalla', part: 'link',
    keep: { id: '54c5a53d-ca40-4206-8a04-1f63d828e1c1', name: 'Ahmed Mohamed Gadalla', channel: 'uber' },
    merge: { id: '60003270-6e09-495b-b801-bbf4c6b7aa53', name: 'Ahmed Mohamed Ramadan Ahmed Gadalla', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-14' } }),
  fromReview({ key: 'alakbar rahimov', part: 'link',
    keep: { id: 'cf08a7df-1a9f-450c-92aa-baa8d9da5f7b', name: 'ALAKBAR RAHIMOV', channel: 'uber' },
    merge: { id: '8219954', name: 'Alakbar Rahimov', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'alakbar rahimov', part: 'link',
    keep: { id: 'cf08a7df-1a9f-450c-92aa-baa8d9da5f7b', name: 'ALAKBAR RAHIMOV', channel: 'uber' },
    merge: { id: '7b1408ba9a154514b1d2c6182eaf2d75', name: 'Alakbar Rahimov', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-18' } }),
  fromReview({ key: 'muhammad yaseen saeed ur rahman', part: 'link',
    keep: { id: '5ebc7cba-8f77-487e-aba9-ae5ff0111ed1', name: 'Muhammad Yaseen Saeed Ur Rahman', channel: 'uber' },
    merge: { id: '8175513', name: 'Muhammad Yaseen Saeed Ur Rahman', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'waseem abbas ghulam nabi', part: 'link',
    keep: { id: '6911c82f8c482942eaacf939', name: 'Waseem Abbas Ghulam Nabi', channel: 'hotel' },
    merge: { id: '8185992', name: 'Waseem Abbas Ghulam Nabi', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'waseem abbas ghulam nabi', part: 'link',
    keep: { id: '6911c82f8c482942eaacf939', name: 'Waseem Abbas Ghulam Nabi', channel: 'hotel' },
    merge: { id: '82b0abaeab4c4ee3b95fa8094978ca9a', name: 'Waseem Abbas Ghulam Nabi', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-18' } }),
  fromReview({ key: 'umair ahmad gul', part: 'link',
    keep: { id: '7ff1e0bb-8c80-4948-9cd8-86902625ac40', name: 'Umair Ahmad Gul', channel: 'uber' },
    merge: { id: '6640352', name: 'Umair Ahmad', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'umair ahmad gul', part: 'link',
    keep: { id: '7ff1e0bb-8c80-4948-9cd8-86902625ac40', name: 'Umair Ahmad Gul', channel: 'uber' },
    merge: { id: '67483c64055e070d791000eb', name: 'UMAIR AHMAD WAZIR GUL', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'umair ahmad gul', part: 'link',
    keep: { id: '7ff1e0bb-8c80-4948-9cd8-86902625ac40', name: 'Umair Ahmad Gul', channel: 'uber' },
    merge: { id: 'b3edf09c58f542e98ff5bd1068d178e8', name: 'UMAIR AHMAD', channel: 'yango' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'sikandar tariq hussain', part: 'link',
    keep: { id: '39042c26-8985-4f99-af1c-a990a63834e6', name: 'Sikandar Tariq Hussain', channel: 'uber' },
    merge: { id: '8074837', name: 'Sikandar Tariq Tariq Hussain', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'rashid khan muhammad', part: 'link',
    keep: { id: '793529a4-6264-497f-9dc5-e7f4e62cbc8a', name: 'Rashid Khan Muhammad', channel: 'uber' },
    merge: { id: '7624077', name: 'Rashid Khan Zar Muhammad', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'mohammad mokdassel md obaidullah', part: 'link',
    keep: { id: '67483c64055e070d79100125', name: 'MOHAMMAD MOKDASSEL MD OBAIDULLAH', channel: 'hotel' },
    merge: { id: '6a37fe4f-8f44-4af0-a043-5cc3e1ffdcb1', name: 'Mohammad Mokdassel Obaidullah', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'mohammad mokdassel md obaidullah', part: 'link',
    keep: { id: '67483c64055e070d79100125', name: 'MOHAMMAD MOKDASSEL MD OBAIDULLAH', channel: 'hotel' },
    merge: { id: '6628253', name: 'MOHAMMAD MOKDASSEL MD OBAIDULLAH', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abdul malik muhammad iqbal', part: 'link',
    keep: { id: '975db95e-0c42-4909-8597-53ffe66fadaf', name: 'Abdul Malik Muhammad Iqbal', channel: 'uber' },
    merge: { id: '6628607', name: 'Abdul Malik Muhammad Iqbal', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' },
    contradictions: ['2025-05-19'] }),
  fromReview({ key: 'abdul malik muhammad iqbal', part: 'link',
    keep: { id: '975db95e-0c42-4909-8597-53ffe66fadaf', name: 'Abdul Malik Muhammad Iqbal', channel: 'uber' },
    merge: { id: '67483c64055e070d791000d6', name: 'ABDUL MALIK MUHAMMAD IQBAL', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' },
    contradictions: ['2025-05-19'] }),
  fromReview({ key: 'henok melese amdisa', part: 'link',
    keep: { id: '2e9e87f5-7b0e-4ccd-af22-64d6bec268f4', name: 'Henok Melese Amdisa', channel: 'uber' },
    merge: { id: '7003039', name: 'Henok Melese Amdisa', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'henok melese amdisa', part: 'link',
    keep: { id: '2e9e87f5-7b0e-4ccd-af22-64d6bec268f4', name: 'Henok Melese Amdisa', channel: 'uber' },
    merge: { id: '8b20b014-d999-41cf-965f-c10363175d5e', name: 'Henok Melese Amdisa', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad hanan munir muhammad munir', part: 'link',
    keep: { id: '688085f5a0bf23d354fd60b0', name: 'Muhammad Hanan Munir Muhammad Munir', channel: 'hotel' },
    merge: { id: '7643624', name: 'Muhammad Hanan Munir Muhammad Munir', channel: 'bolt' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad hanan munir muhammad munir', part: 'link',
    keep: { id: '688085f5a0bf23d354fd60b0', name: 'Muhammad Hanan Munir Muhammad Munir', channel: 'hotel' },
    merge: { id: 'bdc98198249e4b6698131d2b5667bcd7', name: 'Muhammad Hanan', channel: 'yango' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad shafiq raziq', part: 'link',
    keep: { id: '011fdd5b-54af-453e-aa17-b6f86c5fe11f', name: 'Muhammad Shafiq Raziq', channel: 'uber' },
    merge: { id: '6623922', name: 'MUHAMMAD SHAFIQ', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad shafiq raziq', part: 'link',
    keep: { id: '011fdd5b-54af-453e-aa17-b6f86c5fe11f', name: 'Muhammad Shafiq Raziq', channel: 'uber' },
    merge: { id: '67483c64055e070d791000e9', name: 'MUHAMMAD SHAFIQ UMAR RAZIQ', channel: 'hotel' },
    link: { basis: 'shared_phone', confirmed: 'unknown' } }),
  fromReview({ key: 'bashir ahmad amin', part: 'link',
    keep: { id: '369dd9c1-ae0a-4526-8d46-d91a8c217121', name: 'Bashir Ahmad Amin', channel: 'uber' },
    merge: { id: '6a8dac427ba7dbf44436ca89', name: 'Bashir Ahmed Muhammad Amin', channel: 'hotel' },
    link: { basis: 'shared_phone', confirmed: 'unknown' } }),
  fromReview({ key: 'dawit zeraye haile', part: 'link',
    keep: { id: '4880dbcc-f2dd-45ed-a2b9-900bb61bc93b', name: 'Dawit Zeraye Haile', channel: 'uber' },
    merge: { id: '7238992', name: 'Dawit Zeraye Haile', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'dawit zeraye haile', part: 'link',
    keep: { id: '4880dbcc-f2dd-45ed-a2b9-900bb61bc93b', name: 'Dawit Zeraye Haile', channel: 'uber' },
    merge: { id: 'd10ed574-6f79-4f07-990a-5ec7f91a2df4', name: 'Dawit Zeraye Haile', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'ifraz ahmed ghulam ahmed', part: 'link',
    keep: { id: '68766c6303051f14d95a81ed', name: 'Ifraz Ahmed Ghulam Ahmed', channel: 'hotel' },
    merge: { id: 'bb4b1157-37e9-443c-82ef-1fb33660e9ad', name: 'Ifraz Ahmed Ahmed', channel: 'uber' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'ifraz ahmed ghulam ahmed', part: 'link',
    keep: { id: '68766c6303051f14d95a81ed', name: 'Ifraz Ahmed Ghulam Ahmed', channel: 'hotel' },
    merge: { id: '7523359', name: 'Ifraz Ahmed Ghulam Ahmed', channel: 'bolt' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'henry martin motha', part: 'link',
    keep: { id: '550133d0-affd-45b4-9082-0a95a39bd09f', name: 'Henry Martin Motha', channel: 'uber' },
    merge: { id: '8120259', name: 'Henry Martin Motha Henry Bennet Motha', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'henry martin motha', part: 'link',
    keep: { id: '550133d0-affd-45b4-9082-0a95a39bd09f', name: 'Henry Martin Motha', channel: 'uber' },
    merge: { id: '6904614c8c482942eaac6e48', name: 'Henry Martin Motha Henry Bennet Motha', channel: 'hotel' },
    link: { basis: 'shared_phone', confirmed: '2026-09-14' } }),
  fromReview({ key: 'henry martin motha', part: 'link',
    keep: { id: '550133d0-affd-45b4-9082-0a95a39bd09f', name: 'Henry Martin Motha', channel: 'uber' },
    merge: { id: '48a7ee6e-f6d7-4491-a811-798263d4616f', name: 'Henry Martin Motha Henry Bennet Motha', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad naqeeb gull', part: 'link',
    keep: { id: 'b629aefa-7fc1-4bbe-84db-25920914105d', name: 'Muhammad Naqeeb Gull', channel: 'uber' },
    merge: { id: '8636581', name: 'Muhammad Naqeeb Nasir Gull', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad naqeeb gull', part: 'link',
    keep: { id: 'b629aefa-7fc1-4bbe-84db-25920914105d', name: 'Muhammad Naqeeb Gull', channel: 'uber' },
    merge: { id: '67731662-84af-4378-a00d-664845eaee9a', name: 'Muhammad Naqeeb Nasir Gull', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'amir muhammad khan muhammad naeem khan', part: 'link',
    keep: { id: '1ffc17512bae40d2a6899f35aad12789', name: 'Amir Muhammad Khan Muhammad Naeem Khan', channel: 'yango' },
    merge: { id: '7874177', name: 'Muhammad Naeem Khan Amir Muhammad Khan', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mateen gul', part: 'link',
    keep: { id: '31ec8c94-1f92-4fe8-bcd3-8bf83ae928be', name: 'Mateen Gul Gul', channel: 'uber' },
    merge: { id: '6628730', name: 'Mateen Gul', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-18' } }),
  fromReview({ key: 'mateen gul', part: 'link',
    keep: { id: '31ec8c94-1f92-4fe8-bcd3-8bf83ae928be', name: 'Mateen Gul Gul', channel: 'uber' },
    merge: { id: '352cdd896af14ffca96d2fb943c99ad0', name: 'MATEEN GUL', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'sajid ayaz ahmed', part: 'link',
    keep: { id: '67483c64055e070d79100113', name: 'SAJID AYAZ AYAZ AHMED', channel: 'hotel' },
    merge: { id: 'fd30bb7f-8964-4195-8e94-125ae117772f', name: 'Sajid Ayaz Ahmed', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-18' } }),
  fromReview({ key: 'sajid ayaz ahmed', part: 'link',
    keep: { id: '67483c64055e070d79100113', name: 'SAJID AYAZ AYAZ AHMED', channel: 'hotel' },
    merge: { id: '6610666', name: 'Sajid Ayaz Ayaz Ahmed', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'kashan malik abdul malik', part: 'link',
    keep: { id: '67483c64055e070d791000fc', name: 'KASHAN MALIK ABDUL MALIK', channel: 'hotel' },
    merge: { id: '6628224', name: 'Kashan Malik Abdul Malik', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'kashan malik abdul malik', part: 'link',
    keep: { id: '67483c64055e070d791000fc', name: 'KASHAN MALIK ABDUL MALIK', channel: 'hotel' },
    merge: { id: 'f4a294bd4b48456496921e542e58e79e', name: 'KASHAN MALIK', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'moses bale', part: 'link',
    keep: { id: '628fbdea-1404-4289-a5b5-9bab4dc69cf0', name: 'Moses Bale', channel: 'uber' },
    merge: { id: '7976847', name: 'Moses Bale', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mirza abdullah baig mirza zahid baig', part: 'link',
    keep: { id: '67483c64055e070d7910010d', name: 'MIRZA ABDULLAH BAIG MIRZA ZAHID BAIG', channel: 'hotel' },
    merge: { id: '16b7df80-d744-4dc4-87d2-7a7d588d849e', name: 'Mirza Abdullah Baig', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'mirza abdullah baig mirza zahid baig', part: 'link',
    keep: { id: '67483c64055e070d7910010d', name: 'MIRZA ABDULLAH BAIG MIRZA ZAHID BAIG', channel: 'hotel' },
    merge: { id: '6628129', name: 'Mirza Abdullah baig Mirza Zahid baig', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'zeeshan nadeem akram', part: 'link',
    keep: { id: '8189219b-6037-4114-9e80-4847e7cd842f', name: 'Zeeshan Nadeem Nadeem Akram', channel: 'uber' },
    merge: { id: '6611073', name: 'Zeeshan Nadeem Nadeem Akram', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-17' },
    contradictions: ['2025-10-20', '2025-10-23'] }),
  fromReview({ key: 'zeeshan nadeem akram', part: 'link',
    keep: { id: '8189219b-6037-4114-9e80-4847e7cd842f', name: 'Zeeshan Nadeem Nadeem Akram', channel: 'uber' },
    merge: { id: '67483c64055e070d79100132', name: 'ZEESHAN NADEEM NADEEM AKRAM', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-17' },
    contradictions: ['2025-10-20', '2025-10-23'] }),
  fromReview({ key: 'bilal ahmad haji rehman', part: 'link',
    keep: { id: '67483c64055e070d79100106', name: 'BILAL AHMAD HAJI REHMAN', channel: 'hotel' },
    merge: { id: '6e53bb51-d55e-4370-b855-10cb8025b936', name: 'Bilal Ahmad rehman', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-14' } }),
  fromReview({ key: 'bilal ahmad haji rehman', part: 'link',
    keep: { id: '67483c64055e070d79100106', name: 'BILAL AHMAD HAJI REHMAN', channel: 'hotel' },
    merge: { id: '6628147', name: 'Bilal Ahmad Haji Rehman', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad rahim muhammad saleem', part: 'link',
    keep: { id: '67483c64055e070d79100103', name: 'MUHAMMAD RAHIM MUHAMMAD SALEEM', channel: 'hotel' },
    merge: { id: '7cf929d6-45fa-4b87-ac1f-4469ef103358', name: 'Muhammad Rahim Saleem', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'muhammad rahim muhammad saleem', part: 'link',
    keep: { id: '67483c64055e070d79100103', name: 'MUHAMMAD RAHIM MUHAMMAD SALEEM', channel: 'hotel' },
    merge: { id: '6628824', name: 'Muhammad Rahim Muhammad Saleem', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'andreh elias aoun', part: 'link',
    keep: { id: 'eb7c8909-2a1b-418d-a920-49dced4913e0', name: 'Andreh Elias Aoun', channel: 'uber' },
    merge: { id: '567a259c-9610-4fea-9704-7e9bfd8397ad', name: 'Andreh Elias Aoun', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'wajid rehman nausherwan', part: 'link',
    keep: { id: 'ca15a7c6-5df0-4bdc-abec-918c78876c47', name: 'Wajid Rehman Nausherwan', channel: 'uber' },
    merge: { id: '6939735', name: 'Wajid Rehman Nausherwan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'wajid rehman nausherwan', part: 'link',
    keep: { id: 'ca15a7c6-5df0-4bdc-abec-918c78876c47', name: 'Wajid Rehman Nausherwan', channel: 'uber' },
    merge: { id: '67483c64055e070d791000fb', name: 'WAJID REHMAN NAUSHERWAN', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'chahat ravinder', part: 'link',
    keep: { id: '23a9d6f0-c916-477d-8624-91038a7d9fb8', name: 'Chahat Ravinder', channel: 'uber' },
    merge: { id: '9048361', name: 'Chahat Ravinder', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'chahat ravinder', part: 'link',
    keep: { id: '23a9d6f0-c916-477d-8624-91038a7d9fb8', name: 'Chahat Ravinder', channel: 'uber' },
    merge: { id: 'c9943fab-aca7-42c3-a7b6-bb91a298f1b3', name: 'Chahat Ravinder', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'hassan talaat kamel abousira', part: 'link',
    keep: { id: '293f7986-1768-4c56-8317-133ee31d89fb', name: 'Hassan Talaat Kamel Abousira', channel: 'uber' },
    merge: { id: '8143925', name: 'Hassan Talaat Kamel Abousira', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'midrar khan', part: 'link',
    keep: { id: '6f48f5a4-747f-4272-bbec-a413272103e5', name: 'Midrar Khan Khan', channel: 'uber' },
    merge: { id: '6634999', name: 'MIDRAR KHAN MISRI KHAN', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'midrar khan', part: 'link',
    keep: { id: '6f48f5a4-747f-4272-bbec-a413272103e5', name: 'Midrar Khan Khan', channel: 'uber' },
    merge: { id: '67483c64055e070d7910011a', name: 'Midrar Khan Misri Khan', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'hasan wadie alabaza', part: 'link',
    keep: { id: '2c06cfc8-df51-4c32-af89-64fb16699a1b', name: 'Hasan Wadie Alabaza', channel: 'uber' },
    merge: { id: '6611356', name: 'Hasan Wadie Alabaza', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'hasan wadie alabaza', part: 'link',
    keep: { id: '2c06cfc8-df51-4c32-af89-64fb16699a1b', name: 'Hasan Wadie Alabaza', channel: 'uber' },
    merge: { id: 'f9aa707b-6b85-460c-91c5-b88df7808758', name: 'Hasan Wadie Alabaza', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'zahid ullah afsar zada', part: 'link',
    keep: { id: 'faab28eb-79bf-4863-b430-1d0d2167bb05', name: 'Zahid Ullah Afsar Zada', channel: 'uber' },
    merge: { id: '6663860', name: 'Zahid Ullah Afsar Zada', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'zahid ullah afsar zada', part: 'link',
    keep: { id: 'faab28eb-79bf-4863-b430-1d0d2167bb05', name: 'Zahid Ullah Afsar Zada', channel: 'uber' },
    merge: { id: '67483c64055e070d79100127', name: 'ZAHID ULLAH AFSAR ZADA', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'danish rehman haji rehman', part: 'link',
    keep: { id: '67483c64055e070d79100111', name: 'DANISH REHMAN HAJI REHMAN', channel: 'hotel' },
    merge: { id: '6a242abc-ea2e-4a67-8d70-ce4644875dd5', name: 'Danish Rehman Rehman', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'danish rehman haji rehman', part: 'link',
    keep: { id: '67483c64055e070d79100111', name: 'DANISH REHMAN HAJI REHMAN', channel: 'hotel' },
    merge: { id: '6623840', name: 'Danish Rehman', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'mohammad naeem adam khan', part: 'link',
    keep: { id: '67483c64055e070d79100117', name: 'MOHAMMAD NAEEM ADAM KHAN', channel: 'hotel' },
    merge: { id: '6615750', name: 'Mohammad Naeem Adam Khan', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'chingiz seftarov', part: 'link',
    keep: { id: '8b41f469-689e-455d-8b00-ff2a37d9a7ec', name: 'Chingiz Seftarov', channel: 'uber' },
    merge: { id: '8108061', name: 'Chingiz Saftarov', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'chingiz seftarov', part: 'link',
    keep: { id: '8b41f469-689e-455d-8b00-ff2a37d9a7ec', name: 'Chingiz Seftarov', channel: 'uber' },
    merge: { id: '4ca00da1-292a-464e-82c5-f7702b135331', name: 'Chingiz Saftarov', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad ishtiaq khan', part: 'link',
    keep: { id: 'd1925319-0544-48c6-a2fb-a9098f311a65', name: 'Muhammad Ishtiaq Khan', channel: 'uber' },
    merge: { id: '41dd8378ea3a4998a7a1ad70cf1656ba', name: 'MUHAMMAD ISHTIAQ', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'aman ullah amir mehboob alam', part: 'link',
    keep: { id: '68766d7d03051f14d95a8209', name: 'Aman Ullah Amir Mehboob Alam', channel: 'hotel' },
    merge: { id: '7569135', name: 'Aman Ullah Amir Mehboob Alam', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abdul hannan momin', part: 'link',
    keep: { id: 'ea186ae2-197c-4a1c-a1cd-ae56643e6f73', name: 'Abdul Hannan Momin', channel: 'uber' },
    merge: { id: '6610828', name: 'Abdul Hannan Momin Humayun Habib Momin', channel: 'bolt' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'jawad khan gohar', part: 'link',
    keep: { id: '1c16bca7-d064-42b6-bc63-04758e74a06e', name: 'Jawad Khan Gohar', channel: 'uber' },
    merge: { id: '6901251', name: 'Jawad Khan Ali Gohar', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' },
    contradictions: ['2025-10-22'] }),
  fromReview({ key: 'jawad khan gohar', part: 'link',
    keep: { id: '1c16bca7-d064-42b6-bc63-04758e74a06e', name: 'Jawad Khan Gohar', channel: 'uber' },
    merge: { id: '68766b8003051f14d95a81dc', name: 'Jawad Khan Ali Gohar', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' },
    contradictions: ['2025-10-22'] }),
  fromReview({ key: 'zain ul abideen muhammad irfan', part: 'link',
    keep: { id: '67483c64055e070d791000df', name: 'ZAIN UL ABIDEEN MUHAMMAD IRFAN', channel: 'hotel' },
    merge: { id: '6610637', name: 'Zain Ul Abideen Muhammad Irfan', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad faraz khan', part: 'link',
    keep: { id: 'c4febff7-604d-4ce8-90db-d0730bcac155', name: 'Muhammad Faraz Khan', channel: 'uber' },
    merge: { id: '6997157', name: 'Muhammad Faraz Khan Muhammad Farooq Khan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad faraz khan', part: 'link',
    keep: { id: 'c4febff7-604d-4ce8-90db-d0730bcac155', name: 'Muhammad Faraz Khan', channel: 'uber' },
    merge: { id: '35067d2a-3f1e-402e-97f3-fc87657c8153', name: 'Muhammad Faraz Khan Muhammad Farooq Khan', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'kazi fuad ahmed kazi alim ullah', part: 'link',
    keep: { id: '67483c64055e070d791000ca', name: 'Kazi Fuad Ahmed Kazi Alim Ullah', channel: 'hotel' },
    merge: { id: '6610628', name: 'Kazi Fuad Ahmed Kazi Alim Ullah', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'kazi fuad ahmed kazi alim ullah', part: 'link',
    keep: { id: '67483c64055e070d791000ca', name: 'Kazi Fuad Ahmed Kazi Alim Ullah', channel: 'hotel' },
    merge: { id: 'a9634a34f151436da7669fda9cc58bbc', name: 'KAZI AHMED', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'muhammad ihtisham zaman', part: 'link',
    keep: { id: 'a0644707-82d1-496b-b6eb-656d9b3b32ef', name: 'Muhammad Ihtisham Zaman', channel: 'uber' },
    merge: { id: '6633745', name: 'Muhammad Ihtisham Muhammad Zaman', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad ihtisham zaman', part: 'link',
    keep: { id: 'a0644707-82d1-496b-b6eb-656d9b3b32ef', name: 'Muhammad Ihtisham Zaman', channel: 'uber' },
    merge: { id: '67483c64055e070d7910012b', name: 'MUHAMMAD IHTISHAM MUHAMMAD ZAMAN', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'arivoli rajendran', part: 'link',
    keep: { id: '2d4e39b2-43cb-4e51-ac1f-cd4fc0612528', name: 'Arivoli Rajendran Rajendran', channel: 'uber' },
    merge: { id: '6611196', name: 'Arivoli Rajendran Rajendran', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'arivoli rajendran', part: 'link',
    keep: { id: '2d4e39b2-43cb-4e51-ac1f-cd4fc0612528', name: 'Arivoli Rajendran Rajendran', channel: 'uber' },
    merge: { id: 'fb82dc91-90f6-4f1b-9793-b97ccea96640', name: 'Arivoli Rajendran Rajendran', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad talha qureshi', part: 'link',
    keep: { id: '9afe2406-3ca9-4061-96c2-fa0e1db93720', name: 'Muhammad Talha Qureshi', channel: 'uber' },
    merge: { id: '7636498', name: 'Muhammad Talha Mummar Shah Qureshi', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-10-06' } }),
  fromReview({ key: 'muhammad talha qureshi', part: 'link',
    keep: { id: '9afe2406-3ca9-4061-96c2-fa0e1db93720', name: 'Muhammad Talha Qureshi', channel: 'uber' },
    merge: { id: '688218d1a0bf23d354fd7014', name: 'Muhammad Talha Mummar Shah Qureshi', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-10-06' } }),
  fromReview({ key: 'muhammad talha qureshi', part: 'link',
    keep: { id: '9afe2406-3ca9-4061-96c2-fa0e1db93720', name: 'Muhammad Talha Qureshi', channel: 'uber' },
    merge: { id: '812895dc-41b5-4c11-bcb4-fdfdc308c73e', name: 'Muhammad Talha Mummar Shah Qureshi', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'saad ali akram muhammad akram bhatti', part: 'link',
    keep: { id: '67483c64055e070d791000d9', name: 'SAAD ALI AKRAM MUHAMMAD AKRAM BHATTI', channel: 'hotel' },
    merge: { id: '6907719', name: 'Saad Ali Akram Muhammad Akram Bhatti', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'saad ali akram muhammad akram bhatti', part: 'link',
    keep: { id: '67483c64055e070d791000d9', name: 'SAAD ALI AKRAM MUHAMMAD AKRAM BHATTI', channel: 'hotel' },
    merge: { id: 'dd4a45c2d6f3449da9807d81558ecbd2', name: 'Saad Ali Akram', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'abdul basit aman', part: 'link',
    keep: { id: '6d609028-a86c-4cee-92ef-7bae26e0cca8', name: 'Abdul Basit Aman', channel: 'uber' },
    merge: { id: '8168176', name: 'Abdul Basit Aman', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'irfan ullah awal ameen', part: 'link',
    keep: { id: '04c30a0a-1d4f-40f3-b9aa-378ed5ceeee4', name: 'Irfan Ullah Awal Ameen', channel: 'uber' },
    merge: { id: '6814489', name: 'Irfan Ullah Awal Ameen', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'irfan ullah awal ameen', part: 'link',
    keep: { id: '04c30a0a-1d4f-40f3-b9aa-378ed5ceeee4', name: 'Irfan Ullah Awal Ameen', channel: 'uber' },
    merge: { id: 'f7aad3d6075f4e788a303ce744d9986c', name: 'IRFAN ULLAH', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-14' } }),
  fromReview({ key: 'khalid abdalrahman albadwi', part: 'link',
    keep: { id: 'fc05f592-46a1-4353-b843-88e5c6dbec2c', name: 'Khalid Abdalrahman Albadwi', channel: 'uber' },
    merge: { id: '6610644', name: 'Khalid Abdalrahman Basher Albadwi', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'khalid abdalrahman albadwi', part: 'link',
    keep: { id: 'fc05f592-46a1-4353-b843-88e5c6dbec2c', name: 'Khalid Abdalrahman Albadwi', channel: 'uber' },
    merge: { id: '67483c64055e070d791000c7', name: 'Khalid Abdalrahman Basher Albadwi', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'muhammad rahim rauf', part: 'link',
    keep: { id: 'e3c961d9-9bfa-439e-b711-32f825a085d5', name: 'Muhammad Rahim Rauf', channel: 'uber' },
    merge: { id: '6600403', name: 'MOHAMMAD RAHIM SHAHZAD ABDUL RAUF', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad rahim rauf', part: 'link',
    keep: { id: 'e3c961d9-9bfa-439e-b711-32f825a085d5', name: 'Muhammad Rahim Rauf', channel: 'uber' },
    merge: { id: '4ea45e6f-f67f-4484-b5cf-f254e618eeab', name: 'MOHAMMAD RAHIM SHAHZAD ABDUL RAUF', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'edwin nyasani mandere', part: 'link',
    keep: { id: '6a48ed8f13880329d04ebbbd', name: 'Edwin Nyasani Mandere', channel: 'hotel' },
    merge: { id: '9048366', name: 'Edwin Nyasani Mandere', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad zeeshan muhammad shahid', part: 'link',
    keep: { id: '4d57e153e6ff455782e4954a7862099a', name: 'Muhammad Zeeshan Muhammad Shahid', channel: 'yango' },
    merge: { id: '7874167', name: 'Muhammad Zeeshan Ahmed Muhammad Shahid', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'muhammad zeeshan muhammad shahid', part: 'link',
    keep: { id: '4d57e153e6ff455782e4954a7862099a', name: 'Muhammad Zeeshan Muhammad Shahid', channel: 'yango' },
    merge: { id: '6a4e97abb3b4e99c0391914e', name: 'Muhammad Zeeshan Ahmed Shahid', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'wajahat khan', part: 'link',
    keep: { id: 'eeaac51c-2c12-48cf-aee7-5593ee6573ad', name: 'Wajahat Khan', channel: 'uber' },
    merge: { id: '6785544', name: 'Wajahat Ur Rehman Munir Khan', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'wajahat khan', part: 'link',
    keep: { id: 'eeaac51c-2c12-48cf-aee7-5593ee6573ad', name: 'Wajahat Khan', channel: 'uber' },
    merge: { id: 'a206c164ad194fe385209d40a17e5246', name: 'wajahat ur rehman', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'wajahat khan', part: 'link',
    keep: { id: 'eeaac51c-2c12-48cf-aee7-5593ee6573ad', name: 'Wajahat Khan', channel: 'uber' },
    merge: { id: '67483c64055e070d791000e6', name: 'WAJAHAT UR REHMAN MUNIR KHAN', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'abusaad siddiqui akhlaque ahmad', part: 'link',
    keep: { id: '68f744f88c482942eaaba18b', name: 'Abusaad Siddiqui Akhlaque Ahmad', channel: 'hotel' },
    merge: { id: '8110251', name: 'Abusaad Siddiqui Akhlaque Ahmad', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abusaad siddiqui akhlaque ahmad', part: 'link',
    keep: { id: '68f744f88c482942eaaba18b', name: 'Abusaad Siddiqui Akhlaque Ahmad', channel: 'hotel' },
    merge: { id: 'd6892f17ac534650b6855ffa3161f6bb', name: 'Abusaad Siddiqui Akhlaque Ahmad', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-18' } }),
  fromReview({ key: 'ali raza shah', part: 'link',
    keep: { id: '3cf1fcd4-1087-4b72-8598-6dffe3fe86e0', name: 'Ali Raza Shah', channel: 'uber' },
    merge: { id: '7202128', name: 'Ali Raza Shah Muhammad Sadiq Shah', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'ali raza shah', part: 'link',
    keep: { id: '3cf1fcd4-1087-4b72-8598-6dffe3fe86e0', name: 'Ali Raza Shah', channel: 'uber' },
    merge: { id: '0cb17332-9d08-4d1e-8806-898ad47d784d', name: 'Ali Raza Shah Muhammad Sadiq Shah', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'norah chia nsom', part: 'link',
    keep: { id: '8daae9c7-5a34-4e67-a178-565b92191461', name: 'Norah Chia Nsom', channel: 'uber' },
    merge: { id: '9131685', name: 'Norah Chia Nsom', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' },
    contradictions: ['2026-09-03'] }),
  fromReview({ key: 'muhammad sheraz muhammad', part: 'link',
    keep: { id: 'd4862a73-6317-4fa8-ad19-8c7a95e9e74d', name: 'Muhammad sheraz Muhammad', channel: 'uber' },
    merge: { id: '6aa01aee0b289436de6ec0d2', name: 'Muhammad Sheraz Amir Muhammad', channel: 'hotel' },
    link: { basis: 'shared_phone', confirmed: '2026-09-15' } }),
  fromReview({ key: 'muhammad ali bajwa', part: 'strong',
    keep: { id: '03e77aa0-87b4-4a8a-a2ec-2784d831c4f8', name: 'Muhammad Ali Bajwa', channel: 'uber' },
    merge: { id: '6864801', name: 'Muhammad Ali Maqsood Ahmad Tariq Bajwa', channel: 'bolt' },
    seen: { days: 71, shared: 66, interleaved: 46, atOnce: 0, plates: ['L36374', 'L63960', 'L75104'] } }),
  fromReview({ key: 'zahid ezazullah', part: 'link',
    keep: { id: '1da7bc60-8f0c-47e5-a25d-e7e30647faed', name: 'Zahid  Ezaz Ezazullah', channel: 'uber' },
    merge: { id: '6623648', name: 'Zahid Ezaz Ezazullah', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'atif shabbir', part: 'link',
    keep: { id: 'a5465ff1-317a-4d67-ac54-cce9999f725c', name: 'Atif Shabbir Shabbir', channel: 'uber' },
    merge: { id: '6623561', name: 'Atif Shabbir', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'maqsood muhabat shah', part: 'link',
    keep: { id: 'bed790a1-d986-4b0d-b6a3-5f9854789263', name: 'Maqsood Muhabat Shah', channel: 'uber' },
    merge: { id: '6934090', name: 'Maqsood Muhabat Shah Muhabat Shah', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'mansoor mohammad naeem', part: 'link',
    keep: { id: 'fd0284aa-489a-4e53-aa9d-23c2512fe2dd', name: 'Mansoor Mohammad Naeem', channel: 'uber' },
    merge: { id: '7416662', name: 'Mansoor Mohammad Naeem', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mansoor mohammad naeem', part: 'link',
    keep: { id: 'fd0284aa-489a-4e53-aa9d-23c2512fe2dd', name: 'Mansoor Mohammad Naeem', channel: 'uber' },
    merge: { id: 'ba2f3489-1277-4a64-9671-f800173b0aae', name: 'Mansoor Mohammad Naeem', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad ahmad ghulam qadir', part: 'link',
    keep: { id: '6a7f3e80d87732ee9b2068a3', name: 'MUHAMMAD AHMAD GHULAM QADIR', channel: 'hotel' },
    merge: { id: '9324842', name: 'Muhammad Ahmad Ghulam Qadir', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'cedric wendkuni kabore', part: 'link',
    keep: { id: '8e4e351c-aba6-4141-994f-55cffd844191', name: 'Cedric Wendkuni Kabore', channel: 'uber' },
    merge: { id: '7523326', name: 'Cedric Wendkuni Kabore', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'cedric wendkuni kabore', part: 'link',
    keep: { id: '8e4e351c-aba6-4141-994f-55cffd844191', name: 'Cedric Wendkuni Kabore', channel: 'uber' },
    merge: { id: '68766c9e03051f14d95a81f4', name: 'Cedric Wendkuni Kabore', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad masood kishbar khan', part: 'link',
    keep: { id: '67483c64055e070d791000d7', name: 'MUHAMMAD MASOOD KISHBAR KHAN', channel: 'hotel' },
    merge: { id: 'c9948e92-9d32-40bb-91ec-1b3d124647f9', name: 'Muhammad Masood Khan', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'muhammad masood kishbar khan', part: 'link',
    keep: { id: '67483c64055e070d791000d7', name: 'MUHAMMAD MASOOD KISHBAR KHAN', channel: 'hotel' },
    merge: { id: '6628159', name: 'Muhammad Masood Kishbar Khan', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad amir misree khan', part: 'link',
    keep: { id: '67483c64055e070d791000d3', name: 'MUHAMMAD AMIR MISREE KHAN', channel: 'hotel' },
    merge: { id: '6640621', name: 'Muhammad Amir Misree Khan', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'rashid ali haji hussain', part: 'link',
    keep: { id: '43183d548e3e487b9a5227705ace4719', name: 'Rashid Ali Haji Hussain', channel: 'yango' },
    merge: { id: '8203414', name: 'Rashid Ali Haji Hussain', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'sar zamin khan shah bahadar', part: 'link',
    keep: { id: '69411d3a8c482942eaaf083e', name: 'Sar Zamin Khan Shah Bahadar', channel: 'hotel' },
    merge: { id: '8410975', name: 'Sar Zamin Khan Shah Bahadar', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'sameh talaat abdelmaksoud abdelsamie', part: 'link',
    keep: { id: '67483c64055e070d7910010f', name: 'SAMEH TALAAT ABDELMAKSOUD ABDELSAMIE', channel: 'hotel' },
    merge: { id: '8fb45c4e-a2ab-413b-9069-355902279de9', name: 'Sameh Talaat Abdelsamie', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'sameh talaat abdelmaksoud abdelsamie', part: 'strong',
    keep: { id: '67483c64055e070d7910010f', name: 'SAMEH TALAAT ABDELMAKSOUD ABDELSAMIE', channel: 'hotel' },
    merge: { id: '6628152', name: 'SAMEH TALAAT ABDELMAKSOUD ABD ELSAMIE', channel: 'bolt' },
    seen: { days: 154, shared: 90, interleaved: 63, atOnce: 0, plates: ['L45232', 'L46183', 'L81970', 'L91248'] } }),
  fromReview({ key: 'saddam hussain islam', part: 'link',
    keep: { id: '5621f561-9a06-42ad-a85e-c10a751bb216', name: 'Saddam Hussain Islam', channel: 'uber' },
    merge: { id: '9492548', name: 'Saddam Hussain Muhammad islam', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'saddam hussain islam', part: 'link',
    keep: { id: '5621f561-9a06-42ad-a85e-c10a751bb216', name: 'Saddam Hussain Islam', channel: 'uber' },
    merge: { id: '494e1f9c-909d-453e-8588-8c12b4c0ddcc', name: 'Saddam Hussain Muhammad islam', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'zia ullah nasrullah khan', part: 'link',
    keep: { id: 'f01ca0ae-6f62-406e-8115-a881f33a811e', name: 'Zia Ullah Nasrullah Khan', channel: 'uber' },
    merge: { id: '6628537', name: 'ZIA ULLAH NASRULLAH KHAN', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'zia ullah nasrullah khan', part: 'link',
    keep: { id: 'f01ca0ae-6f62-406e-8115-a881f33a811e', name: 'Zia Ullah Nasrullah Khan', channel: 'uber' },
    merge: { id: '805583c3bc6e450aa33ad320e991e714', name: 'ZIA ULLAH', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'zia ullah nasrullah khan', part: 'link',
    keep: { id: 'f01ca0ae-6f62-406e-8115-a881f33a811e', name: 'Zia Ullah Nasrullah Khan', channel: 'uber' },
    merge: { id: '67483c64055e070d79100108', name: 'ZIA ULLAH NASRULLAH KHAN Nasrullah', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'muhammad hasham tanveer ahmad khan', part: 'link',
    keep: { id: '67483c64055e070d791000e2', name: 'MUHAMMAD HASHAM TANVEER TANVEER AHMAD KHAN', channel: 'hotel' },
    merge: { id: '7300699', name: 'Muhammad Hasham Tanveer Tanveer Ahmad Khan', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'sabbir hossain shahalom', part: 'link',
    keep: { id: '006e7f5c-f7c4-45f2-bd00-336121105d3f', name: 'Sabbir Hossain Shahalom', channel: 'uber' },
    merge: { id: 'fa1379f659d343409a1807a4e0e2e1fd', name: 'Sabbir Shahalom', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'hassan munawar shaad', part: 'link',
    keep: { id: '454fefba-ff66-4995-b9c5-f70d1fda7dd5', name: 'Hassan Munawar Shaad', channel: 'uber' },
    merge: { id: '6880673', name: 'HASSAN MUNAWAR MUNAWAR AHMED SHAAD', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'hassan munawar shaad', part: 'link',
    keep: { id: '454fefba-ff66-4995-b9c5-f70d1fda7dd5', name: 'Hassan Munawar Shaad', channel: 'uber' },
    merge: { id: 'f157aac8-ff4d-489d-9d35-1d96ffc5e4ca', name: 'HASSAN MUNAWAR MUNAWAR AHMED SHAAD', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'imad khan darwish khan', part: 'link',
    keep: { id: '6628162', name: 'Imad Khan Darwish Khan', channel: 'bolt' },
    merge: { id: '67483c64055e070d79100124', name: 'IMAD KHAN DARWISH KHAN', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'zain hassan raja nasrullah khan', part: 'link',
    keep: { id: 'c873a0fe-fea0-47a1-8b0d-e620e9675610', name: 'Zain Hassan Raja Nasrullah Khan', channel: 'uber' },
    merge: { id: '9081508', name: 'Zain Hassan Raja Nasrullah Khan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'zain hassan raja nasrullah khan', part: 'link',
    keep: { id: 'c873a0fe-fea0-47a1-8b0d-e620e9675610', name: 'Zain Hassan Raja Nasrullah Khan', channel: 'uber' },
    merge: { id: '36f2a997f1ef434fa3fbd2d63d945c05', name: 'Zain Raja', channel: 'yango' },
    link: { basis: 'shared_phone', confirmed: 'unknown' } }),
  fromReview({ key: 'rizwan ullah muzamil khan', part: 'link',
    keep: { id: '67483c64055e070d79100118', name: 'Rizwan Ullah Muzamil Khan', channel: 'hotel' },
    merge: { id: '0a688852-8cbb-4661-ae26-a2a0057b2690', name: 'Rizwan Ullah Muzamil Khan', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'rizwan ullah muzamil khan', part: 'link',
    keep: { id: '67483c64055e070d79100118', name: 'Rizwan Ullah Muzamil Khan', channel: 'hotel' },
    merge: { id: '6623653', name: 'RIZWAN ULLAH MUZAMIL KHAN', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abdelmohsen said ghanem', part: 'link',
    keep: { id: 'a7ee8da6-f312-4b76-b925-f6682e2fed12', name: 'Abdelmohsen Said Ghanem', channel: 'uber' },
    merge: { id: '6901485', name: 'Abdelmohsen Said Abdelmohsen Mohamed Salem', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abdelmohsen said ghanem', part: 'link',
    keep: { id: 'a7ee8da6-f312-4b76-b925-f6682e2fed12', name: 'Abdelmohsen Said Ghanem', channel: 'uber' },
    merge: { id: '785f350f-47d2-4b3a-99a5-923f01d8f7c9', name: 'Abdelmohsen Said Abdelmohsen Mohamed Salem', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'wunibie mohammed issah', part: 'link',
    keep: { id: 'c0520901-3066-4f65-977c-a40e324e38ae', name: 'Wunibie Mohammed Issah', channel: 'uber' },
    merge: { id: '9481149', name: 'Wunibie Mohammed Issah', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'wunibie mohammed issah', part: 'link',
    keep: { id: 'c0520901-3066-4f65-977c-a40e324e38ae', name: 'Wunibie Mohammed Issah', channel: 'uber' },
    merge: { id: '76f1b791-52ad-4c1a-899c-c2b9c2d8db36', name: 'Wunibie Mohammed Issah', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'ubaid ullah hassan muhammad', part: 'link',
    keep: { id: '9cf2c3e7-896a-4265-9600-0a5c16bbc9fe', name: 'Ubaid Ullah Hassan Muhammad', channel: 'uber' },
    merge: { id: '6835351', name: 'Ubaid Ullah Hassan Muhammad', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'ubaid ullah hassan muhammad', part: 'link',
    keep: { id: '9cf2c3e7-896a-4265-9600-0a5c16bbc9fe', name: 'Ubaid Ullah Hassan Muhammad', channel: 'uber' },
    merge: { id: '67483c64055e070d791000ce', name: 'UBAID ULLAH HASSAN MUHAMMAD', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'sebastian jerones', part: 'link',
    keep: { id: '1b7f45d7-1638-4f3a-a254-8d8b3b922ff7', name: 'Sebastian  Jerones Jerones', channel: 'uber' },
    merge: { id: '9503883', name: 'Sebastian Jerones Jerones', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'majid shah mehboob shah', part: 'link',
    keep: { id: '67483c64055e070d791000ee', name: 'MAJID SHAH MEHBOOB SHAH', channel: 'hotel' },
    merge: { id: 'a4da2085550d423f9c20d374473e474f', name: 'MAJID SHAH', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'nizam wazir zada', part: 'link',
    keep: { id: 'cc926625-4342-4b87-8311-07fc765ffddf', name: 'Nizam Wazir Zada', channel: 'uber' },
    merge: { id: '8348168', name: 'Nizam Wazir Zada', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' },
    contradictions: ['2026-08-26'] }),
  fromReview({ key: 'nizam wazir zada', part: 'link',
    keep: { id: 'cc926625-4342-4b87-8311-07fc765ffddf', name: 'Nizam Wazir Zada', channel: 'uber' },
    merge: { id: '693a7cea8c482942eaaec601', name: 'Nizam Wazir Zada', channel: 'hotel' },
    link: { basis: 'same_name', confirmed: '2026-09-21' },
    contradictions: ['2026-08-26'] }),
  fromReview({ key: 'muhammad hussnain muhammad rafique', part: 'link',
    keep: { id: '6594329', name: 'Muhammad Hussnain Muhammad Rafique', channel: 'bolt' },
    merge: { id: '6cf65aa1-b9b6-4efc-b006-a0a4bde7a2f4', name: 'Muhammad Hussnain Muhammad Rafique', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad aqib khan', part: 'strong',
    keep: { id: 'b2093c44-92a7-4d03-8c43-0b28ac199252', name: 'Muhammad Aqib Khan', channel: 'uber' },
    merge: { id: '6628172', name: 'Muhammad Aqib Ahmad Ullah Khan', channel: 'bolt' },
    seen: { days: 102, shared: 52, interleaved: 32, atOnce: 0, plates: ['L40959', 'L41452'] } }),
  fromReview({ key: 'muhammed shahab khan', part: 'link',
    keep: { id: 'c35f5806-b4a3-41a3-8c84-b1ab7dcfbfa5', name: 'Muhammed SHAHAB KHAN', channel: 'uber' },
    merge: { id: '6623720', name: 'MUHAMMAD SHAHAB GHARIB KHAN', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammed shahab khan', part: 'link',
    keep: { id: 'c35f5806-b4a3-41a3-8c84-b1ab7dcfbfa5', name: 'Muhammed SHAHAB KHAN', channel: 'uber' },
    merge: { id: '688b20bea0bf23d354fdbaca', name: 'Muhammad Shahab Gharib Khan', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abas osman abyan', part: 'link',
    keep: { id: 'c417490e-a60a-4fb3-b4d8-c16673008e0a', name: 'Abas Osman Abyan', channel: 'uber' },
    merge: { id: '7714111', name: 'Abas Osman Abyan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abas osman abyan', part: 'link',
    keep: { id: 'c417490e-a60a-4fb3-b4d8-c16673008e0a', name: 'Abas Osman Abyan', channel: 'uber' },
    merge: { id: 'bb9ef8895f9e4e5c8947258ef0ae1503', name: 'Abyan Abas Osman', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-18' } }),
  fromReview({ key: 'sheraz rehman khan', part: 'strong',
    keep: { id: '2c445083-99b6-411f-bd9d-5b6823b80b9d', name: 'Sheraz Rehman Khan', channel: 'uber' },
    merge: { id: '6800964', name: 'Sheraz Rehman Abdul Rehman Khan', channel: 'bolt' },
    seen: { days: 89, shared: 51, interleaved: 33, atOnce: 0, plates: ['L46183', 'L78463'] } }),
  fromReview({ key: 'sameh altabei elsayed mohamed', part: 'link',
    keep: { id: '6628155', name: 'Sameh Altabei Elsayed Mohamed', channel: 'bolt' },
    merge: { id: 'cbc987fdf3164305b62700b707905664', name: 'Altabei Sameh', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'abdul salim aziz abdul gaffur', part: 'link',
    keep: { id: '55833ba1-0dcb-4a6a-a7f0-5148819e600d', name: 'Abdul Salim Aziz Abdul Gaffur', channel: 'uber' },
    merge: { id: '6611334', name: 'Abdul Salim Aziz Abdul Aziz Abdul Gaffur', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'abdul salim aziz abdul gaffur', part: 'link',
    keep: { id: '55833ba1-0dcb-4a6a-a7f0-5148819e600d', name: 'Abdul Salim Aziz Abdul Gaffur', channel: 'uber' },
    merge: { id: '92a8c1c8-f5ab-462a-99a3-165dc3fbe6c2', name: 'Abdul Salim Aziz Abdul Aziz Abdul Gaffur', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad haris bangash', part: 'link',
    keep: { id: '4392d188-e2fb-4a7d-999d-693e648b4e55', name: 'Muhammad Haris Bangash', channel: 'uber' },
    merge: { id: '8035834', name: 'Muhammad Haris Bangash Iftikhar Ahmad Bangash', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad haris bangash', part: 'link',
    keep: { id: '4392d188-e2fb-4a7d-999d-693e648b4e55', name: 'Muhammad Haris Bangash', channel: 'uber' },
    merge: { id: '87a43a33-2869-44ba-94d5-c9109c308daa', name: 'Muhammad Haris Bangash Iftikhar Ahmad Bangash', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'durga prasad basyal', part: 'link',
    keep: { id: '67483c64055e070d791000cb', name: 'DURGA PRASAD BASYAL', channel: 'hotel' },
    merge: { id: '6611221', name: 'Durga Prasad Basyal', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-18' } }),
  fromReview({ key: 'durga prasad basyal', part: 'link',
    keep: { id: '67483c64055e070d791000cb', name: 'DURGA PRASAD BASYAL', channel: 'hotel' },
    merge: { id: '4abd6016-c582-44f9-8bf7-6af054d0cbe6', name: 'Durga Prasad Basyal', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-18' } }),
  fromReview({ key: 'umar ali zarid khan', part: 'link',
    keep: { id: '67483c64055e070d791000f8', name: 'Umar Ali Zarid Khan', channel: 'hotel' },
    merge: { id: '6628957', name: 'Umar Ali Zarid Khan', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'umar ali zarid khan', part: 'strong',
    keep: { id: '67483c64055e070d791000f8', name: 'Umar Ali Zarid Khan', channel: 'hotel' },
    merge: { id: '7859266', name: 'Umer Ali Zarid Khan', channel: 'bolt' },
    seen: { days: 61, shared: 58, interleaved: 50, atOnce: 0, plates: ['L46197', 'L64007'] } }),
  fromReview({ key: 'abdullah ahmad ullah khan', part: 'weak',
    keep: { id: '67483c64055e070d7910010e', name: 'ABDULLAH AHMAD AHMAD ULLAH KHAN', channel: 'hotel' },
    merge: { id: '23a584f3-cfc7-450e-bb42-6a71ebf0d613', name: 'Abdullah Ahmed Khan', channel: 'uber' },
    seen: { days: 49, shared: 2, interleaved: 2, atOnce: 0, plates: ['L40959'] } }),
  fromReview({ key: 'abdullah ahmad ullah khan', part: 'link',
    keep: { id: '67483c64055e070d7910010e', name: 'ABDULLAH AHMAD AHMAD ULLAH KHAN', channel: 'hotel' },
    merge: { id: '6628743', name: 'Abdullah Ahmad Ahmad Ullah Khan', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'elchin goyushov', part: 'link',
    keep: { id: '5ab414ab-e448-420e-9701-721d4cac42fb', name: 'Elchin Goyushov', channel: 'uber' },
    merge: { id: '8170855', name: 'Elchin Goyushov', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'elchin goyushov', part: 'link',
    keep: { id: '5ab414ab-e448-420e-9701-721d4cac42fb', name: 'Elchin Goyushov', channel: 'uber' },
    merge: { id: 'a4fb427a-514a-476f-9e5f-6498367f327e', name: 'Elchin Goyushov', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'zahid khan ismail', part: 'link',
    keep: { id: '992df6d8-7069-409c-b93d-3f638817ac49', name: 'ZAHID KHAN ISMAIL ISMAIL', channel: 'uber' },
    merge: { id: '67483c64055e070d79100121', name: 'ZAHID KHAN ISMAIL ISMAIL', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' },
    contradictions: ['2025-04-07', '2025-04-25', '2025-04-29'] }),
  fromReview({ key: 'dev bahadur gurung', part: 'link',
    keep: { id: 'a5f9214e-4f6f-4037-bf0a-631bc6ff5343', name: 'Dev Bahadur Gurung', channel: 'uber' },
    merge: { id: '9593727', name: 'Dev Bahadur Gurung', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'dev bahadur gurung', part: 'link',
    keep: { id: 'a5f9214e-4f6f-4037-bf0a-631bc6ff5343', name: 'Dev Bahadur Gurung', channel: 'uber' },
    merge: { id: '93378ac8-6756-439c-9c92-e298ece77c33', name: 'Dev Bahadur Gurung', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'noorullah khan zaman', part: 'link',
    keep: { id: '6fa73403-4c89-4be6-83ca-dada5205a0a7', name: 'NoorUllah KHAN ZAMAN', channel: 'uber' },
    merge: { id: '6659711', name: 'Noor Ullah Khan Sherin Zaman', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'noorullah khan zaman', part: 'link',
    keep: { id: '6fa73403-4c89-4be6-83ca-dada5205a0a7', name: 'NoorUllah KHAN ZAMAN', channel: 'uber' },
    merge: { id: '67483c64055e070d79100102', name: 'NOOR ULLAH KHAN SHERIN ZAMAN', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad nadeem ajmal', part: 'strong',
    keep: { id: '1936ced0-ccd5-4db0-b07f-ab084cee7bd9', name: 'Muhammad Nadeem Ajmal', channel: 'uber' },
    merge: { id: '8074227', name: 'Muhammad Nadeem Muhammad Ajmal', channel: 'bolt' },
    seen: { days: 65, shared: 65, interleaved: 51, atOnce: 0, plates: ['L76099', 'L91636'] } }),
  fromReview({ key: 'ansar murtaza butt rashid murtaza', part: 'link',
    keep: { id: '67483c64055e070d791000e0', name: 'ANSAR MURTAZA BUTT RASHID MURTAZA', channel: 'hotel' },
    merge: { id: '6623712', name: 'Ansar Murtaza', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'ansar murtaza butt rashid murtaza', part: 'link',
    keep: { id: '67483c64055e070d791000e0', name: 'ANSAR MURTAZA BUTT RASHID MURTAZA', channel: 'hotel' },
    merge: { id: 'e2e561163b1b40aaa79b82a87be40f6b', name: 'ANSAR MURTAZA', channel: 'yango' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'haider ali khalid mahmood', part: 'link',
    keep: { id: '6633411', name: 'Haider Ali Khalid Mahmood', channel: 'bolt' },
    merge: { id: '6c861462-33fa-4da4-9ef6-5d0f8d372633', name: 'Haider Ali Mahmood', channel: 'uber' },
    link: { basis: 'similar_name', confirmed: '2026-09-14' } }),
  fromReview({ key: 'haider ali khalid mahmood', part: 'link',
    keep: { id: '6633411', name: 'Haider Ali Khalid Mahmood', channel: 'bolt' },
    merge: { id: '67483c64055e070d7910010c', name: 'HAIDER ALI KHALID MAHMOOD', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'moidutty sanafu moidutty', part: 'link',
    keep: { id: '22a30136-f671-4d0f-a78e-109d255769b3', name: 'Moidutty Sanafu Moidutty', channel: 'uber' },
    merge: { id: '6a042a98284c6a4354627f36', name: 'Moidutty Sanafu Cherunambi', channel: 'hotel' },
    link: { basis: 'shared_phone', confirmed: 'unknown' } }),
  fromReview({ key: 'wajid akbar khan', part: 'strong',
    keep: { id: '00dc098e-2f65-4b6b-9fbd-47305cdb18e0', name: 'Wajid Akbar Khan', channel: 'uber' },
    merge: { id: '7158151', name: 'Wajid Akbar Akbar Din Khan', channel: 'bolt' },
    seen: { days: 71, shared: 71, interleaved: 59, atOnce: 0, plates: ['L36401', 'L46201'] } }),
  fromReview({ key: 'faizan waris muhammad waris', part: 'link',
    keep: { id: '6592207', name: 'FAIZAN WARIS MUHAMMAD WARIS', channel: 'bolt' },
    merge: { id: '221b1276-c0de-43ef-973c-0e536460337d', name: 'FAIZAN WARIS MUHAMMAD WARIS', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'leon anthony marcus', part: 'link',
    keep: { id: '97e08f41-1b0c-44b5-98bd-bfdea50a2c24', name: 'Leon Anthony Marcus', channel: 'uber' },
    merge: { id: '5edfb1b3-25a5-42f7-9759-4f3e4f22c4d6', name: 'Leon Anthony rodrigues Rodrigues Anthony marcus', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-25' } }),
  fromReview({ key: 'muhammad rashid riasat', part: 'link',
    keep: { id: '4a4a43d2-1c84-4b62-9475-7c08b5cecd78', name: 'Muhammad Rashid Riasat', channel: 'uber' },
    merge: { id: '8274586', name: 'Muhammad Rashid Muhammad Riasat', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad rashid riasat', part: 'link',
    keep: { id: '4a4a43d2-1c84-4b62-9475-7c08b5cecd78', name: 'Muhammad Rashid Riasat', channel: 'uber' },
    merge: { id: 'e125d722-cd21-4636-a38c-b2c54494c89f', name: 'Muhammad Rashid Muhammad Riasat', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad abid ali khan noor', part: 'link',
    keep: { id: '67483c64055e070d791000de', name: 'MUHAMMAD ABID ALI KHAN NOOR NOOR', channel: 'hotel' },
    merge: { id: '6639693', name: 'Muhammad Abid Ali Khan Noor Zali Khan', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'nosher hassan bhatti', part: 'strong',
    keep: { id: '4cbf0c03-1666-444e-a164-310bb80fedf5', name: 'Nosher Hassan Bhatti', channel: 'uber' },
    merge: { id: '6620175', name: 'Nosher Hassan Mumtaz Ahmad Bhatti', channel: 'bolt' },
    seen: { days: 41, shared: 21, interleaved: 16, atOnce: 0, plates: ['L78485'] } }),
  fromReview({ key: 'fahad mustafa', part: 'link',
    keep: { id: '41fab64a-e93c-4f7b-847b-513f01084fda', name: 'Fahad Mustafa Mustafa', channel: 'uber' },
    merge: { id: '8519700', name: 'Fahad Mustafa', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'fahad mustafa', part: 'link',
    keep: { id: '41fab64a-e93c-4f7b-847b-513f01084fda', name: 'Fahad Mustafa Mustafa', channel: 'uber' },
    merge: { id: '11ebc40b-25cf-47db-91a3-8705c70ee4ef', name: 'Fahad Mustafa', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'javeed ahmed abuthahir', part: 'link',
    keep: { id: '924ba67f-0ebf-48eb-b30b-0feffe302088', name: 'Javeed Ahmed Abuthahir', channel: 'uber' },
    merge: { id: '9674928', name: 'JAVEED AHMED', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-30' } }),
  fromReview({ key: 'javeed ahmed abuthahir', part: 'link',
    keep: { id: '924ba67f-0ebf-48eb-b30b-0feffe302088', name: 'Javeed Ahmed Abuthahir', channel: 'uber' },
    merge: { id: '6ac5f35a6e0dbece4b48591e', name: 'Javeed Ahmed Syed Abuthahir Syed Abuthahir', channel: 'hotel' },
    link: { basis: 'shared_phone', confirmed: 'unknown' } }),
  fromReview({ key: 'muhammad sabir jamal', part: 'link',
    keep: { id: '716b5404-628d-47e4-827e-1477749eb75f', name: 'Muhammad Sabir Jamal', channel: 'uber' },
    merge: { id: '7194959', name: 'Muhammad Sabir Bakht Jamal', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad sabir jamal', part: 'link',
    keep: { id: '716b5404-628d-47e4-827e-1477749eb75f', name: 'Muhammad Sabir Jamal', channel: 'uber' },
    merge: { id: 'bfb35d1b-be59-4abe-9d35-41870fcd1863', name: 'Muhammad Sabir Bakht Jamal', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'maimaitiyiming abuduhaibaier', part: 'link',
    keep: { id: '6997355', name: 'Maimaitiyiming Abuduhaibaier', channel: 'bolt' },
    merge: { id: 'cf47057f-57d4-480c-b581-23edc94a542a', name: 'Maimaitiyiming Abuduhaibaier', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'dhavooth ibrahim abdul kadhar', part: 'link',
    keep: { id: '8875bda1-9a0a-4337-adbb-43926ad278ea', name: 'Dhavooth Ibrahim Abdul Kadhar', channel: 'uber' },
    merge: { id: 'b4f0558b-284b-4d91-b40a-5ed7b8c11c67', name: 'Dhavooth Ibrahim', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'umairuddin mohammed zameeruddin', part: 'link',
    keep: { id: '84f3c41d-2e32-432d-8d6a-a565184d1068', name: 'Umairuddin Mohammed Zameeruddin', channel: 'uber' },
    merge: { id: '6940023', name: 'Umair Uddin Mohammed Mohammed Zameer Uddin', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'umairuddin mohammed zameeruddin', part: 'link',
    keep: { id: '84f3c41d-2e32-432d-8d6a-a565184d1068', name: 'Umairuddin Mohammed Zameeruddin', channel: 'uber' },
    merge: { id: '2df8f636-2964-4163-a164-b09154f92c80', name: 'Umair Uddin Mohammed Mohammed Zameer Uddin', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mohammad asif ahmad', part: 'link',
    keep: { id: '7c19932d-f2de-45a2-ad08-b01a4b87b988', name: 'Mohammad Asif Ahmad', channel: 'uber' },
    merge: { id: '8051700', name: 'Mohammad Asif Shafiq Ahmad', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mohammad asif ahmad', part: 'link',
    keep: { id: '7c19932d-f2de-45a2-ad08-b01a4b87b988', name: 'Mohammad Asif Ahmad', channel: 'uber' },
    merge: { id: '90c2e390-2820-4d26-8cf3-2b84ca717c55', name: 'Mohammad Asif Shafiq Ahmad', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'shahid khan zada', part: 'link',
    keep: { id: 'eb7962e5-0c47-45c0-b758-b61e6dd12998', name: 'SHAHID KHAN KHAN ZADA', channel: 'uber' },
    merge: { id: '6a291640284c6a4354651585', name: 'SHAHID KHAN KHAN ZADA', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad nasir khan', part: 'link',
    keep: { id: '7a935b56-6a30-4f25-9d0a-d556b947e23a', name: 'Muhammad Nasir Khan', channel: 'uber' },
    merge: { id: '7312220', name: 'Muhammad Nasir Bashir Khan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad nasir khan', part: 'link',
    keep: { id: '7a935b56-6a30-4f25-9d0a-d556b947e23a', name: 'Muhammad Nasir Khan', channel: 'uber' },
    merge: { id: 'b5c7ce92-b5fd-4e08-bc9b-09bcc37f1ac3', name: 'Muhammad Nasir Bashir Khan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'arslan arif', part: 'link',
    keep: { id: 'dbd55f2e-ffeb-479d-b8f0-75c8acf186b5', name: 'Arslan Arif Arif', channel: 'uber' },
    merge: { id: '7547689', name: 'Arslan Arif Muhammad Arif', channel: 'bolt' },
    link: { basis: 'shared_car_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'arslan arif', part: 'strong',
    keep: { id: 'dbd55f2e-ffeb-479d-b8f0-75c8acf186b5', name: 'Arslan Arif Arif', channel: 'uber' },
    merge: { id: '92ec45d804f34718a8ed6214cfb99b4d', name: 'Muhammad Arif Arslan Arif', channel: 'yango' },
    seen: { days: 20, shared: 20, interleaved: 17, atOnce: 0, plates: ['L40965'] } }),
  fromReview({ key: 'muhammad usman khan', part: 'link',
    keep: { id: '67e086af-8cb7-498f-9f4f-f4d4e2a7467a', name: 'Muhammad Usman Khan', channel: 'uber' },
    merge: { id: '8033691', name: 'Muhammad Usman Azmat Khan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'muhammad usman khan', part: 'link',
    keep: { id: '67e086af-8cb7-498f-9f4f-f4d4e2a7467a', name: 'Muhammad Usman Khan', channel: 'uber' },
    merge: { id: '3d226bd8-47bf-4d9e-b4d2-722756144ee9', name: 'Muhammad Usman Azmat Khan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'younas khan shah', part: 'strong',
    keep: { id: 'e6c4ae1e-b424-4b42-ad68-153dc8f7b823', name: 'Younas Khan Shah', channel: 'uber' },
    merge: { id: '7416327', name: 'Younas Khan Islam Shah', channel: 'bolt' },
    seen: { days: 21, shared: 20, interleaved: 12, atOnce: 0, plates: ['L19312', 'L57948', 'L72481'] } }),
  fromReview({ key: 'muhammad asim shahzad', part: 'link',
    keep: { id: '42316a17-6fc9-49f4-af07-b5676ac04eeb', name: 'Muhammad Asim Shahzad', channel: 'uber' },
    merge: { id: '9642366', name: 'Muhammad Asim', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-10-08' } }),
  fromReview({ key: 'yousaf ali javed iqbal khan', part: 'link',
    keep: { id: '6629009', name: 'YOUSAF ALI JAVED IQBAL KHAN', channel: 'bolt' },
    merge: { id: '6f564b8c1a334a7eb9953614300d8e85', name: 'YOUSAF ALI', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'hassan elsayed hassan', part: 'link',
    keep: { id: '19a4453f-a38b-4142-93f5-979b96b681a6', name: 'Hassan Elsayed Hassan', channel: 'uber' },
    merge: { id: '7294843', name: 'Hassan Elsayed Gaber Hassan Hassan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'hassan elsayed hassan', part: 'link',
    keep: { id: '19a4453f-a38b-4142-93f5-979b96b681a6', name: 'Hassan Elsayed Hassan', channel: 'uber' },
    merge: { id: '83cf7ce5-764e-4588-994f-d415566288c1', name: 'Hassan Elsayed Gaber Hassan Hassan', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'emad alabdon', part: 'link',
    keep: { id: 'f77be3df-b458-4a53-94f3-e892dbb495cb', name: 'Emad Alabdon', channel: 'uber' },
    merge: { id: '413c9c74-c8dc-402e-98dd-7317c9855d33', name: 'Emad Alabdon', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mohammed musab rahmathulla', part: 'link',
    keep: { id: '2c085db3-dbb1-48a6-99ca-0af7e5ee3ea5', name: 'Mohammed Musab Rahmathulla', channel: 'uber' },
    merge: { id: '7643640', name: 'Mohammed Musab Rahmathulla', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'mohammed musab rahmathulla', part: 'strong',
    keep: { id: '2c085db3-dbb1-48a6-99ca-0af7e5ee3ea5', name: 'Mohammed Musab Rahmathulla', channel: 'uber' },
    merge: { id: '2bde54e1ec3d46e787c3562a15459a16', name: 'MOHAMMED MUSAB', channel: 'yango' },
    seen: { days: 3, shared: 2, interleaved: 1, atOnce: 0, plates: ['L75122'] } }),
  fromReview({ key: 'shajahan mk', part: 'link',
    keep: { id: '9585892', name: 'shajahan Mk', channel: 'bolt' },
    merge: { id: '0f314ca4-fedd-4de5-9b48-59f274776381', name: 'shajahan Mk', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'maen m alaa shekfa', part: 'link',
    keep: { id: '67483c64055e070d79100133', name: 'M MAEN M ALAA SHEKFA', channel: 'hotel' },
    merge: { id: '00c0221c4aec47db9813f6c525167561', name: 'M MAEN M ALAA SHEKFA', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'maen m alaa shekfa', part: 'strong',
    keep: { id: '67483c64055e070d79100133', name: 'M MAEN M ALAA SHEKFA', channel: 'hotel' },
    merge: { id: '6628845', name: 'M MEAN M ALAA SHEKFA', channel: 'bolt' },
    seen: { days: 7, shared: 3, interleaved: 1, atOnce: 0, plates: ['L81970'] } }),
  fromReview({ key: 'farhan khan manazir khan', part: 'link',
    keep: { id: '6628886', name: 'Farhan Khan Manazir Khan', channel: 'bolt' },
    merge: { id: 'd43a09f3ab8a44b5ab6d35331edb59af', name: 'FARHAN KHAN', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'moidutty sanafu cherunambi moidutty', part: 'link',
    keep: { id: '8688313', name: 'Moidutty sanafu Cherunambi moidutty', channel: 'bolt' },
    merge: { id: '8af4f8d8-c28b-4eef-be5b-609947c9567c', name: 'Moidutty sanafu Cherunambi moidutty', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'umar kayani nasir waheed kayani', part: 'link',
    keep: { id: '67483c64055e070d791000da', name: 'UMAR KAYANI NASIR WAHEED KAYANI', channel: 'hotel' },
    merge: { id: '6628548', name: 'Umar Kayani Nasir Waheed Kayani', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'alzain alfatih ahmed', part: 'link',
    keep: { id: '8d545a2e-725f-488d-9498-0870a0bffb87', name: 'Alzain Alfatih Ahmed', channel: 'uber' },
    merge: { id: '8555822', name: 'Alzain Hussein', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'alzain alfatih ahmed', part: 'link',
    keep: { id: '8d545a2e-725f-488d-9498-0870a0bffb87', name: 'Alzain Alfatih Ahmed', channel: 'uber' },
    merge: { id: '2b53af79-175b-4ff4-bd2e-545c2d409ce9', name: 'Alzain Hussein', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'shehzad ahmad ghulam muhammad', part: 'weak',
    keep: { id: 'f6253b6e-fca4-41cf-99c1-6c2f3e2e67b2', name: 'Shehzad Ahmad Ghulam Muhammad', channel: 'uber' },
    merge: { id: '4e75cfb248fc45dd8bc41c460e956bfb', name: 'Ghulam Muhammad Ahmed', channel: 'yango' },
    seen: { days: 3, shared: 3, interleaved: 0, atOnce: 0, plates: ['L41452', 'L46208'] } }),
  fromReview({ key: 'shehzad ahmad ghulam muhammad', part: 'weak',
    keep: { id: 'f6253b6e-fca4-41cf-99c1-6c2f3e2e67b2', name: 'Shehzad Ahmad Ghulam Muhammad', channel: 'uber' },
    merge: { id: 'b826dc16c41248b1a5005750d255231b', name: 'Shehzad Ahmad', channel: 'yango' },
    seen: { days: 3, shared: 3, interleaved: 0, atOnce: 0, plates: ['L41452', 'L46208'] } }),
  fromReview({ key: 'khan akbar khan', part: 'link',
    keep: { id: 'be22c2b6-fd77-4956-9b72-139eeb61d71f', name: 'Khan Akbar Khan', channel: 'uber' },
    merge: { id: '8519699', name: 'Khan Akbar', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'khan akbar khan', part: 'link',
    keep: { id: 'be22c2b6-fd77-4956-9b72-139eeb61d71f', name: 'Khan Akbar Khan', channel: 'uber' },
    merge: { id: '1f1bb8d4-9a08-41ae-b376-0135ca67a431', name: 'Khan Akbar', channel: 'bolt' },
    link: { basis: 'same_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'rufat gadirli', part: 'link',
    keep: { id: '6628166', name: 'Rufat Gadirli', channel: 'bolt' },
    merge: { id: '34e629f1fab64e9a814089dc0d2a086d', name: 'Rufat Gadirli', channel: 'yango' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'binu abdul rehman kunju abdul rahman kunju', part: 'link',
    keep: { id: '06e30918-61b9-4543-8a38-b7ff787c1b44', name: 'Binu Abdul Rehman Kunju Abdul Rahman Kunju', channel: 'uber' },
    merge: { id: '808537b4-e268-4c3c-bac1-fc1cf6c74004', name: 'Binu Abdul Rehman Kunju Abdul Rahman Kunju', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-10-08' } }),
  fromReview({ key: 'nauman hassan shida muhammad', part: 'link',
    keep: { id: '67483c64055e070d791000f9', name: 'NAUMAN HASSAN SHIDA MUHAMMAD', channel: 'hotel' },
    merge: { id: '6628589', name: 'Nauman Hassan Shida Muhammad', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'nauman hassan shida muhammad', part: 'car',
    keep: { id: '67483c64055e070d791000f9', name: 'NAUMAN HASSAN SHIDA MUHAMMAD', channel: 'hotel' },
    merge: { id: '72caf703fcf64d63965b80a6497428ac', name: 'HASSAN NAUMAN', channel: 'yango' },
    standing: { plate: 'L44251', platformState: 'active' } }),
  fromReview({ key: 'sayed kamal sayed', part: 'link',
    keep: { id: 'b7310a42-4ad3-4c88-b1ce-4fa50e226077', name: 'Sayed Kamal Sayed', channel: 'uber' },
    merge: { id: '6616332', name: 'Sayed Kamal Sayed Sayed Mir Sayed', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' } }),
  fromReview({ key: 'sayed kamal sayed', part: 'link',
    keep: { id: 'b7310a42-4ad3-4c88-b1ce-4fa50e226077', name: 'Sayed Kamal Sayed', channel: 'uber' },
    merge: { id: '67483c64055e070d791000fa', name: 'SAYED KAMAL SAYED SAYED MIR SAYED', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
  fromReview({ key: 'sayed kamal sayed', part: 'car',
    keep: { id: 'b7310a42-4ad3-4c88-b1ce-4fa50e226077', name: 'Sayed Kamal Sayed', channel: 'uber' },
    merge: { id: '36aace666f914d8db5d3e5be3bb6f7fd', name: 'sayed kamal', channel: 'yango' },
    standing: { plate: 'L40965', platformState: 'deactivated' } }),
  fromReview({ key: 'zubair khan shaukat ali', part: 'link',
    keep: { id: '67483c64055e070d791000e4', name: 'ZUBAIR KHAN SHAUKAT ALI', channel: 'hotel' },
    merge: { id: '6616229', name: 'Zubair Khan Shaukat Ali', channel: 'bolt' },
    link: { basis: 'similar_name', confirmed: '2026-09-21' },
    contradictions: ['2025-09-12'] }),
  fromReview({ key: 'zubair khan shaukat ali', part: 'car',
    keep: { id: '67483c64055e070d791000e4', name: 'ZUBAIR KHAN SHAUKAT ALI', channel: 'hotel' },
    merge: { id: '5d1cd81e68944856a6274c458d5ee4f0', name: 'ZUBAIR KHAN', channel: 'yango' },
    standing: { plate: 'L41435', platformState: 'active' } }),
  fromReview({ key: 'zubair muhammad afsar muhammad', part: 'link',
    keep: { id: '80353b2843844d6683b39450d0d458fa', name: 'ZUBAIR MUHAMMAD AFSAR MUHAMMAD', channel: 'yango' },
    merge: { id: '67483c64055e070d791000ef', name: 'ZUBAIR MUHAMMAD AFSAR MUHAMMAD', channel: 'hotel' },
    link: { basis: 'similar_name', confirmed: '2026-09-15' } }),
]);

const hasContradiction = (m) => ((m.contradictions || []).length > 0);

export const MERGES = Object.freeze([
  ...HAND_MERGES,
  ...CANDIDATES.filter((m) => !hasContradiction(m)),
  ...FROM_ROSTER,
  ...FROM_REVIEW,
]);

/** The ones still held back, and why each one is. */
export const PENDING = Object.freeze(CANDIDATES.filter(hasContradiction));


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
    /* AN APPLIED CONTRADICTION NEEDS A RULING THAT NAMES IT.
       ─────────────────────────────────────────────────────────────────────
       Until 2026-09-29 nothing applied could carry a contradiction, because the
       only list that held contradicted pairs was CANDIDATES and MERGES filters
       them out of it. The operator's ruling on Ali Abbas Ahmed put the first
       one into HAND_MERGES — deliberately, with its 2025-08-31 kept as
       evidence — and that list has no filter. So the property the filter gave
       for free is asserted here instead: an applied entry with a contradiction
       loads only if it carries a ruling (who, when, in what words) whose
       `over` names every one of its contradiction dates. A contradicted pair
       pasted into HAND_MERGES without one does not load; neither does a ruling
       made over one date while the entry carries another the ruler never saw. */
    if (list === 'MERGES' && hasContradiction(m)) {
      const r = m.ruling || {};
      const over = new Set(r.over || []);
      if (!r.by || !/^\d{4}-\d{2}-\d{2}$/.test(r.on || '') || !(r.words || '').trim()
          || !m.contradictions.every((d) => over.has(d))) {
        throw new Error(`identity_map: ${where} is applied but carries a contradiction `
          + `(${m.contradictions.join(', ')}) with no ruling made over it — a contradicted pair `
          + 'joins MERGES only on a recorded ruling, as the fifth HAND_MERGES entry does');
      }
    }
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
  /* One key, one survivor.
     ─────────────────────────────────────────────────────────────────────────
     A key may carry more than one entry — "Aliyan khalil" was proved by hand
     against his Yango record and again by the shared-history sweep against his
     Bolt one, and that is one man with three records rather than two pairs.
     What may NOT happen is two entries claiming the same key for two DIFFERENT
     surviving records: the key is the folded name of the survivor, so that
     shape is two men with the same folded name being quietly merged by a
     register entry nobody wrote. It cannot arise from foldName alone, because
     both would already share a key without any register at all — it arises
     from a hand edit, which is exactly what this list is. */
  const survivor = new Map();
  for (const m of [...MERGES, ...PENDING]) {
    const had = survivor.get(m.key);
    if (had && had !== m.keep.id) {
      throw new Error(`identity_map: key ${JSON.stringify(m.key)} names two different `
        + `surviving records (${had} and ${m.keep.id}) — one key, one survivor`);
    }
    survivor.set(m.key, m.keep.id);
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
/* EVERY alias id, not the first one.
   ─────────────────────────────────────────────────────────────────────────
   This read `m.merge.id`, which is right for a pair whose alias is one record
   and silently wrong for one whose alias is two — a Bolt numeral and the hotel
   ObjectId filed under the same long name. `merge.ids` is the commoner shape
   in the register now, and mapping one of them and not the other would split
   the person a third way rather than folding them a second. */
export const ALIAS_KEY = Object.freeze(new Map(
  MERGES.flatMap((m) => mergeIdsOf(m).map((id) => [id, m.key]))));

/** The same thing for the held-back pairs (none since the review of 2026-10-08
    ruled the last four into HAND_MERGES), and it is NOT wired to anything.
    ─────────────────────────────────────────────────────────────────────────
    It exists so the migration that applies them, or a reader checking one
    against production, does not have to walk the list to find out which ids
    would move and where. Nothing in api/ consults it: ALIAS_KEY above is what
    /api/driver/* resolves by and identityCase() below is what the SQL carries,
    and both still answer for the three applied pairs only, so the stored
    person_key column and the key this module computes cannot disagree. */
export const PENDING_ALIAS_KEY = Object.freeze(new Map(
  PENDING.flatMap((m) => mergeIdsOf(m).map((id) => [id, m.key]))));

/** EVERY entry on this person's key, not the first one that mentions the id.
    ─────────────────────────────────────────────────────────────────────────
    This was a `.find`, which is right for a person the register holds once and
    silently wrong for the three it holds twice. "Aliyan khalil" is one man with
    three records — an Uber id, a Yango id proved by hand, and a Bolt id proved
    by the sweep — filed as two entries on one key. A `.find` from the Uber id
    returned the hand entry and therefore two of his three ids, so opening his
    page found his Yango work and not his Bolt standing, and opening the Bolt
    record found the Bolt standing and not the Yango work. The key is the
    person; the entries are the evidence; the ids are the union. */
const entriesFor = (id) => {
  const hit = MERGES.find((x) => x.keep.id === id || mergeIdsOf(x).includes(id));
  return hit ? MERGES.filter((x) => x.key === hit.key) : [];
};

export function mergedIds(id) {
  const es = entriesFor(id);
  if (!es.length) return [id];
  return [...new Set([es[0].keep.id, ...es.flatMap(mergeIdsOf)])];
}

/** The name the merged person is filed under — the surviving record's. */
export function canonicalName(id) {
  const es = entriesFor(id);
  return es.length ? es[0].keep.name : null;
}

/** Every spelling of a merged person, so a driver page can match rows filed
    under any of them. Empty for an id the register has never been told about. */
export function mergedNames(id) {
  const es = entriesFor(id);
  return es.length ? [...new Set([es[0].keep.name, ...es.map((m) => m.merge.name)])] : [];
}

/** The channels the pair's two records live on. The Bolt record in the
    register holds no trip and no compliance row — only a platform standing —
    so a page that derives the channel list from measured work alone would drop
    the very fact the merge exists to surface (an account the fleet
    deactivated). */
export function mergedPlatforms(id) {
  const es = entriesFor(id);
  /* SPLIT on the comma. `channel` is the channels a record files trips on and
     sixteen entries name two of them ("uber,bolt", "bolt,hotel"), so returning
     the field verbatim put the literal string "uber,bolt" into the driver
     page's platform list — one chip reading `uber,bolt` beside the real ones,
     and every `platforms.includes('bolt')` test on that person answering no.
     Harmless while the register was three single-channel pairs; live the day
     the sweep's entries were applied. */
  return es.length
    ? [...new Set([es[0].keep.channel, ...es.map((m) => m.merge.channel)]
      .flatMap((c) => String(c).split(',')).map((c) => c.trim()).filter(Boolean))]
    : [];
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
  + MERGES.flatMap((m) => mergeIdsOf(m).map(
    (id) => `         WHEN ${lit(id)} THEN ${lit(m.key)}`)).join('\n')
  + `\n         ELSE ${fallback} END`;

/** The register as a comment block, so the schema file carries its own reasons. */
export const registerComment = () => MERGES.map((m) =>
  `-- ${mergeIdsOf(m).join(', ')} (${m.merge.channel} "${m.merge.name}")\n`
  + `--   -> ${m.keep.id} (${m.keep.channel} "${m.keep.name}") = ${lit(m.key)}\n`
  + `--   verified ${m.verified}`
  + (m.basis ? ` on a ${m.basis.replace(/_/g, ' ')}`
    : m.plate ? ` on plate ${m.plate}`
      : m.plates ? ` on ${m.plates.length} shared plate${m.plates.length === 1 ? '' : 's'}` : '')
  /* A pair applied over a contradiction says so where the SQL reader sees it,
     with the date it was ruled over — the generated file is read by people
     who never open this one. */
  + (m.ruling ? `; ruled by the ${m.ruling.by} ${m.ruling.on}`
    + (m.ruling.over?.length ? ` over the contradiction of ${m.ruling.over.join(', ')}` : '') : '')).join('\n');
