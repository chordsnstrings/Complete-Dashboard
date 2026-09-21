/* THE LENDING LINE, ON SCREEN.
   ══════════════════════════════════════════════════════════════════════════
   The operator asked for a figure management can change, "not hardcoded, kept
   as a variable in settings". A settings field holding one number would be a
   worse version of hardcoding it: the figure would be current and the reasons
   would be nowhere.

   So what this page owes a reader is the SEQUENCE. The question somebody
   actually arrives with is "why was this driver told they were over the line
   in March", and the answer is March's row — which only exists if the table is
   append-only and the page shows it.

   THREE STANDINGS, NOT TWO. A row can be in force, superseded, or filed ahead
   of its start date. "The newest row" and "the row in force" are different the
   moment a planned change is recorded, which is the normal way one is, and a
   page that conflates them tells a reader the line is 20% when it is 30%.

   AND THE CONSEQUENCE COMES BEFORE THE CHANGE. The preview is a real
   transaction rolled back server-side and it returns who the proposed line
   moves. Moving a lending threshold without seeing who it moves is the
   decision this page exists to stop somebody making blind. */
import { chromium, devices } from 'playwright';
import { readFileSync } from 'node:fs';
import { app } from '../mockapi.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

/* ══ THE PAGE ════════════════════════════════════════════════════════════ */
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/#policy`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-panel="policy-history"] table', { timeout: 15000 });
  const body = await page.evaluate(() => document.body.innerText);

  /* SCOPED TO THE HEADLINE PANEL, not to the document. The first version of
     this asserted `!/^20%/m` over document.body.innerText and failed against a
     correct page: the future-dated 20% row appears at the start of a line in
     the history table below, which is exactly where it SHOULD appear. An
     assertion about what the headline says has to read the headline. */
  const headline = await page.$eval('[data-panel="policy"]', (e) => e.innerText);
  check('the line in force is the headline, and it is the one in force',
    /\b30%/.test(headline) && !/\b20%/.test(headline), headline.slice(0, 300));
  check('with the date it started and who set it',
    /2026-06-01/.test(headline) && /Management/.test(headline), headline.slice(0, 300));
  check('and how many lines there have been, so the history is visibly a history',
    /\b3\b/.test(headline) && /append-only/.test(headline), headline.slice(0, 300));
  check('and the reason it moved, which is the whole point of storing it',
    /tightened after the June review/.test(body));

  /* THREE STANDINGS. */
  const standings = await page.$$eval('[data-panel="policy-history"] tbody tr',
    (rows) => rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent.trim())));
  check('every line this fleet has had is listed, not only the current one',
    standings.length === 3, JSON.stringify(standings));
  check('the one in force is marked as such',
    standings.some((r) => r.some((c) => /in force/.test(c))), JSON.stringify(standings));
  check('a line filed ahead of its start date says STARTS LATER, not "in force"',
    standings.some((r) => r.some((c) => /starts later/.test(c))), JSON.stringify(standings));
  check('and a replaced one says superseded rather than simply looking old',
    standings.some((r) => r.some((c) => /superseded/.test(c))), JSON.stringify(standings));
  check('the future-dated row is NOT the one marked in force',
    !standings.find((r) => r.some((c) => /2099/.test(c)))?.some((c) => /in force/.test(c)),
    JSON.stringify(standings));

  /* BOTH DATES. "From" is when it applies; "Recorded" is when somebody typed
     it. Showing only one makes a legitimate backdate indistinguishable from a
     falsified one. */
  check('both the applying date and the typing date are on the row',
    /2026-01-01/.test(body) && standings.some((r) => r.some((c) => /2026-06-01/.test(c))),
    JSON.stringify(standings));

  check('the page says in words that it authenticates nobody',
    /not authentication/.test(body), body.slice(-400));

  /* ══ THE PREVIEW SHOWS THE CONSEQUENCE ═════════════════════════════════ */
  check('the save starts disabled — nothing is set before it has been checked',
    await page.$eval('[data-panel="policy-form"] .btn.primary', (b) => b.disabled));

  const inputs = await page.$$('[data-panel="policy-form"] .depinput');
  await inputs[0].fill('25');
  await inputs[1].fill('2026-10-01');
  await inputs[2].fill('Operational Head');
  await inputs[3].fill('tightening ahead of Q4');
  await page.click('[data-panel="policy-form"] .btn:not(.primary)');
  await page.waitForSelector('[data-panel="policy-form"] .depsentence', { timeout: 15000 });

  const verdict = await page.$eval('[data-panel="policy-form"] .depverdict', (e) => e.innerText);
  check('checking it says what WOULD happen, in the conditional',
    /Would set the line to 25%/.test(verdict), verdict);
  check('and names the line it replaces rather than only the new one',
    /was 30%/.test(verdict), verdict);
  check('it says how many people the proposed line moves across it',
    /Of 2 people whose exposure can be measured/.test(verdict), verdict);
  check('and how many it cannot judge at all, separately',
    /1 people have no exposure figure at all/.test(verdict)
    || /no exposure figure at all/.test(verdict), verdict);
  check('nothing is written by a check, and the page says so',
    /Nothing was written/.test(verdict), verdict);
  check('only then is the save enabled',
    !(await page.$eval('[data-panel="policy-form"] .btn.primary', (b) => b.disabled))); 

  const doc = await page.evaluate(() => document.documentElement.scrollWidth);
  check('the page does not slide sideways', doc <= 1280, String(doc));
  await ctx.close();
}

/* ══ AND THE PAGE NEVER INVENTS A LINE ═══════════════════════════════════ */
{
  /* A figure the product made up for itself is one nobody can be held to. */
  const src = readFileSync(new URL('../api/public/policy.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  /* A FIGURE THE PRODUCT INVENTED IS ONE NOBODY CAN BE HELD TO. The first
     version of this page put placeholder = '35' on the field, which on a fleet
     that has never stored a line renders a greyed 35 where the line in force
     belongs — the house rule this dashboard exists to uphold, broken in the
     one place it is about. The placeholder now comes from the policy on file
     or is left blank. */
  check('no percentage is compiled into the page at all, outside the comments',
    !/\d+\s*%/.test(code) && !/placeholder\s*=\s*'\d/.test(code)
    && !/pct\s*\|\|\s*\d/.test(code),
    (code.match(/.*\d+\s*%.*|.*placeholder\s*=\s*'\d.*/g) || []).join(' | ').slice(0, 200));
  check('and the only percentage it can show comes from the server',
    /current\.pct/.test(code), 'nothing reads the served figure');
  check('and with nothing stored it renders the absent reason, not a number',
    /absent_reason/.test(code));
}

/* ══ ON A PHONE ══════════════════════════════════════════════════════════ */
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await page.goto(`${base}/#policy`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const doc = await page.evaluate(() => document.documentElement.scrollWidth);
  const vw = await page.evaluate(() => window.innerWidth);
  check('#policy does not slide sideways on a phone', doc <= vw + 1, `${doc} vs ${vw}`);
  const text = await page.evaluate(() => document.body.innerText);
  check('#policy renders something a person can read on a phone',
    text.trim().length > 60, text.slice(0, 120));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n${fail ? '✗' : '✓'} policy_ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
