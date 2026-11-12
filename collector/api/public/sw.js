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
/* -data-2 since sign-in: everything stored before it was read anonymously,
   and a cache from before partitions existed is not one to keep. */
const DATA = `${VERSION}-data-2`;

/* WHICH DEPLOY THIS WORKER IS. The server writes VERSION as 'fleet-' + the
   shell's fingerprint, and stamps every piece of code it serves with the same
   fingerprint in X-FM-Build (api/server.js shellHash). So the worker knows,
   for any response, whether it belongs to its own deploy. Null when the
   literal above was never substituted (a local tool, the mock): nothing is
   then second-guessed. */
const BUILD = /^fleet-[0-9a-f]{12}$/.test(VERSION) ? VERSION.slice('fleet-'.length) : null;
const sameBuild = (res) => {
  const b = res.headers.get('x-fm-build');
  return !BUILD || !b || b === BUILD;
};

/* THE DATA CACHE IS BOUNDED, AND THE OLDEST GOES FIRST.
   ─────────────────────────────────────────────────────────────────────────
   It kept every /api answer it was ever given, with no limit, until the next
   deploy renamed it (the front-end audit, 2026-11-12) — and since the
   window, the chips and the page are all in the address, every page a reader
   opens under every window is a new entry: a day of reading is hundreds of
   them, kept on the reader's disk to serve an offline open that only ever
   needs the last few pages. Registering the worker on the desktop build as
   well (swreg.js) made that a growth with no floor.

   So the data cache holds at most `entries` answers and `bytes` of them, and
   when a new answer would take it over either bound, the answers stored
   longest ago are dropped until it fits — re-storing an address makes it the
   newest again. One answer over `entry` is not kept at all: a single export
   is not worth a page's worth of answers. The largest page answer measured
   on production, /api/unauthorized/attributed at 1.86 MB decoded
   (2026-11-12, the audit's timings), fits with room. A ledger of when each
   address was stored and how big it was lives IN the cache, beside the scope
   marker below, so it is emptied with the cache — by startScope(), by a
   sign-out (signin.js, access.js) — and survives the worker being stopped
   when idle; anything the ledger does not know is read from the stamp the
   answer carries and counted as stored then. */
const DATA_CAP = Object.freeze({ entries: 150, bytes: 24 * 1024 * 1024, entry: 4 * 1024 * 1024 });
const LEDGER_KEY = '/__fm-data-ledger';

/* The smallest set that can paint a usable first screen offline. The phone
   modules are listed by hand rather than globbed: a worker that precaches a
   directory listing it cannot see is a worker that silently precaches nothing. */
const SHELL_FILES = [
  '/', '/index.html',
  '/app.css', '/m/m.css',
  /* The Arkiv skin. index.html writes its <link> only for a reader who chose
     it (?skin=arkiv), but a reader who did must get it on a cold offline open
     too — or the page paints half in one skin: app.css's tokens under the
     skin attribute, with none of the component rules that go with them. */
  '/arkiv.css',
  /* …and the phone's half of it, the redesigned PWA (docs/UI-REDESIGN-PLAN.md
     "Phone PWA — redesign"). It carries --pg-phone:1 as well as the rules:
     missing on a cold offline open, the phone would draw its old screens
     under the Arkiv tokens — usable, but not what the reader chose. */
  '/m/arkiv-m.css',
  '/m/app.js', '/m/ui.js', '/m/screens.js',
  /* Every module the phone's three files reach, followed by hand rather than
     assumed: m/app.js imports ../daterange.js, and daterange.js imports
     ./tz.js, and data.js imports ./swr.js. None of the three were listed, so a
     cold open with no signal painted a shell whose scripts 404ed — they were
     only ever in the cache because a previous online visit had put them there
     one request at a time. */
  '/data.js', '/ui.js', '/charts.js', '/daterange.js', '/tz.js', '/swr.js',
  /* ui.js imports ./pagemeta.js for the page contract's token (2026-11-12:
     the sign-in page asks it too, and that page loads no ui.js). */
  '/pagemeta.js',
  /* ui.js imports ./tokens.js (the colour contract, since the reskin's STEP 0),
     and m/screens.js imports ../deposit_core.js, ../today.js and
     ../onlinetime.js — three modules that were NEVER on this list, found by
     walking the import graph on 2026-09-23 while adding the first. Any one
     missing fails screens.js's import on a cold offline open, and with it
     every screen: the exact failure the comment above records. The list is
     still written by hand, so test/tokens.test.mjs now walks the phone's
     static imports from /m/app.js and fails on any module it does not name. */
  '/tokens.js', '/deposit_core.js', '/today.js', '/onlinetime.js',
  /* m/screens.js imports ../target.js for the revenue target (2026-10-02). */
  '/target.js',
  /* app.js imports it: the first page, the target hour by hour (2026-10-02). */
  '/targetpage.js',
  /* …and the Month target page beside it (2026-10-08), imported the same way. */
  '/targetmonth.js',
  /* …and Low performers (2026-10-19): app.js imports it for the page, and
     m/screens.js for the phone's Below target and watch-list screens. */
  '/lowperf.js',
  /* Sign-in and access: data.js imports ./access.js, which imports
     ./access_model.js — both on the phone's path to its first screen — and
     every page links /access.css. */
  '/access.js', '/access_model.js', '/access.css',
  /* The phone redesign's control bar names the window and the controls a
     screen ignores in the desktop shell's own words, so m/app.js imports
     ../shell.js — a module the phone never reached before. */
  '/shell.js',
  /* The chat assistant's window: m/app.js and app.js import it, and it links
     its own stylesheet (2026-10-09). */
  '/agentchat.js', '/agentchat.css',
  /* The FleetMirror mark, both theme variants: the wordmark of every shell
     paints one of them, and offline it must not be a blank box. */
  '/brand/mark.png', '/brand/mark-dark.png',
  '/icons/fleetmirror-192.png', '/icons/fleetmirror-apple-touch.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  /* addAll rejects the whole install if ONE file 404s, which would leave the
     app with no worker at all and no message saying why. Each file is fetched
     on its own so a renamed module costs that file and not the install. */
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(SHELL_FILES.map(async (f) => {
      /* Fetched and checked rather than c.add(): a file from ANOTHER deploy —
         the server redeployed between this worker's own fetch and these —
         must not enter this deploy's shell (sameBuild above). */
      try {
        const res = await fetch(new Request(f, { cache: 'reload' }));
        if (res.ok && sameBuild(res)) await c.put(f, res);
      } catch { /* one missing file must not sink the install */ }
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
  /* …and how big it is, so the bound below can be kept without reading a
     single body back. */
  h.set('x-sw-bytes', String(body.size));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: h });
};

/* Keeping an answer, one at a time: the ledger is read, changed and written
   back by each, and two writers interleaved would each drop the other's
   line. A failed keep never stops the next. */
let keeping = Promise.resolve();
function keepData(request, res) {
  const job = keeping.then(() => keepOne(request, res));
  keeping = job.catch(() => {});
  return job;
}
/* The two lines the cache keeps about itself are not answers. A function, not
   a Set built here: SCOPE_KEY is declared further down. */
const isMeta = (u) => { const p = new URL(u).pathname; return p === SCOPE_KEY || p === LEDGER_KEY; };
async function keepOne(request, res) {
  const c = await caches.open(DATA);
  const stamped = await stamp(res);
  const bytes = Number(stamped.headers.get('x-sw-bytes')) || 0;
  if (bytes > DATA_CAP.entry) return;
  await c.put(request, stamped);
  let ledger = {};
  try { const l = await c.match(LEDGER_KEY); if (l) ledger = await l.json(); } catch { ledger = {}; }
  ledger[request.url] = [Date.now(), bytes];
  /* The ledger against what the cache really holds: a line for an answer
     that is gone is dropped, and an answer with no line (a keep that was cut
     off between its two writes) is read from its own stamp. */
  const held = (await c.keys()).map((r) => r.url).filter((u) => !isMeta(u));
  const live = new Set(held);
  for (const u of Object.keys(ledger)) if (!live.has(u)) delete ledger[u];
  for (const u of held) {
    if (ledger[u]) continue;
    const r = await c.match(u, { ignoreVary: true });
    ledger[u] = [Date.parse(r?.headers.get('x-sw-cached-at') || '') || 0, Number(r?.headers.get('x-sw-bytes')) || 0];
  }
  const oldestFirst = Object.entries(ledger).sort((a, b) => a[1][0] - b[1][0]);
  let n = oldestFirst.length;
  let total = oldestFirst.reduce((s, [, v]) => s + v[1], 0);
  for (const [u, [, b]] of oldestFirst) {
    if (n <= DATA_CAP.entries && total <= DATA_CAP.bytes) break;
    await c.delete(u, { ignoreVary: true });
    delete ledger[u];
    n -= 1; total -= b;
  }
  await c.put(LEDGER_KEY, new Response(JSON.stringify(ledger), { headers: { 'content-type': 'application/json' } }));
}

/* WHERE AN ANSWER CAME FROM, told to the page that asked (swreg.js). The
   phone reads the stamp off /api/status; the desktop build, which reads no
   stamp, is told each time the worker answers from its copy ('hit', with
   when that copy was stored) or has none to give ('miss'), so it can say on
   screen that what it shows is not live. */
async function tell(clientId, msg) {
  try {
    const c = clientId ? await self.clients.get(clientId) : null;
    if (c) c.postMessage({ type: 'fm-sw', ...msg });
  } catch { /* the page has gone */ }
}

/* The scope the data cache belongs to, kept IN the cache (a worker is
   stopped whenever it is idle, and a scope held only in memory would be
   forgotten — and the cache emptied — on every restart). */
const SCOPE_KEY = '/__fm-data-scope';
let lastScope;
async function currentScope() {
  if (lastScope !== undefined) return lastScope;
  const m = await (await caches.open(DATA)).match(SCOPE_KEY);
  lastScope = m ? await m.text() : null;
  return lastScope;
}
async function startScope(scope) {
  await caches.delete(DATA);
  await (await caches.open(DATA)).put(SCOPE_KEY, new Response(scope));
  lastScope = scope;
}

self.addEventListener('fetch', (e) => {
  const { request } = e;
  /* A HEAD for a piece of the shell is answered with the headers of the copy
     this worker would serve for it.
     ─────────────────────────────────────────────────────────────────────
     The desktop asks which deploy a module is from with a HEAD (app.js
     deployOf: X-FM-Build on its own app.js at boot and on each page module as
     it loads), and refuses to run a page module from one deploy on top of the
     app.js and ui.js of another — the 2026-09-06 failure server.js records.
     A worker that let HEAD through to the network while serving GETs from its
     cache would make that check compare the SERVER's build with the server's
     build: a tab running last week's app.js from this cache would be told it
     was current, and the next page's module, fetched fresh, would run on top
     of it unnoticed. Answered from the same copy the GET gets, the check
     compares what this tab actually runs. Not in the cache → the network, as
     before. Never for /api/. */
  if (request.method === 'HEAD') {
    const u = new URL(request.url);
    if (u.origin === self.location.origin && !u.pathname.startsWith('/api/')) {
      e.respondWith((async () => {
        const hit = await caches.match(u.href, { cacheName: SHELL });
        return hit ? new Response(null, { status: hit.status, statusText: hit.statusText, headers: hit.headers })
          : fetch(request);
      })());
    }
    return;
  }
  if (request.method !== 'GET') return;                 // never replay a write
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;      // tiles and the like

  if (url.pathname.startsWith('/api/')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        /* WHOSE answer this is (ULM-DESIGN §9.2). The server stamps every
           answer to a signed-in reader with x-fm-scope, a fingerprint of who
           may see what. The first answer under a different scope — another
           person, the same person with different access, or signed out —
           empties this cache before anything is kept, so an offline open can
           never paint one person's figures for another. A 401 empties it too. */
        const scope = fresh.status === 401 ? 'signed-out' : (fresh.headers.get('x-fm-scope') || 'anonymous');
        if (scope !== await currentScope()) await startScope(scope);
        /* Only a good answer is worth keeping, and never one the server marked
           no-store (contact details, documents, cash, HR, passengers, the
           audit log) nor anything about sign-in and access itself. A 500
           cached here would be served for a week after the fault was fixed. */
        const noStore = /no-store/i.test(fresh.headers.get('cache-control') || '')
          || url.pathname.startsWith('/api/auth') || url.pathname.startsWith('/api/access');
        /* Kept within the bound (keepData), after the answer has gone to the
           page: waitUntil holds the worker open for the write. */
        if (fresh.ok && !noStore) e.waitUntil(keepData(request, fresh.clone()).catch(() => {}));
        return fresh;
      } catch {
        /* The cache only ever holds ONE scope's answers (startScope empties it
           on every change), so what is here belongs to the last reader seen. */
        const hit = await caches.match(request, { cacheName: DATA });
        if (hit) {
          const h = new Headers(hit.headers);
          h.set('x-sw-cache', 'hit');
          e.waitUntil(tell(e.clientId, { cache: 'hit', at: hit.headers.get('x-sw-cached-at'), path: url.pathname }));
          return new Response(await hit.blob(), { status: 200, headers: h });
        }
        e.waitUntil(tell(e.clientId, { cache: 'miss', path: url.pathname }));
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
      /* Only this deploy's code enters this deploy's shell (sameBuild): a
         module fetched after the server moved on is served, never kept — or
         the cache would hand next week's page module to this week's app.js on
         every later open, and the HEAD above would vouch for it. */
      if (fresh.ok && url.pathname !== '/' && sameBuild(fresh)) {
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
