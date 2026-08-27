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
import { fleetIncome } from './income_sql.js';
import { areaOf } from './analytics_routes.js';

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
      if (!seed && !nameQ) return null;          // unknown id — say so rather than answering emptily
    }
    const name = seed?.driver_name || nameQ;
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
    const ids = [...new Set([...alias.map((a) => a.driver_ext_id), ...(id ? [id] : [])]
      .filter(Boolean))];
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
      ...alias.map((a) => nameKey(a.driver_name)), nameKey(name)].filter(Boolean))];
    // the longest spelling is usually the fullest one; prefer it for display
    const display = alias.map((a) => a.driver_name).sort((a, b) => b.length - a.length)[0] || name;
    return { id: id || ids[0], name: display, ids, keys,
      platforms: [...new Set(alias.map((a) => a.platform))] };
  }

  /* The person key: a provider id where there is one, the synthesised name: key
     where there is not. Every query over trip/trip_norm keys on this, never on
     the raw column — keyed raw, a driver the provider names without an id has
     no matchable rows and every panel on their page comes back empty while the
     directory row that linked there says they drove. */
  const PKEY = `coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || ${CANON('driver_name')})`;

  // Shared trip predicate: any of this person's keys, over the window.
  // `$1..$2` window, `$3` key array — keep this argument order in every query.
  const TW = `${PKEY} = ANY($3) AND requested_at BETWEEN $1 AND $2`;

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
       )
       /* The lifetime figures come from the CTE at the top of this statement:
          the last trip EVER, so "has not driven in this window" and "has never
          driven" are different rows rather than the same blank — and keyed on
          person_key rather than the fold, because that scan is unbounded and
          folding 175,000 names per request is what the stored, indexed column
          exists to avoid. */
       SELECT who.driver_ext_id, who.driver_name,
              coalesce(w.trips, 0) AS trips, coalesce(w.completed, 0) AS completed,
              coalesce(w.bookable, 0) AS bookable, coalesce(w.days, 0) AS days,
              w.km, w.revenue, coalesce(w.priced_trips, 0) AS priced_trips,
              pay.payout, coalesce(pay.payout_days, 0) AS payout_days,
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
              dps.platform AS state_platform, dps.plate AS state_plate
       FROM who
       LEFT JOIN work w ON w.driver_ext_id = who.driver_ext_id
       LEFT JOIN pay ON pay.driver_ext_id = who.driver_ext_id
       LEFT JOIN ever ev ON ev.driver_ext_id = who.driver_ext_id
       LEFT JOIN driver_compliance dc ON dc.driver_ext_id = who.driver_ext_id
       LEFT JOIN driver_platform_state dps ON dps.driver_ext_id = who.driver_ext_id
       ORDER BY coalesce(w.trips, 0) DESC, who.driver_name LIMIT 800`, [...P, placeholderDate]);

    /* Fold per-platform rows into one row per person, so the directory lists
       humans rather than accounts. Counts are carried through and the ratios
       are computed ONCE at the end — folding a pre-computed percentage keeps
       one account's number and calls it the person's. */
    const byName = new Map();
    for (const r of rows) {
      const k = canonName(r.driver_name);
      const cur = byName.get(k);
      if (!cur) {
        byName.set(k, { ...r, ids: [r.driver_ext_id], platforms: [...(r.platforms || [])],
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
        set.add(String(d.local_day).slice(0, 10));
        days.set(person, set);
      }
      days.forEach((set, person) => { person.days = set.size; });
    }

    res.json([...byName.values()].map((p) => {
      delete p._days; delete p._multiAccountDays;
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
    const compliance = await q(
      `SELECT platform, driver_ext_id, full_name, phone, emirates_id, licence_no, licence_expires,
              (licence_expires - now()::date) AS licence_days_left, state, suspension_reason,
              rating, device_brand, device_model, updated_at
       FROM driver_compliance WHERE driver_ext_id = ANY($1)`, [d.keys]);
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
              score, can_earn, observed_at
       FROM driver_platform_state WHERE driver_ext_id = ANY($1)
       ORDER BY platform`, [d.keys]);
    res.json({ ...d, span, compliance, standing, vehicles, accounts });
  }));

  /* ── headline numbers, plus the shift shape the mockup asks for ────── */
  app.get('/api/driver/kpis', withDriver(async (req, res, d, p) => {
    const [t] = await q(
      `SELECT count(*)::int trips,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)::int days_worked,
              round(sum(distance_km)::numeric,0) km, round(avg(distance_km)::numeric,1) avg_km,
              -- avg() skips NULLs, so avg_km is over the trips that REPORT a
              -- distance and km/trips does not reproduce it. Returned so the
              -- tile can print the denominator it actually used.
              count(distance_km)::int trips_with_distance,
              round(sum(price)::numeric,2) revenue,
              round(avg(price)::numeric,2) avg_fare,
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
      `SELECT round(sum(hours_online)::numeric,1) hours_online,
              round(sum(hours_on_trip)::numeric,1) hours_on_trip,
              round(avg(acceptance_rate)::numeric,3) acceptance_rate,
              round(avg(cancellation_rate)::numeric,3) cancellation_rate,
              round(avg(rating)::numeric,2) rating,
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
      bookings: f.bookings, priced_bookings: f.priced_bookings, fares: n(f.fares) });
    for (const y of payByPlat) Object.assign(plat(y.platform), {
      payouts: n(y.payouts), payout_days: y.payout_days ?? 0 });
    const windowDays = Math.round((Date.parse(p[1]) - Date.parse(p[0])) / 86400000) + 1;

    res.json({ ...t, ...shift, ...perf, ...fleetIncome([...byPlat.values()], windowDays),
      trips_per_day: t.days_worked ? +(t.trips / t.days_worked).toFixed(1) : null,
      utilisation_pct: perf?.hours_online ? +((perf.hours_on_trip / perf.hours_online) * 100).toFixed(1) : null });
  }));

  /* ── day by day: the spine every chart on the detail page hangs off ── */
  app.get('/api/driver/daily', withDriver(async (req, res, d, p) => res.json(await q(
    `WITH t AS (
       SELECT (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
              count(*)::int trips,
              count(*) FILTER (WHERE outcome='completed')::int completed,
              count(*) FILTER (WHERE outcome='not_completed')::int cancelled,
              count(*) FILTER (WHERE outcome IS NOT NULL)::int outcome_n,
              round(sum(distance_km)::numeric,1) km,
              round(sum(price)::numeric,2) revenue,
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
       GROUP BY 1)
     SELECT t.*, round(h.hours_online::numeric,2) hours_online,
            round(h.hours_on_trip::numeric,2) hours_on_trip,
            round(h.earnings::numeric,2) platform_earnings,
            w.temp_max, w.precipitation, c.is_holiday, c.holiday_name, c.is_ramadan
     FROM t LEFT JOIN h USING (day)
            LEFT JOIN weather_daily w ON w.day = t.day
            LEFT JOIN calendar_day c ON c.day = t.day
     ORDER BY t.day`, p))));

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
        /* Clamped, not wrapped. A dropoff after midnight is minute 20 of the
           NEXT day, which as a raw number sits before its own request. */
        const e = r.e == null ? null : (r.past_midnight || r.e < s ? 1440 : r.e);
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
            AND at >= $1::timestamptz AND at <= $2::timestamptz),
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
           NEXT day, which as a raw number sits before its own request. */
        e: t.e == null ? null : (t.past_midnight || t.e < t.s ? 1440 : t.e),
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
              count(*)::int trips,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)::int days,
              sum(distance_km) km, sum(price) revenue,
              avg(distance_km) avg_km,
              100.0*count(*) FILTER (WHERE outcome='completed')
                   /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0) completion,
              100.0*count(*) FILTER (WHERE outcome='not_completed')
                   /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0) cancel
       FROM trip_norm
       WHERE requested_at BETWEEN $1 AND $2
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

    // Peer values are folded to one per person too, so a driver split across
    // two platforms isn't counted as two mediocre drivers.
    const folded = new Map();
    for (const r of peers) {
      const k = mineIds.has(r.driver_ext_id) ? '__me__' : r.driver_ext_id;
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
              count(*)::int n, max(pickup_addr) addr, round(avg(distance_km)::numeric,1) avg_km,
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
              round(avg(distance_km)::numeric,1) avg_km, round(avg(price)::numeric,2) avg_fare
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
    const perfKey = (r) => `${r.platform}|${String(r.period_start).slice(0, 10)}`
      + `|${String(r.period_end).slice(0, 10)}`;
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
    const [tips] = await q(
      `SELECT round(sum(tips)::numeric,2) tips, round(sum(net)::numeric,2) fare
       FROM driver_statement_day
       WHERE source <> 'ledger' AND driver_ext_id = ANY($3)
         AND day BETWEEN $1::date AND $2::date`, p);
    res.json({ components, periods,
      /* The sum the caption prints, computed here rather than left to the page
         to add up — the two disagreed by AED 1,538 in production. */
      counted_total: periods.length
        ? Math.round(periods.reduce((a, r) => a + Number(r.counted || 0), 0) * 100) / 100 : null,
      counted_periods: periods.length,
      counted_clipped: periods.filter((r) => r.clipped).length,
      tips: tips?.tips ?? null, fare: tips?.fare ?? null,
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
       SELECT a.alert_type, count(*)::int n, max(a.occurred_at) latest
       FROM alert a JOIN days ON days.plate = a.plate
            AND (a.occurred_at AT TIME ZONE 'Asia/Dubai')::date = days.day
       GROUP BY 1 ORDER BY n DESC LIMIT 15`, p);
    const [exposure] = await q(
      `SELECT round(sum(km)::numeric,0) km FROM vehicle_driver_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date`, p);
    /* What the fleet does, so 29.5 per 100 km has something to be high
       AGAINST. The page painted this figure critical from a hardcoded 5/15
       scale under a sub-label reading "comparable across drivers" — comparable
       to nothing, because the comparison was a constant somebody chose. */
    const [fleetRate] = await q(
      `WITH k AS (
         SELECT sum(km) km FROM vehicle_driver_day
          WHERE day BETWEEN $1::date AND $2::date),
       a AS (
         SELECT count(*)::int n FROM alert
          WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date)
       SELECT round((a.n * 100.0 / nullif(k.km, 0))::numeric, 1) AS per_100km,
              round(k.km::numeric, 0) AS km, a.n AS alerts
         FROM k, a`, [p[0], p[1]]);
    const totalAlerts = alerts.reduce((a, r) => a + r.n, 0);
    res.json({ cancels, cancel_daily: cancelDaily, alerts,
      alert_km: exposure?.km ?? null,
      alerts_per_100km: exposure?.km > 0 ? +((totalAlerts / exposure.km) * 100).toFixed(1) : null,
      fleet_alerts_per_100km: fleetRate?.per_100km == null ? null : Number(fleetRate.per_100km),
      fleet_alert_km: fleetRate?.km == null ? null : Number(fleetRate.km),
      fleet_alerts: fleetRate?.alerts ?? null });
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
    const [rows, [t]] = await Promise.all([
      q(`SELECT platform, external_id, requested_at, ended_at, plate, pickup_addr, dropoff_addr,
                distance_km, duration_s, status, product, payment_type, price, currency,
                -- The provider's own word stays in the status column; outcome is
                -- what the UI may colour by, because the four platforms disagree
                -- about which strings mean success.
                outcome, is_booking, has_fare
         FROM trip_norm WHERE ${TW}
         ORDER BY requested_at DESC LIMIT ${limit} OFFSET ${offset}`, p),
      q(`SELECT count(*)::int n FROM trip_norm WHERE ${TW}`, p),
    ]);
    const total = t?.n ?? rows.length;
    res.json({ rows, total, shown: rows.length, offset, limit,
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
