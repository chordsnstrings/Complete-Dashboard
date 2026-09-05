/* Per-driver detail API.
   ─────────────────────────────────────────────────────────────────────────
   One human can be several records: Uber issues a UUID, Yango a different id,
   Bolt a third, and the hotel channel a fourth — all for the same person. The
   only thing they share is the name they are entered under, and even that is
   inconsistent ("Najeeb Ullah Khan" vs "Najeeb Ullah Khan Khan"). So every
   endpoint here starts by resolving the requested id into the *set* of records
   that plausibly belong to one driver, and answers over that whole set.

   Resolution is deliberately conservative: we match on an exact normalised
   name, never on a fuzzy score, because merging two real people into one page
   is a worse failure than showing the same person twice. */

import { win, winDays } from './window.js';
import { fleetIncome, COMPLETED_SQL } from './income_sql.js';
/* The alerts-per-distance rule, shared with the fleet headline and both
   economics ledgers so this page cannot disagree with the tables that link
   to it. See api/alert_coverage_sql.js for the rule and its assumption. */
import { alertCoverage, alertRate, alertRateReason, drivingCount,
  deviceCount, isDeviceFault, DEVICE_FAULT_SQL } from './alert_coverage_sql.js';
import { areaOf } from './analytics_routes.js';
/* A pg DATE, as the day it holds. Imported rather than re-typed: it is not a
   cycle (src/sources/ledger.js reaches only src/db.js and src/log.js, and
   nothing under src/ imports this file), api/day_routes.js and
   api/economics_routes.js already read this same function, and a fourth local
   copy of a rule this product has now got wrong in four places is a fourth
   place to get it wrong. */
import { isoDay } from '../src/sources/ledger.js';
import { isAdmin } from './admin_gate.js';
import { IDENTITY_DOCS, stripIdentity, withheldNote } from './redact.js';
/* The three identities a human verified, id to id — see api/identity_map.js
   for the measurement behind each and why this is a LIST and not a rule. The
   stored person_key already carries them (sql/schema_v53.sql generates it from
   the same module), so every aggregate here folds them together on its own.
   These two helpers are for the parts of a driver page that are not an
   aggregate: resolving the id in the URL, and the directory's per-row fold,
   where a record with no work in the window has no stored key to fold on. */
import { canonicalName, mergedIds, mergedNames, mergedPlatforms, ALIAS_KEY,
  personOf } from './identity_map.js';

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

/* Some feeds duplicate a name part ("Khan Khan", "Gul Gul"). Collapsing an
   immediately-repeated word is safe — it never merges distinct names.

   ANY repeated adjacent word, not only the final pair. This collapsed the last
   two words only, while the SQL fold in api/server.js collapses every repeat
   wherever it falls — so "Sajid Gul Gul Muhammad" folded to itself here and to
   "Sajid Gul Muhammad" there, and the driver directory and the driver ranking
   reported different headcounts for the same fleet on the same window. Two
   implementations of one identity rule is two answers to "how many drivers do
   we have"; test/consistency.test.mjs now runs both folds over the same names
   and requires the same answer. */
function canonName(s) {
  const parts = norm(s).split(' ').filter(Boolean);
  const out = [];
  for (const w of parts) if (out[out.length - 1] !== w) out.push(w);
  return out.join(' ');
}

/* Two folds, deliberately different, and it matters which is which.

   CANON is the plain fold: trim, collapse runs of whitespace, lowercase. It is
   the *identity* fold — it is what synthesises a stable key for a driver the
   provider names but never gives an id, and the same expression is used in
   custody.js, so the person keys identically in vehicle_driver_day and here.

   canonName() above is the looser *alias* fold, used only to decide that two
   ids belong to one human. It additionally collapses a duplicated surname,
   which is right for grouping and wrong for a key: fold the key that way and a
   feed that starts spelling somebody "Khan Khan" silently renames their id.

   canonSql() is CANON in JS, so a key built in Node matches one built in
   Postgres. Never build a name: key with canonName(). */
const CANON = (col) => `lower(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`;
const canonSql = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const nameKey = (s) => `name:${canonSql(s)}`;
const isNameKey = (id) => String(id || '').startsWith('name:');

export function driverRoutes(app, { q, wrap, endOfDay }) {

  /* Resolve `?id=` (a platform driver id, or a synthesised name: key) or
     `?name=` into every record for that person. Returns null when nothing
     matches, so callers can 404 honestly. */
  async function resolve(req) {
    const id = req.query.id || null;
    const nameQ = req.query.name || null;
    let seed = null;
    /* A name: key is not a provider id and will never be found in a
       driver_ext_id column — looking it up there 404s a person the directory
       just linked to. It carries its own name, so resolve it directly. */
    if (id && isNameKey(id)) {
      const want = id.slice(5);
      /* person_key rather than the fold. Identical value — sql/schema_v20.sql
         stores this exact expression — but a stored column has an index and a
         computed one cannot, so this was a full scan of 175,000 rows folded
         twice on every driver page, before the page had asked for anything. */
      [seed] = await q(
        `SELECT NULL::text AS driver_ext_id, driver_name, platform FROM trip
         WHERE person_key = $1 AND coalesce(btrim(driver_ext_id), '') = ''
         ORDER BY requested_at DESC LIMIT 1`, [want]);
      if (!seed) [seed] = await q(
        `SELECT NULL::text AS driver_ext_id, driver_name, platform FROM trip
         WHERE person_key = $1 ORDER BY requested_at DESC LIMIT 1`, [want]);
      if (!seed && !nameQ) return null;
    } else if (id) {
      [seed] = await q(
        `SELECT driver_ext_id, driver_name, platform FROM trip
         WHERE driver_ext_id = $1 AND driver_name IS NOT NULL ORDER BY requested_at DESC LIMIT 1`, [id]);
      if (!seed) [seed] = await q(
        `SELECT driver_ext_id, full_name AS driver_name, platform FROM driver_compliance
         WHERE driver_ext_id = $1 LIMIT 1`, [id]);
      if (!seed) [seed] = await q(
        `SELECT driver_ext_id, driver_name, platform FROM driver_performance
         WHERE driver_ext_id = $1 ORDER BY period_end DESC LIMIT 1`, [id]);
      // last resort: the id exists on trips but nothing ever gave it a name
      if (!seed) [seed] = await q(
        `SELECT driver_ext_id, driver_name, platform FROM trip
         WHERE driver_ext_id = $1 ORDER BY requested_at DESC LIMIT 1`, [id]);
      /* …unless the merge register knows it. The Bolt record in it holds no
         trip, no compliance row and no performance row — a platform standing
         is its whole existence — so every seed above misses it and the page
         404s a person the directory links to. */
      if (!seed && !nameQ && !canonicalName(id)) return null;   // unknown id — say so rather than answering emptily
    }
    /* A verified duplicate answers under the name of the record it duplicates,
       which is what makes the resolution symmetric: person_key on the trip
       table is already the survivor's key for BOTH records, so folding the
       requested id onto the survivor's name here means opening either one
       finds both. Without it, opening the Yango record searched for "khalil
       aliyan", matched no trip row (they now key as "aliyan khalil") and
       showed a 429-day veteran as a 20-trip newcomer — which is exactly what
       production does today. */
    const name = canonicalName(id) || seed?.driver_name || nameQ;
    if (!name) return id
      ? { id, name: null, ids: [id], keys: [id], platforms: seed ? [seed.platform] : [] }
      : null;

    /* Every id sharing the canonical name, across all sources that carry names.
       Rows with no id contribute the synthesised name: key rather than being
       dropped, so a person the provider names but never numbers still resolves
       to something the trip queries below can match. */
    /* Matched in SQL, not in Node. This selected EVERY row of trip, folded the
       name on each, shipped all 175,000 to the process and then kept the
       handful that matched — on every one of the eight or so requests a driver
       page makes. The trip side is now an indexed lookup on person_key, which
       stores the same fold; the other two tables are small enough that folding
       them in place costs nothing, and they have no such column. */
    const want = canonName(name);
    const alias = await q(
      `SELECT DISTINCT platform, driver_ext_id, driver_name FROM (
         SELECT platform,
                coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || person_key) AS driver_ext_id,
                driver_name FROM trip WHERE person_key = $1
         UNION ALL
         SELECT platform,
                coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || ${CANON('full_name')}), full_name
           FROM driver_compliance WHERE ${CANON('full_name')} = $1
         UNION ALL
         SELECT platform,
                coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || ${CANON('driver_name')}), driver_name
           FROM driver_performance WHERE ${CANON('driver_name')} = $1
       ) s WHERE coalesce(btrim(driver_name), '') <> ''`, [want]);
    /* flatMap through the register, so the partner id is present whichever
       side was asked for. It adds nothing at all for the other 392 records —
       mergedIds returns the id it was given — and it is what carries a record
       that has no row in ANY of the three tables above (the Bolt standing)
       into the account list of the person it belongs to. */
    const ids = [...new Set([...alias.map((a) => a.driver_ext_id), ...(id ? [id] : [])]
      .filter(Boolean).flatMap(mergedIds))];
    if (!ids.length) return null;

    /* Two different lists, and conflating them was a bug in both directions.

       `ids` is what this person's ACCOUNTS are — the provider ids they hold. It
       is shown to a reader ("three accounts across two platforms"), so a
       synthesised key has no business in it.

       `keys` is what their ROWS can be MATCHED by, which is a superset: the
       same ids, plus the synthesised name key for every spelling they appear
       under. A driver who works Uber under an id and the hotel channel without
       one carries both forms, and matching on ids alone left their hotel work
       off their own page while the fleet totals still counted it. A key that
       matches nothing costs one comparison. */
    const keys = [...new Set([...ids,
      ...alias.map((a) => nameKey(a.driver_name)), nameKey(name),
      /* Both spellings of a merged person, for rows the provider named
         without numbering — a key that matches nothing costs one comparison. */
      ...ids.flatMap(mergedNames).map(nameKey)].filter(Boolean))];
    // the longest spelling is usually the fullest one; prefer it for display
    const display = alias.map((a) => a.driver_name).sort((a, b) => b.length - a.length)[0] || name;
    return { id: id || ids[0], name: display, ids, keys,
      /* The register's channels as well as the measured ones: the Bolt half of
         one merged pair files no trips at all, so a list built from work alone
         would omit the channel carrying the fact the operator needs — that the
         fleet deactivated that account. */
      platforms: [...new Set([...alias.map((a) => a.platform), ...ids.flatMap(mergedPlatforms)])] };
  }

  /* The person key: a provider id where there is one, the synthesised name: key
     where there is not. Every query over trip/trip_norm keys on this, never on
     the raw column — keyed raw, a driver the provider names without an id has
     no matchable rows and every panel on their page comes back empty while the
     directory row that linked there says they drove. */
  const PKEY = `coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || ${CANON('driver_name')})`;

  /* The window, as Dubai calendar days — the same expression trip_norm.local_day
     is built from (sql/schema_v18.sql:67) and driver_day is keyed on.

     This was `requested_at BETWEEN $1 AND $2`, a raw timestamptz bound in a UTC
     session, and it cost this page the first four hours of every window. Dubai
     is UTC+4, so the calendar day 2026-08-01 begins at 2026-07-31T20:00Z; a
     bound starting at 2026-08-01T00:00Z drops 00:00–04:00 Dubai on the window's
     first day and picks up the same slice of the day AFTER the last one.

     It was not a rounding error. Reconciled day by day against the trip record
     for one driver's August, /api/driver/daily reported 283 trips where the
     trip list and driver_day both reported 285 — every day agreeing except the
     first, which showed 4 against 6. The same page therefore disagreed with the
     stored per-day record it is drawn beside, and with the fleet totals, which
     have used local_day all along.

     api/server.js carries the same note for the window's END (DAYWIN), and the
     driver directory below fixed its own copy of this bug; the detail page kept
     it because `win()` widens the upper bound to 23:59:59.999 and so LOOKS
     right. The lower bound is the half nothing widened.

     `$2::date` truncates that widened upper bound back to its day, which is
     what a day-grain comparison wants. */
  const DAYWIN = (col) => `(${col} AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date`;

  // Shared trip predicate: any of this person's keys, over the window.
  // `$1..$2` window, `$3` key array — keep this argument order in every query.
  const TW = `${PKEY} = ANY($3) AND ${DAYWIN('requested_at')}`;

  // Wrap a handler so it resolves the driver first and 404s cleanly when unknown.
  const withDriver = (fn) => wrap(async (req, res) => {
    const d = await resolve(req);
    if (!d) return res.status(404).json({ error: 'driver not found' });
    // The MATCH set, not the account list — see resolve() above.
    return fn(req, res, d, [...win(req), d.keys]);
  });

  /* ── directory: every driver we know of, one row each ─────────────────
     Four things were wrong here and all four made the page describe the fleet
     as busier and cleaner than it is:

       - it was built FROM the trip table, so a driver who took nothing in the
         window had no row at all — under a panel headed "All drivers". Sixty-
         four of the people missing that way had an expired licence, which is
         exactly who an operator opens this page to find. The sibling vehicle
         directory does the opposite on purpose and says so.
       - the window was bound as a raw timestamptz in a UTC session, so it
         dropped the Dubai 00:00-04:00 slice of the first day and added a
         phantom one after the last — and the /api/vehicles panel on the same
         screen used Dubai days, so the two disagreed about the same plate.
       - the fold summed trips and kilometres but never recomputed
         completion_pct, so a person carried whichever account happened to be
         listed first — presented as that human's completion rate.
       - `days` took the MAX across a person's accounts rather than the union,
         so days worked on one platform and not another were discarded.

     Completion is over trip_norm.outcome, not status='completed': Bolt says
     'finished', and testing for 'completed' scored every completed Bolt trip
     as a failure. */
  app.get('/api/drivers/directory', wrap(async (req, res) => {
    /* range, not winDays. This read from/to and nothing else, so the platform
       and fleet chips above the directory changed none of its 359 rows: with
       Bolt selected the page stated that 118 people drove on Bolt and plotted
       80 of them, on a channel with no trip anywhere in the database, and
       &fleet=egari came back byte-identical to unfiltered on a two-fleet
       operator.

       A filter narrows the POPULATION as well as the work. With a platform
       selected, "everyone we know of" is everyone who drove on that platform
       in the window or holds a compliance or standing record on it — not
       everyone in the fleet with their trips zeroed, which would report the
       whole roster as idle on Bolt. */
    /* range() lives in server.js and is not among this module's injected deps;
       it is winDays plus the two chips, so it is spelled out here rather than
       threading a new dependency through every route module. */
    const [from, to] = winDays(req);
    const platform = req.query.platform || null;
    const fleet = req.query.fleet || null;
    const P = [from, to, platform, fleet];
    const filtered = !!(platform || fleet);
    /* "Has this person ever driven, and when last" is the one question here
       with no window, so answering it live means grouping the entire trip
       history on every request — two hundred and fifteen thousand rows to
       decorate eight hundred directory rows. driver_lifetime holds it,
       rebuilt after every collection from the SAME SQL that is the fallback
       below, so the two cannot disagree; the fallback runs on a fresh
       database or a deploy that lands before the first rollup.

       A seq-scan predicate on purpose, in both. Written as
         WHERE person_key IS NOT NULL AND person_key <> ''
       it matches the partial index's own predicate exactly, so the planner
       chose an index scan and then fetched the heap row for essentially every
       row in the table: this endpoint went from 4.3s to 41s. The projection
       still uses person_key, which is where the saving actually was. */
    const lifetimeReady = (await q('SELECT 1 FROM driver_lifetime LIMIT 1')).length > 0;
    /* The placeholder licence date, detected the way /api/compliance/drivers
       and src/insights.js already detect it: one date on at least half the
       dated rows, over at least five of them, is what this source writes when
       the field was never filled in.
       ─────────────────────────────────────────────────────────────────────
       The directory did not know about it. All 77 rows carrying licence number
       123456 and the identical date 2026-01-01 were served with a past expiry,
       and the page counted them into "77 with an expired licence" and painted
       red EXPIRED pills — while /api/compliance/drivers, describing the same
       people, reported expired: 0. Two pages of one product disagreeing about
       whether 77 named people may legally drive. */
    const [phRow] = await q(
      `SELECT to_char(licence_expires, 'YYYY-MM-DD') AS d, count(*)::int n,
              (SELECT count(*)::int FROM driver_compliance WHERE licence_expires IS NOT NULL) AS with_date
       FROM driver_compliance WHERE licence_expires IS NOT NULL
       GROUP BY licence_expires ORDER BY n DESC LIMIT 1`);
    const placeholderDate = phRow && phRow.with_date && phRow.n >= 5
      && phRow.n / phRow.with_date >= 0.5 ? phRow.d : null;
    /* The lifetime CTE carries identity now, not just counts.
       ─────────────────────────────────────────────────────────────────────
       Measured on production over thirty days: 361 rows, 244 of them with no
       fleet, no channel list and no vehicle — one of those people has 2,393
       trips on record. Every one of those columns was read from the WINDOW's
       trips, and a person who last drove in June has none. A driver's fleet is
       not a fact about a date range, so it is answered over the whole history
       and used only where the window has nothing to say. The fallback below
       computes the same three columns, so a fresh database behaves
       identically. */
    const everSql = lifetimeReady
      ? `SELECT driver_ext_id, driver_name, last_ever, lifetime,
                last_fleet, platforms AS ever_platforms, last_plate
           FROM driver_lifetime`
      : `SELECT coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || person_key) AS driver_ext_id,
                max(driver_name) AS driver_name,
                max(requested_at) last_ever, count(*)::int lifetime,
                (array_agg(fleet_id ORDER BY requested_at DESC NULLS LAST)
                   FILTER (WHERE fleet_id IS NOT NULL))[1] AS last_fleet,
                array_agg(DISTINCT platform)
                  FILTER (WHERE platform IS NOT NULL AND platform <> '') AS ever_platforms,
                (array_agg(plate ORDER BY requested_at DESC NULLS LAST)
                   FILTER (WHERE plate IS NOT NULL AND btrim(plate) <> ''))[1] AS last_plate
           FROM trip WHERE driver_name IS NOT NULL AND btrim(driver_name) <> '' GROUP BY 1`;
    const rows = await q(
      `WITH ever AS (${everSql}),
       work AS (
         /* The synthesised key from the STORED fold. Written with the fold
            inline it ran two nested regexes over every row in the window as
            the GROUP BY key, which is nineteen twentieths of this CTE's cost
            (schema_v20 measured 2,434ms against 129ms) — and it is the same
            value, because person_key IS that expression, generated and
            stored. The filter still tests driver_name: matching the partial
            index's own predicate is what took this endpoint from 4.3s to 41s. */
         SELECT coalesce(nullif(btrim(n.driver_ext_id), ''),
                         'name:' || bt.person_key) AS driver_ext_id,
                max(n.driver_name) AS work_name,
                /* The STORED fold of the name this person drove under, carried
                   out so the fold below can key on it. See the note at the
                   fold. */
                max(bt.person_key) AS person_key,
                min(n.fleet_id) fleet_id,
                count(*) FILTER (WHERE n.is_booking)::int trips,
                count(*) FILTER (WHERE n.outcome = 'completed')::int completed,
                count(*) FILTER (WHERE n.outcome IS NOT NULL)::int bookable,
                count(DISTINCT n.local_day)::int days,
                round(sum(n.distance_km) FILTER (WHERE n.is_booking AND n.has_distance)::numeric,0) km,
                round(sum(n.price) FILTER (WHERE n.has_fare)::numeric,0) revenue,
                count(*) FILTER (WHERE n.has_fare)::int priced_trips,
                max(n.requested_at) last_trip, min(n.requested_at) first_trip,
                array_agg(DISTINCT n.platform) platforms,
                mode() WITHIN GROUP (ORDER BY n.plate) AS plate
         FROM trip_norm n JOIN trip bt ON bt.platform = n.platform AND bt.external_id = n.external_id
         -- Grouped on the SAME synthesised key as the ids CTE below. Keyed on
         -- the raw column, a driver named without an id had an ids row and no
         -- work to join to it, so they appeared with a permanent zero, which is
         -- worse than absent: it reads as somebody who did nothing.
         WHERE n.local_day BETWEEN $1::date AND $2::date
           AND coalesce(btrim(n.driver_name), '') <> ''
           AND ($3::text IS NULL OR n.platform = $3)
           AND ($4::text IS NULL OR n.fleet_id = $4)
         GROUP BY 1
       ),
       ids AS (
         /* Everyone we know of, from any source, whether or not they drove.
            A name with no id is still a person: the id is synthesised from the
            canonical name so they key identically here, in the work CTE below,
            and in vehicle_driver_day. Requiring an id here made those people
            vanish from the directory entirely.

            The trip branch reads the CTE above rather than scanning the table
            a second time. The who CTE takes max(driver_name) per key, so
            collapsing the several names a key may carry to their max here
            leaves that maximum unchanged. */
         /* The all-time branch carries no platform or fleet — driver_lifetime
            is keyed on the person alone — so under a filter it would readmit
            the whole roster with its work zeroed, which reads as "everybody is
            idle on Bolt". Under a filter the population is exactly the people
            the three filterable sources name. */
         SELECT driver_ext_id, driver_name FROM ever
           WHERE $3::text IS NULL AND $4::text IS NULL
         UNION
         SELECT w.driver_ext_id, w.work_name FROM work w
         UNION
         SELECT coalesce(nullif(btrim(driver_ext_id), ''),
                         'name:' || ${CANON('full_name')}), full_name FROM driver_compliance
           WHERE coalesce(btrim(full_name), '') <> ''
             AND ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR fleet_id = $4)
         UNION
         SELECT coalesce(nullif(btrim(driver_ext_id), ''),
                         'name:' || ${CANON('full_name')}), full_name FROM driver_platform_state
           WHERE coalesce(btrim(full_name), '') <> ''
             AND ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR fleet_id = $4)
       ),
       who AS (
         SELECT driver_ext_id, max(driver_name) AS driver_name FROM ids GROUP BY 1
       ),
       /* What actually reached the fleet for this person's work.
          ─────────────────────────────────────────────────────────────────────
          The revenue column beside this one is sum(trip.price), and the Uber
          trip export has no fare column at all (sql/schema_v18.sql:73). Uber is
          236,000 of the fleet's 253,000 trips, so on a seven-day window 101
          people drove and 21 had a fare — eighty rows of a table whose job is
          to rank people showed a dash in the only money column it had.

          The money exists; it is simply not a fare. driver_payout_day carries
          what each account was PAID, and that is what an operator ranking
          drivers is actually asking about. Keyed on the account id and summed
          over the window's days, so overlapping report periods cannot double
          count — that resolution already happened when the table was built
          (sql/schema_v23.sql). */
       pay AS (
         SELECT driver_ext_id,
                round(sum(earnings)::numeric, 0) AS payout,
                count(DISTINCT day)::int AS payout_days
           FROM driver_payout_day
          WHERE day BETWEEN $1::date AND $2::date
            AND ($3::text IS NULL OR platform = $3)
            AND ($4::text IS NULL OR fleet_id = $4)
          GROUP BY 1
       ),
       /* One money column that answers for everybody.
          ─────────────────────────────────────────────────────────────────────
          The two columns beside it each answer for about half the roster and
          for different halves: revenue is the fares on the trips, which 44 of
          119 active drivers have, because Uber's export carries no fare at all;
          payout is what the platform paid, which 96 have. Between them nobody
          is missing — and a reader ranking drivers is reading one column for
          one person and a different, incomparable one for the next.

          driver_day.money is the resolution this fleet already made: per
          platform, the statement's net where a channel filed one and its fares
          where it did not, then summed (src/rollup.js). money_period_days
          travels with it because most of it is a weekly statement divided
          across its days, and the coarsest window on a person's days is what
          limits what can be said about their total.

          Keyed on the account and summed: the money lands on ONE account per
          person-day by design (the owner CTE in src/rollup.js), so a person
          holding two accounts is added, not doubled. */
       dmoney AS (
         SELECT driver_ext_id,
                round(sum(money)::numeric, 0) AS money,
                count(*) FILTER (WHERE money IS NOT NULL)::int AS money_days,
                CASE WHEN bool_or(money IS NOT NULL AND money_period_days IS NULL) THEN NULL
                     ELSE max(money_period_days) END AS money_period_days,
                CASE WHEN count(DISTINCT money_source) FILTER (WHERE money_source <> 'none') > 1
                     THEN 'mixed'
                     ELSE max(money_source) FILTER (WHERE money_source <> 'none') END AS money_source
           FROM driver_day
          WHERE day BETWEEN $1::date AND $2::date
            AND ($4::text IS NULL OR fleet_id = $4)
          GROUP BY 1
       )
       /* The lifetime figures come from the CTE at the top of this statement:
          the last trip EVER, so "has not driven in this window" and "has never
          driven" are different rows rather than the same blank — and keyed on
          person_key rather than the fold, because that scan is unbounded and
          folding 175,000 names per request is what the stored, indexed column
          exists to avoid. */
       SELECT who.driver_ext_id, who.driver_name, w.person_key,
              coalesce(w.trips, 0) AS trips, coalesce(w.completed, 0) AS completed,
              coalesce(w.bookable, 0) AS bookable, coalesce(w.days, 0) AS days,
              w.km, w.revenue, coalesce(w.priced_trips, 0) AS priced_trips,
              pay.payout, coalesce(pay.payout_days, 0) AS payout_days,
              dm.money, coalesce(dm.money_days, 0) AS money_days,
              dm.money_period_days, dm.money_source,
              w.last_trip, w.first_trip,
              /* Window first, whole history second. The window answer is the
                 one that describes THIS range; the lifetime answer exists so
                 that a person the range does not cover is still identified
                 rather than shown as four blanks under their own name.
                 ever_* is never used to overwrite a window value. */
              coalesce(w.plate, ev.last_plate) AS plate,
              /* …and the books, third. 129 of the people still blank after
                 the history fallback have never driven at all, so no trip can
                 name their fleet — but every one of them holds a standing or a
                 compliance record, and BOTH of those tables carry fleet_id
                 (this query already filters on it). A person on the books with
                 no fleet beside their name is the page failing to read a
                 column it is already joined to. */
              coalesce(w.fleet_id, ev.last_fleet, dc.fleet_id, dps.fleet_id) AS fleet_id,
              coalesce(w.platforms, ev.ever_platforms, ARRAY[]::text[]) AS platforms,
              /* So a reader can tell a measurement from an identity: true
                 where these three describe work outside the window. */
              (w.trips IS NULL OR w.trips = 0) AND coalesce(ev.lifetime, 0) > 0
                AS identity_from_history,
              ev.last_ever, coalesce(ev.lifetime, 0) AS lifetime_trips,
              dc.state, dc.licence_expires, dc.rating,
              /* The portal's own photo, so every list that draws a person can
                 draw their face rather than two letters. It rides on the row
                 the compliance columns already come from. */
              dc.picture_url,
              (dc.licence_expires - now()::date) AS licence_days_left,
              ($5::text IS NOT NULL
               AND to_char(dc.licence_expires,'YYYY-MM-DD') = $5) AS licence_placeholder,
              /* Which platform said it. 241 of the people in this directory
                 have never driven — the panel exists for them — and every
                 column describing them was blank because the source platform
                 was dropped on the way out. A compliance record from Uber and
                 a standing from Bolt are different claims and the page could
                 not tell them apart, or say which one it was showing. */
              dc.platform AS compliance_platform,
              dps.state AS platform_state, dps.can_earn,
              dps.platform AS state_platform, dps.plate AS state_plate,
              /* The platform's own rating, which is what this column was always
                 meant to show. It read driver_compliance.rating — the hotel
                 channel's document register, which has never carried one — so
                 the column was empty on all 365 people and the sentence under
                 it blamed the channels. coalesce, not replace: if a channel
                 ever files one through compliance it still counts. */
              coalesce(dps.rating, dc.rating) AS platform_rating,
              dps.lifetime_trips AS platform_lifetime_trips,
              dps.is_banned, dps.compliance_status AS platform_compliance
       FROM who
       LEFT JOIN work w ON w.driver_ext_id = who.driver_ext_id
       LEFT JOIN pay ON pay.driver_ext_id = who.driver_ext_id
       LEFT JOIN dmoney dm ON dm.driver_ext_id = who.driver_ext_id
       LEFT JOIN ever ev ON ev.driver_ext_id = who.driver_ext_id
       LEFT JOIN driver_compliance dc ON dc.driver_ext_id = who.driver_ext_id
       LEFT JOIN driver_platform_state dps ON dps.driver_ext_id = who.driver_ext_id
       ORDER BY coalesce(w.trips, 0) DESC, who.driver_name LIMIT 800`, [...P, placeholderDate]);

    /* Fold per-platform rows into one row per person, so the directory lists
       humans rather than accounts. Counts are carried through and the ratios
       are computed ONCE at the end — folding a pre-computed percentage keeps
       one account's number and calls it the person's. */
    /* Keyed on the STORED fold where the window has one.
       ─────────────────────────────────────────────────────────────────────
       This folded on canonName(who.driver_name), and who.driver_name is a max
       over four sources — the window's trips, the whole trip history, a
       compliance record and a platform standing. So the directory could be
       folding on a spelling from March while every other page in the product
       folds on the one from this window, and the two then answer "how many
       people drove" differently: 118 here against 119 on the overview, live,
       for the same fleet on the same days. Neither number was wrong and
       nothing on either page could explain the other.

       person_key is that same fold, generated and stored on the trip row
       (sql/schema_v20.sql), and it is what /api/kpis, the ranking and the
       vehicle pages count. Using it here makes the directory's headcount the
       overview's headcount by construction rather than by coincidence.

       canonName stays as the fallback for the people the window has no work
       for — a name on the books and nothing else — where there is no stored
       key to prefer. It is the same rule; test/consistency.test.mjs runs both
       over the same names and requires the same answer. */
    const byName = new Map();
    for (const r of rows) {
      /* The register first, then the stored fold, then the name.
         ─────────────────────────────────────────────────────────────────
         The stored key already carries the three verified merges, so for a
         person the window measured this changes nothing. It is the OTHER
         rows this is for: a record with no work in the window has no
         w.person_key, falls through to the name — and two of the three merged
         records are exactly that (a Bolt standing with no trips, and a hotel
         record outside most windows), so without this the directory would
         still list them as separate people while every aggregate in the
         product counted them as one. */
      const k = ALIAS_KEY.get(r.driver_ext_id) || r.person_key || canonName(r.driver_name);
      const cur = byName.get(k);
      if (!cur) {
        byName.set(k, { ...r, ids: [r.driver_ext_id], platforms: [...(r.platforms || [])],
          /* An unknown window on the SEEDING row counts the same as on any
             other: money_period_days is null both when nothing reported money
             and when what reported it could not say over what period, and only
             the second makes the person's total unstatable. */
          _grainUnknown: r.money != null && r.money_period_days == null,
          _ratingTrips: r.platform_rating != null ? (r.platform_lifetime_trips || 0) : -1,
          _days: new Set() });
        continue;
      }
      cur.ids.push(r.driver_ext_id);
      cur.trips += r.trips;
      cur.completed += r.completed; cur.bookable += r.bookable;
      cur.priced_trips += r.priced_trips;
      cur.lifetime_trips += r.lifetime_trips;
      cur.km = +(cur.km || 0) + +(r.km || 0);
      cur.revenue = +(cur.revenue || 0) + +(r.revenue || 0);
      /* Payouts DO sum across a person's accounts: two provider ids are two
         separate statements for the same human, and both reached the fleet. */
      if (r.payout != null) cur.payout = +(cur.payout || 0) + +r.payout;
      cur.payout_days = Math.max(cur.payout_days || 0, r.payout_days || 0);
      /* Summed across the person's accounts, like the payout beside it — the
         money is on one account per person-day by construction, so this adds
         rather than doubles. The GRAIN takes the coarsest of the accounts, and
         an account that cannot state its window makes the person's total
         unstated too: a figure that is partly a measurement and partly a share
         of a week is not a measurement. */
      if (r.money != null) cur.money = +(cur.money || 0) + +r.money;
      cur.money_days = (cur.money_days || 0) + (r.money_days || 0);
      if (r.money_period_days == null && r.money != null) cur._grainUnknown = true;
      else if (r.money_period_days != null) {
        cur.money_period_days = Math.max(cur.money_period_days || 0, r.money_period_days);
      }
      if (r.money_source && r.money_source !== cur.money_source) {
        cur.money_source = cur.money_source ? 'mixed' : r.money_source;
      }
      /* The platform's own opinion of the person, folded across their
         accounts. NOT averaged: two platforms rating the same human are two
         opinions on two scales and a mean of them is a number neither provider
         would recognise. The best-attested one wins — most lifetime trips
         behind it — and a ban on any account bans the person, because a
         constraint that holds anywhere holds. */
      if (r.platform_rating != null
          && (cur.platform_rating == null
              || (r.platform_lifetime_trips || 0) > (cur._ratingTrips || 0))) {
        cur.platform_rating = r.platform_rating;
        cur._ratingTrips = r.platform_lifetime_trips || 0;
      }
      if (r.platform_lifetime_trips != null) {
        cur.platform_lifetime_trips = Math.max(cur.platform_lifetime_trips || 0, r.platform_lifetime_trips);
      }
      if (r.is_banned === true) cur.is_banned = true;
      cur.platform_compliance = cur.platform_compliance || r.platform_compliance;
      cur.platforms = [...new Set([...cur.platforms, ...(r.platforms || [])])];
      if ((r.driver_name || '').length > (cur.driver_name || '').length) cur.driver_name = r.driver_name;
      if (r.last_trip > cur.last_trip) cur.last_trip = r.last_trip;
      if (r.first_trip && (!cur.first_trip || r.first_trip < cur.first_trip)) cur.first_trip = r.first_trip;
      if (r.last_ever > cur.last_ever) cur.last_ever = r.last_ever;
      cur.state = cur.state || r.state;
      cur.platform_state = cur.platform_state || r.platform_state;
      cur.compliance_platform = cur.compliance_platform || r.compliance_platform;
      cur.state_platform = cur.state_platform || r.state_platform;
      cur.state_plate = cur.state_plate || r.state_plate;
      if (cur.can_earn == null) cur.can_earn = r.can_earn;
      if (r.licence_days_left != null && (cur.licence_days_left == null || r.licence_days_left < cur.licence_days_left)) {
        cur.licence_days_left = r.licence_days_left; cur.licence_expires = r.licence_expires;
        cur.licence_placeholder = r.licence_placeholder;
      }
      cur._multiAccountDays = true;
    }

    /* Distinct working days across ALL of a person's accounts. Taking the max
       of pre-aggregated per-account counts discarded every day worked on one
       platform and not another. Only asked for the people who actually have
       more than one account. */
    const multi = [...byName.values()].filter((p) => p.ids.length > 1);
    if (multi.length) {
      const dayRows = await q(
        `SELECT ${PKEY} AS driver_ext_id, local_day FROM trip_norm
         WHERE local_day BETWEEN $1::date AND $2::date
           AND ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR fleet_id = $4)
           AND ${PKEY} = ANY($5)`,
        [from, to, platform, fleet, multi.flatMap((x) => x.ids)]);
      const idToPerson = new Map();
      multi.forEach((p) => p.ids.forEach((id) => idToPerson.set(id, p)));
      const days = new Map();
      for (const d of dayRows) {
        const person = idToPerson.get(d.driver_ext_id);
        if (!person) continue;
        const set = days.get(person) || new Set();
        /* isoDay, not String(d.local_day).slice(0, 10).
           ───────────────────────────────────────────────────────────────
           local_day is a bare DATE — sql/schema_v18.sql:67 builds it as
           `(requested_at AT TIME ZONE 'Asia/Dubai')::date` and the SELECT
           above does not wrap it in to_char — so node-postgres parses it into
           a JS Date, and those ten characters are "Fri Aug 14": the head of a
           Date toString, with the YEAR cut off. That exact string was measured
           coming out of this very column on /api/day, and the identical
           mistake shipped to production in src/sources/ledger.js and printed
           "covering days up to Fri Aug 21" on the Data-sources page.

           Nothing but the Set's SIZE escapes here — it becomes `days` on a
           /api/drivers/directory row — so the figure was right while the key
           was wrong, and right by luck rather than by construction: dropping
           the year leaves (weekday, month, day), which stays injective only
           while the window is short. Production on 2026-09-02 returned 395
           rows, 52 of them multi-account, whose `days` read 28/29/30 inside a
           30-day window — the correct counts, for the wrong reason. But
           api/window.js accepts days up to 3660 and from/to are unclamped, so
           "Tue Oct 01" is both 2019-10-01 and 2024-10-01 in a window a caller
           can ask for TODAY, and a person who drove one of those days on Uber
           and the other on Yango silently loses a day worked. Same trap and
           same containment as api/economics_routes.js:920, which is where the
           702-days-0-collisions count comes from. */
        set.add(isoDay(d.local_day));
        days.set(person, set);
      }
      days.forEach((set, person) => { person.days = set.size; });
    }

    res.json([...byName.values()].map((p) => {
      /* One unstatable account makes the person's grain unstatable. Resolved
         here rather than in the fold so the flag cannot survive into the
         payload as a private field somebody starts reading. */
      if (p._grainUnknown) p.money_period_days = null;
      delete p._days; delete p._multiAccountDays; delete p._grainUnknown; delete p._ratingTrips;
      return {
        ...p,
        // Computed once, over the whole person.
        completion_pct: p.bookable ? Math.round((p.completed / p.bookable) * 100) : null,
        // "No trip in this window" and "never driven" are different facts.
        active_in_window: p.trips > 0,
        ever_driven: (p.lifetime_trips || 0) > 0,
        /* Not expired — never entered. Reported per row so a page cannot count
           a data-quality artefact as 77 people who must stand down. */
        licence_placeholder: !!p.licence_placeholder,
      };
    }).sort((a, b) => b.trips - a.trips || String(a.driver_name).localeCompare(String(b.driver_name))));
  }));

  /* ── who this is: identity, credentials, platforms, tenure ─────────── */
  app.get('/api/driver/profile', withDriver(async (req, res, d, p) => {
    const [span] = await q(
      `SELECT min(requested_at) first_trip, max(requested_at) last_trip, count(*)::int trips,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)::int days_worked,
              count(DISTINCT plate)::int vehicles, min(fleet_id) fleet_id
       FROM trip WHERE ${TW}`, p);
    /* The identity documents leave this route the same way they leave
       /api/compliance/drivers, through the same helper.
       ─────────────────────────────────────────────────────────────────────
       That route stopped serving emirates_id and licence_no to an anonymous
       caller; this one did not, and it is the more exposed of the two — the
       roster hands out a list, this hands out ONE NAMED PERSON'S papers, which
       is the shape somebody actually wants. Measured on production 2026-09-05
       with curl and no credentials:
       /api/driver/profile?id=67483c64055e070d791000fa returned
       {emirates_id: '784-1977-5137316-4', licence_no: '123456'}.

       The columns are still SELECTed, because an administrator presenting
       x-admin-token gets them, and because the counts and the expiry dates
       below are derived from the same rows. What changes is what leaves. */
    const complianceRows = await q(
      `SELECT platform, driver_ext_id, full_name, phone, email, picture_url,
              emirates_id, licence_no, licence_expires,
              (licence_expires - now()::date) AS licence_days_left, state, suspension_reason,
              rating, device_brand, device_model, updated_at
       FROM driver_compliance WHERE driver_ext_id = ANY($1)`, [d.keys]);
    const admin = isAdmin(req);
    const compliance = stripIdentity(complianceRows, admin);
    /* Which of them this person actually HAS, counted before the values were
       dropped. Without this the page cannot tell "withheld" from "the hotel
       channel never filed one", and those are the two states the whole
       #compliance page exists to keep apart. */
    const identityHeld = admin ? null : IDENTITY_DOCS.filter(
      (c) => complianceRows.some((r) => String(r[c] ?? '').trim() !== ''));
    const vehicles = await q(
      `SELECT plate, count(*)::int days, sum(trips)::int trips, round(sum(km)::numeric,0) km,
              round(sum(revenue)::numeric,0) revenue, min(day) first_day, max(day) last_day,
              bool_or(is_primary) ever_primary
       FROM vehicle_driver_day WHERE driver_ext_id = ANY($1)
       GROUP BY plate ORDER BY days DESC LIMIT 40`, [d.keys]);
    const accounts = await q(
      `SELECT platform, ${PKEY} AS driver_ext_id, count(*)::int trips,
              min(requested_at) first_trip, max(requested_at) last_trip
       FROM trip WHERE ${PKEY} = ANY($1) GROUP BY 1,2 ORDER BY trips DESC`, [d.keys]);
    /* What each platform says about this person's standing.
       ─────────────────────────────────────────────────────────────────────
       This route never touched driver_platform_state, so a suspended driver's
       own page could not show that they were suspended, why, their Bolt score,
       or the plate they are still holding — all of which #roster/blocked shows
       about the same person. Two pages in one product, one of them saying
       nothing about the fact the other exists to report. */
    const standing = await q(
      `SELECT platform, fleet_id, state, state_raw, state_reason, plate, vehicle_ext_id,
              score, can_earn, observed_at,
              /* What the PLATFORM says about the person, as opposed to about
                 their work. Uber answers all four on GetDriver and nothing
                 here asked until sql/schema_v45.sql; the roster has shown a
                 column of dashes under a sentence saying no channel reports a
                 rating, which was a fact about our questions and not about the
                 channels. profile_at is separate from observed_at because the
                 roster is read every half hour and this once a day. */
              rating, lifetime_trips, is_banned, compliance_status, profile_at
       FROM driver_platform_state WHERE driver_ext_id = ANY($1)
       ORDER BY platform`, [d.keys]);
    /* One person, several platform rows. The rating is the platform's, so it
       is NOT averaged across them — two platforms rating the same human are
       two opinions on two scales, and a mean of them is a number neither
       provider would recognise. The best-attested one leads and the rest are
       in `standing` for a reader who wants them. */
    const rated = standing.filter((r) => r.rating != null)
      .sort((a, b) => (b.lifetime_trips || 0) - (a.lifetime_trips || 0));
    const banned = standing.filter((r) => r.is_banned === true);
    res.json({ ...d,
      span, compliance, standing, vehicles, accounts,
      /* Named, so the page captions the gap instead of implying the provider
         sent nothing. Empty for an administrator. */
      identity_withheld: admin ? [] : IDENTITY_DOCS,
      identity_held: identityHeld,
      identity_withheld_reason: admin ? null
        : withheldNote('licence numbers and Emirates IDs'),
      rating: rated[0]?.rating ?? null,
      rating_platform: rated[0]?.platform ?? null,
      rating_at: rated[0]?.profile_at ?? null,
      rating_platforms: rated.length,
      /* Uber's own lifetime count, which is a cross-check on ours rather than a
         replacement: theirs covers the whole relationship, ours covers what we
         collected. Shown side by side, never merged. */
      platform_lifetime_trips: rated[0]?.lifetime_trips
        ?? standing.find((r) => r.lifetime_trips != null)?.lifetime_trips ?? null,
      banned_on: banned.map((r) => r.platform),
      platform_compliance: standing.filter((r) => r.compliance_status)
        .map((r) => ({ platform: r.platform, status: r.compliance_status })),
    });
  }));

  /* ── headline numbers, plus the shift shape the mockup asks for ────── */
  app.get('/api/driver/kpis', withDriver(async (req, res, d, p) => {
    const [t] = await q(
      `SELECT count(*)::int trips,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)::int days_worked,
              /* has_distance and has_fare, the same two rules the rest of the
                 product applies and these two figures did not.
                 ─────────────────────────────────────────────────────────
                 sql/schema_v18.sql:83 excludes complimentary rides from
                 has_fare because counting a ride given away as revenue made
                 the fleet headline disagree with the settlement page by
                 AED 320 over one window, and :88 excludes odometer-derived
                 FMS distances outside a sane range. Both were being applied
                 at the fleet grain, in src/rollup.js when it wrote
                 driver_day, and on this endpoint's own priced_km — but not to
                 the km and revenue on the tiles, so a driver's page answered
                 a question differently from the page that links to it. */
              round(sum(distance_km) FILTER (WHERE has_distance)::numeric,0) km,
              round(avg(distance_km) FILTER (WHERE has_distance)::numeric,1) avg_km,
              -- avg() skips NULLs, so avg_km is over the trips that REPORT a
              -- distance and km/trips does not reproduce it. Returned so the
              -- tile can print the denominator it actually used.
              count(*) FILTER (WHERE has_distance)::int trips_with_distance,
              round(sum(price) FILTER (WHERE has_fare)::numeric,2) revenue,
              round(avg(price) FILTER (WHERE has_fare)::numeric,2) avg_fare,
              -- Normalised, because the four platforms do not share a status
              -- vocabulary: Bolt says 'finished' for a completed trip and
              -- 'client_did_not_show' / 'driver_did_not_respond' /
              -- 'driver_rejected' for three of its four failure modes, none of
              -- which match ILIKE '%cancel%'. FMS telematics rows hardcode
              -- 'completed' and cannot be cancelled at all, so they are dropped
              -- from both sides by the outcome IS NOT NULL denominator rather
              -- than inflating this person's success rate.
              round(100.0*count(*) FILTER (WHERE outcome='completed')
                    /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) completion_pct,
              round(100.0*count(*) FILTER (WHERE outcome='not_completed')
                    /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) cancel_pct,
              count(*) FILTER (WHERE outcome IS NOT NULL)::int outcome_n,
              /* The two numerators, beside the two rates they came from. The
                 rates shipped with only their denominator, so "90.5%" was a
                 figure the reader had to take on trust — while /api/kpis, six
                 inches away on another page, reports both. A rate nobody can
                 check against its own numerator is the same shape of claim
                 this product refuses to make about a verdict. */
              count(*) FILTER (WHERE outcome='completed')::int completed,
              count(*) FILTER (WHERE outcome='not_completed')::int not_completed,
              count(*) FILTER (WHERE is_booking)::int bookings,
              count(*) FILTER (WHERE has_fare)::int priced_trips,
              count(*) FILTER (WHERE has_distance)::int trips_with_distance,
              /* The distance of the PRICED trips. Revenue per km divided the
                 fares of the few trips that carry one by the distance of ALL of
                 them, which is a ratio between two different populations and
                 comes out an order of magnitude too low on any driver working
                 mostly Uber — whose trip export has no fare column at all. */
              round(sum(distance_km) FILTER (WHERE has_fare AND has_distance)::numeric,0) priced_km,
              -- and the revenue of exactly those trips, so per-km is a ratio
              -- between one population rather than two
              round(sum(price) FILTER (WHERE has_fare AND has_distance)::numeric,2) priced_measured_revenue,
              count(*) FILTER (WHERE has_fare AND has_distance)::int priced_measured_trips,
              round(avg(duration_s)::numeric/60,1) avg_minutes,
              count(DISTINCT plate)::int vehicles, count(DISTINCT platform)::int platforms
       FROM trip_norm WHERE ${TW}`, p);
    // "typical start" — the median hour of the first trip of each working day,
    // which is a far better description of a shift than the mean of all trips.
    const [shift] = await q(
      `WITH d AS (
         SELECT (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
                min(requested_at AT TIME ZONE 'Asia/Dubai') first_local,
                max(requested_at AT TIME ZONE 'Asia/Dubai') last_local
         FROM trip WHERE ${TW} GROUP BY 1)
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from first_local::time))/3600 median_start_h,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from last_local::time))/3600 median_end_h,
              round(avg(extract(epoch from (last_local-first_local))/3600)::numeric,1) avg_span_h,
              round(stddev_samp(extract(epoch from first_local::time)/3600)::numeric,2) start_consistency_h
       FROM d`, p);
    const [perf] = await q(
      /* No hours here any more, and that is the fix rather than an omission.
         ─────────────────────────────────────────────────────────────────────
         This selected sum(hours_online) from driver_payout_day, whose view
         divides a platform PERIOD's hours evenly across the days it covers
         (sql/schema_v23.sql:64). Yango is the only channel that files hours and
         it files seven-day windows, so every figure this produced was a week
         divided by seven and printed as if somebody had measured the day.

         What it printed: Khalil Aliyan, twelve trips and four hours of work in
         the whole of August, tile reading 428.8 hours online — 14.3 hours a
         day, every day, including the twenty-four days they did not drive. And
         Fahad Ali, 485.7 hours against the 255.7 the availability feed actually
         recorded for the same month on the same page.

         The hours now come from driver_day below, which is a measurement, and
         the weekly figures are still shown where their grain is visible: the
         periods table on the Earnings tab prints them against the real period
         bounds, which is the one place a week-long number can be read as one. */
      /* No rating here either, and for the same reason as the hours above it.
         This averaged driver_payout_day.rating — a column that traces back to
         driver_performance, which no collector has ever written a rating into.
         It produced a null on every driver, and being spread into the response
         it could shadow a real one. The rating now comes from the platform
         that actually publishes it, below. */
      `SELECT round(avg(acceptance_rate)::numeric,3) acceptance_rate,
              round(avg(cancellation_rate)::numeric,3) cancellation_rate,
              round(sum(earnings)::numeric,2) reported_earnings,
              round(sum(cash_earnings)::numeric,2) cash_earnings
       /* Day grain, and the window applied to the day. Summed over
          driver_performance this counted the same payout week two and three
          times — the provider is asked for overlapping report windows and the
          window is the row's key. See sql/schema_v23.sql.

          It also read period_start >= from AND period_end <= to, which is
          "periods wholly inside the window": a 30-day view of weekly payouts
          silently dropped the two weeks straddling its edges, so the driver's
          earnings jumped whenever the window moved past a Monday. */
       FROM driver_payout_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date`, p);
    /* Hours, from the two feeds that measure them, with the same per-day
       precedence /api/driver/daily uses — so the tile and the chart under it
       cannot disagree.
       ─────────────────────────────────────────────────────────────────────
       The platform's OWN daily figure first, where a channel files one.
       Otherwise driver_day.online_min: Uber's ONLINE spans, folded into Dubai
       days and stored.

       What is deliberately absent is driver_payout_day.hours_online, which
       this used to sum. That view divides a platform PERIOD's hours evenly
       across the days it covers (sql/schema_v23.sql:64), and the only channel
       filing hours files seven-day windows — so every figure it produced was a
       week divided by seven and printed as a measurement. On production it put
       428.8 hours against a driver with twelve trips and four hours of work,
       and 485.7 against a month the availability feed measured at 255.7, on
       this same page. The weekly figures are still shown where their grain is
       visible: the periods table on the Earnings tab prints them against the
       real period bounds.

       FULL OUTER JOIN, because a day can be known to either feed alone: a
       platform that reports hours for a day with no availability, and — far
       more common here — availability for a day no platform reported. */
    const [kept] = await q(
      `WITH ph AS (
         SELECT period_start AS day, sum(hours_online) hours_online,
                sum(hours_on_trip) hours_on_trip
           FROM driver_performance
          WHERE driver_ext_id = ANY($3) AND period_start = period_end
            AND period_start BETWEEN $1::date AND $2::date
          GROUP BY 1),
       av AS (
         SELECT day, sum(online_min) online_min, sum(on_job_min) on_job_min,
                sum(idle_online_min) idle_online_min
           FROM driver_day
          WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
          GROUP BY 1),
       d AS (
         SELECT CASE WHEN ph.hours_online IS NOT NULL THEN ph.hours_online
                     ELSE av.online_min / 60.0 END AS online_h,
                CASE WHEN ph.hours_online IS NOT NULL THEN ph.hours_on_trip
                     ELSE av.on_job_min / 60.0 END AS on_job_h,
                /* Always the stored one: idle-online is online minus on-job
                   measured against the same clock, and no platform here
                   publishes it at all. */
                av.idle_online_min / 60.0 AS idle_h,
                CASE WHEN ph.hours_online IS NOT NULL THEN 'platform'
                     WHEN av.online_min IS NOT NULL THEN 'availability' END AS basis
           FROM ph FULL OUTER JOIN av USING (day))
       /* Numerator and denominator over the SAME days.
          ────────────────────────────────────────────────────────────────
          on_job_h lands on every day that carries on-job minutes; online_h
          only on days that carry online minutes. Summed unfiltered and then
          divided, that is a ratio between two different day sets — and on
          production it read 437.4% for one driver: 2,112.5 on-job hours over
          483 online, across 36 days that had a basis and an unknown number
          that did not. A utilisation over 100% is not a busy driver, it is
          two questions answered as one.

          So the ratio's halves are both restricted to the days that carry a
          basis, and the unrestricted on-job total is returned beside them
          under its own name for the panels that legitimately want every day
          of work rather than every day of measurement. */
       SELECT round(sum(online_h)::numeric,1) online_h,
              round(sum(on_job_h) FILTER (WHERE basis IS NOT NULL)::numeric,1) on_job_h,
              round(sum(on_job_h)::numeric,1) on_job_h_all_days,
              count(*) FILTER (WHERE on_job_h IS NOT NULL)::int on_job_days_all,
              round(sum(idle_h) FILTER (WHERE basis IS NOT NULL)::numeric,1) idle_online_h,
              count(*) FILTER (WHERE basis IS NOT NULL)::int online_days,
              count(*) FILTER (WHERE basis = 'platform')::int platform_days,
              count(*) FILTER (WHERE basis = 'availability')::int availability_days
         FROM d`, p);
    /* What this person's work brought in, both channels, per platform.
       `revenue` above is the fares on their trips, and the Uber export has no
       fare column — so a driver working Uber and one hotel booking led with the
       price of the hotel booking. Their actual pay was already in this response
       as `reported_earnings` and the tile strip did not show it.

       Per platform, and the same rule the fleet and vehicle pages use
       (api/income_sql.js): a payout is what is left of a channel's own fares
       after its commission, so a channel reporting both contributes one. */
    const [fareByPlat, payByPlat] = await Promise.all([
      q(`SELECT platform, count(*)::int bookings,
                count(*) FILTER (WHERE has_fare)::int priced_bookings,
                /* The denominator fare coverage is taken over — see
                   platformFares in api/income_sql.js. A ride nobody took has
                   no fare and never will; counting it as missing coverage made
                   Bolt read 63.8% covered on a month it priced 99.7% of its
                   completed rides. */
                count(*) FILTER (WHERE ${COMPLETED_SQL()} OR has_fare)::int chargeable_bookings,
                count(*) FILTER (WHERE NOT (${COMPLETED_SQL()}) AND NOT has_fare)::int uncharged_bookings,
                round(sum(price) FILTER (WHERE has_fare)::numeric,2) fares
         FROM trip_norm WHERE ${TW} AND is_booking GROUP BY 1`, p),
      q(`SELECT platform, round(sum(earnings)::numeric,2) payouts,
                count(DISTINCT day)::int payout_days
         FROM driver_payout_day
         WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
         GROUP BY 1`, p),
    ]);
    const byPlat = new Map();
    const plat = (name) => {
      if (!byPlat.has(name)) {
        byPlat.set(name, { platform: name, bookings: 0, booking_days: 0, priced_bookings: 0,
          fares: null, payouts: null, payout_days: 0 });
      }
      return byPlat.get(name);
    };
    const n = (v) => (v == null ? null : Number(v));
    for (const f of fareByPlat) Object.assign(plat(f.platform), {
      bookings: f.bookings, priced_bookings: f.priced_bookings, fares: n(f.fares),
      chargeable_bookings: f.chargeable_bookings, uncharged_bookings: f.uncharged_bookings });
    for (const y of payByPlat) Object.assign(plat(y.platform), {
      payouts: n(y.payouts), payout_days: y.payout_days ?? 0 });
    const windowDays = Math.round((Date.parse(p[1]) - Date.parse(p[0])) / 86400000) + 1;

    /* What the platforms say about the PERSON, not about the window.
       ─────────────────────────────────────────────────────────────────────
       Both tile strips on the driver page read k.rating, and it has always
       been null: it came from avg(driver_performance.rating), a column no
       collector writes. Uber answers a rating on GetDriver and now lands it on
       driver_platform_state (sql/schema_v45.sql), so the tiles read it here
       rather than each page fetching a second endpoint.

       Window-independent on purpose. A rating is the platform's standing view
       of a human; slicing it by the dates on the toolbar would imply it was
       measured over them. */
    /* Bound on $1 with the keys alone, not on the shared p triple. Postgres
       infers a parameter's type from where it is USED, and a query that binds
       three but references only the third answers "could not determine data
       type of parameter $1" — which is what every driver endpoint returned for
       a few minutes here. The window is deliberately absent: a rating is the
       platform's standing view of a human, and slicing it by the dates on the
       toolbar would imply it was measured over them. */
    const standing = await q(
      `SELECT platform, rating, lifetime_trips, is_banned, compliance_status, profile_at
       FROM driver_platform_state
       WHERE driver_ext_id = ANY($1) AND (rating IS NOT NULL OR is_banned IS NOT NULL
             OR lifetime_trips IS NOT NULL OR compliance_status IS NOT NULL)
       ORDER BY lifetime_trips DESC NULLS LAST`, [p[2]]);
    const rated = standing.filter((r) => r.rating != null);
    /* Is it going up? — which is the question a rating is actually asked.
       ─────────────────────────────────────────────────────────────────────
       Two readings, the newest and the one before it, from the kept history
       (sql/schema_v46.sql). Deliberately NOT a fixed "last week": the pull is
       weekly but a missed week must not be reported as a week of no change, so
       the comparison is against the previous READING and the gap in days is
       returned with it. A driver read once has no change — `first reading`,
       not zero, because zero is a measurement and this is an absence.

       lifetime_trips comes too, because it is the denominator: 0.02 over 40
       trips and 0.02 over 900 are different events and only the second is
       signal. */
    const [trend] = await q(
      `WITH h AS (
         SELECT platform, rating, lifetime_trips, observed_on,
                row_number() OVER (PARTITION BY platform ORDER BY observed_on DESC) AS rn
           FROM driver_rating_history
          WHERE driver_ext_id = ANY($1) AND rating IS NOT NULL)
       SELECT max(rating) FILTER (WHERE rn = 1)         AS latest,
              max(rating) FILTER (WHERE rn = 2)         AS previous,
              max(observed_on) FILTER (WHERE rn = 1)    AS latest_on,
              max(observed_on) FILTER (WHERE rn = 2)    AS previous_on,
              max(lifetime_trips) FILTER (WHERE rn = 1) AS latest_trips,
              max(lifetime_trips) FILTER (WHERE rn = 2) AS previous_trips,
              count(*)::int                             AS readings
         FROM h`, [p[2]]);
    /* The readings themselves, newest last, for a sparkline. Capped at twelve
       — a quarter of weekly pulls — because a rating line longer than the eye
       can read in a 90-pixel tile is decoration, and because the question the
       tile answers is "which way lately", not "the whole history". */
    const series = await q(
      `SELECT to_char(observed_on, 'YYYY-MM-DD') AS on, max(rating) AS rating,
              max(lifetime_trips) AS trips
         FROM driver_rating_history
        WHERE driver_ext_id = ANY($1) AND rating IS NOT NULL
        GROUP BY observed_on ORDER BY observed_on DESC LIMIT 12`, [p[2]]);
    series.reverse();
    const chg = (trend?.latest != null && trend?.previous != null)
      ? { change: +(Number(trend.latest) - Number(trend.previous)).toFixed(3),
        over_days: Math.round(
          (Date.parse(trend.latest_on) - Date.parse(trend.previous_on)) / 86400000) || null,
        over_trips: (trend.latest_trips != null && trend.previous_trips != null)
          ? trend.latest_trips - trend.previous_trips : null,
        from: Number(trend.previous), to: Number(trend.latest) }
      : null;
    /* WHAT THE PLATFORM SAYS THE FARES WERE.
       ─────────────────────────────────────────────────────────────────────
       Uber's trip export carries no fare column, so `revenue` above — which is
       sum(trip.price) over has_fare — is null for every Uber-only driver. The
       Fares tile on the overview and the Booked revenue tile under Earnings
       therefore both read a dash for people who billed six figures, and the
       page said "where the platform reports fares" as though the platform
       reported none.

       It reports them. Not per trip, but as the `fare` line of the weekly
       statement's earnings breakdown — driver_earnings_component, which this
       same page already draws three panels further down. AED 866,137 over one
       year across the fourteen drivers sampled on production; the tiles above
       it read "—".

       Read here so the tiles can say it, and returned UNDER ITS OWN NAME
       rather than folded into accounted_fares. That fold would be a double
       count: `fare` is the gross the rider was charged and it is the PARENT of
       the payout money in the same tree — your_earnings is fare minus the
       service fee — so the payout already beside it on the tile contains it.
       fleetIncome() therefore never sees this figure.

       Only the top of the tree is summed. little_fare, surge, wait_time,
       cancellation and the rest all carry parent 'fare' and are its
       components; adding them would double the total. 'net_fare' is the same
       line under the other platforms' vocabulary, a direct child of their
       'earnings' root, and no child is named either thing. */
    const [sfare] = await q(
      `SELECT round(sum(amount)::numeric, 2)                       AS statement_fares,
              count(DISTINCT (period_start, period_end))::int      AS statement_fare_periods,
              min(period_start)                                    AS statement_fare_from,
              max(period_end)                                      AS statement_fare_to,
              array_agg(DISTINCT category)                         AS statement_fare_lines
         FROM driver_earnings_component
        WHERE driver_ext_id = ANY($3)
          AND category IN ('fare', 'net_fare')
          AND period_start >= $1::date AND period_end <= $2::date`, p);

    const num = (v) => (v == null ? null : Number(v));
    const hoursOnline = num(kept?.online_h);
    const hoursOnJob = num(kept?.on_job_h);
    /* Both operands checked, and that is not pedantry.
       ─────────────────────────────────────────────────────────────────────
       This read `perf?.hours_online ? (perf.hours_on_trip / perf.hours_online)`
       and hours_on_trip is null for every driver on this fleet, because nothing
       writes it. In JavaScript null/428.8 is 0 — not NaN, not null — so the
       guard passed on the denominator and the tile printed a confident 0%, in
       the critical tone, for the seven drivers who had a denominator at all.
       An invented figure accusing a named person of never carrying a passenger.

       A ratio needs both halves measured, from the same record, over the same
       days. Where either is missing the answer is that we do not know. */
    const utilisation = hoursOnline && hoursOnJob != null
      ? +((hoursOnJob / hoursOnline) * 100).toFixed(1) : null;
    res.json({ ...t, ...shift, ...perf, ...fleetIncome([...byPlat.values()], windowDays),
      hours_online: hoursOnline,
      /* on_job, not on_trip: request to dropoff, which contains the approach
         and the rider's wait. No feed here separates them. */
      hours_on_job: hoursOnJob,
      /* Every day of work, not only the days a basis measured — the panels
         that ask "how long was this person on jobs" want all of them, and the
         utilisation ratio above deliberately does not. Returned separately so
         the two can never be summed into one another again. */
      hours_on_job_all_days: num(kept?.on_job_h_all_days),
      hours_on_job_days: kept?.on_job_days_all ?? null,
      hours_idle_online: num(kept?.idle_online_h),
      /* Which feed answered, and mixed where the window contains both — a
         platform's on-trip figure and our request-to-dropoff fold are not the
         same measure, and a total drawn from both should say so. */
      hours_basis: hoursOnline == null ? null
        : (kept.platform_days && kept.availability_days) ? 'mixed'
          : kept.platform_days ? 'platform' : 'availability',
      hours_days: kept?.online_days ?? 0,
      trips_per_day: t.days_worked ? +(t.trips / t.days_worked).toFixed(1) : null,
      utilisation_pct: utilisation,
      /* After the ...perf spread, deliberately: perf carries a rating column
         from driver_performance that nothing writes, and letting it win would
         put the null back over a real number. */
      rating: rated[0]?.rating ?? null,
      rating_platform: rated[0]?.platform ?? null,
      rating_at: rated[0]?.profile_at ?? null,
      /* null when there is only one reading — "first reading", never a change
         of zero. A zero is a measurement; this is the absence of a second
         observation to measure against. */
      rating_change: chg,
      rating_readings: trend?.readings ?? 0,
      rating_series: series.map((r) => ({ on: r.on, rating: Number(r.rating),
        trips: r.trips == null ? null : Number(r.trips) })),
      /* Beside accounted_fares, never inside it — see the query above. */
      statement_fares: num(sfare?.statement_fares),
      statement_fare_periods: sfare?.statement_fare_periods || 0,
      statement_fare_from: sfare?.statement_fare_from ?? null,
      statement_fare_to: sfare?.statement_fare_to ?? null,
      platform_lifetime_trips: standing.find((r) => r.lifetime_trips != null)?.lifetime_trips ?? null,
      banned_on: standing.filter((r) => r.is_banned === true).map((r) => r.platform),
      platform_compliance: standing.filter((r) => r.compliance_status)
        .map((r) => ({ platform: r.platform, status: r.compliance_status })) });
  }));

  /* ── day by day: the spine every chart on the detail page hangs off ── */
  app.get('/api/driver/daily', withDriver(async (req, res, d, p) => res.json(await q(
    `WITH t AS (
       SELECT (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
              count(*)::int trips,
              count(*) FILTER (WHERE outcome='completed')::int completed,
              count(*) FILTER (WHERE outcome='not_completed')::int cancelled,
              count(*) FILTER (WHERE outcome IS NOT NULL)::int outcome_n,
              -- The same two rules as the tiles above and as driver_day: a
              -- complimentary ride is not revenue, and an odometer-derived
              -- distance outside a sane range is not a distance.
              round(sum(distance_km) FILTER (WHERE has_distance)::numeric,1) km,
              round(sum(price) FILTER (WHERE has_fare)::numeric,2) revenue,
              min(requested_at) first_trip_at, max(requested_at) last_trip_at,
              extract(epoch from (min(requested_at AT TIME ZONE 'Asia/Dubai')::time))/3600 first_hour,
              extract(epoch from (max(requested_at AT TIME ZONE 'Asia/Dubai')::time))/3600 last_hour,
              round((extract(epoch from (max(requested_at)-min(requested_at)))/3600)::numeric,2) span_h,
              string_agg(DISTINCT plate, ',') plates,
              string_agg(DISTINCT platform, ',') platforms
       FROM trip_norm WHERE ${TW} GROUP BY 1),
     h AS (
       SELECT period_start AS day, sum(hours_online) hours_online, sum(hours_on_trip) hours_on_trip,
              sum(earnings) earnings
       FROM driver_performance
       WHERE driver_ext_id = ANY($3) AND period_start = period_end
         AND period_start BETWEEN $1::date AND $2::date
       GROUP BY 1),
     /* The kept per-day record, and the reason this panel was blank.
        ─────────────────────────────────────────────────────────────────────
        h above is the platform's OWN daily figure, and it fires for nobody.
        driver_performance.hours_online has exactly one writer in this codebase
        — src/sources/yango.js:86 — and it files SEVEN-DAY windows, which the
        period_start = period_end predicate directly above then discards.
        hours_on_trip has no writer at all. So the panel rendered "No
        platform-reported hours in this window" directly beneath a shift
        timeline reading 405 h online, and beside a stored per-day record
        holding the same 405 h. The fact was collected, derived and kept; only
        this query did not ask for it. h is left in place because a channel
        that starts filing daily rows should still win — it is the provider's
        own arithmetic rather than ours — but it answers nothing today.

        driver_day is the record: ONLINE spans from driver_timeline_event (the
        availability feed), clamped to Dubai days by src/rollup.js and stored.
        Two things it is NOT:

          it is not driver_payout_day.hours_online, which divides a Yango WEEK
          by seven (sql/schema_v23.sql:64). That column is why the KPI tile on
          this same page reported 428.8 hours for a driver with four hours of
          work — a weekly total stated as a daily measurement. It is read
          nowhere on this page now.

          and on_job_min is not "on trip". Uber's export carries a request time
          and a dropoff time and nothing between them, so this span contains
          the approach and the rider's wait as well as the ride. It is emitted
          as hours_on_job and labelled request-to-dropoff wherever it is drawn;
          calling it time with a passenger would be a claim no feed supports. */
     k AS (
       SELECT day, sum(online_min) online_min, sum(on_job_min) on_job_min,
              sum(idle_online_min) idle_online_min,
              round(sum(money)::numeric, 2) money,
              /* The report window the money was measured over. Uber files this
                 fleet's earnings WEEKLY and src/rollup.js divides each one
                 across its seven days, so seven consecutive days carry a
                 seventh of one number each — identical values, and none of
                 them a measurement of its own day. Production made the point
                 the moment this column shipped: 309.88 for seven days running,
                 then 446.84 for the next seven. The figure is right at the
                 week and allocated at the day, and the page has to be able to
                 say which. See sql/schema_v44.sql. */
              max(money_period_days) money_period_days,
              /* mixed the moment a person's day was reached two ways — one
                 platform filing a statement, another reporting only fares. */
              CASE WHEN count(DISTINCT money_source) FILTER (WHERE money_source <> 'none') > 1
                   THEN 'mixed' ELSE max(money_source) FILTER (WHERE money_source <> 'none') END money_source
       FROM driver_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
       GROUP BY 1),
     /* The spine is every day ANY feed knows about, not only the days with
        trips.
        ─────────────────────────────────────────────────────────────────────
        This selected FROM t — the trip aggregate — so a day the driver was
        online for and never dispatched had no row at all, and neither did a
        day a statement paid them for that the trip feed missed. Those are two
        of the most informative days a driver has: one is availability that
        earned nothing, which is the question the panel above this table exists
        to answer, and the other is money arriving for work we cannot see.

        It also made the page disagree with itself. The KPI tile sums the
        stored record and the chart sums this endpoint, so a driver with an
        online day and no jobs had a tile reading 28 hours over a chart drawing
        24 — the same shape of contradiction as the window bug, from the other
        direction.

        A day arriving only through k lands with trips 0 and null hours of
        work, which is exactly what it was. */
     spine AS (
       SELECT day FROM t UNION SELECT day FROM k UNION SELECT day FROM h)
     SELECT to_char(spine.day, 'YYYY-MM-DD') AS day,
            coalesce(t.trips, 0) AS trips,
            coalesce(t.completed, 0) AS completed,
            coalesce(t.cancelled, 0) AS cancelled,
            coalesce(t.outcome_n, 0) AS outcome_n,
            t.km, t.revenue, t.first_trip_at, t.last_trip_at,
            t.first_hour, t.last_hour, t.span_h, t.plates, t.platforms,
            CASE WHEN h.hours_online IS NOT NULL THEN round(h.hours_online::numeric,2)
                 ELSE round(k.online_min::numeric/60,2) END AS hours_online,
            /* NULL, never 0, where availability was never collected: Uber is
               the only channel here that publishes it, so the hotel and Yango
               drivers have none — and zeroing them would report people who
               worked all month as never having logged in. */
            CASE WHEN h.hours_online IS NOT NULL THEN 'platform'
                 WHEN k.online_min IS NOT NULL THEN 'availability' END AS hours_online_basis,
            round(k.on_job_min::numeric/60,2) AS hours_on_job,
            round(k.idle_online_min::numeric/60,2) AS hours_idle_online,
            /* What the day was worth, from whichever feed measured it: the
               statement's net where a platform filed one, its fares where it
               did not, per platform and then summed (src/rollup.js:823).
               revenue beside it is fares only, which is null on every
               Uber-only day — 85 of this fleet's 119 active drivers. */
            round(k.money::numeric,2) AS money, k.money_source,
            k.money_period_days,
            round(h.earnings::numeric,2) platform_earnings,
            w.temp_max, w.precipitation, c.is_ramadan
     FROM spine LEFT JOIN t USING (day)
                LEFT JOIN h USING (day)
                LEFT JOIN k USING (day)
                LEFT JOIN weather_daily w ON w.day = spine.day
                LEFT JOIN calendar_day c ON c.day = spine.day
     ORDER BY spine.day`, p))));

  /* ── the day as it was actually spent ──────────────────────────────────
     The shift panel drew one solid bar per day, first trip to last trip, and
     called it "the working window". It is not a working window: a driver with
     eight trips between 05:19 and 23:10 was drawn identically to a driver who
     did eight back-to-back and went home, because a span says nothing about
     what happened inside it. On six drivers measured live for 25 August, the
     span was between 51% and 92% WAITING.

     So this returns the day's jobs at their real positions, and the page draws
     the gaps between them. Minutes since Dubai midnight, because that is the
     axis the bar is drawn on and converting in the browser puts the viewer's
     clock back into a chart whose whole subject is Dubai time.

     THREE THINGS IT REFUSES TO GUESS.

     1. A JOB WITH NO DROPOFF IS NOT A JOB OF LENGTH ZERO. Uber reports a
        dropoff time on most trips and none on the rest. Those come back with
        e = null and are drawn as an unknown, never folded into waiting —
        which would silently convert missing data into idleness.

     2. A JOB THAT RUNS PAST MIDNIGHT IS CLAMPED, AND SAYS SO. Minute-of-day
        wraps, so a dropoff at 00:20 the next morning is minute 20, which is
        BEFORE its own request. It is clamped to the end of the day and
        flagged, rather than drawn backwards.

     3. TIME CARRYING SOMEONE IS NOT SEPARABLE FROM TIME DRIVING TO THEM, and
        this was checked against the raw payloads rather than assumed. Uber's
        trip export carries fifteen fields and exactly two timestamps — 'Trip
        request time' and 'Trip drop-off time' (86% filled). There is no
        pickup time and no duration. The hotel channel carries startTime and
        endTime and the same gap. FMS is the only source with a 'Trip Duration'
        field, and FMS rows are telematics journeys rather than bookings, so
        they are excluded here by is_booking and cannot split anything.

        Request-to-dropoff is therefore ONE block containing the approach, the
        wait for the rider and the ride. It is labelled "on job" for exactly
        that reason, and the page says so rather than splitting it on an
        assumption about how long a Dubai pickup takes. */
  app.get('/api/driver/shift', withDriver(async (req, res, d, p) => {
    const MIN = (col) => `(extract(hour FROM ${col} AT TIME ZONE 'Asia/Dubai') * 60`
      + ` + extract(minute FROM ${col} AT TIME ZONE 'Asia/Dubai'))::int`;
    const rows = await q(
      `SELECT to_char((requested_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS day,
              ${MIN('requested_at')} AS s,
              CASE WHEN ended_at IS NULL THEN NULL ELSE ${MIN('ended_at')} END AS e,
              /* Did the dropoff land on a LATER Dubai day than the request?
                 Written as a comparison against the request's day + 1 rather
                 than as a second ::date cast, because a cast on ended_at is a
                 Dubai-day filter expression that no index serves — and
                 test/indexes.test.mjs is right to flag every one of them, even
                 the ones that are only ever selected. */
              (ended_at IS NOT NULL
               AND (ended_at AT TIME ZONE 'Asia/Dubai')
                 >= ((requested_at AT TIME ZONE 'Asia/Dubai')::date + 1)) AS past_midnight,
              platform, plate, outcome
         FROM trip_norm
        WHERE ${TW} AND is_booking
        ORDER BY 1, 2`, p);

    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.day)) byDay.set(r.day, []);
      byDay.get(r.day).push(r);
    }
    const out = [...byDay.entries()].map(([day, list]) => {
      const jobs = list.map((r) => {
        const s = r.s;
        /* Clamped, not wrapped — but only for the case that means what the
           clamp says.
           ─────────────────────────────────────────────────────────────────
           A dropoff after midnight is minute 20 of the NEXT day, which as a
           raw number sits before its own request; running it to 1440 is right.

           A dropoff before its own request on the SAME Dubai day is not that.
           It is a bad timestamp, and this line ran it to 1440 as well — a
           twenty-four hour job. On the operator's own driver, eleven such rows
           contributed 40.4 hours of the 125.8 this endpoint reported for
           August, against 87.7 in the stored record: a page telling somebody
           they were on job for five days straight. src/rollup.js:711 already
           makes the right call for the same rows — greatest(end, start), a
           job of zero known length — and the two are now the same rule, which
           is the only way the panel and the record it is drawn beside can
           agree. `over` still marks the row either way; a bad timestamp is
           worth seeing. */
        const e = r.e == null ? null : (r.past_midnight ? 1440 : Math.max(r.e, s));
        return { s, e, over: Boolean(r.past_midnight) || (r.e != null && r.e < s),
          platform: r.platform, plate: r.plate, outcome: r.outcome };
      });
      let onJob = 0, unknown = 0, overlaps = 0, wait = 0, longest = 0;
      let cursor = null;
      for (const j of jobs) {
        if (j.e == null) { unknown += 1; continue; }
        onJob += Math.max(0, j.e - j.s);
        if (cursor != null) {
          const gap = j.s - cursor;
          if (gap < 0) overlaps += 1;
          else { wait += gap; longest = Math.max(longest, gap); }
        }
        cursor = Math.max(cursor ?? j.e, j.e);
      }
      const known = jobs.filter((j) => j.e != null);
      const first = jobs.length ? Math.min(...jobs.map((j) => j.s)) : null;
      const last = known.length ? Math.max(...known.map((j) => j.e)) : first;
      return { day, jobs, bookings: jobs.length, on_job_min: onJob, wait_min: wait,
        longest_wait_min: longest, overlaps, unknown_end: unknown,
        first_min: first, last_min: last,
        span_min: first == null || last == null ? null : Math.max(0, last - first) };
    }).sort((x, y) => (x.day < y.day ? -1 : 1));

    /* ── was the gap ONLINE or OFF? ──────────────────────────────────────
       The waiting band is 81% of this panel and said nothing: a driver sitting
       at a rank with the app on and a driver who logged off and went home drew
       the same colour. One is supply the fleet is paying for and failing to
       sell; the other is somebody's evening.

       Spans are derived here rather than stored, because the collector records
       transitions (sql/schema_v37.sql) — a span is a pair of them, and storing
       pairs means deciding at write time what a dangling ONLINE means and
       re-deciding it when its OFFLINE arrives on the next run.

       Clamped to the Dubai day, and a span crossing midnight is emitted on
       both days it touches: an evening shift is one span in the data and two
       bars on the chart. */
    const online = await q(
      `WITH ev AS (
         /* PARTITIONED by account. A person can hold two Uber accounts
            (resolve() above returns the match set, not one id), and one
            ordering across both interleaves their transitions into spans that
            belong to neither — an ONLINE on account A closed by an OFFLINE on
            account B. */
         SELECT at, status,
                lead(at) OVER (PARTITION BY driver_ext_id ORDER BY at) AS next_at
           FROM driver_timeline_event
          WHERE driver_ext_id = ANY($3) AND kind = 'status' AND status <> ''
            /* Dubai day bounds, widened by a day at each end.
               ─────────────────────────────────────────────────────────────
               Two separate faults, one line. at >= $1::timestamptz bound
               the FIRST day at UTC midnight, which is 04:00 Dubai, so the
               window's opening four hours had no events and the day drew as
               offline. And a span is opened by one event and closed by the
               NEXT: an ONLINE at 23:40 on the day before the window is what
               makes the window's first morning online at all, and clipping
               the fetch to the window threw that event away along with the
               lead() that needed it.

               So the fetch reaches a day either side — exactly as
               /api/driver/day does below — and the days CTE clamps each span
               to the Dubai days it actually covers. Days outside the window
               fall out at the join, which reads only the days already drawn. */
            AND at >= (($1::date - 1)::timestamp AT TIME ZONE 'Asia/Dubai')
            AND at <  (($2::date + 2)::timestamp AT TIME ZONE 'Asia/Dubai')),
       /* span_start/span_end, not s/e. These are CTE values, and
          test/indexes.test.mjs reads every Dubai-day cast in api/ as a column
          that needs an index — rightly, since an unindexed one scans the
          table. A one-letter alias is indistinguishable from a real column to
          that check and to a reader; a named one says what it is and can be
          declared derived without the exemption swallowing some future column
          called s. */
       spans AS (
         SELECT status, at AS span_start, next_at AS span_end FROM ev
          WHERE next_at IS NOT NULL AND status = 'ONLINE'),
       days AS (
         SELECT generate_series((span_start AT TIME ZONE 'Asia/Dubai')::date,
                                (span_end AT TIME ZONE 'Asia/Dubai')::date,
                                interval '1 day')::date AS d, span_start, span_end
           FROM spans)
       SELECT to_char(d, 'YYYY-MM-DD') AS day,
              greatest(0, extract(epoch FROM (
                greatest(span_start AT TIME ZONE 'Asia/Dubai', d::timestamp)
                - d::timestamp))/60)::int AS s,
              least(1440, extract(epoch FROM (
                least(span_end AT TIME ZONE 'Asia/Dubai', d::timestamp + interval '1 day')
                - d::timestamp))/60)::int AS e
         FROM days
        ORDER BY 1, 2`, p);          // same $1..$3 order as TW, deliberately

    const onlineByDay = new Map();
    for (const r of online) {
      if (r.e <= r.s) continue;                 // a span that ends where it starts
      if (!onlineByDay.has(r.day)) onlineByDay.set(r.day, []);
      onlineByDay.get(r.day).push({ s: r.s, e: r.e });
    }
    /* Attached to the day rows the chart already draws, and only where the day
       HAS availability: a day with none must render as it always did rather
       than as a day the driver was offline for, which is a different claim and
       one the absence of data cannot support. */
    for (const day of out) day.online = onlineByDay.get(day.day) || null;
    /* Days the collector has covered at all, so the caption can say "no data
       yet" instead of the chart implying everyone was logged out. */
    const covered = out.filter((x) => x.online).length;

    res.json({
      days: out,
      /* Stated once, by the API, so every renderer says the same thing rather
         than each inventing its own caption. */
      basis: 'A job runs from the request to the dropoff, so it contains the drive to the '
        + 'rider and the wait for them as well as the ride itself. Uber\'s export carries two '
        + 'timestamps and no pickup time, and the hotel channel the same, so the ride cannot '
        + 'be separated from the approach on any booking channel.',
      /* Uber serves 31 days of availability and nothing older, so this fills in
         from the day the collector started and can never be backfilled past
         it. Said here rather than left for a reader to infer from a chart that
         is bare on the left. */
      online_basis: covered
        ? 'The lighter band is time the driver was ONLINE on Uber between jobs — available and '
          + 'not dispatched. Where a day has no band, availability was not collected for it: '
          + 'Uber serves only the last 31 days, so this fills in going forward.'
        : 'Uber availability has not been collected for this driver yet. It arrives on a '
          + 'three-hourly pull and covers at most the last 31 days.',
      online_days: covered,
      unknown_end: out.reduce((a, x) => a + x.unknown_end, 0),
    });
  }));

  /* ── the KEPT per-day record ──────────────────────────────────────────
     driver_day (sql/schema_v38.sql) rather than a fold over raw. The point of
     the table is that it answers ranges the providers no longer serve: Uber
     gives 31 days of availability and about 192 of earnings, and this row
     survives both. It is also the only place idle-online exists as a stored
     fact rather than as a subtraction done at read time.

     Summed across a person's ACCOUNTS. The table is keyed on one driver id and
     a person can hold several; resolve() returns the match set, and a day this
     person worked on two accounts is one day of theirs. */
  app.get('/api/driver/days', withDriver(async (req, res, d, p) => {
    const rows = await q(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day,
              min(fleet_id) AS fleet_id,
              sum(trips)::int AS trips,
              sum(completed)::int AS completed,
              sum(cancelled)::int AS cancelled,
              round(sum(km)::numeric, 1) AS km,
              round(sum(fares)::numeric, 2) AS fares,
              min(first_min)::int AS first_min,
              max(last_min)::int AS last_min,
              sum(on_job_min)::int AS on_job_min,
              sum(wait_min)::int AS wait_min,
              max(longest_wait_min)::int AS longest_wait_min,
              /* NULL where no account has availability for the day, which is
                 not the same as zero — sum() over all-NULL is NULL, which is
                 the behaviour wanted here and the reason this is not a
                 coalesce. */
              sum(online_min)::int AS online_min,
              sum(idle_online_min)::int AS idle_online_min,
              max(computed_at) AS computed_at
         FROM driver_day
        WHERE driver_ext_id = ANY($3)
          AND day BETWEEN $1::date AND $2::date
        GROUP BY day
        ORDER BY day`, p);
    const covered = rows.filter((r) => r.online_min != null);
    /* When this record was last written, which is the difference between two
       numbers disagreeing and one of them being older.
       ─────────────────────────────────────────────────────────────────────
       Swept across all 119 active drivers after the window fix, /api/driver/kpis
       and this endpoint agree on 115 of them exactly. The other four differ by
       one trip, all on TODAY, because the rollup runs after a collection and
       the trip feed has moved since. That is the table working as designed —
       and indistinguishable, on the page, from the arithmetic being wrong.
       A reader comparing 285 against 284 needs to know one of them is as of
       09:13. */
    /* `a == null ||` first, and it is not defensive noise: `'2026-…' > null`
       coerces the string to NaN and is false, so a reduce seeded with null
       over string timestamps returns null for ever. It happens to work here
       because pg hands back Date objects, and it silently did not in the mock
       beside it, which is the kind of difference that makes a fixture stop
       testing anything. */
    const computed = rows.reduce(
      (a, r) => (r.computed_at && (a == null || r.computed_at > a) ? r.computed_at : a), null);
    res.json({
      days: rows,
      computed_at: computed,
      basis: 'One row per day, written after every collection and kept. Uber serves 31 days of '
        + 'availability and about 192 of earnings; these rows outlive both.',
      online_days: covered.length,
      totals: {
        computed_at: computed,
        days: rows.length,
        trips: rows.reduce((a, r) => a + (+r.trips || 0), 0),
        on_job_min: rows.reduce((a, r) => a + (+r.on_job_min || 0), 0),
        wait_min: rows.reduce((a, r) => a + (+r.wait_min || 0), 0),
        online_min: covered.reduce((a, r) => a + (+r.online_min || 0), 0),
        idle_online_min: covered.reduce((a, r) => a + (+r.idle_online_min || 0), 0),
      },
    });
  }));

  /* ── one driver, one day, minute by minute ────────────────────────────
     "How the day was spent" answers the shape of a month. This answers a day:
     every job at its real time with where it went, and — the part that was
     missing — what happened in the GAPS. A driver page could say somebody
     waited 7h 36m and could not say whether they were online, where they sat,
     or whether they moved while they waited.

     Three feeds joined on one clock:
       trip                     the jobs, with addresses, tier and payment
       driver_timeline_event    ONLINE spans (sql/schema_v37.sql)
       telemetry_snapshot       where the car was during each gap

     The telematics side is keyed by PLATE, not by driver, so it is reached
     through the custody record for that day — which is also why a gap can come
     back with no position at all and must say so rather than drawing nothing. */
  app.get('/api/driver/day', withDriver(async (req, res, d) => {
    const day = String(req.query.day || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return res.status(400).json({ error: 'a day is addressed as YYYY-MM-DD' });
    }
    /* Dubai bounds for the calendar day, built once and reused by all three
       queries so they cannot disagree about where the day starts. */
    const p = [d.keys, day];

    const trips = await q(
      `SELECT external_id, platform, fleet_id, plate,
              requested_at, ended_at, status, outcome,
              distance_km, price, currency, product, payment_type,
              pickup_addr, dropoff_addr,
              (extract(hour FROM requested_at AT TIME ZONE 'Asia/Dubai') * 60
               + extract(minute FROM requested_at AT TIME ZONE 'Asia/Dubai'))::int AS s,
              CASE WHEN ended_at IS NULL THEN NULL ELSE
                (extract(hour FROM ended_at AT TIME ZONE 'Asia/Dubai') * 60
                 + extract(minute FROM ended_at AT TIME ZONE 'Asia/Dubai'))::int END AS e,
              (ended_at IS NOT NULL
               AND (ended_at AT TIME ZONE 'Asia/Dubai') >= (($2::date) + 1)) AS past_midnight
         FROM trip_norm
        WHERE ${PKEY} = ANY($1) AND is_booking
          AND (requested_at AT TIME ZONE 'Asia/Dubai')::date = $2::date
        ORDER BY requested_at`, p);

    /* ONLINE spans clipped to this Dubai day. A shift that starts at 21:00 and
       ends at 03:00 is one span in the data and belongs to two days; this asks
       only for the part inside the day being drawn. */
    const online = await q(
      `WITH ev AS (
         SELECT at, status, lead(at) OVER (PARTITION BY driver_ext_id ORDER BY at) AS next_at
           FROM driver_timeline_event
          WHERE driver_ext_id = ANY($1) AND kind = 'status' AND status <> ''
            AND at >= (($2::date - 1)::timestamp AT TIME ZONE 'Asia/Dubai')
            AND at <  (($2::date + 2)::timestamp AT TIME ZONE 'Asia/Dubai'))
       SELECT greatest(0, extract(epoch FROM (
                greatest(at AT TIME ZONE 'Asia/Dubai', $2::timestamp) - $2::timestamp))/60)::int AS s,
              least(1440, extract(epoch FROM (
                least(next_at AT TIME ZONE 'Asia/Dubai', $2::timestamp + interval '1 day')
                - $2::timestamp))/60)::int AS e
         FROM ev
        WHERE next_at IS NOT NULL AND status = 'ONLINE'
          AND next_at > (($2::date)::timestamp AT TIME ZONE 'Asia/Dubai')
          AND at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
        ORDER BY 1`, p);

    /* Where the car was, minute-bucketed. Returned as fixes rather than as
       per-gap rollups because the gaps are computed on the client from the
       jobs, and doing it twice in two places is how the two stop agreeing. */
    const plates = [...new Set(trips.map((t) => t.plate).filter(Boolean))];
    const fixes = plates.length ? await q(
      `SELECT plate,
              (extract(hour FROM captured_at AT TIME ZONE 'Asia/Dubai') * 60
               + extract(minute FROM captured_at AT TIME ZONE 'Asia/Dubai'))::int AS m,
              lat, lng, speed
         FROM telemetry_snapshot
        WHERE plate = ANY($1)
          AND (captured_at AT TIME ZONE 'Asia/Dubai')::date = $2::date
          AND lat IS NOT NULL AND lng IS NOT NULL
        ORDER BY captured_at`, [plates, day]) : [];

    res.json({
      day,
      driver: { id: d.driver_ext_id, name: d.name, keys: d.keys },
      trips: trips.map((t) => ({
        ...t,
        /* Clamped, not wrapped: a dropoff after midnight is minute 20 of the
           NEXT day, which as a raw number sits before its own request. A
           dropoff before its own request on the SAME day is a bad timestamp,
           not a day-long job — the same rule as the shift fold above and as
           src/rollup.js:711. */
        e: t.e == null ? null : (t.past_midnight ? 1440 : Math.max(t.e, t.s)),
      })),
      online,
      fixes,
      /* Said by the API so every renderer says the same thing. */
      basis: 'A job runs from the request to the dropoff, so it contains the drive to the rider. '
        + 'The gaps between jobs are waiting; where the tracker saw the car during one, its '
        + 'position and how much of it was stationary are shown against that gap.',
      online_known: online.length > 0,
    });
  }));

  /* ── weekday × hour: when this person actually works ───────────────── */
  app.get('/api/driver/heatmap', withDriver(async (req, res, d, p) => res.json(await q(
    `SELECT extract(dow from requested_at AT TIME ZONE 'Asia/Dubai')::int dow,
            extract(hour from requested_at AT TIME ZONE 'Asia/Dubai')::int h,
            count(*)::int trips, round(sum(price)::numeric,0) revenue
     FROM trip WHERE ${TW} GROUP BY 1,2 ORDER BY 1,2`, p))));

  /* ── standing against the fleet, as percentiles ────────────────────── */
  // Percentile answers "where does this driver sit", which a raw number never
  // does. Anyone with fewer than 5 trips in the window is excluded from the
  // comparison set — otherwise a single-trip driver distorts every rank.
  app.get('/api/driver/standing', withDriver(async (req, res, d, p) => {
    const peers = await q(
      `SELECT ${PKEY} AS driver_ext_id,
              /* The NAME as well as the key, because the key is an ACCOUNT and
                 the cohort below has to be people — see the fold underneath
                 this query. max() over a group whose key is the provider id:
                 one id, one person, whichever spelling the feed used. */
              max(driver_name) AS driver_name,
              count(*)::int trips,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)::int days,
              sum(distance_km) km, sum(price) revenue,
              avg(distance_km) FILTER (WHERE has_distance) avg_km,
              100.0*count(*) FILTER (WHERE outcome='completed')
                   /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0) completion,
              100.0*count(*) FILTER (WHERE outcome='not_completed')
                   /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0) cancel
       FROM trip_norm
       -- The SAME window rule as TW above, and it has to be: this ranks the
       -- driver against the cohort, and a cohort measured over a window four
       -- hours longer than the driver's own is a comparison between two
       -- different Augusts.
       WHERE ${DAYWIN('requested_at')}
         -- keyed on the person, so a named driver with no id is a peer like
         -- anyone else instead of being quietly left out of the cohort they
         -- are being ranked against
         AND (coalesce(btrim(driver_ext_id), '') <> '' OR coalesce(btrim(driver_name), '') <> '')
       GROUP BY 1 HAVING count(*) >= 5`, [p[0], p[1]]);
    // The peers query projects the PERSON KEY, so the match set is the one to
    // compare against — the account list would miss their id-less rows.
    const mineIds = new Set(d.keys);
    const mine = peers.filter((r) => mineIds.has(r.driver_ext_id));
    if (!mine.length) return res.json({ n_peers: peers.length, metrics: [] });
    const sum = (k) => mine.reduce((a, r) => a + (+r[k] || 0), 0);
    const wavg = (k) => { const t = sum('trips'); return t ? mine.reduce((a, r) => a + (+r[k] || 0) * r.trips, 0) / t : null; };
    const me = {
      trips: sum('trips'), km: sum('km'), revenue: sum('revenue'),
      days: Math.max(...mine.map((r) => r.days)),
      avg_km: wavg('avg_km'), completion: wavg('completion'), cancel: wavg('cancel'),
      trips_per_day: null,
    };
    me.trips_per_day = me.days ? me.trips / me.days : null;

    /* Peer values folded to one per person, which is what this claimed to do
       and did not.
       ─────────────────────────────────────────────────────────────────────
       The key it folded on was PKEY — a provider id where there is one — so
       only the SUBJECT collapsed, through the '__me__' branch. Every other
       driver holding two platform accounts stayed as two rows: two mediocre
       halves of one person, in a population the page then calls "drivers".
       Measured on production 2026-09-04 at days=365 the page said 414 peers
       where /api/drivers/leaderboard counts 361 people who drove — more peers
       than there are drivers, and every percentile taken against that.

       personOf() is the product's own answer to "which human is this record":
       the three-record identity register first, then the name fold — the same
       one the driver directory folds on twelve hundred lines above, and the
       same one sql/schema_v53.sql stores. So the cohort now counts people the
       way every other headcount in this product counts them. An account nobody
       named keys on itself, which keeps it visible rather than merging every
       unnamed account into one ghost. */
    const folded = new Map();
    for (const r of peers) {
      const k = mineIds.has(r.driver_ext_id)
        ? '__me__' : (personOf(r.driver_ext_id, r.driver_name) || r.driver_ext_id);
      const c = folded.get(k) || { trips: 0, km: 0, revenue: 0, days: 0, _cw: 0, avg_km: 0, completion: 0, cancel: 0 };
      c.trips += r.trips; c.km += +r.km || 0; c.revenue += +r.revenue || 0;
      c.days = Math.max(c.days, r.days);
      c._cw += r.trips;
      c.avg_km += (+r.avg_km || 0) * r.trips;
      c.completion += (+r.completion || 0) * r.trips;
      c.cancel += (+r.cancel || 0) * r.trips;
      folded.set(k, c);
    }
    for (const c of folded.values()) {
      if (c._cw) { c.avg_km /= c._cw; c.completion /= c._cw; c.cancel /= c._cw; }
      c.trips_per_day = c.days ? c.trips / c.days : 0;
    }
    const pop = [...folded.values()];
    const pct = (key, higherIsBetter = true) => {
      const vals = pop.map((c) => +c[key] || 0).sort((a, b) => a - b);
      const v = +me[key] || 0;
      let below = 0; while (below < vals.length && vals[below] < v) below++;
      const raw = vals.length > 1 ? (below / (vals.length - 1)) * 100 : 50;
      return { value: v, percentile: Math.round(higherIsBetter ? raw : 100 - raw),
        median: vals[Math.floor(vals.length / 2)] };
    };
    res.json({
      n_peers: pop.length,
      metrics: [
        { key: 'trips', label: 'Trips completed', ...pct('trips') },
        { key: 'trips_per_day', label: 'Trips per working day', ...pct('trips_per_day') },
        { key: 'km', label: 'Distance driven', ...pct('km') },
        { key: 'avg_km', label: 'Average trip length', ...pct('avg_km') },
        { key: 'days', label: 'Days worked', ...pct('days') },
        { key: 'completion', label: 'Completion rate', ...pct('completion') },
        { key: 'cancel', label: 'Cancellation rate', ...pct('cancel', false) },
        { key: 'revenue', label: 'Revenue booked', ...pct('revenue') },
      ].filter((m) => m.value || m.median),
    });
  }));

  /* ── territory: where they pick up, and where they wait ────────────── */
  app.get('/api/driver/territory', withDriver(async (req, res, d, p) => {
    const pickups = await q(
      `SELECT round(pickup_lat::numeric,4) lat, round(pickup_lng::numeric,4) lng,
              count(*)::int n, max(pickup_addr) addr,
              -- Inline, because this reads trip and not trip_norm, so
              -- has_distance is not in scope: the same three conditions the
              -- view's column is made of.
              round(avg(distance_km) FILTER (WHERE distance_km > 0 AND distance_km < 500)::numeric,1) avg_km,
              round(avg(price)::numeric,2) avg_fare
       FROM trip WHERE ${TW} AND pickup_lat IS NOT NULL AND pickup_lat <> 0
       GROUP BY 1,2 ORDER BY n DESC LIMIT 400`, p);
    const dropoffs = await q(
      `SELECT round(dropoff_lat::numeric,4) lat, round(dropoff_lng::numeric,4) lng,
              count(*)::int n, max(dropoff_addr) addr
       FROM trip WHERE ${TW} AND dropoff_lat IS NOT NULL AND dropoff_lat <> 0
       GROUP BY 1,2 ORDER BY n DESC LIMIT 400`, p);
    /* Named areas, coarser than a coordinate — useful as a list next to the map.
       ─────────────────────────────────────────────────────────────────────
       split_part(addr, ' - ', 1) is the FIRST segment, which in
       "01 Cluster E - Al Thanyah Fifth - Dubai - UAE" is a house number. So
       the list read "12 Cluster E", "9 Marasi Dr", "Atlantis" — one row per
       building rather than per area, with trailing " &" fragments and
       non-Latin strings of their own. The second segment is the community, and
       it is the same expression #corridors and #slot use, imported rather than
       copied so all three name a place the same way. */
    const areas = await q(
      `SELECT coalesce(${areaOf('pickup_addr')}, '(unparsed)') area, count(*)::int n,
              round(avg(distance_km) FILTER (WHERE distance_km > 0 AND distance_km < 500)::numeric,1) avg_km,
              round(avg(price)::numeric,2) avg_fare
       FROM trip WHERE ${TW} AND pickup_addr IS NOT NULL AND pickup_addr <> ''
       GROUP BY 1 ORDER BY n DESC LIMIT 25`, p);
    // Where the vehicle sat still between jobs — telemetry, not trips, so it is
    // only available for plates this driver held on days we have GPS for.
    const idle = await q(
      `WITH days AS (SELECT DISTINCT plate, day FROM vehicle_driver_day
                     WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date)
       SELECT round(s.lat::numeric,3) lat, round(s.lng::numeric,3) lng, count(*)::int fixes
       FROM telemetry_snapshot s JOIN days ON days.plate = s.plate
            AND (s.captured_at AT TIME ZONE 'Asia/Dubai')::date = days.day
       WHERE coalesce(s.speed,0) < 2 AND s.lat IS NOT NULL
       GROUP BY 1,2 HAVING count(*) >= 3 ORDER BY fixes DESC LIMIT 120`, p);
    /* The denominator the map is drawn over. One cluster on a map beside a
       table of 139 pickups across 25 areas is not a contradiction — most of
       this fleet's channels report no coordinate at all — but the page could
       not say so, and its "no positioned trips" note fired only at exactly
       zero. */
    const [cover] = await q(
      `SELECT count(*)::int bookings,
              count(*) FILTER (WHERE pickup_lat IS NOT NULL AND pickup_lat <> 0)::int positioned,
              count(*) FILTER (WHERE pickup_addr IS NOT NULL AND pickup_addr <> '')::int addressed,
              array_remove(array_agg(DISTINCT platform)
                FILTER (WHERE pickup_lat IS NULL OR pickup_lat = 0), NULL) AS unpositioned_platforms
       FROM trip_norm WHERE ${TW} AND is_booking`, p);
    res.json({
      pickups, dropoffs, areas, idle,
      coverage: {
        bookings: cover?.bookings ?? 0,
        positioned: cover?.positioned ?? 0,
        addressed: cover?.addressed ?? 0,
        positioned_pct: cover?.bookings
          ? Math.round((cover.positioned / cover.bookings) * 1000) / 10 : null,
        unpositioned_platforms: cover?.unpositioned_platforms || [],
      },
    });
  }));

  /* ── the shape of the work: distance, product, payment, outcome ────── */
  app.get('/api/driver/mix', withDriver(async (req, res, d, p) => {
    const bucket = await q(
      `SELECT CASE WHEN distance_km < 3 THEN '0–3 km'
                   WHEN distance_km < 7 THEN '3–7 km'
                   WHEN distance_km < 15 THEN '7–15 km'
                   WHEN distance_km < 30 THEN '15–30 km'
                   WHEN distance_km < 60 THEN '30–60 km'
                   ELSE '60 km+' END label,
              CASE WHEN distance_km < 3 THEN 1 WHEN distance_km < 7 THEN 2 WHEN distance_km < 15 THEN 3
                   WHEN distance_km < 30 THEN 4 WHEN distance_km < 60 THEN 5 ELSE 6 END ord,
              count(*)::int n, round(sum(price)::numeric,0) revenue,
              round(avg(price)::numeric,2) avg_fare
       FROM trip WHERE ${TW} AND distance_km IS NOT NULL GROUP BY 1,2 ORDER BY ord`, p);
    const one = (col) => q(
      `SELECT coalesce(${col},'unknown') label, count(*)::int n, round(sum(price)::numeric,0) revenue
       FROM trip WHERE ${TW} GROUP BY 1 ORDER BY n DESC LIMIT 20`, p);
    const [product, payment, status, platform] = await Promise.all(
      [one('product'), one('payment_type'), one('status'), one('platform')]);
    res.json({ distance: bucket, product, payment, status, platform });
  }));

  /* ── money: platform-reported components and the daily earnings line ─ */
  app.get('/api/driver/earnings', withDriver(async (req, res, d, p) => {
    const components = await q(
      `SELECT category, parent, round(sum(amount)::numeric,2) amount, currency
       FROM driver_earnings_component
       WHERE driver_ext_id = ANY($3) AND period_start >= $1::date AND period_end <= $2::date
       GROUP BY 1,2,4 ORDER BY abs(sum(amount)) DESC`, p);
    /* The windows that actually contribute, not every window ever fetched.
       This listed driver_performance directly, and for one driver over six
       months that was sixty-seven rows for twenty-eight weeks of work —
       overlapping pairs six days apart, each a real answer to a slightly
       different question, presented as if they were consecutive periods. The
       reader could not add them up and neither could we. See
       sql/schema_v23.sql; "counted" is the part of the period this window
       covers, which is the whole of it unless a finer report overlaps it. */
    /* Counted means counted IN THIS WINDOW.
       ─────────────────────────────────────────────────────────────────────
       This read the driver_payout view, which sums every day of a period
       (sql/schema_v23.sql:147-167), and selected periods by OVERLAP — so a
       period running 2026-07-20 to 07-26 contributed all seven of its days to
       a window that opens on 07-26. On one load the tile read reported_earnings
       5,053.67 while the panel caption underneath it read "AED 6,592 counted
       across 11 statement(s)": AED 1,538 apart, from the same payload.

       driver_payout_day is already one row per day, so clamping is a matter of
       bounding the day rather than the period. `earnings` stays the whole
       period's figure — it is what the platform reported and the page shows it
       as the period's own total — and `counted` is now the part of it that
       falls inside the window, which is what the caption was always claiming
       to add up. */
    const periods = await q(
      `SELECT platform, period_start, period_end, period_days,
              count(*)::int AS days_used,
              min(day) AS first_day_used, max(day) AS last_day_used,
              round(max(period_earnings)::numeric,2) AS earnings,
              round(sum(earnings)::numeric,2) AS counted,
              round(sum(cash_earnings)::numeric,2) AS cash_earnings,
              round(sum(trips)::numeric,0)::int AS trips,
              round(sum(hours_online)::numeric,2) AS hours_online,
              round(sum(hours_on_trip)::numeric,2) AS hours_on_trip,
              /* True where the period straddles an edge of the window, so the
                 page can say the row is a slice rather than a statement. */
              (min(period_start) < $1::date OR max(period_end) > $2::date) AS clipped
       FROM driver_payout_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
       GROUP BY platform, period_start, period_end, period_days
       ORDER BY period_start DESC LIMIT 120`, p);
    /* The two columns the earnings table draws and the payout table cannot
       supply. driver_payout_day is money and hours; acceptance and rating are
       driver_performance's, on the same (driver, period) key — so the page had
       an ACCEPT column and a RATING column that were structurally empty on
       every row of every driver. Joined here rather than deleted, because a
       payout period with an acceptance rate beside it is what makes a quiet
       week readable. */
    const perf = periods.length ? await q(
      `SELECT platform, period_start, period_end,
              max(acceptance_rate) AS acceptance_rate,
              max(cancellation_rate) AS cancellation_rate,
              max(rating) AS rating
       FROM driver_performance
       WHERE driver_ext_id = ANY($3) AND period_end >= $1::date AND period_start <= $2::date
       GROUP BY 1,2,3`, p) : [];
    /* isoDay on both halves of the key, not String(...).slice(0, 10).
       ─────────────────────────────────────────────────────────────────────
       Both queries select bare DATEs: driver_payout_day.period_start and
       period_end (sql/schema_v23.sql:115-116), grouped above, and
       driver_performance's own pair (sql/schema.sql:88-89). Neither is wrapped
       in to_char, so node-postgres hands both sides JS Dates and String() made
       the key "uber|Wed Sep 02|Wed Sep 02" — a Date toString with the year cut
       off. The type is visible from outside: GET /api/driver/earnings for
       driver 76ede4ae…&days=90 serialises period_start as
       "2026-09-02T00:00:00.000Z", which is Express stringifying a Date, not a
       to_char string.

       It matched the right rows anyway, because BOTH sides lost the same year:
       that response holds 40 periods and exactly 1 carries acceptance_rate 1
       and rating 4.95, the 2026-08-03..08-09 week, which is the right answer —
       30 daily payout rows cannot match a weekly performance period on any
       key. Two distinct failures sat one edit away from that.

       ASYMMETRY. Add to_char to either query alone and one side reads
       "2026-08-03" while the other still reads "Mon Aug 03"; every key misses,
       and the ACCEPT and RATING columns of the earnings table go null on every
       row of every driver with no error to show for it. That is the case
       api/performer_routes.js:203 documents: two Dates compare fine, but only
       by luck.

       COLLISION, and this one needs no future edit. Dropping the year makes
       the key collide across years that align on the weekday: the weeks
       2019-10-01..10-07 and 2024-10-01..10-07 are both
       "uber|Tue Oct 01|Mon Oct 07". win() leaves from/to unclamped, so both
       fit in one window a caller can request now, the Map keeps whichever
       performance row it saw last, and the earnings table prints that week's
       rating and acceptance rate against the other week as well — a wrong
       number on the page, not merely a wrong key behind it.
       test/driver_day_keys.test.mjs drives both periods through the route and
       fails on the shared rating. */
    const perfKey = (r) => `${r.platform}|${isoDay(r.period_start)}|${isoDay(r.period_end)}`;
    const byPeriod = new Map(perf.map((r) => [perfKey(r), r]));
    for (const r of periods) {
      const m = byPeriod.get(perfKey(r));
      r.acceptance_rate = m?.acceptance_rate ?? null;
      r.cancellation_rate = m?.cancellation_rate ?? null;
      r.rating = m?.rating ?? null;
    }
    /* The resolved DAY table, not the raw components.
       ─────────────────────────────────────────────────────────────────────
       Uber now answers this driver on two surfaces at once — the REST payments
       feed on short periods and the supplier GraphQL breakdown on weeks — and
       a raw sum over components adds both readings of the same days together.
       Production shows it plainly: driver 64686123 carries a tip row of 35.00
       under your_earnings and another of 30.00 under earnings, for one week of
       work. Summed, the page reported AED 65.

       driver_statement_day is the same components with that collision already
       settled: one row per driver-day, taken from the FINEST period covering
       it (src/rollup.js). It is also what the reconciliation reads, so the
       driver page and the money pages now answer from one table. The window
       predicate is a day range rather than a period range, which is the other
       half of the fix: a week whose Monday fell outside the window used to
       drag all seven of its days in. */
    /* Matched on the NAME as well as the id, which is this table's own rule.
       ─────────────────────────────────────────────────────────────────────
       sql/schema_v25.sql:25 says it outright: "the name is the key — the ledger
       predates our ids and its people must not vanish for want of a match."
       driver_ext_id is nullable here and mostly null. Joined on the id alone
       this returned nothing, on every driver, while the same statements
       reconciled fine on the money pages — src/rollup.js:781 records the
       identical mistake being made and fixed against 2,375 driver-days and
       AED 330,343 of statements that the id join could not see.

       An OR rather than the coalesce PKEY uses, because either half is
       sufficient evidence: a row carrying one of this person's platform ids is
       theirs, and so is a row filed under their name with no id at all. Each
       row can only be counted once whichever arm matches it.

       btrim on name_key: the generated column collapses runs of whitespace but
       does not trim the ends (sql/schema_v25.sql:33), so a name filed with a
       leading space folds to " ali khan" and would miss a key built by
       canonSql, which trims. Cheap here — the day range bounds the scan. */
    const DSD_PERSON = `(driver_ext_id = ANY($3) OR 'name:' || btrim(name_key) = ANY($3))`;
    const [tips] = await q(
      `SELECT round(sum(tips)::numeric,2) tips, round(sum(net)::numeric,2) fare,
              /* The Cash column on this page carried a note saying no statement
                 separates the cash a driver already took from the net figure.
                 driver_statement_day.cash is sql/schema_v25.sql:41, and this
                 very query reads that table. Selected now, so the column can
                 stop apologising for a value that was there all along. */
              round(sum(cash)::numeric,2) cash,
              round(sum(gross)::numeric,2) gross,
              round(sum(fees)::numeric,2) fees,
              round(sum(salik)::numeric,2) salik,
              count(DISTINCT day)::int statement_days
       FROM driver_statement_day
       WHERE source <> 'ledger' AND NOT pseudo AND ${DSD_PERSON}
         AND day BETWEEN $1::date AND $2::date`, p);
    res.json({ components, periods,
      /* The sum the caption prints, computed here rather than left to the page
         to add up — the two disagreed by AED 1,538 in production. */
      counted_total: periods.length
        ? Math.round(periods.reduce((a, r) => a + Number(r.counted || 0), 0) * 100) / 100 : null,
      counted_periods: periods.length,
      counted_clipped: periods.filter((r) => r.clipped).length,
      tips: tips?.tips ?? null, fare: tips?.fare ?? null,
      statement_cash: tips?.cash ?? null,
      statement_gross: tips?.gross ?? null,
      statement_fees: tips?.fees ?? null,
      statement_salik: tips?.salik ?? null,
      statement_days: tips?.statement_days ?? 0,
      tip_pct: tips?.fare > 0 ? +((tips.tips / tips.fare) * 100).toFixed(2) : null });
  }));

  /* ── quality: cancellations, safety events, unauthorised use ───────── */
  app.get('/api/driver/quality', withDriver(async (req, res, d, p) => {
    const cancels = await q(
      // The raw provider string, kept deliberately — the point of this table
      // is to show the vocabulary each platform actually uses. But what counts
      // as "not completed" is decided by the normalised outcome, so Bolt's
      // 'finished' is not listed here as a failure reason, which is what
      // status <> 'completed' did.
      `SELECT coalesce(status,'unknown') status, platform, count(*)::int n,
              round(100.0*count(*)/sum(count(*)) OVER (),1) pct
       FROM trip_norm WHERE ${TW} AND outcome = 'not_completed'
       GROUP BY 1,2 ORDER BY n DESC LIMIT 12`, p);
    const cancelDaily = await q(
      `SELECT local_day AS day,
              count(*) FILTER (WHERE outcome='not_completed')::int cancelled,
              count(*) FILTER (WHERE outcome IS NOT NULL)::int trips
       FROM trip_norm WHERE ${TW} GROUP BY 1 ORDER BY 1`, p);
    // Harsh-driving events are recorded against the vehicle, so they are only
    // this driver's when they held the vehicle that day.
    // DISTINCT matters: vehicle_driver_day carries one row per platform, so a
    // driver who ran Uber and Yango on the same plate the same day would have
    // every harsh-driving event on that day counted twice.
    const alerts = await q(
      `WITH days AS (SELECT DISTINCT plate, day FROM vehicle_driver_day
                     WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date)
       /* Marked for what it is, so the tile above this table does not have to
          classify it again — the Quality tile sums these rows and the tracker
          losing its own power is not a thing this person did. The word list
          lives in api/alert_coverage_sql.js and nowhere else. */
       SELECT a.alert_type, count(*)::int n, max(a.occurred_at) latest,
              bool_or(${DEVICE_FAULT_SQL('a.alert_type')}) AS device
       FROM alert a JOIN days ON days.plate = a.plate
            AND (a.occurred_at AT TIME ZONE 'Asia/Dubai')::date = days.day
       GROUP BY 1 ORDER BY n DESC LIMIT 15`, p);
    /* Whether the telematics feed saw this person's cars at all.
       ─────────────────────────────────────────────────────────────────────
       The third reason this rate can be absent, and the one that used to fall
       straight through to the divide. A driver whose cars are on no telematics
       feed drove the distance in the denominator and produced no alert row, so
       the tile read a confident 0.0 per 100 km — measured on the drivers
       ledger for the same people, 26 of 309 rows at days=30, against a fleet
       rate of 86.4. alerts 0 with device_alerts 0 cannot tell that apart from
       a genuinely clean record; the journey count can. Same custody days as
       the alert query above, so the numerator and this are about one set of
       plate-days; plate_days is carried so that "no custody row at all" stays
       a different absence from "the feed saw nothing". */
    const [tele] = await q(
      `WITH days AS (SELECT DISTINCT plate, day FROM vehicle_driver_day
                     WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date)
       SELECT (SELECT count(*)::int FROM days) AS plate_days,
              count(*)::int AS telematics_journeys
       FROM trip t JOIN days ON days.plate = t.plate
            AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date = days.day
       WHERE t.platform = 'fms'
         AND (t.requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date`, p);
    const trackedJourneys = tele && tele.plate_days ? tele.telematics_journeys : null;
    /* The days the alert feed covered, and both halves of the rate narrowed to
       them.
       ─────────────────────────────────────────────────────────────────────
       The exposure below used to run to the edge of the window. Measured on
       production 2026-09-02 the fleet figure this page paints a driver against
       read 69.7 per 100 km over 16 days and 41.5 over 30 — the identical
       69,338 alerts over 68% more distance — because the alert feed had a
       73-day hole (2026-06-06 to 2026-08-17) and days 17 to 30 back from today
       sat inside it. So a driver widening their own window watched themselves
       improve, and the baseline they were painted against moved further.

       Dubai calendar days: winDays, not the timestamp bounds in p, because a
       covered day is a calendar day everywhere else in this product. */
    const [covFrom, covTo] = winDays(req);
    const cov = await alertCoverage(q, covFrom, covTo);
    const [exposure] = await q(
      `SELECT round(sum(km)::numeric,0) km FROM vehicle_driver_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
         AND day = ANY($4::date[])`, [...p, cov.days]);
    /* What the fleet does, so 29.5 per 100 km has something to be high
       AGAINST. The page painted this figure critical from a hardcoded 5/15
       scale under a sub-label reading "comparable across drivers" — comparable
       to nothing, because the comparison was a constant somebody chose. */
    const [fleetRate] = await q(
      `WITH k AS (
         SELECT sum(km) km FROM vehicle_driver_day
          WHERE day BETWEEN $1::date AND $2::date AND day = ANY($3::date[])),
       a AS (
         SELECT ${drivingCount()} n, ${deviceCount()} device FROM alert
          WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
            AND (occurred_at AT TIME ZONE 'Asia/Dubai')::date = ANY($3::date[]))
       SELECT round(k.km::numeric, 0) AS km, a.n AS alerts, a.device AS device_alerts
         FROM k, a`, [p[0], p[1], cov.days]);
    /* Split, not summed. Main Power Lost is the tracker reporting its own
       power loss, and this rate is the one the page paints a person against —
       so a driver whose car has a failing box was ranked as a hard driver.
       The rows are already grouped by type here, so the shared classifier
       applies directly rather than through a second query. */
    const totalAlerts = alerts.filter((r) => !isDeviceFault(r.alert_type))
      .reduce((a, r) => a + r.n, 0);
    const deviceAlerts = alerts.filter((r) => isDeviceFault(r.alert_type))
      .reduce((a, r) => a + r.n, 0);
    res.json({ cancels, cancel_daily: cancelDaily, alerts,
      /* The distance the rate was taken over: this person's custody kilometres
         on the days the alert feed was up, and no others. */
      alert_km: exposure?.km ?? null,
      /* Both figures through the same rule, so the driver and the baseline
         they are painted against are measured over the identical days. Null
         rather than 0 when the feed covered nothing in the window — a page
         must render that as "not measured", not as a spotless record. */
      alerts_per_100km: alertRate(totalAlerts, exposure?.km, cov, 1,
        { device: deviceAlerts, tracked: trackedJourneys }),
      alerts_per_100km_absent: alertRateReason(exposure?.km, cov,
        { alerts: totalAlerts, device: deviceAlerts, tracked: trackedJourneys }),
      device_alerts: deviceAlerts,
      /* Beside the rate, because it is why the rate is absent when it is: 0 is
         a car the feed never saw, null is a person no custody row places in a
         car at all. The same field the asset and people ledgers carry. */
      telematics_journeys: trackedJourneys,
      fleet_alerts_per_100km: alertRate(fleetRate?.alerts, fleetRate?.km, cov, 1,
        { device: fleetRate?.device_alerts }),
      fleet_device_alerts: fleetRate?.device_alerts ?? null,
      fleet_alert_km: fleetRate?.km == null ? null : Number(fleetRate.km),
      fleet_alerts: fleetRate?.alerts ?? null,
      /* Which days both figures are about, in words the page prints. */
      alert_coverage: cov });
  }));

  /* ── the raw record, because eventually someone needs the trips ────── */
  /* ── the trip ledger, paged, and honest about being paged ─────────────
     This returned a bare array capped at whatever `limit` asked for, and said
     nothing about how many trips the window actually holds. The page then
     printed "the server sent the 500 newest trips in this window, so older
     ones are not on this page at all" — true, and unusable: 500 of how many?
     Of six hundred, that sentence is a footnote. Of twelve hundred, the reader
     is looking at two fifths of the evidence and has no way to reach the rest.

     So the count comes back with the rows, and so does an offset, which is
     what turns a dead end into a page. The count is a second query rather than
     a window function over the same one — a COUNT(*) OVER () is evaluated for
     every row returned, and on a 1,000-row page that is a thousand copies of
     the same integer travelling over the wire. */
  app.get('/api/driver/trips', withDriver(async (req, res, d, p) => {
    const limit = Math.min(+req.query.limit || 200, 1000);
    const offset = Math.max(0, +req.query.offset || 0);
    const [rows, [t], days] = await Promise.all([
      q(`SELECT platform, external_id, requested_at, ended_at, plate, pickup_addr, dropoff_addr,
                distance_km, duration_s, status, product, payment_type, price, currency,
                -- The Dubai calendar day this trip belongs to, as a string.
                -- A bare DATE reaches node-postgres as a JS Date, and slicing
                -- ten characters off its default string form yields "Sat Aug
                -- 01" rather than a date — the trap driver_day_keys and
                -- server_day_keys both grep this file for. The key the client
                -- joins the day list on is formed here, once, in SQL.
                to_char(local_day, 'YYYY-MM-DD') AS local_day,
                -- The provider's own word stays in the status column; outcome is
                -- what the UI may colour by, because the four platforms disagree
                -- about which strings mean success.
                outcome, is_booking, has_fare
         FROM trip_norm WHERE ${TW}
         ORDER BY requested_at DESC LIMIT ${limit} OFFSET ${offset}`, p),
      q(`SELECT count(*)::int n FROM trip_norm WHERE ${TW}`, p),
      /* What a trip with no fare of its own is nevertheless part of.
         ─────────────────────────────────────────────────────────────────
         Uber's trip export carries no fare column, so four fifths of this
         table's Fare cells were an em-dash under a caption explaining that
         nothing prices these rides. That caption is true and it is not the
         best answer available: Uber DOES publish the money, per driver per
         day, and driver_payout_day holds it. A reader looking at a 2
         September Uber ride can be told the driver earned AED 73.78 across
         four Uber trips that day.

         Per (platform, day), never per trip. Dividing the day by its trip
         count would invent a per-trip fare Uber has never stated, and the
         trips of a day are not equal — see sql/schema_v58.sql for what
         happens when a coarser figure is allowed to stand in for a finer one.
         The day is the finest grain that exists, so the day is what is shown.

         Summed across the driver's keys and any fleet: one person may hold an
         account in both fleets, and driver_payout_day is keyed per fleet. */
      q(`WITH t AS (
           SELECT platform, (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
                  count(*)::int                              AS trips,
                  count(*) FILTER (WHERE has_fare)::int      AS priced
             FROM trip_norm WHERE ${TW}
            GROUP BY 1, 2)
         SELECT t.platform, to_char(t.day, 'YYYY-MM-DD') AS day, t.trips, t.priced,
                pd.earnings, pd.cash_earnings, pd.grain_reason
           FROM t
           LEFT JOIN LATERAL (
             SELECT sum(pdd.earnings)      AS earnings,
                    sum(pdd.cash_earnings) AS cash_earnings,
                    /* Present only when the day carries no money BECAUSE a
                       finer report already stated it — the sentence the
                       server wrote on the row, printed rather than inferred
                       from a NULL. */
                    max(pdd.grain_reason)  AS grain_reason
               FROM driver_payout_day pdd
              WHERE pdd.driver_ext_id = ANY($3)
                AND pdd.platform = t.platform
                AND pdd.day = t.day) pd ON true`, p),
    ]);
    const total = t?.n ?? rows.length;
    res.json({ rows, total, shown: rows.length, offset, limit,
      /* Keyed `platform|day`, matching each row's own platform and local_day.
         A list rather than an object so the shape survives JSON with no key
         ordering assumptions, and so a day with no money still appears with
         its trip count instead of vanishing. */
      days,
      /* Stated as a flag as well as derivable, so a renderer cannot get the
         comparison the wrong way round and claim a complete list. */
      truncated: offset + rows.length < total });
  }));

  /* ── which vehicles, day by day (handovers visible) ────────────────── */
  app.get('/api/driver/custody', withDriver(async (req, res, d, p) => {
    const rows = await q(
      `SELECT day, plate, platform, trips, km, revenue, first_trip_at, last_trip_at, is_primary
       FROM vehicle_driver_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
       ORDER BY day DESC, trips DESC LIMIT 400`, p);
    // 60 of 256 rows reached the Activity tab with nothing saying so.
    const [t] = await q(
      `SELECT count(*)::int n FROM vehicle_driver_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date`, p);
    res.json({ rows, total: t?.n ?? rows.length, shown: rows.length,
      truncated: (t?.n ?? 0) > rows.length });
  }));

  /* The mirror of the vehicle page's custody table: which cars has this person
     had. Moved here from server.js, where three things were wrong with it:

       - it took `driver_id` while every one of its eleven siblings takes `id`,
         so a link built the way the rest of the app builds links answered 400
       - it took ONE raw id, so somebody with an Uber account and a Bolt account
         saw the cars from one of them
       - it ignored the window, so it answered about all of history on a page
         filtered to a month

     withDriver resolves the person, hands over their whole key set, applies the
     window and refuses an id nobody has. `driver_id` is still accepted, because
     an address somebody has already bookmarked should not start 404ing. */
  app.get('/api/driver/vehicles', (req, res, next) => {
    if (!req.query.id && req.query.driver_id) req.query.id = req.query.driver_id;
    return next();
  }, withDriver(async (req, res, d, p) => res.json(await q(
    `SELECT plate, count(DISTINCT day)::int days, sum(trips)::int trips,
            round(sum(km)::numeric,0) km, round(sum(revenue)::numeric,0) revenue,
            min(day) first_day, max(day) last_day,
            count(DISTINCT day) FILTER (WHERE is_primary)::int primary_days,
            array_agg(DISTINCT platform) AS platforms
     FROM vehicle_driver_day
     WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
     GROUP BY plate ORDER BY days DESC, trips DESC`, p))));
}
