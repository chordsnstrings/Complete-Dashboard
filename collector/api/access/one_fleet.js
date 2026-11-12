/* ONE-FLEET READERS ON THE ROUTES THAT MIX BOTH FLEETS (2026-11-12, "ONE").
   ═════════════════════════════════════════════════════════════════════════
   ULM-DESIGN §16 left this deferred: a reader whose access covers only some
   fleets was refused every route the manifest classes `mixed` — 110 of them
   on 2026-11-12, not the 77 the design counted, because the HR roster, the
   vehicle feeds, the watch lists and the target pages joined the class since
   — with one sentence, "this combines the records of every fleet". Narrowing
   them "needs a fleet on every row, route by route". This file is the route
   by route.

   TWO OUTCOMES PER ROUTE, never a third.

   1. NARROWED — the manifest classes it `narrow`. The handler learnt to
      honour `_fmfleet` (NARROW_PARAM) in EVERY query behind the answer: the
      rows, and every total, count, facet and comparison figure printed beside
      them. For a reader holding exactly one fleet the gate writes that fleet
      into `_fmfleet` AND into `fleet` (so the parts of a handler that already
      honoured the fleet chip follow too) and keys the response cache on both
      — the `_fmsearch` precedent (api/access/middleware.js). Where a route's
      rows carry the fleet, the manifest also names them (fleetRows/fleetKey)
      and the shaper drops any row of another fleet as a second line.

   2. STILL REFUSED — still classed `mixed`, and refused with the TRUE reason
      for THAT route (MIXED_WHY below) instead of one sentence for all of
      them. "This combines the records of every fleet" was true of a car's
      trips and false of the revenue target, which is not a combination of
      fleet records at all but one figure set for the company.

   WHY A SEPARATE PARAMETER, NOT THE FLEET CHIP. Making each handler honour
   `?fleet=` everywhere would have narrowed these answers for every caller
   who sends the chip — a change to open mode and to unrestricted readers,
   which this work had to leave exactly as it was until sign-in is used. Some
   of these routes honoured the chip in half their queries (the Overview's
   trip figures followed it; its live-vehicle count did not), and that is a
   defect of its own, recorded in FIX-STATUS, not one to fix silently here.
   `_fmfleet` is written by the gate for a narrowed reader and by nobody
   else; a caller who types it only ever narrows their own answer, and the
   cache key carries it, so a cached answer always matches its key.

   WHO IS UNTOUCHED. An anonymous visitor in open mode (the gate passes them
   before judging), an unrestricted signed-in reader (a `narrow` route judges
   them exactly as `mixed` did: levels over every fleet, no rewrite), and the
   system warmer. None of them is ever handed `_fmfleet`. */

export const NARROW_PARAM = '_fmfleet';

/* The fleet a handler must narrow its whole answer to, or null for "every
   fleet, exactly as before". Only a plain string: Express parses a repeated
   parameter into an array, and an array bound as a text parameter would be
   an error rather than a narrowing. */
export const onlyFleet = (req) => {
  const v = req?.query?.[NARROW_PARAM];
  return typeof v === 'string' && /^[a-z0-9_-]{1,64}$/i.test(v) ? v : null;
};

/* ── the true reason, per route still refused ─────────────────────────────
   Grouped by WHY, because the reasons are few and the routes many. Each
   sentence is shown to the reader verbatim (api/public/data.js prints a
   fleet_scope refusal's detail), so each says what the answer is made of and
   what narrowing it would need — never "not shown to your role", which would
   be false: the reader holds the class, for their fleet. */
const ASK = ' Ask the Owner or an Access admin if you need it for every fleet.';

const WHY = {
  person: 'This page is about one person across every account they hold, and one person\'s accounts '
    + 'can sit in both fleets — so its days, totals and money are the person\'s, both fleets together. '
    + 'Counting only the accounts in your fleet is not built for this page yet.' + ASK,
  cash: 'Cash is kept per person: a deposit, an advance, a salary line or a balance is the person\'s, '
    + 'across every account they drive under in either fleet, and the cash pages total it that way. '
    + 'A one-fleet share of a person\'s balance is not a figure anyone recorded.' + ASK,
  identity: 'Who is one person is decided across both fleets — a pair can be one account in each — so '
    + 'this list cannot be cut by fleet without hiding half of a pair, or deciding about an account '
    + 'outside your access.' + ASK,
  vehicle: 'This page is one car\'s whole record — its bookings, trackers, drivers and money are read '
    + 'by plate, whichever fleet\'s accounts they came through. Filtering every part of it by fleet is '
    + 'not built for this page yet.' + ASK,
  target: 'The revenue target is one figure set for the company — both fleets together, day by day — so '
    + 'there is no one-fleet target to measure your fleet against.' + ASK,
  settings: 'Settings and provider credentials are kept as one company-wide list: no setting belongs '
    + 'to one fleet yet (ULM-DESIGN §3.3, settings per connection, is not built).' + ASK,
  run: 'This starts work over every fleet at once — a collection run, a fare check or an analysis '
    + 'pass. A run for one fleet alone is not offered.' + ASK,
  probe: 'This probe calls the providers with every configured fleet\'s credentials in one request, or '
    + 'reads every fleet\'s stored answers together. A one-fleet probe is not offered.' + ASK,
  raw: 'Raw provider records are kept whole, both fleets, exactly as the providers sent them; they are '
    + 'not split by fleet.' + ASK,
  system: 'This measures the data sources themselves, and each source\'s record spans both fleets, so '
    + 'its counts are not split by fleet yet.' + ASK,
  hr: 'An HR export is one workbook holding both fleets\' employees: reading or importing it acts on '
    + 'every fleet at once.' + ASK,
  messages: 'This previews the next run of driver messages, and a run is worked out over both fleets\' '
    + 'drivers at once; a one-fleet preview is not offered.' + ASK,
  charging: 'PowerDrive charging is one company account: its wallets, sessions and the people they are '
    + 'linked to are not filed by fleet.' + ASK,
  tesla: 'The Tesla connection is one company account, not one per fleet.' + ASK,
  watch: 'A low-performer watch list may follow both fleets, and its export and edits act on the list '
    + 'as saved, whichever fleet its members are in; narrowing them by fleet is not built yet.' + ASK,
  /* api/lowperf.js populationOf(): with a fleet chosen it still counts the
     other fleet's drivers it leaves out (hidden_other_fleet), and a file
     cannot be shaped after it is built. */
  lowperf: 'The low-performer workbook is built from every driver in both fleets: with one fleet chosen it '
    + 'still counts the other fleet\'s drivers it leaves out, and a file cannot be trimmed after it is '
    + 'built. A one-fleet workbook is not built yet.' + ASK,
  day: 'This page reads one Dubai day of both fleets\' records together; filtering every part of it '
    + 'by fleet is not built for this page yet.' + ASK,
  compare: 'This compares the drivers or cars you choose across their whole records in both fleets; '
    + 'filtering every part of it by fleet is not built for this page yet.' + ASK,
  trip: 'This is one booking with everything true around it — who held the car that day, the driver\'s '
    + 'payouts and statement for the day, and their other bookings that day — and those are read '
    + 'across both fleets. Filtering each part by fleet is not built for this page yet.' + ASK,
  segment: 'This is one journey of one car with every booking on every channel within an hour either '
    + 'side, read by plate whichever fleet\'s accounts made them. Filtering each part by fleet is not '
    + 'built for this page yet.' + ASK,
  /* Measured 2026-11-12: src/sources/events.js writes every break with
     fleet_id null, and metric_break's key (metric, grain, platform, period)
     has no fleet — so one fleet's list would be EMPTY, and an empty list
     reads as "nothing changed" when nothing was measured. */
  breaks: 'Changes in the trend are detected over both fleets together — one series for the company '
    + '(src/sources/events.js) — so no break is computed for one fleet, and an empty list here would '
    + 'read as "nothing changed" when nothing was measured.' + ASK,
  cabman: 'This table reads CABMAN\'s lists of cars for both fleets\' accounts together, and its check '
    + 'on the cars CABMAN stopped listing asks whether either fleet ever booked them. Splitting it by '
    + 'fleet is not built yet.' + ASK,
};

/* Every route still `mixed`, with its reason. test/access_one_fleet.test.mjs
   fails when a mixed route has no entry here (it would fall back to the
   generic sentence, which may not be its true reason) or when a route listed
   here is no longer mixed (a stale reason nobody would ever read). */
const BY_ROUTE = {
  person: ['GET /api/driver/custody', 'GET /api/driver/daily', 'GET /api/driver/day', 'GET /api/driver/days',
    'GET /api/driver/earnings', 'GET /api/driver/heatmap', 'GET /api/driver/kpis', 'GET /api/driver/mix',
    'GET /api/driver/photo/:platform/:id', 'GET /api/driver/profile', 'GET /api/driver/quality',
    'GET /api/driver/shift', 'GET /api/driver/standing', 'GET /api/driver/territory', 'GET /api/driver/trips',
    'GET /api/driver/unauthorized', 'GET /api/driver/vehicles', 'GET /api/performer', 'GET /api/status/driver'],
  cash: ['GET /api/driver/register', 'GET /api/ledger/cash-position', 'GET /api/ledger/entries',
    'GET /api/ledger/exposure', 'GET /api/ledger/people', 'GET /api/ledger/receipt/:sha',
    'POST /api/ledger/entry', 'POST /api/ledger/import/commit', 'POST /api/ledger/import/preview'],
  identity: ['GET /api/drivers/identity-links', 'GET /api/person/merge', 'GET /api/same-person',
    'POST /api/person/merge', 'POST /api/same-person/decide'],
  vehicle: ['GET /api/map/journey', 'GET /api/track', 'GET /api/where', 'GET /api/vehicle/daily',
    'GET /api/vehicle/drivers', 'GET /api/vehicle/drivers-detail', 'GET /api/vehicle/earnings',
    'GET /api/vehicle/kpis', 'GET /api/vehicle/mix', 'GET /api/vehicle/movement', 'GET /api/vehicle/profile',
    'GET /api/vehicle/safety', 'GET /api/vehicle/trips'],
  target: ['GET /api/target', 'GET /api/target/hours', 'GET /api/target/car', 'GET /api/export/today.xlsx',
    'GET /api/export/target-month.xlsx'],
  settings: ['GET /api/settings', 'PUT /api/settings', 'POST /api/settings/paste'],
  run: ['POST /api/analyst/run', 'POST /api/uber/fares/run', 'POST /api/settings/trigger'],
  probe: ['GET /api/probe/fms/window', 'GET /api/probe/uber/realtime', 'GET /api/probe/uber/rest',
    'GET /api/probe/uber/window', 'GET /api/probe/yango', 'GET /api/probe/yango/keyapi',
    'GET /api/probe/yango/ledger', 'GET /api/probe/yango/weekly-rebuild', 'GET /api/probe/results'],
  raw: ['GET /api/probe/uber/timeline', 'GET /api/probe/zero-distance', 'GET /api/schema/raw-fields',
    'GET /api/schema/raw-values'],
  system: ['GET /api/coverage', 'GET /api/coverage/calendar'],
  hr: ['POST /api/hr-roster/commit', 'POST /api/hr-roster/preview'],
  messages: ['GET /api/sms/preview'],
  charging: ['GET /api/charging/driver', 'GET /api/charging/sessions', 'GET /api/charging/vehicle',
    'GET /api/charging/wallets', 'GET /api/charging/review', 'POST /api/charging/link'],
  tesla: ['GET /api/tesla/status', 'GET /api/tesla/vehicles'],
  lowperf: ['GET /api/export/lowperf.xlsx'],
  watch: ['POST /api/lowperf/watch',
    'POST /api/lowperf/watch/:id', 'GET /api/export/lowperf-watch.xlsx'],
  day: ['GET /api/day', 'GET /api/slot', 'GET /api/online-time'],
  trip: ['GET /api/trip'],
  segment: ['GET /api/segment'],
  cabman: ['GET /api/vehicles/feeds/cabman'],
  breaks: ['GET /api/breaks'],
  compare: ['GET /api/cohort/drivers', 'GET /api/cohort/vehicles'],
};

export const MIXED_WHY = Object.freeze(Object.fromEntries(
  Object.entries(BY_ROUTE).flatMap(([why, keys]) => keys.map((k) => [k, WHY[why]]))));

export const GENERIC_WHY = 'This combines the records of every fleet, and your access covers only some of them.'
  + ASK;

/* The sentence a one-fleet reader is refused with on a route still mixed. */
export const mixedReason = (entry) => MIXED_WHY[`${entry?.method} ${entry?.path}`] || GENERIC_WHY;
