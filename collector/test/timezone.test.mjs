/* One clock: Dubai's.
   ─────────────────────────────────────────────────────────────────────────
   The fleet works in one city. Postgres runs its session in UTC, Node runs
   wherever the container is, and the browser runs wherever the person reading
   the page is — three clocks, and a booking taken at 01:00 on the 5th in Dubai
   is 21:00 on the 4th in all three of them.

   The SQL side was fixed a while ago: every calendar key the API computes goes
   through AT TIME ZONE 'Asia/Dubai'. The BROWSER side was not, and the two
   disagreed on the same screen — a segment starting at 17:00 Dubai printed as
   13:00 for a reader in London, beside an hour-of-day chart from SQL whose peak
   was at 17. A driver's shift read three hours early. And the shared window was
   built from `new Date().toISOString().slice(0, 10)`, the UTC day, so at 02:00
   in Dubai "last 30 days" ended yesterday and dropped the shift in progress.

   This pins both halves, and it runs the browser half under a NON-Dubai
   process timezone, because a test that only passes in Dubai proves nothing
   about the people this was broken for. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/* Every file, not every file in the top of a directory.
   ─────────────────────────────────────────────────────────────────────────
   Both halves of this guard used a flat readdirSync, so what it actually
   checked was api/*.js and src/*.js — and the product's twelve collectors live
   in src/sources/, its phone screens in api/public/m/, and its generated
   calendar columns in sql/*.sql. None of those were ever scanned.

   Measured 2026-09-02 by running the guard's own rules over the directories it
   skips: four real offenders, none of which it could see. Three of them are on
   the phone — a tracker fix time, a collector run time and the analyst's last
   pass, each rendered on whatever clock the reader is holding — and the fourth
   buckets trips into months by UTC, so a 01:00 Dubai booking on the 1st counts
   against the previous month.

   A lint whose reach is narrower than the thing it protects reports clean
   forever, which is worse than not having it: this file's own header claims
   "every calendar key the API computes goes through AT TIME ZONE 'Asia/Dubai'"
   and that claim was only ever checked in two directories. */
const walk = (dir, ext) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, ext));
    else if (name.endsWith(ext)) out.push(full);
  }
  return out;
};

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── 1. the SQL half: no calendar key without the conversion ───────────── */
{
  /* Timestamp columns whose CALENDAR position is a business fact. Durations
     (extract(epoch from a - b)) are zone-independent and are not listed. */
  const TS = '(requested_at|ended_at|occurred_at|captured_at|polled_at|started_at|event_at|first_trip_at|last_trip_at)';
  const DERIVATIONS = [
    [new RegExp(`(?<!ZONE '[^']*'\\)\\s*)\\b${TS}\\s*::\\s*date`, 'g'), 'a bare ::date'],
    [new RegExp(`date_trunc\\(\\s*'(?:day|week|month)'\\s*,\\s*[\\w.]*${TS}\\s*\\)`, 'g'), 'date_trunc'],
    [new RegExp(`extract\\(\\s*(?:hour|dow|isodow|day|month|year)\\s+from\\s+[\\w.]*${TS}\\s*\\)`, 'gi'), 'extract'],
  ];
  const offenders = [];
  {
    /* .sql as well as .js: sql/schema_*.sql is where the generated local_day
       and local_hour columns are declared, and a generated column computed on
       the wrong clock is the one nothing downstream can correct. */
    for (const path of [...walk('api', '.js'), ...walk('src', '.js'), ...walk('sql', '.sql')]) {
      const dir = path.slice(0, path.lastIndexOf('/'));
      const f = path.slice(path.lastIndexOf('/') + 1);
      const src = readFileSync(path, 'utf8');
      for (const m of src.matchAll(/`([^`]*(?:SELECT|INSERT|UPDATE)[^`]*)`/gs)) {
        for (const [re, what] of DERIVATIONS) {
          for (const g of m[1].matchAll(re)) {
            // The conversion must be inside the derivation itself, not merely
            // somewhere in a statement that also does something else.
            const near = m[1].slice(Math.max(0, g.index - 80), g.index + g[0].length + 10);
            if (/AT TIME ZONE 'Asia\/Dubai'/.test(near)) continue;
            const line = src.slice(0, m.index + 1 + g.index).split('\n').length;
            offenders.push(`${dir}/${f}:${line}  ${what}  ${g[0].replace(/\s+/g, ' ').slice(0, 70)}`);
          }
        }
      }
    }
  }
  check('no calendar key is derived from a timestamp without converting to Dubai',
    offenders.length === 0, offenders.length ? `\n      ${offenders.join('\n      ')}` : '');
}

/* ── 2. the browser half: no formatter left on the viewer's clock ──────── */
{
  const offenders = [];
  for (const path of walk('api/public', '.js')) {
    const f = path.replace(/^api\/public\//, '');
    const raw = readFileSync(path, 'utf8');
    /* Comments blanked, length-preserving so line numbers survive. These files
       explain the trap in prose — tz.js's own header quotes
       `toISOString().slice(0, 10)` as the thing not to do — and a lint that
       reads its own documentation as a violation is a lint people switch off. */
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (c, p1) => p1 + ' '.repeat(c.length - p1.length));
    const lineOf = (idx) => src.slice(0, idx).split('\n').length;
    /* Matched over the WHOLE source, not line by line. The first version of
       this ran per line, so it could not see a call whose options object is on
       the next line — which is how every one of these is written once the
       timeZone option makes the line too long. It reported clean against the
       exact code it exists to check. */
    /* No trailing anchor. It used to require the call to be followed by `;`,
       `,` or `)`, and the shape this product actually writes is a ternary —
       `… .toLocaleTimeString([], {…}) : 'never'` — whose next character is a
       colon. m/screens.js:515 rendered a collector run time on the reader's
       clock and matched nothing for want of that one character. */
    for (const m of src.matchAll(/toLocale(?:Date|Time)String\s*\(([\s\S]{0,220}?)\)/g)) {
      if (/timeZone/.test(m[1])) continue;
      offenders.push(`api/public/${f}:${lineOf(m.index)}  ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    /* toLocaleString on a DATE. The bare name is not enough on its own —
       Number(n).toLocaleString() is how every figure on every page is
       formatted, and a lint that flags those is a lint nobody runs — so the
       receiver has to be a date. m/screens.js:875 printed the analyst's last
       pass as `new Date(d.last_run).toLocaleString()`: no options at all, the
       worst of the three shapes and the only one the old rule could not name. */
    for (const m of src.matchAll(/new Date\([^()]*\)\s*\.toLocaleString\s*\(([\s\S]{0,220}?)\)/g)) {
      if (/timeZone/.test(m[1])) continue;
      offenders.push(`api/public/${f}:${lineOf(m.index)}  ${m[0].replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    /* The UTC day, taken from a clock, used as a business date.
       Date arithmetic on a YYYY-MM-DD string is a different thing and is fine:
       anchoring at T12:00:00Z (16:00 in Dubai) puts the instant far enough from
       both midnights that adding days and reading the UTC date back cannot
       cross one. Recognised by that anchor nearby, because writing it is the
       whole point of choosing noon. */
    for (const m of src.matchAll(/toISOString\(\)\.slice\(0,\s*10\)/g)) {
      const near = src.slice(Math.max(0, m.index - 220), m.index);
      if (/T12:00:00Z/.test(near)) continue;
      offenders.push(`api/public/${f}:${lineOf(m.index)}  UTC day from a clock`);
    }
  }
  check('no date or time is rendered in the viewer’s own timezone',
    offenders.length === 0, offenders.length ? `\n      ${offenders.join('\n      ')}` : '');
}

/* ── 3. the window the whole app shares is Dubai days ──────────────────── */
{
  /* Run under a zone twelve hours from Dubai, so a UTC-day or local-day
     implementation gives a different answer from the right one. */
  process.env.TZ = 'Pacific/Honolulu';
  const { dubaiDay } = await import('../api/public/tz.js');
  const at = (iso) => dubaiDay(new Date(iso));
  check('01:00 in Dubai is that day, not the day before',
    at('2026-08-05T21:05:00Z') === '2026-08-06', at('2026-08-05T21:05:00Z'));
  check('23:00 in Dubai is still that day',
    at('2026-08-05T19:00:00Z') === '2026-08-05', at('2026-08-05T19:00:00Z'));
  check('and midnight UTC is already the next day in Dubai',
    at('2026-08-05T20:30:00Z') === '2026-08-06', at('2026-08-05T20:30:00Z'));

  const { windowDates } = await import('../api/public/data.js');
  const [from, to] = windowDates();
  check('the shared window is a pair of Dubai dates',
    /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to,
    `${from} → ${to}`);
  check('and its end is today in Dubai, not today in UTC or in the browser',
    to === dubaiDay(), `${to} vs ${dubaiDay()}`);
}

/* ── 4. and the API agrees with it, over a real database ───────────────── */
{
  const db = new PGlite();
  await applySchema(db);
  const q = (t, p = []) => db.query(t, p);
  /* 01:00 on the 6th in Dubai. In UTC this is 21:00 on the 5th — so every page
     that reads a UTC day puts this booking on the wrong day, and the driver
     whose shift it ends looks like they worked two days. */
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
             requested_at, status, distance_km, price)
           VALUES ('uber','tz1','ecosine','L100','u1','Night Driver',
                   '2026-08-06T01:00:00+04:00','completed',14,55)`);
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
             requested_at, status, distance_km, price)
           VALUES ('uber','tz2','ecosine','L100','u1','Night Driver',
                   '2026-08-05T23:30:00+04:00','completed',9,40)`);
  await q(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
           VALUES ('fms','tza','ecosine','L100','Harsh Brake','2026-08-06T01:10:00+04:00')`);
  await q(`INSERT INTO occupancy_segment (plate, started_at, ended_at, fleet_id, duration_min,
             distance_km, verdict)
           VALUES ('L100','2026-08-06T01:20:00+04:00','2026-08-06T01:44:00+04:00','ecosine',24,11,'unauthorized')`);

  const { get, server } = await mountAll(db);
  const d6 = (await get('/api/day?day=2026-08-06')).body;
  const d5 = (await get('/api/day?day=2026-08-05')).body;
  check('a 01:00 Dubai booking is on that Dubai day', d6.headline.bookings === 1,
    `${d6.headline.bookings} on the 6th`);
  check('and the 23:30 booking the evening before is on the previous one',
    d5.headline.bookings === 1, `${d5.headline.bookings} on the 5th`);
  check('the harsh-driving event lands on the same day as the trip it happened during',
    (d6.alerts || []).reduce((a, r) => a + r.n, 0) === 1,
    JSON.stringify(d6.alerts));
  check('and so does the unexplained segment',
    (d6.segments || []).length === 1, String((d6.segments || []).length));

  const daily = (await get('/api/trips/daily?from=2026-08-01&to=2026-08-31')).body;
  const byDay = Object.fromEntries((daily || []).map((r) => [String(r.d).slice(0, 10), r.trips]));
  check('the daily series puts them on the same two days the day pages do',
    byDay['2026-08-06'] === 1 && byDay['2026-08-05'] === 1, JSON.stringify(byDay));

  const hours = (await get('/api/trips/hourly?from=2026-08-01&to=2026-08-31')).body;
  const h1 = (hours || []).find((r) => Number(r.h) === 1);
  check('the hourly curve puts the 01:00 booking at hour 1, not at 21',
    h1 && h1.trips === 1, JSON.stringify(hours));

  server.close(); await db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
