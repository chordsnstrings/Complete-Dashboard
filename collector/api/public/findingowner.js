/* Who is on this finding — the panel on a finding's own page.
   ─────────────────────────────────────────────────────────────────────────
   #action/<rule>/<subject> (app.js actionContract). docs/ULM-DESIGN.md §8
   act:finding.own: "take, assign and close a finding on #insights — records
   who acted". Until 2026-11-12 this page could only say "Whether anyone
   acted: not recorded", and that was true. Now a person whose role may take
   findings (Operations managers, Safety & compliance, Management, the
   Owner) can take it, give it to a colleague, close it saying how it ended
   and what was done, or reopen it; the server records each step under their
   name (api/access/findings.js, sql/schema_v122.sql finding_owner, and the
   access audit log).

   WHAT EACH READER SEES:
     a visitor while sign-in is optional  — that this is recorded for
       signed-in people, and a way to sign in. Nothing is fetched: the answer
       is about staff, and open mode shows the product as it was;
     a signed-in reader who cannot take findings — who is on it, and why
       they cannot act (the server's own sentence);
     a reader who can — the same, and the buttons. A step the server refuses
       says the server's reason beside the button, never a generic failure. */
import { el, esc, panel, dtStr } from './ui.js';
import { who, getJson, post } from './access.js';

const STATE_LINE = Object.freeze({ open: 'Nobody is on this finding.' });

export function ownerPanel(r) {
  const p = panel('Who is on it',
    'Take a finding to say you are dealing with it, and close it saying what was done. Each step is recorded with your name.',
    'act-owner');
  const key = { code: String(r.code ?? ''), entity_type: String(r.entity_type ?? ''), entity_id: String(r.entity_id ?? '') };

  const button = (label, act, cls = 'btn') => {
    const b = el('button', cls, esc(label));
    b.type = 'button';
    b.dataset.owner = act;
    return b;
  };
  const say = (host, text, tone = '') => {
    let m = host.querySelector('.fo-msg');
    if (!m) { m = el('p', 'cap fo-msg'); m.setAttribute('role', 'status'); host.append(m); }
    m.className = `cap fo-msg ${tone}`.trim();
    m.textContent = text;
  };
  const run = (host, btn, path, body) => async () => {
    btn.disabled = true;
    try {
      await post(`/api/access/findings/${path}`, { ...key, ...body });
      await draw();
    } catch (e) {
      btn.disabled = false;
      say(host, e.message || 'The server did not say why.', 'bad');
    }
  };

  async function draw() {
    p.body.innerHTML = '';
    if (!who.signedIn || who.kind !== 'user') {
      p.body.append(el('p', 'cap fo-line',
        `${esc('Who is on a finding is recorded for signed-in people, and shown to them.')} <a href="/signin">Sign in</a> to see it, or to take this one.`));
      return;
    }
    let d;
    try {
      d = await getJson(`/api/access/findings?${new URLSearchParams(key)}`);
    } catch (e) {
      p.body.append(el('p', 'cap fo-line', esc(e.message || 'Who is on it could not be read.')));
      return;
    }
    const f = (d.findings || [])[0] || null;
    const state = f?.state || 'open';
    const mine = f?.owner?.id === d.me;
    /* A short list, not a sentence: each part is a line of its own, so the
       page's FOCUS pass (focus.js) keeps who and when on the face of the
       page instead of folding a long sentence under ⓘ notes. */
    const dl = el('dl', 'acx-dl fo-state');
    dl.dataset.state = state;
    const row = (k, v) => dl.append(el('dt', null, esc(k)), el('dd', null, v));
    if (state === 'taken') {
      row('On it', mine ? '<b>You</b>' : `<b>${esc(f.owner?.name)}</b>`);
      if (f.assigned_by) row('Given by', `${esc(f.assigned_by.name)}, ${esc(dtStr(f.taken_at))}`);
      else row('Took it', esc(dtStr(f.taken_at)));
    } else if (state === 'closed') {
      row('Closed by', `<b>${esc(f.closed_by?.name)}</b>, ${esc(dtStr(f.closed_at))}`);
      row('How it ended', esc(f.outcome_text || f.outcome));
      if (f.note) row('What was done', esc(f.note));
      if (d.open) row('The rule', esc(`still finds it, computed ${dtStr(d.computed_at)} — reopen it if needed`));
    } else {
      row('On it', esc(STATE_LINE.open));
      if (f?.note) row('Reopened because', esc(f.note));
    }
    p.body.append(dl);
    if (!d.open && state !== 'closed') {
      p.body.append(el('p', 'cap', esc('Its rule no longer finds it, so it can be closed but not taken.')));
    }
    if (!d.canOwn) {
      if (d.why) p.body.append(el('p', 'cap fo-why', esc(d.why)));
      return;
    }
    const acts = el('div', 'fo-acts');
    p.body.append(acts);
    if (d.open && !(state === 'taken' && mine)) {
      const take = button(state === 'taken' ? 'Take it over' : 'Take it', 'take', 'btn primary');
      take.onclick = run(acts, take, 'take', {});
      acts.append(take);
    }
    if (d.open && (d.people || []).length) {
      const sel = el('select', 'fo-who');
      sel.setAttribute('aria-label', 'Give it to');
      sel.innerHTML = `<option value="">Give it to…</option>${(d.people || [])
        .filter((x) => !(state === 'taken' && x.id === f?.owner?.id))
        .map((x) => `<option value="${esc(x.id)}">${esc(x.name)}${x.id === d.me ? ' (you)' : ''}</option>`).join('')}`;
      const give = button('Give it', 'assign');
      give.onclick = () => {
        if (!sel.value) { say(acts, 'Choose who to give it to.', 'bad'); return undefined; }
        return run(acts, give, 'assign', { userId: Number(sel.value) })();
      };
      acts.append(sel, give);
    }
    if (state !== 'closed') {
      const how = el('select', 'fo-how');
      how.setAttribute('aria-label', 'How it ended');
      how.innerHTML = Object.entries(d.outcomes || {}).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
      const note = el('input', 'depinput fo-note-in');
      note.placeholder = 'What was done';
      note.setAttribute('aria-label', 'What was done');
      const close = button('Close it', 'close');
      close.onclick = () => {
        if (note.value.trim().length < 3) { say(acts, 'Say what was done — it is what “who acted” records.', 'bad'); return undefined; }
        return run(acts, close, 'close', { outcome: how.value, note: note.value.trim() })();
      };
      acts.append(how, note, close);
    }
    if (state !== 'open') {
      const again = button(state === 'closed' ? 'Reopen' : 'Put it back', 'reopen');
      again.onclick = run(acts, again, 'reopen', {});
      acts.append(again);
    }
  }

  draw();
  return p.panel;
}
