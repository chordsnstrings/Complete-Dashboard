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

   THE DARK SET (ADDED 2026-09-23, the operator's ruling 3). The design is
   light only. Every token below has a dark value in the "THE DARK SET"
   section, solved and measured the way the design's PALETTE-EVIDENCE.md
   solved light, and written up in docs/ARKIV-DARK.md with every validator
   run verbatim. The generator writes the dark values under the existing
   theme mechanism, and only under the skin. lintTokens() now checks BOTH
   themes, including the contrast and colour-blindness gates the evidence
   file used to hold alone, so a dark value that falls below its threshold
   fails test/tokens.test.mjs.
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

/* ── ADDED: THE MARK FORM (SPEC §4 and §5) ───────────────────────────────
   STEP 2 of docs/UI-REDESIGN-PLAN.md §3. The design's mark specs, as the
   numbers and words charts.js draws with. The generator writes them into the
   Arkiv block as --mk-*; the old skin declares its own --mk-* in app.css
   (today's forms: rx 3 on all four corners, a 96px ceiling, the hatched void,
   the hollow bar), and charts.js markForm() reads whichever is in force. So
   one piece of chart code draws both skins, and the old one does not move.

   These are FORMS, not colours: they do not change with the theme and are
   written once, in the light block.

     fit        1 = draw at the measured box, so a --t1 tick is 9.4px and a
                24px bar is 24px wherever the chart lands (SPEC §4 is in px).
     max        a bar is at most 24px thick.
     end, base  4px rounded at the DATA end, square at the baseline.
     gap        a 2px surface gap between touching marks, never a stroke.
     steps      the graphite ramp has six steps (SEQUENTIAL above).
     absent     not measured is an OUTLINE: 1px grey-2, no fill, same end.
     unfinished a part-period (today, a clipped week) is a HATCH in the
                series' own colour — it is being measured, it is not absent.
     projected  a projection is a HATCH too (SPEC §5).
     behind     a second measure drawn behind a bar (telematics journeys
                behind bookings, the fleet median behind a driver) is a WASH,
                the series' colour at 14%. The old skin outlines it; under
                SPEC §5 an outline means "not measured", which it is not.
   The hatch itself is 45°, a 4px pitch, 1px lines at --hatch-a (HATCH above)
   over the paper; charts.js draws it from these. */
export const MARK = Object.freeze({
  fit: '1',
  max: '24',
  end: '4',
  base: '0',
  gap: '2',
  steps: String(SEQUENTIAL.length),
  absent: 'outline',
  unfinished: 'hatch',
  projected: 'hatch',
  behind: 'wash',
  hatchPitch: '4',
  hatchAngle: '45'
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

/* ══ ADDED: THE DARK SET ═════════════════════════════════════════════════
   The operator's ruling 3 (docs/UI-REDESIGN-PLAN.md §1): "design a dark mode
   FOR THE NEW UI", with dark values for every neutral, channel identity,
   wash, ramp, semantic and hatch. Each value is validated the way the
   design's PALETTE-EVIDENCE.md validated light: WCAG contrast against the
   dark paper, and the dataviz validator's colour-blindness separation between
   channel colours, rerun with --mode dark --surface #111113. Every run is in
   docs/ARKIV-DARK.md, verbatim. lintTokens() below re-derives each gate from
   these values, so the evidence file and this file cannot drift apart.

   WHY DARK IS A SOLVE AND NOT AN INVERSION. The light identities cannot be
   reused on a dark ground. CABMAN #6B259F measures 2.15:1 on #111113 and the
   negative #961111 measures 2.14:1, both under the 3:1 a mark needs, and both
   sit under the validator's dark lightness band (L 0.48–0.67) — evidence E1.
   The band is also narrower on dark (0.19 of L, against 0.34 on light), so
   eight colours have less room, and the semantics have the least: they colour
   delta TEXT, so they need 4.5:1, which on this paper means L ≳ 0.57. They
   are pushed to the top of the band, which is exactly where Hotel's gold sits
   under deuteranopia. Hotel × negative is therefore the one pair that
   cannot reach the 8.0 target in dark (see "WHAT DARK DOES NOT REACH").

   The paper is a near-black with Arkiv's faint cool cast (hue 286, the hue of
   the light greys), not pure black: #111113. Every neutral was stepped to
   mirror its light twin's contrast against its paper — paper-2 1.10 (light
   1.08), faint 1.23 (1.21), hair 1.50 (1.45), grey 5.71 (5.15), ink-2 12.50
   (13.54), ink 16.56 (19.79).

   grey-2 IS STILL A RULES-AND-OUTLINES TOKEN. It measures 3.40:1 on the dark
   paper: enough for a mark (≥ 3:1, so the absence outline reads), still
   under the 4.5:1 of text, and lintTokens() keeps it there. The light grey-2
   is 2.90:1, as the design approved it. */
export const NEUTRAL_DARK = Object.freeze({
  paper:  '#111113',
  paper2: '#1B1B1D',
  ink:    '#F0F0F1',
  ink2:   '#D2D2D5',
  grey:   '#8D8D92',   // 5.71:1 on paper, 5.21:1 on paper-2
  grey2:  '#68686D',   // 3.40:1 — RULES AND OUTLINES ONLY, never text
  hair:   '#333336',
  faint:  '#252527',
  signal: '#F0F0F1',   // the retired red, still overridden to ink
  absOutline: '#68686D' // === grey2: the outline absence mark, ≥ 3:1
});

/* The six identities on dark. SAME HUE as light, within 2.3° (one colour per
   channel, L1: a reader learns it once), re-stepped in lightness and chroma
   for the dark band. Solved, not picked: the constraints are the validator's
   gates, and the search is recorded in docs/ARKIV-DARK.md.

   UBER IS THE MUTED ONE, AND THAT IS A TRADE, MADE ON PURPOSE. Uber, CABMAN
   and FMS are all blue-violet. To a deuteranope or protanope they differ only
   in lightness and saturation, and the dark band is too narrow to separate
   three of them on lightness alone, so one has to give up saturation. The
   alternative that kept Uber vivid (#0957D8) muted FMS instead, and passed
   the all-pairs run by 0.05 with a normal-vision floor of exactly 15.0 and a
   tritan floor of 8.0 (evidence E2). This set passes at CVD 8.1, normal 15.4
   and tritan 10.9. Uber carries 91% of the work, so a calmer Uber also keeps
   the dark page from reading as a wall of blue.

   The label on a fill (the dominance bar prints its name and share inside
   the segment): Uber, Yango and CABMAN carry INK (5.01, 5.04, 5.31:1); Bolt,
   Hotel and FMS carry PAPER (6.45, 6.29, 5.82:1). Light text on the deeper
   three and dark text on the lighter three, the same as light mode; the
   token NAMES swap because paper and ink swapped. ON_CHANNEL records it. */
export const CHANNEL_DARK = Object.freeze({
  uber:   '#4366A5',   // L 0.514 C 0.108 H 261.4 · 3.31:1
  bolt:   '#2EA3C7',   // L 0.668 C 0.112 H 223.4 · 6.45:1
  yango:  '#BE118E',   // L 0.540 C 0.223 H 343.9 · 3.29:1
  hotel:  '#B29200',   // L 0.670 C 0.137 H  93.2 · 6.29:1
  cabman: '#8D2CD7',   // L 0.529 C 0.240 H 304.8 · 3.12:1
  fms:    '#9C78FA'    // L 0.667 C 0.186 H 293.5 · 5.82:1
});

/* The ramps on dark run LIGHTER from the identity, dL 0.065, constant hue and
   chroma (clipped to sRGB), exactly as the light law says (L2, L5.4). The
   direction was measured both ways against the dark semantics, not assumed
   (docs/ARKIV-DARK.md, C1 and C2). Running toward the paper fails 6 of 36
   step × semantic pairs — Hotel's darker steps turn olive and meet the
   negative red at CVD 3.1, the very failure the light law was written
   against — and drops three steps under the 2:1 ordinal floor. Running
   lighter: 2 of 36 under the 8.0 target (Hotel × negative 7.0 and Yango ×
   positive 7.9, both identities, both in run A4), none under the 7.0 gate,
   normal-vision 15.6 at worst. On dark, lighter also means MORE contrast,
   so idle is the brightest step; the ramp is read by its legend, and its
   order is the one the law fixes. */
export const RAMP_DARK = Object.freeze({
  uber:   Object.freeze({ engaged:'#4366A5', available:'#5579BA', idle:'#688DCF' }),
  bolt:   Object.freeze({ engaged:'#2EA3C7', available:'#48B8DC', idle:'#60CDF2' }),
  yango:  Object.freeze({ engaged:'#BE118E', available:'#D532A2', idle:'#EC4BB7' }),
  hotel:  Object.freeze({ engaged:'#B29200', available:'#C7A62C', idle:'#DCBB47' }),
  cabman: Object.freeze({ engaged:'#8D2CD7', available:'#A146EE', idle:'#B361FF' }),
  fms:    Object.freeze({ engaged:'#9C78FA', available:'#AE93FF', idle:'#C0AFFF' })
});

/* The washes on dark: the same 14% form, laid over the dark paper instead of
   white. WASH_ALPHA is the rule in both themes, and lintTokens() re-derives
   every wash from it, in both themes. 14% was measured, not carried over:
   its mean OKLab distance from the dark paper is 7.9, against 7.4 on light,
   so a chip reads as clearly on either ground. Ink on the worst dark wash is
   11.56:1 (the ink plate). */
export const WASH_ALPHA = Object.freeze({ light: 0.14, dark: 0.14 });
export const WASH_DARK = Object.freeze({
  uber:   '#181D27',
  bolt:   '#15252C',
  yango:  '#291124',
  hotel:  '#282310',
  cabman: '#22152E',
  fms:    '#241F33',
  positive: '#0F231E',
  negative: '#2D1A1A',
  ink:      '#303032'
});

/* The semantic pair on dark. Both colour delta text, so both clear 4.5:1 on
   the dark paper (4.52 and 4.57). The negative keeps the light hue (28.3°,
   light 27.9°). The positive moved 7.7° inside the green band, to 161.7°:
   at the light hue 154° and the same lightness the PAIR itself measures CVD
   6.8, under the target, and each degree toward teal pulls it apart under
   deuteranopia (7.2 at 156°, 7.7 at 160°, 8.1 here). The price is paid by
   Yango × positive, which falls from 9.6 to 7.9 — a channel against a
   semantic, where the semantic always carries its glyph and sign (run A4). */
export const SEMANTIC_DARK = Object.freeze({
  positive: '#008E60',   // L 0.571 H 161.7 · 4.52:1 — always with ▲ and a sign
  negative: '#D65044',   // L 0.609 H  28.3 · 4.57:1 — always with ▼ and a sign
  neutral:  '#8D8D92'    // === NEUTRAL_DARK.grey — a dash, no sign
});

/* The graphite ramp on dark, anchor FLIPPED: step 0 is the one nearest the
   paper (2.22:1, the ordinal floor is 2.0) and step 5 the farthest (14.91:1),
   so a larger quantity is still the stronger mark, as it is on white
   (light step 0 is 2.18:1, step 5 17.95:1). Same hue as light (≈261), same
   chroma (≤ 0.017), dL 0.10. arkiv.css's --s1..--s8 and --b100..--b700
   point at steps by index, so they flip with it and keep their meaning. */
export const SEQUENTIAL_DARK = Object.freeze([
  '#484D56', '#646972', '#818690', '#9FA5AF', '#BEC4CF', '#DFE5F0'
]);

/* THE HATCH (SPEC §5: a projection or an unfinished period, in the mark's
   OWN colour at 45%, 45°, 4px pitch). It has no hex of its own; it has an
   opacity, and the opacity is theme-dependent, because 45% of a mid-light
   colour over near-black is fainter than 45% of it over white: Uber's and
   Yango's hatch lines would measure 1.52 and 1.49:1 on the dark paper
   against a weakest light line of 1.65:1. 0.53 is the least opacity at which
   every dark hatch line is at least as strong as the weakest light one
   (1.66:1). Emitted as --hatch-a; charts.js adopts it with the rest of
   SPEC §5 in STEP 2. The OUTLINE absence mark is absOutline above. */
export const HATCH = Object.freeze({ light: 0.45, dark: 0.53 });

/* ADDED: which ink labels a channel fill. Measured, per theme, as whichever of
   paper and ink clears 4.5:1 on the fill (lintTokens() re-measures it). */
export const ON_CHANNEL = Object.freeze({
  light: Object.freeze({ uber:'paper', bolt:'ink', yango:'paper', hotel:'ink', cabman:'paper', fms:'ink' }),
  dark:  Object.freeze({ uber:'ink', bolt:'paper', yango:'ink', hotel:'paper', cabman:'ink', fms:'paper' })
});

/* The two themes, as one lookup. */
export const THEMES = Object.freeze({
  light: Object.freeze({ NEUTRAL, CHANNEL, RAMP, WASH, SEMANTIC, SEQUENTIAL }),
  dark:  Object.freeze({ NEUTRAL: NEUTRAL_DARK, CHANNEL: CHANNEL_DARK, RAMP: RAMP_DARK,
    WASH: WASH_DARK, SEMANTIC: SEMANTIC_DARK, SEQUENTIAL: SEQUENTIAL_DARK })
});
const T_ = (theme) => {
  if (!Object.prototype.hasOwnProperty.call(THEMES, theme)) throw new Error(`tokens.js: no theme "${theme}"`);
  return THEMES[theme];
};

/* ═══ THE ACCESSORS ══════════════════════════════════════════════════════ */

const ALIAS = Object.freeze({
  uber:'uber',
  bolt:'bolt',
  yango:'yango',
  hotel:'hotel', 'hotel corporate':'hotel', corporate:'hotel',
  cabman:'cabman',
  fms:'fms', infotrack:'fms', 'fms/infotrack':'fms', 'fms / infotrack':'fms',
  /* ADDED (STEP 2): the names ui.js SOURCE_LABEL prints and SOURCE_TOKEN
     keys, so a chart coloured BY NAME from a label a reader sees finds its
     channel. 'FMS telematics' is the label every FMS series carries, and
     uber_fleet is Uber's fleet feed (SOURCE_TOKEN maps it to --c-uber). */
  'fms telematics':'fms', 'uber fleet':'uber', uber_fleet:'uber'
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
   ui.js SOURCE_TOKEN names. A caller that must have a hex (a canvas, a
   Leaflet option) passes the theme it is drawing in: 'light' (the default,
   so every existing call is unchanged) or 'dark'. */
export function channelOf(name, theme = 'light') {
  const k = channelKey(name), t = T_(theme);
  return k ? t.CHANNEL[k] : t.NEUTRAL.grey;
}

/* A sub-state of a channel. Unknown channel → neutral grey, same rule as
   channelOf. Unknown state → the identity, because a state we cannot name is
   not a lighter amount of the channel, it is just the channel.
   OFFLINE IS NOT A RAMP STEP and deliberately does not resolve here: offline
   is the absence outline (§5), and a fourth step would push every light end
   under the 2.00 ordinal floor. */
export function stateOf(name, state, theme = 'light') {
  const k = channelKey(name), t = T_(theme);
  if (!k) return t.NEUTRAL.grey;
  const ramp = t.RAMP[k];
  return Object.prototype.hasOwnProperty.call(ramp, state) ? ramp[state] : ramp.engaged;
}

/** The 14% wash for a channel, a semantic, or ink. Unknown → the ink wash. */
export function washOf(name, theme = 'light') {
  const k = channelKey(name), W = T_(theme).WASH;
  if (k) return W[k];
  const n = typeof name === 'string' ? name.trim().toLowerCase() : '';
  if (n === 'positive' || n === 'negative') return W[n];
  return W.ink;
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
export function sequentialOf(t, theme = 'light') {
  const i = sequentialIndex(t);
  return i == null ? null : T_(theme).SEQUENTIAL[i];
}

/* ADDED (STEP 2): the STEP sequentialOf picks, as an index, so charts.js can
   paint the cell with the matching --seq-N property — a var() follows the theme
   toggle live, a hex would not — and still be the same pick as the accessor.
   Absence is null here too. */
export function sequentialIndex(t, steps = SEQUENTIAL.length) {
  if (t == null || Number.isNaN(t)) return null;      // absence, not step 0
  const f = Math.max(0, Math.min(1, t));
  return Math.round(f * (steps - 1));
}

/** Every hex this file governs. The page-level L1 grep checks against this.
    'light' (the default) is the design's 43; 'dark' the dark set; 'all' both. */
export function allTokenHexes(theme = 'light') {
  const out = new Set();
  for (const name of theme === 'all' ? ['light', 'dark'] : [theme]) {
    const t = T_(name);
    for (const v of Object.values(t.NEUTRAL)) out.add(v.toUpperCase());
    for (const v of Object.values(t.CHANNEL)) out.add(v.toUpperCase());
    for (const r of Object.values(t.RAMP)) for (const v of Object.values(r)) out.add(v.toUpperCase());
    for (const v of Object.values(t.WASH)) out.add(v.toUpperCase());
    for (const v of Object.values(t.SEMANTIC)) out.add(v.toUpperCase());
    for (const v of t.SEQUENTIAL) out.add(v.toUpperCase());
  }
  return out;
}

/* ADDED: the declarations as a list, in the design's order, so the generator
   can lay them out one per line in app.css and the test can compare them one
   by one. cssTokens() is built from the same list, so the two cannot drift. */
export function cssDeclarations(theme = 'light') {
  const { NEUTRAL: N, CHANNEL: C, RAMP: R, WASH: W, SEMANTIC: S, SEQUENTIAL: Q } = T_(theme);
  const p = [
    `--paper:${N.paper}`, `--paper-2:${N.paper2}`,
    `--ink:${N.ink}`, `--ink-2:${N.ink2}`,
    `--grey:${N.grey}`, `--grey-2:${N.grey2}`,
    `--hair:${N.hair}`, `--faint:${N.faint}`,
    `--signal:${N.signal}`
  ];
  for (const k of CHANNEL_ORDER) {
    p.push(`--c-${k}:${C[k]}`, `--w-${k}:${W[k]}`);
    for (const s of RAMP_STATES) p.push(`--c-${k}-${s}:${R[k][s]}`);
  }
  p.push(
    `--sem-pos:${S.positive}`, `--sem-neg:${S.negative}`,
    `--sem-neu:${S.neutral}`,
    `--w-pos:${W.positive}`, `--w-neg:${W.negative}`, `--w-ink:${W.ink}`
  );
  Q.forEach((h, i) => p.push(`--seq-${i}:${h}`));
  p.push(`--abs-outline:${N.absOutline}`);
  /* The form tokens are not colours and do not change with the theme: they
     are declared once, in the light block, which the dark blocks sit on. */
  if (theme === 'light') p.push(
    `--hl-weight:${FORM.hlWeight}`, `--hl-rule-w:${FORM.hlRuleW}`,
    `--hl-pad-x:${FORM.hlPadX}`, `--hl-radius:${FORM.hlRadius}`,
    `--mark-row:${FORM.markRow}`
  );
  return p;
}

/* ADDED (STEP 2): the mark form, as declarations (see MARK). */
export function markDeclarations() {
  const name = { fit: 'fit', max: 'max', end: 'end', base: 'base', gap: 'gap', steps: 'steps',
    absent: 'absent', unfinished: 'unfinished', projected: 'projected', behind: 'behind',
    hatchPitch: 'hatch-pitch', hatchAngle: 'hatch-angle' };
  return Object.entries(MARK).map(([k, v]) => `--mk-${name[k]}:${v}`);
}

/* ADDED: the old-skin names Arkiv repaints, as declarations (see BRIDGE). */
export function bridgeDeclarations() {
  return Object.entries(BRIDGE).map(([from, to]) => `--${from}:var(--${to})`);
}

/* ADDED: the per-theme declarations the design's block does not carry, and
   which the dark mode needs: the hatch opacity (HATCH) and the ink that
   labels each channel fill (ON_CHANNEL), as a reference to --paper or --ink
   so it follows the theme's own values. Kept apart from cssDeclarations() so
   cssTokens() stays the mockups' block byte for byte. */
export function themeDeclarations(theme = 'light') {
  T_(theme);
  return [
    `--hatch-a:${HATCH[theme]}`,
    ...CHANNEL_ORDER.map((k) => `--on-c-${k}:var(--${ON_CHANNEL[theme][k]})`)
  ];
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

/* ── ADDED: THE VALIDATOR'S MEASURES, PORTED ─────────────────────────────
   The design's PALETTE-EVIDENCE.md ran the dataviz skill's validate_palette.js
   by hand, so nothing in the repository re-checked a colour after the fact.
   Its three measures are ported here, unmodified, so lintTokens() can hold
   both themes to the same gates on every test run:
     · colour difference: Euclidean distance in OKLab, ×100;
     · colour blindness: the Machado, Oliveira & Fernandes (2009) matrices at
       severity 1.0, applied in linear RGB and clamped — the simulation the
       validator's thresholds are calibrated to (swapping it for another model
       moves borderline pairs, so it is part of the standard);
     · CVD separation = the lesser of the protan and deutan distances.
   The thresholds are the validator's, and CVD_GATE below says which one
   each run is held to, and why. */
const MACHADO = Object.freeze({
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]
});
const labOfLin = ([r, g, b]) => {
  const l = Math.cbrt(0.4122214708*r + 0.5363325363*g + 0.0514459929*b);
  const m = Math.cbrt(0.2119034982*r + 0.6806995451*g + 0.1073969566*b);
  const s = Math.cbrt(0.0883024619*r + 0.2817188376*g + 0.6299787005*b);
  return [0.2104542553*l + 0.7936177850*m - 0.0040720468*s,
          1.9779984951*l - 2.4285922050*m + 0.4505937099*s,
          0.0259040371*l + 0.7827717662*m - 0.8086757660*s];
};
const simLin = (hex, kind) => {
  const [r, g, b] = RGB(hex.toUpperCase()).map(LIN), M = MACHADO[kind];
  const cl = (c) => Math.max(0, Math.min(1, c));
  return M.map(([x, y, z]) => cl(x*r + y*g + z*b));
};

/** OKLab ΔE ×100 between two hexes; `kind` = 'protan' | 'deutan' | 'tritan'
    simulates that dichromacy first, and no kind is unsimulated vision. */
export function deltaE(a, b, kind) {
  const la = labOfLin(kind ? simLin(a, kind) : RGB(a.toUpperCase()).map(LIN));
  const lb = labOfLin(kind ? simLin(b, kind) : RGB(b.toUpperCase()).map(LIN));
  return 100 * Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

/** The validator's CVD separation: the worse of protanopia and deuteranopia. */
export function cvdSeparation(a, b) {
  return Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan'));
}

/** `fg` laid over `bg` at opacity t, in sRGB, rounded — how a wash is made. */
export function mixHex(bg, fg, t) {
  return '#' + [1, 3, 5].map((i) => Math.round(parseInt(bg.slice(i, i+2), 16) * (1 - t)
    + parseInt(fg.slice(i, i+2), 16) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/* The gates each measured run is held to, per theme. Every number is the
   validator's own threshold except COLLISION on dark, which is a RATCHET:
     · cvd 8.0 — the validator's target; 6.0–8.0 is legal only with secondary
       encoding, under 6.0 is a FAIL.
     · normal 15.0 — the validator's normal-vision floor, a hard gate.
     · text 4.5 / mark 3.0 / ordinal 2.0 — WCAG body text, the validator's
       mark contrast, and its ordinal light-end floor.
   COLLISION is a channel (and every step of its ramp) against a semantic.
   Light clears the target (worst 8.8, Hotel × positive). Dark cannot: the
   semantics colour text, so they must clear 4.5:1 and sit at the top of the
   dark band, where Hotel's gold sits under deuteranopia. The best found in
   the search (docs/ARKIV-DARK.md §E) is 7.04, Hotel × negative, so dark is
   in the validator's WARN band — legal because L3 already gives EVERY
   semantic its glyph and its sign (▲ + / ▼ −) and never lets one be an area
   fill, and SPEC §4 already makes a direct label mandatory on every Hotel
   mark. The gate is 7.0, not the validator's 6.0: a change that makes the
   worst pair worse than what was measured fails, instead of drifting down to
   the legal floor unnoticed. */
export const CVD_GATE = Object.freeze({
  light: Object.freeze({ cvd: 8.0, collision: 8.0, tritan: 8.0, normal: 15.0 }),
  dark:  Object.freeze({ cvd: 8.0, collision: 7.0, tritan: 8.0, normal: 15.0 })
});
/* The validator's lightness band for a categorical colour, per mode. */
export const BAND = Object.freeze({ light: Object.freeze([0.43, 0.77]), dark: Object.freeze([0.48, 0.67]) });

const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/* The measured half of the law, for one theme: contrast, colour blindness,
   the band, the washes, the hatch and the labels. Returns violations. */
export function lintMeasures(theme = 'light') {
  const v = [];
  const { NEUTRAL: N, CHANNEL: C, RAMP: R, WASH: W, SEMANTIC: S, SEQUENTIAL: Q } = T_(theme);
  const G = CVD_GATE[theme], tag = `[${theme}]`;
  const cr = (h, bg = N.paper) => contrast(h, bg);

  // Text: body text needs 4.5:1 on the paper; grey also sits on paper-2
  // (table heads, the hovered row), so it is held there too.
  for (const [name, h] of [['ink', N.ink], ['ink-2', N.ink2], ['grey', N.grey],
    ['sem-pos', S.positive], ['sem-neg', S.negative]])
    if (cr(h) < 4.5) v.push(`${tag} TEXT --${name} ${h} is ${cr(h).toFixed(2)}:1 on paper, under 4.5`);
  if (cr(N.grey, N.paper2) < 4.5)
    v.push(`${tag} TEXT --grey ${N.grey} is ${cr(N.grey, N.paper2).toFixed(2)}:1 on paper-2, under 4.5`);
  // Marks: every identity 3:1. grey-2 stays a rules-only token under 4.5:1,
  // and on dark, where it was solved rather than inherited, it must also
  // read as a mark (the absence outline).
  for (const k of CHANNEL_ORDER)
    if (cr(C[k]) < 3) v.push(`${tag} MARK --c-${k} ${C[k]} is ${cr(C[k]).toFixed(2)}:1 on paper, under 3`);
  if (cr(N.grey2) >= 4.5) v.push(`${tag} L5.7 grey-2 clears 4.5:1 — the rules-and-outlines restriction needs re-deriving`);
  if (theme === 'dark' && cr(N.absOutline) < 3)
    v.push(`${tag} MARK --abs-outline ${N.absOutline} is ${cr(N.absOutline).toFixed(2)}:1, under 3 — absence would not read`);
  // Ordinal: every ramp step and the graphite step nearest the paper 2:1;
  // the graphite ramp grows AWAY from the paper, step by step.
  for (const k of CHANNEL_ORDER) for (const s of RAMP_STATES)
    if (cr(R[k][s]) < 2) v.push(`${tag} ORDINAL --c-${k}-${s} ${R[k][s]} is ${cr(R[k][s]).toFixed(2)}:1, under 2`);
  if (cr(Q[0]) < 2) v.push(`${tag} ORDINAL --seq-0 ${Q[0]} is ${cr(Q[0]).toFixed(2)}:1, under 2`);
  for (let i = 1; i < Q.length; i++) {
    if (cr(Q[i]) <= cr(Q[i-1])) v.push(`${tag} SEQUENTIAL step ${i} is not further from the paper than step ${i-1}`);
    if (Math.abs(oklch(Q[i]).L - oklch(Q[i-1]).L) < 0.06) v.push(`${tag} SEQUENTIAL steps ${i-1}/${i} are under dL 0.06`);
  }
  // The band and the chroma floor, for every categorical colour.
  const [lo, hi] = BAND[theme];
  for (const [name, h] of [...CHANNEL_ORDER.map((k) => [`--c-${k}`, C[k]]),
    ['--sem-pos', S.positive], ['--sem-neg', S.negative]]) {
    const o = oklch(h);
    if (o.L < lo || o.L > hi) v.push(`${tag} BAND ${name} ${h} L ${o.L.toFixed(3)} is outside ${lo}–${hi}`);
    if (o.C < 0.10) v.push(`${tag} BAND ${name} ${h} chroma ${o.C.toFixed(3)} is under 0.10 — it would read as grey`);
  }
  // Washes: each is the WASH_ALPHA form of its token over this theme's
  // paper, ink stays legible on it, and a semantic's dot reads on its own.
  const src = { ...Object.fromEntries(CHANNEL_ORDER.map((k) => [k, C[k]])),
    positive: S.positive, negative: S.negative, ink: N.ink };
  for (const [k, h] of Object.entries(src)) {
    const want = mixHex(N.paper, h, WASH_ALPHA[theme]);
    if (W[k] !== want) v.push(`${tag} WASH.${k} ${W[k]} is not ${Math.round(WASH_ALPHA[theme] * 100)}% of ${h} on paper (${want})`);
    if (cr(N.ink, W[k]) < 4.5) v.push(`${tag} WASH ink on --w-${k} is ${cr(N.ink, W[k]).toFixed(2)}:1, under 4.5`);
  }
  for (const k of ['positive', 'negative'])
    if (cr(S[k], W[k]) < 3) v.push(`${tag} WASH the ${k} dot on its own wash is ${cr(S[k], W[k]).toFixed(2)}:1, under 3`);
  // The label printed inside a channel fill.
  for (const k of CHANNEL_ORDER) {
    const ink = ON_CHANNEL[theme]?.[k] === 'paper' ? N.paper : ON_CHANNEL[theme]?.[k] === 'ink' ? N.ink : null;
    if (!ink) v.push(`${tag} ON_CHANNEL.${k} must be 'paper' or 'ink'`);
    else if (cr(ink, C[k]) < 4.5) v.push(`${tag} LABEL ${ON_CHANNEL[theme][k]} on --c-${k} is ${cr(ink, C[k]).toFixed(2)}:1, under 4.5`);
  }
  // The hatch: on dark, no channel's hatch line may be fainter than the
  // faintest one the design approved on light.
  const hatchMin = (t) => Math.min(...CHANNEL_ORDER.map((k) => {
    const { NEUTRAL: n, CHANNEL: c } = T_(t); return contrast(mixHex(n.paper, c[k], HATCH[t]), n.paper); }));
  if (!(HATCH[theme] > 0 && HATCH[theme] < 1)) v.push(`${tag} HATCH opacity ${HATCH[theme]} is not a fraction`);
  else if (theme === 'dark' && hatchMin('dark') < hatchMin('light'))
    v.push(`${tag} HATCH the faintest dark hatch line is ${hatchMin('dark').toFixed(3)}:1, fainter than light's ${hatchMin('light').toFixed(3)}:1`);

  // Colour blindness, as the evidence runs did.
  const ids = CHANNEL_ORDER.map((k) => [k, C[k]]);
  const sems = [['positive', S.positive], ['negative', S.negative]];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const [a, ha] = ids[i], [b, hb] = ids[j];
    const c = cvdSeparation(ha, hb), t = deltaE(ha, hb, 'tritan');
    if (c < G.cvd) v.push(`${tag} A2 ${a} × ${b} CVD ΔE ${c.toFixed(2)} under ${G.cvd}`);
    if (t < G.tritan) v.push(`${tag} A2 ${a} × ${b} tritan ΔE ${t.toFixed(2)} under ${G.tritan}`);
  }
  const s3 = cvdSeparation(S.positive, S.negative);
  if (s3 < G.cvd) v.push(`${tag} A3 positive × negative CVD ΔE ${s3.toFixed(2)} under ${G.cvd}`);
  const eight = [...ids, ...sems];
  for (let i = 0; i < eight.length; i++) for (let j = i + 1; j < eight.length; j++) {
    const n = deltaE(eight[i][1], eight[j][1]);
    if (n < G.normal) v.push(`${tag} A4 ${eight[i][0]} × ${eight[j][0]} normal-vision ΔE ${n.toFixed(2)} under ${G.normal}`);
  }
  for (const k of CHANNEL_ORDER) for (const s of RAMP_STATES) for (const [m, hm] of sems) {
    const c = cvdSeparation(R[k][s], hm), n = deltaE(R[k][s], hm);
    if (c < G.collision) v.push(`${tag} C2 ${k}.${s} × ${m} CVD ΔE ${c.toFixed(2)} under ${G.collision}`);
    if (n < G.normal) v.push(`${tag} C2 ${k}.${s} × ${m} normal-vision ΔE ${n.toFixed(2)} under ${G.normal}`);
  }
  return v;
}

/* The shape of the dark set: the same keys as light, well-formed, the same
   channel identity by hue, the same laws for ramps, semantics and neutrals. */
function lintDarkShape() {
  const v = [];
  const HEX = /^#[0-9A-F]{6}$/;
  const same = (name, a, b) => { const ka = Object.keys(a).sort().join(), kb = Object.keys(b).sort().join();
    if (ka !== kb) v.push(`DARK ${name} keys ${kb} differ from light's ${ka}`); };
  same('NEUTRAL', NEUTRAL, NEUTRAL_DARK); same('CHANNEL', CHANNEL, CHANNEL_DARK); same('RAMP', RAMP, RAMP_DARK);
  same('WASH', WASH, WASH_DARK); same('SEMANTIC', SEMANTIC, SEMANTIC_DARK);
  if (SEQUENTIAL_DARK.length !== SEQUENTIAL.length) v.push(`DARK SEQUENTIAL has ${SEQUENTIAL_DARK.length} steps, light ${SEQUENTIAL.length}`);
  for (const h of allTokenHexes('dark')) if (!HEX.test(h)) v.push(`DARK ${h} is not a 6-digit hex`);
  for (const [g, obj] of [['NEUTRAL', NEUTRAL_DARK], ['CHANNEL', CHANNEL_DARK], ['WASH', WASH_DARK], ['SEMANTIC', SEMANTIC_DARK]])
    for (const [k, h] of Object.entries(obj)) if (!HEX.test(h)) v.push(`DARK ${g}.${k} is not a 6-digit upper hex: ${h}`);
  for (const k of CHANNEL_ORDER) {
    const d = oklch(CHANNEL_DARK[k]), l = oklch(CHANNEL[k]);
    if (hueGap(d.H, l.H) > 3) v.push(`DARK L1 --c-${k} ${CHANNEL_DARK[k]} is ${hueGap(d.H, l.H).toFixed(1)}° from its light hue — not the same channel`);
    if (isReservedHue(d.H)) v.push(`DARK L1 --c-${k} ${CHANNEL_DARK[k]} sits in a reserved hue band (H ${d.H.toFixed(1)})`);
    const r = RAMP_DARK[k], o = RAMP_STATES.map((s) => oklch(r[s]));
    if (r.engaged !== CHANNEL_DARK[k]) v.push(`DARK L2 RAMP.${k}.engaged ${r.engaged} !== CHANNEL_DARK.${k}`);
    if (hueSpread(o.map((x) => x.H)) > 1) v.push(`DARK L2 RAMP.${k} hue spread ${hueSpread(o.map((x) => x.H)).toFixed(2)}° exceeds 1°`);
    for (let i = 1; i < o.length; i++) {
      const dL = o[i].L - o[i-1].L;
      if (dL <= 0) v.push(`DARK L5.4 RAMP.${k} ${RAMP_STATES[i]} does not run lighter than ${RAMP_STATES[i-1]} (dL ${dL.toFixed(3)})`);
      else if (dL < 0.060) v.push(`DARK L2 RAMP.${k} adjacent dL ${dL.toFixed(3)} below the 0.060 floor`);
    }
    for (const s of RAMP_STATES) if (isReservedHue(oklch(r[s]).H)) v.push(`DARK L1 RAMP.${k}.${s} ${r[s]} sits in a reserved hue band`);
  }
  for (const key of ['positive', 'negative'])
    if (!isReservedHue(oklch(SEMANTIC_DARK[key]).H)) v.push(`DARK L3 SEMANTIC.${key} ${SEMANTIC_DARK[key]} is outside the reserved bands`);
  if (SEMANTIC_DARK.neutral !== NEUTRAL_DARK.grey) v.push('DARK L3 SEMANTIC.neutral must be the dark grey');
  for (const h of [...SEQUENTIAL_DARK, ...Object.values(NEUTRAL_DARK)])
    if (oklch(h).C > 0.05) v.push(`DARK L3 neutral/sequential ${h} carries chroma ${oklch(h).C.toFixed(3)}`);
  if (NEUTRAL_DARK.signal !== NEUTRAL_DARK.ink) v.push('DARK --signal must be the dark ink');
  if (NEUTRAL_DARK.absOutline !== NEUTRAL_DARK.grey2) v.push('DARK --abs-outline must be the dark grey-2');
  if (oklch(NEUTRAL_DARK.paper).L >= oklch(NEUTRAL_DARK.ink).L) v.push('DARK the paper is not darker than the ink');
  for (const h of allTokenHexes('dark')) if (h === '#B32B1C') v.push('DARK carries the RETIRED signal red');
  return v;
}

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

  // ADDED — the dark set's shape, and the measured gates in BOTH themes.
  v.push(...lintDarkShape(), ...lintMeasures('light'), ...lintMeasures('dark'));
  return v;
}

export default {
  CHANNEL, CHANNEL_ORDER, RAMP, RAMP_STATES, WASH, SEMANTIC, SEQUENTIAL,
  NEUTRAL, FORM, MARK, RESERVED_HUE, BRIDGE,
  NEUTRAL_DARK, CHANNEL_DARK, RAMP_DARK, WASH_DARK, WASH_ALPHA, SEMANTIC_DARK, SEQUENTIAL_DARK,
  HATCH, ON_CHANNEL, THEMES, CVD_GATE, BAND,
  channelOf, channelKey, stateOf, washOf, semanticOf, sequentialOf, sequentialIndex,
  allTokenHexes, cssDeclarations, bridgeDeclarations, themeDeclarations, markDeclarations, cssTokens,
  oklch, contrast, isReservedHue, deltaE, cvdSeparation, mixHex, lintMeasures, lintTokens
};
