/* People at work and revenue, hour by hour, on #compare.
   ──────────────────────────────────────────────────────────────────────────
   The operator, 2026-10-15: "#compare should have hourly active driver, and
   hourly revenue as well." Held here, on synthetic rows:

     · a person counts once in an hour, however many accounts they drive
       under, and an FMS journey is not a person taking work;
     · an hour's revenue is its fares on record plus its share of the day
       page's estimate for bookings not priced yet — spread by the hour's
       unpriced bookings, adding up to the day page's trip value to the fils,
       with the estimate never hidden inside the total;
     · a settled day carries no estimate at all;
     · under a fleet chip the estimate is that fleet's own: its rows, its rate,
       nothing of the other fleet's fares in it (the access gate rewrites
       ?fleet= for a reader limited to one fleet);
     · a channel with no settled day to value it by adds nothing and is named;
     · the page draws both panels in both skins, the estimate hatched, and a
       role that may not see revenue is told so rather than shown nothing.

   Proved by revert, each against this file (2026-10-16):
     (a) the estimate spread evenly over a channel's rows instead of by their
         unpriced bookings: 1 fails — the hour shares (112.36 in each).
     (b) hourly drivers counted on driver_ext_id instead of the person key:
         3 fail — the fold, and in both skins the busiest hour, which moves to
         08:00 once one person is counted as two.
     (c) PRICING_RATE_SQL without its fleet clause: 2 fail — the fleet's own
         rate, and the isolation from the other fleet's history.
     (d) hatchIf dropped from the revenue chart: 2 fail — the hatched bars in
         each skin.
     (e) the withheld branch removed: 1 fails — "No revenue on either day"
         printed to a role that may not see revenue.
     (f) the stale-answer guard removed: 1 fails — a response cached across
         the deploy drew "Nothing" for people and money.
     (g) complimentary rides counted as pending again: 5 fail — Egari's
         hotel channel projected on a day with nothing left to price (whole
         fleet, Egari alone and the day page), and in both skins two more
         hatched hours and a caption naming a hotel estimate.
     (i) the estimate spread over every unpriced booking again: 4 fail —
         05:00, whose only unpriced booking was a cancellation, given revenue;
         the share by 10:00 moved with it; and both skins hatch a fourth hour.
     (k) the caption counting the decision's `pending`: 2 fail — "4
         finished Uber rides" in both skins, against the 5 waiting.
     (h) unvalued counted as bookings minus priced: 3 fail — the Yango
         cancellation counted as money missing, on the route and in both
         skins' captions ("2 bookings on Yango"). */
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

const A = '2026-08-25';   // Uber not priced yet: the estimate is drawn
const B = '2026-08-24';   // settled: every Uber booking carries its fare
let n = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status, price, payment_type)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,10,$11,$9,$10)`,
  [o.platform || 'uber', `h${n++}`, o.fleet || 'ecosine', o.plate || 'L100', o.drv, o.name,
    o.at, o.end || null, o.price ?? null, o.pay || null, o.status || 'completed']);

/* The settled fortnight behind both days: ten Uber bookings a day per fleet,
   nine priced — AED 50 a fare on ecosine, AED 100 on egari, so the two fleets'
   rates differ and a rate built from both is visibly neither. */
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
           requested_at, distance_km, status, price)
         SELECT 'uber', 'hist-' || f || '-' || d || '-' || g, f, 'L9' || g, 'hist-' || f, 'History ' || f,
                ('2026-08-' || lpad(d::text, 2, '0') || 'T12:00:00+04:00')::timestamptz, 10, 'completed',
                CASE WHEN g <= 9 THEN CASE f WHEN 'ecosine' THEN 50 ELSE 100 END END
           FROM generate_series(10, 23) d, generate_series(1, 10) g, unnest(ARRAY['ecosine','egari']) f`);
/* …and Egari's hotel channel, which prices every ride as it lands. */
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
           requested_at, distance_km, status, price, payment_type)
         SELECT 'hotel', 'hh-' || d || '-' || g, 'egari', 'L800', 'hist-hotel', 'History hotel',
                ('2026-08-' || lpad(d::text, 2, '0') || 'T12:00:00+04:00')::timestamptz, 10, 'completed', 100, 'room-charge'
           FROM generate_series(10, 23) d, generate_series(1, 5) g`);

/* B, settled: three Uber bookings, each priced. */
await trip({ drv: 'u-1', name: 'Same Person', at: `${B}T08:10:00+04:00`, price: 60 });
await trip({ drv: 'u-2', name: 'Other One', at: `${B}T09:05:00+04:00`, price: 60 });
await trip({ drv: 'u-3', name: 'Third Driver', at: `${B}T09:40:00+04:00`, price: 60 });

/* A, Uber walked to nothing yet. */
await trip({ drv: 'u-1', name: 'Same Person', at: `${A}T08:10:00+04:00` });
// …the same person on the hotel channel under another account and spelling.
await trip({ drv: 'h-1', name: 'same  person', platform: 'hotel', at: `${A}T08:40:00+04:00`,
  price: 240, pay: 'room-charge' });
// …an FMS journey in the same hour: a tracker's trip, not somebody taking work.
await trip({ drv: 'u-9', name: 'Tracker Only', platform: 'fms', at: `${A}T08:15:00+04:00` });
await trip({ drv: 'u-2', name: 'Other One', at: `${A}T09:05:00+04:00` });
await trip({ drv: 'u-2', name: 'Other One', at: `${A}T09:40:00+04:00` });
await trip({ drv: 'u-3', name: 'Third Driver', at: `${A}T14:20:00+04:00` });
// …a rider cancellation at 06:00 that took a fee: priced, so the decision's net
// "pending" (completed less priced) runs one short of the rides waiting.
await trip({ drv: 'u-3', name: 'Third Driver', at: `${A}T06:10:00+04:00`, status: 'cancelled', price: 10 });
// …and a rider cancellation at 05:00 with no fee: no revenue is coming to 05:00.
await trip({ drv: 'u-3', name: 'Third Driver', at: `${A}T05:10:00+04:00`, status: 'cancelled' });
await trip({ drv: 'e-1', name: 'Egari Driver', fleet: 'egari', plate: 'L700', at: `${A}T14:30:00+04:00` });
// …and a channel with no settled day anywhere behind it — one finished ride
// with no fare, and one cancellation, which is not money missing.
await trip({ drv: 'y-1', name: 'Yango Driver', platform: 'yango', at: `${A}T16:00:00+04:00` });
await trip({ drv: 'y-1', name: 'Yango Driver', platform: 'yango', at: `${A}T16:30:00+04:00`, status: 'cancelled' });
/* Egari's hotel rides on the pending day: two billed, two given away — the
   shape production showed on 15 October 2026 (6 completed, 4 priced, the
   other two foc-complimentary), which read as 2 of 4 "pending" and drew an
   estimate on a day with nothing left to price. */
await trip({ drv: 'eh-1', name: 'Egari Hotel Driver', platform: 'hotel', fleet: 'egari', plate: 'L800',
  at: `${A}T20:00:00+04:00`, price: 100, pay: 'room-charge' });
await trip({ drv: 'eh-1', name: 'Egari Hotel Driver', platform: 'hotel', fleet: 'egari', plate: 'L800',
  at: `${A}T20:20:00+04:00`, price: 100, pay: 'room-charge' });
await trip({ drv: 'eh-1', name: 'Egari Hotel Driver', platform: 'hotel', fleet: 'egari', plate: 'L800',
  at: `${A}T20:40:00+04:00`, price: 50, pay: 'foc-complimentary' });
await trip({ drv: 'eh-1', name: 'Egari Hotel Driver', platform: 'hotel', fleet: 'egari', plate: 'L800',
  at: `${A}T21:00:00+04:00`, price: 50, pay: 'foc-complimentary' });

const { server, get: raw } = await mountAll(db, { serverRoutes: false });
const cmp = async (qs) => (await raw(`/api/compare?a=${A}&b=${B}&${qs}`)).body;
const near = (x, y) => x != null && y != null && Math.abs(Number(x) - Number(y)) <= 0.02;
const sum = (rows, k) => rows.reduce((s, h) => s + (Number(h[k]) || 0), 0);

const full = await cmp('cut=full');
const day = (await raw(`/api/day?day=${A}`)).body.headline;
const H = (h) => full.hours[h];

console.log('\npeople at work, hour by hour');
check('one person in 08:00 — two accounts and two spellings fold, and the FMS journey is no one',
  H(8).a_drivers === 1, JSON.stringify(H(8)));
check('…two bookings by one person in 09:00 are one person', H(9).a_drivers === 1, String(H(9).a_drivers));
check('…two people in 14:00, one from each fleet', H(14).a_drivers === 2, String(H(14).a_drivers));
check('…and an hour nobody worked is a measured zero', H(3).a_drivers === 0 && H(3).b_drivers === 0);
check('the earlier day is counted the same way', H(9).b_drivers === 2 && H(8).b_drivers === 1,
  JSON.stringify([H(8).b_drivers, H(9).b_drivers]));

console.log('\nrevenue, hour by hour: the day page\'s trip value, laid over its hours');
const rbA = full.revenue_basis.a, rbB = full.revenue_basis.b;
check('the hours add up to the day page\'s trip value',
  near(sum(full.hours, 'a_revenue'), day.expected_revenue) && near(rbA.revenue, day.expected_revenue),
  `${sum(full.hours, 'a_revenue')} / ${rbA.revenue} against ${day.expected_revenue}`);
check('…the estimate inside them is the day page\'s estimate, and is reported apart',
  near(sum(full.hours, 'a_estimated'), day.projected_revenue) && near(rbA.estimated, day.projected_revenue),
  `${sum(full.hours, 'a_estimated')} against ${day.projected_revenue}`);
check('…on the same working: channel, unpriced bookings, rate and value',
  JSON.stringify(rbA.parts.map((p) => [p.platform, p.bookings, p.per_booking, p.value]))
    === JSON.stringify((day.projection_parts || []).map((p) => [p.platform, p.bookings, p.per_booking, p.value])),
  JSON.stringify([rbA.parts, day.projection_parts]));
check('…the fares on record are the fares the page totals', near(sum(full.hours, 'a_fares'), full.full_day.a.fares)
  && near(rbA.on_record, 450), `${sum(full.hours, 'a_fares')} / ${full.full_day.a.fares}`);
check('the caption\'s count is the rides waiting, not the decision\'s net figure',
  rbA.parts[0]?.waiting === 5 && rbA.parts[0]?.pending === 4, JSON.stringify(rbA.parts));
check('each hour takes its share by its unpriced bookings: 09:00 holds two, 08:00 one',
  H(8).a_estimated > 0 && near(H(9).a_estimated, 2 * H(8).a_estimated) && near(H(14).a_estimated, 2 * H(8).a_estimated),
  JSON.stringify([H(8).a_estimated, H(9).a_estimated, H(14).a_estimated]));
check('an hour whose only unpriced booking was cancelled is given none of the estimate',
  H(5).a_estimated === 0 && H(5).a_revenue === 0 && H(5).a === 1, JSON.stringify(H(5)));
check('…and an hour is its fares plus its estimate, the estimate never hidden',
  near(H(8).a_revenue, 240 + H(8).a_estimated) && H(8).a_fares === 240, JSON.stringify(H(8)));
check('a settled day carries no estimate anywhere',
  rbB.estimated === null && full.hours.every((h) => h.b_estimated === 0)
  && near(sum(full.hours, 'b_revenue'), 180) && near(full.full_day.b.fares, 180),
  JSON.stringify(rbB));
check('rides given away are never pending: no estimate for the hotel, whole fleet or Egari alone',
  !rbA.parts.some((p) => p.platform === 'hotel') && H(20).a_estimated === 0 && H(21).a_estimated === 0
  && !(await cmp('cut=full&fleet=egari')).revenue_basis.a.parts.some((p) => p.platform === 'hotel')
  && !(day.projection_parts || []).some((p) => p.platform === 'hotel'),
  JSON.stringify([rbA.parts, (await cmp('cut=full&fleet=egari')).revenue_basis.a.parts]));
check('a channel with no settled day adds nothing, and is named with its bookings',
  (rbA.unvalued_platforms || []).includes('yango') && rbA.unvalued_bookings === 1
  && H(16).a_unvalued === 1 && H(16).a_revenue === 0, JSON.stringify([rbA.unvalued_platforms, H(16)]));

console.log('\nthe cut');
const noon = await cmp('cut=600');
check('by 10:00 the fares on record are the fares the cut totals hold',
  near(noon.revenue_basis.a.on_record_by_cut, noon.totals.a.fares) && near(noon.revenue_basis.b.on_record_by_cut, noon.totals.b.fares),
  JSON.stringify([noon.revenue_basis.a.on_record_by_cut, noon.totals.a.fares]));
check('…and the estimate by 10:00 is the share of the bookings requested before it',
  near(noon.revenue_basis.a.estimated_by_cut, H(8).a_estimated + H(9).a_estimated),
  `${noon.revenue_basis.a.estimated_by_cut} against ${H(8).a_estimated + H(9).a_estimated}`);
check('…while the hour charts stay uncut', noon.hours[14].a_estimated > 0 && noon.hours[14].a_drivers === 2);

console.log('\na fleet\'s page is that fleet\'s own');
const eco = await cmp('cut=full&fleet=ecosine');
const ecoRate = Math.round(((13 * 450 + 180) / 133) * 100) / 100;
check('the estimate is valued at the fleet\'s own rate over its own bookings',
  eco.revenue_basis.a.parts.length === 1 && eco.revenue_basis.a.parts[0].per_booking === ecoRate
  && eco.revenue_basis.a.parts[0].waiting === 4 && eco.revenue_basis.a.parts[0].bookings === 5,
  JSON.stringify(eco.revenue_basis.a.parts));
check('…and its people are its own', eco.hours[14].a_drivers === 1, String(eco.hours[14].a_drivers));
await q(`UPDATE trip SET price = price * 3 WHERE fleet_id = 'egari' AND external_id LIKE 'hist-%'`);
const eco2 = await cmp('cut=full&fleet=ecosine');
const whole2 = await cmp('cut=full');
check('the other fleet\'s fares reach none of it', JSON.stringify(eco2.revenue_basis) === JSON.stringify(eco.revenue_basis)
  && JSON.stringify(eco2.hours) === JSON.stringify(eco.hours)
  && whole2.revenue_basis.a.estimated !== full.revenue_basis.a.estimated,
  JSON.stringify([eco.revenue_basis.a.estimated, eco2.revenue_basis.a.estimated, full.revenue_basis.a.estimated, whole2.revenue_basis.a.estimated]));
await q(`UPDATE trip SET price = price / 3 WHERE fleet_id = 'egari' AND external_id LIKE 'hist-%'`);

console.log('\nthe page');
const shell = express();
shell.use(express.static('api/public'));
shell.use('/api', (req, res) => raw(`/api${req.url}`)
  .then((x) => res.status(x.status).json(x.body))
  .catch((e) => res.status(500).json({ error: String(e) })));
const web = shell.listen(0);
const base = `http://127.0.0.1:${web.address().port}`;
const browser = await launchChromium();
const read = (page) => page.evaluate(() => {
  const find = (re) => {
    const h = [...document.querySelectorAll('h3')].find((x) => re.test(x.textContent));
    const p = h?.closest('.panel');
    if (!p) return null;
    const svgs = [...p.querySelectorAll('svg')].filter((s) => s.querySelector('[data-rise]'));
    return {
      text: p.innerText.replace(/\s+/g, ' '),
      charts: svgs.length,
      /* Bars drawn as measured differently: a pattern fill (Arkiv's hatch) or a
         dashed outline (the old skin's hollow bar). */
      marked: svgs.map((s) => [...s.querySelectorAll('[data-rise]')].filter((r) => /^url\(/.test(r.getAttribute('fill') || '')
        || r.getAttribute('stroke-dasharray')).length),
      link: p.querySelector('a[href^="#online-hours"]')?.getAttribute('href') || null,
    };
  };
  return { people: find(/People at work, hour by hour/), money: find(/Revenue, hour by hour/) };
});
for (const skin of ['', '&skin=classic']) {
  const label = skin ? 'old skin' : 'Arkiv';
  const page = await browser.newPage({ viewport: { width: 1500, height: 1400 } });
  await page.goto(`${base}/?ui=desktop${skin}#compare/${A}/${B}?cut=full`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /Revenue, hour by hour/.test(document.body.innerText)
    && [...document.querySelectorAll('h3')].some((h) => /Revenue, hour by hour/.test(h.textContent)
      && h.closest('.panel')?.querySelector('svg [data-rise]')), null, { timeout: 60000 }).catch(() => {});
  const r = await read(page);
  check(`${label}: people at work drawn for both days, with the busiest hour named and Uber's online count linked`,
    r.people?.charts === 2 && /Most people at work: 14:00 on/.test(r.people.text) && r.people.link === `#online-hours/${A}`,
    JSON.stringify(r.people)?.slice(0, 400));
  check(`${label}: revenue drawn for both days, the three hours holding an estimate marked as one`,
    r.money?.charts === 2 && r.money.marked[0] === 3 && r.money.marked[1] === 0, JSON.stringify(r.money?.marked));
  check(`${label}: the caption names the estimate, its rate and its days, and the settled day as all on record`,
    /estimated for 5 finished Uber rides not priced yet \(the channel’s bookings at AED [\d.,]+ each over 14 settled days, less what is on record\)/.test(r.money?.text || '')
    && /all of it fares on record/.test(r.money?.text || '')
    && /1 booking on Yango carries no price/.test(r.money?.text || ''),
    (r.money?.text || '').slice(0, 700));
  check(`${label}: nothing undefined or NaN in either panel`,
    !/undefined|NaN|null/.test(`${r.people?.text} ${r.money?.text}`));
  await page.close();
}
/* A role that may not see revenue: the shaper serves the fields as null and
   names the class in _withheld (api/access/shape.js). */
{
  const page = await browser.newPage({ viewport: { width: 1500, height: 1400 } });
  await page.route('**/api/compare?*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const h of body.hours) for (const k of ['a_revenue', 'b_revenue', 'a_fares', 'b_fares', 'a_estimated', 'b_estimated']) h[k] = null;
    body.revenue_basis = null;
    body._withheld = { REV: '' };
    await route.fulfill({ response: res, json: body });
  });
  await page.goto(`${base}/?ui=desktop#compare/${A}/${B}?cut=full`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => [...document.querySelectorAll('h3')].some((h) => /People at work/.test(h.textContent)
    && h.closest('.panel')?.querySelector('svg [data-rise]')), null, { timeout: 60000 }).catch(() => {});
  const r = await read(page);
  check('a role that may not see revenue is told so, not shown "no revenue"',
    /Not shown to your role/.test(r.money?.text || '') && !/No revenue on either day/.test(r.money?.text || '')
    && r.money?.charts === 0, (r.money?.text || '').slice(0, 300));
  await page.close();
}
/* An answer saved before these fields existed — cached across the deploy —
   has no hourly people or money keys at all. */
{
  const page = await browser.newPage({ viewport: { width: 1500, height: 1400 } });
  await page.route('**/api/compare?*', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const h of body.hours) {
      for (const k of Object.keys(h)) if (/_(drivers|revenue|fares|estimated|unvalued)$/.test(k)) delete h[k];
    }
    delete body.revenue_basis;
    await route.fulfill({ response: res, json: body });
  });
  await page.goto(`${base}/?ui=desktop#compare/${A}/${B}?cut=full`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => /saved before the server/.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
  const r = await read(page);
  check('an answer saved before the hourly fields existed says so, not "no people"',
    /saved before the server/.test(r.people?.text || '') && /saved before the server/.test(r.money?.text || '')
    && !/No people on either day|No revenue on either day/.test(`${r.people?.text} ${r.money?.text}`),
    `${(r.people?.text || '').slice(0, 200)} | ${(r.money?.text || '').slice(0, 200)}`);
  await page.close();
}

await browser.close();
web.close();
server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
