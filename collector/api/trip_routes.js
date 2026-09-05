/* One booking, and everything the record knows about it.
   ──────────────────────────────────────────────────────────────────────────
   The driver and vehicle pages both end in a table of trip records, and every
   row was a dead end: nine columns of a row that has twenty-odd, no way to
   reach the coordinates, the seat count, the fleet it was booked under, or the
   provider's own record of it. "Which trip was that, exactly" had no answer
   short of the database.

   A trip is an address now. It carries the row in full, and — the part a row
   cannot — the things that only make sense in context: who held the car that
   day, what the trackers saw while it was running, whether the occupancy
   analysis matched it, what the driver was paid for the day it falls in, and
   the rest of that driver's day around it.

   Both fleets, and both kinds of channel. Uber's export carries no fare at all
   and its money arrives weekly under a payout; the hotel channel prices every
   booking. A page that showed only `price` would be blank for 90% of the work
   this fleet does, so the payout day is here beside the fare and the page says
   which one is a measurement of THIS trip and which is not. */
import { redactRaw } from './redact.js';

/* The fold driver_statement_day's stored name_key uses: whitespace runs
   collapsed and lowercased (sql/schema_v25.sql:33), plus the trim the generated
   column omits. Deliberately NOT the person fold used for identity elsewhere —
   that one also collapses a repeated surname, and matching a stored key means
   matching the rule the key was built with, not a stricter one. */
const stmtName = (v) => {
  const n = String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return n || null;
};

export function tripRoutes(app, { q, wrap }) {
  /* The key is (platform, external_id) — the provider's own id, which is the
     only thing about a trip that is stable across a re-collection. */
  app.get('/api/trip', wrap(async (req, res) => {
    const platform = String(req.query.platform || '').trim().toLowerCase();
    const id = String(req.query.id || '').trim();
    if (!platform || !id) {
      return res.status(400).json({ error: 'platform and id are both required' });
    }

    const [t] = await q(
      `SELECT platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
              requested_at, ended_at, pickup_addr, pickup_lat, pickup_lng,
              dropoff_addr, dropoff_lat, dropoff_lng, distance_km, duration_s,
              status, product, payment_type, seat_count, price, currency,
              ingested_at, raw,
              is_booking, outcome, has_fare, has_distance,
              to_char(local_day, 'YYYY-MM-DD') AS local_day
       FROM trip_norm WHERE platform = $1 AND external_id = $2`, [platform, id]);
    if (!t) {
      return res.status(404).json({ error: 'no trip with that platform and id',
        platform, external_id: id });
    }

    /* ── the provider's record leaves redacted, and says what it withheld ──
       Measured on production 2026-09-05, with curl and no credentials:
       GET /api/trip?platform=hotel&id=6a95b3691698f7d77013df68 answered 200
       and trip.raw.driver carried `password` ($2b$10$… bcrypt cost 10),
       `emiratesId` 784-1999-8885500-5 and `notificationToken`
       ExponentPushToken[…] — on all 12 of 12 hotel trips sampled, and 0 of 36
       uber/bolt/yango ones. The hotel channel is a document store and its
       booking EMBEDS the driver record, so every booking this route could
       address handed an anonymous caller that driver's login credential. The
       push token is the sharpest of the three: it is a capability, not a fact
       — whoever holds it can push a notification to that driver's handset.

       The strip happens HERE, at the boundary, and deliberately not at
       ingest. `raw` is the audit trail this whole product rests on — every
       "what did the provider actually send" answer and every field we have
       not thought to map yet — and a stored row that has been cleaned can
       never answer that question again. api/redact.js holds the rule and the
       argument for it: phone and email STAY, because the operator asked for
       them in as many words and #drivers renders them; identity documents,
       bank numbers and credentials go.

       And the removed PATHS come back with the response, because a field
       silently missing from `raw` is indistinguishable from a field the
       provider never sent, and telling those two apart is this product's
       central claim. On the record above that is four paths:
       driver.password, driver.emiratesId, driver.notificationToken — and
       car.licenseNumber, which is a false positive on the key NAME (it holds
       the plate, L46706, not a driving licence). That fourth one costs
       nothing a reader can lose: the plate is a column of its own on this
       same response, the page prints it, and the withheld line names the path
       rather than leaving a hole. It is the trade redact.js made on purpose —
       one withheld value on a diagnostic panel against a national identity
       number on the open web.

       `trip` is the only object on this response that carries a provider
       record. Every other block below is a SELECT of named columns — vehicle,
       custody, telemetry, occupancy_segment, payout, statement, same_day —
       and not one of them selects `raw`; checked against the live response on
       2026-09-05, where `trip` was the only object with a `raw` key. A block
       that starts selecting one has to redact it here too. */
    const safeRaw = redactRaw(t.raw);

    /* Everything below is context and every one of them may be empty. A trip
       on a plate nobody held, on a day no tracker reported, is a real trip —
       so each block is fetched independently and an empty one is reported as
       empty rather than turning the page into an error. */
    const day = t.local_day;
    const [custody, telemetry, segment, payout, sameDay, vehicle, statement] = await Promise.all([
      /* Who held the car that day, from the shared definition — the same one
         the day page and the playbook use, so the person a trip names is the
         person the to-do list chases. */
      t.plate && day ? q(
        `SELECT driver_ext_id, driver_name, platform, trips, km, is_primary,
                first_trip_at, last_trip_at
         FROM vehicle_driver_day WHERE plate = $1 AND day = $2::date
         ORDER BY is_primary DESC, trips DESC NULLS LAST`, [t.plate, day]) : [],

      /* What the trackers saw while it was running. Bounded by the trip's own
         span, widened a little at each end because a fix lands when it lands. */
      t.plate && t.requested_at ? q(
        `SELECT captured_at, lat, lng, speed, status, seat_occupied, ignition, source
         FROM telemetry_snapshot
         WHERE plate = $1
           AND captured_at BETWEEN $2::timestamptz - interval '10 minutes'
                               AND coalesce($3::timestamptz, $2::timestamptz + interval '2 hours')
                                   + interval '10 minutes'
         ORDER BY captured_at LIMIT 300`, [t.plate, t.requested_at, t.ended_at]) : [],

      /* Did the occupancy analysis see this trip? A booking the seat sensor
         never noticed and a journey with no booking are the two halves of the
         same question, and #segments answers it from the other side. */
      t.plate ? q(
        `SELECT plate, started_at, ended_at, duration_min, distance_km, verdict,
                verdict_reason, matched_platform, matched_trip_id
         FROM occupancy_segment
         WHERE plate = $1
           AND (matched_trip_id = $2
                OR (started_at, coalesce(ended_at, started_at))
                    OVERLAPS ($3::timestamptz - interval '15 minutes',
                              coalesce($4::timestamptz, $3::timestamptz) + interval '15 minutes'))
         ORDER BY started_at LIMIT 10`,
        [t.plate, t.external_id, t.requested_at, t.ended_at]) : [],

      /* The money. For Uber this is the ONLY money that exists for this trip —
         its export has no fare column — and it is a figure for the whole DAY,
         not for this booking. The page must not let those be confused. */
      t.driver_ext_id && day ? q(
        `SELECT day::text AS day, platform, earnings, cash_earnings, trips,
                period_start::text AS period_start, period_end::text AS period_end,
                period_days, period_earnings
         FROM driver_payout_day
         WHERE driver_ext_id = $1 AND day = $2::date`, [t.driver_ext_id, day]) : [],

      /* The rest of that driver's day, so a trip sits in the shift it belongs
         to rather than alone. */
      t.driver_ext_id && day ? q(
        `SELECT platform, external_id, requested_at, ended_at, plate, distance_km,
                status, outcome, price, currency, product
         FROM trip_norm
         WHERE driver_ext_id = $1 AND local_day = $2::date AND is_booking
         ORDER BY requested_at LIMIT 200`, [t.driver_ext_id, day]) : [],

      t.plate ? q(
        `SELECT plate, make, model, year, color AS colour, fleet_id
         FROM vehicle WHERE plate = $1`, [t.plate]) : [],

      /* What the CHANNEL's statement says about that day, beside what the bank
         paid for it. driver_payout_day answers "how much money moved"; it is
         built from driver_performance, and Uber's performance feed reports no
         cash at all — so the trip page printed a dash next to "Cash the driver
         held that day" for a fleet whose drivers collect thousands of dirhams
         in cash a week. The figure exists, on the other surface: the earnings
         components carry cash_collected, and src/rollup.js resolves them into
         one row per driver-day here. Reading both means the page can show the
         day split into what the driver earned, was tipped, was reimbursed for
         Salik and already holds — which is the whole of Uber's own statement
         for that day, against the trip that is part of it. */
      /* Matched on the name as well as the id. driver_statement_day's own
         identity rule is the NAME (sql/schema_v25.sql:25) and its
         driver_ext_id is nullable and mostly null, so an id-only predicate
         returned nothing here — the same dead join api/driver_routes.js
         carried, and the same one src/rollup.js:781 records finding against
         2,375 driver-days of real statements. $3 is the name folded the way
         the stored name_key is folded, or null where the trip names nobody. */
      (t.driver_ext_id || t.driver_name) && day ? q(
        `SELECT round(sum(net)::numeric,2)   AS net,
                round(sum(tips)::numeric,2)  AS tips,
                round(sum(salik)::numeric,2) AS salik,
                round(sum(cash)::numeric,2)  AS cash,
                min(source) AS source
         FROM driver_statement_day
         WHERE source <> 'ledger' AND NOT pseudo AND day = $2::date
           AND (($1::text IS NOT NULL AND driver_ext_id = $1)
                OR ($3::text IS NOT NULL AND btrim(name_key) = $3))`,
        [t.driver_ext_id || null, day, stmtName(t.driver_name)]) : [],
    ]);

    res.json({
      trip: { ...t, raw: safeRaw.value },
      /* The paths redactRaw() took out of `raw` above, in the order it found
         them — never null, so an empty array is itself the statement "nothing
         was withheld from this record" rather than an older deploy that did
         not look. The page names them; see the block above for why naming
         them is not optional here. */
      raw_redacted: safeRaw.removed,
      /* THE BOOKING'S OWN MONEY, where the provider states it per booking.
         ───────────────────────────────────────────────────────────────────
         The panel this feeds is titled "What this trip earned" and for a long
         time every row under it was a figure for the whole DAY, because Uber's
         trip export carries no money. Its payments report does, and per
         TRANSACTION: src/sources/uber.js writes the whole component set onto
         the row it prices — fare, the base-fare leaf beneath it, the service
         fee, the net, cash collected, tips and how many transactions were
         folded into it. Only `fare` was ever promoted to a column, so six of
         the seven sat in `raw` and nothing read them.

         Named here rather than left for a page to dig out of `raw`, because
         `raw` is provider-shaped: a client that reaches into it inherits
         Uber's spelling and breaks silently when Uber changes it. Absent for
         every other channel, which report a price and no breakdown — and
         absent, not zeroed, so "this channel does not break a fare down" and
         "it kept nothing" stay different facts. */
      trip_money: (() => {
        /* Read off the REDACTED copy rather than the row, so no figure this
           endpoint serves can be derived from a value it just refused to
           serve. It costs nothing today: the eight keys below are money
           components and none of them is secret-shaped — measured on the
           hotel booking above, where the four paths redactRaw() removes are
           car.licenseNumber and the three driver credentials, with
           uber_payments untouched. If the rule in redact.js ever grew to
           cover one of these the figure would go missing rather than leak,
           and raw_redacted would name the path that took it. */
        const raw = safeRaw.value;
        const m = raw && typeof raw === 'object' ? raw.uber_payments : null;
        if (!m) return null;
        const n = (v) => (v == null ? null : Number(v));
        const fare = n(m.fare);
        const fee = n(m.service_fee);
        return {
          fare,
          /* The leaf under the fare branch, kept because comparing the two is
             what caught the collector reading the wrong node. */
          fare_base: n(m.fare_base),
          earnings: n(m.earnings),
          service_fee: fee,
          /* Stated rather than left for a reader to divide, and only where
             both halves are real — a percentage of nothing is not 0%. */
          commission_pct: fare && fee != null && fare !== 0
            ? Math.round((Math.abs(fee) / fare) * 1000) / 10 : null,
          cash_collected: n(m.cash_collected),
          tip: n(m.tip),
          adjustment: n(m.adjustment),
          transactions: m.transactions == null ? null : Number(m.transactions),
          source: 'the platform’s payments report, one row per transaction',
        };
      })(),
      vehicle: vehicle[0] || null,
      custody,
      telemetry,
      segments: segment,
      payout_day: payout[0] || null,
      /* Null when no component covers the day, rather than a row of zeroes —
         "the statement does not reach this day" and "the driver earned
         nothing" are different facts and the page says which. */
      statement_day: statement[0]?.net == null ? null : statement[0],
      same_day: sameDay,
      /* Named rather than inferred from an empty array: "no tracker reported
         this plate that day" and "this plate has no tracker" are different
         facts and only one of them is a problem. */
      notes: {
        fare_reported: Boolean(t.has_fare),
        /* Measured, not asserted. This was `platform !== 'uber'`, which told
           every reader of an unpriced Uber trip that the channel never prices
           anything — on a channel that priced 6,369 bookings this month. What
           is true of Uber is that its fares arrive in a separate report a week
           at a time, so an unpriced ride is a week not yet collected; what is
           true of a telematics journey is that nobody sold it. The count is
           over this driver's own day, which is the set already in hand. */
        platform_prices_trips: platform !== 'fms'
          && (t.has_fare || sameDay.some((x) => x.platform === platform && x.price != null)),
        is_telematics_journey: !t.is_booking,
      },
    });
  }));
}
