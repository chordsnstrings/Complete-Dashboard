/* ── credentials that expire, and tokens that are spent by being used ──────
   Bolt wrote zero trips for the life of the project. The supervisor pasted a
   fresh portal refresh token, the collector still logged "portal token invalid
   — refresh needed", and the obvious reading was that the paste was stale.

   It was not. A probe against the live portal, sending the same token three
   ways, separated the two failures the collector had been flattening into one:

     a token with a broken signature → error_hint "Invalid refresh token"
     the supervisor's real token     → error_hint "<uuid>"   (not its own jti)

   The second means the portal recognises the value as one it issued and is
   refusing it anyway.

   THE READING OF THAT CHANGED TWICE ON 2026-09-22, and both old readings are
   recorded because both are inviting. This file used to say "Bolt rotates the
   refresh token on every exchange and invalidates the one presented, and
   getAccessToken returns the successor in the same response" — measured false:
   one token exchanged fifteen times in a row, code 0 every time, and no
   refresh_token field in any response. Nothing is spent by using it.

   The replacement reading, that the uuid names the token that superseded ours,
   is ALSO false: the same uuid comes back for owner 173999's dead token and
   owner 174036's, so it cannot be either one's successor. It is a constant.
   src/sources/bolt.js carries both measurements.

   These tests pin the things that made a one-line bug cost a week: a successor
   would be kept if one ever arrived, the portal's own words survive into the
   log, and a token's expiry is known before it lapses rather than after. */
import { readFileSync } from 'node:fs';
import { jwtExpiry, jwtPayload } from '../src/util.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

// The token the supervisor actually pasted. Signature-bearing but long dead as
// a credential — it expired 2026-08-27 and the portal has superseded it many
// sessions over — so it is safe here and it is the only realistic fixture for
// "what does a real one look like".
const REAL = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJkYXRhIjp7InR5cGUiOiJiYXNlIiwiZmxlZXRfb3duZXJfaWQiOjE3Mzk5OSwianRpIjoiYjllMGI4NmQtMmYwYi00OGFjLWIyYjItMmU2N2MzNjQwMjg1In0sImlhdCI6MTc4NzIyOTczMSwiZXhwIjoxNzg3ODM0NTMxfQ.1e5eCq-Nwtd1dS_GYusNoIrRLWwDxvjJ0qKiQId4TT8';
const EXP_MS = 1787834531000;   // 2026-08-27T12:42:11Z

console.log('\ncredentials: expiry is knowable before it bites');

check('a portal refresh token states its own expiry',
  jwtExpiry(REAL, EXP_MS - 3 * 86400000)?.expires_at === '2026-08-27T12:42:11.000Z');
check('and how long is left, so a page can warn rather than wait for a flat chart',
  jwtExpiry(REAL, EXP_MS - 3 * 86400000)?.days_left === 3);
check('an already-lapsed token reads as expired, not as "3 days left"',
  jwtExpiry(REAL, EXP_MS + 1000)?.expired === true
  && jwtExpiry(REAL, EXP_MS - 1000)?.expired === false);

/* This runs over every stored secret, and most of them are not JWTs — an Uber
   web cookie, a Yango session, a password. Throwing on those would take the
   whole Settings page down to show an expiry on one row. */
for (const junk of ['', null, undefined, 'not-a-jwt', 'a.b', 'a.b.c', '{}',
  'eyJhbGciOiJIUzI1NiJ9.bm90LWpzb24.sig', 42, {}]) {
  check(`a non-JWT secret comes back null rather than throwing (${JSON.stringify(junk)})`,
    jwtExpiry(junk) === null);
}
// A JWT with no exp claim is readable but says nothing about expiry — which is
// not the same as "expires now".
check('a JWT without an exp claim yields no expiry rather than an expired one',
  jwtExpiry(`x.${Buffer.from(JSON.stringify({ sub: 'a' })).toString('base64url')}.y`) === null);

check('the payload is readable, so a token can be matched to the owner it was issued to',
  jwtPayload(REAL)?.data?.fleet_owner_id === 173999);

console.log('\ncredentials: the successor is kept');

const bolt = readFileSync('src/sources/bolt.js', 'utf8');
const settings = readFileSync('src/settings.js', 'utf8');

/* Kept as a standing guard rather than as a live bug. The portal returns no
   successor today (measured, fifteen exchanges, none), but if it ever starts
   then reading past it would spend the credential on the first company in the
   loop and leave the second fleet dark in the same run — which is what this
   code path was written for. The write-back costs one comparison; losing it
   would cost a week the next time Bolt changes its mind. */
check('a successor refresh token, if one ever arrives, is read out of the response',
  /data\?\.data\?\.refresh_token \|\| data\?\.refresh_token/.test(bolt));
check('and written back to the store, not just held for this run',
  /await setSetting\(RT_KEY\(fleet\), next\)/.test(bolt));
check('and only when it actually changed, so an unchanged token is not rewritten',
  /next && next !== rt/.test(bolt));
/* setSetting rejects any key outside the catalogue, so an unregistered key
   turns the write-back into a throw — the failure mode this replaced. */
for (const k of ['BOLT_REFRESH_TOKEN_ECOSINE', 'BOLT_REFRESH_TOKEN_EGARI']) {
  check(`${k} is registered, or the write-back throws "unknown setting"`,
    settings.includes(`key: '${k}'`));
}
/* The word "rotated" came out of this message on 2026-09-22: measured over
   fifteen consecutive exchanges of one live token, the portal never returns a
   successor, so nothing rotates — it supersedes. The assertion is on the
   SEVERITY, which is what this check was always about, rather than on the
   noun, which is what made it fail when the prose was corrected. */
check('a failed write-back is an error, since the next run cannot succeed without it',
  /log\.error\(SRC, `could not store the successor refresh token/.test(bolt));

/* Per fleet. A refresh token is issued to one fleet owner and the two fleets
   have two (174036 / 173999), so a single shared slot means one fleet's
   credential silently stands in for the other's — which is exactly what the
   `|| config.bolt.refreshToken` fallback did to Egari for a week. */
check('each fleet reads its own token, falling back to the shared one',
  /RT_KEY = \(fleet\)/.test(bolt) && /get\(RT_KEY\(fleet\)\) \|\| config\.bolt\.refreshToken/.test(bolt));

console.log('\ncredentials: the portal\'s own words survive');

/* "portal token invalid — refresh needed" is a diagnosis, not an observation,
   and it was the wrong one. The message, code and hint are what distinguish a
   spent token from a broken one — and the hint is the id of the token that
   replaced it. */
check('the rejection logs the portal message, code and hint rather than a verdict',
  /data\?\.message/.test(bolt) && /error_hint/.test(bolt) && /data\?\.code/.test(bolt));
check('and names the owner the token was issued to next to the fleet it was used for',
  /token_owner/.test(bolt) && /expected_owner/.test(bolt) && /owner_matches/.test(bolt));
check('an expired token is refused before the call, not sent and blamed on the portal',
  /meta\?\.expired/.test(bolt) && /re-capture from the portal/.test(bolt));
/* One dead credential must not cost the other fleet its trips: the loop
   continues rather than throwing out of the whole source. */
check('one fleet\'s dead token does not abort the other fleet',
  /return \{ at: null, err/.test(bolt) && /continue;/.test(bolt));
// Zero orders on an authenticated call and zero orders because we read the
// wrong field look identical in the row count.
check('an authenticated call that returns nothing says so',
  /authenticated, no orders in window/.test(bolt));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
