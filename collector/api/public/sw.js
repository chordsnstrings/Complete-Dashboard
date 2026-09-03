/* The service worker: what survives a tunnel, a lift, and a dead signal.
   ─────────────────────────────────────────────────────────────────────────
   This fleet is operated from a phone in a car park, and the honest failure
   mode for a dashboard with no network is not a browser error page — it is the
   last numbers it saw, clearly labelled as old. So there are two strategies,
   chosen by what the request is FOR:

     the shell   (HTML, CSS, JS, fonts, icons) — cache first. It changes only
                 on deploy, and a version bump below retires the old one. Cache
                 first is what makes a cold open on a bad connection instant.

     the data    (/api/…) — network first, falling back to the last good copy.
                 A stale figure presented AS stale is useful; a spinner that
                 never resolves is not. The fallback response carries
                 `x-sw-cache: hit` and the date it was stored, and the phone
                 shell reads both to show "showing data from …".

   Nothing else is cached. A POST is never served from a cache and never
   stored — /api/settings/* writes credentials and triggers collection runs,
   and replaying one of those from a cache would be a genuine fault rather than
   a stale number.

   The version string is the cache's identity. Bumping it is the deploy: the
   activate step deletes every cache that is not this one, so a shell can never
   be half old and half new. */
/* Substituted at serve time — see the /sw.js route in api/server.js.
   ─────────────────────────────────────────────────────────────────────────
   This was the literal 'fleet-v1' and it never once changed. The comment above
   says bumping it IS the deploy, and nothing bumped it: every phone that had
   opened the app was serving /m/app.js, /daterange.js and the rest from a
   cache filled on its first visit, cache-first, for ever. Reported from a real
   phone on 2026-09-03 — a window picker offering "7 days / 30 days / 90 days /
   12 months", which is the control this app stopped shipping in fb24dbc, on a
   deploy that had been serving the calendar picker for weeks. No amount of
   deploying could reach it.

   A human remembering to edit a string is not a mechanism. The server now
   substitutes a hash of every shell asset it serves, so any change to any of
   them retires the old cache on the next update check, and this literal is
   only what runs if somebody opens the file directly. */
const VERSION = 'fleet-dev';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;

/* The smallest set that can paint a usable first screen offline. The phone
   modules are listed by hand rather than globbed: a worker that precaches a
   directory listing it cannot see is a worker that silently precaches nothing. */
const SHELL_FILES = [
  '/', '/index.html',
  '/app.css', '/m/m.css',
  '/m/app.js', '/m/ui.js', '/m/screens.js',
  /* Every module the phone's three files reach, followed by hand rather than
     assumed: m/app.js imports ../daterange.js, and daterange.js imports
     ./tz.js, and data.js imports ./swr.js. None of the three were listed, so a
     cold open with no signal painted a shell whose scripts 404ed — they were
     only ever in the cache because a previous online visit had put them there
     one request at a time. */
  '/data.js', '/ui.js', '/charts.js', '/daterange.js', '/tz.js', '/swr.js',
  '/icons/icon-192.png', '/icons/apple-touch-icon.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  /* addAll rejects the whole install if ONE file 404s, which would leave the
     app with no worker at all and no message saying why. Each file is fetched
     on its own so a renamed module costs that file and not the install. */
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map(async (f) => {
      try { await c.add(new Request(f, { cache: 'reload' })); }
      catch { /* one missing file must not sink the install */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k !== SHELL && k !== DATA) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

/* A cached API response is stamped when it is stored, because the page has to
   be able to say HOW old the numbers are and Response.headers is the only
   thing that travels with it. */
const stamp = async (res) => {
  const body = await res.clone().blob();
  const h = new Headers(res.headers);
  h.set('x-sw-cached-at', new Date().toISOString());
  return new Response(body, { status: res.status, statusText: res.statusText, headers: h });
};

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;                 // never replay a write
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;      // tiles and the like

  if (url.pathname.startsWith('/api/')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        /* Only a good answer is worth keeping. A 500 cached here would be
           served for a week after the fault was fixed. */
        if (fresh.ok) {
          const c = await caches.open(DATA);
          c.put(request, await stamp(fresh.clone()));
        }
        return fresh;
      } catch {
        const hit = await caches.match(request);
        if (hit) {
          const h = new Headers(hit.headers);
          h.set('x-sw-cache', 'hit');
          return new Response(await hit.blob(), { status: 200, headers: h });
        }
        return new Response(JSON.stringify({ error: 'offline', offline: true }),
          { status: 503, headers: { 'content-type': 'application/json', 'x-sw-cache': 'miss' } });
      }
    })());
    return;
  }

  /* Everything else is the shell. Cache first, and a navigation that misses
     falls back to the shell document rather than to the browser's error page —
     the router reads the hash, so any address can be answered by index.html. */
  e.respondWith((async () => {
    const hit = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (hit) return hit;
    try {
      const fresh = await fetch(request);
      if (fresh.ok && url.pathname !== '/') {
        const c = await caches.open(SHELL);
        c.put(request, fresh.clone());
      }
      return fresh;
    } catch {
      if (request.mode === 'navigate') {
        return (await caches.match('/index.html')) || Response.error();
      }
      return Response.error();
    }
  })());
});

/* The page asks for this on a pull-to-refresh so a reader can force the shell
   forward without waiting for the browser's own update check. */
self.addEventListener('message', (e) => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});
