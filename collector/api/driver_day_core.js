/* ONE DRIVER'S DAY — the evidence and the movement, shared.
   ─────────────────────────────────────────────────────────────────────────
   Moved out of api/driver_routes.js /api/driver/day (2026-11-24) so the
   collector's per-driver-day movement rollup (src/movement_rollup.js) runs the
   SAME code the day page runs: the day's bookings, the Uber log-in spans, the
   live status spans, which car was his and when (custody), the tracker's
   fixes in those hours (one tracker per car) and the day as the car saw it
   (api/day_movement.js). A second copy of any of it is how a range view and a
   day page would come to disagree about one driver's day — the operator's
   "complete view for the duration selected" (2026-11-24) is these days, added
   up.

   Nothing here was rewritten: the three blocks are the route's own, with the
   route's long comments kept beside the code they explain. */
import { onlineSpansSql } from './online_span_sql.js';
import { REAL_FIX } from './telemetry_sql.js';
import { SPANS_SQL, STALE_AFTER_MIN } from './status_routes.js';
import { seatOf } from './where_routes.js';
import { statusSpans, custodyWindows, carRuns, movementSegments, movementTotals } from './day_movement.js';

/* The first day the movement rollup builds (src/movement_rollup.js): live
   collection began on 21 Aug 2026 — positions polled every few minutes from
   then (COVERAGE, "the day live collection began"); before it the tracker
   history is journeys, not fixes. Here rather than in the rollup so the read
   route can say it without importing the collector side. */
export const MOVEMENT_FLOOR_DAY = '2026-08-21';

/* "L1 and L2" for a sentence. */
const listWordsPlain = (xs) => (xs.length < 2 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/* The day's bookings for the person's account keys, each with its minute of
   the day (s, e) and whether it ran past midnight. PKEY is the caller's
   person-key expression (api/driver_routes.js), passed in so there is one. */
export function dayTrips(q, keys, day, PKEY) {
  return q(
      `SELECT external_id, platform, fleet_id, plate,
              requested_at, ended_at, status, outcome,
              distance_km, price, currency, product, payment_type,
              pickup_addr, dropoff_addr,
              (extract(hour FROM requested_at AT TIME ZONE 'Asia/Dubai') * 60
               + extract(minute FROM requested_at AT TIME ZONE 'Asia/Dubai'))::int AS s,
              CASE WHEN ended_at IS NULL THEN NULL ELSE
                (extract(hour FROM ended_at AT TIME ZONE 'Asia/Dubai') * 60
                 + extract(minute FROM ended_at AT TIME ZONE 'Asia/Dubai'))::int END AS e,
              (ended_at IS NOT NULL
               AND (ended_at AT TIME ZONE 'Asia/Dubai') >= (($2::date) + 1)) AS past_midnight
         FROM trip_norm
        WHERE ${PKEY} = ANY($1) AND is_booking
          AND (requested_at AT TIME ZONE 'Asia/Dubai')::date = $2::date
        ORDER BY requested_at`, [keys, day]);
}

/* The Uber log-in record's ONLINE spans clipped to this Dubai day (the
   definition is api/online_span_sql.js; the route's comment on the defect it
   was measured on is kept there). */
export function dayOnline(q, keys, day) {
  return q(
      `WITH ${onlineSpansSql({ where: `driver_ext_id = ANY($1)
              AND at >= (($2::date - 1)::timestamp AT TIME ZONE 'Asia/Dubai')
              AND at <  (($2::date + 2)::timestamp AT TIME ZONE 'Asia/Dubai')` })}
       SELECT
              /* FLOOR, NOT A BARE ::int — Postgres rounds an int cast, and
                 every other minute-of-day figure on this response floors:
                 collected_to_min uses floor(), last_event_min is
                 hour*60+minute. That mismatch was invisible until closed_by
                 asserted the band's right edge IS the collection reach, and
                 then it printed the SAME INSTANT two ways — measured on
                 production 2026-09-10, a run finishing 13:17:52 rendered a
                 band ending 798 (13:18) beside a caption reading "last reached
                 13:17". One minute, and it is still the page contradicting
                 itself about one moment. A minute of the day is a floor: at
                 13:17:52 you have completed 797 whole minutes, not 798. */
              floor(greatest(0, extract(epoch FROM (
                greatest(span_start AT TIME ZONE 'Asia/Dubai', $2::timestamp)
                - $2::timestamp))/60))::int AS s,
              floor(least(1440, extract(epoch FROM (
                least(span_end AT TIME ZONE 'Asia/Dubai', $2::timestamp + interval '1 day')
                - $2::timestamp))/60))::int AS e,
              /* Open-ended only where the span really runs out inside this day.
                 A span that merely crosses the day's far edge is clipped at
                 24:00 because the day ends, which is not a claim about the
                 driver. */
              (open_ended
               AND (span_end AT TIME ZONE 'Asia/Dubai') <= $2::timestamp + interval '1 day')
                AS open_ended,
              /* And WHICH bound closed it — 'collection' where the span stops
                 at the last moment we actually asked Uber, 'now' where it is
                 still running as far as we know, 'day' where only the calendar
                 stopped it. Carried only on the spans that are open-ended in
                 this day, because for the rest there is nothing to explain. */
              CASE WHEN open_ended
                    AND (span_end AT TIME ZONE 'Asia/Dubai') <= $2::timestamp + interval '1 day'
                   THEN closed_by END AS closed_by
         FROM spans
        WHERE span_end > (($2::date)::timestamp AT TIME ZONE 'Asia/Dubai')
          AND span_start < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
        ORDER BY 1`, [keys, day]);
}

/* The movement: status spans, custody windows, the fixes in his hours and the
   day as the car saw it. `d` is driverScope().resolve()'s answer ({ keys,
   name }); `now` fixes the clock for a test or a rollup (default: now). */
export async function dayMovement(q, { d, day, trips, online, PKEY, now = null }) {
  const p = [d.keys, day];
    const dayStartMs = Date.parse(`${day}T00:00:00+04:00`);
    const nowMs = now ?? Date.now();
    const nowMin = Math.floor((nowMs - dayStartMs) / 60000);
    const isToday = nowMin >= 0 && nowMin < 1440;
    const limit = Math.max(0, Math.min(1440, nowMin));
    const statusRows = await q(SPANS_SQL, p);
    const statusAll = statusSpans(statusRows, dayStartMs, isToday ? nowMs : null);
    /* A LIVE FEED THAT STOPPED ANSWERING IS NOT A DRIVER STILL ONLINE. The
       last span runs to now() whatever the feed is doing; /api/status/driver
       marks the same status stale after STALE_AFTER_MIN, and this page did
       not — it drew "online … now" and stretched the car's custody across the
       dead stretch (review, 2026-10-13). Closed where the feed last saw him. */
    let statusStale = null;
    const lastSt = statusAll[statusAll.length - 1];
    if (isToday && lastSt?.open_ended) {
      const [obs] = await q(`SELECT max(observed_at) AS at FROM driver_status_now WHERE driver_ext_id = ANY($1)`, [d.keys]);
      const age = obs?.at ? (nowMs - new Date(obs.at).getTime()) / 60000 : null;
      if (age == null || age > STALE_AFTER_MIN) {
        const seen = obs?.at ? Math.max(lastSt.s, Math.min(lastSt.e, Math.floor((new Date(obs.at).getTime() - dayStartMs) / 60000))) : lastSt.s;
        lastSt.e = seen; lastSt.open_ended = false; lastSt.feed_stale = true;
        statusStale = obs?.at
          ? `Uber’s live feed last answered for this driver at ${String(Math.floor(seen / 60)).padStart(2, '0')}:${String(seen % 60).padStart(2, '0')}, so nothing after that is known from it`
          : 'Uber’s live feed holds no current answer for this driver, so the last status is not known to still hold';
      }
    }
    /* The cars he could have been in: his bookings' that day, the car Uber's
       live record and roster have him in, the cars his bookings put him in the
       week around it — and every car UBER'S OWN STATUS ROWS name him in that
       day, found by his id through the (source, polled_at) index. Only
       candidates: custody is decided by the evidence below. */
    const candidates = new Set(trips.map((t) => t.plate).filter(Boolean));
    for (const r of await q(
      `SELECT plate FROM vehicle_driver_day
        WHERE driver_ext_id = ANY($1) AND day BETWEEN $2::date - 7 AND $2::date + 1
       UNION SELECT plate FROM driver_status_now WHERE driver_ext_id = ANY($1)
       UNION SELECT plate FROM driver_platform_state WHERE driver_ext_id = ANY($1)
       UNION SELECT DISTINCT plate FROM telemetry_snapshot
        WHERE source = 'uber'
          AND polled_at >= (($2::date - 1)::timestamp AT TIME ZONE 'Asia/Dubai')
          AND polled_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai') + interval '1 hour'
          AND raw->'driverInfo'->>'driverUuid' = ANY($1)`, p)) {
      if (r.plate) candidates.add(r.plate);
    }
    const mins = (ts) => Math.floor((new Date(ts).getTime() - dayStartMs) / 60000);
    /* Uber's status rows in those cars, the day and the day before. */
    const uberAll = candidates.size ? await q(
      `SELECT plate, captured_at, upper(coalesce(status, '')) AS status,
              raw->'driverInfo'->>'driverUuid' AS who_id,
              nullif(btrim(concat_ws(' ', raw->'driverInfo'->>'firstName', raw->'driverInfo'->>'lastName')), '') AS who_name
         FROM telemetry_snapshot
        WHERE source = 'uber' AND plate = ANY($1)
          AND captured_at >= (($2::date - 1)::timestamp AT TIME ZONE 'Asia/Dubai')
          AND captured_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
        ORDER BY captured_at`, [[...candidates], day]) : [];
    /* THE STATE IN FORCE AT MIDNIGHT, PER CAR — ONE ROW, WHOEVER IT NAMES.
       The first version clamped EVERY working row from yesterday to 00:00, so
       a day man who drove the car yesterday 07:00–15:00 was "in it from
       midnight" today and given the night man's shift (review, 2026-10-13).
       Before midnight only the LAST row per car counts, OFFLINE included — an
       OFFLINE at 15:00 yesterday ends the 07:00 ONLINE — and it is evidence
       at 00:00 only if it is a working status. */
    const inForce = new Map();
    for (const r of uberAll) if (mins(r.captured_at) < 0) inForce.set(r.plate, r);
    const uberRows = uberAll.filter((r) => mins(r.captured_at) >= 0 || inForce.get(r.plate) === r);
    const keySet = new Set((d.keys || []).map(String));
    const working = (st) => st && st !== 'OFFLINE';
    const own = [];
    const others = [];
    for (const t of trips) {
      if (!t.plate) continue;
      const e = t.e == null ? t.s : (t.past_midnight ? 1440 : Math.max(t.e, t.s));
      own.push({ plate: t.plate, s: t.s, e, kind: 'booking' });
    }
    for (const r of uberRows) {
      if (!working(r.status) || !r.who_id) continue;
      const m = Math.max(0, mins(r.captured_at));
      if (m >= 1440) continue;
      (keySet.has(String(r.who_id)) ? own : others).push({ plate: r.plate, s: m, e: m,
        kind: 'uber_vehicle', who: r.who_name, who_id: r.who_id });
    }
    /* Other people's bookings in the cars he was in, for the same reason. */
    const ownPlates = [...new Set(own.map((o) => o.plate))];
    if (ownPlates.length) {
      for (const t of await q(
        `SELECT plate, driver_name, ${PKEY} AS driver_ext_id,
                (extract(hour FROM requested_at AT TIME ZONE 'Asia/Dubai') * 60
                 + extract(minute FROM requested_at AT TIME ZONE 'Asia/Dubai'))::int AS s,
                CASE WHEN ended_at IS NULL THEN NULL ELSE
                  (extract(hour FROM ended_at AT TIME ZONE 'Asia/Dubai') * 60
                   + extract(minute FROM ended_at AT TIME ZONE 'Asia/Dubai'))::int END AS e
           FROM trip_norm
          WHERE plate = ANY($3) AND is_booking AND NOT (${PKEY} = ANY($1))
            AND (requested_at AT TIME ZONE 'Asia/Dubai')::date = $2::date`, [d.keys, day, ownPlates])) {
        others.push({ plate: t.plate, s: t.s, e: t.e == null ? t.s : Math.max(t.s, t.e), who: t.driver_name || null, who_id: t.driver_ext_id || null, kind: 'booking' });
      }
    }
    /* THE SPELLS HE WAS WORKING, from the record that knows each part of the
       day. Where Uber's live feed covers the day it decides — it is current
       and it says OFFLINE, which the log-in record's heartbeat cannot; before
       the live feed's first word, the log-in record. A log-in span that ran
       to midnight only because no later event ever arrived (closed_by 'day')
       is a claim, not a spell: it counts from its start only (review,
       2026-10-13 — it had stretched a car's custody to midnight). */
    const liveStart = statusAll.length ? statusAll[0].s : 1440;
    const spells = [
      ...statusAll.filter((x) => x.status !== 'offline').map((x) => ({ s: x.s, e: x.e })),
      ...online.filter((o) => o.s < liveStart).map((o) => ({ s: o.s,
        e: Math.min(liveStart, o.open_ended && o.closed_by === 'day' ? o.s : o.e) })),
    ];
    const windows = custodyWindows({ own, others, spells, limit: isToday ? limit : 1440 });
    /* Other drivers in his cars between his first and last hour in them,
       said on the page — the hours they explain are not shown as his. */
    const othersInSpells = others.filter((o) => {
      const mine = windows.filter((w) => w.plate === o.plate);
      return mine.length && o.s <= Math.max(...mine.map((w) => w.to)) && (o.e ?? o.s) >= Math.min(...mine.map((w) => w.from));
    })
      .map((o) => ({ plate: o.plate, who: o.who || null, who_id: o.who_id || null, s: o.s, e: o.e ?? o.s, kind: o.kind }));

    /* Where the car was, minute-bucketed. Returned as fixes rather than as
       per-gap rollups because the gaps are computed on the client from the
       jobs, and doing it twice in two places is how the two stop agreeing.
       Now for the cars and the hours that were his (above), each fix with its
       source and its seat reading. */
    const plates = [...new Set(windows.map((w) => w.plate))];
    /* Every fix carries the name of the ground it sits on, joined out of the
       gazetteer (sql/schema_v67.sql). A decimal pair is not an answer to
       "where was the car waiting" — nobody reads 25.112, 55.139 and pictures
       Jumeirah Lakes Towers — and no provider gives us both a fix and a name:
       Uber has 315,505 addresses and no coordinates, FMS has 222,543
       coordinates each with an address beside it. place_cell is that second
       set, folded to half-kilometre cells.

       LEFT JOIN, and the count of votes comes back with the name, because a
       cell one trip named is not the same claim as a cell four hundred trips
       agree on and the page has to be able to say which it is holding. A cell
       nothing has ever named returns NULL and renders as unnamed. */
    const plateFixes = (plates.length ? await q(
      `SELECT s.plate, s.source, s.captured_at AS at,
              to_char(s.captured_at AT TIME ZONE 'Asia/Dubai', 'HH24:MI') AS time,
              (extract(hour FROM s.captured_at AT TIME ZONE 'Asia/Dubai') * 60
               + extract(minute FROM s.captured_at AT TIME ZONE 'Asia/Dubai'))::int AS m,
              s.lat, s.lng, s.speed, s.seat_count, s.seat_occupied,
              pc.area, pc.n AS area_votes, pc.observations AS area_seen
         FROM telemetry_snapshot s
         LEFT JOIN place_cell pc
           ON pc.cell_lat = round(s.lat / 0.005)::int
          AND pc.cell_lng = round(s.lng / 0.005)::int
        WHERE s.plate = ANY($1) AND s.source <> 'uber'
          AND s.captured_at >= (($2::date)::timestamp AT TIME ZONE 'Asia/Dubai')
          AND s.captured_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
          /* A real position only: a tracker with no lock files 0,0 (FIXLIST
             V11), which drew a cell in the Gulf of Guinea and zoomed the map
             to the world (review, 2026-11-24). */
          AND ${REAL_FIX('s.')}
        ORDER BY s.captured_at`, [plates, day]) : []).map((f) => ({
      plate: f.plate, source: f.source, at: new Date(f.at).toISOString(), time: f.time, m: f.m,
      lat: Number(f.lat), lng: Number(f.lng), speed: f.speed == null ? null : Number(f.speed),
      /* The seat by the operator's rule (/api/where seatOf): CABMAN's flag,
         FMS's passenger count at 1 or more; null where the fix has none. */
      passenger: seatOf(f), area: f.area || null, area_votes: f.area_votes ?? null, area_seen: f.area_seen ?? null,
    }));
    /* Each kept fix carries the index of the custody window it sits in, so
       two fixes either side of another driver's hours in the same car are
       never read as one interval (api/day_movement.js sameWindow). */
    let fixes = plateFixes.map((f) => ({ ...f, w: windows.findIndex((w) => w.plate === f.plate && f.m >= w.from && f.m <= w.to) }))
      .filter((f) => f.w >= 0);
    const outsideFixes = plateFixes.length - fixes.length;
    /* ONE TRACKER PER CAR. Where a car carries both CABMAN and FMS they put it
       a median 12.7–25.6 km apart at the same minute (the trap "Check the
       plates with both providers before combining them"), and alternating
       between them is a car crossing the city every minute. The tracker with
       more positions in his hours is kept; the other is counted and said. */
    const secondTracker = new Map();
    for (const plate of plates) {
      const by = new Map();
      for (const f of fixes) if (f.plate === plate) by.set(f.source, (by.get(f.source) || 0) + 1);
      if (by.size < 2) continue;
      const [keep, ...rest] = [...by.entries()].sort((x, y) => y[1] - x[1]);
      secondTracker.set(plate, { kept: keep[0], dropped: rest.map(([source, n]) => ({ source, fixes: n })) });
      fixes = fixes.filter((f) => f.plate !== plate || f.source === keep[0]);
    }

    /* WHERE the shift began, which Uber will not tell us.
       ─────────────────────────────────────────────────────────────────────
       "Where does this person go online" is the question an operator asks
       about supply, and driver_timeline_event has a lat/lon column for it.
       Measured on production 2026-09-07: 197,687 timeline events and lat is
       null on every single one, even though the collector's GraphQL query asks
       for rootLocation. Uber accepts the field and returns nothing in it.

       So the position comes from the other side of the same car. The tracker
       reports the plate every few minutes all day; the fix nearest in time to
       the moment the driver went online is where they were when they did it,
       and the gazetteer names it.

       Nearest IN TIME, with the gap reported rather than hidden — a fix four
       minutes before the span is a good answer and a fix fifty minutes before
       is not the same claim. Beyond half an hour there is no honest answer at
       all and the span says so instead of borrowing a distant fix. */
    const ONLINE_FIX_TOLERANCE_MIN = 30;
    const namedFixes = fixes.filter((f) => f.area);
    const placeAt = (minute) => {
      /* The car's position is his only inside the hours it was his; a minute
         outside them is not placed from somebody else's shift, and says so
         (review, 2026-10-13: it borrowed a reason about the whole day). */
      if (!windows.some((w) => minute >= w.from - ONLINE_FIX_TOLERANCE_MIN && minute <= w.to + ONLINE_FIX_TOLERANCE_MIN)) {
        return { where: null, why: windows.length
          ? 'no car is on record as his at that moment, so no tracker can place him'
          : 'no car is on record as his on this day, so no tracker can place him' };
      }
      if (!fixes.length) {
        return { where: null, why: plates.length
          ? 'the tracker recorded no position for this car on this day'
          : 'no vehicle is attached to this day, so there is no position feed' };
      }
      if (!namedFixes.length) {
        return { where: null, why: 'the tracker saw the car, but no trip has ever named this ground' };
      }
      let best = null;
      for (const f of namedFixes) {
        const gap = Math.abs(f.m - minute);
        if (!best || gap < best.gap) best = { gap, f };
      }
      if (!best || best.gap > ONLINE_FIX_TOLERANCE_MIN) {
        return { where: null, why: `the nearest named position is ${best.gap} minutes away, too far to call it the same place` };
      }
      return {
        where: best.f.area,
        within_min: best.gap,
        lat: best.f.lat,
        lng: best.f.lng,
        votes: best.f.area_votes,
        of: best.f.area_seen,
        why: null,
      };
    };

    /* One row per span, so a shift split by a break reads as two starts rather
       than one — where somebody comes back online is as much a supply fact as
       where they started. */
    const onlinePlaced = online.map((o) => ({ ...o, went_online: placeAt(o.s) }));

    /* And the summary the page leads with: the areas this person actually
       started from, most used first. Counted over spans, not over minutes: the
       question is how often they choose that place, not how long they stayed. */
    const startTally = new Map();
    for (const o of onlinePlaced) {
      const a = o.went_online?.where;
      if (!a) continue;
      startTally.set(a, (startTally.get(a) || 0) + 1);
    }
    const goesOnlineIn = [...startTally.entries()]
      .map(([area, spans]) => ({ area, spans }))
      .sort((a, b) => b.spans - a.spans || a.area.localeCompare(b.area));

    /* The live feed's spells, each one that began a working stretch (after
       offline, or the day's first) placed the same way as the log-in
       record's: the tracker's fix nearest in time, within 30 minutes. */
    const statusPlaced = statusAll.map((x, i) => ((x.status !== 'offline' && !x.carried_in
      && (i === 0 || statusAll[i - 1].status === 'offline')) ? { ...x, went_online: placeAt(x.s) } : x));

    /* The day as the car saw it (api/day_movement.js). */
    const runs = carRuns(fixes);
    const movement = {
      windows: windows.map((w) => ({ plate: w.plate, from: w.from, to: w.to, core_from: w.core_from, core_to: w.core_to,
        stretched: w.stretched, basis: w.basis, overlap: !!w.overlap,
        shared: w.shared.map((x) => ({ who: x.who, who_id: x.who_id || null, s: x.s, e: x.e })),
        second_tracker: secondTracker.get(w.plate) || null })),
      others: othersInSpells,
      runs,
      segments: movementSegments(fixes, windows),
      totals: movementTotals(fixes, windows, runs),
      outside_fixes: outsideFixes,
      absent: windows.length ? (fixes.length ? null
        : `the tracker in ${listWordsPlain(plates)} reported no position while ${d.name || 'this driver'} had it`)
        /* What was CHECKED, never "never" (review, 2026-10-13). */
        : 'no car is on record as his on this day — no booking of his names one, and Uber’s status record for the day shows him working in none',
      basis: 'A car is this driver’s from his first to his last evidence in it — his bookings, and Uber’s own '
        + 'status record, which names the vehicle the app had him in — stretched to the edges of the online spell that '
        + 'evidence sits in, and never across another driver’s evidence in the same car. Positions outside those '
        + 'hours are the car’s, not his, and are not shown. A stop is 10 minutes within 250 m; the seat is the '
        + 'tracker’s own reading (CABMAN’s seat flag, FMS’s passenger count), never inferred from the jobs.',
    };
  return { dayStartMs, nowMs, nowMin, isToday, limit, statusAll, statusStale, statusPlaced, windows, othersInSpells,
    plates, plateFixes, fixes, outsideFixes, secondTracker, onlinePlaced, goesOnlineIn, runs, movement };
}
