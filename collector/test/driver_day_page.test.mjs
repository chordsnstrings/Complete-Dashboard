/* The driver day page under every shape it can be handed (2026-10-13).
   ──────────────────────────────────────────────────────────────────────────
   The independent review of the day page's rework rendered it in its head
   and found the page saying things the data did not: a Fleet technician's
   page threw on `w.shared.length` (the gate nulls a BK path for a role that
   holds bookings only as totals); a Cash desk officer was told "No booking
   from today has reached us yet" and "no car is on record as his" about a day
   with bookings and a car their role is not shown; a Finance manager was told
   "No tracker fix reached this day" beside a distance the tracker measured;
   every new day link landed on the "addressed as" note because href already
   carries `?period=`; the old skin painted a passenger aboard, moving and
   stopped in one colour; the "no seat reading" stripe never showed.

   So this renders the page, in a real browser, against the mock's day — put
   through the REAL access shaper (api/access/shape.js) with the REAL
   manifest entry and each role's REAL levels (api/public/access_model.js) —
   and reads what a person would read. Synthetic data only (the mock). */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const { app: mock } = await import('../mockapi.mjs');
const { launchChromium } = await import('./browser.mjs');
const { shapeBody } = await import('../api/access/shape.js');
const { ROLES } = await import('../api/public/access_model.js');
const express = (await import('express')).default;

const ENTRY = JSON.parse(readFileSync(new URL('../api/access/manifest.json', import.meta.url), 'utf8'))
  .find((e) => e.method === 'GET' && e.path === '/api/driver/day');
const levelsOf = (code) => ROLES.find((r) => r.code === code).levels;

/* The mock answers the day; this middleware hands the page the answer a
   given role would receive, or a deliberately altered one. */
const mockSrv = mock.listen(0); await new Promise((r) => mockSrv.once('listening', r));
const mockBase = `http://127.0.0.1:${mockSrv.address().port}`;
let as = { role: null, alter: null };
const web = express();
web.get('/api/driver/day', async (req, res) => {
  const r = await fetch(`${mockBase}${req.originalUrl}`);
  let body = await r.json();
  if (as.alter) body = as.alter(body);
  if (as.role) {
    const { body: shaped, withheld } = shapeBody(body, ENTRY, levelsOf(as.role));
    body = shaped;
    const classes = Object.keys(withheld || {});
    if (classes.length) res.set('x-fm-withheld', classes.join(','));
  }
  res.set('cache-control', 'no-store');
  res.json(body);
});
web.use(mock);
const srv = web.listen(0); await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const browser = await launchChromium();
async function open(state, { skin = '', on = '2026-09-20' } = {}) {
  as = state;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', timezoneId: 'Asia/Dubai', locale: 'en-GB' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(`${base}/?ui=desktop${skin ? `&skin=${skin}` : ''}#driver/drv-0/day?on=${on}`, { waitUntil: 'load' });
  await page.waitForFunction(() => /Where the car went|Nothing is on record|addressed as|Could not load/i.test(document.querySelector('#view')?.innerText || ''), null, { timeout: 60000 })
    .catch(() => {});
  await page.waitForTimeout(800);
  const text = await page.evaluate(() => (document.querySelector('#view')?.innerText || '').replace(/\s+/g, ' '));
  return { ctx, page, errors, text };
}

console.log('\n§1 the links');
{
  const { ctx, page, errors, text } = await open({});
  const links = await page.$$eval('.dday-nav a', (as) => as.map((a) => a.getAttribute('href')));
  check('the day page renders with no error', !errors.length && /Where the car went/i.test(text), errors.join(' | '));
  check('every day link carries ONE query string with `on` in it (href already carries ?period=)',
    links.length >= 2 && links.every((h) => (h.match(/\?/g) || []).length === 1 && /[?&]on=\d{4}-\d{2}-\d{2}/.test(h)), JSON.stringify(links));
  await page.click('.dday-nav a >> nth=0');
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => (document.querySelector('#view')?.innerText || ''));
  check('…and following one opens that day, not the "addressed as" note', !/addressed as/.test(after) && /19 Sept/i.test(after) && /Where the car went/i.test(after), after.slice(0, 200));
  await ctx.close();
}
{
  const { ctx, page } = await open({}, { on: '2026-09-20' });
  await page.goto(`${base}/?ui=desktop#driver/drv-0`, { waitUntil: 'load' });
  await page.waitForSelector('.lstat-day', { timeout: 30000 }).catch(() => {});
  const h = await page.$eval('.lstat-day', (a) => a.getAttribute('href')).catch(() => null);
  check('the live strip\'s "today" link carries one query string with today\'s `on`', h && (h.match(/\?/g) || []).length === 1 && /[?&]on=\d{4}-\d{2}-\d{2}/.test(h), String(h));
  await ctx.close();
}

console.log('\n§2 each role reads what is true for it');
{
  const { ctx, errors, text } = await open({ role: 'TEC' });
  check('Fleet technician (bookings as totals only): no error — the page draws the car without the hours or the other drivers',
    !errors.length && /was his on this day/.test(text) && /Only totals of/.test(text), `${errors.join(' | ')} ${text.slice(0, 300)}`);
  await ctx.close();
}
{
  const { ctx, errors, text } = await open({ role: 'CLK', alter: (b) => ({ ...b }) });
  check('Cash desk (no bookings, no car, no positions): never "No booking", never "no car is on record"',
    !errors.length && /Bookings are not shown to your role/.test(text) && !/No booking/.test(text) && !/no car is on record as his/.test(text),
    `${errors.join(' | ')} ${text.slice(0, 500)}`);
  check('…the car and the positions are said to be withheld, in the access model\'s words', /Not shown to your role/.test(text), text.slice(0, 500));
  await ctx.close();
}
{
  const { ctx, errors, text } = await open({ role: 'FIN' });
  check('Finance manager (no positions): "Where the car went" withheld, and never "No tracker fix reached this day"',
    !errors.length && /Where the car went: Not shown to your role/i.test(text) && !/No tracker fix reached/.test(text), `${errors.join(' | ')} ${text.slice(0, 400)}`);
  await ctx.close();
}
{
  const { ctx, errors, text } = await open({ role: 'HRO' });
  check('HR officer (no bookings, no positions): no error, bookings said withheld', !errors.length && /Bookings are not shown to your role/.test(text),
    `${errors.join(' | ')} ${text.slice(0, 300)}`);
  await ctx.close();
}
{
  const { ctx, errors, text } = await open({ alter: (b) => { const c = { ...b }; delete c.movement; delete c.status_spans; return c; } });
  check('an answer from before the movement record is said to predate it — not "no car is on record"',
    !errors.length && /predates the car’s movement record/.test(text) && !/No car is on record as his/.test(text), `${errors.join(' | ')}`);
  await ctx.close();
}

console.log('\n§3 colours');
{
  const { ctx, page } = await open({ alter: (b) => ({ ...b, movement: { ...b.movement,
    runs: b.movement.runs.map((r, i) => (i === 1 && r.state !== 'idle' ? { ...r, seat: null } : r)) } }) }, { skin: 'classic' });
  const cols = await page.$$eval('.dday-car > i', (is) => is.map((i) => ({ bg: getComputedStyle(i).backgroundColor, img: getComputedStyle(i).backgroundImage, cls: i.className, title: i.title })));
  const byState = (re) => new Set(cols.filter((c) => re.test(c.title)).map((c) => c.bg));
  const eng = byState(/passenger aboard/); const mov = byState(/moving, no passenger/); const stop = byState(/stopped/);
  check('the old skin paints a passenger aboard, moving and stopped in three different colours',
    eng.size && mov.size && stop.size && ![...eng].some((c) => mov.has(c) || stop.has(c)) && ![...mov].some((c) => stop.has(c)),
    JSON.stringify({ eng: [...eng], mov: [...mov], stop: [...stop] }));
  const ns = cols.filter((c) => /noseat/.test(c.cls));
  check('a moving stretch with no seat reading is striped — the stripe is not wiped by the run\'s colour',
    ns.length > 0 && ns.every((c) => /repeating-linear-gradient/.test(c.img)), JSON.stringify(ns));
  await ctx.close();
}

console.log('\n§4 the words around midnight, now and absence');
{
  const { ctx, errors, text } = await open({ alter: (b) => ({ ...b,
    status_spans: [{ status: 'online', s: 0, e: 200, carried_in: true }, { status: 'offline', s: 200, e: 560 }, ...b.status_spans] }) });
  check('a spell carried in from before midnight reads "already online when the day began" — never a change at 00:00',
    !errors.length && /already online when the day began/i.test(text) && !/00:00 online/.test(text) && !/00:00 went offline/.test(text), errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, errors, text } = await open({ alter: (b) => ({ ...b, trips: [], fixes: [],
    movement: { ...b.movement, runs: [], segments: [], absent: 'the tracker in A 12345 reported no position while Khalid A had it',
      totals: { km: 0, km_with_passenger: 0, km_empty: 0, km_seat_not_reported: 0, fixes: 0, with_passenger_min: 0, moving_empty_min: 0,
        stopped_min: 0, held_min: 260, unseen_min: 260, seat_reported: false, sources: [] } } }) });
  check('a car whose tracker sent nothing has no distance — the reason, never "0.0 km"',
    !errors.length && !/0\.0 km in the car/.test(text) && !/THE CAR MOVED\s*0/i.test(text) && /reported no position while/i.test(text), text.slice(0, 600));
  await ctx.close();
}
{
  const { ctx, errors, text } = await open({ alter: (b) => ({ ...b, today: true, now_min: 1000,
    movement: { ...b.movement, segments: [...b.movement.segments, { kind: 'silence', s: 780, e: 810, minutes: 30, plate: 'A 12345', edge: 'end' }] } }) });
  check('today, a silence that ends where his hours in the car ended says so — not "to now"',
    !errors.length && /to the end of his hours in it/.test(text) && !/no position for 30m — to now/.test(text), errors.join(' | '));
  await ctx.close();
}
{
  const { ctx, errors, text } = await open({ alter: (b) => ({ ...b, trips: [], today: false,
    online: [{ s: 420, e: 1000, open_ended: false, closed_by: null }],
    status_spans: [{ status: 'online', s: 420, e: 800 }, { status: 'offline', s: 800, e: 1440 }] }) });
  check('a closed day with two records says them as two — never "holds X of it so far"',
    !errors.length && !/so far/.test(text) && /log-in record holds 9h 40m for the day/i.test(text), text.slice(0, 600));
  await ctx.close();
}
{
  /* Compared with a FINISHED trip, not with the online bar: the open-ended
     gradient is a background-image, so a running trip painted in the online
     colour still differs from the online bar — that comparison passed with
     the fix removed. */
  const { ctx, page } = await open({ alter: (b) => ({ ...b, today: true, now_min: 1000,
    status_spans: [{ status: 'online', s: 560, e: 700 }, { status: 'ontrip', s: 700, e: 800 }, { status: 'online', s: 800, e: 900 },
      { status: 'ontrip', s: 900, e: 1000, open_ended: true }] }) });
  const [done, running] = await page.$$eval('.dday-status > i.st-trip', (is) => [is.find((i) => !/open/.test(i.className)), is.find((i) => /open/.test(i.className))]
    .map((i) => (i ? `${getComputedStyle(i).backgroundImage} ${getComputedStyle(i).backgroundColor}` : null)));
  check('a trip still running is drawn in the trip colour, as a finished trip is — not the online gradient', done && running && done === running, JSON.stringify({ done, running }));
  await ctx.close();
}

await browser.close(); srv.close(); mockSrv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
