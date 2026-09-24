/* The page phase, section "Today" — each page under the contract.
   ═══════════════════════════════════════════════════════════════════════════
   docs/UI-REDESIGN-PLAN.md §4 (Today), the operator's rulings (§1) and the
   house principle. For every converted page: the contract's shape under the
   skin, its figures against the answer the page itself received, its absences
   with their true reasons, and the old skin still building the old page
   (byte for byte is test/arkiv_classic_frozen.test.mjs's job).

   Synthetic data only: the mock, and fixtures built here. */
import { harness, shape } from './arkiv_pages.mjs';

const { check, start, open, done } = harness('Arkiv page phase — Today');
await start();

/* ══ #insights ═════════════════════════════════════════════════════════════ */
console.log('\n#insights');
const INS_HEADS = ['At a glance', 'Ranked actions', 'By category, over all 93', 'What is open, by kind',
  'What it costs to ignore', 'Cars off the road, by date', 'How old the licence backlog is',
  'The cars nobody can see', 'What Uber is asking the fleet to fix', '† What this page does not know'];
{
  const { ctx, page, answer } = await open('arkiv', 'insights');
  const s = await shape(page);
  const sum = answer('/api/insights/summary');
  const r = await page.evaluate(() => {
    const v = document.querySelector('#view');
    const txt = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
    return {
      chips: v.querySelectorAll('.btnrow a.btn').length,
      rows: v.querySelectorAll('[data-panel="ins-list"] .insight-list > .insight-row').length,
      inHbars: v.querySelectorAll('[data-panel="ins-list"] .hbars .insight-row').length,
      fold: txt(v.querySelector('[data-panel="ins-list"] .foldbtn')),
      catRows: v.querySelectorAll('[data-panel="ins-cat"] .hb[data-click]').length,
      kinds: [...v.querySelectorAll('[data-panel="ins-kind"] .hb')].map((h) => [txt(h.querySelector('.k')), txt(h.querySelector('.v')), !!h.querySelector('.hb-mk')]),
      kindCap: txt(v.querySelector('[data-panel="ins-kind"] .cap')),
      recHead: [...v.querySelectorAll('[data-panel="ins-recs"] thead th')].map(txt),
      gaps: [...v.querySelectorAll('[data-panel="ins-recs"] tbody tr')].map((tr) => txt(tr.querySelector('.dlt, .pill'))
        + '|' + (tr.querySelector('.dlt')?.className || '')),
      recCap: txt(v.querySelector('[data-panel="ins-recs"] .pbody p.cap')),
      costCap: txt(v.querySelector('[data-panel="ins-cost"] .cap')),
      costRows: [...v.querySelectorAll('[data-panel="ins-cost"] .hb')].map((h) => h.querySelector('.fill').className),
      docs: !!v.querySelector('[data-panel="ins-docs"] svg'), lic: !!v.querySelector('[data-panel="ins-lic"] svg'),
      licText: txt(v.querySelector('[data-panel="ins-lic"] .pbody')),
      darkCap: txt(v.querySelector('[data-panel="ins-dark"] .cap')),
      darkSkel: !!v.querySelector('[data-panel="ins-dark"] .skel'),
      aedInk: [...v.querySelectorAll('.insight-row .num')].every((n) => !/--critical|--warn/.test(n.getAttribute('style') || '')),
    };
  });
  check('the section order is the plan\'s: 00, the list, category, kind, cost, documents, licences, trackers, targets, †',
    JSON.stringify(s.heads) === JSON.stringify(INS_HEADS), JSON.stringify(s.heads));
  check('00 leads the page and the verdict is its statement (ruling 7)', s.first === 'cband' && s.vdctIn00, s.first);
  check('five tiles, Open actions the hero, its figure the summary\'s total',
    s.glance === 5 && s.hero === 'Open actions' && s.values['Open actions'] === String(sum.total.n), JSON.stringify(s.values));
  check('…with the stored count beside what was cleared', s.subs['Open actions'].includes(`${sum.stored_rows} findings stored`)
    && s.subs['Open actions'].includes(`${sum.resolved_since_last_run} cleared`), s.subs['Open actions']);
  check('Critical and Warnings are still the addresses of their lists (rule 3)',
    s.hrefs.Critical === '#insights/severity/critical' && s.hrefs.Warnings === '#insights/severity/warning', JSON.stringify(s.hrefs));
  check('a cost the summary does not carry is ABSENT with its reason, never "—"',
    s.na['Measured cost'] === 'no open finding carries a measured cost'
    && s.na['Idle capital, modelled'] === 'no idle car carries a modelled cost' && s.bare.length === 0, JSON.stringify(s.na));
  check('the chip row keeps every address: All, each category, each severity', r.chips === 1 + sum.by_category.length
    + sum.by_severity.filter((x) => ['critical', 'warning'].includes(x.severity) && x.n).length, String(r.chips));
  check('the ranked list is its own column of rows, not hbars\' grid, every row kept and the tail folded',
    r.rows === 7 && r.inHbars === 0 && /Show the other 1 action/i.test(r.fold), `${r.rows} ${r.inHbars} ${r.fold}`);
  check('…and no row\'s AED wears a severity colour', r.aedInk);
  check('02 draws every category as an address', r.catRows === sum.by_category.length, String(r.catRows));
  check('03 draws every rule from by_code, its count and a channel\'s marker only where one channel is named',
    r.kinds.length === sum.by_code.length && r.kinds.every(([, v], i) => v === String(sum.by_code[i].n))
    && r.kinds.filter(([, , m]) => m).length === sum.by_code.filter((c) => c.channels.length === 1).length,
    JSON.stringify(r.kinds));
  check('…over every open finding, and it says so', /over every open finding/.test(r.kindCap), r.kindCap);
  check('04 with nothing priced draws the never-priced as the OUTLINE, with the count', r.costRows.length === 1
    && /hb-outline/.test(r.costRows[0]) && r.costCap.startsWith(`0 of ${sum.total.n} open findings carry a cost`),
  `${JSON.stringify(r.costRows)} ${r.costCap}`);
  check('05 is drawn from the vehicle documents', r.docs);
  check('06 with no expired-licence finding says so rather than drawing an empty axis', !r.lic && /No open finding says a driving licence has expired/.test(r.licText), r.licText);
  check('07 says a car with no hour count is not drawn, and why the bars are ink', /carry no hour count/.test(r.darkCap)
    && /ink rather than a channel/.test(r.darkCap), r.darkCap);
  /* The mock's one silent-tracker finding carries no hour count, so no bar is
     drawn — and the panel kept its loading skeleton above the caption for
     good, because only hbars() cleared the body (the Fleet section's skeleton
     sweep found it, 2026-09-24). */
  check('07 with nothing to draw still clears its loading skeleton', !r.darkSkel, String(r.darkSkel));
  check('08: the pill is a signed gap against the target', r.recHead.includes('Against the target')
    && !r.recHead.includes('Meeting it'), JSON.stringify(r.recHead));
  check('…acceptance under its target is a red ▼ −6.0 points; cancellation over its target a red ▲ +5.0 (down is good)',
    /^▼\s*−6\.0/.test(r.gaps[0]) && /dlt-negative/.test(r.gaps[0]) && /^▲\s*\+5\.0/.test(r.gaps[1]) && /dlt-negative/.test(r.gaps[1]),
    JSON.stringify(r.gaps));
  check('…a rating over its target is a green ▲ +0.12', /\+0\.12/.test(r.gaps[2]) && /positive/.test(r.gaps[2]), r.gaps[2]);
  check('the † band has its four cells, the first sizing the priced share',
    s.abs.length === 4 && s.abs[0].fig === `0 of ${sum.total.n}` && s.abs[1].none && s.abs[2].fig === 'None', JSON.stringify(s.abs));
  check('two highlights: the hero, and the absence band\'s sized figure', s.hl === 2, String(s.hl));
  check('the colophon says the page is not windowed and counts what is open', /Not windowed/.test(s.colophon)
    && s.colophon.includes(`${sum.total.n} open`), s.colophon);
  check('the provenance line is the footer\'s basis', s.srcInFoot);
  check('no sideways scroll at 1440', s.overflowX <= 0, String(s.overflowX));
  await ctx.close();
}
/* A target with no figure on one side: missingTarget() read the null as 0
   and printed "on target" (plan §4 #insights, FIX rule 4). */
{
  const { ctx, page } = await open('arkiv', 'insights', { fixtures: {
    '/api/recommendations': (_q, real) => ({ ...real, rows: [...real.rows,
      { platform: 'uber', rec_type: 'TRIP_COMPLETION', period_start: null, period_end: null,
        org_value: null, target_value: null, flagged_count: 2, flagged: [] }] }),
  } });
  const r = await page.evaluate(() => ({
    last: document.querySelector('[data-panel="ins-recs"] tbody tr:last-child')?.textContent || '',
    cap: document.querySelector('[data-panel="ins-recs"] .pbody p.cap')?.textContent || '',
  }));
  check('a target with no published figure reads "no target published", never "on target"',
    /no target published/i.test(r.last) && !/on target/i.test(r.last), r.last);
  check('…and the caption counts only the targets with both figures', /targets with both figures/.test(r.cap)
    && /1 carry no published figure/.test(r.cap), r.cap);
  await ctx.close();
}
/* Priced findings: the tile says which rules priced its figure and on what
   assumption, and the cost chart puts the three forms side by side. */
const PRICED = {
  total: { n: 93, measured_impact: '397.68', modelled_impact: '23520.00', idle_vehicles: 14, priced_n: 15 },
  by_severity: [{ severity: 'critical', n: 85 }, { severity: 'warning', n: 8 }],
  by_category: [{ category: 'utilisation', n: 55 }, { category: 'compliance', n: 35 }, { category: 'revenue', n: 3 }],
  by_code: [
    { code: 'idle_vehicle', category: 'utilisation', n: 55, priced: 14, impact: '23520.00', channels: [] },
    { code: 'vehicle_doc_expiring', category: 'compliance', n: 35, priced: 0, impact: null, channels: [] },
    { code: 'cancellation_rate', category: 'revenue', n: 3, priced: 1, impact: '397.68', channels: ['bolt'] },
  ],
  modelled: { idle_vehicles: 14, aed: '23520.00', assumption: 'AED 120.00 per vehicle per day of holding cost, over a 14-day lookback' },
  stored_rows: 608, duplicates_suppressed: 0, resolved_since_last_run: 413,
};
{
  const LIC = (q, real) => (q.code === 'licence_expired' ? { ...real, truncated: false, insights: [5, 40, 200, 400, 401]
    .map((d, i) => ({ code: 'licence_expired', severity: 'critical', category: 'compliance', entity_type: 'driver',
      entity_id: `drv-${i}`, title: 't', action: 'a', metric: -d, impact_aed: null })) } : real);
  const { ctx, page } = await open('arkiv', 'insights', { fixtures: { '/api/insights/summary': PRICED, '/api/insights': LIC } });
  const s = await shape(page);
  const lic = await page.evaluate(() => ({
    bars: document.querySelectorAll('[data-panel="ins-lic"] svg rect.bar, [data-panel="ins-lic"] svg path.bar').length,
    cap: document.querySelector('[data-panel="ins-lic"] .pbody .cap')?.textContent || '' }));
  check('06 buckets the days past expiry and names the newest and oldest lapse, and #compliance\'s people count',
    /5 expired-licence findings: the newest lapsed 5 days ago, the oldest 401 days/.test(lic.cap)
    && /#compliance counts \d+ people with an expired licence/.test(lic.cap), lic.cap);
  const r = await page.evaluate(() => [...document.querySelectorAll('[data-panel="ins-cost"] .hb')].map((h) => ({
    k: h.querySelector('.k').textContent.trim(), form: h.querySelector('.fill').className,
    v: h.querySelector('.v').textContent.trim(), mk: !!h.querySelector('.hb-mk') })));
  check('Measured cost is the summary\'s figure, and says it holds an assumed 30%',
    s.values['Measured cost'] === 'AED 397.68' && /assumed 30%/.test(s.subs['Measured cost']), JSON.stringify([s.values, s.subs['Measured cost']]));
  check('04: modelled HATCHED, the priced rule solid with its channel\'s marker, the unpriced 78 OUTLINED',
    r.length === 3 && /hb-hatch/.test(r[0].form) && r[0].v === 'AED 23,520.00'
    && /hb-solid/.test(r[1].form) && r[1].mk && r[1].v === 'AED 397.68'
    && /hb-outline/.test(r[2].form) && r[2].k === 'The other 78 open findings' && /No cost model/.test(r[2].v), JSON.stringify(r));
  check('the † band sizes the assumption inside the measured figure', s.abs[3].fig === 'AED 397.68'
    && /assumed 30%/.test(s.abs[3].why), JSON.stringify(s.abs[3]));
  check('…and the priced share', s.abs[0].fig === '15 of 93', s.abs[0].fig);
  await ctx.close();
}
/* A server without by_code (production until this branch deploys), and a
   capped list: the page counts the rows it holds and SAYS they are partial —
   and never claims "none open" for what it cannot see. */
{
  const noCode = (_q, real) => { const { by_code: _drop, ...rest } = real; return { ...rest, total: { n: 93 } }; };
  const { ctx, page } = await open('arkiv', 'insights', { fixtures: {
    '/api/insights/summary': noCode,
    '/api/insights': (q, real) => (Object.keys(q).some((k) => ['code', 'category', 'severity'].includes(k)) ? real
      : { ...real, truncated: true, limit: 7 }),
  } });
  const s = await shape(page);
  const cap = await page.evaluate(() => document.querySelector('[data-panel="ins-kind"] .cap')?.textContent || '');
  check('by kind, counted from the served rows, says it is partial', /this server does not count by kind, so the chart is partial/.test(cap)
    && /the 7 rows the list serves, of 93 open/.test(cap), cap);
  check('…the priced share is Not counted, with the reason', s.abs[0].fig === 'Not counted'
    && /does not count how many open findings carry a cost/.test(s.abs[0].why), JSON.stringify(s.abs[0]));
  check('…and the cancellation assumption is Not counted rather than "None open"', s.abs[3].fig === 'Not counted', JSON.stringify(s.abs[3]));
  await ctx.close();
}
{
  const { ctx, page } = await open('classic', 'insights');
  const s = await shape(page);
  const r = await page.evaluate(() => ({
    list: document.querySelectorAll('#view .hbars > .insight-row').length,
    pills: [...document.querySelectorAll('#view tbody .pill')].map((p) => p.textContent),
  }));
  check('the old skin keeps today\'s page: a kpiRow of five, no 00, no † band, no highlight',
    s.first === 'kpis' && s.kpiRows === 1 && s.glance === 0 && s.abs.length === 0 && s.hl === 0, JSON.stringify(s));
  check('…its two panels, the list in .hbars, the targets as pills', JSON.stringify(s.heads)
    === JSON.stringify(['Ranked actions', 'What Uber is asking the fleet to fix']) && r.list === 7
    && r.pills.join() === 'below target,below target,on target', JSON.stringify([s.heads, r]));
  await ctx.close();
}

/* ══ #playbook ═════════════════════════════════════════════════════════════ */
console.log('\n#playbook');
const PB_GROUPS = ['Collect', 'Protect', 'Deploy', 'Cover', 'Improve'];
const pbRead = (page) => page.evaluate(() => {
  const v = document.querySelector('#view');
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
  return {
    claim: txt(v.querySelector('.cband .vdct-claim')), unit: txt(v.querySelector('.cband .vdct-fig i')),
    tones: [...v.querySelectorAll('.kpis.glance .kpi')].filter((k) => /\bt-(warn|critical|serious|good)\b/.test(k.className)).length,
    rate: !!v.querySelector('#pbRate'),
    where: [...v.querySelectorAll('[data-panel="pb-where"] .hb')].map((h) => [txt(h.querySelector('.k')), txt(h.querySelector('.v')),
      h.querySelector('.fill')?.className || '']),
    arith: [...v.querySelectorAll('[data-panel="pb-arith"] .hb .v')].map(txt),
    cards: v.querySelectorAll('.card.act').length,
    tonedPills: [...v.querySelectorAll('.card.act .act-tags .pill')].filter((p) => /\b(ok|warn|critical|bad)\b/.test(p.className)).length,
    ceilingChips: [...v.querySelectorAll('.act-cert[data-cert="ceiling"] .sw-proj')].length,
    ceilings: [...v.querySelectorAll('.act-cert[data-cert="ceiling"]')].length,
    errNote: !!v.querySelector('.note.err'),
  };
});
{
  const { ctx, page, answer } = await open('arkiv', 'playbook');
  const s = await shape(page);
  const r = await pbRead(page);
  const d = answer('/api/playbook');
  const groups = PB_GROUPS.filter((g) => d.actions.some((a) => a.group === g));
  const nd = d.fleet.new_driver_first_month, med = d.fleet.median_bookings;
  const idle = d.actions.find((a) => a.id === 'redeploy_idle_vehicles');
  check('the order: 00, where the cars are, the arithmetic, then the groups in their order, †',
    JSON.stringify(s.heads) === JSON.stringify(['At a glance', 'Where the fleet\'s cars are',
      'The arithmetic behind the ceilings', ...groups, '† What this page does not know']), JSON.stringify(s.heads));
  check('the verdict\'s unit is FIXED: a balance already earned, not "a month … over N days"',
    /already earned and not yet in hand/.test(r.claim) && !/a month/.test(r.claim) && r.unit === 'already earned, not yet in hand',
    `${r.claim} | ${r.unit}`);
  /* Ruling 7: the verdict's figure is the measured total, and no tile
     repeats it — P2 drew "Money already earned" as the hero beneath it, the
     same AED figure twice (corrected 2026-09-24, S4). */
  const vfig = await page.evaluate(() => document.querySelector('.cband .vdct-fig > b')?.textContent.trim() || '');
  check('the verdict\'s figure is the answer\'s measured total to the fils, and no tile repeats it (ruling 7)',
    vfig === `AED ${Number(d.totals.aed_measured).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
    && !Object.values(s.values).includes(vfig) && !('Money already earned' in s.values), `${vfig} ${JSON.stringify(s.values)}`);
  check('…so the hero passes to Things to do', s.hero === 'Things to do' && s.values['Things to do'] === String(d.actions.length),
    s.hero);
  check('no tile wears a tone (a level is not better-or-worse)', r.tones === 0, String(r.tones));
  check('Modelled upside with no rate set is ABSENT with its reason, not dropped',
    /no revenue-per-booking rate set/.test(s.na['Modelled upside'] || ''), JSON.stringify(s.na));
  check('Idle capacity adds the same ceiling at a new driver\'s rate, labelled a ceiling',
    s.subs['Idle capacity'].includes(`${(idle.size * nd).toLocaleString('en-US')} (${idle.size} cars × ${nd}) — a ceiling too`),
    s.subs['Idle capacity']);
  check('the rate control is kept (rule 3)', r.rate);
  check('01: earned, moved-but-never-earned and still, from .fleet', r.where.length === 3
    && r.where[1][0] === 'Moved, but never earned' && r.where[1][1].startsWith(String(d.fleet.moved_only)), JSON.stringify(r.where));
  check('02: the median car against a new driver\'s first month', r.arith.join('|') === `${med} bookings|${nd} bookings`, r.arith.join('|'));
  check('every card kept, no pill toned by certainty or horizon', r.cards === d.actions.length && r.tonedPills === 0,
    `${r.cards} ${r.tonedPills}`);
  check('a ceiling\'s chip carries the hatch swatch', r.ceilings > 0 && r.ceilingChips === r.ceilings, `${r.ceilingChips}/${r.ceilings}`);
  check('the red caveat note has moved into the † band, with the share it MEASURED, not "roughly a third"',
    !r.errNote && s.abs[0].label === 'The ceiling is not a forecast' && s.abs[0].fig === `${Math.round(nd / med * 100)}%`
    && s.abs[0].why.includes(`expect about ${Math.round(nd / med * 100)}% of the ceiling`) && !/roughly a third/.test(s.abs[0].why),
    JSON.stringify(s.abs[0]));
  check('two highlights: the hero and the sized caveat', s.hl === 2, String(s.hl));
  await ctx.close();
}
/* The journey feed filed nothing: "moved but never earned" 0 is not a count. */
{
  const { ctx, page } = await open('arkiv', 'playbook', { fixtures: {
    '/api/playbook': (_q, real) => ({ ...real, fleet: { ...real.fleet, moved_only: 0,
      still: real.fleet.still + real.fleet.moved_only, journeys_in_window: 0 } }) } });
  const s = await shape(page);
  const r = await pbRead(page);
  check('with no journey filed, the split is not drawn as 0 — idle cars as one bar, the split OUTLINED',
    r.where.length === 3 && r.where[1][0] === 'Took no booking' && /hb-outline/.test(r.where[2][2])
    && /Not measured/.test(r.where[2][1]), JSON.stringify(r.where));
  check('…and the † band says why', s.abs[3].label === 'Cars that moved but never earned' && s.abs[3].fig === 'Not measured'
    && /filed no journey in this window/.test(s.abs[3].why), JSON.stringify(s.abs[3]));
  await ctx.close();
}
{
  const { ctx, page } = await open('classic', 'playbook');
  const s = await shape(page);
  const r = await pbRead(page);
  const claim = await page.evaluate(() => document.querySelector('#view .vdct-claim')?.textContent || '');
  check('the old skin keeps today\'s page: a kpiRow, the red caveat note, its own verdict wording',
    s.kpiRows === 1 && s.glance === 0 && s.abs.length === 0 && r.errNote && /worth AED .* a month/.test(claim), JSON.stringify([s.kpiRows, claim]));
  await ctx.close();
}

/* ══ #compare ══════════════════════════════════════════════════════════════ */
console.log('\n#compare');
{
  const { ctx, page, answer } = await open('arkiv', 'compare');
  const s = await shape(page);
  const p = answer('/api/compare');
  const r = await page.evaluate(() => {
    const v = document.querySelector('#view');
    const txt = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
    const rows = (sel) => [...v.querySelectorAll(`${sel} svg`)].map((svg) => ({
      absent: svg.querySelectorAll('[data-absent]').length,
      fills: [...new Set([...svg.querySelectorAll('[data-rise]')].map((m) => m.getAttribute('fill')))] }));
    return {
      basis: txt(v.querySelector('.cmp-basis')),
      hours: rows('[data-panel="cmp-hours"]'), canc: rows('[data-panel="cmp-cancel"]'),
      hourCaps: [...v.querySelectorAll('[data-panel="cmp-hours"] p.cap')].map(txt),
      oldDelta: v.querySelectorAll('.dl.up, .dl.dn').length,
      signed: [...v.querySelectorAll('[data-panel="cmp-drivers"] tbody .dlt .dlt-v')].map(txt),
      cov: [...v.querySelectorAll('[data-panel="cmp-channel"] .cmp-cov')].map(txt),
      chn: v.querySelectorAll('[data-panel="cmp-channel"] tbody .chn .sw').length,
      stale: [...v.querySelectorAll('[data-panel="cmp-fresh"] .cmp-stale')].map(txt),
      stalePill: v.querySelectorAll('[data-panel="cmp-fresh"] tbody .pill.warn').length,
      toolbar: [...v.querySelectorAll('.toolbar input[type=date], .toolbar a.btn')].length,
    };
  });
  const A = p.totals.a, B = p.totals.b;
  check('the order: 00, hours, cancellations by hour, the driver table, channel and roster, collection, †',
    JSON.stringify(s.heads) === JSON.stringify(['At a glance', 'Hour by hour', 'Cancellations hour by hour',
      'Who drove more, who drove less', 'By channel', 'Started and stopped', 'Was everything collected?',
      '† What this page does not know']), JSON.stringify(s.heads));
  check('the toolbar keeps both pickers, Swap, Today vs yesterday and the cut toggle', r.toolbar === 5, String(r.toolbar));
  check('six tiles, Bookings the hero — the old "Change" tile is its delta', s.glance === 6 && s.hero === 'Bookings'
    && !s.labels.includes('Change') && s.values.Bookings === `${A.bookings} vs ${B.bookings}`, JSON.stringify(s.values));
  const tileD = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#view .kpis.glance .kpi')]
    .map((k) => [k.querySelector('.l').textContent.trim(), k.querySelector('.dlt')?.className.replace('dlt ', '') || '',
      ]).map(([l, c]) => [l, c])));
  check('Bookings\' delta is the change against the other day, red for a fall', tileD.Bookings === 'dlt-negative', JSON.stringify(tileD));
  check('Completed moves in points, Cancelled is inverted (no change here is said as such)',
    /dlt-/.test(tileD.Completed) && tileD.Cancelled === 'dlt-neutral', JSON.stringify(tileD));
  check('Distance carries both days\' telematics journeys, shown nowhere before',
    s.subs.Distance.includes(`${A.telematics} against ${B.telematics} telematics journeys`), s.subs.Distance);
  check('FIX (rule 4): the fares line says how many rows are priced and why — not "hotel, Yango and Bolt rows only"',
    r.basis.includes(`Fares cover ${A.priced} of ${A.bookings} bookings`) && /separate payments report/.test(r.basis)
    && !/hotel, Yango and Bolt rows only/.test(r.basis), r.basis);
  const pastCut = p.hours.filter((h) => h.past_cut).length;
  check('an hour the live day has not reached is the absence OUTLINE, on both hour charts, at least every hour past the cut',
    r.hours[0].absent >= pastCut && r.canc[0].absent === r.hours[0].absent && r.hours[1].absent === 0,
    JSON.stringify([r.hours, pastCut]));
  check('…and the caption counts them in hours', r.hourCaps.some((c) => c.startsWith(`${r.hours[0].absent} of 24 hours: not yet reached`)),
    JSON.stringify(r.hourCaps));
  check('the later day in ink, the earlier in grey — never Uber\'s blue', JSON.stringify(r.hours[0].fills) === '["var(--ink)"]'
    && JSON.stringify(r.hours[1].fills) === '["var(--grey)"]', JSON.stringify(r.hours));
  check('the driver table\'s changes are signed deltas, not the old arrow-and-magnitude', r.oldDelta === 0
    && r.signed.length > 0 && r.signed.every((x) => /^[+−]/.test(x)), JSON.stringify(r.signed));
  check('By channel names each channel with its swatch, and says where a fare covers part of it',
    r.chn === p.platforms.length && r.cov.join('|') === 'fares on 4 of 6 vs 6 of 8', JSON.stringify(r.cov));
  check('a stale source is ink words with the hollow dot, not an amber pill', r.stale.length === 1
    && r.stale[0] === 'stale · never succeeded' && r.stalePill === 0, JSON.stringify(r.stale));
  check('the † band: the fares priced share first and sized, then hours not reached, a stopped driver, silent sources',
    s.abs.length === 4 && s.abs[0].fig === `${A.priced} of ${A.bookings}` && /hour/.test(s.abs[1].fig)
    && s.abs[2].fig === 'Not known' && s.abs[3].fig === '1 of 2', JSON.stringify(s.abs.map((c) => c.fig)));
  check('two highlights, no bare tile', s.hl === 2 && s.bare.length === 0, `${s.hl} ${JSON.stringify(s.bare)}`);
  check('no sideways scroll at 1440', s.overflowX <= 0, String(s.overflowX));
  await ctx.close();
}
/* A waiting time is null below two bookings: one side measured and the other
   not is not a change of the measured side's size. */
{
  const { ctx, page } = await open('arkiv', 'compare', { fixtures: { '/api/compare': (_q, real) => ({ ...real,
    drivers: real.drivers.map((d, i) => (i ? d : { ...d, a: { ...d.a, wait_min: 90 }, b: { ...d.b, wait_min: null } })) }) } });
  const cell = await page.evaluate(() => document.querySelector('[data-panel="cmp-drivers"] tbody tr td[data-key="d_wait_min"], '
    + '[data-panel="cmp-drivers"] tbody tr td:nth-child(5)')?.textContent.replace(/\s+/g, ' ').trim());
  check('a waiting time measured on one day only prints no change beside it', /^1\.5 h vs —$/.test(cell), cell);
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', 'compare', { width: 390 });
  const s = await shape(page);
  check('#compare at 390: no sideways scroll', s.overflowX <= 0, String(s.overflowX));
  await ctx.close();
}
{
  const { ctx, page } = await open('classic', 'compare');
  const s = await shape(page);
  const cap = await page.evaluate(() => document.querySelector('#view').textContent);
  check('the old skin keeps today\'s page: seven tiles with Change, no 00, no † band',
    s.kpiRows === 1 && s.glance === 0 && s.abs.length === 0 && /Change/.test(cap), String(s.kpiRows));
  await ctx.close();
}

/* ══ #analyst ══════════════════════════════════════════════════════════════ */
console.log('\n#analyst');
const anRead = (page) => page.evaluate(() => {
  const v = document.querySelector('#view');
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
  return {
    tabs: v.querySelectorAll('.tabs a').length,
    toned: v.querySelectorAll('.finding[class*="t-"]').length,
    chips: [...v.querySelectorAll('.an-chip')].map(txt),
    when: v.querySelectorAll('[data-panel="an-cards"] .an-when').length,
    cards: v.querySelectorAll('[data-panel="an-cards"] .an-claim').length,
    older: [...v.querySelectorAll('.an-older')].map((d) => ({ n: d.querySelectorAll('.finding').length,
      why: d.querySelectorAll('.fwhy').length, sum: txt(d.querySelector('summary')) })),
    times: [...v.querySelectorAll('.an-times')].map(txt),
    na: [...v.querySelectorAll('[data-panel="an-cards"] .an-na')].map(txt),
    fate: [...v.querySelectorAll('[data-panel="an-fate"] .hb[data-click]')].length,
    note: /kept rather than hidden/.test(v.textContent),
  };
});
{
  const { ctx, page, answer } = await open('arkiv', 'analyst');
  const s = await shape(page);
  const r = await anRead(page);
  const d = answer('/api/analyst/findings');
  const keys = new Set(d.findings.map((f) => [f.dimension, f.segment, f.metric, f.direction].join('|')));
  check('confirmed: 00, the fate of every claim, above/below, per pass and by cut, the cards, †',
    JSON.stringify(s.heads) === JSON.stringify(['At a glance', 'What became of every claim', 'Segments above the rest of the fleet',
      'Segments below the rest of the fleet', 'Confirmed judgements per pass', 'Which cut the model found things in',
      'Every claim, latest judgement first', '† What this page does not know']), JSON.stringify(s.heads));
  check('the tab bar keeps its five addresses', r.tabs === 5, String(r.tabs));
  check('the hero counts DISTINCT claims, the judgements under it', s.hero === 'Survived the check — distinct claims'
    && s.values[s.hero] === String(keys.size) && s.subs[s.hero].startsWith(`${d.findings.length} judgement`), JSON.stringify([s.values, s.subs[s.hero]]));
  check('five tiles, none toned (a verdict is not better or worse)', s.glance === 5
    && !(await page.evaluate(() => document.querySelectorAll('#view .kpis.glance .kpi[class*=" t-"]').length)), String(s.glance));
  check('01: the four verdicts as bars, each an address of its tab', r.fate === 4, String(r.fate));
  check('cards: one per claim, each chip ink with its glyph, each naming its window and pass, none toned',
    r.cards === keys.size && r.chips.every((c) => c.startsWith('✓')) && r.when === keys.size && r.toned === 0,
    JSON.stringify([r.cards, r.chips, r.when, r.toned]));
  check('the † band: window, property rows, whether anyone acted, worth in money', s.abs.length === 4
    && s.abs[2].fig === 'Not recorded' && s.abs[3].fig === 'Not priced' && /of/.test(s.abs[0].fig), JSON.stringify(s.abs.map((c) => c.fig)));
  check('two highlights', s.hl === 2, String(s.hl));
  await ctx.close();
}
/* The same claim judged by three passes: one card, the older two folded
   beneath it in FULL (the review's correction — rule 1). */
{
  const { ctx, page } = await open('arkiv', 'analyst', { fixtures: { '/api/analyst/findings': (_q, real) => {
    const f = real.findings[0];
    const older = [1, 2].map((k) => ({ ...f, id: 90 + k, measured_value: f.measured_value - k,
      created_at: new Date(Date.parse(f.created_at) - k * 864e5).toISOString() }));
    return { ...real, findings: [...real.findings, ...older] };
  } } });
  const r = await anRead(page);
  const s = await shape(page);
  check('three judgements of one claim are ONE card, "judged 3 times", the measured range stated',
    r.cards === 2 && r.times.length === 1 && /^Judged 3 times, .* measured 68\.2% – 70\.2%\.$/.test(r.times[0]), JSON.stringify(r.times));
  check('…and the two earlier judgements fold beneath it as full cards, each with its why', r.older.length === 1
    && r.older[0].n === 2 && r.older[0].why === 2 && /2 earlier judgements/.test(r.older[0].sum), JSON.stringify(r.older));
  check('…the hero still counts claims, not judgements', s.values[s.hero] === '2', s.values[s.hero]);
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', 'analyst/refuted');
  const s = await shape(page); const r = await anRead(page);
  check('refuted: its hero, how far the model was off, the kept-not-hidden note', s.hero === 'Contradicted by the data — distinct claims'
    && s.heads.includes('How far the model was off') && r.note && r.chips.every((c) => c.startsWith('✗')), JSON.stringify([s.hero, s.heads]));
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', 'analyst/immaterial');
  const s = await shape(page);
  const cap = await page.evaluate(() => document.querySelector('[data-panel="an-small"] .cap')?.textContent || '');
  check('immaterial: each claim against the materiality floor, and which floor it is under', s.hero === 'True but too small to act on — distinct claims'
    && /The floor is a \d+% difference/.test(cap) && /under the difference floor/.test(cap), cap);
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', 'analyst/unsupported');
  const r = await anRead(page);
  check('unsupported: a value the database could not measure says "not measured", never a bare dash',
    r.na.length === 3 && r.na.every((x) => x === 'not measured') && r.chips.every((c) => c.startsWith('?')), JSON.stringify(r.na));
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', 'analyst/rules');
  const s = await shape(page);
  const sw = await page.evaluate(() => [...document.querySelectorAll('[data-panel="an-pick"] tbody tr')]
    .map((tr) => tr.querySelectorAll('.chn .sw').length));
  check('rules: the three thresholds as the 00 band, the four tables kept', s.glance === 3
    && JSON.stringify(s.heads) === JSON.stringify(['At a glance', 'Numbers the model can check', 'Groups the model can compare',
      'What the model could pick from, this window', 'Minimum absolute difference, by unit']), JSON.stringify(s.heads));
  check('…a metric carried by one platform names it with its swatch, not coloured text', JSON.stringify(sw) === '[2,1]', JSON.stringify(sw));
  await ctx.close();
}
{
  const { ctx, page } = await open('classic', 'analyst');
  const s = await shape(page); const r = await anRead(page);
  check('the old skin keeps today\'s page: a kpiRow of five, toned cards, no 00', s.kpiRows === 1 && s.glance === 0
    && r.toned > 0 && r.chips.length === 0, JSON.stringify([s.kpiRows, r.toned]));
  await ctx.close();
}

/* ══ #action ═══════════════════════════════════════════════════════════════ */
console.log('\n#action');
{
  /* The rule writes metric 0 for every idle car (src/insights.js); the mock's
     row leaves it out. */
  const { ctx, page } = await open('arkiv', 'action/idle_vehicle/L46207', { fixtures: {
    '/api/insights': (_q, real) => ({ ...real, insights: real.insights.map((x) => (x.code === 'idle_vehicle' ? { ...x, metric: 0 } : x)) }) } });
  const s = await shape(page);
  const hero = await page.evaluate(() => ({ sw: !!document.querySelector('#view .kpis.glance .is-hero .n .sw-proj'),
    title: document.querySelector('#viewTitle')?.textContent || '' }));
  check('00, what we found and what to do side by side, †', JSON.stringify(s.heads)
    === JSON.stringify(['At a glance', 'What we found', 'What to do', '† What this page does not know']), JSON.stringify(s.heads));
  check('a modelled size is the hero, with the hatch swatch and its label', s.hero === 'Sized at'
    && s.values['Sized at'] === 'AED 1,680.00' && hero.sw && /modelled holding cost/.test(s.subs['Sized at']), JSON.stringify(s.values));
  check('the figure the rule fired on says what it is, per rule', s.subs['Measured at'] === 'bookings in the last 14 days',
    s.subs['Measured at']);
  check('a tile for the same rule elsewhere, zero said as such', s.values['The same rule elsewhere'] === '0'
    && /no other open finding/.test(s.subs['The same rule elsewhere']), JSON.stringify(s.subs));
  check('the † band: parked on purpose, where the AED comes from, whether anyone acted, what the figure is not',
    JSON.stringify(s.abs.map((c) => c.label)) === JSON.stringify(['Whether the car is parked on purpose', 'Where the AED comes from',
      'Whether anyone acted', 'What the figure is not']) && s.abs[1].fig === 'An assumption', JSON.stringify(s.abs));
  check('the page is still titled by the finding', /L46207 is reporting but has not earned/.test(hero.title), hero.title);
  await ctx.close();
}
{
  const stale = [['L82923', 38], ['L11111', 120], ['L22222', 7]].map(([p, h]) => ({ code: 'stale_tracker', severity: h > 72 ? 'critical' : 'warning',
    category: 'data', entity_type: 'vehicle', entity_id: p, title: `${p} has not reported a position for ${h}h`,
    detail: 'd', action: 'a', impact_aed: null, metric: h, computed_at: '2026-08-21T09:00:00Z', window_start: null }));
  const { ctx, page } = await open('arkiv', 'action/stale_tracker/L82923', { fixtures: {
    '/api/insights': (_q, real) => ({ ...real, insights: [...real.insights.filter((x) => x.code !== 'stale_tracker'), ...stale] }) } });
  const s = await shape(page);
  const r = await page.evaluate(() => ({
    bars: [...document.querySelectorAll('[data-panel="act-every"] .hb .k')].map((k) => k.textContent),
    sib: document.querySelectorAll('[data-panel="act-siblings"] tbody tr').length }));
  check('with no size, the figure the rule fired on is the hero, in its own unit', s.hero === 'Measured at'
    && s.values['Measured at'] === '38 h' && s.subs['Measured at'] === 'hours since the tracker last filed a position', JSON.stringify(s.values));
  check('02: the same rule on every entity, largest first, this one marked', JSON.stringify(r.bars)
    === JSON.stringify(['L11111', 'L82923 · this finding', 'L22222']), JSON.stringify(r.bars));
  check('03: every sibling in the table', r.sib === 2, String(r.sib));
  check('an unpriced rule says so in the band, never a nought', s.abs.some((c) => c.label === 'What it would cost' && c.fig === 'Not priced'));
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', 'action/nope/-');
  const t = await page.evaluate(() => document.querySelector('#view').textContent);
  check('a finding that is not open says so, as before', /no longer open/.test(t), t.slice(0, 120));
  await ctx.close();
}
{
  const { ctx, page } = await open('classic', 'action/idle_vehicle/L46207');
  const s = await shape(page);
  check('the old skin keeps today\'s page: a kpiRow, no 00, no † band', s.kpiRows === 1 && s.glance === 0 && s.abs.length === 0);
  await ctx.close();
}

await done();
