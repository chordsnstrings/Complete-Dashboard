/* Nine dashes in a column, and nothing saying what a dash means there.
   ─────────────────────────────────────────────────────────────────────────
   The Data coverage table on #sources inventories every dataset the product
   holds, and one of its columns is Value. Money exists in exactly one of those
   datasets — the payout tables — so nine of the eleven rows on production
   printed an em dash, each carrying a per-cell `title` that a reader has to
   hover to find and a phone cannot show at all. bin/render-audit.mjs read the
   column as "empty in 9 of 11 rows", which is what a reader scanning it sees:
   nine unexplained gaps in a table whose whole subject is whether data has
   landed.

   The `absent` machinery in ui.js cannot answer this, because it removes a
   column that is empty on EVERY row and two rows here do carry money. So the
   answer is a sentence under the table naming the datasets money can be asked
   about — and it has to name them from the rows, not from a hard-coded list,
   because which feeds carry money is a property of the database.

   The fixture below is the shape that matters: several datasets, exactly one
   of them priced. */
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

let n = 0;
const trip = (platform, day) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status, price)
   VALUES ($1, $2, 'ecosine', 'L100', 'd-1', 'Ali Rahman',
           $3::timestamptz, $3::timestamptz + interval '18 min', 9, 'completed', 40)`,
  [platform, `t${++n}`, `${day}T09:00:00+04`]);

for (const day of ['2026-08-10', '2026-08-11', '2026-08-12']) {
  await trip('uber', day);
  await trip('yango', day);
  await q(`INSERT INTO telemetry_snapshot (plate, fleet_id, source, captured_at, polled_at, lat, lng, speed)
           VALUES ('L100', 'ecosine', 'fms', $1::timestamptz, $1::timestamptz, 25.1, 55.2, 0)`,
    [`${day}T09:30:00+04`]);
}
/* One priced dataset, and only one. */
await q(`INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day,
           period_start, period_end, earnings, cash_earnings)
         VALUES ('uber', 'ecosine', 'd-1', 'Ali Rahman', $1, $1, $1, 1234, 0)`, ['2026-08-11']);

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

const coverageTable = async (hash) => {
  await page.goto(`${base}/?ui=desktop${hash}`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i++) {
    const ready = await page.evaluate(() => [...document.querySelectorAll('table')]
      .some((t) => /Dataset/.test(t.querySelector('thead')?.textContent || '')));
    if (ready) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(800);
  return page.evaluate(() => {
    const t = [...document.querySelectorAll('table')]
      .find((x) => /Dataset/.test(x.querySelector('thead')?.textContent || ''));
    if (!t) return null;
    const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim());
    const vi = heads.findIndex((h) => /^Value/.test(h));
    const panel = t.closest('.panel');
    return {
      heads,
      caps: [...(panel?.querySelectorAll('p.cap') || [])].map((c) => c.textContent.trim()),
      rows: [...t.querySelectorAll('tbody tr')].map((r) => [
        r.cells[0]?.textContent.trim(), vi < 0 ? null : r.cells[vi]?.textContent.trim()]),
    };
  });
};

console.log('\na column that is empty on most rows, and says why');
const c = await coverageTable('#sources?from=2026-08-01&to=2026-08-31');
check('the coverage table renders', !!c, String(c));
check('…with a Value column, because one dataset does carry money',
  (c?.heads || []).some((h) => /^Value/.test(h)), JSON.stringify(c?.heads));
const priced = (c?.rows || []).filter((r) => r[1] && /\d/.test(r[1]));
const blank = (c?.rows || []).filter((r) => r[1] === '—');
check('exactly one row carries a figure and the rest are dashes',
  priced.length === 1 && blank.length >= 3,
  JSON.stringify(c?.rows));
check('the priced row is the earnings dataset', /earnings/i.test(priced[0]?.[0] || ''),
  JSON.stringify(priced));

const cap = (c?.caps || []).find((x) => /money value/i.test(x)) || '';
check('a caption under the table explains what a dash in Value is', !!cap,
  JSON.stringify(c?.caps));
/* Named from the rows. A hard-coded sentence would still read correctly here
   and would be wrong the day a second feed starts reporting money. */
check('…and it names the dataset that does carry money', /earnings/i.test(cap), cap);
check('…and counts the ones that do not, rather than leaving it to be counted',
  new RegExp(`empty on ${blank.length} of these ${c.rows.length} rows`).test(cap),
  `${blank.length} blank of ${c?.rows.length} — ${cap}`);
check('…and does not name a dataset that carries none',
  !/telemetry/i.test(cap), cap);

/* The other direction: when NOTHING is priced the column is dropped entirely
   by tableFrom's own `absent` rule, and a caption about a column that is not
   on screen would be a sentence about nothing. */
console.log('\nand when no dataset carries money, neither column nor caption appears');
await q('DELETE FROM driver_payout_day');
const c2 = await coverageTable('#sources?from=2026-08-01&to=2026-08-31&r=2');
check('the Value column is gone', !(c2?.heads || []).some((h) => /^Value/.test(h)),
  JSON.stringify(c2?.heads));
check('…and so is the sentence explaining it',
  !(c2?.caps || []).some((x) => /money value/i.test(x)), JSON.stringify(c2?.caps));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
