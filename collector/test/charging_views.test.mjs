/* POWERDRIVE ON THE PAGES THAT ARE NOT THE CHARGING PAGE — the Drivers
   directory's Charging wallet column, the driver money tab's wallet panel,
   and the vehicle page's charging panel, drawn against the mock in both
   skins.
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-11-03: "show charging wallet balance for the drivers
   that we have" and "we can track how many times each vehicles are
   charging". The routes are test/yocharge.test.mjs's; the Charging page is
   test/charging_page.test.mjs's. What must hold here, on every other page
   that shows a wallet or a charge:
     · a linked wallet shows its balance; one below zero is marked; a
       fleet-wallet driver shows what is left of the company limit, tagged;
     · NO LINK IS NEVER AED 0 — a person with no wallet reads a dash with the
       reason, an account not placed on a person says that, and before
       PowerDrive has been read the column takes itself off the table with
       the route's own reason;
     · a car's charges carry how each reached the car, and its drivers open
       by the person address;
     · the Same person page carries the "Wallets to confirm" queue too (the
       operator, 2026-11-04) — see the last section.
   The mock's people: the directory's person ids are 100 + i (wallets on
   100–104: 182.40, −36.75, the fleet wallet with 912.30 left, 54.00,
   410.10); the driver page's profile ids are 401 + i (401 has a wallet, 402
   is on the fleet wallet, the rest have none). Synthetic names only. */
import { harness, settle } from './arkiv_pages.mjs';

const { check, start, open, done } = harness('PowerDrive on the directory, the money tab and the vehicle page');
await start();
const txt = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '', sel);
/* The Charging wallet cell of the directory row that names `name`. */
const walletCells = (page) => page.evaluate(() => {
  const tbl = [...document.querySelectorAll('table')].find((t) => t.querySelector('th[data-key="charging_wallet"]'));
  if (!tbl) return null;
  const ths = [...tbl.querySelectorAll('thead th')];
  const at = ths.findIndex((t) => t.dataset.key === 'charging_wallet');
  return [...tbl.querySelectorAll('tbody tr')].map((tr) => {
    const td = tr.querySelectorAll('td')[at];
    return { row: tr.textContent.replace(/\s+/g, ' '), cell: td?.textContent.replace(/\s+/g, ' ').trim() || '',
      bad: !!td?.querySelector('.bad'), title: td?.querySelector('[title]')?.getAttribute('title') || '' };
  });
});

for (const skin of ['arkiv', 'classic']) {
  console.log(`\n#drivers — ${skin}`);
  const { ctx, page } = await open(skin, 'drivers');
  const cells = await walletCells(page);
  const of = (name) => cells?.find((c) => c.row.includes(name));
  check('the directory carries a Charging wallet column', Array.isArray(cells) && cells.length > 0, String(cells));
  check('a linked wallet shows its balance', of('Ahmed Tarig Mohamed')?.cell === 'AED 182.40', JSON.stringify(of('Ahmed Tarig Mohamed')));
  check('one below zero is marked, with what it means', of('Muhammad Ashraf Bakhsh')?.cell === '−AED 36.75' && of('Muhammad Ashraf Bakhsh').bad
    && /owing PowerDrive/.test(of('Muhammad Ashraf Bakhsh').title), JSON.stringify(of('Muhammad Ashraf Bakhsh')));
  check('a fleet-wallet driver shows what is left of the company limit, tagged', of('Najeeb Ullah Khan')?.cell === 'AED 912.30 · fleet',
    JSON.stringify(of('Najeeb Ullah Khan')));
  const none = cells?.filter((c) => c.cell === '—') || [];
  check('a person with no linked wallet reads a dash with the reason — never AED 0',
    none.length > 0 && none.every((c) => /no PowerDrive charging wallet is linked to this person/.test(c.title))
    && !cells.some((c) => c.cell === 'AED 0.00'), JSON.stringify(none.slice(0, 2)));
  /* REVERSION (run 2026-11-03): the column's render returning money(0) for
     a person with no wallet -> this check fails (rows read AED 0.00). */
  await ctx.close();
}
{
  console.log('\n#drivers — PowerDrive not read yet');
  const unread = 'PowerDrive has not been read yet — the charging collector runs every six hours once its key and client id are set (Settings → Charging).';
  const { ctx, page } = await open('arkiv', 'drivers', { fixtures: { '/api/charging/wallets': (_q, real) => ({ ...real, customers: 0, why: unread, rows: [] }) } });
  const cells = await walletCells(page);
  const body = await txt(page, '#view');
  check('the column takes itself off the table, and the reason the route gave is printed in its place',
    cells === null && body.includes('Charging wallet') && body.includes('PowerDrive has not been read yet'), `${String(cells)} ${body.slice(-600)}`);
  await ctx.close();
}

for (const skin of ['arkiv', 'classic']) {
  console.log(`\n#driver …/money — ${skin}`);
  {
    const { ctx, page, answer } = await open(skin, 'driver/drv-0/money');
    const t = await txt(page, '[data-panel="driver-charging"]');
    check('a linked driver: the wallet balance and the last thirty days, as positions',
      /Charging wallet balance\s*AED 182\.40/.test(t) && /Charges, last 30 days\s*9/.test(t) && answer('/api/charging/driver')?.person_id === '401', t.slice(0, 300));
    const rows = await page.$$eval('[data-panel="driver-charging"] tbody tr', (r) => r.map((x) => x.textContent.replace(/\s+/g, ' ')));
    check('…its recent charges, each saying how it reached a car, or that it reached none',
      rows.length === 3 && /its own plate/.test(rows[0]) && /no car driven within 12 hours/.test(rows[2]), JSON.stringify(rows));
    check('…and whether the link was automatic, in words', /Linked automatically: the mobile on the PowerDrive account belongs to this person/.test(t), t.slice(-400));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(skin, 'driver/drv-1/money');
    const t = await txt(page, '[data-panel="driver-charging"]');
    check('a fleet-wallet driver: what is left of the limit leads, their own wallet beside it',
      /Fleet charging limit left\s*AED 912\.30/.test(t) && /own wallet AED 0\.00/.test(t) && /confirmed by a person/.test(t), t.slice(0, 300));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(skin, 'driver/drv-5/money');
    const t = await txt(page, '[data-panel="driver-charging"]');
    check('no wallet linked: the reason, and no figure', t.includes('No PowerDrive charging wallet is linked to this driver.') && !/AED/.test(t), t);
    await ctx.close();
  }
  {
    const { ctx, page, answers } = await open(skin, 'driver/U-TARIQ/money');
    const t = await txt(page, '[data-panel="driver-charging"]');
    check('an account not placed on a person: says so, and does not ask', /has not been placed on a person/.test(t)
      && !answers.some((a) => a.path === '/api/charging/driver'), t);
    await ctx.close();
  }
}

/* Long lists fold (production's first read: 180 wallets, 124 suggestions,
   51 cars — 15,000px of page, 87,000 on a phone). */
{
  console.log('\n#charging — long lists fold');
  const many = (list, n) => Array.from({ length: n }, (_, i) => ({ ...list[i % list.length], yc_user_id: `yc-${i}`, person_id: String(100 + (i % 10)) }));
  const { ctx, page } = await open('arkiv', 'charging', { fixtures: {
    '/api/charging/wallets': (_q, real) => ({ ...real, rows: many(real.rows, 30) }),
    '/api/charging/review': (_q, real) => ({ ...real, review: many(real.review, 25) }),
    '/api/charging/sessions': (_q, real) => ({ ...real, vehicles: Array.from({ length: 20 }, (_, i) => ({ ...real.vehicles[0], plate: `C${i}` })) }),
  } });
  const r = await page.evaluate(() => {
    const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null && !e.hidden).length;
    const btn = (panel) => document.querySelector(`[data-panel="${panel}"] .foldbtn`)?.textContent.trim() || '';
    return { wallets: vis('[data-panel="charging-wallets"] tbody tr'), wBtn: btn('charging-wallets'),
      review: vis('[data-panel="charging-review"] li'), rBtn: btn('charging-review'),
      cars: vis('[data-panel="charging-cars"] tbody tr'), cBtn: btn('charging-cars') };
  });
  check('the wallets, the queue and the cars show their first rows and say how many more there are',
    r.wallets === 12 && /Show the other 18 wallets/.test(r.wBtn) && r.review === 10 && /Show the other 15 suggestions/.test(r.rBtn)
    && r.cars === 12 && /Show the other 8 cars/.test(r.cBtn), JSON.stringify(r));
  await page.click('[data-panel="charging-review"] .foldbtn');
  const opened = await page.evaluate(() => [...document.querySelectorAll('[data-panel="charging-review"] li')].filter((e) => !e.hidden).length);
  check('…and the queue opens whole on a click', opened === 25, String(opened));
  await ctx.close();
}
/* REVERSION (run 2026-11-03): the queue's fold removed -> the first check
   fails (all 25 suggestions shown, no control). */

/* The overview's tile, beside the cash (the operator, 2026-11-03: "the
   driver pages should also have charging wallet"). */
const tileOf = (page) => page.evaluate(() => {
  const t = [...document.querySelectorAll('#view .kpi')].find((x) => /^Charging wallet$/i.test(x.querySelector('.l')?.textContent.trim() || ''));
  if (!t) return null;
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
  return { value: txt(t.querySelector('.n')), sub: txt(t.querySelector('.s')), na: txt(t.querySelector('.t-na')),
    href: t.getAttribute('href') || t.querySelector('a')?.getAttribute('href') || '' };
});
for (const skin of ['arkiv', 'classic']) {
  console.log(`\n#driver overview — ${skin}`);
  for (const [addr, test] of [
    ['drv-0', (t) => t?.value === 'AED 182.40' && /PowerDrive, read/.test(t.sub) && /#driver\/[^/]+\/money/.test(t.href)],
    ['drv-1', (t) => t?.value === 'AED 912.30' && /fleet limit left/.test(t.sub)],
    ['drv-5', (t) => t && !/AED/.test(t.value) && /No PowerDrive charging wallet is linked to this driver/.test(`${t.sub} ${t.na}`)],
    ['U-TARIQ', (t) => t && !/AED/.test(t.value) && /not placed on a person/.test(`${t.sub} ${t.na}`)],
  ]) {
    const { ctx, page } = await open(skin, `driver/${addr}`);
    const t = await tileOf(page);
    check(`${addr}: the overview carries the charging wallet beside the cash — ${addr === 'drv-0' ? 'its balance, opening the Money tab'
      : addr === 'drv-1' ? 'the fleet limit left' : addr === 'drv-5' ? 'no wallet: the reason, not AED 0' : 'not placed: says so'}`, test(t), JSON.stringify(t));
    await ctx.close();
  }
}
/* REVERSION (run 2026-11-03): chargingWalletTile left out of OV_TILES -> the
   four overview checks fail in both skins (no tile at all). */

for (const skin of ['arkiv', 'classic']) {
  console.log(`\n#vehicle — ${skin}`);
  {
    const { ctx, page, answer } = await open(skin, 'vehicle/L45235');
    const t = await txt(page, '[data-panel="veh-charging"]');
    const a = answer('/api/charging/vehicle');
    check('a car\'s charges in the window, with the window the route answered', /Charges\s*11/.test(t) && a && t.includes(`${a.from} to ${a.to}`), t.slice(0, 300));
    check('…how they reached the car, in the tile and on every row', /By its own plate\s*2 of 11\s*8 the only car driven within 12 h, 1 nearest booking/.test(t)
      && /its own plate/.test(t) && /the only car driven within 12 hours/.test(t), t.slice(0, 500));
    const links = await page.$$eval('[data-panel="veh-charging"] tbody a', (x) => x.map((e) => e.getAttribute('href')));
    check('…and each driver opens by the person address', links.length === 2 && links.every((h) => /^#driver\/p40[12]/.test(h || '')), JSON.stringify(links));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(skin, 'vehicle/L12615');
    const t = await txt(page, '[data-panel="veh-charging"]');
    check('a car with no charge: says so, and why one might be missing — never a nought',
      /No PowerDrive charge was put on L12615 between/.test(t) && /another network/.test(t) && !/Charges\s*0/.test(t), t);
    await ctx.close();
  }
}

/* ── The queue on the Same person page too ─────────────────────────────────
   The operator, 2026-11-04: "yes add it to the same person page too" — the
   PowerDrive "Wallets to confirm" queue, until then a panel on #charging
   only, beside the name pairs on #same-person (on production 48 of its 124
   suggestions existed because one driver has two records on our side). The
   drawing is api/public/charging_review.js, shared with #charging, whose own
   checks are test/charging_page.test.mjs's; what must hold HERE is the
   wiring on this page, in both skins:
     · the panel is on the page, between the pairs waiting and the pairs
       answered (sameperson.js powerDriveQueue says why there);
     · its caption says what it decides — which of our drivers owns a
       PowerDrive account, not whether two records are one person — and the
       reader can SEE all of it: the Arkiv skin's focus pass cuts a caption
       over fifteen words to one line, and the first render's 45 words were
       cut after "— not…";
     · the wallets themselves are one click away, on #charging;
     · the suggestions are the route's, each with its reason and both
       buttons;
     · "Same person" / "Not this person" send exactly the pair on screen and
       the decision, and the queue is read again after each;
     · PowerDrive not read yet: the reason and no figure; the queue not
       readable: said in words, and the pairs still draw. */
const SPQ = '[data-panel="sp-charging-review"]';
const until = async (page, f, ms = 10000) => {
  for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await f()) return true; await page.waitForTimeout(100); }
  return false;
};
const queueText = (page) => page.evaluate((s) => {
  const b = document.querySelector(`${s} .pbody`);
  return { t: b?.textContent.replace(/\s+/g, ' ').trim() || '', li: b?.querySelectorAll('li').length ?? null,
    btn: b?.querySelectorAll('button').length ?? null, pairs: document.querySelectorAll('#view .sp-pair').length };
}, SPQ);
for (const skin of ['arkiv', 'classic']) {
  console.log(`\n#same-person — the PowerDrive queue, ${skin}`);
  {
    const { ctx, page, answers } = await open(skin, 'same-person');
    const heads = await page.evaluate(() => [...document.querySelectorAll('#view .panel>h3')].map((h) => h.textContent.trim()));
    const at = heads.indexOf('PowerDrive wallets to confirm');
    check('the panel is on the page, between the pairs waiting and the pairs answered',
      at > 0 && heads[at - 1] === 'Waiting for an answer' && heads[at + 1] === 'Already answered', JSON.stringify(heads));
    /* REVERSION (run 2026-11-04): the panel appended after "Already
       answered" instead -> this check fails (both skins); the panel not
       appended at all -> this check and the three below fail. */
    const cap = await page.evaluate((s) => {
      const c = document.querySelector(`${s} > p.cap`);
      if (!c) return null;
      const cs = getComputedStyle(c);
      return { t: c.textContent, shown: cs.display !== 'none' && c.offsetHeight > 0, clamp: cs.webkitLineClamp || 'none',
        link: document.querySelector(`${s} .pbody a.lnk`)?.getAttribute('href') || '' };
    }, SPQ);
    check('…its caption says it decides which of our drivers owns a PowerDrive account, not whether two records are one person — all of it on the face of the page',
      !!cap && /which of our drivers/i.test(cap.t) && /not whether two (?:of our )?records are one person/.test(cap.t) && cap.shown && cap.clamp === 'none',
      JSON.stringify(cap));
    /* REVERSION (run 2026-11-04): the first render's 45-word caption ("Each
       answer here decides which of our drivers a PowerDrive charging account
       belongs to — not whether two of our records are one person, …")
       restored -> this check fails under Arkiv (clamp 1: focus.js cut it to
       one line) and passes under classic, which focus.js never marks. */
    check('…and the wallets themselves are one click away, on Charging', /^#charging\b/.test(cap?.link || ''), JSON.stringify(cap));
    const real = answers.find((a) => a.path === '/api/charging/review')?.body;
    const items = await page.$$eval(`${SPQ} li`, (li) => li.map((x) => ({ t: x.textContent.replace(/\s+/g, ' '),
      b: [...x.querySelectorAll('button')].map((b) => b.textContent) })));
    check('…the route’s suggestions, each with its reason and both buttons',
      !!real && real.review.length === 2 && items.length === 2 && items.every((x, i) => x.t.includes(real.review[i].yc_name)
        && x.t.includes(real.review[i].our_name) && x.t.includes(real.review[i].reason) && x.b.join('|') === 'Same person|Not this person'),
      JSON.stringify(items));
    /* A decision is the reader's, sent as exactly the pair on screen; the
       queue is read again after it (this page's own `again`). */
    const sent = [];
    await page.route('**/api/charging/link', async (route) => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    const reads = () => answers.filter((a) => a.path === '/api/charging/review').length;
    const r0 = reads();
    /* Guarded, so a page without the queue fails the check below instead of
       dying on a click that waits 30 s for a button that is not there. */
    if (items.length === 2) {
      await page.click(`${SPQ} li:nth-child(1) button.btn:not(.ghost)`);
      await until(page, () => reads() > r0);
      await until(page, async () => (await page.$$(`${SPQ} li button:not([disabled])`)).length === 4);
      const r1 = reads();
      await page.click(`${SPQ} li:nth-child(2) button.ghost`);
      await until(page, () => reads() > r1);
    }
    check('"Same person" and "Not this person" send that customer, that person and the decision — and the queue is read again after each',
      sent.length === 2 && sent[0].yc_user_id === 'yc-r1' && sent[0].person_id === 105 && sent[0].decision === 'confirm'
      && sent[1].yc_user_id === 'yc-r2' && sent[1].person_id === 106 && sent[1].decision === 'refuse' && reads() === r0 + 2,
      JSON.stringify({ sent, reads: [r0, reads()] }));
    /* REVERSION (run 2026-11-04): decide('confirm') sending decision:
       'refuse' (charging_review.js) -> this check fails; this page's `again`
       made a no-op (the queue not read after a decision) -> this check
       fails. */
    /* The queue's route failing, on the page opened afresh (#zzz-not-a-page
       is the cheapest page to step through). */
    await page.route('**/api/charging/review*', (route) => route.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ error: 'internal', detail: 'the database did not answer' }) }));
    await page.evaluate(() => { location.hash = '#zzz-not-a-page'; });
    await page.waitForTimeout(600);
    await page.evaluate(() => { location.hash = '#same-person'; });
    await settle(page);
    await until(page, async () => /could not be read/.test((await queueText(page)).t));
    const e = await queueText(page);
    check('the queue not readable: the panel says so in words, and the pairs around it still draw',
      /The queue could not be read: 500 internal: the database did not answer/.test(e.t) && e.li === 0 && e.pairs > 0, JSON.stringify(e));
    /* REVERSION (run 2026-11-04): readReview without its .catch -> this
       check fails (the panel stays on its skeleton, and the rejection is a
       page error). */
    await ctx.close();
  }
  {
    const unread = 'PowerDrive has not been read yet — the charging collector runs every six hours once its key and client id are set (Settings → Charging).';
    const { ctx, page } = await open(skin, 'same-person', { fixtures: {
      '/api/charging/review': (_q, real) => ({ ...real, customers: 0, why: unread, review: [], unplaced: [] }) } });
    const q = await queueText(page);
    check('PowerDrive not read yet: the panel gives the reason and no figure — no suggestion, no button, no count',
      q.t.includes(unread) && q.li === 0 && q.btn === 0 && !/\d/.test(q.t) && q.pairs > 0, JSON.stringify(q));
    /* REVERSION (run 2026-11-04): drawReview's unread branch keyed on the
       list alone (`w.why ||` dropped) -> this check fails: the panel says
       "Nothing waiting", a claim nobody measured, in place of the reason. */
    await ctx.close();
  }
}
await done();
