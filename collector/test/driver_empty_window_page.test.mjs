/* A ZERO NOBODY MEASURED, IN A COLUMN OF FIGURES SOMEBODY DID.
   ═══════════════════════════════════════════════════════════════════════════
   THE DEFECT, AS THE OPERATOR MET IT. They opened Muhammad Nadeem Ajmal's
   profile (Uber e3cd308b2b5f48e19877b924b48bbb9d) on "This month" — September
   2026 — and asked what had happened to the page. It rendered as a wall of
   blanks with one loud zero in the middle of it:

     CASH COLLECTED   AED 0    no cash booking in this window

   beside five tiles correctly reading "—". MEASURED on production for that id
   over 2026-09-01..09-16, which is what every fixture below reproduces:

     /api/driver/profile   span.trips 0, span.days_worked 0, span.last_trip null
                           accounts[0] uber, trips 1203, last_trip 2026-03-29
     /api/driver/kpis      trips 0, days_worked 0, bookings 0, priced_trips 0,
                           revenue null, km null, avg_fare null
     /api/driver/mix       {distance:[], product:[], payment:[], status:[],
                            platform:[]}   ← payment is EMPTY
     /api/driver/earnings  components [{payouts 0.00}, {your_earnings 0.00}],
                           2 periods, counted null on both, counted_total 0

   Nothing there is wrong. The person did not work in September; their last trip
   was in March; the read layer returns NULL for what it could not measure. The
   defect is entirely in the rendering, and it is the house principle this
   product exists to uphold: A FIGURE THAT CANNOT BE MEASURED RENDERS ABSENT
   WITH A REASON — never as zero, and never with a reason that is not the true
   one.

   WHAT THIS FILE PINS, and why each one is load-bearing:

     1. a MONEY figure over an empty population is absent, not nought. This is
        the reported defect.
     2. a money figure over a population that EXISTS and settled no cash is
        still AED 0 — because that is a measurement, and turning it into a dash
        would be the same defect facing the other way and harder to see.
     3. a COUNT of nought stays nought. trips 0 for a person who did not work is
        a true count. The fix must not sweep counts up with money.
     4. the reason beside an absence names the WIDER fact when the wider fact is
        what happened. "no cash booking in this window" is true and narrow when
        no booking of ANY kind was in the window.
     5. the page says once, above the tabs, which of the two empty-window cases
        this is — a quiet month, or a person with no work on record at all — and
        says it in two different sentences, because they are two different facts
        about a person.

   Run in a real browser against the shipped modules, for the reason
   test/absent_columns.test.mjs gives: these paths build elements, set innerHTML
   and are reached only through renderDriver's own awaits, so a hand-rolled
   document shim would be testing the shim. The API is stubbed here — every
   fixture is this file's own, shaped from the production payloads quoted above
   — so nothing in this file talks to a database or to production.

   Each assertion was proved by REVERSION rather than by passing; the reversion
   that proves it is written beside it. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── the fixtures ─────────────────────────────────────────────────────────
   Four people, and the difference between them is the whole subject. */
const UBER_ACC = (trips, first, last) => ({ platform: 'uber', driver_ext_id: 'x1', trips,
  first_trip: first, last_trip: last });

const F = {
  /* THE OPERATOR'S DRIVER, exactly as production answers for him — including
     the two 0.00 components Uber really did publish, which are the one honest
     nought on this tab and which the fix must NOT sweep away. */
  quiet: {
    profile: { name: 'Quiet Record', id: 'quiet', platforms: ['uber', 'yango'], ids: ['x1', 'x2'],
      accounts: [UBER_ACC(1203, '2025-10-17T04:00:00Z', '2026-03-29T16:02:28Z')],
      span: { trips: 0, days_worked: 0, vehicles: 0, first_trip: null, last_trip: null },
      compliance: [], standing: [], vehicles: [], identity_withheld: [], identity_held: [],
      banned_on: [], platform_compliance: [] },
    kpis: { trips: 0, days_worked: 0, bookings: 0, priced_trips: 0, outcome_n: 0, revenue: null,
      km: null, avg_fare: null, completion_pct: null, reported_earnings: null, cash_earnings: null,
      cash_bookings: 0, statement_fares: null, priced_km: null, priced_measured_revenue: null,
      statement_platforms: ['uber'] },
    mix: { distance: [], product: [], payment: [], status: [], platform: [] },
    /* THE THIRTEEN DAYS PRODUCTION REALLY RETURNS for this person: a feed
       reached each date and reported nothing on it. trips 0, km null, revenue
       null, first_hour NULL — and `+null` is 0, which is finite, which is how
       thirteen dots ended up plotted along the 00:00 line. */
    daily: Array.from({ length: 13 }, (_, i) => ({
      day: `2026-09-${String(i + 1).padStart(2, '0')}`, trips: 0, cancelled: 0,
      km: null, revenue: null, first_hour: null, last_hour: null, span_h: null,
      hours_online: null, hours_online_basis: null })),
    earnings: { components: [{ category: 'payouts', parent: null, amount: '0.00', currency: 'AED' },
      { category: 'your_earnings', parent: null, amount: '0.00', currency: 'AED' }],
    periods: [
      { platform: 'uber', period_start: '2026-09-01', period_end: '2026-09-07', period_days: 7,
        days_used: 7, trips: null, earnings: '0.00', counted: null, cash_earnings: null },
      { platform: 'uber', period_start: '2026-09-08', period_end: '2026-09-14', period_days: 7,
        days_used: 7, trips: null, earnings: '0.00', counted: null, cash_earnings: null },
    ],
    tips: null, tip_pct: null, statement_days: 0, fare: null, statement_cash: null },
  },
  /* The same empty window with NOTHING measured anywhere — no statement reached
     us at all. Nothing on this tab may render as a money nought. */
  bare: {
    profile: { name: 'Bare Window', id: 'bare', platforms: ['uber'], ids: ['x1'],
      accounts: [UBER_ACC(412, '2025-11-02T04:00:00Z', '2026-04-11T09:10:00Z')],
      span: { trips: 0, days_worked: 0, vehicles: 0, first_trip: null, last_trip: null },
      compliance: [], standing: [], vehicles: [], identity_withheld: [], identity_held: [],
      banned_on: [], platform_compliance: [] },
    kpis: { trips: 0, days_worked: 0, bookings: 0, priced_trips: 0, outcome_n: 0, revenue: null,
      km: null, avg_fare: null, reported_earnings: null, cash_earnings: null, statement_fares: null },
    mix: { distance: [], product: [], payment: [], status: [], platform: [] },
    daily: [],
    earnings: { components: [], periods: [], tips: null, tip_pct: null, statement_days: 0,
      fare: null, statement_cash: null },
  },
  /* NEVER HAD A TRIP AT ALL. Two platform accounts, neither of which has ever
     taken a booking we hold. A different fact from a quiet month, and it has to
     read as a different sentence. */
  never: {
    profile: { name: 'No Record', id: 'never', platforms: ['bolt', 'yango'], ids: ['y1', 'y2'],
      accounts: [],
      span: { trips: 0, days_worked: 0, vehicles: 0, first_trip: null, last_trip: null },
      compliance: [], standing: [], vehicles: [], identity_withheld: [], identity_held: [],
      banned_on: [], platform_compliance: [] },
    kpis: { trips: 0, days_worked: 0, bookings: 0, priced_trips: 0, revenue: null, km: null,
      avg_fare: null, reported_earnings: null, cash_earnings: null, statement_fares: null },
    mix: { distance: [], product: [], payment: [], status: [], platform: [] },
    daily: [],
    earnings: { components: [], periods: [], tips: null, tip_pct: null, statement_days: 0 },
  },
  /* WORKED, AND TOOK NO CASH. 84 bookings, every one of them on a card. AED 0
     is the right answer here and must survive the fix. */
  cardonly: {
    profile: { name: 'Card Only', id: 'cardonly', platforms: ['uber'], ids: ['z1'],
      accounts: [UBER_ACC(1290, '2025-10-17T04:00:00Z', '2026-09-15T18:00:00Z')],
      span: { trips: 84, days_worked: 19, vehicles: 1, first_trip: '2026-09-01T05:00:00Z',
        last_trip: '2026-09-15T18:00:00Z' },
      compliance: [], standing: [], vehicles: [], identity_withheld: [], identity_held: [],
      banned_on: [], platform_compliance: [] },
    kpis: { trips: 84, days_worked: 19, bookings: 84, priced_trips: 84, outcome_n: 84,
      revenue: 12400, km: 980, avg_fare: 147.6, completion_pct: 97, reported_earnings: 9300,
      cash_earnings: null, cash_bookings: 0, statement_fares: null, priced_km: 980,
      priced_measured_revenue: 12400, priced_measured_trips: 84 },
    mix: { distance: [], product: [], status: [], platform: [{ label: 'uber', n: 84 }],
      payment: [{ label: 'card', n: 84, revenue: 12400 }] },
    daily: [{ day: '2026-09-01', trips: 6, km: 70, revenue: 900, first_hour: 7.5, cancelled: 0 }],
    earnings: { components: [{ category: 'your_earnings', parent: null, amount: '9300.00', currency: 'AED' }],
      periods: [{ platform: 'uber', period_start: '2026-09-01', period_end: '2026-09-07',
        period_days: 7, days_used: 7, trips: 40, earnings: '4400.00', counted: '4400.00',
        cash_earnings: null }],
      tips: 120, tip_pct: 1.3, statement_days: 7, fare: 9300, statement_cash: null },
  },
};

const app = express();
/* Route by id, so one static server carries four people. */
const send = (kind) => (req, res) => {
  const f = F[req.query.id];
  if (!f) return res.status(404).json({ error: 'unknown driver' });
  return res.json(f[kind]);
};
app.get('/api/driver/profile', send('profile'));
app.get('/api/driver/kpis', send('kpis'));
app.get('/api/driver/mix', send('mix'));
app.get('/api/driver/daily', send('daily'));
app.get('/api/driver/earnings', send('earnings'));
/* Everything the tab does not read, answered emptily rather than 404'd, so a
   failed request never masquerades as an empty window. */
app.get('/api/status/driver', (req, res) => res.json({ absent: 'not collected in this test' }));
app.get('/api/driver/trips', (req, res) => res.json({ rows: [], total: 0, offset: 0, truncated: false }));
app.get('/api/driver/standing', (req, res) => res.json([]));
app.get('/api/driver/quality', (req, res) => res.json({ cancels: [], alerts: [], cancel_daily: [],
  alert_km: null, fleet_alerts_per_100km: null, alert_coverage: null }));
app.get('/api/driver/heatmap', (req, res) => res.json([]));
app.get('/api/driver/custody', (req, res) => res.json([]));
app.get('/api/driver/shift', (req, res) => res.json([]));
app.get('/api/driver/days', (req, res) => res.json([]));
app.get('/api/driver/unauthorized', (req, res) => res.json({ rows: [], candidates: { rows: [] },
  coverage: { days_with_data: 0 }, tier_means: {} }));
app.use(express.static('api/public'));
const server = app.listen(0);
const port = server.address().port;

const browser = await launchChromium();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

/* Render one driver's one tab through the SHIPPED renderDriver, and read back
   what a person would actually see. */
const render = (id, tab) => page.evaluate(async ([who, t]) => {
  const d = await import('/driver.js');
  const host = document.createElement('div');
  document.body.append(host);
  await d.renderDriver(host, who, t);
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : null);
  return {
    all: host.textContent.replace(/\s+/g, ' ').trim(),
    banner: txt(host.querySelector('.stack > .note')),
    notes: [...host.querySelectorAll('.note')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
    caps: [...host.querySelectorAll('p.cap')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
    tiles: [...host.querySelectorAll('.kpi')].map((k) => ({
      label: txt(k.querySelector('.l')), value: txt(k.querySelector('.n')), sub: txt(k.querySelector('.s')),
    })),
    hbarValues: [...host.querySelectorAll('.hbars .hb .v')].map((v) => v.textContent.trim()),
    /* The statement table, found by a heading it has always had rather than by
       position, so the Counted column can be examined cell by cell. */
    statements: (() => {
      const t = [...host.querySelectorAll('table')].find((x) => [...x.querySelectorAll('thead th')]
        .some((h) => h.textContent.trim() === 'Statement'));
      if (!t) return null;
      const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim());
      const at = heads.indexOf('Counted');
      return { heads,
        counted: at < 0 ? null : [...t.querySelectorAll('tbody tr')]
          .map((tr) => (tr.children[at] ? tr.children[at].textContent.trim() : null)) };
    })(),
    idcard: txt(host.querySelector('.idcard')),
    /* Counted, not inspected: the defect was thirteen circles on a chart, so
       the assertion is about how many circles exist. */
    scatterPoints: host.querySelectorAll('svg circle').length,
  };
}, [id, tab]);

const tile = (r, label) => r.tiles.find((t) => t.label === label);
/* "AED 0" but not "AED 0.00" and not "AED 0,00" — a bare nought in a money
   slot is the defect; a published 0.00 quoted in a sentence is not. The
   lookahead has to allow a SENTENCE-ENDING full stop ("…net to AED 0.") while
   still rejecting a decimal one ("AED 0.00"), which is why it tests for a digit
   after the separator rather than for the separator itself. */
const MONEY_ZERO = /AED\s0(?![.,]?\d)/;

console.log('\nthe reported defect: a money figure over an empty population');

const quiet = await render('quiet', 'earnings');
const bare = await render('bare', 'earnings');

/* REVERSION THAT PROVES THIS: restore
     return v ? money(v) : (cashTrips ? 'not reported' : money(0));
   at api/public/driver.js's Cash collected tile. The value becomes "AED 0" and
   this assertion fails. */
const qc = tile(quiet, 'Cash collected');
check('cash collected on an empty window draws no figure at all',
  qc && qc.value === '—', JSON.stringify(qc));
/* REVERSION: restore `: 'no cash booking in this window'` as the sub. The
   sentence still reads true-but-narrow and this assertion fails. */
check('…and the reason names the WIDER fact, not the narrow one',
  qc && /no booking of any kind in this window/.test(qc.sub), qc && qc.sub);
check('…so it never claims the fleet looked at this person’s bookings',
  qc && !/^no cash booking in this window$/.test(qc.sub), qc && qc.sub);

/* The whole tab, on the fixture where genuinely nothing was measured. This is
   the assertion the brief asks for in as many words: no money figure anywhere
   on the tab is a zero.

   REVERSION: any one of money(0) in the cash tile, `+c.amount || 0` in the
   components chart, or `Number(r.counted ?? r.earnings ?? 0)` in the statement
   total puts an "AED 0" back on this page and fails this. */
check('with nothing measured, no money figure on the tab renders as nought',
  !MONEY_ZERO.test(bare.all), (bare.all.match(/AED[^·.]{0,12}/g) || []).join(' | '));

console.log('\nthe one nought that is honest survives');

/* Uber DID file those two components and every line of them reads 0.00. That is
   a figure the platform published about this window, not a figure nobody took,
   so it must still be reported — as a sentence, because a bar of zero length is
   a component that does not exist.

   REVERSION: restore the unconditional hbars() call over `roots`. Two
   zero-length bars come back, hbarValues gains two "0" entries, and the first
   two assertions below fail. */
const compNote = quiet.notes.find((n) => /top-level component/i.test(n)) || '';
check('two components published at nought are not drawn as two bars',
  quiet.hbarValues.every((v) => v !== '0'), JSON.stringify(quiet.hbarValues));
check('…they are stated, with both amounts, as the platform published them',
  /payouts AED 0\.00/.test(compNote) && /your earnings AED 0\.00/.test(compNote), compNote);
check('…and the sentence says the platform published them',
  /published/.test(compNote), compNote);
/* REVERSION: restore the caption `${countOf(roots.length,…)} netting to
   ${money(net)}` built from `+c.amount || 0`. "netting to AED 0" returns. */
check('nothing on the page claims these components netted to anything',
  !/netting to AED 0(?![.,]?\d)/.test(quiet.all)
  && !/net to AED 0(?![.,]?\d)/.test(quiet.all),
  (quiet.all.match(/net[a-z]* to AED[^.]*\./g) || []).join(' | '));

console.log('\nthe statement total: counted null is not counted nought');

/* Production returns counted: null on BOTH periods. The old reduce was
   `Number(r.counted ?? r.earnings ?? 0)` — two fallbacks, the first silently
   substituting a different measurement and the second turning that into zero —
   and the caption then asserted the two columns AGREED.

   REVERSION: restore that reduce and the single-branch caption. "AED 0 counted
   across 2 statements. None of them overlap, so Statement and Counted agree."
   comes back and both assertions below fail. */
check('no line claims a nought was counted across the statements',
  !/AED 0(?![.,]?\d) counted across/.test(quiet.all),
  (quiet.all.match(/AED[^.]{0,10} counted across[^.]*\./g) || []).join(' | '));
check('…and nothing asserts Statement and Counted agree over two coerced zeros',
  !/Statement and Counted agree/.test(quiet.all),
  quiet.caps.filter((c) => /statement/i.test(c)).join(' | '));
/* REVERSION THAT PROVES THIS: restore `render: (r) => money(r.counted ?? r.earnings)`
   on the Counted column. `counted` is null on both periods and `earnings` is
   "0.00", so every cell comes back reading "AED 0" — the neighbouring column's
   number, under a heading that promises the window-clamped one. */
check('the statement table is on the page at all',
  !!quiet.statements && quiet.statements.heads.includes('Statement'),
  JSON.stringify(quiet.statements && quiet.statements.heads));
check('the Counted column prunes itself rather than borrowing the Statement column',
  quiet.statements && (quiet.statements.counted === null
    || quiet.statements.counted.every((c) => c === '—')),
  JSON.stringify(quiet.statements && quiet.statements.counted));

console.log('\na measurement of nought is still a measurement');

const card = await render('cardonly', 'earnings');
const cc = tile(card, 'Cash collected');
/* THE BRANCH THAT MUST NOT CHANGE. 84 bookings, none of them cash: AED 0 is a
   real measurement of the cash this driver took, and rendering it as an absence
   would be this same defect facing the other way.

   REVERSION: change the fix's `worked ? money(0) : '—'` to a bare `'—'` and
   this driver's genuine nought disappears. */
check('a driver who worked and took no cash still reads AED 0',
  cc && cc.value === 'AED 0', JSON.stringify(cc));
/* THE SENTENCE IS NARROWER THAN THIS ASSERTION FIRST DEMANDED, AND THE NARROWER
   ONE IS RIGHT. This checked for "none of their 84 bookings in this window was
   paid in cash", and driver.js prints "none of the 84 bookings in this window
   WHOSE PAYMENT METHOD WAS RECORDED was paid in cash" — because the 84 is
   `labelledTrips`, the bookings that carry a payment method at all, not every
   booking. Where a channel files a booking with no method, the shorter sentence
   claims the fleet looked at bookings it never saw. So the assertion follows
   the code rather than the code being trimmed to the assertion: it requires the
   population, the count, AND the qualification that makes the count honest. */
check('…with a reason that names the population it was measured over',
  cc && /none of the 84 bookings in this window whose payment method was recorded was paid in cash/
    .test(cc.sub), cc && cc.sub);

console.log('\na count of nought is a true count and stays a count');

/* REVERSION: none needed — this is the guard against over-correcting. If a
   future edit turns the empty window's COUNTS into dashes alongside its money,
   the identity card stops saying how much work is on record and this fails. */
check('the identity card still states 0 trips in this window as a number',
  /In this window 0 trips/.test(quiet.idcard), quiet.idcard);
check('…while still carrying the 1,203 trips that are on record',
  /1,203/.test(quiet.idcard), quiet.idcard);

console.log('\nthe empty window is explained once, above the tabs');

/* REVERSION: delete the `const ew = emptyWindowNote(prof, tab); if (ew) …` pair
   from renderDriver. Every assertion in this block fails and the page goes back
   to nine panels each explaining its own blank. */
check('a driver with no trip in this window gets a standing sentence',
  !!quiet.banner && quiet.banner.length > 60, quiet.banner);
check('…which names the window on the toolbar',
  /This month/.test(quiet.banner || ''), quiet.banner);
check('…and says the work is missing, not the record',
  /not the record of it/.test(quiet.banner || ''), quiet.banner);
/* Locale-agnostic: whatever dateStr renders, the banner and the card have to
   render the SAME string, which is the whole reason both read personRecord().
   REVERSION: derive lastEver inside emptyWindowNote from p.span.last_trip
   instead (null here) and the banner loses the date the card still shows. */
const DATE_29 = /(29 Mar(ch)? 2026|Mar(ch)? 29,? 2026)/;
check('…and dates their last trip from the record, as the card does',
  DATE_29.test(quiet.banner || '') && DATE_29.test(quiet.idcard || ''),
  `${quiet.banner} || CARD: ${quiet.idcard}`);

const never = await render('never', 'earnings');
/* REVERSION: collapse emptyWindowNote's two branches into one sentence. The two
   banners become identical and this fails — which is the point: a quiet month
   and an empty record are different facts about a person. */
check('a driver who has never had a trip gets a DIFFERENT sentence',
  !!never.banner && never.banner !== quiet.banner, never.banner);
check('…which says there is no work on record at all',
  /no work on record at all/.test(never.banner || ''), never.banner);
check('…and does not claim they merely did not work this period',
  !/not the record of it/.test(never.banner || ''), never.banner);
check('a driver who DID work in this window gets no banner at all',
  card.banner == null || !/falls in|ever reported a trip/.test(card.banner), card.banner);

console.log('\nthe banner changes its tail with the tab, and its head never does');

const quietTrips = await render('quiet', 'trips');
check('the same two sentences open the banner on another tab',
  quietTrips.banner && quietTrips.banner.startsWith(quiet.banner.split(' Every figure')[0]),
  quietTrips.banner);
/* REVERSION: drop EMPTY_WINDOW_TAIL from emptyWindowNote. Both tabs print the
   same sentence and the tab-specific half disappears. */
check('…with a tail that belongs to the tab being read',
  /There are no rows/.test(quietTrips.banner || '')
  && /which figures were never measured/.test(quiet.banner || ''),
  quietTrips.banner);

console.log('\nno tone: a man who took six months off is not an incident');

/* REVERSION: pass 'warn' to note() in renderDriver. The banner turns amber and
   the honest answer starts reading as a failure. */
const bannerClass = await page.evaluate(() => {
  const n = document.querySelector('.stack > .note');
  return n ? n.className : null;
});
check('the standing sentence carries no warn tone',
  bannerClass === 'note', bannerClass);

console.log('\nno chart draws a pattern nobody measured');

/* THE WORST OF THE LOT, AND IT IS ON THE TAB THE PAGE OPENS ON.
   startScatter filtered its days with `Number.isFinite(+d.first_hour)`. `+null`
   is 0 and 0 is finite, so all thirteen days that carry NO first trip passed —
   and the Overview tab drew thirteen dots along the 00:00 line, computed a
   quartile band from thirteen zeros, and captioned it "the middle half of start
   times (00:00–00:00). Each dot is one working day", under a DAYS WORKED tile
   reading 0. A fabricated shift pattern is worse than a fabricated figure: it
   is a whole picture of something that did not happen.

   REVERSION THAT PROVES THIS: restore `days.filter((d) =>
   Number.isFinite(+d.first_hour))` in startScatter. Thirteen circles come back
   and both assertions below fail. */
const over = await render('quiet', 'overview');
check('no start-time dot is plotted for a day with no first trip',
  over.scatterPoints === 0, `${over.scatterPoints} dots plotted`);
check('…and the panel says why it is empty instead of drawing a band',
  /no first trip to plot|records the hour of their first trip/.test(over.all),
  (over.all.match(/Nothing to show[^.]*\./g) || []).join(' | '));
check('…while the DAYS WORKED count beside it is still the number 0',
  (tile(over, 'Days worked') || {}).value === '0',
  JSON.stringify(tile(over, 'Days worked')));

/* REVERSION: restore `km: +d.km || 0` and the unconditional barChart in the
   Activity tab's distance panel. The bare axis comes back with no note at all. */
const act = await render('quiet', 'activity');
check('the distance panel says nothing was measured rather than drawing a bare axis',
  /no distance to plot/.test(act.all), (act.notes.join(' | ') || '').slice(0, 300));

console.log('\na sentence that interpolates its own emptiness');

/* driver.js printed, verbatim: "No cancellations on any of the 0 days this
   driver worked in this window." `cd` is the list of days with trips, `cd.length`
   is 0, and the sentence interpolated it — broken English on exactly the page an
   operator opens to ask why everything is blank, and, read as English, a claim
   of a clean cancellation record over a window with no work in it.

   REVERSION THAT PROVES THIS: remove the `if (!cd.length)` branch from
   tabQuality so the count falls through into the sentence again. */
const qual = await render('quiet', 'quality');
check('no sentence says "the 0 days this driver worked"',
  !/\b0 days this driver worked/.test(qual.all),
  (qual.all.match(/No cancellations[^.]*\./g) || []).join(' | '));
check('…it says there was no day on which anything could have been cancelled',
  /no day on which they could have cancelled/.test(qual.all),
  qual.notes.join(' | ').slice(0, 300));

console.log('\nthe fleet page’s twin of this tile carries the same guard');

/* api/public/app.js:2738 had the IDENTICAL collapse on the Finance page —
   `value: cash ? (…) : money(0)` — and the same true-but-narrow sub-line, "no
   cash booking in this range". Its distinguishing fact is the same one: the
   range's own booking count, from the /api/kpis it has already fetched.

   Asserted against the shipped module's SOURCE rather than its DOM, on the
   precedent of test/unauthorized_attribution_page.test.mjs's last block: that
   page's tiles sit behind nine endpoints and a settlement payload, and standing
   all of that up here would be testing the fixture. The two guards below are
   the two forms the defect can take, and they are exactly the two strings that
   were there.

   REVERSION THAT PROVES THIS: restore `: money(0)` on the Cash collected —
   measured portion tile, or restore the bare `: 'no cash booking in this range'`
   sub. One assertion each. */
const appSrcRaw = await (await fetch(`http://127.0.0.1:${port}/app.js`)).text();
/* Block comments stripped first. This file's house style is to quote the
   defective expression in the comment that explains why it is gone, so a naive
   grep for the old code finds the tombstone and reports the bug as still
   present. */
const appSrc = appSrcRaw.replace(/\/\*[\s\S]*?\*\//g, '');
check('the fleet cash tile no longer falls through to money(0)',
  !/money\(cash\.revenue\)\)\s*:\s*money\(0\)/.test(appSrc)
  && !/:\s*money\(0\),/.test(appSrc), 'api/public/app.js still renders money(0)');
check('…and its reason names the wider fact when no booking is in the range',
  /no booking of any kind falls in this range/.test(appSrc)
  && !/'no cash booking in this range'/.test(appSrc),
  'api/public/app.js still prints the narrow sentence');
/* REVERSION: restore `n: +r.amount || 0` in the Finance ledger chart, or the
   unconditional `cur.amount += +c.amount || 0` seed in componentTree. A null
   amount becomes a zero-length bar labelled with its category again. */
check('no hbars caller in app.js coerces a null amount to a zero-length bar',
  !/n:\s*\+[a-z]\.amount\s*\|\|\s*0/.test(appSrc),
  'api/public/app.js still passes `+x.amount || 0` to hbars');
check('…and componentTree records whether anything behind a category was valued',
  /cur\.measured = true/.test(appSrc) && /c\.amount != null/.test(appSrc),
  'api/public/app.js aggregates amounts from a zero seed regardless of nulls');

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
