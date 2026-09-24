/* THE LENDING LINE — what it is, what it was, and moving it.
   ─────────────────────────────────────────────────────────────────────────
   The operator: "that percentage will change based on admin / operational head
   / management - so don't hardcode it keep it as a variable in settings which
   will be allocated to the usergroup later."

   A stored row, not a constant — and until this screen existed there was
   nowhere to store one, so every exposure figure in the product read "no
   threshold has been stored, so no exposure can be judged". True, honest, and
   useless: the ledger was measuring against a line nobody could draw.

   ── THE PAGE IS MOSTLY THE HISTORY, AND THAT IS THE POINT ────────────────
   One number in a settings field would be a worse version of hardcoding it:
   the figure would be current and the reasons would be nowhere. This table is
   append-only and effective-dated, so what the page owes a reader is the
   sequence — what the line was, from when, who moved it and why — because the
   question somebody actually arrives with is "why was this driver told they
   were over it in March", and the answer is March's row.

   ── AND IT SHOWS THE CONSEQUENCE BEFORE THE CHANGE, NOT AFTER ────────────
   The preview is a real transaction rolled back server-side, and it comes back
   carrying how many people are over the proposed line against how many are
   over the current one. Moving a lending threshold without seeing who it moves
   is the decision this page exists to stop somebody making blind. */
import { el, esc, panel, note, loading, tableFrom, kpiRow, money,
  contract, glance, absenceBand, pageFoot } from './ui.js';
import { fmt } from './charts.js';
import { ledgerBand, formBars, amountBands, firstReason, booksRecorded } from './ledger_ak.js';
import { api } from './data.js';
import { dubaiDay } from './tz.js';

const pctOf = (v) => (v == null ? '—' : `${Number(v)}%`);

export async function renderPolicy(root) {
  root.innerHTML = '';
  /* NOT "The lending line" — that is the rail's label for this view and the
     shell already prints it. test/nav_sections.test.mjs exists because a page
     that repeats its own name spends the one line a reader gives it saying
     nothing they did not already know. */
  const head = panel('Where it stands', null, 'policy');
  const formPanel = panel('Move it', 'Append-only: this writes a new row and edits nothing, so '
    + 'a decision taken in an earlier month still reads against the line it was taken under.',
  'policy-form');
  const histPanel = panel('Every line this fleet has had', null, 'policy-history');
  /* Under the page contract (plan §4 #policy): 00 first, whose opening lines
     are Where it stands' own notes (its tiles become 00's); Move it and
     Every line where they were; then what a line needs and how much of it
     exists, and the † band. One extra GET, the exposure read. */
  const ak = contract();
  const AK = ak ? ledgerBand() : null;
  const lead = ak ? el('div', 'pol-lead') : null;
  const after = ak ? el('div') : null;
  const exP = ak ? api('/api/ledger/exposure').catch(() => null) : null;
  if (ak) { AK.band.insertBefore(lead, AK.tiles); root.append(AK.band, formPanel.panel, histPanel.panel, after); loading(AK.tiles); }
  else root.append(head.panel, formPanel.panel, histPanel.panel);
  loading(head.body);

  async function refresh() {
    const d = await api('/api/ledger/policy').catch(() => null);
    head.body.innerHTML = '';
    histPanel.body.innerHTML = '';
    if (!d) { (ak ? lead : head.body).append(note('The policy could not be read.', 'bad')); return; }

    if (d.current) {
      /* kpiRow rather than a hand-rolled headline: it is the product's own
         tile and carries the type scale with it, and test/type_scale.test.mjs
         forbids a literal font size anywhere. */
      head.body.append(kpiRow([
        { label: 'The line', value: `${d.current.pct}%`,
          sub: 'of what a driver generates' },
        { label: 'In force since', value: d.current.effective_from,
          sub: `set by ${d.current.set_by}` },
        { label: 'Lines on record', value: String(d.history.length),
          sub: d.history.length > 1 ? 'append-only; every one still reads as it did'
            : 'the first' },
      ]));
      if (d.current.note) head.body.append(el('p', 'cap', esc(d.current.note)));
      head.body.append(el('p', 'cap', 'Over it an override is needed and nothing is blocked. '
        + 'The approval step arrives with user management; until then this line is what a '
        + 'person reads before deciding, not something the system enforces.'));
    } else {
      /* ABSENT WITH THE TRUE REASON. Never a default, and never 35 because
         that is what somebody said once in a conversation — a figure the
         product invented for itself is one nobody can be held to. */
      head.body.append(note(d.absent_reason, 'warn'));
    }
    head.body.append(note(d.attribution_only, 'ok'));

    /* Under the contract the notes above are 00's opening lines. */
    if (ak) lead.replaceChildren(...[...head.body.children].filter((c) => !c.classList.contains('kpis')));
    if (!d.history.length) {
      /* "below" was untrue: the form is ABOVE this panel (the plan's FIX,
         taken under the contract; the old skin keeps its sentence). */
      histPanel.body.append(note('No line has ever been set, so there is nothing to read back. '
        + `The first one recorded ${ak ? 'above' : 'below'} starts this history.`, 'warn'));
    } else {
      histPanel.body.append(tableFrom(d.history, [
        { label: 'Line', key: 'pct', num: true,
          render: (r) => `<b>${esc(pctOf(r.pct))}</b>` },
        { label: 'From', key: 'effective_from', render: (r) => esc(r.effective_from) },
        { label: 'Standing', key: 'in_force',
          /* Three states and not two. A row can be the one in force, one that
             has been superseded, or one filed ahead of its start date — and
             "the newest row" is not "the row in force" the moment a planned
             change is recorded, which is the normal way one is. */
          render: (r) => (r.in_force ? '<span class="pill ok">in force</span>'
            : r.starts_later ? '<span class="pill warn">starts later</span>'
              : '<span class="dim">superseded</span>') },
        { label: 'Set by', key: 'set_by', render: (r) => esc(r.set_by) },
        { label: 'Recorded', key: 'set_at',
          /* BOTH DATES, because they are different facts. "From" is when the
             line starts applying and this is when somebody typed it —
             management deciding on the 20th that the line has been 30% since
             the 1st is a real thing, and a page showing only one of the two
             makes that indistinguishable from backdating. */
          render: (r) => `<span class="dim">${esc(String(r.set_at || '').slice(0, 10))}</span>` },
        { label: 'Why', key: 'note', render: (r) => esc(r.note || '—') },
      ], { cards: true, cardLead: 'pct' }));
    }
    if (ak) policyContract(AK, after, root, d, await exP);
    return d;
  }

  const current = await refresh();

  /* ── the form ─────────────────────────────────────────────────────────── */
  const form = el('div', 'depform');
  const field = (label, hint) => {
    const w = el('div', 'depfield');
    w.append(el('label', 'deplabel', label));
    form.append(w);
    if (hint) w.dataset.hint = hint;
    return w;
  };

  const pW = field('The line');
  const pct = el('input', 'depinput depamount');
  pct.type = 'text'; pct.inputMode = 'decimal';
  /* NO PLACEHOLDER UNTIL THE SERVER SAYS WHAT THE LINE IS. A greyed "35" in an
     empty field is a figure this page invented, and on a fleet that has never
     stored one it would be read as the line in force. It is filled in below
     from the policy actually on file, or left blank. */
  const pctNote = el('div', 'depnote', 'The percentage itself, so a whole number rather than a '
    + 'fraction. A fraction sent here would store a line of a fraction of one percent, under '
    + 'which every driver in the fleet reads as over it.');
  /* Under the contract the line's field says what it holds: a visible box
     with a "%" after it (the plan: it read as a blank gap under its label). */
  if (ak) {
    const box = el('span', 'ak-pct');
    box.append(pct, el('span', 'ak-pct-u', '%'));
    pW.append(box, pctNote);
  } else pW.append(pct, pctNote);

  const dW = field('Applying from');
  const from = el('input', 'depinput');
  from.type = 'date'; from.value = dubaiDay();
  dW.append(from, el('div', 'depnote', 'The day this line starts applying, which need not be '
    + 'today. A line decided now that has applied since the first of the month is a real thing '
    + '— both dates are kept, so the record shows when it was typed as well.'));

  const byW = field('Set by');
  const by = el('input', 'depinput');
  by.type = 'text'; by.placeholder = 'Your name';
  byW.append(by, el('div', 'depnote', 'Deliberately not the supervisor list: those four record '
    + 'money at a car, and moving this line is a management decision. Until user accounts '
    + 'exist this name, an address and a timestamp are what make the change traceable.'));

  const nW = field('Why it is moving');
  const why = el('input', 'depinput');
  why.type = 'text';
  why.placeholder = 'The sentence somebody reads a year from now';
  nW.append(why);

  const verdict = el('div', 'depverdict');
  const actions = el('div', 'depactions');
  const checkBtn = el('button', 'btn', 'See who this moves');
  const saveBtn = el('button', 'btn primary', 'Set the line');
  checkBtn.type = 'button'; saveBtn.type = 'button'; saveBtn.disabled = true;
  actions.append(checkBtn, saveBtn);
  form.append(verdict, actions);
  formPanel.body.append(form);

  if (current?.current) {
    pct.placeholder = String(current.current.pct);
    pctNote.textContent = `The percentage itself, so a whole number — the line on file now is `
      + `${current.current.pct}. A fraction sent here would store a line of a fraction of one `
      + 'percent, under which every driver in the fleet reads as over it.';
  }
  [pct, from, by, why].forEach((i) => {
    i.oninput = () => { verdict.innerHTML = ''; saveBtn.disabled = true; };
  });

  const payload = () => ({
    pct: Number(String(pct.value).trim()),
    effective_from: from.value,
    set_by: by.value.trim(),
    note: why.value.trim(),
  });

  async function send(commit) {
    verdict.innerHTML = '';
    loading(verdict);
    const r = await fetch('/api/ledger/policy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload(), dry_run: !commit }),
    });
    const b = await r.json().catch(() => ({}));
    verdict.innerHTML = '';
    if (!r.ok || b.ok === false) {
      (b.refused || [b.error || `Refused (${r.status}).`]).forEach((x) => verdict.append(note(x, 'bad')));
      return null;
    }
    /* THE SERVER'S OWN SENTENCE, verbatim — the same rule as every other write
       in this ledger. Composing a second one here is how two screens come to
       describe one change differently. */
    verdict.append(el('div', 'depsentence', esc(b.sentence)));
    if (b.not_measurable) {
      verdict.append(note(`${b.not_measurable} people have no exposure figure at all, and are `
        + 'not in either count above. Most often no cash position has been stated for them — '
        + 'their exposure is refused rather than shown low, which is the safe direction.', 'warn'));
    }
    verdict.append(note(commit ? b.append_only : b.note, commit ? 'ok' : 'ok'));
    return b;
  }

  checkBtn.onclick = async () => { saveBtn.disabled = !(await send(false)); };
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    const b = await send(true);
    if (!b) { saveBtn.disabled = false; return; }
    pct.value = ''; why.value = '';
    await refresh();
  };
}

/* ── #policy under the page contract ───────────────────────────────────────
   00: Where it stands' notes as the opening lines, then the people this line
   would govern (the hero) · the line in force (or none stored, the route's
   words) · lines ever recorded · exposure measurable. After the history:
   what a lending line needs and how much of it exists (the advance book,
   the deduction book, an opening cash position, an earnings figure — each
   over everyone the exposure read holds); how the cash-fare ceiling
   spreads; both halves of the ratio on the same person. † a stored line,
   what each person owes, cash held, who may move the line.
   NOT ADOPTED: "types the register accepts 18", the registry by book and the
   direction per type (no GET serves the registry — the mockup read schema
   files and a refusal message). */
function policyContract(AK, after, root, d, ex) {
  const people = ex?.people || [];
  const n = people.length;
  const cur = d.current;
  glance(AK.tiles, [
    ex ? { label: 'People this line would govern', value: fmt(n), hero: true, sub: 'everyone on the exposure read' }
      : { label: 'People this line would govern', hero: true, na: 'the exposure read did not answer' },
    cur ? { label: 'The line in force', value: `${cur.pct}%`, sub: `of what a driver generates, since ${cur.effective_from}, set by ${cur.set_by}` }
      : { label: 'The line in force', na: d.absent_reason || 'none stored' },
    { label: 'Lines ever recorded', value: fmt(d.history.length),
      sub: d.history.length ? 'append-only; every one still reads as it did' : 'none, ever' },
    ex ? { label: 'Exposure measurable', value: `${fmt(ex.summary?.measurable ?? people.filter((p) => p.exposure_pct != null).length)} of ${fmt(n)}`,
      sub: 'judged per person on the server' }
      : { label: 'Exposure measurable', na: 'the exposure read did not answer' },
  ]);
  after.innerHTML = '';
  if (!ex) { after.append(note('The exposure read did not answer, so what a line needs cannot be counted here.', 'warn')); return; }
  const g = el('div', 'grid g3'); after.append(g);
  const need = panel('What a lending line needs, and how much of it exists', `Each over the ${fmt(n)} people on the exposure read.`, 'policy-needs');
  const spread = panel('How the cash-fare ceiling spreads', 'Every cash fare on record, per driver — a ceiling, not a balance.', 'policy-ceiling');
  const halves = panel('Both halves of the ratio on the same person', 'A line judges cash against what a driver generates; it can judge only people with both.', 'policy-halves');
  g.append(need.panel, spread.panel, halves.panel);
  const adv = people.filter((p) => (+p.owes?.advance_rows || 0) > 0 || (p.owes?.advance_rows == null && p.owes?.advance != null)).length;
  const ded = people.filter((p) => (+p.owes?.deduction_rows || 0) > 0 || (p.owes?.deduction_rows == null && p.owes?.deduction != null)).length;
  const open = people.filter((p) => p.owes?.cash_basis?.opening_on).length;
  const earn = people.filter((p) => p.earned != null).length;
  formBars(need.body, [
    { label: 'An advance book row', n: adv }, { label: 'A deduction book row', n: ded },
    { label: 'An opening cash position', n: open }, { label: 'An earnings figure', n: earn },
  ], { of: n });
  const sp = amountBands(spread.body, people.map((p) => p.owes?.cash_taken).filter((v) => v != null),
    { noun: 'drivers', aria: 'Drivers by cash-fare ceiling' });
  if (sp) spread.body.append(el('p', 'cap', esc(`${fmt(sp.n)} drivers with a cash fare on record, in ${money(sp.step)} bands named by their lower edge.`)));
  const cash = (p) => p.owes?.cash_taken != null;
  const gen = (p) => p.earned != null;
  formBars(halves.body, [
    { label: 'Both', n: people.filter((p) => cash(p) && gen(p)).length },
    { label: 'Cash fares only', n: people.filter((p) => cash(p) && !gen(p)).length },
    { label: 'An earnings figure only', n: people.filter((p) => !cash(p) && gen(p)).length },
    { label: 'Neither', n: people.filter((p) => !cash(p) && !gen(p)).length, outline: true },
  ], { of: n });
  const books = people.filter(booksRecorded).length;
  const absHost = el('div'); after.append(absHost);
  absenceBand(absHost, [
    { label: 'A stored line', fig: d.history.length ? `${fmt(d.history.length)} on record` : null, none: 'None, ever',
      why: d.history.length ? 'Every line is a new row; none is ever edited.' : (d.absent_reason || 'No threshold has been stored.') },
    { label: 'What each person owes', fig: books ? `${fmt(books)} of ${fmt(n)} recorded` : null, none: 'Nothing recorded',
      why: firstReason(people, (p) => p.owes?.books_absent_reason) || 'Everyone here has an advance or deduction row.' },
    { label: 'Cash held', fig: null, none: 'Not derivable',
      why: firstReason(people, (p) => p.owes?.cash_absent_reason)
        || 'A cash position is stated by the accounts team; it is never derived from the trips.' },
    { label: 'Who may move this line', fig: null, none: 'Nobody authenticated',
      why: d.attribution_only || 'Anybody who can reach this page can move the line.' },
  ]);
  pageFoot({ colophon: ['The whole record', `${fmt(n)} people`, cur ? `${cur.pct}% in force` : 'no line stored'] }, root);
}
