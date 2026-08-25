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
  '/api/kpis', '/api/trips/daily', '/api/mix?by=product',
  '/api/drivers/leaderboard', '/api/drivers/directory', '/api/drivers/cross-platform',
  '/api/roster',
  '/api/vehicles', '/api/vehicles/directory',
  /* The landing page. Both were absent, so every window of the FIRST screen
     anybody sees was always computed live — and they are the two heaviest
     queries here. Safe to warm only since they stopped reading the trip heap:
     at production shape a cold 365-day pair is now about two seconds of
     database work between them, where before it was seven and could not be
     cached at all — a statement cancelled at the two-minute pool timeout
     returns a 500, and api/cache.js stores only 200s. */
  '/api/economics/assets', '/api/economics/drivers',
  '/api/forecast', '/api/retention', '/api/capacity',
  '/api/playbook', '/api/revenue',
  '/api/alerts/by-driver', '/api/alerts/by-vehicle',
  /* Also in BARE_PATHS, and deliberately in both: Data sources asks for the
     whole record and Collection gaps asks about a window, so the endpoint has
     two live cache keys and warming either alone leaves a page cold. */
  '/api/coverage',
];

/* Warmed WITHOUT a window, because that is how the pages ask for them.
   ─────────────────────────────────────────────────────────────────────────
   The cache keys on the full URL, so `/api/coverage?from=…&to=…` and
   `/api/coverage` are two entries. These five endpoints answer a question that
   has no window — how much data do we hold, what does the whole record look
   like — and the UI calls them bare. They sat in the windowed list, so every
   pass warmed four keys nobody would ever request and left the one key every
   reader hits permanently cold.

   That is the shape of the 504 on the Data sources page: /api/coverage is a
   twenty-second query, it had never once been warm, and a reader opening that
   page during a backfill waited on the live query until the platform's gateway
   gave up. Warm what is asked for, not what is convenient to loop over. */
const BARE_PATHS = [
  '/api/platforms', '/api/trend/monthly', '/api/insights',
  '/api/compliance/drivers', '/api/coverage',
];

// The windows the UI opens with. 30 is the default; 7 and 90 are one click away.
/* The windows the UI opens with, and the two it does not.
   30 is the default and 7 and 90 are one click away. 365 was left out and it is
   the one that hurts most: a year crosses every collection gap this fleet has,
   so its queries are the heaviest, and nobody had warmed them — the first
   person to switch a page to a year paid the full aggregate every time.
   All-time is deliberately still absent: it is reachable only by hand-editing a
   URL, and warming it would double this pass to serve a window nobody opens. */
const WINDOWS = [30, 7, 90, 365];

export function startWarmer({ port, pool, everyMs = 60000, enabled = true }) {
  if (!enabled) { log.info(SRC, 'disabled'); return { stop() {} }; }
  let lastVersion = null;
  let running = false;
  let stopped = false;

  /* The window the BROWSER computes, which is the only one worth warming.
     ─────────────────────────────────────────────────────────────────────
     This was `days - 1`, matching daysWindow() in api/window.js — and the
     front end does not use daysWindow(). api/public/data.js:117 sends
     `now - days * 864e5`, so for every windowed path in the list below the
     warmer has been filling a key one day narrower than the one a browser
     asks for: /api/kpis?from=2026-07-27 warmed, /api/kpis?from=2026-07-26
     requested. Seventeen paths times four windows of work per pass, and not
     one of those entries was ever read by a page.

     It is invisible from either side. The warmer logs a successful pass, the
     cache fills up, and the pages are simply never warm — which is exactly
     the failure this file's header describes and the reason the windows are
     computed here rather than assumed. Matched to the client, because the
     client is who has to be served; changing data.js instead would shift the
     window every page in the product reports on. */
  const windowQs = (days) => {
    const to = dubaiDay(new Date());
    /* (days - 1), because a window is INCLUSIVE of both ends: seven days is
       six days back plus today, which is what api/window.js:47 has always
       documented and what api/public/data.js windowDates() now sends.

       This line has been wrong in both directions within one afternoon. It
       was `days - 1` while the front end sent `days`, so every warmed key was
       one day narrow and every warm hit was a miss; the economics fix moved it
       to `days` to match. The browser audit then fixed the front end — the
       real bug, since it made every per-day rate in the product divide by N+1
       — and this became one day wide instead. test/warm.test.mjs reads BOTH
       files and fails when they disagree, which is the only reason this was
       caught on the merge rather than in production. */
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
      const hit = async (url) => {
        try {
          const r = await fetch(url, { headers: { 'x-warm': '1' } });
          r.ok ? ok++ : failed++;
          await r.arrayBuffer();      // drain, or the socket stays open
        } catch { failed++; }
        /* A breath between requests. Without it this is a burst of sixty
           aggregates against a database somebody may be reading a page
           from, which trades one slow first load for a slow minute. */
        await new Promise((res) => setTimeout(res, 150));
      };
      /* The windowless ones first: they are the whole-history aggregates, the
         slowest queries here, and the ones a cold reader waits longest on. */
      for (const path of BARE_PATHS) {
        if (stopped) return;
        await hit(`http://127.0.0.1:${port}${path}`);
      }
      for (const days of WINDOWS) {
        for (const path of PATHS) {
          if (stopped) return;
          const sep = path.includes('?') ? '&' : '?';
          await hit(`http://127.0.0.1:${port}${path}${sep}${windowQs(days)}`);
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
