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
import { resolvePeriod, rangeLabel, shiftRange, resolveClock, shiftDay } from './agent_period.js';
import { dubaiDay } from './window.js';
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
  fn('class_targets', 'The daily revenue target by vehicle class (make, model, year): each class\'s AED a car on an average day, its cars now, today\'s plan, yesterday and the month so far earned against plan, and the figure for every other car.',
    { month: { type: 'string', description: 'YYYY-MM; omit for the current month' } }),
  fn('unregistered_trips', 'Trips the seat sensors saw with a passenger that no platform recorded, for a period: counts by verdict, km, estimated fares forgone, sensor coverage.',
    { ...DATES, fleet: FLEET }, ['from', 'to']),
  /* ── hours, live, money, places (2026-10-13) ─────────────────────────── */
  fn('driver_hours', 'One driver\'s working hours day by day for a period: hours online (logged in to Uber), hours on a job (request to drop-off), hours online waiting for a job, the first and last trip of each day and the hours between them. Totals and averages included. For one day\'s log-in sessions and breaks use driver_shift.',
    { driver_id: { type: 'string', description: 'from find_driver' }, ...DATES }, ['driver_id', 'from', 'to']),
  fn('driver_shift', 'One driver on one day: every log-in session (went online, went offline, where they went online), the breaks between sessions, the first and last trip, and totals — time logged in, shift span from first log-in to last log-out, number and length of breaks, longest break.',
    { driver_id: { type: 'string', description: 'from find_driver' }, day: { type: 'string', description: 'YYYY-MM-DD, from resolve_period' } }, ['driver_id', 'day']),
  fn('fleet_hours', 'Every driver\'s online hours for a period, one row each: hours online, hours on a job, hours waiting, days with hours, trips, money and money per online hour. For "who was online the most/least" or hours across the fleet.',
    { ...DATES, fleet: FLEET,
      sort_by: { type: 'string', enum: ['online_h', 'waiting_online_h', 'on_job_h', 'days_with_hours', 'aed_per_online_h', 'money_aed', 'trips'] },
      order: { type: 'string', enum: ['desc', 'asc'] } }, ['from', 'to']),
  fn('start_times', 'When each driver came online on one day, and — given a start time — who was late and by how many minutes, with their first trip and where they went online. Says why a driver has no online time rather than calling them absent.',
    { day: { type: 'string', description: 'YYYY-MM-DD, from resolve_period' },
      start: { type: 'string', description: 'the expected start time in the user\'s words, e.g. "7am"; omit for no lateness verdict' } }, ['day']),
  fn('live_cars', 'Where the cars are RIGHT NOW: each car\'s latest tracker position as an area name, moving or stopped, speed, whether a passenger is aboard, how old the position is, and the driver holding it. Give plate for one car, or driver_id for the car a driver has now. For a past time use whereabouts.',
    { plate: { type: 'string' }, driver_id: { type: 'string', description: 'from find_driver' }, fleet: FLEET }),
  fn('driver_status', 'Live Uber driver status. With driver_id: whether that driver is online, on a trip or offline right now, since when, which car, and today\'s online, on-trip and waiting minutes with every status change. Without: every Uber driver\'s status now, with counts.',
    { driver_id: { type: 'string', description: 'from find_driver' }, fleet: FLEET }),
  fn('whereabouts', 'Where a car was at a past time, in place names. Give plate or driver_id, the day (from resolve_period) and the time in the user\'s own words ("3pm", "between 2 and 5pm", "evening"); omit time for the whole day. A moment returns the nearest tracker position, the positions either side and who was driving; a stretch returns each stop (where, from, to, how long), the areas passed and the distance. With no plate and no driver, a single moment returns every car\'s position then.',
    { plate: { type: 'string' }, driver_id: { type: 'string', description: 'from find_driver' },
      day: { type: 'string', description: 'YYYY-MM-DD, from resolve_period' },
      time: { type: 'string', description: 'the time of day in the user\'s words; omit for the whole day' }, fleet: FLEET }, ['day']),
  fn('ledger_balances', 'Driver money balances on the company\'s cash ledger: advances owed, deductions owed, cash held (only where the accounts team stated an opening position), cash taken on cash trips, total owed, what the driver earned in the period, and exposure against the lending line. Give driver_id for one driver; without it, every driver with anything on the ledger. Balances are as of the period\'s last day (or today).',
    { driver_id: { type: 'string', description: 'from find_driver' }, from: DATES.from, to: DATES.to }),
  fn('ledger_entries', 'The driver money statement: every line recorded on the company\'s ledger — advances, repayments, deductions, fines, cash handed in, salary and other pay — with date, type, amount, how it was settled, who entered it and the note. Give driver_id for one driver, from/to for a period, book for one kind.',
    { driver_id: { type: 'string', description: 'from find_driver' }, from: DATES.from, to: DATES.to,
      book: { type: 'string', enum: ['advance', 'cash', 'deduction', 'pay'] } }),
  fn('platform_statements', 'What the platforms\' own statements say one driver earned in a period: totals (gross, platform fees, net, tips, cash collected, Salik, payouts counted) and either the statement line items (show "lines": fare, service fee, tips, tolls, cash collected…) or one row per statement period (show "periods").',
    { driver_id: { type: 'string', description: 'from find_driver' }, ...DATES,
      show: { type: 'string', enum: ['lines', 'periods'] } }, ['driver_id', 'from', 'to']),
  fn('payouts', 'Settlement history: every bank transfer Uber, Bolt and Yango paid the company in a period, by fleet, with the period it settles where the platform says, and totals per platform and fleet.',
    { ...DATES, platform: PLATFORM, fleet: FLEET }, ['from', 'to']),
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
  class_targets: () => 'Fetching the targets by vehicle class…',
  unregistered_trips: () => 'Fetching unregistered trips…',
  driver_hours: () => 'Fetching the hours…',
  driver_shift: () => 'Fetching the day’s log-ins and breaks…',
  fleet_hours: () => 'Fetching everyone’s hours…',
  start_times: () => 'Fetching who came online when…',
  live_cars: () => 'Finding the cars now…',
  driver_status: () => 'Checking live status…',
  whereabouts: (a) => `Finding where it was${a.time ? ` at “${String(a.time).slice(0, 30)}”` : ''}…`,
  ledger_balances: () => 'Fetching the balances…',
  ledger_entries: () => 'Fetching the statement lines…',
  platform_statements: () => 'Fetching the platform statements…',
  payouts: () => 'Fetching the payouts…',
  summarise: () => 'Working the figures out…',
  compare: () => 'Comparing…',
  combine: () => 'Putting the tables together…',
  make_excel: () => 'Building the Excel file…',
};

/* ── results ──────────────────────────────────────────────────────────── */
/* What the model is shown of a result. Rows are cut to a dozen; the person
   gets all of them in the table and the file. */
const MODEL_HIDDEN = new Set(['lat', 'lng']);
export function forModel(r) {
  if (!r) return { error: 'no such result' };
  const o = { id: r.id, what: r.definition };
  if (r.withheld) return { ...o, withheld: r.withheld, note: 'Say this plainly; do not guess the figure.' };
  if (r.error) return { ...o, error: r.error, note: 'Say the dashboard could not answer; do not guess the figure.' };
  if (r.values && Object.keys(r.values).length) o.values = r.values;
  if (r.columns) {
    /* Coordinates stay on the stored rows for the Excel file and out of the
       model's preview: it names places by their area, and a decimal pair in
       front of it is only an invitation to quote one (2026-10-13). */
    const cols = r.columns.filter((c) => !MODEL_HIDDEN.has(c.key));
    o.columns = cols.map((c) => c.key);
    o.row_count = (r.rows || []).length;
    o.rows = (r.rows || []).slice(0, 12).map((row) => Object.fromEntries(cols.map((c) => [c.key, row[c.key] ?? null])));
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
    const { status, body, withheld } = await getOnce(path);
    if (status === 401 || status === 403) {
      return { withheld: body?.detail || 'Your access does not include this.' };
    }
    if (status >= 400 || body == null) {
      return { error: `the dashboard could not answer this just now (${status}${body?.detail ? `: ${String(body.detail).slice(0, 120)}` : body?.error ? `: ${String(body.error).slice(0, 120)}` : ''})` };
    }
    /* WHICH PARTS THE GATE BLANKED. An answer the shaper narrowed for this
       person's role still arrives as a 200, with the withheld fields null —
       and a null position is exactly what a car with a dead tracker looks
       like. The gate names what it withheld in x-fm-withheld (and in
       _withheld on an object body), so a tool can say "withheld for your
       role" instead of "not reported", which would be a reason that is not
       the true one. */
    const classes = new Set(String(withheld || '').split(',').map((x) => x.trim()).filter(Boolean));
    if (body && typeof body === 'object' && !Array.isArray(body) && body._withheld) {
      for (const k of Object.keys(body._withheld)) classes.add(k);
    }
    return { body, blanked: classes };
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
          trips_min_today: num(ts.today_min), today_share_of_average_day_pct: s.today_weight != null ? r2(100 * s.today_weight) : null,
          active_drivers: num(dt.drivers), drivers_on_target_money: num(dt.money_on), drivers_on_target_trips: num(dt.trips_on),
        },
        kinds: { month_target_aed: 'aed', earned_aed: 'aed', planned_to_date_aed: 'aed', ahead_aed: 'aed',
          behind_plan_aed: 'aed', ahead_of_plan_aed: 'aed',
          still_to_earn_aed: 'aed', days_left: 'int', each_day_left_needs_aed: 'aed', average_day_aed: 'aed',
          month_end_at_pace_aed: 'aed', pace_pct: 'pct', cars_now: 'int', trips_completed: 'int',
          trips_needed_to_date: 'int', trips_min_per_driver_day: 'int', trips_min_today: 'int', today_share_of_average_day_pct: 'pct',
          active_drivers: 'int',
          drivers_on_target_money: 'int', drivers_on_target_trips: 'int' },
        columns: [col('driver', 'Driver', 'text'), col('fleet', 'Fleet', 'text'), col('platforms', 'Platforms', 'text'),
          col('days_active', 'Days active', 'int'), col('gross_aed', 'Gross', 'aed'), col('gross_target_aed', 'Gross target', 'aed'),
          col('gross_short_aed', 'Gross short', 'aed'), col('gross_pct', 'Gross %', 'pct'), col('on_target_money', 'On target (AED)', 'text'),
          col('trips', 'Trips', 'int'), col('trips_target', 'Trips target', 'int'), col('trips_short', 'Trips short', 'int'),
          col('on_target_trips', 'On target (trips)', 'text')],
        rows,
        note: 'say "behind plan by {{behind_plan_aed}}" or "ahead by {{ahead_of_plan_aed}}", not a negative number; figures are gross fares before commission, counted to the last settled day. '
          + (s.weighted ? 'The month is shared by weekday (since 11 Oct 2026, from the fleet’s last 8 weeks): a Sunday is asked less than a Thursday; today_share_of_average_day_pct is today’s share. ' : '')
          + 'trips_min_per_driver_day is the minimum on an average day; trips_min_today is what today asks of each active driver.' };
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

    /* The operator, 2026-10-29: "Let me set targets vehicle wise. Make model
       year - per day target, which will reflect everywhere." The Target
       page's table by class (api/revenue_target.js computeMonth classes). */
    async class_targets(a) {
      const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(a.month || '')) ? a.month : null;
      const g = await get(`/api/target${month ? `?month=${month}` : ''}`);
      const definition = `Targets by vehicle class · ${month || 'this month'}`;
      if (g.withheld || g.error) return { kind: 'table', definition, ...g };
      const b = g.body; const s = b.summary;
      if (!s) return { kind: 'value', definition, error: b.why || 'no target is set for this month' };
      const rows = (b.classes || []).filter((c) => !c.no_plate).map((c) => ({
        vehicle_class: c.label, cars_now: num(c.cars_now), aed_a_car_average_day: num(c.rate),
        uses_other_car_figure: c.uses_other ? 'yes' : 'no', today_plan_aed: num(c.plan_today),
        yesterday_plan_aed: num(c.yday_plan), yesterday_earned_aed: num(c.yday_earned),
        month_planned_to_date_aed: num(c.planned), month_earned_to_date_aed: num(c.earned), pct_of_plan: num(c.pct),
        month_plan_aed: num(c.month_plan), plates_without_class: (c.plates || []).join(', ') || null,
      }));
      return { kind: 'table', definition: `Targets by vehicle class · ${b.month_name || month}`, source: '/api/target',
        values: { kind: s.kind === 'class' ? 'daily targets by vehicle class' : 'one figure for every car',
          set_on: s.kind === 'class' ? s.rates_set_day : (b.target?.set_day || null),
          other_car_aed_average_day: num(s.other_rate), average_aed_a_car: num(s.rate), month_target_aed: num(s.month_target) },
        kinds: { kind: 'text', set_on: 'text', other_car_aed_average_day: 'aed', average_aed_a_car: 'aed', month_target_aed: 'aed' },
        columns: [col('vehicle_class', 'Make, model, year', 'text'), col('cars_now', 'Cars now', 'int'),
          col('aed_a_car_average_day', 'AED a car, average day', 'aed'), col('today_plan_aed', 'Today\'s plan', 'aed'),
          col('yesterday_earned_aed', 'Yesterday earned', 'aed'), col('yesterday_plan_aed', 'Yesterday plan', 'aed'),
          col('month_earned_to_date_aed', 'Month earned', 'aed'), col('month_planned_to_date_aed', 'Month planned', 'aed'),
          col('pct_of_plan', '% of plan', 'pct'), col('month_plan_aed', 'Month plan', 'aed'),
          col('uses_other_car_figure', 'Other-car figure?', 'text'), col('plates_without_class', 'Plates with no class', 'text')],
        rows,
        note: 'a class\'s figure is AED a car on an AVERAGE day; each day asks it × the weekday\'s weight (a Sunday less than a Thursday). '
          + (s.kind === 'class' ? 'A class with no figure of its own, and a car with no make or model on file, is asked the figure for every other car. '
            : 'This month still runs on one figure for every car, so each row is the class\'s share of it. ')
          + 'Figures are gross fares before commission; month figures are counted to yesterday.' };
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

    /* ══ HOURS ═══════════════════════════════════════════════════════════
       The operator (2026-10-13): "let the chat have access to driver online
       hours, logged in time, shift durations or break times". Every figure
       below is the driver page's own: /api/driver/daily is the Activity
       tab's day table and its hours tile, /api/driver/day the minute-by-
       minute day view, /api/economics/drivers the People ledger,
       /api/online-time the start-time board. Uber is the only channel that
       says when a driver is logged in, and every result says so — a Bolt or
       hotel driver with no online hours has not been offline, we were never
       told. */
    async driver_hours(a, ctx) {
      const p = period(a); if (!p) return badDates;
      const one = ctx.drivers.get(String(a.driver_id || ''));
      if (!one) return notFromLookup(a);
      const definition = defn('Working hours', { period: p, driver: one.name });
      const g = await get(`/api/driver/daily?${qs({ id: a.driver_id, from: p.from, to: p.to })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, period: p, filters: { driver: one.name }, ...g };
      const rows = (Array.isArray(g.body) ? g.body : []).map((d) => ({
        day: d.day, trips: num(d.trips), completed: num(d.completed),
        first_trip: dubaiTime(d.first_trip_at), last_trip: dubaiTime(d.last_trip_at),
        first_to_last_trip_h: num(d.span_h),
        online_h: num(d.hours_online), on_job_h: num(d.hours_on_job), waiting_online_h: num(d.hours_idle_online),
        hours_from: d.hours_online_basis === 'availability' ? 'Uber log-in record'
          : d.hours_online_basis === 'platform' ? 'platform report' : 'not reported',
      }));
      /* The hours tile's own arithmetic (/api/driver/kpis): online and on-job
         summed over the SAME days — the days that carry an online figure —
         so the share of online time spent on jobs cannot exceed 100% by
         dividing two different sets of days. */
      const measured = rows.filter((r) => r.online_h != null);
      const sum = (rs, k) => r2(rs.reduce((s, r) => s + (r[k] || 0), 0));
      const online = measured.length ? sum(measured, 'online_h') : null;
      const onJob = measured.length ? sum(measured, 'on_job_h') : null;
      const bkHidden = g.blanked?.has('BK');
      const values = {
        days_worked: bkHidden ? null : rows.filter((r) => (r.trips || 0) > 0).length,
        days_with_online_hours: measured.length,
        online_hours: online, on_job_hours: onJob,
        waiting_online_hours: measured.length ? sum(measured, 'waiting_online_h') : null,
        average_online_hours_per_day: measured.length ? r2(online / measured.length) : null,
        on_job_share_of_online_pct: online ? r2((onJob / online) * 100) : null,
        on_job_hours_every_day: rows.some((r) => r.on_job_h != null) ? sum(rows, 'on_job_h') : null,
        longest_online_day_hours: measured.length ? Math.max(...measured.map((r) => r.online_h)) : null,
      };
      for (const k of Object.keys(values)) if (values[k] == null) delete values[k];
      const kinds = { days_worked: 'int', days_with_online_hours: 'int', online_hours: 'hours', on_job_hours: 'hours',
        waiting_online_hours: 'hours', average_online_hours_per_day: 'hours', on_job_share_of_online_pct: 'pct',
        on_job_hours_every_day: 'hours', longest_online_day_hours: 'hours' };
      /* The hours are Uber's log-in record on every day that has them —
         production (2026-10-13) refused "logged in to Uber for 72h 47m" because
         this result also carries every platform's trips, so the platform
         cannot be the whole result's. It is the hours figures'. Only when
         EVERY measured day is Uber's record: a day a platform report supplied
         (the `h` source in /api/driver/daily, which no channel files today)
         would make the total no longer Uber's alone. */
      const uberHours = measured.length > 0 && measured.every((r) => r.hours_from === 'Uber log-in record');
      return { kind: 'table', definition, period: p, filters: { driver: one.name }, source: '/api/driver/daily',
        figure_platform: uberHours ? UBER_FIGURES(['online_h', 'on_job_h', 'waiting_online_h', 'days_with_online_hours', 'online_hours',
          'on_job_hours', 'waiting_online_hours', 'average_online_hours_per_day', 'on_job_share_of_online_pct',
          'on_job_hours_every_day', 'longest_online_day_hours']) : undefined,
        columns: [col('day', 'Day', 'date'), col('online_h', 'Online', 'hours'), col('on_job_h', 'On a job', 'hours'),
          col('waiting_online_h', 'Waiting online', 'hours'), col('first_trip', 'First trip', 'time'),
          col('last_trip', 'Last trip', 'time'), col('first_to_last_trip_h', 'First to last trip', 'hours'),
          col('trips', 'Trips', 'int'), col('completed', 'Completed', 'int'), col('hours_from', 'Hours from', 'text')],
        rows, values, kinds,
        note: [HOURS_NOTE, blankedNote(g, ['BK']),
          measured.length < rows.length ? `${rows.length - measured.length} of ${rows.length} days carry no online figure — not reported, which is not zero and not a day off` : null,
        ].filter(Boolean).join(' — ') };
    },

    async driver_shift(a, ctx) {
      const one = ctx.drivers.get(String(a.driver_id || ''));
      if (!one) return notFromLookup(a);
      if (!DAY_RE.test(String(a.day || ''))) return { error: 'day must be YYYY-MM-DD — call resolve_period first' };
      const p = { from: a.day, to: a.day, label: rangeLabel(a.day, a.day) };
      const definition = defn('Shift and breaks', { period: p, driver: one.name });
      const g = await get(`/api/driver/day?${qs({ id: a.driver_id, day: a.day })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, period: p, filters: { driver: one.name }, ...g };
      const b = g.body;
      /* Sessions are the day's online spans (api/online_span_sql.js — the same
         definition the stored online hours are summed from). Two spans a
         minute apart are one session: minutes are floored, so a span ending
         at 13:20:50 and the next starting at 13:21:05 read 800 and 801. */
      const spans = (b.online || []).filter((o) => o.e > o.s).sort((x, y) => x.s - y.s);
      const sessions = [];
      for (const o of spans) {
        const last = sessions[sessions.length - 1];
        if (last && o.s - last.e <= 1) {
          last.e = Math.max(last.e, o.e); last.open_ended = o.open_ended; last.closed_by = o.closed_by;
          continue;
        }
        sessions.push({ s: o.s, e: o.e, open_ended: o.open_ended, closed_by: o.closed_by,
          where: o.went_online?.where || null });
      }
      /* 'day' is a span with no later event at all, counted to the end of its
         own day — not a shift known to carry on past midnight, which is a
         span ending at 24:00 that is NOT open-ended (review, 2026-10-13). */
      const ENDS = { collection: 'record stops here — not collected further yet', now: 'still online at the last update',
        day: 'no log-out on record; counted to the end of the day' };
      const rows = [];
      const gaps = [];
      sessions.forEach((x, i) => {
        if (i > 0) {
          const gap = x.s - sessions[i - 1].e;
          gaps.push(gap);
          rows.push({ what: 'Break (logged out)', from: clock(sessions[i - 1].e), to: clock(x.s), minutes: gap, where: null, ends: '' });
        }
        rows.push({ what: 'Logged in', from: clock(x.s), to: clock(x.e), minutes: x.e - x.s, where: x.where,
          ends: x.open_ended ? (ENDS[x.closed_by] || 'record stops here') : '' });
      });
      /* The trips are BK, their outcomes COND: a role without them gets the
         array or the outcome blanked, and must not be told "0 trips". */
      const bkHidden = g.blanked?.has('BK') || !Array.isArray(b.trips);
      const condHidden = g.blanked?.has('COND');
      const trips = bkHidden ? [] : b.trips;
      const jobs = trips.filter((t) => t.e != null);
      const lastS = sessions[sessions.length - 1];
      /* MIDNIGHT. Spans are clipped to this day, so a session that opens at
         00:00 was already running when the day began, and one that closes at
         24:00 without being open-ended carries on into the next day. Neither
         edge is a log-in or a log-out time (review, 2026-10-13). */
      const fromBefore = sessions.length && sessions[0].s === 0;
      const pastMidnight = lastS && lastS.e >= 1440 && !lastS.open_ended;
      const values = {
        sessions: sessions.length,
        first_logged_in: sessions.length && !fromBefore ? clock(sessions[0].s) : null,
        logged_in_before_midnight: fromBefore ? 'yes — already online when the day began' : null,
        last_logged_out: lastS && !lastS.open_ended && !pastMidnight ? clock(lastS.e) : null,
        still_logged_in_at_midnight: pastMidnight ? 'yes — the session carries on into the next day' : null,
        logged_in_minutes: sessions.length ? sessions.reduce((s, x) => s + (x.e - x.s), 0) : null,
        shift_span_minutes: sessions.length ? lastS.e - sessions[0].s : null,
        breaks: sessions.length ? gaps.length : null,
        break_minutes: gaps.length ? gaps.reduce((s, x) => s + x, 0) : (sessions.length ? 0 : null),
        longest_break_minutes: gaps.length ? Math.max(...gaps) : null,
        breaks_15_min_or_longer: sessions.length ? gaps.filter((x) => x >= 15).length : null,
        trips: bkHidden ? null : trips.length,
        completed: bkHidden || condHidden ? null : trips.filter((t) => t.outcome === 'completed').length,
        first_trip: trips.length ? clock(Math.min(...trips.map((t) => t.s))) : null,
        last_trip_ended: jobs.length ? clock(Math.max(...jobs.map((t) => t.e))) : null,
        on_job_minutes: jobs.length ? jobs.reduce((s, t) => s + Math.max(0, t.e - t.s), 0) : null,
        went_online_most_in: b.goes_online_in?.[0]?.area || null,
      };
      for (const k of Object.keys(values)) if (values[k] == null) delete values[k];
      const kinds = { sessions: 'int', first_logged_in: 'time', logged_in_before_midnight: 'text', last_logged_out: 'time',
        still_logged_in_at_midnight: 'text', logged_in_minutes: 'min',
        shift_span_minutes: 'min', breaks: 'int', break_minutes: 'min', longest_break_minutes: 'min',
        breaks_15_min_or_longer: 'int', trips: 'int', completed: 'int', first_trip: 'time', last_trip_ended: 'time',
        on_job_minutes: 'min', went_online_most_in: 'text' };
      const notes = [
        sessions.length ? 'a break is time logged OUT of Uber between two sessions; time logged in and waiting for a job is not a break (it is in logged_in_minutes)' : null,
        !sessions.length ? `no log-in record for ${one.name} on this day. Uber is the only channel that reports when a driver is logged in, so a driver on Bolt, Yango or the hotel channel has none — that is not a day off${trips.length ? `; they took ${trips.length} trip${trips.length === 1 ? '' : 's'} that day` : ''}` : null,
        lastS?.open_ended ? `the last session has no log-out on record: ${ENDS[lastS.closed_by] || 'the record stops there'}` : null,
        fromBefore || pastMidnight ? 'the shift crosses midnight, so the span and the logged-in time count this day only' : null,
        blankedNote(g, ['BK', 'COND', 'LOC']),
        b.collection?.why || null,
      ].filter(Boolean);
      /* Every figure here is Uber's log-in record — the only provider whose
         timeline the product holds — so the result is about Uber alone, and
         "Uber's record has him logged in 8h 31m" is a true sentence the guard
         refused on production (2026-10-13) while the filter said nothing. */
      return { kind: 'table', definition, period: p, filters: { driver: one.name, platform: 'uber' }, source: '/api/driver/day',
        columns: [col('what', 'What', 'text'), col('from', 'From', 'time'), col('to', 'To', 'time'),
          col('minutes', 'Length', 'min'), col('where', 'Went online in', 'text'), col('ends', 'Note', 'text')],
        rows, values, kinds, note: notes.join(' — ') };
    },

    async fleet_hours(a) {
      const p = period(a); if (!p) return badDates;
      const fleet = fleetOf(a);
      const definition = defn('Online hours by driver', { period: p, fleet });
      const g = await get(`/api/economics/drivers?${qs({ from: p.from, to: p.to, fleet })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, period: p, filters: { fleet }, ...g };
      const b = g.body; const t = b.totals || {};
      let rows = (b.rows || []).map((r) => {
        const online = num(r.measured_hours_online); const idle = num(r.measured_idle_h);
        return { driver: r.driver_name, driver_id: String(r.driver_ext_id || ''), fleet: r.fleet_id || null,
          platforms: (r.platforms || []).join(', '), online_h: online, on_job_h: online != null && idle != null ? r2(online - idle) : null,
          waiting_online_h: idle, days_with_hours: num(r.availability_days), days_worked: num(r.days_worked),
          trips: num(r.bookings), money_aed: num(r.money), aed_per_online_h: num(r.aed_per_measured_hour) };
      }).filter((r) => (r.online_h || 0) > 0 || (r.trips || 0) > 0);
      sortRows(rows, a.sort_by || 'online_h', a.order);
      return { kind: 'table', definition, period: p, filters: { fleet }, source: '/api/economics/drivers',
        columns: [col('driver', 'Driver', 'text'), col('online_h', 'Online', 'hours'), col('on_job_h', 'On a job', 'hours'),
          col('waiting_online_h', 'Waiting online', 'hours'), col('days_with_hours', 'Days with hours', 'int'),
          col('days_worked', 'Days worked', 'int'), col('trips', 'Trips', 'int'), col('money_aed', 'Money', 'aed'),
          col('aed_per_online_h', 'Per online hour', 'aed'), col('platforms', 'Platforms', 'text'), col('driver_id', 'Driver id', 'text')],
        rows,
        values: { drivers: rows.length, drivers_with_online_hours: num(t.people_with_availability),
          online_hours: num(t.measured_hours_online), waiting_online_hours: num(t.measured_idle_h),
          aed_per_online_hour: num(t.aed_per_measured_hour), money_of_drivers_with_hours_aed: num(t.measured_money) },
        kinds: { drivers: 'int', drivers_with_online_hours: 'int', online_hours: 'hours', waiting_online_hours: 'hours',
          aed_per_online_hour: 'aed', money_of_drivers_with_hours_aed: 'aed' },
        /* The hours are Uber's availability record (measured_*, people_with_
           availability); trips, money and days worked are every platform's.
           So "Uber" is true beside an hours figure and not beside the rest. */
        figure_platform: UBER_FIGURES(['online_h', 'on_job_h', 'waiting_online_h', 'days_with_hours',
          'drivers_with_online_hours', 'online_hours', 'waiting_online_hours']),
        note: [HOURS_NOTE, 'the money per online hour is over the drivers who have hours only, both halves over the same people',
          blankedNote(g, ['BK', 'EARN'])].filter(Boolean).join(' — ') };
    },

    async start_times(a) {
      if (!DAY_RE.test(String(a.day || ''))) return { error: 'day must be YYYY-MM-DD — call resolve_period first' };
      let start = null; let said = null;
      if (a.start) {
        const c = resolveClock(a.start, now());
        if (!c.ok || c.kind !== 'moment') {
          return { kind: 'value', definition: `Start time “${a.start}”`, error: c.ok ? 'a start time is one moment, not a stretch' : c.why,
            note: c.options ? `offer: ${c.options.join(' / ')}` : undefined };
        }
        start = c.hhmm; said = c.assumption;
      }
      const p = { from: a.day, to: a.day, label: rangeLabel(a.day, a.day) };
      const definition = `When drivers came online · ${p.label}${start ? ` · against a ${start} start` : ''}`;
      const g = await get(`/api/online-time?${qs({ day: a.day, start })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, period: p, ...g };
      const b = g.body; const t = b.totals || {};
      const HOW = { reported: 'came online', already_online: 'online from before midnight', awaiting_feed: 'Uber record not in yet',
        worked_elsewhere: 'worked another channel (no log-in record)', cannot_earn: 'account cannot take work',
        not_asked: 'not asked of Uber yet', absent: 'did not come online' };
      /* The verdicts are COND: a role without conduct gets them blanked, and
         "not judged" on every row would be a reason that is not the true one
         beside a late count it can still read in the totals (review,
         2026-10-13). So both go, and the result says why. */
      const condHidden = g.blanked?.has('COND');
      const rows = (b.rows || []).map((r) => ({
        driver: r.name, driver_id: r.driver_ext_id || null, came_online: r.online_local || null,
        how: HOW[r.online_basis] || r.online_basis, first_trip: r.worked_first_local || null,
        late: condHidden && start ? 'withheld' : r.late === true ? 'late' : r.late === false ? 'on time' : start ? 'not judged' : '',
        minutes_late: r.late === true ? num(r.minutes_late) : null, car: r.plate || null,
        went_online_in: r.where?.area || null,
      }));
      const values = { drivers: num(t.people), came_online: num(t.reported), worked: num(t.worked),
        did_not_come_online: num(t.absent), cannot_take_work: num(t.cannot_earn) };
      const kinds = { drivers: 'int', came_online: 'int', worked: 'int', did_not_come_online: 'int', cannot_take_work: 'int' };
      if (start) {
        Object.assign(values, { start }); Object.assign(kinds, { start: 'time' });
        if (!condHidden) {
          Object.assign(values, { late: num(t.late), on_time: num(t.on_time), not_judged: num(t.unjudged) });
          Object.assign(kinds, { late: 'int', on_time: 'int', not_judged: 'int' });
        }
      }
      return { kind: 'table', definition, period: p, filters: { platform: 'uber' }, source: '/api/online-time',
        columns: [col('driver', 'Driver', 'text'), col('came_online', 'Came online', 'time'), col('how', 'Record', 'text'),
          col('first_trip', 'First trip', 'time'), col('late', 'Verdict', 'text'), col('minutes_late', 'Minutes late', 'int'),
          col('car', 'Car', 'text'), col('went_online_in', 'Went online in', 'text'), col('driver_id', 'Driver id', 'text')],
        rows, values, kinds, assumption: said,
        note: [said ? `assumption to tell the user: ${said}` : null,
          start ? 'a first trip can only clear somebody, never mark them late: it proves they were online by then' : (b.start_why || null),
          'Uber is the only channel that reports log-ins', blankedNote(g, ['COND', 'BK', 'LOC'])].filter(Boolean).join(' — ') };
    },

    /* ══ LIVE ════════════════════════════════════════════════════════════
       The live map's own rows (/api/live) and the status strip's
       (/api/status/*). A position is "live" for thirty minutes (FIX_FRESH in
       api/server.js); older, it is the last thing the tracker said, with its
       age, never presented as where the car is now. */
    async live_cars(a, ctx) {
      const fleet = fleetOf(a);
      let plate = a.plate ? normPlate(a.plate) : null;
      let driverName = null; let held = null;
      if (!plate && a.driver_id) {
        const one = ctx.drivers.get(String(a.driver_id));
        if (!one) return notFromLookup(a);
        driverName = one.name;
        /* The car this driver has NOW: Uber's live record names it where Uber
           lists them; otherwise the car their bookings put them in, today or
           yesterday. Said which, because they are different claims. */
        const st = await get(`/api/status/driver?${qs({ id: a.driver_id })}`);
        let refused = st.withheld || null;
        if (st.body?.plate) { plate = normPlate(st.body.plate); held = `Uber's live record has ${one.name} in ${st.body.plate}`; } else {
          const today = dubaiDay(new Date(now()));
          const c = await get(`/api/driver/custody?${qs({ id: a.driver_id, from: shiftDay(today, -1), to: today })}`);
          refused = refused || c.withheld || null;
          const r = (c.body?.rows || [])[0];
          if (r?.plate) { plate = normPlate(r.plate); held = `${one.name}'s bookings put them in ${r.plate} on ${rangeLabel(String(r.day).slice(0, 10), String(r.day).slice(0, 10))}`; }
        }
        /* A refusal is not an absence (review, 2026-10-13): a one-fleet reader
           is refused both lookups ('mixed' routes), and "no car is on record"
           would be a reason that is not the true one. */
        if (!plate && refused) {
          return { kind: 'value', definition: defn('Car now', { driver: one.name }), filters: { driver: one.name }, withheld: refused };
        }
        if (!plate) {
          return { kind: 'value', definition: defn('Car now', { driver: one.name }), filters: { driver: one.name },
            error: `no car is on record for ${one.name} now — Uber's live record names none and they made no booking today or yesterday` };
        }
      }
      const definition = `${plate ? `Car ${plate}` : 'Cars'} now${driverName ? ` · ${driverName}` : ''}${!plate ? ` · ${fleetWord(fleet)}` : ''}`;
      const g = await get('/api/live');
      if (g.withheld || g.error) return { kind: 'table', definition, filters: { fleet, plate, driver: driverName }, ...g };
      const locHidden = g.blanked?.has('LOC');
      const today = dubaiDay(new Date(now()));
      let rows = (Array.isArray(g.body) ? g.body : [])
        /* Uber writes driver-status rows into the same table with no
           coordinates (api/server.js /api/track says so); they are not
           positions. When the gate blanked positions for this role, every row
           has a null lat, so the test is the provider instead. */
        .filter((r) => (locHidden ? r.source !== 'uber' : r.lat != null && r.lng != null))
        .filter((r) => !fleet || r.fleet_id === fleet)
        .map((r) => ({
          plate: r.plate, fleet: r.fleet_id || null, driver: r.current_driver || null,
          area: r.place?.area || null,
          state: r.stale ? 'stale' : 'live',
          motion: r.speed == null ? null : Number(r.speed) > 3 ? 'moving' : 'stopped',
          speed_kmh: num(r.speed),
          passenger: r.seat_occupied == null ? 'not reported' : r.seat_occupied ? 'yes' : 'no',
          position_time: r.captured_at ? `${dubaiTime(r.captured_at)}${dayOfTs(r.captured_at) !== today ? ` on ${rangeLabel(dayOfTs(r.captured_at), dayOfTs(r.captured_at))}` : ''}` : null,
          position_age_min: num(r.fix_age_min), tracker: r.source,
          lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng),
        }));
      const want = plate ? plate.replace(/^[A-Z]+/, '') : '';
      const samePlate = (x) => normPlate(x) === plate || (want.length >= 4 && normPlate(x).replace(/^[A-Z]+/, '') === want);
      /* THE NEWEST ROW IS NOT ALWAYS A POSITION (production, 2026-10-13).
         /api/live keeps the newest telemetry row per plate from ANY source,
         and Uber's driver-status rows — which carry no coordinates — are
         often the newest. "Where is L19262 right now?" was answered "no
         tracker position is on record" while FMS had placed it on Al Khaleej
         Rd eight minutes earlier; measured that hour, 13 of the 22 Uber rows
         hid a fix under 30 minutes old. The live map has the same gap (it
         draws only rows with coordinates) — recorded in COVERAGE.md, not
         changed here. The assistant asks /api/where/fleet, which reads
         fixes only, for those cars; one car with no fix in 30 minutes is
         asked /api/where for its last fix today, said as stale with its age. */
      let fromFixes = 0;
      if (!locHidden) {
        const uberOnly = new Map((Array.isArray(g.body) ? g.body : [])
          .filter((r) => r.source === 'uber' && r.lat == null && (!fleet || r.fleet_id === fleet) && (!plate || samePlate(r.plate)))
          .map((r) => [normPlate(r.plate), r]));
        if (uberOnly.size) {
          const at = dubaiTime(new Date(now()));
          const w = await get(`/api/where/fleet?${qs({ day: today, at, fleet })}`);
          for (const c of (w.withheld || w.error ? [] : w.body?.cars || [])) {
            const u = uberOnly.get(normPlate(c.plate));
            if (!u || c.lat == null) continue;
            uberOnly.delete(normPlate(c.plate));
            fromFixes += 1;
            /* Age from the fix's own instant: the route's gap_min is to the
               asked minute, which is the clock truncated, up to 59 s early. */
            const age = c.at ? Math.round((now() - Date.parse(c.at)) / 60000) : num(c.gap_min);
            rows.push({ plate: c.plate, fleet: c.fleet_id || u.fleet_id || null, driver: u.current_driver || null,
              area: c.area || null, state: age != null && age <= 30 ? 'live' : 'stale', motion: c.motion || null, speed_kmh: num(c.speed),
              passenger: c.passenger == null ? 'not reported' : c.passenger ? 'yes' : 'no',
              position_time: c.time || null, position_age_min: age, tracker: c.source,
              lat: Number(c.lat), lng: Number(c.lng) });
          }
          if (plate && uberOnly.size) {
            const [u] = uberOnly.values();
            const one = await get(`/api/where?${qs({ plate: u.plate, day: today, at })}`);
            if (one.withheld) return { kind: 'value', definition, filters: { fleet, plate, driver: driverName }, withheld: one.withheld };
            const f = one.body?.before;
            if (f && f.lat != null) {
              fromFixes += 1;
              rows.push({ plate: u.plate, fleet: u.fleet_id || null, driver: u.current_driver || null,
                area: f.area || null, state: 'stale', motion: f.motion || null, speed_kmh: num(f.speed),
                passenger: f.passenger == null ? 'not reported' : f.passenger ? 'yes' : 'no',
                position_time: f.time || null, position_age_min: f.at ? Math.round((now() - Date.parse(f.at)) / 60000) : null,
                tracker: f.source, lat: Number(f.lat), lng: Number(f.lng) });
            } else {
              return { kind: 'value', definition, filters: { fleet, plate, driver: driverName },
                error: `no tracker has reported a position for ${u.plate} today — the live list holds only Uber's driver status for it`
                  + `${u.status ? ` (${String(u.status).toLowerCase()}${u.current_driver ? `, ${u.current_driver}` : ''})` : ''}, which carries no position` };
            }
          }
        }
      }
      if (plate) rows = rows.filter((r) => samePlate(r.plate));
      rows.sort((x, y) => (x.state === y.state ? String(x.plate).localeCompare(String(y.plate)) : x.state === 'live' ? -1 : 1));
      const live = rows.filter((r) => r.state === 'live');
      const filters = { fleet, plate, driver: driverName };
      const columns = [col('plate', 'Car', 'text'), col('area', 'Where', 'text'), col('state', 'Position', 'text'),
        col('motion', 'Moving', 'text'), col('speed_kmh', 'Km/h', 'int'), col('passenger', 'Passenger', 'text'),
        col('position_time', 'Position at', 'text'), col('position_age_min', 'Age', 'min'), col('driver', 'Driver', 'text'),
        col('fleet', 'Fleet', 'text'), col('tracker', 'Tracker', 'text'), col('lat', 'Lat', 'num'), col('lng', 'Lng', 'num')];
      const notes = [
        locHidden ? 'positions (area and coordinates) are withheld from this person\'s role — say so in one sentence; do not guess where any car is' : null,
        held, 'live = a tracker position in the last 30 minutes; a stale row is the last position the tracker reported, with its age — never say a stale car is there now',
        fromFixes ? `${fromFixes === 1 ? 'one car\'s position comes' : `${fromFixes} cars' positions come`} from the tracker's fixes, because Uber's newer driver-status row for it carries no position` : null,
      ].filter(Boolean);
      if (plate) {
        const r = rows[0];
        if (!r) {
          return { kind: 'value', definition, filters,
            error: `no tracker position is on record for ${plate}${fleet ? ` in ${fleetWord(fleet)}` : ''} — the car may have no tracker, or the plate may be mistyped (find_car checks it)` };
        }
        return { kind: 'table', definition, filters, source: '/api/live', columns, rows,
          values: { plate: r.plate, area: r.area, state: r.state, motion: r.motion, speed_kmh: r.speed_kmh,
            passenger: r.passenger, position_time: r.position_time, position_age_min: r.position_age_min, driver: r.driver },
          kinds: { plate: 'text', area: 'text', state: 'text', motion: 'text', speed_kmh: 'int', passenger: 'text',
            position_time: 'text', position_age_min: 'min', driver: 'text' },
          note: [r.area ? null : (locHidden ? null : 'the fleet has never driven near enough to this spot to have a name for it'), ...notes].filter(Boolean).join(' — ') };
      }
      return { kind: 'table', definition, filters, source: '/api/live', columns, rows,
        values: { cars_with_a_position: rows.length, live: live.length, stale: rows.length - live.length,
          moving: live.filter((r) => r.motion === 'moving').length, stopped: live.filter((r) => r.motion === 'stopped').length,
          with_passenger: live.filter((r) => r.passenger === 'yes').length, empty: live.filter((r) => r.passenger === 'no').length,
          seat_not_reported: live.filter((r) => r.passenger === 'not reported').length },
        kinds: { cars_with_a_position: 'int', live: 'int', stale: 'int', moving: 'int', stopped: 'int', with_passenger: 'int',
          empty: 'int', seat_not_reported: 'int' },
        note: [...notes, 'moving/stopped/passenger counts are over the live cars only'].join(' — ') };
    },

    async driver_status(a, ctx) {
      const WORD = { online: 'online, waiting for a job', ontrip: 'on a trip', offline: 'offline' };
      if (a.driver_id) {
        const one = ctx.drivers.get(String(a.driver_id));
        if (!one) return notFromLookup(a);
        const definition = defn('Live status', { driver: one.name });
        const g = await get(`/api/status/driver?${qs({ id: a.driver_id })}`);
        if (g.withheld || g.error) return { kind: 'table', definition, filters: { driver: one.name }, ...g };
        const b = g.body; const t = b.today || {};
        const rows = (t.spans || []).map((s) => ({ status: WORD[s.status] || s.status, from: s.from, minutes: num(s.minutes) }));
        /* No status change on record today is not "online 0 minutes": the
           route sends zeros beside its `absent` reason, and those zeros are a
           sum over nothing (review, 2026-10-13). */
        const noDay = Boolean(t.absent) || !(t.spans || []).length;
        const values = { status: b.status ? (WORD[b.status] || b.status) : null, since: b.status ? dubaiTime(b.status_at) : null,
          car: b.plate || null, last_heard_minutes_ago: num(b.observed_age_min),
          online_since_today: noDay ? null : t.online_since_local || null,
          online_today_minutes: noDay ? null : num(t.online_minutes),
          on_trip_today_minutes: noDay ? null : num(t.on_trip_minutes),
          waiting_today_minutes: noDay ? null : num(t.waiting_minutes) };
        for (const k of Object.keys(values)) if (values[k] == null) delete values[k];
        return { kind: 'table', definition: `${definition} · ${rangeLabel(b.day, b.day)}`, period: { from: b.day, to: b.day, label: rangeLabel(b.day, b.day) },
          filters: { driver: one.name, platform: 'uber' }, source: '/api/status/driver',
          columns: [col('status', 'Status', 'text'), col('from', 'From', 'time'), col('minutes', 'For', 'min')],
          rows, values,
          kinds: { status: 'text', since: 'time', car: 'text', last_heard_minutes_ago: 'min', online_since_today: 'time',
            online_today_minutes: 'min', on_trip_today_minutes: 'min', waiting_today_minutes: 'min' },
          note: [b.absent, b.stale_why, t.partial_why, t.absent,
            'online today counts online and on-trip time together; waiting is online minus on-trip'].filter(Boolean).join(' — ') };
      }
      const fleet = fleetOf(a);
      const definition = `Live driver status · ${fleetWord(fleet)}`;
      const g = await get(`/api/status/fleet?${qs({ fleet })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, filters: { fleet }, ...g };
      const b = g.body; const t = b.totals || {};
      const rows = (b.rows || []).map((r) => ({ driver: r.full_name || r.person_key || null, driver_id: r.driver_ext_id || null,
        status: r.status ? (WORD[r.status] || r.status) : 'no status reported', since: dubaiTime(r.status_at),
        car: r.plate || null, fleet: r.fleet_id || null }));
      /* Uber's live status feed (driver_status_event) and nothing else — the
         other providers send no status — so its counts are Uber's alone. */
      return { kind: 'table', definition, filters: { fleet, platform: 'uber' }, source: '/api/status/fleet',
        columns: [col('driver', 'Driver', 'text'), col('status', 'Status', 'text'), col('since', 'Since', 'time'),
          col('car', 'Car', 'text'), col('fleet', 'Fleet', 'text'), col('driver_id', 'Driver id', 'text')],
        rows,
        /* "How many drivers are online right now?" is answered by waiting +
           on a trip; production's model (2026-10-13) wrote that sum inside a
           placeholder because the figure was called `working`, and fell back
           to plain figures. It is named for the question now. */
        values: { drivers: num(t.drivers), online_now: num(t.working), online_waiting: num(t.online), on_trip: num(t.ontrip),
          offline: num(t.offline), no_status_reported: num(t.unknown), feed_minutes_old: num(b.feed_age_min) },
        kinds: { drivers: 'int', online_now: 'int', online_waiting: 'int', on_trip: 'int', offline: 'int', no_status_reported: 'int',
          feed_minutes_old: 'min' },
        note: [b.stale ? `the live feed has not answered for ${b.feed_age_min ?? 'an unknown number of'} minutes, so these are the last statuses it gave, not necessarily now` : null,
          'online_now = everyone logged in: waiting for a job + on a trip — the answer to "how many are online"', b.unknown_note, 'only Uber reports a live status; Bolt, Yango and hotel drivers are not on this list and are not offline'].filter(Boolean).join(' — ') };
    },

    /* ══ WHERE, WHEN ═════════════════════════════════════════════════════
       api/where_routes.js answers in the gazetteer's words; this turns the
       person's words for the time into HH:MM with resolveClock (the model
       never converts "3pm" itself), and a driver into the car they held that
       day from their bookings. */
    async whereabouts(a, ctx) {
      let clk = null;
      if (a.time) {
        clk = resolveClock(a.time, now());
        if (!clk.ok) {
          return { kind: 'value', definition: `Time “${String(a.time).slice(0, 40)}”`, error: clk.why,
            note: clk.options ? `ask which: ${clk.options.join(' / ')}` : undefined };
        }
      }
      let day = DAY_RE.test(String(a.day || '')) ? a.day : null;
      if (!day && clk?.now) day = dubaiDay(new Date(now()));
      if (!day) return { error: 'day must be YYYY-MM-DD — call resolve_period first' };
      const p = { from: day, to: day, label: rangeLabel(day, day) };
      const when = clk ? (clk.kind === 'moment' ? `at ${clk.hhmm}` : `${clk.from}–${clk.to}`) : 'all day';
      let plate = a.plate ? normPlate(a.plate) : null;
      let driverName = null; let heldNote = null;
      if (!plate && a.driver_id) {
        const one = ctx.drivers.get(String(a.driver_id));
        if (!one) return notFromLookup(a);
        driverName = one.name;
        const c = await get(`/api/driver/custody?${qs({ id: a.driver_id, from: day, to: day })}`);
        if (c.withheld || c.error) return { kind: 'value', definition: defn(`Where ${when}`, { period: p, driver: one.name }), filters: { driver: one.name }, ...c };
        /* One row per car, from the custody rows (one per platform). */
        const cars = new Map();
        for (const r of c.body?.rows || []) {
          const k = r.plate; if (!k) continue;
          const x = cars.get(k) || { plate: k, trips: r.trips == null ? null : 0, first: null, last: null };
          if (x.trips != null && r.trips != null) x.trips += Number(r.trips) || 0;
          const f = r.first_trip_at ? new Date(r.first_trip_at).getTime() : null;
          const l = r.last_trip_at ? new Date(r.last_trip_at).getTime() : null;
          if (f != null && (x.first == null || f < x.first)) x.first = f;
          if (l != null && (x.last == null || l > x.last)) x.last = l;
          cars.set(k, x);
        }
        const list = [...cars.values()].sort((x, y) => (y.trips ?? 0) - (x.trips ?? 0));
        if (!list.length) {
          return { kind: 'value', definition: defn(`Where ${when}`, { period: p, driver: one.name }), period: p, filters: { driver: one.name },
            error: `no car is on record for ${one.name} on ${p.label} — the car a driver held comes from their bookings that day, and they made none` };
        }
        let pick = list[0];
        if (clk?.kind === 'moment' && list.length > 1) {
          const at = Date.parse(`${day}T00:00:00+04:00`) + clk.minute * 60000;
          const dist = (x) => (x.first != null && x.last != null && x.first <= at && at <= x.last ? 0
            : Math.min(Math.abs((x.first ?? Infinity) - at), Math.abs((x.last ?? Infinity) - at)));
          pick = [...list].sort((x, y) => dist(x) - dist(y))[0];
        }
        plate = normPlate(pick.plate);
        const timed = list.some((x) => x.first != null);
        heldNote = list.length > 1
          ? `${one.name} drove ${list.length} cars that day (${list.map((x) => `${x.plate}${x.trips != null ? `: ${x.trips} trip${x.trips === 1 ? '' : 's'}` : ''}${x.first ? `, ${dubaiTime(new Date(x.first).toISOString())}–${dubaiTime(new Date(x.last).toISOString())}` : ''}`).join('; ')}); this is ${pick.plate}, ${!timed ? 'the first listed — their trip times are withheld from this person\'s role, so which car they had at a given time cannot be told' : clk?.kind === 'moment' ? 'the one whose trips were nearest that time' : 'the one with most trips'}`
          : `${pick.plate} is the car ${one.name}'s bookings put them in that day`;
      }
      const filters = { plate, driver: driverName, fleet: plate ? undefined : fleetOf(a) };

      if (!plate) {
        if (clk?.kind !== 'moment') return { error: 'for every car at once give one moment (e.g. "9pm"); for a stretch of the day give a plate or a driver' };
        const fleet = fleetOf(a);
        const definition = `Where every car was · ${p.label} at ${clk.hhmm} · ${fleetWord(fleet)}`;
        const g = await get(`/api/where/fleet?${qs({ day, at: clk.hhmm, fleet })}`);
        if (g.withheld || g.error) return { kind: 'table', definition, period: p, filters: { fleet }, ...g };
        const b = g.body; const t = b.totals || {};
        const rows = (b.cars || []).map((c) => ({ plate: c.plate, area: c.area || null, motion: c.motion,
          speed_kmh: num(c.speed), passenger: c.passenger == null ? 'not reported' : c.passenger ? 'yes' : 'no',
          position_time: c.time, minutes_from_moment: num(c.gap_min), held_by: c.held_by || null, fleet: c.fleet_id || null,
          lat: num(c.lat), lng: num(c.lng) }));
        const values = { cars: num(t.cars), moving: num(t.moving), stopped: num(t.stopped), with_passenger: num(t.with_passenger),
          on_unnamed_ground: num(t.unnamed_ground) };
        const kinds = { cars: 'int', moving: 'int', stopped: 'int', with_passenger: 'int', on_unnamed_ground: 'int' };
        for (const x of (b.by_area || []).slice(0, 25)) { const k = `cars_in_${slug(x.area)}`; values[k] = x.cars; kinds[k] = 'int'; }
        return { kind: 'table', definition, period: p, filters: { fleet }, source: '/api/where/fleet',
          columns: [col('plate', 'Car', 'text'), col('area', 'Where', 'text'), col('motion', 'Moving', 'text'),
            col('speed_kmh', 'Km/h', 'int'), col('passenger', 'Passenger', 'text'), col('position_time', 'Position at', 'time'),
            col('minutes_from_moment', 'Minutes off', 'int'), col('held_by', 'Held that day by', 'text'),
            col('fleet', 'Fleet', 'text'), col('lat', 'Lat', 'num'), col('lng', 'Lng', 'num')],
          rows, values, kinds, assumption: clk.assumption || null,
          note: [clk.assumption ? `assumption to tell the user: ${clk.assumption}` : null, b.basis,
            'to count cars in one area, summarise this grouped by area'].filter(Boolean).join(' — ') };
      }

      const query = clk?.kind === 'moment' ? { plate, day, at: clk.hhmm }
        : clk?.kind === 'span' ? { plate, day, from: clk.from, to: clk.to } : { plate, day };
      const definition = `Where ${plate} was · ${p.label} ${when}${driverName ? ` · ${driverName}` : ''}`;
      const g = await get(`/api/where?${qs(query)}`);
      if (g.withheld || g.error) return { kind: 'value', definition, period: p, filters, ...g };
      const b = g.body;
      const heldBy = (b.held_by || []).map((h) => `${h.name || 'unnamed'}${h.trips != null ? ` (${h.trips} trip${h.trips === 1 ? '' : 's'})` : ''}`).join(', ');
      const common = [clk?.assumption ? `assumption to tell the user: ${clk.assumption}` : null, heldNote,
        heldBy ? `held that day by ${heldBy}` : b.held_by_why].filter(Boolean);
      if (b.mode === 'moment') {
        const x = b.position;
        const values = { plate, area: x?.area || null, position_time: x?.time || null, minutes_from_moment: x ? num(b.gap_min) : null,
          motion: x?.motion || null, speed_kmh: x ? num(x.speed) : null,
          passenger: x ? (x.passenger == null ? 'not reported' : x.passenger ? 'yes' : 'no') : null,
          position_before: b.before ? `${b.before.time}${b.before.area ? ` in ${b.before.area}` : ''}` : null,
          position_after: b.after ? `${b.after.time}${b.after.area ? ` in ${b.after.area}` : ''}` : null,
          driver: b.driver_at?.name || null,
          /* Times only where the role holds them: a Fleet technician's
             driver_at carries the name and nulls for every booking time, and
             "from null to null" is not a sentence (review, 2026-10-13). */
          driving_basis: b.driver_at ? (b.driver_at.basis === 'on_trip'
            ? `on a trip${b.driver_at.platform ? ` (${b.driver_at.platform[0].toUpperCase()}${b.driver_at.platform.slice(1)})` : ''}${b.driver_at.trip_from ? ` from ${b.driver_at.trip_from} to ${b.driver_at.trip_to || 'an unrecorded drop-off'}` : ''}`
            : `between their own trips${b.driver_at.trip_before && b.driver_at.trip_after ? ` at ${b.driver_at.trip_before} and ${b.driver_at.trip_after}` : ''}`) : null,
        };
        for (const k of Object.keys(values)) if (values[k] == null) delete values[k];
        return { kind: 'value', definition, period: p, filters, source: '/api/where', values,
          kinds: { plate: 'text', area: 'text', position_time: 'time', minutes_from_moment: 'int', motion: 'text', speed_kmh: 'int',
            passenger: 'text', position_before: 'text', position_after: 'text', driver: 'text', driving_basis: 'text' },
          assumption: clk?.assumption || null,
          note: [b.position_why, x && !x.area ? 'the fleet has never driven near enough to this spot to have a name for it' : null,
            b.driver_at_why, ...common, blankedNote(g, ['BK', 'VEH'])].filter(Boolean).join(' — ') };
      }
      const rows = (b.stops || []).map((s) => ({ from: s.from, to: s.to, minutes: num(s.minutes), area: s.area || null,
        silent_min: num(s.longest_silence_min), lat: num(s.lat), lng: num(s.lng) }));
      const values = { plate, positions: num(b.fixes), first_position: b.first ? `${b.first.time}${b.first.area ? ` in ${b.first.area}` : ''}` : null,
        last_position: b.last ? `${b.last.time}${b.last.area ? ` in ${b.last.area}` : ''}` : null,
        distance_km: num(b.distance_km), stops: b.stops == null ? null : rows.length, stopped_minutes: num(b.stopped_min),
        areas_in_order: (b.areas_in_order || []).slice(0, 15).join(' → ') || null,
        longest_silence_minutes: num(b.longest_silence_min) };
      for (const k of Object.keys(values)) if (values[k] == null) delete values[k];
      return { kind: 'table', definition, period: p, filters, source: '/api/where',
        columns: [col('from', 'From', 'time'), col('to', 'To', 'time'), col('minutes', 'Stopped', 'min'),
          col('area', 'Where', 'text'), col('silent_min', 'Longest tracker silence', 'min'), col('lat', 'Lat', 'num'), col('lng', 'Lng', 'num')],
        rows, values,
        kinds: { plate: 'text', positions: 'int', first_position: 'text', last_position: 'text', distance_km: 'km', stops: 'int',
          stopped_minutes: 'min', areas_in_order: 'text', longest_silence_minutes: 'min' },
        assumption: clk?.assumption || null,
        note: [b.why, b.stops == null ? 'fewer than two positions in this stretch, so no stop can be shown or ruled out' : b.stop_rule,
          b.areas_truncated ? 'more areas than shown' : null, ...common, blankedNote(g, ['BK'])].filter(Boolean).join(' — ') };
    },

    /* ══ MONEY ═══════════════════════════════════════════════════════════
       The driver page's Money tab (api/public/driverledger.js) reads exactly
       these two routes: /api/ledger/exposure for the balances and
       /api/ledger/entries for the "Statement for …" lines. Both are CASH-
       class: a role without driver cash is refused them in the gate's own
       words, which the assistant passes on. A person nothing was ever
       recorded against is said to have no record — never a balance of
       nought (api/ledger_routes.js personFor). */
    async ledger_balances(a, ctx) {
      const p = a.from || a.to ? period(a) : null;
      if ((a.from || a.to) && !p) return badDates;
      let one = null;
      if (a.driver_id) { one = ctx.drivers.get(String(a.driver_id)); if (!one) return notFromLookup(a); }
      /* A BALANCE IS A POSITION, NOT A PERIOD'S FIGURE (production,
         2026-10-13). The route counts advances, deductions and cash taken
         from the beginning of the record up to `to`; only `earned` is over
         from–to (api/ledger_routes.js "POSITIONS ARE NOT WINDOWED"). The
         first version labelled the whole result with the period asked for,
         and the chat said "76 cash trips last week" for a driver whose week
         held 68 trips in all. The definition now says "as of", and the two
         windows are figures of their own. */
      const asOf = p ? p.to : dubaiDay(new Date(now()));
      const definition = `${defn(one ? 'Ledger balances' : 'Ledger balances by driver', { driver: one?.name })} · as of ${rangeLabel(asOf, asOf)}`;
      const filters = { driver: one?.name || null };
      const g = await get(`/api/ledger/exposure?${qs({ ext_id: one ? a.driver_id : null, from: p?.from, to: p?.to })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, period: p, filters, ...g };
      const b = g.body;
      if (b.absent_reason) {
        return { kind: 'value', definition, period: p, filters, source: '/api/ledger/exposure',
          values: { on_the_ledger: 'no' }, kinds: { on_the_ledger: 'text' }, note: b.absent_reason };
      }
      const pct = b.policy?.pct != null ? Number(b.policy.pct) : null;
      let rows = (b.people || []).map((x) => {
        const o = x.owes || {};
        return { driver: x.name, driver_id: x.ext_id || null,
          advance_owed_aed: num(o.advance), deductions_owed_aed: num(o.deduction), cash_held_aed: num(o.cash),
          cash_taken_aed: num(o.cash_taken), cash_trips: num(o.cash_taken_trips), total_owed_aed: num(o.total),
          cash_trips_from: o.cash_taken_from || null, cash_trips_to: o.cash_taken_to || null,
          /* THE PAY BOOK RUNS THE OTHER WAY (sql/schema_v78.sql): salary,
             commission, incentives and reimbursements are entered −1 — pay
             the company owes the driver — and a pay-out +1 settles it. Its
             net is therefore negative while pay is still owed. The first
             version printed it as "paid to driver −AED 1,500" (review,
             2026-10-13); it is split into the two plain figures instead. */
          pay_owed_to_driver_aed: x.pay_book == null ? null : r2(Math.max(0, -Number(x.pay_book))),
          paid_beyond_recorded_pay_aed: x.pay_book == null || Number(x.pay_book) <= 0 ? null : r2(Number(x.pay_book)),
          earned_aed: num(x.earned), exposure_pct: num(x.exposure_pct),
          against_line: x.over_policy === true ? 'over the line' : x.over_policy === false ? 'within' : 'not measurable',
          __reasons: [o.books_absent_reason, o.cash_absent_reason, o.cash_taken_means, o.total_absent_reason,
            x.earned_absent_reason, x.exposure_absent_reason, o.cash_basis?.floor_reason].filter(Boolean) };
      });
      if (!one) {
        rows = rows.filter((r) => r.advance_owed_aed != null || r.deductions_owed_aed != null || r.cash_held_aed != null
          || r.cash_taken_aed != null || r.pay_owed_to_driver_aed != null);
        sortRows(rows, 'cash_taken_aed', 'desc');
      }
      const reasons = one ? [...new Set(rows.flatMap((r) => r.__reasons))] : [];
      for (const r of rows) delete r.__reasons;
      const columns = [col('driver', 'Driver', 'text'), col('advance_owed_aed', 'Advances owed', 'aed'),
        col('deductions_owed_aed', 'Deductions owed', 'aed'), col('cash_held_aed', 'Cash held', 'aed'),
        col('cash_taken_aed', 'Cash taken (ceiling)', 'aed'), col('cash_trips', 'Cash trips', 'int'),
        col('total_owed_aed', 'Total owed', 'aed'), col('pay_owed_to_driver_aed', 'Pay owed to driver', 'aed'),
        col('earned_aed', 'Earned', 'aed'), col('exposure_pct', 'Exposure', 'pct'), col('against_line', 'Against the line', 'text'),
        col('driver_id', 'Driver id', 'text')];
      const NOTE = 'advances and deductions owed are what the ledger records; cash held is known only where the accounts team stated an opening cash position; cash taken is every cash fare on record — a ceiling on what they could still hold, not a balance; pay owed to the driver is recorded salary, commission, incentives and reimbursements not yet paid out; an empty figure means nothing was recorded, never a balance of nought';
      const earnedOver = p ? rangeLabel(p.from, p.to) : 'every date on record';
      const WINDOWS = `every balance, cash taken and cash trips is everything recorded up to ${rangeLabel(asOf, asOf)} — NEVER only a period's, so never say "last week" or any period beside them; cash_trips_from/to are the dates of the first and last cash trip counted; only earned_aed is over ${earnedOver}`;
      if (one) {
        const r = rows[0] || {};
        const values = { advance_owed_aed: r.advance_owed_aed, deductions_owed_aed: r.deductions_owed_aed, cash_held_aed: r.cash_held_aed,
          cash_taken_aed: r.cash_taken_aed, cash_trips: r.cash_trips, cash_trips_from: r.cash_trips_from, cash_trips_to: r.cash_trips_to,
          total_owed_aed: r.total_owed_aed, earned_over: earnedOver,
          pay_owed_to_driver_aed: r.pay_owed_to_driver_aed, paid_beyond_recorded_pay_aed: r.paid_beyond_recorded_pay_aed,
          earned_aed: r.earned_aed, exposure_pct: r.exposure_pct,
          lending_line_pct: pct, against_line: r.against_line };
        for (const k of Object.keys(values)) if (values[k] == null) delete values[k];
        return { kind: 'table', definition, period: p, filters, source: '/api/ledger/exposure', columns, rows, values,
          kinds: { advance_owed_aed: 'aed', deductions_owed_aed: 'aed', cash_held_aed: 'aed', cash_taken_aed: 'aed', cash_trips: 'int',
            cash_trips_from: 'date', cash_trips_to: 'date', earned_over: 'text',
            total_owed_aed: 'aed', pay_owed_to_driver_aed: 'aed', paid_beyond_recorded_pay_aed: 'aed', earned_aed: 'aed',
            exposure_pct: 'pct', lending_line_pct: 'pct', against_line: 'text' },
          note: [NOTE, WINDOWS, ...reasons.map((x) => String(x).slice(0, 260)), blankedNote(g, ['EARN', 'BK'])].filter(Boolean).join(' — ') };
      }
      return { kind: 'table', definition, period: p, filters, source: '/api/ledger/exposure', columns, rows,
        values: { ...totalsOf(rows, ['advance_owed_aed', 'deductions_owed_aed', 'cash_held_aed', 'cash_taken_aed', 'pay_owed_to_driver_aed'],
          { drivers: rows.length, over_the_line: rows.filter((r) => r.against_line === 'over the line').length }),
          ...(pct != null ? { lending_line_pct: pct } : {}) },
        kinds: { lending_line_pct: 'pct' },
        note: [NOTE, WINDOWS, blankedNote(g, ['EARN', 'BK'])].filter(Boolean).join(' — ') };
    },

    async ledger_entries(a, ctx) {
      const p = a.from || a.to ? period(a) : null;
      if ((a.from || a.to) && !p) return badDates;
      let one = null;
      if (a.driver_id) { one = ctx.drivers.get(String(a.driver_id)); if (!one) return notFromLookup(a); }
      const book = ['advance', 'cash', 'deduction', 'pay'].includes(a.book) ? a.book : null;
      const definition = [defn('Money statement lines', { period: p || undefined, driver: one?.name }), book ? `${book} book` : null,
        p ? null : 'every date'].filter(Boolean).join(' · ');
      const filters = { driver: one?.name || null, book };
      const g = await get(`/api/ledger/entries?${qs({ ext_id: one ? a.driver_id : null, from: p?.from, to: p?.to, book })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, period: p, filters, ...g };
      const b = g.body;
      if (b.absent_reason) {
        return { kind: 'value', definition, period: p, filters, source: '/api/ledger/entries',
          values: { entries: 0, on_the_ledger: 'no' }, kinds: { entries: 'int', on_the_ledger: 'text' }, note: b.absent_reason };
      }
      const t = b.totals || {};
      const rows = (b.entries || []).filter((e) => e.entry_source !== 'verification').map((e) => ({
        date: e.effective_on, driver: e.person_name, driver_id: e.ext_id || null, type: e.label || e.type_code,
        book: e.book, amount_aed: num(e.amount), settled_via: e.settles_via || null,
        period: e.period_start ? `${e.period_start} to ${e.period_end || e.period_start}` : null,
        entered_by: e.entered_by || null, note: e.note || null,
        receipt: e.receipt_row ? (e.receipt_expired ? 'held, since expired' : 'held') : (e.needs_proof ? 'none attached' : ''),
        reverses: e.reverses_id ? `reverses entry ${e.reverses_id}` : '' }));
      const entries = Math.max(0, (t.rows || 0) - (t.verification_rows || 0));
      return { kind: 'table', definition, period: p, filters, source: '/api/ledger/entries',
        columns: [col('date', 'Date', 'date'), col('driver', 'Driver', 'text'), col('type', 'Type', 'text'), col('book', 'Book', 'text'),
          col('amount_aed', 'Amount', 'aed'), col('settled_via', 'Settled via', 'text'), col('period', 'Period', 'text'),
          col('entered_by', 'Entered by', 'text'), col('note', 'Note', 'text'), col('receipt', 'Receipt', 'text'),
          col('reverses', 'Reverses', 'text'), col('driver_id', 'Driver id', 'text')],
        rows,
        values: { entries, advance_book_aed: num(t.advance), cash_book_aed: num(t.cash), deduction_book_aed: num(t.deduction),
          pay_book_aed: num(t.pay), listed: rows.length },
        kinds: { entries: 'int', advance_book_aed: 'aed', cash_book_aed: 'aed', deduction_book_aed: 'aed', pay_book_aed: 'aed', listed: 'int' },
        note: ['each amount carries the ledger\'s own sign: advances, deductions and fines are positive (the driver owes them); repayments, write-offs, refunds and cash handed in are negative; on the pay book, salary, commission, incentives and reimbursements are negative (the company owes the driver) and a pay-out is positive (it settles them)',
          entries > rows.length ? `the list shows the latest ${rows.length} of ${entries} lines; the book totals cover all of them` : null,
          !entries ? 'nothing is recorded on the ledger for this selection — that is no entries, not a balance of nought' : null,
          b.listed_why || null].filter(Boolean).join(' — ') };
    },

    async platform_statements(a, ctx) {
      const p = period(a); if (!p) return badDates;
      const one = ctx.drivers.get(String(a.driver_id || ''));
      if (!one) return notFromLookup(a);
      const show = a.show === 'periods' ? 'periods' : 'lines';
      const definition = defn(show === 'periods' ? 'Platform statement periods' : 'Platform statement lines', { period: p, driver: one.name });
      const filters = { driver: one.name };
      const g = await get(`/api/driver/earnings?${qs({ id: a.driver_id, from: p.from, to: p.to })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, period: p, filters, ...g };
      const b = g.body;
      const values = { statement_gross_aed: num(b.statement_gross), platform_fees_aed: num(b.statement_fees),
        statement_net_aed: num(b.fare), tips_aed: num(b.tips), cash_collected_aed: num(b.statement_cash),
        salik_aed: num(b.statement_salik), statement_days: num(b.statement_days),
        payouts_counted_aed: num(b.counted_total), statement_periods: num(b.counted_periods) };
      for (const k of Object.keys(values)) if (values[k] == null) delete values[k];
      const kinds = { statement_gross_aed: 'aed', platform_fees_aed: 'aed', statement_net_aed: 'aed', tips_aed: 'aed',
        cash_collected_aed: 'aed', salik_aed: 'aed', statement_days: 'int', payouts_counted_aed: 'aed', statement_periods: 'int' };
      const day = (v) => (v ? String(v).slice(0, 10) : null);
      const NOTE = 'gross, fees, net, tips, cash and Salik are the platforms\' statements resolved to one row a day — quote these totals; net = gross minus fees';
      if (show === 'periods') {
        const rows = (b.periods || []).map((r) => ({ platform: r.platform, from: day(r.period_start), to: day(r.period_end),
          statement_aed: num(r.earnings), counted_in_dates_aed: num(r.counted), cash_aed: num(r.cash_earnings), trips: num(r.trips),
          hours_online: num(r.hours_online), rating: num(r.rating), part: r.clipped ? 'partly outside the dates' : '' }));
        return { kind: 'table', definition, period: p, filters, source: '/api/driver/earnings',
          columns: [col('platform', 'Platform', 'text'), col('from', 'From', 'date'), col('to', 'To', 'date'),
            col('statement_aed', 'Statement', 'aed'), col('counted_in_dates_aed', 'Counted in these dates', 'aed'),
            col('cash_aed', 'Cash', 'aed'), col('trips', 'Trips', 'int'), col('hours_online', 'Hours online', 'hours'),
            col('rating', 'Rating', 'num'), col('part', 'Note', 'text')],
          rows, values, kinds,
          note: [`${NOTE} — a period that runs past the dates is counted only for its days inside them`, blankedNote(g, ['CASH', 'BK', 'COND'])].filter(Boolean).join(' — ') };
      }
      /* THE CASH LINES, WHEN CASH IS WITHHELD. The manifest marks this route's
         cash_collected component as CASH with a filter path
         (components[category=cash_collected]) that api/access/shape.js does
         not read, so the shaper leaves it in — measured by the review of
         2026-10-13, and older than this tool. Until the shaper reads that
         notation, the tool drops every line that is cash, and any group left
         holding nothing but cash lines, whenever the gate withheld CASH
         anywhere else on this answer. */
      let comps = b.components || [];
      if (g.blanked?.has('CASH')) {
        const drop = new Set(comps.filter((c) => /cash/i.test(`${c.category} ${c.parent || ''}`)).map((c) => c.category));
        for (let changed = true; changed;) {
          changed = false;
          for (const c of comps) {
            if (drop.has(c.category)) continue;
            const kids = comps.filter((k) => k.parent === c.category);
            if (kids.length && kids.every((k) => drop.has(k.category))) { drop.add(c.category); changed = true; }
          }
        }
        comps = comps.filter((c) => !drop.has(c.category));
      }
      const rows = comps.map((c) => ({ line: String(c.category || '').replace(/_/g, ' '),
        under: c.parent ? String(c.parent).replace(/_/g, ' ') : '', amount_aed: num(c.amount) }));
      return { kind: 'table', definition, period: p, filters, source: '/api/driver/earnings',
        columns: [col('line', 'Line', 'text'), col('under', 'Part of', 'text'), col('amount_aed', 'Amount', 'aed')],
        rows, values, kinds,
        note: [`${NOTE} — the lines are as each platform filed them over statement periods wholly inside the dates, nested (a line "part of" another is already inside it, so never add a line to its parent), and Uber sometimes files the same days on two surfaces, so a line can repeat; for totals quote the figures above, not a sum of lines`,
          blankedNote(g, ['CASH', 'BK'])].filter(Boolean).join(' — ') };
    },

    async payouts(a) {
      const p = period(a); if (!p) return badDates;
      const platform = platOf(a); const fleet = fleetOf(a);
      const definition = defn('Platform payouts to the company', { period: p, platform, fleet });
      const filters = { platform, fleet };
      const g = await get(`/api/finance/payouts?${qs({ from: p.from, to: p.to, platform, fleet })}`);
      if (g.withheld || g.error) return { kind: 'table', definition, period: p, filters, ...g };
      const b = g.body;
      const day = (v) => (v ? String(v).slice(0, 10) : null);
      const rows = (b.payouts || []).map((x) => ({ paid_on: day(x.paid_on), platform: x.platform, fleet: x.fleet_id || null,
        amount_aed: x.currency && x.currency !== 'AED' ? null : num(x.amount), currency: x.currency || 'AED',
        settles: x.period_start ? `${day(x.period_start)} to ${day(x.period_end)}` : 'not stated by the platform',
        method: x.method || null, listed: x.listed_by_provider ? 'yes' : 'not yet — seen on the balance ledger' }));
      const values = { transfers: rows.length };
      const kinds = { transfers: 'int' };
      for (const t of b.totals || []) {
        if (t.currency && t.currency !== 'AED') continue;
        const k = `${t.platform}_${t.fleet_id}_aed`; values[k] = num(t.total); kinds[k] = 'aed';
        const n = `${t.platform}_${t.fleet_id}_transfers`; values[n] = num(t.transfers); kinds[n] = 'int';
      }
      const totalAed = rows.filter((r) => r.amount_aed != null).reduce((s, r) => s + r.amount_aed, 0);
      if (rows.length) { values.total_aed = r2(totalAed); kinds.total_aed = 'aed'; }
      const silent = (b.coverage || []).filter((c) => !(b.totals || []).some((t) => t.platform === c.platform))
        .map((c) => `${c.platform}: ${c.publishes_payouts ? 'no transfer in these dates' : 'does not publish its payouts to this dashboard'}`);
      return { kind: 'table', definition, period: p, filters, source: '/api/finance/payouts',
        columns: [col('paid_on', 'Paid on', 'date'), col('platform', 'Platform', 'text'), col('fleet', 'Fleet', 'text'),
          col('amount_aed', 'Amount', 'aed'), col('settles', 'Settles', 'text'), col('method', 'Method', 'text'),
          col('listed', 'Listed by the platform', 'text')],
        rows, values, kinds,
        note: ['a transfer here is money that reached the company\'s bank on that date, from the platform\'s own books — it is not what drivers earned over a period',
          silent.length ? silent.join('; ') : null].filter(Boolean).join(' — ') };
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
const notFromLookup = (a) => ({ error: `driver_id ${a.driver_id ?? '(none)'} did not come from find_driver in this chat — call find_driver first` });
const normPlate = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/* Minutes past Dubai midnight as a clock; 1440 is the end of the day. */
const clock = (m) => (m == null ? null : m >= 1440 ? '24:00'
  : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const dayOfTs = (ts) => new Date(new Date(ts).getTime() + 4 * 3600_000).toISOString().slice(0, 10);
/* WHAT THE GATE BLANKED, IN WORDS (review, 2026-10-13). A field the shaper
   withheld arrives as null, and a null trip count summed is a zero: a Cash
   desk officer was told a driver took "0 trips". Every tool names the
   classes its figures rest on, and a figure resting on a blanked class is
   dropped rather than counted. */
const BLANK_WORDS = { BK: 'trip counts and trip times', LOC: 'places', COND: 'lateness and trip outcomes',
  CASH: 'cash figures', EARN: 'money figures', VEH: 'car details', ID: 'driver names' };
const blankedNote = (g, classes) => {
  const hit = classes.filter((c) => g?.blanked?.has(c));
  return hit.length ? `${hit.map((c) => BLANK_WORDS[c] || c).join(' and ')} are withheld from this person's role — say so; never read a withheld figure as zero or as not reported` : null;
};
/* Said on every hours result, because the absence it explains is the one a
   reader most easily mistakes for a fact about the driver. */
const HOURS_NOTE = 'online hours are Uber\'s own record of when the driver was logged in (or a platform\'s own daily figure where one files it); Uber is the only channel that reports log-ins, so a driver or a day with none was not reported, which is not zero and not a day off; on a job runs from the request to the drop-off, so it includes the drive to the rider; waiting = logged in and not on a job';
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
/* Which figures of a mixed result are one platform's: { online_hours: 'uber' }.
   The guard reads it (agent_guard.js) so "Uber" is true beside those figures
   and not beside the result's others. */
const UBER_FIGURES = (keys) => Object.fromEntries(keys.map((k) => [k, 'uber']));
function dubaiTime(ts) {
  if (!ts) return null;
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ts));
  } catch { return null; }
}
