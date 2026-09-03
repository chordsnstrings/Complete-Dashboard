/* Who held this vehicle, on this day.
   ─────────────────────────────────────────────────────────────────────────
   Every fact this product records about a VEHICLE — an unauthorised journey, a
   harsh-braking event, a document about to expire, a car that moved with no
   booking against it — is a fact about a PERSON, and the plate alone does not
   name them. "L45240 carried a passenger with no booking" is an accusation
   nobody can act on; "L45240, held by Kashif Ali that day" is a conversation.

   Two rules are baked in here and both were learned the hard way:

   1. Custody is per DAY, not current. Naming today's custodian against a flag
      from March accuses whoever happens to hold the car now.

   2. A comma-joined string of names is a dead end by construction: a page can
      print it and nothing more. A handover day names two people and both have
      to be openable, so the pairs form is what the UI links from. Endpoints
      return both — the string for reading, the pairs for clicking.

   Correlated subqueries against vehicle_driver_day, which is indexed on
   (plate, day) — cheap per row and, unlike a join, they cannot multiply the
   row count of the query they are dropped into. */

/* ── one custodian per PERSON, not per platform account ──────────────────
   Everything below folds on the stored person key rather than on
   driver_ext_id, because the question a vehicle page asks is "who held this
   car", and one human holds several accounts. Counting ids answered seven for
   a car five people drove; listing them printed two of the five twice, side by
   side, with their days split between the rows — and a day on which the same
   man's Uber account handed over to his own Yango account was booked as a
   handover, with the idle hours between them charged to the vehicle.

   vehicle_driver_day.person_key is that key: the folded name, plus the three
   verified merges (sql/schema_v53.sql, from api/identity_map.js). Falling back
   to the id keeps a row whose name is missing as its own person rather than
   pooling every anonymous custody row into one very busy driver.

   Defined here rather than as personKeyStored('v') so these helpers stay
   readable at the call site; it is the same expression, and
   test/person_key.test.mjs holds the two forms equal. */
const PERSON_OF = (a) => `coalesce(nullif(${a}.person_key, ''), ${a}.driver_ext_id)`;

/** Names, comma-joined, for the plate and day named by the caller's columns. */
export const custodyNames = (plate, day) =>
  `(SELECT string_agg(nm, ', ' ORDER BY nm) FROM (
      SELECT DISTINCT ON (${PERSON_OF('v')}) v.driver_name AS nm
        FROM vehicle_driver_day v
       WHERE v.plate = ${plate} AND v.day = ${day}
         AND v.driver_name IS NOT NULL
       ORDER BY ${PERSON_OF('v')}, v.is_primary DESC, v.trips DESC) s)`;

/** The same people as {name, id} pairs, so every one of them is clickable. */
export const custodyRefs = (plate, day) =>
  `(SELECT jsonb_agg(jsonb_build_object('name', nm, 'id', id) ORDER BY nm) FROM (
      SELECT DISTINCT ON (${PERSON_OF('v')}) v.driver_name AS nm, v.driver_ext_id AS id
        FROM vehicle_driver_day v
       WHERE v.plate = ${plate} AND v.day = ${day}
         AND v.driver_name IS NOT NULL
       ORDER BY ${PERSON_OF('v')}, v.is_primary DESC, v.trips DESC) s)`;

/* The custodian of a plate as of the most recent day we have custody for, for
   facts that are not about a day at all — a document expiring next month, a
   vehicle that has not earned this quarter. Reported with the day it is drawn
   from, because "held by Kashif" is a different claim if the day is yesterday
   or eleven weeks ago, and a page that hides that distinction invites somebody
   to ring the wrong person. */
export const custodyLatest = (plate) =>
  `(SELECT jsonb_build_object('name', v.driver_name, 'id', v.driver_ext_id,
                              'day', to_char(v.day, 'YYYY-MM-DD'))
      FROM vehicle_driver_day v
     WHERE v.plate = ${plate} AND v.driver_name IS NOT NULL
     ORDER BY v.day DESC, v.is_primary DESC, v.trips DESC LIMIT 1)`;

/* Who held the vehicle across a WINDOW rather than on one day — for tables
   whose rows are a vehicle over a range (a tier mix, a quarter's earnings)
   rather than a dated event. Ordered by days held, so the person who actually
   ran the car leads and an occasional relief driver does not.

   Capped at three: a plate with eleven drivers over a quarter is real, and a
   cell listing all eleven is unreadable and stops being a link anybody clicks.
   The count comes back beside them so the cell can say what it left out — a
   truncated list that does not admit it is a lie by omission. */
export const custodyOverWindow = (plate, from = '$1', to = '$2') => `
  (SELECT jsonb_agg(x) FROM (
     SELECT jsonb_build_object(
              'name', (array_agg(v.driver_name ORDER BY v.is_primary DESC, v.trips DESC))[1],
              'id',   (array_agg(v.driver_ext_id ORDER BY v.is_primary DESC, v.trips DESC))[1],
              'days', count(DISTINCT v.day)::int) AS x
       FROM vehicle_driver_day v
      WHERE v.plate = ${plate} AND v.day BETWEEN ${from}::date AND ${to}::date
        AND v.driver_name IS NOT NULL
      GROUP BY ${PERSON_OF('v')}
      ORDER BY count(DISTINCT v.day) DESC, min(v.driver_name)
      LIMIT 3) s)`;

export const custodyCountOverWindow = (plate, from = '$1', to = '$2') => `
  (SELECT count(DISTINCT ${PERSON_OF('v')})::int
     FROM vehicle_driver_day v
    WHERE v.plate = ${plate} AND v.day BETWEEN ${from}::date AND ${to}::date
      AND v.driver_name IS NOT NULL)`;

/* ── the mirror: what did this PERSON drive? ────────────────────────────
   The same dead end in the other direction. A licence expiring in six days is
   a car that stops earning in six days, and the row that reports it named only
   the person — so working out which asset was about to go idle meant opening
   the driver, reading their custody, and coming back. */

/** The vehicle this person most recently held, with the day it is drawn from. */
export const vehicleLatest = (driverId) =>
  `(SELECT jsonb_build_object('plate', v.plate, 'day', to_char(v.day, 'YYYY-MM-DD'))
      FROM vehicle_driver_day v
     WHERE v.driver_ext_id = ${driverId}
     ORDER BY v.day DESC, v.is_primary DESC, v.trips DESC LIMIT 1)`;

/** Every vehicle this person held over a window, busiest first, capped at three. */
export const vehiclesOverWindow = (driverId, from = '$1', to = '$2') => `
  (SELECT jsonb_agg(x) FROM (
     SELECT jsonb_build_object('plate', v.plate, 'days', count(DISTINCT v.day)::int) AS x
       FROM vehicle_driver_day v
      WHERE v.driver_ext_id = ${driverId} AND v.day BETWEEN ${from}::date AND ${to}::date
      GROUP BY v.plate
      ORDER BY count(DISTINCT v.day) DESC, v.plate
      LIMIT 3) s)`;

/* ── one human, several records ─────────────────────────────────────────
   Uber issues a UUID, Yango a different id, Bolt a third, the hotel channel a
   fourth — all for the same person. Counting DISTINCT driver_ext_id therefore
   counts records, not people: a vehicle driven by five humans across four
   platforms reported seven drivers, and the vehicle page listed two of them
   twice, side by side, with their work split between the rows.

   personFold is the rule that decides two records are one human, and it is
   deliberately the SAME rule /api/driver/* resolves by, so the vehicle page and
   the driver page cannot disagree about how many people there are. It is byte
   for byte the CANON helper in api/server.js; test/consistency.test.mjs asserts
   the two strings are identical, so a change to one that is not made to the
   other fails rather than quietly splitting people again. */
export const personFold = (col) => `regexp_replace(
    btrim(regexp_replace(lower(${col}), '\\s+', ' ', 'g')),
    '(\\m\\w+)( \\1)+', '\\1', 'g')`;

/* ── and the three records the fold is not allowed to see ────────────────
   personFold above is the NAME rule and stays exactly what it was: a name it
   has never met folds by its spelling and by nothing else. Three records on
   this roster are a duplicate of another record that no safe spelling rule
   reaches — two are the same names in the opposite order, one is a
   transliterated vowel — and each was verified against production one at a
   time, id to id. api/identity_map.js is that list, with the measurement that
   decided each entry beside it; sql/schema_v53.sql is generated from the same
   module so the stored column carries the same three ids.

   It is applied HERE rather than inside personFold because the register is
   keyed on the provider ID, not on a name. That is the whole safety property:
   a rule keyed on a name fires on names nobody has looked at, including the
   ones that arrive next month; a list keyed on an id fires on three records
   and can never fire on a fourth. api/roster_routes.js still folds a bare name
   with personFold, which is right — a name is all it has there. */
import { identityCase } from './identity_map.js';

/** The name where there is one, the id where there is not — never both;
    except for the three ids in the verified merge register, which answer the
    person they were verified to be. Character for character what
    sql/schema_v53.sql stores, so the computed key and the stored key are the
    same value — test/person_key.test.mjs compares them on every row. */
export const personKey = (idCol = 'driver_ext_id', nameCol = 'driver_name') =>
  identityCase(idCol, `coalesce(nullif(${personFold(nameCol)}, ''), ${idCol})`);

/** personKey from a table that STORES the fold, rather than computing it.
    The same answer as personKey() and roughly a hundred times cheaper: the
    regex runs once per write instead of once per row per request. Only for
    tables carrying the generated column — trip, driver_platform_state,
    vehicle_driver_day (sql/schema_v20.sql), driver_earnings_component
    (v42), driver_statement_day and driver_payout_day (v51). */
export const personKeyStored = (a) =>
  `coalesce(nullif(${a}.person_key, ''), ${a}.driver_ext_id)`;
/* No identityCase here, deliberately: the stored column already carries the
   register (sql/schema_v53.sql generates it), so wrapping it again would be a
   second copy of the list to keep in step with the first. Every raw reference
   to person_key elsewhere in this codebase — `GROUP BY t.person_key`,
   `WHERE person_key = $1` — is correct for the same reason. */

/** How many DISTINCT PEOPLE, as opposed to how many platform records. */
/* Counting people from the STORED fold, for a query that can reach it.
   ─────────────────────────────────────────────────────────────────────────
   peopleCount() below computes the fold per row, which is right for a query
   over trip_norm alone — the view cannot expose person_key, because a view's
   SELECT t.* is frozen at creation. But a query willing to join the base table
   can have the stored column instead, and over a wide window that is the
   difference between a page and a timeout: /api/alerts/by-driver took 93
   seconds over the whole record and /api/kpis scans the same trips in 0.67,
   with the regex being the entire difference.

   JOIN_TRIP is the join that makes it available, written once because it has
   now been needed in four places and each copy is a chance to join on the wrong
   pair of columns. */
export const JOIN_TRIP = 'JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id';

export const peopleCountStored = (keyCol = 't.person_key', idCol = 'n.driver_ext_id') =>
  `count(DISTINCT coalesce(nullif(${keyCol}, ''), ${idCol}))`;

export const peopleCount = (idCol = 'driver_ext_id', nameCol = 'driver_name') =>
  `count(DISTINCT ${personKey(idCol, nameCol)})`;
