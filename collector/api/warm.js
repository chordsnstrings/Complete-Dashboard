/* Warming the cache, so the first reader is not the one who pays.
   ─────────────────────────────────────────────────────────────────────────
   The response cache made a repeated page load 0.3s. It did nothing for the
   FIRST load after a collection, which is still the full aggregate — 8.3s on
   the drivers directory — and somebody has to be the one who waits for it.
   That somebody is currently whoever opens the dashboard first each half hour,
   which is to say the person starting their shift.

   So the process asks itself, in the background, as soon as it notices the data
   has moved. By the time a person opens a page, the answers are already held.

   Deliberately over HTTP to itself rather than by calling the route functions:
   a request through the real middleware stack is the only thing guaranteed to
   populate the cache under exactly the key a browser will ask for. Calling the
   handlers directly would warm nothing, or warm the wrong key, and look like it
   worked either way.

   Sequential, with a pause between. The point is to spend idle time, not to
   replace one thundering herd with another — and the database this shares with
   the collector is small enough that eight parallel aggregates would be felt by
   anyone reading a page at that moment. */
import { log } from '../src/log.js';

const SRC = 'warm';

/* Dubai days, matching what the front end sends. A warmed entry keyed on a
   different window than the browser asks for is a warmed entry nobody reads. */
const dubaiDay = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

/* The paths a person actually lands on, in the order they will want them.
   Not every route: warming all 98 across three windows is 300 aggregates to
   save a handful of first loads, and most detail pages are keyed on an entity
   nobody has opened yet. These are the list views and the headline numbers —
   the ones every session begins with, and the slowest of them. */
const PATHS = [
  '/api/kpis', '/api/trips/daily', '/api/mix?by=product', '/api/platforms',
  '/api/drivers/leaderboard', '/api/drivers/directory', '/api/roster',
  '/api/vehicles', '/api/vehicles/directory',
  '/api/trend/monthly', '/api/forecast', '/api/retention', '/api/capacity',
  '/api/playbook', '/api/revenue', '/api/insights', '/api/compliance/drivers',
  '/api/alerts/by-driver', '/api/alerts/by-vehicle', '/api/coverage',
];

// The windows the UI opens with. 30 is the default; 7 and 90 are one click away.
const WINDOWS = [30, 7, 90];

export function startWarmer({ port, pool, everyMs = 60000, enabled = true }) {
  if (!enabled) { log.info(SRC, 'disabled'); return { stop() {} }; }
  let lastVersion = null;
  let running = false;
  let stopped = false;

  const windowQs = (days) => {
    const to = dubaiDay(new Date());
    const from = dubaiDay(new Date(Date.now() - (days - 1) * 864e5));
    return `from=${from}&to=${to}`;
  };

  async function version() {
    const { rows } = await pool.query(
      `SELECT (SELECT max(finished_at) FROM collection_run) AS c,
              (SELECT max(finished_at) FROM rollup_state)   AS r`);
    return `${rows[0]?.c || '-'}|${rows[0]?.r || '-'}`;
  }

  async function warm() {
    if (running || stopped) return;
    running = true;
    const t0 = Date.now();
    let ok = 0; let failed = 0;
    try {
      for (const days of WINDOWS) {
        for (const path of PATHS) {
          if (stopped) return;
          const sep = path.includes('?') ? '&' : '?';
          const url = `http://127.0.0.1:${port}${path}${sep}${windowQs(days)}`;
          try {
            const r = await fetch(url, { headers: { 'x-warm': '1' } });
            r.ok ? ok++ : failed++;
            await r.arrayBuffer();      // drain, or the socket stays open
          } catch { failed++; }
          /* A breath between requests. Without it this is a burst of sixty
             aggregates against a database somebody may be reading a page
             from, which trades one slow first load for a slow minute. */
          await new Promise((res) => setTimeout(res, 150));
        }
      }
      log.info(SRC, 'cache warmed', { ok, failed, ms: Date.now() - t0 });
    } finally { running = false; }
  }

  async function tick() {
    if (stopped) return;
    try {
      const v = await version();
      if (v !== lastVersion) {
        lastVersion = v;
        /* Not awaited: the tick must stay short, and a warm pass takes a
           minute. A second tick during it finds `running` true and returns. */
        warm();
      }
    } catch (e) {
      log.warn(SRC, 'version check failed', { err: String(e).slice(0, 120) });
    }
  }

  // A moment after boot, so it does not compete with the first real requests
  // while the process is still opening connections.
  const first = setTimeout(tick, 5000);
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  first.unref?.();
  return { stop() { stopped = true; clearInterval(timer); clearTimeout(first); }, warm };
}
