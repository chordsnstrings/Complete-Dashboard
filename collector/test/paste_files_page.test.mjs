/* The Settings paste panel, driven the way the operator drives it.
   ═══════════════════════════════════════════════════════════════════════════
   test/paste_multifile.test.mjs proves the ROUTE. This proves the PAGE, and
   the two failures it is about are only visible in a browser:

     1. THE PICKER TOOK ONE FILE. `<input type="file">` without `multiple` is
        a single-file picker, and it was wired to overwrite the textarea. The
        operator's actual gesture — select all five, open — kept ONE of them
        and discarded four with nothing on screen to say so. No route test can
        see that: the route was never sent the other four.
     2. THE NAMES WERE NEVER ON SCREEN. The page rendered provider, key, fleet
        and verdict. A credential is "accepted" whichever file it came out of,
        so the table read clean for the upload that cost hours on 2026-09-22 —
        two files holding one token, one of them named for the wrong fleet.

   Driven against mockapi.mjs, which answers this route with the REAL
   recogniser and the REAL cross-file rules and stubs only the provider —
   Chromium here has no route to the internet, and a live Bolt mint is the one
   thing that cannot be done from this sandbox.

   EVERY VALUE IS SYNTHETIC. The JWTs are built in this file from a plain
   object with a signature that says it is not one.

   ── PROVED BY REVERT, 2026-09-22 ────────────────────────────────────────
   Full green is 19/19. Each piece backed out on its own and re-run; measured:

     · `file.multiple = true` removed → "…and accepts more than one" FAILS,
       and then Playwright refuses the multi-file set outright — "Non-multiple
       file input can only accept single file" — so the run ends with no
       pass/fail line at all. That is what the defect looks like from here,
       and it is a failure rather than a pass.
     · the `From` column removed from the proposals table → 17 passed, 2
       FAILED: the table no longer says which file a credential came from,
       and the textarea case can no longer say "the paste box" either.
     · the findings loop above the tables removed → 13 passed, 6 FAILED: the
       duplicate is not named, the fleet claim is not named, the owner a real
       ecosine token must carry is nowhere on the page, and the Bolt
       follow-up is gone.
     · `sending` changed to concatenate the staged files into one `text`
       → 13 passed, 6 FAILED: no per-file table at all, and every finding
       that depends on a filename disappears — the upload that cost hours
       renders as a clean result.
*/
import { chromium } from 'playwright';
import { app } from '../mockapi.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOT_A_SIGNATURE = 'not-a-signature-this-token-is-synthetic';
const boltToken = (owner, jti) => [
  b64u({ alg: 'HS256', typ: 'JWT' }),
  b64u({ data: { fleet_owner_id: owner, jti }, exp: Math.floor(Date.now() / 1000) + 6 * 86400 }),
  NOT_A_SIGNATURE,
].join('.');
const EGARI_TOKEN = boltToken(174036, 'synthetic-egari-1');

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
/* reducedMotion for the same reason every browser test here sets it: the
   headline numbers count up, and an assertion made mid-animation reads a
   value that was never in the data. */
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
await page.goto(`${base}/#settings`, { waitUntil: 'networkidle' });
/* Wait for something that is always on this page — the paste panel itself —
   rather than for the result table, which is what is under test. Waiting on
   the thing under test turns a regression into a 30-second timeout with no
   pass/fail line and nothing naming the cause. */
await page.waitForSelector('[data-panel="paste"]', { timeout: 30000 });

console.log('\nthe picker takes several files, which is the whole request');
{
  const input = await page.$('[data-panel="paste"] input[type=file]');
  check('the file input exists', !!input);
  check('…and accepts more than one', await input.evaluate((e) => e.multiple));

  /* THE DAY'S ACTUAL UPLOAD: two files, one token, one of them named for the
     fleet whose token it is not. */
  await input.setInputFiles([
    { name: 'ECOSINE_BOLT.txt', mimeType: 'text/plain', buffer: Buffer.from(EGARI_TOKEN) },
    { name: 'EGARI_BOLT.txt', mimeType: 'text/plain', buffer: Buffer.from(EGARI_TOKEN) },
  ]);
  await page.waitForFunction(
    () => document.querySelectorAll('[data-panel="paste"] .chip').length >= 2, null, { timeout: 10000 });
  const chips = await page.$$eval('[data-panel="paste"] .chip', (c) => c.map((e) => e.textContent));
  check('both files are staged, by name, before anything is sent',
    chips.some((c) => c.includes('ECOSINE_BOLT.txt')) && chips.some((c) => c.includes('EGARI_BOLT.txt')),
    JSON.stringify(chips));
  /* A staged file the operator changed their mind about has to be removable,
     or the only way out of a wrong upload is a page reload. */
  check('…and the set can be cleared', chips.some((c) => /clear all/.test(c)), JSON.stringify(chips));
}

console.log('\nand the page says which file each verdict is about');
{
  await page.click('[data-panel="paste"] button.btn');
  await page.waitForSelector('[data-panel="paste"] table', { timeout: 20000 });
  const heads = await page.$$eval('[data-panel="paste"] table thead th',
    (th) => th.map((e) => e.textContent.trim()));
  check('the table says which file each credential came out of',
    heads.includes('From'), JSON.stringify(heads));
  check('…and there is a per-file table as well as a per-key one',
    heads.includes('File') && heads.includes('Stored'), JSON.stringify(heads));

  const body = await page.evaluate(() => document.querySelector('[data-panel="paste"]').innerText);
  check('both filenames are on screen', body.includes('ECOSINE_BOLT.txt') && body.includes('EGARI_BOLT.txt'));

  /* The finding that cost the hours. It must be in WORDS, above the table —
     an operator who reads only the verdict column sees "accepted" and learns
     nothing. */
  check('the duplicate is named, in words',
    /hold the SAME credential/i.test(body), body.slice(0, 400));
  check('…and says what it means rather than tidying it away',
    /one capture, not two/i.test(body));
  check('the file named for the wrong fleet is named',
    /ECOSINE_BOLT\.txt is named for ecosine/i.test(body), body.slice(0, 600));
  check('…naming the owner a real ecosine token must carry',
    /173999/.test(body));
  check('…and saying outright that ecosine got nothing',
    /ecosine has been given nothing/i.test(body));

  /* The errand that must NOT be given after a Bolt paste. */
  check('a Bolt paste sends the operator to the other fleet',
    /check the other fleet/i.test(body), body.slice(0, 900));
  check('…and never tells them to go and capture another one',
    !/capture a fresh one/i.test(body));

  check('the credential is still filed under the fleet it names',
    /BOLT_REFRESH_TOKEN_EGARI/.test(body));
  /* The rule that outranks the rest of this file. */
  check('and the token itself is never printed back', !body.includes(EGARI_TOKEN));
}

console.log('\nthe single paste box is untouched');
{
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-panel="paste"] textarea', { timeout: 30000 });
  await page.fill('[data-panel="paste"] textarea', EGARI_TOKEN);
  await page.click('[data-panel="paste"] button.btn');
  await page.waitForSelector('[data-panel="paste"] table', { timeout: 20000 });
  const body = await page.evaluate(() => document.querySelector('[data-panel="paste"]').innerText);
  check('a bare paste still reads and reports', /BOLT_REFRESH_TOKEN_EGARI/.test(body), body.slice(0, 300));
  check('…and says so rather than inventing a filename',
    /the paste box/i.test(body), body.slice(0, 400));
}

check('no page error anywhere in this flow', errs.length === 0, JSON.stringify(errs));

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
