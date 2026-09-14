/* Is this driver online RIGHT NOW, and how long have they been?
   ──────────────────────────────────────────────────────────────────────────
   The operator's question, from a FleetHub screenshot: a driver Uber reports
   as online for 5.16 hours, showing nothing on this product. The cause was not
   the feed and not the cadence — /v1/vehicle-suppliers/drivers/actions has
   answered every two minutes since the live map was built, carrying each
   driver's status with the instant it changed, and src/sources/uber.js threw
   all of it away except a plate-keyed telemetry row for the drivers who
   happened to have a vehicle attached. sql/schema_v70.sql has the measurement.

   So this file serves what was always arriving:

     /api/status/driver   one person — live standing, when they came online,
                          how long online today, and the spans behind it
     /api/status/fleet    everybody, for a wall or a phone

   ── THE TWO CLOCKS, AND WHY BOTH ARE ON EVERY ROW ────────────────────────
   `status_at` is when Uber says the status changed. `observed_at` is when this
   fleet last heard from the feed. They answer different questions and a page
   that shows only the first cannot be trusted: "online since 06:14" read off a
   feed that stopped answering at noon is a claim about this morning made from
   a dead source, and it looks identical to a live one. Every row carries both
   and a `stale` flag computed from the second.

   ── WHAT THIS CANNOT SAY, AND SAYS SO ────────────────────────────────────
   The event history starts when the collector started writing it. A driver who
   came online before that has a first-online-today we do not hold, and the
   honest answer is the one this returns: online_since is null and the reason
   names the gap rather than reporting a later event as their start. */
import { dubaiIso } from '../src/util.js';

/* How long after the last successful poll a live answer stops being live.
   LIVE_STATUS_SECONDS is 120, so three missed ticks. Below that a gap is the
   ordinary jitter of a scheduler sharing a box with the collector; above it
   something is wrong and the page must stop implying otherwise. */
export const STALE_AFTER_MIN = 8;

/* online and ontrip are both WORKING. A page that counts only `online` reports
   a driver carrying a passenger as not working, which is the opposite of the
   truth and the easiest mistake to make here — Uber moves a driver out of
   ONLINE and into ONTRIP the moment they accept. */
export const WORKING = ['online', 'ontrip'];

const STATUS_WORD = {
  online: 'online and waiting for a job',
  ontrip: 'on a trip',
  offline: 'offline',
};

/* The spans of one Dubai day, built from the provider's own change events.
   ─────────────────────────────────────────────────────────────────────────
   lead() over the day gives each event its successor; a span runs from the
   event to that successor, and the last one runs to NOW — clamped to the end
   of the day so that yesterday's final ONLINE does not accrue minutes for
   ever. Clamped at the start too: a status that changed at 23:50 yesterday is
   the state this day OPENED in, and its minutes belong to today from midnight,
   not from 23:50.

   That opening state is why the query reaches one event BEFORE the day. Left
   out, a driver who came online at 05:00 and was still online at midnight
   reads as having started work at their first change AFTER midnight — which on
   a night shift is the moment they went offline. */
const SPANS_SQL = `
  WITH bounds AS (
    SELECT ($2::date::timestamp AT TIME ZONE 'Asia/Dubai')               AS day_start,
           (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')         AS day_end
  ),
  ev AS (
    SELECT e.at, e.status
      FROM driver_status_event e, bounds b
     WHERE e.driver_ext_id = ANY($1::text[])
       AND e.at < b.day_end
       AND e.at >= b.day_start - interval '2 days'
     ORDER BY e.at),
  /* The state the day opened in: the last event at or before midnight. */
  opening AS (
    SELECT b.day_start AS at, e.status
      FROM bounds b
      LEFT JOIN LATERAL (
        SELECT status FROM ev WHERE ev.at <= b.day_start ORDER BY ev.at DESC LIMIT 1
      ) e ON true
     WHERE e.status IS NOT NULL),
  inday AS (
    SELECT at, status FROM ev, bounds b WHERE at > b.day_start
    UNION ALL
    SELECT at, status FROM opening),
  spanned AS (
    SELECT at, status,
           lead(at) OVER (ORDER BY at) AS next_at
      FROM inday)
  SELECT status,
         to_char(at AT TIME ZONE 'Asia/Dubai', 'HH24:MI')                AS from_local,
         at                                                               AS from_at,
         least(coalesce(next_at, now()), (SELECT day_end FROM bounds), now()) AS to_at,
         round(extract(epoch FROM (
           least(coalesce(next_at, now()), (SELECT day_end FROM bounds), now()) - at)) / 60)::int
                                                                          AS minutes
    FROM spanned
   WHERE least(coalesce(next_at, now()), (SELECT day_end FROM bounds), now()) > at
   ORDER BY at`;

export function statusRoutes(app, { q, wrap }) {
  /* ── one person ────────────────────────────────────────────────────────── */
  app.get('/api/status/driver', wrap(async (req, res) => {
    const id = req.query.id || null;
    if (!id) return res.status(400).json({ error: 'id required' });
    const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : dubaiIso();

    /* EVERY ACCOUNT THIS PERSON HOLDS, not the one id that was clicked.
       api/identity_map.js folds several platform records into one human and
       the driver page is about the human — so a person with two Uber accounts
       has both asked about, and the answer is the busiest of them. Uber is the
       only channel here that reports a status at all, which the response says
       rather than leaving the reader to wonder about the other three. */
    const ids = await q(
      `SELECT DISTINCT t.driver_ext_id
         FROM trip t
        WHERE t.platform = 'uber'
          AND coalesce(nullif(t.person_key, ''), t.driver_ext_id) =
              (SELECT coalesce(nullif(person_key, ''), driver_ext_id)
                 FROM trip WHERE driver_ext_id = $1 LIMIT 1)
          AND coalesce(btrim(t.driver_ext_id), '') <> ''`, [id]);
    const all = [...new Set([id, ...ids.map((r) => r.driver_ext_id)])];

    const [now] = await q(
      `SELECT driver_ext_id, fleet_id, status, status_raw, status_at, onboarding, plate, observed_at
         FROM driver_status_now
        WHERE platform = 'uber' AND driver_ext_id = ANY($1::text[])
        ORDER BY observed_at DESC NULLS LAST, status_at DESC NULLS LAST
        LIMIT 1`, [all]);

    const spans = await q(SPANS_SQL, [all, day]);
    const working = spans.filter((s) => WORKING.includes(s.status));
    const onlineMin = working.reduce((a, s) => a + (s.minutes || 0), 0);
    const onTripMin = spans.filter((s) => s.status === 'ontrip')
      .reduce((a, s) => a + (s.minutes || 0), 0);
    const first = working[0] || null;

    const ageMin = now?.observed_at
      ? Math.round((Date.now() - new Date(now.observed_at).getTime()) / 60000) : null;
    const stale = ageMin == null || ageMin > STALE_AFTER_MIN;

    /* A ROW THAT EXISTS AND CARRIES NO STATUS IS STILL ABSENT.
       ─────────────────────────────────────────────────────────────────────
       Found on production the hour this shipped, and it is the exact failure
       this feature was written to prevent. `absent` was set only when there
       was NO row — but the live feed lists every driver Uber knows of, and
       writes a row for each whether or not it reports a status for them. On
       2026-09-14, 66 of 158 rows came back with statusEntries empty: a row
       present, `status` null.

       The strip reads `if (!st || st.absent)`, so a null `absent` fell through
       to the word ladder, whose last rung is "Offline" — and sixty-six drivers
       Uber had said NOTHING about were being reported as offline, confidently,
       in a product whose first principle is that a figure that cannot be
       measured renders absent with the TRUE reason.

       It is a different reason from having no row at all, so it gets a
       different sentence: one says Uber does not list this person, the other
       says Uber lists them and has reported no status. Both are honest; only
       "Offline" was not. */
    const known = !!now?.status;

    res.json({
      day,
      driver_ext_id: id,
      uber_ids: all,
      /* ABSENT WITH A REASON, never a cheerful "offline". A driver Uber has
         never told us about and a driver Uber says is offline are different
         facts and only one of them is about the driver. */
      status: now?.status ?? null,
      status_word: now?.status ? STATUS_WORD[now.status] || now.status : null,
      status_raw: now?.status_raw ?? null,
      status_at: now?.status_at ?? null,
      onboarding: now?.onboarding ?? null,
      plate: now?.plate ?? null,
      observed_at: now?.observed_at ?? null,
      observed_age_min: ageMin,
      stale,
      absent: known ? null
        : now
          ? 'Uber lists this driver but has reported no status for them — their record carries '
            + 'no status entry at all. That is not a driver who is offline; it is a driver Uber '
            + 'is telling us nothing about.'
          : 'Uber has not reported a status for this driver. Only Uber publishes one to this '
            + 'fleet, so a driver who works the hotel channel, Bolt or Yango has none by '
            + 'construction — it is not a driver who is offline.',
      stale_why: stale && known
        ? `The live feed last answered ${ageMin == null ? 'we do not know when'
            : `${ageMin} minute${ageMin === 1 ? '' : 's'} ago`}`
          + `, and it answers every two minutes when it is healthy. This is the last status it `
          + 'gave, not necessarily the status now.'
        : null,
      today: {
        /* The first WORKING span of the day, which is the answer to "what time
           did they start" — and null rather than a guess when the history does
           not reach back far enough to know. */
        online_since: first?.from_at ?? null,
        online_since_local: first?.from_local ?? null,
        online_minutes: onlineMin,
        on_trip_minutes: onTripMin,
        /* Waiting is online minus on-trip: the supply this fleet is paying for
           and not selling, which is the figure the Idle hours page is about. */
        waiting_minutes: Math.max(0, onlineMin - onTripMin),
        spans: spans.map((s) => ({ status: s.status, from: s.from_local, minutes: s.minutes })),
        absent: spans.length ? null
          : 'No status change is on record for this driver on this day. The history begins '
            + 'when this fleet started keeping it, so a day before that has none.',
      },
    });
  }));

  /* ── everybody ─────────────────────────────────────────────────────────── */
  app.get('/api/status/fleet', wrap(async (req, res) => {
    const rows = await q(
      `SELECT s.driver_ext_id, s.fleet_id, s.status, s.status_at, s.plate, s.observed_at,
              s.onboarding,
              coalesce(nullif(t.person_key, ''), s.driver_ext_id) AS person_key,
              c.full_name
         FROM driver_status_now s
         LEFT JOIN LATERAL (
           SELECT person_key FROM trip
            WHERE platform = 'uber' AND driver_ext_id = s.driver_ext_id
            ORDER BY requested_at DESC LIMIT 1) t ON true
         LEFT JOIN driver_compliance c
           ON c.platform = 'uber' AND c.driver_ext_id = s.driver_ext_id
        WHERE s.platform = 'uber'
          AND ($1::text IS NULL OR s.fleet_id = $1)
        /* NULLS LAST on both, deliberately. The expression s.status = 'ontrip'
           is NULL for a driver carrying no status, and Postgres sorts NULL
           FIRST under DESC — so the fleet list opened with the sixty-six rows
           that say nothing and buried the people actually working below them.
           (No backticks in this comment: it sits inside a template literal,
           and one would end the string here rather than quote anything.) */
        ORDER BY (s.status = 'ontrip') DESC NULLS LAST,
                 (s.status = 'online') DESC NULLS LAST,
                 c.full_name`,
      [req.query.fleet || null]);

    const freshest = rows.reduce((a, r) => (
      r.observed_at && (!a || r.observed_at > a) ? r.observed_at : a), null);
    const ageMin = freshest ? Math.round((Date.now() - new Date(freshest).getTime()) / 60000) : null;

    res.json({
      rows,
      feed_at: freshest,
      feed_age_min: ageMin,
      stale: ageMin == null || ageMin > STALE_AFTER_MIN,
      stale_after_min: STALE_AFTER_MIN,
      totals: {
        /* `drivers` is every row the feed returned, and `with_status` is how
           many of those Uber actually said something about. Reported apart
           because online + ontrip + offline does NOT add up to drivers and a
           reader who assumes it does will read the difference as offline —
           which is the same wrong answer, one level up. */
        drivers: rows.length,
        with_status: rows.filter((r) => r.status).length,
        unknown: rows.filter((r) => !r.status).length,
        online: rows.filter((r) => r.status === 'online').length,
        ontrip: rows.filter((r) => r.status === 'ontrip').length,
        offline: rows.filter((r) => r.status === 'offline').length,
        working: rows.filter((r) => WORKING.includes(r.status)).length,
      },
      /* Said in words as well as counted, for the same reason. */
      unknown_note: rows.some((r) => !r.status)
        ? `${rows.filter((r) => !r.status).length} of these ${rows.length} carry no status at `
          + 'all: Uber lists the driver and reports nothing about them. They are not offline — '
          + 'nothing is known about them either way.'
        : null,
      /* Only Uber publishes this. Said here so a page reporting "31 online"
         cannot be read as a statement about the whole fleet. */
      basis: 'Uber is the only channel that reports a live driver status to this fleet. A '
        + 'driver on the hotel channel, Bolt or Yango does not appear here, and their absence '
        + 'is not a claim that they are offline.',
    });
  }));
}
