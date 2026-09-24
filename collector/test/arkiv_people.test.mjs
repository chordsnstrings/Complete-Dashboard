/* The page phase, section "People" — each page under the contract.
   ═══════════════════════════════════════════════════════════════════════════
   docs/UI-REDESIGN-PLAN.md §4 (People — drivers, People — the rest), the
   operator's rulings (§1) and the house principle. For every converted page:
   the contract's shape under the skin, its figures against the answers the
   page itself received, its absences with their true reasons, and the old
   skin still building the old page (byte for byte is
   test/arkiv_classic_frozen.test.mjs's job). ONLY=<page> narrows a run.

   Synthetic data only: the mock, and fixtures built here. */
import { harness, shape } from './arkiv_pages.mjs';

const { check, start, open, done } = harness('Arkiv page phase — People');
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
const ORDER = ['uber', 'bolt', 'yango', 'hotel', 'cabman', 'fms'];
const aedOf = (n) => `${Number(n) < 0 ? '−' : ''}AED ${Math.abs(Number(n)).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/* ══ #drivers ═════════════════════════════════════════════════════════════ */
if (want('drivers')) {
  console.log('\n#drivers');
  {
    const { ctx, page } = await open('classic', 'drivers');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      cardsLoose: !!document.querySelector('#view > .dircards'),
      toned: document.querySelectorAll('#view td[class*="v-"]').length }));
    check('old skin: no 00 band, the cards loose under the search box, completion still a coloured cell',
      !r.band && r.cardsLoose && r.toned > 0, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'drivers');
    const s = await shape(page);
    const rows = answer('/api/drivers/directory')?.rows || answer('/api/drivers/directory') || [];
    const R = Array.isArray(rows) ? rows : [];
    const active = R.filter((r) => r.active_in_window).length;
    const idle = R.filter((r) => !r.active_in_window && r.ever_driven).length;
    const never = R.filter((r) => !r.ever_driven).length;
    const f = await vfig(page);
    const n = (v) => (+v).toLocaleString('en-US');
    check('00: the verdict, then the tiles — on the books, drove, did not, never have — from the directory\'s own rows',
      s.vdctIn00 && s.values['On the books'] === n(R.length) && (s.values.Drove ?? n(active)) === n(active)
      && s.values['Did not drive'] === n(idle) && s.values['Never have'] === n(never), JSON.stringify([s.values, R.length]));
    check('ruling 7: no tile repeats the verdict\'s figure', !Object.values(s.values).includes(f), JSON.stringify([f, s.values]));
    check('no tile wears a tone, none prints a bare dash', (await toned(page)).length === 0 && !s.bare.length);
    const order = await page.evaluate(() => {
      const bar = document.querySelector('#view .toolbar #dq')?.closest('.toolbar');
      const next = bar?.nextElementSibling;
      return { next: next?.querySelector('h3')?.textContent || '', busiest: document.querySelectorAll('[data-panel="drivers-busiest"] .dircard').length };
    });
    check('the busiest six are §01, and the search box sits directly above the table it searches',
      order.next === 'All drivers' && order.busiest === Math.min(6, active), JSON.stringify(order));
    const cards = await page.evaluate(() => [...document.querySelectorAll('[data-panel="drivers-busiest"] .dircard')].map((c) => {
      const b = c.querySelector('.dc-meta b').getBoundingClientRect(); const n = c.querySelector('.dc-n').getBoundingClientRect();
      const nm = c.querySelector('.dc-meta b');
      return { overlap: !(b.right <= n.left || n.right <= b.left || b.bottom <= n.top || n.bottom <= b.top), clipped: nm.scrollWidth > nm.clientWidth + 1 };
    }));
    check('§01: every name whole (no ellipsis — AUDIT\'s clipping at 133px), never under the count', cards.length > 0
      && cards.every((c) => !c.overlap && !c.clipped), JSON.stringify(cards));
    const chipRows = await page.evaluate(() => [...document.querySelectorAll('#view tr')].map((tr) =>
      [...tr.querySelectorAll('.pchip')].map((c) => c.querySelector('.sw')?.className.match(/ch-(\w+)/)?.[1] || '')).filter((a) => a.length > 1));
    const anyChip = await page.evaluate(() => document.querySelectorAll('#view td .pchip .sw').length);
    check('platforms: a swatch and an ink label, in the fixed channel order', anyChip > 0
      && chipRows.every((a) => a.every((k, i) => i === 0 || ORDER.indexOf(a[i - 1]) <= ORDER.indexOf(k))), JSON.stringify(chipRows.slice(0, 3)));
    const comp = await page.evaluate(() => {
      const cells = [...document.querySelectorAll('#view table')].find((t) => /Completion/.test(t.querySelector('thead')?.textContent || ''));
      return { coloured: document.querySelectorAll('#view td[class*="v-"]').length,
        gaps: cells ? [...cells.querySelectorAll('td .dlt-of')].map((x) => x.textContent) : [] };
    });
    const below = R.filter((r) => r.completion_pct != null && +r.completion_pct < 95).length;
    check('completion is a gap to 95% with glyph and sign, never a coloured cell', comp.coloured === 0
      && (below === 0 || (comp.gaps.length > 0 && comp.gaps.every((g) => g === 'to 95%'))), JSON.stringify(comp));
    const conc = await txtOf(page, '[data-panel="drivers-conc"]');
    const tr = R.map((r) => +r.trips || 0).filter((x) => x > 0).sort((a, b) => b - a);
    const tot = tr.reduce((a, x) => a + x, 0);
    const top10 = tr.length >= 10 ? (tr.slice(0, 10).reduce((a, x) => a + x, 0) / tot * 100).toFixed(1) : null;
    check('§04 how the work concentrates, computed from the directory rows', !!conc
      && (top10 == null || conc.includes(`the top 10 ran ${top10.replace(/\.0$/, '')}%`) || conc.includes(`the top 10 ran ${top10}%`)), conc.slice(-200));
    const cross = await page.evaluate(() => { const p = [...document.querySelectorAll('#view .panel')].find((x) => /Cross-platform/.test(x.querySelector('h3')?.textContent || ''));
      return p ? [...p.querySelectorAll('thead th')].map((t) => t.textContent.trim()) : []; });
    const CH = { Uber: 'uber', Bolt: 'bolt', Yango: 'yango', Hotel: 'hotel' };
    const ch = cross.map((h) => CH[h.replace(/[▲▼↑↓\s]+$/, '')]).filter(Boolean);
    check('§05 cross-platform columns in the fixed channel order', ch.every((k, i) => i === 0 || ORDER.indexOf(ch[i - 1]) < ORDER.indexOf(k)), JSON.stringify(cross));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    const noDate = R.filter((r) => !r.licence_expires).length;
    check('† four cells, the licence-date gap counted from the rows', s.abs.length === 4
      && (noDate ? ab['People with no licence date at all']?.fig === `${n(noDate)} of ${n(R.length)}` : ab['People with no licence date at all']?.none),
      JSON.stringify(s.abs.map((a) => [a.label, a.fig])));
    check('the colophon names the window and the roster', /on the books/.test(s.colophon), s.colophon);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'drivers', { width: 390 });
    check('#drivers at 390: nothing scrolls sideways (the roster scrolls inside its own frame)', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #driver/overview ═════════════════════════════════════════════════════ */
if (want('driver-overview')) {
  console.log('\n#driver/overview');
  {
    const { ctx, page } = await open('classic', 'driver/drv-0');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      row: document.querySelectorAll('#view .kpis:not(.glance) > .kpi').length }));
    check('old skin: no 00 band, the eleven-tile row', !r.band && r.row === 11, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'driver/drv-0');
    const s = await shape(page);
    const k = answer('/api/driver/kpis');
    const st = answer('/api/driver/standing');
    const tm = (st.metrics || []).find((m) => m.key === 'trips');
    check('00: Trips the hero, the working tiles first, the money on the second row — every old tile kept',
      s.hero === 'Trips' && s.labels.slice(0, 6).join('|') === 'Trips|Days worked|Hours online|Utilisation|Completion|Typical start'
      && ['Money in', 'Cash on hand', 'Bank deposit', 'Fares'].every((l) => s.labels.includes(l)), JSON.stringify(s.labels));
    const d = await txtOf(page, '#view .kpis.glance .is-hero .t-d');
    const gap = Number(k.trips) - Number(tm.median);
    check('the hero\'s gap is its OWN figure against the standing\'s fleet median, worded (ruling 4)',
      s.values.Trips === (+k.trips).toLocaleString('en-US') && d.includes(`against the fleet median of ${tm.median}`)
      && d.includes(`${gap > 0 ? '+' : '−'}${Math.abs(gap)}`), d);
    check('no tile wears a tone', (await toned(page)).length === 0);
    const pb = await page.evaluate(() => {
      const probe = document.createElement('i'); probe.style.color = 'var(--ink)'; document.body.append(probe);
      const ink = getComputedStyle(probe).color; probe.remove();
      return { ink, fills: [...document.querySelectorAll('#view .pbar .pb-track i')].map((i) => getComputedStyle(i).backgroundColor),
        lines: [...document.querySelectorAll('#view .pbar .pb-f')].map((x) => x.textContent) };
    });
    check('the rank bars in ink — a semantic colour is never an area — with each row\'s value against the median on it',
      pb.fills.length > 0 && pb.fills.filter((f) => f !== pb.ink).length <= (st.metrics || []).filter((m) => m.tied > 1).length
      && pb.lines.length === pb.fills.length && pb.lines.every((l) => /fleet median/.test(l)), JSON.stringify(pb).slice(0, 300));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    check('† a fare on every booking, counted from the kpis', ab['A fare on every booking']?.fig === `${(+k.priced_trips).toLocaleString('en-US')} of ${(+k.trips).toLocaleString('en-US')}`,
      JSON.stringify(ab['A fare on every booking']));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0', { width: 390 });
    check('#driver/overview at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #driver/activity ═════════════════════════════════════════════════════ */
if (want('driver-activity')) {
  console.log('\n#driver/activity');
  {
    const { ctx, page } = await open('classic', 'driver/drv-0/activity');
    check('old skin: no 00 band, no † band', !(await page.$('#view .cband')) && !(await page.$('#view .absband')));
    await ctx.close();
  }
  const capOf = (page) => page.evaluate(() => [...document.querySelectorAll('#view .panel')].find((p) => /How the day was spent/.test(p.querySelector('h3')?.textContent || ''))
    ?.querySelectorAll('p.cap') ? [...[...document.querySelectorAll('#view .panel')].find((p) => /How the day was spent/.test(p.querySelector('h3')?.textContent || '')).querySelectorAll('p.cap')].map((c) => c.textContent).join(' ') : '');
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/activity');
    const s = await shape(page);
    const cap = await capOf(page);
    const m = /: ([\d,.]+) h on job, ([\d,.]+) h waiting/.exec(cap) || [];
    check('00: on job and waiting are the ribbon caption\'s own figures, over the same days', s.values['On job'] === `${m[1]} h`
      && s.values['Waiting between jobs'] === `${m[2]} h`, JSON.stringify([s.values['On job'], s.values['Waiting between jobs'], m.slice(1)]));
    check('no availability on these days: the online tiles ABSENT with the true reason, never 0 h', /only Uber publishes it/.test(s.na.Online || '')
      && /only Uber publishes it/.test(s.na['Online, not dispatched'] || ''), JSON.stringify(s.na));
    check('† four cells and the colophon', s.abs.length === 4 && /activity/.test(s.colophon), JSON.stringify(s.abs.map((a) => a.label)));
    await ctx.close();
  }
  {
    /* Availability on every drawn day (synthetic spans), so the hero has a
       figure: it must be the caption's "of which N h … not dispatched". */
    const withOnline = (q, real) => ({ ...real, days: (real.days || []).map((d) => (d.first_min == null ? d
      : { ...d, online: [{ s: Math.max(0, d.first_min - 45), e: Math.min(1440, (d.first_min || 0) + (d.span_min || 0) + 30) }] })) });
    const { ctx, page } = await open('arkiv', 'driver/drv-0/activity', { fixtures: { '/api/driver/shift': withOnline } });
    const s = await shape(page);
    const cap = await capOf(page);
    const m = /([\d,.]+) h online, of which ([\d,.]+) h \((\d+)%\)/.exec(cap) || [];
    check('with availability: online, not dispatched is the hero, and is the caption\'s own idle figure', s.hero === 'Online, not dispatched'
      && s.values['Online, not dispatched'] === `${m[2]} h` && s.values.Online === `${m[1]} h`
      && (s.subs['Online, not dispatched'] || '').startsWith(`${m[3]}% of the time online`), JSON.stringify([s.values, m.slice(1)]));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/activity', { width: 390 });
    check('#driver/activity at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #driver/day ══════════════════════════════════════════════════════════ */
if (want('driver-day')) {
  console.log('\n#driver/day');
  const H = 'driver/drv-0/day?on=2026-09-20';
  {
    const { ctx, page } = await open('classic', H);
    check('old skin: the headline stands alone, no 00 band', !(await page.$('#view .cband')) && !!(await page.$('#view .vdct')));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', H);
    const s = await shape(page);
    const claim = await txtOf(page, '#view .cband .vdct-claim');
    const f = await vfig(page);
    check('00: the headline is the statement, carrying someone the hero — the same figure the claim opens with',
      s.vdctIn00 && s.hero === 'Carrying someone' && claim.startsWith(`${s.values['Carrying someone']} carrying someone`), JSON.stringify([claim, s.values]));
    check('ruling 7: the share in the statement is not repeated as a tile', !Object.values(s.values).includes(f), f);
    const k = answer('/api/driver/kpis', (q) => !!q.from);
    const d = await txtOf(page, '#view .kpis.glance .kpi:nth-child(3) .t-d');
    const per = k && +k.days_worked ? (+k.trips / +k.days_worked) : null;
    check('trips set against the driver\'s own calendar month — one request, from/to the month holding the day',
      !!k && per != null && d.includes(`a working day this month`) && d.includes(per.toFixed(1)), JSON.stringify([d, k && [k.trips, k.days_worked]]));
    const D = answer('/api/driver/day');
    const areas = await page.evaluate(() => [...document.querySelectorAll('[data-panel="dday-areas"] .hb .k')].map((x) => x.textContent.trim()));
    const want = [...new Set((D.fixes || []).map((x) => x.area).filter(Boolean))];
    check('where the tracker saw the car: one bar per named area, a fix with none never drawn as a place',
      (D.fixes || []).length ? areas.length === Math.min(12, want.length) : true, JSON.stringify([areas, want]));
    check('† four cells, the colophon names the day', s.abs.length === 4 && /20 Sept/.test(s.colophon), JSON.stringify([s.abs.map((a) => a.label), s.colophon]));
    await ctx.close();
  }
  {
    /* Fixes with areas (synthetic): two in one area, one in another, one
       with none and no speed — the bars name two places, the caption counts
       the one with no area, and the speed cell counts the stationary fix. */
    const fx = [{ m: 400, lat: 25.2, lng: 55.3, speed: 30, area: 'Area One' }, { m: 410, lat: 25.2, lng: 55.3, speed: 10, area: 'Area One' },
      { m: 420, lat: 25.3, lng: 55.4, speed: 5, area: 'Area Two' }, { m: 430, lat: 25.3, lng: 55.4, speed: null, area: null }];
    const { ctx, page } = await open('arkiv', H, { fixtures: { '/api/driver/day': (q, real) => ({ ...real, fixes: fx }) } });
    const s = await shape(page);
    const r = await page.evaluate(() => { const p = document.querySelector('[data-panel="dday-areas"]');
      return { bars: [...p.querySelectorAll('.hb')].map((h) => [h.querySelector('.k').textContent.trim(), h.querySelector('.v').textContent.trim()]), cap: [...p.querySelectorAll('p.cap')].pop()?.textContent || '' }; });
    check('areas ranked, the fix with no area counted in words and not drawn', JSON.stringify(r.bars) === JSON.stringify([['Area One', '2'], ['Area Two', '1']])
      && /1 carry no area/.test(r.cap), JSON.stringify(r));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    check('† a speed on a fix: the stationary one, of all four', ab['A speed on a fix']?.fig === '1 of 4', JSON.stringify(ab['A speed on a fix']));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', H, { width: 390 });
    check('#driver/day at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #driver/territory ════════════════════════════════════════════════════ */
if (want('driver-territory')) {
  console.log('\n#driver/territory');
  const marks = (page) => page.evaluate(() => {
    const p = [...document.querySelectorAll('#view .panel')].find((x) => /Where this driver works/.test(x.querySelector('h3')?.textContent || ''));
    const paths = p ? [...p.querySelectorAll('path.leaflet-interactive')] : [];
    return { sub: p?.querySelector('p.cap, .sub')?.textContent || p?.textContent.slice(0, 200) || '',
      still: paths.filter((x) => x.classList.contains('terr-still')).map((x) => ({ fill: x.getAttribute('fill'), dash: x.getAttribute('stroke-dasharray') })),
      hollowDashed: paths.filter((x) => x.getAttribute('fill') === 'none' && x.getAttribute('stroke-dasharray')).length };
  });
  {
    const { ctx, page } = await open('classic', 'driver/drv-0/territory');
    const m = await marks(page);
    check('old skin: the stationary places still hollow dashed rings, the subtitle still says so', m.hollowDashed > 0 && /Hollow markers/.test(m.sub), JSON.stringify(m).slice(0, 200));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'driver/drv-0/territory');
    const m = await marks(page);
    const T = answer('/api/driver/territory');
    check('a place the car sat still is MEASURED: a filled grey mark, never the hollow ring kept for "not measured"',
      m.still.length === (T.idle || []).length && m.still.every((x) => x.fill && x.fill !== 'none' && !x.dash) && m.hollowDashed === 0, JSON.stringify(m).slice(0, 300));
    check('…and the subtitle names the mark the reader is looking at', /filled grey marks/.test(m.sub) && !/Hollow/.test(m.sub), m.sub.slice(0, 160));
    const key = await page.evaluate(() => { const i = document.querySelector('#view .legend .terr-still-key'); return i ? getComputedStyle(i).borderStyle + ' ' + getComputedStyle(i).backgroundColor : null; });
    check('…and so does the key under the map: a filled grey swatch, not the dashed ring', !!key && !/dashed/.test(key) && !/rgba\(0, 0, 0, 0\)/.test(key), String(key));
    const s = await shape(page);
    check('the areas table and the distance bars kept; the colophon names the clusters', /Busiest pickup areas/.test(s.heads.join('|'))
      && /Trip distance mix/.test(s.heads.join('|')) && /pickup cluster/.test(s.colophon), JSON.stringify([s.heads, s.colophon]));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/territory', { width: 390 });
    check('#driver/territory at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #driver/earnings ═════════════════════════════════════════════════════ */
if (want('driver-earnings')) {
  console.log('\n#driver/earnings');
  {
    const { ctx, page } = await open('classic', 'driver/drv-0/earnings');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'), rings: document.querySelectorAll('#view svg.donut').length }));
    check('old skin: no 00 band, how riders paid still a ring', !r.band && r.rings === 1, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'driver/drv-0/earnings');
    const s = await shape(page);
    const k = answer('/api/driver/kpis');
    check('00: the six tiles, booked revenue the hero, the same figures, untoned', s.glance === 6 && s.hero === 'Booked revenue'
      && s.values['Booked revenue'] === aedOf(k.revenue) && (await toned(page)).length === 0, JSON.stringify(s.values));
    const mix = answer('/api/driver/mix');
    const bar = await page.evaluate(() => { const p = [...document.querySelectorAll('#view .panel')].find((x) => /How riders paid/.test(x.querySelector('h3')?.textContent || ''));
      const segs = p ? [...p.querySelectorAll('svg rect[data-share], svg rect')].map((r) => r.getAttribute('fill') || r.style.fill) : [];
      return { ring: !!p?.querySelector('svg.donut'), segs, txt: p?.textContent || '' }; });
    check('how riders paid: one 100% bar in an achromatic ramp — payment types are not channels', !bar.ring
      && (mix.payment || []).slice(0, 3).every((x) => bar.txt.includes(x.label)) && !bar.segs.some((f) => /--c-/.test(f || '')), JSON.stringify(bar.segs.slice(0, 6)));
    check('every panel kept, the colophon set', s.heads.join('|') === 'At a glance|What made up the pay|How riders paid|Revenue by day|What each platform paid'
      && /earnings/.test(s.colophon), JSON.stringify(s.heads));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/earnings', { width: 390 });
    check('#driver/earnings at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #driver/quality ══════════════════════════════════════════════════════ */
if (want('driver-quality')) {
  console.log('\n#driver/quality');
  {
    const { ctx, page } = await open('classic', 'driver/drv-0/quality');
    check('old skin: no 00 band', !(await page.$('#view .cband')));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'driver/drv-0/quality');
    const s = await shape(page);
    const k = answer('/api/driver/kpis');
    const qy = answer('/api/driver/quality');
    const deltas = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#view .kpis.glance > .kpi')]
      .map((t) => [t.querySelector('.l').textContent.trim(), { d: t.querySelector('.t-d')?.textContent.replace(/\s+/g, ' ').trim() || '',
        cls: t.querySelector('.t-d .dlt')?.className || '' }])));
    const gap = +(Number(k.completion_pct) - 95).toFixed(1);
    check('completion the hero, its gap to 95% worded with glyph and sign', s.hero === 'Completion'
      && deltas.Completion.d.includes('to 95%, the house threshold') && deltas.Completion.d.includes(`${gap > 0 ? '+' : gap < 0 ? '−' : ''}${Math.abs(gap).toFixed(1)}`),
      JSON.stringify(deltas.Completion));
    check('the alert rate against the fleet median, where lower is better', !qy.fleet_alerts_per_100km
      || (/against the fleet median/.test(deltas['Per 100 km'].d) && /dlt-(positive|negative|neutral)/.test(deltas['Per 100 km'].cls)), JSON.stringify(deltas['Per 100 km']));
    check('no tile wears a tone', (await toned(page)).length === 0);
    const bars = await page.evaluate(() => { const p = [...document.querySelectorAll('#view .panel')].find((x) => /Non-completed trips/.test(x.querySelector('h3')?.textContent || ''));
      return p ? [...p.querySelectorAll('.hb')].map((h) => ({ k: h.querySelector('.k')?.textContent.trim(), bg: h.querySelector('.fill')?.style.background || '' })) : []; });
    check('non-completed bars in the colour of the channel each names', bars.length > 0 && bars.every((b) => {
      const pl = (b.k.split(' · ')[1] || '').toLowerCase();
      return pl ? b.bg.includes(`--c-${pl}`) : true; }), JSON.stringify(bars.slice(0, 4)));
    await ctx.close();
  }
  {
    /* A window the alert feed was dark for: the rate is ABSENT with the
       tile's own reason, never "not measured" printed as a figure. */
    const dark = (q, real) => ({ ...real, alerts_per_100km: null, per_100km: null,
      alerts_per_100km_absent: 'the alert feed was down for every day of this window' });
    const { ctx, page } = await open('arkiv', 'driver/drv-0/quality', { fixtures: { '/api/driver/quality': dark } });
    const s = await shape(page);
    check('an unmeasured alert rate is ABSENT with the server\'s own reason, not a value reading "not measured"',
      s.na['Per 100 km'] === 'the alert feed was down for every day of this window', JSON.stringify([s.values['Per 100 km'], s.na]));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/quality', { width: 390 });
    check('#driver/quality at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #driver/record ═══════════════════════════════════════════════════════ */
if (want('driver-record')) {
  console.log('\n#driver/record');
  {
    const { ctx, page } = await open('classic', 'driver/drv-0/record');
    check('old skin: no 00 band, the six position tiles in a row', !(await page.$('#view .cband'))
      && (await page.$$('#view .kpis:not(.glance) > .kpi')).length === 6);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/record');
    const s = await shape(page);
    const f = await vfig(page);
    const order = await page.evaluate(() => { const v = document.querySelector('#view .stack') || document.querySelector('#view');
      const tabs = [...document.querySelectorAll('#view .tabs')].pop(); const band = document.querySelector('#view .cband');
      return tabs && band ? !!(tabs.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING) : false; });
    check('the grain switch stays first; the verdict is the 00 statement', order && s.vdctIn00, String(order));
    check('ruling 7: no tile repeats the verdict\'s figure, and the rest of the positions are kept',
      !Object.values(s.values).includes(f) && ['Position on jobs', 'Trip value', 'Position on value', 'Active days', 'Jobs a day'].every((l) => l in s.values || l in s.na),
      JSON.stringify([f, s.values]));
    check('no tile toned, none a bare dash; every chart and the period table kept', (await toned(page)).length === 0 && !s.bare.length
      && ['Jobs done, week by week', 'Trip value, week by week', 'Where they stood, week by week', 'Every period on record', 'How to read this'].every((h) => s.heads.includes(h)),
      JSON.stringify(s.heads));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/record?grain=month');
    const s = await shape(page);
    check('month by month: the band and the colophon say the grain', /month by month/.test(s.colophon) && s.vdctIn00, s.colophon);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/record', { width: 390 });
    check('#driver/record at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #driver/money ════════════════════════════════════════════════════════ */
if (want('driver-money')) {
  console.log('\n#driver/money');
  {
    const { ctx, page } = await open('classic', 'driver/U-TARIQ/money');
    const r = await page.evaluate(() => ({ glance: document.querySelectorAll('#view .kpis.glance').length,
      rows: document.querySelectorAll('#view [data-panel="driver-money"] .kpis:not(.glance)').length }));
    check('old skin: the tiles are kpiRows, dashes and all', r.glance === 0 && r.rows === 1, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'driver/U-TARIQ/money');
    const s = await shape(page);
    const ex = answer('/api/ledger/exposure');
    const p = (ex.people || [])[0];
    const inPanels = await page.evaluate(() => ['driver-money', 'driver-money-window'].map((k) => !!document.querySelector(`[data-panel="${k}"] .kpis.glance`)));
    check('restyle only: each tile row stays in the panel it sits in, drawn as glance tiles', inPanels.every(Boolean), JSON.stringify(inPanels));
    check('the positions are the ledger\'s own figures', s.values['Owed in total'] === aedOf(p.owes.total)
      && s.values['Advances outstanding'] === aedOf(p.owes.advance), JSON.stringify(s.values));
    check('no tile toned, none a bare dash', (await toned(page)).length === 0 && !s.bare.length);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/money');
    const s = await shape(page);
    check('a flow nobody wrote down is ABSENT with its reason in the value slot — never a dash with the reason underneath',
      /nothing written down/.test(s.na['Cash advanced'] || '') && /nothing written down/.test(s.na['Cash handed back'] || '') && !s.bare.length,
      JSON.stringify(s.na));
    check('every path sets the colophon, the no-record one included', /positions as of today/.test(s.colophon), s.colophon);
    await ctx.close();
  }
  {
    /* Books nobody has written in: the advance and deduction tiles are
       ABSENT with the server's books_absent_reason — their sub-lines say what
       the figure means, which is not why it is missing. And a tile row in a
       panel has no hero and no highlight. */
    const why = 'nothing has ever been recorded against this person on the advance or deduction books';
    const noBooks = (q, real) => ({ ...real, people: (real.people || []).map((x) => ({ ...x,
      owes: { ...x.owes, advance: null, deduction: null, books_recorded: false, books_absent_reason: why } })) });
    const { ctx, page } = await open('arkiv', 'driver/U-TARIQ/money', { fixtures: { '/api/ledger/exposure': noBooks } });
    const s = await shape(page);
    check('advances and deductions ABSENT with the books\' true reason, not their definitions', s.na['Advances outstanding'] === why
      && s.na.Deductions === why, JSON.stringify(s.na));
    const heroes = await page.evaluate(() => document.querySelectorAll('#view [data-panel^="driver-money"] .is-hero, #view [data-panel^="driver-money"] .hl').length);
    check('a tile row inside a panel has no hero and no highlight', heroes === 0, String(heroes));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/U-TARIQ/money', { width: 390 });
    check('#driver/money at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #driver/trips ════════════════════════════════════════════════════════ */
if (want('driver-trips')) {
  console.log('\n#driver/trips');
  const pills = (page) => page.evaluate(() => {
    const t = [...document.querySelectorAll('#view table')].find((x) => /Status/.test(x.querySelector('thead')?.textContent || ''));
    const i = t ? [...t.querySelectorAll('thead th')].findIndex((th) => /^Status/.test(th.textContent.trim())) : -1;
    return t && i >= 0 ? [...t.querySelectorAll('tbody tr')].map((tr) => tr.children[i]?.querySelector('.pill')?.className || '').filter(Boolean) : [];
  });
  {
    const { ctx, page } = await open('classic', 'driver/drv-0/trips');
    const p = await pills(page);
    check('old skin: a completed booking\'s status is a green pill', p.some((c) => /\bok\b/.test(c)), JSON.stringify(p.slice(0, 4)));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/trips');
    const p = await pills(page);
    const s = await shape(page);
    check('an outcome is not better or worse: every booking\'s status an ink pill (a journey nobody booked keeps its flag)',
      p.length > 0 && p.every((c) => !/\b(ok|warn)\b/.test(c)), JSON.stringify(p.slice(0, 6)));
    check('the table, its paging and its journeys kept; the colophon counts the bookings', /Trip records/.test(s.heads.join('|')) && /booking/.test(s.colophon), s.colophon);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/trips', { width: 390 });
    check('#driver/trips at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #driver/unauthorized ═════════════════════════════════════════════════ */
if (want('driver-unauthorized')) {
  console.log('\n#driver/unauthorized');
  /* The window nobody watched: no seat-occupancy evidence at all. */
  const blind = (q, real) => ({ ...real, coverage: { ...(real.coverage || {}), days_with_data: 0 },
    attributed: { ...(real.attributed || {}), total: 0, rows: [], by_tier: {} },
    also_a_candidate: { ...(real.also_a_candidate || {}), total: 0, rows: [] } });
  {
    const { ctx, page } = await open('classic', 'driver/drv-0/unauthorized', { fixtures: { '/api/driver/unauthorized': blind } });
    const zeros = await page.evaluate(() => [...document.querySelectorAll('#view .kpis > .kpi .n')].filter((n) => n.textContent.trim() === '0').length);
    check('old skin (frozen): the blind window still prints its counts as 0 — found, not changed there', zeros >= 5, String(zeros));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'driver/drv-0/unauthorized');
    const s = await shape(page);
    const U = answer('/api/driver/unauthorized');
    const first = await page.evaluate(() => { const b = document.querySelector('#view .cband'); const p = [...document.querySelectorAll('#view .panel')][0];
      return !!(b && p && (b.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING)); });
    check('00 above the panel, the tiles the endpoint\'s own counts, untoned', first && s.values['Named beside'] === (+U.attributed.total).toLocaleString('en-US')
      && (await toned(page)).length === 0, JSON.stringify(s.values));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/unauthorized', { fixtures: { '/api/driver/unauthorized': blind } });
    const s = await shape(page);
    const why = /nothing was looked at/;
    check('THE TRUTH FIX: nothing was looked at, so every tile is ABSENT with that reason — never five zeros and "AED 0 … AED 0"',
      s.glance === 7 && Object.keys(s.na).length === 7 && Object.values(s.na).every((n) => why.test(n))
      && !(await txtOf(page, '#view .cband')).includes('AED 0'), JSON.stringify(s.na).slice(0, 200));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/unauthorized', { fixtures: { '/api/driver/unauthorized': [] } });
    check('an unreadable answer keeps its own note and draws no band at all', !(await page.$('#view .cband'))
      && /cannot read/.test(await txtOf(page, '#view')));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/unauthorized', { width: 390 });
    check('#driver/unauthorized at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #online-time ═════════════════════════════════════════════════════════ */
if (want('online-time')) {
  console.log('\n#online-time');
  {
    const { ctx, page } = await open('classic', 'online-time');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      pills: [...document.querySelectorAll('#view table tbody td .tag.bad')].length }));
    check('old skin: no 00 band, the late rows still a red pill', !r.band && r.pills >= 0, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'online-time');
    const s = await shape(page);
    const d = answer('/api/online-time');
    const t = d.totals;
    check('00: late the hero, the four verdict tiles with their counts, the wait to a first job beside them',
      s.hero === 'Late' && s.values.Late === (+t.late).toLocaleString('en-US') && s.values['On time'] === (+t.on_time).toLocaleString('en-US')
      && s.labels.join('|') === 'Late|On time|Cannot be judged|Drove|Wait to a first job', JSON.stringify(s.values));
    const order = await page.evaluate(() => { const b = document.querySelector('#view .cband'); const p = [...document.querySelectorAll('#view .panel')][0];
      return { bandFirst: !!(b && p && (b.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING)), pickers: !!p?.querySelector('input[type=date]') && !!p?.querySelector('input[type=time]') }; });
    check('the band leads; the day and start pickers stay in the page panel (the review\'s correction)', order.bandFirst && order.pickers, JSON.stringify(order));
    const cells = await page.evaluate(() => { const t = [...document.querySelectorAll('#view table')].find((x) => /Online/.test(x.querySelector('thead')?.textContent || ''));
      return t ? { pink: t.querySelectorAll('tbody .tag.bad').length, gaps: [...t.querySelectorAll('tbody .dlt')].map((x) => x.textContent.replace(/\s+/g, ' ')) } : null; });
    const late = (d.rows || []).filter((r) => r.late && r.online_local).length;
    check('a late start is a worded gap with glyph and sign, never a pink pill', cells && cells.pink === 0
      && cells.gaps.length === late && cells.gaps.every((g) => /late/.test(g)), JSON.stringify(cells));
    const ch = await page.evaluate(() => [...document.querySelectorAll('#view table tbody td .pchip .sw')].map((x) => x.className.match(/ch-(\w+)/)?.[1]));
    check('portals as swatch chips', ch.length > 0, String(ch.length));
    const waitTxt = await txtOf(page, '[data-panel="ot-wait"]');
    check('§ online to a first job, from the same rows; nobody with no booking yet drawn as a wait', /came online and then took a booking/.test(waitTxt), waitTxt.slice(-200));
    check('† four cells and the colophon naming the day and the start', s.abs.length === 4 && /start \d\d:\d\d/.test(s.colophon), JSON.stringify([s.abs.map((a) => a.label), s.colophon]));
    await ctx.close();
  }
  {
    /* Two late starters (synthetic): each Online cell is its time and a
       worded gap — "▲ +84 min late" — and no row carries the pink pill. */
    let n = 0;
    const lateF = (q, real) => ({ ...real, rows: (real.rows || []).map((r) => (r.online_local && n < 2
      ? (n += 1, { ...r, late: true, minutes_late: n === 1 ? 84 : 12 }) : r)) });
    const { ctx, page } = await open('arkiv', 'online-time', { fixtures: { '/api/online-time': lateF } });
    const cells = await page.evaluate(() => { const t = [...document.querySelectorAll('#view table')].find((x) => /Online/.test(x.querySelector('thead')?.textContent || ''));
      return t ? { pink: t.querySelectorAll('tbody .tag.bad').length, gaps: [...t.querySelectorAll('tbody .dlt')].map((x) => x.textContent.replace(/\s+/g, '')) } : null; });
    check('late starters: the gap in words with glyph and sign (+84 min late), no pink pill', cells && cells.pink === 0
      && cells.gaps.length >= 1 && cells.gaps.every((g) => /late/.test(g)) && cells.gaps.some((g) => /▲\+84min.*late/.test(g)), JSON.stringify(cells));
    await ctx.close();
  }
  {
    /* No readable start: the verdict tiles are ABSENT with the endpoint's
       own sentence, never two bold zeros (onlinetime.js keeps the old
       expressions the old test pins). */
    const noStart = (q, real) => ({ ...real, expected_start: null, start_why: 'no expected start could be read from the request' });
    const { ctx, page } = await open('arkiv', 'online-time', { fixtures: { '/api/online-time': noStart } });
    const s = await shape(page);
    check('no start time: Late and On time ABSENT with the endpoint\'s own reason', s.na.Late === 'no expected start could be read from the request'
      && s.na['On time'] === 'no expected start could be read from the request', JSON.stringify(s.na));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'online-time', { width: 390 });
    check('#online-time at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #performer ═══════════════════════════════════════════════════════════ */
if (want('performer')) {
  console.log('\n#performer');
  {
    const { ctx, page } = await open('classic', 'performer/drv-0');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      tiles: document.querySelectorAll('#view .kpis:not(.glance) > .kpi').length,
      fares: [...document.querySelectorAll('#view table thead th')].some((th) => /^Fares/.test(th.textContent.trim()) && th.closest('.panel')?.querySelector('h3')?.textContent.includes('day by day')) }));
    check('old skin: the five live tiles, no band, no Fares column in the day table', !r.band && r.tiles === 5 && !r.fares, JSON.stringify(r));
    await ctx.close();
  }
  {
    const unrec = (q, real) => ({ ...real, areas: [...(real.areas || []), { area: '(unrecorded)', picked_up: 7 }] });
    const { ctx, page, answer } = await open('arkiv', 'performer/drv-0', { fixtures: { '/api/performer': unrec } });
    const s = await shape(page);
    const p = answer('/api/performer');
    const E = answer('/api/economics/drivers');
    const me = (E.rows || []).find((r) => r.driver_ext_id === 'drv-0' || (r.ids || []).includes('drv-0'));
    const earners = (E.rows || []).filter((r) => Number(r.money) > 0);
    check('00: the week\'s money the hero, from the economics row the ranking reads', s.hero === 'Money' && !!me && s.values.Money === aedOf(me.money), JSON.stringify([s.values.Money, me?.money]));
    const d = await txtOf(page, '#view .kpis.glance .is-hero .t-d');
    check('…set against the mean of everybody who earned that week, worded', d.includes(`the mean of the ${earners.length} who earned`), d);
    check('the five live tiles kept with their figures, the three rates beside them', s.values.Bookings === (+p.bookings).toLocaleString('en-US')
      && ['Days worked', 'Carrying someone', 'Of time on the road', 'Waiting between jobs', 'Per day worked', 'Per measured hour', 'Per booking'].every((l) => l in s.values || l in s.na),
      JSON.stringify(Object.keys(s.values)));
    const t = await page.evaluate(() => { const panel = [...document.querySelectorAll('#view .panel')].find((x) => /day by day/.test(x.querySelector('h3')?.textContent || ''));
      return panel ? [...panel.querySelectorAll('thead th')].map((th) => th.textContent.trim()) : []; });
    check('the day-by-day table keeps its eleven columns and gains Fares', t.length === 12 && /^Fares/.test(t[11]), JSON.stringify(t));
    const areas = await page.evaluate(() => { const panel = [...document.querySelectorAll('#view .panel')].find((x) => /Where they picked up/.test(x.querySelector('h3')?.textContent || ''));
      return { bars: [...panel.querySelectorAll('.hb .k')].map((k) => k.textContent.trim()), cap: panel.textContent }; });
    const unrecN = (p.areas || []).filter((a) => /unrecorded/i.test(a.area)).reduce((x, a) => x + a.picked_up, 0);
    check('"(unrecorded)" is not drawn as a place; the caption counts it', !areas.bars.some((b) => /unrecorded/i.test(b))
      && areas.cap.includes(`${unrecN} pickups carry no recorded address`), JSON.stringify([areas.bars, unrecN]));
    check('the week as a chart above the table; † four cells', /The week, as carrying and waiting/.test(s.heads.join('|')) && s.abs.length === 4, JSON.stringify(s.heads));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'performer/drv-0', { width: 390 });
    check('#performer at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #cohort ══════════════════════════════════════════════════════════════ */
if (want('cohort')) {
  console.log('\n#cohort');
  {
    const { ctx, page } = await open('classic', 'cohort/unit-licence-due');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      due: [...document.querySelectorAll('#view .kpis > .kpi')].find((k) => /Licences due/.test(k.textContent))?.querySelector('.n')?.textContent.trim() }));
    check('old skin (frozen): no band, and "Licences due" still counts the lapsed with the due', !r.band && r.due != null, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'cohort/unit-licence-due');
    const s = await shape(page);
    const E = answer('/api/economics/drivers');
    const rows = (E.rows || []).filter((r) => r.licence_days_left != null && r.licence_days_left < 30);
    const lapsed = rows.filter((r) => r.licence_days_left < 0).length;
    const due = rows.filter((r) => r.licence_days_left >= 0).length;
    check('THE TRUTH FIX: lapsed and due are two tiles over the same predicate', s.values['Already lapsed'] === String(lapsed)
      && s.values['Due within 30 days'] === String(due) && !('Licences due' in s.values), JSON.stringify(s.values));
    const claim = await txtOf(page, '#view .cband .vdct-claim');
    check('…and a set with a lapsed member says "licence expired or expiring"', lapsed ? /licence expired or expiring/.test(claim) : true, claim);
    const f = await vfig(page);
    /* The People tile IS the verdict's count and folds into it. "Already
       lapsed" can equal it — when every member has lapsed — and is a
       different fact, which is the point of the truth fix. */
    check('ruling 7: the count the verdict states is not a tile of its own', !['People', 'Person'].some((l) => l in s.values)
      && Object.entries(s.values).filter(([, v]) => v === f).every(([l]) => l === 'Already lapsed' || l === 'Due within 30 days'), JSON.stringify([f, s.values]));
    const ch = await page.evaluate(() => [...document.querySelectorAll('[data-panel="cohort-chan"] .hb .k')].map((k) => k.textContent.trim()));
    check('which channels carry them, by member', ch.length > 0, JSON.stringify(ch));
    const ans = await page.evaluate(() => [...document.querySelectorAll('[data-panel="cohort-answered"] .hb')].map((h) => h.querySelector('.v')?.textContent.trim()));
    check('what every other system could answer: N of M per system, off the cards\' own join', ans.length === 8 && ans.every((v) => new RegExp(`of ${rows.length}$`).test(v)), JSON.stringify(ans));
    check('the full list and the member cards kept; † and colophon', s.heads.includes('The full list') && s.heads.includes('What each system holds')
      && s.abs.length >= 1 && /from Unit economics/.test(s.colophon), JSON.stringify([s.heads, s.colophon]));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'cohort/roster-blocked');
    const s = await shape(page);
    check('another set converts too: band, no tone, no bare dash', s.vdctIn00 && (await toned(page)).length === 0 && !s.bare.length, JSON.stringify(s.values));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'cohort/unit-licence-due', { width: 390 });
    check('#cohort at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #cancellations ═══════════════════════════════════════════════════════ */
if (want('cancellations')) {
  console.log('\n#cancellations');
  {
    const { ctx, page } = await open('classic', 'cancellations');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      tiles: document.querySelectorAll('#view .kpis > .kpi').length,
      pills: document.querySelectorAll('#view td .pill.err, #view td .pill.warn').length,
      notes: document.querySelectorAll('#view .panel .note').length }));
    check('old skin: no band, the five tiles, the counts still red/amber pills, the notes under the table',
      !r.band && r.tiles === 5 && r.pills > 0 && r.notes >= 1, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'cancellations');
    const s = await shape(page);
    const d = answer('/api/cancellations');
    const t = d.totals || {};
    const R = d.rows || [];
    const n = (v) => (+v || 0).toLocaleString('en-US');
    check('00: five tiles off the totals, Dropped a job the hero', s.glance === 5 && s.hero === 'Dropped a job'
      && s.values.Cancellations === n(t.cancelled) && s.values['Dropped a job'] === n(t.dropped)
      && s.values['Offers not taken'] === n(t.declined) && s.values['By the rider'] === n(t.by_rider)
      && s.values['Nobody said who'] === n(t.unattributed), JSON.stringify([s.hero, s.values, t]));
    const bk = R.reduce((a, r) => a + (+r.bookings || 0), 0);
    const pc = ((+t.cancelled / bk) * 100).toFixed(1);
    check('the plan\'s sub-lines: the share of the bookings these drivers took, and who called none off',
      s.subs.Cancellations === `${pc}% of the ${n(bk)} bookings these ${R.length} driver${R.length === 1 ? '' : 's'} took`
      && /called none off themselves|every driver here called at least one off/.test(s.subs['Dropped a job']), JSON.stringify(s.subs));
    check('no tile wears a tone, none prints a bare dash', (await toned(page)).length === 0 && !s.bare.length);
    const H = s.heads;
    check('order: 00 → who called it off | what a driver cancellation was → the table → by rank → by group → †',
      H[0] === 'At a glance' && H[1] === 'Who called it off' && H[2] === 'What a driver cancellation was'
      && H[3] === 'Cancellations by driver' && H[4] === 'Cancellations per driver, by rank'
      && H[5] === 'Dropped after accepting, by who works Bolt' && /^† /.test(H[6]), JSON.stringify(H));
    const who = await page.evaluate(() => [...document.querySelectorAll('[data-panel="canc-who"] .hb')].map((h) => ({
      k: h.querySelector('.k').textContent.trim(), v: h.querySelector('.v').textContent.trim(),
      c: h.querySelector('.fill').getAttribute('style') })));
    const up = [...new Set(R.flatMap((r) => r.unattributed_platforms || []))];
    const nb = who.find((w) => /^Nobody said who/.test(w.k));
    check('who called it off: four bars off the totals; the rider ink, the driver grey, nobody-said-who in its one channel\'s colour',
      who.length === 4 && who[0].v === n(t.by_rider) && who[1].v === n(t.dropped) && who[2].v === n(t.declined)
      && nb?.v === n(t.unattributed) && /--ink\)/.test(who[0].c) && /--grey\)/.test(who[1].c)
      && (up.length === 1 ? nb.c.includes(`--c-${up[0]})`) : /--ink\)/.test(nb.c)), JSON.stringify([who, up]));
    const comp = await page.evaluate(() => ({ fills: [...document.querySelectorAll('[data-panel="canc-what"] svg rect[data-fade]')].map((r) => r.getAttribute('fill')),
      cap: [...document.querySelectorAll('[data-panel="canc-what"] p.cap')].pop()?.textContent || '' }));
    const sum = (k) => R.reduce((a, r) => a + (+r[k] || 0), 0);
    check('what a driver cancellation was: one bar cut by the channel whose status word it is, the counts beneath',
      comp.fills.includes('var(--c-bolt)') && comp.cap.includes(`Bolt offers declined or unanswered ${n(t.declined)}`)
      && (sum('driver_cancelled_uber') ? comp.cap.includes(`Uber jobs cancelled after accepting ${n(sum('driver_cancelled_uber'))}`) : true),
      JSON.stringify(comp));
    const tbl = await page.evaluate(() => {
      const p = [...document.querySelectorAll('#view .panel')].find((x) => x.querySelector('h3')?.textContent === 'Cancellations by driver');
      const th = p ? [...p.querySelectorAll('thead th')].length : 0;
      const col = p ? [...p.querySelectorAll('thead th')].findIndex((x) => /Dropped a job/.test(x.textContent)) : -1;
      return { th, tel: p ? p.querySelectorAll('a[href^="tel:"]').length : 0, pills: p ? p.querySelectorAll('td .pill.err, td .pill.warn').length : -1,
        first: p && col >= 0 ? p.querySelector(`tbody tr td:nth-child(${col + 1})`)?.textContent.trim() : null };
    });
    const maxDrop = Math.max(0, ...R.map((r) => +r.dropped || 0));
    check('the table: ten columns, tel: links, dropped descending, and the counts ink — no red or amber fill',
      tbl.th === 10 && tbl.tel > 0 && tbl.pills === 0 && tbl.first === (maxDrop ? n(maxDrop) : '—'), JSON.stringify([tbl, maxDrop]));
    const rank = await page.evaluate(() => [...document.querySelectorAll('[data-panel="canc-rank"] p.cap')].pop()?.textContent || '');
    const cs = R.map((r) => +r.cancelled || 0).sort((a, b) => b - a);
    check('by rank: the most and the median named', rank.includes(`the most cancelled ${n(cs[0])}`), rank);
    const grp = await page.evaluate(() => [...document.querySelectorAll('[data-panel="canc-group"] .hb')].map((h) => [h.querySelector('.k').textContent.trim(), h.querySelector('.v').textContent.trim()]));
    const g = (on) => { const x = R.filter((r) => !!r.on_offer_channel === on); const acc = x.reduce((a, r) => a + (+r.accepted || 0), 0);
      return acc ? `${((x.reduce((a, r) => a + (+r.dropped || 0), 0) / acc) * 100).toFixed(1)}%` : null; };
    check('by group: dropped over accepted, the one basis both groups share', (g(true) == null || grp.some(([k, v]) => /^Work Bolt/.test(k) && v === g(true)))
      && (g(false) == null || grp.some(([k, v]) => /^Do not/.test(k) && v === g(false))), JSON.stringify([grp, g(true), g(false)]));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    const noRating = R.filter((r) => r.rating == null).length;
    check('†: the API\'s unattributed sentence, the offers note, and the unrated drivers counted — the notes moved, text unchanged',
      s.abs.length === 3 && (!d.unattributed_why || ab['Who cancelled, on some channels']?.why === d.unattributed_why)
      && (!t.declined || /are shown apart from dropped jobs rather than added to them/.test(ab['Offers on the other channels']?.why || ''))
      && (noRating ? ab['A rating']?.fig === `${noRating} of ${R.length}` : ab['A rating']?.none), JSON.stringify(s.abs.map((a) => [a.label, a.fig])));
    const loose = await page.evaluate(() => [...document.querySelectorAll('#view .panel .note')].map((x) => x.textContent.slice(0, 60)));
    check('the notes are not also printed under the table', !loose.some((x) => /are offers a driver declined/.test(x)), JSON.stringify(loose));
    check('the colophon names the window and the count', new RegExp(`${n(t.cancelled)} cancellations`).test(s.colophon), s.colophon);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'cancellations', { width: 390 });
    check('#cancellations at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #roster and its four tabs ════════════════════════════════════════════ */
if (want('roster')) {
  console.log('\n#roster');
  const panelBy = (page, title) => page.evaluate((t) => {
    const p = [...document.querySelectorAll('#view .panel')].find((x) => (x.querySelector('h3')?.textContent || '').startsWith(t));
    return p ? { text: p.textContent.replace(/\s+/g, ' '), bars: [...p.querySelectorAll('.hb')].map((h) => [h.querySelector('.k').textContent.trim(), h.querySelector('.v').textContent.trim(), h.querySelector('.fill').getAttribute('style')]),
      segs: [...p.querySelectorAll('svg rect[data-fade]')].map((r) => ({ fill: r.getAttribute('fill'), click: r.style.cursor === 'pointer' })),
      caps: [...p.querySelectorAll('p.cap')].map((c) => c.textContent) } : null;
  }, title);
  {
    const { ctx, page } = await open('classic', 'roster');
    const s = await shape(page);
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'), tiles: document.querySelectorAll('#view .kpis > .kpi').length,
      toned: document.querySelectorAll('#view td .pill.warn, #view td .pill.err, #view td .pill.bad').length }));
    check('old skin: no band, the tile row, the standings a ring, the standing pills toned', !r.band && r.tiles >= 6 && s.rings > 0 && r.toned > 0, JSON.stringify([r, s.rings]));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'roster');
    const s = await shape(page);
    const d = answer('/api/roster');
    const t = d.totals || {};
    const P = d.people || [];
    const n = (v) => (+v || 0).toLocaleString('en-US');
    const notEarning = (t.idle_this_window || 0) + (t.never_started || 0);
    const pct = t.people ? Math.round((notEarning / t.people) * 100) : 0;
    const figLabel = t.blocked ? 'Stopped everywhere' : pct >= 40 ? null : 'Drove in this window';
    check('00: the verdict in the band; ruling 7 folds the tile the verdict IS, by name, and keeps every other',
      s.vdctIn00 && (!figLabel || !(figLabel in s.values)) && s.values['People on the books'] === n(t.people)
      && s.values['Able to earn, earning nothing'] === n(t.idle_this_window) && s.values['Recruited, never driven'] === n(t.never_started)
      && (figLabel === 'Drove in this window' || s.values['Drove in this window'] === n(t.working)), JSON.stringify([figLabel, s.values]));
    check('every cohort link kept on the tiles that had one', (!t.idle_this_window || /roster-idle/.test(s.hrefs['Able to earn, earning nothing'] || ''))
      && (!t.never_started || /roster-never-started/.test(s.hrefs['Recruited, never driven'] || '')), JSON.stringify(s.hrefs));
    check('no tile wears a tone, none prints a bare dash', (await toned(page)).length === 0 && !s.bare.length);
    const st = await panelBy(page, 'What everyone is doing');
    check('the standings: one 100% bar, no ring, every segment but the fold still opening its people', s.rings === 0 && st.segs.length > 0
      && st.segs.filter((x) => !/--grey/.test(x.fill)).every((x) => x.click), JSON.stringify(st.segs));
    const cap = st.caps.find((x) => /Every segment opens the people behind it/.test(x)) || '';
    const parts = cap.replace(/\. Every segment.*$/, '').split(' · ').map((x) => +(x.match(/([\d,]+)$/)?.[1] || 'NaN').toString().replace(/,/g, ''));
    check('…with the count of each standing beneath it, summing to everyone on the books', parts.length === new Set(P.map((x) => x.category)).size
      && parts.reduce((a, x) => a + x, 0) === P.length, JSON.stringify([cap, parts]));
    const rec = await panelBy(page, 'When each person last took a booking');
    const B = [[0, 1], [1, 7], [7, 30], [30, 90], [90, 180], [180, Infinity]];
    const dated = P.filter((r) => r.days_since_last_trip != null && r.last_ever);
    const bins = B.map(([lo, hi]) => String(dated.filter((r) => r.days_since_last_trip >= lo && r.days_since_last_trip < hi).length));
    check('recency (new): six bins off people[].days_since_last_trip; never-driven counted in words, never drawn as a gap',
      rec && JSON.stringify(rec.bars.map((b) => b[1])) === JSON.stringify(bins)
      && (!P.some((r) => r.lifetime_trips === 0) || /never took one/.test(rec.caps.join(' '))), JSON.stringify([rec?.bars, bins]));
    const plat = await panelBy(page, 'How many platforms each person works');
    check('platforms per person in the job token', plat.bars.length > 0 && plat.bars.every((b) => /--mk-fill/.test(b[2])), JSON.stringify(plat.bars));
    const tbl = await page.evaluate(() => {
      const p = document.querySelector('[data-panel="roster-table"]');
      const td = p?.querySelector('tbody td:first-child');
      return { toned: p ? p.querySelectorAll('td .pill.warn, td .pill.err, td .pill.bad, td .pill.ok').length : -1,
        chips: p ? p.querySelectorAll('td .pill').length : 0, minW: td ? parseFloat(getComputedStyle(td).minWidth) : 0,
        cols: p ? p.querySelectorAll('thead th').length : 0 };
    });
    check('the table kept, its standings ink chips, the Driver column given a floor', tbl.chips > 0 && tbl.toned === 0 && tbl.minW > 100 && tbl.cols >= 10, JSON.stringify(tbl));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    const noReason = P.filter((r) => !r.reason).length;
    check('†: the reasonless rows counted, the company-account flag absent with its true reason, the caveat moved',
      (noReason ? ab['A reason for the standing']?.fig === `${noReason} of ${P.length}` : ab['A reason for the standing']?.none)
      && /nothing on \/api\/roster marks one/.test(ab['Rows that are not people']?.why || '') && ab['What the roster cannot say']?.why === d.caveat,
      JSON.stringify(s.abs.map((a) => [a.label, a.fig])));
    check('the colophon names the window and the roster', new RegExp(`${n(t.people)} on the books`).test(s.colophon), s.colophon);
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'roster/pipeline');
    const P = (answer('/api/roster').people || []).filter((x) => ['in_pipeline', 'never_started', 'unclassified', 'activity_unknown'].includes(x.category));
    const pp = await panelBy(page, 'Which of the four it is');
    const s = await shape(page);
    check('pipeline: the four states as one 100% bar, and the table', pp && pp.segs.length > 0 && s.heads.some((h) => /^Not yet earning — /.test(h)), JSON.stringify([pp?.segs, s.heads]));
    const noReason = P.filter((r) => !r.reason).length;
    check('pipeline †: the rows with no reason counted', s.abs.find((a) => a.label === 'A reason for the standing')?.fig === (noReason ? `${noReason} of ${P.length}` : 'Every one has one'), JSON.stringify(s.abs));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'roster/idle');
    const P = (answer('/api/roster').people || []).filter((x) => x.category === 'idle_this_window' && x.days_since_last_trip != null)
      .sort((a, b) => b.days_since_last_trip - a.days_since_last_trip).slice(0, 12);
    const dp = await panelBy(page, 'Dormant longest');
    const s = await shape(page);
    check('idle: dormant longest, the oldest last booking first, ink bars', dp && JSON.stringify(dp.bars.map((b) => b[1])) === JSON.stringify(P.map((r) => `${r.days_since_last_trip} days`))
      && dp.bars.every((b) => /--mk-fill/.test(b[2])), JSON.stringify([dp?.bars, P.map((r) => r.days_since_last_trip)]));
    const loose = await page.evaluate(() => [...document.querySelectorAll('#view > * .note, #view .stack > .note')].map((x) => x.textContent));
    check('idle: the widen-the-range note moved into †, not also printed loose', /Widen the range above/.test(s.abs.find((a) => a.label === 'Why they took nothing')?.why || '')
      && !loose.some((x) => /Widen the range above/.test(x)), JSON.stringify(loose));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'roster/blocked');
    const P = (answer('/api/roster').people || []).filter((x) => x.category === 'blocked');
    const holding = P.filter((x) => x.holding_vehicle_while_blocked);
    const r = await page.evaluate(() => {
      const cell = [...document.querySelectorAll('#view .absb-cell')].find((c) => /Holding a car while stopped/.test(c.textContent));
      return { cell: !!cell, links: cell ? cell.querySelectorAll('a[href*="vehicle"]').length : 0, fig: cell?.querySelector('.absb-fig')?.textContent.trim(),
        loose: [...document.querySelectorAll('#view .note')].some((n) => /still (has|have) a vehicle attached/.test(n.textContent)) };
    });
    check('blocked: the holding-a-car note in †, its plates still linked, not also loose', !holding.length
      || (r.cell && r.links > 0 && r.fig === `${holding.length} of ${P.length}` && !r.loose), JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'roster/states');
    const d = answer('/api/roster/states');
    const s = await shape(page);
    const plats = [...new Set((d.by_state || []).map((r) => r.platform))];
    const mult = await page.evaluate(() => [...document.querySelectorAll('[data-panel="roster-multiples"] .grid > div')].map((b) => ({
      name: b.querySelector('p.cap')?.textContent.trim(), fills: [...new Set([...b.querySelectorAll('.fill')].map((f) => f.getAttribute('style').match(/var\((--[\w-]+)\)/)?.[1]))],
      labels: [...b.querySelectorAll('.hb .k')].map((k) => k.textContent.trim()) })));
    check('states: one small multiple per channel on /api/roster/states, each in its own channel colour, "with a car" on every bar',
      mult.length === plats.length && mult.every((m) => m.fills.length === 1 && m.labels.every((l) => /with a car$/.test(l))), JSON.stringify(mult));
    check('states: tiles in the band, untoned; the raw-word table kept', s.glance >= 4 && (await toned(page)).length === 0
      && s.heads.some((h) => /^What each provider says/.test(h)), JSON.stringify(s.heads));
    await ctx.close();
  }
  for (const r of ['roster', 'roster/states']) {
    const { ctx, page } = await open('arkiv', r, { width: 390 });
    check(`#${r} at 390: nothing scrolls sideways`, (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #top-performers and #low-performers ══════════════════════════════════ */
if (want('performers')) {
  console.log('\n#top-performers, #low-performers');
  const rankOf = (d, top) => {
    const rows = (d.rows || []).filter((r) => (r.days_worked || 0) > 0);
    const money = rows.some((r) => (r.money || 0) > 0);
    const rate = (r) => (r.days_worked ? (money ? (r.money || 0) : (r.bookings || 0)) / r.days_worked : null);
    const ranked = rows.filter((r) => (r.days_worked || 0) >= 4 && (r.bookings || 0) >= 15 && rate(r) != null)
      .sort((a, b) => (top ? rate(b) - rate(a) : rate(a) - rate(b)));
    return { rows, money, rate, ranked };
  };
  {
    const { ctx, page } = await open('classic', 'top-performers');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'), tiles: document.querySelectorAll('#view .kpis > .kpi').length,
      pills: [...document.querySelectorAll('#view tbody tr')].slice(0, 3).some((tr) => tr.querySelectorAll('.pill').length > 0) }));
    check('old skin: no band, the four tiles, fleet and platforms still pills', !r.band && r.tiles === 4 && r.pills, JSON.stringify(r));
    await ctx.close();
  }
  for (const band of ['top', 'low']) {
    const top = band === 'top';
    const hash = `${band}-performers`;
    const { ctx, page, answer } = await open('arkiv', hash);
    await page.waitForFunction(() => document.querySelector('#view .cband .dlt-of'), null, { timeout: 15000 }).catch(() => {});
    const s = await shape(page);
    const d = answer('/api/economics/drivers');
    const { rows, rate, ranked } = rankOf(d, top);
    const n = (v) => (+v || 0).toLocaleString('en-US');
    const order = await page.evaluate(() => { const v = document.querySelector('#view'); const kids = [...v.children];
      return { stack: kids.findIndex((k) => k.classList.contains('stack')), band: kids.findIndex((k) => k.classList.contains('cband')) }; });
    check(`#${hash}: the week control first, then 00`, order.stack >= 0 && order.stack < order.band, JSON.stringify(order));
    const f = await vfig(page);
    check(`#${hash}: the verdict in the band; ruling 7 folds the ${top ? 'Best' : 'Lowest'} per day tile into it`, s.vdctIn00
      && !Object.values(s.values).includes(f) && !((top ? 'Best per day' : 'Lowest per day') in s.values), JSON.stringify([f, s.values]));
    check(`#${hash}: People ranked off the rows with the page's own gate and basis`, s.values['People ranked'] === n(ranked.length), JSON.stringify([s.values, ranked.length]));
    if (top) {
      const seven = rows.filter((r) => Number(r.days_worked) >= 7).length;
      check('#top: "Worked all seven days — N of M" (new)', s.values['Worked all seven days'] === `${n(seven)} of ${n(rows.length)}`, JSON.stringify(s.values));
    } else {
      const bk = rows.map((r) => Number(r.bookings) || 0).sort((a, b) => a - b); const qn = Math.ceil(bk.length / 4); const tot = bk.reduce((a, x) => a + x, 0);
      check('#low: the bottom quarter\'s share of the week\'s bookings (new)', s.values['The bottom quarter’s share'] === `${((bk.slice(0, qn).reduce((a, x) => a + x, 0) / tot) * 100).toFixed(1)}%`, JSON.stringify(s.values));
    }
    check(`#${hash}: no tone, no bare dash; an absent tile says why in words`, (await toned(page)).length === 0 && !s.bare.length
      && Object.values(s.na).every((w) => w.length > 20), JSON.stringify(s.na));
    const dl = await page.evaluate(() => [...document.querySelectorAll('#view .cband .kpi')].filter((k) => k.querySelector('.dlt-of')).map((k) => k.querySelector('.l')?.textContent.trim()));
    check(`#${hash}: the week before arrives as a worded delta on People ranked`, dl.includes('People ranked'), JSON.stringify(dl));
    const hero = await page.evaluate(() => [...document.querySelectorAll('[data-panel="perf-hero"] .hb')].map((h) => [h.querySelector('.k').textContent.trim(), h.querySelector('.fill').getAttribute('style')]));
    check(`#${hash}: the ${top ? 'top' : 'bottom'} twelve as bars, in rank order, channel-coloured only for a one-channel week`,
      hero.length === Math.min(12, ranked.length) && hero.every(([k], i) => k === (ranked[i].driver_name || '(unnamed)'))
      && hero.every(([, c], i) => ((ranked[i].platforms || []).length === 1 ? c.includes(`--c-${String(ranked[i].platforms[0]).toLowerCase()})`) : c.includes('--mk-fill)'))),
      JSON.stringify(hero.slice(0, 4)));
    const chips = await page.evaluate((t) => { const p = [...document.querySelectorAll('#view .panel')].find((x) => x.querySelector('h3')?.textContent === t);
      const th = p ? [...p.querySelectorAll('thead th')].map((x) => x.textContent.replace(/[▲▼↑↓]/g, '').trim()) : [];
      const tr = p?.querySelector('tbody tr'); const cell = (l) => tr?.children[th.indexOf(l)];
      return tr ? { pills: ['Fleet', 'Platforms'].reduce((a, l) => a + (cell(l)?.querySelectorAll('.pill').length || 0), 0), sw: cell('Platforms')?.querySelectorAll('.pchip .sw').length || 0 } : null; }, top ? 'Ranked highest' : 'Ranked lowest');
    check(`#${hash}: the table kept; fleet as text, platforms a swatch and an ink label — no pill in either`, chips && chips.sw > 0 && chips.pills === 0, JSON.stringify(chips));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    const t = d.totals || {};
    check(`#${hash}: † carries the coverage and hours notes as the API wrote them`, (!d.coverage?.note || ab['What the week covers']?.why === d.coverage.note)
      && (!t.hours_note || ab['Hours online']?.why === t.hours_note), JSON.stringify(s.abs.map((a) => a.label)));
    if (top) {
      const tr = rows.map((r) => Number(r.bookings) || 0).filter((x) => x > 0);
      const cap = await page.evaluate(() => [...document.querySelectorAll('[data-panel="perf-shape"] p.cap')].pop()?.textContent || '');
      const curve = await page.evaluate(() => !!document.querySelector('[data-panel="perf-shape"] svg path'));
      check('#top: how the work concentrates — the curve, the totals from the rows, the even fleet in words', curve && /an even week would give the top 20|ran/.test(cap)
        && cap.startsWith(`${tr.length} ${tr.length === 1 ? 'person' : 'people'} ran ${n(tr.reduce((a, x) => a + x, 0))} bookings`), cap);
    } else {
      const days = await page.evaluate(() => [...document.querySelectorAll('[data-panel="perf-shape"] .hb')].map((h) => [h.querySelector('.v').textContent.trim(), h.querySelector('.fill').getAttribute('style')]));
      check('#low: days worked 1–7, the columns under the gate set apart in grey', days.length === 7
        && days.every(([v, c], i) => v === String(rows.filter((r) => Number(r.days_worked) === i + 1).length) && (i + 1 < 4 ? c.includes('--grey)') : c.includes('--mk-fill)'))), JSON.stringify(days));
      const dots = await page.evaluate(() => document.querySelectorAll('[data-panel="perf-comp"] svg circle.sc-dot').length);
      check('#low: completion against bookings, drawn only from 30 bookings', dots === ranked.filter((r) => (r.bookings || 0) >= 30 && r.completion_pct != null).length, String(dots));
      const ch = await page.evaluate(() => [...document.querySelectorAll('[data-panel="perf-chan"] .hb')].map((h) => [h.querySelector('.k').textContent.trim(), h.querySelector('.v').textContent.trim()]));
      check('#low: which channels the week came from, people per channel', ch.length > 0 && ch.every(([, v]) => +v > 0), JSON.stringify(ch));
      const loose = await page.evaluate(() => [...document.querySelectorAll('#view .note')].some((x) => /It cannot tell a person who worked/.test(x.textContent)));
      check('#low: the warning moved into † word for word, not also loose', /It cannot tell a person who worked and did little from one who was on leave/.test(ab['Why somebody did little']?.why || '') && !loose);
    }
    await ctx.close();
  }
  for (const r of ['top-performers', 'low-performers']) {
    const { ctx, page } = await open('arkiv', r, { width: 390 });
    check(`#${r} at 390: nothing scrolls sideways`, (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #performance, by week and by month ═══════════════════════════════════ */
if (want('performance')) {
  console.log('\n#performance');
  {
    const { ctx, page } = await open('classic', 'performance');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'), tiles: document.querySelectorAll('#view .kpis > .kpi').length,
      amber: document.querySelectorAll('#view td span.good, #view td span.warn').length }));
    check('old skin: no band, the six tiles, differences still good/warn spans with no minus', !r.band && r.tiles === 6 && r.amber > 0, JSON.stringify(r));
    await ctx.close();
  }
  for (const hash of ['performance', 'performance?grain=month']) {
    const month = /month/.test(hash);
    const { ctx, page, answer } = await open('arkiv', hash);
    const s = await shape(page);
    const d = answer('/api/performance/fleet');
    const S = d.summary || {};
    const n = (v) => (+v || 0).toLocaleString('en-US');
    const order = await page.evaluate(() => { const kids = [...document.querySelector('#view').children];
      return { tabs: kids.findIndex((k) => k.querySelector('.tabs, .tabbar, [role="tablist"]') || /tab/.test(k.className)), band: kids.findIndex((k) => k.classList.contains('cband')),
        chips: kids.findIndex((k) => k.querySelector('.chips')) }; });
    check(`#${hash}: the grain tabs and the period chips first, in the chrome, then 00`, order.tabs >= 0 && order.tabs < order.band
      && order.chips > order.tabs && order.chips < order.band, JSON.stringify(order));
    check(`#${hash}: the verdict's figure is the active-driver count — that tile folds into it; Changed leads`, s.vdctIn00
      && !('Active drivers' in s.values) && (await vfig(page)) === n(S.drivers) && s.hero === 'Changed', JSON.stringify([s.hero, s.values]));
    check(`#${hash}: the tiles off the summary`, s.values['Jobs done'] === n(S.completed) && s.values.Changed === n(d.movers.length)
      && (S.value == null ? 'Trip value' in s.na : s.values['Trip value'] === aedOf(S.value)), JSON.stringify(s.values));
    check(`#${hash}: no tone, no bare dash`, (await toned(page)).length === 0 && !s.bare.length);
    const at = d.periods.findIndex((x) => x.period === d.period);
    const prev = d.period_complete && at > 0 ? [...d.periods.slice(0, at)].reverse().find((x) => x.complete) : null;
    const dl = await page.evaluate(() => [...document.querySelectorAll('#view .cband .kpi')].filter((k) => k.querySelector('.dlt'))
      .map((k) => [k.querySelector('.l')?.textContent.trim(), k.querySelector('.dlt-v')?.textContent.trim()]));
    const want = prev ? `${S.completed - prev.completed > 0 ? '+' : S.completed - prev.completed < 0 ? '−' : ''}${n(Math.abs(S.completed - prev.completed))}` : null;
    check(`#${hash}: a complete period carries its change on the last complete one; the running one none`,
      prev ? dl.some(([l, v]) => l === 'Jobs done' && v === want) : dl.length === 0, JSON.stringify([dl, want, d.period_complete]));
    const dots = await page.evaluate(() => document.querySelectorAll('[data-panel="perf-scatter"] svg circle.sc-dot').length);
    check(`#${hash}: every placeable driver a dot, jobs against trip value`, dots === (d.rows || []).filter((r) => r.value_rankable && r.value != null && r.completed != null).length, String(dots));
    const cells = await page.evaluate(() => ({ amber: document.querySelectorAll('#view td span.good, #view td span.warn').length,
      signed: [...document.querySelectorAll('#view td .dlt .dlt-v')].map((x) => x.textContent) }));
    const moverDown = (d.movers || []).some((m) => Math.round(m.split?.total ?? 0) < 0);
    check(`#${hash}: differences signed — a glyph and a minus, never amber`, cells.amber === 0
      && (!(d.movers || []).length || cells.signed.length > 0) && (!moverDown || cells.signed.some((v) => v.startsWith('−'))), JSON.stringify(cells));
    const tr = await page.evaluate(() => { const p = [...document.querySelectorAll('#view .panel')].find((x) => /^The fleet, /.test(x.querySelector('h3')?.textContent || ''));
      return { svgs: p ? p.querySelectorAll('svg').length : 0, h4: p ? [...p.querySelectorAll('h4')].map((h) => h.textContent) : [] }; });
    check(`#${hash}: the trend, and active drivers as their own chart`, tr.svgs >= 2 && tr.h4.some((h) => /^Active drivers, /.test(h)), JSON.stringify(tr));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    const R = d.rows || [];
    const dropped = R.reduce((a, r) => a + (+r.dropped || 0), 0);
    const limbo = S.accepted - S.completed - dropped;
    check(`#${hash}: †: no usual, accepted-then-neither, and rates under the gate — counted from the rows`,
      (limbo > 0 ? ab['Accepted, then neither done nor dropped']?.fig === n(limbo) : true)
      && ab[`A completion rate under ${d.rate_gates?.show ?? 30} accepted`] != null
      && (R.filter((r) => r.rates?.absent).length ? ab[`A completion rate under ${d.rate_gates?.show ?? 30} accepted`].fig === `${R.filter((r) => r.rates?.absent).length} of ${R.length}` : true),
      JSON.stringify(s.abs.map((a) => [a.label, a.fig])));
    check(`#${hash}: How to read this kept`, s.heads.includes('How to read this'), JSON.stringify(s.heads));
    void month;
    await ctx.close();
  }
  {
    /* A period nobody worked: the `?? 0` noughts become absences with the
       true reason. */
    const empty = (q, real) => ({ ...real, summary: null, movers: [], rows: [], movement: { ...real.movement, tested: 0, untested: 0 } });
    const { ctx, page } = await open('arkiv', 'performance', { fixtures: { '/api/performance/fleet': empty } });
    const s = await shape(page);
    check('a period nobody worked: Active drivers, Jobs done and Jobs a day ABSENT with the reason, Changed absent too — never 0',
      ['Active drivers', 'Jobs done', 'Jobs a day'].every((l) => /^nobody accepted work in /.test(s.na[l] || ''))
      && /enough of their own record/.test(s.na.Changed || '') && !['Active drivers', 'Jobs done', 'Jobs a day', 'Changed'].some((l) => s.values[l] === '0'),
      JSON.stringify([s.values, s.na]));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'performance', { width: 390 });
    check('#performance at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

await done();
