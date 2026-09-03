import { personFold, JOIN_TRIP } from './custody_sql.js';

/* One spelling for a channel, matching the dashboard's own label map. */
const CHANNEL_NAMES = { uber: 'Uber', yango: 'Yango', bolt: 'Bolt', hotel: 'Hotel',
  fms: 'FMS telematics', cabman: 'CABMAN' };
const CHANNEL_LABEL = (v) => CHANNEL_NAMES[String(v || '').toLowerCase()] || String(v || '');
/* The roster: who is on the books, and who is actually earning.
   ──────────────────────────────────────────────────────────────────────────
   Four providers each report a driver's standing and none of them knows what
   the others said. Uber returns an onboardingStatus including WAITLIST; Bolt
   returns a state with a suspension reason and a driver score; Yango returns a
   status on its driver summary; the corporate channel returns a currentStatus.
   Held together, and joined against what each person actually drove, they
   answer three questions no single provider can:

     recruited and never activated     a state that cannot earn, and no trip ever
     on the books and earning nothing   a state that CAN earn, and no trip this window
     stopped while holding a car        a suspended state with a vehicle attached

   The last one is the expensive one: a car assigned to somebody who is not
   allowed to drive it earns nothing and still depreciates, insures and parks.

   Identity across platforms is by NAME, folded the same way the driver pages
   fold it. That is a weaker key than an id and it is the only one that spans
   providers; where it is uncertain the response says how many platform
   accounts were folded, so a reader can see the join rather than trust it. */

const round = (v, d = 1) => (v == null || !Number.isFinite(Number(v)) ? null
  : Math.round(Number(v) * 10 ** d) / 10 ** d);

/* Two spellings of one person. The same collapse the driver pages use: a
   doubled surname ("Asad Khan Khan") is one человек, not two. */
/* The fold, imported rather than repeated. This file held a fourth copy of it
   — api/server.js had a third, api/custody_sql.js exports the original, and
   sql/schema_v20.sql stores it as a generated column. Four definitions of "the
   same human" is how one person becomes two on a page nobody is looking at. */
const CANON = personFold('full_name');
/* The STORED fold, which is the same expression plus the three verified
   merges (sql/schema_v53.sql generates driver_platform_state.person_key from
   api/identity_map.js). Re-folding full_name here instead would leave the
   roster the one page in the product that still reads a merged pair as two
   people — and it is the page an operator counts heads on. coalesce keeps the
   old behaviour for a row the generated column has nothing to say about. */
const STANDING_PERSON = `coalesce(nullif(person_key, ''), ${CANON})`;

export function rosterRoutes(app, { q, wrap, range }) {
  /* One row per person, with every platform standing they hold and what they
     drove inside the window. */
  app.get('/api/roster', wrap(async (req, res) => {
    const [from, to, platform, fleet] = range(req);
    const p = [from, to, platform, fleet];

    /* Which platforms we hold ANY trip for. Without this, "never driven" is
       inferred from our own trip table, and that table has no Bolt rows at all
       — so 36 Bolt drivers were being reported as never having driven when the
       truth is that we do not collect their trips. An inference drawn across a
       collection gap is not a finding about a person. */
    const withTrips = new Set((await q(
      `SELECT DISTINCT platform FROM trip WHERE driver_name IS NOT NULL`)).map((r) => r.platform));

    const rows = await q(
      /* The fleet filter is applied to WORK, not to the credential set.
         ─────────────────────────────────────────────────────────────────────
         driver_platform_state.fleet_id records which fleet's credentials
         collected the row, not which fleet the person drives for. Only Egari's
         Bolt credentials work, so &fleet=egari returned exactly the Bolt
         roster — 67 people, all platforms:["bolt"], working: 0 — byte-identical
         to &platform=bolt, while /api/drivers/directory listed Egari drivers
         with 162 trips in the same window. A supply page that answers "who is
         idle at Egari" with "the people Egari's Bolt token could see" is
         answering a different question in the same words.

         So membership comes from the fleet a person actually drove for in the
         window (`fleets`, below), and the credential fleet is the fallback for
         somebody with no trips at all — where it is the only thing we hold.
         The response says which of the two answered, because they are not the
         same claim. */
      /* The roster's population is not only the people who have an account.
         ─────────────────────────────────────────────────────────────────────
         `s` was driver_platform_state alone, and the whole query hangs off
         `FROM s`, so somebody who took bookings in the window but has no
         standing row on any platform simply was not on the roster. Measured on
         production over 2026-08-01..08-31: /api/kpis counts 119 drivers and
         this page listed 116 of them, while /api/drivers/directory — which
         builds its population from trips — held 395 people against the
         roster's 338.

         Those three are not a rounding difference. The roster exists to find
         people who are not earning, and a driver the provider has stopped
         describing is exactly the shape it should surface loudest; instead it
         was the one shape it could not see. Uber drops a driver from the
         supplier roster when their account is deactivated, so the credential
         feed goes quiet on precisely the people whose last week of work is
         worth looking at.

         A worked-only person carries no state, score or can_earn — nothing
         claimed any — and the aggregates below already skip NULL inputs, so
         they contribute to nothing they cannot answer. `is_account` marks
         which branch a row came from so `accounts` still counts accounts. */
      `WITH s AS (
         SELECT ${STANDING_PERSON} AS person, platform, driver_ext_id, full_name, state, state_raw,
                state_reason, plate, vehicle_ext_id, score, can_earn, observed_at, fleet_id,
                true AS is_account
         FROM driver_platform_state
         WHERE ($3::text IS NULL OR platform = $3)
           AND coalesce(btrim(full_name), '') <> ''
         UNION ALL
         SELECT person, platform, driver_ext_id, full_name,
                NULL::text, NULL::text, NULL::text, plate, NULL::text,
                NULL::numeric, NULL::boolean, NULL::timestamptz, fleet_id,
                false AS is_account
         FROM (
           SELECT t.person_key AS person, n.platform,
                  (array_agg(n.driver_ext_id ORDER BY n.requested_at DESC)
                     FILTER (WHERE n.driver_ext_id IS NOT NULL))[1] AS driver_ext_id,
                  (array_agg(n.driver_name ORDER BY n.requested_at DESC)
                     FILTER (WHERE coalesce(btrim(n.driver_name), '') <> ''))[1] AS full_name,
                  (array_agg(n.plate ORDER BY n.requested_at DESC)
                     FILTER (WHERE coalesce(n.plate, '') <> ''))[1] AS plate,
                  max(n.fleet_id) AS fleet_id
           FROM trip_ext n ${JOIN_TRIP}
           WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking
             AND t.person_key IS NOT NULL AND t.person_key <> ''
             AND ($3::text IS NULL OR n.platform = $3)
           GROUP BY 1, 2
         ) wo
         WHERE NOT EXISTS (
           SELECT 1 FROM driver_platform_state d
            WHERE coalesce(nullif(d.person_key, ''), ${personFold('d.full_name')}) = wo.person
              AND coalesce(btrim(d.full_name), '') <> ''
              AND ($3::text IS NULL OR d.platform = $3))
       ),
       /* ONE pass over the window, answering both questions it was asked
          twice for.
          ─────────────────────────────────────────────────────────────────
          This was two CTEs — fleets over trip_norm and w over trip_ext —
          scanning the same rows of the same window for the same people, one
          without the fleet filter and one with it. Over a 365-day window that
          is the whole trip table, twice, and /api/roster answered in 25
          seconds; api/warm.js requests exactly that window every time the data
          version moves, so the cost was paid on a schedule whether anybody
          read the page or not.

          The filter moves onto the aggregates instead. Every fleet this person
          took a booking for is still computed over ALL of their rows — it is
          the set membership below is tested against, so it cannot be narrowed
          by the filter it is deciding — while the work columns count only the
          rows the filter admits. A person with no work for the filtered fleet
          then arrives with trips 0 and the rest null, which is what the outer
          coalesce already made of a missing row: the response is unchanged,
          row for row.

          The stored fold, via the base table. Computed per row this was the
          roster's cost over a wide window — 37 seconds across the full record
          — and it is the same expression, so the same answer. Every column is
          qualified because the join puts two of each in scope. */
       w AS (
         SELECT t.person_key AS person,
                array_remove(array_agg(DISTINCT n.fleet_id), NULL) AS fleets_worked,
                count(*) FILTER (WHERE $4::text IS NULL OR n.fleet_id = $4)::int trips,
                count(*) FILTER (WHERE n.outcome = 'completed'
                  AND ($4::text IS NULL OR n.fleet_id = $4))::int completed,
                sum(n.price) FILTER (WHERE n.price IS NOT NULL AND NOT n.is_complimentary
                  AND ($4::text IS NULL OR n.fleet_id = $4)) AS revenue,
                sum(n.distance_km) FILTER (WHERE n.has_distance
                  AND ($4::text IS NULL OR n.fleet_id = $4)) AS km,
                max(n.requested_at) FILTER (WHERE $4::text IS NULL OR n.fleet_id = $4) AS last_trip
         FROM trip_ext n ${JOIN_TRIP}
         WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking
           AND t.person_key IS NOT NULL AND t.person_key <> ''
         GROUP BY 1
       ),
       -- Has this person EVER driven, on any platform, at any time? The
       -- difference between "quiet this month" and "never started".
       /* person_key, not the fold. This question has no window — "ever, on any
          platform, at any time" reads the whole trip table by definition — so
          there is no index that can narrow it and the fold was being evaluated
          on all 175,000 rows per request. Measured at that row count it is
          2,434ms folded against 142ms on the stored column, and this endpoint
          took twenty-one seconds. sql/schema_v20.sql stores the same
          expression as a generated column, so the value is identical and
          Postgres maintains it. */
       ever AS (
         SELECT person_key AS person,
                min(requested_at) AS first_trip, max(requested_at) AS last_ever,
                count(*)::int lifetime_trips
         FROM trip WHERE driver_name IS NOT NULL AND btrim(driver_name) <> '' GROUP BY 1
       ),
       /* What these people were PAID, not only what their riders were charged.
          ─────────────────────────────────────────────────────────────────────
          The money column here was sum(trip.price), and Uber's trip export has
          no fare column at all. Measured on production over thirty days: 251
          of 280 people showed no money, on the page an operator reads to
          decide who to keep supplying with cars.

          driver_payout_day is what each ACCOUNT was paid, resolved so
          overlapping report periods cannot double count (sql/schema_v23.sql).
          Folded to the person the same way everything else on this page is,
          because one human can hold two platform accounts and this page is
          about the human. Summed across their accounts — that is what "this
          person earned" means when they drive for two channels. */
       paid AS (
         /* Folded through s, which IS this page's population, rather than
            through another pass over the trip table — ever above already
            reads all of it once and this needs no second scan. A person
            holding two platform accounts appears twice in s, so the id list is
            deduped first and their accounts are then SUMMED, which is what
            "this person earned" means when they drive for two channels. */
         SELECT a.person,
                round(sum(d.earnings)::numeric, 2) AS payout,
                count(DISTINCT d.day)::int AS payout_days
         FROM driver_payout_day d
         JOIN (SELECT DISTINCT person, driver_ext_id FROM s
                WHERE coalesce(btrim(driver_ext_id), '') <> '') a
           ON a.driver_ext_id = d.driver_ext_id
         WHERE d.day BETWEEN $1::date AND $2::date
           AND ($4::text IS NULL OR d.fleet_id = $4)
         GROUP BY 1
       ),
       /* The fare the platform reports, for the channels that report no fare
          per trip. The revenue column above is sum(trip.price), and Uber's export has
          no price column at all — so the Fares column on this page was empty
          for 298 of 335 people, on a fleet whose statements carry the figure
          week by week. Read from the same breakdown /api/driver/earnings
          draws, folded through s exactly as the paid CTE is.

          Only the top of the tree: little_fare, surge, wait_time and the rest
          hang off 'fare' as its components, and summing the category column
          without regard to parent nearly doubles the total. Kept in its own
          column and never added to the revenue — this is the gross the rider was
          charged and the payout beside it came out of it. */
       fare_line AS (
         SELECT a.person,
                round(sum(c.amount)::numeric, 2) AS statement_fares,
                count(DISTINCT (c.period_start, c.period_end))::int AS statement_fare_periods
         FROM driver_earnings_component c
         JOIN (SELECT DISTINCT person, driver_ext_id FROM s
                WHERE coalesce(btrim(driver_ext_id), '') <> '') a
           ON a.driver_ext_id = c.driver_ext_id
        WHERE c.category IN ('fare', 'net_fare')
          AND c.period_start >= $1::date AND c.period_end <= $2::date
        GROUP BY 1
       )
       SELECT s.person,
              max(s.full_name) AS name,
              /* Which fleet they actually worked for, and which fleet's
                 credentials described them. Returned because a filtered page
                 has to be able to say which of the two put this row here. */
              /* max(), not (array_agg(DISTINCT …))[1].
                 ─────────────────────────────────────────────────────────
                 f.fleets_worked is itself an array, so array_agg of it builds
                 a TWO-DIMENSIONAL array, and subscripting a 2-D array with a
                 single index returns NULL in Postgres — not the first row, not
                 an error. This column was therefore null for every person on
                 the roster: 335 of 335 on production, on a page that returns
                 it so a filtered view can say which of the two fleets put the
                 row there. The fleets CTE has one row per person and the
                 join is on person, so every row in the group carries the same
                 array and max() is that array. */
              max(w.fleets_worked) AS fleets_worked,
              array_remove(array_agg(DISTINCT s.fleet_id), NULL) AS credential_fleets,
              /* Accounts, not rows: a person who reached this roster through
                 their trips alone has none, and counting their trip row as one
                 would report a standing account nobody holds. */
              count(*) FILTER (WHERE s.is_account)::int AS accounts,
              array_agg(DISTINCT s.platform ORDER BY s.platform) AS platforms,
              /* NULL-removed, so "no platform reported a state" is an empty
                 set rather than a list containing nothing. The page joins this
                 with commas and a null renders as a stray separator. */
              array_remove(array_agg(DISTINCT s.state ORDER BY s.state), NULL) AS states,
              bool_or(s.can_earn) AS can_earn_anywhere,
              -- NOT coalesce(can_earn, false): that reads "no provider said" as
              -- "every provider said no", which files a driver whose state we
              -- could not classify under "stopped". Postgres aggregates skip
              -- NULL inputs, so (can_earn = false) yields NULL when nobody made
              -- a claim, true when every claim was "cannot earn", and false as
              -- soon as one platform permits work — which is exactly the
              -- three-valued answer this needs.
              bool_and(s.can_earn = false) AS cannot_earn_anywhere,
              -- Stopped is a different fact from cannot-earn. A waitlisted
              -- driver cannot earn and has not been stopped; conflating the two
              -- files somebody who has not started yet under "suspended".
              bool_and(s.state IN ('suspended', 'deactivated')) AS stopped_everywhere,
              max(s.score) AS score,
              -- Any one of the person's platform ids. The roster exists to find
              -- people who are not earning, and every row was a name with
              -- nowhere to go; /api/driver/* resolves one id to the whole
              -- folded person, so one is enough to make the name a link.
              (array_agg(DISTINCT s.driver_ext_id) FILTER (WHERE s.driver_ext_id IS NOT NULL))[1] AS driver_ext_id,
              array_remove(array_agg(DISTINCT s.plate), NULL) AS plates,
              max(s.observed_at) AS observed_at,
              (array_agg(s.state_reason ORDER BY s.state_reason NULLS LAST))[1] AS reason,
              coalesce(max(w.trips), 0)::int AS trips,
              coalesce(max(w.completed), 0)::int AS completed,
              max(w.revenue) AS revenue,
              max(fl.statement_fares) AS statement_fares,
              max(fl.statement_fare_periods) AS statement_fare_periods,
              max(paid.payout) AS payout, max(paid.payout_days) AS payout_days,
              max(w.km) AS km,
              max(w.last_trip) AS last_trip,
              max(e.lifetime_trips) AS lifetime_trips,
              min(e.first_trip) AS first_trip,
              max(e.last_ever) AS last_ever
       FROM s
       LEFT JOIN w    ON w.person = s.person
       LEFT JOIN paid ON paid.person = s.person
       LEFT JOIN ever e ON e.person = s.person
       LEFT JOIN fare_line fl ON fl.person = s.person
       GROUP BY s.person
       HAVING $4::text IS NULL
           OR bool_or(w.fleets_worked @> ARRAY[$4]::text[])
           OR (bool_and(w.fleets_worked IS NULL) AND bool_or(s.fleet_id = $4))
       ORDER BY trips DESC, name`, p);

    const people = rows.map((r) => {
      const lifetime = r.lifetime_trips || 0;
      // Can we even see this person's work? If every platform they are on is
      // one we hold no trips for, a lifetime count of zero says nothing.
      /* Three ways to know somebody's output, not one.
         ─────────────────────────────────────────────────────────────────
         This asked only "do we collect trips for a platform they are on",
         which is the right question for a Bolt-only driver and the wrong one
         for anybody whose trips we are LOOKING AT. Hamza Iqbal Sajid Iqbal
         rendered as "OUTPUT NOT OBSERVED" beside "TRIPS THIS WINDOW 169" and
         "LAST DROVE Aug 24"; five of the busiest people on the roster were
         filed that way, summing 183 trips in the window and 1,518 / 1,752 /
         616 / 39 / 1,546 lifetime. Observed work is observation, whatever the
         platform list says. */
      const activityKnown = (r.platforms || []).some((pl) => withTrips.has(pl))
        || (r.trips || 0) > 0 || lifetime > 0;
      /* Categories, in the order the claims get weaker.

         `bool_or` returns NULL only when EVERY platform declined to say — which
         is what an unrecognised state produces. Filing that person as "not yet
         able to earn" asserts something about their employment that no provider
         actually said, so it gets a category of its own. This is the difference
         between reporting a gap in our knowledge and inventing a fact. */
      const blocked = r.stopped_everywhere === true;
      /* Ordered by how strong the claim is, strongest first.

         What a provider ASSERTS about somebody's standing comes before
         anything INFERRED from our own trip table, because that table may
         simply not contain their platform. Getting the order wrong reported 31
         suspended and deactivated Bolt drivers as "still waiting to start",
         and printed blocked: 0 on the same screen as "31 holding a vehicle
         while blocked".

         And stopped is not the same fact as cannot-earn: a waitlisted driver
         cannot earn and has not been stopped. */
      /* Trips in the window outrank a roster assertion, because a trip is
         something that HAPPENED and a roster row is a claim about an account.
         The rung below is right that our trip table may not cover somebody's
         platform — but the reverse holds here and is what bit: the roster does
         not cover theirs. Two people carrying a rejected Yango application and
         a waitlisted Bolt one had 50 and 23 completed trips in the window and
         2,465 lifetime between them, and were filed under "not yet able to
         earn". That also made "Drove in this window" read 89 on a page where
         91 people had trips. Blocked still comes first: being stopped today is
         compatible with having driven earlier in the same window, and a
         stopped driver holding a car is the fact worth surfacing. */
      const category = blocked ? 'blocked'
        : r.trips > 0 ? 'working'
          : r.cannot_earn_anywhere === true ? 'in_pipeline'
            : r.can_earn_anywhere == null ? 'unclassified'
              : !activityKnown ? 'activity_unknown'
                : lifetime === 0 ? 'never_started'
                  : 'idle_this_window';
      return {
        ...r,
        revenue: r.revenue == null ? null : round(r.revenue, 0),
        /* Beside `revenue`, never merged into it: one is what the trips say
           and the other is what the statement says, on different populations
           and different bases. The page chooses which to show and says which
           it showed. */
        statement_fares: r.statement_fares == null ? null : round(r.statement_fares, 0),
        statement_fare_periods: r.statement_fare_periods ?? 0,
        /* ZERO WHERE WE LOOKED, NULL WHERE WE COULD NOT.
           ─────────────────────────────────────────────────────────────
           The `ever` CTE only produces a row for somebody who has a trip, so
           these three arrive null for everybody who has none — and the page
           printed "—" in Trips ever, First drove and Last drove for 75 people
           it had itself just labelled NEVER DRIVEN. The category is the
           assertion "this person has taken no trip"; the column beside it said
           we did not know. One of the two had to be wrong, and it was the
           column: `lifetime === 0` is what put them in that category.

           So a lifetime count of zero is REPORTED as zero wherever this
           product can actually see the person's work — which is exactly the
           activityKnown test the category above already runs — and stays null
           for the 31 people whose only platform we collect no trips for, where
           "no trips" would be a claim about a feed we do not have. The two
           dates stay null either way: there is no day to name. */
        lifetime_trips: r.lifetime_trips != null ? r.lifetime_trips
          : (activityKnown ? 0 : null),
        payout: r.payout == null ? null : Number(r.payout),
        payout_days: r.payout_days ?? 0,
        km: r.km == null ? null : round(r.km, 0),
        category,
        // A car attached to somebody who cannot drive it.
        blocked_everywhere: blocked,
        activity_known: activityKnown,
        holding_vehicle_while_blocked: !!(blocked && (r.plates || []).length),
        days_since_last_trip: r.last_ever
          ? Math.floor((Date.now() - Date.parse(r.last_ever)) / 864e5) : null,
      };
    });

    const count = (c) => people.filter((x) => x.category === c).length;
    res.json({
      window: [from, to],
      people,
      totals: {
        people: people.length,
        working: count('working'),
        idle_this_window: count('idle_this_window'),
        never_started: count('never_started'),
        in_pipeline: count('in_pipeline'),
        blocked: count('blocked'),
        // People no provider described in a word we recognise. Counted, so the
        // gap is visible rather than absorbed into a neighbouring category.
        unclassified: count('unclassified'),
        // People whose platforms we hold no trips for. Their output is not
        // zero — it is unobserved, and the two must not share a number.
        activity_unknown: count('activity_unknown'),
        holding_vehicle_while_blocked: people.filter((x) => x.holding_vehicle_while_blocked).length,
        multi_platform: people.filter((x) => (x.platforms || []).length > 1).length,
      },
      platforms_with_trips: [...withTrips].sort(),
      /* What the fleet chip narrowed on. driver_platform_state.fleet_id is the
         credential set that collected a standing, not the fleet somebody
         drives for, and treating the two as one returned the Bolt roster for
         &fleet=egari. */
      fleet_basis: fleet
        ? 'People who took a booking for this fleet inside the window, plus anyone with no '
          + 'booking at all whose platform standing was collected under this fleet\'s '
          + 'credentials — for them it is the only fleet we hold.'
        : null,
      caveat: 'Platform accounts are folded into one person by name, because no provider shares an '
        + 'id with another. The accounts column shows how many were folded, so the join can be '
        + 'checked rather than trusted.'
        + (withTrips.size
          /* Channel names as the dashboard writes them; this sentence is read
             beside a Platforms column that has always said Uber, not uber. */
          ? ` Trip history exists for ${[...withTrips].sort().map(CHANNEL_LABEL).join(', ')} only; `
            + 'a driver on any other '
            + 'platform has their output reported as unobserved rather than as zero.'
          : ' No platform has any trip history, so no output can be observed at all.'),
    });
  }));

  /* The raw standing per platform, for a page that wants to show the
     disagreement rather than the fold. */
  app.get('/api/roster/states', wrap(async (req, res) => {
    const [, , platform, fleet] = range(req);
    const byState = await q(
      `SELECT platform, state, state_raw, count(*)::int n,
              count(*) FILTER (WHERE plate IS NOT NULL)::int with_vehicle
       FROM driver_platform_state
       WHERE ($1::text IS NULL OR platform = $1) AND ($2::text IS NULL OR fleet_id = $2)
       GROUP BY 1, 2, 3 ORDER BY platform, n DESC`, [platform, fleet]);
    const [freshness] = await q(
      `SELECT min(observed_at) oldest, max(observed_at) newest, count(*)::int rows
       FROM driver_platform_state`);
    res.json({
      by_state: byState,
      // A roster nobody has refreshed is a roster about the past.
      oldest_observation: freshness?.oldest || null,
      newest_observation: freshness?.newest || null,
      rows: freshness?.rows ?? 0,
      /* Two different gaps that both arrive as `unknown`, and only one of them
         is a mapping problem:
           - the provider sent a word we do not recognise  -> add it to the map
           - the provider sent no state at all             -> nothing to map,
             and the roster row still carries the useful fact that this person
             is on the books.
         Reporting them together made fourteen Yango drivers look like a
         classification failure when the summary endpoint simply does not
         return a status. */
      unrecognised_words: byState.filter((r) => r.state === 'unknown' && r.state_raw != null)
        .map((r) => ({ platform: r.platform, word: r.state_raw, n: r.n })),
      no_state_reported: byState.filter((r) => r.state === 'unknown' && r.state_raw == null)
        .map((r) => ({ platform: r.platform, n: r.n })),
    });
  }));
}
