/* WHERE WAS A CAR, AND WHEN — answered in words, for a moment or a stretch.
   ──────────────────────────────────────────────────────────────────────────
   The operator (2026-10-13) asked for the chat assistant to have "historical
   location based on time". Nothing in the product answered that question as
   asked. /api/track and /api/map/journey hand back every fix of a day as a
   decimal pair, which is what a map draws and what nobody reads: "where was
   L19262 at three yesterday" is not answered by 168 coordinates. The one
   route that names ground at all, /api/driver/day, does it for a driver's
   online moments only.

   So this reads the same fixes (telemetry_snapshot, the table the map and
   the journey read) and answers in the gazetteer's words (api/place_sql.js —
   the fleet's own FMS history, never a geocoder):

     GET /api/where?plate=&day=&at=HH:MM          one moment
     GET /api/where?plate=&day=&from=HH:MM&to=HH:MM   a stretch of a day
     GET /api/where?plate=&day=                   the whole day
     GET /api/where/fleet?day=&at=HH:MM[&fleet=]  every car at one moment

   ── WHAT A MOMENT CAN HONESTLY SAY ───────────────────────────────────────
   Trackers report every few minutes and go quiet when a car is parked with
   the ignition off, so there is rarely a fix AT the moment asked. The answer
   is the nearest fix in time, with the gap said, and refused past thirty
   minutes — the same tolerance /api/driver/day uses for "where did they go
   online" (ONLINE_FIX_TOLERANCE_MIN), for the same reason: a position half
   an hour away is a different claim, not a less precise one. The fixes
   either side come back too, so a car that moved between them reads as
   moving rather than as wherever the nearer one happened to be.

   ── WHO WAS DRIVING IT ───────────────────────────────────────────────────
   A tracker knows a car, not a person. The person comes from the bookings
   made in that car (trip_norm, by plate): a trip in progress at the moment
   names its driver outright; otherwise the trips either side are reported,
   and only when both are the same person is that person named as driving
   between them. Two different people either side is a handover somewhere in
   the gap, and the answer says so rather than choosing. vehicle_driver_day
   lists everyone who held the car that day, beside it.

   ── A STRETCH ────────────────────────────────────────────────────────────
   Stops are found by DISPLACEMENT, not speed: FMS fixes often carry no speed
   at all (measured 2026-10-13: the first fix of L19262 on 2026-10-11 has
   speed null), so a speed rule would see no stops on half the fleet. A stop
   is a run of fixes that stays within 250 m of where it began for 10 minutes
   or more; both numbers are said on the response. Distance is measured the
   way /api/map/journey measures it — consecutive fixes no more than 20
   minutes apart and no hop of 60 km or more — so the two never disagree
   about one day.

   Dubai has no daylight saving (UTC+4 all year), so minutes into a Dubai day
   are worked out from the timestamp here rather than by a ::date cast on the
   column, which test/indexes.test.mjs rightly treats as a filter that needs
   an expression index. */
import { placeAt } from './place_sql.js';
import { dubaiIso } from '../src/util.js';

export const TOLERANCE_MIN = 30;      // a fix further than this from the moment is not "where it was"
export const STOP_RADIUS_KM = 0.25;   // a stop stays within this of where it began…
export const STOP_MIN = 10;           // …for at least this long
export const GAP_MIN = 20;            // /api/map/journey's rule for a drawable step
export const HOP_KM = 60;             // /api/map/journey's bad-fix rule
const DUBAI_MS = 4 * 3600_000;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/* "HH:MM" on a 24-hour clock, and 24:00 for the end of a day. Refused rather
   than coerced, as api/online_routes.js startMinutes() refuses: a time this
   cannot read must not quietly become midnight. */
export function clockMinutes(v, { allowEnd = false } = {}) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? '').trim());
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (allowEnd && String(v ?? '').trim() === '24:00') return 1440;
  return null;
}
const hhmm = (n) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const dayStartMs = (day) => Date.parse(`${day}T00:00:00Z`) - DUBAI_MS;
/* Minutes since the Dubai midnight of `day` — negative before it, over 1440
   after it, which is what lets a fix just across midnight still be compared. */
const minsInto = (ts, day) => Math.floor((new Date(ts).getTime() - dayStartMs(day)) / 60000);
const localTime = (ts) => {
  const d = new Date(new Date(ts).getTime() + DUBAI_MS);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};
const localDay = (ts) => new Date(new Date(ts).getTime() + DUBAI_MS).toISOString().slice(0, 10);
const R = 6371;
const rad = (d) => (d * Math.PI) / 180;
export function km(a, b) {
  const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
/* The seat, from whichever provider sent the fix: CABMAN DT's occupied flag,
   or FMS's live passenger count read as occupied at 1 or more (the operator's
   ruling of 2026-09-23). Null when the fix carries no reading — which is not
   an empty seat. The same rule as /api/live and /api/map/journey. */
export const seatOf = (f) => (f.source === 'fms'
  ? (f.seat_count == null ? null : Number(f.seat_count) >= 1)
  : (f.seat_occupied == null ? null : Boolean(f.seat_occupied)));
const motionOf = (f) => (f.speed == null ? null : Number(f.speed) > 3 ? 'moving' : 'stopped');

/* A fix as the answer carries it. The coordinates travel beside the name so
   a page can draw the point; the name is what a person reads. */
function fixOut(f, day) {
  const place = f.place || null;
  return {
    at: f.captured_at, time: localTime(f.captured_at),
    day: localDay(f.captured_at), minute: minsInto(f.captured_at, day),
    lat: Number(f.lat), lng: Number(f.lng),
    area: place?.area || null, area_votes: place?.votes ?? null, area_seen: place?.seen ?? null,
    speed: f.speed == null ? null : Number(f.speed), motion: motionOf(f),
    passenger: seatOf(f), source: f.source,
  };
}

/* Runs of fixes that stay put. Exported for the test, which drives it with
   synthetic fixes rather than a database. */
export function findStops(fixes) {
  const stops = [];
  let i = 0;
  while (i < fixes.length) {
    const anchor = fixes[i];
    let j = i;
    while (j + 1 < fixes.length && km(anchor, fixes[j + 1]) <= STOP_RADIUS_KM) j += 1;
    const span = (new Date(fixes[j].at) - new Date(anchor.at)) / 60000;
    if (j > i && span >= STOP_MIN) {
      /* The ground the stop is on: the name most of its fixes carry, so one
         stray fix on a cell boundary does not rename a two-hour stop. */
      const tally = new Map();
      for (let k = i; k <= j; k += 1) if (fixes[k].area) tally.set(fixes[k].area, (tally.get(fixes[k].area) || 0) + 1);
      const area = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
      let widest = 0;
      for (let k = i + 1; k <= j; k += 1) widest = Math.max(widest, (new Date(fixes[k].at) - new Date(fixes[k - 1].at)) / 60000);
      stops.push({ from: anchor.time, to: fixes[j].time, from_at: anchor.at, to_at: fixes[j].at,
        minutes: Math.round(span), area, lat: anchor.lat, lng: anchor.lng, fixes: j - i + 1,
        /* A stop inferred across a long silence is a car that was parked with
           its tracker quiet — usually true, and said, because it is inferred
           from two fixes at the same place rather than watched throughout. */
        longest_silence_min: Math.round(widest) });
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return stops;
}

export function distanceKm(fixes) {
  let total = 0;
  for (let i = 1; i < fixes.length; i += 1) {
    const gap = (new Date(fixes[i].at) - new Date(fixes[i - 1].at)) / 60000;
    const step = km(fixes[i - 1], fixes[i]);
    if (gap <= GAP_MIN && step < HOP_KM) total += step;
  }
  return Math.round(total * 10) / 10;
}

export function whereRoutes(app, { q, wrap }) {
  const FIXES = `SELECT captured_at, lat, lng, speed, source, seat_occupied, seat_count, fleet_id,
                        ${placeAt('lat', 'lng')} AS place
                   FROM telemetry_snapshot
                  WHERE plate = $1 AND lat IS NOT NULL AND lng IS NOT NULL
                    AND captured_at >= $2::timestamptz AND captured_at < $3::timestamptz
                  ORDER BY captured_at`;

  /* ── one car ─────────────────────────────────────────────────────────── */
  app.get('/api/where', wrap(async (req, res) => {
    const plate = String(req.query.plate || '').toUpperCase().replace(/[\s-]+/g, '');
    if (!plate) return res.status(400).json({ error: 'plate required' });
    const day = String(req.query.day || dubaiIso());
    if (!ISO_DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
      return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    }
    const hasAt = String(req.query.at ?? '').trim() !== '';
    const at = hasAt ? clockMinutes(req.query.at) : null;
    if (hasAt && at == null) {
      return res.status(400).json({ error: 'at must be HH:MM on a 24-hour clock',
        detail: `"${String(req.query.at).slice(0, 20)}" is not a time this route can read — 15:00, not 3pm.` });
    }
    let from = 0; let to = 1440;
    if (!hasAt) {
      if (String(req.query.from ?? '').trim() !== '') from = clockMinutes(req.query.from);
      if (String(req.query.to ?? '').trim() !== '') to = clockMinutes(req.query.to, { allowEnd: true });
      if (from == null || to == null || to <= from) {
        return res.status(400).json({ error: 'from and to must be HH:MM, with to after from' });
      }
    }
    const d0 = dayStartMs(day);
    /* Half an hour either side of the day, so a moment just after midnight
       can still find the fix just before it. */
    const lo = new Date(d0 - TOLERANCE_MIN * 60000).toISOString();
    const hi = new Date(d0 + 1440 * 60000 + TOLERANCE_MIN * 60000).toISOString();

    const [raw, held, trips, ever] = await Promise.all([
      q(FIXES, [plate, lo, hi]),
      /* Everyone who held the car that day, one row per PERSON-ACCOUNT rather
         than per platform: vehicle_driver_day keeps a row per platform, and a
         driver working two apps would otherwise be listed twice. */
      q(`SELECT driver_name, driver_ext_id, sum(trips)::int AS trips,
                min(first_trip_at) AS first_trip_at, max(last_trip_at) AS last_trip_at,
                bool_or(is_primary) AS is_primary
           FROM vehicle_driver_day WHERE plate = $1 AND day = $2::date
          GROUP BY driver_name, driver_ext_id
          ORDER BY sum(trips) DESC NULLS LAST, driver_name`, [plate, day]),
      /* The bookings made in this car around the day, for "who was driving".
         Reached through trip_plate_requested_idx (plate, requested_at).

         FROM trip, not trip_norm, for the PERSON: a driver is one person
         across their accounts, and the view was created before person_key
         was added to the table, so it does not carry it (api/online_routes.js
         says the same). Compared on driver_ext_id, a man who took a Bolt
         trip and then an Uber trip in the same car read as "the car changed
         hands" between himself and himself (review, 2026-10-13). An account
         nobody named keys on itself, never on the empty string.
         platform <> 'fms' is is_booking's own definition (sql/schema_v7). */
      q(`SELECT driver_name, driver_ext_id, platform, status, requested_at, ended_at,
                coalesce(nullif(person_key, ''), driver_ext_id) AS who
           FROM trip
          WHERE plate = $1 AND platform <> 'fms'
            AND requested_at >= $2::timestamptz - interval '3 hours'
            AND requested_at <  $3::timestamptz
          ORDER BY requested_at`, [plate, lo, hi]),
      /* Whether this car has EVER reported a position, so "no fix today" can
         say whether the tracker is quiet today or the car has none at all. */
      q(`SELECT max(captured_at) AS last_fix FROM telemetry_snapshot
          WHERE plate = $1 AND lat IS NOT NULL`, [plate]),
    ]);
    const fixes = raw.map((f) => fixOut(f, day));
    const inDay = fixes.filter((f) => f.minute >= 0 && f.minute < 1440);
    const lastEver = ever[0]?.last_fix || null;
    const noFixWhy = lastEver
      ? `the tracker in ${plate} recorded no position on this day; its last position on record is from ${localDay(lastEver)} ${localTime(lastEver)}`
      : `no tracker position has ever been recorded for ${plate}, so where it was cannot be known from this dashboard`;
    const heldBy = held.map((h) => ({ name: h.driver_name || null, driver_ext_id: h.driver_ext_id || null,
      trips: h.trips ?? 0, first_trip: h.first_trip_at ? localTime(h.first_trip_at) : null,
      last_trip: h.last_trip_at ? localTime(h.last_trip_at) : null, primary: Boolean(h.is_primary) }));
    const fleetId = raw.find((f) => f.fleet_id)?.fleet_id || null;
    const base = { plate, day, fleet_id: fleetId, held_by: heldBy,
      held_by_why: heldBy.length ? null
        : 'no booking was made in this car on this day, so nobody is on record as holding it',
      tolerance_min: TOLERANCE_MIN,
      place_basis: 'Area names come from the fleet’s own history: every FMS trip arrives with a position '
        + 'and an address, and those pairs name the ground within about half a kilometre. A spot the '
        + 'fleet has never driven near has no name, and is left unnamed rather than guessed.' };

    if (hasAt) {
      const atMs = d0 + at * 60000;
      let best = null; let before = null; let after = null;
      for (const f of fixes) {
        const dt = new Date(f.at).getTime() - atMs;
        if (!best || Math.abs(dt) < Math.abs(new Date(best.at).getTime() - atMs)) best = f;
        if (dt <= 0) before = f;
        if (dt > 0 && !after) after = f;
      }
      const gap = best ? Math.round(Math.abs(new Date(best.at).getTime() - atMs) / 60000) : null;
      const usable = best && gap <= TOLERANCE_MIN;
      /* Who was driving, from the bookings. */
      const tr = trips.map((t) => ({ name: t.driver_name || null, driver_ext_id: t.driver_ext_id || null,
        who: t.who || null, platform: t.platform, s: new Date(t.requested_at).getTime(),
        e: t.ended_at ? new Date(t.ended_at).getTime() : null,
        from: localTime(t.requested_at), to: t.ended_at ? localTime(t.ended_at) : null }));
      const during = tr.find((t) => t.s <= atMs && t.e != null && t.e >= atMs);
      const prev = [...tr].reverse().find((t) => (t.e ?? t.s) < atMs && localDay(new Date(t.s)) === day) || null;
      const next = tr.find((t) => t.s > atMs && localDay(new Date(t.s)) === day) || null;
      let driverAt = null; let driverWhy = null;
      const who = (t) => ({ name: t.name, driver_ext_id: t.driver_ext_id });
      if (during) {
        driverAt = { ...who(during), basis: 'on_trip', trip_from: during.from, trip_to: during.to, platform: during.platform };
      } else if (prev && next && prev.who && prev.who === next.who) {
        driverAt = { ...who(prev), basis: 'between_their_trips', trip_before: prev.to || prev.from, trip_after: next.from };
      } else if (prev || next) {
        driverWhy = prev && next
          ? `no trip was in progress at ${hhmm(at)}. The trip before it (${prev.from}) was ${prev.name || 'unnamed'}'s and the one after (${next.from}) was ${next.name || 'unnamed'}'s, so the car changed hands somewhere in between and who had it at ${hhmm(at)} is not known from bookings`
          : `no trip was in progress at ${hhmm(at)}; the nearest booking in this car that day was ${(prev || next).name || 'an unnamed driver'}'s at ${(prev || next).from}, ${prev ? 'before' : 'after'} it. That is who held the car nearest that time, not proof of who was driving at it`;
      } else {
        driverWhy = 'no booking was made in this car on this day, so who was driving is not known from bookings';
      }
      return res.json({ ...base, mode: 'moment', at: hhmm(at),
        position: usable ? best : null,
        gap_min: gap,
        position_why: usable ? null
          : !best ? noFixWhy
            : `the nearest position to ${hhmm(at)} is ${gap} minutes away (${best.time}), too far to call it where the car was at ${hhmm(at)}`,
        before, after,
        driver_at: driverAt, driver_at_why: driverWhy,
        fixes_that_day: inDay.length });
    }

    /* A stretch of the day. */
    const span = inDay.filter((f) => f.minute >= from && f.minute < to);
    const stops = findStops(span);
    const areas = [];
    for (const f of span) if (f.area && areas[areas.length - 1] !== f.area) areas.push(f.area);
    let widest = 0;
    for (let i = 1; i < span.length; i += 1) {
      widest = Math.max(widest, (new Date(span[i].at) - new Date(span[i - 1].at)) / 60000);
    }
    const stopped = stops.reduce((a, s) => a + s.minutes, 0);
    /* Fewer than two positions cannot show a stop or its absence: "0 stops,
       0 minutes stopped" over a stretch the tracker was silent for is a
       measurement nobody made (review, 2026-10-13). */
    const measured = span.length > 1;
    return res.json({ ...base, mode: 'span', from: hhmm(from), to: to >= 1440 ? '24:00' : hhmm(to),
      fixes: span.length,
      first: span[0] || null, last: span[span.length - 1] || null,
      distance_km: measured ? distanceKm(span) : null,
      stops: measured ? stops : null, stopped_min: measured ? stopped : null,
      areas_in_order: areas.slice(0, 40), areas_truncated: areas.length > 40,
      longest_silence_min: span.length > 1 ? Math.round(widest) : null,
      stop_rule: `a stop is ${STOP_MIN} minutes or more within ${STOP_RADIUS_KM * 1000} m of where it began; `
        + `distance counts steps between fixes no more than ${GAP_MIN} minutes apart, as the journey map does`,
      why: span.length ? null
        : inDay.length ? `the tracker recorded no position between ${hhmm(from)} and ${to >= 1440 ? '24:00' : hhmm(to)} on this day (it did at other times: ${inDay.length} positions that day)`
          : noFixWhy });
  }));

  /* ── every car, one moment ───────────────────────────────────────────── */
  app.get('/api/where/fleet', wrap(async (req, res) => {
    const day = String(req.query.day || dubaiIso());
    if (!ISO_DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
      return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    }
    const at = clockMinutes(req.query.at);
    if (at == null) return res.status(400).json({ error: 'at must be HH:MM on a 24-hour clock' });
    const fleet = ['ecosine', 'egari'].includes(req.query.fleet) ? req.query.fleet : null;
    const t = new Date(dayStartMs(day) + at * 60000).toISOString();
    /* Each plate's nearest fix inside the tolerance, through the
       (plate, captured_at) index one plate at a time; the plates themselves
       from the hour of fixes around the moment (telemetry_captured_idx). */
    const rows = await q(
      `WITH p AS (
         SELECT DISTINCT plate FROM telemetry_snapshot
          WHERE captured_at BETWEEN $1::timestamptz - make_interval(mins => $2)
                                AND $1::timestamptz + make_interval(mins => $2)
            AND lat IS NOT NULL AND lng IS NOT NULL)
       SELECT p.plate, f.captured_at, f.lat, f.lng, f.speed, f.source, f.seat_occupied, f.seat_count,
              f.fleet_id, ${placeAt('f.lat', 'f.lng')} AS place,
              h.driver_name AS held_by, h.driver_ext_id AS held_by_id
         FROM p
         CROSS JOIN LATERAL (
           SELECT s.* FROM telemetry_snapshot s
            WHERE s.plate = p.plate AND s.lat IS NOT NULL AND s.lng IS NOT NULL
              AND s.captured_at BETWEEN $1::timestamptz - make_interval(mins => $2)
                                    AND $1::timestamptz + make_interval(mins => $2)
            ORDER BY abs(extract(epoch FROM (s.captured_at - $1::timestamptz))) LIMIT 1) f
         LEFT JOIN LATERAL (
           SELECT driver_name, driver_ext_id FROM vehicle_driver_day v
            WHERE v.plate = p.plate AND v.day = $3::date
            ORDER BY v.is_primary DESC, v.trips DESC NULLS LAST LIMIT 1) h ON true
        WHERE ($4::text IS NULL OR f.fleet_id = $4)
        ORDER BY p.plate`, [t, TOLERANCE_MIN, day, fleet]);
    const cars = rows.map((r) => {
      const f = fixOut(r, day);
      return { plate: r.plate, fleet_id: r.fleet_id || null, ...f,
        gap_min: Math.round(Math.abs(new Date(r.captured_at) - new Date(t)) / 60000),
        held_by: r.held_by || null, held_by_id: r.held_by_id || null };
    });
    const tally = new Map();
    for (const c of cars) if (c.area) tally.set(c.area, (tally.get(c.area) || 0) + 1);
    res.json({ day, at: hhmm(at), fleet, tolerance_min: TOLERANCE_MIN, cars,
      totals: { cars: cars.length,
        moving: cars.filter((c) => c.motion === 'moving').length,
        stopped: cars.filter((c) => c.motion === 'stopped').length,
        with_passenger: cars.filter((c) => c.passenger === true).length,
        unnamed_ground: cars.filter((c) => !c.area).length },
      by_area: [...tally.entries()].map(([area, n]) => ({ area, cars: n }))
        .sort((a, b) => b.cars - a.cars || a.area.localeCompare(b.area)),
      basis: `Every car whose tracker reported a position within ${TOLERANCE_MIN} minutes of ${hhmm(at)}, at the `
        + 'position nearest that moment. A car with no position in that hour is not on this list — that is '
        + 'a quiet or absent tracker, not a car that was nowhere.' });
  }));
}
