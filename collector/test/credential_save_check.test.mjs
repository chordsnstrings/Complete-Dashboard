/* ── a saved credential is tested on save, and nothing older paints over it ──
   Measured on production 2026-09-23. UBER_WEB_COOKIE_EGARI was saved on the
   Settings page at 08:30:22Z. A collector run had loaded its settings at
   08:30:00Z; at 08:31:28Z it asked Uber with the cookie it held, the OLD one,
   and recorded "redirected to auth.uber.com — the session is no longer signed
   in". The banner showed the saved cookie as stopped. It was not: production's
   paste check passed the same capture at 08:40:51Z, and a report request made
   with the stored value answered "accepted" at 08:41:07Z.

   Nothing tested the saved value until the collector's next run, and when the
   in-flight run did report, its verdict was about the value before. These
   tests hold down both halves of the fix:

     1. noteCredential writes a row only when the value it used is the one
        stored now (schema_v82's value_version);
     2. a save tests what it stored and writes the verdict onto the banner rows
        (api/save_check.js), on the PUT route and on the paste box's Apply;
     3. /api/auth reads a row about a replaced value as pending, never as the
        current state, and scores 'saved' as pending rather than red or amber.

   No provider is contacted: every check here is a stub, and no value below is
   a credential. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { noteCredential } from '../src/auth_state.js';
import { SETTING_VERSION_SQL } from '../src/settings.js';
import { recordSaved, stateOf, saveDetail } from '../api/save_check.js';
import { checkStored } from '../src/credcheck.js';
import { authRoutes } from '../api/auth_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

const KEY = 'UBER_WEB_COOKIE_EGARI';
/* The setting row. app_setting.value is never read here, so it holds a label
   rather than anything shaped like a cookie. */
const save = async (key, at) => {
  await q(`INSERT INTO app_setting (key, value, is_secret, updated_at) VALUES ($1, 'not-a-credential', true, $2)
           ON CONFLICT (key) DO UPDATE SET updated_at = EXCLUDED.updated_at`, [key, at]);
  return (await q(`SELECT (${SETTING_VERSION_SQL})::text AS v FROM app_setting WHERE key = $1`, [key]))[0].v;
};
const row = async (provider, fleet, key = KEY) => (await q(
  `SELECT state, detail, value_version::text AS value_version, last_ok_at, checked_at
     FROM credential_state WHERE provider = $1 AND fleet_id = $2 AND credential = $3`,
  [provider, fleet, key]))[0];

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res))
  .catch((e) => res.status(500).json({ error: String(e) }));
const authApp = express();
authRoutes(authApp, { q, wrap });
const authSrv = authApp.listen(0);
await new Promise((r) => authSrv.once('listening', r));
const auth = async () => (await fetch(`http://127.0.0.1:${authSrv.address().port}/api/auth`)).json();

/* ══ 1. the version guard ═══════════════════════════════════════════════ */
console.log('\nan observation is written only about the value stored now');
{
  const v1 = await save(KEY, '2026-09-23T07:00:00.123456Z');
  check('the version keeps whole microseconds, which a JS Date would lose',
    /456$/.test(v1), v1);

  await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: KEY,
    state: 'ok', surface: 'reports', version: v1 });
  let r = await row('uber', 'egari');
  check('an observation made with the stored version is written', r?.state === 'ok', JSON.stringify(r));
  check('…and carries that version', r?.value_version === v1, `${r?.value_version} vs ${v1}`);

  /* The save: a newer value, and the process still holding the old one. */
  const v2 = await save(KEY, '2026-09-23T08:30:22.622000Z');
  await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: KEY,
    state: 'expired', detail: 'redirected to auth.uber.com — the session is no longer signed in',
    version: v1 });
  r = await row('uber', 'egari');
  check('an observation made with a REPLACED value is dropped', r?.state === 'ok',
    `${r?.state}: ${r?.detail}`);

  /* A process that has not loaded the stored value at all holds the
     environment's, or nothing — not what the Settings page saved. */
  await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: KEY,
    state: 'expired', detail: 'from a process that never loaded the saved value', version: null });
  r = await row('uber', 'egari');
  check('…and so is one made by a process that never loaded the saved value', r?.state === 'ok',
    `${r?.state}: ${r?.detail}`);

  await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: KEY,
    state: 'expired', detail: 'the new value, refused', version: v2 });
  r = await row('uber', 'egari');
  check('an observation made with the new value is written, failures included',
    r?.state === 'expired' && r?.value_version === v2, JSON.stringify(r));

  /* A credential the Settings page has never held: environment only. */
  await noteCredential(db, { provider: 'fms', fleet: 'ecosine', credential: 'FMS_PASSWORD',
    state: 'ok', version: null });
  check('a credential with no saved value records as before',
    (await row('fms', 'ecosine', 'FMS_PASSWORD'))?.state === 'ok');
  /* The default version is this process's own, which in a test process that
     loaded nothing is null — so an env-only credential needs no argument. */
  await noteCredential(db, { provider: 'fms', fleet: 'egari', credential: 'FMS_PASSWORD', state: 'ok' });
  check('…and needs no version argument to do so',
    (await row('fms', 'egari', 'FMS_PASSWORD'))?.state === 'ok');
}

/* ══ 2. the day itself, replayed ════════════════════════════════════════ */
console.log('\nthe 2026-09-23 sequence: save, stale refusal, next run');
{
  await q(`DELETE FROM credential_state`);
  const before = await save(KEY, '2026-09-23T07:31:38Z');
  for (const provider of ['uber', 'uber_fleet', 'uber_profile']) {
    await noteCredential(db, { provider, fleet: 'egari', credential: KEY, state: 'expired',
      detail: '403 from fleethub.uber.com — forbidden by authentication server', version: before });
  }
  check('before the save the banner is red for the cookie',
    (await auth()).rows.filter((x) => x.credential === KEY && x.severity === 'stopped').length === 3);

  const saved = await save(KEY, '2026-09-23T08:30:22.622Z');
  const asked = [];
  const out = await recordSaved(db, [KEY], {
    check: async (key, { fleet }) => {
      asked.push(`${key}|${fleet}`);
      return { key, fleet, verdict: 'pass',
        detail: 'the supplier API accepted this session for org b200… (a stub)' };
    },
    store: async () => { throw new Error('nothing should be stored'); },
    reload: async () => {},
  });
  check('the saved value is tested ONCE for its three banner rows, not once per row',
    asked.length === 1 && asked[0] === `${KEY}|egari`, asked.join(', '));
  check('…and the verdict lands on all three', out[0]?.rows === 3, JSON.stringify(out));
  const r = await row('uber_fleet', 'egari');
  check('a passing save turns the rows ok', r?.state === 'ok', r?.state);
  check('…stamped with the version now stored', r?.value_version === saved, `${r?.value_version} vs ${saved}`);
  check('…with words that say the verdict came from the save',
    /^accepted when saved — /.test(r?.detail || ''), r?.detail);
  check('…and last_ok_at moves, because the credential did just authenticate',
    r?.last_ok_at && Date.now() - Date.parse(r.last_ok_at) < 60_000);

  /* 08:31:28Z: the run that loaded settings at 08:30:00Z reports. */
  await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: KEY, state: 'expired',
    detail: 'redirected to auth.uber.com — the session is no longer signed in', version: before });
  const d = await auth();
  check('the in-flight run’s refusal of the OLD cookie no longer paints the new one red',
    !d.rows.some((x) => x.credential === KEY && x.severity === 'stopped'),
    JSON.stringify(d.rows.filter((x) => x.credential === KEY).map((x) => [x.provider, x.state, x.severity])));
  check('…and the banner has nothing to say about it at all', d.stopped === 0 && d.pending === 0,
    `stopped ${d.stopped}, pending ${d.pending}`);

  /* 09:01Z: the next run, with the new cookie loaded. */
  await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: KEY, state: 'ok',
    surface: 'reports', version: saved });
  check('the next run, holding the new value, writes over the save verdict',
    !/accepted when saved/.test((await row('uber', 'egari'))?.detail || '')
    && (await row('uber', 'egari'))?.state === 'ok');
}

/* ══ 3. every verdict, and what the banner makes of it ══════════════════ */
console.log('\neach save verdict becomes the state the banner already understands');
{
  /* A check answers "should this be stored?"; the banner asks "what is true of
     this credential?". The translation is by what the check ESTABLISHED. */
  const cases = [
    ['a pass', { verdict: 'pass', detail: 'stub pass' }, 'ok', 'ok', /^accepted when saved — stub pass$/],
    ['a refusal of this credential', { verdict: 'fail', detail: 'stub refused' }, 'invalid', 'stopped',
      /^refused when saved — stub refused$/],
    /* The Yango portal refusing the park with or without a session: the check
       itself says the cookie is not what is being refused. */
    ['a refusal that is not about this credential', { verdict: 'fail', blames: 'other', detail: 'not the cookie' },
      'saved', 'pending', /^saved, not tested — not the cookie; each surface tests it the next time it runs$/],
    /* The session was read and something else refused the request; the
       collector records YANGO_COOKIE ok on the same evidence. */
    ['a session that authenticates and is refused for something else',
      { verdict: 'unknown', authenticates: true, detail: 'the session authenticates' }, 'ok', 'ok',
      /^accepted when saved — the session authenticates$/],
    ['a provider that could not be reached', { verdict: 'unknown', detail: 'could not be reached' },
      'saved', 'pending', /^saved, not tested — could not be reached/],
    ['a key with no live check', { verdict: 'untested', detail: 'no live check exists for FMS_PASSWORD' },
      'saved', 'pending', /^saved, not tested — no live check exists/],
  ];
  let i = 0;
  for (const [what, v, state, severity, words] of cases) {
    check(`${what} → ${state}`, stateOf(v) === state, stateOf(v));
    await q(`DELETE FROM credential_state`);
    const ver = await save('FMS_PASSWORD', `2026-09-23T09:0${i++}:00Z`);
    await noteCredential(db, { provider: 'fms', fleet: 'ecosine', credential: 'FMS_PASSWORD',
      state: 'expired', detail: 'the old password', version: ver });
    await recordSaved(db, ['FMS_PASSWORD'], { check: async () => v, reload: async () => {} });
    const r = await row('fms', 'ecosine', 'FMS_PASSWORD');
    const a = (await auth()).rows.find((x) => x.credential === 'FMS_PASSWORD');
    check(`…written as ${state}`, r?.state === state, r?.state);
    check(`…scored ${severity} by /api/auth`, a?.severity === severity, a?.severity);
    check('…in words that name the save', words.test(r?.detail || ''), r?.detail);
  }
  check('nothing a save writes is amber: an untested value is quiet, not "at risk"',
    cases.every(([, v]) => ['ok', 'invalid', 'saved'].includes(stateOf(v))));
  check('a detail is kept inside the column\u2019s 240 characters',
    saveDetail({ verdict: 'fail', detail: 'x'.repeat(400) }).length === 240);
}

/* ══ 4. what the recorder leaves alone ══════════════════════════════════ */
console.log('\nthe recorder touches only what the banner already shows');
{
  await q(`DELETE FROM credential_state`);
  let called = 0;
  const out = await recordSaved(db, ['CHARGING_SITES'], {
    check: async () => { called++; return { verdict: 'pass' }; }, reload: async () => {} });
  check('a key with no banner rows is not tested at all', called === 0 && out.length === 0,
    `called ${called}, out ${JSON.stringify(out)}`);
  check('…and no row is invented for it',
    (await q(`SELECT count(*)::int AS n FROM credential_state`))[0].n === 0);

  /* The paste box has already tested what it stores. */
  await noteCredential(db, { provider: 'yango', fleet: 'ecosine', credential: 'YANGO_COOKIE',
    state: 'expired', detail: 'old', version: null });
  called = 0;
  await recordSaved(db, ['YANGO_COOKIE'], {
    known: new Map([['YANGO_COOKIE', { verdict: 'pass', detail: 'the stub park answered' }]]),
    check: async () => { called++; return { verdict: 'fail' }; }, reload: async () => {} });
  check('a verdict the caller already has is used, not re-tested', called === 0, `called ${called}`);
  check('…and written', (await row('yango', 'ecosine', 'YANGO_COOKIE'))?.state === 'ok');
  await recordSaved(db, ['YANGO_COOKIE'], {
    known: new Map([['YANGO_COOKIE', { verdict: 'unknown', untested: true, detail: 'no live check' }]]),
    reload: async () => {} });
  check('a labelled key with no check comes through as untested, not unreachable',
    (await row('yango', 'ecosine', 'YANGO_COOKIE'))?.state === 'saved',
    (await row('yango', 'ecosine', 'YANGO_COOKIE'))?.state);

  /* A Bolt token under the unsuffixed key serves whichever fleet has none of
     its own, and its check needs the company — so one test per fleet. */
  await q(`DELETE FROM credential_state`);
  for (const f of ['ecosine', 'egari']) {
    await noteCredential(db, { provider: 'bolt', fleet: f, credential: 'BOLT_REFRESH_TOKEN',
      state: 'expired', version: null });
  }
  const fleets = [];
  await recordSaved(db, ['BOLT_REFRESH_TOKEN'], {
    check: async (_k, { fleet }) => { fleets.push(fleet); return { verdict: fleet === 'egari' ? 'pass' : 'fail' }; },
    reload: async () => {} });
  check('an unsuffixed Bolt token is tested once per fleet it serves',
    fleets.sort().join(',') === 'ecosine,egari', fleets.join(','));
  check('…and each fleet gets its own verdict',
    (await row('bolt', 'egari', 'BOLT_REFRESH_TOKEN'))?.state === 'ok'
    && (await row('bolt', 'ecosine', 'BOLT_REFRESH_TOKEN'))?.state === 'invalid');

  /* A successor, if a provider ever hands one back, is stored before the
     verdict — the check spent the value that was saved. */
  const stored = [];
  let reloaded = 0;
  await recordSaved(db, ['BOLT_REFRESH_TOKEN'], {
    check: async () => ({ verdict: 'pass', keys: { BOLT_REFRESH_TOKEN: 'a-successor-label' } }),
    store: async (k, v) => { stored.push(`${k}=${v}`); }, reload: async () => { reloaded++; } });
  check('a successor credential is stored', stored.includes('BOLT_REFRESH_TOKEN=a-successor-label'),
    stored.join(', '));
  check('…and settings reloaded after it', reloaded >= 1);

  const out2 = await recordSaved(db, ['BOLT_REFRESH_TOKEN'], {
    check: async () => { throw new Error('the stub provider fell over'); }, reload: async () => {} });
  check('a check that throws is reported, and the save is not failed by it',
    out2.length && out2.every((o) => o.verdict === 'error' && /fell over/.test(o.detail)),
    JSON.stringify(out2));
}

/* ══ 5. /api/auth: a row about a replaced value is not the current state ═ */
console.log('\na row observed with a replaced value reads as pending');
{
  await q(`DELETE FROM credential_state`);
  await q(`DELETE FROM app_setting`);
  const old = await save(KEY, '2026-09-23T07:00:00Z');
  await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: KEY, state: 'expired',
    detail: 'redirected to auth.uber.com — the session is no longer signed in', version: old });
  check('with the value unchanged, a refusal is stopped',
    (await auth()).rows.find((x) => x.credential === KEY)?.severity === 'stopped');

  /* Saved by a route that did not re-test (a save before schema_v82, or a
     re-test that failed): the row's version is no longer the stored one. */
  await save(KEY, '2026-09-23T08:30:22.622Z');
  const d = await auth();
  const a = d.rows.find((x) => x.credential === KEY);
  check('once the value is replaced, the same row is pending', a?.severity === 'pending', a?.severity);
  check('…flagged as about the earlier value', a?.superseded === true);
  check('…saying so, instead of the old refusal', /^replaced since this was last checked/.test(a?.detail || ''),
    a?.detail);
  check('…with the old words kept under their own name',
    a?.observed_state === 'expired' && /auth\.uber\.com/.test(a?.observed_detail || ''));
  check('…and the save time for the banner to print', a?.saved_at && Date.parse(a.saved_at) > 0);
  check('the banner is no longer red for it', d.stopped === 0 && d.pending === 1,
    `stopped ${d.stopped}, pending ${d.pending}`);

  /* A row from before schema_v82 has no version, and is taken at its word
     whichever side of the save it was checked on. Reading "checked before
     the save" as pending was tried: at deploy it would have made the weekly
     profile rows pending for a week over a cookie that was working. */
  await q(`UPDATE credential_state SET value_version = NULL, checked_at = '2026-09-23T08:00:00Z'`);
  check('an unversioned row checked before the save is taken at its word',
    (await auth()).rows.find((x) => x.credential === KEY)?.severity === 'stopped');
  await q(`UPDATE credential_state SET checked_at = '2026-09-23T08:31:28Z'`);
  check('…and so is one checked after it',
    (await auth()).rows.find((x) => x.credential === KEY)?.severity === 'stopped');
}

/* ══ 6. the two save routes call the recorder ═══════════════════════════ */
console.log('\nboth Settings save routes test what they stored');
{
  await q(`DELETE FROM credential_state`);
  await q(`DELETE FROM app_setting`);
  await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: KEY, state: 'expired',
    detail: 'the old cookie', version: null });
  const asked = [];
  const { server, port } = await mountAll(db, {
    inject: {
      recordSaved: (d, keys, o) => recordSaved(d, keys, { ...o,
        check: async (key, { fleet }) => { asked.push(key); return { key, fleet, verdict: 'pass', detail: 'stub' }; } }),
      /* The paste route's own test, before it writes. */
      checkAll: async (cands) => cands.map((c) => ({ ...c, verdict: c.key ? 'pass' : 'fail',
        detail: `the stub provider accepted ${c.key}` })),
      proposeKeys: async () => [],
    },
  });
  const base = `http://127.0.0.1:${port}`;
  const put = await (await fetch(`${base}/api/settings`, { method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [KEY]: 'not-a-credential' }) })).json();
  check('PUT /api/settings tests the key it stored', asked.includes(KEY), asked.join(','));
  check('…answers with the verdict', put.checked?.[0]?.verdict === 'pass', JSON.stringify(put));
  check('…and the banner row is rewritten', (await row('uber', 'egari'))?.state === 'ok',
    (await row('uber', 'egari'))?.state);

  /* The paste box's Apply, with a credential the recogniser names: a Bolt
     portal token is a JWT whose payload carries the fleet owner. Synthetic,
     with a signature that is not a signature. */
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = [b64u({ alg: 'HS256', typ: 'JWT' }),
    b64u({ data: { fleet_owner_id: 174036, jti: 'synthetic' }, exp: Math.floor(Date.now() / 1000) + 86400 }),
    'not-a-signature-this-token-is-synthetic'].join('.');
  await noteCredential(db, { provider: 'bolt', fleet: 'egari', credential: 'BOLT_REFRESH_TOKEN_EGARI',
    state: 'invalid', detail: 'the old token', version: null });
  asked.length = 0;
  const paste = await (await fetch(`${base}/api/settings/paste`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: token, apply: true }) })).json();
  check('the paste box stores the credential it recognised',
    paste.applied?.includes('BOLT_REFRESH_TOKEN_EGARI'), JSON.stringify(paste.applied));
  check('…and writes the banner from the verdict it already had, without a second test',
    asked.length === 0 && (await row('bolt', 'egari', 'BOLT_REFRESH_TOKEN_EGARI'))?.state === 'ok',
    `asked ${asked.join(',')}, state ${(await row('bolt', 'egari', 'BOLT_REFRESH_TOKEN_EGARI'))?.state}`);
  check('…whose words are the provider’s, marked as the save’s',
    /^accepted when saved — the stub provider accepted/.test(
      (await row('bolt', 'egari', 'BOLT_REFRESH_TOKEN_EGARI'))?.detail || ''));
  check('…and says so in its answer', paste.checked?.some((c) => c.key === 'BOLT_REFRESH_TOKEN_EGARI'));

  const dry = await (await fetch(`${base}/api/settings/paste`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: token }) })).json();
  check('a dry run changes no banner row', Array.isArray(dry.checked) && dry.checked.length === 0);
  server.close();
}

/* ══ 7. checkStored: what a save sends the provider ═════════════════════ */
console.log('\nthe stored value is tested the way the collector will use it');
{
  /* Org ids are identifiers, not secrets — the credkit suite uses the same. */
  const ECO_ORG = '58ca3b81-4953-4793-9f56-d93e16f771bb';
  const EGA_ORG = 'b2004b53-8175-4706-ab0a-c8b60e586c7c';
  process.env.UBER_ORG_UUID = ECO_ORG;
  process.env.UBER_ORG_UUID_EGARI = EGA_ORG;
  const sent = [];
  const spy = async (c) => { sent.push(c); return { verdict: 'pass', detail: 'stub' }; };

  check('nothing configured is missing, and nobody is asked',
    (await checkStored(KEY, { value: '', checkWith: spy })).verdict === 'missing' && sent.length === 0);
  check('a key with no live check is untested, and nobody is asked',
    (await checkStored('FMS_PASSWORD', { value: 'x', checkWith: spy })).verdict === 'untested'
    && sent.length === 0);
  check('an unsuffixed Bolt token with no fleet to test it for is untested, not guessed',
    (await checkStored('BOLT_REFRESH_TOKEN', { value: 'x', checkWith: spy })).verdict === 'untested'
    && sent.length === 0);

  await checkStored(KEY, { value: 'sid=QA.PLACEHOLDER.value', checkWith: spy });
  check('the Egari cookie is tested against the EGARI org the collector asks for',
    sent[0]?.org_uuid === EGA_ORG && sent[0]?.fleet === 'egari' && sent[0]?.key === KEY,
    JSON.stringify({ org: sent[0]?.org_uuid, fleet: sent[0]?.fleet }));
  sent.length = 0;
  await checkStored('UBER_WEB_COOKIE', { value: 'sid=QA.PLACEHOLDER.value', checkWith: spy });
  check('…and the unsuffixed cookie against Ecosine\u2019s, which is the fleet it serves',
    sent[0]?.org_uuid === ECO_ORG && sent[0]?.fleet === 'ecosine');
  sent.length = 0;
  await checkStored('BOLT_REFRESH_TOKEN', { fleet: 'egari', value: 'x', checkWith: spy });
  check('an unsuffixed Bolt token is tested for the fleet whose row it is on',
    sent[0]?.fleet === 'egari');

  /* The failure mode the per-key field invites: a whole "Copy as cURL" typed
     into it. What is stored is sent as-is, so the provider sees a cookie
     header that starts with "curl" and answers like a signed-out session. */
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (p) => [b64({ alg: 'HS256', typ: 'JWT' }), b64(p), 'not_a_real_signature'].join('.');
  const jar = ['sid=QA.PLACEHOLDER.value',
    `sp-jwt-session=${jwt({ data: { supplierOrgUUID: EGA_ORG, tenancy: 'uber/production' }, iat: 1, exp: 2e9 })}`,
  ].join('; ');
  const curl = `curl 'https://fleethub.uber.com/chronicle/graphql' \\\n  -H 'accept: */*' \\\n  -b '${jar}'`;
  const refused = async () => ({ verdict: 'fail', detail: 'the session is no longer signed in' });
  const whole = await checkStored(KEY, { value: curl, checkWith: refused });
  check('a whole curl stored as the cookie is named as that, not as an expired session',
    /whole request or cookie jar/.test(whole.detail) && /paste box/.test(whole.detail), whole.detail);
  const bare = await checkStored(KEY, { value: jar, checkWith: refused });
  check('…and a bare cookie that is refused is not told it is a curl',
    !/whole request/.test(bare.detail), bare.detail);
}

/* ══ 8. the browser keeps no copy of the banner either ═══════════════════ */
console.log('\nthe page never paints a remembered banner');
{
  /* swr.js is a browser module; it needs only localStorage. */
  const mem = new Map();
  global.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const { swr } = await import('../api/public/swr.js');
  swr.put('/api/kpis?days=7', { n: 1 });
  check('an ordinary answer is remembered (the control for the check below)',
    swr.get('/api/kpis?days=7')?.body?.n === 1);
  swr.put('/api/auth', { rows: [{ severity: 'stopped' }] });
  check('the credential banner is not — a red row fixed a second ago must not be painted back',
    swr.get('/api/auth') === null);
}

/* ══ 9. what an independent review found in the first version ═══════════ */
console.log('\nthe rows a save must leave alone, and the writes it must not make');
{
  /* A moved endpoint or a blocked caller is as true of the new value as of
     the old: a passing check must not paint it "accepted when saved". */
  await q(`DELETE FROM credential_state`);
  await q(`DELETE FROM app_setting`);
  const v = await save('UBER_WEB_COOKIE', '2026-09-23T10:00:00Z');
  /* Observed with the value stored then; a null version would be (rightly)
     dropped, because a value IS stored. */
  await noteCredential(db, { provider: 'uber_fleet', fleet: 'ecosine', credential: 'UBER_WEB_COOKIE',
    state: 'moved', detail: 'redirected to fleethub.uber.com — the endpoint has moved', version: v });
  await noteCredential(db, { provider: 'uber', fleet: 'ecosine', credential: 'UBER_WEB_COOKIE',
    state: 'expired', detail: 'the old session', version: v });
  await save('UBER_WEB_COOKIE', '2026-09-23T10:05:00Z');
  const stored = (await q(`SELECT (${SETTING_VERSION_SQL})::text AS v FROM app_setting WHERE key = 'UBER_WEB_COOKIE'`))[0].v;
  const out = await recordSaved(db, ['UBER_WEB_COOKIE'], {
    check: async () => ({ verdict: 'pass', detail: 'stub' }), reload: async () => {} });
  const moved = await row('uber_fleet', 'ecosine', 'UBER_WEB_COOKIE');
  check('a moved endpoint is not repainted by a passing save', moved?.state === 'moved'
    && /endpoint has moved/.test(moved?.detail || ''), `${moved?.state}: ${moved?.detail}`);
  check('…but is re-stamped, so it reads as current rather than superseded',
    moved?.value_version === stored && v !== stored);
  check('…while the credential row beside it takes the verdict',
    (await row('uber', 'ecosine', 'UBER_WEB_COOKIE'))?.state === 'ok' && out[0]?.rows === 1,
    JSON.stringify(out));
  check('…and /api/auth still shows the moved endpoint as stopped',
    (await auth()).rows.find((x) => x.provider === 'uber_fleet')?.severity === 'stopped');

  /* Saving the unsuffixed Bolt token must never write the per-fleet one. The
     check reports the per-fleet key on every pass, carrying the value it was
     given; stored as-is, that overwrote the token the collector uses. */
  const writes = [];
  await q(`DELETE FROM credential_state`);
  await noteCredential(db, { provider: 'bolt', fleet: 'ecosine', credential: 'BOLT_REFRESH_TOKEN',
    state: 'expired', version: null });
  await recordSaved(db, ['BOLT_REFRESH_TOKEN'], {
    check: async () => ({ verdict: 'pass', keys: { BOLT_REFRESH_TOKEN_ECOSINE: 'the-value-just-saved' } }),
    store: async (k, val) => { writes.push(`${k}=${val}`); }, reload: async () => {} });
  check('a check naming ANOTHER key never causes a write to it', writes.length === 0, writes.join(', '));
  const spy = async () => ({ verdict: 'pass', detail: 'x',
    keys: { BOLT_REFRESH_TOKEN_ECOSINE: 'the-value-just-saved' } });
  const same = await checkStored('BOLT_REFRESH_TOKEN', { fleet: 'ecosine', value: 'the-value-just-saved', checkWith: spy });
  check('checkStored carries no successor when the provider handed back the same value',
    same.keys === undefined, JSON.stringify(same.keys));
  const rotated = await checkStored('BOLT_REFRESH_TOKEN', { fleet: 'ecosine', value: 'the-value-just-saved',
    checkWith: async () => ({ verdict: 'pass', keys: { BOLT_REFRESH_TOKEN_ECOSINE: 'a-new-one' } }) });
  check('…and a real successor is filed under the key that was TESTED',
    JSON.stringify(rotated.keys) === JSON.stringify({ BOLT_REFRESH_TOKEN: 'a-new-one' }), JSON.stringify(rotated.keys));
}

/* ══ 10. both routes: a cleared key, and a refused duplicate ═════════════ */
console.log('\nthe routes pass the recorder the truth about what they did');
{
  await q(`DELETE FROM credential_state`);
  await q(`DELETE FROM app_setting`);
  await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: KEY, state: 'ok', version: null });
  let tested = 0;
  const stubCheck = async () => { tested++; return { verdict: 'pass', detail: 'stub' }; };
  const { server, port } = await mountAll(db, {
    inject: {
      recordSaved: (d, keys, o) => recordSaved(d, keys, { ...o, check: stubCheck }),
      /* Two verdicts for one candidate, the second a refusal: a set can hold
         two candidates for one key, and only the admitted one was written. */
      checkAll: async (cands) => cands.flatMap((c) => (c.key ? [
        { ...c, verdict: 'pass', detail: 'the admitted one' },
        { ...c, verdict: 'fail', detail: 'a refused duplicate' },
      ] : [{ ...c, verdict: 'fail', detail: 'unnamed' }])),
      proposeKeys: async () => [],
    },
  });
  const base = `http://127.0.0.1:${port}`;
  const put = await (await fetch(`${base}/api/settings`, { method: 'PUT',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [KEY]: '' }) })).json();
  const r = await row('uber', 'egari');
  check('a CLEARED key is not tested against the API’s own environment', tested === 0, `tested ${tested}`);
  check('…and is written as saved, not as "nothing is configured"',
    r?.state === 'saved' && /^cleared on the Settings page/.test(r?.detail || ''), `${r?.state}: ${r?.detail}`);
  check('…and says so in the answer', put.checked?.[0]?.verdict === 'cleared', JSON.stringify(put.checked));

  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = [b64u({ alg: 'HS256', typ: 'JWT' }),
    b64u({ data: { fleet_owner_id: 174036, jti: 'synthetic-2' }, exp: Math.floor(Date.now() / 1000) + 86400 }),
    'not-a-signature-this-token-is-synthetic'].join('.');
  await noteCredential(db, { provider: 'bolt', fleet: 'egari', credential: 'BOLT_REFRESH_TOKEN_EGARI',
    state: 'invalid', detail: 'the old token', version: null });
  const paste = await (await fetch(`${base}/api/settings/paste`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: token, apply: true }) })).json();
  const b = await row('bolt', 'egari', 'BOLT_REFRESH_TOKEN_EGARI');
  check('the paste box files the verdict of the candidate it WROTE, not a refused duplicate',
    paste.applied?.includes('BOLT_REFRESH_TOKEN_EGARI') && b?.state === 'ok' && /the admitted one/.test(b?.detail || ''),
    `${b?.state}: ${b?.detail}`);
  server.close();
}

/* ══ 11. the providers' own answers, from stand-ins ═══════════════════════ */
console.log('\nwhat each check establishes, against stand-in providers');
{
  let bare = 403;          // what the stand-in portal answers with no cookie
  let grants = 0;
  const stand = express();
  stand.use(express.urlencoded({ extended: false }));
  stand.post('/api/reports-api/v2/summary/drivers/list', (req, res) => {
    if (req.headers.cookie) return res.status(403).type('html').send('<html>edge</html>');
    return res.status(bare).type('html').send('<html>edge</html>');
  });
  stand.post('/oauth/token', (req, res) => {
    grants++;
    res.json({ access_token: `grant-${grants}`, expires_in: 2592000 });
  });
  const ss = stand.listen(0);
  await new Promise((r) => ss.once('listening', r));
  const at = `http://127.0.0.1:${ss.address().port}`;
  process.env.YANGO_BASE = at;
  process.env.YANGO_PARK_ID = 'park-synthetic';
  process.env.YANGO_API_KEY = 'not-a-key';
  process.env.UBER_TOKEN_URL = `${at}/oauth/token`;

  const sym = await checkStored('YANGO_COOKIE', { value: 'Session_id=placeholder' });
  check('Yango refusing the park with or without a session: the check says it is not the cookie',
    sym.verdict === 'fail' && sym.blames === 'other', JSON.stringify({ v: sym.verdict, b: sym.blames }));
  check('…so the save writes it as not tested, never red', stateOf(sym) === 'saved');
  bare = 401;
  const asym = await checkStored('YANGO_COOKIE', { value: 'Session_id=placeholder' });
  check('Yango reading the session and refusing anyway: the check says it authenticates',
    asym.verdict === 'unknown' && asym.authenticates === true, JSON.stringify({ v: asym.verdict, a: asym.authenticates }));
  check('…so the save writes ok, as the collector does on the same evidence', stateOf(asym) === 'ok');

  /* A replaced OAuth secret is used from the next call, not after the old
     grant's thirty days. */
  const { uberOAuthToken } = await import('../src/auth/uber.js');
  const org = (secret) => ({ fleet: 'egari', oauth: { clientId: 'synthetic-client', clientSecret: secret,
    secretKey: 'UBER_CLIENT_SECRET_EGARI', own: true } });
  const t1 = await uberOAuthToken(org('first-secret'));
  const t2 = await uberOAuthToken(org('first-secret'));
  check('the same client and secret reuse one grant', t1 === t2 && grants === 1, `${t1} ${t2} grants ${grants}`);
  const t3 = await uberOAuthToken(org('second-secret'));
  check('a replaced secret mints a new grant at once', t3 !== t1 && grants === 2, `${t3} grants ${grants}`);
  ss.close();
}

/* ══ 12. every row names a key somebody can find ══════════════════════════ */
console.log('\nthe banner names Settings keys, which a save can reach');
{
  const { readFileSync, readdirSync } = await import('node:fs');
  const { SETTING_DEFS } = await import('../src/settings.js');
  const { passKey } = await import('../src/sources/cabman.js');
  const { config } = await import('../src/config.js');
  const keys = new Set(SETTING_DEFS.map((d) => d.key));
  /* Surfaces, not credentials, on purpose: the Yango console is refused in
     front of the API whatever is pasted. */
  const NOT_SETTINGS = new Set(['YANGO_CONSOLE']);
  const files = ['src/auth_state.js', 'src/auth/uber.js',
    ...readdirSync('src/sources').filter((f) => f.endsWith('.js')).map((f) => `src/sources/${f}`)];
  const named = new Set();
  for (const f of files) {
    for (const m of readFileSync(f, 'utf8').matchAll(/credential:\s*'([A-Z0-9_]+)'/g)) named.add(m[1]);
  }
  const strays = [...named].filter((k) => !keys.has(k) && !NOT_SETTINGS.has(k));
  check('every credential a source names in a banner row is a Settings key', strays.length === 0, strays.join(', '));
  check('…CABMAN’s included, which is built per fleet',
    config.cabman.fleets.every((f) => keys.has(passKey(f.fleet))), config.cabman.fleets.map((f) => passKey(f.fleet)).join(','));
}

/* ══ 13. one snapshot per unit of work ═══════════════════════════════════ */
console.log('\na unit of work reads values and versions from one moment');
{
  const { loadSettings, withPinnedSettings, get, settingVersion, setSetting } = await import('../src/settings.js');
  await q(`DELETE FROM credential_state`);
  await q(`DELETE FROM app_setting`);
  /* Stored in the clear (is_secret false): these tests read what they wrote,
     and nothing here is a credential. */
  await q(`INSERT INTO app_setting (key, value, is_secret, updated_at)
           VALUES ($1, 'cookie-one', false, '2026-09-23T08:00:00Z')`, [KEY]);
  await loadSettings(true, db);
  await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: KEY, state: 'ok' });
  check('outside any unit, an observation stamps the loaded version as before',
    (await row('uber', 'egari'))?.value_version === settingVersion(KEY) && settingVersion(KEY) != null);

  let inside = null;
  await withPinnedSettings(async () => {
    const sent = get(KEY);                                     // what uber.collect holds for the pass
    /* 08:30:22 — the operator saves a new cookie … */
    await q(`UPDATE app_setting SET value = 'cookie-two', updated_at = '2026-09-23T08:30:22.622Z' WHERE key = $1`, [KEY]);
    /* … and another tick refreshes the SHARED cache mid-run. */
    await loadSettings(true, db);
    /* 08:31:28 — the run reports on the cookie it sent. */
    await noteCredential(db, { provider: 'uber', fleet: 'egari', credential: KEY, state: 'expired',
      detail: 'redirected to auth.uber.com — the session is no longer signed in' });
    inside = { sent, now: get(KEY) };
  }, { db });
  check('inside the unit, the value does not change under it', inside?.sent === 'cookie-one' && inside?.now === 'cookie-one',
    JSON.stringify(inside));
  check('…so the refusal of the OLD cookie is not filed under the new one, even after a refresh',
    (await row('uber', 'egari'))?.state === 'ok', (await row('uber', 'egari'))?.state);
  check('outside it, the process has moved on to the saved value', get(KEY) === 'cookie-two');

  /* A unit's own writes are visible to the rest of the unit. */
  let seen = null;
  await withPinnedSettings(async () => {
    await setSetting('CHARGING_SITES', 'Al Garhoud', db);
    seen = { value: get('CHARGING_SITES'), version: settingVersion('CHARGING_SITES') };
  }, { db });
  const storedV = (await q(`SELECT (${SETTING_VERSION_SQL})::text AS v FROM app_setting WHERE key = 'CHARGING_SITES'`))[0].v;
  check('a write inside a unit is seen by the rest of that unit, with its version',
    seen?.value === 'Al Garhoud' && seen?.version === storedV, JSON.stringify(seen));
}

/* And the collector actually works in units. This one is read from the
   source, which the house notes warn can be satisfied by a different route:
   so it names every entry point index.js schedules, and fails on any that
   reaches a provider without a pin. Driving a real tick here would mean
   contacting the providers, which a test must not do. */
{
  const { readFileSync } = await import('node:fs');
  const run = readFileSync('src/run.js', 'utf8');
  const bodyOf = (name) => {
    const at = run.search(new RegExp(`export (async function ${name}\\b|const ${name} = )`));
    return at < 0 ? '' : run.slice(at, at + 400);
  };
  const units = ['payoutWalk', 'payoutAudit', 'cabmanTick', 'probePass', 'uberTimelineTick',
    'uberProfileTick', 'uberAuditTick', 'liveStatusTick'];
  const bare = units.filter((u) => !/withPinnedSettings\(/.test(bodyOf(u)));
  check('every scheduled unit of work runs inside a pin', bare.length === 0, bare.join(', ') || '');
  check('…and inside a run, each source does',
    /withPinnedSettings\(\(\) => mod\.collect\(/.test(run));
  const index = readFileSync('src/index.js', 'utf8');
  const imported = (index.match(/import \{([^}]+)\} from '\.\/run\.js'/) || [])[1] || '';
  const scheduled = imported.split(',').map((x) => x.trim()).filter(Boolean);
  const unlisted = scheduled.filter((n) => !units.includes(n)
    && !['backfill', 'incremental', 'catchUp', 'analystPass'].includes(n));
  check('…and no entry point index.js imports is missing from that list', unlisted.length === 0, unlisted.join(', '));
}

authSrv.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
