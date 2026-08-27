/* ── a route that fails AFTER its first byte ───────────────────────────────
   Every route in this API answered JSON in one shot until /api/export/trips.csv
   began streaming a CSV a day at a time. A streaming route can fail with its
   status line already sent, and the error boundary had never met that case:
   res.status(500).json() throws ERR_HTTP_HEADERS_SENT on top of the real
   error, so the log names the wrong thing and the process takes an unhandled
   rejection.

   The alternative that looks tidy is worse: catch it, end the response, and
   the client gets 200 and a file that is short and reads as complete. For an
   export that is precisely the lie the endpoint exists to avoid.

   So: aborted transfer, truth in the log. These tests hold the boundary to
   that — including the ordinary case, which must keep answering JSON. */
import express from 'express';
import { makeWrap } from '../api/wrap.js';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { exportRoutes } from '../api/export_routes.js';
import { winDays } from '../api/window.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const logged = [];
const log = { error: (...a) => logged.push(a) };
const wrap = makeWrap({ log });

/* An unhandled rejection here would take the test process down the same way it
   would take the API down, so it is caught and reported rather than thrown. */
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(String(e)));

const app = express();
app.get('/early', wrap(async () => { throw new Error('failed before writing'); }));
app.get('/late', wrap(async (req, res) => {
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.write('a,b,c\n1,2,3\n');
  throw new Error('failed after writing');
}));
app.get('/fine', wrap(async (req, res) => res.json({ ok: true })));
const server = app.listen(0);
const port = server.address().port;

/* ── the ordinary case still answers ─────────────────────────────────────── */
const fine = await fetch(`http://127.0.0.1:${port}/fine`);
check('a route that succeeds is untouched', fine.status === 200 && (await fine.json()).ok);

const early = await fetch(`http://127.0.0.1:${port}/early`);
const earlyBody = await early.json();
check('a failure BEFORE the first byte is still a 500 with a reference',
  early.status === 500 && earlyBody.error === 'internal' && /^e[a-z0-9]+-[a-z0-9]+$/.test(earlyBody.ref),
  JSON.stringify(earlyBody));
check('and the reference in the body is the one written to the log',
  logged.at(-1)?.[2]?.ref === earlyBody.ref, JSON.stringify(logged.at(-1)));
/* The reason the body is a reference and not the error: a 500 that quotes the
   driver hands an unauthenticated caller the storage engine, the column and
   the type. route_smoke.test.mjs asserts the wiring; this asserts the body. */
check('and the body does not quote the error to the caller',
  !/failed before writing/.test(JSON.stringify(earlyBody))
  && Object.keys(earlyBody).sort().join() === 'error,ref', JSON.stringify(earlyBody));

/* ── the case the boundary had never met ─────────────────────────────────── */
let aborted = false, status = null, partial = null;
try {
  const r = await fetch(`http://127.0.0.1:${port}/late`);
  status = r.status;
  partial = await r.text();          // must NOT resolve: the stream is cut
} catch { aborted = true; }
check('a failure AFTER the first byte aborts the transfer',
  aborted, `status ${status}, body ${JSON.stringify(partial)}`);
/* The distinction that matters. A 200 with a short body is indistinguishable
   from a complete file, which for an export is the whole danger. */
check('rather than handing back a short body that reads as complete',
  partial === null, JSON.stringify(partial));
check('and it is still logged, with the error that actually happened',
  /failed after writing/.test(String(logged.at(-1)?.[2]?.err)), JSON.stringify(logged.at(-1)));
check('not ERR_HTTP_HEADERS_SENT written over the top of it',
  !logged.some((l) => /ERR_HTTP_HEADERS_SENT/.test(JSON.stringify(l))));

/* ── and the real streaming route behaves the same way ───────────────────── */
/* The boundary above is a fixture. This is /api/export/trips.csv itself, made
   to fail on its second day of rows — after the header and the first day have
   already gone out. */
const db = new PGlite();
await applySchema(db);
await db.query(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);
let seq = 0;
for (const at of ['2026-08-25T09:00:00+04', '2026-08-26T09:00:00+04']) {
  await db.query(
    `INSERT INTO trip (platform, fleet_id, external_id, driver_ext_id, driver_name, plate,
                       requested_at, status, distance_km, currency)
     VALUES ('uber','ecosine',$1,'d1','D','L1',$2::timestamptz,'completed',10,'AED')`,
    [`t${++seq}`, at]);
}
let dayQueries = 0;
const q = (t, p = []) => {
  /* The per-day query is the one bounded to a single date. Fail the second. */
  if (/local_day = \$1::date/.test(t) && ++dayQueries === 2) {
    return Promise.reject(new Error('database went away mid-export'));
  }
  return db.query(t, p).then((r) => r.rows);
};
const streamApp = express();
exportRoutes(streamApp, { q, wrap, winDays, log });
const streamSrv = streamApp.listen(0);
let streamAborted = false, streamBody = null;
try {
  const r = await fetch(
    `http://127.0.0.1:${streamSrv.address().port}/api/export/trips.csv?from=2026-08-25&to=2026-08-26&grain=trip`);
  streamBody = await r.text();
} catch { streamAborted = true; }
check('the export itself aborts when a day query fails mid-file',
  streamAborted, JSON.stringify(streamBody));
check('so a half-written export is never delivered as a whole one',
  streamBody === null && dayQueries === 2, `body ${JSON.stringify(streamBody)}, ${dayQueries} day queries`);
check('and the failure is logged, naming the export',
  logged.some((l) => /export/.test(String(l[1])) && /went away/.test(JSON.stringify(l[2]))),
  JSON.stringify(logged.at(-1)));

await new Promise((r) => setTimeout(r, 50));
check('and nothing became an unhandled rejection', unhandled.length === 0, unhandled.join('; '));

console.log(`\n${pass} passed, ${fail} failed`);
server.close(); streamSrv.close(); await db.close();
process.exit(fail ? 1 : 0);
