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
const CANON = `regexp_replace(
  btrim(regexp_replace(lower(coalesce(full_name, '')), '\\s+', ' ', 'g')),
  '(\\m\\w+)( \\1)+', '\\1', 'g')`;

export function rosterRoutes(app, { q, wrap, range }) {
  /* One row per person, with every platform standing they hold and what they
     drove inside the window. */
  app.get('/api/roster', wrap(async (req, res) => {
    const [from, to, platform, fleet] = range(req);
    const p = [from, to, platform, fleet];

    const rows = await q(
      `WITH s AS (
         SELECT ${CANON} AS person, platform, driver_ext_id, full_name, state, state_raw,
                state_reason, plate, vehicle_ext_id, score, can_earn, observed_at
         FROM driver_platform_state
         WHERE ($3::text IS NULL OR platform = $3) AND ($4::text IS NULL OR fleet_id = $4)
           AND coalesce(btrim(full_name), '') <> ''
       ),
       -- Work inside the window, by the same folded name.
       w AS (
         SELECT ${CANON.replace(/full_name/g, 'driver_name')} AS person,
                count(*)::int trips,
                count(*) FILTER (WHERE outcome = 'completed')::int completed,
                sum(price) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary) AS revenue,
                sum(distance_km) FILTER (WHERE has_distance) AS km,
                max(requested_at) AS last_trip,
                array_agg(DISTINCT platform) AS platforms_worked
         FROM trip_ext
         WHERE local_day BETWEEN $1::date AND $2::date AND is_booking
           AND ($4::text IS NULL OR fleet_id = $4)
           AND coalesce(btrim(driver_name), '') <> ''
         GROUP BY 1
       ),
       -- Has this person EVER driven, on any platform, at any time? The
       -- difference between "quiet this month" and "never started".
       ever AS (
         SELECT ${CANON.replace(/full_name/g, 'driver_name')} AS person,
                min(requested_at) AS first_trip, max(requested_at) AS last_ever,
                count(*)::int lifetime_trips
         FROM trip WHERE coalesce(btrim(driver_name), '') <> '' GROUP BY 1
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
              bool_and(s.can_earn = false) AS blocked_everywhere,
              max(s.score) AS score,
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
      /* Categories, in the order the claims get weaker.

         `bool_or` returns NULL only when EVERY platform declined to say — which
         is what an unrecognised state produces. Filing that person as "not yet
         able to earn" asserts something about their employment that no provider
         actually said, so it gets a category of its own. This is the difference
         between reporting a gap in our knowledge and inventing a fact. */
      const blocked = r.blocked_everywhere === true;
      const category = (r.can_earn_anywhere == null && !blocked)
        ? 'unclassified'
        : lifetime === 0
          ? (r.can_earn_anywhere ? 'never_started' : 'in_pipeline')
          : blocked ? 'blocked'
            : r.trips === 0 ? 'idle_this_window' : 'working';
      return {
        ...r,
        revenue: r.revenue == null ? null : round(r.revenue, 0),
        km: r.km == null ? null : round(r.km, 0),
        category,
        // A car attached to somebody who cannot drive it.
        blocked_everywhere: blocked,
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
        holding_vehicle_while_blocked: people.filter((x) => x.holding_vehicle_while_blocked).length,
        multi_platform: people.filter((x) => (x.platforms || []).length > 1).length,
      },
      caveat: 'Platform accounts are folded into one person by name, because no provider shares an '
        + 'id with another. The `accounts` column shows how many were folded, so the join can be '
        + 'checked rather than trusted.',
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
      unknown_states: byState.filter((r) => r.state === 'unknown')
        .map((r) => ({ platform: r.platform, word: r.state_raw, n: r.n })),
    });
  }));
}
