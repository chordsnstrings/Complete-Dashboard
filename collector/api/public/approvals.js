/* Approvals: changes one person prepared and a second must commit.
   ─────────────────────────────────────────────────────────────────────────
   Four-eyes (collector/docs/ULM-DESIGN.md §8). A signed-in person who commits
   an imported cash sheet, or merges two people, does not change anything:
   the server stores exactly what they sent and answers "awaiting". Someone
   else who may commit it opens this page, reads what is stored, and commits
   THAT — by its number, never by re-sending rows a second time. The preparer
   can withdraw it; a committer can decline it, saying why. */
import { getJson, post, who } from './access.js';
import { esc } from './ui.js';

const when = (v) => (v ? new Date(v).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'medium', timeStyle: 'short' }) : '—');

function detail(p) {
  const b = p.payload || {};
  if (p.kind === 'POST /api/ledger/import/commit') {
    const rows = Array.isArray(b.rows) ? b.rows : [];
    const cols = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r || {})))].slice(0, 8);
    return `<p>${rows.length} row(s), batch <code>${esc(b.batch || '—')}</code>.</p>
      <div class="ap-scroll"><table class="ap-rows"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.slice(0, 200).map((r) => `<tr>${cols.map((c) => `<td>${esc(r?.[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      ${rows.length > 200 ? `<p class="ac-msg">Showing the first 200 of ${rows.length}.</p>` : ''}`;
  }
  if (p.kind === 'POST /api/person/merge') {
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
      host.innerHTML = `<p class="note err">${esc(e.message)}</p>`; return;
    }
    const open = data.proposals.filter((p) => p.status === 'open');
    const done = data.proposals.filter((p) => p.status !== 'open');
    host.innerHTML = `
      <p class="ap-lede">Changes one person prepared that a second person must commit. What is committed is exactly what was stored when it was prepared.</p>
      <h3>Waiting (${open.length})</h3>
      ${open.length ? '' : '<p class="ac-msg">Nothing is waiting for a second person.</p>'}
      <div class="ap-list"></div>
      <h3>Decided in the last 30 days (${done.length})</h3>
      <div class="ap-done"></div>`;
    const list = host.querySelector('.ap-list');
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
    host.querySelector('.ap-done').innerHTML = done.length ? `<table class="ap-rows"><thead><tr><th>What</th><th>Prepared</th><th>Outcome</th><th>By</th></tr></thead><tbody>
      ${done.map((p) => `<tr><td>${esc(p.summary)}</td><td>${esc(when(p.prepared_at))}</td><td>${esc(p.status)}</td><td>${esc(p.decided_email || '—')}</td></tr>`).join('')}</tbody></table>`
      : '<p class="ac-msg">None.</p>';
  };
  await draw();
  return { title: 'Approvals', sub: who.signedIn ? 'Changes waiting for a second person' : '' };
}
