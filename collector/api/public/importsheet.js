/* BRINGING A SPREADSHEET IN — and refusing to decide who anybody is.
   ─────────────────────────────────────────────────────────────────────────
   The file is parsed HERE, in the browser: it never leaves the machine it was
   chosen on until a human has looked at what it matched. The preview route
   then receives rows rather than a file whose shape it has to guess.

   ── THE SCREEN'S ONE JOB IS TO MAKE THE CHOICE VISIBLE ───────────────────
   api/import_routes.js does not accept a name at commit — only a person id —
   so a row can physically only be written against somebody chosen here. That
   makes this page the whole of the control, and it has two rules:

     a match the server called AMBIGUOUS is never pre-selected
     a row with no person chosen is never sent

   api/identity_map.js holds apart five pairs carrying simultaneous trips in
   two cars, two of them one token apart. On a sheet of four hundred rows the
   difference between "offered, confirm it" and "pre-ticked, untick if wrong"
   is whether anybody looks.

   ── AND THE HEADERS ARE MATCHED, NOT DEMANDED ────────────────────────────
   A real export says "Driver Name" or "Employee" rather than "name". Common
   spellings are recognised; anything unrecognised is REPORTED with the headers
   that were actually found, rather than the page saying "invalid file" and
   leaving somebody to guess which column it wanted. */
import { el, esc, panel, note, loading } from './ui.js';
import { api } from './data.js';
import { csvObjects, SUPERVISORS, aed, pooled } from './deposit_core.js';

let SUP = null;

/* What a column might be called. Order matters only in that the first hit
   wins, and the first entry is the canonical name. */
const FIELDS = {
  name: ['name', 'driver', 'driver_name', 'employee', 'employee_name', 'full_name'],
  type_code: ['type', 'type_code', 'kind', 'category'],
  amount: ['amount', 'value', 'balance', 'aed', 'sum'],
  effective_on: ['date', 'effective_on', 'day', 'as_of', 'as_at', 'dated'],
  note: ['note', 'notes', 'description', 'remarks', 'comment'],
};

const TYPES = ['opening_balance', 'cash_opening', 'salik', 'salary'];

export async function renderImport(root) {
  root.innerHTML = '';
  /* NOT "Bring a sheet in" — that is the rail's label for this view and the
     shell already prints it. test/nav_sections.test.mjs exists because a page
     that repeats its own name spends the one line a reader gives it saying
     nothing they did not already know. */
  const head = panel('Choose the file', 'History from a spreadsheet — the balances that were '
    + 'already outstanding when this ledger started. The file is read on this machine and '
    + 'nothing is written until every row has a person chosen for it.', 'import');
  const reviewPanel = panel('What it matched', null, 'import-review');
  root.append(head.panel, reviewPanel.panel);

  /* EVERY CANDIDATE, so a row the matcher missed entirely can still be placed
     without leaving the page. This read used to be /api/ledger/exposure — the
     people who already have ledger rows — which on the fresh ledger an import
     exists to OPEN is nobody at all, so every dropdown was empty and the whole
     screen could do nothing.

     /api/ledger/people carries the same `key` on each row that
     /api/ledger/import/preview puts on its proposals, from the same function
     (personKey, api/ledger_person.js) — which is what lets the matcher's
     proposal and this fallback list be the same option rather than two that
     look alike. */
  const people = ((await api('/api/ledger/people').catch(() => null))?.people || [])
    .filter((p) => p.name && p.key);

  const form = el('div', 'depform');
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

  const fileW = el('div', 'depfield');
  fileW.append(el('label', 'deplabel', 'The sheet, as CSV'));
  const file = el('input', 'depinput depfile');
  file.type = 'file'; file.accept = '.csv,text/csv';
  const fileNote = el('div', 'depnote', 'Columns it looks for: a name, a type, an amount, a '
    + 'date and a note. It recognises the usual spellings — “Driver Name”, “Employee”, '
    + '“As At” — and says what it found if it cannot place one.');
  fileW.append(file, fileNote);

  form.append(whoW, fileW);
  head.body.append(form);

  const actions = el('div', 'depactions');
  const commitBtn = el('button', 'btn primary', 'Import the chosen rows');
  commitBtn.type = 'button'; commitBtn.disabled = true;
  actions.append(commitBtn);
  head.body.append(actions);

  let preview = null;
  /* row number -> the candidate KEY a human chose. A key, not a person id,
     because half the candidates have no person id yet: `p:<id>` addresses
     somebody who exists and `a:<platform>:<ext>` an account the commit route
     resolves. Never a name, at either end. */
  const picks = new Map();
  const byKey = new Map();

  const refreshCommit = () => {
    const n = [...picks.values()].filter(Boolean).length;
    commitBtn.disabled = !SUP || n === 0;
    commitBtn.textContent = n ? `Import ${n} row${n === 1 ? '' : 's'}` : 'Import the chosen rows';
  };

  file.onchange = async () => {
    reviewPanel.body.innerHTML = '';
    picks.clear(); refreshCommit();
    const f = file.files && file.files[0];
    if (!f) return;
    loading(reviewPanel.body);
    const { headers, objects } = csvObjects(await f.text());

    /* WHICH COLUMN IS WHICH, said out loud. A file that cannot be placed says
       what it found rather than "invalid". */
    const map = {};
    const missing = [];
    for (const [canon, aliases] of Object.entries(FIELDS)) {
      const hit = aliases.find((a) => headers.includes(a));
      if (hit) map[canon] = hit; else missing.push(canon);
    }
    reviewPanel.body.innerHTML = '';
    if (missing.filter((m) => m !== 'note').length) {
      reviewPanel.body.append(note(`This sheet is missing a column for: `
        + `${missing.filter((m) => m !== 'note').join(', ')}. The headers it does have are: `
        + `${headers.join(', ')}.`, 'bad'));
      return;
    }
    reviewPanel.body.append(note(`Read ${objects.length} rows. Columns placed: `
      + Object.entries(map).map(([k, v]) => `${k} ← “${v}”`).join(', ') + '.'));

    const rows = objects.map((o) => ({
      name: o[map.name], type_code: o[map.type_code], amount: o[map.amount],
      effective_on: o[map.effective_on],
      note: map.note ? o[map.note] : `imported from ${f.name}`,
    }));

    const r = await fetch('/api/ledger/import/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { reviewPanel.body.append(note(body.error || 'The sheet was refused.', 'bad')); return; }
    preview = body;
    draw();
  };

  function draw() {
    const s = preview.summary;
    reviewPanel.body.append(note(`${s.exact} exact, ${s.likely} likely, ${s.ambiguous} `
      + `ambiguous, ${s.weak} weak, ${s.unmatched} matched to nobody`
      + `${s.with_problems ? `, ${s.with_problems} with a problem in the row itself` : ''}.`,
    s.ambiguous || s.unmatched || s.with_problems ? 'warn' : 'ok'));
    reviewPanel.body.append(note(preview.note));

    const t = el('table', 'tbl');
    t.innerHTML = '<thead><tr><th>#</th><th>On the sheet</th><th>What</th>'
      + '<th class="num">Amount</th><th>Who this is</th><th>Why</th></tr></thead>';
    const tb = el('tbody');
    preview.entries.forEach((e) => {
      const tr = el('tr');
      const problems = e.problems.length
        ? `<span class="bad">${esc(e.problems.join(' '))}</span>` : esc(e.match.why || '');
      tr.innerHTML = `<td>${e.row}</td><td>${esc(e.sheet.name || '—')}</td>`
        + `<td>${esc(e.sheet.type_code || '—')}</td>`
        + `<td class="num">${esc(e.parsed.amount == null ? '—' : aed(e.parsed.amount))}</td>`
        + '<td class="pickcell"></td>'
        + `<td>${problems}</td>`;
      const cell = tr.querySelector('.pickcell');
      if (e.problems.length) {
        cell.innerHTML = '<span class="dash" title="this row cannot be imported until the sheet '
          + 'is corrected">—</span>';
      } else {
        const sel = el('select', 'depinput');
        /* NOTHING IS PRE-SELECTED FOR AN AMBIGUOUS MATCH. On a sheet of four
           hundred rows the difference between "offered, confirm it" and
           "pre-ticked, untick if wrong" is whether anybody looks — and this
           roster holds pairs that are two different men. */
        const preselect = ['exact', 'likely'].includes(e.match.verdict) && e.match.person
          ? e.match.person.key : '';
        /* NEW TO THE LEDGER IS SAID ON THE OPTION ITSELF. Choosing one of those
           opens a record rather than adding to one, and on a historical sheet
           that is the normal case — so it belongs where the choice is made,
           not in a note above the table nobody reads twice. */
        const lab = (p, pct) => `${p.name}${pct != null ? ` (${Math.round(pct * 100)}%)` : ''}`
          + `${p.on_the_ledger ? '' : ' — new to the ledger'}`;
        const opts = [{ v: '', l: e.match.verdict === 'ambiguous'
          ? '— choose between these two —' : '— nobody chosen —' }];
        const offer = (p, pct) => {
          if (!p || !p.key || opts.some((o) => o.v === p.key)) return;
          byKey.set(p.key, p);
          opts.push({ v: p.key, l: lab(p, pct) });
        };
        offer(e.match.person, e.match.confidence);
        (e.match.alternatives || []).forEach((a) => offer(a, a.score));
        /* And every other candidate, so a row the matcher missed entirely can
           still be placed without leaving the page. */
        people.forEach((p) => offer(p, null));
        sel.innerHTML = opts.map((o) => `<option value="${esc(String(o.v))}"`
          + `${String(o.v) === String(preselect) ? ' selected' : ''}>${esc(o.l)}</option>`).join('');
        if (preselect) picks.set(e.row, preselect);
        sel.onchange = () => {
          const v = sel.value || null;
          if (v) picks.set(e.row, v); else picks.delete(e.row);
          refreshCommit();
        };
        cell.append(sel);
      }
      tb.append(tr);
    });
    t.append(tb);
    reviewPanel.body.append(el('div', 'tscroll')).append(t);
    refreshCommit();
  }

  commitBtn.onclick = async () => {
    commitBtn.disabled = true;
    const batch = `sheet-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
    const rows = preview.entries
      .filter((e) => picks.get(e.row))
      .map((e) => {
        const p = byKey.get(picks.get(e.row)) || {};
        return {
          /* The identifier the human chose, in whichever of its two shapes.
             person_name rides along so a roster account that has to be minted
             gets the name off the roster rather than "person 41". */
          ...(p.person_id != null
            ? { person_id: p.person_id }
            : { platform: p.platform, ext_id: p.ext_id }),
          person_name: p.name,
          type_code: e.sheet.type_code,
          amount: e.parsed.amount, effective_on: e.parsed.effective_on,
          note: e.sheet.note || `imported in ${batch}`,
        };
      });
    const r = await fetch('/api/ledger/import/commit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch, entered_by: SUP, rows }),
    });
    const body = await r.json().catch(() => ({}));
    reviewPanel.body.innerHTML = '';
    if (!r.ok || body.ok === false) {
      reviewPanel.body.append(note((body.refused || []).join(' ') || 'The import was refused.', 'bad'));
      if (body.note) reviewPanel.body.append(note(body.note));
      commitBtn.disabled = false;
      return;
    }
    reviewPanel.body.append(note(`${body.wrote} rows imported as batch ${body.batch}. They carry `
      + 'that batch so this import can be found — and reversed — together.', 'ok'));
    preview = null; picks.clear(); file.value = '';
  };

  /* Types this route accepts, named on the page so a sheet can be prepared
     rather than rejected. */
  head.body.append(note(`The types a sheet can carry: ${TYPES.join(', ')}. Everything else `
    + 'needs a photograph of its proof, and a spreadsheet has none.'));
}
