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
import { describe, firstList, unmappedAgainst, surfaces, norm } from '../src/probe.js';
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
