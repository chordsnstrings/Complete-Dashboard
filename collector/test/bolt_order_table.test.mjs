/* ── the Bolt portal call that never once returned a row ───────────────────
   Bolt has been a configured source for the life of this project and the trip
   table holds nothing from it. That read as a credential problem, and it was
   not: asked on 2026-09-03 with two freshly-minted access tokens, both fleets'
   refresh tokens exchange cleanly and the order table answers, verbatim,

     {"code":702,"message":"INVALID_REQUEST","validation_errors":[
        {"error":"Is required","property":"limit"},
        {"error":"Is required","property":"offset"}]}

   The endpoint had been naming the fault all along, in a response body nothing
   read. Three separate defects sat behind the zero:

     1. limit and offset are required and were never sent.
     2. The window may not exceed 30 days. 31 gives DATE_RANGE_TOO_BIG, so any
        backfill has to be chunked.
     3. THE RESPONSE HAS NO `orders` ARRAY. It is column-oriented —
        data.columns[i].cells[n] is field i of row n — so the reader's
        `data?.data?.orders || []` could only ever be empty, and the log line
        beside it reported a healthy empty window over 547 real trips.

   The fixture below is a real captured response for the Egari fleet, 50 rows
   of a 156-row window. */
import { readFileSync } from 'node:fs';
import { pivot, portalRow } from '../src/sources/bolt.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nbolt: the order table, as the portal actually serves it');

const FX = JSON.parse(readFileSync('test/fixtures/bolt_order_table.json', 'utf8'));
const C = { fleet: 'egari', companyId: 142897, userId: 174036 };

/* ── the pivot ───────────────────────────────────────────────────────────── */
check('the fixture is the shape that broke the old reader — columns, not orders',
  Array.isArray(FX.data.columns) && FX.data.orders === undefined);
const rows = pivot(FX.data);
check('one row per cell index, not one per column',
  rows.length === FX.data.columns[0].cells.length, `${rows.length}`);
check('and the window total is bigger than the page, so paging is required',
  FX.data.total_rows > rows.length, `${FX.data.total_rows} vs ${rows.length}`);
check('a row carries every column', Object.keys(rows[0]).length === FX.data.columns.length);
check('keyed by the column key, so a reordered column changes nothing',
  'car_reg_number' in rows[0] && 'partner_identifier' in rows[0]);
check('the old reader would have found nothing here',
  (FX.data.orders || []).length === 0);
check('an empty or absent payload pivots to nothing rather than throwing',
  pivot(null).length === 0 && pivot({}).length === 0 && pivot({ columns: [] }).length === 0);

/* ── the key ─────────────────────────────────────────────────────────────── */
/* partner_identifier LOOKS like an order id — a uuid, one value per row — and
   using it would have collapsed the fleet's trips onto a handful of rows. */
const pid = new Set(rows.map((r) => r.partner_identifier));
const drv = new Set(rows.map((r) => r.driver?.id));
check('partner_identifier is the DRIVER, not the order',
  pid.size === drv.size && pid.size < rows.length,
  `${pid.size} identifiers, ${drv.size} drivers, ${rows.length} rows`);

const mapped = rows.map((r) => portalRow(r, C));
check('every row gets a key', mapped.every((r) => r.external_id));
check('and the keys are unique, which partner_identifier was not',
  new Set(mapped.map((r) => r.external_id)).size === mapped.length,
  `${new Set(mapped.map((r) => r.external_id)).size} of ${mapped.length}`);
check('the key is driver and second, and holds no correctable field',
  /^\d+\|\d+$/.test(mapped[0].external_id) && !mapped[0].external_id.includes(mapped[0].plate),
  mapped[0].external_id);
/* A row the portal cannot identify is dropped rather than given a key that
   would collide with the next one like it. */
check('a row with no driver is dropped, not keyed as undefined',
  portalRow({ created: 1788417701 }, C).external_id === null);
check('and so is one with no timestamp',
  portalRow({ driver: { id: '1' }, created: 0 }, C).external_id === null);

/* ── the fields ──────────────────────────────────────────────────────────── */
const done = mapped.find((r) => r.status === 'finished');
check('a finished ride carries a plate', /^L\d+$/.test(done.plate), done.plate);
check('and the driver, by id and by name',
  done.driver_ext_id && done.driver_name, `${done.driver_ext_id} ${done.driver_name}`);
check('and both ends of the route',
  done.pickup_addr && done.dropoff_addr && done.pickup_addr !== done.dropoff_addr);
check('and a distance and a fare', done.distance_km > 0 && done.price > 0,
  `${done.distance_km}km ${done.price}`);
/* Unix SECONDS, not milliseconds — read as ms these land in January 1970. */
check('timestamps are seconds, and land in the window asked for',
  done.requested_at.startsWith('2026-') && done.ended_at.startsWith('2026-'),
  `${done.requested_at} .. ${done.ended_at}`);
check('the ride ends after it starts', new Date(done.ended_at) > new Date(done.requested_at));

/* 0 is the portal's way of writing "did not happen" — a cancelled ride carries
   fare_finalised 0 — and 0 read as a timestamp is 1970. */
const gone = mapped.find((r) => r.status !== 'finished');
check('a cancelled ride is present, not filtered away', !!gone, 'the page needs cancellations');
check('and its missing end time is null rather than 1970',
  gone.ended_at === null, String(gone.ended_at));
check('a multi-stop route reports its LAST stop as the dropoff',
  (() => { const r = rows.find((x) => (x.route || []).length > 2);
    return !r || portalRow(r, C).dropoff_addr === r.route[r.route.length - 1]; })());
/* The fees Bolt itemises are kept out of `price`: folding a booking fee into
   the fare would silently change what every per-trip figure in this product
   means. */
const fee = rows.find((r) => Number(r.booking_fee) > 0);
check('the itemised fees stay out of the fare',
  !fee || portalRow(fee, C).price === Number(fee.price), fee ? `${fee.price} + ${fee.booking_fee}` : 'none');
check('but they are kept, in raw', !fee || portalRow(fee, C).raw.booking_fee === fee.booking_fee);
check('every row is filed to the fleet it was asked for',
  mapped.every((r) => r.fleet_id === 'egari' && r.platform === 'bolt'));

/* ── the limits are in the code, not in a comment ────────────────────────── */
const SRC = readFileSync('src/sources/bolt.js', 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the page size is the measured maximum', /PORTAL_PAGE = 100\b/.test(SRC));
check('the window bound is the measured maximum', /PORTAL_MAX_DAYS = 30\b/.test(SRC));
check('both are sent on every request',
  /limit: PORTAL_PAGE, offset/.test(SRC), 'the request that started all this omitted them');
check('the window is chunked rather than asked for whole',
  /dayChunks\(from, to, PORTAL_MAX_DAYS\)/.test(SRC));
check('paging stops on total_rows, not on a short page alone',
  /total_rows/.test(SRC));
check('a refusal is recorded against the credential rather than swallowed',
  /state: 'invalid'[\s\S]{0,120}?detail: says|detail: says/.test(SRC));
/* The third instance of this defect in this codebase — fms.js and yango.js
   both had it. A credential that can only be written 'invalid' keeps the last
   red row it was given for ever. */
check('and a working token is recorded as working, so the red row can clear',
  /state: 'ok', surface: 'orderHistory'/.test(SRC));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
