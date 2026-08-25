/* Shared UI primitives.
   These used to live inside app.js. They moved out when the dashboard grew
   detail pages of its own: a per-driver page needs the same panels, tables and
   modals as the overview, and copying them would have let the two drift. */
import { fmt, empty } from './charts.js';
import { href } from './data.js';
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
  const body = el('div'); p.append(body);
  return { panel: p, body };
}
export const loading = (host) => { host.innerHTML = '<div class="skel">Loading…</div>'; };

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

export function tableFrom(rows, cols, { compact = false, sortable = false,
  sortId = 't', defaultSort = null, capped = null, onRow = null } = {}) {
  if (!rows.length) { const d = el('div'); empty(d); return d; }
  const wrap = el('div', 'tscroll');
  const t = el('table', compact ? 'compact' : null);

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
  const dead = cols.filter((c) => c.absent && c.key
    && rows.every((r) => isBlank(r[c.key])));
  cols = cols.filter((c) => !dead.includes(c));

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
    return sortable && c.key
      ? `<th class="${cls}" aria-sort="${aria}"><button type="button" data-sk="${esc(c.key)}">`
        + `${esc(c.label)}${mark}</button></th>`
      : `<th class="${cls}" aria-sort="none">${esc(c.label)}</th>`;
  }).join('')}</tr></thead>`;

  const body = (list) => `<tbody>${list.map((r) => `<tr>${cols.map((c) =>
    `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : esc(r[c.key] ?? '—')}</td>`)
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
  if (dead.length) {
    /* Named one per line rather than joined, because each is a different
       missing source and a reader needs to know which. */
    const d = el('div', 'cap tabsent');
    d.innerHTML = dead.map((c) =>
      `<span><b>${esc(c.label)}</b> — ${esc(c.absent)}</span>`).join('');
    wrap.append(d);
  }
  if (sortable && capped) {
    wrap.append(el('p', 'cap tsort-note',
      `Sorting re-orders the ${rows.length} rows on screen, not ${esc(capped)} — the rows that reach `
      + 'this page were chosen by the server before you got to choose the column.'));
  }
  return wrap;
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
export function kpiRow(items) {
  const host = el('div', 'kpis');
  host.innerHTML = items.filter(Boolean).map((k) => `
    <div class="kpi${k.tone ? ' t-' + k.tone : ''}">
      <div class="l">${esc(k.label)}</div>
      <div class="n num">${k.html || esc(k.value ?? '—')}</div>
      ${k.sub ? `<div class="s">${esc(k.sub)}</div>` : ''}
    </div>`).join('');
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
export const timeStr = (v) => {
  const d = asDate(v);
  return d ? d.toLocaleTimeString(undefined,
    { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—';
};
export const dtStr = (v) => (asDate(v) ? `${dayStr(v)} ${timeStr(v)}` : '—');

/* A source's name as a person writes it. These are database keys — `fms`,
   `cabman` — and they were rendered raw as panel HEADINGS on the two pages an
   operator opens to ask which collector is broken. */
export const SOURCE_LABEL = {
  uber: 'Uber', yango: 'Yango', bolt: 'Bolt', hotel: 'Hotel', fms: 'FMS telematics',
  cabman: 'CABMAN', ecosine: 'Ecosine', egari: 'Egari',
};
export const sourceLabel = (s) => SOURCE_LABEL[String(s || '').toLowerCase()] || String(s || '—');

/* "yango is missing 1 days" and "1 have no record of ever being requested".
   Takes the count so the caller cannot forget to look at it. */
export const plural = (n, one, many) => (Math.abs(Number(n)) === 1 ? one : (many ?? `${one}s`));
export const countOf = (n, one, many) => `${fmt(n)} ${plural(n, one, many)}`;

/* A list column that may arrive either way.
   Several endpoints return a set of names as a comma-joined STRING —
   `unavailable_sources: "bolt, yango"`, `channels_checked: "uber,yango,hotel"` —
   and others return a real array for the same idea. Calling .join on the
   string form throws and takes the whole view with it. */
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
// `d` is decimals: whole dirhams for totals, two for rates like revenue-per-km
// where rounding to the nearest dirham destroys the number.
export const money = (v, cur = 'AED', d = 0) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return '—';
  // A rate needs a FIXED number of decimals: `maximumFractionDigits` alone
  // rendered 2.70 as "AED 2.7", and rounding to whole dirhams rendered it
  // "AED 3" — which is a different number.
  return `${cur} ${n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};
export const pct = (v, d = 0) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '—' : `${Number(v).toFixed(d)}%`);
/* An optional tone. Callers were already passing one — a rollup that failed
   and a rollup that is merely stale are different messages and were rendering
   identically, because the second argument was silently dropped. */
export const note = (text, tone) => el('div', `note${tone ? ' ' + tone : ''}`, esc(text));
export { fmt, empty };
