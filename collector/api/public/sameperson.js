/* Two records, one question, and a person to answer it.
   ──────────────────────────────────────────────────────────────────────────
   The operator: "names can be different it needs to be automatically merged.
   If you need human involvement create a page in people which will have
   similar name and a human will confirm or deny if they are the same people or
   not."

   A phone number or an email on two records is an identifier and merges
   itself — those never appear here. What appears here is the residue: pairs
   whose only evidence is that one name sits inside the other. "MUHAMMAD
   SHAFIQ" is inside "MUHAMMAD SHAFIQ UMAR RAZIQ" and equally inside "MUHAMMAD
   SHAFIQ AHMED". One of those is the same man; nothing in the two strings says
   which, and a wrong answer pools two people's work and money.

   So the page's job is not to present a score. It is to put the facts that
   actually settle it next to each other — the channels, the trip counts, the
   dates, the cars — and make both answers one click. A reviewer who has to go
   and look something up will not use this twice. */
import { el, esc, panel, loading, note, kpiRow, entity, pill, sourceLabel,
  dateStr, fmt } from './ui.js';
import { api } from './data.js';

const platPill = (p) => (p ? pill(sourceLabel(p)) : '');

/* One side of the pair, as the block a reviewer reads. Deliberately identical
   for both sides: a layout that presents the survivor more prominently than
   the alias invites the reader to agree with the proposal rather than judge
   it. */
function sideBlock(s, label) {
  const d = el('div', 'sp-side');
  d.append(el('div', 'sp-cap', label));
  const nm = el('div', 'sp-name');
  nm.innerHTML = entity('driver', s.driver_ext_id, s.name || s.driver_ext_id);
  d.append(nm);
  const meta = el('div', 'sp-meta');
  meta.innerHTML = [
    platPill(s.platform),
    ...(s.fleets || []).map((f) => pill(sourceLabel(f))),
  ].join(' ');
  d.append(meta);
  const facts = el('ul', 'sp-facts');
  const li = (h) => { const x = el('li'); x.innerHTML = h; facts.append(x); };
  li(s.trips
    ? `<b>${fmt(s.trips)}</b> ${s.trips === 1 ? 'trip' : 'trips'}`
    : '<b>no trips</b> on record');
  if (s.first_trip) li(`first ${esc(dateStr(s.first_trip))}, last ${esc(dateStr(s.last_trip))}`);
  li((s.plates || []).length
    ? `drove ${(s.plates || []).slice(0, 3).map(esc).join(', ')}`
      + ((s.plates || []).length > 3 ? ` and ${(s.plates.length - 3)} more` : '')
    : '<span class="dim">no car on record</span>');
  d.append(facts);
  return d;
}

function pairCard(p, onDecide) {
  const c = el('div', `sp-pair${p.verdict ? ` done ${p.verdict}` : ''}`);
  const body = el('div', 'sp-body');
  body.append(sideBlock(p.canonical, 'This record'));
  const mid = el('div', 'sp-mid');
  mid.innerHTML = '<span class="sp-q">same person?</span>';
  body.append(mid);
  body.append(sideBlock(p.alias, 'and this one'));
  c.append(body);

  const ev = el('p', 'sp-ev'); ev.textContent = p.evidence; c.append(ev);
  const pl = el('p', 'sp-ev dim'); pl.textContent = p.plate_note; c.append(pl);
  if (p.phone_tail) {
    c.append(el('p', 'sp-ev dim', `Both filed a phone ending ${p.phone_tail}.`));
  }

  if (p.verdict) {
    const v = el('div', 'sp-verdict');
    v.innerHTML = p.verdict === 'same'
      ? `<b>Confirmed one person</b>${p.decided_by ? ` by ${esc(p.decided_by)}` : ''}`
      : `<b>Ruled two people</b>${p.decided_note ? ` — ${esc(p.decided_note)}` : ''}`;
    const undo = el('button', 'btn', 'Put back in the queue');
    undo.onclick = () => onDecide(p, 'undecided');
    v.append(undo);
    c.append(v);
    return c;
  }

  const row = el('div', 'sp-actions');
  /* BOTH BUTTONS PLAIN, and that is the design. An accent on "Yes" would make
     agreeing the default action on a page whose whole value is that somebody
     actually judged it — and the wrong Yes pools two people's work and money
     while the wrong No costs a second look. The labels carry the difference. */
  const same = el('button', 'btn', 'Yes — one person');
  const diff = el('button', 'btn', 'No — two people');
  same.onclick = () => onDecide(p, 'same');
  diff.onclick = () => onDecide(p, 'different');
  row.append(same, diff);
  /* What each button DOES, beside the buttons. "Confirm" on its own does not
     say that the records fold on every page from the next request, nor that
     the monthly rollups keep counting them apart until the pair is promoted
     into the register — and a reviewer who does not know that cannot judge
     whether they are allowed to click it. */
  row.append(el('span', 'sp-hint',
    'Yes folds the two records on the driver pages and the directory from the next request. '
    + 'No keeps them apart for good — the collector will not ask again.'));
  c.append(row);
  return c;
}

export async function renderSamePerson(root) {
  root.innerHTML = '';
  const head = el('div'); root.append(head); loading(head);
  const queue = panel('Waiting for an answer',
    'One name sits inside the other, and nothing else says whether that is one person');
  root.append(queue.panel);
  const done = panel('Already answered', 'A verdict here outlives every collector run');
  root.append(done.panel);
  [queue.body, done.body].forEach(loading);

  const draw = async () => {
    let d;
    try { d = await api('/api/same-person'); } catch (e) {
      head.innerHTML = '';
      head.append(note(`This page could not be read: ${String(e && e.message ? e.message : e)}`, 'warn'));
      return;
    }
    head.innerHTML = '';
    head.append(kpiRow([
      { key: 'sp-pending', label: 'Waiting for you', value: fmt(d.pending.length),
        sub: 'pairs a rule cannot settle' },
      { key: 'sp-same', label: 'Confirmed one person',
        value: fmt(d.decided.filter((p) => p.verdict === 'same').length),
        sub: 'folded on every driver page' },
      { key: 'sp-diff', label: 'Ruled two people',
        value: fmt(d.decided.filter((p) => p.verdict === 'different').length),
        sub: 'never proposed again' },
    ]));
    head.append(note(d.why));
    head.append(el('p', 'cap', d.refuted_note));

    const onDecide = async (p, verdict) => {
      try {
        await api('/api/same-person/decide', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ alias_ext_id: p.alias_ext_id, verdict }),
        });
      } catch (e) {
        head.append(note(`That verdict did not save: ${String(e && e.message ? e.message : e)}`, 'warn'));
        return;
      }
      await draw();
    };

    queue.body.innerHTML = '';
    if (!d.pending.length) {
      queue.body.append(note('Nothing is waiting. Every pair the name rule has found has been '
        + 'answered, and a phone or an email on two records merges without needing anybody.'));
    } else {
      d.pending.forEach((p) => queue.body.append(pairCard(p, onDecide)));
    }

    done.body.innerHTML = '';
    if (!d.decided.length) {
      done.body.append(note('No pair has been answered yet.'));
    } else {
      d.decided.forEach((p) => done.body.append(pairCard(p, onDecide)));
    }
  };

  await draw();
}
