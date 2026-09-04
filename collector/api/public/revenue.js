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
  dayStr, dateStr, dtStr, sourceLabel, countOf, plural, verdict, andList } from './ui.js';
import { q, href, hrefFilter, state } from './data.js';
import { revenueVerdict } from './verdicts.js';

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
  const host = el('div', 'stack'); root.append(host); loading(host);
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

  /* What the accounted total is actually measured OVER, per channel.
     ─────────────────────────────────────────────────────────────────────────
     A fare is measured over BOOKINGS and a payout is measured over DAYS, and
     "Accounted for" is a sum of both. Its sub-line read "across 234,499 of
     234,499 bookings", which is true of the population and false about the
     measurement: on production 2026-09-02T13:16Z, /api/revenue?days=365 puts
     AED 2,401,822.21 of that AED 2,533,853.13 on uber's net payout, which was
     never measured per booking at all and covers 209 of the 365 days uber
     worked. So the tile names both bases, and each one's own denominator.

     Built from the channel rows rather than from a total, because the
     denominator differs per channel — payout_coverage_base is the days THAT
     channel worked, not the length of the window (see api/income_sql.js
     coverage()). */
  const paidRows = live.filter((r) => r.basis === 'payout' || r.basis === 'partial_payout');
  const payoutSpan = paidRows
    .map((r) => `${fmt(r.payout_coverage_days ?? r.payout_days ?? 0)} of the `
      + `${fmt(r.payout_coverage_base ?? d.window_days)} days ${sourceLabel(r.platform)} worked`)
    .join(', and ');
  const underRows = live.filter((r) => r.basis === 'partial_payout');

  /* This page exists to say which channels report money and which do not, and
     it opened on six tiles of totals. The single most misread figure in the
     product is "money in", and the reason it is misread is DARK bookings — work
     that happened and that no channel has told us the price of. */
  {
    const v = revenueVerdict({ platforms: d.platforms, totals: t });
    const { dark0, payoutOnly, lead, leadPct } = { dark0: v.dark, payoutOnly: v.payoutOnly, lead: v.lead, leadPct: v.leadPct };
    let claim, figure, unit, tone = null, recommend = null;
    if (v.branch === 'dark') {
      tone = 'bad';
      const n = v.darkBookings;
      claim = `${andList(dark0.map((r) => sourceLabel(r.platform)))} `
        + `${dark0.length === 1 ? 'reports' : 'report'} work and no money anywhere`;
      figure = fmt(n); unit = 'bookings, no money';
      recommend = 'Neither a fare nor a payout statement covers them, so nothing this product '
        + 'reports about revenue includes that work.';
    } else if (v.branch === 'payout-only') {
      tone = 'warn';
      const n = v.payoutOnlyBookings;
      claim = `${andList(payoutOnly.map((r) => sourceLabel(r.platform)))} `
        + `${payoutOnly.length === 1 ? 'reports' : 'report'} no fare on the trip itself`;
      figure = fmt(n); unit = 'bookings, no fare';
      recommend = 'Their money arrives in the weekly payout statement instead — which is what '
        + '"Bank reconciliation" and "On-trip revenue" above are reading. Any figure divided by '
        + 'a booking count is over the minority of trips that carry a price.';
    } else {
      claim = leadPct >= 80
        ? `${sourceLabel(lead.platform)} is ${leadPct}% of the work and ${
          t.accounted ? money(t.accounted) : 'no money'} of the money`
        : `${fmt(live.length)} channels reported money this window`;
      figure = t.accounted != null ? money(t.accounted) : '—'; unit = 'accounted for';
    }
    verdict(host, {
      claim, figure, unit, tone, recommend,
      meta: `${fmt(t.bookings)} bookings`,
      /* "have a price behind them" was the same overclaim as the tile below:
         accounted_bookings is every booking on a channel whose money we hold,
         and on production 232,832 of those 234,499 are held as a weekly payout
         with no per-booking price anywhere. The sentence now says which. */
      sub: `${fmt(t.accounted_bookings)} of ${fmt(t.bookings)} bookings are on a channel whose money `
        + 'we hold'
        + `${t.priced_bookings != null
          ? `, and ${fmt(t.priced_bookings)} of them carry a fare on the trip itself — the rest are `
            + 'covered by a payout, which is measured over days'
          : ''}.`,
    });
  }

  host.append(kpiRow([
    { label: 'Accounted for', value: t.accounted != null ? money(t.accounted) : '—',
      sub: [
        /* accounted_fare_bookings, not the fleet's priced_bookings: a channel
           that prices every booking can still be counted on its payout, and
           its bookings do not belong under a fares figure they are not in. */
        t.accounted_fares
          ? `${money(t.accounted_fares)} in fares over `
            + `${fmt(t.accounted_fare_bookings ?? t.priced_bookings)} priced bookings`
          : null,
        t.accounted_payouts
          ? `${money(t.accounted_payouts)} in net payout over ${payoutSpan || 'the days it covers'}`
          : null,
      ].filter(Boolean).join(' · ')
        || `across ${fmt(t.accounted_bookings)} of ${fmt(t.bookings)} bookings`,
      /* An under-covered payout is not dark, so dark_pct alone now reads this
         tile green on the 365-day window where 99.3% of the bookings sit on a
         payout covering 57.3% of the days. The second clause keeps that amber
         rather than letting the honest split quietly upgrade the tone. */
      tone: t.dark_pct == null ? null
        : t.dark_pct >= 50 ? 'critical'
          : (t.dark_pct >= 10 || (t.undercovered_pct || 0) >= 10) ? 'warn' : 'good' },
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
    /* Bookings with NO money, and separately bookings whose money does not
       reach across the window. These were one number and it contradicted the
       tile four places to its left.
       ─────────────────────────────────────────────────────────────────────
       Measured 2026-09-02T13:16Z on /api/revenue?days=365: this tile read
       "232,832 — 99.3% of the window" while "Accounted for" read "AED
       2,533,853 across 234,499 of 234,499 bookings". The same 232,832 uber
       rows were in both, because fleetIncome counted a partial_payout channel
       as measured AND as dark. They are not dark: uber's payout is AED
       2,401,822.21 of real money, and what is wrong with it is that it covers
       209 of the 365 days uber worked. api/income_sql.js now splits the two,
       so this tile counts only absent money — basis `none` and the unpriced
       half of `partial_fares` — and the under-covered channels get the second
       clause instead of being reported as having nothing.

       Which is why the tile no longer flips from 0 to 99% as the range widens
       past the statements. The flip moves to the clause below, where it is
       described rather than counted as darkness. */
    { label: 'Bookings with no money value', value: fmt(t.dark_bookings),
      sub: [
        (t.dark_pct != null ? `${pct(t.dark_pct, 1)} of the window · ` : '')
          /* "1 channel of 4 report no money at all" — the verb agrees with the
             count, not with the denominator. */
          + `${countOf(live.filter((r) => r.basis === 'none').length, 'channel')} of `
          + `${fmt(live.length)} ${plural(live.filter((r) => r.basis === 'none').length,
            'reports', 'report')} no money at all`,
        t.undercovered_bookings
          ? `${fmt(t.undercovered_bookings)} more are covered by a payout that reaches `
            + `${underRows.map((r) => `${fmt(r.payout_coverage_days)} of ${sourceLabel(r.platform)}’s `
              + `${fmt(r.payout_coverage_base)} days`).join(', ')} — money we hold, not money missing`
          : null,
      ].filter(Boolean).join(' · '),
      tone: t.dark_bookings ? 'critical' : t.undercovered_bookings ? 'warn' : 'good' },
  ]));
  /* What widening the range actually does to the tiles above.
     ─────────────────────────────────────────────────────────────────────────
     This paragraph used to end "widening the range past the statements we hold
     flips those bookings from accounted to dark in one step — the 'no money
     value' tile moves by tens of thousands without anything changing in the
     fleet". That flip was the double-count in api/income_sql.js, and it is
     gone: a part-window payout is measured money now, so widening the range
     moves those bookings into the under-covered clause, not into darkness.
     What still moves — and what a reader still has to compare across two
     ranges before reading it as a trend — is the COVERAGE, because a payout
     is measured over days and the window is not. */
  const flipped = live.filter((r) => r.basis === 'payout' || r.basis === 'partial_payout');
  if (flipped.length) {
    host.append(el('p', 'cap',
      `${flipped.map((r) => sourceLabel(r.platform)).join(', ')} `
      + `${plural(flipped.length, 'carries', 'carry')} no fare per booking and `
      + `${plural(flipped.length, 'is', 'are')} accounted for by payout instead. A payout covers DAYS, `
      + 'not bookings, so widening the range past the statements we hold does not add money to the '
      + 'total — it lowers the share of the window that total was measured over. The figure stays '
      + 'right about the days it covers and silent about the others; compare the coverage across two '
      + 'ranges before reading either number as a trend.'));
  }

  if (d.caveat) host.append(el('div', 'note err', esc(d.caveat)));

  /* The door to the audit trail. This page states which basis each channel is
     on and why; the provenance page states which API CALL each figure came
     from, and what was held out of the total. They answer the two halves of
     the same question and neither was reachable from the other. */
  const trail = el('p', 'cap');
  trail.innerHTML = `<a class="lnk" href="${href('provenance')}">Where the money came from</a>`
    + ' lists every API call behind these figures — what each one returned, at what grain, and '
    + 'which of them this page counted.';
  host.append(trail);

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
    /* Uber prices no booking, so this column read "none reported" for the
       channel that is 95% of the work — over AED 1,535,180 of gross that its
       weekly statement files and that nothing had ever written into
       driver_statement_day. Same rule as #driver and #roster: the trips win
       where they carry a fare, the statement fills in where they do not, and
       the cell says which of the two it is. */
    { label: 'Fares (gross)', key: 'fares', num: true,
      render: (r) => {
        if (r.fares != null) return money(r.fares);
        if (r.statement_gross != null) {
          return `${money(r.statement_gross)}<span class="dim" title="no booking on this channel carries a fare; this is the gross its weekly statement reports"> stmt</span>`;
        }
        return '<span class="dim">none reported</span>';
      } },
    { label: 'Payout (net)', key: 'payouts', num: true,
      /* With the share of the WINDOW it covers, the population it was paid to,
         and the period it actually spans. A payout is over DAYS, not over
         bookings: three days of it on a thirty-day window is not the month,
         and a weekly period straddling the edge reaches past it — the payout
         column ran to 2026-08-30 on a window ending 08-25, over 217 paid
         drivers against 83 who drove. */
      /* The coverage on its own line. This cell is the widest on the table —
         "AED 1,135,725 · 90 of 90 days · 234 drivers paid" on production — and
         the table is nine columns of dense text: measured at 1750px it was cut
         by 322px with Per km, Basis and Why unreachable, and Why is the column
         that explains which money the row is even reporting. A line break
         costs a row of height and buys back the width of everything after the
         figure. */
      render: (r) => (r.payouts == null ? '<span class="dim">not reported</span>'
        : `${money(r.payouts)}<span class="dim"><br>${r.payout_days || 0} of ${d.window_days} days`
          + `${r.payout_drivers != null ? ` · ${fmt(r.payout_drivers)} drivers paid` : ''}`
          + `${r.first_period ? `<br>${esc(dateStr(r.first_period))} → ${esc(dateStr(r.last_period))}` : ''}</span>`) },
    { label: 'On-trip (net)', key: 'statement_net', num: true,
      /* The statement view of the money, from the platform's own reports.
         Differs from the bank payout by the cash drivers hold plus tips and
         tolls; a 13% difference in a heavy-cash month is normal, not a bug.

         With the coverage it rests on. This column is identical at 7, 30 and
         365 days for Uber, because the statements we hold span nine days —
         so widening the window does not widen this figure and nothing said so. */
      /* And what the channel kept, which is the other half of the same
         statement and the most obvious question an operator has about a
         channel. It rides in this cell rather than in a column of its own: the
         table is already ten columns and a tenth pushed four of them off the
         edge of a 1750px screen.

         The rate is fees over gross and NOT (gross − net) / gross — the
         component tree carries taxes, surcharges and promotions the fold does
         not name, so only one of those two is a commission. */
      render: (r) => (r.statement_net == null ? '<span class="dim">not collected</span>'
        : `${money(r.statement_net)}<span class="dim"><br>cash ${r.statement_cash != null ? money(r.statement_cash) : '—'}`
          + `${r.statement_days != null ? ` · ${r.statement_days} of ${d.window_days} days` : ''}`
          + `${r.statement_drivers != null ? `, ${fmt(r.statement_drivers)} drivers` : ''}`
          + `${r.statement_fees != null
            ? `<br>channel took ${money(r.statement_fees)}${r.statement_gross
              ? ` · ${pct((r.statement_fees / r.statement_gross) * 100, 1)} of the gross` : ''}`
            : ''}</span>`) },

    /* The denominator is named, because it is not the same one on every row.
       A fares row divides gross fares by the distance of the bookings that
       carried a fare; a payout row divides the net payout by every booking
       with a distance. Both answer "what did a kilometre earn", and printing
       them under one heading without saying which money it was would invite
       a reader to compare AED 4.12 of gross hotel fare against AED 2.71 of
       net Uber payout as though they were the same thing. */
    { label: 'Per km', key: 'revenue_per_km', num: true,
      /* Same treatment as the two cells above, and for the same reason: the
         basis and its denominator are what make this figure checkable, and
         they do not have to sit on the same LINE as it to do that. */
      render: (r) => (r.revenue_per_km != null
        ? `${money(r.revenue_per_km, 'AED', 2)}<span class="dim"><br>${
          r.per_km_basis === 'payout' ? 'net payout' : 'gross fare'} over ${
          fmt(r.per_km_km ?? r.priced_km)} km</span>`
        : '—') },
    { label: 'Basis', key: 'basis',
      render: (r) => pill(BASIS[r.basis]?.label || r.basis, BASIS[r.basis]?.tone) },
    { label: 'Why', key: 'basis_note', render: (r) => `<span class="wrap dim">${esc(r.basis_note)}</span>` },
  ], { sortable: true, sortId: 'chan', defaultSort: { key: 'bookings', dir: 'desc' } }));
  /* The identity, and then the gap it actually leaves on THIS window.
     ───────────────────────────────────────────────────────────────────────
     This caption used to end "Reconciled on July 2026 these agree to 0.7%
     once the cash is accounted for", printed under the two columns it named.
     Those two columns do not agree to 0.7%. Measured 2026-09-02T13:16Z,
     /api/revenue?from=2026-07-01&to=2026-07-31: uber statement_net 382,915.61
     + tips 4,219.36 + salik 0 − statement_cash 75,805.92 = 311,329.05
     expected, against payouts 355,419.78 — AED 44,090.73 apart, 14.2%. The
     July row of /api/reconcile agrees to the fils (expected_payout
     311,329.05, bank_covered 355,419.78, delta 44,090.73, delta_pct 14.2),
     and August is 28.0%.

     The 0.7% is real but it is a different comparison. It is the July 2026
     reconciliation against the OPERATOR'S OWN LEDGER — the imported workbook
     in driver_statement_day where source='ledger', which api/income_sql.js
     platformStatements() deliberately excludes from everything this page
     renders (see api/reconcile_routes.js, which carries the same provenance).
     Naming a counterparty the page never shows, as though it were an
     agreement between two columns the page does show, is the whole fault.

     So the sentence is computed instead of written: the same identity, over
     whatever window is on screen, using only the channels that report both
     sides. The claim can then never be older than the figures beside it. */
  const nn = (v) => (Number.isFinite(+v) ? +v : 0);
  const bothSides = live.filter((r) => r.statement_net != null && r.payouts != null);
  const round2 = (v) => Math.round(v * 100) / 100;
  const expected = round2(bothSides.reduce((a, r) => a + nn(r.statement_net) + nn(r.statement_tips)
    + nn(r.statement_salik) - nn(r.statement_cash), 0));
  const wired = round2(bothSides.reduce((a, r) => a + nn(r.payouts), 0));
  const gap = round2(wired - expected);
  const gapPct = expected ? Math.abs(gap / expected) * 100 : null;
  p.body.append(el('p', 'cap',
    'Three views of the same money, never added together. A fare is what the rider was charged. '
    + 'On-trip revenue is gross minus the platform’s commission — what the fleet EARNED, from the '
    + 'platform’s own statement reports. The bank reconciliation is what actually reached the '
    + 'account: on-trip net minus cash the drivers already collected, plus tips and toll '
    + 'reimbursements. '
    + (bothSides.length && expected
      ? `On this window ${andList(bothSides.map((r) => sourceLabel(r.platform)))} `
        + `${plural(bothSides.length, 'reports', 'report')} both sides: `
        + `${money(expected)} expected against ${money(wired)} wired, `
        + `${money(Math.abs(gap))} apart (${pct(gapPct, 1)}${gap > 0 ? ', the bank ahead' : ', the bank behind'})`
        /* Both sides are sums over their own days, and on production they are
           not the same days — 206 statement days against 209 payout days on
           the 365-day window at 2026-09-02T13:16Z. A reader owed the gap is
           owed the two denominators with it, or a coverage difference reads
           as money. */
        + `, over ${andList(bothSides.map((r) => `${fmt(r.statement_days ?? 0)} statement days and `
          + `${fmt(r.payout_days ?? 0)} payout days on ${sourceLabel(r.platform)}`))}. `
        + (gapPct >= 1
          ? 'That is a gap to explain, not a rounding — '
          : 'They close to within a percent here — ')
        + 'Reconciliation breaks it down by month, and over the driver-days both sides actually '
        + 'describe rather than over the whole window. '
      : 'No channel on this window reports both an on-trip statement and a bank payout, so the two '
        + 'cannot be compared here at all. ')
    + 'A payout below the on-trip figure is drivers holding cash, not missing money. '
    + '"Accounted for" takes fares or payout per channel and says which.'));
  /* And the way to the month-by-month version of the same subtraction, which
     is the only place the gap above can be attributed to a period. */
  const rl = el('p', 'cap');
  rl.innerHTML = `<a class="lnk" href="${href('reconcile')}">Reconciliation</a>`
    + ' puts the two sides in one row for every month on record, and states which driver-days '
    + 'each side actually covers.';
  p.body.append(rl);
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
      /* Every component, not just the roots.
         ─────────────────────────────────────────────────────────────────────
         This map was built from `top` — the rows whose parent IS NULL — so a
         GRANDCHILD could never find its parent and its share came out null.
         Uber's supplier tree is three deep: `little_fare` sits inside `fare`
         which sits inside `your_earnings`, and `fare` is not a root. On
         production that left 16 of 30 rows on this table blank, and 17 of 31
         on the same table on #finance — including `little_fare`, which is the
         single largest component the fleet has.

         Keyed on the whole list instead, so a share is against the row's OWN
         parent at whatever depth it sits. A parent that is genuinely absent
         from the window still yields null, which is the case the dash was
         written for. */
      /* Summed, not last-write-wins. One category can hang under two parents
         — Uber reports `taxes_earnings` inside both `earnings` (the REST tree)
         and `your_earnings` (the GraphQL one) — and a plain Map would keep
         whichever came last, so a share could be measured against half its
         denominator. Summing is the only reading that is never wildly wrong
         when the same name means the same money on two surfaces. */
      const byCat = new Map();
      for (const c of [...top, ...kids]) {
        const k = `${c.platform}|${c.category}`;
        byCat.set(k, (byCat.get(k) || 0) + (Number(c.amount) || 0));
      }
      cp.body.append(tableFrom(kids.slice(0, 30).map((c) => ({ ...c,
        _share: byCat.get(`${c.platform}|${c.parent}`)
          ? (Number(c.amount) / byCat.get(`${c.platform}|${c.parent}`)) * 100 : null })), [
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
        const total = byCat.get(key);
        if (!total) return null;
        const sum = kids.filter((c) => `${c.platform}|${c.parent}` === key)
          .reduce((a, c) => a + (Number(c.amount) || 0), 0);
        const diff = total - sum;
        /* A dirham of rounding is not a finding. */
        return Math.abs(diff) < 1 ? null : { name: String(key.split('|')[1]).replace(/_/g, ' '), diff };
      }).filter(Boolean);

      const anyOver = kids.some((c) => {
        const t = byCat.get(`${c.platform}|${c.parent}`);
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
