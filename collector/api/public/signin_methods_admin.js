/* Set up → Access: passkeys and single sign-on — the Owner's switches, and
   what a person has.
   ─────────────────────────────────────────────────────────────────────────
   Two pieces, each hooked into accessadmin.js by one line so that file —
   which other work changes too — carries no more of this than that:

     signinMethodsPanel(host, ctx)   Settings: is each method ready on the
                                     platform, is it on, and the Owner's
                                     switches (POST /api/access/config).
     personSigninMethods(u, ctx)     a person's page: their passkeys and
                                     single sign-on link, and the two
                                     actions that take them away
                                     (POST /api/access/users/:id).

   READY IS NOT ON. The platform has to be ready first — PUBLIC_URL for
   passkeys; the provider's issuer, client id and secret for single sign-on,
   all environment variables that no page can set or read (the secret is
   never shown, only whether it is there). The panel says what is missing in
   the platform's own words; the server refuses to switch a method on while
   it is, with the same reason. Every refusal is the server's sentence. */
import { el, note, panel } from './ui.js';
import { getJson, post } from './access.js';
import { h, field, msgLine, act, plural } from './account.js';

const host_ = (u) => { try { return new URL(u).host; } catch { return u || ''; } };
const pill = (on, yes = 'On', no = 'Off') => h('span', { class: `pill ${on ? 'ok' : 'dim'}` }, on ? yes : no);

export function signinMethodsPanel(host, ctx) {
  const p = panel('Passkeys and single sign-on', null, 'acx-signin-methods');
  host.append(p.panel);
  const body = h('div', { 'data-acx': 'signin-methods' });
  p.body.append(body);
  const draw = async (check = false) => {
    let d;
    try { d = await getJson(`/api/access/signin-methods${check ? '?check=1' : ''}`); } catch (e) {
      body.replaceChildren(note(`These settings could not be read: ${e.message}`, 'err'));
      return;
    }
    const owner = Boolean(d.owner);
    const c = d.config || {};
    body.replaceChildren(h('p', { class: 'acx-p' }, 'Two more ways in beside email, password and two-step. Both stay off until the Owner turns them on '
      + '— which to use is the Owner’s decision (ULM-DESIGN §14, decision 3).'));
    if (!owner) body.append(note('Only the Owner changes these. You can read them here.', 'warn'));

    /* passkeys */
    const pk = d.passkeys || {};
    const pkSel = h('select', { class: 'depinput acx-in', disabled: !owner || (!pk.ready && c.passkeys !== 'on'), 'data-acx': 'passkeys' },
      h('option', { value: 'off' }, 'Off'), h('option', { value: 'on' }, 'On — people may add and use passkeys'));
    pkSel.value = c.passkeys === 'on' ? 'on' : 'off';
    const pkMsg = msgLine();
    const pkSave = h('button', { type: 'button', class: 'btn', disabled: !owner, 'data-acx': 'save-passkeys' }, 'Save');
    pkSave.addEventListener('click', async () => {
      const r = await act(pkSave, pkMsg, () => post('/api/access/config', { passkeys: pkSel.value }));
      if (!r) return;
      ctx.say(pkSel.value === 'on' ? 'Passkeys are on: each person can add one on their account page.' : 'Passkeys are off: nobody can sign in with one until they are on again.',
        pkSel.value === 'on' ? 'ok' : 'warn');
      await draw();
    });
    body.append(h('h4', { class: 'acx-h4' }, 'Passkeys ', pill(c.passkeys === 'on')),
      h('p', { class: 'acx-p' }, pk.ready
        ? `Ready: passkeys belong to ${pk.rpId} and work only on ${pk.origin}. ${plural(pk.registered, 'passkey is', 'passkeys are')} registered, by ${plural(pk.people, 'person', 'people')}.`
        : `Not ready: ${pk.why}`),
      h('p', { class: 'acx-p dim' }, 'A passkey signs a person in with their device’s own lock and counts as two-step sign-in. '
        + 'If the site ever moves to another address, passkeys made for this one stop working there.'),
      h('div', { class: 'acx-inrow' }, field('Passkeys', pkSel), pkSave), pkMsg);

    /* single sign-on */
    const s = d.sso || {};
    const ssoSel = h('select', { class: 'depinput acx-in', disabled: !owner || (!s.ready && c.sso !== 'on'), 'data-acx': 'sso' },
      h('option', { value: 'off' }, 'Off'), h('option', { value: 'on' }, `On — “Continue with ${s.name}” on the sign-in page`));
    ssoSel.value = c.sso === 'on' ? 'on' : 'off';
    const domains = h('input', { class: 'depinput acx-in', value: (c.sso_domains || []).join(', '), disabled: !owner, placeholder: 'example.com', 'data-acx': 'sso-domains' });
    const prov = h('select', { class: 'depinput acx-in', disabled: !owner, 'data-acx': 'sso-provision' },
      h('option', { value: 'off' }, 'No — only people who already have an account'),
      h('option', { value: 'on' }, 'Yes — make an account, with no access until someone gives it a role'));
    prov.value = c.sso_provision === 'on' ? 'on' : 'off';
    const sMsg = msgLine();
    const sSave = h('button', { type: 'button', class: 'btn', disabled: !owner, 'data-acx': 'save-sso' }, 'Save');
    sSave.addEventListener('click', async () => {
      const r = await act(sSave, sMsg, () => post('/api/access/config', { sso: ssoSel.value, sso_domains: domains.value, sso_provision: prov.value }));
      if (!r) return;
      ctx.say(ssoSel.value === 'on' ? `Single sign-on is on for ${(r.config?.sso_domains || []).join(', ')}.` : 'Single sign-on is off.', ssoSel.value === 'on' ? 'ok' : 'warn');
      await draw();
    });
    const checkBtn = h('button', { type: 'button', class: 'btn', disabled: !s.ready, 'data-acx': 'sso-check' }, 'Check the provider');
    checkBtn.addEventListener('click', () => draw(true));
    body.append(h('h4', { class: 'acx-h4' }, 'Single sign-on ', pill(c.sso === 'on')),
      h('p', { class: 'acx-p' }, s.ready
        ? `Ready: ${s.name} at ${host_(s.issuer)}, client ${s.clientId}, its secret ${s.secretSet ? 'set' : 'missing'} on the platform. `
          + `The provider must list ${s.redirectUri} as this application’s redirect address. ${plural(s.linked, 'person has', 'people have')} signed in with it.`
        : `Not ready: ${s.why} These are set on the platform, never on a page.`),
      s.provider ? note(s.provider.detail, s.provider.ok ? 'ok' : 'err') : null,
      h('p', { class: 'acx-p dim' }, 'Only an address the provider has verified, on one of the domains below, can sign in this way. '
        + 'Once a person has signed in, the provider’s own id for them decides, so an address given to somebody else later does not open the old account.'),
      field('Company email domains (comma between)', domains),
      field('An address on these domains with no account', prov),
      h('div', { class: 'acx-inrow' }, field('Single sign-on', ssoSel), sSave, checkBtn), sMsg);
  };
  draw();
}

/* A person's passkeys and single sign-on link, on their page. Hidden when
   they have neither — so with the switches off, the page is what it was. */
export function personSigninMethods(u, ctx) {
  const node = h('div', { class: 'acx-action', 'data-action': 'Passkeys and single sign-on', hidden: true });
  const who2 = u.name || u.email;
  (async () => {
    let d;
    try { d = await getJson(`/api/access/users/${u.id}/signin-methods`); } catch { return; }
    const keys = d.passkeys || [];
    const links = d.sso || [];
    if (!keys.length && !links.length) return;
    node.hidden = false;
    node.append(h('h4', { class: 'acx-h4' }, 'Passkeys and single sign-on'));
    if (keys.length) {
      node.append(h('p', { class: 'acx-p' }, `${plural(keys.length, 'passkey', 'passkeys')}: `
        + keys.map((k) => `${k.name || 'Passkey'}${k.disabled_at ? ' (switched off)' : ''}`).join(', ') + '.'));
    }
    for (const l of links) node.append(h('p', { class: 'acx-p' }, `Single sign-on as ${l.email} at ${host_(l.issuer)}.`));
    const msg = msgLine();
    const twice = (label, sure, action, done) => {
      const b = h('button', { type: 'button', class: 'btn', 'data-acx': action }, label);
      let armedAt = 0;
      b.addEventListener('click', async () => {
        if (Date.now() - armedAt > 6000) { armedAt = Date.now(); b.textContent = sure; return; }
        armedAt = 0; b.textContent = label;
        const r = await act(b, msg, () => post(`/api/access/users/${u.id}`, { action }));
        if (!r) return;
        await ctx.reload();
        ctx.say(done);
      });
      return b;
    };
    node.append(h('div', { class: 'acx-actions' },
      keys.length ? twice('Remove their passkeys', 'Press again to remove', 'remove_passkeys', `${who2}’s passkeys are removed and every session they had is ended.`) : null,
      links.length ? twice('Unlink single sign-on', 'Press again to unlink', 'unlink_sso', `${who2}’s single sign-on is unlinked and every session they had is ended.`) : null,
      msg));
    /* WHICH BUTTON FOR WHICH LOSS (review, 2026-11-12). This said "for a lost
       phone, or a mailbox the company gave to somebody else" of both — and
       for the mailbox it is backwards. The link is what refuses the new
       holder of the address (another account at the provider: other_identity
       in signin_methods.js); unlinked, the next verified sign-on for the
       address links afresh, to THIS account. Unlinking is for the provider
       ACCOUNT changing hands or being replaced; a mailbox given away calls
       for offboarding, which no sign-on opens. test/access_passkey_sso §12. */
    node.append(el('p', 'depnote', 'Both sign them out everywhere. Remove their passkeys for a lost or stolen phone or key. '
      + 'Unlink single sign-on when their account at the provider now belongs to somebody else, or was replaced by a new one for them. '
      + 'Do not unlink because their mailbox was given to somebody else: the link is what stops the new holder of the address signing in as them. '
      + 'Offboard this account instead.'));
  })();
  return node;
}
