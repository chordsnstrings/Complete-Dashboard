/* #vehicle/<plate>/whereabouts — "Where it was", in Chromium against the mock
   (WHR, 2026-11-16).
   ──────────────────────────────────────────────────────────────────────────
   The mock runs synthetic fixes through the REAL arithmetic and answer
   builder (api/whereabouts.js), so what is drawn here is what the route would
   hand the page for such a day. Checked at 1280 (desktop, Arkiv) and 390 (the
   phone shell, which draws the desktop tab inside its fallback), with
   service workers blocked:

     §1  the tab: in the tab bar, its module fetched only when it opens, no
         script error;
     §2  the day: three coverage figures in 00 (never one), the strip with a
         segment for every stretch and every minute of a past day covered,
         each kind drawn its own way, booking anchors, area labels, the
         stays table, the log, the † band with its four true reasons, the
         footer's basis;
     §3  the day picker moves the day through the address (?day=);
     §4  a role that sees bookings as totals (Fleet technician, through the
         real shaper): no booking stretch, no anchor, and it is told why;
     §5  a tracker dead for days says "No reading since", never 0%;
     §6  390 wide: the phone draws it, nothing wider than the screen;
     §7  the old skin draws it too, without an error.

   Synthetic data only. */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const { app: mock } = await import('../mockapi.mjs');
const { launchChromium } = await import('./browser.mjs');
const { shapeBody } = await import('../api/access/shape.js');
const { ROLES } = await import('../api/public/access_model.js');
const express = (await import('express')).default;

const ENTRY = JSON.parse(readFileSync(new URL('../api/access/manifest.json', import.meta.url), 'utf8'))
  .find((e) => e.method === 'GET' && e.path === '/api/vehicle/whereabouts');
const levelsOf = (code) => ROLES.find((r) => r.code === code).levels;

/* The mock answers; this hands the page the answer a ROLE would get, through
   the real shaper and the role's real levels. Port 8325, the one this work
   may use. */
const mockSrv = mock.listen(0); await new Promise((r) => mockSrv.once('listening', r));
const mockBase = `http://127.0.0.1:${mockSrv.address().port}`;
let role = null;
const asked = [];
const web = express();
web.get('/api/vehicle/whereabouts', async (req, res) => {
  asked.push(req.originalUrl);
  const r = await fetch(`${mockBase}${req.originalUrl}`);
  let body = await r.json();
  if (role && r.ok) body = shapeBody(body, ENTRY, levelsOf(role)).body;
  res.status(r.status).set('cache-control', 'no-store').json(body);
});
web.use(mock);
const srv = web.listen(8325); await new Promise((r) => srv.once('listening', r));
const base = 'http://127.0.0.1:8325';

const dubai = (back = 0) => new Date(Date.now() + 4 * 3600e3 - back * 864e5).toISOString().slice(0, 10);
const YDAY = dubai(1);
const browser = await launchChromium();
async function open(route, { width = 1280, height = 900, ui = 'desktop', skin = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, serviceWorkers: 'block', timezoneId: 'Asia/Dubai',
    locale: 'en-GB', ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  const errors = []; const js = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('request', (r) => { const p = new URL(r.url()).pathname; if (p.endsWith('.js')) js.push(p); });
  await page.goto(`${base}/?ui=${ui}${skin ? `&skin=${skin}` : ''}#${route}`, { waitUntil: 'load' });
  const done = await page.waitForFunction(() => {
    const t = `${document.querySelector('#m')?.innerText || ''} ${document.querySelector('#view')?.innerText || ''}`;
    return /What this page does not know|could not be read/i.test(t) ? t : false;
  }, null, { timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(300);
  const text = done ? (await done.jsonValue()).replace(/\s+/g, ' ') : '';
  return { ctx, page, errors, js, text };
}

console.log('\n§1 the tab');
{
  const { ctx, page, js } = await open('vehicle/L45235');
  await page.waitForSelector('.tabs a', { timeout: 30000 }).catch(() => {});
  const tabs = await page.$$eval('.tabs a', (as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
  check('the vehicle page has a "Where it was" tab, linking its own address', tabs.some(([t, h]) => /Where it was/.test(t)
    && /#vehicle\/L45235\/whereabouts/.test(h)), JSON.stringify(tabs));
  check('…and its module is not fetched until the tab opens', !js.some((p) => p.endsWith('/whereabouts.js')), js.filter((p) => /where/.test(p)).join(' '));
  await ctx.close();
}

console.log('\n§2 a past day, at 1280');
{
  asked.length = 0;
  const { ctx, page, errors, js, text } = await open(`vehicle/L45235/whereabouts?day=${YDAY}`);
  check('it draws with no script error', !errors.length && text.length > 0, errors.join(' | ') || text.slice(0, 120));
  check('its module was fetched when the tab opened', js.some((p) => p.endsWith('/whereabouts.js')));
  check('the route was asked for that day', asked.some((u) => u.includes(`day=${YDAY}`)), asked.join(' '));
  const on = await page.$$eval('.tabs a.on', (as) => as.map((a) => a.textContent));
  check('the tab is the active one', on.some((t) => /Where it was/.test(t)), JSON.stringify(on));
  check('00 states three figures — positioned, inferred, unknown — never one',
    /Positioned by fixes/i.test(text) && /Inferred/i.test(text) && /Unknown/i.test(text)
    && /\d+\.\d% positioned by its tracker, \d+\.\d% inferred, \d+\.\d% unknown/.test(text), text.slice(0, 400));
  const segs = await page.$$eval('.whr-strip > .whr-seg', (xs) => xs.map((x) => ({ k: x.dataset.kind,
    l: parseFloat(x.style.left), w: parseFloat(x.style.width), t: x.title })));
  const kinds = new Set(segs.map((s) => s.k));
  check('the strip draws every kind the day holds', ['stay', 'drive', 'parked', 'moved', 'booking'].every((k) => kinds.has(k)), [...kinds].join(' '));
  const cover = segs.reduce((a, s) => a + s.w, 0);
  check('…and every minute of a past day, edge to edge', Math.abs(cover - 100) < 0.01 && segs[0].l === 0, String(cover));
  check('…each stretch says what it was on hover', segs.every((s) => /^\d\d:\d\d–\d\d:\d\d · /.test(s.t))
    && segs.some((s) => /inferred/.test(s.t)) && segs.some((s) => /route not known/.test(s.t)), segs.map((s) => s.t).slice(0, 4).join(' | '));
  const style = await page.$$eval('.whr-strip > .whr-seg', (xs) => Object.fromEntries(xs.map((x) => {
    const cs = getComputedStyle(x);
    return [x.dataset.kind, { bg: cs.backgroundColor, img: cs.backgroundImage, border: cs.borderStyle }];
  })));
  /* Independent review, 2026-11-16: a booking in a silence is unknown (its
     ends pinned, its route not), so it is OUTLINED like every unknown
     stretch — hatched, it read as inferred. REVERSION: .whr-booking back to
     the hatched gradient in app.css — this fails. */
  check('watched is solid, inferred is hatched, unknown is outlined — a booking in a silence too', style.stay.img === 'none' && style.stay.bg !== 'rgba(0, 0, 0, 0)'
    && /repeating-linear-gradient/.test(style.parked.img) && style.booking.img === 'none' && style.booking.border === 'dashed'
    && style.moved.border === 'dashed', JSON.stringify(style));
  const anchors = await page.$$eval('.whr-pins > .whr-anchor', (xs) => xs.map((x) => x.title));
  check('a booking in a quiet stretch anchors the car — "from a booking, not a tracker fix"', anchors.length === 2
    && anchors.every((t) => /from a booking, not a tracker fix/.test(t)), JSON.stringify(anchors));
  const labels = await page.$$eval('.whr-labels > span', (xs) => xs.map((x) => x.textContent));
  check('the stays are named under the strip, once a stay', JSON.stringify(labels)
    === JSON.stringify(['Al Barsha 1', 'Business Bay', 'Dubai Marina', 'Al Barsha 1']), JSON.stringify(labels));
  const stays = await page.$$eval('[data-panel="whr-stays"] tbody tr', (rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')));
  check('the stays table lists each stay with how it is known', stays.length === 4 && /Al Barsha 1/.test(stays[0])
    && /parked with the tracker quiet .* \(inferred\)/.test(stays[0]) && /tracker fixes every/.test(stays[1]), JSON.stringify(stays));
  /* Independent review, 2026-11-16: the stay carried in says since when — the
     mock's evening stay began after a drive home at 18:15, so exactly, never
     "at least". REVERSION: drop the time from the From column — this fails. */
  check('…a stay carried in from the day before says since when (exactly, after a drive)',
    /\(since 18:15 the day before\)/.test(stays[0]) && !/at least/.test(stays[0]), stays[0]);
  const log = await page.$$eval('[data-panel="whr-log"] tbody tr', (rs) => rs.length);
  check('the log has a row for every stretch on the strip', log === segs.length, `${log} vs ${segs.length}`);
  check('the drive with an FMS journey says whose distance it is', /FMS journey/.test(text));
  const band = await page.$$eval('.absband .absb-lab', (xs) => xs.map((x) => x.textContent));
  check('the † band names all four things the page cannot know', JSON.stringify(band)
    === JSON.stringify(['Position between fixes', 'Parked with the tracker quiet', 'Silent over a day', 'Areas'])
    && /half-kilometre cell/.test(text), JSON.stringify(band));
  /* 35 min moved unseen plus the 35-minute booking in that silence: a job
     pins its ends, not the road between (independent review, 2026-11-16). */
  check('…each with its figure sized: 1 h 10 min unplaced (moved unseen, on a booking or not), 4 h parked-quiet, no day-long silence',
    /Position between fixes 1 h 10 min/i.test(text) && /Parked with the tracker quiet 4 h/i.test(text) && /Silent over a day No/i.test(text), text.slice(-900));
  check('the page says what it was built from', /never both mixed/.test(text) && /FMS's own journeys/.test(text));
  const foot = await page.evaluate(() => document.querySelector('#pageFoot .pf-colophon')?.innerText || '');
  check('the colophon names the car, the day and the tracker', /L45235/.test(foot) && foot.includes(YDAY) && /FMS/.test(foot), foot);

  console.log('\n§3 the day picker');
  const prevHref = await page.$eval('.whr-nav a', (a) => a.getAttribute('href'));
  check('the previous-day link carries the day in the address', /#vehicle\/L45235\/whereabouts\?.*day=\d{4}-\d{2}-\d{2}/.test(prevHref), prevHref);
  asked.length = 0;
  await page.click('.whr-nav a >> nth=0');
  await page.waitForFunction(() => /What this page does not know/.test(document.querySelector('#view')?.innerText || ''), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
  check('…and following it asks for that day', asked.some((u) => u.includes(`day=${dubai(2)}`)), asked.join(' '));
  await ctx.close();
}

console.log('\n§4 a Fleet technician: bookings as totals only');
{
  role = 'TEC';
  const { ctx, page, errors, text } = await open(`vehicle/L45235/whereabouts?day=${YDAY}`);
  const kinds = await page.$$eval('.whr-strip > .whr-seg', (xs) => xs.map((x) => x.dataset.kind));
  check('no booking stretch and no anchor is drawn', !kinds.includes('booking')
    && (await page.$$('.whr-anchor')).length === 0 && kinds.includes('moved'), kinds.join(' '));
  check('…and the page says why, not as if there were none', /Only totals of individual bookings are shown to your role/.test(text)
    && /left as the tracker left them/.test(text) && !errors.length, text.slice(0, 600));
  role = null;
  await ctx.close();
}

console.log('\n§5 a tracker dead for days');
{
  const { ctx, page, text } = await open(`vehicle/L40971/whereabouts?day=${YDAY}`);
  const kinds = await page.$$eval('.whr-strip > .whr-seg', (xs) => xs.map((x) => x.dataset.kind));
  check('the whole day is a silence, said as "No reading since"', kinds.length === 1 && kinds[0] === 'silent'
    && /No reading since/.test(text), `${kinds.join(' ')} ${text.slice(0, 200)}`);
  const tile = await page.$$eval('.kpi', (ks) => ks.map((k) => k.innerText.replace(/\s+/g, ' ')).find((t) => /^tracker/i.test(t)) || '');
  check('…the tracker tile is absent with that reason, not a figure', /No reading since/.test(tile) && !/\d+ fixes/.test(tile), tile);
  check('…and the day is 0.0% positioned, 100.0% unknown — said, not hidden', /0\.0% positioned by its tracker, 0\.0% inferred, 100\.0% unknown/.test(text)
    && /Silent over a day Yes/i.test(text), text.slice(0, 500));
  await ctx.close();
}

console.log('\n§6 390 wide, on the phone');
{
  const { ctx, page, errors, text } = await open(`vehicle/L45235/whereabouts?day=${YDAY}`, { width: 390, height: 844, ui: 'phone' });
  check('the phone draws the tab with no error', !errors.length && /Positioned by fixes/i.test(text), errors.join(' | ') || text.slice(0, 160));
  const seg = await page.$$eval('.whr-strip > .whr-seg', (xs) => xs.length);
  check('…with the strip', seg > 5, String(seg));
  const wide = await page.evaluate(() => ({ doc: document.scrollingElement.scrollWidth, win: innerWidth,
    strip: document.querySelector('.whr-strip')?.getBoundingClientRect().right }));
  check('…and nothing wider than the screen', wide.doc <= wide.win + 1 && wide.strip <= wide.win + 1, JSON.stringify(wide));
  await ctx.close();
}
{
  const { ctx, errors, text } = await open(`vehicle/L45235/whereabouts?day=${YDAY}`, { width: 390, height: 844 });
  check('the desktop shell at 390 draws it too', !errors.length && /Positioned by fixes/i.test(text), errors.join(' | '));
  await ctx.close();
}

console.log('\n§7 the old skin');
{
  const { ctx, errors, text } = await open(`vehicle/L45235/whereabouts?day=${YDAY}`, { skin: 'classic' });
  check('the old skin draws the same content without an error', !errors.length && /Positioned by fixes/i.test(text)
    && /What this page does not know/i.test(text), errors.join(' | ') || text.slice(0, 160));
  await ctx.close();
}

await browser.close();
srv.close(); mockSrv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
