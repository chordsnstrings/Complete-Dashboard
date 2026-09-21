/* THE ADVANCES REGISTER AND THE SALARY GRID.
   ══════════════════════════════════════════════════════════════════════════
   Two screens with one form between them, and two claims each must not make.

   ADVANCES. The page exists for a decision — whether to lend somebody more —
   so the people it CANNOT measure come first, by name, with the reason. A
   screen that sorted dashes to the bottom would look complete while the
   drivers most likely to be over the line were the ones nobody scrolled to.
   Measured on production 2026-09-21: unremitted is a daily figure and nothing
   records a remittance, so cash in hand cannot be derived, and the policy
   counts cash inside the line — an exposure without it understates, which is
   the direction that gets somebody lent more than they should be.

   SALARY. One entry per driver per month across a hundred and twenty people is
   a hundred and twenty forms, so it is a grid. What it must not do is imply a
   calculation: the operator records what payroll decided and this system does
   not derive it, so revenue appears as context and is never multiplied by
   anything — sql/schema_v77.sql stores a pay basis with NO RATE for the same
   reason.

   AND THE PROOF COLUMN HAS THREE STATES, not two. A receipt still held, one
   held until a date and since removed, and a type that never has one because
   it records a decision or a period figure. Collapsing those makes an expired
   photograph read as an entry nobody ever documented. */
import { chromium, devices } from 'playwright';
import { readFileSync } from 'node:fs';
import { app } from '../mockapi.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

/* ══ 1. NOTHING IN THE SALARY SCREEN MULTIPLIES ══════════════════════════ */
console.log('\nsalary is recorded, never calculated');
{
  const src = readFileSync(new URL('../api/public/salary.js', import.meta.url), 'utf8');
  /* A rate anywhere here is the beginning of a derived wage. The only figures
     the grid may put on screen are ones somebody typed or payroll recorded. */
  check('the salary grid holds no rate, percentage or multiplier',
    !/\brate\b|\bpct\b|\bpercent|\*\s*0\.\d/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
  check('and it says in the file that it records rather than derives',
    /RECORDED, NEVER CALCULATED/.test(src));
  const adv = readFileSync(new URL('../api/public/advances.js', import.meta.url), 'utf8');
  /* An ASSIGNMENT to exposure_pct, not a comparison: `p.exposure_pct == null`
     is how the page tells a missing figure from a low one and must stay. What
     must never appear is the page deriving the number itself — both halves of
     that ratio fold on one key server-side (api/ledger_routes.js), and a
     second computation here could disagree with it. */
  check('the advances page reads the exposure and never assigns one',
    !/exposure_pct\s*=[^=]/.test(adv) && /exposure_pct/.test(adv));
  check('nor does it divide anything',
    !/\/\s*(p\.earned|earned)/.test(adv));
}

/* ══ 2. THE ADVANCES REGISTER ════════════════════════════════════════════ */
console.log('\nthe advances register');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/#advances`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-panel="advance-register"] table', { timeout: 15000 });

  const body = await page.evaluate(() => document.body.innerText);
  check('the policy is stated with the date it took effect',
    /35% of what a driver generates, in force since 2026-01-01/.test(body), body.slice(0, 200));
  check('and that over it nothing is blocked', /nothing is blocked/i.test(body));

  /* The unmeasurable, first and by name. */
  const firstRow = await page.$eval('[data-panel="advances"] tbody tr b',
    (e) => e.textContent);
  check('the person whose exposure cannot be measured sorts FIRST, not last',
    /Siyad/.test(firstRow), firstRow);
  check('and the page says how many of how many that is',
    /1 of 3 people have no exposure figure/.test(body), body.slice(0, 400));
  check('naming the direction the error would run in',
    /understate exposure/.test(body));

  /* Three proof states in one column. */
  const proofs = await page.$$eval('[data-panel="advance-register"] tbody tr', (rows) =>
    rows.map((r) => {
      const cells = [...r.querySelectorAll('td')];
      const c = cells[4];
      return { link: !!c?.querySelector('a'), title: c?.querySelector('.dash')?.getAttribute('title') || null };
    }));
  check('a held receipt is a link to the photograph',
    proofs.some((p) => p.link), JSON.stringify(proofs));
  check('an expired one says it was held and has since gone',
    proofs.some((p) => /passed its twelve-month retention/.test(p.title || '')),
    JSON.stringify(proofs.map((p) => p.title)));
  check('and a type that never has one says THAT instead',
    proofs.some((p) => /records a decision or a period figure/.test(p.title || '')),
    JSON.stringify(proofs.map((p) => p.title)));

  const doc = await page.evaluate(() => document.documentElement.scrollWidth);
  check('the page does not slide sideways', doc <= 1280, String(doc));
  await ctx.close();
}

/* ══ 3. THE SALARY GRID ══════════════════════════════════════════════════ */
console.log('\nthe salary grid');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/#salary`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.salcell', { timeout: 15000 });

  const cells = await page.$$('.salcell');
  check('every driver gets a cell in the column', cells.length === 3, String(cells.length));
  const h = await page.$eval('.salcell', (e) => Math.round(e.getBoundingClientRect().height));
  check('and each is a touch target', h >= 44, String(h));

  /* Nothing may be written before the whole month has been checked. */
  check('the save starts disabled',
    await page.$eval('[data-panel="salary"] .primary', (e) => e.disabled));
  await page.click('[data-panel="salary"] .depactions .btn');
  await page.waitForSelector('[data-panel="salary"] .depverdict .note', { timeout: 5000 });
  check('checking with nobody named asks for the supervisor first',
    /Say who is recording this/.test(
      await page.$eval('[data-panel="salary"] .depverdict', (e) => e.textContent)));

  await page.click('[data-panel="salary"] .depchip');
  await page.click('[data-panel="salary"] .depactions .btn');
  await page.waitForSelector('[data-panel="salary"] .depverdict .note', { timeout: 5000 });
  check('and with nobody paid, says no amounts were entered',
    /No amounts have been entered/.test(
      await page.$eval('[data-panel="salary"] .depverdict', (e) => e.textContent)));

  await cells[0].fill('3500');
  await cells[1].fill('4200');
  await page.click('[data-panel="salary"] .depactions .btn');
  await page.waitForSelector('[data-panel="salary"] .depsentence', { timeout: 8000 });
  const said = await page.$eval('[data-panel="salary"] .depsentence', (e) => e.textContent);
  check('a checked month reports how many rows and the total',
    /2 of 2 rows would be recorded/.test(said) && /AED 7,700\.00/.test(said), said);
  check('and says plainly that nothing has been written',
    /Nothing has been written/.test(said), said);
  check('only then is the save enabled',
    !(await page.$eval('[data-panel="salary"] .primary', (e) => e.disabled)));

  await ctx.close();
}

/* ══ 4. BOTH PAGES ON A PHONE ════════════════════════════════════════════ */
console.log('\nboth pages on a real phone');
for (const view of ['advances', 'salary']) {
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await page.goto(`${base}/#${view}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const doc = await page.evaluate(() => document.documentElement.scrollWidth);
  check(`#${view} does not slide sideways on a phone`, doc <= 390, String(doc));
  const body = await page.evaluate(() => document.body.innerText);
  /* These two are desktop tabs reached through the phone shell's fallback,
     which renders the REAL module rather than a stub — so they must not be
     empty, and must not be the "bigger screen" card either. */
  check(`#${view} renders something a person can read`, body.trim().length > 60,
    body.slice(0, 80));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n${fail ? '✗' : '✓'} ledger_ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
