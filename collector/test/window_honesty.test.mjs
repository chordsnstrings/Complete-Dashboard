/* ── a page must not send a filter it does not offer ───────────────────────
   bin/page-audit.mjs drives every view at 7 days and again at 365 and asks
   whether the range control on screen governs the numbers under it. On the
   final production sweep it reported four views where the two do not line up,
   and each was a different shape of the same mistake — a request carrying a
   parameter its page has no control for, or its endpoint no use for:

     #coverage    the control is on screen and 0 of 2 windowed calls move —
                  because one of the two, /api/coverage/verified, reads
                  uber_trip_audit and takes only a fleet. It can never move.
     #compare     no control, yet a windowed call. /api/compare reads a, b,
                  cut, fleet and platform and no window: the two days ARE the
                  window. Verified byte-identical over 7d and 365d.
     #capacity    no control, yet /api/platforms — which DOES move: 13,390
                  window bookings at thirty days against 164,169 at a year.
                  The page fits its rota over 84 days and 31,247 bookings and
                  its provenance line quoted the thirty-day figure underneath.
     #settings    the same /api/platforms call, on another page with no range.

   What is pinned here is the rule, not the four instances: the parameters a
   request carries must be the ones its page offers a control for. Static,
   because the alternative is driving 48 views twice, which page-audit already
   does — this is the guard that keeps its verdict from regressing between
   sweeps. */
import { readFileSync } from 'node:fs';
import { NO_RANGE, NO_FILTER, NO_PLATFORM_FLEET, hidesRange, hidesChannel } from '../api/public/data.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const blank = (src) => src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (c, p1) => p1 + ' '.repeat(c.length - p1.length));

console.log('\nthe helpers say what they send');

/* q() sends the window AND the channels; qAll() the window without the
   channels; qChan() the channels without the window; api() neither. A page
   picks by what it offers, so the four have to stay four. */
{
  const data = blank(readFileSync('api/public/data.js', 'utf8'));
  check('q sends both the window and the channels',
    /export const q = \(path, extra\) => api\(`\$\{path\}\?\$\{params\(extra\)\}`\)/.test(data));
  check('qAll sends the window without the channels',
    /export const qAll = \(path, extra\) => api\(`\$\{path\}\?\$\{unfiltered\(extra\)\}`\)/.test(data)
    && /function unfiltered[\s\S]{0,200}windowParams\(\)/.test(data));
  check('qChan sends the channels without the window',
    /export const qChan = /.test(data)
    && /function channels[\s\S]{0,260}state\.platform[\s\S]{0,120}state\.fleet/.test(data)
    && !/function channels[\s\S]{0,260}windowParams/.test(data));
}

console.log('\nthe pages whose range control is hidden do not send a range');

/* The four call sites the sweep named, each asserted by what it now uses.
   Named individually rather than by a grep over every q( in the tree: a page
   that hides the range may still legitimately call q() for an endpoint that
   takes no window at all, and a blanket rule would force churn with no
   meaning. These four were measured wrong. */
{
  const cap = blank(readFileSync('api/public/capacity.js', 'utf8'));
  check('#capacity asks the channels for the window its rota was FITTED over',
    /const fitted = Number\(d\?\.window_days\)/.test(cap)
    && /api\(`\/api\/platforms\?from=/.test(cap)
    && !/q\('\/api\/platforms'\)/.test(cap),
    'the projection is 84 days; the provenance line quoted thirty');
  check('…and the sentence beneath names that number rather than implying one',
    /days it was fitted over/.test(cap) && /\$\{fmt\(fitted\)\}/.test(cap));

  const cmp = blank(readFileSync('api/public/compare.js', 'utf8'));
  check('#compare sends its channels and no window',
    /qChan\('\/api\/compare', \{ a, b, cut \}\)/.test(cmp)
    && !/q\('\/api\/compare'/.test(cmp),
    'the two days are the window; /api/compare reads no other');

  const cov = blank(readFileSync('api/public/coverage.js', 'utf8'));
  check('#coverage sends no window to the endpoint that has no use for one',
    /qChan\('\/api\/coverage\/verified'\)/.test(cov)
    && !/q\('\/api\/coverage\/verified'\)/.test(cov));
  check('…while the windowed calendar beside it still gets the reader’s window',
    /q\('\/api\/coverage\/calendar'\)/.test(cov),
    'that one DOES move, and it is what the range control on this page governs');

  const dr = blank(readFileSync('api/public/daterange.js', 'utf8'));
  check('the date picker asks for the record\u2019s span with no window at all',
    /const rows = await api\('\/api\/platforms'\)/.test(dr) && !/qAll/.test(dr),
    'it reads earliest/latest — all-time fields — and memoises the answer for the page\u2019s life');

  const app = blank(readFileSync('api/public/app.js', 'utf8'));
  check('the provenance line picks its request by BOTH questions, not one',
    /hidesRange\(state\.view\)[\s\S]{0,260}hidesChannel\(state\.view\)[\s\S]{0,120}api\('\/api\/platforms'\)/.test(app),
    'a page hiding the range was sending one anyway');
}

console.log('\nand the lists the rule reads from still mean what they say');

/* The rule is only as good as its inputs: if 'capacity' fell out of NO_FILTER
   the assertions above would still pass while the page grew a control again. */
check('#capacity, #settings and #compare are all pages with no range control',
  hidesRange('capacity') && hidesRange('settings') && hidesRange('compare'),
  JSON.stringify([hidesRange('capacity'), hidesRange('settings'), hidesRange('compare')]));
check('#coverage DOES offer a range control, so its windowed call must move',
  !hidesRange('coverage'), 'if this page stops offering one, the calendar call must go too');
check('#coverage offers no channel chips, which is why qChan there is fleet-free in effect',
  hidesChannel('coverage'));
check('the three lists are disjoint in intent — NO_FILTER hides everything',
  NO_FILTER.every((v) => hidesRange(v) && hidesChannel(v))
  && NO_RANGE.every((v) => hidesRange(v))
  && NO_PLATFORM_FLEET.every((v) => hidesChannel(v)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
