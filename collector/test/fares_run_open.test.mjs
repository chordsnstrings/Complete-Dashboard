/* "Fetch Uber fares (last 2 days)" needs no admin token.
   ──────────────────────────────────────────────────────────────────────────
   The operator pressed the button on 2026-10-07 and production asked for the
   admin token — the button posted to /api/settings/trigger, which sits behind
   requireAdmin, and ADMIN_TOKEN is set there. Ruling: "stop admin token check
   on this one". It now posts to POST /api/uber/fares/run, which, like
   /api/analyst/run, has no gate and keeps the duplicate guard.

   The shared harness stubs requireAdmin to a pass-through, so no other suite
   can tell a gated route from an open one. This mounts the REAL adminGate with
   a synthetic token configured — production's condition — and asks with none. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { adminGate } from '../api/admin_gate.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const requireAdmin = adminGate({ env: { ADMIN_TOKEN: 'synthetic-admin-token' } });
const { server, port } = await mountAll(db, { inject: { requireAdmin } });
const post = (path, body = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

console.log('\nwith ADMIN_TOKEN configured and a caller holding none');
const gated = await post('/api/settings/trigger', { mode: 'probe' });
check('the admin-gated trigger refuses — so the gate in this mount is real', [401, 403].includes(gated.status),
  String(gated.status));
const r1 = await post('/api/uber/fares/run');
const b1 = await r1.json().catch(() => ({}));
check('the Uber fares pass is queued all the same', r1.status === 200 && b1.queued === 'fares' && !!b1.job_id,
  `${r1.status} ${JSON.stringify(b1).slice(0, 160)}`);
const [job] = (await db.query(`SELECT mode, fleet, status FROM collector_job WHERE id = $1`, [b1.job_id ?? -1])).rows;
check('…as a fares job for both fleets, which the worker runs as fareRefresh(2)',
  job?.mode === 'fares' && job?.fleet === null && job?.status === 'queued', JSON.stringify(job));
const r2 = await post('/api/uber/fares/run');
check('…and a second press while it is queued is refused, not queued twice', r2.status === 409, String(r2.status));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
