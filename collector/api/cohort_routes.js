/* Everything every source holds about a named set of people or cars.
   ─────────────────────────────────────────────────────────────────────────
   The counting is not here. A tile's number and the list behind it must agree,
   and the only way to guarantee that is for both to run the same predicate
   over the same rows — which is what api/public/cohorts.js is for. The page
   fetches the endpoint the tile already used, filters it with the shared test,
   and arrives here holding the ids.

   What is here is the part no page could do for itself: for those ids, every
   other source. A driver's standing came from one provider, their pay from
   another's statement, their hours from a supplier session, their car from the
   trip table and their harsh-braking from a telematics box — and until now a
   reader wanting all five opened five pages, one per person, one person at a
   time. Thirty-three idle cars is thirty-three page loads.

   Bounded by construction: the id list is the cohort, and a cohort is at most
   a few hundred rows. Every query below is `= ANY($1)` against an indexed
   column over that list, so this costs what one entity page costs, once. */
import { win, winDays } from './window.js';

const MAX_IDS = 400;

/* ids arrive as one comma-separated parameter. Cleaned, de-duplicated and
   capped: an id list is user input reaching an ANY() binding, and an unbounded
   one is an unbounded query. */
const idList = (v) => {
  const raw = Array.isArray(v) ? v.join(',') : String(v || '');
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX_IDS);
};

const num = (v) => (v == null ? null : Number(v));
const normPlate = (s) => String(s || '').toUpperCase().replace(/[\s-]+/g, '');

export function cohortRoutes(app, { q, wrap }) {
  /* ── people ────────────────────────────────────────────────────────────
     Keyed on the provider account id, and matched on the SYNTHESISED key
     wherever a source may name somebody it never gave an id — the same
     coalesce the driver directory and the economics ledger group by, so a
     person who exists only as a name still resolves. */
  app.get('/api/cohort/drivers', wrap(async (req, res) => {
    const ids = idList(req.query.ids);
    if (!ids.length) return res.json({ ids: [], rows: [] });
    const [from, to] = winDays(req);
    const [ts, te] = win(req);
    const P = [ids, from, to];
    const T = [ids, ts, te];

    const [work, pay, avail, standing, compliance, cars, alerts, perf, cancels] = await Promise.all([
      /* What they drove, per channel — bookings only, so a telematics twin of
         the same journey is not counted a second time. */
      q(`SELECT coalesce(nullif(btrim(t.driver_ext_id), ''), 'name:' || t.person_key) AS id,
                n.platform,
                count(*) FILTER (WHERE n.is_booking)::int AS bookings,
                count(*) FILTER (WHERE n.outcome = 'completed')::int AS completed,
                count(*) FILTER (WHERE n.outcome IS NOT NULL)::int AS bookable,
                count(DISTINCT n.local_day)::int AS days,
                round(sum(n.distance_km) FILTER (WHERE n.is_booking AND n.has_distance)::numeric, 0) AS km,
                round(sum(n.price) FILTER (WHERE n.has_fare)::numeric, 2) AS fares,
                count(*) FILTER (WHERE n.has_fare)::int AS priced,
                min(n.requested_at) AS first_trip, max(n.requested_at) AS last_trip
           FROM trip_norm n
           JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
          WHERE coalesce(nullif(btrim(t.driver_ext_id), ''), 'name:' || t.person_key) = ANY($1)
            AND n.local_day BETWEEN $2::date AND $3::date
          GROUP BY 1, 2`, P),
      /* What each account was PAID, at the day grain where the overlapping
         report periods are already resolved. Never driver_performance. */
      q(`SELECT driver_ext_id AS id, platform,
                round(sum(earnings)::numeric, 2) AS payout,
                round(sum(cash_earnings)::numeric, 2) AS cash,
                count(DISTINCT day)::int AS payout_days,
                min(day) AS first_day, max(day) AS last_day
           FROM driver_payout_day
          WHERE driver_ext_id = ANY($1) AND day BETWEEN $2::date AND $3::date
          GROUP BY 1, 2`, P),
      /* How long they were logged in, and how much of that had nobody in the
         car. NULL where availability was never collected, which is a different
         fact from zero and has to stay one. */
      q(`SELECT driver_ext_id AS id,
                count(*)::int AS days,
                sum(online_min) AS online_min,
                sum(idle_online_min) AS idle_min,
                sum(on_job_min) AS on_job_min,
                round(avg(first_min)::numeric, 0) AS avg_first_min,
                round(avg(last_min)::numeric, 0) AS avg_last_min,
                max(longest_wait_min) AS longest_wait_min
           FROM driver_day
          WHERE driver_ext_id = ANY($1) AND day BETWEEN $2::date AND $3::date
          GROUP BY 1`, P),
      /* What each provider says about their standing right now. Not windowed:
         a standing is a fact about today, and a window that excludes today
         would report an empty one as "no provider said". */
      q(`SELECT driver_ext_id AS id, platform, state, state_reason, can_earn,
                plate, observed_at, fleet_id
           FROM driver_platform_state
          WHERE driver_ext_id = ANY($1)
          ORDER BY observed_at DESC NULLS LAST`, [ids]),
      q(`SELECT driver_ext_id AS id, platform, licence_expires, state, rating,
                (licence_expires - now()::date) AS licence_days_left, updated_at
           FROM driver_compliance
          WHERE driver_ext_id = ANY($1)
          ORDER BY licence_expires ASC NULLS LAST`, [ids]),
      /* Which cars they held, and for how many days — the fold that already
         decides custody, read rather than recomputed. */
      q(`SELECT driver_ext_id AS id, plate,
                count(DISTINCT day)::int AS days,
                sum(trips)::int AS trips,
                max(day) AS last_day
           FROM vehicle_driver_day
          WHERE driver_ext_id = ANY($1) AND day BETWEEN $2::date AND $3::date
          GROUP BY 1, 2
          ORDER BY 3 DESC`, P),
      /* Harsh driving, attributed through the car they were holding that day.
         An alert names a plate, never a person. */
      q(`SELECT v.driver_ext_id AS id, a.alert_type, count(*)::int AS n
           FROM alert a
           JOIN vehicle_driver_day v
             ON v.plate = a.plate
            AND v.day = (a.occurred_at AT TIME ZONE 'Asia/Dubai')::date
          WHERE v.driver_ext_id = ANY($1)
            AND a.occurred_at BETWEEN $2 AND $3
          GROUP BY 1, 2
          ORDER BY 3 DESC`, T),
      /* The platform's own scorecard, where it publishes one. */
      q(`SELECT driver_ext_id AS id, platform,
                round(sum(hours_online)::numeric, 1) AS hours_online,
                round(sum(hours_on_trip)::numeric, 1) AS hours_on_trip,
                round(avg(acceptance_rate)::numeric, 2) AS acceptance,
                round(avg(cancellation_rate)::numeric, 2) AS cancellation,
                round(avg(rating)::numeric, 2) AS rating
           FROM driver_performance
          WHERE driver_ext_id = ANY($1)
            AND period_start >= $2::date AND period_end <= $3::date
          GROUP BY 1, 2`, P),
      /* Why the jobs that did not complete did not complete — the CHANNEL'S OWN
         word, not the fold. trip_norm.outcome has three values by design
         (completed / not_completed / other), which is the right grain for a
         completion rate and useless as a reason: a card reading "most often
         not completed" tells a reader what they already knew from the count
         beside it. The raw status is what separates a rider who cancelled from
         a driver who did, and that is the difference worth a conversation. */
      q(`SELECT coalesce(nullif(btrim(t.driver_ext_id), ''), 'name:' || t.person_key) AS id,
                n.platform, t.status, n.outcome, count(*)::int AS n
           FROM trip_norm n
           JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
          WHERE coalesce(nullif(btrim(t.driver_ext_id), ''), 'name:' || t.person_key) = ANY($1)
            AND n.local_day BETWEEN $2::date AND $3::date
            AND n.outcome IS NOT NULL AND n.outcome <> 'completed'
          GROUP BY 1, 2, 3, 4
          ORDER BY 5 DESC`, P),
    ]);

    const by = new Map(ids.map((id) => [id, {
      id, work: [], pay: [], availability: null, standing: [], compliance: [],
      cars: [], alerts: [], performance: [], not_completed: [],
    }]));
    const put = (r, k) => { const e = by.get(r.id); if (e) e[k].push(r); };
    work.forEach((r) => put(r, 'work'));
    pay.forEach((r) => put(r, 'pay'));
    standing.forEach((r) => put(r, 'standing'));
    compliance.forEach((r) => put(r, 'compliance'));
    cars.forEach((r) => put(r, 'cars'));
    alerts.forEach((r) => put(r, 'alerts'));
    perf.forEach((r) => put(r, 'performance'));
    cancels.forEach((r) => put(r, 'not_completed'));
    avail.forEach((r) => { const e = by.get(r.id); if (e) e.availability = r; });

    res.json({ window: [from, to], ids, rows: [...by.values()] });
  }));

  /* ── cars ──────────────────────────────────────────────────────────────
     Four systems describe one vehicle and none of them agrees on scope: the
     ride platforms know its bookings, the tracker knows where it physically
     was, the fleet portal knows its papers, and the seat sensor knows when
     somebody was in it with no booking open. */
  app.get('/api/cohort/vehicles', wrap(async (req, res) => {
    const plates = idList(req.query.ids).map(normPlate).filter(Boolean);
    if (!plates.length) return res.json({ ids: [], rows: [] });
    const [from, to] = winDays(req);
    const [ts, te] = win(req);
    const P = [plates, from, to];
    const T = [plates, ts, te];

    const [spec, work, custody, docs, tel, alerts, segs, util] = await Promise.all([
      q(`SELECT p.plate,
                coalesce(v.make, vp.make) AS make, coalesce(v.model, vp.model) AS model,
                coalesce(v.year, vp.year) AS year, coalesce(v.color, vp.colour) AS colour,
                coalesce(v.vin, vp.vin) AS vin, v.fuel_type,
                coalesce(v.fleet_id, vp.fleet_id) AS fleet_id
           FROM unnest($1::text[]) AS p(plate)
           LEFT JOIN vehicle v ON v.plate = p.plate
           LEFT JOIN vehicle_profile vp ON vp.plate = p.plate`, [plates]),
      /* Bookings and telematics journeys counted apart. Adding them is how a
         193,027 km odometer row became 1.6 million km against one car. */
      q(`SELECT n.plate, n.platform,
                count(*) FILTER (WHERE n.is_booking)::int AS bookings,
                count(*) FILTER (WHERE NOT n.is_booking)::int AS journeys,
                count(DISTINCT n.local_day)::int AS days,
                round(sum(n.distance_km) FILTER (WHERE n.is_booking AND n.has_distance)::numeric, 0) AS km,
                round(sum(n.distance_km) FILTER (WHERE NOT n.is_booking AND n.has_distance)::numeric, 0) AS journey_km,
                round(sum(n.price) FILTER (WHERE n.has_fare)::numeric, 2) AS fares,
                max(n.requested_at) FILTER (WHERE n.is_booking) AS last_trip,
                max(n.requested_at) AS last_movement
           FROM trip_norm n
          WHERE n.plate = ANY($1) AND n.local_day BETWEEN $2::date AND $3::date
          GROUP BY 1, 2`, P),
      q(`SELECT plate, driver_ext_id, max(driver_name) AS driver_name,
                count(DISTINCT day)::int AS days, sum(trips)::int AS trips,
                max(day) AS last_day
           FROM vehicle_driver_day
          WHERE plate = ANY($1) AND day BETWEEN $2::date AND $3::date
          GROUP BY 1, 2
          ORDER BY 4 DESC`, P),
      /* Every document, not only the nearest expiry: a car whose insurance is
         current and whose registration lapsed next week is one row on the
         directory and two very different jobs. */
      q(`SELECT plate, platform, doc_type, status, expires_at,
                (expires_at::date - now()::date) AS days_left
           FROM vehicle_document
          WHERE plate = ANY($1)
          ORDER BY expires_at ASC NULLS LAST`, [plates]),
      q(`SELECT DISTINCT ON (plate) plate, source, captured_at AS last_fix, status, speed,
                odometer, ignition,
                round(extract(epoch FROM now() - captured_at) / 60)::int AS fix_age_min
           FROM telemetry_snapshot
          WHERE plate = ANY($1)
          ORDER BY plate, captured_at DESC`, [plates]),
      q(`SELECT plate, alert_type, count(*)::int AS n, max(occurred_at) AS last_at
           FROM alert
          WHERE plate = ANY($1) AND occurred_at BETWEEN $2 AND $3
          GROUP BY 1, 2
          ORDER BY 3 DESC`, T),
      /* What the seat sensor saw. "partial" is the largest bucket on this
         fleet and appears on no page of its own. */
      q(`SELECT plate, verdict, count(*)::int AS n,
                round(sum(distance_km)::numeric, 0) AS km,
                round(sum(duration_min)::numeric, 0) AS minutes
           FROM occupancy_segment
          WHERE plate = ANY($1) AND started_at BETWEEN $2 AND $3
          GROUP BY 1, 2`, T),
      q(`SELECT plate, platform,
                round(sum(hours_online)::numeric, 1) AS hours_online,
                round(sum(hours_on_trip)::numeric, 1) AS hours_on_trip,
                round(avg(utilisation)::numeric, 2) AS utilisation,
                round(sum(earnings)::numeric, 2) AS earnings
           FROM vehicle_utilisation
          WHERE plate = ANY($1)
            AND period_start >= $2::date AND period_end <= $3::date
          GROUP BY 1, 2`, P),
    ]);

    const by = new Map(plates.map((plate) => [plate, {
      plate, spec: null, work: [], custody: [], documents: [], telematics: null,
      alerts: [], segments: [], utilisation: [],
    }]));
    const put = (r, k) => { const e = by.get(r.plate); if (e) e[k].push(r); };
    work.forEach((r) => put(r, 'work'));
    custody.forEach((r) => put(r, 'custody'));
    docs.forEach((r) => put(r, 'documents'));
    alerts.forEach((r) => put(r, 'alerts'));
    segs.forEach((r) => put(r, 'segments'));
    util.forEach((r) => put(r, 'utilisation'));
    spec.forEach((r) => { const e = by.get(r.plate); if (e) e.spec = r; });
    tel.forEach((r) => { const e = by.get(r.plate); if (e) e.telematics = { ...r, fix_age_min: num(r.fix_age_min) }; });

    res.json({ window: [from, to], ids: plates, rows: [...by.values()] });
  }));
}
