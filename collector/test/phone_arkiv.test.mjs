/* The redesigned phone PWA, under the Arkiv skin.
   ─────────────────────────────────────────────────────────────────────────
   The operator's ruling of 2026-09-24: "Phone will have a redesigned pwa
   app" — with the standing instruction that every figure, every screen's
   purpose and every operational flow the phone has today survives
   (docs/UI-REDESIGN-PLAN.md, "Phone PWA — redesign"). The old skin's half is
   test/phone_classic.test.mjs, which holds the old screens byte-identical.
   This file holds the new ones, section by section as each lands:

     0. WHICH PHONE IS A TOKEN — --pg-phone, 0 in app.css and 1 in
        m/arkiv-m.css — and no module reads the skin attribute.

   Static checks run on the source; the browser checks use the hermetic
   harness (test/phone_harness.mjs): the recorded API answers and a frozen
   clock, so a figure on screen can be compared with the answer it came from
   and with what the old screen printed from the same answer. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUB } from './phone_harness.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const read = (f) => readFileSync(join(PUB, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');

console.log('\n0 · which phone is a token');
const app = strip(read('app.css'));
/* The FIRST :root block is the old skin's light root; the theme blocks and
   the generated Arkiv block come later and must not move it. */
const firstRoot = app.slice(app.indexOf(':root{'), app.indexOf('}', app.indexOf(':root{')));
check('app.css declares --pg-phone:0 in the old skin’s :root', /--pg-phone:0;/.test(firstRoot));
check('…and nothing else in app.css declares it (no theme block moves it)',
  (app.match(/--pg-phone\s*:/g) || []).length === 1, String((app.match(/--pg-phone\s*:/g) || []).length));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
