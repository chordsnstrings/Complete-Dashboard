#!/usr/bin/env node
/* The app's icons, drawn rather than vendored.
   ─────────────────────────────────────────────────────────────────────────
   A PWA needs real PNGs — iOS ignores SVG for the home screen — and a binary
   checked in with no way to regenerate it is a binary nobody can change. This
   draws them: a deep-ink ground (a home screen is usually dark, and the app's
   linen goes grey against it), the accent dot the sidebar already carries, and
   three ascending bars for the chart language the product is made of.

   Maskable icons keep everything inside the safe area: Android crops to
   whatever shape the launcher likes, and a mark that reaches the corners loses
   its edges. The 20% margin here is what the spec asks for.

     node bin/make-icons.mjs                 # writes api/public/icons/*.png
*/
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const INK = [0x1f, 0x22, 0x25];
const ACCENT = [0x2f, 0x6f, 0x9f];
const BAR = [0xef, 0xec, 0xe5];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const png = (size, px) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;                       // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;                                  // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

/* One drawing, described in fractions of the canvas, so every size is the same
   mark rather than three hand-tuned ones. `inset` is the maskable margin. */
const mark = (size, { inset = 0, round = 0 } = {}) => {
  const s = size, m = inset * s, w = s - 2 * m;          // the drawable square
  const bars = [                                         // x, y, w, h — fractions
    [0.10, 0.56, 0.16, 0.30],
    [0.34, 0.40, 0.16, 0.46],
    [0.58, 0.24, 0.16, 0.62],
  ].map(([x, y, bw, bh]) => [m + x * w, m + y * w, bw * w, bh * w]);
  const dot = { x: m + 0.80 * w, y: m + 0.20 * w, r: 0.11 * w };
  const rad = round * s;
  return (px, py) => {
    const x = px + 0.5, y = py + 0.5;
    if (rad > 0) {
      const cx = Math.min(Math.max(x, rad), s - rad);
      const cy = Math.min(Math.max(y, rad), s - rad);
      if ((x - cx) ** 2 + (y - cy) ** 2 > rad * rad) return [0, 0, 0, 0];
    }
    if ((x - dot.x) ** 2 + (y - dot.y) ** 2 <= dot.r * dot.r) return [...ACCENT, 255];
    for (const [bx, by, bw, bh] of bars) {
      if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) return [...BAR, 255];
    }
    return [...INK, 255];
  };
};

mkdirSync('api/public/icons', { recursive: true });
for (const [name, size, opts] of [
  ['icon-192.png', 192, { inset: 0.06, round: 0.22 }],
  ['icon-512.png', 512, { inset: 0.06, round: 0.22 }],
  ['maskable-192.png', 192, { inset: 0.20 }],
  ['maskable-512.png', 512, { inset: 0.20 }],
  ['apple-touch-icon.png', 180, { inset: 0.08 }],   // iOS rounds it itself
]) {
  const buf = png(size, mark(size, opts));
  writeFileSync(`api/public/icons/${name}`, buf);
  console.log(`${name.padEnd(24)} ${size}×${size}  ${(buf.length / 1024).toFixed(1)} KB`);
}
