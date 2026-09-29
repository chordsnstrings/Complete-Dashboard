/* SET UP → ACCESS — #access[/<tab>[/<id>]]. Who has an account, what each
   of them may see and do, and the company's own sign-in settings.
   ─────────────────────────────────────────────────────────────────────────
   collector/docs/ULM-DESIGN.md §10.4 is the screen; §6.4 (the ceiling, the
   second Owner), §11.2 (a user's lifecycle), §11.3 (reviews) and §12 (the
   audit log) are the rules it draws. The rules are ENFORCED in
   api/access/routes.js and nowhere else: this page offers a change and shows
   whatever the server answers, in its own words, beside the button that was
   pressed. So a manager who is not an Owner sees the Approve button on a
   pending grant replaced by the sentence saying only an Owner approves — and
   if the page ever got that wrong, the server's refusal would say so in the
   same place. Nothing here is a second copy of a rule that can drift.

   ── SUB-PAGES ARE ADDRESSES, NOT MODALS ──────────────────────────────────
   #access (people), #access/person/<id>, #access/teams, #access/roles,
   #access/requests, #access/approvals, #access/reviews, #access/screens,
   #access/audit, #access/settings. Each can be linked to, reloaded and sent
   to a colleague ("the request on #access/requests"), which a dialog cannot.
   Everything is read from GET /api/access/overview (one request, no cache —
   access.js getJson, never data.js's stale-while-revalidate, because these
   answers are about people and must not outlive the session that read them)
   plus the three lists that have their own routes: reviews, the audit log,
   and requests already decided.

   ── ONE-TIME LINKS ───────────────────────────────────────────────────────
   An invitation, a reset and a screen link are shown ONCE: the server keeps
   only a hash of the token, so the page that receives it is the only place it
   will ever be readable. It is printed as a full address with a copy button,
   at the top of the tab (and scrolled to), and it survives the tab redrawing
   itself after the change — it is lost only when the reader leaves or makes
   another change, and the box says so.

   ── EMPTY IS A SENTENCE ──────────────────────────────────────────────────
   Every list that can be empty says what would appear in it and how it gets
   there. "No requests" alone reads the same as "requests are broken". */
import { el, esc, panel, note, tableFrom, tabBar, dtStr, dateStr, kpiRow } from './ui.js';
import { who, loadWho, getJson, post, closedBlock, toSignIn } from './access.js';
import { dubaiDay } from './tz.js';
import { ROLE, CLASS, CLASSES, CAPS, CAP, LEVEL_NAME, rank, roleIsSensitive } from './access_model.js';
import {
  h, field, msgLine, act, oneTimeLink, roleSelect, fleetPicker, endOfDay, roleName, rememberRoles,
  fleetsText, plural, requestWhat, uid, explain,
} from './account.js';

const TABS = [
  { id: 'people', label: 'People', sub: 'Everyone with an account: their roles, fleets, teams and sign-in' },
  { id: 'teams', label: 'Teams', sub: 'Named groups whose members all hold the team’s roles' },
  { id: 'roles', label: 'Roles', sub: 'What each role sees, class by class, and what it can do' },
  { id: 'requests', label: 'Requests', sub: 'Access people asked for from a page that was not open to them' },
  { id: 'approvals', label: 'Approvals', sub: 'Sensitive grants waiting for an Owner' },
  { id: 'reviews', label: 'Reviews', sub: 'Each quarter, every team’s access kept or removed person by person' },
  { id: 'screens', label: 'Screens', sub: 'Wall displays: signed in with a screen link, no person behind them' },
  { id: 'audit', label: 'Audit', sub: 'Who did what, when — append-only, each entry chained to the one before' },
  { id: 'settings', label: 'Settings', sub: 'Whether sign-in is required, and the company-wide sign-in rules' },
];
const TAB = Object.fromEntries(TABS.map((t) => [t.id, t]));

const STATUS = {
  active: ['active', 'ok'], invited: ['invited', 'warn'],
  suspended: ['suspended', 'bad'], offboarded: ['offboarded', 'dim'],
};

/* ═════════════════════════ the page ═════════════════════════ */

export async function accessPage(root, param, sub) {
  root.innerHTML = '';
  root.classList.add('acx-page');
  await loadWho();
  const title = { title: 'Access', sub: 'Who can sign in, and what each person may see and do' };

  if (!who.signedIn || who.kind !== 'user') {
    root.append(closedBlock({ title: 'Sign in to manage access',
      detail: who.mode === 'enforced'
        ? 'Managing access needs an account. Sign in as the Owner or an Access admin.'
        : 'Sign-in is optional for now, so every other page opens without an account — but deciding who may see what is done by a named, signed-in Owner or Access admin, so that every change carries their name.' }));
    root.append(h('div', { class: 'acx-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => toSignIn() }, 'Sign in')));
    return title;
  }
  if (who.preview) {
    root.append(closedBlock({ title: 'Access cannot be changed while you preview a role',
      detail: `You are previewing the ${roleName(who.preview)} role, which is read-only — and a ${roleName(who.preview)} does not manage access. End the preview on your account page to come back here as yourself.` }));
    root.append(h('p', { class: 'acx-p' }, h('a', { href: '#account' }, 'Your account → End the preview')));
    return title;
  }
  if (!(who.access?.caps || []).includes('access.manage')) {
    root.append(closedBlock({ view: 'access', title: 'Access is managed by the Owner and Access admins',
      detail: 'Your role does not include inviting people or changing what they can see. If you need to, ask for it below — the Owner or an Access admin decides.' }));
    return title;
  }

  const tabId = param === 'person' ? 'people' : (TAB[param] ? param : 'people');
  const bar = h('div');
  const flash = h('div', { class: 'acx-flash', 'data-acx': 'flash' });
  const host = h('div', { class: 'acx-tab', 'data-acx-tab': param === 'person' ? 'person' : tabId });
  root.append(bar, flash, host);

  const ctx = { flash, host, sub, param };
  /* What a change reports is painted once the tab has been redrawn from the
     server's answer, never before: a "revoked" line above a table still
     listing the grant would be the page contradicting itself. A change calls
     say() and then reload(); reload() is already running when the queued
     paint comes due, so it waits for the redraw and is painted at its end. */
  let pending = null; let reloading = false;
  const paint = () => { if (pending) { flash.replaceChildren(note(...pending)); pending = null; } };
  ctx.say = (text, tone = 'ok') => { pending = [text, tone]; queueMicrotask(() => { if (!reloading) paint(); }); };
  ctx.showLink = (box) => { flash.replaceChildren(box); box.scrollIntoView?.({ block: 'center' }); };
  ctx.reload = async () => {
    reloading = true;
    try {
      try { build(ctx, await getJson('/api/access/overview')); } catch (e) {
        host.replaceChildren(note(`The access lists could not be read: ${e.message}`, 'err'));
        return;
      }
      bar.replaceChildren(tabBar(TABS.map((t) => ({ ...t, label: tabLabel(t, ctx) })), tabId,
        (id) => (id === 'people' ? '#access' : `#access/${id}`)));
      host.replaceChildren();
      await (param === 'person' ? personTab : RENDER[tabId])(host, ctx);
    } finally {
      reloading = false;
      paint();
    }
  };
  await ctx.reload();
  if (param === 'person') {
    const u = ctx.byId?.get(Number(sub));
    return { title: u ? (u.name || u.email) : 'Access', sub: u ? `${u.email} — their access, teams and sign-in` : 'No such person' };
  }
  return { title: 'Access', sub: TAB[tabId].sub };
}

function tabLabel(t, ctx) {
  const n = t.id === 'requests' ? ctx.requests.length
    : t.id === 'approvals' ? ctx.grants.filter((g) => g.status === 'pending').length : 0;
  return n ? `${t.label} · ${n}` : t.label;
}

/* Everything the tabs look things up by, from one overview answer. */
function build(ctx, ov) {
  rememberRoles(ov.roles || []);
  Object.assign(ctx, {
    ov, me: ov.me || {}, owner: Boolean(ov.me?.owner), users: ov.users || [], teams: ov.teams || [],
    grants: ov.grants || [], requests: ov.requests || [], devices: ov.devices || [], fleets: ov.fleets || [],
    roles: ov.roles || [], config: ov.config || {}, owners: ov.owners || [],
  });
  ctx.byId = new Map(ctx.users.map((u) => [u.id, u]));
  ctx.teamById = new Map(ctx.teams.map((t) => [t.id, t]));
  ctx.roleBy = new Map(ctx.roles.map((r) => [r.code, r]));
  ctx.nameOf = (id) => { const u = ctx.byId.get(Number(id)); return u ? (u.name || u.email) : (id == null ? 'the system' : `person #${id}`); };
  ctx.personLink = (id) => {
    const u = ctx.byId.get(Number(id));
    return u ? `<a href="#access/person/${u.id}">${esc(u.name || u.email)}</a>` : esc(ctx.nameOf(id));
  };
  ctx.directGrants = (uid) => ctx.grants.filter((g) => g.user_id === uid);
  ctx.teamsOf = (uid) => ctx.teams.filter((t) => t.members.includes(uid));
  ctx.teamGrants = (tid) => ctx.grants.filter((g) => g.team_id === tid);
}

const RENDER = {
  people: peopleTab, teams: teamsTab, roles: rolesTab, requests: requestsTab, approvals: approvalsTab,
  reviews: reviewsTab, screens: screensTab, audit: auditTab, settings: settingsTab,
};

/* ── shared pieces ────────────────────────────────────────────────────── */
function grantText(g, ctx) {
  const bits = [roleName(g.role_code), fleetsText(g.fleets, ctx.fleets), g.expires_at ? `until ${dateStr(g.expires_at)}` : 'no end date'];
  if (g.status === 'pending') bits.push('waiting for an Owner’s approval');
  else if (g.effective_at && new Date(g.effective_at).getTime() > Date.now()) bits.push(`takes effect ${dtStr(g.effective_at)}`);
  return bits.join(' · ');
}
const statusPill = (u) => {
  const [t, tone] = STATUS[u.status] || [u.status, 'dim'];
  return `<span class="pill ${tone}">${esc(t)}</span>`;
};
const empty = (text) => el('p', 'acx-p acx-empty', esc(text));

/* A reason, asked for in place before a change that ends something. */
function askReason(host, { prompt, confirm, onConfirm, danger = false }) {
  host.replaceChildren();
  const input = h('input', { class: 'depinput acx-in', required: true, minLength: 3, 'data-acx': 'reason' });
  const msg = msgLine();
  const go = h('button', { type: 'submit', class: `btn${danger ? ' primary' : ''}`, 'data-acx': 'confirm' }, confirm);
  const form = h('form', { class: 'acx-form acx-ask' }, field(prompt, input),
    h('div', { class: 'acx-actions' }, go, h('button', { type: 'button', class: 'btn', onclick: () => host.replaceChildren() }, 'Cancel'), msg));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (input.value.trim().length < 3) { msg.set('Say briefly why — it is kept in the audit log.', 'bad'); return; }
    await act(go, msg, () => onConfirm(input.value.trim()));
  });
  host.append(form);
  input.focus?.();
}

/* A role, its fleets and an optional end date — the three things every grant
   carries — plus a line saying what the chosen role is and, where it is one,
   that it is sensitive (§6.4: it may wait for a second Owner). */
function grantFields(ctx, { selected = '', mark = null } = {}) {
  const role = roleSelect(ctx.roles, { selected, mark });
  const about = h('p', { class: 'depnote' });
  const fleets = fleetPicker(ctx.fleets);
  const ends = h('input', { type: 'date', class: 'depinput acx-in', min: dubaiDay() });
  const explainRole = () => {
    const r = ctx.roleBy.get(role.value);
    if (!r) { about.textContent = ''; return; }
    const bits = [r.desc || ''];
    if (roleIsSensitive(r)) bits.push('Sensitive: giving it can need a second Owner’s approval before it takes effect.');
    if (r.timeboxed) bits.push('This role must have an end date.');
    about.textContent = bits.filter(Boolean).join(' ');
  };
  role.addEventListener('change', explainRole);
  explainRole();
  const node = h('div', { class: 'acx-grant' },
    field('Role', role, about), fleets.node,
    field('Ends (optional)', ends, 'Access stops at the end of this day, Dubai time. Leave it empty for no end date.'));
  return {
    node, role,
    value() {
      const r = ctx.roleBy.get(role.value);
      if (!r) return { error: 'Choose a role.' };
      const f = fleets.value();
      if (f && !f.length) return { error: `Tick at least one fleet for ${r.name}, or choose every fleet.` };
      if (r.timeboxed && !ends.value) return { error: `${r.name} must have an end date.` };
      return { role: r.code, fleets: f, expires_at: endOfDay(ends.value) };
    },
  };
}

/* One click arms a button and a second one within a few seconds fires it —
   for the changes that end something for somebody else. */
function armed(label, sure, onFire) {
  const b = h('button', { type: 'button', class: 'btn' }, label);
  let armedAt = 0;
  b.addEventListener('click', () => {
    if (Date.now() - armedAt < 6000) { armedAt = 0; b.textContent = label; b.classList.remove('primary'); onFire(b); return; }
    armedAt = Date.now();
    b.textContent = sure;
    b.classList.add('primary');
    setTimeout(() => { if (armedAt && Date.now() - armedAt >= 6000) { armedAt = 0; b.textContent = label; b.classList.remove('primary'); } }, 6100);
  });
  return b;
}

/* ═════════════════════════ People ═════════════════════════ */
function peopleTab(host, ctx) {
  const users = ctx.users;
  const n = (s) => users.filter((u) => u.status === s).length;
  const active = users.filter((u) => u.status === 'active');
  host.append(kpiRow([
    { key: 'acx-people', label: 'People', value: String(users.length), sub: 'with an account, ever' },
    { key: 'acx-active', label: 'Can sign in', value: String(active.length), sub: 'active accounts' },
    { key: 'acx-invited', label: 'Invited', value: String(n('invited')), sub: 'have not used their link yet' },
    { key: 'acx-suspended', label: 'Suspended', value: String(n('suspended')), sub: 'cannot sign in' },
    { key: 'acx-mfa', label: 'Two-step on', value: `${active.filter((u) => u.totp_enabled).length} of ${active.length}`, sub: 'of the active accounts' },
  ]));

  const p = panel('Everyone with an account', 'Click a name to change their roles, teams or sign-in.', 'acx-people');
  const q = h('input', { type: 'search', class: 'depinput acx-in', placeholder: 'Name or email', 'data-acx': 'people-search' });
  const st = h('select', { class: 'depinput acx-in' },
    h('option', { value: 'current' }, 'Not offboarded'), h('option', { value: 'all' }, 'Everyone'),
    Object.keys(STATUS).map((s) => h('option', { value: s }, `Only ${s}`)));
  const rl = h('select', { class: 'depinput acx-in' }, h('option', { value: '' }, 'Any role'),
    ctx.roles.filter((r) => !r.device).map((r) => h('option', { value: r.code }, r.name)));
  const tableHost = h('div');
  p.body.append(h('div', { class: 'acx-filters' }, field('Find', q), field('Status', st), field('Role', rl)), tableHost);
  const draw = () => {
    const needle = q.value.trim().toLowerCase();
    const rows = users.filter((u) => (st.value === 'all' ? true : st.value === 'current' ? u.status !== 'offboarded' : u.status === st.value))
      .filter((u) => !needle || `${u.name} ${u.email}`.toLowerCase().includes(needle))
      .filter((u) => !rl.value || ctx.directGrants(u.id).some((g) => g.role_code === rl.value)
        || ctx.teamsOf(u.id).some((t) => ctx.teamGrants(t.id).some((g) => g.role_code === rl.value)));
    tableHost.replaceChildren();
    if (!rows.length) {
      tableHost.append(empty(users.length ? 'Nobody matches these filters.'
        : 'Nobody has an account yet. Invite the first person below.'));
      return;
    }
    tableHost.append(tableFrom(rows, [
      { label: 'Person', key: 'name', sortValue: (u) => (u.name || u.email).toLowerCase(),
        render: (u) => `${ctx.personLink(u.id)}<div class="acx-sub">${esc(u.email)}</div>` },
      { label: 'Status', key: 'status', render: (u) => `${statusPill(u)}${ctx.owners.includes(u.id) ? ' <span class="pill">Owner</span>' : ''}`
        + (u.locked_until && new Date(u.locked_until) > new Date() ? `<div class="acx-sub">locked until ${esc(dtStr(u.locked_until))}</div>` : '')
        + (u.suspended_reason && u.status !== 'active' ? `<div class="acx-sub">${esc(u.suspended_reason)}</div>` : '') },
      { label: 'Roles', key: 'roles', sortValue: (u) => ctx.directGrants(u.id).length, render: (u) => {
        const own = ctx.directGrants(u.id).map((g) => `<div>${esc(grantText(g, ctx))}</div>`);
        const viaTeams = ctx.teamsOf(u.id).flatMap((t) => ctx.teamGrants(t.id)
          .map((g) => `<div>${esc(grantText(g, ctx))} <span class="dim">· through ${esc(t.name)}</span></div>`));
        return [...own, ...viaTeams].join('') || '<span class="dim">no role — every page is closed to them</span>';
      } },
      { label: 'Teams', key: 'teams', sortValue: (u) => ctx.teamsOf(u.id).length,
        render: (u) => esc(ctx.teamsOf(u.id).map((t) => t.name).join(', ')) || '<span class="dim">none</span>' },
      { label: 'Last sign-in', key: 'last_login_at', sortValue: (u) => (u.last_login_at ? Date.parse(u.last_login_at) : null),
        render: (u) => (u.last_login_at ? esc(dtStr(u.last_login_at)) : '<span class="dim">never</span>') },
      { label: 'Two-step', key: 'totp_enabled', sortValue: (u) => (u.totp_enabled ? 1 : 0),
        render: (u) => (u.totp_enabled ? '<span class="pill ok">on</span>' : '<span class="pill dim">off</span>') },
    ], { sortable: true, sortId: 'acx-people', defaultSort: { key: 'name', dir: 'asc' }, cards: true, cardLead: 'name' }));
  };
  [q, st, rl].forEach((c) => c.addEventListener(c === q ? 'input' : 'change', draw));
  draw();
  host.append(p.panel, invitePanel(ctx));
}

function invitePanel(ctx) {
  const p = panel('Invite a person', 'They get a one-time link to choose their own password. Nothing is emailed from here: '
    + 'you send the link to them yourself.', 'acx-invite');
  const email = h('input', { type: 'email', class: 'depinput acx-in', required: true, autocomplete: 'off', 'data-acx': 'invite-email' });
  const name = h('input', { class: 'depinput acx-in', autocomplete: 'off', 'data-acx': 'invite-name' });
  const rows = h('div', { class: 'acx-grants' });
  const grants = [];
  const addRow = () => {
    const g = grantFields(ctx);
    const box = h('div', { class: 'acx-grant-row' }, g.node);
    const drop = h('button', { type: 'button', class: 'btn acx-drop' }, 'Remove this role');
    drop.addEventListener('click', () => { grants.splice(grants.indexOf(g), 1); box.remove(); });
    box.append(drop);
    grants.push(g);
    rows.append(box);
  };
  addRow();
  const teamBoxes = ctx.teams.map((t) => h('input', { type: 'checkbox', value: String(t.id), id: uid() }));
  const teams = ctx.teams.length
    ? h('fieldset', { class: 'acx-fleets' }, h('legend', { class: 'deplabel' }, 'Teams'),
      ctx.teams.map((t, i) => h('label', { class: 'acx-check', for: teamBoxes[i].id }, teamBoxes[i], t.name)))
    : h('p', { class: 'depnote' }, 'No teams yet — a team gives all its members the same roles. Make one under Teams.');
  const reason = h('input', { class: 'depinput acx-in', required: true, 'data-acx': 'invite-reason' });
  const msg = msgLine();
  const send = h('button', { type: 'submit', class: 'btn primary', 'data-acx': 'invite-send' }, 'Make the invitation');
  const form = h('form', { class: 'acx-form' },
    field('Email', email),
    field('Name (optional)', name, 'As it should read on every page and in the audit log. They can be renamed later.'),
    h('h4', { class: 'acx-h4' }, 'Roles'), rows,
    h('div', { class: 'acx-actions' }, h('button', { type: 'button', class: 'btn', onclick: addRow }, 'Add another role')),
    teams,
    field('Why they need it', reason, 'Kept with each grant and in the audit log.'),
    h('div', { class: 'acx-actions' }, send, msg));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const picked = [];
    for (const g of grants) {
      const v = g.value();
      if (v.error) { msg.set(v.error, 'bad'); return; }
      picked.push(v);
    }
    const teamIds = teamBoxes.filter((b) => b.checked).map((b) => Number(b.value));
    if (!picked.length && !teamIds.length) {
      msg.set('Give them at least one role or one team — without one they could sign in and see nothing at all.', 'bad');
      return;
    }
    if (reason.value.trim().length < 3) { msg.set('Say briefly why they need it.', 'bad'); return; }
    const r = await act(send, msg, () => post('/api/access/users', {
      email: email.value.trim(), name: name.value.trim(), grants: picked, teams: teamIds, reason: reason.value.trim() }));
    if (!r) return;
    const who2 = name.value.trim() || email.value.trim();
    await ctx.reload();
    ctx.showLink(oneTimeLink({ key: 'invite', heading: `Invitation for ${who2}`, path: r.link, lines: [
      `Send it to them privately — in a message only they will read. It works once, for ${r.expiresInDays || 7} days.`,
      'It is shown only this once: copy it now. If it is lost, open their page and make a new one.',
      ...(r.notes || []),
    ] }));
  });
  p.body.append(form);
  return p.panel;
}

/* ═════════════════════════ One person ═════════════════════════ */
function personTab(host, ctx) {
  const id = Number(ctx.sub);
  const u = ctx.byId.get(id);
  host.append(h('p', { class: 'acx-p' }, h('a', { href: '#access' }, '← Everyone with an account')));
  if (!u) {
    host.append(empty(`There is no person numbered ${ctx.sub || '(none)'} — the link may be from before they were removed. The list above has everyone.`));
    return;
  }
  const self = u.id === ctx.me.id;
  const isOwner = ctx.owners.includes(u.id);

  const who1 = panel(esc(u.name || u.email), null, 'acx-person');
  const dl = h('dl', { class: 'acx-dl' });
  const row = (k, v) => dl.append(h('dt', null, k), h('dd', null, v));
  row('Email', u.email);
  row('Status', h('span', { html: `${statusPill(u)} ${esc({
    active: 'Can sign in.', invited: 'Has not used their invitation yet.',
    suspended: `Cannot sign in${u.suspended_reason ? `: ${u.suspended_reason}` : '.'}`,
    offboarded: `Has left${u.offboarded_at ? ` (${dateStr(u.offboarded_at)})` : ''}; kept so their name stays on what they recorded.`,
  }[u.status] || '')}` }));
  if (isOwner) row('Standing', 'Owner');
  row('Account made', `${dtStr(u.created_at)}${u.created_by ? ` by ${ctx.nameOf(u.created_by)}` : ''}`);
  row('Last sign-in', u.last_login_at ? dtStr(u.last_login_at) : 'Never');
  row('Two-step sign-in', u.totp_enabled ? 'On' : 'Off');
  if (u.failed_logins) row('Wrong passwords', `${u.failed_logins} in a row${u.locked_until && new Date(u.locked_until) > new Date() ? `, locked until ${dtStr(u.locked_until)}` : ''}`);
  who1.body.append(dl);
  host.append(who1.panel);

  /* Their access. */
  const acc = panel('Their roles', 'Given to them directly, or through a team they are in.', 'acx-person-grants');
  const direct = ctx.directGrants(u.id);
  const ask = h('div', { class: 'acx-inline' });
  if (direct.length) {
    acc.body.append(tableFrom(direct, [
      { label: 'Role', key: 'role_code', render: (g) => `<b>${esc(roleName(g.role_code))}</b>` },
      { label: 'Fleets', key: 'fleets', render: (g) => esc(fleetsText(g.fleets, ctx.fleets)) },
      { label: 'Ends', key: 'expires_at', render: (g) => (g.expires_at ? esc(dtStr(g.expires_at)) : '<span class="dim">no end date</span>') },
      { label: 'State', key: 'status', render: (g) => (g.status === 'pending' ? '<span class="pill warn">waiting for an Owner</span>'
        : new Date(g.effective_at) > new Date() ? `<span class="pill warn">from ${esc(dtStr(g.effective_at))}</span>` : '<span class="pill ok">in force</span>') },
      { label: 'Given', key: 'created_at', render: (g) => `${esc(dtStr(g.created_at))}<div class="acx-sub">by ${esc(ctx.nameOf(g.granted_by))}${g.reason ? ` — ${esc(g.reason)}` : ''}</div>` },
      { label: '', key: 'id', render: (g) => `<button type="button" class="btn" data-revoke="${g.id}">${g.status === 'pending' ? 'Withdraw' : 'Revoke'}</button>` },
    ], { compact: true, cards: true, cardLead: 'role_code' }));
  } else {
    acc.body.append(empty('No role given to them directly.'));
  }
  const viaTeams = ctx.teamsOf(u.id).flatMap((t) => ctx.teamGrants(t.id).map((g) => ({ g, t })));
  if (viaTeams.length) {
    acc.body.append(h('h4', { class: 'acx-h4' }, 'Through their teams'),
      h('ul', { class: 'acx-list' }, viaTeams.map(({ g, t }) => h('li', null, grantText(g, ctx), ' · ',
        h('a', { href: '#access/teams' }, t.name)))));
  }
  acc.body.append(ask);
  acc.body.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-revoke]');
    if (!b) return;
    const g = direct.find((x) => x.id === Number(b.dataset.revoke));
    askReason(ask, { prompt: `Why ${g.status === 'pending' ? 'withdraw' : 'revoke'} ${roleName(g.role_code)}?`, confirm: 'Revoke it', danger: true,
      onConfirm: async (reason) => {
        await post(`/api/access/grants/${g.id}/revoke`, { reason });
        ctx.say(`${roleName(g.role_code)} ${g.status === 'pending' ? 'withdrawn' : 'revoked'} for ${u.name || u.email}. It stopped applying at once.`);
        await ctx.reload();
      } });
  });
  host.append(acc.panel);

  /* Give them a role. */
  if (u.status !== 'offboarded') {
    const give = panel('Give them a role', null, 'acx-person-give');
    if (self) {
      give.body.append(empty('You cannot give access to yourself. Another Owner or Access admin can.'));
    } else {
      const g = grantFields(ctx);
      const reason = h('input', { class: 'depinput acx-in', required: true, 'data-acx': 'grant-reason' });
      const msg = msgLine();
      const btn = h('button', { type: 'submit', class: 'btn primary', 'data-acx': 'grant-give' }, 'Give this role');
      const form = h('form', { class: 'acx-form' }, g.node, field('Why', reason, 'Kept with the grant and in the audit log.'),
        h('div', { class: 'acx-actions' }, btn, msg));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = g.value();
        if (v.error) { msg.set(v.error, 'bad'); return; }
        if (reason.value.trim().length < 3) { msg.set('Say briefly why.', 'bad'); return; }
        const r = await act(btn, msg, () => post('/api/access/grants', { userId: u.id, ...v, reason: reason.value.trim() }));
        if (!r) return;
        ctx.say(r.note ? `${roleName(v.role)} given to ${u.name || u.email}. ${r.note}`
          : `${roleName(v.role)} given to ${u.name || u.email}. It applies from their next click.`, r.note ? 'warn' : 'ok');
        await ctx.reload();
      });
      give.body.append(form);
    }
    host.append(give.panel);
  }

  /* Teams. */
  const tp = panel('Their teams', null, 'acx-person-teams');
  const mine = ctx.teamsOf(u.id);
  const tmsg = msgLine();
  if (mine.length) {
    tp.body.append(h('ul', { class: 'acx-list' }, mine.map((t) => {
      const b = h('button', { type: 'button', class: 'btn acx-mini' }, 'Take them out');
      b.addEventListener('click', async () => {
        const r = await act(b, tmsg, () => post(`/api/access/teams/${t.id}`, { member: { userId: u.id, on: false } }));
        if (r) { ctx.say(`${u.name || u.email} taken out of ${t.name}.`); await ctx.reload(); }
      });
      return h('li', null, h('a', { href: '#access/teams' }, t.name), t.lead_user_id === u.id ? h('span', { class: 'dim' }, ' · leads it') : null, ' ', b);
    })));
  } else {
    tp.body.append(empty('In no team.'));
  }
  const others = ctx.teams.filter((t) => !t.members.includes(u.id));
  if (others.length && u.status !== 'offboarded' && !self) {
    const sel = h('select', { class: 'depinput acx-in' }, others.map((t) => h('option', { value: String(t.id) }, t.name)));
    const b = h('button', { type: 'button', class: 'btn' }, 'Add them');
    b.addEventListener('click', async () => {
      const t = ctx.teamById.get(Number(sel.value));
      const r = await act(b, tmsg, () => post(`/api/access/teams/${t.id}`, { member: { userId: u.id, on: true } }));
      if (r) { ctx.say(`${u.name || u.email} added to ${t.name}; they hold its roles from their next click.`); await ctx.reload(); }
    });
    tp.body.append(h('div', { class: 'acx-inrow' }, field('Add to a team', sel), b));
  }
  tp.body.append(tmsg);
  host.append(tp.panel);

  host.append(actionsPanel(u, ctx, { self, isOwner }));
}

/* Each action with the sentence that says what it does, BEFORE the button:
   the reader should never learn what "reset" meant by pressing it. */
function actionsPanel(u, ctx, { self, isOwner }) {
  const p = panel('Their account', null, 'acx-person-actions');
  const who2 = u.name || u.email;
  const run = (action, extra = {}, done = null) => async (btn, msg) => {
    const r = await act(btn, msg, () => post(`/api/access/users/${u.id}`, { action, ...extra }));
    if (!r) return;
    /* Redrawn first, then reported: a one-time link shown before the redraw
       would be scrolled to and then jumped away from. */
    await ctx.reload();
    if (done) done(r); else ctx.say(`Done: ${who2}.`);
  };
  const item = (title, sentence, controls = [], button = null) => {
    const msg = msgLine();
    const node = h('div', { class: 'acx-action', 'data-action': title }, h('h4', { class: 'acx-h4' }, title), h('p', { class: 'acx-p' }, sentence));
    if (controls.length) node.append(...controls);
    if (button) {
      const b = button.node;
      b.addEventListener('acx-fire', () => button.fire(b, msg));
      node.append(h('div', { class: 'acx-actions' }, b, msg));
    }
    p.body.append(node);
  };
  const plainBtn = (label, fire, dataAct) => {
    const b = h('button', { type: 'button', class: 'btn', 'data-acx': dataAct }, label);
    b.addEventListener('click', () => b.dispatchEvent(new Event('acx-fire')));
    return { node: b, fire };
  };
  const armedBtn = (label, sure, fire, dataAct) => {
    const b = armed(label, sure, (btn) => btn.dispatchEvent(new Event('acx-fire')));
    b.dataset.acx = dataAct;
    return { node: b, fire };
  };

  if (isOwner && !ctx.owner) p.body.append(note('This person is an Owner: only another Owner can change their account.', 'warn'));
  if (u.status === 'offboarded') {
    item('Bring them back', 'They have left. Reinstating reopens this same account — so their name stays joined to everything they recorded before — '
      + 'with no roles and no teams: give them fresh ones after.',
    [], plainBtn('Reinstate', run('reinstate', {}, () => ctx.say(`${who2} reinstated, with no roles. Give them what they need now.`, 'warn')), 'reinstate'));
    return p.panel;
  }

  const newName = h('input', { class: 'depinput acx-in', value: u.name || '', 'data-acx': 'rename' });
  item('Name', 'The name shown for them on every page and in the audit log. Their email, which they sign in with, does not change.',
    [field('Name', newName)], plainBtn('Rename', (b, m) => run('rename', { name: newName.value.trim() }, () => ctx.say(`Renamed to ${newName.value.trim() || '(no name)'}.`))(b, m), 'rename-go'));

  item(u.status === 'invited' ? 'A new invitation link' : 'A password reset link',
    u.status === 'invited'
      ? 'Makes a fresh invitation link for them, for 7 days, and stops the old one working. Use it if they lost the first.'
      : 'Makes a one-time link for them to choose a new password, valid for 24 hours; any earlier link stops working. Their current password keeps working until they use it.',
    [], plainBtn(u.status === 'invited' ? 'Make a new invitation link' : 'Make a reset link', run('reset', {}, (r) => ctx.showLink(oneTimeLink({
      key: 'reset', heading: `${u.status === 'invited' ? 'Invitation' : 'Password reset'} link for ${who2}`, path: r.link, lines: [
        `Send it to them privately. It works once, for ${u.status === 'invited' ? '7 days' : '24 hours'}.`,
        'It is shown only this once: copy it now.',
      ] }))), 'reset'));

  item('Sign them out everywhere', 'Ends every session they have open, on every browser and phone. They can sign straight back in — use Suspend to stop that.',
    [], plainBtn('Sign them out', run('signout', {}, (r) => ctx.say(`Signed ${who2} out of ${plural(r.revoked, 'session', 'sessions')}.`)), 'signout'));

  if (u.totp_enabled) {
    item('Reset two-step sign-in', 'For a lost or replaced phone: turns their two-step sign-in off and signs them out. '
      + 'If their role requires it they will be asked to set it up again the next time they sign in.',
    [], armedBtn('Reset two-step', 'Press again to reset', run('reset_mfa', {}, () => ctx.say(`Two-step sign-in reset for ${who2}.`)), 'reset-mfa'));
  }

  if (self) {
    p.body.append(note('This is you. You cannot suspend or offboard yourself; another Owner or Access admin can.', 'warn'));
    return p.panel;
  }
  if (u.status === 'suspended') {
    item('Reinstate', 'Lets them sign in again, with exactly the roles and teams they had before.', [],
      plainBtn('Reinstate', run('reinstate', {}, () => ctx.say(`${who2} can sign in again.`)), 'reinstate'));
  } else {
    const why = h('input', { class: 'depinput acx-in', 'data-acx': 'suspend-reason' });
    item('Suspend', 'Stops them signing in and ends their sessions at once. Their roles and teams are kept, so reinstating them restores exactly what they had.',
      [field('Why', why)], plainBtn('Suspend', (b, m) => {
        if (why.value.trim().length < 3) { m.set('Say why — it is shown to other admins and kept in the audit log.', 'bad'); return undefined; }
        return run('suspend', { reason: why.value.trim() }, () => ctx.say(`${who2} is suspended.`, 'warn'))(b, m);
      }, 'suspend'));
  }
  const whyOff = h('input', { class: 'depinput acx-in', 'data-acx': 'offboard-reason' });
  item('Offboard', 'For someone who has left: signs them out everywhere, ends every role, takes them out of every team and cancels any unused link. '
    + 'The account is kept, so their name stays on everything they recorded.',
  [field('Why', whyOff)], armedBtn('Offboard', `Press again to offboard ${who2}`, (b, m) => {
    if (whyOff.value.trim().length < 3) { m.set('Say why — it is kept in the audit log.', 'bad'); return undefined; }
    return run('offboard', { reason: whyOff.value.trim() }, () => ctx.say(`${who2} is offboarded.`, 'warn'))(b, m);
  }, 'offboard'));
  return p.panel;
}

/* ═════════════════════════ Teams ═════════════════════════ */
function teamsTab(host, ctx) {
  const people = ctx.users.filter((u) => u.status !== 'offboarded');
  const personOptions = (blank) => [h('option', { value: '' }, blank),
    ...people.map((u) => h('option', { value: String(u.id) }, `${u.name || u.email}${u.name ? ` (${u.email})` : ''}`))];

  if (!ctx.teams.length) {
    host.append(note('No teams yet. A team is a named group — Finance, Night dispatch, the cash office — whose members all hold '
      + 'the roles given to the team. Make one below; give it roles; add people.', 'warn'));
  }
  for (const t of ctx.teams) host.append(teamPanel(t, ctx, personOptions));

  const p = panel('Make a team', null, 'acx-team-new');
  const name = h('input', { class: 'depinput acx-in', required: true, 'data-acx': 'team-name' });
  const desc = h('input', { class: 'depinput acx-in' });
  const lead = h('select', { class: 'depinput acx-in' }, personOptions('No lead yet'));
  const msg = msgLine();
  const btn = h('button', { type: 'submit', class: 'btn primary', 'data-acx': 'team-create' }, 'Make the team');
  const form = h('form', { class: 'acx-form' }, field('Name', name), field('What it is for (optional)', desc),
    field('Lead', lead, 'The lead attests the team’s access each quarter.'), h('div', { class: 'acx-actions' }, btn, msg));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await act(btn, msg, () => post('/api/access/teams', { name: name.value.trim(), description: desc.value.trim(),
      lead: lead.value ? Number(lead.value) : null }));
    if (!r) return;
    ctx.say(`Made the team ${name.value.trim()}. Give it a role and add its members below.`);
    await ctx.reload();
  });
  p.body.append(form);
  host.append(p.panel);
}

function teamPanel(t, ctx, personOptions) {
  const p = panel(esc(t.name), t.description ? esc(t.description) : null, `acx-team-${t.id}`);
  p.panel.dataset.team = t.name;
  const msg = msgLine();
  const lead = ctx.byId.get(t.lead_user_id);
  p.body.append(h('p', { class: 'acx-p' }, lead ? `Led by ${lead.name || lead.email}.` : 'No lead: nobody attests this team’s access each quarter until one is chosen.'));

  /* Members. */
  const members = t.members.map((id) => ctx.byId.get(id)).filter(Boolean);
  p.body.append(h('h4', { class: 'acx-h4' }, `Members (${members.length})`));
  if (members.length) {
    p.body.append(h('ul', { class: 'acx-list' }, members.map((u) => {
      const b = h('button', { type: 'button', class: 'btn acx-mini', 'data-acx': 'member-remove' }, 'Take out');
      b.addEventListener('click', async () => {
        const r = await act(b, msg, () => post(`/api/access/teams/${t.id}`, { member: { userId: u.id, on: false } }));
        if (r) { ctx.say(`${u.name || u.email} taken out of ${t.name}; the team’s roles stopped applying to them at once.`); await ctx.reload(); }
      });
      return h('li', null, h('a', { href: `#access/person/${u.id}` }, u.name || u.email), h('span', { class: 'dim' }, ` · ${u.email} · ${u.status}`), ' ', b);
    })));
  } else {
    p.body.append(empty('Nobody is in this team yet. Add someone below — they get the team’s roles.'));
  }
  const add = h('select', { class: 'depinput acx-in', 'data-acx': 'member-pick' }, personOptions('Choose a person'));
  [...add.options].forEach((o) => { if (t.members.includes(Number(o.value))) o.remove(); });
  const addBtn = h('button', { type: 'button', class: 'btn', 'data-acx': 'member-add' }, 'Add to the team');
  addBtn.addEventListener('click', async () => {
    if (!add.value) { msg.set('Choose a person first.', 'bad'); return; }
    const u = ctx.byId.get(Number(add.value));
    const r = await act(addBtn, msg, () => post(`/api/access/teams/${t.id}`, { member: { userId: u.id, on: true } }));
    if (r) { ctx.say(`${u.name || u.email} added to ${t.name}; they hold its roles from their next click.`); await ctx.reload(); }
  });
  p.body.append(h('div', { class: 'acx-inrow' }, field('Add a member', add), addBtn), msg);

  /* The team's roles. */
  const tg = ctx.teamGrants(t.id);
  p.body.append(h('h4', { class: 'acx-h4' }, 'Roles every member holds'));
  const ask = h('div', { class: 'acx-inline' });
  if (tg.length) {
    p.body.append(h('ul', { class: 'acx-list' }, tg.map((g) => {
      const b = h('button', { type: 'button', class: 'btn acx-mini' }, 'Revoke');
      b.addEventListener('click', () => askReason(ask, { prompt: `Why revoke ${roleName(g.role_code)} from the whole team?`, confirm: 'Revoke it', danger: true,
        onConfirm: async (reason) => {
          await post(`/api/access/grants/${g.id}/revoke`, { reason });
          ctx.say(`${roleName(g.role_code)} revoked from ${t.name}.`);
          await ctx.reload();
        } }));
      return h('li', null, grantText(g, ctx), ' ', b);
    })));
  } else {
    p.body.append(empty('The team gives no role yet, so being in it changes nothing.'));
  }
  p.body.append(ask);

  const giveBox = h('details', { class: 'acx-more' }, h('summary', null, 'Give the team a role'));
  const g = grantFields(ctx);
  const reason = h('input', { class: 'depinput acx-in', required: true });
  const gmsg = msgLine();
  const gbtn = h('button', { type: 'submit', class: 'btn primary' }, 'Give it to the team');
  const gform = h('form', { class: 'acx-form' }, g.node, field('Why', reason), h('div', { class: 'acx-actions' }, gbtn, gmsg));
  gform.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = g.value();
    if (v.error) { gmsg.set(v.error, 'bad'); return; }
    if (reason.value.trim().length < 3) { gmsg.set('Say briefly why.', 'bad'); return; }
    const r = await act(gbtn, gmsg, () => post('/api/access/grants', { teamId: t.id, ...v, reason: reason.value.trim() }));
    if (!r) return;
    ctx.say(`${roleName(v.role)} given to everyone in ${t.name}.${r.note ? ` ${r.note}` : ''}`, r.note ? 'warn' : 'ok');
    await ctx.reload();
  });
  giveBox.append(gform);
  p.body.append(giveBox);

  /* Rename, lead, archive. */
  const edit = h('details', { class: 'acx-more' }, h('summary', null, 'Change the team'));
  const nm = h('input', { class: 'depinput acx-in', value: t.name });
  const ds = h('input', { class: 'depinput acx-in', value: t.description || '' });
  const ld = h('select', { class: 'depinput acx-in' }, personOptions('No lead'));
  ld.value = t.lead_user_id ? String(t.lead_user_id) : '';
  const emsg = msgLine();
  const save = h('button', { type: 'button', class: 'btn primary' }, 'Save');
  save.addEventListener('click', async () => {
    const r = await act(save, emsg, () => post(`/api/access/teams/${t.id}`, {
      name: nm.value.trim() || t.name, description: ds.value.trim(), lead: ld.value ? Number(ld.value) : null }));
    if (r) { ctx.say(`${nm.value.trim() || t.name} saved.`); await ctx.reload(); }
  });
  const archive = armed('Archive the team', 'Press again to archive', async (b) => {
    const r = await act(b, emsg, () => post(`/api/access/teams/${t.id}`, { archived: true }));
    if (r) { ctx.say(`${t.name} archived. Its roles no longer apply to its members; their own roles are unchanged.`, 'warn'); await ctx.reload(); }
  });
  edit.append(h('div', { class: 'acx-form' }, field('Name', nm), field('What it is for', ds), field('Lead', ld),
    h('div', { class: 'acx-actions' }, save),
    h('p', { class: 'acx-p' }, 'Archiving ends the team: its roles stop applying to everyone in it at once. Roles given to people directly are not touched, and the team’s history stays in the audit log.'),
    h('div', { class: 'acx-actions' }, archive, emsg)));
  p.body.append(edit);
  return p.panel;
}

/* ═════════════════════════ Roles ═════════════════════════ */
const LV_SHORT = { F: 'Full', M: 'Masked', A: 'Totals', '': '—' };
function rolesTab(host, ctx) {
  const roles = ctx.roles;
  const lvCell = (l) => `<span class="acx-lv lv-${l || 'none'}" title="${esc(LEVEL_NAME[l || ''])}">${esc(LV_SHORT[l || ''])}</span>`;
  const head = `<tr><th scope="col">Class</th>${roles.map((r) => `<th scope="col" data-role="${esc(r.code)}">${esc(r.name)}${r.custom ? '<div class="acx-sub">your own</div>' : ''}</th>`).join('')}</tr>`;

  const m = panel('What each role sees', 'Full: the real value. Masked: the real value’s last characters only. Totals: counts and sums, '
    + 'never a row. —: not shown at all, and the page says so where it would have been. There is no made-up stand-in at any level.', 'acx-matrix');
  let rowsHtml = '';
  let group = '';
  for (const c of CLASSES) {
    if (c.group !== group) { group = c.group; rowsHtml += `<tr class="acx-grp"><th colspan="${roles.length + 1}" scope="rowgroup">${esc(group)}</th></tr>`; }
    rowsHtml += `<tr><th scope="row" title="${esc(c.desc)}"><b>${esc(c.name)}</b><div class="acx-sub">${esc(c.desc)}</div></th>${roles.map((r) => `<td>${lvCell(r.levels?.[c.code])}</td>`).join('')}</tr>`;
  }
  m.body.append(h('div', { class: 'acx-scroll', 'data-acx': 'matrix', html: `<table class="acx-matrix"><thead>${head}</thead><tbody>${rowsHtml}</tbody></table>` }));
  host.append(m.panel);

  const c = panel('What each role can do', 'Reading is never implied by an action, and an action is never implied by reading.', 'acx-caps');
  const capRows = CAPS.map((cap) => `<tr><th scope="row" title="${esc(cap.note || cap.name)}"><b>${esc(cap.name)}</b>${cap.note ? `<div class="acx-sub">${esc(cap.note)}</div>` : ''}</th>${roles.map((r) => `<td>${(r.caps || []).includes(cap.code) ? '<span class="acx-lv lv-F">Yes</span>' : '<span class="acx-lv lv-none">—</span>'}</td>`).join('')}</tr>`).join('');
  c.body.append(h('div', { class: 'acx-scroll', html: `<table class="acx-matrix"><thead>${head.replace('>Class<', '>Action<')}</thead><tbody>${capRows}</tbody></table>` }));
  host.append(c.panel);

  const l = panel('The roles', null, 'acx-role-list');
  l.body.append(h('dl', { class: 'acx-dl acx-roles' }, roles.flatMap((r) => [
    h('dt', null, r.name),
    h('dd', null, r.desc || (r.basedOn ? `Your company’s own, based on ${roleName(r.basedOn)}.` : 'Your company’s own role.'),
      roleIsSensitive(r) ? h('span', { class: 'pill warn acx-tagged' }, 'needs a second Owner') : null,
      r.device ? h('span', { class: 'pill dim acx-tagged' }, 'for a screen, not a person') : null,
      r.timeboxed ? h('span', { class: 'pill dim acx-tagged' }, 'always has an end date') : null),
  ])));
  host.append(l.panel);
  host.append(duplicatePanel(ctx));
}

function duplicatePanel(ctx) {
  const p = panel('Duplicate to customise', 'Start from a role, change what it sees and does, and give it a name. A role you make '
    + 'can never hold more than you do yourself — the server refuses one that would, and says so here.', 'acx-role-new');
  const mine = { levels: ctx.me.levels || {}, caps: ctx.me.caps || [] };
  const base = h('select', { class: 'depinput acx-in', 'data-acx': 'role-base' },
    ctx.roles.filter((r) => !r.device).map((r) => h('option', { value: r.code }, r.name)));
  const name = h('input', { class: 'depinput acx-in', required: true, 'data-acx': 'role-name' });
  const desc = h('input', { class: 'depinput acx-in' });
  const selects = new Map();
  const grid = h('div', { class: 'acx-lvgrid' });
  for (const c of CLASSES) {
    const s = h('select', { class: 'depinput acx-in', 'data-class': c.code },
      ['F', 'M', 'A', ''].map((l) => h('option', { value: l }, LEVEL_NAME[l])));
    selects.set(c.code, s);
    grid.append(field(c.name, s));
  }
  const capBoxes = new Map();
  const caps = h('fieldset', { class: 'acx-fleets acx-capset' }, h('legend', { class: 'deplabel' }, 'Actions'),
    CAPS.map((cap) => {
      const b = h('input', { type: 'checkbox', value: cap.code, id: uid() });
      capBoxes.set(cap.code, b);
      return h('label', { class: 'acx-check', for: b.id }, b, cap.name);
    }));
  const above = h('p', { class: 'depnote', 'data-acx': 'above' });
  const check = () => {
    const over = CLASSES.filter((c) => rank(selects.get(c.code).value) > rank(mine.levels[c.code])).map((c) => c.name);
    const overCaps = CAPS.filter((cap) => capBoxes.get(cap.code).checked && !mine.caps.includes(cap.code)).map((cap) => cap.name);
    const all = [...over, ...overCaps];
    above.textContent = all.length ? `Above your own access, so the server will refuse it: ${all.join(', ')}.` : '';
    above.className = all.length ? 'depnote bad' : 'depnote';
  };
  const fill = () => {
    const r = ctx.roleBy.get(base.value);
    for (const [code, s] of selects) s.value = r?.levels?.[code] || '';
    for (const [code, b] of capBoxes) b.checked = (r?.caps || []).includes(code);
    check();
  };
  base.addEventListener('change', fill);
  grid.addEventListener('change', check);
  caps.addEventListener('change', check);
  fill();
  const msg = msgLine();
  const btn = h('button', { type: 'submit', class: 'btn primary', 'data-acx': 'role-create' }, 'Make the role');
  const form = h('form', { class: 'acx-form acx-form-wide' }, field('Start from', base), field('Name', name), field('What it is for (optional)', desc),
    h('h4', { class: 'acx-h4' }, 'What it sees'), grid, caps, above, h('div', { class: 'acx-actions' }, btn, msg));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const levels = Object.fromEntries([...selects].filter(([, s]) => s.value).map(([c, s]) => [c, s.value]));
    const capList = [...capBoxes].filter(([, b]) => b.checked).map(([c]) => c);
    const r = await act(btn, msg, () => post('/api/access/roles', { name: name.value.trim(), description: desc.value.trim(),
      basedOn: base.value, levels, caps: capList }));
    if (!r) return;
    ctx.say(`Made the role ${name.value.trim()}. Give it to a person from their page, or to a team.`);
    await ctx.reload();
  });
  p.body.append(form);
  return p.panel;
}

/* ═════════════════════════ Requests ═════════════════════════ */
async function requestsTab(host, ctx) {
  const open = ctx.requests;
  const p = panel('Waiting for a decision', 'Asked from a page that told the person it was not shown to their role. Approve by giving them a role — '
    + 'for a period, if the need is temporary — or decline with a reason they will read on their account page.', 'acx-requests');
  if (!open.length) {
    p.body.append(empty('Nobody is waiting. When a page tells someone “not shown to your role”, it offers them a box to ask; '
      + 'what they ask appears here, with the page they were on and their reason.'));
  }
  for (const r of open) p.body.append(requestCard(r, ctx));
  host.append(p.panel);

  const done = panel('Decided', null, 'acx-requests-done');
  host.append(done.panel);
  {
    let d;
    try { d = await getJson('/api/access/requests'); } catch (e) { done.body.append(note(`Could not be read: ${e.message}`, 'err')); return; }
    const rows = (d.requests || []).filter((r) => r.status !== 'open').slice(0, 50);
    if (!rows.length) { done.body.append(empty('No request has been decided yet.')); return; }
    done.body.append(tableFrom(rows, [
      { label: 'Asked by', key: 'email', render: (r) => ctx.personLink(r.user_id) },
      { label: 'For', key: 'class_code', render: (r) => esc(requestWhat(r)) },
      { label: 'Answer', key: 'status', render: (r) => `<span class="pill ${r.status === 'approved' ? 'ok' : 'dim'}">${esc(r.status)}</span>` },
      { label: 'Decided', key: 'decided_at', render: (r) => `${esc(dtStr(r.decided_at))}<div class="acx-sub">by ${esc(ctx.nameOf(r.decided_by))}${r.decision_reason ? ` — ${esc(r.decision_reason)}` : ''}</div>` },
    ], { compact: true, cards: true, cardLead: 'email' }));
  }
}

function requestCard(r, ctx) {
  const card = h('div', { class: 'acx-card', 'data-request': String(r.id) });
  card.append(h('p', { class: 'acx-p', html: `${ctx.personLink(r.user_id)} <span class="dim">${esc(r.email)} · asked ${esc(dtStr(r.created_at))}</span>` }),
    h('p', { class: 'acx-p' }, h('b', null, 'For: '), requestWhat(r),
      r.view ? h('span', null, ' — ', h('a', { href: `#${r.view}` }, 'the page they were on')) : null),
    h('blockquote', { class: 'acx-quote' }, r.reason || '(no reason given)'));
  if (r.user_id === ctx.me.id) {
    card.append(empty('Your own request: someone else must decide it.'));
    return card;
  }
  const g = grantFields(ctx, { selected: r.role_code || '', mark: r.class_code || null });
  const reason = h('input', { class: 'depinput acx-in', 'data-acx': 'approve-reason' });
  const msg = msgLine();
  const yes = h('button', { type: 'submit', class: 'btn primary', 'data-acx': 'approve' }, 'Approve');
  const approve = h('form', { class: 'acx-form' }, g.node, field('Note (optional)', reason, 'Kept with the grant and in the audit log; their own reason is kept too.'),
    h('div', { class: 'acx-actions' }, yes, msg));
  approve.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = g.value();
    if (v.error) { msg.set(v.error, 'bad'); return; }
    const res = await act(yes, msg, () => post(`/api/access/requests/${r.id}`, { approve: true, ...v, reason: reason.value.trim() }));
    if (!res) return;
    ctx.say(`Approved: ${roleName(v.role)} for ${r.name || r.email}.${res.note ? ` ${res.note}` : ''}`, res.note ? 'warn' : 'ok');
    await ctx.reload();
  });
  const noWhy = h('input', { class: 'depinput acx-in', 'data-acx': 'decline-reason' });
  const nmsg = msgLine();
  const no = h('button', { type: 'submit', class: 'btn', 'data-acx': 'decline' }, 'Decline');
  const decline = h('form', { class: 'acx-form' }, field('Why not', noWhy, 'They read this on their account page.'), h('div', { class: 'acx-actions' }, no, nmsg));
  decline.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (noWhy.value.trim().length < 3) { nmsg.set('Say why — they will read it.', 'bad'); return; }
    const res = await act(no, nmsg, () => post(`/api/access/requests/${r.id}`, { approve: false, reason: noWhy.value.trim() }));
    if (!res) return;
    ctx.say(`Declined ${r.name || r.email}’s request.`);
    await ctx.reload();
  });
  card.append(h('div', { class: 'acx-split' },
    h('div', null, h('h4', { class: 'acx-h4' }, 'Approve'), approve),
    h('div', null, h('h4', { class: 'acx-h4' }, 'Decline'), decline)));
  return card;
}

/* ═════════════════════════ Approvals ═════════════════════════ */
function approvalsTab(host, ctx) {
  const pending = ctx.grants.filter((g) => g.status === 'pending');
  const later = ctx.grants.filter((g) => g.status === 'active' && new Date(g.effective_at).getTime() > Date.now());
  const forWhom = (g) => (g.user_id ? ctx.personLink(g.user_id) : `the team <a href="#access/teams">${esc(ctx.teamById.get(g.team_id)?.name || `#${g.team_id}`)}</a>`);
  const ask = h('div', { class: 'acx-inline' });
  const msg = msgLine();

  const p = panel('Waiting for an Owner', 'A sensitive role — Owner, Access admin, Connections admin, or one that shows driver cash, ID documents in full, '
    + 'who is named as a likely culprit, the audit log, platform logins or raw records — takes a second Owner’s approval (ULM §6.4). '
    + 'Nobody approves a grant they gave, or one for themselves.', 'acx-approvals');
  if (!ctx.owner && pending.length) p.body.append(note('Only an Owner approves these. You can decline one.', 'warn'));
  if (!pending.length) {
    p.body.append(empty('Nothing is waiting. A sensitive grant made while the company has more than one Owner, or made by an Access admin, waits here.'));
  } else {
    p.body.append(tableFrom(pending, [
      { label: 'For', key: 'user_id', render: forWhom },
      { label: 'Role', key: 'role_code', render: (g) => `<b>${esc(roleName(g.role_code))}</b><div class="acx-sub">${esc(fleetsText(g.fleets, ctx.fleets))} · ${g.expires_at ? `until ${esc(dateStr(g.expires_at))}` : 'no end date'}</div>` },
      { label: 'Why', key: 'reason', render: (g) => esc(g.reason || '—') },
      { label: 'Asked', key: 'created_at', render: (g) => `${esc(dtStr(g.created_at))}<div class="acx-sub">by ${esc(ctx.nameOf(g.granted_by))}</div>` },
      { label: '', key: 'id', render: (g) => {
        const mineToGive = g.granted_by === ctx.me.id || g.user_id === ctx.me.id;
        return `${ctx.owner && !mineToGive ? `<button type="button" class="btn primary" data-approve="${g.id}">Approve</button> ` : ''}`
          + `<button type="button" class="btn" data-decline="${g.id}">Decline</button>`
          + (ctx.owner && mineToGive ? '<div class="acx-sub">you gave it, so another Owner approves it</div>' : '');
      } },
    ], { compact: true, cards: true, cardLead: 'role_code' }));
  }
  p.body.append(ask, msg);
  p.body.addEventListener('click', async (e) => {
    const a = e.target.closest('button[data-approve]');
    const d = e.target.closest('button[data-decline]');
    if (a) {
      const g = pending.find((x) => x.id === Number(a.dataset.approve));
      const r = await act(a, msg, () => post(`/api/access/grants/${g.id}/approve`, {}));
      if (r) { ctx.say(`Approved: ${roleName(g.role_code)}. It applies from now.`); await ctx.reload(); }
    } else if (d) {
      const g = pending.find((x) => x.id === Number(d.dataset.decline));
      askReason(ask, { prompt: `Why decline ${roleName(g.role_code)}?`, confirm: 'Decline it',
        onConfirm: async (reason) => { await post(`/api/access/grants/${g.id}/revoke`, { reason }); ctx.say('Declined.'); await ctx.reload(); } });
    }
  });
  host.append(p.panel);

  const l = panel('Starting later', 'Given by the only Owner while sign-in is required: a sensitive role then waits before it takes effect, '
    + 'so a single stolen Owner account cannot hand out access at once. Add a second Owner to approve grants straight away.', 'acx-later');
  if (!later.length) l.body.append(empty('No grant is waiting to start.'));
  else {
    const lmsg = msgLine();
    l.body.append(tableFrom(later, [
      { label: 'For', key: 'user_id', render: forWhom },
      { label: 'Role', key: 'role_code', render: (g) => `<b>${esc(roleName(g.role_code))}</b>` },
      { label: 'Takes effect', key: 'effective_at', render: (g) => esc(dtStr(g.effective_at)) },
      { label: 'Given by', key: 'granted_by', render: (g) => esc(ctx.nameOf(g.granted_by)) },
      { label: '', key: 'id', render: (g) => `<button type="button" class="btn" data-stop="${g.id}">Cancel it</button>` },
    ], { compact: true, cards: true, cardLead: 'role_code' }), lmsg);
    l.body.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-stop]');
      if (!b) return;
      const r = await act(b, lmsg, () => post(`/api/access/grants/${b.dataset.stop}/revoke`, { reason: 'cancelled before it took effect' }));
      if (r) { ctx.say('Cancelled before it took effect.'); await ctx.reload(); }
    });
  }
  host.append(l.panel);
}

/* ═════════════════════════ Reviews ═════════════════════════ */
function quarterNow() {
  const d = new Date();
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
async function reviewsTab(host, ctx) {
  const period = quarterNow();
  const top = panel(`This quarter (${period})`, 'Every quarter each team’s lead — or an admin — looks at who is in the team and keeps or removes '
    + 'each person. Removing someone takes the team’s roles away from them at once.', 'acx-review-open');
  const msg = msgLine();
  const openBtn = h('button', { type: 'button', class: 'btn primary', 'data-acx': 'review-open' }, 'Open this quarter’s review for every team');
  openBtn.addEventListener('click', async () => {
    const r = await act(openBtn, msg, () => post('/api/access/reviews/open', {}));
    if (!r) return;
    ctx.say(r.opened ? `Opened ${r.period} for ${plural(r.opened, 'team', 'teams')}; each is due in 14 days.`
      : `Every team already has a ${r.period} review${ctx.teams.length ? '' : ' — and there are no teams to review'}.`, r.opened ? 'ok' : 'warn');
    await ctx.reload();
  });
  top.body.append(ctx.teams.length ? h('div', { class: 'acx-actions' }, openBtn, msg)
    : empty('There are no teams, so there is nothing to review: reviews are per team. Make teams under Teams.'));
  host.append(top.panel);

  let d;
  try { d = await getJson('/api/access/reviews'); } catch (e) { host.append(note(`The reviews could not be read: ${e.message}`, 'err')); return; }
  const reviews = d.reviews || [];
  const open = reviews.filter((r) => !r.closed_at);
  const closed = reviews.filter((r) => r.closed_at);

  const op = panel('Open reviews', null, 'acx-reviews');
  if (!open.length) op.body.append(empty('No review is open. Open this quarter’s above; each team then appears here with its members.'));
  for (const r of open) op.body.append(reviewCard(r, ctx));
  host.append(op.panel);

  const cp = panel('Finished reviews', null, 'acx-reviews-done');
  if (!closed.length) cp.body.append(empty('No review has been finished yet.'));
  else {
    cp.body.append(tableFrom(closed, [
      { label: 'Team', key: 'team_name', render: (r) => esc(r.team_name) },
      { label: 'Quarter', key: 'period', render: (r) => esc(r.period) },
      { label: 'Attested', key: 'closed_at', render: (r) => `${esc(dtStr(r.closed_at))}<div class="acx-sub">by ${esc(ctx.nameOf(r.attested_by))}</div>` },
      { label: 'Taken out', key: 'decisions', render: (r) => {
        const out = (r.decisions || []).filter((x) => x.keep === false).map((x) => ctx.nameOf(x.userId));
        return out.length ? esc(out.join(', ')) : '<span class="dim">nobody</span>';
      } },
    ], { compact: true, cards: true, cardLead: 'team_name' }));
  }
  host.append(cp.panel);
}

function reviewCard(r, ctx) {
  const t = ctx.teamById.get(r.team_id);
  const overdue = new Date(r.due_at).getTime() < Date.now();
  const card = h('div', { class: 'acx-card', 'data-review': String(r.id) },
    h('p', { class: 'acx-p', html: `<b>${esc(r.team_name)}</b> · ${esc(r.period)} · due ${esc(dateStr(r.due_at))} ${overdue ? '<span class="pill bad">overdue</span>' : ''}` }));
  const members = (t?.members || []).map((id) => ctx.byId.get(id)).filter(Boolean);
  if (!members.length) card.append(empty('Nobody is in this team, so attesting it records only that.'));
  const choices = members.map((u) => {
    const name = `acx-rv-${r.id}-${u.id}`;
    const keep = h('input', { type: 'radio', name, value: 'keep', checked: true, id: uid() });
    const drop = h('input', { type: 'radio', name, value: 'remove', id: uid() });
    card.append(h('div', { class: 'acx-rv' }, h('span', { class: 'acx-rv-who' }, u.name || u.email, h('span', { class: 'dim' }, ` · ${u.status}`)),
      h('label', { class: 'acx-check', for: keep.id }, keep, 'Keep'), h('label', { class: 'acx-check', for: drop.id }, drop, 'Take out')));
    return { u, keep };
  });
  const msg = msgLine();
  const btn = h('button', { type: 'button', class: 'btn primary', 'data-acx': 'attest' }, 'Attest this team');
  btn.addEventListener('click', async () => {
    const decisions = choices.map(({ u, keep }) => ({ userId: u.id, keep: keep.checked }));
    const res = await act(btn, msg, () => post(`/api/access/reviews/${r.id}/attest`, { decisions }));
    if (!res) return;
    const out = decisions.filter((x) => !x.keep).length;
    ctx.say(`${r.team_name} attested for ${r.period}${out ? `; ${plural(out, 'person', 'people')} taken out` : '; everyone kept'}.`);
    await ctx.reload();
  });
  card.append(h('div', { class: 'acx-actions' }, btn, msg));
  return card;
}

/* ═════════════════════════ Screens ═════════════════════════ */
function screensTab(host, ctx) {
  const list = panel('Wall displays', 'A screen signs in once with its own link and stays signed in as the Wall display role: company totals, '
    + 'live counts and how fresh the data is — no driver, no money per person. It has no password; switching it off here ends it at once.', 'acx-screens');
  const lmsg = msgLine();
  if (!ctx.devices.length) {
    list.body.append(empty('No screen has been set up. Make one below, then open its link once on the screen itself.'));
  } else {
    list.body.append(tableFrom(ctx.devices, [
      { label: 'Screen', key: 'name', render: (d) => `<b>${esc(d.name)}</b>` },
      { label: 'Fleets', key: 'fleets', render: (d) => esc(fleetsText(d.fleets, ctx.fleets)) },
      { label: 'Set up', key: 'created_at', render: (d) => `${esc(dtStr(d.created_at))}<div class="acx-sub">by ${esc(ctx.nameOf(d.created_by))}</div>` },
      { label: 'Last seen', key: 'last_seen_at', render: (d) => (d.last_seen_at ? esc(dtStr(d.last_seen_at)) : '<span class="dim">never — its link has not been opened</span>') },
      { label: 'State', key: 'revoked_at', render: (d) => (d.revoked_at ? `<span class="pill dim">switched off ${esc(dateStr(d.revoked_at))}</span>` : '<span class="pill ok">on</span>') },
      { label: '', key: 'id', render: (d) => (d.revoked_at ? '' : `<button type="button" class="btn" data-off="${d.id}">Switch off</button>`) },
    ], { compact: true, cards: true, cardLead: 'name' }), lmsg);
    list.body.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-off]');
      if (!b) return;
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Press again to switch off'; b.classList.add('primary'); return; }
      const d = ctx.devices.find((x) => x.id === Number(b.dataset.off));
      const r = await act(b, lmsg, () => post(`/api/access/devices/${d.id}/revoke`, {}));
      if (r) { ctx.say(`${d.name} is switched off; the screen shows the sign-in page from its next refresh.`, 'warn'); await ctx.reload(); }
    });
  }
  host.append(list.panel);

  const p = panel('Set up a screen', null, 'acx-screen-new');
  const name = h('input', { class: 'depinput acx-in', required: true, placeholder: 'Office wall', 'data-acx': 'screen-name' });
  const fleets = fleetPicker(ctx.fleets);
  const msg = msgLine();
  const btn = h('button', { type: 'submit', class: 'btn primary', 'data-acx': 'screen-create' }, 'Make the screen link');
  const form = h('form', { class: 'acx-form' }, field('Name', name, 'Where it hangs, so it can be told apart in the audit log.'), fleets.node,
    h('div', { class: 'acx-actions' }, btn, msg));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = fleets.value();
    if (f && !f.length) { msg.set('Tick at least one fleet, or choose every fleet.', 'bad'); return; }
    const r = await act(btn, msg, () => post('/api/access/devices', { name: name.value.trim(), fleets: f }));
    if (!r) return;
    const nm = name.value.trim();
    await ctx.reload();
    ctx.showLink(oneTimeLink({ key: 'screen', heading: `Screen link for ${nm}`, path: r.link, lines: [
      'Open it once in the browser on the screen itself; the screen then stays signed in for a year, or until it is switched off here.',
      'Anyone who has the link can see what the wall display shows, so do not send it round.',
      'It is shown only this once: copy it now.',
    ] }));
  });
  p.body.append(form);
  host.append(p.panel);
}

/* ═════════════════════════ Audit ═════════════════════════ */
const ACTION_WORDS = {
  'auth.login': 'signed in', 'auth.login_failed': 'a wrong password', 'auth.login_refused': 'sign-in refused (account not active)',
  'auth.logout': 'signed out', 'auth.code_failed': 'a wrong two-step code', 'auth.recovery_code_used': 'signed in with a recovery code',
  'auth.password_changed': 'changed their password', 'auth.password_change_failed': 'a wrong current password',
  'auth.stepup': 'confirmed it was them', 'auth.stepup_failed': 'failed to confirm it was them',
  'auth.totp_enabled': 'turned two-step on', 'auth.totp_disabled': 'turned two-step off',
  'auth.sessions_revoked': 'signed out everywhere else', 'auth.session_revoked': 'signed one session out',
  'auth.invite_accepted': 'accepted their invitation', 'auth.reset_accepted': 'used a reset link',
  'auth.device_signed_in': 'a screen signed in',
  'access.bootstrap_owner': 'the first Owner was created', 'access.user_invited': 'invited a person',
  'access.user_rename': 'renamed a person', 'access.user_suspend': 'suspended a person', 'access.user_reinstate': 'reinstated a person',
  'access.user_offboard': 'offboarded a person', 'access.user_reset_mfa': 'reset a person’s two-step', 'access.link_issued': 'made a sign-in link',
  'access.sessions_revoked': 'signed a person out everywhere', 'access.grant_created': 'gave a role', 'access.grant_approved': 'approved a role',
  'access.grant_revoked': 'revoked a role', 'access.team_created': 'made a team', 'access.team_updated': 'changed a team',
  'access.team_member_added': 'added a team member', 'access.team_member_removed': 'took out a team member',
  'access.role_created': 'made a role', 'access.requested': 'asked for access', 'access.request_approved': 'approved a request',
  'access.request_declined': 'declined a request', 'access.device_created': 'set up a screen', 'access.device_revoked': 'switched off a screen',
  'access.config_changed': 'changed the sign-in settings', 'access.review_opened': 'opened a review', 'access.review_attested': 'attested a team',
  'access.preview_started': 'started previewing a role', 'access.preview_ended': 'ended a preview', 'access.housekeeping': 'daily tidy-up',
  'proposal.declined': 'declined a proposal', 'proposal.withdrawn': 'withdrew a proposal',
};
const actionWords = (a) => ACTION_WORDS[a] || (a.startsWith('act:') ? `did ${CAP[a.slice(4)]?.name || a.slice(4)}`
  : a.startsWith('read:') ? `read ${a.slice(5)}` : a);

/* A detail object, in a line: values the log stores only as a keyed hash
   (passwords, emails, phone numbers — audit.js scrub) say so rather than
   printing the hash, which means nothing to a reader. */
function detailLine(d) {
  if (!d || typeof d !== 'object') return '';
  const val = (v) => {
    if (v == null || v === '') return null;
    if (typeof v !== 'object') return String(v);
    if (v.hashed) return '(kept as a hash)';
    if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? (x?.role ? roleName(x.role) : JSON.stringify(x)) : String(x))).join(', ') : null;
    return JSON.stringify(v);
  };
  const parts = Object.entries(d).map(([k, v]) => {
    const s = k === 'role' ? roleName(v) : val(v);
    return s == null ? null : `${k}: ${s}`;
  }).filter(Boolean);
  const out = parts.join(' · ');
  return out.length > 180 ? `${out.slice(0, 179)}…` : out;
}

async function auditTab(host, ctx) {
  if (!who.access?.levels?.AUDIT) {
    host.append(closedBlock({ cls: 'AUDIT', view: 'access/audit', title: 'The audit log is not open to your role' }));
    return;
  }
  const chain = panel('Is the log intact?', 'Each entry carries a hash of itself and of the entry before, so an entry edited or removed after it '
    + 'was written breaks the chain from that point on. Checking reads every entry.', 'acx-chain');
  const vmsg = h('div', { 'data-acx': 'chain' });
  const vbtn = h('button', { type: 'button', class: 'btn', 'data-acx': 'chain-check' }, 'Check the chain');
  vbtn.addEventListener('click', async () => {
    vbtn.disabled = true;
    vmsg.replaceChildren(el('p', 'acx-p dim', 'Checking…'));
    try {
      const r = await getJson('/api/access/audit/verify');
      vmsg.replaceChildren(r.ok
        ? note(`Intact. All ${r.rows} entries follow from the one before, so none has been edited or removed since it was written.`, 'ok')
        : note(`Broken at entry #${r.brokenAt}: that entry, or the one before it, was changed or removed after it was written. `
          + `The ${r.rows} entries read before it are consistent. Tell the Owner — nothing in FleetMirror edits this log.`, 'err'));
    } catch (e) { vmsg.replaceChildren(note(`The check could not run: ${e.message}`, 'err')); }
    vbtn.disabled = false;
  });
  chain.body.append(h('div', { class: 'acx-actions' }, vbtn), vmsg);

  const p = panel('Every entry, newest first', null, 'acx-audit');
  const kind = h('select', { class: 'depinput acx-in', 'data-acx': 'audit-kind' },
    [['', 'Everything'], ['auth.', 'Signing in and out'], ['access.', 'Access changes'], ['act:', 'Actions on the data'],
      ['read:', 'Recorded reads'], ['proposal.', 'Four-eyes proposals']].map(([v, t]) => h('option', { value: v }, t)));
  const actor = h('select', { class: 'depinput acx-in', 'data-acx': 'audit-actor' }, h('option', { value: '' }, 'Anyone'),
    ctx.users.map((u) => h('option', { value: String(u.id) }, u.name || u.email)));
  const tableHost = h('div');
  const more = h('button', { type: 'button', class: 'btn', 'data-acx': 'audit-older' }, 'Older entries');
  const msg = msgLine();
  let rows = [];
  const LIMIT = 100;
  const load = async (before = null) => {
    const q = new URLSearchParams({ limit: String(LIMIT) });
    if (before) q.set('before', String(before));
    if (kind.value) q.set('action', kind.value);
    if (actor.value) q.set('actor', actor.value);
    more.disabled = true;
    try {
      const d = await getJson(`/api/access/audit?${q}`);
      rows = before ? rows.concat(d.rows || []) : (d.rows || []);
      draw((d.rows || []).length === LIMIT);
    } catch (e) { msg.set(`The log could not be read: ${e.message}`, 'bad'); }
    more.disabled = false;
  };
  const draw = (hasMore) => {
    tableHost.replaceChildren();
    if (!rows.length) {
      tableHost.append(empty(kind.value || actor.value ? 'No entry matches these filters.' : 'The log is empty.'));
      more.style.display = 'none';
      return;
    }
    tableHost.append(tableFrom(rows.slice(), [
      { label: 'When', key: 'at', render: (r) => `${esc(dtStr(r.at))}<div class="acx-sub mono">#${r.id}</div>` },
      /* A sign-in is written before any session exists, so its actor is
         "anonymous"; the person it is about is the one at the sign-in page. */
      { label: 'Who', key: 'actor_label', render: (r) => (r.actor_id ? ctx.personLink(r.actor_id)
        : r.subject_type === 'user' && r.subject_id && r.action.startsWith('auth.')
          ? `${ctx.personLink(r.subject_id)}<div class="acx-sub">at the sign-in page</div>` : esc(r.actor_label || '—')) },
      { label: 'What', key: 'action', render: (r) => `${esc(actionWords(r.action))}<div class="acx-sub mono" data-action-code>${esc(r.action)}</div>` },
      { label: 'About', key: 'subject_id', render: (r) => (r.subject_type === 'user' && r.subject_id
        ? ctx.personLink(r.subject_id) : esc([r.subject_type, r.subject_id].filter(Boolean).join(' ') || '—')) },
      { label: 'Detail', key: 'detail', render: (r) => esc(detailLine(r.detail)) || '<span class="dim">—</span>' },
      { label: 'Address', key: 'ip', render: (r) => `<span class="mono">${esc(r.ip || '—')}</span>` },
    ], { compact: true, cards: true, cardLead: 'action' }));
    /* style, not the hidden attribute: .btn sets display, which outranks the
       browser's own [hidden] rule. */
    more.style.display = hasMore ? '' : 'none';
    tableHost.append(h('p', { class: 'depnote' }, `${plural(rows.length, 'entry', 'entries')} shown.`));
  };
  more.addEventListener('click', () => load(rows.length ? rows[rows.length - 1].id : null));
  kind.addEventListener('change', () => load());
  actor.addEventListener('change', () => load());
  p.body.append(h('div', { class: 'acx-filters' }, field('Kind', kind), field('Who', actor)), tableHost,
    h('div', { class: 'acx-actions' }, more, msg));
  host.append(chain.panel, p.panel);
  await load();
}

/* ═════════════════════════ Settings ═════════════════════════ */
const MFA_WORDS = {
  admins: 'The Owner and Access admins must use two-step sign-in. Everyone else may.',
  writers: 'Everyone whose role can change anything — record cash, import, merge, manage access — must use it. Read-only roles may.',
  none: 'Nobody is made to. Anyone may turn it on for themselves.',
};
function settingsTab(host, ctx) {
  const cfg = ctx.config;
  const owner = ctx.owner;
  if (!owner) host.append(note('Only the Owner changes these. You can read them here.', 'warn'));

  /* Sign-in: optional or required. */
  const m = panel('Sign-in', null, 'acx-mode');
  const modeNow = cfg.mode === 'enforced' ? 'enforced' : 'open';
  const MODES = [
    { id: 'open', name: 'Optional', desc: 'People without an account still see everything, as today. Signed in, the pages follow each person’s role.' },
    { id: 'enforced', name: 'Required', desc: 'Nothing is shown without signing in. Anyone without an account sees the sign-in page and nothing else; wall displays keep working with their screen link.' },
  ];
  const radios = MODES.map((x) => {
    const id = uid();
    const r = h('input', { type: 'radio', name: 'acx-mode', value: x.id, id, checked: x.id === modeNow, disabled: !owner, 'data-acx': `mode-${x.id}` });
    return { x, r, node: h('label', { class: `acx-look${x.id === modeNow ? ' on' : ''}`, for: id }, r,
      h('span', { class: 'acx-look-t' }, h('b', null, x.name), x.id === modeNow ? h('span', { class: 'dim' }, ' — now') : null),
      h('span', { class: 'acx-look-d' }, x.desc)) };
  });
  const confirmHost = h('div', { 'data-acx': 'mode-confirm' });
  const msg = msgLine();
  const save = h('button', { type: 'button', class: 'btn primary', disabled: !owner, 'data-acx': 'mode-save' }, 'Change sign-in');
  const send = async (mode, btn) => {
    const r = await act(btn, msg, () => post('/api/access/config', { mode }));
    if (!r) return;
    if (r.config?.mode !== mode) {
      ctx.say('Saved — but the server keeps sign-in required whatever this says: ACCESS_MODE is set to “enforced” on the platform, '
        + 'as a break-glass. Only removing it there makes sign-in optional again.', 'warn');
    } else {
      ctx.say(mode === 'enforced' ? 'Sign-in is now required. Anyone without an account sees the sign-in page.'
        : 'Sign-in is optional again: people without an account see every page.', mode === 'enforced' ? 'ok' : 'warn');
    }
    await ctx.reload();
  };
  save.addEventListener('click', () => {
    const want = radios.find((x) => x.r.checked)?.x.id;
    confirmHost.replaceChildren();
    if (!want || want === modeNow) { msg.set('That is already the setting.', ''); return; }
    const active = ctx.users.filter((u) => u.status === 'active');
    const invited = ctx.users.filter((u) => u.status === 'invited');
    const owners = ctx.owners.map((id) => ctx.byId.get(id)).filter(Boolean);
    const screens = ctx.devices.filter((d) => !d.revoked_at).length;
    const yes = h('button', { type: 'button', class: 'btn primary', 'data-acx': 'mode-yes' },
      want === 'enforced' ? 'Yes, require sign-in' : 'Yes, make it optional');
    yes.addEventListener('click', () => send(want, yes));
    const no = h('button', { type: 'button', class: 'btn', onclick: () => { confirmHost.replaceChildren(); } }, 'Cancel');
    confirmHost.append(h('div', { class: 'acx-confirm' }, want === 'enforced'
      ? [h('p', { class: 'acx-p' }, h('b', null, `${plural(active.length, 'person has', 'people have')} an active account and will be able to sign in`),
        active.length ? `: ${active.map((u) => u.name || u.email).slice(0, 15).join(', ')}${active.length > 15 ? ` and ${active.length - 15} more` : ''}.` : '.'),
      h('p', { class: 'acx-p' }, h('b', null, 'Owners: '), owners.length ? owners.map((u) => (u.name ? `${u.name} (${u.email})` : u.email)).join(', ') : 'none active — the server will keep refusing people until one is.'),
      invited.length ? h('p', { class: 'acx-p' }, `${plural(invited.length, 'person has', 'people have')} an invitation they have not used yet, and cannot sign in until they do.`) : null,
      h('p', { class: 'acx-p' }, `Everyone else — anyone who opens FleetMirror without an account, including on a shared office screen — will see the sign-in page and nothing else. ${screens ? `${plural(screens, 'wall display keeps', 'wall displays keep')} working.` : 'No wall display is set up.'}`)]
      : [h('p', { class: 'acx-p' }, 'Anyone who can reach FleetMirror’s address will see every page again without signing in — driver names, cash and all. Signed-in people keep seeing their own role’s view.')],
    h('div', { class: 'acx-actions' }, yes, no)));
  });
  m.body.append(h('div', { class: 'acx-looks', role: 'radiogroup', 'aria-label': 'Sign-in' }, radios.map((x) => x.node)),
    h('div', { class: 'acx-actions' }, save, msg), confirmHost);
  host.append(m.panel);

  /* The other three settings, each saved on its own. */
  const one = (title, key, control, sentence, toValue, done, label) => {
    const p = panel(title, null, `acx-set-${key}`);
    const mm = msgLine();
    const b = h('button', { type: 'button', class: 'btn', disabled: !owner, 'data-acx': `save-${key}` }, 'Save');
    b.addEventListener('click', async () => {
      const v = toValue();
      if (v === undefined) return;
      const r = await act(b, mm, () => post('/api/access/config', { [key]: v }));
      if (!r) return;
      ctx.say(done(r.config?.[key] ?? v));
      await ctx.reload();
    });
    control.disabled = !owner;
    p.body.append(h('p', { class: 'acx-p' }, sentence), h('div', { class: 'acx-inrow' }, field(label, control), b), mm);
    host.append(p.panel);
    return mm;
  };
  const mfa = h('select', { class: 'depinput acx-in', 'data-acx': 'mfa' },
    Object.keys(MFA_WORDS).map((k) => h('option', { value: k }, { admins: 'Owner and Access admins', writers: 'Everyone who can change anything', none: 'Nobody is made to' }[k])));
  mfa.value = cfg.mfa || 'admins';
  const mfaHint = h('span', null, MFA_WORDS[mfa.value]);
  mfa.addEventListener('change', () => { mfaHint.textContent = MFA_WORDS[mfa.value]; });
  one('Who must use two-step sign-in', 'mfa', mfa, mfaHint, () => mfa.value, (v) => `Two-step policy saved: ${MFA_WORDS[v] || v}`, 'Must use it');

  const cash = h('input', { type: 'number', min: '0', step: '100', class: 'depinput acx-in acx-num', value: String(cfg.cash_stepup_aed ?? ''), 'data-acx': 'cash' });
  const cmsg = one('Re-confirming a large cash entry', 'cash_stepup_aed', cash,
    'A single cash entry above this many AED asks the person recording it to confirm it is them first — the password, or the two-step code.',
    () => {
      const n = Number(cash.value);
      if (cash.value === '' || !Number.isFinite(n) || n < 0) { cmsg.set('Enter an amount in AED, 0 or more.', 'bad'); return undefined; }
      return n;
    }, (v) => `Cash entries above AED ${Number(v).toLocaleString('en-US')} now ask the recorder to confirm it is them.`, 'Above, in AED');

  const hours = h('input', { type: 'number', min: '0', max: '168', step: '1', class: 'depinput acx-in acx-num', value: String(cfg.single_owner_delay_hours ?? ''), 'data-acx': 'delay' });
  const hmsg = one('When there is only one Owner', 'single_owner_delay_hours', hours,
    'While sign-in is required and the company has a single Owner, a sensitive role that Owner gives waits this many hours before it takes effect — '
    + 'so one stolen Owner account cannot hand out access at once. 0 turns the wait off. With two Owners, the second approves instead.',
    () => {
      const n = Number(hours.value);
      if (hours.value === '' || !Number.isFinite(n) || n < 0 || n > 168) { hmsg.set('Enter 0 to 168 hours.', 'bad'); return undefined; }
      return n;
    }, (v) => `A sensitive grant by the only Owner now waits ${v} hours.`, 'Hours to wait');

  /* The two driver messages by SMS (src/driver_sms.js). Each can be stopped
     here without a deploy; off also stops the trip messages waiting for 07:00. */
  const smsSwitch = (key, title, sentence, what) => {
    const sel = h('select', { class: 'depinput acx-in', 'data-acx': key },
      h('option', { value: 'on' }, 'On — messages are sent'), h('option', { value: 'off' }, 'Off — nothing is sent'));
    sel.value = cfg[key] === 'off' ? 'off' : 'on';
    one(title, key, sel, sentence, () => sel.value,
      (v) => (v === 'off' ? `${what} are switched off. Nothing more is sent until you switch them on.` : `${what} are on.`), 'Sending');
  };
  smsSwitch('sms_cash', 'Driver text: cash to deposit (05:00)',
    'Every day at 05:00 Dubai, each driver who took cash yesterday is texted: “Please deposit AED X of Uber cash you '
    + 'received yesterday. Talk to your supervisor on WhatsApp.” X is Uber’s own cash-collected figure and the fare on '
    + 'the other channels, and the message names the channels it covers (“Uber and Yango cash”). A channel that did not '
    + 'collect — Bolt, say — is left out and the rest is still sent. It waits until Uber’s figures for yesterday are in, '
    + 'and gives up at 09:00 if they never are. The Messages page shows every message, what each left out, and every '
    + 'one held back, with the reason.', 'Cash reminders');
  smsSwitch('sms_trip', 'Driver text: register a trip',
    'When a journey with no booking is found, the driver it names is texted: “Please Register your trip from X to Y - '
    + 'z km with your supervisor - ADMIN.” Only when exactly one driver is named — the last driver of the car counts, '
    + 'however long ago their last Uber trip was — the trip is 4 km or more, no booking is within 30 minutes and both '
    + 'places have a readable name. Found at night, it waits until 07:00.',
    'Trip messages');

  reportPanel(host, ctx);

  const s = panel('Sessions', null, 'acx-sessions-rule');
  s.body.append(h('p', { class: 'acx-p' }, `A signed-in browser is signed out after ${plural(Math.round((cfg.idle_minutes || 720) / 60), 'hour', 'hours')} without use, `
    + `and after ${plural(cfg.session_days || 7, 'day', 'days')} whatever happens. These two are fixed for now and not changed from here.`));
  host.append(s.panel);
}

/* The 07:00 daily report email (src/daily_report.js): who gets it. The Owner
   and Access admins keep the list; each change is audited. Loaded on its own
   so a slow answer never holds the settings above it. */
function reportPanel(host, ctx) {
  const p = panel('Daily report email', null, 'acx-report');
  const mm = msgLine();
  const listHost = h('div', { class: 'acx-report-list' });
  const runsHost = h('div', { class: 'acx-report-runs' });
  const input = h('input', { type: 'email', class: 'depinput acx-in', placeholder: 'name@company.ae',
    'aria-label': 'Email address to add', 'data-acx': 'report-email', autocomplete: 'off' });
  const add = h('button', { type: 'button', class: 'btn', 'data-acx': 'report-add' }, 'Add');
  const RUN_WORDS = { sent: 'sent to everyone', partial: 'sent to some', failed: 'not sent', composed: 'being sent' };
  const draw = (d) => {
    listHost.replaceChildren(d.recipients.length
      ? h('ul', { class: 'acx-list' }, d.recipients.map((r) => {
        const b = h('button', { type: 'button', class: 'btn', 'data-acx': `report-remove-${r.id}` }, 'Remove');
        b.addEventListener('click', async () => {
          const res = await act(b, mm, () => post(`/api/access/report/recipients/${r.id}/remove`, {}));
          if (!res) return;
          mm.set(`${res.email || r.email} no longer gets the report.`, 'ok');
          load();
        });
        return h('li', { class: 'acx-inrow' }, h('span', null, r.email), h('span', { class: 'acx-dim' }, ` added by ${r.added_by}`), b);
      }))
      : empty('Nobody gets the report yet. Add an address below.'));
    runsHost.replaceChildren(d.runs.length
      ? h('ul', { class: 'acx-list' }, d.runs.map((r) => h('li', null,
        `${dateStr(r.day)} — ${RUN_WORDS[r.status] || r.status}`
        + (r.sent ? ` (${r.sent} sent${r.failed ? `, ${r.failed} not` : ''})` : '')
        + (r.error ? `: ${r.error}` : r.why ? `: ${r.why}` : '')
        + (r.commentary && r.commentary !== 'ok' ? ` · no commentary: ${r.commentary_why || r.commentary}` : ''))))
      : empty('No report has been sent yet. The first goes out at 07:00 Dubai.'));
  };
  const load = async () => {
    try { draw(await getJson('/api/access/report')); } catch (e) { mm.set(explain(e), 'bad'); }
  };
  add.addEventListener('click', async () => {
    const email = input.value.trim();
    if (!email) { mm.set('Type an email address first.', 'bad'); return; }
    const res = await act(add, mm, () => post('/api/access/report/recipients', { email }));
    if (!res) return;
    input.value = '';
    mm.set(`${res.email} will get the report from the next one.`, 'ok');
    load();
  });
  p.body.append(
    h('p', { class: 'acx-p' }, 'Every day at 07:00 Dubai, the day before is emailed to the people below: fares, cash trips, '
      + 'active cars, cars and drivers that earned, the average per driver and per car, and every driver who drove. '
      + 'Two or three sentences at the top are written by GLM 5.2 from those figures alone; every number in them is '
      + 'checked against the figures, and they are left out if one is not.'),
    listHost,
    h('div', { class: 'acx-inrow' }, field('Add someone', input), add),
    mm,
    h('p', { class: 'acx-p' }, h('a', { href: '/api/access/report/preview', target: '_blank', rel: 'noopener' },
      'See yesterday’s email as it would be sent'), ' — without the commentary, which is written when it is sent.'),
    h('h4', { class: 'acx-h4' }, 'The last two weeks'),
    runsHost);
  host.append(p.panel);
  load();
}

