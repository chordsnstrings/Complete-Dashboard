/* THE MENU ASKS WHAT THE SERVER WILL ASK — for pages built on a list.
   ═════════════════════════════════════════════════════════════════════════
   #playbook is about revenue and built on /api/playbook, a list of bookings;
   #unit on /api/economics/assets, a list of vehicles; #corporate/leakage on
   a list of bookings; #platforms/tiers on a list of vehicles. The wall
   screen holds revenue in full and bookings and vehicles only as totals, so
   the menu offered these pages and the server then refused each of them
   whole (bin/access-sweep.mjs, 2026-09-28: 4 of its 15 findings).

   REVERSION: empty VIEW_LIST_NEEDS in api/public/access.js — check 1 fails;
   drop closingClass from the router (subjectOf again) — check 3 fails. */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const access = await import('../api/public/access.js');
const { ROLES, ROLE } = await import('../api/public/access_model.js');
const as = (code) => {
  const lv = ROLE[code].levels;
  Object.assign(access.who, { loaded: true, signedIn: true, kind: ROLE[code].device ? 'device' : 'user', roles: [code],
    access: { levelsAny: lv, levels: lv, capsAny: ROLE[code].caps || [] } });
};
/* As the address gives them: parseHash reads #platforms/tiers as view
   'platforms', PARAM 'tiers'. The first version of this test passed the tab
   as `sub`, which the router never does — and passed while the menu still
   offered both pages (re-sweep, 2026-09-28). */
const PAGES = [['playbook', ''], ['unit', ''], ['corporate', 'leakage'], ['platforms', 'tiers']];
const open = (v, t) => access.canOpenView(v, '', t);

console.log('\n1. the wall screen is not offered a page the server refuses it');
as('WALL');
for (const [v, s] of PAGES) {
  check(`#${s ? `${v}/${s}` : v} is closed to the wall screen`, open(v, s) === false);
}
check('…while the pages it can read stay open (the overview, revenue, the corporate summary)',
  ['overview', 'revenue', 'corporate'].every((v) => access.canOpenView(v)));

console.log('\n2. no other role loses a page by it');
/* Every role that holds the list's class at M or better is unaffected: the
   rule can only close a page for a reader who sees that list as totals. */
const changed = [];
for (const r of ROLES.filter((x) => x.code !== 'WALL')) {
  as(r.code);
  for (const [v, s] of PAGES) {
    const need = access.VIEW_LIST_NEEDS[s ? `${v}/${s}` : v];
    const lv = ROLE[r.code].levels[need] || '';
    if ((lv === 'M' || lv === 'F') && access.closingClass(v, '', s) !== access.subjectOf(v, '', s)) changed.push(`${r.code}:${v}/${s}`);
  }
}
check('a role holding the list in full keeps the page', changed.length === 0, changed.join(' '));
/* A tab of #unit is judged by its own subject, not by #unit's list: the cash
   desk (driver names, no vehicles in full) keeps #unit/drivers. */
as('CLK');
check('a tab is not held to its page\'s list (#unit/drivers for the cash desk)', open('unit', 'drivers') === true && access.closingClass('unit', '', 'drivers') === 'ID');

console.log('\n3. the closed page names the class that closes it');
as('WALL');
check('the wall screen is told #playbook is closed over bookings, not revenue (which it holds in full)',
  access.closingClass('playbook', '') === 'BK', access.closingClass('playbook', ''));
const app = readFileSync(new URL('../api/public/app.js', import.meta.url), 'utf8');
check('the router uses it for the closed page', /const cls = closingClass\(state\.view/.test(app));
access.who.signedIn = false;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
