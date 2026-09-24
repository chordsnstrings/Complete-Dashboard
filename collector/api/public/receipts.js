/* What landed, and when — the finance team's register.
   ═══════════════════════════════════════════════════════════════════════════
   Asked for in these words: "we are more interested in how much got into the
   account, which date, from the source exactly, and how much cash is left to
   who — all granular data that we can get on finance."

   That is not the question the rest of the product answers. Money asks what a
   month was worth and what each car earned. A finance team asks which document
   said so, covering which dates, for how much, and when it arrived — because
   that is what a bank line is reconciled against, and what next month's figure
   is predicted from.

   #provenance already answers "where did the total come from" at the level of
   the API surface: Uber payout, AED 406,893, over 1,204 rows. Right shape for
   checking a headline, wrong shape for being asked when the money landed. This
   page is the level below it: one row per document a provider filed, dated,
   with what it covers and when we first saw it.

   ── three things this page refuses to do ────────────────────────────────
   It does not divide a week into days. A weekly statement is ONE measurement
   of seven days; shown as seven daily figures it would be indistinguishable
   from seven measurements, and a number nobody took would sit in a table
   beside numbers somebody did. The Grain column is therefore not decoration —
   it is the column that says which rows are dated money and which are a week's
   worth attributed to a week.

   It does not add up restatements. Providers re-file: the same money, for an
   overlapping period, sent again. Uber's breakdown serves the same driver-week
   as a weekly row and, for recent days, as daily rows — both true, both the
   same money, and summed they made August's payout AED 1.41m against the AED
   415k the fleet was actually paid. Those rows are marked and excluded from
   the month totals, and the excluded amount is printed beside each month so
   the subtraction can be checked rather than believed.

   And it does not silently book a straddling period. Five weeks a year cross a
   month end. The convention here is that a period belongs to the month it ENDS
   in, and the number of straddling periods is shown per month so a reader can
   see how much of the total rests on that convention. */
import { el, esc, panel, loading, tableFrom, kpiRow, note, sourceLabel, money,
  countOf, dateStr, dtStr, contract, glance, secHead, absenceBand, pageFoot, andList } from './ui.js';
import { fmt, empty, barChart, hbars, gapBars } from './charts.js';
import { q, href, windowLabel } from './data.js';
import { dubaiDay } from './tz.js';

/* The provider's own word, spaced for reading but never renamed — the same
   rule #provenance follows, and for the same reason: `net_fare` and
   `your_earnings` are two APIs' names for nearly the same thing, and folding
   them into one word here would hide the disagreement. */
const words = (s) => String(s || '').replace(/_/g, ' ');

const KIND = {
  fare: 'A rider’s fare, per trip',
  payout: 'What the platform says it paid us',
  component: 'A named line inside a payout',
  ledger: 'A transaction between the fleet and the platform',
  statement: 'A statement the operator imported',
};

/* A period, in the words a finance person uses for one. The dates are the
   fact; this is the shape of them, which is what makes a table of four hundred
   rows scannable. */
const grainOf = (r) => (r.days === 1 ? 'One day'
  : r.days === 7 ? 'A week'
    : r.days >= 28 && r.days <= 31 ? 'A month'
      : `${fmt(r.days)} days`);

/* The month rollup, shared by both orders of the page. */
function monthsOf(d) {
  const byMonth = new Map();
  for (const m of d.months || []) {
    const k = String(m.month).slice(0, 10);
    const cur = byMonth.get(k) || { month: k, amount: 0, superseded_amount: 0, rows_seen: 0,
      periods: 0, straddling: 0, platforms: new Set(), kinds: new Set() };
    cur.amount += +m.amount || 0;
    cur.superseded_amount += +m.superseded_amount || 0;
    cur.rows_seen += m.rows_seen || 0;
    cur.periods += m.periods || 0;
    cur.straddling += m.straddling || 0;
    cur.platforms.add(m.platform);
    cur.kinds.add(m.kind);
    byMonth.set(k, cur);
  }
  const months = [...byMonth.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
  return months;
}

export async function renderReceipts(root) {
  root.innerHTML = '';
  loading(root);
  const d = await q('/api/finance/receipts').catch(() => null);
  root.innerHTML = '';
  if (!d) {
    empty(root, 'The receipts register did not answer',
      'Collection gaps says which feeds ran; this page reads what they filed.');
    return;
  }
  if (!d.rows.length) {
    empty(root, 'No provider filed anything covering this window',
      'Not necessarily a quiet month — a provider that has stopped filing looks exactly '
      + 'like one with nothing to file, and Collection gaps is the page that tells them apart.');
    return;
  }
  /* The page contract (plan §4 receipts) is its own order of the same
     answer; the old skin's page below is unchanged. */
  if (contract()) { receiptsContract(root, d); return; }

  /* SUPERSEDED, not merely contested. Both sides of a re-filing are marked
     `restated` — neither row can say alone which is the truth — so counting
     only the unmarked rows removes the money as well as the duplicate. The
     endpoint applies the rule (longest period wins, newest among equals) and
     `superseded` is its answer; this page reads it rather than re-deriving
     it, because a page that re-derives a rule drifts from it. */
  const live = d.rows.filter((r) => !r.superseded);
  const sum = (rows, k = 'amount') => rows.reduce((a, r) => a + (+r[k] || 0), 0);
  const supersededRows = d.rows.filter((r) => r.superseded);
  const contested = d.rows.filter((r) => r.restated);
  const dated = live.filter((r) => r.is_daily);
  const newest = d.rows.reduce((m, r) => (r.first_seen > (m || '') ? r.first_seen : m), null);

  root.append(kpiRow([
    /* The headline is the number of DOCUMENTS, not the money. This page is a
       register, and its first fact is how many filings it holds — the money
       total lives per month below, where the restatement subtraction is
       visible beside it. A single total up here would be the one figure on the
       page that cannot show its own working. */
    { label: 'Filings on record', value: fmt(d.rows.length),
      sub: `${fmt(new Set(d.rows.map((r) => `${r.source}|${r.platform}`)).size)} `
        + 'source-and-channel combinations'
        + (d.truncated ? ' — the list below is capped at 600 rows' : '') },
    { label: 'Credited, net of re-filings', value: money(sum(live)),
      sub: supersededRows.length
        ? `${countOf(supersededRows.length, 'filing')} superseded by a longer filing of the `
          + `same period, worth ${money(sum(supersededRows))}, are left out of this`
        : contested.length
          ? `${countOf(contested.length, 'filing')} overlap another and none is superseded — `
            + 'nothing has been left out'
          : 'no provider has re-filed a period in this window',
      tone: supersededRows.length ? 'warn' : null },
    /* The grain split, because it decides how much of the register can be
       reconciled to a bank line by date at all. */
    { label: 'Filed for a single date', value: fmt(dated.length),
      sub: `${fmt(live.length - dated.length)} cover a span of days, and are not divisible `
        + 'into daily figures without inventing them' },
    newest
      ? { label: 'Newest filing received', value: dtStr(newest),
        sub: 'when the document reached us — a different date from the period it covers' }
      : null,
  ]));

  /* ── the month rollup, which is what a forecast will eventually read ──── */
  const months = monthsOf(d);

  if (months.length > 1) {
    const mp = panel('By month, as the providers booked it',
      'A period belongs to the month it ENDS in. Re-filings are excluded from every bar and '
      + 'named in the table underneath, so the total and the subtraction are both on screen.');
    const chart = el('div');
    mp.body.append(chart);
    /* Oldest first, because a month series read left to right is a series and
       read right to left is a list. */
    const series = [...months].reverse();
    /* `x` and `y` are the KEY NAMES and barChart gives them no defaults — a
       call that omits them reads `d[undefined]`, every bar is NaN, and the
       chart draws an empty 0..1 axis in a full-height panel. Which is exactly
       what this one did until it was looked at. */
    barChart(chart, series.map((m) => ({ m: dateStr(m.month).replace(/^\d+ /, ''), amount: m.amount })),
      { x: 'm', y: 'amount',
        valueFmt: (v) => money(v),
        /* Money on the axis as well as in the tooltip: "1,240" and "AED 1,240"
           are different claims, and this axis is only ever money. */
        axisFmt: (v) => money(v) });
    mp.body.append(tableFrom(months, [
      { label: 'Month', key: 'month',
        render: (m) => `<b>${esc(dateStr(m.month).replace(/^\d+ /, ''))}</b>` },
      { label: 'Credited', key: 'amount', num: true, render: (m) => money(m.amount) },
      { label: 'Left out as superseded', key: 'superseded_amount', num: true,
        render: (m) => (m.superseded_amount
          ? `<span class="dim" title="a shorter filing of a period a longer one already covers">${money(m.superseded_amount)}</span>`
          : '<span class="ent-off" title="no filing in this month was superseded by a longer one">none</span>') },
      { label: 'Filings', key: 'periods', num: true,
        render: (m) => `${fmt(m.periods)}`
          + (m.straddling
            ? `<span class="dim" title="periods that begin in the previous month — booked here because they end here"> · ${fmt(m.straddling)} straddle the month end</span>`
            : '') },
      { label: 'Channels', key: 'platforms',
        render: (m) => [...m.platforms].map(sourceLabel).join(', ') },
    ], { sortable: true, sortId: 'rcpt-month' }));
    root.append(mp.panel);
  }

  /* ── the register itself ─────────────────────────────────────────────── */
  const rp = panel('Every filing, newest first',
    d.note + ' ' + d.restated_note);
  rp.body.append(tableFrom(d.rows, [
    { label: 'Covers', key: 'period_end',
      render: (r) => (r.is_daily
        ? `<b>${esc(dateStr(r.period_start))}</b>`
        : `<b>${esc(dateStr(r.period_start))}</b><span class="dim"> → </span><b>${esc(dateStr(r.period_end))}</b>`) },
    { label: 'Grain', key: 'days', num: true,
      render: (r) => `<span class="tag${r.is_daily ? ' ok' : ''}">${esc(grainOf(r))}</span>` },
    { label: 'From', key: 'source',
      render: (r) => `<b>${esc(sourceLabel(r.platform))}</b>`
        + `<span class="dim"> · ${esc(words(r.source))}</span>`
        + (r.fleet_id ? `<span class="dim"> · ${esc(r.fleet_id)}</span>` : '') },
    { label: 'What it is', key: 'kind',
      render: (r) => `${esc(words(r.kind))}<span class="dim"> — ${esc(KIND[r.kind] || 'a figure the provider sent')}</span>` },
    { label: 'Amount', key: 'amount', num: true,
      render: (r) => (r.superseded
        ? `<span class="dim" title="a longer filing covers this period, so this one is left out of the month totals">${money(r.amount)}</span>`
        : money(r.amount)) },
    /* Credits and debits apart, because a payout row nets a commission against
       a fare and a finance team is asked about both halves. */
    { label: 'Of which fees', key: 'debits', num: true,
      render: (r) => (r.debits
        ? `<span style="color:var(--critical)">${money(r.debits)}</span>`
        : '<span class="ent-off" title="no negative line in this filing">none</span>') },
    { label: 'People', key: 'drivers', num: true,
      render: (r) => (r.drivers
        ? fmt(r.drivers)
        : '<span class="ent-off" title="this filing is about the fleet, not about named drivers">fleet</span>') },
    { label: 'First seen', key: 'first_seen',
      render: (r) => (r.first_seen
        ? `${dtStr(r.first_seen)}`
          + (r.last_seen && r.last_seen !== r.first_seen
            ? `<span class="dim"> · re-read ${dtStr(r.last_seen)}</span>` : '')
        : '<span class="ent-off" title="this row predates the ingest stamp">not recorded</span>') },
    /* Three states, not two. "Overlaps something" and "loses to something"
       are different facts, and a reader deciding whether a figure is in the
       month total needs the second one. */
    { label: 'Status', key: 'superseded',
      render: (r) => (r.superseded
        ? '<span class="tag warn" title="a longer filing covers this same period — counting both would count the money twice, so this one is left out of the month totals">Superseded</span>'
        : r.restated
          ? '<span class="tag" title="another filing overlaps this period, and this is the longer of the two — this is the one counted">Counted, re-filed</span>'
          : '<span class="tag ok">Counted</span>') },
  ], { sortable: true, sortId: 'rcpt', defaultSort: null }));
  root.append(rp.panel);

  root.append(note(d.month_note));
  const links = el('p', 'cap');
  links.innerHTML = 'Next to this: '
    + `<a class="lnk" href="${href('reconcile')}">what the bank actually received</a>, `
    + `<a class="lnk" href="${href('settlement', 'cash')}">how much cash drivers are holding</a>, `
    + `<a class="lnk" href="${href('settlement', 'receivables')}">what is still owed to us</a>, and `
    + `<a class="lnk" href="${href('provenance')}">which API surface each total is built from</a>.`;
  root.append(links);
}

/* ── #receipts under the page contract ─────────────────────────────────────
   00: Filings on record, the hero (a register's first fact is how many
   documents it holds) · Credited, net of re-filings — KEPT, with "not a total
   across kinds" said on it until the operator rules (the review's
   correction) · set aside as re-filed · provider rows inside · filed for a
   single date · days claimed · when each arrived — ABSENT where every row
   carries one stamp (it is the last rebuild, not the arrival).
   01 how many documents claim each day · 02 how many of those a later
   filing displaces · 03 what each kind is worth · 04 what a later filing
   displaced, by kind · 05 the grain each was filed at · 06 which surface
   filed them · 07 by month, as the old page (when the window spans more
   than one) · 08 the register — its columns, sort and three-state status
   kept; tags neutral; fees in ink with a minus; First seen dropped, with the
   reason, while every row shares one stamp · † the arrival stamp, the
   restatement rule, the straddle convention, why kinds are not a total.
   NOT ADOPTED: the ten largest documents (the register sorted by Amount);
   "set aside as re-filed" as the hero (the count is); "Uber on four of its
   surfaces" as fixed text (the surfaces are counted from the rows). */
const dayList = (a, b) => {
  const out = [];
  for (let t = Date.parse(`${a}T12:00:00Z`), e = Date.parse(`${b}T12:00:00Z`); t <= e; t += 864e5) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};
function receiptsContract(root, d) {
  const rows = d.rows;
  const live = rows.filter((r) => !r.superseded);
  const sum = (rs, k = 'amount') => rs.reduce((a, r) => a + (+r[k] || 0), 0);
  const sup = rows.filter((r) => r.superseded);
  const setAside = sum(sup) + sum(live, 'superseded_amount');
  const dated = live.filter((r) => r.is_daily);
  const stamps = new Set(rows.map((r) => r.first_seen).filter(Boolean));
  const oneStamp = rows.length > 1 && stamps.size === 1;
  const claims = new Map(); const displaced = new Map();
  rows.forEach((r) => {
    if (!r.period_start || !r.period_end) return;
    dayList(String(r.period_start).slice(0, 10), String(r.period_end).slice(0, 10)).forEach((day) => {
      claims.set(day, (claims.get(day) || 0) + 1);
      if (r.superseded) displaced.set(day, (displaced.get(day) || 0) + 1);
    });
  });
  const kinds = [...new Set(rows.map((r) => r.kind))];

  const band = el('section', 'cband');
  const tiles = el('div');
  band.append(secHead('00', 'At a glance', windowLabel()), tiles);
  root.append(band);
  glance(tiles, [
    { label: 'Filings on record', value: fmt(rows.length), hero: true,
      sub: `${fmt(new Set(rows.map((r) => `${r.source}|${r.platform}`)).size)} source-and-channel combinations`
        + (d.truncated ? ' — the register below is capped at 600 rows' : '') },
    { label: 'Credited, net of re-filings', value: money(sum(live)),
      sub: `not a total across kinds — ${andList(kinds.map(words))} are different views of the same trading, `
        + 'added here only until the operator rules; the kinds are apart in 03' },
    { label: 'Set aside as re-filed', value: money(setAside),
      sub: sup.length ? `${countOf(sup.length, 'filing')} superseded by a longer filing of the same period, and the overlapped parts of others`
        : 'no provider has re-filed a period in this window' },
    { label: 'Provider rows inside', value: fmt(sum(rows, 'rows_seen')), sub: 'the provider lines the filings were built from' },
    { label: 'Filed for a single date', value: fmt(dated.length),
      sub: `${fmt(live.length - dated.length)} cover a span of days and are not divisible into daily figures without inventing them` },
    { label: 'Days claimed', value: fmt(claims.size), sub: 'the days at least one filing covers' },
    oneStamp
      ? { label: 'When each one arrived', na: `one stamp on all ${fmt(rows.length)} — it is the last rebuild of the register, not when each document reached us` }
      : stamps.size ? { label: 'When each one arrived', value: dtStr([...stamps].sort().pop()),
        sub: 'the newest arrival — a different date from the period it covers' }
        : { label: 'When each one arrived', na: 'no filing here carries an arrival stamp' },
  ]);

  /* Every day from the first claimed to the last: a day no filing claims is
     a hole (outlined), not a nought; a day after today that a filing already
     claims is hatched, the way an unfinished day is. */
  const today = dubaiDay();
  const span = claims.size ? dayList([...claims.keys()].sort()[0], [...claims.keys()].sort().pop()) : [];
  const perDay = (m) => span.map((day) => ({ d: day, n: m.get(day) || 0, none: !claims.has(day), ahead: day > today }));
  const dayOpts = { x: 'd', y: 'n', color: '--ink', gapKey: 'none', gapLabel: 'no filing claims this day', bucketNoun: 'days',
    inProgress: false, hatchIf: (r) => r.ahead, hatchNote: 'a day still to come, claimed ahead by a filing whose period runs past today',
    valueFmt: (v) => fmt(v) };
  const g1 = el('div', 'grid g2'); root.append(g1);
  const p1 = panel('How many documents claim each day', 'Every day inside a filing\u2019s period, counted once per filing.', 'rcpt-claims');
  const p2 = panel('How many of each day\u2019s claims a later filing displaces', 'The superseded filings, on the days they covered.', 'rcpt-displaced');
  g1.append(p1.panel, p2.panel);
  if (claims.size) gapBars(p1.body, perDay(claims), { ...dayOpts, label: 'filings' });
  else empty(p1.body, 'No filing states the period it covers.');
  if (displaced.size) gapBars(p2.body, perDay(displaced), { ...dayOpts, label: 'displaced', color: '--grey' });
  else empty(p2.body, 'No filing in this window was displaced by a later one.');

  const g2 = el('div', 'grid g2'); root.append(g2);
  const p3 = panel('What each kind is worth', 'After the overlap rule — never added across kinds.', 'rcpt-kinds');
  const p4 = panel('What a later filing displaced, by kind', null, 'rcpt-kind-displaced');
  g2.append(p3.panel, p4.panel);
  const byKind = kinds.map((k) => ({ label: words(k), n: sum(live.filter((r) => r.kind === k)),
    x: sum(sup.filter((r) => r.kind === k)) + sum(live.filter((r) => r.kind === k), 'superseded_amount') }));
  /* Signed only when a kind nets negative: a zero axis in the middle of a
     chart of positive sums halves every bar for nothing. */
  hbars(p3.body, byKind.map((k) => ({ label: k.label, n: k.n })), { signed: byKind.some((k) => k.n < 0), color: '--ink', negColor: '--grey', valueFmt: (v) => money(v) });
  const dk = byKind.filter((k) => k.x);
  if (dk.length) hbars(p4.body, dk.map((k) => ({ label: k.label, n: k.x })), { signed: dk.some((k) => k.x < 0), color: '--grey', valueFmt: (v) => money(v) });
  else empty(p4.body, 'Nothing was displaced in this window.');

  const g3 = el('div', 'grid g2'); root.append(g3);
  const p5 = panel('The grain each was filed at', 'Days per document.', 'rcpt-grain');
  const p6 = panel('Which surface filed them', null, 'rcpt-surface');
  g3.append(p5.panel, p6.panel);
  const grains = new Map();
  rows.forEach((r) => { const g = grainOf(r); grains.set(g, (grains.get(g) || 0) + 1); });
  hbars(p5.body, [...grains.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, n })), { signed: false, color: '--ink' });
  const surf = new Map();
  rows.forEach((r) => { const k = `${sourceLabel(r.platform)} · ${words(r.source)}${r.fleet_id ? ` · ${r.fleet_id}` : ''}`; surf.set(k, (surf.get(k) || 0) + 1); });
  hbars(p6.body, [...surf.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, n })), { signed: false, color: '--ink' });

  const months = monthsOf(d);
  if (months.length > 1) {
    const mp = panel('By month, as the providers booked it',
      'A period belongs to the month it ENDS in. Re-filings are excluded from every bar and '
      + 'named in the table underneath, so the total and the subtraction are both on screen.', 'rcpt-months');
    const chart = el('div'); mp.body.append(chart);
    barChart(chart, [...months].reverse().map((m) => ({ m: dateStr(m.month).replace(/^\d+ /, ''), amount: m.amount })),
      { x: 'm', y: 'amount', color: '--ink', valueFmt: (v) => money(v), axisFmt: (v) => money(v) });
    mp.body.append(tableFrom(months, [
      { label: 'Month', key: 'month', render: (m) => `<b>${esc(dateStr(m.month).replace(/^\d+ /, ''))}</b>` },
      { label: 'Credited', key: 'amount', num: true, render: (m) => money(m.amount) },
      { label: 'Left out as superseded', key: 'superseded_amount', num: true,
        render: (m) => (m.superseded_amount ? `<span class="dim">${money(m.superseded_amount)}</span>`
          : '<span class="ent-off" title="no filing in this month was superseded by a longer one">none</span>') },
      { label: 'Filings', key: 'periods', num: true,
        render: (m) => `${fmt(m.periods)}${m.straddling ? `<span class="dim"> · ${fmt(m.straddling)} straddle the month end</span>` : ''}` },
      { label: 'Channels', key: 'platforms', render: (m) => [...m.platforms].map(sourceLabel).join(', ') },
    ], { sortable: true, sortId: 'rcpt-month' }));
    root.append(mp.panel);
  }

  const rp = panel('Every filing, newest first', `${d.note} ${d.restated_note}`, 'rcpt-register');
  rp.body.append(tableFrom(rows, [
    { label: 'Covers', key: 'period_end',
      render: (r) => (r.is_daily ? `<b>${esc(dateStr(r.period_start))}</b>`
        : `<b>${esc(dateStr(r.period_start))}</b><span class="dim"> → </span><b>${esc(dateStr(r.period_end))}</b>`) },
    { label: 'Grain', key: 'days', num: true, render: (r) => `<span class="tag">${esc(grainOf(r))}</span>` },
    { label: 'From', key: 'source',
      render: (r) => `<b>${esc(sourceLabel(r.platform))}</b><span class="dim"> · ${esc(words(r.source))}</span>`
        + (r.fleet_id ? `<span class="dim"> · ${esc(r.fleet_id)}</span>` : '') },
    { label: 'What it is', key: 'kind',
      render: (r) => `${esc(words(r.kind))}<span class="dim"> — ${esc(KIND[r.kind] || 'a figure the provider sent')}</span>` },
    { label: 'Amount', key: 'amount', num: true,
      render: (r) => (r.superseded ? `<span class="dim" title="a longer filing covers this period, so this one is left out of the month totals">${money(r.amount)}</span>`
        : money(r.amount)) },
    /* A deduction is not "worse": ink, with its sign (plan §4). */
    { label: 'Of which fees', key: 'debits', num: true,
      render: (r) => (r.debits ? money(-Math.abs(+r.debits)) : '<span class="ent-off" title="no negative line in this filing">none</span>') },
    { label: 'People', key: 'drivers', num: true,
      render: (r) => (r.drivers ? fmt(r.drivers) : '<span class="ent-off" title="this filing is about the fleet, not about named drivers">fleet</span>') },
    /* Dropped, with the reason printed beneath, while every row carries the
       same stamp: that stamp is the last rebuild, and a column reading
       "when the document reached us" over it would be a false reason. */
    ...(oneStamp ? [] : [{ label: 'First seen', key: 'first_seen',
      render: (r) => (r.first_seen
        ? `${dtStr(r.first_seen)}`
          + (r.last_seen && r.last_seen !== r.first_seen
            ? `<span class="dim"> · re-read ${dtStr(r.last_seen)}</span>` : '')
        : '<span class="ent-off" title="this row predates the ingest stamp">not recorded</span>') }]),
    { label: 'Status', key: 'superseded',
      render: (r) => (r.superseded
        ? '<span class="tag dim" title="a longer filing covers this same period — counting both would count the money twice, so this one is left out of the month totals">Superseded</span>'
        : r.restated ? '<span class="tag" title="another filing overlaps this period, and this is the longer of the two — this is the one counted">Counted, re-filed</span>'
          : '<span class="tag">Counted</span>') },
  ], { sortable: true, sortId: 'rcpt', defaultSort: null }));
  if (oneStamp) {
    rp.body.append(el('p', 'cap', esc(`No "first seen" column: all ${fmt(rows.length)} rows carry one stamp, `
      + `${dtStr([...stamps][0])} — the last rebuild of the register, not when each document arrived.`)));
  }
  root.append(rp.panel);
  root.append(note(d.month_note));
  const links = el('p', 'cap');
  links.innerHTML = 'Next to this: '
    + `<a class="lnk" href="${href('reconcile')}">what the bank actually received</a>, `
    + `<a class="lnk" href="${href('settlement', 'cash')}">how much cash drivers are holding</a>, `
    + `<a class="lnk" href="${href('settlement', 'receivables')}">what is still owed to us</a>, and `
    + `<a class="lnk" href="${href('provenance')}">which API surface each total is built from</a>.`;
  root.append(links);

  const absHost = el('div'); root.append(absHost);
  absenceBand(absHost, [
    { label: 'When each document arrived', hl: oneStamp, fig: oneStamp ? null : 'Held', none: 'One stamp on all',
      why: oneStamp ? 'Every row\u2019s first-seen is the last rebuild of the money register, so the arrival of each document is not held. '
        + 'Keeping it across rebuilds is a collector change, not a page one.'
        : `${fmt(stamps.size)} distinct arrival stamps across ${fmt(rows.length)} filings — each is when that document first reached us.` },
    { label: 'Which filing is counted', fig: 'The longest', why: 'Where filings overlap, the longest period wins and the newest among equals; the rest are set aside, never added.' },
    { label: 'A period across a month end', fig: 'Its end month', why: 'A period belongs to the month it ends in; each month says how many of its filings straddle.' },
    { label: 'A total across kinds', fig: null, none: 'Not a total',
      why: `${andList(kinds.map(words))} are different views of the same trading — a payout contains its components — so adding them counts money more than once.` },
  ]);
  pageFoot({ colophon: [windowLabel(), `${fmt(rows.length)} filings`] }, root);
}
