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

await done();
