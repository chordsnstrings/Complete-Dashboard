/* Destinations are environment-only (system audit 2026-11-12, CRIT 1).
   ─────────────────────────────────────────────────────────────────────────
   PUT /api/settings stored any key, get() preferred a stored value to the
   environment, and auth/uber.js then POSTed the fleet's client id and secret
   to whatever UBER_TOKEN_URL said; with sign-in optional and ADMIN_TOKEN
   unset, anyone could redirect it. src/settings.js ENV_ONLY_KEYS now keeps
   every destination in the environment. This file proves each half:

     1. the rule covers the ten destinations of 2026-11-12 and nothing else;
     2. get() ignores a stored copy of a destination, and only of one;
     3. setSetting() refuses one without touching the database;
     4. PUT /api/settings refuses the whole save, writing nothing, and a
        plain save still goes through;
     5. the paste box's Apply refuses one a recogniser named, writing nothing;
     6. the Settings page renders one read-only with the reason, outside the
        save's collector.

   REVERSIONS (each was made, and each failed the checks named):
     · get() reading the stored copy again          → "get() ignores…"
     · the setSetting() guard removed               → "setSetting() refuses…"
     · the PUT refusal removed                      → "PUT refuses…", "…nothing written"
     · the paste single-key refusal removed         → "the paste box…"
     · app.js rendering every row with data-k       → "read-only…"           */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { ENV_ONLY_KEYS, envOnlyReason, get, loadSettings, setSetting } from '../src/settings.js';

let pass = 0; let fail = 0;
const check = (name, ok, info = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name} ${info}`); }
};

console.log('\n1. the rule');
{
  const want = ['AGENT_BASE_URL', 'HOTEL_BASE', 'HOTEL_EGARI_BASE', 'NTFY_URL', 'REPORT_MODEL_BASE_URL',
    'SMSALA_BASE', 'TESLA_TOKEN_HOST', 'UBER_ORGS_URL', 'UBER_TOKEN_URL', 'YOCHARGE_HOST'];
  check('the ten destinations of 2026-11-12, and nothing else', [...ENV_ONLY_KEYS].sort().join() === want.join(),
    [...ENV_ONLY_KEYS].sort().join());
  check('a credential is not a destination', !ENV_ONLY_KEYS.has('UBER_WEB_COOKIE') && !ENV_ONLY_KEYS.has('BOLT_REFRESH_TOKEN'));
  check('the reason names the key and says where it is set',
    /UBER_TOKEN_URL/.test(envOnlyReason('UBER_TOKEN_URL')) && /DigitalOcean/.test(envOnlyReason('UBER_TOKEN_URL'))
      && envOnlyReason('BACKFILL_MONTHS') === null);
}

console.log('\n2. get() and a stored copy');
{
  delete process.env.UBER_TOKEN_URL; delete process.env.BACKFILL_MONTHS;
  const fake = { query: async () => ({ rows: [
    { key: 'UBER_TOKEN_URL', value: 'https://attacker.example/token', is_secret: false, version: '1' },
    { key: 'BACKFILL_MONTHS', value: '7', is_secret: false, version: '1' },
  ] }) };
  await loadSettings(true, fake);
  check('get() ignores a stored copy of a destination', get('UBER_TOKEN_URL', 'the default') === 'the default',
    get('UBER_TOKEN_URL', 'the default'));
  process.env.UBER_TOKEN_URL = 'https://login.example/oauth/v2/token';
  check('…and reads the environment for it', get('UBER_TOKEN_URL', 'the default') === process.env.UBER_TOKEN_URL);
  delete process.env.UBER_TOKEN_URL;
  check('…while any other key still reads its stored value', get('BACKFILL_MONTHS', '3') === '7');
}

console.log('\n3. setSetting()');
{
  let queried = 0;
  const fake = { query: async () => { queried += 1; return { rows: [] }; } };
  let err = null;
  try { await setSetting('AGENT_BASE_URL', 'https://attacker.example/v3', fake); } catch (e) { err = e; }
  check('setSetting() refuses a destination, with the reason', err?.code === 'env_only' && /AGENT_BASE_URL/.test(err?.message),
    String(err));
  check('…without touching the database', queried === 0, String(queried));
}

console.log('\n4. PUT /api/settings');
const pg = new PGlite();
await applySchema(pg);
const db = { query: (t, p) => pg.query(t, p) };
const written = [];
const { server, port } = await mountAll(db, {
  inject: {
    setSetting: async (k) => { written.push(k); },
    recordSaved: async () => [],
    recognise: () => [{ key: 'NTFY_URL', value: 'https://attacker.example/topic', source: 'recognised' }],
    checkAll: async (cands) => cands.map((c) => ({ ...c, verdict: 'pass', detail: 'the stub provider accepted it' })),
    proposeKeys: async () => [],
  },
});
const base = `http://127.0.0.1:${port}`;
const put = async (body) => {
  const r = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
{
  const one = await put({ UBER_TOKEN_URL: 'https://attacker.example/token' });
  check('PUT refuses a destination with the reason', one.status === 400 && one.json.error === 'env_only'
    && /UBER_TOKEN_URL/.test(one.json.detail), JSON.stringify(one));
  const mixed = await put({ BACKFILL_MONTHS: '6', AGENT_BASE_URL: 'https://attacker.example/v3' });
  check('…the whole save, with nothing written', mixed.status === 400 && written.length === 0, `${mixed.status} ${written.join()}`);
  const plain = await put({ BACKFILL_MONTHS: '6' });
  check('a plain save still goes through', plain.status === 200 && written.join() === 'BACKFILL_MONTHS', `${plain.status} ${written.join()}`);
}

console.log('\n5. the paste box');
{
  written.length = 0;
  const r = await fetch(`${base}/api/settings/paste`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'ntfy https://attacker.example/topic', apply: true }) });
  const j = await r.json().catch(() => ({}));
  check('the paste box refuses a destination a recogniser named, writing nothing',
    r.status === 200 && !written.includes('NTFY_URL') && !(j.applied || []).includes('NTFY_URL'),
    `${r.status} written=${written.join()} applied=${JSON.stringify(j.applied)}`);
}
server.close();

console.log('\n6. the Settings page');
{
  const src = readFileSync(new URL('../api/public/app.js', import.meta.url), 'utf8');
  const at = src.indexOf('const box = d.env_only');
  const seg = at >= 0 ? src.slice(at, at + 700) : '';
  const ro = seg.match(/\? `(<input readonly[^`]*)`/);
  check('read-only, carrying the reason, and outside the save (no data-k)',
    Boolean(ro) && !/data-k=/.test(ro[1]) && /env_only_reason/.test(ro[1]), seg.slice(0, 200));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
