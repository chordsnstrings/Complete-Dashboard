/* Building the gazetteer: what the fleet's own history calls each patch of
   ground.
   ─────────────────────────────────────────────────────────────────────────
   The question this exists to answer is "where was this car", asked of a
   telematics fix that arrives as nothing but a decimal pair. Every provider
   that names a place declines to position it, and the one provider that
   positions everything also happens to name it — so the names come from the
   history and not from a geocoding service:

     trip:uber       315,505 addresses,   0 coordinates
     timeline:uber   197,687 events,      0 coordinates
     trip:fms        222,543 trips,     100% coordinates AND an address
     trip:hotel        1,786 trips,      69% coordinates
     trip:yango           50 trips,      22% coordinates

   (measured on production 2026-09-07 through /api/coverage)

   Two properties make this better than an external geocoder here rather than
   merely cheaper. It covers exactly the roads this fleet drives, at the
   density it drives them; and every name it returns is a name that already
   appears on a trip in this database, so a place on the driver page and the
   same place on the Territory tab cannot be spelled two different ways.

   What it is NOT: a geocoder. It cannot name a coordinate the fleet has never
   driven near, and it says so rather than reaching for the closest thing it
   has. A cell with no observations renders absent with a reason. */
import { pool } from './db.js';
import { log } from './log.js';

/* About 555 m north-south, 503 m east-west at 25°N. Chosen to be smaller than
   any Dubai community and larger than any one building, because the mode over
   a cell is what lets "Business Bay" outvote "Rostamani Tower" — FMS names a
   building whenever the reverse geocode returned a three-segment address, and
   a person asking where a driver waited does not want the tower. */
export const CELL = 0.005;

export const cellOf = (v) => Math.round(Number(v) / CELL);

/* Dubai and the emirates around it. A fix outside this box is a bad fix — a
   tracker reporting 0,0 on boot is the common one — and letting it into the
   gazetteer would put a Dubai community name on the Gulf of Guinea. */
export const IN_UAE = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng)
  && lat > 22 && lat < 27 && lng > 51 && lng < 57;

const BOUNDS = 'lat > 22 AND lat < 27 AND lng > 51 AND lng < 57';

/* One statement, and it has to be one statement.
   ─────────────────────────────────────────────────────────────────────────
   Both endpoints of every positioned trip are an observation, so the source is
   a UNION ALL over pickup and dropoff. Then, per cell, the modal area — and
   the count of votes for it, the count of votes cast, and how many different
   names the cell ever saw. Those last three are the difference between a name
   400 trips agree on and a name one trip supplied, and the API refuses to
   print the second kind without saying so.

   DISTINCT ON with an ORDER BY that puts the most-voted name first is the
   cheapest mode in Postgres and does not need a window function over the whole
   set. The tie-break is the name itself, so a cell that is genuinely split
   50/50 resolves the same way on every rebuild instead of flapping between
   two names each time the collector runs. */
const BUILD = `
  WITH obs AS (
    SELECT pickup_lat AS lat, pickup_lng AS lng, place_area(pickup_addr) AS area
      FROM trip WHERE pickup_lat IS NOT NULL AND pickup_lng IS NOT NULL
    UNION ALL
    SELECT dropoff_lat, dropoff_lng, place_area(dropoff_addr)
      FROM trip WHERE dropoff_lat IS NOT NULL AND dropoff_lng IS NOT NULL
  ), named AS (
    SELECT (round(lat / ${CELL})::int) AS cell_lat,
           (round(lng / ${CELL})::int) AS cell_lng,
           area
      FROM obs
     WHERE area IS NOT NULL AND ${BOUNDS}
  ), tally AS (
    SELECT cell_lat, cell_lng, area, count(*)::int AS n
      FROM named GROUP BY 1, 2, 3
  ), totals AS (
    SELECT cell_lat, cell_lng, sum(n)::int AS observations,
           count(*)::int AS distinct_names
      FROM tally GROUP BY 1, 2
  )
  SELECT DISTINCT ON (t.cell_lat, t.cell_lng)
         t.cell_lat, t.cell_lng, t.area, t.n,
         z.distinct_names, z.observations
    FROM tally t JOIN totals z USING (cell_lat, cell_lng)
   ORDER BY t.cell_lat, t.cell_lng, t.n DESC, t.area`;

/* Rebuilt whole rather than merged, because a merge cannot express a name
   LOSING a vote: an address corrected upstream would leave the old name in the
   cell for ever, out-voting its own replacement. The table is small — one row
   per half-kilometre of road this fleet has driven — so a rebuild costs one
   scan and the truth is never stale.

   Inside a transaction, so a reader never sees the empty table between the
   delete and the insert. */
/* How stale the gazetteer is allowed to get.
   ─────────────────────────────────────────────────────────────────────────
   The collector runs every thirty minutes and this scans both endpoints of
   every positioned trip — 445,000 rows and climbing — to group them. Paying
   that forty-eight times a day, on a one-vCPU managed Postgres shared with
   every dashboard query, to relearn a map of Dubai that changed by a few
   cells, is not a trade worth making. The pool's statement_timeout is two
   minutes and this is exactly the kind of query that grows into it.

   Six hours, because the thing being rebuilt is a map of place names: a cell
   the fleet drove for the first time this morning is nameable this afternoon,
   which is the resolution the question actually has. An empty table is always
   rebuilt, so a fresh database is named on the first pass rather than in six
   hours' time. */
const MAX_AGE_HOURS = Number(process.env.PLACE_CELL_MAX_AGE_HOURS || 6);

export async function refreshPlaceCells(db = pool, { force = false } = {}) {
  if (!force) {
    /* One aggregate over a table with one row per half-kilometre of road this
       fleet has driven — thousands of rows, not hundreds of thousands. */
    const [age] = (await db.query(
      `SELECT count(*)::int AS cells,
              extract(epoch FROM (now() - max(built_at))) / 3600 AS hours
         FROM place_cell`)).rows;
    if (age && age.cells > 0 && Number(age.hours) < MAX_AGE_HOURS) {
      log.info('places', 'gazetteer still fresh — not rebuilt', {
        cells: age.cells,
        hours: Math.round(Number(age.hours) * 10) / 10,
        max_age_hours: MAX_AGE_HOURS,
      });
      return { cells: age.cells, skipped: true };
    }
  }
  return buildPlaceCells(db);
}

async function buildPlaceCells(db) {
  /* Same shape as src/rollup.js:520 and for the same reason. A pool hands out
     whichever backend is free per call, so BEGIN, DELETE and COMMIT issued
     through it can land on three different sessions and the DELETE autocommits
     on its own — a reader between the two statements meets an empty gazetteer
     and every position on the page loses its name. .connect() pins the
     sequence to one client. PGlite is a single session with no pool, so its
     own query() is already transactional and there is nothing to check out. */
  const pooled = typeof db.connect === 'function';
  const client = pooled ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM place_cell');
    const { rowCount } = await client.query(
      `INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations, built_at)
       SELECT cell_lat, cell_lng, area, n, distinct_names, observations, now() FROM (${BUILD}) g`);
    await client.query('COMMIT');
    const [{ areas, cells, obs }] = (await db.query(
      `SELECT count(DISTINCT area)::int areas, count(*)::int cells,
              coalesce(sum(observations), 0)::int obs FROM place_cell`)).rows;
    log.info('places', 'gazetteer rebuilt', { cells: rowCount, areas, obs });
    return { cells: rowCount ?? cells, areas, observations: obs };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    /* Only a pooled client is ours to hand back; releasing the caller's PGlite
       handle would be releasing the database itself. */
    if (pooled) client.release();
  }
}
