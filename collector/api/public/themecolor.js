/* THE BROWSER'S OWN BAR IN THE PAPER THE PAGE IS DRAWN ON — the desktop build.
   ═══════════════════════════════════════════════════════════════════════════
   A <meta name="theme-color"> colours what no stylesheet can reach: Safari's
   tab bar, an installed window's title bar, Android's status bar. index.html
   carries two, one per OS scheme, and they carried the Classic skin's linen
   and near-black for six weeks after Arkiv became the default (HANDOFF §4.5).
   They now carry Arkiv's paper (tokens.js NEUTRAL.paper, NEUTRAL_DARK.paper),
   but a static value cannot follow two things the page can:

     · the theme the reader CHOSE — the metas answer the OS's scheme, so a
       reader who picked dark on a light OS got a white bar over a grey page
       (the pre-paint script in index.html covers the first paint; this covers
       the theme button, which changes it while the page is open);
     · the skin — a reader who kept Classic draws on linen, not white.

   So once the stylesheets are in, both metas take the RESOLVED --paper — the
   colour the page is actually drawn on, from the one place it is declared
   (no colour is written down twice; SPEC L5.1), whichever skin and theme —
   and again whenever the theme button or the OS's scheme moves it. The phone
   does the same for itself in m/app.js akChrome(). */
export function paintThemeColor(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return null;
  let paper = '';
  try { paper = String(getComputedStyle(doc.documentElement).getPropertyValue('--paper')).trim(); } catch { return null; }
  if (!paper) return null;
  doc.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', paper));
  return paper;
}

let following = false;
/* Paint now, and follow the OS's scheme from here on (a reader on "system"
   whose machine turns dark at sunset). Safe to call on every theme change. */
export function followThemeColor() {
  const paper = paintThemeColor();
  if (!following && typeof matchMedia === 'function') {
    following = true;
    try { matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => paintThemeColor()); }
    catch { /* an old engine: the button still repaints */ }
  }
  return paper;
}
