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
       by the person address.
   The mock's people: the directory's person ids are 100 + i (wallets on
   100–104: 182.40, −36.75, the fleet wallet with 912.30 left, 54.00,
   410.10); the driver page's profile ids are 401 + i (401 has a wallet, 402
   is on the fleet wallet, the rest have none). Synthetic names only. */
import { harness } from './arkiv_pages.mjs';

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
      rows.length === 3 && /its own plate/.test(rows[0]) && /no car driven that day/.test(rows[2]), JSON.stringify(rows));
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

for (const skin of ['arkiv', 'classic']) {
  console.log(`\n#vehicle — ${skin}`);
  {
    const { ctx, page, answer } = await open(skin, 'vehicle/L45235');
    const t = await txt(page, '[data-panel="veh-charging"]');
    const a = answer('/api/charging/vehicle');
    check('a car\'s charges in the window, with the window the route answered', /Charges\s*11/.test(t) && a && t.includes(`${a.from} to ${a.to}`), t.slice(0, 300));
    check('…how they reached the car, in the tile and on every row', /By its own plate\s*2 of 11\s*8 the only car driven that day, 1 nearest booking/.test(t)
      && /its own plate/.test(t) && /the only car driven that day/.test(t), t.slice(0, 500));
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
await done();
