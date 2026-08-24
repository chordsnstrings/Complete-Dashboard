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
import { custodyOverWindow, custodyCountOverWindow, peopleCount } from './custody_sql.js';

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
    /* Totalled in the database, not over the 200 rows returned. "AED x is in
       drivers' hands" is a figure somebody acts on, and summing the visible
       page understates it by exactly the tail — which is the part nobody is
       watching. The driver count has the same problem and is the more likely
       to be wrong first, because a fleet has more drivers than it has drivers
       worth listing. */
    const [totals] = await q(
      /* The driver count is over the SAME grouping the list uses, not over
         DISTINCT driver_ext_id. Those differ whenever one person appears both
         with and without a platform id — and a tile reading 4 above a list of
         5 rows is a contradiction on screen, which is worse than either number
         being slightly off. The tile has to describe the list it sits above. */
      `SELECT (SELECT count(*)::int FROM (
                 SELECT 1 FROM trip_ext WHERE ${FB} AND driver_holds_cash
                 GROUP BY coalesce(driver_name, '(unnamed)'), driver_ext_id) g) AS drivers,
              count(*)::int cash_trips,
              count(*) FILTER (WHERE price IS NOT NULL)::int priced,
              sum(price) AS value
       FROM trip_ext WHERE ${FB} AND driver_holds_cash`, p);
    const cashTrips = totals?.cash_trips || 0;
    const priced = totals?.priced || 0;
    res.json({
      drivers: rows.map((r) => ({
        ...r, cash_value: r.priced_cash_trips ? round(r.cash_value, 0) : null,
        value_known_pct: share(r.priced_cash_trips, r.cash_trips),
      })),
      driver_count: totals?.drivers || 0,
      shown: rows.length,
      truncated: (totals?.drivers || 0) > rows.length,
      total_cash_trips: cashTrips,
      total_cash_value_known: priced ? round(NUM(totals.value) || 0, 0) : null,
      value_known_pct: share(priced, cashTrips),
      caveat: priced < cashTrips
        ? `${cashTrips - priced} of ${cashTrips} cash trips come from a channel `
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
    // Same rule: the outstanding total is a sum over the table, not over the
    // page. A receivables figure that quietly excludes its own tail is worse
    // than no figure, because somebody will reconcile against it.
    const [t] = await q(
      // Counted over the same grouping the list uses, for the same reason as
      // cash exposure: the tile has to describe the list it sits above.
      `SELECT count(*)::int trips,
              count(*) FILTER (WHERE price IS NOT NULL)::int priced_trips,
              sum(price) AS amount,
              (SELECT count(*)::int FROM (
                 SELECT 1 FROM trip_ext WHERE ${FB} AND is_receivable
                 GROUP BY settlement_class,
                          CASE WHEN settlement_class = 'salary'
                               THEN coalesce(driver_name, '(unnamed driver)')
                               ELSE coalesce(partner_name, partner_id, '(unnamed property)') END,
                          partner_id, driver_ext_id) g) AS counterparties,
              min(requested_at) AS oldest
       FROM trip_ext WHERE ${FB} AND is_receivable`, p);
    res.json({
      rows: rows.map((r) => ({
        ...r, amount: r.priced_trips ? round(r.amount, 0) : null,
        label: LABEL[r.settlement_class] || r.settlement_class,
        age_days: r.oldest ? Math.floor((Date.now() - Date.parse(r.oldest)) / 864e5) : null,
      })),
      total: t?.priced_trips ? round(NUM(t.amount) || 0, 0) : 0,
      total_trips: t?.trips || 0,
      counterparties: t?.counterparties || 0,
      priced_trips: t?.priced_trips || 0,
      oldest_days: t?.oldest ? Math.floor((Date.now() - Date.parse(t.oldest)) / 864e5) : null,
      shown: rows.length,
      truncated: (t?.counterparties || 0) > rows.length,
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
              ${peopleCount()}::int drivers,
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
              ${peopleCount()}::int drivers,
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
              count(DISTINCT guest_id)::int guests, ${peopleCount()}::int drivers,
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
              -- The id, so the property name is openable. Where a guest or a
              -- room has used more than one property the name is the busiest
              -- one and this is its id; the properties count above says when
              -- that is a simplification.
              (array_agg(partner_id ORDER BY partner_id) FILTER (WHERE partner_id IS NOT NULL))[1] AS partner_id,
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
              (array_agg(partner_id ORDER BY partner_id) FILTER (WHERE partner_id IS NOT NULL))[1] AS partner_id,
              sum(price) FILTER (WHERE NOT is_complimentary) AS revenue,
              min(requested_at) first_at, max(requested_at) last_at
       FROM trip_ext
       WHERE ${F} AND platform = 'hotel' AND room_no IS NOT NULL AND room_no ~ '^[0-9]{2,5}$'
       GROUP BY 1 HAVING count(*) > 1 ORDER BY bookings DESC LIMIT 80`, p);

    // The page's "Rooms seen more than once" tile was this list's length, and
    // the list stops at 80. Counted properly, so the tile is a fact about the
    // channel rather than about the query.
    const [roomTot] = await q(
      `SELECT count(*)::int repeat_rooms, sum(n)::int repeat_bookings FROM (
         SELECT count(*)::int n FROM trip_ext
         WHERE ${F} AND platform = 'hotel' AND room_no IS NOT NULL
         GROUP BY room_no HAVING count(*) > 1) g`, p);

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
      repeat_rooms: roomTot?.repeat_rooms || 0,
      repeat_bookings: roomTot?.repeat_bookings || 0,
      rooms_truncated: (roomTot?.repeat_rooms || 0) > byRoom.length,
    });
  }));

  /* Everything on this channel that costs money and should not.
     Each row is one named, dated, clickable booking — a leakage report you can
     act on rather than a percentage you can only worry about. */
  app.get('/api/corporate/leakage', wrap(async (req, res) => {
    const p = range(req);

    /* A missing authorisation is only evidence of anything at a property whose
       own workflow requires one. Without that qualifier this fired on 1,095 of
       1,254 live bookings — 87% — because most properties do not use the
       approval flow at all, and a finding that fires on seven bookings in eight
       is not a finding. The property list carries the flag; the collector now
       keeps it. Where no property has ever declared the flag, the category
       reports zero and says why, rather than accusing everybody. */
    const [approval] = await q(
      `SELECT count(*) FILTER (WHERE approval_required)::int requiring,
              count(*) FILTER (WHERE approval_required IS NOT NULL)::int declared,
              count(*)::int properties
       FROM partner WHERE platform = 'hotel'`);
    const REQUIRES_APPROVAL = `partner_id IN (
      SELECT partner_id FROM partner WHERE platform = 'hotel' AND approval_required)`;

    const kinds = {
      complimentary: `is_complimentary`,
      overrun: `over_run`,
      unpriced: `price IS NULL AND NOT is_complimentary`,
      zero_priced: `price = 0 AND NOT is_complimentary`,
      unauthorized: approval?.requiring
        ? `NOT has_authorization AND price IS NOT NULL AND price > 0 AND ${REQUIRES_APPROVAL}`
        : `false`,
      deadhead_exceeds_fare: `deadhead_km IS NOT NULL AND distance_km > 0 AND deadhead_km > distance_km`,
      missing: `coalesce(is_missing, false)`,
    };
    const only = kinds[req.query.kind] ? req.query.kind : null;

    const counts = await q(
      `SELECT ${Object.entries(kinds).map(([k, w]) => `count(*) FILTER (WHERE ${w})::int "${k}"`).join(', ')},
              count(*)::int total,
              sum(price) FILTER (WHERE ${kinds.overrun}) overrun_value,
              sum(cost)  FILTER (WHERE ${kinds.complimentary}) foc_cost,
              sum(distance_km) FILTER (WHERE ${kinds.complimentary} AND has_distance) foc_km,
              sum(duration_s)  FILTER (WHERE ${kinds.complimentary}) foc_seconds,
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
        // A category that cannot fire is not the same as one that found nothing.
        disabled: k === 'unauthorized' && !approval?.requiring
          ? (approval?.declared
            ? `None of the ${approval.properties} properties on this channel requires an authorisation, `
              + 'so a missing one is not evidence of anything.'
            : 'No property has declared whether it requires an authorisation, so a missing one cannot '
              + 'be judged. The property list is read on every collection — if this persists, the '
              + 'channel is not sending the flag.')
          : null,
      })),
      summary: {
        total: counts[0]?.total ?? 0,
        overrun_value: round(counts[0]?.overrun_value, 0),
        // Complimentary rides carry no cost figure on this channel, so what was
        // given away is measured in the things that ARE recorded: distance and
        // the driver's time.
        foc_cost: round(counts[0]?.foc_cost, 0),
        foc_km: round(counts[0]?.foc_km, 1),
        foc_hours: counts[0]?.foc_seconds ? round(counts[0].foc_seconds / 3600, 1) : null,
        wasted_km: round(counts[0]?.wasted_km, 1),
        properties_requiring_approval: approval?.requiring ?? 0,
        properties: approval?.properties ?? 0,
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
    complimentary: 'A driver-hour and the fuel were spent; nothing was billed. This channel reports no '
      + 'delivery cost, so what was given away is measured in distance and driver time.',
    overrun: 'An hourly charter that ran over its booked hours. Whether the extra time was billed '
      + 'is not in this record — it is worth checking against the invoice.',
    unpriced: 'The booking closed without a fare. Either it was never billed or the price never '
      + 'reached us; both are worth a query.',
    zero_priced: 'A completed booking with a fare of exactly zero that is not marked complimentary.',
    unauthorized: 'A billed booking with no authorisation object attached, at a property whose own '
      + 'workflow requires one. Properties that do not use the approval flow are excluded — without '
      + 'that qualifier this category flagged 87% of every booking on the channel.',
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
    /* BOTH unpaid legs, reported separately and never silently added.
       This measured only the approach — driver start to pickup — and reported
       it as "deadhead", which is half the empty running and the forgivable
       half: sending a car 5 km to collect somebody is the cost of doing the
       job. The expensive one is where the driver is LEFT. The hotel API has
       reported driverEndLat/Lon all along, on most bookings, and it was never
       stored.

       `measured_both` is the only denominator a combined ratio may use.
       Dividing a total that mixes measured approaches with unmeasured returns
       by a booking count produces a confident understatement, which is exactly
       the failure this endpoint already had. */
    res.json(await q(
      `SELECT ${dim} AS label, count(*)::int bookings,
              count(*) FILTER (WHERE deadhead_km IS NOT NULL)::int measured,
              count(*) FILTER (WHERE return_deadhead_km IS NOT NULL)::int measured_return,
              count(*) FILTER (WHERE both_legs_measured)::int measured_both,
              round(sum(deadhead_km)::numeric, 1) deadhead_km,
              round(avg(deadhead_km)::numeric, 2) avg_deadhead_km,
              round(sum(return_deadhead_km)::numeric, 1) return_km,
              round(avg(return_deadhead_km)::numeric, 2) avg_return_km,
              -- Over the bookings where both legs exist, so the two halves of
              -- the sum come from the same rows.
              round(sum(total_deadhead_km) FILTER (WHERE both_legs_measured)::numeric, 1) both_km,
              round(avg(total_deadhead_km) FILTER (WHERE both_legs_measured)::numeric, 2) avg_both_km,
              round(sum(distance_km) FILTER (WHERE has_distance)::numeric, 1) paid_km,
              round((100.0 * sum(deadhead_km)
                     / nullif(sum(distance_km) FILTER (WHERE has_distance), 0))::numeric, 1) ratio_pct,
              round(avg(total_deadhead_pct) FILTER (WHERE both_legs_measured)::numeric, 1) both_ratio_pct,
              -- Where the return leg is long, the driver finished somewhere
              -- with nothing to pick up. That is a dispatch problem with a
              -- location attached, not a driver problem.
              count(*) FILTER (WHERE return_deadhead_km > 15)::int stranded_15km
       FROM trip_ext WHERE ${F} AND platform = 'hotel'
       GROUP BY 1 HAVING count(*) FILTER (WHERE deadhead_km IS NOT NULL
                                             OR return_deadhead_km IS NOT NULL) > 0
       ORDER BY coalesce(sum(total_deadhead_km), sum(deadhead_km)) DESC NULLS LAST LIMIT 60`, p));
  }));

  /* Where a job ENDS and leaves the driver with nothing.
     The corridor view answers "where does work start and finish"; this answers
     the operationally different question of which drop-off points cost the
     most to leave, measured by how far the driver had to go afterwards. A
     limousine fleet's controllable waste lives here rather than in the fare. */
  app.get('/api/corporate/stranding', wrap(async (req, res) => {
    const p = range(req);
    res.json(await q(
      `SELECT coalesce(nullif(btrim(split_part(dropoff_addr, ',', 1)), ''), '(no address)') AS place,
              count(*)::int drops,
              count(*) FILTER (WHERE return_deadhead_km IS NOT NULL)::int measured,
              round(avg(return_deadhead_km)::numeric, 2) avg_return_km,
              round(sum(return_deadhead_km)::numeric, 1) return_km,
              round(max(return_deadhead_km)::numeric, 1) worst_km,
              count(*) FILTER (WHERE return_deadhead_km > 15)::int over_15km,
              round(avg(distance_km) FILTER (WHERE has_distance)::numeric, 1) avg_paid_km
       FROM trip_ext
       WHERE ${F} AND platform = 'hotel' AND dropoff_addr IS NOT NULL
       GROUP BY 1
       HAVING count(*) FILTER (WHERE return_deadhead_km IS NOT NULL) >= 3
       ORDER BY avg_return_km DESC NULLS LAST LIMIT 30`, p));
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
              max(vp.colour) AS colour,
              /* Who ran this car over the window. "L45240 does 4% premium work
                 against a fleet median of 31%" is a finding about a person as
                 much as an asset, and the row used to name only the asset —
                 leaving the reader to open the vehicle page and work backwards
                 to who had it before they could act on anything. */
              ${custodyOverWindow('t.plate')} AS driver_refs,
              ${custodyCountOverWindow('t.plate')} AS driver_n
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

  /* Twenty rows, and it sorted the whole year to reach them.
     ─────────────────────────────────────────────────────────────────────────
     Both grouping keys were view expressions — daypart is a CASE over the
     Dubai hour, and uber_tier is a CASE over product — and Postgres keeps no
     statistics for an expression. It therefore estimated sixty-seven thousand
     groups where a daypart against a tier can only ever produce twenty, ruled
     out a hash aggregate on that estimate, and sorted every Uber trip in the
     window through a temp file instead: eighty-five thousand rows spilled to
     the same disk the backfill is already saturating, to produce twenty.

     So the aggregate is taken at the grain the calendar keys already hold —
     the local hour, day or weekday, as narrow integers beside product, which
     is a real column with real statistics — and the label is applied to the
     twenty-odd rows that come out. Both halves of the distance average travel
     up with them, because an average of averages is not an average. */
  app.get('/api/tiers/mix', wrap(async (req, res) => {
    const p = range(req);
    /* The label of a daypart is a fold of the hour, and the other three
       dimensions are their own label. Written as grain and label rather than
       one dimension because the grain is what the database groups on and the
       label is what the page reads. */
    const by = {
      day: ['local_day', 'k'],
      daypart: ['local_hour', `CASE WHEN k < 5 THEN 'night' WHEN k < 10 THEN 'morning'
                        WHEN k < 15 THEN 'midday' WHEN k < 20 THEN 'evening'
                        ELSE 'late' END`],
      dow: ['local_dow', 'k'],
      hour: ['local_hour', 'k'],
    };
    const [grain, label] = by[req.query.by] || by.daypart;
    /* product rather than uber_tier: the two differ only on rows this filter
       has already excluded, and the real column is the one the planner can
       cost. */
    res.json(await q(
      `WITH mix AS (
         SELECT ${grain} AS k, product AS tier, count(*)::int n,
                sum(distance_km) FILTER (WHERE has_distance) km,
                count(distance_km) FILTER (WHERE has_distance) km_n
           FROM trip_norm
          WHERE ${F} AND platform = 'uber' AND product IS NOT NULL
          GROUP BY 1, 2)
       SELECT ${label} AS label, tier, sum(n)::int n,
              round((sum(km) / nullif(sum(km_n), 0))::numeric, 1) avg_km
         FROM mix GROUP BY 1, 2 ORDER BY 1, n DESC`, p));
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

    /* ── the question this page could not answer ──────────────────────────
       A hole in one source is a collection failure. The SAME hole in two
       independent providers, over the same days, resuming on the same day, is
       almost certainly not: it is a fleet that was not operating.

       This one is live right now. Uber is dark 2025-10-23 → 2026-02-22 and FMS
       is dark 2025-09-21 → 2026-02-22, and the two resume on the identical
       day. Uber's report API and a Chinese telematics box do not share an
       outage. Reading the coverage page as it stood, somebody would spend a
       week trying to re-fetch four months that were never driven.

       The distinction is worth making explicitly rather than leaving to the
       reader, because the two conclusions lead to opposite actions: re-run the
       collector, or stop trying. */
    const dayKeys = [];
    for (let t = Date.parse(from); t <= Date.parse(to); t += 864e5) {
      dayKeys.push(new Date(t).toISOString().slice(0, 10));
    }
    /* Two different populations, deliberately.

       DARK is over sources with a collecting span — a source that has reported
       on exactly one day has no interior, so "it was dark on the 8th" says
       nothing about it.

       LIVE is over EVERY source. Anything that saw a single row that day means
       the day was not silent, whatever the source's span looks like. Computing
       both over the same restricted set let a one-day source report inside a
       claimed fleet-wide silence without breaking it — which is precisely the
       false positive this whole block exists to avoid, since a window that is
       'evidence the fleet was not working' collapses the moment one trip
       lands in it. */
    const spans = out.filter((s) => s.first_day && s.last_day && s.days_with_data > 1);
    const seenBy = new Map(out.map((s) => [s.source, new Set(s.days.map((d) => d.day))]));
    const inSpan = (s, d) => d >= s.first_day && d <= s.last_day;

    const shared = [];
    let run = null;
    for (const d of dayKeys) {
      const dark = spans.filter((s) => inSpan(s, d) && !seenBy.get(s.source).has(d)).map((s) => s.source);
      const live = out.filter((s) => seenBy.get(s.source).has(d)).map((s) => s.source);
      if (dark.length >= 2 && live.length === 0) {
        const key = dark.slice().sort().join(',');
        if (run && run.key === key) { run.to = d; run.days++; }
        else { if (run) shared.push(run); run = { key, sources: dark.slice().sort(), from: d, to: d, days: 1 }; }
      } else if (run) { shared.push(run); run = null; }
    }
    if (run) shared.push(run);

    /* WAS A GAP EVER ASKED FOR?
       ──────────────────────────────────────────────────────────────────────
       This is the distinction that decides what to do about a hole, and it is
       the one the page could not make. FMS is dark for 155 days over a period
       Uber — now fully collected — shows as busy, and the obvious reading was
       a broken collector. The collection_run chunk records say otherwise:
       every window covering that period was requested and came back with zero
       rows and no error. The provider was asked and answered "nothing".

       So the FMS hole is not a collection failure. It is the date the
       telematics boxes started reporting. Nobody should spend another hour
       trying to re-fetch it, and nothing in this product said so until the
       per-window records existed to say it.

       Only chunks that SUCCEEDED and returned nothing count as an answer. A
       window that errored is still an open question. */
    const attempts = await q(
      `SELECT source,
              (c ->> 'from') AS from_day, (c ->> 'to') AS to_day,
              (c ->> 'rows')::int AS rows,
              (c ->> 'error') IS NOT NULL AS failed,
              max(finished_at) AS last_tried
       FROM collection_run r, jsonb_array_elements(coalesce(r.detail -> 'chunks', '[]'::jsonb)) c
       WHERE c ? 'from' AND c ? 'to'
       GROUP BY 1, 2, 3, 4, 5`);

    const answeredEmpty = new Map();   // source -> [{from,to,last_tried}]
    const failedWindows = new Map();
    for (const a of attempts) {
      if (!a.from_day || !a.to_day) continue;
      const target = a.failed ? failedWindows : (a.rows === 0 ? answeredEmpty : null);
      if (!target) continue;
      if (!target.has(a.source)) target.set(a.source, []);
      target.get(a.source).push({ from: a.from_day, to: a.to_day, last_tried: a.last_tried });
    }
    /* Coverage is by the UNION of windows, not by any single one.
       The first version of this asked whether ONE chunk spanned the whole gap.
       Collectors chunk by month; a 155-day hole is never spanned by a monthly
       window, so the live FMS gap — requested six times over, every window
       answered with zero rows and no error — was labelled "no record of
       asking", which is the opposite of what the records say. The check has to
       be per day: is every day of this hole inside some window that came back?

       A day inside a FAILED window outranks everything, because one failed
       request is enough to make the whole answer unsafe. */
    const dayList = (gFrom, gTo) => {
      const out2 = [];
      for (let t = Date.parse(gFrom); t <= Date.parse(gTo); t += 864e5) {
        out2.push(new Date(t).toISOString().slice(0, 10));
      }
      return out2;
    };
    const inAny = (wins, d) => (wins || []).some((w) => w.from <= d && w.to >= d);

    for (const s of out) {
      const ok = answeredEmpty.get(s.source);
      const bad = failedWindows.get(s.source);
      s.gaps = (s.gaps || []).map((g) => {
        const days = dayList(g.from, g.to);
        const failedDays = days.filter((d) => inAny(bad, d)).length;
        const answeredDays = days.filter((d) => !inAny(bad, d) && inAny(ok, d)).length;
        return {
          ...g,
          // Three states, and only one of them is a bug worth chasing.
          verdict: failedDays ? 'window_failed'
            : answeredDays === days.length ? 'asked_and_empty'
              : 'never_asked',
          // A partly-requested gap is still "never asked" as a verdict — you
          // cannot conclude anything from a hole with unrequested days in it —
          // but saying how much of it WAS requested is the difference between
          // "start the backfill" and "it is nearly done".
          days_answered: answeredDays,
          days_failed: failedDays,
          days_unrequested: days.length - answeredDays - failedDays,
        };
      });
      s.gaps_asked_and_empty = s.gaps.filter((g) => g.verdict === 'asked_and_empty')
        .reduce((a, g) => a + g.days, 0);
      s.gaps_never_asked = s.gaps.filter((g) => g.verdict === 'never_asked')
        .reduce((a, g) => a + g.days, 0);
      s.gaps_window_failed = s.gaps.filter((g) => g.verdict === 'window_failed')
        .reduce((a, g) => a + g.days, 0);
    }

    res.json({
      window: [from, to],
      sources: out,
      /* Windows where two or more independent sources were each inside their
         own collecting span and each saw nothing, with no other source seeing
         anything either. Reported separately from per-source gaps because the
         conclusion is different: this is evidence about the fleet, not about
         the collector. */
      shared_silence: shared
        .filter((g) => g.days >= 3)
        .sort((a, b) => b.days - a.days)
        .slice(0, 10)
        .map(({ key, ...g }) => g),
    });
  }));

  /* ───────────────────────── corridors ─────────────────────────
     Where the work starts and ends. Every channel returns a formatted address
     rather than a place id, so the community is parsed out of the string; the
     response says so, because a parsed area is evidence of a pattern and not a
     geofence.

     The page asks three things — which corridors carry the work, which areas
     the work starts in, and how many of each there are altogether — and it
     asked them as five separate aggregations of the same window, each one
     pulling the same address strings apart again to build its group key. All
     three are readings of one table at corridor grain, so the corridor grain
     is computed once and everything else is derived from it.

     The origins panel and the three tiles are over a NARROWER set of rows than
     the corridor list: a trip that names only a drop-off is a corridor out of
     nowhere, and it has no origin at all. That restriction rides on the
     corridor row as a count of its own rather than becoming another pass.

     The three shapes come back in one result set with a kind on each row,
     because splitting them in JS costs nothing and a second statement would
     cost a second scan. */
  app.get('/api/geo/corridors', wrap(async (req, res) => {
    const p = range(req);
    const rows = await q(
      `WITH base AS (
         SELECT coalesce(${areaOf('pickup_addr')}, '(unrecorded)') AS from_area,
                coalesce(${areaOf('dropoff_addr')}, '(unrecorded)') AS to_area,
                count(*)::int AS trips,
                round(avg(distance_km) FILTER (WHERE has_distance)::numeric, 1) AS avg_km,
                round(avg(duration_s)::numeric / 60, 1) AS avg_min,
                count(*) FILTER (WHERE price IS NOT NULL)::int AS priced,
                round(avg(price) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary)::numeric, 2) AS avg_fare,
                array_agg(DISTINCT platform) AS platforms,
                -- The pickup-only measures, carried at corridor grain so the
                -- origins panel is a roll-up rather than another scan. The
                -- distance average is kept as its two halves because an
                -- average of averages is not an average.
                count(*) FILTER (WHERE pickup_addr IS NOT NULL)::int AS from_trips,
                count(*) FILTER (WHERE pickup_addr IS NOT NULL AND local_hour BETWEEN 5 AND 9)::int AS from_morning,
                count(*) FILTER (WHERE pickup_addr IS NOT NULL AND local_hour BETWEEN 16 AND 21)::int AS from_evening,
                sum(distance_km) FILTER (WHERE has_distance AND pickup_addr IS NOT NULL) AS from_km,
                count(distance_km) FILTER (WHERE has_distance AND pickup_addr IS NOT NULL) AS from_km_n
           FROM trip_ext
          WHERE ${F} AND (pickup_addr IS NOT NULL OR dropoff_addr IS NOT NULL)
          GROUP BY 1, 2),
       corridor AS (
         SELECT row_number() OVER () AS seq, c.*
           FROM (SELECT * FROM base WHERE trips >= 3 ORDER BY trips DESC LIMIT 120) c),
       origin AS (
         SELECT row_number() OVER () AS seq, o.*
           FROM (SELECT from_area AS area, sum(from_trips)::int AS trips,
                        sum(from_morning)::int AS morning, sum(from_evening)::int AS evening,
                        round((sum(from_km) / nullif(sum(from_km_n), 0))::numeric, 1) AS avg_km
                   FROM base GROUP BY 1 HAVING sum(from_trips) > 0
                  ORDER BY trips DESC LIMIT 60) o)
       SELECT 'corridor' AS kind, seq, from_area, to_area, trips, avg_km, avg_min, priced,
              avg_fare, platforms, NULL::int AS morning, NULL::int AS evening,
              NULL::int AS corridors_3plus, NULL::int AS corridors_all, NULL::int AS origins_all
         FROM corridor
       UNION ALL
       SELECT 'origin', seq, area, NULL, trips, avg_km, NULL, NULL,
              NULL, NULL, morning, evening,
              NULL, NULL, NULL
         FROM origin
       UNION ALL
       /* Counted over every corridor, not over the lists. The page's "Distinct
          pickup areas" and "Corridors seen 3+ times" tiles were the lengths of
          lists capped at 60 and 120 rows — right until the fleet works more
          than 120 distinct corridors, at which point both tiles quietly become
          the cap. One row, always, so an empty window still states its zeroes. */
       SELECT 'total', 0, NULL, NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, NULL, NULL,
              count(*) FILTER (WHERE from_trips >= 3)::int,
              count(*) FILTER (WHERE from_trips > 0)::int,
              count(DISTINCT from_area) FILTER (WHERE from_trips > 0 AND from_area <> '(unrecorded)')::int
         FROM base
       ORDER BY 1, 2`, p);

    const totalRow = rows.find((r) => r.kind === 'total');
    const t = {
      corridors_3plus: totalRow?.corridors_3plus ?? 0,
      corridors_all: totalRow?.corridors_all ?? 0,
      origins_all: totalRow?.origins_all ?? 0,
    };
    const corridors = rows.filter((r) => r.kind === 'corridor').map((r) => ({
      from_area: r.from_area, to_area: r.to_area, trips: r.trips, avg_km: r.avg_km,
      avg_min: r.avg_min, priced: r.priced, avg_fare: r.avg_fare, platforms: r.platforms,
    }));
    const origins = rows.filter((r) => r.kind === 'origin').map((r) => ({
      area: r.from_area, trips: r.trips, morning: r.morning, evening: r.evening, avg_km: r.avg_km,
    }));
    const shown = corridors.filter((r) => r.from_area !== '(unrecorded)' || r.to_area !== '(unrecorded)');
    res.json({
      note: 'Areas are parsed from the address text each provider returns, not from a place id.',
      corridors: shown,
      origins,
      totals: t,
      shown: shown.length,
      truncated: t.corridors_all > shown.length,
      origins_shown: origins.length,
      origins_truncated: t.origins_all > origins.length,
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
