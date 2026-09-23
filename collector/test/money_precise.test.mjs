/* MONEY, PRECISE TO THE FILS — the operator's ruling of 2026-09-23.
   ══════════════════════════════════════════════════════════════════════════
   docs/UI-REDESIGN-PLAN.md §1, ruling 2: "every money figure is PRECISE, with
   decimal points (AED 1,275.14), on every page, tile, table and chart label",
   in both skins. Before it, one page carried three precisions at once:

     - money() took a third argument defaulting to 0, so a total printed as
       whole dirhams and only a rate asked for two decimals; sixteen call
       sites passed 0 on purpose;
     - ~20 renders built the string by hand — 'AED ' + fmt(x), AED ${fmt(x, 0)},
       AED ${fmt(Math.round(x))} — each dropping the fils its own way;
     - the API itself rounded most money to the dirham before it left the
       server (round(sum(price)::numeric, 0), round(v, 0) in JS), so no page
       could have printed the fils even if it had asked. A whole-dirham figure
       printed with ".00" behind it claims a precision that was thrown away.

   And one fallback printed a nought for nothing measured: #charging's
   headline fell back to the literal 'AED 0.00' when no charging row existed
   in the window (test/charging_page.test.mjs renders that case).

   What this file pins, and the reversion that proves each part:
     1. money() — two decimals, separators, U+2212 before the currency, absent
        is '—'. REVERT: put back `d = 0` and pass it to toLocaleString; the
        first check fails on 'AED 1,234'.
     2. A caller cannot re-open whole dirhams by passing 0. REVERT: honour a
        third argument again; check 2 fails.
     3. The server's sentence formatter (src/util.js aedText) prints what the
        page prints. REVERT: aedText with toFixed(2); the parity check fails
        on the separator.
     4. No inline money render is left in api/public. REVERT: restore any one
        `'AED ' + fmt(` in app.js; check 4 names the file and line.
     5. No API query rounds a money column to the dirham. REVERT: restore
        `round(sum(price)::numeric,0) revenue` in api/server.js; check 5
        names it. */
import { readFileSync, readdirSync } from 'node:fs';
import { money, fils } from '../api/public/ui.js';
import { aed } from '../api/public/deposit_core.js';
import { aedText } from '../src/util.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const MINUS = '−';

console.log('\nthe one helper');
check('a whole amount carries its fils', money(1234) === 'AED 1,234.00', money(1234));
check('the ruling’s own example', money(1275.14) === 'AED 1,275.14', money(1275.14));
check('a figure with fils keeps both digits', money(2.7) === 'AED 2.70', money(2.7));
check('rounded to the fils, not truncated', money(17869.675) === 'AED 17,869.68'
  || money(17869.675) === 'AED 17,869.67', money(17869.675));
check('a caller passing 0 decimals still gets the fils — the argument cannot re-open whole dirhams',
  money(1234, 'AED', 0) === 'AED 1,234.00', money(1234, 'AED', 0));
check('a negative puts the true minus before the currency',
  money(-600.59) === `${MINUS}AED 600.59`, money(-600.59));
check('a minus that rounds to nought is not printed', money(-0.004) === 'AED 0.00', money(-0.004));
check('a numeric string from Postgres formats', money('15723.5') === 'AED 15,723.50', money('15723.5'));
check('a measured nought is a nought', money(0) === 'AED 0.00', money(0));
check('absent is a dash, never AED 0.00',
  money(null) === '—' && money(undefined) === '—' && money('') === '—'
  && money(NaN) === '—' && money(Infinity) === '—');
check('fils() is the same figure without its currency',
  fils(24118.2) === '24,118.20' && fils(-5) === `${MINUS}5.00` && fils(null) === '—',
  `${fils(24118.2)} ${fils(-5)} ${fils(null)}`);

console.log('\nthe other two formatters print what money() prints');
{
  const vals = [0, 4500, 1275.14, -600.5, 1135725, 0.1, '420', -0.004];
  const bad = vals.filter((v) => aedText(v) !== money(v));
  check('src/util.js aedText (sentences the API writes) matches money() value for value',
    bad.length === 0, JSON.stringify(bad.map((v) => [v, aedText(v), money(v)])));
  check('…and its absent is null, so a caller has to supply a reason',
    aedText(null) === null && aedText('') === null && aedText('x') === null);
  const badD = vals.filter((v) => aed(v) !== money(v));
  check('deposit_core aed() is money(), not a second formatter with its own locale and minus',
    badD.length === 0, JSON.stringify(badD.map((v) => [v, aed(v), money(v)])));
  check('…and its absent is null', aed(null) === null && aed('') === null);
}

console.log('\nno money is rendered around the helper');
{
  const dir = new URL('../api/public/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => f)
    .concat(readdirSync(new URL('m/', dir)).filter((f) => f.endsWith('.js')).map((f) => `m/${f}`));
  const hits = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    /* Comments quote the old strings on purpose — they are the record of the
       defect — so the scan reads code only. Line numbers survive because each
       comment is replaced by as many newlines as it spanned. */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
    code.split('\n').forEach((line, i) => {
      if (/'AED ' \+|AED \$\{(fmt|Math|dec)\(|AED \$\{[a-z_.?]+\}\/|\|\|\s*'AED 0(\.00)?'/.test(line)) {
        hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 90)}`);
      }
    });
  }
  check('no hand-built "AED " + number in any page — every money figure goes through money()',
    hits.length === 0, `\n      ${hits.join('\n      ')}`);

  /* A chart of a money series is a money figure too: its tooltip and its value
     labels printed charts.js fmt(), which drops the fils and the currency, so
     #vehicle/earnings' "Measured fares" bars read "1,240" and #unit's scatter
     read "money in (AED): 3,861". Every chart call whose y (or scatter y) is a
     money column must say how to print money.
     REVERT: drop `valueFmt: (v) => money(v)` from vehicle.js's Measured fares
     barChart; this names it. */
  const MONEY_Y = /\by:\s*'(fares|revenue|money|amount|attributed|payouts?|earnings|in_fares)'/;
  const bare = [];
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    const re = /\b(barChart|gapBars|areaChart|scatter)\(/g;
    let m;
    while ((m = re.exec(src))) {
      if (/function\s+$/.test(src.slice(Math.max(0, m.index - 12), m.index))) continue;
      let i = m.index + m[0].length, depth = 1;
      while (i < src.length && depth) { if (src[i] === '(') depth++; else if (src[i] === ')') depth--; i++; }
      const call = src.slice(m.index, i);
      if (MONEY_Y.test(call) && !/(valueFmt|yFmt):\s*(\(v\)\s*=>\s*)?money\b/.test(call)) {
        bare.push(`${f}:${src.slice(0, m.index).split('\n').length}: ${call.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
  }
  check('every chart of a money series prints its values through money()',
    bare.length === 0, `\n      ${bare.join('\n      ')}`);
}

console.log('\nno API rounds money to the dirham');
{
  const dir = new URL('../api/', import.meta.url);
  const MONEY = '(revenue|payout|payouts|money|amount|earnings|fares?|priced_measured_revenue'
    + '|measured_impact|modelled_impact|cost|cash_value|statement_cash|statement_fares|gross'
    + '|projected_revenue|forgone_at_own_rate|overrun_value|foc_cost|commission_cost|measured'
    + '|total_cash_value_known|total_statement_cash|total)';
  const sqlWhole = new RegExp(`::numeric,\\s*0\\)\\s*(AS\\s+)?${MONEY}\\b`);
  const jsWhole = new RegExp(`\\b${MONEY}:\\s*[^,\\n]*\\bround\\([^\\n]*,\\s*0\\)`);
  const hits = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    readFileSync(new URL(f, dir), 'utf8').split('\n').forEach((line, i) => {
      if (sqlWhole.test(line) || (jsWhole.test(line) && !/\bkm\b|_km\b|has_cost/.test(line))) {
        hits.push(`api/${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  check('every money column leaves the server with its fils',
    hits.length === 0, `\n      ${hits.join('\n      ')}`);
  const playbook = readFileSync(new URL('playbook_routes.js', dir), 'utf8');
  check('the playbook’s "Chase AED … owed" title is written through aedText, not Math.round',
    /title: `Chase \$\{aedText\(recv\.amount\)\} owed/.test(playbook)
    && !/Chase AED \$\{Math\.round/.test(playbook));
  check('and its measured and modelled figures are rounded to the fils',
    /aed_measured: [^\n]*\* 100\) \/ 100/.test(playbook) && /aed_modelled: [^\n]*\* 100\) \/ 100/.test(playbook));
  const ledger = readFileSync(new URL('ledger_routes.js', dir), 'utf8');
  check('the ledger’s confirming sentence prints money the way the page does',
    /of \$\{aedText\(amount\)\}/.test(ledger) && !/AED \$\{amount\.toFixed/.test(ledger));
}

console.log(`\n${fail ? '✗' : '✓'} money_precise: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
