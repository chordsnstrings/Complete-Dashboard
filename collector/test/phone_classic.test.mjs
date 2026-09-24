/* The old skin's phone did not move by one byte.
   ─────────────────────────────────────────────────────────────────────────
   The operator's ruling of 2026-09-24 gives the phone a redesign, and the
   standing instruction for the whole reskin is that production's look does
   not change until the operator flips the default (docs/UI-REDESIGN-PLAN.md
   §3 STEP 5, and "Phone PWA — redesign"). The redesign is gated on a token,
   --pg-phone, which only m/arkiv-m.css declares 1 — and that sheet is only
   written for a phone reader who chose ?skin=arkiv. Everything else must draw
   what it drew before.

   "It looks the same" is not a proof, so this compares the DOM. Every phone
   screen, the few one-tap states that draw a different list, and the window
   sheet are rendered from the working tree under the old skin, against the
   recorded API answers and a frozen clock (test/phone_harness.mjs), and each
   #m must equal — character for character — what the tree before the
   redesign drew from the same answers at the same instant
   (test/fixtures/phone_classic_dom.json.gz, taken by bin/phone-fixture.mjs
   from commit abb79ad, the base the redesign started from).

   When this fails, it prints the first place the two disagree. A change that
   is SUPPOSED to move the old skin's phone (a bug fix the operator wants on
   production now) re-takes the oracle from the fixed tree and says so in its
   commit — never from the tree being tested for the redesign. */
import { gunzipSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, phonePage, SCREENS, loadFixture, domOf } from './phone_harness.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = loadFixture();
const oraclePath = join(FIX, 'phone_classic_dom.json.gz');
check('the recorded API answers are on disk', !!fixture);
check('the old skin’s oracle is on disk', existsSync(oraclePath));
if (!fixture || !existsSync(oraclePath)) process.exit(1);
const oracle = JSON.parse(gunzipSync(readFileSync(oraclePath)).toString('utf8'));
console.log(`  oracle from ${oracle.tree}, answers recorded at ${oracle.at}`);

const firstDiff = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
};

const browser = await launch();
const p = await phonePage(browser, { skin: 'classic', fixture });
const got = {};
for (const s of SCREENS) {
  await p.open(s.route);
  if (s.tap) { await p.page.click(s.tap); await p.settle(); }
  got[s.as || s.route] = await domOf(p.page);
}
await p.open('today');
await p.page.click('.m-head button[title="Window and channels"]');
await p.settle();
await p.page.waitForTimeout(400);
got['today+sheet'] = await domOf(p.page);

/* The page must not know the redesign exists: no sheet of it requested, no
   token read as 1. */
const probe = await p.page.evaluate(() => ({
  sheets: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => new URL(l.href).pathname),
  token: getComputedStyle(document.documentElement).getPropertyValue('--pg-phone').trim(),
  skin: document.documentElement.dataset.skin || null,
}));
const misses = [...p.misses];
const errors = [...p.errors];
await p.close();
await browser.close();

console.log('\nthe old skin’s phone, screen by screen, against the tree before the redesign');
for (const [name, want] of Object.entries(oracle.screens)) {
  const have = got[name];
  if (have == null) { check(`${name} was rendered`, false); continue; }
  const at = firstDiff(have, want);
  check(`${name}: #m is byte-identical (${want.length} chars)`, have === want,
    have === want ? '' : `\n      first difference at ${at}:\n      before: …${want.slice(Math.max(0, at - 80), at + 120)}…`
      + `\n      now:    …${have.slice(Math.max(0, at - 80), at + 120)}…`);
}
check('every screen the oracle holds was compared', Object.keys(oracle.screens).every((k) => k in got));

console.log('\nand the redesign is not reachable from the old skin');
check('no redesign sheet is requested', !probe.sheets.some((s) => /arkiv/.test(s)), probe.sheets.join(' '));
check('--pg-phone reads 0 (or nothing) under the old skin', probe.token === '' || probe.token === '0', probe.token);
check('the skin attribute is not stamped', probe.skin === null, String(probe.skin));
check('every API call was answered from the recording', !misses.length, misses.join(' '));
check('no screen threw', !errors.length, errors.slice(0, 3).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
