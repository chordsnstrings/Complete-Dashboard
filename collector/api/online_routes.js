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
const STANDING = {
  waitlist: 'Uber has this account on its waitlist, so it cannot take work yet.',
  onboarding: 'This account is still being onboarded and has not been let loose yet.',
  rejected: 'Uber turned this application down, so this account will not be coming online.',
  suspended: 'Uber has suspended this account, so it cannot take work.',
  deactivated: 'Uber has deactivated this account, so it cannot take work.',
  inactive: 'Uber has this account down as inactive, so it cannot take work.',
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
  if (raw) return `Uber has this account as "${tidy(raw)}", which does not permit taking work.`;
  return 'Uber does not currently permit this account to take work.';
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

    const [people, drove, recent, custody, phones, feed] = await Promise.all([
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
      const askedAbout = (recentBy.get(key)?.n || 0) > 0;

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
        why = `${standingWords(pp.state_word, pp.state_raw)} Not coming online is what that `
          + 'means, so there is nothing here to chase.';
      } else if (!askedAbout) {
        basis = 'not_asked';
        why = 'Uber was never asked about this driver. The timeline is only requested for people '
          + 'who took a trip in the previous two days, and this person took none — so we hold no '
          + 'evidence either way, and none is coming until somebody runs the roster sweep.';
      } else {
        basis = 'absent';
        why = 'Uber was asked about this driver and returned no online event for this day.';
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
        ...(start == null || onlineMin == null ? { late: null, minutes_late: null }
          : { late: onlineMin > start, minutes_late: onlineMin - start }),
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
        drove: count((r) => r.trips > 0),
        ...(start == null ? {} : {
          late: count((r) => r.late === true),
          on_time: count((r) => r.late === false),
          unjudged: count((r) => r.late == null),
        }),
      },
      feed: {
        last_run_at: feedAt,
        note: 'Uber’s timeline runs every three hours and is only asked about drivers who '
          + 'took a trip in the previous two days. A driver with no trip was never asked, and '
          + 'renders as such rather than as absent.',
      },
    });
  }));
}
