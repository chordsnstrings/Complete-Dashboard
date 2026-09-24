#!/usr/bin/env node
/* The app's icons, made from the operator's artwork.
   ─────────────────────────────────────────────────────────────────────────
   FleetMirror's mark (the operator, 2026-09-24) arrived as three 1024px files,
   kept as given in api/public/brand/. The icons are the ON-DARK file resized:
   the manifest's ground is that file's own #151513, so an icon and its splash
   meet without a seam. This used to DRAW the old icon (an ink ground, the
   accent dot and three bars); left as it was, running it would have put the
   old design back over the new one.

   The mark sits inside the maskable safe circle as drawn: its farthest corner
   is 395px from the centre of the 1024 canvas, and the circle's radius is
   409.6 (40%), so the maskable icons are the same picture as the plain ones.

   NEW NAMES, on purpose. server.js serves /icons immutable for a year, so an
   icon replaced under its old name stays the old icon in every browser that
   fetched it. A new picture gets a new address.

   Resized in Chromium's canvas (high-quality smoothing), which the test suite
   already carries, so this needs nothing installed.

     node bin/make-icons.mjs                 # writes api/public/icons/fleetmirror-*.png
*/
import { readFileSync, writeFileSync } from 'node:fs';
import { launchChromium } from '../test/browser.mjs';

const PUB = new URL('../api/public/', import.meta.url);
const SRC = readFileSync(new URL('brand/fleetmirror-on-dark.png', PUB)).toString('base64');
const OUT = [
  ['fleetmirror-192.png', 192], ['fleetmirror-512.png', 512],
  ['fleetmirror-maskable-192.png', 192], ['fleetmirror-maskable-512.png', 512],
  ['fleetmirror-apple-touch.png', 180],
];

const browser = await launchChromium();
const page = await (await browser.newContext()).newPage();
const made = await page.evaluate(async ([src, out]) => {
  const img = new Image();
  img.src = `data:image/png;base64,${src}`;
  await img.decode();
  return out.map(([name, size]) => {
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, size, size);
    return [name, c.toDataURL('image/png').split(',')[1]];
  });
}, [SRC, OUT]);
await browser.close();
for (const [name, b64] of made) {
  writeFileSync(new URL(`icons/${name}`, PUB), Buffer.from(b64, 'base64'));
  console.log(`wrote api/public/icons/${name}`);
}
