/* Five files at once, and the one thing concatenating them destroys.
   ═══════════════════════════════════════════════════════════════════════════
   On 2026-09-22 the operator handed over five .txt files in one go — two raw
   Bolt JWTs, two Bolt curls and a Yango cookie jar — and asked for that to be
   how the product works. src/credkit.js already reads a paste holding several
   credentials, so the cheap implementation joins the files with blank lines
   and calls recognise() on the result.

   THE CHEAP IMPLEMENTATION LOSES THE FINDING THAT COST HOURS THAT DAY.
   docs/COVERAGE.md, "Ecosine: proved end to end": two of those files held the
   SAME token — identical sha256, identical `jti`, `fleet_owner_id: 174036`,
   which is EGARI's owner — and the only thing that revealed it was that one
   file was called ECOSINE_BOLT.txt. Concatenated, that is one credential,
   filed correctly against Egari, reported clean; and Ecosine, the fleet the
   operator was actually trying to fix, goes on holding a token that the
   portal refuses at mint time with 900101 and can never be made to work.

   So this file pins the properties that make the filename load-bearing:

     · one credential in two files is ONE candidate and ONE write, with both
       names on it — folded rather than reported twice, because the Bolt check
       is a live exchange and two identical candidates are two exchanges;
     · a file whose NAME claims one fleet and whose CONTENTS belong to the
       other is said out loud, naming the fleet owner a real credential for
       the claimed fleet would have to carry;
     · two files claiming one key with different values refuse each other, in
       the words recognise() already uses within a single paste;
     · a Bolt paste answers with "go and check the other fleet", never with
       "capture a fresh one" — the errand that performs the suspected cause;
     · and the single textarea, which is the same path with one unnamed
       source, still behaves exactly as it did.

   EVERY VALUE HERE IS SYNTHETIC. The JWTs are built in this file out of a
   plain object and an unsigned fake signature; no real credential, and no
   fragment of one, is in this repository. CLAUDE.md's first rule.

   ── PROVED BY REVERT, 2026-09-22 ────────────────────────────────────────
   A test that passes against the unchanged file has proved nothing. Each
   piece of the feature was backed out on its own and this suite re-run. Full
   green is 43/43; the measured results were:

     · `crossFile()` removed, the raw candidate list passed straight through
       → 27 passed, 16 FAILED. The day's own case comes back exactly as it
       was: two proposals for one token, TWO writes of
       BOLT_REFRESH_TOKEN_EGARI, no duplicate finding, no fleet claim, and
       nothing anywhere saying ECOSINE_BOLT.txt held Egari's token.
     · per-file reading replaced by `recognise(sources.join('\n\n'))`
       → 27 passed, 16 FAILED. Every `file` comes back null, so no verdict
       can say which file it is about; worse, recognise()'s own same-key rule
       then refuses BOTH copies and the upload stores NOTHING at all, with
       the message "two credentials claim BOLT_REFRESH_TOKEN_EGARI" about
       what is one credential pasted twice.
     · the `boltFollowUp()` push removed
       → the four assertions under "a Bolt paste sends the operator to the
       OTHER fleet" FAIL, and the section then throws reading a finding that
       is not there, which ends the run.
     · `MIN_CHARS` relaxed from 20 to 0
       → "a file too short to hold a credential is refused BY NAME" FAILS:
       the empty file is read silently and contributes nothing, which is the
       state this whole feature exists to make impossible.
*/
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── synthetic credentials ──────────────────────────────────────────────
   A Bolt portal token is a JWT whose payload carries data.fleet_owner_id, and
   that is the whole of what src/credkit.js reads. These are built here, from
   an object, with a signature that is not a signature: nothing below is a
   credential, and nothing below came from a provider. */
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const NOT_A_SIGNATURE = 'not-a-signature-this-token-is-synthetic';
const boltToken = (owner, jti) => [
  b64u({ alg: 'HS256', typ: 'JWT' }),
  b64u({ data: { fleet_owner_id: owner, jti }, exp: Math.floor(Date.now() / 1000) + 6 * 86400 }),
  NOT_A_SIGNATURE,
].join('.');

const ECOSINE_OWNER = 173999;          // config.bolt.companies, not a secret
const EGARI_OWNER = 174036;
const EGARI_TOKEN = boltToken(EGARI_OWNER, 'synthetic-egari-1');
const EGARI_TOKEN_2 = boltToken(EGARI_OWNER, 'synthetic-egari-2');
const ECOSINE_TOKEN = boltToken(ECOSINE_OWNER, 'synthetic-ecosine-1');

/* ── the app, with the two network-touching dependencies replaced ───────
   checkAll mints a live Bolt access token and proposeKeys calls a model. The
   subject here is what the ROUTE does with verdicts, so the provider is a
   stub that accepts anything the queue did not already refuse — which is
   precisely the contract src/credcheck.js's checkCandidate implements for a
   candidate whose `ok` is false. */
const db = new PGlite();
await applySchema(db);

const written = [];
const { server, port } = await mountAll(db, {
  inject: {
    checkAll: async (cands) => cands.map((c) => (c.ok !== false && c.key
      ? { ...c, verdict: 'pass', detail: `the stub provider accepted this for ${c.fleet}` }
      : { ...c, verdict: 'fail', detail: c.why || 'this credential could not be named' })),
    proposeKeys: async () => [],
    setSetting: async (k, v) => { written.push({ key: k, chars: String(v).length }); },
    loadSettings: async () => {},
  },
});

const paste = async (body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/settings/paste`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; }
  catch { return { status: r.status, body: null, raw: text.slice(0, 200) }; }
};
const findingsOf = (d, kind) => (d.findings || []).filter((f) => f.kind === kind);

/* ══ 1. the day's actual failure: two names, one token ══════════════════ */
console.log('\ntwo files, one token — the failure only the filenames reveal');
{
  written.length = 0;
  const d = (await paste({
    apply: true,
    files: [
      { name: 'ECOSINE_BOLT.txt', text: EGARI_TOKEN },
      { name: 'EGARI_BOLT.txt', text: EGARI_TOKEN },
    ],
  })).body;

  check('one credential in two files is ONE candidate, not two',
    d.proposals.length === 1, JSON.stringify(d.proposals?.map((p) => p.key)));
  check('…and ONE write, so the Bolt portal is asked once',
    written.length === 1 && written[0].key === 'BOLT_REFRESH_TOKEN_EGARI',
    JSON.stringify(written));
  check('…carrying BOTH filenames',
    d.proposals[0].files.length === 2
      && d.proposals[0].files.includes('ECOSINE_BOLT.txt')
      && d.proposals[0].files.includes('EGARI_BOLT.txt'),
    JSON.stringify(d.proposals[0].files));

  const dup = findingsOf(d, 'duplicate_value');
  check('the duplicate is named, prominently and as an error',
    dup.length === 1 && dup[0].tone === 'err', JSON.stringify(dup));
  check('…naming both files', dup[0] && /ECOSINE_BOLT\.txt/.test(dup[0].text)
    && /EGARI_BOLT\.txt/.test(dup[0].text), dup[0]?.text);
  /* The sentence that does the work: an operator who reads "duplicate" as
     "tidied up for you" has learned nothing. */
  check('…and saying what it MEANS — one capture, not two',
    dup[0] && /one capture, not two/i.test(dup[0].text), dup[0]?.text);

  const claim = findingsOf(d, 'fleet_claim');
  check('the file that claims the wrong fleet is named',
    claim.length === 1 && claim[0].files[0] === 'ECOSINE_BOLT.txt', JSON.stringify(claim));
  check('…naming the owner a real ecosine token would have to carry',
    claim[0] && claim[0].text.includes(String(ECOSINE_OWNER)), claim[0]?.text);
  check('…and the owner this one actually carries',
    claim[0] && claim[0].text.includes(String(EGARI_OWNER)), claim[0]?.text);
  /* The house principle: the fleet that got nothing is reported as having got
     nothing, with the true reason — never as a silent success. */
  check('…and saying outright that ecosine was given nothing',
    claim[0] && /ecosine has been given nothing/i.test(claim[0].text), claim[0]?.text);
  check('the credential is still filed under the fleet IT names, not the file',
    d.applied.length === 1 && d.applied[0] === 'BOLT_REFRESH_TOKEN_EGARI',
    JSON.stringify(d.applied));

  const files = d.files;
  check('every file is accounted for, by name', files.length === 2
    && files.every((f) => f.name), JSON.stringify(files.map((f) => f.name)));
  check('the mis-named file reports storing nothing of its own key',
    files.find((f) => f.name === 'ECOSINE_BOLT.txt').declares_fleet === 'ecosine',
    JSON.stringify(files.find((f) => f.name === 'ECOSINE_BOLT.txt')));
  check('…and each file says which other file held the same bytes',
    files.every((f) => f.also_in.length === 1),
    JSON.stringify(files.map((f) => f.also_in)));
}

/* ══ 2. two different values, one key ═══════════════════════════════════ */
console.log('\ntwo different tokens claiming one key refuse each other');
{
  written.length = 0;
  const d = (await paste({
    apply: true,
    files: [
      { name: 'bolt-monday.txt', text: EGARI_TOKEN },
      { name: 'bolt-tuesday.txt', text: EGARI_TOKEN_2 },
    ],
  })).body;
  check('neither is applied', written.length === 0 && d.applied.length === 0,
    JSON.stringify({ written, applied: d.applied }));
  check('both are refused, not silently dropped',
    d.proposals.length === 2 && d.proposals.every((p) => p.verdict === 'fail'),
    JSON.stringify(d.proposals.map((p) => p.verdict)));
  /* The vocabulary is recognise()'s, extended across files rather than
     invented a second time. */
  check('…in the queue’s own words', d.proposals.every((p) => /claims the same key/.test(p.detail || '')),
    JSON.stringify(d.proposals.map((p) => p.detail)));
  const same = findingsOf(d, 'same_key');
  check('and the set-level finding names both files and the key',
    same.length === 1 && same[0].key === 'BOLT_REFRESH_TOKEN_EGARI'
      && /bolt-monday\.txt/.test(same[0].text) && /bolt-tuesday\.txt/.test(same[0].text),
    JSON.stringify(same));
}

/* ══ 3. the errand a Bolt paste must NOT be given ═══════════════════════ */
console.log('\na Bolt paste sends the operator to the OTHER fleet, not back to the portal');
{
  const d = (await paste({ files: [{ name: 'EGARI_BOLT.txt', text: EGARI_TOKEN }] })).body;
  const b = findingsOf(d, 'bolt_capture');
  check('the warning is present', b.length === 1, JSON.stringify(d.findings?.map((f) => f.kind)));
  check('…and names the fleet to go and look at now',
    b[0] && /ecosine/i.test(b[0].text), b[0]?.text);
  check('…and says the open question is open — per owner or per account',
    b[0] && /still open/i.test(b[0].text) && /per Bolt account/i.test(b[0].text), b[0]?.text);
  /* The instruction that produced the loop: "capture a fresh one" is performed
     by signing in, which is the likeliest thing that kills the token just
     pasted. docs/COVERAGE.md, "Traps that have cost time more than once". */
  check('…and never tells them to capture another one',
    b[0] && !/capture a fresh|capture another|re-?capture/i.test(b[0].text), b[0]?.text);

  const e = (await paste({ files: [{ name: 'ECOSINE_BOLT.txt', text: ECOSINE_TOKEN }] })).body;
  check('the fleet named is the one NOT in the upload',
    /egari/i.test(findingsOf(e, 'bolt_capture')[0].text),
    findingsOf(e, 'bolt_capture')[0]?.text);
  check('and no warning at all when nothing Bolt was pasted',
    findingsOf((await paste({ files: [{ name: 'notes.txt', text: 'YANGO_PARK_ID = a23a-not-a-real-park' }] })).body,
      'bolt_capture').length === 0);
}

/* ══ 4. per-file provenance, end to end ════════════════════════════════ */
console.log('\nevery verdict says which file it came from');
{
  const d = (await paste({
    files: [
      { name: 'EGARI_BOLT.txt', text: EGARI_TOKEN },
      { name: 'ECOSINE_BOLT.txt', text: ECOSINE_TOKEN },
    ],
  })).body;
  check('two distinct tokens are two candidates', d.proposals.length === 2);
  check('each carries its own filename',
    d.proposals.every((p) => p.files.length === 1)
      && new Set(d.proposals.map((p) => p.files[0])).size === 2,
    JSON.stringify(d.proposals.map((p) => p.files)));
  check('and the right one — the egari token came out of the egari file',
    d.proposals.find((p) => p.key === 'BOLT_REFRESH_TOKEN_EGARI').files[0] === 'EGARI_BOLT.txt',
    JSON.stringify(d.proposals.map((p) => [p.key, p.files[0]])));
  check('correctly named files raise no fleet claim', findingsOf(d, 'fleet_claim').length === 0,
    JSON.stringify(findingsOf(d, 'fleet_claim')));
  check('nor a duplicate', findingsOf(d, 'duplicate_value').length === 0);
  check('the value never comes back out',
    !JSON.stringify(d).includes(EGARI_TOKEN) && !JSON.stringify(d).includes(ECOSINE_TOKEN));
}

/* ══ 5. a file that was not read, and why ══════════════════════════════ */
console.log('\na file that contributed nothing says so, by name');
{
  const d = (await paste({
    files: [
      { name: 'EGARI_BOLT.txt', text: EGARI_TOKEN },
      { name: 'ECOSINE_YANGO.txt', text: 'this file is a note to self and holds no credential at all' },
      { name: 'empty.txt', text: 'too short' },
    ],
  })).body;
  check('the short file is refused BY NAME, and the others still read',
    d.files_refused.length === 1 && d.files_refused[0].name === 'empty.txt'
      && d.proposals.length === 1,
    JSON.stringify(d.files_refused));
  check('…with the true reason', /under 20 characters/.test(d.files_refused[0].reason),
    d.files_refused[0].reason);
  const nothing = findingsOf(d, 'nothing_read');
  check('the file nothing was read from is named',
    nothing.length === 1 && nothing[0].files[0] === 'ECOSINE_YANGO.txt', JSON.stringify(nothing));
  check('…and its name is read for what it was SUPPOSED to hold',
    /Yango/.test(nothing[0].text) && /ecosine/.test(nothing[0].text), nothing[0].text);
  check('…and says that provider is still holding what it held before',
    /still holding whatever it held before/.test(nothing[0].text), nothing[0].text);
}

/* ══ 6. bounds, refused by name rather than by silence ═════════════════ */
console.log('\nmore files than the route reads');
{
  const many = Array.from({ length: 15 }, (_, i) => ({ name: `f${i}.txt`, text: boltToken(EGARI_OWNER, `s${i}`) }));
  const d = (await paste({ files: many })).body;
  check('the surplus is refused, by name, rather than dropped',
    d.files.length === 12 && d.files_refused.length === 3
      && d.files_refused.every((f) => /more than 12 files/.test(f.reason)),
    JSON.stringify({ read: d.files.length, refused: d.files_refused.length }));
}

/* ══ 7. the textarea is the same path, unchanged ═══════════════════════ */
console.log('\nthe single paste box still behaves exactly as it did');
{
  written.length = 0;
  const d = (await paste({ text: EGARI_TOKEN, apply: true })).body;
  check('a bare paste still reads, tests and applies',
    d.applied.length === 1 && d.applied[0] === 'BOLT_REFRESH_TOKEN_EGARI', JSON.stringify(d.applied));
  check('…and reports no filename, rather than a made-up one',
    d.proposals[0].file === null && d.proposals[0].files.length === 0,
    JSON.stringify([d.proposals[0].file, d.proposals[0].files]));
  check('…and raises no fleet claim about a file that does not exist',
    findingsOf(d, 'fleet_claim').length === 0 && findingsOf(d, 'nothing_read').length === 0);

  const short = await paste({ text: 'nope' });
  check('a paste too short to hold anything is still a 400',
    short.status === 400 && short.body.error === 'nothing to read', JSON.stringify(short));
  const none = await paste({ files: [] });
  check('and an empty file list falls back to the empty textarea, not a crash',
    none.status === 400, JSON.stringify(none));
}

/* ══ 8. the rule that outranks everything else here ════════════════════ */
console.log('\ncredentials never enter the repository');
{
  const { readFileSync } = await import('node:fs');
  const mine = readFileSync('test/paste_multifile.test.mjs', 'utf8');
  /* Every JWT in this file is built at run time out of a literal object. A
     pasted one would be a three-part base64 string sitting in the source. */
  check('no JWT literal is checked in with this test',
    !/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(mine));
  check('…and the fake signature says what it is',
    mine.includes('NOT_A_SIGNATURE'));
}

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
