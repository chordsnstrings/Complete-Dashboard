#!/usr/bin/env node
/* Every page, as a reader actually meets it.
   ─────────────────────────────────────────────────────────────────────────
   Three harnesses already walk this product and none of them would have caught
   what this one is for:

     test/smoke_views.mjs   proves a page RENDERS — no throw, no error box.
     bin/page-audit.mjs     proves the ENDPOINTS behind a page answer.
     bin/live-audit.mjs     proves the NUMBERS on a page add up.

   A view can pass all three and still be a bad page: four panels of which
   three say "no data", a table silently capped at forty rows out of nine
   hundred, a column of dashes where money should be, a figure that reads
   "NaN h", or a row of numbers running off the right edge of a panel because
   nine columns were put in a half-width grid cell.

   So this one opens each address in Chromium against the REAL database and
   inspects the DOM the reader is looking at. Every check below exists because
   the failure it names is invisible to the other three.

       node bin/live-ui.mjs &                 # bridges production
       node bin/render-audit.mjs
       BASE=http://localhost:8099 node bin/render-audit.mjs      # against the mock

   Writes a machine-readable report to docs/audit/render-<date>.json and prints
   the findings grouped by page, worst first. */
import { launchChromium } from '../test/browser.mjs';
import { ROUTES } from '../test/routes_list.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8100';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const SETTLE = Number(process.env.SETTLE || 4500);
const WIDTHS = (process.env.WIDTHS || '1500,1180,820').split(',').map(Number);

const api = async (p) => {
  try { const r = await fetch(`${BASE}${p}`); return r.ok ? await r.json() : null; }
  catch { return null; }
};
const first = (v) => (Array.isArray(v) ? v[0] : (v?.rows?.[0] ?? null));

/* The mock's ids, swapped for whatever the target database actually holds.
   Without this every per-entity route 404s, a "not found" page renders
   cleanly, and the audit reports a clean bill of health for the pages that
   carry all the data. */
const dubai = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const TODAY = dubai(new Date());
const YDAY = dubai(new Date(Date.now() - 864e5));
const WIN = `from=${dubai(new Date(Date.now() - 30 * 864e5))}&to=${TODAY}`;
const [drv, veh, prop, seg] = await Promise.all([
  api(`/api/drivers/directory?${WIN}`), api(`/api/vehicles/directory?${WIN}`),
  api(`/api/corporate/properties?${WIN}`), api(`/api/segments?${WIN}`)]);
const rd = first(drv), rv = first(veh), rp = first(prop), rs = first(seg);
const SUB = {
  'drv-0': rd?.ids?.[0] || rd?.driver_ext_id, 'drv-9': rd?.ids?.[0] || rd?.driver_ext_id,
  L45235: rv?.plate, 'h-palm': rp?.partner_id,
  '2026-08-25': TODAY, '2026-08-24': YDAY, '2026-08-14': YDAY, '2026-08-03': YDAY,
  '2026-08-03T04:00:00.000Z': rs?.started_at || null,
};
const sub1 = (r) => Object.entries(SUB).reduce((acc, [k, v]) =>
  (v ? acc.split(k).join(v) : acc), r);
/* The segment address is (plate, started_at) and BOTH halves must come from
   the SAME row, or the page 404s — which this audit then reported as a
   js-error, an api-error and a blank page on every pass: six findings of its
   own making. Substituted as a pair, before the per-token pass, because the
   plate there is the segment's own and not the directory's first vehicle. */
const subSegment = (r) => (rs?.plate && rs?.started_at
  ? r.replace(/^segment\/[^/]+\/.+$/, `segment/${rs.plate}/${rs.started_at}`)
  : r);
const sub = (r) => sub1(subSegment(r));

const routes = (ONLY || ROUTES).map(sub);

/* ── the checks, each one a failure mode the other harnesses cannot see ──── */
const PROBE = () => {
  const out = { errors: [], warns: [], stats: {} };
  const push = (sev, code, detail) => out[sev === 'e' ? 'errors' : 'warns'].push({ code, detail });
  const root = document.querySelector('#view') || document.body;
  const txt = (n) => (n.textContent || '').trim();

  /* 1. A value that is not a value. These reach the screen as literal text and
        every one of them is a formatter meeting a shape it did not expect. */
  const BAD = /\b(NaN|undefined|null|Infinity|\[object Object\]|Invalid Date)\b/;
  root.querySelectorAll('td, th, .n, .kpi, .cap, p, span, div.note').forEach((n) => {
    if (n.children.length) return;                  // leaves only, so nothing counts twice
    const t = txt(n);
    if (t && BAD.test(t) && t.length < 120) push('e', 'bad-value', t.slice(0, 80));
  });

  /* 2. A panel still loading after the page has settled: the endpoint behind it
        never answered, and nothing on the page says so. */
  const skel = [...root.querySelectorAll('.skel')];
  if (skel.length) push('e', 'stuck-loading', `${skel.length} panel(s) still on the skeleton`);

  /* 3. Panels that rendered nothing. Not an error on its own — an empty state
        is a legitimate answer — but a page that is MOSTLY empty is a page
        nobody can use, and that ratio is the finding. */
  /* ui.js panel(): a div.panel holding an h3, an optional p.cap, and an
     UNCLASSED div as the body. So the body is the panel's last element child,
     and there is no .p-b to look for — a selector that assumed one reported
     every panel on the product as silent. */
  const panels = [...root.querySelectorAll('.panel')].filter((p) => p.querySelector('h3'));
  const head = (p) => txt(p.querySelector('h3'));
  const bodyOf = (p) => {
    const kids = [...p.children].filter((c) => c.tagName !== 'H3' && !c.classList.contains('cap'));
    return kids[kids.length - 1] || null;
  };
  const empties = panels.filter((p) => p.querySelector('.empty'));
  out.stats.panels = panels.length;
  out.stats.empty_panels = empties.length;
  if (panels.length >= 3 && empties.length / panels.length >= 0.5) {
    push('e', 'mostly-empty', `${empties.length} of ${panels.length} panels have no data: `
      + empties.map((p) => head(p).slice(0, 40)).join(' | '));
  } else if (empties.length) {
    /* A panel whose empty state EXPLAINS itself — "no vehicle carries an
       unexplained segment in this range" — is a panel doing its job. The
       generic default is the one worth chasing: it tells the reader nothing
       about whether the answer is empty or the page is. */
    const vague = empties.filter((p) => {
      const e = txt(p.querySelector('.empty'));
      return /No data for this range yet/i.test(e) || e.replace(/Nothing to show/i, '').trim().length < 12;
    });
    if (vague.length) push('w', 'empty-panel', vague.map((p) => head(p).slice(0, 40)).join(' | '));
  }

  /* 4. Missing numbers. A column that is entirely em-dashes is a column that
        should not be there, or a field the collector is not filling — and
        either way the page is claiming to report something it does not. */
  [...root.querySelectorAll('table')].forEach((t) => {
    const heads = [...t.querySelectorAll('thead th')].map(txt);
    const rows = [...t.querySelectorAll('tbody tr')];
    if (rows.length < 3) return;
    heads.forEach((h, i) => {
      const cells = rows.map((r) => txt(r.children[i] || {}));
      const dashes = cells.filter((c) => c === '—' || c === '-' || c === '').length;
      if (dashes === cells.length) push('e', 'dead-column', `"${h}" is empty in all ${cells.length} rows`);
      else if (dashes / cells.length > 0.8) {
        push('w', 'sparse-column', `"${h}" is empty in ${dashes} of ${cells.length} rows`);
      }
    });
    out.stats.rows = (out.stats.rows || 0) + rows.length;
  });

  /* 5. A table cut off without saying so. Row counts that land exactly on a
        round number are almost always a LIMIT, and a reader has no way to tell
        "these are all of them" from "these are the first forty". */
  /* Round numbers a LIMIT actually uses. Ten and twelve are deliberately not
     here: a twelve-row table is far more often twelve months or twelve
     categories than a LIMIT 12, and flagging those buried the real caps —
     forty ranked drivers, sixty occupancy intervals — under twenty false
     ones. Every value below appears as a literal LIMIT somewhere in api/. */
  const CAPS = [20, 25, 30, 40, 50, 60, 90, 100, 120, 150, 200, 300, 400, 500, 600];
  [...root.querySelectorAll('table')].forEach((t) => {
    const n = t.querySelectorAll('tbody tr').length;
    if (!CAPS.includes(n)) return;
    const panel = t.closest('.panel') || root;
    const said = /showing|first|top |of \d|more|capped|limit/i.test(txt(panel));
    if (!said) push('w', 'silent-cap', `a table ends at exactly ${n} rows and nothing says whether that is all of them`);
  });

  /* 6. Content wider than the box holding it. This is the padding class of bug
        the reader sees as a column sliced off at the panel edge. A table inside
        .tscroll is allowed to scroll; anything else is not. */
  const overflow = [];
  root.querySelectorAll('.panel, .kpi, .grid > *').forEach((n) => {
    if (n.scrollWidth > n.clientWidth + 2 && !n.closest('.tscroll')) {
      overflow.push(`${n.className || n.tagName} +${n.scrollWidth - n.clientWidth}px`);
    }
  });
  if (overflow.length) push('e', 'overflow', overflow.slice(0, 4).join(', '));
  if (document.documentElement.scrollWidth > window.innerWidth + 2) {
    push('e', 'page-overflow', `body is ${document.documentElement.scrollWidth - window.innerWidth}px wider than the window`);
  }

  /* 7. Text clipped by its own box. A name cut to "Muhammad Ashraf B…" with no
        title attribute cannot be read at all. */
  const clipped = [];
  root.querySelectorAll('td, th, .kpi .n, .kpi .l, .sh-v, .lgnd span').forEach((n) => {
    if (n.children.length) return;
    if (n.scrollWidth > n.clientWidth + 2 && !n.title) clipped.push(txt(n).slice(0, 30));
  });
  if (clipped.length) push('w', 'clipped-text', `${clipped.length}: ${clipped.slice(0, 4).join(' | ')}`);

  /* 8. A chart panel with no chart in it. An SVG-less chart body reads as a
        broken panel rather than as an absent one. */
  panels.forEach((p) => {
    const h = head(p);
    if (!/chart|by hour|per day|trend|distribution|share|mix|when|shape/i.test(h)) return;
    if (!p.querySelector('svg, canvas, .hb, .shifts, .empty, table')) {
      push('w', 'chartless-panel', h.slice(0, 50));
    }
  });

  /* 9. A heading with nothing under it at all — neither data nor an empty
        state. The reader is left to guess whether it is loading or broken. */
  panels.forEach((p) => {
    const body = bodyOf(p);
    if (body && !body.children.length && !txt(body)) push('e', 'silent-panel', head(p).slice(0, 50));
  });

  /* 10. The page's own headline. A view whose title is another view's name is
         the router failing, and it looks like a working page. */
  /* Did the page SAY something, even if it drew nothing? An empty state, a
     note, or the shell's own failure box all count: the reader is told where
     they are. */
  out.stats.explained = Boolean(root.querySelector('.empty, .note, .failbox, .err'))
    && txt(root).length > 20;
  out.stats.title = txt(document.querySelector('#viewTitle'));
  out.stats.kpis = root.querySelectorAll('.kpi').length;
  out.stats.tables = root.querySelectorAll('table').length;
  out.stats.charts = root.querySelectorAll('svg').length;
  return out;
};

/* ── run ─────────────────────────────────────────────────────────────────── */
const browser = await launchChromium();
const findings = [];
let checked = 0;

for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: 1100 } });
  const live = { js: [], net: [] };
  /* Environment noise, not product findings. Chromium in this sandbox does not
     honour the egress proxy, so every request to a host that is not 127.0.0.1
     dies with a certificate error — the web font, and nothing else. Suppressed
     by CAUSE rather than by muting console errors wholesale, so a genuine
     failed fetch still reports. */
  const NOISE = /ERR_CERT_|ERR_PROXY|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|fonts\.(googleapis|gstatic)/;
  const keep = (t) => t && !NOISE.test(t);
  page.on('pageerror', (e) => { const t = String(e.message).slice(0, 160); if (keep(t)) live.js.push(t); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text().slice(0, 160);
    if (keep(t)) live.js.push(t);
  });
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) {
      live.net.push(`${r.status()} ${r.url().replace(BASE, '')}`.slice(0, 140));
    }
  });

  let n = 0;
  for (const route of routes) {
    live.js.length = 0; live.net.length = 0;
    /* Printed as it goes. A silent hour-long run is indistinguishable from a
       hung one, and the first version of this WAS effectively hung — it was
       started before a deploy, so every page met a restarting API and sat on
       the sixty-second navigation timeout. */
    process.stderr.write(`\r[${width}px ${++n}/${routes.length}] ${route.slice(0, 46).padEnd(46)}`);
    let probe;
    try {
      await page.goto(`${BASE}/#${route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(SETTLE);
      probe = await page.evaluate(PROBE);
    } catch (e) {
      findings.push({ route, width, sev: 'e', code: 'crashed', detail: String(e.message).slice(0, 160) });
      continue;
    }
    checked += 1;
    /* A view that titles itself after another view is the router failing, and
       it renders perfectly while doing it. Only checkable out here, where the
       route that was asked for is known. */
    const head = String(route).split(/[/?]/)[0];
    if (probe.stats.title === 'Unit economics' && head !== 'unit' && head !== '') {
      findings.push({ route, width, sev: 'e', code: 'wrong-title',
        detail: `#${route} is titled "Unit economics"` });
    }
    live.js.forEach((d) => findings.push({ route, width, sev: 'e', code: 'js-error', detail: d }));
    live.net.forEach((d) => findings.push({ route, width, sev: 'e', code: 'api-error', detail: d }));
    probe.errors.forEach((f) => findings.push({ route, width, sev: 'e', ...f }));
    probe.warns.forEach((f) => findings.push({ route, width, sev: 'w', ...f }));
    /* A page with no numbers on it at all. Not every view is a table, but a
       view with no KPI, no table, no chart and no empty state is a view that
       is not showing anything. */
    const s = probe.stats;
    /* An address that cannot resolve — a malformed day, an unknown finding, an
       hour outside the week — SHOULD render one explanation and nothing else.
       That is the page working. Counting it as blank flagged six correct
       routes on every pass and buried whatever else was on them. A page with
       no content AND no explanation is still a finding. */
    if (!s.kpis && !s.tables && !s.charts && !s.panels && !s.explained) {
      findings.push({ route, width, sev: 'e', code: 'blank-page',
        detail: 'no kpi, table, chart or panel, and nothing explaining why' });
    }
    if (width === WIDTHS[0]) {
      findings.push({ route, width, sev: 'i', code: 'stats', detail: JSON.stringify(s) });
    }
  }
  await page.close();
}
await browser.close();

/* ── report ──────────────────────────────────────────────────────────────── */
const real = findings.filter((f) => f.sev !== 'i');
const byRoute = new Map();
real.forEach((f) => {
  if (!byRoute.has(f.route)) byRoute.set(f.route, []);
  byRoute.get(f.route).push(f);
});
const order = [...byRoute.entries()].sort((a, b) =>
  b[1].filter((f) => f.sev === 'e').length - a[1].filter((f) => f.sev === 'e').length
  || b[1].length - a[1].length);

const seen = new Set();
for (const [route, fs] of order) {
  const errs = fs.filter((f) => f.sev === 'e');
  console.log(`\n#${route}  ${errs.length ? `${errs.length} error(s)` : ''} ${fs.length - errs.length} warning(s)`);
  const dedup = new Map();
  fs.forEach((f) => {
    const k = `${f.code}|${f.detail}`;
    if (!dedup.has(k)) dedup.set(k, { ...f, widths: [] });
    dedup.get(k).widths.push(f.width);
  });
  [...dedup.values()].sort((a, b) => (a.sev === b.sev ? 0 : a.sev === 'e' ? -1 : 1))
    .forEach((f) => {
      console.log(`  ${f.sev === 'e' ? '✗' : '·'} ${f.code}  ${f.detail}`
        + (f.widths.length < WIDTHS.length ? `   [${f.widths.join(',')}px]` : ''));
      seen.add(f.code);
    });
}

const counts = {};
real.forEach((f) => { counts[f.code] = (counts[f.code] || 0) + 1; });
console.log('\n─────────────────────────────────────────────');
console.log(`${checked} page-renders across ${WIDTHS.length} widths, ${byRoute.size} routes with findings`);
console.log(Object.entries(counts).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${v}`).join('  ·  '));

mkdirSync('docs/audit', { recursive: true });
const out = `docs/audit/render-${TODAY}.json`;
writeFileSync(out, JSON.stringify({ base: BASE, at: new Date().toISOString(),
  widths: WIDTHS, routes: routes.length, findings }, null, 2));
console.log(`\nreport: ${out}`);
process.exit(real.some((f) => f.sev === 'e') ? 1 : 0);
