#!/usr/bin/env node
/* EVERY ROLE ON EVERY PAGE — the access sweep.
   ─────────────────────────────────────────────────────────────────────────
   The operator's instruction, 2026-09-28: "Don't merge until you test
   everything every role, every page". This drives a real browser through
   every desktop page and every phone screen as each of the fourteen roles
   (and a one-fleet reader, and nobody), against bin/access-gateway.mjs —
   the access layer that will ship, over production's real data, read-only.

   For each (role, page) it records and judges:
     · opened or closed, against the design (api/public/access.js canOpenView
       over the role's levels — the same rule, independently recomputed here);
     · every API answer the page received: status, what the server said it
       withheld, and a LEAK SCAN of the body — any key that names contact
       details, documents, passengers, credentials or raw payloads holding a
       value the role may not see (masked values must carry the bullet);
     · a route answered 200 whose subject class the role does not hold;
     · page errors and console errors (a 403 the page expected is not one);
     · "undefined", "NaN", "[object Object]" in the rendered text;
     · a withheld answer with no reason on the page.
   Writes a JSON report and a screenshot of every failing page.

       node bin/access-gateway.mjs &          (PORT 8500)
       node bin/access-sweep.mjs --roles all --ui both --out /tmp/sweep */
import pg from 'pg';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:8500');
const OUT = arg('out', '/tmp/access-sweep');
const UI = arg('ui', 'both');
const CONC = Number(arg('conc', '3'));
const ONLY = arg('pages', '');
/* Arkiv is the desktop default; --skin classic sweeps the look a person may switch to. */
const SKIN = arg('skin', 'arkiv');
mkdirSync(OUT, { recursive: true });

const { ROLES, ROLE, CLASS_CODES, rank } = await import('../api/public/access_model.js');
const { hashPassword } = await import('../api/access/crypto.js');
const { tokenHash, newToken } = await import('../api/access/crypto.js');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://fleet@127.0.0.1:55432/fleet_sweep' });
const q = (t, p) => pool.query(t, p).then((r) => r.rows);

/* ── the people ──────────────────────────────────────────────────────── */
const PASS = 'sweep password for every role';
const WHO = [
  ...ROLES.filter((r) => !r.device).map((r) => ({ key: r.code, role: r.code, fleets: null })),
  { key: 'OPS@egari', role: 'OPS', fleets: ['egari'] },
  { key: 'WALL', role: 'WALL', device: true },
  { key: 'ANON', anon: true },
];
const wanted = arg('roles', 'all');
const people = wanted === 'all' ? WHO : WHO.filter((w) => wanted.split(',').includes(w.key));

async function setup() {
  await q(`INSERT INTO access_config (key, value) VALUES ('mfa', '"none"'), ('mode', '"enforced"')
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
  const hash = hashPassword(PASS);
  for (const w of people) {
    if (w.anon) continue;
    if (w.device) {
      const token = newToken();
      await q(`DELETE FROM access_device WHERE name = 'sweep wall'`);
      await q(`INSERT INTO access_device (name, role_code, token_hash) VALUES ('sweep wall', 'WALL', $1)`, [tokenHash(token)]);
      w.token = token;
      continue;
    }
    const email = `${w.key.toLowerCase().replace(/[^a-z0-9]/g, '-')}@sweep.test`;
    w.email = email;
    const [u] = await q(
      `INSERT INTO access_user (email, email_norm, name, status, password_hash, password_changed_at)
       VALUES ($1, $1, $2, 'active', $3, now())
       ON CONFLICT (email_norm) DO UPDATE SET password_hash = EXCLUDED.password_hash, status = 'active',
         must_change_password = false, failed_logins = 0, locked_until = NULL
       RETURNING id`, [email, `Sweep ${w.key}`, hash]);
    await q(`UPDATE access_grant SET status = 'revoked' WHERE user_id = $1`, [u.id]);
    await q(`INSERT INTO access_grant (user_id, role_code, fleets, status, reason) VALUES ($1, $2, $3, 'active', 'sweep')`,
      [u.id, w.role, w.fleets]);
  }
}

async function cookiesFor(w) {
  if (w.anon) return [];
  const host = new URL(BASE).hostname;
  if (w.device) return [{ name: 'fm_dev', value: w.token, domain: host, path: '/' }];
  const r = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: w.email, password: PASS }) });
  const j = await r.json();
  if (!j.ok) throw new Error(`${w.key} could not sign in: ${JSON.stringify(j)}`);
  return (r.headers.getSetCookie?.() || []).map((c) => {
    const [kv] = c.split(';'); const i = kv.indexOf('=');
    return { name: kv.slice(0, i), value: decodeURIComponent(kv.slice(i + 1)), domain: host, path: '/' };
  });
}

/* ── the pages ───────────────────────────────────────────────────────── */
const appSrc = readFileSync(new URL('../api/public/app.js', import.meta.url), 'utf8');
const VIEW_IDS = [...appSrc.slice(appSrc.indexOf('const VIEWS = ['), appSrc.indexOf('const SECTIONS = ['))
  .matchAll(/\{ id: '([a-z-]+)'/g)].map((m) => m[1]);
const EXTRA = ['account', 'access', 'access/teams', 'access/roles', 'access/requests', 'access/audit', 'access/settings',
  'approvals', 'fleet-names', 'settings', 'coverage', 'providers', 'identity', 'same-person', 'hr-roster', 'policy',
  'deposits', 'advances', 'salary', 'opening', 'charging', 'import-sheet', 'feeds', 'map', 'live', 'segments', 'unauthorized',
  'platforms/tiers', 'platforms/funnel', 'settlement/cash', 'settlement/receivables', 'corporate/guests',
  'corporate/properties', 'corporate/leakage', 'unit/assets', 'unit/drivers', 'roster/pipeline', 'roster/idle', 'roster/blocked',
  'analyst/rules', 'insights/severity/critical', 'safety/vehicles', 'safety/events'];
const COHORTS = ['unit-drove-unpaid', 'unit-idle-documented', 'vehicles-still', 'roster-idle', 'retention-stopped',
  'safety-drivers', 'settlement-cash'];
const DRIVER_TABS = ['', 'activity', 'territory', 'earnings', 'quality', 'record', 'money', 'trips', 'unauthorized'];
const VEHICLE_TABS = ['', 'drivers', 'movement', 'earnings', 'safety', 'compliance', 'trips'];
const PHONE = ['today', 'money', 'people', 'fleet', 'live', 'safety', 'unauthorized', 'sources', 'trips', 'more',
  'payouts', 'corporate', 'analyst', 'optimise', 'credentials', 'deposits', 'online-time', 'account'];

/* Real addresses for the detail pages, crawled as the Owner. */
async function discover(browser, ownerCookies) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies(ownerCookies);
  const page = await ctx.newPage();
  const firstLink = async (route, prefix) => {
    await page.goto(`${BASE}/?ui=desktop&skin=${SKIN}#${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((p) => document.querySelector(`#view a[href^="#${p}"]`), prefix, { timeout: 120_000 }).catch(() => {});
    return page.evaluate((p) => document.querySelector(`#view a[href^="#${p}"]`)?.getAttribute('href')?.slice(1).split('?')[0] || null, prefix);
  };
  const found = {
    driver: await firstLink('drivers', 'driver/'),
    vehicle: await firstLink('vehicles', 'vehicle/'),
    trip: await firstLink('trips', 'trip/'),
    property: await firstLink('corporate/properties', 'property/'),
    segment: await firstLink('segments', 'segment/'),
    performer: await firstLink('top-performers', 'performer/'),
    action: await firstLink('insights', 'action/'),
    day: await firstLink('demand', 'day/'),
  };
  await ctx.close();
  return found;
}

function desktopRoutes(found) {
  const routes = [...new Set([...VIEW_IDS, ...EXTRA])];
  const base = (r) => (r || '').split('/').slice(0, 2).join('/');
  if (found.driver) for (const t of DRIVER_TABS) routes.push(t ? `${base(found.driver)}/${t}` : base(found.driver));
  if (found.vehicle) for (const t of VEHICLE_TABS) routes.push(t ? `${base(found.vehicle)}/${t}` : base(found.vehicle));
  for (const k of ['trip', 'property', 'segment', 'performer', 'action', 'day']) if (found[k]) routes.push(found[k]);
  if (found.property) routes.push(`${base(found.property)}/guests`, `${base(found.property)}/drivers`);
  for (const c of COHORTS) routes.push(`cohort/${c}`);
  routes.push('compare', 'slot/1/9');
  return ONLY ? routes.filter((r) => ONLY.split(',').some((p) => r.startsWith(p))) : routes;
}

/* ── judging one page ────────────────────────────────────────────────── */
const DICT = (await import('../api/access/shape.js')).DICT;
const DICT_KEYS = new Map(Object.entries(DICT).flatMap(([c, ks]) => ks.map((k) => [k, c])));
function leaks(body, levels, fleets = null) {
  const out = [];
  const walk = (v, path, depth) => {
    if (v == null || typeof v !== 'object' || depth > 30) return;
    if (Array.isArray(v)) { v.slice(0, 400).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1)); return; }
    for (const [k, x] of Object.entries(v)) {
      /* A one-fleet reader must never receive another fleet's rows. */
      if (fleets && (k === 'fleet_id' || k === 'fleet') && typeof x === 'string' && x && !fleets.includes(x)) {
        out.push(`${path}.${k} = ${x} (a fleet outside the reader's scope)`);
      }
      const cls = DICT_KEYS.get(k.toLowerCase());
      if (cls && x != null && x !== '' && !(Array.isArray(x) && !x.length) && x !== false && x !== true) {
        const l = levels[cls] || '';
        const masked = typeof x === 'string' && x.includes('•');
        if (l === '' || l === 'A' || (l === 'M' && !masked)) out.push(`${path}.${k} (${cls}, role ${l || 'none'})`);
      }
      walk(x, `${path}.${k}`, depth + 1);
    }
  };
  walk(body, '$', 0);
  return out.slice(0, 20);
}

const levelsOf = (w, fleetsAll) => {
  if (w.anon) return {};
  const role = ROLE[w.role];
  return role.levels;
};
const canOpen = async (page, route, phone) => page.evaluate(async ([r, ph]) => {
  const m = await import('/access.js');
  const d = await import('/data.js');
  const h = d.parseHash(r);
  return m.canOpenView(h.view, h.sub || '', h.param || '', { phone: ph });
}, [route, phone]);

async function visit(ctx, w, route, phone) {
  const started = Date.now();
  const page = await ctx.newPage();
  const res = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/status of 40[13]|Failed to load resource/.test(t)) return;
    errors.push(`console: ${t.slice(0, 200)}`);
  });
  page.on('response', async (r) => {
    const u = new URL(r.url());
    if (!u.pathname.startsWith('/api/')) return;
    const item = { path: `${u.pathname}${u.search}`.slice(0, 200), status: r.status(), withheld: r.headers()['x-fm-withheld'] || null };
    try {
      if ((r.headers()['content-type'] || '').includes('json')) {
        const body = await r.json();
        /* /api/auth/* answers about the reader themself (their own email),
           and /api/access/* decides for itself who may read it — both are
           proved in test/access_core.test.mjs, not by this key scan, which
           would call a person's own address a leak of drivers' contacts. */
        item.leaks = /^\/api\/(auth|access)\//.test(u.pathname) ? [] : leaks(body, w.levels, w.fleets);
        if (r.status() === 403) item.reason = body?.detail || null;
      }
    } catch { /* body unavailable */ }
    res.push(item);
  });
  const url = `${BASE}/?ui=${phone ? 'phone' : 'desktop'}&skin=${SKIN}#${route}`;
  let nav = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    /* The phone build draws into #m; the desktop's #view is still in the
       page, empty, and reading it called every phone screen blank. */
    await page.waitForFunction((ph) => {
      if (location.pathname === '/signin') return true;
      const v = ph ? document.querySelector('#m') : document.querySelector('#view');
      return v && v.innerText.trim().length > 40 && !v.querySelector('.skel, .m-skel, .loading');
    }, phone, { timeout: 120_000, polling: 500 }).catch(() => {});
    await page.waitForTimeout(1200);
    nav = await page.evaluate((ph) => {
      const v = ph ? document.querySelector('#m') : document.querySelector('#view');
      const text = v ? v.innerText : '';
      return {
        path: location.pathname,
        closed: Boolean(document.querySelector('.access-closed')),
        closedText: document.querySelector('.access-closed')?.innerText.slice(0, 300) || null,
        banner: document.querySelector('.access-withheld')?.innerText.slice(0, 300) || null,
        bad: ['undefined', 'NaN', '[object Object]'].filter((s) => new RegExp(`(^|\\W)${s.replace(/[[\]]/g, '\\$&')}(\\W|$)`).test(text)),
        len: text.length,
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    }, phone);
  } catch (e) { errors.push(`navigation: ${String(e).slice(0, 200)}`); }
  let expectOpen = null;
  if (!w.anon && nav && nav.path !== '/signin') { try { expectOpen = await canOpen(page, route, phone); } catch { /* module not reachable */ } }
  const problems = [];
  if (w.anon) {
    if (nav?.path !== '/signin') problems.push('an anonymous reader was not sent to sign in (sign-in is required)');
    if (res.some((x) => x.status === 200 && !/^\/api\/(health|auth\/me)/.test(x.path))) problems.push(`anonymous got data: ${res.filter((x) => x.status === 200).map((x) => x.path).slice(0, 3).join(', ')}`);
  } else {
    if (nav?.path === '/signin') problems.push('a signed-in reader was sent to the sign-in page');
    if (expectOpen === true && nav?.closed) problems.push(`closed, but the role should open it: ${nav.closedText}`);
    if (expectOpen === false && nav && !nav.closed) problems.push('opened, but the role should not open it');
    for (const x of res) {
      if (x.leaks?.length) problems.push(`LEAK in ${x.path}: ${x.leaks.join('; ')}`);
      if (x.status === 403 && !x.reason) problems.push(`403 without a reason: ${x.path}`);
      if (x.status >= 500) problems.push(`${x.status} from ${x.path}`);
    }
    if (nav?.bad?.length) problems.push(`rendered ${nav.bad.join(', ')}`);
    if (nav && nav.overflow > 2) problems.push(`scrolls sideways by ${nav.overflow}px`);
    if (nav && !nav.closed && nav.len < 40) problems.push('rendered nearly nothing');
  }
  problems.push(...errors);
  const rec = { who: w.key, ui: phone ? 'phone' : 'desktop', route, ms: Date.now() - started, expectOpen, closed: nav?.closed ?? null,
    banner: nav?.banner || null, api: res, problems };
  if (problems.length) {
    const name = `${w.key}-${phone ? 'm' : 'd'}-${route}`.replace(/[^a-zA-Z0-9@-]+/g, '_').slice(0, 120);
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false }).catch(() => {});
  }
  await page.close();
  return rec;
}

/* ── run ─────────────────────────────────────────────────────────────── */
await setup();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const owner = WHO.find((w) => w.key === 'OWN');
if (!owner.email) { owner.email = 'own@sweep.test'; }
const found = await discover(browser, await cookiesFor(owner));
console.log('detail pages found:', JSON.stringify(found));
const desk = desktopRoutes(found);
const phoneRoutes = ONLY ? PHONE.filter((r) => ONLY.split(',').some((p) => r.startsWith(p))) : PHONE;
const report = [];
let done = 0;
const total = people.length * ((UI !== 'phone' ? desk.length : 0) + (UI !== 'desktop' ? phoneRoutes.length : 0));
async function runPerson(w) {
  w.levels = levelsOf(w);
  const cookies = await cookiesFor(w);
  for (const phone of [false, true]) {
    if ((phone && UI === 'desktop') || (!phone && UI === 'phone')) continue;
    const ctx = await browser.newContext(phone
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 } });
    await ctx.addCookies(cookies);
    for (const route of phone ? phoneRoutes : desk) {
      const rec = await visit(ctx, w, route, phone);
      report.push(rec);
      done += 1;
      if (rec.problems.length) console.log(`✗ ${w.key} ${rec.ui} #${route}: ${rec.problems.slice(0, 3).join(' | ')}`);
      if (done % 50 === 0) {
        console.log(`… ${done}/${total}`);
        writeFileSync(join(OUT, 'report.partial.json'), JSON.stringify(report));
      }
    }
    await ctx.close();
  }
}
const queue = [...people];
await Promise.all(Array.from({ length: Math.min(CONC, queue.length) }, async () => {
  while (queue.length) await runPerson(queue.shift());
}));
await browser.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
const bad = report.filter((r) => r.problems.length);
const leaksFound = report.flatMap((r) => r.problems.filter((p) => p.startsWith('LEAK')));
console.log(`\n${report.length} page visits, ${bad.length} with problems, ${leaksFound.length} leak findings. Report: ${join(OUT, 'report.json')}`);
await pool.end();
process.exit(bad.length ? 1 : 0);
