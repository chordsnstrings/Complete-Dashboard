/* The page phase, section "Fleet and Sources" — each page under the contract.
   ═══════════════════════════════════════════════════════════════════════════
   docs/UI-REDESIGN-PLAN.md §4 (Fleet and Sources), the operator's rulings
   (§1) and the house principle. For every converted page: the contract's
   shape under the skin, its figures against the answers the page itself
   received, its absences with their true reasons, and the old skin still
   building the old page (byte for byte is test/arkiv_classic_frozen.test.mjs's
   job). ONLY=<page> narrows a run.

   Synthetic data only: the mock, and fixtures built here. */
import { harness, shape } from './arkiv_pages.mjs';

const { check, start, open, done } = harness('Arkiv page phase — Fleet and Sources');
await start();
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);

const txtOf = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  return n ? n.textContent.replace(/\s+/g, ' ').trim() : '';
}, sel);
const toned = (page) => page.evaluate(() => [...document.querySelectorAll('#view .kpis.glance > .kpi')]
  .filter((t) => /\bt-(good|warn|critical|serious|bad)\b/.test(t.className)).map((t) => t.className));
const vfig = (page) => txtOf(page, '#view .cband .vdct-fig > b');
const n = (v) => (+v || 0).toLocaleString('en-US');
const aedOf = (v) => `${Number(v) < 0 ? '−' : ''}AED ${Math.abs(Number(v)).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const bars = (page, key) => page.evaluate((k) => [...document.querySelectorAll(`[data-panel="${k}"] .hb`)].map((h) => ({
  k: h.querySelector('.k')?.textContent.trim(), v: h.querySelector('.v')?.textContent.trim(), fill: h.querySelector('.fill')?.getAttribute('style') || '' })), key);

/* ══ #vehicles ════════════════════════════════════════════════════════════ */
if (want('vehicles')) {
  console.log('\n#vehicles');
  {
    const { ctx, page } = await open('classic', 'vehicles');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'), tiles: document.querySelectorAll('#view .kpis > .kpi').length,
      money: !!document.querySelector('[data-panel="veh-money"]') }));
    check('old skin: no band, the tile row, no money-against-distance panel', !r.band && r.tiles >= 8 && !r.money, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'vehicles');
    const s = await shape(page);
    const R = answer('/api/vehicles/directory') || [];
    const paid = R.filter((r) => +r.payout > 0);
    const pay = paid.reduce((a, r) => a + +r.payout, 0);
    const km = paid.reduce((a, r) => a + (+r.km || 0), 0);
    check('00: the verdict in the band; the money the cars brought in, the chosen payouts summed', s.vdctIn00
      && s.values['Money the cars brought in'] === aedOf(pay), JSON.stringify([s.values['Money the cars brought in'], pay]));
    check('a kilometre returns: that payout over the booked km of the cars it reached, sum over sum', s.values['A kilometre returns'] === aedOf(pay / km), JSON.stringify([s.values['A kilometre returns'], pay / km]));
    const f = await vfig(page);
    check('ruling 7: the tile the verdict IS folds into it (the moved-no-booking count when there is one)', !Object.entries(s.values).some(([l, v]) => v === f && l === 'Moved, no booking'), JSON.stringify([f, s.values]));
    const reg = await page.evaluate(() => { const r = document.querySelector('#view .cband .vdir-reg'); return r ? [...r.querySelectorAll('.kpi .l')].map((l) => l.textContent.trim()) : []; });
    check('the register as its own row: Vehicles, cars by VIN, the two-channel tiles, Tracked, Documents due', reg[0] === 'Vehicles' && reg.includes('Cars, by VIN')
      && reg.includes('Tracked') && reg.includes('Documents due'), JSON.stringify(reg));
    const heroes = await page.evaluate(() => document.querySelectorAll('#view .cband .kpi.is-hero').length);
    check('one hero at most, and none in the register row', heroes <= 1 && !(await page.evaluate(() => !!document.querySelector('#view .vdir-reg .kpi.is-hero'))), String(heroes));
    check('every cohort link kept', ['Did not move', 'Documents due'].every((l) => !(l in s.values) || s.hrefs[l] == null || /cohort/.test(s.hrefs[l])), JSON.stringify(s.hrefs));
    check('no tile wears a tone, none prints a bare dash', (await toned(page)).length === 0 && !s.bare.length);
    const chips = await page.evaluate(() => { const t = [...document.querySelectorAll('#view .panel')].find((p) => p.querySelector('h3')?.textContent === 'Every vehicle');
      return { all: t.querySelectorAll('tbody .pill').length, toned: [...t.querySelectorAll('tbody .pill')].filter((x) => /\b(ok|warn|bad)\b/.test(x.className)).length }; });
    check('the table\'s tracker and document chips are outline chips: none carries a tone', chips.all > 0 && chips.toned === 0, JSON.stringify(chips));
    const H = s.heads;
    check('order: 00 → money | per km → idle hours → the table (search on it) → spread → tier → booked vs tracked → †',
      H.indexOf('Money against distance') === 1 && H.indexOf('What a kilometre returned') === 2 && H.indexOf('Idle hours between drivers') === 3
      && H.indexOf('Every vehicle') === 4 && H.indexOf('Booked against tracked distance') > H.indexOf('Which assets serve which tier') && /^† /.test(H.at(-1)), JSON.stringify(H));
    const search = await page.evaluate(() => { const b = document.querySelector('#vdq')?.closest('.toolbar'); return b?.nextElementSibling?.querySelector('h3')?.textContent || ''; });
    check('the search sits directly on the table it searches', search === 'Every vehicle', search);
    const dots = await page.evaluate(() => document.querySelectorAll('[data-panel="veh-money"] svg circle.sc-dot').length);
    check('money against distance: a dot per car with a payout and a booked distance', dots === R.filter((r) => +r.payout > 0 && +r.km > 0).length, String(dots));
    const per = await bars(page, 'veh-perkm');
    const want = R.filter((r) => +r.payout > 0 && +r.km >= 100).map((r) => Math.round((+r.payout / +r.km) * 100) / 100).sort((a, b) => a - b).slice(0, 12);
    check('what a kilometre returned: the lowest twelve over 100 km, ascending, in the job token', per.length === want.length
      && per.every((b, i) => b.v === `${aedOf(want[i])}/km` && /--mk-fill/.test(b.fill)), JSON.stringify([per.slice(0, 3), want.slice(0, 3)]));
    const bt = await page.evaluate(() => ({ dots: document.querySelectorAll('[data-panel="veh-booked"] svg circle.sc-dot').length, ref: !!document.querySelector('[data-panel="veh-booked"] svg .sc-ref') }));
    check('booked against tracked: a dot per car with both, and the line where they agree', bt.ref && bt.dots === R.filter((r) => +r.km > 0 && +r.telematics_km > 0).length, JSON.stringify(bt));
    const idle = await page.evaluate(() => [...document.querySelectorAll('#view .panel')].filter((p) => /^(Idle hours between drivers|Fleet spread)$/.test(p.querySelector('h3')?.textContent || ''))
      .flatMap((p) => [...p.querySelectorAll('.hb .fill')].map((f) => f.getAttribute('style'))));
    check('idle hours and fleet spread in the job token — a vehicle is not a channel', idle.length > 0 && idle.every((x) => /--mk-fill/.test(x)), JSON.stringify(idle.slice(0, 2)));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    const still = s.values['Did not move'];
    check('†: what a car costs (not held), the plates that never moved (the tile\'s own count), which distance is right', ab['What a car costs']?.fig === 'Not held'
      && (still && still !== '0' ? ab['Plates that never moved']?.fig === `${still} of ${n(R.length)}` : ab['Plates that never moved']?.none) && !!ab['Which distance is right'], JSON.stringify(s.abs.map((a) => [a.label, a.fig])));
    const cap = await page.evaluate(() => { const r = document.querySelector('#view .cband .vdir-reg');
      return r ? { cap: r.querySelector(':scope > p.cap')?.textContent, inGrid: !!r.closest('.kpis') } : null; });
    check('the register row keeps its caption and sits beside the tile grid, not inside it', cap && cap.cap === 'The register' && !cap.inGrid, JSON.stringify(cap));
    await ctx.close();
  }
  {
    /* A car paid only on the fare it charges: its own chart, its own unit. */
    const fareOnly = (q, real) => (real || []).map((r, i) => (i === 0 ? { ...r, payout: null, revenue: 9876.5 } : r));
    const { ctx, page } = await open('arkiv', 'vehicles', { fixtures: { '/api/vehicles/directory': fareOnly } });
    const r = await page.evaluate(() => { const p = document.querySelector('[data-panel="veh-money"]');
      return { h4: [...(p?.querySelectorAll('h4') || [])].map((h) => h.textContent), svgs: p ? p.querySelectorAll('svg').length : 0 }; });
    check('a fare-basis-only car goes in its own chart, in fares — never on the payout axis', r.h4.includes('Cars paid only on the fare they charge') && r.svgs === 2, JSON.stringify(r));
    await ctx.close();
  }
  {
    /* A plate with neither a booking nor a journey (synthetic): the tile
       counts it and the † band carries the same count, of the whole list. */
    const still = (q, real) => (real || []).map((r, i) => (i === 1 ? { ...r, trips: 0, telematics_journeys: 0, payout: null, revenue: null, km: null }
      : i === 2 ? { ...r, payout: 400, km: 40, doc_days_left: -5 } : r));
    const { ctx, page, answer } = await open('arkiv', 'vehicles', { fixtures: { '/api/vehicles/directory': still } });
    const s = await shape(page);
    const R = answer('/api/vehicles/directory') || [];
    const k = R.filter((r) => !r.trips && !r.telematics_journeys).length;
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    check('a plate that never moved: the tile and the † cell carry the same count', k > 0 && s.values['Did not move'] === n(k)
      && ab['Plates that never moved']?.fig === `${n(k)} of ${n(R.length)}`, JSON.stringify([k, s.values['Did not move'], ab['Plates that never moved']]));
    /* And a car with a payout over 40 booked km: under the 100 km floor, so
       never ranked by what its kilometre returned, however low or high. */
    const per = await bars(page, 'veh-perkm');
    const low = R.find((r) => +r.km === 40);
    const exp = await page.evaluate(() => { const t = [...document.querySelectorAll('#view .panel')].find((p) => p.querySelector('h3')?.textContent === 'Every vehicle');
      const hs = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim()); const i = hs.findIndex((h) => /^Documents/.test(h));
      const c = [...t.querySelectorAll('tbody tr')].map((tr) => tr.children[i]).find((td) => /expired/.test(td?.textContent || ''));
      return c ? { txt: c.textContent.trim(), neg: /--sem-neg/.test(c.innerHTML), pill: !!c.querySelector('.pill') } : null; });
    check('an expired document says so in the negative colour, as text — no chip, no fill', !!exp && exp.txt === 'expired' && exp.neg && !exp.pill, JSON.stringify(exp));
    check('what a kilometre returned: a car under the 100 km floor is never ranked', !!low && per.length > 0 && !per.some((b) => b.k === low.plate), JSON.stringify([low?.plate, per.map((b) => b.k)]));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'vehicles', { width: 390 });
    check('#vehicles at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

await done();
