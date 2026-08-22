/* Shared state, fetching and routing.
   ──────────────────────────────────────────────────────────────────────────
   The dashboard is a multipage app behind a hash router. A route is
   `#<view>[/<param>[/<sub>]]` — so `#driver/7e96cb47.../territory` is a real,
   linkable address rather than a modal that vanishes on reload. */
import { dubaiDay } from './tz.js';

/* Storage access is guarded, not assumed. A browser with site data blocked
   THROWS on the getter rather than returning null, and this module is also
   imported by the Node test suite where there is no localStorage at all — in
   both cases an unguarded read at module scope takes the whole app down before
   a single view renders. */
export const store = {
  get(key, fallback = '') {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* not available */ } },
};

export const state = {
  view: 'overview', param: null, sub: null,
  days: 30, platform: '', fleet: '',
  admin: store.get('adminToken'),
};

export const api = async (path, opts) => {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
};

/* The window every view shares, expressed as DUBAI dates so the server can
   widen the `to` bound to the end of that day.

   This took the UTC day from the viewer's clock. At 02:00 in Dubai the UTC day
   is still yesterday, so "last 30 days" ended a day early and dropped the shift
   in progress — on the one page an operator opens at 2am to see what is
   happening now. West of Greenwich it went the other way and asked for a day
   that has not started in Dubai. The fleet's calendar is Dubai's; the browser's
   location is not part of the question. */
export function windowDates() {
  const now = Date.now();
  return [dubaiDay(new Date(now - state.days * 864e5)), dubaiDay(new Date(now))];
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
/* `#<view>[/<param>[/<sub>]][?days=&platform=&fleet=]`.
   The window and the platform/fleet filters used to live only in `state`, so
   every link anyone sent was a link to the DEFAULT window on that page. Someone
   would narrow to Bolt over 90 days, find the thing, paste the URL, and the
   person opening it saw all platforms over 30 days and no reason to think
   otherwise. A filter that changes what a page says has to be part of the
   page's address. */
const DEFAULTS = { days: 30, platform: '', fleet: '' };

export function filterQuery() {
  const p = new URLSearchParams();
  if (state.days !== DEFAULTS.days) p.set('days', String(state.days));
  if (state.platform) p.set('platform', state.platform);
  if (state.fleet) p.set('fleet', state.fleet);
  const s = p.toString();
  return s ? '?' + s : '';
}

export const href = (view, param, sub) =>
  '#' + [view, param, sub].filter(Boolean).map(encodeURIComponent).join('/') + filterQuery();

export function parseHash(h = location.hash.slice(1)) {
  const qi = h.indexOf('?');
  const path = qi >= 0 ? h.slice(0, qi) : h;
  const search = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : '');
  const [view, param, sub] = path.split('/').map((s) => (s ? decodeURIComponent(s) : null));
  return {
    view: view || null, param: param || null, sub: sub || null,
    // Only values the app actually offers. A hand-edited `days=9999` would
    // otherwise widen every query on the page silently.
    days: [7, 30, 90, 180, 365].includes(+search.get('days')) ? +search.get('days') : null,
    platform: search.get('platform') || null,
    fleet: search.get('fleet') || null,
  };
}
export function navigate(view, param, sub) {
  const next = href(view, param, sub);
  if (location.hash === next) return false;
  location.hash = next; return true;
}
/* Change a filter without leaving the page — and write it into the address, so
   the back button undoes it and the URL still describes what is on screen. */
export function setFilter(patch) {
  Object.assign(state, patch);
  const { view, param, sub } = state;
  location.hash = href(view, param, sub);
}
