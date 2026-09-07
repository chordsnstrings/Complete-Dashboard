/* The finding page has to NAME the people, and this asks the page, not the file.
   ═══════════════════════════════════════════════════════════════════════════
   The failure this guards was not a wrong value. It was a field that existed at
   every layer and was rendered at none: insight.refs stored since
   sql/schema_v31.sql, served by /api/insights ever since, and read by no line
   of api/public — so the most severe finding this product raises said "10
   drivers were online but completed no trips" and identified nobody, under an
   action that is a phone call.

   A grep would not have caught it and a grep will not keep it caught: the
   source can mention `refs` in a comment, in dead code, or in a branch nothing
   reaches. So this loads the shipped renderer in a browser, hands it the shape
   the API now returns, and reads the name, the tel: link and the reasons off
   the DOM that comes back. test/insight_people.test.mjs is the other half —
   it asks whether the API can resolve the ids at all. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
/* Whatever the page asks for a photograph, it does not get one. Both absent
   states below are therefore reached through the real onerror path as well as
   through the reason string. */
app.get('/api/driver/photo/*', (_, res) => res.status(404).json({ error: 'no photo on file' }));
const server = app.listen(0);
const port = server.address().port;

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

/* The exact shape /api/insights now serves: the rule's own ref fields, plus
   what api/insight_people.js resolved them to. */
const AMIR = '11111111-1111-4111-8111-111111111111';
const NOOR = '22222222-2222-4222-8222-222222222222';
const GHOST = '33333333-3333-4333-8333-333333333333';
const REFS = [
  { driver_ext_id: AMIR, hours_online: 6.3,
    full_name: 'Amir Rahman', phone: '+971 50 000 0001', email: 'amir@example.test',
    picture_url: `/api/driver/photo/uber/${AMIR}`,
    state: 'active', state_raw: 'ACTIVE', can_earn: true, state_plate: 'L27045',
    platform_rating: 4.91, lifetime_trips: 6406,
    online_at: '2026-09-05T19:43:00.000Z', online_ended_at: null, began_before_window: true,
    online_lat: null, online_lon: null,
    last_trip_at: '2026-09-04T09:30:00.000Z', last_trip_addr: 'Dubai Marina',
    last_trip_plate: 'L27045', trips_28d: 96, days_28d: 21 },
  { driver_ext_id: NOOR, hours_online: 2,
    full_name: 'Noor Hassan', phone: null, email: null, picture_url: null,
    photo_absent_reason: 'the host answered 403',
    state: 'suspended', state_raw: 'SUSPENDED', can_earn: false, state_plate: null,
    online_at: '2026-09-06T05:00:00.000Z', online_ended_at: '2026-09-06T07:00:00.000Z',
    began_before_window: false, online_lat: null, online_lon: null,
    last_trip_at: null, last_trip_addr: null, last_trip_plate: null,
    trips_28d: 0, days_28d: 0 },
  /* An id the rule named and nothing else knows. It must still render — with
     every line saying what is missing — rather than producing an empty card or
     being dropped, because dropping it would make the card count disagree with
     the headline the finding leads with. */
  { driver_ext_id: GHOST, hours_online: 1,
    photo_absent_reason: 'no photograph has been offered for this account' },
];

const out = await page.evaluate(async (refs) => {
  const P = await import('/people.js');
  const host = document.createElement('div');
  document.body.append(host);
  host.append(P.peopleCards(refs));
  await new Promise((r) => setTimeout(r, 700));
  const cards = [...host.querySelectorAll('.whocard')];
  const read = (c) => ({
    text: c.textContent.replace(/\s+/g, ' ').trim(),
    tel: [...c.querySelectorAll('a[href^="tel:"]')].map((a) => a.getAttribute('href')),
    mail: [...c.querySelectorAll('a[href^="mailto:"]')].map((a) => a.getAttribute('href')),
    links: [...c.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    absent: [...c.querySelectorAll('.wf-absent')].map((e) => e.textContent.trim()),
    avatarCls: c.querySelector('.av')?.className || '',
    /* A VALUE that is nothing but a dash — the placeholder this product
       exists to remove. An em-dash inside a sentence is punctuation and is
       not counted, which is why this reads whole cells rather than
       characters. */
    dashCells: [...c.querySelectorAll('.wf-v')]
      .map((e) => e.textContent.trim()).filter((t) => /^[-—–]$/.test(t)).length,
  });
  return {
    n: cards.length,
    cards: cards.map(read),
    /* The list row, from the same module. */
    names: P.namesLine({ refs }),
    /* Five named people, to exercise the remainder. Three are printed and the
       rest are counted — a list row that wraps to four lines is a list nobody
       scans. */
    namesMany: P.namesLine({ refs: ['Ali', 'Bina', 'Cem', 'Dara', 'Eve']
      .map((n, i) => ({ driver_ext_id: `id-${i}`, full_name: n })) }),
    noNames: P.namesLine({ refs: [{ driver_ext_id: 'x' }] }),
    resolved: P.peopleResolved(refs),
    ago: P.agoStr(new Date(Date.now() - 3 * 864e5).toISOString()),
    agoBad: P.agoStr(null),
  };
}, REFS);

check('the renderer did not throw', errors.length === 0, errors.join(' | '));
check('every driver the finding names gets a card', out.n === 3, String(out.n));

const [amir, noor, ghost] = out.cards;

/* ── the point of the whole change ───────────────────────────────────── */
check('the driver is named', /Amir Rahman/.test(amir.text), amir.text.slice(0, 120));
check('…and the phone number is a link somebody can press, not text to retype',
  amir.tel.length === 1 && amir.tel[0] === 'tel:+971500000001', JSON.stringify(amir.tel));
check('…and the email address is a link too', amir.mail[0] === 'mailto:amir@example.test',
  JSON.stringify(amir.mail));
check('…and the name opens the page that knows the rest',
  amir.links.some((h) => (h || '').includes(`driver/${AMIR}`)), JSON.stringify(amir.links));
check('…and the vehicle they are holding opens the vehicle page',
  amir.links.some((h) => (h || '').includes('vehicle/L27045')), JSON.stringify(amir.links));

/* THE UN-CLIPPED START. 19:43Z is 23:43 in Dubai on the day BEFORE the window,
   which is exactly the case every clipped span query renders as 00:00. */
check('a shift that opened the night before says so in words',
  /evening before/i.test(amir.text), amir.text.slice(0, 260));
check('…and an open shift is described as open rather than as ended',
  /still open|no log-off/i.test(amir.text), amir.text.slice(0, 260));
check('…and the hours the rule measured are still on the card',
  /6\.3 h logged in/.test(amir.text), amir.text.slice(0, 260));

/* ── absence, with a reason, everywhere ──────────────────────────────── */
check('a position no channel reports is a sentence, not a blank',
  amir.absent.some((t) => /does not report a position/i.test(t)), JSON.stringify(amir.absent));
check('a driver with no contact details on file is told so',
  /no phone number or email address on file/i.test(noor.text), noor.text.slice(0, 200));
check('…and has no dead tel: link', noor.tel.length === 0, JSON.stringify(noor.tel));
check('a driver who has never completed a trip is told so, not shown a dash',
  noor.absent.some((t) => /no completed trip/i.test(t)), JSON.stringify(noor.absent));
check('…and "nothing in four weeks" is a sentence too',
  noor.absent.some((t) => /nothing completed in the last four weeks/i.test(t)),
  JSON.stringify(noor.absent));
check('a driver with no vehicle assigned is told so',
  noor.absent.some((t) => /no vehicle is assigned/i.test(t)), JSON.stringify(noor.absent));
/* No em-dash placeholders anywhere on a card. The house rule is that an
   unmeasured figure renders absent WITH A REASON — a dash is the failure. */
check('no card falls back to a bare dash for anything',
  out.cards.every((c) => c.dashCells === 0), JSON.stringify(out.cards.map((c) => c.dashCells)));

check('a suspended driver is shown as suspended, not merely idle',
  /SUSPENDED/i.test(noor.text), noor.text.slice(0, 160));

/* ── the account nothing knows ───────────────────────────────────────── */
check('an id no channel has named still renders, so the count matches the headline',
  /no channel has filed a name/i.test(ghost.text), ghost.text.slice(0, 200));
check('…and is still a link to the page that could learn more',
  ghost.links.some((h) => (h || '').includes(`driver/${GHOST}`)), JSON.stringify(ghost.links));

/* ── the photograph, three states ────────────────────────────────────── */
check('a photograph that will not load is marked on the tile',
  /av-lost/.test(amir.avatarCls), amir.avatarCls);
check('…and one the collector could not fetch is marked too',
  /av-lost/.test(noor.avatarCls), noor.avatarCls);

/* ── the list row ────────────────────────────────────────────────────── */
check('the action list itself carries the first few names',
  /Amir Rahman/.test(out.names) && /Noor Hassan/.test(out.names), out.names);
check('…at most three of them, so the row still scans',
  (out.namesMany.match(/Ali|Bina|Cem|Dara|Eve/g) || []).length === 3, out.namesMany);
check('…and says how many more it did not print',
  /and 2 more/.test(out.namesMany), out.namesMany);
check('…and adds no remainder when it printed them all',
  !/more/.test(out.names), out.names);
check('…and a finding whose refs resolved to nobody adds no empty line',
  out.noNames === '', JSON.stringify(out.noNames));
check('how many were resolved is counted honestly', out.resolved === 2, String(out.resolved));

check('a relative time reads in days once it is past two', /3 days ago/.test(out.ago || ''), String(out.ago));
check('…and an unparseable timestamp produces nothing rather than "NaN ago"',
  out.agoBad === null, String(out.agoBad));

/* ── and the VIEW actually renders it ─────────────────────────────────────
   Everything above proves the renderer works. The bug was that nothing called
   it: `refs` reached the browser and no line of api/public read it. So this
   drives the shipped application — real router, real V.action, real fetch —
   against a stubbed /api/insights, and reads the finished page. */
const real = express();
real.use(express.static('api/public'));
real.get('/api/insights', (req, res) => res.json({
  insights: [{
    code: 'drivers_online_no_trips', severity: 'critical', category: 'utilisation',
    entity_type: 'fleet', entity_id: 'all', fleet_id: 'ecosine',
    title: '3 drivers were online but completed no trips',
    detail: 'Uber flagged three drivers logged in with no completed trip.',
    action: 'Check whether they were genuinely available.',
    impact_aed: null, metric: 3, refs: REFS,
    window_start: '2026-09-06T00:00:00.000Z', window_end: '2026-09-06T00:00:00.000Z',
    computed_at: '2026-09-07T07:04:48.003Z', impact_kind: null,
  }],
  truncated: false, limit: 200, cleared: 0, filter: {},
}));
real.get('/api/driver/photo/*', (_, res) => res.status(404).json({ error: 'no photo on file' }));
/* Everything else the shell asks for on boot. An empty object is enough — the
   assertions below are about one panel, and a 404 here would put an error
   banner over the page rather than a missing one. */
real.get('/api/*', (_, res) => res.json({}));
const realServer = real.listen(0);
const rport = realServer.address().port;

const vp = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const verrors = [];
vp.on('pageerror', (e) => verrors.push(String(e.message).slice(0, 160)));
await vp.goto(`http://127.0.0.1:${rport}/index.html#action/drivers_online_no_trips/all`,
  { waitUntil: 'domcontentloaded' });
await vp.waitForSelector('.whocard', { timeout: 15000 }).catch(() => {});
const view = await vp.evaluate(() => ({
  cards: document.querySelectorAll('.whocard').length,
  heading: [...document.querySelectorAll('h2, h3, .panel-h, .ph-t')]
    .map((e) => e.textContent.trim()).filter((t) => /named by this finding/i.test(t))[0] || null,
  text: document.body.textContent.replace(/\s+/g, ' ').trim(),
  tel: [...document.querySelectorAll('a[href^="tel:"]')].map((a) => a.getAttribute('href')),
}));

check('the finding page renders the people panel, not just the count',
  view.cards === 3, `${view.cards} cards | ${verrors.join(' | ')}`);
check('…headed by how many drivers the finding names',
  /3 drivers named by this finding/i.test(view.text), String(view.heading));
check('…with the names on the page',
  /Amir Rahman/.test(view.text) && /Noor Hassan/.test(view.text),
  view.text.slice(0, 200));
check('…and a number an operator can press',
  view.tel.includes('tel:+971500000001'), JSON.stringify(view.tel));
check('…and the router did not throw getting there', verrors.length === 0, verrors.join(' | '));

await vp.close();
realServer.close();
await browser.close();
server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
