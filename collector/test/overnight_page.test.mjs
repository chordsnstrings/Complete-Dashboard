/* Where each car spent the night — the three placements, in Chromium against
   the mock (OVN, 2026-11-16).
   ──────────────────────────────────────────────────────────────────────────
   The mock runs synthetic fixes through the REAL slicing, WHR arithmetic and
   answer builder (api/overnight.js), so what is drawn here is what the route
   would hand these pages. Each placement in both skins (Arkiv, the default;
   Classic, ?skin=classic) at 1280 and at 390, service workers blocked:

     §1  #vehicles: "Where cars spent the night" — its module fetched only
         when the page asks (not on other pages); the by-area line, the five
         counts, the table (plates linked to the car's "Where it was" for the
         morning, not-parked rows with their reason as an absent value,
         unnamed ground with why); the night picker moves the night; the
         request carries no shell window; nothing wider than the screen;
     §2  #driver/<id>/activity: every drawn day carries its overnight line,
         one read for all of them, the car driven last that day, the day still
         running says its night has not begun, a not-parked night its reason,
         every row the same height; "(car L…)" when two cars were driven;
     §3  #driver/<id>/day: the night before and the night after, with the
         car, the place and a link; today's night after has not begun;
     §4  a role without locations: the server's own refusal in each place —
         not an error, not a blank.
   Review (OVN12, §2/§2b): "inferred" sits inside the visible Activity line
   at every width; (§2c) twelve cars over 55 days are asked in pieces.

   Port 8327 unless PORT says otherwise. Synthetic data only. */
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const { app: mock } = await import('../mockapi.mjs');
const { launchChromium } = await import('./browser.mjs');
const { withheldSentence } = await import('../api/public/access_model.js');
const express = (await import('express')).default;

const mockSrv = mock.listen(0); await new Promise((r) => mockSrv.once('listening', r));
const mockBase = `http://127.0.0.1:${mockSrv.address().port}`;
let refuse = false;
const asked = [];
const web = express();
/* The gate's refusal for a role whose levels hold no LOC (Finance manager,
   HR officer, Cash desk): the body api/access/middleware.js builds for a
   route whose SUBJECT is LOC — withheldBody('LOC', '') — with the header it
   sets beside it. */
web.get('/api/overnight', async (req, res) => {
  asked.push(req.originalUrl);
  if (refuse) {
    return res.status(403).set('x-fm-withheld', 'LOC')
      .json({ error: 'withheld', class: 'LOC', level: '', detail: withheldSentence('LOC', { level: '' }) });
  }
  const r = await fetch(`${mockBase}${req.originalUrl}`);
  res.status(r.status).set('cache-control', 'no-store').json(await r.json());
});
web.use(mock);
/* PORT overrides the default, so two sessions can run this side by side. */
const PORT = Number(process.env.PORT || 8327);
const srv = web.listen(PORT); await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;

const dubai = (back = 0) => new Date(Date.now() + 4 * 3600e3 - back * 864e5).toISOString().slice(0, 10);
const TODAY = dubai(0); const YDAY = dubai(1); const DBY = dubai(2);
const browser = await launchChromium();
async function open(route, { width = 1280, skin = '', until, shift = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', timezoneId: 'Asia/Dubai',
    locale: 'en-GB', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors = []; const js = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  page.on('request', (r) => { const p = new URL(r.url()).pathname; if (p.endsWith('.js')) js.push(p); });
  if (shift) await page.route('**/api/driver/shift**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(shift) }));
  await page.goto(`${base}/?ui=desktop${skin ? `&skin=${skin}` : ''}#${route}`, { waitUntil: 'load' });
  const ok = until ? await page.waitForFunction(until, null, { timeout: 60000 }).then(() => true).catch(() => false) : true;
  await page.waitForTimeout(250);
  const wide = await page.evaluate(() => ({ doc: document.scrollingElement.scrollWidth, win: innerWidth }));
  return { ctx, page, errors, js, ok, wide };
}
const fleetDone = () => !!document.querySelector('[data-panel="veh-ovn"] .ovn-counts, [data-panel="veh-ovn"] .note');
const actDone = () => document.querySelectorAll('.shift[data-day] .sh-n').length > 0
  && !document.querySelector('.shift[data-day] .sh-n[data-state="wait"]');
const dayDone = () => document.querySelectorAll('[data-panel="dday-ovn"] .ovn-day-row').length === 2;

console.log('\n§0 the module is not fetched where it is not drawn');
{
  const { ctx, page, js, errors } = await open('overview', { until: () => /Overview|Money/i.test(document.querySelector('#view')?.innerText || '') });
  await page.waitForTimeout(1500);
  check('#overview loads without api/public/overnight.js', !js.some((p) => p.endsWith('/overnight.js')) && !errors.length,
    js.filter((p) => /overnight/.test(p)).join(' ') + errors.join(' | '));
  await ctx.close();
}

for (const skin of ['', 'classic']) {
  for (const width of [1280, 390]) {
    const tag = `${skin || 'arkiv'} ${width}`;
    console.log(`\n§1 #vehicles — ${tag}`);
    {
      asked.length = 0;
      const { ctx, page, errors, js, ok, wide } = await open('vehicles', { width, skin, until: fleetDone });
      check(`${tag}: the panel draws, with no script error`, ok && !errors.length, errors.join(' | '));
      check(`${tag}: its module was fetched for it`, js.some((p) => p.endsWith('/overnight.js')));
      check(`${tag}: one read of last night, with no shell window on it`, asked.length === 1 && asked[0].includes(`night=${YDAY}`)
        && !/from=|to=|days=|period=/.test(asked[0]), asked.join(' '));
      const g = await page.evaluate(() => {
        const p = document.querySelector('[data-panel="veh-ovn"]');
        const rows = [...p.querySelectorAll('tbody tr')];
        return {
          title: p.querySelector('h3')?.textContent || '',
          areas: p.querySelector('.ovn-areas')?.innerText || '',
          chips: [...p.querySelectorAll('.ovn-chip[data-k]')].map((c) => [c.dataset.k, Number(c.querySelector('b')?.textContent)]),
          rows: rows.map((r) => [...r.cells].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join(' | ')),
          offs: [...p.querySelectorAll('tbody .ent-off.ovn-why')].map((s) => s.innerText),
          link: p.querySelector('tbody a.lnk[href*="L45235"]')?.getAttribute('href') || null,
          /* Not cut: the Arkiv fold layer reads "No reading" as an absence
             line and clamps it to one line (seen at 390 before the counts
             were marked as figures). */
          clipped: ['.ovn-counts', '.ovn-areas'].filter((s) => { const n = p.querySelector(s);
            return !n || n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1; }),
        };
      });
      check(`${tag}: titled for what it is`, /Where cars spent the night/i.test(g.title), g.title);
      check(`${tag}: the by-area line and the counts are whole, not cut to a line`, g.clipped.length === 0, g.clipped.join(' '));
      check(`${tag}: where the fleet slept, by area, with the unnamed counted and why`, /Where the fleet slept:/.test(g.areas)
        && /\d+ International City/.test(g.areas) && /on unnamed ground/.test(g.areas)
        && /ground the fleet has never driven near has no name/.test(g.areas), g.areas);
      const total = g.chips.reduce((a, [, v]) => a + v, 0);
      check(`${tag}: five counts — parked seen, inferred, not known, no reading, on the move — over the 20 cars`,
        g.chips.length === 5 && total === 20 && g.chips.every(([, v]) => Number.isFinite(v)), JSON.stringify(g.chips));
      check(`${tag}: the cars the night does not account for come first, each with its reason as an absent value`,
        /^L\d+ \| no reading — No reading since/.test(g.rows[0] || '') && g.offs.some((t) => /Moved while the tracker was silent/.test(t))
        && g.offs.some((t) => /^on the move — It drove for/.test(t)), JSON.stringify(g.rows.slice(0, 4)));
      check(`${tag}: a plate opens that car’s "Where it was" on the morning after`,
        new RegExp(`^#vehicle/L45235/whereabouts\\?(.*&)?day=${TODAY}(&|$)`).test(g.link || ''), g.link);
      check(`${tag}: a parked row says where, from–to with days, and seen or inferred`,
        g.rows.some((r) => /^L45235 \| Al Barsha 1 \| \d\d:\d\d \d+ \w+–\d\d:\d\d \d+ \w+ \| seen \| FMS$/.test(r))
        && g.rows.some((r) => /^L12615 \| International City \| .* \| inferred \| FMS$/.test(r)), JSON.stringify(g.rows.filter((r) => /L45235|L12615/.test(r))));
      check(`${tag}: nothing wider than the screen`, wide.doc <= wide.win, JSON.stringify(wide));
      if (width === 1280 && !skin) {
        /* The picker: the night before, through the panel alone. */
        asked.length = 0;
        await page.click('[data-panel="veh-ovn"] .ovn-nav [data-go]');
        const moved = await page.waitForFunction((d) => document.querySelector('#ovnNight')?.value === d
          && !!document.querySelector('[data-panel="veh-ovn"] .ovn-counts'), DBY, { timeout: 20000 }).then(() => true).catch(() => false);
        check('the picker moves to the night before, and asks for it', moved && asked.some((u) => u.includes(`night=${DBY}`)), asked.join(' '));
        /* Unfolded, the unnamed ground's row says why. */
        await page.evaluate(() => { [...document.querySelectorAll('[data-panel="veh-ovn"] button, [data-panel="veh-ovn"] a')]
          .find((b) => /show the other/i.test(b.textContent || ''))?.click(); });
        await page.waitForTimeout(300);
        const un = await page.evaluate(() => [...document.querySelectorAll('[data-panel="veh-ovn"] tbody tr')]
          .map((r) => [...r.cells].map((c) => c.innerText.replace(/\s+/g, ' ').trim()).join(' | ')).find((t) => /^L76098/.test(t)) || '');
        check('unnamed ground is "unnamed ground", with why — never a guessed name', /^L76098 \| unnamed ground — Ground the fleet has never driven near has no name/.test(un), un);
      }
      await ctx.close();
    }

    console.log(`\n§2 #driver/<id>/activity — ${tag}`);
    {
      asked.length = 0;
      const { ctx, page, errors, ok, wide } = await open('driver/drv-0/activity', { width, skin, until: actDone });
      check(`${tag}: every drawn day carries its overnight line, with no script error`, ok && !errors.length, errors.join(' | '));
      const a = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.shift[data-day]')];
        return rows.map((r) => ({ day: r.dataset.day, h: Math.round(r.getBoundingClientRect().height),
          line: r.querySelector('.sh-n')?.textContent || '', lineH: Math.round(r.querySelector('.sh-n')?.getBoundingClientRect().height || 0),
          off: r.querySelector('.sh-n')?.classList.contains('ent-off') }));
      });
      /* The mock's shift days are UTC days (mockapi.mjs dayISO), so from 20:00
         UTC its last row is Dubai's yesterday, not today (COVERAGE "Two suites
         fail every evening"): the range's end is read off the drawn rows, and
         the not-begun line is held exactly by §2b's fixed fixture. */
      const days = a.map((x) => x.day);
      const lastAsked = days[days.length - 1] < YDAY ? days[days.length - 1] : YDAY;
      check(`${tag}: one read for every row, over the drawn days to last night, for the car driven`,
        asked.length === 1 && asked[0].includes('plates=L44251') && asked[0].includes(`from=${days[0]}`) && asked[0].includes(`to=${lastAsked}`),
        asked.join(' '));
      const unbegun = a.filter((x) => x.day > YDAY);
      check(`${tag}: a day whose night has not begun says so`, unbegun.every((x) => /night after this day has not begun yet/.test(x.line) && x.off),
        JSON.stringify(unbegun));
      check(`${tag}: a parked night says where and when`, a.some((x) => /^Parked overnight at [A-Z][\w ]+ \(\d\d:\d\d–\d\d:\d\d\)/.test(x.line) && !x.off),
        JSON.stringify(a.map((x) => x.line.slice(0, 60))));
      check(`${tag}: a night that was not a stay says why, as an absent value`, a.some((x) => /^Overnight: (not known|on the move|no reading) — /.test(x.line) && x.off),
        JSON.stringify(a.map((x) => x.line.slice(0, 60))));
      /* OVN12: the line is cut with an ellipsis, so "inferred" must sit where
         it is never cut — the first draft put it last, and at 390 in Classic
         an inferred night read exactly like a watched one. */
      const basisSeen = await page.evaluate(() => [...document.querySelectorAll('.shift[data-day] .sh-n')]
        .filter((ln) => /inferred/.test(ln.textContent)).map((ln) => {
          const t = ln.firstChild; const i = t.textContent.indexOf('inferred');
          const rg = document.createRange(); rg.setStart(t, i); rg.setEnd(t, i + 8);
          return { day: ln.closest('.shift').dataset.day, seen: rg.getBoundingClientRect().right <= ln.getBoundingClientRect().right + 0.5 };
        }));
      check(`${tag}: "inferred" is inside the visible line on every inferred night (${basisSeen.length} drawn)`,
        basisSeen.every((x) => x.seen), JSON.stringify(basisSeen));
      const hs = a.map((x) => x.h);
      check(`${tag}: every row the same height — the line is one line, however long its reason`,
        Math.max(...hs) - Math.min(...hs) <= 1 && a.every((x) => x.lineH > 0 && x.lineH < 24), JSON.stringify([...new Set(hs)]) + JSON.stringify([...new Set(a.map((x) => x.lineH))]));
      check(`${tag}: nothing wider than the screen`, wide.doc <= wide.win, JSON.stringify(wide));
      await ctx.close();
    }

    console.log(`\n§3 #driver/<id>/day — ${tag}`);
    {
      asked.length = 0;
      const { ctx, page, errors, ok, wide } = await open(`driver/drv-0/day?on=${YDAY}`, { width, skin, until: dayDone });
      check(`${tag}: the Overnight panel draws two nights, with no script error`, ok && !errors.length, errors.join(' | '));
      const d = await page.evaluate(() => [...document.querySelectorAll('[data-panel="dday-ovn"] .ovn-day-row')].map((r) => {
        const b = r.lastElementChild;
        return { which: r.dataset.which, text: r.innerText.replace(/\s+/g, ' '), link: r.querySelector('a.lnk')?.getAttribute('href') || null,
          cut: b.scrollHeight > b.clientHeight + 1 || getComputedStyle(b).webkitLineClamp !== 'none' };
      }));
      check(`${tag}: each night’s sentence is whole, link included — not cut to a line`, d.length === 2 && d.every((x) => !x.cut), JSON.stringify(d.map((x) => x.cut)));
      const [bef, aft] = d;
      check(`${tag}: the night before — the car first driven, where it stood when the day began`, bef?.which === 'before'
        && /The night before/.test(bef.text) && /A 12345, the car first driven this day — (Parked overnight|not known|on the move|no reading)/.test(bef.text)
        && new RegExp(`^#vehicle/A%2012345/whereabouts\\?(.*&)?day=${YDAY}(&|$)`).test(bef.link || ''), JSON.stringify(bef));
      check(`${tag}: the night after — the car last driven, where it was left`, aft?.which === 'after'
        && /The night after/.test(aft.text) && /A 12345, the car last driven this day/.test(aft.text)
        && new RegExp(`^#vehicle/A%2012345/whereabouts\\?(.*&)?day=${TODAY}(&|$)`).test(aft.link || ''), JSON.stringify(aft));
      check(`${tag}: one read, both nights, the plate as the route spells it`, asked.length === 1 && asked[0].includes('plates=A12345')
        && asked[0].includes(`from=${DBY}`) && asked[0].includes(`to=${YDAY}`), asked.join(' '));
      check(`${tag}: nothing wider than the screen`, wide.doc <= wide.win, JSON.stringify(wide));
      await ctx.close();
      if (width === 1280) {
        const t = await open(`driver/drv-0/day?on=${TODAY}`, { width, skin, until: dayDone });
        const after = await t.page.evaluate(() => document.querySelector('[data-panel="dday-ovn"] .ovn-day-row[data-which="after"]')?.innerText || '');
        check(`${tag}: today’s night after has not begun, and says when it will be read`, /night after this day has not begun yet: it is read 00:00–05:00/.test(after)
          && !t.errors.length, after);
        await t.ctx.close();
      }
    }
  }
}

console.log('\n§2b two cars in one day');
{
  /* The person drove L45235 in the morning and L12615 last: the line follows
     L12615, and names it. A cancellation on a third car after that does not
     make it the car driven last. */
  const job = (s, plate, extra = {}) => ({ s, e: s + 30, over: false, platform: 'uber', plate, outcome: 'completed', ...extra });
  const SHIFT = { basis: 'synthetic', unknown_end: 0, days: [{ day: YDAY, bookings: 3, on_job_min: 60, wait_min: 300, longest_wait_min: 300,
    overlaps: 0, unknown_end: 0, first_min: 480, last_min: 1300, span_min: 820,
    jobs: [job(480, 'L45235'), job(1270, 'L12615'), job(1330, 'L94178', { e: null, outcome: 'not_completed', cancel_by: 'rider' })] },
  { day: TODAY, bookings: 1, on_job_min: 30, wait_min: 0, longest_wait_min: 0, overlaps: 0, unknown_end: 0,
    first_min: 300, last_min: 330, span_min: 30, jobs: [job(300, 'L45235')] }] };
  asked.length = 0;
  const { ctx, page, errors, ok } = await open('driver/drv-0/activity', { shift: SHIFT, until: actDone });
  const line = await page.evaluate((d) => document.querySelector(`.shift[data-day="${d}"] .sh-n`)?.textContent || '', YDAY);
  check('the line follows the car driven last, names it, and says the night was inferred — first, where the ellipsis cannot cut it', ok && !errors.length
    && /^Parked overnight \(inferred\) at International City \(.*\) \(car L12615\) — the tracker was quiet/.test(line) && asked.some((u) => /plates=L12615/.test(u))
    && !asked.some((u) => /L94178/.test(u)), `${line} ${asked.join(' ')} ${errors.join(' | ')}`);
  const todayLine = await page.evaluate((d) => document.querySelector(`.shift[data-day="${d}"] .sh-n`)?.textContent || '', TODAY);
  check('today’s night has not begun, says so, and is not asked for', todayLine === 'Overnight: the night after this day has not begun yet.'
    && asked.every((u) => !u.includes(`to=${TODAY}`)), `${todayLine} ${asked.join(' ')}`);
  await ctx.close();
  /* OVN12, held on a fixed fixture: L12615 is inferred every night. At 390
     in Classic the first draft's line ended at "(…–07:55) (car L…" and the
     word never showed. REVERSION: put the basis back at the end of
     nightLine's text — this fails. */
  for (const [skin, width] of [['classic', 390], ['', 390]]) {
    const n = await open('driver/drv-0/activity', { shift: SHIFT, until: actDone, skin, width });
    const seen = await n.page.evaluate((d) => {
      const ln = document.querySelector(`.shift[data-day="${d}"] .sh-n`);
      const t = ln?.firstChild; const i = t ? t.textContent.indexOf('inferred') : -1;
      if (i < 0) return { i, text: ln?.textContent || '' };
      const rg = document.createRange(); rg.setStart(t, i); rg.setEnd(t, i + 8);
      return { i, right: rg.getBoundingClientRect().right, box: ln.getBoundingClientRect().right };
    }, YDAY);
    check(`${skin || 'arkiv'} ${width}: the inferred night says "inferred" inside the visible line`, !n.errors.length && seen.i >= 0
      && seen.right <= seen.box + 0.5, JSON.stringify(seen));
    await n.ctx.close();
  }
}

console.log('\n§2c more cars than one read takes, over more nights than one read takes');
{
  /* The route takes at most 10 plates and 31 nights a call; a person who
     drove twelve cars across 55 days is asked in pieces and every row is
     answered. REVERSION: drop the plate chunking or the 31-night spans in
     readCarNights — the route refuses with a 400 and the rows say "could
     not be read". */
  const job = (s, plate) => ({ s, e: s + 30, over: false, platform: 'uber', plate, outcome: 'completed' });
  const days = Array.from({ length: 28 }, (_, i) => dubai(2 + 2 * i)).reverse();
  const SHIFT2 = { basis: 'synthetic', unknown_end: 0, days: days.map((day, i) => ({ day, bookings: 1, on_job_min: 30, wait_min: 0,
    longest_wait_min: 0, overlaps: 0, unknown_end: 0, first_min: 600, last_min: 630, span_min: 30, jobs: [job(600, `L${1000 + (i % 12)}`)] })) };
  asked.length = 0;
  const { ctx, page, errors, ok } = await open('driver/drv-0/activity', { shift: SHIFT2, until: actDone });
  const lines = await page.evaluate(() => [...document.querySelectorAll('.shift[data-day] .sh-n')].map((n) => n.textContent));
  const calls = asked.map((u) => new URL(u, base).searchParams);
  const nightsIn = (c) => Math.round((Date.parse(`${c.get('to')}T12:00:00Z`) - Date.parse(`${c.get('from')}T12:00:00Z`)) / 864e5) + 1;
  check('asked in pieces: every call within 10 plates and 31 nights, the twelve cars and 55 days all covered',
    ok && !errors.length && calls.length >= 4 && calls.every((c) => c.get('plates').split(',').length <= 10 && nightsIn(c) <= 31)
    && new Set(calls.flatMap((c) => c.get('plates').split(','))).size === 12, asked.join(' ') + errors.join(' | '));
  check('every row answered — none "could not be read"', lines.length === 28
    && lines.every((t) => /^(Parked overnight|Overnight: (not known|on the move|no reading|no tracker))/.test(t)), JSON.stringify(lines.slice(0, 4)));
  await ctx.close();
}

console.log('\n§4 a role without locations is told the server’s reason');
{
  refuse = true;
  const why = withheldSentence('LOC', { level: '' });
  const v = await open('vehicles', { until: fleetDone });
  const vt = await v.page.evaluate(() => document.querySelector('[data-panel="veh-ovn"] .pbody')?.innerText || '');
  check('#vehicles: the panel says it is not shown, in the server’s words — no error, no blank', !v.errors.length
    && /not shown to your role/i.test(vt) && vt.includes(why) && !/could not be read/i.test(vt), vt);
  await v.ctx.close();
  const a = await open('driver/drv-0/activity', { until: actDone });
  const lines = await a.page.evaluate(() => [...document.querySelectorAll('.shift[data-day]')]
    .map((r) => [r.dataset.day, r.querySelector('.sh-n')?.textContent || '']));
  const past = lines.filter(([d]) => d <= YDAY);
  check('Activity: each past day’s line carries the refusal', !a.errors.length && past.length > 1
    && past.every(([, t]) => t === `Overnight: ${why}`), JSON.stringify(lines.slice(0, 3)));
  await a.ctx.close();
  const d = await open(`driver/drv-0/day?on=${YDAY}`, { until: dayDone });
  const dt = await d.page.evaluate(() => document.querySelector('[data-panel="dday-ovn"]')?.innerText || '');
  check('the day page: both nights carry the refusal', !d.errors.length && dt.split(why).length === 3 && !/could not be read/i.test(dt), dt);
  await d.ctx.close();
  refuse = false;
}

await browser.close();
srv.close(); mockSrv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
