/* A speed column that is empty whenever the car is parked.
   ─────────────────────────────────────────────────────────────────────────
   bin/render-audit.mjs: "Speed is empty in 33 of 40 rows" on a vehicle's
   movement tab. Measured on production over 2,633 fixes of one plate, the FMS
   feed reports a speed for every Moving fix and none for any Idle or Stopped
   one — 1,063 moving with a number, 1,570 still with none, and not one
   exception either way. So the column is not sparse: it is a moving-only
   measurement on a vehicle that spends most of its time still, and a dash
   there is the car being parked.

   The word that says so has been in the payload all along, and three of the
   four tables that draw these fixes threw it away. They share these cells now
   because a fourth copy of the sentence is a fourth chance for one of them to
   describe the same feed differently. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'domcontentloaded' });

const draw = (rows) => page.evaluate(async (rs) => {
  const ui = await import('/ui.js');
  document.querySelector('#trk')?.remove();
  const host = document.createElement('div');
  host.id = 'trk';
  document.body.append(host);
  host.append(ui.tableFrom(rs, [
    { label: 'Time', key: 'captured_at' }, ui.trackerState, ui.trackerSpeed,
  ]));
  const n = ui.stillNote(rs);
  if (n) host.append(n);
  const t = host.querySelector('table');
  const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim());
  return {
    heads,
    cells: [...t.querySelectorAll('tbody tr')].map((r) => [...r.cells].map((c) => c.textContent.trim())),
    titles: [...t.querySelectorAll('tbody tr')].map((r) => r.cells[2]?.querySelector('[title]')?.title || null),
    note: host.querySelector('p.cap')?.textContent || null,
  };
}, rows);

const fix = (i, status, speed) => ({ captured_at: `10:0${i}`, status, speed });

console.log('\na stationary fix says what it is, in the column beside the dash');
const mixed = await draw([
  fix(1, 'Moving', 38), fix(2, 'Idle', null), fix(3, 'Stopped', null),
  fix(4, 'Moving', 51), fix(5, 'Stopped', null),
]);
check('both columns are drawn', mixed.heads.includes('State') && mixed.heads.includes('Speed'),
  JSON.stringify(mixed.heads));
check('a moving fix carries its speed', mixed.cells[0][2] === '38 km/h', JSON.stringify(mixed.cells[0]));
check('a stationary one carries a dash', mixed.cells[1][2] === '—', JSON.stringify(mixed.cells[1]));
check('…and the state word that explains it', mixed.cells[1][1] === 'Idle' && mixed.cells[2][1] === 'Stopped',
  JSON.stringify(mixed.cells.map((c) => c[1])));
check('the dash names the state in its own tooltip too, for a cell read alone',
  /this fix is idle/.test(mixed.titles[1] || ''), String(mixed.titles[1]));

console.log('\nand the table says how many, in the words of the fixes it holds');
check('a sentence appears', !!mixed.note, String(mixed.note));
check('…counting the still fixes', /Speed is empty on 3 of these 5 fixes/.test(mixed.note), mixed.note);
check('…and naming the states from the rows rather than a fixed list',
  /idle or stopped|stopped or idle/.test(mixed.note), mixed.note);
check('…and saying what a dash there is', /stationary car, not a reading that went missing/.test(mixed.note),
  mixed.note);

console.log('\nnothing is said when there is nothing to explain');
const allMoving = await draw([fix(1, 'Moving', 38), fix(2, 'Moving', 44)]);
check('every fix moving: no sentence', allMoving.note === null, String(allMoving.note));
/* Every fix still is the other end of it. There the column IS dead, and
   tableFrom's own `absent` machinery is the right answer — a sentence about
   some of the rows would be wrong about all of them. */
const allStill = await draw([fix(1, 'Stopped', null), fix(2, 'Idle', null)]);
check('every fix stationary: no sentence either', allStill.note === null, String(allStill.note));

console.log('\na feed that sends no state word is not made to have one');
const noState = await draw([fix(1, null, 12), fix(2, null, null), fix(3, null, null)]);
check('the State cell is an explained dash', noState.cells[0][1] === '—', JSON.stringify(noState.cells[0]));
check('the sentence still counts, and claims no words it does not have',
  /Speed is empty on 2 of these 3 fixes/.test(noState.note) && !/those fixes are/.test(noState.note),
  String(noState.note));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
