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
import { api, filterQuery } from './data.js';

/* Declining an offer and abandoning an accepted job are different behaviours
   and only the second leaves a rider standing in the street, so the driver
   column carries its own breakdown rather than one number for both. */
const driverDetail = (r) => {
  const bits = [];
  if (r.driver_after_accept) bits.push(`${fmt(r.driver_after_accept)} after accepting`);
  if (r.driver_cancelled_uber) bits.push(`${fmt(r.driver_cancelled_uber)} cancelled on Uber`);
  if (r.driver_declined_offer) bits.push(`${fmt(r.driver_declined_offer)} never took the offer`);
  return bits.join(' · ');
};

export async function renderCancellations(root) {
  root.innerHTML = '';
  loading(root);
  let d;
  try {
    d = await api(`/api/cancellations?${filterQuery('cancellations')}`);
  } catch (e) {
    root.innerHTML = '';
    root.append(note(`The cancellation list could not be read: ${String(e.message || e)}`));
    return;
  }
  root.innerHTML = '';

  const t = d.totals || {};
  root.append(kpiRow([
    { label: 'Cancellations', value: fmt(t.cancelled), sub: 'in this window' },
    { label: 'By the driver', value: fmt(t.by_driver),
      sub: t.cancelled ? `${Math.round((t.by_driver / t.cancelled) * 100)}% of them` : null },
    { label: 'By the rider', value: fmt(t.by_rider),
      sub: t.cancelled ? `${Math.round((t.by_rider / t.cancelled) * 100)}% of them` : null },
    /* Rendered even at zero — a zero here means "every channel in this window
       names its actor", which is a fact worth having, and a tile that vanishes
       when it is zero leaves a reader unsure whether it was measured. */
    { label: 'Nobody said who', value: fmt(t.unattributed || 0),
      sub: t.unattributed ? 'the channel does not report it' : 'every channel named the actor' },
  ]));

  const p = panel('Cancellations by driver',
    'Ordered by how many, over the window chosen above');
  const rows = d.rows || [];
  if (!rows.length) {
    p.body.append(note('No booking was cancelled in this window, on any channel.'));
    root.append(p.panel);
    return;
  }
  p.body.append(tableFrom(rows, [
    { label: 'Driver', key: 'driver_name',
      render: (r) => entity('driver', (r.driver_ext_ids || [])[0], r.driver_name || '(unnamed)') },
    /* The only thing on this page that may build a tel: href — ui.js's
       dialable() puts a stored 971… into E.164 so the phone actually dials.
       An absent number says the roster has none rather than rendering an
       em-dash that reads as a page fault. */
    { label: 'Phone', key: 'phone',
      render: (r) => (dialable(r.phone)
        ? `<a href="tel:${esc(dialable(r.phone))}">${esc(r.phone)}</a>`
        : '<span class="dim" title="No channel this driver works has filed a phone number">'
          + 'not on the roster</span>') },
    /* Uber's own rating, and it says WHOSE. A rating with no platform beside
       it invites the reader to assume it covers every channel they work. */
    { label: 'Rating', key: 'rating', num: true,
      absent: 'No channel has filed a rating for any driver in this window.',
      render: (r) => (r.rating == null ? '—'
        : `${Number(r.rating).toFixed(2)}<span class="dim"> ${esc(sourceLabel(r.rating_platform))}</span>`) },
    { label: 'Bookings', key: 'bookings', num: true },
    { label: 'Cancelled', key: 'cancelled', num: true,
      render: (r) => `${fmt(r.cancelled)}<span class="dim"> ${r.bookings
        ? `${Math.round((r.cancelled / r.bookings) * 100)}%` : ''}</span>` },
    { label: 'By the driver', key: 'by_driver', num: true,
      render: (r) => (r.by_driver
        ? pill(fmt(r.by_driver), r.by_driver >= 5 ? 'err' : 'warn', driverDetail(r) || undefined)
        : '—') },
    { label: 'By the rider', key: 'by_rider', num: true },
    { label: 'Nobody said who', key: 'unattributed', num: true,
      absent: 'Every cancellation in this window came from a channel that names who did it.',
      render: (r) => (r.unattributed
        ? pill(fmt(r.unattributed), null,
          `${(r.unattributed_platforms || []).map(sourceLabel).join(', ')} do not report who `
          + 'cancelled')
        : '—') },
  ], { sortable: true, defaultSort: { key: 'cancelled', dir: 'desc' } }));

  if (d.unattributed_why) p.body.append(note(d.unattributed_why));
  root.append(p.panel);
}
