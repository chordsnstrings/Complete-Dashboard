/* Response cache for read endpoints.
   ─────────────────────────────────────────────────────────────────────────
   Every /api GET here answers a question about data that changes only when the
   collector writes — every thirty minutes, plus a quarter-hourly rollup. Two
   people opening the same page in the same minute run the same aggregate
   twice, and one person moving between tabs runs each of them again on the way
   back. On a small managed Postgres that is most of the load, and it showed:
   the same endpoint measured 4.3s and 9.5s ten minutes apart, the difference
   being what else happened to be running.

   Keyed on a DATA VERSION rather than a clock. A time-to-live has to choose
   between serving stale numbers and expiring answers that are still perfectly
   good; the version is derived from when the collector and the rollups last
   finished, so an entry is valid exactly as long as the data behind it has not
   moved. Nothing is served from before a write, and nothing is discarded
   because a timer went off.

   What it must not do, each checked in test/cache.test.mjs:
     - cache anything but a 200. An error cached for half an hour is an outage.
     - cache a mutation, or a route whose whole job is reporting freshness.
     - collapse two different questions into one answer. The key is the whole
       URL, query string included: ?days=7 and ?days=90 are different questions
       sharing a path.
     - grow without bound. */

const MAX_ENTRIES = 400;

/* Never cached, by prefix. /api/live and /api/track are realtime positions, and
   a minute old is simply wrong. /api/settings reads credential state.
   /api/rollups and /api/status are how a reader checks whether the data is
   fresh, which cannot itself be answered from a cache. */
const NEVER = ['/api/live', '/api/track', '/api/settings', '/api/rollups',
  '/api/status', '/api/health', '/api/ready', '/api/probe', '/api/cache-stats'];

export function responseCache({ pool, ttlMs = 30000, enabled = true } = {}) {
  const store = new Map();          // url -> { version, body, type }
  let version = 'boot';
  let checkedAt = 0;
  const stats = { hit: 0, miss: 0, skip: 0 };

  /* The version is the latest finish time of anything that writes: a collection
     run, or a rollup. Re-read at most every ttlMs, so the cache costs one small
     query per half minute rather than one per request — and that query is the
     only thing standing between a reader and a stale answer. */
  async function currentVersion() {
    if (Date.now() - checkedAt < ttlMs) return version;
    checkedAt = Date.now();
    try {
      const { rows } = await pool.query(
        `SELECT (SELECT max(finished_at) FROM collection_run) AS c,
                (SELECT max(finished_at) FROM rollup_state)   AS r`);
      const iso = (v) => (v?.toISOString ? v.toISOString() : String(v ?? '-'));
      version = `${iso(rows[0]?.c)}|${iso(rows[0]?.r)}`;
    } catch {
      /* If we cannot tell whether the data moved, assume it did. Serving a
         known-good answer would be faster and might be wrong, and no cache is
         worth a wrong number. */
      version = `unknown-${Date.now()}`;
    }
    return version;
  }

  const middleware = async function cache(req, res, next) {
    if (!enabled || req.method !== 'GET') return next();
    /* originalUrl, not req.path. Mounted with app.use('/api', cache), Express
       strips the mount point before the handler sees it — req.path is
       '/live/now', so every prefix in NEVER matched nothing and the realtime
       position feed and the credential state were both being cached. A guard
       that silently guards nothing is worse than no guard, because the list
       reads as if the question had been considered. */
    const path = req.originalUrl.split('?')[0];
    if (NEVER.some((p) => path.startsWith(p))) { stats.skip++; return next(); }

    const key = req.originalUrl;
    const v = await currentVersion();
    const hit = store.get(key);
    if (hit && hit.version === v) {
      stats.hit++;
      res.set('x-cache', 'hit');
      res.set('content-type', hit.type);
      return res.send(hit.body);
    }

    /* Intercepted on the way out rather than wrapping every route. res.json is
       what every route here answers with. */
    stats.miss++;
    res.set('x-cache', 'miss');
    const origJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode === 200) {
        try {
          const text = JSON.stringify(body);
          // Bounded, oldest first: a Map iterates in insertion order.
          if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
          store.set(key, { version: v, body: text, type: 'application/json; charset=utf-8' });
        } catch { /* a body that will not serialise is one we cannot cache */ }
      }
      return origJson(body);
    };
    return next();
  };

  // For /api/cache-stats and for the tests, which need to see inside.
  middleware.stats = () => ({ ...stats, entries: store.size, version });
  middleware.clear = () => { store.clear(); checkedAt = 0; };
  return middleware;
}
