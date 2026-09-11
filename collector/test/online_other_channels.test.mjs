/* Online time reads every earning channel, not only Uber.
   ──────────────────────────────────────────────────────────────────────────
   Uber is the one channel that publishes a timeline, so it is the only source
   of a real "came online at" moment. But the fleet also drives hotel, Bolt and
   Yango jobs, and those report finished trips. A trip is a ONE-SIDED bound on
   the online moment — a job cannot be given to a driver who is not online — so
   it can prove somebody was there in time and can never prove they were late.

   The page used that bound already, and read it off UBER TRIPS ALONE. Which
   made it useless for exactly the people it could have helped: a driver with
   no Uber trip has no Uber timeline, and no Uber timeline is what put them in
   the grey bucket in the first place. MEASURED on production 2026-09-10: 0 of
   the 72 unjudged rows carried a first trip, while four of them were driving
   hotel jobs that day. Three of those four were worse than unjudged — they sat
   in `cannot_earn`, so an operations page told somebody they could not take
   work on a day they took five jobs.

   Both halves of the rule are fixtured below, because only asserting the
   generous half would let the page start inventing phone calls. */
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

const state = (o) => q(
  `INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state,
     state_raw, can_earn, plate)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,null)`,
  [o.platform || 'uber', o.id, o.name, o.state || 'active', o.raw || 'ACTIVE', o.canEarn ?? true]);

let tn = 0;
const trip = (platform, id, name, at) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, distance_km, status, price)
   VALUES ($1,$2,'ecosine','L1',$3,$4,$5::timestamptz,10,'completed',40)`,
  [platform, `oc${tn++}`, id, name, at]);

const ev = (id, at, status) => q(
  `INSERT INTO driver_timeline_event (platform, driver_ext_id, fleet_id, at, kind, status, state)
   VALUES ('uber',$1,'ecosine',$2::timestamptz,'status',$3,'')`, [id, at, status]);

/* HOTEL-ONLY, EARLY. Uber waitlisted him; the hotel channel kept giving him
   work, and he was driving at 06:19. Under the old page he read "cannot earn"
   — on an operations screen, about a man doing five jobs. */
await state({ id: 'd-hotel', name: 'Joseph Wandera', canEarn: false,
  state: 'waitlist', raw: 'onboarding_status_waitlisted' });
await state({ platform: 'hotel', id: 'h-hotel', name: 'Joseph Wandera' });
for (const t of ['06:19', '08:40', '11:02']) await trip('hotel', 'h-hotel', 'Joseph Wandera', `${DAY}T${t}:00+04:00`);

/* HOTEL-ONLY, LATE FIRST TRIP. Drove, but the first job landed at 12:14. That
   proves he was working; it says nothing about when he came online. */
await state({ id: 'd-late', name: 'Majid Shah' });
await state({ platform: 'hotel', id: 'h-late', name: 'Majid Shah' });
await trip('hotel', 'h-late', 'Majid Shah', `${DAY}T12:14:00+04:00`);

/* NOTHING ANYWHERE. Must stay not_asked — the evidence widens, the honesty
   about absence does not. */
await state({ id: 'd-none', name: 'Nobody Drove' });

/* UBER, REPORTED AND LATE. The online stamp still governs when it exists, and
   an early hotel trip must not quietly clear a late Uber start... except it
   would be real evidence, so this driver has NO other-channel trip: the point
   here is that the online stamp is untouched. */
await state({ id: 'd-late-uber', name: 'Late On Uber' });
await ev('d-late-uber', `${DAY}T09:30:00+04:00`, 'ONLINE');
await trip('uber', 'd-late-uber', 'Late On Uber', `${DAY}T10:40:00+04:00`);

/* FMS ONLY. A telematics feed watches cars; a GPS journey is not somebody
   being given a job, and must not clear anybody. */
await state({ id: 'd-fms', name: 'Tracker Only' });
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
           requested_at, distance_km, status)
         VALUES ('fms','ocfms','ecosine','L9','d-fms','Tracker Only',$1::timestamptz,10,'completed')`,
  [`${DAY}T05:00:00+04:00`]);

const app = express();
onlineRoutes(app, { q, wrap: (fn) => (rq, rs) => Promise.resolve(fn(rq, rs)).catch((e) => {
  rs.status(500).json({ error: String(e) }); }) });
const server = app.listen(0);
const port = server.address().port;
const get = async (qs) => (await fetch(`http://127.0.0.1:${port}/api/online-time?${qs}`)).json();

const body = await get(`day=${DAY}&start=08:00`);
const row = (name) => body.rows.find((r) => r.name === name);

/* ── a driving person is never told they cannot work ────────────────────── */
{
  const r = row('Joseph Wandera');
  check('a driver with no Uber timeline but hotel jobs is not filed under "cannot earn"',
    r?.online_basis === 'worked_elsewhere', r?.online_basis);
  check('and the sentence names the channel in words, not as a database key',
    /Hotel/.test(r.online_why) && !/\bhotel\b/.test(r.online_why), r.online_why);
  check('…and says the first trip time and why it bounds the online moment',
    /06:19/.test(r.online_why) && /cannot be given to a driver who is not/.test(r.online_why));
}

/* ── the generous half of the rule ──────────────────────────────────────── */
{
  const r = row('Joseph Wandera');
  check('driving before the start time counts as on time',
    r.late === false, JSON.stringify([r.late, r.worked_first_local]));
  check('and the row says the verdict came from a trip, not from a timeline',
    r.judged_by === 'first_trip', r.judged_by);
  check('with no minutes figure, because a bound is not a measurement',
    r.minutes_late === null, String(r.minutes_late));
  check('the first-trip column carries the channel it happened on',
    r.worked_first_platform === 'hotel' && r.worked_first_local === '06:19'
      && r.worked_trips === 3, JSON.stringify([r.worked_first_platform, r.worked_first_local, r.worked_trips]));
}

/* ── the half that must NEVER accuse ────────────────────────────────────── */
{
  const r = row('Majid Shah');
  check('a first trip AFTER the start time does not make anybody late',
    r.late === null, JSON.stringify([r.late, r.worked_first_local]));
  check('and the row says so in words rather than leaving it to be inferred',
    /does not make them late/.test(r.online_why), r.online_why);
  check('they are still counted as having driven, which is the actionable part',
    r.worked_trips === 1 && body.totals.unjudged_but_worked === 1,
    JSON.stringify([r.worked_trips, body.totals.unjudged_but_worked]));
}

/* ── absence stays absence ──────────────────────────────────────────────── */
check('a driver who took no booking anywhere is still "not asked", not cleared',
  row('Nobody Drove')?.online_basis === 'not_asked' && row('Nobody Drove')?.late === null,
  row('Nobody Drove')?.online_basis);
check('a telematics journey is not evidence that somebody was given work',
  row('Tracker Only')?.online_basis === 'not_asked'
    && row('Tracker Only')?.worked_trips === 0,
  JSON.stringify([row('Tracker Only')?.online_basis, row('Tracker Only')?.worked_trips]));

/* ── the online stamp still governs where it exists ─────────────────────── */
{
  const r = row('Late On Uber');
  check('an Uber online event still decides the verdict, and still marks late',
    r.late === true && r.minutes_late === 90 && r.judged_by === 'online',
    JSON.stringify([r.late, r.minutes_late, r.judged_by]));
}

/* ── the totals a reader sees ───────────────────────────────────────────── */
check('the two strengths of "on time" are counted apart',
  body.totals.on_time === 1 && body.totals.on_time_by_trip === 1,
  JSON.stringify(body.totals));
check('and "drove" counts every channel, not only Uber',
  body.totals.worked === 3 && body.totals.drove === 1,
  JSON.stringify([body.totals.worked, body.totals.drove]));

/* ── the source, because the Uber-only filter is the thing that regressed ─ */
{
  const src = readFileSync('api/online_routes.js', 'utf8');
  check('the evidence aggregate reads every booking channel',
    /WHERE platform <> 'fms'/.test(src));
  check('while the aggregate that decides "awaiting feed" stays Uber-only',
    /WHERE platform = 'uber'/.test(src));
  check('and the channel is named from one shared map rather than a fourth copy',
    /from '\.\.\/src\/channels\.js'/.test(src));
}

/* ── the page must not describe itself as Uber-only any more ─────────────
   The shell prints a view's one-line description from the VIEWS register, and
   it said "when each driver came online on Uber" over a page that now clears
   people on the strength of a hotel job. A subtitle is a claim like any other
   figure on the screen. */
{
  const app = readFileSync('api/public/app.js', 'utf8');
  const sub = (app.match(/id: 'online-time'[^}]*?sub: '([^']+)'/) || [])[1] || '';
  check('the view description says the page reads more than Uber',
    /another channel/.test(sub), sub);
}

/* ── the grey caption must add up to the grey figure ─────────────────────
   The tile prints "N cannot be judged" with a breakdown under it. That
   breakdown was built from the flat per-basis totals, which count every row of
   a basis whether judged or not — fine while no basis could ever be judged,
   and wrong the moment one could. A driver cleared by a trip keeps the basis
   that explains their missing online stamp while moving into "on time", and
   the caption started naming 4 states under a figure of 5. */
{
  const b = body.totals.unjudged_by_basis;
  check('the grey breakdown is counted over the grey rows, so it sums to the grey figure',
    Object.values(b).reduce((a, n) => a + n, 0) === body.totals.unjudged,
    JSON.stringify([b, body.totals.unjudged]));
  check('and a driver cleared by a trip is not counted among them',
    b.worked_elsewhere === 1 && body.totals.worked_elsewhere === 2,
    JSON.stringify([b.worked_elsewhere, body.totals.worked_elsewhere]));
  const page = readFileSync('api/public/onlinetime.js', 'utf8');
  check('and the page builds that caption from it rather than from the flat totals',
    /unjudged_by_basis \|\| \{\}/.test(page) && !/fmt\(t\.already_online\) *\} already on/.test(page));
}

/* ── the mock must be able to produce only shapes the endpoint can ───────
   mockapi.mjs is what the browser smoke run renders, so a fixture whose shape
   the real endpoint cannot produce green-lights a page that is wrong about
   real data. It was: the mock emitted a `cannot_earn` row carrying six hotel
   trips — the exact sentence this change exists to delete, rendered on screen
   in a passing test run. Found by looking at the page, not by reading it. */
{
  const mock = readFileSync('mockapi.mjs', 'utf8');
  check('the mock gives no trips to a driver it files as unable to take work',
    /basis === 'not_asked' \|\| basis === 'cannot_earn' \? null/.test(mock));
  /* And its "drove early" row has to land before the page's own default start,
     or the green chip this whole change produces never renders in the smoke
     run. The default lives in the page; both are read here so they cannot
     drift apart silently. */
  const page = readFileSync('api/public/onlinetime.js', 'utf8');
  const dflt = (page.match(/start = [^;]*?'(\d\d:\d\d)'/) || [])[1];
  const early = Number((mock.match(/\? (\d+) *\/\/ *\d\d:\d\d — drove, before the start/) || [])[1]);
  const dfltMin = dflt ? Number(dflt.slice(0, 2)) * 60 + Number(dflt.slice(3)) : null;
  check('and its early driver starts before the page default, so the cleared state renders',
    dfltMin != null && Number.isFinite(early) && early < dfltMin,
    `mock ${early} vs page default ${dflt}`);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
