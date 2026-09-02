/* Four places where the words on a page described something other than the
   number beside them, and the addresses that led to none of them.
   ─────────────────────────────────────────────────────────────────────────
   Every figure quoted below was read off production
   (https://fleet-dashboard-wpeqb.ondigitalocean.app) on 2026-09-02, over the
   window the dashboard opens on — two days — so the fixtures here are
   production's own bodies rather than invented ones.

   1. #unauthorized described the same field twice, twelve pixels apart, in two
      incompatible ways, and only the tile was right.
        headline: "71 are partial matches — a booking covers some of the
                   movement and not all of it."
        KPI row:  "INCONCLUSIVE 71 — telemetry gaps — cannot judge"
      Both read totals.partial from /api/unauthorized/summary. The product's
      own verdict dictionary settles it — api/public/segments.js VERDICT_MEANS
      .partial is "A telemetry gap falls inside this window, so we cannot claim
      to have observed the whole interval" — and so does the reconciler:
      src/reconcile.js NON_CANDIDATE_REASON.partial is "the journey is cut off
      by the edge of available telemetry", and classifySegment() returns
      `partial` BEFORE findMatch() is ever called, so no booking was compared
      against these at all. The distance belongs beside the headline's too:
      /api/unauthorized/summary?days=2 answers unauth_km 154 against 2,227 km
      under the 71 partials.

   2. "Sensor suspect 0 — excluded, likely hardware" sat directly above a table
      flagging 12 of 33 seat pads as NEVER TRIGGERS. The tile reads
      totals.sensor_suspect, which counts occupancy SEGMENTS whose reading was
      implausible — a pad stuck ON. A DEAD pad emits no occupancy segment at
      all, so a fleet whose pads are all dead scores 0 on a tile captioned
      "likely hardware". Production, same window: sensor_suspect 0,
      /api/sensor-health 12 of 33 trackers with occupied_fixes 0 over 20+ fixes.

   3. #finance's "Platform payouts" named two platforms over a figure holding
      one. accounted_payouts (api/income_sql.js:222) sums only rows whose basis
      is payout or partial_payout; payout_platforms / payout_days /
      payout_drivers (api/server.js:506-508) are computed over EVERY platform
      with a payout row. On production at days=2 the tile read
      "AED 38,106 — Uber, Yango · 2 days of statements, 237 drivers" while
      /api/kpis?days=2 gives payouts 38,194.57 against accounted_payouts
      38,105.71: yango's AED 89 is in the caption and deliberately out of the
      figure, because yango is counted on its fares. The exclusion is right and
      the label was wrong.

   4. Any unknown hash silently rendered Unit economics under the Unit
      economics title. Verified live: #hotels and #zzznotarealpage both drew
      the full Unit economics page with no banner and nothing saying the
      address was not recognised (the hotel channel is at #corporate). A stale
      money link therefore landed a reader on a different money page showing a
      real figure as though they had arrived.

   The whole test drives the real api/public against fixtures, so a regression
   in the page or in the router fails here. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── production's own bodies, 2026-09-02, the window the app opens on ────── */

/* GET /api/unauthorized/summary?days=2, verbatim. */
const UNAUTH_SUMMARY = {
  byVerdict: [
    { verdict: 'authorized', n: 81, km: '1975', minutes: '3861' },
    { verdict: 'partial', n: 71, km: '2227', minutes: '4199' },
    { verdict: 'stationary', n: 31, km: '20', minutes: '93' },
    { verdict: 'unauthorized', n: 9, km: '154', minutes: '324' },
    { verdict: 'pending', n: 2, km: '5', minutes: '36' },
  ],
  coverage: { days_with_data: 2, days_in_window: 2, complete: true },
  totals: { unauthorized: 9, authorized: 81, unverifiable: 0, pending: 2, partial: 71,
    sensor_suspect: 0, stationary: 31, segments: 194, unauth_km: '154',
    low_confidence: 0, needs_a_human: 2 },
};

/* GET /api/sensor-health?days=2. The twelve dead pads are production's own
   plates and fix counts; the twenty working ones are stand-ins carrying the
   same verdict, because only the tally is under test here. Every row has
   sensor_suspect_segments 0 — which is the point: 33 trackers, 12 of them
   dead, and the summary above still says sensor_suspect 0. */
const DEAD = [['L44286', 223], ['L44259', 201], ['L78465', 84], ['L74169', 64],
  ['L44251', 55], ['L44284', 46], ['L12615', 45], ['L44295', 42], ['L44271', 41],
  ['L74170', 39], ['L44279', 39], ['L64007', 38]];
const sensorRow = (plate, occupied, total) => ({ plate,
  occupied_fixes: occupied, unreported_fixes: 0, total_fixes: total,
  occupied_pct: total ? +((occupied / total) * 100).toFixed(1) : 0,
  sensor_suspect_segments: 0, judgeable: total >= 20 });
const SENSOR_ROWS = [
  ...DEAD.map(([p, n]) => sensorRow(p, 0, n)),
  ...Array.from({ length: 20 }, (_, i) => sensorRow(`W${String(i).padStart(5, '0')}`, 98 - i, 530 - i * 9)),
  // The one tracker under the 20-fix floor: unjudged, not a finding.
  sensorRow('L78493', 0, 10),
];
const SENSOR_BODY = { rows: SENSOR_ROWS, total: SENSOR_ROWS.length,
  shown: SENSOR_ROWS.length, truncated: false };
const DEAD_PADS = DEAD.length;

/* /api/kpis?days=2's payout fields, laid over the mock's own body so every
   other tile on #finance still renders. uber is counted on its payout
   (38,105.71); yango holds a payout of 88.86 and is counted on its FARES, so
   its money is in accounted_fares and not in accounted_payouts — while its
   name, its 3 drivers and its statement days are all in the caption fields. */
const PROD_PAYOUTS = {
  payouts: 38194.57,
  accounted_payouts: 38105.71,
  payout_days: 2,
  payout_drivers: 237,
  payout_platforms: ['uber', 'yango'],
  payout_coverage_pct: 100,
};
const EXCLUDED = Math.round(PROD_PAYOUTS.payouts - PROD_PAYOUTS.accounted_payouts);  // 89

/* ── the fixture server ─────────────────────────────────────────────────── */
const { app: mockApp } = await import('../mockapi.mjs');
const mockServer = mockApp.listen(0);
const mockPort = mockServer.address().port;

const kpisBody = async (query) => {
  const base = await (await fetch(`http://127.0.0.1:${mockPort}/api/kpis?${query}`)).json();
  return { ...base, ...PROD_PAYOUTS };
};

const shell = express();
shell.get('/api/unauthorized/summary', (_, res) => res.json(UNAUTH_SUMMARY));
shell.get('/api/sensor-health', (_, res) => res.json(SENSOR_BODY));
shell.get('/api/kpis', (req, res) => kpisBody(new URLSearchParams(req.query).toString())
  .then((b) => res.json(b)).catch((e) => res.status(500).json({ error: String(e) })));
shell.use(express.static('api/public'));
shell.use(mockApp);
const server = shell.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1600, height: 1400 } });
const open = async (hash, ready) => {
  await page.goto(`${base}/?ui=desktop`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ } });
  await page.goto(`${base}/?ui=desktop${hash}`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(ready)) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(600);
};
/* The unauthorized page builds its tiles as raw innerHTML with the caption in
   `.d`; kpiRow() puts it in `.s`. Read both. */
const readTiles = () => page.evaluate(() => [...document.querySelectorAll('.kpi')].map((k) => ({
  label: k.querySelector('.l')?.textContent.trim() || '',
  value: k.querySelector('.n')?.textContent.replace(/\s+/g, ' ').trim() || '',
  sub: (k.querySelector('.s') || k.querySelector('.d'))?.textContent.replace(/\s+/g, ' ').trim() || '',
})));
/* countUp() animates every KPI figure from zero, so a tile read the moment its
   label exists reads a number on its way up. Read until two reads agree. */
const tiles = async () => {
  let prev = JSON.stringify(await readTiles());
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300);
    const now = JSON.stringify(await readTiles());
    if (now === prev) return JSON.parse(now);
    prev = now;
  }
  return JSON.parse(prev);
};

/* ── 1. #unauthorized says one thing about `partial`, and it is the dictionary's ── */
console.log('\n#unauthorized describes its 71 partials the way the verdict dictionary does');
await open('#unauthorized',
  () => [...document.querySelectorAll('.kpi .l')].some((l) => /Inconclusive/.test(l.textContent)));
const unTiles = await tiles();
const headline = await page.evaluate(() =>
  (document.querySelector('.vdct .vdct-sub')?.textContent || '').replace(/\s+/g, ' ').trim());

check('the headline mentions the 71 partials at all', /71/.test(headline), headline.slice(0, 300));
check('it no longer calls them partial MATCHES',
  !/partial match/i.test(headline), headline.slice(0, 400));
check('…nor claims a booking covered part of the movement',
  !/booking covers some of the movement/i.test(headline), headline.slice(0, 400));
check('it names the reason the dictionary and the reconciler both give',
  /telemetry gap fall|gap fall inside the interval/i.test(headline)
  && /cannot claim to have observed the whole/i.test(headline), headline.slice(0, 400));
check('…and says outright that no booking was compared against them',
  /no booking was compared against them/i.test(headline), headline.slice(0, 400));
check('it states their km beside the 154 the headline gives',
  /2,227 km/.test(headline) && /against the 154 above/.test(headline), headline.slice(0, 400));

const inconclusive = unTiles.find((k) => k.label === 'Inconclusive');
check('the KPI tile still carries the same 71', inconclusive && inconclusive.value === '71',
  JSON.stringify(inconclusive));
check('…and the two now agree rather than contradicting each other',
  /telemetry/i.test(headline) && /telemetry/i.test(inconclusive?.sub || ''),
  `tile "${inconclusive?.sub}"`);

/* ── 2. the sensor tile counts the fault it can see AND the one it cannot ── */
console.log('\n…and the seat-pad tile names the dead pads its own table is flagging');
const suspect = unTiles.find((k) => /stuck/.test(k.value) || k.label === 'Sensor suspect'
  || /pad/i.test(k.label));
check('there is a seat-pad tile', !!suspect, unTiles.map((k) => k.label).join(' | '));
check('it no longer reads a bare 0 under "likely hardware"',
  !(suspect?.value === '0' && /likely hardware/i.test(suspect?.sub || '')),
  `${suspect?.value} — ${suspect?.sub}`);
check('it carries the stuck-segment count, which is 0 in this window',
  /(^|\D)0(\D|$)/.test(suspect?.value || ''), `value "${suspect?.value}"`);
check(`…and the ${DEAD_PADS} dead pads beside it`,
  new RegExp(`(^|\\D)${DEAD_PADS}(\\D|$)`).test(suspect?.value || ''), `value "${suspect?.value}"`);
check('…and explains why a dead pad can never raise the stuck count',
  /never (fires|reported)/i.test(suspect?.sub || '') && /no interval to exclude/i.test(suspect?.sub || ''),
  `sub "${suspect?.sub}"`);
const flaggedRows = await page.evaluate(() => [...document.querySelectorAll('table tbody tr')]
  .filter((tr) => /never triggers/i.test(tr.textContent)).length);
check('…and that count is the one the table below actually flags',
  flaggedRows === DEAD_PADS, `table flags ${flaggedRows}, tile says ${DEAD_PADS}`);

/* ── 3. #finance's payout tile ───────────────────────────────────────────── */
console.log('\n#finance no longer names two platforms over a figure holding one');
await open('#finance',
  () => [...document.querySelectorAll('.kpi .l')].some((l) => /Platform payouts/.test(l.textContent)));
const finTiles = await tiles();
const payTile = finTiles.find((k) => k.label === 'Platform payouts');
check('the tile is on the page', !!payTile, finTiles.map((k) => k.label).join(' | '));
check('the figure is still the counted one, uber\'s alone',
  payTile?.value === 'AED 38,106', `reads "${payTile?.value}"`);
check('the caption no longer opens by naming the platforms as if they were in it',
  !/^Uber, Yango ·/.test(payTile?.sub || ''), `sub "${payTile?.sub}"`);
check('…it says what those names, days and drivers actually describe',
  /statements held/i.test(payTile?.sub || ''), `sub "${payTile?.sub}"`);
check(`…and names the AED ${EXCLUDED} that is deliberately not in the figure`,
  new RegExp(`AED ${EXCLUDED}`).test(payTile?.sub || '')
  && /not in this figure/i.test(payTile?.sub || ''), `sub "${payTile?.sub}"`);
check('…with the reason, so the exclusion reads as correct rather than missing',
  /counted on their fares/i.test(payTile?.sub || '')
  && /not counted twice/i.test(payTile?.sub || ''), `sub "${payTile?.sub}"`);

/* ── 4. an address that names nothing says so ────────────────────────────── */
console.log('\nan unrecognised address renders a not-found page, not Unit economics');
const headerOf = () => page.evaluate(() => ({
  title: document.querySelector('#viewTitle')?.textContent.trim() || '',
  sub: document.querySelector('#viewSub')?.textContent.trim() || '',
  body: (document.querySelector('#view')?.textContent || '').replace(/\s+/g, ' ').trim(),
  kpis: [...document.querySelectorAll('.kpi .l')].map((l) => l.textContent.trim()),
}));

await open('#zzznotarealpage', () => !!document.querySelector('#view')?.textContent.trim());
const lost = await headerOf();
check('the title is not "Unit economics"', lost.title !== 'Unit economics', `title "${lost.title}"`);
check('the title says the page was not found', /not found/i.test(lost.title), `title "${lost.title}"`);
check('the address itself is quoted back to the reader',
  lost.body.includes('#zzznotarealpage'), lost.body.slice(0, 300));
check('…and no unit-economics figure is rendered under it',
  !lost.kpis.some((l) => /Per earning vehicle-day|Idle vehicle-days/.test(l)),
  lost.kpis.join(' | '));

check('…and nothing attributes the empty page to feeds it never queried',
  !/Built from/.test(lost.body), lost.body.slice(0, 300));
const lostControls = await page.evaluate(() => ['#fRange', '#fPlatform', '#fFleet', '#fGrain']
  .filter((s) => document.querySelector(s) && document.querySelector(s).style.display !== 'none'));
check('…and no window or channel control offers to filter it',
  lostControls.length === 0, `still shown: ${lostControls.join(', ')}`);

await open('#hotels', () => !!document.querySelector('#view')?.textContent.trim());
const hotels = await headerOf();
check('#hotels is not silently answered by Unit economics either',
  /not found/i.test(hotels.title), `title "${hotels.title}"`);
check('…and it points at the page that does hold the hotel channel',
  /Corporate & hotels|Corporate &amp; hotels/.test(hotels.body), hotels.body.slice(0, 300));

/* The address is quoted back into innerHTML, and a hash is reader-supplied. */
await open('#%3Cimg%20src=x%20onerror=window.__x=1%3E',
  () => !!document.querySelector('#view')?.textContent.trim());
check('an address carrying markup is escaped, not executed',
  await page.evaluate(() => window.__x === undefined
    && !document.querySelector('#view img')),
  await page.evaluate(() => document.querySelector('#view')?.innerHTML.slice(0, 200)));

/* The landing behaviour the reshuffle was for stays exactly as it was: an
   EMPTY address is not a mistyped one. */
await open('', () => [...document.querySelectorAll('.kpi .l')].length > 0);
const landing = await headerOf();
check('an empty address still lands on Unit economics',
  landing.title === 'Unit economics', `title "${landing.title}"`);

/* …and the controls the not-found state hides come back. Nothing else in the
   app sets #fGrain's display, so hiding it without setting it both ways would
   cost the reader that control on every page after one bad address. */
await page.evaluate(() => { location.hash = '#zzznotarealpage'; });
await page.waitForTimeout(1200);
await page.evaluate(() => { location.hash = '#overview'; });
await page.waitForTimeout(2500);
const backControls = await page.evaluate(() => ['#fRange', '#fPlatform', '#fFleet', '#fGrain']
  .filter((s) => document.querySelector(s)?.style.display === 'none'));
check('…and navigating on from a bad address restores every filter control',
  backControls.length === 0, `still hidden: ${backControls.join(', ')}`);

await browser.close();
server.close();
mockServer.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
