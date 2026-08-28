/* Every address the product answers, in one place.
   ─────────────────────────────────────────────────────────────────────────
   Two harnesses walk this list — test/smoke_views.mjs, which proves each page
   RENDERS, and bin/render-audit.mjs, which proves each page renders WELL — and
   a list kept in two files is a list that disagrees with itself within a week.
   A route added here is audited by both from that moment on.

   Entity ids are the mock's. Both harnesses substitute real ones when pointed
   at a real database; see the SUB table in each. */
export const ROUTES = [
  // The first screen and its two ledgers.
  'unit', 'unit/assets', 'unit/drivers', 'unit/nonsense',
  /* Both lists, and two drill-downs: drv-0 has an Uber status row, drv-9
     deliberately has none, so the branch that says so is rendered too. */
  'top-performers', 'low-performers', 'performer/drv-0', 'performer/drv-9',
  'overview', 'demand', 'day/2026-08-14', 'day/not-a-date', 'drivers',
  /* Compare, in all four shapes it is reachable in: no days at all (today
     against yesterday), one day, two days, and the reader's override that
     drops the like-for-like cut. */
  'compare', 'compare/2026-08-25', 'compare/2026-08-25/2026-08-24',
  'compare/2026-08-25/2026-08-24?cut=full', 'compare/not-a-date',
  'driver/drv-0', 'driver/drv-0/activity', 'driver/drv-0/territory',
  'driver/drv-0/earnings', 'driver/drv-0/quality', 'driver/drv-0/trips',
  'roster', 'roster/pipeline', 'roster/idle', 'roster/blocked', 'roster/states',
  'vehicles', 'vehicle/L45235', 'vehicle/L45235/drivers', 'vehicle/L45235/movement',
  'vehicle/L45235/earnings', 'vehicle/L45235/safety', 'vehicle/L45235/compliance',
  'vehicle/L45235/trips',
  /* The drill-downs behind the tiles. One of each kind — a driver set from a
     ledger, a vehicle set from a directory, a roster bucket — plus a key
     nothing declares, because a stale bookmark must render a message rather
     than the first entry of VIEWS under somebody else's title. */
  'cohort/unit-drove-unpaid', 'cohort/unit-idle-documented',
  'cohort/vehicles-moved-no-booking', 'cohort/roster-blocked', 'cohort/not-a-cohort',
  'cohort/retention-stopped', 'cohort/safety-drivers', 'cohort/settlement-cash', 'cohort/tiers-behind',
  'platforms', 'platforms/tiers', 'platforms/funnel',
  'corridors', 'finance', 'settlement', 'settlement/cash', 'settlement/receivables',
  'corporate', 'corporate/properties', 'corporate/guests',
  'corporate/leakage', 'corporate/leakage/complimentary',
  'corporate/approach', 'corporate/approach/daypart',
  'property/h-palm', 'property/h-palm/guests', 'property/h-palm/drivers',
  'causes', 'forecast', 'retention', 'playbook', 'capacity', 'revenue',
  'reconcile', 'reconcile/2026-08',
  'insights', 'action/idle_vehicle/L45235', 'action/nope/-',
  'analyst', 'analyst/refuted', 'analyst/immaterial', 'analyst/unsupported', 'analyst/rules',
  'compliance', 'unauthorized',
  // Segments and slots: the pages that replaced the eleven modals. Every filter
  // kind is a route, including one nobody would type, because a facet chip can
  // produce any of them.
  'segments', 'segments/verdict/unauthorized', 'segments/verdict/authorized',
  'segments/plate/L45235', 'segments/day/2026-08-03', 'segments/driver/Ahmed',
  'segments/nonsense/x',
  'segment/L45235/2026-08-03T04:00:00.000Z', 'segment/L45235/not-a-time',
  'slot/2/19', 'slot/0/3', 'slot/9/99',
  'safety', 'safety/vehicles', 'safety/events', 'live', 'map', 'sources', 'coverage', 'providers', 'settings',
  /* The action list's facets are addresses now, so a filtered list can be sent
     to the person who has to act on it. A category nobody has is included on
     purpose: the empty state must say "nothing has this severity", not "no data
     for this range". */
  'insights/severity/critical', 'insights/safety', 'insights/nosuchcategory',
  /* One raw field's values — the drill-down behind "Fields we are not keeping",
     which was the most valuable number on #providers and unopenable. */
  'providers/uber/trips/Surge%20multiplier',
  // The map's own state is an address: mode, plate and day.
  'map/replay/L45235',
  // The window and platform filters now live in the address. A link carrying
  // them has to render the same as one that does not.
  'overview?days=90&platform=uber', 'drivers?days=7&fleet=egari',
  'unit?days=90&fleet=ecosine', 'unit/assets?days=7&platform=uber',
  'segments/verdict/unauthorized?days=180',
];
