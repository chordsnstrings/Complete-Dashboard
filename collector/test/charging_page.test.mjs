/* CHARGING — a page whose most important panel is the one admitting what it
   cannot do.
   ══════════════════════════════════════════════════════════════════════════
   The operator asked for charging advances as their own page. The recorded
   half is exact: somebody typed it, attributed it, attached a photograph. The
   reconciliation half does not exist — this database holds no charging session
   at all, there is no table for one and no collector that fetches one.

   A page that showed only the first half would read as a charging report. The
   operator would take "AED 420 advanced for charging" as a figure somebody had
   checked, when nothing has checked it against a meter and nothing can. So
   four claims this page must not make, and one it must:

   1. NOT that the figures are reconciled. They are typed, and the page says
      so in the tile's own sub-line rather than in a footnote.

   2. NOT that a repayment offsets a charging advance. The ledger records a
      repayment against the PERSON, never against a particular advance —
      nothing knows whether AED 300 repaid charging, cash or salary. So the
      form offers charging advances ONLY, and the page says why rather than
      leaving the absence to look like an oversight.

   3. NOT that the idle hours at charging sites on #supply are a check on it.
      api/supply_routes.js matches an AREA NAME against a list of areas that
      contain a charger; test/charging.test.mjs pins exactly how narrow that
      is. It can say a car was left somewhere with a charger. It cannot say the
      car charged, and says nothing about who was in it. Beside a money figure
      that caveat would become a claim.

   4. NOT that its totals are the list's. The route filters by type and sums in
      SQL over the whole window; a page that pulled book=advance and filtered
      the ARRAY would compute its headline from a 200-row cap — the defect that
      shipped on #payouts as "AED 319,015 · 6 transfers" over 217 transfers and
      AED 3.46m.

   And the one it must: name what would have to change, specifically enough to
   act on. */
import { chromium, devices } from 'playwright';
import { readFileSync } from 'node:fs';
import { app } from '../mockapi.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

console.log('\nwhat it shows');
/* reducedMotion: THE HEADLINE NUMBERS COUNT UP, over 620ms
   (api/public/app.js countUp), and an assertion made mid-animation reads
   'AED 419.77' where the API returned exactly 420. Measured across six runs:
   419.72, 419.77, 419.83, 419.85, 419.95, 419.99 — a test that passes only
   when it happens to read after the last frame. Playwright can set the media
   query the product already honours, so the tiles carry their real value from
   the first paint. Deterministic, and it is a state a real reader can be in. */
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
/* ?skin=classic: this file asserts the CLASSIC desktop page's DOM (panels,
   tiles, pills), written when Classic was the desktop default. Arkiv became
   the default on 2026-09-28 and draws these pages in its own layout; Classic
   is still a look anyone can choose, so what this file proves still ships. */
await page.goto(`${base}/?skin=classic#charging`, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-panel="charging-people"] table', { timeout: 20000 });
const body = await page.evaluate(() => document.body.innerText);

/* ── the figures ───────────────────────────────────────────────────────── */
const headline = await page.$eval('[data-panel="charging"]', (e) => e.innerText);
check('what has been advanced is the headline', /ADVANCED IN/i.test(headline), headline.slice(0, 160));
check('and it is AED 420 — the two charging entries, not the whole advance book',
  /420\.00/.test(headline), headline.slice(0, 200));
check('the tile says the figure was typed and checked against no meter',
  /checked against no meter/i.test(headline), headline.slice(0, 300));
check('and the page says which dates it is over, rather than leaving it implied',
  /Both figures above and both tables below are over/.test(body));

/* ── who ───────────────────────────────────────────────────────────────── */
const who = await page.$$eval('[data-panel="charging-people"] tbody tr',
  (rows) => rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent.trim())));
check('each driver is listed once with what they have had',
  who.length === 2, JSON.stringify(who));
check('ordered largest first, so the biggest exposure reads first',
  /240/.test(who[0].join(' ')) && /180/.test(who[1].join(' ')), JSON.stringify(who));
check('and a driver name opens the person — not a dead end',
  (await page.$$('[data-panel="charging-people"] tbody a.ent')).length >= 1);

/* ── the register, and the three proof states ──────────────────────────── */
const proofs = await page.$$eval('[data-panel="charging-register"] tbody tr', (rows) =>
  rows.map((r) => {
    const c = [...r.querySelectorAll('td')][3];
    return { link: !!c?.querySelector('a'), title: c?.querySelector('.dash')?.getAttribute('title') || null };
  }));
check('the register lists only charging advances', proofs.length === 2, String(proofs.length));
check('a held photograph is a link to it', proofs.some((p) => p.link), JSON.stringify(proofs));
check('and one past its retention says it was held and has since gone',
  proofs.some((p) => /passed its twelve-month retention/.test(p.title || '')),
  JSON.stringify(proofs.map((p) => p.title)));

/* ── THE PANEL THIS PAGE EXISTS FOR ────────────────────────────────────── */
console.log('\nwhat it refuses to imply');
/* PowerDrive's sessions ARE read now (2026-11-03) — the mock answers 25
   charges — so the claim the page used to make, "this database holds no
   charging session at all", would be false. What must hold instead: it says
   they are read, and that matching an advance to them is NOT built. */
check('the page says PowerDrive’s sessions are read, and that no advance has been matched to them',
  /PowerDrive’s charging sessions are read now — 25 charges/.test(body) && /matching an advance to them is not built/.test(body)
  && !/holds no charging session at all/i.test(body), body.slice(-900));
check('and that the gap is ACCESS rather than availability — Tesla serves this',
  /dx\/charging\/sessions/.test(body) && /business fleet owners only/i.test(body));
check('naming why the token cannot be renewed here, specifically',
  /auth edge answers this platform’s egress with an HTML 403/i.test(body)
  || /HTML 403/.test(body), body.slice(-900));
check('and that billing gates it before any of that',
  /default spend limit is \$0/.test(body) && /UAE is not on Tesla’s\s*payment-supported/.test(body.replace(/\s+/g, ' ')),
  body.slice(-700));
check('that even ingested it would be partial, in the operator’s own terms',
  /drivers charge\s*outside our network/i.test(body.replace(/\s+/g, ' ')));
check('and that even complete it would not settle WHO owes it',
  /charger meters a VEHICLE and an advance is owed by a PERSON/i.test(body.replace(/\s+/g, ' ')));

/* THE ONE THAT MATTERS MOST — the near-miss inference. */
check('#supply’s idle-at-a-charger hours are named as NOT evidence of charging',
  /NOT evidence of charging/.test(body), body.slice(-600));
check('and the reason is given: it matches an AREA NAME, not a meter',
  /matches the AREA NAME a car was left in/.test(body.replace(/\s+/g, ' ')));

/* ── the repayment absence is explained, not silent ────────────────────── */
check('the form offers charging advances only',
  (await page.$$eval('[data-panel="charging-form"] .depchips .depchip',
    (c) => c.map((x) => x.textContent.trim()))).filter((t) => /advance|repay/i.test(t)).length === 1,
  JSON.stringify(await page.$$eval('[data-panel="charging-form"] .depchips .depchip',
    (c) => c.map((x) => x.textContent.trim()))));
check('and the page says WHY a repayment is not recorded here',
  /records a repayment against the PERSON and not against a particular advance/.test(
    body.replace(/\s+/g, ' ')), body.slice(0, 900));
check('sending the reader to Advances, where a repayment means what it says',
  (await page.$$eval('[data-panel="charging-form"] a.lnk', (a) => a.map((x) => x.getAttribute('href'))))
    .some((h) => /#advances/.test(h || '')));

/* ── PowerDrive: wallets, the queue, charging by car ───────────────────── */
console.log('\nPowerDrive');
{
  const wal = await page.$eval('[data-panel="charging-wallets"]', (e) => e.innerText);
  check('the wallets panel: five linked drivers, the total, the one below zero',
    /Drivers with a linked wallet\s*5/i.test(wal) && /AED 609\.75/.test(wal) && /Below zero\s*1/i.test(wal), wal.slice(0, 400));
  const rows = await page.$$eval('[data-panel="charging-wallets"] tbody tr', (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ')));
  check('…a row a driver, lowest balance first, the fleet-wallet driver showing what is left of the limit',
    rows.length === 5 && /−AED 36\.75/.test(rows[0]) && rows.some((r) => /AED 912\.30 left of the limit/.test(r)), JSON.stringify(rows));
  check('…each name opens the person, by the person address', (await page.$$eval('[data-panel="charging-wallets"] tbody a.lnk',
    (a) => a.map((x) => x.getAttribute('href')))).every((h) => /^#driver\/p\d+/.test(h || '')));
  const cars = await page.$$eval('[data-panel="charging-cars"] tbody tr', (trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ')));
  check('charging by car: a row a car, most charges first, each saying how its charges reached it',
    cars.length === 3 && /11/.test(cars[0]) && /2 its own plate · 8 the only car driven that day · 1 the nearest booking/.test(cars[0]), JSON.stringify(cars));
  const carTxt = await page.$eval('[data-panel="charging-cars"]', (e) => e.innerText.replace(/\s+/g, ' '));
  check('…and the charges on no car are counted with why, never dropped',
    /3 charges are on no car: 2 by a linked driver who drove no car that day, 1 by a PowerDrive customer/.test(carTxt), carTxt.slice(-400));
  /* A decision is the reader's, sent as exactly the pair on screen. */
  const sent = [];
  await page.route('**/api/charging/link', async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  const items = await page.$$('[data-panel="charging-review"] li');
  check('the queue offers each suggestion with its reason', items.length === 2
    && /the mobile is on 2 of our records/.test(await items[0].innerText()), String(items.length));
  await (await items[0].$('button.btn:not(.ghost)')).click();
  await page.waitForTimeout(400);
  await page.waitForSelector('[data-panel="charging-review"] li', { timeout: 10000 });
  await (await (await page.$$('[data-panel="charging-review"] li'))[1].$('button.ghost')).click();
  await page.waitForTimeout(400);
  check('"Same person" and "Not this person" send that customer, that person, and the decision',
    sent.length === 2 && sent[0].yc_user_id === 'yc-r1' && sent[0].person_id === 105 && sent[0].decision === 'confirm'
    && sent[1].yc_user_id === 'yc-r2' && sent[1].person_id === 106 && sent[1].decision === 'refuse', JSON.stringify(sent));
  /* REVERSION (run 2026-11-03): decide('confirm') sending decision: 'refuse'
     -> this check fails. */
}
{
  /* PowerDrive unread — the state production starts in: every panel says
     why, nothing reads AED 0, and the meter sentence names the reason. */
  /* Its own context: the first page's service worker would otherwise answer
     these requests itself, and page.route never sees a worker's fetch. */
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const p2 = await ctx2.newPage();
  const unread = { why: 'PowerDrive has not been read yet — the charging collector runs every six hours once its key and client id are set (Settings → Charging).', customers: 0 };
  await p2.route('**/api/charging/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(unread) }));
  await p2.goto(`${base}/?skin=classic#charging`, { waitUntil: 'load' });
  await p2.waitForSelector('[data-panel="charging-people"] table', { timeout: 20000 });
  await p2.waitForFunction(() => /has not been read yet/.test(document.querySelector('[data-panel="charging-wallets"]')?.innerText || ''), null, { timeout: 20000 }).catch(() => {});
  const b2 = (await p2.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
  const w2 = await p2.$eval('[data-panel="charging-wallets"]', (e) => e.innerText);
  check('unread: the wallets panel gives the reason and no figure', /has not been read yet/.test(w2) && !/AED/.test(w2), w2);
  check('…and the meter sentence names the same reason, not "none ingested" or a nought',
    /None of it has been checked against a charging meter: PowerDrive has not been read yet/.test(b2), b2.slice(-900));
  await ctx2.close();
}

/* ── the source rule, checked in the source ────────────────────────────── */
console.log('\nhow it gets its numbers');
{
  const src = readFileSync(new URL('../api/public/charging.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  check('the type filter is the ROUTE’s, not a filter over the returned array',
    /type_code: 'charging_advance'/.test(code) && !/\.filter\([^)]*type_code/.test(code),
    'the page filters entries client-side, which recomputes the headline from the 200-row cap');
  check('and the per-person table is the server’s rollup, not one built here',
    /by_person/.test(code) && !/reduce\(/.test(code),
    'the page is summing rows itself');
  check('the window comes from the shell rather than a second reading of the hash',
    /qAll\(/.test(code) && !/location\.hash/.test(code));
}

const w = await page.evaluate(() => document.documentElement.scrollWidth);
check('the page does not slide sideways', w <= 1440, String(w));
check('and it threw nothing', errs.length === 0, JSON.stringify(errs));
await ctx.close();

/* ── a window nobody recorded a charging advance in ────────────────────────
   /api/ledger/entries sums over no rows and answers totals.advance: null. The
   tile fell back to the literal 'AED 0.00' — a bold measured nought — for a
   register that is typed by hand and simply holds no row for these dates.
   Absent with its reason, never a zero (CLAUDE.md), and never AED 0.00 now
   that every money figure carries its fils (the ruling of 2026-09-23).
   REVERSION THAT PROVES THIS: restore `aed(t.advance) || 'AED 0.00'` in
   api/public/charging.js; the first check fails on "AED 0.00". */
console.log('\na window with no charging row');
{
  const c3 = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const pg = await c3.newPage();
  await pg.route('**/api/ledger/entries*', (route) => route.fulfill({
    contentType: 'application/json',
    /* The route's own shape for a window with no row (api/ledger_routes.js,
       and mockapi.mjs's empty branch): a sum over nothing is null. */
    body: JSON.stringify({ from: null, to: null, person_id: null, book: 'advance',
      totals: { rows: 0, verification_rows: 0, advance: null, cash: null },
      by_person: [], shown: 0, listed_why: null, entries: [], absent_reason: null }),
  }));
  await pg.goto(`${base}/?skin=classic#charging`, { waitUntil: 'networkidle' });
  await pg.waitForSelector('[data-panel="charging"] .kpi', { timeout: 20000 });
  const tile = await pg.$eval('[data-panel="charging"] .kpi', (e) => e.innerText);
  check('the headline is a dash, not "AED 0.00"',
    !/AED\s*0\.00/.test(tile) && /^\s*—\s*$/m.test(tile), JSON.stringify(tile));
  check('and the sub-line says it is no record rather than a measured nought',
    /nothing has been recorded for charging in these dates/.test(tile)
    && /not a measured nought/.test(tile), JSON.stringify(tile));
  await c3.close();
}

/* ── on a phone ────────────────────────────────────────────────────────── */
console.log('\non a phone');
{
  const p2 = await browser.newContext({ ...devices['iPhone 13'] });
  const pg = await p2.newPage();
  const e2 = []; pg.on('pageerror', (e) => e2.push(String(e).slice(0, 200)));
  await pg.goto(`${base}/?skin=classic#charging`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForTimeout(6000);
  const doc = await pg.evaluate(() => document.documentElement.scrollWidth);
  const vw = await pg.evaluate(() => window.innerWidth);
  const txt = await pg.evaluate(() => document.body.innerText);
  check('#charging does not slide sideways on a phone', doc <= vw + 1, `${doc} vs ${vw}`);
  /* THE FALLBACK IS THE RIGHT ANSWER HERE, and the assertion says so rather
     than pretending the desktop page renders. Every Money page except
     #deposits shows it: api/public/m/screens.js renders a desktop module only
     for #driver and #vehicle, and this page is two wide tables. What it must
     NOT do is head that message with "charging", the router's word for the
     route — which is exactly what it did until this test was written, and what
     that file already warns about three times for other pages. */
  check('the phone says plainly that this one is built for a bigger screen',
    /Built for a bigger screen/.test(txt), txt.slice(0, 200));
  check('under the product\'s name for the page, not the router\'s word for it',
    /Charging/.test(txt) && !/^\s*charging\s*$/m.test(txt),
    JSON.stringify(txt.split('\n').slice(0, 6)));
  check('with nothing thrown', e2.length === 0, JSON.stringify(e2));
  await p2.close();
}

await browser.close();
srv.close();
console.log(`\n${fail ? '✗' : '✓'} charging_page: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
