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
/* The fleet's calendar is Dubai's, and a local copy of that clock is exactly
   how onlinetime.js came to print a collector time in UTC. dubaiDay() is the
   one implementation; test/timezone.test.mjs is what stops a second one. */
import { dubaiDay } from './tz.js';
import { compress, putReceipt, submitEntry, SUPERVISORS, aed, parseAmount } from './deposit_core.js';

/* The supervisor sticks for the session. A person recording fifteen receipts
   should name themselves once — and re-picking it per entry is how an audit
   column fills with whoever was last in the list. */
let SUP = null;

export async function renderDeposits(root) {
  root.innerHTML = '';
  const head = panel('Cash handed in', 'Every deposit a driver has made, and the form to record '
    + 'the next one. A deposit is what turns cash in hand from a guess into a balance.', 'deposits');
  root.append(head.panel);

  const form = el('div', 'depform');
  head.body.append(form);

  /* ── who is recording ─────────────────────────────────────────────────
     First, and once. Until ULM exists this name plus an IP and a timestamp is
     the whole of the audit trail, and the server refuses anything not on this
     list — so the picker is a convenience and NOT the enforcement. */
  const whoWrap = el('div', 'depfield');
  whoWrap.append(el('label', 'deplabel', 'Recorded by'));
  const who = el('div', 'depchips');
  SUPERVISORS.forEach((s) => {
    const b = el('button', `depchip${SUP === s ? ' on' : ''}`, esc(s[0].toUpperCase() + s.slice(1)));
    b.type = 'button';
    b.onclick = () => {
      SUP = s;
      [...who.children].forEach((c) => c.classList.toggle('on', c === b));
      redrawPreview();
    };
    who.append(b);
  });
  whoWrap.append(who);
  form.append(whoWrap);

  /* ── who it came from ─────────────────────────────────────────────────
     A searchable list and never a typed name. api/identity_map.js is a
     hand-reviewed list precisely because a name cannot settle who somebody is;
     letting this field be free text would put that decision back at the point
     money is recorded. */
  const whoFrom = el('div', 'depfield');
  whoFrom.append(el('label', 'deplabel', 'From'));
  const pick = el('input', 'depinput');
  pick.type = 'search';
  pick.placeholder = 'Type a driver’s name…';
  pick.setAttribute('list', 'dep-drivers');
  const list = el('datalist'); list.id = 'dep-drivers';
  whoFrom.append(pick, list);
  const whoNote = el('div', 'depnote');
  whoFrom.append(whoNote);
  form.append(whoFrom);

  /* ── how much ─────────────────────────────────────────────────────────
     inputmode decimal so a desktop keyboard is unaffected and a touch device
     on this same page gets digits. A magnitude only: the server applies the
     sign from the type, which is what makes a wrong-way-round row impossible
     rather than merely unlikely. */
  const amtWrap = el('div', 'depfield');
  amtWrap.append(el('label', 'deplabel', 'Amount handed in'));
  const amt = el('input', 'depinput depamount');
  amt.type = 'text'; amt.inputMode = 'decimal'; amt.placeholder = '0.00';
  amtWrap.append(amt);
  const amtEcho = el('div', 'depnote');
  amtWrap.append(amtEcho);
  form.append(amtWrap);

  /* ── when ─────────────────────────────────────────────────────────────
     Defaults to today in Dubai and is editable, because a receipt worked
     through on Tuesday may be Monday's handover. effective_on is the day the
     money moved; the server stamps separately when it was typed. */
  const dayWrap = el('div', 'depfield');
  dayWrap.append(el('label', 'deplabel', 'Day the money changed hands'));
  const day = el('input', 'depinput');
  day.type = 'date';
  day.value = dubaiDay();
  dayWrap.append(day);
  form.append(dayWrap);

  /* ── the proof ────────────────────────────────────────────────────────
     Compressed here, and the resulting size shown BEFORE the send. The route
     refuses over 1MB, and a refusal that arrives after the cash has changed
     hands is the worst moment to discover it. */
  const picWrap = el('div', 'depfield');
  picWrap.append(el('label', 'deplabel', 'Photograph of the receipt'));
  const pic = el('input', 'depinput depfile');
  pic.type = 'file'; pic.accept = 'image/*'; pic.setAttribute('capture', 'environment');
  const picNote = el('div', 'depnote');
  const preview = el('img', 'deppreview');
  preview.style.display = 'none';
  picWrap.append(pic, picNote, preview);
  form.append(picWrap);

  /* ── the note ─────────────────────────────────────────────────────────── */
  const noteWrap = el('div', 'depfield');
  noteWrap.append(el('label', 'deplabel', 'Note'));
  const noteIn = el('input', 'depinput');
  noteIn.type = 'text';
  noteIn.placeholder = 'What a reader a year from now would need to know';
  noteWrap.append(noteIn);
  form.append(noteWrap);

  /* ── the verdict, before anything is saved ────────────────────────────
     The server's own sentence, from its dry run — not one assembled here.
     api/ledger_routes.js builds it so that the desktop and the phone cannot
     describe one entry differently, and re-deriving it in this file would
     reintroduce exactly that. */
  const verdict = el('div', 'depverdict');
  form.append(verdict);

  const actions = el('div', 'depactions');
  const previewBtn = el('button', 'btn', 'Check it');
  const saveBtn = el('button', 'btn primary', 'Record the deposit');
  previewBtn.type = 'button'; saveBtn.type = 'button';
  saveBtn.disabled = true;
  actions.append(previewBtn, saveBtn);
  form.append(actions);

  let shot = null;          // { blob, bytes } from the compressor
  let sha = null;           // digest once uploaded
  let people = [];

  const chosen = () => people.find((p) => p.label === pick.value) || null;

  amt.oninput = () => {
    const v = parseAmount(amt.value);
    amtEcho.textContent = v == null
      ? (amt.value.trim() ? 'That is not an amount this form can read — digits, and at most two decimals.' : '')
      : aed(v);
    amtEcho.className = `depnote${v == null && amt.value.trim() ? ' bad' : ''}`;
    saveBtn.disabled = true;
  };
  pick.oninput = () => {
    const p = chosen();
    whoNote.textContent = p
      ? `${p.accounts} account${p.accounts === 1 ? '' : 's'} on this person. A deposit reduces `
        + 'what they are holding whichever account it is entered against.'
      : (pick.value.trim() ? 'Pick a name from the list — this form never takes a typed one, '
        + 'because a name cannot settle who somebody is.' : '');
    whoNote.className = `depnote${p ? '' : (pick.value.trim() ? ' bad' : '')}`;
    saveBtn.disabled = true;
  };
  pic.onchange = async () => {
    shot = null; sha = null; saveBtn.disabled = true;
    preview.style.display = 'none';
    const f = pic.files && pic.files[0];
    if (!f) { picNote.textContent = ''; return; }
    picNote.textContent = 'Compressing…';
    picNote.className = 'depnote';
    const out = await compress(f);
    if (out.error) { picNote.textContent = out.error; picNote.className = 'depnote bad'; return; }
    shot = out;
    const kb = (v) => `${Math.round(v / 1024)}KB`;
    picNote.textContent = `${kb(out.from)} → ${kb(out.bytes)} at ${out.width}×${out.height}. `
      + 'Compressed on this device, so the bytes that cross the connection are these.';
    preview.src = URL.createObjectURL(out.blob);
    preview.style.display = '';
  };

  const problems = () => {
    const out = [];
    if (!SUP) out.push('Say who is recording this.');
    if (!chosen()) out.push('Pick the driver it came from.');
    if (parseAmount(amt.value) == null) out.push('Enter the amount handed in.');
    if (!shot) out.push('Attach a photograph of the receipt — a deposit is money changing hands.');
    if (noteIn.value.trim().length < 3) out.push('Write a note.');
    return out;
  };

  const redrawPreview = () => { verdict.innerHTML = ''; saveBtn.disabled = true; };

  previewBtn.onclick = async () => {
    verdict.innerHTML = '';
    const bad = problems();
    if (bad.length) {
      verdict.append(note(bad.join(' '), 'warn'));
      return;
    }
    loading(verdict);
    if (!sha) {
      const up = await putReceipt(shot.blob, SUP);
      if (up.error) { verdict.innerHTML = ''; verdict.append(note(up.error, 'bad')); return; }
      sha = up.sha256;
      if (up.already_held && up.used_by_entries > 0) {
        verdict.append(note(up.note, 'warn'));
      }
    }
    const p = chosen();
    const out = await submitEntry({
      person_id: p.person_id, platform: p.platform, ext_id: p.ext_id,
      person_name: p.name, type_code: 'cash_deposit',
      amount: parseAmount(amt.value), settles_via: 'cash',
      effective_on: day.value, entered_by: SUP,
      note: noteIn.value.trim(), receipt_sha: sha,
    });
    verdict.innerHTML = '';
    if (out.error) { verdict.append(note(out.error, 'bad')); return; }
    /* The server's sentence, verbatim. */
    verdict.append(el('div', 'depsentence', esc(out.sentence)));
    verdict.append(note('Nothing has been recorded yet. Press “Record the deposit” to save it.', 'ok'));
    saveBtn.disabled = false;
  };

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    const p = chosen();
    const out = await submitEntry({
      person_id: p.person_id, platform: p.platform, ext_id: p.ext_id,
      person_name: p.name, type_code: 'cash_deposit',
      amount: parseAmount(amt.value), settles_via: 'cash',
      effective_on: day.value, entered_by: SUP,
      note: noteIn.value.trim(), receipt_sha: sha,
    }, { commit: true });
    verdict.innerHTML = '';
    if (out.error) { verdict.append(note(out.error, 'bad')); saveBtn.disabled = false; return; }
    verdict.append(note(`Recorded. ${out.sentence}`, 'ok'));
    amt.value = ''; amtEcho.textContent = ''; noteIn.value = '';
    pic.value = ''; picNote.textContent = ''; preview.style.display = 'none';
    shot = null; sha = null;
    await refresh();
  };

  /* ── the worklist ─────────────────────────────────────────────────────── */
  const listPanel = panel('Recorded deposits', null, 'deposit-list');
  root.append(listPanel.panel);

  async function refresh() {
    loading(listPanel.body);
    const d = await api('/api/ledger/exposure').catch(() => null);
    listPanel.body.innerHTML = '';
    if (!d) { listPanel.body.append(note('The ledger could not be read.', 'bad')); return; }
    people = (d.people || []).map((p) => ({
      person_id: p.person_id, name: p.name, accounts: p.accounts,
      label: p.name || `person ${p.person_id}`, platform: null, ext_id: null,
    }));
    list.innerHTML = people.map((p) => `<option value="${esc(p.label)}"></option>`).join('');

    /* EVERYONE, not only the people whose cash is known.
       The first version filtered to `owes.cash != null` and so hid exactly the
       people this screen exists for: somebody whose cash position has never
       been stated is the one finance needs to find, and dropping them from the
       worklist would have made the page look complete while the drivers who
       most need a deposit recorded were the ones missing from it. */
    const all = (d.people || []).slice()
      .sort((a, b) => (b.owes?.cash ?? -1) - (a.owes?.cash ?? -1));
    if (!all.length) {
      listPanel.body.append(note('Nobody is on the ledger yet.', 'warn'));
      return;
    }
    const unknown = all.filter((p) => !p.owes || p.owes.cash == null).length;
    if (unknown) {
      listPanel.body.append(note(`${unknown} of ${all.length} people have no stated cash `
        + 'position. Their cash reads as unknown rather than zero, and their exposure is '
        + 'refused rather than shown low — recording a deposit, or an opening position, is '
        + 'what turns it into a number.', 'warn'));
    }
    /* cards:true, so at phone width each row folds into a labelled block
       instead of a four-column table sliding the page sideways — measured at
       469px against a 390 viewport before this. */
    listPanel.body.append(tableFrom(all, [
      { label: 'Driver', key: 'name', render: (p) => `<b>${esc(p.name || '—')}</b>` },
      { label: 'Cash position', key: 'cash', num: true,
        render: (p) => (p.owes && p.owes.cash != null ? esc(aed(p.owes.cash))
          : `<span class="dash" title="${esc((p.owes && p.owes.cash_absent_reason)
            || p.exposure_absent_reason || '')}">—</span>`) },
      { label: 'Advances', key: 'advance', num: true,
        render: (p) => esc(aed(p.owes ? p.owes.advance : null) || '—') },
      { label: 'Exposure', key: 'exposure_pct', num: true,
        render: (p) => (p.exposure_pct == null
          ? `<span class="dash" title="${esc(p.exposure_absent_reason || '')}">—</span>`
          : `${p.exposure_pct}%`) },
    ], { cards: true, cardLead: 'name' }));
  }

  await refresh();
}
