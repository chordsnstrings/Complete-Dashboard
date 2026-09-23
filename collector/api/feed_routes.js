/* WHICH CARS ON UBER ARE SENDING SEAT-SENSOR AND FMS DATA, AND WHICH ARE NOT.
   ═══════════════════════════════════════════════════════════════════════════
   Asked for in the operator's words: "the vehicles numbers active on uber but
   not receiving any seat sensor or FMS data and which one's receiving … along
   with driver names and phone number". One row per car Uber lists as active,
   a green or red verdict for each of the two feeds, and who to ring.

   Every definition below is one the codebase already held. None is new, and
   each is stated on the page in one line, because a verdict nobody can trace
   to a rule is a verdict nobody can argue with.

   ── ACTIVE ON UBER ────────────────────────────────────────────────────────
   Uber's own vehicle list — src/sources/uber_fleet.js pullVehicles(), which
   reads the supplier portal's getSupplierVehicles for BOTH orgs on every
   thirty-minute incremental and stores each car's compliance.status as
   vehicle_profile.compliance_status. It has two values on production,
   measured 2026-09-23 over all 138 Uber vehicle records: ACTIVE 130, INACTIVE
   8. Uber's other per-car status, gigBaseTypeStatuses[].gigUnifiedStatus,
   reads INVALID on all 138, active or not, so it separates nothing and is not
   used. A car Uber stops listing is never deleted from vehicle_profile and
   its row is not re-stamped (upsertMany leaves updated_at alone), so it keeps
   the last status Uber gave it — docs/COVERAGE.md records that limit.

   ── WHICH FEED IS THE SEAT SENSOR ─────────────────────────────────────────
   CABMAN. src/sources/cabman.js stores SeatSensorValue as
   telemetry_snapshot.seat_occupied; src/reconcile.js builds every
   unauthorized-trip segment from source='cabman' rows and no other; and
   docs/unauthorized-trips.md says CABMAN credentials exist for Ecosine only.
   FMS (src/sources/fms.js) never writes seat_occupied — its live poll stores
   position, ignition, speed and A/C. So "receiving seat-sensor data" means a
   CABMAN fix carrying a seat reading, not any CABMAN fix.

   ── HOW A CAR IS MATCHED ACROSS THE THREE ─────────────────────────────────
   On the plate, exactly as stored. Every collector writes it through normPlate
   in src/config.js (upper case, spaces and dashes removed): Uber's
   licensePlate, CABMAN's VehicleID and FMS's vehicleno alike. Measured
   2026-09-23: all 138 Uber plates and every CABMAN and FMS plate are the same
   L-and-five-digits shape, and no CABMAN-only plate shares its digits with an
   Uber plate, so there is no near-miss for a looser rule to catch.

   ── RECEIVING ─────────────────────────────────────────────────────────────
   A reading in the last FEED_WINDOW_H hours, see below.

   ── WHO DRIVES IT ─────────────────────────────────────────────────────────
   Uber's own assignment first: the same vehicle list carries assignments[],
   the drivers Uber has attached to the car, and pullVehicles keeps the first
   of them as vehicle_profile.assigned_driver_ext_id. The raw array is read
   here rather than that column because a car can carry two — measured, at
   least 8 of 138 do — and printing whichever came first would name one of two
   shift partners at random. Checked against Uber's live driver roster the same
   minute (/api/schema/raw-values covers 101 of the 138 records, and carries
   no plate beside the array, so which car could not be checked — only
   whether the assigned drivers were together): of the 63 carrying an
   assignment, 54 had every assigned driver attached to one and the same car,
   7 had their driver attached to no car, and 2 named two drivers who were in
   different cars.

   Where Uber assigns nobody (38 of 138), the custody table: vehicle_current_
   driver (sql/schema_v4.sql), the primary driver on the latest day with a
   trip, which is what /api/live, /api/vehicles and every vehicle page already
   print as the current driver. It agreed with Uber's live roster on all 90
   cars where both had an answer.

   The phone comes from driver_compliance, where the collectors keep it
   (src/sources/uber.js writes every Uber account's phone off the live roster)
   — the account's own first, then any other account the person spine
   (driver_platform_id) puts on the same human. Measured over the 122 driver
   accounts that custody or Uber's live roster put in an active car: 113 carry
   a phone on the account itself, 120 once the person's other accounts are
   read — counted through /api/driver/profile, whose fold is not the spine's
   but draws on the same register and link table. */
import { config } from '../src/config.js';

/* THE WINDOW, and why it is a day and not a poll.
   ─────────────────────────────────────────────────────────────────────────
   The collectors ASK often: CABMAN every five minutes (CABMAN_CRON,
   src/index.js) and FMS every two (LIVE_STATUS_SECONDS, the live tick in
   src/run.js). But a tracker only files a new reading when it has one, and
   both kinds report on movement. Measured on production over 2026-09-16 to
   2026-09-23, every fix of every active Uber car:

     CABMAN  a fix every 5 min while moving; about hourly while parked — 90% of
             gaps at most 60 min, 99.9% at most 2 h, the longest in the week
             3.8 h. Healthy trackers' newest fix at most 69 min old; the two
             dead ones 58 h and 163 h.
     FMS     a fix every ~6 min while moving; parked, a unit can go quiet for
             most of a night — 84 gaps over 6 h and 10 over a day, across 78
             cars in the week.

   A window cut at the poll interval would turn every parked car red, and a
   red that means "parked" is a red nobody can act on. A day clears every
   CABMAN silence of the week and a parked FMS unit's night. Past a day it no
   longer separates cleanly, and the cell does not pretend it does: 7 FMS cars
   went more than a day without a reading that week and 4 of them came back —
   a car off the road for a weekend reads the same as a dead unit until it
   moves. So every cell prints the time of the last reading, and a car parked
   since Saturday can be told from one dark since March by reading it. A day
   is also the line this codebase already draws everywhere else:
   src/insights.js files a tracker as stopped reporting at 24 h (stale_tracker),
   src/sources/cabman.js counts a tracker dormant after a day (DORMANT_MIN), and
   the Live page's "Silent over a day" tile is the same 24 h. One product,
   one definition of a tracker that has gone quiet. */
export const FEED_WINDOW_H = 24;

const FLEET_NAME = (f) => (f ? `${String(f)[0].toUpperCase()}${String(f).slice(1)}` : 'this fleet');

/* The SQL, exported so a test can read what the route runs. The window is the
   one parameter, so nothing about it is spelled twice. */
export const FEEDS_SQL = `
  WITH active AS (
    /* One row per plate Uber lists as ACTIVE. A plate is matched to its Uber
       records on the stored, normalised plate; a car Uber files twice is still
       one row here, with every driver either record assigns. */
    SELECT vp.plate,
           min(nullif(btrim(vp.fleet_id), '')) AS fleet_id,
           array_remove(array_agg(DISTINCT a.id), NULL) AS assigned
      FROM vehicle_profile vp
      LEFT JOIN LATERAL (
        SELECT nullif(btrim(e ->> 'entityUUID'), '') AS id
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(vp.raw -> 'assignments') = 'array'
                                         THEN vp.raw -> 'assignments' ELSE '[]'::jsonb END) e
        UNION
        SELECT nullif(btrim(vp.assigned_driver_ext_id), '')
      ) a ON true
     WHERE vp.platform = 'uber'
       AND upper(btrim(vp.compliance_status)) = 'ACTIVE'
       AND nullif(btrim(vp.plate), '') IS NOT NULL
     GROUP BY vp.plate
  ),
  heard AS (
    /* The newest reading per feed. A reading dated in the FUTURE is a tracker
       whose clock runs ahead, not a newer reading — the rule /api/live sorts
       by — so it is used only when the car has nothing dated up to now; one
       bogus far-future row must not keep a silent car green. Each max() is an
       index read on telemetry_snapshot's key (source, plate, captured_at). */
    SELECT a.plate,
           coalesce(
             (SELECT max(t.captured_at) FROM telemetry_snapshot t
               WHERE t.source = 'cabman' AND t.plate = a.plate
                 AND t.seat_occupied IS NOT NULL AND t.captured_at <= now()),
             (SELECT max(t.captured_at) FROM telemetry_snapshot t
               WHERE t.source = 'cabman' AND t.plate = a.plate
                 AND t.seat_occupied IS NOT NULL)) AS seat_at,
           coalesce(
             (SELECT max(t.captured_at) FROM telemetry_snapshot t
               WHERE t.source = 'fms' AND t.plate = a.plate AND t.captured_at <= now()),
             (SELECT max(t.captured_at) FROM telemetry_snapshot t
               WHERE t.source = 'fms' AND t.plate = a.plate)) AS fms_at,
           /* FMS's seat sensor. FMS and CABMAN are two separate providers and
              each is meant to send seat data. FMS sends it as the 'Seat Count'
              on each journey in GetTripPassenger (src/sources/fms.js), which is
              collected into trip.seat_count on every incremental. The live call
              this product polls, GetVehicleStatus, carries no seat field. So the
              newest FMS journey that has a seat count is FMS's newest seat
              reading, dated when that journey ended. */
           coalesce(
             (SELECT max(coalesce(t.ended_at, t.requested_at)) FROM trip t
               WHERE t.platform = 'fms' AND t.plate = a.plate AND t.seat_count IS NOT NULL
                 AND coalesce(t.ended_at, t.requested_at) <= now()),
             (SELECT max(coalesce(t.ended_at, t.requested_at)) FROM trip t
               WHERE t.platform = 'fms' AND t.plate = a.plate AND t.seat_count IS NOT NULL)) AS fms_seat_at
      FROM active a
  )
  SELECT a.plate, a.fleet_id, a.assigned,
         h.seat_at, h.fms_at,
         (h.seat_at > now() - make_interval(hours => $1::int)) IS TRUE AS seat_receiving,
         (h.fms_at  > now() - make_interval(hours => $1::int)) IS TRUE AS fms_receiving,
         h.fms_seat_at,
         (h.fms_seat_at > now() - make_interval(hours => $1::int)) IS TRUE AS fms_seat_receiving,
         nullif(btrim(cd.driver_ext_id), '') AS custody_id,
         nullif(btrim(cd.driver_name), '') AS custody_name,
         /* Text, not a DATE: node-postgres hands a DATE back as a Date at the
            server's local midnight, and the page slices the first ten
            characters of whatever it receives. */
         to_char(cd.as_of, 'YYYY-MM-DD') AS custody_as_of,
         /* The vehicle page's own test for "is there anything to show", so a
            plate is a link only where the page it opens is not a 404 — the
            same four tables api/vehicle_routes.js withVehicle() asks. */
         (EXISTS (SELECT 1 FROM trip x WHERE x.plate = a.plate)
          OR EXISTS (SELECT 1 FROM telemetry_snapshot x WHERE x.plate = a.plate)
          OR EXISTS (SELECT 1 FROM vehicle_driver_day x WHERE x.plate = a.plate)
          OR EXISTS (SELECT 1 FROM vehicle_document x WHERE x.plate = a.plate)) AS vehicle_page,
         now() AS as_of
    FROM active a
    JOIN heard h ON h.plate = a.plate
    LEFT JOIN vehicle_current_driver cd ON cd.plate = a.plate
   ORDER BY ((h.seat_at > now() - make_interval(hours => $1::int)) IS TRUE)::int
          + ((h.fms_seat_at > now() - make_interval(hours => $1::int)) IS TRUE)::int
          + ((h.fms_at  > now() - make_interval(hours => $1::int)) IS TRUE)::int,
            a.fleet_id, a.plate`;

/* Name, phone, and whether a page exists, for every driver account the rows
   above name. One statement for all of them rather than one per row. */
export const DRIVERS_SQL = `
  SELECT k.id,
         sp.driver_id AS person_id,
         nullif(btrim(d.full_name), '') AS person_name,
         acct.full_name AS account_name,
         st.full_name AS roster_name,
         ph.phone,
         /* A driver page resolves an account it can find in driver_compliance
            or on a trip (api/driver_routes.js resolve()); the spine's person
            address resolves whoever the spine has placed. */
         (acct.driver_ext_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM trip t WHERE t.driver_ext_id = k.id)) AS account_page
    FROM unnest($1::text[]) AS k(id)
    LEFT JOIN LATERAL (
      SELECT o.driver_id FROM driver_platform_id o
       WHERE o.external_id = k.id AND o.detached_at IS NULL
       ORDER BY o.platform LIMIT 1) sp ON true
    LEFT JOIN driver d ON d.id = sp.driver_id
    LEFT JOIN LATERAL (
      SELECT c.driver_ext_id, nullif(btrim(c.full_name), '') AS full_name
        FROM driver_compliance c
       WHERE c.driver_ext_id = k.id
       ORDER BY (nullif(btrim(c.full_name), '') IS NOT NULL) DESC, (c.platform = 'uber') DESC, c.platform
       LIMIT 1) acct ON true
    LEFT JOIN LATERAL (
      SELECT nullif(btrim(s.full_name), '') AS full_name FROM driver_platform_state s
       WHERE s.driver_ext_id = k.id
       ORDER BY (s.platform = 'uber') DESC, s.platform LIMIT 1) st ON true
    LEFT JOIN LATERAL (
      /* The account's own phone first; then any other account the person
         spine puts on the same human, Uber's first because every Uber account
         carries one. */
      SELECT nullif(btrim(c.phone), '') AS phone
        FROM driver_compliance c
       WHERE nullif(btrim(c.phone), '') IS NOT NULL
         AND (c.driver_ext_id = k.id
              OR c.driver_ext_id IN (SELECT o.external_id FROM driver_platform_id o
                                      WHERE o.driver_id = sp.driver_id AND o.detached_at IS NULL))
       ORDER BY (c.driver_ext_id = k.id) DESC, (c.platform = 'uber') DESC, c.platform, c.driver_ext_id
       LIMIT 1) ph ON true`;

/* Which fleets hold an account on each feed — read from the collector's own
   configuration, because that is the thing that decides whether a fleet can
   ever have a reading. CABMAN lists Ecosine alone (src/config.js: "Egari DT
   credentials can be added here once provided"); FMS lists both. */
export const feedAccounts = () => ({
  seat: config.cabman.fleets.map((f) => f.fleet),
  fms_seat: config.fms.fleets.map((f) => f.fleet),
  fms: config.fms.fleets.map((f) => f.fleet),
});

/* `seat` is CABMAN's seat sensor and `fms_seat` is FMS's: two providers, each
   of which is meant to send seat data (the operator, 2026-09-23). So a fleet
   with no CABMAN account is "no CABMAN account", never "no seat-sensor account",
   which would be false of Egari, whose FMS sends seat counts. */
const FEED_WORDS = {
  seat: { what: 'CABMAN seat-sensor', provider: 'CABMAN', account: 'CABMAN' },
  fms_seat: { what: 'FMS seat-count', provider: 'FMS', account: 'FMS' },
  fms: { what: 'FMS', provider: 'FMS', account: 'FMS' },
};

/* The state of one feed on one car, and the sentence that is TRUE of it.
   ─────────────────────────────────────────────────────────────────────────
   A red cell must never suggest a broken device when the cause is something
   else. Four reds, four reasons, in the order the evidence decides them:

     no_account  the feed has never reported this car, and the car's fleet
                 holds no account on the feed. Nothing could have arrived; the
                 device may be perfect. (A car that the feed HAS reported —
                 one moved between companies, say — is judged on its readings
                 like any other, whatever its fleet's account.)
     never       the feed has never reported this car, and its fleet does hold
                 an account. True of a car with no unit fitted and of a unit
                 never registered on the account; the page cannot tell which,
                 so it says neither.
     feed_dark   the car HAS been reported, its fleet holds an account, and not
                 one of that fleet's cars on this page has a reading in the
                 window. Cars do not all go quiet on the same day; a feed or
                 its login does. src/insights.js makes the same call for a
                 cluster of silent trackers (tracker_feed_dark).
     silent      the car has been reported, and its newest reading is older
                 than the window while other cars on the feed are current. */
function judge(feed, r, ctx) {
  const w = FEED_WORDS[feed];
  const at = r[`${feed}_at`];
  const account = ctx.accounts[feed].includes(r.fleet_id);
  if (r[`${feed}_receiving`]) return { state: 'receiving', reason: null };
  if (at == null) {
    return account
      ? { state: 'never', reason: `no ${w.what} reading on record for this car` }
      : { state: 'no_account', reason: `no ${w.account} account for ${FLEET_NAME(r.fleet_id)}` };
  }
  if (account && !ctx.anyReceiving[feed].has(r.fleet_id)) {
    return { state: 'feed_dark',
      reason: `nothing from ${w.provider} for any ${FLEET_NAME(r.fleet_id)} car in ${ctx.hours} hours`
        + ' — the feed or its login, not this car' };
  }
  return { state: 'silent', reason: `no ${w.what} reading in the last ${ctx.hours} hours` };
}

export function feedRoutes(app, { q, wrap }) {
  app.get('/api/vehicles/feeds', wrap(async (_req, res) => {
    const rows = await q(FEEDS_SQL, [FEED_WINDOW_H]);
    const accounts = feedAccounts();

    /* Uber's assignment where it names somebody, custody where it does not. */
    const ids = [...new Set(rows.flatMap((r) => (r.assigned && r.assigned.length
      ? r.assigned : (r.custody_id ? [r.custody_id] : []))))];
    const who = new Map((ids.length ? await q(DRIVERS_SQL, [ids]) : []).map((d) => [d.id, d]));
    const ref = (id, fallbackName) => {
      const d = who.get(id) || {};
      return {
        name: d.person_name || d.account_name || d.roster_name || fallbackName || null,
        /* The account, and only where its page resolves — reachability is
           asserted on exactly this field by test/reachability.test.mjs. */
        id: d.account_page ? id : null,
        person_id: d.person_id != null ? Number(d.person_id) : null,
        phone: d.phone || null,
      };
    };

    const anyReceiving = {
      seat: new Set(rows.filter((r) => r.seat_receiving).map((r) => r.fleet_id)),
      fms_seat: new Set(rows.filter((r) => r.fms_seat_receiving).map((r) => r.fleet_id)),
      fms: new Set(rows.filter((r) => r.fms_receiving).map((r) => r.fleet_id)),
    };
    const ctx = { accounts, anyReceiving, hours: FEED_WINDOW_H };

    const out = rows.map((r) => {
      const seat = judge('seat', r, ctx);
      const fmsSeat = judge('fms_seat', r, ctx);
      const fms = judge('fms', r, ctx);
      const assigned = r.assigned && r.assigned.length ? r.assigned : null;
      const refs = assigned
        ? assigned.map((id) => ref(id, null))
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
        : (r.custody_id || r.custody_name ? [ref(r.custody_id, r.custody_name)] : []);
      return {
        plate: r.plate,
        fleet_id: r.fleet_id,
        vehicle_page: !!r.vehicle_page,
        seat_receiving: !!r.seat_receiving, seat_at: r.seat_at, seat_state: seat.state,
        seat_reason: seat.reason,
        fms_seat_receiving: !!r.fms_seat_receiving, fms_seat_at: r.fms_seat_at,
        fms_seat_state: fmsSeat.state, fms_seat_reason: fmsSeat.reason,
        fms_receiving: !!r.fms_receiving, fms_at: r.fms_at, fms_state: fms.state,
        fms_reason: fms.reason,
        driver_refs: refs,
        driver_basis: assigned ? 'uber_assignment' : refs.length ? 'custody' : null,
        driver_as_of: assigned ? null : r.custody_as_of || null,
        driver_absent: refs.length ? null
          : 'no driver known — Uber assigns nobody to this car and no trip on record names one',
      };
    });

    const count = (feed, yes) => out.filter((r) => r[`${feed}_receiving`] === yes).length;
    const fleets = {};
    for (const r of out) fleets[r.fleet_id || 'unknown'] = (fleets[r.fleet_id || 'unknown'] || 0) + 1;
    /* The database's clock, which is the one the window was measured on. */
    const asOf = rows[0]?.as_of || (await q('SELECT now() AS as_of'))[0]?.as_of;
    res.json({
      as_of: asOf,
      window_hours: FEED_WINDOW_H,
      accounts,
      totals: {
        vehicles: out.length,
        fleets,
        seat: { receiving: count('seat', true), not_receiving: count('seat', false) },
        fms_seat: { receiving: count('fms_seat', true), not_receiving: count('fms_seat', false) },
        fms: { receiving: count('fms', true), not_receiving: count('fms', false) },
      },
      rows: out,
    });
  }));
}
