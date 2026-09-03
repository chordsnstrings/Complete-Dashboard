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
import { pivot, portalRow, harvestPortal } from '../src/sources/bolt.js';

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
  /dayChunks\(from, end, maxDays\)/.test(SRC) && /maxDays = PORTAL_MAX_DAYS/.test(SRC));
/* `end`, not `to`: an end_date in the FUTURE is refused outright — measured on
   the live portal, 2026-09-03 answered with 79 orders and 2026-09-04 answered
   INVALID_REQUEST (code 702) — so a run whose window ends tomorrow loses today,
   the most valuable window there is. Clamped here because it is a fact about
   this provider, not about any one caller. */
check('and its end date is clamped to today, because the future is refused',
  /const end = day\(to\) > today \? today : day\(to\)/.test(SRC));
/* Newest-first is not a style choice: it is what makes the rolling retention
   edge cost one refused request instead of one per window past it. */
check('and walked newest-window-first',
  /\[\.\.\.dayChunks\([^)]*\)\]\.reverse\(\)/.test(SRC));
check('paging stops on total_rows, not on a short page alone',
  /total_rows/.test(SRC));
check('a refusal that IS about the credential is recorded against it',
  /AUTH_CODES\.has\(refused\.code\)[\s\S]{0,240}?state: 'invalid'/.test(SRC));
/* And one that is not stays off it. Filing "your date is too old" against a
   token is what marked a working Egari credential invalid. */
check('and one that is not about the credential does not touch it',
  /AUTH_CODES = new Set\(/.test(SRC) && !/state: 'invalid'[\s\S]{0,80}?detail: refused\.says[\s\S]{0,40}?\}\);\s*\n\s*\}\s*\n\s*await noteCredential/.test(SRC));
check('the retention edge is a code, tested for equality, not a message match',
  /RETENTION_CODE = 25809/.test(SRC) && /code === RETENTION_CODE/.test(SRC));
/* And the code is READ before it is compared, so a body carrying no numeric
   code is never mistaken for a good empty window. */
check('a response is a success only when it says so AND carries columns',
  /Number\.isFinite\(code\) && code === 0 && Array\.isArray\(data\?\.data\?\.columns\)/.test(SRC));
/* The third instance of this defect in this codebase — fms.js and yango.js
   both had it. A credential that can only be written 'invalid' keeps the last
   red row it was given for ever. */
check('and a working token is recorded as working, so the red row can clear',
  /state: 'ok', surface: 'orderHistory'/.test(SRC));

/* ── the walk over windows and pages ─────────────────────────────────────
   Everything above was green while the collector wrote 70 rows over a two-year
   backfill and 182 over three days, because nothing here could reach the loop.
   These drive it with a fake portal, which is the only way the defect was ever
   going to be caught before production.

   The fake answers the way the real one does: code 0 and message OK on success,
   a non-zero code on refusal, column-oriented pages of at most 100. */
console.log('\nbolt: the walk over windows and pages');

const day = (d) => new Date(`${d}T00:00:00Z`);
/* One synthetic order per day, so a window's row count IS its length in days
   and a lost window is arithmetic rather than a judgement call. */
const orderOn = (iso, n) => ({ driver: { id: String(1000 + n), name: `D${n}` },
  created: Math.floor(day(iso).getTime() / 1000) + n, car_reg_number: 'L00001',
  route: ['a', 'b'], status: 'finished', distance: 3, price: 20, category: 'Bolt',
  arrived_to_destinations: [], payment_method: 'in_app' });
const asColumns = (orders) => ({ code: 0, message: 'OK', data: {
  total_rows: orders.length,
  columns: Object.keys(orders[0] || { created: 0 }).map((k) => ({ key: k,
    cells: orders.map((o) => o[k]) })) } });

/* `since` is the portal's rolling retention edge. Anything starting before it
   is refused with 25809, exactly as the live endpoint does. */
function fakePortal({ since, perDay = 1, refuseWindowsStarting = null, code = 702 }) {
  const seen = [];
  return async (win, offset) => {
    seen.push({ start: win.start.toISOString().slice(0, 10), offset });
    if (win.start < day(since)) return { code: 25809, message: 'START_DATE_TOO_FAR_IN_THE_PAST' };
    if (refuseWindowsStarting
        && win.start.toISOString().slice(0, 10) === refuseWindowsStarting) {
      return { code, message: 'INVALID_REQUEST' };
    }
    const orders = [];
    for (let t = win.start.getTime(); t <= win.end.getTime(); t += 864e5) {
      const d = new Date(t).toISOString().slice(0, 10);
      for (let k = 0; k < perDay; k++) orders.push(orderOn(d, orders.length));
    }
    const slice = orders.slice(offset, offset + 100);
    return { ...asColumns(slice), data: { ...asColumns(slice).data, total_rows: orders.length } };
  };
}
const ROW = (o) => portalRow(o, C);

/* THE BUG, as a test. Two years asked for, fifteen months retained. */
const deep = await harvestPortal({ from: '2024-09-03', to: '2026-09-03',
  ask: fakePortal({ since: '2025-06-01' }), row: ROW });
check('a window older than the portal keeps does not discard the rest',
  deep.rows.length > 400, `${deep.rows.length} rows survived`);
check('and it is reported as the retention edge, not as a failure',
  !!deep.tooOld && deep.refused === null,
  `tooOld=${!!deep.tooOld} refused=${JSON.stringify(deep.refused)}`);
check('the edge it names is the first window that would not answer',
  deep.tooOld.start < day('2025-06-01'));
/* Newest-first is what makes the boundary cheap: at 30-day windows, two years
   is 25 chunks and only about 15 of them are inside retention. Asking
   oldest-first would spend ten requests being refused before collecting
   anything. */
/* `generated`, not `windows`. They used to be the same number and the
   difference is the point: `windows` counts what was actually ASKED, so that a
   coverage figure cannot include windows the walk stopped short of. Comparing
   asked against attempted would now be comparing a number with itself. */
check('it stops at the edge instead of asking for every older window',
  deep.asked < deep.generated && deep.windows < deep.generated,
  `${deep.asked} requests, ${deep.windows} windows attempted, ${deep.generated} generated`);

/* A refusal that is NOT the retention edge keeps its rows too, and is reported. */
const mid = await harvestPortal({ from: '2026-06-01', to: '2026-09-03',
  ask: fakePortal({ since: '2020-01-01', refuseWindowsStarting: '2026-07-01' }), row: ROW });
check('a mid-run refusal keeps everything already collected',
  mid.rows.length > 0, `${mid.rows.length}`);
check('and names the code and the window it happened on',
  mid.refused?.code === 702 && /2026-07-01/.test(mid.refused.says), JSON.stringify(mid.refused));

/* code 0 is SUCCESS. Testing the field for truthiness reads every good
   response as an error and collects nothing — the failure mode that hid this
   endpoint's real behaviour for a year. */
const zero = await harvestPortal({ from: '2026-08-01', to: '2026-08-30',
  ask: fakePortal({ since: '2020-01-01' }), row: ROW });
check('a success code of 0 is not read as a refusal',
  zero.rows.length === 30 && zero.refused === null, `${zero.rows.length} rows`);

/* Paging. total_rows is the window total, so a full last page must not end the
   walk early and an exact multiple must not loop for ever. */
const many = await harvestPortal({ from: '2026-08-01', to: '2026-08-30',
  ask: fakePortal({ since: '2020-01-01', perDay: 10 }), row: ROW });
check('every page of a multi-page window is collected',
  many.rows.length === 300, `${many.rows.length} of 300`);
const exact = await harvestPortal({ from: '2026-08-01', to: '2026-08-10',
  ask: fakePortal({ since: '2020-01-01', perDay: 10 }), row: ROW });
check('a window whose total is an exact multiple of the page terminates',
  exact.rows.length === 100, `${exact.rows.length}`);

/* Windows tile the range with no gap and no overlap: a day counted twice is a
   duplicate trip, a day skipped is a missing one, and the synthetic key makes
   both silent. */
const tiled = await harvestPortal({ from: '2026-01-01', to: '2026-03-31',
  ask: fakePortal({ since: '2020-01-01' }), row: ROW });
check('the windows tile the range exactly — one row per day, no gap, no overlap',
  tiled.rows.length === 90, `${tiled.rows.length} of 90 days`);
check('and every key is distinct across window boundaries',
  new Set(tiled.rows.map((r) => r.external_id)).size === tiled.rows.length);

/* An empty but valid window is not a refusal, and must not stop the walk. */
const gap = await harvestPortal({ from: '2026-08-01', to: '2026-08-30',
  ask: async (win, offset) => (offset > 0 ? { code: 0, message: 'OK', data: { columns: [], total_rows: 0 } }
    : { code: 0, message: 'OK', data: { columns: [], total_rows: 0 } }), row: ROW });
check('an empty window returns nothing and reports no fault',
  gap.rows.length === 0 && gap.refused === null && !gap.tooOld);

/* ── the rate limit, which only a live run could have found ──────────────
   Running the real loop over two years against the live portal collected
   19,239 Ecosine and 13,238 Egari orders — and answered code 1005
   TOO_MANY_REQUESTS partway through, on 2026-07-25..2026-08-23. Two years is
   25 windows but about 210 requests once paging is counted; January 2026 alone
   is 3,932 orders, forty pages.

   A rate limit is the one refusal that is not an answer ABOUT THE DATA. The
   same request succeeds a moment later, so treating it like any other refusal
   drops a month of trips because the provider asked us to slow down. The
   fixture could never have shown this; only asking could. */
console.log('\nbolt: being told to slow down');

const nap = async () => {};   // the backoff itself is not what is under test

/* Refuses the first two attempts on every request, then answers. */
function rateLimited(n, inner) {
  const seen = new Map();
  return async (win, offset) => {
    const k = `${win.start.toISOString().slice(0, 10)}|${offset}`;
    const tries = (seen.get(k) || 0) + 1;
    seen.set(k, tries);
    if (tries <= n) return { code: 1005, message: 'TOO_MANY_REQUESTS' };
    return inner(win, offset);
  };
}

const slowed = await harvestPortal({ from: '2026-08-01', to: '2026-08-30',
  ask: rateLimited(2, fakePortal({ since: '2020-01-01' })), row: ROW, sleep: nap });
check('a rate limit is waited out, not counted as a refusal',
  slowed.rows.length === 30 && slowed.refused === null,
  `${slowed.rows.length} rows, refused=${JSON.stringify(slowed.refused)}`);
check('and the waiting is reported, so a slow run is explicable',
  slowed.limited > 0, `${slowed.limited}`);

/* It gives up eventually rather than retrying for ever — and when it does, it
   is a refusal like any other: reported, with its rows kept. */
const stubborn = await harvestPortal({ from: '2026-08-01', to: '2026-08-30',
  ask: rateLimited(99, fakePortal({ since: '2020-01-01' })), row: ROW, sleep: nap });
check('a limit that never lifts is given up on rather than retried for ever',
  stubborn.refused?.code === 1005, JSON.stringify(stubborn.refused));
check('and the retries are bounded', stubborn.asked <= 6, `${stubborn.asked} requests`);

/* A rate limit on ONE window must not cost the others. This is the same
   family as the retention bug: a transient refusal is not a verdict on the run. */
/* Refuses the Nth DISTINCT window it is shown, counting in the order the walk
   visits them. Picking calendar dates instead would silently match nothing the
   day the chunk arithmetic changes — which is exactly what it did. */
function refuseNthWindow(ns, code, inner) {
  const order = new Map();
  return async (win, offset) => {
    const k = win.start.toISOString().slice(0, 10);
    if (!order.has(k)) order.set(k, order.size);
    return ns.includes(order.get(k)) ? { code, message: 'REFUSED' } : inner(win, offset);
  };
}

const partial = await harvestPortal({ from: '2026-06-01', to: '2026-08-30',
  ask: refuseNthWindow([1], 1005, fakePortal({ since: '2020-01-01' })),
  row: ROW, sleep: nap });
check('one exhausted window does not cost the windows around it',
  partial.rows.length > 50, `${partial.rows.length} rows`);

/* Every bad window, not just the first. On a long backfill "one window failed"
   and "a third of the history is missing" must not read identically. */
const manyBad = await harvestPortal({ from: '2026-01-01', to: '2026-08-30',
  ask: refuseNthWindow([1, 3, 5], 702, fakePortal({ since: '2020-01-01' })),
  row: ROW, sleep: nap });
check('every refused window is counted, not only the first',
  manyBad.refusals.length === 3, `${manyBad.refusals.length}`);
check('and the operator is told there were more than one',
  /2 more windows/.test(manyBad.refused.says), manyBad.refused.says);

/* The rate-limit code must be equality-tested, like the retention code — a
   message match would break the day the provider rewords it. */
check('the limit is recognised by code, not by message text',
  /RATE_LIMIT_CODE = 1005/.test(SRC) && /!== RATE_LIMIT_CODE|=== RATE_LIMIT_CODE/.test(SRC));
check('and it is NOT in the set that blames the credential',
  !/AUTH_CODES = new Set\(\[[^\]]*1005/.test(SRC));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
