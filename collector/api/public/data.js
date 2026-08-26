/* Shared state, fetching and routing.
   ──────────────────────────────────────────────────────────────────────────
   The dashboard is a multipage app behind a hash router. A route is
   `#<view>[/<param>[/<sub>]]` — so `#driver/7e96cb47.../territory` is a real,
   linkable address rather than a modal that vanishes on reload. */
import { dubaiDay } from './tz.js';
import { swr } from './swr.js';

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
  view: 'unit', param: null, sub: null,
  days: 30, platform: '', fleet: '',
  admin: store.get('adminToken'),
};

/* Which render is the current one.
   ─────────────────────────────────────────────────────────────────────────
   A view is a sequence of awaits, and the reader can navigate through the
   middle of one. The shell empties #view and starts again; the abandoned
   render is still holding a reference to panels that are no longer on the page
   and carries on writing to them. On #unauthorized that means
   `root.insertBefore(w, g)` throwing "not a child of this node" — whose catch
   then replaces the WHOLE page with an error box, recoverable only by
   reloading. On #sources it means the abandoned render's panels appended
   beside the new ones, five panels becoming seven with two drawn twice.

   A view captures `currentGen()` before its first await and checks `alive()`
   after each one. Kept here rather than in the shell so a page module can
   import it without importing the shell back. */
let renderGen = 0;
export const newRender = () => ++renderGen;
export const currentGen = () => renderGen;
export const alive = (g) => g === renderGen;

/* Fetch, but answer from what we last knew if we have it.
   ─────────────────────────────────────────────────────────────────────────
   A page issues between five and fifteen of these and shows skeletons until
   they land. On a phone the round trips are most of the wait, and the numbers
   behind them move every half hour at most — so the reader is waiting for the
   network to re-tell them something they already have.

   With a stored answer the page paints real figures immediately and the real
   request runs behind it. When it comes back different, `data:refreshed` fires
   and the view redraws; when it comes back the same, nothing happens at all,
   which is the common case and the reason this does not flicker.

   See api/public/swr.js for what is never cached and why. */
/* A gateway timeout is not a dead end — usually it is a race we can win.
   ─────────────────────────────────────────────────────────────────────────
   The platform's gateway gives up on a slow request, but our server does not:
   it finishes the query, stores the answer in the response cache, and the next
   request for the same URL is served from memory in milliseconds. So a 502/503/
   504 on a GET is worth exactly one more try, a moment later — the retry
   usually lands on the answer the abandoned request just finished computing.

   Only for GETs without options: a POST is not safe to repeat, and this must
   never turn one collection trigger into two. */
const GATEWAY = new Set([502, 503, 504]);
async function fetchWithRetry(path, opts) {
  const r = await fetch(path, opts);
  if (r.ok || opts || !GATEWAY.has(r.status)) return r;
  await new Promise((res) => setTimeout(res, 1200));
  return fetch(path, opts);
}

/* What the reader is told when it fails anyway. The gateway answers with a
   full HTML error page, and printing the first 160 characters of it put
   `504 <!DOCTYPE html> <html> <head> <meta name="viewport"…` on screen where a
   sentence belonged — the reader learns nothing and cannot tell a slow query
   from a broken one. */
async function failure(r) {
  const text = await r.text().catch(() => '');
  if (GATEWAY.has(r.status) || /^\s*<(!doctype|html)/i.test(text)) {
    return `${r.status} — the server took too long to answer. It is usually still `
      + 'computing this; try again in a moment.';
  }
  try {
    const j = JSON.parse(text);
    if (j?.error) return `${r.status} ${j.error}${j.detail ? `: ${j.detail}` : ''}`;
  } catch { /* not JSON — fall through to the raw text */ }
  return `${r.status} ${text.slice(0, 160)}`;
}

export const api = async (path, opts) => {
  const method = (opts?.method || 'GET').toUpperCase();
  const held = method === 'GET' && !opts ? swr.get(path) : null;

  const live = (async () => {
    const r = await fetchWithRetry(path, opts);
    if (!r.ok) throw new Error(await failure(r));
    const body = await r.json();
    if (method === 'GET' && !opts) {
      const { changed } = swr.put(path, body);
      /* Only when it moved. Redrawing a page that is already correct costs the
         reader their scroll position and their place in a table, which is
         worse than the wait being saved. */
      if (changed && held) {
        window.dispatchEvent(new CustomEvent('data:refreshed', { detail: { path } }));
      }
    }
    return body;
  })();

  if (held) {
    /* The request is still running; it must not become an unhandled rejection
       just because nobody is awaiting it. A failed refresh leaves the reader
       with the figures they already had, which is the right outcome. */
    live.catch(() => {});
    return held.body;
  }
  return live;
};

/* The window every view shares, expressed as DUBAI dates so the server can
   widen the `to` bound to the end of that day.

   This took the UTC day from the viewer's clock. At 02:00 in Dubai the UTC day
   is still yesterday, so "last 30 days" ended a day early and dropped the shift
   in progress — on the one page an operator opens at 2am to see what is
   happening now. West of Greenwich it went the other way and asked for a day
   that has not started in Dubai. The fleet's calendar is Dubai's; the browser's
   location is not part of the question. */
/* INCLUSIVE of both ends, so "last 7 days" is seven days and not eight.
   `dubaiDay(now - days * 864e5)` counts back `days` whole days from today and
   then includes today as well — an eight-day range under a label saying seven.
   api/window.js returns exactly `n` days for the same `?days=n`, so the UI and
   a hand-typed URL disagreed about the same window: at days=7 the UI asked for
   2026-08-18 → 2026-08-25 and /api/revenue answered `window_days 8`, rendering
   "8 of 8 days"; /api/kpis?days=7 fetched directly returned 2,876 trips where
   the UI's own "Last 7 days" returned 3,325. Every rate in the product was
   over one more day than it said. */
export function windowDates() {
  const now = Date.now();
  return [dubaiDay(new Date(now - (state.days - 1) * 864e5)), dubaiDay(new Date(now))];
}
/* An absent value must be ABSENT, not the four-letter word "undefined".
   ─────────────────────────────────────────────────────────────────────────
   URLSearchParams stringifies everything it is handed, so `{ fleet: undefined }`
   went over the wire as `fleet=undefined` — and a route that reads
   `req.query.fleet || null` sees a non-empty string and filters on a fleet by
   that name. Nothing matches, and the page renders a perfectly healthy-looking
   empty state.

   #compare shipped with exactly this: `fleet: state.fleet || undefined`, three
   panels reading "No booking on either day" over a database holding 293
   bookings that day. It is the worst class of front-end bug — no error, no
   warning, a page that looks like an answer.

   Dropped here, once, rather than at each of the two hundred call sites. */
const clean = (o = {}) => Object.fromEntries(
  Object.entries(o).filter(([, v]) => v != null && v !== ''));

export function params(extra = {}) {
  const [from, to] = windowDates();
  const p = new URLSearchParams({ from, to, ...clean(extra) });
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
  return new URLSearchParams({ from, to, ...clean(extra) }).toString();
}
export const qAll = (path, extra) => api(`${path}?${unfiltered(extra)}`);

/* The channel chips WITHOUT the window — for pages whose subject is the whole
   record but which are still one fleet's or one channel's.
   ─────────────────────────────────────────────────────────────────────────
   #causes is the case that needed it. Its three endpoints are whole-record by
   construction: a monthly trend, change detection across that trend, and the
   events bounded to the months actually observed. So the date range does not
   apply and the page is on NO_RANGE. But /api/trend/monthly and /api/breaks
   both bind fleet and platform — the server comments say so, having been fixed
   for exactly this — and the page was calling them through bare api(), sending
   neither. The chips were on screen, the server was ready to honour them, and
   choosing "egari" changed nothing on the page whose whole job is explaining
   why the numbers moved. */
export function channels(extra = {}) {
  const p = new URLSearchParams(clean(extra));
  if (state.platform) p.set('platform', state.platform);
  if (state.fleet) p.set('fleet', state.fleet);
  return p.toString();
}
export const qChan = (path, extra) => {
  const qs = channels(extra);
  return api(qs ? `${path}?${qs}` : path);
};

/* ── routing ───────────────────────────────────────────────────────────── */
/* `#<view>[/<param>[/<sub>]][?days=&platform=&fleet=]`.
   The window and the platform/fleet filters used to live only in `state`, so
   every link anyone sent was a link to the DEFAULT window on that page. Someone
   would narrow to Bolt over 90 days, find the thing, paste the URL, and the
   person opening it saw all platforms over 30 days and no reason to think
   otherwise. A filter that changes what a page says has to be part of the
   page's address. */
const DEFAULTS = { days: 30, platform: '', fleet: '' };

/* Which controls a view actually offers. Declared here rather than in the
   shell, because href() has to agree with it: an address that carries a filter
   the destination page hides is a filter nobody can see, change or undo, and
   `#capacity?fleet=egari` was exactly that — a page whose numbers are supposed
   to be filtered by a control that is not on screen.

   NO_FILTER hides all three. NO_RANGE hides only the window (reconciliation is
   whole months by construction, but a fleet's money is still its own).
   NO_PLATFORM_FLEET hides the two channel controls: every detail page answers
   "everything about this person / car / property" through qAll(), so a chip
   reading "egari" above a card reading ECOSINE described nothing. `coverage`
   is here because /api/coverage and /api/coverage/calendar ignore both — it
   comes off this list the day they stop ignoring them. */
/* #compare carries its own two days in the address, so a range chip on it is
   a control that changes nothing — and one that would quietly ride along into
   every link leaving the page. The channel filter stays: comparing two days
   for one fleet, or one platform, is the second question anybody asks. */
export const NO_RANGE = ['reconcile', 'compare',
  /* #causes is thirteen months of trend, the breaks detected across them, and
     the events bounded to the months actually observed. Not one of its three
     endpoints takes a window, so the selector above it was a control that
     changed nothing — and worse, rode along into every link leaving the page.
     Its channel chips stay: a fleet's trend is its own, and the server binds
     both fleet and platform on two of the three. */
  'causes',
  /* All three performer pages are a fixed Monday-to-Sunday week, chosen by the
     page and named in its caption. A range chip above them changes nothing and
     reads as though it does — and worse, rides along into every link leaving
     the page. */
  'top-performers', 'low-performers', 'performer'];
export const NO_PLATFORM_FLEET = ['driver', 'vehicle', 'property', 'coverage'];
/* #map is a live position feed with its own plate-and-day picker, and #segment
   is one occupancy segment addressed by plate and instant. /api/live takes no
   parameters at all, /api/map/days takes a plate, /api/segment takes a plate
   and a timestamp — so all three controls above these two pages governed
   nothing on them. */
export const NO_FILTER = ['settings', 'live', 'sources', 'day', 'providers', 'action', 'insights',
  /* #trip is ONE booking addressed by the provider's own id. /api/trip takes a
     platform and an id and nothing else — a range, a channel or a fleet
     control above it would govern nothing, and would ride along into every
     link leaving the page. */
  'compliance', 'forecast', 'retention', 'capacity', 'map', 'segment', 'trip'];

export const hidesRange = (v) => NO_FILTER.includes(v) || NO_RANGE.includes(v);
export const hidesChannel = (v) => NO_FILTER.includes(v) || NO_PLATFORM_FLEET.includes(v);

/* `extra` is merged into the SAME query string rather than concatenated after
   it. Appending "?day=…" to an href that already carried "?days=365" produced
   `#vehicle/L27045/movement?days=365?day=2026-08-25` — URLSearchParams reads
   one key `days` whose value is "365?day=2026-08-25", so the window silently
   reset to 30 and the day was never seen at all. */
export function filterQuery(view = state.view, extra = null, over = null) {
  const s = { days: state.days, platform: state.platform, fleet: state.fleet, ...(over || {}) };
  const p = new URLSearchParams();
  if (!hidesRange(view) && s.days !== DEFAULTS.days) p.set('days', String(s.days));
  if (!hidesChannel(view)) {
    if (s.platform) p.set('platform', s.platform);
    if (s.fleet) p.set('fleet', s.fleet);
  }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v != null && v !== '') p.set(k, String(v));
  }
  const qs = p.toString();
  return qs ? '?' + qs : '';
}

export const href = (view, param, sub, extra) =>
  '#' + [view, param, sub].filter(Boolean).map(encodeURIComponent).join('/') + filterQuery(view, extra);

/* An address that carries a DIFFERENT filter from the one currently set.
   A donut slice knows which platform it is; the click threw that away and
   opened the unfiltered page, so every slice of the ring led to the same
   place. This builds the link the slice deserves without a handler, so it can
   be middle-clicked, opened in a tab and hovered for its destination. */
export const hrefFilter = (view, patch = {}, param = null, sub = null) =>
  '#' + [view, param, sub].filter(Boolean).map(encodeURIComponent).join('/')
  + filterQuery(view, null, patch);

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
    /* A single day, validated the same way: every trip row deep-links to the
       vehicle's replay OF THAT DAY, and the movement page reads this to
       preselect it. A malformed value is null, and the page falls back to the
       newest replayable day exactly as if no day had been asked for. */
    day: /^\d{4}-\d{2}-\d{2}$/.test(search.get('day') || '') ? search.get('day') : null,
    /* Where #compare cuts both days. 'full' is the reader deliberately asking
       for a partial today against a whole yesterday; anything else means the
       like-for-like default, which is the current Dubai minute. */
    cut: search.get('cut') === 'full' ? 'full' : null,
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
