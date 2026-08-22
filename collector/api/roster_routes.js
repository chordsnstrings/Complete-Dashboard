import { personFold, JOIN_TRIP } from './custody_sql.js';
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
      `WITH s AS (
         SELECT ${CANON} AS person, platform, driver_ext_id, full_name, state, state_raw,
                state_reason, plate, vehicle_ext_id, score, can_earn, observed_at
         FROM driver_platform_state
         WHERE ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR fleet_id = $4)
           AND coalesce(btrim(full_name), '') <> ''
       ),
       -- Work inside the window, by the same folded name.
       /* The stored fold, via the base table. Computed per row this was the
          roster's cost over a wide window — 37 seconds across the full record —
          and it is the same expression, so the same answer. Every column is
          qualified because the join puts two of each in scope. */
       w AS (
         SELECT t.person_key AS person,
                count(*)::int trips,
                count(*) FILTER (WHERE n.outcome = 'completed')::int completed,
                sum(n.price) FILTER (WHERE n.price IS NOT NULL AND NOT n.is_complimentary) AS revenue,
                sum(n.distance_km) FILTER (WHERE n.has_distance) AS km,
                max(n.requested_at) AS last_trip,
                array_agg(DISTINCT n.platform) AS platforms_worked
         FROM trip_ext n ${JOIN_TRIP}
         WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking
           AND ($4::text IS NULL OR n.fleet_id = $4)
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
       )
       SELECT s.person,
              max(s.full_name) AS name,
              count(*)::int AS accounts,
              array_agg(DISTINCT s.platform ORDER BY s.platform) AS platforms,
              array_agg(DISTINCT s.state ORDER BY s.state) AS states,
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
              max(w.km) AS km,
              max(w.last_trip) AS last_trip,
              max(e.lifetime_trips) AS lifetime_trips,
              min(e.first_trip) AS first_trip,
              max(e.last_ever) AS last_ever
       FROM s
       LEFT JOIN w    ON w.person = s.person
       LEFT JOIN ever e ON e.person = s.person
       GROUP BY s.person
       ORDER BY trips DESC, name`, p);

    const people = rows.map((r) => {
      const lifetime = r.lifetime_trips || 0;
      // Can we even see this person's work? If every platform they are on is
      // one we hold no trips for, a lifetime count of zero says nothing.
      const activityKnown = (r.platforms || []).some((pl) => withTrips.has(pl));
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
      const category = blocked ? 'blocked'
        : r.cannot_earn_anywhere === true ? 'in_pipeline'
          : r.can_earn_anywhere == null ? 'unclassified'
            : !activityKnown ? 'activity_unknown'
              : lifetime === 0 ? 'never_started'
                : r.trips === 0 ? 'idle_this_window' : 'working';
      return {
        ...r,
        revenue: r.revenue == null ? null : round(r.revenue, 0),
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
      caveat: 'Platform accounts are folded into one person by name, because no provider shares an '
        + 'id with another. The accounts column shows how many were folded, so the join can be '
        + 'checked rather than trusted.'
        + (withTrips.size
          ? ` Trip history exists for ${[...withTrips].sort().join(', ')} only; a driver on any other `
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
