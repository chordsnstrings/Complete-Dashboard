/* THE PERSON IS THE ADDRESS, AND THE ACCOUNT IS ONLY A DOOR INTO IT.
   ══════════════════════════════════════════════════════════════════════════
   THE DEFECT. Every driver page in this product was addressed by a PROVIDER
   ACCOUNT id:

     #driver/64686123-8389-4a9e-82f1-0287e936239b

   That is an Uber UUID. The page it opens is a PERSON — src/persons.js folds
   the accounts of one human onto one `driver` row, api/driver_routes.js
   answers every panel over all of them, and api/public/driver.js prints
   "every platform this person works on, combined" under the title. So the
   identity a reader saw, bookmarked and pasted into a message was one of the
   records being folded, chosen by whichever row they happened to click.

   THE MEASUREMENT. On production 2026-09-21: 810 platform accounts belonging
   to ~349 people. Which account represents a person is decided by the spine
   and moves — a merge reviewed, a wrongly merged account detached, a hotel
   record linked to an Uber one — while the person id never does, and is
   already what driver_ledger.person_id keys money on. A link to an account
   that stops being the survivor points at a record that is no longer the page
   anybody meant.

   THE FIX, AND WHAT THESE ASSERTIONS HOLD DOWN.

     · `#driver/p412` is the canonical address, and `?person=` is how the
       profile route is asked for it — its own parameter, never `?id=`,
       because Yango and Bolt both issue digits-only account ids and a route
       that guessed between the two namespaces would one day answer one
       person's page under another person's address.
     · `#driver/<ext_id>` still works and always must: those links are in this
       product, in bookmarks and in messages sent to people who will never
       read this file. It resolves to the person, renders the SAME page, and
       the address is rewritten in place to the canonical form so what the
       reader copies from here is the id that does not move.
     · an account the spine has not placed keeps its page exactly as it was —
       it has trips, money and a licence that expires — and says WHICH of the
       not-placed states it is in. Three states are flattened into one word by
       any page that just leaves the line blank: the register could not be
       read (we failed), the register has never been built (nobody is placed),
       and this account has not been reviewed yet (a fact about this account).
       Telling a reader "no person" for the first of those is the house rule's
       exact prohibition — never a reason that is not the true one.

   PROVED BY REVERTING — twice, and the output recorded verbatim, because a
   test that passes against the unchanged file has proved nothing:

     1. The `?person=` branch of resolve() in api/driver_routes.js, replaced
        with `const asked = null;`. resolve() then falls through to `?id=`
        (absent) and `?name=` (absent), returns null, and withDriver 404s.
        Eight assertions went red, among them:
          ✗ a person id resolves to a page {"error":"driver not found"}
          ✗ …and the response says which parameter resolved it
            undefined / ext_id
          ✗ a person id and one of that person's accounts open the same page
            [null,9,null,["u-amina","y-amina"]]
          ✗ and a person address refuses rather than reporting "no such
            driver"  404 {"error":"driver not found"}
        — that last one being the interesting failure: without the branch the
        route answers a read it never attempted with an assertion about the
        fleet.

     2. `rewriteParam(canon)` in renderDriver (api/public/driver.js), commented
        out. The page still RENDERS correctly from an account address, which is
        exactly why this needs a test: the defect is invisible on the page and
        lives entirely in the address bar.
          ✗ an account address leaves the reader holding the person address
            http://127.0.0.1:38825/#driver/drv-0
          ✗ …with the tab it was opened on intact
            http://127.0.0.1:38825/#driver/drv-0/money
          ✗ …and with the day a replay link carried
            http://127.0.0.1:38825/#driver/drv-0/day?on=2026-08-25
*/
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { chromium } from 'playwright';
import { driverRoutes } from '../api/driver_routes.js';
import { clearPersonMapCache } from '../api/person_map.js';
import { app as mockApp } from '../mockapi.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ══ 1. THE ROUTE ═══════════════════════════════════════════════════════ */
console.log('\naddressing the profile by person and by account');

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

/* One woman, two provider accounts, and one man whose account nobody has
   reviewed. The second account is deliberately on a DIFFERENT channel filing
   a different spelling of her name — that is the shape the spine exists for,
   and it is the shape where "which account is the page" is decided by
   something other than the reader. */
let n = 0;
const trip = (ext, name, platform, plate, at) => q(
  `INSERT INTO trip (platform, fleet_id, external_id, driver_ext_id, driver_name, plate,
                     requested_at, ended_at, status, distance_km, price)
   VALUES ($1,'ecosine',$2,$3,$4,$5,$6::timestamptz,$6::timestamptz + interval '20 min',
           'completed',9,32)`,
  [platform, `t${++n}`, ext, name, plate, at]);

for (let i = 0; i < 6; i++) {
  await trip('u-amina', 'Amina Rashid', 'uber', 'L46174', `2026-08-1${i}T09:00:00+04`);
}
for (let i = 0; i < 3; i++) {
  await trip('y-amina', 'Amina Rashid Rashid', 'yango', 'L36397', `2026-08-2${i}T18:00:00+04`);
}
await trip('b-unreviewed', 'Kareem Sayed', 'bolt', 'L98001', '2026-08-22T09:00:00+04');

/* The spine, written the way src/persons.js writes it: one `driver` row per
   human, one live `driver_platform_id` row per account. b-unreviewed is
   deliberately absent — the spine joins accounts from reviewed decisions
   only, and an account nobody has reviewed is exactly the state this page has
   to render honestly rather than treat as an error. */
await q(`INSERT INTO driver (id, fleet_id, full_name) VALUES (412,'ecosine','Amina Rashid')`);
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, basis, display_name)
         VALUES ('uber','u-amina',412,'human:ahsan','Amina Rashid'),
                ('yango','y-amina',412,'link:shared_phone','Amina Rashid Rashid')`);
clearPersonMapCache();

const api = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res))
  .catch((e) => res.status(500).json({ error: String(e) }));
driverRoutes(api, { q, wrap });
const apiServer = api.listen(0);
const W = 'from=2026-08-01&to=2026-08-31';
const get = async (p) => {
  const r = await fetch(`http://127.0.0.1:${apiServer.address().port}${p}`);
  return { status: r.status, body: await r.json() };
};

const byPerson = await get(`/api/driver/profile?person=412&${W}`);
const byAccount = await get(`/api/driver/profile?id=u-amina&${W}`);
const byOther = await get(`/api/driver/profile?id=y-amina&${W}`);

check('a person id resolves to a page',
  byPerson.status === 200 && byPerson.body.person_id === 412,
  JSON.stringify(byPerson.body).slice(0, 160));
check('…and the response says which parameter resolved it',
  byPerson.body.resolved_by === 'person_id' && byAccount.body.resolved_by === 'ext_id',
  `${byPerson.body.resolved_by} / ${byAccount.body.resolved_by}`);
/* The address the reader spells it with, passed straight through. A caller
   handing the route the slot out of the hash should not get a 404 for a `p`. */
const byPrefixed = await get(`/api/driver/profile?person=p412&${W}`);
check('…and the p-prefixed spelling of it is the same person, not a 404',
  byPrefixed.status === 200 && byPrefixed.body.person_id === 412,
  `${byPrefixed.status} ${byPrefixed.body.person_id}`);

/* THE ASSERTION THE WHOLE CHANGE RESTS ON. Not "both return 200" — both have
   to be the SAME PAGE, because the old address stays in circulation and a
   reader following it must not see a smaller person than the canonical
   address shows. */
const samePage = (a, b) => a.span?.trips === b.span?.trips
  && [...(a.ids || [])].sort().join() === [...(b.ids || [])].sort().join()
  && (a.accounts || []).length === (b.accounts || []).length;
check('a person id and one of that person’s accounts open the same page',
  samePage(byPerson.body, byAccount.body),
  JSON.stringify([byPerson.body.span?.trips, byAccount.body.span?.trips,
    byPerson.body.ids, byAccount.body.ids]));
check('…and so does their OTHER account, the one the address rarely names',
  byOther.body.person_id === 412 && samePage(byPerson.body, byOther.body),
  JSON.stringify([byOther.body.person_id, byOther.body.span?.trips, byOther.body.ids]));
check('the person’s trips are all of them, not one account’s',
  byPerson.body.span?.trips === 9, String(byPerson.body.span?.trips));

/* The header's material: the person id and every account, with the platform
   each is on. It is the fact the card exists to state — this page folds these
   records into one human — and nothing on the page said it before. */
const accs = byPerson.body.person_accounts || [];
check('the profile carries every account the person holds, with its platform',
  accs.length === 2
  && accs.map((a) => `${a.platform}:${a.ext_id}`).sort().join() === 'uber:u-amina,yango:y-amina',
  JSON.stringify(accs));
check('…and the basis each was joined on, so a merge can be questioned',
  accs.every((a) => a.basis), JSON.stringify(accs.map((a) => a.basis)));
check('…and marks which account the address came in on',
  (await get(`/api/driver/profile?id=y-amina&${W}`)).body.person_accounts
    .find((a) => a.asked)?.ext_id === 'y-amina',
  JSON.stringify(byOther.body.person_accounts?.map((a) => [a.ext_id, a.asked])));

/* ── the account the spine has not placed ────────────────────────────── */
const unplaced = await get(`/api/driver/profile?id=b-unreviewed&${W}`);
check('an account the spine has not placed still gets its page, not an error',
  unplaced.status === 200 && unplaced.body.span?.trips === 1,
  `${unplaced.status} ${JSON.stringify(unplaced.body).slice(0, 120)}`);
check('…and reports no person rather than inventing one',
  unplaced.body.person_id === null && (unplaced.body.person_accounts || []).length === 0,
  JSON.stringify([unplaced.body.person_id, unplaced.body.person_accounts]));
check('…and says which not-placed state it is in, in words',
  /has not placed this account/.test(unplaced.body.person_absent_reason || '')
  && /reviewed decisions only/.test(unplaced.body.person_absent_reason || ''),
  unplaced.body.person_absent_reason);
check('a person id nobody holds is a 404, not an empty page under a real name',
  (await get(`/api/driver/profile?person=999999&${W}`)).status === 404);
/* The namespaces are not guessed between. A caller who sends a provider id in
   ?person= is refused with the distinction spelled out, rather than having it
   read as a person id that happens to parse. */
const bogus = await get(`/api/driver/profile?person=64686123-8389&${W}`);
check('a person parameter that is not a person id is refused, not guessed at',
  bogus.status === 400 && /different namespaces/.test(bogus.body.detail || ''),
  `${bogus.status} ${JSON.stringify(bogus.body).slice(0, 120)}`);

/* THE DIRECTORY'S SHAPE IS UNTOUCHED. Several consumers read it as a bare
   array; wrapping it in an object to carry a person id would break every one
   of them silently, and the redirect makes it unnecessary. */
const dir = await get(`/api/drivers/directory?${W}`);
check('the directory is still a bare array, as its consumers read it',
  Array.isArray(dir.body) && dir.body.length > 0, typeof dir.body);

/* ── a register that could not be READ is not a register that is empty ── */
await q('DROP TABLE driver_platform_id CASCADE');
clearPersonMapCache();
const blindExt = await get(`/api/driver/profile?id=u-amina&${W}`);
check('an account page survives a register that cannot be read',
  blindExt.status === 200 && blindExt.body.span?.trips > 0,
  `${blindExt.status} ${blindExt.body.span?.trips}`);
check('…and says WE failed rather than that this driver has no person',
  /could not be read/.test(blindExt.body.person_absent_reason || '')
  && /failure of the query/.test(blindExt.body.person_absent_reason || ''),
  blindExt.body.person_absent_reason);
const blindPerson = await get(`/api/driver/profile?person=412&${W}`);
check('and a person address refuses rather than reporting "no such driver"',
  blindPerson.status === 503 && /could not be read/.test(blindPerson.body.error || ''),
  `${blindPerson.status} ${JSON.stringify(blindPerson.body).slice(0, 140)}`);

apiServer.close();
await db.close();

/* ══ 2. THE PAGE ════════════════════════════════════════════════════════ */
const srv = mockApp.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
/* reducedMotion, because the headline numbers count up over 620ms and any
   assertion that reads a .kpi figure without it is a race — see
   test/charging_page.test.mjs, which learned this the same way. */
const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 },
  reducedMotion: 'reduce' });
const page = await ctx.newPage();
const open = async (hash) => {
  await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.idcard', { timeout: 20000 });
  /* The rewrite happens after the profile lands and before the tabs are
     appended, so the tab bar is the signal that the shell has finished. */
  /* `#view .tabs`, scoped: the shell's own section navigation is also a
     `.tabs` bar and is on screen before the page has fetched anything, so an
     unscoped wait returns immediately and every assertion below it races. */
  await page.waitForSelector('#view .tabs', { timeout: 20000 });
};

console.log('\nthe person address');
await open('#driver/p401');
{
  const card = await page.evaluate(() => document.querySelector('.idcard')?.innerText || '');
  check('a person address renders the page', /Ahmed Tarig Mohamed/.test(card), card.slice(0, 120));
  check('…and the header carries the person id it is addressed by',
    /\bp401\b/.test(card), card.replace(/\n/g, ' | ').slice(0, 300));
  /* drv-0 holds a second account on Yango in the fixture, which is the whole
     point of the row: the reader can see WHICH records this page folds. */
  const pills = await page.evaluate(() => [...document.querySelectorAll('.idcard .pill')]
    .map((x) => x.textContent.trim()));
  check('…and every account they hold, with the platform each is on',
    pills.some((t) => /^Uber drv-0$/i.test(t)) && pills.some((t) => /^Yango y-0$/i.test(t)),
    JSON.stringify(pills));
  check('…and the address stays canonical, untouched',
    /#driver\/p401$/.test(page.url()), page.url());
}

console.log('\nan old account link');
const kpiOf = () => page.evaluate(() => [...document.querySelectorAll('.kpi')]
  .map((k) => k.innerText.replace(/\s+/g, ' ').trim()).slice(0, 4).join(' // '));
const personKpis = await kpiOf();
await open('#driver/drv-0');
{
  check('an account address still opens the page it always did',
    /Ahmed Tarig Mohamed/.test(await page.evaluate(() => document.querySelector('.idcard').innerText)),
    page.url());
  check('…and renders the identical figures, not a smaller person',
    (await kpiOf()) === personKpis,
    `${(await kpiOf()).slice(0, 120)}\n        vs ${personKpis.slice(0, 120)}`);
  /* THE ASSERTION THE REWRITE EXISTS FOR — what the reader copies out of the
     address bar is the id that does not move. */
  check('an account address leaves the reader holding the person address',
    /#driver\/p401$/.test(page.url()), page.url());
}

console.log('\nthe rewrite keeps everything else about the address');
await open('#driver/drv-0/money');
check('…with the tab it was opened on intact',
  /#driver\/p401\/money$/.test(page.url()), page.url());
/* The day a replay link carries lives in the QUERY string, not the path —
   rebuilding the address through href() would have dropped it and silently
   changed which day is on screen. */
await open('#driver/drv-0/day?on=2026-08-25');
check('…and with the day a replay link carried',
  /#driver\/p401\/day\?on=2026-08-25$/.test(page.url()), page.url());

console.log('\nthe tabs link by the person from either door');
await open('#driver/drv-0');
{
  const tabHrefs = await page.evaluate(() => [...document.querySelector('#view .tabs').querySelectorAll('a')]
    .map((a) => a.getAttribute('href')));
  check('every tab on the page links by the person id',
    tabHrefs.length > 0 && tabHrefs.every((h) => /^#driver\/p401(\/|$|\?)/.test(h)),
    JSON.stringify(tabHrefs.slice(0, 4)));
}

console.log('\nan account the spine has not placed');
await open('#driver/drv-unreviewed');
{
  const body = await page.evaluate(() => document.body.innerText);
  check('it renders the page rather than an error',
    !/No such driver/.test(body) && (await page.locator('.kpi').count()) > 0,
    body.slice(0, 160).replace(/\n/g, ' | '));
  check('…and says which state it is in rather than leaving the line blank',
    /has not placed this account/.test(body) && /reviewed decisions only/.test(body),
    (await page.evaluate(() => document.querySelector('.idcard')?.innerText || ''))
      .replace(/\n/g, ' | ').slice(0, 260));
  check('…and keeps its provider address, because it has no other one',
    /#driver\/drv-unreviewed$/.test(page.url()), page.url());
  check('…and its tabs go on linking by the account, not by a person it lacks',
    (await page.evaluate(() => [...document.querySelector('#view .tabs').querySelectorAll('a')]
      .map((a) => a.getAttribute('href')))).every((h) => /^#driver\/drv-unreviewed(\/|$|\?)/.test(h)),
    JSON.stringify(await page.evaluate(() => [...document.querySelector('#view .tabs').querySelectorAll('a')]
      .map((a) => a.getAttribute('href')).slice(0, 3))));
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
