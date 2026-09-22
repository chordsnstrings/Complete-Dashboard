/* Bolt's portal: what kills a refresh token, and what the product tells the
   operator to do about it.
   ═══════════════════════════════════════════════════════════════════════════
   THE DEFECT. Three places in this repo said the portal "rotates this token on
   use" / "is single-use … invalidates the one presented", and src/settings.js
   managed to say that six lines above two hints saying the opposite. Every
   message the credential panel produced was built on the false half, so the
   errand it gave an operator was the errand that causes the failure.

   THE MEASUREMENT (live portal, 2026-09-22 — docs/COVERAGE.md carries it in
   full, "Bolt: the portal supersedes, it does not rotate"):

     one refresh token, exchanged FIFTEEN times in a row
       -> code 0 / OK every time
       -> NO `refresh_token` field in any response, at any depth
       -> the token still good after all fifteen

   So nothing is spent by using it. Tokens die anyway, early, unchanged, with
   days left on their own `exp` — three of them on 2026-09-22 across both
   owners, none of them touched by this deployment between working and not.

   AND THE ERROR HINT IS A CONSTANT, WHICH COST THIS FILE A DRAFT. The obvious
   reading of a uuid in `error_hint` — and the one both the old repo comment and
   the first version of this suite asserted — is that the portal is naming the
   token that superseded ours. Measured:

     dead Ecosine token (owner 173999) -> hint 5099637b-cfb0-48da-…
     dead Egari   token (owner 174036) -> hint 5099637b-cfb0-48da-…   SAME

   One uuid cannot be two different owners' successors. It is a fixed marker
   meaning "a token we issued, no longer valid", stable across calls, hours and
   fleets. The words-vs-uuid distinction is still real and still worth making;
   it is only the uuid's MEANING that was invented. These tests assert the
   distinction and the shape, never the constant's value — pinning Bolt's
   constant would make the day they change it a silent misreading.

   WHAT ACTUALLY KILLS THEM IS NOT ESTABLISHED and these tests do not assert
   it. The likeliest cause is a portal sign-in, which is what capturing a token
   IS — so the advice the panel gave ("capture a fresh one") is performed by
   doing the suspected cause. One open question is recorded in
   docs/COVERAGE.md: Egari's token died in the window in which an ECOSINE token
   was captured, a different owner, which would mean the two fleets can never
   both be live. That is a prediction for the operator to settle, not a finding.

   Two more codes were measured and had no reading in the code at all:
     900101 FLEET_OWNER_NOT_AUTHORIZED_COMPANY — minting Egari's owner-174036
            token against Ecosine's company 142868. An ENTITLEMENT verdict.
     210 with error_hint "Invalid refresh token" (in words, not a uuid) —
            a real token with its signature reversed.

   And production printed `(expired 2026-09-26T08:40:27.000Z)` on 2026-09-22:
   the suffix was appended whenever the JWT carried an exp at all, whatever it
   said, about a token whose real problem was supersession.

   ── PROVED BY REVERT ──────────────────────────────────────────────────────
   Each fix was reverted in the working tree and this suite re-run. Recorded:

     1. expiryNote() reverted to the unconditional ` (expired ${expires_at})`
        -> 31 passed, 3 FAILED. It printed, on 2026-09-22, exactly the
           production line this was found from:
             "a token days from its exp is never called expired
               (expired 2026-09-26T05:33:38.000Z)"
           plus "…and says so in words rather than going silent" and "the days
           remaining are stated".

     2. portalRefusal() reverted to the flattened
        `err: [message, hint, code].join(' ')`, detail null, state always
        'invalid' — which is what portalToken() did before this pass
        -> 21 passed, 13 FAILED. Every reading is gone at once: both 210s
           produce the same null detail, and "900101 is not filed as a broken
           credential" fails with state 'invalid'.

     3. only the killed-token ADVICE reverted to "this paste has already been
        exchanged somewhere; capture a fresh one from the portal" — the
        structure kept, one sentence changed
        -> 27 passed, 7 FAILED, including "…and NOT that somebody already spent
           or exchanged it" and "the remedy does not tell the operator to do the
           thing that is the likeliest cause". This is the one that matters
           most: the code can be structurally right and still send the operator
           into the loop.

        Re-run after the hint correction: 28 passed, 11 FAILED — more, because
        the corrected message now has to deny two wrong readings as well as
        give the right errand, and the old sentence asserts both of them.

   No credential is used here. Every token below is an unsigned JWT built in
   this file, and the only portal identifier quoted is a truncated uuid. */
import { expiryNote, portalRefusal, readRefreshToken } from '../src/sources/bolt.js';
import { config } from '../src/config.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const jwt = (payload) =>
  `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
const ECOSINE = config.bolt.companies.find((c) => c.fleet === 'ecosine');
const EGARI = config.bolt.companies.find((c) => c.fleet === 'egari');

/* ── 1. a live token is never called expired ─────────────────────────────── */
console.log('\nthe reason printed for a refusal is the true one');

const soon = Math.floor(Date.now() / 1000) + 4 * 86400;
const past = Math.floor(Date.now() / 1000) - 3 * 86400;
const live = readRefreshToken(jwt({ data: { fleet_owner_id: 173999, jti: 'live' }, iat: 1, exp: soon }));
const dead = readRefreshToken(jwt({ data: { fleet_owner_id: 173999, jti: 'dead' }, iat: 1, exp: past }));

/* The production line this replaced, verbatim:
     "REFRESH_TOKEN_INVALID hint=5099637b-… code=210 (expired 2026-09-26T08:40:27.000Z)"
   printed on 2026-09-22 — four days BEFORE that instant. */
check('a token days from its exp is never called expired',
  !/\bexpired\b/.test(expiryNote(live)), expiryNote(live));
check('…and says so in words rather than going silent',
  /NOT an expiry/i.test(expiryNote(live)), expiryNote(live));
check('the days remaining are stated, so the operator can see it is not that',
  /\bdays away\b/.test(expiryNote(live)), expiryNote(live));
check('a token that really has lapsed still reads as expired',
  /^ \(expired /.test(expiryNote(dead)), expiryNote(dead));
/* Most stored secrets are not JWTs. A note that throws takes the panel down. */
check('an unreadable token yields no expiry clause rather than throwing',
  expiryNote(null) === '' && expiryNote({}) === '' && expiryNote({ expires_at: null }) === '');

/* ── 2. 210 + a uuid is SUPERSEDED, not "already spent" ──────────────────── */
console.log('\na token the portal issued and then killed is read as that, and the remedy can work');

/* A synthetic uuid, not the one the live portal returns. The assertions below
   are about the SHAPE of the hint and the sentence it produces; the portal's
   actual constant belongs in docs/COVERAGE.md, not in a test literal. */
const KILLED_UUID = '00000000-1111-4222-8333-444444444444';
const superseded = portalRefusal(
  { code: 210, message: 'REFRESH_TOKEN_INVALID', error_hint: KILLED_UUID }, ECOSINE);

check('the portal\'s own code, message and hint all survive into the error',
  /210/.test(superseded.err) && /REFRESH_TOKEN_INVALID/.test(superseded.err)
  && superseded.err.includes(KILLED_UUID), superseded.err);
check('the detail says the portal issued it and then invalidated it',
  /issued this token and has since invalidated it/.test(superseded.detail || ''), superseded.detail);
/* The claim this suite shipped wrong once. The uuid names nothing — it is the
   same value for both owners' dead tokens — so the message must not present it
   as a successor, a replacement or a live token. */
check('…and does NOT claim the hint names a replacement token',
  !/(replace[ds]?|successor|supersed|the token that is live)/i.test(superseded.detail || ''),
  superseded.detail);
check('…and says plainly that this is not expiry, which is the other wrong reading',
  /not expiry/i.test(superseded.detail || ''), superseded.detail);
/* The false reading. Nothing spends a Bolt refresh token — fifteen exchanges
   proved it — so "somebody already spent this one" describes an event that
   does not happen and sends nobody anywhere useful. */
/* The affirmative claim only. The corrected message DENIES this in so many
   words ("nothing here spent it"), and a naive /spent/ would fail on the
   denial — which is how an assertion ends up arguing for the bug. */
check('…and NOT that somebody already spent or exchanged it',
  !/already (been )?(spent|exchanged)|this paste has already/i.test(superseded.detail || ''),
  superseded.detail);
check('…and says outright that exchanging one does not consume it',
  /does not consume it/i.test(superseded.detail || ''), superseded.detail);
/* THE ERRAND. "Capture a fresh one from the portal" is performed by signing in
   again, which is the act that invalidates whatever is already pasted for that
   owner. That loop is what this credential has been stuck in. */
check('the remedy does not tell the operator to do the thing that causes the failure',
  !/capture a fresh one/i.test(superseded.detail || ''), superseded.detail);
check('…and says to capture from the session signed in NOW',
  /signed in NOW/.test(superseded.detail || ''), superseded.detail);
check('…and to stop there, since capturing is itself the suspected cause',
  /and then stop/i.test(superseded.detail || ''), superseded.detail);
/* The open question, in the operator's hands rather than buried in a doc: one
   fleet's capture may be what kills the other's token, which would mean the
   two can never both be live. */
check('…and tells the operator to check the OTHER fleet straight afterwards',
  /check the OTHER fleet/i.test(superseded.detail || ''), superseded.detail);
check('…naming the setting to paste it into, since it is per fleet',
  /BOLT_REFRESH_TOKEN_ECOSINE/.test(superseded.detail || ''), superseded.detail);
/* Nothing the portal hands back is echoed into the panel — there is no value
   in it and credential_state.detail is a place secrets must never reach. */
check('…and does not echo the portal\'s hint value into the operator-facing detail',
  !superseded.detail.includes(KILLED_UUID), superseded.detail);
check('a killed token is a credential fault, so it is filed invalid',
  superseded.state === 'invalid', superseded.state);
/* Shape, not value. Bolt's constant is Bolt's to change. */
check('any uuid-shaped hint reads the same way, since the value is the portal\'s to change',
  /issued this token and has since invalidated it/.test(
    portalRefusal({ code: 210, message: 'REFRESH_TOKEN_INVALID',
      error_hint: 'deadbeef-0000-4000-8000-feedfacecafe' }, ECOSINE).detail || ''));

/* ── 3. 210 with WORDS is a broken paste, which needs the opposite advice ── */
console.log('\na broken signature is told apart from a superseded token');

const broken = portalRefusal(
  { code: 210, message: 'REFRESH_TOKEN_INVALID', error_hint: 'Invalid refresh token' }, ECOSINE);
check('the two 210s do not produce the same detail',
  broken.detail !== superseded.detail, broken.detail);
check('a broken signature reads as a value the portal never issued',
  /does not recognise this value/i.test(broken.detail || ''), broken.detail);
check('…and names the likeliest cause of it, a partial paste',
  /truncated/i.test(broken.detail || ''), broken.detail);
/* Measured three ways — a real token with its signature reversed, and forged
   JWTs for each owner — all answer the words, never the uuid. */
check('…and does NOT blame a portal sign-in, which is a different errand',
  !/portal sign-in/i.test(broken.detail || ''), broken.detail);

/* ── 4. 900101 is an entitlement verdict, not a broken credential ────────── */
console.log('\nthe portal\'s own refusal of a company is not filed against the token');

const unentitled = portalRefusal(
  { code: 900101, message: 'FLEET_OWNER_NOT_AUTHORIZED_COMPANY' }, ECOSINE);

/* Same distinction fiRefusal() makes for the FI gateway, for the same reason:
   re-pasting produces a credential with identical entitlement, so filing this
   as 'invalid' asks for an errand that cannot change the answer. */
check('900101 is not filed as a broken credential',
  unentitled.state === 'unentitled', unentitled.state);
check('…and the detail names the company that was refused',
  new RegExp(`\\b${ECOSINE.companyId}\\b`).test(unentitled.detail || ''), unentitled.detail);
check('…and says a different token for the same owner cannot change it',
  /cannot change that/i.test(unentitled.detail || ''), unentitled.detail);
check('…and names the owner a working token has to come from',
  new RegExp(`\\b${ECOSINE.userId}\\b`).test(unentitled.detail || ''), unentitled.detail);
check('the portal\'s own words are kept, not replaced by our verdict',
  /FLEET_OWNER_NOT_AUTHORIZED_COMPANY/.test(unentitled.err), unentitled.err);
check('the same refusal for the other fleet names the other company',
  new RegExp(`\\b${EGARI.companyId}\\b`).test(
    portalRefusal({ code: 900101, message: 'FLEET_OWNER_NOT_AUTHORIZED_COMPANY' }, EGARI).detail || ''));

/* Anything the portal has not been measured saying must not be given a
   confident reading — it gets the portal's words and no invented remedy. */
const unknown = portalRefusal({ code: 4242, message: 'SOMETHING_NEW' }, ECOSINE);
check('an unmeasured code carries the portal\'s words and invents no remedy',
  unknown.detail === null && /SOMETHING_NEW/.test(unknown.err) && /4242/.test(unknown.err),
  JSON.stringify(unknown));

/* ── 5. the source still carries the measurements a reader needs ─────────── */
console.log('\nthe measurements that settle this are written where the next reader will be');

const { readFileSync } = await import('node:fs');
const bolt = readFileSync('src/sources/bolt.js', 'utf8');
const settings = readFileSync('src/settings.js', 'utf8');
const credcheck = readFileSync('src/credcheck.js', 'utf8');

/* The `company` object is the ONE thing our request has that the operator's
   working browser curl does not, and the obvious "fix" on reading that curl is
   to delete it. Measured: without it the mint still answers code 0, and the
   access token it hands back is 503 NOT_AUTHORIZED on the read path. */
check('the mint body still carries the company, which is what scopes the token',
  /company: \{ company_id: companyId, company_type: 'fleet_company' \}/.test(bolt));
check('…and why it is load-bearing is written down, with the 503 it prevents',
  /NOT_AUTHORIZED, no rows/.test(bolt) && /company` object in the body/.test(bolt));
check('the version string is recorded as measured-irrelevant, so it is not chased again',
  /VERSION STRING IS NOT LOAD-BEARING/.test(bolt));
check('…and so are the twelve browser headers',
  /HEADERS ARE NOT LOAD-BEARING/.test(bolt));
check('the decorative company_id in the getTable URL is written down as a trap',
  /DECORATIVE/.test(bolt) && /EGARI'S TRIPS INTO ECOSINE'S FLEET/.test(bolt));

/* The contradiction this whole pass existed to settle: three claims of
   rotation, one of them six lines from two hints saying the opposite. */
/* Quoting the false sentence in order to correct it is not asserting it — all
   three files do exactly that, deliberately, because the old reading is the one
   a reader arrives with. So the claim is hunted line by line and a line that
   marks itself as a correction does not count. Anything else does. */
/* Scoped to the Bolt refresh token: src/settings.js also calls a Tesla OAuth
   code single-use, which is true and is not this claim. */
const CLAIM = /portal rotates (it|this token) on|rotates it on every exchange|refresh token is single-use|single-use.*refresh token/i;
const CORRECTED = /WAS FALSE|used to say|used to open|measured false|no longer|turned out to be false|is NOT|does NOT|not rotate/i;
for (const [name, src] of [['src/sources/bolt.js', bolt], ['src/settings.js', settings],
  ['src/credcheck.js', credcheck]]) {
  const asserted = src.split('\n').filter((l) => CLAIM.test(l) && !CORRECTED.test(l));
  check(`${name} no longer asserts that the portal rotates the token`,
    asserted.length === 0, asserted.join(' | ').slice(0, 200));
}
check('src/settings.js still warns that a token can die early, which is the part that bites',
  /signing that owner in again kills whatever is pasted here/.test(settings));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
