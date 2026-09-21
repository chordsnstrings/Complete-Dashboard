/* ONE FORM FOR EVERY KIND OF ENTRY.
   ─────────────────────────────────────────────────────────────────────────
   A cash advance, a repayment, a deposit, a fine and a write-off are the same
   five questions — who, what kind, how much, when, and what proves it — and
   they differ only in which types the picker offers and what the consequence
   sentence says. The FIRST version of this product had that form written out
   inside api/public/deposits.js, and building the advances page was about to
   copy it: at which point a rule tightened on one screen would have been
   loose on the other, and the person recording money on the looser one would
   never know.

   So the form is here, parameterised by the types it offers, and the three
   screens that use it are layout around it. Everything it decides comes from
   ./deposit_core.js, which the phone bundle imports too — the browser rules
   live in one place the same way the server's sentence does.

   ── WHAT THE FORM REFUSES TO DECIDE ──────────────────────────────────────
   It never picks a sign: the caller sends a positive magnitude and the server
   applies the type's direction, which is what makes a wrong-way-round row
   impossible rather than merely unlikely. It never composes the confirming
   sentence: api/ledger_routes.js assembles that server-side so two shells
   cannot describe one entry differently. And it never saves without a dry run
   first — the button is disabled until the server has said what would happen. */
import { el, esc, note, loading } from './ui.js';
import { dubaiDay } from './tz.js';
import { compress, putReceipt, submitEntry, SUPERVISORS, aed, parseAmount,
  personRef } from './deposit_core.js';

/* The supervisor sticks for the session, across every screen that uses this
   form. Somebody working through a pile should name themselves once — and
   re-picking per entry is how an audit column fills with whoever was last in
   the list. */
let SUP = null;
export const currentSupervisor = () => SUP;

/**
 * @param host      where to render
 * @param types     [{ code, label, needs_proof, hint }] — what this screen offers
 * @param onSaved   called after a successful commit
 * @param people    [{ person_id, name, accounts, platform, ext_id, on_the_ledger }]
 *                  person_id is null for somebody on a platform roster who has no
 *                  ledger record yet — see loadPeople() in ./deposit_core.js.
 */
export function entryForm(host, { types, people, onSaved, settlesVia = null }) {
  const form = el('div', 'depform');
  host.append(form);

  const field = (label) => {
    const w = el('div', 'depfield');
    w.append(el('label', 'deplabel', label));
    form.append(w);
    return w;
  };

  /* ── who is recording ─────────────────────────────────────────────────── */
  const whoW = field('Recorded by');
  const who = el('div', 'depchips');
  SUPERVISORS.forEach((s) => {
    const b = el('button', `depchip${SUP === s ? ' on' : ''}`, esc(s[0].toUpperCase() + s.slice(1)));
    b.type = 'button';
    b.onclick = () => { SUP = s; [...who.children].forEach((c) => c.classList.toggle('on', c === b)); reset(); };
    who.append(b);
  });
  whoW.append(who);

  /* ── which kind ──────────────────────────────────────────────────────────
     Offered as chips rather than a <select>, because the choice IS the entry —
     a cash advance and a repayment move a balance in opposite directions and a
     collapsed dropdown is the control most easily left on its default. */
  const kindW = field('What kind');
  const kinds = el('div', 'depchips');
  let kind = types[0];
  types.forEach((t) => {
    const b = el('button', `depchip${t === kind ? ' on' : ''}`, esc(t.label));
    b.type = 'button';
    b.onclick = () => {
      kind = t;
      [...kinds.children].forEach((c) => c.classList.toggle('on', c === b));
      kindHint.textContent = t.hint || '';
      reset();
    };
    kinds.append(b);
  });
  const kindHint = el('div', 'depnote', esc(kind.hint || ''));
  kindW.append(kinds, kindHint);

  /* ── who it is against ───────────────────────────────────────────────────
     Picked, never typed. api/identity_map.js is a hand-reviewed list precisely
     because a name cannot settle who somebody is; a free-text field here would
     put that decision back at the moment money is recorded. */
  const whoseW = field('Driver');
  const pick = el('input', 'depinput');
  pick.type = 'search'; pick.placeholder = 'Type a driver’s name…';
  pick.setAttribute('list', 'entry-people');
  const dl = el('datalist'); dl.id = 'entry-people';

  /* A DATALIST IS MATCHED ON ITS VALUE, so two people sharing a name would be
     one indistinguishable option and whichever came first in the array would
     silently take the money. The roster half of this list makes that likely
     rather than theoretical: api/identity_map.js exists because the same human
     appears under several accounts, and two different humans sharing a name is
     the case it deliberately refuses to fold. So a name that is not unique
     carries the account that tells the two apart, and the option VALUE is what
     is matched — never the bare name. */
  const seen = new Map();
  people.forEach((p) => seen.set(p.name, (seen.get(p.name) || 0) + 1));
  const labelOf = (p) => {
    let t = p.name;
    if (seen.get(p.name) > 1) {
      t += p.ext_id ? ` (${p.platform || 'account'} ${p.ext_id})` : ` (person ${p.person_id})`;
    }
    if (!p.on_the_ledger) t += ' — new to the ledger';
    return t;
  };
  const byLabel = new Map(people.map((p) => [labelOf(p), p]));
  dl.innerHTML = [...byLabel.keys()].map((t) => `<option value="${esc(t)}"></option>`).join('');
  const whoseNote = el('div', 'depnote');
  whoseW.append(pick, dl, whoseNote);
  const chosen = () => byLabel.get(pick.value) || null;

  /* ── how much ────────────────────────────────────────────────────────── */
  const amtW = field('Amount');
  const amt = el('input', 'depinput depamount');
  amt.type = 'text'; amt.inputMode = 'decimal'; amt.placeholder = '0.00';
  const amtEcho = el('div', 'depnote');
  amtW.append(amt, amtEcho);

  /* ── when ─────────────────────────────────────────────────────────────── */
  const dayW = field('Day the money moved');
  const day = el('input', 'depinput');
  day.type = 'date'; day.value = dubaiDay();
  dayW.append(day);

  /* ── the proof, shown only when the type needs one ───────────────────── */
  const picW = field('Photograph of the proof');
  const pic = el('input', 'depinput depfile');
  pic.type = 'file'; pic.accept = 'image/*'; pic.setAttribute('capture', 'environment');
  const picNote = el('div', 'depnote');
  const prev = el('img', 'deppreview'); prev.style.display = 'none';
  picW.append(pic, picNote, prev);

  const noteW = field('Note');
  const noteIn = el('input', 'depinput');
  noteIn.type = 'text';
  noteIn.placeholder = 'What a reader a year from now would need to know';
  noteW.append(noteIn);

  const verdict = el('div', 'depverdict');
  const actions = el('div', 'depactions');
  const checkBtn = el('button', 'btn', 'Check it');
  const saveBtn = el('button', 'btn primary', 'Record it');
  checkBtn.type = 'button'; saveBtn.type = 'button'; saveBtn.disabled = true;
  actions.append(checkBtn, saveBtn);
  form.append(verdict, actions);

  let shot = null; let sha = null;

  const needsProof = () => kind.needs_proof !== false;
  const syncProof = () => { picW.style.display = needsProof() ? '' : 'none'; };
  const reset = () => { verdict.innerHTML = ''; saveBtn.disabled = true; syncProof(); };
  syncProof();

  amt.oninput = () => {
    const v = parseAmount(amt.value);
    amtEcho.textContent = v == null
      ? (amt.value.trim() ? 'Digits, and at most two decimals.' : '')
      : aed(v);
    amtEcho.className = `depnote${v == null && amt.value.trim() ? ' bad' : ''}`;
    reset();
  };
  pick.oninput = () => {
    const p = chosen();
    let msg = '';
    if (p && p.on_the_ledger) {
      msg = `${p.accounts} account${p.accounts === 1 ? '' : 's'} on this person — an entry counts `
        + 'against them whichever account it is made through.';
    } else if (p) {
      /* SAID BEFORE THE MONEY MOVES, not discovered afterwards. Recording
         against a roster account creates the person, and the resolver folds in
         every sibling the merge register already names — so the operator
         should know they are opening a record, not adding to one. */
      msg = `On the ${p.platform || 'platform'} roster as ${p.ext_id}, with nothing recorded `
        + 'against them yet. Recording this opens their record and pulls in any other account '
        + 'the merge register already says is the same person.';
    } else if (pick.value.trim()) {
      msg = 'Pick a name from the list. This form never takes a typed one, because a name '
        + 'cannot settle who somebody is.';
    }
    whoseNote.textContent = msg;
    whoseNote.className = `depnote${p || !pick.value.trim() ? '' : ' bad'}`;
    reset();
  };
  noteIn.oninput = reset;
  pic.onchange = async () => {
    shot = null; sha = null; prev.style.display = 'none'; reset();
    const f = pic.files && pic.files[0];
    if (!f) { picNote.textContent = ''; return; }
    picNote.textContent = 'Compressing…'; picNote.className = 'depnote';
    const out = await compress(f);
    if (out.error) { picNote.textContent = out.error; picNote.className = 'depnote bad'; return; }
    shot = out;
    const kb = (v) => `${Math.round(v / 1024)}KB`;
    picNote.textContent = `${kb(out.from)} → ${kb(out.bytes)} at ${out.width}×${out.height}, `
      + 'compressed on this device.';
    prev.src = URL.createObjectURL(out.blob); prev.style.display = '';
  };

  const missing = () => {
    const out = [];
    if (!SUP) out.push('Say who is recording this.');
    if (!chosen()) out.push('Pick the driver.');
    if (parseAmount(amt.value) == null) out.push('Enter the amount.');
    if (needsProof() && !shot) out.push('Attach a photograph of the proof.');
    if (noteIn.value.trim().length < 3) out.push('Write a note.');
    return out;
  };
  const payload = () => {
    const p = chosen();
    return {
      /* A MINTED PERSON BY ID, AN UNCLAIMED ROSTER ROW BY ACCOUNT — never a
         fabricated id and never a name. api/ledger_person.js resolves the
         account inside the same transaction as the entry, so the identity
         decision is taken once, by the resolver, with the merge register in
         hand rather than by this form. */
      ...personRef(p),
      person_name: p.name, type_code: kind.code,
      amount: parseAmount(amt.value), settles_via: settlesVia,
      effective_on: day.value, entered_by: SUP,
      note: noteIn.value.trim(), receipt_sha: sha,
    };
  };

  checkBtn.onclick = async () => {
    verdict.innerHTML = '';
    const bad = missing();
    if (bad.length) { verdict.append(note(bad.join(' '), 'warn')); return; }
    loading(verdict);
    if (needsProof() && !sha) {
      const up = await putReceipt(shot.blob, SUP);
      if (up.error) { verdict.innerHTML = ''; verdict.append(note(up.error, 'bad')); return; }
      sha = up.sha256;
      if (up.already_held && up.used_by_entries > 0) {
        verdict.innerHTML = ''; verdict.append(note(up.note, 'warn'));
      }
    }
    const out = await submitEntry(payload());
    const held = verdict.querySelector('.note');
    verdict.innerHTML = '';
    if (held) verdict.append(held);
    if (out.error) { verdict.append(note(out.error, 'bad')); return; }
    verdict.append(el('div', 'depsentence', esc(out.sentence)));
    verdict.append(note('Nothing has been recorded yet.', 'ok'));
    saveBtn.disabled = false;
  };

  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    const out = await submitEntry(payload(), { commit: true });
    verdict.innerHTML = '';
    if (out.error) { verdict.append(note(out.error, 'bad')); saveBtn.disabled = false; return; }
    verdict.append(note(`Recorded. ${out.sentence}`, 'ok'));
    amt.value = ''; amtEcho.textContent = ''; noteIn.value = '';
    pic.value = ''; picNote.textContent = ''; prev.style.display = 'none';
    shot = null; sha = null;
    if (onSaved) await onSaved(out);
  };

  return { form, reset };
}
