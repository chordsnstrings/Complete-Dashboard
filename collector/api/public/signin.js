/* /signin — signing in, finishing an account, and the one-time links.
   ═════════════════════════════════════════════════════════════════════════
   collector/docs/ULM-DESIGN.md §5 and §10.1 are the design; api/access/
   routes.js is the whole server side, and decides everything. This page only
   draws what the server said, and every refusal it shows is the server's own
   `detail` sentence, placed next to the form that caused it — never a
   paraphrase that could drift from the rule that produced it.

   ONE DOCUMENT, STEPS NOT MODALS. Each thing a person can be asked to do here
   replaces the one before it in the same column:

     sign in        email + password                 POST /api/auth/login
     code           six digits, or a recovery code   POST /api/auth/login/code
     password       a first password somebody else set must be replaced
                                                     POST /api/auth/password
     two-step       key as a QR, as typed groups, and as an otpauth: link
                                                     POST /api/auth/totp/setup, …/enable
     recovery       the ten codes, shown ONCE        (from …/enable)
     invite/reset   #invite=… / #reset=…             POST /api/auth/link/check, …/accept
     screen         #device=…                        POST /api/auth/device

   After any sign-in the page asks /api/auth/me what is still owed — the
   session is "restricted" to the password or two-step routes until it is
   paid (api/access/middleware.js identify) — and walks the person through
   exactly that, in that order, before sending them on. A dialog would have
   been a second place for the same form, and a phone app has nowhere to
   dismiss one to.

   WHERE IT SENDS YOU. ?back= is where the reader was when the dashboard sent
   them here (access.js toSignIn). It is only ever a path on THIS origin:
   a sign-in page that forwards to any address it is given is an open
   redirect, the classic way to make a phishing link look like it starts at
   the real site. "/" then not "//" is the obvious half. The half that is not
   obvious: the URL parser treats a backslash as a slash and silently drops
   tabs and newlines, so "/\evil.example" and "/\t/evil.example" both become
   "//evil.example"; and dot segments collapse, so "/.//evil.example" parses
   to the pathname "//evil.example". safeBack() refuses those characters
   outright, asks the URL parser whether the origin survived, and then checks
   the path it is about to hand back — not only the one it was given — in
   the same two ways. It also refuses /signin (a loop) and /api/ (a JSON
   answer is not a page).

   A NEW SIGN-IN FORGETS THE LAST READER'S COPIES. The dashboard keeps what
   it read in localStorage (swr.js, 'fleet.swr.v1') and the service worker
   keeps API answers in its '…-data' cache, both so a phone in a car park can
   show the last numbers. Signing OUT clears them (access.js signOut and the
   server's Clear-Site-Data). A session that simply EXPIRED clears nothing —
   so the next person to sign in at that browser would be drawn the previous
   person's figures, from the previous person's role. localStorage is
   partitioned by access.js itself (loadWho → partitionStorage, keyed on who
   is signed in), and this page calls loadWho after every sign-in. The
   service worker's cache is keyed on the URL alone, so this page empties it
   the moment a sign-in succeeds, and waits for that before moving on.

   The house rule holds on this page too: when something cannot be known —
   /api/auth/me did not answer (or took more than twelve seconds), a QR code
   could not be drawn, this very script did not arrive (signin.html says so
   itself) — the page says so and why, and offers what still works, rather
   than drawing a guess. */
import { who, loadWho, getJson, post, signOut, ROLE } from './access.js';

/* ── pure helpers (exported for test/signin_page.test.mjs) ───────────── */

export function safeBack(raw, origin = 'https://fleetmirror.invalid') {
  const s = String(raw ?? '');
  if (!s.startsWith('/') || s.startsWith('//')) return '/';
  if (/[\\\u0000-\u0020\u007f]/.test(s)) return '/';
  let base, u;
  try { base = new URL(origin); u = new URL(s, base); } catch { return '/'; }
  if (u.origin !== base.origin) return '/';
  if (/^\/(?:signin|api)(?:[/.?#]|$)/i.test(u.pathname)) return '/';
  /* The OUTPUT is checked too, because the parser can make a "//" that the
     input never had: dot segments collapse, so "/.//evil.example",
     "/x/..//evil.example" and "/%2e//evil.example" all have the pathname
     "//evil.example" — which location.replace() reads as another host.
     Found by reverting the guards above one at a time, 2026-09-28. */
  const out = `${u.pathname}${u.search}${u.hash}`;
  if (!out.startsWith('/') || out.startsWith('//') || out.includes('\\')) return '/';
  try { if (new URL(out, base).origin !== base.origin) return '/'; } catch { return '/'; }
  return out;
}

/* #invite=TOKEN, #reset=TOKEN, #device=TOKEN. Tokens are base64url. A link
   that went through a chat app sometimes arrives with a full stop or a
   bracket stuck to its end, so the token is the leading run of token
   characters; if that is not long enough to be one, the link is reported as
   incomplete rather than sent to the server to be refused. */
export function readLink(hash) {
  const m = /^#?(invite|reset|device)=(.*)$/s.exec(String(hash || ''));
  if (!m) return null;
  const token = (/^[A-Za-z0-9_-]*/.exec(m[2].trim()) || [''])[0];
  return { kind: m[1], token: token.length >= 16 && token.length <= 256 ? token : null };
}

/* The two-step key, in groups of four for typing. */
export const keyGroups = (secret) => String(secret || '').replace(/\s+/g, '').toUpperCase().match(/.{1,4}/g) || [];

/* What was typed in the code box: six digits, or a recovery code (ten hex
   characters, which the server wants as xxxxx-xxxxx). Spaces are what people
   type to keep their place; a missing dash is what a recovery code copied
   from a password manager's note often loses. */
export function normaliseCode(raw) {
  const s = String(raw || '').replace(/\s+/g, '').toLowerCase();
  if (/^\d{6}$/.test(s)) return { kind: 'totp', code: s };
  const r = /^([0-9a-f]{5})[-‐–]?([0-9a-f]{5})$/.exec(s);
  if (r) return { kind: 'recovery', code: `${r[1]}-${r[2]}` };
  return null;
}

/* The two checks the page can make before asking the server. The server
   makes them again, and the rest (not your email name, not one repeated
   character, not a known-weak password: api/access/crypto.js passwordProblem)
   only there, so its sentence is the one shown for those. */
export function newPasswordProblem(next, confirm) {
  if (String(next || '').length < 12) return 'Use at least 12 characters.';
  if (next !== confirm) return 'The two new passwords are not the same.';
  return null;
}

/* ?why= — the one line that says why the reader is looking at this page. */
export const WHY = Object.freeze({
  expired: 'Your session ended. Sign in again to carry on where you were.',
  signedout: 'You are signed out.',
  required: 'FleetMirror now asks everyone to sign in. Sign in to continue.',
  setup: 'Finish setting up your account to continue.',
});

export const RULES = 'At least 12 characters. A few ordinary words together are long enough and easy to type on a phone. Not your email name.';

/* ── the page ─────────────────────────────────────────────────────────── */
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
const root = () => document.getElementById('signin');

const S = {
  back: '/', why: '', email: '', notice: null, ticket: null, meError: '',
  acts: {},      // what each data-act button in the current step does
};

/* Every field this page draws. The hint is tied to its input with
   aria-describedby, so a screen reader reads the rule with the box. */
function field({ id, label, type = 'text', value = '', auto = '', extra = '', hint = '', show = false, readonly = false, cls = '' }) {
  return `
    <div class="si-field">
      <div class="si-lab"><label for="${id}">${esc(label)}</label>${show
        ? `<button type="button" class="si-show" data-show="${id}" aria-pressed="false" aria-label="Show ${esc(label.toLowerCase())}">Show</button>` : ''}</div>
      <input id="${id}" name="${id}" type="${type}" value="${esc(value)}"${auto ? ` autocomplete="${auto}"` : ''}${readonly ? ' readonly' : ''}${cls ? ` class="${cls}"` : ''}${hint ? ` aria-describedby="${id}-hint"` : ''} ${extra}>
      ${hint ? `<p class="si-hint" id="${id}-hint">${hint}</p>` : ''}
    </div>`;
}
const errLine = '<p class="si-err" role="alert" hidden></p>';
const wait = (text) => `<p class="si-wait" role="status">${esc(text)}</p>`;

function paint(html, { title = 'Sign in', focus = 'input', acts = {} } = {}) {
  const box = root();
  box.innerHTML = html;
  S.acts = acts;
  document.title = `${title} · FleetMirror`;
  const target = focus === 'none' ? null
    : (focus === 'input' ? box.querySelector('input:not([readonly])') : box.querySelector(focus)) || box.querySelector('h1');
  if (target) target.focus();
  return box;
}

/* The notice line: something that just happened, else why the reader is
   here (?why=), else that /api/auth/me did not answer. Each is shown once. */
function notice() {
  let n = S.notice;
  S.notice = null;
  if (!n && S.why) n = { tone: '', text: WHY[S.why] };
  S.why = '';
  if (!n && S.meError) {
    n = { tone: 'bad', text: `Could not check whether this browser is already signed in (${S.meError}). You can still sign in below.` };
    S.meError = '';
  }
  return n ? `<p class="si-note ${n.tone || ''}" role="status">${esc(n.text)}</p>` : '';
}

/* What an error means to the reader. The server's detail when it gave one;
   a failed fetch is a connection that did not happen, and a bare status is
   a server that answered without saying why — each told as exactly that. */
function says(err) {
  if (!err) return 'Something went wrong. Try again.';
  if (err.status === undefined && err.body === undefined && err.name === 'TypeError') {
    return 'FleetMirror could not be reached. Check the connection and try again.';
  }
  const m = String(err.message || '');
  if (/^\d{3}$/.test(m)) return `The server answered ${m} without saying why. Try again in a minute.`;
  return m || 'Something went wrong. Try again.';
}
function showErr(form, text) {
  const p = form.querySelector('.si-err');
  if (!p) return;
  p.textContent = text;
  p.hidden = false;
}

/* One request at a time from a form: the button says what is happening and
   cannot be pressed twice, which on a slow phone is how a one-time code
   gets spent twice and the second attempt refused as a replay. */
async function submitting(form, label, fn) {
  const btn = form.querySelector('button[type="submit"]');
  const was = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = label; }
  form.setAttribute('aria-busy', 'true');
  const p = form.querySelector('.si-err');
  if (p) p.hidden = true;
  try { return await fn(); } finally {
    if (btn?.isConnected) { btn.disabled = false; btn.textContent = was; form.removeAttribute('aria-busy'); }
  }
}

function onClick(e) {
  const t = e.target instanceof Element ? e.target : null;
  const show = t?.closest('[data-show]');
  if (show) {
    const input = document.getElementById(show.dataset.show);
    if (!input) return;
    const on = input.type === 'password';
    input.type = on ? 'text' : 'password';
    show.textContent = on ? 'Hide' : 'Show';
    show.setAttribute('aria-pressed', String(on));
    return;
  }
  const act = t?.closest('[data-act]');
  /* A link opened into a new tab or window is left to the browser. */
  if (act?.tagName === 'A' && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0)) return;
  if (act && S.acts[act.dataset.act]) {
    e.preventDefault();
    S.acts[act.dataset.act](act, e);
  }
}

/* ── who is this browser ──────────────────────────────────────────────
   access.js's `who` is the one copy; loadWho() fills it but never empties
   it, so a field from the last answer (a user, a restriction) would survive
   an answer that no longer carries it. Emptied first, every time. And
   loadWho() swallows a failure by design (the dashboard then behaves as it
   always did); this page has to be able to say it failed, and why, so a
   failed answer is asked for once more through getJson, which keeps the
   server's reason. */
const BLANK = Object.freeze({
  loaded: false, signedIn: false, kind: 'anonymous', mode: 'open', user: null, access: null, roles: [],
  owner: false, preview: null, fleets: [], restricted: null, device: null, now: undefined,
});
function resetWho() { Object.assign(who, BLANK); }
async function refreshWho() {
  resetWho();
  S.meError = '';
  await loadWho();
  if (who.now) return true;
  try {
    Object.assign(who, await getJson('/api/auth/me'), { loaded: true });
    return Boolean(who.now);
  } catch (err) { S.meError = says(err); return false; }
}

/* Awaited, but never for more than a second: an empty cache is a nicety
   for the next reader, not a reason to hold the person at the door. */
async function forgetPreviousReader() {
  try {
    if (typeof caches === 'undefined') return;
    const gone = caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => /-data$/.test(k)).map((k) => caches.delete(k))));
    await Promise.race([gone, new Promise((r) => setTimeout(r, 1000))]);
  } catch { /* no Cache Storage here, or it refused: nothing kept to forget */ }
}

const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
function guardLeaving(on) {
  if (on) window.addEventListener('beforeunload', onBeforeUnload);
  else window.removeEventListener('beforeunload', onBeforeUnload);
}
function leave(path) {
  guardLeaving(false);
  location.replace(path);
}

/* ── where the reader stands, and what to show them ─────────────────── */
function route({ done = false } = {}) {
  if (!who.now) return stepLogin();
  if (who.signedIn && who.kind === 'user') {
    if (who.restricted === 'password') return stepPassword();
    if (who.restricted === 'mfa') return who.user?.totp ? stepCodeAgain() : stepTotp();
    if (done) return leave(S.back);
    S.why = '';
    return stepSignedIn();
  }
  if (who.signedIn && who.kind === 'device') { S.why = ''; return stepSignedIn(); }
  return stepLogin();
}

/* After a password or a code was accepted, or a step was finished: what,
   if anything, is still owed. */
async function afterSignIn(label = 'Signing you in…') {
  paint(wait(label), { title: 'Signing in', focus: 'none' });
  const ok = await refreshWho();
  if (!ok) {
    S.notice = { tone: 'bad', text: `Signed in, but FleetMirror did not say what comes next (${S.meError || 'no answer'}). Reload this page to carry on.` };
    S.meError = '';
    return stepLogin();
  }
  if (!who.signedIn) {
    S.notice = { tone: 'bad', text: 'You signed in, but this browser did not keep the sign-in. FleetMirror needs cookies for this site: allow them, then sign in again.' };
    return stepLogin();
  }
  return route({ done: true });
}

function signedInAs() {
  const email = who.user?.email;
  if (!email) return '';
  return `<div class="si-quiet"><p>Signed in as <b class="si-email">${esc(email)}</b>. <button type="button" class="si-link" data-act="signout">Not you? Sign out</button></p></div>`;
}
const signOutAct = { signout: () => signOut() };

/* ── 1. sign in ───────────────────────────────────────────────────────── */
function stepLogin() {
  const open = Boolean(who.now) && who.mode === 'open' && !who.signedIn;
  const box = paint(`
    <p class="si-eyebrow">Sign in</p>
    <h1 tabindex="-1">Sign in to FleetMirror</h1>
    ${notice()}
    <form class="si-form" id="si-login" novalidate>
      ${field({ id: 'si-email', label: 'Email', type: 'email', value: S.email, auto: 'username',
    extra: 'inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" required' })}
      ${field({ id: 'si-password', label: 'Password', type: 'password', auto: 'current-password', show: true, extra: 'required' })}
      ${errLine}
      <div class="si-actions"><button class="si-btn" type="submit">Sign in</button></div>
    </form>
    <div class="si-quiet">
      <p>Forgot your password? Ask the Owner or an Access admin to send you a reset link.</p>
      ${open ? `<p class="si-open">Signing in is optional for now — you can also <a href="${esc(S.back)}">continue without an account</a>.</p>` : ''}
    </div>`, { title: 'Sign in', focus: S.email ? '#si-password' : 'input' });

  const form = box.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = form.querySelector('#si-email').value.trim();
    const pw = form.querySelector('#si-password');
    if (!email || !pw.value) { showErr(form, 'Enter your email and your password.'); return; }
    S.email = email;
    submitting(form, 'Signing in…', async () => {
      try {
        const r = await post('/api/auth/login', { email, password: pw.value }, { retry: false });
        if (r?.mfa === 'code' && r.ticket) { S.ticket = r.ticket; stepCode(); return; }
        if (r?.ok) { await forgetPreviousReader(); await afterSignIn(); return; }
        showErr(form, 'The server did not confirm the sign-in. Try again.');
      } catch (err) {
        showErr(form, says(err));
        pw.select();
      }
    });
  });
}

/* ── 1b. the second step ─────────────────────────────────────────────── */
function stepCode({ recovery = false } = {}) {
  const box = paint(`
    <p class="si-eyebrow">Two-step sign-in</p>
    <h1 tabindex="-1">Enter your code</h1>
    <p class="si-lede">Signing in as <b class="si-email">${esc(S.email)}</b>.</p>
    ${notice()}
    <form class="si-form" id="si-codeform" novalidate>
      ${field({ id: 'si-code', label: recovery ? 'Recovery code' : 'Code', auto: 'one-time-code', cls: 'code',
    extra: recovery ? 'inputmode="text" autocapitalize="none" autocorrect="off" spellcheck="false" maxlength="16"'
      : 'inputmode="numeric" maxlength="16"',
    hint: 'The six digits your authenticator app shows for FleetMirror — or, without your phone, one of your recovery codes (xxxxx-xxxxx). Each recovery code works once.' })}
      ${errLine}
      <div class="si-actions"><button class="si-btn" type="submit">Continue</button></div>
    </form>
    <div class="si-quiet">
      <p><button type="button" class="si-link" data-act="toggle">${recovery ? 'Use the code from your app instead' : 'Use a recovery code instead'}</button></p>
      <p><button type="button" class="si-link" data-act="restart">Start again</button></p>
    </div>`, {
    title: 'Enter your code',
    acts: {
      toggle: () => stepCode({ recovery: !recovery }),
      restart: () => { S.ticket = null; stepLogin(); },
    },
  });

  const form = box.querySelector('form');
  const input = form.querySelector('#si-code');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = normaliseCode(input.value);
    if (!n) { showErr(form, 'Enter the six digits from your app, or a recovery code of ten letters and digits (xxxxx-xxxxx).'); return; }
    submitting(form, 'Checking…', async () => {
      try {
        const r = await post('/api/auth/login/code', { ticket: S.ticket, code: n.code }, { retry: false });
        if (r?.ok) { S.ticket = null; await forgetPreviousReader(); await afterSignIn(); return; }
        showErr(form, 'The server did not confirm the code. Try again.');
      } catch (err) {
        /* The ticket is gone (five minutes, or five wrong codes): the
           password has to be given again, so say why on the first step. */
        if (['expired', 'slow_down'].includes(err.body?.error)) {
          S.ticket = null;
          S.notice = { tone: 'bad', text: says(err) };
          stepLogin();
          return;
        }
        showErr(form, says(err));
        input.select();
      }
    });
  });
}

/* A session whose person has two-step on but which never gave a code (one
   that predates the code being turned on, where the server did not end it).
   Only a fresh sign-in can prove the second factor, so end this one. */
async function stepCodeAgain() {
  S.email = who.user?.email || S.email;
  try { await post('/api/auth/logout', {}, { retry: false }); } catch { /* ended either way */ }
  resetWho();
  await refreshWho();
  S.notice = { tone: '', text: 'Sign in again and enter the code from your authenticator app.' };
  stepLogin();
}

/* ── 2a. a password somebody else set ────────────────────────────────── */
function stepPassword() {
  const email = who.user?.email || '';
  const first = Boolean(who.user?.mustChangePassword);
  const box = paint(`
    <p class="si-eyebrow">${first ? 'First sign-in' : 'New password'}</p>
    <h1 tabindex="-1">Choose your own password</h1>
    <p class="si-lede">${first ? 'You signed in with a password somebody else set.' : 'This account needs a new password.'} Choose one only you know before you continue.</p>
    ${notice()}
    <form class="si-form" id="si-pwform" novalidate>
      ${field({ id: 'si-account', label: 'Account', type: 'email', value: email, auto: 'username', readonly: true })}
      ${field({ id: 'si-current', label: 'Current password', type: 'password', auto: 'current-password', show: true })}
      ${field({ id: 'si-new', label: 'New password', type: 'password', auto: 'new-password', show: true, hint: esc(RULES) })}
      ${field({ id: 'si-confirm', label: 'New password again', type: 'password', auto: 'new-password', show: true })}
      ${errLine}
      <div class="si-actions"><button class="si-btn" type="submit">Save password</button></div>
    </form>
    ${signedInAs()}`, { title: 'Choose your password', acts: signOutAct });

  const form = box.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const current = form.querySelector('#si-current').value;
    const next = form.querySelector('#si-new').value;
    const confirm = form.querySelector('#si-confirm').value;
    if (!current) { showErr(form, 'Enter your current password — the one you just signed in with.'); return; }
    const problem = newPasswordProblem(next, confirm);
    if (problem) { showErr(form, problem); return; }
    submitting(form, 'Saving…', async () => {
      try {
        await post('/api/auth/password', { current, next }, { retry: false });
        S.notice = { tone: 'good', text: 'Your new password is saved.' };
        await afterSignIn('Saving…');
      } catch (err) { showErr(form, says(err)); }
    });
  });
}

/* ── 2b. two-step set-up ──────────────────────────────────────────────
   The key reaches the phone three ways, because the reader is on one of two
   devices and does not know which way their app wants it: a QR code for a
   laptop screen, the otpauth: link for the phone itself (a phone cannot scan
   its own screen; tapping the link hands the key to the authenticator), and
   the key typed in groups of four for everything else. The QR is drawn HERE,
   from the vendored generator (vendor/qrcode.js) — never by a QR web service,
   which would be handing the second factor to a third party. */
async function drawQr(text) {
  const { default: qrcode } = await import('/vendor/qrcode.js');
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  /* margin = four modules: the quiet zone the standard asks for, inside the
     SVG's own white ground, so the code scans whatever the page colour is. */
  return q.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
}

const TOTP_HEAD = `
    <p class="si-eyebrow">Two-step sign-in</p>
    <h1 tabindex="-1">Set up two-step sign-in</h1>
    <p class="si-lede">Your role needs a second step when you sign in: a six-digit code from an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password.</p>`;

async function stepTotp() {
  /* The notice (say, "your new password is saved") is taken once and drawn
     on both paints of this step, the wait and the finished one. */
  const note = notice();
  paint(`${TOTP_HEAD}${note}${wait('Making your key…')}`, { title: 'Set up two-step sign-in', focus: 'h1' });
  let setup;
  try {
    setup = await post('/api/auth/totp/setup', {}, { retry: false });
  } catch (err) {
    if (err.body?.error === 'already') { await afterSignIn(); return; }
    paint(`${TOTP_HEAD}<p class="si-note bad" role="status">${esc(says(err))}</p>
      <div class="si-actions"><button type="button" class="si-btn" data-act="retry">Try again</button></div>${signedInAs()}`,
    { title: 'Set up two-step sign-in', focus: 'h1', acts: { ...signOutAct, retry: () => stepTotp() } });
    return;
  }
  let qr = '';
  let qrWhy = '';
  try { qr = await drawQr(setup.uri); } catch (err) {
    qrWhy = `The QR code could not be drawn on this device (${String(err?.message || err).slice(0, 120)}). Type the key below into your app instead.`;
  }
  const groups = keyGroups(setup.secret);
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  /* On a phone the link is the way in, so it is the first, filled button.
     On a laptop it usually opens nothing (no authenticator is registered for
     otpauth: there), so it is a quiet line under the key, for the reader
     whose laptop does have one. */
  const open = coarse
    ? `<a class="si-btn" id="si-otpauth" href="${esc(setup.uri)}" rel="noreferrer">Open in authenticator app</a>`
    : `<p class="si-or">Authenticator on this computer? <a class="si-link" id="si-otpauth" href="${esc(setup.uri)}" rel="noreferrer">Open it with the key filled in</a></p>`;
  const box = paint(`${TOTP_HEAD}${note}
    <ol class="si-steps">
      <li>
        <span class="si-label">Add FleetMirror to your app</span>
        ${coarse ? `${open}<p class="si-or">On this phone, the button above opens your authenticator app with the key filled in. From another device, scan:</p>` : '<p class="si-or">Scan this code with the app:</p>'}
        ${qr ? `<div class="si-qr" id="si-qr" role="img" aria-label="QR code that adds FleetMirror to an authenticator app">${qr}</div>`
    : `<p class="si-note bad" role="status">${esc(qrWhy)}</p>`}
        <p class="si-or">Or type this key into the app (time-based, six digits):</p>
        <p class="si-key" id="si-secret">${groups.map((g) => `<span>${esc(g)}</span>`).join(' ')}</p>
        <div class="si-row">
          <button type="button" class="si-btn ghost" data-act="copykey">Copy key</button>
          <span class="si-status" role="status"></span>
        </div>
        ${coarse ? '' : open}
      </li>
      <li>
        <span class="si-label">Enter the code the app shows</span>
        <form class="si-form" id="si-totpform" novalidate>
          ${field({ id: 'si-totp', label: 'Six-digit code', auto: 'one-time-code', cls: 'code', extra: 'inputmode="numeric" maxlength="7"' })}
          ${errLine}
          <div class="si-actions"><button class="si-btn" type="submit">Turn on two-step sign-in</button></div>
        </form>
      </li>
    </ol>
    ${signedInAs()}`, {
    title: 'Set up two-step sign-in',
    focus: 'h1',
    acts: {
      ...signOutAct,
      copykey: (btn) => copy(groups.join(''), btn.parentElement.querySelector('.si-status'), 'Key copied.'),
    },
  });

  const form = box.querySelector('form');
  const input = form.querySelector('#si-totp');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = input.value.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(code)) { showErr(form, 'Enter the six digits the app shows now.'); return; }
    submitting(form, 'Checking…', async () => {
      try {
        const r = await post('/api/auth/totp/enable', { code }, { retry: false });
        if (Array.isArray(r?.recoveryCodes) && r.recoveryCodes.length) { stepRecovery(r.recoveryCodes); return; }
        /* On, but no codes came back: say so rather than pretend. */
        S.notice = { tone: 'bad', text: 'Two-step sign-in is on, but no recovery codes came back. Ask the Owner or an Access admin to reset your two-step sign-in if you ever lose your phone.' };
        await afterSignIn();
      } catch (err) { showErr(form, says(err)); input.select(); }
    });
  });
}

/* Copying: the Clipboard API where the page is allowed it (https, or
   localhost), else a selection and the old command; and if both are refused,
   the text stays on screen, selected, with a line saying to copy it by hand. */
async function copy(text, status, done) {
  const say = (t) => { if (status) status.textContent = t; };
  try {
    await navigator.clipboard.writeText(text);
    say(done);
    return;
  } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  say(ok ? done : 'This browser would not copy. Select the text and copy it by hand.');
}

/* ── 2c. the recovery codes, once ─────────────────────────────────────── */
function stepRecovery(codes) {
  const email = who.user?.email || S.email;
  guardLeaving(true);
  paint(`
    <p class="si-eyebrow">Two-step sign-in is on</p>
    <h1 tabindex="-1">Save your recovery codes</h1>
    <p class="si-save"><b>Save these now.</b> This is the only time they are shown: FleetMirror keeps only a scrambled copy, and cannot show them to you or anyone else again.</p>
    <p class="si-lede">If you lose your phone, each code signs you in once in place of the app's code. Keep them in a password manager or on paper — not on the phone that has the app.</p>
    <ol class="si-codes" id="si-codes" aria-label="Recovery codes">${codes.map((c, i) => `<li data-n="${i + 1}.">${esc(c)}</li>`).join('')}</ol>
    <div class="si-row"><button type="button" class="si-btn ghost" data-act="copycodes">Copy codes</button><span class="si-status" role="status"></span></div>
    <div class="si-actions" style="margin-top:22px"><button type="button" class="si-btn" data-act="saved">I have saved them — continue</button></div>`, {
    title: 'Save your recovery codes',
    focus: 'h1',
    acts: {
      copycodes: (btn) => copy(`FleetMirror recovery codes for ${email}\nEach code works once.\n\n${codes.join('\n')}\n`,
        btn.parentElement.querySelector('.si-status'), 'Codes copied. Paste them somewhere safe now.'),
      saved: () => { guardLeaving(false); afterSignIn('Opening FleetMirror…'); },
    },
  });
}

/* ── signed in already ────────────────────────────────────────────────── */
function stepSignedIn() {
  if (who.kind === 'device') {
    paint(`
      <p class="si-eyebrow">Screen</p>
      <h1 tabindex="-1">This screen is signed in</h1>
      ${notice()}
      <p class="si-who">This screen is signed in as <b>${esc(who.device?.name || 'a screen')}</b>. It shows only what that screen is allowed to see.</p>
      <div class="si-actions"><a class="si-btn" href="${esc(S.back)}" data-act="continue">Continue</a></div>
      <div class="si-quiet">
        <p>To stop this screen, the Owner or an Access admin revokes it on the Access page.</p>
        <p><button type="button" class="si-link" data-act="person">Sign in as a person on this browser</button></p>
      </div>`,
    /* A person's session outranks the screen's (middleware.js identify reads
       fm_sid before fm_dev), so a person can sign in here without removing
       the screen, and the screen comes back when they sign out. */
    { title: 'Signed in', focus: 'h1', acts: { continue: () => leave(S.back), person: () => stepLogin() } });
    return;
  }
  const u = who.user || {};
  const roles = (who.roles || []).map((r) => ROLE[r]?.name || r);
  paint(`
    <p class="si-eyebrow">Signed in</p>
    <h1 tabindex="-1">You are signed in</h1>
    ${notice()}
    <p class="si-who">Signed in as <b class="si-email">${esc(u.email)}</b>${u.name ? ` (${esc(u.name)})` : ''}.${roles.length
    ? `<span class="si-roles">${esc(roles.join(' · '))}</span>` : ''}</p>
    <div class="si-actions">
      <a class="si-btn" href="${esc(S.back)}" data-act="continue">Continue</a>
      <button type="button" class="si-btn ghost" data-act="signout">Sign out</button>
    </div>`, { title: 'Signed in', focus: 'h1', acts: { ...signOutAct, continue: () => leave(S.back) } });
}

/* ── the one-time links ───────────────────────────────────────────────── */
function stepBadLink(text) {
  paint(`
    <p class="si-eyebrow">Link</p>
    <h1 tabindex="-1">This link cannot be used</h1>
    <p class="si-note bad" role="status">${esc(text)}</p>
    <div class="si-actions"><button type="button" class="si-btn" data-act="tologin">Go to sign in</button></div>`,
  { title: 'Link', focus: 'h1', acts: { tologin: () => route() } });
}

function openLink(link) {
  if (!link.token) {
    return stepBadLink('This link is incomplete. Open it again from the message you were sent, making sure the whole link is used.');
  }
  return link.kind === 'device' ? stepDevice(link.token) : stepLink(link.token);
}

/* The account under the link is whatever the SERVER says the link is for —
   an invite re-sent to somebody who never finished is issued as an invite
   whatever the address said — so the page follows `purpose`, not the word
   in the fragment. */
async function stepLink(token) {
  paint(wait('Checking your link…'), { title: 'Link', focus: 'none' });
  let l;
  try { l = await post('/api/auth/link/check', { token }, { retry: false }); } catch (err) { stepBadLink(says(err)); return; }
  const invite = l.purpose === 'invite';
  /* This browser may already be signed in as somebody else — the person who
     sent the invite, testing it. Setting the password here ends nothing of
     theirs by itself, but the next step signs the NEW person in on this
     browser, so say so before, not after. */
  const other = who.signedIn && who.kind === 'user' && who.user?.email && who.user.email.toLowerCase() !== String(l.email).toLowerCase()
    ? who.user.email : null;
  const box = paint(`
    <p class="si-eyebrow">${invite ? 'New account' : 'Password reset'}</p>
    <h1 tabindex="-1">${invite ? 'Set up your FleetMirror account' : 'Choose a new password'}</h1>
    <p class="si-lede">${invite
    ? 'You have been invited to FleetMirror. Say how your name should appear to colleagues, and choose a password.'
    : 'Choose a new password for this account. Every place it is signed in now will be signed out.'}</p>
    ${other ? `<p class="si-note" role="status">This browser is signed in as ${esc(other)}. Finishing here signs that session out on this browser.</p>` : ''}
    <form class="si-form" id="si-linkform" novalidate>
      ${field({ id: 'si-account', label: 'Account', type: 'email', value: l.email, auto: 'username', readonly: true })}
      ${invite ? field({ id: 'si-name', label: 'Your name', value: l.name || '', auto: 'name', extra: 'maxlength="120" autocapitalize="words"' }) : ''}
      ${field({ id: 'si-new', label: 'New password', type: 'password', auto: 'new-password', show: true, hint: esc(RULES) })}
      ${field({ id: 'si-confirm', label: 'New password again', type: 'password', auto: 'new-password', show: true })}
      ${errLine}
      <div class="si-actions"><button class="si-btn" type="submit">${invite ? 'Create my account' : 'Save new password'}</button></div>
    </form>`, { title: invite ? 'Set up your account' : 'Choose a new password' });

  const form = box.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = invite ? form.querySelector('#si-name').value.trim() : '';
    const password = form.querySelector('#si-new').value;
    const problem = newPasswordProblem(password, form.querySelector('#si-confirm').value);
    if (problem) { showErr(form, problem); return; }
    submitting(form, 'Saving…', async () => {
      let r;
      try { r = await post('/api/auth/link/accept', { token, name, password }, { retry: false }); } catch (err) { showErr(form, says(err)); return; }
      /* Whoever this browser was signed in as — somebody else, or this very
         person, whose sessions the new password has just ended — that
         session is over here: end it properly rather than orphan it. */
      if (who.signedIn && who.kind === 'user') {
        try { await post('/api/auth/logout', {}, { retry: false }); } catch { /* ended either way */ }
      }
      await refreshWho();
      S.email = r?.email || l.email;
      S.notice = { tone: 'good', text: 'Your password is set — sign in.' };
      stepLogin();
    });
  });
}

/* A wall screen. Its token becomes a cookie (fm_dev), but a PERSON's session
   on the same browser outranks it (middleware.js identify reads fm_sid
   first) — so "this screen is signed in" would be untrue while somebody is.
   Asked, never done silently. */
function stepDevice(token) {
  if (who.signedIn && who.kind === 'user') {
    paint(`
      <p class="si-eyebrow">Screen</p>
      <h1 tabindex="-1">Make this browser a screen?</h1>
      <p class="si-lede">This is a link for a wall screen. This browser is signed in as <b class="si-email">${esc(who.user?.email)}</b>, and while it is, it keeps showing what that person sees — not what the screen is allowed to.</p>
      <div class="si-actions">
        <button type="button" class="si-btn" data-act="go">Sign out and make this browser the screen</button>
        <button type="button" class="si-btn ghost" data-act="cancel">Cancel</button>
      </div>`, {
      title: 'Screen',
      focus: 'h1',
      acts: {
        go: async () => {
          try { await post('/api/auth/logout', {}, { retry: false }); } catch { /* ended either way */ }
          await refreshWho();
          doDevice(token);
        },
        cancel: () => route(),
      },
    });
    return;
  }
  doDevice(token);
}
async function doDevice(token) {
  paint(wait('Signing this screen in…'), { title: 'Screen', focus: 'none' });
  let r;
  try { r = await post('/api/auth/device', { token }, { retry: false }); } catch (err) { stepBadLink(says(err)); return; }
  await forgetPreviousReader();
  await refreshWho();
  paint(`
    <p class="si-eyebrow">Screen</p>
    <h1 tabindex="-1">This screen is signed in</h1>
    <p class="si-who">This screen is signed in as <b>${esc(r?.name || who.device?.name || 'a screen')}</b>. It shows only what that screen is allowed to see.</p>
    <div class="si-actions"><a class="si-btn" href="/" data-act="continue">Continue</a></div>`,
  { title: 'Screen signed in', focus: 'h1', acts: { continue: () => leave('/') } });
}

/* The link out of the fragment: normally already taken by the inline script
   in signin.html before anything loaded; here for a link pasted into an
   open /signin tab (hashchange), and as the fallback if that script did not
   run. */
function takeLink() {
  let l = null;
  if (typeof window !== 'undefined' && window.FM_SIGNIN_LINK) {
    const { kind, token } = window.FM_SIGNIN_LINK;
    delete window.FM_SIGNIN_LINK;
    l = readLink(`#${kind}=${token}`);
  }
  const h = readLink(location.hash);
  if (h) {
    try { history.replaceState(history.state, '', `${location.pathname}${location.search}`); } catch { location.hash = ''; }
    l = h;
  }
  return l;
}

export async function start() {
  const q = new URLSearchParams(location.search);
  S.back = safeBack(q.get('back'), location.origin);
  const why = q.get('why') || '';
  S.why = Object.prototype.hasOwnProperty.call(WHY, why) ? why : '';
  root().dataset.ready = '1';
  root().addEventListener('click', onClick);
  window.addEventListener('hashchange', () => {
    const l = takeLink();
    if (l) openLink(l);
  });
  const link = takeLink();
  /* A /api/auth/me that never answers (a database too busy to take the
     query) would leave "Checking…" on screen for as long as the browser
     waits. Twelve seconds, then the form, saying why. */
  const answered = await Promise.race([refreshWho().then(() => true), new Promise((r) => { setTimeout(() => r(false), 12_000); })]);
  if (!answered) S.meError = 'no answer after 12 seconds';
  if (link) return openLink(link);
  return route();
}

if (typeof document !== 'undefined' && document.getElementById('signin')) start();
