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

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
