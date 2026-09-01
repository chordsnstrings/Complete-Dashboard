/* Who is doing well, who is not, and what the difference actually looks like.
   ─────────────────────────────────────────────────────────────────────────
   Two pages over one week. The ranking lives in api/economics_routes.js
   already — this module exists for the part that ranking cannot show: a single
   person's week, day by day, with the places they worked and the hours they
   held the car.

   FOUR RULES, each of which was a wrong page before it was a rule.

   1. THE WEEK IS A COMPLETE WEEK. `days=7` includes today, and today is a few
      hours old at nine in the morning. Ranking people on a partial day puts
      whoever started early at the top. Both pages default to the last complete
      Monday-to-Sunday Dubai week and say which one they are showing.

   2. DAYS ARE DUBAI DAYS, FILTERED ON local_day. api/window.js:83 hands back
      bare timestamps against a UTC session, so a seven-day ask returns EIGHT
      Dubai days: it drops the 00:00–04:00 block of the first and leaks the
      last. This fleet's top driver has a median start hour of 01:04, so that
      is not a rounding error, it is his whole night shift moving between
      weeks. Every query here filters on trip_norm.local_day.

   3. MONEY IS NOT ONE NUMBER. api/income_sql.js chooses a basis per platform:
      hotel reports a fare (gross, what the property was charged), Uber reports
      a payout (net, after commission and after the cash the driver already
      took). Adding them ranks a hotel driver above an Uber driver who earned
      more. The per-platform split is returned with the basis NAMED so a page
      can show the parts rather than a blended total that means nothing.

   4. AN HOUR IS THREE DIFFERENT QUESTIONS. Logged in, dispatched, carrying
      someone. Uber reports none of them: hours_online is null for 232 of 241
      people. What we can measure is ON-TRIP, from the trips themselves, and
      that is what is returned — labelled as what it is, never as "online". */

export function performerRoutes(app, { q, wrap }) {
  const num = (v) => (v == null ? null : Number(v));
  const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

  /* The last complete Dubai week, Monday to Sunday. Monday because that is the
     grid Uber's own billing weeks use (sql/schema_v23.sql), so a week here and
     a payout period there describe the same seven days. */
  const lastCompleteWeek = () => {
    const now = new Date();
    const dubai = new Date(now.getTime() + 4 * 3600e3);
    const dow = (dubai.getUTCDay() + 6) % 7;               // 0 = Monday
    /* Noon, for the same reason the front end uses noon: this value has days
       added and subtracted from it and is then read back as a calendar date. */
    const thisMon = Date.UTC(dubai.getUTCFullYear(), dubai.getUTCMonth(), dubai.getUTCDate() - dow, 12);
    const from = new Date(thisMon - 7 * 864e5);
    const to = new Date(thisMon - 864e5);
    const iso = (d) => d.toISOString().slice(0, 10);
    return [iso(from), iso(to)];
  };

  const weekOf = (req) => {
    const w = req.query.week;
    if (/^\d{4}-\d{2}-\d{2}$/.test(w || '')) {
      const mon = new Date(`${w}T12:00:00Z`);
      const to = new Date(mon.getTime() + 6 * 864e5);
      return [w, to.toISOString().slice(0, 10)];
    }
    return lastCompleteWeek();
  };

  /* The area a booking started or ended in. The parser is the product's own
     (api/analytics_routes.js:41) and it is crude — the second dash-separated
     segment of a free-text address — so what it returns is offered as a
     grouping, never as a fact. The raw address is the record. */
  const AREA = (col) => `nullif(btrim(split_part(${col}, ' - ', 2)), '')`;

  app.get('/api/performer', wrap(async (req, res) => {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const [from, to] = weekOf(req);
    const p = [from, to, id];

    const [days, areas, hours, platforms, ids, gaps] = await Promise.all([
      /* The week, day by day. count(DISTINCT) nothing here — one row per Dubai
         day already — but the first and last request are what make a shift
         visible, and a shift is the thing these pages are about. */
      q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE n.is_booking)::int bookings,
                count(*) FILTER (WHERE n.outcome = 'completed')::int completed,
                count(*) FILTER (WHERE n.outcome = 'not_completed')::int cancelled,
                round(sum(n.distance_km) FILTER (WHERE n.has_distance)::numeric, 1) km,
                round(sum(n.price) FILTER (WHERE n.has_fare)::numeric, 2) fares,
                min(n.requested_at) first_trip, max(coalesce(n.ended_at, n.requested_at)) last_trip,
                array_remove(array_agg(DISTINCT n.plate), NULL) plates,
                array_agg(DISTINCT n.platform) platforms,
                /* On-trip seconds, from the trips. Only where the platform
                   reported an end: a NULL ended_at is an unknown duration, not
                   a zero-length trip, and summing it as zero would report a
                   driver who worked all day as having carried nobody. */
                sum(extract(epoch FROM (n.ended_at - n.requested_at)))
                  FILTER (WHERE n.ended_at IS NOT NULL AND n.ended_at > n.requested_at) AS on_trip_s,
                count(*) FILTER (WHERE n.ended_at IS NOT NULL AND n.ended_at > n.requested_at)::int timed
           FROM trip_norm n
          WHERE n.local_day BETWEEN $1::date AND $2::date
            AND n.driver_ext_id = $3 AND n.is_booking
          GROUP BY 1 ORDER BY 1`, p),

      q(`SELECT coalesce(${AREA('n.pickup_addr')}, '(unrecorded)') AS area,
                count(*) FILTER (WHERE n.pickup_addr IS NOT NULL)::int picked_up,
                count(*) FILTER (WHERE n.dropoff_addr IS NOT NULL AND
                       coalesce(${AREA('n.dropoff_addr')}, '(unrecorded)')
                       = coalesce(${AREA('n.pickup_addr')}, '(unrecorded)'))::int stayed
           FROM trip_norm n
          WHERE n.local_day BETWEEN $1::date AND $2::date
            AND n.driver_ext_id = $3 AND n.is_booking
          GROUP BY 1 ORDER BY 2 DESC LIMIT 25`, p),

      /* What the platform said about the driver's state, if anything. Uber
         writes DRIVER_STATUS_* into telemetry_snapshot keyed on the PLATE, so
         this is joined through the car the person actually held that day. It is
         a five-minute poll, not an event log: a session shorter than the
         interval leaves no trace, and the first observation is not a login. */
      q(`SELECT (ts.captured_at AT TIME ZONE 'Asia/Dubai')::date AS day,
                ts.status, count(*)::int n,
                min(ts.captured_at) first_seen, max(ts.captured_at) last_seen
           FROM telemetry_snapshot ts
           JOIN vehicle_driver_day vd
             ON vd.plate = ts.plate
            AND vd.day = (ts.captured_at AT TIME ZONE 'Asia/Dubai')::date
          WHERE ts.source = 'uber'
            AND (ts.captured_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
            AND vd.driver_ext_id = $3
          GROUP BY 1, 2 ORDER BY 1, 2`, p),

      /* Per platform, with the basis named. Never summed here. */
      q(`SELECT n.platform,
                /* The person's name, carried by the query that already reads
                   their rows rather than by a query of its own. Without it the
                   drill-down's own header could not name whose week it was, and
                   fell back to the first entry in the nav list — so one
                   person's week was titled "Unit economics". */
                max(n.driver_name) AS driver_name,
                count(*) FILTER (WHERE n.is_booking)::int bookings,
                round(sum(n.distance_km) FILTER (WHERE n.has_distance)::numeric, 0) km,
                round(sum(n.price) FILTER (WHERE n.has_fare)::numeric, 2) fares,
                count(*) FILTER (WHERE n.has_fare)::int priced
           FROM trip_norm n
          WHERE n.local_day BETWEEN $1::date AND $2::date
            AND n.driver_ext_id = $3 AND n.is_booking
          GROUP BY 1 ORDER BY 2 DESC`, p),

      q(`SELECT platform, driver_ext_id,
                round(sum(earnings)::numeric, 2) payout,
                count(DISTINCT day)::int payout_days,
                min(period_start) period_start, max(period_end) period_end
           FROM driver_payout_day
          WHERE day BETWEEN $1::date AND $2::date AND driver_ext_id = $3
          GROUP BY 1, 2`, p),

      /* The gaps BETWEEN bookings, which is where a driver's day actually goes.
         ─────────────────────────────────────────────────────────────────────
         Measured live on six drivers: the best of them spent 51% of his span
         not carrying anyone, the worst 92%. On-trip time alone cannot show
         that — a page reporting "1.7 hours on trip" says nothing about whether
         those hours came out of five or fifteen.

         lag() over the day, so the gap is from the END of one booking to the
         REQUEST of the next. coalesce(ended_at, requested_at) because a
         booking with no end time still happened and still occupies its slot;
         treating it as instantaneous is better than dropping the row and
         inventing one enormous gap that spans it.

         A NEGATIVE gap is a real event, not dirty data: a driver dispatched to
         the next rider before dropping the current one. Kept, and counted
         separately, because it is the signature of a busy corridor. */
      q(`WITH t AS (
           SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day, n.requested_at,
                  coalesce(n.ended_at, n.requested_at) AS ended_at
             FROM trip_norm n
            WHERE n.local_day BETWEEN $1::date AND $2::date
              AND n.driver_ext_id = $3 AND n.is_booking
         ), g AS (
           SELECT day,
                  extract(epoch FROM (requested_at
                    - lag(ended_at) OVER (PARTITION BY day ORDER BY requested_at))) AS gap_s
             FROM t
         )
         SELECT day,
                count(*) FILTER (WHERE gap_s IS NOT NULL)::int gaps,
                /* OVERLAPS is a reserved word — it is SQL's own interval
                   operator — so as a bare column alias it is a syntax error at
                   the NEXT token, which points at the line after the mistake.
                   Quoted, it is just a name. */
                count(*) FILTER (WHERE gap_s < 0)::int AS "overlaps",
                round((sum(gap_s) FILTER (WHERE gap_s > 0) / 60)::numeric, 0) wait_min,
                round((max(gap_s) FILTER (WHERE gap_s > 0) / 60)::numeric, 0) longest_min,
                round((percentile_cont(0.5) WITHIN GROUP (ORDER BY gap_s)
                       FILTER (WHERE gap_s > 0) / 60)::numeric, 0) median_min
           FROM g GROUP BY 1 ORDER BY 1`, p),
    ]);

    const onTrip = days.reduce((a, d) => a + (num(d.on_trip_s) || 0), 0);
    const timed = days.reduce((a, d) => a + (d.timed || 0), 0);
    const booked = days.reduce((a, d) => a + (d.bookings || 0), 0);

    res.json({
      week: [from, to],
      days: days.map((d) => {
        /* Both sides are TEXT from to_char, not Dates. Postgres hands a
           `date` back as a JS Date and String(Date) is "Mon Aug 25 2026 …" —
           two Dates compare fine that way, but only by luck, and the moment
           one side changes type every day silently stops matching and every
           waiting figure reads as null. */
        const gp = gaps.find((x) => x.day === d.day) || {};
        return {
        ...d,
        wait_min: num(gp.wait_min), longest_wait_min: num(gp.longest_min),
        median_wait_min: num(gp.median_min), overlaps: gp.overlaps || 0,
        km: num(d.km), fares: num(d.fares),
        on_trip_min: d.on_trip_s == null ? null : Math.round(num(d.on_trip_s) / 60),
        /* Elapsed is first-request to last-dropoff. It is NOT a shift: it
           contains every gap. It is here because the ratio of on-trip to
           elapsed is the one utilisation figure this data can honestly carry. */
        elapsed_min: d.first_trip && d.last_trip
          ? Math.round((new Date(d.last_trip) - new Date(d.first_trip)) / 60000) : null,
      }; }),
      areas,
      platform_status: hours,
      driver_ext_id: req.query.id || null,
      name: (platforms.find((x) => x.driver_name) || {}).driver_name || null,
      platforms: platforms.map((x) => ({ ...x, km: num(x.km), fares: num(x.fares) })),
      payouts: ids.map((x) => ({ ...x, payout: num(x.payout) })),
      on_trip_min: Math.round(onTrip / 60),
      wait_min: gaps.reduce((a, x) => a + (num(x.wait_min) || 0), 0),
      overlaps: gaps.reduce((a, x) => a + (x.overlaps || 0), 0),
      /* Stated, not hidden: a duration average over the trips that HAVE one. */
      timed_bookings: timed,
      bookings: booked,
      duration_coverage_pct: booked ? Math.round((timed / booked) * 100) : null,
      note: timed < booked
        ? `${booked - timed} of ${booked} bookings carry no end time, so on-trip minutes are `
          + 'measured over the rest. Uber reports a dropoff time on most trips and none on the others.'
        : null,
    });
  }));

  /* The weeks a page may offer. Only complete ones, newest first — an
     incomplete week in a ranking picker is a trap, not an option.

     EVERY week the bookings reach back to, not a fixed twenty-six. The count
     was a horizon nobody had chosen: trip_norm starts 2025-04-05 and this
     stopped at 2026-03-02, so forty-seven weeks — around 309,000 bookings and
     AED 2.4m — had no address any picker on the three performer pages could
     produce. What ends the walk is first_day. The 520 is a runaway guard, ten
     years of it, and applies only once there is a first day to walk toward;
     with no bookings at all the endpoint still offers the last twenty-six so
     an empty database does not also produce an empty control. */
  app.get('/api/performer/weeks', wrap(async (_req, res) => {
    const [, lastTo] = lastCompleteWeek();
    const rows = await q(
      `SELECT min(local_day) AS first_day, max(local_day) AS last_day
         FROM trip_norm WHERE is_booking`, []);
    const first = rows[0]?.first_day ? new Date(rows[0].first_day) : null;
    const out = [];
    let cur = new Date(`${lastTo}T12:00:00Z`);
    for (let i = 0; i < (first ? 520 : 26) && (!first || cur >= first); i++) {
      const mon = new Date(cur.getTime() - 6 * 864e5);
      out.push({ week: mon.toISOString().slice(0, 10), to: cur.toISOString().slice(0, 10) });
      cur = new Date(cur.getTime() - 7 * 864e5);
    }
    /* Named so the picker can say how far back it goes rather than making the
       reader scroll to the end of the list to find out. A `date` column comes
       back from pg as a Date and String(Date) is "Sat Apr 05 2025 …". */
    const day = (v) => (v == null ? null
      : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)));
    res.json({
      weeks: out,
      latest_complete: out[0]?.week || null,
      first_booking: day(rows[0]?.first_day),
      last_booking: day(rows[0]?.last_day),
    });
  }));
}
