/* The 09:00 Dubai fare pass asks Uber for prices and for nothing else.
   ──────────────────────────────────────────────────────────────────────────
   Measured 2026-10-07: Tue 6 Oct carried a fare on 801 of 851 completed Uber
   trips (92.1% of the day's bookings across channels) the morning after, and
   the Target page held it "unsettled" until the next night. The trips were all
   there — the half-hourly incremental had them by 01:30 — but the per-trip
   fare comes only from the payments report, and only the 01:00 catch-up asked
   for it, before Uber had priced the late trips. src/run.js fareRefresh now
   asks again at 09:00, through collect({ mode: 'fares' }).

   What is pinned is the cost of that pass: it must ask for the payments report
   ALONE. A fares pass that also walked trips, earnings and quality would be a
   second catch-up every morning, spending Uber's report slots on surfaces the
   incremental already keeps current. And the incremental must still not ask
   for fares — that rule (uber.js, "Not on the incremental") is unchanged.

   The provider is mocked and refuses every report, so each mode stops at its
   first ask of each surface; what is recorded is which report types it
   asked for. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { pool } from '../src/db.js';

const db = new PGlite();
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
pool.query = (t, p) => db.query(t, p);
pool.connect = async () => ({
  query: (t, p) => (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(String(t).trim())
    ? Promise.resolve({ rows: [] }) : db.query(t, p)),
  release: () => {},
});

process.env.UBER_WEB_COOKIE = 'sid=synthetic';   // a session to ask with; the provider below refuses anyway
const asked = [];
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('GenerateReport')) {
    try { asked.push(JSON.parse(opts.body).reportType); } catch { asked.push('unreadable'); }
    return new Response(JSON.stringify({ status: 'failure', data: { meta: { details: 'synthetic refusal' } } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
console.error = () => {}; console.warn = () => {}; console.log = ((l) => (...a) => {
  if (/^\s*[✓✗]|passed,|^\n/.test(String(a[0]))) l(...a);
})(console.log);

const { collect } = await import('../src/sources/uber.js');
const to = new Date();
const from = new Date(to.getTime() - 24 * 3600 * 1000);

console.log('\nthe morning fare pass');
asked.length = 0;
await collect({ from, to, mode: 'fares' });
const fares = [...asked];
check('asks for the payments report', fares.includes('REPORT_TYPE_PAYMENTS_ORDER'), JSON.stringify(fares));
check('…and for no other report — no trips, earnings or quality',
  fares.length > 0 && fares.every((t) => t === 'REPORT_TYPE_PAYMENTS_ORDER'), JSON.stringify(fares));
const runRows = (await db.query(`SELECT mode, status, error FROM collection_run WHERE source = 'uber'`)).rows;
const runs = runRows.map((r) => r.mode);
check('…and records its run under its own mode, so /api/status can tell it from a catch-up',
  runs.includes('fares'), JSON.stringify(runs));

console.log('\nthe half-hourly incremental is unchanged');
asked.length = 0;
await collect({ from, to, mode: 'incremental' });
check('asks for trips first', asked[0] === 'REPORT_TYPE_TRIP_ACTIVITY', JSON.stringify(asked));
check('…and never for fares', !asked.includes('REPORT_TYPE_PAYMENTS_ORDER'), JSON.stringify(asked));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
