/* The fare the platform reports, on a page that said it reported none.
   ─────────────────────────────────────────────────────────────────────────
   Uber's trip export carries no fare column. sum(trip.price) is therefore null
   for an Uber-only driver, and two tiles were built on it:

     #driver overview   "Fares — …—…"  under "where the platform reports fares"
     #driver / Earnings "Booked revenue — …—…" under "no trip of theirs
                        reports a fare"

   Both sentences were false. The platform reports the fare in the weekly
   statement, as the `fare` line of the earnings breakdown that this same page
   draws three panels further down: AED 866,137 over one year across the
   fourteen drivers sampled on production, under two tiles reading "—".

   The trap on the way to fixing it is arithmetic, and it is why the figure is
   returned under its own key rather than folded into accounted_fares:

     `fare` is the GROSS the rider was charged. `your_earnings` is its sibling
     minus the service fee, and the payout on the tile beside it is that. They
     are the same money seen twice, so adding them counts it twice.

     `little_fare`, `surge`, `wait_time`, `cancellation` and the rest are
     CHILDREN of `fare` — components of it, not additions to it. Summing the
     category column without regard to parent doubles the total.

   Both are asserted below, on the numbers rather than on the wording. */
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
const RIDE = 'u-rania', HOTEL = 'h-hana';

let n = 0;
const trip = (platform, drv, name, plate, day, hour, price) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, duration_s, status, product, payment_type, price,
     pickup_addr, dropoff_addr)
   VALUES ($1, $2, 'ecosine', $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '21 min',
           11, 1260, 'completed', 'UberX', 'card', $7,
           'Marina Walk - Dubai Marina - Dubai - UAE', 'T3 - Dubai Airport - Dubai - UAE')`,
  [platform, `f${++n}`, plate, drv, name, `${day}T${String(hour).padStart(2, '0')}:00:00+04:00`, price]);

/* Rania drives Uber only, and Uber prices none of it — the shape of most of
   this fleet. Hana's channel prices every booking, which is the branch that
   must keep behaving exactly as it did. */
for (const day of ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']) {
  for (let i = 0; i < 8; i++) await trip('uber', RIDE, 'Rania Deeb', 'L500', day, 7 + i, null);
  for (let i = 0; i < 4; i++) await trip('hotel', HOTEL, 'Hana Malouf', 'L501', day, 9 + i, 120);
}

/* One statement week, written the way the collector writes it: a `fare` line
   with its own components hanging beneath it, and the payout line that came
   out of the same money. If any of the children were counted the total would
   be 1,980 instead of 1,200; if the payout were added it would be 2,060. */
const comp = (drv, name, cat, parent, amount) => q(
  `INSERT INTO driver_earnings_component
     (platform, driver_ext_id, fleet_id, period_start, period_end, category, parent, amount, currency, driver_name)
   VALUES ('uber', $1, 'ecosine', '2026-08-10', '2026-08-16', $3, $4, $5, 'AED', $2)`,
  [drv, name, cat, parent, amount]);
await comp(RIDE, 'Rania Deeb', 'fare', 'your_earnings', 1200);
await comp(RIDE, 'Rania Deeb', 'little_fare', 'fare', 640);
await comp(RIDE, 'Rania Deeb', 'surge', 'fare', 90);
await comp(RIDE, 'Rania Deeb', 'wait_time', 'fare', 50);
await comp(RIDE, 'Rania Deeb', 'your_earnings', null, 860);
await comp(RIDE, 'Rania Deeb', 'service_fee', 'your_earnings', -340);
await refreshRollups({ db });

const { get } = await mountAll(db, { serverRoutes: true });
const W = `from=${FROM}&to=${TO}`;

console.log('\ndriver kpis: the fare the statement reports, under its own name');

const r = (await get(`/api/driver/kpis?id=${RIDE}&${W}`)).body;
check('the trips still report no fare, because they do not',
  r.revenue == null && r.priced_trips === 0, `${r.revenue} / ${r.priced_trips}`);
check('the statement fare is read and returned',
  Number(r.statement_fares) === 1200, String(r.statement_fares));
/* The whole arithmetic risk, in one assertion: 1,980 is what summing the
   category column without regard to parent produces. */
check('…the components of the fare are not added to it',
  Number(r.statement_fares) !== 1980, String(r.statement_fares));
check('…and neither is the payout that came out of it',
  Number(r.statement_fares) !== 2060, String(r.statement_fares));
check('it says how many statements it covers',
  r.statement_fare_periods === 1, String(r.statement_fare_periods));

/* The reason it is a separate key. accounted / accounted_fares feed the money
   the fleet counts; the statement's gross is the same money as the payout it
   contains, and folding it in would count it twice. */
check('the accounted money does NOT include it',
  !r.accounted_fares || Number(r.accounted_fares) !== 1200,
  `accounted_fares ${r.accounted_fares}`);
const acc = Number(r.accounted || 0);
check('…and the accounted total is unchanged by its presence',
  acc < 1200, `accounted ${acc} — a fold would put the 1,200 gross in here`);

const h = (await get(`/api/driver/kpis?id=${HOTEL}&${W}`)).body;
check('a channel that prices its trips still reports its own fares',
  Number(h.revenue) === 2400 && h.priced_trips === 20, `${h.revenue} / ${h.priced_trips}`);
check('…and has no statement fare to fall back to',
  !h.statement_fares, String(h.statement_fares));

console.log('\nthe page: two tiles that read “—” over six figures of fare');

const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => get(`/api${req.url}`)
  .then((x) => res.status(x.status).json(x.body))
  .catch((e) => res.status(500).json({ error: String(e) })));
const server = shell.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1500, height: 1500 } });
const tiles = async (hash, ms = 7000) => {
  await page.goto(`${base}/?ui=desktop${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(ms);
  return page.evaluate(() => [...document.querySelectorAll('.kpi')].map((k) => ({
    l: (k.querySelector('.l,.lbl,span')?.textContent || '').trim(),
    v: (k.querySelector('.v,.n,b')?.textContent || '').trim(),
    s: k.innerText.replace(/\n/g, ' '),
  })));
};
const num = (s) => { const m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? +m[0] : null; };
const find = (list, re) => list.find((t) => re.test(t.l));

const ov = await tiles(`#driver/${RIDE}?${W}`);
const fares = find(ov, /^Fares$/i);
check('the overview Fares tile is no longer a dash', fares && !/^—$/.test(fares.v), JSON.stringify(fares));
check('…it is the figure the statement reported', num(fares?.v) === 1200, JSON.stringify(fares));
check('…and it says whose figure it is and that it contains the payout',
  /platform's own figure/i.test(fares?.s || '') && /payout beside it came out of this/i.test(fares?.s || ''),
  (fares?.s || '').slice(0, 200));
/* The tile next door is the payout. If the two were added the money-in tile
   would read 2,060; it must still read what actually reached the fleet. */
const moneyIn = find(ov, /^Money in$/i);
check('the Money in tile did not absorb the gross', num(moneyIn?.v) !== 2060, JSON.stringify(moneyIn));

const hv = await tiles(`#driver/${HOTEL}?${W}`);
check('a priced channel still shows its trip fares, unchanged',
  num(find(hv, /^Fares$/i)?.v) === 2400, JSON.stringify(find(hv, /^Fares$/i)));

const earn = await tiles(`#driver/${RIDE}/earnings?${W}`);
const booked = find(earn, /^Booked revenue$/i);
check('the Earnings tab’s Booked revenue tile shows it too',
  num(booked?.v) === 1200, JSON.stringify(booked));
check('…and says it is the statement’s line, not the trips’',
  /statement/i.test(booked?.s || '') && /no trip of theirs reports a fare/i.test(booked?.s || ''),
  (booked?.s || '').slice(0, 200));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
