/* The trip list — the record, browsable.
   ─────────────────────────────────────────────────────────────────────────
   Every number this product shows is an aggregate of one table, and until now
   that table could not be read. An operator asking "what happened on that
   job" had a driver page, a vehicle page, and a CSV. Twelve thousand
   bookings, and no list of them.

   The failure modes guarded here are the ones list endpoints always have:
   `total` quietly reporting the page size instead of the window — which turns
   "12,641 trips" into "100 trips" and nobody notices, because a hundred rows
   are on screen; a second page that repeats the first; a search that matches
   nothing because the term was compared case-sensitively; and telematics
   journeys counted as bookings, which doubles the fleet.

   Both halves are checked — the route, and then the real page rendered
   against the real route — because the join is where this product's worst
   bugs have lived.

   Every date here is relative to the day the suite runs. Fixed dates would
   make the browser half of this file pass only while "today" happened to sit
   inside the seeded month; the front end has no way to be told a window other
   than the one a reader could pick, so the data is placed where a reader's
   own picks will find it. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { applySchema } from './schema.mjs';
import { readFileSync } from 'node:fs';
import { mountAll } from './mount.mjs';
import { launchChromium } from './browser.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* A Dubai calendar day, n days back. The product stores and groups on Dubai
   days, so a fixture that counts in UTC days seeds rows either side of a
   boundary the assertions do not know about. */
const DAY = (n) => new Intl.DateTimeFormat('en-CA',
  { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() - n * 864e5));

let n = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, pickup_addr, dropoff_addr, distance_km, status, price, currency, raw)
   VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz + interval '20 min',
           $8,$9,$10,$11,$12,'AED','{}'::jsonb)`,
  [o.platform, `x${++n}`, o.fleet || 'ecosine', o.plate, o.drv, o.name,
    o.at, o.from, o.to, o.km ?? 10, o.status || 'completed', o.price ?? null]);

/* ── the counted fixture, far enough back that nothing a reader can pick
      overlaps it: ten days, four Uber bookings each (one a cancellation),
      one hotel booking each, one FMS journey each. 50 bookings, 10 journeys. */
const OLD_FROM = DAY(209), OLD_TO = DAY(200);
for (let d = 0; d < 10; d++) {
  const day = DAY(209 - d);
  for (let i = 0; i < 4; i++) {
    await trip({ platform: 'uber', plate: `L${i}`, drv: `u${i}`, name: `Driver ${i}`,
      at: `${day}T0${i + 5}:00:00+04`, from: 'X - Deira - Dubai - UAE', to: 'Y - Al Barsha - Dubai - UAE',
      status: i === 3 ? 'rider_cancelled' : 'completed' });
  }
  await trip({ platform: 'hotel', fleet: 'egari', plate: 'L0', drv: 'h1', name: 'Hotel Hand',
    at: `${day}T12:00:00+04`, from: 'Q - Al Garhoud - Dubai - UAE', to: 'Z - Dubai Marina - Dubai - UAE',
    price: 150 });
  await trip({ platform: 'fms', plate: `L${d % 4}`, drv: `u${d % 4}`, name: `Driver ${d % 4}`,
    at: `${day}T20:00:00+04`, from: 'X - Deira - Dubai - UAE', to: 'Y - Al Barsha - Dubai - UAE' });
}
/* One booking outside that window, so "does the window apply" is answerable. */
await trip({ platform: 'uber', plate: 'LZZ', drv: 'uz', name: 'Out Of Window',
  at: `${DAY(250)}T09:00:00+04`, from: 'X - Deira - Dubai - UAE', to: 'Y - Al Barsha - Dubai - UAE' });

/* ── the browsable fixture: more bookings than fit on a page, inside the last
      week, so the range control's own choices reach them. Mixed channels,
      because a list that only ever sees one channel cannot show the bug where
      it silently shows one channel. */
for (let i = 0; i < 130; i++) {
  const hotel = i % 10 === 0;
  await trip({
    platform: hotel ? 'hotel' : 'uber', fleet: hotel ? 'egari' : 'ecosine',
    plate: `M${i % 7}`, drv: `m${i % 7}`, name: `Recent Driver ${i % 7}`,
    at: `${DAY(i % 6)}T${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00+04`,
    from: 'R - Business Bay - Dubai - UAE', to: 'S - Al Quoz - Dubai - UAE',
    price: hotel ? 150 : null, status: i % 25 === 0 ? 'rider_cancelled' : 'completed',
  });
}
for (let i = 0; i < 12; i++) {
  await trip({ platform: 'fms', plate: `M${i % 7}`, drv: `m${i % 7}`, name: `Recent Driver ${i % 7}`,
    at: `${DAY(i % 6)}T23:0${i % 6}:00+04`, from: 'R - Business Bay - Dubai - UAE', to: 'S - Al Quoz - Dubai - UAE' });
}

const { get } = await mountAll(db, { serverRoutes: true });
const WIN = `from=${OLD_FROM}&to=${OLD_TO}`;
const list = async (extra = '') => (await get(`/api/trips/list?${WIN}${extra}`)).body;

console.log('\n/api/trips/list');
const base = await list();
check('answers rows', Array.isArray(base.rows) && base.rows.length > 0, JSON.stringify(base).slice(0, 120));
check('counts bookings, not journeys', base.total === 50, `total ${base.total}`);
check('shown is the page, total is the window', base.shown === base.rows.length && base.total >= base.shown,
  `${base.shown}/${base.total}`);
check('the window applies — the older booking is not in it',
  !base.rows.some((r) => String(r.plate) === 'LZZ'));
check('and neither is this week', !base.rows.some((r) => String(r.plate).startsWith('M')));
check('newest first', base.rows.every((r, i) => i === 0
  || new Date(base.rows[i - 1].requested_at) >= new Date(r.requested_at)));
check('carries the channel on the row', base.rows.every((r) => !!r.platform));
check('carries the fleet on the row', base.rows.every((r) => !!r.fleet_id));
check('says how many of THIS page carry a fare', base.priced === base.rows.filter((r) => r.has_fare).length,
  `priced ${base.priced}`);
check('explains the empty fare column once', /no fare column|publishes one/i.test(base.note || ''));
check('echoes the window it answered for',
  base.window?.from === OLD_FROM && base.window?.to === OLD_TO, JSON.stringify(base.window));

console.log('\nkind');
const tele = await list('&kind=telematics');
check('telematics is its own population', tele.total === 10, `total ${tele.total}`);
check('telematics rows are not bookings', tele.rows.every((r) => r.is_booking === false));
const both = await list('&kind=all');
check('both = bookings + journeys', both.total === base.total + tele.total, `total ${both.total}`);

console.log('\npaging');
const p1 = await list('&limit=20&offset=0');
const p2 = await list('&limit=20&offset=20');
const p3 = await list('&limit=20&offset=40');
check('a page is the size asked for', p1.shown === 20, `shown ${p1.shown}`);
check('total does not shrink to the page', p1.total === 50 && p2.total === 50, `${p1.total}/${p2.total}`);
check('page two is not page one',
  new Set([...p1.rows, ...p2.rows].map((r) => r.external_id)).size === 40);
check('truncated while there is more', p1.truncated === true && p2.truncated === true);
check('not truncated at the end', p3.truncated === false && p3.shown === 10, `${p3.shown}`);
check('offset is echoed', p2.offset === 20);
check('limit is clamped, not trusted', (await list('&limit=99999')).limit === 500);
check('a zero limit does not empty the page', (await list('&limit=0')).limit === 100);
check('a negative offset reads as the start', (await list('&offset=-5')).offset === 0);

console.log('\nsearch');
const byPlate = await list('&q=L0');
check('search by plate narrows', byPlate.total < base.total && byPlate.total > 0, `total ${byPlate.total}`);
check('search by plate matches the plate', byPlate.rows.every((r) => /L0/i.test(r.plate || '')));
const byName = await list('&q=hotel hand');
check('search by driver name is case-insensitive', byName.total === 10, `total ${byName.total}`);
const byPlace = await list('&q=garhoud');
check('search by place matches an address', byPlace.total === 10, `total ${byPlace.total}`);
check('a search that matches nothing says so, and does not fall back to everything',
  (await list('&q=zzzznothing')).total === 0);
/* 40 Uber bookings run Deira → Al Barsha; the ten FMS journeys run the same
   road and must not be counted, and neither must the one outside the window. */
check('search still respects the window and the kind',
  (await list('&q=deira')).total === 40, String((await list('&q=deira')).total));

console.log('\noutcome and channel');
check('completed excludes the cancellations', (await list('&outcome=completed')).total === 40,
  String((await list('&outcome=completed')).total));
check('not completed is the cancellations', (await list('&outcome=not_completed')).total === 10,
  String((await list('&outcome=not_completed')).total));
check('an outcome nobody offers is ignored, not injected',
  (await list("&outcome=' OR 1=1--")).total === 50);
check('the channel chip applies', (await list('&platform=hotel')).total === 10);
check('the fleet chip applies', (await list('&fleet=egari')).total === 10);

/* ── the page, against the same routes ───────────────────────────────── */
console.log('\nthe page');
const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => get(`/api${req.url}`)
  .then((r) => res.status(r.status).json(r.body))
  .catch((e) => res.status(500).json({ error: String(e) })));
const server = shell.listen(0);
const url = `http://127.0.0.1:${server.address().port}`;

/* The window the browser will be asked for, and the answer the route gives
   for it — so the assertions compare the page against the API rather than
   against a number written down twice. */
const api = (await get('/api/trips/list?days=7&limit=100&offset=0')).body;
const api2 = (await get(`/api/trips/list?days=7&limit=100&offset=100`)).body;

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1500, height: 1400 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
await page.goto(`${url}/?ui=desktop#trips?days=7`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#view table tbody tr', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);

const fmtNum = (v) => Number(v).toLocaleString('en-US');
const read = () => page.evaluate(() => ({
  tiles: [...document.querySelectorAll('#view .kpi')].map((k) => k.innerText.replace(/\n/g, ' | ')),
  rows: document.querySelectorAll('#view table tbody tr').length,
  channels: [...new Set([...document.querySelectorAll('#view table tbody tr')]
    .map((r) => (r.children[1]?.innerText || '').split('·')[0].trim()))],
  text: document.querySelector('#view').innerText,
}));
const v = await read();
check('the page rendered without throwing', errs.length === 0, errs.join(' | '));
check('the route has more than one page to give', api.truncated === true && api.total > 100, `total ${api.total}`);
check('the page drew a row per trip on the page', v.rows === api.shown, `${v.rows} vs ${api.shown}`);
check('the tile shows the WINDOW total, not the page',
  v.tiles[0].includes(String(api.total)) && !v.tiles[0].includes(`| ${api.shown} |`),
  `${v.tiles[0]} — api total ${api.total}`);
check('the second tile is the page, and says which rows',
  v.tiles[1].includes(String(api.shown)) && /rows 1/.test(v.tiles[1]), v.tiles[1]);
check('the channel is on the row, not only in a chip above', v.channels.length > 1, v.channels.join(','));
check('a fare shows where the channel publishes one', /AED\s*150/.test(v.text));
check('and a dash where it does not', (v.text.match(/—/g) || []).length > 5);
check('the page agrees with the route about how many carry a fare',
  v.tiles[2].includes(String(api.priced)), `${v.tiles[2]} — api priced ${api.priced}`);
check('the CSV of the same rows is offered', /Download every trip/i.test(v.text));

/* Search, driven through the real box. */
/* A term that matches SOME of the window. Matching none would let every
   assertion below pass on an empty table. */
await page.fill('#view input[type=search]', 'm3');
await page.waitForTimeout(900);
const searched = (await get('/api/trips/list?days=7&q=m3&limit=100')).body;
const s = await read();
check('the search term matches part of the window, not none of it and not all',
  searched.total > 0 && searched.total < api.total, `${searched.total} of ${api.total}`);
check('typing in the box filters the table', s.rows === searched.shown && s.rows < v.rows,
  `${s.rows} vs ${searched.shown}`);
check('and the count follows the search', s.tiles[0].includes(String(searched.total)), s.tiles[0]);
check('and says it is a search, not the window', /Matching this search/i.test(s.tiles[0]), s.tiles[0]);

await page.fill('#view input[type=search]', '');
await page.waitForTimeout(900);

/* Paging, driven through the real buttons. */
const first = await page.evaluate(() => document.querySelector('#view table tbody tr')?.innerText || '');
await page.evaluate(() => [...document.querySelectorAll('#view button')]
  .find((b) => b.textContent.trim() === 'Older')?.click());
await page.waitForTimeout(1200);
const o = await read();
const firstAfter = await page.evaluate(() => document.querySelector('#view table tbody tr')?.innerText || '');
check('Older moves to different rows', firstAfter !== first && firstAfter.length > 0, firstAfter.slice(0, 40));
check('the second page is what the route says it is', o.rows === api2.shown, `${o.rows} vs ${api2.shown}`);
check('and says which rows they are', /rows 101/.test(o.tiles[1] || ''), o.tiles[1]);
check('and the total is still the window, not what is left',
  o.tiles[0].includes(String(api.total)), o.tiles[0]);
await page.evaluate(() => [...document.querySelectorAll('#view button')]
  .find((b) => b.textContent.trim() === 'Newer')?.click());
await page.waitForTimeout(1200);
const backAgain = await page.evaluate(() => document.querySelector('#view table tbody tr')?.innerText || '');
check('Newer comes back to where it started', backAgain === first, backAgain.slice(0, 40));

/* Telematics is a different population and the page must say so rather than
   quietly adding twelve thousand journeys to the booking count. */
await page.selectOption('#view select', { label: 'Telematics journeys' }).catch(() => {});
await page.waitForTimeout(1000);
const t = await read();
const apiT = (await get('/api/trips/list?days=7&kind=telematics&limit=100')).body;
check('the kind selector changes the population', t.tiles[0].includes(String(apiT.total)),
  `${t.tiles[0]} — api ${apiT.total}`);
check('and the page names it, so a journey is never read as a booking',
  /journeys/i.test(t.tiles[0]) && /Telematics/i.test(t.text), t.tiles[0]);

/* ── and on the phone, which is where the question gets asked ─────────── */
/* "What happened on that job" is asked standing next to the car. The desktop's
   nine-column table does not survive 390px, so the phone renders the same list
   as cards — and the number at the top of it has to be the same number. */
console.log('\nthe phone');
const ph = await browser.newPage({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const phErrs = [];
ph.on('pageerror', (e) => phErrs.push(String(e.message)));
await ph.goto(`${url}/#trips?days=7`, { waitUntil: 'domcontentloaded' });
await ph.waitForSelector('.m-row', { timeout: 20000 }).catch(() => {});
await ph.waitForTimeout(1200);
const m = await ph.evaluate(() => ({
  text: document.body.innerText,
  cards: document.querySelectorAll('.m-row').length,
  wide: document.documentElement.scrollWidth > window.innerWidth + 1,
}));
check('the phone screen rendered without throwing', phErrs.length === 0, phErrs.join(' | '));
check('it drew a card per trip', m.cards >= 40, String(m.cards));
check('and leads with the same total the desktop does',
  m.text.includes(fmtNum(api.total)), `looking for ${api.total}`);
/* The two shells have to mean the same thing by the same address.
   ─────────────────────────────────────────────────────────────────────────
   The phone router read view/param/sub out of the hash and stopped, so every
   window and channel filter a link carried was dropped. Measured on one
   build, one browser, the same URL #trips?days=7:
     desktop  /api/trips/list?from=2026-08-26&to=2026-09-01&limit=100
     phone    /api/trips/list?period=month&limit=40
   A seven-day link opened on a phone showed the month, silently. */
check('the phone honours the window in the address, as the desktop does',
  /applyWindow\(parseHash\(\)\)/.test(readFileSync('api/public/m/app.js', 'utf8')),
  'the address is the authority on every shell, not just the desktop one');
check('and both shells apply it through the same function',
  /export function applyWindow/.test(readFileSync('api/public/data.js', 'utf8'))
  && /applyWindow\(r\);/.test(readFileSync('api/public/app.js', 'utf8')),
  'two copies of a precedence rule are two rules that will drift');
check('a phone filter pick goes through the address, not straight into state',
  /setFilter\(\{/.test(readFileSync('api/public/m/app.js', 'utf8')),
  'render() reads the hash now, so a pick written only to state is overwritten by its own re-render');
check('nothing pushes the phone sideways', !m.wide);
check('the channel is on every card, not in a filter above',
  /Uber/.test(m.text) && /Hotel/.test(m.text), '');
check('a cancelled trip says so on the card', /cancelled/i.test(m.text));
await ph.fill('.m-search input', 'm3');
await ph.waitForTimeout(900);
const ms = await ph.evaluate(() => ({ text: document.body.innerText, cards: document.querySelectorAll('.m-row').length }));
check('the phone search narrows the list', ms.cards < m.cards && ms.cards > 0, `${ms.cards} vs ${m.cards}`);
check('and says what it is showing', /matching/i.test(ms.text), ms.text.slice(0, 120));

await browser.close();
server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
