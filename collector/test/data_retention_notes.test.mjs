/* "Thinned by retention before <date>" reaches every page that reads past it,
   and nothing claims a range was thinned that was not.
   ═════════════════════════════════════════════════════════════════════════
   The house rule: a figure that cannot be measured renders absent with the
   true reason, never as a smaller number. Once the retention pass has thinned
   positions or removed alerts for real, a window reaching back past that
   point is computed from fewer rows than were collected. This proves:

     1. every READERS path is a route that exists (the list cannot rot);
     2. the header is set on exactly the answers whose window reaches past the
        boundary — and through the REAL routes, mounted the way the server
        mounts them, before anything that could answer from a cache;
     3. a dry run (no retention_state) makes no page say anything;
     4. alertCoverage stops calling removed days "the feed was dark";
     5. the front end parses the header and words it truthfully;
     6. /api/settings/retention shows the record, and says why when absent.

   REVERSION: in api/data_retention_notes.js make notesFor compare with `<=`
   reversed (`since > h[t].before`) and section 2's "window reaching past"
   checks fail; drop `removedBefore` from alertCoverage's call and section 4's
   live-route check fails. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { applySchema } from './schema.mjs';
import { mountAll, declaredRoutes } from './mount.mjs';
import { READERS, retentionHorizon, resetRetentionHorizon, retentionNotes, noteValue }
  from '../api/data_retention_notes.js';
import { alertCoverageOf } from '../api/alert_coverage_sql.js';
import { parseRetentionHeader, retentionSentence, noteRetention, retentionNow, resetRetention, dayWords }
  from '../api/public/retention_note.js';
import { dataRetentionPass } from '../src/data_retention.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\n1. the inventory is real');
const declared = new Set(declaredRoutes());
const ghosts = Object.keys(READERS).filter((p) => !declared.has(p));
check(`every READERS path is a declared GET route (${Object.keys(READERS).length})`, ghosts.length === 0, ghosts.join(' '));
check('the whole-record page and the positions pages are on it',
  ['/api/coverage', '/api/where', '/api/track', '/api/vehicle/kpis', '/api/sensor-health', '/api/trip', '/api/segment']
    .every((p) => READERS[p]));
check('and the alert readers, in case RETENTION_ALERT_DAYS is ever set',
  ['/api/kpis', '/api/alerts/summary', '/api/vehicle/safety', '/api/driver/quality', '/api/day'].every((p) => READERS[p]?.tables
    && (typeof READERS[p].tables === 'function' || READERS[p].tables.includes('alert'))));

const db = new PGlite();
await applySchema(db);
const read = (s, p) => db.query(s, p).then((r) => r.rows);

console.log('\n2. the boundary, as pages see it');
{
  resetRetentionHorizon();
  check('no retention_state: nothing has been thinned, so no horizon', Object.keys(await retentionHorizon(read)).length === 0);
  resetRetentionHorizon();
  check('a database without the table (v115 not applied) reads as no horizon, not an error',
    Object.keys(await retentionHorizon(() => Promise.reject(new Error('relation "retention_state" does not exist')))).length === 0);
  await db.query(`INSERT INTO retention_state (tbl, action, done_before, bucket_min)
    VALUES ('telemetry_snapshot', 'thinned', '2025-09-04T00:00:00+04:00', 15),
           ('alert', 'removed', '2025-06-10T13:30:00+04:00', NULL)`);
  resetRetentionHorizon();
  const h = await retentionHorizon(read);
  check('a Dubai-midnight boundary is that day', h.telemetry_snapshot?.before === '2025-09-04', JSON.stringify(h.telemetry_snapshot));
  check('a mid-day boundary rounds UP, so "before <date>" never names a day already cut into',
    h.alert?.before === '2025-06-11', JSON.stringify(h.alert));
  check('the header value carries table, action, day and bucket',
    noteValue(h, ['telemetry_snapshot']) === 'telemetry_snapshot;thinned;2025-09-04;15');
}

/* The real app, with the middleware where the server puts it: before the
   routes, and — standing in for api/cache.js — a short-circuit after it that
   answers some paths without reaching any route, the way a cache hit does. */
const hit = (req, res, next) => (req.query.cachehit ? res.json({ cached: true }) : next());
const m = await mountAll(db, { pre: (app) => { app.use(retentionNotes({ read })); app.use(hit); } });
const head = async (p) => {
  const r = await fetch(`http://127.0.0.1:${m.port}${p}`);
  await r.text();
  return { status: r.status, note: r.headers.get('x-fm-retention') };
};
await db.query(`INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, status)
  VALUES ('uber', 'old-trip', 'ecosine', 'L1', '2025-08-20T10:00:00Z', 'completed'),
         ('uber', 'new-trip', 'ecosine', 'L1', '2026-11-01T10:00:00Z', 'completed')`);

console.log('\n3. set on exactly the answers whose window reaches past the boundary');
{
  resetRetentionHorizon();
  const a = await head('/api/vehicle/kpis?plate=L1&from=2025-08-01&to=2025-09-30');
  check('a vehicle window reaching past the boundary carries it (positions)', /telemetry_snapshot;thinned;2025-09-04;15/.test(a.note || ''), JSON.stringify(a));
  const b = await head('/api/vehicle/kpis?plate=L1&from=2026-10-01&to=2026-10-31');
  check('a window after the boundary carries nothing', !b.note, JSON.stringify(b));
  check('/api/coverage, about the whole record, always carries it', /telemetry_snapshot/.test((await head('/api/coverage')).note || ''));
  check('a day-param route: /api/where for a thinned day does', /telemetry_snapshot/.test((await head('/api/where?plate=L1&day=2025-09-01')).note || ''));
  check('and for a recent day does not', !(await head('/api/where?plate=L1&day=2026-11-01')).note);
  check('an instant-param route: /api/segment at a thinned instant does',
    /telemetry_snapshot/.test((await head('/api/segment?plate=L1&at=2025-09-01T10:00:00Z')).note || ''));
  check('/api/trip reads its own journey\'s date: an old trip does',
    /telemetry_snapshot/.test((await head('/api/trip?platform=uber&id=old-trip')).note || ''));
  check('and a recent trip does not', !(await head('/api/trip?platform=uber&id=new-trip')).note);
  check('the raw sampler only for the table it samples',
    !(await head('/api/schema/raw-fields?table=trip&from=2025-01-01&to=2025-12-31')).note
    && /telemetry_snapshot/.test((await head('/api/schema/raw-fields?table=telemetry_snapshot&from=2025-01-01&to=2025-12-31')).note || ''));
  const k = await head('/api/kpis?from=2025-01-01&to=2026-11-12');
  check('an alert reader past the alert boundary names alerts as REMOVED', /alert;removed;2025-06-11/.test(k.note || ''), JSON.stringify(k));
  check('a route that is not a reader carries nothing', !(await head('/api/revenue?from=2024-01-01&to=2026-11-12')).note);
  const c = await head('/api/vehicle/kpis?plate=L1&from=2025-08-01&to=2025-09-30&cachehit=1');
  check('a cache hit that never reaches the route still carries it', /telemetry_snapshot/.test(c.note || ''), JSON.stringify(c));
}

console.log('\n4. alertCoverage gives the true reason for removed days');
{
  const plain = alertCoverageOf(['2025-06-12'], '2025-06-01', '2025-06-20');
  check('without a boundary the wording is unchanged', plain.basis === 'measured over 1 of the 20 days in this window'
    && plain.removed_before === null && !plain.gaps.some((g) => g.removed), plain.basis);
  const cut = alertCoverageOf(['2025-06-12'], '2025-06-01', '2025-06-20', { removedBefore: '2025-06-11' });
  check('days before the boundary are marked removed, not dark', cut.gaps.some((g) => g.from === '2025-06-01' && g.removed)
    && /removed by retention/.test(cut.basis) && /not because the feed was dark/.test(cut.basis), cut.basis);
  const gone = alertCoverageOf([], '2025-01-01', '2025-03-31', { removedBefore: '2025-06-11' });
  check('a window wholly before the boundary is "not measured — removed", never "the feed produced nothing"',
    gone.basis === 'not measured — alerts before 2025-06-11 were removed by retention (RETENTION_ALERT_DAYS)', gone.basis);
  const after = alertCoverageOf(['2026-10-01'], '2026-10-01', '2026-10-01', { removedBefore: '2025-06-11' });
  check('a window after the boundary says nothing about retention', after.removed_before === null && !/retention/.test(after.basis));
  await db.query(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
    VALUES ('fms', 'a1', 'ecosine', 'L1', 'Harsh Brake', '2025-06-15T10:00:00Z')`);
  const live = await m.get('/api/alerts/by-driver?from=2025-06-01&to=2025-06-30');
  const basis = JSON.stringify(live.body || {});
  check('through a live route (/api/alerts/by-driver), the basis names retention', live.status === 200 && /removed by retention/.test(basis),
    `${live.status} ${basis.slice(0, 300)}`);
}

console.log('\n5. the front end reads it and words it truthfully');
{
  const parsed = parseRetentionHeader('telemetry_snapshot;thinned;2025-09-04;15,alert;removed;2025-06-11;,junk;;x');
  check('two entries parse, the malformed one is dropped', parsed.length === 2 && parsed[0].bucket_min === 15 && parsed[1].bucket_min === null,
    JSON.stringify(parsed));
  check('dates are words', dayWords('2025-09-04') === '4 Sep 2025');
  const s1 = retentionSentence(parsed[0]);
  check('positions: thinned to one fix per car per 15 min, and "not complete"', /one fix per car per 15 minutes/.test(s1) && /not complete/.test(s1), s1);
  const s2 = retentionSentence(parsed[1]);
  check('alerts: removed, and the days are "not covered for that reason"', /removed by retention/.test(s2) && /for that reason/.test(s2), s2);
  resetRetention();
  noteRetention('telemetry_snapshot;thinned;2025-09-01;15');
  noteRetention('telemetry_snapshot;thinned;2025-09-04;15');
  noteRetention(null);
  check('one line per table, the latest boundary wins', retentionNow().length === 1 && retentionNow()[0].before === '2025-09-04');
  resetRetention();
  check('reset clears it for the next page', retentionNow().length === 0);
  const data = (await import('node:fs')).readFileSync('api/public/data.js', 'utf8');
  check('data.js api() hands every answer\'s header over, beside x-fm-withheld',
    /noteRetention\(r\.headers\.get\('x-fm-retention'\)\)/.test(data));
  const app = (await import('node:fs')).readFileSync('api/public/app.js', 'utf8');
  const phone = (await import('node:fs')).readFileSync('api/public/m/app.js', 'utf8');
  check('both shells reset it per page and print it', /resetRetention\(\)/.test(app) && /retentionBanner\(\)/.test(app)
    && /resetRetention\(\)/.test(phone) && /retentionBanner\(\)/.test(phone));
  const sw = (await import('node:fs')).readFileSync('api/public/sw.js', 'utf8');
  check('the service worker precaches the module data.js now imports', /'\/retention_note\.js'/.test(sw));
}

console.log('\n6. /api/settings/retention: the record, and why when there is none');
{
  await db.query('DELETE FROM retention_run');
  const none = await m.get('/api/settings/retention');
  check('before any pass: no record, the reason, and the settings the first pass will read',
    none.status === 200 && none.body.last === null && /no retention pass has run yet/.test(none.body.absent)
    && none.body.next.mode === 'dry_run' && none.body.next.schedule.utc === '19:53', JSON.stringify(none.body).slice(0, 300));
  await dataRetentionPass({ db, read: (k, d) => d });
  const one = await m.get('/api/settings/retention');
  const tbls = (one.body.last?.tables || []).map((t) => t.tbl).sort().join(',');
  check('after a pass: the run, its five tables, and the boundary pages read',
    one.body.last?.mode === 'dry_run' && tbls === 'alert,collection_run,driver_timeline_event,telemetry_snapshot,trip'
    && one.body.state.some((s) => s.tbl === 'telemetry_snapshot') && one.body.absent === null, JSON.stringify(one.body).slice(0, 400));
  check('considered / would remove / removed are on each table row',
    (one.body.last?.tables || []).every((t) => 'considered' in t && 'would_delete' in t && 'deleted' in t));
}

m.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
