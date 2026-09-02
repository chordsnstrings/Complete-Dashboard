/* The probe's default window is the FLEET's day, not UTC's.
   ─────────────────────────────────────────────────────────────────────────
   Two endpoints in api/probe.js take an optional ?from/?to and fall back to
   "the last three days" when neither is given. Both defaults were written as
   `new Date().toISOString().slice(0, 10)`, which is the UTC calendar day — and
   the fleet works Asia/Dubai, four hours ahead all year. Between midnight and
   04:00 in Dubai the UTC day is still YESTERDAY, so an operator opening the
   probe at 01:30 on the 3rd was shown, and Uber was asked for, a window ending
   on the 2nd. The response echoes it verbatim as `window: [from, to]`, so the
   wrong day is not merely internal: it is printed as the answer to "which
   window is this?".

   That is the second half of the class test/timezone.test.mjs polices — its
   rule 2b bans `iso(new Date())` under src/ and api/, and the browser rule
   bans `toISOString().slice(0, 10)` under api/public, but neither could see
   this spelling of it on the server.

   Driven, not pattern-matched. The clock is frozen at a real instant inside
   the failing four-hour window and the route handlers are called for real, so
   what is checked is the date the reader is shown and the date Uber is sent —
   not the shape of the expression that produced them. */

/* config.js reads process.env through get(), so the environment is the
   fixture. One org, because one org is all a window needs. */
process.env.UBER_ORG_UUID = 'eco-uuid';
process.env.UBER_ORG_ENCRYPTED = 'eco-org';
process.env.UBER_WEB_COOKIE = 'eco-cookie';
delete process.env.UBER_ORG_UUID_EGARI;
delete process.env.UBER_WEB_COOKIE_EGARI;

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* No database. loadSettings() swallows a failed query and falls back to the
   environment, which would hide a real one behind a warning; an empty result
   is the same fallback, stated. */
const { pool } = await import('../src/db.js');
pool.query = async () => ({ rows: [] });

/* What fetch actually hands http(): a status, ok, text() and a final URL.
   GenerateReport is answered as accepted so the route reaches its response,
   and every request body is kept — the window Uber is ASKED for matters as
   much as the one the reader is SHOWN. */
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  sent.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
  const reply = (obj) => ({
    status: 200, ok: true, url: String(url), redirected: false, headers: new Map(),
    text: async () => (typeof obj === 'string' ? obj : JSON.stringify(obj)),
  });
  if (/GenerateReport/.test(url)) return reply({ status: 'success', data: { reportId: { uuid: { value: 'r1' } } } });
  if (/DownloadReport/.test(url)) return reply({ data: { signedUrl: { value: 'https://example.invalid/r1.csv' } } });
  return reply('Trip UUID,Date\n"t-1","2026-09-03"\n');
};

const { probeRoutes } = await import('../api/probe.js');

/* The real handlers, collected off a stand-in app. Nothing here is stubbed:
   the route body that computes the window is the one that runs. */
const routes = new Map();
probeRoutes({ get: (path, handler) => routes.set(path, handler) }, { wrap: (fn) => fn });

const RealDate = Date;
async function call(path, query = {}, atIso) {
  const fixed = RealDate.parse(atIso);
  class FrozenDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [fixed])); }
    static now() { return fixed; }
  }
  globalThis.Date = FrozenDate;
  sent.length = 0;
  let body = null, code = 200;
  const res = { json: (o) => { body = o; return res; }, status: (c) => { code = c; return res; } };
  try { await routes.get(path)({ query }, res); }
  finally { globalThis.Date = RealDate; }
  return { body, code, sent: [...sent] };
}

/* 21:30 UTC on the 2nd is 01:30 on the 3rd in Dubai — inside the four-hour
   window where the two calendars disagree, and an hour the collector is awake:
   the incremental runs every thirty minutes. */
const NIGHT = '2026-09-02T21:30:00Z';
/* And an hour where they agree, so a fix that simply shifts every window by a
   day would fail here. */
const NOON = '2026-09-02T12:00:00Z';

console.log('\n/api/probe/uber/report-types');
{
  const r = await call('/api/probe/uber/report-types', {}, NIGHT);
  check('the window it prints ends on the Dubai day, not the UTC one',
    r.body?.window?.[1] === '2026-09-03', JSON.stringify(r.body?.window));
  check('and starts three Dubai days back',
    r.body?.window?.[0] === '2026-08-31', JSON.stringify(r.body?.window));
  const asked = r.sent.find((s) => /GenerateReport/.test(s.url));
  check('the dates Uber is asked for are the dates the reader is shown',
    asked?.body?.startDate?.value === r.body?.window?.[0]
    && asked?.body?.endDate?.value === r.body?.window?.[1],
    JSON.stringify([asked?.body?.startDate?.value, asked?.body?.endDate?.value]));

  const day = await call('/api/probe/uber/report-types', {}, NOON);
  check('and at an hour where the two calendars agree the window is unchanged',
    day.body?.window?.join() === '2026-08-30,2026-09-02', JSON.stringify(day.body?.window));

  /* req.query arrives as a string and must survive untouched — a caller who
     names a window is not asking for the fleet's clock, they are asking for
     the days they typed. */
  const given = await call('/api/probe/uber/report-types', { from: '2026-07-01', to: '2026-07-08' }, NIGHT);
  check('an explicit window is passed through exactly as typed',
    given.body?.window?.join() === '2026-07-01,2026-07-08', JSON.stringify(given.body?.window));
}

console.log('\n/api/probe/uber/report-columns');
{
  const r = await call('/api/probe/uber/report-columns', {}, NIGHT);
  check('the same default, on the endpoint that spends a real Uber report on it',
    r.body?.window?.join() === '2026-08-31,2026-09-03', JSON.stringify(r.body?.window));
  const asked = r.sent.find((s) => /GenerateReport/.test(s.url));
  check('and the report it generates covers that window',
    asked?.body?.startDate?.value === '2026-08-31' && asked?.body?.endDate?.value === '2026-09-03',
    JSON.stringify([asked?.body?.startDate?.value, asked?.body?.endDate?.value]));
}

console.log('\nthe rule, so the spelling cannot come back');
{
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync('api/probe.js', 'utf8');
  /* Comments blanked, length-preserving, so the prose that explains the trap
     is not read as an instance of it. */
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (c, p1) => p1 + ' '.repeat(c.length - p1.length));
  const offenders = [...src.matchAll(/toISOString\(\)\.slice\(0,\s*10\)/g)]
    .map((m) => `api/probe.js:${src.slice(0, m.index).split('\n').length}  UTC day from a clock`);
  check('no default date in this file is taken off the UTC calendar',
    offenders.length === 0, offenders.join('; '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
