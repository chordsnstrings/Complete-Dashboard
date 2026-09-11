/* "Never asked" must mean nobody asked — including the whole-roster sweep.
   ──────────────────────────────────────────────────────────────────────────
   The page has two sentences for a driver with no online event and they say
   opposite things. `not_asked` says we hold no evidence either way.  `absent`
   says Uber was asked and had nothing, which is a statement about the driver.
   Only one can be printed truthfully.

   It chose between them by reconstructing the INCREMENTAL tick's selection
   rule — a trip in the previous 48 hours — and that was the only test it
   applied. The collector has a second way of reaching a driver:
   `timeline-roster` asks about every driver on a fleet's books regardless of
   trips, and src/sources/uber_timeline.js builds that list from the union of
   driver_platform_state and trip.

   So for every day such a sweep covered, the page printed the weaker and
   wronger sentence. MEASURED on production before this: the sweep of
   2026-08-27 covered 2026-07-28 to 2026-08-27, and across that month the page
   reported 44 to 49 people A DAY as never asked about — people Uber had been
   asked about and returned nothing for. The product understated what it knew
   over exactly the period it knew most about. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import express from 'express';
import { onlineRoutes } from '../api/online_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
const DAY = '2026-08-14';

await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);
const state = (id, name, fleet = 'ecosine') => q(
  `INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state,
     state_raw, can_earn) VALUES ('uber',$1,$2,$3,'active','ACTIVE',true)`, [id, fleet, name]);

/* Two drivers on two different fleets, neither with a trip or an event. The
   sweep covered one fleet and not the other, which is the distinction the page
   has to make — a roster pass runs per fleet. */
await state('d-swept', 'Swept Roster', 'ecosine');
await state('d-unswept', 'Unswept Roster', 'egari');

const run = (fleet, mode, from, to, status = 'ok') => q(
  `INSERT INTO collection_run (source, fleet_id, mode, window_start, window_end,
     finished_at, status, rows_written)
   VALUES ('uber_timeline',$1,$2,$3::date,$4::date,$5::timestamptz,$6,10)`,
  [fleet, mode, from, to, `${to}T07:31:16Z`, status]);

await run('ecosine', 'roster', '2026-07-28', '2026-08-27');
/* Egari got only the narrow tick, which reaches nobody without a trip. */
await run('egari', 'timeline', '2026-08-13', '2026-08-15');

const app = express();
onlineRoutes(app, { q, wrap: (fn) => (rq, rs) => Promise.resolve(fn(rq, rs)).catch((e) => {
  rs.status(500).json({ error: String(e) }); }) });
const server = app.listen(0);
const port = server.address().port;
const get = async (qs) => (await fetch(`http://127.0.0.1:${port}/api/online-time?${qs}`)).json();

const body = await get(`day=${DAY}&start=08:00`);
const row = (n) => body.rows.find((r) => r.name === n);

/* ── the sweep is an ask ────────────────────────────────────────────────── */
{
  const r = row('Swept Roster');
  check('a day a whole-roster sweep covered is not reported as never asked about',
    r?.online_basis === 'absent', r?.online_basis);
  check('and the sentence says which ask found nothing, naming the sweep and its date',
    /whole-roster sweep of 2026-08-27/.test(r.online_why)
      && /did not come online/.test(r.online_why), r.online_why);
}

/* ── and a fleet it did not cover keeps the honest refusal ──────────────── */
{
  const r = row('Unswept Roster');
  check('a fleet no sweep reached still holds no evidence either way',
    r?.online_basis === 'not_asked', r?.online_basis);
  check('…and the sentence no longer says the state will never fix itself',
    /fills in by itself/.test(r.online_why) && !/until somebody runs/.test(r.online_why),
    r.online_why);
}

/* ── the boundary, which must fall towards claiming nothing ─────────────── */
{
  /* window_end is the instant the run woke, so the last day in the range is
     only PARTLY covered. Claiming it as fully asked is the error that runs
     towards `absent`, the state that asserts evidence about a person. */
  const end = await get('day=2026-08-27&start=08:00');
  check('the last day of a sweep window is not claimed as swept, being only part-covered',
    end.rows.find((r) => r.name === 'Swept Roster')?.online_basis === 'not_asked',
    end.rows.find((r) => r.name === 'Swept Roster')?.online_basis);
  const first = await get('day=2026-07-28&start=08:00');
  check('while the first day of it is, being whole',
    first.rows.find((r) => r.name === 'Swept Roster')?.online_basis === 'absent',
    first.rows.find((r) => r.name === 'Swept Roster')?.online_basis);
  const before = await get('day=2026-07-27&start=08:00');
  check('and a day before the sweep began is untouched by it',
    before.rows.find((r) => r.name === 'Swept Roster')?.online_basis === 'not_asked');
}

/* ── a failed sweep asked nobody ────────────────────────────────────────── */
{
  await run('egari', 'roster', '2026-07-28', '2026-08-27', 'error');
  const after = await get(`day=${DAY}&start=08:00`);
  check('a sweep that errored is not evidence that anybody was asked',
    after.rows.find((r) => r.name === 'Unswept Roster')?.online_basis === 'not_asked',
    after.rows.find((r) => r.name === 'Unswept Roster')?.online_basis);
}

/* ── the response carries it, so the page can say so too ────────────────── */
check('the response says when a whole-roster pass last covered the day',
  String(body.feed?.roster_swept_at || '').startsWith('2026-08-27'),
  String(body.feed?.roster_swept_at));
check('and the feed note describes the schedule the collector actually runs',
  /every driver on the roster/.test(body.feed?.note || '')
    && !/only asked about drivers who took a trip/.test(body.feed?.note || ''),
  body.feed?.note);

/* ── the mock must not render a shape the endpoint cannot produce ────────
   mockapi.mjs drives the browser smoke run. With no `absent` row it printed
   "1 person has not been asked about for this day" directly above "a
   whole-roster pass last covered this day at 09:40" — two sentences that
   cannot both be true of one fleet, in one eyeful, in a passing test run. They
   CAN both appear on a real page, because a sweep runs per fleet, which is why
   the fixture needs a row of each rather than one of them removed. */
{
  const mock = readFileSync('mockapi.mjs', 'utf8');
  check('the mock renders the asked-and-nothing state as well as the never-asked one',
    /'not_asked', 'cannot_earn',\n      'worked_elsewhere', 'worked_late', 'absent'/.test(mock));
  check('and an asked-and-nothing driver has no trips and no online time to contradict it',
    /\['not_asked', 'cannot_earn', 'absent'\].includes\(basis\) \? null/.test(mock)
      && /\['not_asked', 'absent'\].includes\(basis\) \? 0/.test(mock));
  check('its absent sentence names the sweep, matching the one the endpoint builds',
    /whole-roster sweep of 2026-08-27 covered it/.test(mock));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
