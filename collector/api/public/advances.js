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
import { el, esc, panel, note, loading, tableFrom } from './ui.js';
import { api } from './data.js';
import { entryForm } from './entry_form.js';
import { aed } from './deposit_core.js';

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
  const head = panel('What each driver owes', null, 'advances');
  root.append(head.panel);
  loading(head.body);

  const formPanel = panel('Record an entry', null, 'advance-form');
  const listPanel = panel('The register', null, 'advance-register');
  root.append(formPanel.panel, listPanel.panel);

  async function refresh() {
    const [ex, reg] = await Promise.all([
      api('/api/ledger/exposure').catch(() => null),
      api('/api/ledger/entries').catch(() => null),
    ]);
    head.body.innerHTML = '';
    listPanel.body.innerHTML = '';

    if (!ex) { head.body.append(note('The ledger could not be read.', 'bad')); return; }

    const people = (ex.people || []).filter((p) => p.name);
    const pol = ex.policy;
    head.body.append(el('p', 'cap', pol
      ? `The line is ${pol.pct}% of what a driver generates, in force since ${esc(pol.effective_from)}`
        + `${pol.set_by ? `, set by ${esc(pol.set_by)}` : ''}. Over it an override is needed and `
        + 'nothing is blocked — the approval step arrives with user accounts.'
      : esc(ex.policy_absent_reason || 'No policy threshold is stored.')));

    /* The unmeasurable, first and by name. */
    const blind = people.filter((p) => p.exposure_pct == null);
    if (blind.length) {
      head.body.append(note(`${blind.length} of ${people.length} people have no exposure figure `
        + 'at all, and they are listed below with the reason. Most often it is that no cash '
        + 'position has been stated for them — the policy counts cash the driver holds inside '
        + 'the line, so a figure without it would understate exposure, which is the direction '
        + 'that gets somebody lent more than they should be.', 'warn'));
    }
    const over = people.filter((p) => p.over_policy);
    if (over.length) {
      head.body.append(note(`${over.length} over the line.`, 'warn'));
    }

    head.body.append(tableFrom(people.slice().sort((a, b) => {
      /* Unmeasurable first, then the highest exposure. A dash sorted to the
         bottom is a dash nobody reads. */
      if ((a.exposure_pct == null) !== (b.exposure_pct == null)) return a.exposure_pct == null ? -1 : 1;
      return (b.exposure_pct ?? 0) - (a.exposure_pct ?? 0);
    }), [
      { label: 'Driver', key: 'name', render: (p) => `<b>${esc(p.name)}</b>` },
      { label: 'Advances', key: 'advance', num: true,
        render: (p) => esc(aed(p.owes?.advance) || '—') },
      { label: 'Deductions', key: 'deduction', num: true,
        render: (p) => esc(aed(p.owes?.deduction) || '—') },
      { label: 'Cash held', key: 'cash', num: true,
        render: (p) => (p.owes?.cash != null ? esc(aed(p.owes.cash))
          : `<span class="dash" title="${esc(p.owes?.cash_absent_reason || '')}">—</span>`) },
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
      { label: 'Driver', key: 'person_name', render: (e) => esc(e.person_name) },
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
