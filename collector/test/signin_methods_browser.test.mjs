/* PASSKEYS AND SINGLE SIGN-ON IN A REAL BROWSER — the pages, and a real
   WebAuthn implementation against the server's own verifier.
   ═════════════════════════════════════════════════════════════════════════
   test/access_passkey_sso.test.mjs drives the routes with a synthetic
   authenticator written in this repository — which could share a misreading
   with the verifier it tests. Here Chromium's own WebAuthn stack makes the
   credentials (a CDP virtual authenticator: platform, resident keys, user
   verification), so the CBOR, COSE, flags and signatures the server parses
   are the browser's, not ours.

   ONE PORT. A harness on http://localhost:8310 (the port this work may use;
   localhost because WebAuthn refuses an IP address as an RP id) serves the
   real api/public files, the real access routes on a pglite database, and
   the mock provider under /idp. "/" is a stub: where sign-in sends a reader
   is the page's business, what the dashboard draws is app.js's. Two tiny
   harness pages render the account page and the Access settings panel from
   their real modules.

   What it holds the pages to:
     · with both methods off, the sign-in page is exactly what it was;
     · on, "Continue with passkey" and "Continue with <provider>" come first,
       and each signs a person in and sends them on;
     · a passkey made by the browser registers, signs in, counts, re-confirms
       ("confirm it is you"), and is listed and removed on the account page;
     · single sign-on's three landings: done, a refusal said in words, and the
       two-step code still owed;
     · the Owner switches a method from the Access settings panel, through the
       "confirm it is you" dialog;
     · 390px and 1280px, light and dark: no sideways scroll, and at 390px every
       control at least 44px tall.

   SKIPS (exit 0) when Chromium cannot launch or port 8310 is taken.

   REVERSIONS THAT PROVE IT — each was made, run, and seen to fail the named
   check, 2026-11-12:
     · signin.js altWays: return '' — "…shows Continue with passkey" fails.
     · signin.js start: drop the `sso === 'done'` branch — "single sign-on
       returns signed in" fails (the page sits on the sign-in form).
     · signin_methods.js credentialJson: drop userHandle — "the browser's
       passkey signs in" fails (the server refuses a credential naming
       nobody). */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_FILES } from './schema.mjs';
import { accessLayer } from '../api/access/middleware.js';
import { accessRoutes } from '../api/access/routes.js';
import { signinMethodRoutes } from '../api/access/signin_methods.js';
import { lookupEntry } from '../api/access/manifest.js';
import * as svc from '../api/access/service.js';
import { hashPassword, newTotpSecret, seal, hotp, totpStep } from '../api/access/crypto.js';
import { SSO_REFUSALS } from '../api/public/signin_methods.js';
import { mockProvider } from './_authenticator.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dir, '..', 'api', 'public');
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const skip = (why) => { console.log(`  - skipped: ${why}`); process.exit(0); };

const PORT = 8310;
const BASE = `http://localhost:${PORT}`;
const free = await new Promise((r) => { const s = createServer(); s.once('error', () => r(false)); s.listen(PORT, () => s.close(() => r(true))); });
if (!free) skip(`port ${PORT} is in use`);

for (const k of ['ACCESS_MODE', 'OIDC_NAME']) delete process.env[k];
process.env.PUBLIC_URL = BASE;

const pg = new PGlite();
for (const f of SCHEMA_FILES) await pg.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8'));
const db = { query: (t, p) => pg.query(t, p) };

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
const layer = accessLayer({ db, lookup: (m, p) => (lookupEntry(m, p)?.self ? lookupEntry(m, p) : null) });
app.use(layer.identify);
app.use(layer.gate);
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: 'internal', detail: String(e) }));
accessRoutes(app, { db, layer, wrap, smsSend: async () => ({ ok: true }), reportHttp: async () => ({ status: 200, data: {} }) });
signinMethodRoutes(app, { db, layer, wrap });
const idp = await mockProvider({ host: app, base: BASE, prefix: '/idp' });
process.env.OIDC_ISSUER = idp.issuer;
process.env.OIDC_CLIENT_ID = idp.clientId;
process.env.OIDC_CLIENT_SECRET = idp.clientSecret;
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>harness</title>
  <link rel="stylesheet" href="/access.css"></head><body>${body}</body></html>`;
app.get('/', (req, res) => res.send(page('<p id="stub">Dashboard stub</p>')));
app.get('/signin', (req, res) => res.sendFile(join(PUBLIC_DIR, 'signin.html')));
app.get('/harness/account', (req, res) => res.send(page(`<main id="view"></main>
  <script type="module">import('/account.js').then((m) => m.accountPage(document.getElementById('view'))).then(() => { document.body.dataset.ready = '1'; });</script>`)));
app.get('/harness/access-settings', (req, res) => res.send(page(`<main id="view"></main><p id="said"></p>
  <script type="module">
    /* app.js loads who at boot; the dialog reads it to ask for a code or a password. */
    await (await import('/access.js')).loadWho();
    const { signinMethodsPanel } = await import('/signin_methods_admin.js');
    const host = document.getElementById('view');
    signinMethodsPanel(host, { say: (t) => { document.getElementById('said').textContent = t; }, reload: async () => {} });
    document.body.dataset.ready = '1';
  </script>`)));
app.use(express.static(PUBLIC_DIR, { index: false }));
const server = await new Promise((r) => { const s = app.listen(PORT, () => r(s)); });

/* People. Synthetic only. */
const PASS = 'a long synthetic test password';
async function person(email, role, { totp = false } = {}) {
  const u = await svc.createUser(db, { email, name: `Test ${role}`, status: 'active', passwordHash: hashPassword(PASS) });
  await svc.createGrant(db, { userId: u.id, roleCode: role, reason: 'test' });
  let secret = null;
  if (totp) { secret = newTotpSecret(); await db.query('UPDATE access_user SET totp_enabled = true, totp_secret = $2 WHERE id = $1', [u.id, seal(secret)]); }
  return { id: u.id, email, secret };
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function code(p) {
  for (;;) {
    const t = totpStep();
    const s = Math.max((p.lastStep ?? -Infinity) + 1, t - 1);
    if (s <= t + 1) { p.lastStep = s; return hotp(p.secret, s); }
    await sleep(1000);
  }
}
const owner = await person('owner@example.test', 'OWN', { totp: true });
const fin = await person('finance@example.test', 'FIN');

let browser;
try {
  const { launchChromium } = await import('./browser.mjs');
  browser = await launchChromium();
} catch (e) { server.close(); skip(`Chromium did not launch (${String(e).split('\n')[0].slice(0, 120)})`); }

/* A context with a virtual platform authenticator on its page. */
async function open({ width = 1280, scheme = 'light', authenticator = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme });
  const pg2 = await ctx.newPage();
  let cdp = null; let authId = null;
  if (authenticator) {
    cdp = await ctx.newCDPSession(pg2);
    await cdp.send('WebAuthn.enable', { enableUI: false });
    ({ authenticatorId: authId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }));
  }
  return { ctx, page: pg2, cdp, authId };
}
const me = (pg2) => pg2.evaluate(() => fetch('/api/auth/me', { cache: 'no-store' }).then((r) => r.json()));
/* Waits that answer yes or no, so a page that does not get there fails the
   check that names it rather than crashing the file. */
const reached = (pg2, url) => pg2.waitForURL(url, { timeout: 15000 }).then(() => true, () => false);
/* Each section runs on; one that throws is reported and the next begins. */
async function section(name, fn) {
  try { await fn(); } catch (e) { check(`${name} — ran to the end`, false, String(e?.message || e).split('\n')[0].slice(0, 200)); }
}
const lastSession = async (userId) => (await db.query('SELECT * FROM access_session WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [userId])).rows[0];
async function passwordIn(pg2, p) {
  await pg2.goto(`${BASE}/signin`);
  await pg2.waitForSelector('#si-login');
  await pg2.fill('#si-email', p.email);
  await pg2.fill('#si-password', PASS);
  await pg2.click('#si-login button[type="submit"]');
  if (p.secret) {
    await pg2.waitForSelector('#si-codeform');
    await pg2.fill('#si-code', await code(p));
    await pg2.click('#si-codeform button[type="submit"]');
  }
  await pg2.waitForURL(`${BASE}/`, { timeout: 15000 });
}
/* PKY_SHOTS=<dir> saves a screenshot of every layout check. */
async function layoutOk(pg2, label) {
  if (process.env.PKY_SHOTS) await pg2.screenshot({ path: join(process.env.PKY_SHOTS, `${label.replace(/[^a-z0-9]+/gi, '-')}.png`), fullPage: true });
  const r = await pg2.evaluate(() => {
    const over = document.documentElement.scrollWidth > window.innerWidth + 1;
    const small = [...document.querySelectorAll('#signin button, #signin a.si-btn, #signin input')]
      .filter((n) => n.offsetParent !== null && n.getBoundingClientRect().height < 44)
      .map((n) => `${n.tagName}:${(n.textContent || n.id).trim().slice(0, 30)}:${Math.round(n.getBoundingClientRect().height)}`);
    return { over, small, width: window.innerWidth };
  });
  check(`${label}: no sideways scroll`, !r.over);
  if (r.width <= 400) check(`${label}: every control at least 44px tall`, r.small.length === 0, r.small.join(', '));
}

try {
  console.log('\n1. both off: the sign-in page is what it was');
  {
    const { ctx, page: p } = await open({ authenticator: false });
    await p.goto(`${BASE}/signin`);
    await p.waitForSelector('#si-login');
    check('no passkey button and no single sign-on button', (await p.$('[data-act="passkey"]')) === null && (await p.$('[data-sso]')) === null
      && (await p.$('.si-alt')) === null);
    await ctx.close();
  }

  await svc.setConfig(db, 'passkeys', 'on', owner.id);
  await svc.setConfig(db, 'sso', 'on', owner.id);
  await svc.setConfig(db, 'sso_domains', ['example.test'], owner.id);
  await svc.getConfig(db, { fresh: true });

  console.log('\n2. a passkey made by the browser: registered, then signing in');
  const A = await open();
  await section('2', async () => {
    const p = A.page;
    await p.goto(`${BASE}/signin`);
    await p.waitForSelector('#si-login');
    const pkBtn = await p.$('[data-act="passkey"]');
    check('with passkeys on, the sign-in page shows Continue with passkey, above the password form',
      Boolean(pkBtn) && Boolean(await pkBtn.evaluate((b) => b.compareDocumentPosition(document.querySelector('#si-login')) & Node.DOCUMENT_POSITION_FOLLOWING)));
    const ssoA = await p.$('[data-sso]');
    check('…and Continue with the provider, as a link to the server', Boolean(ssoA) && (await ssoA.getAttribute('href')) === '/api/auth/sso/start');
    await passwordIn(p, fin);
    const reg = await p.evaluate(async (pw) => {
      const { post } = await import('/access.js');
      const { registerPasskey } = await import('/signin_methods.js');
      await post('/api/auth/stepup', { password: pw }, { retry: false });
      try { return await registerPasskey(post, { name: 'Virtual laptop' }); } catch (e) { return { error: e.message }; }
    }, PASS);
    check('the browser\'s own passkey registers with the server', reg?.ok === true, JSON.stringify(reg));
    const { credentials } = await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authId });
    const row = (await db.query('SELECT * FROM access_passkey WHERE user_id = $1', [fin.id])).rows[0];
    const credB64url = credentials[0] && Buffer.from(credentials[0].credentialId, 'base64').toString('base64url');
    check('…stored under the authenticator\'s credential id, as a discoverable credential', row && row.credential_id === credB64url && credentials[0].isResidentCredential);
    check('…with the browser\'s key (ES256) and transports', row && row.alg === -7 && row.transports.includes('internal'));
    await p.evaluate(async () => { const { post } = await import('/access.js'); await post('/api/auth/logout', {}, { retry: false }); });
    await p.goto(`${BASE}/signin`);
    await p.waitForSelector('[data-act="passkey"]');
    await layoutOk(p, 'sign-in with both methods, 1280px light');
    await p.click('[data-act="passkey"]');
    const landed = await reached(p, `${BASE}/`);
    const who = landed ? await me(p) : {};
    const err = landed ? '' : await p.$eval('#si-alt-err', (n) => n.textContent).catch(() => '');
    check('the browser\'s passkey signs in, with no email typed, and the page sends the person on', landed && who.signedIn && who.user.email === fin.email, err);
    check('…a passkey session, two-step done', (await lastSession(fin.id)).auth_method === 'passkey' && (await lastSession(fin.id)).mfa_ok === true);
    const { credentials: c2 } = await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authId });
    const row2 = (await db.query('SELECT sign_count FROM access_passkey WHERE user_id = $1', [fin.id])).rows[0];
    check('the server\'s counter follows the authenticator\'s', Number(row2?.sign_count) === c2[0]?.signCount && c2[0]?.signCount >= 1, `${row2?.sign_count} vs ${c2[0]?.signCount}`);
  });

  console.log('\n3. "confirm it is you" with the passkey, and the account page');
  await section('3', async () => {
    const p = A.page;
    await p.evaluate(() => { window.__c = import('/access.js').then((m) => m.confirmIdentity()).then(() => 'ok', (e) => e.message); });
    await p.waitForSelector('dialog .ac-passkey:not([hidden])', { timeout: 10000 });
    check('the dialog offers "Use a passkey" to somebody who has one', true);
    await p.click('dialog .ac-passkey');
    check('…and the passkey re-confirms them', (await p.evaluate(() => window.__c)) === 'ok');
    check('…recorded on the session as a step-up', Boolean((await lastSession(fin.id)).stepup_at));
    await p.goto(`${BASE}/harness/account`);
    await p.waitForSelector('[data-panel="acct-passkeys"]:not([hidden]) table, [data-panel="acct-passkeys"]:not([hidden]) .cards', { timeout: 10000 }).catch(() => {});
    const text = await p.$eval('[data-panel="acct-passkeys"]', (n) => (n.hidden ? '' : n.innerText));
    check('the account page lists the passkey by its name', /Virtual laptop/.test(text), text.slice(0, 200));
    await p.click('[data-panel="acct-passkeys"] button[data-pk-remove]');
    await p.waitForFunction(() => /Passkey removed/.test(document.querySelector('[data-panel="acct-passkeys"] .acx-msg')?.textContent || ''), null, { timeout: 10000 });
    check('…and removes it', (await db.query('SELECT 1 FROM access_passkey WHERE user_id = $1', [fin.id])).rows.length === 0);
    await p.fill('[data-acx="passkey-name"]', 'Second laptop');
    await p.click('[data-acx="passkey-add"]');
    await p.waitForFunction(() => /Passkey added/.test(document.querySelector('[data-panel="acct-passkeys"] .acx-msg')?.textContent || ''), null, { timeout: 10000 });
    check('"Add a passkey" makes one with the browser and lists it', /Second laptop/.test(await p.$eval('[data-panel="acct-passkeys"]', (n) => n.innerText)));
  });
  await A.ctx.close();

  console.log('\n4. the Owner switches a method from the Access settings panel');
  await section('4', async () => {
    const O = await open({ authenticator: false });
    const p = O.page;
    await passwordIn(p, owner);
    await p.goto(`${BASE}/harness/access-settings`);
    await p.waitForSelector('[data-acx="save-passkeys"]');
    const t = await p.$eval('[data-acx="signin-methods"]', (n) => n.innerText);
    check('the panel says each method is ready, and never shows the secret', /Ready: passkeys belong to localhost/.test(t) && /Ready: /.test(t)
      && t.includes(`${BASE}/api/auth/sso/callback`) && !t.includes(idp.clientSecret));
    await p.selectOption('[data-acx="passkeys"]', 'off');
    await p.click('[data-acx="save-passkeys"]');
    await p.waitForSelector('dialog #ac-stepup');
    await p.fill('dialog #ac-stepup', await code(owner));
    await p.click('dialog button[type="submit"]');
    await p.waitForFunction(() => /Passkeys are off/.test(document.getElementById('said').textContent), null, { timeout: 10000 });
    check('switching passkeys off goes through "confirm it is you", then saves', (await svc.getConfig(db, { fresh: true })).passkeys === 'off');
    await p.waitForSelector('[data-acx="save-passkeys"]');
    await p.selectOption('[data-acx="passkeys"]', 'on');
    await p.click('[data-acx="save-passkeys"]');
    await p.waitForFunction(() => /Passkeys are on/.test(document.getElementById('said').textContent), null, { timeout: 10000 });
    check('…and back on, within the ten minutes, without asking again', (await svc.getConfig(db, { fresh: true })).passkeys === 'on');
    await O.ctx.close();
  });

  console.log('\n5. single sign-on, from the button');
  await section('5', async () => {
    const S = await open({ authenticator: false });
    const p = S.page;
    idp.claims = { sub: 'sub-fin', email: fin.email, email_verified: true, name: 'Test FIN' };
    await p.goto(`${BASE}/signin`);
    await p.click('[data-sso]');
    const landed = await reached(p, `${BASE}/`);
    const who = landed ? await me(p) : {};
    check('single sign-on returns signed in, and the page sends the person on', landed && who.signedIn && who.user.email === fin.email, p.url());
    check('…a single sign-on session', (await lastSession(fin.id)).auth_method === 'sso');
    await S.ctx.close();

    const R = await open({ authenticator: false });
    idp.claims = { sub: 'sub-x', email: 'someone@other.example', email_verified: true };
    await R.page.goto(`${BASE}/signin`);
    await R.page.click('[data-sso]');
    await R.page.waitForSelector('#si-login');
    const note = await R.page.$eval('#signin .si-note', (n) => n.textContent).catch(() => '');
    check('a refusal comes back as the page\'s own sentence for its code', note === SSO_REFUSALS.domain, note);
    check('…and the code leaves the address', !R.page.url().includes('sso='), R.page.url());
    await R.ctx.close();

    const C = await open({ width: 390, scheme: 'dark', authenticator: false });
    idp.claims = { sub: 'sub-own', email: owner.email, email_verified: true };
    await C.page.goto(`${BASE}/signin`);
    await layoutOk(C.page, 'sign-in with both methods, 390px dark');
    await C.page.click('[data-sso]');
    await C.page.waitForSelector('#si-ssocode');
    check('two-step still owed after the provider: the code step', /signed you in/.test(await C.page.$eval('#signin', (n) => n.innerText)));
    await layoutOk(C.page, 'the code step after single sign-on, 390px dark');
    await C.page.fill('#si-scode', await code(owner));
    await C.page.click('#si-ssocode button[type="submit"]');
    await C.page.waitForURL(`${BASE}/`, { timeout: 15000 });
    check('…and the code signs them in', (await me(C.page)).user?.email === owner.email);
    await C.ctx.close();

    const L = await open({ width: 390, scheme: 'light', authenticator: false });
    await L.page.goto(`${BASE}/signin`);
    await L.page.waitForSelector('[data-act="passkey"]');
    await layoutOk(L.page, 'sign-in with both methods, 390px light');
    await L.ctx.close();
    const D = await open({ width: 1280, scheme: 'dark', authenticator: false });
    await D.page.goto(`${BASE}/signin`);
    await D.page.waitForSelector('[data-act="passkey"]');
    await layoutOk(D.page, 'sign-in with both methods, 1280px dark');
    await D.ctx.close();
  });
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${fail ? '✗' : '✓'} signin_methods_browser: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
