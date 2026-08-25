/* Two days, side by side, cut at the same minute.
   ──────────────────────────────────────────────────────────────────────────
   "Compare yesterday and today" sounds like two queries and a subtraction. It
   is not, and the reason is the whole point of this module: TODAY IS NOT OVER.

   At 11:00 Dubai, today holds seven hours of work and yesterday holds
   twenty-four. Subtract them and every driver on the fleet is down 70%, every
   platform is collapsing, and the page says so in red. That page is worse than
   no page — it manufactures an alarm every morning and cries wolf by lunchtime.

   So both days are cut at the same Dubai wall-clock minute. When one of them
   is today, the cut is NOW: today's seven hours are compared against
   yesterday's first seven hours, and a fall means somebody actually did less.
   The cut is returned, named, and shown on the page — a comparison that hides
   its own basis is a comparison nobody should trust.

   The uncut totals for the earlier day are returned alongside, because
   "yesterday finished on 41" is a real thing to know while looking at "by this
   hour yesterday had 22". Both numbers, labelled, rather than a choice made
   for the reader.

   THREE FURTHER RULES.

   1. DAYS ARE DUBAI DAYS. Filtered on trip_norm.local_day, never on a UTC
      timestamp range — this fleet's busiest driver starts at 01:04, and a UTC
      day boundary cuts his shift in half and moves the halves to two different
      days.

   2. A DRIVER WHO WORKED ONE DAY AND NOT THE OTHER IS THE FINDING. The pivot
      is a FULL OUTER union of both days' drivers, so somebody who drove
      yesterday and has not appeared today comes back as a row with a zero,
      not as an absence. That row is the one worth acting on before lunch.

   3. WAITING IS MEASURED FROM THE GAPS, NOT SUBTRACTED. Elapsed minus on-trip
      goes negative the moment two bookings overlap, and on this fleet they
      overlap constantly. Both days' waiting is summed gap by gap, over the
      positive gaps only, and the overlaps are counted separately. */

export function compareRoutes(app, { q, wrap }) {
  const num = (v) => (v == null ? null : Number(v));
  const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))
    && !Number.isNaN(new Date(`${v}T12:00:00Z`).getTime());

  /* Dubai is UTC+4 all year — no DST — so the offset is a constant and the
     calendar date is read off a shifted instant at noon, never at midnight:
     midnight arithmetic lands on the wrong side of the boundary the moment
     anything adds or subtracts a day from it. */
  const dubaiNow = () => new Date(Date.now() + 4 * 3600e3);
  const dubaiToday = () => dubaiNow().toISOString().slice(0, 10);
  const dayBefore = (d) => new Date(new Date(`${d}T12:00:00Z`).getTime() - 864e5)
    .toISOString().slice(0, 10);

  /* Minutes since Dubai midnight, right now. This is the cut when either day
     under comparison is today. Rounded UP to the next quarter hour so the
     figure does not shuffle between two page loads a minute apart and read as
     movement in the data. */
  const nowMinutes = () => {
    const d = dubaiNow();
    const m = d.getUTCHours() * 60 + d.getUTCMinutes();
    return Math.min(1440, Math.ceil(m / 15) * 15);
  };

  app.get('/api/compare', wrap(async (req, res) => {
    const a = isDay(req.query.a) ? req.query.a : dubaiToday();
    const b = isDay(req.query.b) ? req.query.b : dayBefore(a);
    if (a === b) return res.status(400).json({ error: 'a and b must be different days' });

    const today = dubaiToday();
    const touchesToday = a === today || b === today;
    /* `cut=full` is the reader overriding the like-for-like rule — a deliberate
       choice to see a partial day against a whole one, which is legitimate
       when the question is "how much of yesterday's total have we reached". */
    const asked = String(req.query.cut || 'auto');
    const cut = asked === 'full' ? 1440
      : /^\d+$/.test(asked) ? Math.max(15, Math.min(1440, Number(asked)))
        : touchesToday ? nowMinutes() : 1440;

    const fleet = req.query.fleet || null;
    const platform = req.query.platform || null;
    const p = [a, b, cut, fleet, platform];
    /* The uncut queries take their own array rather than ignoring $3. A
       parameter a statement never mentions has no inferable type, and Postgres
       refuses the whole statement with "could not determine data type of
       parameter $3" — which reads like a cast bug and is actually an unused
       placeholder. */
    const pw = [a, b, fleet, platform];

    /* Repeated at every call site rather than wrapped in a view, because a
       view would freeze this expression the day somebody changes the cut.
       local_day is the indexed expression (sql/schema.sql's trip_local_day_idx
       and its partial siblings), so IN (a, b) is two index scans, not a seq
       scan of a quarter-million rows. */
    const WHERE = `n.local_day IN ($1::date, $2::date)
        AND (extract(hour FROM n.requested_at AT TIME ZONE 'Asia/Dubai') * 60
             + extract(minute FROM n.requested_at AT TIME ZONE 'Asia/Dubai')) < $3::int
        AND ($4::text IS NULL OR n.fleet_id = $4)
        AND ($5::text IS NULL OR n.platform = $5)`;

    const [totals, uncut, hours, platforms, people, gaps, fresh] = await Promise.all([
      q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE n.is_booking)::int bookings,
                count(*) FILTER (WHERE n.outcome = 'completed')::int completed,
                count(*) FILTER (WHERE n.outcome = 'not_completed')::int cancelled,
                count(*) FILTER (WHERE NOT n.is_booking)::int telematics,
                round(sum(n.distance_km) FILTER (WHERE n.has_distance AND n.is_booking)::numeric, 0) km,
                sum(n.price) FILTER (WHERE n.has_fare) fares,
                count(*) FILTER (WHERE n.has_fare)::int priced,
                count(DISTINCT n.driver_ext_id) FILTER (WHERE n.is_booking AND n.driver_ext_id IS NOT NULL)::int drivers,
                count(DISTINCT n.plate) FILTER (WHERE nullif(btrim(n.plate), '') IS NOT NULL)::int vehicles,
                min(n.requested_at) FILTER (WHERE n.is_booking) first_at,
                max(n.requested_at) FILTER (WHERE n.is_booking) last_at,
                round((sum(extract(epoch FROM (n.ended_at - n.requested_at)))
                       FILTER (WHERE n.is_booking AND n.ended_at IS NOT NULL) / 60)::numeric, 0) on_trip_min,
                count(*) FILTER (WHERE n.is_booking AND n.ended_at IS NOT NULL)::int timed
           FROM trip_norm n WHERE ${WHERE} GROUP BY 1`, p),
      /* The same figures with no cut at all, so the page can say what the
         earlier day FINISHED on beside what it had reached by this hour. */
      q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE n.is_booking)::int bookings,
                round(sum(n.distance_km) FILTER (WHERE n.has_distance AND n.is_booking)::numeric, 0) km,
                sum(n.price) FILTER (WHERE n.has_fare) fares,
                count(DISTINCT n.driver_ext_id) FILTER (WHERE n.is_booking AND n.driver_ext_id IS NOT NULL)::int drivers
           FROM trip_norm n
          WHERE n.local_day IN ($1::date, $2::date)
            AND ($3::text IS NULL OR n.fleet_id = $3)
            AND ($4::text IS NULL OR n.platform = $4)
          GROUP BY 1`, pw),
      q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day, n.local_hour AS hour,
                count(*) FILTER (WHERE n.is_booking)::int bookings,
                count(*) FILTER (WHERE n.outcome = 'not_completed')::int cancelled
           FROM trip_norm n
          WHERE n.local_day IN ($1::date, $2::date)
            AND ($3::text IS NULL OR n.fleet_id = $3)
            AND ($4::text IS NULL OR n.platform = $4)
          GROUP BY 1, 2 ORDER BY 2`, pw),
      q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day, n.platform,
                count(*)::int n,
                count(*) FILTER (WHERE n.outcome = 'completed')::int completed,
                count(*) FILTER (WHERE n.outcome = 'not_completed')::int cancelled,
                round(sum(n.distance_km) FILTER (WHERE n.has_distance)::numeric, 0) km,
                sum(n.price) FILTER (WHERE n.has_fare) fares
           FROM trip_norm n WHERE ${WHERE} GROUP BY 1, 2`, p),
      /* Keyed on the account, not the display name: two people share a name on
         this fleet and one person appears under three spellings. The name is
         carried for the label only. */
      q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day,
                coalesce(nullif(btrim(n.driver_ext_id), ''), 'name:' || n.driver_name) AS pk,
                max(n.driver_ext_id) driver_ext_id,
                max(n.driver_name) driver_name,
                max(n.fleet_id) fleet_id,
                count(*) FILTER (WHERE n.is_booking)::int bookings,
                count(*) FILTER (WHERE n.outcome = 'completed')::int completed,
                count(*) FILTER (WHERE n.outcome = 'not_completed')::int cancelled,
                round(sum(n.distance_km) FILTER (WHERE n.has_distance AND n.is_booking)::numeric, 0) km,
                sum(n.price) FILTER (WHERE n.has_fare) fares,
                min(n.requested_at) FILTER (WHERE n.is_booking) first_trip,
                max(n.requested_at) FILTER (WHERE n.is_booking) last_trip,
                round((sum(extract(epoch FROM (n.ended_at - n.requested_at)))
                       FILTER (WHERE n.is_booking AND n.ended_at IS NOT NULL) / 60)::numeric, 0) on_trip_min,
                array_agg(DISTINCT n.platform) platforms,
                array_remove(array_agg(DISTINCT n.plate), NULL) plates
           FROM trip_norm n
          WHERE ${WHERE} AND (n.driver_ext_id IS NOT NULL OR n.driver_name IS NOT NULL)
          GROUP BY 1, 2`, p),
      /* The gaps between one dropoff and the next request, per person per day.
         A negative gap is a real dispatch — the next rider assigned before the
         current one was dropped — so it is counted, not clamped, and waiting
         is summed over the positive gaps only. */
      q(`WITH t AS (
           SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day,
                  coalesce(nullif(btrim(n.driver_ext_id), ''), 'name:' || n.driver_name) AS pk,
                  n.requested_at,
                  coalesce(n.ended_at, n.requested_at) AS ended_at
             FROM trip_norm n
            WHERE ${WHERE} AND n.is_booking
              AND (n.driver_ext_id IS NOT NULL OR n.driver_name IS NOT NULL)
         ), g AS (
           SELECT day, pk,
                  extract(epoch FROM (requested_at
                    - lag(ended_at) OVER (PARTITION BY day, pk ORDER BY requested_at))) AS gap_s
             FROM t
         )
         SELECT day, pk,
                /* OVERLAPS is a reserved word — it is SQL's own interval
                   operator — so as a bare column alias it is a syntax error at
                   the NEXT token, which points at the line after the mistake.
                   Quoted, it is just a name. */
                count(*) FILTER (WHERE gap_s < 0)::int AS "overlaps",
                round((sum(gap_s) FILTER (WHERE gap_s > 0) / 60)::numeric, 0) wait_min,
                round((max(gap_s) FILTER (WHERE gap_s > 0) / 60)::numeric, 0) longest_min
           FROM g GROUP BY 1, 2`, p),
      /* Whether today is thin because nobody drove or because nobody
         collected. Without this the page cannot tell a quiet morning from a
         dead collector, and those two need opposite responses. */
      q(`SELECT source, max(finished_at) AS last_run,
                max(finished_at) FILTER (WHERE status = 'ok') AS last_ok,
                sum(rows_written) FILTER (WHERE finished_at > now() - interval '24 hours')::int rows_24h
           FROM collection_run WHERE finished_at IS NOT NULL
          GROUP BY 1 ORDER BY 1`, []),
    ]);

    /* The day comes back as TEXT, not as a date.
       ─────────────────────────────────────────────────────────────────────
       Postgres hands a `date` to the driver as a JS Date, and String(Date) is
       "Mon Aug 25 2026 …" — so `String(row.day).slice(0, 10)` is "Mon Aug 2",
       which matches neither day being compared. Every row then fell through to
       the else branch and landed on the SAME side: both days reported one
       day's numbers, the other reported zero, and the page said the fleet had
       stopped working. Formatting in SQL removes the question. */
    const row = (rows, day) => rows.find((r) => r.day === day) || {};
    const shape = (r) => ({
      bookings: r.bookings || 0, completed: r.completed || 0, cancelled: r.cancelled || 0,
      telematics: r.telematics || 0, km: num(r.km), fares: num(r.fares), priced: r.priced || 0,
      drivers: r.drivers || 0, vehicles: r.vehicles || 0,
      first_at: r.first_at || null, last_at: r.last_at || null,
      on_trip_min: num(r.on_trip_min), timed: r.timed || 0,
    });

    /* One row per person across BOTH days, so somebody who stopped shows up as
       a zero rather than as a missing row. Sorted by the size of the change,
       because the top of this table should be what moved. */
    const byPk = new Map();
    const gapOf = (day, pk) => gaps.find((g) => g.day === day && g.pk === pk) || {};
    people.forEach((r) => {
      const pk = r.pk;
      if (!byPk.has(pk)) {
        byPk.set(pk, {
          pk, driver_ext_id: r.driver_ext_id || null, driver_name: r.driver_name || null,
          fleet_id: r.fleet_id || null, a: null, b: null,
        });
      }
      const cur = byPk.get(pk);
      cur.driver_ext_id = cur.driver_ext_id || r.driver_ext_id || null;
      cur.driver_name = cur.driver_name || r.driver_name || null;
      const g = gapOf(r.day, pk);
      const side = {
        bookings: r.bookings || 0, completed: r.completed || 0, cancelled: r.cancelled || 0,
        km: num(r.km), fares: num(r.fares),
        first_trip: r.first_trip || null, last_trip: r.last_trip || null,
        on_trip_min: num(r.on_trip_min),
        wait_min: num(g.wait_min), longest_wait_min: num(g.longest_min),
        overlaps: g.overlaps || 0,
        platforms: r.platforms || [], plates: r.plates || [],
      };
      if (r.day === a) cur.a = side; else cur.b = side;
    });
    const ZERO = { bookings: 0, completed: 0, cancelled: 0, km: null, fares: null,
      first_trip: null, last_trip: null, on_trip_min: null, wait_min: null,
      longest_wait_min: null, overlaps: 0, platforms: [], plates: [] };
    const drivers = [...byPk.values()].map((r) => {
      const A = r.a || ZERO, B = r.b || ZERO;
      return {
        ...r, a: A, b: B,
        /* The cars they held across both days, at the top level rather than
           only inside each side. A driver who changed vehicle between the two
           days is one of the few explanations this data can actually offer for
           a drop, and it should be visible in the row rather than reachable
           only by opening the person. */
        plates: [...new Set([...(A.plates || []), ...(B.plates || [])])],
        platforms: [...new Set([...(A.platforms || []), ...(B.platforms || [])])],
        worked_a: Boolean(r.a), worked_b: Boolean(r.b),
        d_bookings: A.bookings - B.bookings,
        d_km: (A.km || 0) - (B.km || 0),
        d_on_trip_min: (A.on_trip_min || 0) - (B.on_trip_min || 0),
        d_wait_min: (A.wait_min || 0) - (B.wait_min || 0),
      };
    }).sort((x, y) => Math.abs(y.d_bookings) - Math.abs(x.d_bookings)
      || Math.abs(y.d_km) - Math.abs(x.d_km));

    const plats = [...new Set(platforms.map((r) => r.platform))].map((name) => {
      const A = platforms.find((r) => r.platform === name && r.day === a) || {};
      const B = platforms.find((r) => r.platform === name && r.day === b) || {};
      return {
        platform: name,
        a: { n: A.n || 0, completed: A.completed || 0, cancelled: A.cancelled || 0, km: num(A.km), fares: num(A.fares) },
        b: { n: B.n || 0, completed: B.completed || 0, cancelled: B.cancelled || 0, km: num(B.km), fares: num(B.fares) },
        d: (A.n || 0) - (B.n || 0),
      };
    }).sort((x, y) => (y.a.n + y.b.n) - (x.a.n + x.b.n));

    const hourly = [...Array(24).keys()].map((h) => {
      const A = hours.find((r) => r.hour === h && r.day === a) || {};
      const B = hours.find((r) => r.hour === h && r.day === b) || {};
      return { hour: h, a: A.bookings || 0, b: B.bookings || 0,
        a_cancelled: A.cancelled || 0, b_cancelled: B.cancelled || 0,
        past_cut: h * 60 >= cut };
    });

    const cutLabel = `${String(Math.floor(cut / 60)).padStart(2, '0')}:${String(cut % 60).padStart(2, '0')}`;
    res.json({
      days: [a, b],
      is_today: { a: a === today, b: b === today },
      cut_minutes: cut,
      cut_label: cutLabel,
      cut_mode: cut >= 1440 ? 'full' : (asked === 'auto' || asked === '' ? 'now' : 'fixed'),
      /* The basis, in the words the page prints. A comparison that does not
         state where it cut is a comparison the reader has to take on faith. */
      cut_note: cut >= 1440
        ? 'Both days counted in full.'
        : `Both days counted up to ${cutLabel} Dubai, so a fall means less work done by the same hour — not a day that has not finished yet.`,
      totals: { a: shape(row(totals, a)), b: shape(row(totals, b)) },
      full_day: { a: row(uncut, a), b: row(uncut, b) },
      hours: hourly,
      platforms: plats,
      drivers,
      /* Named, not just counted: "3 people who drove yesterday have not started
         today" is a list to work through, and the list is the useful part. */
      stopped: drivers.filter((r) => r.worked_b && !r.worked_a)
        .map((r) => ({ driver_ext_id: r.driver_ext_id, driver_name: r.driver_name,
          bookings: r.b.bookings, plates: r.b.plates || [] })),
      started: drivers.filter((r) => r.worked_a && !r.worked_b)
        .map((r) => ({ driver_ext_id: r.driver_ext_id, driver_name: r.driver_name,
          bookings: r.a.bookings, plates: r.a.plates || [] })),
      collectors: fresh.map((r) => ({ source: r.source, last_run: r.last_run,
        last_ok: r.last_ok, rows_24h: r.rows_24h || 0 })),
      fleet,
      platform,
    });
  }));
}
