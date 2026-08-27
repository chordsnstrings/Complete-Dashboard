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
   what window would fit, rather than handing back a plausible lie. */

/* The default cap. Overridable ONLY so a test can exercise the refusal against
   a handful of rows instead of needing to seed two hundred thousand — the
   alternative was a regex over this file asserting the refusal exists, which
   is a check that the words are present, not that the arithmetic is right. It
   was wrong: see the comment on the walk-back below. */
const MAX_ROWS = 200000;

/** RFC 4180: quote anything with a comma, quote or newline; double the quotes. */
function csvCell(v) {
  if (v == null) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, cols) {
  const out = [cols.map(csvCell).join(',')];
  for (const r of rows) out.push(cols.map((c) => csvCell(r[c])).join(','));
  /* A trailing newline: without it the last row is a line some tools drop. */
  return `${out.join('\n')}\n`;
}

export function exportRoutes(app, { q, wrap, winDays, maxRows = MAX_ROWS }) {
  app.get('/api/export/trips.csv', wrap(async (req, res) => {
    const [from, to] = winDays(req);
    const grain = req.query.grain === 'trip' ? 'trip' : 'day';
    const fleet = req.query.fleet || null;
    const platform = req.query.platform || null;
    const p = [from, to, platform, fleet];

    /* Counted before it is built. The refusal below needs a number, and a
       count over the same predicate is the only honest source for it. */
    const [{ n }] = await q(
      `SELECT count(*)::int n FROM trip_norm
        WHERE local_day BETWEEN $1::date AND $2::date AND is_booking
          AND ($3::text IS NULL OR platform = $3)
          AND ($4::text IS NULL OR fleet_id = $4)`, p);

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
          WHERE local_day BETWEEN $1::date AND $2::date AND is_booking
            AND ($3::text IS NULL OR platform = $3)
            AND ($4::text IS NULL OR fleet_id = $4)
          GROUP BY 1 ORDER BY 1 DESC`, p);
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

    const rows = grain === 'day'
      ? await q(
        /* One row per fleet per channel per day. Every measure is over
           BOOKINGS: the FMS feed is a telematics twin of journeys other
           channels already reported (sql/schema_v7.sql), so counting it would
           double the fleet. */
        `SELECT local_day::text AS day,
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
          WHERE local_day BETWEEN $1::date AND $2::date AND is_booking
            AND ($3::text IS NULL OR platform = $3)
            AND ($4::text IS NULL OR fleet_id = $4)
          GROUP BY 1, 2, 3, currency
          ORDER BY 1, 2, 3`, p)
      : await q(
        `SELECT local_day::text AS day, coalesce(fleet_id, 'unassigned') AS fleet,
                platform AS channel, external_id AS trip_id,
                requested_at, ended_at, driver_name, driver_ext_id, plate,
                pickup_addr, dropoff_addr, distance_km, product, payment_type,
                status, outcome, price, currency
           FROM trip_norm
          WHERE local_day BETWEEN $1::date AND $2::date AND is_booking
            AND ($3::text IS NULL OR platform = $3)
            AND ($4::text IS NULL OR fleet_id = $4)
          ORDER BY local_day, fleet_id, requested_at`, p);

    const cols = rows.length ? Object.keys(rows[0])
      : (grain === 'day'
        ? ['day', 'fleet', 'channel', 'bookings', 'completed', 'drivers', 'vehicles',
          'km', 'priced_bookings', 'fares', 'currency']
        : ['day', 'fleet', 'channel', 'trip_id', 'requested_at', 'ended_at', 'driver_name',
          'driver_ext_id', 'plate', 'pickup_addr', 'dropoff_addr', 'distance_km',
          'product', 'payment_type', 'status', 'outcome', 'price', 'currency']);

    /* The header row survives an empty result, so a window with no bookings
       downloads a file that says which columns it would have had rather than
       an empty one that reads as a broken export. */
    const name = `trips-${grain}-${from}-to-${to}${fleet ? `-${fleet}` : ''}`
      + `${platform ? `-${platform}` : ''}.csv`;
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    /* The window and the row count in headers, so a file saved months later
       can still say what it covers without opening it. */
    res.setHeader('x-export-window', `${from}..${to}`);
    res.setHeader('x-export-rows', String(rows.length));
    res.send(toCsv(rows, cols));
  }));
}
