/* A finding that names a count must be able to name the people.
   ═══════════════════════════════════════════════════════════════════════════
   The most severe row this product raises reads "10 drivers were online but
   completed no trips", and its action — "check whether they were genuinely
   available" — is a phone call. On 2026-09-07 the page rendered the sentence
   and nothing else: `grep '\.refs' api/public/*.js` returned no hits, so the
   ids the rule engine had been storing since sql/schema_v31.sql and the API had
   been serving ever since reached the browser and were dropped.

   api/insight_people.js resolves those ids. This exercises the resolution
   against a real Postgres, because the failure mode that matters here is a SQL
   error: the join is nine LATERALs over six tables, it runs inside the
   /api/insights handler behind a try/catch that must not swallow a mistake
   silently, and no amount of string-matching the source would catch a column
   that does not exist. PGlite runs the shipped schema, the shipped query, and
   asks what came back.

   The assertion this file exists for is the un-clipped shift. Every other span
   query in the product clips to the Dubai day, so a shift opened at 23:43 the
   night before reads 00:00 — and "went online at midnight" is a plausible
   sentence that starts the wrong conversation with the wrong person. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { refIds, peopleFor, attachPeople } from '../api/insight_people.js';
import { photoHref } from '../api/redact.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

/* Two people and one ghost.
   AMIR opened his shift at 23:43 Dubai the night before the finding's day and
   was still online when it was computed — the case the whole file is about.
   NOOR logged in inside the day, has no phone number on file, and last
   completed a trip three weeks ago. GHOST is an id the rule saw and no other
   table has ever heard of, which is the case that decides whether the page can
   say "we hold nothing about this account" or renders an empty card. */
const AMIR = '11111111-1111-4111-8111-111111111111';
const NOOR = '22222222-2222-4222-8222-222222222222';
const GHOST = '33333333-3333-4333-8333-333333333333';
const DAY = '2026-09-06';

await db.exec(`INSERT INTO fleet (id, name) VALUES ('ecosine', 'Ecosine') ON CONFLICT DO NOTHING`);
await q(
  `INSERT INTO driver_compliance (platform, driver_ext_id, full_name, phone, email, rating, updated_at)
   VALUES ('uber', $1, 'Amir Rahman', '+971500000001', 'amir@example.test', 4.91, now()),
          ('uber', $2, 'Noor Hassan',  NULL,           NULL,                4.62, now())`,
  [AMIR, NOOR]);
await q(
  `INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state, state_raw,
                                      plate, can_earn, rating, lifetime_trips, is_banned, observed_at)
   VALUES ('uber', $1, 'ecosine', 'Amir Rahman', 'active', 'ACTIVE', 'L27045', true, 4.91, 6406, false, now()),
          ('uber', $2, 'ecosine', 'Noor Hassan', 'active', 'ACTIVE', NULL,     true, 4.62,  318, false, now())`,
  [AMIR, NOOR]);
await q(`INSERT INTO driver_photo (platform, driver_ext_id, bytes, byte_len, sha256, content_type, fetched_at)
         VALUES ('uber', $1, '\\x00'::bytea, 1, repeat('a', 64), 'image/jpeg', now())`, [AMIR]);
await q(`INSERT INTO driver_photo_miss (platform, driver_ext_id, reason, source_host, tried_at)
         VALUES ('uber', $1, 'the host answered 403', 'tb-static.uber.com', now())`, [NOOR]);

/* The timeline, in UTC. Dubai is UTC+4, so 23:43 Dubai on the 5th is 19:43Z. */
await q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status)
   VALUES ('uber','ecosine',$1,'2026-09-05T19:43:00Z','status','ONLINE'),
          ('uber','ecosine',$2,'2026-09-06T05:00:00Z','status','ONLINE'),
          ('uber','ecosine',$2,'2026-09-06T07:00:00Z','status','OFFLINE')`,
  [AMIR, NOOR]);

/* One completed trip each, long enough ago that "when did they last work" has
   a different answer from "did they work today". */
await q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, ended_at, dropoff_addr, status)
   VALUES ('uber','t-amir','ecosine','L27045',$1,'Amir Rahman',
           '2026-09-04T09:00:00Z','2026-09-04T09:30:00Z','Dubai Marina','completed'),
          ('uber','t-noor','ecosine','L31200',$2,'Noor Hassan',
           '2026-08-16T09:00:00Z','2026-08-16T09:20:00Z','Al Garhoud','completed')`,
  [AMIR, NOOR]);

/* ── refIds ─────────────────────────────────────────────────────────────── */
const findings = [
  { code: 'drivers_online_no_trips',
    refs: [{ driver_ext_id: AMIR, hours_online: 6.3 }, { driver_ext_id: NOOR, hours_online: 2 },
      { driver_ext_id: GHOST, hours_online: 1 }, { driver_ext_id: AMIR, hours_online: 6.3 }] },
  { code: 'idle_vehicle', refs: null },
  /* A ref shape that names no person. A rule writing refs about vehicles must
     get no enrichment rather than a wrong one. */
  { code: 'some_future_rule', refs: [{ plate: 'L27045' }] },
];
const ids = refIds(findings);
check('every id a finding names is collected', ids.includes(AMIR) && ids.includes(NOOR) && ids.includes(GHOST),
  JSON.stringify(ids));
check('…exactly once, however many refs repeat it', ids.length === 3, JSON.stringify(ids));
check('…and a ref about something other than a person contributes none',
  !ids.some((i) => i === 'L27045'), JSON.stringify(ids));
check('a finding with no refs at all costs nothing', refIds([{ code: 'x', refs: null }]).length === 0);

/* ── the query ──────────────────────────────────────────────────────────── */
let people = [];
let threw = null;
try { people = await peopleFor(q, ids, { from: `${DAY}T00:00:00Z`, to: `${DAY}T00:00:00Z` }); }
catch (e) { threw = e; }
check('the resolution query runs against the shipped schema', !threw, String(threw?.message || '').slice(0, 200));
if (threw) { console.log(`\n  ${pass} passed, ${fail} failed`); process.exit(1); }

const by = new Map(people.map((p) => [p.driver_ext_id, p]));
check('every id the finding named comes back, known or not', people.length === 3, `${people.length} rows`);
check('…including one no other table has heard of, so the page can say so',
  by.has(GHOST), [...by.keys()].join(','));

const amir = by.get(AMIR), noor = by.get(NOOR), ghost = by.get(GHOST);
check('a driver is resolved to a name', amir?.full_name === 'Amir Rahman', JSON.stringify(amir?.full_name));
check('…and to a phone number, which is the point of the page',
  amir?.phone === '+971500000001', JSON.stringify(amir?.phone));
check('…and the vehicle they are holding', amir?.state_plate === 'L27045', JSON.stringify(amir?.state_plate));
check('…and what the platform says about their standing',
  amir?.state === 'active' && amir?.can_earn === true, JSON.stringify([amir?.state, amir?.can_earn]));

/* THE POINT OF THE FILE.
   driver_day and every span query on the driver page clip to the Dubai day, so
   this shift would read 00:00. It opened at 23:43 the night before. */
const opened = amir?.online_at ? new Date(amir.online_at).toISOString() : null;
check('a shift that opened the night before reports the hour it actually opened',
  opened === '2026-09-05T19:43:00.000Z', String(opened));
check('…and says so, rather than leaving the reader to notice the date',
  amir?.began_before_window === true, String(amir?.began_before_window));
check('…and an open shift with no log-off is reported as open, not as zero-length',
  amir?.online_ended_at == null, String(amir?.online_ended_at));
/* The clipped answer, written out so the regression is named rather than
   implied: if this ever starts matching, the clip is back. */
check('…and it is NOT the Dubai midnight the clipped form would have given',
  opened !== '2026-09-05T20:00:00.000Z', String(opened));

const noorOpen = noor?.online_at ? new Date(noor.online_at).toISOString() : null;
check('a shift opened inside the window is reported at its own hour',
  noorOpen === '2026-09-06T05:00:00.000Z', String(noorOpen));
check('…and is not flagged as having begun earlier',
  noor?.began_before_window === false, String(noor?.began_before_window));
check('…and its close is the next event on that timeline',
  noor?.online_ended_at && new Date(noor.online_ended_at).toISOString() === '2026-09-06T07:00:00.000Z',
  String(noor?.online_ended_at));

check('when they last completed a trip is answered',
  amir?.last_trip_at && new Date(amir.last_trip_at).toISOString() === '2026-09-04T09:30:00.000Z',
  String(amir?.last_trip_at));
check('…with where it ended, so "idle in a dead zone" can be checked',
  amir?.last_trip_addr === 'Dubai Marina', JSON.stringify(amir?.last_trip_addr));
/* Their normal, so "idle" has something to be idle against. Noor last worked
   three weeks ago and that trip IS inside the four-week window — the count is
   what makes the difference between a bad morning and a dormant account
   legible, so it counts what is there rather than only what is recent. */
check('what normal looks like for them is counted over four weeks',
  amir?.trips_28d === 1 && noor?.trips_28d === 1,
  JSON.stringify([amir?.trips_28d, noor?.trips_28d]));
check('…and an account with nothing behind it counts zero rather than nothing',
  ghost?.trips_28d === 0, JSON.stringify(ghost?.trips_28d));
check('…over the days actually worked, not the days in the window',
  amir?.days_28d === 1 && ghost?.days_28d === 0,
  JSON.stringify([amir?.days_28d, ghost?.days_28d]));

/* Uber fills lat/lon on none of its 194,107 timeline rows. The column is read
   anyway, and comes back null — which the page renders as a sentence. What
   must never happen is a coordinate appearing from somewhere else. */
check('a position we do not hold is null, not inferred from their trips',
  amir?.online_lat == null && amir?.online_lon == null,
  JSON.stringify([amir?.online_lat, amir?.online_lon]));

/* An id nothing knows resolves to a row of nulls rather than to no row: the
   card still renders, and every line on it says what is missing. */
check('an unknown account resolves to a row, not to silence',
  ghost && ghost.full_name == null && ghost.phone == null && ghost.online_at == null,
  JSON.stringify(ghost));

/* Identity DOCUMENTS are not selected here at all. Nothing about ringing an
   idle driver needs their papers, and a column that is never read cannot leak. */
check('no identity document leaves this query',
  !people.some((p) => 'emirates_id' in p || 'licence_no' in p),
  JSON.stringify(Object.keys(people[0] || {})));

/* ── attachPeople ───────────────────────────────────────────────────────── */
attachPeople(findings, by, photoHref);
const flat = new Map(findings[0].refs.map((r) => [r.driver_ext_id, r]));
check('the resolved person is folded onto the ref the rule wrote',
  flat.get(AMIR)?.full_name === 'Amir Rahman', JSON.stringify(flat.get(AMIR)?.full_name));
check('…without losing what the rule itself measured',
  flat.get(AMIR)?.hours_online === 6.3, String(flat.get(AMIR)?.hours_online));
check('a photograph we hold is addressed through our own route, never the CDN',
  flat.get(AMIR)?.picture_url === `/api/driver/photo/uber/${AMIR}`,
  String(flat.get(AMIR)?.picture_url));
/* Three states, not two — the same rule avatar() enforces on the tile. */
check('a photograph we could not fetch names what went wrong',
  flat.get(NOOR)?.picture_url == null && /403/.test(flat.get(NOOR)?.photo_absent_reason || ''),
  JSON.stringify(flat.get(NOOR)?.photo_absent_reason));
check('…and an account that never offered one says THAT instead',
  /no photograph has been offered/.test(flat.get(GHOST)?.photo_absent_reason || ''),
  JSON.stringify(flat.get(GHOST)?.photo_absent_reason));
check('a finding whose refs name nobody is left exactly as it was',
  findings[2].refs.length === 1 && findings[2].refs[0].plate === 'L27045',
  JSON.stringify(findings[2].refs));
check('…and a finding with no refs is not given any', findings[1].refs === null);

await db.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
