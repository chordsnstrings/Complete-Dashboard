/* Cancellations, per person, over the reader's own window.
   ──────────────────────────────────────────────────────────────────────────
   The operator's question is "who is cancelling, and was it them or the
   rider", and it has to be answerable per driver with a phone number beside
   it — the whole point is that a row ends in a phone call.

   api/cancellation_sql.js owns the attribution and explains, with the
   measurements, why Yango cancellations are counted into a THIRD bucket
   rather than assigned. This file adds the two things the page needs around
   it: the window, and the sentence that says what the numbers do not cover. */
import { win } from './window.js';
import { cancellationsSql } from './cancellation_sql.js';

export function cancellationRoutes(app, { q, wrap }) {
  app.get('/api/cancellations', wrap(async (req, res) => {
    const [from, to] = win(req);
    /* Bound on the same local_day the rest of the product groups by, not on
       requested_at directly: a window that means "this month" to the reader
       has to mean the Dubai month here, and trip_norm exists to stop every
       call site re-deriving that. */
    const rows = await q(cancellationsSql({
      where: 'n.requested_at >= $1 AND n.requested_at <= $2 AND n.is_booking',
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
        by_rider: rows.reduce((a, r) => a + (r.by_rider || 0), 0),
        unattributed: unattr,
      },
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
