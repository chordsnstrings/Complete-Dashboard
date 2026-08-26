/* ── two minus signs on one page ───────────────────────────────────────────
   money() emits U+2212 and Math.round/toFixed emit an ASCII hyphen, and this
   product built its signed numbers both ways. Screenshotting production found
   them adjacent: #revenue's payout tree shows "−AED 600.59" in the Amount
   column and "-1.8%" in the Share column of the same row, and #causes printed
   "Largest move -76%" beside notes reading "Bookings moved -69%, drivers -40%".

   A hyphen is narrower than a minus and sits higher. On a page whose entire
   subject is which way the numbers MOVED, the glyph carrying that meaning is
   the one a reader can scan past.

   signed() is the one place a number's own sign is written. Plus is explicit,
   minus is U+2212, zero carries neither, and the unit is appended by the
   helper so a caller cannot put the sign on the wrong side of it.

   Checked as a unit — the helper's own output — plus a source sweep for the
   pattern it replaced, because the next hand-rolled `${v > 0 ? '+' : ''}` is
   how the inconsistency comes back. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'api', 'public');

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const browser = await launchChromium();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'domcontentloaded' });
const out = await page.evaluate(async () => {
  const ui = await import('/ui.js');
  return {
    neg: ui.signed(-76, { unit: '%' }),
    pos: ui.signed(69, { unit: '%' }),
    zero: ui.signed(0, { unit: '%' }),
    nul: ui.signed(null),
    dec: ui.signed(-1.25, { d: 1 }),
    unitless: ui.signed(-4),
    big: ui.signed(-1182, { unit: '/month' }),
    pctNeg: ui.pct(-1.8, 1),
    pctPos: ui.pct(1.6, 1),
    money: ui.money(-600.59, 'AED', 2),
    moneyPos: ui.money(600.59, 'AED', 2),
  };
});
await browser.close();
server.close();

console.log('\nsigned() writes the sign, in the house glyphs');
check('a fall carries U+2212, not a hyphen', out.neg === '−76%', JSON.stringify(out.neg));
check('and never an ASCII hyphen', !out.neg.includes('-'), JSON.stringify(out.neg));
check('a rise carries an explicit plus', out.pos === '+69%', JSON.stringify(out.pos));
check('zero carries neither', out.zero === '0%', JSON.stringify(out.zero));
check('an absent value is an em-dash', out.nul === '—', JSON.stringify(out.nul));
check('decimals are kept where asked for', out.dec === '−1.3' || out.dec === '−1.2',
  JSON.stringify(out.dec));
check('the unit is appended after the number', out.big === '−1,182/month', JSON.stringify(out.big));
check('a bare number needs no unit', out.unitless === '−4', JSON.stringify(out.unitless));

console.log('\nand pct() agrees with money() about what a minus looks like');
check('pct uses U+2212', out.pctNeg === '−1.8%', JSON.stringify(out.pctNeg));
check('a positive percentage is unsigned', out.pctPos === '1.6%', JSON.stringify(out.pctPos));
check('money uses the same glyph', out.money.includes('\u2212'), JSON.stringify(out.money));
check('and puts it before the currency, where a reader reads it',
  out.money.startsWith('\u2212'), JSON.stringify(out.money));
check('a positive amount carries no sign', out.moneyPos === 'AED 600.59', JSON.stringify(out.moneyPos));

console.log('\nnothing builds a sign by hand any more');
/* The shape that was everywhere: a ternary on a numeric COMPARISON emitting
   '+' for positives and nothing for negatives, leaving whatever glyph the
   formatter produced for the negative case.

   The comparison is the part that matters. Without it this also matched
   providers.js's `${capped ? '+' : ''}`, where the plus means "at least this
   many" on a sampled count — a suffix, not a sign, and nothing to do with
   this rule. A check that flags correct code is a check people learn to
   ignore. */
const HAND = /[><]=?\s*0\s*\?\s*'\+'\s*:\s*''\s*\}/;
const offenders = readdirSync(PUB).filter((f) => f.endsWith('.js'))
  .map((f) => [f, readFileSync(join(PUB, f), 'utf8')])
  /* ui.js documents the pattern in signed()'s own comment. */
  .filter(([f, src]) => f !== 'ui.js' && HAND.test(src))
  .map(([f, src]) => `${f}:${src.split('\n').findIndex((l) => HAND.test(l)) + 1}`);
check('no view rolls its own sign', offenders.length === 0, offenders.join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
