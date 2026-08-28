/* The phone's component vocabulary.
   ─────────────────────────────────────────────────────────────────────────
   Small on purpose. Everything that already exists and is not shaped by the
   screen — el(), esc(), money(), pct(), the date formatters, fmt() — is
   imported from the desktop modules rather than rewritten, so a change to how
   this product writes a number reaches both applications at once.

   What IS here is the handful of things a thumb needs and a mouse does not: a
   row instead of a table, a sheet instead of a dropdown, a segmented control
   instead of a select, and a sparkline small enough to sit inside a stat. */
import { el, esc, money, pct, dayStr } from '../ui.js';
import { fmt } from '../charts.js';

export { el, esc, money, pct, dayStr, fmt };

export const card = (title, cap) => {
  const c = el('div', 'm-card');
  if (title) c.append(el('h2', null, esc(title)));
  if (cap) c.append(el('p', 'm-cap', esc(cap)));
  const body = el('div', 'm-body');
  c.append(body);
  return { card: c, body };
};

/* One sentence and the number it is about. The claim comes first because on a
   phone the first line is often the only line read. */
export const lede = (host, { claim, sub, tone }) => {
  const d = el('div', `m-lede${tone ? ` ${tone}` : ''}`);
  d.append(el('b', null, esc(claim)));
  if (sub) d.append(el('p', null, esc(sub)));
  host.append(d);
  return d;
};

export const stat = ({ label, value, sub, tone, href, long }) => {
  const s = el(href ? 'a' : 'div', `m-stat${tone ? ` ${tone}` : ''}`);
  if (href) s.href = href;
  s.append(el('span', 'l', esc(label)));
  const n = el('span', `n${long || String(value).length > 9 ? ' sm' : ''}`, esc(String(value)));
  s.append(n);
  if (sub) s.append(el('span', 's', esc(sub)));
  return s;
};

export const stats = (host, list, three = false) => {
  const g = el('div', `m-stats${three ? ' three' : ''}`);
  list.filter(Boolean).forEach((s) => g.append(stat(s)));
  host.append(g);
  return g;
};

/* A row is an identity, a figure, and one line of why. `to` makes it a link,
   which is what a drill-down is here — an address, not a modal. */
export const row = ({ title, sub, value, note, to, tone }) => {
  /* A link gets a chevron in a slot of its own. Putting one in the figure
     column made it share the right edge with a tabular number, and the two
     took turns being clipped. */
  const r = el(to ? 'a' : 'div', `m-row${to ? ' go' : ''}`);
  if (to) r.href = to;
  const k = el('div', 'k');
  k.append(el('b', null, esc(title)));
  if (sub) k.append(el('span', null, esc(sub)));
  r.append(k);
  const v = el('div', 'v');
  if (value != null && value !== '' && value !== '\u203a') {
    const b = el('b', null, esc(String(value)));
    if (tone) b.style.color = `var(--${tone})`;
    v.append(b);
  }
  if (note) v.append(el('span', null, esc(note)));
  r.append(v);
  if (to) r.append(el('span', 'chev', '\u203a'));
  return r;
};

export const rows = (host, list) => {
  const box = el('div', 'm-rows');
  list.filter(Boolean).forEach((r) => box.append(r instanceof Node ? r : row(r)));
  host.append(box);
  return box;
};

/* The control owns which of its buttons is lit. Callers used to re-derive that
   by comparing button text to a label map, which is a second source of truth
   that goes wrong the first time a label is reworded. */
export const seg = (host, options, active, onPick) => {
  const s = el('div', 'm-seg');
  const btns = options.map((o) => {
    const b = el('button', o.id === active ? 'on' : null, esc(o.label));
    b.type = 'button';
    b.dataset.id = o.id;
    b.onclick = () => {
      btns.forEach((x) => x.classList.toggle('on', x.dataset.id === o.id));
      onPick(o.id);
    };
    s.append(b);
    return b;
  });
  host.append(s);
  return s;
};

export const chips = (host, options, active, onPick) => {
  const c = el('div', 'm-chips');
  options.forEach((o) => {
    const a = el('button', `m-chip${o.id === active ? ' on' : ''}`, esc(o.label));
    a.type = 'button';
    a.onclick = () => onPick(o.id);
    c.append(a);
  });
  host.append(c);
  return c;
};

export const search = (host, placeholder, onType) => {
  const w = el('div', 'm-search');
  w.append(el('span', null, '⌕'));
  const i = el('input');
  i.type = 'search'; i.placeholder = placeholder; i.autocomplete = 'off';
  /* Typed on a phone keyboard, so it debounces: filtering 300 drivers on
     every keystroke made the field itself feel broken. */
  let t = null;
  i.oninput = () => { clearTimeout(t); t = setTimeout(() => onType(i.value.trim()), 130); };
  w.append(i);
  host.append(w);
  return i;
};

export const skeleton = (host, n = 3) => {
  host.innerHTML = '';
  for (let i = 0; i < n; i++) host.append(el('div', 'm-skel'));
};

export const empty = (host, title, why) => {
  const d = el('div', 'm-card');
  d.innerHTML = `<div class="m-empty"><b>${esc(title)}</b>${esc(why || '')}</div>`;
  host.append(d);
  return d;
};

export const failed = (host, e) => {
  const d = el('div', 'm-card m-err');
  d.innerHTML = `<div class="m-empty"><b>Could not load this</b>${esc(
    /offline/i.test(String(e && e.message)) ? 'No network, and nothing cached for it yet.'
      : String((e && e.message) || e))}</div>`;
  host.append(d);
  return d;
};

/* A sparkline, sized in the box it is given rather than in pixels, so it works
   in a stat card and across a full-width card without two versions. */
export const spark = (values, { h = 34, tone = 'var(--accent)', fill = true } = {}) => {
  const v = values.map(Number).filter((n) => Number.isFinite(n));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 100 ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = `display:block;width:100%;height:${h}px;overflow:visible`;
  if (v.length < 2) return svg;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const pad = 2.5;
  const pt = (n, i) => [
    (i / (v.length - 1)) * 100,
    h - pad - ((n - lo) / span) * (h - pad * 2),
  ];
  const d = v.map((n, i) => `${i ? 'L' : 'M'}${pt(n, i).map((x) => x.toFixed(2)).join(' ')}`).join('');
  if (fill) {
    const a = document.createElementNS(ns, 'path');
    a.setAttribute('d', `${d}L100 ${h}L0 ${h}Z`);
    a.setAttribute('fill', tone); a.setAttribute('opacity', '.12');
    svg.append(a);
  }
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d); p.setAttribute('fill', 'none');
  p.setAttribute('stroke', tone); p.setAttribute('stroke-width', '1.6');
  p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
  p.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(p);
  const [cx, cy] = pt(v[v.length - 1], v.length - 1);
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('r', '2');
  dot.setAttribute('fill', tone);
  dot.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.append(dot);
  return svg;
};

/* Proportion as a stack of bars rather than a donut: a donut at 120px wide is
   a coloured ring with the labels somewhere else. */
export const bars = (host, list, { max = 6 } = {}) => {
  const all = list.filter((r) => Number(r.n) > 0);
  const rowsIn = all.slice(0, max);
  /* The share is of EVERYTHING, not of the six that fitted. Dividing by the
     visible rows made five payment types read 17% each and sum to 84%, which
     is a percentage of nothing the reader can name. */
  const total = all.reduce((a, r) => a + Number(r.n), 0) || 1;
  const box = el('div');
  box.style.cssText = 'display:flex;flex-direction:column;gap:9px';
  rowsIn.forEach((r, i) => {
    const line = el('div');
    line.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:8px;align-items:baseline';
    line.append(el('span', null, esc(r.label)), (() => {
      const s = el('span', 'num');
      s.style.cssText = 'font-size:.8rem;color:var(--ink-2)';
      s.textContent = `${fmt(r.n)} · ${Math.round((r.n / total) * 100)}%`;
      return s;
    })());
    const track = el('div');
    track.style.cssText = 'height:6px;border-radius:3px;background:var(--surface-3);overflow:hidden;margin-top:5px';
    const fillEl = el('div');
    fillEl.style.cssText = `height:100%;width:${(r.n / total) * 100}%;`
      + `background:var(--s${(i % 6) + 1});border-radius:3px`;
    track.append(fillEl);
    const wrap = el('div');
    wrap.style.fontSize = '.83rem';
    wrap.append(line, track);
    box.append(wrap);
  });
  if (all.length > rowsIn.length) {
    const rest = all.slice(rowsIn.length).reduce((a, r) => a + Number(r.n), 0);
    const more = el('p', 'm-cap');
    more.style.cssText = 'margin:2px 0 0;font-size:.74rem';
    more.textContent = `${all.length - rowsIn.length} more, `
      + `${Math.round((rest / total) * 100)}% between them.`;
    box.append(more);
  }
  host.append(box);
  return box;
};
