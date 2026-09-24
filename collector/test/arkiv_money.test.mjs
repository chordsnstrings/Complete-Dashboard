/* The page phase, section "Money" — each page under the contract.
   ═══════════════════════════════════════════════════════════════════════════
   docs/UI-REDESIGN-PLAN.md §4 (Money), the operator's rulings (§1) and the
   house principle. For every converted page: the contract's shape under the
   skin, its figures against the answer the page itself received, its absences
   with their true reasons, and the old skin still building the old page
   (byte for byte is test/arkiv_classic_frozen.test.mjs's job).

   Synthetic data only: the mock, and fixtures built here. */
import { harness, shape } from './arkiv_pages.mjs';

const { check, start, open, done } = harness('Arkiv page phase — Money');
await start();

/* money() as the pages print it: two decimals, separators, always. */
const aed = (n) => `${Number(n) < 0 ? '−' : ''}AED ${Math.abs(Number(n)).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const txtOf = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  return n ? n.textContent.replace(/\s+/g, ' ').trim() : '';
}, sel);
const toned = (page) => page.evaluate(() => [...document.querySelectorAll('#view .kpis.glance > .kpi')]
  .filter((t) => /\bt-(good|warn|critical|serious)\b/.test(t.className)).map((t) => t.className));
const keys = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(s)]
  .map((t) => t.getAttribute('data-kpi')).filter(Boolean), sel);

/* ══ #unit — Money in ═════════════════════════════════════════════════════ */
console.log('\n#unit');
const UNIT_HEADS = ['At a glance', 'What a car earns on a day it earns anything', 'Which cars earn the money',
  'Money per km, by channel', 'Cars earning most per day worked', 'Cars earning least per day worked',
  'Drivers earning most per day worked', 'Drivers earning least per day worked',
  'What a person earns on a day they work', 'Days earned against the rate, one dot per car', 'What the cars did',
  'What the people did', 'The hours behind the hourly rate', 'Insured cars that earned nothing',
  'Where each car was last seen', '† What this page does not know'];
let classicUnitKeys = [];
let classicCaps = [];
const ledgerCaps = (page) => page.evaluate(() => ['unit-cars-top', 'unit-cars-bottom', 'unit-drivers-top', 'unit-drivers-bottom']
  .map((k) => document.querySelector(`[data-panel="${k}"] .cap, [data-panel="${k}"] > p`)?.textContent.replace(/\s+/g, ' ').trim() || ''));
{
  const { ctx, page } = await open('classic', 'unit');
  classicUnitKeys = await keys(page, '#view .kpis .kpi');
  classicCaps = await ledgerCaps(page);
  const r = await page.evaluate(() => ({
    band: !!document.querySelector('#view .cband'), rows: document.querySelectorAll('#view .kpis').length,
    hist: !!document.querySelector('[data-panel="unit-hist"]') }));
  check('old skin: the old page — no 00 band, its tile row, none of the contract\'s charts',
    !r.band && r.rows >= 1 && !r.hist, JSON.stringify(r));
  await ctx.close();
}
{
  const { ctx, page, answer } = await open('arkiv', 'unit');
  const s = await shape(page);
  const A = answer('/api/economics/assets'), D = answer('/api/economics/drivers'), K = answer('/api/kpis');
  const t = A.totals, dt = D.totals;
  check('the section order is the plan\'s: 00, the car histogram, the curve beside the yields, the four ledgers, '
    + 'the people and the cars spread out, the idle-and-insured list, the map, †',
  JSON.stringify(s.heads) === JSON.stringify(UNIT_HEADS), JSON.stringify(s.heads));
  const order = await page.evaluate(() => { const v = document.querySelector('#view');
    return [v.firstElementChild.className, v.children[1]?.firstElementChild?.className]; });
  check('the tab bar is kept, and 00 is the first thing under it', order[0].includes('tabs') && order[1] === 'cband', JSON.stringify(order));
  check('the verdict is 00\'s statement (ruling 7)', s.vdctIn00);
  check('all eight tiles, in one band, Money placed on cars the hero with the assets answer\'s total',
    s.glance === 8 && s.glanceBands === 1 && s.hero === 'Money placed on cars'
    && s.values['Money placed on cars'] === aed(t.money), JSON.stringify(s.values));
  check('…the tiles\' keys are the old page\'s, every one (rule 1)',
    JSON.stringify(await keys(page, '#view .kpis.glance > .kpi')) === JSON.stringify(classicUnitKeys), JSON.stringify(classicUnitKeys));
  check('…and the Finance comparison and the refusal to price never-earned idle days are still on their tiles',
    s.subs['Money placed on cars'].includes(`against ${aed(K.accounted)} on Finance`)
    && /have never earned, which have no rate of their own/.test(s.subs['Days a car sat idle']), s.subs['Days a car sat idle']);
  check('no tile wears a tone — a level is not better or worse', (await toned(page)).length === 0, JSON.stringify(await toned(page)));
  check('Cars earning and Insured and idle still open their cohorts', s.hrefs['Cars earning']?.startsWith('#cohort/unit-moved-unpaid')
    && s.hrefs['Insured and idle']?.startsWith('#cohort/unit-idle-documented'), JSON.stringify(s.hrefs));

  const perDay = A.rows.map((r) => r.aed_per_earning_day).filter((x) => x != null).map(Number).sort((a, b) => a - b);
  const hcap = await txtOf(page, '[data-panel="unit-hist"] .cap');
  check('01 is drawn over every car with a daily rate, and its median is the rows\' median',
    hcap.includes(`over ${perDay.length} cars that earned`) && hcap.includes(`median ${aed(perDay[Math.floor(perDay.length / 2)])}`)
    && !!(await page.$('[data-panel="unit-hist"] svg')), hcap);
  check('…with the fleet rate the assets answer carries', hcap.includes(`the fleet rate is ${aed(t.aed_per_earning_day)}`), hcap);
  check('the four ranked ledgers keep their threshold captions word for word',
    JSON.stringify(await ledgerCaps(page)) === JSON.stringify(classicCaps) && classicCaps.every(Boolean), JSON.stringify(classicCaps));
  const did = await page.evaluate(() => ['unit-cars-did', 'unit-people-did', 'unit-hours'].map((k) => [...document
    .querySelectorAll(`[data-panel="${k}"] .hb`)].map((h) => [h.querySelector('.k').textContent.trim(), h.querySelector('.v').textContent.replace(/\s+/g, ' ').trim()])));
  check('what the cars did: earning, moved with no money, never moved — the assets totals',
    did[0].map(([, v]) => v.split(' ')[0]).join() === [t.earning, t.moved_unpaid, t.still].join(), JSON.stringify(did[0]));
  check('what the people did: the drivers totals', did[1].map(([, v]) => v.split(' ')[0]).join() === [dt.earning, dt.drove_unpaid, dt.idle].join(),
    JSON.stringify(did[1]));
  const hrs = await txtOf(page, '[data-panel="unit-hours"] .cap');
  check('the hours behind the hourly rate are the measured people\'s, and say how many',
    did[2].length === 2 && hrs.includes(`by the ${dt.people_with_availability} people whose availability is measured`)
    && hrs.includes(`${aed(dt.aed_per_measured_hour)} an hour`), `${JSON.stringify(did[2])} ${hrs}`);
  const leg = await page.evaluate(() => [...document.querySelectorAll('[data-panel="unit-map"] .legend i')]
    .map((i) => ({ cls: i.className, bg: getComputedStyle(i).backgroundColor, ring: getComputedStyle(i).boxShadow })));
  check('the map\'s legend is by FORM: an ink dot, the negative dot, and the absence outline for a car that never moved',
    leg.length === 3 && leg[2].cls.includes('ak-sw-out') && leg[2].bg === 'rgba(0, 0, 0, 0)' && /inset/.test(leg[2].ring)
    && leg[0].bg !== leg[1].bg, JSON.stringify(leg));
  check('the † band: the cost nobody holds, the measured hours, Finance\'s figure, the bookings before money',
    s.abs.length === 4 && s.abs[0].none && s.abs[1].fig === `${dt.people_with_availability} of ${dt.people}`
    && s.abs[2].fig === aed(K.accounted) && s.abs[2].why.includes(aed(t.money)), JSON.stringify(s.abs));
  check('three highlights at most: the hero, the busiest band, the measured hours', s.hl === 3, String(s.hl));
  check('the colophon counts the earning cars and the money', s.colophon.includes(`${t.earning} of ${t.vehicles} cars earning`)
    && s.colophon.includes(aed(t.money)), s.colophon);
  check('no sideways scroll at 1440', s.overflowX <= 0, String(s.overflowX));
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', 'unit', { width: 390, scheme: 'dark' });
  const s = await shape(page);
  const ink = await page.evaluate(() => {
    const i = document.querySelector('[data-panel="unit-map"] .legend i');
    const probe = document.createElement('i'); probe.style.color = 'var(--ink)'; document.body.append(probe);
    return [i && getComputedStyle(i).backgroundColor, getComputedStyle(probe).color];
  });
  check('390, dark: every section, no sideways scroll', s.heads.length === UNIT_HEADS.length && s.overflowX <= 0, `${s.heads.length} ${s.overflowX}`);
  check('…and the earning dot is the dark theme\'s ink, not a fixed black', ink[0] && ink[0] === ink[1], JSON.stringify(ink));
  await ctx.close();
}
/* The ranked lists prune a column nobody on the list has. The reason said
   "availability has not been collected for anyone in this window" whenever
   ONE list's ten rows had no hours — while the verdict counted the people
   whose availability was measured. Under the contract the reason is the
   list's own. */
{
  const noHours = (_q, real) => ({ ...real, rows: real.rows.map((r) => ({ ...r, measured_hours_online: null,
    measured_idle_h: null, aed_per_measured_hour: null })) });
  const why = (page) => txtOf(page, '[data-panel="unit-drivers-bottom"] .pbody');
  const a = await open('arkiv', 'unit', { fixtures: { '/api/economics/drivers': noHours } });
  const dt = a.answer('/api/economics/drivers').totals;
  const wa = await why(a.page);
  check('a list with no measured hours says so of the list, and counts who is measured',
    wa.includes('none of the drivers on this list has measured online hours')
    && wa.includes(`availability is measured for ${dt.people_with_availability} of ${dt.people} people`)
    && !wa.includes('for anyone in this window'), wa.slice(0, 400));
  await a.ctx.close();
  const c = await open('classic', 'unit', { fixtures: { '/api/economics/drivers': noHours } });
  check('…the old skin keeps its sentence', (await why(c.page)).includes('availability has not been collected for anyone in this window'));
  await c.ctx.close();
}

/* ══ #unit/assets — Every vehicle ═════════════════════════════════════════ */
console.log('\n#unit/assets');
{
  const { ctx, page, answer } = await open('arkiv', 'unit/assets');
  const s = await shape(page);
  const A = answer('/api/economics/assets');
  const t = A.totals;
  const r = await page.evaluate(() => ({
    order: [document.querySelector('#view').firstElementChild.className,
      document.querySelector('#view').children[1]?.firstElementChild?.className],
    cov: !!document.querySelector('#view .cband .note, #view .cband p'),
    ref: !!document.querySelector('#view svg .sc-ref'),
    filters: document.querySelectorAll('#view .btnrow button, #view .btnrow a.btn, #view .bandbtns button').length,
    search: !!document.querySelector('#view input[type="search"], #view input[type="text"]'),
    rows: document.querySelectorAll('#view table tbody tr').length,
  }));
  const cap = await page.evaluate(() => [...document.querySelectorAll('#view .panel .cap')].map((c) => c.textContent)
    .find((x) => /per km/.test(x)) || '');
  check('the tab bar, then 00 with the coverage note in it', r.order[0].includes('tabs') && r.order[1] === 'cband' && r.cov, JSON.stringify(r.order));
  check('all six tiles, Money in the hero with the answer\'s total, none toned',
    s.glance === 6 && s.hero === 'Money in' && s.values['Money in'] === aed(t.money) && (await toned(page)).length === 0,
    JSON.stringify(s.values));
  check('Moved, no money / Never moved / Insured and idle still open their cohorts',
    ['Moved, no money', 'Never moved', 'Insured and idle'].every((l) => s.hrefs[l]?.startsWith('#cohort/')), JSON.stringify(s.hrefs));
  check('the search and the band filters are kept, and the table holds every vehicle',
    r.search && r.rows === A.rows.length, JSON.stringify(r));
  check('the line the caption describes is drawn, at the fleet\'s own rate', r.ref && cap.includes(`${aed(t.aed_per_km)} per km (the line)`), cap);
  check('the colophon', s.colophon.includes(`${A.rows.length} vehicles`) && s.colophon.includes(aed(t.money)), s.colophon);
  check('no sideways scroll at 1440', s.overflowX <= 0, String(s.overflowX));
  await ctx.close();
  const c = await open('classic', 'unit/assets');
  check('old skin: no line, no 00 band', !(await c.page.$('#view svg .sc-ref')) && !(await c.page.$('#view .cband')));
  await c.ctx.close();
}

/* ══ #unit/drivers — Every driver ═════════════════════════════════════════ */
console.log('\n#unit/drivers');
{
  const { ctx, page, answer } = await open('arkiv', 'unit/drivers');
  const s = await shape(page);
  const D = answer('/api/economics/drivers');
  const dt = D.totals;
  check('seven tiles, Money to drivers the hero with the answer\'s total, none toned',
    s.glance === 7 && s.hero === 'Money to drivers' && s.values['Money to drivers'] === aed(dt.money) && (await toned(page)).length === 0,
    JSON.stringify(s.values));
  check('Per hour online names the people it is computed over — not the hours_note that contradicted the verdict',
    s.values['Per hour online'] === aed(dt.aed_per_measured_hour)
    && s.subs['Per hour online'].startsWith(`over the ${dt.people_with_availability} people of ${dt.people} whose online hours are measured`)
    && !s.subs['Per hour online'].includes(dt.hours_note), s.subs['Per hour online']);
  check('Drove, no money and Earned nothing still open their cohorts', s.hrefs['Drove, no money']?.startsWith('#cohort/unit-drove-unpaid')
    && s.hrefs['Earned nothing']?.startsWith('#cohort/unit-earned-nothing'), JSON.stringify(s.hrefs));
  check('the table holds every person', (await page.$$eval('#view table tbody tr', (x) => x.length)) === D.rows.length);
  check('the colophon', s.colophon.includes(`${D.rows.length} people`) && s.colophon.includes(aed(dt.money)), s.colophon);
  await ctx.close();
  const c = await open('classic', 'unit/drivers');
  const cs = await shape(c.page);
  const sub = await c.page.evaluate(() => [...document.querySelectorAll('#view .kpis .kpi')]
    .find((k) => /Per hour online/.test(k.textContent))?.querySelector('.s')?.textContent.trim() || '');
  check('old skin: its tile still carries the API\'s hours_note', sub === dt.hours_note && cs.glance === 0, sub);
  await c.ctx.close();
}
{
  const none = (_q, real) => ({ ...real, totals: { ...real.totals, aed_per_measured_hour: null, measured_hours_online: null,
    people_with_availability: 0 } });
  const { ctx, page } = await open('arkiv', 'unit/drivers', { fixtures: { '/api/economics/drivers': none } });
  const s = await shape(page);
  check('with nothing measured, Per hour online is ABSENT with the reason, not a dash',
    s.na['Per hour online'] === 'no online hours were measured for anyone in this window' && s.bare.length === 0, JSON.stringify(s.na));
  await ctx.close();
}

/* ══ #revenue — Money by platform ═════════════════════════════════════════ */
console.log('\n#revenue');
const REV_HEADS = ['At a glance', 'What each channel is accounted on', 'How many bookings each channel filed',
  'Uber’s money, six ways', 'Money by channel', 'What the platforms added', 'What the platforms took out',
  'Channels whose money is not collected', 'The payout, broken down', '† What this page does not know'];
const revRead = (page) => page.evaluate(() => {
  const t = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
  const tbl = document.querySelector('[data-panel="rev-accounted"]') ? [...document.querySelectorAll('#view table')]
    .find((x) => /Report a fare/i.test(x.querySelector('thead')?.textContent || '')) : null;
  return {
    first: document.querySelector('#view .stack')?.firstElementChild?.className,
    vfig: t(document.querySelector('.cband .vdct-fig > b')),
    tones: [...document.querySelectorAll('#view .kpis .kpi')].map((k) => [t(k.querySelector('.l')), (k.className.match(/t-\w+/) || [''])[0]]),
    acc: [...document.querySelectorAll('[data-panel="rev-accounted"] .hb')].map((h) => [t(h.querySelector('.k')), t(h.querySelector('.v')),
      h.querySelector('.fill').className]),
    six: [...document.querySelectorAll('[data-panel="rev-six"] .hb')].map((h) => [t(h.querySelector('.k')), t(h.querySelector('.v'))]),
    head: tbl ? [...tbl.querySelectorAll('thead th')].map(t) : [],
    rows: tbl ? [...tbl.querySelectorAll('tbody tr')].map((tr) => [tr.className, t(tr.querySelector('td'))]) : [],
    added: document.querySelectorAll('[data-panel="rev-added"] .hb').length,
    took: [...document.querySelectorAll('[data-panel="rev-took"] .hb .v')].map(t),
    dropped: t(document.querySelector('.cband .rev-dropped')),
  };
});
let classicRevTones = [];
{
  const { ctx, page } = await open('classic', 'revenue');
  const r = await revRead(page);
  classicRevTones = r.tones;
  const head = await page.evaluate(() => [...document.querySelectorAll('#view table thead')].map((h) => h.textContent).join('|'));
  check('old skin: its tile row, and the channel table still carries Basis and Why as columns',
    !(await page.$('#view .cband')) && r.tones.length === 7 && /Basis/.test(head) && /Why/.test(head), JSON.stringify(r.tones));
  await ctx.close();
}
{
  const { ctx, page, answer } = await open('arkiv', 'revenue');
  const s = await shape(page);
  const r = await revRead(page);
  const d = answer('/api/revenue');
  const t = d.totals;
  const live = d.platforms.filter((x) => (+x.bookings || 0) > 0);
  check('the section order is the plan\'s: 00, accounted by channel, bookings beside Uber six ways, the table, '
    + 'the leaf lines, the payout tree, †', JSON.stringify(s.heads) === JSON.stringify(REV_HEADS), JSON.stringify(s.heads));
  check('00 leads the page and the verdict is its statement', r.first === 'cband' && s.vdctIn00, r.first);
  check('all seven tiles, Accounted for the hero with the answer\'s total (the verdict\'s figure here is a count)',
    s.glance === 7 && s.hero === 'Accounted for' && s.values['Accounted for'] === aed(t.accounted) && r.vfig !== s.values['Accounted for'],
    JSON.stringify([r.vfig, s.values]));
  check('…each tile keeps its tone class (the plan: labels, sub-lines and tone classes kept)',
    JSON.stringify(r.tones) === JSON.stringify(classicRevTones), JSON.stringify([r.tones, classicRevTones]));
  check('01: one bar per channel, its best figure and basis; a channel with none is the OUTLINE with its reason',
    r.acc.length === live.length && live.every((p) => {
      const row = r.acc.find(([k]) => k.startsWith(p.platform === 'hotel' ? 'Hotel' : p.platform[0].toUpperCase() + p.platform.slice(1)));
      return row && (p.best == null ? /hb-outline/.test(row[2]) && row[1] === p.basis_note : row[1] === aed(p.best));
    }), JSON.stringify(r.acc));
  const u = live.find((p) => p.platform === 'uber');
  check('03: Uber six ways, every figure the answer filed, the counted one marked',
    r.six.every(([k, v]) => v === aed(u[{ 'Fares on the trips': 'fares', 'Statement gross': 'statement_gross',
      'Statement net': 'statement_net', 'Paid into the bank': 'payouts', 'Service fee Uber kept': 'statement_fees',
      'Cash taken at the kerb': 'statement_cash' }[k.replace(' · counted', '')]])) && r.six.length >= 4, JSON.stringify(r.six));
  check('the channel table: one line of figures a row, Basis and Why on a full-width line beneath it',
    !r.head.includes('Basis') && !r.head.includes('Why') && r.rows.filter(([c]) => c === 'rev-why').length === live.length
    && r.rows.every(([c], i) => (i % 2 ? c === 'rev-why' : c !== 'rev-why')), JSON.stringify(r.rows));
  /* Sorted, the second line must follow ITS channel, not the row index. */
  await page.evaluate(() => [...document.querySelectorAll('#view table thead th')].find((th) => /^Bookings/.test(th.textContent.trim()))
    ?.querySelector('button, .sortbtn, [role="button"]')?.click() || [...document.querySelectorAll('#view table thead th')]
    .find((th) => /^Bookings/.test(th.textContent.trim()))?.click());
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => {
    const tbl = [...document.querySelectorAll('#view table')].find((x) => /Report a fare/i.test(x.querySelector('thead')?.textContent || ''));
    return [...tbl.querySelectorAll('tbody tr')].map((tr) => [tr.className, tr.className === 'rev-why'
      ? tr.textContent.replace(/\s+/g, ' ').trim() : tr.querySelector('td').textContent.trim()]);
  });
  const pairs = [];
  for (let i = 0; i + 1 < after.length; i += 2) pairs.push([after[i][1], after[i + 1][1]]);
  check('…and after a sort each second line is still its own channel\'s', pairs.length === live.length && pairs.every(([name, why]) => {
    const p = live.find((x) => x.platform.toLowerCase() === name.toLowerCase());
    return p && why.includes(p.basis_note.slice(0, 40));
  }), JSON.stringify(pairs.map(([n, w]) => [n, w.slice(0, 60)])));
  check('the leaf lines: eight at most each way, what was taken out signed', r.added <= 8 && r.took.every((v) => v.startsWith('−')),
    JSON.stringify(r.took));
  check('the † band: under-covered bookings, the bank line, channels with neither, channels silent',
    s.abs.length === 4 && s.abs[0].fig === String(t.undercovered_bookings || 0) && s.abs[2].fig.endsWith(`of ${live.length}`),
    JSON.stringify(s.abs));
  check('the colophon', s.colophon.includes(`${t.bookings.toLocaleString('en-US')} bookings`) && s.colophon.includes(aed(t.accounted)), s.colophon);
  check('no sideways scroll at 1440', s.overflowX <= 0, String(s.overflowX));
  await ctx.close();
}
/* Ruling 7: when the verdict's figure IS the accounted total, the tile that
   printed it a second time is not drawn, and its split is kept in words. */
{
  const priced = (_q, real) => ({ ...real, platforms: real.platforms.map((p) => (p.platform === 'uber'
    ? { ...p, fares: 90000, priced_bookings: p.bookings, best: 61200, basis: 'statement', basis_note: 'statement net' } : p)) });
  const { ctx, page, answer } = await open('arkiv', 'revenue', { fixtures: { '/api/revenue': priced } });
  const s = await shape(page);
  const r = await revRead(page);
  const t = answer('/api/revenue').totals;
  check('the verdict carries the accounted total, and no tile repeats it (ruling 7)',
    r.vfig === aed(t.accounted) && !Object.values(s.values).includes(r.vfig) && !('Accounted for' in s.values), JSON.stringify([r.vfig, s.values]));
  check('…the split it carried is kept in words under the band, and the hero passes on',
    r.dropped.startsWith('Accounted for —') && r.dropped.includes(aed(t.accounted_fares)) && s.hero === 'Fares charged', `${r.dropped} | ${s.hero}`);
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', 'revenue', { width: 390, scheme: 'dark' });
  const s = await shape(page);
  check('390, dark: every section, no sideways scroll', s.heads.length === REV_HEADS.length && s.overflowX <= 0, `${s.heads.length} ${s.overflowX}`);
  await ctx.close();
}

await done();
