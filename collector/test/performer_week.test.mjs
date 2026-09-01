/* Seventeen months of ranking that had no address.
   ─────────────────────────────────────────────────────────────────────────
   The three performer pages are a Monday-to-Sunday week, and that is right —
   ranking people on a day that is four hours old rewards whoever starts early.
   What was wrong is that the week could never be CHOSEN.

   Three separate faults, each of which hid the next:

   1. api/public/performers.js read `state.week`. There is no such field on
      `state` (api/public/data.js:21) and nothing ever set one, so the value
      was `undefined` on every visit and the page fell to the newest week.

   2. It fetched /api/performer/weeks on the line above and then used only
      `latest_complete`. The list of weeks — the entire point of that endpoint
      — was fetched and dropped. No control offered it and no address named it.

   3. The endpoint itself stopped after twenty-six weeks, a horizon nobody had
      chosen, while trip_norm reached back seventeen months. Even a picker
      would not have shown the older half.

   And under all three, the drill-down dropped the week entirely: a reader who
   ranked March, read the list and opened somebody in it landed on that
   person's CURRENT week — frequently "No booking in this week" for a man they
   were looking at a moment earlier.

   The assertions below are on the PROPERTY, not on any literal week: this
   file's fixture is anchored to a fixed first booking but its newest week is
   whatever the clock says, so anything pinned to a date string would pass
   today and fail next Monday. */
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

const iso = (d) => d.toISOString().slice(0, 10);
const mondayOf = (d) => {
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow, 12));
};
/* The same week the endpoint calls the newest complete one, derived here from
   the clock rather than written down, so this file does not go stale. */
const NOW = new Date(Date.now() + 4 * 3600e3);
const LAST_MON = new Date(mondayOf(NOW).getTime() - 7 * 864e5);
const LAST_WEEK = iso(LAST_MON);
/* A Monday seventeen months before it — comfortably past the old cap of 26. */
const OLD_MON = new Date(mondayOf(new Date(LAST_MON.getTime() - 520 * 864e5)).getTime());
const OLD_WEEK = iso(OLD_MON);

let n = 0;
const trip = (drv, name, day, price) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, pickup_addr, dropoff_addr, distance_km, status, price, raw)
   VALUES ('hotel', $1, 'ecosine', 'L900', $2, $3, $4::timestamptz,
           $4::timestamptz + interval '22 min',
           'A - Business Bay - Dubai - UAE', 'B - Deira - Dubai - UAE',
           14, 'completed', $5, '{}'::jsonb)`,
  [`pw${++n}`, drv, name, `${day}T09:00:00+04`, price]);

const spread = async (drv, name, monday) => {
  for (let d = 0; d < 6; d++) {
    const day = iso(new Date(new Date(`${monday}T12:00:00Z`).getTime() + d * 864e5));
    for (let i = 0; i < 5; i++) await trip(drv, name, day, 130);
  }
};
/* Two people, two weeks, no overlap: whichever week the page is showing, the
   OTHER person must not be in it. A ranking that silently answers for the
   newest week is otherwise indistinguishable from one that honoured the ask. */
await spread('old-1', 'Marwan Al Qassimi', OLD_WEEK);
await spread('new-1', 'Idris Ferreira', LAST_WEEK);
await refreshRollups({ db });

const { app: apiApp, get } = await mountAll(db, { serverRoutes: true });
void apiApp;

console.log('\nperformer weeks: the list reaches as far back as the bookings do');

const wks = (await get('/api/performer/weeks')).body;
const weeks = wks.weeks || [];
check('the endpoint names how far back the bookings go',
  wks.first_booking === OLD_WEEK, `${wks.first_booking} vs ${OLD_WEEK}`);
check('every week offered is a Monday',
  weeks.every((w) => new Date(`${w.week}T12:00:00Z`).getUTCDay() === 1), String(weeks.length));
check('they are contiguous, newest first',
  weeks.every((w, i) => i === 0
    || new Date(`${weeks[i - 1].week}T12:00:00Z`) - new Date(`${w.week}T12:00:00Z`) === 7 * 864e5),
  String(weeks.length));
/* The property, not the number: as many complete weeks as lie between the
   first booking and the newest complete week. The old code returned 26 of them
   whatever the answer was. */
const expected = Math.round(
  (new Date(`${wks.latest_complete}T12:00:00Z`) - new Date(`${OLD_WEEK}T12:00:00Z`)) / (7 * 864e5)) + 1;
check('the list is every complete week back to the first booking, not a fixed count',
  weeks.length === expected, `${weeks.length} offered, ${expected} between the two ends`);
check('…which is more than the twenty-six it used to stop at',
  weeks.length > 26, String(weeks.length));
check('the oldest week offered is the one the first booking falls in',
  weeks[weeks.length - 1]?.week === OLD_WEEK, weeks[weeks.length - 1]?.week);

console.log('\nperformer: the week asked for is the week answered');

const dflt = (await get('/api/performer?id=old-1')).body;
check('with no week the answer is the newest complete one',
  dflt.week?.[0] === wks.latest_complete, String(dflt.week));
check('…so this person, who drove seventeen months ago, has no day in it',
  (dflt.days || []).length === 0, `${(dflt.days || []).length} days`);

const asked = (await get(`/api/performer?id=old-1&week=${OLD_WEEK}`)).body;
check('with a week the answer is THAT week', asked.week?.[0] === OLD_WEEK, String(asked.week));
check('…and the days in it are that person’s',
  (asked.days || []).length === 6, `${(asked.days || []).length} days`);
check('…each falling inside the seven days named',
  (asked.days || []).every((d) => String(d.day) >= OLD_WEEK && String(d.day) <= asked.week[1]),
  (asked.days || []).map((d) => d.day).join(','));
check('…and the bookings are the ones seeded, not a subset',
  asked.bookings === 30, String(asked.bookings));

console.log('\nthe page: a control that offers those weeks, and carries the choice');

const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => get(`/api${req.url}`)
  .then((r) => res.status(r.status).json(r.body))
  .catch((e) => res.status(500).json({ error: String(e) })));
const server = shell.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1440, height: 1400 } });
const go = async (hash) => {
  await page.goto(`${base}/?ui=desktop${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
};

await go('#top-performers');
const opts = await page.evaluate(() =>
  [...document.querySelectorAll('select option')].map((o) => o.value).filter((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)));
check('the page renders a week control at all', opts.length > 0, String(opts.length));
check('…offering every week the endpoint does, not the newest alone',
  opts.length === weeks.length, `${opts.length} in the page, ${weeks.length} from the endpoint`);
check('…including the oldest', opts.includes(OLD_WEEK), opts.slice(-3).join(','));

const bodyOf = () => page.evaluate(() => document.body.innerText);
const nowText = await bodyOf();
check('the default week ranks the person who drove in it',
  /Idris Ferreira/.test(nowText) && !/Marwan Al Qassimi/.test(nowText));

await go(`#top-performers/${OLD_WEEK}`);
const oldText = await bodyOf();
/* The whole fix, in one assertion: an address naming a week seventeen months
   back ranks THAT week. Before it, this page showed the current week whatever
   the address said. */
check('an address naming an old week ranks that week',
  /Marwan Al Qassimi/.test(oldText) && !/Idris Ferreira/.test(oldText),
  oldText.slice(0, 120).replace(/\n/g, ' '));

const link = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('tbody tr')];
  const r = rows.find((x) => /Marwan/.test(x.textContent));
  if (!r) return null;
  r.click();
  return location.hash;
});
check('clicking a ranked row carries the week into the drill-down',
  /^#performer\/[^/]+\/\d{4}-\d{2}-\d{2}/.test(link || ''), String(link));
check('…and it is the week that was being ranked',
  (link || '').includes(OLD_WEEK), String(link));

await page.waitForTimeout(3500);
const drillText = await bodyOf();
check('the person’s page shows the week it was opened for',
  new RegExp(String(OLD_MON.getUTCFullYear())).test(drillText)
  && !/No booking in the week/.test(drillText),
  drillText.slice(0, 200).replace(/\n/g, ' '));
/* The sub-line was the raw ISO string on a page that writes "Apr 7, 2025" in
   every date column it owns. */
check('…and names its days the way every other date on the page is written',
  !new RegExp(`week of ${OLD_WEEK}`).test(drillText), 'raw ISO in the week sub-line');

const crumb = await page.evaluate(() =>
  document.querySelector('#crumb a, .crumb a')?.getAttribute('href') || '');
check('the crumb back to the ranking keeps the week',
  crumb.includes(OLD_WEEK), crumb);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
