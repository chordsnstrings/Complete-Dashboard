/* Getting the data OUT.
   ─────────────────────────────────────────────────────────────────────────
   Every figure in this product could be read on a page and none of it could
   be taken anywhere. There was no CSV, no download, no Content-Disposition
   anywhere in the API or the UI — so an operator who wanted last month's
   trips in a spreadsheet, or an accountant reconciling against their own
   ledger, had to read numbers off a screen and retype them.

   Two grains, because "daily trip data" means both things depending on who is
   asking. `day` is one row per fleet per channel per Dubai day, which is what
   a manager wants. `trip` is one row per booking, which is what somebody
   checking a specific journey wants. Both carry the fleet on every row, so
   one file covers both organisations rather than needing two exports stitched
   together — that was the actual question.

   Dubai days throughout, like every other calendar key here: the fleet works
   past midnight UTC and a UTC day would split its evenings in half.

   NO SILENT CAP. A truncated export is worse than a refused one, because a
   spreadsheet that is quietly missing its last ten thousand rows reads as
   complete. Over the limit this refuses and says how many rows there are and
   which window WOULD fit, rather than handing back a plausible lie. */
import { once } from 'node:events';

/* The default cap. Overridable ONLY so a test can exercise the refusal against
   a handful of rows instead of needing to seed two hundred thousand — the
   alternative was a regex over this file asserting the refusal exists, which
   is a check that the words are present, not that the arithmetic is right. It
   was wrong: see the comment on the walk-back below. */
const MAX_ROWS = 200000;

/* Declared, not discovered.
   ─────────────────────────────────────────────────────────────────────────
   The header used to be `Object.keys(rows[0])`, so an empty window fell back
   to a hand-written list kept in step by hope — two definitions of the file
   format, one of which only ran when there was no data to check it against.
   One list, used for the SELECT order, the header and every row. */
const COLS = {
  day: ['day', 'fleet', 'channel', 'bookings', 'completed', 'drivers', 'vehicles',
    'km', 'priced_bookings', 'fares', 'currency'],
  trip: ['day', 'fleet', 'channel', 'trip_id', 'requested_at', 'ended_at', 'driver_name',
    'driver_ext_id', 'plate', 'pickup_addr', 'dropoff_addr', 'distance_km',
    'product', 'payment_type', 'status', 'outcome', 'price', 'currency'],
};

/** RFC 4180: quote anything with a comma, quote or newline; double the quotes. */
function csvCell(v) {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* Written as a fold rather than `rows.map(...).join()` so no intermediate
   array of formatted lines exists beside the rows themselves. */
function csvChunk(rows, cols) {
  let out = '';
  for (const r of rows) {
    for (let i = 0; i < cols.length; i++) out += (i ? ',' : '') + csvCell(r[cols[i]]);
    out += '\n';
  }
  return out;
}

const WHERE = `local_day BETWEEN $1::date AND $2::date AND is_booking
                 AND ($3::text IS NULL OR platform = $3)
                 AND ($4::text IS NULL OR fleet_id = $4)`;

/* One row per fleet per channel per day. Every measure is over BOOKINGS: the
   FMS feed is a telematics twin of journeys other channels already reported
   (sql/schema_v7.sql), so counting it would double the fleet. */
const DAY_SQL = `
  SELECT local_day::text AS day,
         coalesce(fleet_id, 'unassigned') AS fleet,
         platform AS channel,
         count(*)::int AS bookings,
         count(*) FILTER (WHERE outcome = 'completed')::int AS completed,
         count(DISTINCT driver_ext_id)::int AS drivers,
         count(DISTINCT plate)::int AS vehicles,
         round(sum(distance_km) FILTER (WHERE has_distance)::numeric, 1) AS km,
         count(*) FILTER (WHERE has_fare)::int AS priced_bookings,
         round(sum(price) FILTER (WHERE has_fare)::numeric, 2) AS fares,
         currency
    FROM trip_norm
   WHERE ${WHERE}
   GROUP BY 1, 2, 3, currency
   ORDER BY 1, 2, 3`;

/* Bounded to ONE day, because that is the unit this streams in. */
const TRIP_DAY_SQL = `
  SELECT local_day::text AS day, coalesce(fleet_id, 'unassigned') AS fleet,
         platform AS channel, external_id AS trip_id,
         requested_at, ended_at, driver_name, driver_ext_id, plate,
         pickup_addr, dropoff_addr, distance_km, product, payment_type,
         status, outcome, price, currency
    FROM trip_norm
   WHERE local_day = $1::date AND is_booking
     AND ($2::text IS NULL OR platform = $2)
     AND ($3::text IS NULL OR fleet_id = $3)
   ORDER BY fleet_id, requested_at, external_id`;

export function exportRoutes(app, { q, wrap, winDays, maxRows = MAX_ROWS, log = null }) {
  app.get('/api/export/trips.csv', wrap(async (req, res) => {
    const [from, to] = winDays(req);
    const grain = req.query.grain === 'trip' ? 'trip' : 'day';
    const fleet = req.query.fleet || null;
    const platform = req.query.platform || null;
    const p = [from, to, platform, fleet];
    const cols = COLS[grain];

    /* Counted before it is built. The refusal below needs a number, and a
       count over the same predicate is the only honest source for it. */
    const [{ n }] = await q(`SELECT count(*)::int n FROM trip_norm WHERE ${WHERE}`, p);

    if (grain === 'trip' && n > maxRows) {
      /* The window that WOULD fit, found rather than extrapolated.
         ─────────────────────────────────────────────────────────────────
         This scaled the requested day count by the row ratio, which assumes
         bookings are spread evenly across the window — and they are not, in
         the one direction that matters. Asked for 1,200 days it answered
         "about 1,007 days would fit" over a record only 863 days long: every
         one of those 1,007 days holds the same 238,330 rows, so following the
         advice reproduces the refusal exactly. A suggestion that cannot work
         is worse than none, because the reader spends a round trip on it.

         Counting per day and walking back from the most recent one is exact
         and costs a grouped count over the same predicate. Whole days only,
         so the boundary is a date somebody can type. */
      const perDay = await q(
        `SELECT local_day::text d, count(*)::int c FROM trip_norm
          WHERE ${WHERE} GROUP BY 1 ORDER BY 1 DESC`, p);
      let acc = 0, start = null;
      for (const r of perDay) {
        if (acc + r.c > maxRows) break;
        acc += r.c; start = r.d;
      }
      /* A single day over the limit has no narrower window to offer, so it
         gets the other two routes out and no date. */
      const fits = start
        ? `The most recent ${start} → ${to} would fit, at ${acc.toLocaleString('en')} rows.`
        : 'Even one day of this selection is over the limit.';
      return res.status(413).json({
        error: 'too many rows for one file',
        rows: n, limit: maxRows,
        fits_from: start, fits_to: start ? to : null, fits_rows: start ? acc : null,
        detail: `${n.toLocaleString('en')} bookings match this window, over the `
          + `${maxRows.toLocaleString('en')}-row limit. ${fits} Or export one fleet `
          + 'or one channel at a time, or use grain=day.',
      });
    }

    /* The day grain is bounded by days × fleets × channels — a year is a few
       thousand rows — so it is one query, run BEFORE the headers go out.
       x-export-rows must count rows in the FILE, and at this grain that is the
       number of groups, not the number of bookings behind them: reporting `n`
       here said 6 over a two-day file holding 4 lines. */
    const dayRows = grain === 'day' ? await q(DAY_SQL, p) : null;

    const name = `trips-${grain}-${from}-to-${to}${fleet ? `-${fleet}` : ''}`
      + `${platform ? `-${platform}` : ''}.csv`;
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    /* The window and the row count in headers, so a file saved months later
       can still say what it covers without opening it. Set BEFORE the first
       byte goes out, because after that they cannot be set at all — which is
       why the streaming grain takes its count from the count query rather than
       from the rows it has not read yet. */
    res.setHeader('x-export-window', `${from}..${to}`);
    res.setHeader('x-export-rows', String(dayRows ? dayRows.length : n));
    /* The header row survives an empty result, so a window with no bookings
       downloads a file that says which columns it would have had rather than
       an empty one that reads as a broken export. */
    res.write(`${cols.join(',')}\n`);

    if (dayRows) {
      res.write(csvChunk(dayRows, cols));
      return res.end();
    }

    /* ── the trip grain STREAMS, one Dubai day at a time ───────────────────
       This built the whole file in memory: 200,000 pg row objects, then a
       single 72MB string, on a 512MB instance. It did not time out — it was
       OOM-killed, the container restarted, and the platform answered 504
       after ten seconds. The download the refusal above had just recommended
       as the window that fits was the one that killed the process.

       A day is the natural chunk: it is already the sort key, it is a few
       hundred rows, and there is an index on it (sql/schema_v7.sql). Memory
       stays flat at one day of rows however long the window is, and the
       header goes out immediately rather than after the last row is read.

       Backpressure is honoured — without awaiting 'drain' the whole file
       accumulates in the socket's write buffer instead, which is the same
       memory bug one layer down. */
    const days = await q(
      `SELECT DISTINCT local_day::text d FROM trip_norm WHERE ${WHERE} ORDER BY 1`, p);
    try {
      for (const { d } of days) {
        /* The reader closed the tab. Every further query is work nobody will
           ever see, and on a long export that is minutes of it. */
        if (res.destroyed || res.writableEnded) return;
        const rows = await q(TRIP_DAY_SQL, [d, platform, fleet]);
        if (!res.write(csvChunk(rows, cols))) await once(res, 'drain');
      }
    } catch (e) {
      /* A failure AFTER the first byte cannot become a 500 — the status line
         is long gone, and wrap()'s res.status(500).json() would only raise
         ERR_HTTP_HEADERS_SENT on top of it. Ending the stream normally is
         worse still: it hands back a file that is short and looks complete,
         which is the exact lie this endpoint exists to avoid. So the
         connection is destroyed and the client sees an aborted transfer. */
      log?.error?.('api', '/api/export/trips.csv failed mid-stream',
        { err: String(e?.message || e) });
      return res.destroy();
    }
    res.end();
  }));
}
