/* The hero sparklines: what /api/history answered, as a glance tile's `spark`.
   ─────────────────────────────────────────────────────────────────────────
   api/history_routes.js answers a page's hero series in one request, each
   point `{ d, v, why }` — `v` null where the point was not measured, with the
   reason. A glance tile (ui.js kpiTile, `glance` flag) takes `spark` as either
   an array of numbers, a null in it drawn as a GAP by charts.js spark(), or a
   STRING: the reason there is no line, printed where the line would be. These
   two functions are the whole translation, kept in one module so the four
   pages that draw one cannot each grow their own idea of when a line is worth
   drawing and what to say when it is not.

   Three rules, the house principle applied to a line on a tile:

   · A series the endpoint calls absent is the endpoint's sentence, never an
     empty box and never a flat line.
   · A line needs two measured points. With one, or none, the tile says why —
     from the points' own reasons, the most common first — instead of drawing
     an end-dot that reads as a figure with no history.
   · A request that failed says so, and says the figure above it is not
     affected: the hero figure came from the page's own endpoint, and a reader
     must not take a missing line for a missing number.

   No imports: the pages pass in what they fetched, so this is testable in
   Node without a DOM and costs nothing to load. */

const NOUN = { day: 'day', week: 'week' };
const LEAD = { day: 'No daily line.', week: 'No weekly line.' };
const sentence = (s) => {
  const t = String(s ?? '').trim();
  if (!t) return '';
  const c = t[0].toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(c) ? c : `${c}.`;
};
const day = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB',
  { day: 'numeric', month: 'short', timeZone: 'UTC' });

/* The reasons behind a series' gaps, most common first, with their counts. */
export function gapReasons(series) {
  const n = new Map();
  for (const p of series?.points || []) if (p.v == null && p.why) n.set(p.why, (n.get(p.why) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([why, count]) => ({ why, count }));
}

/** The tile's `spark`: an array to draw, or the sentence that stands in for it.
    `failed` — the request itself did not answer. */
export function sparkOf(series, { failed = false } = {}) {
  if (!series) {
    return failed ? 'No line. The history did not load for this tile just now — the figure above is unaffected.' : null;
  }
  const lead = LEAD[series.grain] || 'No line.';
  if (series.absent) return `${lead} ${sentence(series.absent)}`;
  const v = (series.points || []).map((p) => (p.v == null || !Number.isFinite(Number(p.v)) ? null : Number(p.v)));
  const measured = v.filter((x) => x != null).length;
  if (measured >= 2) return v;
  const why = gapReasons(series)[0]?.why;
  const noun = NOUN[series.grain] || 'point';
  if (measured === 1) {
    return `${lead} Only one ${noun} in this span is measured, and a line needs two${why ? ` — the rest: ${why}` : ''}.`;
  }
  return `${lead} ${sentence(why || `no ${noun} in this span is measured`)}`;
}

/** The line's own caption, for the tile's tooltip and its screen-reader label:
    what it counts, over which span, how much of it is drawn and why the rest
    is not. Null when there is no line to describe. */
export function sparkNote(series) {
  if (!series || series.absent || !Array.isArray(series.points) || !series.points.length) return null;
  const pts = series.points;
  const noun = NOUN[series.grain] || 'point';
  const measured = pts.filter((p) => p.v != null).length;
  const gaps = gapReasons(series)
    .map((g) => `${g.count} ${g.count === 1 ? noun : `${noun}s`}: ${g.why}`).join('; ');
  const span = `${day(pts[0].d)} to ${day(pts[pts.length - 1].d)}`;
  return `${series.label}, each ${noun}, ${span} — ${measured} of ${pts.length} drawn.`
    + (gaps ? ` Not drawn — ${gaps}.` : '')
    + (series.basis ? ` ${series.basis}` : '');
}

/** Both, for a tile: `{ spark, sparkTitle }` to spread into its item. */
export const sparkFields = (series, opts) => {
  const spark = sparkOf(series, opts);
  return spark == null ? {} : { spark, ...(Array.isArray(spark) ? { sparkTitle: sparkNote(series) } : {}) };
};

/** The line for one tile from a page's /api/history answer. Whatever the
    answer lacks — the request failed (the pages remember that as
    `{ failed: true }`), or it arrived without this series — the tile says the
    line did not load, rather than drawing nothing and saying nothing. */
export const lineFor = (hist, metric) => {
  const series = hist?.series?.[metric];
  return sparkFields(series, { failed: !series });
};

/* Calendar arithmetic on a YYYY-MM-DD, for the spans the pages ask for.
   Anchored at noon UTC, the codebase's documented way (test/timezone.test.mjs):
   no offset any calendar uses can carry noon across either midnight. */
/** The day `n` days from `d`. */
export const shiftDay = (d, n) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
/** The Monday of the week holding `d`. */
export const mondayOf = (d) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
};
