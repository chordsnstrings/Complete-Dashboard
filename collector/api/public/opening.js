/* THE OPENING CASH POSITION — the one figure this ledger cannot derive.
   ─────────────────────────────────────────────────────────────────────────
   The operator: "we will ask the accountant team to update each driver's cash
   position as of the date that they will input. The new ones will take into
   account since that day."

   Everything else on these screens is an event somebody records as it happens.
   This is a STATEMENT about a moment already past, and it is the term that
   makes the other two mean anything: without a starting balance there is
   nothing for collections to accumulate onto, so until a driver has one their
   cash reads as unknown and their exposure is refused rather than shown low.

   ── WHY IT CANNOT BE DERIVED, MEASURED RATHER THAN ASSUMED ───────────────
   driver_statement_day.unremitted is the obvious source and is not a balance:
   on production 2026-09-21 the sum of every daily figure is AED 1,935,693
   against AED 6,243 for the latest-per-person, 146 of 217 people carry a
   latest of exactly zero, and nothing in this database records a remittance,
   so it cannot be accumulated. It also cannot be joined to a person for most
   of its value — it is keyed on a NAME, and only 236 of 405 people on it carry
   an id at all, AED 315,771 of AED 1,935,693, 16.3%.

   So a human counts it and says so. This screen is where they say it.

   ── A DATE PER PERSON, DEFAULTED, NOT ASSUMED ───────────────────────────
   The accounts team almost certainly counts on one day, so there is one date
   at the top. But the operator said "as of the date that they will input", and
   a driver counted on Tuesday when the rest were counted on Monday is an
   ordinary thing — so each row carries its own date, pre-filled from the top
   and editable. Getting that wrong by a day silently moves which trips count
   as collected since. */
import { el, esc, panel, note, loading, tableFrom, entity } from './ui.js';
import { api } from './data.js';
import { submitEntry, SUPERVISORS, aed, parseAmount, pooled, loadPeople,
  personRef } from './deposit_core.js';
import { dubaiDay } from './tz.js';

let SUP = null;

export async function renderOpening(root) {
  root.innerHTML = '';
  const head = panel('State a starting balance', 'What each driver was holding on the day it '
    + 'was counted. Everything after that date is counted from here — so this is the figure '
    + 'that turns an exposure from “not measurable” into a number.', 'opening');
  const gridPanel = panel('Every driver', null, 'opening-grid');
  root.append(head.panel, gridPanel.panel);
  loading(gridPanel.body);

  /* THE ROSTER, not the people who already have a ledger row. This screen's
     whole job is to state the FIRST figure for somebody, so reading a list of
     people who already have entries would offer precisely the drivers who
     least need it — and on a fresh ledger, nobody at all. */
  const d = await loadPeople();
  if (!d.ok) {
    gridPanel.body.innerHTML = '';
    gridPanel.body.append(note(esc(d.error), 'bad'));
    return;
  }
  const people = (d.people || []).filter((p) => p.name);
  if (!d.exposure_ok) head.body.append(note(esc(d.exposure_absent_reason), 'warn'));

  const bar = el('div', 'depform');
  const dW = el('div', 'depfield');
  dW.append(el('label', 'deplabel', 'Counted on'));
  const when = el('input', 'depinput');
  when.type = 'date'; when.value = dubaiDay();
  dW.append(when, el('div', 'depnote', 'Pre-fills every row. A driver counted on a different '
    + 'day can be given their own date in the row — the date decides which trips count as '
    + 'collected since, so a day out is a real difference.'));
  const wW = el('div', 'depfield');
  wW.append(el('label', 'deplabel', 'Recorded by'));
  const who = el('div', 'depchips');
  SUPERVISORS.forEach((s) => {
    const b = el('button', `depchip${SUP === s ? ' on' : ''}`, esc(s[0].toUpperCase() + s.slice(1)));
    b.type = 'button';
    b.onclick = () => { SUP = s; [...who.children].forEach((c) => c.classList.toggle('on', c === b)); };
    who.append(b);
  });
  wW.append(who);
  bar.append(dW, wW);
  head.body.append(bar);

  const verdict = el('div', 'depverdict');
  const actions = el('div', 'depactions');
  const checkBtn = el('button', 'btn', 'Check them');
  const saveBtn = el('button', 'btn primary', 'State these balances');
  checkBtn.type = 'button'; saveBtn.type = 'button'; saveBtn.disabled = true;
  actions.append(checkBtn, saveBtn);
  head.body.append(verdict, actions);

  const amounts = new Map(); const dates = new Map();

  function draw() {
    gridPanel.body.innerHTML = '';
    const stated = people.filter((p) => p.owes?.cash_basis?.opening_on);
    gridPanel.body.append(note(stated.length
      ? `${stated.length} of ${people.length} already have a starting balance. Stating a second `
        + 'one replaces which date the count runs from — it does not add to the first.'
      : `Nobody has one yet, so every exposure on this fleet reads as not measurable. That is `
        + 'the honest answer and not a useful one.', stated.length ? 'ok' : 'warn'));

    amounts.clear(); dates.clear();
    gridPanel.body.append(tableFrom(people, [
      { label: 'Driver', key: 'name', render: (p) => entity('driver', p.ext_id, p.name) },
      { label: 'Stated', key: 'stated',
        render: (p) => (p.owes?.cash_basis?.opening_on
          ? `${esc(aed(p.owes.cash_basis.opening))} <span class="dim">on `
            + `${esc(p.owes.cash_basis.opening_on)}</span>`
          : '<span class="dash" title="no starting balance has been stated, so this driver’s '
            + 'cash is unknown and their exposure is refused rather than shown low">—</span>') },
      /* KEYED ON THE ROW, NOT ON person_id. Half this list is roster accounts
         nobody has recorded against yet, and their person_id is null by
         design — so data-person="null" would collide every one of them onto a
         single cell and post the last typed figure against whichever of them
         the lookup happened to find. The index is unique by construction. */
      { label: 'Counted now', key: 'amt', num: true,
        render: (p) => `<input class="depinput opencell" inputmode="decimal" `
          + `data-row="${people.indexOf(p)}" placeholder="0.00">` },
      { label: 'On', key: 'on',
        render: (p) => `<input class="depinput opendate" type="date" `
          + `data-row="${people.indexOf(p)}">` },
    ], { cards: true, cardLead: 'name' }));

    gridPanel.body.querySelectorAll('.opencell').forEach((i) => {
      amounts.set(Number(i.dataset.row), i);
      i.oninput = () => { verdict.innerHTML = ''; saveBtn.disabled = true; };
    });
    gridPanel.body.querySelectorAll('.opendate').forEach((i) => {
      i.value = when.value;
      dates.set(Number(i.dataset.row), i);
    });
  }

  when.onchange = () => {
    /* Only the rows nobody has touched. Overwriting a date somebody typed
       because the header changed is how a considered exception is lost. */
    dates.forEach((i) => { if (!i.dataset.touched) i.value = when.value; });
  };

  const filled = () => [...amounts.entries()]
    .map(([row, i]) => ({ row, p: people[row], v: parseAmount(i.value), raw: i.value.trim(),
      on: dates.get(row)?.value }))
    .filter((r) => r.raw && r.p);

  /* A minted person by id, a roster account by account — personRef decides,
     and the server resolves the second inside the same transaction as the
     entry. Stating an opening balance is very often the FIRST thing recorded
     against somebody, which is exactly when person_id is null. */
  const entryFor = (r) => ({
    ...personRef(r.p), person_name: r.p.name,
    type_code: 'cash_opening', amount: r.v, settles_via: 'none',
    effective_on: r.on, entered_by: SUP,
    note: `counted on ${r.on}, stated by the accounts team`,
  });

  async function run(commit) {
    verdict.innerHTML = '';
    const rows = filled();
    if (!SUP) { verdict.append(note('Say who is recording this.', 'warn')); return; }
    if (!rows.length) { verdict.append(note('No balances have been entered.', 'warn')); return; }
    const bad = rows.filter((r) => r.v == null || !r.on);
    if (bad.length) {
      verdict.append(note(`${bad.length} row${bad.length === 1 ? '' : 's'} need an amount and a `
        + 'date this form can read.', 'bad'));
      return;
    }
    loading(verdict);
    const out = await pooled(rows, (r) => submitEntry(entryFor(r), { commit }));
    verdict.innerHTML = '';
    const refused = out.map((o, k) => (o.error ? { r: rows[k], why: o.error } : null)).filter(Boolean);
    const total = rows.reduce((a, r) => a + r.v, 0);
    if (commit) {
      verdict.append(note(`${rows.length - refused.length} starting balances stated, `
        + `${aed(total)} in total.`, refused.length ? 'warn' : 'ok'));
    } else {
      verdict.append(el('div', 'depsentence',
        `${esc(String(rows.length - refused.length))} of ${esc(String(rows.length))} balances `
        + `would be stated, ${esc(aed(total))} in total. Nothing has been written — each of `
        + 'those ran against the real constraints inside a transaction that was rolled back.'));
      saveBtn.disabled = refused.length === rows.length;
    }
    refused.forEach((x) => verdict.append(note(`${x.r.p.name}: ${x.why}`, 'bad')));
    if (commit) { await renderOpening(root); }
  }

  checkBtn.onclick = () => run(false);
  saveBtn.onclick = () => { saveBtn.disabled = true; run(true); };
  draw();
  gridPanel.body.addEventListener('input', (e) => {
    if (e.target.classList.contains('opendate')) e.target.dataset.touched = '1';
  });
}
