/* ADVANCES, DEDUCTIONS AND WHAT COMES BACK — the register and the form.
   ─────────────────────────────────────────────────────────────────────────
   Everything a driver owes this company and everything that reduces it, in
   one place: the advance formats the operator named (cash, salary, charging),
   repayments against them, the deductions that behave the same way (Salik,
   fines, damage), and the two ways a balance ends without being paid — a
   refund and a write-off.

   ── THE EXPOSURE TILE IS THE POINT OF THE PAGE ───────────────────────────
   The operator keeps a driver's total within a percentage of what they
   generate — stored and effective-dated, not compiled in. The number that
   matters for a decision is the one AFTER the advance, not before it, and the
   form's dry run is what produces it: the server runs the real statements
   against the real constraints and rolls back, so the figure shown is what
   would be true, because it was true for the length of a transaction.

   ── AND THE ONES IT CANNOT MEASURE ARE LISTED FIRST ──────────────────────
   Measured on production 2026-09-21, driver_statement_day.unremitted is a
   daily figure and nothing records a remittance, so cash in hand cannot be
   derived. Until a deposit or an opening position exists for somebody, their
   cash is unknown — and the policy counts cash inside the 35%, so their
   exposure is refused rather than shown low. Those people are the first thing
   on this page, because a screen that quietly dropped them would look complete
   while the drivers most likely to be over the line were the ones missing. */
import { el, esc, panel, note, loading, tableFrom, entity,
  contract, glance, absenceBand, pageFoot } from './ui.js';
import { fmt, scatter } from './charts.js';
import { api, href } from './data.js';
import { ledgerBand, ceiling, ceilingWho, ceilingCol, ceilingRanked, firstReason,
  booksRecorded } from './ledger_ak.js';
import { entryForm } from './entry_form.js';
import { aed, loadPeople } from './deposit_core.js';

/* What this screen offers. `needs_proof: false` mirrors the registry
   (sql/schema_v78.sql) — proof is required where money or goods physically
   changed hands and not where the row records a decision or a period figure.
   The server refuses on its own copy of this; the flag here only decides
   whether the form ASKS. */
const TYPES = [
  { code: 'cash_advance', label: 'Cash advance',
    hint: 'Cash handed to the driver. Their obligation rises the day it is given.' },
  { code: 'salary_advance', label: 'Salary advance',
    hint: 'Against future pay, recovered by a deduction from a pay run this system records '
      + 'but does not run.' },
  { code: 'charging_advance', label: 'Charging advance',
    hint: 'Charging paid for on the driver’s behalf. Always a human entry — a charger meters a '
      + 'vehicle, and this building has no record of who was in one.' },
  { code: 'repayment', label: 'Repayment',
    hint: 'Money returned against an advance. Enter it as a positive amount; the system knows '
      + 'which way a repayment moves.' },
  { code: 'salik', label: 'Salik / tolls', needs_proof: false,
    hint: 'A period figure, entered as one line rather than per trip.' },
  { code: 'traffic_fine', label: 'Traffic fine',
    hint: 'Carries the same vehicle-to-person attribution problem as charging.' },
  { code: 'damage', label: 'Damage / excess' },
  { code: 'refund', label: 'Refund to driver',
    hint: 'The company returning money — an overcharge corrected, or a cost they bore that was '
      + 'ours.' },
  { code: 'writeoff', label: 'Write off', needs_proof: false,
    hint: 'A decision that a balance will not be recovered. No photograph exists of a decision, '
      + 'so none is asked for — and it is never summed with repayments, because one is money '
      + 'that came back and one is money that did not.' },
];

export async function renderAdvances(root) {
  root.innerHTML = '';
  /* Under the page contract (plan §4 #advances): 00 first; the owes table,
     the form and the register where they were; then the cash-against-
     generated scatter, the ranked ceiling and the † band. */
  const ak = contract();
  const AK = ak ? ledgerBand() : null;
  if (ak) { root.append(AK.band); loading(AK.tiles); }
  const head = panel('What each driver owes', null, 'advances');
  root.append(head.panel);
  loading(head.body);

  const formPanel = panel('Record an entry', null, 'advance-form');
  const listPanel = panel('The register', null, 'advance-register');
  root.append(formPanel.panel, listPanel.panel);
  const after = ak ? el('div') : null;
  if (ak) root.append(after);

  async function refresh() {
    /* THE OFFER AND THE FIGURES ARE DIFFERENT QUESTIONS — loadPeople() folds
       exposure onto a list that also holds the roster accounts nobody has
       recorded against yet. Reading exposure alone offered nobody on a fresh
       ledger, so no first advance could ever be entered. */
    const [ex, reg] = await Promise.all([
      loadPeople(),
      api('/api/ledger/entries').catch(() => null),
    ]);
    head.body.innerHTML = '';
    listPanel.body.innerHTML = '';

    if (!ex.ok) { head.body.append(note(esc(ex.error), 'bad')); return; }
    if (!ex.exposure_ok) head.body.append(note(esc(ex.exposure_absent_reason), 'warn'));

    const people = (ex.people || []).filter((p) => p.name);
    const pol = ex.policy;
    if (ak) advancesContract(AK, after, root, people, ex);
    head.body.append(el('p', 'cap', pol
      ? `The line is ${pol.pct}% of what a driver generates, in force since ${esc(pol.effective_from)}`
        + `${pol.set_by ? `, set by ${esc(pol.set_by)}` : ''}. Over it an override is needed and `
        + 'nothing is blocked — the approval step arrives with user accounts.'
      : esc(ex.policy_absent_reason || 'No policy threshold is stored.')));

    /* The unmeasurable, first and by name. */
    /* TWO POPULATIONS, AND THEY MUST NOT BE ONE COUNT.
       ───────────────────────────────────────────────────────────────────
       Since the form began offering the platform roster as well as the
       people this ledger holds, "N of M have no exposure figure" would fold
       together two entirely different facts: somebody on the ledger whose
       cash position has never been stated — a gap worth closing, and the
       whole reason this warning exists — and somebody who has simply never
       been recorded against, for whom the absence is not a gap at all.

       Reported separately, each with its own reason. A single number over
       both would read as "most of the fleet is unmeasurable" on a ledger
       that is merely new, and that is a false alarm rather than a true
       absence. */
    const onLedger = people.filter((p) => p.on_the_ledger !== false);
    const blind = onLedger.filter((p) => p.exposure_pct == null);
    if (blind.length) {
      head.body.append(note(`${blind.length} of ${onLedger.length} people have no exposure `
        + 'figure at all, and they are listed below with the reason. Most often it is that no '
        + 'cash position has been stated for them — the policy counts cash the driver holds '
        + 'inside the line, so a figure without it would understate exposure, which is the '
        + 'direction that gets somebody lent more than they should be.', 'warn'));
    }
    const fresh = people.length - onLedger.length;
    if (fresh) {
      head.body.append(note(`${fresh} more are on a platform roster with nothing ever recorded `
        + 'against them. They are offered in the form above — an entry creates their record — '
        + 'and they carry no balance of any kind rather than a balance of zero, so they are '
        + 'not counted in the figures on this page.', 'ok'));
    }
    const over = onLedger.filter((p) => p.over_policy);
    if (over.length) {
      head.body.append(note(`${over.length} over the line.`, 'warn'));
    }

    /* The TABLE is the ledger's population. Somebody with no record has no row
       to show — every cell would be a dash, and a page of dashes is how a
       reader stops reading dashes. They are offered in the form, which is
       where they are needed. */
    head.body.append(tableFrom(onLedger.slice().sort((a, b) => {
      /* Unmeasurable first, then the highest exposure. A dash sorted to the
         bottom is a dash nobody reads. */
      if ((a.exposure_pct == null) !== (b.exposure_pct == null)) return a.exposure_pct == null ? -1 : 1;
      return (b.exposure_pct ?? 0) - (a.exposure_pct ?? 0);
    }), [
      { label: 'Driver', key: 'name',
        /* entity(), not a bare name: test/interlinking.test.mjs is the standing
           check that a column naming a thing can OPEN it — "a cell that prints
           a name and links nowhere is a dead end, and every dead end silently
           turns an investigation into a search". A person with no account
           degrades to plain text rather than to a broken link. */
        render: (p) => entity('driver', p.ext_id, p.name) },
      { label: 'Advances', key: 'advance', num: true,
        render: (p) => esc(aed(p.owes?.advance) || '—') },
      { label: 'Deductions', key: 'deduction', num: true,
        render: (p) => esc(aed(p.owes?.deduction) || '—') },
      { label: 'Cash held', key: 'cash', num: true,
        render: (p) => (p.owes?.cash != null ? esc(aed(p.owes.cash))
          : `<span class="dash" title="${esc(p.owes?.cash_absent_reason || '')}">—</span>`) },
      /* Beside Cash held under the contract: what cash fares put in the
         driver's hand — a ceiling on what Cash held could be, never it. */
      ...(ak ? [ceilingCol()] : []),
      { label: 'Generated', key: 'earned', num: true,
        render: (p) => (p.earned != null ? esc(aed(p.earned))
          : `<span class="dash" title="${esc(p.earned_absent_reason || '')}">—</span>`) },
      { label: 'Exposure', key: 'exposure_pct', num: true,
        render: (p) => (p.exposure_pct == null
          ? `<span class="dash" title="${esc(p.exposure_absent_reason || '')}">—</span>`
          : `<b class="${p.over_policy ? 'bad' : ''}">${p.exposure_pct}%</b>`) },
    ], { cards: true, cardLead: 'name' }));

    /* The form, once — rebuilding it on every refresh would throw away a
       half-typed entry the moment a save elsewhere completed. */
    if (!formPanel.body.querySelector('.depform')) {
      entryForm(formPanel.body, { types: TYPES, people, onSaved: refresh });
    }

    if (!reg || !reg.entries) {
      listPanel.body.append(note('The register could not be read.', 'bad'));
      return;
    }
    if (reg.listed_why) listPanel.body.append(note(reg.listed_why));
    if (!reg.entries.length) {
      listPanel.body.append(note('Nothing has been recorded yet.'));
      return;
    }
    listPanel.body.append(tableFrom(reg.entries, [
      { label: 'Day', key: 'effective_on', render: (e) => esc(e.effective_on) },
      { label: 'Driver', key: 'person_name',
        render: (e) => entity('driver', e.ext_id, e.person_name) },
      { label: 'What', key: 'label',
        render: (e) => esc(e.label || e.type_code)
          + (e.entry_source === 'verification'
            ? ' <span class="pill warn" title="written to prove the feature works — excluded '
              + 'from every total by construction">verification</span>' : '') },
      { label: 'Amount', key: 'amount', num: true, render: (e) => esc(aed(e.amount)) },
      { label: 'Proof', key: 'receipt',
        render: (e) => (e.receipt.held
          ? `<a href="/api/ledger/receipt/${esc(e.receipt.sha256)}" target="_blank" rel="noopener">photo</a>`
          : `<span class="dash" title="${esc(e.receipt.absent_reason)}">—</span>`) },
      { label: 'By', key: 'entered_by', render: (e) => esc(e.entered_by) },
      { label: 'Note', key: 'note', render: (e) => esc(e.note) },
    ], { cards: true, cardLead: 'person_name' }));
  }

  await refresh();
}

/* ── #advances under the page contract ─────────────────────────────────────
   00: cash fares put in drivers' hands, the hero — a CEILING, not a balance,
   with who carries it, over how many fares, between which dates, and the
   largest single driver · recorded on the advance book · exposure
   measurable · the lending line (or none stored, and where it is set) ·
   generated. After the register: cash taken against generated, one dot per
   person (those with only one of the two are counted, not drawn); the
   ceiling ranked. † what each driver owes, cash in hand as a balance,
   exposure, the line itself — the route's reasons.
   This page reads exposure_pct and never computes one; nothing here divides
   by what a driver generated (test/ledger_ui.test.mjs).
   NOT ADOPTED: "the eighteen books" bars (no GET serves the ledger-type
   registry); a policy line on the scatter (a client-side ratio, and none may
   be drawn where none is stored); the ceiling across all 347 as bars (the top
   thirty as bars, the drivers with none as one outlined count). */
function advancesContract(AK, after, root, people, ex) {
  const n = people.length;
  const c = ceiling(people);
  const books = people.filter((p) => p.owes && ((+p.owes.advance_rows || 0) > 0
    || (p.owes.advance_rows == null && p.owes.advance != null))).length;
  const measurable = people.filter((p) => p.exposure_pct != null).length;
  const gen = people.filter((p) => p.earned != null && +p.earned > 0);
  const pol = ex.policy;
  glance(AK.tiles, [
    c.n ? { label: 'Cash fares put in drivers’ hands', value: aed(c.sum), hero: true,
      sub: `a ceiling, not a balance · ${ceilingWho(c)} · ${fmt(c.trips)} cash fares, ${c.from} → ${c.to}`
        + ` · the largest single driver ${aed(c.top.owes.cash_taken)}` }
      : { label: 'Cash fares put in drivers’ hands', hero: true,
        na: c.measured ? 'no cash-marked trip is on record for anyone here' : 'the exposure read did not answer, so no cash fare is measured' },
    { label: 'Recorded on the advance book', value: `${fmt(books)} of ${fmt(n)}`,
      sub: books ? 'with at least one advance row' : 'nobody has an advance row — a balance nobody wrote down, not nought' },
    { label: 'Exposure measurable', value: `${fmt(measurable)} of ${fmt(n)}`,
      sub: 'judged per person by the route, never as a fleet ratio' },
    pol ? { label: 'The lending line', value: `${pol.pct}%`, to: href('policy'),
      sub: `of what a driver generates, in force since ${pol.effective_from}` }
      : { label: 'The lending line', na: 'none stored — it is set on The lending line', to: href('policy') },
    gen.length ? { label: 'Generated', value: aed(gen.reduce((a, p) => a + (+p.earned || 0), 0)),
      sub: `by ${fmt(gen.length)} of ${fmt(n)}` }
      : { label: 'Generated', na: firstReason(people, (p) => p.earned_absent_reason) || 'no driver here has a generated figure' },
  ]);

  after.innerHTML = '';
  const g = el('div', 'grid g2'); after.append(g);
  const sc = panel('Cash taken against what each driver generated', 'One dot per person with both. No lending line is drawn: exposure is judged per person on the server.', 'advances-scatter');
  const rk = panel('Who has taken the most cash in fares', 'The ceiling, ranked — the thirty largest, and the drivers with none as one count.', 'advances-ceiling');
  g.append(sc.panel, rk.panel);
  const both = people.filter((p) => p.owes?.cash_taken != null && p.earned != null);
  const cashOnly = people.filter((p) => p.owes?.cash_taken != null && p.earned == null).length;
  if (!both.length) sc.body.append(note('Nobody here has both a cash fare on record and a generated figure.'));
  else {
    scatter(sc.body, both.map((p) => ({ name: p.name, ext: p.ext_id, gen: +p.earned, cash: +p.owes.cash_taken })),
      { x: 'gen', y: 'cash', label: 'name', xLabel: 'generated (AED)', yLabel: 'cash fares taken (AED)',
        xFmt: (v) => fmt(v), yFmt: (v) => fmt(v),
        onClick: (d) => { if (d.ext) location.hash = href('driver', d.ext); } });
  }
  sc.body.append(el('p', 'cap', esc(`${fmt(both.length)} of ${fmt(n)} people have both.`
    + (cashOnly ? ` ${fmt(cashOnly)} with cash fares and no generated figure are not drawn — a dot needs both, and theirs is missing, not nought.` : ''))));
  ceilingRanked(rk.body, people, { top: 30 });

  const known = people.filter((p) => p.owes?.cash != null).length;
  const absHost = el('div'); after.append(absHost);
  absenceBand(absHost, [
    { label: 'What each driver owes', fig: people.filter(booksRecorded).length ? `${fmt(people.filter(booksRecorded).length)} of ${fmt(n)} recorded` : null,
      none: 'Nothing recorded',
      why: firstReason(people, (p) => p.owes?.books_absent_reason) || 'Every driver here has an advance or deduction row.' },
    { label: 'Cash in hand, as a balance', fig: known ? `${fmt(known)} of ${fmt(n)} known` : null, none: 'Unknown',
      why: firstReason(people, (p) => p.owes?.cash_absent_reason) || 'Every driver here has an opening cash position stated.' },
    { label: 'Exposure', hl: true, fig: `${fmt(n - measurable)} of ${fmt(n)} not measurable`,
      why: firstReason(people, (p) => p.exposure_absent_reason) || 'Every driver here has an exposure figure.' },
    { label: 'The line itself', fig: pol ? `${pol.pct}%` : null, none: 'Never set',
      why: pol ? `In force since ${pol.effective_from}${pol.set_by ? `, set by ${pol.set_by}` : ''}.`
        : (ex.policy_absent_reason || 'No threshold has been stored.') },
  ]);
  pageFoot({ colophon: ['The whole record', `${fmt(n)} people`, c.n ? `${aed(c.sum)} in cash fares — a ceiling` : null] }, root);
}
