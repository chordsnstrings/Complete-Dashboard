/* Shared state, fetching and routing.
   ──────────────────────────────────────────────────────────────────────────
   The dashboard is a multipage app behind a hash router. A route is
   `#<view>[/<param>[/<sub>]]` — so `#driver/7e96cb47.../territory` is a real,
   linkable address rather than a modal that vanishes on reload. */

export const state = {
  view: 'overview', param: null, sub: null,
  days: 30, platform: '', fleet: '',
  admin: localStorage.getItem('adminToken') || '',
};

export const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
};

// The window every view shares, expressed as dates so the server can widen the
// `to` bound to the end of that day.
export function windowDates() {
  const to = new Date(); const from = new Date();
  from.setDate(from.getDate() - state.days);
  return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
}
export function params(extra = {}) {
  const [from, to] = windowDates();
  const p = new URLSearchParams({ from, to, ...extra });
  if (state.platform) p.set('platform', state.platform);
  if (state.fleet) p.set('fleet', state.fleet);
  return p.toString();
}
export const q = (path, extra) => api(`${path}?${params(extra)}`);

// Same window, but without the platform/fleet filters — detail pages answer
// "everything about this person", and silently hiding half their work because
// a platform filter is set elsewhere would be a lie.
export function unfiltered(extra = {}) {
  const [from, to] = windowDates();
  return new URLSearchParams({ from, to, ...extra }).toString();
}
export const qAll = (path, extra) => api(`${path}?${unfiltered(extra)}`);

/* ── routing ───────────────────────────────────────────────────────────── */
export const href = (view, param, sub) =>
  '#' + [view, param, sub].filter(Boolean).map(encodeURIComponent).join('/');

export function parseHash(h = location.hash.slice(1)) {
  const [view, param, sub] = h.split('/').map((s) => (s ? decodeURIComponent(s) : null));
  return { view: view || null, param: param || null, sub: sub || null };
}
export function navigate(view, param, sub) {
  const next = href(view, param, sub);
  if (location.hash === next) return false;
  location.hash = next; return true;
}
