/* THE SERVICE WORKER ON THE DESKTOP BUILD.
   ═══════════════════════════════════════════════════════════════════════════
   api/public/sw.js was written for the phone and only the phone registered
   it (m/app.js, "the worker"). The desktop build — the same origin, the same
   shell — went to the network for every module, stylesheet and font on every
   cold open, and had nothing to show at all when the server did not answer
   (HANDOFF §4.5, "a desktop service worker"). This registers the same worker
   with the same policy, and adds the two things the desktop needs that the
   phone already had another way:

   1. THE SAME POLICY. Registered after the page has loaded — a cold open
      spends its first second on the page the reader asked for, not on
      priming a cache — at scope '/'. When a NEW worker takes over a page an
      older worker was serving (a deploy reached this browser: the shell in
      the cache is new and the modules running in this tab are not), the page
      reloads once, guarded, exactly as the phone does.

      One refinement, and why: the phone also reloads when the FIRST worker
      ever claims a page (clients.claim() fires controllerchange on a page no
      worker was serving). Nothing is stale then — every module that page is
      running came from the network a moment ago — and on a desktop a reload
      a few seconds after opening the page throws away whatever the reader
      had started (a search typed, a form half filled on #access). So the
      reload is kept for a takeover, which is the case its reason names, and
      skipped for the first claim. m/app.js keeps its own copy of the policy;
      test/sw_desktop.test.mjs holds the two to the same worker, scope and
      takeover reload.

   2. STALE FIGURES SAY THEY ARE STALE. The worker answers /api/… from the
      network and falls back to the last good copy when the network fails,
      stamped x-sw-cache: hit. The phone shell reads that stamp off
      /api/status and prints "Offline — showing what was last collected at …"
      (m/app.js freshness()). The desktop read nothing: registered as it
      stood, the worker would have painted last week's figures as today's on
      a dropped connection — the one thing this product exists not to do. So
      the worker now TELLS the page each time it answers from its copy
      (sw.js "fm-sw" messages), and this module puts one line above the page,
      in Dubai time: what is on screen is a kept copy, how old the oldest of
      it is, and that it is not live. The line belongs to the page it was
      written for: when the page is redrawn (#view is replaced on every
      navigation and refresh) it goes, and comes back only if the new page's
      answers came from the copy too.

   Nothing here runs where there is no service worker (http, a private window
   that refuses one, the test harnesses that block them). */
import { el, esc, dtStr } from './ui.js';

const NOTICE_ID = 'swStale';

/* The line, kept for the #view it describes. */
let shownFor = null;
let oldest = null;
let missed = false;
function paint() {
  const view = document.getElementById('view');
  if (!view) return;
  let box = document.getElementById(NOTICE_ID);
  if (!box) {
    box = el('div', 'note warn sw-stale');
    box.id = NOTICE_ID;
    box.setAttribute('role', 'status');
    view.parentElement.insertBefore(box, view);
    watchRedraws(view.parentElement);
  }
  box.innerHTML = oldest
    ? `<b>Offline.</b> The figures on this page are copies this browser kept, the oldest from ${esc(dtStr(oldest))} (Dubai time) — not live answers. They are replaced as soon as the server answers again.`
    : `<b>Offline.</b> The server is not answering, and ${missed ? 'some of this page has no kept copy to show' : 'nothing here is live'}. What is on screen is what this browser kept from an earlier visit.`;
}
function clear() {
  document.getElementById(NOTICE_ID)?.remove();
  shownFor = null; oldest = null; missed = false;
}

/* A message from sw.js: { type: 'fm-sw', cache: 'hit', at, path } when it
   answered from its copy, { cache: 'miss' } when it had none to give. */
export function onWorkerMessage(ev) {
  const m = ev?.data;
  if (!m || m.type !== 'fm-sw' || (m.cache !== 'hit' && m.cache !== 'miss')) return;
  const view = document.getElementById('view');
  if (!view) return;
  if (shownFor !== view) { clear(); shownFor = view; }
  if (m.cache === 'miss') missed = true;
  const at = m.at && !Number.isNaN(Date.parse(m.at)) ? m.at : null;
  if (at && (!oldest || Date.parse(at) < Date.parse(oldest))) oldest = at;
  paint();
}

/* The page was redrawn: #view is a new node (app.js freshView replaces it in
   place), so the line no longer describes what is on screen. Watched from
   where #view is WHEN THE LINE IS SHOWN, not from where it was at
   registration: the Arkiv shell (shell.js) builds its structure on the first
   render, which can land after the worker is registered. */
let watcher = null;
function watchRedraws(host) {
  if (!host || typeof MutationObserver !== 'function') return;
  watcher?.disconnect();
  watcher = new MutationObserver(() => {
    if (shownFor && document.getElementById('view') !== shownFor) { clear(); watcher?.disconnect(); watcher = null; }
  });
  watcher.observe(host, { childList: true });
}

let registered = false;
export function registerWorker({ nav = typeof navigator !== 'undefined' ? navigator : null,
  win = typeof window !== 'undefined' ? window : null } = {}) {
  if (registered || !nav || !win || !('serviceWorker' in nav)) return false;
  registered = true;
  const sw = nav.serviceWorker;
  /* Has a worker served this page yet? Only a change from one worker to
     ANOTHER is a deploy arriving (see 1 above). Tracked, not read once at
     load: a page the first worker claims after it loaded can still be taken
     over by the next deploy's worker in the same visit — measured in
     test/sw_desktop.test.mjs, where a flag read once at load left that page
     on the old code for good. */
  let controlled = Boolean(sw.controller);
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (!controlled) { controlled = true; return; }      // the first claim: nothing is stale
    if (reloading) return;
    reloading = true;
    win.location.reload();
  });
  sw.addEventListener('message', onWorkerMessage);
  const go =() => { sw.register('/sw.js', { scope: '/' }).catch(() => { /* http, or blocked */ }); };
  if (win.document?.readyState === 'complete') go();
  else win.addEventListener('load', go, { once: true });
  return true;
}
