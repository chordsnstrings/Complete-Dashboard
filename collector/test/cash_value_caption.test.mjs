/* Forty-one dashes in the column the page is named after.
   ─────────────────────────────────────────────────────────────────────────
   #settlement/cash lists who is holding the fleet's cash. Its Value known
   column is sum(trip.price) over a driver's cash bookings, and Uber's export
   carries no price on a cash trip — so on production the column reads "—" for
   41 of 46 rows. bin/render-audit.mjs reports it as a sparse column, which is
   what a reader scanning it sees: forty-one gaps under a definition.

   The definition was already in the panel caption. What was missing is the
   count and the reason, and both have to come from the rows: a sentence
   hard-coding "Uber publishes no cash fare" would read correctly today and be
   wrong the day it starts, or the day another channel stops.

   Rendered through the real view against a seeded database, because the
   sentence is computed in the browser and a JSON assertion cannot see it. */
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

/* Three drivers taking cash. Two are on the channel that publishes no fare,
   one is on the channel that does — the production shape, in miniature. */
let n = 0;
const cashTrip = (platform, drv, name, day, price) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status, payment_type, price)
   VALUES ($1, $2, 'ecosine', 'L100', $3, $4, $5::timestamptz, $5::timestamptz + interval '15 min',
           8, 'completed', 'cash', $6)`,
  [platform, `c${++n}`, drv, name, `${day}T09:00:00+04`, price]);

const DAYS = ['2026-08-10', '2026-08-11', '2026-08-12'];
for (const day of DAYS) {
  await cashTrip('uber', 'u-1', 'Amina Rashid', day, null);
  await cashTrip('uber', 'u-2', 'Bilal Noor', day, null);
  await cashTrip('hotel', 'h-1', 'Chandra Rao', day, 90);
}
/* The payout side does report what one of the silent-channel drivers took, so
   the sentence can say the money is visible from the other direction. */
await q(`INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day,
           net, tips, salik, cash, source, pseudo)
         VALUES ('uber', 'ecosine', 'Amina Rashid', 'u-1', '2026-08-11', 300, 0, 0, 260, 'uber_rest', false)`);

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

/* The front end holds a stale-while-revalidate copy of every GET (data.js),
   which is right for a reader and wrong for a fixture that changes underneath
   the page: without clearing it the second render answers from the first. */
const read = async () => {
  await page.goto(`${base}/?ui=desktop`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ } });
  await page.goto(`${base}/?ui=desktop#settlement/cash?from=2026-08-01&to=2026-08-31`,
    { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(() => [...document.querySelectorAll('table')]
      .some((t) => /Value known/.test(t.querySelector('thead')?.textContent || '')));
    if (ready) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const t = [...document.querySelectorAll('table')]
      .find((x) => /Value known/.test(x.querySelector('thead')?.textContent || ''));
    const pn = t?.closest('.panel');
    const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim());
    const vi = heads.findIndex((h) => /^Value known/.test(h));
    return {
      caps: [...(pn?.querySelectorAll('p.cap') || [])].map((c) => c.textContent.trim()),
      values: [...t.querySelectorAll('tbody tr')].map((r) => r.cells[vi]?.textContent.trim()),
    };
  });
};

console.log('\na column of dashes says how many, and why');
const r = await read();
check('the table lists all three cash holders', r.values.length === 3, JSON.stringify(r.values));
check('two of them have no value and one does',
  r.values.filter((v) => v === '—').length === 2, JSON.stringify(r.values));
const cap = (r.caps || []).find((x) => /Value known is empty/.test(x)) || '';
check('a sentence under the table says the column is empty', !!cap, JSON.stringify(r.caps));
check('…and counts the rows rather than leaving them to be counted',
  /empty on 2 of these 3 rows/.test(cap), cap);
/* The channel is named from the data. Uber prices nothing here and hotel
   prices everything, so Uber is the one that can be named — and hotel must
   not be, because naming a channel that does publish fares would be a
   sentence the reader can disprove from the row above it. */
check('…and names the channel that publishes no cash fare', /on Uber carries one/.test(cap), cap);
check('…and does not name the channel that does', !/Hotel/.test(cap), cap);
/* The other side of the same money: the point of the sentence is that the
   figure is not simply missing, it is on the payout side. */
check('…and points at the column that does carry it',
  /Statement cash beside it .* filled on 1 of them/.test(cap), cap);

/* And when the fleet's channels all publish a fare there is nothing to
   explain, so nothing is said. A caption about an absence that is not there
   is worse than no caption. */
console.log('\nand when every row carries a value it says nothing at all');
await q(`UPDATE trip SET price = 75 WHERE price IS NULL`);
const r2 = await read();
check('every row now carries a figure',
  r2.values.every((v) => /\d/.test(v)), JSON.stringify(r2.values));
check('and the sentence is gone', !(r2.caps || []).some((x) => /Value known is empty/.test(x)),
  JSON.stringify(r2.caps));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
