/* The operator's statement ledger: an IMPORT, and the only source here that
   nothing schedules.
   ──────────────────────────────────────────────────────────────────────────
   Every other module in this directory is a poll. This one is a CSV out of the
   operator's own workbook, pushed through bin/import-ledger.mjs into
   POST /api/import/statement-days, and it is the only machine-readable record
   of the months the provider APIs no longer serve — Uber earnings before
   2026-02-09 — and the only source at all for the statement/treasury view of
   the money.

   WHY THIS FILE EXISTS.
   ──────────────────────────────────────────────────────────────────────────
   Read off production /api/status on 2026-09-02 11:30 UTC:

     ledger  ecosine  import  ok  39,797 rows  finished 2026-08-24 09:00 UTC

   — 218 hours old, beside `uber` and `fms` incrementals that had finished
   fourteen minutes earlier, and the Data-sources page printed a green
   "healthy" against it because the row carries no error. Nine days is not a
   fault here; it is what "nobody has exported a new workbook since Monday
   week" looks like, and there is nothing in src/index.js that schedules a
   ledger import (grep it: the word does not appear). /api/settings/jobs holds
   forty jobs and not one of them has mode 'import'.

   But the row cannot say that, and worse, two of its three numbers are not
   about the import at all. api/server.js records it as

     INSERT INTO collection_run (...)
     SELECT $1, 'ecosine', 'import', 'ok', count(*), now()
       FROM driver_statement_day WHERE source = $1

   so `rows_written` is a count of the WHOLE table and `fleet_id` is a
   hard-coded literal. 39,797 is how many statement-days are held in total, not
   how many the 24 August import wrote; it can only ever grow, so an import
   that landed nothing — an empty export, a workbook whose every row was
   rejected — records the same 39,797 under status 'ok' as one that landed
   everything. The one failure mode a person would want to hear about is the
   one this shape cannot express. bin/numbers-audit.mjs already caught the
   smell from the outside ("ledger imported 39,797 rows a hundred hours ago")
   without being able to say why.

   So: one run per fleet the workbook actually named, carrying the rows THIS
   import wrote and the span of days it covered, and a declared cadence of
   none, so a reader can tell a quiet importer from a broken one.

   NOTHING HERE POLLS. There is deliberately no collect() — an operator import
   has no window to fetch and no credential to expire, and a `collect` on this
   module would be the first thing a future scheduler loop picked up. */
import { logRun, pool } from '../db.js';
import { log } from '../log.js';

export const SOURCE = 'ledger';
export const MODE = 'import';

/* What this source's silence means, declared rather than inferred by whoever
   is reading the run table.
   ──────────────────────────────────────────────────────────────────────────
   Every staleness rule in the product — STALL_HOURS in api/auth_routes.js, the
   "stalest source last finished N h ago" line on the Data-sources page —
   assumes a source has a cadence to fall behind. This one does not. An age is
   still worth printing; what must not happen is that age being scored against
   a limit nobody set, which for the 12-hour default would paint this amber
   permanently and for ever, and an alarm that is always on is one nobody
   reads. */
export const CADENCE = {
  scheduled: false,
  kind: 'operator-import',
  /* Deliberately null, not a number. There is no interval at which a new
     workbook is due; the operator exports one when there is one. */
  expect_every_h: null,
  runs_via: 'bin/import-ledger.mjs → POST /api/import/statement-days',
  note: 'The ledger is an operator import, not a poll. Nothing schedules it, so '
    + 'an old last-import date means nobody has imported one — not that the '
    + 'importer has stopped. What would mean the importer is broken is an '
    + 'import that ran and wrote nothing, which is why recordImport() reports '
    + 'the rows THIS import wrote rather than the size of the table.',
};

/** The days the import covered, as YYYY-MM-DD strings, from the rows themselves.
    Dates are compared as strings on purpose: these arrive as the ISO day the
    CSV carried, and String(new Date(...)) yields "Thu Aug 07 2026", which is
    neither sortable nor storable. */
export function spanOf(rows = []) {
  let first = null, last = null;
  for (const r of rows) {
    const day = String(r?.date ?? r?.day ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (first === null || day < first) first = day;
    if (last === null || day > last) last = day;
  }
  return { first, last };
}

/* The tally an import keeps while it is running.
   ──────────────────────────────────────────────────────────────────────────
   The importer sends the workbook in batches of 400 — each one its own POST,
   answered by its own process — and only the LAST batch carries done:true. So
   the handler that records the run knows about 400 rows of a 39,797-row
   import, which is exactly why the count(*)-over-the-table form was reached
   for in the first place: it was the only number in scope that looked like the
   whole import.

   The tally is that missing number, accumulated in source_state rather than in
   a module variable, because App Platform may answer two batches on two
   instances and a variable would then hold half an import each. One row, read
   and rewritten per batch; the importer is sequential, so there is no second
   writer to race.

   A tally older than TALLY_STALE_H belonged to an import that died before its
   last batch. Folding those rows into the next import's count would report
   work the next import did not do, so it is dropped and started again — the
   dead import stays unrecorded, which is what "it never finished" means. */
export const TALLY_KEY = 'import_tally';
export const TALLY_STALE_H = 6;

const emptyTally = (nowMs) => ({
  started_at: new Date(nowMs).toISOString(), fleets: {}, first: null, last: null,
});

const readTally = async (db, source) => {
  const { rows } = await db.query(
    `SELECT value FROM source_state WHERE source = $1 AND fleet_id = '-' AND key = $2`,
    [source, TALLY_KEY]);
  if (!rows.length || !rows[0].value) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
};

/** Fold one batch into the running tally and return it.
    @param fleets  { [fleet_id]: rows this batch wrote for that fleet }
    @param days    { first, last } — the span this batch covered, from spanOf() */
export async function tallyBatch({ db = pool, source = SOURCE, fleets = {},
  days = {}, now = Date.now() } = {}) {
  const held = await readTally(db, source);
  const fresh = held && held.started_at
    && (now - Date.parse(held.started_at)) < TALLY_STALE_H * 36e5;
  const t = fresh ? { ...emptyTally(now), ...held, fleets: { ...(held.fleets || {}) } }
    : emptyTally(now);
  for (const [fleet, n] of Object.entries(fleets)) {
    if (!fleet) continue;
    t.fleets[fleet] = (Number(t.fleets[fleet]) || 0) + (Number(n) || 0);
  }
  /* ISO days compared as strings, for the reason spanOf() gives. */
  if (days.first && (t.first === null || days.first < t.first)) t.first = days.first;
  if (days.last && (t.last === null || days.last > t.last)) t.last = days.last;
  await db.query(
    `INSERT INTO source_state (source, fleet_id, key, value, updated_at)
     VALUES ($1, '-', $2, $3, now())
     ON CONFLICT (source, fleet_id, key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [source, TALLY_KEY, JSON.stringify(t)]);
  return t;
}

/** Read the tally and clear it, so the next import starts from nothing.
    Returns an empty tally when there is none — an import whose only batch
    carried done:true has already folded itself in, and one that wrote no rows
    at all must still be recorded, as a failure. */
export async function takeTally({ db = pool, source = SOURCE, now = Date.now() } = {}) {
  const { rows } = await db.query(
    `DELETE FROM source_state WHERE source = $1 AND fleet_id = '-' AND key = $2
     RETURNING value`, [source, TALLY_KEY]);
  if (!rows.length || !rows[0].value) return emptyTally(now);
  try { return { ...emptyTally(now), ...JSON.parse(rows[0].value) }; }
  catch { return emptyTally(now); }
}

/**
 * Record a finished statement import as a collection run.
 *
 * @param db      a pg pool or a PGlite handle — passed through to logRun so a
 *                test can drive this against a throwaway database, the same
 *                reason logRun itself takes one.
 * @param rows    { [fleet_id]: rowsWrittenForThatFleet }. The fleets the
 *                workbook actually named, each with its own count. NOT a total
 *                and NOT a table size.
 * @param days    { first, last } — the span the imported rows cover, from
 *                spanOf(). Stored as the run's window, so the Data-sources
 *                page can say WHICH months this import was for.
 * @returns the ids of the runs written, one per fleet.
 */
export async function recordImport({ db = pool, source = SOURCE, mode = MODE,
  rows = {}, days = {} } = {}) {
  const window_start = days.first || null;
  const window_end = days.last || null;
  const fleets = Object.keys(rows).filter((f) => f).sort();
  const total = fleets.reduce((a, f) => a + (Number(rows[f]) || 0), 0);

  /* An import that landed nothing gets a run of its own rather than no run at
     all. This is the case the count(*) form could never report — the table
     still holds everything the last import left, so the row said 39,797 and
     'ok' — and it is the only shape that means the importer is broken rather
     than idle. fleet_id null because no fleet was named: attributing an empty
     import to Ecosine is how the hard-coded literal lied in the first place. */
  if (!total) {
    const id = await logRun({
      source, fleet_id: null, mode, window_start, window_end,
      status: 'error', rows_written: 0,
      error: 'the import wrote no statement-days — every row was rejected, or the '
        + 'file held none. The ledger is the only record of the months the '
        + 'provider APIs no longer serve, so this is a lost import, not a quiet one.',
    }, db);
    log.warn(SOURCE, 'import wrote nothing', { source, window_start, window_end });
    return [id];
  }

  const ids = [];
  for (const fleet of fleets) {
    const n = Number(rows[fleet]) || 0;
    ids.push(await logRun({
      source, fleet_id: fleet, mode, window_start, window_end,
      status: n ? 'ok' : 'error', rows_written: n,
      /* A workbook that named a fleet and then carried nothing for it is worth
         saying out loud: on a two-fleet account that is how one business's
         whole month goes missing while the other's lands. */
      error: n ? null : `the workbook named ${fleet} and imported no day for it`,
    }, db));
  }
  log.info(SOURCE, 'import recorded', { source, fleets, total, window_start, window_end });
  return ids;
}

/**
 * The sentence a page should print about a ledger that has not been imported
 * lately — which is a different sentence from every other source's, because
 * there is no schedule to be behind.
 *
 * @param run  the latest ledger run row (or null if there has never been one)
 * @param now  ms, injected so this is testable without freezing the clock
 */
export function silence(run, now = Date.now()) {
  if (!run || !run.finished_at) {
    return { state: 'never',
      sentence: 'No statement ledger has ever been imported. The months before the '
        + 'provider APIs begin have no other source, so they are simply absent.' };
  }
  const ageH = Math.round((now - Date.parse(run.finished_at)) / 36e5);
  const days = Math.round(ageH / 24);
  /* An import that RAN and failed is the broken case, and it is the only one
     that should read as a fault. */
  if (run.status === 'error') {
    return { state: 'broken', age_h: ageH,
      sentence: `The last statement import, ${days} day(s) ago, wrote nothing: `
        + `${run.error || 'no reason recorded'}` };
  }
  return { state: 'idle', age_h: ageH,
    sentence: `The last statement ledger was imported ${days} day(s) ago`
      + (run.window_end ? `, covering days up to ${String(run.window_end).slice(0, 10)}` : '')
      + '. Nothing schedules this: it is a workbook an operator exports, so an '
      + 'old date means none has been exported since, not that the importer has stopped.' };
}
