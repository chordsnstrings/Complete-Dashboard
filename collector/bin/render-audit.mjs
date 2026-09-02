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
/* Token pass FIRST, pair pass second.
   ─────────────────────────────────────────────────────────────────────────
   This was the other way round, and the comment above explaining why the pair
   substitution exists was describing an order that defeats it. subSegment
   writes the real (plate, started_at) into the route; sub1 then walks the SUB
   table replacing date tokens ANYWHERE in the string, and SUB maps
   '2026-08-25' to today — so a segment that began at 2026-08-25T19:58:57.077Z
   was asked for at 2026-08-26T19:58:57.077Z and the API answered, correctly,
   "no segment starts at that instant for that plate". The audit reported a
   404 and a js-error on every pass, both of its own making.

   subSegment replaces the whole route, so running it last makes it immune to
   anything the token pass did to the placeholder. */
const sub = (r) => subSegment(sub1(r));

const routes = (ONLY || ROUTES).map(sub);

/* ── the checks, each one a failure mode the other harnesses cannot see ──── */
const PROBE = () => {
  const out = { errors: [], warns: [], stats: {} };
  const push = (sev, code, detail) => out[sev === 'e' ? 'errors' : 'warns'].push({ code, detail });
  const root = document.querySelector('#view') || document.body;
  const txt = (n) => (n.textContent || '').trim();

  /* 0. The view that threw and CAUGHT ITSELF.
        ─────────────────────────────────────────────────────────────────────
        This harness listens for `pageerror`, which fires only for an exception
        that reaches the window. app.js:4890 failureBox() catches every view's
        throw and renders `<div class="empty"><b>Could not load this view</b>`
        instead — so a page replaced entirely by an error box raises nothing,
        and everything below this line then measures the error box and finds it
        healthy.

        Measured on production 2026-09-02: #supply was dead — `d is not
        defined`, the whole body an error box, no grid, no table, no figure —
        and this file rendered it and reported ZERO findings. Re-verified by
        reintroducing the fault deliberately: 1 page-render, 0 routes with
        findings, on a page a reader cannot use at all. That is the worst thing
        an audit tool can do, because it is the one that gets believed.

        The class is `empty`, shared with legitimate empty states, so the <b>
        is what separates them. Reported as an error and returned on, because
        every other check below is about a page that rendered. */
  const failed = [...root.querySelectorAll('.empty > b')]
    .find((b) => /^Could not load this view/.test(txt(b)));
  if (failed) {
    const why = txt(failed.parentNode).replace(/^Could not load this view/, '').replace(/Try again$/, '');
    push('e', 'view-failed', (why.trim() || 'no reason given').slice(0, 120));
    out.stats.title = (document.title || '').replace(/\s*[·|—-].*$/, '').trim();
    return out;
  }

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
    /* What the table already SAYS about its own gaps. ui.js prints a .tabsent
       line per column that declared why it can be empty — "Fares — 31 of 361
       rows carry one; Uber's trip export carries no fare column". A column
       that explains itself is a column doing its job, and flagging it anyway
       is how a harness teaches people to ignore it. The empty column itself is
       still reported when nothing explains it. */
    /* Looked for in the table's BLOCK, not inside the scroller.
       ─────────────────────────────────────────────────────────────────────
       ui.js used to append the .tabsent line inside .tscroll, and it was moved
       out: a note is prose and has no business being as wide as a fourteen-
       column table, so tableFrom now wraps the scroller and its notes in a
       .tblock and the note is a SIBLING of .tscroll. This kept looking inside
       the scroller, found nothing, and reported 51 sparse columns that were
       each explaining themselves one line below the table — including all four
       of the reconciliation money columns, which share a single sentence.

       Both are checked, so the note is found wherever tableFrom decides to put
       it, and the panel is the last resort for a caller that prints its own. */
    /* And a caption counts as an explanation, not only a .tabsent line.
       ─────────────────────────────────────────────────────────────────────
       `absent` — and the .tabsent note it prints — removes a column that is
       empty on EVERY row. It cannot say anything about a column that is empty
       on most of them, which is the case this rule is for, so the answer to a
       sparse column is a sentence under the table and never a .tabsent line.
       Four pages now carry one and every one of them was still being reported.

       Two things are required of the sentence, so that any prose under a table
       does not silence the rule: it must NAME the column, and it must say
       something about emptiness. A caption describing what the column means is
       a definition, and a definition is what the reader already had. */
    /* The block AND the panel around it: tableFrom puts its own .tabsent note
       in the .tblock, and a caller writing its own sentence appends it to the
       panel body, a sibling of the block. Looking only at the nearest of the
       two found the first kind and none of the second. */
    const scopes = [t.closest('.tblock'), t.closest('.panel'), t.closest('.tscroll'), t.parentElement]
      .filter((x, i, a) => x && x.querySelectorAll && a.indexOf(x) === i);
    const EMPTINESS = /empty|carries no|carry no|records? none|publish(es)? no|not recorded|no rate|absent|blank|a dash/i;
    /* A .tabsent line is BY CONSTRUCTION a sentence about an absent column —
       tableFrom prints it for nothing else — so it counts whatever words it
       chose. The emptiness test is for ordinary prose, where a caption
       DEFINING a column would otherwise silence the rule; requiring it of
       .tabsent as well reported five columns that were explaining themselves
       in the product's own words. */
    /* .note as well as p.cap. A view that explains an empty column in a note
       INSIDE the panel was reported anyway, because this only read captions —
       and the two are the same kind of prose in the same place. The emptiness
       test still applies to both, so a note that merely defines the column
       does not silence the rule. A note OUTSIDE the panel is deliberately
       still not counted: a sentence a reader has to leave the table to find is
       not beside the column it is about. */
    const notes = [
      ...scopes.flatMap((sc) => [...sc.querySelectorAll('.tabsent')].map(txt)),
      ...scopes.flatMap((sc) => [...sc.querySelectorAll('p.cap, .note')].map(txt))
        .filter((x) => EMPTINESS.test(x)),
    ];
    /* Without the sort indicator a sortable header carries: the sentence names
       the column, and "Value known↓" is not a phrase anybody would write. */
    const bare = (h) => h.replace(/[↓↑▲▼]/g, '').trim();
    heads.forEach((h, i) => {
      const cells = rows.map((r) => txt(r.children[i] || {}));
      const dashes = cells.filter((c) => c === '—' || c === '-' || c === '').length;
      const said = notes.some((x) => x.includes(bare(h)));
      if (dashes === cells.length) push('e', 'dead-column', `"${h}" is empty in all ${cells.length} rows`);
      else if (dashes / cells.length > 0.8 && !said) {
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
    /* A panel that CLAIMS totality and prints the count is not a silent cap:
       "Every driver with an event — 20 rows" tells a reader exactly what the
       phrases above tell them, in the words the product happens to use. The
       claim alone is not enough and neither is the number alone — a heading
       saying "every" over a list the endpoint capped is the failure this rule
       is for, and #safety was making exactly that claim until the page learned
       to read its own truncated flag. */
    const ptxt = txt(panel);
    /* A FOLD is not a cap. foldRows() renders the first N rows with a control
       reading "Show the other 18 people →" underneath — the rest are one click
       away and the count is on the button. #cohort/roster-blocked was reported
       three times over for a table that said exactly what this rule asks of
       it, in words the regex happened not to carry. */
    const said = /showing|first|top |of \d|more|capped|limit|show the other/i.test(ptxt)
      || (/\b(every|all)\b/i.test(ptxt) && new RegExp(`\\b${n}\\b`).test(ptxt));
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
  /* Map tiles are the other half of this. Chromium here cannot reach a host
     that is not 127.0.0.1, and OpenStreetMap's tile servers fail with
     ERR_CONNECTION_RESET rather than any of the proxy errors above — so every
     tile fetch on #map, #roster and #compliance was reported as a broken page,
     forty-nine of them in one pass. They load perfectly in a reader's browser.
     Matched on the HOST rather than on the error code, so a reset talking to
     the app itself is still a finding. */
  const NOISE = new RegExp([
    'ERR_CERT_', 'ERR_PROXY', 'ERR_TUNNEL', 'ERR_NAME_NOT_RESOLVED',
    'fonts\\.(googleapis|gstatic)',
    'tile\\.openstreetmap\\.org', '\\.tile\\.', 'basemaps\\.',
    /* Vehicle photographs, served by the platform that owns the record. Same
       shape as the tiles: an external host this sandbox cannot reach and a
       reader's browser can. The page no longer shows a broken-image icon when
       it fails, which is the part that WAS a product bug. */
    'tb-static\\.uber\\.com',
  ].join('|'));
  const keep = (t) => t && !NOISE.test(t);
  page.on('pageerror', (e) => { const t = String(e.message).slice(0, 160); if (keep(t)) live.js.push(t); });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text().slice(0, 160);
    /* Chromium logs a bare "Failed to load resource: net::ERR_…" alongside the
       requestfailed event above, naming nothing. Every request failure is
       already recorded WITH its URL, so this duplicate can only add an
       unactionable line — and it is the line that survived the host filter,
       because there is no host in it to match. Dropped; anything else the
       console says is kept. */
    if (/^Failed to load resource/.test(t)) return;
    if (keep(t)) live.js.push(t);
  });
  /* A failed request, WITH its URL.
     ─────────────────────────────────────────────────────────────────────────
     Chromium's console line for a dead request is "Failed to load resource:
     net::ERR_CONNECTION_RESET" and names nothing, so a run reporting fifty of
     them says fifty pages are broken and gives no way to find out what broke.
     `requestfailed` carries the URL and the error text; recorded here so the
     finding is actionable instead of atmospheric. The console line is still
     kept — it catches errors that never became a request at all. */
  page.on('requestfailed', (r) => {
    const t = `${r.failure()?.errorText || 'failed'} ${r.url().replace(BASE, '')}`.slice(0, 150);
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
      /* A skeleton is a page that has not answered YET, and one settle is not
         evidence that it never will. #sources asks /api/coverage, which its own
         warmer comment calls a twenty-second query, and it reported
         "stuck-loading" on a panel that fills at about eleven — a finding about
         this harness's patience rather than about the page.

         So a page still showing a skeleton gets the settle again, once. What
         survives that is a panel whose endpoint did not answer, which is the
         thing the check exists to catch. A slow page is still worth knowing
         about, so the extra wait is reported rather than hidden. */
      if (await page.$('.skel')) {
        await page.waitForTimeout(SETTLE * 2);
        if (!(await page.$('.skel'))) {
          findings.push({ route, width, sev: 'w', code: 'slow-panel',
            detail: `a panel needed more than ${SETTLE}ms to fill — it renders, but a reader `
              + 'waits on a skeleton first' });
        }
      }
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

/* REPORT_DIR for the same reason numbers-audit has one: a test that drives
   this tool must not overwrite the production sweep it is named after. */
/* A run that could not REACH the site is not a run that found 114 defects.
   ─────────────────────────────────────────────────────────────────────────
   Measured on 2026-09-02: with four Chromium sweeps and a fleet of agents all
   pulling on production through the same egress proxy at once, the proxy began
   resetting connections, and every route in turn recorded
   `crashed net::ERR_CONNECTION_RESET at .../#<route>`. The tool then wrote a
   report naming 114 of 116 routes as findings, exited 1, and looked exactly
   like a dashboard that had collapsed — while /api/kpis answered 200 in 0.9s
   the whole time. An audit that cannot tell "the site is broken" from "I could
   not get to the site" is worse than no audit: it is a false alarm with a
   machine-readable file behind it.

   So a transport failure is counted separately and, past a third of the run,
   the whole sweep is declared UNUSABLE: no report is written, because a report
   is a claim about the product, and nothing here observed the product. */
const TRANSPORT = /ERR_CONNECTION_(RESET|CLOSED|REFUSED|ABORTED)|ERR_NETWORK|ERR_EMPTY_RESPONSE|ERR_SOCKET|ECONNRESET|socket hang up|ERR_TUNNEL|net::ERR_TIMED_OUT|Timeout .* exceeded.*goto/i;
const transportFailures = findings.filter(
  (f) => f.code === 'crashed' && TRANSPORT.test(String(f.detail || '')));
/* Page-RENDERS, not routes: this tool sweeps every route at each width, so the
   denominator is the number of attempts it actually made. */
const attempts = routes.length * WIDTHS.length;
if (transportFailures.length > attempts / 3) {
  console.error(`\n${transportFailures.length} of ${attempts} page-renders could not be REACHED `
    + `(${String(transportFailures[0].detail).slice(0, 80)}).`);
  console.error('This is a transport failure, not a finding. Nothing about the product was '
    + 'observed, so no report is written. Re-run when the network is quiet — one sweep at a '
    + 'time, and not while other jobs are pulling on the same host.');
  process.exit(2);
}

const REPORT_DIR = process.env.REPORT_DIR || 'docs/audit';
mkdirSync(REPORT_DIR, { recursive: true });
const out = `${REPORT_DIR}/render-${TODAY}.json`;
writeFileSync(out, JSON.stringify({ base: BASE, at: new Date().toISOString(),
  widths: WIDTHS, routes: routes.length, findings }, null, 2));
console.log(`\nreport: ${out}`);
process.exit(real.some((f) => f.sev === 'e') ? 1 : 0);
