/* One human on the roster twice, and a page that reads it as two.
   ─────────────────────────────────────────────────────────────────────────
   bin/numbers-audit.mjs reported three payouts that had a column on
   #roster/pipeline, sat in a row it was showing, and were not in that row. The
   rows turned out to be different people from the payouts — "Anoj Gautam" has
   646 lifetime trips and "Anoj Gautam Mohan Bahadur" has never driven — which
   is not a rendering fault. It is one man filed twice: once under the name a
   provider issues him by, once under his full legal name.

   personFold cannot see it and must not be made to. It collapses case,
   whitespace and a repeated word — the noise it was written for — and a name
   carrying three extra words in the middle is not noise. Folding on a shared
   prefix instead would merge real people: this product's own code records
   "Muhammad Khalid" and "Muhammad Khalid Gul" as two different drivers, both
   with payouts.

   So the page states the suspicion beside the row and merges nothing. On
   production 65 of the 134 people this tab lists carry a candidate — half a
   list an operator reads as people to chase.

   What is asserted here is the shape of the rule, in both directions: which
   pairs it must catch, and the four kinds of pair it must leave alone. */
import { launchChromium } from './browser.mjs';
import express from 'express';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'domcontentloaded' });

/* Through the module the page runs, not a copy of the rule. */
const twin = (name, others) => page.evaluate(async ([nm, os]) => {
  const r = await import('/roster.js');
  const drove = os.map((o, i) => ({ name: o.name, driver_ext_id: `d${i}`,
    lifetime_trips: o.lifetime, trips: 0 }));
  const found = r.twinFor({ name: nm, lifetime_trips: 0, trips: 0 }, drove);
  return found ? found.name : null;
}, [name, others]);

const DROVE = [
  { name: 'Anoj Gautam', lifetime: 646 },
  { name: 'Aamir Khan Amin', lifetime: 2779 },
  { name: 'Muhammad Khalid', lifetime: 4020 },
  { name: 'Bashir Ahmad Amin', lifetime: 1026 },
  { name: 'Ali Nawaz Nawaz', lifetime: 1995 },
  { name: 'Ahmed', lifetime: 900 },
];

console.log('\nthe pairs it must catch');
check('a fuller legal name over the name a provider files',
  await twin('Anoj Gautam Mohan Bahadur', DROVE) === 'Anoj Gautam');
check('extra words in the MIDDLE, not only at the end',
  await twin('AAMIR KHAN ROOHUL AMIN AMIN', DROVE) === 'Aamir Khan Amin');
check('case is not a difference — the fold already settled that',
  await twin('ALI NAWAZ MUHAMMAD NAWAZ', DROVE) === 'Ali Nawaz Nawaz');
/* And the other direction: the shorter name is the one with no output. */
check('the shorter name can be the idle one',
  await twin('Bashir Ahmad', DROVE) === 'Bashir Ahmad Amin');

console.log('\nand the ones it must refuse');
/* The whole risk of this rule. Merging two people is not recoverable, so it
   has to be wrong in the safe direction. */
check('a different given name is a different person, whatever the surnames share',
  await twin('Imran Khan Amin', DROVE) === null,
  'matched on surnames alone');
check('a single-word name matches nobody — it is not enough to go on',
  await twin('Ahmed', DROVE) === null);
check('…and nobody matches a single-word driver either',
  await twin('Ahmed Tarig Mohamed', [{ name: 'Ahmed', lifetime: 900 }]) === null);
check('a name sharing only its first word is not a candidate',
  await twin('Muhammad Yusuf Iqbal', DROVE) === null,
  'a first-name match alone would name half this roster');
check('an identical name is not its own twin',
  await twin('Anoj Gautam', [{ name: 'Anoj Gautam', lifetime: 646 }]) === null);
/* The pair the product already treats as two drivers. Both have driven, so
   neither is a candidate — the signal is a record with NO output beside one
   with a great deal of it, and this rule is only ever asked about the first. */
check('two people who have both driven are never offered to each other',
  await page.evaluate(async () => {
    const r = await import('/roster.js');
    const a = { name: 'Muhammad Khalid', trips: 293, lifetime_trips: 4020 };
    const b = { name: 'Muhammad Khalid Gul', trips: 242, lifetime_trips: 3011, driver_ext_id: 'x' };
    return r.hasDriven(a) && r.hasDriven(b);
  }), 'both have output, so neither is annotated');

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
