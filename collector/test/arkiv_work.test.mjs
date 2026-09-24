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

await done();
