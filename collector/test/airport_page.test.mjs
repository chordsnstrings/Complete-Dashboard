/* #airport in Chromium — api/public/airport.js (FIX-STATUS FLT, 2026-11-16).
   ═════════════════════════════════════════════════════════════════════════
   Synthetic data only: mockapi.mjs, whose /api/airport is the route's own
   airportShape over the REAL OpenSky arrivals of 2026-11-15 shifted a day at
   a time, and — for the states the clock decides (today's live hours, an
   hour the watch half-missed, no client at all) — /api/airport answered by
   page.route() with airportShape at a FIXED clock, so the test does not
   depend on the hour it runs. serviceWorkers: 'block' (the desktop registers
   /sw.js, and a worker would answer before page.route does).

     1. Yesterday at 1280, Arkiv light: 00 at a glance with the landings as
        hero; the two hour-by-hour charts drawn; the hours table, the impact
        (lead sentence, the caveat, four lags, the days), the origins and the
        platforms; the † band naming coverage, passengers, today's estimates
        and the address rule; no script error, no "Could not load".
     2. The same at 390 and in dark, and in the classic skin: no horizontal
        overflow, nothing thrown, every panel drawn.
     3. A fixed clock: today's live hours wear "live estimate", an hour the
        watch half-missed says why on hover, the hero says "so far".
     4. No client and nothing collected: the hero is absent with "no OpenSky
        client configured", the chart says so, the impact says why it is not
        measured — and no 0 is printed as a landing count.
     5. The phone shell opens #airport without a script error.

   REVERSIONS (each made on 2026-11-16, each failed the checks named):
     · airport.js drawing the live bars without colorFor/projected → "today's
       live hours are drawn hatched" (no bar is marked projected).
     · the hours table printing `fmt(h.n)` for an absent hour (no reason) →
       "an hour the watch half-missed says why on hover".
     · the hero tile taking `fmt(Lg.total)` with no reason when absent →
       "no client: the hero is absent with the reason". */
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';
import { airportShape, addDays } from '../api/airport_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const J = (o) => JSON.stringify(o).slice(0, 300);

const srv = mock.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const dubaiToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const yday = addDays(dubaiToday, -1);

const open = async (route, { width = 1280, theme = 'light', skin = 'arkiv', stub = null, ui = 'desktop' } = {}) => {
  /* reducedMotion: the Arkiv motion layer raises bars and counts figures up
     on arrival; a read or a screenshot taken mid-rise sees half a chart. */
  const c = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', timezoneId: 'Asia/Dubai',
    colorScheme: theme, reducedMotion: 'reduce' });
  const page = await c.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  if (stub) await page.route('**/api/airport?*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stub) }));
  await page.goto(`${base}/?ui=${ui}&skin=${skin}#${route}`, { waitUntil: 'load' });
  if (ui === 'desktop') {
    await page.waitForFunction(() => {
      const t = document.querySelector('[data-panel="ap-impact"]')?.textContent || '';
      return t.length > 40 && !/Loading…/.test(t);
    }, null, { timeout: 20000 }).catch(() => {});
  } else {
    await page.waitForTimeout(2500);
  }
  return { c, page, errs };
};
const READ = () => {
  const P = (k) => document.querySelector(`[data-panel="${k}"]`);
  const txt = (e) => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');
  const glance = [...document.querySelectorAll('[data-band="glance"] .kpi, #view .kpi')].map((k) => txt(k));
  return {
    title: document.title,
    glance,
    charts: P('ap-chart') ? P('ap-chart').querySelectorAll('svg').length : 0,
    /* A projected bar is painted with a hatch pattern (charts.js hatches):
       a rect or, under Arkiv's end-rounded bars, a path. */
    projected: P('ap-chart') ? P('ap-chart').querySelectorAll('rect[fill^="url("], path[fill^="url("]').length : 0,
    chartText: txt(P('ap-chart')),
    hoursRows: P('ap-hours') ? P('ap-hours').querySelectorAll('tbody tr').length : 0,
    hoursText: txt(P('ap-hours')),
    /* The Landings column's own cell (the second): a dash with the reason. */
    absentTitles: P('ap-hours') ? [...P('ap-hours').querySelectorAll('tbody tr td:nth-child(2) .ent-off[title]')].map((e) => e.getAttribute('title')) : [],
    lead: txt(P('ap-impact')?.querySelector('.ap-lead')),
    caveat: txt(P('ap-impact')?.querySelector('.ap-caveat')),
    caveatFull: P('ap-impact')?.querySelector('.ap-caveat')?.getAttribute('title') || '',
    /* On the face of the page, not folded under ⓘ by focus.js. */
    shown: ['.ap-lead', '.ap-caveat'].map((q) => { const e = P('ap-impact')?.querySelector(q); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none'; }),
    impactRows: P('ap-impact') ? P('ap-impact').querySelectorAll('tbody tr').length : 0,
    origins: P('ap-origins') ? P('ap-origins').querySelectorAll('tbody tr').length : 0,
    originsText: txt(P('ap-origins')),
    platforms: txt(P('ap-platforms')),
    absence: [...document.querySelectorAll('[data-band="absence"] .absb-lab')].map((e) => txt(e)),
    view: txt(document.querySelector('#view')),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

console.log('\n1 · yesterday at 1280, Arkiv light');
{
  const o = await open(`airport/${yday}`);
  const x = await o.page.evaluate(READ);
  check('00 at a glance: the landings first, with a figure', /landings at dxb/i.test(x.glance[0] || '') && /\d{3}/.test(x.glance[0] || ''), J(x.glance));
  check('…airport pickups with their share, drop-offs, the relationship, pickups per 10 landings',
    x.glance.length >= 5 && x.glance.some((g) => /airport pickups/i.test(g) && /%/.test(g)) && x.glance.some((g) => /r 0\.\d\d/.test(g))
      && x.glance.some((g) => /per 10 landings/i.test(g)), J(x.glance));
  check('two hour-by-hour charts, landings over pickups', x.charts >= 2, String(x.charts));
  check('the hours table, every hour of a past day, on the OpenSky list', x.hoursRows === 24 && /OpenSky list/.test(x.hoursText), `${x.hoursRows}`);
  check('the impact: a lead line with the lag, r and pickups per 10 landings', /later|same hour/.test(x.lead) && /r 0\.\d\d/.test(x.lead) && /per 10 landings/i.test(x.lead), x.lead);
  check('…the caveat that correlation is not causation, its reasoning on hover', /not causation/i.test(x.caveat) && /time of day/.test(x.caveatFull), x.caveat);
  check('…both on the face of the page, not folded under ⓘ', x.shown.every(Boolean), J(x.shown));
  check('…four lags and the days of the window', x.impactRows >= 4 + 7, String(x.impactRows));
  check('the origins, named, with the unknown counted apart', x.origins >= 5 && /have no origin/.test(x.originsText), x.originsText.slice(0, 120));
  check('the platforms, with the address rule printed', /Airport Rd/.test(x.platforms) && /uber/i.test(x.platforms));
  check('† names coverage, passengers, today’s estimates and the address rule', x.absence.length === 4
    && x.absence.some((a) => /did not see/i.test(a)) && x.absence.some((a) => /passengers/i.test(a))
    && x.absence.some((a) => /today/i.test(a)) && x.absence.some((a) => /airport trips/i.test(a)), J(x.absence));
  check('no horizontal overflow at 1280', x.overflow <= 0, String(x.overflow));
  check('nothing thrown, nothing failed to load', !o.errs.length && !/Could not load/.test(x.view), o.errs.join(' | '));
  await o.page.screenshot({ path: `${process.env.SHOT_DIR || '/tmp'}/airport-1280-light.png`, fullPage: true }).catch(() => {});
  await o.c.close();
}

console.log('\n2 · 390, dark, and the classic skin');
for (const [label, opts] of [['390 light', { width: 390 }], ['390 dark', { width: 390, theme: 'dark' }],
  ['1280 dark', { theme: 'dark' }], ['classic 1280', { skin: 'classic' }], ['classic 390', { skin: 'classic', width: 390 }]]) {
  const o = await open(`airport/${yday}`, opts);
  const x = await o.page.evaluate(READ);
  check(`${label}: drawn (charts, hours, impact), no horizontal overflow, nothing thrown`,
    x.charts >= 2 && x.hoursRows === 24 && /not causation/i.test(x.caveat) && x.overflow <= 0 && !o.errs.length,
    J({ charts: x.charts, rows: x.hoursRows, overflow: x.overflow, errs: o.errs }));
  await o.page.screenshot({ path: `${process.env.SHOT_DIR || '/tmp'}/airport-${label.replace(/\s+/g, '-')}.png`, fullPage: true }).catch(() => {});
  await o.c.close();
}

console.log('\n3 · today at a fixed clock (14:30 Dubai): live estimates, labelled');
{
  const nowMs = Date.parse('2026-11-16T10:30:00Z');
  const D = '2026-11-16';
  const fixed = airportShape({ day: D, airport: 'OMDB', days: 28, nowMs, backfillDays: 30,
    coverage: [{ airport: 'OMDB', utc_day: '2026-11-15', status: 'collected', landings: 438 },
      { airport: 'OMDB', utc_day: D, status: 'not_published', reason: 'OpenSky has not published this day yet — its flights arrive in a nightly batch' }],
    landed: [0, 1, 2, 3].map((h) => ({ airport: 'OMDB', d: D, h, n: 20 + h })),
    live: [4, 5, 7, 8, 9, 10, 11, 12, 13, 14].map((h) => ({ airport: 'OMDB', d: D, h, n: 12 + (h % 4) })),
    liveHours: [...[4, 5, 7, 8, 9, 10, 11, 12, 13].map((h) => ({ d: D, h, polls: 30, polls_ok: 30 })),
      { d: D, h: 6, polls: 30, polls_ok: 9, last_error: 'OpenSky answered HTTP 503' }, { d: D, h: 14, polls: 16, polls_ok: 16 }],
    bookings: [{ d: D, h: 9, platform: 'uber', pu: 'OMDB', dr: null, n: 3, done: 3, noaddr: 0 },
      { d: D, h: 9, platform: 'bolt', pu: null, dr: 'OMDB', n: 2, done: 2, noaddr: 1 }],
    runs: { live: { status: 'ok', finished_at: '2026-11-16T10:30:00Z' } } });
  const o = await open(`airport/${D}`, { stub: fixed });
  const x = await o.page.evaluate(READ);
  check('today’s live hours wear “live estimate” in the hours table', /live estimate/.test(x.hoursText), x.hoursText.slice(0, 160));
  check('today’s live hours are drawn hatched (marked projected)', x.projected > 0 && /live estimates/.test(x.chartText), `${x.projected}`);
  check('an hour the watch half-missed says why on hover', x.absentTitles.some((t) => /9 of 30 polls/.test(t) && /not published yet/.test(t)), J(x.absentTitles));
  check('the hero says how many hours are measured so far', /so far/.test(x.glance[0] || '') && /live estimate/.test(x.glance[0] || ''), x.glance[0]);
  check('the impact is not measured, and says why', /^Not measured/.test(x.lead) && /only 0 of these 28 days/.test(x.lead), x.lead);
  check('nothing thrown', !o.errs.length, o.errs.join(' | '));
  await o.c.close();
}

console.log('\n4 · no client, nothing collected');
{
  const NO = 'no OpenSky client configured — set OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET on the Settings page';
  const nowMs = Date.parse('2026-11-16T10:30:00Z');
  const none = airportShape({ day: '2026-11-10', airport: 'OMDB', days: 28, nowMs, backfillDays: 30,
    runs: { arrivals: { status: 'error', error: NO, finished_at: '2026-11-16T10:00:00Z' }, live: { status: 'error', error: NO } } });
  const o = await open('airport/2026-11-10', { stub: none });
  const x = await o.page.evaluate(READ);
  check('no client: the hero is absent with the reason, and no count', /no hour of this day has a landing figure/i.test(x.glance[0] || '')
    && /no OpenSky client configured/.test(x.glance[0] || '') && !/\d/.test((x.glance[0] || '').split(':')[0]), x.glance[0]);
  check('…the landings chart says so instead of drawing zeros', /no OpenSky client configured/.test(x.chartText), x.chartText.slice(0, 200));
  check('…every hour in the table is “not measured”, with the reason on hover', x.hoursRows === 24 && x.absentTitles.filter((t) => /no OpenSky client configured/.test(t)).length >= 24,
    String(x.absentTitles.length));
  check('…and the impact says why it is not measured', /^Not measured/.test(x.lead), x.lead);
  check('nothing thrown', !o.errs.length, o.errs.join(' | '));
  await o.c.close();
}

/* 5 · the review of 2026-11-16 (FIX-STATUS FLT-R3). Three sentences the
   page wrote whatever the answer said:
     · the head called the airport trips "both fleets" even when the gate had
       written a one-fleet reader's fleet into ?fleet= and the route counted
       that fleet's only;
     · the lead said "Pickups follow landings … — r 0.12";
     · a reason handed to empty() went through esc() first and was escaped
       twice ("&lt;!DOCTYPE").
   REVERSIONS (each made on 2026-11-16, each failed the check named): the old
   static head caption → "a one-fleet answer says whose bookings…"; the old
   verb → "a weak r is not called…"; esc() back around Lg.total_why → "a
   reason reaches the page as written". */
console.log('\n5 · whose bookings, how strong, and reasons as written');
{
  const real = await (await fetch(`${base}/api/airport?day=${yday}&airport=OMDB&days=28`)).json();
  const weak = { ...real, fleet: 'egari', impact: { ...real.impact, r: 0.12, best_lag: 0,
    lags: real.impact.lags.map((x) => ({ ...x, r: x.lag === 0 ? 0.12 : 0.05 })) } };
  const o = await open(`airport/${yday}`, { stub: weak });
  const x = await o.page.evaluate(READ);
  const headCap = await o.page.evaluate(() => document.querySelector('[data-panel="ap-head"] p.cap')?.textContent || '');
  check('a one-fleet answer says whose bookings it counts, and never “both fleets”', /Egari/.test(headCap) && !/both fleets/i.test(headCap), headCap);
  check('a weak r is not called a relationship: “weakly follow”, never a bare “follow”', /^Pickups weakly follow landings in the same hour/.test(x.lead), x.lead);
  check('nothing thrown', !o.errs.length, o.errs.join(' | '));
  await o.c.close();
  const both = await open(`airport/${yday}`);
  const cap2 = await both.page.evaluate(() => document.querySelector('[data-panel="ap-head"] p.cap')?.textContent || '');
  check('…and an answer for every fleet says so', /both fleets|every fleet/i.test(cap2), cap2);
  await both.c.close();

  const NOJSON = 'Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON';
  const nowMs = Date.parse('2026-11-16T10:30:00Z');
  const broken = airportShape({ day: '2026-11-10', airport: 'OMDB', days: 28, nowMs, backfillDays: 30,
    runs: { arrivals: { status: 'error', error: NOJSON, finished_at: '2026-11-16T10:00:00Z' }, live: { status: 'error', error: NOJSON } } });
  const b = await open('airport/2026-11-10', { stub: broken });
  const y = await b.page.evaluate(READ);
  check('a reason reaches the page as written, escaped once', y.chartText.includes('"<!DOCTYPE "') && !/&lt;|&quot;|&amp;/.test(y.chartText), y.chartText.slice(0, 240));
  /* The chart's empty state printed "No hour of this day has a landing
     figure: no hour of this day has a landing figure: …" — the page's prefix
     before the API's total_why, which already opens with it. REVERSION:
     put the prefix back → this fails. */
  check('…and says “no hour of this day has a landing figure” once, not twice',
    (y.chartText.match(/no hour of this day has a landing figure/gi) || []).length === 1, y.chartText.slice(0, 240));
  await b.c.close();
}

console.log('\n6 · the phone shell');
{
  const o = await open(`airport/${yday}`, { ui: 'phone', width: 390 });
  check('the phone shell opens #airport without a script error', !o.errs.length, o.errs.join(' | '));
  await o.c.close();
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
