/* A heading promising every driver, over the worst hundred of them.
   ─────────────────────────────────────────────────────────────────────────
   /api/alerts/by-driver ranks people by event count and stops at a hundred. It
   says so — `truncated` and a `totals.drivers` count ride on the response, and
   the vehicle table on the same page has read them since it was written. The
   driver table never did: its heading said "Every driver with an event" and
   its row count came from the array, so on any window wide enough to reach the
   cap the page promised the fleet and showed the worst hundred of it.

   bin/render-audit.mjs flags a table that ends on exactly a round number with
   nothing saying whether that is all of them, and #safety was the case where
   the page said something and the something was wrong.

   Both directions are here: under the cap the claim must be made, and over it
   the claim must be withdrawn and the real total named. */
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

const DAY = '2026-08-14';
let ev = 0;
/* One driver, one car, one day, and as many events as their rank needs — the
   list is ordered by event count, so the hundred that survive the cap have to
   be a defined hundred for the totals to be checkable. */
const driver = async (i, alerts) => {
  const plate = `L${1000 + i}`;
  await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name,
             fleet_id, trips, km, is_primary)
           VALUES ($1, $2::date, $3, 'uber', $4, 'ecosine', 4, 60, true)`,
  [plate, DAY, `d-${i}`, `Driver ${String(i).padStart(3, '0')}`]);
  for (let a = 0; a < alerts; a++) {
    await q(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
             VALUES ('fms', $1, 'ecosine', $2, 'Harsh Brake', $3::timestamptz)`,
    [`ev-${++ev}`, plate, `${DAY}T09:00:00+04`]);
  }
};

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

const safety = async () => {
  await page.goto(`${base}/?ui=desktop`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ } });
  await page.goto(`${base}/?ui=desktop#safety?from=2026-08-01&to=2026-08-31`,
    { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 60; i++) {
    const ready = await page.evaluate(() => [...document.querySelectorAll('.panel h3')]
      .some((h) => /driver.? with an event/i.test(h.textContent)));
    if (ready) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const pn = [...document.querySelectorAll('.panel')]
      .find((x) => /driver.? with an event/i.test(x.querySelector('h3')?.textContent || ''));
    return {
      head: pn?.querySelector('h3')?.textContent.trim(),
      rows: pn?.querySelectorAll('tbody tr').length,
      caps: [...(pn?.querySelectorAll('p.cap') || [])].map((c) => c.textContent.trim()),
    };
  });
};

console.log('\nunder the cap, the page may say every — and does');
for (let i = 1; i <= 6; i++) await driver(i, 7 - i);
const few = await safety();
check('the table holds all six', few.rows === 6, `${few.rows} rows — ${few.head}`);
check('the heading claims every driver', /^Every driver with an event/.test(few.head || ''), few.head);
check('…and prints the count beside the claim', /6 rows/.test(few.head || ''), few.head);
check('and nothing tells the reader rows are missing',
  !few.caps.some((c) => /Showing \d+ of/.test(c)), JSON.stringify(few.caps));

console.log('\nover the cap, it withdraws the claim and names the real total');
/* 104 people with an event; the endpoint ranks and keeps a hundred. */
for (let i = 7; i <= 104; i++) await driver(i, 1);
const many = await safety();
check('the table stops at the endpoint’s hundred', many.rows === 100,
  `${many.rows} rows — ${many.head}`);
check('the heading no longer says every', !/Every/.test(many.head || ''), many.head);
check('…and names both figures', /100 rows of 104/.test(many.head || ''), many.head);
check('a caption under the table says the same in words',
  many.caps.some((c) => /Showing 100 of 104 drivers with an event/.test(c)),
  JSON.stringify(many.caps));
/* Sorting a capped table re-orders the rows it holds and reaches none of the
   others, which is the thing a reader assumes wrongly. */
check('…and warns that sorting does not reach the rest',
  many.caps.some((c) => /Sorting re-orders those rows/.test(c)), JSON.stringify(many.caps));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
