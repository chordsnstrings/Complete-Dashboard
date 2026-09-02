/* Shared UI primitives.
   These used to live inside app.js. They moved out when the dashboard grew
   detail pages of its own: a per-driver page needs the same panels, tables and
   modals as the overview, and copying them would have let the two drift. */
import { fmt, empty } from './charts.js';
import { href, params } from './data.js';
import { TZ, TZ_LABEL, dubaiDay } from './tz.js';

export const $ = (s, r = document) => r.querySelector(s);
export const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
export const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function panel(title, cap) {
  const p = el('div', 'panel');
  if (title) p.append(el('h3', null, title));
  if (cap) p.append(el('p', 'cap', cap));
  /* .pbody, not a bare div: a panel that holds more than one thing — a note,
     a KPI row and a table, say — stacked them at 0px for as long as this
     helper has existed, because a <div> is not a stack and a .panel carries
     no margins of its own. The class is the whole fix, and it is applied
     here rather than at the three hundred call sites that append to a body. */
  const body = el('div', 'pbody'); p.append(body);
  return { panel: p, body };
}
/* A skeleton, optionally saying how long it expects to be one.
   ─────────────────────────────────────────────────────────────────────────
   Every skeleton in this product looks the same, and one of them is not the
   same: /api/coverage scans the whole record — its own warmer comment calls it
   a twenty-second query, and #sources sits on that skeleton for eleven seconds
   on a warm cache. Eleven seconds of an identical grey box is indistinguishable
   from a panel that will never fill, and the render audit could not tell them
   apart either.

   So a caller that KNOWS its panel is slow can say so. Nothing else changes:
   with no message this is the same one-line skeleton it has always been. */
export const loading = (host, slow) => {
  host.innerHTML = '<div class="skel">Loading…</div>';
  /* A STRING, or nothing. Twenty-four call sites in this product write
     `[a.body, b.body, c.body].forEach(loading)`, and Array.forEach hands its
     callback (element, INDEX, array) — so every panel after the first was
     asked to declare itself slow with the message "1", "2", "3". On
     #unit?days=90&fleet=ecosine seven skeletons replaced "Loading…" with a
     bare index a second after the page opened, and bin/render-audit.mjs saw
     only that they were still skeletons. Guarding the type here rather than
     rewriting the twenty-four sites: forEach(fn) is the idiom, and a helper
     that cannot survive it is the thing that is wrong. */
  if (typeof slow !== 'string' || !slow) return;
  /* Said only if it turns out to BE slow.
     ─────────────────────────────────────────────────────────────────────
     Rendering the sentence immediately would flash a paragraph on every warm
     load — /api/coverage answers in about a second warm and twenty cold — and
     a panel that explains itself before there is anything to explain is noise.
     So the ordinary bar goes up first and the explanation replaces it after a
     beat, which is the shape #sources had already hand-rolled for its field
     inventory. Doing it here means every slow panel behaves the same way, and
     that one gets the styling its sentence needed: it was writing prose into a
     13px shimmer bar, where nobody could read it.

     Guarded on the skeleton still being the thing in the host, so a panel that
     filled in the meantime is not overwritten by its own loading state. */
  const bar = host.firstElementChild;
  setTimeout(() => {
    if (host.firstElementChild !== bar || !bar.isConnected) return;
    bar.classList.add('says');
    bar.textContent = slow;
  }, 1200);
};

/* ── ranked tables you can actually rank ──────────────────────────────────
   Every table in this product is ordered by whatever the SQL chose, and the
   column somebody wants to rank by is usually a different one: the largest
   known cash holder sat 38th on #settlement/cash behind thirty-seven rows
   reading "—", and the licence table opened on 77 placeholder dates with no
   way to get past them.

   `sortable: true` makes each header a button. Three things make it correct
   rather than merely clickable:

     - Postgres sends `numeric` over JSON as a STRING, so a `num` column is
       coerced with Number() before comparing. Sorting "9" against "10" as text
       puts 9 last.
     - Nulls go last in BOTH directions. A dash is an absence, not a small
       value, and floating them to the top of a descending sort buries the
       answer under rows that have none.
     - The sort is part of the ADDRESS. This product replaced its modals with
       pages so a finding could be sent to somebody; a table sorted into a
       finding and not linkable would reintroduce the same problem one layer
       down. Written with replaceState, so re-sorting does not re-fetch. */
const sortVal = (r, c) => {
  if (c.sortValue) return c.sortValue(r);
  const v = r[c.key];
  if (v == null || v === '') return null;
  if (c.num) { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return String(v).toLowerCase();
};

function readSorts() {
  const h = location.hash.slice(1);
  const qi = h.indexOf('?');
  if (qi < 0) return new Map();
  const out = new Map();
  for (const raw of new URLSearchParams(h.slice(qi + 1)).getAll('sort')) {
    const [id, key, dir] = String(raw).split('.');
    if (id && key) out.set(id, { key, dir: dir === 'asc' ? 'asc' : 'desc' });
  }
  return out;
}

function writeSort(id, key, dir) {
  const h = location.hash.slice(1);
  const qi = h.indexOf('?');
  const path = qi >= 0 ? h.slice(0, qi) : h;
  const p = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
  const keep = p.getAll('sort').filter((s) => String(s).split('.')[0] !== id);
  p.delete('sort');
  keep.forEach((s) => p.append('sort', s));
  if (key) p.append('sort', `${id}.${key}.${dir}`);
  const qs = p.toString();
  // replaceState, not assignment: a hashchange would re-render the whole view
  // and re-issue every request on the page to re-order rows already in the DOM.
  try { history.replaceState(null, '', `#${path}${qs ? '?' + qs : ''}`); }
  catch { /* a sandboxed frame refuses; the sort still applies on screen */ }
}

/* A detail page addressed with nothing to detail.
   ─────────────────────────────────────────────────────────────────────────
   #driver, #vehicle, #performer, #property and #segment each report on ONE
   thing named in the address. Reached without one — a typed URL, a stale
   bookmark, a link whose id never got filled in — they called their endpoint
   anyway and rendered whatever it complained with: "Could not load: 400 id
   required", or a bare 404. #day has always answered this in English and
   pointed somewhere useful; this makes the others do the same. */
export function noneChosen(root, thing, listView, listLabel, listParam) {
  root.innerHTML = '';
  const p = panel(`No ${thing} chosen`,
    `This page reports one ${thing} at a time and the address carries no `
    + `${thing === 'segment' ? 'plate and instant' : 'id'}.`);
  root.append(p.panel);
  p.body.append(el('p', 'cap',
    `<a class="lnk" href="${href(listView, listParam)}">${esc(listLabel)} \u2192</a>`));
  p.body.append(note(`Open one from that list, or from any ${thing} name elsewhere in the product — `
    + 'every one of them is a link that carries what this page needs.'));
  return null;
}

/* The default cell.
   ─────────────────────────────────────────────────────────────────────────
   A column declared `num: true` with no render of its own fell straight
   through to esc(), which meant 105 columns across seventeen views printed
   2547 where every other number in the product is written 2,547 — the safety
   table's event counts, the day view's minutes, the corporate room counts.

   Only integers of four digits or more are touched. A rate, a share, a
   latitude or a per-100km figure arrives fractional and keeps every digit it
   came with, and anything under a thousand is unchanged by definition, so
   this cannot alter a number that was already right. */
function plainCell(c, r) {
  const v = r[c.key];
  const n = Number(v);
  return (c.num && v != null && v !== '' && Number.isInteger(n) && Math.abs(n) >= 1000)
    ? fmt(n) : esc(v ?? '—');
}

export function tableFrom(rows, cols, { compact = false, sortable = false,
  sortId = 't', defaultSort = null, capped = null, onRow = null } = {}) {
  if (!rows.length) { const d = el('div'); empty(d); return d; }
  const wrap = el('div', 'tscroll');
  const t = el('table', compact ? 'compact' : null);
  /* Anything that explains the table rather than being part of it. Collected
     here and attached outside the scroller at the end. */
  const notes = [];

  /* A column that is empty in EVERY row is not a column.
     ───────────────────────────────────────────────────────────────────────
     The drivers directory carried a Rating column that was null for all 360
     people, because nothing in the collector writes driver_platform_state.
     rating — no channel reports one to this fleet. Rendered, that is three
     hundred and sixty em-dashes taking the width of a real column, and a
     reader is left to decide whether the fleet has no ratings or the page is
     broken. Neither reading is available from the dashes themselves.

     So a column may declare `absent`: the sentence to print if it turns out to
     be empty everywhere. The column is then dropped — its width goes to the
     columns that DO carry numbers — and the sentence is printed under the
     table. A column with no `absent` is kept as it is, dashes and all, because
     silently dropping a column the caller did not think about would hide a
     collection failure rather than report it. */
  const isBlank = (v) => v == null || v === '' || v === '—'
    || (Array.isArray(v) && v.length === 0);
  const filled = (c) => rows.reduce((n, r) => n + (isBlank(r[c.key]) ? 0 : 1), 0);
  const dead = cols.filter((c) => c.absent && c.key && filled(c) === 0);
  cols = cols.filter((c) => !dead.includes(c));

  /* …and a column that is MOSTLY empty says so too.
     ───────────────────────────────────────────────────────────────────────
     Between "every row" and "most rows" there is no difference to the reader:
     330 dashes under Fares out of 361 drivers looks exactly as broken as 361
     would. But the column has to stay — thirty-one people DO have a fare, and
     they are the hotel and Yango drivers, which is the finding. So the same
     `absent` sentence is printed with the count in front of it: "31 of 361
     rows carry one", and then why the rest do not.

     A quarter is the line. Above it a column reads as populated with gaps,
     which is ordinary; below it the gaps are the story. */
  const SPARSE = 0.25;
  /* Counted as the reader SEES it, not as the row carries it.
     ───────────────────────────────────────────────────────────────────────
     `filled` tests the raw value, and a numeric 0 is a value. But a money
     column renders 0 as a dash — `r.revenue ? money(r.revenue) : '—'` — so on
     production this note said "72 of 361 rows carry one" above a table showing
     31: forty-one drivers have a fare total of exactly zero. The note and the
     column it describes disagreed about the column.
     
     So a column that declares `absent` is counted by running its own renderer
     and asking whether anything came out. Only those columns pay for it, the
     renderers here are pure string builders, and the tables are capped — and
     it makes the sentence agree with the cells by construction rather than by
     both sides happening to test the same thing.
     
     Deliberately NOT used for `dead` above: that one PRUNES a column, and
     changing what counts as empty there would silently drop columns across
     every page in the product on a judgement about rendering. */
  const DASH = /^[—–-]?$/;
  const shown = (c, r) => {
    if (typeof c.render !== 'function') return !isBlank(r[c.key]);
    let out;
    try { out = c.render(r); } catch { return !isBlank(r[c.key]); }
    return !DASH.test(String(out ?? '').replace(/<[^>]*>/g, '').trim());
  };
  const visible = (c) => rows.reduce((n, r) => n + (shown(c, r) ? 1 : 0), 0);
  const sparse = cols.filter((c) => c.absent && c.key && rows.length >= 8
    && visible(c) / rows.length < SPARSE)
    .map((c) => ({ col: c, n: visible(c) }));

  const byKey = (k) => cols.find((c) => c.key === k);

  let active = sortable ? (readSorts().get(sortId) || defaultSort) : null;
  if (active && !byKey(active.key)) active = defaultSort && byKey(defaultSort.key) ? defaultSort : null;

  const order = (list) => {
    if (!active) return list;
    const c = byKey(active.key);
    if (!c) return list;
    const sign = active.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const x = sortVal(a, c), y = sortVal(b, c);
      if (x == null && y == null) return 0;
      if (x == null) return 1;                 // absences last, both directions
      if (y == null) return -1;
      if (x === y) return 0;
      return x > y ? sign : -sign;
    });
  };

  const head = () => `<thead><tr>${cols.map((c) => {
    const on = active && active.key === c.key;
    const aria = on ? (active.dir === 'asc' ? 'ascending' : 'descending') : 'none';
    const cls = `${c.num ? 'num' : ''}${sortable && c.key ? ' sortable' : ''}${on ? ' sorted' : ''}`.trim();
    const mark = on ? `<i class="sarr">${active.dir === 'asc' ? '↑' : '↓'}</i>` : '';
    /* data-key on every header, sortable or not: the column's own field name.
       A heading is free to say something other than its key — the source
       panel's "Rows written" is rows_24h, and its caption explains why — and
       a tool matching a payload field to a column on the WORDS of the
       heading then attributed one endpoint's figure to another's column.
       The key is the fact; the label is the writing. */
    const dk = c.key ? ` data-key="${esc(c.key)}"` : '';
    return sortable && c.key
      ? `<th class="${cls}"${dk} aria-sort="${aria}"><button type="button" data-sk="${esc(c.key)}">`
        + `${esc(c.label)}${mark}</button></th>`
      : `<th class="${cls}"${dk} aria-sort="none">${esc(c.label)}</th>`;
  }).join('')}</tr></thead>`;

  const body = (list) => `<tbody>${list.map((r) => `<tr>${cols.map((c) =>
    `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : plainCell(c, r)}</td>`)
    .join('')}</tr>`).join('')}</tbody>`;

  /* The caller's row-level handlers index into the array it passed, so the
     re-ordered array is written back onto the same reference rather than
     replaced — otherwise clicking row 1 of a re-sorted table opens row 1 of
     the original order. */
  const paint = () => {
    const list = order(rows.slice());
    rows.length = 0; rows.push(...list);
    t.innerHTML = head() + body(rows);
    /* Row handlers are re-bound on every paint and take the ROW, not an index
       into an array that has since been re-ordered. A table that opened the
       wrong driver after a sort would be worse than one that could not sort. */
    if (onRow) {
      t.querySelectorAll('tbody tr').forEach((tr, i) => {
        tr.style.cursor = 'pointer';
        tr.setAttribute('data-click', '');
        tr.onclick = (ev) => { if (!ev.target.closest('a')) onRow(rows[i], ev); };
      });
    }
    if (!sortable) return;
    t.querySelectorAll('thead button[data-sk]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.sk;
        const c = byKey(k);
        active = active && active.key === k
          ? (active.dir === 'desc' ? { key: k, dir: 'asc' } : null)
          // A first click ranks the way the reader means: biggest first for a
          // number, A-Z for a name.
          : { key: k, dir: c && c.num ? 'desc' : 'asc' };
        writeSort(sortId, active?.key, active?.dir);
        paint();
        wrap.dispatchEvent(new CustomEvent('table:sorted', { bubbles: true, detail: { rows } }));
      };
    });
  };
  paint();
  wrap.append(t);
  if (dead.length || sparse.length) {
    /* One line per REASON, not per column.
       ───────────────────────────────────────────────────────────────────
       Four columns of the reconciliation table share one answer — the ledger
       does not go back that far — and printing it four times filled the
       bottom of the panel with the same sentence, which reads as four
       separate faults. Grouped by the sentence, with the columns named in
       front of it. */
    const byReason = new Map();
    const add = (label, reason, count) => {
      if (!byReason.has(reason)) byReason.set(reason, []);
      byReason.get(reason).push({ label, count });
    };
    dead.forEach((c) => add(c.label, c.absent, null));
    sparse.forEach(({ col, n }) => add(col.label, col.absent, n));

    const d = el('div', 'cap tabsent');
    d.innerHTML = [...byReason.entries()].map(([reason, cols]) => {
      const names = cols.map((c) => `<b>${esc(c.label)}</b>`).join(', ');
      /* A count belongs to one column, so it is only stated when the reason
         covers exactly one — "31 of 361 rows carry one" is meaningless spread
         across four different columns. */
      const carried = cols.length === 1 && cols[0].count != null
        ? ` — ${fmt(cols[0].count)} of ${fmt(rows.length)} rows carry one;`
        : ' —';
      return `<span>${names}${carried} ${esc(reason)}</span>`;
    }).join('');
    /* Appended to the PANEL, not to the scrolling box.
       Inside .tscroll it scrolled with the table: on a phone the reader saw a
       sentence starting halfway through — "rows carry one; the ledger only
       carries…" — with its own subject off the left edge. The note explains
       the table; it is not part of it. */
    notes.push(d);
  }
  if (sortable && capped) {
    notes.push(el('p', 'cap tsort-note',
      `Sorting re-orders the ${rows.length} rows on screen, not ${esc(capped)} — the rows that reach `
      + 'this page were chosen by the server before you got to choose the column.'));
  }
  /* The scroller holds the table; the notes sit OUTSIDE it, at panel width.
     Inside .tscroll they scrolled with the table, so on a phone the reader met
     a sentence beginning halfway through — "rows carry one; the ledger only
     carries…" — with its own subject off the left edge. A note explains the
     table; it is not part of it.

     Returned as one element either way, because two hundred call sites do
     `body.append(tableFrom(...))` and a fragment would break every one. */
  /* The scroller gets its own positioned box so the edge fades can be pinned
     over the TABLE and not over the notes underneath it. A pseudo-element on
     the scroller itself would scroll away with the content, which is exactly
     when it is needed. */
  const box = el('div', 'tsbox');
  box.append(wrap);
  const block = el('div', 'tblock');
  block.append(box, ...notes);
  scrollCue(box, wrap);
  return block;
}

/* A table that scrolls sideways has to say so.
   ─────────────────────────────────────────────────────────────────────────
   Measured on production, #reconcile at 1440px — a wide desktop, not a phone:
   the scroller is 1,088px and its table is 1,278, so 190px sits outside the
   panel and the last figure a reader can see is "+AED 41", cut mid-number. At
   1180px it is 449px, which is two whole columns. There was no fade, no
   shadow, no caption — nothing on screen said the table continued.

   This is the user's own report about Reconciliation ("doesn't have all data
   filled") in its second form. Pinning the identity column fixed WHICH ROW a
   figure belongs to; nothing had ever addressed whether the reader knows there
   are more figures to the right.

   Two cues, because they answer different questions. The fade says "there is
   more this way" and follows the scroll — it appears at whichever end has
   content beyond it and goes when you reach it. The caption NAMES the columns
   that start off screen, which is the part a fade cannot do: "Δ bank −
   expected" is a number somebody came to this page for, and a gradient does
   not tell them it exists.

   Both are recomputed on scroll and on resize, and both are silent when the
   table fits — which is most tables on most screens. */
function scrollCue(box, wrap) {
  const sync = () => {
    const over = wrap.scrollWidth - wrap.clientWidth;
    box.classList.toggle('cue-r', over > 2 && wrap.scrollLeft < over - 2);
    box.classList.toggle('cue-l', over > 2 && wrap.scrollLeft > 2);
  };
  wrap.addEventListener('scroll', sync, { passive: true });

  /* The caption is REMEASURED, not written once and left.
     ─────────────────────────────────────────────────────────────────────
     It used to be produced inside a single requestAnimationFrame and appended
     for good. The fade beside it was already recomputed on scroll and resize,
     so the two disagreed the moment a layout settled: on production #compare's
     By channel panel carried "Scroll the table sideways for one more column:
     Money" under a table measuring scrollWidth 660 against clientWidth 660 —
     nothing hidden, nothing to scroll, and a sentence telling the reader a
     figure they could see was out of reach. Any table can reach that state:
     a chart above it finishing its layout, a filter widening the grid, a
     window resized, a sibling panel collapsing.

     Recomputed on RESIZE but not on scroll, deliberately. The fades answer
     "is there more this way" and must follow the scroll position; the caption
     answers "which columns are not on screen", and rewriting its wording under
     the reader's finger as they drag is worse than leaving it. A scroll cannot
     change WHETHER the table overflows, only where you are within it. */
  let cue = null;
  const name = () => {
    if (!wrap.isConnected) return;
    const over = wrap.scrollWidth - wrap.clientWidth;
    /* Which columns are CUT, not which start off screen.
       ─────────────────────────────────────────────────────────────────────
       The first version tested the header's left edge, and on #reconcile at
       1440px that reported one hidden column when the screenshot plainly shows
       two: "Δ bank − expected" starts inside the panel and ends outside it, so
       the figure a reader sees is "+AED 41" — cut mid-number. A column whose
       value is clipped is a column you have to scroll for, whether or not its
       heading happens to fit. */
    const edge = wrap.getBoundingClientRect().right;
    const hidden = over > 2
      ? [...wrap.querySelectorAll('thead th')]
        .filter((th) => th.getBoundingClientRect().right > edge + 4)
        .map((th) => th.textContent.replace(/[↑↓▾▴]/g, '').trim())
        .filter(Boolean)
      : [];
    if (!hidden.length) { if (cue) { cue.remove(); cue = null; } return; }
    if (!cue) { cue = el('p', 'cap tcue'); box.parentElement?.append(cue); }
    cue.textContent = `Scroll the table sideways for ${hidden.length === 1 ? 'one more column' : `${hidden.length} more columns`}: ${hidden.join(', ')}.`;
  };

  /* ResizeObserver rather than a window resize listener: a table can start
     overflowing because a SIBLING changed — a panel gaining a chart, a filter
     narrowing the grid — with the window untouched. */
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => { sync(); name(); }).observe(wrap);
  }

  /* requestAnimationFrame because the element is not in the document yet at
     this point, so scrollWidth is 0 and every table would look like it fits. */
  requestAnimationFrame(() => { sync(); name(); });
}

/* There is no `drill()` any more.
   Every one of the eleven modals this app used to open has become a page with
   an address: an occupancy segment is #segment/<plate>/<started_at>, a heatmap
   cell is #slot/<dow>/<hour>, a day is #day/<date>. The modal was always the
   wrong container for this product — the things it opened are exactly the
   things somebody needs to send to somebody else, and a modal cannot be sent.

   The .modal CSS is deliberately left in app.css: it costs nothing and removing
   it is the kind of tidying that breaks a page nobody tested. */

/* A row of headline numbers. Values may carry a `sub` line and a `tone`
   (good / warn / serious / critical) that colours the number. */
/* Roughly what fits on one line of a 158px tile at the smallest size the
   clamp will go to. Past it the value wraps instead of being clipped: a figure
   cut off at the card edge is not a figure at all, and `overflow:hidden` on
   the tile means the reader does not even get an ellipsis to warn them.
   Measured against the values that overflowed — "12:00 AM – 11:57 PM" (19)
   and "+AED 37,286 · 150.9%" (20) — and against the ones the nowrap rule
   exists to protect, of which the longest is "AED 257,122" (11).

   It was 14, and the render audit found the value that sits exactly on the
   boundary: #compare's Distance tile reading "44 vs 6,454 km" — fourteen
   characters, so `> 14` was false, so no wrap, so clipped by five pixels at
   1500px with no ellipsis to say so. A threshold tuned to the character is a
   threshold that fails on the next character, and it fails INVISIBLY: the tile
   looks like a tile and the number in it is wrong.

   Twelve, because the class is not a punishment. `.long` lets a value wrap and
   drops the font a step; a value that fits still occupies one line, because
   `white-space:normal` breaks only where it must. Everything the nowrap rule
   was written for — "AED 257,122" at eleven — is still under it, and the two
   characters of margin are what stops the next boundary case from clipping. */
const KPI_ONE_LINE = 12;

/* A tile may name the SET behind its number.
   ─────────────────────────────────────────────────────────────────────────
   "33 insured and idle" is a true sentence nobody can act on: it is thirty-
   three named cars printed as a cardinality, and reaching them meant knowing
   which page listed them and how to filter it. A tile carrying `cohort` is a
   link to that list — the same rows, gathered with every other source that
   holds anything about them (see api/public/cohorts.js).

   Rendered as an <a> so it is a real destination: linkable, bookmarkable, and
   openable in a new tab, which a click handler on a div is not. */
export function kpiRow(items) {
  const host = el('div', 'kpis');
  host.innerHTML = items.filter(Boolean).map((k) => {
    /* Measured on the TEXT, so a value carrying markup is judged by what the
       reader actually sees rather than by the length of its span tags. */
    const plain = String(k.html ? k.html.replace(/<[^>]*>/g, '') : (k.value ?? '—'));
    const long = plain.length > KPI_ONE_LINE ? ' long' : '';
    const to = k.to || (k.cohort ? href('cohort', k.cohort) : null);
    const tag = to ? 'a' : 'div';
    const attr = to ? ` href="${to}"` : '';
    return `
    <${tag} class="kpi${k.tone ? ' t-' + k.tone : ''}${to ? ' kpi-open' : ''}"${attr}>
      <div class="l">${esc(k.label)}</div>
      <div class="n num${long}">${k.html || esc(k.value ?? '—')}</div>
      ${k.sub ? `<div class="s">${esc(k.sub)}</div>` : ''}
      ${to ? '<div class="kpi-who">Who exactly? →</div>' : ''}
    </${tag}>`;
  }).join('');
  return host;
}

/* Sub-navigation inside a detail page. Each tab is a real route, so a tab can
   be linked to, bookmarked and reloaded — the whole point of splitting the
   driver view into pages instead of stacking everything on one. */
export function tabBar(tabs, active, hrefFor) {
  const bar = el('div', 'tabs');
  tabs.forEach((t) => {
    const a = el('a', t.id === active ? 'on' : '', `${t.ic ? `<span class="ic">${t.ic}</span>` : ''}${esc(t.label)}`);
    a.href = hrefFor(t.id);
    bar.append(a);
  });
  return bar;
}

/* Every drill-down in this app used to end at a table of names that were not
   links: you could find the driver responsible for something and then have no
   way to open them. `entity` makes any cell that names a driver, a vehicle or a
   property a real address, so a finding always leads somewhere. */
export const entity = (view, id, text) => (id
  ? `<a class="ent" href="${href(view, id)}">${esc(text ?? id)}</a>`
  : `<span class="ent-off">${esc(text ?? '—')}</span>`);

/* The people who held a vehicle on the day a vehicle-level fact happened.
   ─────────────────────────────────────────────────────────────────────────
   Every table that names a plate can name them: an unauthorised journey, a
   harsh-braking count, a document expiring, a car that moved with no booking.
   A plate on its own is not actionable — somebody has to be rung.

   Takes the {name, id} pairs the endpoint returns and falls back to splitting
   the comma-joined names when only those are present, so an endpoint that has
   not been given the pairs yet still reads rather than showing a blank. Every
   name is rendered through entity(), so a handover day makes BOTH people
   openable and a person with no id degrades to plain text rather than to a
   broken link. */
export const custody = (r, { title = null, hrefFor = null } = {}) => {
  const refs = r.driver_refs || (r.drivers
    ? String(r.drivers).split(',').map((x) => ({ name: x.trim(), id: null })) : []);
  if (!refs.length) return '<span class="dim">unknown</span>';
  const names = refs.map((d) => entity('driver', d.id, d.name)).join(', ');
  return hrefFor
    ? `${names} <a class="dim" title="${esc(title || '')}" href="${hrefFor(refs[0])}">⌕</a>`
    : names;
};

/* The custodian as of the most recent day we hold custody for, for facts that
   are not about a particular day — a document expiring next month, a car that
   has not earned all quarter. The day is shown because "held by Kashif" means
   something different if it is drawn from yesterday or from eleven weeks ago,
   and hiding that invites somebody to ring the wrong person. */
export const custodyAsOf = (ref) => (ref && ref.name
  /* Anchored at midday: a bare YYYY-MM-DD parses as UTC midnight, which renders
     as the previous day for any viewer west of Greenwich.

     The day is sliced to ten characters first, because callers hand this
     whatever the endpoint gave them and half of them send a full ISO timestamp
     — appending "T12:00:00" to "2026-04-03T00:00:00.000Z" produced an
     unparseable string, so a real custody date rendered as "as of —". */
  ? `${entity('driver', ref.id, ref.name)}<span class="dim"> as of `
    + `${ref.day ? dayStr(`${String(ref.day).slice(0, 10)}T12:00:00`) : 'an unrecorded day'}</span>`
  : '<span class="dim">nobody on record</span>');

export const pill = (text, tone) => `<span class="pill${tone ? ' ' + tone : ''}">${esc(text)}</span>`;

/* Every time and date in this product is Dubai time, stated explicitly.
   ─────────────────────────────────────────────────────────────────────────
   The API computes its calendar keys in Asia/Dubai — local_day, local_hour,
   local_dow, the custody day, the whole demand heatmap. These formatters
   rendered in the VIEWER's zone, so the two disagreed on the same screen: for
   anyone outside the Gulf, a segment starting at 17:00 Dubai printed as 13:00
   beside an hour-of-day chart whose peak was at 17. A driver's shift read
   "03:00 – 15:00" for a day the fleet worked 07:00 – 19:00, and a booking
   after midnight Dubai landed on the previous date — the exact off-by-one the
   SQL side was fixed for.

   The fleet operates in one city. Its clock is that city's clock, wherever the
   person reading this happens to be. */
export { TZ, TZ_LABEL, dubaiDay };

const asDate = (v) => {
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};
// The Dubai calendar year of an instant, and of right now.
const yearOf = (d) => d.toLocaleDateString('en-CA', { year: 'numeric', timeZone: TZ });
const thisYear = () => yearOf(new Date());

export const dateStr = (v) => {
  const d = asDate(v);
  return d ? d.toLocaleDateString(undefined,
    { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) : '—';
};
/* Year-aware, because this product offers a twelve-month window.
   ─────────────────────────────────────────────────────────────────────────
   "21 Oct" and "21 Aug" sat side by side with nothing to say which year, so a
   driver who last drove ten months ago read as current, a 2027 registration
   expiry read as June just gone, and the Revenue footer printed
   "Window Aug 25 – Aug 25" for a range covering an entire year. The year is
   added only when the date falls outside the current Dubai year, so the
   common case — a date inside the window you are looking at — stays short. */
export const dayStr = (v) => {
  const d = asDate(v);
  if (!d) return '—';
  // Both branches state the zone, rather than mutating one options object:
  // every formatter in this file names timeZone inside its own call, which is
  // what test/timezone.test.mjs reads to prove none is left on the viewer's
  // clock. A zone set a line earlier is invisible to that check and to a
  // reader skimming for it.
  return yearOf(d) === thisYear()
    ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: TZ })
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ });
};
/* 24-hour, explicitly.
   ─────────────────────────────────────────────────────────────────────────
   Left to the viewer's locale this rendered "12:00 AM" on an en-US browser —
   eight characters where "00:00" is five, which is what overflowed the
   "First / last booking" tile on #day by 31px and clipped it. It was also the
   only 12-hour clock in the product: the demand axis, the shift bars, the
   compare page and every hour label are 24-hour, so one tile disagreed with
   every chart beside it about what time a shift started. */
export const timeStr = (v) => {
  const d = asDate(v);
  return d ? d.toLocaleTimeString('en-GB',
    { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: TZ }) : '—';
};
export const dtStr = (v) => (asDate(v) ? `${dayStr(v)} ${timeStr(v)}` : '—');

/* A source's name as a person writes it. These are database keys — `fms`,
   `cabman` — and they were rendered raw as panel HEADINGS on the two pages an
   operator opens to ask which collector is broken. */
export const SOURCE_LABEL = {
  uber: 'Uber', yango: 'Yango', bolt: 'Bolt', hotel: 'Hotel', fms: 'FMS telematics',
  cabman: 'CABMAN', ecosine: 'Ecosine', egari: 'Egari',
  /* A collector /api/status reports and this map had no entry for, so
     sourceLabel() fell through to the database key and "uber_fleet · Ecosine"
     was printed at a reader — in the Settings collection-debt sentence and in
     the #sources Source column. */
  uber_fleet: 'Uber fleet',
};
/* An enum value written for a person. The rule engine stores `critical`,
   `compliance`, `vehicle`; printed as a tile's value they are the largest text
   on the page and were lowercase with underscores in them. */
export const sentence = (v) => {
  const t = String(v ?? '').trim().replace(/_/g, ' ');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '—';
};

export const sourceLabel = (s) => SOURCE_LABEL[String(s || '').toLowerCase()] || String(s || '—');

/* ── what a page was built from ───────────────────────────────────────────
   Audited across production, several pages showed money and counts with
   nothing on them naming which feeds those numbers came from. On a fleet that
   is 93% one channel, that matters in both directions: a reader assumes a
   figure covers everything when it covers Uber alone, and assumes a thin
   number is a bad week when it is a channel that stopped reporting.

   So a page can state its own provenance, from the same /api/platforms the
   Data sources page reads — the bookings each channel actually contributed to
   THIS window, and any channel that contributed none. A channel that is
   configured and silent is the important half: it is the difference between
   "Yango is tiny" and "Yango has not answered since the 26th".

   `only` narrows it to the channels a page genuinely draws on — the safety
   page is telematics and nothing else, and listing Uber under it would be a
   worse lie than saying nothing. */
export function sourceLine(platforms = [], { only = null, fleet = null, note = null,
  whole = false } = {}) {
  /* /api/platforms answers the whole catalogue whatever the request carries —
     it is the collector's inventory, not a windowed aggregate — so the page's
     own channel and fleet filters have to be applied here. Without it,
     #overview?platform=hotel rendered "Built from Uber 11,724 · Hotel 877"
     under a page showing 877 hotel bookings and nothing else: the exact claim
     this line exists to stop anyone making. */
  const rows = (Array.isArray(platforms) ? platforms : [])
    .filter((r) => !only || only.includes(String(r.platform || '').toLowerCase()))
    .filter((r) => !fleet || String(r.fleet_id || '').toLowerCase() === String(fleet).toLowerCase()
      /* A provider with no fleet of its own — Bolt — belongs to whichever
         fleet is being viewed rather than to neither. */
      || !r.fleet_id);
  if (!rows.length) return null;

  /* One entry per CHANNEL, with the fleets folded in: two Uber rows are two
     businesses on one provider, and a reader counting sources should see one
     Uber, not two. */
  const byPlatform = new Map();
  for (const r of rows) {
    const key = String(r.platform || '').toLowerCase();
    const cur = byPlatform.get(key) || { n: 0, rows: 0, bad: [], fleets: 0 };
    /* A page that hides the range selector is not answering about a window,
       and quoting `window_bookings` under it would attribute its numbers to a
       span it does not use. Those pages get the whole record instead. */
    cur.n += Number((whole ? r.bookings : r.window_bookings) || 0);
    cur.rows += Number(r.rows_seen || 0);
    cur.fleets += 1;
    if (r.collection_status && r.collection_status !== 'ok') {
      /* Bolt carries no fleet_id, and the placeholder rendered as the literal
         word — "Bolt (fleet: partial)". A provider with one row says only what
         is wrong with it. */
      cur.bad.push(r.fleet_id ? `${sourceLabel(r.fleet_id)}: ${r.collection_status}`
        : String(r.collection_status));
    }
    byPlatform.set(key, cur);
  }
  const live = [...byPlatform.entries()].filter(([, v]) => v.n > 0)
    .sort((a, b) => b[1].n - a[1].n);
  /* "Contributed nothing" was wrong about the telematics feed, which
     contributes 30,176 rows and zero BOOKINGS — it watches cars move, it does
     not sell rides. Reported as silent it looked like a dead collector, which
     is the opposite of what it is. A channel with rows and no bookings is
     doing its job; a channel with neither is not. */
  const noBookings = [...byPlatform.entries()].filter(([, v]) => v.n === 0 && v.rows > 0);
  const silent = [...byPlatform.entries()].filter(([, v]) => v.n === 0 && v.rows === 0);

  const el2 = el('p', 'cap srcline');
  const parts = [];
  if (live.length) {
    parts.push(`Built from ${whole ? 'the whole record — ' : ''}` + live
      .map(([k, v]) => `${esc(sourceLabel(k))} ${fmtInt(v.n)}`).join(' · '));
  }
  if (noBookings.length) {
    parts.push(`${noBookings.map(([k, v]) => `${esc(sourceLabel(k))} ${fmtInt(v.rows)}`).join(' · ')} `
      + 'in journeys rather than bookings — these feeds watch the cars, they do not sell rides');
  }
  if (silent.length) {
    /* Named, not omitted, and named WITH its collection state. A channel with
       nothing at all is either a market this fleet does not work or a
       collector that has stopped, and the page cannot tell which — but leaving
       it out lets the reader assume the first, and separating the state into
       its own clause said "Bolt contributed nothing. Bolt (partial)." */
    parts.push(`${silent.map(([k, v]) => esc(sourceLabel(k))
      + (v.bad.length ? ` (last run ${esc(v.bad.join(', '))})` : '')).join(' and ')} `
      + `contributed nothing ${whole ? 'on record' : 'to this window'}`);
  }
  /* A channel already named as silent does not need naming again for its
     collection state — "Bolt contributed nothing to this window. Bolt
     (partial)." was two sentences about one fact. Where it is the ONLY thing
     on the line, the two are merged; otherwise the states are listed apart
     from the counts, which is where a reader looks for them. */
  const silentKeys = new Set(silent.map(([k]) => k));
  const broken = [...byPlatform.entries()].filter(([, v]) => v.bad.length);
  const brokenElsewhere = broken.filter(([k]) => !silentKeys.has(k));
  if (brokenElsewhere.length) {
    parts.push(`${brokenElsewhere.map(([k, v]) => `${esc(sourceLabel(k))} (${esc(v.bad.join(', '))})`).join('; ')}`);
  }
  el2.innerHTML = parts.join('. ') + (note ? `. ${esc(note)}` : '') + '.';
  return el2;
}

/* Digits with separators, without importing charts.js into ui.js — sourceLine
   is the only thing here that needs one. */
const fmtInt = (v) => (Number.isFinite(+v) ? (+v).toLocaleString('en-US') : '—');

/* A product tier as a person reads it.
   ─────────────────────────────────────────────────────────────────────────
   These are column HEADINGS built from whatever the channels call their
   products, and the channels do not agree on a convention: Uber sends
   "Comfort" and "Black", the hotel channel sends "drop_off" and
   "pick_and_drop". So the tier table on #vehicles read
   "Electric · UberX · Comfort · Black · pick_and_drop · drop_off" — four
   product names and two database enum values, side by side, in the header row.

   Only the raw shape is touched: a value already written for a reader keeps
   its own capitalisation, because "UberX" is not "Uberx" and re-casing it
   would be the same class of mistake in the other direction. */
export const tierLabel = (t) => {
  const s = String(t ?? '').trim();
  if (!s) return '—';
  if (!/^[a-z0-9]+(_[a-z0-9]+)+$/.test(s)) return s;      // already human, or a proper name
  return s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
};

/* "yango is missing 1 days" and "1 have no record of ever being requested".
   Takes the count so the caller cannot forget to look at it. */
/* Irregular plurals the product actually uses. A caller passing an explicit
   `many` still wins; this is for the ones that reach the page through a `noun`
   option nobody thinks about at the call site — #cohort/roster-blocked offered
   to "Show the other 18 persons", because foldRows takes noun:'person' and the
   default plural is the word plus an s. */
const IRREGULAR = { person: 'people', company: 'companies', day: 'days' };
export const plural = (n, one, many) => (Math.abs(Number(n)) === 1
  ? one
  : (many ?? IRREGULAR[one] ?? `${one}s`));
export const countOf = (n, one, many) => `${fmt(n)} ${plural(n, one, many)}`;

/* A tracker fix, and the two columns that only make sense together.
   ─────────────────────────────────────────────────────────────────────────
   bin/render-audit.mjs: "Speed is empty in 33 of 40 rows" on a vehicle's
   movement tab. Measured over 2,633 fixes on one plate, FMS reports a speed
   for every Moving fix and none for any Idle or Stopped one, without a single
   exception — so the column is not sparse, it is a moving-only measurement on
   a vehicle that spends most of its time still.

   The word that says which has been in the payload all along and three of the
   four fix tables threw it away. These are shared because those three tables
   live in three modules, and a fourth copy of the sentence is a fourth chance
   for one of them to say something different about the same feed. */
export const trackerState = { label: 'State', key: 'status',
  render: (r) => (r.status
    ? `<span class="tag ${/mov/i.test(r.status) ? 'ok' : 'dim'}">${esc(r.status)}</span>`
    : '<span class="ent-off" title="this feed sends no state word with a fix">—</span>') };

export const trackerSpeed = { label: 'Speed', key: 'speed', num: true,
  /* And when EVERY fix is a stationary one the column has nothing to say at
     all, so it prunes itself and says this instead — stillNote() deliberately
     stays quiet there, because a sentence about some of the rows would be
     wrong about all of them. Without the two halves the column rendered forty
     dashes on a parked car and bin/render-audit.mjs read it as dead, which is
     what a reader would have read it as too. */
  absent: 'no fix in this table was taken while the vehicle was moving, and this tracker reports '
    + 'a speed only when it is — the State column beside it is what these fixes have to say',
  render: (r) => (r.speed != null ? `${fmt(r.speed)} km/h`
    : `<span class="ent-off" title="this tracker reports a speed only while the vehicle is moving${
      r.status ? `; this fix is ${esc(String(r.status).toLowerCase())}` : ''}">—</span>`) };

/** The sentence under such a table, or null when there is nothing to explain —
    every fix moving, or none of them. */
export const stillNote = (rows) => {
  const still = (rows || []).filter((r) => r.speed == null);
  if (!still.length || still.length === rows.length) return null;
  const words = [...new Set(still.map((r) => String(r.status || '').toLowerCase()).filter(Boolean))];
  return el('p', 'cap',
    `Speed is empty on ${fmt(still.length)} of these ${countOf(rows.length, 'fix', 'fixes')}: this `
    + 'tracker reports a speed only while the vehicle is moving'
    + (words.length ? `, and those fixes are ${words.join(' or ')}` : '')
    + '. A dash there is a stationary car, not a reading that went missing — the State column '
    + 'beside it says which.');
};

/* A list column that may arrive either way.
   Several endpoints return a set of names as a comma-joined STRING —
   `unavailable_sources: "bolt, yango"`, `channels_checked: "uber,yango,hotel"` —
   and others return a real array for the same idea. Calling .join on the
   string form throws and takes the whole view with it. */
/* "A, B and C" — never "A and B and C", which is what join(' and ') produces
   the moment a list has three items in it. A verdict that reads like a machine
   wrote it is a verdict a reader trusts less. */
export const andList = (a) => {
  const x = (a || []).filter(Boolean).map(String);
  return x.length <= 1 ? (x[0] || '')
    : `${x.slice(0, -1).join(', ')} and ${x[x.length - 1]}`;
};

export const asList = (v) => (Array.isArray(v) ? v.filter(Boolean)
  : (v == null || v === '' ? [] : String(v).split(',').map((s) => s.trim()).filter(Boolean)));

/* A trip's timestamp, as a door into the telemetry behind it: the link opens
   the vehicle's movement replay preselected to that trip's Dubai day. Every
   table that lists trips renders its time through this, so "what actually
   happened on that ride" is one click from any number that mentions it. No
   plate — a hotel booking before dispatch, an unmatched statement line — and
   it degrades to the plain timestamp rather than a link to nowhere. */
/* The day rides in href()'s own query string rather than being concatenated
   after it. Appended, an address already carrying a window came out as
   `…/movement?days=365?day=2026-08-25`: URLSearchParams reads one key `days`
   whose value is "365?day=2026-08-25", so the window silently fell back to 30
   and the `day` was never parsed at all — every trip clicked from a non-default
   window opened the newest replayable day instead of the trip's own. */
export const tripTime = (plate, at) => {
  const day = plate && at ? dubaiDay(at) : null;
  return day
    ? `<a class="lnk" href="${href('vehicle', plate, 'movement', { day })}" `
      + `title="Replay ${esc(plate)} on this day">${esc(dtStr(at))}</a>`
    : esc(dtStr(at));
};


// 7.5 → "07:30", which reads as a clock time rather than a decimal
export const hourStr = (h) => {
  const n = Number(h);
  if (h == null || h === '' || !Number.isFinite(n)) return '—';
  // Rounding minutes independently of hours produced "23:60" and "06:60".
  const total = Math.round(n * 60);
  const hh = ((Math.floor(total / 60) % 24) + 24) % 24, mm = ((total % 60) + 60) % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
};
/* ── why a column is mostly dashes, said once ──────────────────────────────
   These are the `absent` sentences for the three gaps that recur across the
   whole product. They lived in driver.js, where four tables used them, and
   nine more tables in five other files rendered the SAME columns with no
   explanation at all — a Fares column empty in 330 of 361 rows on #drivers,
   251 of 280 on #roster, 391 of 400 on a vehicle's trips.

   That column is the user's own report: "drivers are not showing fares
   either". They were not, they cannot, and nothing on the page said so —
   which reads as a broken page rather than as a fact about Uber's export.
   Shared here so the sentence is the same wherever the gap is. */
export const UBER_FARE = 'Uber\'s trip export carries no fare column at all, and Uber is most of '
  + 'this fleet\'s work — the money for these trips is in the weekly payout statement, not on the '
  + 'trip, so a fare exists only on the hotel and Yango rows';
/* Rewritten, because the old sentence outlived the thing it described.
   ─────────────────────────────────────────────────────────────────────────
   It read "no channel reports hours to this fleet", and that was true when it
   was written and false the day sql/schema_v37.sql landed: Uber's availability
   feed reports ONLINE spans, src/rollup.js folds them into Dubai days, and
   driver_day.online_min has carried them ever since. A page that prints a
   sentence the codebase has withdrawn teaches the reader to distrust the
   sentences that are still true.

   What IS still true is narrower and worth saying exactly: the hours come from
   the availability feed rather than from a figure a platform published, that
   feed is Uber's alone, and it reaches back 31 days. */
export const UBER_HOURS = 'hours here come from Uber\u2019s availability feed \u2014 the ONLINE spans it '
  + 'emits, folded into days \u2014 and not from a total any platform published: driver_performance is '
  + 'written from the earnings breakdown, which carries trips, distance and money only. Uber is the '
  + 'only channel this fleet works that publishes availability at all, and only for the last 31 days';
/* The first clause is right and the last one was wrong.
   ─────────────────────────────────────────────────────────────────────────
   Nothing fills trip.duration_s — that part holds. But "a trip's own duration
   is not something any channel reports" is contradicted by the same payload:
   ended_at is present on 85% of these rows, and requested-to-dropoff is a
   duration, just not the one the column was named for. Saying no channel
   reports it, while the page holds two timestamps that bracket it, is the
   product refusing to answer a question it can answer. */
export const NO_DURATION = 'no source fills trip.duration_s, so this is the request-to-dropoff span '
  + 'instead \u2014 which contains the drive to the rider, because neither Uber\u2019s export nor the '
  + 'hotel channel reports a pickup time. A dash means that trip carries no dropoff time either';

// `d` is decimals: whole dirhams for totals, two for rates like revenue-per-km
// where rounding to the nearest dirham destroys the number.
export const money = (v, cur = 'AED', d = 0) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '—';
  // A rate needs a FIXED number of decimals: `maximumFractionDigits` alone
  // rendered 2.70 as "AED 2.7", and rounding to whole dirhams rendered it
  // "AED 3" — which is a different number.
  /* And the minus goes BEFORE the currency, in U+2212.
     ─────────────────────────────────────────────────────────────────────
     toLocaleString put an ASCII hyphen after the currency — "AED -600.59" —
     and the two payout tables that render negatives look right only because
     they hand-write "−" and pass Math.abs() to this function. Every other
     negative money figure in the product carried the hyphen, next to
     percentages that carry a true minus. A sign belongs to the number, and
     the number reads left to right: −AED 600.59. */
  const body = Math.abs(n).toLocaleString(undefined,
    { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${n < 0 ? '\u2212' : ''}${cur} ${body}`;
};
/* A percentage, with the same minus sign as every other number on the page.
   ─────────────────────────────────────────────────────────────────────────
   toFixed emits an ASCII hyphen, and money() emits a true minus (U+2212). The
   payout tree puts them in adjacent columns of one table — "−AED 600.59" beside
   "-1.8%" — and the hyphen is narrower and sits higher, so a negative share is
   the one number in the row a reader can scan past. One convention, applied
   where the string is built rather than at ninety call sites. */
export const pct = (v, d = 0) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '—'
  : `${Number(v).toFixed(d).replace(/^-/, '\u2212')}%`);

/* A number that carries its own sign, in the house glyphs.
   ─────────────────────────────────────────────────────────────────────────
   Every hand-built "${v > 0 ? '+' : ''}${Math.round(v)}%" in this product
   emitted an ASCII hyphen for the negative case, because that is what
   Math.round and toFixed produce — so "−76%" and "-76%" appear on the same
   page depending on which line drew it. A minus that is narrower and sits
   higher than the one beside it is a minus a reader can miss, and on a page
   about which way the numbers MOVED that is the whole content.

   Plus is explicit and minus is U+2212. `unit` is appended rather than
   interpolated by the caller so a caller cannot put the sign in the wrong
   place. */
export const signed = (v, { unit = '', d = 0 } = {}) => {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  const body = Math.abs(n).toFixed(d);
  return `${n > 0 ? '+' : n < 0 ? '\u2212' : ''}${fmt(Number(body), d)}${unit}`;
};
/* An optional tone. Callers were already passing one — a rollup that failed
   and a rollup that is merely stale are different messages and were rendering
   identically, because the second argument was silently dropped. */
export const note = (text, tone) => el('div', `note${tone ? ' ' + tone : ''}`, esc(text));
/* ── taking the figures away ───────────────────────────────────────────────
   Everything in this product could be read and none of it could be TAKEN. No
   CSV, no download, no Content-Disposition anywhere in the API or the pages —
   so an operator who wanted last month in a spreadsheet, or an accountant
   reconciling against their own ledger, read numbers off a screen and retyped
   them. The one question this answers most often is "give me the daily trips
   for both organisations", and the answer was a manual transcription.

   The link carries the page's own window and chips, so what downloads is what
   is on screen. With NO fleet chip set that is both fleets, each row naming
   its own — which is the whole point: one file, both organisations, rather
   than two exports to stitch together in the spreadsheet.

   The row limit is checked HERE as well as on the server, off the row count
   the page already has. The server refuses an oversized export rather than
   truncating it (api/export_routes.js), and a refusal arriving as a downloaded
   file full of JSON is a worse answer than a link that says up front why it is
   not offered. */
/* Must equal MAX_ROWS in api/export_routes.js — a browser module cannot import
   a server one, so test/export_csv.test.mjs asserts the two agree. A page
   guard set below the server's refuses downloads that would have worked; set
   above it, the refusal arrives as a file full of JSON. */
export const CSV_MAX_ROWS = 400000;

/**
 * A download line for the trip export.
 * @param bookings row count for the trip grain — the same predicate the
 *   export uses, so the page can honour the server's limit without asking.
 */
export function exportRow(bookings = null) {
  const bar = el('div', 'getout');
  bar.append(el('span', 'getout-lab', 'Download'));
  const link = (grain, label, hint) => {
    const a = el('a', 'getout-a', esc(label));
    a.href = `/api/export/trips.csv?${params({ grain })}`;
    /* No value: the filename comes from the server's Content-Disposition,
       which already names the grain, the window and any chip. */
    a.setAttribute('download', '');
    a.title = hint;
    return a;
  };
  bar.append(link('day', 'daily totals',
    'One row per fleet per channel per Dubai day: bookings, completed, drivers, vehicles, km and fares.'));
  if (bookings == null || bookings <= CSV_MAX_ROWS) {
    bar.append(el('span', 'getout-sep', '·'));
    bar.append(link('trip', 'every trip',
      'One row per booking: time, driver, plate, pickup, dropoff, distance, outcome and fare.'));
  } else {
    bar.append(el('span', 'getout-sep', '·'));
    bar.append(el('span', 'getout-no',
      `every trip — ${fmt(bookings)} bookings is over the ${fmt(CSV_MAX_ROWS)}-row file limit; `
      + 'narrow the window or pick one fleet'));
  }
  bar.append(el('span', 'getout-tz', `CSV · days in ${TZ_LABEL}`));
  return bar;
}

export { fmt, empty };

/* ── the same fold, for things that are not tables ────────────────────────
   The action list is 24,270px — twenty-four laptop screens — and it is a list
   of CARDS, so foldRows cannot reach it: there is no tbody to hide rows in.
   Every argument for folding a 361-row table applies to a 200-card list, and
   more strongly, because a card is taller than a row.

   Takes the container and hides its children past `shown`. Same control, same
   remembered choice, same rule: folded, never truncated. */
export function foldChildren(host, box, { shown = 8, total = null, noun = 'item', key = null } = {}) {
  host.append(box);
  const kids = [...box.children];
  const n = total ?? kids.length;
  const hidden = Math.max(0, n - shown);
  if (!hidden || !kids.length) return;
  const K = key ? `fold:${key}` : null;
  let open = false;
  try { open = K ? localStorage.getItem(K) === 'open' : false; } catch { open = false; }
  const btn = el('button', 'foldbtn');
  const apply = () => {
    kids.forEach((c, i2) => { c.hidden = !open && i2 >= shown; });
    btn.textContent = open
      ? `Show fewer — the first ${fmt(shown)}`
      : `Show the other ${fmt(hidden)} ${plural(hidden, noun)} →`;
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', () => {
    open = !open;
    try { if (K) localStorage.setItem(K, open ? 'open' : 'shut'); } catch { /* not essential */ }
    apply();
  });
  apply();
  host.append(btn);
}


/* ── the verdict band ──────────────────────────────────────────────────────
   Every page in this product opened with a title, a subtitle and then data. A
   reader had to do the interpreting themselves, on all 32 of them: the fleet
   overview showed six tiles and three charts without ever saying what it
   found, and the drivers page opened onto a 361-row table 44,000 pixels tall.
   Measured across the whole app: 275,000 pixels of scroll and 76,000 words,
   none of which states a conclusion.

   A verdict is the page's answer, computed and written as a sentence, above
   everything that supports it. It is not a caption — a caption describes the
   chart beneath it; this says what the chart MEANS, and carries the one figure
   that decides it.

   Rules it enforces, so 32 pages cannot each invent their own:
     · one sentence, present tense, about THIS window
     · the figure that decides it, rendered once and large
     · a tone that is earned — `warn`/`bad` only when something needs doing
     · an optional recommendation, which is the only bold text allowed here */
/* `cohort` names the set the claim counts, and turns the headline into a way
   of reaching it. "1 driver drove and was paid nothing" is the sentence a
   reader most wants to click, and until this it was the one thing on the page
   that led nowhere. */
export function verdict(host, { claim, figure, unit, sub, tone = null, recommend = null,
  meta = null, cohort = null }) {
  const v = el('div', `vdct${tone ? ' ' + tone : ''}`);
  const main = el('div', 'vdct-main');
  main.append(el('h2', 'vdct-claim', esc(claim)));
  if (sub) main.append(el('p', 'vdct-sub', esc(sub)));
  if (recommend) {
    const r = el('p', 'vdct-rec');
    r.innerHTML = `<b>Recommendation:</b> ${esc(recommend)}`;
    main.append(r);
  }
  if (cohort) {
    const a = el('a', 'vdct-who');
    a.href = href('cohort', cohort);
    a.textContent = 'Who exactly? →';
    main.append(a);
  }
  v.append(main);
  if (figure != null) {
    const f = el('div', 'vdct-fig');
    f.innerHTML = `<b>${esc(figure)}</b>${unit ? `<i>${esc(unit)}</i>` : ''}`;
    if (meta) f.append(el('span', 'vdct-meta', esc(meta)));
    v.append(f);
  }
  host.append(v);
  return v;
}

/* ── one bar that carries the headline ─────────────────────────────────────
   A donut of six channels where one is 92.7% is a picture of a fact nobody
   needs six colours to read. A single stacked bar, with the leader named
   INSIDE it and the rest listed beneath with what each one is worth, says the
   same thing in one line and leaves room for why it matters.

   `parts`: [{ label, value, note, cls }] — cls picks the series colour. */
export function dominantBar(host, parts, { total = null, unitLabel = '' } = {}) {
  const sum = total ?? parts.reduce((a, p) => a + (+p.value || 0), 0);
  const wrap = el('div', 'domb');
  const bar = el('div', 'domb-bar');
  bar.innerHTML = parts.filter((p) => +p.value > 0).map((p, i) => {
    const pct = sum ? (p.value / sum) * 100 : 0;
    /* The label rides inside the segment only when it fits. Below about a
       tenth of the width it overflows into its neighbour and reads as that
       segment's name, which is worse than no label. */
    const inside = pct >= 18
      ? `<span>${esc(p.label)}</span><b>${fmt(p.value)}</b><i>${pct.toFixed(1)}%</i>` : '';
    return `<span class="domb-seg ${esc(p.cls || `c${i + 1}`)}" style="width:${pct}%" `
      + `title="${esc(p.label)} · ${fmt(p.value)} · ${pct.toFixed(1)}%">${inside}</span>`;
  }).join('');
  wrap.append(bar);
  const keys = el('div', 'domb-keys');
  keys.innerHTML = parts.map((p, i) =>
    `<span class="domb-key"><i class="sw ${esc(p.cls || `c${i + 1}`)}"></i>`
    + `<b>${esc(p.label)} · ${fmt(p.value)}</b>`
    + (p.note ? `<em>${esc(p.note)}</em>` : '') + '</span>').join('');
  wrap.append(keys);
  if (unitLabel) wrap.append(el('p', 'domb-total', esc(unitLabel)));
  host.append(wrap);
  return wrap;
}

/* ── a table that respects the fold ────────────────────────────────────────
   The drivers table is 361 rows and 44,000 pixels; the roster 280 and 33,000.
   Nobody scrolls either. But truncating to a top ten and calling it "All
   drivers" is the lie this product spent a session removing, so the rows stay
   — folded, with the count of what is folded stated on the control that opens
   them, and the fold remembered per table so a reader who wants the long form
   gets it every time.

   `table` is already built and complete; this only decides how much of it is on
   screen at rest. The rows beyond the fold are `hidden`, so they are out of
   find-in-page while folded — every page with a table this long carries its
   own search box, and that one searches the data rather than the DOM. */
export function foldRows(host, node, { shown = 10, total, noun = 'row', key = null } = {}) {
  host.append(node);
  /* tableFrom returns a `div.tscroll` WRAPPING the table, not the table — so
     reading `node.tBodies` found nothing, the fold returned early, and the
     drivers page stayed 44,625px with no error anywhere. The second silent
     no-op of this session: it rendered, it looked right, it did nothing.
     Accept either, and say so loudly when there is no table at all rather than
     returning quietly a third time. */
  const table = node?.tagName === 'TABLE' ? node : node?.querySelector?.('table');
  const trs = table?.tBodies?.[0] ? [...table.tBodies[0].rows] : [];
  if (!trs.length) {
    if (total > shown) console.warn('[foldRows] no rows found to fold', node?.className);
    return;
  }
  const hidden = Math.max(0, (total ?? trs.length) - shown);
  if (!hidden) return;
  /* Remembered, because a reader who opens the long form on every visit is
     telling you their default. Guarded: a browser with site data blocked
     throws on the getter rather than returning null. */
  const K = key ? `fold:${key}` : null;
  let open = false;
  try { open = K ? localStorage.getItem(K) === 'open' : false; } catch { open = false; }
  const apply = () => {
    trs.forEach((tr, i) => { tr.hidden = !open && i >= shown; });
    btn.textContent = open
      ? `Show fewer — the first ${fmt(shown)}`
      : `Show the other ${fmt(hidden)} ${plural(hidden, noun)} →`;
    btn.setAttribute('aria-expanded', String(open));
  };
  const btn = el('button', 'foldbtn');
  btn.addEventListener('click', () => {
    open = !open;
    try { if (K) localStorage.setItem(K, open ? 'open' : 'shut'); } catch { /* not essential */ }
    apply();
  });
  apply();
  host.append(btn);
}
