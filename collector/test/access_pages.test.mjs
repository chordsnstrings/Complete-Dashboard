/* YOUR ACCOUNT and SET UP → ACCESS — the two pages, driven in a real browser
   against the real server on a real Postgres.
   ═════════════════════════════════════════════════════════════════════════
   api/public/account.js and api/public/accessadmin.js draw what the server
   decides; this file proves they draw it and that every change they offer
   actually reaches the server and lands. It boots api/server.js exactly as
   production does (every migration, the bootstrapped first Owner) on its own
   database and port, signs that Owner in through the API — first password,
   the forced change, two-step set up with a real TOTP code — hands the
   session cookie to Chromium, and then works the pages as a person would:

     People     invite a Cash desk person → the one-time link is shown, whole
     (API)      the link is accepted, as the invitee would
     Person     give them Dispatcher → revoke it
     Teams      make a team → add them to it
     Roles      the fourteen built-in roles in the matrix; a custom one made
     Requests   the cash-desk person asks for access (API) → the Owner approves
     Reviews    this quarter's review opened → the team attested
     Screens    a wall display made (its link shown once) → switched off
     Audit      rows listed; the hash chain checked and intact
     Settings   sign-in required → and back to optional, each confirmed
     Account    sessions listed; preview as Dispatcher → ended; the look
                switched to Classic → back to Arkiv

   Then every address of both pages at 390px and 1440px, in Arkiv and in
   Classic (and dark, and the phone build at 390): the page must not scroll
   sideways and must print no console error of its own.

   CONSOLE ERRORS. Chromium logs "Failed to load resource" for every 4xx a
   page's fetch receives, including the SHELL's (app.js's strip, freshness,
   source line) — which are not these pages. A 403 whose body is the access
   layer refusing a route this role does not hold, or one the route manifest
   does not declare yet (ULM-3, another part of the work), is counted and
   PRINTED as the shell's, by URL and reason, not hidden; anything else — any
   page error, any 4xx on /api/auth or /api/access, any other console error —
   fails. ACCESS_PAGES_STRICT=1 fails on the shell's too.

   Needs the local Postgres (ACCESS_PAGES_PG, default
   postgres://fleet@127.0.0.1:55432/fleet): when it cannot be reached this
   prints a skip line and exits 0. Synthetic people only (@example.test).

   REVERSIONS that prove it (each fails the named check):
     accessadmin.js invitePanel: drop `location.origin` from oneTimeLink's
       url (account.js) → "the invitation link is shown whole".
     accessadmin.js personTab: post the grant without `userId` →
       "Dispatcher is given".
     accessadmin.js settingsTab: send `mode: 'open'` from the Yes button
       whatever was chosen → "sign-in is now required".
     account.js lookPanel: remove location.reload() → part 13 fails, waiting
       for the reload the switch owes before "the look is Classic".
   Each was reverted and run on 2026-09-28; each failed as named. */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import pg from 'pg';
import { hashPassword, hotp, totpStep } from '../api/access/crypto.js';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const PORT = 8412;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_URL = process.env.ACCESS_PAGES_PG || 'postgres://fleet@127.0.0.1:55432/fleet';
const DB = 'fleet_access_pages';
const DB_URL = (() => { const u = new URL(ADMIN_URL); u.pathname = `/${DB}`; return u.toString(); })();
const OWNER = 'owner@example.test';
const FIRST = 'first handover phrase 2026';
const SECOND = 'granite harbour lantern 77';
const CASH = 'cash.desk@example.test';
const CASH_PW = 'copper willow meadow 42';
const SHOTS = process.env.ACCESS_PAGES_SHOTS || '';
const STRICT = process.env.ACCESS_PAGES_STRICT === '1';

/* ── is there a Postgres to boot on? ─────────────────────────────────── */
const admin = new pg.Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
try { await admin.connect(); } catch (e) {
  console.log(`  - skipped: no Postgres at ${ADMIN_URL.replace(/\/\/[^@]*@/, '//')} (${String(e.message || e).slice(0, 80)})`);
  process.exit(0);
}
const portBusy = await fetch(`${BASE}/api/health`).then(() => true, () => false);
if (portBusy) {
  console.log(`  ✗ port ${PORT} is already in use — stop whatever is listening there and run again`);
  await admin.end();
  process.exit(1);
}
await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DB}`);
await admin.end();

/* ── the real server ─────────────────────────────────────────────────── */
const env = { ...process.env, DATABASE_URL: DB_URL, DATABASE_SSL: 'false', PORT: String(PORT), WARM: 'off',
  BOOTSTRAP_OWNER_EMAIL: OWNER, BOOTSTRAP_OWNER_PASSWORD_HASH: hashPassword(FIRST) };
delete env.ACCESS_MODE;
const server = spawn(process.execPath, ['api/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog = (serverLog + d).slice(-20000); });
server.stderr.on('data', (d) => { serverLog = (serverLog + d).slice(-20000); });
let browser = null;
const finish = async (code) => {
  try { await browser?.close(); } catch { /* already gone */ }
  try { await dbc.end(); } catch { /* already closed */ }
  if (server.exitCode == null && server.signalCode == null) {
    server.kill('SIGTERM');
    await new Promise((r) => { server.once('exit', r); setTimeout(r, 5000); });
    if (server.exitCode == null && server.signalCode == null) server.kill('SIGKILL');
  }
  process.exit(code);
};
process.on('uncaughtException', (e) => { console.log(`  ✗ crashed: ${e.stack || e}`); console.log(serverLog.slice(-3000)); finish(1); });
process.on('unhandledRejection', (e) => { console.log(`  ✗ crashed: ${e?.stack || e}`); console.log(serverLog.slice(-3000)); finish(1); });

const dbc = new pg.Client({ connectionString: DB_URL });
const until = async (what, fn, ms = 120000) => {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch { /* not yet */ }
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}\n${serverLog.slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};
await until('the server to answer', async () => (await fetch(`${BASE}/api/auth/me`)).status === 200);
await dbc.connect();
await until('the first Owner to be bootstrapped', async () =>
  (await dbc.query(`SELECT count(*)::int AS n FROM access_grant WHERE role_code = 'OWN' AND status = 'active'`)).rows[0].n === 1);

/* ── a cookie jar per person, for the API side ───────────────────────── */
function agent() {
  const jar = {};
  const header = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const call = async (method, path, body) => {
    const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', cookie: header(),
      ...(jar.fm_csrf ? { 'x-fm-csrf': decodeURIComponent(jar.fm_csrf) } : {}) }, body: body ? JSON.stringify(body) : undefined });
    for (const c of r.headers.getSetCookie()) {
      const kv = c.split(';')[0]; const i = kv.indexOf('=');
      const k = kv.slice(0, i); const v = kv.slice(i + 1);
      if (v === '') delete jar[k]; else jar[k] = v;
    }
    let j = null; try { j = await r.json(); } catch { /* not json */ }
    return { status: r.status, j };
  };
  return { jar, call };
}

console.log('\n1 · the bootstrapped Owner signs in through the API');
const own = agent();
let secret = null; let lastStep = 0; let stepupAt = 0;
{
  let r = await own.call('POST', '/api/auth/login', { email: OWNER, password: FIRST });
  check('the first password signs in, and must be changed', r.status === 200 && r.j?.mustChangePassword === true, JSON.stringify(r.j));
  r = await own.call('POST', '/api/auth/password', { current: FIRST, next: SECOND });
  check('the password is changed', r.status === 200, JSON.stringify(r.j));
  r = await own.call('GET', '/api/auth/me');
  check('…and two-step is now owed (policy: admins)', r.j?.restricted === 'mfa', r.j?.restricted);
  r = await own.call('POST', '/api/auth/totp/setup', {});
  secret = r.j?.secret;
  lastStep = totpStep();
  r = await own.call('POST', '/api/auth/totp/enable', { code: hotp(secret, lastStep) });
  stepupAt = Date.now();
  check('two-step is turned on with a real code', r.status === 200 && r.j?.recoveryCodes?.length === 10, JSON.stringify(r.j)?.slice(0, 120));
  r = await own.call('GET', '/api/auth/me');
  check('the session is the Owner’s, unrestricted', r.j?.owner === true && !r.j?.restricted, JSON.stringify(r.j?.restricted));
}
/* Changes to access are re-confirmed within ten minutes (§5.1). The browser
   shares this session, so re-confirming here re-confirms it there. A code is
   accepted once, so a fresh one waits for the next thirty-second step. */
async function ensureStepup() {
  if (Date.now() - stepupAt < 7 * 60_000) return;
  while (totpStep() <= lastStep) await new Promise((r) => setTimeout(r, 1000));
  lastStep = totpStep();
  const r = await own.call('POST', '/api/auth/stepup', { code: hotp(secret, lastStep) });
  if (r.status !== 200) throw new Error(`step-up refused: ${JSON.stringify(r.j)}`);
  stepupAt = Date.now();
}

/* ── the browser ─────────────────────────────────────────────────────── */
browser = await launchChromium();
const cookies = () => Object.entries(own.jar).map(([name, value]) => ({ name, value, domain: '127.0.0.1', path: '/',
  httpOnly: name !== 'fm_csrf', sameSite: name === 'fm_csrf' ? 'Strict' : 'Lax' }));
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
await ctx.addCookies(cookies());
const page = await ctx.newPage();
/* A step whose element never appears fails its own check and the run goes
   on, rather than one missing button hiding every check after it. */
page.setDefaultTimeout(15000);

/* Console errors, sorted into ours and the shell's (see the header). */
const refused = new Map();          // url → the body's error code, for 4xx answers
const mine = [];
const shell = [];
const watch = (p) => {
  p.on('response', async (res) => {
    if (res.status() < 400) return;
    let code = '';
    try { code = (await res.json())?.error || ''; } catch { /* not json */ }
    refused.set(res.url(), { status: res.status(), code });
  });
  p.on('pageerror', (e) => mine.push(`page error: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url || '';
    const text = m.text();
    if (/Failed to load resource/.test(text) && url) {
      const path = new URL(url, BASE).pathname;
      const ours = /^\/api\/(auth|access)\//.test(path) || !path.startsWith('/api/');
      if (!ours) { shell.push({ url: path, status: /status of (\d+)/.exec(text)?.[1] || '?' }); return; }
    }
    mine.push(`${text} @ ${url}`);
  });
};
watch(page);
const settle = async (p = page) => {
  await p.waitForLoadState('networkidle').catch(() => {});
  await p.waitForTimeout(250);
};
const go = async (addr, { skin = 'arkiv', ui = 'desktop', p = page } = {}) => {
  await p.goto(`${BASE}/?ui=${ui}${skin ? `&skin=${skin}` : ''}#${addr}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.acx-page', { timeout: 20000 });
  await settle(p);
};
const flash = async () => (await page.locator('[data-acx="flash"]').innerText().catch(() => '')).trim();
const waitFlash = async (re, ms = 15000) => {
  await page.waitForFunction((src) => new RegExp(src).test(document.querySelector('[data-acx="flash"]')?.innerText || ''), re.source, { timeout: ms })
    .catch(() => {});
  return flash();
};
/* Each numbered part runs to its end or fails one check saying where it
   stopped: a button that never appeared must not take every later check
   down with it (the reversions in the header each leave the rest running). */
const section = async (n, fn) => {
  try { await fn(); } catch (e) { check(`part ${n} ran to its end`, false, String(e.message || e).split('\n')[0].slice(0, 200)); }
};
const noErrorsSoFar = (where) => {
  const got = mine.splice(0);
  check(`${where}: no console error of the page’s own`, got.length === 0, got.join(' | ').slice(0, 600));
};

console.log('\n2 · People: invite a Cash desk person');
let inviteToken = null; let cashId = null;
await section('2', async () => {
  await ensureStepup();
  await go('access');
  check('the People tab opens for the Owner', await page.locator('[data-panel="acx-people"]').count() === 1);
  check('the Owner is listed', (await page.locator('[data-panel="acx-people"]').innerText()).includes(OWNER));
  const inv = page.locator('[data-panel="acx-invite"]');
  await inv.locator('[data-acx="invite-email"]').fill(CASH);
  await inv.locator('[data-acx="invite-name"]').fill('Test Cash Desk');
  await inv.locator('.acx-grant select').first().selectOption('CLK');
  await inv.locator('[data-acx="invite-reason"]').fill('Records cash handed in at the desk');
  await inv.locator('[data-acx="invite-send"]').click();
  await page.waitForSelector('[data-acx="invite"]', { timeout: 15000 }).catch(() => {});
  const link = await page.locator('[data-acx="invite"]').inputValue().catch(() => '');
  check('the invitation link is shown whole', link.startsWith(`${BASE}/signin#invite=`), link.slice(0, 60));
  check('…with how to send it and for how long', /privately[\s\S]*once, for 7 days/.test(await page.locator('[data-acx="invite-box"]').innerText().catch(() => '')));
  inviteToken = decodeURIComponent(link.split('#invite=')[1] || '');
  check('…and the new person is in the table', (await page.locator('[data-panel="acx-people"]').innerText()).includes('Test Cash Desk'));
  noErrorsSoFar('People');
});

console.log('\n3 · the invitation is accepted (as the invitee would, on /signin)');
const cash = agent();
await section('3', async () => {
  const r = await cash.call('POST', '/api/auth/link/accept', { token: inviteToken, password: CASH_PW });
  check('the link sets their password', r.status === 200 && r.j?.email === CASH, JSON.stringify(r.j));
  const again = await cash.call('POST', '/api/auth/link/accept', { token: inviteToken, password: CASH_PW });
  check('…and works only once', again.status === 404);
  const l = await cash.call('POST', '/api/auth/login', { email: CASH, password: CASH_PW });
  check('they can sign in', l.status === 200 && l.j?.ok === true, JSON.stringify(l.j));
  cashId = (await dbc.query('SELECT id FROM access_user WHERE email_norm = $1', [CASH])).rows[0]?.id;
  cashId = Number(cashId);
});

console.log('\n4 · One person: give Dispatcher, then revoke it');
await section('4', async () => {
  await ensureStepup();
  await go('access');
  await page.locator('[data-panel="acx-people"] a', { hasText: 'Test Cash Desk' }).first().click();
  await page.waitForSelector('[data-panel="acx-person-give"]', { timeout: 15000 });
  await settle();
  check('their page opens from the table', page.url().endsWith(`#access/person/${cashId}`), page.url());
  /* innerText is what the reader sees, so case-blind: Arkiv sets pills in capitals. */
  check('…showing Cash desk, in force', /Cash desk[\s\S]*in force/i.test(await page.locator('[data-panel="acx-person-grants"]').innerText()));
  const give = page.locator('[data-panel="acx-person-give"]');
  await give.locator('.acx-grant select').selectOption('DSP');
  await give.locator('[data-acx="grant-reason"]').fill('Covering the dispatch desk this week');
  await give.locator('[data-acx="grant-give"]').click();
  const f1 = await waitFlash(/Dispatcher given/);
  check('Dispatcher is given', /Dispatcher given to Test Cash Desk/.test(f1), f1);
  const row = page.locator('[data-panel="acx-person-grants"] tr', { hasText: 'Dispatcher' });
  check('…and listed on their page', await row.count() === 1);
  const g = (await dbc.query(`SELECT status FROM access_grant WHERE user_id = $1 AND role_code = 'DSP'`, [cashId])).rows[0];
  check('…and in force on the server', g?.status === 'active', JSON.stringify(g));
  if (await row.count() === 1) {
    await row.locator('button[data-revoke]').click();
    await page.locator('[data-acx="reason"]').fill('Cover ended');
    await page.locator('[data-acx="confirm"]').click();
  }
  const f2 = await waitFlash(/revoked/);
  check('Dispatcher is revoked', /Dispatcher revoked for Test Cash Desk/.test(f2), f2);
  check('…and gone from their page', await page.locator('[data-panel="acx-person-grants"] tr', { hasText: 'Dispatcher' }).count() === 0);
  const g2 = (await dbc.query(`SELECT status FROM access_grant WHERE user_id = $1 AND role_code = 'DSP'`, [cashId])).rows[0];
  check('…and revoked on the server', g2?.status === 'revoked', JSON.stringify(g2));
  noErrorsSoFar('One person');
});

console.log('\n5 · Teams: make one, add a member');
await section('5', async () => {
  await ensureStepup();
  await go('access/teams');
  await page.locator('[data-acx="team-name"]').fill('Cash office');
  await page.locator('[data-acx="team-create"]').click();
  const f = await waitFlash(/Made the team/);
  check('the team is made', /Made the team Cash office/.test(f), f);
  const team = page.locator('[data-team="Cash office"]');
  check('…and has its own panel', await team.count() === 1);
  await team.locator('[data-acx="member-pick"]').selectOption({ label: `Test Cash Desk (${CASH})` });
  await team.locator('[data-acx="member-add"]').click();
  const f2 = await waitFlash(/added to Cash office/);
  check('a member is added', /Test Cash Desk added to Cash office/.test(f2), f2);
  check('…and listed in the team', (await page.locator('[data-team="Cash office"]').innerText()).includes('Test Cash Desk'));
  noErrorsSoFar('Teams');
});

console.log('\n6 · Roles: the matrix, and a role of the company’s own');
await section('6', async () => {
  await ensureStepup();
  await go('access/roles');
  const n = await page.locator('[data-acx="matrix"] thead th[data-role]').count();
  check('the matrix has the fourteen built-in roles', n === 14, String(n));
  const rows = await page.locator('[data-acx="matrix"] tbody tr:not(.acx-grp)').count();
  check('…across the nineteen classes', rows === 19, String(rows));
  await page.locator('[data-acx="role-base"]').selectOption('CLK');
  await page.locator('[data-acx="role-name"]').fill('Night cash desk');
  await page.locator('[data-acx="role-create"]').click();
  const f = await waitFlash(/Made the role/);
  check('a custom role is made from Cash desk', /Made the role Night cash desk/.test(f), f);
  check('…and joins the matrix', await page.locator('[data-acx="matrix"] thead th[data-role]').count() === 15);
  noErrorsSoFar('Roles');
});

console.log('\n7 · Requests: the cash-desk person asks; the Owner approves');
await section('7', async () => {
  const r = await cash.call('POST', '/api/auth/request', { view: 'revenue', class: 'REV', reason: 'Month-end revenue check' });
  check('the request is sent (as the cash-desk person)', r.status === 200 && r.j?.id, JSON.stringify(r.j));
  await ensureStepup();
  await go('access/requests');
  const card = page.locator(`[data-request="${r.j?.id}"]`);
  check('the request is listed with its reason', (await card.innerText().catch(() => '')).includes('Month-end revenue check'));
  check('…and the tab counts it', /Requests · 1/.test(await page.locator('.tabs').innerText()));
  await card.locator('.acx-grant select').selectOption('ANL');
  await card.locator('[data-acx="approve"]').click();
  const f = await waitFlash(/Approved/);
  check('the Owner approves it', /Approved: Analyst for Test Cash Desk/.test(f), f);
  const mineNow = await cash.call('GET', '/api/auth/requests');
  check('…and the person sees it approved', mineNow.j?.requests?.[0]?.status === 'approved', JSON.stringify(mineNow.j?.requests?.[0]?.status));
  check('…under Decided', /approved/i.test(await page.locator('[data-panel="acx-requests-done"]').innerText().catch(() => '')));
  noErrorsSoFar('Requests');
});

console.log('\n8 · Reviews: open this quarter, attest the team');
await section('8', async () => {
  await ensureStepup();
  await go('access/reviews');
  await page.locator('[data-acx="review-open"]').click();
  const f = await waitFlash(/Opened|already/);
  check('this quarter’s review is opened for the team', /Opened \d{4}-Q\d for 1 team/.test(f), f);
  const card = page.locator('[data-review]').first();
  check('…listing its member', (await card.innerText().catch(() => '')).includes('Test Cash Desk'));
  await card.locator('[data-acx="attest"]').click();
  const f2 = await waitFlash(/attested/);
  check('the team is attested, everyone kept', /Cash office attested for .*everyone kept/.test(f2), f2);
  noErrorsSoFar('Reviews');
});

console.log('\n9 · Screens: make a wall display, then switch it off');
await section('9', async () => {
  await ensureStepup();
  await go('access/screens');
  await page.locator('[data-acx="screen-name"]').fill('Office wall');
  await page.locator('[data-acx="screen-create"]').click();
  await page.waitForSelector('[data-acx="screen"]', { timeout: 15000 }).catch(() => {});
  const link = await page.locator('[data-acx="screen"]').inputValue().catch(() => '');
  check('the screen link is shown whole, once', link.startsWith(`${BASE}/signin#device=`), link.slice(0, 50));
  const off = page.locator('[data-panel="acx-screens"] button[data-off]');
  check('…and the screen is listed, on', await off.count() === 1);
  await off.click();
  await off.click();
  /* The link box above also says "switched off" (in its advice), so the wait
     is for the report of this change by name. */
  const f = await waitFlash(/Office wall is switched off/);
  check('the screen is switched off', /Office wall is switched off/.test(f), f);
  const d = (await dbc.query(`SELECT revoked_at FROM access_device WHERE name = 'Office wall'`)).rows[0];
  check('…on the server', d?.revoked_at != null);
  noErrorsSoFar('Screens');
});

console.log('\n10 · Audit: the rows, and the chain');
await section('10', async () => {
  await go('access/audit');
  await page.waitForSelector('[data-panel="acx-audit"] table', { timeout: 15000 }).catch(() => {});
  const rows = await page.locator('[data-panel="acx-audit"] tbody tr').count();
  check('the log lists what was just done', rows >= 10, String(rows));
  check('…in words', /invited a person/.test(await page.locator('[data-panel="acx-audit"]').innerText()));
  await page.locator('[data-acx="chain-check"]').click();
  await page.waitForFunction(() => /Intact|Broken/.test(document.querySelector('[data-acx="chain"]')?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
  const v = await page.locator('[data-acx="chain"]').innerText();
  check('the chain is checked and intact', /^Intact\. All \d+ entries/.test(v.trim()), v);
  await page.locator('[data-acx="audit-kind"]').selectOption('access.');
  await settle();
  const actions = await page.locator('[data-panel="acx-audit"] [data-action-code]').allInnerTexts();
  check('the kind filter narrows it', actions.length > 0 && actions.every((a) => a.startsWith('access.')), actions.slice(0, 4).join(','));
  noErrorsSoFar('Audit');
});

console.log('\n11 · Settings: require sign-in, then make it optional again');
await section('11', async () => {
  await ensureStepup();
  await go('access/settings');
  await page.locator('[data-acx="mode-enforced"]').check();
  await page.locator('[data-acx="mode-save"]').click();
  const conf = await page.locator('[data-acx="mode-confirm"]').innerText();
  check('the confirmation counts the active accounts', /2 people have an active account/.test(conf), conf.slice(0, 120));
  check('…and names the Owners', conf.includes(`Owners: ${OWNER}`), conf.slice(0, 300));
  await page.locator('[data-acx="mode-yes"]').click();
  const f = await waitFlash(/now required/);
  check('sign-in is now required', /Sign-in is now required/.test(f), f);
  const anon = await (await fetch(`${BASE}/api/auth/me`)).json();
  check('…and the server says so to a stranger', anon.mode === 'enforced', anon.mode);
  const refusedAnon = await fetch(`${BASE}/api/kpis?days=1`);
  check('…and refuses a stranger the data', refusedAnon.status === 401, String(refusedAnon.status));
  await page.locator('[data-acx="mode-open"]').check();
  await page.locator('[data-acx="mode-save"]').click();
  await page.locator('[data-acx="mode-yes"]').click();
  const f2 = await waitFlash(/optional again/);
  check('sign-in is optional again', /Sign-in is optional again/.test(f2), f2);
  const anon2 = await (await fetch(`${BASE}/api/auth/me`)).json();
  check('…on the server', anon2.mode === 'open', anon2.mode);
  noErrorsSoFar('Settings');
});

/* ── every address, both looks, both widths ───────────────────────────── */
console.log('\n12 · every address: no sideways scroll, no console error, in Arkiv and Classic, at 390px and 1440px');
const ADDRS = ['account', 'access', `access/person/${cashId}`, 'access/teams', 'access/roles', 'access/requests',
  'access/approvals', 'access/reviews', 'access/screens', 'access/audit', 'access/settings'];
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
/* Two measurements, because two things can scroll sideways. The PAGE'S OWN
   content: every element under .acx-page must end inside the viewport,
   except inside a box built to scroll (a table, the role matrix) — strict,
   always. And the DOCUMENT: when it scrolls sideways, the same look and width
   is measured on a control page these files have nothing to do with
   (#policy); if the control overflows just as far, the overflow is the
   shell's (app.js / app.css), printed with its width, and fails only under
   ACCESS_PAGES_STRICT. Wider than the control is ours, and fails. */
const shellWide = [];
const sweep = async ({ skin, width, ui = 'desktop', scheme = 'light', addrs = ADDRS }) => {
  const c = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', colorScheme: scheme,
    ...(ui === 'phone' ? { hasTouch: true, isMobile: true } : {}) });
  await c.addCookies(cookies());
  const p = await c.newPage();
  watch(p);
  await p.goto(`${BASE}/?ui=${ui}&skin=${skin}#policy`, { waitUntil: 'domcontentloaded' });
  await settle(p);
  const control = await p.evaluate(() => document.documentElement.scrollWidth);
  const wide = []; const own = []; const broken = [];
  for (const a of addrs) {
    await go(a, { skin, ui, p });
    const m = await p.evaluate(() => {
      const iw = innerWidth;
      const past = [];
      for (const n of document.querySelectorAll('.acx-page, .acx-page *')) {
        if (n.parentElement?.closest('.tscroll, .acx-scroll')) continue;
        const r = n.getBoundingClientRect();
        if (r.width > 0 && r.right > iw + 0.5) past.push(`${n.tagName.toLowerCase()}.${String(n.className).split(' ')[0]} ${Math.round(r.right)}`);
      }
      return { sw: document.documentElement.scrollWidth, iw, past: past.slice(0, 4),
        skin: getComputedStyle(document.documentElement).getPropertyValue('--pg-contract').trim() === '1' ? 'arkiv' : 'classic',
        failed: /Could not load this view|This page did not open/.test(document.body.innerText) };
    });
    if (m.past.length) own.push(`#${a}: ${m.past.join(', ')}`);
    if (m.sw > m.iw) (m.sw > control ? wide : shellWide).push(`#${a} ${m.sw}>${m.iw} (${skin}, ${scheme}, ${ui})`);
    if (m.failed || m.skin !== skin) broken.push(`#${a}${m.failed ? ' failed to render' : ` drew ${m.skin}`}`);
    if (SHOTS) await p.screenshot({ path: `${SHOTS}/${ui}-${skin}-${scheme}-${width}-${a.replace(/\//g, '_')}.png`, fullPage: true });
  }
  await c.close();
  const tag = `${skin}, ${scheme}, ${ui} at ${width}px`;
  check(`${tag}: every address rendered in its look`, broken.length === 0, broken.join(' · '));
  check(`${tag}: nothing on these pages reaches past the screen's edge`, own.length === 0, own.join(' · '));
  check(`${tag}: the document scrolls sideways no further than a control page does (#policy, ${control}px)`, wide.length === 0, wide.join(' · '));
  noErrorsSoFar(tag);
};
for (const skin of ['arkiv', 'classic']) {
  for (const width of [390, 1440]) await sweep({ skin, width });
}
for (const skin of ['arkiv', 'classic']) await sweep({ skin, width: 390, scheme: 'dark', addrs: ['account', 'access', 'access/roles', 'access/settings'] });
for (const skin of ['arkiv', 'classic']) await sweep({ skin, width: 390, ui: 'phone', addrs: ['account', 'access', 'access/roles'] });

console.log('\n13 · Your account: sessions, preview as Dispatcher, the look');
await section('13', async () => {
  await go('account');
  const s = await page.locator('[data-panel="acct-sessions"]').innerText();
  check('the sessions list shows this browser', /this browser/i.test(s), s.slice(0, 120));
  check('your roles are listed', /Owner[\s\S]*every fleet/.test(await page.locator('[data-panel="acct-you"]').innerText()));
  await page.locator('[data-panel="acct-preview"] select').selectOption('DSP');
  await Promise.all([page.waitForEvent('load'), page.locator('[data-acx="start-preview"]').click()]);
  await page.waitForSelector('[data-acx="preview-on"]', { timeout: 20000 }).catch(() => {});
  await settle();
  const me = await own.call('GET', '/api/auth/me');
  check('preview as Dispatcher starts', me.j?.preview === 'DSP', me.j?.preview);
  check('…and the page says it is read-only', /previewing the Dispatcher role[\s\S]*nothing can be changed/i.test(await page.locator('[data-acx="preview-on"]').innerText().catch(() => '')));
  check('…and shows what a Dispatcher sees', /Not shown[\s\S]*driver cash/.test(await page.locator('[data-panel="acct-sees"]').innerText()));
  await go('access', { skin: 'arkiv' });
  check('Access is closed while previewing, with the reason', /cannot be changed while you preview/.test(await page.locator('.access-closed').innerText().catch(() => '')));
  await go('account');
  await Promise.all([page.waitForEvent('load'), page.locator('[data-acx="end-preview"]').click()]);
  await page.waitForSelector('[data-panel="acct-you"]', { timeout: 20000 });
  await settle();
  const me2 = await own.call('GET', '/api/auth/me');
  check('the preview ends', me2.j?.preview === null, String(me2.j?.preview));
  /* The preview's own refusals (a Dispatcher is not shown the shell's money
     strip) are the shell's; this page's are still counted. */
  noErrorsSoFar('Account and preview');

  /* The look, with no ?skin= in the address: the choice must stick by itself. */
  const skinNow = () => page.evaluate(() => (getComputedStyle(document.documentElement).getPropertyValue('--pg-contract').trim() === '1' ? 'arkiv' : 'classic'));
  await page.goto(`${BASE}/?ui=desktop#account`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-panel="acct-look"]');
  await settle();
  check('the look starts as Arkiv', await skinNow() === 'arkiv');
  await Promise.all([page.waitForEvent('load'), page.locator('[data-acx="look-classic"]').click()]);
  await page.waitForSelector('[data-panel="acct-look"]');
  await settle();
  check('the look is Classic after switching', await skinNow() === 'classic');
  const p1 = await own.call('GET', '/api/auth/me');
  check('…and kept on the account', p1.j?.user?.prefs?.look === 'classic', JSON.stringify(p1.j?.user?.prefs));
  await Promise.all([page.waitForEvent('load'), page.locator('[data-acx="look-arkiv"]').click()]);
  await page.waitForSelector('[data-panel="acct-look"]');
  await settle();
  check('…and Arkiv again after switching back', await skinNow() === 'arkiv');
  noErrorsSoFar('The look');

  /* The mobile a reset code goes to (2026-09-28). This server has no SMS
     token, so a send cannot happen: the panel must say so in the server's
     words rather than pretend a code is on its way. */
  const mob = page.locator('[data-panel="acct-mobile"]');
  check('the account page offers a mobile for reset codes', await mob.count() === 1
    && /reset code/i.test(await mob.innerText()), await mob.innerText().catch(() => ''));
  await ensureStepup();   // setting the mobile needs a fresh re-confirmation
  await mob.locator('input[type="tel"]').fill('050 123 4567');
  await mob.locator('button[type="submit"]').click();
  await page.waitForFunction(() => /could not be sent/i.test(document.querySelector('[data-panel="acct-mobile"]')?.innerText || ''),
    null, { timeout: 8000 }).catch(() => {});
  check('…and with no SMS gateway set up it says the text could not be sent', /could not be sent/i.test(await mob.innerText()), await mob.innerText());
  /* That 502 is the answer this check asked for; any OTHER error still fails. */
  const otherErrors = mine.splice(0).filter((e) => !/\/api\/auth\/phone/.test(e));
  check('…and the page raised no other console error', otherErrors.length === 0, otherErrors.join(' | ').slice(0, 400));
});

console.log('\n14 · the same pages for an Access admin, and for someone who manages nothing');
await section('14', async () => {
  /* An Access admin, invited through the API (the page's invite is proven in
     2), who must set up two-step before anything opens (policy: admins). */
  await ensureStepup();
  const inv = await own.call('POST', '/api/access/users', { email: 'access.admin@example.test', name: 'Test Access Admin',
    grants: [{ role: 'ACC', fleets: null }], reason: 'Runs access day to day' });
  check('an Access admin is invited', inv.status === 200, JSON.stringify(inv.j).slice(0, 160));
  const acc = agent();
  await acc.call('POST', '/api/auth/link/accept', { token: decodeURIComponent(inv.j?.link?.split('#invite=')[1] || ''), password: 'slate orbit fern 9031' });
  await acc.call('POST', '/api/auth/login', { email: 'access.admin@example.test', password: 'slate orbit fern 9031' });
  const setup = await acc.call('POST', '/api/auth/totp/setup', {});
  const en = await acc.call('POST', '/api/auth/totp/enable', { code: hotp(setup.j?.secret, totpStep()) });
  check('…signs in and sets up two-step', en.status === 200, JSON.stringify(en.j).slice(0, 120));
  const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await c2.addCookies(Object.entries(acc.jar).map(([name, value]) => ({ name, value, domain: '127.0.0.1', path: '/',
    httpOnly: name !== 'fm_csrf', sameSite: name === 'fm_csrf' ? 'Strict' : 'Lax' })));
  const p2 = await c2.newPage();
  watch(p2);
  await go('access', { p: p2 });
  check('People opens for an Access admin', await p2.locator('[data-panel="acx-people"]').count() === 1);
  await go(`access/person/${cashId}`, { p: p2 });
  const give = p2.locator('[data-panel="acx-person-give"]');
  await give.locator('.acx-grant select').selectOption('FIN');
  await give.locator('[data-acx="grant-reason"]').fill('Month end');
  await give.locator('[data-acx="grant-give"]').click();
  await p2.waitForFunction(() => /cannot give access/.test(document.querySelector('[data-panel="acx-person-give"] .acx-msg')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  const refusal = await give.locator('.acx-msg').innerText();
  check('the ceiling: the server’s refusal is shown in place, in its words', /You cannot give access you do not hold yourself/.test(refusal), refusal);
  /* That refusal is a 403 the browser logs; it is the one this step caused on purpose. */
  const expected = mine.filter((m) => /status of 403/.test(m) && /\/api\/access\/grants/.test(m));
  mine.splice(0, mine.length, ...mine.filter((m) => !expected.includes(m)));
  check('…and it is the only console error it caused', expected.length === 1, String(expected.length));
  await go('access/settings', { p: p2 });
  check('Settings are read-only for an Access admin, and say so', /Only the Owner changes these/.test(await p2.locator('.acx-tab').innerText())
    && await p2.locator('[data-acx="mode-save"]').isDisabled());
  await go('access/audit', { p: p2 });
  await p2.waitForSelector('[data-panel="acx-audit"] table', { timeout: 15000 }).catch(() => {});
  check('the audit log opens for an Access admin', await p2.locator('[data-panel="acx-audit"] tbody tr').count() > 5);
  await go('access/approvals', { p: p2 });
  check('Approvals opens for an Access admin', await p2.locator('[data-panel="acx-approvals"]').count() === 1);
  await go('account', { p: p2 });
  check('their account lists the Access admin role, and no preview', /Access admin/.test(await p2.locator('[data-panel="acct-you"]').innerText())
    && await p2.locator('[data-panel="acct-preview"]').count() === 0);
  await c2.close();
  noErrorsSoFar('Access admin');

  /* The cash-desk person (Cash desk, Analyst from the request, the Cash office team). */
  const c3 = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  await c3.addCookies(Object.entries(cash.jar).map(([name, value]) => ({ name, value, domain: '127.0.0.1', path: '/',
    httpOnly: name !== 'fm_csrf', sameSite: name === 'fm_csrf' ? 'Strict' : 'Lax' })));
  const p3 = await c3.newPage();
  watch(p3);
  await go('access', { p: p3 });
  check('Access is closed to someone who manages nothing, with the reason', /Access is managed by the Owner and Access admins/.test(await p3.locator('.access-closed').innerText().catch(() => '')));
  check('…and offers to ask for it', await p3.locator('.access-closed form.ac-ask').count() === 1);
  await go('account', { p: p3 });
  const you = await p3.locator('[data-panel="acct-you"]').innerText();
  check('their account lists their roles and team', /Cash desk/.test(you) && /Analyst/.test(you) && /Cash office/.test(you), you.slice(0, 200));
  check('…the answer to their request', /approved/i.test(await p3.locator('[data-panel="acct-requests"]').innerText()));
  check('…and what they are not shown', /Not shown[\s\S]*contact details/.test(await p3.locator('[data-panel="acct-sees"]').innerText()));
  check('…with no preview (Owners only)', await p3.locator('[data-panel="acct-preview"]').count() === 0);
  const w = await p3.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  check('…and nothing scrolls sideways at 390px (Arkiv)', w[0] <= w[1], w.join('>'));
  await c3.close();
  noErrorsSoFar('Someone who manages nothing');
});

/* ── the shell's own sideways scroll, printed rather than hidden ───────── */
if (shellWide.length) {
  console.log(`\n  note: the shell scrolls sideways on ${shellWide.length} address(es), exactly as far as on #policy — not these pages: ${[...new Set(shellWide.map((x) => x.replace(/^#\S+ /, '')))].join('; ')}`);
  if (STRICT) check('ACCESS_PAGES_STRICT: the document never scrolls sideways', false, shellWide.slice(0, 6).join(' · '));
}

/* ── the shell's refusals, printed rather than hidden ───────────────────── */
const byUrl = new Map();
for (const s of shell) {
  const u = s.url;
  const why = [...refused.entries()].find(([k]) => new URL(k).pathname === u)?.[1]?.code || '';
  byUrl.set(u, `${s.status}${why ? ` ${why}` : ''}`);
}
if (byUrl.size) {
  const list = [...byUrl.entries()].map(([u, w]) => `${u} (${w})`).join(', ');
  console.log(`\n  note: the shell around these pages (app.js) had ${shell.length} request(s) refused, which is not these pages: ${list}`);
  const unexplained = [...byUrl.values()].filter((w) => !/withheld|undeclared|fleet_scope|signin|preview/.test(w));
  check('every shell refusal is the access layer’s own (withheld, undeclared, previewing)', unexplained.length === 0, unexplained.join(', '));
  if (STRICT) check('ACCESS_PAGES_STRICT: no shell refusal at all', false, list);
}

console.log(`\n${pass} passed, ${fail} failed`);
await finish(fail ? 1 : 0);
