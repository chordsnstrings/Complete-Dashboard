/* A licence expiry must name the day the provider wrote, on any clock.
   ─────────────────────────────────────────────────────────────────────────
   src/sources/hotel.js is the only place this product learns when a driver's
   licence runs out — the field rides along on every trip record — and that
   date becomes "days_left" on /api/compliance/drivers and "stand down until
   renewed" in licenceRisk(). A day lost in the parse is a person told to stop
   driving a day early.

   The parser has two arms and, until this test, one clock. Measured on
   production 2026-09-02, every hotel driver record carries licenseExpireDate
   "1/1/26" (/api/schema/raw-values?table=trip&platform=hotel&key=driver — 19
   distinct driver records, that one licence text among them), which is why all
   94 dated hotel licences on /api/compliance/drivers read 2026-01-01. So the
   day-first regex arm is the only one live traffic reaches, and the FALLBACK
   arm — free text the regex misses — used
   `new Date(v).toISOString().slice(0, 10)`. A non-ISO date-only string is
   parsed at LOCAL midnight, which in Dubai is 20:00 the previous day in UTC.
   The provider spelling it "1 Jan 2026" was all it would have taken.

   This runs the REAL module in CHILD PROCESSES under three process timezones,
   because a clock bug exercised on one clock is not tested: Asia/Dubai (where
   the fleet is), UTC (where the container usually is) and America/New_York (a
   laptop — and the direction the naive fix, local components everywhere,
   breaks instead). */
import { execFileSync } from 'node:child_process';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* Every one of these means 1 January 2026 and must come back as that day.
   `arm` records which branch reads it, because the two arms have to be proved
   differently: the live one that it did not move, the fallback that it did. */
const SHAPES = [
  { v: '1/1/26',                   arm: 'regex',    note: 'the live shape, two-digit year' },
  { v: '01/01/2026',               arm: 'regex',    note: 'the live shape, four-digit year' },
  { v: 'Jan 1 2026',               arm: 'fallback', note: 'parsed at LOCAL midnight' },
  { v: '1 Jan 2026',               arm: 'fallback', note: 'parsed at LOCAL midnight' },
  { v: 'January 1, 2026',          arm: 'fallback', note: 'parsed at LOCAL midnight' },
  { v: '2026/01/01',               arm: 'fallback', note: 'slashes, so LOCAL midnight too' },
  { v: '2026-01-01',               arm: 'fallback', note: 'ISO date-only, parsed as UTC' },
  { v: '2026-01-01T00:00:00.000Z', arm: 'fallback', note: 'an instant, carries its own day' },
];
const ZONES = ['Asia/Dubai', 'UTC', 'America/New_York'];

/* The child prints, for each shape, what the shipped parser answers and what
   the expression it replaced would have answered — so the failure this fixes
   shows up in the test's own output, not only in its prose. `before` is a
   verbatim copy of the code as it stood, kept here (and nowhere else) because
   a regression test for a fix needs the thing that was wrong. */
const CHILD = `
  const { parseLicenceDate } = await import(process.argv[1]);
  const before = (v) => {
    if (!v) return null;
    const m = String(v).trim().match(/^(\\d{1,2})[\\/\\-](\\d{1,2})[\\/\\-](\\d{2,4})$/);
    if (!m) { const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0, 10); }
    let [, dd, mm, yy] = m;
    if (yy.length === 2) yy = String(2000 + Number(yy));
    const d = new Date(\`\${yy}-\${String(mm).padStart(2, '0')}-\${String(dd).padStart(2, '0')}\`);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  };
  /* The OTHER wrong answer: isoDay()'s Date branch applied to everything, i.e.
     "just read the local components". Carried through so the table shows why
     the shipped parser splits on the shape instead of picking one clock. */
  const naive = (v) => {
    if (!v) return null;
    const d = new Date(String(v).trim());
    if (isNaN(d)) return null;
    const p = (n) => String(n).padStart(2, '0');
    return \`\${d.getFullYear()}-\${p(d.getMonth() + 1)}-\${p(d.getDate())}\`;
  };
  console.log(JSON.stringify(JSON.parse(process.argv[2])
    .map((v) => ({ v, before: before(v), naive: naive(v), after: parseLicenceDate(v) }))));
`;

const MOD = new URL('../src/sources/hotel.js', import.meta.url).href;
const run = (tz, values) => JSON.parse(execFileSync(process.execPath,
  ['--input-type=module', '-e', CHILD, MOD, JSON.stringify(values)],
  { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim().split('\n').pop());

console.log('\nhotel licence expiry: the day the provider wrote, on every clock');

const byZone = {};
for (const tz of ZONES) {
  const rows = run(tz, SHAPES.map((s) => s.v));
  byZone[tz] = new Map(rows.map((r) => [r.v, r]));
  console.log(`\n  TZ=${tz}`);
  for (const s of SHAPES) {
    const r = byZone[tz].get(s.v);
    const mark = r.before !== r.after ? '  ← shipped code was wrong'
      : r.naive !== r.after ? '  ← a local-components fix would be wrong' : '';
    console.log(`    ${JSON.stringify(s.v).padEnd(28)} ${s.arm.padEnd(9)}`
      + ` before ${String(r.before).padEnd(11)} naive ${String(r.naive).padEnd(11)}`
      + ` after ${String(r.after).padEnd(11)}${mark}`);
  }
}
console.log('');

for (const tz of ZONES) {
  const wrong = SHAPES.filter((s) => byZone[tz].get(s.v).after !== '2026-01-01');
  check(`every spelling of 1 January 2026 parses to 2026-01-01 under ${tz}`,
    wrong.length === 0, JSON.stringify(wrong.map((s) => [s.v, byZone[tz].get(s.v).after])));
}

/* The measured failure, asserted as a fact about the code that was there: if
   this ever stops being true, the runtime changed and the checks above have
   stopped standing for anything. */
{
  const lost = SHAPES.filter((s) => byZone['Asia/Dubai'].get(s.v).before === '2025-12-31');
  check('in Dubai the expression this replaced really did lose a day',
    lost.length >= 3 && lost.every((s) => s.arm === 'fallback'),
    JSON.stringify(lost.map((s) => s.v)));
}

/* The live path is untouched. Production sends "1/1/26" and nothing else, so
   this is the assertion that says this change cannot move a number on the
   board today — before and after are the same string, in all three zones. */
check('the shape production actually sends answers identically before and after, in every zone',
  ZONES.every((tz) => SHAPES.filter((s) => s.arm === 'regex')
    .every((s) => { const r = byZone[tz].get(s.v); return r.before === r.after && r.after === '2026-01-01'; })),
  JSON.stringify(ZONES.map((tz) => [tz, byZone[tz].get('1/1/26')])));

/* And the fix does not trade a Dubai bug for a western one. Reading local
   components of an ISO-parsed value is wrong west of UTC — measured,
   new Date('2026-01-01') is 2025-12-31 by local components in New York — which
   is why ISO text is passed through as text instead. */
{
  const iso = ['2026-01-01', '2026-01-01T00:00:00.000Z']
    .map((v) => byZone['America/New_York'].get(v));
  check('a local-components fix would have lost a day on ISO text in New York',
    iso.every((r) => r.naive === '2025-12-31'), JSON.stringify(iso));
  check('…and the shipped parser passes ISO text through as text instead',
    iso.every((r) => r.after === '2026-01-01'), JSON.stringify(iso));
}

/* Absent or unparseable stays null. The compliance page prints "no licence
   date on file" for null, which is true, where a guessed date would read as
   "expired 244 days ago", which would not be. */
{
  const junk = run('Asia/Dubai', ['not a date', '', 'expired', '  ']);
  console.log(`\n  junk: ${JSON.stringify(junk.map((r) => [r.v, r.after]))}`);
  check('text that is not a date is null, never a guess',
    junk.every((r) => r.after === null), JSON.stringify(junk));
}

/* An impossible calendar day is NOT this fix's business, and is recorded here
   so the next reader does not mistake silence for correctness: Date rolls
   31 February over rather than refusing it. Printed, and asserted only as
   "unchanged by this edit" — the day someone fixes it properly, this test must
   not be what stands in the way. */
{
  const [r] = run('Asia/Dubai', ['31/02/2026']);
  console.log(`  impossible day: "31/02/2026" → before ${r.before}, after ${r.after}`
    + '  (rolls over; pre-existing, on the arm this edit did not touch)');
  check('an impossible day behaves exactly as it did before this change',
    r.before === r.after, JSON.stringify(r));
}

/* ── the whole collector, not just the function ────────────────────────────
   Everything above tests parseLicenceDate directly. This drives collect()
   against a stub of the corporate API and reads what it would have written to
   driver_compliance.licence_expires — the column /api/compliance/drivers
   subtracts from today to print "expired 244 days ago". Under TZ=Asia/Dubai
   (the host this runs on is UTC, which is why it has to be a child), with the
   provider spelling the date "Jan 1 2026". */
{
  const DB = new URL('../src/db.js', import.meta.url).href;
  const E2E = `
    import { createServer } from 'node:http';
    const db = await import(process.argv[2]);
    const wrote = [];
    // logRun and friends go through pool.query; upsertMany takes a client.
    db.pool.query = async () => ({ rows: [{ id: 1 }], rowCount: 0 });
    db.pool.connect = async () => ({
      query: async (text, params = []) => {
        const t = String(text);
        const m = /INSERT INTO (\\w+) \\(([^)]+)\\)/.exec(t);
        if (m) wrote.push({ table: m[1], cols: m[2].split(','), params });
        return { rows: [], rowCount: 0 };
      },
      release() {},
    });
    const trip = {
      _id: 't1', startTime: '2026-08-20T10:00:00.000Z', endTime: '2026-08-20T10:30:00.000Z',
      car: { licenseNumber: 'L-46185' }, status: 'finished', totalDistance: 12, cost: 40,
      driver: { _id: 'd1', firstName: 'Test', lastName: 'Driver', driverLicense: '123456',
                licenseExpireDate: process.argv[3], active: true, role: 'driver' },
    };
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(/get-trip-report/.test(req.url)
        ? { data: { totalTrips: 1, trips: [trip] } } : { data: [] }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.HOTEL_BASE = \`http://127.0.0.1:\${server.address().port}\`;
    process.env.HOTEL_TOKEN = 'x';
    const hotel = await import(process.argv[1]);
    await hotel.collect({ mode: 'incremental', from: '2026-08-20', to: '2026-08-21' });
    server.close();
    const dc = wrote.find((w) => w.table === 'driver_compliance');
    console.log(JSON.stringify(dc ? dc.params[dc.cols.indexOf('licence_expires')] : null));
  `;
  const drive = (text) => JSON.parse(execFileSync(process.execPath,
    ['--input-type=module', '-e', E2E, MOD, DB, text],
    { env: { ...process.env, TZ: 'Asia/Dubai' }, encoding: 'utf8' }).trim().split('\n').pop());

  const live = drive('1/1/26');
  const spelt = drive('Jan 1 2026');
  console.log(`\n  collect() → driver_compliance.licence_expires, TZ=Asia/Dubai`);
  console.log(`    provider sends "1/1/26"      → ${JSON.stringify(live)}   (what production sends today)`);
  console.log(`    provider sends "Jan 1 2026"  → ${JSON.stringify(spelt)}   (was "2025-12-31" before this fix)`);
  check('the collector stores the licence day the provider wrote, whichever way it spells it',
    live === '2026-01-01' && spelt === '2026-01-01', JSON.stringify({ live, spelt }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
