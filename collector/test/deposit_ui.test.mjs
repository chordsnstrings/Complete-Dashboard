/* CASH HANDED IN, ON BOTH SHELLS — and they are two apps, not one.
   ═══════════════════════════════════════════════════════════════════════════
   The operator: "deposit should be able to be done from phone and desktop so
   optimize both." Those are genuinely different screens of one event: finance
   works through a pile of receipts at a desk, a supervisor takes notes from a
   driver at the car. So there are two presentations and ONE set of rules, in
   api/public/deposit_core.js — because a validation copied into two bundles is
   how the phone comes to refuse what the desktop accepts, and the person
   standing next to the car is the one who finds out.

   ── THE TRAP THIS FILE EXISTS TO NOT FALL INTO AGAIN ─────────────────────
   api/public/index.html picks the phone bundle on `max-width:760px` AND
   `pointer:coarse`. A Playwright page with a viewport and no hasTouch fails
   the second half and loads the DESKTOP bundle — an afternoon of responsive
   work was once measured against an app no phone loads. §3 uses
   devices['iPhone 13'] and asserts documentElement.dataset.ui before it
   asserts anything else.

   ── AND A FORM IS A NEW KIND OF THING HERE ───────────────────────────────
   Nothing in the phone bundle had an input before this. The assertions are
   therefore about TOUCH TARGETS and OVERFLOW as much as about behaviour: 44px
   is the floor below which a person recording a handover in a car park misses
   and re-taps, and a mis-tap on a money form costs more than on any other. */
import { chromium, devices } from 'playwright';
import { readFileSync } from 'node:fs';
import { app } from '../mockapi.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ══ 1. ONE SET OF RULES, NOT TWO ═════════════════════════════════════════ */
console.log('\nthe two shells share their rules');
{
  const core = readFileSync(new URL('../api/public/deposit_core.js', import.meta.url), 'utf8');
  const form = readFileSync(new URL('../api/public/entry_form.js', import.meta.url), 'utf8');
  const phone = readFileSync(new URL('../api/public/m/screens.js', import.meta.url), 'utf8');
  const views = ['deposits.js', 'advances.js'].map((f) =>
    [f, readFileSync(new URL(`../api/public/${f}`, import.meta.url), 'utf8')]);

  /* THE INVARIANT: every rule about recording money lives in deposit_core.js.
     The desktop and phone have different LAYOUTS on purpose — a worklist with a
     form beside it, against one handover thumb-first — and identical RULES,
     because a validation copied into two bundles is how the phone comes to
     refuse what the desktop accepts. */
  for (const fn of ['compress', 'putReceipt', 'submitEntry', 'parseAmount']) {
    check(`${fn} is defined once, in the core`,
      new RegExp(`export (async function|function|const) ${fn}\\b`).test(core));
  }
  check('the desktop form takes its rules from the core',
    /from '\.\/deposit_core\.js'/.test(form));
  check('and so does the phone screen',
    /from '\.\.\/deposit_core\.js'/.test(phone));

  /* The two desktop VIEWS are layout. They must not talk to the API directly
     or they become a third place a rule can differ. */
  for (const [name, src] of views) {
    check(`${name} delegates the form rather than carrying one`,
      /entryForm\(/.test(src) && !/fetch\(/.test(src), name);
  }

  /* The confirming sentence comes from the SERVER — assembled there so the two
     shells cannot describe one entry differently. "book moves from" is its
     distinctive phrase; matching "is recording" alone was too loose, because
     both shells legitimately say "Say who is recording this", which is a
     missing-field message and not a confirmation. */
  check('nothing in the client composes its own confirmation sentence',
    !/book moves from/.test(form) && !/book moves from/.test(phone)
    && views.every(([, src]) => !/book moves from/.test(src)));
  check('both shells quote the server\'s sentence instead',
    /out\.sentence/.test(form) && /out\.sentence/.test(phone));

  /* A magnitude is sent, never a sign: the server applies the type's
     direction, which is what makes a wrong-way-round row impossible. */
  check('neither shell sends a negative amount',
    !/amount:\s*-/.test(form) && !/amount:\s*-/.test(phone));
  check('the dry run is the default and the save is explicit',
    /commit:\s*true/.test(form) && /commit:\s*true/.test(phone)
    && /dry_run:\s*!commit/.test(core));
}

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const box = async (page, sel) => page.$eval(sel, (e) => {
  const r = e.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
}).catch(() => null);

/* ══ 2. THE DESKTOP SHELL ════════════════════════════════════════════════ */
console.log('\nthe desktop form');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/#deposits`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.depform', { timeout: 15000 });

  check('the deposit form renders on the desktop bundle',
    (await page.$$('.depform')).length === 1);
  check('and it is the desktop shell that rendered it',
    (await page.evaluate(() => document.documentElement.dataset.ui)) !== 'phone');
  const amt = await box(page, '.depamount');
  check('the amount field is a touch target even here', amt && amt.h >= 44, JSON.stringify(amt));
  const chip = await box(page, '.depchip');
  check('so is a supervisor chip', chip && chip.h >= 44, JSON.stringify(chip));

  /* THE WORKLIST'S HONESTY. The third fixture person has no stated cash
     position, so the ledger cannot say what they are holding and the exposure
     is not a number. A dash with the reason on it — never a low percentage. */
  const dashes = await page.$$eval('.dash', (els) => els.map((e) => e.getAttribute('title')));
  check('a person with no stated cash position shows a dash, not a percentage',
    dashes.length >= 1, JSON.stringify(dashes.length));
  check('and the dash carries the reason it cannot be measured',
    dashes.some((t) => /understate exposure/i.test(t || '')), JSON.stringify(dashes));

  /* The amount echo is what a person re-reads before saving. */
  await page.fill('.depamount', '1,250.5');
  check('a grouped amount is read, not refused',
    /AED 1,250\.50/.test(await page.$eval('.depamount + .depnote', (e) => e.textContent)));
  await page.fill('.depamount', '12.345');
  check('too many decimals are named as unreadable rather than rounded',
    /at most two decimals/i.test(await page.$eval('.depamount + .depnote', (e) => e.textContent)));

  /* Nothing may be saved before it has been checked. */
  check('the save button starts disabled',
    await page.$eval('.depactions .primary', (e) => e.disabled));
  await page.click('.depactions .btn');
  await page.waitForSelector('.depverdict .note', { timeout: 5000 });
  const warn = await page.$eval('.depverdict .note', (e) => e.textContent);
  check('pressing check with an empty form lists what is missing, in words',
    /Say who is recording this/.test(warn) && /Pick the driver/.test(warn), warn);
  check('and the save is still disabled',
    await page.$eval('.depactions .primary', (e) => e.disabled));

  const doc = await page.evaluate(() => document.documentElement.scrollWidth);
  check('the page does not slide sideways at 1280px', doc <= 1280, String(doc));
  await ctx.close();
}

/* ══ 3. THE DESKTOP BUNDLE AT PHONE WIDTH — a real surface, not the phone ══ */
console.log('\nthe same bundle at 390px (a narrow window, a tablet, ?ui=desktop)');
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/#deposits`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.depform', { timeout: 15000 });
  const doc = await page.evaluate(() => document.documentElement.scrollWidth);
  check('the page does not slide sideways at 390px', doc <= 390, String(doc));
  const btn = await box(page, '.depactions .primary');
  check('the save button goes full width rather than sharing a row',
    btn && btn.w >= 300, JSON.stringify(btn));
  const over = await page.$$eval('.depform *', (els) => els
    .filter((e) => e.getBoundingClientRect().right > 391).length);
  check('no control in the form sticks out of the viewport', over === 0, String(over));

  /* THE WORKLIST FOLDS INTO CARDS, and this is asserted separately because the
     overflow check above does NOT prove it: tableFrom wraps every table in
     .tscroll, so a four-column table scrolls sideways inside its own box and
     the document stays 390px wide either way. Dropping `cards: true` therefore
     left the page-width assertion green — a guard that passed against the
     unchanged file, which per CLAUDE.md has proved nothing.

     What cards actually buy is that a reader does not scroll sideways through
     every row to read one: each cell becomes a labelled line. That is what
     these assertions measure. */
  check('the worklist renders as cards at phone width',
    (await page.$$('.tcards')).length >= 1);
  const labels = await page.$$eval('.tcards td[data-label]', (els) =>
    [...new Set(els.map((e) => e.getAttribute('data-label')))]);
  check('and every cell carries the column name it folded away from',
    labels.includes('Cash position') && labels.includes('Exposure'), JSON.stringify(labels));
  const tblOver = await page.$$eval('.tcards table', (els) =>
    els.filter((e) => e.scrollWidth > 391).length);
  check('so the table itself is no wider than the column it sits in', tblOver === 0,
    String(tblOver));
  await ctx.close();
}

/* ══ 4. THE PHONE BUNDLE — the one a phone actually loads ═════════════════ */
console.log('\nthe phone bundle');
{
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  await page.goto(`${base}/#deposits`, { waitUntil: 'networkidle' });
  const ui = await page.evaluate(() => document.documentElement.dataset.ui);
  check('a real phone loads the PHONE bundle, not the desktop one at 390px',
    ui === 'phone', String(ui));

  await page.waitForSelector('.m-amount', { timeout: 15000 });
  /* The fallback is what this screen exists to not be. */
  const body = await page.evaluate(() => document.body.innerText);
  check('it is a screen and not "Built for a bigger screen"',
    !/Built for a bigger screen/i.test(body));
  check('the header names the screen in the product\'s words',
    /Cash handed in/i.test(body), body.slice(0, 120));

  const amt = await box(page, '.m-amount');
  check('the amount field is 56px, the one field nobody may misread',
    amt && amt.h >= 56, JSON.stringify(amt));
  check('and it fills the column', amt && amt.w >= 300, JSON.stringify(amt));
  const chip = await box(page, '.m-chip');
  check('a supervisor chip clears 44px', chip && chip.h >= 44, JSON.stringify(chip));
  const save = await box(page, '.m-btn.primary');
  check('the save button is full width and 48px',
    save && save.h >= 48 && save.w >= 300, JSON.stringify(save));

  check('the camera opens rather than a file picker',
    await page.$eval('.m-file', (e) => e.getAttribute('capture')) === 'environment');
  check('and the numeric keypad opens for the amount',
    await page.$eval('.m-amount', (e) => e.getAttribute('inputmode')) === 'decimal');

  const doc = await page.evaluate(() => document.documentElement.scrollWidth);
  check('nothing slides sideways', doc <= 390, String(doc));

  /* The flow: pick a driver from a search, and the picked line explains that a
     deposit is per PERSON however many accounts they hold. */
  await page.fill('.m-search input', 'Tariq');
  await page.waitForSelector('.m-pick', { timeout: 5000 });
  await page.click('.m-pick');
  const picked = await page.$eval('.m-picked', (e) => e.textContent);
  check('picking a driver says a deposit is against the person, not an account',
    /whichever one it is entered against/i.test(picked), picked);

  /* A supervisor first: without one the form's FIRST complaint is about the
     name, not the photograph, which is correct behaviour and was the test
     asserting the wrong step. */
  await page.click('.m-supervisors .m-chip');
  await page.fill('.m-amount', '400');
  await page.fill('.m-noteinput', 'handed in at the depot');
  await page.click('.m-btn:not(.primary)');
  await page.waitForFunction(() => {
    const e = document.querySelector('.m-fieldnote.bad');
    return e && e.textContent.length > 0;
  }, { timeout: 5000 });
  const said = await page.$eval('.m-fieldnote.bad', (e) => e.textContent);
  check('checking without a photograph names the photograph, not something vague',
    /photograph of the receipt/i.test(said), said);
  check('and the save stays disabled', await page.$eval('.m-btn.primary', (e) => e.disabled));

  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n${fail ? '✗' : '✓'} deposit_ui: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
