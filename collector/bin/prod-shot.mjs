#!/usr/bin/env node
/* Screenshot production, and read back what is actually on the screen.
   ─────────────────────────────────────────────────────────────────────────
   Points a real browser at bin/prod-mirror.mjs, which serves production's own
   bytes (see that file for why a browser here cannot reach the origin itself).
   Writes a full-page PNG per route and prints the page's own numbers — the KPI
   tiles, the table headers and first rows, the captions — so a claim about a
   page can be checked against what the page says rather than against what the
   endpoint returns.

       node bin/prod-shot.mjs overview drivers
       WIDTH=412 node bin/prod-shot.mjs drivers
*/
import { launchChromium } from '../test/browser.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://127.0.0.1:8200';
const WIDTH = Number(process.env.WIDTH || 1440);
const SETTLE = Number(process.env.SETTLE || 9000);
const OUT = process.env.OUT || 'docs/audit/shots';
mkdirSync(OUT, { recursive: true });

const slug = (r) => r.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'home';
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: WIDTH, height: 1000 } });

const bad = [];
page.on('pageerror', (e) => bad.push(`pageerror ${String(e.message).slice(0, 110)}`));
page.on('response', (r) => {
  if (r.url().includes('/api/') && r.status() >= 400) bad.push(`${r.status()} ${r.url().split('8200')[1]?.slice(0, 60)}`);
});

for (const route of process.argv.slice(2)) {
  bad.length = 0;
  await page.goto(`${BASE}/#${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(SETTLE);
  const file = `${OUT}/${WIDTH}-${slug(route)}.png`;
  await page.screenshot({ path: file, fullPage: true });
  /* PANEL="Trips per day" shoots that panel alone. A full page is the record;
     one panel is what you look at when checking a specific fix, and cropping a
     PNG afterwards is a worse way to get there than asking the browser. */
  if (process.env.PANEL) {
    const el = await page.evaluateHandle((want) => [...document.querySelectorAll('.panel')]
      .find((n) => (n.querySelector('h3')?.textContent || '').includes(want)) || null, process.env.PANEL);
    const node = el.asElement();
    if (node) {
      const one = `${OUT}/${WIDTH}-${slug(route)}--${slug(process.env.PANEL)}.png`;
      await node.screenshot({ path: one });
      console.log(`   panel → ${one}`);
    } else console.log(`   panel "${process.env.PANEL}" not found`);
  }

  const seen = await page.evaluate(() => {
    const t = (n) => (n?.textContent || '').replace(/\s+/g, ' ').trim();
    return {
      title: t(document.querySelector('#viewTitle')),
      kpis: [...document.querySelectorAll('.kpi')].map((k) => ({
        l: t(k.querySelector('.l')), n: t(k.querySelector('.n')), s: t(k.querySelector('.s') || k.querySelector('.d')),
      })),
      tables: [...document.querySelectorAll('table')].map((tb) => ({
        panel: t(tb.closest('.panel')?.querySelector('h3')).slice(0, 40),
        cols: [...tb.querySelectorAll('thead th')].map(t),
        rows: tb.querySelectorAll('tbody tr').length,
        first: [...(tb.querySelector('tbody tr')?.querySelectorAll('td') || [])].map(t),
      })),
      notes: [...document.querySelectorAll('.tabsent, .note')].map((n) => t(n).slice(0, 150)),
      empty: [...document.querySelectorAll('.empty')].map((n) => t(n).slice(0, 90)),
    };
  });
  console.log(`\n━━ #${route}  →  ${file}`);
  console.log(`   title: ${seen.title}`);
  seen.kpis.forEach((k) => console.log(`   KPI  ${k.l} = ${k.n}${k.s ? `   [${k.s}]` : ''}`));
  seen.tables.forEach((tb) => {
    console.log(`   TBL  ${tb.panel} — ${tb.rows} rows`);
    console.log(`        ${tb.cols.join(' | ')}`);
    if (tb.first.length) console.log(`        ${tb.first.join(' | ').slice(0, 190)}`);
  });
  seen.empty.forEach((e) => console.log(`   EMPTY  ${e}`));
  seen.notes.forEach((n) => console.log(`   NOTE  ${n}`));
  if (bad.length) console.log(`   ✗ ${[...new Set(bad)].join(' · ')}`);
}
await browser.close();
