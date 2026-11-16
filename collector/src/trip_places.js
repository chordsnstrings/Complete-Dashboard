/* The pass that places every booking's pickup and drop-off (FIX-STATUS PLC).
   ─────────────────────────────────────────────────────────────────────────
   src/place_resolve.js decides; this module feeds it and stores what it says
   in trip_place (sql/schema_v126.sql). It runs once per collector pass, after
   refreshPlaceCells(), because two of its rungs name a position through the
   gazetteers.

   WHAT ONE PASS DOES, in order, until its time budget is spent:

     1. booking_cell, rebuilt from place_vote when it is older than the
        gazetteer cadence (six hours, src/places.js) or empty. The gazetteer in
        the bookings' own words — src/place_resolve.js says why there are two.
     2. fresh   bookings in the last FRESH_DAYS with no trip_place row, or
                whose inputs changed upstream (an md5 over every column the
                answer is built from, so a late address, a corrected plate or
                a Bolt order's coordinates arriving afterwards re-resolve it).
     3. retry   rows whose earlier answer was absent, or named through the
                FMS gazetteer, when better data has arrived:
                  · a tracker fix now exists inside the window of an endpoint
                    that was absent for want of one (checked exactly, per row);
                  · RETRY_HOURS since the last attempt, for an endpoint absent
                    for a name (the vocabulary and the gazetteers grow);
                  · booking_cell rebuilt since a position was named by
                    place_cell.
     4. sweep   the whole history, newest first, a batch at a time, behind a
                cursor kept in source_state: the backfill on the first passes,
                and afterwards a slow re-check (SWEEP_SLICES a pass) that
                catches an old trip whose inputs changed outside the fresh
                window. When the cursor runs off the oldest trip it starts
                again from the newest.

   CANNOT STARVE THE WORKER. Every step is a batch of BATCH bookings — one
   select, one batched tracker lookup over the (plate, captured_at) index, one
   upsert — and the loop checks the budget between batches, so the pass ends
   within one batch of budgetMs whatever the backlog. Measured locally on
   PGlite (test/trip_places.test.mjs) and to be measured on production in the
   first passes; the run log carries batches, rows and milliseconds.

   IDEMPOTENT. A booking is resolved again only when one of the three
   conditions above holds; a second pass over unchanged data writes nothing
   new except resolved_at on the rows it retried. Votes are one per booking,
   keyed on the booking, and replaced with it. */
import { canonAreaSql } from './area_alias.js';
import { pool } from './db.js';
import { log } from './log.js';
import { CELL, cellOf } from './places.js';
import { resolveEndpoint, buildVocabulary, TRACKER_WINDOW_MIN } from './place_resolve.js';

export const BATCH = Number(process.env.TRIP_PLACE_BATCH || 500);
export const BUDGET_MS = Number(process.env.TRIP_PLACE_BUDGET_MS || 90_000);
export const FRESH_DAYS = Number(process.env.TRIP_PLACE_FRESH_DAYS || 35);
export const RETRY_HOURS = Number(process.env.TRIP_PLACE_RETRY_HOURS || 6);
/* After the first full sweep, how many slices (4 × BATCH bookings each) one
   pass re-checks. 10 × 2,000 = 20,000 a pass, so ~425,000 bookings are
   re-checked about every 21 passes — ten and a half hours at the collector's
   thirty-minute cadence — instead of all of them every thirty minutes. Until
   the first sweep completes (the backfill) only the budget limits it. */
export const SWEEP_SLICES = Number(process.env.TRIP_PLACE_SWEEP_SLICES || 10);
const GAZ_MAX_AGE_HOURS = Number(process.env.PLACE_CELL_MAX_AGE_HOURS || 6);
const STATE = ['trip_places', '-'];

/* Every trip column the answer depends on, NULL spelled out (concat_ws skips
   NULLs, so ('a', NULL, 'b') and ('a', 'b', NULL) would collide) and times as
   epochs (timestamptz::text follows the session's TimeZone, which is not a
   property of the trip). status is in it because a cancelled booking's
   missing drop-off has its own reason. */
const INPUTS = (a = 't') => `md5(concat_ws('|',
  coalesce(${a}.pickup_addr, '∅'), coalesce(${a}.pickup_lat::text, '∅'), coalesce(${a}.pickup_lng::text, '∅'),
  coalesce(${a}.dropoff_addr, '∅'), coalesce(${a}.dropoff_lat::text, '∅'), coalesce(${a}.dropoff_lng::text, '∅'),
  coalesce(${a}.plate, '∅'), coalesce(extract(epoch FROM ${a}.requested_at)::text, '∅'),
  coalesce(extract(epoch FROM ${a}.ended_at)::text, '∅'), coalesce(${a}.status, '∅'),
  coalesce(${a}.is_scheduled::text, '∅')))`;

/* Whose requested_at is the moment the car reached the pickup, so the
   tracker at that instant IS at the pickup even on a booking made in
   advance: the hotel channel's requested_at is the trip's startTime
   (src/sources/hotel.js). Everyone else's is when the booking was made —
   Bolt's is the order's `created` (src/sources/bolt_orders.js), Uber's the
   "Trip request time" — and on a scheduled booking that can be hours
   before the pickup (review 2026-11-16; src/place_resolve.js
   resolveEndpoint, `scheduled`). */
const REQUEST_IS_PICKUP = new Set(['hotel']);

const COLS = `t.platform, t.external_id, t.fleet_id, t.plate, t.status, t.requested_at, t.ended_at, t.is_scheduled,
  t.pickup_addr, t.pickup_lat, t.pickup_lng, t.dropoff_addr, t.dropoff_lat, t.dropoff_lng,
  ${INPUTS('t')} AS inputs, (tp.platform IS NOT NULL) AS stored`;

/* The tracker lookup, for a batch at once. The same choice as chooseFix() in
   src/place_resolve.js, which the tests pin: within the window, FMS before
   CABMAN, then the nearest in time. Uber's own status rows share this table
   (source 'uber') and carry no position; the UAE box drops the 0,0 a tracker
   reports on boot (api/telemetry_sql.js REAL_FIX). */
const FIX_SQL = `
  SELECT k.i::int AS i, f.lat, f.lng, f.source, f.captured_at,
         abs(extract(epoch FROM (f.captured_at - k.at))) / 60 AS minutes
    FROM unnest($1::text[], $2::timestamptz[]) WITH ORDINALITY AS k(plate, at, i)
    JOIN LATERAL (
      SELECT s.lat, s.lng, s.source, s.captured_at
        FROM telemetry_snapshot s
       WHERE s.plate = k.plate AND s.source IN ('fms', 'cabman')
         AND s.captured_at BETWEEN k.at - make_interval(mins => $3::int)
                               AND k.at + make_interval(mins => $3::int)
         AND s.lat > 22 AND s.lat < 27 AND s.lng > 51 AND s.lng < 57
       ORDER BY (s.source = 'fms') DESC, abs(extract(epoch FROM (s.captured_at - k.at)))
       LIMIT 1) f ON true`;

async function getState(db, key) {
  const r = await db.query('SELECT value FROM source_state WHERE source=$1 AND fleet_id=$2 AND key=$3', [...STATE, key]);
  return r.rows[0]?.value ?? null;
}
async function setState(db, key, value) {
  await db.query(
    `INSERT INTO source_state (source, fleet_id, key, value, updated_at) VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (source, fleet_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [...STATE, key, value]);
}

/* ── booking_cell: the votes, folded to the modal name per cell ───────────
   The same statement shape as src/places.js BUILD and for the same reasons:
   DISTINCT ON for the mode, the name as tie-break so a split cell does not
   flap between rebuilds, and the vote counts kept beside the name. */
/* Votes are tallied on the FOLDED name (src/area_alias.js, 2026-11-16): a
   cell voted "Al Raffa" ×4 and "الرفاعة" ×5 is one area with nine votes, named
   in English, not an Arabic name that won by a single vote — which is how the
   overnight lines on production came to read "الرفاعة". On a tie the Latin
   spelling wins, for the same reader. */
const BOOKING_CELL_BUILD = `
  WITH tally AS (
    SELECT cell_lat, cell_lng, ${canonAreaSql('area')} AS area, count(*)::int AS n FROM place_vote GROUP BY 1, 2, 3
  ), totals AS (
    SELECT cell_lat, cell_lng, sum(n)::int AS observations, count(*)::int AS distinct_names
      FROM tally GROUP BY 1, 2
  )
  SELECT DISTINCT ON (t.cell_lat, t.cell_lng) t.cell_lat, t.cell_lng, t.area, t.n,
         z.distinct_names, z.observations
    FROM tally t JOIN totals z USING (cell_lat, cell_lng)
   ORDER BY t.cell_lat, t.cell_lng, t.n DESC, (t.area ~ '[A-Za-z]') DESC, t.area`;

export async function refreshBookingCells(db = pool, { force = false } = {}) {
  if (!force) {
    const [age] = (await db.query(
      `SELECT count(*)::int AS cells, extract(epoch FROM (now() - max(built_at))) / 3600 AS hours
         FROM booking_cell`)).rows;
    const [{ votes }] = (await db.query('SELECT count(*)::int AS votes FROM place_vote')).rows;
    /* Empty with votes waiting is rebuilt now, not in six hours: the first
       pass on a fresh database casts its votes, and the next pass should name
       positions with them. */
    if (age && age.cells > 0 && Number(age.hours) < GAZ_MAX_AGE_HOURS) return { cells: age.cells, skipped: true };
    if (age && age.cells === 0 && votes === 0) return { cells: 0, skipped: true };
  }
  const pooled = typeof db.connect === 'function';
  const client = pooled ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM booking_cell');
    const { rowCount } = await client.query(
      `INSERT INTO booking_cell (cell_lat, cell_lng, area, n, distinct_names, observations, built_at)
       SELECT cell_lat, cell_lng, area, n, distinct_names, observations, now() FROM (${BOOKING_CELL_BUILD}) g`);
    await client.query('COMMIT');
    log.info('trip_places', 'booking gazetteer rebuilt', { cells: rowCount });
    return { cells: rowCount, skipped: false };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (pooled) client.release();
  }
}

/* What the pass needs in memory: both gazetteers (thousands of rows, not
   hundreds of thousands) and the vocabulary of area names the fleet already
   uses — place_area()'s answers stored in trip_place, plus every name
   place_cell holds (FMS's own addresses, which trip_place does not resolve).
   booking_cell is left out on purpose: its names are drop-off place_area()
   answers already counted through trip_place, and counting them twice would
   lift a name one trip produced over the two-observation floor. */
export async function loadContext(db = pool) {
  const cells = new Map();
  for (const r of (await db.query('SELECT cell_lat, cell_lng, area, n, observations FROM place_cell')).rows) {
    cells.set(`${r.cell_lat},${r.cell_lng}`, { area: r.area, votes: r.n, seen: r.observations, named_by: 'place_cell' });
  }
  const booking = new Map();
  const bc = (await db.query('SELECT cell_lat, cell_lng, area, n, observations, built_at FROM booking_cell')).rows;
  for (const r of bc) {
    booking.set(`${r.cell_lat},${r.cell_lng}`, { area: r.area, votes: r.n, seen: r.observations, named_by: 'booking_cell' });
  }
  const names = (await db.query(
    `SELECT name, sum(n)::int AS n FROM (
       SELECT pickup_area AS name, count(*) AS n FROM trip_place WHERE pickup_basis = 'address' GROUP BY 1
       UNION ALL SELECT dropoff_area, count(*) FROM trip_place WHERE dropoff_basis = 'address' GROUP BY 1
       UNION ALL SELECT area, sum(n) FROM place_cell GROUP BY 1) x
     WHERE name IS NOT NULL GROUP BY 1`)).rows;
  const counts = new Map(names.map((r) => [r.name, Number(r.n)]));
  const cellArea = (lat, lng) => {
    const k = `${cellOf(lat)},${cellOf(lng)}`;
    return booking.get(k) || cells.get(k) || null;
  };
  const bookingBuiltAt = bc.length ? bc.reduce((m, r) => (r.built_at > m ? r.built_at : m), bc[0].built_at) : null;
  return { counts, vocab: buildVocabulary(entries(counts)), cellArea, bookingBuiltAt };
}
const entries = (counts) => [...counts].map(([name, n]) => ({ name, n }));

const cancelledStatus = (s) => /cancel/i.test(String(s || ''));
const iso = (v) => (v == null ? null : new Date(v).toISOString());

/* One batch of trip rows → trip_place rows and votes. */
export async function resolveBatch(db, rows, ctx) {
  if (!rows.length) return { rows: 0, votes: 0, fixes: 0, by: {} };
  /* The address rung first, over the whole batch, and its names go into the
     vocabulary before the name rung runs — so a batch of a new community's
     first bookings can name that community's one-line addresses too. Only
     for bookings not already stored: a stored row's names were counted by
     loadContext, and a retried row counted again would inflate them. */
  let grew = false;
  for (const t of rows) {
    if (t.stored) continue;
    for (const col of ['pickup_addr', 'dropoff_addr']) {
      const r = resolveEndpoint({ addr: t[col] }, {});
      if (r.basis === 'address') { ctx.counts.set(r.area, (ctx.counts.get(r.area) || 0) + 1); grew = true; }
    }
  }
  if (grew) ctx.vocab = buildVocabulary(entries(ctx.counts));

  const input = (t, end) => (end === 'pickup'
    ? { addr: t.pickup_addr, lat: t.pickup_lat, lng: t.pickup_lng, plate: t.plate, at: iso(t.requested_at),
      scheduled: t.is_scheduled === true && !REQUEST_IS_PICKUP.has(t.platform) }
    : { addr: t.dropoff_addr, lat: t.dropoff_lat, lng: t.dropoff_lng, plate: t.plate, at: iso(t.ended_at),
      cancelled: cancelledStatus(t.status) });
  const first = rows.map((t) => ({ pickup: resolveEndpoint(input(t, 'pickup'), ctx), dropoff: resolveEndpoint(input(t, 'dropoff'), ctx) }));

  /* Which endpoints need the tracker: those only the tracker can still
     place, and every drop-off the address placed — that one is a VOTE for
     booking_cell, the car being at the drop-off at the drop-off time. */
  const asks = [];
  rows.forEach((t, i) => {
    if (first[i].pickup.needsFix) asks.push({ i, end: 'pickup', plate: t.plate, at: iso(t.requested_at) });
    const d = first[i].dropoff;
    if ((d.needsFix || d.basis === 'address') && t.plate && t.ended_at) {
      asks.push({ i, end: 'dropoff', plate: t.plate, at: iso(t.ended_at) });
    }
  });
  const fixOf = new Map();
  if (asks.length) {
    const r = await db.query(FIX_SQL, [asks.map((a) => a.plate), asks.map((a) => a.at), TRACKER_WINDOW_MIN]);
    for (const f of r.rows) {
      const a = asks[f.i - 1];
      fixOf.set(`${a.i}|${a.end}`, { lat: Number(f.lat), lng: Number(f.lng), source: f.source,
        at: iso(f.captured_at), minutes: Math.round(Number(f.minutes) * 10) / 10 });
    }
  }

  const out = [];
  const votes = [];
  const by = {};
  rows.forEach((t, i) => {
    const row = { platform: t.platform, external_id: t.external_id, fleet_id: t.fleet_id, inputs: t.inputs };
    for (const end of ['pickup', 'dropoff']) {
      let r = first[i][end];
      if (r.needsFix) r = resolveEndpoint({ ...input(t, end), fix: fixOf.get(`${i}|${end}`) ?? null }, ctx);
      row[`${end}_area`] = r.area;
      row[`${end}_basis`] = r.basis;
      row[`${end}_reason`] = r.reason;
      row[`${end}_named_by`] = r.named_by ?? null;
      row[`${end}_detail`] = r.detail;
      const k = `${end}:${r.basis || r.reason}`;
      by[k] = (by[k] || 0) + 1;
      if (end === 'dropoff' && r.basis === 'address') {
        const f = fixOf.get(`${i}|dropoff`);
        if (f) {
          votes.push({ platform: t.platform, external_id: t.external_id, fleet_id: t.fleet_id,
            cell_lat: cellOf(f.lat), cell_lng: cellOf(f.lng), area: r.area, minutes: f.minutes });
        }
      }
    }
    out.push(row);
  });

  /* Only trips that still exist: a trip deleted between the select and here
     would otherwise fail the whole batch on the foreign key. */
  await db.query(
    `INSERT INTO trip_place (platform, external_id, fleet_id,
       pickup_area, pickup_basis, pickup_reason, pickup_named_by, pickup_detail,
       dropoff_area, dropoff_basis, dropoff_reason, dropoff_named_by, dropoff_detail, inputs, resolved_at)
     SELECT r.platform, r.external_id, r.fleet_id,
            r.pickup_area, r.pickup_basis, r.pickup_reason, r.pickup_named_by, r.pickup_detail,
            r.dropoff_area, r.dropoff_basis, r.dropoff_reason, r.dropoff_named_by, r.dropoff_detail, r.inputs, now()
       FROM jsonb_to_recordset($1::jsonb) AS r(platform text, external_id text, fleet_id text,
              pickup_area text, pickup_basis text, pickup_reason text, pickup_named_by text, pickup_detail jsonb,
              dropoff_area text, dropoff_basis text, dropoff_reason text, dropoff_named_by text, dropoff_detail jsonb,
              inputs text)
      WHERE EXISTS (SELECT 1 FROM trip x WHERE x.platform = r.platform AND x.external_id = r.external_id)
     ON CONFLICT (platform, external_id) DO UPDATE SET
       fleet_id = EXCLUDED.fleet_id,
       pickup_area = EXCLUDED.pickup_area, pickup_basis = EXCLUDED.pickup_basis,
       pickup_reason = EXCLUDED.pickup_reason, pickup_named_by = EXCLUDED.pickup_named_by,
       pickup_detail = EXCLUDED.pickup_detail,
       dropoff_area = EXCLUDED.dropoff_area, dropoff_basis = EXCLUDED.dropoff_basis,
       dropoff_reason = EXCLUDED.dropoff_reason, dropoff_named_by = EXCLUDED.dropoff_named_by,
       dropoff_detail = EXCLUDED.dropoff_detail,
       inputs = EXCLUDED.inputs, resolved_at = now()`,
    [JSON.stringify(out)]);
  /* The batch's votes replace whatever these bookings voted before: a
     drop-off whose address changed, or lost its fix, takes its vote back. */
  await db.query(
    `DELETE FROM place_vote v USING jsonb_to_recordset($1::jsonb) AS r(platform text, external_id text)
      WHERE v.platform = r.platform AND v.external_id = r.external_id`,
    [JSON.stringify(out.map((r) => ({ platform: r.platform, external_id: r.external_id })))]);
  if (votes.length) {
    await db.query(
      `INSERT INTO place_vote (platform, external_id, fleet_id, cell_lat, cell_lng, area, minutes, voted_at)
       SELECT r.platform, r.external_id, r.fleet_id, r.cell_lat, r.cell_lng, r.area, r.minutes, now()
         FROM jsonb_to_recordset($1::jsonb) AS r(platform text, external_id text, fleet_id text,
                cell_lat int, cell_lng int, area text, minutes real)
        WHERE EXISTS (SELECT 1 FROM trip x WHERE x.platform = r.platform AND x.external_id = r.external_id)
       ON CONFLICT (platform, external_id) DO UPDATE SET cell_lat = EXCLUDED.cell_lat,
         cell_lng = EXCLUDED.cell_lng, area = EXCLUDED.area, minutes = EXCLUDED.minutes, voted_at = now()`,
      [JSON.stringify(votes)]);
  }
  return { rows: out.length, votes: votes.length, fixes: fixOf.size, by };
}

/* ── the three ways a booking becomes a candidate ─────────────────────── */
const freshSql = `
  SELECT ${COLS} FROM trip t
    LEFT JOIN trip_place tp ON tp.platform = t.platform AND tp.external_id = t.external_id
   WHERE t.platform <> 'fms' AND t.requested_at >= now() - make_interval(days => $1::int)
     AND (tp.platform IS NULL OR tp.inputs <> ${INPUTS('t')})
   ORDER BY t.requested_at DESC, t.platform, t.external_id
   LIMIT $2`;

/* $1 window minutes, $2 retry hours, $3 booking_cell built_at, $4 pass
   start (rows this pass already touched are not picked twice), $5 limit. */
const retrySql = `
  SELECT ${COLS} FROM trip_place tp
    JOIN trip t ON t.platform = tp.platform AND t.external_id = tp.external_id
   WHERE (tp.pickup_area IS NULL OR tp.dropoff_area IS NULL
          OR tp.pickup_named_by = 'place_cell' OR tp.dropoff_named_by = 'place_cell')
     AND tp.resolved_at < $4::timestamptz
     AND (
       (tp.pickup_reason LIKE '%+no_fix' AND EXISTS (
          SELECT 1 FROM telemetry_snapshot s
           WHERE s.plate = t.plate AND s.source IN ('fms', 'cabman')
             AND s.captured_at BETWEEN t.requested_at - make_interval(mins => $1::int)
                                   AND t.requested_at + make_interval(mins => $1::int)
             AND s.lat > 22 AND s.lat < 27 AND s.lng > 51 AND s.lng < 57))
       OR (tp.dropoff_reason LIKE '%+no_fix' AND EXISTS (
          SELECT 1 FROM telemetry_snapshot s
           WHERE s.plate = t.plate AND s.source IN ('fms', 'cabman')
             AND s.captured_at BETWEEN t.ended_at - make_interval(mins => $1::int)
                                   AND t.ended_at + make_interval(mins => $1::int)
             AND s.lat > 22 AND s.lat < 27 AND s.lng > 51 AND s.lng < 57))
       OR ((tp.pickup_area IS NULL OR tp.dropoff_area IS NULL)
           AND tp.resolved_at < now() - make_interval(hours => $2::int))
       OR ((tp.pickup_named_by = 'place_cell' OR tp.dropoff_named_by = 'place_cell')
           AND $3::timestamptz IS NOT NULL AND tp.resolved_at < $3::timestamptz))
   ORDER BY tp.resolved_at
   LIMIT $5`;

/* The history, newest first, behind a keyset cursor. The slice is read by
   the requested_at index and filtered to the rows that need work, so a sweep
   over an already-resolved history costs one index range and an md5 a row. */
const sweepSql = `
  SELECT ${COLS}, (tp.platform IS NULL OR tp.inputs <> ${INPUTS('t')}) AS needs
    FROM trip t
    LEFT JOIN trip_place tp ON tp.platform = t.platform AND tp.external_id = t.external_id
   WHERE t.platform <> 'fms' AND t.requested_at IS NOT NULL
     AND ($1::timestamptz IS NULL OR t.requested_at <= $1::timestamptz)
     AND ($1::timestamptz IS NULL OR (t.requested_at, t.platform, t.external_id) < ($1::timestamptz, $2::text, $3::text))
   ORDER BY t.requested_at DESC, t.platform DESC, t.external_id DESC
   LIMIT $4`;
const undatedSql = `
  SELECT ${COLS} FROM trip t
    LEFT JOIN trip_place tp ON tp.platform = t.platform AND tp.external_id = t.external_id
   WHERE t.platform <> 'fms' AND t.requested_at IS NULL
     AND (tp.platform IS NULL OR tp.inputs <> ${INPUTS('t')})
   LIMIT $1`;

export async function resolveTripPlaces(db = pool, {
  budgetMs = BUDGET_MS, batch = BATCH, freshDays = FRESH_DAYS, retryHours = RETRY_HOURS, sweepSlices = SWEEP_SLICES,
  now = () => Date.now(),
} = {}) {
  const t0 = now();
  /* The pass's start on the DATABASE's clock, not the worker's. The retry
     step skips rows this pass already touched by comparing resolved_at —
     written by the database's now() — with this instant; read off the
     worker's clock instead, a worker running even a second ahead of the
     database (two machines: an App Platform container and a managed
     Postgres) saw every row it had just re-resolved as older than the pass,
     picked it again, and spun on the same batch until the budget ran out
     (review 2026-11-16; test/trip_places.test.mjs pins it with a worker
     clock an hour fast). */
  const startedAt = (await db.query('SELECT now() AS t')).rows[0].t;
  const over = () => now() - t0 >= budgetMs;
  const stats = { fresh: 0, retried: 0, swept: 0, scanned: 0, votes: 0, fixes: 0, batches: 0, by: {}, sweep_wrapped: false };
  const add = (r) => {
    stats.votes += r.votes; stats.fixes += r.fixes; stats.batches++;
    for (const [k, v] of Object.entries(r.by)) stats.by[k] = (stats.by[k] || 0) + v;
  };

  const gaz = await refreshBookingCells(db);
  const ctx = await loadContext(db);
  stats.booking_cells = gaz.cells;

  // 2. fresh
  while (!over()) {
    const rows = (await db.query(freshSql, [freshDays, batch])).rows;
    if (!rows.length) break;
    add(await resolveBatch(db, rows, ctx));
    stats.fresh += rows.length;
    if (rows.length < batch) break;
  }
  // 3. retry
  while (!over()) {
    const rows = (await db.query(retrySql,
      [TRACKER_WINDOW_MIN, retryHours, ctx.bookingBuiltAt, startedAt, batch])).rows;
    if (!rows.length) break;
    add(await resolveBatch(db, rows, ctx));
    stats.retried += rows.length;
    if (rows.length < batch) break;
  }
  // 4. sweep
  let cur = null;
  try { cur = JSON.parse((await getState(db, 'sweep_cursor')) || 'null'); } catch { cur = null; }
  const cap = (await getState(db, 'sweep_completed_at')) ? sweepSlices : Infinity;
  let slices = 0;
  while (!over() && slices < cap) {
    slices++;
    const slice = (await db.query(sweepSql,
      [cur?.at ?? null, cur?.platform ?? null, cur?.external_id ?? null, batch * 4])).rows;
    if (!slice.length) {
      /* Off the oldest trip: the trips with no request time, once per sweep,
         then the cursor starts again from the newest. */
      const undated = (await db.query(undatedSql, [batch])).rows;
      if (undated.length) { add(await resolveBatch(db, undated, ctx)); stats.swept += undated.length; }
      cur = null;
      stats.sweep_wrapped = true;
      await setState(db, 'sweep_completed_at', new Date(now()).toISOString());
      break;
    }
    stats.scanned += slice.length;
    const todo = slice.filter((r) => r.needs);
    for (let i = 0; i < todo.length; i += batch) {
      add(await resolveBatch(db, todo.slice(i, i + batch), ctx));
      stats.swept += Math.min(batch, todo.length - i);
    }
    const last = slice[slice.length - 1];
    cur = { at: iso(last.requested_at), platform: last.platform, external_id: last.external_id };
  }
  await setState(db, 'sweep_cursor', JSON.stringify(cur));
  stats.ms = now() - t0;
  log.info('trip_places', 'pass', stats);
  return stats;
}

/* Exported for the tests: the grid the votes are cast on is src/places.js's,
   imported, never retyped (api/place_sql.js says why). */
export { CELL };
