/* THE 08:00 LOW-TRIPS EMAIL — active drivers under the day's minimum.
   ═══════════════════════════════════════════════════════════════════════════
   src/low_trips_email.js against a real schema (PGlite) and a fake Resend.
   Synthetic drivers only (Test Driver …, @example.test).

   What is pinned — the operator's words and answers, 2026-09-30:
     1. ACTIVE is a completed trip in the eight Dubai days to yesterday; a TRIP
        is a completed booking on any platform, one person across platforms;
        a driver is listed when yesterday's trips are UNDER the minimum (ten
        is enough), including a driver who did not drive at all;
     2. the minimum is the Access page's low_trips_min, read when it runs;
     3. a platform that had not delivered yesterday is named, and every
        driver who works there is marked as possibly short;
     4. each address gets a day's list once, composed once; a failed send is
        retried.

   REVERSIONS, run 2026-09-30, recorded beside the checks they break. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;

process.env.RESEND_API_KEY = 'resend-key-under-test';
process.env.LOW_TRIPS_RECIPIENTS = 'Ops@Example.test, boss@example.test';
delete process.env.PUBLIC_URL;

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

const { lowTripsFacts, renderLowTripsEmail, lowTripsRun, minTrips, lowTripsRecipients, ACTIVE_DAYS } =
  await import('../src/low_trips_email.js');
const { DEFAULTS } = await import('../api/access/service.js');

/* D = 2026-09-29 (Dubai). 06:00Z is 10:00 Dubai. */
const D = '2026-09-29';
let n = 0;
const T = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
   VALUES ($1, $2, $3, $4, $5, 'P1', $6::timestamptz, $6::timestamptz + interval '20 minutes', $7, 'card', 20, 'AED', '{}'::jsonb)`,
  [o.platform || 'uber', `t${++n}`, o.fleet || 'ecosine', o.id || `${o.platform || 'uber'}-${o.name}`, o.name, o.at, o.status || 'completed']);
const many = async (k, o) => { for (let i = 0; i < k; i++) await T({ ...o, at: new Date(Date.parse(o.at) + i * 60_000).toISOString() }); };
await many(12, { name: 'Test Driver A', at: '2026-09-29T06:00:00Z' });                       // 12: enough
await many(3, { name: 'Test Driver B', at: '2026-09-29T06:00:00Z' });                        // 3 Uber …
await T({ name: 'Test Driver B', platform: 'bolt', at: '2026-09-29T09:00:00Z' });            // … + 1 Bolt = 4
await many(11, { name: 'Test Driver B', at: '2026-09-25T06:00:00Z' });                       // the week before:
await many(9, { name: 'Test Driver B', at: '2026-09-27T06:00:00Z' });                        //   20 on 2 days
await many(5, { name: 'Test Driver C', at: '2026-09-26T06:00:00Z' });                        // active, none yesterday
await T({ name: 'Test Driver C', platform: 'fms', at: '2026-09-29T08:00:00Z' });             // a journey, not a trip
await many(6, { name: 'Test Driver D', at: '2026-09-21T06:00:00Z' });                        // 8 days before D: not active
await many(9, { name: 'Test Driver E', at: '2026-09-29T06:00:00Z' });                        // 9 completed …
await many(3, { name: 'Test Driver E', at: '2026-09-29T10:00:00Z', status: 'cancelled' });   // … + 3 cancelled
await many(10, { name: 'Test Driver F', platform: 'yango', fleet: 'egari', at: '2026-09-29T06:00:00Z' }); // exactly 10
await many(10, { name: 'Test Driver G', at: '2026-09-29T20:30:00Z' });                       // 00:30 Dubai on the 30th
await T({ name: 'Test Driver G', at: '2026-09-28T06:00:00Z' });                              // G: active, 0 yesterday
/* Uber delivered the day; Bolt Ecosine did not (its last run finished before D ended). */
const run = (source, fleet, finished) => q(
  `INSERT INTO collection_run (source, fleet_id, mode, window_start, window_end, status, rows_written, finished_at)
   VALUES ($1, $2, 'incremental', '2026-09-27', '2026-09-29', 'ok', 5, $3::timestamptz)`, [source, fleet, finished]);
await run('uber', 'ecosine', '2026-09-29T22:00:00Z');
await run('yango', 'egari', '2026-09-29T22:00:00Z');
await run('bolt', 'ecosine', '2026-09-29T12:00:00Z');

/* ── 1. who is listed ──────────────────────────────────────────────────────
   REVERSION: count every booking instead of completed ones (drop
   `AND outcome = 'completed'`) -> 26 passed, 6 FAILED, among them
   "cancelled bookings are not trips…" (E has 12, so E drops off the list).
   REVERSION: `< min` written `<= min` -> 27 passed, 5 FAILED, among them
   "exactly the minimum is enough".
   REVERSION: active over the whole history (drop the window's lower bound)
   -> 25 passed, 7 FAILED, among them "a driver whose last trip is 8 days
   before…" and "the active count". */
console.log('\n1. who is listed');
const f = await lowTripsFacts(q, D, { min: 10 });
const names = f.below.map((x) => x.name);
check('below the minimum, fewest first: none yesterday, then 4, then 9',
  j(names) === '["Test Driver C","Test Driver G","Test Driver B","Test Driver E"]', j(f.below.map((x) => [x.name, x.yesterday])));
check('the active count: everyone with a completed trip in the 8 days to yesterday', f.active === 6 && ACTIVE_DAYS === 8, String(f.active));
check('twelve trips: not listed', !names.includes('Test Driver A'));
check('exactly the minimum is enough', !names.includes('Test Driver F'));
check('a driver whose last trip is 8 days before yesterday is not active, so not listed', !names.includes('Test Driver D'));
const E = f.below.find((x) => x.name === 'Test Driver E');
check('cancelled bookings are not trips: 9 completed, listed', E?.yesterday === 9, j(E));
const B = f.below.find((x) => x.name === 'Test Driver B');
check('one person across two platforms is one row, summed, with the split',
  B?.yesterday === 4 && j(B.by_platform) === '[{"platform":"uber","trips":3},{"platform":"bolt","trips":1}]', j(B));
check('…and the seven days before: 20 trips on 2 days', B?.before === 20 && B.before_days === 2, j(B));
const C = f.below.find((x) => x.name === 'Test Driver C');
check('active but did not drive: 0, with the last day driven, and a telematics journey is not a trip',
  C?.yesterday === 0 && C.last_day === '2026-09-26', j(C));
const G = f.below.find((x) => x.name === 'Test Driver G');
check('a trip at 00:30 Dubai the next day is not yesterday’s', G?.yesterday === 0, j(G));
check('drivers at or above: 2; none yesterday: 2', f.at_or_above === 2 && f.did_not_drive === 2, j([f.at_or_above, f.did_not_drive]));

/* ── 2. the minimum is the Access page's ──────────────────────────────────
   REVERSION: minTrips ignoring the setting (always 10) -> 31 passed,
   1 FAILED ("the setting is what is used"). */
console.log('\n2. the minimum');
check('the default on the Access page is 10', DEFAULTS.low_trips_min === 10);
check('the setting is what is used', minTrips({ low_trips_min: 5 }) === 5);
check('a missing or broken setting falls back to 10, never to 0',
  minTrips({}) === 10 && minTrips({ low_trips_min: 0 }) === 10 && minTrips({ low_trips_min: 'x' }) === 10 && minTrips({ low_trips_min: 2.5 }) === 10);
const f5 = await lowTripsFacts(q, D, { min: 5 });
check('with 5: only those under 5', j(f5.below.map((x) => x.name)) === '["Test Driver C","Test Driver G","Test Driver B"]', j(f5.below.map((x) => x.name)));

/* ── 3. a platform that had not delivered ─────────────────────────────────
   REVERSION: drop the maybe_short marking -> 30 passed, 2 FAILED ("a
   driver who works there is marked…", and the email check). */
console.log('\n3. a platform that had not delivered');
check('Bolt · Ecosine had not delivered the day', j(f.collection.missing) === '[{"platform":"bolt","fleet":"ecosine"}]', j(f.collection));
check('a driver who works there is marked as possibly short; one who does not is not',
  j(B?.maybe_short) === '[{"platform":"bolt","fleet":"ecosine"}]' && E?.maybe_short.length === 0, j([B?.maybe_short, E?.maybe_short]));

console.log('\n4. the email');
const { html, text, subject } = renderLowTripsEmail(f, { dashboard: 'https://fleet.example.test' });
check('the subject: the minimum, the day, how many of how many',
  /^Under 10 trips — Tue 29 Sept? · 4 of 6 active drivers$/.test(subject), subject);
check('every listed driver is in it, and nobody else',
  ['Test Driver B', 'Test Driver C', 'Test Driver E', 'Test Driver G'].every((s) => html.includes(s) && text.includes(s))
  && !/Test Driver [ADF]/.test(html + text));
check('the platform that had not delivered is named at the top, and under the driver',
  html.includes('Bolt · Ecosine had not delivered Tuesday’s trips') && html.includes('Bolt · Ecosine had not delivered — the count may be short'));
check('a driver who did not drive says so, with the last day', html.includes('Did not drive Tuesday; last trip 2026-09-26.'));
check('the split for a driver on two platforms', html.includes('Uber 3 · Bolt 1') && text.includes('(Uber 3, Bolt 1)'));
check('the seven days before, and the daily rate', html.includes('20 on 2 days') && html.includes('10.0 a day'));
check('it says what active and a trip mean, and where the minimum is set',
  /Active means at least one completed trip in the 8 days/.test(html) && /set by the Owner on the Access page/.test(html));
const big = { ...f, below: Array.from({ length: 150 }, (_, i) => ({ ...B, name: `Test Driver ${i}` })) };
check('150 drivers stay under Gmail’s clipping size', Buffer.byteLength(renderLowTripsEmail(big).html) < 100_000,
  `${Buffer.byteLength(renderLowTripsEmail(big).html)} bytes`);

/* ── 5. the send ─────────────────────────────────────────────────────────
   REVERSION: stop reading low_trips_email_send before sending -> 30
   passed, 2 FAILED ("a second run the same morning sends nothing", and the
   last check, which counts the sends before it).
   REVERSION: recount on every run instead of reusing the kept list -> 31
   passed, 1 FAILED ("a retry sends the list 08:00 composed…"). */
console.log('\n5. the send');
const posts = [];
let status = 200;
const http = async (url, opt) => {
  posts.push({ url, headers: opt.headers, body: JSON.parse(opt.body) });
  return status === 200 ? { status: 200, data: { id: `re_${posts.length}` } } : { status, data: { message: 'down' } };
};
check('the addresses from the setting, lower-cased', j(lowTripsRecipients()) === '["ops@example.test","boss@example.test"]');
status = 500;
let r = await lowTripsRun({ q, http, day: D, cfg: { low_trips_min: 10 }, now: new Date('2026-09-30T04:00:00Z') });
check('08:00: Resend down — both recorded as failed', r.failed === 2 && r.sent === 0, j(r));
status = 200;
r = await lowTripsRun({ q, http, day: D, cfg: { low_trips_min: 5 }, now: new Date('2026-09-30T04:15:00Z') });
check('08:15: both sent', r.sent === 2, j(r));
check('a retry sends the list 08:00 composed, not one recounted with a minimum changed since',
  r.min === 10 && posts.at(-1).body.subject.startsWith('Under 10 trips'), posts.at(-1)?.body.subject);
check('the Resend call: one address each, the day’s idempotency key',
  j(posts.at(-1).body.to) === '["boss@example.test"]' && posts.at(-1).headers['Idempotency-Key'] === `low-trips/${D}/boss@example.test`);
r = await lowTripsRun({ q, http, day: D, cfg: { low_trips_min: 10 }, now: new Date('2026-09-30T04:30:00Z') });
check('a second run the same morning sends nothing', r.due === 0 && posts.length === 4, j([r, posts.length]));
process.env.LOW_TRIPS_RECIPIENTS = '';
r = await lowTripsRun({ q, http, day: '2026-09-28', cfg: {}, now: new Date('2026-09-29T04:00:00Z') });
check('no address set: nothing sent, and the reason returned', /LOW_TRIPS_RECIPIENTS is empty/.test(r.why || '') && posts.length === 4, j(r));

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
