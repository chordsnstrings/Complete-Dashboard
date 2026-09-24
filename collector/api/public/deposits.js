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
import { el, esc, panel, note, loading, tableFrom, entity,
  contract, glance, absenceBand, pageFoot } from './ui.js';
import { fmt, areaChart } from './charts.js';
import { api } from './data.js';
import { ledgerBand, ceiling, ceilingWho, ceilingCol, lastCashCol, ceilingRanked, monthBars, amountBands,
  firstReason, booksRecorded } from './ledger_ak.js';
import { entryForm } from './entry_form.js';
import { aed, loadPeople } from './deposit_core.js';

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
  /* Under the page contract (plan §4 #deposits): 00 first, then the form
     exactly as it is, the twenty largest ceilings, the table (its default
     order and card mode kept, now sortable), the distributions and the †
     band. One extra GET: the handovers on record. */
  const ak = contract();
  const AK = ak ? ledgerBand() : null;
  const top = ak ? panel('Who is carrying the most', 'The cash-fare ceiling — every cash fare on record in a driver’s hand, '
    + 'never a balance. The twenty largest; the drivers with none as one count.', 'deposit-top') : null;
  const after = ak ? el('div') : null;
  const handP = ak ? api('/api/ledger/entries?type_code=cash_deposit').catch(() => null) : null;
  if (ak) { root.append(AK.band, head.panel, top.panel, listPanel.panel, after); loading(AK.tiles); }
  else root.append(head.panel, listPanel.panel);
  loading(listPanel.body);

  async function refresh() {
    /* THE OFFER AND THE FIGURES ARE DIFFERENT QUESTIONS. This read used to be
       /api/ledger/exposure alone, which lists people who already have a
       ledger row — and on a ledger nobody has written to that is nobody, so
       the form offered no one and no first entry could ever be made. See
       loadPeople() in ./deposit_core.js. */
    const d = await loadPeople();
    listPanel.body.innerHTML = '';
    if (!d.ok) { listPanel.body.append(note(esc(d.error), 'bad')); return; }
    const people = (d.people || []).filter((p) => p.name);
    if (ak) depositsContract(AK, top, after, root, people, d, await handP);

    if (!head.body.querySelector('.depform')) {
      entryForm(head.body, { types: TYPES, people, settlesVia: 'cash', onSaved: refresh });
    }

    if (!people.length) {
      listPanel.body.append(note('There is nobody to record against — neither this ledger nor '
        + 'the platform rosters hold a driver. Nothing is wrong with this screen; there is no '
        + 'one to show.', 'warn'));
      return;
    }
    if (!d.exposure_ok) listPanel.body.append(note(esc(d.exposure_absent_reason), 'warn'));
    /* EVERYONE, not only the people whose cash is known. The first version
       filtered to `owes.cash != null` and so hid exactly the people this screen
       exists for: somebody with no stated position is who finance needs to
       find, and dropping them would have made the page look complete while the
       drivers most needing a deposit were the ones missing from it. */
    const fresh = people.filter((p) => !p.on_the_ledger).length;
    if (fresh) {
      listPanel.body.append(note(`${fresh} of ${people.length} are on a platform roster but have `
        + 'never been recorded against here. They are offered anyway — the first entry made '
        + 'against one creates their record, and until then they have no balance of any kind '
        + 'rather than a balance of zero.', 'warn'));
    }
    const unknown = people.filter((p) => p.on_the_ledger && p.owes?.cash == null).length;
    if (unknown) {
      listPanel.body.append(note(`${unknown} of the people already on this ledger have no `
        + 'stated cash '
        + 'position. Their cash reads as unknown rather than zero, and their exposure is '
        + 'refused rather than shown low — recording a deposit, or an opening position, is '
        + 'what turns it into a number.', 'warn'));
    }
    listPanel.body.append(tableFrom(people.slice()
      .sort((a, b) => (b.owes?.cash ?? -1) - (a.owes?.cash ?? -1)), [
      { label: 'Driver', key: 'name',
        /* Openable — see the same column on #advances and
           test/interlinking.test.mjs for why. */
        render: (p) => entity('driver', p.ext_id, p.name) },
      { label: 'Cash position', key: 'cash', num: true,
        render: (p) => (p.owes?.cash != null ? esc(aed(p.owes.cash))
          : `<span class="dash" title="${esc(p.owes?.cash_absent_reason
            || p.exposure_absent_reason || '')}">—</span>`) },
      { label: 'Advances', key: 'advance', num: true,
        render: (p) => esc(aed(p.owes?.advance) || '—') },
      /* Under the contract: what cash fares put in the driver's hand, and
         when the last one did — the ceiling beside the position, never it. */
      ...(ak ? [ceilingCol(), lastCashCol()] : []),
      { label: 'Exposure', key: 'exposure_pct', num: true,
        render: (p) => (p.exposure_pct == null
          ? `<span class="dash" title="${esc(p.exposure_absent_reason || '')}">—</span>`
          : `${p.exposure_pct}%`) },
    ], { cards: true, cardLead: 'name', ...(ak ? { sortable: true, sortId: 'deposits' } : {}) }));
  }

  await refresh();
}

/* ── #deposits under the page contract ─────────────────────────────────────
   00: the ceiling on cash outstanding, the hero (who carries it, over how
   many cash trips, between which dates) · cash actually in hand — unknown,
   with the route's reason, for everyone with no stated position · drivers
   carrying a ceiling · the cash trips behind it and their mean · handovers
   recorded. Who is carrying the most: the twenty largest. After the table:
   the ceilings in round bands, the month each driver's last cash fare was
   taken (is cash still coming in), and how concentrated the ceiling is.
   † what each driver holds, what each owes, the line, the window.
   NOT ADOPTED: the mockup's absence of the form and the table; a sparkline
   on "drivers carrying a ceiling" (the payload holds no series for it). */
function depositsContract(AK, top, after, root, people, d, hand) {
  const n = people.length;
  const c = ceiling(people);
  const known = people.filter((p) => p.owes?.cash != null).length;
  const handed = hand?.totals ? hand.totals.rows : null;
  glance(AK.tiles, [
    c.n ? { label: 'Ceiling on cash outstanding', value: aed(c.sum), hero: true,
      sub: `every cash fare on record, not a balance · ${ceilingWho(c)} · ${fmt(c.trips)} cash trips, ${c.from} to ${c.to}` }
      : { label: 'Ceiling on cash outstanding', hero: true, na: 'no cash-marked trip is on record for anyone here' },
    known ? { label: 'Cash actually in hand', value: `${fmt(known)} of ${fmt(n)} known`,
      sub: 'from a stated position plus what came in since' }
      : { label: 'Cash actually in hand', na: `unknown for all ${fmt(n)} — no opening cash position has been stated, and it is not derivable` },
    { label: 'Drivers carrying a ceiling', value: fmt(c.n), sub: [c.none ? `${fmt(c.none)} no cash fare` : null,
      c.unmeasured ? `${fmt(c.unmeasured)} not on the exposure read` : null].filter(Boolean).join(' · ') || `of ${fmt(n)}` },
    c.trips ? { label: 'Cash trips behind it', value: fmt(c.trips), sub: `a mean of ${aed(c.sum / c.trips)} a trip — derived` }
      : { label: 'Cash trips behind it', na: 'no cash-marked trip is on record' },
    handed != null ? { label: 'Handovers recorded', value: fmt(handed), sub: handed ? 'cash handed in, on the ledger' : 'none yet — the form below records the first' }
      : { label: 'Handovers recorded', na: 'the register did not answer, so the count is not known here' },
  ]);
  top.body.innerHTML = '';
  ceilingRanked(top.body, people, { top: 20 });

  after.innerHTML = '';
  const g = el('div', 'grid g3'); after.append(g);
  const bands = panel('The ceilings, in bands', null, 'deposit-bands');
  const last = panel('The month each driver’s last cash fare was taken', 'Is cash still coming in.', 'deposit-last');
  const conc = panel('How concentrated the ceiling is', null, 'deposit-conc');
  g.append(bands.panel, last.panel, conc.panel);
  const sp = amountBands(bands.body, c.carriers.map((p) => p.owes.cash_taken), { noun: 'drivers', aria: 'Drivers by cash-fare ceiling' });
  if (sp) bands.body.append(el('p', 'cap', esc(`${fmt(sp.n)} drivers, in ${aed(sp.step)} bands named by their lower edge.`)));
  monthBars(last.body, people, 'cash_taken_to', { aria: 'Drivers by the month of their last cash fare' });
  if (c.n) {
    const sorted = c.carriers.map((p) => +p.owes.cash_taken).sort((a, b) => b - a);
    let run = 0;
    const curve = sorted.map((v, i) => { run += v; return { rank: i + 1, share: Math.round((run / c.sum) * 1000) / 10 }; });
    const half = curve.findIndex((x) => x.share >= 50) + 1;
    areaChart(conc.body, curve, { x: 'rank', y: 'share', color: '--ink', valueFmt: (v) => `${v}%`, aria: 'Share of the ceiling by the drivers carrying most' });
    conc.body.append(el('p', 'cap', esc(`${fmt(half)} of ${fmt(c.n)} drivers carry half the ceiling. The x axis is rank, not a name.`)));
  } else conc.body.append(note('No driver has a cash fare on record.'));

  const books = people.filter(booksRecorded).length;
  const pol = d.policy;
  const absHost = el('div'); after.append(absHost);
  absenceBand(absHost, [
    { label: 'What each driver holds, unknown', hl: true, fig: `${fmt(n - known)} of ${fmt(n)}`,
      why: firstReason(people, (p) => p.owes?.cash_absent_reason) || 'Everyone here has a stated cash position.' },
    { label: 'What each driver owes', fig: books ? `${fmt(books)} of ${fmt(n)} recorded` : null, none: 'Nothing recorded',
      why: firstReason(people, (p) => p.owes?.books_absent_reason) || 'Everyone here has an advance or deduction row.' },
    { label: 'The line', fig: pol ? `${pol.pct}%` : null, none: 'Never stored',
      why: pol ? `In force since ${pol.effective_from}.` : (d.policy_absent_reason || 'No threshold has been stored.') },
    { label: 'The window', fig: 'The whole record',
      why: 'This page reads every cash fare and every handover ever recorded; the date range in the control bar does not apply to it.' },
  ]);
  pageFoot({ colophon: ['The whole record', `${fmt(n)} people`, c.n ? `${aed(c.sum)} ceiling` : null] }, root);
}
