/* Every headline tile in this product is built in one place.
   ─────────────────────────────────────────────────────────────────────────
   .kpi .n sets white-space:nowrap, and .kpi is overflow:hidden, so a value
   too wide for its tile is CUT at the card edge — mid-number, with not even an
   ellipsis to say the figure is incomplete. kpiRow() has guarded against that
   since the first time it happened, by measuring the value's plain text and
   adding .long, which lets it wrap.

   Eight tiles were not built by kpiRow. They were template strings written
   inline in app.js, and not one of them had the measurement. So the same
   defect was found and repaired three separate times on three separate copies
   of the same markup — "+AED 37,286 · 150.9%" on #reconcile, "0 stuck · 12
   dead" on the tracker page, "Money in" on the Overview — and every fix left
   the other seven copies able to do it again.

   Two things are asserted, because either alone is weak. That the guard fires
   on a long value, which is the behaviour; and that there is only one place
   able to get it wrong, which is why the behaviour will stay true. */
import { readFileSync } from 'node:fs';
import { kpiTile, kpiTiles } from '../api/public/ui.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nthe guard fires on a value too long for one line');

const short = kpiTile({ label: 'Trips', value: '74' });
const long = kpiTile({ label: 'Money in', value: 'AED 37,286 · 150.9%' });
check('a short value is left on one line', !/class="n num long"/.test(short), short.slice(0, 120));
check('a long one is allowed to wrap', /class="n num long"/.test(long), long.slice(0, 140));

/* Measured on what the reader SEES. A value carrying a pill is a few
   characters of text inside forty of markup, and judging it by string length
   would wrap every one of them. */
const pill = kpiTile({ label: 'Gap', html: '<span class="pill bad">12</span>' });
check('markup is not counted as length', !/num long/.test(pill), pill.slice(0, 160));
const pillLong = kpiTile({ label: 'Gap', html: '<span class="pill bad">+AED 228,060 · 114.5%</span>' });
check('…but the text inside it is', /num long/.test(pillLong), pillLong.slice(0, 200));

console.log('\nthe two tone vocabularies became one');

/* The inline tiles said ok / warn / err and got their colour from a parallel
   set of rules; kpiRow says t-good / t-warn / t-serious / t-critical, which is
   the four-step ramp the palette actually has. A tile that says "err" must
   reach --critical by the same route as everything else. */
for (const [given, want] of [['ok', 't-good'], ['err', 't-critical'], ['warn', 't-warn'],
  ['good', 't-good'], ['serious', 't-serious'], ['critical', 't-critical']]) {
  const html = kpiTile({ label: 'x', value: '1', tone: given });
  check(`tone "${given}" renders as ${want}`, new RegExp(`class="kpi ${want}`).test(html), html.slice(0, 90));
}
check('an unknown tone colours nothing rather than guessing',
  /class="kpi"/.test(kpiTile({ label: 'x', value: '1', tone: 'purple' })));

console.log('\na tile that opens something is a real link');

const link = kpiTile({ label: 'Critical', value: '3', to: '#insights/severity/critical', who: false });
check('it is an anchor', /^\s*<a /.test(link), link.slice(0, 60));
check('…carrying the address', /href="#insights\/severity\/critical"/.test(link));
check('…and it does not invite the reader to ask "who exactly" about a finding',
  !/kpi-who/.test(link), link);
const cohort = kpiTile({ label: 'Not earning', value: '282', to: '#cohort/idle' });
check('…while a tile that opens a list of PEOPLE still does', /kpi-who/.test(cohort));

console.log('\nand there is only one implementation left to get wrong');

const app = readFileSync(new URL('../api/public/app.js', import.meta.url), 'utf8');
const driver = readFileSync(new URL('../api/public/driver.js', import.meta.url), 'utf8');
const vehicle = readFileSync(new URL('../api/public/vehicle.js', import.meta.url), 'utf8');
/* Written as markup, anywhere but the one function that builds it. This is a
   fact about the source and the source is the right place to ask it: the
   question is not "does a tile behave" but "is there a second copy able to
   drift". */
const handRolled = [['app.js', app], ['driver.js', driver], ['vehicle.js', vehicle]]
  .filter(([, src]) => /class="kpi[ "]/.test(src)).map(([n]) => n);
check('no page writes tile markup of its own', handRolled.length === 0, handRolled.join(', '));
check('the tiles all come from ui.js', /kpiTile|kpiRow/.test(app), '');

/* kpiRow is the row; kpiTile is the tile. The row must not grow a second
   implementation of the tile inside it. */
const ui = readFileSync(new URL('../api/public/ui.js', import.meta.url), 'utf8');
check('kpiRow builds its row out of the same tile everything else uses',
  /export function kpiRow\(items\) \{\s*const host = el\('div', 'kpis'\);\s*host\.innerHTML = kpiTiles\(items\);/.test(ui));
check('and a row of tiles is the tiles joined, nothing more',
  kpiTiles([{ label: 'a', value: '1' }, { label: 'b', value: '2' }])
    === kpiTile({ label: 'a', value: '1' }) + kpiTile({ label: 'b', value: '2' }));
check('…and a hole in the list is skipped, not rendered empty',
  kpiTiles([null, { label: 'a', value: '1' }, false]) === kpiTile({ label: 'a', value: '1' }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
