/* A page that fetches with filterQuery() is a page whose window governs nothing.
   ──────────────────────────────────────────────────────────────────────────
   data.js exports two things that look interchangeable and are not:

     filterQuery(view)  builds the query string for a LINK. It omits the window
                        entirely on views that hide the range control, because
                        an address carrying a filter its destination hides is a
                        filter nobody can see or undo.
     params() / q()     build the query string for a FETCH. Exactly one window
                        is always sent — from/to, or a period, or computed
                        dates — so a route never has to guess.

   #cancellations shipped using the first. Nothing failed: the page rendered,
   the table filled, and every figure was the WHOLE RECORD. Production served
   68,194 cancellations and 5,321 bookings against a single driver under a URL
   reading `period=yesterday`, because a route given no window falls back to
   2000-01-01..2100-01-01.

   That is the worst shape a bug can take here — a control that appears to
   bound a figure and does not. The operator who spotted it had to read the
   numbers and disbelieve them; nothing on the screen said anything was wrong.

   So it is checked rather than remembered. Any api() call whose URL is built
   from filterQuery is a fetch that may carry no window at all. */
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nevery page fetches with the window, not with a link builder');

const dir = new URL('../api/public/', import.meta.url);
const pages = readdirSync(dir).filter((f) => f.endsWith('.js'));
const offenders = [];
for (const f of pages) {
  const src = readFileSync(new URL(f, dir), 'utf8');
  /* api(`…${filterQuery(…)}…`) in any spacing, and the same through fetch(). */
  const re = /(?:\bapi|\bfetch)\s*\(\s*`[^`]*\$\{\s*filterQuery\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    offenders.push(`${f}: fetches with filterQuery() — use q() so the window is sent`);
  }
}
check('no page builds a fetch URL from filterQuery()', offenders.length === 0,
  offenders.join('; '));

/* The other half of the same rule: data.js must keep them distinct. If params()
   ever stopped sending a window this test would still pass above while every
   page silently went unbounded, so the guarantee is asserted where it lives. */
const data = readFileSync(new URL('data.js', dir), 'utf8');
check('params() always sends exactly one window',
  /function windowParams\(\)[\s\S]*?if \(state\.from && state\.to\) return[\s\S]*?if \(state\.period\) return[\s\S]*?windowDates\(\)/.test(data),
  'windowParams() no longer returns a window in all three cases');
check('…and params() spreads it into every request',
  /export function params\([\s\S]{0,200}\.\.\.windowParams\(\)/.test(data));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
