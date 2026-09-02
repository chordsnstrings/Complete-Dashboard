/* The runner's own clock: every window it builds is a Dubai day.
   ─────────────────────────────────────────────────────────────────────────
   src/run.js turns instants into calendar days three times — the line it logs,
   the bounds it hands rebuildCustody, and the bounds it hands computeInsights —
   and analystPass builds a fourth for the nightly analyst. All four were
   `toISOString().slice(0, 10)`, which is the UTC day, and the fleet works Dubai
   time: between 20:00 and 24:00 UTC — 00:00 to 04:00 the next day in Dubai —
   that names yesterday.

   Both of this file's scheduled callers sit inside those four hours. Measured
   on production 2026-09-02:

     • /api/status — the nightly catch-up (src/index.js:98, `0 21 * * *`) had
       its eleven source rows finish between 2026-09-01T21:05:47.209Z and
       21:09:52.629Z, i.e. 01:05-01:09 on the 2nd in Dubai, while custody and
       insights were rebuilt with bounds ending "2026-09-01".
     • /api/analyst/findings — the analyst (src/index.js:107, `10 23 * * *`)
       recorded, on five consecutive nights, a window ending the day BEFORE the
       Dubai day it ran on. Those five rows are the table below, copied
       verbatim, and this test replays the shipped expression against them: if
       it does not reproduce production exactly, the test is not describing the
       bug it claims to.

   test/timezone.test.mjs bans `iso(new Date())` and could not see any of this:
   analystPass laundered the clock through a local variable and a locally
   redefined `iso` that shadowed the import, and the other three sites never
   mention iso() at all. Running it with the bug live gave 17 passed, 0 failed.
   The rule at the bottom of this file is the narrow version of the widening
   that guard wants — narrow because it is scoped to the one file this change
   owns, and because a tree-wide ban on the shape would be wrong: the same
   expression is CORRECT on a Date already anchored at UTC midnight
   (api/performer_routes.js:50 builds one deliberately), and src/run.js's own
   auditWindows does exactly that, which is why iso() is still imported there.

   Run under a process timezone twelve hours from Dubai, so nothing here can
   pass by accident of where the container happens to be. */
process.env.TZ = 'Pacific/Honolulu';

import { readFileSync } from 'node:fs';

const { dubaiWindow, analystWindow, auditWindows } = await import('../src/run.js');
const { iso, dubaiIso } = await import('../src/util.js');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* The expression src/run.js shipped with, kept here so "before" is a thing the
   test RUNS rather than a thing its comments assert. */
const shipped = (days, now) => ({
  from: new Date(now.getTime() - days * 864e5).toISOString().slice(0, 10),
  to: now.toISOString().slice(0, 10),
});

/* ── 1. the analyst window, against the five nights production recorded ── */
console.log('\nthe analyst pass measures the Dubai day it runs on');
{
  /* run_id, created_at, and the window_start/window_end stored with it — read
     from https://fleet-dashboard-wpeqb.ondigitalocean.app/api/analyst/findings
     ?from=2026-07-01&to=2026-09-02 on 2026-09-02. analystPass uses days = 30. */
  const PRODUCTION = [
    ['an-20260901231000', '2026-09-01T23:10:13.008Z', '2026-08-02', '2026-09-01'],
    ['an-20260831231000', '2026-08-31T23:10:14.724Z', '2026-08-01', '2026-08-31'],
    ['an-20260830231000', '2026-08-30T23:10:21.920Z', '2026-07-31', '2026-08-30'],
    ['an-20260829231000', '2026-08-29T23:10:13.351Z', '2026-07-30', '2026-08-29'],
    ['an-20260828231000', '2026-08-28T23:10:20.329Z', '2026-07-29', '2026-08-28'],
  ];
  for (const [runId, createdAt, wStart, wEnd] of PRODUCTION) {
    const at = new Date(createdAt);
    const before = shipped(30, at);
    const after = analystWindow(30, at);
    check(`${runId}: the old expression reproduces the window production stored`,
      before.from === wStart && before.to === wEnd,
      `${before.from}..${before.to} vs ${wStart}..${wEnd}`);
    check(`${runId}: …and it ended the day BEFORE the Dubai day the pass ran on`,
      before.to !== dubaiIso(at), `${before.to} vs Dubai ${dubaiIso(at)}`);
    check(`${runId}: the window now ends on the Dubai day the pass runs on`,
      after.to === dubaiIso(at), `${after.to} vs Dubai ${dubaiIso(at)}`);
    check(`${runId}: …and still spans thirty days`,
      Math.round((Date.parse(after.to) - Date.parse(after.from)) / 864e5) === 30,
      `${after.from}..${after.to}`);
  }
  const at = new Date('2026-09-01T23:10:13.008Z');
  console.log(`      before: ${JSON.stringify(shipped(30, at))}`);
  console.log(`      after:  ${JSON.stringify(analystWindow(30, at))}   (Dubai: ${dubaiIso(at)})`);
}

/* ── 2. custody and insights, at the instant the catch-up actually ran ─── */
console.log('\nthe nightly catch-up materialises the Dubai day in progress');
{
  /* The earliest and latest finished_at of the eleven catchup rows on
     /api/status, 2026-09-02. catchUp(30) passes daysAgo(30) and new Date(). */
  for (const [what, instant] of [
    ['first source finished', '2026-09-01T21:05:47.209Z'],
    ['last source finished', '2026-09-01T21:09:52.629Z'],
  ]) {
    const to = new Date(instant);
    const from = new Date(to.getTime() - 30 * 864e5);
    const before = shipped(30, to);
    const after = dubaiWindow(from, to);
    check(`${what} ${instant}: it was already 2026-09-02 in Dubai`,
      dubaiIso(to) === '2026-09-02', dubaiIso(to));
    check(`${what}: the old bounds stopped a day short of it`,
      before.to === '2026-09-01', before.to);
    check(`${what}: custody and insights are now rebuilt through that day`,
      after.to === '2026-09-02' && after.from === '2026-08-03',
      `${after.from}..${after.to}`);
  }
}

/* ── 2b. …and what that costs, over a real database and a real route ──── */
console.log('\nthe day in progress can name its driver');
{
  /* The half of this that a reader sees. An alert at 01:10 on 2026-09-02 in
     Dubai is 21:10Z on the 1st — inside the four hours — and the trip that
     names its driver is at 01:00. /api/alerts/by-driver joins the event to
     vehicle_driver_day, so a day custody was not materialised for is not a
     quiet internal gap: the Safety page prints the event under
     "(unattributed)".

     Both bounds below are computed from the SAME instant, 2026-09-01T21:05:47
     .209Z — the first catch-up source row to finish on production that night —
     one with the expression that shipped and one with dubaiWindow. */
  const { PGlite } = await import('@electric-sql/pglite');
  const { applySchema } = await import('./schema.mjs');
  const { mountAll } = await import('./mount.mjs');
  const { rebuildCustody } = await import('../src/custody.js');

  const db = new PGlite();
  await applySchema(db);
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
             requested_at, status, distance_km, price)
           VALUES ('uber','tzrun1','ecosine','L100','u1','Night Driver',
                   '2026-09-02T01:00:00+04:00','completed',14,55)`);
  await q(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
           VALUES ('fms','tzrun1a','ecosine','L100','Harsh Brake','2026-09-02T01:10:00+04:00')`);

  const at = new Date('2026-09-01T21:05:47.209Z');
  const from = new Date(at.getTime() - 30 * 864e5);
  const OLD = shipped(30, at);
  const NEW = dubaiWindow(from, at);

  const { get, server } = await mountAll(db);
  const ROUTE = '/api/alerts/by-driver?from=2026-09-02&to=2026-09-02';
  const named = async () => {
    const b = (await get(ROUTE)).body;
    const rows = Array.isArray(b) ? b : (b.rows || b.drivers || []);
    return rows.map((r) => `${r.driver_name}:${r.alerts}`).join(', ');
  };
  const custodyDays = () => q(
    `SELECT driver_name FROM vehicle_driver_day WHERE day = '2026-09-02'::date`);

  await rebuildCustody({ from: OLD.from, to: OLD.to, db });
  const beforeRows = await custodyDays();
  const beforeSays = await named();
  check('with the shipped bounds the Dubai day in progress gets no custody row',
    beforeRows.length === 0, JSON.stringify(beforeRows));
  check('…so the Safety page files its harsh-braking event under nobody',
    beforeSays === '(unattributed):1', beforeSays);

  await rebuildCustody({ from: NEW.from, to: NEW.to, db });
  const afterRows = await custodyDays();
  const afterSays = await named();
  check('with Dubai bounds the same run materialises that day',
    afterRows.length === 1 && afterRows[0].driver_name === 'Night Driver',
    JSON.stringify(afterRows));
  check('…and the event names the driver who was in the car',
    afterSays === 'Night Driver:1', afterSays);
  console.log(`      before: ${OLD.from}..${OLD.to} → ${beforeSays}`);
  console.log(`      after:  ${NEW.from}..${NEW.to} → ${afterSays}`);

  server.close(); await db.close();
}

/* ── 3. a window that was already right does not move ──────────────────── */
console.log('\nand a run outside those four hours is untouched');
{
  /* Read from /api/insights on 2026-09-02: the newest findings carry
     window 2026-08-30 → 2026-09-02, computed at 2026-09-02T18:06:08Z. That is
     22:06 in Dubai, where the UTC day and the Dubai day agree — which is why
     this bug is invisible on the half-hourly daytime incrementals and shows
     up only on the two nightly jobs. An incremental is daysAgo(3). */
  const to = new Date('2026-09-02T18:06:08Z');
  const from = new Date(to.getTime() - 3 * 864e5);
  const before = shipped(3, to);
  const after = dubaiWindow(from, to);
  check('the printed insight window still reads 2026-08-30 → 2026-09-02',
    after.from === '2026-08-30' && after.to === '2026-09-02', `${after.from}..${after.to}`);
  check('…which is exactly what it read before, so nothing correct was shifted',
    after.from === before.from && after.to === before.to,
    `${before.from}..${before.to} vs ${after.from}..${after.to}`);
  /* The far edge of the four-hour window, from both sides. 19:59 UTC is 23:59
     the same day in Dubai; one minute later it is the next day. */
  check('23:59 in Dubai is still that Dubai day',
    dubaiWindow(new Date('2026-09-01T19:59:00Z'), new Date('2026-09-01T19:59:00Z')).to === '2026-09-01');
  check('and 00:01 in Dubai is the next one',
    dubaiWindow(new Date('2026-09-01T20:01:00Z'), new Date('2026-09-01T20:01:00Z')).to === '2026-09-02');
}

/* ── 4. the audit windows keep iso(), and are right to ─────────────────── */
console.log('\nthe one place the UTC day is still correct');
{
  /* auditWindows builds its bounds with Date.UTC(...), so they ARE midnight
     UTC of the date meant — the single argument src/util.js:86-95 says iso()
     is correct for. This is asserted rather than assumed because the rule
     below bans the shape in this file, and a reader needs to see why the
     import survived rather than guessing the fix was incomplete. */
  const W = auditWindows(new Date('2026-08-31T09:00:00Z'));
  const anchored = W.every((w) => [w.from, w.to].every((d) =>
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0));
  check('every audit window bound is midnight UTC of the day it names', anchored);
  check('…so iso() reads them back unshifted on any container clock',
    W.every((w) => iso(w.from).length === 10 && iso(w.from) === w.from.toISOString().slice(0, 10)));
}

/* ── 5. the shape, so it cannot come back ──────────────────────────────── */
console.log('\nthe runner cannot build a day from a clock again');
{
  const raw = readFileSync('src/run.js', 'utf8');
  /* Comments blanked, length-preserving, so the prose above that QUOTES the
     bad expression is not read as a violation — the same trick, and for the
     same reason, as test/timezone.test.mjs. */
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (c, p1) => p1 + ' '.repeat(c.length - p1.length));
  const lineOf = (i) => src.slice(0, i).split('\n').length;

  const slices = [...src.matchAll(/toISOString\(\)\s*\.\s*slice\(0,\s*10\)/g)]
    .map((m) => `src/run.js:${lineOf(m.index)}`);
  check('no day in the runner is cut out of a UTC timestamp',
    slices.length === 0, slices.join(', '));

  /* The laundering that walked past the existing guard: a second `iso` defined
     locally, shadowing the import, so `iso(from)` no longer means what the
     lint thinks it means. Anywhere in this file, at any indent. */
  const shadow = [...src.matchAll(/(?:const|let|var|function)\s+iso\b/g)]
    .map((m) => `src/run.js:${lineOf(m.index)}`);
  check('and nothing redefines iso() on top of the one imported from util.js',
    shadow.length === 0, shadow.join(', '));

  check('the run window is built once, as Dubai days, and used by all three readers',
    /const day = dubaiWindow\(from, to\)/.test(src)
    && /rebuildCustody\(\{ from: day\.from, to: day\.to \}\)/.test(src)
    && /computeInsights\(\{ from: day\.from, to: day\.to \}\)/.test(src)
    && /log\.info\('run', `\$\{mode\} \$\{day\.from\}\.\.\$\{day\.to\}`\)/.test(src));
  check('and the analyst pass takes its window from the same helper',
    /const \{ from, to \} = analystWindow\(days, now\)/.test(src)
    && /runAnalyst\(\{ from, to \}\)/.test(src));
  check('the failed-pass row records that same window rather than recomputing one',
    /VALUES \(\$1,\$2,\$3,'failed',\$4, now\(\)\)/.test(src) && /Date\.now\(\)\}`, from, to, err\]/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
