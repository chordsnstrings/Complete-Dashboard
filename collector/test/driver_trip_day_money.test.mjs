/* An unpriced trip is not a trip with no money.
   ─────────────────────────────────────────────────────────────────────────
   The Fare column on #driver/<id>/trips was an em-dash on four rows in five,
   under a caption saying Uber's trip export carries no fare column. That is
   true, and it is the least useful true thing available: Uber DOES publish
   the money, per driver per DAY, and driver_payout_day holds it. A reader
   looking at a 2 September ride can be told the driver earned AED 73.78
   across four Uber trips that day.

   Three things are asserted, and the second is the one that matters most.

     1. the day IS shown where it is known
     2. it is NEVER divided by the day's trip count — 73.78 / 4 = 18.445 is a
        per-trip fare Uber has never stated, and the trips of a day are not
        equal. Inventing it is the exact failure sql/schema_v58.sql was
        written to undo, one grain down.
     3. a day whose money a finer report already stated shows the server's own
        sentence, not a figure and not a bare dash.

   The API half runs against PGlite; the rendering half runs in Chromium, on
   the cell as a reader meets it. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshRollups, refreshPayouts } from '../src/rollup.js';
import { launchChromium } from './browser.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const near = (a, b, e = 0.01) => Math.abs(Number(a) - Number(b)) < e;

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

const FROM = '2026-09-01', TO = '2026-09-06';
const DRV = 'u-rania', OTHER = 'u-otto', HOTEL = 'h-hana';

let n = 0;
const trip = (platform, drv, name, day, hour, price) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, duration_s, status, product, payment_type, price,
     pickup_addr, dropoff_addr)
   VALUES ($1, $2, 'ecosine', 'L500', $3, $4, $5::timestamptz,
           $5::timestamptz + interval '21 min', 11, 1260, 'completed', 'UberX', 'card', $6,
           'Marina Walk - Dubai Marina - Dubai - UAE', 'T3 - Dubai Airport - Dubai - UAE')`,
  [platform, `f${++n}`, drv, name, `${day}T${String(hour).padStart(2, '0')}:00:00+04:00`, price]);

const perf = (drv, from, to, earnings) => q(
  `INSERT INTO driver_performance
     (platform, fleet_id, driver_ext_id, driver_name, period_start, period_end,
      earnings, ingested_at)
   VALUES ('uber', 'ecosine', $1, $1, $2, $3, $4, now())
   ON CONFLICT (platform, driver_ext_id, period_start, period_end) DO NOTHING`,
  [drv, from, to, earnings]);

/* 2 SEP — the ordinary case. Four Uber trips, none priced, and Uber's own
   per-day figure for them. */
for (let i = 0; i < 4; i++) await trip('uber', DRV, 'Rania Deeb', '2026-09-02', 8 + i, null);
await perf(DRV, '2026-09-02', '2026-09-02', 73.78);

/* 3 SEP — the superseded case. On this day the driver appears only in a
   multi-day window, and the fleet's daily grid demonstrably ran because
   another driver has a day row on it. schema_v58 withholds that window's
   money and writes the reason.

   The window stops at 3 September on purpose. A window reaching over 4
   September would legitimately supply that day's money — outside the daily
   grid the coarse report is the only record and schema_v58 leaves it alone —
   and there would then be no day left in this fixture that nothing reported.
   That third branch is the one the reader meets most often on a page whose
   window runs past the last statement. */
for (let i = 0; i < 3; i++) await trip('uber', DRV, 'Rania Deeb', '2026-09-03', 8 + i, null);
await perf(DRV, '2026-09-02', '2026-09-03', 300);
await perf(OTHER, '2026-09-03', '2026-09-03', 210);

/* 4 SEP — nothing reported the day at all. The dash survives, and so does the
   sentence that explains it. */
for (let i = 0; i < 2; i++) await trip('uber', DRV, 'Rania Deeb', '2026-09-04', 8 + i, null);

/* 5 SEP — a channel that prices its bookings, on the same person's page.
   The branch that must behave exactly as it always has. */
for (let i = 0; i < 2; i++) await trip('hotel', DRV, 'Rania Deeb', '2026-09-05', 9 + i, 120);

await refreshRollups({ db });
await refreshPayouts(db);

const { get } = await mountAll(db, { serverRoutes: true });
const W = `from=${FROM}&to=${TO}`;

console.log('\nthe endpoint');

const body = (await get(`/api/driver/trips?id=${DRV}&${W}&limit=500`)).body;
const rows = body.rows || [];
check('every trip on the page came back', rows.length === 11, String(rows.length));

/* The trap this key exists to avoid: a bare DATE reaches node-postgres as a
   JS Date, and slicing ten characters off its default string form yields
   "Wed Sep 02" rather than a date. A client joining on that would miss every
   day, silently, and every cell would fall back to the em-dash. */
check('each row carries its Dubai day as YYYY-MM-DD',
  rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.local_day || '')),
  JSON.stringify(rows.slice(0, 2).map((r) => r.local_day)));

const days = body.days || [];
const day = (p, d) => days.find((x) => x.platform === p && x.day === d);

check('a day list came back beside the rows', days.length >= 4, String(days.length));

const d2 = day('uber', '2026-09-02');
check('the ordinary day reports its money', d2 && near(d2.earnings, 73.78), JSON.stringify(d2));
check('…and how many trips it is spread over', d2 && d2.trips === 4, String(d2 && d2.trips));
check('…and that none of them carried a fare', d2 && d2.priced === 0, String(d2 && d2.priced));
check('…with no reason to withhold it', d2 && !d2.grain_reason, String(d2 && d2.grain_reason));

const d3 = day('uber', '2026-09-03');
check('the superseded day reports NO money', d3 && d3.earnings == null, JSON.stringify(d3 && d3.earnings));
check('…and carries the server’s own sentence saying why',
  /also filed a per-day report/.test((d3 && d3.grain_reason) || ''),
  String(d3 && d3.grain_reason).slice(0, 80));

const d4 = day('uber', '2026-09-04');
check('a day nothing reported is present with its trip count, not missing',
  d4 && d4.trips === 2 && d4.earnings == null, JSON.stringify(d4));

const d5 = day('hotel', '2026-09-05');
check('a priced channel’s day counts its priced trips', d5 && d5.priced === 2, JSON.stringify(d5 && d5.priced));

console.log('\nthe cell, as a reader meets it');

const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => get(`/api${req.url}`)
  .then((x) => res.status(x.status).json(x.body))
  .catch((e) => res.status(500).json({ error: String(e) })));
const server = shell.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1600, height: 1400 } });
await page.goto(`${base}/?ui=desktop#driver/${DRV}/trips?${W}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);

/* Read the Fare cell of every row together with the day it belongs to, by
   column position rather than by index — a column added to the left of Fare
   should not silently move this test onto Status. */
const cells = await page.evaluate(() => {
  const tbl = [...document.querySelectorAll('table')]
    .find((t) => [...t.querySelectorAll('th')].some((h) => /^Fare$/i.test(h.textContent.trim())));
  if (!tbl) return { error: 'no table with a Fare column' };
  const heads = [...tbl.querySelectorAll('th')].map((h) => h.textContent.trim());
  const fi = heads.findIndex((h) => /^Fare$/i.test(h));
  const ri = heads.findIndex((h) => /^Requested$/i.test(h));
  return {
    rows: [...tbl.querySelectorAll('tbody tr')].map((tr) => {
      const td = tr.querySelectorAll('td');
      return {
        when: (td[ri]?.textContent || '').trim(),
        text: (td[fi]?.textContent || '').trim(),
        title: (td[fi]?.querySelector('[title]')?.getAttribute('title') || ''),
      };
    }),
  };
});

check('the Fare column is on the page', !cells.error, String(cells.error));
const all = cells.rows || [];
check('every trip drew a row', all.length === 11, String(all.length));

const part = all.filter((c) => /part of/.test(c.text));
check('the four trips of the day Uber priced by day say what they are part of',
  part.length === 4, `${part.length} cells: ${JSON.stringify(all.map((c) => c.text))}`);
check('…and they say it to the cent',
  part.every((c) => /AED\s*73\.78/.test(c.text)), JSON.stringify(part.map((c) => c.text)));
/* The column is headed Fare and the figure is a PAYOUT — net of the platform's
   commission, which on Uber is a quarter. A cell that prints one under a
   heading meaning the other invites exactly the misreading this product spends
   its captions preventing, so the cell names it and the tooltip says why. */
check('…and name it as earnings rather than letting it read as a fare',
  part.every((c) => /earned that day/.test(c.text)), JSON.stringify(part.map((c) => c.text)));
check('…and the tooltip says it is after the commission',
  part.every((c) => /AFTER the platform.s commission/.test(c.title)),
  JSON.stringify(part[0]?.title || '').slice(0, 160));

/* THE ONE THAT MATTERS. 73.78 / 4 = 18.445. Any appearance of it — 18.45,
   18.44, 18 — means the product has invented a per-trip fare. */
const quotient = /18[.,]4|AED\s*18\b/;
check('the day is NEVER divided into a per-trip fare',
  !all.some((c) => quotient.test(c.text) || quotient.test(c.title)),
  JSON.stringify(all.filter((c) => quotient.test(c.text) || quotient.test(c.title))));

check('the tooltip says why it cannot be divided',
  part.every((c) => /not a share of one/.test(c.title) && /never stated a per-trip figure/.test(c.title)),
  JSON.stringify(part[0]?.title || '').slice(0, 160));

const dash = all.filter((c) => c.text === '—');
check('the superseded day and the unreported day still show a dash',
  dash.length === 5, `${dash.length}: ${JSON.stringify(all.map((c) => c.text))}`);
check('…and the superseded one explains itself rather than blaming the export',
  dash.some((c) => /would state the same money twice/.test(c.title)),
  JSON.stringify(dash.map((c) => c.title.slice(0, 60))));
check('…and the unreported one says no statement covers it',
  dash.some((c) => /no statement covers this day/.test(c.title)),
  JSON.stringify(dash.map((c) => c.title.slice(0, 60))));

const priced = all.filter((c) => /AED\s*120/.test(c.text));
check('a channel that prices its bookings still prints the fare itself',
  priced.length === 2, JSON.stringify(all.map((c) => c.text)));

console.log('\nthe column has to survive long enough to render');

/* tableFrom drops a column whose declared key is blank in EVERY row when that
   column declares `absent`. On an Uber-only driver every price is null, so the
   Fare column would be pruned before its renderer ran and the reader would be
   told the fare is unknowable while the server was holding the day's money.

   Two drivers, two answers. UNPRICED has no fare on any trip and a day figure
   for every one; NOTHING has neither. */
const UNPRICED = 'u-uma', NOTHING = 'u-nadia';
for (let i = 0; i < 3; i++) await trip('uber', UNPRICED, 'Uma Rahim', '2026-09-02', 8 + i, null);
await perf(UNPRICED, '2026-09-02', '2026-09-02', 210.5);
for (let i = 0; i < 3; i++) await trip('uber', NOTHING, 'Nadia Salem', '2026-09-02', 8 + i, null);
await refreshRollups({ db });
await refreshPayouts(db);

const fareCells = async (who) => {
  await page.goto(`${base}/?ui=desktop#driver/${who}/trips?${W}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  return page.evaluate(() => {
    const tbl = [...document.querySelectorAll('table')]
      .find((t) => [...t.querySelectorAll('th')].some((h) => /^(Fare|Requested)$/i.test(h.textContent.trim())));
    const heads = tbl ? [...tbl.querySelectorAll('th')].map((h) => h.textContent.trim()) : [];
    const fi = heads.findIndex((h) => /^Fare$/i.test(h));
    return {
      hasFare: fi >= 0,
      cells: fi < 0 ? [] : [...tbl.querySelectorAll('tbody tr')]
        .map((tr) => (tr.querySelectorAll('td')[fi]?.textContent || '').trim()),
      notes: [...document.querySelectorAll('.cap, .note')].map((n) => n.textContent).join(' | '),
    };
  });
};

const u = await fareCells(UNPRICED);
check('a driver with no priced trip at all keeps the Fare column',
  u.hasFare, 'the column was pruned before its renderer could run');
check('…and every cell says what the trip is part of',
  u.cells.length === 3 && u.cells.every((c) => /part of AED 210\.50 earned that day/.test(c)),
  JSON.stringify(u.cells));

const none = await fareCells(NOTHING);
check('a driver with no fare and no day figure drops the column instead',
  !none.hasFare, JSON.stringify(none.cells));
check('…and the page says why, rather than showing three dashes',
  /payments report/.test(none.notes), none.notes.slice(0, 200));

await browser.close(); server.close(); await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
