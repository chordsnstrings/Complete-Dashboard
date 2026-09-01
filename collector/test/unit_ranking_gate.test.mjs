/* Four of eight panels empty, on the window the page opens on.
   ─────────────────────────────────────────────────────────────────────────
   #unit ranks assets and people by money per day worked, and gates both on
   having enough days to make a per-day rate mean something. The gate was a
   flat TEN DAYS — right for a month, and impossible for any window shorter
   than ten.

   The product's default window is the calendar month (api/public/data.js:21),
   so on the 1st of every month the gate emptied four of this page's eight
   panels, and again on the 2nd, and every day to the 10th. Measured on
   production on 2026-09-01: 84 vehicles and 94 drivers cleared it at days=30
   and ZERO at period=month. bin/render-audit.mjs reported it as "4 of 8
   panels have no data".

   The gate is now a third of the window, capped at ten and floored at one.
   Asserted through the page rather than as arithmetic, because the defect was
   what a reader saw. */
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

/* Four cars and four drivers, each working four consecutive days at a priced
   channel. Nobody reaches ten days — which is the whole point: on a four-day
   window they are exactly the population the page exists to rank. */
let n = 0;
const trip = (plate, drv, day, price) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status, payment_type, price, pickup_addr, dropoff_addr)
   VALUES ('hotel', $1, 'ecosine', $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '20 min',
           13, 'completed', 'room-charge', $6,
           'A - Deira - Dubai - UAE', 'B - Al Barsha - Dubai - UAE')`,
  [`g${++n}`, plate, drv, `Driver ${drv}`, `${day}T09:00:00+04`, price]);

const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'];
for (let v = 0; v < 4; v++) {
  for (const day of DAYS) {
    for (let i = 0; i < 3; i++) await trip(`L70${v}`, `d7${v}`, day, 100 + v * 25);
  }
}
await refreshRollups({ db });
const { get } = await mountAll(db, { serverRoutes: true });

const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => get(`/api${req.url}`)
  .then((x) => res.status(x.status).json(x.body))
  .catch((e) => res.status(500).json({ error: String(e) })));
const server = shell.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1500, height: 1400 } });

const panels = async (hash) => {
  await page.goto(`${base}/?ui=desktop${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (let i = 0; i < 30; i++) {
    const ready = await page.evaluate(() => [...document.querySelectorAll('.panel h3')]
      .some((h) => /earning most per day/i.test(h.textContent)));
    if (ready) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(1200);
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.panel')]
    .map((p) => [p.querySelector('h3')?.textContent?.trim() || '?',
      { cap: p.querySelector('p.cap')?.textContent || '',
        rows: p.querySelectorAll('tbody tr').length,
        text: p.innerText.replace(/\s+/g, ' ').slice(0, 200) }])));
};

/* A four-day window: shorter than the old gate, which is the state the
   calendar-month default is in for the first ten days of every month. */
console.log('\na window shorter than ten days still ranks');
const p = await panels('#unit?from=2026-08-10&to=2026-08-13');
const RANKED = ['Assets earning most per day worked', 'Assets earning least per day worked',
  'People earning most per day worked', 'People earning least per day worked'];
for (const name of RANKED) {
  check(`"${name}" has rows`, (p[name]?.rows || 0) > 0,
    `${p[name]?.rows} rows — ${p[name]?.text?.slice(0, 90)}`);
}
/* The gate that was actually applied, printed. "At least 10" over a four-day
   window described a threshold the page was not using. */
check('the caption names the gate it actually used, not a flat ten',
  /at least 2 days|at least 2 earning days/i.test(p[RANKED[0]]?.cap + p[RANKED[2]]?.cap),
  `${p[RANKED[0]]?.cap} | ${p[RANKED[2]]?.cap}`);
check('…and says why it is not the usual ten',
  /would rank nobody/i.test(p[RANKED[0]]?.cap || ''), p[RANKED[0]]?.cap);

/* And a month-long window must keep the ten-day gate: the point of it is that
   one good day is not a good month, and loosening that everywhere would be a
   different bug in the other direction. */
console.log('\nand a month-long window still asks for ten days');
const q30 = await panels('#unit?from=2026-07-20&to=2026-08-18');
check('a thirty-day window keeps the ten-day threshold',
  /at least 10 earning days/i.test(q30[RANKED[0]]?.cap || ''), q30[RANKED[0]]?.cap);
check('…and does not tell the reader it was lowered',
  !/would rank nobody/i.test(q30[RANKED[0]]?.cap || ''), q30[RANKED[0]]?.cap);
/* Nobody in this fixture has ten days, so the panels are empty here — and the
   empty state must name the real window rather than a threshold-shaped
   sentence that could be about any page. */
check('the empty state names the window it measured',
  /range of 30 days/i.test(q30[RANKED[0]]?.text || ''), q30[RANKED[0]]?.text?.slice(0, 140));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
