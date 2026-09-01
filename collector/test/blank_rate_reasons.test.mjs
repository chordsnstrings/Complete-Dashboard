/* Two tables whose columns are mostly dashes, and what the dashes are.
   ─────────────────────────────────────────────────────────────────────────
   bin/render-audit.mjs walks every route and reports a column empty on most
   of its rows, because that is what a reader scanning one sees: gaps, with no
   way to tell a missing measurement from a measurement that cannot exist.

   #platforms/funnel — "Accept %", "Complete %" and "Cash share" empty in 5 of
   6 rows. All three are rates over the offers a driver-period received, and
   those rows received none. Nothing to divide by is not the same as nothing
   recorded, and the hours sitting beside the zero make it the more interesting
   of the two: a driver logged on and never offered a job is a finding.

   #corporate/guests — "Purpose" empty in 24 of 27 rows. A purpose is free text
   somebody types when raising a booking, and only one of the booking sources
   has anywhere to type it.

   Both sentences are computed from the rows — the counts and the channel names
   alike — so neither can go on reading correctly after the data changes under
   it. That is the part a JSON assertion cannot check, so both are read off the
   rendered page. */
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

/* ── the funnel: one driver offered work, two logged on and offered none ── */
const perf = (id, name, raw) => q(
  `INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, driver_name,
     period_start, period_end, raw)
   VALUES ('yango', 'ecosine', $1, $2, '2026-08-01', '2026-08-31', $3)`,
  [id, name, JSON.stringify(raw)]);
await perf('y-1', 'Aliyan Khalil', { count_orders_all: 53, count_orders_accepted: 51,
  count_orders_completed: 43, work_time_seconds: 360000, price_cash: 800, price_cashless: 2269 });
await perf('y-2', 'Fahad Ali', { count_orders_all: 0, count_orders_accepted: 0,
  count_orders_completed: 0, work_time_seconds: 36000 });
await perf('y-3', 'Waseem Abbas', { count_orders_all: 0, count_orders_accepted: 0,
  count_orders_completed: 0, work_time_seconds: 18000 });

/* ── the guests: one source that records a purpose, two that never do ─────
   Twenty-four bookings with twenty-four passenger ids, because that is the
   shape production is in — the hotel channel issues a new id per booking, and
   the endpoint switches to its per-booking view above twenty of them. Testing
   the other branch would be testing the page nobody sees. */
let n = 0;
const booking = (property, purpose) => {
  n += 1;
  return q(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
       requested_at, ended_at, distance_km, status, payment_type, price,
       partner_id, partner_name, raw)
     VALUES ('hotel', $1, 'ecosine', 'L100', 'h-1', 'Chandra Rao',
             '2026-08-14T09:00:00+04'::timestamptz, '2026-08-14T09:20:00+04'::timestamptz,
             7, 'completed', 'room-charge', 60, $2, $2, $3)`,
    [`g${n}`, property, JSON.stringify({ client: `guest-${n}`,
      ...(purpose == null ? {} : { tripPurpose: purpose }) })]);
};
for (let i = 0; i < 3; i++) await booking('Office', 'OFFICE TRIP');
for (let i = 0; i < 11; i++) await booking('Aloft Al Mina', null);
/* An empty string, which is not a purpose. If it counted as one, the property
   writing it would be listed as recording purposes and the sentence would be
   the opposite of true. */
for (let i = 0; i < 10; i++) await booking('Le Meridien Dubai', '');

const { get } = await mountAll(db, { serverRoutes: true });
const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => get(`/api${req.url}`)
  .then((x) => res.status(x.status).json(x.body))
  .catch((e) => res.status(500).json({ error: String(e) })));
const server = shell.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });

const render = async (hash, headerRe) => {
  await page.goto(`${base}/?ui=desktop`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ } });
  await page.goto(`${base}/?ui=desktop${hash}`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate((re) => [...document.querySelectorAll('table')]
      .some((t) => new RegExp(re).test(t.querySelector('thead')?.textContent || '')), headerRe.source);
    if (ready) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(700);
  return page.evaluate(() => ({
    caps: [...document.querySelectorAll('p.cap')].map((c) => c.textContent.trim()),
    text: document.body.innerText,
  }));
};

console.log('\nrates with nothing to divide by say so, and say what is there instead');
const f = await render('#platforms/funnel?from=2026-08-01&to=2026-08-31', /Accept/);
const fc = (f.caps || []).find((x) => /Accept %/.test(x) && /empty/.test(x)) || '';
check('a sentence under the funnel names the three empty columns', !!fc,
  JSON.stringify(f.caps));
check('…and counts the rows, from the rows', /empty on 2 of these 3 rows/.test(fc), fc);
check('…and gives the reason: nothing was offered',
  /offered nothing at all, so there is no rate to take/.test(fc), fc);
/* 36,000 + 18,000 seconds is 15 hours, and that is the finding: two people
   logged on for fifteen hours between them and never offered a job. */
check('…and reports the hours those rows DID carry', /15 hours logged on/.test(fc), fc);

console.log('\nand a column only one source can fill names that source');
const g = await render('#corporate/guests?from=2026-08-01&to=2026-08-31', /Purpose/);
const gc = (g.caps || []).find((x) => /Purpose is empty/.test(x)) || '';
check('a sentence under the guest table says how many rows have none', !!gc,
  JSON.stringify(g.caps.slice(0, 6)));
check('…counted, not asserted', /empty on 21 of these 24 rows/.test(gc), gc);
check('…and it names the source that does record one', /Office is the only booking source/.test(gc), gc);
/* An empty string is not a purpose. If it counted as one, the source that
   writes '' would be listed as recording purposes and the sentence would be
   the opposite of true. */
check('…and a blank string does not count as a purpose recorded',
  /Le Meridien Dubai/.test(gc) && !/Office.*Le Meridien.*only/.test(gc), gc);
check('…and the sources that never record one are named too',
  /publish no purpose with a booking at all/.test(gc), gc);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
