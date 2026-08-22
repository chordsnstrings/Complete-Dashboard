/* Where the money is, and where it is missing.
   ─────────────────────────────────────────────────────────────────────────
   The fleet page's Revenue tile is the most misread number in this product,
   and it was misread for a reason: it is the sum of the fares reported on
   about a tenth of the trips, printed against all of them. Uber's trip export
   has no fare column at all and Uber is most of the fleet's work.

   This page exists so the question "what did we take?" has an answer with its
   working shown. Two kinds of money, never added together — gross fares
   charged to riders, and net payouts the platforms report after commission —
   and, per channel, which of the two we hold and how much of that channel's
   work it covers.

   The most useful row here is the one with nothing in it. A channel with
   thousands of bookings and no money is not an accounting problem, it is a
   collector that needs a credential, and naming it is the point. */
import { empty, fmt, hbars } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, money, pct, dayStr } from './ui.js';
import { q, href } from './data.js';

const BASIS = {
  fares: { label: 'measured', tone: 'ok',
    means: 'the provider reports a fare on essentially every booking, so this is what riders were charged' },
  payout: { label: 'payout', tone: 'warn',
    means: 'the provider reports no usable fare, so this is the net amount it says it paid the fleet — '
      + 'after its commission, and therefore smaller than what riders paid' },
  partial_fares: { label: 'partial', tone: 'warn',
    means: 'a fare on some bookings and nothing on the rest — this figure covers only the priced ones' },
  none: { label: 'dark', tone: 'critical',
    means: 'no fare on any booking and no payout reported: this channel’s money is not collected at all' },
};

export async function renderRevenue(root) {
  root.innerHTML = '';
  const host = el('div'); root.append(host); loading(host);
  const d = await q('/api/revenue');
  host.innerHTML = '';

  if (!d.platforms.length) return empty(host, 'No bookings on any channel in this window.');

  const t = d.totals;
  host.append(kpiRow([
    { label: 'Accounted for', value: t.accounted != null ? money(t.accounted) : '—',
      sub: `across ${fmt(t.accounted_bookings)} of ${fmt(t.bookings)} bookings`,
      tone: t.dark_pct == null ? null : t.dark_pct >= 50 ? 'critical' : t.dark_pct >= 10 ? 'warn' : 'good' },
    { label: 'Fares charged', value: t.fares != null ? money(t.fares) : '—',
      sub: `gross, over the ${fmt(t.priced_bookings)} bookings that report one` },
    { label: 'Payouts reported', value: t.payouts != null ? money(t.payouts) : '—',
      sub: 'net of platform commission — a different quantity, never added to the fares' },
    { label: 'Cash collected', value: t.cash != null ? money(t.cash) : '—',
      sub: 'already in the driver’s hand, owed back to the fleet' },
    { label: 'Tips', value: t.tips != null ? money(t.tips) : '—',
      sub: 'never appears in a trip feed — it comes from the payout tree' },
    { label: 'Bookings with no money', value: fmt(t.dark_bookings),
      sub: t.dark_pct != null ? `${pct(t.dark_pct, 1)} of the window` : null,
      tone: t.dark_bookings ? 'critical' : 'good' },
  ]));

  if (d.caveat) host.append(el('div', 'note err', esc(d.caveat)));

  /* ── per channel ─────────────────────────────────────────────────────── */
  const p = panel('What each channel tells us',
    'Two kinds of money, kept apart. "Basis" is which one this row is, and how far it can be trusted.');
  p.body.append(tableFrom(d.platforms, [
    { label: 'Channel', key: 'platform',
      render: (r) => `<a class="ent" href="${href('platforms')}">${esc(r.platform)}</a>` },
    { label: 'Bookings', key: 'bookings', num: true, render: (r) => fmt(r.bookings) },
    { label: 'Report a fare', key: 'priced_bookings', num: true,
      render: (r) => (r.bookings
        ? `${fmt(r.priced_bookings)}<span class="dim"> · ${pct(r.fare_coverage_pct, 0)}</span>`
        : '—') },
    { label: 'Fares (gross)', key: 'fares', num: true,
      render: (r) => (r.fares != null ? money(r.fares) : '<span class="dim">none reported</span>') },
    { label: 'Payout (net)', key: 'payouts', num: true,
      render: (r) => (r.payouts != null ? money(r.payouts) : '<span class="dim">not reported</span>') },
    { label: 'Per km', key: 'revenue_per_km', num: true,
      render: (r) => (r.revenue_per_km != null
        ? `${money(r.revenue_per_km, 'AED', 2)}<span class="dim"> over ${fmt(r.priced_km)} km</span>`
        : '—') },
    { label: 'Basis', key: 'basis',
      render: (r) => pill(BASIS[r.basis]?.label || r.basis, BASIS[r.basis]?.tone) },
    { label: 'Why', key: 'basis_note', render: (r) => `<span class="wrap dim">${esc(r.basis_note)}</span>` },
  ]));
  p.body.append(el('p', 'cap',
    'A fare is what the rider was charged. A payout is what the platform says it paid the fleet, '
    + 'after its own commission. They are different money and this page never adds them together — '
    + '"accounted for" above takes the better of the two per channel and says which it used.'));
  host.append(p.panel);

  /* ── what is missing, and what would fix it ──────────────────────────── */
  const missing = d.platforms.filter((r) => r.basis === 'none' || r.basis === 'partial_fares');
  if (missing.length) {
    const mp = panel('Channels whose money is not collected',
      'Each of these is a credential or an endpoint away from being measured, not an accounting problem.');
    mp.body.append(tableFrom(missing, [
      { label: 'Channel', key: 'platform' },
      { label: 'Bookings it carries', key: 'bookings', num: true, render: (r) => fmt(r.bookings) },
      { label: 'Share of the window', key: '_s', num: true,
        render: (r) => pct((r.bookings / (d.totals.bookings || 1)) * 100, 1) },
      { label: 'Drivers affected', key: 'drivers', num: true },
      { label: 'Vehicles affected', key: 'vehicles', num: true },
      { label: 'What is missing', key: 'basis_note',
        render: (r) => `<span class="wrap">${esc(BASIS[r.basis]?.means || r.basis_note)}</span>` },
    ]));
    mp.body.append(note('Until these are collected, every fleet-wide revenue figure in this product — '
      + 'here, on the overview, on each vehicle and each driver — is over what did land, and understates '
      + 'what the fleet actually took. The Data sources page shows which collector is failing and why.'));
    host.append(mp.panel);
  }

  /* ── the payout tree ─────────────────────────────────────────────────── */
  const top = (d.components || []).filter((c) => c.parent == null);
  const kids = (d.components || []).filter((c) => c.parent != null);
  if (top.length || kids.length) {
    const cp = panel('The payout, broken down',
      'What the platform actually paid and took back. Tips and tolls never appear in a trip feed at all.');
    if (top.length) {
      hbars(cp.body, top.map((c) => ({ label: `${c.platform}: ${c.category}`, n: Number(c.amount) })),
        { valueFmt: (v) => money(v) });
    }
    if (kids.length) {
      cp.body.append(tableFrom(kids.slice(0, 30), [
        { label: 'Channel', key: 'platform' },
        { label: 'Within', key: 'parent' },
        { label: 'Component', key: 'category' },
        { label: 'Amount', key: 'amount', num: true, render: (c) => money(c.amount, 'AED', 2) },
        { label: 'Drivers', key: 'drivers', num: true },
      ], { compact: true }));
    }
    host.append(cp.panel);
  } else {
    host.append(note('No payout breakdown has been collected for this window. It is the only place tips, '
      + 'tolls and cash clawbacks appear — the trip feeds carry none of them.'));
  }

  host.append(el('p', 'cap',
    `Window ${dayStr(`${d.window[0]}T12:00:00`)} – ${dayStr(`${d.window[1]}T12:00:00`)}, Dubai days.`));
}
