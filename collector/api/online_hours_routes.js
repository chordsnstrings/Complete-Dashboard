/* Uber: who was online, hour by hour — one day, and a range of days.
   ───────────────────────────────────────────────────────────────────────
   The operator, 2026-10-14: "we need to show driver online by hour on uber and
   store it to fetch previous data". sql/schema_v106.sql keeps the hours;
   api/online_hours_sql.js defines them. These two routes read them.

   GET /api/online/hours?day=YYYY-MM-DD[&fleet=]
     The 24 hours of one Dubai day: how many Uber drivers were online in each,
     the driver-hours, and the average online at once — then every driver's
     minutes, hour by hour. What the TIMELINE recorded (stored, the record) is
     kept apart from what the LIVE status feed says about the hours the
     timeline has not reached yet (today, up to three hours behind): those
     come from driver_status_event at request time, never stored, and every
     hour says which source it rests on and whether it is complete.

   GET /api/online/hours/range?from=&to=[&fleet=]  (or ?days=)
     Day × hour, from the stored table only: drivers online and driver-hours
     per cell, and the per-hour average over the days that have a record —
     the history Uber's 31-day timeline does not keep.

   "Drivers" here are Uber ACCOUNTS: the timeline is keyed on the account and
   carries no person key (sql/schema_v37.sql). On this one channel an account
   is a driver; a person with two Uber accounts would count twice, and the
   response says so in `basis`. */
import { winDays } from './window.js';
import { dubaiIso } from '../src/util.js';
import { LIVE_HOURS_SQL } from './online_hours_sql.js';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const dubaiToday = () => dubaiIso();
const dayStartMs = (day) => Date.parse(`${day}T00:00:00+04:00`);
const r1 = (v) => Math.round(v * 10) / 10;

/* The day the timeline's record begins on production (collector/docs/
   COVERAGE.md: 100% of complete days from 2026-07-28, nothing before, and
   unrecoverable). An earlier day is answered absent with that reason. */
export const TIMELINE_FROM = '2026-07-28';

export const BASIS = 'Online means ONLINE or on a trip on Uber, from Uber’s own timeline of each '
  + 'account (collected every 3 hours, kept here hour by hour). Drivers are Uber accounts: the timeline '
  + 'carries no person key, so one person with two Uber accounts would count twice. Average online is '
  + 'the driver-minutes in the hour over the minutes of it that are measured — how many were online at '
  + 'once, on average.';

/* driver_status_event began at 13:41 UTC on 14 September 2026 (COVERAGE.md,
   "The live driver status was arriving every two minutes and being
   discarded"). Before it the live feed holds nothing, so an hour it would
   cover is not "live, nobody online" — it is not measured. */
export const LIVE_FROM = '2026-09-14T13:41:00Z';
const LIVE_FROM_MS = Date.parse(LIVE_FROM);

export function onlineHoursRoutes(app, { q, wrap }) {
  /* The last timeline run that reached Uber, per fleet asked for — before
     `asOf` when given. */
  const timelineTo = async (fleet, asOf = null) => {
    const [r] = await q(
      `SELECT max(finished_at) AS at FROM collection_run
        WHERE source = 'uber_timeline' AND status <> 'error'
          AND ($1::text IS NULL OR fleet_id = $1 OR fleet_id IS NULL)
          AND ($2::timestamptz IS NULL OR finished_at <= $2::timestamptz)`, [fleet, asOf]);
    return r?.at ? new Date(r.at).getTime() : null;
  };
  /* WHAT THE STORE HOLDS. The hours are read from driver_online_hour, which
     holds only what a rollup pass has built (sql/schema_v107.sql). Built from
     the timeline as it stood at `at`, and back to `from`. An hour is RECORDED
     only up to the last timeline run that finished before `at`, and only on a
     day at or after `from`; judging it by the timeline's own last run made an
     empty table read as a day with nobody online (production, 2026-10-14). */
  const builtState = async () => {
    const [r] = await q(`SELECT read_at, built_from::text AS built_from FROM driver_online_hour_build`, []);
    if (!r?.read_at) return null;
    return { at: new Date(r.read_at).toISOString(), from: String(r.built_from || '').slice(0, 10) || null };
  };
  const NOT_BUILT = 'the hour-by-hour record has not been built for this day yet — it is built from Uber’s timeline after each '
    + 'collection, and back through all of history every night';

  app.get('/api/online/hours', wrap(async (req, res) => {
    const day = String(req.query.day || dubaiToday());
    if (!ISO_DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
      return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    }
    const fleet = ['ecosine', 'egari'].includes(req.query.fleet) ? req.query.fleet : null;
    const d0 = dayStartMs(day);
    const d1 = d0 + 864e5;
    const now = Date.now();
    if (d0 > now) return res.status(400).json({ error: 'that day has not started' });

    const [stored, names, toMs, built] = await Promise.all([
      q(`SELECT driver_ext_id, fleet_id, hour, online_min::float8 AS online_min, open_min::float8 AS open_min
           FROM driver_online_hour
          WHERE day = $1::date AND platform = 'uber' AND ($2::text IS NULL OR fleet_id = $2)`, [day, fleet]),
      q(`SELECT driver_ext_id, min(full_name) FILTER (WHERE btrim(coalesce(full_name, '')) <> '') AS name
           FROM driver_platform_state WHERE platform = 'uber' GROUP BY 1`, []),
      timelineTo(fleet),
      builtState(),
    ]);
    /* Recorded up to: the timeline run the store was last built from, on a
       day the store has been built back to. */
    const builtForDay = Boolean(built && built.from && day >= built.from);
    const recTo = builtForDay ? await timelineTo(fleet, built.at) : null;

    /* The live feed for what the store does not hold: from the later of the
       day's start and the recorded instant, to the earlier of the day's end
       and now — and never before the live feed itself began. */
    const liveFrom = Math.max(d0, recTo ?? d0, LIVE_FROM_MS);
    const liveTo = Math.min(d1, now);
    const live = liveTo > liveFrom
      ? await q(LIVE_HOURS_SQL, [new Date(liveFrom).toISOString(), new Date(liveTo).toISOString(), fleet])
      : [];

    const nameOf = new Map(names.map((n) => [n.driver_ext_id, n.name]));
    const people = new Map();
    const person = (id, fleetId) => {
      if (!people.has(id)) {
        people.set(id, { driver_ext_id: id, name: nameOf.get(id) || null, fleet_id: fleetId || null,
          minutes: Array(24).fill(0), live_minutes: Array(24).fill(0), open_minutes: Array(24).fill(0) });
      }
      return people.get(id);
    };
    /* A day the store has not been built back to is read from the live feed
       alone: rows an earlier pass left there are not counted beside it, or one
       minute could be counted from both. */
    for (const r of builtForDay ? stored : []) {
      const p = person(r.driver_ext_id, r.fleet_id);
      p.minutes[r.hour] += r.online_min;
      p.open_minutes[r.hour] += r.open_min;
    }
    for (const r of live) person(r.driver_ext_id, r.fleet_id).live_minutes[r.hour] += r.online_min;

    /* Each hour: which source it rests on, and how much of it is measured.
       The timeline's minutes end where its last run ended (toMs) and the live
       feed's begin there (liveFrom), so the two never cover the same minute. */
    const hours = Array.from({ length: 24 }, (_, h) => {
      const hs = d0 + h * 3600e3;
      const he = hs + 3600e3;
      if (hs >= now) {
        return { hour: h, state: 'future', drivers: null, drivers_live_only: 0, online_h: null, live_h: 0,
          avg_online: null, measured_min: 0 };
      }
      const elapsed = (Math.min(he, now) - hs) / 60000;
      const recMin = recTo == null ? 0 : Math.max(0, Math.min(he, now, recTo) - hs) / 60000;
      const liveCov = liveTo > liveFrom ? Math.max(0, Math.min(he, liveTo) - Math.max(hs, liveFrom)) / 60000 : 0;
      const covered = Math.min(elapsed, recMin + liveCov);
      let mins = 0, liveMins = 0, drivers = 0, liveOnly = 0;
      for (const p of people.values()) {
        const a = p.minutes[h], b = p.live_minutes[h];
        mins += a; liveMins += b;
        if (a + b > 0) { drivers += 1; if (a === 0) liveOnly += 1; }
      }
      const whole = (x) => x >= elapsed - 0.5;
      /* An hour nothing measured has no figure: 'not_built' where the
         timeline has reached it but the store has not been built from that
         run, 'not_collected' where the timeline has not reached it. */
      const state = whole(recMin) ? 'recorded'
        : whole(covered) ? (recMin > 0 ? 'recorded+live' : 'live')
          : recMin > 0 || liveCov > 0 ? 'partial'
            : toMs != null && toMs > hs ? 'not_built' : 'not_collected';
      const none = covered <= 0;
      return {
        hour: h, state, drivers: none ? null : drivers, drivers_live_only: liveOnly,
        online_h: none ? null : r1((mins + liveMins) / 60), live_h: r1(liveMins / 60),
        avg_online: covered > 0 ? r1((mins + liveMins) / covered) : null,
        measured_min: Math.round(covered),
      };
    });

    const list = [...people.values()].map((p) => {
      const per = p.minutes.map((m, h) => Math.round((m + p.live_minutes[h]) * 10) / 10);
      return { driver_ext_id: p.driver_ext_id, name: p.name, fleet_id: p.fleet_id,
        minutes: per, live: p.live_minutes.map((m) => m > 0),
        total_min: Math.round(per.reduce((a, b) => a + b, 0)),
        first_hour: per.findIndex((m) => m > 0), last_hour: 23 - [...per].reverse().findIndex((m) => m > 0) };
    }).sort((a, b) => b.total_min - a.total_min || String(a.name).localeCompare(String(b.name)));

    const before = day < TIMELINE_FROM;
    const measured = hours.some((x) => x.measured_min > 0);
    const anyone = list.some((p) => p.total_min > 0);
    const liveRead = liveTo > liveFrom;
    res.json({
      day, fleet, platform: 'uber',
      timeline_to: toMs ? new Date(toMs).toISOString() : null,
      recorded_to: recTo ? new Date(recTo).toISOString() : null,
      built_at: built?.at || null, built_from: built?.from || null,
      live_from: liveRead ? new Date(liveFrom).toISOString() : null,
      live_to: liveRead ? new Date(liveTo).toISOString() : null,
      hours, drivers: list,
      /* Nothing measured is no figure, never a zero. */
      totals: measured ? {
        drivers: list.filter((p) => p.total_min > 0).length,
        online_h: r1(list.reduce((a, p) => a + p.total_min, 0) / 60),
        peak_hour: hours.reduce((b, x) => (x.drivers != null && (b == null || x.drivers > b.drivers) ? x : b), null)?.hour ?? null,
        peak_drivers: Math.max(0, ...hours.map((x) => x.drivers || 0)),
      } : { drivers: null, online_h: null, peak_hour: null, peak_drivers: null },
      absent_why: before
        ? 'Uber’s timeline is held from 28 July 2026; the days before it were never collected and Uber no longer answers for them'
        : anyone ? null
          : !measured
            ? (!builtForDay && toMs != null && toMs > d0 ? NOT_BUILT
              : 'the timeline has not run since this day began, and the live feed has not reached it either')
            : !builtForDay && toMs != null && toMs > d0
              ? `${NOT_BUILT}; the live status feed${liveRead ? ', read in its place,' : ''} recorded nobody online`
              : hours.every((x) => x.state === 'future' || x.state === 'recorded')
                ? 'no Uber account was recorded online on this day'
                : 'no Uber account was recorded online in the hours measured so far',
      basis: BASIS,
      sources: {
        timeline: 'Uber chronicle GetTimelineInfo, every 3 hours, stored per hour in driver_online_hour',
        live: 'Uber driver status, polled every 2 minutes since 14 Sep 2026; used only for hours the timeline has not reached, and not stored',
      },
    });
  }));

  app.get('/api/online/hours/range', wrap(async (req, res) => {
    const [from, to] = winDays(req);
    const fleet = ['ecosine', 'egari'].includes(req.query.fleet) ? req.query.fleet : null;
    const [cells, toMs, built] = await Promise.all([
      q(`SELECT day, hour, count(DISTINCT driver_ext_id)::int AS drivers,
                round(sum(online_min)::numeric / 60, 1)::float8 AS online_h
           FROM driver_online_hour
          WHERE day BETWEEN $1::date AND $2::date AND platform = 'uber'
            AND ($3::text IS NULL OR fleet_id = $3)
          GROUP BY 1, 2 ORDER BY 1, 2`, [from, to, fleet]),
      timelineTo(fleet),
      builtState(),
    ]);
    /* Complete only up to the timeline run the store was built from, and only
       on days it has been built back to (see builtState). */
    const recTo = built ? await timelineTo(fleet, built.at) : null;
    const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
    const byDay = new Map();
    for (const c of cells) {
      const k = iso(c.day);
      if (!byDay.has(k)) byDay.set(k, { day: k, drivers: Array(24).fill(0), online_h: Array(24).fill(0) });
      const d = byDay.get(k);
      d.drivers[c.hour] = c.drivers; d.online_h[c.hour] = c.online_h;
    }
    /* Every day in the window gets a row, so a day nothing was recorded on is
       a visible gap with its reason rather than a row that is not there. */
    const days = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 864e5) {
      const k = new Date(t).toISOString().slice(0, 10);
      const row = byDay.get(k);
      const builtDay = Boolean(built && built.from && k >= built.from);
      const complete = builtDay && recTo != null && dayStartMs(k) + 864e5 <= recTo;
      days.push(row ? { ...row, total_h: r1(row.online_h.reduce((a, b) => a + b, 0)),
        peak: Math.max(...row.drivers), complete }
        : { day: k, drivers: null, online_h: null, total_h: null, peak: null, complete,
          absent_why: k < TIMELINE_FROM ? 'before Uber’s timeline was first collected (28 Jul 2026)'
            : !builtDay ? 'the hour-by-hour record has not been built back to this day yet (all of history is built every night)'
              : !complete ? (toMs != null && dayStartMs(k) + 864e5 <= toMs
                ? 'the timeline has reached this day but the hour-by-hour record has not been rebuilt from it yet'
                : 'the timeline has not yet reached this day')
                : 'no Uber account was recorded online' });
    }
    const held = days.filter((d) => d.drivers && d.complete);
    const avg = Array.from({ length: 24 }, (_, h) => (held.length
      ? r1(held.reduce((a, d) => a + d.drivers[h], 0) / held.length) : null));
    res.json({ from, to, fleet, platform: 'uber', days, avg_drivers_by_hour: avg, days_averaged: held.length,
      timeline_to: toMs ? new Date(toMs).toISOString() : null, recorded_to: recTo ? new Date(recTo).toISOString() : null,
      built_at: built?.at || null, built_from: built?.from || null, basis: BASIS });
  }));
}
