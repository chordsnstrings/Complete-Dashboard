/* Journeys no channel booked, as RIDES on a person's own timeline.
   ───────────────────────────────────────────────────────────────────────
   The operator, 2026-10-14: "unauthorized trips should show on activity tab
   and daily pages". /api/driver/unauthorized already answers which unbooked
   journeys a person is named beside and which they are one of several
   candidates for (api/unauthorized_routes.js); the Unexplained trips tab lists
   them. This turns that answer into marks the Activity tab and the day page
   can lay on the same clock as the person's jobs.

   THREE RULES, each inherited from the tab that already shows these.

   A RIDE ONCE. Since 2026-09-23 one ride an FMS car made is usually two
   segments — FMS's live seat count and FMS's journey — and they can land on
   DIFFERENT sides of the split: measured on production 2026-10-14, a ride at
   17:06 on 13 October was named by one reading (last trip on the car) and one
   of several by the other. Drawing by `counts_once` alone would quietly
   downgrade it; drawing every segment would draw one ride twice. So segments
   on one car that overlap in time are one ride, the ride is NAMED if any
   reading names this person, and a ride its readings disagree about says so.
   That person's fortnight: the server's totals were 6 named + 12 candidate,
   the rides here 7 + 11 — the same 18, the one ride moved and said.

   THE RUNG IN WORDS. Named-by-time, the operator's last-trip rule and
   day-custody are different strengths of claim, and the tab says which in
   words beside the row (api/public/driver.js TIER_LABEL); a mark says it in
   its title and every list entry in its text. None of them is a record of the
   journey, and nothing here calls it the person's trip.

   A FAILED ANSWER IS NOT A CLEAN RECORD. A request that threw, or came back
   without the shape, is said as a failure; a day the seat sensor did not
   watch is not a day with no unbooked journey. */
import { dubaiDay } from './tz.js';

export const RUNG = {
  bracketed: 'named by time — their own Uber trips on the car either side of it',
  last_trip: 'the last Uber trip on the car before it was theirs (the operator’s rule)',
  sole_custodian: 'the only person on record holding the car that day',
  ambiguous: 'one of several people who held the car',
};
const NAMED = new Set(['bracketed', 'last_trip', 'sole_custodian']);
const STRENGTH = { bracketed: 3, last_trip: 2, sole_custodian: 1, ambiguous: 0 };

/* Is this a body the route actually answered? The tab's own test: the
   attributed list and the coverage must both be there. */
export const readable = (res) => !!(res && res.attributed && Array.isArray(res.attributed.rows) && res.coverage);

/* Minutes since Dubai midnight of an instant, and its Dubai day. */
const DUBAI_MS = 4 * 3600e3;
const dayOf = (ms) => new Date(ms + DUBAI_MS).toISOString().slice(0, 10);
const minOf = (ms) => { const d = new Date(ms + DUBAI_MS); return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60; };

/* Every reading on both sides of the split, folded into rides BY THE
   SERVER'S OWN RULE (the response's dedupe_rule): a ride is the reading the
   server counts once — FMS trip seat count before CABMAN before FMS live — and
   its time and distance are that reading's. Every other reading is attached
   to the counted one on the same car it overlaps most, and only lends the
   ride its strength: a ride is NAMED if any reading of it names this person.
   Built this way the rides here are the rides the Unexplained trips tab
   counts, and a ride its readings disagree about is said, not resolved. */
export function ridesOf(res) {
  if (!readable(res)) return null;
  const segs = [
    ...(res.attributed.rows || []).map((r) => ({ ...r, _side: 'named' })),
    ...((res.also_a_candidate && res.also_a_candidate.rows) || []).map((r) => ({ ...r, _side: 'candidate' })),
  ].filter((r) => r.started_at && r.plate)
    .map((r) => ({ ...r, _s: Date.parse(r.started_at), _e: Date.parse(r.ended_at || r.started_at) }));
  const anchors = segs.filter((g) => g.counts_once !== false);
  const rides = anchors.map((a) => ({ plate: a.plate, start: a._s, end: Math.max(a._s, a._e), anchor: a, segs: [a] }));
  const overlap = (a, b) => Math.max(0, Math.min(a._e, b.end) - Math.max(a._s, b.start));
  for (const g of segs.filter((x) => x.counts_once === false)) {
    let best = null; let most = 0;
    for (const r of rides) {
      if (r.plate !== g.plate) continue;
      const o = overlap(g, r);
      if (o > most || (o === most && o > 0 && best && Math.abs(r.start - g._s) < Math.abs(best.start - g._s))) { best = r; most = o; }
    }
    /* A reading the server counted under no ride is its own — it should not
       happen, and dropping it would hide a journey. */
    if (best) best.segs.push(g);
    else rides.push({ plate: g.plate, start: g._s, end: Math.max(g._s, g._e), anchor: g, segs: [g] });
  }
  for (const r of rides) {
    const a = r.anchor;
    r.named = r.segs.some((g) => g._side === 'named');
    r.mixed = r.named && r.segs.some((g) => g._side === 'candidate');
    /* The strongest rung any reading names this person on, and its working. */
    const best = [...r.segs].sort((x, y) => (STRENGTH[y.attribution_tier] ?? -1) - (STRENGTH[x.attribution_tier] ?? -1))[0];
    r.tier = best.attribution_tier;
    r.evidence = best.attribution_evidence || null;
    r.km = a.distance_km != null ? Number(a.distance_km) : null;
    r.from = a.start_place?.area || r.segs.find((g) => g.start_place?.area)?.start_place?.area || null;
    r.to = a.end_place?.area || r.segs.find((g) => g.end_place?.area)?.end_place?.area || null;
    r.sources = [...new Set(r.segs.map((g) => g.source_label || g.source))];
    r.source = a.source;
    r.day = dayOf(r.start);
    /* The pieces on each Dubai day, for a 24-hour axis: a ride across
       midnight is drawn on both days, each piece to its own edge. */
    r.pieces = [];
    let s = r.start;
    for (;;) {
      const d = dayOf(s);
      const dayEnd = Date.parse(`${d}T00:00:00+04:00`) + 864e5;
      const e = Math.min(r.end, dayEnd);
      r.pieces.push({ day: d, s: minOf(s), e: e >= dayEnd ? 1440 : minOf(e) });
      if (e >= r.end) break;
      s = e;
    }
  }
  return rides.sort((x, y) => x.start - y.start);
}

/* One line saying what a ride is, for a title or a list. */
export function rideWords(r, { clock }) {
  const when = `${clock(r.start)}–${clock(r.end)}`;
  const where = r.from || r.to ? ` · ${r.from || 'unnamed ground'} → ${r.to || 'unnamed ground'}` : '';
  const km = r.km != null ? ` · ${r.km.toFixed(1)} km` : '';
  const rung = r.mixed
    ? 'named by one sensor reading, one of several by the other'
    : r.named ? RUNG[r.tier] || r.tier : RUNG.ambiguous;
  return { when, line: `unbooked journey ${when} · ${r.plate}${km}${where} — ${rung}`, rung };
}

/* What the seat sensor watched, in a sentence, so a day with no mark is
   never read as a day with nothing on it. */
export function coverageWords(cov) {
  if (!cov) return 'What the seat sensor watched could not be read.';
  if (!cov.days_in_window) return '';
  if (!cov.days_with_data) {
    return `No seat-sensor reading exists for ${cov.scope || 'the cars this person held'} in this window, `
      + 'so an unbooked journey could not have been seen — no mark here means nothing was watched, not nothing happened.';
  }
  return `The seat sensor watched ${cov.days_with_data} of ${cov.days_in_window} days `
    + `of ${cov.scope || 'the cars this person held'}`
    + (cov.days_with_data < cov.days_in_window ? '; a day it did not watch can carry no mark' : '') + '.';
}

/* The server returns at most 400 readings, newest first, and says
   `truncated` when it hit the cap (api/unauthorized_routes.js). Days older
   than the oldest reading returned can then carry rides nothing here marks,
   so the pages say where the answer stops instead of letting a bare early
   day read as a clean one. '' when the answer is whole. */
export function truncationWords(res) {
  if (!res || !res.truncated) return '';
  const all = [...((res.attributed && res.attributed.rows) || []), ...((res.also_a_candidate && res.also_a_candidate.rows) || [])];
  const oldest = all.map((r) => Date.parse(r.started_at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  const from = oldest != null ? dayOf(oldest) : null;
  return `The server returned only its newest ${all.length} sensor readings${from ? `, reaching back to ${from}` : ''}; `
    + `${from ? 'a day before that' : 'an earlier day'} can carry a journey that is not marked here.`;
}

export const todayDubai = () => dubaiDay();
