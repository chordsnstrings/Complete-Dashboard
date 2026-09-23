/* ── the banner after a Settings save, drawn in a real browser ──────────────
   On 2026-09-23 a working Egari Uber cookie was saved and the banner went on
   showing it stopped, because the only verdict on record was about the cookie
   it replaced. A save now tests what it stored (api/save_check.js). What the
   page must then do is:

     - draw what cannot be settled at save time ('pending': saved and not yet
       tested) quietly, never red or amber;
     - keep a real stop red when both are present, pending listed after it;
     - redraw the banner the moment the paste box's Apply finishes, because
       nothing else on the Settings page re-reads it.

   /api/auth and the paste route are answered by the test, so what is drawn
   is exactly what the test sent. */
import { readFileSync } from 'node:fs';
import { app } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();

/* 12:30 in Dubai, TODAY in Dubai. This was the literal 2026-09-23T08:30Z,
   and the page prints a bare "saved 12:30" only for a save made on the
   reader's own Dubai day (savedWhen), so from 00:00 Dubai on 24 September
   the check below failed on a correct page — found by the full run of the
   reskin's STEP 4, twenty minutes after midnight in Dubai. The earlier-day
   case further down keeps its fixed date on purpose. */
const DUBAI_TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric',
  month: '2-digit', day: '2-digit' }).format(new Date());
const SAVED_AT = `${DUBAI_TODAY}T08:30:22.622Z`;     // 12:30 in Dubai (UTC+4, no DST)
const row = (o) => ({ fleet_id: 'egari', surface: 'x', last_ok_at: null, checked_at: SAVED_AT,
  last_ok_age_h: null, run_age_h: 0.2, stall_limit_h: 6, still_collecting: true,
  saved_at: null, superseded: false, ...o });
const PENDING = row({ provider: 'fms', credential: 'FMS_PASSWORD', state: 'saved', severity: 'pending',
  saved_at: SAVED_AT,
  detail: 'saved, not tested — no live check exists for FMS_PASSWORD; each surface tests it the next '
    + 'time it runs' });
const PENDING_2 = { ...PENDING, fleet_id: 'ecosine' };
const STOPPED = row({ provider: 'uber', credential: 'UBER_WEB_COOKIE_EGARI', state: 'invalid',
  severity: 'stopped', last_ok_age_h: 1.2,
  detail: 'refused when saved — the session is no longer signed in' });
const body = (rows) => JSON.stringify({ rows, observed: true,
  stopped: rows.filter((r) => r.severity === 'stopped').length,
  at_risk: 0, degraded: 0, pending: rows.filter((r) => r.severity === 'pending').length });

const banner = (page) => page.$eval('#authBanner', (e) => ({
  cls: e.className, head: e.querySelector('.ab-head')?.textContent || '',
  items: [...e.querySelectorAll('li')].map((li) => li.textContent),
  bg: getComputedStyle(e).backgroundColor, html: e.innerHTML,
}));

/* ══ 1. saved and untested, alone ═══════════════════════════════════════ */
console.log('\nsaved and not yet tested, on its own');
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let answer = body([PENDING, PENDING_2]);
  await page.route('**/api/auth**', (r) => r.fulfill({ contentType: 'application/json', body: answer }));
  await page.goto(`${base}/#overview`, { waitUntil: 'networkidle' });
  /* Not thrown on: a banner that never appears is a failed check with its
     reason, not a stack trace that hides the other checks. */
  await page.waitForSelector('#authBanner.pending', { timeout: 15000 }).catch(() => {});
  const b = await banner(page);
  check('the banner is drawn in the quiet tone', /\bpending\b/.test(b.cls) && !/stopped|at-risk/.test(b.cls), b.cls);
  check('…counting the credential once, not once per surface',
    /^1 saved credential has not been tested yet/.test(b.head), b.head);
  check('…saying when it was saved, in Dubai time',
    b.items.every((t) => /saved 12:30/.test(t)), b.items.join(' | '));
  check('…and not "last worked", which would be about the value it replaced',
    b.items.every((t) => !/last worked|never authenticated/.test(t)), b.items.join(' | '));
  check('…with the recorded words', b.items.every((t) => /no live check exists for FMS_PASSWORD/.test(t)));
  check('…and a head that promises no particular run', /each surface tests it the next time it runs$/.test(b.head),
    b.head);
  const stopBg = await page.evaluate(() => {
    const d = document.createElement('div'); d.className = 'authbanner stopped';
    document.body.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c;
  });
  check('…on a ground that is not the stopped one', b.bg !== stopBg, `${b.bg} vs ${stopBg}`);

  /* Saved on an earlier day: a bare "12:30" under a line that has sat there
     since then reads as this afternoon. */
  answer = body([{ ...PENDING, saved_at: '2026-09-20T08:30:22Z' }]);
  await page.goto(`${base}/#vehicles`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => /saved 20 Sep 12:30/.test(document.querySelector('#authBanner')?.textContent || ''),
    null, { timeout: 15000 }).catch(() => {});
  check('a save from an earlier day carries its date', /saved 20 Sep 12:30/.test((await banner(page)).items[0] || ''),
    (await banner(page)).items[0]);

  /* Nothing to say, nothing drawn. A different view, so the page renders. */
  answer = body([]);
  await page.goto(`${base}/#drivers`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#authBanner')?.innerHTML === '', null, { timeout: 15000 })
    .catch(() => {});
  check('with nothing pending or wrong, the banner is empty', (await banner(page)).html === '');
  await page.close();
}

/* ══ 2. beside a real stop ══════════════════════════════════════════════ */
console.log('\nbeside a credential that really is refused');
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/api/auth**', (r) => r.fulfill({ contentType: 'application/json',
    body: body([PENDING, STOPPED]) }));
  await page.goto(`${base}/#overview`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#authBanner.stopped', { timeout: 15000 });
  const b = await banner(page);
  check('the banner stays red for the refusal', /\bstopped\b/.test(b.cls), b.cls);
  check('…leads with the refusal, not the pending one', /stopped working/.test(b.head), b.head);
  check('…lists the refused credential first and the pending one after it',
    b.items.length === 2 && /UBER_WEB_COOKIE_EGARI/.test(b.items[0]) && /FMS_PASSWORD/.test(b.items[1]),
    b.items.join(' | '));
  check('…and the refusal says it was refused when saved', /refused when saved/.test(b.items[0]));
  await page.close();
}

/* ══ 3. Apply redraws it ════════════════════════════════════════════════ */
console.log('\nthe paste box’s Apply redraws the banner');
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let applied = false;
  let authReads = 0;
  await page.route('**/api/auth**', (r) => {
    authReads++;
    r.fulfill({ contentType: 'application/json', body: body(applied ? [] : [STOPPED]) });
  });
  const proposal = { provider: 'Uber', key: 'UBER_WEB_COOKIE_EGARI', fleet: 'egari', verdict: 'pass',
    detail: 'the supplier API accepted this session (a stub)', source: 'recognised', applied: false };
  await page.route('**/api/settings/paste**', async (r) => {
    const sent = JSON.parse(r.request().postData() || '{}');
    applied = sent.apply === true;
    r.fulfill({ contentType: 'application/json', body: JSON.stringify({
      ok: true, dry_run: !applied, unread: 0, findings: [], files: [], files_refused: [],
      applied: applied ? ['UBER_WEB_COOKIE_EGARI'] : [],
      checked: applied ? [{ key: 'UBER_WEB_COOKIE_EGARI', fleet: 'egari', verdict: 'pass', rows: 3 }] : [],
      proposals: [{ ...proposal, applied }],
    }) });
  });
  await page.goto(`${base}/#settings`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#authBanner.stopped', { timeout: 15000 });
  check('before the save the banner is red', /\bstopped\b/.test((await banner(page)).cls));

  await page.fill('textarea', 'a pasted request that is at least twenty characters long');
  await page.getByRole('button', { name: 'Read and test' }).click();
  const apply = page.getByRole('button', { name: /Apply the 1 the provider accepted/ });
  await apply.waitFor({ timeout: 10000 });
  const readsBefore = authReads;
  await apply.click();
  await page.waitForFunction(() => document.querySelector('#authBanner')?.innerHTML === '', null, { timeout: 10000 })
    .catch(() => {});
  check('after Apply the banner is re-read', authReads > readsBefore, `${readsBefore} → ${authReads}`);
  check('…and the red row the save fixed is gone, without leaving the page',
    (await banner(page)).html === '', (await banner(page)).head);
  check('…and the note says the banner now shows the save’s verdicts',
    /banner above now shows what each provider said/.test(await page.textContent('#view')));
  await page.close();
}

/* The paste box redraws through the same function every page uses, so the
   wording and the tone above are the ones a reader sees everywhere. */
{
  const js = readFileSync(new URL('../api/public/app.js', import.meta.url), 'utf8');
  const applyBranch = js.slice(js.indexOf('if (d.applied?.length) {'), js.indexOf('} else if (good.length) {'));
  check('the Apply branch calls the shared banner, not a copy of it', /\bauthBanner\(\);/.test(applyBranch));
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
