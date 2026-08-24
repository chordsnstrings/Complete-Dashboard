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

export function tableFrom(rows, cols, { compact = false } = {}) {
  if (!rows.length) { const d = el('div'); empty(d); return d; }
  const wrap = el('div', 'tscroll');
  const t = el('table', compact ? 'compact' : null);
  t.innerHTML = `<thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.render ? c.render(r) : esc(r[c.key] ?? '—')}</td>`).join('')}</tr>`).join('')}</tbody>`;
  wrap.append(t); return wrap;
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
  // Anchored at midday: a bare YYYY-MM-DD parses as UTC midnight, which renders
  // as the previous day for any viewer west of Greenwich.
  ? `${entity('driver', ref.id, ref.name)}<span class="dim"> as of `
    + `${ref.day ? dayStr(`${ref.day}T12:00:00`) : 'an unrecorded day'}</span>`
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

export const dateStr = (v) => (v ? new Date(v).toLocaleDateString(undefined,
  { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) : '—');
export const dayStr = (v) => (v ? new Date(v).toLocaleDateString(undefined,
  { day: 'numeric', month: 'short', timeZone: TZ }) : '—');
export const timeStr = (v) => (v ? new Date(v).toLocaleTimeString(undefined,
  { hour: '2-digit', minute: '2-digit', timeZone: TZ }) : '—');
export const dtStr = (v) => (v ? `${dayStr(v)} ${timeStr(v)}` : '—');

/* A trip's timestamp, as a door into the telemetry behind it: the link opens
   the vehicle's movement replay preselected to that trip's Dubai day. Every
   table that lists trips renders its time through this, so "what actually
   happened on that ride" is one click from any number that mentions it. No
   plate — a hotel booking before dispatch, an unmatched statement line — and
   it degrades to the plain timestamp rather than a link to nowhere. */
export const tripTime = (plate, at) => (plate && at
  ? `<a class="lnk" href="${href('vehicle', plate, 'movement')}?day=${dubaiDay(at)}" `
    + `title="Replay ${esc(plate)} on this day">${esc(dtStr(at))}</a>`
  : esc(dtStr(at)));


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
