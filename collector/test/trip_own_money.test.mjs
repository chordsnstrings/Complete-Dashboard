/* The money a single booking made, on the page that asks what it earned.
   ─────────────────────────────────────────────────────────────────────────
   #trip's panel is titled "What this trip earned" and until now every row
   under it but one was a figure for the whole DAY — because Uber's trip export
   carries no money and the day payout was all there was.

   Its payments report does carry money, per TRANSACTION, and the collector has
   been writing the whole component set onto every row it prices since the fare
   walk landed: fare, the base-fare leaf beneath it, the service fee, the net,
   cash collected, tips, and how many transactions were folded in. Only `fare`
   was ever promoted to a column. Six of the seven sat in trip.raw and nothing
   read them, so a reader asking what one ride made was answered with a figure
   for twelve of them.

   Measured on production, one Ecosine ride of 26 August 2026:

       fare          42.75      the gross the rider was charged
       fare_base     34.53      its base-fare leaf
       service_fee  -10.69      exactly 25.00% of the fare
       earnings      31.53      42.75 - 10.69 - 0.53 tax on the fee
       cash_collected 0
       transactions   1

   This holds down that the API names it rather than leaving a page to dig
   through a provider-shaped blob, that the page shows the booking's rows above
   the day's rather than mixing them, and that a channel with no breakdown is
   unchanged. */
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
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

const PAID = 'u-paid', PLAIN = 'u-plain', HOTEL = 'h-booking';
const trip = (platform, ext, price, raw) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, duration_s, status, product, payment_type, price,
     currency, pickup_addr, dropoff_addr, raw)
   VALUES ($1, $2, 'ecosine', 'L500', 'drv-1', 'Rania Deeb',
           '2026-09-02T09:00:00+04:00', '2026-09-02T09:21:00+04:00', 11, 1260,
           'completed', 'UberX', 'card', $3, 'AED',
           'Marina Walk - Dubai Marina', 'T3 - Dubai Airport', $4::jsonb)`,
  [platform, ext, price, JSON.stringify(raw)]);

/* The shape the collector writes, copied from the production row quoted above. */
await trip('uber', PAID, 42.75, { 'Trip UUID': PAID, uber_payments: {
  fare: 42.75, fare_base: 34.53, earnings: 31.53, service_fee: -10.69,
  cash_collected: 0, tip: 0, adjustment: null, transactions: 1 } });
/* An Uber trip whose week the payments report has not reached. */
await trip('uber', PLAIN, null, { 'Trip UUID': PLAIN });
/* A channel that prices its bookings and files no breakdown at all. */
await trip('hotel', HOTEL, 120, { ref: 'h-1' });

const { get, server } = await mountAll(db, { serverRoutes: true });

console.log('\nthe endpoint names it rather than leaving raw to be dug through');

const paid = (await get(`/api/trip?platform=uber&id=${PAID}`)).body;
const tm = paid.trip_money;
check('a priced Uber booking carries its own money block', tm != null, JSON.stringify(tm));
check('…the gross the rider was charged', tm?.fare === 42.75, String(tm?.fare));
check('…the base-fare leaf beneath it, kept for the audit that found it',
  tm?.fare_base === 34.53, String(tm?.fare_base));
check('…what the platform kept', tm?.service_fee === -10.69, String(tm?.service_fee));
check('…and what the fleet earned on this one ride', tm?.earnings === 31.53, String(tm?.earnings));
/* Stated, not left for a reader to divide — and it is the identity that has
   held on every priced trip measured: the fee is a quarter of the fare. */
check('the commission is stated as a rate as well as an amount',
  tm?.commission_pct === 25, String(tm?.commission_pct));
check('cash collected is carried, and 0 means the rider paid in the app',
  tm?.cash_collected === 0, String(tm?.cash_collected));
check('and it says where the figures came from',
  /payments report/.test(tm?.source || ''), String(tm?.source));

const plain = (await get(`/api/trip?platform=uber&id=${PLAIN}`)).body;
check('an Uber booking whose week is not collected has no block, rather than a row of zeroes',
  plain.trip_money === null, JSON.stringify(plain.trip_money));

const hotel = (await get(`/api/trip?platform=${'hotel'}&id=${HOTEL}`)).body;
check('a channel that reports a price and no breakdown has none either',
  hotel.trip_money === null && Number(hotel.trip.price) === 120,
  `${JSON.stringify(hotel.trip_money)} / ${hotel.trip?.price}`);

console.log('\nthe panel, as a reader meets it');

const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => get(`/api${req.url}`)
  .then((x) => res.status(x.status).json(x.body))
  .catch((e) => res.status(500).json({ error: String(e) })));
const site = shell.listen(0);
const base = `http://127.0.0.1:${site.address().port}`;
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1500, height: 1600 } });

const rowsOf = async (id) => {
  await page.goto(`${base}/?ui=desktop#trip/uber/${id}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(7000);
  return page.evaluate(() => {
    const pan = [...document.querySelectorAll('.panel')]
      .find((p) => /What this trip earned/i.test(p.textContent));
    if (!pan) return { error: 'no money panel' };
    return {
      caption: (pan.querySelector('.sub, .cap, p')?.textContent || '').trim(),
      rows: [...pan.querySelectorAll('tbody tr')].map((tr) =>
        [...tr.querySelectorAll('td')].map((td) => td.textContent.trim())),
    };
  });
};

const paidPage = await rowsOf(PAID);
check('the panel is on the page', !paidPage.error, String(paidPage.error));
const label = (r) => r[0];
const labels = (paidPage.rows || []).map(label);
check('it names what the platform kept on THIS booking',
  labels.some((l) => /kept on this booking/i.test(l)), JSON.stringify(labels));
check('…what the fleet earned on it',
  labels.some((l) => /Earned on this booking/i.test(l)), JSON.stringify(labels));
check('…and what cash was collected on it',
  labels.some((l) => /Cash collected on this booking/i.test(l)), JSON.stringify(labels));

/* THE ordering that keeps the two grains apart. Every per-booking row must
   come before every per-day one, because a reader scanning down a column of
   amounts is entitled to assume the rows above are about the same thing. */
const idx = (re) => labels.findIndex((l) => re.test(l));
check('every booking row sits above every day row',
  Math.max(idx(/on this booking/i), idx(/Earned on this booking/i))
    < Math.min(...labels.map((l, i) => (/that day/i.test(l) ? i : Infinity))),
  JSON.stringify(labels));
check('and the caption says the two must not be added',
  /must not be added/i.test(paidPage.caption), paidPage.caption.slice(0, 160));

const amounts = (paidPage.rows || []).map((r) => r[1]);
check('the amounts are the booking’s own, to the fils',
  amounts.some((a) => /42\.75/.test(a)) && amounts.some((a) => /22|10\.69/.test(a))
    && amounts.some((a) => /31\.53/.test(a)), JSON.stringify(amounts));
check('and the commission is shown as a rate beside it',
  (paidPage.rows || []).some((r) => /25(\.0+)?%/.test(r[2] || '')),
  JSON.stringify((paidPage.rows || []).map((r) => r[2])));

const plainPage = await rowsOf(PLAIN);
check('an unpriced Uber booking still shows the day, and adds no booking rows',
  !(plainPage.rows || []).some((r) => /on this booking/i.test(label(r)) && !/Fare/i.test(label(r))),
  JSON.stringify((plainPage.rows || []).map(label)));
check('…and its caption still explains the wait rather than promising a breakdown',
  /payments report/i.test(plainPage.caption), plainPage.caption.slice(0, 160));

await browser.close(); site.close(); server.close(); await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
