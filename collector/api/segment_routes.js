/* Occupancy segments as addressable pages, with the evidence attached.
   ──────────────────────────────────────────────────────────────────────────
   An "unexplained trip" is an accusation. Until this file existed it lived in
   a modal: you clicked a bar, read a hardcoded English sentence keyed on the
   verdict, and had no way to send anyone the thing you were looking at. Four
   separate click paths all opened the same modal, and none of them had an
   address.

   Worse, the sentence was asserted rather than shown. `reconcile` already
   records WHY it decided what it decided — which channels it could read, how
   far away the nearest booking was, whether a telemetry gap falls inside the
   window — and none of that reached the screen. A verdict nobody can falsify
   is not evidence; it is an opinion with a database behind it.

   So: `/api/segments` is a filterable list that also returns its own facets
   (so the page can offer the next filter rather than making you guess), and
   `/api/segment` is one interval with everything that was true around it —
   every booking on every channel within an hour either side, not just the
   nearest; the driver who actually held the car that day; and the raw fixes. */
import { custodyNames, custodyRefs, peopleCount } from './custody_sql.js';
import { areaOf } from './analytics_routes.js';

export function segmentRoutes(app, { q, wrap, range, DAYWIN }) {
  const VERDICTS = ['unauthorized', 'authorized', 'sensor_suspect', 'partial', 'stationary', 'unverifiable', 'pending'];

  /* A reason is a SHAPE, not a string.
     ─────────────────────────────────────────────────────────────────────────
     The reason facet grouped on the raw text, so every matched segment was its
     own "reason": production reported facet_totals {reason: 109, reason_shown:
     20} over a menu whose rows were "matched uber trip fa66c89c-…", "matched
     hotel trip 6a8aa7d1…" and four separate "telemetry clock is {2339, 2903,
     2439, 2438} min behind wall time". Four shapes carried meaning and 109
     filters were offered, of which 89 could not even be selected because the
     list stops at 20.

     The trip id and the minute count are what vary; the sentence is what
     means something. Both are replaced before grouping, and the skew comes
     back as a NUMBER on each segment so a page can name the affected plates
     instead of leaving 37 unverifiable segments discoverable only by reading
     four table rows. */
  /* Two id shapes, not one. Uber and Bolt trip ids are 32-hex UUIDs; the hotel
     channel issues 24-hex Mongo ObjectIds with no dashes, which the UUID
     pattern cannot match. Those fell through to the digits-to-N rule below and
     came out as "matched hotel trip NaNdbNbNbaNdbfNccN" — a different mangling
     per id, so every hotel match became its own reason and the menu this code
     exists to collapse was fragmented again, twelve of its twenty rows
     matching a single segment each. */
  const REASON_SHAPE = (col) => `regexp_replace(
    regexp_replace(coalesce(${col}, '(no reason recorded)'),
                   '[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}|[0-9a-f]{24}',
                   '<trip id>', 'gi'),
    '[0-9]+', 'N', 'g')`;
  const SKEW = (col) => `(regexp_match(${col}, '([0-9]+) min behind'))[1]::int`;

  const SEG_COLS = `o.plate, o.fleet_id, o.started_at, o.ended_at, o.duration_min, o.distance_km,
     o.top_speed, o.fixes, o.max_gap_min, o.ignition_ratio, o.verdict,
     o.matched_platform, o.matched_trip_id, o.low_confidence, o.unavailable_sources,
     o.verdict_reason, o.nearest_platform, o.nearest_trip_id, o.nearest_gap_min,
     o.channels_checked, o.boundary_gap_min,
     ${SKEW('o.verdict_reason')} AS clock_skew_min,
     o.start_lat, o.start_lng, o.end_lat, o.end_lng,
     to_char((o.started_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS local_day`;

  /* The driver who held the car ON THE DAY OF THE SEGMENT, from the shared
     definition — the same one the day page and the playbook use, so the person
     an unauthorised journey names is the person the to-do list chases. */
  const SEG_DAY = `(o.started_at AT TIME ZONE 'Asia/Dubai')::date`;
  const CUSTODY = custodyNames('o.plate', SEG_DAY);
  const CUSTODY_IDS = custodyRefs('o.plate', SEG_DAY);

  /* ── the list, with the facets that make the next click obvious ────────── */
  app.get('/api/segments', wrap(async (req, res) => {
    const [from, to] = range(req);
    const verdict = req.query.verdict && req.query.verdict !== 'all' ? String(req.query.verdict) : null;
    const plate = req.query.plate ? String(req.query.plate) : null;
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : null;
    const driver = req.query.driver ? String(req.query.driver) : null;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 300));

    // $1..$2 window, $3 verdict, $4 plate, $5 day, $6 driver — all optional and
    // all nullable, so one statement serves every filter combination rather
    // than five near-identical ones drifting apart.
    const p = [from, to, verdict, plate, day, driver];
    const WHERE = `${DAYWIN('o.started_at')}
       AND ($3::text IS NULL OR o.verdict = $3)
       AND ($4::text IS NULL OR o.plate = $4)
       AND ($5::text IS NULL OR (o.started_at AT TIME ZONE 'Asia/Dubai')::date = $5::date)
       AND ($6::text IS NULL OR ${CUSTODY} ILIKE '%' || $6 || '%')`;

    const [rows, byVerdict, byPlate, byDay, byReason, [tot], [facetN]] = await Promise.all([
      q(`SELECT ${SEG_COLS}, ${CUSTODY} AS drivers, ${CUSTODY_IDS} AS driver_refs
          FROM occupancy_segment o WHERE ${WHERE}
          ORDER BY o.started_at DESC LIMIT ${limit}`, p),
      // Facets are computed over the WINDOW, not over the current filter —
      // a verdict count that changes when you pick a verdict tells you nothing
      // about what else is there.
      q(`SELECT o.verdict AS key, count(*)::int n,
                round(sum(o.distance_km)::numeric,1) km
          FROM occupancy_segment o WHERE ${DAYWIN('o.started_at')}
          GROUP BY 1 ORDER BY n DESC`, [from, to]),
      // Plate-level, so the per-segment custody subquery cannot ride along —
      // grouping by it would return one row per segment wearing a plate label.
      q(`SELECT plate AS key, count(*)::int n,
                count(*) FILTER (WHERE verdict='unauthorized')::int unauthorized,
                round(sum(distance_km) FILTER (WHERE verdict='unauthorized')::numeric,1) unauth_km
          FROM occupancy_segment o WHERE ${DAYWIN('started_at')}
          GROUP BY 1 ORDER BY unauthorized DESC, n DESC LIMIT 40`, [from, to]),
      q(`SELECT to_char((o.started_at AT TIME ZONE 'Asia/Dubai')::date,'YYYY-MM-DD') AS key,
                count(*)::int n,
                count(*) FILTER (WHERE o.verdict='unauthorized')::int unauthorized
          FROM occupancy_segment o WHERE ${DAYWIN('o.started_at')}
          GROUP BY 1 ORDER BY 1`, [from, to]),
      // What the reconciler actually said. This is the honest version of the
      // hardcoded sentence: a reason with no rows is a reason we never give.
      q(`SELECT ${REASON_SHAPE('o.verdict_reason')} AS key, count(*)::int n,
                min(o.verdict) AS verdict,
                max(${SKEW('o.verdict_reason')})::int AS max_skew_min,
                count(*) FILTER (WHERE ${SKEW('o.verdict_reason')} IS NOT NULL)::int skewed
          FROM occupancy_segment o WHERE ${DAYWIN('o.started_at')}
          GROUP BY 1 ORDER BY n DESC LIMIT 20`, [from, to]),
      q(`SELECT count(*)::int n,
                count(*) FILTER (WHERE o.low_confidence)::int low_confidence,
                count(*) FILTER (WHERE o.verdict_reason IS NULL)::int unreasoned
          FROM occupancy_segment o WHERE ${WHERE}`, p),
      // How many facet values exist, against how many the lists above show.
      q(`SELECT count(DISTINCT o.plate)::int plates,
                count(DISTINCT ${REASON_SHAPE('o.verdict_reason')})::int reasons
          FROM occupancy_segment o WHERE ${DAYWIN('o.started_at')}`, [from, to]),
    ]);

    res.json({
      rows,
      total: tot?.n ?? 0,
      truncated: (tot?.n ?? 0) > rows.length,
      low_confidence: tot?.low_confidence ?? 0,
      unreasoned: tot?.unreasoned ?? 0,
      filter: { verdict, plate, day, driver },
      facets: { verdict: byVerdict, plate: byPlate, day: byDay, reason: byReason },
      /* A facet list is a set of filters somebody can choose. Two of these are
         capped — the 40 busiest plates and the 20 commonest reasons — and a
         truncated facet list is not a shorter menu, it is a filter that cannot
         be selected at all: the plate you are looking for is simply absent and
         the page gives no hint that it exists. The counts say how many there
         are so the page can offer a search rather than implying the menu is
         complete. */
      facet_totals: {
        plate: facetN?.plates ?? (byPlate || []).length,
        reason: facetN?.reasons ?? (byReason || []).length,
        plate_shown: (byPlate || []).length,
        reason_shown: (byReason || []).length,
      },
      known_verdicts: VERDICTS,
      /* A tracker whose clock is two days out cannot be compared against a
         booking at all, and 37 unverifiable segments in production were
         exactly that. Named here so the page can say which cars, rather than
         leaving it to be inferred from four rows of a facet list. */
      clock_skew: {
        segments: rows.filter((r) => r.clock_skew_min != null).length,
        plates: [...new Set(rows.filter((r) => r.clock_skew_min != null).map((r) => r.plate))],
        max_min: rows.reduce((a, r) => Math.max(a, r.clock_skew_min || 0), 0) || null,
      },
    });
  }));

  /* ── one interval, with everything that was true around it ─────────────── */
  app.get('/api/segment', wrap(async (req, res) => {
    const plate = String(req.query.plate || '');
    const at = String(req.query.at || '');
    if (!plate || !at) return res.status(400).json({ error: 'plate and at are required' });
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return res.status(400).json({ error: 'at must be a timestamp' });

    const [seg] = await q(
      `SELECT ${SEG_COLS}, ${CUSTODY} AS drivers, ${CUSTODY_IDS} AS driver_refs
       FROM occupancy_segment o WHERE o.plate = $1 AND o.started_at = $2::timestamptz`, [plate, at]);
    if (!seg) return res.status(404).json({ error: 'no segment starts at that instant for that plate' });

    const [track, nearby, driverTrips, sameDay, custody, neighbours] = await Promise.all([
      // The fixes themselves. Capped, because a stuck sensor can produce a
      // segment hours long and nobody reads 400 rows of GPS.
      q(`SELECT captured_at, lat, lng, speed, seat_occupied, ignition, status
          FROM telemetry_snapshot
          WHERE plate = $1 AND captured_at BETWEEN $2::timestamptz - interval '5 minutes'
                                              AND coalesce($3::timestamptz, $2::timestamptz + interval '4 hours') + interval '5 minutes'
          ORDER BY captured_at LIMIT 400`, [plate, seg.started_at, seg.ended_at]),

      /* Every booking on every channel within an hour either side — for THIS
         VEHICLE. The reconciler keeps only the nearest; that is enough to
         decide, and not enough to argue with. Thirteen accusations each
         showing a nearest booking exactly 240 minutes away is a clock skew,
         and you can only see that shape if you can see the neighbours.

         Four hours either side rather than one, because four hours is the
         actual observed skew — a window narrower than the bug cannot show the
         bug, and that is the whole reason this query exists. */
      q(`SELECT platform, external_id, driver_name, driver_ext_id, requested_at, ended_at,
                status, outcome, price, distance_km, pickup_addr, dropoff_addr,
                round(extract(epoch from (requested_at - $2::timestamptz))/60)::int gap_min
          FROM trip_norm
          WHERE plate = $1
            AND requested_at BETWEEN $2::timestamptz - interval '4 hours'
                                 AND coalesce($3::timestamptz, $2::timestamptz) + interval '4 hours'
          ORDER BY requested_at LIMIT 40`, [plate, seg.started_at, seg.ended_at]),

      /* And the same question asked of the PERSON rather than the car. A
         driver who was demonstrably on a booking in someone else's vehicle at
         that moment did not take this one, and no per-plate query can see it. */
      q(`SELECT t.platform, t.external_id, t.plate, t.driver_name, t.driver_ext_id,
                t.requested_at, t.ended_at, t.status, t.outcome, t.price,
                round(extract(epoch from (t.requested_at - $2::timestamptz))/60)::int gap_min
          FROM trip_norm t
          WHERE t.driver_name IS NOT NULL
            AND t.driver_name IN (SELECT DISTINCT v.driver_name FROM vehicle_driver_day v
                                   WHERE v.plate = $1
                                     AND v.day = ($2::timestamptz AT TIME ZONE 'Asia/Dubai')::date
                                     AND v.driver_name IS NOT NULL)
            AND t.requested_at BETWEEN $2::timestamptz - interval '90 minutes'
                                   AND coalesce($3::timestamptz, $2::timestamptz) + interval '90 minutes'
          ORDER BY t.requested_at LIMIT 40`, [plate, seg.started_at, seg.ended_at]),

      // What else this vehicle did on the same day — the flag in context.
      q(`SELECT ${SEG_COLS}
          FROM occupancy_segment o
          WHERE o.plate = $1
            AND (o.started_at AT TIME ZONE 'Asia/Dubai')::date = ($2::timestamptz AT TIME ZONE 'Asia/Dubai')::date
          ORDER BY o.started_at`, [plate, seg.started_at]),

      q(`SELECT day, driver_name, driver_ext_id, platform, trips
          FROM vehicle_driver_day
          WHERE plate = $1 AND day BETWEEN ($2::timestamptz AT TIME ZONE 'Asia/Dubai')::date - 2
                                       AND ($2::timestamptz AT TIME ZONE 'Asia/Dubai')::date + 2
          ORDER BY day`, [plate, seg.started_at]),

      /* Was the collector even reading every channel that day? A verdict of
         "no booking anywhere" reached while a revenue channel was down is a
         statement about our collection, not about the driver. `low_confidence`
         already flags this; showing which sources actually wrote rows that day
         lets someone check it rather than trust it. */
      q(`SELECT platform, count(*)::int rows_that_day
          FROM trip_norm
          WHERE (requested_at AT TIME ZONE 'Asia/Dubai')::date
                = ($1::timestamptz AT TIME ZONE 'Asia/Dubai')::date
          GROUP BY 1 ORDER BY 1`, [seg.started_at]),
    ]);

    // Speed profile straight off the fixes: a "trip" that never exceeded
    // walking pace is a parked car with a warm seat, whatever the verdict says.
    const speeds = track.map((r) => Number(r.speed)).filter((n) => Number.isFinite(n));
    const moving = speeds.filter((s) => s > 3).length;

    res.json({
      segment: seg,
      track,
      profile: {
        fixes: track.length,
        moving_fixes: moving,
        moving_pct: track.length ? Math.round((moving / track.length) * 100) : null,
        max_speed: speeds.length ? Math.max(...speeds) : null,
        median_speed: speeds.length
          ? [...speeds].sort((a, b) => a - b)[Math.floor(speeds.length / 2)] : null,
        // A gap larger than two poll intervals means we did not observe the
        // whole window, whatever the verdict claims to know about it.
        observed: seg.max_gap_min == null ? null : seg.max_gap_min <= 11,
      },
      nearby_vehicle_trips: nearby,
      nearby_driver_trips: driverTrips,
      same_day_segments: sameDay,
      custody,
      channels_that_day: neighbours,
    });
  }));
}

/* One cell of the weekday × hour heatmap, as a page.
   ──────────────────────────────────────────────────────────────────────────
   The heatmap has always been the most-used chart on the demand page and the
   least useful, because clicking a cell opened a modal that said "Slot-level
   trip list requires per-trip drill; showing driver ranking for the range" and
   then showed the ranking for the WHOLE range — the same table whichever cell
   you clicked. A dark cell told you Tuesday 19:00 was busy and nothing else.

   A slot is an operational unit: it is when you roster people. So the question
   is not "how many trips" but "is this hour covered, by whom, on which
   platform, and is it worth covering" — and every one of those is answerable
   from data already in the table. */
export function slotRoutes(app, { q, wrap, range }) {
  app.get('/api/slot', wrap(async (req, res) => {
    const [from, to] = range(req);
    const dow = Number(req.query.dow), hour = Number(req.query.hour);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return res.status(400).json({ error: 'dow must be 0-6' });
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return res.status(400).json({ error: 'hour must be 0-23' });

    // Every query below is over bookings only. A telematics journey has no
    // platform, no fare and no outcome, so folding it in here would inflate
    // "trips in this slot" with rows that cannot answer any of the questions.
    const SLOT = `is_booking AND local_dow = $3 AND local_hour = $4
                  AND local_day BETWEEN $1::date AND $2::date`;
    const p = [from, to, dow, hour];

    const [[head], drivers, platforms, corridors, occurrences, peers, settle, outcome] = await Promise.all([
      q(`SELECT count(*)::int trips,
                count(DISTINCT local_day)::int days_seen,
                ${peopleCount()}::int drivers,
                count(DISTINCT plate)::int vehicles,
                count(DISTINCT platform)::int platforms,
                round(avg(distance_km) FILTER (WHERE has_distance)::numeric,1) avg_km,
                round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue,
                count(*) FILTER (WHERE has_fare)::int priced_n,
                round(100.0*count(*) FILTER (WHERE outcome='completed')
                      /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) completion_pct
          FROM trip_norm WHERE ${SLOT}`, p),

      /* Who actually covers this hour. The point of the page: an hour served by
         two people is an hour that breaks when one of them is off. */
      q(`SELECT driver_ext_id, max(driver_name) driver_name, count(*)::int trips,
                count(DISTINCT local_day)::int days,
                string_agg(DISTINCT platform, ', ') platforms,
                round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue,
                round(100.0*count(*) FILTER (WHERE outcome='completed')
                      /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) completion_pct
          FROM trip_norm WHERE ${SLOT} AND driver_ext_id IS NOT NULL
          GROUP BY 1 ORDER BY trips DESC LIMIT 40`, p),

      q(`SELECT platform, count(*)::int trips,
                round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue,
                count(*) FILTER (WHERE has_fare)::int priced_n
          FROM trip_norm WHERE ${SLOT} GROUP BY 1 ORDER BY trips DESC`, p),

      /* Where the work in this hour actually starts — the rostering question is
         "put a car where", not just "put a car on".

         Split on the DASH, not on a comma. Every channel returns a formatted
         address of the form "01 Cluster E - Al Thanyah Fifth - Dubai - UAE",
         which contains no comma at all, so split_part(addr, ',', 1) returned
         the whole string: twelve bars covering 29 of a slot's 118 trips, the
         largest of them "(no address)", and the rest whole raw addresses that
         could never group with each other. The expression that does this
         correctly already existed in api/analytics_routes.js and is imported
         rather than copied, so #slot and #corridors cannot drift into two
         different taxonomies for the same place. */
      q(`SELECT coalesce(${areaOf('pickup_addr')}, '(no address)') AS place,
                count(*)::int trips
          FROM trip_norm WHERE ${SLOT} AND pickup_addr IS NOT NULL
          GROUP BY 1 ORDER BY trips DESC LIMIT 12`, p),

      /* Every occurrence of this slot in the window, so the average has a
         spread behind it. One Friday with 40 trips and eleven with 2 is a
         different business from twelve Fridays with 5. */
      q(`SELECT to_char(local_day,'YYYY-MM-DD') AS day, count(*)::int trips,
                round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue
          FROM trip_norm WHERE ${SLOT} GROUP BY 1 ORDER BY 1`, p),

      /* The same hour on every other weekday, so "busy" has something to be
         busy against. Its own parameter list: reusing `p` left $3 unreferenced,
         and Postgres refuses a statement whose parameter it cannot type. */
      q(`SELECT local_dow AS dow, count(*)::int trips,
                count(DISTINCT local_day)::int days
          FROM trip_norm
          WHERE is_booking AND local_hour = $3 AND local_day BETWEEN $1::date AND $2::date
          GROUP BY 1 ORDER BY 1`, [from, to, hour]),

      q(`SELECT settlement_class, count(*)::int trips,
                round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue
          FROM trip_ext WHERE ${SLOT} GROUP BY 1 ORDER BY trips DESC`, p),

      q(`SELECT coalesce(outcome,'(not reported)') AS outcome, count(*)::int trips
          FROM trip_norm WHERE ${SLOT} GROUP BY 1 ORDER BY trips DESC`, p),
    ]);

    /* How many times this weekday even OCCURRED in the window. Without it, a
       slot seen on 3 of 4 Tuesdays and a slot seen on 3 of 12 look identical,
       and the second is a coverage hole wearing an average. */
    const [{ n: possible } = { n: 0 }] = await q(
      `SELECT count(*)::int n FROM generate_series($1::date, $2::date, interval '1 day') d
       WHERE extract(dow from d)::int = $3::int`, [from, to, dow]);

    /* Whether the window holds any bookings at all, anywhere. Two very
       different states both produce zero here and they must not read alike:
       a fleet that worked 5,000 bookings and none in this hour is a coverage
       hole worth staffing, while a window with no data in it is not a finding
       about this hour — it is the absence of any finding. Reported as 0.0
       trips per Tuesday, the second is a claim nothing supports. */
    const [{ n: measured } = { n: 0 }] = await q(
      `SELECT count(*)::int n FROM trip_norm
       WHERE is_booking AND local_day BETWEEN $1::date AND $2::date`, [from, to]);

    const [drvTot] = await q(
      `SELECT count(DISTINCT driver_ext_id)::int n FROM trip_norm
       WHERE ${SLOT} AND driver_ext_id IS NOT NULL`, p);

    res.json({
      slot: { dow, hour },
      headline: {
        ...head,
        possible_days: possible,
        window_trips: measured,
        // Trips per occurrence of this weekday, not per day the slot happened
        // to fire. The second flatters an hour nobody covers.
        trips_per_occurrence: possible && measured ? +((head?.trips || 0) / possible).toFixed(1) : null,
        coverage_pct: possible && measured ? Math.round(((head?.days_seen || 0) / possible) * 100) : null,
        revenue_per_priced_trip: head?.priced_n
          ? +(Number(head.revenue) / head.priced_n).toFixed(2) : null,
      },
      drivers,
      /* 40 of a slot's 62 drivers were listed with nothing saying so, on a page
         whose whole subject is how few people cover an hour. */
      drivers_total: drvTot?.n ?? drivers.length,
      drivers_shown: drivers.length,
      drivers_truncated: (drvTot?.n ?? 0) > drivers.length,
      platforms, corridors, occurrences, peers, settlement: settle, outcome,
    });
  }));
}
