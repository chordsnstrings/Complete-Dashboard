/* The phone's four clocks.
   ─────────────────────────────────────────────────────────────────────────
   test/timezone.test.mjs is the fleet-wide guard and it scans every file under
   api/public. This one is narrower and harder: it checks the PHONE bundle, and
   it checks it twice — once by reading the source, and once by loading the real
   screens in a real browser whose clock is NOT Dubai's, which is the only way
   to observe the bug the reader actually had.

   What was measured on production, 2026-09-02:

     /api/live      L12615 polled_at 2026-09-02T13:00:01.603Z
                    → 17:00 in Dubai, 09:00 in New York, 14:00 in London.
                    #live printed the reader's number beside a fleet whose
                    every other hour label comes from SQL in Dubai.
     /api/status    bolt/backfill finished_at 2026-09-02T12:40:13.916Z
                    → 16:40 in Dubai, 08:40 in New York. The desktop's own
                    Sources table renders this same field through dtStr and
                    said 16:40 on the screen next to it.
     /api/analyst/findings
                    last_run 2026-09-01T23:10:13.470Z
                    → 2026-09-02 03:10 in Dubai but 2026-09-01 19:10 in New
                    York: not three hours out, a DIFFERENT DAY. The phone told
                    a reader in the Americas the analyst had not run today.

   Part 1 reads the source; part 2 needs a browser and the working tree served
   at PHONE_BASE (http://127.0.0.1:8100 by default) and skips itself, loudly,
   when either is missing — a skip is not a pass and is printed as neither. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0, skip = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const skipped = (n, why) => { skip++; console.log(`  – ${n}  (skipped: ${why})`); };

const walk = (dir, ext) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (name.endsWith(ext)) out.push(full);
  }
  return out;
};
const blank = (raw) => raw
  .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (c, p1) => p1 + ' '.repeat(c.length - p1.length));

/* ── 1. no formatter in the phone bundle is left on the reader's clock ─── */
{
  const offenders = [];
  for (const path of walk('api/public/m', '.js')) {
    const raw = readFileSync(path, 'utf8');
    const src = blank(raw);
    const lineOf = (i) => src.slice(0, i).split('\n').length;
    for (const m of src.matchAll(/toLocale(?:Date|Time)String\s*\(([\s\S]{0,220}?)\)/g)) {
      if (/timeZone/.test(m[1])) continue;
      offenders.push(`${path}:${lineOf(m.index)}  ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    for (const m of src.matchAll(/new Date\([^()]*\)\s*\.toLocaleString\s*\(([\s\S]{0,220}?)\)/g)) {
      if (/timeZone/.test(m[1])) continue;
      offenders.push(`${path}:${lineOf(m.index)}  ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    for (const m of src.matchAll(/toISOString\(\)\.slice\(0,\s*10\)/g)) {
      const near = src.slice(Math.max(0, m.index - 220), m.index);
      if (/T12:00:00Z/.test(near)) continue;
      offenders.push(`${path}:${lineOf(m.index)}  UTC day from a clock`);
    }
  }
  check('no phone screen formats a timestamp on the viewer’s clock',
    offenders.length === 0, offenders.length ? `\n      ${offenders.join('\n      ')}` : '');
}

/* ── 2. and none of them writes the zone out by hand ───────────────────── */
{
  /* A literal 'Asia/Dubai' inside a screen passes the rule above and is still
     the wrong shape: it is a fifth copy of an options object whose four
     siblings live in api/public/ui.js, and the day this fleet gains a second
     city it is the copy nobody greps for. m/screens.js:573 was exactly that —
     correct, and unreachable from the constant that decides it. */
  const offenders = [];
  for (const path of walk('api/public/m', '.js')) {
    const src = blank(readFileSync(path, 'utf8'));
    for (const m of src.matchAll(/['"]Asia\/Dubai['"]/g)) {
      offenders.push(`${path}:${src.slice(0, m.index).split('\n').length}  hand-written zone literal`);
    }
  }
  check('the phone names the zone through TZ / the shared formatters, never a literal',
    offenders.length === 0, offenders.length ? `\n      ${offenders.join('\n      ')}` : '');
}

/* ── 3. the shared formatters really are importable from the phone ─────── */
{
  process.env.TZ = 'America/New_York';
  const ui = await import('../api/public/ui.js');
  check('ui.js exports the four formatters the phone needs',
    ['timeStr', 'dtStr', 'dayStr', 'dateStr'].every((k) => typeof ui[k] === 'function'));
  /* The measured production instants, under a process clock nine hours from
     Dubai — a test that only passes in Dubai proves nothing. */
  check('a 13:00Z tracker fix is 17:00, not 09:00',
    ui.timeStr('2026-09-02T13:00:01.603Z') === '17:00', ui.timeStr('2026-09-02T13:00:01.603Z'));
  check('a 12:40Z collector run is 16:40, not 08:40',
    ui.timeStr('2026-09-02T12:40:13.916Z') === '16:40', ui.timeStr('2026-09-02T12:40:13.916Z'));
  check('a 23:10Z analyst pass is on the NEXT Dubai day',
    /Sep\s*2\b/.test(ui.dtStr('2026-09-01T23:10:13.470Z'))
    && /03:10/.test(ui.dtStr('2026-09-01T23:10:13.470Z')),
    ui.dtStr('2026-09-01T23:10:13.470Z'));
  /* And every screen that shows a run/fix time must be able to reach them:
     m/screens.js and m/app.js both already import from '../ui.js', so the
     phone bundle can — there is no bundler boundary to work around. */
  for (const f of ['api/public/m/app.js', 'api/public/m/screens.js']) {
    const src = readFileSync(f, 'utf8');
    check(`${f} pulls its time formatting from the shared module`,
      /from '\.\.\/ui\.js'/.test(src) && /\b(timeStr|dtStr)\b/.test(blank(src)),
      'no timeStr/dtStr imported from ../ui.js');
  }
}

/* ── 4. and on a real phone screen, on a real non-Dubai browser ────────── */
{
  const BASE = process.env.PHONE_BASE || 'http://127.0.0.1:8100';
  let launchChromium = null;
  try { ({ launchChromium } = await import('./browser.mjs')); } catch { /* no playwright */ }
  let up = false;
  try { up = (await fetch(`${BASE}/`, { signal: AbortSignal.timeout(4000) })).ok; } catch { /* not served */ }

  if (!launchChromium || !up) {
    skipped('the rendered phone agrees with Dubai, not with the reader',
      !up ? `nothing serving ${BASE}` : 'playwright unavailable');
  } else {
    const browser = await launchChromium();
    /* Nine hours from Dubai and on the other side of midnight for the analyst's
       last pass: if any of the four is still on the viewer's clock, its text
       differs by a visible amount and, for the analyst, by a whole day. */
    const ctx = await browser.newContext({
      viewport: { width: 412, height: 900 }, deviceScaleFactor: 2,
      isMobile: true, hasTouch: true, timezoneId: 'America/New_York', locale: 'en-US',
    });
    const page = await ctx.newPage();

    /* Each case: the route, the endpoint the number comes from, how to pick the
       instant the screen renders, and the Intl options the screen renders it
       with. Both the Dubai string and the New-York string are computed IN THE
       PAGE from the raw API value, so the assertion is "the screen shows the
       Dubai one and not the local one" rather than a hardcoded clock. */
    const CASES = [
      { route: 'sources', api: '/api/status', label: 'a collector run time',
        pick: (rows) => rows.map((r) => r.finished_at).filter(Boolean).sort().pop(),
        opts: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, kind: 'time' },
      { route: 'live', api: '/api/live', label: 'a tracker fix time',
        pick: (rows) => rows.map((r) => r.polled_at).filter(Boolean).sort().pop(),
        opts: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, kind: 'time' },
      { route: 'analyst', api: '/api/analyst/findings', label: 'the analyst’s last pass',
        pick: (d) => d && d.last_run,
        opts: { day: 'numeric', month: 'short' }, kind: 'day' },
    ];

    for (const c of CASES) {
      /* The instant is taken from the response THE PAGE ITSELF used, not from a
         second fetch of our own. /api/live is a realtime feed: fetched a beat
         before the screen loads it answers with a newer poll, and the test then
         demanded a minute the screen never saw. That is a flake, and a flaky
         timezone guard is a guard people stop believing. */
      let body = null;
      const grab = async (r) => {
        if (body || !r.url().includes(c.api)) return;
        try { body = await r.json(); } catch { /* not the JSON we wanted */ }
      };
      page.on('response', grab);
      await page.goto(`${BASE}/?ui=phone#${c.route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4500);
      page.off('response', grab);
      const raw = body && c.pick(body);
      if (!raw) { skipped(`${c.label} renders in Dubai`, `${c.api} carried no timestamp`); continue; }
      const seen = await page.evaluate(({ raw, opts, kind }) => {
        const d = new Date(raw);
        const f = (tz) => (kind === 'time'
          ? new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz }).format(d)
          : new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz }).format(d));
        return { text: document.body.innerText, dubai: f('Asia/Dubai'), local: f('America/New_York') };
      }, { raw, opts: c.opts, kind: c.kind });

      check(`${c.label} renders in Dubai`, seen.text.includes(seen.dubai),
        `expected "${seen.dubai}" (${raw}); page has "${seen.local}": ${seen.text.includes(seen.local)}`);
      if (seen.dubai !== seen.local) {
        check(`${c.label} does not render on the reader’s clock`,
          !seen.text.includes(seen.local), `page shows the New York value "${seen.local}"`);
      }
    }
    await browser.close();
  }
}

console.log(`\n${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
process.exit(fail ? 1 : 0);
