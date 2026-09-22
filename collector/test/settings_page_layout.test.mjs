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

     4. AN INPUT FLOATED AWAY FROM ITS OWN LABEL. Found after the three above
        were live, by measuring the deployed page rather than looking at it:
        `.setrow` is `align-items:center`, and a row made three or four lines
        tall by its hint pushed the input 23-102px BELOW the label naming it.
        21 of the 47 rows on production carry a hint; the 26 without one sat
        at 2px. At 102px the input's midline is level with the fourth line of
        a different credential's sentence, and you lose which box the label
        belongs to. Only hinted rows change - a short row centred is right.

   Driven against mockapi.mjs, whose /api/settings fixture carries several
   providers so the grouping has something to group, and whose /api/admin-mode
   fixture answers `open: true` because that is the deployment this page is
   written against. NO REAL CREDENTIAL IS READ OR PRINTED: every value in the
   fixture is synthetic and the assertions below read structure, not values.

   ── PROVED BY REVERT, 2026-09-22 ────────────────────────────────
   Full green is 20/20 against the mock, whose /api/settings fixture carries
   five groups and five rows (production carries forty-seven). Each fix backed
   out on its own and the suite re-run; every count below was MEASURED after
   the alignment block was added, not carried forward:

     · `(groupEl || wrap).append(row)` → `wrap.append(row)` — 18 passed, 2
       FAILED: {"groups":5,"rows":5,"inside":0,"loose":5,"empty":["Uber",
       "Yango","CABMAN","Hotel","Collection"]}. Every group an empty card,
       every row loose. That is the production screenshot exactly.
     · the `.setrow .lab small{display:block…}` rule deleted — 17 passed, 3
       FAILED: the key's computed display reads `inline` and its font is not
       monospaced — the "usernameFMS_ECOSINE_USER" defect — and the alignment
       check goes with it, because an inline key changes the geometry it is
       measured against ({"base":-9,"hinted":[2,2,2]}). Note the geometry
       check alone does NOT catch the key defect: a long label wraps and
       pushes an inline <small> down a line anyway, so the computed `display`
       is the load-bearing half of that assertion.
     · the hint welded back into <small> as `' · ' + esc(d.hint)` — 15
       passed, 5 FAILED: no `.labhint` exists at all, the key reads
       "UBER_WEB_COOKIE · Paste from a logged-in supplier.uber.com session" —
       a sentence in an identifier's typeface — and the alignment block's own
       guard fires, "there are hinted rows to measure: 0". That guard is why
       the alignment assertion cannot pass vacuously.
     · the subtitle hardcoded back to 'Changes require the admin token
       configured on the server' — 18 passed, 2 FAILED: with the fixture open,
       the panel both fails to name the open state and asserts a gate this
       server is not running.
     · the two `:has(.labhint)` rules deleted — 19 passed, 1 FAILED:
       {"base":2,"hinted":[23,23,13]}. Small numbers on the mock because its
       hints are short; on production the same revert is the 23-102px spread
       above. The assertion is ± 2px of an unhinted row, not "near" — a
       threshold wide enough to be comfortable is wide enough to absorb the
       regression it exists to catch.

   Two of those five counts were first written down by arithmetic — 16 green
   minus 2 — and re-running them gave 3 and 5, because the alignment block
   couples to the other fixes in ways subtraction cannot see. They are all
   measured now. This is the same failure the file is about: a number nobody
   re-took is a number that has quietly stopped being true.

   And one proof the other way, that the sentence is READ rather than printed:
   flipping the fixture to `open: false` with the fix in place turns the panel
   to "Writes require the admin token…" and the suite stays 20/20. So the two
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

console.log('\nan input stays level with the label that names it');
{
  /* MEASURED ON PRODUCTION, 2026-09-22: 21 of the 47 credential rows carry a
     hint, and `align-items:center` on a row made three lines tall by that hint
     pushed the input 23-102px BELOW the label naming it, while the 26 rows
     without a hint sat at 2px. At 102px the input's midline is level with the
     fourth line of a different credential's sentence. The assertion is that a
     hinted row's input starts where an unhinted row's does, within a couple of
     pixels — not that it is "near", which is the kind of threshold that
     absorbs a regression silently. */
  const m = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-panel="credentials"] .setrow')];
    const drift = (r) => {
      const lab = r.querySelector('.lab'), inp = r.querySelector('input');
      return (lab && inp) ? Math.round(inp.getBoundingClientRect().top - lab.getBoundingClientRect().top) : null;
    };
    const has = (r) => !!r.querySelector('.labhint');
    return {
      hasSupported: CSS.supports('selector(.a:has(.b))'),
      hinted: rows.filter(has).map(drift).filter((x) => x !== null),
      plain: rows.filter((r) => !has(r)).map(drift).filter((x) => x !== null),
    };
  });
  check('the browser under test supports :has(), or this proves nothing', m.hasSupported);
  check('there are hinted rows to measure', m.hinted.length > 0, JSON.stringify(m.hinted.length));
  check('there are unhinted rows to measure against', m.plain.length > 0, JSON.stringify(m.plain.length));
  const base = Math.max(...m.plain);
  check('a hinted row lines its input up with an unhinted one',
    m.hinted.every((d) => Math.abs(d - base) <= 2), JSON.stringify({ base, hinted: m.hinted }));
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
