/* SET UP → FLEET NAMES — #fleet-names[/<tab>]. What each fleet is called,
   where that name came from, and which platform accounts belong to which
   fleet.
   ─────────────────────────────────────────────────────────────────────────
   collector/docs/ULM-DESIGN.md §3 is the rule and §10.3 the screen. The
   operator's rulings (2026-09-26): a fleet's name is taken FROM the platforms;
   the name shown is the brand, the common part of what they call it; nothing
   is typed and nothing is hard-coded; every id is the real one.

   THREE ADDRESSES, NOT MODALS:
     #fleet-names            every fleet: its brand, the platform names it came
                             from (each with its platform — the legal names
                             finance needs), its accounts with their real ids,
                             its rename history, and "Choose the name"
     #fleet-names/accounts   every account a platform reported: new ones first
                             ("New: CABMAN company “Sahalat” — link to a fleet,
                             start a new fleet, or ignore"), the evidence, and
                             what each would do to who sees what
     #fleet-names/changes    links waiting for an Owner, with who gains and who
                             loses sight of the rows

   WHO SEES WHAT. The names are for everyone (GET /api/fleets is SYS, which
   every role holds): a dispatcher who wonders why the picker says "Egari"
   can read that Uber calls it "Egari Luxury Cars Transport LLC". The
   accounts are platform logins' territory (CRED): the Connections admin and
   the Owner. The plates and drivers behind the evidence counts open for the
   Owner only; a Connections admin "sees no driver". The server decides all
   of it (api/fleet_names_routes.js); this page draws what it decided, and a
   refusal is printed in the server's own words beside the button pressed.

   CHOOSE, NEVER TYPE. "Choose the name" offers only runs of words the
   platforms send (§3.2 rule 6) — there is no text box for a name, on purpose.

   A LINK WAITS FOR AN OWNER, and the page says why every time: which fleet
   an account belongs to changes who can see its rows. Before anything is
   sent, the change is tried as a dry run and the page shows who would gain
   and who would lose sight of it; only then is it sent for approval.

   EMPTY IS A SENTENCE. Every list that can be empty says what would appear
   in it and how it gets there. */
import { el, esc, panel, note, tableFrom, tabBar, dtStr, pill, entity } from './ui.js';
import { who, loadWho, getJson, post, closedBlock, toSignIn } from './access.js';

const TABS = [
  { id: 'fleets', label: 'Fleets', sub: 'Each fleet’s name, taken from what its platforms call it — never typed' },
  { id: 'accounts', label: 'Accounts', sub: 'Every account a platform reported, and which fleet it belongs to' },
  { id: 'changes', label: 'Waiting for an Owner', sub: 'Links that change who can see which rows, waiting for an Owner' },
];
const TAB = Object.fromEntries(TABS.map((t) => [t.id, t]));
const hrefOf = (id) => (id === 'fleets' ? '#fleet-names' : `#fleet-names/${id}`);

/* ── small DOM helpers, kept here so this page depends only on ui.js and
   access.js (the shared modules), not on another page's internals ─────── */
function h(tag, props = null, ...kids) {
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
      else n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  return n;
}
let seq = 0;
const uid = () => `fnx-${++seq}`;
function field(label, control, hint = null) {
  if (!control.id) control.id = uid();
  const w = h('div', { class: 'acx-field' }, h('label', { class: 'deplabel', for: control.id }, label), control);
  if (hint) w.append(hint instanceof Node ? hint : h('p', { class: 'depnote' }, hint));
  return w;
}
function msgLine() {
  const m = h('p', { class: 'acx-msg', role: 'status', 'aria-live': 'polite' });
  m.set = (text, tone = '') => { m.textContent = text || ''; m.className = `acx-msg${tone ? ` ${tone}` : ''}`; };
  return m;
}
const explain = (e) => (e?.message === 'Not confirmed.'
  ? 'Nothing was changed: you did not confirm it was you.' : e?.message || 'The server did not say why.');
async function act(btn, msg, fn) {
  if (btn) btn.disabled = true;
  msg?.set?.('');
  try { return (await fn()) || { ok: true }; } catch (e) { msg?.set?.(explain(e), 'bad'); return null; } finally { if (btn) btn.disabled = false; }
}
const empty = (text) => h('p', { class: 'acx-p acx-empty' }, text);
const plural = (n, one, many) => `${Number(n) || 0} ${Number(n) === 1 ? one : many}`;
const nf = (n) => Number(n || 0).toLocaleString('en-US');

const BASIS = {
  brand: ['from the platforms', 'ok', 'The brand: the words every platform name starts with, cut at the first trade word.'],
  chosen: ['chosen', 'plat', 'Chosen from the platforms’ own words by the Connections admin or the Owner.'],
  disagree: ['the platforms disagree', 'warn', 'No word is common to every name the platforms report, so every name is shown.'],
  unnamed: ['unnamed', 'warn', 'No linked account reports a name.'],
};
const LINKED_BY = { configuration: 'by configuration', person: 'by an Owner' };

/* ═════════════════════════ the page ═════════════════════════ */
export async function fleetsPage(root, param, sub) {
  root.innerHTML = '';
  root.classList.add('acx-page', 'fnx-page');
  await loadWho();
  const tabId = TAB[param] ? param : 'fleets';
  const signedUser = who.signedIn && who.kind === 'user';
  const canRead = signedUser && (Boolean(who.access?.levelsAny?.CRED) || (who.access?.capsAny || []).includes('fleets.link'));

  const bar = h('div');
  const status = h('div', { 'data-fnx': 'discovery' });
  const flash = h('div', { class: 'acx-flash', 'data-fnx': 'flash' });
  const host = h('div', { class: 'acx-tab', 'data-fnx-tab': tabId });
  root.append(bar, status, flash, host);

  const ctx = { flash, host, canRead, signedUser, tabId, sub };
  let pending = null; let reloading = false;
  const paint = () => { if (pending) { flash.replaceChildren(note(...pending)); pending = null; } };
  ctx.say = (text, tone = 'ok') => { pending = [text, tone]; queueMicrotask(() => { if (!reloading) paint(); }); };
  ctx.reload = async () => {
    reloading = true;
    try {
      let names;
      try { names = await getJson('/api/fleets'); } catch (e) {
        host.replaceChildren(note(`The fleet names could not be read: ${e.message}`, 'err'));
        return;
      }
      ctx.names = names;
      ctx.fleetName = (id) => names.fleets.find((f) => f.id === id)?.name || id || '—';
      ctx.acc = null; ctx.accErr = null;
      if (canRead) {
        try { ctx.acc = await getJson('/api/fleets/accounts'); } catch (e) { ctx.accErr = e; }
      }
      const waiting = (ctx.acc?.changes || []).filter((c) => c.status === 'pending').length;
      const newOnes = (ctx.acc?.accounts || []).filter((a) => a.status === 'new').length;
      bar.replaceChildren(tabBar(TABS.map((t) => ({ ...t,
        label: t.id === 'changes' && waiting ? `${t.label} · ${waiting}` : t.id === 'accounts' && newOnes ? `${t.label} · ${newOnes} new` : t.label })),
      tabId, hrefOf));
      status.replaceChildren(discoveryLine(names.discovery));
      host.replaceChildren();
      if (tabId === 'fleets') fleetsTab(host, ctx);
      else if (!canRead) host.append(accountsClosed());
      else if (ctx.accErr) host.append(note(`The platform accounts could not be read: ${ctx.accErr.message}`, 'err'));
      else if (tabId === 'accounts') accountsTab(host, ctx);
      else changesTab(host, ctx);
    } finally {
      reloading = false;
      paint();
    }
  };
  await ctx.reload();
  return { title: 'Fleet names', sub: TAB[tabId].sub };
}

/* When the platforms were last asked, and what each said — the page's
   first line, because a name can only be as current as that. */
function discoveryLine(d) {
  const box = h('div', { class: 'acx-p' });
  if (!d?.lastRun) {
    box.append(note(d?.reason || 'The platforms have not been asked for their names yet.', 'warn'));
    return box;
  }
  const bad = (d.steps || []).flatMap((s) => (s.ok ? (Array.isArray(s.notes) ? s.notes : []).filter((n) => n && n.ok === false && n.reason)
    .map((n) => `${s.label}${n.fleet ? ` (${n.fleet})` : ''}: ${n.reason}`) : [`${s.label}: ${s.error || 'failed'}`]));
  box.append(h('p', { class: 'acx-sub' }, `Names last read from the platforms ${dtStr(d.lastRun)}. They are read again every night.`));
  if (bad.length) {
    const more = h('details', { class: 'acx-more' }, h('summary', null, `${plural(bad.length, 'platform answer', 'platform answers')} gave no name — why`),
      h('ul', { class: 'acx-list' }, bad.map((b) => h('li', null, b))));
    box.append(more);
  }
  return box;
}

function accountsClosed() {
  if (!who.signedIn) {
    const box = h('div');
    box.append(closedBlock({ title: 'Sign in to see platform accounts',
      detail: 'Which platform accounts belong to which fleet is managed by a named, signed-in Connections admin or Owner, so that every change carries their name. The fleet names themselves are on the Fleets tab for everyone.' }));
    box.append(h('div', { class: 'acx-actions' }, h('button', { type: 'button', class: 'btn primary', onclick: () => toSignIn() }, 'Sign in')));
    return box;
  }
  return closedBlock({ cls: 'CRED', view: 'fleet-names', title: 'Platform accounts are not shown to your role',
    detail: 'Which platform accounts belong to which fleet is part of the platform logins, which the Connections admin and the Owner manage. The fleet names and where they come from are on the Fleets tab.' });
}

/* ═════════════════════════ Fleets ═════════════════════════ */
function fleetsTab(host, ctx) {
  const fleets = ctx.names.fleets || [];
  if (!fleets.length) { host.append(empty('There are no fleets. A fleet is started from a platform account on the Accounts tab.')); return; }
  const linkFleets = new Set(ctx.acc?.me?.linkFleets || []);
  for (const f of fleets) {
    const [label, tone, why] = BASIS[f.basis] || ['', '', ''];
    const p = panel(`${esc(f.name || f.id)} ${label ? pill(label, tone, why) : ''}`,
      `${f.basis === 'brand' ? `The brand of “${esc(f.common || f.name)}”, cut at its first trade word. ` : ''}Internal id ${esc(f.id)}, which every stored row carries · ${plural(f.accounts, 'linked account', 'linked accounts')}`,
      `fnx-fleet-${f.id}`);
    p.panel.dataset.fleet = f.id;
    if (f.unnamedReason) p.body.append(note(f.unnamedReason, 'warn'));
    if (f.disagreeReason) p.body.append(note(f.disagreeReason, 'warn'));
    if (f.choiceStale) {
      p.body.append(note(`The name chosen earlier (“${f.choice}”) no longer appears in what the platforms send, so the brand derived from them is shown instead.`, 'warn'));
    }

    p.body.append(h('h4', { class: 'acx-h4' }, 'What the platforms call it'));
    if (!f.reported.length) {
      p.body.append(empty('No linked account reports a name yet.'));
    } else {
      p.body.append(h('ul', { class: 'acx-list', 'data-fnx': 'legal' }, f.reported.map((r) => h('li', null,
        h('b', null, r.name), ` · ${platformName(r.platform)}`,
        h('div', { class: 'acx-sub' }, `${r.source_call ? `${r.source_call}, ` : ''}${r.reported_at ? `read ${dtStr(r.reported_at)}` : ''}`)))));
      if (f.common && f.reported.length > 1) {
        p.body.append(h('p', { class: 'acx-sub' }, `Every one of them starts with “${f.common}”; the brand is that, up to the first trade word: “${f.brand}”.`));
      }
    }

    p.body.append(h('h4', { class: 'acx-h4' }, 'Its accounts'));
    if (!f.linked.length) {
      p.body.append(empty('No platform account is linked to this fleet. Link one on the Accounts tab.'));
    } else {
      p.body.append(tableFrom(f.linked, [
        { label: 'Account', key: 'label', render: (a) => `<b>${esc(a.label)}</b>` },
        { label: 'The name it reports', key: 'reported_name', render: (a) => (a.reported_name ? esc(a.reported_name)
          : `<span class="acx-sub">none — ${esc(a.name_reason || 'this platform reported no name')}</span>`) },
        { label: 'Linked', key: 'link_basis', render: (a) => esc(LINKED_BY[a.link_basis] || '—') },
      ], { compact: true, cards: true, cardLead: 'label' }));
    }

    const hist = [
      ...f.renames.map((r) => ({ at: r.at, text: `Renamed by ${r.platformLabel} on ${dtStr(r.at)}: “${r.from}” → “${r.to}”` })),
      ...(f.nameChoices || []).map((c) => ({ at: c.at, text: c.words
        ? `Name chosen on ${dtStr(c.at)}${c.by ? ` by ${c.by}` : ''}: “${c.display || c.words}”${c.reason ? ` — ${c.reason}` : ''}`
        : `Choice cleared on ${dtStr(c.at)}${c.by ? ` by ${c.by}` : ''}: back to the brand the platforms give` })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (hist.length) {
      p.body.append(h('h4', { class: 'acx-h4' }, 'Name history'),
        h('ul', { class: 'acx-list', 'data-fnx': 'history' }, hist.map((x) => h('li', null, x.text))));
    }

    p.body.append(chooseName(f, ctx, linkFleets.has(f.id)));
    host.append(p.panel);
  }
}

const platformName = (p) => ({ uber: 'Uber', yango: 'Yango', bolt: 'Bolt', fms: 'FMS', cabman: 'CABMAN', hotel: 'Hotel channel' }[p] || p);

/* Choose, never type: a list of the runs of words the platforms send. */
function chooseName(f, ctx, may) {
  const box = h('div', { 'data-fnx': 'choose' });
  box.append(h('h4', { class: 'acx-h4' }, 'Choose the name'));
  if (!f.candidates?.length) {
    box.append(empty('There is nothing to choose from until a linked account reports a name.'));
    return box;
  }
  if (!may) {
    box.append(h('p', { class: 'acx-p acx-sub' }, `If “${f.name}” reads wrong, the Connections admin or the Owner can choose another run of these words: `
      + `${f.candidates.map((c) => `“${c.display}”`).join(', ')}. Nobody can type a name.`));
    return box;
  }
  const sel = h('select', { class: 'depinput acx-in', 'data-fnx': 'words' },
    h('option', { value: '' }, f.basis === 'disagree' || (f.basis === 'chosen' && !f.brand)
      ? 'Every name the platforms report (they share no first word)'
      : `The brand the platforms give${f.brand ? ` (“${f.brand}”)` : ''}`),
    f.candidates.map((c) => h('option', { value: c.words }, c.display)));
  sel.value = f.basis === 'chosen' && f.choice ? f.choice : '';
  const why = h('input', { class: 'depinput acx-in', maxlength: 200, 'data-fnx': 'why' });
  const msg = msgLine();
  const go = h('button', { type: 'submit', class: 'btn primary' }, 'Use this name');
  const form = h('form', { class: 'acx-form' },
    h('p', { class: 'acx-p acx-sub' }, 'Only runs of words the platforms send are offered. A choice stands while the platforms still send those words.'),
    h('div', { class: 'acx-inrow' }, field('Name', sel), field('Why (optional, kept in the audit log)', why)),
    h('div', { class: 'acx-actions' }, go, msg));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await act(go, msg, () => post(`/api/fleets/${encodeURIComponent(f.id)}/name`, { words: sel.value, reason: why.value.trim() }));
    if (r) { ctx.say(r.unchanged ? 'That is already the name.' : `The fleet is now called “${r.fleet?.name || f.name}”. Every page that asks the server for fleet names shows it.`); await ctx.reload(); }
  });
  box.append(form);
  return box;
}

/* ═════════════════════════ Accounts ═════════════════════════ */
function accountsTab(host, ctx) {
  const all = ctx.acc.accounts || [];
  const me = ctx.acc.me || {};
  const fresh = all.filter((a) => a.status === 'new');
  const linked = all.filter((a) => a.status === 'linked');
  const ignored = all.filter((a) => a.status === 'ignored');

  const n = panel('New and unlinked', 'Reported by a platform and not yet part of any fleet. An account arrives here when a platform lists it — '
    + 'an Uber organisation the credential reaches, a company behind a CABMAN interface — and nothing links it by guessing.', 'fnx-new');
  if (!fresh.length) n.body.append(empty('Every account a platform has reported is linked or ignored. A new one appears here after the nightly run that finds it.'));
  for (const a of fresh) n.body.append(accountCard(a, ctx, me));
  host.append(n.panel);

  const l = panel('Linked', 'Each account’s names name its fleet. “By configuration” means the collector already filed its rows under that fleet, so recording the link moved nobody’s rows.', 'fnx-linked');
  if (!linked.length) l.body.append(empty('No account is linked yet.'));
  const byFleet = new Map();
  for (const a of linked) byFleet.set(a.fleet_id, [...(byFleet.get(a.fleet_id) || []), a]);
  for (const [fid, list] of byFleet) {
    l.body.append(h('h4', { class: 'acx-h4' }, ctx.fleetName(fid)));
    for (const a of list) l.body.append(accountCard(a, ctx, me));
  }
  host.append(l.panel);

  const i = panel('Ignored', 'Not the company’s: another operator’s cars on a shared interface, a parent organisation. Rows already stored under a fleet stay where they are until an Owner decides.', 'fnx-ignored');
  if (!ignored.length) i.body.append(empty('Nothing is ignored.'));
  for (const a of ignored) i.body.append(accountCard(a, ctx, me));
  host.append(i.panel);
}

function accountCard(a, ctx, me) {
  const card = h('section', { class: 'acx-card', 'data-account': a.id });
  const lead = a.status === 'new' ? `New: ${a.label} — link to a fleet, start a new fleet, or ignore`
    : a.status === 'ignored' ? `Ignored: ${a.label}` : a.label;
  card.append(h('h4', { class: 'acx-h4' }, lead));

  const dl = h('dl', { class: 'acx-dl' });
  const row = (k, v) => dl.append(h('dt', null, k), h('dd', null, v));
  row('The name it reports', a.reported_name
    ? h('span', null, h('b', null, a.reported_name), h('div', { class: 'acx-sub' }, `${a.source_call || ''}${a.reported_at ? `, read ${dtStr(a.reported_at)}` : ''}`))
    : h('span', { class: 'acx-sub' }, `None — ${a.name_reason || 'this platform reported no name.'}`));
  if (a.reported_name && a.nameCheck && a.nameCheck.ok === false) {
    row('Last check', h('span', { class: 'acx-sub' }, `${dtStr(a.nameCheck.at)}: ${a.nameCheck.reason || 'no name'} — the name above is the last one it gave.`));
  }
  if (a.names?.length > 1) row('Earlier names', a.names.slice(0, -1).map((x) => `“${x.name}” (until ${dtStr(x.last_reported)})`).join(', '));
  if (a.brand) row('Its brand would be', a.brand);
  row('Real id', h('code', null, a.account_id));
  row('Rows already stored', filedText(a, ctx));
  row('Evidence', evidenceNode(a, ctx));
  if (a.status !== 'linked' && a.suggestions?.length) {
    const s = a.suggestions[0];
    row('Suggested', `${ctx.fleetName(s.fleet)} — ${[s.sameBrand && 'the same brand', s.plates && `${plural(s.plates, 'shared plate', 'shared plates')}`,
      s.drivers && `${plural(s.drivers, 'shared driver', 'shared drivers')}`].filter(Boolean).join(', ')}. A suggestion only: nothing is linked until a person proposes it and an Owner approves.`);
  }
  if (a.status === 'linked') row('Linked', `to ${ctx.fleetName(a.fleet_id)}, ${LINKED_BY[a.link_basis] || ''}`);
  card.append(dl);

  if (a.pending) {
    card.append(note(`Waiting for an Owner: ${changeText(a.pending, a, ctx)} — proposed by ${a.pending.proposed_by || 'someone'} on ${dtStr(a.pending.proposed_at)}. See “Waiting for an Owner”.`, 'warn'));
  }
  const area = h('div', { class: 'acx-inline' });
  const msg = msgLine();
  if (me.owner) {
    const show = h('button', { type: 'button', class: 'btn', 'data-fnx': 'evidence' }, 'Show the plates and drivers');
    show.addEventListener('click', async () => {
      const r = await act(show, msg, () => getJson(`/api/fleets/accounts/${a.id}/evidence`));
      if (r) area.replaceChildren(evidenceLists(r, ctx));
    });
    card.append(h('div', { class: 'acx-actions' }, show));
  }
  if (me.canLink && !a.pending) card.append(actions(a, ctx, area, msg));
  card.append(area, msg);
  return card;
}

function filedText(a, ctx) {
  const f = a.filed ? Object.entries(a.filed) : [];
  const unit = a.platform === 'cabman' ? ['snapshot', 'snapshots'] : ['row', 'rows'];
  if (f.length) return `${f.map(([fid, k]) => `${nf(k)} ${Number(k) === 1 ? unit[0] : unit[1]} filed under ${ctx.fleetName(fid)}`).join('; ')}${a.vehicles != null ? `, from ${plural(a.vehicles, 'vehicle', 'vehicles')}` : ''}.`;
  if (a.filed_fleet) return `Collected and filed under ${ctx.fleetName(a.filed_fleet)} by today’s configuration.`;
  return 'None: nothing is collected from this account.';
}

/* Counts per fleet, or the reason there is no count — never a 0 that
   means "we could not look". */
function evidenceNode(a, ctx) {
  const ev = a.evidence;
  if (!ev) return h('span', { class: 'acx-sub' }, a.evidenceReason || 'Not counted yet.');
  const parts = [];
  const fleets = Object.keys(ev.byFleet || {});
  if (ev.plates == null) parts.push(`Plates: ${ev.platesReason}`);
  if (ev.drivers == null) parts.push(`Drivers: ${ev.driversReason}`);
  const lines = fleets.map((fid) => {
    const x = ev.byFleet[fid];
    return `${ctx.fleetName(fid)}: ${[x.plates != null && plural(x.plates, 'plate', 'plates'), x.drivers != null && plural(x.drivers, 'driver', 'drivers')].filter(Boolean).join(', ')} in common`;
  });
  if (ev.plates != null && !fleets.length) lines.push(`None of its ${plural(ev.plates, 'plate', 'plates')} appears in any fleet’s rows from another platform`);
  return h('span', null,
    lines.length ? h('span', null, lines.join('; '), '.') : '',
    parts.length ? h('div', { class: 'acx-sub' }, parts.join(' ')) : '',
    h('div', { class: 'acx-sub' }, `Counted from our own rows over the last ${ev.windowDays} days, ${dtStr(ev.at)}${ev.platesSource === 'reported' ? '; plates are the vehicles the platform reported under this account' : ''}.`));
}

function evidenceLists(r, ctx) {
  const box = h('div', { class: 'acx-card', 'data-fnx': 'evidence-lists' });
  box.append(h('p', { class: 'acx-p' }, `Behind the counts for ${r.account.label}, over the last ${r.windowDays} days. You are seeing this as the Owner; a Connections admin sees the counts only.`));
  const sp = r.plates.shared || [];
  box.append(h('h4', { class: 'acx-h4' }, `Plates it shares (${sp.length})`));
  if (!sp.length) box.append(empty(r.plates.reason || 'None of its plates appears in another platform’s rows.'));
  else {
    box.append(tableFrom(sp, [{ label: 'Fleet', key: 'fleet_id', render: (x) => esc(ctx.fleetName(x.fleet_id)) },
      { label: 'Plate', key: 'plate', render: (x) => entity('vehicle', x.plate, x.plate) }], { compact: true }));
  }
  const sd = r.drivers.shared || [];
  box.append(h('h4', { class: 'acx-h4' }, `Drivers it shares (${sd.length})`));
  if (!sd.length) box.append(empty(r.drivers.reason || 'None of its drivers appears in another platform’s rows.'));
  else {
    box.append(tableFrom(sd, [{ label: 'Fleet', key: 'fleet_id', render: (x) => esc(ctx.fleetName(x.fleet_id)) },
      { label: 'Driver', key: 'name', render: (x) => entity('driver', x.driver_ext_id, x.name) },
      { label: 'Trips there', key: 'trips', num: true }], { compact: true }));
  }
  return box;
}

/* ── what a person may do to an account ─────────────────────────────── */
function actions(a, ctx, area, msg) {
  const me = ctx.acc.me || {};
  const fleets = ctx.acc.fleets || [];
  const row = h('div', { class: 'acx-actions', 'data-fnx': 'actions' });
  const others = fleets.filter((f) => !(a.status === 'linked' && f.id === a.fleet_id));
  const order = a.suggestions?.length ? [...a.suggestions.map((s) => s.fleet), ...others.map((f) => f.id)] : others.map((f) => f.id);
  const ids = [...new Set(order)].filter((id) => others.some((f) => f.id === id));
  if (a.status !== 'ignored' && ids.length) {
    const sel = h('select', { class: 'depinput', 'aria-label': 'Fleet', 'data-fnx': 'fleet' },
      ids.map((id) => h('option', { value: id }, ctx.fleetName(id))));
    const link = h('button', { type: 'button', class: 'btn primary', 'data-fnx': 'link' }, a.status === 'linked' ? 'Move to this fleet…' : 'Link to this fleet…');
    link.addEventListener('click', () => propose(a, ctx, area, msg, { action: 'link', fleet: sel.value }, link));
    row.append(sel, link);
  }
  if (a.status === 'new') {
    const nb = h('button', { type: 'button', class: 'btn', 'data-fnx': 'new' }, 'Start a new fleet…');
    nb.addEventListener('click', () => propose(a, ctx, area, msg, { action: 'new' }, nb));
    row.append(nb);
  }
  if (a.status === 'linked') {
    const ub = h('button', { type: 'button', class: 'btn', 'data-fnx': 'unlink' }, 'Unlink…');
    ub.addEventListener('click', () => propose(a, ctx, area, msg, { action: 'unlink' }, ub));
    row.append(ub);
  }
  if (a.status !== 'ignored') {
    const ib = h('button', { type: 'button', class: 'btn', 'data-fnx': 'ignore' }, 'Ignore…');
    ib.addEventListener('click', () => (a.status === 'new' ? ignoreNow(a, ctx, area, msg) : propose(a, ctx, area, msg, { action: 'ignore' }, ib)));
    row.append(ib);
  } else {
    const back = h('button', { type: 'button', class: 'btn', 'data-fnx': 'unignore' }, 'Stop ignoring');
    back.addEventListener('click', async () => {
      const r = await act(back, msg, () => post(`/api/fleets/accounts/${a.id}`, { action: 'unignore' }));
      if (r) { ctx.say(`${a.label} is back among the new accounts.`); await ctx.reload(); }
    });
    row.append(back);
  }
  if (!me.linkFleets?.length) return h('p', { class: 'acx-sub' }, 'Your role cannot change which fleet an account belongs to.');
  return row;
}

/* Ignoring an account nobody linked moves nobody's rows: it applies at
   once, with a reason. */
function ignoreNow(a, ctx, area, msg) {
  area.replaceChildren();
  const why = h('input', { class: 'depinput acx-in', required: true, minlength: 3, maxlength: 400, 'data-fnx': 'reason' });
  const go = h('button', { type: 'submit', class: 'btn primary', 'data-fnx': 'confirm' }, 'Ignore it');
  const form = h('form', { class: 'acx-form acx-confirm' },
    h('p', { class: 'acx-p' }, `Ignoring ${a.label} says it is not one of the company’s. It applies at once: nobody’s rows move, because it belongs to no fleet. ${a.filed ? 'Rows already stored under a fleet stay there until an Owner decides.' : ''}`),
    field('Why is it not the company’s?', why, 'For example: another operator’s cars on our CABMAN interface. Kept in the audit log.'),
    h('div', { class: 'acx-actions' }, go, h('button', { type: 'button', class: 'btn', onclick: () => area.replaceChildren() }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (why.value.trim().length < 3) { msg.set('Say briefly why — it is kept in the audit log.', 'bad'); return; }
    const r = await act(go, msg, () => post(`/api/fleets/accounts/${a.id}`, { action: 'ignore', reason: why.value.trim() }));
    if (r) { ctx.say(r.detail || `${a.label} is ignored.`); await ctx.reload(); }
  });
  area.append(form);
  why.focus?.();
}

/* A change that moves rows: tried as a dry run first, so the person sees
   who gains and who loses sight of the account before sending it to an
   Owner. */
async function propose(a, ctx, area, msg, body, btn) {
  area.replaceChildren();
  const dry = await act(btn, msg, () => post(`/api/fleets/accounts/${a.id}`, { ...body, dry_run: true }));
  if (!dry) return;
  const what = changeText({ kind: dry.kind, fleet_id: dry.fleet, from_fleet: a.status === 'linked' ? a.fleet_id : null }, a, ctx);
  const why = h('input', { class: 'depinput acx-in', maxlength: 400, 'data-fnx': 'reason', required: body.action === 'ignore', minlength: body.action === 'ignore' ? 3 : null });
  const go = h('button', { type: 'submit', class: 'btn primary', 'data-fnx': 'confirm' }, 'Send to an Owner');
  const form = h('form', { class: 'acx-form acx-confirm', 'data-fnx': 'confirm-form' },
    h('p', { class: 'acx-p' }, h('b', null, what), '.'),
    impactNode(dry.impact, ctx, { proposed: true }),
    field(body.action === 'ignore' ? 'Why is it not the company’s?' : 'Why (the Owner reads this)', why),
    h('div', { class: 'acx-actions' }, go, h('button', { type: 'button', class: 'btn', onclick: () => area.replaceChildren() }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (body.action === 'ignore' && why.value.trim().length < 3) { msg.set('Say briefly why — it is kept in the audit log.', 'bad'); return; }
    const r = await act(go, msg, () => post(`/api/fleets/accounts/${a.id}`, { ...body, reason: why.value.trim() }));
    if (r) {
      ctx.say(`${what}: sent to an Owner. Nothing has changed yet — which fleet an account belongs to changes who can see its rows, so an Owner who did not propose it approves it.`);
      await ctx.reload();
    }
  });
  area.append(form);
  why.focus?.();
}

function impactNode(impact, ctx, { proposed = false } = {}) {
  const box = h('div', { class: 'acx-p', 'data-fnx': 'impact' });
  if (!impact) return box;
  const names = (v) => (Array.isArray(v) ? (v.length ? v.map((x) => x.label).join(', ') : 'nobody') : `${plural(v, 'person', 'people')}`);
  const gainN = Array.isArray(impact.gains) ? impact.gains.length : Number(impact.gains) || 0;
  const loseN = Array.isArray(impact.loses) ? impact.loses.length : Number(impact.loses) || 0;
  const dl = h('dl', { class: 'acx-dl' },
    h('dt', null, proposed ? 'Would gain sight of its rows' : 'Gain sight of its rows'), h('dd', null, gainN ? names(impact.gains) : 'nobody'),
    h('dt', null, proposed ? 'Would lose sight of them' : 'Lose sight of them'), h('dd', null, loseN ? names(impact.loses) : 'nobody'),
    h('dt', null, 'Unaffected'), h('dd', null, `${plural(impact.unaffected, 'person', 'people')} who see both fleets`));
  box.append(dl);
  if (impact.namesWithheld) box.append(h('p', { class: 'acx-sub' }, 'The Owner and Access admins see who; you see how many.'));
  if (impact.note) box.append(h('p', { class: 'acx-sub' }, impact.note));
  return box;
}

function changeText(c, a, ctx) {
  const acct = a?.label || (c.account ? `account ${c.account}` : 'an account');
  const to = c.fleet_id ? ctx.fleetName(c.fleet_id) : '';
  const from = c.from_fleet ? ctx.fleetName(c.from_fleet) : '';
  switch (c.kind) {
    case 'link': return from ? `Move ${acct} from ${from} to ${to}` : `Link ${acct} to ${to}`;
    case 'new_fleet': return `Start a new fleet (id “${c.fleet_id}”) from ${acct}`;
    case 'unlink': return `Unlink ${acct} from ${from || 'its fleet'}`;
    case 'ignore': return from ? `Ignore ${acct}, unlinking it from ${from}` : `Ignore ${acct}`;
    case 'unignore': return `Stop ignoring ${acct}`;
    case 'name': return c.words ? `Name ${to} “${c.words_display || c.words}”` : `Return ${to} to the brand the platforms give`;
    default: return `${c.kind} ${acct}`;
  }
}

/* ═════════════════════════ Waiting for an Owner ═════════════════════════ */
function changesTab(host, ctx) {
  const changes = ctx.acc.changes || [];
  const acctById = new Map((ctx.acc.accounts || []).map((a) => [a.id, a]));
  const me = ctx.acc.me || {};
  const open = changes.filter((c) => c.status === 'pending');
  const p = panel('Waiting for an Owner', 'Linking, unlinking or moving an account changes who can see its rows, so an Owner who did not propose it approves it. '
    + (!me.soleOwner ? ''
      : me.mode === 'enforced'
        ? `You are the only Owner: a change you proposed waits ${me.singleOwnerDelayHours} hours before you may approve it yourself, so a single stolen account cannot move rows at once.`
        : `You are the only Owner. While sign-in is not yet required you may approve a change you proposed yourself; once it is required, such a change waits ${me.configuredDelayHours} hours first.`), 'fnx-changes');
  if (!open.length) p.body.append(empty('Nothing is waiting. A link proposed on the Accounts tab waits here for an Owner.'));
  for (const c of open) {
    const a = acctById.get(c.account);
    const card = h('section', { class: 'acx-card', 'data-change': c.id });
    card.append(h('h4', { class: 'acx-h4' }, changeText(c, a, ctx)));
    card.append(h('p', { class: 'acx-sub' }, `Proposed by ${c.proposed_by || 'someone'} on ${dtStr(c.proposed_at)}${c.basis === 'configuration' ? ', recording what the configuration already did' : ''}.`));
    if (c.reason) card.append(h('p', { class: 'acx-quote' }, c.reason));
    card.append(impactNode(c.impact, ctx, { proposed: true }));
    const msg = msgLine();
    const ask = h('div', { class: 'acx-inline' });
    const row = h('div', { class: 'acx-actions' });
    if (c.canApprove) {
      const ok = h('button', { type: 'button', class: 'btn primary', 'data-fnx': 'approve' }, 'Approve');
      ok.addEventListener('click', async () => {
        const r = await act(ok, msg, () => post(`/api/fleets/changes/${c.id}/approve`, {}));
        if (r) {
          const renamed = (r.renamed || []).map((x) => `${x.id} is now called “${x.to}”`).join('; ');
          ctx.say(`Approved: ${changeText(c, a, ctx)}.${renamed ? ` ${renamed}.` : ''}`);
          await ctx.reload();
        }
      });
      row.append(ok);
    } else if (me.owner && c.mine) {
      row.append(h('span', { class: 'acx-sub' }, c.waitsUntil
        ? `You proposed it. As the only Owner you may approve it yourself from ${dtStr(c.waitsUntil)}, or a second Owner can now.`
        : 'You proposed it, so another Owner approves it.'));
    } else if (!me.owner) {
      row.append(h('span', { class: 'acx-sub' }, 'Only an Owner approves these.'));
    }
    if (c.canDecline) {
      const no = h('button', { type: 'button', class: 'btn', 'data-fnx': 'decline' }, c.mine ? 'Withdraw' : 'Decline…');
      no.addEventListener('click', async () => {
        if (c.mine) {
          const r = await act(no, msg, () => post(`/api/fleets/changes/${c.id}/decline`, { reason: '' }));
          if (r) { ctx.say('Withdrawn.'); await ctx.reload(); }
          return;
        }
        ask.replaceChildren();
        const why = h('input', { class: 'depinput acx-in', required: true, minlength: 3, maxlength: 400, 'data-fnx': 'reason' });
        const go = h('button', { type: 'submit', class: 'btn' }, 'Decline it');
        const f = h('form', { class: 'acx-form acx-ask' }, field('Why decline it? The person who proposed it reads this.', why),
          h('div', { class: 'acx-actions' }, go, h('button', { type: 'button', class: 'btn', onclick: () => ask.replaceChildren() }, 'Cancel')));
        f.addEventListener('submit', async (e) => {
          e.preventDefault();
          const r = await act(go, msg, () => post(`/api/fleets/changes/${c.id}/decline`, { reason: why.value.trim() }));
          if (r) { ctx.say('Declined.'); await ctx.reload(); }
        });
        ask.append(f);
        why.focus?.();
      });
      row.append(no);
    }
    card.append(row, ask, msg);
    p.body.append(card);
  }
  host.append(p.panel);

  const done = changes.filter((c) => c.status !== 'pending');
  const d = panel('Decided in the last 60 days', 'Every change to an account’s fleet, and every name chosen, with who proposed and who decided.', 'fnx-decided');
  if (!done.length) d.body.append(empty('Nothing has been decided yet.'));
  else {
    const STATUS = { applied: ['applied', 'ok'], declined: ['declined', 'bad'], withdrawn: ['withdrawn', 'dim'], superseded: ['set aside', 'dim'] };
    d.body.append(tableFrom(done, [
      { label: 'Change', key: 'kind', render: (c) => `<b>${esc(changeText(c, acctById.get(c.account), ctx))}</b>${c.reason ? `<div class="acx-sub">${esc(c.reason)}</div>` : ''}` },
      { label: 'Outcome', key: 'status', render: (c) => `${pill(...(STATUS[c.status] || [c.status, 'dim']))}${c.decided_reason ? `<div class="acx-sub">${esc(c.decided_reason)}</div>` : ''}` },
      { label: 'Proposed', key: 'proposed_at', render: (c) => `${esc(dtStr(c.proposed_at))}<div class="acx-sub">${esc(c.basis === 'configuration' ? 'by configuration' : `by ${c.proposed_by || '—'}`)}</div>` },
      { label: 'Decided', key: 'approved_at', render: (c) => (c.approved_at ? `${esc(dtStr(c.approved_at))}<div class="acx-sub">${esc(c.approved_by ? `by ${c.approved_by}` : '')}</div>` : '—') },
    ], { compact: true, cards: true, cardLead: 'kind' }));
  }
  host.append(d.panel);
}
