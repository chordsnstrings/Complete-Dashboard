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

await done();
