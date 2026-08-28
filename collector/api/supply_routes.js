/* ── the other half of the market ─────────────────────────────────────────
   Every page in this product measures DEMAND — how much work arrived, when,
   from where. Nothing measured supply, because until the driver availability
   collector landed there was nothing to measure it with.

   Now there is, and the number is the largest in the business. Sampled across
   the six busiest drivers over ~24 days each, on production:

       online 336h  on-job  72h   78% idle      online 343h  on-job 56h  83%
       online 315h  on-job  69h   78% idle      online 279h  on-job 55h  80%
       online 375h  on-job  65h   82% idle      online 278h  on-job 53h  81%

   Those are the BEST people. The fleet is paying for supply it is not selling,
   four hours in five, and that fact existed only on individual driver pages.

   This endpoint answers the two questions that turn it into a decision:
     · WHEN — online driver-hours against jobs, by weekday and hour, so an
       over-supplied slot is visible as one
     · WHERE — how long a driver waits after a dropoff in each area, which is
       the repositioning question stated in the only geography we have

   The where uses the DROPOFF AREA of the job before the wait, not a tracker
   position. A driver idles where their last job left them; the addresses are
   already rolled into areas by /api/geo/corridors, and a lat/lng has no area
   without a geocoder we do not run. It is a proxy, and it is named as one. */
import { areaOf } from './analytics_routes.js';

export function supplyRoutes(app, { q, wrap, range, FB }) {
  /* ── when: supply against demand, by weekday and hour ─────────────────── */
  app.get('/api/supply/balance', wrap(async (req, res) => {
    const p = range(req);

    /* Online minutes land in the hour they were online IN, not the hour the
       span started — a shift from 18:00 to 02:00 is eight hours of supply
       across eight slots, and attributing all of it to 18:00 would invent a
       peak that is really a shift boundary. generate_series over the span does
       the splitting; the clamps keep the first and last hour partial. */
    const supply = await q(
      `WITH ev AS (
         SELECT driver_ext_id, at, status,
                lead(at) OVER (PARTITION BY driver_ext_id ORDER BY at) AS next_at
           FROM driver_timeline_event
          WHERE kind = 'status' AND status <> ''
            AND at >= $1::timestamptz AND at <= $2::timestamptz),
       spans AS (
         SELECT driver_ext_id, at AS s, next_at AS e FROM ev
          WHERE next_at IS NOT NULL AND status = 'ONLINE'),
       slots AS (
         SELECT sp.driver_ext_id, g AS slot,
                extract(epoch FROM (
                  least(sp.e AT TIME ZONE 'Asia/Dubai', g + interval '1 hour')
                  - greatest(sp.s AT TIME ZONE 'Asia/Dubai', g)))/60 AS mins
           FROM spans sp,
                LATERAL generate_series(
                  date_trunc('hour', sp.s AT TIME ZONE 'Asia/Dubai'),
                  sp.e AT TIME ZONE 'Asia/Dubai', interval '1 hour') AS g)
       SELECT extract(dow FROM slot)::int AS dow,
              extract(hour FROM slot)::int AS h,
              round(sum(greatest(0, mins))::numeric / 60, 1) AS online_h,
              count(DISTINCT driver_ext_id)::int AS drivers
         FROM slots GROUP BY 1, 2 ORDER BY 1, 2`, [p[0], p[1]]);

    /* The same split for time ON a job, so idle is a subtraction over
       identical slots rather than two differently-shaped numbers. */
    const onJob = await q(
      `WITH j AS (
         SELECT requested_at AS s, ended_at AS e FROM trip_norm
          WHERE ${FB} AND is_booking AND ended_at IS NOT NULL AND ended_at > requested_at),
       slots AS (
         SELECT g AS slot,
                extract(epoch FROM (
                  least(j.e AT TIME ZONE 'Asia/Dubai', g + interval '1 hour')
                  - greatest(j.s AT TIME ZONE 'Asia/Dubai', g)))/60 AS mins
           FROM j, LATERAL generate_series(
                  date_trunc('hour', j.s AT TIME ZONE 'Asia/Dubai'),
                  j.e AT TIME ZONE 'Asia/Dubai', interval '1 hour') AS g)
       SELECT extract(dow FROM slot)::int AS dow, extract(hour FROM slot)::int AS h,
              round(sum(greatest(0, mins))::numeric / 60, 1) AS on_job_h
         FROM slots GROUP BY 1, 2`, p);

    const demand = await q(
      `SELECT local_dow AS dow, local_hour AS h, count(*)::int AS jobs
         FROM trip_norm WHERE ${FB} GROUP BY 1, 2`, p);

    /* How many times each weekday actually OCCURRED in the window.
       ─────────────────────────────────────────────────────────────────────
       A 30-day window holds five of two weekdays and four of the other five,
       so summed hours make those two look 25% bigger for calendar reasons.
       The first version of this endpoint reported "the worst single hour of
       the week is Thu 18:00" — and every one of its top six idle slots was a
       Thursday, because Thursday happened five times. That is a fact about the
       calendar, not about the fleet.

       Everything below is therefore PER OCCURRENCE: what a typical Thursday
       at 18:00 looks like, which is the only form a rota can be built from.
       The Rota gaps page already learned this lesson; this one had to too. */
    const occ = await q(
      `SELECT extract(dow FROM d)::int AS dow, count(*)::int AS n
         FROM generate_series($1::date, $2::date, interval '1 day') AS g(d)
        GROUP BY 1`, [String(p[0]).slice(0, 10), String(p[1]).slice(0, 10)]);
    const occBy = new Map(occ.map((r) => [r.dow, r.n || 1]));
    const per = (dow, v) => Math.round((v / (occBy.get(dow) || 1)) * 100) / 100;

    const key = (r) => `${r.dow}|${r.h}`;
    const jobBy = new Map(onJob.map((r) => [key(r), +r.on_job_h || 0]));
    const demBy = new Map(demand.map((r) => [key(r), r.jobs]));
    const cells = supply.map((r) => {
      const on = +r.online_h || 0;
      const busy = jobBy.get(key(r)) || 0;
      const jobs = demBy.get(key(r)) || 0;
      /* Floored: the two series come from different providers' clocks, and a
         job overhanging its own online span by seconds must not render as
         negative idle supply. */
      const idle = Math.max(0, on - busy);
      return {
        dow: r.dow, h: r.h,
        occurrences: occBy.get(r.dow) || 1,
        /* Per a typical occurrence of this weekday-hour. The raw totals are
           kept alongside because a reader checking the arithmetic needs them,
           but nothing is CHARTED off them. */
        online_h: per(r.dow, on), on_job_h: per(r.dow, busy), idle_h: per(r.dow, idle),
        jobs: per(r.dow, jobs),
        drivers: r.drivers,
        total_online_h: Math.round(on * 10) / 10, total_jobs: jobs,
        /* Jobs per online hour — the slot's own sell-through, and the one
           figure occurrence count cannot distort: it is a ratio of two things
           counted over the same days. */
        jobs_per_online_h: on ? Math.round((jobs / on) * 100) / 100 : null,
      };
    });

    /* The totals are over the REAL window, not over the per-occurrence figures
       — "80% of the hours drivers were online" is a fact about what happened,
       and normalising it would answer a question nobody asked. */
    const tot = cells.reduce((a, c) => ({
      online_h: a.online_h + c.total_online_h,
      on_job_h: a.on_job_h + (jobBy.get(key(c)) || 0),
      idle_h: a.idle_h + Math.max(0, c.total_online_h - (jobBy.get(key(c)) || 0)),
      jobs: a.jobs + c.total_jobs,
    }), { online_h: 0, on_job_h: 0, idle_h: 0, jobs: 0 });

    res.json({
      cells,
      totals: {
        online_h: Math.round(tot.online_h), on_job_h: Math.round(tot.on_job_h),
        idle_h: Math.round(tot.idle_h), jobs: tot.jobs,
        idle_pct: tot.online_h ? Math.round((tot.idle_h / tot.online_h) * 100) : null,
        jobs_per_online_h: tot.online_h ? Math.round((tot.jobs / tot.online_h) * 100) / 100 : null,
      },
      /* Whether there is anything to say at all. Uber serves 31 days of
         availability and nothing older, so a window before the collector
         started has demand and no supply — and a balance chart drawn over that
         reads as a fleet that was never online. */
      covered: supply.length > 0,
      basis: 'Online hours are split across the hours they were actually online in, not attributed '
        + 'to the hour a shift started; time on a job is split the same way, so idle is a '
        + 'subtraction over identical slots. Every per-hour figure is PER OCCURRENCE of that '
        + 'weekday — a 30-day window holds five of two weekdays and four of the rest, and summing '
        + 'raw hours makes those two look 25% busier for reasons that are the calendar’s.',
    });
  }));

  /* ── where: how long the wait is after a dropoff in each area ──────────── */
  app.get('/api/supply/areas', wrap(async (req, res) => {
    const p = range(req);
    const rows = await q(
      `WITH j AS (
         SELECT driver_ext_id,
                coalesce(${areaOf('dropoff_addr')}, '(unrecorded)') AS area,
                ended_at,
                lead(requested_at) OVER (PARTITION BY driver_ext_id ORDER BY requested_at) AS next_at
           FROM trip_norm
          WHERE ${FB} AND is_booking AND ended_at IS NOT NULL
            AND coalesce(btrim(driver_ext_id), '') <> ''),
       gaps AS (
         SELECT area, extract(epoch FROM (next_at - ended_at))/60 AS wait_min
           FROM j
          WHERE next_at IS NOT NULL AND next_at > ended_at
            /* A gap longer than six hours is a shift ending, not a wait for
               work. Counting those would rank an area by who goes home there. */
            AND next_at - ended_at < interval '6 hours')
       SELECT area,
              count(*)::int AS waits,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_min)::numeric, 0) AS median_wait_min,
              round(avg(wait_min)::numeric, 0) AS mean_wait_min,
              round(sum(wait_min)::numeric / 60, 1) AS waiting_h
         FROM gaps GROUP BY 1
        HAVING count(*) >= 5
        ORDER BY sum(wait_min) DESC`, p);
    res.json({
      areas: rows,
      basis: 'Measured from a dropoff to that driver’s next request, so it is the wait a driver '
        + 'actually experiences after finishing in an area. The area is where the last job LEFT '
        + 'them, which is a proxy for where they waited — a tracker fix carries a position and no '
        + 'area, and there is no geocoder here to give it one. Gaps over six hours are excluded as '
        + 'shift ends rather than waits, and an area needs five waits to appear.',
    });
  }));
}
