/* YANGO'S CONSOLE: ASKED ONCE A DAY, READ FOR WHAT IT SAYS, AND NOT ALLOWED
   TO TURN A WORKING RUN RED.
   ═══════════════════════════════════════════════════════════════════════════
   Measured on production 2026-09-29, before this change:

     • fleet.yango.com was asked about a thousand times a week — every closed
       week in the window on every run (half-hourly, the daily 30-day
       catch-up, and 105 weeks every Sunday), each refusal doubled by a
       cookie-free copy — and every one was refused by Yandex's edge.
     • YANGO_COOKIE read 'ok' on the panel, written from "403 with the cookie,
       401 without". The 403 is the edge's HTML page and the 401 is Yango's
       API: two different machines. A cookie pasted at 09:19:39Z was green
       forty minutes later without anything having read it.
     • Every Yango run was 'error' — the Sunday backfill wrote 15,112 rows and
       was still 'error' — because the console weeks were the run's only
       windows and logRun read "all windows failed" as "the run failed".

   Each group below says what reverting its fix does; the reversions were run
   on 2026-09-29 and their results are written beside them.

   No credential is used. Every request is made against a stub. */
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;

process.env.YANGO_PARK_ID = 'park-under-test';
process.env.YANGO_API_KEY = 'api-key-under-test';
process.env.YANGO_COOKIE = 'Session_id=stub-session; yandex_login=stub-account';

const { pool, logRun } = await import('../src/db.js');

/* ── the database, as the collector sees it ──────────────────────────────── */
let consoleRow = null;             // what consoleGate reads
let haveWeeks = [];                // period_start of weeks already held
const runs = [];                   // collection_run inserts
const creds = [];                  // credential_state inserts
pool.query = async (text, params = []) => {
  const t = String(text);
  if (/FROM credential_state c\s+WHERE c\.provider = \$1 AND c\.credential = 'YANGO_CONSOLE'/.test(t)) {
    return { rows: consoleRow ? [consoleRow] : [] };
  }
  if (/SELECT DISTINCT period_start::text AS s FROM driver_performance/.test(t)) {
    return { rows: haveWeeks.map((s) => ({ s })) };
  }
  if (/INSERT INTO collection_run/.test(t)) {
    runs.push({ status: params[5], rows: params[6], error: params[7], detail: params[10] });
    return { rows: [{ id: runs.length }] };
  }
  if (/INSERT INTO credential_state/.test(t)) {
    creds.push({ credential: params[2], state: params[3], detail: params[4] });
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => ({ query: async () => ({ rows: [], rowCount: 1 }), release() {} });

/* ── the network ─────────────────────────────────────────────────────────── */
let consoleAnswer = () => new Response('<!DOCTYPE html><html><head><title>403</title></head><body><pre></pre>'
  + '<p>Request id 7f3a-synthetic</p></body></html>', { status: 403, headers: { 'content-type': 'text/html' } });
let tripsFail = false;
const seen = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('ipify.org')) return new Response('{"ip":"203.0.113.9"}', { status: 200 });
  seen.push(u);
  if (u.includes('fleet.yango.com')) return consoleAnswer();
  if (tripsFail && u.includes('/orders/list')) {
    return new Response(JSON.stringify({ code: '403', message: 'invalid client id or api key' }), { status: 403 });
  }
  /* The key host answers, with one car, so a run has rows to its name. */
  return new Response(JSON.stringify({ driver_profiles: [], orders: [], transactions: [],
    cars: u.includes('/cars/list') ? [{ id: 'car-1', number: 'T 1' }] : [], total: 1 }),
  { status: 200, headers: { 'content-type': 'application/json' } });
};

const Y = await import('../src/sources/yango.js');
const { readConsoleAnswer, consoleGate, collect, pageText, CONSOLE_WEEKS_PER_DAY } = Y;
const consoleCalls = () => seen.filter((u) => u.includes('fleet.yango.com')).length;
const reset = () => { seen.length = 0; runs.length = 0; creds.length = 0; };
const WINDOW = { from: new Date('2026-08-03T00:00:00Z'), to: new Date('2026-09-27T00:00:00Z') };

/* ══ 1. what an answer proves ══════════════════════════════════════════════
   REVERSION: the edge branch writes cookie 'ok' (the old asymmetry reading)
   -> 28 passed, 1 FAILED: "an HTML page from the edge proves nothing about
      the session".
   REVERSION: the 2xx-page branch removed, so a sign-in page served with 200
   falls to 'blocked' -> 28 passed, 1 FAILED: "a sign-in page served with
   200 is not called the edge's refusal". */
console.log('\n1. each answer is read for what it is');
const edge = readConsoleAnswer({ status: 403, data: '<!DOCTYPE html><html>edge</html>' });
check('an HTML page from the edge proves nothing about the session',
  edge.kind === 'edge' && edge.console === 'blocked' && edge.cookie === 'unknown', j(edge));
const api401 = readConsoleAnswer({ status: 401, data: { code: 'unauthorized' } });
check('a JSON 401 from Yango’s API is a signed-out session',
  api401.console === 'expired' && api401.cookie === 'expired', j(api401));
const api403 = readConsoleAnswer({ status: 403, data: { code: 'forbidden', message: 'park' } });
check('a JSON 403 is the park refused, and says nothing about the session',
  api403.console === 'unentitled' && api403.cookie === 'unknown' && /forbidden: park/.test(api403.why), j(api403));
const ok = readConsoleAnswer({ status: 200, data: { items: [] } });
check('an answer with a driver list — even an empty one — proves both', ok.ok && ok.console === 'ok' && ok.cookie === 'ok');
const passport = readConsoleAnswer({ status: 200, data: '<html>sign in</html>', redirected: true,
  finalUrl: 'https://passport.yango.com/auth?retpath=x' }, 'https://fleet.yango.com');
check('a redirect to the sign-in host is a signed-out session, not an answer',
  !passport.ok && passport.cookie === 'expired' && /passport\.yango\.com/.test(passport.why), j(passport));
const page200 = readConsoleAnswer({ status: 200, data: '<!doctype html><html>log in</html>' });
check('a sign-in page served with 200 is not called the edge’s refusal',
  page200.kind === 'failed' && page200.console === 'unknown', j(page200));
check('a server error is unknown, not a verdict on anything',
  readConsoleAnswer({ status: 502, data: { message: 'bad gateway' } }).console === 'unknown');
check('the edge page is logged as its text, past the empty <pre> the old 600-character cut ended in',
  pageText('<html><style>p{}</style><pre></pre><p>Request id 7f3a &amp; more</p></html>') === 'Request id 7f3a & more');

/* ══ 2. once a Dubai day ═══════════════════════════════════════════════════
   REVERSION: consoleGate returns { open: true } unconditionally
   -> 24 passed, 5 FAILED: "asked at 10:00 Dubai today: closed", "a session
      saved after today's refusal gets its own try" (it answers 'reverted'),
      "asked earlier today and refused: not asked again" (1 call), "…and the
      run says so", and "answered today: not asked again either". */
console.log('\n2. once a Dubai day, or once more after a new paste');
const now = new Date('2026-09-29T10:00:00Z');                     // 14:00 Dubai
consoleRow = null;
check('never asked: open', (await consoleGate(pool, now)).open);
consoleRow = { checked_at: '2026-09-29T06:00:00Z', state: 'blocked', saved_at: null };  // 10:00 Dubai
check('asked at 10:00 Dubai today: closed', !(await consoleGate(pool, now)).open);
consoleRow = { checked_at: '2026-09-28T19:59:00Z', state: 'blocked', saved_at: null };  // 23:59 Dubai yesterday
check('asked at 23:59 Dubai yesterday: open — the day is Dubai’s, not UTC’s',
  (await consoleGate(pool, now)).open);
consoleRow = { checked_at: '2026-09-29T06:00:00Z', state: 'blocked', saved_at: '2026-09-29T07:00:00Z' };
const afterPaste = await consoleGate(pool, now);
check('a session saved after today’s refusal gets its own try', afterPaste.open && /saved/.test(afterPaste.why), j(afterPaste));

console.log('\n   …through collect()');
reset();
consoleRow = { checked_at: new Date(Date.now() - 3600e3).toISOString(), state: 'blocked', saved_at: null };
haveWeeks = [];
await collect({ ...WINDOW, mode: 'catchup' });
check('asked earlier today and refused: not asked again', consoleCalls() === 0, `${consoleCalls()} calls`);
check('…and the run says so, as partial, in a sentence',
  runs[0]?.status === 'partial' && /not asked — \d+ closed weeks? missing/.test(runs[0]?.error || ''), j(runs[0]));
reset();
consoleRow = { checked_at: new Date(Date.now() - 3600e3).toISOString(), state: 'ok', saved_at: null };
await collect({ ...WINDOW, mode: 'catchup' });
check('answered today: not asked again either, and nothing is failing',
  consoleCalls() === 0 && runs[0]?.status === 'ok', j(runs[0]));

/* ══ 3. only the weeks we do not have, newest first, stopping at a refusal ═
   REVERSION: `break` back to `continue`
   -> 27 passed, 2 FAILED: "a refusal stops the walk" (8 calls) and "…it was
      the NEWEST closed week" (eight refused windows).
   REVERSION: weeksWanted ignores the stored weeks
   -> 27 passed, 2 FAILED: "a week already held is not asked for" and "up to
      8 weeks are fetched" (the two held weeks were asked first). */
console.log('\n3. only the weeks that are missing, newest first');
reset();
consoleRow = null;
await collect({ ...WINDOW, mode: 'backfill' });
check('a refusal stops the walk: one request, not one per week', consoleCalls() === 1, `${consoleCalls()} calls`);
const asked = JSON.parse(runs[0]?.detail || '[]');
check('…and it was the NEWEST closed week, the one a reader is waiting for',
  asked.length === 1 && asked[0].from === '2026-09-21', j(asked));
reset();
consoleAnswer = () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
haveWeeks = ['2026-09-21', '2026-09-14'];
await collect({ ...WINDOW, mode: 'backfill' });
const walked = JSON.parse(runs[0]?.detail || '[]').map((c) => c.from);
check('a week already held is not asked for', !walked.includes('2026-09-21') && !walked.includes('2026-09-14'), j(walked));
check(`a day the console answers, up to ${CONSOLE_WEEKS_PER_DAY} weeks are fetched, newest first`,
  walked.length === Math.min(CONSOLE_WEEKS_PER_DAY, 6) && walked[0] === '2026-09-07'
  && walked.every((w, i) => i === 0 || w < walked[i - 1]), j(walked));
check('…and the answer turns both rows green, the cookie by evidence',
  creds.some((c) => c.credential === 'YANGO_COOKIE' && c.state === 'ok')
  && creds.some((c) => c.credential === 'YANGO_CONSOLE' && c.state === 'ok'), j(creds.slice(-2)));

/* ══ 4. a working run is not an error ══════════════════════════════════════
   REVERSION: `chunks_cover: 'surface'` dropped from collect()'s logRun call
   -> 28 passed, 1 FAILED: "every console week refused, key-host rows
      written: partial, not error" — status "error", exactly production's.
   REVERSION: the trips clause dropped from collect()'s status
   -> 28 passed, 1 FAILED: "…but a run whose TRIPS failed is an error". */
console.log('\n4. the run’s status');
reset();
consoleAnswer = () => new Response('<!DOCTYPE html><html>edge</html>', { status: 403 });
consoleRow = null; haveWeeks = [];
await collect({ ...WINDOW, mode: 'incremental' });
check('every console week refused, key-host rows written: partial, not error',
  runs[0]?.status === 'partial' && runs[0]?.rows > 0, j(runs[0]));
reset();
tripsFail = true; consoleRow = null;
await collect({ ...WINDOW, mode: 'incremental' });
tripsFail = false;
check('…but a run whose TRIPS failed is an error, whatever else it wrote — the SMS run reads '
  + 'a partial Yango run as "collected"', runs[0]?.status === 'error', j(runs[0]));

/* And logRun itself, both ways. */
const cap = [];
const fakeDb = { query: async (_t, p) => { cap.push(p[5]); return { rows: [{ id: 1 }] }; } };
const refusedWeeks = [{ from: '2026-09-21', to: '2026-09-27', rows: 0, error: 'refused' }];
await logRun({ source: 's', fleet_id: 'f', mode: 'm', status: 'partial', rows_written: 9, chunks: refusedWeeks,
  chunks_cover: 'surface', error: 'console refused' }, fakeDb);
await logRun({ source: 's', fleet_id: 'f', mode: 'm', status: 'partial', rows_written: 9, chunks: refusedWeeks }, fakeDb);
check('logRun: windows that are ONE surface do not decide the run', cap[0] === 'partial', cap[0]);
check('…windows that ARE the run still do: all failed is an error', cap[1] === 'error', cap[1]);

/* ══ 5. the paste box asks once, and claims nothing it did not see ═════════
   REVERSION: src/credcheck.js as committed before this change (the
   cookie-free second request and its asymmetry reading)
   -> 26 passed, 3 FAILED: "one request" (2 sent), "an edge refusal is 'not
      checked'…" and "a signed-out session is refused, naming whose it is" —
      the stub answers the same whatever the cookie, so the old check read
      both as "the portal refuses this park with or without a session". */
console.log('\n5. the paste check');
const { checkStored } = await import('../src/credcheck.js');
const { stateOf } = await import('../api/save_check.js');
reset();
consoleAnswer = () => new Response('<!DOCTYPE html><html>edge</html>', { status: 403 });
const v = await checkStored('YANGO_COOKIE', { value: 'Session_id=pasted; yandex_login=stub-account' });
check('one request, no cookie-free copy', consoleCalls() === 1, `${consoleCalls()} sent`);
check('an edge refusal is "not checked", stored, and not recorded as working',
  v.verdict === 'unknown' && !v.authenticates && stateOf(v) === 'saved' && /not checked/.test(v.detail), j(v));
check('…and it no longer says the session authenticates', !/authenticates/.test(v.detail || ''), v.detail);
reset();
consoleAnswer = () => new Response(JSON.stringify({ code: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json' } });
const v401 = await checkStored('YANGO_COOKIE', { value: 'Session_id=old; yandex_login=stub-account' });
check('a signed-out session is refused, naming whose it is', v401.verdict === 'fail' && /stub-account/.test(v401.detail), j(v401));
reset();
consoleAnswer = () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const v200 = await checkStored('YANGO_COOKIE', { value: 'Session_id=good' });
check('an answer passes', v200.verdict === 'pass', j(v200));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
