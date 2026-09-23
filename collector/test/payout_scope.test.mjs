/* THE PAYOUT PAGE'S SUBJECT IS THE WHOLE REGISTER, AND A REQUEST THAT NAMES NO
   WINDOW NOW GETS THE WHOLE REGISTER.
   ═══════════════════════════════════════════════════════════════════════════
   THE DEFECT THIS FILE GUARDS, reported by the operator in four words — "it
   doesn't show it. why?" — over a screenshot of the live Payouts page reading:

     TRANSFERRED TO THE BANK   AED 319,015
     6 transfers on 2 dates in this window
     THE RECORD STARTS         23 Dec 2024

   Every number on that screen was correct. The shell's window selector was on
   "This month"; api/public/data.js params() puts `period=month` on every call
   a page makes through q(); api/payout_routes.js honoured it exactly. Six
   transfers is the truth about 2026-09-01 to 2026-09-17.

   MEASURED ON PRODUCTION 2026-09-17, the same route three ways:
     ?period=month                     6 transfers,  2 dates, AED   319,015.37
     ?from=2024-01-01&to=2026-12-31  216 transfers, 91 dates, AED 3,460,166.93
     (no window at all)              217 transfers

   SO THE ROUTE WAS NEVER THE PROBLEM, and the first version of this fix said
   it was. api/window.js winDays() already falls back to a whole-record span
   when nothing is named; what put six transfers on screen was params() in
   api/public/data.js, which puts `period=month` on every call a page makes
   through q(). A transfer is a SPARSE event — 91 dates across twenty-one
   months — so a rolling window is the wrong default for it in the way it is
   the right default for trips, and the page asked for as "clear visibility
   including past payments" was showing 3% of the payments.

   The fix is therefore on the CLIENT — qChan instead of q, and #payouts on
   NO_RANGE so the selector is off the page rather than merely ignored — and
   this file asserts that half in §5 by reading the source, because every
   server assertion below would pass over a page still reading "6 transfers".

   WHAT THE SERVER HALF FIXES IS WHAT THAT FALLBACK DOES TO THE REST OF THE
   ANSWER. winDays()'s no-window span is ['2000-01-01', '2100-01-01'], a
   sentinel and not the register, and the unchecked band walks
   generate_series(from, yesterday) over it. The same production request, made
   before the floor landed:

     GET /api/finance/payouts/reconcile   (no window)
       unchecked  uber/ecosine 9,721 days · uber/egari 9,729 days
       response   359,254 bytes

   — a backlog counted from the year 2000, most of it days before either fleet
   existed, printed by the one panel whose entire job is stopping this register
   from being read as exhaustive. So a no-window request resolves to the
   register's OWN floor, measured from the data and never written down as a
   constant, and the enumerated day list is capped with the cap named in the
   response. The COUNTS stay complete: they are what the panel's sentence is
   built from, and a cut total would understate a backlog. A cap that does not
   announce itself reads as "this is all of them", which is the same class of
   untruth as a reason that is not the true one. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

/* ── the fixture: a register that straddles any rolling window ───────────
   The old wire is deliberately far outside thirty days of the recent ones —
   that gap IS the defect, and a fixture whose rows all sit inside one month
   could not tell the two behaviours apart. */
const payout = (o) => q(
  `INSERT INTO platform_payout (platform, fleet_id, payout_ext_id, paid_on, amount,
                                currency, period_start, period_end, method, source)
   VALUES ($1,$2,$3,$4::date,$5,'AED',$6::date,$7::date,'bank','test')`,
  [o.platform, o.fleet, o.id, o.day, o.amount, o.from || null, o.to || null]);

const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.parse(`${TODAY}T12:00:00Z`) - n * 864e5)
  .toISOString().slice(0, 10);

/* Two recent transfers a thirty-day window would find... */
await payout({ platform: 'uber', fleet: 'ecosine', id: 'r1', day: daysAgo(3),
  amount: 111179.66 });
await payout({ platform: 'bolt', fleet: 'egari', id: 'r2', day: daysAgo(9),
  amount: 2130.56 });
/* ...and three it would not. 'THE RECORD STARTS' on the live page is this
   kind of row: the oldest one, nineteen months back. */
await payout({ platform: 'bolt', fleet: 'ecosine', id: 'o1', day: '2024-12-23',
  amount: 5000 });
await payout({ platform: 'uber', fleet: 'ecosine', id: 'o2', day: '2025-04-07',
  amount: 40000 });
await payout({ platform: 'uber', fleet: 'egari', id: 'o3', day: '2025-04-07',
  amount: 10000 });

const m = await mountAll(db);
const get = (p) => m.get(p).then((r) => r.body);

/* ══ 1. NO WINDOW MEANS THE WHOLE REGISTER ═══════════════════════════════ */
console.log('\na request that names no window gets every transfer on record');
{
  const d = await get('/api/finance/payouts');
  /* These two hold under the OLD behaviour as well — winDays()'s no-window
     fallback is already whole-record — and they are here to pin that, not to
     prove the change. Reverting the floor leaves both green; §1's last two
     assertions and §4 are the ones that go red. Said out loud because a test
     that looks like it proves something it does not is worse than no test. */
  check('all five transfers come back, the two recent ones and the three old',
    (d.payouts || []).length === 5, String((d.payouts || []).length));
  check('the total is the whole register',
    Math.round((d.payouts || []).reduce((a, r) => a + Number(r.amount), 0) * 100) / 100
      === 168310.22,
    String((d.payouts || []).reduce((a, r) => a + Number(r.amount), 0)));
  /* THE FLOOR IS MEASURED, NOT WRITTEN DOWN — and it is the register's floor
     and not api/window.js's sentinel. A constant would be a second copy of a
     date the database already holds and would go stale the first time an older
     statement is backfilled, which is what the Mondays-first walk in
     src/sources/uber_payout.js does every two hours. */
  check('the window it answered over starts at the register’s own oldest row',
    d.window?.[0] === '2024-12-23', JSON.stringify(d.window));
  check('…and not at winDays()’s 2000-01-01 sentinel, which is not a record',
    d.window?.[0] !== '2000-01-01', JSON.stringify(d.window));
  /* BOTH ENDS MEASURED. The first production build of this shipped with a
     measured floor beside winDays()'s 2100-01-01 ceiling and reported
     "2024-12-23 -> 2100-01-01" — a window half read from the register and half
     from a sentinel, in the field that is this route's own account of what it
     answered over. Today, not the newest row: a register whose last transfer
     was a week ago has still been answered over up to today. */
  check('…and it ends at a measured date rather than the 2100-01-01 sentinel',
    d.window?.[1] === TODAY, JSON.stringify(d.window));
  /* The page's sentences bind on this rather than guessing from the dates:
     "the whole record" and "a window that happens to be wide" read identically
     in a pair of dates and say different things to a reader. */
  check('…and it says so, so the page can print a true noun phrase',
    d.scope === 'record', String(d.scope));
}

/* ══ 2. AN EXPLICIT WINDOW IS STILL HONOURED, UNCHANGED ══════════════════
   This is the half that keeps every existing caller — the audit tooling, the
   other tests, anybody reading the API directly — behaving exactly as before.
   Three spellings, because params() can send any of them. */
console.log('\nan explicitly named window is honoured exactly as before');
for (const [label, qs] of [
  ['from/to', `from=${daysAgo(30)}&to=${TODAY}`],
  ['days', 'days=30'],
  ['period', 'period=month'],
]) {
  const d = await get(`/api/finance/payouts?${qs}`);
  const inside = (d.payouts || []).map((r) => String(r.paid_on).slice(0, 10));
  check(`?${label} excludes the 2024 and 2025 rows`,
    !inside.includes('2024-12-23') && !inside.includes('2025-04-07'),
    JSON.stringify(inside));
  check(`?${label} reports scope 'window', not 'record'`,
    d.scope === 'window', String(d.scope));
}

/* An empty string is not a window. params() drops empties, but a hand-built
   URL can carry `?from=&to=`, and reading that as "the caller asked for a
   window" would silently hand them thirty days under a whole-record page. */
{
  const d = await get('/api/finance/payouts?from=&to=&days=');
  check('empty window parameters are not a window', d.scope === 'record'
    && (d.payouts || []).length === 5, `${d.scope} / ${(d.payouts || []).length}`);
}

/* ══ 3. THE RECONCILIATION TAKES THE SAME DEFAULT ════════════════════════
   The two endpoints paint one page. A register on the whole record beside a
   reconciliation on thirty days would put a difference under a total it does
   not cover — which is worse than either scope alone. */
console.log('\nthe reconciliation defaults the same way the register does');
{
  const r = await get('/api/finance/payouts/reconcile');
  check('every transfer on record is reconciled', (r.rows || []).length === 5,
    String((r.rows || []).length));
  check('it reports scope record', r.scope === 'record', String(r.scope));
  /* The sentence the page prints. "in this window" over the whole register is
     exactly the kind of untrue reason this product refuses. */
  check('its totals sentence says "on record" and never "in this window"',
    /on record/.test(r.totals?.basis || '') && !/in this window/.test(r.totals?.basis || ''),
    r.totals?.basis);

  const w = await get(`/api/finance/payouts/reconcile?from=${daysAgo(30)}&to=${TODAY}`);
  check('…and says "in this window" when one was actually named',
    w.scope === 'window' && /in this window/.test(w.totals?.basis || ''),
    `${w.scope} / ${w.totals?.basis}`);
}

/* ══ 4. THE COUNT IS COMPLETE AND THE LIST IS CUT, AND IT SAYS SO ════════ */
console.log('\nthe unchecked backlog is counted in full and enumerated in part');
{
  const r = await get('/api/finance/payouts/reconcile');
  const u = (r.unchecked || []).find((x) => x.fleet_id === 'ecosine');
  check('the unchecked band answers for Uber/ecosine', !!u,
    JSON.stringify((r.unchecked || []).map((x) => `${x.platform}/${x.fleet_id}`)));
  /* THE COUNT IS A FACT ABOUT THE REGISTER, BOUNDED ON BOTH SIDES.
     Lower: 2024-12-23 to yesterday is well past six hundred days, so the cap
     below is genuinely exercised rather than assumed to be. Upper: under the
     2000-01-01 sentinel this number was 9,721 on production — a backlog
     counted from before either fleet existed, printed by the one panel whose
     job is to be actionable. An upper bound is what makes this assertion go
     red when the floor is reverted. */
  const floorDays = Math.round(
    (Date.parse(`${TODAY}T12:00:00Z`) - Date.parse('2024-12-23T12:00:00Z')) / 864e5);
  check('the count is the register’s own backlog, hundreds of days',
    u?.count > 400 && u?.count <= floorDays,
    `${u?.count} against a register floor ${floorDays} days back`);
  check('the enumerated list is bounded at ninety', (u?.days || []).length === 90,
    String((u?.days || []).length));
  check('days_shown reports what actually arrived, beside the true count',
    u?.days_shown === 90 && u.days_shown < u.count,
    `${u?.days_shown} of ${u?.count}`);
  /* NO SILENT CAPS. A picker showing ninety of nine hundred and fifty-six with
     nothing said reads as ninety. */
  check('the cut is named in the response rather than left to be inferred',
    /most recent/.test(u?.listed_why || ''), u?.listed_why);
  /* Most recent first: a person at this page wants last Monday, and the
     nightly walk needs no list from a reader to find the old ones. */
  check('the listed days are the most recent ones, newest first',
    (u?.days || [])[0] > (u?.days || [])[89], `${(u?.days || [])[0]} … ${(u?.days || [])[89]}`);
  /* THE RESPONSE HAS TO FIT A basic-xxs INSTANCE. 130 KB was measured on
     production before the cap; the assertion is on the shape that produced it. */
  const bytes = Buffer.byteLength(JSON.stringify(r));
  check('the whole-record response stays well under the 130 KB it measured at',
    bytes < 60000, `${bytes} bytes`);
}

/* ══ 5. THE PAGE SENDS NO WINDOW, AND THE SELECTOR IS OFF IT ═════════════
   Source assertions, because the server half is useless on its own: q() would
   go on putting period=month on every call and the route would go on honouring
   it, and every assertion above would still pass over a page still reading
   "6 transfers on 2 dates". */
console.log('\nthe page itself stops sending a window');
{
  const page = readFileSync(new URL('../api/public/payouts.js', import.meta.url), 'utf8');
  const calls = page.match(/\bq\('\/api\/finance\/payouts/g) || [];
  check('payouts.js calls neither payout endpoint through q(), which sends the window',
    calls.length === 0, calls.join(' '));
  check('…it calls both through qChan(), which sends the channel chips only',
    (page.match(/qChan\('\/api\/finance\/payouts/g) || []).length === 3,
    String((page.match(/qChan\('\/api\/finance\/payouts/g) || []).length));

  const data = readFileSync(new URL('../api/public/data.js', import.meta.url), 'utf8');
  const { NO_RANGE, NO_PLATFORM_FLEET } = await import('../api/public/data.js');
  check('#payouts is on NO_RANGE, so the selector is off the page rather than ignored',
    NO_RANGE.includes('payouts'), NO_RANGE.join(', '));
  /* And the channel chips STAY: Ecosine and Egari bank separately, and "which
     of my two companies was this wire for" is the second question anybody asks
     of a transfer. */
  check('…and the fleet and platform chips stay, because the two fleets bank apart',
    !NO_PLATFORM_FLEET.includes('payouts'), NO_PLATFORM_FLEET.join(', '));
  check('the reason is written down beside the entry, not left to a commit message',
    /it doesn.t show it/.test(data), 'no defect note next to the NO_RANGE entry');
}

/* ══ 6. AND THE HEADING THAT WAS MISSED WHEN THE LEAD SENTENCE WAS FIXED ══
   The unchecked panel's lead sentence was corrected from "nobody has asked"
   to "we hold no statement" because a day asked and REFUSED leaves no row
   either — the walk of 2026-09-16 asked eight days for Ecosine and stored
   four when Uber's limiter shut. The per-pair heading one line further down
   still carried the disproved claim. */
console.log('\nthe per-pair heading no longer claims nobody asked');
{
  const page = readFileSync(new URL('../api/public/payouts.js', import.meta.url), 'utf8');
  check('no rendered string asserts "nobody has asked about" as a count’s reason',
    !/nobody has asked about\.`/.test(page) && !/'} nobody has asked about/.test(page),
    'the heading still asserts it');
  check('…it says what the page actually knows: no statement is stored',
    /with no statement stored/.test(page), 'the corrected heading is missing');
}

/* ══ 7. AND THE CLAIM THE WHOLE RECORD DISPROVED ═════════════════════════
   Not a scope assertion, and it belongs to this change because the window is
   what hid it. Bolt's coverage row said "One payout per date, with NO FIXED
   WEEKDAY" — written from the month the page used to show. Measured on
   production the day the window came off, over every transfer on record:
   uber 60/60 on a Monday, bolt 175/175, 91 distinct dates and all of them
   Mondays. 175 out of 175 is not "no fixed weekday". */
console.log('\nBolt’s cadence row states a count rather than a guessed rule');
{
  const d = await get('/api/finance/payouts');
  const bolt = (d.coverage || []).find((c) => c.platform === 'bolt');
  check('it no longer claims Bolt has no fixed weekday',
    !/no fixed weekday/i.test(bolt?.cadence || ''), bolt?.cadence);
  /* THIS ASSERTION USED TO PIN THE LITERAL "175 of 175" — which is to say it
     asserted the stale number. The cadence line hard-coded a count measured on
     2026-09-17 and kept printing it after the register reached 177; this test
     was the thing holding that in place. It now checks the line COUNTS: the
     second number is this fixture's Bolt transfers and the first is how many
     of them fall on a Monday, both computed here from the fixture's own dates
     (one of which is "nine days ago", a Monday only on some days — so the
     expected figure cannot be written down either). */
  const boltRows = await q(`SELECT paid_on FROM platform_payout WHERE platform = 'bolt'`);
  const mondays = boltRows.filter((r) => new Date(r.paid_on).getUTCDay() === 1).length;
  const m = (bolt?.cadence || '').match(/(\d+) of (\d+)/);
  check('…it names what was counted — the live count, not a number written down',
    !!m && Number(m[2]) === boltRows.length && Number(m[1]) === mondays
    && /not a rule/.test(bolt?.cadence || ''),
    `${bolt?.cadence} | fixture: ${mondays} of ${boltRows.length}`);
  /* And it still refuses the thing Bolt genuinely does not publish. */
  check('…and still says Bolt states no settled period',
    /does not say which period/.test(bolt?.cadence || ''), bolt?.cadence);
}

/* ══ 8. THE REASONS UNDER THE TABLE GROUP BY KIND, NOT BY SENTENCE ═══════
   Also a whole-record defect: the page groups rows with no comparison by their
   REASON before printing it, so Bolt's 175 identical sentences become one
   note. The "no driver-day rows" sentence NAMES THE WEEK, so each Uber row was
   its own group. Measured on the first whole-record production render: 51
   groups over 225 rows, 50 of them a single row, fifty notes reading "No
   comparison is made for 1 transfer (Uber)" stacked down the money page.

   The route half is asserted here; the page half — grouping on the code — is
   asserted by reading the source, the way §5 does, because it is a browser
   function this harness does not run. */
console.log('\nthe route names WHICH absence a row has, so the page can group by kind');
{
  /* Two Uber wires with a stated period and no driver-day rows behind it: the
     rows whose sentences differ only in the dates they name. */
  await payout({ platform: 'uber', fleet: 'ecosine', id: 'g1', day: '2025-12-22',
    amount: 5000, from: '2025-12-15', to: '2025-12-21' });
  await payout({ platform: 'uber', fleet: 'ecosine', id: 'g2', day: '2025-12-15',
    amount: 6000, from: '2025-12-08', to: '2025-12-14' });
  const r = await get('/api/finance/payouts/reconcile');
  const g = r.rows.filter((x) => x.payout_ext_id || true)
    .filter((x) => ['2025-12-22', '2025-12-15'].includes(x.paid_on));
  check('both rows come back with no comparison', g.length === 2
    && g.every((x) => x.calculated == null), JSON.stringify(g.map((x) => x.calculated)));
  check('…their sentences differ, because each names its own week',
    g[0].calculated_basis !== g[1].calculated_basis,
    'the two reasons are identical, so this fixture proves nothing');
  check('…and their absence CODE is the same, which is the groupable key',
    g[0].calculated_absent === 'no_driver_day_rows'
      && g[1].calculated_absent === g[0].calculated_absent,
    `${g[0].calculated_absent} / ${g[1].calculated_absent}`);
  const bolt = r.rows.find((x) => x.platform === 'bolt');
  check('a provider that states no period is a different kind of absence',
    bolt?.calculated_absent === 'provider_states_no_period', String(bolt?.calculated_absent));
  /* The comparison being MADE must carry no code at all — a code there would
     put a compared row into the "no comparison is made" band. */
  const done = r.rows.find((x) => x.calculated != null);
  check('a row that WAS compared carries no absence code',
    !done || done.calculated_absent === null,
    `${done?.paid_on} -> ${done?.calculated_absent}`);

  const page = readFileSync(new URL('../api/public/payouts.js', import.meta.url), 'utf8');
  check('the page groups on the code and the pair, not on the reason string',
    /\$\{r\.platform\}\|\$\{r\.fleet_id\}\|\$\{r\.calculated_absent\}/.test(page),
    'the grouping key is not built from calculated_absent');
  check('…and it still falls back to the sentence when no code is sent',
    /r\.calculated_absent\s*\n?\s*\?[\s\S]{0,120}:\s*\n?\s*reason;/.test(page),
    'no fallback for a row without a code');
  /* One week named over fifty is a specificity that lies about its scope. */
  check('…and names the SPAN of the weeks rather than the first row’s week',
    /spanning \$\{span\}/.test(page), 'the note does not state a span');
}

m.server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
