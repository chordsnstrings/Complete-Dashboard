/* THE MONEY THE NEXT TRIP EXPORT USED TO DESTROY.
   ══════════════════════════════════════════════════════════════════════════
   `trip.raw` is written by two passes that know different things. The trip
   export carries the RIDE (src/sources/uber.js:202, `raw: r`). The payments
   walk merges the MONEY into the same column afterwards — uber.js:641-644
   does `raw = coalesce(raw,'{}'::jsonb) || $4::jsonb`, adding a
   `uber_payments` key holding per-trip earnings, service_fee, cash_collected
   and tip.

   Then the next export ran, upsertMany built `raw=EXCLUDED.raw`, and the
   money was gone — replaced wholesale by a blob that never had it.

   MEASURED ON PRODUCTION 2026-09-22, before the fix: person 202's two cash
   trips on 2026-09-18 both returned `trip_money: null` through /api/trip,
   while every sampled trip up to 2026-09-16 returned a full blob with
   `commission_pct: 25`. The gap sat on the most recent days — exactly the
   ones an operator looks at — and it MOVED rather than healed: the next
   payments walk restored the figures and the next export destroyed them
   again.

   This matters beyond tidiness. The per-trip `cash_collected` is what tells
   a driver's statement how much cash they are actually holding, and the
   per-trip `service_fee` is the commission on that ride. A register built
   over a clobbered blob reports a driver holding nothing on the days they
   most recently drove.

   Four things are asserted here, and the last two are the ones a naive fix
   gets wrong. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await db.exec(`
  CREATE TABLE trip (
    platform TEXT NOT NULL, external_id TEXT NOT NULL,
    price NUMERIC(12,2), status TEXT, raw JSONB,
    PRIMARY KEY (platform, external_id)
  );
  CREATE TABLE plain (k TEXT PRIMARY KEY, raw JSONB);
`);

const fakePool = {
  async connect() {
    return { query: async (t, p) => db.query(t, p), release() {} };
  },
  query: (t, p) => db.query(t, p),
};

/* Re-created FROM THE SHIPPED SOURCE, helpers included — see the PRELUDE note
   in test/upsert.test.mjs for why the slice must carry what sits above it. */
const src = readFileSync('src/db.js', 'utf8');
const PRELUDE = src.slice(src.indexOf('const JSONB_MERGE'), src.indexOf('// Upsert one row into'));
const body = src.slice(src.indexOf('export async function upsertMany'))
  .replace('export async function upsertMany', 'async function upsertMany');
const end = body.indexOf('\n}\n', body.indexOf('return n;')) + 2;
// eslint-disable-next-line no-new-func
const upsertMany = new Function('pool', `${PRELUDE}\n${body.slice(0, end)}; return upsertMany;`)(fakePool);

const rawOf = async (id = 't1') =>
  (await db.query(`SELECT raw FROM trip WHERE external_id = $1`, [id])).rows[0]?.raw;
const xminOf = async (id = 't1') =>
  (await db.query(`SELECT xmin::text x FROM trip WHERE external_id = $1`, [id])).rows[0]?.x;

console.log('\nthe money survives the next export');

/* 1. The export writes the ride. */
await upsertMany('trip', [{ platform: 'uber', external_id: 't1', price: 29.83,
  status: 'completed', raw: { ride: 'first export', product: 'Electric' } }],
['platform', 'external_id']);

/* 2. The payments walk merges the money in, exactly as uber.js:641-644 does. */
await db.query(
  `UPDATE trip SET raw = coalesce(raw, '{}'::jsonb) || $1::jsonb
    WHERE platform = 'uber' AND external_id = 't1'`,
  [JSON.stringify({ uber_payments: { earnings: 22, service_fee: -7.46,
    cash_collected: -67.13, commission_pct: 25 } })]);
check('the walk lands the per-trip money', (await rawOf())?.uber_payments?.cash_collected === -67.13,
  JSON.stringify(await rawOf()));

/* 3. THE DEFECT: the export runs again with a blob that never had the money. */
await upsertMany('trip', [{ platform: 'uber', external_id: 't1', price: 29.83,
  status: 'completed', raw: { ride: 'second export', product: 'Electric' } }],
['platform', 'external_id']);

const after = await rawOf();
check('the per-trip cash is STILL THERE after a re-export',
  after?.uber_payments?.cash_collected === -67.13, JSON.stringify(after));
check('and so is the per-trip service fee',
  after?.uber_payments?.service_fee === -7.46, JSON.stringify(after));

/* 4. The incoming blob still WINS on a key it carries — a merge that let the
      stored value win would freeze a restated ride value forever, which is
      the opposite defect and just as quiet. */
check('a key the export restates is updated, not preserved',
  after?.ride === 'second export', JSON.stringify(after));

console.log('\nand it does not cost a write that changes nothing');

/* THE SUBTLE ONE. The guard reads `stored IS DISTINCT FROM <what we would
   write>`. Compare against EXCLUDED and it is true on every re-export of an
   enriched row — the stored blob legitimately holds a key the incoming one
   lacks — so an UPDATE that changes not one byte fires on every tick, which
   is the dead-tuple cost src/db.js's guard exists to prevent. It must compare
   the MERGED expression. */
const before = await xminOf();
await upsertMany('trip', [{ platform: 'uber', external_id: 't1', price: 29.83,
  status: 'completed', raw: { ride: 'second export', product: 'Electric' } }],
['platform', 'external_id']);
check('re-exporting an identical enriched row rewrites nothing',
  (await xminOf()) === before, `xmin ${before} -> ${await xminOf()}`);

await upsertMany('trip', [{ platform: 'uber', external_id: 't1', price: 31.00,
  status: 'completed', raw: { ride: 'second export', product: 'Electric' } }],
['platform', 'external_id']);
check('while a row that genuinely changed is still written',
  (await xminOf()) !== before, 'the guard swallowed a real change');
check('and the money survived that too',
  (await rawOf())?.uber_payments?.commission_pct === 25, JSON.stringify(await rawOf()));

console.log('\nonly trip merges — every other table still replaces');

/* The rule is table-driven and narrow ON PURPOSE. A blanket jsonb merge would
   make every raw column in the schema un-clearable: a provider that STOPS
   sending a field could never remove it, and the row would keep asserting a
   value nobody still reports. */
await upsertMany('plain', [{ k: 'a', raw: { one: 1 } }], ['k']);
await upsertMany('plain', [{ k: 'a', raw: { two: 2 } }], ['k']);
const plain = (await db.query(`SELECT raw FROM plain WHERE k = 'a'`)).rows[0].raw;
check('a non-merge table replaces its blob wholesale', plain.one === undefined && plain.two === 2,
  JSON.stringify(plain));

console.log(`\n${fail ? '✗' : '✓'} trip_raw_merge: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
