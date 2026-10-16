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

/* The shared person fold and the join that makes it reachable from trip_norm.
   trip_norm is a view frozen before person_key existed (sql/schema_v18.sql), so
   a query over it that needs the stored key joins the base table — written once
   in api/custody_sql.js because it has been needed in five places now and each
   copy is a chance to join on the wrong pair of columns. */
import { peopleCountStored, JOIN_TRIP } from './custody_sql.js';
import { TRIP_RUN_SQL } from './run_kinds.js';
/* What a day's unpriced bookings will be worth — the day page's own rule, so
   the revenue hour by hour here adds up to the day page's "≈ trip value" for
   the same day and cannot disagree with it. */
import { PRICING_LOOKBACK_DAYS, PRICING_RATE_SQL, projectUnpriced, spreadByHour } from './projection_sql.js';

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

    const [totals, uncut, hours, platforms, paidByPlat, stmtByPlat, people, gaps, fresh,
      hourPeople, hourMoney, rateA, rateB] = await Promise.all([
      q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE n.is_booking)::int bookings,
                count(*) FILTER (WHERE n.outcome = 'completed')::int completed,
                count(*) FILTER (WHERE n.outcome = 'not_completed')::int cancelled,
                count(*) FILTER (WHERE NOT n.is_booking)::int telematics,
                round(sum(n.distance_km) FILTER (WHERE n.has_distance AND n.is_booking)::numeric, 0) km,
                sum(n.price) FILTER (WHERE n.has_fare) fares,
                count(*) FILTER (WHERE n.has_fare)::int priced,
                /* PEOPLE OUT, not platform accounts.
                   ──────────────────────────────────────────────────────────
                   THE DEFECT. This is the "Drivers out" tile
                   (api/public/compare.js:197) and it counted driver_ext_id. On
                   the part-day slice production served — 2026-09-16 cut at
                   13:15, 282 bookings — raw and folded both came to 90, so the
                   sample showed no gap; the same population measured whole-day
                   on /api/day is 112 accounts against 94 people. A tile that
                   happens to agree on a quiet afternoon is not a tile that is
                   right.

                   It is also internally inconsistent by construction, which is
                   the part that does not need a measurement. The driver LIST
                   on this same response is keyed on coalesce(driver_ext_id,
                   'name:' || driver_name) — one row per ACCOUNT, deliberately,
                   and its comment says so — so the page counted accounts in
                   the tile and listed accounts under it while calling the tile
                   drivers. Now the tile counts people and driver_accounts
                   carries the figure the list is one row per.

                   trip_norm is a VIEW created in sql/schema_v18.sql, BEFORE
                   person_key existed, and a view's SELECT t.* is frozen at
                   creation — so it cannot expose the column and the fold needs
                   JOIN_TRIP, the shared join api/custody_sql.js exports for
                   exactly this. It is cheap here and nowhere near a hot query:
                   the predicate is local_day IN ($1, $2), two index scans on
                   trip_local_day_idx, and the join key is trip's primary key so
                   it is 1:1 and cannot multiply a row. */
                ${peopleCountStored('t.person_key', 'n.driver_ext_id')}
                  FILTER (WHERE n.is_booking AND n.driver_ext_id IS NOT NULL)::int drivers,
                count(DISTINCT n.driver_ext_id) FILTER (WHERE n.is_booking AND n.driver_ext_id IS NOT NULL)::int driver_accounts,
                count(DISTINCT n.plate) FILTER (WHERE nullif(btrim(n.plate), '') IS NOT NULL)::int vehicles,
                min(n.requested_at) FILTER (WHERE n.is_booking) first_at,
                max(n.requested_at) FILTER (WHERE n.is_booking) last_at,
                round((sum(extract(epoch FROM (n.ended_at - n.requested_at)))
                       FILTER (WHERE n.is_booking AND n.ended_at IS NOT NULL) / 60)::numeric, 0) on_trip_min,
                count(*) FILTER (WHERE n.is_booking AND n.ended_at IS NOT NULL)::int timed
           FROM trip_norm n ${JOIN_TRIP} WHERE ${WHERE} GROUP BY 1`, p),
      /* The same figures with no cut at all, so the page can say what the
         earlier day FINISHED on beside what it had reached by this hour. */
      q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day,
                count(*) FILTER (WHERE n.is_booking)::int bookings,
                round(sum(n.distance_km) FILTER (WHERE n.has_distance AND n.is_booking)::numeric, 0) km,
                sum(n.price) FILTER (WHERE n.has_fare) fares,
                /* Folded with the cut figure above, and it HAS to be: this pair
                   exists so a reader can compare what a day had reached by this
                   hour against what it finished on. Folding one and not the
                   other would make the two incomparable, which is the entire
                   purpose of the pair. Same JOIN_TRIP, same two-day predicate,
                   same cost. */
                ${peopleCountStored('t.person_key', 'n.driver_ext_id')}
                  FILTER (WHERE n.is_booking AND n.driver_ext_id IS NOT NULL)::int drivers,
                count(DISTINCT n.driver_ext_id) FILTER (WHERE n.is_booking AND n.driver_ext_id IS NOT NULL)::int driver_accounts
           FROM trip_norm n ${JOIN_TRIP}
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
                sum(n.price) FILTER (WHERE n.has_fare) fares,
                /* How many of the channel's rows the fare covers. Uber's fares
                   arrive with the weekly payments-report walk, so a day's Uber
                   fares can cover a handful of its bookings — "AED 235 over 311
                   bookings" read as a collapse with nothing to say it was a
                   coverage gap (plan §4 #compare). */
                count(*) FILTER (WHERE n.has_fare)::int priced
           FROM trip_norm n WHERE ${WHERE} GROUP BY 1, 2`, p),
      /* THE MONEY THE BIGGEST CHANNEL DOES REPORT.
         ─────────────────────────────────────────────────────────────────
         The Fares column above is sum(trip.price) and Uber's export carries no
         price at all — so on a day that is 89% Uber the By channel table's only
         money column described a tenth of the work, and read "—" against the
         rows that mattered. The page's own header already says this in words;
         it had nothing to put beside the sentence.

         driver_payout_day spreads each weekly statement across the days it
         covers, so a single day carries a share of it. That share is an
         ESTIMATE — nobody earns a seventh of their week each day — and it is
         labelled as one. It is the right estimate for "what did this day bring
         in" and exactly the wrong one for "what did this driver earn on
         Tuesday", which is why it is aggregated per channel and never per
         person here. Beside the fares, never added to them. */
      q(`SELECT to_char(day, 'YYYY-MM-DD') AS day, platform,
                round(sum(earnings)::numeric, 2) AS paid
           FROM driver_payout_day
          WHERE day IN ($1::date, $2::date)
            AND ($3::text IS NULL OR fleet_id = $3)
            AND ($4::text IS NULL OR platform = $4)
          GROUP BY 1, 2`, pw),
      /* And the operator's own import, which is the only money that exists for
         the months the platform APIs no longer serve — driver_payout_day is
         built from the Uber earner breakdown and reaches back about 192 days.
         Read beside the payout, never summed with it. */
      q(`SELECT to_char(day, 'YYYY-MM-DD') AS day, platform,
                round(sum(net)::numeric, 2) AS statement_net
           FROM driver_statement_day
          WHERE day IN ($1::date, $2::date) AND source = 'ledger' AND net IS NOT NULL
            AND ($3::text IS NULL OR fleet_id = $3)
            AND ($4::text IS NULL OR platform = $4)
          GROUP BY 1, 2`, pw),
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
           FROM collection_run WHERE finished_at IS NOT NULL AND ${TRIP_RUN_SQL}
          GROUP BY 1 ORDER BY 1`, []),
      /* PEOPLE AT WORK, HOUR BY HOUR.
         ─────────────────────────────────────────────────────────────────
         The operator, 2026-10-15: "#compare should have hourly active driver,
         and hourly revenue as well." Active here is what the Drivers out tile
         already means — a person with a booking — read per Dubai hour of the
         request, on every channel, folded on the stored person key exactly as
         the tile is (the same JOIN_TRIP, the same fallback to the account), so
         an hour cannot count one person twice for driving two accounts.

         A person on a ninety-minute airport run is counted in the hour the
         booking was requested, not in every hour it ran: the bookings chart
         beside it buckets the same way, and "people who took work in this
         hour" is a figure the two charts can be read against. Summed over the
         day it overcounts — somebody working eight hours is in eight of them
         — which is why the tile, not this, says how many people drove.

         Uncut, like the bookings hours: an hour today has not reached is drawn
         absent by the page, never as zero. */
      q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day, n.local_hour AS hour,
                ${peopleCountStored('t.person_key', 'n.driver_ext_id')}
                  FILTER (WHERE n.is_booking AND n.driver_ext_id IS NOT NULL)::int drivers
           FROM trip_norm n ${JOIN_TRIP}
          WHERE n.local_day IN ($1::date, $2::date)
            AND ($3::text IS NULL OR n.fleet_id = $3)
            AND ($4::text IS NULL OR n.platform = $4)
          GROUP BY 1, 2`, pw),
      /* MONEY, HOUR BY HOUR.
         ─────────────────────────────────────────────────────────────────
         Fares on record are only part of a recent day: Uber prices its trips
         from a report fetched hours behind the ride, so at 14:00 the morning's
         Uber bookings can be priced and the last two hours' not — and an hour
         chart of fares alone draws the fleet collapsing into the present,
         every afternoon. So each hour carries its fares AND its share of the
         day page's estimate for the bookings not priced yet
         (api/projection_sql.js), the share drawn as an estimate.

         Decided on the rows this page is showing. With no fleet chip that is
         the whole fleet, and the hours add up to the day page's trip value for
         the same day. With one, it is that fleet's rows valued at that fleet's
         own rate: a reader whose access covers one fleet has ?fleet= rewritten
         by the gate (api/access/middleware.js), and an estimate decided over
         both fleets would carry the other fleet's fares into their page in
         the rate and in the floor. So the two fleets' pages need not add up to
         the unfiltered one to the dirham, and each says only what its own
         records hold.

         `by_cut` splits each hour at the page's cut, so "revenue by this
         minute" is like for like on both days. A row with no request time
         falls outside the cut, as it does in every cut figure above. */
      q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day, n.local_hour AS hour, n.platform,
                coalesce((extract(hour FROM n.requested_at AT TIME ZONE 'Asia/Dubai') * 60
                  + extract(minute FROM n.requested_at AT TIME ZONE 'Asia/Dubai')) < $3::int, false) AS by_cut,
                count(*) FILTER (WHERE n.is_booking)::int bookings,
                count(*) FILTER (WHERE n.is_booking AND n.has_fare)::int priced,
                count(*) FILTER (WHERE n.has_fare)::int priced_all,
                count(*) FILTER (WHERE n.outcome = 'completed')::int completed,
                count(*) FILTER (WHERE n.outcome = 'completed' AND n.is_complimentary)::int complimentary,
                /* Finished, chargeable and still without a fare: the bookings
                   an unrated channel leaves unvalued. A cancellation without a
                   fee or a ride given away is not money missing. */
                count(*) FILTER (WHERE n.is_booking AND n.outcome = 'completed'
                                   AND NOT n.is_complimentary AND NOT n.has_fare)::int pending,
                sum(n.price) FILTER (WHERE n.has_fare) fares
           FROM trip_ext n
          WHERE n.local_day IN ($1::date, $2::date)
            AND ($4::text IS NULL OR n.fleet_id = $4)
            AND ($5::text IS NULL OR n.platform = $5)
          GROUP BY 1, 2, 3, 4`, p),
      /* What a booking on each channel was worth over the settled days behind
         each of the two days — the day page's rate, on this page's fleet. */
      q(PRICING_RATE_SQL, [a, PRICING_LOOKBACK_DAYS, fleet]),
      q(PRICING_RATE_SQL, [b, PRICING_LOOKBACK_DAYS, fleet]),
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

    /* The channel set is the union of the three sources, not the trip table
       alone: a channel can be paid on a day whose bookings we did not collect,
       and dropping that row would report the money as absent rather than the
       bookings as missing. */
    const moneyOf = (rows, name, day, key) => {
      const r = rows.find((x) => x.platform === name && x.day === day);
      return r ? num(r[key]) : null;
    };
    const plats = [...new Set([...platforms, ...paidByPlat, ...stmtByPlat].map((r) => r.platform))]
      .map((name) => {
        const A = platforms.find((r) => r.platform === name && r.day === a) || {};
        const B = platforms.find((r) => r.platform === name && r.day === b) || {};
        const side = (row, day) => ({
          n: row.n || 0, completed: row.completed || 0, cancelled: row.cancelled || 0,
          km: num(row.km), fares: num(row.fares), priced: row.priced || 0,
          /* Beside the fares, never inside them: a fare is what the rider was
             charged and a payout is what reached the fleet after commission. */
          paid: moneyOf(paidByPlat, name, day, 'paid'),
          statement_net: moneyOf(stmtByPlat, name, day, 'statement_net'),
        });
        return {
          platform: name,
          a: side(A, a),
          b: side(B, b),
          d: (A.n || 0) - (B.n || 0),
        };
      }).sort((x, y) => (y.a.n + y.b.n) - (x.a.n + x.b.n));

    /* One day's money by hour. The channel totals the decision is made on
       are in the shape buildDay reads off trip_ext — `priced` and `revenue`
       over every row, `bookings` over bookings — so with no fleet chip the
       parts projected here are the parts the day page projects for the day. */
    const r2 = (v) => Math.round(v * 100) / 100;
    const hourMoneyOf = (day, rateRows) => {
      const rows = hourMoney.filter((r) => r.day === day).map((r) => ({ ...r, h: r.hour }));
      const chan = new Map();
      for (const r of rows) {
        const c = chan.get(r.platform) || { platform: r.platform, bookings: 0, priced: 0, completed: 0, complimentary: 0, revenue: null };
        c.bookings += r.bookings; c.priced += r.priced_all; c.completed += r.completed; c.complimentary += r.complimentary;
        if (r.fares != null) c.revenue = (c.revenue || 0) + Number(r.fares);
        chan.set(r.platform, c);
      }
      const { projected, unrated } = projectUnpriced([...chan.values()], rateRows);
      const est = spreadByHour(projected, rows);
      const estByCut = spreadByHour(projected, rows, (r) => r.by_cut);
      const fares = Array(24).fill(0);
      let faresByCut = 0;
      for (const r of rows) {
        if (r.fares == null) continue;
        fares[r.hour] += Number(r.fares);
        if (r.by_cut) faresByCut += Number(r.fares);
      }
      /* Finished, chargeable bookings with no price on a channel that has no
         settled day to value them by. Absent with a reason: they add nothing
         to the hours they sit in, and the page says how many there are rather
         than letting those hours read as quiet. Cancellations and rides given
         away are not counted — no money is missing for them. */
      const unvalued = Array(24).fill(0);
      const unratedSet = new Set(unrated.map((u) => u.platform));
      for (const r of rows) {
        if (unratedSet.has(r.platform)) unvalued[r.hour] += r.pending;
      }
      const sum = (xs) => xs.reduce((x, v) => x + v, 0);
      const estimated = sum(est);
      return {
        fares, est, unvalued,
        basis: {
          on_record: r2(sum(fares)),
          estimated: estimated ? r2(estimated) : null,
          revenue: r2(sum(fares) + estimated),
          /* Up to the page's cut, both halves, so the caption compares like
             with like on a day that has not finished. */
          on_record_by_cut: r2(faresByCut),
          estimated_by_cut: estimated ? r2(sum(estByCut)) : null,
          revenue_by_cut: r2(faresByCut + sum(estByCut)),
          parts: projected.map((x) => ({ platform: x.platform, bookings: x.bookings, pending: x.pending,
            per_booking: x.per_booking, days: x.days, value: x.value })),
          unvalued_bookings: sum(unvalued) || null,
          unvalued_platforms: unrated.map((u) => u.platform),
          lookback_days: PRICING_LOOKBACK_DAYS,
        },
      };
    };
    const MA = hourMoneyOf(a, rateA), MB = hourMoneyOf(b, rateB);
    const hourly = [...Array(24).keys()].map((h) => {
      const A = hours.find((r) => r.hour === h && r.day === a) || {};
      const B = hours.find((r) => r.hour === h && r.day === b) || {};
      const PA = hourPeople.find((r) => r.hour === h && r.day === a) || {};
      const PB = hourPeople.find((r) => r.hour === h && r.day === b) || {};
      return { hour: h, a: A.bookings || 0, b: B.bookings || 0,
        a_cancelled: A.cancelled || 0, b_cancelled: B.cancelled || 0,
        /* People with a booking requested in this hour, folded. */
        a_drivers: PA.drivers || 0, b_drivers: PB.drivers || 0,
        /* Fares on record, the estimate for the hour's unpriced bookings, and
           the two added — the estimate never hidden inside the total. */
        a_revenue: r2(MA.fares[h] + MA.est[h]), b_revenue: r2(MB.fares[h] + MB.est[h]),
        a_fares: r2(MA.fares[h]), b_fares: r2(MB.fares[h]),
        a_estimated: r2(MA.est[h]), b_estimated: r2(MB.est[h]),
        a_unvalued: MA.unvalued[h], b_unvalued: MB.unvalued[h],
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
      /* How each day's revenue hours were reached: the fares on record, the
         estimate and its working, and the bookings that could not be valued. */
      revenue_basis: {
        a: MA.basis, b: MB.basis,
        method: 'Fares on record, plus — for a channel whose completed work does not carry its price yet — '
          + 'each unpriced booking valued at what a booking on that channel was worth over the settled days '
          + `behind the day (up to ${PRICING_LOOKBACK_DAYS}), spread over the hours those bookings were requested in. `
          + (fleet ? 'Decided on this fleet’s own bookings and valued at its own rate.'
            : 'The same estimate the day page shows as its trip value.'),
      },
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
