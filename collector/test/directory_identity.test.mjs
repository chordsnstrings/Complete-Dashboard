/* ── a driver's fleet is not a fact about a date range ─────────────────────
   The directory lists everyone the fleet has ever known, which is the point of
   it: a person who has stopped driving is exactly who an operator opens the
   page to find, and their WORK columns are legitimately zero.

   Their IDENTITY columns were blank too. Measured on production over thirty
   days: 361 rows, 244 of which carried no fleet, no channel list and no usual
   vehicle — one of those people has 2,393 trips on record. Every one of those
   columns was read from the window's trips or a compliance row, and somebody
   who last drove in June has neither, so the page printed a name and four
   dashes about a driver it knows a great deal about.

   driver_lifetime already answers the other question with no window, so the
   three whole-history facts live there now (sql/schema_v34.sql) and the
   directory falls back to them. These tests hold down the two halves that
   matter: the fallback fills a person the window misses, and it NEVER
   overwrites what the window actually measured. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { refreshLifetime } from '../src/rollup.js';
import { driverRoutes } from '../api/driver_routes.js';
import { clearIdentityLinkCache } from '../api/identity_links.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);

let n = 0;
const trip = (drv, name, fleet, platform, plate, at) => q(
  `INSERT INTO trip (platform, fleet_id, external_id, driver_ext_id, driver_name, plate,
                     requested_at, ended_at, status, distance_km)
   VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz + interval '20 min','completed',9)`,
  [platform, fleet, `t${++n}`, drv, name, plate, at]);

/* Someone who drove recently — the window covers them. */
await trip('d-now', 'Amina Rashid', 'ecosine', 'uber', 'L100', '2026-08-25T09:00:00+04');
/* Someone who stopped in June. Two channels, and they changed fleet and car,
   so "most recent" has to mean something rather than "alphabetically last". */
await trip('d-old', 'Bilal Noor', 'ecosine', 'yango', 'L200', '2026-06-01T09:00:00+04');
await trip('d-old', 'Bilal Noor', 'egari', 'uber', 'L900', '2026-06-14T09:00:00+04');
await refreshLifetime(db);

const lt = await q(`SELECT * FROM driver_lifetime WHERE driver_ext_id='d-old'`);
check('the lifetime row carries the fleet of the most recent booking',
  lt[0]?.last_fleet === 'egari', JSON.stringify(lt[0]));
check('and the plate of that same booking, not the largest one',
  lt[0]?.last_plate === 'L900', String(lt[0]?.last_plate));
check('and every channel they ever drove on',
  [...(lt[0]?.platforms || [])].sort().join() === 'uber,yango', JSON.stringify(lt[0]?.platforms));
check('with the lifetime count intact', lt[0]?.lifetime === 2, String(lt[0]?.lifetime));

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
driverRoutes(app, { q, wrap });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

/* A window that covers only the recent driver. */
const rows = await get('/api/drivers/directory?from=2026-08-20&to=2026-08-26');
const now = rows.find((r) => r.driver_ext_id === 'd-now');
const old = rows.find((r) => r.driver_ext_id === 'd-old');

check('both people are listed, whether or not the window covers them',
  !!now && !!old, JSON.stringify(rows.map((r) => r.driver_ext_id)));
check('the person the window covers keeps their measured work',
  now.trips === 1 && now.fleet_id === 'ecosine' && now.plate === 'L100', JSON.stringify(now));
check('and is not marked as identified from history', now.identity_from_history === false,
  String(now.identity_from_history));

/* The whole point: a name and four blanks becomes a name and four facts. */
check('the person the window misses still has a fleet',
  old.fleet_id === 'egari', JSON.stringify(old));
check('still has their channels',
  [...(old.platforms || [])].sort().join() === 'uber,yango', JSON.stringify(old.platforms));
check('still has a vehicle', old.plate === 'L900', String(old.plate));
check('and their work columns stay honestly zero',
  old.trips === 0 && old.days === 0, JSON.stringify({ t: old.trips, d: old.days }));
check('flagged so a reader can tell an identity from a measurement',
  old.identity_from_history === true, String(old.identity_from_history));
check('their lifetime count is still there to explain the zero',
  old.lifetime_trips === 2, String(old.lifetime_trips));

/* The fallback must never win over a measurement. Bilal drove for egari most
   recently overall, but inside a window that only sees his ecosine day the
   window's answer is the true one. */
const june = await get('/api/drivers/directory?from=2026-05-30&to=2026-06-05');
const oldJune = june.find((r) => r.driver_ext_id === 'd-old');
check('inside a window that measures them, the window wins',
  oldJune.fleet_id === 'ecosine' && oldJune.plate === 'L200', JSON.stringify(oldJune));
check('and the flag says so', oldJune.identity_from_history === false,
  String(oldJune.identity_from_history));

/* The fallback SQL runs on a database with no rollup yet, and must agree. */
await q('DELETE FROM driver_lifetime');
const fresh = await get('/api/drivers/directory?from=2026-08-20&to=2026-08-26');
const oldFresh = fresh.find((r) => r.driver_ext_id === 'd-old');
check('a database with no rollup yet answers the same way',
  oldFresh.fleet_id === 'egari' && oldFresh.plate === 'L900'
  && [...(oldFresh.platforms || [])].sort().join() === 'uber,yango', JSON.stringify(oldFresh));

/* ── and the books, for somebody who has never driven ───────────────────── */
/* 129 people on production carried no fleet even after the history fallback,
   because they have taken no booking at all — but every one of them holds a
   standing or a compliance record, and both tables carry fleet_id. */
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, state)
         VALUES ('hotel','d-books','egari','Saeed Al Mansoori','offline')`);
const books = await get('/api/drivers/directory?from=2026-08-20&to=2026-08-26');
const bk = books.find((r) => r.driver_ext_id === 'd-books');
check('somebody who has never driven still shows the fleet whose books they are on',
  bk?.fleet_id === 'egari', JSON.stringify(bk && { f: bk.fleet_id, t: bk.trips, l: bk.lifetime_trips }));
check('and is not claimed as identified from trip history, because there is none',
  bk?.identity_from_history === false, String(bk?.identity_from_history));
check('their work columns stay zero and their channels stay empty',
  bk.trips === 0 && (bk.platforms || []).length === 0, JSON.stringify(bk.platforms));
/* The order matters: a trip beats the books. */
const still = books.find((r) => r.driver_ext_id === 'd-now');
check('a measured fleet still beats a compliance record',
  still.fleet_id === 'ecosine', String(still.fleet_id));

/* ── ONE PERSON, ONE ROW, WHEN THE TWO LAYERS NAME HIM DIFFERENTLY ──────
   The operator's report: "we fixed double entries but it still showing double
   names." From #drivers, both Ecosine, both on plate L44251:

     WISAL MUHAMMAD IRSHAD MUHAMMAD   uber + hotel
     Wisal Muhammad Irshah Muhammad   bolt

   Both layers already agreed he was one man. api/identity_map.js holds the
   pair in MERGES with contradictions: [], and the live sweep proposed it twice
   and both are confirmed. What they disagreed about was the KEY: the register
   keys him on the UBER record's short filed name, the link chain terminates on
   the HOTEL record and keys him on its long one. driver_routes.js resolved
   that per id, first-wins — so the single id the register named stopped there
   and the other three fell through to the chain.

   Measured against production's own link table: 37 people, every one the same
   shape, a short filed name against a long one.

   The fixture below is that shape exactly, built out of a live link rather
   than the register — the register is a fixed list this test must not edit,
   and the defect is about the two layers disagreeing, not about which one. */
/* THE FIXTURE USES A REAL REGISTER ID, and it has to.
   ───────────────────────────────────────────────────────────────────────
   The defect needs the register to name SOME of a person's ids and not
   others. api/identity_map.js is a fixed, hand-reviewed list that a test
   must never edit, so invented ids reproduce nothing — the register knows
   none of them, every id falls through to the link chain, they agree, and
   the fixture passes against the unfixed code. That is exactly what the
   first version of this block did.

   So the Uber leg below IS a register id — 7fc8da91… keyed 'aliyan khalil'
   — and the link chain around it terminates on a record filed under a
   LONGER name. The register says 'aliyan khalil'; the chain says 'aliyan
   khalil rafiq khalil'; and the shipped first-wins-per-id resolution put
   them in two rows. */
const REG_ID = '7fc8da91fc4a44c185e8d6d918db3e6b';   // ALIAS_KEY -> 'aliyan khalil'
await trip(REG_ID, 'Aliyan khalil', 'ecosine', 'yango', 'L99001', '2026-08-21T09:00:00+04');
await trip('sp-bolt', 'Aliyan Khalil Rafiq Khalil', 'ecosine', 'bolt', 'L99001', '2026-08-22T09:00:00+04');
await trip('sp-hotel', 'Aliyan Khalil Rafiq Khalil', 'ecosine', 'hotel', 'L99001', '2026-08-23T09:00:00+04');
/* REG_ID → sp-bolt → sp-hotel. The chain terminates on the hotel record and
   keys the person on ITS longer name, while the register names only REG_ID
   and keys him on his short one. */
await q(`INSERT INTO driver_identity_link
   (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
    canonical_name, canonical_key, basis, evidence, confirmed_at, confirmed_by)
   VALUES ($1,'yango','Aliyan khalil','sp-bolt','bolt','Aliyan Khalil Rafiq Khalil',
           'aliyan khalil rafiq khalil','shared_car_name','same car, spelling apart',
           now(),'ahsan'),
          ('sp-bolt','bolt','Aliyan Khalil Rafiq Khalil','sp-hotel','hotel',
           'Aliyan Khalil Rafiq Khalil','aliyan khalil rafiq khalil','shared_car_name',
           'same car, same name', now(),'ahsan')`, [REG_ID]);
clearIdentityLinkCache();

const folded = await get('/api/drivers/directory?from=2026-08-20&to=2026-08-26');
const one = folded.filter((r) => (r.ids || []).some(
  (i2) => i2 === REG_ID || String(i2).startsWith('sp-')));
check('a person the register and the link chain key DIFFERENTLY is one row',
  one.length === 1,
  `${one.length} rows: ${JSON.stringify(one.map((r) => [r.driver_name, r.ids]))}`);
check('and that row holds every one of his accounts',
  one.length === 1 && [REG_ID, 'sp-bolt', 'sp-hotel'].every((i2) => (one[0].ids || []).includes(i2)),
  JSON.stringify(one[0] && one[0].ids));
check('his trips are summed across them rather than split in two',
  one.length === 1 && one[0].trips === 3, String(one[0] && one[0].trips));
/* THE KEY KEPT IS THE REGISTER'S — the person who looked decides the label,
   over the whole person rather than over the one id they happened to name. */
check('folded under the key a human chose, not the chain\'s terminal',
  one.length === 1 && /aliyan khalil/i.test(one[0].driver_name || ''),
  JSON.stringify(one[0] && one[0].driver_name));

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
