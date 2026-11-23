/* The events layer's web tier, and the classifier's thinking switch (EVW).
   ─────────────────────────────────────────────────────────────────────────
   src/sources/events_web.js asks BytePlus ModelArk's Responses API, with its
   built-in web_search tool, for Dubai events in the next 21 days. MEASURED
   2026-11-16: that tool answers 403 AccessDenied ("you do not have access to
   the built in tool") until an account owner enables it in the BytePlus
   console, and /chat/completions does not offer it at all. So the tier has to
   do two jobs well: read a real answer into world_event rows without
   believing more of it than the search supports, and — when it cannot run —
   say the TRUE reason in /api/status and on #causes.

   A fake Responses server stands in for ModelArk. The collector is pointed at
   ModelArk's real Singapore host (so isModelArk and thinkingSwitch see the
   host they will see in production) and fetch is rewritten to the fake
   server underneath, so the request crosses a real socket.

     1. parseWebEvents: the model's array → rows; window, title, date, url
        (kept only when the search cited it), attendance, confidence, dupes;
     2. searchWeb against the fake server: the request (path, tool, thinking,
        key), a 200 with url_citation annotations, the 403 AccessDenied that
        names the tool, a 403 that does not, malformed text, a timeout, no
        key, a non-ModelArk endpoint;
     3. collectWeb on PGlite: written, idempotent on a rerun the next day,
        once a Dubai day, six hours after a failure, and the reason on
        /api/status and /api/events/web (the real handlers, mounted);
     4. classifyNews: {thinking: disabled} reaches ModelArk and MiniMax and no
        other host; a revised answer is read by its last array.

   REVERSIONS (each run against this file, each failing as named):
     · events_web.js parseWebEvents `url: hit ? hit.url : null` → `url: modelUrl`
       → §1 "an address the search did not cite is not kept as the url" fails
     · parseWebEvents's two window checks removed
       → §1 "before the window" and "after the window" fail
     · searchWeb toolRefused forced false
       → §2 "the console switch, in the operator's words" fails
     · webDue → `return true`
       → §3 "once a Dubai day" fails
     · code built with foundOn (`${slug}:${starts}:${foundOn}`)
       → §3 "idempotent on the next day's rerun" fails
     · collectWeb logRun `error: out.reason` → `error: null`
       → §3 "/api/status carries the reason" fails
     · events.js classifyBody's thinking spread removed
       → §4 "ModelArk is sent thinking disabled" and "MiniMax too" fail
     · classifyNews back to txt.match(/\[[\s\S]*\]/)
       → §4 "a revised answer is read by its last array" fails

   REVIEW REVERSIONS (2026-11-16, FIX-STATUS "EVW review"):
     · parseWebEvents without lastJsonArray's `accept`
       → §1 "trailing citation markers" and "markers alone" fail       (R1)
     · detectBreaks ORDER BY confidence alone
       → §3 both candidate checks fail; source/url dropped from its
         SELECT → the "says where it came from" check fails            (R2)
     · collectWeb without the first-stored-title reuse
       → §3 "re-found under another spelling" and two after it fail   (R3)
     · code back to `${slug(title) || 'event'}:${starts}`
       → §1 "two different non-Latin titles" fails                     (R4) */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';

let pass = 0; let fail = 0;
const check = (name, ok, info = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name} ${info}`); }
};

const ARK = 'https://ark.ap-southeast.bytepluses.com/api/v3';
for (const k of ['ANALYST_BASE_URL', 'ANALYST_MODEL', 'ANALYST_API_KEY', 'ARK_BASE_URL', 'ARK_MODEL', 'ARK_API_KEY']) delete process.env[k];
process.env.ANALYST_BASE_URL = ARK;
process.env.ANALYST_MODEL = 'seed-2-0-pro-260328';
process.env.ANALYST_API_KEY = 'test-key-not-real';

/* ── the fake Responses server ─────────────────────────────────────────── */
let MODE = 'ok';
let ANSWER = '';
const seen = [];
const CITED = 'https://www.example.com/events/dubai-run/';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ path: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
    const send = (status, obj, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    if (MODE === 'denied') {
      return send(403, { error: { code: 'AccessDenied', type: 'Forbidden',
        message: 'The request failed because you do not have access to the built in tool. Request id: 0217test' } });
    }
    if (MODE === 'denied-model') {
      return send(403, { error: { code: 'AccessDenied', type: 'Forbidden',
        message: 'The request failed because your account has not activated the model. Request id: 0217test' } });
    }
    if (MODE === 'slow') { setTimeout(() => send(200, {}), 1500); return; }
    if (MODE === 'chat') {
      return send(200, { choices: [{ message: { content: ANSWER } }] });
    }
    return send(200, {
      id: 'resp_test_1', object: 'response', status: 'completed',
      output: [
        { type: 'web_search_call', id: 'ws_1', status: 'completed' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: ANSWER,
          annotations: [
            { type: 'url_citation', url: CITED, title: 'Dubai Run 2026', start_index: 0, end_index: 10 },
            { type: 'url_citation', url: 'https://example.org/expo', title: 'Expo week', start_index: 11, end_index: 20 },
          ] }] },
      ],
      usage: { input_tokens: 1200, output_tokens: 400, total_tokens: 1600 },
    }, { 'x-rate-limit-remaining': '3999' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${server.address().port}`;
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(String(url).startsWith(ARK)
  ? FAKE + String(url).slice('https://ark.ap-southeast.bytepluses.com'.length) : url, opts);

const W = await import('../src/sources/events_web.js');
const { parseWebEvents, searchWeb, collectWeb, webDue, webWindow, REASON } = W;
const { dubaiIso } = await import('../src/util.js');

/* A fixed instant: 2026-11-16 10:00 in Dubai. The window is 16 Nov – 6 Dec. */
const NOW = new Date('2026-11-16T06:00:00Z');
const win = webWindow(NOW);
const arr = (xs) => JSON.stringify(xs);

console.log('\n1. parseWebEvents');
{
  check('the window is 21 Dubai days, today included', win.from === '2026-11-16' && win.to === '2026-12-06', JSON.stringify(win));
  const citations = [{ url: CITED, title: 'Dubai Run 2026' }];
  const text = 'Here is what I found.\n' + arr([
    { title: 'Dubai Run', starts_on: '2026-11-23', ends_on: '2026-11-23', venue: 'Sheikh Zayed Road', area: 'Downtown',
      category: 'closure', expected_attendance: 300000, expected_effect: 'demand_down', confidence: 0.7,
      url: 'https://example.com/events/dubai-run' },
    { title: 'Arena concert', starts_on: '2026-11-28', ends_on: null, venue: 'Coca-Cola Arena', area: null,
      category: 'Concert', expected_attendance: 0, expected_effect: 'demand_up', confidence: 85,
      url: 'https://made-up.example/concert' },
    { title: 'Festival already running', starts_on: '2026-11-10', ends_on: '2026-11-20', category: 'festival',
      expected_effect: 'surge', confidence: 0.4, url: null },
    { title: 'Last month’s show', starts_on: '2026-10-01', ends_on: '2026-10-02', category: 'exhibition' },
    { title: 'Far future', starts_on: '2027-01-15', ends_on: '2027-01-15', category: 'sports' },
    { title: '', starts_on: '2026-11-20' },
    { title: 'No date at all', starts_on: null },
    { title: 'Not a day', starts_on: '2026-02-30' },
    { title: 'Dubai Run', starts_on: '2026-11-23', ends_on: '2026-11-23', category: 'closure' },
    { title: 'Backwards end', starts_on: '2026-12-01', ends_on: '2026-11-25', category: 'mystery' },
  ]);
  const r = parseWebEvents(text, { ...win, citations, foundOn: win.from });
  const by = Object.fromEntries(r.rows.map((x) => [x.title, x]));
  check('valid leads are kept as source web, scope dubai', r.rows.length === 4 && r.rows.every((x) => x.source === 'web' && x.scope === 'dubai'),
    JSON.stringify(r.rows.map((x) => x.title)));
  check('a cited page is kept as the url, spelled as the search cited it (www. and a trailing slash do not hide it)', by['Dubai Run']?.url === CITED, by['Dubai Run']?.url);
  check('an address the search did not cite is not kept as the url', by['Arena concert']?.url === null
    && by['Arena concert']?.raw.model_url === 'https://made-up.example/concert' && by['Arena concert']?.raw.model_url_unverified === true,
    JSON.stringify(by['Arena concert']?.url));
  check('the stable code is the normalised title and the start', by['Dubai Run']?.code === 'dubai-run:2026-11-23', by['Dubai Run']?.code);
  check('attendance 0 is a placeholder, not an estimate', by['Arena concert']?.raw.expected_attendance === null);
  check('confidence outside 0..1 is dropped, not rescaled', by['Arena concert']?.confidence === null);
  check('a category is lower-cased, an unknown one is other', by['Arena concert']?.category === 'concert' && by['Backwards end']?.category === 'other');
  check('an unknown effect is unknown', by['Festival already running']?.expected_effect === 'unknown');
  check('an event already running into the window is kept', !!by['Festival already running']);
  check('a missing or backwards end is a one-day event', by['Arena concert']?.ends_on === '2026-11-28' && by['Backwards end']?.ends_on === '2026-12-01');
  const why = r.rejected.map((x) => x.reason).join(' | ');
  check('before the window: refused', /ended 2026-10-02, before the window/.test(why), why);
  check('after the window: refused', /starts 2027-01-15, after the window/.test(why), why);
  check('no title, no date, not a calendar day: refused', /no title/.test(why) && /no start date \(null\)/.test(why)
    && /no start date \("2026-02-30"\)/.test(why), why);
  check('a second entry for the same event: refused', /second entry/.test(why), why);
  check('raw keeps venue, area, found_on and the citations', by['Dubai Run']?.raw.venue === 'Sheikh Zayed Road'
    && by['Dubai Run']?.raw.found_on === '2026-11-16' && by['Dubai Run']?.raw.citations.length === 1
    && by['Dubai Run']?.raw.citation?.title === 'Dubai Run 2026');
  check('summary is composed from what was given, never invented', by['Dubai Run']?.summary === 'Sheikh Zayed Road, Downtown — about 300,000 expected'
    && by['Festival already running']?.summary === null, by['Dubai Run']?.summary);
  const revised = '<think>[{"title":"draft"}]</think> First: [{"title":"x","starts_on":"2026-11-20"}] — wait, corrected: '
    + arr([{ title: 'Corrected', starts_on: '2026-11-21', category: 'sports' }]);
  const rv = parseWebEvents(revised, win);
  check('a think block is ignored and a revised answer is read by its last array', rv.rows.length === 1 && rv.rows[0].title === 'Corrected',
    JSON.stringify(rv.rows.map((x) => x.title)));
  check('no array at all is an error, not an empty success', parseWebEvents('Sorry, nothing found.', win).error === 'no JSON array in the response');
  /* REVIEW 2026-11-16. A search-grounded answer that ends with its citation
     markers: the last array that parses is [2], and before the accept
     predicate every lead was refused as "not an object" — the run reported
     "all 1 events the model returned failed validation" for an answer whose
     one event was valid. */
  const marked = 'Here are the events:\n```json\n'
    + arr([{ title: 'Dubai Run', starts_on: '2026-11-23', category: 'closure' }])
    + '\n```\nSources: [1] dubairun.com [2] visitdubai.com';
  const mk = parseWebEvents(marked, win);
  check('trailing citation markers ([1] [2]) are not taken for the answer', mk.error === null && mk.rows.length === 1
    && mk.rows[0].title === 'Dubai Run', JSON.stringify({ e: mk.error, n: mk.rows.length, rej: mk.rejected }));
  check('…an honest [] followed by a marker is still "found nothing"', parseWebEvents('[] [1]', win).error === null
    && parseWebEvents('[] [1]', win).rows.length === 0);
  /* REVIEW 2026-11-16. Two Arabic-titled events on one day both slugged to
     nothing and shared the code 'event:<day>', so the second was refused as a
     duplicate of the first. */
  const ar = parseWebEvents(arr([
    { title: 'معرض دبي للكتاب', starts_on: '2026-11-25', category: 'exhibition' },
    { title: 'مهرجان الأضواء', starts_on: '2026-11-25', category: 'festival' },
  ]), win);
  check('two different non-Latin titles on one day are two events, with distinct stable codes', ar.rows.length === 2
    && ar.rows[0].code !== ar.rows[1].code && ar.rows.every((x) => /^t-[0-9a-f]{8}:2026-11-25$/.test(x.code))
    && parseWebEvents(arr([{ title: 'معرض دبي للكتاب', starts_on: '2026-11-25' }]), win).rows[0].code === ar.rows[0].code,
    JSON.stringify({ codes: ar.rows.map((x) => x.code), rej: ar.rejected.map((x) => x.reason) }));
  check('…and markers alone are an error that says so, not an empty success',
    parseWebEvents('No events found [1][2]', win).error === 'no JSON array of the expected shape in the response',
    parseWebEvents('No events found [1][2]', win).error);
}

console.log('\n2. searchWeb against the fake Responses server');
{
  ANSWER = 'Results:\n' + arr([
    { title: 'Dubai Run', starts_on: '2026-11-23', ends_on: '2026-11-23', venue: 'Sheikh Zayed Road', area: 'Downtown',
      category: 'closure', expected_attendance: 300000, expected_effect: 'demand_down', confidence: 0.7, url: CITED },
    { title: 'Expo week', starts_on: '2026-12-01', ends_on: '2026-12-04', venue: 'Dubai World Trade Centre', area: null,
      category: 'exhibition', expected_attendance: null, expected_effect: 'demand_up', confidence: 0.55, url: 'https://example.org/expo' },
  ]);
  MODE = 'ok'; seen.length = 0;
  const ok = await searchWeb({ now: NOW });
  const req = seen[0];
  check('one call, to /api/v3/responses, with the key as a bearer token', seen.length === 1 && req?.path === '/api/v3/responses'
    && req?.auth === 'Bearer test-key-not-real', JSON.stringify({ n: seen.length, path: req?.path }));
  check('the measured shape: model, input, tools [{type: web_search}], thinking disabled — nothing else',
    req?.body?.model === 'seed-2-0-pro-260328' && JSON.stringify(req?.body?.tools) === '[{"type":"web_search"}]'
    && req?.body?.thinking?.type === 'disabled' && Object.keys(req?.body || {}).sort().join(',') === 'input,model,thinking,tools',
    JSON.stringify(Object.keys(req?.body || {})));
  check('the prompt names the window and asks for strict JSON', /2026-11-16 and 2026-12-06/.test(req?.body?.input || '')
    && /ONLY a JSON array/.test(req?.body?.input || ''));
  check('200: status ok, both leads, each with a cited url', ok.status === 'ok' && ok.reason === null && ok.rows.length === 2
    && ok.rows.every((x) => x.url), JSON.stringify({ s: ok.status, r: ok.reason, n: ok.rows.length }));
  check('the citations and the call are kept in raw (usage, response id, searches, rate-limit header)',
    ok.rows[0].raw.citations.length === 2 && ok.rows[0].raw.call?.response_id === 'resp_test_1'
    && ok.rows[0].raw.call?.usage?.total_tokens === 1600 && ok.rows[0].raw.call?.searches === 1
    && ok.rows[0].raw.call?.rate_limit_remaining === '3999', JSON.stringify(ok.rows[0].raw.call));

  MODE = 'denied';
  const d = await searchWeb({ now: NOW });
  check('403 AccessDenied naming the built-in tool: the console switch, in the operator’s words',
    d.status === 'error' && d.reason === REASON.accessDenied && d.rows.length === 0, d.reason);
  check('…which says who switches it on and where', /not enabled for this account/.test(REASON.accessDenied)
    && /BytePlus console/.test(REASON.accessDenied));

  MODE = 'denied-model';
  const dm = await searchWeb({ now: NOW });
  check('a 403 AccessDenied that does not name the tool is quoted verbatim, not blamed on the switch',
    dm.reason !== REASON.accessDenied && /HTTP 403 AccessDenied: The request failed because your account has not activated the model/.test(dm.reason || ''),
    dm.reason);

  MODE = 'ok'; ANSWER = 'I found several events but here they are: [{"title": "Broken", "starts_on": ';
  const mal = await searchWeb({ now: NOW });
  check('malformed text: an error that quotes what came back', mal.status === 'error'
    && /could not be read \(no JSON array in the response\)/.test(mal.reason || '') && /I found several events/.test(mal.reason || ''), mal.reason);

  ANSWER = arr([{ title: 'Old', starts_on: '2025-01-01' }, { title: '', starts_on: '2026-11-20' }]);
  const allBad = await searchWeb({ now: NOW });
  check('every lead refused: an error naming the first reason, not an empty success', allBad.status === 'error'
    && /all 2 events the model returned failed validation \(first: ended 2025-01-01/.test(allBad.reason || ''), allBad.reason);

  ANSWER = '[]';
  const none = await searchWeb({ now: NOW });
  check('an honest [] is a search that found nothing: ok, no rows', none.status === 'ok' && none.rows.length === 0, none.reason);

  MODE = 'slow';
  const slow = await searchWeb({ now: NOW, timeoutMs: 200 });
  check('a timeout is said as one, with the runtime’s own words', slow.status === 'error'
    && /^the web search call timed out after 0\.2 s \(.+\)$/.test(slow.reason || ''), slow.reason);

  seen.length = 0;
  const nokey = await searchWeb({ now: NOW, m: { baseUrl: ARK, model: 'm', apiKey: '' } });
  check('no key: "no model configured", and nothing is asked', nokey.reason === REASON.noModel && /^no model configured/.test(nokey.reason)
    && seen.length === 0, nokey.reason);
  const other = await searchWeb({ now: NOW, m: { baseUrl: 'https://api.minimax.io/v1', model: 'm', apiKey: 'k' } });
  check('an endpoint that is not ModelArk is named, and nothing is asked', other.reason === REASON.notArk('api.minimax.io')
    && seen.length === 0, other.reason);
}

console.log('\n3. collectWeb on PGlite: written, idempotent, once a day, the reason on /api/status');
{
  const db = new PGlite();
  await applySchema(db);
  const { pool } = await import('../src/db.js');
  pool.query = async (t, p) => {
    const r = await db.query(t, p);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  /* upsertMany writes inside BEGIN/COMMIT on a checked-out client; one PGlite
     connection serves as that client. */
  pool.connect = async () => ({ query: pool.query, release() {} });
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  ANSWER = arr([
    { title: 'Dubai Run', starts_on: '2026-11-23', ends_on: '2026-11-23', category: 'closure', confidence: 0.7, url: CITED },
    { title: 'Expo week', starts_on: '2026-12-01', ends_on: '2026-12-04', category: 'exhibition', confidence: 0.55 },
  ]);
  MODE = 'ok'; seen.length = 0;
  const first = await collectWeb({ now: NOW });
  const ev1 = await q(`SELECT code, url, raw FROM world_event WHERE source = 'web' ORDER BY code`);
  check('the first run writes both leads', first.ran && first.written === 2 && ev1.length === 2, JSON.stringify(first.written));
  const run1 = await q(`SELECT status, error, rows_written, window_start::text AS ws, window_end::text AS we
                          FROM collection_run WHERE source = 'events' AND mode = 'web'`);
  check('…and records its own run: events / web, ok, the window searched', run1.length === 1 && run1[0].status === 'ok'
    && run1[0].rows_written === 2 && run1[0].ws === '2026-11-16' && run1[0].we === '2026-12-06', JSON.stringify(run1));

  /* The run is logged with the DATABASE's clock (src/db.js logRun:
     finished_at = now()), and this file's clock is fixed at NOW. While the two
     fell on the same Dubai day (16 Nov 2026, when this was written) the check
     below held by coincidence; from 17 Nov it failed on every branch, CI on
     PR #46 included — the run read as yesterday's and was due again. Pinned
     to the file's own clock, so "an hour later" is an hour after the run. */
  await q(`UPDATE collection_run SET finished_at = $1 WHERE source = 'events' AND mode = 'web'`, [NOW.toISOString()]);
  seen.length = 0;
  const again = await collectWeb({ now: new Date(NOW.getTime() + 3600e3) });
  check('once a Dubai day: an hour later nothing is asked', again.ran === false && seen.length === 0, JSON.stringify({ ran: again.ran, n: seen.length }));

  const NEXT = new Date(NOW.getTime() + 864e5);
  const second = await collectWeb({ now: NEXT });
  const ev2 = await q(`SELECT code, raw->>'found_on' AS found_on FROM world_event WHERE source = 'web' ORDER BY code`);
  check('idempotent on the next day’s rerun: the same two rows, found_on moved on', second.ran && ev2.length === 2
    && ev2.every((x) => x.found_on === dubaiIso(NEXT)), JSON.stringify(ev2));

  /* REVIEW 2026-11-16. The same lead re-found with another spelling of the
     same title — same slug, same start, so the same code — must land on the
     row already there, not beside it: the table's key carries the title. */
  ANSWER = arr([
    { title: 'DUBAI RUN.', starts_on: '2026-11-23', ends_on: '2026-11-23', category: 'closure', confidence: 0.8, url: CITED },
    { title: 'Expo week', starts_on: '2026-12-01', ends_on: '2026-12-04', category: 'exhibition', confidence: 0.55 },
  ]);
  const THIRD = new Date(NEXT.getTime() + 864e5);
  const respelled = await collectWeb({ now: THIRD });
  const ev3 = await q(`SELECT code, title, confidence FROM world_event WHERE source = 'web' ORDER BY code`);
  check('a lead re-found under another spelling of its title updates its row instead of adding one', respelled.ran
    && ev3.length === 2 && ev3.find((x) => x.code === 'dubai-run:2026-11-23')?.title === 'Dubai Run'
    && ev3.find((x) => x.code === 'dubai-run:2026-11-23')?.confidence === 0.8, JSON.stringify(ev3));

  MODE = 'denied';
  const LATER = new Date(THIRD.getTime() + 864e5);
  const refused = await collectWeb({ now: LATER });
  check('a refused search writes nothing and keeps what was found', refused.ran && refused.written === 0
    && (await q(`SELECT count(*)::int AS n FROM world_event WHERE source = 'web'`))[0].n === 2);
  const last = (await q(`SELECT status, error, finished_at FROM collection_run WHERE source = 'events' AND mode = 'web'
                          ORDER BY finished_at DESC LIMIT 1`))[0];
  check('…and its run row is error, with the console switch as the reason', last.status === 'error' && last.error === REASON.accessDenied, JSON.stringify(last));
  check('a failure is tried again after six hours, not every thirty minutes',
    webDue(last, new Date(new Date(last.finished_at).getTime() + 5 * 3600e3)) === false
    && webDue(last, new Date(new Date(last.finished_at).getTime() + 6 * 3600e3)) === true);
  check('a success is not repeated the same Dubai day, and is the next', webDue({ status: 'ok', finished_at: '2026-11-16T19:59:00Z' },
    new Date('2026-11-16T19:59:30Z')) === false
    && webDue({ status: 'ok', finished_at: '2026-11-16T19:59:00Z' }, new Date('2026-11-16T20:00:30Z')) === true
    && webDue(null, NOW) === true);

  /* The real handlers, mounted on the same database. */
  const { mountAll } = await import('./mount.mjs');
  const { get, server: api } = await mountAll(db);
  const status = await get('/api/status');
  const row = (status.body || []).find((r) => r.source === 'events' && r.mode === 'web');
  check('/api/status carries the reason under the events source', row?.status === 'error' && row?.error === REASON.accessDenied,
    JSON.stringify(row || status.status));
  const fwd = await get('/api/events/web');
  const b = fwd.body || {};
  check('/api/events/web: the tier’s run and its true reason', b.tier?.status === 'error' && b.tier?.error === REASON.accessDenied
    && typeof b.today === 'string' && Array.isArray(b.events), JSON.stringify(b).slice(0, 300));
  /* The fixed instant is in the past by the time anyone reads this, so the
     forward view is asked against rows moved to start tomorrow. */
  await db.query(`UPDATE world_event SET starts_on = (now() AT TIME ZONE 'Asia/Dubai')::date + 1,
                    ends_on = (now() AT TIME ZONE 'Asia/Dubai')::date + 1 WHERE source = 'web'`);
  const fwd2 = (await get('/api/events/web')).body || {};
  const run = (fwd2.events || []).find((e) => e.title === 'Dubai Run');
  check('…and the leads, flattened: url only where cited, the citation count, found_on',
    fwd2.events?.length === 2 && run?.url === 'https://www.example.com/events/dubai-run/' && run?.citations_n === 2
    && run?.found_on === dubaiIso(THIRD) && (fwd2.events || []).find((e) => e.title === 'Expo week')?.url === null,
    JSON.stringify(fwd2.events).slice(0, 400));
  api.close();

  /* REVIEW 2026-11-16: a web lead inside a finished month is a break
     candidate. detectBreaks ranked candidates on confidence alone and copied
     no source, so a month of 0.95 leads pushed a derived 0.6 row out of the
     eight slots and the card could not say which rows were leads. Months are
     relative to the current Dubai month, as in break_month_grain. */
  const nowD = new Date(Date.now() + 4 * 3600e3);
  const MB = (back) => new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - back, 1)).toISOString().slice(0, 7);
  const [B1, B2] = [MB(1), MB(2)];
  const seedTrips = async (month, count, tag) => {
    const vals = [], ps = [];
    for (let i = 0; i < count; i++) {
      ps.push('webbrk', `${tag}${i}`, 'd1', `${month}-10T12:00:00+04:00`);
      vals.push(`($${ps.length - 3},$${ps.length - 2},$${ps.length - 1},$${ps.length},'completed')`);
    }
    await db.query(`INSERT INTO trip (platform, external_id, driver_ext_id, requested_at, status) VALUES ${vals.join(',')}`, ps);
  };
  await seedTrips(B2, 200, 'a'); await seedTrips(B1, 40, 'b');
  await db.query(`INSERT INTO world_event (source, code, title, category, scope, starts_on, ends_on, expected_effect, confidence)
                  VALUES ('seasonal', 'reviewseason', 'A derived season', 'seasonal', 'dubai', $1, $2, 'demand_down', 0.6)`,
  [`${B1}-01`, `${B1}-28`]);
  for (let i = 0; i < 9; i++) {
    await db.query(`INSERT INTO world_event (source, code, title, category, scope, starts_on, ends_on, expected_effect, confidence, url)
                    VALUES ('web', $1, $2, 'concert', 'dubai', $3, $3, 'demand_up', $5, $4)`,
    [`lead-${i}:${B1}-1${i}`, `Lead ${i}`, `${B1}-1${i}`, i === 0 ? 'https://example.com/lead-0' : null, i === 0 ? 0.96 : 0.95]);
  }
  const { detectBreaks } = await import('../src/sources/events.js');
  await detectBreaks();
  const [brk] = await q(`SELECT candidate_events FROM metric_break WHERE platform = 'webbrk'`);
  const cands = brk ? (typeof brk.candidate_events === 'string' ? JSON.parse(brk.candidate_events) : brk.candidate_events) : [];
  check('a month of web leads does not push a derived event out of a break’s candidates', cands.length === 8
    && cands[0]?.title === 'A derived season', JSON.stringify(cands.map((c) => c.title)));
  check('…and each candidate says where it came from, a lead with its cited url', cands.filter((c) => c.source === 'web').length === 7
    && cands.find((c) => c.title === 'Lead 0')?.url === 'https://example.com/lead-0', JSON.stringify(cands.map((c) => c.source)));
}

console.log('\n4. classifyNews: the thinking switch, and a revised answer');
{
  const { classifyBody, classifyNews, classifyPrompt } = await import('../src/sources/events.js');
  const prompt = classifyPrompt([{ title: 'Dubai airport traffic record' }]);
  const ark = classifyBody(prompt, { baseUrl: ARK, model: 'seed-2-0-pro-260328' });
  check('ModelArk is sent thinking disabled', ark.thinking?.type === 'disabled' && ark.model === 'seed-2-0-pro-260328'
    && ark.messages[0].content === prompt && ark.max_tokens === 1600, JSON.stringify(ark).slice(0, 160));
  check('MiniMax too', classifyBody(prompt, { baseUrl: 'https://api.minimax.io/v1', model: 'MiniMax-M3' }).thinking?.type === 'disabled');
  check('another host is not', !('thinking' in classifyBody(prompt, { baseUrl: 'https://api.example.com/v1', model: 'm' })));

  /* And the request classifyNews actually sends, over the socket. */
  MODE = 'chat'; seen.length = 0;
  ANSWER = '[{"i":0,"effect":"none","confidence":0.1,"reason":"draft"}] On reflection, the first is material: '
    + '[{"i":0,"effect":"demand_up","confidence":0.6,"reason":"airport demand"}]';
  const failed = [];
  const v = await classifyNews([{ title: 'Dubai airport traffic record' }], failed);
  check('classifyNews sends the switch to ModelArk', seen[0]?.path === '/api/v3/chat/completions'
    && seen[0]?.body?.thinking?.type === 'disabled', JSON.stringify(seen[0]?.body || {}).slice(0, 160));
  check('a revised answer is read by its last array', v.length === 1 && v[0].effect === 'demand_up' && failed.length === 0,
    JSON.stringify({ v, failed }));
  ANSWER = 'No JSON here.';
  const failed2 = [];
  await classifyNews([{ title: 'x' }], failed2);
  check('an answer with no array is reported, not taken for a quiet week', failed2.join() === 'classifier: no JSON array in the response',
    JSON.stringify(failed2));
}

console.log('\n5. wiring');
{
  const src = readFileSync(new URL('../src/sources/events.js', import.meta.url), 'utf8');
  const collect = src.slice(src.indexOf('export async function collect('));
  check('events.collect runs the web tier, inside its own try', /try \{\s*web = await collectWeb\(\);\s*\} catch/.test(collect));
  check('classifyNews posts classifyBody', /body: JSON\.stringify\(classifyBody\(prompt\)\)/.test(src));
}

server.close();
globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
