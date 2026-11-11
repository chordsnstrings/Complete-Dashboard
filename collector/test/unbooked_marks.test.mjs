/* Journeys no channel booked, on a person's Activity bars and day page.
   ───────────────────────────────────────────────────────────────────────
   The operator, 2026-10-14: "unauthorized trips should show on activity tab
   and daily pages". Held here, in a real browser against the mock, with
   /api/driver/unauthorized answered by a fixture written for this test:

     · a ride is the reading the server counts once; a second reading of the
       same ride is not a second mark, and a ride named by one reading and a
       candidate by the other is NAMED and says so (api/public/unbooked.js);
     · named rides are solid, one-of-several hollow, each at its real time on
       its own day, with the rung in words;
     · on the day page the rides are a row on the band and entries in the list
       of jobs, at their time, never in a job's colours;
     · a failed answer claims nothing, a refused one says the role.

   Synthetic people and places only. */
import { chromium } from 'playwright';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const { app } = await import('../mockapi.mjs');
const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;

/* The days the mock's shift answer draws, so the fixture lands on them. */
const shift = await (await fetch(`${base}/api/driver/shift?id=drv-0`)).json();
const drawn = (shift.days || []).filter((d) => d.first_min != null).map((d) => d.day);
const D1 = drawn[drawn.length - 2];          // a drawn day
const D2 = drawn[drawn.length - 1];          // another
const at = (day, hhmm) => new Date(`${day}T${hhmm}:00+04:00`).toISOString();
/* What a reading carries that a person can act on (2026-11-11): the seat
   count, the fares forgone at the fleet's AED/km and the nearest booking. */
const RATE_BASIS = 'the fleet’s own rate over this window — AED 4.5/km. Revenue forgone, not a cash cost.';
/* The shapes the server sends (api/unauthorized_routes.js dress(), src/reconcile.js). */
const NO_RATE = 'no booking in this window carries both a fare and a distance, so there is no rate to value this at';
const seg = (o) => ({ verdict: 'unauthorized', fleet_id: 'ecosine', plate: 'TST001', counts_once: true,
  source: 'fms_trip', source_label: 'FMS trip seat count', distance_km: 9.5,
  passengers: 2, forgone_aed: 42.75, aed_per_km: 4.5, rate_basis: RATE_BASIS, nearest_platform: 'uber', nearest_gap_min: 95,
  verdict_reason: 'no completed booking overlaps; nearest is a uber trip 95 min away', channels_checked: 'bolt,hotel,uber,yango',
  start_place: { area: 'Test Origin' }, end_place: { area: 'Test Destination' }, ...o });
/* A place name past fifteen words with its label: data, never folded. */
const LONG_PLACE = 'Test Origin Marasi Drive Business Bay Tower Two Gate Three Near The Long Bridge By The Water Front';
/* Ride A on D1 23:10–23:40: two readings, both naming this person (last trip).
   Ride B on D2 10:00–10:30: the counted reading a candidate, the other naming
   them — named by one reading, one of several by the other.
   Ride C on D2 15:00–15:20: a candidate only. */
const named = [
  seg({ started_at: at(D1, '23:10'), ended_at: at(D1, '23:40'), attribution_tier: 'last_trip',
    attribution_evidence: 'The last Uber trip on TST001 before this journey was theirs, 12 minutes before.' }),
  seg({ started_at: at(D1, '23:11'), ended_at: at(D1, '23:39'), source: 'fms_live', source_label: 'FMS live seat count',
    counts_once: false, attribution_tier: 'last_trip' }),
  seg({ started_at: at(D2, '10:01'), ended_at: at(D2, '10:29'), source: 'fms_live', source_label: 'FMS live seat count',
    counts_once: false, attribution_tier: 'bracketed', attribution_evidence: 'Named by time on TST001.' }),
];
const cands = [
  seg({ started_at: at(D2, '10:00'), ended_at: at(D2, '10:30'), attribution_tier: 'ambiguous', start_place: { area: LONG_PLACE } }),
  /* A CABMAN reading (no seat count), on a day with no rate, and no booking
     of any kind near it — each said absent WITH its reason, never as 0. */
  seg({ started_at: at(D2, '15:00'), ended_at: at(D2, '15:20'), attribution_tier: 'ambiguous', distance_km: 4.1,
    source: 'cabman', source_label: 'CABMAN DT', passengers: null, forgone_aed: null, aed_per_km: null, rate_basis: NO_RATE,
    nearest_platform: null, nearest_gap_min: null,
    verdict_reason: 'no booking of any kind on this plate in the window, across bolt, hotel, uber, yango' }),
];
const BODY = {
  driver: { id: 'drv-0' },
  attributed: { rows: named, total: 1, shown: named.length },
  also_a_candidate: { rows: cands, total: 2, shown: cands.length },
  coverage: { days_with_data: 14, days_in_window: 14, scope: 'the 1 car(s) this person held in this window' },
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const open = async (hash, answer, query = '') => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  await page.route('**/api/driver/unauthorized**', (r) => answer(r));
  await page.goto(`${base}/${query}#${hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  return { page, errs, close: () => ctx.close() };
};
const json = (body, status = 200) => (r) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

console.log('\nActivity: the rides on their days, named solid and one-of-several hollow');
{
  const p = await open('driver/drv-0/activity', json(BODY));
  await p.page.waitForSelector('.unbooked-note .cap', { timeout: 15000 }).catch(() => {});
  const got = await p.page.evaluate(([d1, d2]) => {
    const marks = (d) => [...document.querySelectorAll(`.shift[data-day="${d}"] .sh-track > i.x, .shift[data-day="${d}"] .sh-track > i.xc`)]
      .map((i) => ({ cls: i.className, left: parseFloat(i.style.left), title: i.title }));
    return { d1: marks(d1), d2: marks(d2), legend: document.querySelector('.lgnd')?.textContent || '',
      cap: document.querySelector('.unbooked-note')?.textContent || '',
      link: document.querySelector('.unbooked-note a')?.getAttribute('href') || '' };
  }, [D1, D2]);
  check('a ride two sensors read is ONE mark, named, at 23:10', got.d1.length === 1 && got.d1[0].cls === 'x'
    && Math.abs(got.d1[0].left - (23 * 60 + 10) / 14.4) < 0.1, JSON.stringify(got.d1));
  check('…its title says the rung in words', /the last Uber trip on the car before it was theirs/.test(got.d1[0]?.title || ''), got.d1[0]?.title);
  const b = got.d2.find((m) => Math.abs(m.left - 600 / 14.4) < 0.2);
  const c = got.d2.find((m) => Math.abs(m.left - 900 / 14.4) < 0.2);
  check('a ride named by one reading and a candidate by the other is NAMED, and says both', b && b.cls === 'x'
    && /named by one sensor reading, one of several by the other/.test(b.title), JSON.stringify(b));
  check('a candidate-only ride is hollow', c && c.cls === 'xc' && /one of several people who held the car/.test(c.title), JSON.stringify(c));
  check('three rides, three marks — the second reading of a ride is not drawn again', got.d1.length + got.d2.length === 3, JSON.stringify([got.d1.length, got.d2.length]));
  check('the legend names both forms', /this person named beside it/.test(got.legend) && /one of several who held the car/.test(got.legend), got.legend);
  check('the sentence counts by rung, says the disagreement, and that none of it is who drove',
    /2 rides where they are named beside it \(1 by time, 1 by the last trip on the car\), one of them named by one sensor reading and one of several by the other/.test(got.cap)
      && /1 ride where they are one of several/.test(got.cap) && /never a record of who drove/.test(got.cap), got.cap);
  check('…what the seat sensor watched', /The seat sensor watched 14 of 14 days/.test(got.cap), got.cap);
  check('…and the way to the working', /#driver\/.+\/unauthorized/.test(got.link), got.link);
  check('nothing on the page threw', !p.errs.length, p.errs.join(' | '));
  await p.close();
}

console.log('\nActivity: a ride on a day with no bar is counted in words, and the key names no mark it did not draw');
{
  const OFF = '2020-01-15';
  const off = { ...BODY, attributed: { rows: [seg({ started_at: at(OFF, '09:00'), ended_at: at(OFF, '09:30'), attribution_tier: 'last_trip' })], total: 1, shown: 1 },
    also_a_candidate: { rows: [], total: 0, shown: 0 } };
  const p = await open('driver/drv-0/activity', json(off));
  await p.page.waitForSelector('.unbooked-note .cap', { timeout: 15000 }).catch(() => {});
  const t = await p.page.evaluate(() => ({ legend: document.querySelector('.lgnd')?.textContent || '',
    cap: document.querySelector('.unbooked-note')?.textContent || '',
    marks: document.querySelectorAll('.sh-track > i.x, .sh-track > i.xc').length }));
  check('no mark drawn, so no key entry for one', t.marks === 0 && !/unbooked journey/.test(t.legend), JSON.stringify(t).slice(0, 300));
  check('…and the ride is still counted, with why it is not on the chart', /1 ride where they are named beside it/.test(t.cap)
    && /1 day with one has no bar above/.test(t.cap), t.cap);
  await p.close();
}

console.log('\nA capped answer says where it stops, on both pages');
{
  const capped = { ...BODY, truncated: true };
  const p = await open('driver/drv-0/activity', json(capped));
  await p.page.waitForSelector('.unbooked-note .cap', { timeout: 15000 }).catch(() => {});
  const cap = await p.page.evaluate(() => document.querySelector('.unbooked-note')?.textContent || '');
  check('Activity: "only its newest 5 sensor readings, reaching back to" the oldest day returned', new RegExp(`only its newest 5 sensor readings, reaching back to ${D1}`).test(cap), cap);
  await p.close();
  const q = await open(`driver/drv-0/day?on=${D1}`, json(capped));
  await q.page.waitForFunction(() => document.querySelector('[data-unbooked]'), null, { timeout: 20000 }).catch(() => {});
  const said = await q.page.evaluate(() => [...document.querySelectorAll('.dday-onbasis')].map((x) => x.textContent).join(' | '));
  check('day page: the same warning', /only its newest 5 sensor readings/.test(said), said);
  await q.close();
  const r = await open('driver/drv-0/activity', json(BODY));
  await r.page.waitForSelector('.unbooked-note .cap', { timeout: 15000 }).catch(() => {});
  const whole = await r.page.evaluate(() => document.querySelector('.unbooked-note')?.textContent || '');
  check('…and a whole answer carries no such line', !/newest/.test(whole) && /seat sensor watched/.test(whole), whole);
  await r.close();
}

console.log('\nActivity: a failed answer claims nothing; a refused one names the role');
{
  const p = await open('driver/drv-0/activity', json({ error: 'internal' }, 500));
  await p.page.waitForFunction(() => !/Looking for/.test(document.querySelector('.unbooked-note')?.textContent || 'x'), null, { timeout: 15000 }).catch(() => {});
  const t = await p.page.evaluate(() => ({ cap: document.querySelector('.unbooked-note')?.textContent || '',
    marks: document.querySelectorAll('.sh-track > i.x, .sh-track > i.xc').length }));
  check('a failed request says so, marks nothing, and says it is not a finding', t.marks === 0
    && /could not be loaded/.test(t.cap) && /says nothing about whether there are any/.test(t.cap), t.cap);
  await p.close();
  const q2 = await open('driver/drv-0/activity', json({ error: 'withheld', detail: 'Your role does not see accusations.' }, 403));
  await q2.page.waitForFunction(() => !/Looking for/.test(document.querySelector('.unbooked-note')?.textContent || 'x'), null, { timeout: 15000 }).catch(() => {});
  const t2 = await q2.page.evaluate(() => document.querySelector('.unbooked-note')?.textContent || '');
  check('a refused request says the role does not see it', /not shown to your role/.test(t2), t2);
  await q2.close();
}

console.log('\nThe day page: a row on the band, and each ride in the list at its time');
{
  const p = await open(`driver/drv-0/day?on=${D2}`, json(BODY));
  await p.page.waitForFunction(() => document.querySelector('#view')?.dataset?.unbooked
    || document.querySelector('[data-unbooked]'), null, { timeout: 20000 }).catch(() => {});
  const got = await p.page.evaluate(() => {
    const row = document.querySelector('.dday-unrow');
    const marks = row ? [...row.querySelectorAll('.dday-unbooked > i')].map((i) => i.className) : [];
    const list = document.querySelector('.dday-list');
    const order = list ? [...list.children].filter((c) => c.classList.contains('dday-job'))
      .map((c) => ({ s: Number(c.dataset.s), unb: c.classList.contains('dday-unb'), named: c.classList.contains('named'),
        /* 900, not 400: the row's facts grew on 2026-11-11 (seat count, fares
           forgone, nearest booking, the rung) and pushed its caveat past 400. */
        text: c.textContent.replace(/\s+/g, ' ').slice(0, 900), href: c.querySelector('.dday-open')?.getAttribute('href') })) : [];
    const gaps = [...document.querySelectorAll('.dday-gap[data-from]')].map((g) => ({ from: Number(g.dataset.from), to: Number(g.dataset.to),
      said: [...g.querySelectorAll('.dday-ungap')].map((x) => x.textContent) }));
    return { label: row?.querySelector('.dday-onlab')?.textContent, total: row?.querySelector('.dday-ontot')?.textContent, marks, order, gaps };
  });
  check('a row on the band, "unbooked journeys", one mark per ride: one named, one of several',
    got.label === 'unbooked journeys' && got.marks.sort().join(',') === 'x,xc' && got.total === '2 · 1 named', JSON.stringify(got));
  const unb = got.order.filter((o) => o.unb);
  check('both rides are in the list', unb.length === 2, JSON.stringify(unb.map((u) => u.s)));
  const sorted = got.order.every((o, i, a) => i === 0 || a[i - 1].s <= o.s);
  check('…at their time among the jobs, the list still in clock order', sorted, JSON.stringify(got.order.map((o) => [o.s, o.unb])));
  check('…each says what it is and is not — the rung, and not a record of who drove',
    unb[0] && /named by one sensor reading, one of several by the other/i.test(unb[0].text)
      && /not a record of who drove/.test(unb[0].text) && /Test Origin/.test(unb[0].text) && /TST001/.test(unb[0].text), unb[0]?.text);
  /* The mock's jobs are fixed clock times (09:43–09:54, 12:38–12:47,
     13:07–13:23), so ride B at 10:00 is inside the 09:54–12:38 wait on any day
     and ride C at 15:00 is after the last job. */
  const holding = got.gaps.filter((g) => g.from < 630 && g.to > 600);
  check('a wait that held a ride says so, with the ride\'s time, and that it is below',
    holding.length === 1 && holding[0].said.length === 1 && /10:00–10:30 on TST001/.test(holding[0].said[0]) && /below\.$/.test(holding[0].said[0]),
    JSON.stringify(got.gaps));
  check('…and no other wait claims one', got.gaps.filter((g) => g !== holding[0]).every((g) => !g.said.length), JSON.stringify(got.gaps));
  check('…with the way to the journey itself', unb.length > 0 && unb.every((u) => /^#segment\/TST001\//.test(u.href || '')), JSON.stringify(unb.map((u) => u.href)));
  check('nothing on the page threw', !p.errs.length, p.errs.join(' | '));
  await p.close();
}

console.log('\nThe day page: each unbooked journey says what a person can act on (2026-11-11)');
/* The operator: "unbooked journey in the drivers page … doesn't show
   actionable data". Every reading carries the seat count, the fares forgone
   at the fleet's own AED/km and the nearest booking; the row printed none. */
{
  const p = await open(`driver/drv-0/day?on=${D2}`, json(BODY), '?ui=desktop&skin=arkiv');
  await p.page.waitForSelector('.dday-job.dday-unb', { timeout: 20000 }).catch(() => {});
  await p.page.waitForTimeout(900);            // the focus pass's debounce, so its marks are on
  const rows = await p.page.evaluate(() => [...document.querySelectorAll('.dday-job.dday-unb')].map((j) => {
    const when = j.querySelector('.dday-when').getBoundingClientRect(), row = j.getBoundingClientRect();
    const forgone = [...j.querySelectorAll('.dday-facts span')].find((s) => /fares forgone/.test(s.textContent));
    return {
      s: Number(j.dataset.s), text: j.textContent.replace(/\s+/g, ' '),
      facts: [...j.querySelectorAll('.dday-facts')].map((f) => ({ seen: f.checkVisibility(), text: f.textContent.replace(/\s+/g, ' ').trim() })),
      pts: [...j.querySelectorAll('.dday-pt')].map((x) => ({ seen: x.checkVisibility(), fx: x.dataset.fx || null, text: x.textContent.replace(/\s+/g, ' ').trim() })),
      forgoneTitle: forgone?.getAttribute('title') || null,
      car: j.querySelector('.dday-facts a.lnk')?.getAttribute('href') || null,
      links: [...j.querySelectorAll(':scope > a')].map((a) => ({ text: a.textContent, href: a.getAttribute('href') })),
      fx: j.dataset.fx || null, whenInset: Math.round(when.left - row.left),
    };
  }));
  const gap = await p.page.evaluate(() => {
    const g = document.querySelector('.dday-ungap');
    return g ? { text: g.textContent, seen: g.checkVisibility(), fx: g.dataset.fx || null } : null;
  });
  const [b, c] = rows;
  check('two unbooked rows on the day, at 10:00 and 15:00', rows.length === 2 && b.s === 600 && c.s === 900, JSON.stringify(rows.map((r) => r.s)));
  check('ride B: "2 aboard by seat count", "nearest booking 1h 35m away · Uber" — a booking that ran, said as nothing more',
    /\b2 aboard by seat count/.test(b.text) && /nearest booking 1h 35m away · Uber/.test(b.text) && !/never ran/.test(b.text), b.text);
  check('…the money names its basis in words — "AED 42.75 fares forgone at this day’s AED 4.5/km", the rate as the route states it — and in full as its title',
    /AED 42\.75 fares forgone at this day’s AED 4\.5\/km/.test(b.text) && b.forgoneTitle === RATE_BASIS, `${b.forgoneTitle} · ${b.text}`);
  check('…and the rung it rests on, beside the pill', /named beside it/i.test(b.facts[1]?.text || '')
    && /named by one reading, one of several by the other/.test(b.facts[1]?.text || ''), JSON.stringify(b.facts));
  check('ride C (CABMAN, no rate that day, no booking near it): each absent WITH its reason, and no zero stands in',
    /aboard not counted — CABMAN DT gives no seat count/.test(c.text)
      && /fares forgone not valued — no booking that day carries both a fare and a distance/.test(c.text)
      && /no booking on Bolt, Hotel, Uber, Yango touched this car near it/.test(c.text)
      && !/AED 0\b/.test(c.text) && !/\b0 aboard/.test(c.text), c.text);
  check('…and a candidate carries the pill alone, no rung that names them', /one of several/i.test(c.facts[1]?.text || '') && !/\bby (the|time|day-custody)\b/.test(c.facts[1]?.text || ''), JSON.stringify(c.facts));
  check('both lines of facts are on the face of the row under the Arkiv focus pass', rows.every((r) => r.facts.length === 2 && r.facts.every((f) => f.seen) && !r.fx),
    JSON.stringify(rows.map((r) => [r.fx, r.facts.map((f) => f.seen)])));
  check('a place name past fifteen words is shown, never folded (data, not prose)', b.pts.length === 2 && b.pts.every((x) => x.seen && !x.fx)
    && /Water Front/.test(b.pts[0].text), JSON.stringify(b.pts));
  check('the car opens its own movement page on this day; the one way onward is the journey',
    rows.every((r) => new RegExp(`^#vehicle/TST001/movement\\?(?:.*&)?day=${D2}(?:&|$)`).test(r.car || '') && r.links.length === 1
      && /^#segment\/TST001\//.test(r.links[0].href) && /journey/.test(r.links[0].text)), JSON.stringify(rows.map((r) => [r.car, r.links])));
  check('the clocks sit clear of the row’s critical stripe (inset ≥ 6 px)', rows.every((r) => r.whenInset >= 6), JSON.stringify(rows.map((r) => r.whenInset)));
  const words = (s) => (s.match(/[A-Za-z0-9][A-Za-z0-9'’.,%+−\-/:]*/g) || []).length;
  check('the wait that holds a ride says so in 15 words or fewer, so the focus pass keeps it visible',
    gap && words(gap.text) <= 15 && gap.seen && /10:00–10:30 on TST001/.test(gap.text), JSON.stringify(gap));
  check('nothing on the page threw', !p.errs.length, p.errs.join(' | '));
  await p.close();
}

console.log('\nThe day page: a nearest booking that never ran says so');
/* "nearest booking 0m away · Bolt" is what the operator read on 2026-10-14
   as "it's a bolt trip, not unauthorized" — 16 of 17 such bookings had been
   cancelled (test/nearest_cancelled.test.mjs). The reconciler's reason says
   so; a verdict stored before that wording is caught by the booking's status. */
for (const [name, patch, want] of [
  ['the reconciler\'s reason', { nearest_platform: 'bolt', nearest_gap_min: 12,
    verdict_reason: 'no completed booking overlaps; nearest is a bolt booking that never ran — the driver cancelled after accepting it; requested 12 min before the journey began' },
  /nearest booking 12m away · Bolt — it never ran \(the driver cancelled after accepting it\)/],
  ['an older verdict, by the booking\'s status', { nearest_platform: 'bolt', nearest_gap_min: 0,
    verdict_reason: 'no completed booking overlaps; nearest is a bolt trip 0 min away', nearest_booking: { status: 'rider_cancelled' } },
  /nearest booking 0m away · Bolt — it never ran \(status rider cancelled\)/],
]) {
  const body = { ...BODY, attributed: { ...BODY.attributed, rows: [{ ...named[0], ...patch }, named[1]] } };
  const p = await open(`driver/drv-0/day?on=${D1}`, json(body), '?ui=desktop&skin=arkiv');
  await p.page.waitForSelector('.dday-job.dday-unb', { timeout: 20000 }).catch(() => {});
  const text = await p.page.evaluate(() => document.querySelector('.dday-job.dday-unb')?.textContent.replace(/\s+/g, ' ') || '');
  check(`${name}: "${String(want).slice(1, 60)}…"`, want.test(text), text.slice(0, 500));
  /* The rung keeps what makes it an inference ("the operator's rule"), in
     the Activity tab's own words — never a bare "by the last Uber trip". */
  if (name.startsWith('the reconciler')) {
    check('…and the rung beside the pill says whose rule names them: "by the last Uber trip on the car — the operator’s rule"',
      /named beside it.*by the last Uber trip on the car — the operator’s rule/i.test(text), text.slice(0, 500));
  }
  await p.close();
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
