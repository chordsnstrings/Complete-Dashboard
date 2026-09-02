/* TODAY IS NOT A DAY YET.
   ─────────────────────────────────────────────────────────────────────────
   One root cause, four figures. A window whose last day is still being
   collected was read as a complete observation, so a 15-hour day was averaged,
   ranked and correlated against 24-hour ones.

   Every fixture below is production's own, measured 2026-09-02 over the window
   Sep 1–2 (Sep 2 is today):

     /api/trips/daily     Sep 1 = 662 bookings, Sep 2 = 361 so far
     /api/trips/hourly    08:00 = 91, 18:00 = 59
     /api/trips/heatmap   Tue (dow 2) hours 0–23, Wed (dow 3) hours 0–14 only

   The heatmap and the hourly curve are the SAME bookings, so the fixture is
   internally consistent by construction: the Tuesday row sums to exactly 662,
   and hourly[h] is the Tuesday value plus the Wednesday one where Wednesday
   has reached that hour. That is what makes the fault arithmetic rather than
   opinion — 08:00's 91 is Tue 47 + Wed 44, while 18:00's 59 is Tue 59 plus a
   Wednesday that has not got there yet.

   What production printed, and what this pins:

     "The busiest hour is 08:00 — 9% of the day's work"   → 18:00, which is
        what the page's own heatmap caption 1,400px lower already said.
     "502 bookings a day · over 2 days"                   → 662 over the one
        day that finished. (502 was (662+341)/2 at 15:17; re-measured at 17:19
        the part-day is 361, so the same arithmetic gives 512.)
     "Temp vs volume −1.00 · hotter days run quieter"     → no figure at all.
        Pearson's r over two points is ±1 for ANY two distinct points, and one
        of the two was the part-day, so the sign was the clock.
     #corridors "Morning wave or evening wave"            → the evening window
        (16:00–21:00) has not closed today, so today is in neither half.

   The browser clock is pinned to 2026-09-02T11:17:00Z — 15:17 in Dubai — and
   the process runs under a NON-Dubai zone, because a page that is only right
   in Dubai is the bug this product already has a guard for.

     node test/live_day.test.mjs */
process.env.TZ = 'Pacific/Honolulu';

import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/* ── the fixture ───────────────────────────────────────────────────────── */
/* Tuesday 1 Sep, whole. Sums to 662, which is what /api/trips/daily reports
   for that day — the fixture is the production day, not a shape like it. */
const TUE = [11, 7, 5, 3, 3, 6, 13, 31, 47, 28, 39, 34, 32, 38, 41, 48, 55, 50, 59, 44, 26, 19, 14, 9];
/* Wednesday 2 Sep, hours 0–14, because at 15:17 Dubai that is every hour it
   has had. Sums to 361. */
const WED = [12, 8, 3, 5, 2, 3, 12, 37, 44, 46, 32, 36, 41, 35, 45];
const sum = (a) => a.reduce((x, y) => x + y, 0);

const HOURLY = TUE.map((n, h) => ({ h, trips: n + (WED[h] || 0) }));
const HEATMAP = [
  ...TUE.map((n, h) => ({ dow: 2, h, trips: n })),
  ...WED.map((n, h) => ({ dow: 3, h, trips: n })),
];
const DAILY = [
  { d: '2026-09-01', trips: sum(TUE), completed: 598, cancelled: 64, telematics_journeys: 731,
    km: '8138.3', revenue: '3417.00', priced_trips: 40, drivers: 88,
    sources_silent: 0, sources_expected: 4, silent_sources: null, uncollected: false },
  { d: '2026-09-02', trips: sum(WED), completed: 330, cancelled: 26, telematics_journeys: 201,
    km: '5870.6', revenue: '1392.94', priced_trips: 27, drivers: 87,
    sources_silent: 0, sources_expected: 4, silent_sources: null, uncollected: false },
];
/* Two days of weather, the part-day the hotter one. This is the whole of the
   "−1.00, hotter days run quieter" finding: two points, one of them 15 hours
   long, and r over two points is ±1 whatever they are. */
const CONTEXT = [
  { day: '2026-09-01', temp_max: 40.2, temp_min: 31, precipitation: 0, wind_max: 22,
    is_holiday: false, is_ramadan: false, is_forecast: false },
  { day: '2026-09-02', temp_max: 44.1, temp_min: 33, precipitation: 0, wind_max: 19,
    is_holiday: false, is_ramadan: false, is_forecast: false },
];

const RAW_PEAK = HOURLY.reduce((b, r) => (r.trips > b.trips ? r : b));
const TUE_PEAK = TUE.indexOf(Math.max(...TUE));
check('fixture: the Tuesday row is production’s 662-booking day', sum(TUE) === 662, String(sum(TUE)));
check('fixture: summed over the window the raw peak is 08:00', RAW_PEAK.h === 8 && RAW_PEAK.trips === 91,
  `${RAW_PEAK.h} = ${RAW_PEAK.trips}`);
check('fixture: on the only complete day the peak is 18:00', TUE_PEAK === 18 && TUE[18] === 59,
  `${TUE_PEAK} = ${TUE[TUE_PEAK]}`);

/* ── 1. the #demand page ───────────────────────────────────────────────── */
const stub = {
  '/api/trips/daily': DAILY,
  '/api/trips/hourly': HOURLY,
  '/api/trips/heatmap': HEATMAP,
  '/api/context': CONTEXT,
};
const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => {
  const path = `/api${req.path}`;
  res.json(path in stub ? stub[path] : []);
});
const server = shell.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1600 } });
/* 15:17 in Dubai on 2026-09-02, the minute the audit was taken. setFixedTime
   rather than install(): the page's own timers must keep running or nothing
   ever renders. */
await ctx.clock.setFixedTime(new Date('2026-09-02T11:17:00Z'));
const page = await ctx.newPage();
await page.goto(`${base}/?ui=desktop`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ } });
await page.goto(`${base}/?ui=desktop#demand?from=2026-09-01&to=2026-09-02`, { waitUntil: 'domcontentloaded' });
/* Settle on the LAST panel to paint, not the first. Each of the four requests
   fails and renders on its own, so a read taken when the verdict appears
   catches the weather panel half-built and reports whatever it held then —
   which is how this harness first reported r = −0.26 for a fixture whose
   answer is exactly −1.00. */
for (let i = 0; i < 120; i++) {
  const ready = await page.evaluate(() => {
    const t = document.body.innerText;
    return /Busiest slots:/.test(t) && /Temp vs volume/.test(t)
      && document.querySelectorAll('table tbody tr').length >= 2;
  });
  if (ready) { await page.waitForTimeout(300); break; }
  await page.waitForTimeout(250);
}
const demand = await page.evaluate(() => {
  const t = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim();
  return {
    claim: t(document.querySelector('.vdct-claim')),
    figure: t(document.querySelector('.vdct-fig b')),
    unit: t(document.querySelector('.vdct-fig i')),
    meta: t(document.querySelector('.vdct-meta')),
    sub: t(document.querySelector('.vdct-sub')),
    kpis: [...document.querySelectorAll('.kpi')].map((k) => ({
      label: t(k.querySelector('.l')), value: t(k.querySelector('.n')), sub: t(k.querySelector('.s')) })),
    body: t(document.body),
  };
});

console.log('\nthe busiest hour is the busiest hour of a whole day');
check('the headline does not name 08:00, whose 91 is 47 Tuesday + 44 Wednesday',
  !/busiest hour[^.]*\b08:00/.test(demand.claim), demand.claim);
check('…it names 18:00, the busiest hour of the only day that finished',
  /\b18:00\b/.test(demand.claim), demand.claim);
check('…which is what the page’s own heatmap caption says',
  /Busiest slots: Tue 18:00/.test(demand.body),
  flat((demand.body.match(/Busiest slots:[^·]*·[^·]*·[^·]*/) || [''])[0]));

console.log('\na 15-hour day is not averaged with a 24-hour one');
check('the daily rate is not (662 + 361) / 2', demand.figure !== '512', demand.figure);
check('…it is 662, the one day in this window that finished',
  demand.figure === '662', `${demand.figure} ${demand.unit}`);
check('…and the sentence says today is still being collected rather than counted',
  /still being collected|not averaged|so far/i.test(`${demand.meta} ${demand.sub}`),
  flat(`${demand.meta} — ${demand.sub}`));
check('…naming what today has so far, so it agrees with the chart below it',
  new RegExp(`\\b${sum(WED)}\\b`).test(`${demand.meta} ${demand.sub}`),
  flat(`${demand.meta} — ${demand.sub}`));

console.log('\nPearson’s r over two points is ±1 whatever the two points are');
const tempTile = demand.kpis.find((k) => /Temp vs volume/i.test(k.label)) || {};
check('the correlation tile is on the page', !!tempTile.label, JSON.stringify(demand.kpis.map((k) => k.label)));
check('…and does not print the ±1.00 that two points always give',
  !/^[\u2212-]?1\.00$/.test(tempTile.value || ''), `${tempTile.value} — ${tempTile.sub}`);
check('…nor concludes that hotter days run quieter from it',
  !/hotter days run quieter/.test(tempTile.sub || ''), `${tempTile.value} — ${tempTile.sub}`);
check('…it says how many complete days a correlation needs',
  /three|3 /.test(tempTile.sub || ''), `${tempTile.value} — ${tempTile.sub}`);

/* ── 1b. the #corridors wave panel says which days it is over ──────────── */
/* The endpoint's answer for the window Sep 1–2 once today is held out: the
   wave is over one day, and the page has to say so rather than presenting the
   ratio as if it covered both. */
stub['/api/geo/corridors'] = {
  note: 'Areas are parsed from the address text each provider returns.',
  part: 'all',
  wave: { morning: [5, 9], evening: [16, 21], days: 1, window_days: 2,
    live_day: '2026-09-02', closes: '22:00', as_of: '15:17' },
  corridors: [{ from_area: 'Al Garhoud', to_area: 'Business Bay', trips: 7, avg_km: '9.0',
    avg_min: '20.0', min_n: 7, min_reported_n: 0, priced: 7, complimentary: 0,
    avg_fare: '40.00', platforms: ['uber'] }],
  origins: [{ area: 'Al Garhoud', trips: 38, morning: 17, evening: 21, avg_km: '9.0' }],
  totals: { corridors_3plus: 1, corridors_all: 1, origins_all: 1, pickups_all: 38, pickups_named: 38 },
  shown: 1, truncated: false, origins_shown: 1, origins_truncated: false,
  duration_measured: 7, duration_reported: 0,
};
const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 1600 } });
await ctx2.clock.setFixedTime(new Date('2026-09-02T11:17:00Z'));
const page2 = await ctx2.newPage();
await page2.goto(`${base}/?ui=desktop`, { waitUntil: 'domcontentloaded' });
await page2.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ } });
await page2.goto(`${base}/?ui=desktop#corridors?from=2026-09-01&to=2026-09-02`, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 120; i++) {
  if (await page2.evaluate(() => /Morning wave or evening wave/.test(document.body.innerText)
    && !!document.querySelector('.wv'))) { await page2.waitForTimeout(300); break; }
  await page2.waitForTimeout(250);
}
const corr = await page2.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));

console.log('\nthe wave says how many days it is over');
check('the page names the day the endpoint held out of both halves',
  /2026-09-02 is today and is in NEITHER half/.test(corr),
  flat((corr.match(/05:00[^.]*\. ?[^.]*\./) || [''])[0]).slice(0, 200));
check('…with the hours the server actually filtered on, through :59',
  /05:00\u201309:59 against 16:00\u201321:59/.test(corr),
  flat((corr.match(/\d\d:00[^,]{0,60}against[^,]{0,60}/) || [''])[0]));
check('…and how many days the ratio covers, of how many the window holds',
  /over 1 day of the 2 in this window/.test(corr),
  flat((corr.match(/over \d+ days? of the \d+ in this window[^.]*/) || [''])[0]));
await ctx2.close();

await ctx.close();
await browser.close();
server.close();

/* ── 2. the corridor wave, over a real database ────────────────────────── */
/* Morning is 05:00–09:00 and evening is 16:00–21:00 Dubai. A day cannot be
   asked which way it leans until its evening window has closed at 22:00, so
   today belongs in NEITHER half until then — production returned evening = 0
   for every area on a today-only window and the page printed "morning wave".
   Seeded relative to the real Dubai clock so this holds whenever it runs. */
const dubaiDay = (d) => new Intl.DateTimeFormat('en-CA',
  { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const dubaiHour = Number(new Intl.DateTimeFormat('en-GB',
  { timeZone: 'Asia/Dubai', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const TODAY = dubaiDay(new Date());
const YESTERDAY = dubaiDay(new Date(Date.now() - 864e5));
/* Once 22:00 Dubai has passed, today HAS had its evening and counts like any
   other day — the rule has to be right at 23:59 as well as at 00:05. */
const todayCounts = dubaiHour >= 22;

const db = new PGlite();
await applySchema(db);
const dq = (t, p = []) => db.query(t, p);
let seq = 0;
const trip = async (day, hh, from, to) => {
  seq += 1;
  await dq(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
              requested_at, ended_at, status, distance_km, price, pickup_addr, dropoff_addr)
            VALUES ('uber',$1,'ecosine','L1','u1','Wave Driver',$2::timestamptz,
                    $2::timestamptz + interval '20 minutes','completed',9,40,$3,$4)`,
  [`w${seq}`, `${day}T${String(hh).padStart(2, '0')}:30:00+04:00`,
    `Block 1 - ${from} - Dubai - UAE`, `Block 2 - ${to} - Dubai - UAE`]);
};
/* Yesterday leans EVENING: two mornings, five evenings. */
for (const h of [6, 8]) await trip(YESTERDAY, h, 'Al Garhoud', 'Business Bay');
for (const h of [16, 17, 18, 19, 20]) await trip(YESTERDAY, h, 'Al Garhoud', 'Business Bay');
/* Today has had a morning and, at 15:17, no evening. Four mornings — enough
   that counting them turns the area's ratio over. */
for (const h of [5, 6, 7, 8]) await trip(TODAY, h, 'Al Garhoud', 'Business Bay');

const { get, server: api } = await mountAll(db);
const both = (await get(`/api/geo/corridors?from=${YESTERDAY}&to=${TODAY}`)).body;
const area = (b) => (b.origins || []).find((o) => o.area === 'Al Garhoud') || {};
const w = area(both);

console.log('\nan evening that has not happened is not a quiet evening');
check('the endpoint says which days the wave is over', !!both.wave,
  JSON.stringify(Object.keys(both)));
if (todayCounts) {
  check('after 22:00 Dubai today has had its evening and is counted',
    w.morning === 6 && w.evening === 5, `${w.morning} / ${w.evening}`);
  check('…and no day is held out', both.wave?.live_day === null, String(both.wave?.live_day));
} else {
  check('today’s four mornings are not counted against an evening it has not had',
    w.morning === 2, `morning ${w.morning} (2 = yesterday only, 6 = today folded in)`);
  check('…and the evening is yesterday’s five', w.evening === 5, String(w.evening));
  check('…so the area still reads evening-heavy, which is what the only whole day did',
    w.evening > w.morning, `${w.morning} / ${w.evening}`);
  check('…the response names the day it held out', both.wave?.live_day === TODAY,
    `${both.wave?.live_day} vs ${TODAY}`);
  check('…and how many days the wave IS over, of the two the window holds',
    both.wave?.days === 1 && both.wave?.window_days === 2,
    `${both.wave?.days} of ${both.wave?.window_days}`);
}

/* A window that is only today: the wave has nothing to say, and must say that
   rather than reporting every area as morning-heavy. */
const only = (await get(`/api/geo/corridors?from=${TODAY}&to=${TODAY}`)).body;
if (!todayCounts) {
  check('a today-only window reports no wave days rather than a false morning',
    only.wave?.days === 0 && (area(only).morning || 0) === 0 && (area(only).evening || 0) === 0,
    `${only.wave?.days} days, ${area(only).morning} / ${area(only).evening}`);
}

api.close(); await db.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
