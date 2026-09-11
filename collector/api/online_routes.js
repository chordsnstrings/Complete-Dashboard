/* When each driver came online, and whether that was late.
   ──────────────────────────────────────────────────────────────────────────
   Operations chase people who start late, and the fleet's answer to "who
   started late" lived in nothing but a per-driver chart nobody opens 109 times.
   This is the fleet, on one day, against a start time the reader sets.

   The whole difficulty is honesty about ABSENCE, and the operator named it
   before the page existed: "sometimes we get uberX trips but it doesn't show
   the driver going online on uber … or else it will be inaccurate data that
   the operations team will work on." A person marked late is a person who gets
   a phone call, so a gap in collection must never render as a gap in
   attendance. Measured on production 2026-09-09, there are FOUR distinct
   reasons a driver has no online time, and only one of them is about them:

     REPORTED       an ONLINE transition on this Dubai day. The answer.
                    100% of drivers who took an Uber trip on 2026-09-07 and
                    2026-09-08 — 82 of 82 and 84 of 84.

     ALREADY ONLINE a span from the previous day covers midnight and no fresh
                    transition follows it. The driver did not "come online at
                    00:00"; we joined the day with them already on. Printing
                    the clipped 00:00 as a start time is a false early mark,
                    and 14 of 82 drivers hit this on 2026-09-07 alone.

     AWAITING FEED  they took a trip, and the timeline has not caught up. Trips
                    arrive on the half-hourly incremental; the timeline runs on
                    UBER_TIMELINE_CRON, every three hours (src/settings.js:53).
                    So there is a structural window of up to ~3 hours where a
                    trip exists and its ONLINE event does not — exactly what the
                    operator saw. On 2026-09-09 at 07:30 it was two drivers,
                    both with a first trip at 06:30 against timeline runs that
                    finished at 06:17. It self-heals on the next tick, because
                    the fetch window is two days wide.

     NOT ASKED      and this one does NOT self-heal. src/sources/uber_timeline.js
                    :206-210 asks Uber only about drivers who already have a
                    trip in the two-day window. The whole-roster mode exists and
                    has no cron — it last ran 2026-08-27. Measured for
                    2026-09-08: 109 accounts hold an active Uber standing, 84
                    drove, and all 25 who did not also took no trip on the 6th
                    or 7th, so the collector never asked Uber about a single one
                    of them. We hold no evidence in either direction. "Never
                    came online" is unprovable for those people BY
                    CONSTRUCTION, and the page says not asked.

   THE FIRST TRIP IS AN UPPER BOUND, NEVER A SUBSTITUTE. A trip is necessarily
   after going online, so it bounds the online moment from above and a lateness
   verdict built on it is systematically too kind. Measured over 2026-09-07 and
   2026-09-08 on drivers whose first block is not clipped: the first trip lands
   a MEDIAN 68.5 and 73 minutes after the driver came online, p90 380 and 197,
   max 907. It is carried on the row as evidence — "was working by 07:14" — and
   it never colours anybody red.

   Nothing before 2026-07-28 is recoverable: that is the start of the only
   whole-roster sweep ever run, Uber serves at most 31 days, and coverage of
   driver-days-with-trips is 100% from that date and exactly 0% before it. */

import { placeAt } from './place_sql.js';
import { channelWords } from '../src/channels.js';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/* The reader's own start time, as minutes past Dubai midnight. Rejected rather
   than coerced: a page that silently reads 'half seven' as 00:00 marks the
   whole fleet late. */
export function startMinutes(v) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/* A STANDING, IN WORDS AN OPERATOR READS.
   ──────────────────────────────────────────────────────────────────────────
   The first version printed driver_platform_state.state_raw straight into the
   sentence, and production answered with
   `onboarding_status_waitlisted_auto_reactivation` — Uber's enum, on a page an
   operations person reads while deciding who to phone. That is the same defect
   ui.js's SOURCE_LABEL was written for: "These are database keys — fms,
   cabman — and they were rendered raw as panel HEADINGS."

   Measured on production 2026-09-09, all thirty accounts that cannot earn are
   at some stage of onboarding rather than suspended: 21 waitlisted, 6
   rejected, 2 accepted, 1 applied. So the four sentences say four DIFFERENT
   things — a person who was rejected is never coming, a person who was
   accepted has simply not started — because "cannot take work" alone would
   have an operator chase all four the same way.

   Keyed on the NORMALISED state (schema_v13:26), with the provider's own word
   as the fallback so a standing the normaliser could not place still says
   something true rather than nothing. Even that fallback is tidied: the enum's
   prefix is dropped and its underscores become spaces, because a raw key is
   never the right thing to show. */
/* Every non-earning member of src/roster.js's STATES, and `rejected` is the one
   that must not be missed: STATES:17-22 says why it exists as its own word —
   "Not 'onboarding' — nothing is in progress — and not 'deactivated', which is
   somebody who was working and was stopped." Six people are in it on
   production, and lumping them under a generic "cannot take work" would have
   an operator chase an application Uber has already turned down. */
/* Each entry is a WHOLE sentence, including what to do about it. A shared
   "Not coming online is what that means, so there is nothing here to chase"
   was appended to all of them at first, and after the rejected one it read
   "…will not be coming online. Not coming online is what that means" — the
   same clause twice, on the row where the answer is bluntest. What an operator
   should do differs by standing, so the ending does too. */
const STANDING = {
  waitlist: 'Uber has this account on its waitlist, so it cannot take work yet. '
    + 'Nothing to chase until Uber lets them off it.',
  onboarding: 'This account is still being onboarded and has not been let loose yet. '
    + 'Nothing to chase until Uber finishes with it.',
  rejected: 'Uber turned this application down. This account is not coming online, '
    + 'now or later, and it should not be on a call list at all.',
  suspended: 'Uber has suspended this account, so it cannot take work. The call worth '
    + 'making here is about the suspension, not about the morning.',
  deactivated: 'Uber has deactivated this account, so it cannot take work. If a car is '
    + 'still attached to this person, that is the thing to chase.',
  inactive: 'Uber has this account down as inactive, so it cannot take work. Nothing '
    + 'about this morning to chase.',
};
const tidy = (raw) => String(raw)
  .replace(/^onboarding_status_/, '').replace(/_/g, ' ').trim().toLowerCase();
export function standingWords(state, raw) {
  /* `unknown` is deliberately absent from the map: STATES:26 gives it
     can_earn null, not false, so a row whose standing we could not read never
     reaches this branch at all — it is not evidence that somebody cannot work.
     If one ever does, it falls to the raw word below rather than being given a
     sentence about a standing nobody established. */
  if (state && STANDING[state]) return STANDING[state];
  if (raw) {
    return `Uber has this account as "${tidy(raw)}", which does not permit taking work. `
      + 'Nothing about this morning to chase.';
  }
  return 'Uber does not currently permit this account to take work. Nothing about this '
    + 'morning to chase.';
}

export function onlineRoutes(app, { q, wrap }) {
  app.get('/api/online-time', wrap(async (req, res) => {
    const day = String(req.query.day || '');
    if (!ISO_DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
      return res.status(400).json({ error: 'day must be YYYY-MM-DD' });
    }
    const start = startMinutes(req.query.start);
    const p = [day];
    const D0 = `($1::date::timestamp AT TIME ZONE 'Asia/Dubai')`;
    const D1 = `(($1::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')`;
    /* THE PERSON, and never the empty string.
       ─────────────────────────────────────────────────────────────────────
       person_key is GENERATED from the name (sql/schema_v20.sql:28), so a row
       whose name is blank folds to '' rather than to NULL. Four queries here
       said `person_key IS NOT NULL`, which admits it — and every unnamed Uber
       account and every unnamed Uber trip then grouped into ONE row whose
       uber_ids was their union and whose first online moment was the earliest
       across all of them. One early sign-on rendered the whole pool on time
       and every late unnamed driver disappeared from the call list.

       The schema says this in its own words at sql/schema_v53.sql:753 — "an
       empty key must never become the bucket every anonymous row falls into" —
       and makes every person_key index partial on `<> ''` accordingly, which
       also means the four predicates could not use those indexes at all.

       api/custody_sql.js:174 exports exactly this expression for exactly this
       reason: an account nobody named keys on ITSELF, which keeps it on the
       page as its own row instead of merging or vanishing. */
    const PK = (a) => `coalesce(nullif(${a}.person_key, ''), ${a}.driver_ext_id)`;

    const [people, drove, worked, recent, swept, custody, phones, feed] = await Promise.all([
      /* WHO THE PAGE IS ABOUT. Everyone holding an Uber account, folded to the
         PERSON — api/identity_map.js applies 130 entries over 124 people, and
         in 37 of them the surviving canonical record is not the Uber one, so a
         page keyed on the Uber id alone loses those people's phone and portals.
         The Uber ids come back as an array because the timeline is keyed on
         them and a person can hold more than one. */
      q(`SELECT ${PK('dps')} AS person_key,
                min(full_name) FILTER (WHERE btrim(coalesce(full_name, '')) <> '') AS name,
                array_remove(array_agg(DISTINCT driver_ext_id)
                  FILTER (WHERE platform = 'uber'), NULL) AS uber_ids,
                array_remove(array_agg(DISTINCT driver_ext_id), NULL) AS all_ids,
                array_agg(DISTINCT platform ORDER BY platform) AS portals,
                /* WHICH FLEET'S SWEEP WOULD HAVE ASKED ABOUT THEM. The
                   whole-roster pass runs per fleet and takes the union of
                   driver_platform_state and trip for that fleet, so a dps row
                   here is exactly the thing that puts somebody in it. */
                array_remove(array_agg(DISTINCT fleet_id), NULL) AS fleets,
                bool_or(platform = 'uber' AND can_earn) AS can_earn,
                /* BOTH words for the standing. The normalised one
                   (schema_v13:26 — active | waitlist | onboarding | suspended |
                   deactivated | inactive | unknown) is what the sentence is
                   built from; the provider's own is kept beside it for the case
                   the normaliser could not place. */
                min(state) FILTER (WHERE platform = 'uber' AND can_earn IS NOT TRUE
                                     AND btrim(coalesce(state, '')) <> '') AS state_word,
                min(state_raw) FILTER (WHERE platform = 'uber' AND can_earn IS NOT TRUE
                                         AND btrim(coalesce(state_raw, '')) <> '') AS state_raw,
                min(plate) FILTER (WHERE platform = 'uber' AND plate IS NOT NULL) AS state_plate
           FROM driver_platform_state dps
          GROUP BY 1
         HAVING bool_or(platform = 'uber')`, []),
      /* What they actually did that day. The first trip is the upper bound the
         header describes; the count is what makes "no online event and no trip"
         a different row from "no online event and eleven trips". */
      /* FROM `trip`, NOT `trip_ext`. The view is `SELECT t.*` and was created
         before person_key was added to the table, so the star froze without it
         — confirmed against the test schema, where trip carries person_key and
         both trip_ext and trip_norm do not. The Dubai-day cast is written
         exactly as sql/schema_v53.sql:776 indexes it; `platform = 'uber'`
         already implies is_booking, which schema_v7 defines as platform <> 'fms'. */
      q(`SELECT ${PK('t')} AS person_key, min(requested_at) AS first_trip_at,
                count(*)::int AS trips,
                mode() WITHIN GROUP (ORDER BY plate) AS trip_plate,
                /* THE UBER IDS OF PEOPLE WHO DROVE, which is not the same set
                   as the roster's.
                   ──────────────────────────────────────────────────────────
                   Uber drops a driver from the supplier roster the moment the
                   account is deactivated (api/roster_routes.js:80-96 measures
                   395 people built from trips against 338 on the roster), but
                   src/sources/uber_timeline.js:203-210 picks who to ASK about
                   from the trip table, NOT from the roster — so Uber is still
                   asked, and still answers, for somebody the roster forgot.

                   This page took its Uber ids from driver_platform_state
                   alone. For those people uber_ids came back EMPTY, the
                   timeline lookup below had nothing to look up, and a driver
                   who came online at 09:30 fell through to "no online event
                   has arrived for the day yet … it is not evidence about the
                   driver" — every day, permanently, never healing. A gap in
                   the roster rendered as a gap in attendance, which is the one
                   thing the header of this file forbids, and it silently drops
                   the phone call the page exists to produce. */
                array_remove(array_agg(DISTINCT driver_ext_id), NULL) AS drove_ids
           FROM trip t
          WHERE platform = 'uber'
            AND (requested_at AT TIME ZONE 'Asia/Dubai')::date = $1::date
          GROUP BY 1`, p),
      /* WHAT THEY DID ON EVERY OTHER CHANNEL, which is the difference between
         "we know nothing about this person today" and "this person was driving
         a hotel job at 06:19".
         ─────────────────────────────────────────────────────────────────────
         The aggregate above is `platform = 'uber'` and has to stay that way:
         it decides `awaiting_feed` — "a trip exists and its ONLINE event has
         not landed yet" — and that sentence is only true of an UBER trip,
         because Uber's timeline is the only feed that could be behind. A
         hotel-only driver folded into it would be told the timeline was
         catching up on them when Uber was never asked about them at all.

         So the evidence is gathered separately. `platform <> 'fms'` rather
         than a list of names: schema_v7 defines is_booking that way, and FMS
         is a telematics feed that watches cars rather than a channel that
         sells rides — a GPS journey is not proof that somebody was working,
         only that a vehicle moved.

         MEASURED on production over 2026-09-08, -09 and -10: four people each
         day sit in the unjudged bucket while holding hotel trips on the very
         day the page says nothing can be said about them. Three of the four
         are worse than unjudged — they are in `cannot_earn`, so the page tells
         an operator they cannot take work while they are taking it. */
      q(`SELECT ${PK('t')} AS person_key,
                min(requested_at) AS work_first_at,
                count(*)::int AS work_trips,
                array_agg(DISTINCT platform ORDER BY platform) AS work_platforms,
                (array_agg(platform ORDER BY requested_at))[1] AS work_first_platform
           FROM trip t
          WHERE platform <> 'fms'
            AND (requested_at AT TIME ZONE 'Asia/Dubai')::date = $1::date
          GROUP BY 1`, p),
      /* WAS UBER EVER ASKED ABOUT THIS PERSON, in the collector's own units.
         ─────────────────────────────────────────────────────────────────────
         This decides which of two sentences a driver with no online event
         gets, and they say opposite things: `not_asked` says we hold no
         evidence, `absent` asserts that Uber was asked and had nothing. Only
         one of them can be printed truthfully, so the window has to be the
         window the collector actually used.

         It is not a calendar window. src/run.js:407-411 anchors the tick on
         the instant it wakes — `to = new Date(); from = daysAgo(2)` — and
         src/sources/uber_timeline.js:206-210 uses that SAME pair both to
         choose who to ask about and to bound what it fetches. Written here as
         three whole Dubai days it was up to 24 hours too generous, and the
         error ran the dangerous way: a driver whose last trip was 03:00 two
         days back counted as asked, so a day nobody actually fetched printed
         "Uber was asked about this driver and returned no online event for
         this day". False, and believed, on a page that produces phone calls.

         So: a rolling 48 hours ending where the collector's coverage of this
         day ends — the end of the day, or now if the day is still running. A
         tick at that instant has window [end - 48h, end] and its fetch covers
         the whole of the day, so a trip inside it is SUFFICIENT proof the
         person was selected. It is not necessary — an earlier tick may also
         have reached them — which makes the residual error fall towards
         `not_asked`, the state that claims nothing, rather than towards
         `absent`, the state that claims evidence. That direction is the
         house principle and it is deliberate. */
      q(`SELECT ${PK('t')} AS person_key, count(*)::int AS n
           FROM trip t
          WHERE platform = 'uber'
            AND requested_at <  least(${D1}, now())
            AND requested_at >= least(${D1}, now()) - interval '48 hours'
          GROUP BY 1`, p),
      /* THE OTHER WAY SOMEBODY GETS ASKED ABOUT: a whole-roster sweep.
         ─────────────────────────────────────────────────────────────────────
         The query above reconstructs the INCREMENTAL tick's selection rule —
         a trip in the previous 48 hours — and that was the only test. It is
         not the only way the collector reaches a driver: `timeline-roster`
         asks about every driver on the fleet's books regardless of trips, and
         src/sources/uber_timeline.js takes the union of driver_platform_state
         and trip to build that list.

         So for every day such a sweep covered, this page was printing the
         WEAKER AND WRONGER of its two sentences. Measured on production before
         this was added: the sweep of 2026-08-27 covered 2026-07-28 to
         2026-08-27, and across that month the page reported 44 to 49 people a
         day as "Uber was never asked about this driver … we hold no evidence
         either way" — about people Uber was definitively asked about and
         returned nothing for. The product was understating what it knows over
         exactly the period it knows most about.

         A PARTLY COVERED DAY IS NOT AN UNCOVERED ONE. The run records the
         instant it woke as its end, so its last day is covered only up to that
         moment — and the tick's last day is ALWAYS TODAY, the day the page is
         actually read. Excluding it outright, which is what this did first,
         meant today's readers kept the "we never asked" sentence about people
         Uber had been asked about all morning: 37 of them on 2026-09-11, over
         a pass that had run at 16:18 Dubai.

         So the coverage carries HOW FAR INTO THE DAY it reaches, as minutes
         from that day's Dubai midnight, capped at a whole day. The question
         this page asks is "were they online by the start time", and a pass
         that ran past the start time answers it; one that stopped before it
         does not, and that day stays unclaimed. The error still falls towards
         `not_asked`, the state that asserts nothing — which is the direction
         the comment above chose and this keeps. */
      q(`SELECT fleet_id, max(finished_at) AS swept_at,
                max(least(
                  extract(epoch from (finished_at
                    - ($1::date::timestamp AT TIME ZONE 'Asia/Dubai'))) / 60,
                  1440))::int AS covered_minutes
           FROM collection_run
          WHERE source = 'uber_timeline' AND mode = 'roster' AND status = 'ok'
            AND window_start <= $1::date AND window_end >= $1::date
          GROUP BY 1`, [p[0]]),
      /* The car they held that day, from the shared definition every other
         vehicle fact uses. Trip-derived, so it is empty for a driver with no
         trip — the state plate above is the only thing left for those, and the
         two are labelled differently on the row because they are different
         claims. */
      q(`SELECT ${PK('vdd')} AS person_key, mode() WITHIN GROUP (ORDER BY plate) AS plate
           FROM vehicle_driver_day vdd
          WHERE day = $1::date AND plate IS NOT NULL
          GROUP BY 1`, p),
      /* The number operations dials. api/redact.js:50-66 states that phone and
         email are deliberately NOT withheld — they are an operator-requested
         feature; what that module strips is emirates_id and licence_no. */
      q(`SELECT driver_ext_id, max(phone) AS phone FROM driver_compliance
          WHERE phone IS NOT NULL AND btrim(phone) <> '' GROUP BY 1`, []),
      /* When the timeline last ran, so "awaiting feed" can name its own clock
         rather than asking the reader to take it on trust. */
      q(`SELECT max(finished_at) AS last_at FROM collection_run
          WHERE source = 'uber_timeline' AND status <> 'error'`, []),
    ]);

    /* ── STAGE TWO: the timeline, for the people this page is about ────────
       Split out of the fan-out above rather than run beside it, because it
       needs the ids the first two queries produce — and needs them for two
       separate reasons.

       CORRECTNESS: the id set is the roster's Uber accounts UNION the accounts
       that actually drove that day. The second half is what puts a driver Uber
       has dropped from the supplier roster back on this page with their real
       online time; see the comment on drove_ids above.

       COST: driver_timeline_event is indexed (driver_ext_id, at)
       (sql/schema_v37.sql:56) and has ~197,687 rows. Bounding `at` alone
       matched no index — not that one, which leads on the id, and not
       dte_fleet_day_idx, which is built on the Dubai-DATE expression and not on
       a raw timestamptz range — so every request scanned the whole table. The
       sibling that runs this identical CTE, api/driver_routes.js:2261, binds
       driver_ext_id, and test/indexes.test.mjs excuses it on exactly that
       ground. */
    const askIds = [...new Set([
      ...people.flatMap((r) => r.uber_ids || []),
      ...drove.flatMap((r) => r.drove_ids || []),
    ].filter(Boolean))];
    /* PARTITIONED BY ACCOUNT, and that is load-bearing rather than tidy: one
       ordering across two Uber accounts closes an ONLINE on account A with an
       OFFLINE on account B and yields spans belonging to neither
       (api/driver_routes.js:2050-2055 records the same rule).

       Fetched a day either side, because a span is opened by one event and
       closed by the NEXT — the ONLINE at 23:40 yesterday is what makes this
       morning online at all, and clipping the fetch to the day throws away
       the row the lead() needs.

       A dangling ONLINE — next_at null, the most recent transition we hold —
       still starts a span. Its start is a fact even when its end is not. */
    const online = askIds.length
      ? await q(`WITH ev AS (
         SELECT driver_ext_id, at, status,
                lead(at) OVER (PARTITION BY driver_ext_id ORDER BY at) AS next_at
           FROM driver_timeline_event
          WHERE driver_ext_id = ANY($2::text[])
            AND kind = 'status' AND status <> ''
            AND at >= (($1::date - 1)::timestamp AT TIME ZONE 'Asia/Dubai')
            AND at <  (($1::date + 2)::timestamp AT TIME ZONE 'Asia/Dubai')),
       spans AS (
         SELECT driver_ext_id, at AS span_start, next_at AS span_end
           FROM ev WHERE status = 'ONLINE')
       SELECT driver_ext_id,
              min(span_start) FILTER (
                WHERE span_start >= ${D0} AND span_start < ${D1}) AS first_at,
              /* Already online when the day began. Not a start time — see the
                 header — and a row that reports 00:00 here is claiming the
                 driver signed on at midnight. */
              bool_or(span_start < ${D0}
                      AND (span_end IS NULL OR span_end > ${D0})) AS covered_midnight
         FROM spans GROUP BY 1`, [day, askIds])
      : [];

    const byKey = (rows) => new Map(rows.map((r) => [r.person_key, r]));
    const droveBy = byKey(drove);
    const workedBy = byKey(worked);
    /* Keyed on fleet, not person: a sweep covers a fleet's whole roster. */
    const sweptBy = new Map((swept || []).map((r) => [r.fleet_id, r]));
    const recentBy = byKey(recent);
    const custodyBy = byKey(custody);
    const phoneBy = new Map(phones.map((r) => [r.driver_ext_id, r.phone]));
    const onlineBy = new Map(online.map((r) => [r.driver_ext_id, r]));
    const feedAt = feed[0]?.last_at || null;

    /* Everyone with an Uber account, plus anyone who drove Uber that day and
       has no state row — a person who worked is on this page whatever the
       roster says about them. */
    const keys = new Set([...people.map((r) => r.person_key), ...drove.map((r) => r.person_key)]);
    const peopleBy = byKey(people);

    const minsInto = (ts) => {
      if (!ts) return null;
      const d = new Date(ts);
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai',
        hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
      const h = Number(parts.find((x) => x.type === 'hour').value);
      const m = Number(parts.find((x) => x.type === 'minute').value);
      return h * 60 + m;
    };

    const rows = [];
    for (const key of keys) {
      const pp = peopleBy.get(key) || { person_key: key, uber_ids: [], all_ids: [], portals: [] };
      const d = droveBy.get(key);
      const w = workedBy.get(key);
      /* Minutes into the Dubai day of the first booking on ANY earning
         channel. Named `worked` rather than `first trip` because that is what
         it establishes: somebody had to be online to be given the job. */
      const workedMin = w?.work_first_at == null ? null : minsInto(w.work_first_at);
      const trips = d?.trips || 0;
      /* The earliest transition across the person's Uber accounts. min over the
         accounts rather than a single id, because the fold is the point. */
      let firstAt = null, midnight = false;
      /* The roster's accounts UNION the accounts that drove. A person Uber has
         dropped from the supplier roster has an empty uber_ids and a full
         drove_ids, and their timeline is on record either way — see drove_ids
         above. Deduplicated, because for everybody else the two are the same. */
      const ids = [...new Set([...(pp.uber_ids || []), ...(d?.drove_ids || [])])];
      for (const id of ids) {
        const o = onlineBy.get(id);
        if (!o) continue;
        if (o.covered_midnight) midnight = true;
        if (o.first_at && (!firstAt || new Date(o.first_at) < new Date(firstAt))) firstAt = o.first_at;
      }
      /* ASKED ABOUT, BY EITHER ROUTE. The incremental tick reaches people with
         a recent trip; the whole-roster sweep reaches everybody on the fleet's
         books. Both are real asks and either one makes "we never asked" false,
         so the page must test both or it prints a sentence it cannot support. */
      const sweeps = (pp.fleets || []).map((f) => sweptBy.get(f)).filter(Boolean);
      const coveredMin = sweeps.length
        ? Math.max(...sweeps.map((r) => Number(r.covered_minutes) || 0)) : null;
      /* How far into this day a whole-roster pass reached, and whether that is
         far enough to answer the question on screen. A pass that stopped before
         the start time cannot say whether somebody was late by it, so the day
         stays unclaimed rather than being reported as asked-and-nothing. With
         no start time set there is no threshold to clear, so only a whole day
         counts. */
      const sweptWhole = coveredMin != null && coveredMin >= 1440;
      const sweptEnough = sweptWhole
        || (coveredMin != null && start != null && coveredMin >= start);
      const sweptAt = sweptEnough
        ? sweeps.map((r) => r.swept_at).filter(Boolean).sort().pop() || null : null;
      const askedAbout = (recentBy.get(key)?.n || 0) > 0 || sweptEnough;

      let basis, why;
      if (firstAt) {
        basis = 'reported'; why = 'Uber recorded the driver coming online at this time.';
      } else if (midnight) {
        basis = 'already_online';
        why = 'The driver was already online when the day began — the shift started before '
          + 'midnight, so this day has no start time of its own.';
      } else if (trips > 0) {
        basis = 'awaiting_feed';
        why = 'This driver took a trip, and no online event has arrived for the day yet. Trips '
          + 'land every half hour and the timeline every three hours, so the two run on '
          + 'different clocks'
          + (feedAt ? ` — the timeline last ran at ${new Date(feedAt).toISOString().slice(11, 16)} UTC. ` : '. ')
          + 'It fills in on the next pass; it is not evidence about the driver.';
      } else if ((w?.work_trips || 0) > 0) {
        /* THEY WERE DRIVING, on a channel that does not publish a timeline.
           ───────────────────────────────────────────────────────────────────
           Checked BEFORE cannot_earn, and that ordering is the point. `can_earn`
           is read off the UBER standing, so a driver Uber has waitlisted while
           the hotel channel keeps giving them jobs was being told, on an
           operations page, that they cannot take work — on days they took five
           of them. Measured on production 2026-09-08, -09 and -10: three people
           every day, every one of them driving hotel jobs under a sentence
           saying they could not.

           Checked AFTER awaiting_feed for the opposite reason: if an UBER trip
           exists then Uber's timeline genuinely is behind, and that is a more
           specific and more useful thing to say than this. */
        const chans = channelWords(w.work_platforms);
        basis = 'worked_elsewhere';
        why = `No Uber online event for this day, and none is expected: this driver worked `
          + `${chans}, which report finished trips and never publish when somebody came `
          + `online. The first of ${w.work_trips === 1 ? 'their trips' : `their ${w.work_trips} trips`} `
          + `was at ${hhmm(workedMin)}, so they were online at or before then — a trip cannot `
          + 'be given to a driver who is not.'
          /* And when that proof lands AFTER the start time it is not proof of
             anything about the start time. Said here rather than left for the
             reader to work out, because the natural reading of "first trip
             12:14" under a heading about lateness is that the person turned up
             at noon, and the header of this file measures the gap between
             coming online and the first trip at a median of 68 to 73 minutes
             and a maximum of 907. */
          + (start != null && workedMin > start
            ? ` That is after ${hhmm(start)}, which does not make them late: a driver `
              + 'online from first thing who is offered nothing until midday has the same '
              + 'first trip as one who started at midday. It is not judged either way.'
            : '');
      } else if (pp.can_earn === false) {
        /* A FIFTH state, and it was found on production rather than designed:
           of 157 people holding an Uber account on 2026-09-09, 30 held one
           that cannot take work at all — suspended, deactivated, waitlisted.
           They were falling into `not_asked` and sitting in the call list, and
           the operator's whole reason for asking for this page was that
           operations must not be handed inaccurate rows to work on. Phoning a
           deactivated driver to ask why they did not come online is precisely
           that call.

           Checked AFTER `reported` and after `awaiting_feed`, deliberately: a
           suspended driver who DID come online, or who took a trip, is a fact
           worth surfacing exactly as it is, and this state must never mask it.
           It only claims the remaining case — no event, no trip, and no
           standing that would have let them work. */
        basis = 'cannot_earn';
        why = standingWords(pp.state_word, pp.state_raw);
      } else if (!askedAbout) {
        basis = 'not_asked';
        /* The sentence used to end "and none is coming until somebody runs the
           roster sweep", which was true and is not any more: the three-hourly
           tick asks about the whole roster now, and there is a weekly deep
           sweep behind it (src/index.js). So this state stops meaning "nobody
           will ever look" and starts meaning "no pass has reached this day
           yet" — which is a different thing to tell an operator, because one
           of them is worth waiting for. */
        why = 'Uber was never asked about this driver for this day, so we hold no evidence '
          + 'either way. The timeline tick covers the whole roster over a two-day window every '
          + 'three hours and a thirty-day sweep runs weekly, so a recent day fills in by itself; '
          + 'a day that stays like this is older than any pass has reached, or a pass that '
          + 'could not sign in to Uber.';
      } else {
        basis = 'absent';
        /* WHICH ask found nothing, because the two are different strengths of
           evidence and an operator deciding whether to ring somebody should be
           told which one this is. A sweep asked about every driver on the
           books for a whole span at once; the incremental tick asked because
           this person had a recent trip. */
        why = sweptAt
          ? 'Uber was asked about every driver on the roster '
            + (sweptWhole
              ? 'for this day'
              /* The cut-off, said out loud. "Asked and nothing" over half a day
                 is a weaker claim than over a whole one, and an operator
                 deciding whether to ring somebody is entitled to know which
                 they are holding. */
              : `for this day up to ${hhmm(coveredMin)}`)
            + ` — the whole-roster sweep of ${new Date(sweptAt).toISOString().slice(0, 10)} `
            + 'covered it — and returned no online event for this person. They did not come '
            + `online${sweptWhole ? '' : ` before ${hhmm(coveredMin)}`}.`
          : 'Uber was asked about this driver and returned no online event for this day.';
      }

      const onlineMin = basis === 'reported' ? minsInto(firstAt) : null;
      rows.push({
        person_key: key,
        name: pp.name || null,
        driver_ext_id: ids[0] || null,
        uber_ids: ids,
        can_earn: pp.can_earn ?? null,
        online_at: basis === 'reported' ? firstAt : null,
        online_minute: onlineMin,
        online_local: onlineMin == null ? null : hhmm(onlineMin),
        online_basis: basis,
        online_why: why,
        /* The upper bound, always carried and never a verdict. See the header:
           a median 68 to 73 minutes after the true online moment. */
        first_trip_at: d?.first_trip_at || null,
        first_trip_local: d?.first_trip_at == null ? null : hhmm(minsInto(d.first_trip_at)),
        trips,
        /* THE SAME BOUND, OVER EVERY EARNING CHANNEL. `first_trip_at` above is
           Uber's alone, which is right beside an Uber online stamp and useless
           for the person whose whole day was hotel jobs — they had no Uber trip
           BY DEFINITION of being in this bucket, so the column was empty for
           every single one of the people it could have helped. Measured on
           production 2026-09-10: 0 of the 72 unjudged rows carried an Uber
           first trip, and 4 of them were driving. */
        worked_first_at: w?.work_first_at || null,
        worked_first_local: workedMin == null ? null : hhmm(workedMin),
        worked_first_platform: w?.work_first_platform || null,
        worked_platforms: w?.work_platforms || [],
        worked_trips: w?.work_trips || 0,
        plate: custodyBy.get(key)?.plate || d?.trip_plate || pp.state_plate || null,
        plate_basis: (custodyBy.get(key)?.plate || d?.trip_plate)
          ? 'held that day'
          : (pp.state_plate ? 'attached on the Uber roster — not a car we saw them drive today' : null),
        /* driver_compliance is keyed on the account, not the roster, so a
           person with no driver_platform_state row can still have a number on
           file — and on this page a number is the whole point. all_ids first,
           because a person's non-Uber records often carry the better one. */
        phone: [...(pp.all_ids || []), ...ids].map((id) => phoneBy.get(id)).find(Boolean) || null,
        portals: pp.portals || [],
        /* Filled by the placement pass below, for the rows that have a moment
           to place. */
        where: null, where_why: null,
        /* THE VERDICT, and the one-sided rule that governs the second source.
           ───────────────────────────────────────────────────────────────────
           An online stamp is two-sided: it says when they came on, so it can
           mark somebody late OR on time. A first trip is not. It proves
           somebody was online at or before it — a job cannot be given to a
           driver who is not — so:

             a trip at or before the start   PROVES they were there in time.
             a trip after the start          proves NOTHING about lateness.
                                             They may have been online from
                                             06:00 and been offered nothing.
                                             The header measures the gap at a
                                             median 68-73 minutes and a max of
                                             907, so reading a late first trip
                                             as a late start would invent a
                                             phone call out of a quiet morning.

           So the evidence is only ever allowed to clear somebody, never to
           accuse them, and it is applied only where the online stamp said
           nothing at all. `minutes_late` stays null on those rows: we know they
           were in time, not how early. `judged_by` names which source decided,
           because "on time" established two ways is two different strengths of
           claim and the page has to be able to say which it holds. */
        ...(start == null ? { late: null, minutes_late: null, judged_by: null }
          : onlineMin != null
            ? { late: onlineMin > start, minutes_late: onlineMin - start, judged_by: 'online' }
            : workedMin != null && workedMin <= start
              ? { late: false, minutes_late: null, judged_by: 'first_trip' }
              : { late: null, minutes_late: null, judged_by: null }),
      });
    }

    /* WHERE THE CAR WAS when they came online, from the nearest telemetry fix
       to that moment. The gazetteer names it (api/place_sql.js); a fix is
       refused past thirty minutes, because a position half a shift away is not
       where they started.

       One query over the whole page rather than one per driver: the pairs go in
       as two arrays and the LATERAL picks the nearest fix per pair. */
    const placeable = rows.filter((r) => r.plate && r.online_at);
    if (placeable.length) {
      /* placeAt(), not a hand-written join on round(lat / 0.005).
         api/place_sql.js:18-22 states the rule and names the single existing
         offender: "The cell size is imported, never retyped … a second literal
         is a second place to get it wrong: change CELL in src/places.js and
         that query silently starts reading a gazetteer built on a different
         grid, returning names for the WRONG GROUND rather than no names at
         all." This was about to be the third. The helper also brings the vote
         counts along with the name, which is the module's other rule — a cell
         one trip named is not the claim a cell four hundred trips agree on. */
      const fixes = await q(
        `SELECT t.i, s.captured_at, s.lat, s.lng,
                abs(extract(epoch FROM (s.captured_at - t.at)) / 60)::int AS within_min,
                ${placeAt('s.lat', 's.lng')} AS place
           FROM unnest($1::text[], $2::timestamptz[]) WITH ORDINALITY AS t(plate, at, i)
           JOIN LATERAL (
             SELECT captured_at, lat, lng FROM telemetry_snapshot s2
              WHERE s2.plate = t.plate AND s2.lat IS NOT NULL AND s2.lng IS NOT NULL
                AND s2.captured_at BETWEEN t.at - interval '30 minutes'
                                       AND t.at + interval '30 minutes'
              ORDER BY abs(extract(epoch FROM (s2.captured_at - t.at))) LIMIT 1) s ON TRUE`,
        [placeable.map((r) => r.plate), placeable.map((r) => r.online_at)]);
      const byIdx = new Map(fixes.map((f) => [Number(f.i), f]));
      placeable.forEach((r, i) => {
        const f = byIdx.get(i + 1);
        if (!f) {
          r.where_why = 'no position was recorded for this car within half an hour of the moment '
            + 'they came online';
          return;
        }
        const place = f.place || {};
        r.where = { area: place.area || null, votes: place.votes ?? null, seen: place.seen ?? null,
          lat: f.lat, lng: f.lng, within_min: f.within_min };
        /* The car, and how sure we are it is THEIR car. plate_basis is already
           on the row for the Plate column; it belongs in this sentence too,
           because the area is derived from the plate and inherits every doubt
           the plate carries. A row placed off the roster's attached vehicle is
           reporting where SOME car was — possibly one another driver had that
           day — and a sentence reading "nearest fix 3 min from the moment they
           came online", with no qualification, invites a caller to treat it as
           the driver's own position. */
        const car = /not a car we saw them drive today/.test(r.plate_basis || '')
          ? `, from ${r.plate}, the car attached to them on the Uber roster — we did not see `
            + 'them drive it that day'
          : '';
        r.where_why = place.area
          ? `nearest fix ${f.within_min} min from the moment they came online${car}`
          : `the fleet has never driven near enough to this spot to have a name for it${car}`;
      });
    }

    /* LATEST FIRST, and everyone we cannot judge after everyone we can.
       ─────────────────────────────────────────────────────────────────────
       The secondary key is online_minute DESCENDING, so the person who signed
       on latest — the person furthest behind — is the first row. That is what
       a call list wants and it is what this comment used to describe
       backwards, as "Late last, on-time first". The desktop caption above the
       same table said "Late last" too and had to be fixed for the same reason:
       a caption or a comment that contradicts the sort teaches whoever reads
       it next to distrust the sort. */
    const ORDER = { reported: 0, already_online: 1, awaiting_feed: 2, absent: 3,
      not_asked: 4, cannot_earn: 5 };
    rows.sort((a, b) => (ORDER[a.online_basis] - ORDER[b.online_basis])
      || ((b.online_minute ?? -1) - (a.online_minute ?? -1))
      || String(a.name || '').localeCompare(String(b.name || '')));

    const count = (f) => rows.filter(f).length;
    res.json({
      day,
      expected_start: start == null ? null : hhmm(start),
      /* WHY THERE IS NO VERDICT, when there is none.
         ────────────────────────────────────────────────────────────────────
         startMinutes() rightly refuses to read 'half seven' as 00:00 — that
         would mark the whole fleet late — but refusing silently produced the
         other half of the same problem: a page with no red rows, no green
         rows, and nothing anywhere saying the time it was given could not be
         read. The reader sees a morning where nobody was late. Absent, with no
         reason, on the one figure the page exists to compute.

         Absent is the right answer. Unexplained is not, and this is the
         product's own principle: a figure that cannot be measured renders
         absent WITH A REASON, and never a reason that is not the true one. So
         the two absences are told apart — nothing asked for, versus something
         asked for that could not be read — and the second one names what it
         was handed back. */
      start_why: start != null ? null
        : (String(req.query.start ?? '').trim() === ''
          ? 'No start time was set, so nobody is marked late or on time.'
          : `"${String(req.query.start).trim().slice(0, 20)}" is not a time this page can read. `
            + 'Give it as HH:MM on a 24-hour clock — 06:00, not 6am — and nobody is judged '
            + 'until it can be.'),
      rows,
      totals: {
        people: rows.length,
        reported: count((r) => r.online_basis === 'reported'),
        already_online: count((r) => r.online_basis === 'already_online'),
        awaiting_feed: count((r) => r.online_basis === 'awaiting_feed'),
        not_asked: count((r) => r.online_basis === 'not_asked'),
        cannot_earn: count((r) => r.online_basis === 'cannot_earn'),
        absent: count((r) => r.online_basis === 'absent'),
        worked_elsewhere: count((r) => r.online_basis === 'worked_elsewhere'),
        drove: count((r) => r.trips > 0),
        /* Anybody who took a booking on any channel. `drove` above is Uber's
           count and stays that way — it pairs with the Uber-shaped bases — but
           an operator asking "how many of my people worked today" means this
           one. */
        worked: count((r) => r.worked_trips > 0),
        ...(start == null ? {} : {
          late: count((r) => r.late === true),
          on_time: count((r) => r.late === false),
          /* Of those, how many were established by a trip rather than by an
             online stamp. The tile prints it: "on time" proved by somebody
             driving at 06:19 is a different strength of claim from "on time"
             read off Uber's own transition, and a page that shows one number
             for both has quietly merged them. */
          on_time_by_trip: count((r) => r.late === false && r.judged_by === 'first_trip'),
          unjudged: count((r) => r.late == null),
          /* THE BREAKDOWN OF THE GREY, counted over the grey rows themselves.
             ───────────────────────────────────────────────────────────────
             The per-basis totals above count every row of that basis, judged
             or not, and the tile's caption was built from them. That held only
             while no basis could ever be judged — and now one can: a driver
             cleared by a trip keeps whatever basis explains their missing
             online stamp while moving into "on time". The caption immediately
             stopped adding up to the figure above it, 4 named under a 5, which
             is the defect that tile's own comment says it was pinned for once
             already. Restricted to the unjudged rows, it adds up by
             construction rather than by the two happening to agree. */
          unjudged_by_basis: Object.fromEntries(
            ['already_online', 'awaiting_feed', 'not_asked', 'cannot_earn', 'absent',
              'worked_elsewhere']
              .map((b) => [b, count((r) => r.late == null && r.online_basis === b)])),
          /* Unjudged people who WERE demonstrably driving — their first trip
             just landed after the start time, so it cannot say whether they
             were late. Worth its own number because it is the one slice of the
             unjudged bucket an operator can still do something about. */
          unjudged_but_worked: count((r) => r.late == null && r.worked_trips > 0),
        }),
      },
      feed: {
        last_run_at: feedAt,
        /* WHAT THE COLLECTOR ACTUALLY DOES, which changed under this sentence.
           It said the timeline was "only asked about drivers who took a trip in
           the previous two days" — the reason 39 people a day were unmeasurable
           — and the tick now asks about the whole roster. A caption describing
           a schedule the collector no longer runs is the same class of defect
           as a figure describing a window the query no longer uses. */
        note: 'Uber’s timeline runs every three hours and asks about every driver on the '
          + 'roster, not only those who took a trip. A day no pass has reached yet renders as '
          + 'not asked rather than as absent.',
        /* When a whole-roster pass last covered THIS day, which is what lets
           the rows above say "asked and nothing" rather than "never asked". */
        roster_swept_at: (swept || []).map((r) => r.swept_at).filter(Boolean).sort().pop() || null,
      },
    });
  }));
}
