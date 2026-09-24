/* The page phase, section "Money" — the ledger pages under the contract.
   ═══════════════════════════════════════════════════════════════════════════
   #import-sheet, #opening, #salary, #advances, #charging, #policy and
   #deposits: forms and registers first. The plan keeps every form, grid and
   register where the operator works it; the contract adds a 00 band, charts
   drawn from what the page already fetched, and a † band. Each page is
   checked for the contract's shape, its figures against the answer the page
   itself received, its absences with their true reasons, and the old skin
   still building the old page (byte for byte is
   test/arkiv_classic_frozen.test.mjs's job).

   Its own file, not test/arkiv_money.test.mjs, so a revert proof on one
   ledger page runs this and not every Money page. ONLY=<page> narrows it.

   Synthetic data only: the mock, and fixtures built here. */
import { harness, shape } from './arkiv_pages.mjs';

const { check, start, open, done } = harness('Arkiv page phase — the ledger pages');
await start();
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);

/* money() as the pages print it: two decimals, separators, always. */
const aed = (n) => `${Number(n) < 0 ? '−' : ''}AED ${Math.abs(Number(n)).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const txt = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '', sel);

/* ══ #import-sheet ═══════════════════════════════════════════════════════ */
if (want('import-sheet')) {
  console.log('\n#import-sheet');
  const { ctx, page } = await open('arkiv', 'import-sheet');
  const idle = await txt(page, '[data-panel="import-review"] .import-idle');
  check('the empty "What it matched" says why it is empty', /^Nothing is read until a file is chosen/.test(idle), idle);
  await page.setInputFiles('[data-panel="import"] input[type="file"]',
    { name: 'sheet.csv', mimeType: 'text/csv', buffer: Buffer.from('name,type,amount,date\nNadia Omar Hassan,salik,120.00,2026-09-01\n') });
  await page.waitForTimeout(1200);
  check('…and the line goes the moment a file is chosen', !(await page.$('[data-panel="import-review"] .import-idle')));
  await ctx.close();
  const c = await open('classic', 'import-sheet');
  check('old skin: no such line', !(await c.page.$('.import-idle')));
  await c.ctx.close();
}

/* ══ #opening ════════════════════════════════════════════════════════════ */
const dubaiToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
if (want('opening')) {
  console.log('\n#opening');
  const { ctx, page, answer } = await open('arkiv', 'opening');
  const s = await shape(page);
  const ppl = answer('/api/ledger/people').people.filter((p) => p.name);
  const ex = answer('/api/ledger/exposure').people;
  const n = ppl.length;
  const stated = ex.filter((p) => p.owes?.cash_basis?.opening_on).length;
  const first = ex.map((p) => p.owes?.cash_taken_from).filter(Boolean).sort()[0];
  const r = await page.evaluate(() => ({
    head: [...document.querySelectorAll('[data-panel="opening-grid"] thead th')].map((t) => t.textContent.trim()),
    rows: [...document.querySelectorAll('[data-panel="opening-grid"] tbody tr')].map((tr) => tr.textContent.replace(/\s+/g, ' ').trim()),
    /* ONE ROW: every tile's top the same, and the form straight after the
       band. (Absolute "above the fold" depends on the credential banner the
       shell draws above every page — 332px on the mock — not on this page.) */
    tileTops: [...new Set([...document.querySelectorAll('#view .kpis.glance > .kpi')].map((k) => Math.round(k.getBoundingClientRect().top)))].length,
    gap: document.querySelector('[data-panel="opening"]').getBoundingClientRect().top
      - document.querySelector('#view .cband').getBoundingClientRect().bottom,
    charts: ['opening-first', 'opening-run', 'opening-exposure'].map((k) => !!document.querySelector(`[data-panel="${k}"] svg, [data-panel="${k}"] .hb`)),
  }));
  check('00 leads with ONE row of five tiles, and the form follows it directly',
    s.first === 'cband' && s.glance === 5 && r.tileTops === 1 && r.gap < 40, `${s.first} ${s.glance} ${r.tileTops} ${r.gap}`);
  check('Opening balances stated is the hero, counted from the exposure read over everyone the form offers',
    s.hero === 'Opening balances stated' && s.values['Opening balances stated'] === `${stated} of ${n}`, JSON.stringify(s.values));
  check('How far back a count reaches: from the first cash fare on record to today',
    s.values['How far back a count reaches'] === `${daysBetween(first, dubaiToday())} days` && s.subs['How far back a count reaches'].startsWith(`from ${first}`),
    JSON.stringify([s.values['How far back a count reaches'], first]));
  check('with no cash fare among the people still to count, the ceiling tile is ABSENT and says who is not on the read',
    /not on it, so no cash fare has been measured for them/.test(s.na['Unstated, at its ceiling'] || ''), JSON.stringify(s.na));
  const tariq = ex.find((p) => p.owes?.cash_taken != null);
  check('the grid gains the cash-fare ceiling, beside what was stated', r.head.includes('Cash fares on record (ceiling)')
    && r.rows.some((t) => t.includes(aed(tariq.owes.cash_taken)) && t.includes(`since ${tariq.owes.cash_taken_from}`)), JSON.stringify(r.head));
  check('after the grid: first cash fare by month, how long cash has run, what exposure could judge', r.charts.every(Boolean), JSON.stringify(r.charts));
  const books = ex.filter((p) => p.owes && (p.owes.books_recorded ?? (p.owes.advance != null || p.owes.deduction != null))).length;
  check('the † band: the opening position, what each driver owes (as recorded, not as nought), the date per row',
    s.abs.length === 3 && s.abs[0].label === 'Opening positions unknown' && s.abs[0].fig === `${n - stated} of ${n}` && s.abs[1].fig === `${books} of ${n} recorded`
    && /nothing on the advance or deduction books/.test(s.abs[1].why) && s.abs[2].fig === 'Per row', JSON.stringify(s.abs));
  check('no sideways scroll at 1440', s.overflowX <= 0, String(s.overflowX));
  await ctx.close();
  const c = await open('classic', 'opening');
  const head = await c.page.evaluate(() => [...document.querySelectorAll('#view thead th')].map((t) => t.textContent.trim()));
  check('old skin: no 00 band, and the grid without the ceiling column', !(await c.page.$('#view .cband'))
    && !head.includes('Cash fares on record (ceiling)'), JSON.stringify(head));
  await c.ctx.close();
}

/* ══ #salary ═════════════════════════════════════════════════════════════ */
if (want('salary')) {
  console.log('\n#salary');
  const { ctx, page, answer } = await open('arkiv', 'salary');
  const s = await shape(page);
  const ppl = answer('/api/ledger/people').people.filter((p) => p.name);
  const ex = answer('/api/ledger/exposure').people;
  const n = ppl.length;
  const ym = dubaiToday().slice(0, 7);
  const byId = new Map(ex.map((p) => [p.person_id, p]));
  const earned = ppl.map((p) => byId.get(p.person_id)?.earned ?? null);
  const gen = earned.filter((v) => v != null && v > 0);
  const r = await page.evaluate(() => ({
    head: [...document.querySelectorAll('[data-panel="salary-grid"] thead th')].map((t) => t.textContent.trim()),
    cover: [...document.querySelectorAll('[data-panel="salary-cover"] .hb')].map((h) => [h.querySelector('.k').textContent,
      h.querySelector('.fill').className, h.querySelector('.v').textContent.trim()]),
    gen: [...document.querySelectorAll('[data-panel="salary-generated"] .hb')].map((h) => [h.querySelector('.k').textContent,
      h.querySelector('.fill').className]),
    spread: !!document.querySelector('[data-panel="salary-spread"] svg'),
  }));
  check('00 leads; salary recorded for the month is the hero, over everyone on the payroll',
    s.first === 'cband' && s.hero === `Salary recorded for ${ym}` && s.values[`Salary recorded for ${ym}`] === `0 of ${n}`, JSON.stringify(s.values));
  check('Generated, whole record: the exposure read\'s figure, by how many, never called a wage',
    s.values['Generated, whole record'] === aed(gen.reduce((a, v) => a + v, 0))
    && s.subs['Generated, whole record'].startsWith(`by ${gen.length} of ${n}`), JSON.stringify([s.values, s.subs['Generated, whole record']]));
  check('No generated figure says "none at all" and "exactly 0.00" apart',
    s.values['No generated figure'] === `${earned.filter((v) => v == null || v === 0).length} of ${n}`
    && /none at all · \d+ exactly 0\.00/.test(s.subs['No generated figure']), s.subs['No generated figure']);
  check('the column the plan fixes reads "Generated, whole record" — the month is the column beside it',
    r.head.includes('Generated, whole record') && !r.head.includes('Generated'), JSON.stringify(r.head));
  check('who the pay book covers: no record is the OUTLINE, a count of people and not a quantity',
    r.cover.length === 3 && /hb-outline/.test(r.cover[2][1]) && r.cover[2][2].startsWith(String(n)), JSON.stringify(r.cover));
  check('generated measured / exactly 0.00 / none, the last outlined; the spread drawn', r.gen.length === 3
    && /hb-outline/.test(r.gen[2][1]) && r.spread, JSON.stringify(r.gen));
  check('the † band: wage runs on the pay book (none, ever, here), payroll as a feed, what a wage should be, generated missing',
    s.abs.length === 4 && s.abs[0].none && s.abs[0].fig === 'None, ever' && s.abs[2].fig === 'Not derivable', JSON.stringify(s.abs));
  check('no sideways scroll at 1440', s.overflowX <= 0, String(s.overflowX));
  await ctx.close();
  const c = await open('classic', 'salary');
  const head = await c.page.evaluate(() => [...document.querySelectorAll('#view thead th')].map((t) => t.textContent.trim()));
  check('old skin: no 00 band, and its column still reads "Generated"', !(await c.page.$('#view .cband')) && head.includes('Generated'), JSON.stringify(head));
  await c.ctx.close();
}

/* ══ #advances ═══════════════════════════════════════════════════════════ */
if (want('advances')) {
  console.log('\n#advances');
  const { ctx, page, answer } = await open('arkiv', 'advances');
  const s = await shape(page);
  const n = answer('/api/ledger/people').people.filter((p) => p.name).length;
  const exp = answer('/api/ledger/exposure');
  const ex = exp.people;
  const carriers = ex.filter((p) => p.owes?.cash_taken != null);
  const sum = carriers.reduce((a, p) => a + p.owes.cash_taken, 0);
  const r = await page.evaluate(() => ({
    head: [...document.querySelectorAll('[data-panel="advances"] thead th')].map((t) => t.textContent.trim()),
    rows: document.querySelectorAll('[data-panel="advances"] tbody tr').length,
    dots: document.querySelectorAll('[data-panel="advances-scatter"] svg circle').length,
    scCap: document.querySelector('[data-panel="advances-scatter"] .pbody p.cap')?.textContent || '',
    ranked: [...document.querySelectorAll('[data-panel="advances-ceiling"] .hb')].map((h) => [h.querySelector('.k').textContent.trim(),
      h.querySelector('.fill').className]),
  }));
  check('the order: 00, the owes table, the form, the register, the scatter, the ranked ceiling, †',
    JSON.stringify(s.heads) === JSON.stringify(['At a glance', 'What each driver owes', 'Record an entry', 'The register',
      'Cash taken against what each driver generated', 'Who has taken the most cash in fares', '† What this page does not know']),
    JSON.stringify(s.heads));
  check('the hero is the cash-fare CEILING, said to be one, with who carries it and the largest single driver',
    s.hero === 'Cash fares put in drivers’ hands' && s.values[s.hero] === aed(sum)
    && s.subs[s.hero].startsWith('a ceiling, not a balance') && s.subs[s.hero].includes(`${carriers.length} of ${n} carry one`), JSON.stringify([s.values, s.subs[s.hero]]));
  check('the lending line is a tile that opens #policy, its figure the one in force', s.hrefs['The lending line'] === '#policy'
    && s.values['The lending line'] === `${exp.policy.pct}%`, JSON.stringify(s.hrefs));
  check('the owes table keeps its rows and gains the ceiling beside Cash held',
    r.rows === ex.length && r.head.indexOf('Cash fares on record (ceiling)') === r.head.indexOf('Cash held') + 1, JSON.stringify(r.head));
  const both = ex.filter((p) => p.owes?.cash_taken != null && p.earned != null).length;
  check('the scatter draws only people with both, and says so', r.dots === both && r.scCap.startsWith(`${both} of ${n} people have both`),
    `${r.dots} ${r.scCap}`);
  check('the ranked ceiling: bars for carriers, the drivers with none as one OUTLINED count', r.ranked.length === carriers.length + 1
    && /hb-outline/.test(r.ranked[r.ranked.length - 1][1]) && /with no cash fare on record/.test(r.ranked[r.ranked.length - 1][0]),
  JSON.stringify(r.ranked));
  check('the † band: what each driver owes, cash in hand, exposure, the line', JSON.stringify(s.abs.map((a) => a.label))
    === JSON.stringify(['What each driver owes', 'Cash in hand, as a balance', 'Exposure', 'The line itself'])
    && s.abs[2].fig === `${n - ex.filter((p) => p.exposure_pct != null).length} of ${n} not measurable`, JSON.stringify(s.abs));
  check('no sideways scroll at 1440', s.overflowX <= 0, String(s.overflowX));
  await ctx.close();
  /* No line stored: absent with where it is set. */
  const nl = await open('arkiv', 'advances', { fixtures: { '/api/ledger/exposure': (_q, real) => ({ ...real, policy: null,
    policy_absent_reason: 'no threshold has been stored, so no exposure can be judged.' }) } });
  const ns = await shape(nl.page);
  check('with no line stored, the tile is ABSENT with where it is set, and the † cell says never set',
    /none stored/.test(ns.na['The lending line'] || '') && ns.abs[3].fig === 'Never set' && /no threshold has been stored/.test(ns.abs[3].why),
    JSON.stringify([ns.na, ns.abs[3]]));
  await nl.ctx.close();
  const c = await open('classic', 'advances');
  const head = await c.page.evaluate(() => [...document.querySelectorAll('[data-panel="advances"] thead th')].map((t) => t.textContent.trim()));
  check('old skin: no 00 band, no ceiling column', !(await c.page.$('#view .cband')) && !head.includes('Cash fares on record (ceiling)'), JSON.stringify(head));
  await c.ctx.close();
}

/* ══ #charging ═══════════════════════════════════════════════════════════ */
if (want('charging')) {
  console.log('\n#charging');
  const { ctx, page, answer } = await open('arkiv', 'charging');
  const s = await shape(page);
  const reg = answer('/api/ledger/entries');
  const n = answer('/api/ledger/people').people.filter((p) => p.name).length;
  const r = await page.evaluate(() => ({
    note: document.querySelector('.cband .sechd-note')?.textContent.trim() || '',
    span: document.querySelector('.cband .ch-span')?.textContent || '',
    sides: [...document.querySelectorAll('[data-panel="charging-sides"] .hb')].map((h) => [h.querySelector('.k').textContent,
      h.querySelector('.fill').className, h.querySelector('.v').textContent.trim()]),
    gapPanel: !!document.querySelector('[data-panel="charging-gap"]'),
    supply: !!document.querySelector('.absband a[href^="#supply"]'),
  }));
  check('the order: 00, Record one, Who has had what, Every entry, both sides, † — the gap panel became the band',
    JSON.stringify(s.heads) === JSON.stringify(['At a glance', 'Record one', 'Who has had what', 'Every entry, most recent first',
      'Both sides of this reconciliation', '† What this page does not know']) && !r.gapPanel, JSON.stringify(s.heads));
  check('the window claimed is the window the register ANSWERED — here the whole record, said so in the head, the hero and a caption',
    reg.from == null && reg.to == null && r.note === 'The whole record' && s.hero === 'Advanced over the whole record'
    && /answered over the whole record/.test(r.span), JSON.stringify([r.note, s.hero, r.span]));
  check('the hero is the register\'s own total', s.values[s.hero] === aed(reg.totals.advance), s.values[s.hero]);
  check('drivers with one, over everyone the form can point at', s.values['Drivers with one'] === `${reg.by_person.length} of ${n}`, s.values['Drivers with one']);
  check('a meter to check it against is ABSENT with the reason, not a nought', /none ingested/.test(s.na['A meter to check it against'] || ''), JSON.stringify(s.na));
  check('both sides: the form\'s people, the ones with an advance, and the sessions as the OUTLINE',
    r.sides.length === 3 && /hb-outline/.test(r.sides[2][1]) && r.sides[1][2] === String(reg.by_person.length), JSON.stringify(r.sides));
  check('the † band keeps every bullet and the Supply link', s.abs.length === 4 && r.supply
    && /dx\/charging\/history/.test(s.abs[0].why) && /2026-09-10/.test(s.abs[1].why) && /VEHICLE/.test(s.abs[2].why)
    && /AREA NAME/.test(s.abs[3].why), JSON.stringify(s.abs.map((a) => a.label)));
  await ctx.close();
  /* A window with no charging row: the hero is ABSENT, and the window the
     answer covers is the one named. */
  const e = await open('arkiv', 'charging', { fixtures: { '/api/ledger/entries': (_q, real) => ({ ...real, from: '2026-09-01',
    to: '2026-09-24', entries: [], by_person: [], totals: { ...real.totals, rows: 0, advance: null } }) } });
  const es = await shape(e.page);
  check('an empty window: the hero is ABSENT with "no record, not a measured nought", over the dates answered',
    es.hero === 'Advanced over 2026-09-01 to 2026-09-24' && /no record, not a measured nought/.test(es.na[es.hero] || ''), JSON.stringify([es.hero, es.na]));
  const who = await txt(e.page, '[data-panel="charging-people"]');
  check('…and "who has had what" names the same dates, not the control bar\'s label', /over 2026-09-01 to 2026-09-24/.test(who)
    && !/This month/.test(who), who);
  await e.ctx.close();
  const c = await open('classic', 'charging');
  check('old skin: its tile panel and its gap panel', !!(await c.page.$('[data-panel="charging"] .kpis'))
    && !!(await c.page.$('[data-panel="charging-gap"]')) && !(await c.page.$('#view .cband')));
  await c.ctx.close();
}

await done();
