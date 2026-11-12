/* "THINNED BY RETENTION BEFORE <date>" — said by every page that reads past it.
   ═════════════════════════════════════════════════════════════════════════════
   THE RULE THIS HOLDS. A figure that cannot be measured renders absent with
   the true reason, never as a smaller number. Once the data-retention pass
   (src/data_retention.js) has thinned old positions or removed old alerts FOR
   REAL, every page whose window reaches back past that point is computing
   from fewer rows than were collected: fewer fixes per day on #coverage and
   #sensor-health, a coarser track on #where and #trip, shorter distances,
   fewer stops, alerts that read as "not covered". Shown without a word, each
   of those is a smaller number presented as complete.

   HOW. One header, x-fm-retention, set before the response cache so a cache
   hit carries it too, on exactly the routes listed in READERS — the inventory
   src/data_retention.js was written from, route by route, with the window
   each one reads. api/public/retention_note.js gathers the header from every
   answer a page receives (data.js api(), beside x-fm-withheld) and the page
   prints one line at its top naming the table, the date and what the pass did.

   Only a pass in "on" mode writes retention_state, so a dry run — the
   default — never makes a page claim a range was thinned that was not.

   IF YOU ADD A ROUTE that reads telemetry_snapshot's tracker fixes or alert
   over a window a reader chooses, add it here. test/data_retention_notes.test.mjs
   fails on any READERS path that no longer exists; it cannot find the route
   you forgot, which is why this paragraph exists (docs/COVERAGE.md, trap). */
import { winDays } from './window.js';

const TTL_MS = 5 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const DUBAI_MS = 4 * 3600e3;
const dubaiDayOf = (t) => new Date(new Date(t).getTime() + DUBAI_MS).toISOString().slice(0, 10);
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

let cached = null;
export const resetRetentionHorizon = () => { cached = null; };

/* The claim per table: the Dubai days rows were really removed from, as
   [from, before). removed_before is an instant: a Dubai midnight when a
   thinning pass finished (or cut short) a day, possibly mid-day when an alert
   removal was cut short. Rounded UP to the next whole day in the second case,
   so "before <date>" is never a date inside which rows are already gone; and
   removed_from is read as its own Dubai day, for the same reason. A row with
   no removed_from is a policy that has run and removed nothing: nothing to
   say. (done_before is the pass's resume cursor, NOT the claim. The first
   draft read it, and an "on" pass that removed no alert made every alert page
   say alerts were removed; see sql/schema_v115.sql.) `read` is any
   (sql, params) => rows: a route's q, or the pool wrapped. Cached five
   minutes: the claim moves once a night. A missing table (v115 not applied
   yet) means nothing has been thinned, which is the truth. */
export async function retentionHorizon(read, { now = Date.now() } = {}) {
  if (cached && now - cached.at < TTL_MS) return cached.value;
  let value = {};
  try {
    const rows = await read('SELECT tbl, action, removed_from, removed_before, bucket_min FROM retention_state');
    for (const r of rows || []) {
      if (!r?.removed_from || !r?.removed_before) continue;
      const at = new Date(r.removed_before);
      const day = dubaiDayOf(at);
      const whole = (at.getTime() + DUBAI_MS) % 864e5 === 0;
      value[r.tbl] = { action: r.action, from: dubaiDayOf(r.removed_from), before: whole ? day : nextDay(day),
        bucket_min: r.bucket_min == null ? null : Number(r.bucket_min), at: at.toISOString() };
    }
  } catch { value = {}; }
  cached = { at: now, value };
  return value;
}

/* How each reader's window is read off the request, as the Dubai days
   [first, last] its answer depends on. Both ends, because a window that ends
   before the claim begins lost nothing: a page about a month before the
   first fix was ever collected must not be told its fixes were thinned. */
const WIN = (req) => winDays(req);
const DAY = (req) => {
  const d = String(req.query.day || '').slice(0, 10);
  const day = ISO_DAY.test(d) ? d : dubaiDayOf(Date.now());     // these routes default to today
  return [day, day];
};
const AT = (req) => {
  const t = Date.parse(String(req.query.at || ''));
  return Number.isFinite(t) ? [dubaiDayOf(t), dubaiDayOf(t)] : null;
};
const ALL = () => ['0000-01-01', '9999-12-31'];
/* /api/trip names a journey, not a time: its track is read around the
   journey's own start, which only the database knows. Asked only when a
   claim exists at all, so it costs nothing until the pass has removed rows. */
const TRIP = async (req, read) => {
  const rows = await read(
    'SELECT requested_at FROM trip WHERE platform = $1 AND external_id = $2 LIMIT 1',
    [String(req.query.platform || '').trim().toLowerCase(), String(req.query.id || '').trim()]);
  const d = rows?.[0]?.requested_at ? dubaiDayOf(rows[0].requested_at) : null;
  return d ? [d, d] : null;
};

const T = 'telemetry_snapshot';
const A = 'alert';
/* The inventory. `tables` are the retention-managed tables the route reads;
   `span` gives the Dubai days its answer depends on (ALL for a route about
   the whole record). See src/data_retention.js for why each is here. */
export const READERS = Object.freeze({
  '/api/coverage': { tables: [T, A], span: ALL },
  '/api/schema/raw-fields': {
    tables: (req) => ({ telemetry_snapshot: [T], alert: [A] }[req.query.table] || []), span: WIN },
  // positions over a window the reader picks
  '/api/where': { tables: [T], span: DAY },
  '/api/where/fleet': { tables: [T], span: DAY },
  '/api/track': { tables: [T], span: WIN },
  '/api/map/days': { tables: [T], span: WIN },
  '/api/map/journey': { tables: [T], span: DAY },
  '/api/sensor-health': { tables: [T], span: WIN },
  '/api/vehicle/kpis': { tables: [T, A], span: WIN },
  '/api/vehicle/daily': { tables: [T, A], span: WIN },
  '/api/vehicle/movement': { tables: [T], span: WIN },
  '/api/vehicle/safety': { tables: [A], span: WIN },
  '/api/economics/assets': { tables: [T, A], span: WIN },
  '/api/economics/drivers': { tables: [A], span: WIN },
  '/api/driver/day': { tables: [T], span: DAY },
  '/api/driver/territory': { tables: [T], span: WIN },
  '/api/driver/quality': { tables: [A], span: WIN },
  '/api/online-time': { tables: [T], span: DAY },
  '/api/segment': { tables: [T], span: AT },
  '/api/trip': { tables: [T], span: TRIP },
  // alerts over a window the reader picks
  '/api/kpis': { tables: [A], span: WIN },
  '/api/alerts/summary': { tables: [A], span: WIN },
  '/api/alerts/by-vehicle': { tables: [A], span: WIN },
  '/api/alerts/by-driver': { tables: [A], span: WIN },
  '/api/vehicles/directory': { tables: [A], span: WIN },
  '/api/cohort/drivers': { tables: [A], span: WIN },
  '/api/cohort/vehicles': { tables: [A], span: WIN },
  '/api/day': { tables: [A], span: DAY },
});

/* The header value: table;action;first-whole-day;bucket-minutes, comma
   separated. Exported for the front end's parser test. */
export const noteValue = (h, tables) => tables
  .map((t) => [t, h[t].action, h[t].before, h[t].bucket_min ?? ''].join(';')).join(',');

/* Which managed tables this request reads rows retention removed from: its
   days overlap the claim [from, before). */
export async function notesFor(req, read, h) {
  const spec = READERS[req.path];
  if (!spec) return [];
  const want = (typeof spec.tables === 'function' ? spec.tables(req) : spec.tables).filter((t) => h[t]);
  if (!want.length) return [];
  const span = await spec.span(req, read);
  if (!span) return [];
  const [first, last] = span;
  return want.filter((t) => first < h[t].before && last >= h[t].from);
}

/* The middleware. Registered after the access gate and BEFORE the response
   cache (api/server.js), so a hit — which never reaches the route — still
   carries the header. A note that cannot be computed is left off; it never
   costs the page its answer. */
export function retentionNotes({ read }) {
  return async (req, res, next) => {
    if (req.method !== 'GET' || !READERS[req.path]) return next();
    try {
      const h = await retentionHorizon(read);
      if (Object.keys(h).length) {
        const hit = await notesFor(req, read, h);
        if (hit.length) res.set('x-fm-retention', noteValue(h, hit));
      }
    } catch { /* never block the answer on its footnote */ }
    return next();
  };
}
