/* UNEXPLAINED JOURNEYS, WITH A NAME BESIDE THEM AND THE REASON FOR THE NAME.
   ═══════════════════════════════════════════════════════════════════════════
   Asked for in these words: "on driver's trip page we should also keep
   unauthorized trips. we can get the unauthorized trips on the time and date
   and we can match who drove that car using uber and put it on their profile
   along with another tab of all unauthorized trips".

   Two endpoints, and they answer two different questions:

     /api/driver/unauthorized     what this PERSON is named beside, and —
                                  separately, under its own heading — what they
                                  are merely one of several candidates for.
     /api/unauthorized/attributed every unexplained journey in the fleet with
                                  its attribution, filterable by tier, with the
                                  distribution of the tiers on the response so a
                                  page can say what it is before a name is read.

   The rule that names anybody lives in api/unauthorized_sql.js and its header
   carries the measurement; nothing is decided here. What this file is
   responsible for is the three disciplines that make those names safe to put
   on a screen:

   1. THE TWO LISTS NEVER MERGE. A person attributed to a journey and a person
      who is one of three candidates for it are different claims, and a single
      array of rows has nowhere to say so once. The driver response therefore
      carries `attributed` and `also_a_candidate` as separate objects with
      separate totals and separate words, never a flag on a shared list.

   2. THE COVERAGE NOTE TRAVELS. Seat occupancy comes from CABMAN, a five-minute
      realtime poll with no history behind it: measured on production over
      2026-06-01..2026-09-16, only 27 of 108 days carry any segment at all, and
      every unauthorized segment in that window falls in 2026-08-21..2026-09-16.
      A driver tab that omits this reads as a clean record for June and July
      when it is really an absence of sensor data — an exoneration nobody
      measured, which is the same defect as an accusation nobody measured.
      CABMAN is also Ecosine-only, so Egari has no occupancy evidence at all
      and its page must say that rather than show an empty table.

   3. THE VALUE OF THE DISTANCE CARRIES ITS RATE. /api/unauthorized/list
      attaches forgone_aed with a rate_basis sentence on every row rather than
      in a wrapper, and these rows do it the same way and from the same
      RATE_SQL — a second convention for the same figure is two figures. */
import { placeEnds, RATE_SQL, forgone } from './place_sql.js';
import {
  attributionJoin, statusJoin, nearestJoin, statusNote, personKeysForDriver,
  ATTRIBUTION_COLS, TIERS, TIER_MEANS, BRACKET_CAP_MIN, BRACKET_PLATFORMS,
} from './unauthorized_sql.js';
/* The same resolver every other per-person endpoint uses — see the header on
   driverScope() in api/driver_routes.js for why it is a factory now. Opening
   either half of a merged pair has to land on the same person here as it does
   on the Trips tab beside it, or this surface accuses somebody the rest of the
   page does not believe exists. */
import { driverScope } from './driver_routes.js';

/* The segment's own columns. A deliberate subset of what
   api/segment_routes.js SEG_COLS selects: everything a row needs in order to
   be recognised, be opened at #segment/<plate>/<started_at>, and be argued
   with — and nothing that would make this a second, competing segment page. */
const SEG_COLS = `o.plate, o.fleet_id, o.started_at, o.ended_at, o.duration_min,
  o.distance_km, o.top_speed, o.verdict, o.verdict_reason, o.low_confidence,
  o.nearest_platform, o.nearest_trip_id, o.nearest_gap_min, o.channels_checked,
  o.start_lat, o.start_lng, o.end_lat, o.end_lng,
  ${placeEnds('o')},
  to_char((o.started_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS local_day`;

export function unauthorizedRoutes(app, { q, wrap, range, DAYWIN }) {
  const { withDriver } = driverScope({ q, wrap });

  /* What the reader has to be told about the evidence before they read a name.
     Shared by both endpoints so a driver page and the fleet page cannot report
     different coverage for the same window — they did exactly that once for
     the fleet filter, and #unauthorized showed twenty-six Ecosine segments
     under a note saying no sensor data covers Egari. */
  /* win() widens the window's upper bound to `2026-09-16 23:59:59.999` so that
     a bare date does not drop the last day, while winDays() leaves it bare —
     and withDriver() passes the widened form. `${to}T00:00:00Z` parses to NaN
     on the widened one, which silently turned the day arithmetic below into
     NaN and the coverage note into a sentence with NaN in it. SQL's ::date
     truncates it for us; the JS side has to do the same explicitly. */
  const bareDay = (d) => String(d).slice(0, 10);

  const coverageOf = async (from, to, fleet) => {
    const [c] = await q(
      `SELECT count(DISTINCT (started_at AT TIME ZONE 'Asia/Dubai')::date)::int AS days_with_data,
              min((started_at AT TIME ZONE 'Asia/Dubai')::date)::text AS first_day,
              max((started_at AT TIME ZONE 'Asia/Dubai')::date)::text AS last_day
         FROM occupancy_segment
        WHERE ${DAYWIN('started_at')} AND ($3::text IS NULL OR fleet_id = $3)`, [from, to, fleet]);
    const daysInWindow = Math.max(1, Math.round(
      (Date.parse(`${bareDay(to)}T00:00:00Z`) - Date.parse(`${bareDay(from)}T00:00:00Z`)) / 864e5) + 1);
    const days = c?.days_with_data || 0;
    return {
      days_with_data: days,
      days_in_window: daysInWindow,
      first_day: c?.first_day || null,
      last_day: c?.last_day || null,
      complete: days >= daysInWindow,
      /* The true reason, not a plausible one. An empty list here means one of
         two entirely different things and they must not read alike. */
      note: days === 0
        ? 'No seat-occupancy evidence exists for this window at all, so this is not a '
          + 'record of no unexplained journeys — it is an absence of the sensor that would '
          + 'find them. CABMAN is a five-minute realtime poll with no history behind it, '
          + 'and it is configured for Ecosine only.'
        : days >= daysInWindow ? null
          : `The seat sensor covers ${days} of the ${daysInWindow} days in this window `
            + `(${c.first_day} to ${c.last_day}). The other ${daysInWindow - days} days are `
            + 'not quiet days — they are days with no evidence, because CABMAN is a '
            + 'five-minute realtime poll with no history behind it. Read every count here '
            + 'as a count over the days that were watched.',
    };
  };

  /* One rate for the window, measured over the same window and fleet as the
     segments it values, then multiplied per row — never a per-row lookup,
     because every row is valued at the same published figure and a reader has
     to be able to check the arithmetic. */
  const rateOf = async (from, to, fleet) => {
    const [rk] = await q(`${RATE_SQL} WHERE ${DAYWIN('requested_at')}
       AND ($3::text IS NULL OR fleet_id = $3)`, [from, to, fleet]);
    const rate = rk?.aed_per_km == null ? null : Number(rk.aed_per_km);
    return { rate,
      basis: rate == null
        ? 'no booking in this window carries both a fare and a distance, so there is no rate '
          + 'to value this at'
        : `the fleet’s own rate over this window — AED ${rate}/km across ${rk.rate_trips} `
          + `bookings carrying both a fare and a distance (${rk.rate_km} km). `
          + 'Revenue forgone, not a cash cost.' };
  };

  /* How far back Uber's own status feed reaches. Asked once per request rather
     than per row: it is a fact about the table, and it is what decides whether
     a silent corroboration line means "they were off the app" or "nobody was
     watching yet". Those are the two absences api/status_routes.js was
     rewritten to keep apart after sixty-six drivers Uber had said nothing
     about were reported as offline. */
  const statusHistoryFrom = async () => {
    const [h] = await q('SELECT min(at) AS history_from FROM driver_status_event');
    return h?.history_from || null;
  };

  /* Everything a row carries beyond its own columns, applied in one place so
     the driver page and the fleet page cannot describe the same journey
     differently. */
  const dress = (r, rate, basis, historyFrom) => ({
    ...r,
    forgone_aed: forgone(r.distance_km, rate),
    aed_per_km: rate,
    rate_basis: basis,
    /* Corroboration, explicitly labelled as such and explicitly not a tier.
       See api/unauthorized_sql.js for the measurement: Uber's status feed
       named a driver on 0 of the 7 segments it can even see, and the reason is
       structural rather than a small sample. */
    status_note: statusNote(r.candidate_statuses, historyFrom, r.started_at),
  });

  const ATTRIBUTION_CONTRACT = 'Every name on these rows is an INFERENCE, never a trip '
    + 'record: an unexplained journey is by definition one that no booking explains, so no '
    + 'booking names its driver. attribution_tier says which rule named this person and '
    + 'attribution_evidence states the measurement that rule ran, so it can be checked '
    + 'against the car’s own trip list. Where the evidence cannot single out one person the '
    + 'tier is `ambiguous` and EVERY candidate is listed, equally weighted; where there is no '
    + 'custody record at all the tier is `unknown` and no name is offered. The car’s usual '
    + 'driver is never used as a fallback.';

  /* ── the fleet-wide list: every unexplained journey, with its attribution ──
     A companion to /api/unauthorized/list rather than a replacement: that one
     answers with a bare array which three shells already read that way, so its
     shape cannot gain a wrapper. This one is paged properly from the start —
     /api/unauthorized/list is a hard LIMIT 300 with no offset and no total,
     and "another tab of ALL unauthorized trips" is precisely the request a cap
     with no total cannot honour. */
  app.get('/api/unauthorized/attributed', wrap(async (req, res) => {
    const [from, to, , fleet] = range(req);
    /* The platform chip is not bound here, deliberately, and api/server.js
       carries the same note over SEG_FLEET: an occupancy segment belongs to a
       car and therefore to a fleet, but it does NOT belong to a booking
       channel — the whole point of the verdict is that no channel explains it.
       Filtering by platform would return an empty page and call it a clean one. */
    const verdict = req.query.verdict === 'all' ? 'all' : (req.query.verdict || 'unauthorized');
    const tier = TIERS.includes(String(req.query.tier)) ? String(req.query.tier) : null;
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const p = [from, to, fleet, verdict, tier];
    const WHERE = `${DAYWIN('o.started_at')}
       AND ($3::text IS NULL OR o.fleet_id = $3)
       AND ($4 = 'all' OR o.verdict = $4)`;

    const [rows, [tot], dist, coverage, { rate, basis }, historyFrom] = await Promise.all([
      q(`SELECT ${SEG_COLS}, ${ATTRIBUTION_COLS}, st.statuses AS candidate_statuses,
                nb.nearest_booking
           FROM occupancy_segment o
           ${attributionJoin('o')}
           ${statusJoin('o')}
           ${nearestJoin('o')}
          WHERE ${WHERE} AND ($5::text IS NULL OR att.tier = $5)
          ORDER BY o.started_at DESC LIMIT ${limit} OFFSET ${offset}`, p),
      q(`SELECT count(*)::int n FROM occupancy_segment o ${attributionJoin('o')}
          WHERE ${WHERE} AND ($5::text IS NULL OR att.tier = $5)`, p),
      /* THE DISTRIBUTION, over the WINDOW rather than over the current filter.
         A tier count that changes when you pick a tier tells a reader nothing
         about what else is there — the same rule /api/segments applies to its
         facets. This strip is also the thing that stops the page being read as
         a list of thieves: 13 named by time, 48 by day-custody alone, 26 with
         more than one candidate and 33 with nobody is a fact about the
         EVIDENCE, and it belongs above the names rather than under them. */
      /* Four parameters, not five: this query does not name $5, and Postgres
         refuses a bind that supplies more parameters than the statement uses
         ("bind message supplies 5 parameters, but prepared statement requires
         4"). The tier filter is deliberately absent — see the note above. */
      q(`SELECT att.tier AS key, count(*)::int n,
                round(sum(o.distance_km)::numeric, 1) AS km
           FROM occupancy_segment o ${attributionJoin('o')}
          WHERE ${WHERE} GROUP BY 1`, [from, to, fleet, verdict]),
      coverageOf(from, to, fleet),
      rateOf(from, to, fleet),
      statusHistoryFrom(),
    ]);

    const byTier = Object.fromEntries(dist.map((d) => [d.key, d.n]));
    res.json({
      rows: rows.map((r) => dress(r, rate, basis, historyFrom)),
      total: tot?.n ?? rows.length,
      shown: rows.length,
      offset,
      limit,
      truncated: offset + rows.length < (tot?.n ?? rows.length),
      filter: { verdict, tier, fleet },
      /* Every tier, whether or not it occurred, so a category dropping to zero
         is visible rather than absent — the same rule the verdict totals on
         /api/unauthorized/summary follow. */
      distribution: {
        bracketed: byTier.bracketed || 0,
        sole_custodian: byTier.sole_custodian || 0,
        ambiguous: byTier.ambiguous || 0,
        unknown: byTier.unknown || 0,
        segments: dist.reduce((a, d) => a + d.n, 0),
        by_tier: dist,
      },
      tier_means: TIER_MEANS,
      bracket: {
        cap_min: BRACKET_CAP_MIN,
        platforms: BRACKET_PLATFORMS,
        rule: `The same person’s booking on the same car ends at most ${BRACKET_CAP_MIN} `
          + `minutes before the journey starts and their next begins at most ${BRACKET_CAP_MIN} `
          + 'minutes after it ends, with no other driver’s booking on that car in between. '
          + 'Both gaps are stated on the row rather than summarised, because "bracketed" is '
          + 'not checkable and "their trip ended 34 minutes before and the next began 19 '
          + 'minutes after" is.',
      },
      status_feed: {
        history_from: historyFrom,
        role: 'CORROBORATION, never attribution. Uber’s status feed is per driver and '
          + 'carries no plate, it is append-only from the day the collector started writing '
          + 'it with no backfill, and on the segments it can see every candidate was offline '
          + 'for the whole window — which is what an unexplained journey is, by construction. '
          + 'It promotes nobody to a tier and names nobody the ladder did not already name.',
      },
      coverage,
      value: { aed_per_km: rate, basis },
      note: ATTRIBUTION_CONTRACT,
    });
  }));

  /* ── one person: what they are named beside, and what they are only a
        candidate for ────────────────────────────────────────────────────────
     Resolved through the shared driverScope(), so `p` is [from, to, keys] in
     the house argument order and a merged identity answers once rather than
     once per platform account. */
  app.get('/api/driver/unauthorized', withDriver(async (req, res, d, p) => {
    const [from, to] = p;
    const verdict = req.query.verdict === 'all' ? 'all' : (req.query.verdict || 'unauthorized');
    const fleet = req.query.fleet || null;
    const params = [...p, verdict];

    /* No index exists from a person to a segment, and there cannot be one: the
       attribution is COMPUTED, not stored. So this asks the same question of
       every segment in the window and keeps the ones whose candidate set the
       person is in. That is the whole window's segments, which on this fleet
       is about 120 rows over a quarter — the cost of not storing an inference
       that would go stale the moment a trip arrived late. */
    const rows = await q(
      `WITH me AS (${personKeysForDriver('$3')})
       SELECT ${SEG_COLS}, ${ATTRIBUTION_COLS}, st.statuses AS candidate_statuses,
              nb.nearest_booking
         FROM occupancy_segment o
         ${attributionJoin('o')}
         ${statusJoin('o')}
         ${nearestJoin('o')}
        WHERE ${DAYWIN('o.started_at')}
          AND ($4 = 'all' OR o.verdict = $4)
          AND att.candidate_keys
              && coalesce((SELECT array_agg(pkey) FROM me), ARRAY[]::text[])
        ORDER BY o.started_at DESC LIMIT 400`, params);

    const [coverage, { rate, basis }, historyFrom] = await Promise.all([
      coverageOf(from, to, fleet), rateOf(from, to, fleet), statusHistoryFrom(),
    ]);
    const dressed = rows.map((r) => dress(r, rate, basis, historyFrom));

    /* THE SPLIT, AND IT IS THE POINT OF THIS ENDPOINT.
       ───────────────────────────────────────────────────────────────────────
       A journey this person is NAMED beside and a journey they are one of
       three candidates for are two different claims about them, and a single
       list with a tier column has nowhere to make the difference impossible to
       miss. So they come back as two objects, with two totals and two
       sentences, and the UI is expected to render them under two headings.
       Merging them would put "you were named for this" and "you held a car
       that day, along with two other people" in one table under one count —
       which is the count that would get quoted. */
    const attributed = dressed.filter(
      (r) => r.attribution_tier === 'bracketed' || r.attribution_tier === 'sole_custodian');
    const candidate = dressed.filter((r) => r.attribution_tier === 'ambiguous');

    res.json({
      driver: { id: d.id, name: d.name, ids: d.ids, platforms: d.platforms },
      attributed: {
        rows: attributed,
        total: attributed.length,
        by_tier: {
          bracketed: attributed.filter((r) => r.attribution_tier === 'bracketed').length,
          sole_custodian: attributed.filter((r) => r.attribution_tier === 'sole_custodian').length,
        },
        heading: 'Unexplained journeys this person is named beside',
        means: 'Either their own Uber trips on that car bracket the journey in time, or they '
          + 'are the only person the trip record shows holding the car that day. Both are '
          + 'inferences from the booking record, not trip records of the journey itself.',
      },
      also_a_candidate: {
        rows: candidate,
        total: candidate.length,
        heading: 'Cars this person held on a day an unexplained journey happened',
        means: candidate.length
          ? 'These journeys have more than one candidate and nothing separates them. This '
            + 'person is one of the people who held the car that day; so is somebody else. '
            + 'No claim is made about who was driving, and this list must never be counted '
            + 'together with the one above.'
          : 'None in this window.',
      },
      truncated: rows.length >= 400,
      coverage,
      value: { aed_per_km: rate, basis },
      tier_means: TIER_MEANS,
      bracket: { cap_min: BRACKET_CAP_MIN, platforms: BRACKET_PLATFORMS },
      status_feed: { history_from: historyFrom },
      note: ATTRIBUTION_CONTRACT,
    });
  }));
}
