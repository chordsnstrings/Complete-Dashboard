/* Paint what we knew, then correct it.
   ─────────────────────────────────────────────────────────────────────────
   The server answers most requests in about 150ms and a cached one in 250ms
   over the network. That is fast and it is not instant: a page still shows
   skeletons until between five and fifteen requests come back, and on a phone
   on 4G the round trips dominate. The dashboard is opened repeatedly by the
   same few people, usually to the same handful of pages, and the numbers move
   every half hour at most. Waiting for the network to re-tell them something
   they already have is the whole delay.

   So a response is kept in the browser and served immediately on the next ask,
   while the real request runs behind it. The page paints real figures with no
   network wait at all, and corrects itself a moment later if anything moved.

   The rules that make this safe rather than merely fast:

     - never a realtime answer. A position feed or a freshness report served
       from yesterday is wrong in a way the reader cannot see.
     - never an error. A 500 held for a day is an outage.
     - never a mutation.
     - the key is the whole URL. ?days=7 and ?days=90 are different questions.
     - bounded, and oldest-out. localStorage is a few megabytes and shared with
       everything else on the origin.
     - a re-render only when the answer actually CHANGED. Redrawing a page that
       is already correct throws away the reader's scroll position and their
       place in a table, which is a worse cost than the one being saved. */

const KEY = 'fleet.swr.v1';
const MAX_BYTES = 3 * 1024 * 1024;      // localStorage is ~5MB for the whole origin
const MAX_ENTRY = 256 * 1024;           // one 170kb directory is worth keeping; a 2MB export is not
const MAX_AGE_MS = 36 * 3600 * 1000;    // beyond a day and a half, wait for the truth

/* Endpoints whose whole point is being current. Matched on the path, before the
   query string, because ?days= never changes whether something is realtime. */
const NEVER = ['/api/live', '/api/track', '/api/status', '/api/rollups',
  '/api/cache-stats', '/api/settings', '/api/probe', '/api/health', '/api/ready'];

const cacheable = (url) => {
  const path = String(url).split('?')[0];
  return !NEVER.some((p) => path.startsWith(p));
};

/* One read and one write of the whole store per operation. localStorage is
   synchronous and on the main thread, so this is deliberately a single small
   JSON blob rather than a key per entry — fifteen separate reads on every page
   load would cost more than the network call being saved. */
function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save(store) {
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* Quota, or a private window that refuses to store. Dropping the whole
       store is right: a half-written cache is worse than none, and the pages
       simply go back to waiting for the network. */
    try { localStorage.removeItem(KEY); } catch { /* nothing more to try */ }
  }
}

function trim(store) {
  const entries = Object.entries(store).sort((a, b) => a[1].at - b[1].at);
  let total = entries.reduce((n, [, v]) => n + (v.body?.length || 0), 0);
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [k, v] of entries) {
    if (total <= MAX_BYTES && v.at >= cutoff) break;
    total -= v.body?.length || 0;
    delete store[k];
  }
  return store;
}

export const swr = {
  /* What we last knew for this URL, or null. */
  get(url) {
    if (!cacheable(url)) return null;
    const hit = load()[url];
    if (!hit || Date.now() - hit.at > MAX_AGE_MS) return null;
    try { return { body: JSON.parse(hit.body), at: hit.at }; } catch { return null; }
  },

  /* Keep it, and say whether it differs from what we had. The caller re-renders
     only when it does. */
  put(url, value) {
    if (!cacheable(url)) return { changed: true };
    let body;
    try { body = JSON.stringify(value); } catch { return { changed: true }; }
    if (body.length > MAX_ENTRY) return { changed: true };
    const store = load();
    const changed = store[url]?.body !== body;
    store[url] = { body, at: Date.now() };
    save(trim(store));
    return { changed };
  },

  clear() { try { localStorage.removeItem(KEY); } catch { /* nothing to do */ } },

  /* For the Sources page and for tests: how much is held, and since when. */
  stats() {
    const store = load();
    const vals = Object.values(store);
    return {
      entries: vals.length,
      bytes: vals.reduce((n, v) => n + (v.body?.length || 0), 0),
      oldest: vals.length ? Math.min(...vals.map((v) => v.at)) : null,
    };
  },
};
