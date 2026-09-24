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

import { empty, fmt, hbars, barChart } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, note, pill, pct, dtStr, dayStr, countOf,
  sentence, sourceLabel, sourceToken, swatch, contract, glance, secHead, absenceBand, pageFoot, money } from './ui.js';
import { q, api, href, state, currentGen, alive, windowLabel } from './data.js';

export const ANALYST_TABS = [
  { id: 'confirmed', label: 'Survived the check', ic: '✓' },
  { id: 'refuted', label: 'Contradicted', ic: '✗' },
  { id: 'immaterial', label: 'True but too small', ic: '·' },
  { id: 'unsupported', label: 'Not measurable', ic: '?' },
  { id: 'rules', label: 'How this is judged', ic: '❑' },
];

const TONE = { confirmed: 'ok', refuted: 'err', immaterial: 'warn', unsupported: '' };
/* The tab bar's own glyphs, on the contract's neutral verdict chips. */
const VERDICT_GLYPH = { confirmed: '✓', refuted: '✗', immaterial: '·', unsupported: '?' };

/* Ask for a pass now.
   ─────────────────────────────────────────────────────────────────────────
   The analyst runs on the collector's nightly schedule, which is the right
   default and the wrong loop to debug in: a fix to the prompt could only be
   checked the next morning, and on this fleet every pass for weeks had failed
   without anybody being able to try again. The endpoint queues one job and
   refuses a second while one is in flight, so the button cannot be leaned on.
   No credential: see the note on POST /api/analyst/run. */
function runButton() {
  const wrap = el('div', 'toolbar');
  const b = el('button', 'btn', 'Run a pass now');
  const said = el('span', 'cap');
  b.onclick = async () => {
    b.disabled = true; said.textContent = 'queueing…';
    try {
      const j = await api('/api/analyst/run', { method: 'POST', body: '{}' });
      said.textContent = j?.ok
        ? `queued as job ${j.job_id} — a pass takes about a minute; reload to see it`
        : (j?.detail || 'could not queue a pass');
      /* Left disabled where a retry is the wrong move: a 409 means a pass is
         already in flight, and pressing again queues nothing twice. */
      if (!j?.ok && !j?.already) b.disabled = false;
    } catch (e) { said.textContent = 'could not reach the API'; b.disabled = false; }
  };
  wrap.append(b, said);
  return wrap;
}

/* ── shared by both orders of the page ─────────────────────────────────────
   The verdict counts, the three empty states and the card: the old skin and
   the contract read one /api/analyst/findings answer through these, so they
   cannot disagree about a figure. */
function analystTiles(d) {
  return [
    { label: 'Survived the check', value: fmt(d.confirmed), tone: 'good' },
    { label: 'Contradicted by the data', value: fmt(d.refuted), tone: d.refuted ? 'critical' : null },
    { label: 'True but too small to act on', value: fmt(d.immaterial), tone: d.immaterial ? 'warn' : null },
    { label: 'Not measurable', value: fmt(d.unsupported) },
    { label: 'Passes', value: fmt(d.runs), sub: d.model ? `judged against ${d.model}` : null },
  ];
}

/* Three different nothings, and the page told one story for all of them —
   see the notes inside. Renders the right one into `host`. */
function emptyStates(host, d) {
  /* Three different nothings, and the page told one story for all of them.
     "Has not run yet" is a scheduling delay somebody waits out; a model
     credential that is not set is a configuration nobody is going to wait
     into existence, and this fleet has the second — every pass count is
     zero because ARK_API_KEY is unset on the API. Read from a `configured`
     flag where the endpoint supplies one, and inferred from "no pass has
     ever run" where it does not. */
  /* The endpoint records what the last pass actually did now, so the page
     no longer has to infer three states from two counts. A pass that
     reached the model and failed is the case this never had a word for —
     production ran nightly into a 429 and a timeout while this page said
     "the analyst has not run yet", which reads as something you wait out. */
  if (d.last_pass && d.last_pass.outcome === 'failed') {
    host.append(note(`The analyst ran and could not reach the model. It last tried ${
      dtStr(d.last_pass.finished_at)} and the call failed: ${d.last_pass.error
      || 'no reason was recorded'}. This page stays empty until that is fixed — `
      + 'it is not a scheduling delay.', 'warn'));
    const link = el('p', 'cap');
    link.innerHTML = `The model is called from the COLLECTOR, not from this page. `
      + `<a class="lnk" href="${href('sources')}">Data sources</a> shows what that process `
      + `can reach, and <a class="lnk" href="${href('insights')}">the action list</a> is the `
      + 'rule-based findings, which need no model at all and are running.';
    host.append(link);
    return;
  }
  const unconfigured = d.configured === false
    || d.last_pass?.outcome === 'no_model'
    || (!d.runs && !d.last_pass && !d.model
      && !(d.confirmed || d.refuted || d.immaterial || d.unsupported));
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
  /* The endpoint composes this sentence, so every surface that shows it
     says the same thing rather than each inferring its own. */
  host.append(note(d.empty_reason
    || (d.runs
      ? 'No finding in this category for this window. Widen the range above, or look at the other '
        + 'tabs — a pass that produced nothing here still produced something.'
      : 'The analyst has not run over this window yet. It runs from the collector schedule rather '
        + 'than from a page load, because each pass costs a model call.')));
  if (d.last_pass) {
    host.append(el('p', 'cap', `Last pass ${dtStr(d.last_pass.finished_at)}`
      + `${d.last_pass.model ? ` · ${d.last_pass.model}` : ''}`
      + ` · ${d.last_pass.proposed} proposed, ${d.last_pass.confirmed} confirmed`
      + `${d.last_pass.dropped ? `, ${d.last_pass.dropped} dropped` : ''}`));
  }
  host.append(runButton());
  return;
}
/* One judgement. `neutral` is the contract's: a verdict is not a better or
   worse delta under the colour law, so its chip is ink with the verdict's
   glyph (✓ ✗ · ?) and the card wears no tone; the card also says which
   window and which pass measured it, because each pass measures its own
   trailing span. A value the database could not measure prints "not
   measured" with the verdict's reason beside it, never a bare dash. */
function findingCard(f, { neutral = false } = {}) {
  const card = el('div', neutral ? 'finding' : `finding t-${TONE[f.verdict] || 'flat'}`);
  // The unit comes from the metric definition on the server. Deriving it
  // from the column name here printed a distance difference as a bare number.
  const u = f.unit || '';
  const unit = u === '%' ? '%' : u ? ` ${u}` : '';
  /* Under the contract a value the database could not measure says so in
     the value slot, and its reason is the verdict's, printed above it. */
  /* Ruling 2, money to the fils: an AED metric printed fmt(v, 1) + " AED" —
     "116 AED" beside "59.8 AED", neither a money figure (found by scanning
     the rendered text for AED amounts with no fils, 2026-09-24). Under the
     contract it is money(), as every other amount on the dashboard is; the
     old skin keeps its own rendering. */
  const isAed = neutral && u === 'AED';
  const val = (v) => (neutral && (v == null || v === '')
    ? '<span class="an-na">not measured</span>' : isAed ? money(v) : `${fmt(v, 1)}${unit}`);
  const chip = neutral
    ? `<span class="pill an-chip" data-verdict="${esc(f.verdict)}"><span aria-hidden="true">${esc(VERDICT_GLYPH[f.verdict] || '')}</span>${esc(f.verdict)}</span>`
    : pill(f.verdict, TONE[f.verdict]);
  card.innerHTML = `
      <div class="fh">
        ${chip}
        <b>${esc(f.claim)}</b>
      </div>
      <p class="fw">${esc(f.verdict_reason)}</p>${neutral ? `
      <p class="an-when">Measured over ${esc(dayStr(f.window_start))} → ${esc(dayStr(f.window_end))} · pass of ${esc(dtStr(f.created_at))}${f.run_id ? ` · ${esc(f.run_id)}` : ''}</p>` : ''}
      <div class="fnums">
        <div><span>${esc(f.segment)}</span><b class="num">${val(f.measured_value)}</b>
             <i>${fmt(f.segment_n)} records</i></div>
        <div><span>everything else</span><b class="num">${val(f.baseline_value)}</b>
             <i>${fmt(f.baseline_n)} records</i></div>
        <div><span>difference</span><b class="num">${f.effect == null ? (neutral ? '<span class="an-na">not measured</span>' : '—')
          : isAed ? (f.effect > 0 ? '+' : '') + money(f.effect) : (f.effect > 0 ? '+' : '') + fmt(f.effect, 1) + unit}</b>
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
  return card;
}

/* Two orders of one page until the operator flips the default skin: the old
   skin's (analystClassic) and the page contract (analystContract, below),
   sharing the tiles, the empty states and the card. */
export async function renderAnalyst(root) {
  return contract() ? analystContract(root) : analystClassic(root);
}

async function analystClassic(root) {
  const tab = ANALYST_TABS.some((t) => t.id === state.param) ? state.param : 'confirmed';
  root.innerHTML = '';
  root.append(tabBar(ANALYST_TABS, tab, (id) => href('analyst', id === 'confirmed' ? null : id)));
  const host = el('div', 'stack'); root.append(host);
  if (tab === 'rules') return analystRules(host);

  loading(host);
  const d = await q('/api/analyst/findings', { verdict: tab });

  /* Running a pass is a button, not a credential. The analyst reads what this
     API already serves and writes only its own findings, so it is not gated —
     see the note on POST /api/analyst/run. The page needs it because the
     alternative is waiting for a nightly cron to find out whether a fix
     worked. */
  host.innerHTML = '';
  host.append(kpiRow(analystTiles(d)));

  if (!d.findings.length) { emptyStates(host, d); return; }

  d.findings.forEach((f) => host.append(findingCard(f)));

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
  const { panel: p1, body: b1 } = panel('Numbers the model can check',
    'A claim about anything not on this list cannot be checked, so it is never shown as a finding.');
  b1.append(tableFrom(r.metrics, [
    { label: 'Metric', key: 'label' },
    { label: 'Key', key: 'metric', render: (x) => `<code>${esc(x.metric)}</code>` },
    { label: 'Kind', key: 'kind' },
    { label: 'Unit', key: 'unit' },
    { label: 'Defined over', key: 'defined_over', render: (x) => `<code>${esc(x.defined_over)}</code>` },
  ]));
  host.append(p1);
  const { panel: p2, body: b2 } = panel('Groups the model can compare',
    'The model names one of these and one value of it. It never writes a query.');
  b2.innerHTML = `<div class="chips">${r.dimensions.map((d) => `<span class="chip">${esc(d)}</span>`).join('')}</div>`;
  host.append(p2);
  /* The list the model actually chose from, this window.
     ─────────────────────────────────────────────────────────────────────────
     "What can be sliced" names the twelve dimensions in the abstract. This is
     what each of them CONTAINED when the brief was built — and it is the
     difference between a reader thinking the analyst ignored their worst
     vehicle and seeing that the vehicle cleared the floor and was offered. */
  const { panel: pc, body: bc } = panel('What the model could pick from, this window',
    'Every segment with at least the minimum records behind it, and where each metric is defined '
    + 'at all. A metric carried by one platform alone has no complement to compare against, so a '
    + 'claim about that platform cannot be settled and is never shown.');
  loading(bc);
  host.append(pc);
  q('/api/analyst/brief').then((brief) => {
    bc.innerHTML = '';
    const cand = brief?.candidates || {};
    const cov = brief?.metric_coverage || {};
    if (!Object.keys(cand).length) { empty(bc, 'No window to build a brief from'); return; }
    bc.append(tableFrom(Object.entries(cov).map(([metric, v]) => ({
      metric, rows: v.rows, unit: v.unit, platforms: (v.platforms || []).join(', ') })), [
      { label: 'Metric', key: 'metric', render: (x) => `<code>${esc(x.metric)}</code>` },
      { label: 'Rows it is defined on', key: 'rows', num: true },
      { label: 'Carried by', key: 'platforms',
        render: (x) => (x.platforms.split(', ').length === 1
          ? `${esc(x.platforms)} <span class="dim">— one platform, so no complement</span>`
          : esc(x.platforms)) },
    ]));
    for (const [dim, rows] of Object.entries(cand)) {
      const line = el('p', 'cap');
      line.innerHTML = `<b>${esc(dim)}</b> — ` + rows
        .map((x) => `${esc(x.segment)} <span class="dim">${fmt(x.n)}</span>`).join(' · ');
      bc.append(line);
    }
  }).catch(() => { bc.innerHTML = ''; empty(bc, 'Could not read the brief'); });

  const { panel: p3, body: b3 } = panel('Minimum absolute difference, by unit', null);
  b3.append(tableFrom(Object.entries(m.minAbsEffect).map(([unit, v]) => ({ unit, v })), [
    { label: 'Unit', key: 'unit' },
    { label: 'A difference smaller than this is not a finding', key: 'v', num: true },
  ]));
  host.append(p3);
}

/* ── #analyst under the page contract (plan §4, the five analyst entries,
   with the review's correction) ────────────────────────────────────────────
   The tab bar, every number on every card, the three empty states and the
   Run-a-pass button are kept. What changes:

     00  AT A GLANCE — five tiles, the tab's own verdict the hero, counted in
         DISTINCT CLAIMS (a claim is its dimension, segment, metric and
         direction: the nightly pass restates the same claim, 151 judgements
         were 31 claims on production), the judgements under it; no tile
         wears a tone — a verdict is not better or worse under the colour law.
     01  What became of every claim — the four verdicts as bars, each the
         address of its tab.
     02… per tab: confirmed — the segments above and below the rest of the
         fleet (the relative gap per distinct claim, a channel's marker only
         where the cut IS a platform), then judgements per pass and by cut;
         refuted — how far the model was off (claimed against measured, as a
         share of the claim); immaterial — each claim's effect against the
         materiality floor and its records against the minimum.
     —   the cards, ONE PER DISTINCT CLAIM: the latest judgement in full with
         its own window and pass, "judged N times, D1–D2, measured X–Y", and
         every older judgement folded beneath it AS A FULL CARD (the review's
         correction: a table of run/window/n/p would drop each one's reason,
         why and what-to-do — rule 1). Verdict chips are ink with the tab's
         glyph.
     †   four cells: claims measured over the window shown, the property rows
         in the model's pack, whether anyone acted, what a claim is worth.

   NOT ADOPTED: "what the model had to work with" (brief.by_platform —
   #platforms owns completion by channel); "what the model was allowed to
   measure" (brief.metric_coverage — the Rules tab already carries it); the
   absence cell "refuted and immaterial claims: counted, never listed" (false:
   each has its tab); the mockup's counts (15-Sep data). */
const claimKey = (f) => [f.dimension, f.segment, f.metric, f.direction].map((x) => String(x ?? '')).join('|');
const dayOf = (v) => String(v ?? '').slice(0, 10);
function groupClaims(findings) {
  const by = new Map();
  findings.forEach((f) => {
    const k = claimKey(f);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(f);
  });
  return [...by.values()].map((list) => list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))));
}
async function analystContract(root) {
  const gen = currentGen();
  const tab = ANALYST_TABS.some((t) => t.id === state.param) ? state.param : 'confirmed';
  root.innerHTML = '';
  root.append(tabBar(ANALYST_TABS, tab, (id) => href('analyst', id === 'confirmed' ? null : id)));
  const host = el('div', 'stack'); root.append(host);
  if (tab === 'rules') return analystRulesContract(host, gen);

  loading(host);
  const [d, brief, rules] = await Promise.all([
    q('/api/analyst/findings', { verdict: tab }),
    q('/api/analyst/brief').catch(() => null),
    tab === 'immaterial' ? api('/api/analyst/rules').catch(() => null) : Promise.resolve(null),
  ]);
  if (!alive(gen)) return;
  host.innerHTML = '';
  const groups = groupClaims(d.findings || []);
  const TILE_OF = { confirmed: 'Survived the check', refuted: 'Contradicted by the data',
    immaterial: 'True but too small to act on', unsupported: 'Not measurable' };

  /* ── 00 ──────────────────────────────────────────────────────────────── */
  const band = el('section', 'cband');
  const tiles = el('div');
  band.append(secHead('00', 'At a glance', windowLabel()), tiles);
  host.append(band);
  const base = analystTiles(d).map((t) => ({ ...t, tone: null }));
  const heroLabel = TILE_OF[tab];
  glance(tiles, [
    ...base.filter((t) => t.label === heroLabel).map((t) => ({ ...t, hero: true,
      label: `${t.label} — distinct claims`, value: fmt(groups.length),
      sub: `${countOf(d.findings.length, 'judgement')}: a nightly pass restates a claim it has made before` })),
    ...base.filter((t) => t.label !== heroLabel),
  ]);
  if (!d.findings.length) {
    emptyStates(host, d);
    pageFoot({ colophon: [windowLabel(), `${fmt(d.runs)} passes`, d.model ? `judged against ${d.model}` : null] }, root);
    return;
  }

  /* ── 01 · what became of every claim ─────────────────────────────────── */
  const fate = panel('What became of every claim', 'Judgements by verdict. Click a bar for its tab.', 'an-fate');
  host.append(fate.panel);
  hbars(fate.body, ANALYST_TABS.filter((t) => t.id !== 'rules').map((t) => ({ label: `${t.ic} ${t.label}`, id: t.id, n: Number(d[t.id]) || 0 })),
    { signed: false, onClick: (x) => { location.hash = href('analyst', x.id === 'confirmed' ? null : x.id); } });

  /* ── 02… · the tab's own charts ──────────────────────────────────────── */
  const latest = groups.map((g) => g[0]);
  const labelOf = (f) => `${String(f.dimension) === 'platform' ? sourceLabel(f.segment) : f.segment} · ${f.metric_label || f.metric}`;
  const chanOf = (f) => (String(f.dimension) === 'platform' ? sourceToken(f.segment) : null);
  if (tab === 'confirmed') {
    const withPct = latest.filter((f) => f.effect_pct != null && Number.isFinite(Number(f.effect_pct)));
    const g2 = el('div', 'grid g2'); host.append(g2);
    const up = panel('Segments above the rest of the fleet', null, 'an-above');
    const dn = panel('Segments below the rest of the fleet', null, 'an-below');
    g2.append(up.panel, dn.panel);
    const draw = (p, rows, word) => {
      if (!rows.length) { empty(p.body, `No confirmed claim puts a segment ${word} the rest of the fleet.`); return; }
      hbars(p.body, rows.map((f) => ({ label: labelOf(f), n: Math.abs(Number(f.effect_pct)), f })),
        { signed: false, valueFmt: (v) => `${word === 'above' ? '+' : '−'}${fmt(v, 1)}%`, colorFor: (x) => chanOf(x.f) });
      p.body.append(el('p', 'cap', esc(`The segment's value against the rest of the fleet, as a share of the rest — `
        + `${countOf(rows.length, 'distinct claim')}, the latest judgement of each. A channel's marker only where the cut is a platform.`)));
    };
    draw(up, withPct.filter((f) => Number(f.effect_pct) > 0).sort((a, b) => b.effect_pct - a.effect_pct), 'above');
    draw(dn, withPct.filter((f) => Number(f.effect_pct) < 0).sort((a, b) => a.effect_pct - b.effect_pct), 'below');
    const g3 = el('div', 'grid g2'); host.append(g3);
    const runs = panel('Confirmed judgements per pass', null, 'an-runs');
    const cuts = panel('Which cut the model found things in', null, 'an-cuts');
    g3.append(runs.panel, cuts.panel);
    const perRun = new Map();
    d.findings.forEach((f) => { const k = dayOf(f.created_at); perRun.set(k, (perRun.get(k) || 0) + 1); });
    barChart(runs.body, [...perRun.entries()].sort().map(([day, n]) => ({ day, n })),
      { x: 'day', y: 'n', color: '--ink', label: 'judgements', aria: 'Confirmed judgements per pass' });
    runs.body.append(el('p', 'cap', esc(`${countOf(perRun.size, 'pass day')}, ${countOf(d.findings.length, 'judgement')}.`)));
    const perCut = new Map();
    latest.forEach((f) => perCut.set(f.dimension, (perCut.get(f.dimension) || 0) + 1));
    hbars(cuts.body, [...perCut.entries()].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label: sentence(label), n })),
      { signed: false });
    cuts.body.append(el('p', 'cap', 'Distinct confirmed claims by the dimension the model cut the fleet on.'));
  } else if (tab === 'refuted') {
    const off = panel('How far the model was off', null, 'an-off');
    host.append(off.panel);
    const rows = latest.filter((f) => f.claimed_value != null && f.measured_value != null && Number(f.claimed_value) !== 0)
      .map((f) => ({ label: labelOf(f), n: ((Number(f.measured_value) - Number(f.claimed_value)) / Math.abs(Number(f.claimed_value))) * 100, f }))
      .sort((a, b) => Math.abs(b.n) - Math.abs(a.n));
    if (!rows.length) empty(off.body, 'No refuted claim carries both the value the model claimed and the one measured.');
    else {
      hbars(off.body, rows, { valueFmt: (v) => `${fmt(v, 1)}%`, colorFor: (x) => chanOf(x.f),
        legend: [['--mk-fill', 'measured above the claim'], ['--mk-neg', 'measured below it']] });
      off.body.append(el('p', 'cap', esc(`The measured value against the value the model claimed, as a share of the claim — `
        + `${countOf(rows.length, 'distinct claim')}. ${latest.length > rows.length ? `${fmt(latest.length - rows.length)} carry no claimed figure and are not drawn.` : ''}`)));
    }
  } else if (tab === 'immaterial') {
    const small = panel('Why each claim is too small', null, 'an-small');
    host.append(small.panel);
    const m = rules?.materiality || {};
    const rows = latest.filter((f) => f.effect_pct != null).map((f) => ({ label: labelOf(f), n: Math.abs(Number(f.effect_pct)), f }))
      .sort((a, b) => b.n - a.n);
    if (!rows.length) empty(small.body, 'No immaterial claim carries a relative effect.');
    else {
      hbars(small.body, rows, { signed: false, colorFor: (x) => chanOf(x.f),
        valueFmt: (v) => `${fmt(v, 1)}%` });
      small.body.append(el('p', 'cap', esc([
        m.minRelEffect != null ? `The floor is a ${fmt(m.minRelEffect * 100, 0)}% difference, ${fmt(m.minSegmentN)} records in the segment and p < ${m.maxP}.` : 'The materiality rules did not load.',
        `Of ${countOf(rows.length, 'distinct claim')}: ${fmt(rows.filter((x) => m.minRelEffect != null && x.n < m.minRelEffect * 100).length)} under the difference floor, `
          + `${fmt(rows.filter((x) => m.minSegmentN != null && Number(x.f.segment_n) < m.minSegmentN).length)} under the records floor, `
          + `${fmt(rows.filter((x) => m.maxP != null && x.f.p_value != null && Number(x.f.p_value) >= m.maxP).length)} a difference chance would produce.`,
      ].join(' '))));
    }
  }

  /* ── the cards, one per distinct claim ───────────────────────────────── */
  const cards = panel(tab === 'unsupported' ? 'Every claim the database could not measure' : 'Every claim, latest judgement first',
    'One card per distinct claim; earlier judgements of the same claim are folded under it, each in full.', 'an-cards');
  host.append(cards.panel);
  groups.forEach((g) => {
    const f = g[0];
    const wrap = el('div', 'an-claim');
    wrap.append(findingCard(f, { neutral: true }));
    if (g.length > 1) {
      const ms = g.map((x) => Number(x.measured_value)).filter(Number.isFinite);
      const u = f.unit === '%' ? '%' : f.unit ? ` ${f.unit}` : '';
      wrap.append(el('p', 'cap an-times', esc(`Judged ${fmt(g.length)} times, ${dayStr(g[g.length - 1].created_at)} – ${dayStr(f.created_at)}`
        + (ms.length ? `; measured ${fmt(Math.min(...ms), 1)}${u} – ${fmt(Math.max(...ms), 1)}${u}` : '') + '.')));
      const more = el('details', 'an-older');
      more.innerHTML = `<summary>The ${countOf(g.length - 1, 'earlier judgement')}, in full</summary>`;
      g.slice(1).forEach((x) => more.append(findingCard(x, { neutral: true })));
      wrap.append(more);
    }
    cards.body.append(wrap);
  });
  if (tab === 'refuted') {
    host.append(note('These are claims the model made that the data contradicts. They are kept rather '
      + 'than hidden: how often a model is wrong about this fleet is itself worth knowing, and it is the '
      + 'only honest basis for deciding how much weight to give the tab next door.'));
  }

  /* ── † ───────────────────────────────────────────────────────────────── */
  const absHost = el('div'); host.append(absHost);
  const w = Array.isArray(brief?.window) ? brief.window.map(dayOf) : null;
  const inWin = w ? latest.filter((f) => dayOf(f.window_start) === w[0] && dayOf(f.window_end) === w[1]).length : null;
  absenceBand(absHost, [
    { label: 'Claims measured over the window shown', hl: true,
      fig: inWin == null ? null : `${fmt(inWin)} of ${fmt(latest.length)}`, none: 'Not known',
      why: inWin == null ? 'The brief did not load, so the window this page asked for is not known here.'
        : `Each pass measures its own trailing span, so a claim can be over a different ${dayStr(w[0])} → ${dayStr(w[1])} than the one above; `
          + 'every card says which it was measured over.' },
    { label: 'Property rows in the model\'s pack', fig: brief ? fmt((brief.properties || []).length) : null, none: 'Not known',
      why: brief ? ((brief.properties || []).length ? 'The model was shown these corporate properties to cut on.'
        : 'The pack the model is shown holds no property rows, so it cannot propose a claim about one hotel.')
        : 'The brief did not load.' },
    { label: 'Whether anyone acted', fig: null, none: 'Not recorded',
      why: 'A judgement carries no acknowledgement and no owner: nothing records whether a confirmed claim was acted on.' },
    { label: 'What a claim is worth', fig: null, none: 'Not priced',
      why: 'A judgement carries a measured value and a baseline, never an AED figure, so no claim here is sized in money.' },
  ]);
  pageFoot({ colophon: [windowLabel(), `${countOf(latest.length, 'distinct claim')} · ${countOf(d.findings.length, 'judgement')}`,
    `${fmt(d.runs)} passes${d.model ? ` · ${d.model}` : ''}`] }, root);
}

/* The rules tab under the contract: reference material, restyled only — the
   note, the three thresholds as the 00 band, the four tables; a metric
   carried by one platform names it with its swatch. */
async function analystRulesContract(host, gen) {
  loading(host);
  const r = await api('/api/analyst/rules');
  if (!alive(gen)) return;
  host.innerHTML = '';
  const m = r.materiality;
  const band = el('section', 'cband');
  const tiles = el('div');
  band.append(secHead('00', 'At a glance', 'How a judgement is decided'), note(r.note), tiles);
  host.append(band);
  glance(tiles, [
    { label: 'Minimum records in a segment', value: fmt(m.minSegmentN), sub: 'below this the estimate is noise', hero: true },
    { label: 'Minimum difference', value: pct(m.minRelEffect * 100, 0), sub: 'against the rest of the fleet' },
    { label: 'Significance threshold', value: `p < ${m.maxP}`, sub: 'where a test applies at all' },
  ]);
  const { panel: p1, body: b1 } = panel('Numbers the model can check',
    'A claim about anything not on this list cannot be checked, so it is never shown as a finding.', 'an-metrics');
  b1.append(tableFrom(r.metrics, [
    { label: 'Metric', key: 'label' },
    { label: 'Key', key: 'metric', render: (x) => `<code>${esc(x.metric)}</code>` },
    { label: 'Kind', key: 'kind' },
    { label: 'Unit', key: 'unit' },
    { label: 'Defined over', key: 'defined_over', render: (x) => `<code>${esc(x.defined_over)}</code>` },
  ]));
  host.append(p1);
  const { panel: p2, body: b2 } = panel('Groups the model can compare',
    'The model names one of these and one value of it. It never writes a query.', 'an-dims');
  b2.innerHTML = `<div class="chips">${r.dimensions.map((d) => `<span class="chip">${esc(d)}</span>`).join('')}</div>`;
  host.append(p2);
  const { panel: pc, body: bc } = panel('What the model could pick from, this window',
    'Every segment with at least the minimum records behind it, and where each metric is defined '
    + 'at all. A metric carried by one platform alone has no complement to compare against, so a '
    + 'claim about that platform cannot be settled and is never shown.', 'an-pick');
  host.append(pc);
  const { panel: p3, body: b3 } = panel('Minimum absolute difference, by unit', null, 'an-abs');
  b3.append(tableFrom(Object.entries(m.minAbsEffect).map(([unit, v]) => ({ unit, v })), [
    { label: 'Unit', key: 'unit' },
    { label: 'A difference smaller than this is not a finding', key: 'v', num: true },
  ]));
  host.append(p3);
  loading(bc);
  const brief = await q('/api/analyst/brief').catch(() => null);
  if (!alive(gen)) return;
  bc.innerHTML = '';
  const cand = brief?.candidates || {};
  const cov = brief?.metric_coverage || {};
  if (!brief) empty(bc, 'Could not read the brief');
  else if (!Object.keys(cand).length) empty(bc, 'No window to build a brief from');
  else {
    bc.append(tableFrom(Object.entries(cov).map(([metric, v]) => ({
      metric, rows: v.rows, unit: v.unit, plats: v.platforms || [], platforms: (v.platforms || []).join(', ') })), [
      { label: 'Metric', key: 'metric', render: (x) => `<code>${esc(x.metric)}</code>` },
      { label: 'Rows it is defined on', key: 'rows', num: true },
      { label: 'Carried by', key: 'platforms',
        render: (x) => (x.plats.length === 1
          ? `<span class="chn">${swatch(x.plats[0])}${esc(sourceLabel(x.plats[0]))}</span> <span class="dim">— one platform, so no complement</span>`
          : x.plats.map((pl) => `<span class="chn">${swatch(pl)}${esc(sourceLabel(pl))}</span>`).join(' ')) },
    ]));
    for (const [dim, rows] of Object.entries(cand)) {
      const line = el('p', 'cap');
      line.innerHTML = `<b>${esc(dim)}</b> — ` + rows
        .map((x) => `${esc(x.segment)} <span class="dim">${fmt(x.n)}</span>`).join(' · ');
      bc.append(line);
    }
  }
  pageFoot({ colophon: [windowLabel(), `${countOf(r.metrics.length, 'metric')} · ${countOf(r.dimensions.length, 'dimension')}`] }, host);
}
