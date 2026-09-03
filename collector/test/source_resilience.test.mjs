/* ── the same six failure shapes, swept across every other collector ───────
   The Bolt review found twenty-four defects in one source. Four of them were
   shapes rather than mistakes, and shapes repeat: a loop where one failure
   discards the whole harvest; a request-shaped refusal filed against a
   credential; a credential that can only ever be written 'invalid', so nothing
   in the product can turn its row green again; and a run that reports zero
   rows over rows it has already committed.

   This is the sweep of the other seven sources. fms.js and uber.js's own trip
   and earnings loops came back clean and are the pattern the rest now follow —
   both ask per window, both record every window, and neither lets one refusal
   reach the credential table or the rows already collected. */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
/* Comments blanked first. Every one of these files explains its own defect in
   prose that quotes the code being searched for, and a lint that matches its
   own explanation passes on a file where the fix has been deleted. This repo
   has been caught by it four times. */
const src = (f) => readFileSync(`src/sources/${f}`, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\nevery source: the four shapes the Bolt review named');

/* ── 1. a credential that can only ever go red ───────────────────────────── */
/* api/auth_routes.js scores 'invalid' as "stopped", and src/credcheck.js has a
   live checker for only some keys — so for the rest, a row written 'invalid'
   by a bad gateway minute stays red for ever and sends somebody to replace a
   credential that was never refused. A source that can write red must be able
   to write green. */
for (const f of ['hotel.js', 'cabman.js', 'yango.js', 'fms.js', 'bolt.js', 'uber.js']) {
  const t = src(f);
  const red = /state: 'invalid'/.test(t);
  const green = /state: 'ok'/.test(t);
  check(`${f}: writes 'ok' as well as 'invalid'`, !red || green,
    'a state only something can clear is a state nothing clears');
}

/* ── 2. a request-shaped refusal is not a credential verdict ─────────────── */
/* src/http.js retries 429/500/502/503/504 four times before returning, so a
   persistent gateway error and a 404 from a moved path both reach these
   guards. Blaming the credential for either is how an operator is sent to
   re-issue a working token. */
for (const f of ['hotel.js', 'cabman.js']) {
  const t = src(f);
  const blames = [...t.matchAll(/if \(status && status >= 400\) \{([\s\S]{0,400}?)\n\s{4,6}\}/g)];
  check(`${f}: a bare status >= 400 no longer writes a credential row`,
    blames.every((m) => !/noteCredential/.test(m[1]) || /401|403|saysAuth|isAuthStatus/.test(m[1])),
    'only an authorization answer is an authorization verdict');
  check(`${f}: and it discriminates with the shared helper`, /saysAuth/.test(t));
}
const tl = src('uber_timeline.js');
check('uber_timeline: the cookie is blamed only for an auth-shaped refusal',
  /failed === asked && authFailed/.test(tl),
  'a maintenance page, a renamed field and a dropped connection all used to expire the cookie');
check('uber_timeline: and each refusal says whether it implicates the credential',
  /auth: saysAuth\(msg\)/.test(tl) && /auth: false/.test(tl));

/* ── 3. one window's refusal is not the run's ────────────────────────────── */
const ya = src('yango.js');
check('yango: a refused driver week is caught and the walk carries on',
  /catch \(e\) \{[\s\S]{0,300}?chunks\.push\(\{[\s\S]{0,120}?error: why \}\);[\s\S]{0,40}?continue;/.test(ya),
  'post() throws on >= 400 and nothing stood between it and collect()');
check('yango: and each of its three surfaces is guarded on its own',
  /const surface = async \(name, fn\)/.test(ya)
  && /await surface\('drivers'/.test(ya) && /await surface\('trips'/.test(ya)
  && /await surface\('ledger'/.test(ya),
  'one refused week used to cost the trips and the ledger too');
check('yango: and the windows reach the run row',
  /\.\.\.\(chunks\.length \? \{ chunks \} : \{\}\)/.test(ya));

const uq = src('uber.js');
check('uber quality: a failed second report keeps what the first parsed',
  /if \(merged\.size\) \{[\s\S]{0,400}?upsertMany\('driver_performance'/.test(uq),
  'a slow acceptance report used to discard a whole week of ratings');

/* ── 4. the checkpoint may not run ahead of the write ────────────────────── */
const up = src('uber_profile.js');
check('uber_profile: a driver is marked done only after the batch is written',
  /await writeProfiles\(batch\.map[\s\S]{0,160}?checkpoint\?\.mark/.test(up),
  'mark-before-write means a throw loses the rows AND records them as collected');
check('uber_profile: and it still flushes in batches, so a long pass can resume',
  /const BATCH = \d+/.test(up) && /pending\.length >= BATCH/.test(up),
  'marking only at the end would restart a 160-driver pass from zero every time');
check('uber_profile: nothing marks inside the collect loop any more',
  !/rows\.push\(out\.row\);[\s\S]{0,200}?checkpoint\?\.mark/.test(up));

/* ── 5. a run states what it actually wrote ──────────────────────────────── */
/* src/db.js stores `run.rows_written || 0`, so an omitted count reports zero
   over rows that are written and durable — and "collected nothing" sends
   somebody hunting a fault that is not there. */
for (const f of ['uber.js', 'yango.js', 'hotel.js', 'bolt.js']) {
  const t = src(f);
  const errRuns = [...t.matchAll(/logRun\(\{[^}]*status: 'error'[^}]*\}/g)].map((m) => m[0]);
  check(`${f}: an error run carries the rows it had already written`,
    errRuns.length > 0 && errRuns.every((r) => /rows_written/.test(r)),
    errRuns.filter((r) => !/rows_written/.test(r)).join(' | ') || `${errRuns.length} error runs`);
}

/* ── 6. a fleet that is skipped is still on the record ───────────────────── */
const uf = src('uber_fleet.js');
check('uber_fleet: a fleet with no cookie gets a run row, not just a log line',
  /if \(!o\.orgUuid \|\| !o\.webCookie\) \{[\s\S]{0,800}?logRun\(/.test(uf),
  'it used to be a continue, so the fleet vanished from /api/status rather than showing as broken');
check('uber_fleet: and its credential is recorded missing',
  /if \(!o\.orgUuid \|\| !o\.webCookie\) \{[\s\S]{0,800}?state: 'missing'/.test(uf));

/* ── 7. a truncated window is named, not silently short ──────────────────── */
const ho = src('hotel.js');
check('hotel: the response’s own trip count is compared with what arrived',
  /totalTrips/.test(ho) && /declared > trips\.length/.test(ho),
  'the field was named only in a comment; nothing ever read it');
check('yango: a driver week landing on a page boundary says so',
  /items\.length % 50 === 0/.test(ya),
  'this endpoint sends no limit and reads no cursor while both its siblings page');

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
