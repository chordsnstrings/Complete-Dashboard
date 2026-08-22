/* The request window, in one place.
   ─────────────────────────────────────────────────────────────────────────
   Three copies of this lived in server.js, driver_routes.js and
   vehicle_routes.js — near-identical, and drifting. All three read `from` and
   `to` and nothing else.

   That is a problem because the URL a person sees says something different.
   The hash router carries `?days=30`, and the front end translates it into
   from/to before every fetch, so `days` never reaches the server. Ask the API
   directly — from a spreadsheet, a report, a monitoring check, or a debugging
   session — and `?days=30` is not rejected, not defaulted, but silently
   ignored: `from` falls back to 2000-01-01 and the answer is every trip the
   fleet has ever taken, wearing a thirty-day label. On one vehicle that read
   as 2,440 trips and 316 "days worked" inside a thirty-day window, which is
   only obviously wrong because a month has thirty days. The same silence over
   revenue or utilisation would just look like a big number.

   So `days` is honoured here, on the Dubai calendar the rest of the product
   uses, and `from`/`to` still win when given. */

/* Shape AND validity. Two of the three copies this replaces tested only the
   shape, so `from=2026-13-45` — month thirteen, day forty-five — matched the
   regex and was bound straight into SQL, where Postgres rejected the statement
   and the page showed "could not load this view". The round trip through Date
   is what separates a date-shaped string from a date. */
const isDay = (v) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// Dubai calendar day for an instant. The fleet's calendar is Dubai's; the
// caller's clock, and the server's UTC session, are not part of the question.
export const dubaiDay = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

/* A `days` window ends TODAY in Dubai and starts days-1 earlier, so `days=1`
   is today and `days=30` is thirty distinct calendar days — matching what the
   front end computes for the same number. An out-of-range or non-numeric
   `days` is ignored rather than clamped to something arbitrary: a caller who
   asked for `days=abc` gets the default window, not a silently invented one. */
export function daysWindow(v, now = Date.now()) {
  // Digits only. Number() would read "1e3" as 1000 and " 30\n" as 30; a query
  // parameter that does not look like a count should not be guessed at.
  if (!/^\d+$/.test(String(v ?? ''))) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 3660) return null;
  return [dubaiDay(new Date(now - (n - 1) * 864e5)), dubaiDay(new Date(now))];
}

/* Calendar-day bounds: `[from, to]` as YYYY-MM-DD, for queries that compare
   against local_day (a date) or apply their own timezone conversion. */
export function winDays(req, now = Date.now()) {
  if (isDay(req.query?.from) || isDay(req.query?.to)) {
    let from = isDay(req.query.from) ? req.query.from : '2000-01-01';
    let to = isDay(req.query.to) ? req.query.to : '2100-01-01';
    if (from > to) [from, to] = [to, from];   // an inverted range is a typo, not an empty set
    return [from, to];
  }
  return daysWindow(req.query?.days, now) || ['2000-01-01', '2100-01-01'];
}

/* Timestamp bounds for tables keyed on a raw timestamptz. The upper bound is
   widened to the end of the day, because a bare date binds as midnight and
   would drop everything that happened on the last day of the window. */
const endOfDay = (d) => (isDay(d) ? `${d} 23:59:59.999` : d);
export function win(req, now = Date.now()) {
  const [from, to] = winDays(req, now);
  return [from, endOfDay(to)];
}
