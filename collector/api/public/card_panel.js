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
import { el, esc, note, tableFrom, kpiRow, dtStr, fmt } from './ui.js';
import { api } from './data.js';
import { aed } from './deposit_core.js';
import { post } from './access.js';

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
      sub: `${fmt(t.no_driver_payments)} payments on ${fmt(s.no_driver_terminals_total)} terminals the sheet maps to nobody` },
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
      { label: 'The sheet says', key: 'labels', render: (r) => esc((r.labels || []).join(', ') || '—') },
      { label: 'Days', key: 'first_day', render: (r) => esc(span(r.first_day, r.last_day)) },
      { label: 'Ever mapped', key: 'ever_mapped', render: (r) => esc(r.ever_mapped ? 'yes, on other days' : 'never') },
    ], { cards: true, cardLead: 'terminal_id' }));
    if (s.no_driver_terminals_total > s.no_driver_terminals.length) {
      host.append(el('p', 'cap', esc(`The ${fmt(s.no_driver_terminals.length)} terminals carrying the most, of ${fmt(s.no_driver_terminals_total)}.`)));
    }
  }
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
