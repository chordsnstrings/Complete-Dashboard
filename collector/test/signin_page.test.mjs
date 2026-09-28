/* THE SIGN-IN PAGE — /signin, driven in Chromium against the real server.
   ═════════════════════════════════════════════════════════════════════════
   api/public/signin.html + signin.js are the only way into FleetMirror once
   sign-in is required, so this file drives them the way people will: the
   first Owner from the handover password through a password of their own,
   two-step set-up and the recovery codes; signing out and back in with a
   code, a recovery code, and a bad one; an invite, a reset and a wall-screen
   link opened from the address the Access page hands out; and the page
   saying why when it cannot know something.

   REAL SERVER, OWN DATABASE. `node api/server.js` is started against a fresh
   database on the local Postgres 16 (127.0.0.1:55432, created and dropped
   here), so every route, cookie, CSRF check, restriction and migration is
   production's own. If that Postgres is not reachable the page-driving half
   prints a SKIP line and exits 0; the pure helpers at the top still run.

   Synthetic people only: every address is @example.test, every name says
   "Test", and every password and two-step key exists only for this run.

   "/" IS STUBBED. Where sign-in sends a reader is the page's business; what
   the dashboard then draws is app.js's, and that file is being changed by
   other work. So the landing page is a stub unless SIGNIN_TEST_REAL_APP=1,
   when the real app loads and the test checks it does not bounce straight
   back to /signin (a redirect loop between the two is the failure that
   matters at the seam).

   Every layout check runs at 390px and 1280px, light and dark: no sideways
   scroll, the right paper for the theme, and at 390px every control at
   least 44px tall. SIGNIN_SHOTS=<dir> saves a screenshot of each.

   REVERSIONS THAT PROVE IT — each was made, run, and seen to fail the
   named check, 2026-09-28:
     · signin.html inline script: drop the history.replaceState — "the invite
       token left the address bar before signin.js had even loaded" fails.
     · signin.js safeBack: drop the check on the path it HANDS BACK — the four
       dot-segment cases ("/.//evil.example" and kin) come back as
       "//evil.example", another host. (Dropping the character test or the
       input's origin test alone fails nothing: the URL parser turns
       "/\evil.example" into a different origin whose PATH is "/", so the
       output is still "/". The output check is the one that matters.)
     · signin.js: drop guardLeaving(false) from leave() and from the "saved"
       action — "…without a 'leave this page?' on the way" fails.
     · signin.js stepLogin: drop `Boolean(who.now) &&` from `open` — "…and
       does not claim sign-in is optional" fails when /api/auth/me is 503.
     · signin.js forgetPreviousReader: make it delete nothing — "…and the
       service worker's copies of them too" fails. (The localStorage half is
       access.js partitionStorage's, and is checked, not owned, here.) */
import pg from 'pg';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hotp, totpStep, hashPassword } from '../api/access/crypto.js';
import { safeBack, readLink, normaliseCode, newPasswordProblem, keyGroups, WHY } from '../api/public/signin.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══ 1. the pure helpers — no server needed ═════════════════════════════ */
console.log('\n1. where the page may send you, and what it reads');
{
  const O = 'http://127.0.0.1:8411';
  const cases = [
    ['/', '/'], ['/#drivers', '/#drivers'], ['/?ui=phone#today', '/?ui=phone#today'],
    ['//evil.example', '/'], ['/\\evil.example', '/'], ['/\t/evil.example', '/'], ['/\n/evil.example', '/'],
    ['https://evil.example/', '/'], ['javascript:alert(1)', '/'], ['', '/'], [null, '/'], [undefined, '/'],
    ['/signin', '/'], ['/signin?back=/x', '/'], ['/signin.html', '/'], ['/api/kpis', '/'],
    ['/%2F%2Fevil.example', '/%2F%2Fevil.example'], ['drivers', '/'],
    /* Dot segments collapse into a "//" the input never had. */
    ['/.//evil.example', '/'], ['/..//evil.example', '/'], ['/%2e//evil.example', '/'], ['/x/..//evil.example', '/'],
    ['/./\\evil.example', '/'], ['/#//evil.example', '/#//evil.example'],
  ];
  for (const [raw, want] of cases) check(`safeBack(${JSON.stringify(raw)}) → ${want}`, safeBack(raw, O) === want, `got ${safeBack(raw, O)}`);
  const tok = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde';
  check('an invite link reads its token', readLink(`#invite=${tok}`)?.token === tok && readLink(`#invite=${tok}`).kind === 'invite');
  check('…a full stop a chat app stuck on the end is not part of it', readLink(`#reset=${tok}.`)?.token === tok);
  check('…a token too short to be one is reported, not sent', readLink('#device=abc')?.token === null);
  check('…anything else in the fragment is not a link', readLink('#drivers') === null && readLink('') === null);
  check('six digits with a space are a code', normaliseCode('123 456')?.code === '123456');
  check('a recovery code without its dash gets it back', normaliseCode('3F9A10C27E')?.code === '3f9a1-0c27e');
  check('five digits are neither', normaliseCode('12345') === null);
  check('the key is shown in groups of four', keyGroups('jbswy3dpehpk3pxp').join(' ') === 'JBSW Y3DP EHPK 3PXP');
  check('a short new password is refused with the server\'s own sentence', newPasswordProblem('short', 'short') === 'Use at least 12 characters.');
  check('two different new passwords are refused', /not the same/.test(newPasswordProblem('long enough words', 'long enough wordz') || ''));
  check('every ?why= the dashboard sends has a line', ['expired', 'signedout', 'required', 'setup'].every((k) => WHY[k]));
}

/* ══ 2. the real server ════════════════════════════════════════════════ */
const ADMIN_URL = process.env.SIGNIN_TEST_PG || 'postgres://fleet@127.0.0.1:55432/fleet';
const DB = 'fleet_signin_test';
const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
try {
  await admin.connect();
} catch (e) {
  console.log(`\nSKIP signin_page: local Postgres not reachable at ${ADMIN_URL.replace(/\/\/[^@]*@/, '//…@')} (${String(e.message || e).slice(0, 80)})`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const portFree = (p) => new Promise((res) => {
  const s = createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
  s.listen(p, '0.0.0.0');
});
const anyPort = () => new Promise((res) => { const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => res(port)); }); });
/* Never adopt a server that is already there: another agent's, on another
   database, would answer every request and prove nothing about this one. */
let PORT = Number(process.env.SIGNIN_TEST_PORT || 8411);
if (!(await portFree(PORT))) {
  const was = PORT;
  PORT = await anyPort();
  console.log(`  (port ${was} is taken by something else — using ${PORT})`);
}
const base = `http://127.0.0.1:${PORT}`;
const OWNER = 'owner@example.test';
const BOOT_PW = 'handover words for test only';
const OWNER_PW = 'quiet harbour lantern seven';

let server = null, browser = null, db = null;
async function cleanup() {
  try { await browser?.close(); } catch { /* gone */ }
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((r) => server.once('exit', r)), sleep(5000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  try { await db?.end(); } catch { /* gone */ }
  try { await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* best effort */ }
  try { await admin.end(); } catch { /* gone */ }
}
/* Whatever stops this run, the server and the database go with it: a
   Playwright call that throws outside the try below (inside a route
   handler, say) would otherwise leave a server holding the port and a
   database behind — measured once, 2026-09-28. And a run that hangs is
   ended, not left running. */
let ending = false;
const bail = (why, code = 1) => {
  if (ending) return;
  ending = true;
  console.log(`  ✗ the run stopped: ${String(why?.stack || why).slice(0, 800)}`);
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  cleanup().finally(() => process.exit(code));
};
process.on('SIGINT', () => bail('interrupted', 130));
process.on('unhandledRejection', (e) => bail(e));
process.on('uncaughtException', (e) => bail(e));
setTimeout(() => bail('took longer than eight minutes'), 8 * 60_000).unref();

try {
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB}`);
  const DB_URL = ADMIN_URL.replace(/\/[^/]*$/, `/${DB}`);

  /* A clean environment: only what the server needs, so nothing from this
     shell (a token, a proxy setting, a mode pin) changes what it does. */
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'UTC',
    DATABASE_URL: DB_URL, DATABASE_SSL: 'false', PORT: String(PORT), WARM: 'off',
    BOOTSTRAP_OWNER_EMAIL: OWNER, BOOTSTRAP_OWNER_PASSWORD_HASH: hashPassword(BOOT_PW),
  };
  let log = '';
  server = spawn(process.execPath, ['api/server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });

  db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  const t0 = Date.now();
  let ready = false;
  while (Date.now() - t0 < 120_000 && server.exitCode === null) {
    try {
      const r = await fetch(`${base}/api/auth/me`);
      if (r.ok) {
        const { rows } = await db.query(`SELECT count(*)::int AS n FROM access_grant WHERE role_code = 'OWN' AND status = 'active'`);
        if (rows[0].n === 1) { ready = true; break; }
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  if (!ready) throw new Error(`server did not come up with a bootstrapped Owner:\n${log.slice(-1500)}`);
  console.log(`\n2. the real server on :${PORT}, database ${DB}, ready in ${Math.round((Date.now() - t0) / 1000)}s`);

  const { launchChromium } = await import('./browser.mjs');
  browser = await launchChromium();

  const SHOTS = process.env.SIGNIN_SHOTS || '';
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  const REAL_APP = process.env.SIGNIN_TEST_REAL_APP === '1';

  /* Each browser: its own cookies, the landing page stubbed, and every
     console line recorded against the address it came from. A "Failed to
     load resource" line is the browser logging an HTTP refusal this test
     provoked (a wrong password is a 401); anything else on /signin — and
     any uncaught exception — is a defect. */
  const pages = [];
  async function newPage({ phone = false } = {}) {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    if (!REAL_APP) {
      await ctx.route((u) => u.pathname === '/', (route) => route.fulfill({
        status: 200, contentType: 'text/html', body: '<!doctype html><title>landed</title><p id="landed">landed</p>' }));
    }
    const page = await ctx.newPage();
    const rec = { page, ctx, errors: [], refusals: [], dialogs: [] };
    /* A handler here means Playwright no longer answers dialogs itself; each
       is recorded and accepted, so a "leave this page?" that should not have
       been asked is counted rather than silently cancelling a navigation. */
    page.on('dialog', (d) => { rec.dialogs.push(d.type()); d.accept().catch(() => {}); });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const where = page.url();
      if (/^Failed to load resource/.test(m.text())) rec.refusals.push(m.text());
      else if (new URL(where).pathname.startsWith('/signin')) rec.errors.push(`${m.text()} @ ${where}`);
    });
    page.on('pageerror', (e) => rec.errors.push(`pageerror ${String(e).slice(0, 200)} @ ${page.url()}`));
    pages.push(rec);
    return rec;
  }
  const h1 = (page) => page.locator('#signin h1').innerText();
  const errText = (page) => page.locator('#signin .si-err:not([hidden])').innerText({ timeout: 5000 }).catch(() => '');
  const noteText = (page) => page.locator('#signin .si-note').first().innerText({ timeout: 3000 }).catch(() => '');
  const waitH1 = (page, text) => page.waitForFunction((t) => document.querySelector('#signin h1')?.textContent.includes(t), text, { timeout: 15000 });
  const landed = async (page) => {
    await page.waitForURL((u) => !u.pathname.startsWith('/signin'), { timeout: 15000 });
    if (!REAL_APP) await page.waitForSelector('#landed');
    const at = new URL(page.url());
    /* With the real app: it must STAY there — app.js sends a signed-out or
       restricted reader to /signin, and a disagreement between the two
       about who is signed in is a loop the reader cannot get out of. */
    if (REAL_APP) {
      await sleep(3000);
      const now = new URL(page.url());
      check(`the real app kept the reader on ${at.pathname}${at.hash} (no bounce back to /signin)`, !now.pathname.startsWith('/signin'), now.href);
    }
    return at;
  };
  const csrfOf = async (ctx) => (await ctx.cookies(base)).find((c) => c.name === 'fm_csrf')?.value || '';
  const api = async (ctx, path, data) => {
    const r = await ctx.request.post(`${base}${path}`, { data: data || {}, headers: { 'x-fm-csrf': await csrfOf(ctx) } });
    let j = null;
    try { j = await r.json(); } catch { /* not json */ }
    return { status: r.status(), body: j };
  };
  const me = async (ctx) => (await ctx.request.get(`${base}/api/auth/me`)).json();

  /* A code the server will take: current step or the next (it allows one
     step of drift), and strictly later than the last one this account used,
     which the server refuses as a replay. Waits for the clock when it must. */
  async function freshCode(secret, last) {
    for (;;) {
      const t = totpStep();
      for (const s of [t, t + 1]) if (last == null || s > last) return { code: hotp(secret, s), step: s };
      await sleep((t + 1) * 30_000 - Date.now() + 250);
    }
  }
  const wrongCode = (secret) => {
    const t = totpStep();
    const near = new Set([-2, -1, 0, 1, 2].map((d) => hotp(secret, t + d)));
    for (let n = 0; ; n++) { const c = String(n * 7919 % 1e6).padStart(6, '0'); if (!near.has(c)) return c; }
  };

  let shotN = 0;
  async function layout(rec, label) {
    const { page } = rec;
    const bad = [];
    for (const w of [390, 1280]) {
      for (const scheme of ['light', 'dark']) {
        await page.setViewportSize({ width: w, height: w === 390 ? 844 : 900 });
        await page.emulateMedia({ colorScheme: scheme });
        const m = await page.evaluate((narrow) => {
          const cs = getComputedStyle(document.body);
          const small = narrow ? [...document.querySelectorAll('.si button, .si input, .si a.si-btn')]
            .filter((e) => e.offsetParent !== null)
            .map((e) => ({ e, h: e.getBoundingClientRect().height }))
            .filter((x) => x.h < 43.5)
            .map((x) => `${x.e.tagName.toLowerCase()}${x.e.id ? `#${x.e.id}` : ''}.${x.e.className}=${Math.round(x.h)}`) : [];
          const marks = [...document.querySelectorAll('.si-mark')].filter((i) => getComputedStyle(i).display !== 'none');
          return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, bg: cs.backgroundColor, small,
            marks: marks.map((i) => ({ src: new URL(i.src).pathname, ok: i.complete && i.naturalWidth > 0 })) };
        }, w === 390);
        if (m.sw > m.iw) bad.push(`${w}/${scheme}: scrolls sideways (${m.sw} > ${m.iw})`);
        const wantBg = scheme === 'dark' ? 'rgb(17, 17, 19)' : 'rgb(255, 255, 255)';
        if (m.bg !== wantBg) bad.push(`${w}/${scheme}: paper is ${m.bg}, not ${wantBg}`);
        const wantMark = scheme === 'dark' ? '/brand/mark-dark.png' : '/brand/mark.png';
        if (m.marks.length !== 1 || m.marks[0].src !== wantMark || !m.marks[0].ok) {
          bad.push(`${w}/${scheme}: the mark shown is ${JSON.stringify(m.marks)}, not a loaded ${wantMark}`);
        }
        if (m.small.length) bad.push(`${w}/${scheme}: under 44px: ${m.small.join(', ')}`);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `${String(++shotN).padStart(2, '0')}-${label.replace(/\W+/g, '-')}-${w}-${scheme}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    check(`${label}: no sideways scroll, right paper and mark, 44px controls — 390/1280 × light/dark`, !bad.length, bad.join(' | '));
  }

  /* ── 3. the first Owner ─────────────────────────────────────────────── */
  console.log('\n3. the first Owner: handover password → own password → two-step → recovery codes');
  const A = await newPage();
  let ownerSecret = null, ownerLast = null, ownerRecovery = [];
  {
    const { page } = A;
    await page.goto(`${base}/signin`);
    await waitH1(page, 'Sign in to FleetMirror');
    check('the sign-in step is drawn', (await h1(page)).includes('Sign in to FleetMirror'));
    const open = page.locator('.si-open a');
    check('while sign-in is optional, it says so and links to "/"',
      (await page.locator('.si-open').innerText()).includes('Signing in is optional for now') && (await open.getAttribute('href')) === '/');
    await layout(A, 'sign in');

    await page.fill('#si-email', OWNER);
    await page.fill('#si-password', 'not the handover password');
    await page.click('#si-login button[type=submit]');
    check('a wrong password shows the server\'s sentence beside the form',
      (await errText(page)).includes('That email and password do not match an account.'), await errText(page));

    await page.fill('#si-password', BOOT_PW);
    await page.click('#si-login button[type=submit]');
    await waitH1(page, 'Choose your own password');
    check('the handover password leads straight to choosing one\'s own', true);
    check('…the account is named, read-only', (await page.inputValue('#si-account')) === OWNER && await page.locator('#si-account').evaluate((e) => e.readOnly));
    check('…the password rule is stated beside the field', (await page.locator('#si-new-hint').innerText()).includes('At least 12 characters'));
    await layout(A, 'first password');

    await page.fill('#si-current', BOOT_PW);
    await page.fill('#si-new', OWNER_PW);
    await page.fill('#si-confirm', `${OWNER_PW}x`);
    await page.click('#si-pwform button[type=submit]');
    check('two different new passwords are refused before the server is asked', (await errText(page)).includes('not the same'));
    await page.fill('#si-new', 'the owner of it all');
    await page.fill('#si-confirm', 'the owner of it all');
    await page.click('#si-pwform button[type=submit]');
    check('a password the server refuses shows the server\'s own reason',
      (await errText(page)).includes('Do not include your email name in the password.'), await errText(page));
    await page.fill('#si-new', OWNER_PW);
    await page.fill('#si-confirm', OWNER_PW);
    await page.click('#si-pwform button[type=submit]');
    await waitH1(page, 'Set up two-step sign-in');
    check('the Owner is taken on to two-step set-up (policy: admins)', true);
    check('…the saved password is acknowledged', (await noteText(page)).includes('Your new password is saved.'));

    await page.waitForSelector('#si-secret');
    ownerSecret = (await page.locator('#si-secret').innerText()).replace(/\s+/g, '');
    const href = await page.locator('#si-otpauth').getAttribute('href');
    check('the key is shown in eight groups of four', (await page.locator('#si-secret span').allInnerTexts()).join('') === ownerSecret && (await page.locator('#si-secret span').allInnerTexts()).every((g) => /^[A-Z2-7]{4}$/.test(g)) && ownerSecret.length === 32);
    check('a QR code is drawn on the page, as SVG', await page.locator('#si-qr svg path').count() === 1);
    check('the otpauth link carries the same key and the account',
      href?.startsWith('otpauth://totp/FleetMirror:') && href.includes(`secret=${ownerSecret}`) && href.includes(encodeURIComponent(OWNER)));
    check('on a laptop the QR comes before the app link', await page.evaluate(() => {
      const q = document.getElementById('si-qr'); const a = document.getElementById('si-otpauth');
      return Boolean(q && a && (q.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING));
    }));
    await page.click('[data-act=copykey]');
    await page.waitForFunction(() => document.querySelector('.si-status')?.textContent.includes('copied'));
    check('Copy key puts the key on the clipboard', (await page.evaluate(() => navigator.clipboard.readText())) === ownerSecret);
    await layout(A, 'two-step set-up');

    await page.fill('#si-totp', wrongCode(ownerSecret));
    await page.click('#si-totpform button[type=submit]');
    check('a wrong code is refused with the server\'s sentence', (await errText(page)).includes('That code is not right'), await errText(page));
    const c = await freshCode(ownerSecret, null);
    await page.fill('#si-totp', c.code);
    await page.click('#si-totpform button[type=submit]');
    ownerLast = c.step;
    await waitH1(page, 'Save your recovery codes');
    ownerRecovery = await page.locator('#si-codes li').allInnerTexts();
    check('ten recovery codes, each xxxxx-xxxxx', ownerRecovery.length === 10 && ownerRecovery.every((x) => /^[0-9a-f]{5}-[0-9a-f]{5}$/.test(x.trim())));
    check('…with a plain "save these now"', (await page.locator('.si-save').innerText()).includes('Save these now.'));
    await page.click('[data-act=copycodes]');
    await page.waitForFunction(() => document.querySelector('.si-status')?.textContent.includes('copied'));
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    check('Copy codes copies all ten', ownerRecovery.every((x) => clip.includes(x.trim())));
    await layout(A, 'recovery codes');
    check('leaving the codes unsaved asks first (beforeunload is held)', await page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }));
    await page.click('[data-act=saved]');
    const u = await landed(page);
    check('"I have saved them" lands on "/"', u.pathname === '/' && !u.hash, u.href);
    check('…without a "leave this page?" on the way', !A.dialogs.includes('beforeunload'), A.dialogs.join(','));
    const m = await me(A.ctx);
    check('…signed in, nothing still owed, two-step on', m.signedIn && m.restricted === null && m.user.totp === true, JSON.stringify(m).slice(0, 200));
  }

  /* ── 4. signed in already; out; back in with a code ─────────────────── */
  console.log('\n4. signed in already, signed out, back in with a code');
  {
    const { page } = A;
    await page.goto(`${base}/signin`);
    await waitH1(page, 'You are signed in');
    check('an unrestricted visitor sees who they are signed in as',
      (await page.locator('.si-who').innerText()).includes(`Signed in as ${OWNER}`));
    check('…with their role', (await page.locator('.si-roles').innerText()).toLowerCase().includes('owner'));
    check('…a Continue and a Sign out', await page.locator('[data-act=continue]').count() === 1 && await page.locator('[data-act=signout]').count() === 1);
    await layout(A, 'signed in');
  }
  {
    const { page, ctx } = A;
    const out = await api(ctx, '/api/auth/logout');
    check('POST /api/auth/logout signs the Owner out', out.status === 200 && (await me(ctx)).signedIn === false);
    await page.goto(`${base}/signin?why=signedout&back=%2F%2Fevil.example`);
    await waitH1(page, 'Sign in to FleetMirror');
    /* Put there AFTER the sign-out: the server's Clear-Site-Data has already
       emptied storage by now (Chromium applies it, even to this API call, on
       the next navigation — measured). What is left is the case this guards:
       a session that simply expired, with the last reader's answers still in
       the store when the next person signs in. */
    await page.evaluate(async () => {
      try { localStorage.setItem('fleet.swr.v1', '{"stale":"from the last reader"}'); } catch { /* */ }
      const c = await caches.open('fleet-test-data');
      await c.put('/api/kpis?days=1', new Response('{"stale":"from the last reader"}', { headers: { 'content-type': 'application/json' } }));
    });
    check('?why=signedout says so in one line', (await noteText(page)).includes(WHY.signedout));
    await page.fill('#si-email', OWNER);
    await page.fill('#si-password', OWNER_PW);
    await page.click('#si-login button[type=submit]');
    await waitH1(page, 'Enter your code');
    check('with two-step on, the password leads to the code step', true);
    check('…which says a recovery code works too', (await page.locator('#si-code-hint').innerText()).includes('xxxxx-xxxxx'));
    await layout(A, 'code');
    await page.fill('#si-code', wrongCode(ownerSecret));
    await page.click('#si-codeform button[type=submit]');
    check('a wrong code is refused with the server\'s sentence', (await errText(page)).includes('That code is not right'), await errText(page));
    const c = await freshCode(ownerSecret, ownerLast);
    await page.fill('#si-code', c.code);
    await page.click('#si-codeform button[type=submit]');
    ownerLast = c.step;
    const u = await landed(page);
    check('a hostile ?back= lands on this origin\'s "/"', u.origin === base && u.pathname === '/', u.href);
    /* The stale entry must be gone; with the real app loaded, the store may
       already hold the NEW reader's answers, which is right. */
    check('the last reader\'s answers kept by the page were forgotten on sign-in (access.js partitionStorage)',
      !String(await page.evaluate(() => localStorage.getItem('fleet.swr.v1'))).includes('from the last reader'));
    check('…and the service worker\'s copies of them too',
      !(await page.evaluate(() => caches.keys())).includes('fleet-test-data'));
    check('signed in with the second step done', (await me(ctx)).restricted === null);
  }

  /* ── 5. the Owner hands out links ───────────────────────────────────── */
  console.log('\n5. step-up, then an invite, an Access admin, a screen');
  let dispatchLink, adminLink, deviceLink, dispatchId;
  {
    const { ctx } = A;
    const c = await freshCode(ownerSecret, ownerLast);
    const s = await api(ctx, '/api/auth/stepup', { code: c.code });
    ownerLast = c.step;
    check('the Owner re-confirms with a fresh code', s.status === 200, JSON.stringify(s.body));
    const d = await api(ctx, '/api/access/users', { email: 'dispatch@example.test', grants: [{ role: 'DSP' }], reason: 'test invite' });
    check('an invite is created through the API', d.status === 200 && /^\/signin#invite=/.test(d.body?.link || ''), JSON.stringify(d.body));
    dispatchLink = d.body?.link; dispatchId = d.body?.user?.id;
    const a = await api(ctx, '/api/access/users', { email: 'access.admin@example.test', grants: [{ role: 'ACC' }], reason: 'test invite' });
    check('…and one for an Access admin', a.status === 200 && /^\/signin#invite=/.test(a.body?.link || ''), JSON.stringify(a.body));
    adminLink = a.body?.link;
    const w = await api(ctx, '/api/access/devices', { name: 'Test wall screen' });
    check('…and a wall screen', w.status === 200 && /^\/signin#device=/.test(w.body?.link || ''), JSON.stringify(w.body));
    deviceLink = w.body?.link;
  }

  /* ── 6. the invite, in a browser of its own ─────────────────────────── */
  console.log('\n6. accepting an invite');
  const B = await newPage();
  {
    const { page, ctx } = B;
    /* signin.js is held back at the network, so what is measured here is the
       inline script in signin.html alone: the token must already be out of
       the address bar while the module that uses it has not even arrived. */
    let release;
    const held = new Promise((r) => { release = r; });
    await ctx.route('**/signin.js', async (route) => { await held; await route.continue().catch(() => {}); });
    await page.goto(`${base}${dispatchLink}`, { waitUntil: 'commit' });
    await page.waitForSelector('#signin .si-wait', { state: 'attached' });
    const early = await page.evaluate(() => location.href);
    release();
    check('the invite token left the address bar before signin.js had even loaded', !early.includes('invite='), early);
    await waitH1(page, 'Set up your FleetMirror account');
    await ctx.unroute('**/signin.js');
    check('the invite says whose account it is', (await page.inputValue('#si-account')) === 'dispatch@example.test');
    check('…and asks for a name', await page.locator('#si-name').count() === 1);
    check('the token is not in the address bar or the history entry', !page.url().includes('#') && !(await page.evaluate(() => location.href)).includes('invite'));
    await layout(B, 'invite');
    await page.fill('#si-name', 'Test Dispatcher');
    await page.fill('#si-new', 'short');
    await page.fill('#si-confirm', 'short');
    await page.click('#si-linkform button[type=submit]');
    check('a short password is refused', (await errText(page)).includes('Use at least 12 characters.'));
    await page.fill('#si-new', 'amber cedar delta onyx');
    await page.fill('#si-confirm', 'amber cedar delta onyx');
    await page.click('#si-linkform button[type=submit]');
    await waitH1(page, 'Sign in to FleetMirror');
    check('accepting leads to sign-in, saying the password is set', (await noteText(page)).includes('Your password is set — sign in.'));
    check('…with the email filled in', (await page.inputValue('#si-email')) === 'dispatch@example.test');
    await page.fill('#si-password', 'amber cedar delta onyx');
    await page.click('#si-login button[type=submit]');
    const u = await landed(page);
    check('the new person lands on "/"', u.pathname === '/', u.href);
    const m = await me(ctx);
    check('…signed in with their name and role', m.signedIn && m.user.name === 'Test Dispatcher' && m.roles.includes('DSP'), JSON.stringify(m).slice(0, 200));

    await page.goto(`${base}${dispatchLink}`);
    await waitH1(page, 'This link cannot be used');
    check('a used invite says so, in the server\'s words', (await noteText(page)).includes('expired or was already used'));

    /* Sign out from the page's own button. */
    await page.goto(`${base}/signin`);
    await waitH1(page, 'You are signed in');
    await page.click('[data-act=signout]');
    await page.waitForURL((x) => x.search.includes('why=signedout'));
    await waitH1(page, 'Sign in to FleetMirror');
    check('Sign out ends the session and says so', (await me(ctx)).signedIn === false && (await noteText(page)).includes(WHY.signedout));
  }

  /* ── 7. an Access admin, on a phone: invite → password → two-step ─────── */
  console.log('\n7. an Access admin on a phone: invite, two-step, a recovery code');
  const C = await newPage({ phone: true });
  {
    const { page, ctx } = C;
    await page.goto(`${base}${adminLink}`);
    await waitH1(page, 'Set up your FleetMirror account');
    await page.fill('#si-new', 'birch flint hazel orbit');
    await page.fill('#si-confirm', 'birch flint hazel orbit');
    await page.click('#si-linkform button[type=submit]');
    await waitH1(page, 'Sign in to FleetMirror');
    await page.fill('#si-password', 'birch flint hazel orbit');
    await page.click('#si-login button[type=submit]');
    await waitH1(page, 'Set up two-step sign-in');
    check('an Access admin is asked for two-step at first sign-in', true);
    await page.waitForSelector('#si-secret');
    check('on a phone the "Open in authenticator app" button comes first', await page.evaluate(() => {
      const q = document.getElementById('si-qr'); const a = document.getElementById('si-otpauth');
      return Boolean(q && a && (a.compareDocumentPosition(q) & Node.DOCUMENT_POSITION_FOLLOWING));
    }));
    await layout(C, 'two-step set-up, phone');
    const secret = (await page.locator('#si-secret').innerText()).replace(/\s+/g, '');
    const c = await freshCode(secret, null);
    await page.fill('#si-totp', c.code);
    await page.click('#si-totpform button[type=submit]');
    await waitH1(page, 'Save your recovery codes');
    const codes = (await page.locator('#si-codes li').allInnerTexts()).map((x) => x.trim());
    await layout(C, 'recovery codes, phone');
    await page.click('[data-act=saved]');
    const u = await landed(page);
    check('lands on "/" after the codes', u.pathname === '/');

    await api(ctx, '/api/auth/logout');
    await page.goto(`${base}/signin?back=%2F%23drivers`);
    await waitH1(page, 'Sign in to FleetMirror');
    await page.fill('#si-email', 'access.admin@example.test');
    await page.fill('#si-password', 'birch flint hazel orbit');
    await page.click('#si-login button[type=submit]');
    await waitH1(page, 'Enter your code');
    check('the code box opens the number pad', (await page.getAttribute('#si-code', 'inputmode')) === 'numeric');
    await page.click('[data-act=toggle]');
    await waitH1(page, 'Enter your code');
    check('"Use a recovery code instead" switches to a keyboard with letters', (await page.getAttribute('#si-code', 'inputmode')) === 'text');
    await page.fill('#si-code', codes[3].replace('-', ''));
    await page.click('#si-codeform button[type=submit]');
    const v = await landed(page);
    check('a recovery code signs in, and ?back= is honoured', v.pathname === '/' && v.hash === '#drivers', v.href);

    await api(ctx, '/api/auth/logout');
    await page.goto(`${base}/signin`);
    await page.fill('#si-email', 'access.admin@example.test');
    await page.fill('#si-password', 'birch flint hazel orbit');
    await page.click('#si-login button[type=submit]');
    await waitH1(page, 'Enter your code');
    await page.fill('#si-code', codes[3]);
    await page.click('#si-codeform button[type=submit]');
    check('the same recovery code does not work twice', (await errText(page)).includes('That code is not right'), await errText(page));
  }

  /* ── 8. a reset, a screen, and a screen link opened by a person ──────── */
  console.log('\n8. a password reset, and a wall screen');
  {
    const { ctx } = A;
    const r = await api(ctx, `/api/access/users/${dispatchId}`, { action: 'reset' });
    check('the Owner issues a reset link', r.status === 200 && /^\/signin#reset=/.test(r.body?.link || ''), JSON.stringify(r.body));
    const { page } = B;
    await page.goto(`${base}${r.body.link}`);
    await waitH1(page, 'Choose a new password');
    check('a reset asks for no name', await page.locator('#si-name').count() === 0);
    check('…and names the account', (await page.inputValue('#si-account')) === 'dispatch@example.test');
    await layout(B, 'reset');
    await page.fill('#si-new', 'lotus maple mesa nectar');
    await page.fill('#si-confirm', 'lotus maple mesa nectar');
    await page.click('#si-linkform button[type=submit]');
    await waitH1(page, 'Sign in to FleetMirror');
    await page.fill('#si-password', 'lotus maple mesa nectar');
    await page.click('#si-login button[type=submit]');
    const u = await landed(page);
    check('the new password signs in', u.pathname === '/' && (await me(B.ctx)).signedIn === true);
  }
  {
    /* The Owner, signed in, opens the screen link by mistake: asked, and
       Cancel leaves them exactly as they were. */
    const { page, ctx } = A;
    await page.goto(`${base}${deviceLink}`);
    await waitH1(page, 'Make this browser a screen?');
    check('a screen link in a signed-in browser asks first', (await page.locator('.si-lede').innerText()).includes(OWNER));
    await page.click('[data-act=cancel]');
    await waitH1(page, 'You are signed in');
    check('…and Cancel leaves the person signed in', (await me(ctx)).kind === 'user');

    const D = await newPage();
    await D.page.goto(`${base}${deviceLink}`);
    check('the screen token left the address bar', !D.page.url().includes('device='));
    await waitH1(D.page, 'This screen is signed in');
    check('the screen says what it is signed in as', (await D.page.locator('.si-who').innerText()).includes('Test wall screen'));
    await layout(D, 'screen');
    await D.page.click('[data-act=continue]');
    const u = await landed(D.page);
    check('…and continues to "/"', u.pathname === '/');
    const m = await me(D.ctx);
    check('…as a device', m.signedIn && m.kind === 'device' && m.device?.name === 'Test wall screen');
    await D.page.goto(`${base}/signin`);
    await waitH1(D.page, 'This screen is signed in');
    await D.page.click('[data-act=person]');
    await waitH1(D.page, 'Sign in to FleetMirror');
    check('a person can still sign in at a screen', await D.page.locator('#si-email').count() === 1);
  }

  /* ── 9. what the page cannot know, it says ──────────────────────────── */
  console.log('\n9. saying why');
  {
    const E = await newPage();
    const { page, ctx } = E;
    await page.goto(`${base}/signin?why=required`);
    await waitH1(page, 'Sign in to FleetMirror');
    check('?why=required is explained', (await noteText(page)).includes(WHY.required));
    await page.goto(`${base}/signin?why=nonsense`);
    await waitH1(page, 'Sign in to FleetMirror');
    check('an unknown ?why= says nothing', await page.locator('#signin .si-note').count() === 0);

    await ctx.route('**/api/auth/me', (route) => route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: 'starting', detail: 'migrations are still applying — retry shortly' }) }));
    await page.goto(`${base}/signin`);
    await waitH1(page, 'Sign in to FleetMirror');
    check('when /api/auth/me does not answer, the page says so and why',
      (await noteText(page)).includes('migrations are still applying'), await noteText(page));
    check('…and does not claim sign-in is optional', await page.locator('.si-open').count() === 0);
    await ctx.unroute('**/api/auth/me');

    await ctx.route('**/api/auth/login', (route) => route.abort('connectionrefused'));
    await page.goto(`${base}/signin`);
    await waitH1(page, 'Sign in to FleetMirror');
    await page.fill('#si-email', 'nobody@example.test');
    await page.fill('#si-password', 'any long password here');
    await page.click('#si-login button[type=submit]');
    check('a sign-in that never reached the server says so', (await errText(page)).includes('could not be reached'), await errText(page));
    await ctx.unroute('**/api/auth/login');

    await page.goto(`${base}/signin#invite=abc`);
    await waitH1(page, 'This link cannot be used');
    check('a cut-off link is reported as incomplete', (await noteText(page)).includes('incomplete'));

    await ctx.route('**/signin.js', (route) => route.abort('connectionreset'));
    await page.goto(`${base}/signin`);
    await waitH1(page, 'The sign-in page did not load');
    check('when signin.js does not arrive, the page says so instead of "Checking…" for ever',
      (await noteText(page)).includes('did not arrive'));
    await ctx.unroute('**/signin.js');

    /* /api/auth/me that never answers: the form after twelve seconds, with
       the reason, and no claim about the sign-in mode. */
    let hang;
    const hung = new Promise((r) => { hang = r; });
    await ctx.route('**/api/auth/me', async (route) => { await hung; await route.abort().catch(() => {}); });
    const t = Date.now();
    await page.goto(`${base}/signin`);
    await waitH1(page, 'Sign in to FleetMirror');
    check('a /api/auth/me that never answers gives way to the form, saying so',
      (await noteText(page)).includes('no answer after 12 seconds') && Date.now() - t >= 11_000, await noteText(page));
    check('…with no claim that sign-in is optional', await page.locator('.si-open').count() === 0);
    hang();
    await ctx.unroute('**/api/auth/me');
  }

  /* ── 10. sign-in required ────────────────────────────────────────────── */
  console.log('\n10. once sign-in is required');
  {
    const c = await freshCode(ownerSecret, ownerLast);
    const s = await api(A.ctx, '/api/auth/stepup', { code: c.code });
    ownerLast = c.step;
    const r = await api(A.ctx, '/api/access/config', { mode: 'enforced' });
    check('the Owner requires sign-in', s.status === 200 && r.status === 200 && r.body?.config?.mode === 'enforced', JSON.stringify(r.body));
    const F = await newPage();
    await F.page.goto(`${base}/signin?why=required`);
    await waitH1(F.page, 'Sign in to FleetMirror');
    check('the optional-sign-in line is gone', await F.page.locator('.si-open').count() === 0);
    await F.page.fill('#si-email', 'dispatch@example.test');
    await F.page.fill('#si-password', 'lotus maple mesa nectar');
    await F.page.click('#si-login button[type=submit]');
    const u = await landed(F.page);
    check('signing in still works when it is required', u.pathname === '/');
  }

  /* ── 10b. links opened in a browser somebody is signed in to ─────────── */
  console.log('\n10b. links opened in a browser that is already signed in');
  {
    const inv = await api(A.ctx, '/api/access/users', { email: 'second.dispatch@example.test', grants: [{ role: 'DSP' }], reason: 'test invite' });
    const dev = await api(A.ctx, '/api/access/devices', { name: 'Test second screen' });
    check('two more links are issued (the step-up still holds)', inv.status === 200 && dev.status === 200, JSON.stringify([inv.body, dev.body]).slice(0, 200));

    /* The Owner opens somebody else's invite in their own browser. */
    const { page, ctx } = A;
    await page.goto(`${base}${inv.body.link}`);
    await waitH1(page, 'Set up your FleetMirror account');
    check('the invite warns that this browser is signed in as somebody else',
      (await noteText(page)).includes(`signed in as ${OWNER}`), await noteText(page));
    await page.fill('#si-new', 'garnet iris jade kestrel');
    await page.fill('#si-confirm', 'garnet iris jade kestrel');
    await page.click('#si-linkform button[type=submit]');
    await waitH1(page, 'Sign in to FleetMirror');
    check('…finishing it ends the Owner\'s session here, as it said', (await me(ctx)).signedIn === false);
    check('…and offers sign-in for the new account', (await page.inputValue('#si-email')) === 'second.dispatch@example.test');

    /* A screen link opened where a person is signed in, and accepted. */
    const { page: bp, ctx: bctx } = B;
    await bp.goto(`${base}${dev.body.link}`);
    await waitH1(bp, 'Make this browser a screen?');
    await bp.click('[data-act=go]');
    await waitH1(bp, 'This screen is signed in');
    const m = await me(bctx);
    check('"Sign out and make this browser the screen" does both', m.kind === 'device' && m.device?.name === 'Test second screen', JSON.stringify(m).slice(0, 160));
  }


  /* ── 11. the console ─────────────────────────────────────────────────── */
  console.log('\n11. the console');
  const errors = pages.flatMap((p) => p.errors);
  check('no script errors and no console errors on /signin (other than HTTP refusals the test provoked)', !errors.length, errors.slice(0, 5).join(' | '));
  const refusals = pages.flatMap((p) => p.refusals);
  check('every console "error" was the browser logging a refusal status', refusals.every((t) => /status of (4\d\d|503)|net::ERR_/.test(t)), refusals.slice(0, 3).join(' | '));
} catch (e) {
  fail++;
  console.log(`  ✗ the run stopped: ${String(e?.stack || e).slice(0, 1500)}`);
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
