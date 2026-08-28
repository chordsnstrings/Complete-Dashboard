/* Who exactly? — the sets behind the numbers.
   ─────────────────────────────────────────────────────────────────────────
   Every tile in this product states a count and stops there. "1 driver drove
   and was paid nothing" is a true sentence that cannot be acted on: nobody can
   ring a number. The same is true of "33 insured and idle", "4 moved without
   earning", "126 earned nothing" and two dozen others — each is a set of named
   people or named cars, printed as its cardinality.

   This file is the set, named once. Each entry says which endpoint already
   answers the question, and the PREDICATE that turns its rows into the tile's
   number. The tile and the drill-down then run the same function over the same
   rows, so the page cannot say 33 and the list show 31 — which is the failure
   this exists to prevent, and the one a hand-written second query would
   reintroduce the first time either definition moved.

   Pure: no DOM, no fetch, no imports. api/public/cohort.js renders it and
   test/cohorts.test.mjs checks every predicate against real payload shapes. */

/* Rows of the endpoint named by `source`. `pick` says where in the response
   they are — a bare array for the directories, `.rows` for the ledgers. */
export const COHORTS = {
  /* ── Unit economics · the driver ledger ──────────────────────────────── */
  'unit-drove-unpaid': {
    kind: 'driver', source: '/api/economics/drivers', pick: 'rows', chips: true,
    from: 'unit', fromLabel: 'Unit economics',
    label: 'Drove and was paid nothing',
    question: 'Who took bookings in this window and has no money against their name?',
    why: 'Work happened and no channel has paid for it. Either the payout has not landed '
      + 'yet, or the account it landed in is not the one that drove.',
    test: (r) => r.band === 'drove_unpaid',
  },
  'unit-earned-nothing': {
    kind: 'driver', source: '/api/economics/drivers', pick: 'rows', chips: true,
    from: 'unit', fromLabel: 'Unit economics',
    label: 'Earned nothing',
    question: 'Who is on the books, took no booking and was paid nothing?',
    why: 'Every rate on Unit economics divides by the people who earned. These are the '
      + 'people the denominator leaves out, and the reason the two per-driver figures differ.',
    test: (r) => r.band === 'idle',
  },
  'unit-no-hours': {
    kind: 'driver', source: '/api/economics/drivers', pick: 'rows', chips: true,
    from: 'unit', fromLabel: 'Unit economics',
    label: 'Earning, with no measured hours',
    question: 'Who earned money in a window where nothing measured how long they were online?',
    why: 'The money-per-online-hour rate can only count people whose availability was '
      + 'collected. These earned and are not in it.',
    test: (r) => (Number(r.money) || 0) > 0 && !(Number(r.measured_hours_online) > 0),
  },
  'unit-licence-due': {
    kind: 'driver', source: '/api/economics/drivers', pick: 'rows', chips: true,
    from: 'unit', fromLabel: 'Unit economics',
    label: 'Licence expiring',
    question: 'Whose licence runs out within 30 days?',
    why: 'A driver whose licence lapses stops earning on the day it does, and the fleet '
      + 'usually finds out from the platform rather than from itself.',
    test: (r) => r.licence_days_left != null && r.licence_days_left < 30,
  },

  /* ── Unit economics · the asset ledger ───────────────────────────────── */
  'unit-idle-documented': {
    kind: 'vehicle', source: '/api/economics/assets', pick: 'rows', chips: true,
    from: 'unit', fromLabel: 'Unit economics',
    label: 'Insured and idle',
    question: 'Which cars earned nothing while their papers were still current?',
    why: 'The fleet is paying to keep these road-legal and getting nothing back. This is '
      + 'as close to "losing money" as the record honestly gets.',
    test: (r) => !r.money && r.doc_days_left != null && r.doc_days_left >= 0,
  },
  'unit-moved-unpaid': {
    kind: 'vehicle', source: '/api/economics/assets', pick: 'rows', chips: true,
    from: 'unit', fromLabel: 'Unit economics',
    label: 'Moved without earning',
    question: 'Which cars drove in this window with no money against them?',
    why: 'The tracker logged the kilometres and no channel reported a booking that pays '
      + 'for them.',
    test: (r) => r.band === 'moved_unpaid',
  },
  'unit-still': {
    kind: 'vehicle', source: '/api/economics/assets', pick: 'rows', chips: true,
    from: 'unit', fromLabel: 'Unit economics',
    label: 'Never moved',
    question: 'Which cars did not move at all in this window?',
    why: 'No booking and no journey. An asset with a cost and no output.',
    test: (r) => r.band === 'still',
  },

  /* ── Vehicles · the directory ────────────────────────────────────────── */
  'vehicles-moved-no-booking': {
    kind: 'vehicle', source: '/api/vehicles/directory', pick: null, chips: false,
    from: 'vehicles', fromLabel: 'Vehicles',
    label: 'Moved with no booking',
    question: 'Which cars drove with nothing paying for the journey?',
    why: 'The tracker saw the car move and every channel reported no booking behind it. '
      + 'Unauthorized trips lists the journeys themselves.',
    test: (r) => !r.trips && r.telematics_journeys > 0,
  },
  'vehicles-still': {
    kind: 'vehicle', source: '/api/vehicles/directory', pick: null, chips: false,
    from: 'vehicles', fromLabel: 'Vehicles',
    label: 'Did not move',
    question: 'Which cars produced neither a booking nor a journey?',
    why: 'Nothing at all in this window — the longest-standing of these are where '
      + 'redeployment starts.',
    test: (r) => !r.trips && !r.telematics_journeys,
  },
  'vehicles-untracked': {
    kind: 'vehicle', source: '/api/vehicles/directory', pick: null, chips: false,
    from: 'vehicles', fromLabel: 'Vehicles',
    label: 'No tracker fix',
    question: 'Which cars has no tracker ever reported a position for?',
    why: 'Nothing can say where these are. Every movement-based check on this product '
      + 'is blind to them.',
    test: (r) => !r.last_fix,
  },
  'vehicles-stale': {
    kind: 'vehicle', source: '/api/vehicles/directory', pick: null, chips: false,
    from: 'vehicles', fromLabel: 'Vehicles',
    label: 'Tracker gone quiet',
    question: 'Which cars have a tracker that has not reported in 11 minutes?',
    why: 'A tracker that stops reporting looks exactly like a car that stopped moving, '
      + 'and only one of those is a fleet problem.',
    test: (r) => !!r.stale && !!r.last_fix,
  },
  'vehicles-docs-due': {
    kind: 'vehicle', source: '/api/vehicles/directory', pick: null, chips: false,
    from: 'vehicles', fromLabel: 'Vehicles',
    label: 'Documents due',
    question: 'Which cars have a document expiring within 30 days?',
    why: 'A lapsed registration or insurance takes the car off the road on the day it '
      + 'expires, whatever it was earning.',
    test: (r) => r.doc_days_left != null && r.doc_days_left < 30,
  },

  /* ── Roster · who is on the books ────────────────────────────────────
     `category` is computed once, on the server, in the order the claims get
     weaker — a trip that HAPPENED outranks a roster row that CLAIMS. These
     read it rather than re-deriving it, so the tile and the list cannot
     disagree about which bucket somebody is in. */
  'roster-idle': {
    kind: 'driver', source: '/api/roster', pick: 'people', chips: true,
    from: 'roster', fromLabel: 'Roster & supply',
    label: 'Able to earn, earning nothing',
    question: 'Who may legally drive on some platform and took no booking in this window?',
    why: 'Capacity the fleet already carries. A licence and a slot standing still.',
    test: (r) => r.category === 'idle_this_window',
  },
  'roster-never-started': {
    kind: 'driver', source: '/api/roster', pick: 'people', chips: true,
    from: 'roster', fromLabel: 'Roster & supply',
    label: 'Recruited, never driven',
    question: 'Who has a roster record and has never taken a booking on any channel, ever?',
    why: 'Recruitment that never converted. The window does not matter for these — they '
      + 'have no trip in any window.',
    test: (r) => r.category === 'never_started',
  },
  'roster-pipeline': {
    kind: 'driver', source: '/api/roster', pick: 'people', chips: true,
    from: 'roster', fromLabel: 'Roster & supply',
    label: 'Still waiting to start',
    question: 'Who is onboarding or waitlisted?',
    why: 'Nobody here can earn yet. How long each has been waiting is the number that '
      + 'decides whether onboarding is working.',
    test: (r) => r.category === 'in_pipeline',
  },
  'roster-blocked': {
    kind: 'driver', source: '/api/roster', pick: 'people', chips: true,
    from: 'roster', fromLabel: 'Roster & supply',
    label: 'Stopped everywhere',
    question: 'Who is not permitted to work on any platform they hold?',
    why: 'A leaver the fleet may not have recorded as one — and some of them are still '
      + 'holding a car.',
    test: (r) => r.category === 'blocked',
  },
  'roster-blocked-holding': {
    kind: 'driver', source: '/api/roster', pick: 'people', chips: true,
    from: 'roster', fromLabel: 'Roster & supply',
    label: 'Holding a car while stopped',
    question: 'Who cannot drive on any platform and still has a vehicle attached to them?',
    why: 'The car earns nothing and still depreciates, insures and parks. This is the '
      + 'shortest list on the product with the clearest action behind it.',
    test: (r) => !!r.holding_vehicle_while_blocked,
  },
  'roster-unclassified': {
    kind: 'driver', source: '/api/roster', pick: 'people', chips: true,
    from: 'roster', fromLabel: 'Roster & supply',
    label: 'Standing not reported',
    question: 'Whose standing did no provider describe in a word we recognise?',
    why: 'A gap in what we know, not a fact about the person. Filing them anywhere else '
      + 'would assert something no provider said.',
    test: (r) => r.category === 'unclassified',
  },
};

/* Everything a page needs to make a tile clickable, without importing the DOM
   helpers into this file. Returns null for a key nothing declares, so a typo
   in a page renders an ordinary tile rather than a link to a dead page. */
export const cohortOf = (key) => COHORTS[key] || null;

/* Members of a cohort, from the payload its source endpoint returned. Rows are
   taken from `pick` where the endpoint wraps them, and the same predicate the
   tile used is applied here. */
export function membersOf(key, payload) {
  const c = COHORTS[key];
  if (!c) return [];
  const rows = c.pick ? (payload?.[c.pick] || []) : (Array.isArray(payload) ? payload : []);
  return rows.filter((r) => { try { return !!c.test(r); } catch { return false; } });
}

/* The entity id of a member row, whichever shape its source uses. A driver row
   from the ledgers carries `ids` (one per platform account) and a directory row
   carries one; a vehicle is always its plate. */
export function idOf(kind, r) {
  if (kind === 'vehicle') return r.plate || null;
  return r.driver_ext_id || (Array.isArray(r.ids) ? r.ids[0] : null) || r.id || null;
}

/* Every provider account behind one person, so the detail endpoint can gather
   what each platform said about them separately. */
export function accountsOf(r) {
  const ids = Array.isArray(r.ids) ? r.ids.filter(Boolean) : [];
  const one = r.driver_ext_id || r.id;
  return [...new Set([...ids, one].filter(Boolean))];
}
