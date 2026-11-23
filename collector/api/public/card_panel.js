/* CARD-MACHINE PAYMENTS — Network International (FIX-STATUS CARD-1).
   ─────────────────────────────────────────────────────────────────────────
   Two drawings of api/card_routes.js:

     cardMachineDriver  the driver money tab: every card payment on record
                        for this person, each with its terminal (the
                        operator: "in driver's history, the terminal ID should
                        be there so that we can trace back"), and each terminal
                        they used with its first and last day;
     cardMachineFleet   the Deposits page: the fleet by month, the payments
                        with no driver named (by terminal), and the Emirates
                        IDs not placed on anybody yet, with a link for a person
                        who decides same-person pairs.

   Both say, every time, that these payments are NOT yet taken off the cash a
   driver holds: that is phase 3 (FIX-STATUS CARD-3), after the operator has
   seen a before-and-after per driver. A negative amount is a chargeback and
   is labelled as one; the operator: the fare "usually comes back". */
import { el, esc, note, tableFrom, kpiRow, dtStr, fmt, entity } from './ui.js';
import { api } from './data.js';
import { aed } from './deposit_core.js';
import { post } from './access.js';

/* Why a payment has no driver, in words that are true: the sheet's own words
   quoted where it wrote some ("Not Found", "N/A"), and ours where it wrote a
   number this reader could not read (the review of 2026-11-23: the column
   said "the sheet says" over a label the sheet never wrote). */
const WHY_LABEL = { 'unreadable Emirates ID': 'an Emirates ID too short or long to read', 'no driver named': 'left blank' };
const whyNoDriver = (labels) => (labels || []).map((l) => WHY_LABEL[l] || `the sheet says \u201c${l}\u201d`).join('; ') || '—';
const span = (a, b) => (a && b && a !== b ? `${a} – ${b}` : (a || b || '—'));
const money = (v) => (v == null ? '<span class="ent-off" title="Not shown to your role">—</span>' : esc(aed(v)));
const amountCell = (r) => (r.amount == null ? money(null)
  : r.amount < 0 ? `${esc(aed(r.amount))} <span class="dim">· chargeback</span>` : esc(aed(r.amount)));

function readNotes(host, c) {
  if (c.failed) {
    host.append(note(`The last read of the card-payments sheet, at ${dtStr(c.failed.at)} Dubai, was ${c.failed.status === 'held' ? 'held back' : 'refused'}: `
      + `${c.failed.why || c.failed.status}. ${c.read_at ? `What is shown is from the last good read, ${dtStr(c.read_at)}.` : ''}`, 'warn'));
  }
}
/* CARD-2: a day against that day's cash trips, in words. */
const STATUS = {
  covered: () => 'covered by the fares collected',
  covered_with_day_before: () => 'covered with the day before (a fare before midnight, paid after)',
  over: (r) => `over the fares collected by ${aed(r.over_by)}`,
  no_cash_trips: () => 'no cash or card-machine fare that day or the day before',
};
const statusCell = (r) => {
  const t = (STATUS[r.status] || (() => '—'))(r);
  return r.status === 'over' || r.status === 'no_cash_trips' ? `<strong>${esc(t)}</strong>` : `<span class="dim">${esc(t)}</span>`;
};
/* Cash trips, and the hotel's pos-driver fares (paid on the driver's own
   card machine) where there are any. */
const cashCell = (r) => (r.cash == null ? money(null)
  : `${esc(aed(r.cash))} <span class="dim">· ${fmt(r.cash_trips)} cash</span>`
    + (r.pos_trips ? `<br>${esc(aed(r.pos))} <span class="dim">· ${fmt(r.pos_trips)} on the card machine (hotel)</span>` : ''));
/* Driver cells go through entity() inline (test/interlinking.test.mjs rule 3):
   a driver with no id degrades to plain text, never to a broken link; a
   person opens at p<id>. */

const sourceLine = (c) => `From the Network International card-payments sheet, last read ${c.read_at ? dtStr(c.read_at) : '—'}`
  + `${c.covers_to ? `; it runs to ${c.covers_to}` : ''}. Not yet taken off the cash this driver holds — that change waits for review.`;

export async function cardMachineDriver(host, prof) {
  host.innerHTML = '';
  if (prof?.person_id == null) {
    host.append(note('No card payments can be shown: this account has not been placed on a person, and a card payment is '
      + 'placed on a person by their Emirates ID.', 'warn'));
    return;
  }
  let c;
  try { c = await api(`/api/card/driver?person=${encodeURIComponent(prof.person_id)}`); }
  catch (e) { host.append(note(`The card payments could not be read: ${e.message}`, 'bad')); return; }
  readNotes(host, c);
  if (c?.why) { host.append(note(c.why, 'warn')); return; }
  const t = c.totals || {};
  host.append(kpiRow([
    { label: 'Card payments', value: t.net == null ? '—' : aed(t.net), sub: `${fmt(t.payments)} payments, ${span(t.first_day, t.last_day)}` },
    { label: 'Chargebacks', value: t.chargebacks == null ? '—' : aed(t.chargebacks),
      sub: t.chargeback_n ? `${fmt(t.chargeback_n)} taken back; the fare usually comes back` : 'none on record' },
    { label: 'Terminals used', value: fmt((c.terminals || []).length), sub: (c.terminals || []).slice(0, 3).map((x) => x.terminal_id).join(', ') || '—' },
  ]));
  if ((c.terminals || []).length) {
    host.append(el('h4', 'subhead', 'Terminals — when each was in this driver’s hands'));
    host.append(tableFrom(c.terminals, [
      { label: 'Terminal', key: 'terminal_id' },
      { label: 'Payments', key: 'payments', num: true },
      { label: 'Amount', key: 'net', num: true, render: (r) => money(r.net) },
      { label: 'First day', key: 'first_day' },
      { label: 'Last day', key: 'last_day' },
    ], { cards: true, cardLead: 'terminal_id' }));
  }
  if ((c.payments || []).length) {
    /* CARD-2: each day against the cash trips — a card payment settles a cash
       trip, so a day's card total should not run past them. */
    if ((c.days || []).some((d) => d.status)) {
      host.append(el('h4', 'subhead', 'By day — against the fares collected'));
      host.append(tableFrom(c.days, [
        { label: 'Day', key: 'day' },
        { label: 'Card', key: 'net', num: true, render: (r) => money(r.net) },
        { label: 'Fares collected', key: 'cash', num: true, render: cashCell },
        { label: 'Check', key: 'status', render: statusCell },
      ], { cards: true, cardLead: 'day' }));
    }
    host.append(el('h4', 'subhead', 'Payments'));
    host.append(tableFrom(c.payments, [
      { label: 'Day', key: 'day' },
      { label: 'Terminal', key: 'terminal_id' },
      { label: 'Amount', key: 'amount', num: true, render: amountCell },
    ], { cards: true, cardLead: 'day' }));
  }
  host.append(el('p', 'cap', esc(`${sourceLine(c)} `
    + `${(c.payments || []).length < (t.payments || 0) ? `The ${fmt(c.payments.length)} most recent of ${fmt(t.payments)} payments. ` : ''}`
    + `Placed on this driver by ${c.placed_by?.linked ? 'a person’s link of their Emirates ID' : 'the Emirates ID on the HR export'}.`)));
}

export async function cardMachineFleet(host) {
  host.innerHTML = '';
  let s;
  try { s = await api('/api/card/summary'); }
  catch (e) { host.append(note(`The card payments could not be read: ${e.message}`, 'bad')); return; }
  readNotes(host, s);
  if (s.why) { host.append(note(s.why, 'warn')); return; }
  const t = s.totals || {};
  host.append(kpiRow([
    { label: 'Card payments on record', value: t.net == null ? '—' : aed(t.net), sub: `${fmt(t.payments)} payments, ${span(s.covers_from, s.covers_to)}` },
    { label: 'Placed on a driver', value: t.placed == null ? '—' : aed(t.placed), sub: `${fmt(t.people)} drivers, by Emirates ID` },
    { label: 'No driver named', value: t.no_driver == null ? '—' : aed(t.no_driver),
      sub: `${fmt(t.no_driver_payments)} payments with no readable driver, on ${fmt(s.no_driver_terminals_total)} terminals` },
    { label: 'Emirates ID not placed', value: t.unplaced == null ? '—' : aed(t.unplaced), sub: `${fmt(t.unplaced_ids)} IDs, ${fmt(t.unplaced_payments)} payments` },
  ]));
  if ((s.months || []).length) {
    host.append(el('h4', 'subhead', 'By month'));
    host.append(tableFrom(s.months, [
      { label: 'Month', key: 'month' },
      { label: 'Fleet', key: 'fleet_id' },
      { label: 'Payments', key: 'payments', num: true },
      { label: 'Amount', key: 'net', num: true, render: (r) => money(r.net) },
      { label: 'Chargebacks', key: 'chargebacks', num: true, render: (r) => money(r.chargebacks) },
      { label: 'Terminals', key: 'terminals', num: true },
    ], { cards: true, cardLead: 'month' }));
  }
  if ((s.no_driver_terminals || []).length) {
    host.append(el('h4', 'subhead', 'Payments with no driver named, by terminal'));
    host.append(tableFrom(s.no_driver_terminals, [
      { label: 'Terminal', key: 'terminal_id' },
      { label: 'Payments', key: 'payments', num: true },
      { label: 'Amount', key: 'net', num: true, render: (r) => money(r.net) },
      { label: 'Why no driver', key: 'labels', render: (r) => esc(whyNoDriver(r.labels)) },
      { label: 'Days', key: 'first_day', render: (r) => esc(span(r.first_day, r.last_day)) },
      { label: 'Ever mapped', key: 'ever_mapped', render: (r) => esc(r.ever_mapped ? 'yes, on other days' : 'never') },
    ], { cards: true, cardLead: 'terminal_id' }));
    if (s.no_driver_terminals_total > s.no_driver_terminals.length) {
      host.append(el('p', 'cap', esc(`The ${fmt(s.no_driver_terminals.length)} terminals carrying the most, of ${fmt(s.no_driver_terminals_total)}.`)));
    }
  }
  const cx = el('div'); host.append(cx);
  await crossCheck(cx, s.covers_to);
  const rev = el('div'); host.append(rev);
  await reviewList(rev);
  host.append(el('p', 'cap', esc(`From the Network International card-payments sheet, last read ${s.read_at ? dtStr(s.read_at) : '—'}. `
    + 'A negative amount is a chargeback. These payments are not yet taken off the cash any driver holds — that change waits for review.')));
}

/* THE REVIEW: IDs not placed, and a link for whoever decides same-person
   pairs. A driver is PICKED from the ledger's list, never typed — the same
   rule the entry form keeps (./entry_form.js): a name cannot settle who
   somebody is, and two people sharing one are told apart by their account. */
async function reviewList(host) {
  host.innerHTML = '';
  let r;
  try { r = await api('/api/card/review'); }
  catch (e) {
    host.append(note(e.status === 403 ? 'The Emirates IDs not yet placed are listed for the people who decide same-person pairs.'
      : `The Emirates IDs not yet placed could not be read: ${e.message}`, e.status === 403 ? 'info' : 'bad'));
    return;
  }
  if (!(r.rows || []).length) { host.append(note('Every Emirates ID on the card payments is placed on a driver.', 'ok')); return; }
  host.append(el('h4', 'subhead', `Emirates IDs not placed on a driver (${fmt(r.rows.length)})`));
  let people = null;
  const loadPeople = async () => {
    if (people) return people;
    const d = await api('/api/ledger/people');
    const list = (Array.isArray(d) ? d : d.people || d.rows || []).filter((p) => p.name && p.person_id != null);
    const seen = new Map(); list.forEach((p) => seen.set(p.name, (seen.get(p.name) || 0) + 1));
    people = new Map(list.map((p) => [seen.get(p.name) > 1 ? `${p.name} (${p.ext_id ? `${p.platform || 'account'} ${p.ext_id}` : `person ${p.person_id}`})` : p.name, p]));
    return people;
  };
  const table = tableFrom(r.rows, [
    { label: 'Emirates ID', key: 'emirates_id', render: (x) => (x.emirates_id ? esc(x.emirates_id) : '<span class="dim">on the HR export</span>') },
    { label: 'Payments', key: 'payments', num: true },
    { label: 'Amount', key: 'net', num: true, render: (x) => money(x.net) },
    { label: 'Days', key: 'last_day', render: (x) => esc(span(x.first_day, x.last_day)) },
    { label: 'Terminals', key: 'terminals', render: (x) => esc((x.terminals || []).join(', ')) },
    { label: 'Why', key: 'why', render: (x) => esc(x.why) },
    { label: '', key: 'ref', render: (x) => `<button class="btn btn-sm" data-card-ref="${esc(x.ref)}">Link to a driver</button>` },
  ], { cards: true, cardLead: 'emirates_id' });
  host.append(table);
  host.querySelectorAll('button[data-card-ref]').forEach((b) => b.addEventListener('click', async () => {
    const cell = b.parentElement;
    cell.innerHTML = '';
    const pick = el('input', 'depinput'); pick.type = 'search'; pick.placeholder = 'Type a driver’s name…';
    const dl = el('datalist'); dl.id = `card-people-${b.dataset.cardRef}`; pick.setAttribute('list', dl.id);
    const go = el('button', 'btn btn-sm', 'Link');
    const msg = el('span', 'dim');
    cell.append(pick, dl, go, msg);
    try { const ps = await loadPeople(); dl.innerHTML = [...ps.keys()].map((k) => `<option value="${esc(k)}"></option>`).join(''); }
    catch (e) { msg.textContent = ` The driver list could not be read: ${e.message}`; return; }
    go.addEventListener('click', async () => {
      const p = people.get(pick.value);
      if (!p) { msg.textContent = ' Pick a driver from the list.'; return; }
      go.disabled = true;
      try { await post('/api/card/link', { ref: b.dataset.cardRef, decision: 'link', person_id: Number(p.person_id) }); await reviewList(host); }
      catch (e) { go.disabled = false; msg.textContent = ` ${e.message}`; }
    });
  }));
}

/* THE FLEET'S CROSS-CHECK (CARD-2): every placed driver-day with card
   payments against that driver's cash trips, and the drivers with the most
   card money the cash trips do not explain. */
/* The last 90 days of card data by default: the whole year is a 4–7 s read
   (measured on production, 2026-11-23), 90 days about 1.6 s. */
async function crossCheck(host, coversTo) {
  host.innerHTML = '';
  const from = coversTo ? new Date(Date.parse(`${coversTo}T00:00:00Z`) - 89 * 864e5).toISOString().slice(0, 10) : null;
  let x;
  try { x = await api(`/api/card/crosscheck${from ? `?from=${from}` : ''}`); }
  catch (e) { host.append(note(`The cross-check with cash trips could not be read: ${e.message}`, 'bad')); return; }
  host.append(el('h4', 'subhead', `Against the fares collected${from ? ` — the last 90 days (from ${from})` : ''}`));
  if (x.why) { host.append(note(x.why, 'warn')); return; }
  const t = x.totals || {};
  host.append(kpiRow([
    { label: 'Driver-days checked', value: fmt(t.driver_days), sub: `${aed(t.card)} on card` },
    { label: 'Covered by the fares', value: fmt((t.covered || 0) + (t.covered_with_day_before || 0)),
      sub: `${fmt(t.covered_with_day_before)} only with the day before (after midnight)` },
    { label: 'Over the fares', value: t.over_aed == null ? '—' : aed(t.over_aed), sub: `${fmt(t.over)} driver-days` },
    { label: 'No fare collected at all', value: t.no_cash_aed == null ? '—' : aed(t.no_cash_aed), sub: `${fmt(t.no_cash_trips)} driver-days` },
  ]));
  if ((x.drivers || []).length) {
    host.append(tableFrom(x.drivers, [
      { label: 'Driver', key: 'name', render: (r) => entity('driver', r.person_id != null ? `p${r.person_id}` : null, r.name || `person ${r.person_id}`) },
      { label: 'Card days', key: 'card_days', num: true },
      { label: 'Days over', key: 'over_days', num: true },
      { label: 'Over by', key: 'over_aed', num: true, render: (r) => money(r.over_aed) },
      { label: 'Days with no fare', key: 'no_cash_days', num: true },
      { label: 'Card on those days', key: 'no_cash_aed', num: true, render: (r) => money(r.no_cash_aed) },
      { label: 'Not explained', key: 'unexplained_aed', num: true, render: (r) => money(r.unexplained_aed) },
    ], { cards: true, cardLead: 'name' }));
    if (x.drivers_flagged > x.drivers.length) host.append(el('p', 'cap', esc(`The ${fmt(x.drivers.length)} with the most, of ${fmt(x.drivers_flagged)} drivers flagged.`)));
  }
  host.append(el('p', 'cap', esc(`A card payment settles a fare the driver collects — a cash trip, or a hotel fare filed "pos-driver" (paid on the driver's own card machine) — `
    + `so a driver's card total for a day should not run past those fares (allowing AED ${x.allowance_aed} a day for tips and rounding, `
    + 'and the day before\'s leftover for a fare taken before midnight). Over, or no such fare at all, means the sheet put the payment on '
    + 'the wrong driver, or a ride on no platform was paid by card.')));
}

