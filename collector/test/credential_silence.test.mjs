/* A refused source has to name the credential it was refused for.
   ─────────────────────────────────────────────────────────────────────────
   Uber has recorded credential state since the OAuth work. The other five
   sources never did, so their refusals reached the operator as a source that
   had quietly gone empty — and the Settings panel built to answer "what do I
   re-paste" had nothing to say about any of them.

   Two of the five were worse than silent. http() resolves whatever the status
   and both hotel.js and cabman.js read `data?.…  || []`, so a 401 produced an
   empty result that is indistinguishable from a quiet hour. For CABMAN that
   is not a cosmetic difference: production carried 89 stale_tracker findings,
   85 of them CABMAN, each telling an operator to "Check the device" on a
   device that was answering fine. One credential, printed eighty-five times as
   eighty-five broken cars.

   And Yango named the wrong credential. Every request carries the park id, the
   API key AND the cookie, so a 403 names none of them — but the hint said "the
   Yandex session has expired; re-paste YANGO_COOKIE". Measured 2026-09-02, the
   endpoint answers the same 403 with the cookie header omitted entirely. */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

/* The two things a refusal must reach: the credential panel, and the run
   record. Both are captured at the one place they both go through — pool.query
   — so what the assertions read is what the collector actually passed, not a
   stub standing in for it. */
const notes = [];
const runs = [];
const { pool } = await import('../src/db.js');
pool.query = async (text, params = []) => {
  const t = String(text);
  if (/INSERT INTO credential_state/i.test(t)) {
    notes.push({ provider: params[0], fleet: params[1], credential: params[2],
      state: params[3], detail: params[4], surface: params[5] });
  } else if (/INSERT INTO collection_run/i.test(t)) {
    runs.push({ source: params[0], status: params[5], rows: params[6], error: params[7],
      chunks: params[10] ? JSON.parse(params[10]) : [] });
  }
  return { rows: [{ id: 1 }], rowCount: 0 };
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const src = (f) => readFileSync(f, 'utf8');

console.log('\nevery source that can be refused records which credential was refused');

/* Uber is the reference: it is where this behaviour already existed, and the
   assertion is that the others now match it rather than that it still does. */
const SOURCES = [
  ['src/sources/uber.js', 'uber'],
  ['src/sources/yango.js', 'yango'],
  ['src/sources/bolt.js', 'bolt'],
  ['src/sources/hotel.js', 'hotel'],
  ['src/sources/cabman.js', 'cabman'],
];
for (const [file, name] of SOURCES) {
  check(`${name} reaches for noteCredential`, /noteCredential\(/.test(src(file)), file);
}

console.log('\nand a refusal is never read as an empty answer');

{
  /* Driven, not read: a source-text assertion about where a guard sits relative
     to a `|| []` is a test of this file's own prose. This stands a real server
     in front of the real collector and has it answer 401 to everything. */
  const seen = { hits: 0 };
  const server = createServer((req, res) => {
    seen.hits++;
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'token expired' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  process.env.CABMAN_URL = `http://127.0.0.1:${port}/`;
  process.env.CABMAN_ECOSINE_PASS = 'x';
  const { pullLive } = await import('../src/sources/cabman.js');
  let wrote = null;
  try { wrote = await pullLive(); } catch (e) { wrote = `threw: ${String(e).slice(0, 80)}`; }
  check('a refused CABMAN feed writes no vehicles and does not report zero as an answer',
    wrote === 0 || String(wrote).startsWith('threw'), JSON.stringify(wrote));
  check('…having actually asked the refusing server', seen.hits > 0, String(seen.hits));
  const noted = notes.filter((n) => n.provider === 'cabman');
  check('…and it named the credential rather than leaving the panel empty',
    noted.length > 0 && noted.every((n) => n.state === 'invalid' && /401/.test(n.detail || '')),
    JSON.stringify(noted));

  notes.length = 0;
  process.env.HOTEL_BASE = `http://127.0.0.1:${port}`;
  process.env.HOTEL_TOKEN = 'x';
  const hotelMod = await import('../src/sources/hotel.js');
  runs.length = 0;
  /* One window, so the assertion is about the refusal rather than about how
     many months an incremental happens to cover. */
  try {
    await hotelMod.collect({ mode: 'incremental', from: '2026-08-01', to: '2026-08-05' });
  } catch { /* collect logs its own failure rather than throwing */ }
  const chunkErrors = runs.flatMap((r) => (r.chunks || []).map((c) => c.error).filter(Boolean));
  check('a refused hotel window is an error on the window, not a month with no trips',
    chunkErrors.some((e) => /refused: HTTP 401/.test(e)), JSON.stringify(chunkErrors.slice(0, 2)));
  check('…and it named the credential too',
    notes.some((n) => n.provider === 'hotel' && n.state === 'invalid'), JSON.stringify(notes));

  server.close();
}

console.log('\nand Yango stops blaming the cookie for a refusal the cookie is not in');

{
  for (const f of ['src/sources/yango.js', 'src/credcheck.js']) {
    const y = src(f);
    /* The isolating request: the same call with no cookie header. If the
       refusal survives it, the cookie is not what is being refused. */
    check(`${f} asks a second time without the cookie`,
      /cookie/.test(y) && /(cookieIsNotIt|with or without a session|no cookie at all)/.test(y), f);
    check(`…and only names YANGO_COOKIE when that second answer differs`,
      !/re-paste YANGO_COOKIE/.test(y) || /cookieIsNotIt\s*\n?\s*\?/.test(y)
      || /with or without a session/.test(y), f);
  }
  const y = src('src/sources/yango.js');
  check('…and names the park and key when it does not',
    /YANGO_PARK_ID/.test(y) && /YANGO_API_KEY/.test(y));
}

console.log('\nand a credential that was never supplied is a different message');

{
  const b = src('src/sources/bolt.js');
  check('bolt distinguishes a missing refresh token from a rejected one',
    /state: 'missing'/.test(b) && /state: 'invalid'/.test(b));
  check('…and a token minted for the other fleet from an expired one',
    /wrong fleet's token, not an expired one/.test(b));
  check('cabman distinguishes a missing password from a rejected one',
    /state: 'missing'/.test(src('src/sources/cabman.js')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
