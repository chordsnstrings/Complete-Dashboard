/* Total, completed, cancelled — and who called the cancellations off.
   ──────────────────────────────────────────────────────────────────────────
   The Today screen showed 789 bookings, "88.7%" and "11.2% cancelled": two
   comparisons and not one of the things being compared. An operator looking at
   it could not say how many of the 789 were actual rides. They asked for
   exactly that — "a breakdown of total trips, actual number of trips,
   cancelled trips, rider cancelled and driver cancelled".

   FOUR buckets, not the two asked for, because two do not add up. Over 2026,
   5,307 of the fleet's 7,032 driver-attributed cancellations are Bolt offers
   nobody picked up — broadcast to several drivers at once, so refusing one
   leaves nobody waiting, and Uber never files them at all. Folding those into
   "driver cancelled" makes the line three-quarters an artefact of which app a
   driver works, which is the defect the Cancellations page was split to fix.
   Yango's are the fourth: it files the bare word 'cancelled' and names nobody.

   And the counts come from api/cancellation_sql.js's own expressions rather
   than a second copy, because two definitions of a cancellation in one product
   is how the Today screen and the Cancellations page come to disagree about
   one morning. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

let tn = 0;
const trip = (platform, status, n = 1) => Promise.all(Array.from({ length: n }, () => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, status, distance_km, price)
   VALUES ($1,$2,'ecosine','L1','d1','Driver One',$3::timestamptz,$3::timestamptz,$4,10,40)`,
  [platform, `tb${tn++}`, '2026-08-14T12:00:00+04:00', status])));

await trip('uber', 'completed', 20);
await trip('uber', 'rider_cancelled', 5);
await trip('uber', 'driver_cancelled', 3);
await trip('bolt', 'finished', 4);
await trip('bolt', 'client_cancelled', 2);
await trip('bolt', 'driver_cancelled_after_accept', 1);
/* Offers, which are the reason this has four buckets. Two of them wear Bolt's
   backup-offer prefix, which sql/schema_v18.sql strips before deciding an
   outcome and which must be stripped here too. */
await trip('bolt', 'driver_did_not_respond', 6);
await trip('bolt', 'optional_ride_driver_rejected', 2);
await trip('yango', 'cancelled', 4);
await trip('yango', 'complete', 3);
/* A status this product has not mapped: neither completed nor cancelled. It is
   the remainder that makes a breakdown add up or nearly add up. */
await trip('bolt', 'fare_split', 2);
/* Telematics, which is movement and not a booking, and must stay out of all
   of it. */
await trip('fms', 'completed', 9);

const { server, get } = await mountAll(db);
const k = (await get('/api/kpis?from=2026-08-01&to=2026-08-31')).body;

/* ── the counts the operator asked for ──────────────────────────────────── */
check('total bookings excludes telematics journeys',
  k.trips === 52, String(k.trips));
check('the actual number of trips is a COUNT, not only a percentage',
  k.completed_trips === 27, String(k.completed_trips));
check('and so is the number cancelled',
  k.cancelled_trips === 23, String(k.cancelled_trips));

/* ── who called them off ────────────────────────────────────────────────── */
check('the rider bucket counts both channels that name them',
  k.cancelled_by_rider === 7, String(k.cancelled_by_rider));
check('the driver bucket is jobs ACCEPTED and then ended, on either channel',
  k.cancelled_by_driver === 4, String(k.cancelled_by_driver));
check('offers nobody took are counted apart, never inside "by the driver"',
  k.declined_offers === 8, String(k.declined_offers));
check('…including the ones wearing Bolt’s backup-offer prefix',
  k.declined_offers === 8, 'optional_ride_ must be stripped before matching');
check('and the channel that names no actor keeps its own bucket',
  k.cancelled_unsaid === 4, String(k.cancelled_unsaid));

/* ── it has to add up, which is the whole point of a breakdown ──────────── */
check('the four buckets sum to the cancellation total',
  k.cancelled_by_rider + k.cancelled_by_driver + k.declined_offers + k.cancelled_unsaid
    === k.cancelled_trips,
  JSON.stringify([k.cancelled_by_rider, k.cancelled_by_driver, k.declined_offers,
    k.cancelled_unsaid, k.cancelled_trips]));
check('and completed plus cancelled plus the unplaced remainder is every booking',
  k.completed_trips + k.cancelled_trips + k.other_outcome + k.no_outcome === k.trips,
  JSON.stringify([k.completed_trips, k.cancelled_trips, k.other_outcome, k.no_outcome, k.trips]));
check('the remainder is named rather than dropped',
  k.other_outcome === 2, String(k.other_outcome));

/* ── and it must match the page that owns the subject ───────────────────── */
{
  const c = (await get('/api/cancellations?from=2026-08-01&to=2026-08-31')).body.totals;
  check('Today and the Cancellations page agree on the cancellation total',
    c.cancelled === k.cancelled_trips, `${c.cancelled} vs ${k.cancelled_trips}`);
  check('…and on every bucket in it',
    c.by_rider === k.cancelled_by_rider && c.dropped === k.cancelled_by_driver
      && c.declined === k.declined_offers && c.unattributed === k.cancelled_unsaid,
    JSON.stringify([c.by_rider, c.dropped, c.declined, c.unattributed]));
}

/* ── one definition, not two copies ─────────────────────────────────────── */
{
  const srv = readFileSync('api/server.js', 'utf8');
  check('the kpis query reads the shared expressions rather than its own status list',
    /from '\.\/cancellation_sql\.js'/.test(srv)
      && /\$\{DROPPED_SQL\}/.test(srv) && /\$\{DECLINED_SQL\}/.test(srv));
  check('and names no cancellation status of its own',
    !/driver_did_not_respond|rider_cancelled|client_cancelled/.test(srv),
    'a second copy of the vocabulary is how two pages come to disagree');
}

/* ── both shells show it, and say the same thing ────────────────────────── */
{
  const strip = (f) => readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const phone = strip('api/public/m/screens.js');
  const desk = strip('api/public/app.js');
  check('the phone leads the Completed tile with the count',
    /label: 'Completed', value: fmt\(k\.completed_trips\)/.test(phone));
  check('…and gives Cancelled a count of its own rather than a percentage alone',
    /label: 'Cancelled', value: fmt\(k\.cancelled_trips\)/.test(phone));
  check('…and breaks the cancellations down, the phone having no Cancellations screen',
    /Who called it off/.test(phone) && /cancelled_by_rider/.test(phone)
      && /cancelled_by_driver/.test(phone) && /declined_offers/.test(phone));
  /* The unplaced remainder is not a fifth bucket. It was rendered as a peer row
     under "Who called it off", which reads as part of the cancellation total
     when it is not a cancellation at all — it is a booking that is neither
     completed nor cancelled. It belongs below the list, not in it. */
  const block = phone.slice(phone.indexOf('Who called it off'));
  const listEnd = block.indexOf(']);');
  check('the unplaced remainder is not rendered as a fifth cancellation bucket',
    !block.slice(0, listEnd).includes('unplaced'),
    'it must sit below the list, not among the four');
  check('…but is still named, so the breakdown accounts for every booking',
    /neither\s*\n?\s*.?completed nor cancelled/.test(block)
      || /neither `\s*$/m.test(block) || block.includes('completed nor cancelled'),
    'the remainder must be printed somewhere');
  check('the desktop tile leads with the count too, so the two shells agree',
    /k\.completed_trips\)\} of \$\{fmt\(k\.bookable_trips\)/.test(desk));
  check('…and carries the same split',
    /cancelled_by_rider/.test(desk) && /cancelled_by_driver/.test(desk)
      && /declined_offers/.test(desk));
}

/* ── the mock must be able to produce the shape the endpoint produces ───── */
{
  const m = readFileSync('mockapi.mjs', 'utf8');
  const g = (k2) => { const h = m.match(new RegExp("\\b" + k2 + ": (\\d+)")); return h ? Number(h[1]) : NaN; };
  check('the mock fixture’s buckets sum to its own cancellation total',
    g('cancelled_by_rider') + g('cancelled_by_driver') + g('declined_offers')
      + g('cancelled_unsaid') === g('cancelled_trips'),
    JSON.stringify([g('cancelled_by_rider'), g('cancelled_by_driver'),
      g('declined_offers'), g('cancelled_unsaid'), g('cancelled_trips')]));
  check('…and its completed, cancelled and remainder sum to its bookings',
    g('completed_trips') + g('cancelled_trips') + g('other_outcome') === g('trips'),
    `${g('completed_trips')} + ${g('cancelled_trips')} + ${g('other_outcome')} vs ${g('trips')}`);
  /* A duplicate key in an object literal is silent, and it bit here: these
     counts were added beside the rates at the top of the fixture while
     completed_trips, cancelled_trips and bookable_trips were already declared
     further down, so the earlier copy was shadowed and the desktop tile drew
     225 cancellations over a breakdown summing to 219. */
  for (const key of ['completed_trips', 'cancelled_trips', 'bookable_trips', 'trips']) {
    const seg = m.slice(m.indexOf("app.get('/api/kpis'"), m.indexOf("app.get('/api/kpis'") + 3000);
    check(`the mock declares ${key} exactly once`,
      (seg.match(new RegExp(`\\b${key}:`, 'g')) || []).length === 1,
      String((seg.match(new RegExp(`\\b${key}:`, 'g')) || []).length));
  }
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
