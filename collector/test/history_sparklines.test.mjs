/* The hero sparklines, drawn from /api/history — in the browser and in Node.
   ═══════════════════════════════════════════════════════════════════════════
   Four heroes the redesign plan lists had no series and so no line (FIX-STATUS
   SPK): #online-time's Late, #performer's weekly money, #deposits' ceiling and
   its carriers, #cancellations. Each now draws one from ONE request to
   /api/history. What this holds them to:

   0. api/public/history.js, in Node: a series becomes the tile's array, nulls
      kept as gaps; an absent series becomes the endpoint's own sentence; a
      line needs two measured points or it says why; a request that failed —
      or an answer without the series — says the line did not load and that
      the figure is unaffected; the caption names the span, how much is drawn
      and why the rest is not.
   1. Each page, Arkiv, 1280: ONE /api/history request per draw — counted
      against the page's own primary request, because the mock's figures move
      on every request and a revalidation redraws the whole page (FIX-STATUS
      UBJ6), each draw asking for both again; the line on
      the tile the plan names; a null drawn as a break in the line (as many
      runs as the answer has stretches of two or more readings), the end mark
      at the last measured point's own x (so a trailing gap stays a gap); a
      round end mark; the caption on the tile.
   2. 390: the line still drawn, nothing sideways.
   3. Dark: the line is a visible colour on the page.
   4. Classic: no request, no line — the old page is untouched.
   5. The absences: an absent series prints its reason where the line would
      be; an answer without the series says the line did not load; with no
      start time #online-time's Late tile keeps its own reason and no line.
   Synthetic data only: mockapi.mjs, whose /api/history uses the route's own
   registry and window rule. ONLY=online-time,deposits,absences narrows a run
   (section 0 always runs). */
import { sparkOf, sparkNote, sparkFields, lineFor, gapReasons, shiftDay, mondayOf, historyFailed } from '../api/public/history.js';
import { withheldSentence } from '../api/public/access_model.js';
import { harness } from './arkiv_pages.mjs';

const { check, start, open, done } = harness('Hero sparklines from /api/history');

/* ══ 0 · history.js ═════════════════════════════════════════════════════ */
console.log('\n0 · history.js, in Node');
{
  const S = (pts, extra = {}) => ({ label: 'Late', grain: 'day', basis: 'B.', absent: null,
    points: pts.map((v, i) => ({ d: shiftDay('2026-10-01', i), v, why: v == null ? (i === pts.length - 1 ? 'today' : 'not collected') : null })), ...extra });
  const s = S([3, 4, null, 5, 6, null]);
  check('a series becomes the tile\'s array, every null kept in place as a gap',
    JSON.stringify(sparkOf(s)) === '[3,4,null,5,6,null]');
  check('an absent series is the endpoint\'s own sentence, led by what is missing',
    sparkOf({ grain: 'week', absent: 'the cash-fare roll-up has not been built yet' })
      === 'No weekly line. The cash-fare roll-up has not been built yet.');
  check('one measured point is not a line: it says so, with the rest\'s reason',
    sparkOf(S([null, 7, null])) === 'No daily line. Only one day in this span is measured, and a line needs two — the rest: not collected.',
    sparkOf(S([null, 7, null])));
  check('none measured: the most common reason, as a sentence', sparkOf(S([null, null, null])) === 'No daily line. Not collected.',
    sparkOf(S([null, null, null])));
  check('a failed request says the line did not load and the figure is unaffected',
    /did not load for this tile just now — the figure above is unaffected/.test(sparkOf(null, { failed: true })));
  check('…and nothing at all when nothing was asked', sparkOf(null) === null && JSON.stringify(sparkFields(null)) === '{}');
  check('lineFor: an answer without the series is a failure, never a silent blank',
    /did not load/.test(lineFor({ series: {} }, 'late').spark) && /did not load/.test(lineFor({ failed: true }, 'late').spark));
  const note = sparkNote(s);
  check('the caption: label, span, how much is drawn, why the rest is not, and the basis',
    note === 'Late, each day, 1 Oct to 6 Oct — 4 of 6 drawn. Not drawn — 1 day: not collected; 1 day: today. B.', note);
  check('gap reasons are counted, most common first',
    JSON.stringify(gapReasons(S([null, null, 1, 2, null]))) === '[{"why":"not collected","count":2},{"why":"today","count":1}]',
    JSON.stringify(gapReasons(S([null, null, 1, 2, null]))));
  check('a line comes with its caption; a reason does not need one',
    !!sparkFields(s).sparkTitle && !sparkFields({ grain: 'day', absent: 'x' }).sparkTitle);
  check('calendar arithmetic is noon-anchored and lands on the right days',
    shiftDay('2026-03-31', 1) === '2026-04-01' && shiftDay('2026-01-01', -1) === '2025-12-31'
      && mondayOf('2026-11-12') === '2026-11-09' && mondayOf('2026-11-09') === '2026-11-09' && mondayOf('2026-11-15') === '2026-11-09');
  /* WITHHELD IS NOT UNMEASURED, AND NOT "DID NOT LOAD" (review of SPK,
     2026-11-12). The gate nulls a class's values and names it in
     `_withheld`, or refuses the request outright (a WithheldError). Read as
     data, the first drew gaps captioned by whatever real gap was left, and
     the second said the history did not load. */
  const held = { ...s, class: 'COND', points: s.points.map((p) => ({ ...p, v: null })) };
  const heldLine = lineFor({ series: { late: held }, _withheld: { COND: '' } }, 'late').spark;
  check('values the gate withheld: its own sentence for the class, not the gaps\' reasons',
    heldLine === `No daily line. ${withheldSentence('COND', { level: '' })}`, heldLine);
  check('…and at the totals-only level, its sentence for that',
    lineFor({ series: { late: held }, _withheld: { COND: 'A' } }, 'late').spark === `No daily line. ${withheldSentence('COND', { level: 'A' })}`);
  check('a class withheld elsewhere in the answer leaves this line alone',
    Array.isArray(lineFor({ series: { late: { ...s, class: 'COND' } }, _withheld: { BK: '' } }, 'late').spark));
  const refusal = Object.assign(new Error('That fleet is outside your access.'), { name: 'WithheldError' });
  check('a request the gate refused: the refusal\'s own words, never "did not load"',
    lineFor(historyFailed(refusal), 'late').spark === 'No line. That fleet is outside your access.', lineFor(historyFailed(refusal), 'late').spark);
  check('…while any other failure still says the line did not load',
    /did not load for this tile just now/.test(lineFor(historyFailed(new Error('500')), 'late').spark || ''));
}

await start();
const lastMon = mondayOf(shiftDay(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date()), -7));
const PAGES = [
  { hash: 'online-time', tiles: [['Late', 'late']], hero: 'Late', primary: '/api/online-time' },
  { hash: `performer/drv-0/${lastMon}`, tiles: [['Money', 'money']], hero: 'Money', primary: '/api/economics/drivers' },
  { hash: 'deposits', tiles: [['Ceiling on cash outstanding', 'cash_ceiling'], ['Drivers carrying a ceiling', 'cash_carriers']],
    hero: 'Ceiling on cash outstanding', primary: '/api/ledger/entries' },
  { hash: 'cancellations', tiles: [['Cancellations', 'cancelled']], hero: 'Dropped a job', primary: '/api/cancellations' },
];
const perDraw = (answers, primary) => {
  const h = answers.filter((a) => a.path === '/api/history').length;
  const p = answers.filter((a) => a.path === primary).length;
  return { ok: h >= 1 && h === p, h, p };
};
/* Stretches of two or more readings: what spark() draws as a run. */
const runsOf = (vs) => {
  let runs = 0, len = 0;
  for (const v of [...vs, null]) { if (v == null) { if (len >= 2) runs++; len = 0; } else len++; }
  return runs;
};
const lineOf = (page, label) => page.evaluate((l) => {
  const t = [...document.querySelectorAll('#view .kpis.glance > .kpi')]
    .find((k) => k.querySelector('.t-l')?.textContent.trim() === l);
  if (!t) return null;
  const s = t.querySelector('.t-s');
  const line = s?.querySelector('svg.tspark > path:not(.sp-end)');
  const end = s?.querySelector('svg.tspark > path.sp-end');
  return { hero: t.classList.contains('is-hero'), has: !!line, na: s?.classList.contains('t-s-na') ? s.textContent.trim() : null,
    d: line?.getAttribute('d') || '', end: end?.getAttribute('d') || null, circle: !!s?.querySelector('circle'),
    endCap: end ? getComputedStyle(end).strokeLinecap : null, title: s?.getAttribute('title') || '',
    stroke: line ? getComputedStyle(line).stroke : null, aria: s?.getAttribute('aria-label') || '' };
}, label);

const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);
for (const P of PAGES) {
  const key = P.hash.split('/')[0];
  if (!want(key)) continue;
  console.log(`\n#${key}`);
  {
    const { ctx, page, answers, answer } = await open('arkiv', P.hash, { width: 1280 });
    const n = perDraw(answers, P.primary);
    check(`1280: one request to /api/history per draw (as many as to ${P.primary})`, n.ok, JSON.stringify(n));
    const h = answer('/api/history');
    for (const [label, metric] of P.tiles) {
      const L = await lineOf(page, label);
      const vs = (h?.series?.[metric]?.points || []).map((p) => p.v);
      const want = runsOf(vs);
      check(`"${label}": a line, drawn from the answer — ${want} run(s), a null a break and never a zero`,
        L?.has && (L.d.match(/M/g) || []).length === want, JSON.stringify({ d: L?.d?.slice(0, 80), want, vs }));
      const lastI = vs.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0).pop();
      const x = ((lastI / (vs.length - 1)) * 100).toFixed(2);
      check(`"${label}": the end mark sits on the last measured point (x ${x}), so a trailing gap stays a gap`,
        L?.end?.startsWith(`M${x} `), JSON.stringify([L?.end, x]));
      check(`"${label}": the end mark is round at any stretch — a capped stroke, not a stretched circle`,
        L?.endCap === 'round' && !L.circle, JSON.stringify([L?.endCap, L?.circle]));
      check(`"${label}": the caption says the span and how much of it is drawn, for a pointer and a screen reader`,
        /each (day|week), .+ — \d+ of \d+ drawn\./.test(L?.title || '') && L.aria === L.title, L?.title);
    }
    const hero = await page.evaluate(() => document.querySelector('#view .kpis.glance > .kpi.is-hero .t-l')?.textContent.trim());
    check(`the hero is still "${P.hero}"`, hero === P.hero, hero);
    await ctx.close();
  }
  {
    const { ctx, page, answers } = await open('arkiv', P.hash, { width: 390 });
    const L = await lineOf(page, P.tiles[0][0]);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const n = perDraw(answers, P.primary);
    check('390: the line is drawn, one request per draw, nothing goes sideways',
      L?.has && n.ok && sideways <= 0, JSON.stringify([L?.has, n, sideways]));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', P.hash, { width: 1280, scheme: 'dark' });
    const L = await lineOf(page, P.tiles[0][0]);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lum = (c) => { const m = String(c).match(/[\d.]+/g) || []; return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; };
    check('dark: the line is a light ink on the dark page, not the page\'s own colour',
      L?.has && L.stroke !== bg && lum(L.stroke) - lum(bg) > 0.5, JSON.stringify([L?.stroke, bg]));
    await ctx.close();
  }
  {
    const { ctx, page, answers } = await open('classic', P.hash, { width: 1280 });
    const lines = await page.evaluate(() => document.querySelectorAll('#view .tspark').length);
    check('classic: no request to /api/history and no line — the old page is untouched',
      answers.filter((a) => a.path === '/api/history').length === 0 && lines === 0, JSON.stringify([lines]));
    await ctx.close();
  }
}

if (want('absences')) console.log('\nthe absences');
if (want('absences')) {
  const why = 'the cash-fare roll-up has not been built yet — the collector builds it after each collection run, and in full at boot and every night';
  const { ctx, page } = await open('arkiv', 'deposits', { fixtures: { '/api/history': (_, real) => ({ ...real,
    series: Object.fromEntries(Object.entries(real.series).map(([k, s]) => [k, { ...s, absent: why, points: [], measured: 0, of: 0 }])) }) } });
  const L = await lineOf(page, 'Ceiling on cash outstanding');
  check('an absent series: its reason printed where the line would be, no line drawn',
    !L?.has && L?.na === `No weekly line. ${why[0].toUpperCase()}${why.slice(1)}.`, JSON.stringify(L));
  await ctx.close();
}
if (want('absences')) {
  const { ctx, page } = await open('arkiv', 'cancellations', { fixtures: { '/api/history': {} } });
  const L = await lineOf(page, 'Cancellations');
  check('an answer without the series: "did not load", and the figure above is unaffected — never a silent blank',
    !L?.has && /did not load for this tile just now — the figure above is unaffected/.test(L?.na || ''), JSON.stringify(L));
  const v = await page.evaluate(() => [...document.querySelectorAll('#view .kpis.glance > .kpi')]
    .find((k) => k.querySelector('.t-l')?.textContent.trim() === 'Cancellations')?.querySelector('.t-v')?.textContent.trim());
  check('…and the figure is there', /\d/.test(v || ''), v);
  await ctx.close();
}
if (want('absences')) {
  /* The Cash desk's view of its own page, as the gate would shape it for a
     role without CASH: the values nulled and the class named. The tile says
     so in the gate's words — not "no week is measured", not "did not load". */
  const { ctx, page } = await open('arkiv', 'deposits', { fixtures: { '/api/history': (_, real) => ({ ...real, _withheld: { CASH: '' },
    series: Object.fromEntries(Object.entries(real.series).map(([k, s]) => [k, { ...s, points: s.points.map((p) => ({ ...p, v: null })) }])) }) } });
  const L = await lineOf(page, 'Ceiling on cash outstanding');
  check('values the gate withheld: the tile says so in the gate\'s words, and draws no line',
    !L?.has && L?.na === `No weekly line. ${withheldSentence('CASH', { level: '' })}`, JSON.stringify(L));
  await ctx.close();
}
if (want('absences')) {
  /* history.js loads on #online-time's first draw (onlinetime.js); served
     here as something that is not a module, the import fails. The figures
     must still be drawn — the line is decoration — and Late must say its
     line did not load, rather than the page sitting on its skeleton. */
  const { ctx, page } = await open('arkiv', 'online-time', { fixtures: { '/history.js': { not: 'a module' } } });
  const L = await lineOf(page, 'Late');
  const v = await page.evaluate(() => [...document.querySelectorAll('#view .kpis.glance > .kpi')]
    .find((k) => k.querySelector('.t-l')?.textContent.trim() === 'Late')?.querySelector('.t-v')?.textContent.trim());
  check('history.js failing to load: the tiles still draw, and Late says its line did not load',
    /\d/.test(v || '') && !L?.has && /did not load for this tile just now/.test(L?.na || ''), JSON.stringify([v, L]));
  await ctx.close();
}
if (want('absences')) {
  /* The control falls back to 06:00 when emptied (onlinetime.js), so the one
     way a reader reaches "no start to judge against" is a stored start the
     page cannot read — which is what this stores, then reloads. */
  const { ctx, page, answers } = await open('arkiv', 'online-time');
  await page.evaluate(() => localStorage.setItem('online-time:start', 'half seven'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('#nav a', { state: 'attached' });
  await page.waitForTimeout(2500);
  const L = await lineOf(page, 'Late');
  const na = await page.evaluate(() => [...document.querySelectorAll('#view .kpis.glance > .kpi')]
    .find((k) => k.querySelector('.t-l')?.textContent.trim() === 'Late')?.querySelector('.t-v')?.textContent.trim());
  check('a start the page cannot read: Late keeps its own reason, and carries no line under it',
    !L?.has && !L?.na && /not a time this page can read/.test(na || ''), JSON.stringify([na, L]));
  const last = answers.filter((a) => a.path === '/api/history').pop();
  check('…and the history was asked with that start, and answered absent in the same words',
    last?.query.start === 'half seven' && /not a time this page can read/.test(last?.body?.series?.late?.absent || ''),
    JSON.stringify(last?.query));
  await ctx.close();
}
await done();
