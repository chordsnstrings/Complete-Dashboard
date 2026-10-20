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
              each is meant to send seat data. FMS sends it two ways, and the
              newer of the two is FMS's newest seat reading:
                - live, as 'Seatcount' on GetVehicleCurrentDetails, which the
                  live poller now collects into telemetry_snapshot.seat_count
                  every 2 minutes (schema_v84, src/sources/fms.js);
                - per journey, as the 'Seat Count' in GetTripPassenger,
                  collected into trip.seat_count on every incremental and dated
                  when the journey ended.
              GREATEST ignores a NULL, so a car with only one of the two is
              judged on that one. */
           GREATEST(
             coalesce(
               (SELECT max(t.captured_at) FROM telemetry_snapshot t
                 WHERE t.source = 'fms' AND t.plate = a.plate AND t.seat_count IS NOT NULL
                   AND t.captured_at <= now()),
               (SELECT max(t.captured_at) FROM telemetry_snapshot t
                 WHERE t.source = 'fms' AND t.plate = a.plate AND t.seat_count IS NOT NULL)),
             coalesce(
               (SELECT max(coalesce(t.ended_at, t.requested_at)) FROM trip t
                 WHERE t.platform = 'fms' AND t.plate = a.plate AND t.seat_count IS NOT NULL
                   AND coalesce(t.ended_at, t.requested_at) <= now()),
               (SELECT max(coalesce(t.ended_at, t.requested_at)) FROM trip t
                 WHERE t.platform = 'fms' AND t.plate = a.plate AND t.seat_count IS NOT NULL))) AS fms_seat_at
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
   ever have a reading. Both fleets now hold one on every feed: CABMAN listed
   Ecosine alone until Egari's own DT login was configured on 2026-10-06, and
   until then Egari's cars read "no CABMAN account for Egari" — true of what we
   asked, while the CABMAN portal showed five of them connected. */
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

/* ══ CABMAN: THE SEAT SENSOR HELD AGAINST THE CAR'S OWN MOVEMENT AND ITS BOOKINGS ══
   ═══════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-20, over the table above: "since there are some
   discrepancies let's add a separate seat sensor table for cabman as well
   where we can see seat sensor data and cabman movement data".

   The table above can only say whether a seat reading ARRIVED. It cannot say
   whether the reading is right, and the audit that asked for this table showed
   that the two are far apart. Measured on production over 14–20 Oct, the 46
   cars on CABMAN's list, every completed booking on each:

     - 781 completed bookings (FMS journeys are not bookings); 752 with a
       seat reading inside, and the seat occupied during 512 of them (68%).
     - Five cars drove all week, 4 to 52 bookings each, and their seat never
       once read occupied (L44295: 52 Uber bookings, 1,413 km).
     - L44286 read occupied 20 times in the week and never during a booking.
     - L76099 completed 17 hotel bookings; its unit last reported 16 Apr 2024.
     - L45243's unit stood still through 13 of its 36 bookings long enough to
       measure — the car whose
       CABMAN and FMS put it 25.6 km apart at the same minute (COVERAGE).

   CABMAN's own trip flag is no second witness. Over the same week its
   SeatSensorStatus read "Active" on exactly 6,304 readings and Status read
   "Engaged" on exactly 6,304: the flag is the pad (docs/COVERAGE.md). So the
   independent checks are the two things the pad cannot influence — where the
   unit says the car went, and whether a booking says a passenger was aboard.

   ── WHICH CARS ────────────────────────────────────────────────────────────
   The plates CABMAN lists now: the roster src/sources/cabman.js keeps in
   source_state, members only (admitted and not departed). On 2026-10-20
   CABMAN's latest poll held 46 plates; 106 more had stopped being listed — 65
   at 14 Oct 12:35Z, 41 at 7 Oct 16:25Z — and not one of the 106 has ever had a
   booking with either fleet: they are other companies' cars the Ecosine
   interface used to carry. They are counted under the table with that check,
   never mixed into it. Where no roster has been written yet, the cars with a
   CABMAN reading in the window stand in, and the answer says so.

   ── MOVEMENT ──────────────────────────────────────────────────────────────
   Measured along CABMAN's OWN fixes and no other provider's, by the rule
   /api/map/journey walks (api/server.js): a step counts when the gap is at
   most 20 minutes and the hop under 60 km. Never the day's distance_km from
   that route — it walks every provider's fixes in one line, and on L45243,
   with two units 25 km apart, that line came to 26,528.8 km in the week.

   ── BOOKINGS ──────────────────────────────────────────────────────────────
   trip_norm, is_booking (an FMS journey is the tracker's own record, not a
   booking — channels_sql.js) and outcome 'completed', with an end time. A
   booking is checked on the CABMAN readings from two minutes before it was
   requested to two minutes after drop-off — the pad's 5-minute poll is
   coarse, and a reading just outside the booking is still about it — never
   from before the previous booking's drop-off. A booking with no SEAT reading
   inside that span says nothing about the pad and is counted apart, never as
   a miss. */
export const CAB_DAYS = 7;
export const CAB_GAP_MIN = 20;
export const CAB_HOP_KM = 60;
export const CAB_PAD_MIN = 2;
/* A verdict on the pad needs this many bookings with a seat reading inside:
   one or two short rides can fall between five-minute polls on a working pad. */
export const CAB_MIN_BOOKINGS = 3;
/* At or above this share of bookings the pad is working. The fleet's working
   pads measured 0.92–1.00 in the audit week (L64921 56/56, L75125 46/46,
   L44305 46/48, L77062 38/39); the next car down was 0.70. */
export const CAB_OK_SHARE = 0.8;
/* Standing still through a booking: under half a kilometre moved, on a
   booking of at least 2 km, with at least two readings inside it. */
export const CAB_STILL_KM = 0.5;
export const CAB_TRIP_KM = 2;
/* …and only where movement can be MEASURED: a booking of at least 10 minutes
   with at least 3 readings inside it (2 measured steps). On the production
   week a looser rule (2 readings) named L78465 "not moving with the car" on
   three 4–6 minute hotel jobs — one booked at 13.41 km in six minutes — that
   a 5-minute poll caught twice each: the booking's own times, not the unit. */
export const CAB_STILL_MIN = 10;
export const CAB_STILL_READINGS = 3;
/* Standing still through this share of a car's bookings (and at least three)
   is the unit in another car or filed under another plate, not a pause. */
export const CAB_ELSEWHERE_SHARE = 0.3;

export const CAB_ROSTER_SQL = `
  SELECT fleet_id, value FROM source_state WHERE source = 'cabman' AND key = 'roster'`;
/* The newest reading per plate, whenever it was: a unit silent since 2024 is
   still a unit CABMAN lists. A reading dated in the future is a clock running
   ahead, so only readings up to now count, as in FEEDS_SQL. */
export const CAB_LAST_SQL = `
  SELECT p.plate, l.fleet_id, l.captured_at, l.speed, l.ignition, l.status, l.seat_occupied
    FROM unnest($1::text[]) AS p(plate)
    LEFT JOIN LATERAL (
      SELECT t.fleet_id, t.captured_at, t.speed, t.ignition, t.status, t.seat_occupied
        FROM telemetry_snapshot t
       WHERE t.source = 'cabman' AND t.plate = p.plate AND t.captured_at <= now()
       ORDER BY t.captured_at DESC LIMIT 1) l ON true`;
export const CAB_FIXES_SQL = `
  SELECT plate, fleet_id, captured_at, lat, lng, speed, ignition, status, seat_occupied
    FROM telemetry_snapshot
   WHERE source = 'cabman' AND ($1::text[] IS NULL OR plate = ANY($1::text[]))
     AND captured_at > now() - make_interval(days => $2::int) AND captured_at <= now()
   ORDER BY plate, captured_at`;
export const CAB_BOOKINGS_SQL = `
  SELECT plate, platform, requested_at, ended_at, distance_km
    FROM trip_norm
   WHERE is_booking AND outcome = 'completed' AND plate = ANY($1::text[])
     AND requested_at > now() - make_interval(days => $2::int) AND requested_at <= now()
     AND ended_at IS NOT NULL AND ended_at >= requested_at
   ORDER BY plate, requested_at`;
/* Whether a plate CABMAN stopped listing ever had a booking with us — the
   check that says those plates were never ours. */
export const CAB_EVER_SQL = `
  SELECT plate, count(*)::int AS bookings FROM trip_norm
   WHERE is_booking AND plate = ANY($1::text[]) GROUP BY plate`;

/* The roster rows as the collector writes them, read into members and
   departures. `known` is true once any fleet's roster has been written.
   A plate is one car whatever its fleet: on two rosters it is one row (the
   first fleet's), and a plate that is a member anywhere is never also counted
   as departed — a car moved between fleets is departed on one and listed on
   the other, and printing it in the table AND under it as gone is two answers
   about one car (the review of 2026-10-20). */
export function readRosters(rows) {
  const members = new Map(); const departed = new Map();
  let known = false;
  for (const r of rows || []) {
    let v = null;
    try { v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value; } catch { v = null; }
    if (!v || typeof v !== 'object' || !v.plates || typeof v.plates !== 'object') continue;
    known = true;
    for (const [plate, e] of Object.entries(v.plates)) {
      if (e?.admitted && !e?.departed) {
        if (!members.has(plate)) members.set(plate, { plate, fleet_id: r.fleet_id });
      } else if (e?.departed && !departed.has(plate)) {
        departed.set(plate, { plate, fleet_id: r.fleet_id, last_seen: e.last_seen || null,
          departed_at: e.departed_at || null });
      }
    }
  }
  for (const p of members.keys()) departed.delete(p);
  return { known, members: [...members.values()], departed: [...departed.values()] };
}

const RAD = Math.PI / 180;
const hopKm = (a, b) => {
  const dLat = (b.lat - a.lat) * RAD; const dLng = (b.lng - a.lng) * RAD;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
};
const ms = (v) => (typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Date.parse(v));
const iso = (v) => (v == null ? null : new Date(ms(v)).toISOString());
/* A coordinate the provider did not send is not 0: Number(null) is 0, and a
   reading at (0, 0) beside Dubai is a 6,000 km hop that the 60 km guard then
   throws away together with the two real steps either side of it. */
const coord = (v) => (v == null || v === '' ? NaN : Number(v));
const dubaiDayOf = (t) => new Date(t + 4 * 3600e3).toISOString().slice(0, 10);
const r1 = (x) => Math.round(x * 10) / 10;
const pctOf = (n, d) => (d ? Math.round((1000 * n) / d) / 10 : null);
const many = (n, one, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;

/* Worst first. The order is the order a person should ring about them. */
export const CAB_VERDICTS = ['silent', 'elsewhere', 'no_seat', 'unreported', 'pad_dead', 'pad_misses', 'few', 'no_bookings', 'ok'];
/* …except a silent unit on a car that took no booking since it went quiet.
   On 2026-10-20 thirteen of the fourteen silent units were on cars with no
   booking all week — off the road, most last heard from months ago — and
   ranked first they buried the one silent unit on a car that was working
   (L76099, 17 hotel bookings) and every pad reading wrong on a busy car.
   Counted from the last reading, not over the week: a car that worked all
   week and has been parked since yesterday is a parked car, not a silent
   unit on a working one (the review of 2026-10-20). */
export const cabRank = (r) => (r.verdict === 'silent' && !r.bookings.since_last_reading
  ? CAB_VERDICTS.length : CAB_VERDICTS.indexOf(r.verdict));

/** One car: its readings and bookings in the window, measured and judged. */
function cabmanCar({ plate, fleet_id, last, fixes, bookings, nowMs, days }) {
  const pts = fixes.map((f) => ({ ...f, t: ms(f.captured_at), lat: coord(f.lat), lng: coord(f.lng) }))
    .filter((f) => Number.isFinite(f.t)).sort((a, b) => a.t - b.t);
  const placed = (f) => Number.isFinite(f.lat) && Number.isFinite(f.lng);
  const seat = pts.filter((f) => f.seat_occupied != null);
  const occupied = seat.filter((f) => f.seat_occupied === true);
  const engaged = pts.filter((f) => f.status === 'Engaged');
  const disagree = seat.filter((f) => (f.status === 'Engaged') !== (f.seat_occupied === true)).length;
  /* Walked once over the readings that carry a position: kilometres,
     kilometres with the seat occupied (the step after an occupied reading,
     as /api/map/journey counts it), the days moved and the last movement.
     A DAY is 24 hours counted back from now, so a 7-day window holds 7 of
     them — counted by Dubai calendar date it touched 8 at any hour but
     midnight, and printed "moved on 8 of 7 days" (the review of 2026-10-20). */
  const geo = pts.filter(placed);
  let km = 0; let okm = 0; let measured = 0; let nSteps = 0; let nSeatSteps = 0; let lastMoved = null;
  const dayKm = new Array(days).fill(0);
  const steps = [];
  for (let i = 1; i < geo.length; i++) {
    const a = geo[i - 1]; const b = geo[i];
    const gap = (b.t - a.t) / 6e4;
    const d = hopKm(a, b);
    if (gap > CAB_GAP_MIN || d >= CAB_HOP_KM) continue;
    nSteps++;
    km += d;
    const back = Math.floor((nowMs - b.t) / 864e5);
    if (back >= 0 && back < days) dayKm[back] += d;
    if (a.seat_occupied != null) { nSeatSteps++; measured += d; if (a.seat_occupied === true) okm += d; }
    if (d >= 0.2 || (b.speed || 0) > 0) lastMoved = b.t;
    steps.push({ a: a.t, b: b.t, d });
  }
  /* Each booking, on the readings inside it and the distance the unit moved
     inside it. The span opens 2 minutes before the booking was REQUESTED
     (Uber's trip request time, Bolt's created, Yango's created_at — not the
     pickup) and closes 2 minutes after drop-off; it never opens before the
     previous booking's drop-off, or a chained Uber request would count the
     last ride's passenger as this one's (the review of 2026-10-20). */
  const pad = CAB_PAD_MIN * 6e4;
  const plat = {};
  const bks = [...bookings].sort((x, y) => ms(x.requested_at) - ms(y.requested_at));
  let read = 0; let seen = 0; let noReading = 0; let still = 0; let stillChecked = 0;
  let prevEnd = -Infinity;
  for (const bk of bks) {
    const from = Math.max(ms(bk.requested_at) - pad, prevEnd + 1); const to = ms(bk.ended_at) + pad;
    prevEnd = Math.max(prevEnd, ms(bk.ended_at));
    plat[bk.platform] = (plat[bk.platform] || 0) + 1;
    const inside = pts.filter((f) => f.t >= from && f.t <= to);
    /* Standing still is judged only where movement was MEASURED inside the
       booking (CAB_STILL_MIN, CAB_STILL_READINGS).
       Readings 26 minutes apart are not a car standing still; they are a
       unit reporting in bursts, and calling that "another car" was the
       review's case 5. And the first and last readings inside must be close
       too, so a step the walk refused cannot hide a drive. */
    const here = inside.filter(placed);
    const inSteps = steps.filter((x) => x.a >= from && x.b <= to);
    const lasts = (ms(bk.ended_at) - ms(bk.requested_at)) / 6e4;
    if (here.length >= CAB_STILL_READINGS && inSteps.length >= CAB_STILL_READINGS - 1
      && lasts >= CAB_STILL_MIN && Number(bk.distance_km) >= CAB_TRIP_KM) {
      stillChecked++;
      const moved = inSteps.reduce((x, y) => x + y.d, 0);
      if (moved < CAB_STILL_KM && hopKm(here[0], here[here.length - 1]) < CAB_STILL_KM) still++;
    }
    /* The pad is judged on SEAT readings: a reading with no seat value inside
       a booking says where the car was, not who sat in it. */
    const seatIn = inside.filter((f) => f.seat_occupied != null);
    if (!seatIn.length) { noReading++; continue; }
    read++;
    if (seatIn.some((f) => f.seat_occupied === true)) seen++;
  }
  const lastAt = last?.captured_at ? ms(last.captured_at) : null;
  const receiving = lastAt != null && lastAt > nowMs - FEED_WINDOW_H * 3600e3;
  const since = receiving ? null : bks.filter((b) => lastAt == null || ms(b.requested_at) > lastAt).length;
  /* The verdict, and the sentence that is true of it. */
  const share = read ? seen / read : null;
  let verdict; let text;
  if (!receiving) {
    verdict = 'silent';
    text = (lastAt == null ? 'CABMAN lists this car but has never sent a reading for it'
      : `no CABMAN reading in the last ${FEED_WINDOW_H} hours — the unit is silent`)
      + (since ? `, while the car completed ${many(since, 'booking')} ${lastAt == null ? `in ${days} days` : 'since its last reading'}` : '');
  } else if (still >= CAB_MIN_BOOKINGS && still / stillChecked >= CAB_ELSEWHERE_SHARE) {
    verdict = 'elsewhere';
    text = `CABMAN had the car standing still through ${still} of ${many(stillChecked, 'booking')} of ${CAB_TRIP_KM} km or more — `
      + 'the unit may be fitted to, or filed under, another car';
  } else if (pts.length && !seat.length) {
    /* Readings arrive and none carries a seat value: nothing is reported for
       the pad at all, which is not the same as a pad reading nobody. */
    verdict = 'no_seat';
    text = `the unit sent ${many(pts.length, 'reading')} in ${days} days and none carries a seat value — CABMAN reports no pad on this car`;
  } else if (!read && bks.length >= CAB_MIN_BOOKINGS) {
    /* The car worked and the unit said nothing while it did — not "nothing
       to check": every one of those bookings is a gap (the review's S2). */
    verdict = 'unreported';
    text = `${many(bks.length, 'booking')} in ${days} days and no seat reading fell inside any of them — the unit is not reporting while the car works`;
  } else if (read >= CAB_MIN_BOOKINGS && seen === 0) {
    verdict = 'pad_dead';
    text = `the seat never read occupied during any of ${many(read, 'booking')} — the pad is not reporting passengers`;
  } else if (read >= CAB_MIN_BOOKINGS && share < CAB_OK_SHARE) {
    verdict = 'pad_misses';
    text = `the seat read occupied during only ${seen} of ${many(read, 'booking')}`;
  } else if (read >= CAB_MIN_BOOKINGS) {
    verdict = 'ok';
    text = `the seat read occupied during ${seen} of ${many(read, 'booking')}`;
  } else if (bks.length) {
    verdict = 'few';
    text = read
      ? `only ${many(read, 'booking')} with a seat reading inside — too few to judge the pad`
      : `only ${many(bks.length, 'booking')} in ${days} days, none with a seat reading inside — too few to judge the pad`;
  } else {
    verdict = 'no_bookings';
    text = `no completed booking in ${days} days to hold the seat against`;
  }
  const notes = [];
  if (verdict === 'pad_dead' && occupied.length) {
    notes.push(`it read occupied ${many(occupied.length, 'time')} in the window, never during a booking`);
  }
  if (still && verdict !== 'elsewhere') notes.push(`standing still through ${many(still, 'booking')} of ${CAB_TRIP_KM} km or more`);
  if (noReading && read) notes.push(`${many(noReading, 'booking')} with no seat reading inside`);
  if (disagree >= 20 && disagree >= 0.1 * seat.length) {
    notes.push(`CABMAN's own trip flag (Engaged) disagrees with the seat on ${disagree} of ${seat.length} readings`);
  }
  /* Absent, never 0, when there was nothing to measure — and the reason. No
     accepted step means no distance was MEASURED, which is not a car that did
     not move (the review's case 4); no step after a seat reading means no
     passenger distance was measured. */
  const kmReason = nSteps ? null
    : !pts.length ? `no CABMAN reading in ${days} days`
      : geo.length < 2 ? 'fewer than two readings carry a position'
        : `no two readings within ${CAB_GAP_MIN} minutes of each other, so no distance could be measured`;
  return {
    plate, fleet_id, vehicle_page: true,
    last_at: iso(lastAt), last_status: last?.status ?? null, last_speed: last?.speed ?? null,
    last_ignition: last?.ignition ?? null, receiving,
    readings: pts.length, seat_readings: seat.length, occupied_readings: occupied.length,
    occupied_pct: pctOf(occupied.length, seat.length), engaged_readings: engaged.length,
    flag_disagrees: disagree,
    steps: nSteps,
    km: nSteps ? r1(km) : null, km_reason: kmReason,
    occupied_km: nSeatSteps ? r1(okm) : null,
    occupied_km_pct: nSeatSteps && measured > 0 ? pctOf(okm, measured) : null,
    days_moved: nSteps ? dayKm.filter((d) => d >= 1).length : null,
    last_moved_at: iso(lastMoved),
    last_occupied_at: occupied.length ? iso(occupied[occupied.length - 1].t) : null,
    bookings: { total: bks.length, read, seat_seen: seen, seat_pct: pctOf(seen, read),
      no_reading: noReading, standing_still: still, still_checked: stillChecked, since_last_reading: since,
      platforms: plat },
    verdict, verdict_text: text, notes,
  };
}

/** The whole table from what the four statements return. Pure, so the
    tests and the mock both run exactly what the route runs. */
export function cabmanSeat({ rosterRows = [], last = [], fixes = [], bookings = [], ever = [], now, days = CAB_DAYS }) {
  const nowMs = now ? ms(now) : Date.now();
  const roster = readRosters(rosterRows);
  const by = (list) => {
    const m = new Map();
    for (const x of list) { if (!m.has(x.plate)) m.set(x.plate, []); m.get(x.plate).push(x); }
    return m;
  };
  const fx = by(fixes); const bk = by(bookings);
  const lastOf = new Map(last.map((l) => [l.plate, l]));
  const cars = roster.known
    ? roster.members
    : [...fx.keys()].map((plate) => ({ plate, fleet_id: fx.get(plate)[0]?.fleet_id ?? null }));
  const rows = cars.map((c) => cabmanCar({ plate: c.plate, fleet_id: c.fleet_id || lastOf.get(c.plate)?.fleet_id || null,
    last: lastOf.get(c.plate), fixes: fx.get(c.plate) || [], bookings: bk.get(c.plate) || [], nowMs, days }))
    .sort((a, b) => cabRank(a) - cabRank(b)
      || (b.bookings.total - a.bookings.total) || a.plate.localeCompare(b.plate))
    .map((r) => ({ ...r, rank: cabRank(r) }));
  const everOf = new Map(ever.map((e) => [e.plate, Number(e.bookings) || 0]));
  /* The plates CABMAN stopped listing, grouped by the Dubai day they were
     last listed, with the one fact that decides whether they matter. */
  const groups = {};
  for (const d of roster.departed) {
    const day = d.last_seen ? dubaiDayOf(ms(d.last_seen)) : null;
    const g = groups[day ?? 'unknown'] || (groups[day ?? 'unknown'] = { day, plates: 0 });
    g.plates++;
  }
  const verdicts = Object.fromEntries(CAB_VERDICTS.map((v) => [v, rows.filter((r) => r.verdict === v).length]));
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  return {
    as_of: new Date(nowMs).toISOString(), days, window_hours: FEED_WINDOW_H,
    roster: { known: roster.known, basis: roster.known ? 'roster' : 'readings',
      basis_reason: roster.known ? null
        : 'CABMAN’s own list has not been read yet, so the cars with a CABMAN reading in the window stand in for it' },
    rules: { gap_min: CAB_GAP_MIN, hop_km: CAB_HOP_KM, pad_min: CAB_PAD_MIN, min_bookings: CAB_MIN_BOOKINGS,
      ok_share: CAB_OK_SHARE, still_km: CAB_STILL_KM, trip_km: CAB_TRIP_KM, elsewhere_share: CAB_ELSEWHERE_SHARE,
      still_min: CAB_STILL_MIN, still_readings: CAB_STILL_READINGS },
    totals: {
      cars: rows.length, verdicts,
      bookings: sum((r) => r.bookings.total), bookings_read: sum((r) => r.bookings.read),
      bookings_seat_seen: sum((r) => r.bookings.seat_seen),
    },
    departed: {
      plates: roster.departed.length,
      with_bookings: roster.departed.filter((d) => (everOf.get(d.plate) || 0) > 0).length,
      groups: Object.values(groups).sort((a, b) => b.plates - a.plates || String(b.day).localeCompare(String(a.day))),
    },
    rows,
  };
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
        /* NOTHING AT ALL: no CABMAN seat sensor, no FMS seat count and no FMS
           reading in the window — the car is invisible to every tracker we
           read, so no journey it makes can be checked against a booking.
           The operator, 2026-10-06: "it should also show a number of vehicle
           which is not receiving any data whether fms or cabman". */
        no_data: !r.seat_receiving && !r.fms_seat_receiving && !r.fms_receiving,
        /* …and never has: every feed is 'never' or has no account for its
           fleet. Kept apart from one that went silent, because one is a car
           nobody fitted or linked and the other is a device that stopped. */
        no_data_ever: [seat.state, fmsSeat.state, fms.state].every((x) => x === 'never' || x === 'no_account'),
        driver_refs: refs,
        driver_basis: assigned ? 'uber_assignment' : refs.length ? 'custody' : null,
        driver_as_of: assigned ? null : r.custody_as_of || null,
        driver_absent: refs.length ? null
          : 'no driver known — Uber assigns nobody to this car and no trip on record names one',
      };
    });

    const count = (feed, yes) => out.filter((r) => r[`${feed}_receiving`] === yes).length;
    const dark = out.filter((r) => r.no_data);
    const noData = { vehicles: dark.length, never: dark.filter((r) => r.no_data_ever).length, fleets: {} };
    for (const r of dark) noData.fleets[r.fleet_id || 'unknown'] = (noData.fleets[r.fleet_id || 'unknown'] || 0) + 1;
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
        no_data: noData,
      },
      rows: out,
    });
  }));

  /* The CABMAN table: see "CABMAN: THE SEAT SENSOR HELD AGAINST …" above. */
  app.get('/api/vehicles/feeds/cabman', wrap(async (_req, res) => {
    const rosterRows = await q(CAB_ROSTER_SQL);
    const roster = readRosters(rosterRows);
    const plates = roster.known ? roster.members.map((m) => m.plate) : null;
    /* No roster yet: the plates with a reading in the window stand in. */
    const fixes = await q(CAB_FIXES_SQL, [plates, CAB_DAYS]);
    const list = plates || [...new Set(fixes.map((f) => f.plate))];
    const [last, bookings, ever, [{ now }]] = await Promise.all([
      list.length ? q(CAB_LAST_SQL, [list]) : [],
      list.length ? q(CAB_BOOKINGS_SQL, [list, CAB_DAYS]) : [],
      roster.departed.length ? q(CAB_EVER_SQL, [roster.departed.map((d) => d.plate)]) : [],
      q('SELECT now() AS now'),
    ]);
    res.json(cabmanSeat({ rosterRows, last, fixes, bookings, ever, now, days: CAB_DAYS }));
  }));
}
