/* THE ASSISTANT'S TOOLS — every figure it can say comes from one of these.
   ──────────────────────────────────────────────────────────────────────────
   The chat assistant (api/agent_routes.js) is a model that plans and talks.
   It is never asked to remember, estimate or add up a number: it calls a
   tool, the tool fetches, the server computes, and the answer refers to the
   result by its id ({{r3.completed_trips}}) so that the digits on screen are
   the server's, filled in after the model has finished writing.

   THE TOOLS READ THE PAGES' OWN ENDPOINTS, AS THE PERSON ASKING. Each data
   tool is a GET to an existing /api route over the loopback, carrying the
   asker's own cookie — never the internal token, never an admin token (the
   operator's rule: "nothing in production does"). So:

     · a figure equals the figure on the page that shows it, because it is
       that page's arithmetic, not a second implementation of it;
     · the access layer judges every call exactly as it judges the page: a
       Dispatcher asking about cash gets the refusal the Money page would give
       them, in its words, and the assistant passes that on rather than a
       zero (api/access/middleware.js);
     · nothing here can write. Every tool is a GET, and the assistant has no
       tool that is not.

   THE MODEL SEES A PREVIEW; THE PERSON SEES THE WHOLE. A result is stored
   whole on the conversation (agent_result, deleted with everything else after
   24 hours) and the model is shown its id, its definition, its headline values
   and its first dozen rows — enough to write about, too little to need
   copying. Tables and Excel files are built from the stored rows, not from
   anything the model wrote.

   EVERY RESULT SAYS WHAT IT IS. `definition` names the figure, the dates, the
   person or car, the platform and the fleet, in words. The chat prints it
   under every answer that uses the result, which is what makes a sentence like
   "on Bolt" checkable against a result that covered every platform — the
   mistake the 2026-10-09 trial of Seed 2.0 made, and api/agent_guard.js
   refuses. */
import { resolvePeriod, rangeLabel, shiftRange } from './agent_period.js';
import { findDriver, findCar } from './agent_people.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FLEETS = { ecosine: 'Ecosine', egari: 'Egari' };
const PLATFORMS = ['uber', 'bolt', 'yango', 'hotel', 'careem'];
const fleetWord = (f) => (f ? (FLEETS[f] || f) : 'both fleets');
const platWord = (p) => (p ? `${p[0].toUpperCase()}${p.slice(1)}` : 'every platform');

/* ── the specs the model is given ─────────────────────────────────────── */
const DATES = {
  from: { type: 'string', description: 'first day, YYYY-MM-DD, from resolve_period' },
  to: { type: 'string', description: 'last day, YYYY-MM-DD, from resolve_period' },
};
const FLEET = { type: 'string', enum: ['ecosine', 'egari'], description: 'one fleet; omit for both' };
const PLATFORM = { type: 'string', enum: PLATFORMS, description: 'one platform; omit for all' };
const fn = (name, description, properties, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const TOOL_SPECS = [
  fn('resolve_period', 'Turn the user\'s words about time into exact Dubai dates. Call this before any tool that takes from/to, every time a new time is mentioned. Pass the user\'s own words.',
    { text: { type: 'string', description: 'the time as the user said it, e.g. "last week", "September", "1-7 Oct"' } }, ['text']),
  fn('shift_period', 'The same span moved earlier or later, for fair comparisons: the same day last week (by week, n -1), the same days last month (by month), the same dates last year (by year), or the period of the same length just before (by period). Takes a result that has dates.',
    { result: { type: 'string', description: 'a result id with dates, usually from resolve_period' },
      by: { type: 'string', enum: ['day', 'week', 'month', 'year', 'period'] },
      n: { type: 'integer', description: 'how many; negative is earlier. Default -1' } }, ['result', 'by']),
  fn('find_driver', 'Find a driver by name (any spelling). Returns candidates. If the verdict is ambiguous or weak, call ask_user with the candidates before using any of them.',
    { name: { type: 'string' } }, ['name']),
  fn('find_car', 'Find a car by plate (e.g. L90721 or just 90721).', { plate: { type: 'string' } }, ['plate']),
  fn('fleet_totals', 'Whole-fleet totals for a period: completed trips, all trips, cancelled, gross fares (AED), priced trips, average fare, km, drivers, cars.',
    { ...DATES, platform: PLATFORM, fleet: FLEET }, ['from', 'to']),
  fn('daily', 'The fleet day by day for a period: trips, completed, cancelled, gross fares, drivers, km per day.',
    { ...DATES, platform: PLATFORM, fleet: FLEET }, ['from', 'to']),
  fn('drivers', 'Every driver who worked in a period, one row each, as on the Drivers page: trips, completed, days worked, gross fares, money, payout, km, rating. Use driver_id to get one person (from find_driver).',
    { ...DATES, fleet: FLEET, driver_id: { type: 'string' },
      sort_by: { type: 'string', enum: ['completed', 'trips', 'gross_fares_aed', 'money_aed', 'payout_aed', 'days', 'km'] },
      order: { type: 'string', enum: ['desc', 'asc'] } }, ['from', 'to']),
  fn('driver_trips', 'One driver\'s individual trips in a period: day, time, platform, plate, outcome, fare, payment. Use this for per-platform figures for one driver (then summarise with group_by platform).',
    { driver_id: { type: 'string', description: 'from find_driver' }, ...DATES, platform: PLATFORM }, ['driver_id', 'from', 'to']),
  fn('cars', 'Every car in a period, one row each, as on the Vehicles page: trips, gross fares, km, days moved, drivers, payout, current driver, status. Use plate for one car.',
    { ...DATES, fleet: FLEET, plate: { type: 'string' },
      sort_by: { type: 'string', enum: ['trips', 'gross_fares_aed', 'km', 'days_moved', 'payout_aed'] },
      order: { type: 'string', enum: ['desc', 'asc'] } }, ['from', 'to']),
  fn('cash_trips', 'Cash trips per driver in a period (trips where the driver collected the cash): count, known cash value, the statement\'s cash.',
    { ...DATES, fleet: FLEET }, ['from', 'to']),
  fn('month_target', 'The monthly revenue target: target, earned so far, planned, ahead/behind, still to earn, days left, pace, month-end projection, trips needed, and every driver against their own target.',
    { month: { type: 'string', description: 'YYYY-MM; omit for the current month' } }),
  fn('yesterday_target', 'Yesterday against its target: earned, plan, needed, difference, trips, trips target, active drivers, cars.', {}),
  fn('unregistered_trips', 'Trips the seat sensors saw with a passenger that no platform recorded, for a period: counts by verdict, km, estimated fares forgone, sensor coverage.',
    { ...DATES, fleet: FLEET }, ['from', 'to']),
  fn('summarise', 'Work on a stored table result: filter rows, group them, total or average a column, sort, keep the top N. Returns a new result. Use this for any adding up, averaging, ranking or counting — never do arithmetic yourself.',
    { result: { type: 'string', description: 'a table result id, e.g. r3' },
      filter: { type: 'array', items: { type: 'object', properties: {
        column: { type: 'string' }, op: { type: 'string', enum: ['=', '!=', '>', '>=', '<', '<=', 'contains'] }, value: {} },
      required: ['column', 'op', 'value'] } },
      group_by: { type: 'string', description: 'a column to group by, e.g. platform, day, fleet' },
      measures: { type: 'array', items: { type: 'object', properties: {
        column: { type: 'string' }, fn: { type: 'string', enum: ['sum', 'avg', 'min', 'max', 'count'] } }, required: ['fn'] } },
      sort_by: { type: 'string' }, order: { type: 'string', enum: ['desc', 'asc'] },
      limit: { type: 'integer', minimum: 1, maximum: 1000 } }, ['result']),
  fn('compare', 'Compare two results of the same kind (e.g. this week vs last week fleet totals): every shared figure with both values, the change and the % change. Returns a new result.',
    { a: { type: 'string', description: 'the newer/first result id' }, b: { type: 'string', description: 'the older/second result id' } }, ['a', 'b']),
  fn('combine', 'Join two table results row by row on driver, plate or day, so their columns sit side by side. Returns a new result.',
    { left: { type: 'string' }, right: { type: 'string' }, on: { type: 'string', enum: ['driver', 'plate', 'day'] } }, ['left', 'right', 'on']),
  fn('make_excel', 'Make an Excel file from one or more stored results, one sheet each. Returns a download link to put in the answer as [[file rN]].',
    { results: { type: 'array', items: { type: 'string' } }, title: { type: 'string' } }, ['results', 'title']),
  fn('ask_user', 'Ask the user to choose when something is ambiguous (two drivers, an unclear date, an unclear figure). Give short options. Ends your turn.',
    { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, maxItems: 6 } }, ['question']),
];

/* The words shown while a tool runs. */
export const STATUS = {
  resolve_period: (a) => `Working out the dates for “${String(a.text || '').slice(0, 40)}”…`,
  shift_period: () => 'Working out the dates to compare with…',
  find_driver: (a) => `Looking for “${String(a.name || '').slice(0, 40)}”…`,
  find_car: (a) => `Looking for car ${String(a.plate || '').slice(0, 12)}…`,
  fleet_totals: () => 'Fetching fleet totals…',
  daily: () => 'Fetching the day-by-day figures…',
  drivers: () => 'Fetching the drivers…',
  driver_trips: () => 'Fetching the trips…',
  cars: () => 'Fetching the cars…',
  cash_trips: () => 'Fetching cash trips…',
  month_target: () => 'Fetching the month target…',
  yesterday_target: () => 'Fetching yesterday against target…',
  unregistered_trips: () => 'Fetching unregistered trips…',
  summarise: () => 'Working the figures out…',
  compare: () => 'Comparing…',
  combine: () => 'Putting the tables together…',
  make_excel: () => 'Building the Excel file…',
};

/* ── results ──────────────────────────────────────────────────────────── */
/* What the model is shown of a result. Rows are cut to a dozen; the person
   gets all of them in the table and the file. */
export function forModel(r) {
  if (!r) return { error: 'no such result' };
  const o = { id: r.id, what: r.definition };
  if (r.withheld) return { ...o, withheld: r.withheld, note: 'Say this plainly; do not guess the figure.' };
  if (r.error) return { ...o, error: r.error, note: 'Say the dashboard could not answer; do not guess the figure.' };
  if (r.values && Object.keys(r.values).length) o.values = r.values;
  if (r.columns) {
    o.columns = r.columns.map((c) => c.key);
    o.row_count = (r.rows || []).length;
    o.rows = (r.rows || []).slice(0, 12).map((row) => Object.fromEntries(r.columns.map((c) => [c.key, row[c.key] ?? null])));
    if ((r.rows || []).length > 12) o.rows_note = `first 12 of ${(r.rows || []).length}; use summarise to sort, filter or total, and [[table ${r.id}]] to show them`;
  }
  if (r.candidates) o.candidates = r.candidates;
  if (r.verdict) o.verdict = r.verdict;
  if (r.note) o.note = r.note;
  return o;
}

const defn = (what, { period, driver, plate, platform, fleet } = {}) => [
  what,
  driver || null,
  plate ? `car ${plate}` : null,
  platform !== undefined ? platWord(platform) : null,
  fleet !== undefined ? fleetWord(fleet) : null,
  period ? period.label : null,
].filter(Boolean).join(' · ');

/* ── the box ──────────────────────────────────────────────────────────── */
/**
 * @param {object} deps
 * @param {(path:string) => Promise<{status:number, body:any}>} deps.fetchApi  GET as the asker
 * @param {() => number} [deps.now]
 * @param {(rid:string) => string} deps.fileUrl
 */
export function toolbox({ fetchApi, now = () => Date.now(), fileUrl = (rid) => `#${rid}`, fixedFleet = null }) {
  /* One directory and one car list per turn: a person named twice in one
     question is looked up once. */
  const memo = new Map();
  const getOnce = (path) => {
    if (!memo.has(path)) memo.set(path, fetchApi(path));
    return memo.get(path);
  };

  async function get(path) {
    const { status, body } = await getOnce(path);
    if (status === 401 || status === 403) {
      return { withheld: body?.detail || 'Your access does not include this.' };
    }
    if (status >= 400 || body == null) {
      return { error: `the dashboard could not answer this just now (${status}${body?.detail ? `: ${String(body.detail).slice(0, 120)}` : ''})` };
    }
    return { body };
  }

  const period = (a) => {
    if (!DAY_RE.test(String(a.from || '')) || !DAY_RE.test(String(a.to || ''))) return null;
    const [from, to] = a.from <= a.to ? [a.from, a.to] : [a.to, a.from];
    return { from, to, label: rangeLabel(from, to) };
  };
  const badDates = { error: 'from and to must be YYYY-MM-DD dates — call resolve_period first' };
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
  /* A person whose access covers one fleet: the gate narrows every fleet-
     filtered call to it whether or not the call says so, and a result labelled
     "both fleets" over one fleet's figures would be a true number under a
     false heading. So that fleet is sent, and named, explicitly. A different
     fleet asked for is sent as asked, and the gate's refusal is passed on. */
  const fleetOf = (a) => (FLEETS[a.fleet] ? a.fleet : fixedFleet);
  const platOf = (a) => (PLATFORMS.includes(a.platform) ? a.platform : null);

  const T = {
    async resolve_period(a) {
      const p = resolvePeriod(a.text, now());
      if (!p.ok) return { kind: 'period', definition: `Dates for “${a.text}”`, error: p.why, note: p.options ? `offer: ${p.options.join(' / ')}` : undefined };
      return { kind: 'period', definition: `Dates for “${a.text}”: ${p.label}`,
        period: { from: p.from, to: p.to, label: p.label },
        values: { from: p.from, to: p.to, label: p.label, days: p.days },
        kinds: { from: 'date', to: 'date', label: 'text', days: 'int' },
        note: p.assumption ? `assumption to tell the user: ${p.assumption}` : undefined,
        assumption: p.assumption || null };
    },

    async shift_period(a, ctx) {
      const src = ctx.results.get(String(a.result || ''));
      if (!src?.period) return { kind: 'period', definition: 'Shifted dates', error: `${a.result} has no dates to move — call resolve_period first` };
      const p = shiftRange(src.period.from, src.period.to, a.by, a.n ?? -1, now());
      if (!p.ok) return { kind: 'period', definition: 'Shifted dates', error: p.why };
      return { kind: 'period', definition: `Dates to compare with ${src.period.label}: ${p.label}`,
        period: { from: p.from, to: p.to, label: p.label },
        values: { from: p.from, to: p.to, label: p.label, days: p.days },
        kinds: { from: 'date', to: 'date', label: 'text', days: 'int' },
        note: p.assumption ? `assumption to tell the user: ${p.assumption}` : undefined, assumption: p.assumption || null };
    },

    async find_driver(a, ctx) {
      const g = await get('/api/drivers/directory?days=3660');
      if (g.withheld || g.error) return { kind: 'lookup', definition: `Drivers named “${a.name}”`, ...g };
      const rows = Array.isArray(g.body) ? g.body : (g.body.rows || []);
      const m = findDriver(a.name, rows);
      for (const c of m.candidates) ctx.drivers.set(c.driver_id, { name: c.name, ids: rows.find((r) => String(r.driver_ext_id) === c.driver_id)?.ids || [c.driver_id] });
      return { kind: 'lookup', definition: `Drivers named “${a.name}”`, verdict: m.verdict, candidates: m.candidates,
        note: m.why };
    },

    async find_car(a) {
      const g = await get('/api/vehicles/directory?days=365');
      if (g.withheld || g.error) return { kind: 'lookup', definition: `Cars with plate “${a.plate}”`, ...g };
      const rows = Array.isArray(g.body) ? g.body : (g.body.rows || []);
      const m = findCar(a.plate, rows);
      return { kind: 'lookup', definition: `Cars with plate “${a.plate}”`, verdict: m.verdict, candidates: m.candidates, note: m.why };
    },

    async fleet_totals(a) {
      const p = period(a); if (!p) return badDates;
      const platform = platOf(a); const fleet = fleetOf(a);
      const definition = defn('Fleet totals', { period: p, platform, fleet });
      const g = await get(`/api/kpis?${qs({ from: p.from, to: p.to, platform, fleet })}`);
      if (g.withheld || g.error) return { kind: 'value', definition, period: p, filters: { platform, fleet }, ...g };
      const k = g.body;
      return { kind: 'value', definition, period: p, filters: { platform, fleet }, source: '/api/kpis',
        values: {
          completed_trips: num(k.completed_trips), all_trips: num(k.trips), cancelled_trips: num(k.cancelled_trips),
          completion_pct: num(k.completion_pct), gross_fares_aed: num(k.revenue), priced_trips: num(k.priced_trips),
          avg_fare_aed: num(k.avg_fare), km: num(k.km), drivers: num(k.drivers), cars: num(k.vehicles),
        },
        kinds: { completed_trips: 'int', all_trips: 'int', cancelled_trips: 'int', completion_pct: 'pct',
          gross_fares_aed: 'aed', priced_trips: 'int', avg_fare_aed: 'aed', km: 'km', drivers: 'int', cars: 'int' },
        note: 'gross fares are the fares on priced trips, before commission; a trip not priced yet counts in trips but adds no fare' };
    },

    async daily(a) {
      const p = period(a); if (!p) return badDates;
      const platform = platOf(a); const fleet = fleetOf(a);
      const definition = defn('Day by day', { period: p, platform, fleet });
      const g = await get(`/api/trips/daily?${qs({ from: p.from, to: p.to, platform, fleet })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, period: p, ...g };
      const rows = (Array.isArray(g.body) ? g.body : g.body.rows || []).map((d) => ({
        day: d.d, all_trips: num(d.trips), completed: num(d.completed), cancelled: num(d.cancelled),
        gross_fares_aed: num(d.revenue), priced_trips: num(d.priced_trips), drivers: num(d.drivers), km: num(d.km),
        uncollected: d.uncollected ? 'not collected' : '',
      }));
      const missing = rows.filter((r) => r.uncollected).map((r) => r.day);
      return { kind: 'table', definition, period: p, filters: { platform, fleet }, source: '/api/trips/daily',
        columns: [col('day', 'Day', 'date'), col('completed', 'Completed', 'int'), col('all_trips', 'All trips', 'int'),
          col('cancelled', 'Cancelled', 'int'), col('gross_fares_aed', 'Gross fares', 'aed'), col('drivers', 'Drivers', 'int'),
          col('km', 'Km', 'km'), col('uncollected', 'Data', 'text')],
        rows, values: totalsOf(rows, ['completed', 'all_trips', 'cancelled', 'gross_fares_aed'], { days: rows.length }),
        note: missing.length ? `${missing.length} day(s) were not fully collected: ${missing.join(', ')} — say so` : undefined };
    },

    async drivers(a, ctx) {
      const p = period(a); if (!p) return badDates;
      const fleet = fleetOf(a);
      const one = a.driver_id ? ctx.drivers.get(String(a.driver_id)) : null;
      if (a.driver_id && !one) return { error: `driver_id ${a.driver_id} did not come from find_driver in this chat — call find_driver first` };
      const definition = defn(one ? 'Driver figures' : 'Drivers', { period: p, driver: one?.name, fleet });
      const g = await get(`/api/drivers/directory?${qs({ from: p.from, to: p.to, fleet })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, period: p, ...g };
      let rows = (Array.isArray(g.body) ? g.body : g.body.rows || []).map(driverRow);
      if (one) rows = rows.filter((r) => one.ids.includes(r.driver_id) || r.driver_id === String(a.driver_id));
      else rows = rows.filter((r) => (r.trips || 0) > 0 || r.money_aed != null || r.payout_aed != null);
      sortRows(rows, a.sort_by || 'completed', a.order);
      return { kind: 'table', definition, period: p, filters: { fleet, driver: one?.name || null }, source: '/api/drivers/directory',
        columns: DRIVER_COLS, rows,
        values: totalsOf(rows, ['trips', 'completed', 'gross_fares_aed', 'money_aed', 'payout_aed'], { drivers: rows.length }),
        note: 'money = the statement’s net where a platform filed one, fares where it did not; payout = what the platform paid; gross fares = fares on priced trips' };
    },

    async driver_trips(a, ctx) {
      const p = period(a); if (!p) return badDates;
      const one = ctx.drivers.get(String(a.driver_id || ''));
      if (!one) return { error: `driver_id ${a.driver_id} did not come from find_driver in this chat — call find_driver first` };
      const platform = platOf(a);
      const definition = defn('Trips', { period: p, driver: one.name, platform });
      const rows = [];
      for (let offset = 0; offset < 20000; offset += 1000) {
        const g = await get(`/api/driver/trips?${qs({ id: a.driver_id, from: p.from, to: p.to, limit: 1000, offset })}`);
        if (g.withheld || g.error) return { kind: 'table', definition, period: p, ...g };
        const page = g.body.rows || [];
        rows.push(...page);
        if (page.length < 1000 || !g.body.truncated) break;
      }
      const out = rows.filter((t) => !platform || t.platform === platform).map((t) => ({
        day: t.local_day, time: dubaiTime(t.requested_at), platform: t.platform, plate: t.plate || null,
        outcome: t.outcome || t.status || null, fare_aed: num(t.price), payment: t.payment_type || null,
        product: t.product || null, km: num(t.distance_km),
      }));
      const done = out.filter((t) => t.outcome === 'completed');
      return { kind: 'table', definition, period: p, filters: { driver: one.name, platform }, source: '/api/driver/trips',
        columns: [col('day', 'Day', 'date'), col('time', 'Time', 'text'), col('platform', 'Platform', 'text'),
          col('plate', 'Car', 'text'), col('outcome', 'Outcome', 'text'), col('fare_aed', 'Fare', 'aed'),
          col('payment', 'Payment', 'text'), col('product', 'Product', 'text'), col('km', 'Km', 'km')],
        rows: out,
        values: { trips: out.length, completed: done.length,
          fares_aed: r2(done.reduce((s, t) => s + (t.fare_aed || 0), 0)),
          priced_completed: done.filter((t) => t.fare_aed != null).length },
        kinds: { trips: 'int', completed: 'int', fares_aed: 'aed', priced_completed: 'int' },
        note: 'fares_aed adds the fares of completed trips that carry one; a trip not priced yet adds nothing' };
    },

    async cars(a) {
      const p = period(a); if (!p) return badDates;
      const fleet = fleetOf(a);
      const definition = defn(a.plate ? 'Car figures' : 'Cars', { period: p, plate: a.plate || null, fleet });
      const g = await get(`/api/vehicles/directory?${qs({ from: p.from, to: p.to, fleet })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, period: p, ...g };
      let rows = (Array.isArray(g.body) ? g.body : g.body.rows || []).map((v) => ({
        plate: v.plate, fleet: v.fleet_id || null, make_model: [v.make, v.model].filter(Boolean).join(' ') || null,
        trips: num(v.trips), gross_fares_aed: num(v.revenue), km: num(v.km), days_moved: num(v.days_moved),
        drivers: num(v.drivers), payout_aed: num(v.payout), current_driver: v.current_driver || null,
        status: v.status || null, last_trip: v.last_trip ? String(v.last_trip).slice(0, 10) : null,
      }));
      if (a.plate) {
        const want = String(a.plate).toUpperCase().replace(/[^A-Z0-9]/g, '');
        rows = rows.filter((r) => String(r.plate || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === want
          || String(r.plate || '').replace(/[^0-9]/g, '').endsWith(want.replace(/^[A-Z]+/, '')) && want.replace(/^[A-Z]+/, '').length >= 4);
      } else rows = rows.filter((r) => (r.trips || 0) > 0 || (r.km || 0) > 0);
      sortRows(rows, a.sort_by || 'trips', a.order);
      return { kind: 'table', definition, period: p, filters: { fleet, plate: a.plate || null }, source: '/api/vehicles/directory',
        columns: [col('plate', 'Car', 'text'), col('fleet', 'Fleet', 'text'), col('make_model', 'Model', 'text'),
          col('trips', 'Trips', 'int'), col('gross_fares_aed', 'Gross fares', 'aed'), col('km', 'Km', 'km'),
          col('days_moved', 'Days moved', 'int'), col('drivers', 'Drivers', 'int'), col('payout_aed', 'Payout', 'aed'),
          col('current_driver', 'Current driver', 'text'), col('status', 'Status', 'text'), col('last_trip', 'Last trip', 'date')],
        rows, values: totalsOf(rows, ['trips', 'gross_fares_aed', 'km', 'payout_aed'], { cars: rows.length }) };
    },

    async cash_trips(a) {
      const p = period(a); if (!p) return badDates;
      const fleet = fleetOf(a);
      const definition = defn('Cash trips by driver', { period: p, fleet });
      const g = await get(`/api/settlement/cash-exposure?${qs({ from: p.from, to: p.to, fleet })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, period: p, ...g };
      const b = g.body;
      const rows = (b.drivers || []).map((d) => ({
        driver: d.driver_name, driver_id: d.driver_ext_id || null, platforms: (d.platforms || []).join(', '),
        cars: (d.plates || []).join(', '), cash_trips: num(d.cash_trips), cash_value_aed: num(d.cash_value),
        statement_cash_aed: num(d.statement_cash), last_cash_trip: d.last_cash_trip ? String(d.last_cash_trip).slice(0, 10) : null,
      }));
      return { kind: 'table', definition, period: p, filters: { fleet }, source: '/api/settlement/cash-exposure',
        columns: [col('driver', 'Driver', 'text'), col('platforms', 'Platforms', 'text'), col('cars', 'Cars', 'text'),
          col('cash_trips', 'Cash trips', 'int'), col('cash_value_aed', 'Cash value (known)', 'aed'),
          col('statement_cash_aed', 'Statement cash', 'aed'), col('last_cash_trip', 'Last cash trip', 'date')],
        rows,
        values: { cash_trips: num(b.total_cash_trips), cash_value_known_aed: num(b.total_cash_value_known),
          statement_cash_aed: num(b.total_statement_cash), drivers: num(b.driver_count), value_known_pct: num(b.value_known_pct) },
        kinds: { cash_trips: 'int', cash_value_known_aed: 'aed', statement_cash_aed: 'aed', drivers: 'int', value_known_pct: 'pct' },
        note: [b.truncated ? `the list shows ${b.shown} of ${b.driver_count} drivers; the totals cover all of them` : null,
          b.caveat ? String(b.caveat).slice(0, 300) : null].filter(Boolean).join(' — ') || undefined };
    },

    async month_target(a) {
      const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(a.month || '')) ? a.month : null;
      const g = await get(`/api/target/month${month ? `?month=${month}` : ''}`);
      const definition = `Month target · ${month || 'this month'}`;
      if (g.withheld || g.error) return { kind: 'table', definition, ...g };
      const b = g.body; const s = b.summary || {}; const ts = b.trips_summary || {}; const dt = b.drivers?.totals || {};
      if (!s || s.month_target == null) {
        return { kind: 'value', definition: `Month target · ${b.month_name || month || 'this month'}`,
          error: b.why || 'no target is set for this month' };
      }
      const rows = (b.drivers?.rows || []).map((d) => ({
        driver: d.name, driver_id: d.driver_ext_id || null, fleet: d.fleet || null, platforms: (d.platforms || []).join(', '),
        days_active: num(d.days_active), gross_aed: num(d.gross), gross_target_aed: num(d.gross_target),
        gross_short_aed: num(d.gross_short), gross_pct: num(d.gross_pct), on_target_money: d.money_on ? 'yes' : 'no',
        trips: num(d.trips), trips_target: num(d.trips_target), trips_short: num(d.trips_short), on_target_trips: d.trips_on ? 'yes' : 'no',
      }));
      /* The days counted so far: the month's first day to the last settled
         one (drivers.through), as the page's own heading says. */
      const thru = b.drivers?.through || b.today || null;
      return { kind: 'table', definition: `Month target · ${b.month_name || month}${thru ? ` · counted to ${rangeLabel(thru, thru)}` : ''}`,
        period: b.first && thru ? { from: b.first, to: thru, label: rangeLabel(b.first, thru) } : null,
        source: '/api/target/month',
        values: {
          month_target_aed: num(s.month_target), earned_aed: num(s.earned), planned_to_date_aed: num(s.planned),
          ahead_aed: num(s.ahead),
          /* Signed figures read badly in a sentence ("−AED 46,323.98
             below plan"), so the two plain ones beside it. */
          behind_plan_aed: num(s.ahead) != null ? r2(Math.max(0, -num(s.ahead))) : null,
          ahead_of_plan_aed: num(s.ahead) != null ? r2(Math.max(0, num(s.ahead))) : null,
          still_to_earn_aed: num(s.to_go), days_left: num(s.days_left),
          each_day_left_needs_aed: num(s.per_day_left ?? s.today_needs), average_day_aed: num(s.avg_day),
          month_end_at_pace_aed: num(s.month_end_pace), pace_pct: num(s.pace_pct), cars_now: num(s.cars_now),
          trips_completed: num(ts.trips), trips_needed_to_date: num(ts.needed), trips_min_per_driver_day: num(ts.min),
          active_drivers: num(dt.drivers), drivers_on_target_money: num(dt.money_on), drivers_on_target_trips: num(dt.trips_on),
        },
        kinds: { month_target_aed: 'aed', earned_aed: 'aed', planned_to_date_aed: 'aed', ahead_aed: 'aed',
          behind_plan_aed: 'aed', ahead_of_plan_aed: 'aed',
          still_to_earn_aed: 'aed', days_left: 'int', each_day_left_needs_aed: 'aed', average_day_aed: 'aed',
          month_end_at_pace_aed: 'aed', pace_pct: 'pct', cars_now: 'int', trips_completed: 'int',
          trips_needed_to_date: 'int', trips_min_per_driver_day: 'int', active_drivers: 'int',
          drivers_on_target_money: 'int', drivers_on_target_trips: 'int' },
        columns: [col('driver', 'Driver', 'text'), col('fleet', 'Fleet', 'text'), col('platforms', 'Platforms', 'text'),
          col('days_active', 'Days active', 'int'), col('gross_aed', 'Gross', 'aed'), col('gross_target_aed', 'Gross target', 'aed'),
          col('gross_short_aed', 'Gross short', 'aed'), col('gross_pct', 'Gross %', 'pct'), col('on_target_money', 'On target (AED)', 'text'),
          col('trips', 'Trips', 'int'), col('trips_target', 'Trips target', 'int'), col('trips_short', 'Trips short', 'int'),
          col('on_target_trips', 'On target (trips)', 'text')],
        rows,
        note: 'say "behind plan by {{behind_plan_aed}}" or "ahead by {{ahead_of_plan_aed}}", not a negative number; figures are gross fares before commission, counted to the last settled day' };
    },

    async yesterday_target() {
      const g = await get('/api/target');
      if (g.withheld || g.error) return { kind: 'value', definition: 'Yesterday against target', ...g };
      const y = g.body.yesterday || {};
      if (!y.day) return { kind: 'value', definition: 'Yesterday against target', error: g.body.why || 'no target is set' };
      const p = { from: y.day, to: y.day, label: rangeLabel(y.day, y.day) };
      return { kind: 'value', definition: `Yesterday against target · ${p.label}`, period: p, source: '/api/target',
        values: { earned_aed: num(y.earned), plan_aed: num(y.plan), needed_aed: num(y.needed), difference_aed: num(y.diff),
          pct_of_needed: num(y.pct), completed_trips: num(y.trips), trips_target: num(y.trips_target),
          active_drivers: num(y.active_drivers), drivers_who_drove: num(y.drove), cars: num(y.cars),
          trips_per_active_driver: num(y.trips_per_active), verdict: y.verdict || null },
        kinds: { earned_aed: 'aed', plan_aed: 'aed', needed_aed: 'aed', difference_aed: 'aed', pct_of_needed: 'pct',
          completed_trips: 'int', trips_target: 'int', active_drivers: 'int', drivers_who_drove: 'int', cars: 'int',
          trips_per_active_driver: 'num', verdict: 'text' },
        note: y.settled === false ? 'yesterday is not settled yet — figures may still rise' : undefined };
    },

    async unregistered_trips(a) {
      const p = period(a); if (!p) return badDates;
      const fleet = fleetOf(a);
      const definition = defn('Unregistered trips', { period: p, fleet });
      const g = await get(`/api/unauthorized/summary?${qs({ from: p.from, to: p.to, fleet })}`);
      if (g.withheld || g.error) return { kind: 'value', definition, period: p, ...g };
      const b = g.body; const t = b.totals || {}; const c = b.coverage || {};
      return { kind: 'value', definition, period: p, filters: { fleet }, source: '/api/unauthorized/summary',
        values: { unregistered: num(t.unauthorized), registered: num(t.authorized), cannot_tell: num(t.unverifiable),
          waiting: num(t.pending), unregistered_km: num(t.unauth_km), fares_forgone_aed: num(b.value?.forgone_aed),
          days_with_sensor_data: num(c.days_with_data), days_in_period: num(c.days_in_window) },
        kinds: { unregistered: 'int', registered: 'int', cannot_tell: 'int', waiting: 'int', unregistered_km: 'km',
          fares_forgone_aed: 'aed', days_with_sensor_data: 'int', days_in_period: 'int' },
        note: c.complete === false ? 'sensor data does not cover every day of this period — say so' : undefined };
    },

    async summarise(a, ctx) {
      const src = ctx.results.get(String(a.result || ''));
      if (!src || !src.columns) return { error: `${a.result} is not a table result in this chat` };
      let rows = (src.rows || []).slice();
      const known = new Set(src.columns.map((c) => c.key));
      const filters = Array.isArray(a.filter) ? a.filter : [];
      for (const f of filters) {
        if (!known.has(f.column)) return { error: `${src.id} has no column ${f.column}; it has ${[...known].join(', ')}` };
        rows = rows.filter((r) => test(r[f.column], f.op, f.value));
      }
      const fdesc = filters.map((f) => `${f.column} ${f.op} ${f.value}`).join(', ');
      if (a.group_by) {
        if (!known.has(a.group_by)) return { error: `${src.id} has no column ${a.group_by}` };
        const measures = (Array.isArray(a.measures) && a.measures.length ? a.measures : [{ fn: 'count' }])
          .filter((m) => m.fn === 'count' || known.has(m.column));
        const groups = new Map();
        for (const r of rows) {
          const k = r[a.group_by] == null || r[a.group_by] === '' ? '(none)' : String(r[a.group_by]);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(r);
        }
        const key = (m) => (m.fn === 'count' ? 'count' : `${m.fn}_${m.column}`);
        const kindOf = (m) => (m.fn === 'count' ? 'int' : (src.columns.find((c) => c.key === m.column)?.kind || 'num'));
        let out = [...groups.entries()].map(([k, rs]) => {
          const row = { [a.group_by]: k };
          for (const m of measures) row[key(m)] = agg(rs, m);
          return row;
        });
        sortRows(out, a.sort_by && (a.sort_by === a.group_by || measures.some((m) => key(m) === a.sort_by)) ? a.sort_by : key(measures[0]), a.order);
        if (a.limit) out = out.slice(0, a.limit);
        const groupCol = src.columns.find((c) => c.key === a.group_by);
        const columns = [groupCol, ...measures.map((m) => col(key(m), m.fn === 'count' ? 'Rows' : `${m.fn} of ${src.columns.find((c) => c.key === m.column)?.label || m.column}`, kindOf(m) === 'date' ? 'text' : (m.fn === 'avg' && kindOf(m) === 'int' ? 'num' : kindOf(m))))];
        const values = { groups: out.length, rows_counted: rows.length };
        const kinds = { groups: 'int', rows_counted: 'int' };
        for (const m of measures) { values[`total_${key(m)}`] = m.fn === 'count' ? rows.length : (m.fn === 'sum' ? agg(rows, m) : null); kinds[`total_${key(m)}`] = m.fn === 'count' ? 'int' : kindOf(m); }
        /* Each group's figures as values too, so a sentence can cite one:
           {{r5.bolt_sum_completed}}. */
        for (const r of out.slice(0, 40)) {
          for (const m of measures) {
            const vk = `${slug(r[a.group_by])}_${key(m)}`;
            values[vk] = r[key(m)]; kinds[vk] = columns.find((c) => c.key === key(m)).kind;
          }
        }
        for (const k of Object.keys(values)) if (values[k] == null) { delete values[k]; delete kinds[k]; }
        return { kind: 'table', definition: `${src.definition} — grouped by ${groupCol.label.toLowerCase()}${fdesc ? `, where ${fdesc}` : ''}`,
          period: src.period, filters: { ...(src.filters || {}), grouped_by: a.group_by }, columns, rows: out, values, kinds, derived_from: src.id };
      }
      sortRows(rows, a.sort_by && known.has(a.sort_by) ? a.sort_by : null, a.order);
      if (a.limit) rows = rows.slice(0, a.limit);
      const numeric = src.columns.filter((c) => ['int', 'aed', 'km', 'num'].includes(c.kind)).map((c) => c.key);
      const values = totalsOf(rows, numeric, { rows: rows.length });
      for (const m of Array.isArray(a.measures) ? a.measures : []) {
        if (m.fn === 'count') { values.count = rows.length; values.__kinds.count = 'int'; continue; }
        if (!known.has(m.column)) continue;
        values[`${m.fn}_${m.column}`] = agg(rows, m);
        values.__kinds[`${m.fn}_${m.column}`] = m.fn === 'avg' ? 'num2' : (src.columns.find((c) => c.key === m.column)?.kind || 'num');
      }
      const top = a.limit ? `${a.order === 'asc' ? 'bottom' : 'top'} ${a.limit} by ${a.sort_by || 'order'}` : null;
      return { kind: 'table', definition: [src.definition, [fdesc ? `where ${fdesc}` : null, top].filter(Boolean).join(', ')].filter(Boolean).join(' — '),
        period: src.period, filters: src.filters, columns: src.columns, rows, values, derived_from: src.id };
    },

    async compare(a, ctx) {
      const A = ctx.results.get(String(a.a || '')); const B = ctx.results.get(String(a.b || ''));
      if (!A || !B) return { error: 'compare needs two result ids from this chat' };
      const keys = Object.keys(A.values || {}).filter((k) => typeof A.values[k] === 'number' && typeof B.values?.[k] === 'number');
      if (!keys.length) return { error: `${A.id} and ${B.id} share no figures to compare` };
      const rows = keys.map((k) => {
        const x = A.values[k]; const y = B.values[k];
        return { figure: k, label: labelOf(k), a: x, b: y, change: r2(x - y), change_pct: y ? r2(((x - y) / Math.abs(y)) * 100) : null, kind: (A.kinds || {})[k] || 'num' };
      });
      const values = {}; const kinds = {};
      for (const r of rows) {
        values[`${r.figure}_a`] = r.a; kinds[`${r.figure}_a`] = r.kind;
        values[`${r.figure}_b`] = r.b; kinds[`${r.figure}_b`] = r.kind;
        values[`${r.figure}_change`] = r.change; kinds[`${r.figure}_change`] = r.kind === 'pct' ? 'pts' : r.kind;
        if (r.change_pct != null) { values[`${r.figure}_change_pct`] = r.change_pct; kinds[`${r.figure}_change_pct`] = 'pct'; }
      }
      const la = A.period?.label || A.id; const lb = B.period?.label || B.id;
      /* Two periods of different lengths compared as totals would call a
         longer week "up". Said, so the answer can say per day instead. */
      const lenA = A.period ? dayCount(A.period) : null; const lenB = B.period ? dayCount(B.period) : null;
      return { kind: 'table', definition: `Comparison: ${A.definition}  against  ${B.definition}`,
        period: A.period, filters: A.filters, source: 'compare',
        /* One column holds trips, dirhams and percentages at once, so each
           row carries its own format (__kind) for the chat to read. */
        columns: [col('label', 'Figure', 'text'), col('a', la, 'num'), col('b', lb, 'num'), col('change', 'Change', 'num'), col('change_pct', 'Change %', 'pct')],
        rows: rows.map(({ kind, ...r }) => ({ ...r, __kind: kind === 'pct' ? 'num2' : kind })), values, kinds,
        note: lenA && lenB && lenA !== lenB ? `the two periods have different lengths (${lenA} and ${lenB} days) — compare per day, or say so` : undefined };
    },

    async combine(a, ctx) {
      const L = ctx.results.get(String(a.left || '')); const R = ctx.results.get(String(a.right || ''));
      if (!L?.columns || !R?.columns) return { error: 'combine needs two table results from this chat' };
      const keyCol = { driver: 'driver_id', plate: 'plate', day: 'day' }[a.on];
      const lk = keyCol === 'driver_id' && !L.columns.some((c) => c.key === 'driver_id') ? null : keyCol;
      if (!lk || !L.columns.some((c) => c.key === lk) || !R.columns.some((c) => c.key === lk)) {
        return { error: `both tables need a ${keyCol} column to be joined on ${a.on}` };
      }
      const rightBy = new Map((R.rows || []).map((r) => [String(r[lk]), r]));
      const extra = R.columns.filter((c) => c.key !== lk && !L.columns.some((x) => x.key === c.key));
      const clash = R.columns.filter((c) => c.key !== lk && L.columns.some((x) => x.key === c.key) && c.key !== 'driver');
      const columns = [...L.columns, ...extra, ...clash.map((c) => col(`${c.key}_2`, `${c.label} (2)`, c.kind))];
      const rows = (L.rows || []).map((l) => {
        const r = rightBy.get(String(l[lk])) || {};
        const o = { ...l };
        for (const c of extra) o[c.key] = r[c.key] ?? null;
        for (const c of clash) o[`${c.key}_2`] = r[c.key] ?? null;
        return o;
      });
      const unmatched = (L.rows || []).filter((l) => !rightBy.has(String(l[lk]))).length;
      return { kind: 'table', definition: `${L.definition}  joined with  ${R.definition}  on ${a.on}`, period: L.period,
        filters: L.filters, columns, rows, values: { rows: rows.length, unmatched }, kinds: { rows: 'int', unmatched: 'int' },
        note: unmatched ? `${unmatched} row(s) of ${L.id} have no match in ${R.id}; their ${R.id} columns are empty, not zero` : undefined };
    },

    async make_excel(a, ctx) {
      const ids = (Array.isArray(a.results) ? a.results : []).map(String).filter((id) => ctx.results.get(id)?.columns);
      if (!ids.length) return { error: 'make_excel needs at least one table result from this chat' };
      const rows = ids.reduce((s, id) => s + (ctx.results.get(id).rows || []).length, 0);
      const title = String(a.title || 'FleetMirror').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80).trim() || 'FleetMirror';
      return { kind: 'file', definition: `Excel file “${title}” · ${ids.length} sheet(s), ${rows} row(s)`, sheets: ids, title,
        values: { sheets: ids.length, rows }, kinds: { sheets: 'int', rows: 'int' }, __file: true };
    },
  };

  /** Run one tool. Returns the stored result. */
  return async function run(name, args, ctx) {
    const f = T[name];
    if (!f) return ctx.store({ kind: 'error', definition: name, error: `there is no tool called ${name}` });
    let r;
    try {
      r = await f(args || {}, ctx);
    } catch (e) {
      r = { definition: name, error: `the tool failed: ${String(e.message || e).slice(0, 160)}` };
    }
    if (r.values && r.values.__kinds) { r.kinds = { ...(r.kinds || {}), ...r.values.__kinds }; delete r.values.__kinds; }
    const stored = ctx.store({ tool: name, args, ...r });
    if (stored.__file) stored.url = fileUrl(stored.id);
    return stored;
  };
}

/* ── helpers ──────────────────────────────────────────────────────────── */
function col(key, label, kind) { return { key, label, kind }; }
/* A figure's key as a reader would say it: gross_fares_aed → Gross fares
   (AED), completion_pct → Completion %. */
export function labelOf(key) {
  const k = String(key || '');
  const named = { all_trips: 'All trips', avg_fare_aed: 'Average fare (AED)', km: 'Km', cars: 'Cars', drivers: 'Drivers' };
  if (named[k]) return named[k];
  const t = k.replace(/_aed$/, ' (AED)').replace(/_pct$/, ' %').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : k;
}
const DRIVER_COLS = [col('driver', 'Driver', 'text'), col('platforms', 'Platforms', 'text'), col('plate', 'Car', 'text'),
  col('fleet', 'Fleet', 'text'), col('trips', 'Trips', 'int'), col('completed', 'Completed', 'int'), col('days', 'Days worked', 'int'),
  col('gross_fares_aed', 'Gross fares', 'aed'), col('money_aed', 'Money', 'aed'), col('money_source', 'Money from', 'text'),
  col('payout_aed', 'Payout', 'aed'), col('km', 'Km', 'km'), col('rating', 'Rating', 'num'), col('last_trip', 'Last trip', 'date'),
  col('driver_id', 'Driver id', 'text')];
function driverRow(r) {
  return {
    driver: r.driver_name, driver_id: String(r.driver_ext_id || ''), platforms: (r.platforms || []).join(', '),
    plate: r.plate || null, fleet: r.fleet_id || null, trips: num(r.trips), completed: num(r.completed), days: num(r.days),
    gross_fares_aed: num(r.revenue), money_aed: num(r.money), money_source: r.money_source || null, payout_aed: num(r.payout),
    km: num(r.km), rating: num(r.rating ?? r.platform_rating), last_trip: r.last_trip ? String(r.last_trip).slice(0, 10) : null,
    ids: r.ids || [],
  };
}
function totalsOf(rows, keys, extra = {}) {
  const values = { ...extra }; const kinds = {};
  for (const k of Object.keys(extra)) kinds[k] = 'int';
  for (const k of keys) {
    const have = rows.filter((r) => typeof r[k] === 'number');
    if (!have.length) continue;
    values[`total_${k}`] = r2(have.reduce((s, r) => s + r[k], 0));
    kinds[`total_${k}`] = /_aed$/.test(k) ? 'aed' : k === 'km' ? 'km' : 'int';
  }
  values.__kinds = kinds;
  return values;
}
function sortRows(rows, by, order) {
  if (!by) return rows;
  const dir = order === 'asc' ? 1 : -1;
  return rows.sort((a, b) => {
    const x = a[by]; const y = b[by];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
  });
}
function test(v, op, want) {
  const nv = Number(v); const nw = Number(want);
  const both = v != null && v !== '' && Number.isFinite(nv) && Number.isFinite(nw);
  switch (op) {
    case '=': return both ? nv === nw : String(v ?? '').toLowerCase() === String(want ?? '').toLowerCase();
    case '!=': return both ? nv !== nw : String(v ?? '').toLowerCase() !== String(want ?? '').toLowerCase();
    case '>': return both && nv > nw;
    case '>=': return both && nv >= nw;
    case '<': return both && nv < nw;
    case '<=': return both && nv <= nw;
    case 'contains': return String(v ?? '').toLowerCase().includes(String(want ?? '').toLowerCase());
    default: return true;
  }
}
function agg(rows, m) {
  if (m.fn === 'count') return rows.length;
  const xs = rows.map((r) => r[m.column]).filter((x) => typeof x === 'number');
  if (!xs.length) return null;
  if (m.fn === 'sum') return r2(xs.reduce((s, x) => s + x, 0));
  if (m.fn === 'avg') return r2(xs.reduce((s, x) => s + x, 0) / xs.length);
  if (m.fn === 'min') return Math.min(...xs);
  if (m.fn === 'max') return Math.max(...xs);
  return null;
}
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'none';
const dayCount = (p) => Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 864e5) + 1;
function dubaiTime(ts) {
  if (!ts) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
  } catch { return null; }
}
