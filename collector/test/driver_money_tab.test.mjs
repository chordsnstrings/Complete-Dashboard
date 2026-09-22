/* THE MONEY TAB INSIDE A DRIVER'S PROFILE.
   ══════════════════════════════════════════════════════════════════════════
   The operator's sixth requirement, in their words: "All advance repayment
   will be logged into the system in the drivers page preferrably in a new tab
   within the driver profile page - for repayment amount or any disbursement
   they HAVE to upload an image."

   Three claims this tab must not make, each of which it is easy to make.

   1. AN EMPTY TABLE WHERE THERE IS NO RECORD. Most drivers have no ledger
      record and will until somebody records something. A blank table reads as
      a failure and AED 0.00 is a claim — a driver with nothing recorded has
      had no advance this system knows of, which is not the same as one whose
      advances have all been repaid, and somebody can be refused an advance
      over the difference.

   2. SOMEBODY ELSE'S MONEY. Both read routes filter with `$3::bigint IS NULL
      OR person_id = $3`, which treats a null person as NO FILTER. An account
      that resolves to nobody therefore falls through to the WHOLE FLEET —
      every entry in the ledger, summed, under one driver's name on their own
      page. It is the single most dangerous shape on this page and is asserted
      directly.

   3. THAT THE FIGURES ARE WINDOWED. A balance is a POSITION. The shell's
      empty-window banner says "every figure below is measured over those
      dates", which is true on seven tabs and false on this one — a reader who
      believes it concludes the driver owes nothing because they did not work
      in September. driver.js already carries this defect's twin for the Record
      tab, written up at length; this is the assertion that keeps the third
      case honest.

   AND OPENING THIS PAGE MUST NEVER CREATE A LEDGER RECORD. api/ledger_person.js
   mints a person when it cannot find one, which is right at write time and
   catastrophic here: a fleet browsed end to end would mint four hundred people
   who have never had a dirham recorded against them, and every figure on every
   money page would then be counted over a population that looking created. */
import { chromium, devices } from 'playwright';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { app } from '../mockapi.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ══ 1. THE ROUTE: READ-ONLY RESOLUTION, AND NO FALL-THROUGH ═════════════ */
console.log('\nresolving a driver page to a person');
{
  const db = new PGlite();
  await applySchema(db);
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  const { get } = await mountAll(db);

  await q(`INSERT INTO driver (id, full_name) VALUES (1,'Recorded Person'), (2,'Somebody Else')`);
  await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, basis)
           VALUES ('uber','U-KNOWN',1,'human'), ('uber','U-OTHER',2,'human')`);
  const add = (pid, name, type, dir, book, amt) => q(
    `INSERT INTO driver_ledger (person_id, person_name, resolved_from, type_code, direction,
       book, amount, effective_on, entered_by, note)
     VALUES ($1,$2,'human:ahsan',$3,$4,$5,$6,'2026-09-10','ahsan','n')`,
    [pid, name, type, dir, book, amt]);
  await add(1, 'Recorded Person', 'cash_advance', 1, 'advance', 5000);
  await add(2, 'Somebody Else', 'cash_advance', 1, 'advance', 9999);

  const known = (await get('/api/ledger/entries?ext_id=U-KNOWN&platform=uber')).body;
  check('an account maps to its person and to their entries only',
    known.entries.length === 1 && Number(known.entries[0].amount) === 5000,
    JSON.stringify(known.entries.map((e) => e.amount)));
  check('and says which account resolved it, not merely that something did',
    /^account:uber:U-KNOWN$/.test(known.resolved_from || ''), known.resolved_from);

  /* THE ASSERTION THIS FILE EXISTS FOR. */
  const nobody = (await get('/api/ledger/entries?ext_id=U-NOBODY&platform=uber')).body;
  check('an account nobody has recorded against returns NOTHING, not everything',
    nobody.entries.length === 0, `${nobody.entries.length} entries: `
      + JSON.stringify(nobody.entries.map((e) => e.person_name)));
  check('and its totals are null rather than the fleet\'s',
    nobody.totals.advance === null && nobody.totals.rows === 0, JSON.stringify(nobody.totals));
  check('with a reason that distinguishes "no record" from "could not read"',
    /A record is created by the first entry/.test(nobody.absent_reason || ''),
    nobody.absent_reason);

  const exNobody = (await get('/api/ledger/exposure?ext_id=U-NOBODY')).body;
  check('exposure does the same rather than answering for the whole fleet',
    exNobody.people.length === 0 && exNobody.summary.people === 0,
    JSON.stringify(exNobody.summary));
  const exKnown = (await get('/api/ledger/exposure?ext_id=U-KNOWN')).body;
  check('and answers for exactly one person when the account resolves',
    exKnown.people.length === 1 && exKnown.people[0].name === 'Recorded Person',
    JSON.stringify(exKnown.people.map((p) => p.name)));

  /* READING NEVER WRITES. */
  const before = (await q(`SELECT count(*)::int n FROM driver`))[0].n;
  await get('/api/ledger/exposure?ext_id=U-NEVER-SEEN&platform=bolt');
  await get('/api/ledger/entries?ext_id=U-NEVER-SEEN&platform=bolt');
  check('opening the page of a driver with no record MINTS NOBODY',
    (await q(`SELECT count(*)::int n FROM driver`))[0].n === before,
    `${(await q(`SELECT count(*)::int n FROM driver`))[0].n} vs ${before}`);
  check('and maps no account either',
    (await q(`SELECT count(*)::int n FROM driver_platform_id
               WHERE external_id='U-NEVER-SEEN'`))[0].n === 0);
}

/* ══ 2. THE TAB ══════════════════════════════════════════════════════════ */
const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

console.log('\na driver who has a record');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/#driver/U-TARIQ/money`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-panel="driver-money-register"] table', { timeout: 20000 });
  const body = await page.evaluate(() => document.body.innerText);

  check('the tab is reachable as its own address, not a modal',
    /#driver\/U-TARIQ\/money$/.test(page.url()), page.url());
  /* SCOPED TO THE DRIVER'S OWN TAB BAR. `.tabs a.on` also matches the shell's
     main rail, whose active item is "Drivers" — an assertion that reads the
     first match in the document is asserting about the wrong control. */
  const tabs = await page.$$eval('.tabs a', (as) => as.map(
    (a) => ({ t: a.textContent.trim(), on: a.classList.contains('on'), h: a.getAttribute('href') })));
  const money = tabs.find((t) => /#driver\/U-TARIQ\/money(\?|$)/.test(t.h || ''));
  check('Money is in the driver\'s tab bar and marked as the one open',
    money && money.on && /Money/.test(money.t), JSON.stringify(tabs.map((t) => t.t)));
  check('and it is a real route, so it can be linked and reloaded',
    /#driver\/U-TARIQ\/money/.test(money?.h || ''), money?.h);
  /* THE WINDOW GOVERNS THE REGISTER AND NOT THE BALANCES, and the page has to
     be readable on that point or the two halves look like a contradiction:
     an empty list under a tile reading AED 3,500. */
  check('the register heading names the window it is over',
    /Statement for /.test(await page.$eval('[data-panel="driver-money-register"]',
      (e) => e.innerText)),
    (await page.$eval('[data-panel="driver-money-register"]', (e) => e.innerText)).slice(0, 80));

  const stand = await page.$eval('[data-panel="driver-money"]', (e) => e.innerText);
  check('what they owe is the headline', /OWED IN TOTAL/i.test(stand), stand.slice(0, 200));
  check('with the advance balance beside it', /ADVANCES OUTSTANDING/i.test(stand));
  check('and where they sit against the line', /AGAINST THE LINE/i.test(stand));
  check('and the balance tile says it is a position rather than a total over those dates',
    /as it stands now, not over the window/.test(stand), stand.slice(0, 400));
  check('the cash term is shown as its PARTS, not as a total to be trusted',
    /counted on 2026-01-01, plus/.test(stand) && /less .* handed in over/.test(stand),
    stand.slice(0, 600));

  /* ONE PERSON'S ENTRIES, NOT THE FLEET'S. */
  const names = await page.$$eval('[data-panel="driver-money-register"] tbody tr',
    (rows) => rows.map((r) => r.textContent));
  /* THE CLAIM IS "NOBODY ELSE'S", NOT "EXACTLY TWO". The first version
     asserted a row count, which is a fact about the fixture rather than about
     the page — adding a charging advance to the mock turned it red while the
     page was still perfectly correct. What must hold is that no row belongs to
     another person, and that every row belongs to this one. */
  check('the register carries only this driver\'s entries, and nobody else\'s',
    names.length > 0 && !names.some((t) => /Selim|Siyad|Nadia|Rashid/.test(t)),
    `${names.length}: ${JSON.stringify(names.map((t) => t.slice(0, 40)))}`);
  check('and every one of them is an entry, not an empty row',
    names.every((t) => /AED/.test(t)), JSON.stringify(names.map((t) => t.slice(0, 30))));
  check('a repayment reads as money coming back, by its sign',
    /-1,000\.00|−1,000\.00/.test(names.join(' ')), names.join(' ').slice(0, 200));

  /* THREE PROOF STATES. */
  /* BY HEADER, NOT BY INDEX. This read `td[3]` and broke silently the moment
     the register grew a Fare and a Cash-in column in front of it — returning
     six perfectly valid cells that simply were not the proof column, and
     failing with a message that looked like a receipt bug. A column position
     is not a stable identifier for a table this page is still growing. */
  const proof = await page.$$eval('[data-panel="driver-money-register"] table',
    (tbls) => {
      const tbl = tbls[0];
      const heads = [...tbl.querySelectorAll('thead th')].map((h) => h.textContent.trim());
      const i = heads.findIndex((h) => /proof/i.test(h));
      return [...tbl.querySelectorAll('tbody tr')].map((r) => {
        const c = [...r.querySelectorAll('td')][i];
        return { link: !!c?.querySelector('a'),
          title: c?.querySelector('.dash')?.getAttribute('title') || null };
      });
    });
  check('a held receipt is a link to the photograph', proof.some((p) => p.link),
    JSON.stringify(proof));
  /* AND THE CORRECTED WORDING. "Removed" was never true — nothing in this
     system deletes a receipt — so an expired one now says it was held until a
     date and is no longer served, and a digest with no bytes says it was never
     saved. See docs/COVERAGE.md. */
  check('and an expired one says it was held until a date and is no longer served',
    proof.some((p) => /held until .* no longer serves it/s.test(p.title || '')),
    JSON.stringify(proof.map((p) => p.title)));
  check('the page says entries are never edited, and what a correction is instead',
    /a correction is a reversing entry/.test(body), body.slice(-400));

  const doc = await page.evaluate(() => document.documentElement.scrollWidth);
  check('the page does not slide sideways', doc <= 1280, String(doc));
  await ctx.close();
}

console.log('\na driver who has no record — which is most of them');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/#driver/U-NOBODY/money`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-panel="driver-money"] .note', { timeout: 20000 });
  const body = await page.evaluate(() => document.body.innerText);

  check('the page says nothing has been recorded, in plain English',
    /nothing has ever been recorded against this driver/i.test(body), body.slice(0, 600));
  check('and says explicitly that this is not a balance of zero',
    /not a balance of zero/.test(body), body.slice(0, 900));
  check('naming the difference it makes — repaid is not the same as never lent',
    /all been repaid/.test(body), body.slice(0, 900));
  check('no figure is printed for them at all',
    !(await page.$('[data-panel="driver-money"] .kpis')),
    'a KPI row was rendered for a driver with no record');

  /* AND THE STATEMENT STILL RENDERS. This is the case the whole panel exists
     for and it had no test, which is how it shipped broken: the page took an
     early `return` on an empty LEDGER, and a statement is mostly TRIPS.
     Measured on production 2026-09-22 — person 202 has zero ledger rows and
     241 statement lines (134 trips, 107 commissions, AED 11,461.61 of fares)
     and the page showed them none of it, saying "Nothing was recorded against
     this driver", which is true of the ledger and false of the page. Every
     browser test passed, because this fixture gated the register on having a
     ledger record, exactly as the page did. Both are fixed. */
  await page.waitForSelector('[data-panel="driver-money-register"] table', { timeout: 20000 })
    .catch(() => null);
  const stTable = await page.$('[data-panel="driver-money-register"] table');
  check('a driver with NO ledger record still gets their statement',
    !!stTable, 'the statement was swallowed by the empty-ledger branch');
  const stRows = stTable
    ? await page.$$eval('[data-panel="driver-money-register"] tbody tr', (r) => r.length) : 0;
  check('with their trips in it, not an empty table', stRows > 0, `${stRows} rows`);
  check('and the panel says the register carries work and no recorded money',
    /carries their work and no recorded money/.test(
      await page.$eval('[data-panel="driver-money-register"]', (e) => e.innerText)),
    (await page.$eval('[data-panel="driver-money-register"]', (e) => e.innerText)).slice(0, 200));
  check('both running balances read absent, never zero',
    !/AED 0\.00/.test(await page.$eval('[data-panel="driver-money-register"]',
      (e) => e.innerText)),
    'a balance printed as AED 0.00 for a driver whose position nobody has counted');
  /* THIS ASSERTION USED TO READ "no register table is drawn to look like an
     empty one", and it was right while the panel listed only ledger entries:
     an empty table then meant nothing to show. It is wrong now. The panel is a
     STATEMENT, its rows are mostly trips, and a driver with no ledger record
     has plenty to show — so the table must be drawn, and what must NOT be
     drawn is a ledger figure for somebody who has no ledger. */
  const regTxt = await page.$eval('[data-panel="driver-money-register"]', (e) => e.innerText);
  check('and no ledger BOOK total is printed for a driver with no ledger',
    !/Advances AED|Deductions AED|Pay AED/.test(regTxt), regTxt.slice(0, 220));
  await ctx.close();
}

/* ══ 3. THE BANNER MUST NOT CALL A POSITION A MEASUREMENT ════════════════ */
console.log('\nthe empty-window banner');
{
  const src = readFileSync(new URL('../api/public/driver.js', import.meta.url), 'utf8');
  check('the Money tab gets its own closing sentence, not the windowed one',
    /tab === 'money'/.test(src), 'no money branch in emptyWindowNote');
  check('and that sentence says a balance is a position rather than a span',
    /What somebody owes is \s*'?\s*\+?\s*'?a POSITION/.test(src.replace(/\s+/g, ' '))
    || /a POSITION and not a figure over a span/.test(src.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ')),
    'the money branch does not say a balance is a position');
  check('while still crediting the window with the one thing it does govern',
    /Only the register of entries below is measured over those dates/.test(src));
  /* The specific wrong reading it exists to prevent, named. */
  check('naming what a reader would otherwise conclude',
    /an advance taken in June is still/.test(src));
}

await browser.close();
srv.close();
console.log(`\n${fail ? '✗' : '✓'} driver_money_tab: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
