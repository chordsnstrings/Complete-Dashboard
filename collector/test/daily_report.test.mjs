/* THE 07:00 DAILY REPORT EMAIL — figures, commentary, and the send.
   ═══════════════════════════════════════════════════════════════════════════
   src/daily_report.js against a real schema (PGlite), a fake model and a
   fake Resend. Synthetic drivers only (@example.test, Test Driver …).

   What is pinned:
     1. the figures are the day page's own (buildDay) plus the counts the
        operator asked for: cash trips from trip_cash (Uber's cash-collected
        where it exists), active cars, cars and drivers that earned, and the
        two averages — with bookings that have no fare yet NAMED, never valued;
     2. a channel that did not deliver the day is named in the email;
     3. the model sees no name, no id and no plate, and a commentary carrying
        a number that is not in the figures is dropped, with the reason;
     4. each address gets one day's email once; a failed send is retried; the
        list seeds once from the environment.

   REVERSIONS, run 2026-09-29, recorded beside the checks they break. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;

process.env.RESEND_API_KEY = 'resend-key-under-test';
process.env.REPORT_MODEL_API_KEY = 'model-key-under-test';
process.env.REPORT_RECIPIENTS = 'ops@example.test, boss@example.test';

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

const R = await import('../src/daily_report.js');
const { reportFacts, guardCommentary, numbersIn, modelInput, renderEmail, dailyReportRun, recipients } = R;

/* D = 2026-09-27, a Dubai day. Requested times are UTC; 20:30Z the day
   before is 00:30 Dubai on D. */
const T = (id, o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
   VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz + interval '20 minutes', $8, $9, $10, 'AED', $11::jsonb)`,
  [o.platform || 'uber', id, o.fleet || 'ecosine', o.driver, o.name, o.plate, o.at, o.status || 'completed',
    o.pay || 'card', o.price ?? null, j(o.cash != null ? { uber_payments: { cash_collected: -o.cash } } : {})]);
await T('a1', { driver: 'u-a', name: 'Test Driver A', plate: 'P1', at: '2026-09-26T20:30:00Z', price: 100, pay: 'cash', cash: 110 });
await T('a2', { driver: 'u-a', name: 'Test Driver A', plate: 'P1', at: '2026-09-27T10:00:00Z', price: 50 });
await T('b1', { driver: 'u-b', name: 'Test Driver B', plate: 'P2', at: '2026-09-27T12:00:00Z', price: 30 });
await T('b2', { platform: 'bolt', driver: 'b-b', name: 'Test Driver B', plate: 'P2', at: '2026-09-27T13:00:00Z', price: 20, pay: 'cash' });
/* A booking with no fare yet: counted, never valued at nought. */
await T('c1', { driver: 'u-c', name: 'Test Driver C', plate: 'P3', at: '2026-09-27T14:00:00Z', price: null });
/* Outside the day: 20:00Z on D is 00:00 Dubai the next day. */
await T('z1', { driver: 'u-a', name: 'Test Driver A', plate: 'P1', at: '2026-09-27T20:00:00Z', price: 999 });
/* Uber delivered the day; Bolt did not (its last run finished before D ended). */
const run = (source, fleet, finished, windowEnd) => q(
  `INSERT INTO collection_run (source, fleet_id, mode, window_start, window_end, status, rows_written, finished_at)
   VALUES ($1, $2, 'incremental', $4::date - 2, $4::date, 'ok', 5, $3::timestamptz)`, [source, fleet, finished, windowEnd]);
await run('uber', 'ecosine', '2026-09-27T22:00:00Z', '2026-09-27');
await run('bolt', 'ecosine', '2026-09-27T12:00:00Z', '2026-09-27');

/* ── 1. the figures ────────────────────────────────────────────────────────
   REVERSION: cash summed from the fare instead of trip_cash's amount
   -> 27 passed, 2 FAILED: "cash is what the driver holds…" (120 against
      130) and "a driver's row…" (A's cash 100 against Uber's 110).
   REVERSION: drivers_earned counting everyone who drove -> 27 passed,
   2 FAILED: "drivers who earned exclude…" [3,3] and "average per driver…"
   (66.67 against 100). */
console.log('\n1. the figures, from the day page and trip_cash');
const f = await reportFacts(q, '2026-09-27');
check('fares are the day’s priced bookings, inside the Dubai day only', f.fares === 200 && f.priced === 4, `${f.fares} ${f.priced}`);
check('a booking with no fare is counted and named, not valued', f.unpriced === 1 && f.bookings === 5, j([f.unpriced, f.bookings]));
check('cash is what the driver holds: Uber’s cash-collected, the fare elsewhere',
  f.cash.trips === 2 && f.cash.amount === 130, j(f.cash));
check('active cars: every plate that worked', f.cars.active === 3, j(f.cars));
check('cars that earned: at least one priced booking', f.cars.earned === 2, j(f.cars));
check('drivers who earned exclude the one whose only booking has no fare',
  f.drivers_earned === 2 && f.drivers_drove === 3, j([f.drivers_earned, f.drivers_drove]));
check('average per driver and per car: fares over those that earned',
  f.avg_per_driver === 100 && f.avg_per_car === 100, j([f.avg_per_driver, f.avg_per_car]));
const a = f.drivers.find((p) => p.name === 'Test Driver A');
const b = f.drivers.find((p) => p.name === 'Test Driver B');
check('a driver’s row: bookings, fares and their own cash', a.bookings === 2 && a.fares === 150 && a.cash === 110, j(a));
check('one person across two channels is one row', b.platforms.join() === 'bolt,uber' && b.fares === 50 && b.cash === 20, j(b));
check('the channel that did not deliver the day is named',
  f.collection.missing.length === 1 && f.collection.missing[0].platform === 'bolt', j(f.collection));

/* ── 2. the model sees no one, and may not move a number ───────────────────
   (Until 2026-09-29 the model was shown no names; the operator ruled that
   it sees drivers by name, so the check below now asserts the names.)
   REVERSION: guardCommentary always ok -> 27 passed, 2 FAILED: "a number
   that is not in the figures is caught" and "a commentary with a number not
   in the figures is dropped…". */
console.log('\n2. the commentary');
const shown = j(modelInput(f));
/* The operator, 2026-09-29: "GLM 5.2 always sees a person" — names and
   plates, not phone numbers. */
check('the model is shown the drivers by name, with their cars', /Test Driver A/.test(shown) && /P1/.test(shown), shown.slice(0, 200));
check('numbers are read as written', numbersIn('AED 1,234.50 and 7 cars, 12.0%').join() === '1234.5,7,12');
check('a sentence using only the figures passes',
  guardCommentary('Fares came to AED 200 from 5 bookings, with 2 cars earning; Bolt ecosine was not collected.', f).ok);
const stray = guardCommentary('Fares rose to AED 260 on 5 bookings.', f);
check('a number that is not in the figures is caught', !stray.ok && stray.stray.includes('260'), j(stray));

/* ── 3. the run: once per address per day, retried when it fails ───────── */
console.log('\n3. the send');
const calls = [];
let resendOk = true;
/* Since the analysis (2026-09-29) the model answers {summary, actions} in
   JSON; test/report_findings.test.mjs drives the actions. */
let modelSays = { summary: 'Yesterday brought 5 bookings and AED 200 in fares across 2 cars.', actions: [] };
const fakeHttp = async (url, opt = {}) => {
  const body = opt.body ? JSON.parse(opt.body) : null;
  calls.push({ url, body, headers: opt.headers });
  if (url.includes('/chat/completions')) {
    return { status: 200, data: { choices: [{ message: { content: JSON.stringify(modelSays) } }] } };
  }
  if (url.includes('api.resend.com')) {
    return resendOk ? { status: 200, data: { id: `re-${calls.length}` } }
      : { status: 403, data: { name: 'validation_error', message: 'The ecosine.ae domain is not verified.' } };
  }
  throw new Error(`unexpected ${url}`);
};
const now = new Date('2026-09-28T03:00:00Z');   // 07:00 Dubai on the 28th
resendOk = false;
const r1 = await dailyReportRun({ q, now, http: fakeHttp });
check('a refused send is recorded as failed, with Resend’s own words',
  r1.failed === 2 && (await q(`SELECT error FROM report_send WHERE status = 'failed'`))[0]?.error?.includes('not verified'), j(r1));
resendOk = true;
const r2 = await dailyReportRun({ q, now, http: fakeHttp });
check('…and retried at the next run', r2.sent === 2 && r2.failed === 0, j(r2));
/* REVERSION: the `sent` filter dropped from dailyReportRun -> 28 passed,
   1 FAILED: "an address is sent a day's email once" (2 more sends). */
const before = calls.filter((c) => c.url.includes('resend')).length;
const r3 = await dailyReportRun({ q, now, http: fakeHttp });
check('an address is sent a day’s email once', r3.due === 0
  && calls.filter((c) => c.url.includes('resend')).length === before, j(r3));
const modelCalls = calls.filter((c) => c.url.includes('/chat/completions'));
check('the commentary is written once per day, and the retry sends what 07:00 composed', modelCalls.length === 1, String(modelCalls.length));
check('the model asked is GLM 5.2, with its reasoning off',
  modelCalls[0]?.body?.model === 'glm-5-2-260617' && modelCalls[0]?.body?.thinking?.type === 'disabled', j(modelCalls[0]?.body?.model));
const sends = calls.filter((c) => c.url.includes('resend') && c.headers?.['Idempotency-Key']);
check('each send carries its own idempotency key, so Resend drops a duplicate',
  sends.every((c) => /^daily-report\/2026-09-27\/.+@example\.test$/.test(c.headers['Idempotency-Key'])), j(sends.map((c) => c.headers['Idempotency-Key'])));
check('one address per email — no recipient sees the others', sends.every((c) => c.body.to.length === 1));
const html = sends.at(-1)?.body?.html || '';
check('the email carries the commentary the model wrote', html.includes('Yesterday brought 5 bookings'));
check('…the figures asked for', ['Revenue — fares', 'Cash trips', 'Active cars', 'Cars that earned',
  'Drivers who earned', 'Average per driver', 'Average per car'].every((w) => html.includes(w)));
check('…every driver who drove, by name', html.includes('Test Driver A') && html.includes('Test Driver C'));
check('…and the channel that did not deliver', /Not in these figures: Bolt · Ecosine/.test(html));
check('the subject says the day and its headline', /^Fleet 2026-09-27 — AED 200\.00 fares/.test(sends.at(-1)?.body?.subject || ''),
  sends.at(-1)?.body?.subject);

/* A commentary that invents a number is left out, and the email says so. */
await q(`DELETE FROM report_run`); await q(`DELETE FROM report_send`);
modelSays = { summary: 'Fares climbed 30% to AED 260.', actions: [] };
await dailyReportRun({ q, now, http: fakeHttp });
const html2 = calls.filter((c) => c.url.includes('resend')).at(-1)?.body?.html || '';
check('a commentary with a number not in the figures is dropped, and the email says why',
  !html2.includes('climbed') && /No commentary today — it stated 30; 260/.test(html2), html2.match(/No commentary[^<]*/)?.[0]);

/* ── 4. the list ───────────────────────────────────────────────────────── */
console.log('\n4. the list');
const list = await recipients(q, { initial: 'someone-else@example.test' });
check('seeded once from the environment, and not again', list.join() === 'ops@example.test,boss@example.test', list.join());
const rendered = renderEmail({ ...f, fares: null, priced: 0, avg_per_driver: null, avg_per_car: null }, null);
check('a figure that cannot be measured says so, in words, never a nought',
  /Revenue — fares[\s\S]*not measured — no booking had a fare yet/.test(rendered.html)
  && /Average per driver[\s\S]*not measured/.test(rendered.html), '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
