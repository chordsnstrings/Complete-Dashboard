/* The to-do list.
   ──────────────────────────────────────────────────────────────────────────
   Every other page in this product answers a question. This one tells somebody
   to go and do something, which is a much stronger claim, so each row carries
   three things a question never has to: how big it is, how the size was
   computed, and how certain that is.

   The certainty distinction is the point. "AED 58,721 is owed" is a measured
   fact — the rows exist and carry prices. "Nine idle vehicles could produce
   1,300 bookings" is a CEILING: what they would do if every one were
   redeployed and matched the fleet median, both of which are optimistic. Those
   two numbers must never be added together, and a page that sorts by size puts
   the ceiling on top, which is exactly backwards. */

import { dec, empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, money,
         entity, custody, custodyAsOf, dateStr, countOf, plural, verdict } from './ui.js';
import { q, href, store } from './data.js';

const GROUPS = [
  { id: 'Collect', blurb: 'Money the fleet has already earned and has not got yet.' },
  { id: 'Protect', blurb: 'Capacity about to stop being able to work. Avoiding a loss, not chasing a gain.' },
  { id: 'Deploy', blurb: 'Vehicles the fleet already owns and is not earning from.' },
  { id: 'Cover', blurb: 'Hours where work reliably turns up and almost nobody is on.' },
  { id: 'Improve', blurb: 'More out of what is already running.' },
];

const CERT = {
  measured: { tone: 'ok', label: 'measured', means: 'The rows exist and carry the figure.' },
  'partly measured': { tone: 'warn', label: 'partly measured', means: 'Some of the rows carry no fare, so the figure is a floor.' },
  observed: { tone: 'ok', label: 'observed', means: 'Counted from what happened; the size is a count, not a projection.' },
  ceiling: { tone: 'warn', label: 'a ceiling', means: 'What it would yield if everything went right. Not an expectation.' },
};

const HORIZON_TONE = { today: 'critical', 'this week': 'warn', 'next rota': 'warn', 'this month': null };

export async function renderPlaybook(root) {
  root.innerHTML = '';
  loading(root);
  /* The operator's own revenue-per-booking assumption, remembered locally.
     Deliberately empty by default: this fleet's only measured rate comes from
     the corporate hotel channel, and applying it to UberX would invent about
     half a business. */
  const saved = store.get('aedPerTrip', '');
  const d = await q('/api/playbook', saved ? { aed_per_trip: saved } : {});
  root.innerHTML = '';

  if (!d.actions.length) {
    return empty(root, 'Nothing to action. Either the fleet is in good order, or the collectors have not '
      + 'completed a cycle — check Collection gaps before reading it as the first.');
  }

  const t = d.totals || {};
  const fleet = d.fleet || {};

  /* Fields read off /api/playbook on production: totals carries aed_measured,
     aed_modelled, bookings_ceiling_gain, bookings_at_risk, ceiling_unit; each
     action carries a horizon. A to-do list's headline is what the list is
     WORTH, and only the part of it with arithmetic behind it can be totalled —
     the rest is real and unpriced, and saying so is the difference between a
     number and a claim. */
  {
    const measured = +t.aed_measured || 0;
    const soon = d.actions.filter((a) => a.horizon === 'today' || a.horizon === 'this week').length;
    const modelled = t.aed_modelled == null ? null : +t.aed_modelled;
    verdict(root, {
      claim: measured
        ? `${countOf(d.actions.length, 'thing')} to do, worth ${money(measured)} a month`
        : `${countOf(d.actions.length, 'thing')} to do`,
      figure: measured ? money(measured) : fmt(d.actions.length),
      unit: measured ? `over ${d.window_days} days` : 'actions',
      tone: soon ? 'warn' : null,
      meta: soon ? `${fmt(soon)} this week or sooner` : null,
      sub: (measured
        ? 'That figure is only the items with arithmetic behind them. '
        : 'None of these carry a size yet. ')
        + (modelled ? `A further ${money(modelled)} is modelled rather than measured. ` : '')
        + (t.bookings_at_risk
          ? `${fmt(t.bookings_at_risk)} ${t.ceiling_unit || 'bookings'} are at risk if nothing changes.`
          : ''),
    });
  }
  /* Which window produced this list. `d.window` is the response's first key and
     the page printed it nowhere — so "13 vehicles took no booking at all this
     window" is a different list at 7, 30 and 365 days, with nothing on screen
     to say which one you are reading. */
  if (d.window) {
    const w = Array.isArray(d.window) ? d.window : [d.window.from, d.window.to];
    if (w[0] && w[1]) {
      root.append(el('p', 'cap',
        `Everything on this page is over ${dateStr(`${String(w[0]).slice(0, 10)}T12:00:00`)} → `
        + `${dateStr(`${String(w[1]).slice(0, 10)}T12:00:00`)}`
        + (d.window_days ? ` (${countOf(d.window_days, 'Dubai day')})` : '')
        + '. Widening the range changes which items appear AND how big each one is sized.'));
    }
  }
  root.append(kpiRow([
    { label: 'Things to do', value: fmt(d.actions.length),
      sub: `${d.actions.filter((a) => a.horizon === 'today' || a.horizon === 'this week').length} this week or sooner` },
    { label: 'Money already earned', value: money(t.aed_measured),
      sub: 'measured — these rows carry a price', tone: t.aed_measured ? 'warn' : null },
    /* Named for the unit the server actually computed. The ceilings are per
       WINDOW — the same 31 blocked vehicles are sized 1,163 at seven days and
       51,336 at a year — so a tile reading "bookings/month" is only true at
       one of the five ranges the page offers. It says what it is until the
       server normalises it. */
    { label: 'Idle capacity', value: fmt(t.bookings_ceiling),
      sub: t.ceiling_unit
        ? esc(t.ceiling_unit)
        : `bookings at the fleet median, over ${d.window_days ? countOf(d.window_days, 'day') : 'this window'}`
          + ' — not per month; it scales with the range above',
      tone: t.bookings_ceiling ? 'warn' : null },
    /* The other half of the split, which was computed and never drawn.
       ─────────────────────────────────────────────────────────────────────
       api/playbook_routes.js separates the ceilings into GAIN and PROTECT
       precisely so the two are not added together — its comment says an
       avoided loss on the same cars had been printing as upside. Only the gain
       half reached this page, so a reader saw what the fleet could win and not
       what it stands to lose by doing nothing. A protect action is a document
       about to expire or a driver about to be blocked: the volume behind it is
       not upside, it is the floor falling out. */
    ...(t.bookings_at_risk
      ? [{ label: 'At risk if nothing is done', value: fmt(t.bookings_at_risk),
        sub: `${t.ceiling_unit || 'bookings over this window'} — volume the fleet ALREADY has and `
          + 'would lose, counted apart from the idle capacity beside it so the two are never added',
        tone: 'critical' }]
      : []),
    { label: 'Vehicles earning', value: `${fmt(fleet.earning)} of ${fmt(fleet.vehicles_seen)}`,
      sub: fleet.median_bookings ? `median ${fmt(fleet.median_bookings)} bookings each` : null,
      tone: fleet.earning < fleet.vehicles_seen * 0.6 ? 'critical' : 'warn' },
    /* The benchmark that decides whether the ceiling above is a plan or a
       fantasy. Every ceiling is n × the fleet median, which assumes an
       experienced driver takes each car — and this fleet has just run the
       experiment on what genuinely new capacity delivers. */
    fleet.new_driver_first_month != null
      ? { label: 'What a new driver produces', value: fmt(fleet.new_driver_first_month),
        sub: `bookings in their first whole month, over ${fmt(fleet.new_drivers_measured)} recent joiners`
          + (fleet.median_bookings
            ? ` — ${Math.round((fleet.new_driver_first_month / fleet.median_bookings) * 100)}% of the median`
            : ''),
        tone: fleet.median_bookings && fleet.new_driver_first_month < fleet.median_bookings * 0.6
          ? 'critical' : null }
      : null,
    t.aed_modelled != null
      ? { label: 'Modelled upside', value: money(t.aed_modelled),
        sub: `at AED ${d.assumption.aed_per_trip}/booking — an assumption`, tone: 'warn' }
      : null,
  ]));

  /* The rate control. Money and ceilings stay apart whatever it is set to;
     this only decides whether ceilings get a second, clearly-labelled column. */
  const bar = el('div', 'toolbar');
  bar.innerHTML = `<label class="cap" for="pbRate">Revenue per booking, for modelling</label>
    <input id="pbRate" type="number" min="0" step="1" placeholder="not set"
           value="${esc(saved)}" style="width:8rem">
    <span class="cap">AED — leave empty and nothing is converted to money</span>`;
  root.append(bar);
  bar.querySelector('#pbRate').onchange = (e) => {
    store.set('aedPerTrip', e.target.value.trim());
    renderPlaybook(root);
  };
  root.append(el('p', 'cap', esc(d.assumption.note)));

  /* Ordered by horizon then certainty, NOT by size. A ceiling that dwarfs a
     measured amount is not thereby more valuable — it is less certain, and a
     list sorted by size would put the least reliable item at the top. */
  for (const g of GROUPS) {
    const rows = d.actions.filter((a) => a.group === g.id);
    if (!rows.length) continue;
    const { panel: p, body } = panel(g.id, g.blurb);
    root.append(p);
    rows.forEach((a) => body.append(actionCard(a, d)));
  }

  if (fleet.new_driver_first_month != null && fleet.median_bookings
      && fleet.new_driver_first_month < fleet.median_bookings * 0.6) {
    root.append(el('div', 'note err',
      `Every ceiling on this page is a count times the fleet's median earning vehicle `
      + `(${fmt(fleet.median_bookings)} bookings). That benchmark assumes an experienced driver takes each `
      + `car. This fleet's last ${fmt(fleet.new_drivers_measured)} genuinely new drivers produced a median of `
      + `${fmt(fleet.new_driver_first_month)} bookings in their first whole month — about `
      + `${Math.round((fleet.new_driver_first_month / fleet.median_bookings) * 100)}% of it. Where an action `
      + 'needs NEW people rather than existing ones, expect roughly a third of the ceiling. That is why '
      + 'reassigning cars from drivers who cannot use them sits above putting idle cars back on the road, '
      + 'despite being the smaller number.'));
  }

  root.append(note('Sorted by when it needs doing, then by how certain the size is — never by the size '
    + 'itself. A ceiling that dwarfs a measured amount is not more valuable than it; it is less certain, '
    + 'and sorting by size would put the least reliable row at the top of the list.'));
}

function actionCard(a, d) {
  const card = el('div', 'card act');
  const cert = CERT[a.certainty] || { tone: null, label: a.certainty, means: '' };

  const head = el('div', 'act-head');
  head.innerHTML = `<div class="act-title">${esc(a.title)}</div>
    <div class="act-tags">
      ${pill(a.horizon, HORIZON_TONE[a.horizon])}
      ${pill(cert.label, cert.tone)}
      ${pill(`${a.effort} effort`, null)}
    </div>`;
  card.append(head);

  card.append(el('p', 'act-why', esc(a.why)));

  // The numbers, each labelled with what kind of number it is.
  const figs = [];
  if (a.aed_measured) figs.push([money(a.aed_measured), 'measured, already earned']);
  if (a.ceiling) figs.push([`${fmt(a.ceiling)}`, a.ceiling_unit || 'ceiling']);
  if (a.aed_modelled != null) {
    figs.push([money(a.aed_modelled), `modelled at AED ${d.assumption.aed_per_trip}/booking`]);
  }
  if (a.size) figs.push([fmt(a.size), a.size_unit]);
  if (figs.length) {
    card.append(el('div', 'act-figs', figs.map(([v, l]) =>
      `<span class="act-fig"><b>${esc(v)}</b><i>${esc(l)}</i></span>`).join('')));
  }

  /* How the size was computed, from which rows. An action nobody can check is
     an opinion with a database behind it, and this is the field that makes the
     difference. */
  const basis = el('details', 'act-basis');
  basis.innerHTML = `<summary>How this was worked out</summary>
    <p>${esc(a.basis)}</p>
    <p class="cap">${esc(cert.means)}</p>`;
  if (a.detail?.length) {
    /* The evidence table is built from whatever keys the action returned, which
       kept it honest — a new field on an action appears here without anyone
       remembering to add it. But esc(String(v)) is only right for scalars: it
       printed a plate as dead text next to a driver as dead text, so the one
       table in the product whose whole job is "check this yourself" was the one
       you could not click out of. And once actions started carrying custody,
       it rendered [object Object].

       So: scalars still fall through to the generic path, and the handful of
       keys that name an entity render as links. Keys that exist only to carry
       an id or a count for another column are folded into it rather than shown
       as their own column of noise. */
    /* `partner_id` is a Mongo id no page navigates by; it was a column of
       twenty-four hex characters sitting where the reader looks for a name. */
    const HIDDEN = new Set(['driver_ext_id', 'driver_n', 'partner_id']);
    const RENDER = {
      plate: (r) => entity('vehicle', r.plate, r.plate),
      plates: (r) => (Array.isArray(r.plates) && r.plates.length
        ? r.plates.map((pl) => entity('vehicle', pl, pl)).join(' ') : '\u2014'),
      driver: (r) => entity('driver', r.driver_ext_id, r.driver),
      driver_name: (r) => entity('driver', r.driver_ext_id, r.driver_name),
      counterparty: (r) => (r.driver_ext_id
        ? entity('driver', r.driver_ext_id, r.counterparty) : esc(String(r.counterparty ?? '\u2014'))),
      held_by: (r) => custodyAsOf(r.held_by),
      driver_refs: (r) => custody(r) + (r.driver_n > (r.driver_refs || []).length
        ? ` <span class="dim">+${fmt(r.driver_n - (r.driver_refs || []).length)} more</span>` : ''),
      amount: (r) => money(r.amount, 'AED', 0),
      pct: (r) => (r.pct == null ? '\u2014' : `${dec(r.pct, 1)}%`),
      avg_return_km: (r) => (r.avg_return_km == null ? '\u2014' : `${dec(r.avg_return_km, 1)} km`),
      expires_at: (r) => dateStr(r.expires_at),
      last_booking: (r) => dateStr(r.last_booking),
      days_left: (r) => (r.days_left == null ? '\u2014'
        : (Number(r.days_left) <= 0 ? pill('today', 'critical')
          : `${fmt(r.days_left)}${Number(r.days_left) <= 7 ? ' ' + pill('soon', 'warn') : ''}`)),
      state: (r) => pill(String(r.state ?? ''), 'warn'),
      settlement_class: (r) => pill(String(r.settlement_class ?? '').replace(/_/g, ' ')),
      platform: (r) => pill(String(r.platform ?? '')),
      /* `unpriced_channel: false` printed the word "false" under a heading that
         read "unpriced channel", which asks the reader to negate a negative to
         learn that the fare IS recorded. Stated the plain way round instead. */
      unpriced_channel: (r) => (r.unpriced_channel ? pill('no', 'warn') : 'yes'),
    };
    /* Every other table in this product uses sentence case; these were raw
       column names with the underscores swapped for spaces. */
    const LABEL = {
      driver_refs: 'Driven by', held_by: 'Held by', plate: 'Plate', plates: 'Plates',
      driver: 'Driver', driver_name: 'Driver', counterparty: 'Counterparty',
      settlement_class: 'Settlement class', trips: 'Bookings', amount: 'Amount owed',
      oldest_days: 'Oldest, days', priced: 'With a fare', unpriced_channel: 'Fares recorded',
      expires_at: 'Expires', days_left: 'Days left', state: 'Why blocked',
      place: 'Drop-off area', drops: 'Drop-offs', avg_return_km: 'Average return',
      platform: 'Platform', lost: 'Lost', judged: 'Requests judged', pct: 'Lost share',
      journeys: 'Journeys', last_booking: 'Last booking',
    };
    /* Counts arrived through String(v): "45970" where the rest of the product
       writes 45,970. */
    const NUM = new Set(['trips', 'priced', 'drops', 'lost', 'judged', 'journeys', 'oldest_days']);
    /* Columns are built from whatever keys the finding's evidence carries, so a
       field the generator emits but never fills becomes a column of dashes —
       "last booking" was empty in all twelve rows of one action. The reason
       cannot be specific here, because the shape is different for every rule;
       what it CAN say is that the evidence itself carries nothing, which is
       the difference between "these vehicles have no last booking" and "this
       page failed to show one". */
    const cols = Object.keys(a.detail[0]).filter((k) => !HIDDEN.has(k)).map((k) => ({
      label: LABEL[k] || k.replace(/_/g, ' '), key: k,
      num: NUM.has(k) || k === 'amount' || k === 'pct' || k === 'days_left',
      absent: 'the evidence behind this finding carries no '
        + `${(LABEL[k] || k.replace(/_/g, ' ')).toLowerCase()} for any of its rows`,
      render: RENDER[k]
        || (NUM.has(k) ? (r) => (r[k] == null ? '\u2014' : fmt(r[k]))
          : (r) => (r[k] == null ? '\u2014' : esc(String(r[k])))),
    }));
    const tbl = tableFrom(a.detail, cols, { compact: true });
    basis.append(tbl);
    if (a.detail_of) {
      /* Not every finding's evidence is a sample of what the finding counts.
         The cancellations rule counts lost BOOKINGS and hands back one row per
         PLATFORM, which the generic caption rendered as "Showing 3 of 1,288" —
         three of a thousand two hundred and eighty-eight what? */
      basis.append(el('p', 'cap',
        `${countOf(a.detail.length, a.detail_of)}, covering all `
        + `${fmt(a.size)} ${a.size_unit || 'rows'}.`));
    } else if (a.size > a.detail.length) {
      basis.append(el('p', 'cap', `Showing ${a.detail.length} of ${fmt(a.size)}.`));
    } else if (a.detail.length > a.size) {
      /* The renewals finding counts documents expiring inside SEVEN days and
         hands back the whole forty-five day query as its evidence, so a
         headline reading "8" sat above a table of twelve. The extra rows are
         worth seeing — they are what comes next — but the table has to say
         that rather than leave the reader to think one of the two is wrong. */
      basis.append(el('p', 'cap',
        `The headline counts ${fmt(a.size)} ${a.size_unit || 'rows'} — the ones this finding is about. `
        + `The table carries ${fmt(a.detail.length - a.size)} more from the same query for context, `
        + 'which the columns distinguish.'));
    }
  }
  card.append(basis);

  const foot = el('div', 'act-foot');
  foot.innerHTML = `<a class="lnk" href="${esc(a.link)}">Open the evidence →</a>`;
  card.append(foot);
  return card;
}
