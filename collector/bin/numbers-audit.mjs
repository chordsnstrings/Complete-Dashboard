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
       EXPLAIN=1 node bin/numbers-audit.mjs     # …and why a page said nothing
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
const sub1 = (r) => Object.entries(SUB).reduce((a, [k, v]) => (v ? a.split(k).join(v) : a), r);

/* A segment is addressed by (plate, started_at) and BOTH halves have to come
   from the SAME row, or the page 404s and this harness audits an error box
   while reporting the route as clean. There was no substitution here at all,
   so #segment has never actually been checked by the numbers pass.

   Applied AFTER the token pass, not before. The token table maps '2026-08-25'
   to today, and it will happily rewrite that date INSIDE a timestamp this
   function just wrote — which is exactly the bug that had render-audit asking
   for a segment one day after the one it had looked up. subSegment replaces
   the whole route, so running it last makes it immune. */
const seg1 = await (async () => {
  const d = await api(`/api/segments?${WIN}`);
  const rows = Array.isArray(d) ? d : (d?.rows || []);
  return rows[0] || null;
})();
const subSegment = (r) => (seg1?.plate && seg1?.started_at
  ? r.replace(/^segment\/[^/]+\/.+$/, `segment/${seg1.plate}/${seg1.started_at}`)
  : r);
const sub = (r) => subSegment(sub1(r));

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
/* EVERY name a row could be drawn under, not the first one on this list.
   ─────────────────────────────────────────────────────────────────────────
   This used to return one identity: the first key present, with `plate` at the
   head of the list. Which is right for a vehicle row and wrong for a driver
   row that happens to name the car — and /api/drivers/directory names the car,
   under "Usual vehicle". So every row of that endpoint was identified as a
   PLATE while the table it is drawn in leads with the person's name, no row
   ever matched, and the figure was skipped as "not drawn here".

   Measured on #drivers against the live API, with every figure over a thousand
   on the page deliberately multiplied by three: 488 payload figures, three
   tables, 395 rows on screen — and this audit reported no findings at all. It
   had not been checking that page for some time; it had been failing to find
   the rows.

   So a row offers every identity it carries, in this order, and the matcher
   below takes the first that names a row the page is actually showing. A
   candidate that matches nothing costs nothing; the one that matches is the
   one the table is keyed on. */
const ID_KEYS = ['plate', 'driver_name', 'name', 'm', 'month', 'day', 'area', 'place',
  'platform', 'category', 'label', 'source', 'partner_name', 'property', 'from_area'];
const identitiesOf = (row) => {
  const out = [];
  for (const k of ID_KEYS) {
    const v = row[k];
    if (typeof v === 'string' && v.trim().length > 1 && !out.includes(v.trim())) out.push(v.trim());
  }
  return out;
};

/* Every (identity, figure) pair in a payload, from the lists inside it. */
function rowFigures(o, out = [], where = '') {
  if (Array.isArray(o)) {
    const slice = o.slice(0, 80);
    /* How many ROWS of this list each identity stands for, counted before the
       size filter below throws most of their fields away. /api/status holds
       four `fms` records and two `hotel` ones; the source panel shows the
       latest of each, which is what the panel is for. Counting the survivors
       instead missed that entirely — hotel's other run wrote 136 rows, under
       the thousand this audit looks at, so the identity looked unique and one
       backfill total was demanded on screen. */
    const rowsWithId = new Map();
    for (const r of slice) {
      if (!r || typeof r !== 'object') continue;
      for (const id of identitiesOf(r)) rowsWithId.set(id, (rowsWithId.get(id) || 0) + 1);
    }
    slice.forEach((r) => {
      if (!r || typeof r !== 'object') return;
      const ids = identitiesOf(r);
      if (!ids.length) return;
      const siblings = Object.keys(r);
      for (const [k, v] of Object.entries(r)) {
        if (!isNum(v)) continue;
        const n = big(v);
        if (n != null) {
          out.push({ id: ids[0], ids, key: k, n, where, siblings,
            /* per identity, because "how many payload rows share this name"
               has a different answer for the person and for the car they
               drive, and the guard below has to ask about the one the table
               is actually keyed on. */
            rowsBy: Object.fromEntries(ids.map((x) => [x, rowsWithId.get(x) || 1])) });
        }
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
    /* An EXPLICIT window, and an empty cache before it.
       ─────────────────────────────────────────────────────────────────────
       A bare `#route` inherits whatever window the previous route's drift
       check left in localStorage, and data.js paints a cached copy before
       revalidating — so the payload this listener captured and the numbers
       on screen could belong to two different windows. That is what
       reported nine perfectly displayed figures on #vehicles: the DOM said
       801 for a 7-day window, the captured payload said 1,286 for a
       30-day one, and the page had rendered exactly what it was given.
       Pinning the window and dropping the store makes the two comparable. */
    await page.goto(`${BASE}/#${route}${route.includes('?') ? '&' : '?'}days=30`,
      { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.evaluate(() => { try { localStorage.removeItem('fleet.swr.v1'); } catch { /* none */ } });
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
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
    /* Every text node, joined by a space — not innerText.
       ───────────────────────────────────────────────────────────────────
       innerText separates table cells with a tab only while they are laid
       out as cells. At 412px they are not, and a row came back as one
       unbroken string: "L46174" and "2025" fused into "461742025", the
       Alerts value fused with its neighbours, and nine figures that were
       plainly on screen were reported missing. Text nodes carry their own
       boundaries whatever the display mode. */
    const words2 = (el) => {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const out = []; let node;
      while ((node = w.nextNode())) out.push(node.nodeValue);
      return out.join(' ');
    };
    /* Each table as the reader meets it: what its columns are called, and what
       each row says. The check needs both — a figure only counts as missing if
       the table HAS a column for it and the row is on screen without it. */
    const tables = [...root.querySelectorAll('table')].map((t) => ({
      heads: [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim()),
      keys: [...t.querySelectorAll('thead th')].map((h) => h.getAttribute('data-key') || ''),
      rows: [...t.querySelectorAll('tbody tr')].map((r) => ({
        /* A row is ABOUT its first cell. Matching the identity anywhere in the
           row found a driver's name in the "Held by" column of a VEHICLE row
           and then demanded that driver's earnings appear in a row describing
           a car — four findings that were the matcher's fault, not the page's. */
        subject: ((r.children[0] || {}).textContent || '').trim().toLowerCase(),
        text: words2(r).toLowerCase(),
        nums: norm(words2(r)).split(/\s+/).filter(Boolean),
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
    return { tables, looseTables: loose.length, indexPinned, page: norm(words2(root)).split(/\s+/).filter(Boolean) };
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
  const columnFor = (heads, key, keys) => {
    /* The column's own field name settles it when the table carries one.
       Matching on the words of a HEADING made "Rows written" (rows_24h, every
       write in the last day) accept rows_written (one run's all-time total)
       from a different endpoint, and reported a column correctly reading 0. */
    if (keys && keys.length) {
      const at = keys.indexOf(key);
      if (at !== -1) return heads[at];
      if (keys.some(Boolean)) return null;
    }
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
  /* Every NUMERIC field each endpoint offers per identity, whatever its size.
     The rival test below has to see fields the thousand-row floor throws
     away: the source table's rows_24h is 0 for the ledger, and 0 never
     becomes a figure, so the collision it causes was invisible. */
  const keysAt = new Map();
  const allIds = new Map();
  /* …and WHICH identity field each endpoint's rows carry it in. A table that
     labels its first column (`data-key="name"`, `data-key="driver_name"`) has
     named the field its rows are drawn from, and an endpoint whose rows have
     no such field cannot have drawn it — /api/platforms carries `platform`
     and nothing else, so it can never be the source of a table of properties
     however many property names happen to contain the word "hotel". */
  const idFieldsAt = new Map();
  latest.forEach((body, u) => {
    const url = u.split('?')[0];
    const walk = (o) => {
      if (Array.isArray(o)) {
        /* Every row, not the first eighty. The slice was a bound on work and
           it silently bounded CORRECTNESS: the identities collected here are
           what stops a loose match landing on somebody else's row, and the
           roster carries 336 people. Anoj Gautam Mohan Bahadur sits well past
           the eightieth, so he was not in the set, and Anoj Gautam's payout
           was demanded of his row. Collecting a name and a set of key names
           per row costs nothing worth bounding. */
        for (const r of o.slice(0, 5000)) {
          if (!r || typeof r !== 'object') continue;
          const fields = idFieldsAt.get(url) || new Set();
          for (const k of ID_KEYS) {
            if (typeof r[k] === 'string' && r[k].trim().length > 1) fields.add(k);
          }
          if (fields.size) idFieldsAt.set(url, fields);
          /* Under every name the row could be drawn as, for the same reason
             identitiesOf returns them all: the table decides which of a row's
             names is its subject, and this side does not get to guess. */
          for (const id of identitiesOf(r)) {
            const k = `${url}|${id}`;
            const set = keysAt.get(k) || new Set();
            for (const [kk, vv] of Object.entries(r)) if (isNum(vv)) set.add(kk);
            keysAt.set(k, set);
          /* Every identity, not only the ones that produced a figure.
             ─────────────────────────────────────────────────────────────
             This set exists to stop a loose match landing on somebody else's
             row, and it was built from `pairs` — the rows that carried a
             number big enough to be worth checking. A person with no output
             carries none, so the roster's "Anoj Gautam Mohan Bahadur" was not
             in it, and the guard let "Anoj Gautam"'s payout be demanded of
             his row. The people this catches are exactly the people with
             nothing in their row. */
            const ids = allIds.get(url) || new Set();
            ids.add(String(id).toLowerCase().trim());
            allIds.set(url, ids);
          }
        }
        return;
      }
      if (o && typeof o === 'object') Object.values(o).forEach(walk);
    };
    walk(body);
  });

  /* Every identity each endpoint names, so a loose match can be stopped from
     landing on a row that belongs to a different one. Built by the walk above,
     which sees every row rather than only the ones carrying a figure. */
  const idsByUrl = allIds;

  /* ── what a drawn row is CALLED, and which endpoint drew it ──────────────
     A page fetches several endpoints and draws several tables, and until now
     nothing tied one to the other: any payload row whose identity turned up
     in any table's first cell was demanded of that table. Both halves of that
     went wrong on production on 2026-09-02, and neither page was at fault.

     #corporate/properties draws one table, from /api/corporate/properties,
     six properties over the chosen window. It also fetches /api/platforms for
     the provenance line — the collector's inventory, one row per CHANNEL, all
     time. The channel row `hotel` carries bookings 1632; the table has a
     Bookings column; and "Le Meridien Dubai Hotel & Conference Centre"
     contains the word "hotel". So a channel's all-time total was demanded of
     a property's windowed row. The page was right twice over: its six rows
     sum to 899, and the provenance line under them reads "Hotel 899", which
     is /api/platforms' own window_bookings for that channel. 1632 is not a
     number that belongs anywhere on that page.

     #overview draws "Top drivers" — twelve rows of /api/drivers/leaderboard,
     which returns a hundred. Rank 4 is Muhammad Khalid Gul (4d4eb2c1…,
     L94178, 9,060 km, all correctly on screen) and further down, undrawn, is
     a different man: Muhammad Khalid (76ede4ae…, L90721, 3,526 km). The
     prefix guard below already knew about that pair — but it tested the whole
     first cell against the endpoint's names, and the cell reads
     "4Muhammad Khalid Gul": the rank sits in the same cell with no separator,
     so the cell was not recognised as Gul's, and the undrawn man's kilometres
     were demanded of the drawn man's row.

     Both are the same mistake. So a row's subject is resolved to the identity
     an endpoint actually knows it by — the name it LEADS with, longest where
     several start together, which reads a rank off the front and a badge off
     the end — and a table is only checked against the endpoints that name
     its rows. */
  const subjectAs = (subject, ids) => {
    if (ids.has(subject)) return subject;              // the ordinary case, O(1)
    let best = null, at = Infinity;
    for (const id of ids) {
      if (id.length < 2 || id.length > subject.length) continue;
      const i = subject.indexOf(id);
      /* Earliest, then longest. Earliest because a cell leads with what it is
         about and trails with decoration; longest because "Muhammad Khalid"
         and "Muhammad Khalid Gul" both start at the same offset in
         "4Muhammad Khalid Gul" and only one of them is who the row is. */
      if (i === -1 || i > at) continue;
      if (i < at || id.length > best.length) { best = id; at = i; }
    }
    return best;
  };
  /* Resolved once per (table, endpoint), not once per figure.
     The matcher asks this for every payload figure against every row of every
     table: #drivers is 488 figures, three tables and 395 rows against a
     directory naming 790 identities, which is a scan the audit would do
     something like a billion times a page. Each answer depends only on the
     row and the endpoint, so it is computed on first use and kept. */
  const resolved = new Map();
  const subjectsOf = (ti, url) => {
    const k = `${ti}|${url}`;
    let v = resolved.get(k);
    if (!v) {
      const ids = idsByUrl.get(url) || new Set();
      v = dom.tables[ti].rows.map((r) => subjectAs(r.subject.trim(), ids));
      resolved.set(k, v);
    }
    return v;
  };
  /* Which endpoints drew this table. Two questions, the exact one first:

     1. The table's first column usually carries a data-key — the field its
        subject is drawn from. Only endpoints whose rows have that field can
        have drawn it. #corporate/properties' table says data-key="name" and
        /api/platforms has no `name` on any row, so it is out on the spot.
     2. Where no endpoint offers that field (an unlabelled table, or a column
        named differently from the payload), fall back to a vote: how many of
        the table's rows can this endpoint name at all. Measured on
        #corporate/properties — /api/corporate/properties names 6 of 6,
        /api/platforms names 2 by having "hotel" inside a property's name.
        Half of the best coverage is the line: it keeps a second endpoint that
        genuinely feeds the same table (ordinary) and drops one that merely
        collides with a couple of rows.

     The vote is over the whole table, because subjectsOf has resolved it
     already and a half-count would only be a different kind of guess. */
  const ownersOf = (t, ti) => {
    const key0 = (t.keys || [])[0] || '';
    const claims = key0 ? [...idFieldsAt].filter(([, fs]) => fs.has(key0)).map(([u]) => u) : [];
    const pool = claims.length ? new Set(claims) : null;
    const cover = new Map();
    for (const url of idsByUrl.keys()) {
      if (pool && !pool.has(url)) continue;
      const c = subjectsOf(ti, url).filter(Boolean).length;
      if (c) cover.set(url, c);
    }
    const best = Math.max(0, ...cover.values());
    return new Set([...cover].filter(([, c]) => c * 2 >= best).map(([u]) => u));
  };
  const owners = dom.tables.map(ownersOf);

  /* How many payload rows one endpoint offers under the same identity. */
  const idCount = new Map();
  for (const f of pairs) {
    for (const cand of f.ids) {
      const k = `${f.url}|${cand}`;
      idCount.set(k, Math.max(idCount.get(k) || 1, f.rowsBy?.[cand] || 1));
    }
  }

  const onPage = new Set(dom.page);
  const anywhere = (v) => onPage.has(String(v)) || onPage.has(String(v - 1)) || onPage.has(String(v + 1));

  /* A field the page shows in different UNITS is shown.
     `on_trip_s` is seconds and the column prints hours off `on_trip_min`; both
     are the same measurement and the row carries both. So a key is skipped
     when its own row holds a sibling sharing its stem — the page is free to
     render whichever of them reads better. */
  const STEM = /_(s|ms|sec|secs|min|mins|hours|hrs|km|m|pct|percent)$/;
  const missing = [];
  /* WHY this page produced no findings, on request.
     ─────────────────────────────────────────────────────────────────────
     Every guard below is a reason to say nothing, and each of them is right
     about the case it was written for. Together they are also how this audit
     went quiet on a page it had stopped being able to read: 488 figures in,
     none compared, "0 findings" out — which is indistinguishable from a page
     that is correct. EXPLAIN=1 prints the funnel, so "nothing found" can be
     told apart from "nothing checked". */
  const D = { col: 0, foreign: 0, rows: 0, granular: 0, rival: 0, compared: 0 };
  for (const f of pairs) {
    if (STEM.test(f.key) && f.siblings.some((k) => k !== f.key
      && k.replace(STEM, '') === f.key.replace(STEM, ''))) continue;
    for (const [ti, t] of dom.tables.entries()) {
      const col = columnFor(t.heads, f.key, t.keys);
      if (!col) continue;
      D.col += 1;
      /* A table this endpoint did not draw.
         ─────────────────────────────────────────────────────────────────
         #corporate/properties fetches /api/platforms for its provenance
         line and draws one table, of properties. /api/platforms' `hotel`
         row — the channel, 1632 bookings all time — landed in that table
         because a property is called "Le Meridien Dubai Hotel & Conference
         Centre" and the table has a Bookings column. The page's own figure
         for that channel and window is 899: the six rows sum to it and the
         provenance line prints it. A figure is only owed by the table its
         own endpoint fed; continue, because another table on the page may
         be that one. */
      if (!owners[ti].has(f.url)) { D.foreign += 1; continue; }
      /* EVERY row carrying this identity, not the first.
         A platform name is not unique — /api/revenue has an `uber` row per
         fleet and per month, and /api/platforms one per fleet — so matching
         the first and then failing to find another row's value there reported
         six perfectly displayed figures as missing. The claim being tested is
         "this value is nowhere in its own column", so all the candidate rows
         are searched. */
      /* Each name the row could be drawn under, in order, until one of them
         names a row this table is showing. A driver row from
         /api/drivers/directory carries both the person and their usual plate;
         the directory table is keyed on the person and the vehicle table on
         the plate, and neither side should have to guess which. */
      /* RESOLVE the cell, do not test it.
         ─────────────────────────────────────────────────────────────────
         "Muhammad Khalid" is a prefix of "Muhammad Khalid Gul" — two
         different drivers of this fleet, 76ede4ae… on L90721 and 4d4eb2c1…
         on L94178, one account each — so a substring match hands the first
         man's figure to the second man's row and calls a correctly drawn
         table wrong. This was known: the rule was exact match first, and a
         substring fallback that refused any cell the endpoint knew as
         somebody else's name.

         It refused on the WHOLE cell, and a cell carries more than the
         identity — a rank in front of a name, a plate beside a badge. On
         #overview the Top drivers cell reads "4Muhammad Khalid Gul", with
         the rank in the same cell and no separator; "muhammad khalid gul" is
         not equal to that string, so the guard did not fire, the prefix went
         through, and the undrawn man's 3,526 km was demanded of the drawn
         man's row — whose own 9,060 was on screen and correct.

         So the cell is resolved to the name the endpoint knows it by
         (subjectAs, above) and compared to that. "4Muhammad Khalid Gul"
         resolves to Gul and to nobody else. When a man's own row is simply
         not drawn — the table is sorted and cut to twelve of a hundred — the
         honest answer is no row at all. */
      let want = null, rows = [];
      const as = subjectsOf(ti, f.url);
      for (const cand of (f.ids || [f.id])) {
        want = String(cand).toLowerCase().trim();
        rows = t.rows.filter((r, ri) => as[ri] === want);
        if (rows.length) break;
      }
      if (!rows.length) continue;                          // this row is not drawn here
      D.rows += 1;
      /* More payload rows share this identity than the page draws.
         ─────────────────────────────────────────────────────────────────
         /api/status holds one record per (source, mode, fleet) — four for
         `fms` — and the source panel shows the latest of them, which is the
         whole point of the panel. Demanding all four reported fifteen
         figures on #compare that no reader was ever meant to see. The same
         thing happens to two drivers who share a name. When the payload is
         more granular than the table, this check cannot say which row a
         figure belongs to, so it says nothing. */
      if ((idCount.get(`${f.url}|${want}`) || 1) > rows.length) { D.granular += 1; break; }
      /* Two endpoints, one column heading, different measurements.
         ─────────────────────────────────────────────────────────────────
         The source-health table's "Rows written" is rows_24h — every write
         by every run that FINISHED IN THE LAST DAY, and its own caption
         says so. /api/status carries rows_written, the all-time total of
         one run. Both reduce to the words "rows written", so a figure from
         the run log was demanded in a column that means something else: the
         ledger imported 39,797 rows a hundred hours ago and the column
         correctly reads 0. When more than one endpoint offers this identity
         a field that lands on this column, the column cannot be attributed
         to either. */

      /* …and the guard the paragraph above describes, which was written down
         and never written. keysAt holds every numeric field every endpoint
         offers under this identity; if another endpoint offers one that lands
         on this same column, the column cannot be attributed to either, and a
         harness that guesses is worse than one that says nothing.

         Measured: #revenue's Bookings column is /api/revenue's windowed count
         and /api/platforms — which the same page also fetches, for the channel
         inventory — offers an all-time `bookings` for the same channel. One
         column, two true numbers, and the audit demanded the one the column
         was never about. */
      const rival = [...keysAt].some(([k2, set]) => {
        const at = k2.indexOf('|');
        if (k2.slice(0, at) === f.url) return false;
        if (k2.slice(at + 1).toLowerCase().trim() !== want) return false;
        return [...set].some((kk) => columnFor(t.heads, kk, t.keys) === col);
      });
      if (rival) { D.rival += 1; break; }

      /* A column is free to render a duration in the unit that reads best.
         /api/rollups reports duration_ms and the "Took" column prints 3.5s;
         the STEM rule above only covers a payload carrying BOTH units on the
         same row, and this one carries only the small one. So the ordinary
         conversions count as shown. */
      /* …but only where a unit is what the field IS.
         ─────────────────────────────────────────────────────────────────
         Dividing every figure by 1000, 60, 3600 and 60000 and accepting any
         of the results turned this comparison into a rubber stamp. A value
         of 3,496 accepts the tokens 0, 1, 2, 3, 4, 57, 58 and 59 — and every
         row of a ranked table starts with its rank, so "3,496 km" was
         satisfied by the digit 3 sitting in the rank column three cells to
         the left. Measured: with every figure over a thousand on #drivers
         deliberately multiplied by three, 213 figures were compared against
         the DOM and not one was reported.

         A duration is the only thing this allowance was written for —
         /api/rollups reports duration_ms and the column prints 3.5s — so it
         now applies only to a field whose name says it carries a unit of
         time. Everything else is compared as the number it is. */
      const TIMEY = /(^|_)(ms|s|sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|hrs|duration|elapsed|took|age|uptime|runtime|time)(_|$)/i;
      const forms = (v, key) => {
        const out = new Set([v, v - 1, v + 1]);
        if (TIMEY.test(key)) {
          for (const d of [1000, 60, 3600, 60000]) {
            const q2 = Math.round(v / d);
            if (q2 >= 1) { out.add(q2); out.add(q2 - 1); out.add(q2 + 1); }
          }
        }
        return [...out].map(String);
      };
      const near = (r, v) => forms(v, f.key).some((x) => r.nums.includes(x));
      D.compared += 1;
      if (!rows.some((r) => near(r, f.n)) && !anywhere(f.n)) missing.push({ ...f, col, as: want });
      break;
    }
  }
  if (process.env.EXPLAIN) {
    console.error(`\n  ${route}: ${pairs.length} payload figures → ${D.col} have a column`
      + ` → ${D.rows} sit in a drawn row → ${D.compared} compared`
      + ` (${D.foreign} in a table their endpoint did not draw,`
      + ` ${D.granular} more granular than the table, ${D.rival} claimed by two endpoints)`);
  }
  if (missing.length) {
    findings.push({ route, code: 'unshown',
      detail: `${missing.length} figure(s) have a column on this page, sit in a row it is `
        + 'showing, and are not in that row',
      examples: [...new Set(missing.map((f) => `${f.as || f.id} · ${f.col} should be ${f.n} (${f.url} ${f.key})`))].slice(0, 6) });
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
  /* FOUR loads, and BRACKETED: 7d, 365d, 365d, 7d.
     ───────────────────────────────────────────────────────────────────────
     Three loads in the order 7, 365, 7 catch a fast-moving value and miss a
     slow one. "Last fix" is a GPS timestamp that advances every few minutes:
     the two 7d loads ran close together and agreed, the 365d load between
     them did not, and a clock was reported as a window. Bracketing puts the
     repeat of each window on the far side of the other, so anything drifting
     over the run differs from itself and is excluded, while a genuinely
     windowed fact still agrees with its own pair. */
  let wide2;
  try {
    a = await cardFacts(route, 7);
    wide = await cardFacts(route, 365);
    wide2 = await cardFacts(route, 365);
    again = await cardFacts(route, 7);
  } catch { continue; }
  if (!a.length || a.length !== wide.length || a.length !== again.length
    || a.length !== wide2.length) continue;

  const drifted = a.map((f, i) => ({ f, w: wide[i], v: again[i], w2: wide2[i] }))
    .filter(({ f, w, v, w2 }) => w.label === f.label && v.label === f.label
      && w2.label === f.label
      && v.value === f.value                       // held still while the clock ran
      && w2.value === w.value                      // …at the other window too
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
/* Where the report lands, overridable.
   ─────────────────────────────────────────────────────────────────────────
   test/audit_tools_detect.test.mjs drives this tool against a one-route stub
   to prove it still catches an unshown figure, and it spawned it with the
   repository as cwd — so every run of the test suite overwrote the real
   production sweep at docs/audit/numbers-<today>.json with a stub's findings.
   The audit and the test for the audit were writing to the same file, and the
   test ran second. */
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
if (transportFailures.length > routes.length / 3) {
  console.error(`\n${transportFailures.length} of ${routes.length} routes could not be REACHED `
    + `(${String(transportFailures[0].detail).slice(0, 80)}).`);
  console.error('This is a transport failure, not a finding. Nothing about the product was '
    + 'observed, so no report is written. Re-run when the network is quiet — one sweep at a '
    + 'time, and not while other jobs are pulling on the same host.');
  process.exit(2);
}

const REPORT_DIR = process.env.REPORT_DIR || 'docs/audit';
mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(`${REPORT_DIR}/numbers-${TODAY}.json`,
  JSON.stringify({ base: BASE, width: WIDTH, at: new Date().toISOString(), findings }, null, 2));
console.log(`report: ${REPORT_DIR}/numbers-${TODAY}.json`);
process.exit(findings.length ? 1 : 0);
