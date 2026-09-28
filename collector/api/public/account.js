/* YOUR ACCOUNT — #account. Who you are here, what you can see, and your own
   sign-in: password, two-step, where you are signed in, the look, and the
   access you asked for.
   ─────────────────────────────────────────────────────────────────────────
   collector/docs/ULM-DESIGN.md §10.2 ("the account menu … your access, a
   read-only list of your grants and their expiries") and §10.5 ("More →
   Account shows your name and fleet scope, and a sign-out"). Every figure on
   this page is read from the server at the moment the page is drawn —
   /api/auth/me, /api/auth/sessions, /api/auth/requests — and every change is
   sent through access.js post(), which carries the CSRF header and, when the
   server answers "confirm it is you", asks for the password or the code and
   retries. The page decides nothing: a button offered here that the server
   then refuses shows the server's own sentence, in place, never a guess.

   ── WHY THE LOOK IS HERE AND NOT IN A SETTINGS STORE ──────────────────────
   The operator, 2026-09-28: "let's do arkiv as the default, and let users
   switch to classic". The switch has to work for somebody who has no account
   (sign-in is optional until the Owner requires it), so it is written to this
   browser first (setLook → localStorage, the key index.html reads before the
   first paint) and, for a signed-in person, to their account as well, which
   app.js applies on any browser they sign in on. Which look is on NOW is read
   from the page contract (ui.js contract(): arkiv.css declares it, app.css
   does not) — never from the skin attribute, which test/arkiv_skin.test.mjs
   forbids any module to branch on.

   ── WHAT IS NOT ON THIS PAGE, AND WHY ─────────────────────────────────────
   There is no "change my name" and no "change my email": no route accepts
   either from the person themselves (an admin renames on Set up → Access),
   and a field that the server would ignore is worse than no field.
   A session is named by the first twelve characters of its token's SHA-256,
   which is what /api/auth/sessions returns: enough to sign one out, nothing a
   thief could use. The token itself never reaches any page.

   The small form kit at the bottom of this file (h, field, msgLine, act,
   oneTimeLink, fleetPicker, roleSelect, endOfDay…) is shared with
   accessadmin.js, which imports it from here: both pages are loaded on
   demand, and this is the one of the two every signed-in person opens. */
import { el, esc, panel, note, tableFrom, dtStr, dateStr, contract } from './ui.js';
import { who, loadWho, getJson, post, signOut, setLook, toSignIn } from './access.js';
import { ROLE, ROLES, CLASS, CLASSES, CAP, rank } from './access_model.js';

/* ═════════════════════════ the page ═════════════════════════ */

export async function accountPage(root, _param, _sub) {
  root.innerHTML = '';
  root.classList.add('acx-page');
  await loadWho();

  if (!who.signedIn) {
    anonymousPanels(root);
    return { title: 'Your account', sub: 'You are not signed in on this browser' };
  }
  if (who.kind === 'device') {
    devicePanel(root);
    return { title: 'This screen', sub: 'A wall display, signed in with its own screen link' };
  }

  if (who.preview) root.append(previewStrip());
  if (who.restricted) {
    /* app.js sends a restricted session to /signin before any page is drawn;
       this is for the phone build and for an address opened directly. The
       server refuses everything but the password and two-step routes until
       the account is set up, so only those two are offered. */
    root.append(note(who.restricted === 'password'
      ? 'Finish setting up your account first: choose your own password below. Until then nothing else here will open.'
      : 'Finish setting up your account first: turn on two-step sign-in below. Your role requires it, and until it is on nothing else here will open.', 'warn'));
    /* Once the step is done the rest of the page can open, so each reloads
       it rather than drawing the next panel into a page built for this one. */
    if (who.restricted === 'password') root.append(passwordPanel({ then: () => location.reload() }));
    else root.append(twoStepPanel({ then: () => location.reload() }));
    root.append(signOutRow());
    return { title: 'Your account', sub: 'Finish setting up your account' };
  }

  root.append(youPanel(), seesPanel());
  if (who.owner) root.append(previewPanel());
  root.append(passwordPanel(), twoStepPanel(), sessionsPanel(), lookPanel(), requestsPanel());
  return { title: 'Your account', sub: `Signed in as ${who.user?.email || ''}` };
}

/* ── not signed in ────────────────────────────────────────────────────── */
function anonymousPanels(root) {
  const p = panel('You are not signed in', null, 'acct-anon');
  p.body.append(el('p', 'acx-p', who.mode === 'enforced'
    ? 'Sign-in is required on FleetMirror. Sign in with the email and password you were given.'
    : 'Sign-in is optional for now: without an account you still see every page, as before. '
      + 'Signed in, the pages follow your role, and your own settings follow you to any browser.'));
  p.body.append(h('div', { class: 'acx-actions' },
    h('button', { type: 'button', class: 'btn primary', onclick: () => toSignIn() }, 'Sign in')));
  root.append(p.panel, lookPanel());
}

function devicePanel(root) {
  const p = panel('This browser is a wall display', null, 'acct-device');
  p.body.append(el('p', 'acx-p', `It is signed in as the screen “${esc(who.device?.name || 'unnamed')}”, with the Wall display role: `
    + 'company totals, live counts and how fresh the data is. It has no password and no person behind it; '
    + 'the Owner or an Access admin can switch it off from Set up → Access → Screens.'));
  root.append(p.panel, lookPanel());
}

function previewStrip() {
  const r = ROLE[who.preview];
  const box = h('div', { class: 'note warn acx-preview-note', 'data-acx': 'preview-on' },
    h('span', null, `You are previewing the ${r?.name || who.preview} role. Every page shows what a ${r?.name || who.preview} sees; nothing can be changed until you end the preview. `),
    h('button', { type: 'button', class: 'btn', onclick: (e) => endPreview(e.currentTarget) }, 'End the preview'));
  return box;
}

async function endPreview(btn, msg = null) {
  const ok = await act(btn, msg, () => post('/api/auth/preview', { role: null }));
  if (ok) location.reload();
}

function signOutRow() {
  return h('div', { class: 'acx-actions acx-signout' },
    h('button', { type: 'button', class: 'btn', onclick: () => signOut() }, 'Sign out'));
}

/* ── you ──────────────────────────────────────────────────────────────── */
function youPanel() {
  const u = who.user || {};
  const p = panel('You', null, 'acct-you');
  const dl = h('dl', { class: 'acx-dl' });
  const row = (k, v) => dl.append(h('dt', null, k), v instanceof Node ? h('dd', null, v) : h('dd', null, String(v)));
  row('Name', u.name ? u.name : h('span', { class: 'dim' }, 'No name on your account. The Owner or an Access admin can add one.'));
  row('Email', u.email || '—');
  row('Last sign-in', u.lastLoginAt ? `${dtStr(u.lastLoginAt)} Dubai` : 'This is the first');
  row('Fleets', fleetScopeText());
  if (who.owner) row('Standing', 'Owner — you can see and do everything, and approve the sensitive grants.');
  p.body.append(dl);

  const grants = who.grants || [];
  p.body.append(h('h4', { class: 'acx-h4' }, 'Your roles'));
  if (!grants.length) {
    p.body.append(el('p', 'acx-p dim', 'You hold no role, so every page is closed to you. Ask the Owner or an '
      + 'Access admin — or use “Ask for access” on any page that says it is not shown to your role.'));
  } else {
    const ul = h('ul', { class: 'acx-list' });
    const teamName = (id) => (who.teams || []).find((t) => t.id === id)?.name;
    for (const g of grants) {
      const r = ROLE[g.role];
      ul.append(h('li', null,
        h('b', null, roleName(g.role)),
        h('span', { class: 'dim' }, ` · ${fleetsText(g.fleets, who.fleets)} · ${g.expires_at ? `until ${dateStr(g.expires_at)}` : 'no end date'}`
          + (g.via === 'team' ? ` · through the team ${teamName(g.team_id) || ''}` : '')),
        r?.desc ? h('div', { class: 'acx-sub' }, r.desc) : null));
    }
    p.body.append(ul);
  }
  const teams = who.teams || [];
  p.body.append(h('h4', { class: 'acx-h4' }, 'Your teams'));
  p.body.append(teams.length
    ? h('ul', { class: 'acx-list' }, teams.map((t) => h('li', null, t.name, t.lead ? h('span', { class: 'dim' }, ' · you lead it') : null)))
    : el('p', 'acx-p dim', 'You are in no team. A team gives its members its roles; yours are given to you directly.'));
  p.body.append(signOutRow());
  return p.panel;
}

function fleetScopeText() {
  const scope = who.access?.scope || [];
  const all = who.fleets || [];
  if (!scope.length) return 'None — your roles cover no fleet yet';
  if (scope.length === all.length) return `Every fleet (${all.map((f) => f.name).join(', ')})`;
  return scope.map((id) => all.find((f) => f.id === id)?.name || id).join(', ');
}

/* What the pages will show this person, class by class — the same levels the
   server shapes every answer with (who.access.levelsAny: on at least one of
   their fleets). Where a level holds on some fleets only, it says so, so a
   reader who sees Egari's cash and not Ecosine's is not left guessing. */
function seesPanel() {
  const a = who.access || {};
  const any = a.levelsAny || {};
  const all = a.levels || {};
  const p = panel('What the pages show you', who.preview
    ? `While you preview, this is the ${esc(roleName(who.preview))} role’s view, not yours.`
    : 'Worked out from your roles. Anything not shown is left out of every page and every download, with the reason printed where it would have been.',
  'acct-sees');
  const groups = [['F', 'In full'], ['M', 'Masked — the last characters only'], ['A', 'Totals only'], ['', 'Not shown']];
  const dl = h('dl', { class: 'acx-dl acx-levels' });
  for (const [lv, label] of groups) {
    const cls = CLASSES.filter((c) => (any[c.code] || '') === lv);
    if (!cls.length) continue;
    dl.append(h('dt', null, label), h('dd', null, cls.map((c) => {
      const partial = lv && (all[c.code] || '') !== lv;
      return `${c.plain}${partial ? ' (on some of your fleets)' : ''}`;
    }).join(', ')));
  }
  p.body.append(dl);
  const caps = a.capsAny || [];
  p.body.append(h('h4', { class: 'acx-h4' }, 'What you can do'));
  p.body.append(caps.length
    ? h('ul', { class: 'acx-list' }, caps.map((c) => h('li', null, CAP[c]?.name || c,
      CAP[c]?.note ? h('span', { class: 'dim' }, ` — ${CAP[c].note}`) : null)))
    : el('p', 'acx-p dim', who.preview ? 'Nothing: a preview is read-only.' : 'Read only: your roles include no action.'));
  return p.panel;
}

/* ── the Owner previews a role ─────────────────────────────────────────── */
function previewPanel() {
  const p = panel('Preview as a role', 'See every page exactly as one role sees it, over every fleet. A preview is read-only: '
    + 'every change is refused until you end it. Starting and ending one is recorded in the audit log.', 'acct-preview');
  const msg = msgLine();
  if (who.preview) {
    p.body.append(el('p', 'acx-p', `Previewing <b>${esc(roleName(who.preview))}</b> now.`),
      h('div', { class: 'acx-actions' },
        h('button', { type: 'button', class: 'btn primary', 'data-acx': 'end-preview', onclick: (e) => endPreview(e.currentTarget, msg) }, 'End the preview'), msg));
    return p.panel;
  }
  const sel = h('select', { class: 'depinput acx-in', id: uid() },
    ROLES.filter((r) => r.code !== 'OWN').map((r) => h('option', { value: r.code }, r.name)));
  const desc = h('p', { class: 'depnote' }, ROLE[sel.value]?.desc || '');
  sel.addEventListener('change', () => { desc.textContent = ROLE[sel.value]?.desc || ''; });
  const btn = h('button', { type: 'button', class: 'btn primary', 'data-acx': 'start-preview' }, 'Preview this role');
  btn.addEventListener('click', async () => {
    const ok = await act(btn, msg, () => post('/api/auth/preview', { role: sel.value }));
    if (ok) location.reload();
  });
  p.body.append(field('Role', sel, desc), h('div', { class: 'acx-actions' }, btn, msg));
  return p.panel;
}

/* ── password ─────────────────────────────────────────────────────────── */
function passwordPanel({ then = null } = {}) {
  const p = panel('Password', 'At least 12 characters. A few ordinary words strung together is stronger than a short '
    + 'word with symbols, and easier to type on a phone.', 'acct-password');
  const form = h('form', { class: 'acx-form', autocomplete: 'on' });
  const user = h('input', { type: 'email', autocomplete: 'username', value: who.user?.email || '', hidden: true, readOnly: true, tabIndex: -1 });
  const cur = h('input', { type: 'password', class: 'depinput acx-in', autocomplete: 'current-password', required: true, id: uid(), name: 'current' });
  const nxt = h('input', { type: 'password', class: 'depinput acx-in', autocomplete: 'new-password', required: true, minLength: 12, id: uid(), name: 'next' });
  const rep = h('input', { type: 'password', class: 'depinput acx-in', autocomplete: 'new-password', required: true, minLength: 12, id: uid(), name: 'repeat' });
  const msg = msgLine();
  const btn = h('button', { type: 'submit', class: 'btn primary' }, 'Change my password');
  form.append(user, field('Current password', cur), field('New password', nxt), field('New password again', rep),
    h('div', { class: 'acx-actions' }, btn, msg));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (nxt.value !== rep.value) { msg.set('The two new passwords are not the same.', 'bad'); return; }
    if (nxt.value.length < 12) { msg.set('Use at least 12 characters.', 'bad'); return; }
    const ok = await act(btn, msg, () => post('/api/auth/password', { current: cur.value, next: nxt.value }));
    if (!ok) return;
    form.reset();
    msg.set('Changed. Every other browser and phone you were signed in on has been signed out; this one stays signed in.', 'ok');
    await loadWho();
    if (then) setTimeout(then, 1200);
  });
  p.body.append(form);
  return p.panel;
}

/* ── two-step sign-in ─────────────────────────────────────────────────── */
function twoStepPanel({ then = null } = {}) {
  const p = panel('Two-step sign-in', null, 'acct-twostep');
  const body = p.body;
  const draw = () => {
    if (then && who.user?.totp) { then(); return; }
    body.innerHTML = '';
    const on = Boolean(who.user?.totp);
    const required = Boolean(who.mfaRequired);
    body.append(h('p', { class: 'acx-p', 'data-acx': 'twostep-state' },
      h('span', { class: `pill ${on ? 'ok' : required ? 'bad' : 'dim'}` }, on ? 'On' : 'Off'), ' ',
      on ? 'Signing in asks for your password and then a six-digit code from the authenticator app on your phone.'
        : 'Signing in asks for your password only. With two-step on, it also asks for a six-digit code from an authenticator app on your phone, so a password alone is not enough to get in.'));
    if (on) {
      if (required) {
        body.append(el('p', 'acx-p dim', 'Your role requires it, so it stays on. If you lose your phone, sign in with one of '
          + 'your recovery codes, or ask the Owner or an Access admin to reset it.'));
        return;
      }
      const msg = msgLine();
      const btn = h('button', { type: 'button', class: 'btn' }, 'Turn two-step sign-in off');
      btn.addEventListener('click', async () => {
        const ok = await act(btn, msg, () => post('/api/auth/totp/disable', {}));
        if (!ok) return;
        await loadWho();
        draw();
      });
      body.append(el('p', 'acx-p dim', 'Turning it off asks you to confirm with a code first.'),
        h('div', { class: 'acx-actions' }, btn, msg));
      return;
    }
    if (required) body.append(note('Your role requires two-step sign-in, so it has to be on before anything else here opens.', 'warn'));
    const msg = msgLine();
    const btn = h('button', { type: 'button', class: 'btn primary', 'data-acx': 'totp-start' }, 'Set up two-step sign-in');
    btn.addEventListener('click', async () => {
      const r = await act(btn, msg, () => post('/api/auth/totp/setup', {}));
      if (r) setupSteps(body, r, draw);
    });
    body.append(h('div', { class: 'acx-actions' }, btn, msg));
  };
  draw();
  return p.panel;
}

/* The secret is shown three ways because people set this up three ways: a
   QR code for a phone camera, the key in groups of four for typing, and the
   otpauth link for somebody reading this ON the phone that holds the app.
   The QR is drawn by the vendored qrcode-generator (api/public/vendor/
   qrcode.js), black on white whatever the theme, because an inverted code is
   one many phone cameras will not read. If that module cannot load, the key
   and the link still work, and the page says the picture is missing. */
async function setupSteps(host, { secret, uri }, done) {
  host.innerHTML = '';
  const grouped = String(secret).replace(/(.{4})/g, '$1 ').trim();
  const qrBox = h('div', { class: 'acx-qr', 'data-acx': 'qr' });
  host.append(h('ol', { class: 'acx-steps' },
    h('li', null, h('p', { class: 'acx-p' }, 'Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password or similar) and add an account by scanning this code:'), qrBox),
    h('li', null, h('p', { class: 'acx-p' }, 'Or, if you cannot scan it, type this key into the app (spaces do not matter):'),
      h('div', { class: 'acx-link-row' }, h('code', { class: 'acx-secret', 'data-acx': 'secret' }, grouped), copyButton(secret, 'Copy the key')),
      h('p', { class: 'depnote' }, 'Reading this on the phone that has the app? ', h('a', { href: uri }, 'Open it in the authenticator app'), '.')),
    h('li', null, h('p', { class: 'acx-p' }, 'Then enter the six-digit code the app now shows for FleetMirror:'))));
  try {
    const { qrcode } = await import('/vendor/qrcode.js');
    const qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    qrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true, alt: 'QR code to add FleetMirror to an authenticator app' });
  } catch {
    qrBox.append(el('p', 'depnote bad', 'The QR picture could not be drawn in this browser — use the key below instead; it does the same.'));
  }
  const code = h('input', { class: 'depinput acx-in acx-code', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 7, id: uid(), 'data-acx': 'totp-code' });
  const msg = msgLine();
  const btn = h('button', { type: 'submit', class: 'btn primary', 'data-acx': 'totp-enable' }, 'Turn it on');
  const cancel = h('button', { type: 'button', class: 'btn', onclick: () => done() }, 'Not now');
  const form = h('form', { class: 'acx-form' }, field('Six-digit code', code), h('div', { class: 'acx-actions' }, btn, cancel, msg));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await act(btn, msg, () => post('/api/auth/totp/enable', { code: code.value.replace(/\s+/g, '') }));
    if (!r) return;
    await loadWho();
    recoveryCodes(host, r.recoveryCodes || [], done);
  });
  host.append(form);
  code.focus?.();
}

function recoveryCodes(host, codes, done) {
  host.innerHTML = '';
  const text = codes.join('\n');
  host.append(
    note('Two-step sign-in is on. Every other browser you were signed in on has been signed out.', 'ok'),
    h('p', { class: 'acx-p' }, h('b', null, 'Your recovery codes. '), 'Each one signs you in once, in place of a code from your phone, '
      + 'if you lose it. Keep them somewhere safe and away from your phone — a password manager, or printed and filed. '
      + 'They are shown this once and cannot be shown again.'),
    h('ul', { class: 'acx-codes', 'data-acx': 'recovery-codes' }, codes.map((c) => h('li', null, h('code', null, c)))),
    h('div', { class: 'acx-actions' },
      copyButton(text, 'Copy all ten'),
      h('button', { type: 'button', class: 'btn', onclick: () => download('fleetmirror-recovery-codes.txt',
        `FleetMirror recovery codes for ${who.user?.email || ''}\nEach works once.\n\n${text}\n`) }, 'Save as a text file'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => done() }, 'I have kept them')));
}

/* ── where you are signed in ──────────────────────────────────────────── */
function sessionsPanel() {
  const p = panel('Where you are signed in', 'Each browser or phone signed in to your account. A session ends by itself after '
    + '12 hours without use or 7 days in all, whichever comes first.', 'acct-sessions');
  const host = h('div');
  const msg = msgLine();
  p.body.append(host, msg);
  const draw = async () => {
    host.innerHTML = '';
    let d;
    try { d = await getJson('/api/auth/sessions'); } catch (e) {
      host.append(note(`The list could not be read: ${e.message}`, 'err'));
      return;
    }
    const rows = (d.sessions || []).map((s) => ({ ...s, current: s.id === d.current }));
    if (!rows.length) { host.append(el('p', 'acx-p dim', 'No session is open — which cannot be true while you read this; reload the page.')); return; }
    host.append(tableFrom(rows, [
      { label: 'Browser', key: 'ua', render: (s) => `${esc(uaSummary(s.ua))}${s.current ? ' <span class="pill ok">this browser</span>' : ''}`
        + (s.view_as ? ` <span class="pill dim">previewing ${esc(roleName(s.view_as))}</span>` : '') },
      { label: 'Address', key: 'ip', render: (s) => `<span class="mono">${esc(s.ip || '—')}</span>` },
      { label: 'Signed in', key: 'created_at', render: (s) => esc(dtStr(s.created_at)) },
      { label: 'Last used', key: 'last_seen_at', render: (s) => esc(dtStr(s.last_seen_at)) },
      { label: 'Ends at the latest', key: 'expires_at', render: (s) => esc(dtStr(s.expires_at)) },
      { label: '', key: 'id', render: (s) => (s.current
        ? '<button type="button" class="btn" data-out="me">Sign out</button>'
        : `<button type="button" class="btn" data-out="${esc(s.id)}">Sign it out</button>`) },
    ], { compact: true, cards: true, cardLead: 'ua' }));
    if (rows.length > 1) {
      host.append(h('div', { class: 'acx-actions' },
        h('button', { type: 'button', class: 'btn', 'data-out': 'all' }, 'Sign out everywhere else')));
    }
  };
  host.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-out]');
    if (!b) return;
    const which = b.dataset.out;
    if (which === 'me') { signOut(); return; }
    const r = await act(b, msg, () => post('/api/auth/sessions/revoke', which === 'all' ? { all: true } : { id: which }));
    if (!r) return;
    msg.set(which === 'all' ? `Signed out ${plural(r.revoked, 'other session', 'other sessions')}.` : 'Signed out.', 'ok');
    draw();
  });
  draw();
  return p.panel;
}

/* ── the look ─────────────────────────────────────────────────────────── */
const LOOKS = [
  { id: 'arkiv', name: 'Arkiv', desc: 'Black on white, numbered sections, and every missing figure’s reason printed where the figure would be. The default.' },
  { id: 'classic', name: 'Classic', desc: 'FleetMirror as it looked before: rounded panels, coloured tiles and a blue accent.' },
];
function lookPanel() {
  const p = panel('Look', who.signedIn && who.kind === 'user'
    ? 'Kept for your account, so it follows you to any browser you sign in on.'
    : 'Kept in this browser.', 'acct-look');
  const now = contract() ? 'arkiv' : 'classic';
  const group = h('div', { class: 'acx-looks', role: 'radiogroup', 'aria-label': 'Look' });
  const msg = msgLine();
  for (const l of LOOKS) {
    const id = uid();
    const input = h('input', { type: 'radio', name: 'acx-look', value: l.id, id, checked: l.id === now, 'data-acx': `look-${l.id}` });
    input.addEventListener('change', async () => {
      if (!input.checked || l.id === now) return;
      msg.set('Switching…');
      await setLook(l.id);
      location.reload();
    });
    group.append(h('label', { class: `acx-look${l.id === now ? ' on' : ''}`, for: id }, input,
      h('span', { class: 'acx-look-t' }, h('b', null, l.name), l.id === now ? h('span', { class: 'dim' }, ' — on now') : null),
      h('span', { class: 'acx-look-d' }, l.desc)));
  }
  p.body.append(group, msg);
  return p.panel;
}

/* ── the access you asked for ─────────────────────────────────────────── */
const REQ_STATE = {
  open: ['waiting for a decision', 'warn'], approved: ['approved', 'ok'],
  declined: ['declined', 'bad'], withdrawn: ['withdrawn', 'dim'],
};
function requestsPanel() {
  const p = panel('Access you asked for', 'From “Ask for access” on a page that said it was not shown to your role. '
    + 'The Owner or an Access admin decides; the answer lands here.', 'acct-requests');
  (async () => {
    let d;
    try { d = await getJson('/api/auth/requests'); } catch (e) {
      p.body.append(note(`Your requests could not be read: ${e.message}`, 'err'));
      return;
    }
    const rows = d.requests || [];
    if (!rows.length) {
      p.body.append(el('p', 'acx-p dim', 'You have not asked for any access. When a page says “not shown to your role”, '
        + 'it offers a box to ask; what you ask and the answer will be listed here.'));
      return;
    }
    p.body.append(tableFrom(rows, [
      { label: 'Asked', key: 'created_at', render: (r) => esc(dtStr(r.created_at)) },
      { label: 'For', key: 'class_code', render: (r) => esc(requestWhat(r)) },
      { label: 'Why you asked', key: 'reason', render: (r) => esc(r.reason || '—') },
      { label: 'Answer', key: 'status', render: (r) => {
        const [t, tone] = REQ_STATE[r.status] || [r.status, 'dim'];
        return `<span class="pill ${tone}">${esc(t)}</span>${r.decided_at ? ` <span class="dim">${esc(dtStr(r.decided_at))}</span>` : ''}`
          + (r.decision_reason ? `<div class="acx-sub">${esc(r.decision_reason)}</div>` : '');
      } },
    ], { compact: true, cards: true, cardLead: 'class_code' }));
  })();
  return p.panel;
}

export function requestWhat(r) {
  const parts = [];
  if (r.class_code) parts.push(CLASS[r.class_code]?.plain || r.class_code);
  if (r.role_code) parts.push(`the ${roleName(r.role_code)} role`);
  if (r.view) parts.push(`on #${r.view}`);
  return parts.join(' · ') || 'unspecified';
}

/* ═════════════════ the form kit, shared with accessadmin.js ═════════════════ */

let seq = 0;
export const uid = () => `acx-${++seq}`;

/* One element, its children, then its properties — in that order so a
   <select>'s value is set after its options exist. `on<event>` binds a
   listener; a non-string value is set as a property (checked, disabled,
   readOnly…); a string becomes an attribute. Children may be nodes, strings
   (always text, never markup) or arrays of either. */
export function h(tag, props = null, ...kids) {
  const n = document.createElement(tag);
  for (const k of kids.flat(3)) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'for') n.htmlFor = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (/^on[a-z]+$/.test(k) && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (typeof v !== 'string' && k in n) n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  return n;
}

/* A labelled control. `hint` is a sentence under it, or a node. */
export function field(label, control, hint = null) {
  if (!control.id) control.id = uid();
  const w = h('div', { class: 'acx-field' }, h('label', { class: 'deplabel', for: control.id }, label), control);
  if (hint) w.append(hint instanceof Node ? hint : h('p', { class: 'depnote' }, hint));
  return w;
}

/* The line a change reports into: the server's own sentence on a refusal,
   in place, next to the button that was pressed. */
export function msgLine() {
  const m = h('p', { class: 'acx-msg', role: 'status', 'aria-live': 'polite' });
  m.set = (text, tone = '') => { m.textContent = text || ''; m.className = `acx-msg${tone ? ` ${tone}` : ''}`; };
  return m;
}

/* Runs one change: the button is held while it is in flight, and a refusal
   is written to `msg` in the server's words. Returns the answer, or null
   when nothing changed. Cancelling the "confirm it is you" dialog is not an
   error the reader made, so it is said plainly as what it is. */
export async function act(btn, msg, fn) {
  if (btn) btn.disabled = true;
  msg?.set?.('');
  try {
    return (await fn()) || { ok: true };
  } catch (e) {
    msg?.set?.(explain(e), 'bad');
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}
export const explain = (e) => (e?.message === 'Not confirmed.'
  ? 'Nothing was changed: you did not confirm it was you.'
  : e?.message || 'The server did not say why.');

export function copyButton(text, label = 'Copy') {
  const b = h('button', { type: 'button', class: 'btn acx-copy' }, label);
  b.addEventListener('click', async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      /* Clipboard refused (an old browser, or a page not served over HTTPS):
         the older route, through a selection. */
      const t = h('textarea', { class: 'acx-offscreen', readOnly: true });
      t.value = text;
      document.body.append(t);
      t.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      t.remove();
    }
    b.textContent = ok ? 'Copied' : 'Select it and copy';
    setTimeout(() => { b.textContent = label; }, 2400);
  });
  return b;
}

function download(name, text) {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* A one-time link (an invitation, a password reset, a wall display's screen
   link): shown this once, because the server keeps only its hash and cannot
   show it again. The full address is printed, not just the path, because it
   is going to be pasted into a message to somebody else. */
export function oneTimeLink({ heading, path, lines = [], key = 'link' }) {
  const url = `${location.origin}${path}`;
  const input = h('input', { class: 'depinput acx-in acx-link-url', readOnly: true, value: url, 'aria-label': heading, 'data-acx': key });
  input.addEventListener('focus', () => input.select());
  return h('div', { class: 'acx-link', 'data-acx': `${key}-box` },
    h('p', { class: 'acx-link-h' }, heading),
    h('div', { class: 'acx-link-row' }, input, copyButton(url, 'Copy the link')),
    lines.filter(Boolean).map((l) => h('p', { class: 'depnote' }, l)));
}

/* ── words for grants, fleets and roles ──────────────────────────────── */
let customNames = {};
/* accessadmin.js hands in the company's own roles once it has read them, so
   a grant of a custom role reads by its name everywhere on both pages. */
export const rememberRoles = (roles = []) => {
  customNames = Object.fromEntries(roles.filter((r) => !ROLE[r.code]).map((r) => [r.code, r.name]));
};
export const roleName = (code) => ROLE[code]?.name || customNames[code] || String(code || '—');

export function fleetsText(fleets, all = []) {
  if (!fleets || !fleets.length) return 'every fleet';
  return fleets.map((id) => all.find((f) => f.id === id)?.name || id).join(', ');
}

/* A browser, as a person names it, from its user-agent string. Order
   matters: Edge and Opera also say "Chrome", and Chrome also says "Safari". */
export function uaSummary(ua) {
  const s = String(ua || '');
  if (!s) return 'Unknown browser';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /HeadlessChrome/.test(s) ? 'Chrome (automated)'
    : /Chrome\//.test(s) ? 'Chrome' : /Firefox\//.test(s) ? 'Firefox' : /Version\/.*Safari/.test(s) ? 'Safari' : 'A browser';
  const os = /iPhone|iPad/.test(s) ? 'iPhone or iPad' : /Android/.test(s) ? 'Android' : /Windows/.test(s) ? 'Windows'
    : /Mac OS X|Macintosh/.test(s) ? 'Mac' : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

export const plural = (n, one, many) => `${Number(n) || 0} ${Number(n) === 1 ? one : many}`;

/* The last moment of a Dubai calendar day, for an end date typed as a day:
   "until 30 Oct" means through the 30th in the city the fleet runs in, not
   midnight UTC — which is 04:00 on the 30th in Dubai. */
export const endOfDay = (d) => (d ? `${d}T23:59:59+04:00` : null);

/* The role chooser. `roles` is the overview's list (built-ins and the
   company's own). Screens' roles are for devices and are left out — a
   person cannot hold one. `mark` names classes to call out beside each role
   that holds them (a request for driver cash lists the roles with cash
   first). */
export function roleSelect(roles, { selected = '', mark = null, blank = 'Choose a role' } = {}) {
  const people = roles.filter((r) => !r.device);
  const holds = (r) => mark && rank(r.levels?.[mark]) > 0;
  const ordered = mark ? [...people.filter(holds), ...people.filter((r) => !holds(r))] : people;
  const sel = h('select', { class: 'depinput acx-in', required: true },
    h('option', { value: '' }, blank),
    ordered.map((r) => h('option', { value: r.code },
      `${r.name}${r.custom ? ' (your company’s own)' : ''}${holds(r) ? ` — includes ${CLASS[mark]?.plain || mark}` : ''}`)));
  sel.value = selected || '';
  return sel;
}

/* The fleet chooser: every fleet — now and any added later — or only the
   ones ticked. The server reads no fleets as every fleet, so "every" sends
   none rather than today's list, which would quietly exclude a fleet added
   next month. */
export function fleetPicker(fleets = [], { name = uid() } = {}) {
  const every = h('input', { type: 'checkbox', checked: true, id: uid(), 'data-acx': 'fleet-every' });
  const boxes = fleets.map((f) => h('input', { type: 'checkbox', value: f.id, id: uid(), name, disabled: true, 'data-fleet': f.id }));
  const list = h('div', { class: 'acx-fleets-only' }, fleets.map((f, i) => h('label', { class: 'acx-check', for: boxes[i].id }, boxes[i], f.name)));
  every.addEventListener('change', () => {
    boxes.forEach((b) => { b.disabled = every.checked; if (every.checked) b.checked = false; });
    list.classList.toggle('off', every.checked);
  });
  list.classList.add('off');
  const node = h('fieldset', { class: 'acx-fleets' }, h('legend', { class: 'deplabel' }, 'Fleets'),
    h('label', { class: 'acx-check', for: every.id }, every, 'Every fleet, including any added later'), list);
  return {
    node,
    /* null = every fleet; [] = none ticked, which the caller refuses. */
    value: () => (every.checked ? null : boxes.filter((b) => b.checked).map((b) => b.value)),
  };
}
