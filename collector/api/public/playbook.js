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
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, money } from './ui.js';
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
  root.append(kpiRow([
    { label: 'Things to do', value: fmt(d.actions.length),
      sub: `${d.actions.filter((a) => a.horizon === 'today' || a.horizon === 'this week').length} this week or sooner` },
    { label: 'Money already earned', value: money(t.aed_measured),
      sub: 'measured — these rows carry a price', tone: t.aed_measured ? 'warn' : null },
    { label: 'Idle capacity', value: fmt(t.bookings_ceiling), sub: 'bookings/month, at the fleet median',
      tone: t.bookings_ceiling ? 'warn' : null },
    { label: 'Vehicles earning', value: `${fmt(fleet.earning)} of ${fmt(fleet.vehicles_seen)}`,
      sub: fleet.median_bookings ? `median ${fmt(fleet.median_bookings)} bookings each` : null,
      tone: fleet.earning < fleet.vehicles_seen * 0.6 ? 'critical' : 'warn' },
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
    const cols = Object.keys(a.detail[0]).map((k) => ({
      label: k.replace(/_/g, ' '), key: k,
      render: (r) => (r[k] == null ? '—' : esc(String(r[k]))),
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
