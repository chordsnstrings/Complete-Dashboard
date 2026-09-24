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
  dateStr, fmt, contract, glance, glanceBand, bandTiles, absenceBand, pageFoot, foldChildren, countOf } from './ui.js';
import { hbars } from './charts.js';
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
  const hr = p.source === 'hr_roster';
  const c = el('div', `sp-pair${p.verdict ? ` done ${p.verdict}` : ''}${hr ? ' sp-hr' : ''}`);
  /* WHERE THE PROPOSAL CAME FROM, first. A pair HR's roster groups is a
     different kind of evidence from two names that look alike — an employer
     filed these ids under one employee — and the reviewer weighs it
     differently, so the card says so before anything else. */
  if (hr) {
    const src = el('div', 'sp-meta');
    src.innerHTML = `${pill('HR roster', 'info', 'basis hr_roster — platform ids HR files under one employee')} `
      + `<span class="dim">${esc(p.employee?.fleet_id === 'egari' ? 'Egari' : 'Ecosine')} employee `
      + `<span class="mono">${esc(p.employee?.employee_id || '')}</span>${p.employee?.name ? ` · ${esc(p.employee.name)}` : ''}`
      + ` · ${esc(String((p.accounts || []).length))} ids on HR’s row</span>`;
    c.append(src);
  }
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
  /* HR's roster disagrees with this pair, or this HR proposal disagrees with
     a link already held. Said on the card being answered. */
  if (p.hr_contradiction) c.append(note(`HR’s roster contradicts this: ${p.hr_contradiction}`, 'warn'));

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
  row.append(el('span', 'sp-hint', hr
    /* An HR proposal is NEVER applied — the operator's rule — so "Yes" must
       not promise a fold it will not make. */
    ? 'Yes records that you agree with HR; it merges nothing — an HR proposal is never applied '
      + 'automatically. No records that HR’s row carries somebody else’s id.'
    : 'Yes folds the two records on the driver pages and the directory from the next request. '
      + 'No keeps them apart for good — the collector will not ask again.'));
  c.append(row);
  return c;
}

export async function renderSamePerson(root) {
  root.innerHTML = '';
  /* Under the page contract (plan §4 same-person): a 00 band — waiting for
     you the hero, and the trips the "same" verdicts fold — then the queue in
     full, first; the answered pairs folded to twelve, with a filter by
     verdict (the page was 111,110 px tall at 1440 with 365 cards); the
     channel pairs of the decided; a † band holding the why and refuted notes
     and the verdicts that carry no reviewer. The card markup, both buttons,
     their wording and Put back in the queue are unchanged; a decided card
     says its verdict in words, not with a tinted background (arkiv.css). */
  const ak = contract();
  const AKB = ak ? glanceBand(root, null) : null;
  const head = el('div'); root.append(head); loading(head);
  const queue = panel('Waiting for an answer',
    'One name sits inside the other, and nothing else says whether that is one person');
  root.append(queue.panel);
  const done = panel('Already answered', 'A verdict here outlives every collector run');
  root.append(done.panel);
  [queue.body, done.body].forEach(loading);

  let spFilter = 'all';
  const draw = async () => {
    let d;
    try { d = await api('/api/same-person'); } catch (e) {
      head.innerHTML = '';
      head.append(note(`This page could not be read: ${String(e && e.message ? e.message : e)}`, 'warn'));
      return;
    }
    head.innerHTML = '';
    const SP_TILES = [
      { key: 'sp-pending', label: 'Waiting for you', value: fmt(d.pending.length),
        sub: 'pairs a rule cannot settle' },
      { key: 'sp-same', label: 'Confirmed one person',
        value: fmt(d.decided.filter((p) => p.verdict === 'same').length),
        sub: 'folded on every driver page' },
      { key: 'sp-diff', label: 'Ruled two people',
        value: fmt(d.decided.filter((p) => p.verdict === 'different').length),
        sub: 'never proposed again' },
    ];
    if (ak) {
      const same = d.decided.filter((p) => p.verdict === 'same');
      /* EACH RECORD ONCE. One record sits in several pairs (a person with
         three spellings is two pairs on one canonical record), and summing
         both sides pair by pair counted it every time — 338,628 over 365
         pairs on production when first drawn that way. */
      const recs = new Map();
      same.forEach((p) => [p.alias, p.canonical].forEach((x) => {
        if (x?.driver_ext_id != null) recs.set(`${x.platform}\u0000${x.driver_ext_id}`, Number(x.trips) || 0);
      }));
      const folded = [...recs.values()].reduce((a, n) => a + n, 0);
      AKB.tilesHost.innerHTML = '';
      glance(AKB.tilesHost, bandTiles([{ ...SP_TILES[0], hero: true }, ...SP_TILES.slice(1),
        { key: 'sp-folded', label: 'Trips on the records they join', value: fmt(folded),
          sub: `across ${countOf(recs.size, 'record')} in the ${countOf(same.length, 'pair')} confirmed one person — each record counted once` }]).tiles);
    } else head.append(kpiRow(SP_TILES));
    if (!ak) {
      head.append(note(d.why));
      head.append(el('p', 'cap', d.refuted_note));
    }
    if (d.hr_note) head.append(el('p', 'cap', d.hr_note));
    /* Every contradiction HR's latest export makes with what is held — some
       concern a link that is not in this queue at all (a phone link, the
       register), so they are listed here as well as on the cards. */
    if ((d.hr_contradictions || []).length) {
      const box = panel('Where HR’s roster contradicts a link already held',
        'Either the link is wrong or HR’s row is — this page cannot say which', 'sp-hr-contra');
      const ul = el('ul', 'sp-facts');
      d.hr_contradictions.forEach((x) => ul.append(el('li', null, esc(x.evidence))));
      box.body.append(ul);
      head.append(box.panel);
    }

    const onDecide = async (p, verdict) => {
      try {
        await api('/api/same-person/decide', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          /* An HR proposal is addressed by its own id; the link table's key
             would name a different record. */
          body: JSON.stringify(p.proposal_id != null
            ? { proposal_id: p.proposal_id, verdict } : { alias_ext_id: p.alias_ext_id, verdict }),
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
    } else if (ak) {
      /* Folded to twelve in the order the API sends them (it carries no
         decision time, so "the most recent" is not a thing this page can
         know), with a filter by verdict; every card still built and still
         answerable behind the fold's exact count. */
      const bar = el('div', 'chips');
      const list = el('div');
      const paint = () => {
        list.innerHTML = '';
        const rows = spFilter === 'all' ? d.decided : d.decided.filter((p) => p.verdict === spFilter);
        const box = el('div');
        rows.forEach((p) => box.append(pairCard(p, onDecide)));
        if (!rows.length) list.append(note('No answered pair carries that verdict.'));
        else foldChildren(list, box, { shown: 12, total: rows.length, noun: 'answered pair', key: 'sp-done' });
        bar.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.v === spFilter));
      };
      [['all', `All ${fmt(d.decided.length)}`], ['same', `One person ${fmt(d.decided.filter((p) => p.verdict === 'same').length)}`],
        ['different', `Two people ${fmt(d.decided.filter((p) => p.verdict === 'different').length)}`]].forEach(([v, label]) => {
        const a = el('a', 'chip', label); a.href = '#same-person'; a.dataset.v = v;
        a.onclick = (e) => { e.preventDefault(); spFilter = v; paint(); };
        bar.append(a);
      });
      done.body.append(bar, list);
      paint();
    } else {
      d.decided.forEach((p) => done.body.append(pairCard(p, onDecide)));
    }
    if (ak) samePersonTail(root, d);
  };

  await draw();
}

/* ── #same-person under the page contract ────────────────────────────────── */
function samePersonTail(root, d) {
  root.querySelectorAll('[data-panel="sp-pairs"], section.absence').forEach((n) => n.remove());
  const p = panel('Which channels the answered pairs sit across', 'One bar per pair of channels', 'sp-pairs');
  root.append(p.panel);
  const by = new Map();
  d.decided.forEach((x) => {
    const k = [sourceLabel(x.canonical?.platform), sourceLabel(x.alias?.platform)].sort().join(' – ');
    by.set(k, (by.get(k) || 0) + 1);
  });
  if (by.size) {
    const box = el('div'); p.body.append(box);
    hbars(box, [...by.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, n })), { signed: false, color: '--mk-fill' });
  } else p.body.append(note('No pair has been answered yet.'));
  const anon = d.decided.filter((x) => !x.decided_by).length;
  const absHost = el('div'); root.append(absHost);
  absenceBand(absHost, [
    { label: 'Who gave each verdict', hl: anon > 0, fig: anon ? `${fmt(anon)} of ${fmt(d.decided.length)}` : null,
      none: d.decided.length ? 'Every one named' : 'None given',
      why: anon ? 'These verdicts carry no reviewer: the product has no sign-in, and the page sends none with the answer.' : d.decided.length ? 'Every verdict names who gave it.' : 'No pair has been answered yet.' },
    { label: 'Why a pair waits for a person', fig: null, none: 'See the note', why: d.why || '' },
    { label: 'A pair ruled two people', fig: null, none: 'See the note', why: d.refuted_note || '' },
  ]);
  pageFoot({ colophon: ['the review queue', `${fmt(d.pending.length)} waiting`] }, root);
}
