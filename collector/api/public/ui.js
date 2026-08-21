/* Shared UI primitives.
   These used to live inside app.js. They moved out when the dashboard grew
   detail pages of its own: a per-driver page needs the same panels, tables and
   modals as the overview, and copying them would have let the two drift. */
import { fmt, empty } from './charts.js';

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

export function drill(title, subtitle, renderBody) {
  const back = el('div', 'modal-back');
  const box = el('div', 'modal');
  box.innerHTML = `<div class="modal-head"><div><h3>${esc(title)}</h3><p class="cap">${esc(subtitle || '')}</p></div>
    <button class="btn sec" id="mClose">Close</button></div>`;
  const body = el('div', 'modal-body'); box.append(body); back.append(box); document.body.append(back);
  const close = () => back.remove();
  box.querySelector('#mClose').onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
  document.addEventListener('keydown', function onEsc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); } });
  loading(body);
  Promise.resolve(renderBody(body)).catch((e) => { body.innerHTML = `<div class="empty"><b>Could not load</b>${esc(e.message)}</div>`; });
}

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

export const pill = (text, tone) => `<span class="pill${tone ? ' ' + tone : ''}">${esc(text)}</span>`;

export const dateStr = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const dayStr = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '—');
export const timeStr = (v) => (v ? new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');
export const dtStr = (v) => (v ? `${dayStr(v)} ${timeStr(v)}` : '—');
// 7.5 → "07:30", which reads as a clock time rather than a decimal
export const hourStr = (h) => (h == null || isNaN(h) ? '—'
  : `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`);
// `d` is decimals: whole dirhams for totals, two for rates like revenue-per-km
// where rounding to the nearest dirham destroys the number.
export const money = (v, cur = 'AED', d = 0) => (v == null || v === '' ? '—' : `${cur} ${fmt(v, d)}`);
export const pct = (v, d = 0) => (v == null || isNaN(v) ? '—' : `${Number(v).toFixed(d)}%`);
export const note = (text) => el('div', 'note', esc(text));
export { fmt, empty };
