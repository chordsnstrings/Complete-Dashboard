/* FLIGHTS FROM OPENSKY — src/sources/flights.js (FIX-STATUS FLT, 2026-11-16).
   ═════════════════════════════════════════════════════════════════════════
   The operator: "add flight details and flights actually landing, and how
   that impacts the airport trips". The source has three halves and each is
   proved here against REAL OpenSky answers saved on 2026-11-16
   (test/fixtures/opensky/: the arrivals at OMDB and OMDW for 2026-11-15 and
   one live state snapshot over Dubai — public flight data, no credentials)
   and a fake OpenSky on a local port. No network, no secret.

     1. THE FINAL-APPROACH RULE on the real snapshot: UAE375 and FDB1134 are on
        short final to DXB's runway 30 and count; ABY739 (Air Arabia, based at
        Sharjah) is on final to OMSJ's runway 30 and must NOT count as DXB's;
        nothing else in the box is landing. A made-up OMSJ approach from the
        north-west stays Sharjah's even with the distance limit removed, and
        a departure, a level overflight and a far one are refused.
     2. THE CLIENT against a fake server: the client-credentials grant as a
        form, the token cached until it expires, a 401 answered by one fresh
        sign-in, a second 401 an error naming the client, a 429 carrying its
        retry-after, a 404 an answer (not a throw), and no secret in any
        error message.
     3. THE COLLECTOR on PGlite: a day stored once is the same rows stored
        twice (idempotent); a collected day is never asked again; yesterday's
        404 is "not published yet" and an older day's is "none returned";
        a 500 is "failed" with its reason; the credit floor stops a run;
        no client → the run says "no OpenSky client configured" and writes
        no landing and no coverage; the confirmed list supersedes the live
        estimate for its aircraft; the live poll stores each approach once
        across two polls, counts its polls by hour, and backs off after 429.

   REVERSIONS (each made on 2026-11-16, each failed the checks named):
     · approachOf without the cross-track test (`cross > rule.maxCrossNm`
       dropped) → "nothing else … is landing" (A6RRR, 12 nm out and level-
       ish, is then a landing) and "the Sharjah one is named and not stored".
     · APPROACH_AIRPORTS without the OMSJ decoy → five checks, among them
       "ABY739 … is Sharjah's" and "a Sharjah approach from the north-west
       is Sharjah's".
     · getJson without the 401 retry → "a 401 is answered by one fresh
       sign-in".
     · storeLandings' ON CONFLICT … DO UPDATE removed (a plain INSERT) →
       "storing the same day twice changes nothing" (duplicate key).
     · planDays without the `collected` skip → "the plan skips a collected
       day…" and "a collected day is not asked again" (the fake server
       counts every ask).
     · collectArrivals treating every 404 as not_published → "an older
       day's 404 is none returned".
     · the arrivals cron written as the stepped range '41 1-22/3 * * *' →
       "arrivals run at 01:41 … 22:41" (node-cron fires it at 3, 6 … 21). */
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { applySchema } from './schema.mjs';
import { approachOf, APPROACH_AIRPORTS, APPROACH_RULE, makeClient, forgetToken, OpenSkyError, planDays,
  storeLandings, collectArrivals, pollLive, resetLive, NO_CLIENT, LIVE_BOX } from '../src/sources/flights.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const FIX = new URL('./fixtures/opensky/', import.meta.url);
const gz = (f) => JSON.parse(gunzipSync(readFileSync(new URL(f, FIX))).toString('utf8'));
const OMDB = gz('arrivals_OMDB_2026-11-15.json.gz');
const OMDW = gz('arrivals_OMDW_2026-11-15.json.gz');
const STATES = JSON.parse(readFileSync(new URL('states_dubai_box.json', FIX), 'utf8'));

console.log('\n1 · the final-approach rule, on the real snapshot of 2026-11-16');
{
  const hits = STATES.states.map((sv) => ({ cs: String(sv[1]).trim(), d: approachOf(sv) })).filter((x) => x.d);
  const counted = hits.filter((x) => x.d.counted).map((x) => `${x.cs}@${x.d.airport}/${x.d.runway}`).sort();
  check('exactly UAE375 and FDB1134 are landing at DXB (runway 30)', counted.join() === 'FDB1134@OMDB/30,UAE375@OMDB/30', counted.join());
  const aby = hits.find((x) => x.cs === 'ABY739');
  check('ABY739, on final 3.2 nm from Sharjah, is Sharjah’s and is not counted', aby?.d.airport === 'OMSJ' && aby.d.counted === false, JSON.stringify(aby));
  check(`nothing else of the ${STATES.states.length} aircraft in the box is landing`, hits.length === 3, hits.map((x) => x.cs).join());
  const uae8y = STATES.states.find((sv) => String(sv[1]).trim() === 'UAE8Y');
  check('UAE8Y, lined up for DXB but 7 nm out, waits for the next poll (outside 6 nm)', approachOf(uae8y) === null);
  /* The poll interval against the window: at 70 m/s an approach covers
     4.5 nm in two minutes and the window is 6.5 nm deep (6 ahead, 0.5
     past), so every approach the receivers see is sampled at least once. */
  check('the window is deeper than two minutes of final approach', APPROACH_RULE.maxDistNm - APPROACH_RULE.minAlongNm > (70 * 120) / 1852);

  /* A made-up Sharjah approach for runway 12, from the north-west: 4 nm
     before OMSJ on its 300° radial, 400 m, descending, tracking 120°. */
  const sj = { lat: 25.3286, lon: 55.5172 };   // OMSJ's reference point, typed here so a lost decoy cannot hide
  const at = (ap, nm, brg) => [ap.lat + (nm * Math.cos(brg * Math.PI / 180)) / 60,
    ap.lon + (nm * Math.sin(brg * Math.PI / 180)) / (60 * Math.cos(ap.lat * Math.PI / 180))];
  const [la, lo] = at(sj, 4, 300);
  const sv = ['abc123', 'TEST12  ', 'X', 0, 0, lo, la, 400, false, 75, 120, -3.5, null, 410, null, false, 0, 0];
  check('a Sharjah approach from the north-west is Sharjah’s', approachOf(sv)?.airport === 'OMSJ');
  const wide = approachOf(sv, { rule: { ...APPROACH_RULE, maxDistNm: 15 } });
  const noSj = Object.fromEntries(Object.entries(APPROACH_AIRPORTS).filter(([k]) => k !== 'OMSJ'));
  check('…stays Sharjah’s even with no distance limit, and is never DXB’s', wide?.airport === 'OMSJ'
    && approachOf(sv, { airports: noSj, rule: { ...APPROACH_RULE, maxDistNm: 15 } }) === null, JSON.stringify(wide));
  const DXB = { lat: 25.2528, lon: 55.3644 };
  const [dl, dn] = at(DXB, 2, 300);
  check('a departure climbing out over runway 30 is not a landing',
    approachOf(['d1', 'DEP', 'X', 0, 0, dn, dl, 300, false, 80, 300, 9, null, 310, null, false, 0, 0]) === null);
  check('a level aircraft lined up at 450 m is not a landing',
    approachOf(['d2', 'LVL', 'X', 0, 0, dn, dl, 450, false, 80, 120, 0, null, 460, null, false, 0, 0]) === null);
  const [fl, fn] = at(DXB, 3, 300);
  check('lined up and descending at 3 nm from the north-west for 12 is a landing on 12',
    approachOf(['d3', 'ARR', 'X', 0, 0, fn, fl, 300, false, 75, 120, -3.8, null, 310, null, false, 0, 0])?.runway === '12');
  check('the live box is under one square degree (1 credit a call)', (LIVE_BOX.lamax - LIVE_BOX.lamin) * (LIVE_BOX.lomax - LIVE_BOX.lomin) < 1);
}

/* ── a fake OpenSky ──────────────────────────────────────────────────────── */
const fake = { tokens: 0, tokenBodies: [], asks: [], mode: {}, credits: 3970, states: 0, issued: 0 };
const srv = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(body == null ? '' : JSON.stringify(body)); };
  if (req.method === 'POST' && u.pathname === '/token') {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      fake.tokens++; fake.tokenBodies.push({ body: b, type: req.headers['content-type'] });
      const p = new URLSearchParams(b);
      if (p.get('client_secret') !== 'not-a-real-secret') return send(401, { error: 'invalid_client', echo: p.get('client_secret') });
      fake.issued++;
      return send(200, { access_token: `tok-${fake.issued}`, expires_in: 1800, token_type: 'Bearer' });
    });
    return;
  }
  const auth = req.headers.authorization || '';
  const live = `Bearer tok-${fake.issued}`;
  if (fake.mode.reject401 || auth !== live) {
    if (fake.mode.reject401 === 'once') fake.mode.reject401 = false;
    return send(401, { error: 'unauthorized' });
  }
  if (fake.mode.rate) return send(429, { error: 'too many' }, { 'X-Rate-Limit-Retry-After-Seconds': '1234' });
  if (u.pathname === '/api/flights/arrival') {
    const airport = u.searchParams.get('airport');
    const day = new Date(Number(u.searchParams.get('begin')) * 1000).toISOString().slice(0, 10);
    fake.asks.push(`${airport}|${day}`);
    const h = { 'X-Rate-Limit-Remaining': String((fake.credits -= 30)) };
    if (fake.mode.arrivalsHtml) { res.writeHead(200, { 'content-type': 'text/html', ...h }); res.end('<!DOCTYPE html><html><body>Sign in</body></html>'); return; }
    if (fake.mode.arrivalsEmpty) return send(200, [], h);
    if (day === '2026-11-15') return send(200, airport === 'OMDB' ? OMDB : OMDW, h);
    if (day === '2026-11-13') return send(500, { error: 'boom' }, h);
    return send(404, null, h);
  }
  if (u.pathname === '/api/states/all') {
    fake.states++;
    if (fake.mode.states404) return send(404, null, { 'X-Rate-Limit-Remaining': '3997' });
    if (fake.mode.statesBare) return send(200, { time: STATES.time }, { 'X-Rate-Limit-Remaining': '3997' });
    if (fake.mode.statesEmpty) return send(200, { time: STATES.time, states: null }, { 'X-Rate-Limit-Remaining': '3997' });
    return send(200, STATES, { 'X-Rate-Limit-Remaining': '3998' });
  }
  return send(404, null);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const CFG = { clientId: 'test-client', clientSecret: 'not-a-real-secret', apiUrl: `${base}/api`, tokenUrl: `${base}/token` };

console.log('\n2 · the client, against a fake OpenSky');
{
  forgetToken();
  let clock = Date.parse('2026-11-16T09:30:00Z');
  const c = makeClient(CFG, { now: () => clock });
  const r1 = await c.getJson('/states/all', LIVE_BOX);
  const tb = fake.tokenBodies[0] || {};
  const form = new URLSearchParams(tb.body || '');
  check('the token is a client-credentials grant sent as a form', form.get('grant_type') === 'client_credentials'
    && form.get('client_id') === 'test-client' && /x-www-form-urlencoded/.test(tb.type || ''), JSON.stringify(tb.type));
  check('a data call carries the token and reads the credits header', r1.status === 200 && r1.credits === 3998);
  await c.getJson('/states/all', LIVE_BOX);
  check('the token is reused while it lasts (one grant for two calls)', fake.tokens === 1, String(fake.tokens));
  clock += 1800_000;
  await c.getJson('/states/all', LIVE_BOX);
  check('…and asked for again once it has expired', fake.tokens === 2, String(fake.tokens));
  fake.mode.reject401 = 'once';
  const r401 = await c.getJson('/states/all', LIVE_BOX).catch((e) => ({ status: String(e.message) }));
  check('a 401 is answered by one fresh sign-in, and the call then succeeds', r401.status === 200 && fake.tokens === 3, `${r401.status} ${fake.tokens}`);
  fake.mode.reject401 = true;
  let e401 = null; try { await c.getJson('/states/all', LIVE_BOX); } catch (e) { e401 = e; }
  check('a second 401 is an error that says the token was refused', e401 instanceof OpenSkyError && e401.kind === 'auth', String(e401));
  fake.mode.reject401 = false;
  fake.mode.rate = true;
  let e429 = null; try { await c.getJson('/states/all', LIVE_BOX); } catch (e) { e429 = e; }
  check('a 429 is a rate error carrying OpenSky’s retry-after', e429?.kind === 'rate' && e429.retryAfter === 1234, String(e429?.message));
  fake.mode.rate = false;
  const r404 = await c.getJson('/flights/arrival', { airport: 'OMDB', begin: Date.parse('2026-11-16T00:00:00Z') / 1000, end: 0 });
  check('a 404 is an answer, not a throw', r404.status === 404);
  forgetToken();
  const bad = makeClient({ ...CFG, clientSecret: 'wrong-secret-value' }, { now: () => clock });
  let eBad = null; try { await bad.getJson('/states/all', LIVE_BOX); } catch (e) { eBad = e; }
  check('a refused client says so, naming the settings — and never the secret', eBad?.kind === 'auth'
    && /OPENSKY_CLIENT_ID/.test(eBad.message) && !/wrong-secret-value/.test(eBad.message), String(eBad?.message));
}

console.log('\n3 · the collector, on PGlite');
const db = new PGlite();
await applySchema(db);
const rows = async (t, p = []) => (await db.query(t, p)).rows;
{
  forgetToken();
  /* planDays alone. */
  const plan = planDays({ nowMs: Date.parse('2026-11-16T09:30:00Z'), days: 2, coverage: [
    { airport: 'OMDB', utc_day: '2026-11-15', status: 'collected' },
    { airport: 'OMDW', utc_day: '2026-11-14', status: 'none_returned', attempts: 3 }] });
  check('the plan skips a collected day, an exhausted old day, and today', plan.map((p) => `${p.airport}|${p.day}`).join() === 'OMDW|2026-11-15,OMDB|2026-11-14',
    JSON.stringify(plan));

  /* No client: absent with the reason, nothing written. */
  const none = await collectArrivals({ db, cfg: null, nowMs: Date.parse('2026-11-16T09:30:00Z'), days: 3 });
  const run0 = (await rows(`SELECT status, error FROM collection_run WHERE source = 'opensky' AND mode = 'arrivals' ORDER BY id DESC LIMIT 1`))[0];
  check('no client: the run records “no OpenSky client configured”', none.skipped === NO_CLIENT && run0?.status === 'error' && run0.error === NO_CLIENT, JSON.stringify(run0));
  check('…and writes no landing and no coverage row (absent, never zero)',
    (await rows('SELECT count(*)::int n FROM flight_landing'))[0].n === 0 && (await rows('SELECT count(*)::int n FROM flight_day_coverage'))[0].n === 0);

  /* A live estimate for an aircraft the confirmed list holds (896621, UAE393,
     lastSeen 1794786559), to be superseded. */
  const ls = OMDB.find((f) => f.icao24 === '896621').lastSeen;
  await db.query(`INSERT INTO flight_live_landing (airport, icao24, callsign, landed_at, seen_at) VALUES
    ('OMDB', '896621', 'UAE393', $1, $1), ('OMDB', 'ffffff', 'NOPE1', $2, $2)`,
  [new Date((ls - 240) * 1000).toISOString(), new Date((ls - 7200) * 1000).toISOString()]);   // 21:49Z, the same UTC day

  const nowMs = Date.parse('2026-11-16T09:30:00Z');
  const r1 = await collectArrivals({ db, cfg: CFG, nowMs, days: 3, floor: 0 });
  const n1 = (await rows('SELECT count(*)::int n FROM flight_landing'))[0].n;
  check(`2026-11-15 stored: ${OMDB.length} at OMDB + ${OMDW.length} at OMDW`, n1 === OMDB.length + OMDW.length && r1.written === n1, `${n1} ${JSON.stringify(r1)}`);
  const cov = Object.fromEntries((await rows(`SELECT airport || '|' || utc_day::text k, status, landings, reason FROM flight_day_coverage`)).map((r) => [r.k, r]));
  check('each airport-day says what happened', cov['OMDB|2026-11-15']?.status === 'collected' && cov['OMDB|2026-11-15'].landings === OMDB.length
    && cov['OMDW|2026-11-15']?.status === 'collected', JSON.stringify(cov));
  check('an older day’s 404 is “none returned”, with the reason', cov['OMDB|2026-11-14']?.status === 'none_returned' && /holds no arrivals/.test(cov['OMDB|2026-11-14'].reason));
  check('a 500 is “failed”, with the reason', cov['OMDB|2026-11-13']?.status === 'failed' && /HTTP 500/.test(cov['OMDB|2026-11-13'].reason));
  const nullOrigin = (await rows(`SELECT count(*)::int n FROM flight_landing WHERE airport = 'OMDB' AND origin IS NULL`))[0].n;
  check('an origin OpenSky could not estimate is stored as unknown, not guessed (163 of 438)', nullOrigin === 163, String(nullOrigin));
  const t = (await rows(`SELECT landed_at FROM flight_landing WHERE icao24 = '896621' AND airport = 'OMDB'`))[0];
  check('landed_at is OpenSky’s lastSeen', new Date(t.landed_at).getTime() === ls * 1000);
  const lv = Object.fromEntries((await rows(`SELECT icao24, superseded_at IS NOT NULL s, confirmed_id FROM flight_live_landing`)).map((r) => [r.icao24, r]));
  check('the confirmed list supersedes the live estimate and points it at its landing', lv['896621']?.s && lv['896621'].confirmed_id != null, JSON.stringify(lv));
  check('…and an estimate it does not hold is superseded with no match', lv.ffffff?.s && lv.ffffff.confirmed_id == null);
  const run1 = (await rows(`SELECT status, rows_written FROM collection_run WHERE source = 'opensky' AND mode = 'arrivals' ORDER BY id DESC LIMIT 1`))[0];
  check('the run is partial (one window failed) and counts what it wrote', run1.status === 'partial' && run1.rows_written === n1, JSON.stringify(run1));

  /* Again: the collected day is not asked; the failed and none-returned are. */
  const asked = fake.asks.length;
  await collectArrivals({ db, cfg: CFG, nowMs, days: 3, floor: 0 });
  const again = fake.asks.slice(asked);
  check('a collected day is not asked again', !again.some((k) => k.endsWith('2026-11-15')) && again.includes('OMDB|2026-11-13'), again.join());
  check('…and the landings are the same rows', (await rows('SELECT count(*)::int n FROM flight_landing'))[0].n === n1);
  const twice = await storeLandings(db, 'OMDB', '2026-11-15', OMDB).then(() => null, (e) => String(e.message).slice(0, 120));
  check('storing the same day twice changes nothing (idempotent)', twice === null && (await rows('SELECT count(*)::int n FROM flight_landing'))[0].n === n1, twice);
  const att = (await rows(`SELECT attempts FROM flight_day_coverage WHERE airport = 'OMDB' AND utc_day = '2026-11-13'`))[0].attempts;
  check('a failed day counts its attempts', att === 2, String(att));

  /* Yesterday's 404 is the nightly batch not having run. */
  const early = Date.parse('2026-11-17T00:30:00Z');
  await collectArrivals({ db, cfg: CFG, nowMs: early, days: 1, floor: 0 });
  const np = (await rows(`SELECT status, reason FROM flight_day_coverage WHERE airport = 'OMDB' AND utc_day = '2026-11-16'`))[0];
  check('yesterday’s 404 is “not published yet”', np?.status === 'not_published' && /nightly batch/.test(np.reason), JSON.stringify(np));

  /* The credit floor stops a run before it spends below it. */
  fake.credits = 700;
  const before = fake.asks.length;
  const rf = await collectArrivals({ db, cfg: CFG, nowMs: Date.parse('2026-11-20T09:30:00Z'), days: 10, floor: 620 });
  const spent = fake.asks.length - before;
  check('the credit floor stops the run (670, 640, 610 left — then it stops, under 620)', rf.stopped && spent === 3, `${spent} ${rf.stopped}`);

  /* A 200 that is not a list is not a day on which nothing landed. Review of
     2026-11-16 (FIX-STATUS FLT-R5): storeLandings keeps array rows only, so
     a sign-in page behind a silent redirect (text) was stored as nothing and
     the day written 'collected' with 0 landings — never asked again, and a
     complete day of zeros to /api/airport. An empty list is read as OpenSky's
     404 is. REVERSION: drop the not-a-list throw and the empty-list test in
     collectArrivals — both checks fail ('collected', 0). */
  fake.credits = 3970;
  fake.mode.arrivalsHtml = true;
  await collectArrivals({ db, cfg: CFG, nowMs: Date.parse('2026-11-25T09:30:00Z'), days: 1, floor: 0 });
  fake.mode.arrivalsHtml = false;
  const html = (await rows(`SELECT status, landings, reason FROM flight_day_coverage WHERE airport = 'OMDB' AND utc_day = '2026-11-24'`))[0];
  check('a 200 that is a page of text is “failed” with the reason, never a collected zero',
    html?.status === 'failed' && html.landings == null && /without a list of arrivals/.test(html.reason || ''), JSON.stringify(html));
  fake.mode.arrivalsEmpty = true;
  await collectArrivals({ db, cfg: CFG, nowMs: Date.parse('2026-11-27T09:30:00Z'), days: 2, floor: 0 });
  fake.mode.arrivalsEmpty = false;
  const emp = Object.fromEntries((await rows(`SELECT utc_day::text d, status, landings, reason FROM flight_day_coverage
    WHERE airport = 'OMDB' AND utc_day IN ('2026-11-25', '2026-11-26')`)).map((r) => [r.d, r]));
  check('an empty list is read as a 404 is: yesterday not published, an older day none returned — never collected',
    emp['2026-11-26']?.status === 'not_published' && emp['2026-11-25']?.status === 'none_returned'
      && /an empty list/.test(emp['2026-11-25'].reason || '') && emp['2026-11-25'].landings == null, JSON.stringify(emp));
}

console.log('\n4 · the live poll');
{
  resetLive(); forgetToken();
  await db.query('DELETE FROM flight_live_landing');
  const t0 = STATES.time * 1000;
  const p1 = await pollLive({ db, cfg: CFG, nowMs: t0 });
  /* The same snapshot again, as the next poll would see two aircraft still on
     final: they refine their estimate, they do not land twice. */
  const p2 = await pollLive({ db, cfg: CFG, nowMs: t0 + 120_000 });
  const live = await rows(`SELECT airport, icao24, runway, superseded_at FROM flight_live_landing ORDER BY icao24`);
  check('the poll stores the two DXB approaches as live estimates', p1.landing === 2 && live.length === 2
    && live.every((r) => r.airport === 'OMDB' && r.runway === '30' && r.superseded_at == null), JSON.stringify(live));
  check('…and the Sharjah one is named and not stored', p1.sharjah === 1);
  check('a second poll of the same approaches adds no landing', p2.landing === 0 && live.length === 2);
  const hr = (await rows(`SELECT polls, polls_ok, aircraft_seen FROM flight_live_hour WHERE hour_start = $1`, [new Date(Math.floor(t0 / 3600e3) * 3600e3).toISOString()]))[0];
  check('the hour counts its polls and what they saw', hr?.polls >= 2 && hr.polls_ok >= 2 && hr.aircraft_seen >= 40, JSON.stringify(hr));
  fake.mode.rate = true;
  const pr = await pollLive({ db, cfg: CFG, nowMs: t0 + 240_000 });
  fake.mode.rate = false;
  const statesBefore = fake.states;
  const pb = await pollLive({ db, cfg: CFG, nowMs: t0 + 360_000 });
  check('after a 429 the poller backs off for OpenSky’s retry-after, and says so', /429/.test(pr.error || '') && /backing off/.test(pb.skipped || '') && fake.states === statesBefore,
    `${pr.error} | ${pb.skipped}`);
  /* A 404, or a 200 without a `states` field, is not an empty sky. Review of
     2026-11-16 (FIX-STATUS FLT-R4): pollLive read both as zero aircraft and
     counted the poll as answered, so the hour turned "watched" and the page
     drew 0 landings as a live estimate for an hour nothing measured.
     OpenSky's own empty answer, `states: null`, still counts.
     REVERSION: drop the status / states-field guard in pollLive — the first
     two checks fail. */
  const hourOf = (ms) => new Date(Math.floor(ms / 3600e3) * 3600e3).toISOString();
  const tq = t0 + 3 * 3600e3;
  resetLive();   // the 429 above set a back-off; these hours are past it anyway
  fake.mode.states404 = true;
  const q404 = await pollLive({ db, cfg: CFG, nowMs: tq });
  fake.mode.states404 = false;
  const h404 = (await rows('SELECT polls, polls_ok, last_error FROM flight_live_hour WHERE hour_start = $1', [hourOf(tq)]))[0];
  check('a 404 on the live positions is a failed poll with its reason, never an empty sky',
    /HTTP 404/.test(q404.error || '') && h404?.polls === 1 && h404.polls_ok === 0 && /HTTP 404/.test(h404.last_error || ''), JSON.stringify({ q404, h404 }));
  const tb = t0 + 4 * 3600e3;
  fake.mode.statesBare = true;
  const qb = await pollLive({ db, cfg: CFG, nowMs: tb });
  fake.mode.statesBare = false;
  const hb = (await rows('SELECT polls_ok FROM flight_live_hour WHERE hour_start = $1', [hourOf(tb)]))[0];
  check('…and so is a 200 that carries no states field', /without a states field/.test(qb.error || '') && hb?.polls_ok === 0, JSON.stringify({ qb, hb }));
  const te = t0 + 5 * 3600e3;
  fake.mode.statesEmpty = true;
  const qe = await pollLive({ db, cfg: CFG, nowMs: te });
  fake.mode.statesEmpty = false;
  const he = (await rows('SELECT polls_ok FROM flight_live_hour WHERE hour_start = $1', [hourOf(te)]))[0];
  check('…while OpenSky’s own empty answer (states: null) is an answered poll that saw nothing', qe.seen === 0 && !qe.error && he?.polls_ok === 1, JSON.stringify({ qe, he }));
  const pn = await pollLive({ db, cfg: null, nowMs: t0 + 7200_000 });
  const hn = (await rows(`SELECT polls_ok, last_error FROM flight_live_hour WHERE hour_start = $1`, [new Date(Math.floor((t0 + 7200_000) / 3600e3) * 3600e3).toISOString()]))[0];
  check('no client: the live hour records the reason, and no poll counts as answered', pn.skipped === NO_CLIENT && hn?.polls_ok === 0 && hn.last_error === NO_CLIENT, JSON.stringify(hn));
}

console.log('\n5 · the schedule, read the way node-cron reads it');
{
  /* node-cron 3.0.3 reads a stepped RANGE as the multiples of its step
     (COVERAGE trap), so the hours are checked through its own matcher, not
     by eye. */
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const arr = idx.match(/cron\.schedule\('([^']+)', \(\) => flightsArrivalsTick\(\)/)?.[1];
  const liv = idx.match(/cron\.schedule\('([^']+)', \(\) => flightsLiveTick\(\)/)?.[1];
  const { default: TimeMatcher } = await import('node-cron/src/time-matcher.js');
  const fires = (expr, d) => new TimeMatcher(expr, 'Etc/UTC').match(d);
  const hours = Array.from({ length: 24 }, (_, h) => h).filter((h) => arr && fires(arr, new Date(Date.UTC(2026, 10, 16, h, 41))));
  check('arrivals run at 01:41, 04:41 … 22:41 UTC — every third hour from just after the UTC day closes', hours.join() === '1,4,7,10,13,16,19,22', `${arr} → ${hours}`);
  const mins = Array.from({ length: 60 }, (_, m) => m).filter((m) => liv && fires(liv, new Date(Date.UTC(2026, 10, 16, 9, m))));
  check('the live watch polls every two minutes from minute 0 (30 an hour)', mins.length === 30 && mins[0] === 0 && mins.every((m) => m % 2 === 0), `${liv} → ${mins.length}`);
}

srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
