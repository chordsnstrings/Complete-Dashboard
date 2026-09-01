/* What the channel charged, and what it kept.
   ─────────────────────────────────────────────────────────────────────────
   #revenue's channel table is the page an operator reads to decide which
   channel is worth supplying. Two of its columns could not answer for the
   channel that is 95% of the work:

     Fares (gross)   "none reported" — Uber prices no booking, so
                     sum(trip.price) is null, while its weekly statement files
                     AED 1,535,180 of gross for the same window.
     the commission  nowhere at all. driver_statement_day has carried `gross`
                     and `fees` since sql/schema_v25.sql and refreshStatements
                     never wrote either, so /api/revenue reported both as null
                     on every platform and every window.

   Both come out of the component tree the same fold already reads. The traps,
   asserted below because each produces a plausible wrong number:

     `service_fee` arrives NEGATIVE, like cash_collected.
     The commission rate is fees over GROSS, not (gross − net) / gross — the
     tree carries taxes and surcharges the fold does not name, so those two
     are different numbers and only one of them is a commission.
     A channel that prices its bookings must keep showing ITS fares, not the
     statement's gross.
     And it must all fit: the first cut of this was a tenth column, and it
     pushed four columns off a 1750px screen. */
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

const FROM = '2026-08-03', TO = '2026-08-30';
let n = 0;
const trip = (platform, drv, plate, day, price) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, duration_s, status, product, payment_type, price,
     pickup_addr, dropoff_addr)
   VALUES ($1, $2, 'ecosine', $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '19 min',
           10, 1140, 'completed', 'UberX', 'card', $7,
           'A - Deira - Dubai - UAE', 'B - Al Barsha - Dubai - UAE')`,
  [platform, `rc${++n}`, plate, drv, `Drv ${drv}`, `${day}T10:00:00+04:00`, price]);

/* Uber prices nothing; the hotel channel prices everything. */
for (const day of ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13']) {
  for (let i = 0; i < 6; i++) await trip('uber', `u${i}`, `L60${i}`, day, null);
  for (let i = 0; i < 2; i++) await trip('hotel', `h${i}`, `L61${i}`, day, 150);
}

/* One Uber statement week. gross 4,000 charged to riders, of which the channel
   kept 1,000 — a flat 25%, which is what a real Uber week looks like. net is
   its own line and must not move when the other two arrive. */
const comp = (drv, cat, parent, amount) => q(
  `INSERT INTO driver_earnings_component
     (platform, driver_ext_id, fleet_id, period_start, period_end, category, parent, amount, currency, driver_name)
   VALUES ('uber', $1, 'ecosine', '2026-08-10', '2026-08-16', $2, $3, $4, 'AED', $5)`,
  [drv, cat, parent, amount, `Drv ${drv}`]);
for (const drv of ['u0', 'u1']) {
  await comp(drv, 'fare', 'your_earnings', 2000);
  await comp(drv, 'service_fee', 'your_earnings', -500);
  await comp(drv, 'net_fare', null, 1400);
  await comp(drv, 'tip', null, 30);
  await comp(drv, 'cash_collected', 'payouts', -200);
}
await refreshRollups({ db });

const { get } = await mountAll(db, { serverRoutes: true });
const W = `from=${FROM}&to=${TO}`;

console.log('\nthe statement lines nothing had ever written');

const rev = (await get(`/api/revenue?${W}`)).body;
const uber = (rev.platforms || []).find((r) => r.platform === 'uber');
const hotel = (rev.platforms || []).find((r) => r.platform === 'hotel');

check('no Uber booking carries a fare, because the export carries none',
  uber && uber.fares == null, String(uber?.fares));
check('the gross its statement reports is read', Number(uber?.statement_gross) === 4000,
  String(uber?.statement_gross));
/* service_fee arrives negative in the tree. A fold that passed the sign
   through would report the channel as having taken minus a thousand dirhams. */
check('the commission is a magnitude, not the negative the tree files',
  Number(uber?.statement_fees) === 1000, String(uber?.statement_fees));
check('…and the net line is untouched by either of them',
  Math.abs(Number(uber?.statement_net) - 2800) < 0.01, String(uber?.statement_net));
/* 1000/4000 = 25.0%. (gross − net)/gross is 1200/4000 = 30.0% — a plausible
   number, a different quantity, and not a commission. */
check('the rate is fees over gross, which is not (gross − net) over gross',
  Math.round((uber.statement_fees / uber.statement_gross) * 1000) === 250
  && Math.round(((uber.statement_gross - uber.statement_net) / uber.statement_gross) * 1000) !== 250,
  `${(uber.statement_fees / uber.statement_gross) * 100}% vs ${((uber.statement_gross - uber.statement_net) / uber.statement_gross) * 100}%`);
check('a channel that prices its bookings reports its own fares',
  Number(hotel?.fares) === 1200, String(hotel?.fares));
check('…and files no statement, so it claims no gross and no commission',
  hotel?.statement_gross == null && hotel?.statement_fees == null,
  JSON.stringify([hotel?.statement_gross, hotel?.statement_fees]));

console.log('\nand the page shows both, without pushing itself off the screen');

const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => get(`/api${req.url}`)
  .then((x) => res.status(x.status).json(x.body))
  .catch((e) => res.status(500).json({ error: String(e) })));
const server = shell.listen(0);
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1750, height: 1400 } });
await page.goto(`http://127.0.0.1:${server.address().port}/?ui=desktop#revenue?${W}`,
  { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
for (let i = 0; i < 30; i++) {
  const ready = await page.evaluate(() => {
    const h = [...document.querySelectorAll('h3')].find((x) => /What each channel/i.test(x.textContent));
    return !!h?.closest('.panel')?.querySelector('tbody tr');
  });
  if (ready) break;
  await page.waitForTimeout(1000);
}
const t = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h3')].find((x) => /What each channel/i.test(x.textContent));
  const el = h?.closest('.panel');
  if (!el) return null;
  const w = el.querySelector('.tscroll');
  return {
    cols: [...el.querySelectorAll('thead th')].map((x) => x.innerText.trim()),
    rows: [...el.querySelectorAll('tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' ')),
    cut: w ? w.scrollWidth - w.clientWidth : null,
  };
});
check('the channel table rendered', !!t && t.rows.length >= 2, JSON.stringify(t?.rows?.length));
const uRow = (t?.rows || []).find((r) => /Uber/i.test(r)) || '';
check('the Uber gross cell is no longer "none reported"',
  /4,000/.test(uRow) && !/none reported/.test(uRow), uRow.slice(0, 160));
check('…and is marked as the statement’s figure, not a per-trip total',
  /stmt/.test(uRow), uRow.slice(0, 160));
check('the commission and its rate are on the row',
  /channel took/i.test(uRow) && /1,000/.test(uRow) && /25\.0%/.test(uRow), uRow.slice(0, 240));
const hRow = (t?.rows || []).find((r) => /Hotel/i.test(r)) || '';
check('the priced channel still shows its own fares and claims no commission',
  /1,200/.test(hRow) && !/channel took/i.test(hRow), hRow.slice(0, 160));
/* THE LAYOUT, ASSERTED HONESTLY.
   ─────────────────────────────────────────────────────────────────────────
   This table is nine columns of dense text and it OVERFLOWS on production
   data: measured at 1750px on the live figures it was cut by 322px before any
   of this, with Per km, Basis and Why unreachable. A test demanding cut <= 2
   would pass on this fixture's small numbers and say nothing about the page
   an operator opens — which is exactly the kind of assertion that lets a
   regression through.

   So the property is the one that matters: whatever is cut, it is not the two
   columns this change is about. On production after the line breaks the cut
   is 46px with only Why beyond the edge, down from 322px. */
const hidden = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h3')].find((x) => /What each channel/i.test(x.textContent));
  const w = h?.closest('.panel')?.querySelector('.tscroll');
  if (!w) return null;
  const edge = w.getBoundingClientRect().right;
  return [...w.querySelectorAll('thead th')]
    .filter((th) => th.getBoundingClientRect().right > edge + 4)
    .map((th) => th.textContent.replace(/[↑↓▾▴]/g, '').trim());
});
check('the gross column is on screen, not past the right-hand edge',
  hidden != null && !hidden.some((c) => /Fares/i.test(c)), JSON.stringify(hidden));
check('…and so is the column carrying the commission',
  hidden != null && !hidden.some((c) => /On-trip/i.test(c)), JSON.stringify(hidden));
/* And the first cut of this WAS a tenth column, which pushed four off the
   screen. Nine is the count this table has room for. */
check('no tenth column was added to make room for either of them',
  (t?.cols || []).length === 9, (t?.cols || []).join(' | '));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
