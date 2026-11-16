/* Reading the resolved place of a booking's endpoint (FIX-STATUS PLC).
   ──────────────────────────────────────────────────────────────────────────
   trip_place (sql/schema_v126.sql) holds, per booking, the area each endpoint
   was placed in and the BASIS it came from — the address, a name in the
   address text, a plus code, the booking's coordinates, or the car's tracker —
   or the reason no rung could place it. src/trip_places.js fills it once per
   collector pass. These helpers are how a grouping query reads it, so every
   surface that switches from place_area() to the resolved layer reads it the
   same way and names the same booking the same way.

   A booking the pass has not reached yet (a trip that landed this minute, or
   the first passes over the history) has no trip_place row. It falls back to
   place_area() — the rule every page used before, so nothing that read
   before reads worse — and, where that names nothing, to the reason
   'pending', which the page prints as "not placed yet" rather than inventing
   one. The CASE on tp.platform keeps place_area() off the rows that have an
   answer.

   The column names are qualified by the caller's aliases. The trip side is
   best read through a subquery that selects only what it needs (trip and
   trip_place share fleet_id, platform and external_id), so a caller's own
   unqualified WHERE cannot become ambiguous by gaining this join. */
import { BASIS_TEXT, BASIS_TEXT_DROPOFF, reasonText, TRACKER_WINDOW_MIN } from '../src/place_resolve.js';
import { canonAreaSql } from '../src/area_alias.js';

export const placeJoin = (t = 't', tp = 'tp') =>
  `LEFT JOIN trip_place ${tp} ON ${tp}.platform = ${t}.platform AND ${tp}.external_id = ${t}.external_id`;

/* Folded to one name per area at read time (src/area_alias.js, PLC12): the
   stored area stays what the evidence said; what a page groups by is the
   community, so "Marsa Dubai", "Dubai Marina" and "دبي مارينا" are one row. */
export const placedArea = (end, t = 't', tp = 'tp') =>
  canonAreaSql(`coalesce(${tp}.${end}_area, CASE WHEN ${tp}.platform IS NULL THEN place_area(${t}.${end}_addr) END)`);

export const placedBasis = (end, t = 't', tp = 'tp') =>
  `CASE WHEN ${tp}.platform IS NOT NULL THEN ${tp}.${end}_basis
        WHEN place_area(${t}.${end}_addr) IS NOT NULL THEN 'address' END`;

export const placedReason = (end, t = 't', tp = 'tp') =>
  `CASE WHEN ${tp}.platform IS NOT NULL THEN ${tp}.${end}_reason
        WHEN place_area(${t}.${end}_addr) IS NULL THEN 'pending' END`;

/* The rungs in ladder order, so a caption lists them most direct first. */
export const BASES = ['address', 'address_name', 'plus_code', 'coordinates', 'tracker'];

/* Counts by basis and by reason → the words a caption is made of. The words
   live in src/place_resolve.js, once, and travel with the counts so the page
   never has to know what "tracker" means. */
export function placementSummary(rows, end = 'pickup') {
  const words = end === 'dropoff' ? BASIS_TEXT_DROPOFF : BASIS_TEXT;
  const by = new Map();
  const why = new Map();
  let total = 0;
  for (const r of rows || []) {
    const n = Number(r.n) || 0;
    total += n;
    if (r.basis) by.set(r.basis, (by.get(r.basis) || 0) + n);
    else why.set(r.reason || 'pending', (why.get(r.reason || 'pending') || 0) + n);
  }
  const byBasis = BASES.filter((b) => by.get(b)).map((b) => ({ basis: b, label: words[b], n: by.get(b) }));
  const unplaced = [...why].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([reason, n]) => ({ reason, label: reasonText(reason), n }));
  return {
    total,
    placed: byBasis.reduce((s, x) => s + x.n, 0),
    by_basis: byBasis,
    unplaced,
    tracker_window_min: TRACKER_WINDOW_MIN,
  };
}

/* The residual row's name: what is true about it, never "(unparsed)". */
export const unplacedLabel = (reason) => (!reason || reason === 'pending'
  ? 'Not placed yet — the resolver has not reached these bookings'
  : `Not placed — ${reasonText(reason)}`);
