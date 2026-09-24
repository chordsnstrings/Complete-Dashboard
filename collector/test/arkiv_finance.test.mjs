/* The page phase, section "Finance" — each page under the contract.
   ═══════════════════════════════════════════════════════════════════════════
   docs/UI-REDESIGN-PLAN.md §4 (Finance), the operator's rulings (§1) and the
   house principle. For every converted page: the contract's shape under the
   skin, its figures against the answer the page itself received, its absences
   with their true reasons, and the old skin still building the old page
   (byte for byte is test/arkiv_classic_frozen.test.mjs's job). ONLY=<page>
   narrows a run (finance, receipts, payouts, reconcile, settlement,
   provenance).

   Synthetic data only: the mock, and fixtures built here. */
import { harness, shape } from './arkiv_pages.mjs';

const { check, start, open, done } = harness('Arkiv page phase — Finance');
await start();
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);

/* money() as the pages print it: two decimals, separators, always. */
const aed = (n) => `${Number(n) < 0 ? '−' : ''}AED ${Math.abs(Number(n)).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const txtOf = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  return n ? n.textContent.replace(/\s+/g, ' ').trim() : '';
}, sel);
const toned = (page) => page.evaluate(() => [...document.querySelectorAll('#view .kpis.glance > .kpi')]
  .filter((t) => /\bt-(good|warn|critical|serious|bad)\b/.test(t.className)).map((t) => t.className));
/* A plain tile row (kpiRow) as label → value, optionally inside one panel. */
const rowTiles = (page, sel) => page.evaluate((s) => Object.fromEntries([...document.querySelectorAll(s)]
  .map((t) => [t.querySelector('.l')?.textContent.replace(/\s+/g, ' ').trim(),
    t.querySelector('.n')?.textContent.replace(/\s+/g, ' ').trim()])), sel);
const deltaOf = (page, label) => page.evaluate((l) => {
  const t = [...document.querySelectorAll('#view .kpis.glance > .kpi')]
    .find((k) => k.querySelector('.l')?.textContent.trim() === l);
  return t ? (t.querySelector('.t-d')?.textContent.replace(/\s+/g, ' ').trim() || '') : null;
}, label);
const dubaiToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());

/* ══ #finance ═════════════════════════════════════════════════════════════ */
if (want('finance')) {
  console.log('\n#finance');
  const HEADS = ['At a glance', 'Money in, day by day', 'Trip value a day', 'Platform payouts a day',
    'How the rider paid', 'What each priced tier earns', 'What makes up a payout', 'Tips by driver',
    'What the operator ledger added', 'What it took out', '† What this page does not know'];
  let classic = {};
  {
    const { ctx, page } = await open('classic', 'finance');
    classic = await rowTiles(page, '#view .kpis .kpi');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      donut: !!document.querySelector('#view svg.donut'), pills: document.querySelectorAll('#view .pill').length }));
    check('old skin: the old page — no 00 band, its eight tiles in one row, the payment ring',
      !r.band && Object.keys(classic).length === 8 && r.donut, JSON.stringify({ ...r, tiles: Object.keys(classic) }));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'finance');
    const s = await shape(page);
    const K = answer('/api/kpis'), F = answer('/api/finance/daily'), L = answer('/api/ledger/entries');
    check('the section order is the plan\'s: 00, money in by day, trip value | payouts, how the rider paid, '
      + 'tiers, the payout, tips, the ledger each way, †', JSON.stringify(s.heads) === JSON.stringify(HEADS), JSON.stringify(s.heads));
    check('00 leads and the verdict is its statement (ruling 7)', s.first === 'cband' && s.vdctIn00, s.first);
    const vfig = await txtOf(page, '#view .cband .vdct .vdct-n, #view .cband .vdct-fig');
    check('no tile repeats the verdict\'s figure (ruling 7)', !Object.values(s.values).includes(vfig) || !vfig, `${vfig} ${JSON.stringify(s.values)}`);
    check('six tiles in one band, Money in the hero with the kpis answer\'s accounted total',
      s.glance === 6 && s.glanceBands === 1 && s.hero === 'Money in' && s.values['Money in'] === aed(K.accounted), JSON.stringify(s.values));
    check('Platform payouts, On-trip revenue and Cash collected carry the old page\'s figures exactly',
      ['Platform payouts', 'On-trip revenue', 'Cash collected — measured portion']
        .every((l) => s.values[l] && s.values[l] === classic[l]), JSON.stringify([s.values, classic]));
    check('Trip value booked is the daily answer\'s fares total, and never called Money in',
      s.values['Trip value booked'] === aed(F.totals.fares) && /never added to Money in/.test(s.subs['Trip value booked']), s.subs['Trip value booked']);
    const derived = F.rows.filter((r) => r.money_derived);
    if (+F.totals.money_derived_part > 0 && (F.open_statement || []).some(Boolean)) {
      check('The open week is the derived part, with the rate and the closed days it was worked out from',
        s.values['The open week'] === aed(F.totals.money_derived_part) && /worked out at [\d.]+% of that week's own fares/.test(s.subs['The open week']),
        `${s.values['The open week']} ${s.subs['The open week']}`);
    }
    check('no tile wears a tone — a level is not better or worse', (await toned(page)).length === 0, JSON.stringify(await toned(page)));
    check('no tile prints a bare dash or nought', s.bare.length === 0, JSON.stringify(s.bare));

    /* The week-on-week change, recomputed from the rows the page was sent. */
    const today = dubaiToday();
    const wow = (key, skip = () => false) => {
      const days = F.rows.filter((r) => r.d < today && !skip(r) && r[key] != null && !r.nothing_recorded);
      if (days.length < 14) return null;
      const sum = (a) => a.reduce((x, r) => x + (+r[key] || 0), 0);
      const now = sum(days.slice(-7)), before = sum(days.slice(-14, -7));
      return before ? ((now - before) / before) * 100 : null;
    };
    const signed = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;
    const dm = await deltaOf(page, 'Money in');
    const wm = wow('money', (r) => r.money_derived);
    check('Money in\'s change is over closed statement days only — the derived open week is left out',
      wm == null ? /not compared/.test(dm) : dm.includes(signed(wm)), `${dm} vs ${wm}`);
    const dp = await deltaOf(page, 'Platform payouts');
    const wp = wow('payout');
    check('Platform payouts\' change is the last seven whole days against the seven before',
      wp == null ? /not compared/.test(dp) : dp.includes(signed(wp)), `${dp} vs ${wp}`);

    /* 01: the open week's days hatched, every filed day solid. */
    const marks = await page.evaluate(() => [...document.querySelectorAll('[data-panel="fin-money"] svg [data-rise]')]
      .map((m) => m.getAttribute('fill') || ''));
    /* A day nothing reported is a HOLE (no bar), never a nought bar. */
    const drawn = F.rows.filter((r) => !r.nothing_recorded);
    const want01 = drawn.map((r, i) => !!r.money_derived || (i === drawn.length - 1 && r.d === today));
    check('01: a bar per reported day (a silent day stays a hole), the open week\'s derived days hatched and every filed day solid',
      marks.length === drawn.length && marks.every((f, i) => /^url\(/.test(f) === want01[i]),
      JSON.stringify({ n: marks.length, rows: drawn.length, derived: derived.length, fills: marks.map((f) => f.slice(0, 8)) }));
    if (derived.length) {
      check('…and the hatch is said in words under the chart', /Hatched bars are the open week/.test(await txtOf(page, '[data-panel="fin-money"]')));
    }
    const pay = await page.evaluate(() => [...document.querySelectorAll('[data-panel="fin-paymix"] .hbars .hb')].map((h) => ({
      k: h.querySelector('.k')?.textContent.trim(), fill: h.querySelector('.fill')?.style.background || '', click: h.hasAttribute('data-click') })));
    const P = answer('/api/mix/detail', (q) => q.by === 'payment');
    const atRide = (k) => /^(Card|Wallet) ·/.test(k);
    check('04: how the rider paid is ranked bars, not a ring — card and wallet in ink, every other route grey',
      s.rings === 0 && pay.length > 1 && pay.every((b) => (atRide(b.k) ? /--ink/.test(b.fill) : /--grey/.test(b.fill))), JSON.stringify(pay));
    check('…each labelled with what it earned, or "no fare reported" where nothing was priced — never a nought',
      pay.every((b) => / · (AED [\d,]+\.\d\d over [\d,]+ priced|no fare reported)$/.test(b.k)) && !pay.some((b) => /AED 0\.00/.test(b.k)), JSON.stringify(pay.map((b) => b.k)));
    check('…and the routes that open a page still do (cash, card, wallet, on account, salary)',
      pay.filter((b) => /^(Cash|Card|Wallet|On account|Salary deduction) ·/.test(b.k)).every((b) => b.click), JSON.stringify(pay));
    check('…over the payment answer\'s every trip', pay.length >= 1 && !!P, '');
    const tierTiles = await rowTiles(page, '[data-panel="fin-tiers"] .kpis .kpi');
    check('05 is headed by Fares, Average fare and Revenue per km — the old tiles, the old figures',
      ['Fares', 'Average fare', 'Revenue per km'].every((l) => tierTiles[l] && tierTiles[l] === classic[l]), JSON.stringify(tierTiles));
    const tipTiles = await rowTiles(page, '[data-panel="fin-tips"] .kpis .kpi');
    check('07 is headed by the fleet\'s Tips tile, the old figure', tipTiles.Tips && tipTiles.Tips === classic.Tips, JSON.stringify(tipTiles));
    const tipPills = await page.evaluate(() => document.querySelectorAll('[data-panel="fin-tips"] .pill').length);
    check('…and a tip rate is a plain figure, not a green/amber/red pill', tipPills === 0, String(tipPills));

    /* †. */
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    check('† Trips that carry a fare: the kpis answer\'s share, with the old note\'s reason',
      ab['Trips that carry a fare']?.fig === `${(+K.priced_pct).toFixed(1)}%`, JSON.stringify(ab['Trips that carry a fare']));
    const rows = L?.totals?.rows ?? 0;
    check('† Money out is absent, and its reason counts the operator ledger from the ledger\'s own answer',
      ab['Money out']?.none && ab['Money out'].why.includes(`holds ${rows} ${rows === 1 ? 'entry' : 'entries'}`)
      && ab['Money out'].why.includes(L.from || L.to ? 'between' : 'over the whole record'), JSON.stringify(ab['Money out']));
    const elsewhere = K.uncounted_payouts != null ? +K.uncounted_payouts : null;
    if (elsewhere != null) {
      check('† Payouts counted elsewhere is the kpis answer\'s uncounted figure', ab['Payouts counted elsewhere']?.fig === (elsewhere ? aed(elsewhere) : 'None'),
        JSON.stringify(ab['Payouts counted elsewhere']));
    }
    check('the colophon names the window and the money in', s.colophon.includes(aed(K.accounted)), s.colophon);
    await ctx.close();
  }
  {
    /* The daily series did not load: the tiles built on it say so, and the
       charts say so — nothing is drawn at nought. */
    const { ctx, page } = await open('arkiv', 'finance', { fixtures: { '/api/finance/daily': null } });
    const s = await shape(page);
    check('no daily series: Trip value booked and The open week are ABSENT with that reason',
      /daily money series did not load/.test(s.na['Trip value booked'] || '') && /daily money series did not load/.test(s.na['The open week'] || ''),
      JSON.stringify(s.na));
    check('…and the two day charts say so rather than drawing nothing', /did not load/.test(await txtOf(page, '[data-panel="fin-tripvalue"]'))
      && /did not load/.test(await txtOf(page, '[data-panel="fin-payouts"]')));
    await ctx.close();
  }
  {
    /* Fewer than fourteen whole days: no change is invented. */
    const short = (_q, real) => ({ ...real, rows: real.rows.slice(-9) });
    const { ctx, page } = await open('arkiv', 'finance', { fixtures: { '/api/finance/daily': short } });
    const d = await deltaOf(page, 'Platform payouts');
    check('under fourteen whole days, the change is not computed and says how many days the window holds',
      /not compared: this window holds \d+ whole days? of it, and a week against a week needs fourteen/.test(d), d);
    await ctx.close();
  }
  {
    /* The ledger answered a named span: the reason names it. */
    const spanned = (_q, real) => ({ ...real, from: '2026-09-01', to: '2026-09-30' });
    const { ctx, page } = await open('arkiv', 'finance', { fixtures: { '/api/ledger/entries': spanned } });
    const ab = (await shape(page)).abs.find((a) => a.label === 'Money out');
    check('† Money out names the span the ledger answered for, from its own from/to',
      /between 2026-09-01 and 2026-09-30/.test(ab?.why || ''), ab?.why);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'finance', { width: 390 });
    const s = await shape(page);
    check('at 390 nothing scrolls sideways', s.overflowX <= 0, String(s.overflowX));
    await ctx.close();
  }
}

/* ══ #receipts ════════════════════════════════════════════════════════════ */
if (want('receipts')) {
  console.log('\n#receipts');
  const HEADS = ['At a glance', 'How many documents claim each day', 'How many of each day’s claims a later filing displaces',
    'What each kind is worth', 'What a later filing displaced, by kind', 'The grain each was filed at', 'Which surface filed them',
    'By month, as the providers booked it', 'Every filing, newest first', '† What this page does not know'];
  let classic = {};
  let classicCols = [];
  {
    const { ctx, page } = await open('classic', 'receipts');
    classic = await rowTiles(page, '#view .kpis .kpi');
    classicCols = await page.evaluate(() => [...document.querySelectorAll('#view table')].pop()
      ?.querySelectorAll('thead th').length || 0);
    const band = await page.$('#view .cband');
    check('old skin: the old page — no 00 band, its four tiles, the nine-column register',
      !band && Object.keys(classic).length === 4 && classicCols === 9, JSON.stringify({ tiles: Object.keys(classic), classicCols }));
    await ctx.close();
  }
  const dayList = (a, b) => { const o = []; for (let t = Date.parse(`${a}T12:00:00Z`), e = Date.parse(`${b}T12:00:00Z`); t <= e; t += 864e5) o.push(new Date(t).toISOString().slice(0, 10)); return o; };
  {
    const { ctx, page, answer } = await open('arkiv', 'receipts');
    const s = await shape(page);
    const R = answer('/api/finance/receipts');
    const rows = R.rows, live = rows.filter((r) => !r.superseded), sup = rows.filter((r) => r.superseded);
    const sum = (rs, k = 'amount') => rs.reduce((a, r) => a + (+r[k] || 0), 0);
    check('the section order is the plan\'s: 00, per day, displaced, by kind, grain | surface, by month, the register, †',
      JSON.stringify(s.heads) === JSON.stringify(HEADS), JSON.stringify(s.heads));
    check('Filings on record is the hero and counts every row the register answered',
      s.hero === 'Filings on record' && s.values['Filings on record'] === String(rows.length), JSON.stringify(s.values));
    check('Credited, net of re-filings is KEPT with the old figure, and says it is not a total across kinds (review correction)',
      s.values['Credited, net of re-filings'] === classic['Credited, net of re-filings']
      && /not a total across kinds/.test(s.subs['Credited, net of re-filings']), JSON.stringify([s.values, classic]));
    check('Set aside as re-filed is the superseded rows plus the overlapped parts of the rest',
      s.values['Set aside as re-filed'] === aed(sum(sup) + sum(live, 'superseded_amount')), s.values['Set aside as re-filed']);
    check('Provider rows inside is the sum of rows_seen', s.values['Provider rows inside'] === sum(rows, 'rows_seen').toLocaleString('en-US'), s.values['Provider rows inside']);
    const days = new Set(rows.filter((r) => r.period_start && r.period_end)
      .flatMap((r) => dayList(String(r.period_start).slice(0, 10), String(r.period_end).slice(0, 10))));
    check('Days claimed is the union of every filing\'s days', s.values['Days claimed'] === days.size.toLocaleString('en-US'), `${s.values['Days claimed']} vs ${days.size}`);
    check('Filed for a single date carries the old figure', s.values['Filed for a single date'] === classic['Filed for a single date'], '');
    check('no tile wears a tone', (await toned(page)).length === 0, JSON.stringify(await toned(page)));
    check('no tile prints a bare dash', s.bare.length === 0, JSON.stringify(s.bare));
    const tags = await page.evaluate(() => [...document.querySelectorAll('[data-panel="rcpt-register"] .tag')].map((t) => t.className));
    check('the register\'s tags are neutral (Superseded a grey outline, never amber; Counted never green)',
      tags.length && tags.every((c) => /^tag( dim)?$/.test(c)), JSON.stringify([...new Set(tags)]));
    const fees = await page.evaluate(() => [...document.querySelectorAll('[data-panel="rcpt-register"] td')]
      .filter((td) => /^−AED/.test(td.textContent.trim())).map((td) => td.innerHTML));
    check('fees are ink with a minus, not red', fees.length > 0 && fees.every((h) => !/critical/.test(h)), JSON.stringify(fees));
    const hasFirst = await page.evaluate(() => [...document.querySelectorAll('[data-panel="rcpt-register"] th')].some((th) => /First seen/.test(th.textContent)));
    const stamps = new Set(rows.map((r) => r.first_seen).filter(Boolean));
    check('with more than one arrival stamp, the First seen column stays', stamps.size > 1 ? hasFirst : !hasFirst, String(stamps.size));
    const kinds = await page.evaluate(() => [...document.querySelectorAll('[data-panel="rcpt-kinds"] .hb')].map((h) => [h.querySelector('.k')?.textContent.trim(), h.querySelector('.v')?.textContent.trim()]));
    const want3 = [...new Set(rows.map((r) => r.kind))].map((k) => [k.replace(/_/g, ' '), aed(sum(live.filter((r) => r.kind === k)))]);
    check('03: one bar per kind, each its own sum after the overlap rule — never one total',
      JSON.stringify(kinds) === JSON.stringify(want3), JSON.stringify([kinds, want3]));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    check('† a total across kinds is absent, and says why', ab['A total across kinds']?.none && /counts money more than once/.test(ab['A total across kinds'].why), JSON.stringify(ab['A total across kinds']));
    await ctx.close();
  }
  {
    /* Every row one stamp — the register's last rebuild (production's case). */
    const oneStamp = (_q, real) => ({ ...real, rows: real.rows.map((r) => ({ ...r, first_seen: '2026-09-23T06:07:00Z', last_seen: '2026-09-23T06:07:00Z' })) });
    const { ctx, page } = await open('arkiv', 'receipts', { fixtures: { '/api/finance/receipts': oneStamp } });
    const s = await shape(page);
    const r = await page.evaluate(() => ({
      th: [...document.querySelectorAll('[data-panel="rcpt-register"] th')].map((t) => t.textContent.trim()),
      cap: [...document.querySelectorAll('[data-panel="rcpt-register"] .cap')].map((c) => c.textContent).join(' ') }));
    check('one stamp on every row: "When each one arrived" is ABSENT with that reason, not the rebuild\'s time',
      /one stamp on all \d+ — it is the last rebuild of the register, not when each document reached us/.test(s.na['When each one arrived'] || ''), JSON.stringify(s.na));
    check('…the First seen column is dropped and the reason printed under the register',
      !r.th.some((t) => /First seen/.test(t)) && /No "first seen" column: all \d+ rows carry one stamp/.test(r.cap), JSON.stringify(r));
    const ab = s.abs.find((a) => a.label === 'When each document arrived');
    check('…and † says the arrival of each document is not held, and is highlighted', ab?.none && s.hl >= 1 && /last rebuild/.test(ab.why), JSON.stringify(ab));
    await ctx.close();
  }
  {
    /* A filing whose period runs past today: its days to come are hatched. */
    const ahead = (_q, real) => {
      const t = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
      return { ...real, rows: real.rows.map((r, i) => (i === 0 ? { ...r, period_end: t, is_daily: false } : r)) };
    };
    const { ctx, page } = await open('arkiv', 'receipts', { fixtures: { '/api/finance/receipts': ahead } });
    const fills = await page.evaluate(() => [...document.querySelectorAll('[data-panel="rcpt-claims"] svg [data-rise]')].map((m) => m.getAttribute('fill') || ''));
    const hatched = fills.filter((f) => /^url\(/.test(f)).length;
    check('01: the days after today that a filing already claims are hatched, and only those',
      hatched >= 3 && hatched <= 4 && /^url\(/.test(fills[fills.length - 1]) && !/^url\(/.test(fills[0]), JSON.stringify({ n: fills.length, hatched }));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'receipts', { width: 390 });
    check('at 390 nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

await done();
