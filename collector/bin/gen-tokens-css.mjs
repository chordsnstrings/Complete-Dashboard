/* The Arkiv custom properties in api/public/app.css are GENERATED from
   api/public/tokens.js.
   ─────────────────────────────────────────────────────────────────────────
   SPEC L5.1: colour is defined in exactly one place. A hand-copied :root is
   the second copy that drifts — the old palette already carried one (--s7
   and --s8 declared in the light block and forgotten in both dark ones, so
   dark mode drew #unauthorized's primary series at 3.16:1 for months). So
   the block between the GENERATED TOKENS markers in app.css is written from
   tokens.js by this script, the same pattern as bin/gen-schema-v53.mjs, and
   test/tokens.test.mjs re-renders it and fails if app.css differs by a byte.

     node bin/gen-tokens-css.mjs          # rewrite the block in app.css
     node bin/gen-tokens-css.mjs --check  # exit 1 if it is stale

   WHY THE BLOCK IS SCOPED TO data-skin="arkiv". The old skin paints --paper,
   --paper-2, --ink, --grey and the six --c-* with its OWN values, and
   production keeps the old look until the operator flips it (plan §3,
   STEP 0 → STEP 5). Written under a bare :root these values would repaint
   every page on the next deploy. Under :root[data-skin="arkiv"] (specificity
   0,2,0, placed AFTER the old dark blocks, which are 0,2,0 too) they win
   whenever the skin is on — in either theme, because the old dark palette
   must never show through the new skin (two colour laws on one page) — and
   are inert everywhere else. STEP 1 stamps the attribute before first paint.

   Only the text between the two markers is touched; a missing or doubled
   marker is refused rather than guessed at.

   THE DARK SET (ruling 3) IS WRITTEN UNDER THE EXISTING THEME MECHANISM, the
   same three states the old skin's dark blocks answer to and #themeBtn
   cycles (system → light → dark):
     · the reader chose nothing and the OS is dark:
         @media (prefers-color-scheme: dark){ :root[data-skin="arkiv"]:not([data-theme="light"]){…} }
       — the :not() guard is what lets a reader who chose LIGHT keep it on a
       dark OS;
     · the reader chose dark: :root[data-skin="arkiv"][data-theme="dark"]{…}.
   Both are (0,3,0), one step heavier than the light block and than every
   rule in arkiv.css, so they win in either theme state that asks for dark
   and are inert without the skin. They carry color-scheme:dark, so native
   controls and scrollbars follow; arkiv.css's color-scheme:light (0,2,0)
   stands everywhere else. The form tokens (--hl-*, --mark-row, and the
   chart mark form --mk-* that STEP 2 added) are not colours and are
   declared once, in the light block. */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cssDeclarations, bridgeDeclarations, themeDeclarations, markDeclarations } from '../api/public/tokens.js';

export const CSS = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'public', 'app.css');
export const BEGIN = '/* ═══ BEGIN GENERATED TOKENS ═══ */';
export const END = '/* ═══ END GENERATED TOKENS ═══ */';
export const SELECTOR = ':root[data-skin="arkiv"]';
export const DARK_MEDIA = '@media (prefers-color-scheme: dark)';
export const DARK_SYSTEM = ':root[data-skin="arkiv"]:not([data-theme="light"])';
export const DARK_CHOSEN = ':root[data-skin="arkiv"][data-theme="dark"]';

/* What each dark block declares, in order. */
export const darkDeclarations = () => ['color-scheme:dark', ...cssDeclarations('dark'), ...themeDeclarations('dark')];

/* The block, markers excluded. */
export function render() {
  const decl = (d) => `  ${d};`;
  const decl4 = (d) => `    ${d};`;
  return `
/* Written by bin/gen-tokens-css.mjs from api/public/tokens.js — do not edit
   here; edit tokens.js and re-run the script. test/tokens.test.mjs fails if
   this block and tokens.js disagree.

   The Arkiv colour contract (docs/UI-REDESIGN-PLAN.md §3). INERT until
   <html data-skin="arkiv">: every name below that the old skin also uses
   (--paper, --paper-2, --ink, --grey, --c-*) keeps the old skin's value on a
   page without the attribute. --ink-2 here is near-black EMPHASIS, not the
   old secondary-text grey, which is --grey-strong now. */
${SELECTOR}{
${cssDeclarations().map(decl).join('\n')}
  /* per theme, not in the design's block: hatch opacity, label on a fill */
${themeDeclarations('light').map(decl).join('\n')}
  /* the old skin's names, folded onto Arkiv tokens (tokens.js BRIDGE) */
${bridgeDeclarations().map(decl).join('\n')}
  /* the mark form, SPEC §4-§5, read by charts.js markForm() (tokens.js MARK) */
${markDeclarations().map(decl).join('\n')}
}
/* The dark set (the operator's ruling 3; evidence in docs/ARKIV-DARK.md),
   twice: for a dark OS when the reader chose nothing, and for a reader who
   chose dark. Same values in both, from tokens.js THEMES.dark. */
${DARK_MEDIA}{
  ${DARK_SYSTEM}{
${darkDeclarations().map(decl4).join('\n')}
  }
}
${DARK_CHOSEN}{
${darkDeclarations().map(decl).join('\n')}
}
`;
}

/* app.css with the block replaced. Throws on a missing or doubled marker. */
export function apply(css) {
  const b = css.indexOf(BEGIN), e = css.indexOf(END);
  if (b < 0 || e < 0 || e < b) throw new Error(`app.css has no ${BEGIN} … ${END} pair`);
  if (css.indexOf(BEGIN, b + 1) >= 0 || css.indexOf(END, e + 1) >= 0)
    throw new Error('app.css carries the GENERATED TOKENS markers twice');
  return css.slice(0, b + BEGIN.length) + render() + css.slice(e);
}

if (process.argv[1] && process.argv[1].endsWith('gen-tokens-css.mjs')) {
  const got = readFileSync(CSS, 'utf8');
  const want = apply(got);
  if (process.argv.includes('--check')) {
    if (got !== want) { console.error('app.css tokens are stale — run node bin/gen-tokens-css.mjs'); process.exit(1); }
    console.log('app.css tokens match api/public/tokens.js');
  } else {
    writeFileSync(CSS, want);
    console.log(`wrote ${cssDeclarations().length + themeDeclarations('light').length + bridgeDeclarations().length + markDeclarations().length} light and 2 × ${darkDeclarations().length} dark declarations into ${CSS}`);
  }
}
