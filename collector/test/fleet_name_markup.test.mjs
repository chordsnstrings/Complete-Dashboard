/* A FLEET'S NAME IS TEXT A PLATFORM ACCOUNT HOLDER TYPED — never markup.
   ═════════════════════════════════════════════════════════════════════════
   Since 2026-09-26 the pages call a fleet what the platforms call it
   (src/fleet_names.js derives it; /api/auth/me hands it over). That made a
   string from outside the product part of a few dozen HTML templates:
   sourceLabel() alone reaches ~40 of them, not all through esc(). The
   security review of 2026-09-28 found four sinks that wrote it unescaped
   (the HR roster's two fleet splits and its duplicate-id line, the
   Overview's "Trips by fleet" caption).

   Two locks, both checked here:
     1. access.js fleetList() drops the characters that open a tag or leave a
        double-quoted attribute, once, before any page sees the name;
     2. the four sinks the review named escape what they write.

   REVERSION: return f.name unfiltered in fleetList() — check 1 fails;
   remove esc() around fleetLabel in hrroster.js — check 3 fails. */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const access = await import('../api/public/access.js');

console.log('\n1. a hostile name arrives as text');
access.who.fleets = [
  { id: 'ecosine', name: 'Eco<img src=x onerror=alert(1)>sine' },
  { id: 'egari', name: 'Smith & "Sons"\u0007' },
];
const names = access.fleetList().map((f) => f.name);
check('no fleet name can open a tag or leave an attribute', names.every((n) => !/[<>"`\u0000-\u001f]/.test(n)), JSON.stringify(names));
check('fleetLabel and fleetNames read the same cleaned names',
  !/[<>]/.test(access.fleetLabel('ecosine')) && !/[<>"]/.test(access.fleetNames()), access.fleetNames());
check('an ampersand in a real brand survives', access.fleetLabel('egari') === 'Smith & Sons', access.fleetLabel('egari'));

console.log('\n2. a name with nothing left falls back to the fleet\'s own id');
access.who.fleets = [{ id: 'ecosine', name: '<>' }];
check('never an empty label', access.fleetLabel('ecosine') === 'Ecosine', access.fleetLabel('ecosine'));
access.who.fleets = [];

console.log('\n3. the sinks the review named escape what they write');
const src = (f) => readFileSync(new URL(`../api/public/${f}`, import.meta.url), 'utf8');
const hr = src('hrroster.js');
/* The three innerHTML sinks by their exact text. The fourth use of
   fleetLabel on that page is written with textContent, where escaping would
   print "&amp;" — so it is deliberately not asked for. */
check('the HR roster escapes the fleet names it writes into HTML',
  ['esc(fleetLabel(f) || f)', 'esc(fleetLabel(d.fleet_id) || d.fleet_id)', 'esc(fleetLabel(f))'].every((x) => hr.includes(x)));
check('…and the employee id beside it', /esc\(d\.employee_id\)/.test(hr));
check('the Overview\'s fleet caption escapes the names', /esc\(fleetNames\(' vs '\)\)/.test(src('app.js')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
