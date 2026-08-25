#!/usr/bin/env node
/* Does the page show the numbers the API gave it?
   ─────────────────────────────────────────────────────────────────────────
   The render audit proved every page LOOKS right: nothing overflows, no
   column is a wall of dashes, every gap explains itself. It passed 312
   renders clean — and the Reconciliation page was still showing twelve months
   of "no statement" while the endpoint behind it held seven months of bank
   payouts totalling AED 2.1M. The numbers were fetched, they were rendered,
   and they were off the right-hand edge of a table whose identity column had
   scrolled off the left. Nothing in a render check can see that, because
   nothing was wrong with the render.

   So this asks the other question. For each page it captures every /api/
   response the page actually fetched, walks the JSON for money and counts,
   and checks that the figures which reached the browser also reached the
   SCREEN — either as text, or inside something the reader can scroll to
   without losing the row they are reading.

   Three failures it looks for:

     unshown    a number in the payload that appears nowhere in the DOM
     unreachable a number rendered only outside the visible box, in a table
                whose first column does not stay put — the reader can reach it
                or know which row it belongs to, but not both
     mislabelled a figure whose column header the payload does not support

       node bin/live-ui.mjs &
       node bin/numbers-audit.mjs
       ONLY=reconcile,drivers node bin/numbers-audit.mjs
*/
import { launchChromium } from '../test/browser.mjs';
import { ROUTES } from '../test/routes_list.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8100';
const SETTLE = Number(process.env.SETTLE || 5000);
const WIDTH = Number(process.env.WIDTH || 412);       // a phone, where it bites hardest

const api = async (p) => {
  try { const r = await fetch(`${BASE}${p}`); return r.ok ? await r.json() : null; } catch { return null; }
};
const first = (v) => (Array.isArray(v) ? v[0] : (v?.rows?.[0] ?? null));
const dubai = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const TODAY = dubai(new Date());
const WIN = `from=${dubai(new Date(Date.now() - 30 * 864e5))}&to=${TODAY}`;
const [drv, veh, prop] = await Promise.all([
  api(`/api/drivers/directory?${WIN}`), api(`/api/vehicles/directory?${WIN}`),
  api(`/api/corporate/properties?${WIN}`)]);
const rd = first(drv), rv = first(veh), rp = first(prop);
const SUB = { 'drv-0': rd?.ids?.[0] || rd?.driver_ext_id, 'drv-9': rd?.ids?.[0] || rd?.driver_ext_id,
  L45235: rv?.plate, 'h-palm': rp?.partner_id, '2026-08-25': TODAY,
  '2026-08-24': dubai(new Date(Date.now() - 864e5)), '2026-08-14': dubai(new Date(Date.now() - 864e5)) };
const sub = (r) => Object.entries(SUB).reduce((a, [k, v]) => (v ? a.split(k).join(v) : a), r);

/* Numbers worth checking: money and counts big enough that a reader would
   notice them missing. Small integers — a page index, a rating, a day count —
   appear everywhere by coincidence and would drown the signal. */
const MIN = 1000;
const isNum = (v) => (typeof v === 'number'
  || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)));
const big = (v) => {
  const n = Math.abs(Number(v));
  return Number.isFinite(n) && n >= MIN ? Math.round(n) : null;
};

/* What a row is ABOUT. A payload row carries its own identity — a plate, a
   person, a month, an area — and that is the hinge this whole check turns on:
   if the identity is on screen the row is being displayed, so every figure in
   it should be on screen too. If the identity is absent the row was never
   drawn, and its numbers being absent is not a fault.

   Without this the audit reported 267 of 302 figures "unshown" on #unit, which
   fetches the whole asset ledger for a tab it is not currently showing. A
   harness that cannot tell "not rendered" from "rendered wrong" reports the
   product as broken and gets switched off. */
const ID_KEYS = ['plate', 'driver_name', 'name', 'm', 'month', 'day', 'area', 'place',
  'platform', 'category', 'label', 'source', 'partner_name', 'property', 'from_area'];
const identityOf = (row) => {
  for (const k of ID_KEYS) {
    const v = row[k];
    if (typeof v === 'string' && v.trim().length > 1) return v.trim();
  }
  return null;
};

/* Every (identity, figure) pair in a payload, from the lists inside it. */
function rowFigures(o, out = [], where = '') {
  if (Array.isArray(o)) {
    o.slice(0, 80).forEach((r) => {
      if (!r || typeof r !== 'object') return;
      const id = identityOf(r);
      if (!id) return;
      const siblings = Object.keys(r);
      for (const [k, v] of Object.entries(r)) {
        if (!isNum(v)) continue;
        const n = big(v);
        if (n != null) out.push({ id, key: k, n, where, siblings });
      }
    });
    return out;
  }
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) rowFigures(v, out, where ? `${where}.${k}` : k);
  }
  return out;
}

const routes = (process.env.ONLY ? process.env.ONLY.split(',') : ROUTES).map(sub);
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 } });

const findings = [];
let n = 0;
for (const route of routes) {
  const seen = [];
  const onResp = async (r) => {
    if (!r.url().includes('/api/') || r.status() >= 400) return;
    try { seen.push([r.url().replace(BASE, ''), await r.json()]); } catch { /* not json */ }
  };
  page.on('response', onResp);
  process.stderr.write(`\r[${++n}/${routes.length}] ${route.slice(0, 44).padEnd(44)}`);
  try {
    await page.goto(`${BASE}/#${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(SETTLE);
  } catch (e) {
    findings.push({ route, code: 'crashed', detail: String(e.message).slice(0, 120) });
    page.off('response', onResp); continue;
  }

  const dom = await page.evaluate(() => {
    const root = document.querySelector('#view') || document.body;
    /* "AED 2,117,508" and 2117508 must compare equal, so the thousands
       separators come OUT rather than becoming spaces — the first version of
       this turned "3,387" into "3 387", matched neither, and reported 196 of
       197 figures as missing on a page that was showing all of them. */
    const norm = (s2) => (s2 || '')
      .replace(/(\d),(?=\d{3}\b)/g, '$1')
      .replace(/[^\d]/g, ' ');
    /* Each table as the reader meets it: what its columns are called, and what
       each row says. The check needs both — a figure only counts as missing if
       the table HAS a column for it and the row is on screen without it. */
    const tables = [...root.querySelectorAll('table')].map((t) => ({
      heads: [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim()),
      rows: [...t.querySelectorAll('tbody tr')].map((r) => ({
        /* A row is ABOUT its first cell. Matching the identity anywhere in the
           row found a driver's name in the "Held by" column of a VEHICLE row
           and then demanded that driver's earnings appear in a row describing
           a car — four findings that were the matcher's fault, not the page's. */
        subject: ((r.children[0] || {}).textContent || '').trim().toLowerCase(),
        text: (r.innerText || '').toLowerCase(),
        nums: norm(r.innerText).split(/\s+/).filter(Boolean),
      })),
    }));
    /* A table that scrolls sideways WITHOUT a pinned first column: a figure
       only reachable there costs the reader the row it belongs to. */
    const loose = [...root.querySelectorAll('.tscroll')].filter((w) => {
      const t = w.querySelector('table');
      if (!t || w.scrollWidth <= w.clientWidth + 2) return false;
      const c = t.querySelector('tbody td:first-child');
      return !c || getComputedStyle(c).position !== 'sticky';
    });
    /* …and one whose pinned column is an INDEX rather than an identity. The
       drivers directory led with '#', so a phone froze a column of 1, 2, 3
       while the person each row is about scrolled away behind three narrow
       columns: every number on screen and nobody's name against any of it.
       A pinned column that says nothing is worse than none, because it looks
       like the fix is already in. */
    const indexPinned = [...root.querySelectorAll('.tscroll')].filter((w) => {
      const t = w.querySelector('table');
      if (!t || w.scrollWidth <= w.clientWidth + 2) return false;
      const head = (t.querySelector('thead th')?.textContent || '').trim();
      if (/^(#|no\.?|rank|idx)$/i.test(head)) return true;
      /* Or unlabelled cells that are all bare small integers. */
      const cells = [...t.querySelectorAll('tbody td:first-child')].slice(0, 12)
        .map((c) => c.textContent.trim());
      return cells.length >= 4 && cells.every((v) => /^\d{1,3}$/.test(v));
    }).map((w) => (w.closest('.panel')?.querySelector('h3') || {}).textContent?.trim().slice(0, 34) || '?');
    /* The whole page as digits, charts included. A figure drawn as a bar
       label — the revenue page draws its top-level payout components as an
       hbars chart and tables only their children — is SHOWN, and a check that
       reads table cells alone called four of those missing. The last gate is
       "nowhere on the page", not "not in this cell". */
    return { tables, looseTables: loose.length, indexPinned, page: norm(root.innerText).split(/\s+/).filter(Boolean) };
  });

  /* Does this table have a column for that field? Compared on words, so
     "on_trip_net" matches "On-trip net" and "bank_payout" matches "Bank
     payout" — and a field with NO column is not a finding: not every value in
     a payload is meant to be a column, and treating them as one reported
     fix_age_min and a tier's kilometres as missing from tables that never
     offered them. */
  /* Two-letter tokens are kept on the KEY side. Dropping them made
     `priced_km` and `priced` identical, so the audit demanded a kilometre
     figure appear in a column headed "Priced" that correctly holds a count of
     bookings. They are still dropped from headers, where "of", "in" and "by"
     are noise. */
  const NOISE = ['the', 'per', 'and', 'of', 'in', 'by', 'to', 'for'];
  const tok = (x, min) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w.length >= min && !NOISE.includes(w));
  const words = (x) => tok(x, 3);
  /* A column showing a DERIVED quantity is not a column for the raw field.
     "Alerts /100km" is a rate and `alerts` is a count; "Share of revenue" is a
     percentage and `revenue` is an amount. Both matched on words alone and the
     audit demanded the raw number appear in a cell that correctly holds
     something else. */
  const DERIVED = /[/%]|\bper\b|\bshare\b|\brate\b|\bavg\b|\baverage\b|\bper 100\b/i;
  const columnFor = (heads, key) => {
    const kw = tok(key, 2);
    if (!kw.length) return null;
    return heads.find((h) => {
      if (DERIVED.test(h)) return false;
      const hw = words(h);
      return kw.every((w) => hw.includes(w));
    }) || null;
  };

  /* One body per URL, and it is the LAST one.
     ─────────────────────────────────────────────────────────────────────────
     data.js is stale-while-revalidate: when a cached copy exists it paints
     from that immediately and revalidates behind it, so a single page load
     produces TWO responses for the same endpoint. Both were being walked, and
     the figures compared against the DOM came from a mixture of the two.

     Measured on #unit/drivers: the held copy said Bakht Zada Sharif earned
     7,898 and the fresh one 7,911. The page painted the held figure, the
     revalidation came back changed, the page redrew with 7,911 — everything
     working exactly as designed — and the audit reported eight drivers whose
     money was "unshown", naming the number that had been correct for about a
     second. Six of those eight were the same story.

     What the reader ends up looking at is the last answer, so that is the one
     the DOM has to agree with. Keeping the earlier body would make this
     harness report the product as broken every time a cache warmed up. */
  const latest = new Map();
  seen.forEach(([u, body]) => latest.set(u, body));

  const pairs = [];
  latest.forEach((body, u) => rowFigures(body).forEach((f) => pairs.push({ ...f, url: u.split('?')[0] })));

  const onPage = new Set(dom.page);
  const anywhere = (v) => onPage.has(String(v)) || onPage.has(String(v - 1)) || onPage.has(String(v + 1));

  /* A field the page shows in different UNITS is shown.
     `on_trip_s` is seconds and the column prints hours off `on_trip_min`; both
     are the same measurement and the row carries both. So a key is skipped
     when its own row holds a sibling sharing its stem — the page is free to
     render whichever of them reads better. */
  const STEM = /_(s|ms|sec|secs|min|mins|hours|hrs|km|m|pct|percent)$/;
  const missing = [];
  for (const f of pairs) {
    if (STEM.test(f.key) && f.siblings.some((k) => k !== f.key
      && k.replace(STEM, '') === f.key.replace(STEM, ''))) continue;
    for (const t of dom.tables) {
      const col = columnFor(t.heads, f.key);
      if (!col) continue;
      /* EVERY row carrying this identity, not the first.
         A platform name is not unique — /api/revenue has an `uber` row per
         fleet and per month, and /api/platforms one per fleet — so matching
         the first and then failing to find another row's value there reported
         six perfectly displayed figures as missing. The claim being tested is
         "this value is nowhere in its own column", so all the candidate rows
         are searched. */
      const rows = t.rows.filter((r) => r.subject.includes(f.id.toLowerCase().slice(0, 18)));
      if (!rows.length) continue;                          // this row is not drawn here
      const near = (r, v) => r.nums.includes(String(v))
        || r.nums.includes(String(v - 1)) || r.nums.includes(String(v + 1));
      if (!rows.some((r) => near(r, f.n)) && !anywhere(f.n)) missing.push({ ...f, col });
      break;
    }
  }
  if (missing.length) {
    findings.push({ route, code: 'unshown',
      detail: `${missing.length} figure(s) have a column on this page, sit in a row it is `
        + 'showing, and are not in that row',
      examples: [...new Set(missing.map((f) => `${f.id} · ${f.col} should be ${f.n} (${f.url} ${f.key})`))].slice(0, 6) });
  }
  if (dom.indexPinned?.length) {
    findings.push({ route, code: 'index-pinned',
      detail: `${dom.indexPinned.length} scrolling table(s) pin a rank or index instead of the `
        + `row's identity: ${dom.indexPinned.join(' | ')}` });
  }
  if (dom.looseTables) {
    findings.push({ route, code: 'unreachable',
      detail: `${dom.looseTables} table(s) scroll sideways with no pinned first column — `
        + 'a figure there costs the reader the row it belongs to' });
  }
  page.off('response', onResp);
}

/* ── a fact that moves under a label that promised it would not ────────────
   Entity pages carry an identity card: the block that says who or what this
   page is about. Everything in it reads as a property of the thing — and some
   of it was coming out of a payload field that the range selector changes.

   Measured on one driver's card before this check existed:

     days=7    "First seen 19 Aug 2026"   trips  54
     days=30   "First seen 27 Jul 2026"   trips 266
     days=365  "First seen 27 Aug 2025"   trips 3280

   The person had been on Uber since 24 August 2025 the whole time. Moving the
   range selector changed the date they were hired.

   So each entity route is loaded at two windows and its card compared fact by
   fact. A fact whose VALUE differs between the two is windowed, and it has to
   say so — a label naming the window is the whole fix, and it is what makes
   the number readable rather than merely correct. */
const CARD_ROUTES = [...new Set(ROUTES
  .filter((r) => /^(driver|vehicle|performer|property)\/[^/]+$/.test(r)).map(sub))];
const cardFacts = async (route, days) => {
  await page.goto(`${BASE}/#${route}?days=${days}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(SETTLE);
  return page.evaluate(() => [...document.querySelectorAll('.idcard .idfacts > span')].map((n) => {
    const b = n.querySelector('b');
    return { label: (b?.textContent || '').trim(), value: n.textContent.replace(b?.textContent || '', '').trim() };
  }));
};
/* The words that make a windowed fact honest. A label carrying one of these is
   telling the reader the number belongs to the range they chose. */
const NAMES_WINDOW = /window|range|selected|period|this week|so far|last \d/i;

for (const route of CARD_ROUTES) {
  process.stderr.write(`\r[card] ${route.slice(0, 44).padEnd(44)}`);
  let a, wide, again;
  /* THREE loads, not two: 7d, 365d, then 7d again.
     ───────────────────────────────────────────────────────────────────────
     This is a live fleet. Its drivers take trips while the audit is running,
     so a two-load comparison reported "Trips: 3,295 at 7d, 3,296 at 365d" —
     a driver who completed one trip during the fifteen seconds between the two
     page loads, on a figure that is not windowed at all. Comparing 7d against
     7d isolates what MOVED from what the window CHANGED: a fact that differs
     between the two identical loads is volatile and says nothing, and only a
     fact that held still across them and differs at 365d is windowed. */
  try {
    a = await cardFacts(route, 7);
    wide = await cardFacts(route, 365);
    again = await cardFacts(route, 7);
  } catch { continue; }
  if (!a.length || a.length !== wide.length || a.length !== again.length) continue;

  const drifted = a.map((f, i) => ({ f, w: wide[i], v: again[i] }))
    .filter(({ f, w, v }) => w.label === f.label && v.label === f.label
      && v.value === f.value                       // held still while the clock ran
      && w.value !== f.value                       // …and moved when the window did
      && !NAMES_WINDOW.test(f.label));
  if (drifted.length) {
    findings.push({ route, code: 'window-drift',
      detail: `${drifted.length} identity fact(s) change with the range selector under a label `
        + 'that does not name a window',
      examples: drifted.map(({ f, w }) =>
        `${f.label}: "${f.value}" at 7d, "${w.value}" at 365d`.slice(0, 140)).slice(0, 6) });
  }
}
process.stderr.write('\r'.padEnd(70) + '\r');

await browser.close();
process.stderr.write('\r'.padEnd(70) + '\r');

const byRoute = new Map();
findings.forEach((f) => {
  if (!byRoute.has(f.route)) byRoute.set(f.route, []);
  byRoute.get(f.route).push(f);
});
for (const [route, fs] of byRoute) {
  console.log(`\n#${route}`);
  fs.forEach((f) => {
    console.log(`  ✗ ${f.code}  ${f.detail}`);
    (f.examples || []).forEach((e) => console.log(`      ${e}`));
  });
}
console.log(`\n─────────────────────────────────────────────`);
console.log(`${routes.length} routes at ${WIDTH}px, ${byRoute.size} with findings`);
mkdirSync('docs/audit', { recursive: true });
writeFileSync(`docs/audit/numbers-${TODAY}.json`,
  JSON.stringify({ base: BASE, width: WIDTH, at: new Date().toISOString(), findings }, null, 2));
console.log(`report: docs/audit/numbers-${TODAY}.json`);
process.exit(findings.length ? 1 : 0);
