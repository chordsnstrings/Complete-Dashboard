/* Can you get from any fact to the thing it is about?
   ──────────────────────────────────────────────────────────────────────────
   This product's whole claim is that a number on one page can be checked on
   another. "L44305 carried a passenger with no booking" is only useful if you
   can open L44305; "Kashif has 12 harsh-braking events" is only useful if you
   can open Kashif. A cell that prints a name and links nowhere is a dead end,
   and every dead end silently turns an investigation into a search.

   Grepping for these by hand found eight of them one afternoon and missed
   several. This is the standing check.

   THREE RULES, each of which has been broken in this codebase:

   1. A column whose LABEL names an entity must RENDER a link to it. A "Driver"
      column printing esc(r.driver_name) is a dead end.

   2. The endpoint behind it must RETURN THE ID. Four of the eight found by
      hand were dead because the SQL never selected an id — the render could
      not have linked even if it wanted to.

   3. An id that is absent must degrade to plain text, not to a broken link.
      `entity()` already does this; a hand-rolled anchor does not. */
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const UI = readdirSync('api/public').filter((f) => f.endsWith('.js'));
const API = readdirSync('api').filter((f) => f.endsWith('.js'));

/* ── rule 1: a column that names an entity must link to it ──────────────── */
/* Labels that promise an entity. Deliberately narrow: "Drivers" (a count) and
   "Driver name" (an identity) are different promises, and flagging counts
   would train everyone to ignore this test. */
const ENTITY_LABEL = /^(driver|vehicle|plate|property|held by|driver that day|owed by|passenger)$/i;

const findings = [];
for (const f of UI) {
  const src = readFileSync(`api/public/${f}`, 'utf8');
  // Column objects, matched shallowly — a render function may contain braces.
  for (const m of src.matchAll(/\{\s*label:\s*'([^']+)'\s*,\s*key:\s*'([^']+)'([\s\S]{0,400}?)\}\s*,\s*\n/g)) {
    const [, label, key, rest] = m;
    if (!ENTITY_LABEL.test(label.trim())) continue;
    /* Linked if it uses one of the shared helpers or builds an href to a detail
       page. custody()/custodyAsOf() render every name through entity(), so a
       column using them is linked by construction — and by more than a
       hand-rolled anchor could be, because a handover day names two people and
       both come out openable. */
    const linked = /entity\(|custody\(|custodyAsOf\(|href\(\s*'(driver|vehicle|property|segment|slot|day)'/.test(rest);
    if (linked) continue;
    const line = src.slice(0, m.index).split('\n').length;
    findings.push(`api/public/${f}:${line}  "${label}" (key ${key})`);
  }
}
check('every column that names an entity links to it',
  findings.length === 0,
  findings.length ? `\n      ${findings.join('\n      ')}` : '');

/* ── rule 2: the endpoint must return the id the link needs ─────────────── */
/* For each entity link the UI renders, the endpoint feeding that page has to
   select the id. This is the failure that made four columns unfixable at the
   render layer: the SQL never selected driver_ext_id, so the name was all
   there was. Checked structurally: any file that selects driver_name must also
   select driver_ext_id somewhere in the same statement, unless the statement
   groups in a way that makes one id meaningless — in which case it must fold
   one out explicitly with array_agg. */
const idless = [];
for (const f of API) {
  if (f === 'probe.js') continue;
  const src = readFileSync(`api/${f}`, 'utf8');
  for (const m of src.matchAll(/`([^`]*SELECT[^`]*)`/gs)) {
    /* Strip every aggregate wrapper before asking whether the name is
       RETURNED. `count(DISTINCT coalesce(partner_name, driver_name))` mentions
       the column while returning a number, and flagging those trains everyone
       to ignore this test — which is worse than not having it. */
    const stmt = m[1]
      // FILTER rides OUTSIDE the aggregate's parens, so stripping the
      // aggregate alone leaves `count(DISTINCT x) FILTER (WHERE x IS NOT NULL)`
      // still mentioning the column it is only counting.
      .replace(/FILTER\s*\((?:[^()]|\([^()]*\))*\)/gi, '')
      .replace(/count\s*\((?:[^()]|\([^()]*\))*\)/gi, 'COUNT')
      .replace(/(sum|avg|min|max|string_agg|array_agg)\s*\((?:[^()]|\([^()]*\))*driver_ext_id(?:[^()]|\([^()]*\))*\)/gi, 'AGG_WITH_ID');
    if (!/\bdriver_name\b/.test(stmt)) continue;
    // A name in the SELECT list, not one used only in a WHERE or a GROUP BY.
    const selectPart = stmt.split(/\bFROM\b/i)[0]
      // A fold to a canonical person key returns the key, not the name.
      .replace(/lower\s*\(\s*regexp_replace\((?:[^()]|\([^()]*\))*\)\s*\)[^,]*/gi, 'PERSON_KEY');
    if (!/\bdriver_name\b/.test(selectPart)) continue;
    if (/driver_ext_id|AGG_WITH_ID/.test(m[1])) continue;
    /* A comma-joined list of names cannot carry ids in the same column, and a
       handover day names two people who must both be openable. The convention
       is a parallel `driver_refs` aggregate of {name, id} pairs; a file that
       produces one has paired its name list and is not a dead end. */
    if (/driver_refs|custodyRefs/.test(src)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    idless.push(`api/${f}:${line}`);
  }
}
check('every query that returns a driver name also returns an id to link it by',
  idless.length === 0, idless.length ? `\n      ${idless.join('\n      ')}` : '');

/* ── rule 3: a missing id degrades to text, not to a broken link ────────── */
const brittle = [];
for (const f of UI) {
  const src = readFileSync(`api/public/${f}`, 'utf8');
  // A hand-rolled anchor into a detail page, without a guard on the id.
  for (const m of src.matchAll(/href="?\$\{href\('(driver|vehicle|property)',\s*([^)]+)\)\}/g)) {
    const before = src.slice(Math.max(0, m.index - 220), m.index);
    const guarded = /\?\s*$|&&|\bentity\(/.test(before.trim().slice(-60)) || /\?/.test(before.slice(-120));
    if (!guarded) {
      const line = src.slice(0, m.index).split('\n').length;
      brittle.push(`api/public/${f}:${line}  href('${m[1]}', ${m[2].trim().slice(0, 40)})`);
    }
  }
}
check('a hand-rolled entity link guards against a missing id',
  brittle.length === 0, brittle.length ? `\n      ${brittle.join('\n      ')}` : '');

/* ── the helper itself must still degrade ───────────────────────────────── */
const ui = readFileSync('api/public/ui.js', 'utf8');
check('entity() renders plain text when there is no id to link to',
  /export const entity = \(view, id, text\) => \(id/.test(ui)
  && /:\s*(esc|`?<span)/.test(ui.slice(ui.indexOf('export const entity'), ui.indexOf('export const entity') + 300)),
  ui.slice(ui.indexOf('export const entity'), ui.indexOf('export const entity') + 220));

/* ── every detail view a link can point at must exist ───────────────────── */
const app = readFileSync('api/public/app.js', 'utf8');
const targets = new Set();
for (const f of UI) {
  const src = readFileSync(`api/public/${f}`, 'utf8');
  for (const m of src.matchAll(/href\(\s*'([a-z-]+)'/g)) targets.add(m[1]);
  for (const m of src.matchAll(/entity\(\s*'([a-z-]+)'/g)) targets.add(m[1]);
}
const declared = new Set([...app.matchAll(/V\.([a-zA-Z]+)\s*=/g)].map((m) => m[1]));
const missing = [...targets].filter((t) => !declared.has(t));
check('every view a link points at is actually registered',
  missing.length === 0, missing.join(', '));

console.log(`\n  ${UI.length} page modules, ${API.length} api modules, ${targets.size} link targets`);
console.log('\nrule 4: a trip leads to its telemetry');

/* A trip row naming a time and a plate must open the vehicle replay of that
   day on click — "what actually happened on that ride" is the question every
   trips table exists to raise. tripTime() is the one helper that builds the
   link (and degrades to plain text when there is no plate), so the rule is:
   a trips table renders its timestamp through tripTime, never bare dtStr. */
{
  const ui = readFileSync('api/public/ui.js', 'utf8');
  check('tripTime links the replay preselected to the trip day',
    /href\('vehicle', plate, 'movement'\)}\?day=\$\{day\}/.test(ui));
  /* Behaviour, not source shape: the crash this guards against was a STRING
     timestamp reaching Intl — test/formatters.test.mjs renders tripTime with
     real row shapes. Here it is enough that the degrade branch exists. */
  check('and degrades to plain text without a valid plate and day',
    /: esc\(dtStr\(at\)\)/.test(ui));

  /* Scoped to tables that ARE trips — the ones showing a pickup and dropoff.
     The jobs table has a 'Requested' column too (when a human queued a
     collection run), and the segment pages list bookings beside telemetry that
     is already on screen; neither is a trip needing a door to its replay. */
  const offenders = [];
  for (const f of UI) {
    const src = readFileSync(`api/public/${f}`, 'utf8');
    if (!src.includes("key: 'pickup_addr'")) continue;
    for (const m of src.matchAll(/label: '(?:Requested|When)', key: 'requested_at', render: \(r\) => ([^,}]+)/g)) {
      if (!/tripTime/.test(m[1])) offenders.push(`${f}: ${m[1].trim()}`);
    }
  }
  check('every trips table opens its telemetry on click', offenders.length === 0, offenders.join(' | '));

  const veh = readFileSync('api/public/vehicle.js', 'utf8');
  check('the movement page honours the day the link asked for',
    /parseHash\(\)\.day/.test(veh) && /sel\.value = asked/.test(veh));
  const data = readFileSync('api/public/data.js', 'utf8');
  check('and the router validates it like every other filter',
    /day: \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test/.test(data));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
