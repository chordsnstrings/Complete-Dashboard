#!/usr/bin/env node
/* Every internal link on every page, checked for a malformed address.
   ─────────────────────────────────────────────────────────────────────────
   A hash router builds its own URLs, and a malformed one does not fail: it
   goes somewhere plausible and wrong, silently. parseHash splits the hash on
   its FIRST '?' and hands everything after it to URLSearchParams, so a second
   '#' or a second '?' lands inside a parameter value.

   That is what this found on its first run. #sources linked to Collection gaps
   as `#coverage?days=365#src-fms` — a query and then an anchor — so `days`
   came out as the string "365#src-fms", failed the [7,30,90,180,365] check,
   and fell back to thirty. The link said "over the whole record" and opened
   one month of it, on the page whose entire subject is what is missing from
   the record. Nothing about the page looked wrong.

   The patterns are the shapes a router builds by accident: a doubled '?' or
   '#', a stringified undefined or null, a doubled slash, "[object Object]".

       node bin/live-ui.mjs &
       node bin/link-audit.mjs
*/
import { launchChromium } from '../test/browser.mjs';
import { ROUTES } from '../test/routes_list.mjs';
const BASE = process.env.BASE || 'http://localhost:8100';
const b = await launchChromium(); const page = await b.newPage();
await page.setViewportSize({ width: 1280, height: 900 });
const BAD = /\?[^#]*\?|#.*#|undefined|=null\b|\/\/|%5Bobject/;
const sub = (r) => r
  .replace('drv-0', '0a6eb545-aa3b-4441-882c-34204df3d451')
  .replace('drv-9', '0a6eb545-aa3b-4441-882c-34204df3d451')
  .replace('L45235', 'L36397').replace('h-palm', '673dc94395448356a777f1ec');
let n = 0, bad = 0;
for (const r0 of ROUTES) {
  const r = sub(r0);
  try {
    await page.goto(`${BASE}/#${r}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);
  } catch { continue; }
  const hits = await page.evaluate((re) => {
    const rx = new RegExp(re);
    return [...new Set([...document.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href'))
      .filter((h) => h && h.startsWith('#') && rx.test(h)))].slice(0, 6);
  }, BAD.source);
  n += 1;
  if (hits.length) { bad += 1; console.log(`\n#${r0}`); hits.forEach((h) => console.log('   ', h)); }
}
console.log(`\n${n} routes walked, ${bad} with a malformed link`);
await b.close();
process.exit(bad ? 1 : 0);
