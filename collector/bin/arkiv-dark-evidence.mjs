#!/usr/bin/env node
/* Reprints the measured half of docs/ARKIV-DARK.md from api/public/tokens.js.
   ─────────────────────────────────────────────────────────────────────────
   The design's PALETTE-EVIDENCE.md was a paste of validator runs, and nothing
   in the repository could re-run it. tokens.js now carries a port of the
   validator's measures (OKLab ΔE ×100, Machado 2009 colour-blindness at
   severity 1.0), and test/tokens.test.mjs holds every dark value to its gate.
   This prints the same numbers as tables, so the evidence file can be
   refreshed after a token changes instead of being re-derived by hand:

     node bin/arkiv-dark-evidence.mjs            # both themes
     node bin/arkiv-dark-evidence.mjs dark       # one

   What it cannot reprint is the validator's own output (the A/B/E runs in
   the evidence file): that script ships with the dataviz skill, outside the
   repository. The command lines to rerun it are in docs/ARKIV-DARK.md. */
import * as T from '../api/public/tokens.js';

/* OKLCH → hex, reducing chroma (never hue, never lightness) until it is in
   sRGB. Only used for the measured alternative: a ramp run the other way. */
function lch2hex(L, C, H) {
  const rad = H * Math.PI / 180;
  const lin = (c) => {
    const a = c * Math.cos(rad), b = c * Math.sin(rad);
    const l = (L + 0.3963377774*a + 0.2158037573*b) ** 3, m = (L - 0.1055613458*a - 0.0638541728*b) ** 3,
      s = (L - 0.0894841775*a - 1.2914855480*b) ** 3;
    return [4.0767416621*l - 3.3077115913*m + 0.2309699292*s, -1.2684380046*l + 2.6097574011*m - 0.3413193965*s,
      -0.0041960863*l - 0.7034186147*m + 1.7076147010*s];
  };
  const ok = (rgb) => rgb.every((x) => x >= -1e-7 && x <= 1 + 1e-7);
  let lo = 0, hi = C;
  if (!ok(lin(C))) { for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (ok(lin(mid))) lo = mid; else hi = mid; } C = lo; }
  const enc = (c) => { c = Math.max(0, Math.min(1, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
  return '#' + lin(C).map((c) => Math.round(enc(c) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

const f2 = (x) => x.toFixed(2), f1 = (x) => x.toFixed(1);
const pairs = (xs) => xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b]));

for (const theme of process.argv[2] ? [process.argv[2]] : ['light', 'dark']) {
  const t = T.THEMES[theme], N = t.NEUTRAL, P = N.paper;
  console.log(`\n══ ${theme.toUpperCase()} — paper ${P} ══`);
  console.log('\nContrast (WCAG) — text needs 4.5, a mark 3, an ordinal step 2');
  for (const [n, h] of [['ink', N.ink], ['ink-2', N.ink2], ['grey', N.grey], ['grey-2', N.grey2], ['hair', N.hair],
    ['faint', N.faint], ['paper-2', N.paper2], ['sem-pos', t.SEMANTIC.positive], ['sem-neg', t.SEMANTIC.negative]])
    console.log(`  --${n.padEnd(8)} ${h}  ${f2(T.contrast(h, P)).padStart(6)}:1 on paper  ${f2(T.contrast(h, N.paper2)).padStart(6)}:1 on paper-2`);
  for (const k of T.CHANNEL_ORDER) {
    const o = T.oklch(t.CHANNEL[k]), on = T.ON_CHANNEL[theme][k];
    console.log(`  --c-${k.padEnd(7)} ${t.CHANNEL[k]}  ${f2(T.contrast(t.CHANNEL[k], P)).padStart(6)}:1  L ${o.L.toFixed(3)} C ${o.C.toFixed(3)} H ${o.H.toFixed(1).padStart(5)}  label ${on} ${f2(T.contrast(N[on], t.CHANNEL[k]))}:1  ramp ${T.RAMP_STATES.map((s) => t.RAMP[k][s]).join(' ')}`);
  }
  console.log(`  graphite ${t.SEQUENTIAL.map((h) => `${h} ${f2(T.contrast(h, P))}`).join('  ')}`);
  console.log(`  washes (${Math.round(T.WASH_ALPHA[theme] * 100)}%) ${Object.entries(t.WASH).map(([k, w]) => `${k} ${w} ink ${f2(T.contrast(N.ink, w))}`).join(' · ')}`);
  console.log(`  hatch at ${T.HATCH[theme]}: ${T.CHANNEL_ORDER.map((k) => `${k} ${f2(T.contrast(T.mixHex(P, t.CHANNEL[k], T.HATCH[theme]), P))}`).join(' ')}`);

  const ch = T.CHANNEL_ORDER.map((k) => [k, t.CHANNEL[k]]);
  const sem = [['positive', t.SEMANTIC.positive], ['negative', t.SEMANTIC.negative]];
  const worst = (ps, fn) => ps.map(([[a, x], [b, y]]) => [`${a} × ${b}`, fn(x, y)]).sort((p, q) => p[1] - q[1])[0];
  console.log('\nColour blindness (OKLab ΔE ×100; CVD = min of protan and deutan; target 8, floor 6, normal 15)');
  const adj = ch.slice(1).map((c, i) => [ch[i], c]);
  for (const [run, ps] of [['A1 channels, adjacent', adj], ['A2 channels, all pairs', pairs(ch)],
    ['A3 the semantic pair', pairs(sem)], ['A4 channels + semantics, all pairs', pairs([...ch, ...sem])]]) {
    const c = worst(ps, T.cvdSeparation), n = worst(ps, (x, y) => T.deltaE(x, y)), tr = worst(ps, (x, y) => T.deltaE(x, y, 'tritan'));
    console.log(`  ${run.padEnd(36)} CVD ${f1(c[1]).padStart(5)} (${c[0]})  normal ${f1(n[1]).padStart(5)} (${n[0]})  tritan ${f1(tr[1]).padStart(5)} (${tr[0]})`);
  }
  for (const dir of [1, -1]) {
    const rows = [];
    for (const k of T.CHANNEL_ORDER) {
      const o = T.oklch(t.CHANNEL[k]);
      const steps = dir === 1 ? T.RAMP_STATES.map((s) => t.RAMP[k][s]) : [0, 1, 2].map((i) => lch2hex(o.L - i * 0.065, o.C, o.H));
      steps.forEach((h, i) => sem.forEach(([m, hm]) => rows.push([`${k}.s${i} ${h} × ${m}`, T.cvdSeparation(h, hm), T.deltaE(h, hm), T.contrast(h, P)])));
    }
    rows.sort((a, b) => a[1] - b[1]);
    const bad = rows.filter((r) => r[1] < T.CVD_GATE[theme].collision || r[2] < 15 || r[3] < 2);
    console.log(`  C${dir === 1 ? '2' : '1'} ramp steps ${dir === 1 ? 'LIGHTER' : 'toward the PAPER'} × semantics: ${bad.length} of ${rows.length} fail`
      + ` (gate CVD ${T.CVD_GATE[theme].collision}, normal 15, step 2:1); worst CVD ${f2(rows[0][1])} ${rows[0][0]}; worst normal ${f2(Math.min(...rows.map((r) => r[2])))}; faintest step ${f2(Math.min(...rows.map((r) => r[3])))}:1`);
  }
}
const v = T.lintTokens();
console.log(`\nlintTokens(): ${v.length ? v.join('\n  ') : '[] — clean, both themes'}`);
process.exit(v.length ? 1 : 0);
