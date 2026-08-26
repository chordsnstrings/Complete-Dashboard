/* Where a dated source stopped answering, and for how long.
   ─────────────────────────────────────────────────────────────────────────
   Extracted from /api/coverage/calendar, which had the only copy. The Data
   coverage table on #sources needs the identical computation for datasets
   that are not trips — telemetry, safety alerts, the operator's ledger — and
   on production nine of its eleven rows read "not a dated source" against
   feeds that are plainly dated. Telemetry is the longest record the product
   holds and the table could say nothing about its continuity at all.

   Two copies of a gap-finder would be two definitions of a gap, and this one
   carries a rule worth keeping exactly: gaps are counted only INSIDE a
   source's own observed span. A feed that started in March has no hole in
   January — it has no history, which is a different statement and belongs in
   a different sentence. */

/**
 * @param days [{ day: 'YYYY-MM-DD', rows: number }] — ascending, one per day
 *             the source actually produced something on.
 */
export function spanGaps(days) {
  const seen = new Set(days.map((d) => d.day));
  const first = days[0]?.day;
  const last = days[days.length - 1]?.day;
  const gaps = [];
  if (first && last) {
    let run = null;
    for (let t = Date.parse(first); t <= Date.parse(last); t += 864e5) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (seen.has(d)) { if (run) { gaps.push(run); run = null; } }
      else if (run) { run.to = d; run.days++; }
      else run = { from: d, to: d, days: 1 };
    }
    if (run) gaps.push(run);
  }
  const daily = days.map((d) => d.rows).sort((a, b) => a - b);
  return {
    days_with_data: days.length,
    first_day: first ?? null,
    last_day: last ?? null,
    median_rows_per_day: daily.length ? daily[Math.floor(daily.length / 2)] : 0,
    gaps: gaps.sort((a, b) => b.days - a.days).slice(0, 20),
    missing_days: gaps.reduce((a, g) => a + g.days, 0),
  };
}
