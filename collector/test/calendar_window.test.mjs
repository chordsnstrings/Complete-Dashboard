/* "Why are we not getting monthly, weekly data instead of 30 days, 7 days?"
   ─────────────────────────────────────────────────────────────────────────
   Because every window in this product was a rolling one, and a rolling
   window cannot answer a calendar question. "Last 30 days" on the 30th of
   August covers the 1st of August to the 30th — and on the 2nd of September
   it covers the 4th of August to the 2nd, which is neither August nor
   September. Two people opening the same page a day apart saw different
   months and the same title.

   Worse, it is why the pages did not agree with each other: a window that
   moves continuously means a figure quoted at 09:00 and the same figure
   checked at 17:00 are honestly different, with nothing on screen to say so.

   So the default is now a calendar month, both kinds are offered on both
   screens, and this file pins the three things that were wrong: the default,
   the round trip through the address, and the label — because a page showing
   August while its header says "Last 30 days" is the bug, restated. */
import express from 'express';
import { readFileSync } from 'node:fs';
import { launchChromium } from './browser.mjs';
import { PERIODS as SERVER_PERIODS, periodWindow, isPeriod, periodPartial } from '../api/window.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const browser = await launchChromium();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'domcontentloaded' });
const inPage = (fn, arg) => page.evaluate(async ({ src, a }) => {
  const d = await import('/data.js');
  // eslint-disable-next-line no-new-func
  return new Function('d', 'a', `return (${src})(d, a);`)(d, a);
}, { src: fn.toString(), a: arg });

console.log('\nthe default window is a calendar month, not thirty days');
check('state opens on a period', await inPage((d) => d.state.period) === 'month');
check('and so does the reset the filter bar restores to',
  await inPage((d) => d.params({})).then((p) => /period=month/.test(p)));
check('the control in the markup is a picker, not a list of fixed choices',
  /<button id="fRange"/.test(readFileSync('api/public/index.html', 'utf8'))
  && !/<select id="fRange"/.test(readFileSync('api/public/index.html', 'utf8')));

console.log('\nboth kinds of window, and never both at once');
const rolling = await inPage((d) => { d.state.period = ''; d.state.days = 7; return d.params({}); });
check('a rolling window sends dates', /from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/.test(rolling), rolling);
check('and no period beside them', !/period=/.test(rolling), rolling);
const period = await inPage((d) => { d.state.period = 'last_month'; return d.params({}); });
check('a period sends its name', /period=last_month/.test(period), period);
check('and no dates beside it', !/from=/.test(period), period);

console.log('\nthe address carries the choice, so a link means one window');
const round = await inPage((d) => {
  const seen = [];
  for (const p of [...d.PERIODS, 'not_a_period']) {
    seen.push([p, d.parseHash(`overview?period=${p}`).period]);
  }
  return { seen, days: d.parseHash('overview?days=7').period, bare: d.parseHash('overview').period };
});
check('every period the control offers survives the round trip',
  round.seen.filter(([p]) => p !== 'not_a_period').every(([p, got]) => p === got),
  JSON.stringify(round.seen));
check('a period nobody offers is dropped rather than sent',
  round.seen.find(([p]) => p === 'not_a_period')[1] !== 'not_a_period');
/* Three states, not two, and this is the one that was wrong: an address
   naming a rolling window must CLEAR the period, or the default reasserts
   itself and the link opens on a different window than it named. */
check('an address naming a rolling window clears the period', round.days === '', JSON.stringify(round.days));
check('and an address naming neither leaves it to the default', round.bare === null, JSON.stringify(round.bare));

console.log('\none list of periods, and one set of labels for them');
const labels = await inPage((d) => ({ keys: Object.keys(d.PERIOD_LABEL), periods: d.PERIODS }));
check('the client offers exactly what the server resolves',
  [...labels.periods].sort().join() === [...SERVER_PERIODS].sort().join(),
  `${labels.periods} vs ${SERVER_PERIODS}`);
check('and every one of them has a label a person can read',
  [...labels.keys].sort().join() === [...labels.periods].sort().join(),
  `${labels.keys} vs ${labels.periods}`);
const picker = readFileSync('api/public/daterange.js', 'utf8');
check('one picker, built from that list, and it is the file both hosts import',
  /PERIODS\.map/.test(picker) && /PERIOD_LABEL\[k\]/.test(picker));
const phone = readFileSync('api/public/m/app.js', 'utf8');
check('the phone opens the same panel rather than keeping its own list',
  /rangePanel/.test(phone) && !/'p:month', 'This month'/.test(phone)
  && !/const RANGES = \[/.test(phone));
const desk = readFileSync('api/public/app.js', 'utf8');
check('and so does the desktop', /rangePanel/.test(desk));

console.log('\nthe label on screen names the window on screen');
const named = await inPage((d) => {
  d.state.period = 'last_month'; const a = d.windowLabel();
  d.state.period = ''; d.state.days = 90; const b = d.windowLabel();
  d.state.period = 'month'; return [a, b, d.windowLabel()];
});
check('a period is called by its name', named[0] === 'Last month', named[0]);
check('a rolling window says how long it is', named[1] === 'Last 90 days', named[1]);
check('and the default reads as a month, not as thirty days', named[2] === 'This month', named[2]);
const screens = readFileSync('api/public/m/screens.js', 'utf8');
check('the phone header takes its wording from there too',
  /windowLabel\(\)/.test(screens) && !/Last \$\{state\.days\} days/.test(screens));

console.log('\nthe period the client names is the window the server resolves');
/* The client deliberately does not compute month boundaries — it sends the
   name. This is the check that the name means what the control says it
   means, because a client and a server with two calendars is the oldest bug
   in reporting. */
const now = new Date('2026-08-30T12:00:00+04:00');
const [mf, mt] = periodWindow('month', now);
check('this month starts on the 1st', /-01$/.test(mf), mf);
check('and ends today, not at the end of the month', mt === '2026-08-30', mt);
const [lf, lt] = periodWindow('last_month', now);
check('last month is the whole of the month before', lf === '2026-07-01' && lt === '2026-07-31', `${lf}→${lt}`);
const [wf] = periodWindow('week', now);
check('a week starts on a Monday', new Date(`${wf}T00:00:00Z`).getUTCDay() === 1, wf);

/* ── a span named outright ────────────────────────────────────────────── */
console.log('\nAugust 2026, not "this month"');
/* "This month" is the right frame while the month is running and useless the
   moment somebody wants to talk about August — and a relative name cannot be
   sent to anybody, because `period=month` opens on whatever month the reader
   opens it in. */
{
  const at = new Date('2026-08-30T12:00:00+04:00');
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('a finished month is the whole of it',
    eq(periodWindow('2026-07', at), ['2026-07-01', '2026-07-31']),
    JSON.stringify(periodWindow('2026-07', at)));
  check('the month containing today runs to today, not to its own end',
    eq(periodWindow('2026-08', at), ['2026-08-01', '2026-08-30']),
    JSON.stringify(periodWindow('2026-08', at)));
  check('February gets its leap day right without a table of lengths',
    eq(periodWindow('2024-02', at), ['2024-02-01', '2024-02-29']),
    JSON.stringify(periodWindow('2024-02', at)));
  check('and not in a year that has none',
    eq(periodWindow('2026-02', at), ['2026-02-01', '2026-02-28']),
    JSON.stringify(periodWindow('2026-02', at)));
  check('a quarter is its three months',
    eq(periodWindow('2026-Q1', at), ['2026-01-01', '2026-03-31']),
    JSON.stringify(periodWindow('2026-Q1', at)));
  check('the quarter containing today stops at today',
    eq(periodWindow('2026-Q3', at), ['2026-07-01', '2026-08-30']),
    JSON.stringify(periodWindow('2026-Q3', at)));
  check('a finished year is whole', eq(periodWindow('2025', at), ['2025-01-01', '2025-12-31']));
  check('and this year is to date', eq(periodWindow('2026', at), ['2026-01-01', '2026-08-30']));
  /* A span that has not started is not truncated to today — it returns its own
     dates and the pages report honestly that they hold nothing for it. */
  check('a future month keeps its own dates rather than collapsing onto today',
    eq(periodWindow('2026-11', at), ['2026-11-01', '2026-11-30']),
    JSON.stringify(periodWindow('2026-11', at)));
  for (const bad of ['2026-13', '2026-00', '2026-8', '20260-01', '2026-Q5', 'august', '']) {
    check(`a span nobody can mean is refused rather than guessed at — ${JSON.stringify(bad)}`,
      periodWindow(bad, at) === null, JSON.stringify(periodWindow(bad, at)));
  }
  check('and the validator agrees with the parser on every one of them',
    ['2026-08', '2026-Q3', '2026', 'month'].every((v) => isPeriod(v))
    && !['2026-13', '2026-Q5', 'august'].some((v) => isPeriod(v)));
}

console.log('\na span still running says so');
/* A page headed "August 2026" over two thirds of August is the same mistake
   as a thirty-day figure headed "this month". `partial` used to be tested
   against a list of five relative words, so a named month never carried it. */
{
  const at = new Date('2026-08-30T12:00:00+04:00');
  const cases = [['2026-08', true], ['2026-07', false], ['2026-Q3', true], ['2026-Q2', false],
    ['2026', true], ['2025', false], ['month', true], ['last_month', false],
    ['today', true], ['yesterday', false], ['2026-11', false]];
  for (const [name, want] of cases) {
    check(`${name} is ${want ? 'still running' : 'finished'}`,
      periodPartial(name, at) === want, String(periodPartial(name, at)));
  }
  /* The last day of a span is the one that used to disagree with itself: on
     the 31st of August, `month` and `2026-08` resolve to identical dates, and
     one of them called itself whole. */
  const last = new Date('2026-08-31T08:30:00+04:00');
  check('a named month containing today is partial on its own last day too',
    periodPartial('2026-08', last) === true && periodPartial('month', last) === true);
  check('and is finished the moment the next one starts',
    periodPartial('2026-08', new Date('2026-09-01T01:00:00+04:00')) === false);
  check('the two ways of naming the same span agree about it',
    JSON.stringify(periodWindow('2026-08', last)) === JSON.stringify(periodWindow('month', last)),
    `${JSON.stringify(periodWindow('2026-08', last))} vs ${JSON.stringify(periodWindow('month', last))}`);
  check('and the echo names the span that was asked for, not null',
    isPeriod('2026-08') && isPeriod('2026-Q3') && isPeriod('2026'));
}

console.log('\nthe client names the same spans, in words');
{
  const named = await inPage((d) => [d.periodLabel('2026-08'), d.periodLabel('2026-01'),
    d.periodLabel('2026-Q3'), d.periodLabel('2026'), d.periodLabel('last_month'),
    d.dayLabel('2026-08-03'), d.isPeriod('2026-08'), d.isPeriod('2026-13')]);
  check('a month is written with its year on it', named[0] === 'August 2026', named[0]);
  check('and so is January', named[1] === 'January 2026', named[1]);
  check('a quarter reads as a quarter', named[2] === 'Q3 2026', named[2]);
  check('a year is its own name', named[3] === '2026', named[3]);
  check('a relative period keeps its words', named[4] === 'Last month', named[4]);
  check('a date carries its year too — "3 Aug" is ambiguous over a year of data',
    named[5] === '3 Aug 2026', named[5]);
  check('the client validates spans the way the server resolves them',
    named[6] === true && named[7] === false, JSON.stringify(named.slice(6)));
}

console.log('\nan explicit range outranks both, and clears them');
{
  const r = await inPage((d) => {
    d.state.period = 'month'; d.state.from = '2026-08-03'; d.state.to = '2026-08-19';
    const p = d.params({});
    const lab = d.windowLabel();
    d.state.from = ''; d.state.to = ''; d.state.period = 'month';
    return { p, lab };
  });
  check('two dates are sent as two dates', /from=2026-08-03&to=2026-08-19/.test(r.p), r.p);
  check('and no period rides along beside them', !/period=/.test(r.p), r.p);
  check('the header names the two ends, with their year',
    r.lab === '3 Aug 2026 – 19 Aug 2026', r.lab);
  const round = await inPage((d) => {
    const h = d.parseHash('overview?from=2026-08-03&to=2026-08-19');
    return [h.from, h.to, h.period, d.parseHash('overview?from=2026-13-99&to=x').from];
  });
  check('a range survives the round trip through the address',
    round[0] === '2026-08-03' && round[1] === '2026-08-19', JSON.stringify(round));
  check('and clears the period, so the link means one window', round[2] === '', JSON.stringify(round[2]));
  check('a date-shaped value that is not a date is dropped, not bound into SQL',
    round[3] === null, JSON.stringify(round[3]));
}

/* ── the control itself, driven ───────────────────────────────────────── */
/* Source-shape checks cannot tell whether the panel is reachable, whether a
   month button writes the month it says, or whether the picker closes. This
   drives the real control against the real router. */
console.log('\nthe picker, clicked');
{
  const shell = express();
  shell.use(express.static('api/public'));
  /* No API behind it — this is about the control, and every fetch failing is
     fine as long as the control still writes the right address. */
  shell.use('/api', (_, res) => res.status(503).json({ error: 'no api in this test' }));
  const srv = shell.listen(0);
  const ui = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const thrown = [];
  ui.on('pageerror', (e) => thrown.push(String(e.message)));
  await ui.goto(`http://127.0.0.1:${srv.address().port}/?ui=desktop#overview`,
    { waitUntil: 'domcontentloaded' });
  await ui.waitForTimeout(1500);

  const open = async () => { await ui.click('#fRange'); await ui.waitForTimeout(250); };
  const label = () => ui.evaluate(() => document.querySelector('#fRangeLabel').textContent);
  const hash = () => ui.evaluate(() => location.hash);

  await open();
  check('the button opens a panel', await ui.evaluate(() => !!document.querySelector('.rangepanel')));
  check('and says so for a screen reader',
    await ui.evaluate(() => document.querySelector('#fRange').getAttribute('aria-expanded')) === 'true');
  check('the panel offers months by name', await ui.evaluate(() =>
    [...document.querySelectorAll('.rp-m')].map((b) => b.textContent).join(',')) === 'Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec');
  check('a month that has not happened cannot be picked', await ui.evaluate(() => {
    const now = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
    const m = Number(now.slice(5, 7));
    return [...document.querySelectorAll('.rp-m')].every((b, i) => b.disabled === (i + 1 > m));
  }));

  await ui.click('.rp-m:not(:disabled)');
  await ui.waitForTimeout(400);
  check('picking one closes the panel', await ui.evaluate(() => !document.querySelector('.rangepanel')));
  check('and writes the month into the address', /period=\d{4}-\d{2}/.test(await hash()), await hash());
  check('and the button says which month, with its year',
    /^[A-Z][a-z]+ \d{4}$/.test(await label()), await label());

  await open();
  await ui.locator('.rp-dates input').first().fill('2026-08-03');
  await ui.locator('.rp-dates input').nth(1).fill('2026-08-19');
  await ui.waitForTimeout(150);
  await ui.click('.rp-apply');
  await ui.waitForTimeout(400);
  check('two dates go into the address as two dates',
    (await hash()).includes('from=2026-08-03&to=2026-08-19'), await hash());
  check('and never beside a period', !(await hash()).includes('period='), await hash());
  check('the button reads as the range it is showing',
    (await label()) === '3 Aug 2026 – 19 Aug 2026', await label());

  /* Backwards is a typo, not an empty window. The server would swap them; so
     does the control, so the address that gets shared is the corrected one. */
  await open();
  await ui.locator('.rp-dates input').first().fill('2026-08-19');
  await ui.locator('.rp-dates input').nth(1).fill('2026-08-03');
  await ui.waitForTimeout(150);
  await ui.click('.rp-apply');
  await ui.waitForTimeout(400);
  check('an inverted range is swapped rather than shown as nothing',
    (await hash()).includes('from=2026-08-03&to=2026-08-19'), await hash());

  await open();
  await ui.keyboard.press('Escape');
  await ui.waitForTimeout(250);
  check('Escape closes it', await ui.evaluate(() => !document.querySelector('.rangepanel')));
  check('nothing threw through any of that', thrown.length === 0, thrown.join(' | '));
  await ui.close();
  srv.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
