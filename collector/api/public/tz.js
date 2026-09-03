/* The fleet's clock.
   ─────────────────────────────────────────────────────────────────────────
   Every calendar key the API computes is Asia/Dubai: local_day, local_hour,
   local_dow, the custody day, the demand heatmap. The browser's formatters
   default to the VIEWER's zone, so the two disagreed on the same screen — for
   anyone outside the Gulf a segment starting at 17:00 Dubai printed as 13:00
   beside an hour-of-day chart whose peak was at 17, a shift read three hours
   early, and a booking after midnight Dubai landed on the previous date.

   Its own module rather than a constant in ui.js, because data.js needs it to
   build the shared window and ui.js already imports data.js — putting it there
   made a cycle out of two files that had no business referring to each other. */
export const TZ = 'Asia/Dubai';
export const TZ_LABEL = 'Dubai time (GST, UTC+4)';

/* A date in Dubai, as YYYY-MM-DD. `new Date().toISOString().slice(0, 10)` is
   the UTC day: at 02:00 in Dubai it is still yesterday in UTC, so the shared
   window ended a day early and dropped the shift in progress — on the one page
   somebody opens at 2am to see what is happening now. */
/* Takes what callers actually hold: a Date, or the ISO STRING an API row
   carries. Intl's format() accepts only Dates and numbers — handed a string it
   coerces via Number, gets NaN, and throws "Invalid time value", which is a
   RangeError with no mention of who called or with what. Every trip timestamp
   in the product passes through here on its way to a replay link, so that
   throw took the whole Drivers trips tab down with it. Unparseable input
   returns null and the caller shows plain text instead of a link. */
export const dubaiDay = (d = new Date()) => {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA',
    { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt);
};

/* The Dubai wall clock, as {hour, minute}. Never the viewer's: a reader in
   London opening this at 21:00 is being shown tomorrow in Dubai.

   Lives here rather than in api/public/app.js because BOTH shells need it and
   only one had it. The phone printed "0 bookings a day" on a today-only window
   where the desktop printed "523 bookings so far today, as of 17:18 Dubai" —
   the desktop had the rule and the clock to say it with, and the phone had
   neither. A rule kept in one shell is a rule the other shell will contradict. */
export const dubaiClock = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ,
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const at = (t) => Number(parts.find((x) => x.type === t)?.value);
  return { hour: at('hour'), minute: at('minute'),
    hhmm: `${String(at('hour')).padStart(2, '0')}:${String(at('minute')).padStart(2, '0')}` };
};
