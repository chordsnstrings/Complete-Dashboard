/* tokens.js — the Arkiv colour contract, and the ONE place a colour is defined.
   ═══════════════════════════════════════════════════════════════════════════
   Ported 2026-09-23 from the design's tokens.mjs (scratchpad arkiv-new/) for
   STEP 0 of docs/UI-REDESIGN-PLAN.md §3. SPEC L5.1: colour is defined in
   exactly one place. Everything below is the design's file with the values
   untouched; what was added is marked ADDED and says why.

   HOW THIS FILE REACHES THE PAGE
     bin/gen-tokens-css.mjs writes the custom properties into app.css, between
     the GENERATED markers, and test/tokens.test.mjs fails if that block and
     this file disagree by a byte. Nobody edits the block by hand: edit this
     file, then run `node bin/gen-tokens-css.mjs`.

     The Arkiv values are written under :root[data-skin="arkiv"], NOT under a
     bare :root, because five of their names (--paper, --paper-2, --ink,
     --grey and the six --c-*) are also names the old skin paints with its own
     values, and production keeps the old look until the operator flips it.
     STEP 1 stamps data-skin="arkiv" before first paint (like data-zen and
     data-ui); until then every value here is inert on production.

   WHERE THE VALUES CAME FROM, so the next reader does not redo it.
     The design's original gen2/tokens.mjs did not survive. tokens.mjs was a
     reconstruction transcribed from what the built mockups EMIT: every C-*.html
     page carries the generated :root inline, and all 65 of them (44 in
     arkiv/arkiv-pages, 21 in arkiv-new) carry ONE byte-identical block —

       $ for f in C-*.html; do grep -o '<style>:root{[^<]*}</style>' "$f" \
           | md5sum; done | sort -u
       b46907d2df65aa93a6011cc73d370a2b          ← measured 2026-09-23, 65 of 65

     — and cssTokens() below reproduces that block byte for byte (the same
     md5, asserted in test/tokens.test.mjs). So the port changed no value.
     Extracting every distinct hex from the 44 original pages yields exactly
     43 hexes, and this file exports exactly those 43.

   #B32B1C, THE OLD SIGNAL RED, IS RETIRED AND IS NOT A TOKEN. b.css (the
   design's inherited chrome) still declares --signal:#B32B1C and the design's
   generated block redefines --signal to ink so the stale red dies. This app
   never imports b.css (the plan forbids a verbatim import: .cap, .num, .sub
   and a dozen other class names collide), so --signal guards nothing here; it
   is kept so cssTokens() stays the block the mockups carry. Do not use
   --signal as a colour.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── NEUTRALS ────────────────────────────────────────────────────────────
   grey-2 measures 2.90:1 on paper. It FAILS WCAG for text at every size and
   is a RULES-AND-OUTLINES token only (SPEC §3.2, L5.7). Text that would land
   on it moves to `grey` at 5.15:1. It is also the absence outline, which is
   why absence is colourless: an outline that cannot be read as good or bad.

   ink-2 IS NOT THE OLD --ink-2. The old skin's --ink-2 (#5b6165) was
   SECONDARY TEXT; Arkiv's is near-black EMPHASIS (13.54:1). STEP 0 renamed
   every old use away before this one was defined — old --ink-3 → --grey, old
   --ink-2 → --grey-strong (see BRIDGE) — so a var(--ink-2) anywhere now means
   Arkiv's emphasis. test/tokens.test.mjs holds the old names out. */
export const NEUTRAL = Object.freeze({
  paper:  '#FFFFFF',
  paper2: '#F6F6F7',
  ink:    '#0A0A0B',
  ink2:   '#2E2E31',
  grey:   '#6D6D72',
  grey2:  '#97979D',   // 2.90:1 — RULES AND OUTLINES ONLY, never text
  hair:   '#D6D6D9',   // row separators, column rules
  faint:  '#E9E9EB',   // chart grid
  signal: '#0A0A0B',   // RETIRED red, overridden to ink. See the header.
  absOutline: '#97979D' // === grey2, named for its job (SPEC §5 OUTLINE)
});

/* ── THE SIX CHANNEL IDENTITIES ──────────────────────────────────────────
   One colour per channel, everywhere that channel appears — chart fill, line
   stroke, legend swatch, table row marker, tile accent, chip, map pin (L1).
   Bolt is NOT green and Yango is NOT red, and never may be: green and red are
   ceded entirely to meaning. Run F3 in PALETTE-EVIDENCE.md is the whole
   argument — the old Bolt green and the positive green measure CVD ΔE 1.7 and
   normal-vision ΔE 2.4 against each other, which is to say they are the same
   colour to a deuteranope and very nearly the same colour to everyone else. */
export const CHANNEL = Object.freeze({
  uber:   '#2362D3',   // L 0.524 H 261.1 · 5.59:1
  bolt:   '#0398BA',   // L 0.630 H 221.2 · 3.38:1 — direct label mandatory
  yango:  '#B4358A',   // L 0.545 H 343.9 · 5.50:1
  hotel:  '#A38902',   // L 0.635 H  95.5 · 3.42:1 — direct label mandatory
  cabman: '#6B259F',   // L 0.435 H 306.0 · 8.79:1
  fms:    '#9974F5'    // L 0.655 H 293.9 · 3.40:1 — direct label mandatory
});

/* Fixed order. Hues are NEVER cycled by index (L1). */
export const CHANNEL_ORDER = Object.freeze(
  ['uber', 'bolt', 'yango', 'hotel', 'cabman', 'fms']
);

/* ── THE STATE RAMPS ─────────────────────────────────────────────────────
   Three steps at constant OKLCH hue, running LIGHTER from the identity, with
   adjacent dL 0.065. `engaged` IS the identity hex, so a page that shows no
   state is automatically consistent with one that does.

   THE DIRECTION IS THE WHOLE POINT. Darkening ramps were measured and six of
   forty-four channel-step × semantic pairs failed: #594900 Hotel-deep against
   the negative red at CVD ΔE 3.0, #897300 Hotel-mid against the positive green
   at CVD 4.2 / normal 12.7. In OKLab every hue converges toward black as
   chroma collapses, so the dark end of a ramp is exactly where hue dies and a
   channel walks into a semantic. Light-running: 0 failures of 36 (L5.4).

   dL = 0.065 is not a taste. At 0.070 FMS's light end drops to 1.96:1 and
   fails the 2.00 ordinal floor; at 0.062 the adjacent gap sits exactly on the
   0.060 floor with no margin (L5.11). There is no fourth step: offline is the
   absence outline, not a faint amount of online. */
export const RAMP = Object.freeze({
  uber:   Object.freeze({ engaged:'#2362D3', available:'#3777E9', idle:'#4B8BFF' }),
  bolt:   Object.freeze({ engaged:'#0398BA', available:'#30ACCF', idle:'#4BC1E5' }),
  yango:  Object.freeze({ engaged:'#B4358A', available:'#CA4B9E', idle:'#E160B2' }),
  hotel:  Object.freeze({ engaged:'#A38902', available:'#B79D2B', idle:'#CCB244' }),
  cabman: Object.freeze({ engaged:'#6B259F', available:'#7E3BB4', idle:'#9150CA' }),
  fms:    Object.freeze({ engaged:'#9974F5', available:'#AB8EFF', idle:'#BDA9FF' })
});

export const RAMP_STATES = Object.freeze(['engaged', 'available', 'idle']);

/* ── THE WASHES ──────────────────────────────────────────────────────────
   The 14% form of each governing token: chip backgrounds, area fills, and the
   highlight plate (L4). NOT IN SPEC §3.2's TABLE — recovered from the emitted
   :root and confirmed against PALETTE.html's per-channel "Wash" swatch rows.
   The highlight's digits stay ink on all of these; ink on the worst wash
   measures 15.27:1, so an emphasised figure is never harder to read. */
export const WASH = Object.freeze({
  uber:   '#E0E9F9',
  bolt:   '#DCF1F5',
  yango:  '#F5E3EF',
  hotel:  '#F2EEDC',
  cabman: '#EAE0F2',
  fms:    '#F1ECFE',
  positive: '#DBEDE5',
  negative: '#F0DEDE',
  ink:      '#DDDDDD'   // the ink-governed highlight plate
});

/* ── THE SEMANTIC PAIR ───────────────────────────────────────────────────
   Green means better and red means worse, everywhere, without exception (L3).
   Nothing else on any page may be either hue.

   These two hexes and not a prettier pair: they split lightness by 0.089
   (L 0.520 against L 0.431), and that split — not the hue difference — is what
   lifts them to CVD ΔE 8.6 and a pass. A green and a red held at the SAME
   lightness measure CVD ΔE 4.2 and FAIL at every lightness tested (evidence
   E5/E5b). "Make the negative a bit lighter so it looks friendlier" breaks the
   system.

   There is NO AMBER. The operator ruled 2026-09-23 (plan §1.1): a warning is
   the negative red with a HOLLOW dot, critical the same red with a SOLID dot —
   one rule on every page. Severity is a form, not a third hue.

   `neutral` is achromatic on purpose (C 0.008) and carries a bare dash with NO
   sign, so that zero is never mistaken for a small win. */
export const SEMANTIC = Object.freeze({
  positive: '#007E44',   // L 0.520 H 154.0 · 5.16:1 — always with ▲ and a sign
  negative: '#961111',   // L 0.431 H  27.9 · 8.80:1 — always with ▼ and a sign
  neutral:  '#6D6D72'    // === NEUTRAL.grey — a dash, no sign
});

/* The reserved hue bands. A channel hex may not sit inside one; a semantic hex
   must. THIS IS THE CHEAP CHECK, NOT THE GUARANTEE (SPEC §3A.1) — Yango sits
   only 0.9–1.2° outside the red edge and is legal, and what actually proves it
   safe is the measured pair separation (Yango × negative, CVD ΔE 16.3 /
   normal 17.5). Run both, always. */
export const RESERVED_HUE = Object.freeze([
  Object.freeze({ name:'green', from:115, to:180 }),
  Object.freeze({ name:'red',   from:345, to:58  })   // wraps through 0
]);

/* ── THE SEQUENTIAL RAMP ─────────────────────────────────────────────────
   For ordered, non-categorical quantity — heat cells, density, rank. Graphite,
   carrying no hue at all (C ≤ 0.020), so it can never be mistaken for a
   channel or for a judgement. A green cell in a density map would read as good
   news about density, which is not a thing. */
export const SEQUENTIAL = Object.freeze([
  '#ACB0B7', '#878E9A', '#676E79', '#4A4F57', '#2D323A', '#13171F'
]);

/* ── THE FORM TOKENS ─────────────────────────────────────────────────────
   Emphasis is a colourless FORM (L4/L5): a wash, a 3px rule inset to the
   figure's width, one weight step — with the digits staying ink. These are the
   non-colour half of the generated block. */
export const FORM = Object.freeze({
  hlWeight: '600',
  hlRuleW:  '3px',
  hlPadX:   '8px',
  hlRadius: '3px',
  markRow:  '3px'       // the 3px table row marker, in the gutter
});

/* ── ADDED: THE BRIDGE FROM THE OLD SKIN ─────────────────────────────────
   Transitional, and deleted with the old stylesheet one release after the
   flip (plan §3, STEP 5).

   The --ink-2 collision could not be resolved into ONE name without changing
   the old look: the old skin prints secondary text in two greys (#5b6165 and
   #8b9095, and #a9afb5 / #7b8288 in dark), and Arkiv prints both in one
   (--grey #6D6D72). So STEP 0 renamed old --ink-3 → --grey (the plan's step 1,
   literally) and old --ink-2 → --grey-strong, which the old skin paints its
   darker grey and Arkiv folds onto --grey here. When the old skin is deleted,
   `--grey-strong` → `--grey` is one mechanical rename, and this map goes.

   Each entry: old-skin name → the Arkiv token it resolves to under the skin. */
export const BRIDGE = Object.freeze({
  'grey-strong': 'grey'
});

/* ═══ THE ACCESSORS ══════════════════════════════════════════════════════ */

const ALIAS = Object.freeze({
  uber:'uber',
  bolt:'bolt',
  yango:'yango',
  hotel:'hotel', 'hotel corporate':'hotel', corporate:'hotel',
  cabman:'cabman',
  fms:'fms', infotrack:'fms', 'fms/infotrack':'fms', 'fms / infotrack':'fms'
});

/** Normalise a feed name to a channel key, or null if it is not one of the six. */
export function channelKey(name) {
  if (typeof name !== 'string') return null;
  const k = name.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ALIAS, k) ? ALIAS[k] : null;
}

/* AN UNKNOWN NAME RETURNS NEUTRAL GREY — never a borrowed hue and never the
   first colour in the order. A mislabelled feed must look UNIDENTIFIED, not
   look like Uber. This is a named check in L1, and getting it wrong is silent:
   the page renders, and it renders a lie about whose trips those are.

   Returns a HEX. A caller painting through CSS (so the theme resolves) wants
   the custom property instead — `--c-${channelKey(name)}` — which is what
   ui.js SOURCE_TOKEN names. */
export function channelOf(name) {
  const k = channelKey(name);
  return k ? CHANNEL[k] : NEUTRAL.grey;
}

/* A sub-state of a channel. Unknown channel → neutral grey, same rule as
   channelOf. Unknown state → the identity, because a state we cannot name is
   not a lighter amount of the channel, it is just the channel.
   OFFLINE IS NOT A RAMP STEP and deliberately does not resolve here: offline
   is the absence outline (§5), and a fourth step would push every light end
   under the 2.00 ordinal floor. */
export function stateOf(name, state) {
  const k = channelKey(name);
  if (!k) return NEUTRAL.grey;
  const ramp = RAMP[k];
  return Object.prototype.hasOwnProperty.call(ramp, state) ? ramp[state] : ramp.engaged;
}

/** The 14% wash for a channel, a semantic, or ink. Unknown → the ink wash. */
export function washOf(name) {
  const k = channelKey(name);
  if (k) return WASH[k];
  const n = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (n === 'positive' || n === 'negative') return WASH[n];
  return WASH.ink;
}

/* The colour follows the MEANING, never the arithmetic sign (L3). A measure
   where down is good — cancellations, unauthorized trips, cost per km — passes
   {invert:true} and gets a GREEN down-arrow. A rise in cancellations is never
   green. Returns null for a figure that could not be measured: absence is not
   no-change, and it is certainly not zero. */
export function semanticOf(delta, { invert = false } = {}) {
  if (delta == null || Number.isNaN(delta)) return null;
  if (delta === 0) return { token: SEMANTIC.neutral, glyph: '–', sign: '', word: 'no change' };
  const better = invert ? delta < 0 : delta > 0;
  return better
    ? { token: SEMANTIC.positive, glyph: '▲', sign: '+', word: 'better' }
    : { token: SEMANTIC.negative, glyph: '▼', sign: '−', word: 'worse' };
}

/* A step of the graphite ramp. Takes a fraction 0..1 of the measured range and
   returns the step. A cell with NO READING does not come here at all — it is
   the absence outline (§5), because a pale fill reads as a small value and
   "not measured" is not a small value. */
export function sequentialOf(t) {
  if (t == null || Number.isNaN(t)) return null;      // absence, not step 0
  const f = Math.max(0, Math.min(1, t));
  return SEQUENTIAL[Math.round(f * (SEQUENTIAL.length - 1))];
}

/** Every hex this file governs. The page-level L1 grep checks against this. */
export function allTokenHexes() {
  const out = new Set();
  for (const v of Object.values(NEUTRAL)) out.add(v.toUpperCase());
  for (const v of Object.values(CHANNEL)) out.add(v.toUpperCase());
  for (const r of Object.values(RAMP)) for (const v of Object.values(r)) out.add(v.toUpperCase());
  for (const v of Object.values(WASH)) out.add(v.toUpperCase());
  for (const v of Object.values(SEMANTIC)) out.add(v.toUpperCase());
  for (const v of SEQUENTIAL) out.add(v.toUpperCase());
  return out;
}

/* ADDED: the declarations as a list, in the design's order, so the generator
   can lay them out one per line in app.css and the test can compare them one
   by one. cssTokens() is built from the same list, so the two cannot drift. */
export function cssDeclarations() {
  const p = [
    `--paper:${NEUTRAL.paper}`, `--paper-2:${NEUTRAL.paper2}`,
    `--ink:${NEUTRAL.ink}`, `--ink-2:${NEUTRAL.ink2}`,
    `--grey:${NEUTRAL.grey}`, `--grey-2:${NEUTRAL.grey2}`,
    `--hair:${NEUTRAL.hair}`, `--faint:${NEUTRAL.faint}`,
    `--signal:${NEUTRAL.signal}`
  ];
  for (const k of CHANNEL_ORDER) {
    p.push(`--c-${k}:${CHANNEL[k]}`, `--w-${k}:${WASH[k]}`);
    for (const s of RAMP_STATES) p.push(`--c-${k}-${s}:${RAMP[k][s]}`);
  }
  p.push(
    `--sem-pos:${SEMANTIC.positive}`, `--sem-neg:${SEMANTIC.negative}`,
    `--sem-neu:${SEMANTIC.neutral}`,
    `--w-pos:${WASH.positive}`, `--w-neg:${WASH.negative}`, `--w-ink:${WASH.ink}`
  );
  SEQUENTIAL.forEach((h, i) => p.push(`--seq-${i}:${h}`));
  p.push(
    `--abs-outline:${NEUTRAL.absOutline}`,
    `--hl-weight:${FORM.hlWeight}`, `--hl-rule-w:${FORM.hlRuleW}`,
    `--hl-pad-x:${FORM.hlPadX}`, `--hl-radius:${FORM.hlRadius}`,
    `--mark-row:${FORM.markRow}`
  );
  return p;
}

/* ADDED: the old-skin names Arkiv repaints, as declarations (see BRIDGE). */
export function bridgeDeclarations() {
  return Object.entries(BRIDGE).map(([from, to]) => `--${from}:var(--${to})`);
}

/* The generated :root block, byte-for-byte as the mockups carry it. */
export function cssTokens() {
  return `:root{${cssDeclarations().join(';')}}`;
}

/* ═══ THE LAW, AS A SCRIPT ═══════════════════════════════════════════════
   lintTokens() checks the TOKEN FILE. It returns [] when clean. It does not
   and cannot check a page — the page-level clauses (no hex outside this file,
   no semantic as an area fill, no channel on a delta chip, ≤3 highlights) are
   checks over rendered pages, and belong to bin/render-audit.mjs (plan §3,
   STEP 3). */

const RGB = h => [1,3,5].map(i => parseInt(h.slice(i, i+2), 16) / 255);
const LIN = c => c <= 0.04045 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4);

/** sRGB hex → OKLCH. Björn Ottosson's matrices, unmodified. */
export function oklch(hex) {
  const [r, g, b] = RGB(hex.toUpperCase()).map(LIN);
  const l = Math.cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b);
  const m = Math.cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b);
  const s = Math.cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b);
  const L = 0.2104542553*l + 0.7936177850*m - 0.0040720468*s;
  const A = 1.9779984951*l - 2.4285922050*m + 0.4505937099*s;
  const B = 0.0259040371*l + 0.7827717662*m - 0.8086757660*s;
  let H = Math.atan2(B, A) * 180 / Math.PI;
  if (H < 0) H += 360;
  return { L, C: Math.hypot(A, B), H };
}

/** WCAG contrast against paper by default. */
export function contrast(hex, other = NEUTRAL.paper) {
  const rl = h => { const [r,g,b] = RGB(h.toUpperCase()).map(LIN);
                    return 0.2126*r + 0.7152*g + 0.0722*b; };
  const a = rl(hex), b = rl(other);
  return (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
}

/** Is this hue inside a band reserved for meaning? */
export function isReservedHue(H) {
  return RESERVED_HUE.some(b => b.from > b.to ? (H >= b.from || H <= b.to)
                                              : (H >= b.from && H <= b.to));
}

const hueSpread = hs => {           // smallest arc covering the hues, degrees
  let worst = 0;
  for (let i = 0; i < hs.length; i++) for (let j = i+1; j < hs.length; j++) {
    const d = Math.abs(hs[i] - hs[j]);
    worst = Math.max(worst, Math.min(d, 360 - d));
  }
  return worst;
};

export function lintTokens() {
  const v = [];
  const HEX = /^#[0-9A-F]{6}$/;

  // L1 — the exports are well-formed, the order is the six, nothing is missing.
  for (const [k, h] of Object.entries(CHANNEL))
    if (!HEX.test(h)) v.push(`L1 CHANNEL.${k} is not a 6-digit upper hex: ${h}`);
  if (CHANNEL_ORDER.length !== 6) v.push(`L1 CHANNEL_ORDER has ${CHANNEL_ORDER.length} entries, not 6`);
  for (const k of CHANNEL_ORDER) {
    if (!CHANNEL[k])  v.push(`L1 CHANNEL_ORDER names "${k}" but CHANNEL has no such channel`);
    if (!RAMP[k])     v.push(`L2 no RAMP for channel "${k}"`);
    if (!WASH[k])     v.push(`L4 no WASH for channel "${k}"`);
  }
  if (Object.keys(CHANNEL).length !== CHANNEL_ORDER.length)
    v.push('L5.10 CHANNEL and CHANNEL_ORDER disagree — there is no seventh channel');
  if (channelOf('not-a-feed') !== NEUTRAL.grey)
    v.push('L1 channelOf(unknown) must return NEUTRAL.grey, not a borrowed hue');
  if (channelOf('not-a-feed') === CHANNEL[CHANNEL_ORDER[0]])
    v.push('L1 channelOf(unknown) is returning the first colour in the order');
  if (stateOf('not-a-feed', 'engaged') !== NEUTRAL.grey)
    v.push('L1 stateOf(unknown, …) must return NEUTRAL.grey');

  // L1 — a channel hex may never sit in a hue band reserved for meaning.
  for (const [k, h] of Object.entries(CHANNEL)) {
    const { H } = oklch(h);
    if (isReservedHue(H)) v.push(`L1 CHANNEL.${k} ${h} sits in a reserved hue band (H ${H.toFixed(1)})`);
  }

  // L2 — every ramp: constant hue, monotone, running LIGHT, dL ≥ 0.060,
  //      and engaged === the identity.
  for (const k of CHANNEL_ORDER) {
    const r = RAMP[k], steps = RAMP_STATES.map(s => r[s]);
    if (r.engaged !== CHANNEL[k])
      v.push(`L2 RAMP.${k}.engaged ${r.engaged} !== CHANNEL.${k} ${CHANNEL[k]}`);
    const o = steps.map(oklch);
    const spread = hueSpread(o.map(x => x.H));
    if (spread > 1) v.push(`L2 RAMP.${k} hue spread ${spread.toFixed(2)}° exceeds 1°`);
    for (let i = 1; i < o.length; i++) {
      const dL = o[i].L - o[i-1].L;
      if (dL <= 0) v.push(`L5.4 RAMP.${k} step ${RAMP_STATES[i]} darkens past ${RAMP_STATES[i-1]} (dL ${dL.toFixed(3)})`);
      else if (dL < 0.060) v.push(`L2 RAMP.${k} adjacent dL ${dL.toFixed(3)} below the 0.060 floor`);
    }
    for (const [i, h] of steps.entries()) {
      const { H } = oklch(h);
      if (isReservedHue(H)) v.push(`L1 RAMP.${k}.${RAMP_STATES[i]} ${h} sits in a reserved hue band`);
    }
  }

  // L3 — each semantic MUST sit in its reserved band, and only those two may.
  for (const key of ['positive', 'negative']) {
    const { H } = oklch(SEMANTIC[key]);
    if (!isReservedHue(H)) v.push(`L3 SEMANTIC.${key} ${SEMANTIC[key]} is outside the reserved bands (H ${H.toFixed(1)})`);
  }
  if (SEMANTIC.neutral !== NEUTRAL.grey)
    v.push('L3 SEMANTIC.neutral must be the achromatic grey, so zero cannot read as a small win');
  if (oklch(SEMANTIC.neutral).C > 0.05)
    v.push(`L3 SEMANTIC.neutral is not achromatic (C ${oklch(SEMANTIC.neutral).C.toFixed(3)})`);

  // Neutrals and the sequential ramp carry no hue that could read as either.
  for (const h of [...SEQUENTIAL, ...Object.values(NEUTRAL)]) {
    const { C } = oklch(h);
    if (C > 0.05) v.push(`L3 neutral/sequential ${h} carries chroma ${C.toFixed(3)} — it could read as a channel`);
  }
  for (let i = 1; i < SEQUENTIAL.length; i++)
    if (oklch(SEQUENTIAL[i]).L >= oklch(SEQUENTIAL[i-1]).L)
      v.push(`SEQUENTIAL is not monotone at step ${i}`);

  // L5.7 — grey-2 is a rules-and-outlines token. If it ever cleared 4.5:1 the
  //        comment above it would have to change; assert it has not.
  if (contrast(NEUTRAL.grey2) >= 4.5)
    v.push('L5.7 grey-2 now clears 4.5:1 — the rules-and-outlines restriction needs re-deriving');

  // The retired red is not a token, under any key.
  for (const [group, obj] of [['NEUTRAL', NEUTRAL], ['CHANNEL', CHANNEL], ['SEMANTIC', SEMANTIC], ['WASH', WASH]])
    for (const [k, h] of Object.entries(obj))
      if (String(h).toUpperCase() === '#B32B1C') v.push(`${group}.${k} is the RETIRED signal red #B32B1C`);
  if (SEQUENTIAL.some(h => h.toUpperCase() === '#B32B1C')) v.push('SEQUENTIAL carries the retired red');
  if (NEUTRAL.signal !== NEUTRAL.ink)
    v.push('--signal must be redefined to ink, or b.css\'s retired red returns on the nav underline');

  // ADDED — the bridge may only point at a token this file emits, or the old
  //         name resolves to nothing under the skin and paints the default.
  const emitted = new Set(cssDeclarations().map((d) => d.slice(2, d.indexOf(':'))));
  for (const [from, to] of Object.entries(BRIDGE)) {
    if (!emitted.has(to)) v.push(`BRIDGE --${from} points at --${to}, which this file does not emit`);
    if (emitted.has(from)) v.push(`BRIDGE --${from} is itself an Arkiv token — it would be declared twice`);
  }

  return v;
}

export default {
  CHANNEL, CHANNEL_ORDER, RAMP, RAMP_STATES, WASH, SEMANTIC, SEQUENTIAL,
  NEUTRAL, FORM, RESERVED_HUE, BRIDGE,
  channelOf, channelKey, stateOf, washOf, semanticOf, sequentialOf,
  allTokenHexes, cssDeclarations, bridgeDeclarations, cssTokens,
  oklch, contrast, isReservedHue, lintTokens
};
