/* One type scale, and a stylesheet that cannot quietly grow a fiftieth size.
   ─────────────────────────────────────────────────────────────────────────
   app.css carried forty-nine distinct font sizes across a hundred and
   fifty-three declarations, and m.css twenty-six more. Among them: .77, .78,
   .79, .8, .81, .82, .83, .84, .85, .86, .87, .88 and .885rem — thirteen sizes
   inside a single point, which no reader can tell apart and no author can
   choose between. That is not a scale, it is drift, and drift has no bottom:
   every rule added is one more value, because picking a number is easier than
   finding the one that already means what you want.

   The steps were chosen AT the sizes already carrying the most weight, so the
   busiest text did not move — .72, .78, .82, .85 and .92rem are exactly where
   they were, and of a hundred and ninety-three declarations across both files
   all but four move by under four per cent.

   What is asserted is that it STAYS one scale. A literal font-size anywhere in
   either stylesheet is the fiftieth value arriving, and it arrives one at a
   time — which is exactly why nobody notices. */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = readFileSync(new URL('../api/public/app.css', import.meta.url), 'utf8');
const m = readFileSync(new URL('../api/public/m/m.css', import.meta.url), 'utf8');

const sizes = (css) => [...css.matchAll(/font-size:\s*([^;}]+)/g)].map((x) => x[1].trim());

console.log('\nevery size on the page comes from the scale');

for (const [name, css] of [['app.css', app], ['m.css', m]]) {
  const all = sizes(css);
  /* clamp() and em are deliberate exceptions and are named as such: a clamp is
     a size that RESPONDS — to the container, to the viewport — and an em is a
     size relative to whatever it sits in. Neither is a step of a scale, and
     folding them into one would be flattening the thing that makes them
     useful. Everything else must be a token. */
  const literal = all.filter((v) => !v.startsWith('var(')
    && !v.startsWith('clamp(') && !/\dem$/.test(v));
  check(`${name}: no rule sets a size of its own`, literal.length === 0,
    `${literal.length}: ${[...new Set(literal)].join(', ')}`);
  check(`${name}: and it does set sizes, so this is measuring something`,
    all.length > (name === 'app.css' ? 100 : 20), String(all.length));
}

console.log('\nthe scale is a scale');

const tokens = [...app.matchAll(/--([td]\d+):\s*([\d.]+)rem/g)]
  .map((x) => ({ name: `--${x[1]}`, rem: +x[2] }));
check('it is declared once, in app.css', tokens.length >= 12, String(tokens.length));
/* Both stylesheets resolve against the same declaration — index.html loads
   app.css for every reader and adds m.css on top for a phone — so a token used
   in m.css and defined only in app.css is correct, and a token used in m.css
   and defined NOWHERE renders at the browser default with no error at all. */
const defined = new Set(tokens.map((t) => t.name));
const used = new Set([...sizes(app), ...sizes(m)]
  .filter((v) => v.startsWith('var('))
  .map((v) => v.slice(4, -1).split(',')[0].trim()));
const undef = [...used].filter((t) => !defined.has(t));
check('every token a rule asks for is defined', undef.length === 0, undef.join(', '));
/* The other direction: a step nothing uses is a step somebody will use by
   accident, believing it means something. */
const unused = [...defined].filter((t) => !used.has(t));
check('and every step defined is used', unused.length === 0, unused.join(', '));

const asc = [...tokens].sort((a, b) => a.rem - b.rem);
check('the steps are distinct', asc.length >= 12
  && new Set(asc.map((t) => t.rem)).size === asc.length, asc.map((t) => t.rem).join(' '));
/* Two steps a reader cannot tell apart are one step and a trap. Six per cent
   is roughly the smallest difference in body text that reads as deliberate. */
const tooClose = asc.slice(1).map((t, i) => [asc[i], t])
  .filter(([a, b]) => b.rem / a.rem < 1.06);
/* asc.length is checked here too: with no tokens found there are no adjacent
   pairs, and "no pair is too close" would be true of an empty stylesheet. */
check('and no two steps are closer than six per cent',
  asc.length >= 12 && tooClose.length === 0,
  `${asc.length} steps · ${tooClose.map(([a, b]) => `${a.name}/${b.name}`).join(', ')}`);

console.log(`\n  ${new Set([...sizes(app), ...sizes(m)]).size} distinct declarations, ${defined.size} steps`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
