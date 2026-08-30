/* Does the page RENDER what the API answered?
   ─────────────────────────────────────────────────────────────────────────
   Every other test here checks one side or the other: the route returns the
   right figure, or the component draws what it is handed. Nothing checked the
   join — and the join is where this product's worst bugs have lived. The
   phone divided priced fares by every trip's distance and printed AED 0; the
   overview divided trips by row count and called a week a day; the money
   tiles led with a fares figure covering 7% of the work. In all three the
   endpoint was right and the page was wrong.

   So: mount the real routes over a seeded database, serve the real front end
   against them, and assert that the number a reader can see on the tile is
   the number the endpoint answered. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshRollups } from '../src/rollup.js';
import { launchChromium } from './browser.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* Three channels, because the bug this guards against is a page that quietly
   shows one of them: Uber with no per-trip fare, a hotel channel that prices
   every ride, and a telematics feed that is not a booking at all. */
let n = 0;
const trip = (platform, day, price, plate, drv) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, pickup_addr, dropoff_addr, distance_km, status, price, raw)
   VALUES ($1, $2, 'ecosine', $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '18 min',
           'A - Deira - Dubai - UAE', 'B - Al Barsha - Dubai - UAE', 12, 'completed', $7, '{}'::jsonb)`,
  [platform, `p${++n}`, plate, drv, `D ${drv}`, `2026-08-${String(day).padStart(2, '0')}T09:00:00+04`, price]);

for (let d = 1; d <= 10; d++) {
  for (let i = 0; i < 4; i++) await trip('uber', d, null, `L${i}`, `u${i}`);
  await trip('hotel', d, 150, 'L0', 'u0');
  await trip('fms', d, null, `L${d % 4}`, `u${d % 4}`);
}
await refreshRollups({ db });

const { app: apiApp, get } = await mountAll(db, { serverRoutes: true });
/* The real front end, served over the real routes. */
const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => {
  /* Hand the browser's /api call to the mounted routes. */
  get(`/api${req.url}`).then((r) => res.status(r.status).json(r.body))
    .catch((e) => res.status(500).json({ error: String(e) }));
});
const server = shell.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1440, height: 1300 } });
await page.goto(`${base}/?ui=desktop#overview?from=2026-08-01&to=2026-08-31`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(6000);

const tiles = await page.evaluate(() => [...document.querySelectorAll('.kpi')].map((k) => ({
  l: (k.querySelector('.l,.lbl,span')?.textContent || '').trim(),
  v: (k.querySelector('.v,.n,b')?.textContent || '').trim(),
})));
check('the overview rendered its tiles at all', tiles.length > 0, String(tiles.length));


const api = (await get('/api/kpis?from=2026-08-01&to=2026-08-31')).body;
const num = (s) => { const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? +m[0] : null; };
const tile = (re) => num(tiles.find((t) => re.test(t.l))?.v);

/* Within a tenth of a percent: tiles round for display, and a test that
   demanded byte equality would fail on the rounding rather than on the join
   it exists to check. */
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.001);

check('the trips tile is the trips the endpoint answered',
  near(tile(/^Trips/i), +api.trips), `${tile(/^Trips/i)} vs ${api.trips}`);
check('…the distance tile likewise',
  near(tile(/^Distance/i), Math.round(+api.km)), `${tile(/^Distance/i)} vs ${api.km}`);
check('…the completion tile likewise',
  near(tile(/^Completion/i), +api.completion_pct), `${tile(/^Completion/i)} vs ${api.completion_pct}`);
check('…and the vehicles tile likewise',
  near(tile(/^Vehicles/i), +api.vehicles), `${tile(/^Vehicles/i)} vs ${api.vehicles}`);

/* The one that has gone wrong twice. `revenue` is sum(trip.price) and Uber
   publishes none, so a money tile fed from it describes the hotel channel and
   calls it the fleet. The tile must be the ACCOUNTED figure — fares plus
   platform payouts — not the fares alone. */
const moneyTile = tile(/^Money in/i);
check('the money tile is money IN, not the fares alone',
  near(moneyTile, Math.round(+api.accounted)), `${moneyTile} vs accounted ${api.accounted}`);
check('…and is therefore NOT the fares figure',
  !near(moneyTile, Math.round(+api.revenue)) || +api.revenue === +api.accounted,
  `${moneyTile} vs fares ${api.revenue}`);

/* The fixture has a telematics feed in it deliberately: an FMS row is the
   same physical car moving, not a booking, and adding it to demand
   double-counts every trip it shadows. */
check('telematics journeys are not counted as bookings',
  +api.trips === 50, `${api.trips} bookings from 40 uber + 10 hotel + 10 fms rows`);

/* And the page says which feeds it was built from — the whole point of the
   provenance work, asserted where a reader would actually see it. */
const src = await page.evaluate(() => document.querySelector('.srcline')?.textContent || '');
check('the page names the channels it was built from', /Uber/.test(src) && /Hotel/.test(src), src.slice(0, 100));
check('…and names the telematics feed as journeys rather than bookings',
  /journeys rather than bookings/.test(src) || !/FMS/.test(src), src.slice(0, 160));

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close(); await db.close();
process.exit(fail ? 1 : 0);
