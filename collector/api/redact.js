/* What an anonymous reader may not see, in one place.
   ─────────────────────────────────────────────────────────────────────────
   This product has no user authentication. `api/auth_routes.js` is provider
   credential health, not sign-in, and every /api route answers a request with
   no cookie, no header and no token. That is a deliberate posture for a
   dashboard of aggregates — and it stops being defensible the moment a route
   hands back a provider's record verbatim.

   Measured on production 2026-09-05, with curl and no credentials:

     /api/trip?platform=hotel&id=…   trip.raw.driver carries `password`
                                     ($2b$10$… bcrypt cost 10), `emiratesId`
                                     784-1999-8885500-5, `phone`, and an
                                     `ExponentPushToken[…]` — on all 12 of 12
                                     hotel trips sampled, 0 of 36 elsewhere.
     /api/schema/raw-values          key=driverInfo returns 60 provider records
                                     verbatim: {driverUuid, email, firstName,
                                     lastName, phone}.
     /api/compliance/drivers         289 rows, phone 289/289, emirates_id
                                     123/289, licence_no 94/289.
     /api/export/trips.csv           x-export-rows 265,739 on a one-year
                                     window against a 400,000 cap, so the whole
                                     364,015-row booking history — with pickup
                                     and drop-off addresses — fits one GET.

   The push token is the sharpest of these: it is a capability, not a fact.
   Anyone holding it can send notifications to that driver's phone.

   ── redact on the way OUT, not on the way in ─────────────────────────────
   `trip.raw` is the audit trail this product rests on — every "what did the
   provider actually send" answer, every schema inventory, every future field
   we have not thought to map yet. Stripping at ingest would buy the same
   safety and cost the record. So the stored row keeps everything and the
   boundary decides what leaves.

   The one exception is a value that must never have been written at all: a
   bcrypt hash and a push token are not evidence about a ride, and
   src/sources/hotel.js drops those at ingest as well. Belt and braces, because
   a new route added next year will not remember to call this.

   ── and it SAYS what it withheld ─────────────────────────────────────────
   A field silently missing from `raw` is indistinguishable from a field the
   provider never sent, and this product's whole claim is that it can tell
   those apart. Every redaction returns the paths it removed so the page can
   name them. Same rule as redactSettings() in api/admin_gate.js: "Presence,
   provenance and expiry survive redaction; the value does not." */

/* ── what stays, and why ─────────────────────────────────────────────────
   Phone and email are NOT redacted. They are a feature the operator asked for
   in as many words — "let's have uber drivers phone numbers email address and
   pictures if possible" — and #drivers, #roster and every driver page are built
   to show them. Removing them here would break a page on purpose while calling
   it a security fix.

   What goes is the set nobody asked for and no page renders: identity
   documents (Emirates ID, licence number, passport, visa), bank and card
   numbers, and anything that is a CREDENTIAL rather than a fact — a bcrypt
   hash, an API key, a session cookie, and the Expo push token, which is a
   capability to send a notification to that driver's handset.

   The line is: a fact about a person the fleet already employs may be shown to
   whoever can reach the dashboard; a government identifier or a working key may
   not. */

/* Matched against the KEY, at any depth.

   Deliberately not a list of the four keys the hotel feed happens to use
   today. A provider adds a field whenever it likes and nobody re-reads this
   file when they do, so the test is the shape of the name. The cost of a false
   positive is one withheld value on a diagnostic page, named as withheld; the
   cost of a false negative is a national identity number on the open web. */
export const SECRET_KEY = new RegExp([
  'password', 'passwd', 'secret', 'token', 'otp', 'pin',
  'emirates', 'national.?id', 'nationality.?id',
  'licen[cs]e.?(no|num|number)', 'passport', 'visa.?(no|num|number)',
  'iban', 'account.?(no|num|number)', 'card.?(no|num|number)',
  'api.?key', 'auth', 'credential', 'cookie', 'session',
].join('|'), 'i');

/* A key that LOOKS secret but is a harmless identifier this product needs.
   `driver_ext_id` and friends are the join keys every page is built on, and
   `authorization` on a corporate booking is an approval object, not a header —
   #corporate's whole leakage tab reads it. */
const KEEP = /^(driver_ext_id|external_id|trip_id|partner_id|org_id|vehicle_id|authorization|authorizations|has_authorization)$/i;

const isObj = (v) => v !== null && typeof v === 'object';

/** Deep-strip secret-shaped keys. Returns the cleaned value and the paths
    removed, so a caller can say what it withheld rather than implying the
    provider sent nothing. Never mutates its argument. */
export function redactRaw(value, { path = '', removed = [] } = {}) {
  if (Array.isArray(value)) {
    const out = value.map((v, i) => redactRaw(v, { path: `${path}[${i}]`, removed }).value);
    return { value: out, removed };
  }
  if (!isObj(value)) return { value, removed };
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const here = path ? `${path}.${k}` : k;
    if (!KEEP.test(k) && SECRET_KEY.test(k)) { removed.push(here); continue; }
    out[k] = redactRaw(v, { path: here, removed }).value;
  }
  return { value: out, removed };
}

/** True when a raw FIELD NAME is one whose distinct values must not be sampled.
    /api/schema/raw-values exists to say whether a field is a dimension worth
    charting; for a secret it can answer that from the count alone. */
export const secretField = (key) => Boolean(key) && !KEEP.test(key) && SECRET_KEY.test(key);

/* A raw field can be an OBJECT rather than a scalar — `driverInfo` on the Uber
   telemetry rows is {driverUuid, email, firstName, lastName, phone}, and
   `raw ->> 'driverInfo'` serialises the whole record into the `value` column.
   So the sampler has to redact the value as well as refuse the key. */
export function redactSampleValue(v) {
  if (v == null) return v;
  const s = String(v);
  if (!(s.startsWith('{') || s.startsWith('['))) return s;
  try { return JSON.stringify(redactRaw(JSON.parse(s)).value); } catch { return s; }
}

/* ── the identity documents a COLUMN carries, not a raw blob ─────────────
   redactRaw() above walks a provider record whose shape nobody controls. This
   pair is the other half of the same rule, applied where the shape IS ours:
   driver_compliance has named columns, and two of them are government identity
   documents. The set lives here rather than in each route because it was
   defined in api/server.js and /api/driver/profile — a route on another file,
   selecting the same two columns for one person instead of the whole roster —
   went on serving 784-1977-5137316-4 to an anonymous GET after the roster
   stopped. Measured on production 2026-09-05, after the roster fix shipped to
   this branch and before this one did. One definition, imported twice, is the
   only arrangement in which that cannot happen again.

   Phone, email and picture stay, here as everywhere: see "what stays, and why"
   at the top of this file. */
/* A photograph's ADDRESS, which is this product's own and not Uber's.
   ─────────────────────────────────────────────────────────────────────────
   driver_compliance.picture_url holds what the portal returned: a CloudFront
   URL signed for twelve hours. It is dead within half a day of being written
   and it is 480 bytes of expired credential — measured on production, 12.2% of
   the entire /api/drivers/directory response was Expires/Signature/Key-Pair-Id
   query string that had not worked for two days.

   So it never leaves. What leaves is the address of the copy we hold, which is
   short, stable, and answers. A driver with no stored photograph gets null,
   which is what avatar() already draws initials for — the same three states
   the rest of this file keeps apart: held and served, held and withheld, never
   collected.

   Applied at the point of emission rather than in the query, because the same
   rows carry the expiry dates and counts the compliance page derives, and
   because an administrator reading provenance may still want to know a URL was
   once stored. */
export const photoHref = (platform, id) => (platform && id
  ? `/api/driver/photo/${encodeURIComponent(platform)}/${encodeURIComponent(id)}`
  : null);

/* Replace every picture_url with our own, for rows we hold bytes for.
   `held` maps driver_ext_id -> the platform the bytes are filed under, built by
   the caller from one cheap query that reads no bytes at all.

   KEYED ON THE ID, AND THE PLATFORM COMES BACK OUT OF THE MAP. It used to be a
   Set of `<platform>\u0000<id>` keys probed with the ROW's platform, which
   quietly requires the compliance record and the photograph to be filed under
   the same channel. Today they always are, because Uber is the only channel
   that files a picture at all — so the bug would have waited for the first
   person with a hotel record and an Uber face and then shown them nothing. The
   address has to name the row the bytes are actually under; anything else is a
   404 this product built for itself. The same mistake, in its louder form, put
   a null on all 434 rows of the driver directory. */
export function withPhotos(rows, held) {
  return rows.map((r) => {
    const platform = held && held.get(r.driver_ext_id);
    return { ...r, picture_url: platform ? photoHref(platform, r.driver_ext_id) : null };
  });
}

export const IDENTITY_DOCS = ['licence_no', 'emirates_id'];

/** Drop the identity documents from a row set unless the caller is an admin.
    Non-mutating; the rows keep every other column. */
export function stripIdentity(rows, admin) {
  if (admin) return rows;
  return rows.map((r) => {
    const o = { ...r };
    for (const c of IDENTITY_DOCS) delete o[c];
    return o;
  });
}

/** The sentence a page prints where the number used to be.

    SAID, not merely absent — the rule this whole file is built on. A blank
    Emirates ID cell already means something specific on this product ("the
    channel that onboarded this person does not report one"), and letting a
    withheld value render as that same blank would make the page state a
    falsehood about the provider. Every route that calls stripIdentity() also
    returns `identity_withheld` and this reason, and api/public/app.js and
    api/public/driver.js render the withheld cell differently from the empty
    one because of it. */
export const withheldNote = (what) => `The ${what} themselves are withheld from this response: this `
  + 'API answers every request without a credential, and a government identity document is not '
  + 'something to hand to an anonymous GET. Coverage, expiry dates and the expired/expiring '
  + 'counts are all unredacted above and below — only the numbers are gone. Present a valid '
  + 'x-admin-token to see them.';
