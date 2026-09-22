/* The Settings page's STRUCTURE, which had three separate things wrong with it.
   ═══════════════════════════════════════════════════════════════════════════
   Reported on 2026-09-22 as "the page is broken padding and in general the
   structure". Screenshotting the production bytes found three defects, and
   only one of them is spacing:

     1. A GROUP WAS AN EMPTY CARD BESIDE ITS ROWS. app.js appended
        `el('div','setgroup', grp)` to `wrap` and then appended the rows to
        `wrap` as well — siblings, not children. app.css:957 styles .setgroup
        as a card (surface, border, radius, padding, shadow), so each provider
        name rendered as a bordered box with nothing in it and the forty rows
        it named ran loose underneath it, edge to edge. The CSS had always
        described the intent; the DOM never matched it.

     2. THE LABEL AND THE KEY WERE ONE WORD. `.lab` and `.lab small` had no
        CSS rule anywhere in app.css, and <small> is inline by default, so
        label and key concatenated on screen: "usernameFMS_ECOSINE_USER",
        "passwordFMS_ECOSINE_PASS". The key is the string an operator matches
        against a provider's own documentation, so it has to be separable by
        eye. The hint — a sentence saying where to get the credential — was
        glued onto the same <small> with ' · ', which monospaced prose.

     3. THE ADMIN PANEL STATED SOMETHING THE SERVER DOES NOT DO. The subtitle
        read "Changes require the admin token configured on the server".
        api/admin_gate.js runs the write gate OPEN when ADMIN_TOKEN is unset,
        which is this deployment's deliberate state: it warns once and calls
        next(). An operator who believed that sentence would hunt for a token
        problem that is not there. The page now asks /api/admin-mode and says
        which state the server is actually in. That is the house rule — a
        figure that cannot be measured renders absent with a reason, and a
        reason that is not the true one is worse than none.

   Driven against mockapi.mjs, whose /api/settings fixture carries several
   providers so the grouping has something to group, and whose /api/admin-mode
   fixture answers `open: true` because that is the deployment this page is
   written against. NO REAL CREDENTIAL IS READ OR PRINTED: every value in the
   fixture is synthetic and the assertions below read structure, not values.

   ── PROVED BY REVERT, 2026-09-22 ────────────────────────────────
   Full green is 16/16 against the mock, whose /api/settings fixture carries
   five groups and five rows (production carries forty). Each fix backed out
   on its own and the suite re-run; measured, not asserted:

     · `(groupEl || wrap).append(row)` → `wrap.append(row)` — 14 passed, 2
       FAILED: {"groups":5,"rows":5,"inside":0,"loose":5,"empty":["Uber",
       "Yango","CABMAN","Hotel","Collection"]}. Every group an empty card,
       every row loose. That is the production screenshot exactly.
     · the `.setrow .lab small{display:block…}` rule deleted — 14 passed, 2
       FAILED: the key's computed display reads `inline` and its font is not
       monospaced, which is the "usernameFMS_ECOSINE_USER" defect. Note the
       geometry check alone does NOT catch it — a long label wraps and pushes
       the inline <small> down a line anyway — so the computed `display` is
       the load-bearing half of that assertion.
     · the hint welded back into <small> as `' · ' + esc(d.hint)` — 12
       passed, 4 FAILED: no `.labhint` exists at all, and the key now reads
       "UBER_WEB_COOKIE · Paste from a logged-in supplier.uber.com session",
       which is a sentence set in a monospace identifier's typeface.
     · the subtitle hardcoded back to 'Changes require the admin token
       configured on the server' — 14 passed, 2 FAILED: with the fixture open,
       the panel both fails to name the open state and asserts a gate this
       server is not running.

   And one proof the other way, that the sentence is READ rather than printed:
   flipping the fixture to `open: false` with the fix in place turns the panel
   to "Writes require the admin token…" and the suite stays 16/16. So the two
   admin assertions bite on `open === true` only — they track what the server
   says, which is the entire point of the route.
*/
import { chromium } from 'playwright';
import { app } from '../mockapi.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1400 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
await page.goto(`${base}/#settings`, { waitUntil: 'networkidle' });
/* Wait for a .setrow, not for the panel: the rows arrive from /api/settings a
   tick after the panel is in the DOM, and an assertion made against the empty
   panel would report "0 rows loose outside a group" as a pass. */
await page.waitForSelector('[data-panel="credentials"] .setrow', { timeout: 30000 });

console.log('\na group is a card that CONTAINS its rows');
{
  const m = await page.evaluate(() => {
    const scope = document.querySelector('[data-panel="credentials"]');
    const groups = [...scope.querySelectorAll('.setgroup')];
    return {
      groups: groups.length,
      rows: scope.querySelectorAll('.setrow').length,
      inside: scope.querySelectorAll('.setgroup .setrow').length,
      loose: [...scope.querySelectorAll('.setrow')].filter((r) => !r.closest('.setgroup')).length,
      empty: groups.filter((g) => !g.querySelector('.setrow')).map((g) => g.textContent.trim().slice(0, 40)),
      heads: groups.map((g) => (g.querySelector('.setgroup-h') || {}).textContent || null),
      /* The head has to be INSIDE the card it titles, above the rows. */
      headFirst: groups.every((g) => g.firstElementChild
        && g.firstElementChild.classList.contains('setgroup-h')),
    };
  });
  check('the page renders more than one provider group', m.groups > 1, JSON.stringify(m.groups));
  check('the page renders credential rows at all', m.rows > 0, JSON.stringify(m.rows));
  check('every credential row is inside the group that names it',
    m.loose === 0 && m.inside === m.rows, JSON.stringify(m));
  check('a group is not an empty card', m.empty.length === 0, JSON.stringify(m.empty));
  check('each group is headed by the provider it holds',
    m.headFirst && m.heads.every((h) => h && h.trim().length), JSON.stringify(m.heads));
}

console.log('\nlabel, key and hint are three things, not one string');
{
  const m = await page.evaluate(() => {
    const lab = document.querySelector('[data-panel="credentials"] .setrow .lab');
    const small = lab.querySelector('small');
    const cs = getComputedStyle(small);
    const labBox = lab.getBoundingClientRect(), keyBox = small.getBoundingClientRect();
    /* Find a row that HAS a hint — not every credential carries one. */
    const hintRow = [...document.querySelectorAll('[data-panel="credentials"] .setrow .lab')]
      .find((l) => l.querySelector('.labhint'));
    const hint = hintRow && hintRow.querySelector('.labhint');
    const hs = hint && getComputedStyle(hint);
    const body = getComputedStyle(document.body).fontFamily;
    return {
      keyDisplay: cs.display,
      keyMono: /mono/i.test(cs.fontFamily),
      keyText: small.textContent.trim(),
      /* The defect was the two running together on ONE line. */
      keyBelowLabel: Math.round(keyBox.top) > Math.round(labBox.top),
      labelText: lab.firstChild && lab.firstChild.textContent.trim(),
      hasHint: !!hint,
      hintDisplay: hs && hs.display,
      hintMono: hs ? /mono/i.test(hs.fontFamily) : null,
      hintInSmall: hint ? !!hint.closest('small') : null,
      bodyMono: /mono/i.test(body),
    };
  });
  check('the key is on its own line, not welded to the label',
    m.keyDisplay === 'block' && m.keyBelowLabel, JSON.stringify(m));
  check('the label still reads as words', !!m.labelText && !/^[A-Z0-9_]+$/.test(m.labelText), m.labelText);
  check('the key still reads as an identifier', /^[A-Z0-9_]+$/.test(m.keyText), m.keyText);
  check('the key is monospaced, because it is one', m.keyMono, JSON.stringify(m.keyMono));
  check('some row carries a hint', m.hasHint);
  check('the hint is prose, not an identifier',
    m.hasHint && m.hintMono === false && !m.bodyMono, JSON.stringify(m));
  check('the hint is on its own line too',
    m.hintDisplay === 'block' && m.hintInSmall === false, JSON.stringify(m));
}

console.log('\nthe admin panel says what the SERVER does, not what it wishes');
{
  const mode = await (await page.request.get(`${base}/api/admin-mode`)).json();
  const txt = await page.evaluate(() =>
    document.querySelector('[data-panel="adminmode"]').innerText);
  check('the API says whether the write gate is open',
    typeof mode.open === 'boolean', JSON.stringify(mode));
  check('the panel says which state the server is in',
    mode.open ? /OPEN/.test(txt) : /require/i.test(txt), txt.slice(0, 300));
  check('it no longer claims a gate this server is not running',
    !(mode.open && /(changes|writes) require the admin token/i.test(txt)), txt.slice(0, 300));
}

check('no page error anywhere on this view', errs.length === 0, JSON.stringify(errs));

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
