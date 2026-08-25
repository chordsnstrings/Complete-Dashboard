/* The analyst's findings — and, just as importantly, what it got wrong.
   ──────────────────────────────────────────────────────────────────────────
   A model proposed each claim on this page. The database then measured it
   against the rest of the fleet in the same window and decided whether it
   survived. Four verdicts are possible and all four are shown, because a page
   that only ever displays what the model got right teaches nobody how much to
   trust it:

     confirmed    true, large enough to act on, and larger than the sample size
                  would produce by chance
     refuted      the measurement points the other way
     immaterial   true, but about too few records or too small a difference
     unsupported  the measurement could not be made at all

   Every row carries the two numbers that decided it, the row counts on both
   sides, and the p-value where a test applied. Nothing here has to be taken on
   the model's word. */

import { empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, note, pill, pct } from './ui.js';
import { q, api, href, state } from './data.js';

export const ANALYST_TABS = [
  { id: 'confirmed', label: 'Survived the check', ic: '✓' },
  { id: 'refuted', label: 'Contradicted', ic: '✗' },
  { id: 'immaterial', label: 'True but too small', ic: '·' },
  { id: 'unsupported', label: 'Not measurable', ic: '?' },
  { id: 'rules', label: 'How this is judged', ic: '❑' },
];

const TONE = { confirmed: 'ok', refuted: 'err', immaterial: 'warn', unsupported: '' };

export async function renderAnalyst(root) {
  const tab = ANALYST_TABS.some((t) => t.id === state.param) ? state.param : 'confirmed';
  root.innerHTML = '';
  root.append(tabBar(ANALYST_TABS, tab, (id) => href('analyst', id === 'confirmed' ? null : id)));
  const host = el('div'); root.append(host);
  if (tab === 'rules') return analystRules(host);

  loading(host);
  const d = await q('/api/analyst/findings', { verdict: tab });
  host.innerHTML = '';
  host.append(kpiRow([
    { label: 'Survived the check', value: fmt(d.confirmed), tone: 'good' },
    { label: 'Contradicted by the data', value: fmt(d.refuted), tone: d.refuted ? 'critical' : null },
    { label: 'True but too small to act on', value: fmt(d.immaterial), tone: d.immaterial ? 'warn' : null },
    { label: 'Not measurable', value: fmt(d.unsupported) },
    { label: 'Passes', value: fmt(d.runs), sub: d.model ? `judged against ${d.model}` : null },
  ]));

  if (!d.findings.length) {
    /* Three different nothings, and the page told one story for all of them.
       "Has not run yet" is a scheduling delay somebody waits out; a model
       credential that is not set is a configuration nobody is going to wait
       into existence, and this fleet has the second — every pass count is
       zero because ARK_API_KEY is unset on the API. Read from a `configured`
       flag where the endpoint supplies one, and inferred from "no pass has
       ever run" where it does not. */
    const unconfigured = d.configured === false
      || (!d.runs && !d.model && !(d.confirmed || d.refuted || d.immaterial || d.unsupported));
    if (unconfigured) {
      host.append(note('The analyst is not configured on this deployment. It needs a model credential — '
        + 'the pass is a model call, so with no key nothing can run, and this page will stay empty '
        + 'however long you wait. It is not a scheduling delay.', 'warn'));
      const link = el('p', 'cap');
      link.innerHTML = `The key is set in the API environment, not in the database — `
        + `<a class="lnk" href="${href('settings')}">Settings</a> lists what the collector holds, and `
        + `<a class="lnk" href="${href('insights')}">the action list</a> is the rule-based findings, `
        + 'which need no model at all and are running.';
      host.append(link);
      return;
    }
    host.append(note(d.runs
      ? 'No finding in this category for this window. Widen the range above, or look at the other tabs — '
        + 'a pass that produced nothing here still produced something.'
      : 'The analyst has not run over this window yet. It runs from the collector schedule rather than '
        + 'from a page load, because each pass costs a model call.'));
    return;
  }

  d.findings.forEach((f) => {
    const card = el('div', `finding t-${TONE[f.verdict] || 'flat'}`);
    // The unit comes from the metric definition on the server. Deriving it
    // from the column name here printed a distance difference as a bare number.
    const u = f.unit || '';
    const unit = u === '%' ? '%' : u ? ` ${u}` : '';
    card.innerHTML = `
      <div class="fh">
        ${pill(f.verdict, TONE[f.verdict])}
        <b>${esc(f.claim)}</b>
      </div>
      <p class="fw">${esc(f.verdict_reason)}</p>
      <div class="fnums">
        <div><span>${esc(f.segment)}</span><b class="num">${fmt(f.measured_value, 1)}${unit}</b>
             <i>${fmt(f.segment_n)} records</i></div>
        <div><span>everything else</span><b class="num">${fmt(f.baseline_value, 1)}${unit}</b>
             <i>${fmt(f.baseline_n)} records</i></div>
        <div><span>difference</span><b class="num">${f.effect == null ? '—'
          : (f.effect > 0 ? '+' : '') + fmt(f.effect, 1) + unit}</b>
             <i>${f.effect_pct == null ? 'not comparable' : pct(f.effect_pct, 1) + ' of baseline'}</i></div>
        <div><span>by chance?</span><b class="num">${f.p_value == null ? 'no test'
          : f.p_value < 0.001 ? 'p &lt; 0.001' : 'p = ' + Number(f.p_value).toFixed(3)}</b>
             <i>${f.p_value == null ? 'no test applies to this comparison' : 'two-sided'}</i></div>
      </div>
      ${f.why ? `<p class="fwhy"><b>Why it matters</b> ${esc(f.why)}</p>` : ''}
      ${f.action && f.verdict === 'confirmed' ? `<p class="fact"><b>What to do</b> ${esc(f.action)}</p>` : ''}
      ${f.claimed_value != null && f.measured_value != null
        && Math.abs(f.claimed_value - f.measured_value) > 1
        ? `<p class="fcap">The model said ${fmt(f.claimed_value, 1)}${unit}; the measurement says ${fmt(f.measured_value, 1)}${unit}.</p>`
        : ''}`;
    host.append(card);
  });

  if (tab === 'refuted') {
    host.append(note('These are claims the model made that the data contradicts. They are kept rather '
      + 'than hidden: how often a model is wrong about this fleet is itself worth knowing, and it is the '
      + 'only honest basis for deciding how much weight to give the tab next door.'));
  }
}

async function analystRules(host) {
  loading(host);
  const r = await api('/api/analyst/rules');
  host.innerHTML = '';
  host.append(note(r.note));
  const m = r.materiality;
  host.append(kpiRow([
    { label: 'Minimum records in a segment', value: fmt(m.minSegmentN),
      sub: 'below this the estimate is noise' },
    { label: 'Minimum difference', value: pct(m.minRelEffect * 100, 0),
      sub: 'against the rest of the fleet' },
    { label: 'Significance threshold', value: `p < ${m.maxP}`,
      sub: 'where a test applies at all' },
  ]));
  const { panel: p1, body: b1 } = panel('What can be measured',
    'A claim about anything not on this list cannot be checked, so it is never shown as a finding.');
  b1.append(tableFrom(r.metrics, [
    { label: 'Metric', key: 'label' },
    { label: 'Key', key: 'metric', render: (x) => `<code>${esc(x.metric)}</code>` },
    { label: 'Kind', key: 'kind' },
    { label: 'Unit', key: 'unit' },
    { label: 'Defined over', key: 'defined_over', render: (x) => `<code>${esc(x.defined_over)}</code>` },
  ]));
  host.append(p1);
  const { panel: p2, body: b2 } = panel('What can be sliced',
    'The model names one of these and one value of it. It never writes a query.');
  b2.innerHTML = `<div class="chips">${r.dimensions.map((d) => `<span class="chip">${esc(d)}</span>`).join('')}</div>`;
  host.append(p2);
  const { panel: p3, body: b3 } = panel('Minimum absolute difference, by unit', null);
  b3.append(tableFrom(Object.entries(m.minAbsEffect).map(([unit, v]) => ({ unit, v })), [
    { label: 'Unit', key: 'unit' },
    { label: 'A difference smaller than this is not a finding', key: 'v', num: true },
  ]));
  host.append(p3);
}
