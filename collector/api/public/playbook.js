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

import { empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, money,
         entity, custody, custodyAsOf, dateStr, countOf, plural } from './ui.js';
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
    const HIDDEN = new Set(['driver_ext_id', 'driver_n']);
    const RENDER = {
      plate: (r) => entity('vehicle', r.plate, r.plate),
      driver: (r) => entity('driver', r.driver_ext_id, r.driver),
      driver_name: (r) => entity('driver', r.driver_ext_id, r.driver_name),
      held_by: (r) => custodyAsOf(r.held_by),
      driver_refs: (r) => custody(r) + (r.driver_n > (r.driver_refs || []).length
        ? ` <span class="dim">+${fmt(r.driver_n - (r.driver_refs || []).length)} more</span>` : ''),
    };
    const LABEL = { driver_refs: 'driven by', held_by: 'held by' };
    const cols = Object.keys(a.detail[0]).filter((k) => !HIDDEN.has(k)).map((k) => ({
      label: LABEL[k] || k.replace(/_/g, ' '), key: k,
      render: RENDER[k] || ((r) => (r[k] == null ? '—' : esc(String(r[k])))),
    }));
    const tbl = tableFrom(a.detail, cols, { compact: true });
    basis.append(tbl);
    if (a.size > a.detail.length) {
      basis.append(el('p', 'cap', `Showing ${a.detail.length} of ${fmt(a.size)}.`));
    }
  }
  card.append(basis);

  const foot = el('div', 'act-foot');
  foot.innerHTML = `<a class="lnk" href="${esc(a.link)}">Open the evidence →</a>`;
  card.append(foot);
  return card;
}
