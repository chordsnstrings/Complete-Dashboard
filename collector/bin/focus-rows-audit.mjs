#!/usr/bin/env node
/* Which LAYOUT ROWS has the focus pass marked as prose?
   ───────────────────────────────────────────────────────────────────
   api/public/focus.js marks long prose so arkiv.css can fold it under
   "ⓘ notes" or cut it to one line. A mark on an element that holds blocks
   (a list row, a card, a panel body) is a fault: the one-line cut hides
   everything under its first line and the fold hides whole structures. That
   is what the operator's screenshot of a driver's day showed on 2026-11-11
   ("unbooked journey in the drivers page are not properly formatted"), and
   docs/AUDIT.md "Rows cut to one line" carries the sweep this tool took.

   Walks every route in test/routes_list.mjs plus the pages that list does
   not carry (as bin/prose-audit.mjs does), under the Arkiv skin with focus
   on, lets each page settle, and lists every marked element whose children
   include a block element: which mark, its class, whether it is clamped or
   hidden, and how much of it the clamp cut (height against scrollHeight).
   A `.cap` or other BLOCK the selector names on purpose is reported too —
   read the class before calling it a fault.

   Read-only: GETs only. Point it at production through bin/prod-mirror.mjs
   (:8200) or at the working tree through bin/live-ui.mjs (:8100):

     node bin/prod-mirror.mjs &
     node bin/focus-rows-audit.mjs http://127.0.0.1:8200 /tmp/fx-rows.json
     ONLY='driver/<id>/day?on=2026-11-10' SETTLE=8000 node bin/focus-rows-audit.mjs http://127.0.0.1:8100 /tmp/fx.json

   ONLY narrows to the routes given (comma separated); MORE adds routes to
   the full list; SETTLE is the wait after the network goes quiet (ms). A slow
   page read before its panels arrive reports fewer marks, so compare two
   servers with the same SETTLE, run side by side. */
import { writeFileSync } from 'node:fs';
import { launchChromium } from '../test/browser.mjs';
import { ROUTES } from '../test/routes_list.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:8200';
const OUT = process.argv[3] || '/tmp/focus-rows-audit.json';
const EXTRA = ['import-sheet', 'opening', 'salary', 'advances', 'charging', 'policy', 'deposits', 'payouts', 'supply',
  'cancellations', 'hr-roster', 'same-person', 'feeds', 'unauthorized'];
const SKIP = /not-a-|nonsense|zzz-/;
const SETTLE = Number(process.env.SETTLE || 1500);

/* The fixture ids in the route list name nobody on production; swap in the
   first real driver, car and day the read API returns (bin/prose-audit.mjs). */
const api = async (p) => { try { const r = await fetch(`${BASE}${p}`); return r.ok ? await r.json() : null; } catch { return null; } };
const first = (v) => (Array.isArray(v) ? v[0] : (v?.rows?.[0] ?? null));
const dubai = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const TODAY = dubai(new Date()), YDAY = dubai(new Date(Date.now() - 864e5));
const WIN = `from=${dubai(new Date(Date.now() - 30 * 864e5))}&to=${TODAY}`;
const [rd, rv] = (await Promise.all([api(`/api/drivers/directory?${WIN}`), api(`/api/vehicles/directory?${WIN}`)])).map(first);
const SUB = { 'drv-0': rd?.person_id ? `p${rd.person_id}` : rd?.driver_ext_id, L45235: rv?.plate,
  '2026-08-25': TODAY, '2026-08-24': YDAY, '2026-08-14': YDAY, '2026-08-03': YDAY };
const sub = (r) => Object.entries(SUB).reduce((a, [k, v]) => (v ? a.split(k).join(v) : a), r);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const MORE = process.env.MORE ? process.env.MORE.split(',') : [];
const routes = ONLY || [...new Set([...ROUTES, ...EXTRA, ...MORE].filter((r) => !SKIP.test(r)).map(sub))];

const PROBE = () => {
  const LAYOUT = 'div, section, article, ul, ol, dl, table, figure, header, footer, nav, aside, form, fieldset';
  const rows = [];
  for (const m of document.querySelectorAll('#view [data-fx]:not([data-fx="keep"]), #pageFoot [data-fx]:not([data-fx="keep"])')) {
    const kids = [...m.children].filter((c) => c.matches(LAYOUT));
    if (!kids.length) continue;
    const cs = getComputedStyle(m);
    rows.push({ fx: m.dataset.fx, tag: m.tagName.toLowerCase(), cls: m.className.toString().slice(0, 60), kids: kids.length,
      clamp: !!cs.webkitLineClamp && cs.webkitLineClamp !== 'none', hidden: !m.checkVisibility(),
      h: Math.round(m.getBoundingClientRect().height), sh: m.scrollHeight,
      text: m.textContent.replace(/\s+/g, ' ').trim().slice(0, 110) });
  }
  return { marks: document.querySelectorAll('#view [data-fx]:not([data-fx="keep"])').length, rows };
};

const browser = await launchChromium();
const results = [];
const queue = [...routes];
const worker = async () => {
  for (let r; (r = queue.shift());) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', timezoneId: 'Asia/Dubai' });
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}/?ui=desktop&skin=arkiv#${r}`, { waitUntil: 'load', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
      await page.waitForTimeout(SETTLE);
      const p = await page.evaluate(PROBE);
      results.push({ route: r, ...p });
      if (p.rows.length) console.log(`${r}: ${p.rows.length} layout element(s) marked — ${[...new Set(p.rows.map((x) => `${x.fx}:${x.cls.split(' ')[0]}`))].join(', ')}`);
    } catch (e) {
      results.push({ route: r, error: String(e).slice(0, 160) });
      console.log(`${r}: ERROR ${String(e).slice(0, 100)}`);
    }
    await ctx.close();
  }
};
console.log(`${routes.length} routes`);
await Promise.all([worker(), worker(), worker(), worker()]);
await browser.close();
writeFileSync(OUT, JSON.stringify(results, null, 1));
const bad = results.filter((x) => x.rows?.length);
console.log(`\n${results.length} pages, ${bad.length} with marked layout elements, ${bad.reduce((a, x) => a + x.rows.length, 0)} elements; errors ${results.filter((x) => x.error).length} → ${OUT}`);
