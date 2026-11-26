/* CABMAN's clock-skew alarm judges only fixes new since the last poll
   (2026-11-26; the audit of 2026-11-25).
   ──────────────────────────────────────────────────────────────────────────
   The alarm raised 109 ERRORs in one night, all between 01:50 and 09:05 Dubai,
   on both fleets, and none in the day. Every one had the same shape: median
   lag 187–409 minutes, freshest decile 20–269, as few as 5 vehicles reporting.
   Nearly every car was parked. The alarm took "even the freshest fix is old"
   for a wrong clock, but at night nobody has just reported, so age cannot tell
   a wrong clock from a parked fleet.

   A NEW fix can. A healthy tracker's new fix is minutes old; a clock or
   timezone error makes it arrive an hour off, behind or in the future; a
   parked fleet sends none, which is no evidence of anything.

     §1  through pullLive, with the provider mocked:
         · a parked fleet at night, hours-old fixes repeated poll after poll:
           silent (the old alarm fired on every poll);
         · a healthy fleet sending fresh fixes: silent;
         · every new fix an hour behind (the gmt field's timezone changed):
           ERROR, "arrive already old";
         · every new fix an hour in the future: ERROR, "stamped in the
           future" (the old alarm could not see this at all);
         · two plates' stale new fixes: not enough to judge, silent;
         · the first poll after a restart, stale: no baseline, silent;
     §2  skewVerdict's thresholds and its baseline, directly.

   Synthetic data only. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { pool } from '../src/db.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
pool.query = (t, p) => db.query(t, p);
pool.connect = async () => ({
  query: (t, p) => (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(String(t).trim())
    ? Promise.resolve({ rows: [] }) : db.query(t, p)),
  release: () => {},
});
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine', 'Ecosine') ON CONFLICT DO NOTHING`);
process.env.CABMAN_ECOSINE_PASS = 'test-password';
process.env.CABMAN_ECOSINE_ID = '81';
process.env.CABMAN_ECOSINE_USER = 'admin_ecosine';

let payload = [];
globalThis.fetch = async () => new Response(JSON.stringify({ IVDDataResult: payload }),
  { status: 200, headers: { 'content-type': 'application/json' } });
const gmtAt = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString().replace('T', ' ').slice(0, 19);
const fixes = (plates, minutesAgo) => plates.map((p, i) => ({
  VehicleID: p, gmt: gmtAt(typeof minutesAgo === 'function' ? minutesAgo(i) : minutesAgo), lat: 25.2, lng: 55.3,
  speed: 0, state: '0', Status: 'Stopped', SeatSensorValue: '0', odometer: 1000,
}));

const raised = [];
console.error = (...a) => { raised.push({ level: 'error', line: a.join(' ') }); };
console.warn = (...a) => { raised.push({ level: 'warn', line: a.join(' ') }); };
const skewErrors = (from) => raised.slice(from).filter((r) => r.level === 'error' && /clock skew/.test(r.line));

const { pullLive, skewVerdict } = await import('../src/sources/cabman.js');
const poll = async (p) => { payload = p; const from = raised.length; await pullLive(); return skewErrors(from); };
const plates = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(3, '0')}`);

/* ── §1 ─────────────────────────────────────────────────────────────────── */
console.log('\n§1 through pullLive');
{
  /* A parked fleet at night: 10 cars, last fixes 3–6 hours old, the same
     fixes returned on three polls running — the production shape. */
  const P = plates('LPARK', 10);
  const night = fixes(P, (i) => 180 + i * 20);
  const e1 = await poll(night); const e2 = await poll(night); const e3 = await poll(night);
  check('a parked fleet at night, hours-old fixes poll after poll: no clock-skew ERROR (the old alarm fired every poll)',
    e1.length + e2.length + e3.length === 0, JSON.stringify([...e1, ...e2, ...e3].map((e) => e.line.slice(0, 120))));
}
{
  const P = plates('LMOVE', 10);
  await poll(fixes(P, (i) => 3 + i));
  const e = await poll(fixes(P, (i) => i * 0.2));
  check('a healthy fleet sending fresh fixes: silent', e.length === 0, JSON.stringify(e.map((x) => x.line.slice(0, 120))));
}
{
  /* The gmt field's timezone changed: every new fix lands an hour old. */
  const P = plates('LBEHIND', 10);
  await poll(fixes(P, 75));
  const e = await poll(fixes(P, (i) => 61 + i * 0.1));
  check('every new fix an hour behind: ERROR, "new fixes arrive already old"', e.length === 1 && /arrive already old/.test(e[0].line)
    && /"new_fixes":10/.test(e[0].line), JSON.stringify(e.map((x) => x.line.slice(0, 200))));
}
{
  const P = plates('LAHEAD', 10);
  await poll(fixes(P, 5));
  const e = await poll(fixes(P, (i) => -60 - i * 0.1));
  check('every new fix an hour in the future: ERROR, "stamped in the future" — which the old alarm could not see',
    e.length === 1 && /stamped in the future/.test(e[0].line), JSON.stringify(e.map((x) => x.line.slice(0, 200))));
}
{
  /* Two cars wake from the night with stale new fixes; eight stay parked. */
  const P = plates('LFEW', 10);
  const first = fixes(P, 300);
  await poll(first);
  const next = first.map((f, i) => (i < 2 ? { ...f, gmt: gmtAt(45) } : f));
  const e = await poll(next);
  check('two plates\' stale new fixes are not enough to judge: silent', e.length === 0, JSON.stringify(e.map((x) => x.line.slice(0, 120))));
}
{
  const e = await poll(fixes(plates('LBOOT', 10), 240));
  check('the first poll after a restart has no baseline, however stale: silent', e.length === 0);
}

/* ── §2 ─────────────────────────────────────────────────────────────────── */
console.log('\n§2 skewVerdict, directly');
const NOW = '2026-11-25T23:00:00.000Z';
const at = (min) => new Date(Date.parse(NOW) - min * 60000).toISOString();
const rowsAt = (mins) => mins.map((m, i) => ({ plate: `P${i}`, captured_at: at(m) }));
const seenAt = (mins) => new Map(mins.map((m, i) => [`f|P${i}`, Date.parse(at(m))]));
check('new fixes 25 min behind: "behind"', skewVerdict(rowsAt([25, 26, 27]), NOW, seenAt([40, 40, 40]), 'f').verdict === 'behind');
check('new fixes 15 min behind: within the poll and the provider\'s latency, "ok"', skewVerdict(rowsAt([15, 15, 15]), NOW, seenAt([40, 40, 40]), 'f').verdict === 'ok');
check('new fixes 15 min ahead: "ahead"', skewVerdict(rowsAt([-15, -15, -15]), NOW, seenAt([40, 40, 40]), 'f').verdict === 'ahead');
check('fixes no newer than last time: "no_evidence", however old', skewVerdict(rowsAt([400, 400, 400]), NOW, seenAt([400, 400, 400]), 'f').verdict === 'no_evidence');
const seen = seenAt([400, 400, 400]);
const v = skewVerdict(rowsAt([2, 400, 400]), NOW, seen, 'f');
check('…the baseline moves to each plate\'s newest fix; vehicles outside a day are counted as dormant, not as lag',
  v.newFixes === 1 && seen.get('f|P0') === Date.parse(at(2))
    && skewVerdict(rowsAt([2, 3000]), NOW, new Map(), 'f').dormant === 1, JSON.stringify(v));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
