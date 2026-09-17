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
   quantity, and it is not a wire.

   ── THE "7.1% APART" THIS FILE USED TO PRINT WAS THE WRONG WEEK ─────────
   The retracted sentence stood here, in the header of the page that renders
   the register: "measured on Ecosine's closed week of Mon 7 to Sun 13
   September 2026, the dashboard says AED 110,962.09 and Uber's own books say
   the transfer was AED 103,567.54. 7.1% apart, because they count different
   events." The division is right — 7,394.55 / 103,567.54 = 7.14% — and the
   two figures are not the same week, which is the entirety of why they were
   so far apart.

   103,567.54 was wired on MONDAY 2026-09-07, and a Monday wire settles the
   Mon–Sun week that ENDED THE DAY BEFORE: 31 Aug – 6 Sep. The wire that
   settles 7–13 Sep is the one paid on Monday 2026-09-14. Beside the RIGHT
   wire, measured on production 2026-09-17:

     ours, the seven daily bank_payout figures /api/reconcile prints for
     7–13 Sep, each sum(driver_payout_day.earnings) for that day:
       14,324.61 + 15,770.41 + 17,192.37 + 16,612.39
       + 17,532.04 + 15,726.00 + 13,804.27              = 110,962.09
     Uber's wire, Mon 2026-09-14                        = 111,179.66
     difference                                              217.57  (0.20%)

   So the two registers agree to a fifth of one percent. They still count
   different events — a week of per-driver earnings is not a transfer — but
   "7.1% apart" was never a measurement of that difference, and a page that
   printed it told an operator their books were out by seven percent.

   That is also why the panel added below is not a nicety: the comparison was
   being done in a comment, by hand, once, against whichever wire was nearest.
   It is now done per transfer, against the week each transfer names, by the
   server, and printed with its own difference beside it.

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
   A wire means nothing on its own and means a great deal beside the balance
   it left from — as a DIFFERENCE, which is the second claim this page has had
   to retract. src/sources/uber_payout.js and this page both said the Monday
   transfer equals the previous week's closing balance "to the fils, proven
   over two consecutive weeks". Three Ecosine Mondays are now measurable:

     2026-08-17  opening  57,791.73   wire  57,810.41   wire 18.68 ABOVE
     2026-09-07  opening 103,567.54   wire 103,567.54   exact
     2026-09-14  opening 111,279.92   wire 111,179.66   wire 100.26 BELOW

   The CADENCE is sound and nothing here doubts it. The equals-to-the-fils
   half holds on one of the three, so the balance figures are shown as a
   difference to look at and never as a check that should come out at zero.

   The daily movement panel is
   the provider's own books per date, and it carries `basis` for a reason:
   'statement' is the provider's own opening and closing balance, which can be
   checked against itself, and 'ledger' is us summing that provider's dated
   rows, which cannot. Presenting them identically would be lying by
   omission. */
import { el, esc, panel, loading, tableFrom, kpiRow, note, sourceLabel, money,
  countOf, dateStr, dayStr, pill, pct, signed, foldChildren } from './ui.js';
import { fmt, empty, barChart } from './charts.js';
import { q, currentGen, alive } from './data.js';

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
  const gen = currentGen();
  /* Both in one round trip's worth of waiting rather than two. The register
     and the reconciliation are different questions of the same subject, and a
     page that paints the register and then makes the reader watch a second
     skeleton for the one number they came for has ordered its work around the
     server's convenience. /api/finance/payouts/reconcile is read-only and
     carries no live ask, so it costs about what the register does.

     Caught SEPARATELY and to a distinguishable value: `null` from the register
     is the existing whole-page failure below, and a reconciliation that did
     not answer must not take the register down with it — the transfers are
     still true. The reason is carried rather than swallowed, because "the
     comparison could not be read" is itself a thing this page has to say out
     loud instead of quietly omitting a panel. */
  const [d, rec] = await Promise.all([
    q('/api/finance/payouts').catch(() => null),
    q('/api/finance/payouts/reconcile').catch((e) => ({ __error: String(e && e.message ? e.message : e) })),
  ]);
  if (!alive(gen)) return;
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

  /* ── THE DIFFERENCE, DIRECTLY UNDER THE TILES ─────────────────────────
     Placed ABOVE the register and not below it. An operator opening this page
     has one question — did the money that arrived match what we say was
     earned — and the register answers a different one: what arrived. The
     register is the evidence; this is the finding, and a finding printed
     under 175 rows of evidence is a finding nobody reads.

     Its own host, because it redraws on its own after a live ask without the
     rest of the page being rebuilt: rebuilding would take the reader's scroll
     position and the results of the ask they just made. */
  {
    const host = el('div', 'stack');
    root.append(host);
    reconcileSection(host, rec, gen);
  }

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
    /* INTO ITS OWN BOX, and this is a repair rather than a tidy-up.
       ───────────────────────────────────────────────────────────────────
       empty() begins `host.innerHTML = ''` — it has to, because every caller
       reaches it after loading() has filled the host with a skeleton and
       appending to that leaves a shimmering bar sitting on top of the empty
       state. Handed `root`, it therefore wipes THE WHOLE PAGE: on a window
       with no transfer this erased the four at-a-glance tiles above it, and
       from the panel added in this pass it would have erased the wire-against-
       our-figure comparison and the count of days nobody has asked Uber about
       — the two things on this page that are still worth reading when no
       transfer landed in the window.

       The message is about the TRANSFER TABLE, so it replaces the transfer
       table and nothing else. */
    const host = el('div');
    root.append(host);
    empty(host, 'No transfer reached the bank in this window — which is a fact about the '
      + 'window, not about the platforms. The band below says what each one publishes and '
      + 'what is on record for it.');
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

/* ═══════════════════════════════════════════════════════════════════════════
   UBER'S WIRE AGAINST OUR OWN FIGURE — and the days nobody has asked about.
   ═══════════════════════════════════════════════════════════════════════════
   Everything from here down reads GET /api/finance/payouts/reconcile and
   writes POST /api/finance/payouts/verify, and it exists because of a defect
   in this page rather than in the data.

   WHAT WAS WRONG. The register above proves what arrived. It never once said
   whether what arrived matched what we say was earned — the only comparison
   this product made was the retracted sentence in this file's own header,
   done by hand, once, against whichever wire was nearest the week being
   discussed. It picked the wrong one: the wire of 103,567.54 paid on Monday
   2026-09-07 settles 31 Aug – 6 Sep, and it was printed against the week
   7–13 Sep, which produced "7.1% apart" out of a 0.20% agreement.

   A comparison made in a comment is a comparison that is made once and then
   decays. This one is made per transfer, by the server, against the week each
   transfer itself names, and the difference is printed in the row.

   AND THE HALF THAT MAKES IT TRUSTWORTHY. Uber's statement is a per-day
   document and the nightly walk is bounded — 4 statement days stored for
   uber/ecosine on 2026-09-17, against a record that runs to hundreds. Every
   day not asked about is a day with NO MEASUREMENT, and a page that showed
   only the days it holds would read as exhaustive. So the unchecked days are
   counted, named and given a button, because the house rule is that a figure
   which cannot be measured renders absent with the true reason, and "we never
   asked" is the true reason for most of this history. */

/* WHERE THE COLOUR COMES FROM, AND WHAT IT IS JUDGING.
   ─────────────────────────────────────────────────────────────────────────
   NOT the sign. A wire above our figure and a wire below it are not good and
   bad news respectively — they are the same news, which is that the two
   registers count different events and do not land on the same number. What
   an operator needs coloured is the SIZE of the gap, because that is the only
   part of it that can be wrong.

   The bands are set from the one week where both sides are known and from the
   defect that produced this panel:
     ≤ 1%   the two agree. Measured: 217.57 on 111,179.66 is 0.20%.
     ≤ 5%   a gap worth a look but inside the range a week of adjustments,
            refunds and cash movements can produce.
     > 5%   the shape of the retracted claim. 7,394.55 on 103,567.54 is 7.14%,
            and it came from comparing two different weeks — so a figure in
            this band is far more likely to be a periods bug than a real hole
            in the money, and it should stop a reader.

   A row with NO comparison gets no tone at all. An absent figure must never
   be painted as a good one or a bad one; it is painted as absent, with its
   reason, which is what td.v-* would quietly launder into a verdict. */
export const AGREE_PCT = 1;
export const WIDE_PCT = 5;
export const deltaTone = (delta, deltaPct) => {
  if (delta == null || !Number.isFinite(Number(delta))) return null;
  /* A percentage needs a denominator. Where the wire is zero the server sends
     delta_pct null, and a difference against a zero wire is not a small
     disagreement — it is the whole of our figure with no transfer behind it. */
  const a = deltaPct == null || !Number.isFinite(Number(deltaPct))
    ? (Math.abs(Number(delta)) > 0.005 ? Infinity : 0)
    : Math.abs(Number(deltaPct));
  return a <= AGREE_PCT ? 'v-good' : a <= WIDE_PCT ? 'v-warn' : 'v-critical';
};

/* A difference carries its own sign, and the plus is the half that has to be
   added: money() already emits U+2212 for a negative, and nothing in this
   product emits a plus, so a column of differences read as if every one of
   them were a shortfall. */
/* THE SIGN COMES FROM ui.js, NOT FROM HERE.
   ─────────────────────────────────────────────────────────────────────────
   These two were written with a ternary on a numeric comparison emitting a
   plus for positives and nothing otherwise, wrapped round money() — the exact
   shape test/signed.test.mjs exists to forbid, and which it caught. (Quoting
   that shape literally here would trip the same guard, which greps the raw
   source and exempts only ui.js by name; so it is described rather than
   reproduced.) Its reasoning is this product's: the minus glyph is
   U+2212 rather than a hyphen, the sign goes BEFORE the currency where a
   reader looks for it, and a second copy of that rule drifts from the first.
   ui.js's signed() owns all of it, so these two now only decide where the
   currency word goes. */
/* THE SIGN from ui.js's signed(); the BODY from the formatter that belongs to
   the quantity. signed() renders its own body through fmt(), which drops a
   trailing zero — 0.20% came out as 0.2%, and on a percentage that is the
   difference between a measurement and a rounding, on the one figure this
   panel exists to show. So the glyph is taken from signed() (one owner, U+2212
   not a hyphen, before the currency) and the digits from money() and pct(). */
const signOf = (v) => (signed(v, { d: 2 }).match(/^[+\u2212]/) || [''])[0];
const signedMoney = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '—'
  : `${signOf(v)}${money(Math.abs(Number(v)), 'AED', 2)}`);
const signedPct = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '—'
  : `${signOf(v)}${pct(Math.abs(Number(v)), 2)}`);

/* AN ABSENCE, WITH THE REASON ATTACHED TO IT.
   A short phrase a reader can scan a column of, and the provider's own full
   sentence on the element itself. The full sentences are ALSO printed under
   the table, grouped, because a reason that can only be read by hovering is a
   reason a printout, a screenshot and a phone all lose. */
const absent = (short, why) => `<span class="ent-off"${why ? ` title="${esc(why)}"` : ''}>${esc(short)}</span>`;

/* Which of the two absences this is. They are not the same finding: one is a
   fact about the provider that will never change, the other is a gap in our
   own collection that will. */
const noCompareShort = (r) => (r.period_start == null || r.period_end == null
  ? 'no period stated' : 'our figure not collected');

const periodRange = (a, b) => `${esc(dateStr(a))} – ${esc(dateStr(b))}`;

const MAX_ASK = 5;      // must equal MAX_DAYS in api/payout_routes.js

/* ── the section ─────────────────────────────────────────────────────────
   Two hosts that redraw independently. The reconciliation redraws after a
   live ask, because the ask changes what is stored; the results of that ask
   do NOT, because rebuilding them would throw away the answer the operator
   just waited three minutes for. */
function reconcileSection(host, rec, gen) {
  host.innerHTML = '';
  const dataHost = el('div', 'stack');
  const resultHost = el('div', 'stack');
  host.append(dataHost, resultHost);

  let current = rec;
  /* Shared by every ask control this section builds — see run() below for the
     defect. `buttons` is rebuilt on every paint(), because paint() replaces the
     DOM wholesale and a stale reference would re-enable a detached node. */
  let asking = false;
  /* Found in the DOM rather than threaded through three call sites: paint()
     replaces this subtree wholesale, so a list captured at build time would
     re-enable detached nodes and miss the live ones. */
  const buttons = () => [...host.querySelectorAll('button[data-ask]')];

  function paint() {
    drawReconcile(dataHost, current, run);
  }

  /* CACHE-BUSTED ON PURPOSE. api/cache.js keys on the URL and the route's own
     comment says a verify does not move the data version the reconciliation
     is cached against — so re-reading the same URL straight after an ask
     returns the answer from before it, and the page would report that asking
     Uber changed nothing. The extra parameter is ignored by the route and
     makes the key new. */
  async function refresh() {
    const fresh = await q('/api/finance/payouts/reconcile', { _: Date.now() })
      .catch((e) => ({ __error: String(e && e.message ? e.message : e) }));
    if (!alive(gen) || !host.isConnected) return;
    current = fresh;
    paint();
  }

  /* ── the live ask ──────────────────────────────────────────────────────
     RAW fetch, not api(), and the reason is the refusal rather than the
     success. api()'s failure() flattens a non-2xx body to one string and
     throws it, which discards `refused[]` — and on a 409 that array IS the
     answer: it names every day that was NOT asked about and why, and a day
     that vanishes from this page because the request came back 409 is a day
     an operator will believe was checked. The 409 is also not a failure. It
     means another ask is walking the same limiter, which is the route doing
     its job, and it is rendered as its own message rather than as an error. */
  /* ONE ASK AT A TIME ON THIS PAGE, TOO, AND FOR A DIFFERENT REASON THAN THE
     ROUTE'S.
     ─────────────────────────────────────────────────────────────────────────
     THE DEFECT. askControl() builds one button per fleet and they shared this
     one resultHost. Pressing Egari's button while Ecosine's three-minute walk
     was running ran `resultHost.innerHTML = ''`, which DETACHES the first run's
     panel without stopping it: the second ask got a fast 409, and the first
     then appended its rows, its per-day reasons and its refused list into a
     node no longer in the document, and re-enabled its own button. The operator
     was left looking at a bare 409 and none of the results Uber's limiter had
     just been spent on — the one cost on this page that cannot be refunded.

     So every ask button on the page is locked for the duration, not just the
     one pressed, and the lock beats the chip selection (see sync()) so a tick
     in the other fleet's control cannot quietly undo it. The panel is only
     ever cleared at the START of an ask, and an ask can no longer start while
     one is running, so nothing writes into a detached node any more. */
  async function run(fleet, days, ui) {
    if (asking) return;
    asking = true;
    buttons().forEach((b) => { b.dataset.locked = '1'; b.disabled = true; });
    ui.go.disabled = true;
    ui.said.textContent = '';

    resultHost.innerHTML = '';
    const p = panel('What Uber said, just now',
      'Asked live, one day at a time, and never cached. Each row is Uber’s own organisation '
      + 'payment statement for that day beside what the register held before the ask.',
      'payout-verify');
    resultHost.append(p.panel);
    const status = el('div', 'note');
    status.textContent = `Asking Uber about ${countOf(days.length, 'day')} for `
      + `${sourceLabel(fleet)}, one day at a time. One report takes between ten and forty `
      + 'seconds, so this can take a few minutes — the page is waiting on the provider, not '
      + 'on itself. Nothing is stored until Uber answers.';
    p.body.append(status);
    p.panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    let res = null; let body = null; let netErr = null;
    try {
      res = await fetch('/api/finance/payouts/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fleet, days }),
      });
      body = await res.json().catch(() => null);
    } catch (e) {
      netErr = String(e && e.message ? e.message : e);
    }
    if (!alive(gen) || !host.isConnected) return;

    ui.go.disabled = false;
    asking = false;
    buttons().forEach((b) => { delete b.dataset.locked; b.disabled = false; });
    status.remove();

    if (netErr) {
      p.body.append(note(`The ask never reached the API: ${netErr}. Nothing was asked of Uber `
        + 'and nothing was learned about these days — they are still days nobody has asked '
        + 'about, and no figure here is zero because there is no figure.', 'err'));
      return;
    }
    if (!body || typeof body !== 'object') {
      p.body.append(note(`The API answered ${res ? res.status : 'nothing'} and the answer was `
        + 'not readable as JSON, so what it did with these days is unknown. Nothing here may '
        + 'be read as a measurement.', 'err'));
      return;
    }

    /* A REFUSAL IS ITS OWN MESSAGE, NOT A FAILURE.
       409 means another live ask is holding Uber's report queue. Rendering it
       red beside "the ask never reached the API" would tell an operator
       something is broken when the correct move is to wait a minute. */
    if (res && res.status === 409) {
      p.body.append(note(body.error || 'A live ask is already running, so nothing was asked '
        + 'of Uber. Try again when it finishes.', 'warn'));
    } else if (res && !res.ok) {
      p.body.append(note(body.error || `The API refused this ask with ${res.status} and gave `
        + 'no reason, which is itself the finding.', 'err'));
    }

    const rows = Array.isArray(body.days) ? body.days : [];
    if (rows.length) p.body.append(verifyTable(rows));

    /* EVERY REASON, VERBATIM, WHERE IT CANNOT BE MISSED.
       A day that came back with a `why` has no numbers at all, so it is one
       line of dashes in the table above and nothing else — which reads as a
       day that was checked and found empty. It was not checked. The reason is
       printed word for word, as the route wrote it, because the difference
       between "Uber's limiter is shut" and "Uber has no statement for this
       day" is the difference between a fact about this minute and a fact
       about the day, and paraphrasing loses exactly that. */
    for (const r of rows) {
      if (r && r.why) p.body.append(note(`${r.day}: ${r.why}`, 'warn'));
    }
    for (const r of (Array.isArray(body.refused) ? body.refused : [])) {
      if (r) p.body.append(note(`${r.day}: ${r.why}`, 'warn'));
    }
    if (!rows.length && !(body.refused || []).length && res && res.ok) {
      p.body.append(note('The API answered with neither a day nor a refusal, so nothing is '
        + 'known about what was asked.', 'warn'));
    }
    if (body.note) p.body.append(note(body.note));

    /* Only when something was actually asked. A 409 changed nothing, and
       re-reading the register after it would spend a query to redraw the same
       numbers — and, worse, look to a reader like a refresh that confirmed
       the refusal was harmless. */
    if (res && res.ok && rows.length) await refresh();
  }

  paint();
}

/* ── the comparison table ────────────────────────────────────────────────── */
function drawReconcile(hostEl, rec, run) {
  hostEl.innerHTML = '';

  const p = panel('Uber’s wire against our own figure',
    'One row per transfer that reached the bank: the exact amount, the week it settles, and '
    + 'our own figure for that same week — sum of what the drivers earned on those days, '
    + 'which is what Bank reconciliation calls "bank payout". The difference is the column '
    + 'this panel exists for. The two count different events and are not expected to match to '
    + 'the fils; the size of the gap is the finding.',
    'payout-reconcile');
  hostEl.append(p.panel);

  if (!rec || rec.__error) {
    p.body.append(note('The comparison could not be read'
      + (rec && rec.__error ? `: ${rec.__error}` : ' — the endpoint did not answer.')
      + ' No difference is shown, and none is shown as zero: nothing here has been measured. '
      + 'The transfers listed further down this page are unaffected — they are what the '
      + 'providers filed, and they are still true.', 'err'));
    return;
  }

  const rows = Array.isArray(rec.rows) ? rec.rows : [];
  if (!rows.length) {
    p.body.append(note('No transfer reached the bank inside this window, so there is nothing '
      + 'to compare. That is a fact about the window and not about the providers — widen it, '
      + 'or read the band below for the days nobody has asked Uber about.'));
    drawUnchecked(hostEl, rec, run);
    return;
  }

  p.body.append(tableFrom(rows, [
    { label: 'Arrived', key: 'paid_on',
      render: (r) => `<b>${esc(dateStr(r.paid_on))}</b>`
        + `<span class="dim"> · ${esc(weekdayOf(r.paid_on) || '')}</span>` },
    { label: 'Platform', key: 'platform', render: (r) => esc(sourceLabel(r.platform)) },
    { label: 'Fleet', key: 'fleet_id', render: (r) => esc(sourceLabel(r.fleet_id) || '—') },
    /* TWO DECIMALS, EVERYWHERE ON THIS PANEL. money() rounds to whole dirhams
       by default, and the whole claim of the panel is a difference of 217.57
       against a wire of 111,179.66 — rounded to the dirham the difference
       survives and the check a reader could do by hand does not. */
    { label: 'The wire', key: 'wire', num: true,
      render: (r) => (r.wire == null
        ? absent('not stated', 'this transfer is stored with no amount, which is a collection '
          + 'fault rather than a transfer of nothing')
        : `<b>${money(r.wire, 'AED', 2)}</b>`) },
    { label: 'Settles', key: 'period_start',
      render: (r) => (r.period_start && r.period_end
        ? periodRange(r.period_start, r.period_end)
        : absent('not stated', r.calculated_basis || 'this provider does not say which period a '
          + 'transfer settles, and inferring one from the transfer date would be a guess')) },
    { label: 'Our figure', key: 'calculated', num: true,
      render: (r) => (r.calculated == null
        ? absent(noCompareShort(r), r.calculated_basis)
        : `<span title="${esc(r.calculated_basis || '')}">${money(r.calculated, 'AED', 2)}</span>`) },
    /* THE COLUMN THE OPERATOR CAME FOR. Strongest mark available in a table
       cell in this product: the td takes the verdict colour and a 2px inset
       rule (td.v-*, which survives greyscale), and the figure itself takes
       .dl — tabular numerals at weight 600, so a column of differences lines
       up digit under digit — inside a <b>. The percentage sits under it in
       .dim, because the magnitude is the number and the percentage is the
       scale of it. */
    { label: 'Difference', key: 'delta', num: true,
      cellCls: (r) => deltaTone(r.delta, r.delta_pct) || '',
      render: (r) => (r.delta == null
        ? absent(noCompareShort(r), r.calculated_basis)
        : `<b class="dl">${esc(signedMoney(r.delta))}</b>`
          + (r.delta_pct == null
            ? '<span class="dim" title="the wire is zero, so there is no denominator to state '
              + 'this difference as a share of">&nbsp;·&nbsp;no share</span>'
            : `<span class="dim">&nbsp;·&nbsp;${esc(signedPct(r.delta_pct))}</span>`)) },
    /* ── AGAINST THE OPENING BALANCE, WHICH IS THE OTHER CHECK ON A WIRE ──
       THE DEFECT THIS CLOSES. The route computes opening_balance and
       balance_delta for every transfer that has a statement row beside it, and
       nothing rendered either. So the one comparison that needs no derivation
       at all — Uber's own balance at the start of the day against the money it
       moved out of that balance — was visible only AFTER an operator spent a
       report slot on a live ask, even though it was already stored.

       It is also the substance of a claim this product used to print and has
       now retracted: "the transfer equals the previous week's closing balance
       to the fils". Measured on three Ecosine Mondays the difference was
       +18.68, 0.00 and -100.26 — so the column exists to show the gap rather
       than to assert it away, and it does NOT get the good/bad colouring the
       Difference column carries, because a non-zero value here is not known to
       be a fault.

       DECLARED `absent` for the same reason as Asked live: on a transfer whose
       day we hold no statement for, there is no opening balance to compare,
       and a column of identical dashes would push Difference off a phone. */
    { label: 'Against the opening balance', key: 'balance_delta', num: true,
      absent: 'no day in this table has a stored statement beside its transfer, so there is no '
        + 'opening balance to compare the wire against. Asking Uber about the day of a transfer '
        + 'fills it.',
      render: (r) => (r.balance_delta == null
        ? absent('no statement for that day',
          'we hold no statement row for the day this transfer left, so Uber’s own opening '
          + 'balance for it has not been collected. This is not a difference of zero.')
        : `<span class="dim" title="Uber’s opening balance for that day was `
          + `${esc(money(r.opening_balance))}; the wire was ${esc(money(r.wire))}. These are `
          + `not expected to agree exactly — measured on three Mondays the gap was 18.68 above, `
          + `nil, and 100.26 below.">${esc(signedMoney(r.balance_delta))}</span>`) },
    /* Who has actually asked. A row filled by the nightly walk and a row a
       person verified live are both true and only one of them has been looked
       at, and the register had no way of saying which. */
    /* DECLARED `absent`, so the column REMOVES ITSELF when no row has one.
       checked_at is filled only by POST /api/finance/payouts/verify, so until
       somebody presses the button below every row in this table is null — a
       whole column of identical absences, and on a phone it is the column
       that pushes Difference off the right-hand edge of a table the operator
       opened to read Difference. tableFrom drops a column that is empty in
       every row and prints the sentence under the table instead, which is
       where this belongs: it is one fact about the panel, not one fact per
       row. Where SOME rows carry a date the column stays, and the rows that
       do not carry the same sentence on the dash. */
    { label: 'Asked live', key: 'checked_at',
      absent: 'nobody has asked Uber live about any of these days, so this is the nightly '
        + 'walk’s reading of the provider — which is not a reason to doubt it, and is a reason '
        + 'to know it. The band below asks Uber directly about a day.',
      render: (r) => (r.checked_at
        ? `<span class="dim" title="somebody asked Uber about this day directly">${esc(dateStr(r.checked_at))}</span>`
        : '<span class="ent-off" title="nobody has asked Uber live about this day — this row is '
          + 'the nightly walk’s reading of the provider">—</span>') },
  ], { sortable: true, sortId: 'payout-reconcile' }));

  /* ── the totals, over two populations, said apart ──────────────────────── */
  const t = rec.totals || {};
  if (t.wire != null) {
    const sameRows = t.comparable_rows != null && t.rows != null && t.comparable_rows === t.rows;
    p.body.append(note(
      `${countOf(t.rows ?? rows.length, 'transfer')} totalling ${money(t.wire, 'AED', 2)} `
      + 'reached the bank in this window. '
      + (t.calculated == null
        ? 'None of them can be compared against our own figure, so no total difference is '
          + 'stated — and none is stated as zero.'
        : `${sameRows ? 'All of them name' : `${fmt(t.comparable_rows)} of them name`} `
          + `the period they settle and carry our figure for it: ${money(t.calculated, 'AED', 2)} `
          + `against ${money(t.wire_comparable ?? t.wire, 'AED', 2)} of wire, a difference of `
          + `${signedMoney(t.delta)}.`),
      t.calculated == null ? 'warn' : null));
    if (t.basis) p.body.append(el('p', 'cap', esc(t.basis)));
  }

  /* ── every reason a row has no comparison, in full, under the table ───────
     Grouped by the SENTENCE and not by the row, the way tableFrom groups its
     own absent-column notes: Bolt files 175 transfers and every one of them
     carries the identical reason, and printing it 175 times would bury the
     one row that has a different one. */
  const byReason = new Map();
  for (const r of rows) {
    if (r.calculated != null) continue;
    const k = r.calculated_basis || 'no reason was given for this, which is itself a defect';
    if (!byReason.has(k)) byReason.set(k, []);
    byReason.get(k).push(r);
  }
  for (const [reason, rs] of byReason) {
    const who = [...new Set(rs.map((x) => sourceLabel(x.platform)))].join(', ');
    p.body.append(note(`No comparison is made for ${countOf(rs.length, 'transfer')} (${who}), `
      + `and that is not a difference of zero. ${reason}`, 'warn'));
  }

  if (rec.note) p.body.append(note(rec.note));

  drawUnchecked(hostEl, rec, run);
}

/* ── WHAT WE HAVE NOT ASKED UBER ABOUT ───────────────────────────────────
   ═════════════════════════════════════════════════════════════════════════
   The house principle, applied to the one absence on this page that a reader
   would never otherwise see. Every other absence here is a figure that is
   missing from a row that exists. This one is the rows that do not exist:
   Uber's organisation statement is a per-day document, the nightly walk is
   bounded at 24 days per fleet per run and was cut to 4 by Uber's report
   limiter on the night of 2026-09-16, so on 2026-09-17 uber/ecosine holds 4
   statement days out of a record that runs to hundreds.

   A day with no statement row is a day NOBODY ASKED ABOUT. It is not a day
   with no transfer. The two look identical on a page that only lists what it
   holds, and the difference between them is the difference between "Uber did
   not pay us that week" and "we have not looked" — which is the single worst
   confusion this page could cause, because the first is a reason to ring
   Uber and the second is a reason to press a button.

   So the count is stated, per fleet, in plain English, and the button is
   right there. */
function drawUnchecked(hostEl, rec, run) {
  const unchecked = Array.isArray(rec.unchecked) ? rec.unchecked : [];
  const p = panel('What we have not asked Uber about',
    'Uber answers one day at a time, and most of the record has never been asked for. These '
    + 'are those days.', 'payout-unchecked');
  hostEl.append(p.panel);

  if (!unchecked.length) {
    /* AN EMPTY LIST AND A FILTERED-OUT LIST ARE NOT THE SAME FACT.
       ────────────────────────────────────────────────────────────────────────
       THE DEFECT. This panel is Uber-only by construction — Uber is the one
       provider with a per-day statement that can be missing — but the page
       sends the global platform chip on every call. With the chip on Bolt or
       Yango the route correctly returns nothing, and this branch then told the
       operator that every day in the window had been asked about. On production
       that is false for roughly twenty-six days per fleet, and it is the exact
       inversion the panel exists to prevent: a page reporting an absence of
       gaps because it had filtered the gaps out of its own question. The route
       now returns the filter it applied, so the two states can be told apart
       and neither is stated as the other. */
    const chip = rec.filters && rec.filters.platform;
    if (chip && chip !== 'uber') {
      p.body.append(note(`This panel is about Uber’s per-day statement, and the platform filter `
        + `is set to ${sourceLabel(chip)} — so it has nothing to say here. That is NOT the same `
        + 'as every day having been asked about. Clear the platform filter, or set it to Uber, '
        + 'to see the days we hold no statement for.'));
      return;
    }
    p.body.append(note('Every day in this window has an Uber statement stored against it, so '
      + 'there is no day here that we hold no measurement for. Where a day shows no transfer, '
      + 'that is a measurement: Uber published the transfer column and left it empty.'));
    return;
  }

  const countOfPair = (u) => (u.count != null ? u.count : (u.days || []).length);
  const total = unchecked.reduce((a, u) => a + countOfPair(u), 0);

  /* THE SENTENCE. Written here rather than echoed from the endpoint, because
     this is the page's own guarantee and it must not be able to disappear by
     the server rewording its prose. The endpoint's reason is printed under it
     as well, in the provider's own terms. */
  /* "NOBODY HAS ASKED" IS NOT WHAT THIS PANEL KNOWS.
     ────────────────────────────────────────────────────────────────────────
     THE DEFECT, disproved by this change's own measurement. This sentence
     opened "Nobody has asked Uber about N days in this window", which is a
     claim about what was DONE. What the page actually knows is what is HELD:
     there is no statement row for those days. A day that WAS asked and came
     back refused leaves no row either — and that is not hypothetical, it is
     the event this whole batch was built around. On the night of 2026-09-16
     the walk asked eight days for Ecosine and stored four, because Uber's
     report limiter shut. Under the old wording the page would have told an
     operator that nobody asked about the four it was refused.

     The house rule is not "give a reason" but never give a reason that is not
     the true one, so the sentence now names both ways a day lands here and
     asserts neither. Everything downstream — the count, the chips, the button
     — is unchanged by saying it correctly. */
  p.body.append(note(`We hold no Uber statement for ${countOf(total, 'day')} in this window — `
    + 'either nobody asked, or the ask was refused: Uber’s report limiter shuts for minutes '
    + 'at a time and cut the walk of 16 Sep to four of the eight days it asked for. Either '
    + 'way it is a day with no measurement, a day with no measurement cannot be reported as a '
    + 'day with no transfer, and not one of them is shown anywhere on this page as a zero. '
    + 'Uber publishes a one-day organisation statement and the nightly walk is bounded per '
    + `run, so this is the ordinary state of the record rather than a fault. Pick up to `
    + `${MAX_ASK} days below and ask now.`, 'warn'));

  for (const u of unchecked) {
    const n = countOfPair(u);
    const box = el('div');
    box.style.marginTop = '14px';
    box.append(el('p', 'cap',
      `<b>${esc(sourceLabel(u.platform))} · ${esc(sourceLabel(u.fleet_id) || u.fleet_id)}</b> — `
      + `${esc(countOf(n, 'day'))} nobody has asked about.`));
    if (u.why) box.append(el('p', 'cap', esc(u.why)));
    box.append(askControl(u, run));
    p.body.append(box);
  }
}

/* ── the control that asks Uber directly ─────────────────────────────────
   One block per platform+fleet, and the selection never crosses a fleet,
   because the route takes ONE fleet and answers about it — a control that
   let an operator tick days from both would either refuse the whole ask or,
   worse, answer about Ecosine under a request that named Egari.

   Newest first. The backfill fills oldest first for a reason of its own (a
   gap in the middle of the record is worse than a short tail), and a person
   at this page wants last Monday. Mondays are marked, because Uber has only
   ever been seen to wire on one and a day chosen at random is a day almost
   certain to come back with an empty bank column. */
function askControl(u, run) {
  const wrap = el('div');
  const days = [...(u.days || [])].sort().reverse();
  const sel = new Set();

  const chips = el('div', 'chips');
  const row = el('div', 'btnrow');
  row.style.marginTop = '10px';
  const go = el('button', 'btn primary');
  go.type = 'button';
  /* Marked so reconcileSection() can find every ask button on the page and
     lock them all while one ask is walking Uber's limiter — see run(). */
  go.dataset.ask = '1';
  const said = el('span', 'cap');

  const sync = () => {
    [...chips.children].forEach((c) => c.classList.toggle('on', sel.has(c.dataset.day)));
    /* `locked` beats the selection. Without it, ticking a day in the OTHER
       fleet's control while an ask is running called sync() and re-enabled
       that fleet's button, defeating the lock from a path that looks like it
       only touches chips. */
    go.disabled = sel.size === 0 || go.dataset.locked === '1';
    /* .btn.primary sets its own background and colour, so a disabled one is
       painted exactly like a live one — the browser's default disabled
       rendering never gets a look in. The cue is set here rather than in
       app.css because this is the only primary button in the product that
       spends most of its life disabled. */
    go.style.opacity = go.disabled ? '0.45' : '';
    go.style.cursor = go.disabled ? 'not-allowed' : 'pointer';
    go.textContent = sel.size
      ? `Ask Uber about ${countOf(sel.size, 'day')}`
      : 'Ask Uber about these days';
  };

  for (const day of days) {
    const b = el('button', 'chip');
    b.type = 'button';
    b.style.cursor = 'pointer';
    b.dataset.day = day;
    const wd = weekdayOf(day);
    b.textContent = wd === 'Monday' ? `${day} · Mon` : day;
    b.title = wd === 'Monday'
      ? `${day} is a Monday, and Uber wires on a Monday — this is a day a transfer is likely `
        + 'to be found on.'
      : `${day} is a ${wd || 'day with no weekday'}. Uber has only ever been seen to wire on a `
        + 'Monday, so this day will most likely come back with an empty bank column — which is '
        + 'a measured day with no transfer, and worth having.';
    b.onclick = () => {
      if (sel.has(day)) {
        sel.delete(day);
        said.textContent = '';
      } else if (sel.size >= MAX_ASK) {
        /* REFUSED HERE AND SAID OUT LOUD, rather than sent and refused by the
           route. The cap is not arbitrary: one report is ten to forty seconds
           and Uber's limiter shuts for minutes once about three are in
           flight, so five is roughly three minutes of walking and the most
           one request may hold that queue for. */
        said.textContent = `${MAX_ASK} days is the cap for one ask — Uber’s payment-report `
          + 'limiter shuts for minutes once about three reports are in flight, so this walks '
          + 'one day at a time. Unpick one first.';
        return;
      } else {
        sel.add(day);
        said.textContent = '';
      }
      sync();
    };
    chips.append(b);
  }

  /* Folded, because a fleet can be several hundred days behind and a wall of
     three hundred buttons is not a control. */
  foldChildren(wrap, chips, { shown: 28, noun: 'day',
    key: `payout-unasked:${u.platform}:${u.fleet_id}` });

  const mondays = days.filter((x) => weekdayOf(x) === 'Monday');
  if (mondays.length) {
    const mb = el('button', 'btn');
    mb.type = 'button';
    const take = Math.min(MAX_ASK, mondays.length);
    mb.textContent = `Pick the newest ${countOf(take, 'Monday', 'Mondays')}`;
    mb.title = 'Uber wires on a Monday and the Monday wire settles the week that ended the day '
      + 'before, so the Mondays are the days that carry a transfer to find.';
    mb.onclick = () => {
      sel.clear();
      mondays.slice(0, take).forEach((x) => sel.add(x));
      said.textContent = '';
      sync();
    };
    row.append(mb);
  }

  go.onclick = () => run(u.fleet_id, [...sel].sort(), { go, said });
  row.append(go, said);
  wrap.append(row);
  sync();
  return wrap;
}

/* ── what Uber said, per day ─────────────────────────────────────────────
   Every column here can be absent and every absence has a different reason,
   so none of them share a renderer. In particular the two ways a wire can be
   missing are kept apart at every level of this stack, because they were the
   original defect the collector was written around: Uber leaves the transfer
   cell BLANK on a day it did not wire, which is a measurement of zero, and a
   report that does not carry the column at all is a provider change. The
   route maps the first to 0 and the second to null; this renders the first
   as "none" and the second as an absence with its reason. */
function verifyTable(rows) {
  return tableFrom(rows, [
    { label: 'Day', key: 'day',
      render: (r) => `<b>${esc(dateStr(r.day))}</b>`
        + `<span class="dim"> · ${esc(weekdayOf(r.day) || '')}</span>` },
    { label: 'Uber’s wire', key: 'wire', num: true,
      render: (r) => {
        if (!r.uber) {
          return absent('nothing learned', r.why || 'Uber was not asked about this day, or did '
            + 'not answer — no figure here, and certainly not a zero');
        }
        if (r.wire == null) {
          return absent('column absent', 'Uber’s report did not carry the transfer column at '
            + 'all. That is a provider change, and it is not the same as the empty cell Uber '
            + 'leaves on a day it did not wire.');
        }
        return r.wire > 0.005
          ? `<b>${money(r.wire, 'AED', 2)}</b>`
          : '<span class="dim" title="Uber published the transfer column and left it empty — a '
            + 'measured day with no transfer, not a missing figure">none</span>';
      } },
    { label: 'Settles', key: 'settles',
      render: (r) => (r.settles && r.settles.period_start && r.settles.period_end
        ? `<span title="${esc(r.settles.basis || '')}">`
          + `${periodRange(r.settles.period_start, r.settles.period_end)}</span>`
        : absent(r.settles ? 'not stated' : 'no transfer',
          (r.settles && r.settles.basis)
          || 'no transfer left on this day, so there is no period for one to settle')) },
    { label: 'We held before', key: 'stored_before',
      num: true,
      render: (r) => {
        const sb = r.stored_before || {};
        const head = sb.wire == null
          ? absent('no transfer stored', sb.had_statement
            ? 'a statement for this day was already stored and it carried no transfer'
            : 'nothing at all was stored for this day before this ask')
          : money(sb.wire, 'AED', 2);
        return `${head}<span class="dim"><br>${sb.had_statement
          ? 'statement was stored' : 'no statement was stored'}</span>`;
      } },
    { label: 'Our figure', key: 'calculated', num: true,
      render: (r) => {
        if (!r.calculated) {
          return absent('not compared', r.why || 'no transfer left on this day, so there is no '
            + 'week for our own figure to be summed over');
        }
        return r.calculated.value == null
          ? absent('not collected', r.calculated.basis)
          : `<span title="${esc(r.calculated.basis || '')}">`
            + `${money(r.calculated.value, 'AED', 2)}</span>`;
      } },
    /* The same treatment as the reconciliation table, from the same function,
       so a difference an operator reads after asking Uber directly cannot be
       coloured by a different rule from the one they read a minute earlier. */
    { label: 'Difference', key: 'delta', num: true,
      cellCls: (r) => (r.delta ? deltaTone(r.delta.value, r.delta.pct) || '' : ''),
      render: (r) => (!r.delta || r.delta.value == null
        ? absent('no comparison', (r.calculated && r.calculated.basis) || r.why
          || 'nothing on this day can be compared, and that is not a difference of zero')
        : `<b class="dl">${esc(signedMoney(r.delta.value))}</b>`
          + (r.delta.pct == null ? ''
            : `<span class="dim">&nbsp;·&nbsp;${esc(signedPct(r.delta.pct))}</span>`)) },
    /* A DIFFERENCE, NOT A CHECK. This column is the retracted "to the fils"
       claim rendered honestly: it prints how far the wire sat from the
       opening balance of the day it left on, and its title carries the three
       measured Mondays that disprove the equality. */
    { label: 'Against the opening balance', key: 'balance_check', num: true,
      render: (r) => (!r.balance_check
        ? absent('no balance', 'no statement balance was collected for this day, or no transfer '
          + 'left on it — either way there is nothing to put the wire against')
        : `<span title="${esc(r.balance_check.note || '')}">`
          + `${esc(signedMoney(r.balance_check.difference))}</span>`) },
    { label: 'Written', key: 'stored',
      render: (r) => (r.stored
        ? pill('stored', 'ok', 'Uber answered and the statement row was written to the register')
        : pill('not stored', 'warn', r.why || 'nothing was written for this day')) },
  ], { sortId: 'payout-verify' });
}
