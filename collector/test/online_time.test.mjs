/* Who came online when — and the four different reasons somebody has no time.
   ──────────────────────────────────────────────────────────────────────────
   This page produces a call list. A driver on it gets a phone call, so a gap in
   COLLECTION must never render as a gap in ATTENDANCE — the operator said so
   before the page existed: "sometimes we get uberX trips but it doesn't show
   the driver going online on uber … or else it will be inaccurate data that the
   operations team will work on."

   Measured on production 2026-09-09, there are four reasons and only one is
   about the driver. Each has a fixture here, and the assertions are about which
   sentence each one gets, because the sentence is the whole product. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { onlineRoutes, startMinutes } from '../api/online_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

const DAY = '2026-08-14';
const state = (o) => q(
  `INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state,
     state_raw, can_earn, plate)
   VALUES ($1,$2,'ecosine',$3,'active','ACTIVE',$4,$5)`,
  [o.platform || 'uber', o.id, o.name, o.canEarn ?? true, o.plate ?? null]);

let tn = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, distance_km, status, price)
   VALUES ('uber',$1,'ecosine',$2,$3,$4,$5::timestamptz,10,'completed',40)`,
  [`ot${tn++}`, o.plate ?? null, o.id, o.name, o.at]);

const ev = (o) => q(
  `INSERT INTO driver_timeline_event (platform, driver_ext_id, fleet_id, at, kind, status, state)
   VALUES ('uber',$1,'ecosine',$2::timestamptz,'status',$3,'')`,
  [o.id, o.at, o.status]);

/* ── ONE: reported. An ONLINE transition on the day, and a car with a fix
      beside it so the place column has something to name. */
await state({ id: 'd-rep', name: 'Rida Aslam', plate: 'L100' });
await ev({ id: 'd-rep', at: `${DAY}T06:12:00+04:00`, status: 'ONLINE' });
await ev({ id: 'd-rep', at: `${DAY}T14:00:00+04:00`, status: 'OFFLINE' });
await trip({ id: 'd-rep', name: 'Rida Aslam', plate: 'L100', at: `${DAY}T07:30:00+04:00` });
await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, driver_name, platform,
           trips, km, revenue, is_primary)
         VALUES ('L100',$1::date,'d-rep','Rida Aslam','uber',1,10,40,true)`, [DAY]);
await q(`INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, lat, lng, speed)
         VALUES ('fms','L100','ecosine',$1::timestamptz,25.1,55.2,0)`, [`${DAY}T06:14:00+04:00`]);
await q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations)
         VALUES (5020, 11040, 'Deira', 412, 3, 430)`);
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, phone)
         VALUES ('uber','d-rep','ecosine','Rida Aslam','+9715012345')`);

/* ── TWO: already online. A span opened the evening before and never closed
      inside this day. The clipped 00:00 is NOT a start time. */
await state({ id: 'd-mid', name: 'Bilal Noor', plate: 'L200' });
await ev({ id: 'd-mid', at: `2026-08-13T21:00:00+04:00`, status: 'ONLINE' });
await ev({ id: 'd-mid', at: `${DAY}T09:00:00+04:00`, status: 'OFFLINE' });
await trip({ id: 'd-mid', name: 'Bilal Noor', plate: 'L200', at: `${DAY}T02:00:00+04:00` });

/* ── THREE: awaiting feed. Trips today, no online event — the three-hourly
      timeline against the half-hourly trip pull. */
await state({ id: 'd-lag', name: 'Sana Iqbal', plate: 'L300' });
await trip({ id: 'd-lag', name: 'Sana Iqbal', plate: 'L300', at: `${DAY}T06:30:00+04:00` });

/* ── FOUR: not asked. No trip in the two-day window, so the collector never
      requested this person from Uber at all. */
await state({ id: 'd-cold', name: 'Omar Farid', plate: 'L400' });
/* …and their other portal, so the row can prove the fold reaches it. */
await state({ platform: 'hotel', id: 'd-cold', name: 'Omar Farid', canEarn: true });

/* A trip three days back: outside the two-day window, so still never asked. */
await trip({ id: 'd-cold', name: 'Omar Farid', plate: 'L400', at: `2026-08-11T08:00:00+04:00` });

/* ── FIVE: drove, but Uber has dropped them from the supplier roster.
      ────────────────────────────────────────────────────────────────────────
      api/roster_routes.js records 395 people built from trips against 338 on
      the roster, and the reason: "Uber drops a driver from the supplier roster
      when their account is deactivated." src/sources/uber_timeline.js:206-210
      picks who to ask from `trip`, NOT from the roster — so Uber IS asked about
      this person and DOES return their online events. Only this page could not
      see them, because it took the Uber ids from driver_platform_state alone
      and this person has no row there: uber_ids came back empty, the timeline
      lookup had nothing to look up, and a driver who came online at 09:30
      against a 06:00 start rendered "no online event has arrived for the day
      yet … it is not evidence about the driver", permanently, every day.

      That is the exact failure the operator described before the page existed
      and the exact failure the file header forbids: a gap in COLLECTION shown
      as a gap in ATTENDANCE. It does not self-heal, and it drops the phone
      call the page exists to produce. */
await trip({ id: 'd-off', name: 'Kabir Rahman', plate: 'L500', at: `${DAY}T10:10:00+04:00` });
await ev({ id: 'd-off', at: `${DAY}T09:30:00+04:00`, status: 'ONLINE' });

/* ── SIX: nobody named this account.
      person_key is generated from the name, so a blank name folds to the EMPTY
      STRING, not to NULL. Every other reader in the product excludes it —
      sql/schema_v20.sql:33-34 and every index in sql/schema_v53.sql are partial
      on `person_key IS NOT NULL AND person_key <> ''`, and the schema says why:
      "an empty key must never become the bucket every anonymous row falls
      into." Two unnamed accounts here, and they must stay two rows. */
await state({ id: 'd-anon1', name: '', plate: 'L600' });
await state({ id: 'd-anon2', name: '', plate: 'L700' });
await ev({ id: 'd-anon1', at: `${DAY}T05:00:00+04:00`, status: 'ONLINE' });
await trip({ id: 'd-anon1', name: '', plate: 'L600', at: `${DAY}T05:30:00+04:00` });
await trip({ id: 'd-anon2', name: '', plate: 'L700', at: `${DAY}T11:00:00+04:00` });

/* ── SEVEN and EIGHT: the two sides of the ask-window, one Dubai evening apart.
      ────────────────────────────────────────────────────────────────────────
      These decide which of two OPPOSITE sentences a driver with no online
      event gets. `absent` asserts Uber was asked and had nothing; `not_asked`
      asserts we hold no evidence. The window has to be the collector's own.

      src/run.js:407-411 anchors each tick on the instant it wakes — to = now,
      from = now - 2 days — and src/sources/uber_timeline.js:206-210 uses that
      same pair to choose who to ask AND to bound what it fetches. Written as
      three whole Dubai days (BETWEEN day - 2 AND day) it was up to 24 hours
      too generous, and the error ran the wrong way: d-early's last trip, at
      20:00 on the 12th, falls on Dubai date 08-12 and so counted as "asked"
      about the 14th — a day no tick ever fetched for them.

      d-warm's trip is inside the real 48 hours and is genuinely covered. */
await state({ id: 'd-warm', name: 'Hina Sethi', plate: 'L800' });
await trip({ id: 'd-warm', name: 'Hina Sethi', plate: 'L800', at: `2026-08-13T10:00:00+04:00` });

await state({ id: 'd-early', name: 'Tariq Javed', plate: 'L900' });
await trip({ id: 'd-early', name: 'Tariq Javed', plate: 'L900', at: `2026-08-12T20:00:00+04:00` });

/* ── NINE: a standing that cannot take work at all.
      ────────────────────────────────────────────────────────────────────────
      Found on production rather than designed: of 157 people holding an Uber
      account on 2026-09-09, 30 held one that cannot earn — suspended,
      deactivated, waitlisted. They fell into `not_asked` and sat in the call
      list, which is the operator's own stated failure mode: "or else it will
      be inaccurate data that the operations team will work on." Phoning a
      deactivated driver to ask why they did not come online is that call. */
await q(
  `INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state,
     state_raw, can_earn, plate)
   VALUES ('uber','d-susp','ecosine','Faisal Rehman','suspended','SUSPENDED',false,'L1000')`);

await q(`INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, finished_at)
         VALUES ('uber_timeline','ecosine','timeline','ok',10,$1::timestamptz)`,
[`${DAY}T06:17:00+00:00`]);

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
onlineRoutes(app, { q, wrap });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json() }; };

const d = (await get(`/api/online-time?day=${DAY}&start=06:00`)).body;
const row = (name) => d.rows.find((r) => r.name === name);

console.log('\nthe four reasons a driver has no online time');
const rep = row('Rida Aslam');
check('a recorded transition is the answer, and it is the time Uber recorded',
  rep?.online_basis === 'reported' && rep.online_local === '06:12', JSON.stringify(rep?.online_local));

const mid = row('Bilal Noor');
check('a driver already online at midnight is not reported as starting at 00:00',
  mid?.online_basis === 'already_online' && mid.online_local === null,
  `${mid?.online_basis} / ${mid?.online_local}`);
check('…and the row says the shift began before the day did',
  /already online when the day began/.test(mid?.online_why || ''), mid?.online_why);

const lag = row('Sana Iqbal');
check('a driver with a trip and no event yet is awaiting the feed, not absent',
  lag?.online_basis === 'awaiting_feed' && lag.trips === 1, lag?.online_basis);
check('…and the row blames the two clocks rather than the driver',
  /different clocks/.test(lag?.online_why || '')
  && /not evidence about the driver/.test(lag?.online_why || ''), lag?.online_why);

const cold = row('Omar Farid');
check('a driver nobody asked Uber about is NOT reported as never coming online',
  cold?.online_basis === 'not_asked', cold?.online_basis);
check('…and the row says we hold no evidence either way',
  /never asked about this driver/.test(cold?.online_why || '')
  && /no evidence either way/.test(cold?.online_why || ''), cold?.online_why);

console.log('\nthe verdict, and what may never produce one');
check('the reader’s start time decides late, and only for a reported time',
  rep.late === true && rep.minutes_late === 12, JSON.stringify([rep.late, rep.minutes_late]));
check('nobody without a reported time is judged at all',
  [mid, lag, cold].every((r) => r.late === null && r.minutes_late === null),
  JSON.stringify([mid.late, lag.late, cold.late]));
/* The first trip is an UPPER bound — a trip is necessarily after going online,
   by a median 68 to 73 minutes on production. It is evidence, never a verdict. */
check('the first trip is carried as evidence',
  lag.first_trip_local === '06:30' && rep.first_trip_local === '07:30',
  JSON.stringify([lag.first_trip_local, rep.first_trip_local]));
check('…and never colours anyone late by itself',
  lag.late === null, 'a first trip is an upper bound and a lateness verdict built on it is too kind');

console.log('\nwhat operations needs beside the time');
check('the phone number is on the row, so somebody can be called',
  rep.phone === '+9715012345', String(rep.phone));
check('the car they held that day, labelled as held',
  rep.plate === 'L100' && rep.plate_basis === 'held that day', JSON.stringify([rep.plate, rep.plate_basis]));
check('a roster-attached car is labelled as NOT a car we saw them drive',
  /not a car we saw them drive today/.test(cold.plate_basis || ''), cold.plate_basis);
check('where the car was when they came online, named and timed',
  rep.where?.area === 'Deira' && rep.where.within_min <= 30 && rep.where.votes === 412,
  JSON.stringify(rep.where));
check('every portal the person holds, folded across their accounts',
  cold.portals.includes('uber') && cold.portals.includes('hotel'), JSON.stringify(cold.portals));

console.log('\nthe page as a whole');
/* Ten fixtures: four roster people (reported, already-online, awaiting,
   never-asked), one who drove with no roster row at all, two unnamed accounts
   that must not merge, the two sides of the ask-window, and one standing that
   cannot take work. Six of the ten drove on the day; the other four are
   precisely the ones with no trip, which is what makes them interesting. */
check('everyone we hold an Uber account for is on it, not only those who drove',
  d.totals.people === 10 && d.totals.drove === 6, JSON.stringify(d.totals));
check('the totals name each reason rather than lumping them as missing',
  d.totals.reported === 3 && d.totals.already_online === 1
  && d.totals.awaiting_feed === 2 && d.totals.not_asked === 2
  && d.totals.cannot_earn === 1 && d.totals.absent === 1, JSON.stringify(d.totals));
check('and the counted verdict matches the rows',
  d.totals.late === 2 && d.totals.on_time === 1 && d.totals.unjudged === 7,
  JSON.stringify(d.totals));
check('…and every person carries exactly one of the six reasons',
  d.totals.reported + d.totals.already_online + d.totals.awaiting_feed
  + d.totals.not_asked + d.totals.cannot_earn + d.totals.absent === d.totals.people,
  JSON.stringify(d.totals));
check('…and the three counts partition the page, leaving nobody unaccounted for',
  d.totals.late + d.totals.on_time + d.totals.unjudged === d.totals.people,
  JSON.stringify(d.totals));
check('the feed says when it last ran, so "awaiting" can be checked',
  d.feed.last_run_at != null && /every three hours/.test(d.feed.note));

console.log('\na person Uber knows about but the roster does not');
const off = d.rows.find((r) => (r.uber_ids || []).includes('d-off'));
check('someone who drove is on the page even with no roster row', off != null,
  JSON.stringify(d.rows.map((r) => r.uber_ids)));
check('…and their ONLINE event is found, because the collector asks by trip not by roster',
  off?.online_basis === 'reported' && off.online_local === '09:30',
  `${off?.online_basis} / ${off?.online_local}`);
check('…so they are judged late rather than excused as "awaiting feed"',
  off?.late === true && off?.minutes_late === 210,
  `${off?.late} / ${off?.minutes_late}`);

console.log('\nan account nobody named keys on itself, never on the empty string');
const anon = d.rows.filter((r) => (r.uber_ids || []).some((x) => x.startsWith('d-anon')));
check('two unnamed accounts are two rows, not one merged ghost',
  anon.length === 2, JSON.stringify(anon.map((r) => r.uber_ids)));
check('…and each keeps its own online time rather than the earliest of the pool',
  anon.every((r) => r.uber_ids.length === 1)
  && anon.find((r) => r.uber_ids[0] === 'd-anon1')?.online_local === '05:00'
  && anon.find((r) => r.uber_ids[0] === 'd-anon2')?.online_basis !== 'reported',
  JSON.stringify(anon.map((r) => [r.uber_ids[0], r.online_basis, r.online_local])));
check('…and each keeps its own car',
  anon.find((r) => r.uber_ids[0] === 'd-anon1')?.plate === 'L600'
  && anon.find((r) => r.uber_ids[0] === 'd-anon2')?.plate === 'L700',
  JSON.stringify(anon.map((r) => r.plate)));

console.log('\na standing that cannot take work is not a driver who is late');
const susp = row('Faisal Rehman');
check('a suspended account gets its own reason, not "nobody asked"',
  susp?.online_basis === 'cannot_earn', susp?.online_basis);
check('…worded in English rather than in Uber\'s enum',
  /Uber has suspended this account/.test(susp?.online_why || ''), susp?.online_why);
check('…and says what to do about it, because that is the point of the state',
  /not about the morning/.test(susp?.online_why || ''), susp?.online_why);
check('…without saying the same clause twice, which a shared tail did',
  !/(coming online).*\1/is.test(susp?.online_why || ''), susp?.online_why);
check('…and it is never late, whatever the start time',
  susp?.late === null && susp?.online_at === null,
  `${susp?.late} / ${susp?.online_at}`);
check('the Drove denominator excludes them, so the fleet does not read a third idler',
  /of \$\{fmt\(t\.people - \(t\.cannot_earn \|\| 0\)\)\} allowed to take work/
    .test(await (await import('node:fs')).promises.readFile(
      new URL('../api/public/onlinetime.js', import.meta.url), 'utf8')));

/* The four standings production actually returns, measured 2026-09-09: 21
   waitlisted, 6 rejected, 2 accepted, 1 applied. All four are onboarding
   states rather than suspensions, and they mean different things to whoever
   reads the row — an application Uber turned down is not a person who has
   simply not started. */
{
  const { standingWords } = await import('../api/online_routes.js');
  const { normaliseState } = await import('../src/roster.js');
  const RAW = ['ONBOARDING_STATUS_WAITLISTED_AUTO_REACTIVATION', 'ONBOARDING_STATUS_REJECTED',
    'ONBOARDING_STATUS_ACCEPTED', 'ONBOARDING_STATUS_APPLIED'];
  const said = RAW.map((r) => standingWords(normaliseState(r), r));
  check('no standing reaches the reader as a database key',
    said.every((w) => !/_/.test(w) && !/onboarding_status/i.test(w)), JSON.stringify(said));
  check('a rejected application does not read as one still in progress',
    /turned this application down/.test(said[1]) && !/being onboarded/.test(said[1]), said[1]);
  check('…and every standing ends by saying what to do about it',
    said.every((w) => /chase|call list|call worth/.test(w)), JSON.stringify(said));
  check('…and none of them says the same clause twice',
    said.every((w) => !/(coming online).*\1/is.test(w)), JSON.stringify(said));
  check('…and the waitlist is not called a suspension',
    /on its waitlist/.test(said[0]), said[0]);
  check('an unrecognised standing shows the provider\'s word, tidied, not a guess',
    /^Uber has this account as "not a real state", which does not permit/
      .test(standingWords(normaliseState('NOT_A_REAL_STATE'), 'NOT_A_REAL_STATE')),
    standingWords(normaliseState('NOT_A_REAL_STATE'), 'NOT_A_REAL_STATE'));
  check('…and with neither word we say only what is true',
    /^Uber does not currently permit this account to take work\./.test(standingWords(null, null)),
    standingWords(null, null));
}

console.log('\nasked, or not asked, in the units the collector actually uses');
const warm = row('Hina Sethi');
check('a trip inside the real 48 hours means the day WAS fetched',
  warm?.online_basis === 'absent', warm?.online_basis);
check('…and that row is the only one allowed to say Uber was asked and had nothing',
  /asked about this driver and returned no online event/.test(warm?.online_why || ''),
  warm?.online_why);
const early = row('Tariq Javed');
check('a trip 52 hours out is NOT proof the day was fetched, even on a Dubai date inside day-2',
  early?.online_basis === 'not_asked', early?.online_basis);
check('…so it says we hold no evidence rather than asserting a no-show',
  /never asked/.test(early?.online_why || '')
  && !/returned no online event/.test(early?.online_why || ''), early?.online_why);

console.log('\nthe timeline query is answerable from an index');
{
  const src = (await import('node:fs')).readFileSync(
    new URL('../api/online_routes.js', import.meta.url), 'utf8');
  check('the span scan binds driver_ext_id, which is what dte_driver_at_idx leads on',
    /FROM driver_timeline_event\s+WHERE driver_ext_id = ANY\(/.test(src),
    'sql/schema_v37.sql:56 indexes (driver_ext_id, at); bounding `at` alone scans the '
    + 'whole table on every request — api/driver_routes.js:2261 runs the same CTE with '
    + 'the id bound, and test/indexes.test.mjs excuses it on exactly that ground');
  check('the cell size is imported rather than retyped a third time',
    !/round\(s\.lat \/ 0\.005\)/.test(src),
    'api/place_sql.js:19 names api/driver_routes.js:2299 as the one existing literal '
    + 'and says a second is a second place to get it wrong');
  /* Asserted on what the comment SAYS rather than on the absence of the old
     wording — the fix quotes the old wording while explaining it, so a lint
     written as "the old sentence is gone" fails against the corrected file. */
  check('the sort comment describes the sort it sits above',
    /LATEST FIRST, and everyone we cannot judge after everyone we can/.test(src),
    'the sort is online_minute DESC, which puts the LATEST sign-on first; the '
    + 'comment above it read "Late last, on-time first"');
}

console.log('\nthe start time itself');
check('a start time is read as Dubai minutes', startMinutes('06:30') === 390 && startMinutes('00:00') === 0);
check('…and a start time nobody can parse is refused, never coerced to midnight',
  startMinutes('half seven') === null && startMinutes('25:00') === null && startMinutes('') === null,
  'coercing an unparseable start to 00:00 marks the whole fleet late');
{
  const none = (await get(`/api/online-time?day=${DAY}`)).body;
  check('with no start time nobody is judged',
    none.rows.every((r) => r.late === null) && none.expected_start === null);
  check('…and the page says so rather than showing two silent zeroes',
    /No start time was set/.test(none.start_why || ''), none.start_why);
  check('…and holds back the counts entirely, so no tile can render 0 late',
    none.totals.late === undefined && none.totals.on_time === undefined,
    JSON.stringify(none.totals));
  const junk = (await get(`/api/online-time?day=${DAY}&start=half%20seven`)).body;
  check('a start time nobody can read is absent WITH A REASON, and names what it got',
    junk.expected_start === null && /"half seven" is not a time/.test(junk.start_why || ''),
    junk.start_why);
  check('…which is a different sentence from "you set none", because it is a different problem',
    junk.start_why !== none.start_why);
  const bad = await get('/api/online-time?day=14-08-2026');
  check('a day that is not a day is refused with a 400', bad.status === 400, String(bad.status));
}

server.close();

/* ── the two shells, read as source ──────────────────────────────────────
   Both the desktop page and the phone screen render this endpoint, and every
   assertion above is about the endpoint. What is left is the pair of ways the
   two shells can disagree with each other or with the endpoint, and each of
   these pinned a defect that shipped into the working tree and rendered
   convincingly before it was caught. */
const { readFileSync } = await import('node:fs');
const desk = readFileSync(new URL('../api/public/onlinetime.js', import.meta.url), 'utf8');
const phone = readFileSync(new URL('../api/public/m/screens.js', import.meta.url), 'utf8');

console.log('\nthe phone screen is a real screen, not the desktop hand-off');
check('the route table has a screen for it',
  /'online-time': onlineTime,/.test(phone),
  'without this the call list falls to "built for a bigger screen" — on the one '
  + 'page whose action is a phone call, read by somebody holding a phone');
check('its rows dial rather than drill',
  /to: r\.phone \? `tel:\$\{String\(r\.phone\)\.replace/.test(phone));
check('and it says so, because a chevron that dials is a surprise',
  /Tap a row to call/.test(phone));
check('the query string is built by q(), not glued onto the path',
  /q\('\/api\/online-time', \{ day, start \}\)/.test(phone)
  && !/q\(`\/api\/online-time\?/.test(phone),
  'q(path, extra) appends its own `?...`; a path carrying one produced '
  + '`?day=..&start=..?from=..`, start failed validation, and the screen judged nobody');

console.log('\nneither shell prints a verdict it does not have');
check('the desktop holds the tiles back rather than rendering 0 late',
  /const judged = d\.expected_start != null;/.test(desk)
  && /value: judged \? fmt\(t\.late \?\? 0\) : '—'/.test(desk),
  '`fmt(t.late ?? 0)` printed a bold 0 under "Late" on a morning whose start '
  + 'time could not be read — absent rendered as a measurement of zero');
check('and the phone lede does not claim nobody is late',
  /claim: !judged \? 'Nobody can be judged yet'/.test(phone));
check('…nor does its empty call list, which had two opposite causes and one sentence',
  /judged \? `Everyone measured on \$\{d\.day\} was online by \$\{d\.expected_start\}\.`/.test(phone)
  && !/^\s*\? `Everyone measured on/m.test(phone),
  'it read "Everyone measured on 2026-09-09 was online by null" when the start '
  + 'time could not be read — a no-lateness claim over a day nothing was judged on');
check('both surface the endpoint\'s own sentence rather than inventing one',
  /d\.start_why \|\| 'No start time is set\.'/.test(desk)
  && /\(d\.start_why \|\| 'No start time is set\.'\)/.test(phone));

check('and the grey breakdown adds up to the figure it sits under, in both states',
  /everyone, for want of a start time/.test(desk),
  'the sub named three grey states under a figure of eight, because with no '
  + 'start time every person is unjudged and not only the grey ones');

console.log('\nthe two shells cannot drift apart on the words');
check('the grey states are exported from one place',
  /export const GREY = \{/.test(desk));
check('…and the phone imports them rather than retyping them',
  /import \{ GREY \} from '\.\.\/onlinetime\.js';/.test(phone));

console.log('\nno reason is printed over a row it is not about');
check('the phone prints one line per DISTINCT state, keyed on the state itself',
  /const reasons = new Map\(\);/.test(phone)
  && /reasons\.set\(r\.online_basis, r\.online_why\)/.test(phone)
  && !/d\.rows\.find\(\(r\) => r\.late == null\)\?\.online_why/.test(phone),
  'printing the first grey row\'s reason under a list of three states put a '
  + 'sentence about "never asked" under two drivers it was not about');

console.log('\nthe call list is ordered worst-first in both shells');
check('the phone sorts by how far behind, absences last',
  /const worstFirst = \(a, b\) => \(b\.minutes_late \?\? -Infinity\) - \(a\.minutes_late \?\? -Infinity\);/
    .test(phone));
check('and the desktop caption agrees with the desktop sort',
  /Latest first, so the call list is the top of this table/.test(desk)
  && /defaultSort: \{ key: 'online_minute', dir: 'desc' \}/.test(desk),
  '"Late last" described the opposite of the sort it sat above');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
