/* The pass that places every booking — on PGlite, end to end.
   ──────────────────────────────────────────────────────────────────────────
   src/trip_places.js feeds src/place_resolve.js a batch of trips, asks the
   tracker table about the endpoints only a tracker can place, stores the
   answer in trip_place and casts one vote per drop-off for booking_cell. What
   this pins, each with the case that motivates it:

     · every rung lands in the table with its basis, and the absent endpoints
       with their true reason (a cancelled booking's missing drop-off is
       "cancelled", not "no time");
     · FMS journeys are not bookings and are not resolved;
     · the tracker window and the FMS-before-CABMAN rule hold in the SQL, not
       only in chooseFix();
     · a position is named by booking_cell (the bookings' own words) once the
       votes exist, and a row named through place_cell (FMS's words) is
       re-resolved when booking_cell is rebuilt;
     · an absent row is re-resolved once a tracker fix arrives;
     · a second pass over unchanged data changes nothing (idempotent);
     · a trip whose inputs change upstream is resolved again;
     · a drop-off that stops qualifying takes its vote back;
     · the budget bounds the pass (budget 0 resolves nothing);
     · the sweep reaches history older than the fresh window, and wraps. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { resolveTripPlaces, refreshBookingCells } from '../src/trip_places.js';
import { CELL } from '../src/places.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* Three named cells in place_cell, the FMS gazetteer, spelled the way FMS
   spells them — "Bay Square" is a real place_cell name for a Business Bay
   cell (production, 2026-11-16). */
const cell = (v) => Math.round(v / CELL);
const X = [25.185, 55.27];          // Business Bay, by both gazetteers
const P = [25.0821875, 55.1614375]; // where 35J6+VH decodes to
const K = [25.2, 55.27];
await q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations, built_at) VALUES
  ($1, $2, 'Bay Square', 3, 2, 5, now()), ($3, $4, 'Al Sufouh', 4, 1, 4, now()),
  ($5, $6, 'Downtown Dubai', 9, 1, 9, now()), (1, 1, 'DAMAC Hills', 4, 1, 4, now())`,
[cell(X[0]), cell(X[1]), cell(P[0]), cell(P[1]), cell(K[0]), cell(K[1])]);

const BB = 'Ahad Tower - Marasi Dr - Business Bay - Dubai - United Arab Emirates';
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, status, requested_at, ended_at,
     pickup_addr, pickup_lat, pickup_lng, dropoff_addr, dropoff_lat, dropoff_lng)
   VALUES ($1, $2, 'ecosine', $3, $4, now() - make_interval(mins => $5::int),
           CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(mins => $6::int) END,
           $7, $8, $9, $10, NULL, NULL)`,
  [o.platform || 'uber', o.id, o.plate ?? null, o.status || 'completed', o.req, o.end ?? null,
    o.pickup ?? '', o.lat ?? null, o.lng ?? null, o.dropoff ?? '']);
const fix = (plate, minsAgo, [lat, lng], source = 'fms') => q(
  `INSERT INTO telemetry_snapshot (source, plate, captured_at, lat, lng)
   VALUES ($1, $2, now() - make_interval(secs => $3::float * 60), $4, $5)`, [source, plate, minsAgo, lat, lng]);
const row = async (id) => (await q('SELECT * FROM trip_place WHERE external_id = $1', [id]))[0];

// A1, A2: dash-form drop-offs in Business Bay, the car's tracker there a minute later → two votes.
await trip({ id: 'A1', plate: 'P1', req: 300, end: 280, pickup: BB, dropoff: BB });
await trip({ id: 'A2', plate: 'P1', req: 260, end: 240, pickup: BB, dropoff: BB });
await fix('P1', 279, X); await fix('P1', 239, X);
// B: no pickup address; the tracker 2 minutes after the request, in that cell.
await trip({ id: 'B', plate: 'P1', req: 200, end: 180, pickup: '', dropoff: '' });
await fix('P1', 198, [X[0] - 0.0001, X[1] - 0.0001]);
// C: no address and no fix — yet.
await trip({ id: 'C', plate: 'P2', req: 150, pickup: '', dropoff: '' });
// H: the only fix is 8 minutes from the request — outside the window.
await trip({ id: 'H', plate: 'P3', req: 120, pickup: '', dropoff: '' });
await fix('P3', 112, X);
// I: CABMAN 30 s from the request somewhere unnamed, FMS 3 minutes away in Business Bay.
await trip({ id: 'I', plate: 'P4', req: 100, pickup: '', dropoff: '' });
await fix('P4', 99.5, [25.3, 55.4], 'cabman'); await fix('P4', 97, X);
// D: Uber's one-line form. E: Bolt's comma form. P: a bare plus code. K: the booking's own coordinates.
await trip({ id: 'D', req: 90, pickup: 'Ahad Residences Marasi Drive Business Bay AE' });
await trip({ id: 'E', platform: 'bolt', req: 80, pickup: 'DAMAC Hills, Dubai' });
await trip({ id: 'P', req: 70, pickup: '35J6+VH - Dubai - United Arab Emirates' });
await trip({ id: 'K', platform: 'hotel', req: 60, pickup: '', lat: K[0], lng: K[1] });
// G: rider cancelled, so no drop-off time and no drop-off address.
await trip({ id: 'G', plate: 'P5', status: 'rider_cancelled', req: 50, pickup: BB, dropoff: '' });
// F: an FMS journey — not a booking.
await trip({ id: 'F', platform: 'fms', plate: 'P1', req: 40, end: 30, pickup: BB, dropoff: BB });
// S: a booking 100 days old, outside the fresh window — only the sweep reaches it.
await trip({ id: 'S', req: 100 * 1440, pickup: BB, dropoff: BB });

console.log('\npass 1: every rung, every reason');
{
  const s = await resolveTripPlaces(db, { budgetMs: 60_000 });
  const n = (await q('SELECT count(*)::int n FROM trip_place'))[0].n;
  check('every booking has a row (12), and the FMS journey does not', n === 12 && !(await row('F')), `rows ${n}`);
  check('the 100-day-old booking was reached by the sweep, not the fresh window',
    (await row('S'))?.pickup_basis === 'address' && s.swept === 1 && s.fresh === 11, JSON.stringify(s));
  const a1 = await row('A1');
  check('A1: dash form → basis address', a1.pickup_basis === 'address' && a1.pickup_area === 'Business Bay');
  const b = await row('B');
  check('B: no address → the car\'s tracker, 2 minutes from the request',
    b.pickup_basis === 'tracker' && b.pickup_detail.minutes === 2 && b.pickup_detail.source === 'fms', JSON.stringify(b.pickup_detail));
  check('…named through place_cell on the first pass (booking_cell had no votes yet): "Bay Square"',
    b.pickup_area === 'Bay Square' && b.pickup_named_by === 'place_cell', `${b.pickup_area}/${b.pickup_named_by}`);
  check('C: no address, no fix → "no_address+no_fix"', (await row('C')).pickup_reason === 'no_address+no_fix');
  check('H: a fix 8 minutes away is not used → "no_address+no_fix"', (await row('H')).pickup_reason === 'no_address+no_fix');
  const i = await row('I');
  check('I: FMS three minutes away beats CABMAN thirty seconds away', i.pickup_basis === 'tracker'
    && i.pickup_detail.source === 'fms' && i.pickup_area === 'Bay Square', JSON.stringify(i.pickup_detail));
  const d = await row('D');
  check('D: Uber one-line → address_name "Business Bay"', d.pickup_basis === 'address_name' && d.pickup_area === 'Business Bay');
  const e = await row('E');
  check('E: Bolt comma form → address_name "DAMAC Hills" (a place_cell name)', e.pickup_basis === 'address_name' && e.pickup_area === 'DAMAC Hills');
  const p = await row('P');
  check('P: a bare plus code → plus_code, "Al Sufouh"', p.pickup_basis === 'plus_code' && p.pickup_area === 'Al Sufouh'
    && p.pickup_detail.code === '35J6+VH', JSON.stringify(p));
  const k = await row('K');
  check('K: the booking\'s own coordinates → coordinates, "Downtown Dubai"', k.pickup_basis === 'coordinates' && k.pickup_area === 'Downtown Dubai');
  check('G: a cancelled booking\'s drop-off → "no_address+cancelled", not "no time"',
    (await row('G')).dropoff_reason === 'no_address+cancelled', (await row('G')).dropoff_reason);
  const votes = await q('SELECT external_id, area, cell_lat, cell_lng FROM place_vote ORDER BY 1');
  check('two votes, one per dash-form drop-off the tracker saw: Business Bay in that cell',
    votes.length === 2 && votes.every((v) => v.area === 'Business Bay' && v.cell_lat === cell(X[0]) && v.cell_lng === cell(X[1])),
    JSON.stringify(votes));
  check('the constraint holds on every row: an area or a reason, never both, never neither',
    (await q(`SELECT count(*)::int n FROM trip_place WHERE (pickup_area IS NULL) = (pickup_reason IS NULL)
               OR (dropoff_area IS NULL) = (dropoff_reason IS NULL)`))[0].n === 0);
}

console.log('\npass 2: booking_cell built from the votes; an absent row gets its fix');
{
  await fix('P2', 147, X);   // C's tracker turns up, 3 minutes after its request
  const s = await resolveTripPlaces(db, { budgetMs: 60_000 });
  const bc = await q('SELECT * FROM booking_cell');
  check('booking_cell: the voted cell, named in the bookings\' words, with its votes',
    bc.length === 1 && bc[0].area === 'Business Bay' && bc[0].n === 2, JSON.stringify(bc));
  const b = await row('B');
  check('B is re-resolved: now "Business Bay", named by booking_cell',
    b.pickup_area === 'Business Bay' && b.pickup_named_by === 'booking_cell', `${b.pickup_area}/${b.pickup_named_by}`);
  const c = await row('C');
  check('C, absent for want of a fix, is placed once the fix arrives', c.pickup_basis === 'tracker'
    && c.pickup_area === 'Business Bay' && c.pickup_detail.minutes === 3, JSON.stringify(c));
  check('H stays absent: its only fix is still outside the window', (await row('H')).pickup_reason === 'no_address+no_fix');
  check('the pass says what it did', s.retried >= 3 && s.fresh === 0, JSON.stringify(s));
}

console.log('\npass 3: nothing changed, nothing changes');
{
  const snap = async () => JSON.stringify(await q(
    `SELECT platform, external_id, pickup_area, pickup_basis, pickup_reason, pickup_named_by, pickup_detail,
            dropoff_area, dropoff_basis, dropoff_reason, dropoff_named_by, dropoff_detail, inputs
       FROM trip_place ORDER BY 1, 2`));
  const before = await snap();
  const votes = (await q('SELECT count(*)::int n FROM place_vote'))[0].n;
  const s = await resolveTripPlaces(db, { budgetMs: 60_000 });
  check('every answer is the same', (await snap()) === before);
  check('no booking was fresh, retried or swept', s.fresh === 0 && s.retried === 0 && s.swept === 0, JSON.stringify(s));
  check('and the votes are the same', (await q('SELECT count(*)::int n FROM place_vote'))[0].n === votes);
}

console.log('\nan upstream change is resolved again');
{
  await q(`UPDATE trip SET pickup_addr = 'Cluster T - Al Thanyah Fifth - Jumeirah Lakes Towers - Dubai - United Arab Emirates'
            WHERE external_id = 'D'`);
  const s = await resolveTripPlaces(db, { budgetMs: 60_000 });
  const d = await row('D');
  check('D\'s new address is read: Jumeirah Lakes Towers, basis address',
    d.pickup_area === 'Jumeirah Lakes Towers' && d.pickup_basis === 'address' && s.fresh === 1, JSON.stringify(s));
  await q(`UPDATE trip SET dropoff_addr = '' WHERE external_id = 'A2'`);
  await resolveTripPlaces(db, { budgetMs: 60_000 });
  const v = await q('SELECT external_id FROM place_vote ORDER BY 1');
  check('A2\'s drop-off lost its address, so A2 takes its vote back', v.length === 1 && v[0].external_id === 'A1', JSON.stringify(v));
}

console.log('\nthe budget bounds the pass');
{
  await trip({ id: 'N', req: 10, pickup: BB, dropoff: BB });
  const s = await resolveTripPlaces(db, { budgetMs: 0 });
  check('budget 0: no batch runs, the new booking waits', s.batches === 0 && !(await row('N')), JSON.stringify(s));
  /* A clock that moves a second per look: with a 1.5 s budget the pass
     stops after the first batch it starts, whatever is still queued. */
  for (let j = 0; j < 6; j++) await trip({ id: `Q${j}`, req: 5, pickup: BB });
  let t = 0;
  const s2 = await resolveTripPlaces(db, { budgetMs: 1500, batch: 2, now: () => (t += 1000) });
  check('a moving clock: the pass ends within one batch of its budget', s2.batches === 1, JSON.stringify(s2));
  await resolveTripPlaces(db, { budgetMs: 60_000 });
  check('…and the next pass picks up the rest', (await q("SELECT count(*)::int n FROM trip_place WHERE external_id LIKE 'Q%' OR external_id = 'N'"))[0].n === 7);
}

console.log('\nthe sweep wraps, and a deleted trip takes its rows with it');
{
  const cur = (await q("SELECT value FROM source_state WHERE source = 'trip_places' AND key = 'sweep_cursor'"))[0]?.value;
  const done = (await q("SELECT value FROM source_state WHERE source = 'trip_places' AND key = 'sweep_completed_at'"))[0]?.value;
  check('after running off the oldest trip the cursor resets and the sweep records its end', cur === 'null' && !!done, `${cur} ${done}`);
  /* Once the history has been swept, a pass re-checks at most sweepSlices
     slices of it — the re-check is a slow background read, not a scan of the
     whole table every thirty minutes. */
  const s = await resolveTripPlaces(db, { budgetMs: 60_000, batch: 2, sweepSlices: 1 });
  check('after the first full sweep, one slice per pass (batch 2 → 8 rows scanned)', s.scanned === 8 && !s.sweep_wrapped,
    JSON.stringify(s));
  await q("DELETE FROM trip WHERE external_id = 'A1'");
  check('deleting the trip deletes its trip_place row and its vote',
    !(await row('A1')) && (await q("SELECT count(*)::int n FROM place_vote WHERE external_id = 'A1'"))[0].n === 0);
  const r = await refreshBookingCells(db, { force: true });
  check('a forced rebuild over no votes leaves booking_cell empty, not stale', r.cells === 0
    && (await q('SELECT count(*)::int n FROM booking_cell'))[0].n === 0);
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
