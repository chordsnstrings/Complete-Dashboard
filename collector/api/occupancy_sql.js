/* THE SEAT-SENSOR PROVIDERS, AND HOW ONE RIDE IS COUNTED ONCE ACROSS THEM.
   ═══════════════════════════════════════════════════════════════════════════
   The operator's rulings of 2026-09-23 made FMS a second seat-sensor provider
   for unauthorized-trip detection, beside CABMAN, and made it two sources at
   once: FMS's live seat count and FMS's per-journey Seat Count. So an
   occupancy segment now carries `source` (sql/schema_v85.sql):

     cabman    CABMAN DT's seat pad, a 5-minute poll, Ecosine only
     fms_live  FMS's live Seatcount, occupied when it is 1 or more
     fms_trip  one FMS journey whose Seat Count is 1 or more

   Ruling 4 is that nothing is merged across sources and nothing is dropped:
   every segment keeps its own source and its own timestamps, and every list
   shows every one of them. What that leaves is the TOTALS. From 2026-09-23 on,
   one real ride on an FMS car is normally two segments — the live seat count
   saw it, and FMS filed it as a journey — and on the two cars that carry both
   trackers it can be three. A combined count that added them up would count
   one ride two or three times, which is the one thing a total must not do.

   THE RULE, which every combined figure in the product uses through
   occCountsOnce() and states through OCC_DEDUPE_RULE:

     Where segments from different providers on the same car overlap in time
     and reached the same verdict, they are one ride. It is counted once, by
     the first of them in the order FMS trip seat count → CABMAN DT → FMS live
     seat count, and its distance is that segment's distance. Each provider's
     own figures count every segment it produced.

   WHY SAME-VERDICT. Two providers can disagree about a ride — CABMAN's
   segment unauthorized, FMS's journey matched to a booking a few minutes off.
   Deduplicating ACROSS verdicts would have to pick a winner, and whichever it
   picked would silently remove a flagged ride from the unauthorized count.
   Within one verdict there is nothing to decide: the ride is in that bucket
   either way, and it is counted there once.

   WHY THAT ORDER. An FMS journey is the tracker's own record of one whole
   trip, with the provider's start, end and distance. CABMAN and FMS live
   segments are built here from samples five and about six minutes apart, so
   their ends are known to within a poll. The journey is the best-bounded
   reading of the three, and its distance is the provider's rather than a sum
   of straight lines between samples.

   WHY THE REPRESENTATIVE IS NOT BOUNDED BY THE WINDOW. A ride is counted on
   the day, and under the fleet, of the segment that represents it — even when
   a shorter segment of the same ride from another provider starts after the
   window's edge. Restricting the representative to the window would count a
   ride that straddles Dubai midnight once in each of two adjacent days, so
   daily bars would sum to more than the window's own total.

   THE INDEX BOUND, and the invariant it rests on. The overlap lookup is a
   range scan on (plate, started_at). Unbounded below, every segment would
   scan every earlier segment on its plate — quadratic, and FMS journeys put
   thousands a year on each car. The bound is safe because of the classifier:
   src/reconcile.js classifySegment() returns sensor_suspect for anything
   longer than RULES.maxDurationHr (8 h) BEFORE any other verdict, and the
   FMS-journey classifier applies the same 8-hour rule. So a representative
   that shares a verdict other than sensor_suspect is at most eight hours long
   (duration_min is rounded, hence nine hours of margin) and must have started
   within nine hours before the segment it overlaps. sensor_suspect segments
   can be any length, so for them the lookup is unbounded — there are few. */

export const OCC_SOURCES = ['cabman', 'fms_live', 'fms_trip'];

/* The words a page prints for each provider. The operator's own names for the
   three — "CABMAN DT", "FMS live seat count", "FMS trip seat count". */
export const OCC_SOURCE_LABEL = {
  cabman: 'CABMAN DT',
  fms_live: 'FMS live seat count',
  fms_trip: 'FMS trip seat count',
};

/* Which segment represents a ride in a combined figure. See the header. */
export const OCC_SOURCE_ORDER = ['fms_trip', 'cabman', 'fms_live'];

const rank = (col) => `CASE ${col} ${OCC_SOURCE_ORDER.map((s, i) => `WHEN '${s}' THEN ${i + 1}`).join(' ')} ELSE ${OCC_SOURCE_ORDER.length + 1} END`;

/* The provider label as a SQL expression, so every read that returns a
   segment returns the words beside the code and no page has to carry its own
   copy of the map. */
export const occSourceLabel = (col) => `CASE ${col} ${OCC_SOURCES.map((s) => `WHEN '${s}' THEN '${OCC_SOURCE_LABEL[s]}'`).join(' ')} ELSE ${col} END`;

/* TRUE when this segment is the one that represents its ride in a combined
   figure; FALSE when another provider's overlapping segment with the same
   verdict outranks it. `o` is the outer table's alias, or the bare table name
   when the query does not alias it — inside this subquery the table is aliased
   `r_once`, so the bare name can only mean the outer row. */
export const occCountsOnce = (o) => `NOT EXISTS (
    SELECT 1 FROM occupancy_segment r_once
     WHERE r_once.plate = ${o}.plate
       AND r_once.source <> ${o}.source
       AND r_once.verdict IS NOT DISTINCT FROM ${o}.verdict
       AND ${rank('r_once.source')} < ${rank(`${o}.source`)}
       AND r_once.started_at <= coalesce(${o}.ended_at, ${o}.started_at)
       AND r_once.started_at >= CASE WHEN ${o}.verdict = 'sensor_suspect'
                                     THEN '-infinity'::timestamptz
                                     ELSE ${o}.started_at - interval '9 hours' END
       AND coalesce(r_once.ended_at, r_once.started_at) >= ${o}.started_at)`;

export const OCC_DEDUPE_RULE = 'Combined figures count a ride once. Where segments from '
  + 'different providers on the same car overlap in time and reached the same verdict, they '
  + 'are one ride: it is counted once, by the first of them in the order FMS trip seat count, '
  + 'CABMAN DT, FMS live seat count, and its distance is that segment’s distance. Each '
  + 'provider’s own figures count every segment it produced, so the providers’ figures can '
  + 'add up to more than the combined one.';

/* The day each provider's seat evidence begins, as the collector records it.
   CABMAN DT and FMS live are polls with no history behind them; FMS journeys
   reach back two years through GetTripPassenger. */
export const OCC_CABMAN_SINCE = '2026-08-21';
export const OCC_FMS_LIVE_SINCE = '2026-09-23';

/* Why a provider has NOTHING in a window — the true reason, which depends on
   the window and the fleet asked about. A count of zero from a provider that
   produced no segment at all would be a measurement nobody made. */
export function occSourceAbsent(source, { from = null, to = null, fleet = null } = {}) {
  const before = (d) => to && String(to).slice(0, 10) < d;
  if (source === 'cabman') {
    if (fleet === 'egari') return 'CABMAN DT holds no account for Egari, so it has no seat reading for this fleet.';
    if (before(OCC_CABMAN_SINCE)) {
      return 'CABMAN DT’s seat pad is a live poll with no history, and collection began on '
        + `${OCC_CABMAN_SINCE}, after this window. It holds an account for Ecosine only.`;
    }
    return 'No CABMAN DT fix in this window formed a segment — a segment needs consecutive fixes '
      + 'reporting an occupied seat. CABMAN DT holds an account for Ecosine only.';
  }
  if (source === 'fms_live') {
    if (before(OCC_FMS_LIVE_SINCE)) {
      return `FMS’s live seat count has been collected only since ${OCC_FMS_LIVE_SINCE}, after this window.`;
    }
    return 'No FMS live fix in this window formed a segment — a segment needs consecutive fixes '
      + 'reporting a seat count of 1 or more.';
  }
  if (source === 'fms_trip') {
    return 'No FMS journey with a seat count was judged in this window. FMS journeys reach back '
      + 'about two years, but a window is judged only once the reconciler has run over it — the '
      + 'half-hourly pass covers three days, the nightly one thirty, the weekly backfill its months.';
  }
  return 'no segment from this provider in this window';
}

/* Per-provider figures, one entry for every provider whether or not it
   produced anything, from rows grouped by source. A provider with no segment
   at all carries NULL figures and the reason, never a zero. */
export function occBySource(rows, ctx = {}, fields = ['unauthorized', 'unauth_km']) {
  const got = new Map((rows || []).map((r) => [r.source, r]));
  return Object.fromEntries(OCC_SOURCES.map((s) => {
    const r = got.get(s);
    if (!r || !(Number(r.segments) > 0)) {
      return [s, { label: OCC_SOURCE_LABEL[s], segments: 0,
        ...Object.fromEntries(fields.map((f) => [f, null])),
        absent: occSourceAbsent(s, ctx) }];
    }
    return [s, { label: OCC_SOURCE_LABEL[s], ...r, source: undefined }];
  }));
}

/* Which days each provider covers in a window, per provider — the coverage a
   note has to state before any count is read. `rows` is grouped by source:
   {source, days_with_data, first_day, last_day, plates}. */
export function occCoverageBySource(rows, ctx = {}) {
  const got = new Map((rows || []).map((r) => [r.source, r]));
  return Object.fromEntries(OCC_SOURCES.map((s) => {
    const r = got.get(s);
    return [s, r && r.days_with_data > 0
      ? { label: OCC_SOURCE_LABEL[s], days_with_data: r.days_with_data,
        first_day: r.first_day || null, last_day: r.last_day || null, plates: r.plates ?? null }
      : { label: OCC_SOURCE_LABEL[s], days_with_data: 0, first_day: null, last_day: null,
        plates: 0, absent: occSourceAbsent(s, ctx) }];
  }));
}

/* One clause naming each provider's days, for the coverage sentences:
   "CABMAN DT 12 days, FMS live seat count 1 day, FMS trip seat count 30 days". */
export const occCoverageClause = (bySource) => OCC_SOURCES
  .map((s) => `${OCC_SOURCE_LABEL[s]} ${bySource?.[s]?.days_with_data || 0} `
    + `day${(bySource?.[s]?.days_with_data || 0) === 1 ? '' : 's'}`).join(', ');

/* Why a window carries no seat evidence from any provider. All three halves
   are true at once, and which one applies depends on the window and fleet, so
   the sentence names all three rather than guessing. */
export const OCC_NO_EVIDENCE_WHY = 'Three sources feed this and none produced a segment here: '
  + 'CABMAN DT’s seat pad is a live poll with no history and holds an account for Ecosine only; '
  + `FMS’s live seat count has been collected only since ${OCC_FMS_LIVE_SINCE}; and FMS journeys, `
  + 'which reach back about two years, are judged only over the windows the reconciler has run.';
