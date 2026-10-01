/* #messages — every text the product sent a driver, and every one it held back.
   ═══════════════════════════════════════════════════════════════════════════
   Two texts go to drivers on their own (src/driver_sms.js): at 05:00 Dubai,
   the cash each one took yesterday; and when a journey with no booking is
   found, a request to register it with their supervisor. Both were asked for
   in the operator's own words, and so is the wording of each.

   A message that could not be sent correctly is not sent — it is HELD, with
   the reason, and this page is where the reason is read. "Why did this driver
   get nothing?" is the question it answers most often, so the held rows are
   as much the page as the sent ones: a driver whose number is also on a
   colleague's record, a day whose Bolt collector failed, a journey the
   evidence cannot pin on one person.

   The second tab is the dry run: what the next cash run and the next trip run
   would decide now, without writing or sending anything.

   Drivers' mobile numbers and what was texted to them are on this page, so
   the API refuses anyone who is not signed in whatever the sign-in mode
   (api/sms_routes.js), and the manifest makes it a contact-details page: a
   role without contact details never opens it. */
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, note, pill, entity, dtStr, dayStr, countOf, andList,
  sourceLabel, money } from './ui.js';
import { fmt } from './charts.js';
import { api, href } from './data.js';
import { who, closedBlock, toSignIn } from './access.js';

const TABS = [
  { id: 'log', label: 'Sent and held back' },
  { id: 'next', label: 'What the next run would do' },
];
const KIND = {
  cash_deposit: 'Cash to deposit', trip_register: 'Register a trip',
  reset_code: 'Staff reset code', phone_code: 'Staff mobile check', cash_run: 'The 05:00 run',
};
const FILTERS = [
  { id: '', label: 'Everything' },
  { id: 'cash_deposit', label: 'Cash to deposit' },
  { id: 'trip_register', label: 'Register a trip' },
  { id: 'reset_code', label: 'Staff codes' },
];

/* The state of one message, in words, and never colour alone. */
function statusCell(r) {
  if (r.status === 'sent') {
    const dlr = r.provider_status ? `<div class="dim">${esc(r.provider_status === 'Delivered' ? 'delivered to the phone' : `gateway: ${r.provider_status}`)}</div>` : '';
    return `${pill('sent', 'ok')}<div class="dim">${esc(dtStr(r.sent_at))}</div>${dlr}`;
  }
  if (r.status === 'queued') {
    return `${pill('waiting', 'warn')}<div class="dim">${r.not_before ? `goes at ${esc(dtStr(r.not_before))} — nothing is texted at night` : 'goes on the next pass'}</div>`;
  }
  if (r.status === 'failed') {
    /* The outbox keeps "code: sentence"; the reader gets the sentence. */
    const why = r.error === 'sending' ? 'the send was interrupted'
      : String(r.error || '').replace(/^[a-z_0-9]+:\s*/, '') || 'the gateway refused it';
    return `${pill('not sent', 'bad')}<div class="dim">${esc(why)}</div>`;
  }
  return `${pill('held back', 'dim')}<div class="dim">${esc(r.why || r.hold_reason || '')}</div>`;
}

/* `link` is handed in by the column, so the column that names a driver
   visibly links to one (test/interlinking.test.mjs reads the column). */
/* A held trip message used to carry no person at all, so every one read
   "nobody the evidence names" — though the evidence named one driver on 51 of
   58 (2026-10-01). src/driver_sms.js now records the person whenever the
   evidence names one, and the candidates by name when it names several or
   names someone not on the register. */
function whoCell(r, link) {
  if (r.person_id != null) return link(`p${r.person_id}`, r.person_name || 'name not on file');
  if (r.user_id != null) return `<span>${esc(r.user_email || 'a staff account')}</span><div class="dim">staff</div>`;
  const c = Array.isArray(r.detail?.candidates) ? r.detail.candidates : [];
  if (c.length === 1) return `<span>${esc(c[0])}</span><div class="dim">not on the driver register</div>`;
  if (c.length > 1) return `<span>${esc(c.join(' or '))}</span><div class="dim">${c.length} people — the evidence does not settle which</div>`;
  return '<span class="ent-off">nobody the evidence names</span>';
}

function toCell(r) {
  if (!r.destination) return '<span class="ent-off">no number chosen</span>';
  return `${esc(r.destination)}${r.detail?.phone_source || r.detail?.source
    ? `<div class="dim">${(r.detail.phone_source || r.detail.source) === 'hr' ? 'HR’s number' : 'Uber’s number'}</div>` : ''}`;
}

/* The channels, as the message names them (src/driver_sms.js channelWords). */
const CHANNEL = { uber: 'Uber', bolt: 'Bolt', yango: 'Yango', hotel: 'Hotel' };
const channelName = (p) => CHANNEL[p] || p;
const LEFT_OUT_WHY = { not_collected: 'did not collect', not_priced: 'no amount yet', hotel_by_name: 'hotel account matched by name' };
/* What a cash message did NOT count, and why — so a driver told "AED 44.00
   of Uber cash" has the Bolt cash beside it on the page, not forgotten. */
function leftOutLine(detail) {
  const lo = Array.isArray(detail?.left_out) ? detail.left_out : [];
  if (!lo.length) return '';
  const words = lo.map((x) => (x.trips
    ? `${channelName(x.platform)}: ${countOf(x.trips, 'cash trip')}${x.known_aed ? ` (${money(x.known_aed)} seen)` : ''}, ${LEFT_OUT_WHY[x.why] || x.why}`
    : `${channelName(x.platform)} ${LEFT_OUT_WHY[x.why] || x.why}, so any ${channelName(x.platform)} cash is not in this`));
  return `<div class="dim">Not in this amount — ${esc(words.join('; '))}</div>`;
}
function messageCell(r) {
  if (r.kind === 'reset_code' || r.kind === 'phone_code') return '<span class="dim">a six-digit code — never kept</span>';
  const trip = r.kind === 'trip_register' && r.plate
    ? `<div class="dim">${entity('vehicle', r.plate, r.plate)} · ${esc(dtStr(r.trip_start))}</div>` : '';
  const day = r.kind === 'cash_deposit' && r.business_day ? `<div class="dim">for ${esc(dayStr(`${r.business_day}T12:00:00`))}</div>` : '';
  const none = r.kind === 'cash_deposit'
    ? '<span class="ent-off">no message — nothing certain to ask for</span>'
    : '<span class="ent-off">no wording — the places have no readable name</span>';
  const left = r.kind === 'cash_deposit' ? leftOutLine(r.detail) : '';
  return `${r.message_text ? `“${esc(r.message_text)}”` : none}${trip}${day}${left}`;
}

/* The 05:00 run itself: sent to how many, or why it is still waiting. */
function runLine(r) {
  const d = r.detail || {};
  const day = r.business_day ? dayStr(`${r.business_day}T12:00:00`) : 'a day';
  if (r.hold_reason === 'switched_off') return `${day}: switched off in Settings — nothing was sent.`;
  if (r.hold_reason === 'waiting' || r.hold_reason === 'not_complete') {
    const parts = [];
    if (d.missing_catchup?.length) parts.push(`Uber’s nightly catch-up has not run for ${andList(d.missing_catchup.map(sourceLabel))}`);
    if (d.uber_cash_trips_without_figure) parts.push(`${countOf(d.uber_cash_trips_without_figure, 'Uber cash trip')} still without Uber’s own cash figure`);
    return r.hold_reason === 'waiting'
      ? `${day}: waiting — ${parts.join('; ') || 'yesterday is not complete yet'}. It asks again every 15 minutes until 09:00.`
      : `${day}: not sent — at 09:00 yesterday was still not complete (${parts.join('; ') || 'incomplete'}). No driver was told a short amount.`;
  }
  const holds = Object.entries(d.holds || {}).map(([k, n]) => `${fmt(n)} ${k.replace(/_/g, ' ')}`);
  const unplaced = d.unplaced_trips ? ` ${countOf(d.unplaced_trips, 'cash trip')} (${money(d.unplaced_aed)}) belong to an account not placed on any person, so nobody was texted about them.` : '';
  const partial = d.partial ? ` (${fmt(d.partial)} of them with a channel left out)` : '';
  return `${day}: ${countOf(d.sent || 0, 'driver')} texted${partial}, ${fmt(d.held || 0)} held back${holds.length ? ` (${holds.join(', ')})` : ''}.${unplaced}`;
}

async function renderLog(root, kind) {
  const hold = el('div'); root.append(hold);
  loading(hold);
  let d;
  try { d = await api(`/api/sms/log?limit=300${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`); } catch (e) {
    hold.replaceChildren(e?.name === 'WithheldError'
      ? closedBlock({ view: 'messages', cls: 'CT', title: 'The messages are not shown to your role', detail: e.message })
      : note(`The messages could not be read: ${e.message}`, 'err'));
    return;
  }
  hold.replaceChildren();
  const c = d.last7days || {};
  hold.append(kpiRow([
    { label: 'Texted to drivers', value: fmt(c.sent || 0), sub: 'last 7 days', tone: 'good' },
    { label: 'Held back', value: fmt(c.held || 0), sub: 'each with its reason below' },
    { label: 'Waiting for 07:00', value: fmt(c.queued || 0), sub: 'found at night' },
    { label: 'Refused by the gateway', value: fmt(c.failed || 0), sub: 'last 7 days', tone: c.failed ? 'critical' : undefined },
    /* The gateway's own figure, in its account's currency — which it does
       not state and nobody has measured, so no currency is printed. */
    { label: 'Gateway charge', value: c.cost ? Number(c.cost).toFixed(3) : 'none reported', sub: 'last 7 days, in the gateway account’s own currency' },
  ]));
  const sw = d.switches || {};
  const off = [sw.sms_cash === 'off' && 'the 05:00 cash reminder', sw.sms_trip === 'off' && 'the trip request'].filter(Boolean);
  if (off.length) hold.append(note(`Switched off in Access → Settings: ${andList(off)}. Nothing of that kind is sent until it is switched back on.`, 'warn'));

  const rows = d.rows || [];
  const runs = rows.filter((r) => r.kind === 'cash_run');
  if (!kind && runs.length) {
    const p = panel('The 05:00 cash run', 'One line per day. The run waits until yesterday is complete, so nobody is told a short amount.', 'msg-runs');
    p.body.append(el('div', 'cap', runs.slice(0, 7).map((r) => `<div>${esc(runLine(r))}</div>`).join('')));
    hold.append(p.panel);
  }

  const bar = el('div', 'chips');
  bar.innerHTML = FILTERS.map((f) => `<a class="chip${(kind || '') === f.id ? ' on' : ''}" href="${href('messages', f.id ? 'log' : null, f.id || null)}">${esc(f.label)}</a>`).join('');
  const list = rows.filter((r) => r.kind !== 'cash_run');
  const p = panel(countOf(list.length, 'message'), 'Newest first. A held message was never sent; its reason is beside it.', 'msg-log');
  p.body.append(bar);
  if (!list.length) {
    p.body.append(note(kind ? `No message of this kind yet.` : 'No message has been decided yet. The first cash reminder goes at 05:00 Dubai; a trip request as soon as a journey with no booking is found and passes every check.', ''));
  } else {
    p.body.append(tableFrom(list, [
      { label: 'When', key: 'created_at', render: (r) => esc(dtStr(r.created_at)) },
      { label: 'Message', key: 'kind', render: (r) => `<b>${esc(KIND[r.kind] || r.kind)}</b>` },
      { label: 'Driver', key: 'person_name', sortValue: (r) => String(r.person_name || r.user_email || '').toLowerCase() || null, render: (r) => whoCell(r, (id, name) => entity('driver', id, name)) },
      { label: 'Sent to', key: 'destination', render: toCell },
      { label: 'What it says', key: 'message_text', render: messageCell },
      { label: 'State', key: 'status', render: statusCell },
    ], { sortable: true, sortId: 'messages', cards: true, cardLead: 'kind' }));
  }
  hold.append(p.panel);
}

function decisionRows(r, kind) {
  return (r.decisions || []).map((x) => ({ ...x, kind }));
}

async function renderNext(root) {
  const p = panel('What the next run would do', 'Decided now, from what the database holds this minute. Nothing is written and nothing is sent. The real run can differ by the time it is due.', 'msg-next');
  root.append(p.panel);
  const btns = el('div', 'chips');
  btns.innerHTML = '<button type="button" class="chip" data-k="cash">The cash reminder</button> <button type="button" class="chip" data-k="trip">The trip requests</button>';
  const out = el('div');
  out.dataset.msgOut = '';
  p.body.append(btns, out);
  const run = async (k) => {
    btns.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === k));
    loading(out);
    let r;
    try { r = await api(`/api/sms/preview?kind=${k}`); } catch (e) {
      out.replaceChildren(e?.name === 'WithheldError'
        ? closedBlock({ view: 'messages', cls: 'CT', title: 'The preview is not shown to your role', detail: e.message })
        : note(`The preview could not be run: ${e.message}`, 'err'));
      return;
    }
    out.replaceChildren();
    if (r.off) { out.append(note('Switched off in Access → Settings: nothing would be sent.', 'warn')); return; }
    if (k === 'cash') {
      if (r.already) { out.append(note(`Yesterday’s run (${dayStr(`${r.day}T12:00:00`)}) has already finished. The Sent and held back tab shows what it did.`, '')); return; }
      if (r.waiting || r.gaveUp) {
        const parts = [];
        if (r.missing_catchup?.length) parts.push(`Uber’s nightly catch-up has not run for ${andList(r.missing_catchup.map(sourceLabel))}`);
        if (r.uber_cash_trips_without_figure) parts.push(`${countOf(r.uber_cash_trips_without_figure, 'Uber cash trip')} without Uber’s own cash figure`);
        out.append(note(`Yesterday is not complete yet: ${parts.join('; ')}. Nobody would be texted now.`, 'warn'));
        return;
      }
      out.append(el('p', 'cap', esc(`For ${dayStr(`${r.day}T12:00:00`)}: ${countOf(r.people || 0, 'driver')} took cash, ${fmt((r.people || 0) - (r.held || 0))} would be texted, ${fmt(r.held || 0)} held back.`)));
      out.append(tableFrom(decisionRows(r, 'cash'), [
        { label: 'Driver', key: 'person', render: (x) => entity('driver', `p${x.person}`, x.name || 'name not on file') },
        { label: 'Cash', key: 'amount', render: (x) => `${esc(money(x.amount))}${x.channels?.length
          ? `<div class="dim">${esc(x.channels.map(channelName).join(' + '))}</div>` : ''}${leftOutLine(x)}` },
        { label: 'Would go to', key: 'to', render: (x) => (x.to ? `${esc(x.to)}<div class="dim">${x.source === 'hr' ? 'HR’s number' : 'Uber’s number'}</div>` : '<span class="ent-off">no number chosen</span>') },
        { label: 'Would be', key: 'hold', render: (x) => (x.hold ? `${pill('held back', 'dim')}<div class="dim">${esc(x.why || x.hold)}</div>` : pill('sent', 'ok')) },
      ], { sortable: true, sortId: 'messages-next-cash', cards: true }));
    } else {
      if (r.error) { out.append(note(r.error, 'err')); return; }
      if (!r.decisions?.length) { out.append(note('No journey with no booking has ended since the last pass and passed the reconciler’s two-hour wait.', '')); return; }
      out.append(el('p', 'cap', esc(`${countOf(r.candidates || 0, 'journey')} with no booking; ${fmt(r.skipped || 0)} already decided; ${fmt(r.held || 0)} would be held back.`)));
      out.append(tableFrom(decisionRows(r, 'trip'), [
        { label: 'Vehicle', key: 'plate', render: (x) => `${entity('vehicle', x.plate, x.plate)}<div class="dim">${esc(dtStr(x.started_at))}</div>` },
        { label: 'Journey', key: 'km', render: (x) => esc(x.from && x.to_place ? `${x.from} to ${x.to_place}, ${x.km} km` : `${x.km} km, a place with no readable name`) },
        { label: 'Driver', key: 'person', render: (x) => (x.person ? entity('driver', `p${x.person}`, x.name || 'name not on file') : `<span class="ent-off">${esc(x.tier ? `named on ${x.tier.replace(/_/g, ' ')} evidence, not certain` : 'nobody named')}</span>`) },
        { label: 'Would be', key: 'hold', render: (x) => (x.hold ? `${pill('held back', 'dim')}<div class="dim">${esc(x.why || x.hold)}</div>`
          : x.waits_until_7 ? pill('waits for 07:00', 'warn') : pill('sent', 'ok')) },
      ], { sortable: true, sortId: 'messages-next-trip', cards: true }));
    }
  };
  btns.addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) run(b.dataset.k); });
}

export async function renderMessages(root, param, sub) {
  root.innerHTML = '';
  /* Not signed in: the API says no whatever the mode, so the page says why
     and offers the way in, rather than an error. */
  if (!who.signedIn || who.kind !== 'user') {
    const box = el('section', 'access-closed');
    box.innerHTML = `<p class="ac-eyebrow">Sign in to see this page</p><h2>Driver messages</h2>
      <p class="ac-why">This page lists drivers’ mobile numbers and what was texted to each of them, so it opens only for someone signed in — whatever the sign-in setting.</p>
      <p><button type="button" class="chip on">Sign in</button></p>`;
    box.querySelector('button').addEventListener('click', () => toSignIn());
    root.append(box);
    return;
  }
  const t = TABS.some((x) => x.id === param) ? param : 'log';
  const kind = sub;
  root.append(tabBar(TABS, t, (id) => href('messages', id === 'log' ? null : id)));
  if (t === 'next') await renderNext(root);
  else await renderLog(root, KIND[kind] ? kind : '');
  root.append(el('div', 'cap srcline', [
    '<div><b>Cash to deposit:</b> at 05:00 Dubai, each driver who took cash yesterday: Uber’s own cash-collected figure, the fare on the other channels, and the message names the channels it covers. A channel that did not collect, has no amount yet, or is a hotel account matched by name is left out and the rest is still sent; held only when nothing certain is left. Sent once Uber’s figures for yesterday are in; given up at 09:00 if they never are.</div>',
    '<div><b>Register a trip:</b> a journey with no booking, 4 km or more, no booking within 30 minutes, exactly one driver named — the last driver of the car counts, however long ago their last Uber trip — and both places with a readable name. Never the word “unauthorized”. Found between 23:00 and 07:00, it waits until 07:00, and is checked again before it goes.</div>',
    '<div><b>Whose number:</b> Uber’s first, HR’s second. Never a number on two people’s records, never one of two different numbers, never a record held back as possibly the same person as another.</div>',
    '<div><b>Stopping them:</b> Access → Settings has a switch for each.</div>',
  ].join('')));
}
