/* The page phase, section "Work" — each page under the contract.
   ═══════════════════════════════════════════════════════════════════════════
   docs/UI-REDESIGN-PLAN.md §4 (Work), the operator's rulings (§1) and the
   house principle. For every converted page: the contract's shape under the
   skin, its figures against the answers the page itself received, its
   absences with their true reasons, and the old skin still building the old
   page (byte for byte is test/arkiv_classic_frozen.test.mjs's job).
   ONLY=<page> narrows a run.

   Synthetic data only: the mock, and fixtures built here. */
import { harness, shape } from './arkiv_pages.mjs';

const { check, start, open, done } = harness('Arkiv page phase — Work');
await start();
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);

const aed = (n) => `${Number(n) < 0 ? '−' : ''}AED ${Math.abs(Number(n)).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const txtOf = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  return n ? n.textContent.replace(/\s+/g, ' ').trim() : '';
}, sel);
const toned = (page) => page.evaluate(() => [...document.querySelectorAll('#view .kpis.glance > .kpi')]
  .filter((t) => /\bt-(good|warn|critical|serious|bad)\b/.test(t.className)).map((t) => t.className));
const fills = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(`${s} svg [data-rise]`)]
  .map((m) => ({ f: m.getAttribute('fill') || '', h: m.getBBox().height })), sel);
const hatched = (f) => /^url\(/.test(f);
const bars = (page, sel) => page.evaluate((s) => [...document.querySelectorAll(`${s} .hb`)]
  .map((h) => [h.querySelector('.k')?.textContent.trim(), h.querySelector('.v')?.textContent.trim()]), sel);
const dubai = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24 };
};

/* ══ #demand ══════════════════════════════════════════════════════════════ */
if (want('demand')) {
  console.log('\n#demand');
  const HEADS = ['At a glance', 'Every hour of every weekday', 'The shape of a day', 'The shape of a week',
    'A weekend day is a different day', 'Daily volume', 'Trips against weather and holidays', '† What this page does not know'];
  {
    const { ctx, page } = await open('classic', 'demand');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      heads: [...document.querySelectorAll('#view .panel > h3')].map((h) => h.textContent.trim()) }));
    check('old skin: the old page — no 00 band, the hourly curve beside the daily volume',
      !r.band && r.heads[0] === 'Hourly demand curve' && r.heads.includes('Busiest hours of the week'), JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'demand');
    const s = await shape(page);
    const D = answer('/api/trips/daily'), G = answer('/api/trips/heatmap');
    check('the section order is the plan\'s', JSON.stringify(s.heads) === JSON.stringify(HEADS), JSON.stringify(s.heads));
    const vfig = await txtOf(page, '#view .cband .vdct-n, #view .cband .vdct-fig');
    check('the verdict (unchanged arithmetic) is 00\'s statement and its figure is not a tile (ruling 7)',
      s.vdctIn00 && !!vfig && !Object.values(s.values).includes(vfig), `${vfig} ${JSON.stringify(s.values)}`);
    /* 02 and the hero agree: the hero is the tallest SOLID column. */
    const day = await fills(page, '[data-panel="demand-day"]');
    const hrs = await page.evaluate(() => [...document.querySelectorAll('[data-panel="demand-day"] svg text.axis')].length);
    const solid = day.map((b, i) => ({ ...b, i })).filter((b) => !hatched(b.f));
    const top = solid.reduce((a, b) => (b.h > a.h ? b : a), solid[0]);
    check('02 draws the day as 24 columns and hatches at most the hour in progress',
      day.length === 24 && day.filter((b) => hatched(b.f)).length <= 1 && hrs > 0, JSON.stringify(day.map((b) => b.f.slice(0, 6))));
    check('…and the hero, the busiest hour, is its tallest solid column', s.hero === 'The busiest hour'
      && s.values['The busiest hour'] === `${String(top.i).padStart(2, '0')}:00`, `${s.values['The busiest hour']} vs ${top.i}`);
    /* 03 per occurrence, recomputed from the two answers the page read. */
    const now = dubai();
    const dow = (d) => new Date(`${String(d).slice(0, 10)}T12:00:00Z`).getUTCDay();
    const occ = Array(7).fill(0);
    D.filter((r) => String(r.d).slice(0, 10) !== now.day && !r.uncollected && !(+r.of_days > 1)).forEach((r) => { occ[dow(r.d)] += 1; });
    const runsInto = D.some((r) => String(r.d).slice(0, 10) === now.day);
    const tDow = runsInto ? dow(now.day) : null;
    const rate = (w) => (occ[w] ? G.filter((c) => +c.dow === w).reduce((a, c) => {
      const days = occ[w] + (tDow === w && +c.h < now.hour ? 1 : 0);
      return a + (days ? (+c.trips || 0) / days : 0);
    }, 0) : null);
    const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const want3 = NAMES.map((n, w) => [n, rate(w), occ[w]]).filter((x) => x[1] != null).sort((a, b) => b[1] - a[1]);
    const got3 = await bars(page, '[data-panel="demand-week"]');
    check('03: every weekday per occurrence — its heatmap row over its own count of collected whole days',
      got3.length === want3.length && got3.every(([k, v], i) => k === `${want3[i][0]} · ${want3[i][2]} ${want3[i][2] === 1 ? 'day' : 'days'}`
        && v === Math.round(want3[i][1]).toLocaleString('en-US')), JSON.stringify([got3, want3.map((x) => [x[0], Math.round(x[1]), x[2]])]));
    check('…and the busiest weekday tile is the top of it', s.values['Busiest weekday'] === want3[0][0], s.values['Busiest weekday']);
    const two = await page.evaluate(() => [...document.querySelectorAll('[data-panel="demand-weekend"] svg')].length);
    check('04: a weekday and a weekend day, side by side', two === 2 && /Monday to Friday/.test(await txtOf(page, '[data-panel="demand-weekend"]')), String(two));
    check('demand nobody served is ABSENT with its reason', /no feed reports a request that no car took/.test(s.na['Demand nobody served'] || ''), JSON.stringify(s.na));
    check('no tile wears a tone, none prints a bare dash', (await toned(page)).length === 0 && !s.bare.length);
    const temp = await page.evaluate(() => {
      const t = document.querySelector('[data-panel="demand-weather"] table');
      if (!t) return null;
      const i = [...t.querySelectorAll('thead th')].findIndex((th) => /Max temp/.test(th.textContent));
      return i < 0 ? null : [...t.querySelectorAll('tbody tr')].filter((tr) => tr.children[i]?.querySelector('.pill')).length;
    });
    check('the weather table\'s Max temp is a plain figure, not a toned pill (a hot day is not worse)', temp === 0 || temp === null, String(temp));
    const cells = new Set(G.map((c) => `${c.dow}:${c.h}`)).size;
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    check('† cells with no reading are counted from the heatmap answer', ab['Cells with no reading']?.fig === `${168 - cells} of 168`, JSON.stringify(ab['Cells with no reading']));
    check('the heatmap still opens #slot and lists the busiest slots', /Busiest slots:/.test(await txtOf(page, '[data-panel="demand-heat"]')));
    await ctx.close();
  }
  {
    /* A day one source was silent on still put the others' bookings in the
       heatmap row, so it stays in that weekday's count of days. */
    let marked = null;
    const silent = (_q, real) => real.map((r, i) => {
      if (marked == null && i > 0 && !r.uncollected && String(r.d).slice(0, 10) !== dubai().day) { marked = r.d; return { ...r, sources_silent: 1 }; }
      return r;
    });
    const { ctx, page, answer } = await open('arkiv', 'demand', { fixtures: { '/api/trips/daily': silent } });
    const D = answer('/api/trips/daily');
    const w = new Date(`${String(marked).slice(0, 10)}T12:00:00Z`).getUTCDay();
    const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const n = D.filter((r) => new Date(`${String(r.d).slice(0, 10)}T12:00:00Z`).getUTCDay() === w && !r.uncollected
      && String(r.d).slice(0, 10) !== dubai().day).length;
    const got = (await bars(page, '[data-panel="demand-week"]')).find(([k]) => k.startsWith(`${NAMES[w]} ·`));
    check('a day one source was silent on stays in its weekday\'s count of days (its other bookings are in the row)',
      got && got[0] === `${NAMES[w]} · ${n} ${n === 1 ? 'day' : 'days'}`, JSON.stringify([got, n, marked]));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'demand', { width: 390 });
    check('at 390 nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #trips ═══════════════════════════════════════════════════════════════ */
if (want('trips')) {
  console.log('\n#trips');
  {
    const { ctx, page } = await open('classic', 'trips');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      tiles: [...document.querySelectorAll('#view .kpis .kpi .l')].map((l) => l.textContent.trim()),
      th: [...document.querySelectorAll('#view thead th')].map((t) => t.textContent.trim()) }));
    check('old skin: the old page — its three tiles, its nine columns, no booking link',
      !r.band && r.tiles.length === 3 && !r.th.includes('Booking') && r.th.length === 9, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'trips');
    const s = await shape(page);
    const L = answer('/api/trips/list'), K = answer('/api/kpis');
    check('00 leads, the table directly under it (the plan\'s departure: operators come to find a job), then the charts and †',
      JSON.stringify(s.heads) === JSON.stringify(['At a glance', 'Bookings', 'Whether the booking carries a price', 'How the fare settles',
        'Every booking, a day at a time', 'How much of a day gets cancelled', '† What this page does not know']), JSON.stringify(s.heads));
    check('Carrying a fare is the hero, the list answer\'s window count', s.hero === 'Carrying a fare' && s.values['Carrying a fare'] === (+L.priced).toLocaleString('en-US'), JSON.stringify(s.values));
    check('Bookings, Completed and Cancelled are /api/kpis\'s, the cancellations split by who',
      s.values.Bookings === (+K.trips).toLocaleString('en-US') && s.values.Completed === `${(+K.completion_pct).toFixed(1)}%`
      && s.subs.Cancelled.includes(`${(+K.cancelled_by_rider).toLocaleString('en-US')} by the rider`), JSON.stringify([s.values, s.subs.Cancelled]));
    check('Mean fare is the kpis mean over priced bookings', s.values['Mean fare'] === aed(K.avg_fare), s.values['Mean fare']);
    check('how long a ride took is ABSENT with the true reason', /request to end is not ride time/.test(s.na['How long a ride took'] || ''), JSON.stringify(s.na));
    const t = await page.evaluate(() => ({ th: [...document.querySelectorAll('[data-panel="trips-list"] thead th')].map((x) => x.textContent.trim()),
      links: [...document.querySelectorAll('[data-panel="trips-list"] tbody a[href^="#trip/"]')].length,
      toned: document.querySelectorAll('[data-panel="trips-list"] .tag.ok, [data-panel="trips-list"] .tag.bad').length }));
    const bookable = L.rows.filter((r) => r.external_id && r.is_booking !== false).length;
    check('the nine columns kept, Tier, Payment and a link to the booking page added on every booking row',
      ['When', 'Channel', 'Driver', 'Vehicle', 'From', 'To', 'Km', 'Outcome', 'Fare', 'Tier', 'Payment', 'Booking'].every((h) => t.th.includes(h))
      && t.links === bookable, JSON.stringify(t));
    check('outcome tags lose their green/red fills', t.toned === 0, String(t.toned));
    const ab = s.abs.find((a) => a.label === 'How long a ride took');
    check('† ride time counts the rows with no duration', ab?.none && /duration_s is empty/.test(ab.why), JSON.stringify(ab));
    /* The search still narrows the table and says so beside it. */
    await page.fill('[data-panel="trips-list"] input[type=search]', 'zzzz-no-such-thing');
    await page.waitForTimeout(1500);
    const after = await txtOf(page, '[data-panel="trips-list"] .trips-count');
    check('the search still narrows the list, and the count beside the table says "matching this search"', /^Matching this search: 0/.test(after), after);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'trips', { width: 390 });
    check('at 390 nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #supply ══════════════════════════════════════════════════════════════ */
if (want('supply')) {
  console.log('\n#supply');
  /* One cell sold nothing with real supply behind it; others are missing. */
  const zero = (_q, real) => ({ ...real, cells: real.cells.map((c, i) => (i === 0 ? { ...c, jobs: 0, on_job_h: 0, jobs_per_online_h: 0, online_h: Math.max(2, +c.online_h || 0) } : c)) });
  const gridStyle = (page) => page.evaluate(() => {
    const cs = (sel, pseudo) => { const n = document.querySelector(sel); return n ? getComputedStyle(n, pseudo || null) : null; };
    const b0 = cs('.sup-c.b0'), after = cs('.sup-c.b0', '::after'), none = cs('.sup-c.none');
    return { b0: b0 ? [b0.backgroundColor, b0.opacity] : null, glyph: after ? after.content : null,
      none: none ? [none.backgroundImage, none.boxShadow] : null };
  });
  {
    const { ctx, page } = await open('classic', 'supply', { fixtures: { '/api/supply/balance': zero } });
    const g = await gridStyle(page);
    check('old skin: "sold nothing" is still the critical fill and "no availability" still a hatch',
      g.b0 && g.b0[1] !== '1' && g.glyph === 'none' && /gradient/.test(g.none?.[0] || ''), JSON.stringify(g));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'supply', { fixtures: { '/api/supply/balance': zero } });
    const g = await gridStyle(page);
    check('S8: under the skin "sold nothing" is the lowest step at full opacity with a ▾ glyph (a measured nought)',
      g.b0 && g.b0[1] === '1' && /▾/.test(g.glyph || ''), JSON.stringify(g));
    check('S8: …and "no availability collected" is an outline, not a hatch (an absence, not a projection)',
      g.none && g.none[0] === 'none' && /inset/.test(g.none[1] || ''), JSON.stringify(g));
    await ctx.close();
  }
}

if (want('supply')) {
  {
    const { ctx, page, answer } = await open('arkiv', 'supply');
    const s = await shape(page);
    const B = answer('/api/supply/balance'), A = answer('/api/supply/areas');
    const t = B.totals;
    check('#supply: 00, the rate grid, a typical week, what an hour buys, the area table, †',
      JSON.stringify(s.heads) === JSON.stringify(['At a glance', 'Which hours sell the drivers you are paying for', 'A typical week, hour by hour',
        'What an online hour actually buys', 'Where the waiting happens', '† What this page does not know']), JSON.stringify(s.heads));
    const vfig = await txtOf(page, '#view .cband .vdct-n, #view .cband .vdct-fig');
    check('the verdict is 00\'s statement; its figure, jobs per online hour, is not a tile (ruling 7)',
      s.vdctIn00 && !Object.values(s.values).includes(vfig) && !s.labels.some((l) => /jobs per online hour/i.test(l)), `${vfig} ${JSON.stringify(s.values)}`);
    check('idle hours lead, then online hours with the part on a job — the balance answer\'s totals',
      s.hero === 'Idle hours' && s.values['Idle hours'] === `${(+t.idle_h).toLocaleString('en-US')} h`
      && s.values['Online hours'] === `${(+t.online_h).toLocaleString('en-US')} h` && s.subs['Online hours'].includes(`${(+t.on_job_h).toLocaleString('en-US')} h`), JSON.stringify(s.values));
    const waited = A.areas.reduce((a, r) => a + (+r.waiting_h || 0), 0);
    check('waiting between jobs sums the area answer', s.values['Waiting between jobs'] === `${waited.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h`, s.values['Waiting between jobs']);
    const wk = await fills(page, '[data-panel="supply-week"]'), buy = await fills(page, '[data-panel="supply-buys"]');
    check('02 and 03 are drawn hour by hour from the same per-occurrence cells', wk.length > 0 && wk.length <= 24 && buy.length > 0 && buy.length <= 24, `${wk.length} ${buy.length}`);
    const un = A.areas.find((r) => /unrecorded/i.test(r.area));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    check('† the unnamed area\'s waiting stays in the table and is named in the band', un ? ab['Waits in an unnamed area']?.fig === `${(+un.waiting_h).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} h` : true,
      JSON.stringify(ab['Waits in an unnamed area']));
    check('the area table keeps its sort and its fold', /Show the other/.test(await txtOf(page, '#view')) || A.areas.length <= 12);
    await ctx.close();
  }
  {
    /* No availability for this selection (a Bolt chip): every tile built on
       online hours is ABSENT, with the reason the page already gives. */
    const off = (_q, real) => ({ ...real, covered: false, uncovered: { reason: 'no-feed', platforms: ['uber'] },
      totals: { online_h: null, on_job_h: null, idle_h: null, jobs: null, idle_pct: null, jobs_per_online_h: null }, cells: [] });
    const { ctx, page } = await open('arkiv', 'supply', { fixtures: { '/api/supply/balance': off } });
    const s = await shape(page);
    check('no availability collected: idle and online hours are ABSENT, never nought', /no availability was collected/.test(s.na['Idle hours'] || '')
      && /no availability was collected/.test(s.na['Online hours'] || '') && !s.bare.length, JSON.stringify(s.na));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'supply', { width: 390 });
    check('#supply at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

await done();
