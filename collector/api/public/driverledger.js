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

/* The three proof states, in one cell, said in words on hover rather than
   encoded in a colour. */
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
  const regPanel = panel(`Entries in ${windowLabel()}, most recent first`, null,
    'driver-money-register');
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
  const [ex, reg] = await Promise.all([
    api(`/api/ledger/exposure?${qs}`).catch(() => null),
    qAll('/api/ledger/entries', Object.fromEntries(new URLSearchParams(qs))).catch(() => null),
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

  const t = reg.totals;
  regPanel.body.append(el('p', 'cap', ['advance', 'cash', 'deduction', 'pay']
    .filter((b) => t[b] != null)
    .map((b) => `${BOOK_LABEL[b]} ${aed(t[b])}`).join(' · ')
    + `. ${t.rows} ${t.rows === 1 ? 'entry' : 'entries'}`
    + (t.verification_rows
      ? `, of which ${t.verification_rows} ${t.verification_rows === 1 ? 'is' : 'are'} a `
        + 'verification row — listed and flagged below, and in none of these totals.'
      : '.')));
  if (reg.listed_why) regPanel.body.append(note(reg.listed_why, 'warn'));

  regPanel.body.append(tableFrom(reg.entries, [
    { label: 'When', key: 'effective_on', render: (e) => esc(e.effective_on) },
    { label: 'What', key: 'label',
      render: (e) => esc(e.label || e.type_code)
        + (e.entry_source === 'verification'
          ? ' <span class="pill warn">verification</span>' : '')
        + (e.entry_source === 'import' ? ' <span class="dim">imported</span>' : '') },
    { label: 'Amount', key: 'amount', num: true,
      /* SIGNED, and the sign is the server's. A repayment and an advance move
         a balance in opposite directions and a column of magnitudes would make
         the two indistinguishable at a glance — which is the one thing a
         reader of this table is doing. */
      render: (e) => `<b class="${e.amount < 0 ? 'good' : ''}">${esc(aed(e.amount))}</b>` },
    { label: 'Proof', key: 'proof', render: proofCell },
    { label: 'Recorded by', key: 'entered_by',
      render: (e) => `${esc(e.entered_by)} <span class="dim">`
        + `${esc(String(e.entered_at || '').slice(0, 10))}</span>` },
    { label: 'Note', key: 'note', render: (e) => esc(e.note || '—') },
  ], { cards: true, cardLead: 'label' }));

  regPanel.body.append(el('p', 'cap', 'Entries are permanent and are never edited — a correction '
    + 'is a reversing entry, which is why a mistake stays visible above the thing that fixed it. '
    + 'Photographs are held for twelve months; an entry whose proof has passed that says so '
    + 'rather than reading as one nobody ever documented.'));
}
