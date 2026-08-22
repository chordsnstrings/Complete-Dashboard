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

/* Bounded by bytes, not by entry count.
   400 entries was the first guess and it was wrong in both directions: the
   product has 35 views and offers five windows, so a single person exploring it
   passes 400 keys and starts evicting entries they are still using — measured
   at 4,852 misses against 810 hits, which is a cache paying its costs and
   returning almost nothing. And an entry is not a unit of anything: the driver
   directory is 172kb and a KPI row is under 1kb, so counting them treats two
   hundredfold different things as equal.

   64MB of JSON is a few thousand of the small ones or a few hundred of the
   large, which is the whole product across every window with room to spare, and
   is nothing next to the memory a Node process already holds. */
const MAX_BYTES = Number(process.env.CACHE_MAX_BYTES || 64 * 1024 * 1024);

/* Never cached, by prefix. /api/live and /api/track are realtime positions, and
   a minute old is simply wrong. /api/settings reads credential state.
   /api/rollups and /api/status are how a reader checks whether the data is
   fresh, which cannot itself be answered from a cache. */
const NEVER = ['/api/live', '/api/track', '/api/settings', '/api/rollups',
  '/api/status', '/api/health', '/api/ready', '/api/probe', '/api/cache-stats'];

export function responseCache({ pool, ttlMs = 30000, enabled = true, port,
  maxBytes = MAX_BYTES } = {}) {
  /* The port to re-request a stale key on. Set after listen, because with
     PORT=0 the real one does not exist until then. */
  let boundPort = port || null;
  const selfPort = () => boundPort;
  const store = new Map();          // url -> { version, at, body, type }
  let bytes = 0;                    // total held, kept in step with the store
  let version = 'boot';
  let checkedAt = 0;
  const stats = { hit: 0, stale: 0, miss: 0, skip: 0 };
  /* Keys with a background refresh already in flight. Without this a burst of
     readers on a just-invalidated page each start the same aggregate, which is
     the thundering herd the cache exists to prevent, arriving one moment
     later. */
  const refreshing = new Set();

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

    // A background refresh must reach the route, not be handed the stale copy
    // it was sent to replace — which would leave the entry stale for ever.
    const warm = req.get('x-warm') === '1';
    const key = req.originalUrl;
    const v = await currentVersion();
    const hit = store.get(key);
    /* The version this answer describes, on every response — cached, stale or
       live. Two requests from one page can straddle a refresh: the headline
       comes from version N and the chart beside it from N+1, and their totals
       then differ by whatever landed in between. That is small and it is real,
       and a reader comparing two numbers deserves to be able to tell. It is
       also what turns a reconciliation check from flaky into precise: compare
       like with like, or fetch again. */
    res.set('x-data-version', v);

    if (hit && hit.version === v) {
      stats.hit++;
      res.set('x-cache', 'hit');
      res.set('content-type', hit.type);
      return res.send(hit.body);
    }

    /* Stale while revalidating.
       The version moves whenever a collection run or any of the three rollups
       finishes, which on this deployment is several times a quarter hour —
       faster than a warm pass can refill sixty entries. Measured in production:
       every request was a miss, because every entry was invalidated before
       anybody read it, and the cache did nothing at all for a first load.

       So a reader with a stale answer in hand gets it immediately and the
       refresh happens behind them. The data is at most one collection cycle
       old, on windows of seven to ninety days, and the response says so rather
       than implying it is current. Only a reader with no entry at all waits.

       Refreshed once per key: `refreshing` is what stops a burst of readers
       each starting their own copy of the same aggregate. */
    if (hit && !warm) {
      stats.stale++;
      res.set('x-cache', 'stale');
      res.set('x-cache-age', String(Math.round((Date.now() - hit.at) / 1000)));
      res.set('content-type', hit.type);
      res.send(hit.body);
      if (!refreshing.has(key)) {
        refreshing.add(key);
        const url = `http://127.0.0.1:${selfPort()}${key}`;
        fetch(url, { headers: { 'x-warm': '1' } })
          .then((r) => r.arrayBuffer())
          .catch(() => {})
          .finally(() => refreshing.delete(key));
      }
      return undefined;
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
          /* Oldest first — a Map iterates in insertion order — and evicting
             until the new entry fits rather than one per write, or a single
             large response never makes room for itself. */
          /* Subtract before deleting. Replacing a key — which is what every
             refresh does — dropped the entry without crediting its bytes back,
             so the counter only ever rose and the cache would eventually evict
             everything while holding almost nothing. */
          const replacing = store.get(key);
          if (replacing) { bytes -= replacing.body.length; store.delete(key); }
          while (bytes + text.length > maxBytes && store.size) {
            const oldest = store.keys().next().value;
            bytes -= store.get(oldest).body.length;
            store.delete(oldest);
          }
          store.set(key, { version: v, at: Date.now(), body: text, type: 'application/json; charset=utf-8' });
          bytes += text.length;
        } catch { /* a body that will not serialise is one we cannot cache */ }
      }
      return origJson(body);
    };
    return next();
  };

  // For /api/cache-stats and for the tests, which need to see inside.
  middleware.stats = () => ({ ...stats, entries: store.size, bytes,
    bytes_cap: maxBytes, version });
  middleware.setPort = (p) => { boundPort = p; };
  middleware.clear = () => { store.clear(); bytes = 0; checkedAt = 0; };
  /* The counter recomputed from what is actually held. A running total that
     drifts from the store is the failure this cache already had once, and it is
     silent: the cache slowly evicts everything while reporting a size it does
     not have. */
  middleware.audit = () => {
    let real = 0;
    for (const v of store.values()) real += v.body.length;
    return { counted: bytes, actual: real, entries: store.size };
  };
  return middleware;
}
