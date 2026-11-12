/* Access reviews on the page — the lines a person keeps or takes out.
   ─────────────────────────────────────────────────────────────────────────
   docs/ULM-DESIGN.md §11.3; the server is api/access/reviews.js. A review is
   a CYCLE: it opens (on the schedule once sign-in is required, or by an
   Access admin), lists one line per role given directly and one per person
   in a team that holds a role, and closes after 14 days — every line nobody
   decided then ends 14 days later unless someone attests it first.

   Two pages draw the same cards:
     Set up → Access → Reviews (accessadmin.js) — an Access admin or the
       Owner, every line;
     Your account (account.js) — a team lead, the people in their team.
   A card is one team's lines, or the roles given directly, within one
   review. Each line the reader may decide has Keep / Take out; a line they
   may not says the server's reason instead (their own access, an Owner's,
   someone else's team). "Attest" sends the card's choices at once; the
   server judges each line on its own and the answer says line by line what
   happened — a refusal is written beside the button in the server's words. */
import { esc, dtStr, dateStr, panel } from './ui.js';
import { who, getJson, post } from './access.js';
import { h, msgLine, act, roleName, fleetsText, plural } from './account.js';

export const KIND_WORD = Object.freeze({ quarterly: 'quarterly review', monthly: 'monthly review of sensitive access', adhoc: 'extra review' });
const cycleTitle = (c) => `${c?.period || ''} ${KIND_WORD[c?.kind] || 'review'}`.trim();

/* The cards for `items` (one review's lines, as GET /api/access/reviews
   lists them), grouped by team; direct grants first. */
export function reviewCards(items, { cycle, fleets = [], say = () => {}, reload = async () => {} } = {}) {
  const groups = new Map();
  for (const it of items) {
    const k = it.kind === 'membership' ? `team:${it.team_id}` : 'direct';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'direct' ? -1 : b === 'direct' ? 1 : a.localeCompare(b)));
  return order.map((k) => card(groups.get(k), { cycle, fleets, say, reload, direct: k === 'direct' }));
}

function card(lines, { cycle, fleets, say, reload, direct }) {
  const title = direct ? 'Roles given directly' : `Team ${lines[0].team_name || `#${lines[0].team_id}`}`;
  const ending = lines.some((l) => l.state === 'unattested');
  const c = h('div', { class: 'acx-card', dataset: { review: String(cycle?.id ?? lines[0].cycle_id), reviewGroup: direct ? 'direct' : `team-${lines[0].team_id}` } },
    h('p', { class: 'acx-p', html: `<b>${esc(title)}</b> · ${esc(cycleTitle(cycle))}`
      + (cycle && !cycle.closed_at ? ` · due ${esc(dateStr(cycle.due_at))}${cycle.overdue ? ' <span class="pill bad">overdue</span>' : ''}` : '')
      + (ending ? ' · <span class="pill warn">not attested — ending</span>' : '') }));
  if (!direct) {
    c.append(h('p', { class: 'acx-p acx-dim' }, `Taking someone out of the team takes away its ${plural((lines[0].roles || []).length, 'role', 'roles')} `
      + `(${(lines[0].roles || []).map(roleName).join(', ')}) from them only.`));
  }
  const choices = [];
  for (const l of lines) {
    const what = direct ? `${l.roles.map(roleName).join(', ')} · ${fleetsText(l.fleets, fleets)}` : '';
    const who = h('span', { class: 'acx-rv-who' }, l.user_name || l.user_email,
      h('span', { class: 'dim' }, `${what ? ` · ${what}` : ''}${l.user_status !== 'active' ? ` · ${l.user_status}` : ''}`),
      l.state === 'unattested' && l.expires_at ? h('span', { class: 'acx-sub' }, `Ends ${dtStr(l.expires_at)} unless attested.`) : null);
    const row = h('div', { class: 'acx-rv', dataset: { line: String(l.id) } }, who);
    if (l.canDecide) {
      const name = `acx-rl-${l.id}`;
      const keep = h('input', { type: 'radio', name, value: 'keep', checked: true });
      const drop = h('input', { type: 'radio', name, value: 'remove' });
      row.append(h('label', { class: 'acx-check' }, keep, 'Keep'), h('label', { class: 'acx-check' }, drop, direct ? 'Revoke' : 'Take out'));
      choices.push({ l, keep });
    } else {
      row.append(h('span', { class: 'acx-sub' }, l.why || 'Not yours to decide.'));
    }
    c.append(row);
  }
  if (!choices.length) return c;
  const why = h('input', { class: 'depinput acx-in', 'data-acx': 'review-reason', placeholder: 'Why, for anyone taken out (optional)' });
  const msg = msgLine();
  const btn = h('button', { type: 'button', class: 'btn primary', 'data-acx': 'attest' }, direct ? 'Attest these' : 'Attest this team');
  btn.addEventListener('click', async () => {
    const reason = why.value.trim();
    const decisions = choices.map(({ l, keep }) => ({ item: l.id, keep: keep.checked, ...(keep.checked || !reason ? {} : { reason }) }));
    const r = await act(btn, msg, () => post(`/api/access/reviews/${cycle?.id ?? lines[0].cycle_id}/attest`, { decisions }));
    if (!r) return;
    const refused = (r.results || []).filter((x) => !x.ok);
    say(`${title} attested for ${cycle?.period || 'this review'}: `
      + `${r.revoked ? `${plural(r.revoked, 'line', 'lines')} taken out` : 'everyone kept'}`
      + `${r.gone ? `; ${plural(r.gone, 'line', 'lines')} had already ended` : ''}`
      + `${refused.length ? `; ${plural(refused.length, 'line was', 'lines were')} refused — ${refused[0].detail}` : ''}.`,
    refused.length ? 'warn' : 'ok');
    await reload();
  });
  c.append(h('div', { class: 'acx-actions' }, why, btn, msg));
  return c;
}

/* Your account: the lines waiting for this person as a team's lead. An
   Access admin or the Owner decides on Set up → Access → Reviews, which
   lists every line; this panel is for a lead who manages no access, and is
   drawn only when something waits for them. */
export async function waitingPanel(host) {
  host.innerHTML = '';
  const caps = who.access?.caps || [];
  if (!who.signedIn || who.kind !== 'user' || caps.includes('access.manage') || !(who.teams || []).some((t) => t.lead)) return;
  let d;
  try { d = await getJson('/api/access/reviews'); } catch { return; }
  const items = (d.items || []).filter((i) => i.canDecide);
  if (!items.length) return;
  const p = panel('Access reviews waiting for you',
    'You lead a team, so you attest who in it keeps the team’s roles. Anything nobody attests ends 14 days after the review closes.',
    'acct-reviews');
  const msg = msgLine();
  const say = (text, tone = 'ok') => msg.set(text, tone);
  /* After a decision the panel is drawn again from the server; the answer
     stays on screen even when nothing is left waiting. */
  const reload = async () => {
    const said = msg.textContent;
    await waitingPanel(host);
    const m = host.querySelector('.acx-msg');
    if (m?.set) m.set(said);
    else if (said) host.append(h('p', { class: 'acx-msg ok', role: 'status' }, said));
  };
  for (const c of d.cycles || []) {
    const mine = items.filter((i) => i.cycle_id === c.id);
    for (const card of reviewCards(mine, { cycle: c, say, reload })) p.body.append(card);
  }
  p.body.append(msg);
  host.append(p.panel);
}
