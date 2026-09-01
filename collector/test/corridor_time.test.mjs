/* How long a corridor takes, on the page that exists to answer that.
   ─────────────────────────────────────────────────────────────────────────
   #corridors is the page an operator reads to see which routes carry the work
   and what they cost. Its timing column read duration_s — declared on
   sql/schema.sql:64, mapped from Uber's "Trip Duration" in src/probe.js, and
   written by no collector — so avg_min was NULL on all 119 production
   corridors in every window, and the page printed a sentence saying no timing
   exists for any of them.

   It does exist. 180 of 200 production bookings carry BOTH requested_at and
   ended_at, and #trip has always shown their difference — "3 min · requested
   to ended — the channel reports no duration" — about the very same trips.
   Two pages disagreeing about whether a figure exists at all is the failure
   this product is built to avoid.

   What the derivation must get right, each asserted below because each
   produces a plausible wrong number:

     an end BEFORE the request is a clock artefact, not a negative trip;
     a six-hour "corridor" is a stuck record, not a long drive, and one of
       them drags a corridor's average by an hour;
     a channel's own duration, where one ever files it, still wins;
     and the label must say request-to-dropoff rather than drive time,
       because it contains the approach and the rider's wait. */
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

const A = 'Gate 4 - Al Barsha First - Dubai - UAE';
const B = 'T3 - Dubai Airport - Dubai - UAE';
let n = 0;
/* mins: the gap to write between the two timestamps. dur: a channel-reported
   duration_s, where the fixture wants one. */
const trip = (day, mins, opts = {}) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, duration_s, status, payment_type, price,
     pickup_addr, dropoff_addr)
   VALUES ('uber', $1, 'ecosine', 'L800', 'd-c', 'Corridor Driver',
           $2::timestamptz, $3, 21, $4, 'completed', 'card', NULL, $5, $6)`,
  [`c${++n}`, `2026-08-${day}T09:00:00+04:00`,
    mins == null ? null : `2026-08-${day}T09:00:00+04:00`.replace('09:00', '09:00') , opts.dur ?? null,
    opts.from ?? A, opts.to ?? B]);

/* Written directly rather than through the helper, because the point of each
   row is the exact relationship between its two timestamps. */
const raw = (day, startH, endExpr, dur, from = A, to = B) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, duration_s, status, payment_type, price,
     pickup_addr, dropoff_addr)
   VALUES ('uber', $1, 'ecosine', 'L800', 'd-c', 'Corridor Driver',
           $2::timestamptz, $3::timestamptz, 21, $4, 'completed', 'card', NULL, $5, $6)`,
  [`r${++n}`, `2026-08-${day}T${startH}:00:00+04:00`, endExpr, dur, from, to]);

/* Three honest 30-minute runs. */
for (const d of ['10', '11', '12']) await raw(d, '09', `2026-08-${d}T09:30:00+04:00`, null);
/* An end BEFORE the request — a clock artefact. Counted, it is −60 minutes. */
await raw('13', '09', '2026-08-13T08:00:00+04:00', null);
/* A record that never closed. Counted, it is 1,440 minutes and it alone moves
   a five-trip average from 30 to 312. */
await raw('14', '09', '2026-08-15T09:00:00+04:00', null);
/* And one the channel timed itself, at 40 minutes, whose OWN figure must win
   over the 30 its timestamps imply. */
await raw('16', '09', '2026-08-16T09:30:00+04:00', 2400);

/* A second corridor where nothing records an end at all, so the cell — not the
   whole column — has to say so. */
for (const d of ['17', '18', '19']) {
  await raw(d, '14', null, null, B, A);
}
void trip;

const { get } = await mountAll(db, { serverRoutes: true });
const W = 'from=2026-08-01&to=2026-08-31';
const body = (await get(`/api/geo/corridors?${W}`)).body;
const rows = body.corridors || [];
const ab = rows.find((r) => r.from_area === 'Al Barsha First' && r.to_area === 'Dubai Airport');
const ba = rows.find((r) => r.from_area === 'Dubai Airport' && r.to_area === 'Al Barsha First');

console.log('\ncorridor timing: derived from the record, bounded against its artefacts');

check('the corridor is found', !!ab, JSON.stringify(rows.map((r) => [r.from_area, r.to_area])));
check('a timing is reported at all, where it used to be null on every corridor',
  ab && ab.avg_min != null, String(ab?.avg_min));
/* Four rows survive the bounds: three 30-minute runs and the channel-timed
   40. (30·3 + 40) / 4 = 32.5. */
check('…and it is the mean of the rows that survive the bounds',
  ab && Math.abs(Number(ab.avg_min) - 32.5) < 0.05, String(ab?.avg_min));
check('an end before the request is dropped, not counted as negative time',
  ab && Number(ab.avg_min) > 0, String(ab?.avg_min));
/* Counted, the unclosed record takes the same corridor to 312 minutes. */
check('a record that never closed does not drag the corridor to five hours',
  ab && Number(ab.avg_min) < 60, String(ab?.avg_min));
check('the denominator is the rows that carried a time, not every trip',
  ab && ab.min_n === 4 && ab.trips === 6, `${ab?.min_n} of ${ab?.trips}`);
/* The channel's own duration wins where it files one — 2400s is 40 minutes,
   not the 30 its timestamps imply, and a fold that ignored duration_s would
   give this corridor 30.0 flat. */
check('a channel’s own duration wins over the gap between the timestamps',
  ab && Math.abs(Number(ab.avg_min) - 30) > 0.05, String(ab?.avg_min));
check('and the response says how many were REPORTED rather than derived',
  body.duration_reported === 1 && body.duration_measured === 4,
  JSON.stringify([body.duration_reported, body.duration_measured]));
check('a corridor where nothing records an end reports no time, on its own row',
  ba && ba.avg_min == null && ba.trips === 3, JSON.stringify([ba?.avg_min, ba?.trips]));

console.log('\nand the page names the measure rather than implying a drive time');

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
  const th = [...document.querySelectorAll('th')];
  const t = th.find((x) => /Request|Avg minutes/i.test(x.textContent))?.closest('table');
  return { cols: [...(t?.querySelectorAll('thead th') || [])].map((x) => x.innerText.trim()),
    body: document.body.innerText.replace(/\s+/g, ' ') };
});
check('the timing column is on the page at all',
  (seen?.cols || []).some((c) => /Request|Avg minutes/i.test(c)), (seen?.cols || []).join(' | '));
/* "Avg minutes" beside a figure that contains the approach and the rider's
   wait would be a different claim from the one the data supports. */
check('…named as request-to-dropoff rather than as a drive time',
  (seen?.cols || []).some((c) => /Request/i.test(c))
  && !(seen?.cols || []).some((c) => /^Avg minutes$/i.test(c)), (seen?.cols || []).join(' | '));
check('…and the page says the figure is derived, not filed by a channel',
  /contains the approach/i.test(seen?.body || ''), (seen?.body || '').slice(0, 200));
check('the old sentence claiming no timing exists at all is gone',
  !/no provider's trip duration is stored/i.test(seen?.body || ''));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
