/* Where every figure came from.
   ─────────────────────────────────────────────────────────────────────────
   The headline is a CHOICE, and it was invisible. Money reaches this fleet
   through nine API surfaces — Uber has three that carry money and they
   disagree with each other — and api/income_sql.js picks ONE figure per
   channel, a fare total or a payout total but never both, since a payout is
   what is left of those same fares after the platform's commission. The loser
   is discarded. That rule is right, and a reader had no way to see it: no way
   to learn that Yango's payout was excluded because its fares won, or that a
   channel showing nothing was a dead credential rather than a quiet week, or
   that the park ledger this fleet has been collecting since the day it was
   wired up reaches no figure at all.

   So this page is the audit trail: one row per API call, what that call
   actually returned for this window, at the grain it returned it, and whether
   the headline uses it.

   Nothing on this page is derived, allocated or spread. Every figure is a sum
   of amounts a provider itself sent, over rows that still carry the call that
   sent them — which is why the grain column matters more than it looks. A
   weekly statement is ONE measurement of seven days. Shown as seven daily
   figures it would be indistinguishable from seven measurements, and a number
   nobody took would be sitting in a table beside numbers somebody did. */
import { el, esc, panel, loading, tableFrom, kpiRow, note, sourceLabel } from './ui.js';
import { fmt, empty } from './charts.js';
import { q, state } from './data.js';

/* The provider's own word, spaced for reading but never renamed: `net_fare`
   and `your_earnings` are two APIs' names for nearly the same thing, and
   folding them into one word here would hide exactly the disagreement this
   page exists to show. */
const words = (s) => String(s || '').replace(/_/g, ' ');

const KIND = {
  fare: 'What a rider paid, per trip',
  payout: 'What the platform says it paid us',
  component: 'A named line inside a payout',
  ledger: 'A transaction between the fleet and the platform',
  statement: 'A statement the operator imported',
};

/* Which surfaces the headline actually draws on. `/api/revenue` reports the
   basis it chose per channel, so this is read from the product rather than
   asserted here — a page describing a rule from memory drifts from the rule. */
const usedBy = (basis) => (basis === 'fares' || basis === 'partial_fares' ? 'fare'
  : basis === 'payout' || basis === 'partial_payout' ? 'payout' : null);

export async function renderProvenance(root) {
  root.innerHTML = '';
  loading(root);
  const [d, rev] = await Promise.all([
    q('/api/money/sources'),
    q('/api/revenue').catch(() => null),
  ]);
  root.innerHTML = '';

  if (!d.rows.length) {
    empty(root, 'No provider sent a figure for this window',
      'Not a quiet week necessarily — Collection gaps says which feeds ran.');
    return;
  }

  /* What the headline is made of, per channel, taken from the page that makes
     it rather than recomputed here. A page that describes a rule from memory
     drifts from the rule; this one reads /api/revenue's own answer, and says
     so when it could not. */
  const chosen = new Map();
  const basisOf = new Map();
  for (const p of rev?.platforms || []) {
    chosen.set(p.platform, usedBy(p.basis));
    basisOf.set(p.platform, p.basis);
  }
  const knowsBasis = !!(rev?.platforms || []).length;

  const inHeadline = (r) => knowsBasis && (r.kind === 'fare' || r.kind === 'payout')
    && chosen.get(r.platform) === r.kind;

  const counted = d.rows.filter(inHeadline);
  const held = d.rows.filter((r) => !inHeadline(r));
  const sum = (rows) => rows.reduce((a, r) => a + (+r.amount || 0), 0);

  /* The headline's OWN number, never a re-derivation of it. Recomputing it
     here would give this page a second opinion about the fleet's income,
     which is the disease it was built to diagnose — and it CANNOT be
     recomputed from this table anyway, which is the more important half.

     A provider does not send each figure once. Uber's breakdown serves the
     same driver-week as a weekly row and, for recent days, as daily rows —
     both true, both the same money. Added up, August's payout comes to AED
     1.41m against the AED 415k the fleet was actually paid. So the number
     from Finance is shown as Finance's, and this page says what it is for
     rather than pretending to reconcile to it. */
  const headline = rev?.totals?.accounted;
  const restated = d.rows.reduce((a, r) => a + (r.restated_rows || 0), 0);

  root.append(kpiRow([
    { label: 'API calls reporting money', value: fmt(new Set(d.rows.map((r) => r.source)).size),
      sub: `${fmt(d.rows.length)} channel-and-kind combinations` },
    { label: 'Figures the providers sent', value: fmt(d.rows.reduce((a, r) => a + r.rows_seen, 0)),
      sub: `${fmt(d.rows.reduce((a, r) => a + r.reported_days, 0))} for a single day · `
        + `${fmt(d.rows.reduce((a, r) => a + r.period_rows, 0))} for a span of days`
        + (restated ? ` · ${fmt(restated)} restating days another figure already covers` : '') },
    headline != null
      ? { label: 'What Finance counts', value: `AED ${fmt(headline)}`,
        sub: knowsBasis
          ? `one figure per channel — ${counted.map((r) => sourceLabel(r.platform))
            .filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'none'} — chosen from the calls below`
          : 'Revenue by channel did not answer, so this page cannot say which calls it used' }
      : { label: 'What Finance counts', value: '—',
        sub: 'Revenue by channel did not answer, so this page cannot say which calls it used' },
  ]));

  const cols = [
    { label: 'API surface', key: 'source',
      render: (r) => `<b>${esc(words(r.source))}</b>`
        + `<span class="dim"> · ${esc(sourceLabel(r.platform))}`
        + (r.fleet_id ? ` · ${esc(r.fleet_id)}` : '') + '</span>' },
    { label: 'What it reports', key: 'kind',
      render: (r) => `${esc(words(r.kind))}<span class="dim"> — ${esc(KIND[r.kind] || '')}</span>` },
    /* The grain, said as a fact about the provider rather than as a number.
       "7 days" in this column is the reason the money beside it cannot be
       read as a daily figure. */
    { label: 'Reported at', key: 'max_period_days',
      render: (r) => (r.period_rows === 0
        ? `<span class="tag ok">per day</span>`
        : `<span class="tag">${fmt(r.max_period_days)}-day periods</span>`
          + (r.reported_days ? `<span class="dim"> and ${fmt(r.reported_days)} single days</span>` : '')) },
    { label: 'Figures', key: 'rows_seen', num: true, render: (r) => fmt(r.rows_seen) },
    { label: 'Drivers', key: 'drivers', num: true,
      render: (r) => (r.drivers ? fmt(r.drivers) : '<span class="dim">—</span>') },
    { label: 'Returned', key: 'amount', num: true,
      render: (r) => `AED ${fmt(r.amount)}` },
    /* A verdict, not a second number. The obvious column here — "of that, the
       part said once" — is a subset sum, and the components carry negative
       lines, so on the live data that subset came out LARGER than the total it
       was a subset of. True, and unreadable. What a person needs from this
       column is whether the figure beside it can be added to anything, which
       is a yes or a no. */
    { label: 'Can it be added?', key: 'restated_rows', num: false,
      render: (r) => (r.restated_rows
        ? `<span class="tag bad">no</span><span class="dim"> — ${fmt(r.restated_rows)} of `
          + `${fmt(r.rows_seen)} figures restate days another already covers</span>`
        : '<span class="tag ok">yes</span><span class="dim"> — each day reported once</span>') },
    { label: 'In the headline', key: '_used', num: false,
      render: (r) => (inHeadline(r)
        ? '<span class="tag ok">counted</span>'
        : `<span class="tag dim">held out</span>`) },
  ];

  const p1 = panel('Every call that returned money in this window',
    'One row per API call, per channel, per kind of money. The amounts are sums of what that '
    + 'call itself returned — nothing here is allocated, spread or estimated. A provider that '
    + 'reports the same days twice, once weekly and once daily, is shown reporting them twice, '
    + 'which is why most of these amounts cannot be added to anything.');
  root.append(p1.panel);
  p1.body.append(tableFrom(d.rows, cols, { compact: true }));

  /* Why a source is held out, said once and specifically. Four different
     reasons look identical in a table until they are named. */
  if (held.length) {
    const why = (r) => {
      if (r.kind === 'component') return 'a line INSIDE a payout that is already counted — adding it would count the same money twice';
      if (r.kind === 'ledger') return 'money moving between the fleet and the platform, which is neither a fare nor a payout';
      if (r.kind === 'statement') return 'the operator’s own import, for months the APIs no longer serve';
      if (!knowsBasis) return 'Revenue by channel did not answer, so this page cannot say';
      const c = chosen.get(r.platform);
      if (c && c !== r.kind) {
        return `this channel’s headline uses its ${c === 'fare' ? 'fares' : 'payouts'} — a payout is `
          + 'what is left of those same fares after commission, so counting both counts them nearly twice';
      }
      /* Not the same as "we chose the other one": a channel whose basis is
         `none` has nothing the headline can stand on, and saying that is the
         difference between a rule and a failure. */
      const b = basisOf.get(r.platform);
      if (b === 'none') return 'no figure from this channel covers enough of the window for the headline to stand on it';
      if (b == null) return 'Revenue by channel reported nothing for this channel at all';
      return `the headline records this channel’s basis as “${esc(words(b))}”, which this call is not`;
    };
    const p2 = panel(`Held out of the headline — ${fmt(held.length)} of ${fmt(d.rows.length)}`,
      'Real money, deliberately not added. Each row says why.');
    root.append(p2.panel);
    p2.body.append(tableFrom(held.map((r) => ({ ...r, _why: why(r) })), [
      cols[0], cols[1],
      { label: 'Returned', key: 'amount', num: true, render: (r) => `AED ${fmt(r.amount)}` },
      { label: 'Why it is not in the headline', key: '_why',
        render: (r) => `<span class="wrap">${esc(r._why)}</span>` },
    ], { compact: true }));
  }

  /* The provider's own vocabulary. "AED 406,893 of Uber payout" is not an
     answer to what the fleet was paid FOR. */
  if (d.categories?.length) {
    const p3 = panel('What the money was called, in the provider’s own words',
      'The named lines inside the payouts and the ledger. These are a TREE in the provider’s own '
      + 'shape — your earnings contains fare, tip and the rest — so this says what the money was '
      + 'called and their sum is not a total of anything. Two of Uber’s APIs describe the same '
      + 'payout with different words, net fare and your earnings, and neither is renamed here.');
    root.append(p3.panel);
    p3.body.append(tableFrom(d.categories, [
      { label: 'Category', key: 'category', render: (r) => esc(words(r.category)) },
      { label: 'From', key: 'source',
        render: (r) => `${esc(words(r.source))}<span class="dim"> · ${esc(sourceLabel(r.platform))}</span>` },
      { label: 'Lines', key: 'rows_seen', num: true, render: (r) => fmt(r.rows_seen) },
      { label: 'Amount', key: 'amount', num: true, render: (r) => `AED ${fmt(r.amount)}` },
    ], { compact: true }));
  }

  root.append(note(d.note));
}
