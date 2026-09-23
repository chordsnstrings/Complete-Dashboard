# ARKIV-DARK.md — the dark set for the new UI, and every run that proves it

The operator ruled on 2026-09-23 (docs/UI-REDESIGN-PLAN.md §1, ruling 3):
*design a dark mode FOR THE NEW UI — dark values for every neutral, channel
identity, wash, ramp, semantic and hatch, each validated the way
PALETTE-EVIDENCE.md validated light: contrast against the dark paper, and CVD
separation between channel colours. The existing system/light/dark toggle
keeps working.*

This file is to the dark set what the design's PALETTE-EVIDENCE.md is to the
light one. The values live in `api/public/tokens.js` ("THE DARK SET") and
nowhere else. `bin/gen-tokens-css.mjs` writes them into app.css under the
existing theme mechanism, scoped to the skin. `test/tokens.test.mjs` §9 and
`lintTokens()` hold every value to the gates below, so this file and the
tokens cannot drift apart without a test failing.

**What dark does not reach, first, so nobody has to dig for it:** one
channel-against-semantic pair, Hotel × negative, measures CVD ΔE **7.0**
where light reaches 8.8. That is inside the validator's 6–8 band, which it
calls legal only with secondary encoding, and the law already requires that
encoding on every semantic (glyph and sign) and on every Hotel mark (a direct
label). Why it cannot reach 8.0, and what was tried, is in §E and §F.

## The set

| role | light | dark | dark contrast on #111113 |
|---|---|---|---|
| paper | `#FFFFFF` | `#111113` | — |
| paper-2 | `#F6F6F7` | `#1B1B1D` | 1.10 (light 1.08) |
| faint (grid) | `#E9E9EB` | `#252527` | 1.23 (1.21) |
| hair (rules) | `#D6D6D9` | `#333336` | 1.50 (1.45) |
| grey-2 / abs-outline | `#97979D` | `#68686D` | **3.40** — a mark, still rules-only |
| grey (secondary text) | `#6D6D72` | `#8D8D92` | **5.71** (5.21 on paper-2) |
| ink-2 | `#2E2E31` | `#D2D2D5` | 12.50 |
| ink | `#0A0A0B` | `#F0F0F1` | 16.56 |
| Uber | `#2362D3` | `#4366A5` | 3.31 |
| Bolt | `#0398BA` | `#2EA3C7` | 6.45 |
| Yango | `#B4358A` | `#BE118E` | 3.29 |
| Hotel | `#A38902` | `#B29200` | 6.29 |
| CABMAN | `#6B259F` | `#8D2CD7` | 3.12 |
| FMS | `#9974F5` | `#9C78FA` | 5.82 |
| positive | `#007E44` | `#008E60` | **4.52** (text) |
| negative | `#961111` | `#D65044` | **4.57** (text) |
| graphite 0…5 | `#ACB0B7`…`#13171F` | `#484D56` `#646972` `#818690` `#9FA5AF` `#BEC4CF` `#DFE5F0` | 2.22 … 14.91 |
| wash | 14% of the token on white | 14% of the token on `#111113` | ink on the worst 11.56 |
| hatch opacity | 0.45 | 0.53 | faintest line 1.66 (light 1.65) |

The ramps run lighter from each identity by dL 0.065, as on light (§C). The
label printed inside a channel fill (the dominance bar) is ink on Uber, Yango
and CABMAN and paper on Bolt, Hotel and FMS in dark: light text on the deeper
three and dark text on the lighter three, which is what light mode does too.
The token names swap because paper and ink did (`--on-c-*`, tokens.js
`ON_CHANNEL`).

## How it was solved

- **Paper.** A near-black with the faint cool cast of Arkiv's greys (hue 286),
  not pure black. Every neutral was then stepped to mirror its light twin's
  contrast against its own paper (table above).
- **Channels.** Each keeps its light hue within 2.3° (L1: one colour per
  channel; lintTokens allows 3°). Lightness and chroma were SOLVED against
  the validator's gates: the dark band L 0.48–0.67, chroma ≥ 0.10, 3:1 on the
  paper, CVD ≥ 8 on all pairs of the six, normal-vision ≥ 15 on all 28 pairs
  of the eight, tritan ≥ 8 among the six, a 4.5:1 label on every fill, and
  every ramp step against both semantics. The search is in §E.
- **Semantics.** They colour delta text, so each needs 4.5:1 on the paper.
  On this paper that means L ≳ 0.57 — the top of the dark band.
- **Washes** keep the 14% form. Measured, not carried over: 14% of each token
  on the dark paper sits a mean OKLab ΔE 7.9 from the paper, against 7.4 on
  light, so a chip reads as clearly.
- **Graphite** flips its anchor, so step 5 is the farthest from the paper in
  both themes (2.22:1 → 14.91:1; light 2.18:1 → 17.95:1). arkiv.css's
  `--s1..--s8` and `--b100..--b700` point at steps by index and flip with it.
- **Hatch** (SPEC §5, the mark's own colour at an opacity). 45% of a mid-light
  colour over near-black is fainter than 45% of it over white: Uber's and
  Yango's lines would measure 1.52 and 1.49:1 against a weakest light line of
  1.65:1. 0.53 is the least opacity at which no dark line is fainter than the
  faintest light one. Emitted as `--hatch-a`; charts.js adopts it in STEP 2.

## How to rerun

The validator is the dataviz skill's script, the same one PALETTE-EVIDENCE.md
ran (that file names build 2.1.272; these runs used 2.1.280, whose thresholds
and simulation are the same — the light collision run below reproduces the
design's published A4 output line for line):

```bash
VALIDATE=<dataviz skill>/scripts/validate_palette.js
node collector/bin/arkiv-dark-evidence.mjs   # the port in tokens.js: every table in §D
node collector/test/tokens.test.mjs          # §9 holds each value to its gate
```

The port (`tokens.js` `deltaE`, `cvdSeparation`) is calibrated in
`test/tokens.test.mjs` §9 against six numbers PALETTE-EVIDENCE.md printed from
the validator itself (A2, A3, E1, E5b, F3); it reproduces each to the printed
decimal. The light collision run, rerun on this build, gives the design's
published A4 result line for line:

```
$ node $VALIDATE \
    "#2362D3,#0398BA,#B4358A,#A38902,#6B259F,#9974F5,#007E44,#961111" --mode light --surface "#FFFFFF" --pairs all

Palette (light, surface #FFFFFF, categorical): 8 slots
  [PASS] Lightness band         all 8 inside L 0.43–0.77
  [PASS] Chroma floor           all 8 >= 0.1
  [PASS] CVD separation         worst all-pairs #961111↔#007E44 ΔE 8.6 (deutan) · tritan 5.2
  [PASS] Normal-vision floor    worst all-pairs #0398BA↔#2362D3 ΔE 16.1 (normal)
  [PASS] Contrast vs surface    all 8 >= 3:1

  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
  scope: categorical palettes only. For a lone status/text color check WCAG text contrast; for a sequential ramp, lightness monotonicity.

exit=0
```

Gates, from the validator's source: `CVD_TARGET 8.0` / `CVD_FLOOR 6.0` (min of
protan and deutan, OKLab ΔE×100, Machado 2009 at severity 1.0) ·
`NORMAL_FLOOR 15.0` (hard) · `CONTRAST_MIN 3.0` · band `L 0.48–0.67` in dark
· chroma `C 0.10` · ordinal `dL 0.06`, near-end `2.0:1`. Tritan is reported,
not gated, by the validator; tokens.js gates it at 8.0 among the six
channels, because the ruling asks for the channels to be distinguishable
under tritanopia too.

---

## A · The accepted system

### A1 — six identities, adjacent, in the fixed order

```
$ node $VALIDATE \
    "#4366A5,#2EA3C7,#BE118E,#B29200,#8D2CD7,#9C78FA" --mode dark --surface "#111113"

Palette (dark, surface #111113, categorical): 6 slots
  [PASS] Lightness band         all 6 inside L 0.48–0.67
  [PASS] Chroma floor           all 6 >= 0.1
  [PASS] CVD separation         worst adjacent #BE118E↔#2EA3C7 ΔE 12.0 (deutan) · tritan 15.3
  [PASS] Normal-vision floor    worst adjacent #9C78FA↔#8D2CD7 ΔE 15.4 (normal)
  [PASS] Contrast vs surface    all 6 >= 3:1

  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
  scope: categorical palettes only. For a lone status/text color check WCAG text contrast; for a sequential ramp, lightness monotonicity.

exit=0
```

### A2 — six identities, all pairs (scatter, map, small multiples)

```
$ node $VALIDATE \
    "#4366A5,#2EA3C7,#BE118E,#B29200,#8D2CD7,#9C78FA" --mode dark --surface "#111113" --pairs all

Palette (dark, surface #111113, categorical): 6 slots
  [PASS] Lightness band         all 6 inside L 0.48–0.67
  [PASS] Chroma floor           all 6 >= 0.1
  [PASS] CVD separation         worst all-pairs #BE118E↔#4366A5 ΔE 8.1 (protan) · tritan 10.9
  [PASS] Normal-vision floor    worst all-pairs #9C78FA↔#8D2CD7 ΔE 15.4 (normal)
  [PASS] Contrast vs surface    all 6 >= 3:1

  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
  scope: categorical palettes only. For a lone status/text color check WCAG text contrast; for a sequential ramp, lightness monotonicity.

exit=0
```

All six still pass all-pairs, as on light, so no dark page has to facet. The
margin is thinner (8.1 against 8.6).

### A3 — the semantic pair alone

```
$ node $VALIDATE \
    "#008E60,#D65044" --mode dark --surface "#111113" --pairs all

Palette (dark, surface #111113, categorical): 2 slots
  [PASS] Lightness band         all 2 inside L 0.48–0.67
  [PASS] Chroma floor           all 2 >= 0.1
  [PASS] CVD separation         worst all-pairs #D65044↔#008E60 ΔE 8.1 (deutan) · tritan 32.1
  [PASS] Normal-vision floor    worst all-pairs #D65044↔#008E60 ΔE 27.6 (normal)
  [PASS] Contrast vs surface    all 2 >= 3:1

  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
  scope: categorical palettes only. For a lone status/text color check WCAG text contrast; for a sequential ramp, lightness monotonicity.

exit=0
```

### A4 — the collision run: six identities plus both semantics, all pairs

```
$ node $VALIDATE \
    "#4366A5,#2EA3C7,#BE118E,#B29200,#8D2CD7,#9C78FA,#008E60,#D65044" --mode dark --surface "#111113" --pairs all

Palette (dark, surface #111113, categorical): 8 slots
  [PASS] Lightness band         all 8 inside L 0.48–0.67
  [PASS] Chroma floor           all 8 >= 0.1
  [WARN] CVD separation         worst all-pairs #D65044↔#B29200 ΔE 7.0 (deutan) · tritan 7.9
  [PASS] Normal-vision floor    worst all-pairs #9C78FA↔#8D2CD7 ΔE 15.4 (normal)
  [PASS] Contrast vs surface    all 8 >= 3:1

  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
  scope: categorical palettes only. For a lone status/text color check WCAG text contrast; for a sequential ramp, lightness monotonicity.

exit=0
```

**WARN, exit 0.** The worst pair is Hotel × negative at 7.0. Every other pair
is at 7.9 or more, and only one more is under 8.0 (Yango × positive, 7.9):

```
$ node $VALIDATE \
    "#B29200,#D65044" --mode dark --surface "#111113" --pairs all

Palette (dark, surface #111113, categorical): 2 slots
  [PASS] Lightness band         all 2 inside L 0.48–0.67
  [PASS] Chroma floor           all 2 >= 0.1
  [WARN] CVD separation         worst all-pairs #D65044↔#B29200 ΔE 7.0 (deutan) · tritan 15.4
  [PASS] Normal-vision floor    worst all-pairs #D65044↔#B29200 ΔE 17.9 (normal)
  [PASS] Contrast vs surface    all 2 >= 3:1

  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
  scope: categorical palettes only. For a lone status/text color check WCAG text contrast; for a sequential ramp, lightness monotonicity.

exit=0
```

```
$ node $VALIDATE \
    "#4366A5,#2EA3C7,#BE118E,#B29200,#8D2CD7,#9C78FA,#008E60" --mode dark --surface "#111113" --pairs all

Palette (dark, surface #111113, categorical): 7 slots
  [PASS] Lightness band         all 7 inside L 0.48–0.67
  [PASS] Chroma floor           all 7 >= 0.1
  [WARN] CVD separation         worst all-pairs #008E60↔#BE118E ΔE 7.9 (deutan) · tritan 7.9
  [PASS] Normal-vision floor    worst all-pairs #9C78FA↔#8D2CD7 ΔE 15.4 (normal)
  [PASS] Contrast vs surface    all 7 >= 3:1

  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
  scope: categorical palettes only. For a lone status/text color check WCAG text contrast; for a sequential ramp, lightness monotonicity.

exit=0
```

Both pairs set a channel against a semantic. A semantic is never an area
fill (L3) and always carries its glyph and sign (▲ + / ▼ −); every Hotel
mark carries a direct label (SPEC §4). That is the secondary encoding the
validator's WARN requires, and it is already the law. `lintTokens()` holds
this run at 7.0 — a ratchet on what was measured, not the validator's 6.0
floor — so a change that makes it worse fails instead of drifting to the
floor unnoticed.

---

## B · The state ramps and the graphite ramp

Each ramp is passed in its own order (identity first). The validator's
dark-mode near-end check takes the step nearest the dark paper, which is the
identity itself.

### B1 Uber

```
$ node $VALIDATE \
    "#4366A5,#5579BA,#688DCF" --mode dark --surface "#111113" --ordinal

Palette (dark, surface #111113, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #4366A5 at 3.31:1 vs surface
  [PASS] Single hue             hue spread 0°

  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
exit=0
```

### B2 Bolt

```
$ node $VALIDATE \
    "#2EA3C7,#48B8DC,#60CDF2" --mode dark --surface "#111113" --ordinal

Palette (dark, surface #111113, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #2EA3C7 at 6.45:1 vs surface
  [PASS] Single hue             hue spread 1°

  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
exit=0
```

### B3 Yango

```
$ node $VALIDATE \
    "#BE118E,#D532A2,#EC4BB7" --mode dark --surface "#111113" --ordinal

Palette (dark, surface #111113, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #BE118E at 3.29:1 vs surface
  [PASS] Single hue             hue spread 0°

  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
exit=0
```

### B4 Hotel

```
$ node $VALIDATE \
    "#B29200,#C7A62C,#DCBB47" --mode dark --surface "#111113" --ordinal

Palette (dark, surface #111113, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #B29200 at 6.29:1 vs surface
  [PASS] Single hue             hue spread 0°

  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
exit=0
```

### B5 CABMAN

```
$ node $VALIDATE \
    "#8D2CD7,#A146EE,#B361FF" --mode dark --surface "#111113" --ordinal

Palette (dark, surface #111113, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #8D2CD7 at 3.12:1 vs surface
  [PASS] Single hue             hue spread 0°

  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
exit=0
```

### B6 FMS

```
$ node $VALIDATE \
    "#9C78FA,#AE93FF,#C0AFFF" --mode dark --surface "#111113" --ordinal

Palette (dark, surface #111113, ordinal ramp): 3 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #9C78FA at 5.82:1 vs surface
  [PASS] Single hue             hue spread 0°

  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
exit=0
```

### B7 Graphite

```
$ node $VALIDATE \
    "#484D56,#646972,#818690,#9FA5AF,#BEC4CF,#DFE5F0" --mode dark --surface "#111113" --ordinal

Palette (dark, surface #111113, ordinal ramp): 6 slots
  [PASS] Lightness monotone     steps read light→dark
  [PASS] Adjacent ΔL            all gaps >= 0.06
  [PASS] Light-end contrast     #484D56 at 2.22:1 vs surface
  [PASS] Single hue             hue spread 4°

  → ALL CHECKS PASS  (ordinal: one hue, monotone L, visible step gaps, light end clears surface)
exit=0
```

---

## C · The direction of the ramps, measured both ways

The light law says a ramp runs LIGHT from its identity, because the dark end
is where hue dies and a channel walks into a semantic (L5.4). On dark,
running lighter also runs toward the semantics' lightness, so the direction
was measured again rather than assumed. The sweep is every ramp step against
each dark semantic, the dark analogue of PALETTE-EVIDENCE.md's C1/C2 (whose
own C1 was a different, rejected set of light ramps — these are this
palette's steps run each way).

### C1 — REJECTED: running toward the paper

```
$ node sweep.mjs down   # tokens.js's port; steps at the identity's L, −0.065, −0.130
                        # (bin/arkiv-dark-evidence.mjs prints its summary line)
EVERY dark ramp step (running toward the PAPER) x each dark semantic, sorted by worst CVD.
Gates: CVD >= 8.0 target / 6.0 floor (7.0 the dark ratchet), normal >= 15.0, ordinal step >= 2.0:1 on #111113
FAIL-CVD                     hotel.s1   #9B7F00 x negative cvd   3.1  normal  16.4  tritan  15.0  step 4.88:1
FAIL-CVD                     hotel.s2   #856C00 x negative cvd   4.9  normal  17.3  tritan  17.2  step 3.72:1
WARN-CVD                     hotel.s0   #B29200 x negative cvd   7.0  normal  17.9  tritan  15.4  step 6.29:1
WARN-CVD FAIL-NORM           hotel.s1   #9B7F00 x positive cvd   7.1  normal  14.4  tritan  17.1  step 4.88:1
WARN-CVD                     yango.s0   #BE118E x positive cvd   7.9  normal  35.0  tritan  31.6  step 3.29:1
FAIL-NORM                    hotel.s2   #856C00 x positive cvd   8.3  normal  13.8  tritan  16.6  step 3.72:1
                             hotel.s0   #B29200 x positive cvd   9.2  normal  17.8  tritan  19.9  step 6.29:1
                             yango.s1   #A20078 x positive cvd  11.5  normal  34.3  tritan  31.1  step 2.52:1
FAIL-NORM                    bolt.s2    #007A99 x positive cvd  11.5  normal  12.3  tritan   3.4  step 3.81:1
FAIL-NORM                    bolt.s1    #028FB2 x positive cvd  11.8  normal  12.6  tritan   4.5  step 5.01:1
                             bolt.s2    #007A99 x negative cvd  12.6  normal  27.9  tritan  31.9  step 3.81:1
                             bolt.s0    #2EA3C7 x positive cvd  14.6  normal  15.6  tritan  10.3  step 6.45:1
=> 12 of 36 pairs fail a gate (CVD < 7.0, normal < 15.0 or step < 2.0:1). Under the 8.0 target: 5.
=> worst CVD 3.13 (hotel.s1 x negative); worst normal 12.31; faintest step 1.82:1
```

Hotel's darker steps turn olive and meet the negative red at CVD 3.1 — the
failure the light law was written against — and three steps fall under the
2:1 floor.

### C2 — ACCEPTED: running lighter

```
$ node sweep.mjs up     # tokens.js's port; the RAMP_DARK steps
EVERY dark ramp step (running LIGHTER from the identity) x each dark semantic, sorted by worst CVD.
Gates: CVD >= 8.0 target / 6.0 floor (7.0 the dark ratchet), normal >= 15.0, ordinal step >= 2.0:1 on #111113
WARN-CVD                     hotel.s0   #B29200 x negative cvd   7.0  normal  17.9  tritan  15.4  step 6.29:1
WARN-CVD                     yango.s0   #BE118E x positive cvd   7.9  normal  35.0  tritan  31.6  step 3.29:1
                             yango.s1   #D532A2 x positive cvd   8.5  normal  35.1  tritan  31.6  step 4.32:1
                             hotel.s0   #B29200 x positive cvd   9.2  normal  17.8  tritan  19.9  step 6.29:1
                             hotel.s1   #C7A62C x negative cvd  12.8  normal  20.9  tritan  18.8  step 8.01:1
                             yango.s2   #EC4BB7 x positive cvd  12.9  normal  36.3  tritan  32.8  step 5.62:1
                             yango.s1   #D532A2 x negative cvd  13.8  normal  15.7  tritan   3.7  step 4.32:1
                             hotel.s1   #C7A62C x positive cvd  14.1  normal  22.1  tritan  23.8  step 8.01:1
                             uber.s1    #5579BA x positive cvd  14.3  normal  18.0  tritan   3.6  step 4.34:1
                             bolt.s0    #2EA3C7 x positive cvd  14.6  normal  15.6  tritan  10.3  step 6.45:1
                             yango.s2   #EC4BB7 x negative cvd  14.8  normal  16.9  tritan   6.8  step 5.62:1
                             uber.s2    #688DCF x positive cvd  15.5  normal  19.3  tritan   6.7  step 5.66:1
=> 0 of 36 pairs fail a gate (CVD < 7.0, normal < 15.0 or step < 2.0:1). Under the 8.0 target: 2.
=> worst CVD 7.04 (hotel.s0 x negative); worst normal 15.61; faintest step 3.12:1
```

The two WARN rows are the two identities already named in A4. No lighter step
is worse than its identity.

---

## D · Every measure, from the port

```
$ node collector/bin/arkiv-dark-evidence.mjs dark
══ DARK — paper #111113 ══

Contrast (WCAG) — text needs 4.5, a mark 3, an ordinal step 2
  --ink      #F0F0F1   16.56:1 on paper   15.10:1 on paper-2
  --ink-2    #D2D2D5   12.50:1 on paper   11.40:1 on paper-2
  --grey     #8D8D92    5.71:1 on paper    5.21:1 on paper-2
  --grey-2   #68686D    3.40:1 on paper    3.10:1 on paper-2
  --hair     #333336    1.50:1 on paper    1.37:1 on paper-2
  --faint    #252527    1.23:1 on paper    1.12:1 on paper-2
  --paper-2  #1B1B1D    1.10:1 on paper    1.00:1 on paper-2
  --sem-pos  #008E60    4.52:1 on paper    4.13:1 on paper-2
  --sem-neg  #D65044    4.57:1 on paper    4.17:1 on paper-2
  --c-uber    #4366A5    3.31:1  L 0.514 C 0.108 H 261.4  label ink 5.01:1  ramp #4366A5 #5579BA #688DCF
  --c-bolt    #2EA3C7    6.45:1  L 0.668 C 0.112 H 223.4  label paper 6.45:1  ramp #2EA3C7 #48B8DC #60CDF2
  --c-yango   #BE118E    3.29:1  L 0.540 C 0.223 H 343.9  label ink 5.04:1  ramp #BE118E #D532A2 #EC4BB7
  --c-hotel   #B29200    6.29:1  L 0.670 C 0.137 H  93.2  label paper 6.29:1  ramp #B29200 #C7A62C #DCBB47
  --c-cabman  #8D2CD7    3.12:1  L 0.529 C 0.240 H 304.8  label ink 5.31:1  ramp #8D2CD7 #A146EE #B361FF
  --c-fms     #9C78FA    5.82:1  L 0.667 C 0.186 H 293.5  label paper 5.82:1  ramp #9C78FA #AE93FF #C0AFFF
  graphite #484D56 2.22  #646972 3.42  #818690 5.16  #9FA5AF 7.61  #BEC4CF 10.77  #DFE5F0 14.91
  washes (14%) uber #181D27 ink 14.82 · bolt #15252C ink 13.83 · yango #291124 ink 15.37 · hotel #282310 ink 13.78 · cabman #22152E ink 15.18 · fms #241F33 ink 13.98 · positive #0F231E ink 14.41 · negative #2D1A1A ink 14.47 · ink #303032 ink 11.56
  hatch at 0.53: uber 1.76 bolt 2.61 yango 1.67 hotel 2.58 cabman 1.66 fms 2.48

Colour blindness (OKLab ΔE ×100; CVD = min of protan and deutan; target 8, floor 6, normal 15)
  A1 channels, adjacent                CVD  12.0 (bolt × yango)  normal  15.4 (cabman × fms)  tritan  15.3 (cabman × fms)
  A2 channels, all pairs               CVD   8.1 (uber × yango)  normal  15.4 (cabman × fms)  tritan  10.9 (hotel × fms)
  A3 the semantic pair                 CVD   8.1 (positive × negative)  normal  27.6 (positive × negative)  tritan  32.1 (positive × negative)
  A4 channels + semantics, all pairs   CVD   7.0 (hotel × negative)  normal  15.4 (cabman × fms)  tritan   7.9 (uber × positive)
  C2 ramp steps LIGHTER × semantics: 0 of 36 fail (gate CVD 7, normal 15, step 2:1); worst CVD 7.04 hotel.s0 #B29200 × negative; worst normal 15.61; faintest step 3.12:1
  C1 ramp steps toward the PAPER × semantics: 12 of 36 fail (gate CVD 7, normal 15, step 2:1); worst CVD 3.13 hotel.s1 #9B7F00 × negative; worst normal 12.31; faintest step 1.82:1

lintTokens(): [] — clean, both themes
```

Two figures in it are under what light reaches, and are named here rather
than glossed:
- **The semantics on paper-2 measure 4.13 and 4.17:1** (light 4.78 and
  8.15). They clear 4.5 on the paper, where delta text sits. Under the skin,
  semantic colour reaches paper-2 only as text in a HOVERED table row (a
  verdict cell is a dot with ink digits, and a tile's digits are ink). Holding
  4.5 on paper-2 as well was measured (E3) and costs more than it buys.
- **Tritan, channel against semantic:** the worst ramp step against a
  semantic is 3.6 (Uber available × positive), and the A4 run's tritan is 7.9.
  Light's A4 tritan is 5.2. The validator reports tritan and does not gate
  it; between the six channels it is 10.9 and gated at 8.0.

---

## E · Rejected alternatives, measured

### E1 — the light identities, reused on the dark paper

```
$ node $VALIDATE \
    "#2362D3,#0398BA,#B4358A,#A38902,#6B259F,#9974F5" --mode dark --surface "#111113" --pairs all

Palette (dark, surface #111113, categorical): 6 slots
  [FAIL] Lightness band         outside band: [["#6B259F",0.435]]
  [PASS] Chroma floor           all 6 >= 0.1
  [PASS] CVD separation         worst all-pairs #B4358A↔#0398BA ΔE 8.6 (deutan) · tritan 9.8
  [PASS] Normal-vision floor    worst all-pairs #0398BA↔#2362D3 ΔE 16.1 (normal)
  [WARN] Contrast vs surface    below 3:1 — relief required (visible labels or table view): [["#6B259F",2.15]]

  → FAILED — fix the marked checks  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
  scope: categorical palettes only. For a lone status/text color check WCAG text contrast; for a sequential ramp, lightness monotonicity.

exit=1
```

### E1b — the light semantics, reused on the dark paper

```
$ node $VALIDATE \
    "#007E44,#961111" --mode dark --surface "#111113" --pairs all

Palette (dark, surface #111113, categorical): 2 slots
  [FAIL] Lightness band         outside band: [["#961111",0.431]]
  [PASS] Chroma floor           all 2 >= 0.1
  [PASS] CVD separation         worst all-pairs #961111↔#007E44 ΔE 8.6 (deutan) · tritan 28.3
  [PASS] Normal-vision floor    worst all-pairs #961111↔#007E44 ΔE 28.0 (normal)
  [WARN] Contrast vs surface    below 3:1 — relief required (visible labels or table view): [["#961111",2.14]]

  → FAILED — fix the marked checks  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
  scope: categorical palettes only. For a lone status/text color check WCAG text contrast; for a sequential ramp, lightness monotonicity.

exit=1
```

CABMAN and the negative red are both under 3:1 on #111113 and under the dark
band. Neither light pair can be kept.

### E2 — REJECTED: a vivid Uber, with FMS muted instead

```
$ node $VALIDATE \
    "#0957D8,#00A6C7,#B70088,#B29200,#B758FF,#7E71BB" --mode dark --surface "#111113" --pairs all

Palette (dark, surface #111113, categorical): 6 slots
  [PASS] Lightness band         all 6 inside L 0.48–0.67
  [PASS] Chroma floor           all 6 >= 0.1
  [PASS] CVD separation         worst all-pairs #7E71BB↔#00A6C7 ΔE 8.1 (deutan) · tritan 8.0
  [PASS] Normal-vision floor    worst all-pairs #7E71BB↔#B758FF ΔE 15.0 (normal)
  [PASS] Contrast vs surface    all 6 >= 3:1

  → ALL CHECKS PASS  (CVD in the 6–8 floor band is legal ONLY with secondary encoding: direct labels, gaps, or texture)
  scope: categorical palettes only. For a lone status/text color check WCAG text contrast; for a sequential ramp, lightness monotonicity.

exit=0
```

Uber, CABMAN and FMS are all blue-violet, and to a protanope or deuteranope
they differ only in lightness and saturation. The dark band is too narrow to
separate three of them on lightness alone, so one of the three has to give up
saturation. This alternative keeps Uber's saturation (C 0.209) and mutes FMS
(C 0.111). It passes, by 0.05 on CVD, with a normal-vision floor of exactly
15.0 and a tritan floor of 8.0. The accepted set mutes Uber (C 0.108) and
passes at CVD 8.1, normal 15.4 and tritan 10.9. It was chosen on those
margins, and because Uber carries 91% of the work: a calmer Uber keeps the
dark page from reading as a wall of blue.

### E3 — REJECTED: the semantics held at 4.5:1 on paper-2 as well

With every channel as accepted, the best semantic pair that clears 4.5:1 on
BOTH the paper and paper-2 (`#009762` / `#DD5942`, 4.59 and 4.57 on paper-2)
drops the worst channel × semantic pair to **CVD 4.8** (Hotel × negative;
the pair itself still passes at 8.0),
under the validator's 6.0 floor: a FAIL. Raising the paper-2 requirement
pushes both semantics higher in lightness, straight into Hotel's gold.

### E4 — REJECTED: the positive on the light hue (154°)

At 154° and the accepted lightness (`#298D54`, 4.52:1), the semantic pair
itself measures **CVD 6.78** — under the target on the one pair that must
never be confused. Moving toward teal inside the green band pulls it apart
under deuteranopia: 7.2 at 156°, 7.7 at 160°, 8.1 at 161.7°. The cost is
Yango × positive, 9.6 → 7.9 (A4c). `test/tokens.test.mjs` fails on 154°.

### E5 — the ceiling on Hotel × negative

Why 7.0 and not 8.0: under deuteranopia a red and a gold of the same
lightness are nearly the same colour (the OKLab b-axis carries both), so
they must be split in lightness. The negative must be at L ≳ 0.60 to clear
4.5:1 as text; Hotel then has to sit well above it (the band stops at 0.67)
or well below it, where protanopia pulls the red DOWN toward the gold (a red
loses 0.08–0.10 of lightness under protan simulation). Both directions run
out of band. What was tried, all with the validator's gates as hard
constraints (band, chroma, contrast, the 4.5:1 label on every fill, normal
≥ 15 on all 28 pairs, the six channels ≥ 8 all-pairs, the pair ≥ 8):

- simulated annealing over OKLCH, 4 configurations × 10 restarts × 20,000
  steps: best channel × semantic **7.02, 7.07, 6.54 and 7.17** (the 7.17 still
  missed one gate by a hair), each with the six-channel and normal-vision
  floors at 8.00–8.05 and 15.0–15.2;
- an exhaustive grid (L step 0.01, C step 0.02, hue ±2°) over 9,125 semantic
  pairs, with small margins on each floor (0.1 on CVD and tritan, 0.2 on
  normal vision, 0.05–0.1 on contrast): **no set at all** with channel ×
  semantic ≥ 7.0 and ramps running lighter, and none at ≥ 7.5 with ramps
  running toward the paper.

That is the best found, not a proof that 8.0 is impossible. The accepted set
is at 7.04 with wider margins on every other floor than the 7.17 set had.

---

## F · What dark does not reach, and what it asks of the pages

| | light | dark | consequence |
|---|---|---|---|
| channel × semantic, CVD | 8.8 | **7.0** (Hotel × negative) | WARN band. Legal because every semantic carries its glyph and sign and is never an area fill (L3), and every Hotel mark is directly labelled (SPEC §4). STEP 3's render-audit checks (a semantic with no glyph) enforce it. |
| six channels, all pairs | 8.6 | 8.1 | still a PASS; a scatter or map of all six needs no facets |
| semantic text on paper-2 | 4.78 / 8.15 | 4.13 / 4.17 | only in a hovered table row today; ≥ 3:1, the large-text level |
| Uber's saturation | C 0.186 | C 0.108 | a calmer steel blue; see E2 |
| ramp salience | idle faintest | idle brightest | the order is the law's; the ramp is read by its legend |

## G · How the theme reaches the page

`bin/gen-tokens-css.mjs` writes three rules between the GENERATED TOKENS
markers in app.css:

```css
:root[data-skin="arkiv"]{ …the design's light block, byte for byte… }
@media (prefers-color-scheme: dark){
  :root[data-skin="arkiv"]:not([data-theme="light"]){ color-scheme:dark; …the dark set… }
}
:root[data-skin="arkiv"][data-theme="dark"]{ color-scheme:dark; …the dark set… }
```

These are the same three states the old skin's dark blocks answer to and
`#themeBtn` cycles through (system → light → dark). The `:not()` guard is
what lets a reader who chose light keep it on a dark OS. Both dark rules are
(0,3,0), one step heavier than every rule in arkiv.css, which names tokens
and never values, so the same component rules draw both themes. None of it
applies without `data-skin="arkiv"`, so production's look does not move.
`test/arkiv_skin.test.mjs` §2 resolves every old colour name in a browser in
four states (OS light; OS dark; light OS with dark chosen; dark OS with light
chosen), and §7 draws the components in dark.
