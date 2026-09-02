/* Three places a money page contradicted itself, and the arithmetic that says so.
   ─────────────────────────────────────────────────────────────────────────────
   Every figure quoted below was read off production
   (https://fleet-dashboard-wpeqb.ondigitalocean.app) at 2026-09-02T13:16Z and
   2026-09-02T13:18Z, during collector job 41's backfill — so the money moves,
   and each assertion here is against the SHAPE of the contradiction rather
   than against a frozen amount.

   1. #revenue counted the same bookings twice, in opposite directions.
      /api/revenue?days=365 put uber on basis `partial_payout` (a real net
      payout of AED 2,401,822.21 covering 209 of the 365 days uber worked) and
      fleetIncome() then counted uber's 232,832 bookings BOTH in the measured
      set (accounted_bookings) AND in darkRows (dark_bookings). The page
      printed, in one row of tiles:
        "Accounted for AED 2,533,853 across 234,499 of 234,499 bookings"
        "Bookings with no money value 232,832 — 99.3% of the window"
      of the identical rows. accounted_bookings + dark_bookings = 467,331 over
      a window of 234,499 bookings.

   2. The channel table's caption claimed "Reconciled on July 2026 these agree
      to 0.7% once the cash is accounted for" directly under the two columns it
      named. Those two columns are 14.2% apart:
      /api/revenue?from=2026-07-01&to=2026-07-31 gives uber statement_net
      382,915.61 + tips 4,219.36 + salik 0 − statement_cash 75,805.92 =
      311,329.05 expected against payouts 355,419.78 — AED 44,090.73 apart —
      and /api/reconcile's July row agrees to the fils (expected_payout
      311,329.05, bank_covered 355,419.78, delta 44,090.73, delta_pct 14.2).
      The 0.7% is the reconciliation against the OPERATOR'S OWN LEDGER
      (driver_statement_day source='ledger'), which this page never displays.

   3. #unit's "Idle vehicle-days" tile paired a day count with a cost that
      prices a fraction of it. /api/economics/assets?days=2 at 13:18Z:
      idle_vehicle_days 289, forgone_at_own_rate AED 2,056 — and that 2,056
      prices SEVEN of the 289 days. The other 282 belong to 141 vehicles in
      band `still` that have never earned and so have no daily rate of their
      own (api/economics_routes.js correctly leaves those null). Dividing the
      tile's two numbers gave AED 7.11 a day, three tiles below the same
      page's "Per earning vehicle-day AED 377".

   The UI half renders the real views. Section 1 is pure arithmetic and needs
   no browser; sections 2 and 3 serve api/public against fixtures whose totals
   are produced by the REAL fleetIncome(), so a regression in either layer
   fails here. */
import express from 'express';
import { fleetIncome } from '../api/income_sql.js';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── 1. the split, in arithmetic ─────────────────────────────────────────── */
console.log('\na part-window payout is measured money, not dark money');

/* Production's four channels on the 365-day window, 2026-09-02T13:16Z. */
const platformRows = () => [
  { platform: 'uber', bookings: 232832, priced_bookings: 0, fares: null, km: 2778038,
    payouts: 2401822.21, cash: null, payout_days: 209, booking_days: 365,
    statement_net: 2279334.52, statement_gross: 3029666.13, statement_fees: 757475.85,
    statement_tips: 25057.87, statement_salik: 1837.65, statement_cash: 450325.88,
    statement_bank: null, statement_days: 206, statement_drivers: 234,
    tips: 25057.87, drivers: 207, vehicles: 137, payout_drivers: 234,
    collection_status: 'ok', collection_error: null },
  { platform: 'hotel', bookings: 1631, priced_bookings: 1616, fares: 130218.92, km: 19088,
    priced_km: 19032, payouts: null, cash: null, payout_days: 0, booking_days: 58,
    drivers: 37, vehicles: 38, collection_status: 'ok', collection_error: null },
  { platform: 'yango', bookings: 36, priced_bookings: 36, fares: 1812, km: 454,
    priced_km: 454, payouts: 17611.22, cash: 6411.52, payout_days: 115, booking_days: 14,
    drivers: 3, vehicles: 3, collection_status: 'error',
    collection_error: 'yango /api/reports-api/v1/orders/list refused: HTTP 403' },
  { platform: 'bolt', bookings: 0, priced_bookings: 0, fares: null, km: null,
    payouts: null, cash: null, payout_days: 0, booking_days: 0, drivers: 0, vehicles: 0,
    collection_status: 'partial',
    collection_error: 'BOLT_CLIENT_ID is not entitled to company_id 142868 — code=503' },
];

const rows365 = platformRows();
const t365 = fleetIncome(rows365, 365);
const uber = rows365.find((r) => r.platform === 'uber');
const totalBookings = rows365.reduce((a, r) => a + r.bookings, 0);

check('the window still puts uber on a part-window payout',
  uber.basis === 'partial_payout' && uber.payout_coverage_days === 209
  && uber.payout_coverage_base === 365, `basis=${uber.basis} ${uber.payout_coverage_days}/${uber.payout_coverage_base}`);
check('…and still counts its AED 2.4m inside the accounted total',
  t365.accounted > 2400000 && t365.accounted_payouts === 2401822.21,
  `accounted=${t365.accounted} payouts=${t365.accounted_payouts}`);

/* THE failing assertion: the two counts partition the window's bookings, they
   do not both claim it. Before the fix this read 467331 against 234499. */
check('accounted and dark bookings cannot both count the same rows',
  t365.accounted_bookings + t365.dark_bookings <= totalBookings,
  `accounted_bookings ${t365.accounted_bookings} + dark_bookings ${t365.dark_bookings} `
  + `= ${t365.accounted_bookings + t365.dark_bookings} over a window of ${totalBookings}`);
check('a channel we hold AED 2,401,822.21 for is not "no money value"',
  t365.dark_bookings === 0 && t365.dark_pct === 0,
  `dark_bookings=${t365.dark_bookings} dark_pct=${t365.dark_pct}`);
check('…it is reported as under-covered instead, with its own count',
  t365.undercovered_bookings === 232832 && t365.undercovered_payouts === 2401822.21
  && t365.undercovered_platforms.join() === 'uber',
  `undercovered_bookings=${t365.undercovered_bookings} `
  + `payouts=${t365.undercovered_payouts} platforms=${t365.undercovered_platforms}`);

/* And the other direction: money that really is absent still counts as dark.
   bolt with bookings and no figure of any kind, and a partial_fares channel. */
const absent = [
  { platform: 'bolt', bookings: 618, priced_bookings: 0, fares: null, payouts: null,
    payout_days: 0, booking_days: 31 },
  { platform: 'careem', bookings: 400, priced_bookings: 80, fares: 5100, payouts: null,
    payout_days: 0, booking_days: 31 },
];
const tAbsent = fleetIncome(absent, 31);
check('a channel with no figure at all is still dark',
  absent[0].basis === 'none' && tAbsent.dark_bookings >= 618, `dark=${tAbsent.dark_bookings}`);
check('…and so is a channel pricing 80 of its 400 bookings',
  absent[1].basis === 'partial_fares' && tAbsent.dark_bookings === 1018
  && tAbsent.undercovered_bookings === 0,
  `dark=${tAbsent.dark_bookings} undercovered=${tAbsent.undercovered_bookings}`);

/* The July window, where the same channel clears 80% coverage, goes to basis
   `payout`, and is neither dark nor under-covered. The split has to be a
   property of the coverage, not of the channel. */
const july = [{ platform: 'uber', bookings: 9655, priced_bookings: 0, fares: null,
  payouts: 355419.78, payout_days: 31, booking_days: 31, statement_net: 382915.61 }];
const tJuly = fleetIncome(july, 31);
check('a payout that covers the window is neither dark nor under-covered',
  july[0].basis === 'payout' && tJuly.dark_bookings === 0 && tJuly.undercovered_bookings === 0,
  `basis=${july[0].basis} dark=${tJuly.dark_bookings} under=${tJuly.undercovered_bookings}`);

/* ── the fixture server ──────────────────────────────────────────────────── */
/* Everything the shell needs comes from mockapi.mjs; the two routes under test
   are overridden with production's own shape. /api/revenue's `totals` is built
   by the real fleetIncome() rather than typed, so this half of the test cannot
   pass on a fixture the server would never send. */
const { app: mockApp } = await import('../mockapi.mjs');
const mockServer = mockApp.listen(0);
const mockPort = mockServer.address().port;

const revenueBody = () => {
  const rows = platformRows();
  const income = fleetIncome(rows, 365);
  for (const r of rows) {
    const paid = r.basis === 'payout' || r.basis === 'partial_payout';
    r.revenue_per_km = paid && r.payouts != null && r.km
      ? Math.round((r.payouts / r.km) * 100) / 100
      : (r.fares != null && r.priced_km ? Math.round((r.fares / r.priced_km) * 100) / 100 : null);
    r.per_km_basis = paid && r.payouts != null && r.km ? 'payout' : (r.fares != null && r.priced_km ? 'fares' : null);
    r.per_km_km = r.per_km_basis === 'payout' ? r.km : r.priced_km ?? null;
  }
  return {
    window: ['2025-09-03', '2026-09-02'],
    platforms: rows.sort((a, b) => b.bookings - a.bookings),
    window_days: 365,
    totals: {
      bookings: rows.reduce((a, r) => a + r.bookings, 0),
      priced_bookings: rows.reduce((a, r) => a + (r.priced_bookings || 0), 0),
      fares: rows.reduce((a, r) => a + (r.fares || 0), 0) || null,
      payouts: rows.reduce((a, r) => a + (r.payouts || 0), 0) || null,
      cash: rows.reduce((a, r) => a + (r.cash || 0), 0) || null,
      statement_net: rows.reduce((a, r) => a + (r.statement_net || 0), 0) || null,
      statement_cash: rows.reduce((a, r) => a + (r.statement_cash || 0), 0) || null,
      statement_bank: null,
      tips: rows.reduce((a, r) => a + (r.tips || 0), 0) || null,
      ...income,
    },
    components: [],
    /* null under the corrected rule: nothing in this window is money we do not
       hold. api/revenue_routes.js still builds this sentence with the old
       filter (partial_payout counted as dark) — reported, not editable here. */
    caveat: null,
    measured_platforms: income.accounted_platforms,
    silent_platforms: [],
  };
};

/* Production's idle-day split at ?days=2, 2026-09-02T13:18Z, laid over the
   mock's own asset rows so every other field the page reads stays intact:
   7 earning cars carrying one idle day each and priced, and 141 cars that have
   never earned carrying two idle days each and priced at nothing. */
const assetsBody = async () => {
  const base = await (await fetch(`http://127.0.0.1:${mockPort}/api/economics/assets?days=2`)).json();
  const tpl = base.rows.find((r) => r.band === 'earning');
  /* 294 × 5 + 293 × 2 = the AED 2,056 production priced those seven days at,
     and one idle day each at a rate of its own means the tile above reads
     AED 294 per earning vehicle-day — the number the old sub-line invited a
     reader to compare AED 7.11 against. */
  const earning = [294, 294, 294, 294, 294, 293, 293].map((v, i) => ({ ...tpl,
    plate: `E${String(i).padStart(5, '0')}`, band: 'earning',
    window_days: 2, idle_days: 1, days_moved: 1, days_earning: 1,
    money: v, payouts: v, fares: null, forgone_at_own_rate: v,
    aed_per_earning_day: v, aed_per_booking: null, aed_per_km: null }));
  const stillOne = base.rows.find((r) => r.band === 'still') || base.rows[base.rows.length - 1];
  const still = Array.from({ length: 141 }, (_, i) => ({ ...stillOne, band: 'still',
    plate: `S${String(i).padStart(5, '0')}`, window_days: 2, idle_days: 2, days_moved: 0,
    days_earning: 0, money: null, fares: null, payouts: null, bookings: 0, km: null,
    aed_per_earning_day: null, aed_per_km: null, aed_per_booking: null,
    forgone_at_own_rate: null, current_driver: null, current_driver_id: null }));
  const rows = [...earning, ...still];
  const sum = (f) => rows.reduce((a, r) => a + (Number(f(r)) || 0), 0);
  return { ...base, window_days: 2, rows,
    totals: { ...base.totals,
      vehicles: rows.length, earning: earning.length, moved_unpaid: 0, still: still.length,
      earning_vehicle_days: earning.length,
      idle_vehicle_days: sum((r) => r.idle_days),
      forgone_at_own_rate: sum((r) => r.forgone_at_own_rate) || null,
      money: sum((r) => r.money) || null,
      aed_per_earning_day: Math.round((sum((r) => r.money) / earning.length) * 100) / 100 } };
};

const shell = express();
shell.get('/api/revenue', (_, res) => res.json(revenueBody()));
shell.get('/api/economics/assets', (_, res) => assetsBody().then((b) => res.json(b))
  .catch((e) => res.status(500).json({ error: String(e) })));
shell.use(express.static('api/public'));
shell.use(mockApp);
const server = shell.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1600, height: 1400 } });
const open = async (hash, ready) => {
  await page.goto(`${base}/?ui=desktop`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ } });
  await page.goto(`${base}/?ui=desktop${hash}`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate(ready)) break;
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(600);
};
const readTiles = () => page.evaluate(() => [...document.querySelectorAll('.kpi')].map((k) => ({
  label: k.querySelector('.l')?.textContent.trim() || '',
  value: k.querySelector('.n')?.textContent.trim() || '',
  sub: k.querySelector('.s')?.textContent.trim() || '',
  tone: [...k.classList].find((c) => c.startsWith('t-')) || null,
})));
/* app.js countUp() animates every KPI figure from zero, so a tile read the
   moment its label exists reads a number on its way up — 212, then 240, then
   288 on three runs of an idle count that is 289. Read until two consecutive
   reads agree. */
const tiles = async () => {
  let prev = JSON.stringify(await readTiles());
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(300);
    const now = JSON.stringify(await readTiles());
    if (now === prev) return JSON.parse(now);
    prev = now;
  }
  return JSON.parse(prev);
};

/* ── 2. the two tiles, on the rendered page ──────────────────────────────── */
console.log('\n#revenue no longer prints the same bookings as accounted and as dark');
await open('#revenue?days=365',
  () => [...document.querySelectorAll('.kpi .l')].some((l) => /Accounted for/.test(l.textContent)));
const revTiles = await tiles();
const accTile = revTiles.find((k) => k.label === 'Accounted for');
const darkTile = revTiles.find((k) => k.label === 'Bookings with no money value');

check('both tiles are on the page', !!accTile && !!darkTile,
  revTiles.map((k) => k.label).join(' | '));
check('the dark tile no longer claims uber\'s 232,832 bookings',
  darkTile.value === '0', `reads "${darkTile.value}"`);
check('…and says where those bookings actually went',
  /232,832 more are covered by a payout that reaches 209 of Uber’s 365 days/.test(darkTile.sub),
  `sub was "${darkTile.sub}"`);
check('…and is amber rather than critical, because the money is held',
  darkTile.tone === 't-warn', `tone ${darkTile.tone}`);
check('the accounted tile no longer says "across 234,499 of 234,499 bookings"',
  !/across 234,499 of 234,499 bookings/.test(accTile.sub), `sub was "${accTile.sub}"`);
check('…it names the fare base and its own denominator',
  /AED 132,031 in fares over 1,652 priced bookings/.test(accTile.sub), `sub was "${accTile.sub}"`);
check('…and the payout base and ITS denominator, which is days',
  /AED 2,401,822 in net payout over 209 of the 365 days Uber worked/.test(accTile.sub),
  `sub was "${accTile.sub}"`);
check('…and stays amber while 99.3% of the work sits on a part-window payout',
  accTile.tone === 't-warn', `tone ${accTile.tone}`);

/* ── the reconciliation claim ────────────────────────────────────────────── */
console.log('\n…and it claims only the reconciliation it can show');
const caps = await page.evaluate(() => [...document.querySelectorAll('p.cap')].map((p) => p.textContent));
const recon = caps.find((c) => /Three views of the same money/.test(c)) || '';
check('the caption is there', !!recon, caps.join('\n---\n').slice(0, 400));
check('it no longer claims a 0.7% agreement between two columns 29% apart',
  !/0\.7%/.test(recon), recon);
/* uber is the only channel with both sides: 2,279,334.52 + 25,057.87 + 1,837.65
   − 450,325.88 = 1,855,904.16 expected against 2,401,822.21 wired. */
check('…it prints the gap these two columns actually leave',
  /AED 1,855,904 expected against AED 2,401,822 wired/.test(recon), recon);
check('…with the size of it, and which side is ahead',
  /AED 545,918 apart \(29\.4%, the bank ahead\)/.test(recon), recon);
check('…and the two denominators, which are not the same days',
  /206 statement days and 209 payout days on Uber/.test(recon), recon);

/* ── 3. the idle tile names the base its money was measured over ─────────── */
console.log('\n#unit pairs its idle days with the base the cost was measured over');
await open('#unit?days=2',
  () => [...document.querySelectorAll('.kpi .l')].some((l) => /Idle vehicle-days/.test(l.textContent)));
const unitTiles = await tiles();
const idleTile = unitTiles.find((k) => k.label === 'Idle vehicle-days');
const perDay = unitTiles.find((k) => k.label === 'Per earning vehicle-day');
check('the tile is there and counts every idle day', idleTile?.value === '289',
  `value "${idleTile?.value}"`);
check('…and does not pair that count with a bare figure',
  !/^AED [\d,]+ at each asset’s own daily rate/.test(idleTile.sub), `sub was "${idleTile.sub}"`);
check('…it says the money was measured over 7 of the 289',
  /AED 2,056 over the 7 of them held by a car that has earned/.test(idleTile.sub),
  `sub was "${idleTile.sub}"`);
check('…and why the other 282 carry nothing',
  /the other 282 belong to cars that have never earned/.test(idleTile.sub),
  `sub was "${idleTile.sub}"`);
/* The reading the old tile invited: 2056 / 289 = AED 7.11 a day, against the
   per-earning-day tile three places above it. The sub-line has to make the
   division impossible to make by accident. */
check('…so the tile cannot be read as AED 7 a day beside a AED 294 one',
  /over the 7 of them/.test(idleTile.sub) && perDay?.value === 'AED 294',
  `per-day tile "${perDay?.value}", idle sub "${idleTile.sub}"`);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close(); mockServer.close();
process.exit(fail ? 1 : 0);
