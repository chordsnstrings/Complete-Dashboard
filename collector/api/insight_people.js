/* Who a finding is ABOUT, resolved into people an operations lead can ring.
   ═══════════════════════════════════════════════════════════════════════════
   The most severe row on the action list reads "10 drivers were online but
   completed no trips", carries an action that says "check whether they were
   genuinely available", and names nobody. Measured on production 2026-09-07:
   the finding's `refs` column already held all ten Uber driver ids and the
   hours each was logged in, /api/insights already served that column, and
   `grep '\.refs' api/public/*.js` returned nothing at all. The one field that
   makes the finding actionable travelled the whole way from the rule engine to
   the browser and was dropped on the last hop.

   An id is not a person, though. `84d498cf-a74a-4750-9ac2-5eabdeec3b8d` is
   exactly as unactionable as a bare count — worse, because it looks like an
   answer. What an operations lead needs before picking up a phone is:

     WHO      a name, and the photograph, so the right person is called
     HOW      a phone number and an email address
     WHAT     the vehicle they are holding, because an idle driver holding a
              car is a car nobody else can drive
     WHEN     the moment they went online — un-clipped, see below
     WHERE    where they were when they did, if we can prove it
     CONTEXT  when they last completed a trip, and how much they normally
              work, because "idle today" means one thing about somebody who
              did forty trips yesterday and something else entirely about
              somebody who has not worked in three weeks
     STANDING what the platform itself says about them — suspended, banned,
              or in good standing with a 4.9 rating

   Every one of those already exists in this database. None of them was being
   joined.

   ── the un-clipped start ─────────────────────────────────────────────────
   `driver_day` and every span query on the driver page clip ONLINE spans to
   the Dubai day, so a shift that opened at 23:43 the previous night reads as
   00:00. Printing that as a start time is a lie with a plausible face, and it
   is the single most misleading thing this table could say — "went online at
   midnight" invites exactly the wrong conversation. So the span here is read
   from driver_timeline_event with NO clipping: the latest ONLINE at or before
   the end of the finding's window whose span reaches into it, wherever it
   started, plus a flag saying whether it began before the window opened.

   ── where from, honestly ─────────────────────────────────────────────────
   driver_timeline_event carries lat/lon columns. Uber populates them on zero
   of 194,107 rows (docs/COVERAGE.md), so for the fleet this finding is about
   they are always NULL. The column is read anyway — Yango and the telematics
   feed may fill it, and a row that has it should show it — and when it is
   empty the response says so in words rather than returning a blank the page
   would have to guess at. A coordinate we do not hold is never inferred from
   the driver's trips: they completed none, which is the entire finding.

   ── the redaction posture ────────────────────────────────────────────────
   Phone, email and photograph leave this route, exactly as they leave
   /api/compliance/drivers and /api/driver/profile. They are a feature the
   operator asked for in as many words and the page exists to act on them.
   Identity DOCUMENTS — Emirates ID, licence number — are not selected here at
   all: nothing about ringing an idle driver needs their papers. */

/* The finding shapes whose refs name people. A rule that starts writing refs
   in a different shape gets no enrichment rather than a wrong one, and the
   list is here so adding a shape is one line in one place. */
export const PERSON_REF_KEY = 'driver_ext_id';

export function refIds(rows) {
  const out = new Set();
  for (const r of rows || []) {
    for (const ref of Array.isArray(r?.refs) ? r.refs : []) {
      const id = ref && ref[PERSON_REF_KEY];
      if (typeof id === 'string' && id.trim()) out.add(id.trim());
    }
  }
  return [...out];
}

/* One query, one finding. Deliberately not one query over every finding's ids
   at once: the online span is read against THIS finding's window, and two
   findings about two different days would silently blend into one span if the
   windows were unioned. There is at most a handful of findings carrying refs,
   so the cost of honesty here is a handful of queries. */
export async function peopleFor(q, ids, { from, to } = {}) {
  if (!ids || !ids.length) return [];
  /* The window the online span is read against. A finding with no window at
     all is a statement about the current state, so the span is read against
     the last 48 hours ending now — long enough to catch a shift that opened
     yesterday evening, short enough not to report a span from last week as if
     it were this one. */
  const lo = from || null, hi = to || null;
  return q(
    `WITH ids AS (SELECT DISTINCT unnest($1::text[]) AS driver_ext_id),
     /* The window, resolved once so every branch below agrees on it. A
        finding's window_end is the START of its closing day for a day-grain
        rule, so the span search runs to the end of that day. */
     win AS (
       SELECT coalesce($2::timestamptz, now() - interval '48 hours') AS lo,
              coalesce($3::timestamptz + interval '1 day', now()) AS hi)
     SELECT i.driver_ext_id,
            c.full_name, c.phone, c.email, c.rating AS compliance_rating,
            ph.platform AS photo_platform,
            pm.reason   AS photo_absent_reason,
            st.state, st.state_raw, st.state_reason, st.can_earn, st.plate AS state_plate,
            st.rating AS platform_rating, st.lifetime_trips, st.is_banned,
            st.platform AS state_platform, st.observed_at AS state_at,
            sp.online_at, sp.online_ended_at, sp.online_lat, sp.online_lon,
            sp.online_platform, sp.began_before_window,
            lt.last_trip_at, lt.last_trip_addr, lt.last_trip_platform, lt.last_trip_plate,
            recent.trips_28d, recent.days_28d, recent.last_28d_day
       FROM ids i
       CROSS JOIN win w
       /* The person. Ordered exactly as /api/driver/profile orders it, because
          two routes disagreeing about which of a driver's platform records is
          "the" one is how a page shows a name with no phone number while the
          phone number sits in the row behind it. */
       LEFT JOIN LATERAL (
         SELECT dc.full_name, dc.phone, dc.email, dc.rating
           FROM driver_compliance dc
          WHERE dc.driver_ext_id = i.driver_ext_id
          ORDER BY (nullif(btrim(dc.full_name), '') IS NOT NULL) DESC,
                   (coalesce(dc.phone, dc.email) IS NOT NULL) DESC,
                   (dc.platform = 'uber') DESC, dc.updated_at DESC NULLS LAST
          LIMIT 1) c ON true
       /* Our own copy of the photograph, by key only — never Uber's signed URL,
          which expires twelve hours after it is issued. */
       LEFT JOIN LATERAL (
         SELECT p.platform FROM driver_photo p
          WHERE p.driver_ext_id = i.driver_ext_id LIMIT 1) ph ON true
       LEFT JOIN LATERAL (
         SELECT m.reason FROM driver_photo_miss m
          WHERE m.driver_ext_id = i.driver_ext_id
          ORDER BY m.tried_at DESC LIMIT 1) pm ON true
       /* What the platform says about them, newest observation first. */
       LEFT JOIN LATERAL (
         SELECT s.platform, s.state, s.state_raw, s.state_reason, s.can_earn, s.plate,
                s.rating, s.lifetime_trips, s.is_banned, s.observed_at
           FROM driver_platform_state s
          WHERE s.driver_ext_id = i.driver_ext_id
          ORDER BY (s.plate IS NOT NULL) DESC, s.observed_at DESC NULLS LAST
          LIMIT 1) st ON true
       /* The shift, UN-CLIPPED. The span is an ONLINE row and the very next
          event on that driver's timeline, whatever that next event is — the
          same shape src/rollup.js uses, so the two agree. lead() runs over the
          driver's whole timeline and the window is applied to the RESULT: a
          predicate applied before lead() deletes events out of the middle of a
          timeline and lets the survivors close each other, which turns a
          two-hour span into a twenty-five hour one. */
       LEFT JOIN LATERAL (
         /* Written as a derived table rather than a CTE: a WITH inside a
            LATERAL cannot see the lateral's outer columns on every server
            version, and this one needs both i.driver_ext_id and w.lo. */
         SELECT at AS online_at, next_at AS online_ended_at,
                lat AS online_lat, lon AS online_lon, platform AS online_platform,
                (at < w.lo) AS began_before_window
           FROM (SELECT e.at, e.status, e.platform, e.lat, e.lon,
                        lead(e.at) OVER (ORDER BY e.at) AS next_at
                   FROM driver_timeline_event e
                  WHERE e.driver_ext_id = i.driver_ext_id
                    AND e.kind = 'status' AND e.status <> ''
                    AND e.at >= w.lo - interval '2 days'
                    AND e.at <= w.hi + interval '1 day') ev
          WHERE status = 'ONLINE'
            /* The span has to REACH the window, not merely start near it. An
               open span (next_at NULL) counts: the driver has not logged off. */
            AND (next_at IS NULL OR next_at > w.lo)
            AND at < w.hi
          ORDER BY at
          LIMIT 1) sp ON true
       /* When they last completed anything, ever. The finding says they did
          nothing today; whether that is a bad day or a dormant account is the
          difference between a phone call and a deactivation. */
       LEFT JOIN LATERAL (
         SELECT t.ended_at AS last_trip_at, t.dropoff_addr AS last_trip_addr,
                t.platform AS last_trip_platform, t.plate AS last_trip_plate
           FROM trip_norm t
          WHERE t.driver_ext_id = i.driver_ext_id AND t.outcome = 'completed'
          ORDER BY coalesce(t.ended_at, t.requested_at) DESC
          LIMIT 1) lt ON true
       /* Their normal. Four weeks up to the window, so "idle" has something to
          be idle against. */
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS trips_28d,
                count(DISTINCT t.local_day)::int AS days_28d,
                max(t.local_day) AS last_28d_day
           FROM trip_norm t
          WHERE t.driver_ext_id = i.driver_ext_id AND t.outcome = 'completed'
            AND t.requested_at >= w.hi - interval '28 days'
            AND t.requested_at < w.hi) recent ON true
      ORDER BY sp.online_at NULLS LAST, c.full_name NULLS LAST, i.driver_ext_id`,
    [ids, lo, hi]);
}

/* Fold the resolved people back onto each finding's refs, so the page reads one
   array rather than joining two client-side.

   `photoHref` is passed in rather than imported so this module has no opinion
   about the URL shape the API serves photographs under — one place owns that,
   and it is api/redact.js. */
export function attachPeople(rows, byId, photoHref) {
  for (const r of rows || []) {
    if (!Array.isArray(r?.refs) || !r.refs.length) continue;
    r.refs = r.refs.map((ref) => {
      const id = ref && ref[PERSON_REF_KEY];
      const p = id ? byId.get(String(id).trim()) : null;
      if (!p) return ref;
      const { photo_platform, photo_absent_reason, ...rest } = p;
      return {
        ...ref, ...rest,
        picture_url: photo_platform ? photoHref(photo_platform, id) : null,
        /* Named, never blank. A driver with no photograph and a driver whose
           photograph failed to download are two different states and the page
           says which. */
        ...(photo_platform ? {} : photo_absent_reason
          ? { photo_absent_reason }
          : { photo_absent_reason: 'no photograph has been offered for this account' }),
      };
    });
  }
  return rows;
}
