/* ONE DRIVER'S MONEY — what they owe, what they hold, and every entry that
   made it so.
   ─────────────────────────────────────────────────────────────────────────
   The operator's sixth requirement, in their words: "All advance repayment
   will be logged into the system in the drivers page preferrably in a new tab
   within the driver profile page - for repayment amount or any disbursement
   they HAVE to upload an image."

   So this is that tab. Everything else in the money section answers about the
   fleet and lets you filter to a person; this answers about the person and
   never about anybody else. That is a different page, not a filtered view of
   the same one: a supervisor opens it holding one question — can this driver
   take another advance, and what have they already had.

   ── ADDRESSED BY AN ACCOUNT, KEYED ON A PERSON ───────────────────────────
   Every driver page in this product is reached by a PROVIDER account id,
   because that is what a link from a trip, a payout or the roster carries.
   This ledger keys on a person. api/ledger_routes.js resolves the one to the
   other READ-ONLY — opening somebody's page must never create their ledger
   record, or a fleet browsed end to end would mint four hundred people who
   have never had a dirham recorded against them, and every figure on every
   money page would then be counted over a population that looking created.

   ── THE ABSENCE HERE IS A REAL ANSWER ────────────────────────────────────
   Most drivers have no ledger record at all, and will until somebody records
   something. That renders as a sentence saying so — not as an empty table,
   which reads as a failure, and not as AED 0.00, which is a claim. The house
   rule this dashboard exists to uphold, on the page where it is easiest to
   break: a balance of zero and no record are different facts and a driver can
   be refused an advance over the difference.

   ── AND THE PROOF COLUMN HAS THREE STATES ────────────────────────────────
   A receipt still held, one held until a date and since removed, and a type
   that never has one because it records a decision or a period figure.
   Retention is twelve months and the entry is permanent, so collapsing those
   makes an expired photograph read as an entry nobody ever documented. */
import { el, esc, panel, note, loading, tableFrom, kpiRow, empty } from './ui.js';
import { api, qAll, windowLabel } from './data.js';
import { aed } from './deposit_core.js';

const BOOK_LABEL = { advance: 'Advances', cash: 'Cash', deduction: 'Deductions', pay: 'Pay' };

/* FOUR proof states, in one cell, said in words on hover rather than encoded
   in a colour — and the cell links only where the product will actually serve
   the file.
   ─────────────────────────────────────────────────────────────────────────
   `held` used to mean "a receipt row exists", which is true of one PAST ITS
   RETENTION, so this cell rendered a live "photograph" link that
   GET /api/ledger/receipt/:sha answers 410 (api/ledger_routes.js:1037). It now
   means "the photograph is there AND this system will serve it", so the four
   states fall out of it: served, held-until-a-date-and-now-refused, recorded
   by digest but never stored, and never attached at all. Each carries its own
   sentence from the route; this cell invents none of them. */
function proofCell(e) {
  if (e.receipt?.held) {
    return `<a class="lnk" href="/api/ledger/receipt/${esc(e.receipt.sha256)}" target="_blank" `
      + `rel="noopener">photograph</a>`;
  }
  return `<span class="dash" title="${esc(e.receipt?.absent_reason
    || 'no photograph is attached to this entry')}">—</span>`;
}

export async function renderDriverLedger(root, id, prof) {
  root.innerHTML = '';
  const head = panel('Where they stand', null, 'driver-money');
  /* The heading says the window, because this list is the one thing on the tab
     the toolbar governs and the tiles above it are not. A reader who cannot
     tell which half moved when they changed the window has two figures that
     appear to contradict each other. */
  const regPanel = panel(`Statement for ${windowLabel()}`, null, 'driver-money-register');
  root.append(head.panel, regPanel.panel);
  loading(head.body);
  loading(regPanel.body);

  /* The account this page is addressed by, and the platform if the profile
     names one — sent together so an id that two providers both use resolves to
     the right one rather than to whichever row sorted first. */
  const platform = (prof?.accounts || []).find((a) => a.driver_ext_id === id)?.platform
    || (prof?.accounts || [])[0]?.platform || '';
  const qs = `ext_id=${encodeURIComponent(id)}${platform ? `&platform=${encodeURIComponent(platform)}` : ''}`;

  /* TWO READS, AND THE WINDOW APPLIES TO EXACTLY ONE OF THEM.
     ───────────────────────────────────────────────────────────────────────
     A BALANCE IS A POSITION. What this driver owes today is what they owe
     today, whether or not they drove in the window on the toolbar — so the
     exposure read is deliberately UNWINDOWED, through a bare api() rather than
     qAll(), and the tiles say as of when they are true.

     A REGISTER IS A LIST, and "what was advanced to this driver in September"
     is a real question the toolbar is the right control for. So the entries
     read goes through qAll(), which carries the window the rest of the product
     is using.

     The alternative considered and rejected: ignoring the window on both, so
     the selector above this tab would be a control that changes nothing — the
     defect api/public/data.js spends four paragraphs on NO_RANGE avoiding, and
     which also rides that dead parameter into every link leaving the page. */
  /* THREE READS NOW. The statement is the third, and it is the one the
     operator asked for: "everything that a person earns and spends in a ledger
     that looks similar to a bank statement which has specific transaction
     history". It is windowed like the entries read, because "what moved in
     September" is exactly the question the toolbar above asks. */
  const [ex, reg, st] = await Promise.all([
    api(`/api/ledger/exposure?${qs}`).catch(() => null),
    qAll('/api/ledger/entries', Object.fromEntries(new URLSearchParams(qs))).catch(() => null),
    qAll('/api/driver/register', Object.fromEntries(new URLSearchParams(qs))).catch(() => null),
  ]);

  head.body.innerHTML = '';
  regPanel.body.innerHTML = '';

  if (!ex || !reg) {
    head.body.append(note('The money ledger could not be read just now. This says nothing '
      + 'about what this driver owes — the request for it failed.', 'bad'));
    return;
  }

  /* NOTHING RECORDED IS NOT A BALANCE OF ZERO. */
  if (ex.absent_reason || reg.absent_reason) {
    head.body.append(note(ex.absent_reason || reg.absent_reason, 'warn'));
    head.body.append(el('p', 'cap', 'That is not a balance of zero, and the difference matters: '
      + 'a driver with nothing recorded has had no advance this system knows of, which is not '
      + 'the same as one whose advances have all been repaid. Recording anything against them '
      + '— on Advances, Cash handed in, Salary or Starting balances — opens their record.'));
    regPanel.body.append(empty(el('div'), 'No entry has ever been made against this driver.'));
    return;
  }

  const p = (ex.people || [])[0];
  if (!p) {
    head.body.append(note('This driver resolves to a person on the money ledger, but no figures '
      + 'came back for them. That is a fault in this page rather than an answer about them.', 'bad'));
    return;
  }

  /* ── where they stand ─────────────────────────────────────────────────── */
  head.body.append(kpiRow([
    { label: 'Owed in total', value: aed(p.owes?.total) || '—',
      sub: p.owes?.total == null ? (p.owes?.total_absent_reason || 'not measurable')
        : 'advances and deductions, plus the cash they are holding — as it stands now, '
          + 'not over the window' },
    { label: 'Advances outstanding', value: aed(p.owes?.advance) || '—',
      sub: 'what has been advanced, less what has come back' },
    { label: 'Cash in hand', value: p.owes?.cash == null ? '—' : aed(p.owes.cash),
      sub: p.owes?.cash == null ? p.owes?.cash_absent_reason
        : (p.owes?.cash_basis?.is_a_floor ? 'at least this — see below' : 'counted from a stated '
          + 'opening position') },
    { label: 'Deductions', value: aed(p.owes?.deduction) || '—',
      sub: 'tolls, fines, damage' },
    { label: 'Against the line', value: p.exposure_pct == null ? '—' : `${p.exposure_pct}%`,
      sub: p.exposure_pct == null ? (p.exposure_absent_reason || 'not measurable')
        : (p.verdict || '') },
  ]));

  /* THE CASH TERM, SHOWN AS ITS PARTS. It is the one figure on this page that
     is derived rather than recorded, and the derivation is where it can be
     wrong — so a reader gets the terms rather than being asked to trust the
     total. */
  const cb = p.owes?.cash_basis;
  if (cb) {
    head.body.append(el('p', 'cap', `Cash in hand is ${esc(aed(cb.opening))} counted on `
      + `${esc(cb.opening_on)}, plus ${esc(aed(cb.collected_since))} of fares on `
      + `${esc(String(cb.collected_trips))} cash-marked trips since, less `
      + `${esc(aed(cb.handed_in_since))} handed in over ${esc(String(cb.handed_in_entries))} `
      + 'deposits.'));
    if (cb.is_a_floor) head.body.append(note(cb.floor_reason, 'warn'));
  } else if (p.owes?.cash_absent_reason) {
    head.body.append(note(p.owes.cash_absent_reason, 'warn'));
  }

  if (ex.policy) {
    head.body.append(el('p', 'cap', `The line is ${esc(String(ex.policy.pct))}% of what a driver `
      + `generates, in force since ${esc(ex.policy.effective_from)}. Over it an override is `
      + 'needed and nothing is blocked — the approval step arrives with user management.'));
  } else if (ex.policy_absent_reason) {
    head.body.append(note(ex.policy_absent_reason, 'warn'));
  }

  /* ── the register ─────────────────────────────────────────────────────── */
  if (!reg.entries.length) {
    /* AND THIS IS WHY THE HALVES MUST BE DISTINGUISHABLE. A driver with a real
       outstanding balance and no entry in the chosen window lands here, and an
       empty list under a tile reading AED 3,500 is a contradiction unless the
       page says which of the two the window moved. */
    regPanel.body.append(note(`Nothing was recorded against this driver in ${windowLabel()}. `
      + 'The figures above are unaffected — they are a position as it stands now, not a total '
      + 'over these dates, so a balance with no movement in this window is a balance that did '
      + 'not move, not one that is not there.', 'warn'));
    return;
  }

  /* THE STATEMENT, and the two things about it that are not a table.
     ─────────────────────────────────────────────────────────────────────
     TWO RUNNING BALANCES, NOT ONE. A bank statement has a single balance
     because a bank account is a single relationship. This one is two: what
     the driver is HOLDING (cash fares up, hand-ins down — the operator's rule
     of 2026-09-22, "cash trips are cash to the driver unless they give it to
     the company") and what they OWE (advances and deductions up, repayments
     down). Netting them would read an honest driver carrying AED 400 of fares
     as someone in debt for it, and the four books exist precisely so that
     cannot happen.

     AND A COLUMN THAT IS NOT A BALANCE AT ALL. The fare is what the RIDER was
     charged. It is shown because it happened, never summed into either
     balance, and the caption says so — three different figures on this product
     answer to the word "earned" and none of them is a column of fares. */
  const t = reg.totals;
  if (!st || st.absent_reason) {
    regPanel.body.append(note(st?.absent_reason
      || 'the statement could not be read for this driver.', 'warn'));
  } else {
    const o = st.opening || {};
    /* THE OPENING IS WHAT MAKES A BALANCE A BALANCE, and it is stated before
       the lines rather than discovered at the bottom of them. Without one the
       running column is a running CHANGE wearing a balance's name, so it is
       rendered absent with the reason rather than started from an assumed
       nought. */
    const openBits = [];
    if (o.cash != null) openBits.push(`Cash in hand ${aed(o.cash)} as of ${esc(o.cash_on)}`);
    else openBits.push('Cash in hand — not counted');
    if (o.owed != null) openBits.push(`Owed ${aed(o.owed)} as of ${esc(o.owed_on)}`);
    else openBits.push('Owed — nothing carried in');
    regPanel.body.append(el('p', 'cap', `Opening: ${openBits.join(' · ')}.`));
    if (o.cash_absent_reason) regPanel.body.append(note(o.cash_absent_reason));
    if (o.owed_absent_reason) regPanel.body.append(note(o.owed_absent_reason));

    if (st.truncated) {
      regPanel.body.append(note(`Showing ${st.shown} of ${st.of} lines. The totals below are `
        + 'over all of them, not over this page.', 'warn'));
    }

    regPanel.body.append(tableFrom(st.lines, [
      { label: 'When', key: 'on', render: (l) => esc(String(l.on || '').slice(0, 10)) },
      { label: 'What', key: 'detail',
        render: (l) => (l.kind === 'trip'
          ? `<span class="pill plat">${esc(l.platform || '')}</span> ${esc(l.plate || '')}`
            + ` <span class="dim">${esc(l.detail || '')}</span>`
          : esc(l.detail || ''))
          + (l.verification ? ' <span class="pill warn">verification</span>' : '') },
      { label: 'Fare', key: 'fare', num: true,
        render: (l) => (l.fare == null ? '<span class="dim">—</span>' : esc(aed(l.fare))) },
      { label: 'Cash in', key: 'cash_in', num: true,
        render: (l) => (l.cash_in != null
          ? `<b>${esc(aed(l.cash_in))}</b>`
          : `<span class="dash" title="${esc(l.no_movement_reason || '')}">—</span>`) },
      { label: 'Entry', key: 'amount', num: true,
        render: (l) => (l.amount == null ? '<span class="dim">—</span>'
          : `<b class="${l.amount < 0 ? 'good' : ''}">${esc(aed(l.amount))}</b>`) },
      { label: 'Cash in hand', key: 'running_cash', num: true,
        render: (l) => (l.running_cash == null
          ? `<span class="dash" title="${esc(o.cash_absent_reason || '')}">—</span>`
          : esc(aed(l.running_cash))) },
      { label: 'Owed', key: 'running_owed', num: true,
        render: (l) => (l.running_owed == null
          ? `<span class="dash" title="${esc(o.owed_absent_reason || '')}">—</span>`
          : esc(aed(l.running_owed))) },
      { label: 'Proof', key: 'proof',
        render: (l) => (l.ledger ? proofCell(l) : '<span class="dim"></span>') },
    ], { cards: true, cardLead: 'detail' }));

    regPanel.body.append(el('p', 'cap',
      `Over ${windowLabel()}: fares ${aed(st.totals.fares)} · cash taken `
      + `${aed(st.totals.cash_in)} · commission ${aed(st.totals.fees)} · advances `
      + `${aed(st.totals.ledger_advance)} · deductions ${aed(st.totals.ledger_deduction)} · `
      + `cash handed in ${aed(st.totals.ledger_cash)}. ${st.totals.fares_are_not_earnings}`));
  }

  /* The hand-recorded half, kept as a caption rather than a second table: the
     lines are already in the statement above, and two tables of the same money
     on one tab is how a reader ends up with two figures that appear to
     contradict each other. */
  regPanel.body.append(el('p', 'cap', ['advance', 'cash', 'deduction', 'pay']
    .filter((b) => t[b] != null)
    .map((b) => `${BOOK_LABEL[b]} ${aed(t[b])}`).join(' · ')
    + `. ${t.rows} recorded ${t.rows === 1 ? 'entry' : 'entries'}`
    + (t.verification_rows
      ? `, of which ${t.verification_rows} ${t.verification_rows === 1 ? 'is' : 'are'} a `
        + 'verification row — listed and flagged, and in none of these totals.'
      : '.')
    + ' Entries are permanent and are never edited — a correction is a reversing entry, which '
    + 'is why a mistake stays visible above the thing that fixed it. Photographs are held for '
    + 'twelve months; one past that says it was held until a date rather than reading as an '
    + 'entry nobody documented.'));
}
