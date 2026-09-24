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

/* ══ #payouts ═════════════════════════════════════════════════════════════ */
if (want('payouts')) {
  console.log('\n#payouts');
  const HEADS = ['At a glance', 'Every Uber transfer, and our own figure beside it', 'The difference, per transfer',
    'Each wire against our own figure', 'What we have not asked Uber about', 'Uber, by month', 'Bolt, by month',
    'Every transfer, by the date it arrived', 'Every transfer date, by channel',
    'What each platform publishes about its own transfers', 'The provider’s own books, day by day', '† What this page does not know'];
  let classic = {};
  let classicApi = [];
  {
    const { ctx, page, answers } = await open('classic', 'payouts');
    classic = await rowTiles(page, '#view .kpis .kpi');
    classicApi = [...new Set(answers.map((a) => a.path))].sort();
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      order: [...document.querySelectorAll('#view .panel > h3')].some((h) => h.textContent.trim() === 'The same transfers, in order') }));
    check('old skin: the old page — no 00 band, its four tiles, the all-channel chart', !r.band && Object.keys(classic).length === 4 && r.order,
      JSON.stringify({ ...r, tiles: Object.keys(classic) }));
    await ctx.close();
  }
  {
    const { ctx, page, answer, answers } = await open('arkiv', 'payouts');
    const s = await shape(page);
    const D = answer('/api/finance/payouts'), R = answer('/api/finance/payouts/reconcile');
    const amt = (v) => Math.abs(+v || 0);
    const total = D.payouts.reduce((a, r) => a + amt(r.amount), 0);
    check('no fetch the old page does not make (the review: every tile reads the two payloads already loaded)',
      JSON.stringify([...new Set(answers.map((a) => a.path))].sort()) === JSON.stringify(classicApi), JSON.stringify(classicApi));
    check('the section order is the plan\'s, with per-date bars for each channel kept (the review\'s correction)',
      JSON.stringify(s.heads) === JSON.stringify(HEADS), JSON.stringify(s.heads));
    check('Transferred to the bank is the hero, the register\'s sum, the old figure',
      s.hero === 'Transferred to the bank' && s.values['Transferred to the bank'] === aed(total)
      && s.values['Transferred to the bank'] === classic['Transferred to the bank'], JSON.stringify(s.values));
    const byCh = new Map();
    D.payouts.forEach((r) => byCh.set(r.platform, (byCh.get(r.platform) || 0) + amt(r.amount)));
    const sub = s.subs['Transferred to the bank'];
    check('…its sub splits it per channel, and keeps the weekday finding and where the record starts',
      [...byCh.values()].every((v) => sub.includes(aed(v))) && /the record starts/.test(sub)
      && (new Set(D.payouts.map((r) => new Date(`${String(r.paid_on).slice(0, 10)}T12:00:00Z`).getUTCDay())).size !== 1
        || /every one of them a/.test(sub)), sub);
    const T = R.totals;
    check('Can be checked against ours is the reconciliation\'s comparable rows of its rows',
      s.values['Can be checked against ours'] === `${T.comparable_rows} of ${T.rows}`, s.values['Can be checked against ours']);
    check('The difference over those is the signed total difference', s.values['The difference over those']
      === `${+T.delta > 0 ? '+' : +T.delta < 0 ? '−' : ''}${aed(Math.abs(+T.delta))}`, s.values['The difference over those']);
    const cmp = R.rows.filter((r) => r.delta != null).sort((a, b) => (a.paid_on < b.paid_on ? 1 : -1));
    check('The latest wire is the newest comparable transfer', s.values['The latest wire'] === aed(Math.abs(+cmp[0].wire)), s.values['The latest wire']);
    const silent = D.coverage.filter((c) => !c.publishes_payouts);
    const silentLabel = Object.keys(s.na).find((l) => /no transfer published/.test(l));
    check('a channel that publishes no transfer is an ABSENT tile with the provider\'s own reason (not an amber "2 of 3")',
      silent.length ? !!silentLabel && s.na[silentLabel] === String(silent[0].absent).split(/(?<=\.)\s/)[0] : !silentLabel, JSON.stringify(s.na));
    check('no tile wears a tone', (await toned(page)).length === 0, JSON.stringify(await toned(page)));
    const pills = await page.evaluate(() => [...document.querySelectorAll('#view .pill.ok, #view .pill.warn, #view .pill.bad')]
      .filter((p) => !p.closest('[data-panel="payout-reconcile"]')).map((p) => p.textContent.trim()));
    check('the basis, ledger and publishes pills are neutral chips', pills.length === 0, JSON.stringify(pills));
    const dates = await page.evaluate(() => {
      const p = [...document.querySelectorAll('#view .panel')].find((x) => x.querySelector('h3')?.textContent.trim() === 'Every transfer date, by channel');
      return p ? { charts: p.querySelectorAll('.chartscroll svg').length, phone: !!p.querySelector('.cap.phone-only') } : null;
    });
    check('every channel keeps its own per-date bars inside .chartscroll, with the phone-only caption',
      dates && dates.charts === byCh.size && dates.phone, JSON.stringify(dates));
    const diffs = await page.evaluate(() => [...document.querySelectorAll('[data-panel="payout-diff"] .hb .v')].map((v) => v.textContent.trim()));
    const wantD = R.rows.filter((r) => r.delta != null).sort((a, b) => (a.paid_on < b.paid_on ? 1 : -1)).slice(0, 20)
      .map((r) => `${+r.delta < 0 ? '−' : ''}${aed(Math.abs(+r.delta))}`);
    check('02: one bar per comparable transfer, newest first, each the signed difference (one sign, never "−+")',
      JSON.stringify(diffs) === JSON.stringify(wantD), JSON.stringify([diffs, wantD]));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    const unasked = (R.unchecked || []).reduce((a, u) => a + (+u.count || 0), 0);
    check('† the transfers we can check, and the days Uber was never asked about, from the reconciliation',
      ab['Transfers we can check']?.fig === `${T.comparable_rows} of ${T.rows}` && ab['Days Uber was never asked about']?.fig === String(unasked),
      JSON.stringify([ab['Transfers we can check'], ab['Days Uber was never asked about']]));
    await ctx.close();
  }
  {
    /* Nothing can be compared: the two tiles built on the comparison say why. */
    const none = (_q, real) => ({ ...real, totals: { ...real.totals, comparable_rows: 0, delta: null },
      rows: real.rows.map((r) => ({ ...r, delta: null, delta_pct: null })) });
    const { ctx, page } = await open('arkiv', 'payouts', { fixtures: { '/api/finance/payouts/reconcile': none } });
    const s = await shape(page);
    check('nothing comparable: the difference and the latest wire are ABSENT with that reason, never AED 0.00',
      /no transfer names a period we hold driver-day rows for/.test(s.na['The difference over those'] || '')
      && /no transfer can be checked against our own figure yet/.test(s.na['The latest wire'] || ''), JSON.stringify(s.na));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'payouts', { width: 390 });
    check('at 390 nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #reconcile and #reconcile/<month> ═══════════════════════════════════ */
if (want('reconcile')) {
  console.log('\n#reconcile');
  const HEADS = ['At a glance', 'What the statement expects, and what the bank paid, month by month', 'Is the gap closing?',
    'What the expectation is built from', 'Every month on record', 'Month by month', 'What each statement said',
    '† What this page does not know'];
  const ML = (m) => { const [y, mm] = String(m).split('-'); return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mm - 1]} ${y}`; };
  const pct1 = (v) => `${Math.abs(v).toFixed(1)}%`;
  let classic = {};
  {
    const { ctx, page } = await open('classic', 'reconcile');
    classic = await rowTiles(page, '#view .kpis .kpi');
    const band = await page.$('#view .cband');
    check('old skin: the old page — no 00 band, its five tiles with the Gap', !band && Object.keys(classic).length === 5 && 'Gap' in classic,
      JSON.stringify(Object.keys(classic)));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'reconcile');
    const s = await shape(page);
    const D = answer('/api/reconcile'), t = D.totals;
    check('the section order is the plan\'s: 00, expected against paid, the trend | what it is built from, every month, the two tables, †',
      JSON.stringify(s.heads) === JSON.stringify(HEADS), JSON.stringify(s.heads));
    check('the verdict (headlineVerdict, unchanged) is 00\'s statement', s.vdctIn00);
    const line = await page.evaluate(() => { const l = document.querySelector('#view .cband .rc-gapline');
      return l ? { txt: l.textContent.replace(/\s+/g, ' ').trim(), pill: l.querySelector('.pill')?.className || '' } : null; });
    check('the gap\'s judgement opens the band through deltaPill (the review: the salik floor and the partial/cut rules carried)',
      line && /Bank paid over statement/.test(line.txt) && /\bpill\b/.test(line.pill)
      && line.txt.includes(aed(t.bank_covered)) && line.txt.includes(aed(t.expected_covered)), JSON.stringify(line));
    check('no tile repeats the verdict\'s figure (ruling 7: bank over statement is the verdict\'s)',
      !Object.values(s.values).includes(aed(t.delta)), JSON.stringify(s.values));
    /* Comparable by the endpoint's rule, not by "has a delta". */
    const cmp = D.rows.filter((r) => r.delta != null && r.delta_pct != null && !r.statement_partial && !r.period_cut);
    const last = cmp[cmp.length - 1], prev = cmp[cmp.length - 2];
    check('the mock holds a month with a delta that the endpoint leaves out (so the rule below is exercised)',
      D.rows.some((r) => r.delta != null && (r.statement_partial || r.period_cut)));
    const heroL = `The gap in ${ML(last.m)}`;
    check('the hero is the gap in the latest comparable month, signed, from the rows',
      s.hero === heroL && s.values[heroL] === `${last.delta_pct > 0 ? '+' : last.delta_pct < 0 ? '−' : ''}${pct1(last.delta_pct)}`, JSON.stringify([s.hero, s.values]));
    const dl = (await deltaOf(page, heroL)) || "";
    const move = Math.abs(last.delta_pct) - Math.abs(prev.delta_pct);
    check('…its change is in points against the month before, and a narrowing gap reads as better',
      dl.includes(`${move < 0 ? '−' : '+'}${Math.abs(move).toFixed(1)}`) && dl.includes(`against ${ML(prev.m)}`)
      && (move < 0 ? /better/.test(dl) : /worse/.test(dl)), dl);
    const bl = `Bank paid in ${ML(last.m)}`;
    check('Bank paid in the latest month is its bank side, its change in words and never toned',
      s.values[bl] === aed(last.bank_covered) && /neither better nor worse/.test(s.subs[bl]) && !(await deltaOf(page, bl)), JSON.stringify([s.values[bl], s.subs[bl]]));
    check('Compared over and Trips carry the old page\'s figures', s.values['Compared over'] === classic['Compared over'] && s.values.Trips === classic.Trips,
      JSON.stringify([s.values, classic]));
    check('no tile wears a tone', (await toned(page)).length === 0, JSON.stringify(await toned(page)));
    const cap1 = await txtOf(page, '[data-panel="recon-pair"]');
    check('Expected payout and Bank payout are not dropped: both totals and their coverage are 01\'s caption line',
      cap1.includes(`Expected payout ${aed(t.expected_payout)}`) && cap1.includes(`bank payout ${aed(t.bank_payout)}`), cap1.slice(-400));
    const trend = await page.evaluate(() => document.querySelectorAll('[data-panel="recon-trend"] .hb').length);
    check('02: one bar per comparable month', trend === cmp.length, `${trend} vs ${cmp.length}`);
    const all = await page.evaluate(() => [...document.querySelectorAll('[data-panel="recon-all"] svg [data-rise]')].map((m) => m.getAttribute('fill') || ''));
    const drawn = D.rows.filter((r) => r.bank_payout != null);
    check('04: every month with a money row drawn, a month the window cuts hatched and only those',
      all.length === drawn.length && all.every((f, i) => /^url\(/.test(f) === !!drawn[i].period_cut), JSON.stringify({ all: all.length, drawn: drawn.length }));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    const noCmp = D.rows.filter((r) => r.delta == null).length;
    check('† months that cannot be compared are counted from the rows', ab['Months that cannot be compared']?.fig === `${noCmp} of ${D.rows.length}`,
      JSON.stringify(ab['Months that cannot be compared']));
    check('† the statement horizon is the endpoint\'s own, not a hard-coded one',
      ab['The statement horizon']?.fig === `${D.statement_horizon.days} days` && ab['The statement horizon'].why.includes('Nothing before'), JSON.stringify(ab['The statement horizon']));
    check('the timing note is kept word for word', /A gap between bank and expected is usually timing, not theft/.test(await txtOf(page, '#view')));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'reconcile/2026-08');
    const s = await shape(page);
    const D = answer('/api/reconcile');
    check('#reconcile/<month>: 00, chart 01 at day grain, the day table and the statements unchanged, † — no month charts',
      JSON.stringify(s.heads) === JSON.stringify(['At a glance', 'What the statement expects, and what the bank paid, day by day',
        'Aug 2026, day by day', 'What each statement said', '† What this page does not know']), JSON.stringify(s.heads));
    check('…its tiles name days as days, not ISO keys', !Object.keys(s.values).some((l) => /\d{4}-\d{2}-\d{2}/.test(l)), JSON.stringify(Object.keys(s.values)));
    const runs = (() => { let e = 0; const same = (a, b) => a != null && b != null && +a === +b;
      for (let i = 1; i < D.rows.length; i++) if (same(D.rows[i].expected_payout, D.rows[i - 1].expected_payout) || same(D.rows[i].bank_payout, D.rows[i - 1].bank_payout)) e++; return e; })();
    const cap = await txtOf(page, '[data-panel="recon-pair"]');
    check('…and where a weekly report is spread across its days, 01 says plateaus are the grain (captioned, not hatched)',
      runs ? /Plateaus are the grain/.test(cap) : !/Plateaus/.test(cap), `${runs} ${cap.slice(-200)}`);
    await ctx.close();
  }
  {
    const none = (_q, real) => ({ ...real, rows: real.rows.map((r) => ({ ...r, delta: null, delta_pct: null })),
      totals: { ...real.totals, delta: null, reconciled_rows: 0, matched_pairs: 0 } });
    const { ctx, page } = await open('arkiv', 'reconcile', { fixtures: { '/api/reconcile': none } });
    const s = await shape(page);
    check('nothing comparable: the gap, the bank side and Compared over are ABSENT with that reason, never a nought',
      /no month here has both sides describing the same driver-days/.test(s.na['The gap'] || '')
      && /no month here can be compared/.test(s.na['Bank paid'] || '') && /no driver-day is described by both sides/.test(s.na['Compared over'] || ''),
      JSON.stringify(s.na));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'reconcile', { width: 390 });
    check('at 390 nothing scrolls sideways', (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

/* ══ #settlement, #settlement/cash, #settlement/receivables ══════════════ */
if (want('settlement')) {
  console.log('\n#settlement');
  let classic = {};
  {
    const { ctx, page } = await open('classic', 'settlement');
    classic = await rowTiles(page, '#view .kpis .kpi');
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'),
      toned: document.querySelectorAll('#view .cards .card.t-good, #view .cards .card.t-warn').length }));
    check('old skin: the old page — no 00 band, the route tile first, toned class cards',
      !r.band && Object.keys(classic)[0] === 'Bookings with a settlement route' && r.toned > 0, JSON.stringify({ ...r, tiles: Object.keys(classic) }));
    await ctx.close();
  }
  {
    const { ctx, page, answer } = await open('arkiv', 'settlement');
    const s = await shape(page);
    const M = answer('/api/settlement/mix');
    const total = M.classes.reduce((a, c) => a + c.trips, 0);
    check('mix: 00, the ranked bars, † — the tab bar kept above it', JSON.stringify(s.heads) === JSON.stringify(['At a glance',
      'Every booking, by how it was paid', '† What this page does not know']) && /tabs/.test(s.first), JSON.stringify([s.first, s.heads]));
    check('…the verdict is 00\'s statement, and "still to collect" is not repeated as a tile (ruling 7)', s.vdctIn00
      && !s.labels.some((l) => /still to collect/i.test(l)), JSON.stringify(s.labels));
    const line = await txtOf(page, '#view .cband > p.cap');
    check('…the route count folds into the band\'s opening line', line.startsWith(`${total.toLocaleString('en-US')} bookings with a settlement route`), line);
    check('…the other tiles are the old ones with the old figures, Settled at the ride leading',
      s.hero === 'Settled at the ride' && s.labels.every((l) => s.values[l] === classic[l]), JSON.stringify([s.values, classic]));
    check('…and none keeps a tone', (await toned(page)).length === 0, JSON.stringify(await toned(page)));
    const bars = await page.evaluate(() => [...document.querySelectorAll('#view .panel .hbars .hb')].map((h) => ({
      k: h.querySelector('.k')?.textContent.trim(), fill: h.querySelector('.fill')?.style.background || '', p: h.querySelector('.hb-p')?.textContent.trim() })));
    const byLabel = Object.fromEntries(M.classes.map((c) => [c.label, c]));
    check('01: one ranked bar per class, card and wallet ink, every other route grey, each with its share',
      bars.length === M.classes.length && bars.every((b, i) => (i === 0 || byLabel[bars[i - 1].k].trips >= byLabel[b.k].trips)
        && (['card', 'wallet'].includes(byLabel[b.k].settlement_class) ? /--ink/.test(b.fill) : /--grey/.test(b.fill))
        && b.p === `${(byLabel[b.k].trips / total * 100).toFixed(1)}%`), JSON.stringify(bars));
    const cards = await page.evaluate(() => [...document.querySelectorAll('#view .cards .card')].map((c) => ({ cls: c.className, href: c.getAttribute('href') })));
    check('the class cards stay, untoned, and keep their links', cards.length === M.classes.length && cards.every((c) => /\bt-flat\b/.test(c.cls))
      && cards.some((c) => c.href?.startsWith('#settlement/cash')), JSON.stringify(cards));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    check('† bookings with no route count the answer\'s unlabelled bookings; "not reported" is not zero',
      ab['Bookings with no route']?.fig === String(M.unlabelled_trips) && /Not zero/.test(ab['Revenue "not reported"']?.fig || ''), JSON.stringify(s.abs.map((a) => a.fig)));
    await ctx.close();
  }
  {
    const noCash = (_q, real) => ({ ...real, classes: real.classes.filter((c) => c.settlement_class !== 'cash') });
    const { ctx, page } = await open('arkiv', 'settlement', { fixtures: { '/api/settlement/mix': noCash } });
    const s = await shape(page);
    check('mix with no cash booking: Paid in cash is a measured 0.0% that says so, never a bare dash',
      s.values['Paid in cash'] === '0.0%' && /no booking in this window was paid in cash/.test(s.subs['Paid in cash']) && !s.bare.length, JSON.stringify([s.values, s.bare]));
    await ctx.close();
  }

  {
    const { ctx, page, answer } = await open('arkiv', 'settlement/cash');
    const s = await shape(page);
    const C = answer('/api/settlement/cash-exposure'), V = answer('/api/revenue'), L = answer('/api/ledger/entries');
    const known = +C.total_cash_value_known || 0;
    const reported = (+V.totals.cash || 0) + (+V.totals.statement_cash || 0);
    check('cash: 00, the two readings, the table, † — in that order', JSON.stringify(s.heads.map((h) => h.replace(/ — .*/, ''))) === JSON.stringify(['At a glance',
      'Two readings of the same cash, driver by driver', 'Who is holding it', '† What this page does not know']), JSON.stringify(s.heads));
    check('…Value we can see is the verdict\'s figure and is not repeated (ruling 7); the platforms\' figure leads',
      !('Value we can see' in s.values) && s.hero === 'Cash the platforms report' && s.values['Cash the platforms report'] === aed(reported), JSON.stringify(s.values));
    const word = reported > known ? 'the larger of the two' : reported < known ? 'the smaller of the two' : 'the same figure';
    check('…and its comparative is computed from the two numbers (the plan\'s finding: it always said "larger")',
      s.subs['Cash the platforms report'].includes(word), s.subs['Cash the platforms report']);
    check('Cash bookings and Drivers holding cash keep the old figures and the cohort link', s.values['Cash bookings'] === C.total_cash_trips.toLocaleString('en-US')
      && s.hrefs['Drivers holding cash']?.startsWith('#cohort/settlement-cash'), JSON.stringify([s.values, s.hrefs]));
    const dots = await page.evaluate(() => document.querySelectorAll('[data-panel="cash-scatter"] svg circle').length);
    const both = C.drivers.filter((r) => r.cash_value != null && r.statement_cash != null).length;
    const sc = await txtOf(page, '[data-panel="cash-scatter"]');
    check('01: one dot per row that carries both readings, and the rows with one are counted', dots === both
      && sc.includes(`${both} of ${C.drivers.length} rows carry both readings`), `${dots} vs ${both}: ${sc.slice(-160)}`);
    const tbl = await page.evaluate(() => [...document.querySelectorAll('#view th')].map((t) => t.textContent.replace(/[↓↑\s]+$/g, '').trim()));
    check('the table keeps its eight columns', ['Driver', 'Cash bookings', 'Value known', 'Coverage', 'Statement cash', 'Channels', 'Vehicles', 'Last cash trip']
      .every((h) => tbl.includes(h)), JSON.stringify(tbl));
    const ab = Object.fromEntries(s.abs.map((a) => [a.label, a]));
    check('† Cash banked is absent, and says what the hand-in record holds from its own answer',
      ab['Cash banked']?.none && ab['Cash banked'].why.includes(`holds ${L.totals.rows} ${L.totals.rows === 1 ? 'entry' : 'entries'}`), JSON.stringify(ab['Cash banked']));
    check('† the supervisor exclusion and the statement filed by name are said', !!ab['Collected by a supervisor'] && !!ab['Statement cash, by name'], JSON.stringify(Object.keys(ab)));
    await ctx.close();
  }
  {
    /* The platforms report LESS than the fares show — production's case. */
    const small = (_q, real) => ({ ...real, totals: { ...real.totals, cash: 1000, statement_cash: 0 } });
    const { ctx, page } = await open('arkiv', 'settlement/cash', { fixtures: { '/api/revenue': small } });
    const s = await shape(page);
    check('cash: a platforms\' figure smaller than the fares is called the smaller of the two',
      /the smaller of the two/.test(s.subs['Cash the platforms report'] || ''), s.subs['Cash the platforms report']);
    await ctx.close();
  }

  {
    const { ctx, page, answer } = await open('arkiv', 'settlement/receivables');
    const s = await shape(page);
    const R = answer('/api/settlement/receivables');
    check('receivables: 00, the ageing bars, the table, †', JSON.stringify(s.heads.map((h) => h.replace(/ — .*/, ''))) === JSON.stringify(['At a glance',
      'How old the unpaid work is', 'Who owes it', '† What this page does not know']), JSON.stringify(s.heads));
    check('Outstanding leads with the answer\'s total', s.hero === 'Outstanding' && s.values.Outstanding === aed(R.total), JSON.stringify(s.values));
    const bars = await page.evaluate(() => [...document.querySelectorAll('[data-panel="recv-ageing"] .hb')].map((h) => [h.querySelector('.k')?.textContent.trim(), h.querySelector('.v')?.textContent.trim()]));
    const wantB = R.ageing.buckets.map((b) => [`${b.label} · ${b.trips} ${b.trips === 1 ? 'booking' : 'bookings'}, ${b.counterparties} ${b.counterparties === 1 ? 'counterparty' : 'counterparties'}`,
      +b.amount ? aed(b.amount) : 'nothing outstanding']);
    check('01: one bar per age, every column of the old table in its label, an empty bucket "nothing outstanding"',
      JSON.stringify(bars) === JSON.stringify(wantB), JSON.stringify([bars, wantB]));
    const nf = s.na['Bookings with no fare'] || s.values['Bookings with no fare'];
    const diff = R.total_trips - R.priced_trips;
    check('Bookings with no fare is the difference when it is one, and ABSENT with the reason when the answer contradicts itself',
      diff >= 0 ? nf === String(diff) : /counts more priced bookings than bookings/.test(nf), `${nf} (${diff})`);
    await ctx.close();
  }
  {
    const fine = (_q, real) => ({ ...real, total_trips: 84, priced_trips: 81 });
    const { ctx, page } = await open('arkiv', 'settlement/receivables', { fixtures: { '/api/settlement/receivables': fine } });
    const s = await shape(page);
    check('receivables: three of 84 unpriced reads 3', s.values['Bookings with no fare'] === '3', JSON.stringify(s.values));
    await ctx.close();
  }
  for (const r of ['settlement', 'settlement/cash', 'settlement/receivables']) {
    const { ctx, page } = await open('arkiv', r, { width: 390 });
    check(`${r} at 390: nothing scrolls sideways`, (await shape(page)).overflowX <= 0);
    await ctx.close();
  }
}

await done();
