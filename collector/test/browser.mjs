/* One place that knows how to launch Chromium.
   ─────────────────────────────────────────────────────────────────────────
   Playwright resolves its browser from its own version: 1.62 looks for
   chromium-1234 under PLAYWRIGHT_BROWSERS_PATH and refuses to launch when it
   finds only chromium-1194 — printing "run npx playwright install", which the
   sandboxed environments this runs in block, and which would download a second
   copy of a browser that is already on disk. Every browser script here grew
   the same workaround (a hand-set PW_CHROME), which meant every fresh shell
   hit the same crash first and every runbook carried the same env var.

   Resolution order:
     1. PW_CHROME — an explicit override always wins.
     2. Playwright's own registry — the right answer when versions match.
     3. Whatever chromium* build actually exists under PLAYWRIGHT_BROWSERS_PATH
        (newest build number first), plus the /opt/pw-browsers/chromium symlink
        the environment maintains for exactly this case.

   The fallback is a resolver, not a pin: when the image and the package are in
   step this module adds nothing, and when they drift it keeps every script
   working instead of every script failing identically. */
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function chromiumPath() {
  if (process.env.PW_CHROME && existsSync(process.env.PW_CHROME)) return process.env.PW_CHROME;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* registry entry missing — fall through to the scan */ }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const stable = join(root, 'chromium');            // env-maintained symlink
  if (existsSync(stable)) return stable;
  try {
    const builds = readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const b of builds) {
      const bin = join(root, b, 'chrome-linux', 'chrome');
      if (existsSync(bin)) return bin;
    }
  } catch { /* no browsers dir at all — let launch() produce the real error */ }
  return null;
}

export function launchChromium(opts = {}) {
  const p = chromiumPath();
  return chromium.launch({ ...(p ? { executablePath: p } : {}), ...opts });
}
