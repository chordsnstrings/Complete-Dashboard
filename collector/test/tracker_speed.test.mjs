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

/* ── a skeleton that told the reader its own array index ──────────────────
   loading() takes an optional message for a panel that KNOWS it is slow —
   #sources' field inventory is a scan over every stored record and says so
   rather than showing an identical grey box for four seconds. Twenty-four
   places in this product write `[a.body, b.body, c.body].forEach(loading)`,
   and Array.forEach hands its callback (element, INDEX, array): every panel
   after the first was asked to declare itself slow with the message "1", "2",
   "3". On a cold #unit at a wide window, seven skeletons replaced "Loading…"
   with a bare index a second after the page opened.

   bin/render-audit.mjs could not see it — a skeleton is a skeleton — which is
   why the guard is asserted here instead. */
console.log('\nthe loading skeleton says "Loading…", or a sentence, and never a number');
const skel = (arg) => page.evaluate(async (a) => {
  const ui = await import('/ui.js');
  document.querySelector('#skelhost')?.remove();
  const host = document.createElement('div');
  host.id = 'skelhost';
  document.body.append(host);
  if (a === '__forEach') [host].forEach(ui.loading);
  else if (a === undefined) ui.loading(host);
  else ui.loading(host, a);
  await new Promise((r) => setTimeout(r, 1500));
  const s = host.querySelector('.skel');
  return { text: s?.textContent.trim() || null, says: !!s?.classList.contains('says') };
}, arg);

check('a plain call stays "Loading…"', (await skel(undefined)).text === 'Loading…');
check('a real message replaces it after a beat',
  (await skel('Reading the whole record — this one takes a while')).says === true);
/* The index, exactly as forEach sends it. 0 was already harmless by being
   falsy, which is why this went unnoticed on the first panel of every page. */
for (const i of [0, 1, 7]) {
  const r = await skel(i);
  check(`an index of ${i} is not a message`, r.text === 'Loading…' && !r.says, JSON.stringify(r));
}
/* And through forEach itself, which is the shape the call sites actually use
   — a guard that only holds for a hand-written number would not have caught
   this one. */
const viaForEach = await skel('__forEach');
check('…and neither is anything forEach passes a callback',
  viaForEach.text === 'Loading…' && !viaForEach.says, JSON.stringify(viaForEach));
/* An empty string is not a sentence either: a panel declaring itself slow with
   nothing to say would blank the word the reader is waiting on. */
check('an empty message leaves the word alone', (await skel('')).text === 'Loading…');

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
