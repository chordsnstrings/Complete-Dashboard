/* countUp() must never show a figure on the wrong side of zero.
   ─────────────────────────────────────────────────────────────────────────
   app.js countUp() animates a KPI from 0 to its value with an ease-out cubic
   over p = (now − t0) / 620 ms, where `now` is the requestAnimationFrame
   timestamp and t0 is performance.now() at the call. A frame's timestamp is
   the START of that frame, so it can be earlier than t0. Before p was clamped
   at 0, that made p negative and the cubic with it, and the tile printed a
   negative figure. The final full suite of the page phase (2026-09-24) caught
   the idle-days tile reading "-176" (value 289) and the per-earning-day tile
   reading "AED -178.65" (value AED 293.71) in test/money_contradictions. It
   had been seen once before and filed as "reason not established" (P6).

   This file makes the condition certain instead of waiting for load to cause
   it. Every animation frame is handed a timestamp 150 ms in the past. Every
   `.kpi .n` text is recorded after every frame, and a tile whose settled
   figure is not negative must never have shown a negative one. Motion is left
   ON here (every other browser harness reduces it), because the defect lives
   only in the animation.

   Synthetic data only (the mock). */
import express from 'express';
import { launchChromium } from './browser.mjs';

const { app: mock } = await import('../mockapi.mjs');
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const web = express();
web.use(express.static('api/public'));
web.use(mock);
const srv = web.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const browser = await launchChromium();
const NEG = /[-−]\s*\d/;

for (const [skin, hash] of [['classic', '#unit?days=2'], ['classic', '#overview'], ['arkiv', '#unit?days=2']]) {
  console.log(`\n${skin} ${hash}`);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference',
    timezoneId: 'Asia/Dubai', locale: 'en-GB' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((negSrc) => {
    const NEG = new RegExp(negSrc);
    window.__cu = { frames: 0, neg: [], moved: 0 };
    const real = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => real(() => {
      cb(performance.now() - 150);
      window.__cu.frames++;
      for (const n of document.querySelectorAll('.kpi .n')) {
        const t = n.textContent.trim();
        if (!n.__first) { n.__first = t; } else if (t !== n.__first && !n.__moved) { n.__moved = true; window.__cu.moved++; }
        if (NEG.test(t) && !n.__neg) { n.__neg = t; window.__cu.neg.push(n); }
      }
    });
  }, NEG.source);
  await page.goto(`${base}/?ui=desktop&skin=${skin}${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('#view .kpi .n').length > 0, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const r = await page.evaluate((negSrc) => {
    const NEG = new RegExp(negSrc);
    return {
      tiles: document.querySelectorAll('#view .kpi .n').length,
      frames: window.__cu.frames,
      moved: window.__cu.moved,
      wrong: window.__cu.neg.filter((n) => n.isConnected && !NEG.test(n.textContent)).map((n) => [n.__neg, n.textContent.trim()]),
    };
  }, NEG.source);
  check('the page drew tiles and the count-up ran under the shifted clock', r.tiles > 0 && r.frames > 0 && r.moved > 0, JSON.stringify(r));
  check('no tile whose figure is not negative ever showed a negative one', r.wrong.length === 0, JSON.stringify(r.wrong.slice(0, 4)));
  check('no page error', errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
