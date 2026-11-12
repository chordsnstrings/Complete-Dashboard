/* UBER'S LIVE PER-TRIP MONEY — src/sources/uber_transactions.js, the probe
   fix, the fare walk's provenance stamp, the schedule and the read route,
   against a real schema (PGlite) and a fake Uber that records every request.
   ═════════════════════════════════════════════════════════════════════════
   What is pinned (FIX-STATUS UTX):
     1. the request is the ONE shape Uber answers — POST, snake_case envelope,
        timeRange IN_RANGE over epoch-ms STRINGS, windows of at most 15
        minutes, ending ≥ 5 minutes ago, never older than 24 hours;
     2. the walk: 15-minute windows over the last N hours (6, capped at 24),
        newest first, every page, one request per 1.1 s;
     3. a 429 backs off (Retry-After when named) and, still refused, stops the
        fleet's walk for this run — and is never filed as a credential failure;
        a 403 is, and stops it; the same 4xx twice stops it;
     4. the row: amountE5 → AED exactly, the fare BRANCH (never the leaf),
        no names kept, one row per transaction however often it is re-asked;
     5. the fill: a NULL price or the feed's own, never a statement-grade or
        a channel's own price; never an INSERT; never the other fleet's trip;
        the fare walk now stamps 'uber_payments' and outranks the feed;
     6. each run is in collection_run as /api/status reads it;
     7. the schedule collides with no other job's minute, and a pass that
        moves the response cache starts eight minutes after each run;
     8. the nightly probe and both API probes ask with POST, never GET;
     9. GET /api/status/uber-live-money: provisional prices, agreement with the
        payments report, and absent-with-a-reason where nothing is measured.
   Synthetic ids and a synthetic driver ("Test Driver") only. No network. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { applySchema } from './schema.mjs';

/* The probe's surface list is built only when an OAuth client is configured;
   settings fall back to the environment. Set BEFORE the modules load. */
process.env.UBER_CLIENT_ID = process.env.UBER_CLIENT_ID || 'test-client';
process.env.UBER_CLIENT_SECRET = process.env.UBER_CLIENT_SECRET || 'test-secret';
process.env.UBER_ORG_ENCRYPTED = process.env.UBER_ORG_ENCRYPTED || 'org-ecosine-enc';

const T = await import('../src/sources/uber_transactions.js');
const { FARE_WRITE_SQL } = await import('../src/sources/uber.js');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

/* ── fixtures in the measured shape ────────────────────────────────────── */
const node = (name, e5, children = null) => ({ categoryName: name, categoryLabel: name.replace(/_/g, ' '),
  amount: { amountE5: e5, currencyCode: 'AED' }, children });
/* The worked example in docs/COVERAGE.md: fare 46.94 = little_fare 45.77 +
   wait_time 1.17; service fee −11.74; VAT −0.59; your_earnings 34.61. */
function txn({ id, trip, at, desc = 'TRIP', fare = 4694000, base = 4577000, wait = 117000,
  fee = -1174000, tax = -59000, tip = null, noFareBranch = false }) {
  const earn = fare + fee + tax + (tip || 0);
  const fareNode = noFareBranch ? [node('little_fare', base)]
    : [node('fare', fare, [node('little_fare', base), node('wait_time', wait)])];
  return {
    driverInfo: { driverUuid: 'drv-test-1', firstName: 'Test', lastName: 'Driver' },
    transactionInfo: { transactionUuid: id, tripUuid: trip, processedAt: at, description: desc,
      breakDowns: [node('paid_to_you', earn, [
        node('your_earnings', earn, [
          ...fareNode,
          node('service_fee', fee),
          node('taxes_earnings', tax, [node('tax_on_service_fee', tax)]),
          ...(tip != null ? [node('tip', tip)] : []),
        ]),
        node('trip_balance', 0, [node('refunds', 0, [node('toll', 0)])]),
      ])] },
  };
}

/* A fake Uber: filters its dataset by the asked range, pages by the asked
   size with an offset cursor, and lets a test script any single call. */
let fakeNow = Date.parse('2026-11-12T10:07:30Z');
const clock = () => fakeNow;
const slept = [];
const sleep = async (ms) => { slept.push(ms); fakeNow += ms; };
function fakeUber(dataset, script = () => null) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const call = { url, method: opts.method, body, headers: opts.headers, at: fakeNow };
    calls.push(call);
    fakeNow += 120;                       // a request takes a little time
    const s = script(call, calls.length);
    if (s) return { status: s.status, data: s.data ?? {}, headers: s.headers || {}, finalUrl: s.finalUrl };
    const org = new URL(url).searchParams.get('org_id');
    const [a, b] = body.filters[0].value.map(Number);
    const all = dataset.filter((d) => d.org === org)
      .map((d) => d.txn).filter((t) => {
        const p = Date.parse(t.transactionInfo.processedAt);
        return p >= a && p <= b;
      });
    const off = Number(body.pagination_options.page_token || 0);
    const size = body.pagination_options.page_size;
    const page = all.slice(off, off + size);
    const next = off + size < all.length ? String(off + size) : '';
    /* proto3 JSON omits an empty repeated field: an empty window may be {} */
    return { status: 200, headers: {},
      data: page.length ? { transactions: page, paginationResult: next ? { nextPageToken: next } : {} } : {} };
  };
  return { fn, calls };
}
const ORG_E = { fleet: 'ecosine', org: 'org-ecosine-enc', oauth: { clientId: 'c', clientSecret: 's', own: true, secretKey: 'UBER_CLIENT_SECRET' } };
const ORG_G = { fleet: 'egari', org: 'org-egari-enc', oauth: { clientId: 'c2', clientSecret: 's2', own: true, secretKey: 'UBER_CLIENT_SECRET_EGARI' } };
const notes = [];
const noteRest = async (_db, url, res, o, surface) => {
  notes.push({ status: res.status, fleet: o.fleet, surface });
  return res.status === 401 || res.status === 403 ? { reason: `${res.status} from api.uber.com — bad key` } : null;
};
const run = (opts) => T.collect({ db, hours: 1, orgs: [ORG_E], tokenFor: async () => 'tok-test',
  noteRest, sleep, clock, log: quiet, ...opts });

/* ══ 1. the request ═══════════════════════════════════════════════════════ */
console.log('\nthe request is the one shape Uber answers');
{
  const now = new Date('2026-11-12T10:07:30Z');
  const ws = T.txnWindows(now, 6);
  check('six hours is 24 quarter-hour windows', ws.length === 24, String(ws.length));
  check('newest first, aligned to the quarter hour, ending at least five minutes ago',
    ws[0].start.toISOString() === '2026-11-12T09:45:00.000Z' && +now - +ws[0].end >= 5 * 60_000
    && ws.every((w, i) => i === 0 || +w.start < +ws[i - 1].start), ws[0].start.toISOString());
  check('every window spans at most 15 minutes, and they tile the clock',
    ws.every((w) => +w.end - +w.start <= 15 * 60_000 && +w.end - +w.start === 15 * 60_000 - 1)
    && ws.every((w, i) => i === 0 || +ws[i - 1].start === +w.end + 1));
  const w24 = T.txnWindows(now, 24);
  const w48 = T.txnWindows(now, 48);
  check('the look-back is capped at 24 hours, with the oldest window still inside it',
    w48.length === w24.length && +now - +w24[w24.length - 1].start <= 24 * 3600e3 - 5 * 60_000,
    `${w24.length} / ${w48.length}`);
  check('a nonsense look-back falls back to six hours', T.txnWindows(now, 'x').length === 24
    && T.txnWindows(now, 0).length === 24);
  const b = T.txnRequestBody(ws[0].start, ws[0].end, 'cur-2');
  check('timeRange, the prefixed enum, epoch MILLISECONDS as STRINGS',
    b.filters[0].field === 'timeRange' && b.filters[0].operator === 'FILTER_OPERATOR_IN_RANGE'
    && b.filters[0].value.every((v) => typeof v === 'string' && /^\d{13}$/.test(v))
    && b.filters[0].value[0] === String(+ws[0].start), j(b.filters));
  check('a snake_case envelope with page_size 50, and the cursor sent back as page_token',
    b.pagination_options.page_size === 50 && b.pagination_options.page_token === 'cur-2'
    && !('paginationOptions' in b) && !('page_token' in T.txnRequestBody(ws[0].start, ws[0].end).pagination_options));
  check('the org goes in the query string', T.txnUrl('a b') === `${T.TXN_URL}?org_id=a%20b`);
  check('a past day this feed cannot serve has no legal window',
    T.latestLegalWindow({ from: '2026-11-10', to: '2026-11-10T23:59:59Z', now }) === null
    && T.latestLegalWindow({ now })?.start.toISOString() === '2026-11-12T09:45:00.000Z');
  check('Retry-After in seconds or as a date, capped at a minute',
    T.retryAfterMs({ 'retry-after': '3' }) === 3000 && T.retryAfterMs({ 'retry-after': '900' }) === 60_000
    && T.retryAfterMs({}) === null && T.retryAfterMs({ get: () => '2' }) === 2000);
}

/* ══ 2. the row ════════════════════════════════════════════════════════════ */
console.log('\nthe row: AED exactly, the fare branch, no names');
{
  const r = T.parseTransaction(txn({ id: 'tx-a', trip: 'trip-a', at: '2026-11-12T09:50:00.000Z', tip: 500000 }), 'ecosine');
  check('amountE5 → AED to five places, exactly', r.fare === '46.94000' && r.fare_base === '45.77000'
    && r.service_fee === '-11.74000' && r.taxes === '-0.59000' && r.tip === '5.00000'
    && r.your_earnings === '39.61000', j(r));
  check('the fare is the BRANCH, not the little_fare leaf beneath it', r.fare !== r.fare_base);
  check('every node kept by its path', r.categories['paid_to_you.your_earnings.fare.wait_time'] === 1.17
    && r.categories['paid_to_you.trip_balance.refunds.toll'] === 0, j(r.categories));
  check('the driver is the account id; the names are not stored anywhere in the row',
    r.driver_ext_id === 'drv-test-1' && !/Test|Driver/.test(j(r)));
  check('ride, adjustment, payout, other', T.txnKind('TRIP') === 'trip'
    && T.txnKind('PERSONAL_TRANSPORT') === 'trip' && T.txnKind('TRIP_FARE_ADJUSTMENT') === 'adjustment'
    && T.txnKind('so.payout') === 'payout' && T.txnKind('TIP') === 'other');
  const leafOnly = T.parseTransaction(txn({ id: 'tx-l', trip: 'trip-l', at: '2026-11-12T09:50:00Z', noFareBranch: true }), 'ecosine');
  check('a row without the fare branch carries no fare — the leaf is never promoted into it',
    leafOnly.fare === null && leafOnly.fare_base === '45.77000');
  check('a row with no id or no time is not a row', T.parseTransaction({ transactionInfo: { processedAt: '2026-11-12T09:50:00Z' } }, 'e') === null
    && T.parseTransaction(txn({ id: 'x', trip: 't', at: 'not a time' }), 'e') === null);
  check('amountE5 as a string is read the same as a number', T.e5ToDec(Number('4694000')) === '46.94000'
    && T.flattenBreakdown([{ categoryName: 'fare', amount: { amountE5: '4694000' } }]).amounts.fare === 4694000);
  /* COVERAGE trap: node-postgres binds a JS array as a Postgres array literal
     and a JSONB column refuses it. The batch goes as ONE string. */
  const { prepareValue } = createRequire(import.meta.url)('pg/lib/utils.js');
  const bound = prepareValue(JSON.stringify([r]));
  check('the store binds the batch as JSON text, which node-postgres passes through untouched',
    typeof bound === 'string' && JSON.parse(bound)[0].transaction_uuid === 'tx-a');
}

/* ══ 3. the walk ═══════════════════════════════════════════════════════════ */
console.log('\nthe walk: every window, every page, paced');
const at = (iso) => iso;   // readability
{
  const data = [];
  /* 60 transactions in the newest window (two pages), one in the oldest. */
  for (let i = 0; i < 60; i++) {
    data.push({ org: 'org-ecosine-enc', txn: txn({ id: `tx-p${i}`, trip: `trip-p${i}`,
      at: new Date(Date.parse('2026-11-12T09:46:00Z') + i * 10_000).toISOString() }) });
  }
  data.push({ org: 'org-ecosine-enc', txn: txn({ id: 'tx-old', trip: 'trip-old', at: at('2026-11-12T09:01:00.000Z') }) });
  fakeNow = Date.parse('2026-11-12T10:07:30Z'); slept.length = 0;
  const U = fakeUber(data);
  const out = await run({ httpImpl: U.fn });
  const f = out.fleets[0];
  check('one hour is four windows, all asked, all answered', f.windows === 4 && f.asked === 4 && f.failed === 0, j(f));
  check('every request is a POST with the documented body', U.calls.every((c) => c.method === 'POST'
    && c.body.filters[0].field === 'timeRange' && c.headers['content-type'] === 'application/json'
    && c.headers.authorization === 'Bearer tok-test'), j(U.calls.map((c) => c.method)));
  check('the full window is paged: the second page asked with the first page\'s cursor',
    U.calls.length === 5 && U.calls[1].body.pagination_options.page_token === '50', String(U.calls.length));
  check('all 61 transactions received and stored, none lost between pages',
    f.received === 61 && (await q(`SELECT count(*)::int n FROM uber_live_transaction`))[0].n === 61);
  const gaps = U.calls.slice(1).map((c, i) => c.at - U.calls[i].at);
  check('one request per 1.1 s at most', gaps.every((g) => g >= T.PACE_MS), j(gaps));
  /* Re-asking the same hour rewrites nothing. */
  fakeNow = Date.parse('2026-11-12T10:07:30Z');
  const again = await run({ httpImpl: fakeUber(data).fn });
  check('re-asking the same windows writes nothing and duplicates nothing',
    again.fleets[0].written === 0 && (await q(`SELECT count(*)::int n FROM uber_live_transaction`))[0].n === 61,
    j(again.fleets[0]));
  const changed = data.map((d) => (d.txn.transactionInfo.transactionUuid === 'tx-old'
    ? { ...d, txn: txn({ id: 'tx-old', trip: 'trip-old', at: '2026-11-12T09:01:00.000Z', fare: 5000000 }) } : d));
  fakeNow = Date.parse('2026-11-12T10:07:30Z');
  const third = await run({ httpImpl: fakeUber(changed).fn });
  check('a transaction Uber restates is rewritten once, in place',
    third.fleets[0].written === 1 && third.fleets[0].inserted === 0
    && (await q(`SELECT fare::text f FROM uber_live_transaction WHERE transaction_uuid = 'tx-old'`))[0].f === '50.00000');
  /* A cursor the server ignores, on a full page. */
  fakeNow = Date.parse('2026-11-12T10:07:30Z');
  const stuck = fakeUber(data, (c) => (c.body.pagination_options.page_token ? {
    status: 200, data: { transactions: data.slice(0, 50).map((d) => d.txn), paginationResult: { nextPageToken: '50' } } } : null));
  const s = (await run({ httpImpl: stuck.fn })).fleets[0];
  check('an ignored cursor on a full page is reported, not looped on', s.failed === 1
    && stuck.calls.length === 5, j(s));
  /* The other half (independent review): a cursor Uber SENDS under a key this
     file does not read. nextToken comes back empty and, unguarded, the loop
     ended after page one with the window marked answered — 50 of its
     transactions stored, the rest silently gone. */
  const w0 = T.txnWindows(new Date('2026-11-12T10:07:30Z'), 0.25)[0];
  const full = data.slice(0, 50).map((d) => d.txn);
  const once = (pagination) => T.fetchWindow({ url: T.txnUrl('o'), token: 't', w: w0,
    httpImpl: async () => ({ status: 200, headers: {}, data: { transactions: full, paginationResult: pagination } }) });
  const unread = await once({ next_cursor: 'abc' });
  check('a full page whose cursor sits under a key nobody reads fails its window, naming the key',
    /paginationResult\.next_cursor/.test(unread.error || '') && unread.truncated && unread.raw.length === 50,
    j({ e: unread.error, n: unread.raw.length }));
  const end = await once({});
  const total = await once({ totalSize: '50' });
  check('…while a full LAST page (an empty paginationResult) is simply the end, and a total is not a cursor',
    !end.error && end.pages === 1 && !total.error && total.pages === 1, j({ end: end.error, total: total.error }));
  check('the cursor is read under either spelling of the envelope', T.nextToken({ pagination_result: { nextPageToken: 'x' } }) === 'x'
    && T.nextToken({ paginationResult: { next_page_token: 'y' } }) === 'y' && T.nextToken({ paginationResult: {} }) === ''
    && T.nextToken({ paginationResult: { nextPageToken: 50 } }) === '50' && T.nextToken({ paginationResult: { nextPageToken: '  ' } }) === '');
}

/* ══ 4. 429, 403, 400 ══════════════════════════════════════════════════════ */
console.log('\nrefusals: back off on 429, stop on a credential, stop on a repeated 4xx');
{
  await q(`DELETE FROM collection_run`);
  /* Two 429s, the second naming Retry-After, then an answer. */
  fakeNow = Date.parse('2026-11-12T10:07:30Z'); slept.length = 0; notes.length = 0;
  const U = fakeUber([], (c, n) => (n === 1 ? { status: 429, data: { code: 'TooManyRequests' } }
    : n === 2 ? { status: 429, data: 'Too Many Requests', headers: { 'retry-after': '3' } } : null));
  const f = (await run({ httpImpl: U.fn })).fleets[0];
  check('a 429 is retried after a back-off, Retry-After honoured when Uber names it',
    slept.includes(2000) && slept.includes(3000) && f.failed === 0 && f.asked === 4, j({ slept, f }));
  check('…and a 429 is never handed to the credential check', notes.every((x) => x.status !== 429), j(notes));

  /* Refused through every back-off: the fleet's walk stops for this run. */
  await q(`DELETE FROM collection_run`);
  fakeNow = Date.parse('2026-11-12T10:07:30Z'); slept.length = 0; notes.length = 0;
  /* Windows newest first, one call each (no data): 09:45 and 09:30 answer,
     09:15 is refused through every back-off, 09:00 is never asked. */
  const all429 = fakeUber([], (c, n) => (n > 2 ? { status: 429, data: 'Too Many Requests' } : null));
  const g = (await run({ httpImpl: all429.fn })).fleets[0];
  check('still refused after three back-offs, the walk stops and leaves the rest for the next run',
    g.asked === 3 && g.not_asked === 1 && g.failed === 1 && all429.calls.length === 6
    && j(slept.filter((x) => x >= 2000)) === j(T.BACKOFF_MS), j({ g, slept }));
  check('…no credential is blamed for it', notes.every((x) => x.status !== 429), j(notes));
  const [cr] = await q(`SELECT status, error, chunks_total, chunks_failed, detail FROM collection_run
                         WHERE source = 'uber_transactions'`);
  check('the run reads partial, says 429, and says the rest are asked next quarter hour',
    cr?.status === 'partial' && /429/.test(cr.error) && /next quarter hour/.test(cr.error)
    && cr.chunks_failed === 1, j(cr));
  const crd = (typeof cr?.detail === 'string' ? JSON.parse(cr.detail) : cr?.detail) || [];
  check('the window never asked is not listed as a failed window; the refused one is',
    crd.length === 2 && !crd.some((c) => c.from === '2026-11-12T09:00:00Z')
    && crd.some((c) => c.from === '2026-11-12T09:15:00Z' && /429/.test(c.error)), j(crd));

  /* 403: a credential, and it stops the fleet; the other fleet still runs. */
  await q(`DELETE FROM collection_run`);
  fakeNow = Date.parse('2026-11-12T10:07:30Z'); notes.length = 0;
  const bad = fakeUber([], (c) => (c.url.includes('org-egari-enc') ? { status: 403, data: { message: 'bad key' } } : null));
  const both = await run({ httpImpl: bad.fn, orgs: [ORG_G, ORG_E] });
  const eg = both.fleets.find((x) => x.fleet === 'egari'), ec = both.fleets.find((x) => x.fleet === 'ecosine');
  check('a 403 is noted against the fleet\'s credential and stops that fleet',
    notes.some((x) => x.status === 403 && x.fleet === 'egari' && x.surface === 'transactions')
    && eg.status === 'error' && eg.asked === 1 && eg.not_asked === 3, j(eg));
  check('…and Ecosine is collected anyway', ec.status === 'ok' && ec.asked === 4, j(ec));
  check('a good answer is noted once, as the credential working',
    notes.filter((x) => x.fleet === 'ecosine' && x.status === 200).length === 1, j(notes));

  /* The same 400 twice: the request is wrong, not the window. */
  fakeNow = Date.parse('2026-11-12T10:07:30Z');
  const v = fakeUber([], () => ({ status: 400, data: { message: 'invalid start time' } }));
  const h = (await run({ httpImpl: v.fn })).fleets[0];
  check('two windows refused alike stop the walk, with Uber\'s own words kept',
    v.calls.length === 2 && h.not_asked === 2, j(h));
  const [r400] = await q(`SELECT error FROM collection_run WHERE source = 'uber_transactions'
                           AND fleet_id = 'ecosine' ORDER BY id DESC LIMIT 1`);
  check('…the run says what Uber said', /invalid start time/.test(r400?.error || ''), r400?.error);

  /* No token: nothing asked, and the run says why. */
  const nt = await run({ httpImpl: fakeUber([]).fn, tokenFor: async () => { throw new Error('uber oauth failed: {}'); } });
  check('no token is an error run that asked nothing', nt.fleets[0].status === 'error'
    && /no OAuth token/.test(nt.fleets[0].error));
  check('no configured fleet is a skip, never a request', (await T.collect({ db, orgs: [], log: quiet,
    httpImpl: async () => { throw new Error('asked'); } })).skipped?.includes('encrypted org id'));
}

/* ══ 5. the fill ═══════════════════════════════════════════════════════════ */
console.log('\nthe fill: only where nothing better exists');
{
  await q(`DELETE FROM uber_live_transaction`);
  await q(`DELETE FROM trip WHERE platform = 'uber'`);
  const tripRow = (id, fleet, price = null, source = null) => q(
    `INSERT INTO trip (platform, external_id, fleet_id, requested_at, status, price, price_source)
     VALUES ('uber', $1, $2, '2026-11-12T09:30:00Z', 'completed', $3, $4)`, [id, fleet, price, source]);
  await tripRow('t-null', 'ecosine');                          // nothing yet → filled
  await tripRow('t-stmt', 'ecosine', 50.10, 'uber_payments');  // statement-grade → held
  await tripRow('t-legacy', 'ecosine', 44.00, null);           // priced before v117 → held
  await tripRow('t-live', 'ecosine', 40.00, 'uber_live');      // the feed's own → revised
  await tripRow('t-other', 'egari');                           // the other fleet's trip
  await tripRow('t-adj', 'ecosine');                           // ride + adjustment
  await tripRow('t-unknown', 'ecosine');                       // only an unknown kind
  const data = [
    txn({ id: 'f1', trip: 't-null', at: '2026-11-12T09:50:00Z' }),
    txn({ id: 'f2', trip: 't-stmt', at: '2026-11-12T09:51:00Z' }),
    txn({ id: 'f3', trip: 't-legacy', at: '2026-11-12T09:52:00Z' }),
    txn({ id: 'f4', trip: 't-live', at: '2026-11-12T09:53:00Z' }),
    txn({ id: 'f5', trip: 't-other', at: '2026-11-12T09:54:00Z' }),
    txn({ id: 'f6', trip: 't-adj', at: '2026-11-12T09:55:00Z' }),
    txn({ id: 'f7', trip: 't-adj', at: '2026-11-12T09:56:00Z', desc: 'TRIP_FARE_ADJUSTMENT', fare: 500000 }),
    txn({ id: 'f8', trip: 't-unknown', at: '2026-11-12T09:57:00Z', desc: 'SOMETHING_NEW' }),
    txn({ id: 'f9', trip: 't-missing', at: '2026-11-12T09:58:00Z' }),
  ].map((t) => ({ org: 'org-ecosine-enc', txn: t }));
  const tripsBefore = (await q(`SELECT count(*)::int n FROM trip`))[0].n;
  fakeNow = Date.parse('2026-11-12T10:07:30Z');
  const f = (await run({ httpImpl: fakeUber(data).fn })).fleets[0];
  const P = Object.fromEntries((await q(`SELECT external_id, price::text AS price, price_source
                                           FROM trip WHERE platform = 'uber'`)).map((r) => [r.external_id, r]));
  check('a trip with no price gets the live fare branch, rounded to the fils, marked uber_live',
    P['t-null'].price === '46.94' && P['t-null'].price_source === 'uber_live', j(P['t-null']));
  check('a statement-grade price is never overwritten', P['t-stmt'].price === '50.10'
    && P['t-stmt'].price_source === 'uber_payments', j(P['t-stmt']));
  check('nor a price written before provenance existed', P['t-legacy'].price === '44.00'
    && P['t-legacy'].price_source === null, j(P['t-legacy']));
  check('the feed corrects its own provisional price', P['t-live'].price === '46.94'
    && P['t-live'].price_source === 'uber_live', j(P['t-live']));
  check('the other fleet\'s trip is not priced from this fleet\'s money', P['t-other'].price === null, j(P['t-other']));
  check('an adjustment is kept beside the fare and never added to it', P['t-adj'].price === '46.94', j(P['t-adj']));
  check('a kind nobody has named is stored but prices nothing', P['t-unknown'].price === null
    && (await q(`SELECT kind FROM uber_live_transaction WHERE transaction_uuid = 'f8'`))[0].kind === 'other');
  check('a transaction for a trip we do not hold invents no trip',
    (await q(`SELECT count(*)::int n FROM trip`))[0].n === tripsBefore);
  /* unmatched 2: t-missing has no row at all, and t-other's row is Egari's —
     to Ecosine's money it is not a trip we hold either. */
  check('the run counts what it did and what it declined', f.filled === 2 && f.revised === 1
    && f.held === 2 && f.unmatched === 2 && f.no_fare === 1 && f.trips === 8, j(f));

  /* The payments walk lands later and outranks the feed. */
  const blob = j({ uber_payments: { fare: 47.5 } });
  await q(FARE_WRITE_SQL, ['ecosine', 't-null', 47.5, blob]);
  const [stated] = await q(`SELECT price::text AS price, price_source FROM trip WHERE external_id = 't-null'`);
  check('the fare walk replaces the provisional price and says it is the payments report\'s',
    stated.price === '47.50' && stated.price_source === 'uber_payments', j(stated));
  fakeNow = Date.parse('2026-11-12T10:22:30Z');
  await run({ httpImpl: fakeUber(data).fn });
  const [after] = await q(`SELECT price::text AS price, price_source FROM trip WHERE external_id = 't-null'`);
  check('…and the next live pass leaves the statement\'s figure alone', after.price === '47.50'
    && after.price_source === 'uber_payments', j(after));
  await q(FARE_WRITE_SQL, ['ecosine', 't-live', null, j({ uber_payments: { fare: null, adjustment: 5 } })]);
  const [held] = await q(`SELECT price::text AS price, price_source FROM trip WHERE external_id = 't-live'`);
  check('a payments row with no fare holds the price AND its source', held.price === '46.94'
    && held.price_source === 'uber_live', j(held));

  /* Kept 90 days, per fleet. */
  await q(`INSERT INTO uber_live_transaction (transaction_uuid, fleet_id, processed_at, kind)
           VALUES ('ancient', 'ecosine', '2026-07-01T00:00:00Z', 'trip')`);
  check('a transaction older than 90 days is pruned', await T.pruneTransactions(q, 'ecosine',
    new Date('2026-11-12T10:00:00Z')) === 1);
}

/* ══ 6. /api/status ════════════════════════════════════════════════════════ */
console.log('\neach run is in /api/status');
{
  /* The query /api/status runs (api/server.js), read here as it ships. */
  const server = readFileSync('api/server.js', 'utf8');
  const sql = server.match(/app\.get\('\/api\/status', wrap\(async \(_, res\) => res\.json\(\(await q\(\s*`([^`]+)`/)?.[1];
  check('the /api/status query was found', Boolean(sql));
  const rows = sql ? await q(sql) : [];
  const mine = rows.filter((r) => r.source === 'uber_transactions');
  check('one row per fleet, under its own source and the realtime mode',
    mine.length >= 1 && mine.every((r) => r.mode === 'realtime') && mine.some((r) => r.fleet_id === 'ecosine'),
    j(mine.map((r) => [r.fleet_id, r.mode, r.status])));
  const latest = mine.find((r) => r.fleet_id === 'ecosine');
  const det = typeof latest?.detail === 'string' ? JSON.parse(latest.detail) : latest?.detail;
  check('a healthy run is one merged window, oldest → newest, with its transaction count',
    latest?.status === 'ok' && det?.length === 1 && det[0].from === '2026-11-12T09:15:00Z'
    && det[0].to === '2026-11-12T10:15:00Z' && det[0].rows === 9, j({ s: latest?.status, det }));
  check('a source no reader mistakes for Uber\'s trip collection', !/source:\s*'uber'/.test(
    readFileSync('src/sources/uber_transactions.js', 'utf8')) && T.SRC === 'uber_transactions');
  const ui = readFileSync('api/public/ui.js', 'utf8');
  check('and a name for the reader, never the database key',
    /uber_transactions: 'Uber live money'/.test(ui) && /\['uber_transactions', '--c-uber'\]/.test(ui));
  const chunks = T.compactChunks([
    { w: { start: new Date('2026-11-12T09:00:00Z'), end: new Date('2026-11-12T09:14:59.999Z') }, rows: 2, error: null },
    { w: { start: new Date('2026-11-12T09:30:00Z'), end: new Date('2026-11-12T09:44:59.999Z') }, rows: 0, error: '429' },
    { w: { start: new Date('2026-11-12T09:15:00Z'), end: new Date('2026-11-12T09:29:59.999Z') }, rows: 3, error: null },
  ]);
  check('neighbours of one outcome merge; a refusal keeps its own quarter hour',
    chunks.length === 2 && chunks[0].rows === 5 && chunks[0].to === '2026-11-12T09:30:00Z'
    && chunks[1].error === '429', j(chunks));
}

/* ══ 7. the schedule ═══════════════════════════════════════════════════════ */
console.log('\nthe schedule collides with nothing');
{
  /* Every schedule in src/index.js, expanded by node-cron's OWN converter —
     so a stepped range means what node-cron 3.0.3 makes it mean (COVERAGE:
     '3-23/6' is 6, 12, 18), not what it reads like. */
  const convert = createRequire(import.meta.url)('node-cron/src/convert-expression/index.js');
  const { SETTING_DEFAULTS } = await import('../src/settings.js');
  const idx = readFileSync('src/index.js', 'utf8');
  const cfg = readFileSync('src/config.js', 'utf8');
  const getter = Object.fromEntries([...cfg.matchAll(/get (\w+Cron)\(\) \{ return get\('(\w+)'/g)]
    .map((m) => [m[1], m[2]]));
  const calls = [...idx.matchAll(/cron\.schedule\(('[^']*'|config\.\w+|get\('\w+', '[^']*'\))/g)].map((m) => m[1]);
  const exprOf = (a) => {
    let m = a.match(/^'([^']+)'$/); if (m) return m[1];
    m = a.match(/^config\.(\w+)$/); if (m && getter[m[1]]) return SETTING_DEFAULTS[getter[m[1]]];
    m = a.match(/^get\('(\w+)', '([^']+)'\)$/); if (m) return m[2];
    return null;
  };
  const exprs = calls.map((a) => ({ a, e: exprOf(a) }));
  check('every cron.schedule in src/index.js was read — none skipped for its form',
    exprs.length === (idx.match(/cron\.schedule\(/g) || []).length && exprs.every((x) => x.e),
    j(exprs.filter((x) => !x.e)));
  const mins = (e) => new Set(convert(e).split(' ')[1].split(',').map(Number));
  check('the live money tick is scheduled at 7, 22, 37 and 52 past, once',
    /cron\.schedule\('7,22,37,52 \* \* \* \*', \(\) => liveMoneyTick\(\)/.test(idx)
    && exprs.filter((x) => x.e === '7,22,37,52 * * * *').length === 1);
  const others = exprs.filter((x) => x.e !== '7,22,37,52 * * * *');
  const clash = others.filter((x) => [...mins(x.e)].some((m) => [7, 22, 37, 52].includes(m)));
  check('no other job starts on any of those minutes, at any hour', others.length > 20 && clash.length === 0,
    j(clash));
  /* The response cache: a realtime run moves no version, so the price waits
     for the next pass that does — a rollup or an incremental, eight minutes on. */
  const movers = [...mins('15,45 * * * *'), ...mins('*/30 * * * *')];
  check('a rollup or an incremental starts eight minutes after each run',
    [7, 22, 37, 52].every((m) => movers.some((v) => (v - m + 60) % 60 === 8)), j(movers));
  check('those two are what src/index.js schedules',
    /cron\.schedule\('15,45 \* \* \* \*', \(\) => refreshRollups/.test(idx)
    && /cron\.schedule\('\*\/30 \* \* \* \*', \(\) => incremental\(\)/.test(idx));
  const cache = readFileSync('api/cache.js', 'utf8');
  check('and the cache version still skips realtime runs', /mode IS DISTINCT FROM 'realtime'/.test(cache)
    && T.MODE === 'realtime');
  check('a by-hand command runs one pass', /if \(cmd === 'live-money'\) return liveMoneyTick\(\);/.test(idx));
}

/* ══ 8. the probes ask with POST ═══════════════════════════════════════════ */
console.log('\nthe probes ask the way the feed answers');
{
  const sent = [];
  const fakeHttp = async (url, opts) => { sent.push({ url, ...opts }); return { status: 200, data: { transactions: [txn({ id: 'p1', trip: 'tp', at: '2026-11-12T09:50:00Z' })] } }; };
  const p = await T.probeTransactions({ org: 'org-ecosine-enc', token: 'tok', now: new Date('2026-11-12T10:07:30Z'), httpImpl: fakeHttp });
  check('probeTransactions POSTs the documented body over the newest legal window',
    sent.length === 1 && sent[0].method === 'POST' && sent[0].url === T.txnUrl('org-ecosine-enc')
    && JSON.parse(sent[0].body).filters[0].operator === 'FILTER_OPERATOR_IN_RANGE'
    && p.window[0] === '2026-11-12T09:45:00.000Z' && p.status === 200, j(sent[0]));
  /* The probes store describe() of what this returns, and describe() prints
     a field's values when there are a dozen or fewer — a quiet window's
     drivers' names, every night. */
  const { describe } = await import('../src/probe.js');
  const described = j(describe(p.data.transactions));
  check('the probe sees that Uber sends a name, and never the name itself',
    /driverInfo\.firstName/.test(described) && /driverInfo\.lastName/.test(described)
    && !/Test|Driver"/.test(described) && !/"Test"|"Driver"/.test(j(p.data)), described.slice(0, 160));
  const none = await T.probeTransactions({ org: 'o', token: 't', from: '2026-11-01', to: '2026-11-01T23:59:59Z',
    now: new Date('2026-11-12T10:07:30Z'), httpImpl: async () => { throw new Error('asked'); } });
  check('a window the feed cannot serve is not asked at all', none.window === null && none.status === null);

  const probeSrc = readFileSync('src/probe.js', 'utf8');
  check('the nightly probe no longer builds a GET URL for the feed',
    !/vehicle-suppliers\/transactions\?\$\{qs\(/.test(probeSrc) && !/transactions:\s*\(org\)\s*=>\s*`https/.test(probeSrc));
  const { surfaces } = await import('../src/probe.js');
  const s = surfaces({ from: new Date('2026-11-09'), to: new Date('2026-11-12') })
    .find((x) => x.provider === 'uber' && x.surface === 'transactions');
  check('…it asks through probeTransactions, measured against uber_live_transaction',
    Boolean(s) && /POST/.test(s.note) && s.cols === T.TXN_COLS && s.aliases === T.TXN_ALIASES
    && /probeTransactions\(\{ org: config\.uber\.org \}\)/.test(probeSrc), j(s && { note: s.note }));
  const apiSrc = readFileSync('api/probe.js', 'utf8');
  check('/api/probe/uber/rest sends the feed through probeTransactions',
    /name === 'transactions'\s*\?\s*await probeTransactions\(\{ org: config\.uber\.org, token \}\)/.test(apiSrc)
    && !/transactions\?org_id=\$\{encodeURIComponent\(org\)\}&limit=50/.test(apiSrc));
  check('/api/probe/uber/window asks the newest legal quarter hour, or says why it cannot',
    /probeTransactions\(\{ org, token, from: new Date\(from\), to: new Date\(to\) \}\)/.test(apiSrc)
    && !/transactions: `https:\/\/api\.uber\.com\/v1\/vehicle-suppliers\/transactions\?\$\{qs/.test(apiSrc));
}

/* ══ 9. GET /api/status/uber-live-money ═══════════════════════════════════════════ */
console.log('\nGET /api/status/uber-live-money');
{
  const { mountAll } = await import('./mount.mjs');
  const m = await mountAll(db, { serverRoutes: false });
  check('the route module is discovered', m.mounted.some((x) => /uber_live_money_routes\.js:uberLiveMoneyRoutes/.test(x)));
  /* The runs it reports move no cache version (mode realtime), so a cached
     answer would go stale for as long as nothing else ran. It must sit under
     a prefix the response cache never holds — read off api/cache.js itself. */
  const never = [...(readFileSync('api/cache.js', 'utf8').match(/const NEVER = \[([\s\S]*?)\];/)?.[1] || '')
    .replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const declared = readFileSync('api/uber_live_money_routes.js', 'utf8').match(/app\.get\('([^']+)'/)?.[1] || '';
  check('the route is on a prefix the response cache never serves',
    never.length > 5 && declared === '/api/status/uber-live-money' && never.some((p) => declared.startsWith(p)),
    `${declared} against ${j(never)}`);
  const r = await m.get('/api/status/uber-live-money');
  const ec = r.body?.fleets?.find((x) => x.fleet === 'ecosine');
  const eg = r.body?.fleets?.find((x) => x.fleet === 'egari');
  check('200, both fleets', r.status === 200 && ec && eg, j(r.body).slice(0, 200));
  /* t-live still carries the feed's price; t-null was confirmed by the
     payments report at 47.50 against the feed's 46.94. */
  check('the feed\'s provisional prices, counted and summed',
    ec?.provisional?.trips === 2 && Math.abs(ec.provisional.aed - 93.88) < 0.001, j(ec?.provisional));
  check('agreement with the payments report, measured on the trips both priced',
    ec?.agreement?.confirmed === 2 && ec.agreement.agreed === 0 && ec.agreement.worst_gap_aed === 3.16,
    j(ec?.agreement));
  check('a fleet the feed never ran for is absent with the reason, not zero',
    Boolean(eg) && (eg.last_run !== null || /has not run/.test(eg.absent || '')), j(eg));
  const only = await m.get('/api/status/uber-live-money?fleet=egari');
  check('the fleet filter narrows to one fleet', only.body?.fleets?.length === 1 && only.body.fleets[0].fleet === 'egari');
  await q(`DELETE FROM collection_run WHERE fleet_id = 'egari'`);
  const absent = await m.get('/api/status/uber-live-money?fleet=egari');
  check('no run at all reads as absent, with what it needs', absent.body?.fleets?.[0]?.last_run === null
    && /UBER_ORG_ENCRYPTED_EGARI/.test(absent.body.fleets[0].absent), j(absent.body?.fleets?.[0]));
  /* An empty day is a zero only if Uber answered (independent review): a day
     of refused runs holds no transaction either, and "Uber reported none"
     would be a reason that is not the true one. Egari holds no transaction
     at all here, whatever the clock says. */
  const egariRun = (status, error = null) => q(
    `INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, finished_at, error)
     VALUES ('uber_transactions', 'egari', 'realtime', $1, 0, now(), $2)`, [status, error]);
  await egariRun('error', '4 of 4 windows refused: 403 from Uber — bad key');
  const refused = (await m.get('/api/status/uber-live-money?fleet=egari')).body?.fleets?.[0] || {};
  check('a day of refused runs is NOT a zero: not measured, and the last run\'s own words',
    refused.last_24h?.transactions === null && /not measured/.test(refused.last_24h?.why || '')
    && /bad key/.test(refused.last_24h.why), j(refused.last_24h));
  check('…and nothing the feed priced means nothing to compare, said as that',
    refused.agreement?.pct === null && /nothing to compare/.test(refused.agreement?.why || ''), j(refused.agreement));
  await egariRun('ok');
  const quiet = (await m.get('/api/status/uber-live-money?fleet=egari')).body?.fleets?.[0] || {};
  check('a day Uber answered with nothing is a measured zero, and says it was answered',
    quiet.last_24h?.transactions === 0 && /answered/.test(quiet.last_24h?.why || ''), j(quiet.last_24h));
  await q(`UPDATE trip SET price_source = 'uber_live' WHERE price_source = 'uber_payments'`);
  await q(`UPDATE trip SET price_source = NULL WHERE external_id = 't-stmt'`);
  const unmeasured = (await m.get('/api/status/uber-live-money?fleet=ecosine')).body?.fleets?.[0] || {};
  check('no trip priced by both yet: agreement absent, with the true reason',
    unmeasured.agreement?.pct === null && /hours after the live feed/.test(unmeasured.agreement?.why || ''), j(unmeasured.agreement));
  m.server.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
await db.close();
process.exit(fail ? 1 : 0);
