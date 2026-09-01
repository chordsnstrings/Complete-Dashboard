/* ── the comparison that would have cried wolf every morning ───────────────
   "Yesterday against today" is two queries and a subtraction only if you are
   willing to be wrong before lunch. At 11:00 Dubai today holds seven hours of
   work and yesterday holds twenty-four, and the subtraction reports the whole
   fleet down 70% — every morning, for the rest of the product's life.

   So /api/compare cuts BOTH days at the same Dubai wall-clock minute. These
   assertions drive the cut from both sides: that it actually excludes the late
   rows on the earlier day, that the uncut total is still available beside it,
   and that `cut=full` gives the reader back the unfair comparison when they
   deliberately ask for it.

   The other three are the ones a plain join gets wrong:

   - A driver who worked one day and not the other must come back as a ROW WITH
     A ZERO. As an absent row they are invisible, and they are the single most
     actionable thing on the page.
   - Waiting is summed from the GAPS, never as elapsed minus on-trip. Two
     bookings that overlap make that subtraction negative, and on this fleet
     they overlap constantly.
   - A day is a DUBAI day. A trip at 01:00 Dubai belongs to that date, not to
     the UTC one four hours behind it. */
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

const A = '2026-08-25';           // the later day
const B = '2026-08-24';           // the baseline

let n = 0;
/* `at` and `end` are written with an explicit +04:00 offset, so the fixture
   states Dubai local time and the database does the conversion — the same way
   every source's payload arrives. */
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status, price, payment_type)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [o.platform || 'uber', `c${n++}`, o.plate || 'L100', o.drv, o.name || `Driver ${o.drv}`,
    o.at, o.end || null, o.km ?? 10, o.status || 'completed', o.price ?? null, o.pay || null]);

/* ── EARLY, the part of each day that falls before the cut ──────────────── */
// Two people work the morning of both days. `early` does more on the baseline
// day than on the later one, so a real fall exists to be measured.
await trip({ drv: 'd-steady', at: `${B}T08:00:00+04:00`, end: `${B}T08:30:00+04:00` });
await trip({ drv: 'd-steady', at: `${B}T09:30:00+04:00`, end: `${B}T10:00:00+04:00` });
await trip({ drv: 'd-steady', at: `${A}T08:00:00+04:00`, end: `${A}T08:30:00+04:00` });
await trip({ drv: 'd-steady', at: `${A}T09:30:00+04:00`, end: `${A}T10:00:00+04:00` });

/* ── LATE, after the cut. Only on the baseline day, which is the whole point:
      these are the rows that make an unfair comparison look like a collapse. */
for (let i = 0; i < 6; i++) {
  await trip({ drv: 'd-steady', at: `${B}T${String(16 + i).padStart(2, '0')}:00:00+04:00`,
    end: `${B}T${String(16 + i).padStart(2, '0')}:40:00+04:00` });
}

/* ── STOPPED: worked the baseline day, has not appeared on the later one. */
await trip({ drv: 'd-stopped', at: `${B}T07:00:00+04:00`, end: `${B}T07:40:00+04:00`, plate: 'L200' });
await trip({ drv: 'd-stopped', at: `${B}T09:00:00+04:00`, end: `${B}T09:20:00+04:00`, plate: 'L200' });

/* ── STARTED: first appears on the later day. */
await trip({ drv: 'd-started', at: `${A}T07:15:00+04:00`, end: `${A}T07:45:00+04:00`, plate: 'L300' });

/* ── OVERLAP: the next request arrives BEFORE the previous dropoff. Elapsed
      minus on-trip is negative for this person; the gap sum is not. */
await trip({ drv: 'd-overlap', at: `${A}T06:00:00+04:00`, end: `${A}T07:00:00+04:00`, plate: 'L400' });
await trip({ drv: 'd-overlap', at: `${A}T06:45:00+04:00`, end: `${A}T07:30:00+04:00`, plate: 'L400' });
// …then a real 90-minute wait, so there is one positive gap to sum as well.
await trip({ drv: 'd-overlap', at: `${A}T09:00:00+04:00`, end: `${A}T09:30:00+04:00`, plate: 'L400' });

/* ── MIDNIGHT: 01:00 Dubai on the later day is 21:00 UTC on the baseline day.
      A UTC-keyed comparison files this under the wrong date entirely. */
await trip({ drv: 'd-night', at: `${A}T01:00:00+04:00`, end: `${A}T01:40:00+04:00`, plate: 'L500' });

/* ── A CHANNEL THAT REPORTS MONEY, beside Uber which reports none. */
await trip({ drv: 'd-steady', platform: 'hotel', at: `${A}T08:45:00+04:00`,
  end: `${A}T09:10:00+04:00`, price: 240, pay: 'room-charge', plate: 'L100' });
await trip({ drv: 'd-steady', platform: 'hotel', at: `${B}T08:45:00+04:00`,
  end: `${B}T09:10:00+04:00`, price: 300, pay: 'room-charge', plate: 'L100' });

/* ── THE MONEY THE UBER ROWS DO CARRY ─────────────────────────────────────
   None of the Uber trips above has a price, because the export has no price
   column — which left the By channel panel's only money column reading "no
   fare reported" against 89% of a real day's bookings. The money exists one
   table away: driver_payout_day is the weekly statement spread across the days
   it covers, and for days older than the platform feeds reach, the operator's
   own ledger import in driver_statement_day.

   Both are seeded here, on DIFFERENT days, so a column that shows one and
   silently drops the other fails. */
await q(`INSERT INTO driver_payout_day
           (platform, fleet_id, driver_ext_id, driver_name, day, period_start, period_end,
            period_days, earnings, period_earnings, trips)
         VALUES ('uber','ecosine','d-steady','Steady', $1::date, $1::date, $1::date, 1, 780, 780, 9)`,
  [A]);
await q(`INSERT INTO driver_statement_day
           (platform, fleet_id, driver_name, driver_ext_id, day, net, source)
         VALUES ('uber','ecosine','Steady','d-steady', $1::date, 615, 'ledger')`, [B]);

const { server, get: raw } = await mountAll(db, { serverRoutes: false });
const get = (qs) => raw(`/api/compare?${qs}`);

/* A cut at 12:00 keeps the morning of both days and drops the baseline day's
   afternoon — which is exactly the shape of "it is noon and today is not
   over". */
console.log('\ncompare: the cut is the whole point');
const noon = (await get(`a=${A}&b=${B}&cut=720`)).body;

check('the cut it applied is the cut it reports, in minutes and as a clock time',
  noon.cut_minutes === 720 && noon.cut_label === '12:00', JSON.stringify([noon.cut_minutes, noon.cut_label]));
check('and it says so in words, on the page, rather than in a tooltip',
  /12:00/.test(noon.cut_note || '') && /both days/i.test(noon.cut_note || ''), noon.cut_note);
check('the baseline day\'s afternoon is EXCLUDED — six trips after 16:00 do not count',
  noon.totals.b.bookings === 5, JSON.stringify(noon.totals.b.bookings));
/* The clearest statement of why this route exists. Uncut, the later day is 8
   against 11 and the page would report the fleet DOWN 27%. Cut at noon it is
   8 against 5 and the fleet is UP — because the eleven includes six trips the
   baseline day had not yet done at the hour being compared. Same data, same
   two days, opposite verdicts, and only one of them is honest. */
check('and the cut REVERSES the verdict: 8 vs 11 uncut reads as a fall, 8 vs 5 '
  + 'at the same hour is a rise',
  noon.totals.a.bookings === 8 && noon.totals.b.bookings === 5
  && noon.full_day.b.bookings === 11,
  JSON.stringify([noon.totals.a.bookings, noon.totals.b.bookings, noon.full_day.b.bookings]));
check('the WHOLE baseline day is still returned beside it, so nothing is hidden '
  + 'by the cut', noon.full_day.b.bookings === 11, JSON.stringify(noon.full_day.b));

const full = (await get(`a=${A}&b=${B}&cut=full`)).body;
check('cut=full gives the reader the uncut comparison they deliberately asked for',
  full.cut_minutes === 1440 && full.totals.b.bookings === 11,
  JSON.stringify([full.cut_minutes, full.totals.b.bookings]));
check('and says the days were counted in full',
  /in full/i.test(full.cut_note || ''), full.cut_note);

console.log('\ncompare: a day is a Dubai day');
check('01:00 Dubai belongs to that Dubai date, not to the UTC day four hours behind',
  full.drivers.some((r) => r.driver_ext_id === 'd-night' && r.a.bookings === 1 && r.b.bookings === 0),
  JSON.stringify(full.drivers.find((r) => r.driver_ext_id === 'd-night')));

console.log('\ncompare: somebody who stopped is a row, not an absence');
const stopped = full.drivers.find((r) => r.driver_ext_id === 'd-stopped');
check('a driver who worked the baseline day and not the later one is IN the list',
  Boolean(stopped), JSON.stringify(full.drivers.map((r) => r.driver_ext_id)));
check('with a zero on the later day rather than a missing side',
  stopped && stopped.a.bookings === 0 && stopped.b.bookings === 2);
check('flagged, so the page can mark the row without recomputing it',
  stopped && stopped.worked_b === true && stopped.worked_a === false);
check('and named in its own list, which is the list somebody works through',
  full.stopped.length === 1 && full.stopped[0].driver_ext_id === 'd-stopped',
  JSON.stringify(full.stopped));
check('the plate they were holding comes with them — an idle car is the other '
  + 'half of that phone call',
  (full.stopped[0].plates || []).includes('L200'), JSON.stringify(full.stopped[0].plates));
check('and the reverse: somebody new on the later day is listed as started, and '
  + 'nobody appears in both lists',
  full.started.some((r) => r.driver_ext_id === 'd-started')
  && !full.started.some((r) => r.driver_ext_id === 'd-stopped')
  && !full.stopped.some((r) => full.started.some((s2) => s2.driver_ext_id === r.driver_ext_id)),
  JSON.stringify(full.started.map((r) => r.driver_ext_id)));

console.log('\ncompare: waiting is summed from the gaps, never subtracted');
const ov = full.drivers.find((r) => r.driver_ext_id === 'd-overlap');
/* 06:00–07:00, 06:45–07:30, 09:00–09:30. Gap one is 07:00 → 06:45 = −15
   minutes, an overlap. Gap two is 07:30 → 09:00 = 90 minutes of waiting. */
check('an overlapping dispatch is COUNTED, not clamped and not discarded',
  ov && ov.a.overlaps === 1, JSON.stringify(ov && ov.a));
check('and it does not make waiting negative — only the positive gap is summed',
  ov && ov.a.wait_min === 90, JSON.stringify(ov && ov.a.wait_min));
check('elapsed minus on-trip would have disagreed, which is why it is not used',
  ov && (() => {
    const elapsed = (new Date(ov.a.last_trip) - new Date(ov.a.first_trip)) / 60000;
    return elapsed - ov.a.on_trip_min !== ov.a.wait_min;
  })());
check('the longest single gap is reported as well as the total',
  ov && ov.a.longest_wait_min === 90, JSON.stringify(ov && ov.a.longest_wait_min));

console.log('\ncompare: money says which rows it describes');
check('fares come only from the channel that reports one',
  full.totals.a.fares === 240 && full.totals.b.fares === 300,
  JSON.stringify([full.totals.a.fares, full.totals.b.fares]));
check('and the priced count is returned, so the page can say how little of the '
  + 'work that covers',
  full.totals.a.priced === 1 && full.totals.a.bookings > 1,
  JSON.stringify([full.totals.a.priced, full.totals.a.bookings]));

console.log('\ncompare: the rest of the contract');
check('rows are ordered by the SIZE of the change, so the top of the table moved most',
  full.drivers.length > 1
  && Math.abs(full.drivers[0].d_bookings) >= Math.abs(full.drivers[full.drivers.length - 1].d_bookings),
  JSON.stringify(full.drivers.map((r) => r.d_bookings)));
check('every hour of the day is present, including the empty ones — a bar chart '
  + 'that omits a quiet hour draws the next one beside it',
  full.hours.length === 24 && full.hours[3].hour === 3);
check('collector freshness rides along, because a quiet day and an uncollected '
  + 'day look identical on every chart',
  Array.isArray(full.collectors));
check('two identical days are refused rather than compared with themselves',
  (await get(`a=${A}&b=${A}`)).status === 400);
check('a nonsense day falls back to today rather than 500ing',
  (await get('a=not-a-date')).status === 200);

const oneFleet = (await get(`a=${A}&b=${B}&cut=full&fleet=egari`)).body;
check('the fleet filter reaches every query, not just the headline',
  oneFleet.totals.a.bookings === 0 && oneFleet.drivers.length === 0,
  JSON.stringify(oneFleet.totals.a.bookings));

/* ── the same arithmetic, on the page it was written for ──────────────────
   /api/performer computes waiting with the identical window function, and its
   day rows are joined to the gap rows by a day key. That key was a JS Date on
   one side and text on the other for exactly as long as nobody looked, and the
   failure mode is silent: every waiting figure on the drill-down reads "—",
   which is indistinguishable from a driver who took no break. */
console.log('\nperformer: the drill-down agrees with the comparison');
const perf = await raw(`/api/performer?id=d-overlap&week=${B}`);
check('the performer week loads for somebody the compare page links to',
  perf.status === 200, JSON.stringify(perf.body).slice(0, 120));
const pd = (perf.body.days || []).find((d) => d.day === A);
check('and its day row carries the SAME waiting minutes the comparison reported',
  pd && pd.wait_min === ov.a.wait_min, JSON.stringify([pd && pd.wait_min, ov.a.wait_min]));
check('the overlap is reported there too, rather than silently absorbed',
  pd && pd.overlaps === 1, JSON.stringify(pd && pd.overlaps));
check('and the week total is the sum of its days, not a second query that can '
  + 'disagree with them',
  perf.body.wait_min === (perf.body.days || []).reduce((a2, d) => a2 + (d.wait_min || 0), 0),
  JSON.stringify([perf.body.wait_min, (perf.body.days || []).map((d) => d.wait_min)]));

/* ── the By channel money column ──────────────────────────────────────── */
console.log('\ncompare: the channel that publishes no fare still reports its money');
const money = (await get(`a=${A}&b=${B}&cut=1440`)).body;
const uber = (money.platforms || []).find((r) => r.platform === 'uber');
const hotel = (money.platforms || []).find((r) => r.platform === 'hotel');

check('the Uber rows still carry no fare, because the export carries none',
  uber && uber.a.fares == null && uber.b.fares == null, JSON.stringify(uber && [uber.a.fares, uber.b.fares]));
check('the day inside the payout horizon reports the statement’s share',
  Number(uber?.a.paid) === 780, String(uber?.a.paid));
check('the day outside it reports the operator’s ledger instead',
  uber?.b.paid == null && Number(uber?.b.statement_net) === 615,
  JSON.stringify([uber?.b.paid, uber?.b.statement_net]));
/* Two measures of the same money on the same row would be added by anybody
   reading the JSON, so only one of them is ever present per day. */
check('…and never both on the same day',
  (money.platforms || []).every((r) => [r.a, r.b].every((x) => !(x.paid != null && x.statement_net != null))),
  JSON.stringify(money.platforms));
check('the fares are not touched by any of it',
  Number(hotel?.a.fares) === 240 && Number(hotel?.b.fares) === 300,
  JSON.stringify(hotel && [hotel.a.fares, hotel.b.fares]));
check('a channel with fares and no statement reports no payout rather than zero',
  hotel?.a.paid == null && hotel?.a.statement_net == null, JSON.stringify(hotel?.a));

/* ── and the column actually appears ──────────────────────────────────────
   The first cut of this shipped a Paid column that never rendered. tableFrom
   PRUNES a column that declares `absent` and whose KEY is empty on every row
   (ui.js:187), and for that decision it reads the key rather than running the
   renderer — so a column keyed 'paid' whose money lives under r.a / r.b was
   dropped from every render, silently, with the endpoint answering correctly
   the whole time. Asserting the JSON was not enough; this asserts the cell. */
console.log('\ncompare: the money column reaches the page');
const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => raw(`/api${req.url}`)
  .then((x) => res.status(x.status).json(x.body))
  .catch((e) => res.status(500).json({ error: String(e) })));
const web = shell.listen(0);
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1500, height: 1400 } });
await page.goto(`http://127.0.0.1:${web.address().port}/?ui=desktop#compare/${A}/${B}?cut=full`,
  { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
const panel = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h3')].find((x) => /By channel/i.test(x.textContent));
  const el2 = h?.closest('.panel');
  if (!el2) return null;
  return {
    cols: [...el2.querySelectorAll('thead th')].map((x) => x.innerText.trim()),
    body: el2.innerText.replace(/\n/g, ' '),
  };
});
check('the By channel panel rendered', !!panel, String(panel));
/* One money column, not two: this panel is half a page wide and a fifth
   column puts it into horizontal scroll, which is the reason the kilometres
   column is not here either. */
check('…with one money column carrying every basis',
  (panel?.cols || []).some((c) => /^Money$/i.test(c))
  && !(panel?.cols || []).some((c) => /^Fares$/i.test(c)),
  (panel?.cols || []).join(' | '));
check('…and no fifth column pushing the table sideways',
  (panel?.cols || []).length <= 4, (panel?.cols || []).join(' | '));
check('…carrying the statement share for the day inside the horizon',
  /780/.test(panel?.body || ''), (panel?.body || '').slice(0, 200));
check('…and the ledger import for the day outside it, marked as one',
  /615/.test(panel?.body || '') && /ldg/.test(panel?.body || ''), (panel?.body || '').slice(0, 200));
check('…and the channel that DOES price its trips still shows its fare',
  /240/.test(panel?.body || '') && /300/.test(panel?.body || ''), (panel?.body || '').slice(0, 300));

/* And it FITS. Measured on production at 1600px, the money cell needed 660px
   of a 593px half — so the column the panel exists to show sat 67px off the
   edge and the page told the reader to scroll for it. The panel takes the
   wider half of the grid now and the currency is written once per cell. This
   asserts the scroller, not the table: the table element is as wide as its
   content by definition and always reports that it fits. */
const cut = await page.evaluate(() => {
  const h = [...document.querySelectorAll('h3')].find((x) => /By channel/i.test(x.textContent));
  const w = h?.closest('.panel')?.querySelector('.tscroll');
  return w ? w.scrollWidth - w.clientWidth : null;
});
check('the money column is on screen, not 67px past the edge',
  cut != null && cut <= 2, `${cut}px of the table is cut off`);
check('…and the page does not tell the reader to scroll for it',
  !/Scroll the table sideways/.test(panel?.body || ''),
  (panel?.body || '').match(/Scroll the table sideways[^.]*\./)?.[0] || '');

await browser.close();
web.close();
server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
