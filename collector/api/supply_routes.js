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
import { config } from '../src/config.js';
/* A real import, not a copy: this module is loaded as an ES module by
   api/server.js, so unlike the route bodies server.js evaluates inside its own
   `new Function` slice (see the note above isoDay there) a top-level binding is
   in scope here. src/util.js imports nothing, so there is no cycle.
   isoDay() in src/sources/ledger.js is the sibling helper for a pg DATE, and it
   is deliberately NOT what is used below: a DATE arrives as a Date at LOCAL
   midnight and has no instant to convert, whereas every value converted here is
   a real timestamptz instant, which has to be moved onto the Dubai clock. */
import { dubaiIso } from '../src/util.js';

/* ── charging ─────────────────────────────────────────────────────────────
   A car standing still for fifty minutes is not automatically waste. This
   fleet is 44% electric and has chargers at two of the very places the idle
   ranking puts at the top, so without this the optimiser reads a charging
   session as downtime and recommends moving the cars away from the only
   place they can refuel — advice that would cost trips rather than win them.

   It is a NAME match, not a geofence: the trip data gives an address string
   and nothing else, so this can only say "the area this car was left in
   contains a charger", never "this car was plugged in". That is a weaker
   claim and every surface that uses it says so rather than netting the hours
   off silently. */
export const chargingSites = () => config.chargingSites;

/* Anchored, not a substring: an area that merely CONTAINS the words is a
   different place, and flagging it would excuse idle time with no charger
   behind it. The trailing space and comma admit the one variant providers
   actually write — "Al Garhoud DU, AE". */
const hits = (a, name) => {
  const n = String(name).toLowerCase();
  return a === n || a.startsWith(`${n} `) || a.startsWith(`${n},`);
};

/* Returns the SITE a wait sits on, or null — the label, so the page can name
   it, and so an area written under an alias is attributed to the site it
   actually is rather than to itself. */
export const chargingSiteOf = (area, sites) => {
  if (!area) return null;
  const a = String(area).toLowerCase();
  return sites.find((s) => s.names.some((n) => hits(a, n)))?.label || null;
};

export const isCharging = (area, sites) => chargingSiteOf(area, sites) != null;

export function supplyRoutes(app, { q, wrap, range, FB }) {
  /* ── when: supply against demand, by weekday and hour ─────────────────── */
  app.get('/api/supply/balance', wrap(async (req, res) => {
    const p = range(req);

    /* Both halves over the days the AVAILABILITY feed actually covers.
       ─────────────────────────────────────────────────────────────────────
       Online hours come from driver_timeline_event, which Uber serves for
       about 31 days and nothing older; time on a job comes from the trip
       record, which goes back a year. Both queries honoured the requested
       window, and that was the bug: widening the range added job hours and no
       online hours, so the headline moved without the fleet moving. Measured
       on production, the same fleet through the four range chips:

         30 days  online 24,344  on job  5,288  →  78% idle
         90 days  online 29,175  on job 11,962  →  59% idle
         6 months online 29,175  on job 19,087  →  35% idle
         12 months online 29,175  on job 89,379 →   1% idle

       — three times as many on-job hours as online hours at a year, which is
       impossible, printed as "1% of the hours this fleet pays for are idle".
       The denominator was frozen and only the numerator grew.

       So the span the availability feed covers INSIDE the window is measured
       first, and the job and demand halves are clamped to it. The response
       says which span it used, because a rate over 31 of the 365 days somebody
       asked for is only honest if it says so. */
    const [span] = await q(
      `SELECT min(at) AS from_at, max(at) AS to_at,
              count(DISTINCT (at AT TIME ZONE 'Asia/Dubai')::date)::int AS days
         FROM driver_timeline_event
        WHERE kind = 'status' AND status <> ''
          AND at >= $1::timestamptz AND at <= $2::timestamptz`, [p[0], p[1]]);
    /* Where the feed has nothing, leave the window alone: every query then
       returns nothing and `covered` already says so. */
    /* ISO strings, not the driver's Date objects: the occurrence query below
       slices these to a date, and String(Date) is "Thu Aug 07 2026 …". */
    const iso = (v) => (v instanceof Date ? v.toISOString() : String(v));
    const bounded = span && span.from_at
      ? [iso(span.from_at), iso(span.to_at), ...p.slice(2)]
      : p;

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
         FROM slots GROUP BY 1, 2`, bounded);

    const demand = await q(
      `SELECT local_dow AS dow, local_hour AS h, count(*)::int AS jobs
         FROM trip_norm WHERE ${FB} GROUP BY 1, 2`, bounded);

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
        GROUP BY 1`, [String(bounded[0]).slice(0, 10), String(bounded[1]).slice(0, 10)]);
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
      /* The span every figure above is actually over, which is the
         availability feed's own reach inside the window rather than the window
         the reader picked. A page that prints a rate has to be able to say
         what it divided by. */
      measured: span && span.from_at ? {
        /* Dubai days, not UTC days — the same clock `days` beside them counts on.
           ─────────────────────────────────────────────────────────────────────
           from_at/to_at are min(at)/max(at) over driver_timeline_event.at, a
           bare timestamptz (sql/schema_v37.sql:29): no to_char, no ::text, so
           node-postgres hands back a Date, and iso() above turns an INSTANT
           into its UTC calendar day. `days` in the same row is
           count(DISTINCT (at AT TIME ZONE 'Asia/Dubai')::date) — Dubai days.
           Two clocks in one object, and production printed the contradiction:
           GET /api/supply/balance?from=2026-07-28&to=2026-07-29 answered
           {"from":"2026-07-28","to":"2026-07-28","days":2}, a span of one day
           beside a count of two, and ?to=2026-08-01 answered 07-28 → 07-31
           with days 5. Anything from 20:00 UTC onward is already tomorrow in
           Dubai, which is where max(at) fell.
           dubaiIso() applies src/util.js's constant +04:00 — the same shift
           Postgres's AT TIME ZONE 'Asia/Dubai' applies, since Dubai has had no
           daylight saving since 1990 — so the printed span and the count beside
           it can no longer disagree. */
        from: dubaiIso(span.from_at),
        to: dubaiIso(span.to_at),
        days: span.days,
        /* True when the reader asked for more than the feed can answer, which
           is the case the pages have to caption.
           Both sides have to be on ONE clock. p[0] is a Dubai calendar date
           string from winDays (api/server.js range → api/window.js), which
           iso()'s String(v) branch passed through untouched, while the left
           side was the UTC day of an instant — and the UTC day of an instant
           is never LATER than its Dubai day, so the error could only bias this
           flag toward false. That suppresses "Availability is only reported
           from …" (api/public/supply.js:151-156, api/public/optimise.js:117)
           in exactly the boundary case the caption exists for. */
        narrower_than_window: dubaiIso(span.from_at) > String(p[0]).slice(0, 10),
      } : null,
      basis: 'Online hours are split across the hours they were actually online in, not attributed '
        + 'to the hour a shift started; time on a job is split the same way, so idle is a '
        + 'subtraction over identical slots. Every per-hour figure is PER OCCURRENCE of that '
        + 'weekday — a 30-day window holds five of two weekdays and four of the rest, and summing '
        + 'raw hours makes those two look 25% busier for reasons that are the calendar’s.',
    });
  }));

  /* ── where: how long the wait is after a dropoff in each area ──────────── */
  /* Where the cars should BE, and when.
     ─────────────────────────────────────────────────────────────────────
     /api/supply/balance answers WHEN the fleet is over-supplied and
     /api/supply/areas answers WHERE a driver waits, and neither answers the
     question the operator actually has, which is both at once: at 17:00 on a
     Thursday, which areas are producing work that no car is already standing
     in?

     The join that makes it answerable is arrivals against departures in the
     SAME place one hour apart. A trip that ends in an area leaves a car
     there; a trip that starts in that area an hour later can use it. Where
     departures exceed the arrivals before them, the difference is cars
     driving in empty — which is the deadhead the corporate page already
     measures, here attributed to a place and an hour so it can be pre-empted
     rather than reported.

     Three things this is careful not to claim:

       · the area is parsed from address text, the same second dash-separated
         segment /api/geo/corridors uses. It is a community, not a polygon,
         and rows whose address does not carry one are excluded rather than
         bucketed into a fake area that would then rank.
       · a car that ended a trip in an area may have left it for reasons this
         cannot see. The arrival count is an UPPER bound on cars available,
         so the gap it implies is a lower bound — the honest direction.
       · bookings only. An FMS row is the tracker's record of a journey a ride
         platform already reported, and counting it would double every place. */
  app.get('/api/optimise', wrap(async (req, res) => {
    const p = range(req);
    const rows = await q(
      `WITH t AS (
         SELECT requested_at AT TIME ZONE 'Asia/Dubai' AS s,
                ended_at AT TIME ZONE 'Asia/Dubai' AS e,
                ${areaOf('pickup_addr')} AS from_area,
                ${areaOf('dropoff_addr')} AS to_area,
                price, has_fare
           FROM trip_norm
          WHERE ${FB} AND is_booking),
       pick AS (
         SELECT from_area AS area, extract(dow FROM s)::int AS dow,
                extract(hour FROM s)::int AS h, count(*)::int AS pickups,
                /* Over the bookings that CARRY a fare, and the count beside
                   it. A place-hour of Uber work has no price on any row, and
                   averaging across the priced and the unpriced answered
                   "AED 0" — which reads as "this place earns nothing" rather
                   than "nothing here reported a price". */
                round(avg(price) FILTER (WHERE has_fare)::numeric, 1) AS avg_fare,
                count(*) FILTER (WHERE has_fare)::int AS priced_pickups
           FROM t WHERE from_area IS NOT NULL GROUP BY 1, 2, 3),
       /* Shifted an hour forward: a car that arrives at 16:00 is the car
          available to a 17:00 booking, and comparing the two hours as if they
          were the same one understates every evening peak. */
       arrive AS (
         SELECT to_area AS area, extract(dow FROM e + interval '1 hour')::int AS dow,
                extract(hour FROM e + interval '1 hour')::int AS h, count(*)::int AS arrivals
           FROM t WHERE to_area IS NOT NULL AND e IS NOT NULL GROUP BY 1, 2, 3),
       /* How many times this weekday-hour happened in the window, so a slot
          is a RATE rather than a count that rewards the longer window. */
       occ AS (
         SELECT extract(dow FROM g)::int AS dow, extract(hour FROM g)::int AS h,
                count(*)::int AS occurrences
           FROM generate_series($1::timestamptz AT TIME ZONE 'Asia/Dubai',
                                $2::timestamptz AT TIME ZONE 'Asia/Dubai',
                                interval '1 hour') AS g
          GROUP BY 1, 2)
       SELECT coalesce(p.area, a.area) AS area,
              coalesce(p.dow, a.dow) AS dow, coalesce(p.h, a.h) AS h,
              coalesce(p.pickups, 0) AS pickups,
              coalesce(a.arrivals, 0) AS arrivals,
              p.avg_fare, p.priced_pickups,
              o.occurrences
         FROM pick p
         FULL OUTER JOIN arrive a ON a.area = p.area AND a.dow = p.dow AND a.h = p.h
         LEFT JOIN occ o ON o.dow = coalesce(p.dow, a.dow) AND o.h = coalesce(p.h, a.h)
        WHERE coalesce(p.pickups, 0) + coalesce(a.arrivals, 0) >= 3
        ORDER BY coalesce(p.pickups, 0) DESC`, p);

    const num = (v) => (v == null ? null : Number(v));
    const slots = rows.map((r) => {
      const occ = Math.max(1, num(r.occurrences) || 1);
      const pickups = num(r.pickups) || 0;
      const arrivals = num(r.arrivals) || 0;
      return {
        area: r.area, dow: num(r.dow), h: num(r.h), occurrences: occ,
        pickups, arrivals,
        /* Positive: work starts here that no car was already standing in. */
        gap: pickups - arrivals,
        per_occurrence: Math.round((pickups / occ) * 100) / 100,
        avg_fare: num(r.avg_fare),
        priced_pickups: num(r.priced_pickups),
      };
    });

    /* The ranking the board asks for: the place-hours where the fleet is
       driving in empty most often. Sorted by the gap PER OCCURRENCE, because
       a slot that happens four times in a month and a slot that happens
       thirty times are not the same opportunity at the same total. */
    const movesAll = slots
      .filter((s2) => s2.gap > 0 && s2.pickups >= 4)
      .map((s2) => ({
        ...s2,
        gap_per_occurrence: Math.round((s2.gap / s2.occurrences) * 100) / 100,
        /* A week's worth, which is the unit a rota is written in. */
        weekly: Math.round((s2.gap / s2.occurrences) * 100) / 100,
      }))
      .sort((a, b) => b.gap_per_occurrence - a.gap_per_occurrence);
    const moves = movesAll.slice(0, 40);

    /* And the other side of the same coin: where cars land and nothing
       starts. That is where the idle hours are actually being spent. */
    const surplusAll = slots
      .filter((s2) => s2.gap < 0 && s2.arrivals >= 4)
      .map((s2) => ({ ...s2, idle_per_occurrence: Math.round((-s2.gap / s2.occurrences) * 100) / 100 }))
      .sort((a, b) => b.idle_per_occurrence - a.idle_per_occurrence);
    const surplus = surplusAll.slice(0, 20);

    /* The measurement that cannot be fooled by an address book.
       ─────────────────────────────────────────────────────────────────────
       The area arithmetic above ranked Al Garhoud as the fleet's worst
       shortfall and Dubai Int'l Airport as its largest surplus, for every
       hour of every day — which reads as "move the cars from the airport to
       the airport", because Terminal 1 and 3 stand IN Al Garhoud and the two
       providers write the same place two different ways. An area parsed from
       text cannot know that, and no amount of counting fixes it.

       A CAR knows. Take each vehicle's trips in order: the minutes between
       one drop-off and its next pick-up is that vehicle's idle gap, measured
       without reference to what either place was called. Where the gap is
       long, the car is waiting. Where it is short, the last drop-off left it
       somewhere with work — which is the definition of a good position and
       the only one this data can honestly support.

       Capped at four hours: a longer gap is a shift ending, not a car
       waiting for a fare, and averaging the two together turns every
       overnight break into a repositioning problem. */
    const chains = await q(
      `WITH t AS (
         SELECT plate,
                requested_at AT TIME ZONE 'Asia/Dubai' AS s,
                ended_at AT TIME ZONE 'Asia/Dubai' AS e,
                ${areaOf('dropoff_addr')} AS to_area
           FROM trip_norm
          WHERE ${FB} AND is_booking AND plate IS NOT NULL AND ended_at IS NOT NULL),
       chain AS (
         SELECT plate, to_area AS area, e,
                lead(s) OVER (PARTITION BY plate ORDER BY e) AS next_s
           FROM t),
       gaps AS (
         SELECT area, extract(dow FROM e)::int AS dow, extract(hour FROM e)::int AS h,
                extract(epoch FROM (next_s - e)) / 60 AS wait_min
           FROM chain
          WHERE next_s IS NOT NULL AND next_s > e AND area IS NOT NULL
            AND next_s - e <= interval '4 hours')
       SELECT area, dow, h, count(*)::int AS handovers,
              round(percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_min)::numeric, 0) AS median_wait_min,
              round(sum(wait_min)::numeric / 60, 1) AS idle_h
         FROM gaps GROUP BY 1, 2, 3 HAVING count(*) >= 3
         ORDER BY sum(wait_min) DESC`, p);

    const sites = chargingSites();
    const waits = chains.map((r) => ({
      area: r.area, dow: num(r.dow), h: num(r.h),
      handovers: num(r.handovers),
      median_wait_min: num(r.median_wait_min),
      idle_h: num(r.idle_h),
      /* True where the AREA holds a charger, which is not the same as this
         car having been plugged in. Named `charging_site`, not `charging`,
         so nothing downstream can read it as a measurement. */
      charging_site: chargingSiteOf(r.area, sites),
    }));
    const totalIdle = waits.reduce((a, x) => a + (x.idle_h || 0), 0);
    const chargeIdle = waits.filter((x) => x.charging_site)
      .reduce((a, x) => a + (x.idle_h || 0), 0);
    const totalHandovers = waits.reduce((a, x) => a + x.handovers, 0);

    const totalPickups = slots.reduce((a, x) => a + x.pickups, 0);
    const totalGap = moves.reduce((a, x) => a + Math.max(0, x.gap), 0);
    res.json({
      window: [p[0], p[1]],
      areas_seen: new Set(slots.map((x) => x.area)).size,
      slots_seen: slots.length,
      placed_bookings: totalPickups,
      empty_arrivals: totalGap,
      empty_arrival_pct: totalPickups ? Math.round((totalGap / totalPickups) * 1000) / 10 : null,
      /* The headline the whole page exists for: hours a car spent between
         jobs, and where. Trips are what a fleet sells; this is what it pays
         for and does not sell. */
      idle_h_between_jobs: Math.round(totalIdle * 10) / 10,
      /* The share of that idle standing somewhere with a charger. An upper
         bound on charging, and a floor on how much of the ranking above is
         about refuelling rather than about waiting for work. */
      charging_sites: sites.map((s2) => s2.label),
      /* Where a site is written more than one way, the page has to say so —
         a reader looking at twenty rows labelled with the alias would
         otherwise read them as pure waiting. */
      charging_aliases: sites.filter((s2) => s2.names.length > 1)
        .map((s2) => ({ site: s2.label, written: s2.names })),
      idle_h_at_charging_sites: Math.round(chargeIdle * 10) / 10,
      idle_h_charging_pct: totalIdle ? Math.round((chargeIdle / totalIdle) * 1000) / 10 : null,
      handovers: totalHandovers,
      median_wait_overall: waits.length
        ? Math.round(waits.reduce((a, x) => a + (x.median_wait_min || 0) * x.handovers, 0)
          / Math.max(1, totalHandovers)) : null,
      /* Ranked by idle hours, which is the quantity a rota can actually
         reduce — a long median in a place with three handovers is a story
         about three cars. */
      waits: waits.slice(0, 40),
      moves,
      surplus,
      slots,
      /* Every ranking above is a head, not a census. A reader who sees forty
         rows has no way to know whether that is the whole fleet or the worst
         forty of six hundred, and the difference changes what the ranking
         means — so each list names the population it was cut from. */
      totals: {
        waits: waits.length,
        moves: movesAll.length,
        surplus: surplusAll.length,
        slots: slots.length,
      },
      shown: {
        waits: Math.min(waits.length, 40),
        moves: moves.length,
        surplus: surplus.length,
        slots: slots.length,
      },
      note: 'An area is the second dash-separated segment of the address text, not a polygon, and '
        + 'two providers can write one place two ways — Terminal 3 is addressed both as Dubai '
        + "Int'l Airport and as Al Garhoud, so `moves` and `surplus` will rank them against each "
        + 'other as though they were different places. `waits` does not have that problem: it '
        + "follows each VEHICLE from one drop-off to its next pick-up, so it measures the car's "
        + 'own idle time without reference to what either place was called. Gaps over four hours '
        + 'are excluded as shift ends rather than waiting. Rows in an area that '
        + 'holds a charging station carry `charging_site`, naming that site: this '
        + 'fleet is largely electric, so idle time there is an upper bound that '
        + 'mixes waiting with refuelling, and it is a name match on the address, '
        + 'not a geofence and not a plug event. `charging_aliases` lists any site '
        + 'written more than one way — the airport charger is reached under both '
        + "\"Al Garhoud\" and \"Dubai Int'l Airport\", so rows under either name "
        + 'are attributed to it.',
    });
  }));

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
