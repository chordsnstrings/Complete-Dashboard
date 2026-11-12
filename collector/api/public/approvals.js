/* Approvals: changes one person prepared and a second must commit.
   ─────────────────────────────────────────────────────────────────────────
   Four-eyes (collector/docs/ULM-DESIGN.md §8). A signed-in person who commits
   an imported cash sheet, or merges two people, does not change anything:
   the server stores exactly what they sent and answers "awaiting". Someone
   else who may commit it opens this page, reads what is stored, and commits
   THAT — by its number, never by re-sending rows a second time. The preparer
   can withdraw it; a committer can decline it, saying why. */
import { getJson, post, who, closedBlock } from './access.js';
import { esc, el, panel, contract, glance, glanceBand, absenceBand, pageFoot } from './ui.js';
import { fmt } from './charts.js';
import { TZ } from './tz.js';

const when = (v) => (v ? new Date(v).toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) : '—');

function detail(p) {
  const b = p.payload || {};
  if (p.view === 'rows') {
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const cols = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r || {})))].slice(0, 8);
    return `<p>${rows.length} row(s), batch <code>${esc(b.batch || '—')}</code>.</p>
      <div class="ap-scroll"><table class="ap-rows"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.slice(0, 200).map((r) => `<tr>${cols.map((c) => `<td>${esc(r?.[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${rows.length > 200 ? `<p class="ac-msg">Showing the first 200 of ${rows.length}.</p>` : ''}`;
  }
  if (p.view === 'merge') {
    return `<p>Keep person <b>${esc(b.keep)}</b>, fold person <b>${esc(b.drop)}</b> into them. Reason given: ${esc(b.why || '—')}.</p>
      <p><a href="#driver/p${esc(b.keep)}">Open the person kept</a> · <a href="#driver/p${esc(b.drop)}">Open the person folded in</a></p>`;
  }
  return `<pre>${esc(JSON.stringify(b, null, 2).slice(0, 4000))}</pre>`;
}

export async function approvalsPage(root) {
  const host = document.createElement('div');
  host.className = 'ap-page';
  root.append(host);
  const draw = async () => {
    let data;
    try { data = await getJson('/api/access/proposals'); } catch (e) {
      /* Refused (a screen, or a role with no four-eyes action) is an answer
         with a reason, not a failure. */
      if (e.status === 403) { host.replaceChildren(closedBlock({ view: 'approvals', title: 'This is not shown to your role', detail: e.message })); return; }
      host.innerHTML = `<p class="note err">${esc(e.message)}</p>`; return;
    }
    const open = data.proposals.filter((p) => p.status === 'open');
    const done = data.proposals.filter((p) => p.status !== 'open');
    const ak = contract();
    let list, doneBox;
    if (ak) ({ list, doneBox } = contractFrame(host, open, done));
    else {
      host.innerHTML = `
      <p class="ap-lede">Changes one person prepared that a second person must commit. What is committed is exactly what was stored when it was prepared.</p>
      <h3>Waiting (${open.length})</h3>
      ${open.length ? '' : '<p class="ac-msg">Nothing is waiting for a second person.</p>'}
      <div class="ap-list"></div>
      <h3>Decided in the last 30 days (${done.length})</h3>
      <div class="ap-done"></div>`;
      list = host.querySelector('.ap-list');
      doneBox = host.querySelector('.ap-done');
    }
    for (const p of open) {
      const card = document.createElement('section');
      card.className = 'ap-card';
      card.innerHTML = `<h4>${esc(p.summary)}</h4>
        <p class="ac-msg">Prepared by ${esc(p.prepared_name || p.prepared_email)} on ${esc(when(p.prepared_at))}${p.mine ? ' — by you' : ''}.</p>
        ${detail(p)}
        <div class="ac-row">
          ${p.canCommit ? '<button type="button" class="ap-commit">Commit this</button>' : ''}
          <input type="text" class="ap-reason" placeholder="${p.mine ? 'Why withdraw it' : 'Why decline it'}" aria-label="Reason" maxlength="300">
          <button type="button" class="ghost ap-decline">${p.mine ? 'Withdraw' : 'Decline'}</button>
          <span class="ac-msg ap-msg" role="status"></span>
        </div>
        ${!p.canCommit && !p.mine ? '<p class="ac-msg">Your role cannot commit this; someone who can will see it here.</p>' : ''}
        ${p.mine ? '<p class="ac-msg">You prepared this, so someone else must commit it.</p>' : ''}`;
      const msg = card.querySelector('.ap-msg');
      card.querySelector('.ap-commit')?.addEventListener('click', async (e) => {
        e.target.disabled = true;
        try {
          const path = p.kind.split(' ')[1];
          await post(path, { proposal: p.id });
          msg.textContent = 'Committed.';
          setTimeout(draw, 600);
        } catch (err) { msg.textContent = err.message; e.target.disabled = false; }
      });
      card.querySelector('.ap-decline').addEventListener('click', async () => {
        try {
          await post(`/api/access/proposals/${p.id}/decline`, { reason: card.querySelector('.ap-reason').value });
          draw();
        } catch (err) { msg.textContent = err.message; }
      });
      list.append(card);
    }
    doneBox.innerHTML = done.length ? `<table class="ap-rows"><thead><tr><th>What</th><th>Prepared</th><th>Outcome</th><th>By</th></tr></thead><tbody>
      ${done.map((p) => `<tr><td>${esc(p.summary)}</td><td>${esc(when(p.prepared_at))}</td><td>${esc(p.status)}</td><td>${esc(p.decided_email || '—')}</td></tr>`).join('')}</tbody></table>`
      : '<p class="ac-msg">None.</p>';
    if (ak) contractTail(host, data.proposals, open, done);
  };
  await draw();
  return { title: 'Approvals', sub: who.signedIn ? 'Changes waiting for a second person' : '' };
}

/* ── the page contract (HANDOFF §4.5) ─────────────────────────────────────
   #approvals made no contract() call: under Arkiv it drew two bare <h3>s
   carrying their counts in brackets, no 00 band, no †, no colophon. Under
   the contract the counts lead as 00 (what is waiting the hero — the one
   question this page answers), the two lists become numbered sections
   (panel(); arkiv.css numbers them), and † says what the server does not
   send. Every figure is a count of what /api/access/proposals returned —
   nothing is derived. The old skin draws exactly what it drew before. */
function contractFrame(host, open, done) {
  host.replaceChildren();
  const yours = open.filter((p) => p.canCommit).length;
  const mine = open.filter((p) => p.mine).length;
  const by = (s) => done.filter((p) => p.status === s).length;
  const withdrawn = done.filter((p) => p.status === 'declined' && p.result?.withdrawn).length;
  const declined = by('declined') - withdrawn;
  glance(glanceBand(host, 'Counted in what the server lists for your role').tilesHost, [
    { label: 'Waiting for a second person', value: fmt(open.length), hero: true,
      sub: 'prepared by one person; nothing changes until a second commits it' },
    { label: 'Yours to commit', value: fmt(yours), sub: 'your role may commit these, and you did not prepare them' },
    { label: 'Prepared by you', value: fmt(mine), sub: 'someone else must commit them' },
    { label: 'Decided in the last 30 days', value: fmt(done.length),
      sub: [`${fmt(by('committed'))} committed`, `${fmt(declined)} declined`, `${fmt(withdrawn)} withdrawn`,
        by('failed') ? `${fmt(by('failed'))} failed on commit` : null].filter(Boolean).join(' · ') },
  ]);
  const w = panel('Waiting for a second person', 'What is committed is exactly what was stored when it was prepared — by its number, never by sending the rows again.', 'ap-waiting');
  if (!open.length) w.body.append(el('p', 'ac-msg', 'Nothing is waiting for a second person.'));
  const list = el('div', 'ap-list');
  w.body.append(list);
  const d = panel('Decided in the last 30 days', null, 'ap-decided');
  const doneBox = el('div', 'ap-done');
  d.body.append(doneBox);
  host.append(w.panel, d.panel);
  return { list, doneBox };
}
function contractTail(host, all, open, done) {
  const absHost = el('div');
  host.append(absHost);
  absenceBand(absHost, [
    /* The server cuts its list at the newest 200 BEFORE it keeps the ones
       this reader's role may see (api/access/routes.js /api/access/proposals:
       LIMIT 200, then proposalVisible), so a reader who sees fewer than 200
       cannot tell whether the cut was reached. The first draft said the cap
       only when this reader saw 200, and otherwise described the list as
       complete — a claim the page cannot make (the ARK review, 2026-11-12).
       The cap is stated always; that it WAS reached, only when it shows. */
    { label: 'Decided more than 30 days ago', fig: null, none: 'Not listed',
      why: `The server lists what is still open and what was prepared in the last 30 days — at most the newest 200, counted before your role’s share is kept${
        all.length >= 200 ? ', and this list reached that limit' : ''}. Older decisions are in the audit log (Access → Audit).` },
    { label: 'Proposals your role may not see', fig: null, none: 'Not counted',
      why: 'The server sends each reader only the proposals their role may see, and does not say how many others there are.' },
  ]);
  pageFoot({ colophon: ['Four-eyes changes', `${fmt(open.length)} waiting`, `${fmt(done.length)} decided in 30 days`] }, host);
}
