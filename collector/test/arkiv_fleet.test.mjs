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

/* ══ #vehicle/overview ════════════════════════════════════════════════════ */
if (want('vehicle-overview')) {
  console.log('\n#vehicle/overview');
  const H = 'vehicle/L45235';
  {
    const { ctx, page } = await open('classic', H);
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      tiles: [...document.querySelectorAll('#view .kpis > .kpi .l')].map((l) => l.textContent.trim()),
      earned: !!document.querySelector('[data-panel="veh-earned"]') }));
    check('old skin: no band, its own tile row (Drivers and Last fix among them), none of the new panels',
      !r.band && r.tiles.includes('Drivers') && r.tiles.includes('Last fix') && !r.earned, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', H);
    const s = await shape(page);
    const k = answer('/api/vehicle/kpis') || {};
    const F = answer('/api/kpis') || {};
    const rows = await page.evaluate(() => [...document.querySelectorAll('#view .cband .kpis.glance')]
      .map((g) => [...g.querySelectorAll(':scope > .kpi .l')].map((l) => l.textContent.trim())));
    check('00 in two rows: what the car did (five, the hero spanning two), then Utilisation, Fares, Idle days, Completion', JSON.stringify(rows) === JSON.stringify([
      ['Money in', 'Bookings', 'Distance', 'Fare per priced km', 'Harsh events per 100 km'], ['Utilisation', 'Fares', 'Idle days', 'Completion']]), JSON.stringify(rows));
    check('Money in the one hero, the reconciled figure exact', s.hero === 'Money in' && s.values['Money in'] === aedOf(k.accounted)
      && (await page.evaluate(() => document.querySelectorAll('#view .cband .kpi.is-hero').length)) === 1, JSON.stringify([s.values['Money in'], k.accounted]));
    check('Bookings and Distance are the endpoint\'s', s.values.Bookings === n(k.trips) && s.values.Distance === `${n(k.km)} km`, JSON.stringify([s.values.Bookings, s.values.Distance, k.trips, k.km]));
    const d = await txtOf(page, '#view .cband .kpi:nth-child(4) .t-d');
    check('fare per priced km, set against the fleet\'s own rate as a worded gap', s.values['Fare per priced km'] === aedOf(k.revenue_per_km)
      && (F.revenue_per_km == null || d.includes(`against the fleet's ${aedOf(F.revenue_per_km)}`)), JSON.stringify([s.values['Fare per priced km'], d, F.revenue_per_km]));
    check('Drivers and Last fix are not tiles: the card line carries the fixes in range and the drivers', !('Drivers' in s.values) && !('Last fix' in s.values)
      && (await txtOf(page, '.idcard .vov-range')).startsWith(`In range ${n(k.fixes)} fixes`), await txtOf(page, '.idcard .vov-range'));
    check('no tile wears a tone, none prints a bare dash', (await toned(page)).length === 0 && !s.bare.length);
    const want = ['At a glance', 'Fares on its bookings, day by day', 'Bookings, day by day', 'What the tracker saw', 'Who held it', 'What it did, by channel',
      'Where its journeys stand', 'When it works', 'Harsh driving, by kind', 'Harsh driving, by person'];
    check('order: 00 → 01 fares → 02 bookings | fixes → who | channel → verdicts | hours → kind | person → †',
      JSON.stringify(s.heads.slice(0, want.length)) === JSON.stringify(want) && /^† /.test(s.heads.at(-1)), JSON.stringify(s.heads));
    const dd = answer('/api/vehicle/drivers-detail') || { totals: [] };
    const who = await bars(page, 'veh-who');
    check('who held it: a bar per person (eight at most), in the job token', who.length === Math.min(8, dd.totals.length) && who.every((b) => /--mk-fill/.test(b.fill)), JSON.stringify(who.slice(0, 2)));
    const mix = answer('/api/vehicle/mix') || {};
    const ch = await bars(page, 'veh-chan');
    const booked = (mix.platform || []).filter((r) => +r.bookings > 0);
    check('by channel: bookings on each channel with a booking, in the channel\'s own colour', ch.length === booked.length
      && ch.every((b) => /--c-/.test(b.fill)), JSON.stringify(ch));
    const chanTxt = await txtOf(page, '[data-panel="veh-chan"]');
    check('service and payment over bookings only: "unknown" (the tracker\'s journeys) never a slice', !/\bunknown\b/i.test(chanTxt) && /Service/.test(chanTxt) && /Payment/.test(chanTxt), chanTxt.slice(0, 200));
    const mv = answer('/api/vehicle/movement') || {};
    const vb = await bars(page, 'veh-verdicts');
    check('where its journeys stand: a bar per verdict, with km and minutes', vb.length === (mv.by_verdict || []).length, JSON.stringify([vb.length, (mv.by_verdict || []).length]));
    const sf = answer('/api/vehicle/safety') || {};
    const kinds = await bars(page, 'veh-kinds');
    check('harsh driving by kind: driving kinds in the alert feed\'s identity, the tracker\'s own faults in ink', kinds.length === (sf.by_type || []).length
      && kinds.every((b) => (/tracker fault/.test(b.k) ? /--ink/.test(b.fill) : /--c-fms|--mk-fill/.test(b.fill))), JSON.stringify(kinds.slice(0, 3)));
    const daily = answer('/api/vehicle/daily') || [];
    const fsum = daily.reduce((a, r) => a + (r.revenue != null ? +r.revenue : 0), 0);
    const earnTxt = await txtOf(page, '[data-panel="veh-earned"]');
    check('fares day by day: the caption names the window\'s fares on every channel and says they are not Money in, nor the Fares tile\'s basis',
      earnTxt.includes(`before commission — ${aedOf(fsum)} over the window`) && /not Money in/.test(earnTxt) && /not yet ruled/.test(earnTxt), earnTxt.slice(-400));
    const pp = await bars(page, 'veh-persons');
    const rated = (sf.by_driver || []).filter((r) => r.per_100km != null && r.driver_ext_id && +(r.booked_km ?? r.km) >= 200)
      .sort((a, b) => +b.per_100km - +a.per_100km);
    check('harsh driving by person: rated over 200 booked km, worst first', pp.length === rated.length && pp.every((b, i) => b.k === rated[i].driver_name), JSON.stringify([pp.map((b) => b.k), rated.map((r) => r.driver_name)]));
    const hrs = await page.evaluate(() => !!document.querySelector('[data-panel="veh-hours"] svg'));
    check('when it works: the hours the tab already fetched, drawn', hrs || !(mix.hours || []).length);
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    check('† utilisation only when it is absent (the report covers this car)', k.utilisation != null ? !ab.Utilisation : !!ab.Utilisation, JSON.stringify(s.abs.map((a) => a.label)));
    check('† a channel statement, and how many people the drivers are, through the register', !!ab['A channel statement for this car']
      && (!k.drivers || ab['Whether its drivers are that many people']?.fig === `${n(k.drivers)} counted`), JSON.stringify(s.abs));
    await ctx.close();
  }
  {
    /* A car no utilisation report covers, and journeys the telemetry cut
       (synthetic): the tile goes absent with the true reason, the † band
       says so and counts the cut journeys once each, from by_verdict. */
    const noUtil = (q, real) => ({ ...real, utilisation: null, hours_online: null, hours_on_trip: null, earnings_per_hour: null, trips_per_online_hour: null });
    const cut = (q, real) => ({ ...real, by_verdict: [...(real?.by_verdict || []).filter((r) => r.verdict !== 'partial'), { verdict: 'partial', n: 2, km: 5, minutes: 30 }] });
    /* And the tracker's journeys in the mix, as production sends them: an
       "unknown" service and payment, and an FMS row, with no booking. */
    const fmsJ = (q, real) => ({ ...real,
      product: [...real.product, { label: 'unknown', n: 263, bookings: 0, revenue: null }],
      payment: [...real.payment, { label: 'unknown', n: 263, bookings: 0, revenue: null }],
      platform: [...real.platform, { label: 'fms', n: 263, bookings: 0, revenue: null }] });
    /* And a person with a rate over 57 km (synthetic, the shape production
       showed): never drawn, counted in words. */
    const short = (q, real) => ({ ...real, by_driver: [...(real.by_driver || []), { driver_name: 'Short Distance Driver', driver_ext_id: 'drv-short', n: 3, per_100km: 287.7, booked_km: 57 }] });
    const { ctx, page, answer } = await open('arkiv', H, { fixtures: { '/api/vehicle/kpis': noUtil, '/api/vehicle/movement': cut, '/api/vehicle/mix': fmsJ, '/api/vehicle/safety': short } });
    const s = await shape(page);
    const mv = answer('/api/vehicle/movement');
    const all = mv.by_verdict.reduce((a, r) => a + (+r.n || 0), 0);
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    check('utilisation absent with the TRUE reason: no report covers this car, all five fields empty', /no utilisation report in this window covers this vehicle/.test(s.na.Utilisation || ''), JSON.stringify(s.na));
    check('† utilisation carries the same reason', /all empty for it/.test(ab.Utilisation?.why || ''), JSON.stringify(ab.Utilisation));
    const chanTxt = await txtOf(page, '[data-panel="veh-chan"]');
    const ch = await bars(page, 'veh-chan');
    check('the tracker\'s 263 journeys are named in the caption, never a channel bar, a service or a payment', !/\bunknown\b/i.test(chanTxt)
      && /263 tracker journeys on this car are not bookings/.test(chanTxt) && !ch.some((b) => /FMS/i.test(b.k)), JSON.stringify([ch.map((b) => b.k), chanTxt.slice(0, 160)]));
    const pp = await bars(page, 'veh-persons');
    const ppTxt = await txtOf(page, '[data-panel="veh-persons"]');
    check('a rate over 57 km is never drawn; the people under the floor are counted in words', !pp.some((b) => b.k === 'Short Distance Driver')
      && /under 200 booked km on this car (is|are) not rated/.test(ppTxt), JSON.stringify([pp.map((b) => b.k), ppTxt.slice(-120)]));
    check('† journeys with a hole in the telemetry: the partial count of every journey', ab['Journeys with a hole in the telemetry']?.fig === `2 of ${n(all)}`, JSON.stringify(ab['Journeys with a hole in the telemetry']));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', H, { width: 390 });
    check('#vehicle/overview at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #vehicle/drivers ═════════════════════════════════════════════════════ */
if (want('vehicle-drivers')) {
  console.log('\n#vehicle/drivers');
  const H = 'vehicle/L45235/drivers';
  const cells = (page) => page.evaluate(() => [...document.querySelectorAll('#view .panel')].map((p) => {
    const hs = [...p.querySelectorAll('thead th')].map((h) => h.textContent.replace(/[↑↓]/g, '').trim());
    const rows = [...p.querySelectorAll('tbody tr')];
    const col = (name) => { const i = hs.findIndex((h) => h.startsWith(name)); return i < 0 ? [] : rows.map((tr) => tr.children[i]); };
    return { h: p.querySelector('h3')?.textContent || '', heads: hs, n: rows.length,
      plat: col('Platform').map((c) => ({ chip: !!c?.querySelector('.pchip .sw, .pchip [class*="sw"]'), txt: c?.textContent.trim(), coloured: !!c?.querySelector('[style*="color"]') })),
      acc: col('Accounts').map((c) => ({ chip: !!c?.querySelector('.pchip'), txt: c?.textContent.trim() })),
      trips: col('Trips').map((c) => c?.textContent.trim()), drv: col('Driver').map((c) => c?.querySelector('a')?.getAttribute('href') || '') };
  }));
  {
    const { ctx, page } = await open('classic', H);
    const c = await cells(page);
    const days = c.find((p) => p.h === 'Who held it, day by day');
    check('old skin: the platform column is the plain label, no chip', !!days && days.plat.length > 0 && days.plat.every((x) => !x.chip), JSON.stringify(days?.plat.slice(0, 2)));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', H);
    const dd = answer('/api/vehicle/drivers-detail');
    const c = await cells(page);
    const tot = c.find((p) => p.h === 'Who has held this car');
    const days = c.find((p) => p.h === 'Who held it, day by day');
    check('both custody tables kept, every column', JSON.stringify(tot?.heads) === JSON.stringify(['Driver', 'Accounts', 'Days', 'As primary', 'Trips', 'Km', 'Fares', 'Held'])
      && JSON.stringify(days?.heads) === JSON.stringify(['Day', 'Driver', 'Platform', 'Trips', 'Km', 'First', 'Last', 'Primary']), JSON.stringify([tot?.heads, days?.heads]));
    check('every person and (up to 120) every day, a row each', tot.n === dd.totals.length && days.n === Math.min(120, dd.days.length), JSON.stringify([tot.n, dd.totals.length, days.n, dd.days.length]));
    const tr = tot.trips.map((x) => +x.replace(/,/g, ''));
    check('trips descending by default, every name a driver link', tr.every((v, i) => !i || tr[i - 1] >= v) && tot.drv.every((h) => /#driver\//.test(h)), JSON.stringify([tr, tot.drv.slice(0, 2)]));
    check('a platform is a channel swatch beside an ink label, never coloured text', days.plat.length > 0 && days.plat.every((x) => x.chip && !x.coloured), JSON.stringify(days.plat.slice(0, 2)));
    check('the accounts column names its platforms the same way', tot.acc.every((x) => x.chip || x.txt === '1'), JSON.stringify(tot.acc.slice(0, 2)));
    const s = await shape(page);
    check('the colophon names the window and the people', /driver/.test(s.colophon), s.colophon);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', H, { width: 390 });
    check('#vehicle/drivers at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #vehicle/movement ════════════════════════════════════════════════════ */
if (want('vehicle-movement')) {
  console.log('\n#vehicle/movement');
  const H = 'vehicle/L45235/movement';
  const look = (page) => page.evaluate(() => {
    const P = (h) => [...document.querySelectorAll('#view .panel')].find((p) => (p.querySelector('h3')?.textContent || '').startsWith(h));
    const verd = P('Movement matched to a booking');
    const seg = P('Movement periods');
    const hs = seg ? [...seg.querySelectorAll('thead th')].map((h) => h.textContent.replace(/[↑↓]/g, '').trim()) : [];
    const vi = hs.indexOf('Verdict');
    const vcells = seg ? [...seg.querySelectorAll('tbody tr')].map((tr) => tr.children[vi]).filter(Boolean) : [];
    return {
      heads: [...document.querySelectorAll('#view .panel h3')].map((h) => h.textContent.trim()),
      map: !!document.querySelector('#view .leaflet-container, #view [data-map], #view .map'),
      picker: !!document.querySelector('#view select'),
      fills: verd ? [...verd.querySelectorAll('.hb .fill')].map((f) => f.getAttribute('style') || '') : [],
      verdicts: vcells.map((c) => ({ t: c.textContent.trim(), toned: !!c.querySelector('.pill.ok, .pill.warn, .pill.bad'), neg: /--sem-neg/.test(c.innerHTML) })),
      tonedAnywhere: [...document.querySelectorAll('#view tbody .pill.ok, #view tbody .pill.warn, #view tbody .pill.bad, #view tbody .tag.ok, #view tbody .tag.warn')].length,
      dayTiles: [...document.querySelectorAll('#view .kpis > .kpi')].map((k) => ({ l: k.querySelector('.l')?.textContent.trim(), na: k.querySelector('.t-na')?.textContent.trim() || null,
        v: k.querySelector('.n')?.textContent.trim(), toned: /\bt-(good|warn|critical|bad)\b/.test(k.className) })),
    };
  });
  {
    const { ctx, page } = await open('classic', H);
    const r = await look(page);
    check('old skin: the verdict bars on the sequential ramp and the verdicts as toned pills', r.fills.length > 0 && !r.fills.some((f) => /--mk-fill/.test(f))
      && r.verdicts.some((v) => v.toned), JSON.stringify([r.fills.slice(0, 1), r.verdicts.slice(0, 2)]));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', H);
    const r = await look(page);
    const mv = answer('/api/vehicle/movement');
    check('the whole tab kept: map, day picker, the verdict bars and all three tables', r.map && r.picker
      && ['Where it went', 'Movement matched to a booking (whole window)', 'Where it parks (whole window)', 'Movement periods (whole window)', 'Most recent fixes'].every((h) => r.heads.includes(h)), JSON.stringify(r.heads));
    check('verdict bars in the job token — a verdict is not a channel', r.fills.length === (mv.by_verdict || []).length && r.fills.every((f) => /--mk-fill/.test(f)), JSON.stringify(r.fills.slice(0, 2)));
    check('a verdict is an outline chip; only "unauthorized" keeps the negative colour, as text', r.verdicts.length > 0 && r.verdicts.every((v) => !v.toned && (v.t === 'unauthorized') === v.neg), JSON.stringify(r.verdicts.slice(0, 4)));
    check('no toned chip in any table on the tab', r.tonedAnywhere === 0, String(r.tonedAnywhere));
    check('the four day tiles, untoned', r.dayTiles.length === 4 && r.dayTiles.every((t) => !t.toned), JSON.stringify(r.dayTiles));
    await ctx.close();
  }
  {
    /* A day no fix carried a seat reading on, with no custody record
       (synthetic): both tiles absent with the true reason, never a dash. */
    const blind = (q, real) => ({ ...real, occupancy_reported: false, occupied_km: null, driver: null, driver_id: null, driver_trips: null });
    const { ctx, page } = await open('arkiv', H, { fixtures: { '/api/map/journey': blind } });
    const r = await look(page);
    const t = Object.fromEntries(r.dayTiles.map((x) => [x.l, x]));
    check('with passenger: absent — no fix that day carried a seat reading', /no fix this day carried a seat reading/.test(t['With passenger']?.na || ''), JSON.stringify(t['With passenger']));
    check('driver: absent — no custody record names anybody that day', /no custody record names who held the car that day/.test(t.Driver?.na || ''), JSON.stringify(t.Driver));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', H, { width: 390 });
    check('#vehicle/movement at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #vehicle/earnings ════════════════════════════════════════════════════ */
if (want('vehicle-earnings')) {
  console.log('\n#vehicle/earnings');
  const H = 'vehicle/L45235/earnings';
  const chips = (page) => page.evaluate(() => ({
    pills: [...document.querySelectorAll('#view tbody .pill')].map((p) => p.className),
    pchips: document.querySelectorAll('#view tbody .pchip .sw').length,
    day: [...document.querySelectorAll('#view .panel')].find((p) => p.querySelector('h3')?.textContent === 'Day by day')?.innerHTML.match(/--mk-fill/g)?.length || 0,
    dayHtml: ([...document.querySelectorAll('#view .panel')].find((p) => p.querySelector('h3')?.textContent === 'Day by day')?.innerHTML || '').match(/(fill|stroke|background)[=:]\s*"?[^";]{0,40}/g)?.slice(0, 6),
  }));
  {
    const { ctx, page } = await open('classic', H);
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'), toned: document.querySelectorAll('#view .kpis > .kpi.t-good, #view .kpis > .kpi.t-warn, #view .kpis > .kpi.t-critical').length }));
    const c = await chips(page);
    check('old skin: no band, its toned tile row, the channel as a pill', !r.band && r.toned > 0 && c.pills.some((p) => /\bplat\b|pill$|pill /.test(p)) && c.pchips === 0, JSON.stringify([r, c]));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', H);
    const s = await shape(page);
    const e = answer('/api/vehicle/earnings');
    check('00: the four tiles, Attributed pay the hero, exact money', s.hero === 'Attributed pay' && s.values['Attributed pay'] === aedOf(e.totals.attributed)
      && s.values['Measured fares'] === aedOf(e.totals.fares) && s.values['Drivers paid'] === n(e.attributed.length), JSON.stringify(s.values));
    check('no tile wears a tone (a fare coverage is a level), none prints a bare dash', (await toned(page)).length === 0 && !s.bare.length);
    const c = await chips(page);
    check('a channel is a swatch and an ink label; the basis chip carries no tone', c.pchips === e.by_platform.length + e.attributed.length
      && c.pills.every((p) => !/\b(ok|warn|bad)\b/.test(p)), JSON.stringify(c));
    const perSvg = await page.evaluate(() => [...([...document.querySelectorAll('#view .panel')].find((p) => p.querySelector('h3')?.textContent === 'Day by day')?.querySelectorAll('svg') || [])]
      .filter((g) => g.querySelector('path, rect')).map((g) => /--mk-fill/.test(g.outerHTML)));
    check('both day-by-day series in the job token, still two charts', perSvg.length >= 2 && perSvg.every(Boolean), JSON.stringify([perSvg, c.dayHtml]));
    check('both tables, the payout-period caveat and the colophon kept', s.heads.includes('By channel') && s.heads.includes('By driver')
      && /payout period/.test(await txtOf(page, '#view')) && /channel/.test(s.colophon), s.colophon);
    await ctx.close();
  }
  {
    /* Nothing to attribute and nothing priced (synthetic): "AED 0.00" is not
       a measurement — both tiles absent with the reason. */
    const none = (q, real) => ({ ...real, attributed: [], totals: { ...real.totals, attributed: 0, fares: 0, priced_bookings: 0, fare_coverage_pct: null } });
    const { ctx, page } = await open('arkiv', H, { fixtures: { '/api/vehicle/earnings': none } });
    const s = await shape(page);
    check('attributed pay absent: no payout overlaps this car — never AED 0.00', /no driver payout overlaps this vehicle/.test(s.na['Attributed pay'] || '') && s.hero === 'Attributed pay', JSON.stringify([s.na, s.hero]));
    check('measured fares absent: none of its bookings reports a fare', /none of its [\d,]+ bookings reports a fare/.test(s.na['Measured fares'] || ''), JSON.stringify(s.na));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', H, { width: 390 });
    check('#vehicle/earnings at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #vehicle/safety ══════════════════════════════════════════════════════ */
if (want('vehicle-safety')) {
  console.log('\n#vehicle/safety');
  const H = 'vehicle/L45235/safety';
  const panelFills = (page, h) => page.evaluate((hh) => {
    const p = [...document.querySelectorAll('#view .panel')].find((x) => x.querySelector('h3')?.textContent === hh);
    return p ? { bars: [...p.querySelectorAll('.hb')].map((b) => ({ k: b.querySelector('.k')?.textContent.trim(), fill: b.querySelector('.fill')?.getAttribute('style') || '' })),
      svg: p.querySelector('svg')?.outerHTML.match(/var\(--[a-z0-9-]+\)/g) || [] } : null;
  }, h);
  {
    const { ctx, page } = await open('classic', H);
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'), tiles: document.querySelectorAll('#view .kpis > .kpi').length }));
    const kinds = await panelFills(page, 'Event types');
    check('old skin: no band, its tile row, the event bars on the sequential ramp', !r.band && r.tiles >= 3 && kinds && kinds.bars.every((b) => !/--c-fms|--mk-fill/.test(b.fill)), JSON.stringify([r, kinds?.bars.slice(0, 2)]));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', H);
    const s = await shape(page);
    const k = answer('/api/vehicle/kpis');
    const F = answer('/api/kpis');
    const sf = answer('/api/vehicle/safety');
    check('00: the tiles as the band, the per-100-km rate the hero', s.hero === 'Per 100 km' && Math.abs(parseFloat(s.values['Per 100 km']) - Number(k.alerts_per_100km)) < 0.05,
      JSON.stringify([s.values, k.alerts_per_100km]));
    const d = await txtOf(page, '#view .cband .kpi.is-hero .t-d');
    const gap = Number(k.alerts_per_100km) - Number(F.alerts_per_100km);
    const worse = await page.evaluate(() => { const x = document.querySelector('#view .cband .kpi.is-hero .dlt'); return x ? x.className : ''; });
    /* fmt() drops a trailing ".0" (52.0 prints "52"), so the figure is read
       back as a number — the arkiv_people month check's lesson (P38b). */
    const fx = (d.match(/against the fleet's ([\d,]+(?:\.\d+)?)/) || [])[1];
    check('set against the fleet\'s rate, up is worse', fx != null && Math.abs(Number(fx.replace(/,/g, '')) - Number(F.alerts_per_100km)) < 0.05
      && (gap > 0 ? /neg|bad|worse/.test(worse + d) : /pos|good|better/.test(worse + d)), JSON.stringify([d, worse, gap]));
    check('no tile wears a tone, none prints a bare dash', (await toned(page)).length === 0 && !s.bare.length);
    const kinds = await panelFills(page, 'Event types');
    check('event bars: driving kinds in the FMS/InfoTrack identity, the tracker\'s own faults in ink', kinds.bars.length === sf.by_type.length
      && kinds.bars.every((b) => (/tracker fault/.test(b.k) ? /--ink/.test(b.fill) : /--c-fms/.test(b.fill))), JSON.stringify(kinds.bars));
    const days = await panelFills(page, 'Events by day');
    check('events by day in the same identity', days && days.svg.includes('var(--c-fms)'), JSON.stringify(days?.svg.slice(0, 4)));
    check('both tables kept, and the colophon counts the alerts', s.heads.includes('Which driver was holding it') && s.heads.includes('Recent events') && /alerts/.test(s.colophon), JSON.stringify([s.heads, s.colophon]));
    await ctx.close();
  }
  {
    /* No distance for the feed's days (synthetic): the rate absent with the
       endpoint's own reason, never "—". */
    const blind = (q, real) => ({ ...real, alerts_per_100km: null, alerts_per_100km_absent: 'no booked distance on the days the alert feed covered' });
    const { ctx, page } = await open('arkiv', H, { fixtures: { '/api/vehicle/kpis': blind } });
    const s = await shape(page);
    check('the rate absent with the endpoint\'s reason', s.na['Per 100 km'] === 'no booked distance on the days the alert feed covered', JSON.stringify(s.na));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', H, { width: 390 });
    check('#vehicle/safety at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #vehicle/compliance ══════════════════════════════════════════════════ */
if (want('vehicle-compliance')) {
  console.log('\n#vehicle/compliance');
  const H = 'vehicle/L45235/compliance';
  /* Three documents (synthetic): one expired, one inside 30 days, one well
     clear — the three treatments the plan names. */
  const three = (q, real) => ({ ...real, documents: [
    { doc_type: 'Vehicle Registration Form', platform: 'uber', status: 'ACTIVE', expires_at: '2026-12-31T00:00:00Z', days_left: 96 },
    { doc_type: 'Insurance', platform: 'uber', status: 'EXPIRED', expires_at: '2026-09-12T00:00:00Z', days_left: -12 },
    { doc_type: 'Permit', platform: 'uber', status: 'ACTIVE', expires_at: '2026-10-01T00:00:00Z', days_left: 7 },
  ] });
  const docs = (page) => page.evaluate(() => {
    const p = [...document.querySelectorAll('#view .panel')].find((x) => x.querySelector('h3')?.textContent === 'Documents');
    const hs = [...p.querySelectorAll('thead th')].map((h) => h.textContent.replace(/[↑↓]/g, '').trim());
    const at = (name) => hs.indexOf(name);
    return [...p.querySelectorAll('tbody tr')].map((tr) => {
      const d = tr.children[at('Days left')]; const st = tr.children[at('Status')]; const pl = tr.children[at('Platform')];
      return { doc: tr.children[at('Document')]?.textContent.trim(), days: d?.textContent.trim(), neg: /--sem-neg/.test(d?.innerHTML || ''),
        chip: d?.querySelector('.pill')?.className || null, dim: !!d?.querySelector('.dim'),
        status: st?.querySelector('.pill')?.className || null, plat: !!pl?.querySelector('.pchip .sw') };
    });
  });
  {
    const { ctx, page } = await open('classic', H, { fixtures: { '/api/vehicle/profile': three } });
    const r = await docs(page);
    check('old skin: days left as toned pills', r.some((x) => /\b(bad|warn|err)\b/.test(x.chip || '')), JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', H, { fixtures: { '/api/vehicle/profile': three } });
    const r = await docs(page);
    check('days left ascending, as before', JSON.stringify(r.map((x) => x.doc)) === JSON.stringify(['Insurance', 'Permit', 'Vehicle Registration Form']), JSON.stringify(r.map((x) => x.doc)));
    const [exp, soon, clear] = r;
    check('expired: the negative colour as text, with its word and its minus — no chip', exp.neg && !exp.chip && exp.days === 'expired · −12 d', JSON.stringify(exp));
    check('under 30 days: an ink outline chip (amber is not a token)', soon.chip === 'pill' && !soon.neg && soon.days === '7 d', JSON.stringify(soon));
    check('the rest grey, no chip', clear.dim && !clear.chip && clear.days === '96 d', JSON.stringify(clear));
    check('the status an outline chip and the platform a swatch', r.every((x) => x.status === 'pill' && x.plat), JSON.stringify(r.map((x) => [x.status, x.plat])));
    const s = await shape(page);
    check('both blocks kept, the colophon counts the documents', s.heads.includes('Documents') && s.heads.includes('Specification') && /3 documents/.test(s.colophon), JSON.stringify([s.heads, s.colophon]));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', H, { width: 390 });
    check('#vehicle/compliance at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #vehicle/trips ═══════════════════════════════════════════════════════ */
if (want('vehicle-trips')) {
  console.log('\n#vehicle/trips');
  const H = 'vehicle/L45235/trips';
  const rowsOf = (page) => page.evaluate(() => {
    const p = [...document.querySelectorAll('#view .panel')].find((x) => x.querySelector('h3')?.textContent === 'Trip records');
    const hs = [...p.querySelectorAll('thead th')].map((h) => h.textContent.replace(/[↑↓]/g, '').trim());
    const at = (n) => hs.indexOf(n);
    return { heads: hs, more: !!p.querySelector('button.btn'), rows: [...p.querySelectorAll('tbody tr')].map((tr) => ({
      plat: !!tr.children[at('Platform')]?.querySelector('.pchip .sw'), status: tr.children[at('Status')]?.querySelector('.pill')?.className || null,
      fare: tr.children[at('Fare')]?.textContent.trim(), link: tr.children[at('Requested')]?.querySelector('a')?.getAttribute('href') || '' })) };
  });
  {
    const { ctx, page } = await open('classic', H);
    const r = await rowsOf(page);
    check('old skin: the platform as a bare label, the status as a toned pill', r.rows.length > 0 && r.rows.every((x) => !x.plat) && r.rows.some((x) => /\b(ok|warn)\b/.test(x.status || '')), JSON.stringify(r.rows.slice(0, 2)));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', H);
    const r = await rowsOf(page);
    const res = answer('/api/vehicle/trips');
    check('every column kept, in order', JSON.stringify(r.heads) === JSON.stringify(['Requested', 'Driver', 'Platform', 'From', 'To', 'Km', 'Product', 'Status', 'Fare']), JSON.stringify(r.heads));
    check('the first page (drawn to 400, the rest named), and the button that loads the next', r.rows.length === Math.min(400, res.rows.length) && r.more === ((res.total ?? 0) > res.rows.length), JSON.stringify([r.rows.length, res.rows.length, res.total, r.more]));
    check('the platform a swatch and an ink label; the status an outline chip', r.rows.every((x) => x.plat && x.status === 'pill'), JSON.stringify(r.rows.slice(0, 2)));
    check('every fare exact, with its fils', r.rows.filter((x) => /AED/.test(x.fare || '')).every((x) => /AED [\d,]+\.\d{2}$/.test(x.fare)), JSON.stringify(r.rows.slice(0, 3).map((x) => x.fare)));
    check('every trip time still opens that day\'s replay', r.rows.every((x) => /^#vehicle\/L45235\/movement\?(.*&)?day=\d{4}-\d{2}-\d{2}/.test(x.link)), JSON.stringify(r.rows.slice(0, 2).map((x) => x.link)));
    const s = await shape(page);
    check('the colophon counts the trip records', /trip records/.test(s.colophon), s.colophon);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', H, { width: 390 });
    check('#vehicle/trips at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #unauthorized ════════════════════════════════════════════════════════ */
if (want('unauthorized')) {
  console.log('\n#unauthorized');
  const H = 'unauthorized';
  const flagged = (page) => page.evaluate(() => {
    const p = [...document.querySelectorAll('#view .panel')].find((x) => x.querySelector('h3')?.textContent === 'Flagged segments');
    const hs = [...p.querySelectorAll('thead th')].map((h) => h.textContent.replace(/[↑↓]/g, '').trim());
    const vi = hs.findIndex((h) => h === 'Verdict');
    return { heads: hs, cap: [...p.querySelectorAll('p.cap')].map((c) => c.textContent).join(' '),
      verdicts: vi < 0 ? [] : [...p.querySelectorAll('tbody tr')].map((tr) => tr.children[vi]).filter(Boolean)
        .map((c) => ({ t: c.textContent.trim(), cls: c.querySelector('.pill, .tag')?.className || null, neg: /--sem-neg/.test(c.innerHTML) })) };
  });
  {
    const { ctx, page } = await open('classic', H);
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      heads: [...document.querySelectorAll('#view .panel h3')].map((h) => h.textContent.trim()) }));
    const f = await flagged(page);
    check('old skin: no band, the donut\'s panel, the custody column alone, toned verdict tags', !r.band && r.heads.includes('What each flagged trip turned out to be')
      && f.heads.includes('Driver that day') && !f.heads.includes('Who the evidence names') && f.verdicts.some((v) => /\btag\b/.test(v.cls || '')), JSON.stringify([r.heads.slice(0, 4), f.heads]));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', H);
    const s = await shape(page);
    const sum = answer('/api/unauthorized/summary');
    const daily = answer('/api/unauthorized/daily');
    const rows = answer('/api/unauthorized/list');
    const t = sum.totals;
    const f = await vfig(page);
    check('00: the verdict is the statement, and the tile it prints is folded into it (ruling 7)', s.vdctIn00 && !Object.values(s.values).includes(f)
      && !('Unexplained trips' in s.values), JSON.stringify([f, Object.keys(s.values)]));
    check('the tiles, untoned: km, revenue forgone exact, the mean a day, inconclusive, then the second five', JSON.stringify(Object.keys(s.values)) === JSON.stringify(
      ['Unexplained km', 'Revenue forgone', 'Mean a day', 'Inconclusive', 'Matched to a booking', 'Occupied but stationary', 'Seat-pad faults', 'Could not be verified', 'Needs a human'])
      && (await toned(page)).length === 0 && !s.bare.length, JSON.stringify(Object.keys(s.values)));
    check('figures are the endpoint\'s', s.values['Unexplained km'] === `${n(t.unauth_km)} km` && s.values['Revenue forgone'] === aedOf(sum.value.forgone_aed)
      && s.values.Inconclusive === n(t.partial), JSON.stringify(s.values));
    const withData = daily.filter((d) => !d.uncollected);
    const mean = (a) => a.reduce((x, d) => x + (+d.unauthorized || 0), 0) / a.length;
    const m = mean(withData.slice(-7)), pm = mean(withData.slice(-14, -7));
    const md = await page.evaluate(() => [...document.querySelectorAll('#view .cband .kpi')].find((k) => k.querySelector('.l')?.textContent.trim() === 'Mean a day')?.querySelector('.t-d')?.className || '');
    check('mean a day: the last seven days with seat data, against the seven before, fewer is better', Math.abs(parseFloat(s.values['Mean a day']) - m) < 0.05
      && (m === pm || (m < pm ? /pos|better/.test(md + (await txtOf(page, '#view .cband'))) : /neg|worse/.test(md + (await txtOf(page, '#view .cband'))))), JSON.stringify([s.values['Mean a day'], m, pm]));
    const trend = await page.evaluate(() => { const p = [...document.querySelectorAll('#view .panel')].find((x) => x.querySelector('h3')?.textContent === 'Unexplained trips per day');
      return { svg: p.querySelector('svg')?.outerHTML.match(/var\(--[a-z0-9-]+\)/g) || [], cap: [...p.querySelectorAll('p.cap')].map((c) => c.textContent).join(' ') }; });
    const seen = daily.reduce((a, d) => a + (+d.segments || 0), 0);
    check('unexplained a day on its own axis in the job token; every interval seen named in the caption, not drawn', trend.svg.includes('var(--mk-fill)')
      && trend.cap.includes(`of the ${n(seen)} occupancy intervals seen`), JSON.stringify([trend.svg.slice(0, 4), trend.cap.slice(0, 120)]));
    const verd = await page.evaluate(() => { const p = [...document.querySelectorAll('#view .panel')].find((x) => x.querySelector('h3')?.textContent === 'What the matcher decided');
      return p ? [...p.querySelectorAll('.hb .fill')].map((x) => x.getAttribute('style')) : null; });
    check('what the matcher decided: ranked bars in the job token, one per verdict', verd && verd.length === sum.byVerdict.length && verd.every((x) => /--mk-fill/.test(x)), JSON.stringify(verd));
    const veh = await page.evaluate(() => { const p = [...document.querySelectorAll('#view .panel')].find((x) => x.querySelector('h3')?.textContent === 'Vehicles with unexplained trips');
      return [...p.querySelectorAll('.hb')].map((b) => ({ v: b.textContent.replace(/\s+/g, ' ').trim(), fill: b.querySelector('.fill')?.getAttribute('style') || '' })); });
    check('vehicles: the job token, the kilometres beside the count', veh.length > 0 && veh.every((b) => /--mk-fill/.test(b.fill) && /(\d km|no distance)/.test(b.v)), JSON.stringify(veh.slice(0, 2)));
    await page.waitForFunction(() => [...document.querySelectorAll('#view thead th')].some((h) => h.textContent.includes('Who the evidence names')), null, { timeout: 10000 }).catch(() => {});
    const fl = await flagged(page);
    check('flagged segments: the rung and name BESIDE the day-grain custody column', fl.heads.includes('Who the evidence names') && fl.heads.includes('Driver that day')
      && fl.heads.indexOf('Driver that day') === fl.heads.indexOf('Who the evidence names') + 1, JSON.stringify(fl.heads));
    check('a verdict is an outline chip; "unauthorized" in the negative colour, as text', fl.verdicts.length > 0 && fl.verdicts.every((v) => v.cls === 'pill' && (v.t === 'unauthorized') === v.neg), JSON.stringify(fl.verdicts.slice(0, 2)));
    const near = await bars(page, 'un-near');
    const plats = new Set(rows.filter((r) => r.nearest_platform).map((r) => r.nearest_platform));
    check('the nearest booking by channel: a bar per channel, in its colour', near.length === plats.size && near.every((b) => /--c-/.test(b.fill)), JSON.stringify(near));
    const nearTxt = await txtOf(page, '[data-panel="un-near"]');
    const none = rows.filter((r) => !r.nearest_platform).length;
    check('journeys with no booking at all on that plate are counted in words', !none || nearTxt.includes(`${n(none)} journey`), nearTxt.slice(-160));
    const hrs = await page.evaluate(() => !!document.querySelector('[data-panel="un-hours"] svg'));
    const where = await bars(page, 'un-where');
    const areas = new Set(rows.map((r) => r.start_place?.area).filter(Boolean));
    check('when they happen, drawn; where they start, a bar per named area (twelve at most)', hrs && where.length === Math.min(12, areas.size), JSON.stringify([hrs, where.length, areas.size]));
    const dots = await page.evaluate(() => document.querySelectorAll('[data-panel="un-size"] svg circle.sc-dot').length);
    check('how long, how far: a dot per journey with both', dots === rows.filter((r) => +r.duration_min > 0 && +r.distance_km > 0).length, String(dots));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    const cov = sum.coverage;
    check('†: the days with no seat data, the journeys nobody could judge, no driver on record, why the car moved', ab['Days with no seat data']?.fig === `${n(cov.days_in_window - cov.days_with_data)} of ${n(cov.days_in_window)}`
      && ab['Journeys nobody could judge']?.fig === n(t.partial) && !!ab['Journeys with no driver on record'] && ab['Why the car moved']?.fig === 'Not recorded', JSON.stringify(s.abs.map((a) => [a.label, a.fig])));
    check('the colophon counts every journey examined', new RegExp(`${n(sum.byVerdict.reduce((a, r) => a + r.n, 0))} journeys examined`).test(s.colophon), s.colophon);
    check('the seat-sensor health tables kept', s.heads.includes('Seat-sensor health'), JSON.stringify(s.heads));
    const skel = await page.evaluate(() => [...document.querySelectorAll('#view .skel')].map((x) => x.closest('.panel')?.querySelector('h3')?.textContent || '?'));
    check('no loading skeleton left behind anywhere on the page', !skel.length, JSON.stringify(skel));
    await ctx.close();
  }
  {
    /* The ladder unreadable and no rate (synthetic): the table stands on
       custody alone and says why; revenue forgone absent with the basis. */
    const noRate = (q, real) => ({ ...real, value: { forgone_aed: null, basis: 'no booking in this window carries both a fare and a distance, so there is no rate' } });
    const { ctx, page } = await open('arkiv', H, { fixtures: { '/api/unauthorized/attributed': () => [], '/api/unauthorized/summary': noRate } });
    await page.waitForFunction(() => /could not be loaded/.test(document.querySelector('#view')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
    const s = await shape(page);
    const fl = await flagged(page);
    check('attribution unreadable: the custody column alone, and the table says why', fl.heads.includes('Driver that day') && !fl.heads.includes('Who the evidence names')
      && /could not be loaded/.test(fl.cap), JSON.stringify([fl.heads, fl.cap.slice(0, 120)]));
    check('revenue forgone absent with the endpoint\'s basis', s.na['Revenue forgone'] === 'no booking in this window carries both a fare and a distance, so there is no rate', JSON.stringify(s.na));
    await ctx.close();
  }
  {
    /* The ladder held (production answers it in ~30 s): the page is drawn
       without it — every panel, the table on custody, a line saying the name
       is still coming — and the column arrives when it lands. */
    let release; const gate = new Promise((r) => { release = r; });
    const { ctx, page } = await open('arkiv', H, { hold: { url: '**/api/unauthorized/attributed**', gate } });
    const before = await flagged(page);
    const s = await shape(page);
    check('the ladder held: the whole page drawn, the table on custody, a line saying the name is still loading', /^† /.test(s.heads.at(-1))
      && before.heads.includes('Driver that day') && !before.heads.includes('Who the evidence names') && /still loading/.test(before.cap), JSON.stringify([before.heads.slice(0, 5), before.cap.slice(0, 80)]));
    release();
    await page.waitForFunction(() => [...document.querySelectorAll('#view thead th')].some((h) => h.textContent.includes('Who the evidence names')), null, { timeout: 10000 }).catch(() => {});
    const after = await flagged(page);
    check('…and when it lands the rung and name join the table, the loading line gone', after.heads.includes('Who the evidence names') && after.heads.includes('Driver that day') && !/still loading/.test(after.cap), JSON.stringify([after.heads.slice(0, 5), after.cap]));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', H, { width: 390 });
    check('#unauthorized at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

await done();
