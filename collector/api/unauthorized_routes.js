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
  STALE_CAP_MIN, FRESH_BAND_MIN,
} from './unauthorized_sql.js';
import { personKeyStored } from './custody_sql.js';
/* The same resolver every other per-person endpoint uses — see the header on
   driverScope() in api/driver_routes.js for why it is a factory now. Opening
   either half of a merged pair has to land on the same person here as it does
   on the Trips tab beside it, or this surface accuses somebody the rest of the
   page does not believe exists. */
import { driverScope } from './driver_routes.js';
/* The reconciler's own verdict vocabulary, and the duplicated-parameter guard.
   Both endpoints below validated `tier` and took `verdict` raw, so an
   unrecognised verdict produced an empty list under a coverage note affirming
   the sensor WAS watching — a computed all-clear over evidence that existed,
   which is the one shape the house principle forbids. */
import { RECONCILER_VERDICTS } from './segment_routes.js';
import { first } from './window.js';

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

  /* WHAT THE CALLER ASKED FOR, AND WHETHER IT WAS UNDERSTOOD.
     ───────────────────────────────────────────────────────────────────────
     Returns the verdict to bind AND the raw value when it was not recognised,
     so the response can say the filter was not understood instead of serving
     an empty page as a clean one. `tier` one line below has had exactly this
     treatment since it was written; verdict had not. */
  const verdictOf = (req) => {
    const raw = String(first(req.query.verdict) ?? '');
    if (!raw) return { verdict: 'unauthorized', rejected: null };
    if (raw === 'all') return { verdict: 'all', rejected: null };
    return RECONCILER_VERDICTS.includes(raw)
      ? { verdict: raw, rejected: null }
      : { verdict: 'unauthorized',
        rejected: `The verdict "${raw}" is not one the reconciler writes `
          + `(${RECONCILER_VERDICTS.join(', ')}, or "all"). It was IGNORED rather than bound: a `
          + 'filter nobody understood would have returned an empty list under a coverage note '
          + 'saying the sensor was watching, which reads as a clean fleet. These rows are the '
          + 'unexplained ones, which is the default.' };
  };

  /* `plates`, when given, scopes the coverage to the cars a PERSON actually
     held in this window.
     ───────────────────────────────────────────────────────────────────────
     THE DEFECT THIS EXISTS FOR. days_with_data was counted over
     occupancy_segment FLEET-WIDE — days on which ANY car produced a segment —
     and api/public/driver.js printed it as "No unexplained journey in this
     window names this person, across the 27 of 108 days the seat sensor
     actually watched." That asserts coverage over THEIR cars which was never
     measured. A driver whose only two cars carry no CABMAN sensor at all reads
     as 27 days of watched-and-clean; the true statement is "no sensor watched
     any car this person drove, on any day in this window". It is an
     exoneration nobody measured, which this file's own header names as the
     same defect class as an accusation nobody measured. */
  const coverageOf = async (from, to, fleet, plates = null) => {
    const [c] = await q(
      `SELECT count(DISTINCT (started_at AT TIME ZONE 'Asia/Dubai')::date)::int AS days_with_data,
              min((started_at AT TIME ZONE 'Asia/Dubai')::date)::text AS first_day,
              max((started_at AT TIME ZONE 'Asia/Dubai')::date)::text AS last_day,
              count(DISTINCT plate)::int AS plates_with_sensor
         FROM occupancy_segment
        WHERE ${DAYWIN('started_at')} AND ($3::text IS NULL OR fleet_id = $3)
          AND ($4::text[] IS NULL OR plate = ANY($4))`, [from, to, fleet, plates]);
    const daysInWindow = Math.max(1, Math.round(
      (Date.parse(`${bareDay(to)}T00:00:00Z`) - Date.parse(`${bareDay(from)}T00:00:00Z`)) / 864e5) + 1);
    const days = c?.days_with_data || 0;
    return {
      days_with_data: days,
      days_in_window: daysInWindow,
      first_day: c?.first_day || null,
      last_day: c?.last_day || null,
      plates_with_sensor: c?.plates_with_sensor ?? null,
      plates_held: plates ? plates.length : null,
      /* Whose cars this is a statement about. A page that prints the day count
         has to be able to print what it is a count OVER, because "the sensor
         watched 27 days" and "the sensor watched 27 days on the cars THIS
         person held" are different claims and only one of them exonerates
         anybody. */
      scope: plates
        ? (plates.length
          ? `the ${plates.length} car(s) this person held in this window`
          : 'no car at all — the trip record shows this person holding none in this window')
        : 'every car in the fleet',
      complete: days >= daysInWindow,
      /* The true reason, not a plausible one. An empty list here means one of
         two entirely different things and they must not read alike. */
      note: days === 0
        ? (plates && plates.length
          ? 'No car this person held in this window carries any seat-occupancy evidence at '
            + 'all, so this is not a record of no unexplained journeys — it is an absence of '
            + 'the sensor that would find them. CABMAN is a five-minute realtime poll with no '
            + 'history behind it, and it is configured for Ecosine only.'
          : plates
            ? 'The trip record shows this person holding no car at all in this window, so '
              + 'there was nothing for the seat sensor to watch on their behalf. This is an '
              + 'absence of work in the record, not a clean record.'
            : 'No seat-occupancy evidence exists for this window at all, so this is not a '
              + 'record of no unexplained journeys — it is an absence of the sensor that would '
              + 'find them. CABMAN is a five-minute realtime poll with no history behind it, '
              + 'and it is configured for Ecosine only.')
        : days >= daysInWindow ? null
          : `The seat sensor covers ${days} of the ${daysInWindow} days in this window `
            + `(${c.first_day} to ${c.last_day}), across ${plates
              ? `the ${plates.length} car(s) this person held` : 'every car in the fleet'}. `
            + `The other ${daysInWindow - days} days are `
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
    + 'driver is never used as a fallback. `last_trip` is the operator’s own rule — usually '
    + 'one person drives a car, so whoever did the last Uber trip on it is the one '
    + 'responsible — and it is the one tier that encodes knowledge this database does not '
    + 'hold. It is still an inference: no figure anywhere on this response is a hit rate, '
    + 'because an unexplained journey has no ground truth to score against.';

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
    const { verdict, rejected } = verdictOf(req);
    const tier = TIERS.includes(String(first(req.query.tier))) ? String(first(req.query.tier)) : null;
    const limit = Math.min(500, Math.max(1, Number(first(req.query.limit)) || 200));
    const offset = Math.max(0, Number(first(req.query.offset)) || 0);
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
      filter: { verdict, tier, fleet, verdict_rejected: rejected },
      /* Every tier, whether or not it occurred, so a category dropping to zero
         is visible rather than absent — the same rule the verdict totals on
         /api/unauthorized/summary follow. */
      distribution: {
        bracketed: byTier.bracketed || 0,
        last_trip: byTier.last_trip || 0,
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
      /* THE OPERATOR'S RULE AND ITS CAP, stated beside the bracket's the same
         way and for the same reason: the cap is the whole argument, so a page
         that prints a name under this tier has to be able to print what the
         name was allowed to rest on. Both numbers are measurements of THIS
         fleet, not settings — see the block comments in
         api/unauthorized_sql.js for the three independent readings that put
         the cap where it is and for the sensitivity table. */
      last_trip: {
        cap_min: STALE_CAP_MIN,
        fresh_band_min: FRESH_BAND_MIN,
        platforms: BRACKET_PLATFORMS,
        rule: 'The operator’s rule, in their words: "usually one person drives per car. so we '
          + 'will take the last trip custodian for that specific vehicle. whoever did the last '
          + 'trip on uber is the one responsible." Applied as: the person who finished the most '
          + 'recent COMPLETED Uber trip on this car before the journey started. The gap is '
          + 'stated on every row, because a gap of forty minutes and a gap of six days are '
          + 'different claims.',
        cap_basis: `The trip may be at most ${STALE_CAP_MIN} minutes (21.97 days) old. That is `
          + 'the 99.9th percentile of this fleet’s own gap between consecutive Uber trips, '
          + 'measured over 21,942 consecutive trip pairs on the 20 flagged plates — above it '
          + 'the fleet’s own record says the car was not in normal service, and the rule’s '
          + 'premise that the car is in service with one driver no longer holds. Beyond the '
          + 'cap nobody is named and the last driver of record is returned as context under '
          + 'attribution_last_uber_driver, never as a candidate.',
        band_basis: `At or under ${FRESH_BAND_MIN} minutes (p98 of the same gap) the car was in `
          + 'continuous normal Uber service across the journey and the sentence leads with the '
          + 'name; above it the car was in an abnormally quiet spell and the sentence leads '
          + 'with the age of the trip. Both bands name the person — this is a change of voice, '
          + 'not a second cap.',
        not_a_hit_rate: 'The rule agrees with the independent day-custody source on 70 of the '
          + '70 journeys under the cap where day-custody names anyone, and on 0 of the 2 above '
          + 'it. That is CONSISTENCY between two inferences drawn from the same trip table, '
          + 'never accuracy: an unexplained journey has no ground truth. It is also thin at the '
          + 'far end — the 7-to-21-day bucket is 9 samples, because 11 of the 20 journeys in it '
          + 'have no day-custody row to check against at all.',
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
    const { verdict, rejected } = verdictOf(req);
    const fleet = first(req.query.fleet) || null;
    /* BOUND TO THE ROWS, NOT ONLY TO THE COVERAGE NOTE AND THE MONEY.
       ─────────────────────────────────────────────────────────────────────
       `fleet` governed coverageOf() and rateOf() and NOT the rows query, so
       the two halves of one response described two different populations.
       Asked with fleet=egari — CABMAN is Ecosine-only — the coverage note came
       back "No seat-occupancy evidence exists for this window at all…",
       printed by driver.js in a warn box directly ABOVE a table of Ecosine
       rows naming this person, each priced at Egari's AED/km over Ecosine
       kilometres. The page contradicted itself over an accusation, which is
       worse than either half being wrong alone. Nothing triggered it today
       because the driver UI reaches this through qAll(), which strips the
       chip — which made it a trap set for the next caller rather than a bug
       that announces itself. */
    const params = [...p, verdict, fleet];

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
          AND ($5::text IS NULL OR o.fleet_id = $5)
          AND att.candidate_keys
              && coalesce((SELECT array_agg(pkey) FROM me), ARRAY[]::text[])
        ORDER BY o.started_at DESC LIMIT 400`, params);

    /* THE TOTALS ARE COUNTED, NOT MEASURED OFF THE CAPPED ARRAY.
       ─────────────────────────────────────────────────────────────────────
       attributed.total and also_a_candidate.total were `.length` over a list
       the query had already truncated at 400, served under the key `total`,
       and rendered by api/public/driver.js as bare KPI values with `truncated`
       reported separately at the top level where the tiles never consult it.
       A per-person count of unexplained journeys that is silently a floor is
       the one number on that page that must not be approximate — it is the
       count of journeys a named person is accused beside. Production is at 120
       segments a quarter today, so this was latent rather than live; it goes
       live the moment CABMAN is extended to Egari or the window is widened.

       One extra query, over the same WHERE and the same lateral, grouped on
       the tier the ladder assigned. */
    const tally = await q(
      `WITH me AS (${personKeysForDriver('$3')})
       SELECT att.tier AS key, count(*)::int AS n
         FROM occupancy_segment o
         ${attributionJoin('o')}
        WHERE ${DAYWIN('o.started_at')}
          AND ($4 = 'all' OR o.verdict = $4)
          AND ($5::text IS NULL OR o.fleet_id = $5)
          AND att.candidate_keys
              && coalesce((SELECT array_agg(pkey) FROM me), ARRAY[]::text[])
        GROUP BY 1`, params);
    const byTier = Object.fromEntries(tally.map((t) => [t.key, t.n]));

    /* THE CARS THIS PERSON ACTUALLY HELD, so the coverage note below is a
       statement about them rather than about the fleet. See coverageOf(). */
    const held = await q(
      `WITH me AS (${personKeysForDriver('$3')})
       SELECT DISTINCT v.plate FROM vehicle_driver_day v
        WHERE v.day BETWEEN $1::date AND $2::date
          AND ${personKeyStored('v')} = ANY(coalesce((SELECT array_agg(pkey) FROM me),
                                                     ARRAY[]::text[]))`, p.slice(0, 3));
    const plates = held.map((h) => h.plate);

    const [coverage, { rate, basis }, historyFrom] = await Promise.all([
      coverageOf(from, to, fleet, plates), rateOf(from, to, fleet), statusHistoryFrom(),
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
    /* `last_trip` belongs on the ATTRIBUTED side, not the candidate side: it
       names exactly one person, which is the whole distinction this split
       draws. It is the operator's own rule and it is the tier that will carry
       most of this list — 45 of 120 journeys on the measured distribution,
       against 13 brackets and 24 sole custodians. */
    const attributed = dressed.filter(
      (r) => r.attribution_tier === 'bracketed' || r.attribution_tier === 'last_trip'
        || r.attribution_tier === 'sole_custodian');
    const candidate = dressed.filter((r) => r.attribution_tier === 'ambiguous');

    res.json({
      driver: { id: d.id, name: d.name, ids: d.ids, platforms: d.platforms },
      attributed: {
        rows: attributed,
        /* Counted over the window, not over the 400 rows that came back. */
        total: (byTier.bracketed || 0) + (byTier.last_trip || 0) + (byTier.sole_custodian || 0),
        shown: attributed.length,
        by_tier: {
          bracketed: byTier.bracketed || 0,
          last_trip: byTier.last_trip || 0,
          sole_custodian: byTier.sole_custodian || 0,
        },
        heading: 'Unexplained journeys this person is named beside',
        means: 'One of three things: their own Uber trips on that car bracket the journey in '
          + 'time; theirs was the last Uber trip on that car before the journey started, which '
          + 'is the operator’s rule for who is responsible; or they are the only person the '
          + 'trip record shows holding the car that day. All three are inferences from the '
          + 'booking record, not trip records of the journey itself, and none of them says '
          + 'this person drove.',
      },
      also_a_candidate: {
        rows: candidate,
        total: byTier.ambiguous || 0,
        shown: candidate.length,
        heading: 'Cars this person held on a day an unexplained journey happened',
        means: candidate.length
          ? 'These journeys have more than one candidate and nothing separates them. This '
            + 'person is one of the people who held the car that day; so is somebody else. '
            + 'No claim is made about who was driving, and this list must never be counted '
            + 'together with the one above.'
          : 'None in this window.',
      },
      truncated: rows.length >= 400,
      /* What the two totals are, in words, so a page cannot print one as a
         complete figure while the caveat sits somewhere else on the response.
         The convention foldGrain() already uses for drivers_basis. */
      total_basis: rows.length >= 400
        ? 'Both totals are counted over the whole window and are exact. The ROWS are the 400 '
          + 'most recent of them, so the tables below are shorter than the counts above — '
          + 'narrow the date range to see the rest.'
        : 'Both totals are counted over the whole window, and every one of them is in the '
          + 'tables below.',
      coverage,
      value: { aed_per_km: rate, basis },
      tier_means: TIER_MEANS,
      bracket: { cap_min: BRACKET_CAP_MIN, platforms: BRACKET_PLATFORMS },
      last_trip: { cap_min: STALE_CAP_MIN, fresh_band_min: FRESH_BAND_MIN,
        platforms: BRACKET_PLATFORMS },
      status_feed: { history_from: historyFrom },
      note: ATTRIBUTION_CONTRACT,
    });
  }));
}
