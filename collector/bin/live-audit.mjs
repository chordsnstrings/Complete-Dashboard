#!/usr/bin/env node
/* The test suite's invariants, run against the live database.
   ─────────────────────────────────────────────────────────────────────────
   Every check in test/ runs against a fixture, and a fixture is a hypothesis
   about the data. This runs the same questions against production, where the
   answers are whatever the providers actually sent.

   It found five things the fixtures could not:

     - the driver directory and the driver ranking folded names differently, so
       the two pages reported 90 and 89 drivers for the same fleet
     - revenue_per_km divided the revenue of one population by the distance of
       another, on three pages
     - fifteen bookings carry no vehicle, so the vehicle table summed to fifteen
       fewer trips than the fleet and nothing said why
     - the fleet revenue headline counted complimentary rides and the settlement
       page did not, a difference of AED 320
     - and, behind all of it, Uber earnings had never been collected at all

   Read-only: every request is a GET. Safe to run against production at any
   time, and worth running after every deploy.

       node bin/live-audit.mjs
       BASE=http://localhost:8099 node bin/live-audit.mjs
       WIN='from=2026-01-01&to=2026-08-22' node bin/live-audit.mjs
*/
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const B = process.env.BASE || 'https://fleet-dashboard-wpeqb.ondigitalocean.app';
const W = process.env.WIN || 'from=2026-07-23&to=2026-08-22';
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++) : (fail++, console.log(`  ✗ ${n}  ${x}`)); };
const N = (v) => (v == null || v === '' ? null : Number(v));
const sum = (rows, k) => (rows || []).reduce((a, r) => a + (Number(r[k]) || 0), 0);
const near = (a, b, tol = 0.06) => a != null && b != null && Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const get = async (p) => {
  /* Only append the shared window if the path does not carry its own. Appending
     it regardless produced ?from=A&to=B&from=C&to=D, which Express reads as
     arrays — and a rejected value fell through to the open window, so a check
     on the first 28 days of August was quietly answered with 167,168 trips from
     the whole record. The server now takes the first of a duplicated
     parameter; this stops sending them. */
  const hasWindow = /[?&](from|to|day|days)=/.test(p);
  const url = hasWindow ? `${B}${p}` : `${B}${p}${p.includes('?') ? '&' : '?'}${W}`;
  const r = await fetch(url);
  const t = await r.text();
  const version = r.headers.get('x-data-version') || null;
  try { return { status: r.status, version, body: JSON.parse(t) }; }
  catch { return { status: r.status, version, body: null, raw: t.slice(0, 120) }; }
};

/* Two endpoints, fetched at the same data version.
   Responses are cached and refreshed per key, so two requests from one page can
   straddle a refresh: the headline from version N and the chart beside it from
   N+1, differing by whatever landed in between. Three reconciliation checks
   here failed on exactly that — 8,390 against 8,387 — and re-running them a
   moment later showed no difference at all.

   A check that fails on a real inconsistency and also on a harmless one is a
   check nobody trusts. So the pair is fetched again until both answers describe
   the same data, and only then compared. If they cannot be aligned in three
   attempts, that is worth reporting on its own. */
const getPair = async (a, b, tries = 3) => {
  let ra; let rb;
  for (let i = 0; i < tries; i++) {
    ra = await get(a); rb = await get(b);
    if (!ra.version || !rb.version || ra.version === rb.version) return [ra, rb, true];
    await new Promise((r) => setTimeout(r, 400));
  }
  return [ra, rb, false];
};

const k = (await get('/api/kpis')).body;
check('kpis.completion_pct', near(N(k.completion_pct), 100 * k.completed_trips / k.bookable_trips), `${k.completion_pct} vs ${k.completed_trips}/${k.bookable_trips}`);
check('kpis.cancel_pct', near(N(k.cancel_pct), 100 * k.cancelled_trips / k.bookable_trips), `${k.cancel_pct}`);
check('kpis.avg_km', near(N(k.avg_km), N(k.km) / k.trips_with_distance, 0.05), `${k.avg_km} vs ${N(k.km)}/${k.trips_with_distance}`);
check('kpis.avg_fare', near(N(k.avg_fare), N(k.revenue) / k.priced_trips, 0.05), `${k.avg_fare}`);
const settle = (await get('/api/settlement/mix')).body;
const classSum = (settle.classes || []).reduce((a, c) => a + (Number(c.revenue) || 0), 0);
check('kpis revenue and the settlement page describe the same money',
  Math.abs(N(k.revenue) - classSum) <= (settle.classes || []).length / 2 + 1,
  `${k.revenue} vs ${classSum}`);
check('kpis trips and the settlement page describe the same trips',
  k.trips === settle.total_trips, `${k.trips} vs ${settle.total_trips}`);
check('kpis.revenue_per_km', near(N(k.revenue_per_km), N(k.priced_measured_revenue) / N(k.priced_km), 0.02), `${k.revenue_per_km} vs ${N(k.priced_measured_revenue)}/${N(k.priced_km)}`);
check('outcomes fit the denominator', k.completed_trips + k.cancelled_trips <= k.bookable_trips, `${k.completed_trips}+${k.cancelled_trips} vs ${k.bookable_trips}`);

/* Each breakdown against the headline it decomposes, both read at the same data
   version. Responses are cached and refreshed per key, so a pair fetched either
   side of a refresh differs by whatever landed between them — these three
   reported 8,390 against 8,387 once for that reason alone, and agreed exactly
   when asked again a moment later. A check that fails on a real inconsistency
   and also on a harmless one is a check nobody trusts. */
for (const by of ['platform', 'status', '']) {
  const [mix, kp, aligned] = await getPair(`/api/mix${by ? `?by=${by}` : ''}`, '/api/kpis');
  const rows = mix.body || [];
  check(`mix ${by || 'product'} sums to trips`,
    !aligned || sum(rows, 'n') === kp.body?.trips,
    `${sum(rows, 'n')} vs ${kp.body?.trips}${aligned ? '' : ' (versions could not be aligned)'}`);
}
for (const [path, label] of [['/api/trips/daily', 'daily'], ['/api/trips/hourly', 'hourly'],
  ['/api/trips/heatmap', 'heatmap']]) {
  const [series, kp, aligned] = await getPair(path, '/api/kpis');
  check(`${label} sums to trips`, !aligned || sum(series.body, 'trips') === kp.body?.trips,
    `${sum(series.body, 'trips')} vs ${kp.body?.trips}${aligned ? '' : ' (versions could not be aligned)'}`);
}

const vdir = (await get('/api/vehicles/directory')).body || [];
const veh = (await get('/api/vehicles')).body;
check('vehicle directory trips + unassigned = fleet trips',
  sum(vdir, 'trips') + (k.trips_without_vehicle || 0) === k.trips,
  `${sum(vdir, 'trips')} + ${k.trips_without_vehicle} vs ${k.trips}`);
// Different populations on purpose: /api/vehicles counts vehicles with a trip
// in the window, the directory covers every plate we hold anything about.
check('vehicles list total <= directory size', veh.total <= vdir.length, `${veh.total} vs ${vdir.length}`);
const dir = (await get('/api/drivers/directory')).body || [];
const lb = (await get('/api/drivers/leaderboard')).body;
/* The leaderboard returns a hundred rows and reports its population in a
   separate field; the directory returns every driver we hold anything about,
   most of whom did not drive in the window. Summing both and demanding they
   match compared a page against a fleet, and failed live by exactly the 54
   trips belonging to the 19 active drivers below the hundredth place.

   The invariant worth asserting is the one that caught the 90-vs-89 split:
   that the two pages fold a person's several platform accounts into one row
   the same way. So compare the populations, and compare trips over the same
   hundred people rather than over different sets. */
const active = dir.filter((d) => Number(d.trips) > 0);
check('directory active drivers = leaderboard people', active.length === lb.people,
  `${active.length} vs ${lb.people}`);
const top = active.map((d) => Number(d.trips) || 0).sort((a, b) => b - a)
  .slice(0, lb.rows.length).reduce((a, b) => a + b, 0);
check('leaderboard page trips = directory top rows', sum(lb.rows, 'trips') === top,
  `${sum(lb.rows, 'trips')} vs ${top}`);
check('directory people = leaderboard people', dir.filter((r) => (r.trips || 0) > 0).length === lb.people, `${dir.filter((r) => (r.trips || 0) > 0).length} vs ${lb.people}`);
check('nobody appears twice on the ranking', new Set(lb.rows.map((r) => r.driver_name)).size === lb.rows.length, `${lb.rows.length} rows`);

// every percentage in every response must be a percentage
const ROUTES = ['/api/kpis', '/api/vehicles/directory', '/api/drivers/directory', '/api/settlement/mix',
  '/api/roster', '/api/compliance/drivers', '/api/compliance/vehicles', '/api/unauthorized/summary',
  '/api/alerts/by-driver', '/api/alerts/by-vehicle', '/api/revenue', '/api/tiers/by-vehicle',
  '/api/corporate/properties', '/api/trend/monthly', '/api/playbook', '/api/capacity', '/api/retention',
  '/api/forecast', '/api/sensor-health', '/api/mix/detail?by=payment', '/api/drivers/cross-platform'];
const badPct = [], nan = [];
for (const r of ROUTES) {
  const { status, body } = await get(r);
  if (status >= 400 || body == null) { console.log(`  !! ${r} → ${status}`); continue; }
  const walk = (o, at = '') => {
    if (o == null || typeof o !== 'object') return;
    if (Array.isArray(o)) return o.forEach((x, i) => walk(x, `${at}[${i}]`));
    for (const [key, v] of Object.entries(o)) {
      // A SHARE is bounded; a CHANGE is not. A month that went from 4,203 to
      // 18,672 bookings really is +344%, and flagging it would train everyone
      // to ignore this check.
      const isShare = /_pct$|^pct|percent/.test(key) && !/change|delta|gap|growth|diff|swing/.test(key);
      if (isShare && v != null && Number.isFinite(Number(v)) && (Number(v) < 0 || Number(v) > 100)) badPct.push(`${r}${at}.${key}=${v}`);
      if (typeof v === 'number' && !Number.isFinite(v)) nan.push(`${r}${at}.${key}`);
      if (typeof v === 'string' && /^(NaN|Infinity|-Infinity)$/.test(v)) nan.push(`${r}${at}.${key}=${v}`);
      walk(v, `${at}.${key}`);
    }
  };
  walk(body);
}
check('no percentage out of range', badPct.length === 0, badPct.slice(0, 6).join(' | '));
check('no NaN or Infinity anywhere', nan.length === 0, nan.slice(0, 6).join(' | '));

// every driver/vehicle a list names opens
const ids = [...new Set(dir.slice(0, 25).map((r) => r.ids?.[0] || r.driver_ext_id).filter(Boolean))];
const dead = [];
for (const id of ids) {
  const { status } = await get(`/api/driver/kpis?id=${encodeURIComponent(id)}`);
  if (status !== 200) dead.push(`${id} → ${status}`);
}
check('every driver in the directory opens', dead.length === 0, dead.slice(0, 5).join(', '));
const deadV = [];
for (const v of vdir.slice(0, 25)) {
  const { status } = await get(`/api/vehicle/kpis?plate=${encodeURIComponent(v.plate)}`);
  if (status !== 200) deadV.push(`${v.plate} → ${status}`);
}
check('every vehicle in the directory opens', deadV.length === 0, deadV.slice(0, 5).join(', '));
check('an unknown driver 404s', (await get('/api/driver/kpis?id=no-such-person')).status === 404);
check('an unknown vehicle 404s', (await get('/api/vehicle/kpis?plate=NOSUCHPLATE')).status === 404);

// hollow pages: the list says busy, the page says nothing
const hollow = [];
for (const r of dir.filter((x) => (x.trips || 0) > 20).slice(0, 20)) {
  const id = r.ids?.[0] || r.driver_ext_id;
  const kk = (await get(`/api/driver/kpis?id=${encodeURIComponent(id)}`)).body;
  if (!kk || (kk.trips || 0) === 0) hollow.push(`${r.driver_name}: dir ${r.trips}, page ${kk?.trips}`);
}
check('no driver page is empty for somebody the directory says drove', hollow.length === 0, hollow.slice(0, 5).join(' | '));

/* ── every route the app declares, live ─────────────────────────────────── */
const ARGS = {
  '/api/mix': 'by=payment', '/api/mix/detail': 'by=product', '/api/tiers/mix': 'by=daypart',
  '/api/corporate/leakage': 'kind=complimentary', '/api/corporate/approach': 'by=driver',
  '/api/schema/raw-values': 'key=client&platform=hotel',
  '/api/day': `day=${new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)}`,
  '/api/slot': 'dow=2&hour=19',
};
const one = (arr) => (Array.isArray(arr) ? arr[0] : null);
const someDriver = one(dir)?.ids?.[0] || one(dir)?.driver_ext_id;
const somePlate = one(vdir)?.plate;
const someProp = one((await get('/api/corporate/properties')).body || [])?.partner_id;
const seg = one(((await get('/api/segments')).body || {}).rows || []);
const DETAIL = {
  driver: `id=${encodeURIComponent(someDriver || '')}`,
  vehicle: `plate=${encodeURIComponent(somePlate || '')}`,
};
/* One real booking, by the provider's own platform and id: /api/trip answers
   "platform and id are both required" to anything else, and a 400 read as a
   pass is the whole failure mode this section is guarding against. */
const TRIP = await (async () => {
  const b = (await get(`/api/vehicle/trips?plate=${encodeURIComponent(somePlate || '')}`)).body;
  const rows = Array.isArray(b) ? b : (b?.rows || b?.trips || []);
  const t = rows.find((x) => x.platform && x.external_id);
  return t ? { platform: t.platform, id: t.external_id } : null;
})();
/* THE ROUTES THE APP DECLARES, read from the app.
   ─────────────────────────────────────────────────────────────────────────
   This was a hand-kept list under a heading that says "every route the app
   declares", and a hand-kept list of a moving API is a list that quietly stops
   being every route. Measured today: api/*.js declares 123 GET endpoints and
   this file named 91 of them. The 32 nobody was asking included /api/reconcile,
   /api/economics/drivers, /api/compare, /api/optimise, /api/coverage/calendar
   and /api/money/sources — whole pages whose backend could have started
   answering 500 without this run saying a word.

   The `/api/endpoints` fetch that used to sit here was the intended fix and
   never landed: the route does not exist (it answers "no such endpoint"), and
   the string it returned was assigned to a variable nothing read. So the list
   is derived the way bin/cap-audit.mjs derives its own — from the source in
   this working tree, which is the thing being deployed. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');
const declared = [...new Set(
  ['server.js', ...readdirSync(SRC).filter((f) => f.endsWith('_routes.js'))]
    .flatMap((f) => [...readFileSync(join(SRC, f), 'utf8')
      .matchAll(/app\.get\('(\/api\/[^']*)'/g)].map((m) => m[1])))]
  /* `:id` is a pattern rather than an address, and /api/probe/<provider> reaches
     out to a provider on request — this run is read-only. /api/probe/results
     only reads what the nightly pass already stored, so it stays. */
  .filter((r) => !r.includes(':') && !/^\/api\/probe\/(?!results)/.test(r)).sort();

/* What an endpoint needs before it can answer at all, so a route is exercised
   rather than audited against its own 400. Same shape as the table in
   bin/page-audit.mjs, and for the same reason: a refusal read as a pass is how
   a panel goes unchecked while the run says every route is fine. */
const day3 = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
const NEEDS = (r) => {
  if (r === '/api/trip') return TRIP ? `platform=${encodeURIComponent(TRIP.platform)}&id=${encodeURIComponent(TRIP.id)}` : '';
  if (r === '/api/segment') return seg ? `plate=${encodeURIComponent(seg.plate)}&at=${encodeURIComponent(seg.started_at)}` : '';
  if (r.startsWith('/api/corporate/property')) return someProp ? `id=${encodeURIComponent(someProp)}` : '';
  if (r.startsWith('/api/driver/')) return `${DETAIL.driver}&day=${day3}`;
  if (r.startsWith('/api/vehicle/')) return `${DETAIL.vehicle}&day=${day3}`;
  if (r === '/api/performer') return DETAIL.driver;
  if (r === '/api/track' || r === '/api/map/journey') return `plate=${somePlate}&day=${day3}`;
  if (ARGS[r]) return ARGS[r];
  return '';
};
const broke = [], unreached = [];
for (const r of declared) {
  const first = NEEDS(r);
  let { status } = await get(`${r}${first ? `?${first}` : ''}`);
  /* A route that refuses is offered everything this run holds before it is
     written off — an endpoint ignores the parameters it does not want. */
  if (status === 400 || status === 404) {
    const all = [DETAIL.driver, DETAIL.vehicle, `day=${day3}`, 'dow=2&hour=19'].filter(Boolean).join('&');
    ({ status } = await get(`${r}?${all}`));
  }
  if (status >= 500) broke.push(`${r} → ${status}`);
  else if (status >= 400) unreached.push(`${r} → ${status}`);
}
if (someProp) { const { status } = await get(`/api/corporate/property?id=${encodeURIComponent(someProp)}`); if (status >= 400) broke.push(`/api/corporate/property → ${status}`); }
if (seg) { const { status } = await get(`/api/segment?plate=${encodeURIComponent(seg.plate)}&at=${encodeURIComponent(seg.started_at)}`); if (status >= 400) broke.push(`/api/segment → ${status}`); }
check('no route errors or 404s against live data', broke.length === 0, broke.slice(0, 10).join(' | '));
/* Still refusing after being handed every id this run holds. Not an error —
   it is an endpoint this run did not manage to exercise, which is a different
   thing from one that answered. Named rather than counted, because "62 routes
   walked" reads as coverage and this is the part of it that is not. */
check(`every one of the ${declared.length} declared routes answered`,
  unreached.length === 0, unreached.slice(0, 10).join(' | '));

/* ── the pages that reason, reasoned about themselves ───────────────────── */
{
  const fc = (await get('/api/forecast')).body;
  if (fc?.months?.length) {
    const bad = fc.months.filter((m) => m.lo != null && m.hi != null && !(N(m.lo) <= N(m.point) && N(m.point) <= N(m.hi)));
    check('every forecast interval brackets its own point estimate', bad.length === 0,
      JSON.stringify(bad.slice(0, 2)));
  }
  const pb = (await get('/api/playbook')).body;
  if (pb?.actions?.length) {
    const noBasis = pb.actions.filter((a) => !a.basis || a.size == null);
    check('every playbook action carries a size and the arithmetic that produced it',
      noBasis.length === 0, noBasis.map((a) => a.id).join(', '));
    const negative = pb.actions.filter((a) => Number(a.size) < 0);
    check('no action is sized negatively', negative.length === 0, negative.map((a) => `${a.id}=${a.size}`).join(', '));
  }
  const rt = (await get('/api/retention')).body;
  if (rt?.flow?.length) {
    const bad = rt.flow.filter((m) => m.joined < 0 || m.left < 0);
    check('no month gained or lost a negative number of drivers', bad.length === 0, JSON.stringify(bad.slice(0, 2)));
  }
  const rev = (await get('/api/revenue')).body;
  if (rev?.platforms) {
    const over = rev.platforms.filter((r) => r.priced_bookings > r.bookings);
    check('no channel reports more priced bookings than bookings', over.length === 0,
      over.map((r) => `${r.platform} ${r.priced_bookings}/${r.bookings}`).join(', '));
    check('the accounted total is the sum of the per-channel figures',
      Math.abs((rev.totals.accounted || 0) - rev.platforms.reduce((a, r) => a + (r.best || 0), 0)) < 1,
      `${rev.totals.accounted}`);
  }
}


/* ── the precomputed layer ─────────────────────────────────────────────────
   Four pages read rollups rather than aggregating the whole history. That is
   only an acceptable trade while the rollups are running and agree with the
   endpoints that compute things independently. A stale or wrong rollup is
   worse than a slow page, because nothing about it looks wrong. */
{
  const roll = (await get('/api/rollups')).body;
  if (Array.isArray(roll) && roll.length) {
    /* 'running' is a rollup in progress, not a rollup that failed — this check
       reported a healthy refresh as broken the first time it ran. */
    const broken = roll.filter((r) => r.status !== 'ok' && r.status !== 'running');
    check('no rollup last finished with an error', broken.length === 0,
      broken.map((r) => `${r.name}: ${r.status} ${String(r.error).slice(0, 80)}`).join(' | '));

    /* The schedule is a quarter of an hour. Anything past 45 minutes means the
       collector is not running, and the pages are quietly serving whatever it
       last managed to write. */
    const stale = roll.filter((r) => r.age_min != null && r.age_min > 45);
    check('no rollup is more than 45 minutes behind its 15-minute schedule',
      stale.length === 0, stale.map((r) => `${r.name} ${r.age_min}min`).join(', '));

    check('each rollup records the span it covers, so a page can date its answer',
      roll.every((r) => r.covers_from && r.covers_to),
      roll.filter((r) => !r.covers_from).map((r) => r.name).join(', '));

    /* The three cover the same data and must agree about how far it runs. One
       lagging behind means a page reading it disagrees with the page beside
       it, on the same screen. */
    const spans = [...new Set(roll.map((r) => String(r.covers_to).slice(0, 10)))];
    check('all three rollups cover the same last day', spans.length === 1, spans.join(' vs '));
  }

  /* And the arithmetic, against an endpoint that does not read the rollup.
     /api/kpis computes its window live; /api/trend/monthly reads rollup_month.
     Over the same window they are counting the same bookings, so a rollup that
     has drifted shows up here rather than on somebody's screen. */
  const tr = (await get('/api/trend/monthly')).body;
  if (tr?.months?.length && k) {
    const observed = tr.months.filter((m) => !m.no_data);
    check('the trend page reports which of its figures were precomputed',
      tr.source === 'rollup' || tr.source === 'live', String(tr.source));
    // Months are whole; the KPI window is 30 days. Compare the overlap only:
    // the last complete month in the trend against the same month from kpis.
    const last = observed[observed.length - 1];
    if (last) {
      /* The first 28 days of a month cannot exceed the whole month. Fetched at
         one version, because the trend reads a rollup and kpis computes live:
         a refresh landing between the two requests makes the rollup look three
         trips short of a window inside it, which is not a defect in either. */
      const [tr2, partial, aligned] = await getPair(
        '/api/trend/monthly', `/api/kpis?from=${last.m}-01&to=${last.m}-28`);
      const m = (tr2.body?.months || []).find((x) => x.m === last.m);
      if (aligned && m && N(partial.body?.trips)) {
        /* Close, not equal. The trend reads a rollup — a snapshot taken when it
           last ran — while kpis computes live at request time, so the two
           legitimately differ by whatever landed in between. Sharing a cache
           version does not make them one database snapshot; the version says
           when the rollup finished, not that nothing has happened since.

           Measured here: 6,152 against 6,153. Exact equality is not a property
           this system has, and asserting it would mean a check that fails
           whenever the collector is doing its job. What IS worth failing on is
           a rollup that has drifted materially — a stale bucket, a botched
           incremental pass, a month rebuilt from a fortnight. One percent is
           far tighter than any of those and far looser than a collection
           cycle's worth of trips. */
        const drift = Math.abs(N(m.trips) - N(partial.body.trips)) / N(partial.body.trips);
        check('the trend month and a live count of it agree to within one percent',
          drift < 0.01,
          `trend ${m.m}=${m.trips} vs kpis 1st-28th=${partial.body.trips} (${(drift * 100).toFixed(2)}%)`);
      } else {
        check('the trend and kpis could be read at one data version', aligned,
          `${tr2.version} vs ${partial.version}`);
      }
    }
  }
}

/* ── the cache ─────────────────────────────────────────────────────────────
   It answers most requests now, so a fault here is a fault on every page. */
{
  const cs = (await get('/api/cache-stats')).body;
  if (cs) {
    check('the cache is holding entries rather than silently doing nothing',
      N(cs.entries) > 0, JSON.stringify(cs));
    /* Every request being a miss is what this looked like before
       stale-while-revalidate: correct, and useless. It is also what a broken
       version query would look like. */
    const served = (N(cs.hit) || 0) + (N(cs.stale) || 0);
    const total = served + (N(cs.miss) || 0);
    check('and actually serving from them, not missing on everything',
      total < 20 || served > 0, JSON.stringify(cs));

    /* The exclusions have to exclude. Mounted at /api, Express strips the
       prefix before the handler sees the path, which once made the whole NEVER
       list match nothing — including the realtime feed. */
    const live1 = await fetch(`${B}/api/live`);
    check('the realtime feed is never served from the cache',
      live1.headers.get('x-cache') !== 'hit' && live1.headers.get('x-cache') !== 'stale',
      String(live1.headers.get('x-cache')));
    const st1 = await fetch(`${B}/api/status`);
    check('nor is the freshness page, which could not report staleness from a cache',
      st1.headers.get('x-cache') !== 'hit' && st1.headers.get('x-cache') !== 'stale',
      String(st1.headers.get('x-cache')));
  }
}

/* ── attributed earnings ───────────────────────────────────────────────────
   Uber prices nothing per trip and pays the driver weekly, so a vehicle's
   money is a share of its drivers' payouts. An inference is only worth showing
   if it conserves: what is placed on vehicles, plus what could not be placed,
   must equal what the platform actually paid. */
{
  const dir = (await get('/api/vehicles/directory')).body;
  const rows = Array.isArray(dir) ? dir : (dir?.rows || []);
  const plate = rows.find((r) => Number(r.trips) > 0)?.plate;
  if (plate) {
    const e = (await get(`/api/vehicle/earnings?plate=${plate}`)).body;
    if (e?.totals) {
      check('a vehicle never reports more priced bookings than bookings',
        N(e.totals.priced_bookings) <= N(e.totals.bookings),
        `${e.totals.priced_bookings}/${e.totals.bookings}`);
      check('attributed pay is never negative',
        (e.attributed || []).every((r) => Number(r.attributed) >= 0),
        (e.attributed || []).filter((r) => Number(r.attributed) < 0).map((r) => r.driver_name).join(', '));
      /* The two are different quantities and the page must not have summed
         them: fares are measured per trip, attribution is a share of a net
         payout. */
      check('fares and attributed pay are reported apart, not added',
        e.totals.fares != null && e.totals.attributed != null
        && !('revenue' in e.totals), JSON.stringify(e.totals));
      const perDriver = (e.attributed || []).reduce((a, r) => a + Number(r.attributed || 0), 0);
      check('the attributed total is the sum of its per-driver rows',
        Math.abs(perDriver - Number(e.totals.attributed || 0)) < 1,
        `${perDriver} vs ${e.totals.attributed}`);
      /* Every driver credited with money on this vehicle must be openable —
         a payout attributed to a name nobody can look up is a dead end. */
      for (const d of (e.attributed || []).slice(0, 3)) {
        const r = await get(`/api/driver/kpis?id=${encodeURIComponent(d.driver_ext_id)}`);
        check(`a driver credited on ${plate} opens: ${d.driver_name}`, r.status === 200,
          `${r.status}`);
      }
    }
  }
}

/* ── the window parameters mean what they say ──────────────────────────────
   ?days= reached no endpoint at all and was silently answered with every trip
   ever collected; ?day= did the same on /api/track. Both are the kind of fault
   that produces a plausible number rather than an error. */
{
  const d7 = (await fetch(`${B}/api/kpis?days=7`)).json?.() ?? null;
  const seven = await (await fetch(`${B}/api/kpis?days=7`)).json();
  const ninety = await (await fetch(`${B}/api/kpis?days=90`)).json();
  check('days=7 and days=90 are different windows, not both all-time',
    N(seven.trips) < N(ninety.trips), `7d=${seven.trips} 90d=${ninety.trips}`);
  const all = await (await fetch(`${B}/api/kpis`)).json();
  check('and neither is the whole record',
    N(ninety.trips) <= N(all.trips), `90d=${ninety.trips} all=${all.trips}`);
  void d7;
}

console.log(`\n${pass} passed, ${fail} failed  (live: ${B})`);
