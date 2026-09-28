/* The park ledger answers for the fleet it is asked about.
   ─────────────────────────────────────────────────────────────────────────
   GET /api/finance/ledger bound the platform and never read
   ledger_entry.fleet_id, so ?fleet=egari returned Ecosine's Yango park
   ledger summed in with Egari's, under an Egari heading. Once a reader can be
   limited to one fleet (ULM-DESIGN §5, the access gate rewrites their ?fleet=
   to their own), the same defect would have handed a one-fleet reader the
   other fleet's money. Found by the route-classification pass on 2026-09-28.

   REVERSION: drop `AND ($4::text IS NULL OR fleet_id=$4)` from the handler in
   api/server.js — "Egari sees only Egari's ledger" fails with both fleets'
   sum. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() - 3 * 864e5));
let n = 0;
const entry = (fleet, category, amount) => db.query(
  `INSERT INTO ledger_entry (platform, external_id, fleet_id, event_at, category, amount, currency)
   VALUES ('yango', $1, $2, $3::timestamptz, $4, $5, 'AED')`,
  [`t${++n}`, fleet, `${DAY}T12:00:00+04`, category, amount]);
await entry('ecosine', 'platform_fees', -100);
await entry('ecosine', 'platform_fees', -50);
await entry('egari', 'platform_fees', -7);
await entry('egari', 'cash_collected', 30);

const { get } = await mountAll(db, { serverRoutes: true });
const W = `from=${DAY}&to=${DAY}`;
const sum = (rows, cat) => rows.filter((r) => r.category === cat).reduce((a, r) => a + Number(r.amount), 0);

console.log('\nthe park ledger and the fleet filter');
const both = (await get(`/api/finance/ledger?${W}`)).body;
check('no fleet asked: both fleets, as before', sum(both, 'platform_fees') === -157, JSON.stringify(both));
const eg = (await get(`/api/finance/ledger?${W}&fleet=egari`)).body;
check('Egari sees only Egari’s ledger', sum(eg, 'platform_fees') === -7 && sum(eg, 'cash_collected') === 30, JSON.stringify(eg));
const ec = (await get(`/api/finance/ledger?${W}&fleet=ecosine`)).body;
check('Ecosine sees only Ecosine’s', sum(ec, 'platform_fees') === -150 && !ec.some((r) => r.category === 'cash_collected'), JSON.stringify(ec));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
