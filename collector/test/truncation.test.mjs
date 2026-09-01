/* What does a page say when it is showing you part of the fleet?
   ─────────────────────────────────────────────────────────────────────────
   Every list in this product has a LIMIT on it, and it has to: a table of
   40,000 trips helps nobody. The danger is not the cap, it is the silence. A
   list of 100 drivers presented without a word reads as the roster, and a
   sentence computed over it — "6 of 100 people work more than one channel" —
   is not an approximation, it is a false statement about the fleet.

   Two of those were live when this file was written:

     - /api/drivers/cross-platform counted multi-platform people over the 150
       rows it returned. With more drivers than that in the window, the "of M"
       was the cap.

     - /api/recommendations returned the most recent 30 rows across all
       platforms and the page said "N of 30 targets are not being met" — a
       mixture of platforms at different depths of history, over a cap.

   So this seeds a fleet WIDER than every cap in the API and asks two things of
   every route: if a list came back at its cap, does the response say how many
   there really are; and are the population figures the pages quote measured
   over the population rather than over the page. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { seedFleet, WIDE_PLATES, WIDE_PEOPLE } from './fixture.mjs';
import { rebuildCustody } from '../src/custody.js';
import { mountAll, declaredRoutes } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const trips = await seedFleet(db, { wide: true });
await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });
const { get, server } = await mountAll(db);

const WIN = 'from=2026-08-01&to=2026-08-31';
const ARGS = {
  '/api/driver/profile': 'id=w-1', '/api/driver/kpis': 'id=w-1', '/api/driver/daily': 'id=w-1',
  '/api/driver/heatmap': 'id=w-1', '/api/driver/standing': 'id=w-1', '/api/driver/territory': 'id=w-1',
  '/api/driver/mix': 'id=w-1', '/api/driver/earnings': 'id=w-1', '/api/driver/quality': 'id=w-1',
  '/api/driver/trips': 'id=w-1', '/api/driver/custody': 'id=w-1', '/api/driver/vehicles': 'id=w-1&driver=w-1',
  '/api/vehicle/profile': 'plate=W00001', '/api/vehicle/kpis': 'plate=W00001',
  '/api/vehicle/daily': 'plate=W00001', '/api/vehicle/drivers-detail': 'plate=W00001',
  '/api/vehicle/movement': 'plate=W00001', '/api/vehicle/safety': 'plate=W00001', '/api/vehicle/trips': 'plate=W00001',
  '/api/vehicle/mix': 'plate=W00001',
  '/api/vehicle/drivers': 'plate=W00001', '/api/track': 'plate=W00001',
  '/api/map/journey': 'plate=W00001&day=2026-08-05', '/api/mix': 'by=payment',
  '/api/mix/detail': 'by=product', '/api/schema/raw-values': 'key=client&platform=hotel',
  '/api/corporate/property': 'id=h1', '/api/corporate/leakage': 'kind=complimentary',
  '/api/corporate/approach': 'by=driver', '/api/tiers/mix': 'by=daypart',
  '/api/day': 'day=2026-08-05', '/api/slot': 'dow=2&hour=19',
  '/api/segment': 'plate=W00001&at=2026-08-05T13:00:00Z',
};

/* Every cap that appears in a LIMIT in api/, read from the source. A list whose
   length is exactly one of these is a list that was almost certainly cut. */
const { readFileSync, readdirSync } = await import('node:fs');
const CAPS = new Set(readdirSync('api').filter((f) => f.endsWith('.js'))
  .flatMap((f) => [...readFileSync(`api/${f}`, 'utf8').matchAll(/LIMIT\s+(\d+)/g)]
    .map((m) => Number(m[1])))
  .filter((n) => n >= 10));

/* A sibling key that states the true size. Named rather than sniffed, because
   "n" and "count" appear on rows for other reasons and a loose rule here would
   pass everything. */
const SAYS_SO = /^(total|totals|people|shown|truncated|population|history|fleet_|n_peers|possible_days|window_trips|size|facet_totals|headline)/;

/* Lists whose length happens to equal a cap used somewhere else in api/, but
   which are not truncations at all. Each is a fixed span the route chooses
   deliberately, and each says so here rather than being silently tolerated by a
   looser rule that would let a real truncation through with it. */
const NOT_A_TRUNCATION = new Set([
  // The twelve days either side of the one being viewed. A window, not a page.
  '/api/day.versus_neighbours.series',
]);

const silent = [];
for (const route of declaredRoutes()) {
  if (ARGS[route] === null) continue;
  const path = route.replace(/:(\w+)/g, 'w-1');
  const extra = ARGS[route] ? `&${ARGS[route]}` : '';
  const { status, body } = await get(`${path}?${WIN}${extra}`);
  if (status >= 400 || body == null) continue;
  /* Ancestors, not just the immediate parent. A facet list sits at
     `.facets.plate` and its population count is `facet_totals` beside `facets`
     — one level further up — so a parent-only rule reported an honest response
     as silent, which is the way a check gets ignored. */
  const walk = (o, at = '', up = []) => {
    if (o == null || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      const rows = o.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (rows.length && CAPS.has(o.length)) {
        const says = up.some((anc) => Object.keys(anc).some((k) => SAYS_SO.test(k)));
        if (!says && !NOT_A_TRUNCATION.has(`${route}${at}`)) {
          silent.push(`${route}${at}  ${o.length} rows, no population figure beside it`);
        }
      }
      return o.forEach((x) => walk(x, `${at}[]`, []));
    }
    for (const [k, v] of Object.entries(o)) walk(v, `${at}.${k}`, [o, ...up]);
  };
  walk(body);
}
check('no list comes back at its cap without saying how many there really are',
  silent.length === 0, silent.length ? `\n      ${silent.join('\n      ')}` : '');

/* ── the two sentences that were false ─────────────────────────────────── */
{
  const x = (await get(`/api/drivers/cross-platform?${WIN}`)).body;
  check('the cross-platform panel counts people over the fleet, not over its own page',
    x.people === WIDE_PEOPLE, `${x.people} vs ${WIDE_PEOPLE} seeded`);
  check('and says how many of them it is showing',
    x.shown === (x.drivers || []).length && x.truncated === true,
    `${x.shown} shown, truncated=${x.truncated}`);
  check('and its multi-platform count is over the fleet too',
    x.multi_platform >= 0 && x.multi_platform <= x.people,
    `${x.multi_platform} of ${x.people}`);
}
{
  const r = (await get('/api/recommendations')).body;
  const seen = new Set((r.rows || []).map((x) => `${x.platform}|${x.rec_type}`));
  check('the recommendations list is one row per platform and target, so it cannot be truncated',
    seen.size === (r.rows || []).length && r.truncated === false,
    `${seen.size} distinct of ${(r.rows || []).length}`);
}
{
  const lb = (await get(`/api/drivers/leaderboard?${WIN}`)).body;
  check('the ranking knows how many people it is ranking',
    lb.people === WIDE_PEOPLE, `${lb.people} vs ${WIDE_PEOPLE}`);
  check('and says it is showing part of them',
    lb.truncated === true && lb.shown < lb.people, `${lb.shown} of ${lb.people}`);
  const names = (lb.rows || []).map((x) => x.driver_name);
  check('and nobody appears on it twice',
    new Set(names).size === names.length, `${names.length} rows, ${new Set(names).size} people`);
}
{
  /* The day page's tables are capped at 120 and its headline counts the whole
     day, so the two must not be read as the same number. */
  const d = (await get('/api/day?day=2026-08-05')).body;
  check('the day headline counts every vehicle that moved, not the ones the table shows',
    d.headline.vehicles >= d.vehicles.length, `${d.headline.vehicles} vs ${d.vehicles.length}`);
  check('and every person who drove',
    d.headline.drivers >= d.drivers.length, `${d.headline.drivers} vs ${d.drivers.length}`);
}
{
  /* Platform-reported performance: 240 people over four weekly periods is 960
     rows against a 300-row cap. This is the exact state the real fleet entered
     the moment the Uber collector was fixed — a period used to hold ten drivers
     because that was all the collector could see, and started holding a hundred
     and fifty, so the first 300 rows became two periods rather than a year of
     them. The list looked identical before and after: no error, no gap, just
     fourteen periods that quietly stopped being in it. */
  const pf = (await get(`/api/drivers/performance?${WIN}`)).body;
  check('the performance list is truncated at this scale, so the next checks mean something',
    pf.truncated === true && (pf.rows || []).length < pf.totals.total,
    `${pf.shown} of ${pf.totals?.total}`);
  check('and it says how many records, people and periods there really are',
    pf.totals.total >= 900 && pf.totals.people === WIDE_PEOPLE && pf.totals.periods >= 4,
    JSON.stringify(pf.totals));
  check('and lists every period, so a period cut from the rows is still visible',
    (pf.periods || []).length >= 4, String((pf.periods || []).length));
  check('the earnings total is over every record, not over the page',
    Number(pf.totals.earnings) > (pf.rows || []).reduce((a, r) => a + Number(r.earnings || 0), 0),
    `${pf.totals.earnings} vs the page`);
}
{
  // The vehicle directory is the fleet's asset register; missing a car from it
  // is the one thing it must not do.
  const dir = (await get(`/api/vehicles/directory?${WIN}`)).body;
  check('the vehicle directory covers the whole fleet, not a page of it',
    dir.length === WIDE_PLATES, `${dir.length} of ${WIDE_PLATES}`);
}

console.log(`\n  ${WIDE_PLATES} vehicles, ${WIDE_PEOPLE} people, ${trips} trips, `
  + `${CAPS.size} distinct caps in api/`);
/* ── a window wider than the record must not be answered in full ──────────
   The daily series fills the calendar deliberately: a day nobody collected and
   a day nobody drove are different facts, and drawing only the days that have
   rows turned a 124-day collection hole into two touching bars. But it filled
   the REQUESTED window, so a request from 2000 to 2100 answered with 36,526
   rows — 368 of which had any trips — and 7.9MB of zeros, enough to stall the
   browser it was drawn in. There was no fleet in 2000, and a row saying it took
   no trips that day is not a fact about anything. */
{
  const wide = (await get('/api/trips/daily?from=2000-01-01&to=2100-01-01')).body;
  const rows = Array.isArray(wide) ? wide : (wide?.rows || []);
  check('a hundred-year window does not answer with a hundred years of zeros',
    rows.length < 2000, `${rows.length} rows`);
  /* And the fill still happens inside the record, which is the whole reason it
     exists — clamping must not have turned it into "only the days with rows".
     Contiguity is the property, not the presence of an empty day: this fixture
     has data on every day it covers, so counting empties would test the fixture
     rather than the endpoint. A series with a day missing from the middle is
     what the fill exists to prevent. */
  /* At the DAY grain, which is what an absent `grain` means — deliberately, so
     that every caller written before the grain existed keeps the shape it
     already parses. A hundred-year window asked with `grain=auto` comes back
     in months, and months are not one day apart. */
  const dayMs = 864e5;
  const gaps = rows.slice(1).filter((r, i) =>
    (Date.parse(String(r.d)) - Date.parse(String(rows[i].d))) !== dayMs);
  check('but the calendar is still filled, so the series has no missing day in it',
    rows.length > 1 && gaps.length === 0,
    `${rows.length} rows, ${gaps.length} discontinuities`);


  /* And the same property one grain up: a bucketed series must be contiguous
     in BUCKETS. A month missing from the middle of a monthly series is the
     identical failure the daily fill exists to prevent, and nothing else in
     the suite would have noticed it. */
  const monthly = (await get('/api/trips/daily?from=2000-01-01&to=2100-01-01&grain=auto')).body;
  const mrows = Array.isArray(monthly) ? monthly : (monthly?.rows || []);
  check('a century asked with auto grouping comes back in months, not days',
    mrows.length > 0 && mrows.every((r) => r.grain === 'month'), `${mrows.length} rows`);
  const mgaps = mrows.slice(1).filter((r, i2) => {
    const a = new Date(`${mrows[i2].d}T00:00:00Z`), b = new Date(`${r.d}T00:00:00Z`);
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) !== 1;
  });
  check('…and every month between the first and the last is present',
    mgaps.length === 0, `${mrows.length} buckets, ${mgaps.length} discontinuities`);

  /* Bounded by span, not clamped to the DATA. The trailing days of a window
     showing "nothing recorded" is how a collector that stopped three days ago
     becomes visible, so the fill must still run past the last day that has
     rows — clamping to the record was the first attempt and hid exactly that.

     This used to be pinned as `last === '2100-01-01'`, which is the property
     restated as the literal it happened to produce — and that literal WAS the
     bug. An open window is [2000-01-01, 2100-01-01], the 800-day cap
     subtracted from its upper end, and the calendar generated ran 2097-10-23
     to 2100-01-01: past the last day with data, technically satisfying the
     assertion, and matching no row at all. Production answered all-time with
     28 empty month buckets over a fleet holding 312,762 bookings.

     Today is the honest upper anchor. It is always at or after the last day
     with data, so a stopped collector still shows as a run of empty days, and
     it never generates a decade that has not happened. */
  const lastDay = String(rows[rows.length - 1].d).slice(0, 10);
  const withData = rows.filter((r) => (r.trips || 0) > 0);
  const lastWithData = String(withData[withData.length - 1]?.d || '').slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  check('the series still runs past the last day with data, so a stopped collector shows',
    withData.length > 0 && lastDay > lastWithData,
    `series ends ${lastDay}, data ends ${lastWithData}`);
  check('and stops at today rather than a century that has not happened yet',
    lastDay === today, `${lastDay} vs ${today}`);
  check('and is cut at the far end instead, where there was no fleet to report on',
    rows.length <= 801, `${rows.length} rows`);
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close(); await db.close();
process.exit(fail ? 1 : 0);
