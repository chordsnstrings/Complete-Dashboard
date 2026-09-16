/* THE PAYOUT REGISTER — what each platform actually transferred, by date.
   ═══════════════════════════════════════════════════════════════════════════
   Asked for in these words: "find out other payout end points for bolt and
   yango and create a payout tab under finance and have it exactly on the date
   basis."

   The date basis is the whole of the requirement and it is the hard part.
   Finance already carries five pages and not one of them holds a transfer:
   Bank reconciliation compares a month's "bank payout" against what the
   statements say was owed, and its bank payout is the sum of what DRIVERS
   earned that month, spread across the days they earned it. That is a real
   quantity. It is not a wire, and the two do not agree — measured on Ecosine's
   closed week of Mon 7 to Sun 13 September 2026, the dashboard says
   AED 110,962.09 and Uber's own books say the transfer was AED 103,567.54.
   7.1% apart, because they count different events.

   So this page holds one kind of row and only one: a transfer that reached the
   company's bank, on the date the provider says it did.

   ── what each provider gives, and the one that gives nothing ────────────
   Uber and Bolt both date their transfers, by two completely different routes.
   Uber's organisation payment statement has a `Transferred To Bank Account`
   column that is EMPTY on a day with no transfer, so asking it one day at a
   time yields the date; Bolt simply lists every payout with the second it
   completed.

   Yango publishes no transfer to the company at all. Its ledger is a
   driver-account ledger, and the only categories in it that mention a bank sit
   in a group Yango itself names "Payouts from account balance to contractors"
   — the park paying its own drivers. None of them has ever carried a row here.

   THAT IS WHY THE ABSENCE BAND IS NOT AN AFTERTHOUGHT ON THIS PAGE. A Yango
   row reading AED 0 would be a figure nobody measured sitting in a column of
   figures somebody did, and a Yango row simply missing would read as a
   collection fault. It gets a sentence instead, and the sentence says which of
   the two it is — the endpoint distinguishes "publishes and we have none"
   (a gap to fix) from "does not publish" (a fact to state).

   ── and the second panel, which is what makes a transfer checkable ──────
   A wire of 103,567.54 means nothing on its own and means everything when it
   is the closing balance of the week before it. The daily movement panel is
   the provider's own books per date, and it carries `basis` for a reason:
   'statement' is the provider's own opening and closing balance, which can be
   checked against itself, and 'ledger' is us summing that provider's dated
   rows, which cannot. Presenting them identically would be lying by
   omission. */
import { el, esc, panel, loading, tableFrom, kpiRow, note, sourceLabel, money,
  countOf, dateStr, dayStr, pill } from './ui.js';
import { fmt, empty, barChart } from './charts.js';
import { q } from './data.js';

/* A transfer is money ARRIVING, so it is shown positive whatever sign the
   provider files it under. Uber signs a payout negative because from the
   account's point of view it leaves; the collector already flips it on the way
   in, and this is the reader's half of the same decision. */
const amt = (v) => Math.abs(+v || 0);

/* Which weekday a date falls on in Dubai, in a word. The single most useful
   fact about Uber's transfers turned out to be that they all land on a Monday,
   and a table of dates does not say so — a column of weekday names does. */
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/* ANCHORED AT NOON UTC, and the reason is a bug this page shipped with.
   ─────────────────────────────────────────────────────────────────────────
   This parsed `${d}T00:00:00+04:00`, which IS the right instant for Dubai
   midnight and is also 20:00 on the PREVIOUS UTC day — so getUTCDay() named
   the day before. On the wire this page exists to show, Mon 2026-09-07 with
   Ecosine's AED 103,567.54, it returned "Sunday".

   The page therefore contradicted itself in its own headline: the transfer
   table read "7 Sep 2026 · Sunday" and the at-a-glance tile read "every one of
   them a Sunday", four rows above a coverage row stating "Uber wires on a
   Monday" — and the false half was the one in the headline.

   Midday is far enough from either midnight that no offset in use can move it
   across a date boundary, so the weekday reported is the weekday of the
   CALENDAR DATE rather than of an instant. Same idiom as api/public/day.js:176
   and api/public/performers.js:58, and the same fix as settlesWeek() in
   src/sources/uber_payout.js, which had the identical defect. */
export const weekdayOf = (d) => {
  const t = Date.parse(`${String(d).slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(t) ? WEEKDAY[new Date(t).getUTCDay()] : null;
};

/* The period a transfer settles, where the provider says one. Bolt does not,
   and this returns null rather than the transfer's own date — writing "7 Sep
   to 7 Sep" for a payout with no stated period would be an invented fact in
   the column whose entire job is to say what is known. */
const periodOf = (r) => (r.period_start && r.period_end
  ? `${dateStr(r.period_start)} – ${dateStr(r.period_end)}`
  : null);

export async function renderPayouts(root) {
  root.innerHTML = '';
  loading(root);
  const d = await q('/api/finance/payouts').catch(() => null);
  root.innerHTML = '';
  if (!d) {
    empty(root, 'The payout register did not answer',
      'Collection gaps says which feeds ran; this page reads what they filed.');
    return;
  }

  const payouts = d.payouts || [];
  const coverage = d.coverage || [];
  const publishing = coverage.filter((c) => c.publishes_payouts);
  const silent = coverage.filter((c) => !c.publishes_payouts);
  const total = payouts.reduce((a, r) => a + amt(r.amount), 0);
  const dates = new Set(payouts.map((r) => String(r.paid_on).slice(0, 10)));
  const weekdays = new Set([...dates].map(weekdayOf).filter(Boolean));
  const spans = (d.coverage || []).flatMap((c) => c.record_span || []);
  const earliest = spans.map((s) => String(s.earliest).slice(0, 10)).filter(Boolean).sort()[0] || null;

  /* ── the numbers at a glance ─────────────────────────────────────────── */
  root.append(kpiRow([
    { label: 'Transferred to the bank', value: money(total),
      sub: payouts.length
        ? `${countOf(payouts.length, 'transfer')} on ${countOf(dates.size, 'date')} in this window`
        : 'nothing in this window' },
    /* The count of DATES rather than of transfers, because the request was for
       an exact date basis and this is the figure that says whether the page
       delivers one. */
    { label: 'Dates money arrived', value: fmt(dates.size),
      sub: weekdays.size === 1
        ? `every one of them a ${[...weekdays][0]}`
        : weekdays.size
          ? `across ${countOf(weekdays.size, 'weekday')}: ${[...weekdays].join(', ')}`
          : 'no transfer has a date in this window' },
    { label: 'Platforms that publish a transfer', value: `${publishing.length} of ${coverage.length}`,
      sub: silent.length
        ? `${silent.map((c) => sourceLabel(c.platform)).join(', ')} `
          + `publish${silent.length === 1 ? 'es' : ''} none — see the band below for why`
        : 'every platform on record dates its own transfers',
      tone: silent.length ? 'warn' : null },
    earliest
      ? { label: 'The record starts', value: dateStr(earliest),
        sub: 'the earliest transfer held for any platform, regardless of the window above' }
      : null,
  ]));

  /* ── EVERY TRANSFER, ONE ROW EACH ────────────────────────────────────── */
  if (payouts.length) {
    const p = panel('Every transfer, by the date it arrived',
      'One row per payment that reached the bank, taken from the provider’s own books. '
      + 'Nothing here is divided out of a weekly figure — a row exists because a provider '
      + 'named this date.');
    p.body.append(tableFrom(payouts, [
      { label: 'Date', key: 'paid_on',
        render: (r) => `<b>${esc(dateStr(r.paid_on))}</b>`
          + `<span class="dim"> · ${esc(weekdayOf(r.paid_on) || '')}</span>` },
      { label: 'Platform', key: 'platform',
        render: (r) => esc(sourceLabel(r.platform)) },
      { label: 'Fleet', key: 'fleet_id', render: (r) => esc(r.fleet_id || '—') },
      { label: 'Amount', key: 'amount', num: true, render: (r) => money(amt(r.amount)) },
      { label: 'Settles', key: 'period_start',
        render: (r) => (periodOf(r)
          ? esc(periodOf(r))
          : '<span class="ent-off" title="this provider does not say which period a transfer '
            + 'settles, and inferring one from the transfer date would be a guess">not stated</span>') },
      /* The provenance column, not decoration: #provenance is a whole page in
         this product built on the principle that a figure whose source is not
         stored cannot be re-derived when a provider changes shape. */
      { label: 'From', key: 'source',
        render: (r) => `<span class="dim">${esc(r.source || '—')}</span>` },
    ], { sortable: true, sortId: 'payout-rows' }));
    root.append(p.panel);

    /* The shape of it. Oldest first, because a series read left to right is a
       series and read right to left is a list. */
    const byDate = new Map();
    for (const r of payouts) {
      const k = String(r.paid_on).slice(0, 10);
      byDate.set(k, (byDate.get(k) || 0) + amt(r.amount));
    }
    const series = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, v]) => ({ day: dayStr(day), v }));
    if (series.length > 1) {
      const cp = panel('The same transfers, in order',
        'Gaps between the bars are days no transfer arrived — they are not zeroes and are '
        + 'not drawn as any.');
      const host = el('div');
      cp.body.append(host);
      barChart(host, series, { x: 'day', y: 'v', valueFmt: (v) => money(v), axisFmt: (v) => money(v) });
      root.append(cp.panel);
    }
  } else {
    empty(root, 'No transfer reached the bank in this window',
      'Which is a fact about the window, not about the platforms — the band below says what '
      + 'each one publishes and what is on record for it.');
  }

  /* ── WHAT EACH PLATFORM PUBLISHES, AND WHY A FIGURE IS MISSING ────────── */
  {
    const p = panel('What each platform publishes about its own transfers',
      'A platform with no figure here has either not been collected or does not publish one, '
      + 'and those are different problems. Each row says which.');
    p.body.append(tableFrom(coverage, [
      { label: 'Platform', key: 'platform',
        render: (c) => `<b>${esc(sourceLabel(c.platform))}</b>` },
      { label: 'Dates its transfers', key: 'publishes_payouts',
        render: (c) => (c.publishes_payouts
          ? pill('yes', 'ok', c.how || '')
          : pill('no', 'warn', 'this platform publishes no transfer to the company')) },
      { label: 'In this window', key: 'in_window',
        num: true,
        render: (c) => {
          const rows = c.in_window || [];
          if (!rows.length) return '<span class="ent-off">—</span>';
          return rows.map((t) => `${esc(t.fleet_id)}: <b>${money(t.total)}</b>`
            + `<span class="dim"> over ${fmt(t.dates)} date${t.dates === 1 ? '' : 's'}</span>`).join('<br>');
        } },
      { label: 'On record', key: 'record_span',
        render: (c) => {
          const rows = c.record_span || [];
          if (!rows.length) return '<span class="ent-off">nothing yet</span>';
          return rows.map((s) => `${esc(s.fleet_id)}: ${esc(dateStr(s.earliest))} – `
            + `${esc(dateStr(s.latest))}<span class="dim"> · ${fmt(s.transfers)} transfers</span>`).join('<br>');
        } },
      { label: 'When it pays', key: 'cadence',
        render: (c) => (c.cadence ? esc(c.cadence) : '<span class="ent-off">—</span>') },
    ], { sortId: 'payout-coverage' }));

    /* THE ABSENCE BAND. Each missing figure gets the reason it is missing, in
       plain English, in the provider's own terms — never a zero and never a
       dash standing in for a sentence. */
    for (const c of coverage.filter((x) => x.absent)) {
      p.body.append(note(`${sourceLabel(c.platform)}: ${c.absent}`,
        c.publishes_payouts ? 'warn' : null));
    }
    root.append(p.panel);
  }

  /* ── THE DAILY MOVEMENT, which is what makes a transfer checkable ─────── */
  const days = d.days || [];
  if (days.length) {
    const statements = days.filter((r) => r.basis === 'statement');
    const ledgers = days.filter((r) => r.basis === 'ledger');
    const p = panel('The provider’s own books, day by day',
      'A transfer is checkable only against the balance it settles. Where a provider publishes '
      + 'an opening and a closing balance, this is that statement; where it publishes only dated '
      + 'transactions, this is those transactions summed per day, and the Basis column says '
      + 'which — only the first can be checked against itself.');
    p.body.append(tableFrom(days, [
      { label: 'Date', key: 'day', render: (r) => `<b>${esc(dateStr(r.day))}</b>` },
      { label: 'Platform', key: 'platform', render: (r) => esc(sourceLabel(r.platform)) },
      { label: 'Fleet', key: 'fleet_id', render: (r) => esc(r.fleet_id || '—') },
      { label: 'Basis', key: 'basis',
        render: (r) => (r.basis === 'statement'
          ? pill('statement', 'ok', 'the provider’s own balances, which close against each other')
          : pill('ledger', null, 'summed by us from the provider’s dated rows — there is no '
            + 'balance here to check it against')) },
      { label: 'Opened at', key: 'opening_balance', num: true,
        render: (r) => (r.opening_balance == null
          ? '<span class="ent-off" title="this provider publishes no running balance">—</span>'
          : money(r.opening_balance)) },
      { label: 'Earned', key: 'earnings', num: true,
        render: (r) => (r.earnings == null ? '<span class="ent-off">—</span>' : money(r.earnings)) },
      { label: 'Cash taken', key: 'cash_collected', num: true,
        render: (r) => (r.cash_collected == null ? '<span class="ent-off">—</span>' : money(r.cash_collected)) },
      /* The commission column exists because of what the Yango ledger turned
         out to contain. src/sources/yango.js has said since it was written that
         "an order carries no commission field, and Yango's commission is about
         24% of the gross" — the ledger carries it per transaction, and the
         measured figure over ninety days is 27.2%. */
      { label: 'Platform fee', key: 'commission', num: true,
        render: (r) => (r.commission == null
          ? '<span class="ent-off" title="this provider nets its fee off before the money reaches '
            + 'the company account, so there is no fee line to read">—</span>'
          : money(r.commission)) },
      { label: 'To the bank', key: 'bank_transferred', num: true,
        render: (r) => (r.bank_transferred == null
          ? '<span class="ent-off" title="this provider publishes no transfer to the company">not published</span>'
          : (Math.abs(+r.bank_transferred) > 0.005
            ? `<b>${money(amt(r.bank_transferred))}</b>`
            : '<span class="dim" title="the provider published this column and it was empty — '
              + 'a measured nothing, not a missing figure">none</span>')) },
      { label: 'Closed at', key: 'closing_balance', num: true,
        render: (r) => (r.closing_balance == null
          ? '<span class="ent-off">—</span>' : money(r.closing_balance)) },
    ], { sortable: true, sortId: 'payout-days' }));
    p.body.append(note(`${countOf(statements.length, 'day')} come from a provider statement `
      + `and ${countOf(ledgers.length, 'day')} are summed from dated transactions. `
      + 'A blank in a money column means the provider publishes no such figure, and it is never '
      + 'shown as zero.'));
    root.append(p.panel);
  }

  /* The sentence that stops this page being read as a contradiction of
     Bank reconciliation. Both are true; they count different things. */
  root.append(note(d.note));
}
