/* #corridors: one bucket, one denominator, and a count that is not a tooltip.
   ─────────────────────────────────────────────────────────────────────────
   Three faults, all of them about what a share is divided by, all measured on
   production 2026-09-02 over the default "Last 30 days" window:

   1. THE SAME BUCKET, TWO PERCENTAGES, TWO PANELS APART. The KPI tile said
      "PICKUPS WITH NO AREA 2,112 — 15.6% of every pickup" (2,112 / 13,536,
      totals.pickups_all). The caption under the bars said "2,112 further
      pickups — 22.3% of the window". 22.3% was 2,112 / (7,375 + 2,112), where
      7,375 is the sum of only the 59 named origin rows the SERVER SENT — the
      window holds 1,362 named areas and the page receives the top 60. The
      comment block above the tiles documents this exact bug class being fixed
      for the tiles; the caption below the chart was still doing it.

   2. "11,424 OF 13,536 PICKUPS CARRY AN ADDRESS" claims 2,112 bookings have no
      address at all. Every one of them has one. `pickups_all` is
      count(*) FILTER (WHERE pickup_addr IS NOT NULL) — /api/kpis?days=1 on the
      same production returned 535 bookings and /api/geo/corridors?days=1
      returned pickups_all 535 — so the 2,112 are addresses whose text carries
      no community, which is what the KPI tile 100px below already says. The
      headline claimed a missing field; what is missing is a parse.

   3. "REQUEST → DROP" HID ITS DENOMINATOR IN A TITLE ATTRIBUTE. The endpoint
      sends min_n per corridor — on production Burj Khalifa → Burj Khalifa is
      497 of 3,277 trips, Business Bay → Business Bay 1,211 of 2,693 — and the
      cell printed "14 min" with the count only in a tooltip: invisible in a
      screenshot, on touch, and to anyone reading the column beside "Priced",
      which prints "205 of 357 · 57%" inline.

   The fixture reproduces the shape rather than the size: 210 named areas of
   which the endpoint returns the top 59, holding 747 of the window's 1,200
   named pickups — so a share taken over the rows that arrived (28.7%) is
   visibly not the share of the window (20.0%). */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { launchChromium } from './browser.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* Rows are written by generate_series rather than one INSERT per trip: the
   point of the fixture is a tail longer than the 60 origin rows the endpoint
   returns, which is two thousand bookings. */
const seed = (tag, n, addr, dropAddr, endedRatio) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status, payment_type, price,
     pickup_addr, dropoff_addr)
   SELECT 'uber', $1 || '-' || g, 'ecosine', 'L800', 'd-c', 'Corridor Driver',
          timestamptz '2026-08-10T09:00:00+04:00',
          CASE WHEN g <= $5 THEN timestamptz '2026-08-10T09:20:00+04:00' END,
          9, 'completed', 'card', NULL, $3, $4
     FROM generate_series(1, $2) g`, [tag, n, addr, dropAddr, endedRatio]);

/* Ten busy areas, each its own corridor, so the corridor table has rows. */
for (let i = 1; i <= 10; i++) {
  const a = `Gate ${i} - Hub ${String(i).padStart(2, '0')} - Dubai - UAE`;
  /* Hub 01 records an end on 12 of its 60 trips and Hub 02 on all 60: one
     corridor whose timing covers a fifth of it, one whose timing covers all of
     it, printed in the same column. */
  await seed(`hub${i}`, 60, a, a, i === 1 ? 12 : (i === 2 ? 60 : 30));
}
/* Two hundred more areas, three pickups each, that the top-60 cut cannot
   reach — 600 pickups that exist in the window and in no row this page is
   sent. This is the tail that made the two percentages disagree. */
for (let i = 1; i <= 200; i++) {
  const a = `Villa ${i} - Tail ${String(i).padStart(3, '0')} - Dubai - UAE`;
  await seed(`tail${i}`, 3, a, a, 0);
}
/* And the bucket the whole test is about: an address with no ' - ' in it, so
   the parse yields no community. The column is NOT NULL on every one of
   them — that is the point of finding 2. */
await seed('unrec', 300, 'Somewhere in Dubai', 'Somewhere in Dubai', 0);

const { get } = await mountAll(db, { serverRoutes: true });
const W = 'from=2026-08-01&to=2026-08-31';
const body = (await get(`/api/geo/corridors?${W}`)).body;
const t = body.totals || {};
const named = body.origins.filter((o) => o.area !== '(unrecorded)');
const unrec = body.origins.find((o) => o.area === '(unrecorded)');
const sentSum = named.reduce((a, o) => a + o.trips, 0);

console.log('\nwhat the window holds, and what the page is sent of it');

const [{ bookings, addressed }] = await q(
  `SELECT count(*)::int bookings,
          count(*) FILTER (WHERE pickup_addr IS NOT NULL)::int addressed
     FROM trip_ext WHERE local_day BETWEEN '2026-08-01' AND '2026-08-31' AND is_booking`);
check('every booking in the fixture carries a pickup address',
  bookings === 1500 && addressed === 1500, `${addressed} of ${bookings}`);
check('…and pickups_all is that count, not "the ones that have an address"',
  t.pickups_all === 1500, String(t.pickups_all));
check('1,200 of them resolve to an area', t.pickups_named === 1200, String(t.pickups_named));
check('the origins list is truncated, so its sum is not the window',
  named.length === 59 && sentSum === 747, `${named.length} rows, ${sentSum} trips`);
check('the unrecorded bucket is 300 pickups', unrec && unrec.trips === 300, String(unrec?.trips));

console.log('\nand the page divides the same bucket by the same thing, twice');

const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => get(`/api${req.url}`)
  .then((x) => res.status(x.status).json(x.body))
  .catch((e) => res.status(500).json({ error: String(e) })));
const server = shell.listen(0);
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1500, height: 1300 } });
await page.goto(`http://127.0.0.1:${server.address().port}/?ui=desktop#corridors?${W}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
for (let i = 0; i < 30; i++) {
  if (await page.evaluate(() => !!document.querySelector('tbody tr'))) break;
  await page.waitForTimeout(1000);
}

const seen = await page.evaluate(() => {
  const txt = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim();
  const tile = [...document.querySelectorAll('.kpi')]
    .find((k) => /no area/i.test(txt(k.querySelector('.l'))));
  const caps = [...document.querySelectorAll('.cap')].map(txt);
  /* The timing cell as a READER gets it: innerText, which is what a screenshot
     and a screen reader show, with the title attribute kept separately so the
     test can say the count moved out of it rather than merely existing. */
  const head = [...document.querySelectorAll('thead th')].map(txt);
  const col = head.findIndex((h) => /Request|Avg minutes/i.test(h));
  const rows = [...document.querySelectorAll('tbody tr')].slice(0, 12).map((tr) => {
    const cells = [...tr.querySelectorAll('td')];
    return { from: txt(cells[0]), trips: txt(cells[2]),
      min_text: col >= 0 ? (cells[col]?.innerText || '').replace(/\s+/g, ' ').trim() : '',
      min_title: col >= 0 ? [...(cells[col]?.querySelectorAll('[title]') || [])]
        .map((n) => n.getAttribute('title')).join(' | ') : '' };
  });
  return { tile: txt(tile), caps, rows, head,
    verdict: txt(document.querySelector('.vdct-sub')),
    claim: txt(document.querySelector('.vdct-claim')),
    body: document.body.innerText.replace(/\s+/g, ' ') };
});

const pctIn = (s) => (String(s).match(/(\d+(?:\.\d+)?)%/) || [])[1];
const barCap = (seen.caps || []).find((c) => /further pickup/i.test(c));
check('the bar caption names the dropped bucket at all', !!barCap, (seen.caps || []).join(' // '));
/* 300 / 1,500 = 20.0%. Divided by the 747 rows the page was sent it is 28.7%. */
check('the KPI tile divides the bucket by every pickup in the window',
  pctIn(seen.tile) === '20.0', seen.tile);
check('…and the caption under the bars divides it by the same thing',
  pctIn(barCap) === '20.0', barCap);
check('the two figures for one bucket agree',
  pctIn(seen.tile) === pctIn(barCap), `tile ${pctIn(seen.tile)}% vs caption ${pctIn(barCap)}%`);

console.log('\nand says what is missing — a parse, not an address');

check('the headline no longer claims 300 bookings have no address',
  !/pickups carry an address/i.test(seen.verdict || ''), seen.verdict);
check('…it says they resolve to an area',
  /resolve to an area/i.test(seen.verdict || ''), seen.verdict);
check('the count itself is unchanged', /1,200 of 1,500/.test(seen.verdict || ''), seen.verdict);
/* 300 of 1,500 is exactly the 20% at which the headline switches from naming
   the busiest area to naming the gap, so this fixture reads the warning
   wording rather than assuming it. */
check('and the claim above it blames the parse, not a missing field',
  /addresses name no area/i.test(seen.claim || '')
  && !/carry no usable address/i.test(seen.claim || ''), seen.claim);

console.log('\nand the timing column prints its denominator where it can be seen');

const hub1 = (seen.rows || []).find((r) => /Hub 01/.test(r.from));
check('the Hub 01 corridor is on the page', !!hub1, JSON.stringify((seen.rows || []).map((r) => r.from)));
check('the timing cell shows how many of the trips it is over',
  /12 of 60/.test(hub1?.min_text || ''), `text "${hub1?.min_text}" title "${hub1?.min_title}"`);
check('…as text, not only as a title attribute a screenshot cannot show',
  !!hub1 && !/^\d+\s*min$/.test(hub1.min_text), `"${hub1?.min_text}"`);
const hub2 = (seen.rows || []).find((r) => /Hub 02/.test(r.from));
check('a corridor timed on every trip says so too',
  /60 of 60/.test(hub2?.min_text || ''), `"${hub2?.min_text}"`);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
