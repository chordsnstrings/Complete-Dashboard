/* The provider probe, and the three ways it can lie.
   ──────────────────────────────────────────────────────────────────────────
   This module exists to answer "what else could we be collecting?" from
   evidence rather than memory. Its first live pass got two of those answers
   wrong, in ways that were invisible precisely because they produced no error:

   1. SILENCE READ AS AN ANSWER. Every Uber surface was skipped because the
      guard tested `config.uber.clientId` when the real path is
      `config.uber.oauth.clientId`. The results page showed no Uber rows at
      all — not an error, an absence — which reads as "Uber offers nothing".
      The same class of bug skipped CABMAN, whose fleet keys are `pass`,
      `interfaceId` and `user`, not `password`, `id` and `username`.

   2. A TRUE COLUMN MADE USELESS BY NOISE. The "not kept" column flagged all
      twelve FMS fields — including "Start Location", "StartLat" and "Total
      Travel Distance", every one of which the collector maps. A column that is
      wrong twelve times out of twelve is worse than no column.

   3. A SHAPE REPORT THAT IS ACTUALLY A DATA EXPORT. The whole justification for
      running this on a schedule is that it records shape, never records. */
import { describe, firstList, unmappedAgainst, surfaces, norm, payloadError } from '../src/probe.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── shape, not records ───────────────────────────────────────────────── */
{
  // A dimension (few values) and an identifier (many) must be treated
  // differently: one is worth seeing, the other is somebody's data.
  const rows = Array.from({ length: 60 }, (_, i) => ({
    status: ['finished', 'cancelled'][i % 2],
    email: `person${i}@example.com`,
    note: i % 3 ? '' : 'something',
    nested: { tier: ['Black', 'UberX'][i % 2] },
    tags: ['a', 'b'],
  }));
  const f = Object.fromEntries(describe(rows).map((x) => [x.key, x]));
  check('a narrow field has its values reported', f.status.values.sort().join() === 'cancelled,finished');
  check('a wide field has its contents suppressed', f.email.values === null, JSON.stringify(f.email.values));
  check('the wide field is still reported as existing', f.email.fill_pct === 100 && f.email.distinct_seen > 12);
  check('nested objects are walked and dotted', !!f['nested.tier'], Object.keys(f).join(','));
  check('an empty string counts as unfilled, not as a value',
    f.note.fill_pct === 34 || f.note.fill_pct === 33, String(f.note.fill_pct));
  check('an array field is typed as an array rather than stringified', f.tags.type === 'array', f.tags.type);
  check('a bare object is described as well as a list', describe({ a: 1, b: 'x' }).length === 2);
  check('an empty response does not throw', describe([]).length === 0 && describe(null).length === 0);
}

/* ── finding the list ─────────────────────────────────────────────────── */
{
  check('a bare array is the list', firstList([{ a: 1 }])?.length === 1);
  check('a list wrapped under any key is found',
    firstList({ meta: 1, IVDDataResult: [{ VehicleID: 'L1' }] })?.[0].VehicleID === 'L1');
  check('a list nested two deep is found',
    firstList({ data: { trips: [{ _id: 'x' }] } })?.[0]._id === 'x');
  check('a response with no list is not invented', firstList({ code: 3, message: 'nope' }) === null);
  check('an array of scalars is not mistaken for a record list',
    firstList({ ids: ['a', 'b'], rows: [{ x: 1 }] })?.[0].x === 1);
}

/* ── "not kept" has to be trustworthy ─────────────────────────────────── */
{
  // These are the REAL field names FMS returns, and the real columns they land
  // in. Every one of them was flagged as unmapped on the first live pass.
  const fmsFields = ['Plate No', 'Start Time', 'End Time', 'Start Location', 'End Location',
    'StartLat', 'StartLon', 'EndLat', 'EndLon', 'Total Travel Distance', 'Trip Duration',
    'Slno', 'Seat Count', 'Fuel Level'].map((key) => ({ key, fill_pct: 100 }));
  const cols = ['plate', 'requested_at', 'ended_at', 'pickup_addr', 'dropoff_addr', 'pickup_lat',
    'pickup_lng', 'dropoff_lat', 'dropoff_lng', 'distance_km', 'duration_s', 'external_id', 'seat_count'];
  const aliases = {
    'Plate No': 'plate', 'Start Time': 'requested_at', 'End Time': 'ended_at',
    'Start Location': 'pickup_addr', 'End Location': 'dropoff_addr',
    StartLat: 'pickup_lat', StartLon: 'pickup_lng', EndLat: 'dropoff_lat', EndLon: 'dropoff_lng',
    'Total Travel Distance': 'distance_km', 'Trip Duration': 'duration_s',
    'Seat Count': 'seat_count', Slno: 'external_id',
  };
  const out = unmappedAgainst(fmsFields, cols, aliases);
  check('a field the collector maps under another name is not called unkept',
    !out.includes('Start Location') && !out.includes('StartLat') && !out.includes('Total Travel Distance'),
    out.join(', '));
  check('the one field nothing holds is still flagged',
    out.length === 1 && out[0] === 'Fuel Level', out.join(', '));
  check('without aliases the same fields are all flagged — which is the bug this fixes',
    unmappedAgainst(fmsFields, cols).length === 13,
    String(unmappedAgainst(fmsFields, cols).length));
  check('a field that is present but never filled is not reported as a missed opportunity',
    unmappedAgainst([{ key: 'Ghost', fill_pct: 0 }], cols, {}).length === 0);
  check('matching ignores case, spaces and punctuation',
    norm('Total Travel Distance') === 'totaltraveldistance' && norm('total_travel_distance') === 'totaltraveldistance');
  check('a dotted path matches on its leaf',
    unmappedAgainst([{ key: 'car.licenseNumber', fill_pct: 100 }], ['plate'],
      { 'car.licenseNumber': 'plate' }).length === 0);
}

/* ── silence is never an answer ───────────────────────────────────────── */
{
  // No credentials are configured in the test environment, which is exactly
  // the condition that previously produced an empty results page.
  const list = surfaces({ from: new Date(Date.now() - 3 * 864e5), to: new Date() });
  const providers = new Set(list.map((s) => s.provider));
  for (const p of ['uber', 'fms', 'cabman', 'hotel', 'yango', 'bolt']) {
    check(`${p} appears even with nothing configured`, providers.has(p),
      [...providers].join(', '));
  }
  const skipped = list.filter((s) => s.surface === '(not configured)');
  check('an unconfigured provider says which credential is missing',
    skipped.every((s) => /is not set|no .* has a password/.test(s.note || '')),
    JSON.stringify(skipped.map((s) => s.note)));
  check('a skipped surface fails loudly rather than returning an empty success',
    await skipped[0].run().then(() => false, () => true));
}

/* ── the config paths that were wrong ─────────────────────────────────── */
{
  const src = readFileSync('src/probe.js', 'utf8');
  const cfg = readFileSync('src/config.js', 'utf8');
  // Each of these is a path that exists in config.js. Reading a path that does
  // not exist is silent in JS, which is how the whole Uber section vanished.
  check('the Uber guard reads the path config.js actually defines',
    /config\.uber\?\.oauth\?\.clientId/.test(src) && /oauth:\s*\{[\s\S]{0,200}clientId:/.test(cfg));
  check('the CABMAN fleet keys match config.js',
    /cab\.pass/.test(src) && /cab\.interfaceId/.test(src) && /cab\.user\b/.test(src)
    && /interfaceId: get\('CABMAN/.test(cfg) && /pass: get\('CABMAN/.test(cfg));
  check('CABMAN credentials go in headers, the way the collector sends them',
    /InterfaceUniqueId: cab\.interfaceId/.test(src));
  check('no probe guard reads a config path that config.js does not define',
    !/config\.uber\?\.clientId\b/.test(src) && !/config\.cabman[^;]*\.password/.test(src));
}

/* ── it must never become a data export ───────────────────────────────── */
{
  const src = readFileSync('src/probe.js', 'utf8');
  check('nothing stored carries a raw record',
    !/fields: JSON\.stringify\(arr\)/.test(src) && /fields: JSON\.stringify\(fields\)/.test(src));
  check('the value cap is small enough that an identifier cannot slip through',
    /MAX_VALUES = 1?[0-9];/.test(src));
  check('every upstream call is a fixed URL, not a caller-supplied one',
    !/req\.query/.test(src) && !/req\.params/.test(src));
  check('a single value is truncated even when the field is narrow',
    describe([{ x: 'y'.repeat(400) }])[0].values[0].length <= 48);
  // A credential in a stored note or error would be visible on a public page.
  check('no credential is interpolated into a note or a surface name',
    !/note:.*(token|password|cookie|secret|apiKey)/i.test(src)
    && !/surface: `[^`]*\$\{[^}]*(token|pass|cookie|secret)/i.test(src));
}

/* ── a refusal is not a success ────────────────────────────────────────────
   Yango's orders/list, summary/drivers/list and transactions/park/list all came
   back from production as {http_status: 403, ok: true}; Uber's transactions as
   {404, ok: true}. The page counted every one of them under "ANSWERING 18 /
   NOT ANSWERING 0" with failing: []. And FMS's GetVehicleCurrentDetails
   returned {ok: true, record_count: 0, top_keys: ["error"]} with the value
   "Authentication failed" — then offered "error" as an unmapped field we could
   be keeping. */
{
  const src = readFileSync('src/probe.js', 'utf8');
  check('ok is decided by the status code, not by the call returning',
    /const good = status == null \|\| \(status >= 200 && status < 300\)/.test(src));
  check('and a non-2xx surface records the status as its error',
    /error: refusal \|\| \(good \? null : `HTTP \$\{status\}`\)/.test(src));

  check('a payload whose only key is an error is a refusal, whatever the status said',
    payloadError({ error: 'Authentication failed' }) === 'Authentication failed');
  check('and the provider\'s own words survive into it',
    payloadError({ message: 'token expired' }) === 'token expired');
  check('a real payload is not mistaken for one',
    payloadError({ error: null, rows: [] }) === null
    && payloadError([{ a: 1 }]) === null && payloadError(null) === null);
  check('an empty object is not a refusal either — it is an empty answer',
    payloadError({}) === null);

  /* distinct_seen saturated at exactly 14 for every wide field in the corpus:
     the cap on the sample set was also the counter, so a trip uuid, a plate, a
     driver name and a timestamp all reported "14 distinct". */
  const wide = describe(Array.from({ length: 40 }, (_, i) => ({ id: `u-${i}`, tier: i % 3 })));
  check('a wide field reports how many distinct values it really had',
    wide.find((f) => f.key === 'id').distinct_seen === 40,
    String(wide.find((f) => f.key === 'id').distinct_seen));
  check('and says the count is a floor when every sampled row differed',
    wide.find((f) => f.key === 'id').distinct_capped === true);
  check('while a narrow field is unaffected and still carries its values',
    wide.find((f) => f.key === 'tier').distinct_seen === 3
    && wide.find((f) => f.key === 'tier').values.length === 3);
  check('a wide field still exports no values at all',
    wide.find((f) => f.key === 'id').values === null);

  check('every configured FMS fleet is probed, not the first one with a credential',
    !/const fmsFleet = \(config\.fms/.test(src) && /for \(const fleet of fmsFleets\.filter/.test(src));
  check('and a fleet that cannot be probed gets a visible row rather than silence',
    /surface: `\$\{f\.fleet\}:\(not probed\)`/.test(src));
  check('CABMAN surfaces name their fleet',
    /`\$\{cab\.fleet\}:GetIVDData`/.test(src));
  check('both Bolt companies are probed, and the trip and earnings surfaces with them',
    /for \(const company of \(config\.bolt\.companies/.test(src)
    && /getFleetOrders/.test(src) && /getCompanyEarnings/.test(src));
  check('the described row count is stored beside the record count',
    /described_n: Math\.min\(Array\.isArray\(arr\) \? arr\.length : 0, 300\)/.test(src));
}

/* ── a helper referenced but never imported ────────────────────────────────
   The history probe called probeEarnerWindow and the import line was never
   added. node --check passed, because the file's syntax was fine. Importing the
   module passed, because the reference sits inside a callback that only runs
   against a live provider. It failed in production, four minutes after deploy,
   as "ReferenceError: probeEarnerWindow is not defined" — recorded against the
   surface it was probing, which is the one good thing about it.

   Every capitalised-or-camelCase call in this file has to resolve to something:
   an import, a local declaration, or a global. */
{
  const src2 = readFileSync('src/probe.js', 'utf8');
  const imported = new Set(
    [...src2.matchAll(/import\s*\{([^}]+)\}\s*from/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop())));
  const declared = new Set([
    ...[...src2.matchAll(/(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    ...[...src2.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  ]);
  // `if (`, `for (`, `catch (` and friends match a call pattern and are not one.
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof',
    'await', 'async', 'of', 'in', 'new', 'delete', 'void', 'yield', 'do', 'else', 'function']);
  const GLOBALS = new Set(['Object', 'Array', 'String', 'Number', 'Boolean', 'JSON', 'Math', 'Date',
    'Set', 'Map', 'Promise', 'Error', 'RegExp', 'Buffer', 'console', 'process', 'fetch',
    'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'setTimeout',
    'String', 'Intl', 'URL', 'URLSearchParams', 'AbortController', 'TextDecoder', 'structuredClone']);
  const called = new Set([...src2.matchAll(/(?:^|[^.\w$'"`])([a-z][\w$]*)\s*\(/g)].map((m) => m[1]));
  /* Parameter names and inline arrow bindings are declared where they are used
     and appear in none of the patterns above. Built with a RegExp constructor
     over a plain string: the first version wrote this as a template literal and
     the backslashes ended up doubled, so the pattern matched everything and the
     whole check silently passed — including on the exact bug it was written
     for, which is how I found out. */
  const isBinding = (n) => new RegExp('[(,]\\s*' + n + '\\s*[),=]|\\b' + n + '\\s*=>').test(src2);
  const missing = [...called].filter((n) =>
    !imported.has(n) && !declared.has(n) && !GLOBALS.has(n)
    && !KEYWORDS.has(n) && !isBinding(n));
  check('every function this file calls is imported or declared in it',
    missing.length === 0, missing.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
