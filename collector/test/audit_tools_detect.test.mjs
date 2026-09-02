/* The audit tools, audited.
   ──────────────────────────────────────────────────────────────────────────
   bin/cap-audit.mjs, bin/slice-audit.mjs and bin/page-audit.mjs exist to catch
   a page that shows N of M rows without saying so, and to walk every view the
   router declares. Nothing checked that they still could — and all three had
   quietly stopped catching part of what they were written for:

     cap-audit    read its "is the set size stated?" test over the ROWS as well
                  as the envelope, and a row's own arithmetic is full of words
                  like total. /api/sensor-health's rows carry total_fixes, so
                  the endpoint read as disclosed whatever the envelope said —
                  the one shape the tool exists to catch was the shape it
                  could not see.
     slice-audit  matched only `tableFrom(list.slice(0, 30))` written inline
                  with a numeric size. A cut assigned to a variable first, or
                  sized by a constant, was invisible: 9 of the 27 cut tables in
                  this dashboard, reported as though 18 were all of them.
     page-audit   found views by `^V\.name = ` only, so the two declared as
                  V['top-performers'] and V['low-performers'] were never
                  audited, on any window, ever.

   Each check below drives the real tool against a stub that contains a fault
   the tool claims to catch, and against one that does not. A harness that says
   nothing is only good news if it would have spoken.

       node test/audit_tools_detect.test.mjs
*/
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, statSync,
  existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}  ${x}`)); };

/* A throwaway report directory, for every tool spawned here.
   ─────────────────────────────────────────────────────────────────────────
   numbers-audit writes docs/audit/numbers-<today>.json at the end of every
   run, and this file drives it against a one-route stub — so running the test
   suite REPLACED the day's real production sweep with a stub's findings, and
   did it silently, on the one artefact whose whole job is to be believed. The
   tools take REPORT_DIR now; this is where it points while they are under
   test. */
const REPORTS = mkdtempSync(join(tmpdir(), 'audit-reports-'));
/* Taken before any tool runs, so "the real report is older than this run" is
   a fact rather than a hope. */
const START_MS = Date.now();

const run = (script, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(ROOT, 'bin', script)],
    { cwd: ROOT, env: { ...process.env, REPORT_DIR: REPORTS, ...env } });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});

/* A stub API that answers ONE route and refuses everything else, so a run is
   about the route under test and nothing else. */
const stub = async (answers) => {
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    const body = answers[path];
    res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body === undefined ? { error: 'no such endpoint' } : body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, stop: () => server.close() };
};

/* ── cap-audit: N of M with the set size nowhere ─────────────────────────── */
/* /api/sensor-health carries LIMIT 100 and its rows carry total_fixes — a
   per-row count of GPS fixes, not a statement about the set. 120 rows are
   returned so the cap is plainly biting. */
const rows = (extra = {}) => Array.from({ length: 120 }, (_, i) => ({
  plate: `L${1000 + i}`, total_fixes: 7, occupied_fixes: 3, ...extra }));

{
  const s = await stub({ '/api/sensor-health': { rows: rows() } });
  const { code, out } = await run('cap-audit.mjs', { BASE: s.base });
  s.stop();
  const flagged = /CAPS THAT ARE CUTTING[\s\S]*\/api\/sensor-health/.test(out);
  check('a capped envelope that never states the set size is reported', flagged, out.trim());
  check('…and the run fails', code === 1, `exit ${code}`);
}
{
  const s = await stub({ '/api/sensor-health': { rows: rows(), total: 130, shown: 100, truncated: true } });
  const { code, out } = await run('cap-audit.mjs', { BASE: s.base });
  s.stop();
  check('an envelope that states total/shown/truncated is not reported',
    !/CAPS THAT ARE CUTTING/.test(out) && /say so[\s\S]*sensor-health/.test(out), out.trim());
  check('…and the run passes', code === 0, `exit ${code}`);
}
{
  /* The bare-array form /api/map/days uses: no envelope at all, the three
     set-size facts repeated on every row. That is a disclosure and must stay
     one. */
  const s = await stub({ '/api/sensor-health': rows({ total: 130, shown: 120, truncated: true }) });
  const { out } = await run('cap-audit.mjs', { BASE: s.base });
  s.stop();
  check('a bare array repeating total/shown/truncated on each row still discloses',
    !/CAPS THAT ARE CUTTING/.test(out), out.trim());
}
{
  /* …and the same bare array carrying only a per-row measurement does not. */
  const s = await stub({ '/api/sensor-health': rows() });
  const { out } = await run('cap-audit.mjs', { BASE: s.base });
  s.stop();
  check('a bare capped array whose rows only carry their own counts is reported',
    /CAPS THAT ARE CUTTING[\s\S]*\/api\/sensor-health/.test(out), out.trim());
}

/* ── slice-audit: a list the server sent whole and the page cut ──────────── */
const withPub = async (source) => {
  const dir = mkdtempSync(join(tmpdir(), 'slice-audit-'));
  writeFileSync(join(dir, 'stub.js'), source);
  const r = await run('slice-audit.mjs', { PUB: dir });
  rmSync(dir, { recursive: true, force: true });
  return r;
};
const COLS = `[
      { label: 'Plate', key: 'plate' },
      { label: 'Trips', key: 'trips', num: true },
    ]`;
{
  const { code, out } = await withPub(`export function renderStub(root) {
  const p = panel('Vehicles', 'every car');
  root.append(p.panel);
  p.body.append(tableFrom(rows.slice(0, 30), ${COLS}));
}
`);
  check('an inline cut with no caption is reported', /stub\.js:4/.test(out) && code === 1, out.trim());
}
{
  const { code, out } = await withPub(`export function renderStub(root) {
  const p = panel('Vehicles', 'every car');
  root.append(p.panel);
  const top = rows.slice(0, 30);
  p.body.append(tableFrom(top, ${COLS}));
}
`);
  check('a cut ASSIGNED first and then drawn is reported', /stub\.js:4/.test(out) && code === 1, out.trim());
}
{
  const { code, out } = await withPub(`export function renderStub(root) {
  const p = panel('Vehicles', 'every car');
  root.append(p.panel);
  const DRAW = 400;
  p.body.append(tableFrom(rows.slice(0, DRAW), ${COLS}));
}
`);
  check('a cut sized by a named constant is reported', /stub\.js:5/.test(out) && code === 1, out.trim());
}
{
  /* An emptiness guard is not a disclosure. This is the shape that used to
     rubber-stamp a silent table: `if (!rows.length)` matched the old
     `.length)` pattern and the cut below it was passed. */
  const { code, out } = await withPub(`export function renderStub(root) {
  const p = panel('Vehicles', 'every car');
  root.append(p.panel);
  if (!rows.length) empty(p.body, 'nothing yet');
  else p.body.append(tableFrom(rows.slice(0, 30), ${COLS}));
}
`);
  check('an emptiness guard does not count as owning up to a cut',
    /stub\.js:5/.test(out) && code === 1, out.trim());
}
{
  /* A caption on the far side of a wide column list still counts — the window
     is the panel, not a line count. */
  const filler = Array.from({ length: 70 }, (_, i) => `      { label: 'C${i}', key: 'c${i}' },`).join('\n');
  const { code, out } = await withPub(`export function renderStub(root) {
  const p = panel('Vehicles', 'every car');
  root.append(p.panel);
  p.body.append(tableFrom(rows.slice(0, 30), [
${filler}
    ]));
  p.body.append(el('p', 'cap', \`Showing 30 of \${fmt(rows.length)} vehicles.\`));
}
`);
  check('a caption 70 lines below the cut is found', !/✗/.test(out) && code === 0, out.trim());
}

/* ── page-audit: every view the router declares ──────────────────────────── */
{
  /* Enough shape for the tool's id lookups; every endpoint answers the same
     non-empty row so no view is reported blank for the stub's sake. */
  const row = [{ plate: 'L1', driver_ext_id: 'd1', partner_id: 'p1', trips: 3,
    started_at: '2026-01-01T00:00:00.000Z', platform: 'uber', external_id: 'x1' }];
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(row));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { out } = await run('page-audit.mjs', { BASE: base, WINDOWS: '7' });
  server.close();
  for (const v of ['top-performers', 'low-performers']) {
    check(`#${v} is one of the views this tool audits`,
      new RegExp(`^${v}\\s`, 'm').test(out), out.split('\n').filter((l) => /performer/.test(l)).join(' | '));
  }
  check('and it still audits the views declared the ordinary way',
    /^overview\s/m.test(out), '');
}

/* ── numbers-audit: a figure that reached the browser and not the screen ──
   Two guards had turned this tool into one that says nothing:

     the row's identity was the FIRST of plate/driver_name/… that it carried,
     so a driver row naming the car it drives was looked up by plate in a table
     keyed on the person, matched nothing, and was skipped as "not drawn";

     and every figure was additionally accepted in its value divided by 1000,
     60, 3600 and 60000 — an allowance written for durations, applied to
     everything, which let a km figure of 3,496 be satisfied by the digit 3
     sitting in a Trips column two cells away.

   So the fixture is one driver row carrying both a plate and a name, drawn in
   a table keyed on the name, with a small integer beside the figure. The page
   is served twice: once printing the number it was given, once printing three
   times it. */
{
  const row = [{ driver_name: 'Aisha Rahman', plate: 'L9001', km: 3496, trips: 3 }];
  const page = (mult) => `<!doctype html><meta charset="utf-8"><div id="view"></div>
<script>
fetch('/api/drivers/directory?from=2026-01-01&to=2026-01-31').then((r) => r.json()).then((rows) => {
  const t = document.createElement('table');
  t.innerHTML = '<thead><tr><th data-key="driver_name">Driver</th>'
    + '<th data-key="trips">Trips</th><th data-key="km">Km</th></tr></thead><tbody>'
    + rows.map((r) => '<tr><td>' + r.driver_name + '</td><td>' + r.trips + '</td><td>'
      + (Number(r.km) * ${mult}) + '</td></tr>').join('') + '</tbody>';
  document.getElementById('view').appendChild(t);
});
</script>`;
  const serve = async (mult) => {
    const server = createServer((req, res) => {
      if (req.url.startsWith('/api/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(row));
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(page(mult));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const r = await run('numbers-audit.mjs',
      { BASE: `http://127.0.0.1:${server.address().port}`, ONLY: 'stub', SETTLE: '900' });
    server.close();
    return r;
  };
  const honest = await serve(1);
  check('a page printing the figure it was given is not reported',
    !/unshown/.test(honest.out), honest.out.split('\n').filter((l) => /✗/.test(l)).join(' | '));
  const wrong = await serve(3);
  check('a figure that has a column, sits in a drawn row, and is not in that row is reported',
    /unshown/.test(wrong.out) && /3496/.test(wrong.out),
    wrong.out.split('\n').slice(-6).join(' | '));
}

/* ── live-audit: every route the app declares ────────────────────────────── */
{
  /* The mock on 8099 is not a coherent fleet — live-audit fails a couple of
     dozen invariants against it and that is expected, since those invariants
     are about production data. What is asked here is narrower and does not
     care: with /api/reconcile deliberately answering 500, does the run NAME
     it? Before the route list was derived from api/*.js it did not, because
     /api/reconcile was one of the 32 declared endpoints the hand-kept list
     had never heard of. */
  const up = 'http://127.0.0.1:8099';
  const reachable = await fetch(`${up}/api/kpis?from=2026-07-23&to=2026-08-22`)
    .then((r) => r.ok).catch(() => false);
  if (!reachable) {
    console.log('  · live-audit route coverage not checked — no mock API on 127.0.0.1:8099');
  } else {
    const proxy = createServer(async (req, res) => {
      if (req.url.split('?')[0] === '/api/reconcile') {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end('{"error":"deliberately broken"}');
      }
      try {
        const r = await fetch(`${up}${req.url}`);
        const body = await r.text();
        const keep = {};
        for (const h of ['x-data-version', 'x-cache']) if (r.headers.get(h)) keep[h] = r.headers.get(h);
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', ...keep });
        res.end(body);
      } catch (e) { res.writeHead(502); res.end(JSON.stringify({ error: String(e) })); }
    });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const { out } = await run('live-audit.mjs', { BASE: `http://127.0.0.1:${proxy.address().port}` });
    proxy.close();
    check('a declared endpoint answering 500 is named, even one no hand-kept list mentioned',
      /\/api\/reconcile → 500/.test(out),
      out.split('\n').filter((l) => /route errors/.test(l)).join(' | ') || out.slice(-200));
  }
}

/* ── the tools under test must not overwrite the tools' own output ────────
   Every run above went through `run`, which sets REPORT_DIR. If a tool ever
   ignores it again, the day's production sweep is silently replaced by a
   stub's findings — which is what happened, and it took a full re-run of the
   116-route sweep to notice and undo. */
{
  const written = readdirSync(REPORTS);
  check('the audit tools wrote their reports into the throwaway directory',
    written.some((f) => /^numbers-\d{4}-\d{2}-\d{2}\.json$/.test(f)),
    JSON.stringify(written));
  const real = join(ROOT, 'docs', 'audit');
  const before = statSync(real, { throwIfNoEntry: false });
  check('and nothing in this file touched the real docs/audit report for today',
    !before || !existsSync(join(real, written.find((f) => /^numbers-/.test(f)) || 'none'))
      || statSync(join(real, written.find((f) => /^numbers-/.test(f)))).mtimeMs < START_MS,
    'the production sweep was overwritten by a test stub');
}
rmSync(REPORTS, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
