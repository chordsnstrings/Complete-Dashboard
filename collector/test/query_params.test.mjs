/* ── three panels reading "No booking on either day" over 293 bookings ─────
   URLSearchParams stringifies whatever it is handed. `{ fleet: undefined }`
   therefore goes over the wire as `fleet=undefined`, and a route that reads
   `req.query.fleet || null` sees a non-empty string and filters on a fleet by
   that name. Nothing matches. The page renders a perfectly healthy empty
   state, with no error and no warning, and the reader is told there was no
   work on a day the fleet did 293 bookings.

   #compare shipped with exactly that — `fleet: state.fleet || undefined` — and
   it took a DOM-level audit to find, because every layer below it behaved
   correctly: the request was well-formed, the query ran, the answer was an
   honest zero for the filter it was given.

   So params() and unfiltered() drop empty values once, rather than two hundred
   call sites each remembering to. These assertions pin that, and pin the two
   things it must NOT do: drop a legitimate zero, or drop the window.

   Run in Chromium because data.js imports tz.js and reads `location` — the
   same reason test/absent_columns.test.mjs does. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const port = server.address().port;
const browser = await launchChromium();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

const call = (fn, arg) => page.evaluate(async ({ src, a }) => {
  const d = await import('/data.js');
  // eslint-disable-next-line no-new-func
  return new Function('d', 'a', `return (${src})(d, a);`)(d, a);
}, { src: fn.toString(), a: arg });

console.log('\nquery params: an absent value is absent, not the word "undefined"');

const p1 = await call((d, a) => d.params(a), { a: '2026-08-25', fleet: undefined, platform: null });
check('undefined does not become a filter', !/fleet=undefined/.test(p1), p1);
check('null does not become a filter', !/platform=null/.test(p1), p1);
check('the value that WAS given survives', /a=2026-08-25/.test(p1), p1);

const u1 = await call((d, a) => d.unfiltered(a), { id: 'x', limit: undefined });
check('unfiltered() drops them too — every detail page goes through it',
  !/limit=undefined/.test(u1) && /id=x/.test(u1), u1);

console.log('\nquery params: what must NOT be dropped');

const p2 = await call((d) => d.params({ offset: 0, days: 0, term: 'false' }));
check('a legitimate zero survives — offset=0 is the first page, not "no offset"',
  /offset=0/.test(p2), p2);
check('and so does another zero', /days=0/.test(p2), p2);
check('a string that merely looks falsy survives', /term=false/.test(p2), p2);

const p3 = await call((d) => d.params({}));
check('the window is always carried', /from=\d{4}-\d{2}-\d{2}/.test(p3) && /to=\d{4}-\d{2}-\d{2}/.test(p3), p3);
check('and it is a Dubai date, not a UTC one — dubaiDay(), not toISOString()',
  /from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/.test(p3), p3);

console.log('\nquery params: no caller may pass an undefined through');

const { readFileSync, readdirSync } = await import('node:fs');
const offenders = readdirSync('api/public')
  .filter((f) => f.endsWith('.js'))
  .flatMap((f) => {
    const src = readFileSync(`api/public/${f}`, 'utf8');
    /* `x || undefined` inside a q()/qAll() argument object is the exact shape
       that produced the bug: it reads as "omit it", and does the opposite. */
    return [...src.matchAll(/\b(?:q|qAll)\([^)]*\|\|\s*undefined/g)]
      .map(() => `${f}`);
  });
check('no call site writes `something || undefined` into a query object',
  offenders.length === 0, [...new Set(offenders)].join(', '));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
