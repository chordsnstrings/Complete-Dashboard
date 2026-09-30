/* THE 08:00 CASH EMAIL — every driver texted to deposit yesterday's cash.
   ═══════════════════════════════════════════════════════════════════════════
   src/cash_sms_email.js against a real schema (PGlite) and a fake Resend.
   Synthetic drivers only (Test Driver …, 97150000000x, @example.test).

   What is pinned:
     1. the list is the texts the gateway accepted for that cash day — name,
        the mobile the text went to, the amount in the text, and the split by
        platform the 05:00 run kept; nothing else is in it;
     2. what cannot be said is said to be unknown: a split not kept, cash on a
        platform the text left out, a text the gateway reported undelivered,
        drivers with cash who were not texted (counted, by reason);
     3. it waits for the cash text run to finish, and at 09:15 goes anyway,
        saying why the list is short or empty;
     4. each address gets a day's list once; a failed send is retried; with
        no address set nothing is sent.

   REVERSIONS, run 2026-09-30, recorded beside the checks they break. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;

process.env.RESEND_API_KEY = 'resend-key-under-test';
process.env.CASH_REPORT_RECIPIENTS = 'Desk@Example.test';
delete process.env.PUBLIC_URL;

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

const { cashEmailFacts, renderCashEmail, cashEmailRun, readablePhone, lastCall, cashRecipients, runNote } =
  await import('../src/cash_sms_email.js');

const D = '2026-09-29';
for (const [id, name] of [[1, 'Test Driver A'], [2, 'Test Driver B'], [3, 'Test Driver C'], [4, 'Test Driver D'],
  [5, 'Test Driver E'], [6, 'Test Driver F'], [7, 'Test Driver G'], [8, 'Test Driver H']]) {
  await q(`INSERT INTO driver (id, fleet_id, full_name) VALUES ($1, 'ecosine', $2)`, [id, name]);
}
let n = 0;
const msg = (o) => q(
  `INSERT INTO sms_outbox (kind, dedupe_key, person_id, business_day, destination, message_text, status, hold_reason, detail, sent_at, provider_status)
   VALUES ($1, $2, $3, $4, $5, 'text', $6, $7, $8::jsonb, $9, $10)`,
  [o.kind || 'cash_deposit', o.key || `cash:${o.person}:${o.day || D}:${++n}`, o.person ?? null, o.day || D, o.to ?? null,
    o.status || 'sent', o.hold || null, j(o.detail || {}), o.status === 'sent' || !o.status ? '2026-09-30T01:05:00Z' : null, o.dlr ?? null]);
/* A: two platforms, split kept, delivered. */
await msg({ person: 1, to: '971500000001', dlr: 'Delivered', detail: { amount: 150.5, channels: ['uber', 'bolt'],
  by_channel: [{ platform: 'bolt', amount: 40, trips: 1, fleets: ['ecosine'] }, { platform: 'uber', amount: 110.5, trips: 2, fleets: ['ecosine'] }], left_out: [] } });
/* B: texted before the split was kept, one platform — the whole amount is that platform's. */
await msg({ person: 2, to: '971500000002', dlr: 'Delivered', detail: { amount: 44, channels: ['uber'], left_out: [] } });
/* C: texted before the split was kept, two platforms — the split is unknown. */
await msg({ person: 3, to: '971500000003', detail: { amount: 53, channels: ['uber', 'yango'], left_out: [] } });
/* D: Yango left out (no fare yet); the gateway reported the text undelivered. */
await msg({ person: 4, to: '971500000004', dlr: 'Undelivered', detail: { amount: 55, channels: ['uber'],
  by_channel: [{ platform: 'uber', amount: 55, trips: 1, fleets: ['egari'] }],
  left_out: [{ platform: 'yango', fleets: ['egari'], trips: 1, known_aed: 0, why: 'not_priced' },
    { platform: 'bolt', fleets: ['egari'], trips: 0, known_aed: 0, why: 'not_collected' }] } });
/* Not texted: held twice, refused by the gateway once. */
await msg({ person: 5, status: 'held', hold: 'no_number', detail: { amount: 20, channels: ['uber'] } });
await msg({ person: 6, status: 'held', hold: 'no_number', detail: { amount: 25, channels: ['uber'] } });
await msg({ person: 7, status: 'failed', to: '971500000007', detail: { amount: 30, channels: ['uber'] } });
/* Another day's text, and a trip request: neither is this list. */
await msg({ person: 8, to: '971500000008', day: '2026-09-28', detail: { amount: 999, channels: ['uber'] } });
await msg({ person: 8, kind: 'trip_register', to: '971500000008', detail: {} });
const runRow = (status, reason, detail) => q(
  `INSERT INTO sms_outbox (kind, dedupe_key, status, hold_reason, business_day, detail) VALUES ('cash_run', $1, $2, $3, $4, $5::jsonb)
   ON CONFLICT (dedupe_key) DO UPDATE SET status = $2, hold_reason = $3, detail = $5::jsonb`,
  [`cash-run:${D}`, status, reason, D, j(detail)]);
await runRow('sent', null, { finished: true, people: 7, sent: 5, held: 2 });

/* ── 1. the list ──────────────────────────────────────────────────────────
   REVERSION: drop `AND m.status = 'sent'` -> 29 passed, 6 FAILED (the list,
   the total, the platform totals, the subject, and the two "who is named"
   checks: the held and the refused drivers appear).
   REVERSION: stop reading detail.by_channel -> 31 passed, 4 FAILED ("A's
   split…", "two platforms and no split kept…", "the platform totals…", "the
   platform each amount came from"). */
console.log('\n1. the list is the texts');
const f = await cashEmailFacts(q, D);
check('only the texts the gateway accepted for that cash day, largest first',
  j(f.drivers.map((x) => x.person_id)) === '[1,4,3,2]', j(f.drivers.map((x) => [x.person_id, x.amount])));
const A = f.drivers.find((x) => x.person_id === 1);
check('a row is the name, the mobile texted and the amount in the text',
  A.name === 'Test Driver A' && A.phone === '971500000001' && A.amount === 150.5, j(A));
check('A’s split is the one the run kept: Uber 110.50, Bolt 40.00, Uber first',
  j((A.split || []).map((c) => [c.platform, c.amount])) === '[["uber",110.5],["bolt",40]]', j(A.split));
check('a text on one platform with no split kept: that platform is the whole amount',
  j((f.drivers.find((x) => x.person_id === 2).split || []).map((c) => [c.platform, c.amount])) === '[["uber",44]]');
const C = f.drivers.find((x) => x.person_id === 3);
check('two platforms and no split kept: both named, no amount guessed for either',
  C.split === null && j(C.platforms) === '["uber","yango"]' && f.unsplit === 1, j(C));
check('the total is the sum of the amounts texted', f.total === 302.5, String(f.total));
check('the platform totals add only the splits that are known',
  j(f.by_platform) === '[{"platform":"uber","amount":209.5},{"platform":"bolt","amount":40}]', j(f.by_platform));
check('drivers with cash who were not texted are counted by reason',
  j(f.not_texted.map((o) => [o.status, o.reason, o.n])) === '[["held","no_number",2],["failed",null,1]]', j(f.not_texted));

/* ── 2. the email ─────────────────────────────────────────────────────────
   REVERSION: drop the left_out notes from the HTML row -> 34 passed,
   1 FAILED ("cash on a platform the text left out…").
   REVERSION: treat every provider_status as delivered -> 34 passed,
   1 FAILED ("a text the gateway reported undelivered…"). */
console.log('\n2. the email');
const { html, text, subject } = renderCashEmail(f, { dashboard: 'https://fleet.example.test' });
check('the subject names the day, the drivers and the total', subject === 'Cash to deposit — Tue 29 Sept · 4 drivers · AED 302.50'
  || subject === 'Cash to deposit — Tue 29 Sep · 4 drivers · AED 302.50', subject);
check('every texted driver is in it, with a readable mobile and the amount',
  ['Test Driver A', 'Test Driver B', 'Test Driver C', 'Test Driver D'].every((s) => html.includes(s) && text.includes(s))
  && html.includes('+971 50 000 0001') && text.includes('+971 50 000 0004') && html.includes('150.50') && html.includes('302.50'));
check('nobody who was not texted is named', !/Test Driver [EFGH]/.test(html + text) && !html.includes('999'));
check('the platform each amount came from', /Uber&nbsp;&nbsp;<span class="n">110\.50<\/span><br>Bolt&nbsp;&nbsp;<span class="n">40\.00/.test(html)
  && text.includes('Uber 110.50, Bolt 40.00'));
check('a split not kept says so, never a guessed amount', html.includes('Uber, Yango<br><span class="n">split not recorded for this text')
  && text.includes('Uber, Yango (split not recorded)'));
check('cash on a platform the text left out is named under the driver, and a platform with no cash trip is not',
  html.includes('Not in this amount: Yango, 1 cash trip — no amount yet') && !html.includes('Not in this amount: Bolt'));
check('…in the plain text too', text.includes('Not in this amount: Yango, 1 cash trip — no amount yet'));
check('a text the gateway reported undelivered, and one not reported yet, say so',
  html.includes('The gateway reported it “Undelivered”') && html.includes('The gateway has not reported delivery yet'));
check('the foot counts the drivers not texted, with the reason in words',
  /3 more drivers took cash on Tuesday and were not texted: 2 — no mobile on Uber or on HR’s roster for this driver; 1 — the SMS gateway refused the text\./.test(text), text.split('\n').slice(-1)[0]);
check('it links the Messages page', html.includes('https://fleet.example.test/#messages'));
check('readable mobile: UAE numbers grouped, anything else as stored',
  readablePhone('971501234567') === '+971 50 123 4567' && readablePhone('4412345') === '4412345');
/* Gmail clips a message past about 102 KB. 150 texted drivers, each on two
   platforms with a note, must still arrive whole. */
const big = { ...f, drivers: Array.from({ length: 150 }, (_, i) => ({ ...A, name: `Test Driver ${i}`,
  left_out: [{ platform: 'yango', trips: 2, known_aed: 12, why: 'not_priced' }] })), not_texted: [] };
const bigHtml = renderCashEmail(big).html;
check('150 drivers stay under Gmail’s clipping size', Buffer.byteLength(bigHtml) < 100_000, `${Buffer.byteLength(bigHtml)} bytes`);

/* ── 3. when it goes ──────────────────────────────────────────────────────
   REVERSION: wait until 09:15 whether or not the run finished (drop
   `!facts.run?.finished &&`) -> 32 passed, 3 FAILED ("08:00, finished run:
   sent…" and the two after it).
   REVERSION: no 09:15 last call -> 31 passed, 4 FAILED ("…and at 09:15 it
   goes anyway", "…saying why…", "the Resend call…", and the once-only
   check after it, which never sees a first send). */
console.log('\n3. when it goes');
const posts = [];
let resendStatus = 200;
const http = async (url, opt) => {
  posts.push({ url, headers: opt.headers, body: JSON.parse(opt.body) });
  return resendStatus === 200 ? { status: 200, data: { id: `re_${posts.length}` } } : { status: resendStatus, data: { message: 'down' } };
};
check('09:15 Dubai the morning after is the last call', lastCall(D).toISOString() === '2026-09-30T05:15:00.000Z', lastCall(D).toISOString());
check('the address from the setting, lower-cased, and a non-address ignored',
  j(cashRecipients('Desk@Example.test, nope, desk@example.test;x@y.ae')) === '["desk@example.test","x@y.ae"]');

/* A run still waiting for Uber at 08:00: nothing yet. */
await runRow('held', 'waiting', { finished: false, missing_catchup: ['egari'], uber_cash_trips_without_figure: 0 });
let r = await cashEmailRun({ q, http, day: D, now: new Date('2026-09-30T04:00:00Z') });
check('08:00, the cash text run still waiting: nothing sent yet', r.waiting === true && posts.length === 0, j(r));
r = await cashEmailRun({ q, http, day: D, now: new Date('2026-09-30T05:15:00Z') });
check('…and at 09:15 it goes anyway', r.sent === 1 && posts.length === 1, j(r));
check('…saying why the list may be short', posts[0]?.body.html.includes('still waiting for Uber’s figures')
  && posts[0]?.body.html.includes('Uber Egari had not caught up'), posts[0]?.body.text.slice(0, 300));
check('the Resend call: one address, the sender, the day’s idempotency key',
  j(posts[0]?.body.to) === '["desk@example.test"]' && posts[0].body.from === 'Ecosine Fleet <reports@ecosine.ae>'
  && posts[0]?.headers['Idempotency-Key'] === `cash-email/${D}/desk@example.test`
  && posts[0]?.headers.authorization === 'Bearer resend-key-under-test');

/* ── 4. once per address; a failure is retried ─────────────────────────────
   REVERSION: stop reading cash_email_send before sending -> 34 passed,
   1 FAILED ("…and a second run the same morning sends nothing"). */
console.log('\n4. once per address, and retried when it failed');
r = await cashEmailRun({ q, http, day: D, now: new Date('2026-09-30T05:30:00Z') });
check('…and a second run the same morning sends nothing', r.due === 0 && posts.length === 1, j(r));

const D2 = '2026-09-28';
await q(`INSERT INTO sms_outbox (kind, dedupe_key, status, business_day, detail) VALUES ('cash_run', $1, 'sent', $2, '{"finished":true}')`, [`cash-run:${D2}`, D2]);
resendStatus = 500;
r = await cashEmailRun({ q, http, day: D2, now: new Date('2026-09-29T04:00:00Z') });
const [failed] = await q(`SELECT status, error, attempts FROM cash_email_send WHERE business_day = $1`, [D2]);
check('08:00, finished run: sent — and a Resend failure is recorded as failed, with Resend’s words',
  r.failed === 1 && failed?.status === 'failed' && /Resend HTTP 500: down/.test(failed.error), j([r, failed]));
resendStatus = 200;
r = await cashEmailRun({ q, http, day: D2, now: new Date('2026-09-29T04:15:00Z') });
const [retried] = await q(`SELECT status, provider_id, attempts FROM cash_email_send WHERE business_day = $1`, [D2]);
check('…and sent on the next quarter hour, on the second attempt', r.sent === 1 && retried.status === 'sent' && retried.attempts === 2, j(retried));
check('a day with one earlier text: that driver, that amount', posts.at(-1)?.body.subject.includes('1 driver · AED 999.00'), posts.at(-1)?.body.subject);

console.log('\n5. nothing to say, said');
check('no run recorded for the day: said, not an empty table read as nobody owing',
  /did not record finishing for this day .* and nobody was texted\./.test(runNote({ run: null, drivers: [] }))
  && /so this list is only the drivers it had texted before it stopped\./.test(runNote({ run: null, drivers: [{}] })));
check('the run gave up at 09:00: nobody texted, and why',
  /Nobody was texted for this day: Uber’s figures for it were still not complete at 09:00 \(Uber Ecosine had not caught up\), and 3 Uber cash trips were still without Uber’s own amount\./
    .test(runNote({ run: { status: 'held', reason: 'not_complete', finished: true, missing_catchup: ['ecosine'], without_figure: 3 } })));
check('switched off: said', /switched off/.test(runNote({ run: { status: 'held', reason: 'switched_off', finished: true, missing_catchup: [] } })));
const empty = renderCashEmail({ day: '2026-09-27', run: null, drivers: [], total: 0, by_platform: [], unsplit: 0, not_texted: [] });
check('…and an empty day’s email says nobody was texted, with no table', empty.subject.endsWith('nobody texted')
  && empty.html.includes('Nobody was texted') && !empty.html.includes('To deposit AED'), empty.subject);
process.env.CASH_REPORT_RECIPIENTS = '';
const before = posts.length;
r = await cashEmailRun({ q, http, day: '2026-09-27', now: new Date('2026-09-28T06:00:00Z') });
check('no address set: nothing is sent, and the reason is returned', posts.length === before && /CASH_REPORT_RECIPIENTS is empty/.test(r.why || ''), j(r));

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
