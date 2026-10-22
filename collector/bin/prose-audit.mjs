#!/usr/bin/env node
/* How much each page asks a reader to READ, as the reader meets it.
   ───────────────────────────────────────────────────────────────────
   The verbosity audit of 2026-10-22 (docs/AUDIT.md "Verbosity"), kept as a
   tool so the numbers can be taken again instead of quoted. It walks every
   route in test/routes_list.mjs (plus the pages that list does not carry),
   lets each page settle, and classes every VISIBLE text node in #view and the
   page footer as prose, table cell, tile figure, tile label, heading, control
   or chart. Per page it records the visible prose words, the prose on the
   first screen against the figures there, the prose before the first figure,
   the page's height in screens, and the 40 longest prose blocks.

   Hidden text is not counted: a block folded under "ⓘ notes" (focus.js) does
   not count until it is opened, and a title tooltip never does. So run it
   twice — once as is, once with FOCUS=off — to see what the folding saves.

   Read-only: GETs only. Point it at production through bin/prod-mirror.mjs
   (:8200, production's own bytes and data) or at the working tree through
   bin/live-ui.mjs (:8100).

     node bin/prod-mirror.mjs &            # or bin/live-ui.mjs
     node bin/prose-audit.mjs http://127.0.0.1:8200 /tmp/prose     # → /tmp/prose/measure.json
     ONLY=payouts,overview FOCUS=off node bin/prose-audit.mjs http://127.0.0.1:8100 /tmp/prose-off */
import { launchChromium } from '../test/browser.mjs';
import { ROUTES } from '../test/routes_list.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://127.0.0.1:8200';
const OUT = process.argv[3] || '/tmp/prose-audit';
mkdirSync(`${OUT}/shots`, { recursive: true });
const EXTRA = ['import-sheet', 'opening', 'salary', 'advances', 'charging', 'policy', 'deposits', 'payouts', 'supply',
  'cancellations', 'hr-roster', 'same-person', 'feeds', 'unauthorized'];
const SKIP = /not-a-|nonsense|zzz-/;

/* The fixture ids in the route list name nobody on production; swap in the
   first real driver, car and day the read API returns. */
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
const routes = [...new Set((ONLY || [...ROUTES, ...EXTRA]).filter((r) => !SKIP.test(r)).map(sub))];

const PROBE = () => {
  const view = document.querySelector('#view');
  const roots = [view, document.querySelector('#pageFoot')].filter(Boolean);
  const words = (s) => (s.match(/[A-Za-z0-9][A-Za-z0-9'’.,%+−\-/:]*/g) || []).length;
  const nums = (s) => (s.match(/[−+-]?\d[\d,]*(\.\d+)?%?/g) || []).length;
  const kind = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (e.closest('svg')) return 'chart';
      const t = e.tagName;
      if (t === 'TD' || t === 'TH') return 'table';
      if (['BUTTON', 'SELECT', 'OPTION', 'INPUT', 'LABEL'].includes(t)) return 'control';
      if (e.classList?.contains('n') && e.closest('.kpi')) return 'figure';
      if (e.classList?.contains('l') && e.closest('.kpi')) return 'label';
      if (['H1', 'H2', 'H3', 'H4', 'SUMMARY'].includes(t)) return 'heading';
    }
    return 'prose';
  };
  const out = { prose: 0, table: 0, figure: 0, label: 0, chart: 0, control: 0, heading: 0 };
  const blocks = new Map();
  let beforeData = 0, sawData = false, fsProse = 0, fsData = 0;
  for (const root of roots) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      const s = n.nodeValue.replace(/\s+/g, ' ').trim();
      const el = n.parentElement;
      if (!s || !el || !el.checkVisibility()) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const k = kind(el), wc = words(s);
      out[k] += wc;
      if (k === 'table' || k === 'figure' || k === 'chart') { if (nums(s)) sawData = true; }
      if (k === 'prose' && !sawData) beforeData += wc;
      if (r.top + scrollY < innerHeight) { if (k === 'prose') fsProse += wc; else if (k === 'figure' || k === 'table') fsData += nums(s); }
      if (k === 'prose') {
        const b = el.closest('p, li, .note, .cap, div, section, details') || el;
        const e = blocks.get(b) || { words: 0, text: (b.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400), cls: String(b.className || b.tagName).slice(0, 40) };
        e.words += wc; blocks.set(b, e);
      }
    }
  }
  return { ...out, prose_before_first_data: beforeData, first_screen_prose: fsProse, first_screen_data: fsData,
    height: document.documentElement.scrollHeight, screens: +(document.documentElement.scrollHeight / innerHeight).toFixed(1),
    title: (document.querySelector('#viewTitle')?.textContent || '').trim().slice(0, 80),
    blocks: [...blocks.values()].sort((a, b) => b.words - a.words).slice(0, 40) };
};

const browser = await launchChromium();
const results = [];
for (const r of routes) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', timezoneId: 'Asia/Dubai' });
  if (process.env.FOCUS) await ctx.addInitScript((m) => { try { localStorage.setItem('fleet.focus', m); } catch { /* */ } }, process.env.FOCUS);
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/#${r}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const m = await page.evaluate(PROBE);
    await page.screenshot({ path: `${OUT}/shots/${r.replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}.jpg`, type: 'jpeg', quality: 55 });
    results.push({ route: r, ...m });
    console.log(`${r.padEnd(48)} prose ${String(m.prose).padStart(5)}  first screen ${String(m.first_screen_prose).padStart(4)} words / ${String(m.first_screen_data).padStart(3)} figures  ${m.screens} screens`);
  } catch (e) {
    results.push({ route: r, error: String(e).slice(0, 200) });
    console.log(r, 'ERROR', String(e).slice(0, 120));
  }
  await ctx.close();
  writeFileSync(`${OUT}/measure.json`, JSON.stringify(results, null, 1));
}
await browser.close();
const ok = results.filter((x) => !x.error).map((x) => x.prose).sort((a, b) => a - b);
console.log(`done: ${results.length} pages, median visible prose ${ok[Math.floor(ok.length / 2)] ?? '—'} words`);
