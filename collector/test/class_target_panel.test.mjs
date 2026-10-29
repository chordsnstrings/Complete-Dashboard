/* THE OWNER'S CLASS PANEL — api/public/accessadmin.js targetPanel, drawn on
   its own in Chromium against the real GET /api/access/target and POST
   /api/access/target/classes (api/access/routes.js) over PGlite.
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-29: "Let me set targets vehicle wise. Make model year
   - per day target". The fleet is production's of that morning in miniature:
   its eight classes in their counts (42 BYD Han EV 2025s … one ES 300h), two
   cars with no make or model, every car earning its class's AED a day, and
   the month's target saved as one figure for every car. What must hold:
     · a box a class with its cars now and what a car of it usually earns,
       and one for every other car naming the plates it covers;
     · every box starts at the figure in force (one figure for every car);
     · the preview's month is the month the save then reads, to the fils;
     · Save sends each class with a figure, leaves an emptied one to the
       figure for every other car, and the history lists the save.
   The access layer itself is test/access_core.test.mjs's: here the request
   arrives as the Owner, re-confirmed, so only the panel and its two routes
   are under test. Synthetic plates (C…, X…) only. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySchema } from './schema.mjs';
import { accessRoutes } from '../api/access/routes.js';
import { launchChromium } from './browser.mjs';
import { dubaiDay } from '../api/window.js';
import * as rt from '../api/revenue_target.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const browser = await launchChromium();
/* Twice: the month save made on an earlier day (the days gone keep their
   plan), and made today (a class save today replaces it, the days gone
   included — the same-day rule — and the preview says "about"). */
async function scenario(sameDay) {
  console.log(sameDay ? '\nthe month saved today' : '\nthe month saved on an earlier day');
  const db = new PGlite();
  await applySchema(db);
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);
  const MIX = [['BYD', 'Han EV', 2025, 42, 520], ['Tesla', 'Model Y', 2023, 36, 380], ['Polestar', '4', 2025, 10, 470],
    ['Tesla', 'Model Y', 2025, 5, 430], ['Tesla', 'Model Y', 2024, 4, 300], ['Tesla', 'Model 3', 2024, 4, 280],
    ['Toyota', 'Highlander', 2023, 2, 600], ['Lexus', 'ES 300h', 2023, 1, 260]];
  const cars = [];
  let k = 0;
  for (const [make, model, year, n, fare] of MIX) {
    for (let i = 0; i < n; i++) cars.push({ plate: `C${++k}`, make, model, year, fare });
  }
  cars.push({ plate: 'X1', fare: 300 }, { plate: 'X2', fare: 300 });
  await q(`INSERT INTO vehicle (plate, make, model, year) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[])`,
    [cars.filter((c) => c.make).map((c) => c.plate), cars.filter((c) => c.make).map((c) => c.make),
      cars.filter((c) => c.make).map((c) => c.model), cars.filter((c) => c.make).map((c) => c.year)]);
  const today = dubaiDay(new Date());
  const from = rt.addDays(today, -40);
  await q(`INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
    SELECT 'uber', 'x-' || p.plate || '-' || d::date, 'ecosine', 'u-' || p.plate, 'Test Driver ' || p.plate, p.plate,
           (d::date + time '08:00') AT TIME ZONE 'Asia/Dubai', (d::date + time '08:20') AT TIME ZONE 'Asia/Dubai',
           'completed', 'card', p.fare, 'AED', '{}'::jsonb
      FROM unnest($1::text[], $2::numeric[]) AS p(plate, fare), generate_series($3::date, $4::date, interval '1 day') d`,
  [cars.map((c) => c.plate), cars.map((c) => c.fare), from, rt.addDays(today, -1)]);
  await q(`INSERT INTO collection_run (source, fleet_id, mode, window_start, window_end, started_at, finished_at, status)
    VALUES ('uber', 'ecosine', 'incremental', $1::date, $2::date, now(), now(), 'ok')`, [rt.addDays(from, -1), today]);
  /* The month's target as one figure for every car, saved on an earlier day
     when the month has one (on its first three days, today). */
  const month = today.slice(0, 7);
  const setOn = !sameDay && rt.addDays(today, -3) >= `${month}-01` ? new Date(Date.now() - 3 * 864e5) : new Date();
  const flat = await rt.saveTarget(q, { month, gross: 1750500, now: setOn, by: 1, byLabel: 'owner@example.test' });
  check('the fixture: a month save over the 106 cars', flat.row?.cars === 106, JSON.stringify(flat).slice(0, 200));

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.fm = { kind: 'user', user: { id: 1, email: 'owner@example.test' }, access: { preview: false, caps: ['access.manage'] },
      grants: [{ role_code: 'OWN' }], session: { id: 's1', stepup_at: new Date().toISOString() } };
    req.fmCookies = { fm_csrf: 'k' };
    next();
  });
  accessRoutes(app, { db, layer: { cache: { clear() {} }, reveals: new Map(), mfaRequired: () => false },
    wrap: (fn) => (req, res, next) => fn(req, res, next).catch(next) });
  app.get('/panel.html', (_req, res) => res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
  <link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/access.css"></head>
  <body style="padding:24px;max-width:1180px"><div id="host" class="acx-page"></div>
  <script type="module">document.cookie = 'fm_csrf=k'; import('/accessadmin.js').then((m) => m.targetPanel(document.querySelector('#host'), { owner: true }));</script></body></html>`));
  app.use(express.static(join(root, 'api', 'public')));
  app.use((err, _req, res, _next) => res.status(500).json({ error: 'server', detail: String(err.stack || err).slice(0, 400) }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;

  const page = await browser.newPage({ viewport: { width: 1240, height: 1600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const posted = [];
  page.on('request', (r) => { if (r.method() === 'POST') posted.push({ url: r.url(), body: r.postDataJSON() }); });
  await page.goto(`${base}/panel.html`, { waitUntil: 'load' });
  await page.waitForSelector('.acx-cls tbody tr', { timeout: 20000 });
  await page.waitForTimeout(300);

  const rows = await page.$$eval('.acx-cls tbody tr', (trs) => trs.map((tr) => ({
    name: tr.querySelector('th').textContent.trim(), cells: [...tr.querySelectorAll('td')].map((td) => td.textContent.trim()),
    box: tr.querySelector('input')?.value ?? null })));
  check('a box a class, the largest first, and one for every other car — nine rows',
    rows.length === 9 && rows[0].name === 'BYD Han EV 2025' && rows[1].name === 'Tesla Model Y 2023' && rows[8].name.startsWith('Every other car'),
    JSON.stringify(rows.map((r) => r.name)));
  check('…each with the cars it counts today and what a car of it usually earns a day',
    rows[0].cells[0] === '42' && rows[0].cells[2] === 'AED 520.00' && rows[1].cells[0] === '36' && rows[1].cells[2] === 'AED 380.00',
    JSON.stringify(rows.slice(0, 2)));
  check('the every-other-car row names the two plates with no make or model', /X1, X2/.test(rows[8].name) && rows[8].cells[0] === '2', rows[8].name);
  const flatRate = Number(flat.row.rate).toFixed(2);
  check('every box starts at the figure in force — one figure for every car', rows.every((r) => r.box === flatRate), `${flatRate} ${JSON.stringify(rows.map((r) => r.box))}`);

  /* The Owner's figures: BYD 600, the Highlander 650, the Model Y 2023 box
     emptied (the figure for every other car), every other car 450. */
  const box = (i) => page.locator('.acx-cls tbody tr').nth(i).locator('input');
  await box(0).fill('600');
  await box(6).fill('650');
  await box(1).fill('');
  await box(8).fill('450');
  await page.waitForTimeout(150);
  const said = await page.$eval('#host .acx-target .acx-dim[aria-live], #host [aria-live="polite"]', (p) => p.textContent);
  const m = said.match(/would come to (about )?AED ([\d,]+\.\d\d)/);
  check('the preview says what these figures ask today and what the month comes to — "about" when the days gone are planned afresh',
    !!m && /Over today’s 106 cars these figures ask AED/.test(said) && (sameDay ? m[1] === 'about ' && !/keep the AED/.test(said) : !m[1] && /keep the AED/.test(said)),
    said.slice(0, 300));
  await page.click('[data-acx="target-save"]');
  await page.waitForFunction(() => /Saved from/.test(document.querySelector('.acx-msg')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
  const msg = await page.$eval('.acx-msg', (e) => e.textContent).catch(() => '');
  const body = posted.find((x) => x.url.endsWith('/api/access/target/classes'))?.body;
  check('Save sends each class with a figure and the figure for every other car; the emptied class is left to it',
    body && body.other === 450 && body.rates.length === 7 && !body.rates.some((r) => r.model === 'Model Y' && r.year === 2023)
    && body.rates.find((r) => r.model === 'Han EV').rate === 600, JSON.stringify(body));
  const saidMonth = m ? Number(m[2].replace(/,/g, '')) : NaN;
  const after = await rt.monthTarget(q, { month });
  check('the month the preview said is the month the save reads, to the fils',
    Math.abs(after.summary.month_target - saidMonth) < 0.005 && msg.includes(`AED ${after.summary.month_target.toLocaleString('en-US', { minimumFractionDigits: 2 })}`),
    `${saidMonth} vs ${after.summary.month_target} — ${msg}`);
  /* REVERSION (run 2026-10-29): the preview's days gone always at
     summary.planned, whoever saved them (the first build) -> in the
     same-day scenario this check and the preview's "about" fail: the save
     re-plans those days, the preview kept them. */
  await page.waitForFunction(() => /Daily targets by class from/.test(document.querySelector('.acx-target-hist')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  const hist = await page.$eval('.acx-target-hist', (e) => e.textContent);
  check('the history lists the save first, with every figure and who made it',
    /^Daily targets by class from \d{4}-\d\d-\d\d — BYD Han EV 2025 AED 600\.00;/.test(hist.trim()) && /every other car AED 450\.00/.test(hist)
    && /owner@example\.test/.test(hist), hist.slice(0, 200));
  const reread = await page.$$eval('.acx-cls tbody tr input', (xs) => xs.map((x) => x.value));
  check('…and the boxes now start at the saved figures, the emptied one empty', reread[0] === '600' && reread[1] === '' && reread[8] === '450', JSON.stringify(reread));
  check('no script error on the page', errors.length === 0, errors.join(' | '));
  if (process.env.PANEL_SHOT && !sameDay) await page.locator('#host').screenshot({ path: process.env.PANEL_SHOT });
  await page.close();
  srv.close();
}
await scenario(false);
await scenario(true);
await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
