/* ── the transaction report's verdict on the wire register ─────────────────
   WHY THIS EXISTS. The register is built from
   REPORT_TYPE_PAYMENTS_ORGANIZATION, one aggregate row per request and no date
   column, so it is asked a day at a time and the walk asks MONDAYS FIRST.
   Measured on production 2026-09-17: twenty payout dates across seventeen
   months (2025-04-07 to 2026-09-14) and every one is a Monday.

   Which makes the cadence very likely and NOT CHECKED, and the walk cannot
   check it — it asks Mondays first precisely because that is where wires are,
   so a Thursday wire is the last thing it reaches or the thing it never
   reaches. REPORT_TYPE_PAYMENTS_ORDER settles it: probed on production, it is
   per transaction (399+ rows for one day), the wire is a row of it
   (Description = 'so.payout', carrying -111,179.66 on 2026-09-14 — the figure
   the operator confirmed against their bank), and every row is dated by a
   column called 'vs reporting'.

   WHAT IS ASSERTED HERE. Not the HTTP — that is Uber's, and the probe on
   production is what established it. What rots is the PARSING and the
   RECONCILIATION: which rows count as a wire, how they are dated, and — the
   part that matters most — that a disagreement between two Uber reports is
   surfaced rather than resolved by writing order. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { ORDER_COLUMNS, PAYOUT_MARK } from '../src/sources/uber_payout_orders.js';
import { pathKey, money } from '../src/sources/uber_payout.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);

console.log('\nthe schema the server applies carries the audit');

const cols = (await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name = 'platform_payout'`))
  .rows.map((r) => r.column_name);
check('platform_payout carries what the transaction report said',
  cols.includes('audit_amount') && cols.includes('audited_at'), JSON.stringify(cols));
const tabs = (await db.query(
  `SELECT table_name FROM information_schema.tables WHERE table_name = 'payout_audit'`)).rows;
check('payout_audit exists, so a checked window can be named', tabs.length === 1);

console.log('\nwhich rows of the report are a wire, and how they are dated');

/* The header spellings are the provider's, folded through the SAME pathKey the
   organisation reader uses — one spelling rule for both reports, so a provider
   that re-spaces a header breaks both or neither. These are the real strings
   the probe returned on 2026-09-14. */
const HEADERS = ['transaction UUID', 'Description', 'vs reporting',
  'Paid to you:Trip balance:Payouts:Transferred To Bank Account'];
check('the description column folds to what the reader looks up',
  pathKey('Description') === ORDER_COLUMNS.description);
check('…and the date column does',
  pathKey('vs reporting') === ORDER_COLUMNS.at);
check('…and the bank column does, colons, spaces and capitals included',
  pathKey('Paid to you:Trip balance:Payouts:Transferred To Bank Account') === ORDER_COLUMNS.bank,
  pathKey('Paid to you:Trip balance:Payouts:Transferred To Bank Account'));
check('every column the reader needs is in the real header',
  Object.values(ORDER_COLUMNS).every((c) => HEADERS.map(pathKey).includes(c)));

/* The four Description values the probe saw. Only one of them is a transfer,
   and a reader that matched loosely on "payout" would also take the cash
   collected line, which is money that never reached the bank. */
const SEEN = ['trip completed order', 'so.payout',
  'Business Order for: marketplace: PERSONAL_TRANSPORT', 'trip fare adjust order'];
check('exactly one of the provider’s description values marks a transfer',
  SEEN.filter((d) => d.trim().toLowerCase() === PAYOUT_MARK).length === 1);

/* money() is the organisation reader's, and the distinction it draws is the
   one that matters here too: '' is not 0. A so.payout row whose bank column is
   blank is a row this module cannot interpret, and the collector skips it
   rather than writing a transfer of nothing. */
/* money('') is 0 and that is DELIBERATE — its own comment records why: on the
   organisation report a blank bank column means "no transfer happened that
   day", which is a measurement and not an absence. The ORDER report asks a
   different question: a so.payout row whose bank column is blank is a payout
   line carrying no amount, which this module cannot interpret. So the reader
   does not lean on money() to tell it apart — it skips on `!amt`, which takes
   both the blank and a literal zero, and neither becomes a transfer. */
check('a blank bank column reads as zero, as the daily report needs',
  money('') === 0, String(money('')));
check('…and the audit’s own guard refuses a zero rather than writing a wire of nothing',
  !money('') && !money('0'), `${money('')} ${money('0')}`);
check('the wire is read through the thousands separator',
  money('-111,179.66') === -111179.66, String(money('-111,179.66')));

console.log('\na disagreement between two Uber reports is kept, not resolved');

/* THE RULE THIS FILE EXISTS FOR. The audit writes what the transaction report
   said into audit_amount and NEVER into amount. Two Uber reports differing
   about one transfer is a finding; resolving it by writing order would destroy
   the only evidence that they differ. */
await db.query(
  `INSERT INTO platform_payout (platform, fleet_id, payout_ext_id, paid_on, amount, currency,
                                method, source)
   VALUES ('uber','ecosine','ecosine:2026-08-31','2026-08-31', 77796.52, 'AED', 'bank', 'stmt')`);
await db.query(
  `INSERT INTO platform_payout (platform, fleet_id, payout_ext_id, audit_amount, audited_at,
                                paid_on, amount, currency, method, source)
   VALUES ('uber','ecosine','ecosine:2026-08-31', 77796.02, now(), '2026-08-31', 77796.52,
           'AED','bank','stmt')
   ON CONFLICT (platform, fleet_id, payout_ext_id)
   DO UPDATE SET audit_amount = EXCLUDED.audit_amount, audited_at = EXCLUDED.audited_at`);
const [row] = (await db.query(
  `SELECT amount::float8 AS amount, audit_amount::float8 AS audit_amount
     FROM platform_payout WHERE payout_ext_id = 'ecosine:2026-08-31'`)).rows;
check('the register’s own figure is untouched by the audit', row.amount === 77796.52,
  String(row.amount));
check('…and the transaction report’s figure travels beside it',
  row.audit_amount === 77796.02, String(row.audit_amount));
check('…so the difference is computable rather than lost',
  Math.round((row.audit_amount - row.amount) * 100) / 100 === -0.5);

console.log('\na window nobody audited is not a window with nothing missed');

await db.query(
  `INSERT INTO payout_audit (platform, fleet_id, period_start, period_end, outcome,
                             wires_found, wires_new)
   VALUES ('uber','ecosine','2026-08-18','2026-09-17','audited', 5, 1)`);
await db.query(
  `INSERT INTO payout_audit (platform, fleet_id, period_start, period_end, outcome, detail)
   VALUES ('uber','ecosine','2026-07-18','2026-08-17','refused','the limiter shut')`);
const audited = (await db.query(
  `SELECT to_char(period_start,'YYYY-MM-DD') AS s FROM payout_audit
    WHERE outcome = 'audited' ORDER BY period_start`)).rows.map((r) => r.s);
check('only a window that was READ counts as checked',
  audited.length === 1 && audited[0] === '2026-08-18', JSON.stringify(audited));
/* REVERSION: let the route count 'refused' windows as audited and the page
   would tell an operator a month was clear on the strength of a limiter
   outage — the exact shape of claim this product exists to refuse. */

console.log(`\n${pass} passed, ${fail} failed`);
await db.close();
process.exit(fail ? 1 : 0);
