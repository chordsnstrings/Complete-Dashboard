/* Commercial analytics — the questions an operator asks that the trip table
   already contains the answer to, and nothing was reading.
   ──────────────────────────────────────────────────────────────────────────
   Everything here is built on `trip_ext` (sql/schema_v9.sql). Three rules hold
   across every endpoint, because breaking any of them is how this dashboard
   previously produced numbers that were not true:

   1. MONEY RATIOS ONLY OVER PRICED ROWS. The Uber trip export carries no fare
      column, so 30,330 of the fleet's trips have a NULL price. Dividing total
      revenue by total trips answered "what is the average fare" with a number
      four times too small. Every money figure below states its denominator.

   2. A COMPLIMENTARY RIDE IS NOT A ZERO-PRICE SALE. `foc-complimentary` rides
      have cost 0. Counted as sales they drag the average fare down; excluded
      entirely they hide a real cost. They are counted as trips, excluded from
      price averages, and reported on their own.

   3. NULL IS NOT ZERO. `deadhead_km` exists only on the hotel channel, which
      is the only source that records where the driver set off from. Everywhere
      else it is unmeasured, and an unmeasured approach leg is never charted as
      a zero-kilometre one. */

/* A number that lives in a JSON blob is a number a provider can change into a
   word without telling us. Every numeric read out of `raw` is guarded, because
   an unguarded cast fails the whole query for every driver the moment one row
   is malformed. */
const J = (key) => `CASE WHEN raw ->> '${key}' ~ '^-?[0-9]+(\\.[0-9]+)?$'
                         THEN (raw ->> '${key}')::numeric END`;

const NUM = (v) => (v == null ? null : Number(v));
const round = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? null
  : Math.round(Number(v) * 10 ** d) / 10 ** d);
const share = (n, total) => (total ? round((n / total) * 100, 1) : null);

/* An address here is a formatted string, not a structured place. The second
   dash-separated segment is the community in the overwhelming majority of the
   Dubai addresses these providers return ("01 Cluster E - Al Thanyah Fifth -
   Dubai - UAE"), so it is the coarsest key that still means something. Where
   the format does not hold, the whole string is kept rather than guessed at. */
const AREA = `nullif(btrim(split_part(%s, ' - ', 2)), '')`;
const areaOf = (col) => AREA.replace('%s', col);

export function analyticsRoutes(app, { q, wrap, range, F, FB }) {
  /* ───────────────────────── settlement ─────────────────────────
     Who settles the fare, and when. */

  app.get('/api/settlement/mix', wrap(async (req, res) => {
    const p = range(req);
    const rows = await q(
      `SELECT settlement_class, platform,
              count(*)::int trips,
              count(*) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary)::int priced_trips,
              sum(price) FILTER (WHERE NOT is_complimentary) AS revenue,
              sum(distance_km) FILTER (WHERE has_distance) AS km,
              count(*) FILTER (WHERE is_complimentary)::int foc_trips,
              min(requested_at) first_at, max(requested_at) last_at
       FROM trip_ext WHERE ${FB}
       GROUP BY 1, 2`, p);

    const total = rows.reduce((a, r) => a + r.trips, 0);
    const labelled = rows.filter((r) => r.settlement_class);
    const byClass = new Map();
    for (const r of labelled) {
      const c = byClass.get(r.settlement_class) || {
        settlement_class: r.settlement_class, trips: 0, priced_trips: 0, revenue: 0,
        km: 0, foc_trips: 0, platforms: new Set(), last_at: null,
      };
      c.trips += r.trips; c.priced_trips += r.priced_trips;
      c.revenue += NUM(r.revenue) || 0; c.km += NUM(r.km) || 0;
      c.foc_trips += r.foc_trips; c.platforms.add(r.platform);
      if (!c.last_at || r.last_at > c.last_at) c.last_at = r.last_at;
      byClass.set(r.settlement_class, c);
    }

    res.json({
      total_trips: total,
      unlabelled_trips: rows.filter((r) => !r.settlement_class).reduce((a, r) => a + r.trips, 0),
      unlabelled_platforms: [...new Set(rows.filter((r) => !r.settlement_class).map((r) => r.platform))],
      classes: [...byClass.values()].map((c) => ({
        settlement_class: c.settlement_class,
        label: LABEL[c.settlement_class] || c.settlement_class,
        meaning: MEANING[c.settlement_class] || null,
        trips: c.trips,
        trip_share_pct: share(c.trips, total),
        priced_trips: c.priced_trips,
        // A revenue figure over a class where nothing is priced is not zero —
        // it is unknown, and saying zero would understate the class.
        revenue: c.priced_trips ? round(c.revenue, 0) : null,
        avg_fare: c.priced_trips ? round(c.revenue / c.priced_trips, 2) : null,
        km: c.km ? round(c.km, 0) : null,
        foc_trips: c.foc_trips,
        platforms: [...c.platforms].sort(),
        last_at: c.last_at,
      })).sort((a, b) => b.trips - a.trips),
    });
  }));

  const LABEL = {
    cash: 'Cash', card: 'Card', wallet: 'Wallet', on_account: 'On account',
    salary: 'Salary deduction', complimentary: 'Complimentary',
    off_platform: 'Settled off-platform', adjustment: 'Adjustment', other: 'Other',
  };
  const MEANING = {
    cash: 'The driver was handed money and is holding it until it is banked.',
    card: 'Cleared through a card processor at the end of the ride.',
    wallet: 'Apple Pay, Google Pay, PayPal and equivalents — cleared, no cash risk.',
    on_account: 'Charged to the room or the property. Outstanding until the hotel settles.',
    salary: 'Posted against an employee’s salary. Outstanding until payroll runs.',
    complimentary: 'Given away. Costs a driver-hour and fuel, earns nothing.',
    off_platform: 'Uber records the fare as settled outside the app. The export gives no further '
      + 'detail, so this is a settlement route and not, on this evidence, a business-account label.',
    adjustment: 'A derived charge — split fare, credit or correction.',
  };

  /* Cash in drivers' hands. The count is knowable on every channel; the VALUE
     is only knowable where the channel reports a fare, which Uber does not. */
  app.get('/api/settlement/cash-exposure', wrap(async (req, res) => {
    const p = range(req);
    const rows = await q(
      `SELECT coalesce(driver_name, '(unnamed)') driver_name, driver_ext_id,
              count(*)::int cash_trips,
              count(*) FILTER (WHERE price IS NOT NULL)::int priced_cash_trips,
              sum(price) AS cash_value,
              array_agg(DISTINCT platform) platforms,
              array_remove(array_agg(DISTINCT plate), NULL) plates,
              max(requested_at) last_cash_trip
       FROM trip_ext
       WHERE ${FB} AND driver_holds_cash
       GROUP BY 1, 2 ORDER BY cash_trips DESC LIMIT 200`, p);
    const totals = rows.reduce((a, r) => ({
      cash_trips: a.cash_trips + r.cash_trips,
      priced: a.priced + r.priced_cash_trips,
      value: a.value + (NUM(r.cash_value) || 0),
    }), { cash_trips: 0, priced: 0, value: 0 });
    res.json({
      drivers: rows.map((r) => ({
        ...r, cash_value: r.priced_cash_trips ? round(r.cash_value, 0) : null,
        value_known_pct: share(r.priced_cash_trips, r.cash_trips),
      })),
      total_cash_trips: totals.cash_trips,
      total_cash_value_known: totals.priced ? round(totals.value, 0) : null,
      value_known_pct: share(totals.priced, totals.cash_trips),
      caveat: totals.priced < totals.cash_trips
        ? `${totals.cash_trips - totals.priced} of ${totals.cash_trips} cash trips come from a channel `
          + 'that does not report a fare, so the value column is a floor, not the total.'
        : null,
    });
  }));

  /* What is owed, and by whom. */
  app.get('/api/settlement/receivables', wrap(async (req, res) => {
    const p = range(req);
    const rows = await q(
      `SELECT settlement_class,
              CASE WHEN settlement_class = 'salary' THEN coalesce(driver_name, '(unnamed driver)')
                   ELSE coalesce(partner_name, partner_id, '(unnamed property)') END AS counterparty,
              partner_id, driver_ext_id,
              count(*)::int trips,
              count(*) FILTER (WHERE price IS NOT NULL)::int priced_trips,
              sum(price) AS amount,
              min(requested_at) oldest, max(requested_at) newest
       FROM trip_ext
       WHERE ${FB} AND is_receivable
       GROUP BY 1, 2, 3, 4 ORDER BY amount DESC NULLS LAST LIMIT 200`, p);
    res.json({
      rows: rows.map((r) => ({
        ...r, amount: r.priced_trips ? round(r.amount, 0) : null,
        label: LABEL[r.settlement_class] || r.settlement_class,
        age_days: r.oldest ? Math.floor((Date.now() - Date.parse(r.oldest)) / 864e5) : null,
      })),
      total: round(rows.reduce((a, r) => a + (NUM(r.amount) || 0), 0), 0),
      total_trips: rows.reduce((a, r) => a + r.trips, 0),
    });
  }));

  /* ───────────────────────── corporate / hotel channel ─────────────────────
     The only channel in this fleet that reports a cost as well as a price, the
     property that booked, the guest, and where the driver set off from. */

  app.get('/api/corporate/summary', wrap(async (req, res) => {
    const p = range(req);
    const [s] = await q(
      `SELECT count(*)::int bookings,
              count(*) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary)::int priced,
              sum(price) FILTER (WHERE NOT is_complimentary) revenue,
              sum(cost)  FILTER (WHERE NOT is_complimentary) cost,
              sum(distance_km) FILTER (WHERE has_distance) km,
              sum(deadhead_km) deadhead_km,
              count(*) FILTER (WHERE deadhead_km IS NOT NULL)::int deadhead_measured,
              count(*) FILTER (WHERE is_complimentary)::int foc_trips,
              count(*) FILTER (WHERE over_run)::int overrun_trips,
              count(*) FILTER (WHERE is_scheduled)::int scheduled_trips,
              count(*) FILTER (WHERE has_authorization)::int authorized_trips,
              count(*) FILTER (WHERE coalesce(is_missing,false))::int missing_trips,
              count(DISTINCT guest_id)::int guests,
              count(DISTINCT partner_id)::int properties,
              count(DISTINCT driver_ext_id)::int drivers,
              count(DISTINCT plate)::int vehicles,
              count(*) FILTER (WHERE zone = 'outside-dubai')::int outside_dubai,
              count(*) FILTER (WHERE zone IS NOT NULL)::int zoned
       FROM trip_ext WHERE ${F} AND platform = 'hotel'`, p);

    // Client concentration. The Herfindahl index is the standard way to say
    // "how much of this business rests on one customer" in one number, and the
    // top-property share is the same fact in a form anyone can act on.
    const props = await q(
      `SELECT coalesce(partner_name, partner_id, '(unnamed)') name, count(*)::int n
       FROM trip_ext WHERE ${F} AND platform = 'hotel' GROUP BY 1 ORDER BY n DESC`, p);
    const totalN = props.reduce((a, r) => a + r.n, 0);
    const hhi = totalN ? Math.round(props.reduce((a, r) => a + (r.n / totalN) ** 2, 0) * 10000) : null;

    res.json({
      ...s,
      revenue: s.priced ? round(s.revenue, 0) : null,
      // A cost figure only means something if it is a DIFFERENT number from the
      // fare. The hotel report returns one money value per booking; recording
      // it twice produced a gross margin of exactly zero on every property.
      cost: s.cost != null ? round(s.cost, 0) : null,
      has_cost: s.cost != null && s.priced > 0 && round(s.cost, 0) !== round(s.revenue, 0),
      avg_fare: s.priced ? round(NUM(s.revenue) / s.priced, 2) : null,
      km: round(s.km, 0),
      revenue_per_km: s.priced && NUM(s.km) > 0 ? round(NUM(s.revenue) / NUM(s.km), 2) : null,
      deadhead_km: round(s.deadhead_km, 0),
      deadhead_measured_pct: share(s.deadhead_measured, s.bookings),
      // Every approach kilometre is a kilometre driven with nobody paying. As a
      // share of paid distance it is the cleanest statement of positioning cost.
      deadhead_ratio_pct: NUM(s.km) > 0 && NUM(s.deadhead_km) != null
        ? round((NUM(s.deadhead_km) / NUM(s.km)) * 100, 1) : null,
      scheduled_pct: share(s.scheduled_trips, s.bookings),
      authorized_pct: share(s.authorized_trips, s.bookings),
      outside_dubai_pct: share(s.outside_dubai, s.zoned),
      concentration_hhi: hhi,
      top_property: props[0]?.name || null,
      top_property_share_pct: share(props[0]?.n || 0, totalN),
    });
  }));

  app.get('/api/corporate/properties', wrap(async (req, res) => {
    const p = range(req);
    res.json((await q(
      `SELECT partner_id, coalesce(partner_name, partner_id, '(unnamed)') name,
              count(*)::int bookings,
              count(*) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary)::int priced,
              sum(price) FILTER (WHERE NOT is_complimentary) revenue,
              sum(cost)  FILTER (WHERE NOT is_complimentary) cost,
              sum(distance_km) FILTER (WHERE has_distance) km,
              avg(deadhead_km) avg_deadhead_km,
              count(*) FILTER (WHERE is_complimentary)::int foc,
              count(*) FILTER (WHERE over_run)::int overrun,
              count(*) FILTER (WHERE is_scheduled)::int scheduled,
              count(*) FILTER (WHERE product = 'hourly')::int hourly,
              count(*) FILTER (WHERE product = 'pick_and_drop')::int pick_and_drop,
              count(*) FILTER (WHERE product = 'drop_off')::int drop_off,
              count(DISTINCT guest_id)::int guests,
              count(DISTINCT driver_ext_id)::int drivers,
              min(requested_at) first_at, max(requested_at) last_at
       FROM trip_ext WHERE ${F} AND platform = 'hotel'
       GROUP BY 1, 2 ORDER BY bookings DESC`, p)).map((r) => ({
      ...r,
      revenue: r.priced ? round(r.revenue, 0) : null,
      cost: r.cost != null ? round(r.cost, 0) : null,
      avg_fare: r.priced ? round(NUM(r.revenue) / r.priced, 2) : null,
      km: round(r.km, 0),
      revenue_per_km: r.priced && NUM(r.km) > 0 ? round(NUM(r.revenue) / NUM(r.km), 2) : null,
      avg_deadhead_km: round(r.avg_deadhead_km, 2),
      // Bookings per distinct guest: a property whose guests come back is worth
      // more than one with the same volume from strangers.
      bookings_per_guest: r.guests ? round(r.bookings / r.guests, 2) : null,
      scheduled_pct: share(r.scheduled, r.bookings),
    })));
  }));

  app.get('/api/corporate/property', wrap(async (req, res) => {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });
    const p = [...range(req), id];
    const W = `${F} AND platform = 'hotel' AND (partner_id = $5 OR partner_name = $5)`;
    const [profile] = await q(
      `SELECT coalesce(partner_name, partner_id) name, partner_id,
              count(*)::int bookings, min(requested_at) first_at, max(requested_at) last_at,
              count(DISTINCT guest_id)::int guests, count(DISTINCT driver_ext_id)::int drivers,
              count(DISTINCT plate)::int vehicles,
              sum(price) FILTER (WHERE NOT is_complimentary) revenue,
              count(*) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary)::int priced
       FROM trip_ext WHERE ${W} GROUP BY 1, 2`, p);
    if (!profile) return res.status(404).json({ error: 'no bookings for that property in this window' });
    const [daily, types, payments, guests, drivers, dayparts] = await Promise.all([
      q(`SELECT to_char(ext_local_day, 'YYYY-MM-DD') AS day, count(*)::int bookings,
                sum(price) FILTER (WHERE NOT is_complimentary) revenue
         FROM trip_ext WHERE ${W} GROUP BY 1 ORDER BY 1`, p),
      q(`SELECT product AS label, count(*)::int n,
                sum(price) FILTER (WHERE NOT is_complimentary) revenue,
                avg(distance_km) FILTER (WHERE has_distance) avg_km
         FROM trip_ext WHERE ${W} GROUP BY 1 ORDER BY n DESC`, p),
      q(`SELECT payment_type AS label, settlement_class, count(*)::int n,
                sum(price) FILTER (WHERE NOT is_complimentary) revenue
         FROM trip_ext WHERE ${W} GROUP BY 1, 2 ORDER BY n DESC`, p),
      q(`SELECT guest_id, count(*)::int bookings,
                sum(price) FILTER (WHERE NOT is_complimentary) revenue,
                max(room_no) room_no, min(requested_at) first_at, max(requested_at) last_at
         FROM trip_ext WHERE ${W} AND guest_id IS NOT NULL
         GROUP BY 1 ORDER BY bookings DESC, revenue DESC NULLS LAST LIMIT 40`, p),
      q(`SELECT driver_name, driver_ext_id, count(*)::int bookings,
                avg(deadhead_km) avg_deadhead_km,
                sum(price) FILTER (WHERE NOT is_complimentary) revenue
         FROM trip_ext WHERE ${W} AND driver_name IS NOT NULL
         GROUP BY 1, 2 ORDER BY bookings DESC LIMIT 40`, p),
      q(`SELECT daypart AS label, count(*)::int n FROM trip_ext WHERE ${W} GROUP BY 1`, p),
    ]);
    res.json({
      profile: { ...profile, revenue: profile.priced ? round(profile.revenue, 0) : null,
        avg_fare: profile.priced ? round(NUM(profile.revenue) / profile.priced, 2) : null },
      daily: daily.map((d) => ({ ...d, revenue: round(d.revenue, 0) })),
      types: types.map((t) => ({ ...t, revenue: round(t.revenue, 0), avg_km: round(t.avg_km, 1) })),
      payments: payments.map((x) => ({ ...x, revenue: round(x.revenue, 0), label_class: LABEL[x.settlement_class] || null })),
      guests: guests.map((g) => ({ ...g, revenue: round(g.revenue, 0) })),
      drivers: drivers.map((d) => ({ ...d, revenue: round(d.revenue, 0), avg_deadhead_km: round(d.avg_deadhead_km, 2) })),
      dayparts,
    });
  }));

  /* Passengers. The hotel channel issues a NEW passenger record per booking —
     checked against a year of live data, 1,254 bookings carry 1,254 distinct
     client ids and no id appears twice. So this is not a customer table and
     repeat business is not measurable from it. The endpoint says that in the
     response rather than reporting a repeat rate of zero as if it were a
     finding about the business. */
  app.get('/api/corporate/guests', wrap(async (req, res) => {
    const p = range(req);
    const rows = await q(
      `SELECT guest_id, count(*)::int bookings,
              sum(price) FILTER (WHERE NOT is_complimentary) AS revenue,
              count(*) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary)::int priced,
              count(DISTINCT partner_id)::int properties,
              max(coalesce(partner_name, partner_id)) property,
              max(room_no) room_no, max(trip_purpose) purpose,
              min(requested_at) first_at, max(requested_at) last_at,
              sum(distance_km) FILTER (WHERE has_distance) AS km
       FROM trip_ext WHERE ${F} AND platform = 'hotel' AND guest_id IS NOT NULL
       GROUP BY 1 ORDER BY bookings DESC, revenue DESC NULLS LAST LIMIT 300`, p);
    const [all] = await q(
      `SELECT count(DISTINCT guest_id)::int guests, count(*)::int bookings,
              count(*) FILTER (WHERE room_no IS NOT NULL)::int with_room,
              count(DISTINCT room_no)::int rooms
       FROM trip_ext WHERE ${F} AND platform = 'hotel' AND guest_id IS NOT NULL`, p);
    const repeat = rows.filter((r) => r.bookings > 1);

    // One id per booking means the id is a booking, whatever the field is called.
    const idIsPerBooking = all && all.bookings > 20 && all.guests === all.bookings;

    // Where a room number IS recorded, it is the only thing on this channel
    // that can recur — so it is the only repeat signal available, and it is
    // reported as what it is: a room, not a person.
    const byRoom = await q(
      `SELECT room_no, count(*)::int bookings,
              count(DISTINCT coalesce(partner_name, partner_id))::int properties,
              max(coalesce(partner_name, partner_id)) property,
              sum(price) FILTER (WHERE NOT is_complimentary) AS revenue,
              min(requested_at) first_at, max(requested_at) last_at
       FROM trip_ext
       WHERE ${F} AND platform = 'hotel' AND room_no IS NOT NULL AND room_no ~ '^[0-9]{2,5}$'
       GROUP BY 1 HAVING count(*) > 1 ORDER BY bookings DESC LIMIT 80`, p);

    res.json({
      guests: rows.map((r) => ({
        ...r, revenue: r.priced ? round(r.revenue, 0) : null, km: round(r.km, 0),
        span_days: r.first_at && r.last_at
          ? Math.round((Date.parse(r.last_at) - Date.parse(r.first_at)) / 864e5) : null,
      })),
      total_guests: all?.guests ?? 0,
      total_bookings: all?.bookings ?? 0,
      bookings_with_room: all?.with_room ?? 0,
      distinct_rooms: all?.rooms ?? 0,
      repeat_guests: repeat.length,
      repeat_rate_pct: share(repeat.length, rows.length),
      bookings_from_repeat_pct: share(repeat.reduce((a, r) => a + r.bookings, 0),
        rows.reduce((a, r) => a + r.bookings, 0)),
      // The single most important field in this response.
      id_is_per_booking: idIsPerBooking,
      caveat: idIsPerBooking
        ? `This channel issues a new passenger record per booking — ${all.guests} ids across `
          + `${all.bookings} bookings, none of them repeated. Repeat travel cannot be measured from it, `
          + 'and a repeat rate of 0% here is a fact about the identifier, not about the customers.'
        : null,
      rooms: byRoom.map((r) => ({ ...r, revenue: round(r.revenue, 0) })),
    });
  }));

  /* Everything on this channel that costs money and should not.
     Each row is one named, dated, clickable booking — a leakage report you can
     act on rather than a percentage you can only worry about. */
  app.get('/api/corporate/leakage', wrap(async (req, res) => {
    const p = range(req);
    const kinds = {
      complimentary: `is_complimentary`,
      overrun: `over_run`,
      unpriced: `price IS NULL AND NOT is_complimentary`,
      zero_priced: `price = 0 AND NOT is_complimentary`,
      unauthorized: `NOT has_authorization AND price IS NOT NULL AND price > 0`,
      deadhead_exceeds_fare: `deadhead_km IS NOT NULL AND distance_km > 0 AND deadhead_km > distance_km`,
      missing: `coalesce(is_missing, false)`,
    };
    const only = kinds[req.query.kind] ? req.query.kind : null;
    const counts = await q(
      `SELECT ${Object.entries(kinds).map(([k, w]) => `count(*) FILTER (WHERE ${w})::int "${k}"`).join(', ')},
              count(*)::int total,
              sum(price) FILTER (WHERE ${kinds.overrun}) overrun_value,
              sum(cost)  FILTER (WHERE ${kinds.complimentary}) foc_cost,
              sum(deadhead_km) FILTER (WHERE ${kinds.deadhead_exceeds_fare}) wasted_km
       FROM trip_ext WHERE ${F} AND platform = 'hotel'`, p);
    const rows = only ? await q(
      `SELECT external_id, requested_at, ended_at, driver_name, driver_ext_id, plate,
              coalesce(partner_name, partner_id) property, partner_id, product, payment_type,
              settlement_class, price, cost, distance_km, deadhead_km, hours, room_no,
              trip_purpose, over_run, has_authorization, guest_id
       FROM trip_ext WHERE ${F} AND platform = 'hotel' AND ${kinds[only]}
       ORDER BY requested_at DESC LIMIT 500`, p) : [];
    res.json({
      kinds: Object.keys(kinds).map((k) => ({
        kind: k, label: LEAK_LABEL[k], why: LEAK_WHY[k], n: counts[0]?.[k] ?? 0,
      })),
      summary: {
        total: counts[0]?.total ?? 0,
        overrun_value: round(counts[0]?.overrun_value, 0),
        foc_cost: round(counts[0]?.foc_cost, 0),
        wasted_km: round(counts[0]?.wasted_km, 1),
      },
      kind: only, rows,
    });
  }));

  const LEAK_LABEL = {
    complimentary: 'Given away', overrun: 'Ran past the booked hours',
    unpriced: 'No fare recorded', zero_priced: 'Priced at zero',
    unauthorized: 'Charged with no authorisation on file',
    deadhead_exceeds_fare: 'Drove further to reach the job than the job itself',
    missing: 'Flagged as a missing trip by the booking system',
  };
  const LEAK_WHY = {
    complimentary: 'A driver-hour and the fuel were spent; nothing was billed.',
    overrun: 'An hourly charter that ran over its booked hours. Whether the extra time was billed '
      + 'is not in this record — it is worth checking against the invoice.',
    unpriced: 'The booking closed without a fare. Either it was never billed or the price never '
      + 'reached us; both are worth a query.',
    zero_priced: 'A completed booking with a fare of exactly zero that is not marked complimentary.',
    unauthorized: 'A billed booking with no authorisation object attached. On this channel the '
      + 'authorisation is the approval trail for a charge back to a property.',
    deadhead_exceeds_fare: 'The unpaid approach leg was longer than the paid ride. Repeated on the '
      + 'same property or daypart, this is a positioning problem, not bad luck.',
    missing: 'The booking system itself flagged this record as incomplete.',
  };

  /* The unpaid leg, cut every way it can be acted on. */
  app.get('/api/corporate/approach', wrap(async (req, res) => {
    const p = range(req);
    const by = { property: `coalesce(partner_name, partner_id, '(unnamed)')`,
      daypart: 'daypart', driver: `coalesce(driver_name, '(unnamed)')`,
      type: 'product', zone: `coalesce(zone, '(unrecorded)')` };
    const dim = by[req.query.by] || by.property;
    res.json(await q(
      `SELECT ${dim} AS label, count(*)::int bookings,
              count(*) FILTER (WHERE deadhead_km IS NOT NULL)::int measured,
              round(sum(deadhead_km)::numeric, 1) deadhead_km,
              round(avg(deadhead_km)::numeric, 2) avg_deadhead_km,
              round(sum(distance_km) FILTER (WHERE has_distance)::numeric, 1) paid_km,
              round((100.0 * sum(deadhead_km)
                     / nullif(sum(distance_km) FILTER (WHERE has_distance), 0))::numeric, 1) ratio_pct
       FROM trip_ext WHERE ${F} AND platform = 'hotel'
       GROUP BY 1 HAVING count(*) FILTER (WHERE deadhead_km IS NOT NULL) > 0
       ORDER BY deadhead_km DESC NULLS LAST LIMIT 60`, p));
  }));

  /* ───────────────────────── product tiers ─────────────────────────
     Uber's consumer tier is the limousine product mix. The export carries no
     fare, so this is deliberately a MIX and DISTANCE analysis, not a revenue
     one — a tier table with invented money would be worse than none. */
  app.get('/api/tiers/by-vehicle', wrap(async (req, res) => {
    const p = range(req);
    const rows = await q(
      `SELECT t.plate,
              count(*)::int trips,
              count(*) FILTER (WHERE t.uber_tier = 'Black')::int black,
              count(*) FILTER (WHERE t.uber_tier = 'Comfort')::int comfort,
              count(*) FILTER (WHERE t.uber_tier = 'Electric')::int electric,
              count(*) FILTER (WHERE t.uber_tier = 'UberX')::int uberx,
              count(*) FILTER (WHERE t.is_premium_tier)::int premium,
              round(sum(t.distance_km) FILTER (WHERE t.has_distance)::numeric, 0) km,
              round(avg(t.distance_km) FILTER (WHERE t.has_distance)::numeric, 1) avg_km,
              max(vp.make) AS make, max(vp.model) AS model, max(vp.year)::int AS year,
              max(vp.colour) AS colour
       -- The window filter is applied inside a subquery rather than beside the
       -- join: vehicle_profile also has platform and fleet_id columns, and the
       -- shared filter names them bare, which makes the reference ambiguous.
       FROM (SELECT * FROM trip_ext WHERE ${F} AND platform = 'uber' AND plate IS NOT NULL) t
       LEFT JOIN vehicle_profile vp ON upper(replace(vp.plate, ' ', '')) = upper(replace(t.plate, ' ', ''))
       GROUP BY t.plate ORDER BY trips DESC LIMIT 250`, p);
    const fleetPremium = rows.reduce((a, r) => a + r.premium, 0);
    const fleetTrips = rows.reduce((a, r) => a + r.trips, 0);
    const fleetPct = share(fleetPremium, fleetTrips);
    // A model that carries premium work somewhere in the fleet can carry it
    // everywhere. Comparing a car against its OWN model's best premium share is
    // the honest version of "this car is under-used" — comparing a BYD against
    // a Lexus is not a finding, it is a spec sheet.
    const byModel = new Map();
    for (const r of rows) {
      const k = [r.make, r.model].filter(Boolean).join(' ') || '(unknown)';
      const cur = byModel.get(k) || { premium: 0, trips: 0, best: 0 };
      cur.premium += r.premium; cur.trips += r.trips;
      cur.best = Math.max(cur.best, r.trips >= 20 ? (r.premium / r.trips) * 100 : 0);
      byModel.set(k, cur);
    }
    res.json({
      fleet_premium_pct: fleetPct,
      vehicles: rows.map((r) => {
        const k = [r.make, r.model].filter(Boolean).join(' ') || '(unknown)';
        const m = byModel.get(k);
        const pctv = share(r.premium, r.trips);
        return {
          ...r, premium_pct: pctv,
          model_key: k,
          model_premium_pct: m && m.trips ? share(m.premium, m.trips) : null,
          model_best_pct: m && m.best ? round(m.best, 1) : null,
          // Only claim a shortfall where the same model demonstrably carries
          // more premium work and this car has enough trips to judge.
          premium_gap_pct: m && m.best && r.trips >= 20 && pctv != null && m.best - pctv > 5
            ? round(m.best - pctv, 1) : null,
        };
      }),
    });
  }));

  app.get('/api/tiers/mix', wrap(async (req, res) => {
    const p = range(req);
    const by = { day: 'ext_local_day', daypart: 'daypart', dow: 'local_dow', hour: 'local_hour' };
    const dim = by[req.query.by] || by.daypart;
    res.json(await q(
      `SELECT ${dim} AS label, uber_tier AS tier, count(*)::int n,
              round(avg(distance_km) FILTER (WHERE has_distance)::numeric, 1) avg_km
       FROM trip_ext WHERE ${F} AND platform = 'uber' AND uber_tier IS NOT NULL
       GROUP BY 1, 2 ORDER BY 1, n DESC`, p));
  }));

  /* ───────────────────────── coverage calendar ─────────────────────────
     A collection hole and a quiet week produce the same chart. This is the
     endpoint that tells them apart, and it exists because the Uber backfill has
     a real one: 2026-07-16 to 2026-08-02 holds zero trips between two months
     that hold thousands. */
  app.get('/api/coverage/calendar', wrap(async (req, res) => {
    const [from, to] = range(req);
    const rows = await q(
      // to_char, not the raw date: the driver hands a DATE back as a JS Date
      // whose string form is "Tue Aug 01 2026 …", and slicing ten characters
      // off that yields "Tue Aug 01" — which then parses as the year 2001 and
      // moved every gap in this report a quarter of a century into the past.
      `SELECT source, to_char(day, 'YYYY-MM-DD') AS day, rows, plates, drivers
       FROM source_day_coverage
       WHERE day BETWEEN $1::date AND $2::date ORDER BY source, day`, [from, to]);
    const bySource = new Map();
    for (const r of rows) {
      const s = bySource.get(r.source) || { source: r.source, days: [], total: 0 };
      s.days.push({ day: r.day, rows: r.rows, plates: r.plates, drivers: r.drivers });
      s.total += r.rows;
      bySource.set(r.source, s);
    }
    const out = [...bySource.values()].map((s) => {
      const seen = new Set(s.days.map((d) => d.day));
      const first = s.days[0]?.day, last = s.days[s.days.length - 1]?.day;
      // Gaps are only counted INSIDE a source's own observed span. A source that
      // started collecting in March has no hole in January — it has no history,
      // which is a different statement and belongs in a different sentence.
      const gaps = [];
      if (first && last) {
        let run = null;
        for (let t = Date.parse(first); t <= Date.parse(last); t += 864e5) {
          const d = new Date(t).toISOString().slice(0, 10);
          if (seen.has(d)) { if (run) { gaps.push(run); run = null; } }
          else if (run) { run.to = d; run.days++; }
          else run = { from: d, to: d, days: 1 };
        }
        if (run) gaps.push(run);
      }
      const daily = s.days.map((d) => d.rows).sort((a, b) => a - b);
      const median = daily.length ? daily[Math.floor(daily.length / 2)] : 0;
      return {
        source: s.source, total_rows: s.total, days_with_data: s.days.length,
        first_day: first, last_day: last, median_rows_per_day: median,
        gaps: gaps.sort((a, b) => b.days - a.days).slice(0, 20),
        missing_days: gaps.reduce((a, g) => a + g.days, 0),
        days: s.days,
      };
    }).sort((a, b) => b.total_rows - a.total_rows);
    res.json({ window: [from, to], sources: out });
  }));

  /* ───────────────────────── corridors ─────────────────────────
     Where the work starts and ends. Every channel returns a formatted address
     rather than a place id, so the community is parsed out of the string; the
     response says so, because a parsed area is evidence of a pattern and not a
     geofence. */
  app.get('/api/geo/corridors', wrap(async (req, res) => {
    const p = range(req);
    const rows = await q(
      `SELECT coalesce(${areaOf('pickup_addr')}, '(unrecorded)') AS from_area,
              coalesce(${areaOf('dropoff_addr')}, '(unrecorded)') AS to_area,
              count(*)::int trips,
              round(avg(distance_km) FILTER (WHERE has_distance)::numeric, 1) avg_km,
              round(avg(duration_s)::numeric / 60, 1) avg_min,
              count(*) FILTER (WHERE price IS NOT NULL)::int priced,
              round(avg(price) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary)::numeric, 2) avg_fare,
              array_agg(DISTINCT platform) platforms
       FROM trip_ext
       WHERE ${F} AND (pickup_addr IS NOT NULL OR dropoff_addr IS NOT NULL)
       GROUP BY 1, 2 HAVING count(*) >= 3
       ORDER BY trips DESC LIMIT 120`, p);
    const origins = await q(
      `SELECT coalesce(${areaOf('pickup_addr')}, '(unrecorded)') AS area,
              count(*)::int trips,
              count(*) FILTER (WHERE local_hour BETWEEN 5 AND 9)::int morning,
              count(*) FILTER (WHERE local_hour BETWEEN 16 AND 21)::int evening,
              round(avg(distance_km) FILTER (WHERE has_distance)::numeric, 1) avg_km
       FROM trip_ext WHERE ${F} AND pickup_addr IS NOT NULL
       GROUP BY 1 ORDER BY trips DESC LIMIT 60`, p);
    res.json({
      note: 'Areas are parsed from the address text each provider returns, not from a place id.',
      corridors: rows.filter((r) => r.from_area !== '(unrecorded)' || r.to_area !== '(unrecorded)'),
      origins,
    });
  }));

  /* ───────────────────────── acceptance funnel ─────────────────────────
     Yango and Bolt report the counts a trip table cannot: how many requests
     were offered, accepted, and who cancelled. This is the only place in the
     data where lost demand is visible at all. */
  app.get('/api/funnel/drivers', wrap(async (req, res) => {
    const [from, to] = range(req);
    res.json((await q(
      `SELECT platform, driver_name, driver_ext_id, period_start, period_end,
              ${J('count_orders_all')}              offered,
              ${J('count_orders_accepted')}         accepted,
              ${J('count_orders_completed')}        completed,
              ${J('count_orders_cancelled_by_driver')} cancelled_driver,
              ${J('count_orders_cancelled_by_client')} cancelled_client,
              ${J('work_time_seconds')}             work_time_seconds,
              ${J('price_cash')}                    price_cash,
              ${J('price_cashless')}                price_cashless,
              ${J('price_platform_commission')}     commission,
              ${J('driver_score')}                  driver_score,
              raw ->> 'state'                                    state
       FROM driver_performance
       WHERE period_start <= $2::date AND period_end >= $1::date AND raw IS NOT NULL
       ORDER BY offered DESC NULLS LAST LIMIT 200`, [from, to])).map((r) => ({
      ...r,
      accept_pct: r.offered > 0 ? round((r.accepted / r.offered) * 100, 1) : null,
      complete_pct: r.accepted > 0 ? round((r.completed / r.accepted) * 100, 1) : null,
      // The commission arrives negative — it is money leaving. Reported as a
      // positive cost with an explicit label rather than a signed number that
      // sums to something meaningless.
      commission_cost: r.commission != null ? round(Math.abs(r.commission), 0) : null,
      gross: r.price_cash != null || r.price_cashless != null
        ? round((NUM(r.price_cash) || 0) + (NUM(r.price_cashless) || 0), 0) : null,
      hours: r.work_time_seconds != null ? round(r.work_time_seconds / 3600, 1) : null,
      cash_pct: (NUM(r.price_cash) || 0) + (NUM(r.price_cashless) || 0) > 0
        ? round(((NUM(r.price_cash) || 0) / ((NUM(r.price_cash) || 0) + (NUM(r.price_cashless) || 0))) * 100, 1)
        : null,
    })));
  }));
}

/* ───────────────────────── the analyst ─────────────────────────
   Findings a model proposed and the database then judged. Read-only here; the
   generation pass is a collector job, because it costs a model call and must
   not be triggerable by anyone who loads a page. */
export function analystRoutes(app, { q, wrap, range }) {
  /* What every provider surface actually sends, and which of those fields we
     have nowhere to put. Read from the stored probe rather than run live: the
     credentials live in the collector, and a page load must never be able to
     spend somebody else's API quota. */
  app.get('/api/probe/results', wrap(async (_req, res) => {
    const rows = await q(
      `SELECT provider, surface, ok, http_status, record_count, top_keys, fields,
              unmapped, error, note, probed_at
       FROM provider_probe ORDER BY provider, surface`);
    res.json({
      surfaces: rows.map((r) => ({ ...r,
        fields: typeof r.fields === 'string' ? JSON.parse(r.fields) : r.fields,
        unmapped_n: r.unmapped?.length ?? null })),
      last_probe: rows.reduce((a, r) => (!a || r.probed_at > a ? r.probed_at : a), null),
      failing: rows.filter((r) => !r.ok).map((r) => ({ provider: r.provider, surface: r.surface, error: r.error })),
      note: 'Each surface here is one the collectors already call, with the same credentials and the '
        + 'same read-only verb. Values are shown only for fields narrow enough to be a dimension; '
        + 'anything wider is an identifier, an address or free text and its contents are not recorded.',
    });
  }));

  app.get('/api/analyst/findings', wrap(async (req, res) => {
    const [from, to] = range(req);
    const verdicts = String(req.query.verdict || 'confirmed').split(',')
      .filter((v) => ['confirmed', 'refuted', 'immaterial', 'unsupported'].includes(v));
    const rows = await q(
      `SELECT * FROM analyst_finding
       WHERE window_start >= $1::date AND window_end <= $2::date
         AND ($3::text[] IS NULL OR verdict = ANY($3))
       ORDER BY created_at DESC,
                CASE verdict WHEN 'confirmed' THEN 0 WHEN 'refuted' THEN 1
                             WHEN 'immaterial' THEN 2 ELSE 3 END,
                abs(coalesce(effect_pct, 0)) DESC
       LIMIT 300`, [from, to, verdicts.length ? verdicts : null]);
    // The unit belongs to the metric, not to a guess at the front end: a page
    // deriving "%" from a column name printed a distance difference as a bare
    // number and a fare difference as a percentage.
    const { METRICS } = await import('../src/analyst.js');
    for (const r of rows) {
      r.unit = METRICS[r.metric]?.unit ?? '';
      r.metric_label = METRICS[r.metric]?.label ?? r.metric;
    }
    const [counts] = await q(
      `SELECT count(*) FILTER (WHERE verdict = 'confirmed')::int confirmed,
              count(*) FILTER (WHERE verdict = 'refuted')::int refuted,
              count(*) FILTER (WHERE verdict = 'immaterial')::int immaterial,
              count(*) FILTER (WHERE verdict = 'unsupported')::int unsupported,
              count(DISTINCT run_id)::int runs, max(created_at) last_run, max(model) model
       FROM analyst_finding
       WHERE window_start >= $1::date AND window_end <= $2::date`, [from, to]);
    res.json({ ...counts, findings: rows });
  }));

  /* What the checker is allowed to check, published so the rules are readable
     rather than folklore. A threshold nobody can see is a threshold nobody can
     argue with. */
  app.get('/api/analyst/rules', wrap(async (_req, res) => {
    const { METRICS, DIMENSIONS, MATERIALITY } = await import('../src/analyst.js');
    res.json({
      metrics: Object.entries(METRICS).map(([k, m]) => ({
        metric: k, label: m.label, kind: m.kind, unit: m.unit, defined_over: m.where })),
      dimensions: Object.keys(DIMENSIONS),
      materiality: MATERIALITY,
      note: 'The model chooses a metric, a dimension and a segment from these lists. It never writes a '
        + 'query. Each claim is measured against the rest of the fleet in the same window, and is only '
        + 'shown as confirmed when it is true, large enough to act on, and larger than the sample size '
        + 'would produce by chance.',
    });
  }));
}
