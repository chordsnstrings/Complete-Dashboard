/* WHAT THE FLEET-WIDE UNAUTHORIZED LIST IS ALLOWED TO SAY ABOUT A PERSON.
   ═══════════════════════════════════════════════════════════════════════════
   An unauthorized trip is, by definition, a journey with no booking against
   it — so no trip record names its driver, and every name #segments prints
   beside one is an INFERENCE. Naming the wrong person accuses an innocent
   employee of theft, which is what makes the assertions below load-bearing in
   a way a chart's are not: the failure mode is not a wrong number, it is a
   wrong name on an accusation.

   api/unauthorized_sql.js decides WHO, and test/unauthorized_attribution.test.mjs
   asserts that decision against a real Postgres. This file asserts the other
   half — what the PAGE does with the answer — because every discipline the SQL
   observes can be undone by one table cell:

     1. the TIER is in front of the name, always. A name with no tier is a name
        read as a fact.
     2. an AMBIGUOUS row prints EVERY candidate, joined by "or". Printing the
        first, or joining them with a comma, turns a question into a list of
        people who did it.
     3. an UNKNOWN row names NOBODY — and specifically not the nearest booking,
        which is on the row, names a real person, and has a median gap of 97
        minutes on production. It is the plausible name a reader would take for
        an answer on exactly the rows where there is no answer.
     4. a row with NO attribution is not an UNKNOWN row. The first means the
        ladder never ran on it; the second means it ran and reached nobody.
        Rendering them alike would report a matched, explained segment as a
        journey nobody can account for.
     5. every name is a LINK to that person. api/custody_sql.js explains why a
        comma-joined string of names is a dead end by construction.

   Run in a real browser against the shipped module, for the reason
   test/absent_columns.test.mjs gives: segmentTable builds elements and sets
   innerHTML, and a hand-rolled document shim would be testing the shim. No
   server data is involved — the rows below are this file's own.

   Each assertion was proved by REVERSION rather than by passing; the reversion
   that proves it is written beside it. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const port = server.address().port;

const browser = await launchChromium();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

/* Everything below runs IN the page, against the real module. */
const build = (rows) => page.evaluate(async (rs) => {
  const seg = await import('/segments.js');
  const t = seg.segmentTable(rs);
  const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim());
  const who = heads.findIndex((h) => h === 'Who the evidence names' || h === 'Driver that day');
  const cells = [...t.querySelectorAll('tbody tr')].map((tr) => {
    const td = tr.children[who];
    return {
      text: td.textContent.replace(/\s+/g, ' ').trim(),
      html: td.innerHTML,
      tag: (td.querySelector('.tag') || {}).textContent || null,
      tagClass: (td.querySelector('.tag') || {}).className || '',
      links: [...td.querySelectorAll('a.ent')].map((a) => ({ href: a.getAttribute('href'), text: a.textContent })),
      title: (td.querySelector('.tag') || {}).title || '',
    };
  });
  return { heads, whoHead: heads[who], cells, html: t.innerHTML };
}, rows);

/* Two people who both held L45243 that day — the handover case the operator
   asked to have narrowed, taken from api/unauthorized_sql.js's own measurement. */
const WASEEM = { name: 'Waseem Abbas Ghulam Nabi', id: 'u-waseem', key: 'k-waseem' };
const ZAIN = { name: 'Zain Hassan Raja Nasrullah Khan', id: 'u-zain', key: 'k-zain' };

const base = (o) => ({
  plate: 'L45243', fleet_id: 'ecosine', verdict: 'unauthorized',
  started_at: '2026-08-24T05:33:00.000Z', ended_at: '2026-08-24T05:48:00.000Z',
  duration_min: 15, distance_km: 4.2, top_speed: 86, low_confidence: false,
  verdict_reason: 'no completed booking on any collected channel overlaps this window',
  ...o,
});

const bracketed = base({
  attribution_tier: 'bracketed', attribution_candidates: [ZAIN],
  attribution_candidate_count: 1, attribution_candidate_keys: [ZAIN.key],
  attribution_evidence: 'Named by time: Zain Hassan Raja Nasrullah Khan. Their Uber trip on '
    + 'L45243 ended 54 minutes before this journey started, and their next began 75 minutes after.',
  bracket_before_min: 54, bracket_after_min: 75, custodian_count: 2,
});
const ambiguous = base({
  plate: 'L44305',
  attribution_tier: 'ambiguous', attribution_candidates: [WASEEM, ZAIN],
  attribution_candidate_count: 2, attribution_candidate_keys: [WASEEM.key, ZAIN.key],
  attribution_evidence: 'Two people held L44305 on 2026-08-24 and nothing separates them.',
  custodian_count: 2,
});
/* The row where the temptation lives: nobody can be named, and a real person's
   name is sitting on the row in `nearest_booking`. */
const unknown = base({
  plate: 'L45240',
  attribution_tier: 'unknown', attribution_candidates: [],
  attribution_candidate_count: 0, attribution_candidate_keys: [],
  attribution_evidence: 'Nobody can be named. No booking on any channel names a driver for '
    + 'L45240 on 2026-08-24. The car’s usual driver is deliberately NOT shown.',
  custodian_count: 0,
  nearest_platform: 'uber', nearest_gap_min: 97,
  nearest_booking: { platform: 'uber', external_id: 'fa66c89c', name: WASEEM.name,
    id: WASEEM.id, key: WASEEM.key, gap_min: 97 },
});
/* The operator's own rule, which is the rung that carries most of this list
   and which this page had no label for at all — it was added to the ladder in
   api/unauthorized_sql.js and TIER_LABEL/TIER_SHORT were not updated with it,
   so a row on it printed its raw key. */
const lastTrip = base({
  plate: 'L45235',
  attribution_tier: 'last_trip', attribution_candidates: [ZAIN],
  attribution_candidate_count: 1, attribution_candidate_keys: [ZAIN.key],
  attribution_evidence: 'The last Uber trip on L45235 before this journey was Zain Hassan Raja '
    + 'Nasrullah Khan’s, ending 44 minutes earlier. That is the operator’s rule, and it is an '
    + 'inference from this car’s Uber record rather than a record of this journey.',
  attribution_last_trip_gap_min: 44, custodian_count: 2,
});
const sole = base({
  plate: 'L44251',
  attribution_tier: 'sole_custodian', attribution_candidates: [WASEEM],
  attribution_candidate_count: 1, attribution_candidate_keys: [WASEEM.key],
  attribution_evidence: 'Waseem Abbas Ghulam Nabi is the only person the trip record shows '
    + 'holding this car on 2026-08-24 — but this is custody, not driving.',
  custodian_count: 1,
});

console.log('\nevery name carries the rung that produced it');

const four = await build([bracketed, sole, ambiguous, unknown]);
check('the column is headed for the evidence, not for the day',
  four.whoHead === 'Who the evidence names', four.whoHead);
/* REVERSION: drop `tag` from attributionCell's return and every one of these
   cells still prints the right name — with nothing saying how sure we are. */
check('every attributed row leads with a tier tag',
  four.cells.every((c) => c.tag), JSON.stringify(four.cells.map((c) => c.tag)));
check('the four rungs render as four different words',
  new Set(four.cells.map((c) => c.tag)).size === 4, JSON.stringify(four.cells.map((c) => c.tag)));
/* REVERSION: pass `r.attribution_evidence` to the cell without putting it in a
   title and the sentence that makes a tier checkable disappears silently. */
check('the tier carries the evidence sentence a reader can check',
  four.cells.every((c) => c.title.length > 40), JSON.stringify(four.cells.map((c) => c.title.length)));

/* ── NO COLOUR RAMP DOWN A COLUMN OF PEOPLE ────────────────────────────────
   TIER_TONE was { bracketed: 'ok', sole_custodian: null, ambiguous: 'warn',
   unknown: 'dim' }. In this product a tone IS a verdict: a green tag beside a
   named person reads as "confirmed" when the green rung is still an inference,
   and an amber one on `ambiguous` reads as "this one is suspicious" when it
   actually means "nothing separates these people". Together they ranked four
   people by how strongly the product suspected them — the one choice the
   ladder refuses to make. api/public/driver.js renders the same ladder
   deliberately uncoloured and says why in a block comment; two surfaces, one
   ladder, one claim.

   REVERSION THAT PROVES THIS: set TIER_TONE.bracketed back to 'ok' and
   TIER_TONE.ambiguous back to 'warn' in api/public/segments.js. Both
   assertions below fail. */
console.log('\nno tone ranks one named person above another');
check('no tier tag beside a name carries a good or a bad colour',
  four.cells.every((c) => !/\b(ok|bad|warn)\b/.test(c.tagClass)),
  JSON.stringify(four.cells.map((c) => [c.tag, c.tagClass])));
check('…and the distinction is carried in the words instead',
  new Set(four.cells.map((c) => c.tag)).size === four.cells.length,
  JSON.stringify(four.cells.map((c) => c.tag)));

/* ── THE UNKNOWN CELL SAID THE SAME WORD TWICE ────────────────────────────
   The branch read `if (!cands.length)` and printed the tier tag followed by
   "nobody can be named". TIER_SHORT.unknown is the single word "nobody", so
   the one row on the page where nobody can be named — the row a reader looks
   hardest at — rendered "NOBODY nobody can be named".

   REVERSION THAT PROVES THIS: key the branch on `!cands.length` again and
   return `${tag} …nobody can be named`. This assertion fails. */
console.log('\nthe row where nobody can be named says it once');
check('the unknown cell does not print the word "nobody" twice',
  (four.cells[3].text.match(/nobody/gi) || []).length === 1, four.cells[3].text);

/* ── THE OPERATOR'S OWN RULE HAS A LABEL ──────────────────────────────────
   REVERSION THAT PROVES THIS: remove `last_trip` from TIER_SHORT in
   api/public/segments.js. The cell falls back to the raw key. */
console.log('\nthe operator’s rule is a rung with words, not a raw key');
const five = await build([lastTrip]);
check('a last_trip row renders a label rather than its own database key',
  five.cells[0].tag && five.cells[0].tag !== 'last_trip'
  && /trip/i.test(five.cells[0].tag), five.cells[0].tag);
check('…and the name it produced is still printed and still linked',
  five.cells[0].links.length === 1
  && five.cells[0].links[0].href.includes('#driver/u-zain'),
  JSON.stringify(five.cells[0].links));

console.log('\nambiguous: every candidate, joined by "or", and never a likeliest');

const amb = four.cells[2];
/* REVERSION: render `cands[0]` instead of cands.map(...) — the cell prints one
   name, the page reads as an accusation, and nothing else on screen changes. */
check('both candidates are printed', amb.links.length === 2, amb.text);
check('…both of them, by name',
  amb.text.includes(WASEEM.name) && amb.text.includes(ZAIN.name), amb.text);
/* REVERSION: join with ', ' — the cell becomes a list of people who did it
   rather than a question about which of them did. */
check('they are joined by "or", not by a comma',
  / or /.test(amb.text) && !new RegExp(`${WASEEM.name},`).test(amb.text), amb.text);
check('and neither is marked out as the likelier',
  amb.links.every((l) => !/likely|probabl|best/i.test(l.text)), amb.text);

console.log('\nunknown: nobody is named, and the nearest booking is not a candidate');

const unk = four.cells[3];
/* REVERSION: fall back to `r.nearest_booking.name` when candidates is empty —
   every unknown row gains a plausible name with a 97-minute gap behind it.
   This is the single most dangerous line this page could grow. */
check('an unknown row names nobody at all', unk.links.length === 0, unk.text);
check('…not even the nearest booking, whose driver is on the row',
  !unk.text.includes(WASEEM.name) && !unk.html.includes(WASEEM.id), unk.text);
check('and it says so in words rather than showing a dash',
  /nobody can be named/i.test(unk.text), unk.text);
check('the true reason travels with it',
  /No booking on any channel names a driver/.test(unk.title), unk.title);

console.log('\nbracketed: both gaps, stated rather than summarised');

/* REVERSION: drop the gaps span — "bracketed" becomes a word a reader has to
   take on trust, when the whole claim is that it can be checked against the
   car's own trip list. */
check('the gap before and the gap after are both on the row',
  /54m/.test(four.cells[0].text) && /75m/.test(four.cells[0].text), four.cells[0].text);

console.log('\nevery name is a link to that person, never a string');

check('each candidate opens their own profile',
  four.cells[0].links[0].href.includes('#driver/u-zain')
  && four.cells[1].links[0].href.includes('#driver/u-waseem'),
  JSON.stringify(four.cells.slice(0, 2).map((c) => c.links)));

console.log('\na row the ladder never ran on is not a row it reached nobody on');

/* A matched segment: explained by a booking, so no attribution is computed for
   it — and it must not render as "nobody can be named", which would report an
   accounted-for journey as an unaccounted-for one. */
const matched = base({
  plate: 'L63960', verdict: 'authorized', attribution_tier: null,
  attribution_absent: 'the attribution ladder is only run on unexplained journeys',
  drivers: WASEEM.name, driver_refs: [WASEEM],
  verdict_reason: 'matched uber trip fa66c89c',
});
const mixed = await build([bracketed, matched]);
/* REVERSION: let attributionCell fall through to the `unknown` branch when
   `tier` is absent and this row reads "nobody can be named" over a journey a
   booking explains. */
check('it keeps the day-custody name it always had',
  mixed.cells[1].text.includes(WASEEM.name), mixed.cells[1].text);
check('…labelled as day custody, so it cannot be read as a narrowed name',
  /day custody/i.test(mixed.cells[1].tag || ''), mixed.cells[1].tag);
check('…with the reason the ladder did not run on it',
  /only run on unexplained journeys/.test(mixed.cells[1].title), mixed.cells[1].title);

console.log('\nthe table other pages pass rows to is unchanged');

/* api/public/vehicle.js and api/public/day.js render the same table from
   /api/segments alone. The attribution column is conditional on the DATA, not
   on a flag, so those two keep the column they have always had — a page that
   silently upgraded day custody into "who the evidence names" would relabel an
   unnarrowed pair as a narrowed one. */
const plain = await build([
  base({ attribution_tier: undefined, drivers: `${WASEEM.name}, ${ZAIN.name}`,
    driver_refs: [WASEEM, ZAIN] }),
]);
check('with no attribution anywhere the heading stays "Driver that day"',
  plain.whoHead === 'Driver that day', plain.whoHead);
check('and both custodians are still printed and still linked',
  plain.cells[0].links.length === 2, plain.cells[0].text);

/* ── THE OTHER SURFACE'S EVIDENCE CELL MUST NOT NAME THE NEAREST BOOKING ──
   api/public/driver.js segEvidence() used to end `… The booking is on Uber,
   driven by <name>.` The server's own `means` string, printed immediately
   before it, ends "…so this name is deliberately absent from the candidate
   list above" — so the UI printed the name the sentence had just said was
   withheld, LAST, directly beneath the stacked candidate list, on a panel
   whose warn box reads "Nobody is accused here". The nearest booking is very
   often one of those candidates, so a reader who read the paragraph to the end
   was handed the tiebreaker the ladder had refused to make. This page has
   never printed it (rule 3 above); the driver page did.

   Asserted against the shipped module's SOURCE rather than its DOM, because
   segEvidence is module-private there and exporting it to test it would widen
   a surface for a test's sake. The two guards below are the two forms the
   defect can take.

   REVERSION THAT PROVES THIS: restore `driven by ${esc(nb.name)}` in
   segEvidence(). Both assertions fail. */
console.log('\nthe driver page’s evidence cell never names the nearest booking’s driver');
const driverSrc = await (await fetch(`http://127.0.0.1:${port}/driver.js`)).text();
check('segEvidence does not interpolate the nearest booking’s name',
  !/nb\.name/.test(driverSrc), 'api/public/driver.js still reads nb.name');
check('…and no rendered line says "driven by"',
  !/driven by \$\{/.test(driverSrc), 'api/public/driver.js still prints "driven by"');

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
