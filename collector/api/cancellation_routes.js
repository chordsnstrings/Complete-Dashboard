/* Cancellations, per person, over the reader's own window.
   ──────────────────────────────────────────────────────────────────────────
   The operator's question is "who is cancelling, and was it them or the
   rider", and it has to be answerable per driver with a phone number beside
   it — the whole point is that a row ends in a phone call.

   api/cancellation_sql.js owns the attribution and explains, with the
   measurements, why Yango cancellations are counted into a THIRD bucket
   rather than assigned. This file adds the two things the page needs around
   it: the window, and the sentence that says what the numbers do not cover. */
import { winDays } from './window.js';
import { cancellationsSql, OFFER_CHANNELS } from './cancellation_sql.js';

export function cancellationRoutes(app, { q, wrap }) {
  app.get('/api/cancellations', wrap(async (req, res) => {
    const [from, to] = winDays(req);
    /* BOUND ON local_day, WHICH IS THE DUBAI CALENDAR DATE — not on
       requested_at, which is an instant in UTC.
       ─────────────────────────────────────────────────────────────────────
       This comment already said that and the query underneath it did not.
       It bound `n.requested_at >= $1 AND n.requested_at <= $2` against the
       output of win(), which is a pair of naked date strings the server's
       UTC session reads as UTC midnights. sql/schema_v18.sql:84 builds
       local_day as (requested_at AT TIME ZONE 'Asia/Dubai')::date, so the
       two bounds are the same window slid four hours: a "day" here began at
       04:00 Dubai and ran to 03:59 the next morning. Every other windowed
       route in the product — twenty-seven call sites, all of them
       `local_day BETWEEN $1::date AND $2::date` — bounds the other way, so
       this page disagreed with all of them, and the shorter the window the
       larger the share of it that was wrong.

       MEASURED on production 2026-09-10, this endpoint against the daily
       rollup over identical windows (both count outcome = 'not_completed'):

         window            rollup   this page   out by
         today             77       65          -12   (-16%)
         yesterday         85       88           +3
         week (07-10)     354      343          -11
         month (01-10)    856      846          -10

       Today loses its own first four hours and has not yet reached the four
       it borrows from tomorrow, which is why the live figure was always the
       one most wrong — and the live figure is the one on screen. The fix is
       not a new rule, it is the rule everything else already follows.

       winDays() rather than win(): win() widens the upper bound to
       23:59:59.999 for exactly the timestamptz comparison being removed
       here, and against a date column that string would have to be cast
       back down again. */
    const rows = await q(cancellationsSql({
      where: 'n.local_day BETWEEN $1::date AND $2::date AND n.is_booking',
    }), [from, to]);

    /* WHAT THIS PAGE CANNOT TELL YOU, computed rather than asserted.
       If no Yango cancellation fell in the window the caveat is not printed —
       a warning about data that is not on screen trains people to skip
       warnings. */
    const unattr = rows.reduce((a, r) => a + (r.unattributed || 0), 0);
    const channels = [...new Set(rows.flatMap((r) => r.unattributed_platforms || []))].sort();

    res.json({
      from, to,
      rows,
      totals: {
        drivers: rows.length,
        cancelled: rows.reduce((a, r) => a + (r.cancelled || 0), 0),
        by_driver: rows.reduce((a, r) => a + (r.by_driver || 0), 0),
        /* The two halves of by_driver, reported apart because they are two
           different acts — see api/cancellation_sql.js, which carries the
           measurement. by_driver is kept beside them so the three-bucket total
           still adds up and so a caller written against the old shape is not
           broken by this. */
        dropped: rows.reduce((a, r) => a + (r.dropped || 0), 0),
        declined: rows.reduce((a, r) => a + (r.declined || 0), 0),
        by_rider: rows.reduce((a, r) => a + (r.by_rider || 0), 0),
        unattributed: unattr,
      },
      /* How many of these people are even on a channel that reports an offer.
         The page needs it to word the offers column honestly: "3 of 45 drivers
         in this window work a channel that files offers" is a different
         sentence from "42 drivers turned nothing down". */
      offer_channel_drivers: rows.filter((r) => r.on_offer_channel).length,
      offer_channels: OFFER_CHANNELS,
      /* One sentence, written here so the desktop and the phone cannot word
         the same limitation differently. */
      unattributed_why: unattr
        ? `${unattr} cancellation${unattr === 1 ? '' : 's'} in this window `
          + `${unattr === 1 ? 'came' : 'came'} from ${channels.join(' and ')}, which `
          + `file${channels.length === 1 ? 's' : ''} the bare word "cancelled" and never says `
          + 'who did it. They are counted and kept separate rather than being shared out — '
          + 'putting them on the rider would flatter every driver who works that channel, and '
          + 'putting them on the driver would accuse people on the strength of a word that does '
          + 'not say so.'
        : null,
    });
  }));
}
