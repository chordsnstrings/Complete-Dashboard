/* Who is cancelling, and whether it was them or the rider.
   ──────────────────────────────────────────────────────────────────────────
   Every row on this page ends in a phone call, which is why the phone number
   is a column and not a click-through: an operator working a cancellation
   list should not have to open twelve profiles to make twelve calls.

   THE THIRD COLUMN IS THE HONEST ONE. Uber and Bolt both say who cancelled —
   measured across six drivers over thirty days: uber rider_cancelled 111 and
   driver_cancelled 3; bolt client_cancelled 11, driver_cancelled_after_accept
   2, driver_did_not_respond 2, driver_rejected 1. Yango says only the bare
   word `cancelled` and nothing in its payload names an actor.

   So this page shows three buckets, not two. A driver/rider split alone would
   have to put Yango's somewhere, and both somewheres are lies: on the rider it
   flatters every driver who works that channel, on the driver it accuses
   people on the strength of a word that does not say so. The reason is printed
   under the table, from the API, and only when such a cancellation is actually
   in the window — a caveat about data nobody is looking at teaches people to
   skip caveats. */
import { el, esc, panel, loading, note, kpiRow, tableFrom, pill, fmt, entity,
  dialable, sourceLabel } from './ui.js';
/* q(), NOT api() + filterQuery(). filterQuery builds the query string for a
   LINK — it deliberately omits the window on views that hide the range
   control, and it is not what a page fetches with. params()/q() is, and every
   other page in this product uses it.

   Getting that wrong did not fail loudly: the page rendered, the table filled,
   and the numbers were the WHOLE RECORD. Production showed 68,194
   cancellations and 5,321 bookings against one driver under a URL that said
   `period=yesterday`, because with no window in the query the route falls back
   to 2000-01-01..2100-01-01. A window control that silently governs nothing is
   worse than no control: it tells the reader a figure is bounded when it is
   not. */
import { q } from './data.js';

/* Declining an offer and abandoning an accepted job are different behaviours
   and only the second leaves a rider standing in the street. They used to be
   one column with this breakdown in a hover, which meant the number on the
   page — and the sort that used it — added them.

   It should not have. Over 2026 to date, 5,307 of the fleet's 7,032
   driver-attributed cancellations are Bolt offers nobody picked up, against
   566 jobs accepted and then abandoned. Bolt files an offer as a row and Uber
   does not, so one column ranked people by which app they work: the driver at
   the top had 433 offers he did not take and 7 jobs he dropped, above every
   Uber driver who left a real rider waiting. A hover cannot fix a sort.

   So they are two columns now, and each says what it is made of. */
const droppedDetail = (r) => {
  const bits = [];
  if (r.driver_cancelled_uber) bits.push(`${fmt(r.driver_cancelled_uber)} cancelled on Uber`);
  if (r.driver_after_accept) bits.push(`${fmt(r.driver_after_accept)} abandoned after accepting`);
  /* The rate an operator can actually compare between two people, which is not
     the one in the Cancelled column: a Bolt driver's booking count includes
     offers they never took, so a share of bookings flatters and damns the same
     row at once. Over the jobs that reached them as a dispatch instead. */
  if (r.accepted) bits.push(`${Math.round((r.dropped / r.accepted) * 100)}% of the ${fmt(r.accepted)} jobs that reached them`);
  return bits.join(' · ');
};

/* Only Bolt files an offer at all, which is why this column is blank for most
   of the fleet and why a blank must say so. An Uber-only driver has no offers
   on record because Uber's export contains dispatched trips and the offers
   that preceded them are not in it — not because they took everything they
   were shown, which is what an em-dash here would let a reader conclude about
   a named person. */
const declinedCell = (r) => {
  if (r.declined) {
    return pill(fmt(r.declined), r.declined >= 20 ? 'warn' : null,
      'Offered and either declined or left unanswered. Bolt broadcasts an offer '
      + 'to several drivers at once, so one ride can be declined by several people, '
      + 'and nobody was left waiting by it.');
  }
  if (r.on_offer_channel) return '0';
  /* SHORT, because this cell is in every row of a ten-column table and the long
     form pushed the last column off a 1440px screen — the reader then has to
     scroll to find "Nobody said who", which is a worse outcome than a terse
     cell with the reason on hover. The reason is not hidden behind that hover:
     it is on the column's tile ("only Bolt reports these") and spelled out in
     full under the table. */
  return '<span class="dim" title="Only Bolt files the offers a driver was shown; '
    + 'Uber, Yango, the hotel channel and CABMAN report dispatched trips only. '
    + 'This driver worked no Bolt booking in this window, so there is nothing to '
    + 'count here — it does not mean they turned nothing down.">not reported</span>';
};

export async function renderCancellations(root) {
  root.innerHTML = '';
  loading(root);
  let d;
  try {
    d = await q('/api/cancellations');
  } catch (e) {
    root.innerHTML = '';
    root.append(note(`The cancellation list could not be read: ${String(e.message || e)}`));
    return;
  }
  root.innerHTML = '';

  const t = d.totals || {};
  root.append(kpiRow([
    { label: 'Cancellations', value: fmt(t.cancelled), sub: 'in this window' },
    /* Split, for the same reason the column is. One tile reading "by the
       driver" over a number that is three-quarters declined offers is the
       headline version of the same error. */
    { label: 'Dropped a job', value: fmt(t.dropped),
      sub: 'accepted, then ended by the driver' },
    { label: 'Turned down an offer', value: fmt(t.declined),
      sub: d.offer_channels?.length
        ? `only ${d.offer_channels.map(sourceLabel).join(' and ')} reports these`
        : 'no channel reports these' },
    { label: 'By the rider', value: fmt(t.by_rider),
      sub: t.cancelled ? `${Math.round((t.by_rider / t.cancelled) * 100)}% of them` : null },
    /* Rendered even at zero — a zero here means "every channel in this window
       names its actor", which is a fact worth having, and a tile that vanishes
       when it is zero leaves a reader unsure whether it was measured. */
    { label: 'Nobody said who', value: fmt(t.unattributed || 0),
      sub: t.unattributed ? 'the channel does not report it' : 'every channel named the actor' },
  ]));

  const p = panel('Cancellations by driver',
    'Ordered by the jobs somebody was left waiting for. Every column sorts.');
  const rows = d.rows || [];
  if (!rows.length) {
    p.body.append(note('No booking was cancelled in this window, on any channel.'));
    root.append(p.panel);
    return;
  }
  p.body.append(tableFrom(rows, [
    { label: 'Driver', key: 'driver_name',
      /* driver_ext_id, not driver_ext_ids[0]: the endpoint now returns a
         stable singular id for exactly this, so the link does not move
         between refreshes when array_agg happens to reorder. */
      render: (r) => entity('driver', r.driver_ext_id, r.driver_name || '(unnamed)') },
    /* The car the cancellation happened in — "which car were you in" is the
       next question after "why did you cancel", and it is the first thing a
       driver is asked. Only plates from CANCELLED bookings, so a plate here is
       one something went wrong in. */
    { label: 'Car', key: 'plates',
      absent: 'No cancelled booking in this window carries a plate.',
      render: (r) => {
        const ps = r.plates || [];
        if (!ps.length) return '<span class="dim">no plate on the booking</span>';
        return ps.slice(0, 2).map((x) => entity('vehicle', x, x)).join(' ')
          + (ps.length > 2 ? `<span class="dim"> +${ps.length - 2}</span>` : '');
      } },
    /* The only thing on this page that may build a tel: href — ui.js's
       dialable() puts a stored 971… into E.164 so the phone actually dials.
       An absent number says the roster has none rather than rendering an
       em-dash that reads as a page fault.

       The LINK TEXT is the normalised form too, not the raw column. It was
       the raw column, and the roster does not store one shape: on production
       2026-09-10 this table printed +971551667768 and 971561881739 in
       adjacent rows, three of the first fifteen missing the plus. Both dial —
       the href was always normalised — but a column of numbers where some
       carry a country-code marker and some do not reads as a column where
       some numbers are incomplete, and an operator working down it has to
       stop and check. The same substitution is made on the three other
       surfaces that print a phone, for the same reason. */
    { label: 'Phone', key: 'phone',
      render: (r) => (dialable(r.phone)
        ? `<a href="tel:${esc(dialable(r.phone))}">${esc(dialable(r.phone))}</a>`
        : '<span class="dim" title="No channel this driver works has filed a phone number">'
          + 'not on the roster</span>') },
    /* Uber's own rating, and it says WHOSE. A rating with no platform beside
       it invites the reader to assume it covers every channel they work. */
    { label: 'Rating', key: 'rating', num: true,
      absent: 'No channel has filed a rating for any driver in this window.',
      render: (r) => (r.rating == null ? '—'
        : `${Number(r.rating).toFixed(2)}<span class="dim"> ${esc(sourceLabel(r.rating_platform))}</span>`) },
    { label: 'Bookings', key: 'bookings', num: true },
    /* The percentage is over BOOKINGS, and for anyone on an offer-filing channel
       that denominator contains offers they never accepted. The figure is not
       wrong — it is "of everything put in front of you, how much did not
       happen" — but it is not comparable with an Uber-only driver's, whose
       bookings are all dispatches. Median over 2026: 64% across the 53 people
       who only work Bolt against 15% across the 68 who only work Uber. Said on
       the cell rather than footnoted, because the cell is where it is read. */
    { label: 'Cancelled', key: 'cancelled', num: true,
      render: (r) => `${fmt(r.cancelled)}<span class="dim"${r.on_offer_channel
        ? ' title="Of all bookings, which on Bolt includes offers this driver never'
          + ' accepted. Not comparable with a driver who only works a channel that'
          + ' reports dispatched trips."' : ''}> ${r.bookings
        ? `${Math.round((r.cancelled / r.bookings) * 100)}%` : ''}</span>` },
    /* The act an operator is ringing about: this person accepted a job and
       then ended it, and somebody was waiting for it. */
    { label: 'Dropped a job', key: 'dropped', num: true,
      absent: 'Nobody accepted a job and then ended it in this window.',
      render: (r) => (r.dropped
        ? pill(fmt(r.dropped), r.dropped >= 5 ? 'err' : 'warn', droppedDetail(r) || undefined)
        : '—') },
    /* A different act, on a channel most of the fleet does not work. */
    { label: 'Turned down an offer', key: 'declined', num: true,
      render: declinedCell },
    { label: 'By the rider', key: 'by_rider', num: true },
    { label: 'Nobody said who', key: 'unattributed', num: true,
      absent: 'Every cancellation in this window came from a channel that names who did it.',
      render: (r) => (r.unattributed
        ? pill(fmt(r.unattributed), null,
          `${(r.unattributed_platforms || []).map(sourceLabel).join(', ')} do not report who `
          + 'cancelled')
        : '—') },
    /* Sorted on the jobs somebody was left waiting for, matching the ORDER BY
       the endpoint already applies. This said `cancelled`, and a client-side
       defaultSort RE-SORTS the rows the server ordered — so the SQL change
       alone did nothing to what a reader sees, and the header marker said
       CANCELLED while the page claimed to be ordered by something else. Caught
       by rendering it, which is the only way that class of disagreement shows
       up at all. */
  ], { sortable: true, defaultSort: { key: 'dropped', dir: 'desc' } }));

  if (d.unattributed_why) p.body.append(note(d.unattributed_why));
  /* Printed WHENEVER the offers column has anything in it, because the column
     is the part of this page most easily misread: the two numbers beside each
     other invite a reader to add them, and they do not add to anything an
     operator should act on. Says how many of the people on screen are even on
     a channel that reports an offer, so the blanks are accounted for. */
  if (t.declined) {
    const ch = (d.offer_channels || []).map(sourceLabel).join(' and ') || 'no channel';
    p.body.append(note(
      `${fmt(t.declined)} of these are offers a driver declined or left unanswered, and `
      + `${ch} is the only channel that files them — `
      + `${fmt(d.offer_channel_drivers)} of the ${fmt(rows.length)} drivers here worked it in `
      + 'this window. They are shown apart from dropped jobs rather than added to them: '
      + 'an offer is broadcast to several drivers at once and refusing one leaves nobody '
      + 'waiting, while abandoning a job that was accepted does. Added together they rank '
      + 'a driver by which app they are on.'));
  }
  root.append(p.panel);
}
