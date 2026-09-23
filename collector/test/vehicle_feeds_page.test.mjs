/* #feeds in a real browser, against the mock.
   ─────────────────────────────────────────────────────────────────────────
   test/vehicle_feeds.test.mjs proves what the route decides. This proves the
   page says it: that the tab is in the Fleet section, that the count at the
   top is the route's count, that each feed cell is a chip in the product's own
   verdict colours WITH its word, that a red cell prints the route's reason,
   and that plates, drivers and phone numbers are links a person can use.

   The mock's rows are synthetic (Q-prefixed plates, test names, +999
   numbers). reducedMotion because the headline tiles count up over 620 ms
   and a tile read mid-animation carries a number that was never in the data
   — see "EVERY HEADLINE NUMBER COUNTS UP" in docs/COVERAGE.md. */
import { launchChromium } from './browser.mjs';
import { app } from '../mockapi.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
await page.goto(`${base}/#feeds`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-panel="feeds"] table', { timeout: 20000 });

console.log('\nwhere it lives');
check('the page renders without an error', errs.length === 0, errs.join(' | '));
const strip = await page.$$eval('#sectabs .tabs a', (as) => as.map((a) => ({
  text: a.textContent.trim(), on: a.classList.contains('on'), href: a.getAttribute('href') })));
const me = strip.find((a) => /Seat sensor & FMS/.test(a.text));
check('it is a tab in the Fleet section, beside the other Fleet pages',
  !!me && strip.some((a) => /Vehicles/.test(a.text)) && strip.some((a) => /Live fleet/.test(a.text)),
  JSON.stringify(strip.map((a) => a.text)));
check('…and it is the one lit', !!me?.on && me.href === '#feeds', JSON.stringify(me));
const rail = await page.$eval('#nav a.on', (a) => a.getAttribute('aria-label')).catch(() => null);
check('the rail lights Fleet', rail === 'Fleet', String(rail));
/* Asserted as PRESENT-AND-HIDDEN, not as "not visible": the three controls
   exist in index.html on every page, so a missing element must fail here
   rather than pass — the negative-only form of this check passed against a
   data.js with no 'feeds' entry at all. */
const controls = await page.evaluate(() => ['#fRange', '#fPlatform', '#fFleet'].map((s) => {
  const e = document.querySelector(s);
  return { s, exists: !!e, display: e ? getComputedStyle(e).display : null };
}));
check('no date, platform or fleet control sits above a page they would not govern',
  controls.every((c) => c.exists && c.display === 'none'), JSON.stringify(controls));

console.log('\nthe count at the top');
const tile = (k) => page.$eval(`[data-kpi="${k}"] .n`, (e) => e.textContent.trim()).catch(() => null);
check('seat sensor: 2 receiving, 4 not', (await tile('seat-yes')) === '2' && (await tile('seat-no')) === '4',
  `${await tile('seat-yes')} / ${await tile('seat-no')}`);
check('FMS seat sensor: 3 receiving, 3 not', (await tile('fms-seat-yes')) === '3' && (await tile('fms-seat-no')) === '3',
  `${await tile('fms-seat-yes')} / ${await tile('fms-seat-no')}`);
check('FMS data: 2 receiving, 4 not', (await tile('fms-yes')) === '2' && (await tile('fms-no')) === '4',
  `${await tile('fms-yes')} / ${await tile('fms-no')}`);
const seatNoSub = await page.$eval('[data-kpi="seat-no"] .s', (e) => e.textContent).catch(() => '');
check('the CABMAN count says how many of its reds are the missing CABMAN account',
  /2 of them on Egari, which has no CABMAN account/.test(seatNoSub), seatNoSub);

console.log('\nthe table');
const rows = await page.$$eval('[data-panel="feeds"] tbody tr', (trs) => trs.map((tr) => {
  const td = [...tr.querySelectorAll('td')];
  return {
    text: td.map((c) => c.innerText.replace(/\s+/g, ' ').trim()),
    plateHref: td[0]?.querySelector('a')?.getAttribute('href') || null,
    seat: td[2]?.querySelector('.pill')?.className || '',
    fmsSeat: td[3]?.querySelector('.pill')?.className || '',
    fms: td[4]?.querySelector('.pill')?.className || '',
    drivers: [...(td[5]?.querySelectorAll('a') || [])].map((a) => a.getAttribute('href')),
    tel: [...(td[6]?.querySelectorAll('a[href^="tel:"]') || [])].map((a) => a.getAttribute('href')),
  };
}));
const by = (plate) => rows.find((r) => r.text[0] === plate);
check('one row per car, every car the route returned', rows.length === 6, String(rows.length));
check('the columns are the ones asked for',
  JSON.stringify(await page.$$eval('[data-panel="feeds"] thead th', (th) => th.map((t) => t.textContent.replace(/[↑↓]/g, '').trim())))
  === '["Vehicle","Fleet","Seat sensor — CABMAN","Seat sensor — FMS","FMS data","Driver","Phone"]');
/* FMS and CABMAN are two separate seat-sensor providers (the operator,
   2026-09-23): each gets its own column, and every feed cell names where its
   reading came from. */
check('every seat-sensor and FMS cell names its provider',
  rows.every((r) => /from CABMAN DT/.test(r.text[2]) && /from FMS \(InfoTrack\), seat count per trip/.test(r.text[3])
    && /from FMS \(InfoTrack\), live/.test(r.text[4])), JSON.stringify(rows.map((r) => r.text.slice(2, 5))));
{
  const r = by('Q10001');
  check('receiving is green AND says "receiving"',
    /\bok\b/.test(r?.seat) && /\bok\b/.test(r?.fmsSeat) && /\bok\b/.test(r?.fms)
    && /^receiving/i.test(r.text[2]) && /^receiving/i.test(r.text[3]) && /^receiving/i.test(r.text[4]),
    JSON.stringify(r));
  check('…with when it was last received',
    /last reading/.test(r?.text[2]) && /last reading/.test(r?.text[3]) && /last reading/.test(r?.text[4]));
  check('the plate opens the vehicle page', /^#vehicle\/Q10001(\?|$)/.test(r?.plateHref || ''), String(r?.plateHref));
  check('the driver opens the driver page', /^#driver\/drv-5(\?|$)/.test(r?.drivers?.[0] || ''), JSON.stringify(r?.drivers));
  check('the phone is a number a handset will dial', r?.tel?.[0] === 'tel:+9995550101', JSON.stringify(r?.tel));
  check('…and the driver cell says the name came from Uber’s assignment',
    /Test Driver Alpha/.test(r?.text[5]) && /assigned to this car in Uber/.test(r?.text[5]), r?.text[5]);
}
{
  const r = by('Q10003');
  check('not receiving is red AND says "not receiving"',
    /\bbad\b/.test(r?.seat) && /\bbad\b/.test(r?.fmsSeat) && /\bbad\b/.test(r?.fms)
    && /not receiving/i.test(r.text[2]) && /not receiving/i.test(r.text[3]) && /not receiving/i.test(r.text[4]),
    JSON.stringify(r));
  check('…and why, where the time cannot say it', /no CABMAN seat-sensor reading on record for this car/.test(r?.text[2])
    && /no FMS seat-count reading on record for this car/.test(r?.text[3]), JSON.stringify(r?.text.slice(2, 4)));
  check('a car nobody is known to drive says so in both driver columns',
    /no driver known/.test(r?.text[5]) && /no driver known/.test(r?.text[6]), JSON.stringify(r?.text));
}
{
  const r = by('Q20001');
  check('an Egari car is red on CABMAN with the true reason: CABMAN, not the seat sensor',
    /\bbad\b/.test(r?.seat) && /no CABMAN account for Egari/.test(r?.text[2])
    && !/no seat-sensor account/.test(r?.text[2]), r?.text[2]);
  check('…while its FMS seat sensor, which Egari does have, is green on its own readings',
    /\bok\b/.test(r?.fmsSeat) && /^receiving/i.test(r?.text[3]), r?.text[3]);
  check('…and nothing in that cell reads as a fault in the car', !/device|broken|fault/i.test(r?.text[2] || ''));
  check('two assigned drivers are both named and both openable', r?.drivers?.length === 2, JSON.stringify(r?.drivers));
  check('…each phone told apart by its owner\u2019s name, and the missing one said to be missing',
    /Test Driver Echo: \+9995550201/.test(r?.text[6])
    && /Test Driver Foxtrot: no phone on file/.test(r?.text[6]), r?.text[6]);
}
{
  const r = by('Q10002');
  check('a silent feed shows when it was last heard from', /last reading/.test(r?.text[2]), r?.text[2]);
  check('a custody driver says which day they drove it', /drove it most on/.test(r?.text[5]), r?.text[5]);
}
check('the cars missing a feed come first, as the route ordered them',
  rows[0]?.text[0] === 'Q10003' && rows[rows.length - 1]?.text[0] === 'Q10001',
  rows.map((r) => r.text[0]).join(','));

console.log('\nthe colours are the product’s verdict colours');
const colours = await page.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  const probe = document.createElement('span');
  document.body.append(probe);
  const resolve = (v) => { probe.style.color = v; return getComputedStyle(probe).color; };
  const ok = document.querySelector('[data-panel="feeds"] .pill.ok');
  const bad = document.querySelector('[data-panel="feeds"] .pill.bad');
  return {
    ok: ok && getComputedStyle(ok).color, good: resolve(root.getPropertyValue('--good').trim()),
    bad: bad && getComputedStyle(bad).color, critical: resolve(root.getPropertyValue('--critical').trim()),
  };
});
check('green is --good', colours.ok === colours.good, JSON.stringify(colours));
check('red is --critical', colours.bad === colours.critical, JSON.stringify(colours));

console.log('\nthe rules, one line each');
const body = await page.evaluate(() => document.getElementById('view').innerText);
for (const [k, re] of [
  ['active on Uber', /Active on Uber: Uber’s own vehicle list marks the car ACTIVE/],
  ['the CABMAN seat-sensor source', /Seat sensor — CABMAN: CABMAN DT's seat sensor, sampled every 5 minutes\. It holds an account for Ecosine only\./],
  ['the FMS seat-sensor source', /Seat sensor — FMS: the seat count FMS records on each trip, collected every 30 minutes, for Ecosine and Egari\. A car that makes no trip sends no seat count\./],
  ['FMS', /FMS data: InfoTrack's live telematics, with an account for Ecosine and Egari\./],
  ['the window', /Receiving: a reading in the last 24 hours\./],
  ['the matching', /Matched by: the plate/],
  ['the driver and phone', /Driver: whoever Uber assigns to the car/],
]) check(`states ${k}`, re.test(body));
/* Those lines ARE the page's provenance. The shell stamps a count of
   bookings under any page without one, and this page reads no booking. */
check('and no generic bookings provenance is stamped under them',
  !/Built from/.test(body) && (await page.$$('#view .srcline')).length === 1, body.slice(-300));

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
