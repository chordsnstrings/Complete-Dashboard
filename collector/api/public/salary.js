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
import { el, esc, panel, note, loading, tableFrom, entity,
  contract, glance, absenceBand, pageFoot } from './ui.js';
import { fmt } from './charts.js';
import { api } from './data.js';
import { ledgerBand, formBars, amountBands, firstReason } from './ledger_ak.js';
import { submitEntry, SUPERVISORS, aed, parseAmount, pooled, loadPeople,
  personRef } from './deposit_core.js';
import { dubaiDay } from './tz.js';

let SUP = null;

const monthOf = (d) => String(d).slice(0, 7);
const lastDay = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

export async function renderSalary(root) {
  root.innerHTML = '';
  /* Under the page contract (plan §4 #salary): 00 first, the form and the
     grid unchanged, then who the pay book covers and how the generated
     figure spreads, then the † band. */
  const ak = contract();
  const AK = ak ? ledgerBand('The grid is one month; Generated is the whole record') : null;
  if (ak) { root.append(AK.band); loading(AK.tiles); }
  const head = panel('Pay the month', 'One entry per driver, all in. Recorded, never '
    + 'calculated — this system holds what payroll decided and does not derive it.', 'salary');
  root.append(head.panel);
  loading(head.body);

  const gridPanel = panel('The month', null, 'salary-grid');
  root.append(gridPanel.panel);
  const after = ak ? el('div') : null;
  if (ak) root.append(after);

  /* EVERYONE ON THE PAYROLL, which is the roster and not the set of people who
     already carry a ledger balance. Salary is very often the FIRST thing ever
     recorded against a new hire — they may have no platform account at all —
     so a list drawn from existing ledger rows would omit exactly them. */
  const d = await loadPeople();
  head.body.innerHTML = '';
  if (!d.ok) { head.body.append(note(esc(d.error), 'bad')); return; }
  const people = (d.people || []).filter((p) => p.name);
  if (!d.exposure_ok) head.body.append(note(esc(d.exposure_absent_reason), 'warn'));
  /* The whole pay book, once, for the † band's "ever" — the grid's two reads
     are one month each. */
  const payAll = ak ? api('/api/ledger/entries?book=pay').catch(() => null) : null;

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
      { label: 'Driver', key: 'name',
        render: (p) => entity('driver', p.ext_id, p.name) },
      /* "Generated, whole record" under the contract (plan §4 FIX):
         loadPeople() is unwindowed, so this column is all-time while the
         column beside it is one month, and a reader took it as the month's. */
      { label: ak ? 'Generated, whole record' : 'Generated', key: 'earned', num: true,
        render: (p) => (p.earned != null ? esc(aed(p.earned))
          : `<span class="dash" title="${esc(p.earned_absent_reason || '')}">—</span>`) },
      /* `already` and `before` are keyed on person_id and come from the
         register, so they can only ever describe somebody who HAS entries.
         A roster row's person_id is null, which no register row carries — the
         lookups simply miss, which is the right answer: nobody has recorded a
         salary for a person who does not exist yet.

         The CELL, though, is keyed on the row index and not on person_id, for
         the same reason as #opening: data-person="null" would collide every
         unrecorded driver onto one cell. */
      { label: 'Last month', key: 'prev', num: true,
        render: (p) => (p.person_id != null && before.has(p.person_id)
          ? `<span class="dim">${esc(aed(before.get(p.person_id)))}</span>` : '—') },
      { label: `Salary for ${ym}`, key: 'pay', num: true,
        render: (p) => (p.person_id != null && already.has(p.person_id)
          ? `${esc(aed(Math.abs(already.get(p.person_id).amount)))} <span class="pill ok">recorded</span>`
          : `<input class="depinput salcell" inputmode="decimal" data-row="${people.indexOf(p)}" `
            + `placeholder="${p.person_id != null && before.has(p.person_id)
              ? esc(String(before.get(p.person_id))) : '0.00'}">`) },
    ], { cards: true, cardLead: 'name' }));

    gridPanel.body.querySelectorAll('.salcell').forEach((i) => {
      inputs.set(Number(i.dataset.row), i);
      i.oninput = () => { verdict.innerHTML = ''; saveBtn.disabled = true; };
    });
    if (ak) salaryContract(AK, after, root, people, { ym, prev, already, before, payAll: await payAll });
  }

  const filled = () => [...inputs.entries()]
    .map(([row, i]) => ({ row, p: people[row], v: parseAmount(i.value), raw: i.value.trim() }))
    .filter((r) => r.raw && r.p);

  const entryFor = (r, ym) => ({
    ...personRef(r.p),
    person_name: r.p.name,
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
    refused.forEach((r) => verdict.append(note(`${r.row.p.name}: ${r.why}`, 'bad')));
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
    failed.forEach((r) => verdict.append(note(`${r.row.p.name}: ${r.why}`, 'bad')));
    await drawGrid();
  };

  month.onchange = drawGrid;
  await drawGrid();
}

/* ── #salary under the page contract ───────────────────────────────────────
   00: salary recorded for the month (the hero) · last month · on the payroll
   and their accounts · generated, whole record · no generated figure (none
   at all, and exactly 0.00, said apart). After the grid: who the pay book
   covers this month, the generated figure measured / 0.00 / none, and how
   the measured figures spread. † wage runs on the pay book, payroll as a
   feed, what a wage should be, and the generated figure's own reason.
   RECORDED, NEVER CALCULATED holds here too: nothing below multiplies,
   divides or compares a wage with anything.
   NOT ADOPTED: a tile offering a figure "to check a wage against" (no GET
   serves the pay basis, and this file is built never to hold one); the
   accounts-per-person spread (an identity question, not payroll). */
function salaryContract(AK, after, root, people, { ym, prev, already, before, payAll }) {
  const n = people.length;
  const gen = people.filter((p) => p.earned != null && +p.earned > 0);
  const zero = people.filter((p) => p.earned != null && +p.earned === 0);
  const none = people.filter((p) => p.earned == null);
  const days = gen.reduce((a, p) => a + (+p.earning_days || 0), 0);
  const total = Math.round(gen.reduce((a, p) => a + (+p.earned || 0), 0) * 100) / 100;
  glance(AK.tiles, [
    { label: `Salary recorded for ${ym}`, value: `${fmt(already.size)} of ${fmt(n)}`, hero: true,
      sub: already.size ? 'those rows are locked in the grid below' : 'nothing is recorded for this month yet' },
    { label: 'Last month', value: `${fmt(before.size)} of ${fmt(n)}`, sub: `recorded for ${prev}` },
    { label: 'On the payroll', value: fmt(n),
      sub: `across ${fmt(people.reduce((a, p) => a + (+p.accounts || 0), 0))} platform accounts` },
    gen.length
      ? { label: 'Generated, whole record', value: aed(total),
        sub: `by ${fmt(gen.length)} of ${fmt(n)} over ${fmt(days)} earning days — context, never a wage` }
      : { label: 'Generated, whole record', na: firstReason(people, (p) => p.earned_absent_reason)
        || 'no driver here has a generated figure on the exposure read' },
    { label: 'No generated figure', value: `${fmt(none.length + zero.length)} of ${fmt(n)}`,
      sub: `${fmt(none.length)} none at all · ${fmt(zero.length)} exactly 0.00` },
  ]);

  after.innerHTML = '';
  const g = el('div', 'grid g3'); after.append(g);
  const cover = panel(`Who the pay book covers, ${ym}`, 'A person with no row is drawn as the outline: no record, not a nought.', 'salary-cover');
  const genP = panel('Generated, whole record', 'Measured, exactly 0.00, or no figure at all — three different facts.', 'salary-generated');
  const spread = panel('How the generated figure spreads', null, 'salary-spread');
  g.append(cover.panel, genP.panel, spread.panel);
  formBars(cover.body, [
    { label: `Recorded for ${ym}`, n: already.size },
    { label: `Recorded for ${prev}`, n: before.size },
    { label: `Not recorded for ${ym}`, n: n - already.size, outline: true, why: 'no salary row for this month' },
  ], { of: n });
  formBars(genP.body, [
    { label: 'A generated figure', n: gen.length },
    { label: 'Exactly 0.00', n: zero.length },
    { label: 'No figure', n: none.length, outline: true, why: firstReason(people, (p) => p.earned_absent_reason) || '' },
  ], { of: n });
  const sp = amountBands(spread.body, gen.map((p) => p.earned), { noun: 'people', aria: 'People by generated amount' });
  if (sp) spread.body.append(el('p', 'cap', esc(`${fmt(sp.n)} people with a generated figure above nought, in ${aed(sp.step)} bands, each named by its lower edge, over the whole record.`)));

  const pays = payAll?.totals?.rows;
  const absHost = el('div'); after.append(absHost);
  absenceBand(absHost, [
    { label: 'Wage runs on the pay book', fig: pays ? `${fmt(pays)} rows` : null, none: payAll ? 'None, ever' : 'Not loaded',
      why: !payAll ? 'The pay book did not load, so whether any wage has ever been recorded is not known here.'
        : pays ? 'Rows on the pay book over the whole record, verification rows excluded.'
          : 'No salary has been recorded on the pay book at any date — this page is where the first one is.' },
    { label: 'Payroll as a feed', fig: null, none: 'Not imported',
      why: 'No payroll system feeds this ledger. Every salary here is typed on this page or brought in from a sheet.' },
    { label: 'What a wage should be', fig: null, none: 'Not derivable',
      why: 'This system records what payroll decided and does not derive it: the pay basis is stored as documentation only, with nothing to multiply (sql/schema_v77.sql).' },
    { label: 'Generated, missing', hl: true, fig: `${fmt(none.length)} of ${fmt(n)}`,
      why: firstReason(people, (p) => p.earned_absent_reason) || 'Every driver here has a generated figure.' },
  ]);
  pageFoot({ colophon: [`The grid: ${ym}`, 'Generated: the whole record', `${fmt(n)} on the payroll`] }, root);
}
