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
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, money, pct,
  dayStr, dateStr, dtStr, sourceLabel, countOf, plural } from './ui.js';
import { q, href, hrefFilter, state } from './data.js';

const BASIS = {
  fares: { label: 'measured', tone: 'ok',
    means: 'the provider reports a fare on essentially every booking, so this is what riders were charged' },
  payout: { label: 'payout', tone: 'warn',
    means: 'the provider reports no usable fare, so this is the net amount it says it paid the fleet — '
      + 'after its commission, and therefore smaller than what riders paid' },
  partial_fares: { label: 'partial', tone: 'warn',
    means: 'a fare on some bookings and nothing on the rest — this figure covers only the priced ones' },
  partial_payout: { label: 'part-window', tone: 'warn',
    means: 'a real payout covering only part of the window — the rest of this channel’s money has not '
      + 'been collected yet, so the figure is right about the days it covers and silent about the others' },
  none: { label: 'dark', tone: 'critical',
    means: 'no fare on any booking and no payout reported: this channel’s money is not collected at all' },
};

export async function renderRevenue(root) {
  root.innerHTML = '';
  const host = el('div'); root.append(host); loading(host);
  const d = await q('/api/revenue');
  host.innerHTML = '';

  /* A channel with no booking is not the same as a channel that is not there.
     The endpoint returns only the channels with rows, so a filter that matches
     nothing produced a phantom row — `uber`, 0 bookings, tips 528 — because
     the tips query carries no platform predicate. The population this page
     describes is the channels that actually carry bookings. */
  const live = d.platforms.filter((r) => (+r.bookings || 0) > 0);
  if (!live.length) {
    const box = el('div', 'empty');
    box.innerHTML = state.platform
      ? `<b>No booking on ${esc(sourceLabel(state.platform))} in this window</b>`
        + 'That is a statement about this channel, not about the range: it either has no collector '
        + 'running or is being refused at the door.'
      : '<b>No booking on any channel in this window</b>Widen the range above, or check Data sources.';
    const links = el('p', 'cap');
    links.innerHTML = `<a class="lnk" href="${href('sources')}">Which collector is failing and why</a>`
      + (state.platform ? ` · <a class="lnk" href="${hrefFilter('revenue', { platform: '' })}">every channel</a>` : '');
    box.append(links);
    host.append(box);
    return;
  }

  const t = d.totals;
  host.append(kpiRow([
    { label: 'Accounted for', value: t.accounted != null ? money(t.accounted) : '—',
      sub: `across ${fmt(t.accounted_bookings)} of ${fmt(t.bookings)} bookings`,
      tone: t.dark_pct == null ? null : t.dark_pct >= 50 ? 'critical' : t.dark_pct >= 10 ? 'warn' : 'good' },
    { label: 'Fares charged', value: t.fares != null ? money(t.fares) : '—',
      sub: `gross, over the ${fmt(t.priced_bookings)} bookings that report one` },
    { label: 'Bank reconciliation', value: t.payouts != null ? money(t.payouts) : '—',
      sub: 'what the platforms wired to the bank — net of commission AND of cash already collected' },
    { label: 'On-trip revenue', value: t.statement_net != null ? money(t.statement_net) : '—',
      sub: t.statement_net != null
        ? 'gross minus commission, from the platform statement reports'
        : 'not yet collected for this window — comes from the platform statement reports' },
    /* Two sources of cash, added, with both named. This tile was `t.cash`
       alone — Yango's, because Uber's cash_earnings is null — so it read
       AED 1,505 on a window whose statements report AED 5,754 more. Three
       pages of this product carry a "cash" figure and no two of them agreed. */
    { label: 'Cash the platforms report',
      value: (t.cash != null || t.statement_cash != null)
        ? money((+t.cash || 0) + (+t.statement_cash || 0)) : '—',
      html: (t.cash != null || t.statement_cash != null)
        ? `<a class="ent" href="${href('settlement', 'cash')}">${esc(money((+t.cash || 0) + (+t.statement_cash || 0)))}</a>`
        : null,
      sub: [t.cash != null ? `${money(t.cash)} in the payout tree` : null,
        t.statement_cash != null ? `${money(t.statement_cash)} in the statements` : null]
        .filter(Boolean).join(' · ')
        + ' — already in a driver’s hand. Cash in hand lists who holds it.' },
    { label: 'Tips', value: t.tips != null ? money(t.tips) : '—',
      sub: 'never appears in a trip feed — it comes from the channel’s own statement' },
    /* The basis, not just the count. This tile reads 0 · 0.0% green at 7 and
       30 days and 234,790 · 99.4% red at 365, and nothing moved in the fleet:
       `chooseBasis` puts Uber on a payout basis while a payout covers the
       window and on nothing once the window reaches past the statements. The
       flip is the finding, so it is on the tile. */
    { label: 'Bookings with no money value', value: fmt(t.dark_bookings),
      sub: (t.dark_pct != null ? `${pct(t.dark_pct, 1)} of the window · ` : '')
        + `${countOf(live.filter((r) => r.basis === 'none').length, 'channel')} of `
        + `${fmt(live.length)} report no money at all`,
      tone: t.dark_bookings ? 'critical' : 'good' },
  ]));
  /* Why the tile above can be 0 one moment and 99% the next. */
  const flipped = live.filter((r) => r.basis === 'payout' || r.basis === 'partial_payout');
  if (flipped.length) {
    host.append(el('p', 'cap',
      `${flipped.map((r) => sourceLabel(r.platform)).join(', ')} `
      + `${plural(flipped.length, 'carries', 'carry')} no fare per booking and `
      + `${plural(flipped.length, 'is', 'are')} accounted for by payout instead. A payout covers DAYS, so `
      + 'widening the range past the statements we hold flips those bookings from accounted to dark in one '
      + 'step — the "no money value" tile moves by tens of thousands without anything changing in the '
      + 'fleet. Compare it across two ranges before reading it as a trend.'));
  }

  if (d.caveat) host.append(el('div', 'note err', esc(d.caveat)));

  /* ── per channel ─────────────────────────────────────────────────────── */
  const p = panel('What each channel tells us',
    'Two kinds of money, kept apart. "Basis" is which one this row is, and how far it can be trusted.');
  p.body.append(tableFrom(live, [
    /* The channel name carries which channel it is, and the link discarded it
       — all three names opened the same unfiltered #platforms, whose own
       caption then invited the reader to click a slice to filter by platform. */
    { label: 'Channel', key: 'platform',
      render: (r) => `<a class="ent" href="${hrefFilter('platforms', { platform: r.platform })}">${esc(sourceLabel(r.platform))}</a>` },
    { label: 'Bookings', key: 'bookings', num: true, render: (r) => fmt(r.bookings) },
    { label: 'Report a fare', key: 'priced_bookings', num: true,
      render: (r) => (r.bookings
        ? `${fmt(r.priced_bookings)}<span class="dim"> · ${pct(r.fare_coverage_pct, 0)}</span>`
        : '—') },
    { label: 'Fares (gross)', key: 'fares', num: true,
      render: (r) => (r.fares != null ? money(r.fares) : '<span class="dim">none reported</span>') },
    { label: 'Payout (net)', key: 'payouts', num: true,
      /* With the share of the WINDOW it covers, the population it was paid to,
         and the period it actually spans. A payout is over DAYS, not over
         bookings: three days of it on a thirty-day window is not the month,
         and a weekly period straddling the edge reaches past it — the payout
         column ran to 2026-08-30 on a window ending 08-25, over 217 paid
         drivers against 83 who drove. */
      render: (r) => (r.payouts == null ? '<span class="dim">not reported</span>'
        : `${money(r.payouts)}<span class="dim"> · ${r.payout_days || 0} of ${d.window_days} days`
          + `${r.payout_drivers != null ? ` · ${fmt(r.payout_drivers)} drivers paid` : ''}`
          + `${r.first_period ? `<br>${esc(dateStr(r.first_period))} → ${esc(dateStr(r.last_period))}` : ''}</span>`) },
    { label: 'On-trip (net)', key: 'statement_net', num: true,
      /* The statement view of the money, from the platform's own reports.
         Differs from the bank payout by the cash drivers hold plus tips and
         tolls; a 13% difference in a heavy-cash month is normal, not a bug.

         With the coverage it rests on. This column is identical at 7, 30 and
         365 days for Uber, because the statements we hold span nine days —
         so widening the window does not widen this figure and nothing said so. */
      render: (r) => (r.statement_net == null ? '<span class="dim">not collected</span>'
        : `${money(r.statement_net)}<span class="dim"> · cash ${r.statement_cash != null ? money(r.statement_cash) : '—'}`
          + `${r.statement_days != null ? ` · ${r.statement_days} of ${d.window_days} days` : ''}`
          + `${r.statement_drivers != null ? `, ${fmt(r.statement_drivers)} drivers` : ''}</span>`) },
    { label: 'Per km', key: 'revenue_per_km', num: true,
      render: (r) => (r.revenue_per_km != null
        ? `${money(r.revenue_per_km, 'AED', 2)}<span class="dim"> over ${fmt(r.priced_km)} km</span>`
        : '—') },
    { label: 'Basis', key: 'basis',
      render: (r) => pill(BASIS[r.basis]?.label || r.basis, BASIS[r.basis]?.tone) },
    { label: 'Why', key: 'basis_note', render: (r) => `<span class="wrap dim">${esc(r.basis_note)}</span>` },
  ], { sortable: true, sortId: 'chan', defaultSort: { key: 'bookings', dir: 'desc' } }));
  p.body.append(el('p', 'cap',
    'Three views of the same money, never added together. A fare is what the rider was charged. '
    + 'On-trip revenue is gross minus the platform’s commission — what the fleet EARNED, from the '
    + 'platform’s own statement reports. The bank reconciliation is what actually reached the '
    + 'account: on-trip net minus cash the drivers already collected, plus tips and toll '
    + 'reimbursements. Reconciled on July 2026 these agree to 0.7% once the cash is accounted for — '
    + 'a payout below the on-trip figure is drivers holding cash, not missing money. '
    + '"Accounted for" takes fares or payout per channel and says which.'));
  host.append(p.panel);

  /* ── what is missing, and what would fix it ──────────────────────────── */
  const missing = live.filter((r) => r.basis === 'none' || r.basis === 'partial_fares');
  if (missing.length) {
    const mp = panel('Channels whose money is not collected',
      'Each of these is a credential or an endpoint away from being measured, not an accounting problem.');
    mp.body.append(tableFrom(missing, [
      { label: 'Channel', key: 'platform', render: (r) => sourceLabel(r.platform) },
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

  /* ── a channel that reported NOTHING ─────────────────────────────────── */
  /* The panel above is built from `live`, which is d.platforms filtered to
     bookings > 0 — and the endpoint returns a row only for a channel that has
     rows. So a channel whose collector is being REFUSED produces no row at
     all, matches no filter, and disappears from the money page entirely.

     Measured live: bolt is configured on both fleets and has never delivered a
     booking, because the FI roster answers 503 NOT_AUTHORIZED for ecosine and
     egari's portal token is invalid. /api/revenue has been returning that in
     `silent_platforms` — platform, status, the error text and when it was last
     tried — and this page showed none of it. A reader saw three channels and
     concluded the fleet has three.

     Zero and absent are different facts, and on the page that totals the money
     the difference is whether a channel is small or shut. */
  const silent = d.silent_platforms || [];
  if (silent.length) {
    const sp = panel('Channels that reported nothing at all',
      'Configured on this fleet, carrying no booking in this window, and failing at the door. '
      + 'These are not small channels — they are channels nothing is reaching.');
    sp.body.append(tableFrom(silent, [
      { label: 'Channel', key: 'platform', render: (r) => esc(sourceLabel(r.platform)) },
      { label: 'Collector', key: 'collection_status',
        render: (r) => pill(r.collection_status || 'never run',
          r.collection_status === 'ok' ? 'ok' : r.collection_status ? 'bad' : 'warn') },
      { label: 'Last attempt', key: 'collection_at',
        render: (r) => (r.collection_at ? esc(dtStr(r.collection_at))
          : '<span class="ent-off" title="no collection run has ever been recorded for this channel">never</span>') },
      { label: 'What the channel said', key: 'collection_error',
        render: (r) => (r.collection_error
          ? `<span class="wrap dim">${esc(r.collection_error)}</span>`
          : '<span class="ent-off" title="the run finished without an error and still returned nothing">nothing — it simply returned no rows</span>') },
    ]));
    sp.body.append(note(`${countOf(silent.length, 'channel')} on this fleet ${
      plural(silent.length, 'is', 'are')} configured and silent. Nothing on this page counts `
      + 'them, so every total here is the fleet MINUS whatever they carry — which is unknown '
      + 'rather than zero. The Data sources page shows the credential or endpoint behind each.', 'warn'));
    const l = el('p', 'cap');
    l.innerHTML = `<a class="lnk" href="${href('sources')}">Which collector is failing and why →</a>`;
    sp.body.append(l);
    host.append(sp.panel);
  }

  /* ── the payout tree ─────────────────────────────────────────────────── */
  const top = (d.components || []).filter((c) => c.parent == null);
  const kids = (d.components || []).filter((c) => c.parent != null);
  if (top.length || kids.length) {
    const cp = panel('The payout, broken down',
      'What the platform actually paid and took back. Tips and tolls never appear in a trip feed at all.');
    if (top.length) {
      /* Negative amounts are drawn as deductions and not as magnitudes. The
         AED −10,248 cash clawback rendered an 886px bar beside the AED +33,905
         earnings bar at 899px, because a negative width is an invalid CSS
         declaration and the fill then filled its whole track. */
      hbars(cp.body, top.map((c) => ({ label: `${sourceLabel(c.platform)}: ${String(c.category).replace(/_/g, ' ')}`,
        n: Number(c.amount) })), {
        valueFmt: (v) => money(v),
        legend: [['--b400', 'paid to the fleet'], ['--s2', 'taken back — cash already collected, fees']] });
      const net = top.reduce((a, c) => a + (Number(c.amount) || 0), 0);
      cp.body.append(el('p', 'cap',
        `${countOf(top.length, 'top-level component')} netting to ${money(net)}. `
        + 'Everything in the table below is INSIDE one of these and is not added again.'));
    }
    if (kids.length) {
      const rootAmt = new Map(top.map((c) => [`${c.platform}|${c.category}`, Number(c.amount) || 0]));
      cp.body.append(tableFrom(kids.slice(0, 30).map((c) => ({ ...c,
        _share: rootAmt.get(`${c.platform}|${c.parent}`)
          ? (Number(c.amount) / rootAmt.get(`${c.platform}|${c.parent}`)) * 100 : null })), [
        { label: 'Channel', key: 'platform', render: (c) => esc(sourceLabel(c.platform)) },
        { label: 'Within', key: 'parent', render: (c) => esc(String(c.parent).replace(/_/g, ' ')) },
        { label: 'Component', key: 'category', render: (c) => esc(String(c.category).replace(/_/g, ' ')) },
        /* money() writes the sign now, so the amount goes in as it stands.
             This used to hand-write the minus and pass Math.abs, which is why
             this table looked right while every other negative money figure in
             the product carried an ASCII hyphen. */
        { label: 'Amount', key: 'amount', num: true,
          render: (c) => money(Number(c.amount), 'AED', 2) },
        { label: 'Share of its parent', key: '_share', num: true,
          render: (c) => (c._share == null
            ? '<span class="ent-off" title="the parent component was not returned for this window">—</span>'
            : pct(c._share, 1)) },
        { label: 'Drivers', key: 'drivers', num: true },
      ], { compact: true, sortable: true, sortId: 'payoutkids' }));
      if (kids.length > 30) {
        cp.body.append(el('p', 'cap',
          `Showing 30 of ${countOf(kids.length, 'nested component')}, largest first.`));
      }

      /* Why a share can read 100.9%, and what the children do not add up to.
         ─────────────────────────────────────────────────────────────────────
         Measured on this fleet: `earnings` is AED 33,905.19 and its children
         are net fare AED 34,198.82, taxes −AED 600.59 and tips AED 528.00. So
         the largest child is 100.9% of its parent, which reads as arithmetic
         that has gone wrong, and it has not — the parent is a NET, and a
         positive child can exceed it once a negative sibling is taken off.

         The children also sum to AED 34,126.23 against a parent of 33,905.19:
         a remainder of AED 221.04 that the platform does not itemise. That is
         a real fact about the statement and it was on no page. A reader adding
         the column up and landing 221 short had no way to tell whether the
         product had lost it. */
      const parents = [...new Set(kids.map((c) => `${c.platform}|${c.parent}`))];
      const gaps = parents.map((key) => {
        const total = rootAmt.get(key);
        if (!total) return null;
        const sum = kids.filter((c) => `${c.platform}|${c.parent}` === key)
          .reduce((a, c) => a + (Number(c.amount) || 0), 0);
        const diff = total - sum;
        /* A dirham of rounding is not a finding. */
        return Math.abs(diff) < 1 ? null : { name: String(key.split('|')[1]).replace(/_/g, ' '), diff };
      }).filter(Boolean);

      const anyOver = kids.some((c) => {
        const t = rootAmt.get(`${c.platform}|${c.parent}`);
        return t && Math.abs(Number(c.amount)) > Math.abs(t);
      });
      if (anyOver || gaps.length) {
        cp.body.append(el('p', 'cap',
          (anyOver
            ? 'A share above 100% is not an error: a parent here is a NET of its children, so a '
              + 'positive component can exceed it once a negative sibling — a tax, a clawback — is '
              + 'taken off. '
            : '')
          + (gaps.length
            ? `${gaps.map((g) => `<b>${esc(g.name)}</b> is ${money(Math.abs(g.diff))} `
              + `${g.diff > 0 ? 'more' : 'less'} than the components listed under it`).join('; ')}. `
              + 'The platform reports the parent and the parts separately and does not itemise the '
              + 'difference, so the column will not add up to the row above it.'
            : '')));
      }
    }
    host.append(cp.panel);
  } else {
    host.append(note('No payout breakdown has been collected for this window. It is the only place tips, '
      + 'tolls and cash clawbacks appear — the trip feeds carry none of them.'));
  }

  /* With the year. At 365 days this footer read "Window Aug 25 – Aug 25" for a
     range covering 2025-08-25 to 2026-08-25: two dates a year apart printed
     identically, on the line whose only job is to say which period the page is
     about. */
  host.append(el('p', 'cap',
    `Window ${dateStr(`${d.window[0]}T12:00:00`)} – ${dateStr(`${d.window[1]}T12:00:00`)}, `
    + `${countOf(d.window_days, 'Dubai day')} inclusive.`));
}
