/* CASH HANDED IN — the desktop half.
   ─────────────────────────────────────────────────────────────────────────
   A deposit is the one entry in this ledger with two genuinely different
   users, and the operator asked for both: a supervisor taking notes from a
   driver at the car, and finance working through a bundle of receipts at a
   desk. So there are two screens and one set of rules — everything either of
   them decides lives in ./deposit_core.js, because a validation copied into
   two bundles is how the phone comes to refuse what the desktop accepts, and
   the person standing next to the car is the one who finds out.

   ── WHY A DEPOSIT AND NOT JUST "CASH" ────────────────────────────────────
   Measured on production 2026-09-21: driver_statement_day.unremitted is a
   DAILY figure and nothing in this database records a remittance, so cash in
   hand cannot be derived — the sum overstates by every dirham ever handed
   back and the latest figure is one day's leftovers. This form is the missing
   leg. Until it has been used, api/ledger_routes.js reports every driver's
   cash term as unknown rather than zero, and their exposure as unmeasured
   rather than understated.

   ── THE DESKTOP SHAPE IS NOT THE PHONE SHAPE ─────────────────────────────
   The phone is one handover at a time, thumb-first, camera in the flow. This
   is a worklist: who is carrying the most, what has already been recorded
   today, and a form that stays open so the next receipt in the pile does not
   cost a page load. Same core, different question. */
import { el, esc, panel, note, loading, tableFrom } from './ui.js';
import { api } from './data.js';
import { entryForm } from './entry_form.js';
import { aed } from './deposit_core.js';

/* One type, and it needs a photograph: money physically changed hands. The
   form itself is ./entry_form.js, shared with #advances and the driver tab —
   the first version of this file had it written out inline, and the advances
   page was about to copy it, at which point a rule tightened on one screen
   would have been loose on the other. */
const TYPES = [{ code: 'cash_deposit', label: 'Cash handed in' }];

export async function renderDeposits(root) {
  root.innerHTML = '';
  /* NOT "Cash handed in" — that is the rail's label for this view and the
     shell already prints it above. test/nav_sections.test.mjs exists because a
     page that repeats its own name spends the one line a reader gives it
     saying nothing they did not already know. */
  const head = panel('Record a handover', 'A deposit is what turns cash in hand from a guess '
    + 'into a balance — nothing in this database records a driver handing money back, so until '
    + 'one is entered every cash figure reads as unknown rather than zero.', 'deposits');
  const listPanel = panel('Who is carrying cash', null, 'deposit-list');
  root.append(head.panel, listPanel.panel);
  loading(listPanel.body);

  async function refresh() {
    const d = await api('/api/ledger/exposure').catch(() => null);
    listPanel.body.innerHTML = '';
    if (!d) { listPanel.body.append(note('The ledger could not be read.', 'bad')); return; }
    const people = (d.people || []).filter((p) => p.name);

    if (!head.body.querySelector('.depform')) {
      entryForm(head.body, { types: TYPES, people, settlesVia: 'cash', onSaved: refresh });
    }

    if (!people.length) {
      listPanel.body.append(note('Nobody is on the ledger yet.', 'warn'));
      return;
    }
    /* EVERYONE, not only the people whose cash is known. The first version
       filtered to `owes.cash != null` and so hid exactly the people this screen
       exists for: somebody with no stated position is who finance needs to
       find, and dropping them would have made the page look complete while the
       drivers most needing a deposit were the ones missing from it. */
    const unknown = people.filter((p) => p.owes?.cash == null).length;
    if (unknown) {
      listPanel.body.append(note(`${unknown} of ${people.length} people have no stated cash `
        + 'position. Their cash reads as unknown rather than zero, and their exposure is '
        + 'refused rather than shown low — recording a deposit, or an opening position, is '
        + 'what turns it into a number.', 'warn'));
    }
    listPanel.body.append(tableFrom(people.slice()
      .sort((a, b) => (b.owes?.cash ?? -1) - (a.owes?.cash ?? -1)), [
      { label: 'Driver', key: 'name', render: (p) => `<b>${esc(p.name)}</b>` },
      { label: 'Cash position', key: 'cash', num: true,
        render: (p) => (p.owes?.cash != null ? esc(aed(p.owes.cash))
          : `<span class="dash" title="${esc(p.owes?.cash_absent_reason
            || p.exposure_absent_reason || '')}">—</span>`) },
      { label: 'Advances', key: 'advance', num: true,
        render: (p) => esc(aed(p.owes?.advance) || '—') },
      { label: 'Exposure', key: 'exposure_pct', num: true,
        render: (p) => (p.exposure_pct == null
          ? `<span class="dash" title="${esc(p.exposure_absent_reason || '')}">—</span>`
          : `${p.exposure_pct}%`) },
    ], { cards: true, cardLead: 'name' }));
  }

  await refresh();
}
