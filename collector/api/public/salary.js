/* SALARY — a month, a column, and one save.
   ─────────────────────────────────────────────────────────────────────────
   The operator: "salary is all-in, one entry per driver monthly — except cash
   advance given." So this is not the advance form with a different type on it.
   One entry per driver per month across a hundred and twenty people is a
   hundred and twenty forms, and nobody does that twice: it is a GRID. Last
   month's figure sits greyed beside each input, because the fastest way to
   enter this month is to see where it differs from last.

   ── RECORDED, NEVER CALCULATED ───────────────────────────────────────────
   The operator's instruction is that this system records what payroll decided
   and does not derive it. Drivers are variously on a fixed salary, a
   commission and a salary with incentives, and it differs person to person —
   so sql/schema_v77.sql stores a pay basis as DOCUMENTATION with no rate
   anywhere, and this screen shows revenue only as context, never multiplied by
   anything. A stored rate beside a revenue figure invites a reader to multiply
   and find the page contradicting payroll in front of the person whose wages
   are the subject.

   ── AND SALARY IS NOT EXPOSURE ───────────────────────────────────────────
   Recording pay does not reduce what a driver owes; money going TO somebody is
   not money they owe. It lands in the `pay` book and the 35% line does not
   move. That is asserted server-side in test/ledger_exposure.test.mjs and
   stated here because this is the screen where somebody would expect
   otherwise.

   ── EVERY ROW IS CHECKED BEFORE ANY ROW IS WRITTEN ───────────────────────
   "Check the month" runs the server's dry run for every filled row — the real
   statements against the real constraints, rolled back — and shows what would
   happen, including the refusals. Only then does "Record the month" commit.
   The alternative, saving as you tab out of each field, means discovering on
   row ninety that the supervisor was never picked. */
import { el, esc, panel, note, loading, tableFrom } from './ui.js';
import { api } from './data.js';
import { submitEntry, SUPERVISORS, aed, parseAmount } from './deposit_core.js';
import { dubaiDay } from './tz.js';

let SUP = null;

/* Six at a time. A hundred and twenty parallel requests against a one-vCPU
   database is a self-inflicted outage; one at a time is four minutes of
   somebody watching a spinner. */
const LANES = 6;
async function pooled(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(LANES, items.length) }, async () => {
    for (;;) {
      const k = i; i += 1;
      if (k >= items.length) return;
      // eslint-disable-next-line no-await-in-loop
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

const monthOf = (d) => String(d).slice(0, 7);
const lastDay = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

export async function renderSalary(root) {
  root.innerHTML = '';
  const head = panel('Pay the month', 'One entry per driver, all in. Recorded, never '
    + 'calculated — this system holds what payroll decided and does not derive it.', 'salary');
  root.append(head.panel);
  loading(head.body);

  const gridPanel = panel('The month', null, 'salary-grid');
  root.append(gridPanel.panel);

  const ex = await api('/api/ledger/exposure').catch(() => null);
  head.body.innerHTML = '';
  if (!ex) { head.body.append(note('The ledger could not be read.', 'bad')); return; }
  const people = (ex.people || []).filter((p) => p.name);

  /* ── the month, and who is recording ──────────────────────────────────── */
  const bar = el('div', 'depform');
  const mW = el('div', 'depfield');
  mW.append(el('label', 'deplabel', 'Month'));
  const month = el('input', 'depinput');
  month.type = 'month';
  month.value = monthOf(dubaiDay());
  mW.append(month);
  const whoW = el('div', 'depfield');
  whoW.append(el('label', 'deplabel', 'Recorded by'));
  const who = el('div', 'depchips');
  SUPERVISORS.forEach((s) => {
    const b = el('button', `depchip${SUP === s ? ' on' : ''}`, esc(s[0].toUpperCase() + s.slice(1)));
    b.type = 'button';
    b.onclick = () => { SUP = s; [...who.children].forEach((c) => c.classList.toggle('on', c === b)); };
    who.append(b);
  });
  whoW.append(who);
  bar.append(mW, whoW);
  head.body.append(bar);

  const verdict = el('div', 'depverdict');
  const actions = el('div', 'depactions');
  const checkBtn = el('button', 'btn', 'Check the month');
  const saveBtn = el('button', 'btn primary', 'Record the month');
  checkBtn.type = 'button'; saveBtn.type = 'button'; saveBtn.disabled = true;
  actions.append(checkBtn, saveBtn);
  head.body.append(verdict, actions);

  const inputs = new Map();

  async function drawGrid() {
    gridPanel.body.innerHTML = '';
    loading(gridPanel.body);
    const ym = month.value || monthOf(dubaiDay());
    /* Last month's figures, as the thing to type against. */
    const [y, m] = ym.split('-').map(Number);
    const prev = m === 1 ? `${y - 1}-12` : `${ym.slice(0, 5)}${String(m - 1).padStart(2, '0')}`;
    const [thisM, prevM] = await Promise.all([
      api(`/api/ledger/entries?book=pay&from=${ym}-01&to=${lastDay(ym)}`).catch(() => null),
      api(`/api/ledger/entries?book=pay&from=${prev}-01&to=${lastDay(prev)}`).catch(() => null),
    ]);
    const already = new Map();
    (thisM?.entries || []).filter((e) => e.type_code === 'salary')
      .forEach((e) => already.set(e.person_id, e));
    const before = new Map();
    (prevM?.entries || []).filter((e) => e.type_code === 'salary')
      .forEach((e) => before.set(e.person_id, Math.abs(e.amount)));

    gridPanel.body.innerHTML = '';
    const done = already.size;
    gridPanel.body.append(note(done
      ? `${done} of ${people.length} already have a salary recorded for ${esc(ym)}. Those rows `
        + 'are locked — a second entry for the same month would be a duplicate, and the way to '
        + 'correct one is a reversing entry, never an edit.'
      : `Nothing recorded for ${esc(ym)} yet.`, done ? 'ok' : null));

    inputs.clear();
    gridPanel.body.append(tableFrom(people, [
      { label: 'Driver', key: 'name', render: (p) => `<b>${esc(p.name)}</b>` },
      { label: 'Generated', key: 'earned', num: true,
        render: (p) => (p.earned != null ? esc(aed(p.earned))
          : `<span class="dash" title="${esc(p.earned_absent_reason || '')}">—</span>`) },
      { label: 'Last month', key: 'prev', num: true,
        render: (p) => (before.has(p.person_id)
          ? `<span class="dim">${esc(aed(before.get(p.person_id)))}</span>` : '—') },
      { label: `Salary for ${ym}`, key: 'pay', num: true,
        render: (p) => (already.has(p.person_id)
          ? `${esc(aed(Math.abs(already.get(p.person_id).amount)))} <span class="pill ok">recorded</span>`
          : `<input class="depinput salcell" inputmode="decimal" data-person="${p.person_id}" `
            + `placeholder="${before.has(p.person_id) ? esc(String(before.get(p.person_id))) : '0.00'}">`) },
    ], { cards: true, cardLead: 'name' }));

    gridPanel.body.querySelectorAll('.salcell').forEach((i) => {
      inputs.set(Number(i.dataset.person), i);
      i.oninput = () => { verdict.innerHTML = ''; saveBtn.disabled = true; };
    });
  }

  const filled = () => [...inputs.entries()]
    .map(([id, i]) => ({ id, v: parseAmount(i.value), raw: i.value.trim() }))
    .filter((r) => r.raw);

  const entryFor = (r, ym) => ({
    person_id: r.id,
    person_name: people.find((p) => p.person_id === r.id)?.name,
    type_code: 'salary', amount: r.v, settles_via: 'bank',
    effective_on: lastDay(ym), period_start: `${ym}-01`, period_end: lastDay(ym),
    entered_by: SUP, note: `${ym} salary, all in`,
  });

  checkBtn.onclick = async () => {
    verdict.innerHTML = '';
    const ym = month.value;
    const rows = filled();
    if (!SUP) { verdict.append(note('Say who is recording this.', 'warn')); return; }
    if (!rows.length) { verdict.append(note('No amounts have been entered.', 'warn')); return; }
    const bad = rows.filter((r) => r.v == null);
    if (bad.length) {
      verdict.append(note(`${bad.length} row${bad.length === 1 ? '' : 's'} could not be read as `
        + 'an amount. Digits, and at most two decimals.', 'bad'));
      return;
    }
    loading(verdict);
    const out = await pooled(rows, (r) => submitEntry(entryFor(r, ym)));
    verdict.innerHTML = '';
    const refused = out.map((o, k) => (o.error ? { row: rows[k], why: o.error } : null)).filter(Boolean);
    const total = rows.reduce((a, r) => a + r.v, 0);
    verdict.append(el('div', 'depsentence',
      `${esc(String(rows.length - refused.length))} of ${esc(String(rows.length))} rows would be `
      + `recorded for ${esc(ym)}, totalling ${esc(aed(total))}. Nothing has been written — every `
      + 'one of those ran against the real constraints inside a transaction that was rolled back.'));
    refused.forEach((r) => verdict.append(note(
      `${people.find((p) => p.person_id === r.row.id)?.name}: ${r.why}`, 'bad')));
    saveBtn.disabled = refused.length === rows.length;
  };

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    const ym = month.value;
    const rows = filled().filter((r) => r.v != null);
    loading(verdict);
    const out = await pooled(rows, (r) => submitEntry(entryFor(r, ym), { commit: true }));
    verdict.innerHTML = '';
    const failed = out.map((o, k) => (o.error ? { row: rows[k], why: o.error } : null)).filter(Boolean);
    verdict.append(note(`${rows.length - failed.length} recorded for ${ym}.`,
      failed.length ? 'warn' : 'ok'));
    failed.forEach((r) => verdict.append(note(
      `${people.find((p) => p.person_id === r.row.id)?.name}: ${r.why}`, 'bad')));
    await drawGrid();
  };

  month.onchange = drawGrid;
  await drawGrid();
}
