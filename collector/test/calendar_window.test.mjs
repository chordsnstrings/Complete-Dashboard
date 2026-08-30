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
import { PERIODS as SERVER_PERIODS, periodWindow } from '../api/window.js';

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
check('the desktop control has that option selected in the markup',
  /<option value="p:month" selected>/.test(readFileSync('api/public/index.html', 'utf8')));

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
{
  const html = readFileSync('api/public/index.html', 'utf8');
  const opts = [...html.matchAll(/<option value="p:([a-z_]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]);
  const map = await inPage((d) => d.PERIOD_LABEL);
  check('the desktop control offers every one of them',
    [...opts.map(([k]) => k)].sort().join() === [...labels.keys].sort().join(), JSON.stringify(opts));
  check('and none of them is worded differently from the phone',
    opts.every(([k, t]) => map[k] === t), JSON.stringify(opts));
}
const phone = readFileSync('api/public/m/app.js', 'utf8');
check('the phone builds its sheet from that list rather than its own copy',
  /PERIOD_LABEL/.test(phone) && !/'p:month', 'This month'/.test(phone));
check('and still offers rolling windows, said as rolling',
  /Rolling 30 days/.test(phone));

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

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
