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

/* ══ #platforms (share, tiers, funnel) ════════════════════════════════════ */
if (want('platforms')) {
  console.log('\n#platforms');
  for (const tab of ['platforms', 'platforms/tiers', 'platforms/funnel']) {
    const { ctx, page } = await open('classic', tab);
    const band = await page.$('#view .cband');
    check(`old skin: ${tab} has no 00 band`, !band);
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'platforms');
    const s = await shape(page);
    const M = answer('/api/mix', (q) => q.by === 'platform'), K = answer('/api/kpis', (q) => !q.platform);
    const total = M.reduce((a, r) => a + (+r.n || 0), 0);
    check('share: 00, the dominance bar, completion and km by channel, the fleets, coverage, †',
      JSON.stringify(s.heads) === JSON.stringify(['At a glance', 'Every booking, by channel', 'Completion by channel, against the fleet',
        'How far a booking goes, by channel', 'Trips by fleet', 'Coverage & history depth', '† What this page does not know']), JSON.stringify(s.heads));
    const vfig = await txtOf(page, '#view .cband .vdct-n, #view .cband .vdct-fig');
    check('…no tile repeats the verdict\'s figure (the leading channel\'s share is the verdict\'s)', !Object.values(s.values).includes(vfig), `${vfig} ${JSON.stringify(s.values)}`);
    check('…bookings across every channel leads, from the mix answer', s.hero === 'Bookings across every channel' && s.values['Bookings across every channel'] === total.toLocaleString('en-US'), JSON.stringify(s.values));
    check('…work turned down is the kpis answer\'s declined offers', s.values['Work turned down'] === (+K.declined_offers).toLocaleString('en-US') || /offer/.test(s.na['Work turned down'] || ''), JSON.stringify([s.values, s.na]));
    const sub = await txtOf(page, '#view .cband .vdct');
    const fmsDead = !M.some((r) => r.label === 'fms');
    check('the verdict\'s sub no longer says the tracker "delivered nothing": it files journeys, not bookings (the plan\'s fix)',
      !/FMS telematics[^.]*delivered nothing/.test(sub) && (!fmsDead || /files journeys, not bookings/.test(sub)), sub.slice(0, 400));
    const ctl = await page.evaluate(() => [...document.querySelectorAll('[data-panel="plat-share"] button, [data-panel="plat-share"] [role="button"]')].length);
    check('the dominance bar is still the channel filter — its segments are buttons', ctl > 0, String(ctl));
    const fleet = await page.evaluate(() => { const p = [...document.querySelectorAll('#view .panel')].find((x) => x.querySelector('h3')?.textContent.trim() === 'Trips by fleet');
      return p ? { ring: !!p.querySelector('svg.donut') } : null; });
    check('the fleets are a two-part bar, not a ring', fleet && !fleet.ring, JSON.stringify(fleet));
    check('† four cells, the tracker among them', s.abs.length === 4 && s.abs.some((a) => a.label === 'The tracker as a channel'), JSON.stringify(s.abs.map((a) => a.label)));
    check('no tile wears a tone', (await toned(page)).length === 0);
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'platforms/tiers');
    const s = await shape(page);
    const P = answer('/api/mix', (q) => q.by === 'product');
    check('tiers: the four tiles as a band, premium share the hero', s.hero === 'Premium share' && s.glance === 4, JSON.stringify(s.labels));
    const asked = await bars(page, '[data-panel="tiers-asked"]');
    check('01: one bar per tier the riders asked for, from the product mix', asked.length === P.filter((r) => +r.n > 0).length, `${asked.length}`);
    const ink = await page.evaluate(() => { const p = [...document.querySelectorAll('#view .panel')].find((x) => /Gap to the best car/.test(x.querySelector('h3')?.textContent || ''));
      return p ? [...p.querySelectorAll('.hb .fill')].map((f) => f.style.background) : []; });
    check('the gap bars are ink — a shortfall against a peer is not a channel colour', ink.length === 0 || ink.every((b) => /--ink/.test(b)), JSON.stringify(ink.slice(0, 3)));
    check('no tile wears a tone, none prints a bare dash', (await toned(page)).length === 0 && !s.bare.length);
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'platforms/funnel');
    const s = await shape(page);
    const K = answer('/api/kpis');
    check('funnel: the five tiles as a band, untoned, none a bare dash', s.glance === 5 && (await toned(page)).length === 0 && !s.bare.length, JSON.stringify(s.labels));
    const down = await bars(page, '[data-panel="funnel-down"]');
    const n = [K.cancelled_by_rider, K.declined_offers, K.cancelled_by_driver, K.cancelled_unsaid].filter((x) => x != null).length;
    check('01: what any channel says about work turned down, each bar naming who files it', down.length === n && down.every(([k]) => / · /.test(k)), JSON.stringify(down));
    await ctx.close();
  }
  for (const tab of ['platforms', 'platforms/tiers', 'platforms/funnel']) {
    const { ctx, page } = await open('arkiv', tab, { width: 390 });
    check(`${tab} at 390: nothing scrolls sideways`, (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #corridors ═══════════════════════════════════════════════════════════ */
if (want('corridors')) {
  console.log('\n#corridors');
  {
    const { ctx, page } = await open('classic', 'corridors');
    check('old skin: no 00 band', !(await page.$('#view .cband')));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'corridors');
    const s = await shape(page);
    const C = answer('/api/geo/corridors'), t = C.totals;
    check('the plan\'s order: 00, busiest routes, where work starts, km against fare, morning/evening, same area, the table, †',
      JSON.stringify(s.heads) === JSON.stringify(['At a glance', 'The busiest routes between two areas', 'Where jobs start',
        'How far a route runs, and what it earns', 'Morning areas and evening areas', 'Work that never leaves the area', 'Common routes',
        '† What this page does not know']), JSON.stringify(s.heads));
    const vfig = await txtOf(page, '#view .cband .vdct-n, #view .cband .vdct-fig');
    check('the verdict is 00\'s statement and no tile repeats its figure', s.vdctIn00 && !Object.values(s.values).includes(vfig), `${vfig} ${JSON.stringify(s.values)}`);
    const named = C.corridors.filter((r) => r.from_area !== '(unrecorded)' && r.to_area !== '(unrecorded)');
    const same = named.filter((r) => r.from_area === r.to_area);
    const sent = C.corridors.reduce((a, r) => a + (+r.trips || 0), 0);
    check('Never leaves the area counts the same-area routes the server sent', s.values['Never leaves the area'] === same.reduce((a, r) => a + r.trips, 0).toLocaleString('en-US')
      && s.subs['Never leaves the area'].includes(`routes the server sent`) && sent > 0, `${s.values['Never leaves the area']} ${s.subs['Never leaves the area']}`);
    const r01 = await bars(page, '[data-panel="corr-routes"]');
    const between = named.filter((r) => r.from_area !== r.to_area).sort((a, b) => b.trips - a.trips).slice(0, 12);
    check('01: the busiest routes between two different named areas, top twelve', JSON.stringify(r01.map(([k]) => k))
      === JSON.stringify(between.map((r) => `${r.from_area} → ${r.to_area}`)), JSON.stringify([r01.slice(0, 3), between.slice(0, 3).map((r) => r.from_area)]));
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('#view .hbars .hb .k')].filter((k) => /unrecorded/.test(k.textContent)).length);
    check('"(unrecorded)" is never drawn as a place (AUDIT #47)', unnamed === 0, String(unnamed));
    const dots = await page.evaluate(() => document.querySelectorAll('[data-panel="corr-scatter"] svg circle').length);
    const priced = named.filter((r) => +r.priced > 0 && r.avg_km != null && r.avg_fare != null).length;
    check('03: one dot per named route with a priced trip', priced ? dots === priced : dots === 0, `${dots} vs ${priced}`);
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    check('† routes not drawn is the pairs in the window less the routes sent', ab['Routes not drawn']?.fig === String(Math.max(0, (t.corridors_all ?? C.corridors.length) - C.corridors.length)),
      JSON.stringify(ab['Routes not drawn']));
    check('no tile wears a tone', (await toned(page)).length === 0);
    await ctx.close();
  }
  {
    /* The busiest route has an unnamed end: it is not drawn as a place. */
    const unnamed = (_q, real) => ({ ...real, corridors: [{ from_area: '(unrecorded)', to_area: 'Al Garhoud', trips: 99999, avg_km: '5', priced: 10, avg_fare: '40', platforms: ['uber'] },
      { from_area: 'Al Garhoud', to_area: '(unrecorded)', trips: 88888, avg_km: '5', priced: 10, avg_fare: '40', platforms: ['uber'] }, ...real.corridors] });
    const { ctx, page } = await open('arkiv', 'corridors', { fixtures: { '/api/geo/corridors': unnamed } });
    const r01 = await bars(page, '[data-panel="corr-routes"]');
    const dots = await page.evaluate(() => [...document.querySelectorAll('[data-panel="corr-scatter"] svg circle')].length);
    check('a route with an unnamed end is in no chart — not the busiest bar, not a dot (AUDIT #47)',
      !r01.some(([k]) => /unrecorded/.test(k)) && !(await txtOf(page, '[data-panel="corr-scatter"]')).includes('unrecorded'), JSON.stringify([r01.slice(0, 2), dots]));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'corridors', { width: 390 });
    check('#corridors at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #causes ══════════════════════════════════════════════════════════════ */
if (want('causes')) {
  console.log('\n#causes');
  {
    const { ctx, page } = await open('classic', 'causes');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      fold: !!document.querySelector('#view details.causes-fold'), journeys: /journeys on FMS/.test(document.querySelector('#view')?.textContent || '') }));
    check('old skin: no 00 band, no fold, FMS cards still say trips', !r.band && !r.fold && !r.journeys, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'causes');
    const s = await shape(page);
    const T = answer('/api/trend/monthly'), B = answer('/api/breaks');
    check('the plan\'s order: 00, the trend, what moved, drivers | per driver, the cards, gaps, events, fewer drivers, †',
      JSON.stringify(s.heads) === JSON.stringify(['At a glance', 'Trips per month', 'What moved, at each break', 'How many drivers', 'What each one did',
        'Big jumps between months', 'Coverage gaps', 'What was on in Dubai', 'Fewer drivers, or less work?', '† What this page does not know']), JSON.stringify(s.heads));
    check('the largest move is the hero, and no tile repeats the verdict\'s figure', s.hero === 'Largest move'
      && !Object.values(s.values).includes(await txtOf(page, '#view .cband .vdct-n, #view .cband .vdct-fig')), JSON.stringify(s.values));
    const all = [...(T.breaks || [])].sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
    const big = all.find((b) => !b.boundary_artifact) || all[0];
    const sp = big && big.drivers_from && big.drivers_to ? (() => { const p0 = big.trips_from / big.drivers_from; const head = (big.drivers_to - big.drivers_from) * p0;
      return Math.round((head / (big.trips_to - big.trips_from)) * 100); })() : null;
    check('the headcount\'s share of the largest move is ΔD·p₀ over ΔT', sp == null ? !!s.na['The headcount explains'] : s.values['The headcount explains'] === `${sp}%`,
      `${s.values['The headcount explains']} vs ${sp}`);
    const real = all.filter((b) => !b.boundary_artifact && b.drivers_from && b.drivers_to);
    const deco = await bars(page, '[data-panel="causes-deco"]');
    check('02: a headcount bar and a per-driver bar for every real break that names its drivers', deco.length === real.length * 2, `${deco.length} vs ${real.length * 2}`);
    const cards = Array.isArray(B) ? B.length : 0;
    const folded = await page.evaluate(() => document.querySelectorAll('#view details.causes-fold .bk, #view details.causes-fold > div').length);
    check('the break cards fold after the first four — nothing removed', cards > 4 ? folded > 0 : folded === 0, `${cards} cards, ${folded} folded`);
    const fms = (Array.isArray(B) ? B : []).some((b) => b.platform === 'fms');
    check('an FMS break card says journeys, not trips (the plan\'s fix)', !fms || /journeys on FMS/.test(await txtOf(page, '#view')), String(fms));
    check('no tile wears a tone', (await toned(page)).length === 0);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'causes', { width: 390 });
    check('#causes at 390: nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

await done();
