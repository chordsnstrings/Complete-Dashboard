/* Per-driver detail API.
   ─────────────────────────────────────────────────────────────────────────
   One human can be several records: Uber issues a UUID, Yango a different id,
   Bolt a third, and the hotel channel a fourth — all for the same person. The
   only thing they share is the name they are entered under, and even that is
   inconsistent ("Najeeb Ullah Khan" vs "Najeeb Ullah Khan Khan"). So every
   endpoint here starts by resolving the requested id into the *set* of records
   that plausibly belong to one driver, and answers over that whole set.

   Resolution is deliberately conservative: we match on an exact normalised
   name, never on a fuzzy score, because merging two real people into one page
   is a worse failure than showing the same person twice. */

const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();

// Some feeds duplicate the surname ("Khan Khan", "Afzal Afzal"). Collapsing an
// immediately-repeated final word is safe — it never merges distinct names.
function canonName(s) {
  const parts = norm(s).split(' ').filter(Boolean);
  while (parts.length > 2 && parts[parts.length - 1] === parts[parts.length - 2]) parts.pop();
  return parts.join(' ');
}

export function driverRoutes(app, { q, wrap, endOfDay }) {
  const win = (req) => [req.query.from || '2000-01-01', endOfDay(req.query.to || '2100-01-01')];
  /* Dubai calendar days, matching trip_norm.local_day and every other endpoint.
     Binding a bare date against a timestamptz in a UTC session made the window
     start at 04:00 Dubai and end at 03:59 the following day, so this page and
     the /api/vehicles panel beside it disagreed about the same plate. */
  const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const winDays = (req) => [
    isDay(req.query.from) ? req.query.from : '2000-01-01',
    isDay(req.query.to) ? req.query.to : '2100-01-01',
  ];

  /* Resolve `?id=` (a platform driver id) or `?name=` into every record for that
     person. Returns null when nothing matches, so callers can 404 honestly. */
  async function resolve(req) {
    const id = req.query.id || null;
    const nameQ = req.query.name || null;
    let seed = null;
    if (id) {
      [seed] = await q(
        `SELECT driver_ext_id, driver_name, platform FROM trip
         WHERE driver_ext_id = $1 AND driver_name IS NOT NULL ORDER BY requested_at DESC LIMIT 1`, [id]);
      if (!seed) [seed] = await q(
        `SELECT driver_ext_id, full_name AS driver_name, platform FROM driver_compliance
         WHERE driver_ext_id = $1 LIMIT 1`, [id]);
      if (!seed) [seed] = await q(
        `SELECT driver_ext_id, driver_name, platform FROM driver_performance
         WHERE driver_ext_id = $1 ORDER BY period_end DESC LIMIT 1`, [id]);
      // last resort: the id exists on trips but nothing ever gave it a name
      if (!seed) [seed] = await q(
        `SELECT driver_ext_id, driver_name, platform FROM trip
         WHERE driver_ext_id = $1 ORDER BY requested_at DESC LIMIT 1`, [id]);
      if (!seed && !nameQ) return null;          // unknown id — say so rather than answering emptily
    }
    const name = seed?.driver_name || nameQ;
    if (!name) return id ? { id, name: null, ids: [id], platforms: seed ? [seed.platform] : [] } : null;

    // every id sharing the canonical name, across all sources that carry names
    const aliasRows = name ? await q(
      `SELECT DISTINCT platform, driver_ext_id, driver_name FROM (
         SELECT platform, driver_ext_id, driver_name FROM trip WHERE driver_ext_id IS NOT NULL
         UNION ALL SELECT platform, driver_ext_id, full_name FROM driver_compliance
         UNION ALL SELECT platform, driver_ext_id, driver_name FROM driver_performance
       ) s WHERE driver_ext_id IS NOT NULL AND driver_name IS NOT NULL`) : [];
    const want = canonName(name);
    const alias = aliasRows.filter((r) => canonName(r.driver_name) === want);
    const ids = [...new Set([...alias.map((a) => a.driver_ext_id), ...(id ? [id] : [])])];
    if (!ids.length) return null;
    // the longest spelling is usually the fullest one; prefer it for display
    const display = alias.map((a) => a.driver_name).sort((a, b) => b.length - a.length)[0] || name;
    return { id: id || ids[0], name: display, ids, platforms: [...new Set(alias.map((a) => a.platform))] };
  }

  // Shared trip predicate: any of this person's ids, over the window.
  // `$1..$2` window, `$3` id array — keep this argument order in every query.
  const TW = `driver_ext_id = ANY($3) AND requested_at BETWEEN $1 AND $2`;

  // Wrap a handler so it resolves the driver first and 404s cleanly when unknown.
  const withDriver = (fn) => wrap(async (req, res) => {
    const d = await resolve(req);
    if (!d) return res.status(404).json({ error: 'driver not found' });
    return fn(req, res, d, [...win(req), d.ids]);
  });

  /* ── directory: every driver we know of, one row each ─────────────────
     Four things were wrong here and all four made the page describe the fleet
     as busier and cleaner than it is:

       - it was built FROM the trip table, so a driver who took nothing in the
         window had no row at all — under a panel headed "All drivers". Sixty-
         four of the people missing that way had an expired licence, which is
         exactly who an operator opens this page to find. The sibling vehicle
         directory does the opposite on purpose and says so.
       - the window was bound as a raw timestamptz in a UTC session, so it
         dropped the Dubai 00:00-04:00 slice of the first day and added a
         phantom one after the last — and the /api/vehicles panel on the same
         screen used Dubai days, so the two disagreed about the same plate.
       - the fold summed trips and kilometres but never recomputed
         completion_pct, so a person carried whichever account happened to be
         listed first — presented as that human's completion rate.
       - `days` took the MAX across a person's accounts rather than the union,
         so days worked on one platform and not another were discarded.

     Completion is over trip_norm.outcome, not status='completed': Bolt says
     'finished', and testing for 'completed' scored every completed Bolt trip
     as a failure. */
  app.get('/api/drivers/directory', wrap(async (req, res) => {
    const [from, to] = winDays(req);
    const rows = await q(
      `WITH ids AS (
         -- Everyone we know of, from any source, whether or not they drove.
         SELECT DISTINCT driver_ext_id, driver_name FROM trip
           WHERE driver_ext_id IS NOT NULL AND coalesce(btrim(driver_name), '') <> ''
         UNION
         SELECT driver_ext_id, full_name FROM driver_compliance
           WHERE driver_ext_id IS NOT NULL AND coalesce(btrim(full_name), '') <> ''
         UNION
         SELECT driver_ext_id, full_name FROM driver_platform_state
           WHERE driver_ext_id IS NOT NULL AND coalesce(btrim(full_name), '') <> ''
       ),
       who AS (
         SELECT driver_ext_id, max(driver_name) AS driver_name FROM ids GROUP BY 1
       ),
       t AS (
         SELECT driver_ext_id, min(fleet_id) fleet_id,
                count(*) FILTER (WHERE is_booking)::int trips,
                count(*) FILTER (WHERE outcome = 'completed')::int completed,
                count(*) FILTER (WHERE outcome IS NOT NULL)::int bookable,
                count(DISTINCT local_day)::int days,
                round(sum(distance_km) FILTER (WHERE is_booking AND has_distance)::numeric,0) km,
                round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue,
                count(*) FILTER (WHERE has_fare)::int priced_trips,
                max(requested_at) last_trip, min(requested_at) first_trip,
                array_agg(DISTINCT platform) platforms,
                mode() WITHIN GROUP (ORDER BY plate) plate
         FROM trip_norm
         WHERE local_day BETWEEN $1::date AND $2::date AND driver_ext_id IS NOT NULL
         GROUP BY driver_ext_id
       ),
       -- The last trip EVER, so "has not driven in this window" and "has never
       -- driven" are different rows rather than the same blank.
       ever AS (
         SELECT driver_ext_id, max(requested_at) last_ever, count(*)::int lifetime
         FROM trip WHERE driver_ext_id IS NOT NULL GROUP BY 1
       )
       SELECT who.driver_ext_id, who.driver_name,
              coalesce(t.trips, 0) AS trips, coalesce(t.completed, 0) AS completed,
              coalesce(t.bookable, 0) AS bookable, coalesce(t.days, 0) AS days,
              t.km, t.revenue, coalesce(t.priced_trips, 0) AS priced_trips,
              t.last_trip, t.first_trip, t.plate, t.fleet_id,
              coalesce(t.platforms, ARRAY[]::text[]) AS platforms,
              ev.last_ever, coalesce(ev.lifetime, 0) AS lifetime_trips,
              dc.state, dc.licence_expires, dc.rating,
              (dc.licence_expires - now()::date) AS licence_days_left,
              dps.state AS platform_state, dps.can_earn
       FROM who
       LEFT JOIN t   ON t.driver_ext_id = who.driver_ext_id
       LEFT JOIN ever ev ON ev.driver_ext_id = who.driver_ext_id
       LEFT JOIN driver_compliance dc ON dc.driver_ext_id = who.driver_ext_id
       LEFT JOIN driver_platform_state dps ON dps.driver_ext_id = who.driver_ext_id
       ORDER BY coalesce(t.trips, 0) DESC, who.driver_name LIMIT 800`, [from, to]);

    /* Fold per-platform rows into one row per person, so the directory lists
       humans rather than accounts. Counts are carried through and the ratios
       are computed ONCE at the end — folding a pre-computed percentage keeps
       one account's number and calls it the person's. */
    const byName = new Map();
    for (const r of rows) {
      const k = canonName(r.driver_name);
      const cur = byName.get(k);
      if (!cur) {
        byName.set(k, { ...r, ids: [r.driver_ext_id], platforms: [...(r.platforms || [])],
          _days: new Set() });
        continue;
      }
      cur.ids.push(r.driver_ext_id);
      cur.trips += r.trips;
      cur.completed += r.completed; cur.bookable += r.bookable;
      cur.priced_trips += r.priced_trips;
      cur.lifetime_trips += r.lifetime_trips;
      cur.km = +(cur.km || 0) + +(r.km || 0);
      cur.revenue = +(cur.revenue || 0) + +(r.revenue || 0);
      cur.platforms = [...new Set([...cur.platforms, ...(r.platforms || [])])];
      if ((r.driver_name || '').length > (cur.driver_name || '').length) cur.driver_name = r.driver_name;
      if (r.last_trip > cur.last_trip) cur.last_trip = r.last_trip;
      if (r.first_trip && (!cur.first_trip || r.first_trip < cur.first_trip)) cur.first_trip = r.first_trip;
      if (r.last_ever > cur.last_ever) cur.last_ever = r.last_ever;
      cur.state = cur.state || r.state;
      cur.platform_state = cur.platform_state || r.platform_state;
      if (r.licence_days_left != null && (cur.licence_days_left == null || r.licence_days_left < cur.licence_days_left)) {
        cur.licence_days_left = r.licence_days_left; cur.licence_expires = r.licence_expires;
      }
      cur._multiAccountDays = true;
    }

    /* Distinct working days across ALL of a person's accounts. Taking the max
       of pre-aggregated per-account counts discarded every day worked on one
       platform and not another. Only asked for the people who actually have
       more than one account. */
    const multi = [...byName.values()].filter((p) => p.ids.length > 1);
    if (multi.length) {
      const dayRows = await q(
        `SELECT driver_ext_id, local_day FROM trip_norm
         WHERE local_day BETWEEN $1::date AND $2::date
           AND driver_ext_id = ANY($3)`,
        [from, to, multi.flatMap((p) => p.ids)]);
      const idToPerson = new Map();
      multi.forEach((p) => p.ids.forEach((id) => idToPerson.set(id, p)));
      const days = new Map();
      for (const d of dayRows) {
        const person = idToPerson.get(d.driver_ext_id);
        if (!person) continue;
        const set = days.get(person) || new Set();
        set.add(String(d.local_day).slice(0, 10));
        days.set(person, set);
      }
      days.forEach((set, person) => { person.days = set.size; });
    }

    res.json([...byName.values()].map((p) => {
      delete p._days; delete p._multiAccountDays;
      return {
        ...p,
        // Computed once, over the whole person.
        completion_pct: p.bookable ? Math.round((p.completed / p.bookable) * 100) : null,
        // "No trip in this window" and "never driven" are different facts.
        active_in_window: p.trips > 0,
        ever_driven: (p.lifetime_trips || 0) > 0,
      };
    }).sort((a, b) => b.trips - a.trips || String(a.driver_name).localeCompare(String(b.driver_name))));
  }));

  /* ── who this is: identity, credentials, platforms, tenure ─────────── */
  app.get('/api/driver/profile', withDriver(async (req, res, d, p) => {
    const [span] = await q(
      `SELECT min(requested_at) first_trip, max(requested_at) last_trip, count(*)::int trips,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)::int days_worked,
              count(DISTINCT plate)::int vehicles, min(fleet_id) fleet_id
       FROM trip WHERE ${TW}`, p);
    const compliance = await q(
      `SELECT platform, driver_ext_id, full_name, phone, emirates_id, licence_no, licence_expires,
              (licence_expires - now()::date) AS licence_days_left, state, suspension_reason,
              rating, device_brand, device_model, updated_at
       FROM driver_compliance WHERE driver_ext_id = ANY($1)`, [d.ids]);
    const vehicles = await q(
      `SELECT plate, count(*)::int days, sum(trips)::int trips, round(sum(km)::numeric,0) km,
              round(sum(revenue)::numeric,0) revenue, min(day) first_day, max(day) last_day,
              bool_or(is_primary) ever_primary
       FROM vehicle_driver_day WHERE driver_ext_id = ANY($1)
       GROUP BY plate ORDER BY days DESC LIMIT 40`, [d.ids]);
    const accounts = await q(
      `SELECT platform, driver_ext_id, count(*)::int trips, min(requested_at) first_trip,
              max(requested_at) last_trip
       FROM trip WHERE driver_ext_id = ANY($1) GROUP BY 1,2 ORDER BY trips DESC`, [d.ids]);
    res.json({ ...d, span, compliance, vehicles, accounts });
  }));

  /* ── headline numbers, plus the shift shape the mockup asks for ────── */
  app.get('/api/driver/kpis', withDriver(async (req, res, d, p) => {
    const [t] = await q(
      `SELECT count(*)::int trips,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)::int days_worked,
              round(sum(distance_km)::numeric,0) km, round(avg(distance_km)::numeric,1) avg_km,
              round(sum(price)::numeric,2) revenue,
              round(avg(price)::numeric,2) avg_fare,
              round(100.0*sum((status='completed')::int)/nullif(count(*),0),1) completion_pct,
              round(100.0*sum((status ILIKE '%cancel%')::int)/nullif(count(*),0),1) cancel_pct,
              round(avg(duration_s)::numeric/60,1) avg_minutes,
              count(DISTINCT plate)::int vehicles, count(DISTINCT platform)::int platforms
       FROM trip WHERE ${TW}`, p);
    // "typical start" — the median hour of the first trip of each working day,
    // which is a far better description of a shift than the mean of all trips.
    const [shift] = await q(
      `WITH d AS (
         SELECT (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
                min(requested_at AT TIME ZONE 'Asia/Dubai') first_local,
                max(requested_at AT TIME ZONE 'Asia/Dubai') last_local
         FROM trip WHERE ${TW} GROUP BY 1)
       SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from first_local::time))/3600 median_start_h,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch from last_local::time))/3600 median_end_h,
              round(avg(extract(epoch from (last_local-first_local))/3600)::numeric,1) avg_span_h,
              round(stddev_samp(extract(epoch from first_local::time)/3600)::numeric,2) start_consistency_h
       FROM d`, p);
    const [perf] = await q(
      `SELECT round(sum(hours_online)::numeric,1) hours_online,
              round(sum(hours_on_trip)::numeric,1) hours_on_trip,
              round(avg(acceptance_rate)::numeric,3) acceptance_rate,
              round(avg(cancellation_rate)::numeric,3) cancellation_rate,
              round(avg(rating)::numeric,2) rating,
              round(sum(earnings)::numeric,2) reported_earnings,
              round(sum(cash_earnings)::numeric,2) cash_earnings
       FROM driver_performance
       WHERE driver_ext_id = ANY($3) AND period_start >= $1::date AND period_end <= $2::date`, p);
    res.json({ ...t, ...shift, ...perf,
      trips_per_day: t.days_worked ? +(t.trips / t.days_worked).toFixed(1) : null,
      utilisation_pct: perf?.hours_online ? +((perf.hours_on_trip / perf.hours_online) * 100).toFixed(1) : null });
  }));

  /* ── day by day: the spine every chart on the detail page hangs off ── */
  app.get('/api/driver/daily', withDriver(async (req, res, d, p) => res.json(await q(
    `WITH t AS (
       SELECT (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
              count(*)::int trips,
              sum((status='completed')::int)::int completed,
              sum((status ILIKE '%cancel%')::int)::int cancelled,
              round(sum(distance_km)::numeric,1) km,
              round(sum(price)::numeric,2) revenue,
              min(requested_at) first_trip_at, max(requested_at) last_trip_at,
              extract(epoch from (min(requested_at AT TIME ZONE 'Asia/Dubai')::time))/3600 first_hour,
              extract(epoch from (max(requested_at AT TIME ZONE 'Asia/Dubai')::time))/3600 last_hour,
              round((extract(epoch from (max(requested_at)-min(requested_at)))/3600)::numeric,2) span_h,
              string_agg(DISTINCT plate, ',') plates,
              string_agg(DISTINCT platform, ',') platforms
       FROM trip WHERE ${TW} GROUP BY 1),
     h AS (
       SELECT period_start AS day, sum(hours_online) hours_online, sum(hours_on_trip) hours_on_trip,
              sum(earnings) earnings
       FROM driver_performance
       WHERE driver_ext_id = ANY($3) AND period_start = period_end
         AND period_start BETWEEN $1::date AND $2::date
       GROUP BY 1)
     SELECT t.*, round(h.hours_online::numeric,2) hours_online,
            round(h.hours_on_trip::numeric,2) hours_on_trip,
            round(h.earnings::numeric,2) platform_earnings,
            w.temp_max, w.precipitation, c.is_holiday, c.holiday_name, c.is_ramadan
     FROM t LEFT JOIN h USING (day)
            LEFT JOIN weather_daily w ON w.day = t.day
            LEFT JOIN calendar_day c ON c.day = t.day
     ORDER BY t.day`, p))));

  /* ── weekday × hour: when this person actually works ───────────────── */
  app.get('/api/driver/heatmap', withDriver(async (req, res, d, p) => res.json(await q(
    `SELECT extract(dow from requested_at AT TIME ZONE 'Asia/Dubai')::int dow,
            extract(hour from requested_at AT TIME ZONE 'Asia/Dubai')::int h,
            count(*)::int trips, round(sum(price)::numeric,0) revenue
     FROM trip WHERE ${TW} GROUP BY 1,2 ORDER BY 1,2`, p))));

  /* ── standing against the fleet, as percentiles ────────────────────── */
  // Percentile answers "where does this driver sit", which a raw number never
  // does. Anyone with fewer than 5 trips in the window is excluded from the
  // comparison set — otherwise a single-trip driver distorts every rank.
  app.get('/api/driver/standing', withDriver(async (req, res, d, p) => {
    const peers = await q(
      `SELECT driver_ext_id,
              count(*)::int trips,
              count(DISTINCT (requested_at AT TIME ZONE 'Asia/Dubai')::date)::int days,
              sum(distance_km) km, sum(price) revenue,
              avg(distance_km) avg_km,
              100.0*sum((status='completed')::int)/nullif(count(*),0) completion,
              100.0*sum((status ILIKE '%cancel%')::int)/nullif(count(*),0) cancel
       FROM trip WHERE requested_at BETWEEN $1 AND $2 AND driver_ext_id IS NOT NULL
       GROUP BY 1 HAVING count(*) >= 5`, [p[0], p[1]]);
    const mineIds = new Set(d.ids);
    const mine = peers.filter((r) => mineIds.has(r.driver_ext_id));
    if (!mine.length) return res.json({ n_peers: peers.length, metrics: [] });
    const sum = (k) => mine.reduce((a, r) => a + (+r[k] || 0), 0);
    const wavg = (k) => { const t = sum('trips'); return t ? mine.reduce((a, r) => a + (+r[k] || 0) * r.trips, 0) / t : null; };
    const me = {
      trips: sum('trips'), km: sum('km'), revenue: sum('revenue'),
      days: Math.max(...mine.map((r) => r.days)),
      avg_km: wavg('avg_km'), completion: wavg('completion'), cancel: wavg('cancel'),
      trips_per_day: null,
    };
    me.trips_per_day = me.days ? me.trips / me.days : null;

    // Peer values are folded to one per person too, so a driver split across
    // two platforms isn't counted as two mediocre drivers.
    const folded = new Map();
    for (const r of peers) {
      const k = mineIds.has(r.driver_ext_id) ? '__me__' : r.driver_ext_id;
      const c = folded.get(k) || { trips: 0, km: 0, revenue: 0, days: 0, _cw: 0, avg_km: 0, completion: 0, cancel: 0 };
      c.trips += r.trips; c.km += +r.km || 0; c.revenue += +r.revenue || 0;
      c.days = Math.max(c.days, r.days);
      c._cw += r.trips;
      c.avg_km += (+r.avg_km || 0) * r.trips;
      c.completion += (+r.completion || 0) * r.trips;
      c.cancel += (+r.cancel || 0) * r.trips;
      folded.set(k, c);
    }
    for (const c of folded.values()) {
      if (c._cw) { c.avg_km /= c._cw; c.completion /= c._cw; c.cancel /= c._cw; }
      c.trips_per_day = c.days ? c.trips / c.days : 0;
    }
    const pop = [...folded.values()];
    const pct = (key, higherIsBetter = true) => {
      const vals = pop.map((c) => +c[key] || 0).sort((a, b) => a - b);
      const v = +me[key] || 0;
      let below = 0; while (below < vals.length && vals[below] < v) below++;
      const raw = vals.length > 1 ? (below / (vals.length - 1)) * 100 : 50;
      return { value: v, percentile: Math.round(higherIsBetter ? raw : 100 - raw),
        median: vals[Math.floor(vals.length / 2)] };
    };
    res.json({
      n_peers: pop.length,
      metrics: [
        { key: 'trips', label: 'Trips completed', ...pct('trips') },
        { key: 'trips_per_day', label: 'Trips per working day', ...pct('trips_per_day') },
        { key: 'km', label: 'Distance driven', ...pct('km') },
        { key: 'avg_km', label: 'Average trip length', ...pct('avg_km') },
        { key: 'days', label: 'Days worked', ...pct('days') },
        { key: 'completion', label: 'Completion rate', ...pct('completion') },
        { key: 'cancel', label: 'Cancellation rate', ...pct('cancel', false) },
        { key: 'revenue', label: 'Revenue booked', ...pct('revenue') },
      ].filter((m) => m.value || m.median),
    });
  }));

  /* ── territory: where they pick up, and where they wait ────────────── */
  app.get('/api/driver/territory', withDriver(async (req, res, d, p) => {
    const pickups = await q(
      `SELECT round(pickup_lat::numeric,4) lat, round(pickup_lng::numeric,4) lng,
              count(*)::int n, max(pickup_addr) addr, round(avg(distance_km)::numeric,1) avg_km,
              round(avg(price)::numeric,2) avg_fare
       FROM trip WHERE ${TW} AND pickup_lat IS NOT NULL AND pickup_lat <> 0
       GROUP BY 1,2 ORDER BY n DESC LIMIT 400`, p);
    const dropoffs = await q(
      `SELECT round(dropoff_lat::numeric,4) lat, round(dropoff_lng::numeric,4) lng,
              count(*)::int n, max(dropoff_addr) addr
       FROM trip WHERE ${TW} AND dropoff_lat IS NOT NULL AND dropoff_lat <> 0
       GROUP BY 1,2 ORDER BY n DESC LIMIT 400`, p);
    // Named areas, coarser than a coordinate — useful as a list next to the map.
    const areas = await q(
      `SELECT split_part(pickup_addr, ' - ', 1) area, count(*)::int n,
              round(avg(distance_km)::numeric,1) avg_km, round(avg(price)::numeric,2) avg_fare
       FROM trip WHERE ${TW} AND pickup_addr IS NOT NULL AND pickup_addr <> ''
       GROUP BY 1 ORDER BY n DESC LIMIT 25`, p);
    // Where the vehicle sat still between jobs — telemetry, not trips, so it is
    // only available for plates this driver held on days we have GPS for.
    const idle = await q(
      `WITH days AS (SELECT DISTINCT plate, day FROM vehicle_driver_day
                     WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date)
       SELECT round(s.lat::numeric,3) lat, round(s.lng::numeric,3) lng, count(*)::int fixes
       FROM telemetry_snapshot s JOIN days ON days.plate = s.plate
            AND (s.captured_at AT TIME ZONE 'Asia/Dubai')::date = days.day
       WHERE coalesce(s.speed,0) < 2 AND s.lat IS NOT NULL
       GROUP BY 1,2 HAVING count(*) >= 3 ORDER BY fixes DESC LIMIT 120`, p);
    res.json({ pickups, dropoffs, areas, idle });
  }));

  /* ── the shape of the work: distance, product, payment, outcome ────── */
  app.get('/api/driver/mix', withDriver(async (req, res, d, p) => {
    const bucket = await q(
      `SELECT CASE WHEN distance_km < 3 THEN '0–3 km'
                   WHEN distance_km < 7 THEN '3–7 km'
                   WHEN distance_km < 15 THEN '7–15 km'
                   WHEN distance_km < 30 THEN '15–30 km'
                   WHEN distance_km < 60 THEN '30–60 km'
                   ELSE '60 km+' END label,
              CASE WHEN distance_km < 3 THEN 1 WHEN distance_km < 7 THEN 2 WHEN distance_km < 15 THEN 3
                   WHEN distance_km < 30 THEN 4 WHEN distance_km < 60 THEN 5 ELSE 6 END ord,
              count(*)::int n, round(sum(price)::numeric,0) revenue,
              round(avg(price)::numeric,2) avg_fare
       FROM trip WHERE ${TW} AND distance_km IS NOT NULL GROUP BY 1,2 ORDER BY ord`, p);
    const one = (col) => q(
      `SELECT coalesce(${col},'unknown') label, count(*)::int n, round(sum(price)::numeric,0) revenue
       FROM trip WHERE ${TW} GROUP BY 1 ORDER BY n DESC LIMIT 20`, p);
    const [product, payment, status, platform] = await Promise.all(
      [one('product'), one('payment_type'), one('status'), one('platform')]);
    res.json({ distance: bucket, product, payment, status, platform });
  }));

  /* ── money: platform-reported components and the daily earnings line ─ */
  app.get('/api/driver/earnings', withDriver(async (req, res, d, p) => {
    const components = await q(
      `SELECT category, parent, round(sum(amount)::numeric,2) amount, currency
       FROM driver_earnings_component
       WHERE driver_ext_id = ANY($3) AND period_start >= $1::date AND period_end <= $2::date
       GROUP BY 1,2,4 ORDER BY abs(sum(amount)) DESC`, p);
    const periods = await q(
      `SELECT platform, period_start, period_end, trips, hours_online, hours_on_trip,
              earnings, cash_earnings, acceptance_rate, cancellation_rate, rating
       FROM driver_performance
       WHERE driver_ext_id = ANY($3) AND period_start >= $1::date AND period_end <= $2::date
       ORDER BY period_start DESC LIMIT 120`, p);
    const [tips] = await q(
      `SELECT round(sum(amount) FILTER (WHERE category='tip')::numeric,2) tips,
              round(sum(amount) FILTER (WHERE category='net_fare')::numeric,2) fare
       FROM driver_earnings_component
       WHERE driver_ext_id = ANY($3) AND period_start >= $1::date AND period_end <= $2::date`, p);
    res.json({ components, periods,
      tips: tips?.tips ?? null, fare: tips?.fare ?? null,
      tip_pct: tips?.fare > 0 ? +((tips.tips / tips.fare) * 100).toFixed(2) : null });
  }));

  /* ── quality: cancellations, safety events, unauthorised use ───────── */
  app.get('/api/driver/quality', withDriver(async (req, res, d, p) => {
    const cancels = await q(
      `SELECT coalesce(status,'unknown') status, count(*)::int n,
              round(100.0*count(*)/sum(count(*)) OVER (),1) pct
       FROM trip WHERE ${TW} AND status IS NOT NULL AND status <> 'completed'
       GROUP BY 1 ORDER BY n DESC LIMIT 12`, p);
    const cancelDaily = await q(
      `SELECT (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
              sum((status ILIKE '%cancel%')::int)::int cancelled, count(*)::int trips
       FROM trip WHERE ${TW} GROUP BY 1 ORDER BY 1`, p);
    // Harsh-driving events are recorded against the vehicle, so they are only
    // this driver's when they held the vehicle that day.
    // DISTINCT matters: vehicle_driver_day carries one row per platform, so a
    // driver who ran Uber and Yango on the same plate the same day would have
    // every harsh-driving event on that day counted twice.
    const alerts = await q(
      `WITH days AS (SELECT DISTINCT plate, day FROM vehicle_driver_day
                     WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date)
       SELECT a.alert_type, count(*)::int n, max(a.occurred_at) latest
       FROM alert a JOIN days ON days.plate = a.plate
            AND (a.occurred_at AT TIME ZONE 'Asia/Dubai')::date = days.day
       GROUP BY 1 ORDER BY n DESC LIMIT 15`, p);
    const [exposure] = await q(
      `SELECT round(sum(km)::numeric,0) km FROM vehicle_driver_day
       WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date`, p);
    const totalAlerts = alerts.reduce((a, r) => a + r.n, 0);
    res.json({ cancels, cancel_daily: cancelDaily, alerts,
      alert_km: exposure?.km ?? null,
      alerts_per_100km: exposure?.km > 0 ? +((totalAlerts / exposure.km) * 100).toFixed(1) : null });
  }));

  /* ── the raw record, because eventually someone needs the trips ────── */
  app.get('/api/driver/trips', withDriver(async (req, res, d, p) => res.json(await q(
    `SELECT platform, external_id, requested_at, ended_at, plate, pickup_addr, dropoff_addr,
            distance_km, duration_s, status, product, payment_type, price, currency
     FROM trip WHERE ${TW}
     ORDER BY requested_at DESC LIMIT ${Math.min(+req.query.limit || 200, 1000)}`, p))));

  /* ── which vehicles, day by day (handovers visible) ────────────────── */
  app.get('/api/driver/custody', withDriver(async (req, res, d, p) => res.json(await q(
    `SELECT day, plate, platform, trips, km, revenue, first_trip_at, last_trip_at, is_primary
     FROM vehicle_driver_day
     WHERE driver_ext_id = ANY($3) AND day BETWEEN $1::date AND $2::date
     ORDER BY day DESC, trips DESC LIMIT 400`, p))));
}
