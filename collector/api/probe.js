/* Live API probes — "what does this provider actually give us?"
   ──────────────────────────────────────────────────────────────────────────
   The collectors map a chosen subset of each provider's response into columns.
   When a question comes up that the mapped data cannot answer — "does Uber
   segregate business trips?" — the only honest way to settle it is to call the
   provider and look, rather than reason from what we happened to keep.

   Two rules make this safe to leave enabled:

   1. Every upstream call is from a fixed allowlist below. There is no
      pass-through of a caller-supplied URL, operation or body, so this cannot
      be turned into an open proxy onto the fleet's credentials.
   2. Responses are reduced to SHAPE before they are returned — field names,
      value cardinality, and sample values only for fields with few enough
      distinct values to be a dimension rather than personal data. Full records
      never leave this module.

   Nothing here writes. */

import { config } from '../src/config.js';
import { http, qs } from '../src/http.js';
import { pool } from '../src/db.js';
import { uberOAuthToken, uberWebHeaders, UBER_WEB_HOST } from '../src/auth/uber.js';
import { probeEarnerWindow, auditTripWindow, uberOrgs } from '../src/sources/uber.js';
import { loadSettings } from '../src/settings.js';
/* The fleet's clock, for the two default windows below. src/util.js owns the
   +04:00 arithmetic and every other server-side day key already goes through
   it or through Postgres's AT TIME ZONE 'Asia/Dubai'; a fourth private copy of
   the offset here is how the two would eventually disagree. */
import { dubaiIso } from '../src/util.js';
import { log } from '../src/log.js';

/* The org a probe asks about: the first with a full credential pair. The
   legacy fields carry Ecosine's values where they are set, but on a component
   that holds only one org's cookie the pair must come from ONE entry — the
   Ecosine uuid with the Egari cookie is a 401 wearing a confusing hat. */
const uberOrg = () => config.uber.orgs?.[0] || config.uber;

/* The API component had its OWN three copies of the host, and fixes 39 and 40
   moved only the collector's. So every live Uber diagnostic on production went
   on posting to a 301 and answering "Not Found" — and /api/probe/uber/tier
   printed "Re-paste the supplier cookie", sending an operator to destroy a
   session that was working at that moment. A diagnostic that is confidently
   wrong is worse than no diagnostic. */
const REPORTS = `${UBER_WEB_HOST}/api/vs-sp-reports-management`;

/* Report types worth testing for existence. Uber answers an unknown name with
   REPORT_TYPE_INVALID, so this enumerates the surface cheaply — the report is
   never downloaded, only asked for. */
const CANDIDATE_REPORTS = [
  'REPORT_TYPE_TRIP_ACTIVITY',
  'REPORT_TYPE_DRIVER_ACTIVITY',
  /* The two the fleet actually wants if no tier exists: they are the INPUTS
     Uber computes a tier from — confirmation, cancellation and completion
     rates, ratings over the last 500 trips, earnings and trips per hour — and
     unlike a tier they are per-driver, numeric, and not gated on a driver's
     personal opt-in, so their coverage would be the whole roster. */
  'REPORT_TYPE_DRIVER_QUALITY',
  'REPORT_TYPE_DRIVER_PERFORMANCE',
  'REPORT_TYPE_PAYMENT_DETAILS',
  'REPORT_TYPE_PAYMENTS',
  'REPORT_TYPE_EARNINGS',
  'REPORT_TYPE_TRIP_DETAILS',
  'REPORT_TYPE_VEHICLE_ACTIVITY',
  'REPORT_TYPE_ORGANIZATION_TRIPS',
  'REPORT_TYPE_BUSINESS_TRIPS',
  'REPORT_TYPE_U4B_TRIPS',
  'REPORT_TYPE_RIDER_ACTIVITY',
  'REPORT_TYPE_INVOICE',
  'REPORT_TYPE_TAX',
  'REPORT_TYPE_FLEET_PERFORMANCE',
];

/* Reduce any JSON to a description of its shape. Values are only echoed for
   fields with few distinct values — a product tier is a dimension worth seeing,
   an address is not. */
function describe(records, { maxValues = 12 } = {}) {
  const rows = Array.isArray(records) ? records : [records];
  const fields = new Map();
  const walk = (obj, prefix = '') => {
    if (obj == null || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) { walk(v, path); continue; }
      const f = fields.get(path) || { key: path, present: 0, filled: 0, values: new Set(), type: null };
      f.present++;
      if (v !== null && v !== '' && !(Array.isArray(v) && !v.length)) f.filled++;
      f.type = f.type || (Array.isArray(v) ? 'array' : typeof v);
      if (f.values.size <= maxValues + 1 && !Array.isArray(v)) f.values.add(String(v).slice(0, 48));
      fields.set(path, f);
    }
  };
  rows.slice(0, 200).forEach((r) => walk(r));
  return [...fields.values()].map((f) => ({
    key: f.key, type: f.type,
    fill_pct: f.present ? Math.round((f.filled / f.present) * 100) : 0,
    distinct_seen: f.values.size,
    // A field with a handful of values is a dimension; anything wider is
    // free text or an identifier and its contents are not reported.
    values: f.values.size <= maxValues ? [...f.values] : null,
  })).sort((a, b) => b.fill_pct - a.fill_pct || a.key.localeCompare(b.key));
}


/* Does Uber tell a fleet what tier its drivers are?
   ─────────────────────────────────────────────────────────────────────────
   Uber Pro ranks a driver Blue, Gold, Platinum or Diamond, and nothing in
   this product has ever asked whether that reaches a supplier account. The
   report pipeline does not carry it — REPORT_TYPE_DRIVER_ACTIVITY was probed
   and has exactly six columns, none of them a tier — so if it exists at all
   it is on the GraphQL surface, which we call for exactly one thing.

   Asking is not as simple as guessing a field name, and this endpoint exists
   because there are three ways to ask and they answer differently:

   1. INTROSPECTION. If the server will describe its own schema, that is the
      whole answer in one call and every guess below is unnecessary. Usually
      disabled in production; costs one request to find out.

   2. FIELD PROBING. A GraphQL server answers an unknown field with
      "Cannot query field X on type T" — and very often with
      "Did you mean Y?", which names a REAL field we did not know existed.
      So a wrong guess is not a wasted call: the error is the schema leaking
      one field at a time, and a near-miss is more informative than a hit.

   3. OPERATION PROBING. PERMISSION_DENIED and "Cannot query field" mean
      opposite things at the query root. The first says the operation EXISTS
      and this session may not have it — a credential question, answerable by
      a human with the right login. The second says it does not exist at all,
      and no credential will ever change that. Reporting them as one failure
      would waste somebody's week.

   Every candidate is fixed in this file. Nothing the caller sends becomes
   part of a query, so this cannot be turned into an open GraphQL proxy onto
   the fleet's session. Read-only; writes nothing. */
const TIER_FIELDS = [
  /* The recognition family first, because recognitionRating is the one field
     on this type we KNOW is real — GetDriver returns 4.97 from it — and Uber
     names things by family. A tier living beside a rating would be called
     recognitionSomething long before it would be called proTier.

     recognitionTie is a deliberate near-miss on that known-real prefix. It
     cannot exist, and that is the point: a server that answers it with
     'Did you mean "recognitionRating"?' and NOTHING ELSE has just told us
     there is no other recognition* field on DriverInfo, which is worth more
     than twenty blind guesses. */
  ['driverInfo', 'recognitionTier'], ['driverInfo', 'recognition'],
  ['driverInfo', 'recognitionStatus'], ['driverInfo', 'recognitionLevel'],
  ['driverInfo', 'recognitionTie'],
  /* On the type that already carries completedTripsCount and
     recognitionRating — the likeliest home for a status the same surface
     computes. */
  ['driverInfo', 'proTier'], ['driverInfo', 'tier'], ['driverInfo', 'driverTier'],
  ['driverInfo', 'loyaltyTier'], ['driverInfo', 'rewardsTier'], ['driverInfo', 'uberProTier'],
  ['driverInfo', 'proStatus'], ['driverInfo', 'uberProStatus'], ['driverInfo', 'tierName'],
  ['driverInfo', 'currentTier'], ['driverInfo', 'level'], ['driverInfo', 'driverLevel'],
  ['driverInfo', 'status'], ['driverInfo', 'partnerTier'], ['driverInfo', 'performanceTier'],
  ['driverInfo', 'badge'], ['driverInfo', 'acceptanceRate'], ['driverInfo', 'cancellationRate'],
  ['driverInfo', 'lifetimeTrips'], ['driverInfo', 'rating'],
  /* One level up, on the user rather than the driving record. */
  ['user', 'proTier'], ['user', 'tier'], ['user', 'loyaltyStatus'], ['user', 'driverTier'],
  /* And on the driver itself, beside complianceInfo and associatedVehicles. */
  ['driver', 'proTier'], ['driver', 'tier'], ['driver', 'performanceTier'],
  ['driver', 'driverStatus'], ['driver', 'tierInfo'], ['driver', 'rewards'],
];

/* A name that cannot exist, on each parent and at the query root.
   ─────────────────────────────────────────────────────────────────────────
   The first run of this probe was nearly fooled. Twenty-nine of thirty-one
   candidates came back with an explicit `Cannot query field "proTier" on type
   "DriverInfo"` — the schema naming the type, which is a clean no. Two came
   back with a bare "Invalid GraphQL query" instead, and the naive reading is
   that a field the server declines to name is a field that exists.

   That reading is worth nothing without a control. If a name that certainly
   does not exist ALSO draws the bare error, the bare error is noise and those
   two are no different from the other twenty-nine. If the control is named
   and refused like the rest, then the two the server would not name are
   hiding something, and that is the finding.

   One request per parent, and it settles the whole run. */
const CONTROL_FIELDS = [
  ['driverInfo', 'zzNotARealFieldQx'], ['user', 'zzNotARealFieldQx'], ['driver', 'zzNotARealFieldQx'],
];
const CONTROL_OP = 'zzNotARealOperationQx';

/* And the control in the other direction, which matters more.
   ─────────────────────────────────────────────────────────────────────────
   Every negative result below is worthless if the session is simply not
   working: an expired supplier cookie refuses everything, and a run of thirty
   refusals would read as "Uber does not publish a tier" when it means "we did
   not ask anybody". recognitionRating is known-real on this exact type — it
   is where the roster's 4.97 comes from — so if it does not come back with a
   number, nothing else in the run may be believed. */
const POSITIVE_CONTROL = ['driverInfo', 'recognitionRating'];

/* And one more, for a signature the run leans on and nothing else proves.
   ─────────────────────────────────────────────────────────────────────────
   When a candidate is refused WITHOUT being named, the probe asks again with
   a sub-selection, on the theory that the field exists and is an object we
   asked for as a scalar. That whole branch assumes this server answers a bare
   object with "must have a selection of subfields". If it does not — if it
   folds that into the same generic refusal — the retry proves nothing and
   must be reported as inconclusive rather than as a negative.

   complianceInfo is a known-real object on Driver and is not in the baseline
   selection, so asking for it bare is a clean test of the signature. */
const OBJECT_CONTROL = ['driver', 'complianceInfo'];

/* The control that explains the generic refusal, and on this server it is the
   one that matters most.
   ─────────────────────────────────────────────────────────────────────────
   Measured live: zzNotARealFieldQx on DriverInfo is refused BY NAME —
   'Cannot query field "zzNotARealFieldQx" on type "DriverInfo"' — while
   recognitionTier, recognitionStatus, recognitionLevel and recognitionTie on
   the same type are refused with a bare "Invalid GraphQL query". The naive
   reading is that the four the server would not name are real. But
   recognitionTie is a name this file invented; it cannot exist. So the
   difference is not existence. The likeliest cause is that Apollo attaches a
   "Did you mean recognitionRating?" suggestion to a near miss and Uber's
   gateway scrubs any error carrying one, leaving the generic string behind.

   recognitionRatingg is one letter off a field known to be real, and is
   certainly not a field. If it draws the generic refusal too, then proximity
   and not existence is what produces that error, and no generic refusal in
   this run means anything on its own. */
const NEAR_MISS_CONTROL = ['driverInfo', 'recognitionRatingg'];

/* Whole operations. A tier might not hang off GetDriver at all. */
const TIER_OPS = [
  /* Same family reasoning as the fields, and the same prize: at the query
     root, PERMISSION_DENIED and "Cannot query field" are opposite answers.
     The first says the operation is there and a higher-privilege login would
     reach it — a question a person can act on. The second closes it for ever. */
  'getDriverRecognition', 'getEarnerRecognition',
  'getEarnerProfile', 'getDriverRewards', 'getProTier', 'getDriverTier', 'getRewards',
  'getLoyalty', 'getDriverBadges', 'getEarnerTier', 'getDriverPerformanceTier',
  'getDriverIncentives', 'getPerformanceReport', 'getFleetDrivers',
];

/* ── the contact fields, asked for rather than assumed ────────────────────
   src/sources/uber_profile.js says the portal's own query returns "a picture
   url, a phone number and an email as well", and declines to store them. That
   sentence is a claim about a schema nobody has re-checked, and the operator
   now wants those fields — so before writing any storage for them, ask the
   schema what it actually has and under which spellings.

   Fixed candidates, like every other list in this file: nothing the caller
   sends becomes part of a query, so this cannot become an open GraphQL proxy
   onto the fleet's session. Read-only; writes nothing.

   `user` first, because a phone and an email belong to a person rather than to
   a driving record — and `driver` too, because an address, if it exists, is
   more likely to hang off the driver the org contracted than off the account. */
const CONTACT_FIELDS = [
  ['user', 'phoneNumber'], ['user', 'phone'], ['user', 'mobile'], ['user', 'mobileNumber'],
  ['user', 'mobileCountryIso2'], ['user', 'mobileDigits'],
  ['user', 'email'], ['user', 'emailAddress'],
  ['user', 'firstName'], ['user', 'lastName'], ['user', 'name'],
  ['user', 'pictureUrl'], ['user', 'picture'], ['user', 'photoUrl'], ['user', 'profilePhotoUrl'],
  ['user', 'profilePictureUrl'], ['user', 'avatarUrl'],
  ['user', 'address'], ['user', 'homeAddress'], ['user', 'city'], ['user', 'country'],
  ['driver', 'phoneNumber'], ['driver', 'email'], ['driver', 'address'],
  ['driver', 'pictureUrl'], ['driver', 'profilePhotoUrl'],
  ['driver', 'contactInfo'], ['driver', 'personalInfo'], ['driver', 'documents'],
  ['driverInfo', 'phoneNumber'], ['driverInfo', 'email'],
];

/* ── the sub-fields of the two objects the contact set found ──────────────
   Measured 2026-09-04 against the live schema: user.email and user.pictureUrl
   are scalars and answered outright; user.phone is an object of type
   PhoneNumber and user.name an object of type UserName, both proved by a
   { __typename } retry; and EVERY address spelling — address, homeAddress,
   city, country, on all three parents — is named absent. So there is no
   address on this surface, and the two objects need one more question. */
const CONTACT_SUBFIELDS = [
  ['user', 'phone', ' { countryCode }'], ['user', 'phone', ' { country }'],
  ['user', 'phone', ' { countryIso2 }'], ['user', 'phone', ' { nationalNumber }'],
  ['user', 'phone', ' { number }'], ['user', 'phone', ' { digits }'],
  ['user', 'phone', ' { e164 }'], ['user', 'phone', ' { formatted }'],
  ['user', 'phone', ' { phoneNumber }'], ['user', 'phone', ' { subscriberNumber }'],
  ['user', 'name', ' { firstName }'], ['user', 'name', ' { lastName }'],
  ['user', 'name', ' { fullName }'], ['user', 'name', ' { displayName }'],
  ['user', 'name', ' { given }'], ['user', 'name', ' { family }'],
];

/* ── the number itself ────────────────────────────────────────────────────
   PhoneNumber.countryCode is real and answers "+971" — a dialling code, not a
   number. nationalNumber and countryIso2 came back with the bare "Invalid
   GraphQL query" that this file's NEAR_MISS_CONTROL exists to interpret: on
   this gateway that string is what a near-miss produces, so it is ambiguous
   rather than a no. The way to settle an ambiguous field is to ask for it
   BESIDE a field known to be real — if the pair answers, both exist. */
const CONTACT_PAIRS = [
  ['user', 'phone', ' { countryCode nationalNumber }'],
  ['user', 'phone', ' { countryCode countryIso2 }'],
  ['user', 'phone', ' { countryCode national }'],
  ['user', 'phone', ' { countryCode subscriber }'],
  ['user', 'phone', ' { countryCode value }'],
  ['user', 'phone', ' { countryCode rawNumber }'],
  ['user', 'phone', ' { countryCode numberString }'],
  ['user', 'phone', ' { countryCode phone }'],
  ['user', 'name', ' { firstName lastName fullName }'],
  /* And the whole selection this collector would actually send, so the answer
     is the shape that would ship rather than a field at a time. */
  ['user', 'phone', ' { countryCode nationalNumber countryIso2 }'],
];

/* ── one more round on PhoneNumber, and the proof the method works ────────
   The pair technique settled the interpretation. name { firstName } answers
   "Sabbir Hossain" and name { lastName } answers "Shahalom" — both proven real
   — yet name { firstName lastName fullName } comes back "Invalid GraphQL
   query". Two known-real fields plus one unknown produce the generic refusal,
   so on this gateway the generic refusal IS an absence, scrubbed of its "Did
   you mean" suggestion. Every suggestion in three runs came back stripped,
   which is consistent.

   By that proof nationalNumber and countryIso2 are absent too, and fifteen
   spellings of "the actual digits" have now been refused on PhoneNumber. This
   round is the last of them; if none answers, the type carries a dialling code
   and no subscriber number, and the operator's phone list cannot come from
   this surface. */
const PHONE_LAST = [
  ['user', 'phone', ' { countryCode msisdn }'],
  ['user', 'phone', ' { countryCode localNumber }'],
  ['user', 'phone', ' { countryCode nationalPhoneNumber }'],
  ['user', 'phone', ' { countryCode subscriberNo }'],
  ['user', 'phone', ' { countryCode phoneDigits }'],
  ['user', 'phone', ' { countryCode raw }'],
  ['user', 'phone', ' { countryCode line }'],
  ['user', 'phone', ' { countryCode mobileNumber }'],
  ['user', 'phone', ' { countryCode internationalNumber }'],
  ['user', 'phone', ' { countryCode fullNumber }'],
  /* And the control for THIS round: a name that certainly cannot exist, asked
     the same way. If it draws the same generic refusal as the candidates, the
     round has proved nothing new; if it draws a named absence while a
     candidate draws the generic one, that candidate is interesting. */
  ['user', 'phone', ' { countryCode zzNotARealFieldQx }'],
];

/* ── identity DOCUMENTS, which the contact round never asked about ────────
   The contact round asked for a phone, an email, a picture and an address. It
   never asked whether Uber holds a government identity number, and the fleet's
   own hotel channel DOES — driver_compliance.emirates_id is populated on the
   hotel records and empty everywhere else, so a single identifier that would
   join a person across all four channels may be sitting one field away.

   Asked beside countryCode-style known-real siblings where the parent is an
   object, because on this gateway a bare "Invalid GraphQL query" is an absence
   with its suggestion scrubbed, and a pair with one known-real member is what
   tells the two apart. */
const IDENTITY_FIELDS = [
  ['user', 'emiratesId'], ['user', 'nationalId'], ['user', 'nationalIdNumber'],
  ['user', 'identityNumber'], ['user', 'governmentId'], ['user', 'idNumber'],
  ['user', 'documentNumber'], ['user', 'passportNumber'], ['user', 'nationality'],
  ['user', 'dateOfBirth'], ['user', 'birthDate'],
  ['driver', 'emiratesId'], ['driver', 'nationalId'], ['driver', 'identityDocument'],
  ['driver', 'documentInfo'], ['driver', 'identity'], ['driver', 'kyc'],
  ['driver', 'licenseNumber'], ['driver', 'licence'], ['driver', 'driverLicense'],
  ['driver', 'complianceDocuments'], ['driver', 'backgroundCheck'],
  ['driverInfo', 'licenseNumber'], ['driverInfo', 'nationalId'],
  /* complianceInfo is a type this schema DOES have — GetDriver already selects
     complianceInfo { status } — so a document hanging off it is the likeliest
     home of all. */
  ['driver', 'complianceInfo'],
];

/* ── inside ComplianceInfo, the last place a document could hide ──────────
   Every one of the 25 identity candidates came back named-absent except two,
   and one of those two is real: driver.complianceInfo answers with
   __typename ComplianceInfo. GetDriver already selects complianceInfo
   { status }, so `status` is a known-real sibling — which is exactly what the
   pair technique needs to tell a scrubbed absence from a real field. */
const COMPLIANCE_SUB = [
  ['driver', 'complianceInfo', ' { status documents }'],
  ['driver', 'complianceInfo', ' { status emiratesId }'],
  ['driver', 'complianceInfo', ' { status nationalId }'],
  ['driver', 'complianceInfo', ' { status licenseNumber }'],
  ['driver', 'complianceInfo', ' { status licenseExpiry }'],
  ['driver', 'complianceInfo', ' { status expiresAt }'],
  ['driver', 'complianceInfo', ' { status items }'],
  ['driver', 'complianceInfo', ' { status requirements }'],
  ['driver', 'complianceInfo', ' { status reasons }'],
  ['driver', 'complianceInfo', ' { status __typename }'],
  /* The control for this round: cannot exist, asked the same way. */
  ['driver', 'complianceInfo', ' { status zzNotARealFieldQx }'],
];

/* ── inside complianceInfo.documents ─────────────────────────────────────
   The round above was decisive about ComplianceInfo: its control
   (zzNotARealFieldQx) came back NAMED absent, so this type does not scrub, and
   nine of the ten candidates were named absent for real. One was not.
   `{ status documents }` answered "Invalid GraphQL query" — the generic
   refusal — and on a type that demonstrably names what it does not have, a
   generic refusal is the OTHER signature: a field of object type asked without
   a sub-selection. It is the identical answer `driver.complianceInfo` itself
   gives when asked bare, which the control records, and complianceInfo is
   real.

   So `documents` is asked properly here — with a selection — and the round
   opens with `{ __typename }`, which every object type answers and no scalar
   does. If that answers, `documents` exists and the following candidates are
   asked inside it; if it refuses generically as well, `documents` is a scalar
   or does not exist and nothing below can be read as evidence either way.

   The pair rule still applies: `status` rides along as the known-real sibling,
   and zzNotARealFieldQx is the control for this level. */
const COMPLIANCE_DOCS = [
  ['driver', 'complianceInfo', ' { status documents { __typename } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename zzNotARealFieldQx } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename type } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename name } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename number } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename documentNumber } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename id } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename status } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename expiresAt } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename expiryDate } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename issuedAt } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename country } }'],
  /* The two shapes an Emirates ID could take if it is here at all: a value on
     the document, or a document TYPE the fleet could then read a number off. */
  ['driver', 'complianceInfo', ' { status documents { __typename value } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename documentType } }'],
];

/* ── what KIND of document, and when it expires ──────────────────────────
   The documents round settled the shape and found more than it went looking
   for. driver.complianceInfo.documents is real: a list of DriverDocument, and
   two of its fields answer outright —

     status     ACTIVE / MISSING, per document
     expiresAt  a real timestamp: 2028-02-04T19:59:59Z on this driver

   — while type, name, number, documentNumber, id, issuedAt, country and value
   are all NAMED absent, and the control on DriverDocument is named absent too,
   so that type does not scrub either. Uber is therefore telling us that a
   document exists, whether it is present, and when it runs out. It is not
   telling us the number on it, which is the answer to the Emirates ID
   question and is a No.

   Two candidates came back with the generic refusal rather than a name:
   `documentType` and `expiryDate`. On a type that names its absences that is
   the object-needs-a-selection signature again, the same one that found
   `documents` itself. `documentType` is the field that would say WHICH
   document each of these rows is — and without it the expiry dates are a set
   of dates belonging to nothing nameable, which is not usable on a compliance
   page. So it is asked properly here.

   This matters beyond the identity question. /api/compliance/drivers holds
   289 people, 94 licence dates that are all the identical placeholder
   2026-01-01, and 195 with no date at all — while Uber is answering real
   per-document expiry for the same roster. */
const COMPLIANCE_DOC_TYPE = [
  ['driver', 'complianceInfo', ' { status documents { __typename documentType { __typename } } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename documentType { __typename zzNotARealFieldQx } } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename documentType { __typename name } } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename documentType { __typename id } } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename documentType { __typename type } } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename documentType { __typename key } } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename documentType { __typename label } } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename documentType { __typename displayName } } }'],
  ['driver', 'complianceInfo', ' { status documents { __typename documentType { __typename description } } }'],
  /* And the other generic one, asked the same way. */
  ['driver', 'complianceInfo', ' { status documents { __typename expiryDate { __typename } } }'],
];

/* GetDriver with one extra field spliced into one of its three selections.
   The rest of the query is the shape already known to work, so a failure is
   about the field and not about the request. */
function driverQueryWith(parent, field) {
  const extra = { driverInfo: '', user: '', driver: '' };
  extra[parent] = field;
  return `query GetDriver($orgUUID: ID!, $driverUUID: ID!) {
    getDriver(orgUUID: $orgUUID, driverUUID: $driverUUID) {
      driver {
        uuid ${extra.driver}
        member { user {
          uuid ${extra.user}
          driverInfo { completedTripsCount ${extra.driverInfo} }
        } }
      }
    }
  }`;
}

export function probeRoutes(app, { wrap }) {
  /* Which report types this org can actually generate. */
  app.get('/api/probe/uber/report-types', wrap(async (req, res) => {
    await loadSettings();
    if (!uberOrg().orgUuid) return res.status(400).json({ error: 'no Uber org configured' });
    /* The last three days on the fleet's calendar, not on UTC's.
       ────────────────────────────────────────────────────────────────────
       These defaults were `new Date().toISOString().slice(0, 10)`, which is
       the UTC day, and Dubai is UTC+4 all year: between midnight and 04:00
       local the UTC day is still yesterday. Driven with the clock frozen at
       2026-09-02T21:30:00Z — 01:30 on the 3rd in Dubai — this route printed
       and asked Uber for `window: ["2026-08-30","2026-09-02"]`, a window
       ending the day before the one the operator reading it was standing in.
       Now ["2026-08-31","2026-09-03"]. See test/probe_window_dubai.test.mjs.

       `to` is echoed to the reader in the response below, so the wrong day is
       not merely internal — it is printed as the answer to "which window is
       this?". A ?from/?to from the caller is already a string and is left
       exactly as typed: somebody who names a window is asking for the days
       they typed, not for the fleet's clock. */
    const to = req.query.to || dubaiIso();
    const from = req.query.from || dubaiIso(new Date(Date.now() - 3 * 864e5));
    const out = [];
    for (const reportType of CANDIDATE_REPORTS) {
      try {
        const { data } = await http(`${REPORTS}/GenerateReport?localeCode=en-GB`, {
          method: 'POST', timeoutMs: 30000, retries: 0, headers: uberWebHeaders(uberOrg()),
          body: JSON.stringify({
            orgId: { uuid: { value: uberOrg().orgUuid } }, reportType,
            startDate: { value: from }, endDate: { value: to },
            childOrgUuids: [{ uuid: { value: uberOrg().orgUuid } }],
          }),
        });
        const ok = data?.status === 'success';
        out.push({ reportType, valid: ok,
          detail: ok ? 'accepted' : String(JSON.stringify(data?.data?.meta?.details || data?.data || data)).slice(0, 160) });
      } catch (e) { out.push({ reportType, valid: false, detail: String(e).slice(0, 160) }); }
    }
    res.json({ window: [from, to], types: out });
  }));

  /* The shape of one generated report's CSV header — column names only. */
  app.get('/api/probe/uber/report-columns', wrap(async (req, res) => {
    await loadSettings();
    /* An unrecognised type used to fall through to REPORT_TYPE_TRIP_ACTIVITY,
       which meant a caller asking about a report that does not exist got a
       confident, detailed and completely wrong answer about a different one —
       trip columns presented as the answer to a question about drivers. A
       probe whose failure mode is a plausible wrong answer is worse than no
       probe, so an unknown type is refused by name. */
    if (req.query.type && !CANDIDATE_REPORTS.includes(String(req.query.type))) {
      return res.status(400).json({
        error: `unknown report type ${String(req.query.type).slice(0, 60)}`,
        known: CANDIDATE_REPORTS,
      });
    }
    const reportType = req.query.type ? String(req.query.type) : 'REPORT_TYPE_TRIP_ACTIVITY';
    /* The same UTC-day default as report-types above, and the same fix — but
       here the dates are not only echoed as `window: [from, to]`, they decide
       which rows the report CONTAINS, so a default run started at 01:00 Dubai
       described the columns of a window that stops a day short of today.
       Measured at the same frozen instant: ["2026-08-30","2026-09-02"] before,
       ["2026-08-31","2026-09-03"] after. */
    const to = req.query.to || dubaiIso();
    const from = req.query.from || dubaiIso(new Date(Date.now() - 3 * 864e5));
    const { data: gen } = await http(`${REPORTS}/GenerateReport?localeCode=en-GB`, {
      method: 'POST', timeoutMs: 30000, headers: uberWebHeaders(uberOrg()),
      body: JSON.stringify({
        orgId: { uuid: { value: uberOrg().orgUuid } }, reportType,
        startDate: { value: from }, endDate: { value: to },
        childOrgUuids: [{ uuid: { value: uberOrg().orgUuid } }],
      }),
    });
    if (gen?.status !== 'success') {
      return res.json({ reportType, error: String(JSON.stringify(gen?.data?.meta?.details || gen)).slice(0, 300) });
    }
    const id = gen.data.reportId.uuid.value;
    let url = null;
    for (let i = 0; i < 30 && !url; i++) {
      const { data } = await http(`${REPORTS}/DownloadReport?localeCode=en-GB`, {
        method: 'POST', timeoutMs: 30000, headers: uberWebHeaders(uberOrg()),
        body: JSON.stringify({ orgId: { uuid: { value: uberOrg().orgUuid } }, reportId: { uuid: { value: id } } }),
      });
      url = data?.data?.signedUrl?.value;
      if (!url) await new Promise((r2) => setTimeout(r2, 5000));
    }
    if (!url) return res.json({ reportType, error: 'report did not finish generating within 150s' });
    const { data: csv } = await http(url, { expect: 'text', timeoutMs: 120000 });
    const lines = String(csv).split(/\r?\n/).filter(Boolean);
    const header = (lines[0] || '').split(',').map((h) => h.replace(/^"|"$/g, ''));
    // Cardinality per column, so a low-cardinality column (a dimension) is
    // distinguishable from an identifier without echoing the rows.
    const cells = lines.slice(1, 400).map((l) => l.split(','));
    res.json({
      reportType, window: [from, to], rows_sampled: cells.length,
      columns: header.map((h, i) => {
        const vals = new Set(cells.map((c) => (c[i] || '').replace(/^"|"$/g, '')).filter(Boolean));
        return { column: h, distinct_seen: vals.size, values: vals.size <= 12 ? [...vals] : null };
      }),
    });
  }));

  /* Does Uber report a driver rating? It does, and nothing here asked.
     ──────────────────────────────────────────────────────────────────────
     The roster page has carried a Rating column of dashes for every driver
     since it was built, under a sentence saying nothing reaching this fleet
     reports one. That sentence was written from the surfaces the collector
     happens to call: the roster endpoint returns onboarding status and a
     vehicle, and the earnings breakdown returns trips, distance and money.

     The supplier portal has a third surface neither of those is on. GetDriver
     returns driver.member.user.driverInfo.recognitionRating alongside
     completedTripsCount and isBanned — one driver per call, by uuid. It was
     captured from the portal with a working session months ago and sat
     unread in the reconnaissance folder.

     Probed rather than asserted, because "the capture shows a field" and "the
     field has a value for our drivers" are different claims and only the
     second is worth changing a page for. `driver` takes a uuid so a caller
     can check a specific person; without one it asks about the first driver
     the roster knows, which is enough to answer whether the surface works. */
  app.get('/api/probe/uber/driver', wrap(async (req, res) => {
    await loadSettings();
    const org = uberOrg();
    let uuid = String(req.query.uuid || '').trim();
    if (!uuid) {
      const { rows } = await pool.query(
        /* Scoped to the org we are about to ask AS. Unscoped, this took the
           newest roster row of either fleet and asked Ecosine about it — and
           an Egari driver asked of Ecosine returns INTERNAL_SERVER_ERROR with
           an empty message, which reads exactly like a dead cookie. A probe
           whose default arguments manufacture a scary error about a healthy
           credential is worse than one that declines to guess. */
        `SELECT driver_ext_id FROM driver_platform_state
          WHERE platform = 'uber' AND fleet_id = $1
            AND coalesce(btrim(driver_ext_id), '') <> ''
          ORDER BY observed_at DESC NULLS LAST LIMIT 1`, [uberOrg().fleet]);
      uuid = rows[0]?.driver_ext_id || '';
    }
    if (!uuid) return res.json({ error: 'no uber driver uuid to ask about' });

    const query = `query GetDriver($orgUUID: ID!, $driverUUID: ID!) {
      getDriver(orgUUID: $orgUUID, driverUUID: $driverUUID) {
        orgUUID
        driver {
          uuid
          member { user {
            uuid
            driverInfo { completedTripsCount recognitionRating }
            isBanned
          } }
          associatedVehicles { uuid licensePlate make model year }
          complianceInfo { status }
        }
      }
    }`;
    const { data } = await http(`${UBER_WEB_HOST}/graphql`, {
      method: 'POST', timeoutMs: 30000, headers: uberWebHeaders(org),
      body: JSON.stringify({ operationName: 'GetDriver',
        variables: { orgUUID: org.orgUuid, driverUUID: uuid }, query }),
    });
    /* JSON, not String(). A GraphQL error is an object and half of them carry
       no `message` — String() on one yields "[object Object]", which is a
       diagnostic that diagnoses nothing. The same slip is why the analyst's
       charging-site rule shipped naming no place. */
    const say = (e) => (typeof e === 'string' ? e
      : (e?.message || JSON.stringify(e))).slice(0, 400);
    if (data?.errors?.length) {
      return res.json({ error: say(data.errors[0]), errors: data.errors.length });
    }
    const d = data?.data?.getDriver?.driver;
    if (!d) {
      return res.json({ error: 'no driver in the response',
        keys: Object.keys(data || {}),
        data_keys: Object.keys(data?.data || {}),
        body: JSON.stringify(data).slice(0, 600) });
    }
    const info = d.member?.user?.driverInfo || {};
    /* Shape and the rating itself. A rating is a number about a person, not
       personal data in the sense this module guards against — and the whole
       question is whether it has a value, which a shape summary cannot say. */
    res.json({
      fleet: org.fleet, driver_uuid_asked: uuid,
      recognitionRating: info.recognitionRating ?? null,
      completedTripsCount: info.completedTripsCount ?? null,
      isBanned: d.member?.user?.isBanned ?? null,
      compliance_status: d.complianceInfo?.status ?? null,
      vehicles: (d.associatedVehicles || []).length,
      /* So a reader can see what else this surface carries without another
         round trip. */
      fields_present: {
        driverInfo: Object.keys(info),
        driver: Object.keys(d),
        vehicle: Object.keys((d.associatedVehicles || [])[0] || {}),
      },
    });
  }));

  /* Shape of the OAuth REST surfaces the trip report does not cover. */
  const REST = {
    /* Which organisations this credential can actually reach, and what Uber
       calls each of them.
       ─────────────────────────────────────────────────────────────────────
       Every other surface here needs an org_id and answers 403 "bad key" for a
       wrong one, which is a question you cannot answer with the thing you are
       trying to find. This one takes no org at all — the OAuth scope list
       already asks for vehicle_suppliers.organizations.read — so it is the one
       endpoint that can say what the right value IS.
       
       Egari's REST org id has been refused on every call for as long as there
       are logs, while its GraphQL surface works: the two want different
       identifiers, and the uuid that satisfies GraphQL is not what REST calls
       an org. Confirmed by setting it and watching the 403 persist. An org
       list has two rows, so describe() reports the ids rather than suppressing
       them as free text, which is exactly what makes this answerable. */
    /* `orgs`, not `organizations` — five other spellings answer 404. Measured
       2026-08-26. This is the only surface here that takes no org_id, so it is
       the only one that can say what a valid org_id IS, and it answers with
       exactly the string UBER_ORG_ENCRYPTED wants. */
    orgs: () => 'https://api.uber.com/v1/vehicle-suppliers/orgs',
    'driver-actions': (org) => `https://api.uber.com/v1/vehicle-suppliers/drivers/actions?org_id=${encodeURIComponent(org)}`,
    transactions: (org) => `https://api.uber.com/v1/vehicle-suppliers/transactions?org_id=${encodeURIComponent(org)}&limit=50`,
    'earner-payments': (org) => `https://api.uber.com/v1/vehicle-suppliers/earners/payments?org_id=${encodeURIComponent(org)}&limit=50`,
    vehicles: (org) => `https://api.uber.com/v1/vehicle-suppliers/vehicles?org_id=${encodeURIComponent(org)}&limit=50`,
    drivers: (org) => `https://api.uber.com/v1/vehicle-suppliers/drivers?org_id=${encodeURIComponent(org)}&limit=50`,
  };

  app.get('/api/probe/uber/rest', wrap(async (req, res) => {
    await loadSettings();
    const only = req.query.endpoint;
    const names = only && REST[only] ? [only] : Object.keys(REST);
    const token = await uberOAuthToken();
    const out = [];
    for (const name of names) {
      try {
        const { data, status } = await http(REST[name](config.uber.org), {
          timeoutMs: 30000, retries: 0, headers: { authorization: `Bearer ${token}` },
        });
        // Find the first array of objects in the response — providers wrap
        // their lists under varying keys.
        const arr = Array.isArray(data) ? data
          : Object.values(data || {}).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
        out.push({ endpoint: name, status: status || 200,
          count: Array.isArray(arr) ? arr.length : 0,
          top_level_keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 20) : [],
          fields: arr ? describe(arr) : describe(data || {}) });
      } catch (e) {
        out.push({ endpoint: name, error: String(e).slice(0, 220) });
      }
    }
    res.json({ endpoints: out });
  }));

  /* ── is a gap in our history recoverable, or is it gone? ──────────────────
     Uber earnings are absent for every month before about March 2026 — 20,016
     bookings in September 2025 with no payout row against any of them. The
     backfill DID ask for those windows: 65 chunks, none failed. They came back
     empty.

     That leaves two possibilities with opposite consequences. Either the
     provider no longer serves data that old, in which case the half-year is
     gone and the product must say so instead of showing a blank; or we asked
     wrongly, in which case re-collecting recovers it. Guessing between them
     decides whether to spend a day on a backfill or on an explanation, and the
     only honest way to settle it is to ask the provider for a window we know
     we are missing and see what comes back.

     Read-only, on the same allowlisted surface the daily probe already calls —
     only the window is a parameter, and it is parsed as a date rather than
     passed through. Counts and field names only; no records leave here. */
  app.get('/api/probe/uber/window', wrap(async (req, res) => {
    await loadSettings();
    const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    if (!isDay(req.query.from) || !isDay(req.query.to)) {
      return res.status(400).json({ error: 'from and to are required, as YYYY-MM-DD' });
    }
    const from = new Date(`${req.query.from}T00:00:00Z`).getTime();
    const to = new Date(`${req.query.to}T23:59:59Z`).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      return res.status(400).json({ error: 'window is not a range' });
    }
    const org = config.uber.org;
    if (!org) return res.status(400).json({ error: 'no Uber org configured' });

    /* Both money surfaces, because they fail differently: earner-payments is
       what driver_performance is built from, transactions is the ledger beside
       it, and a window that one serves and the other does not is itself the
       answer to a different question. */
    const windowed = {
      'earner-payments': `https://api.uber.com/v1/vehicle-suppliers/earners/payments?${qs({
        org_id: org, start_time: from, end_time: to, page_size: 50 })}`,
      transactions: `https://api.uber.com/v1/vehicle-suppliers/transactions?${qs({
        org_id: org, start_time: from, end_time: to, limit: 50 })}`,
    };
    /* The surface that actually feeds driver_performance. The two REST
       endpoints below are the ones the daily probe already watches, and it
       turns out neither is the source: earner-payments returns an empty list
       even for a month we hold AED 140,379 of earnings for, and transactions
       404s outright. Probing only those would have said "the provider serves
       nothing" about a window that is demonstrably served. */
    /* `to` is inclusive to whoever typed it and exclusive to Uber, so the day
       asked about has to be pushed past. Without this a probe for a single day
       asks for a zero-length range and reports "the provider serves nothing"
       about a day it serves — the same off-by-one that was quietly costing the
       collector one day in seven. */
    const until = new Date(to); until.setUTCDate(until.getUTCDate() + 1);
    const graph = await probeEarnerWindow(new Date(from), until)
      .catch((e) => ({ err: String(e).slice(0, 200) }));

    const token = await uberOAuthToken();
    const out = [];
    for (const [name, url] of Object.entries(windowed)) {
      try {
        const { data, status } = await http(url, {
          timeoutMs: 45000, retries: 0, headers: { authorization: `Bearer ${token}` } });
        const arr = Array.isArray(data) ? data
          : Object.values(data || {}).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
        out.push({ surface: name, status: status || 200,
          count: Array.isArray(arr) ? arr.length : 0,
          /* An empty list and a refusal look identical in a row count, and they
             mean opposite things: one says the data is gone, the other says we
             asked wrongly. */
          top_level_keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 20) : [],
          message: data?.message || data?.error || null,
          fields: arr ? describe(arr) : [] });
      } catch (e) { out.push({ surface: name, error: String(e).slice(0, 220) }); }
    }
    res.json({
      window: [req.query.from, req.query.to],
      // The one that answers the question; the REST pair is context.
      earner_breakdowns: graph,
      surfaces: out,
    });
  }));
  /* Ask Uber whether the past we hold is the past it has.
     ─────────────────────────────────────────────────────────────────────────
     Every completeness figure in this product is computed from our own rows.
     /api/coverage/calendar reports 376 Uber days with no gaps, and that is
     true and useless for the question actually being asked, because a day we
     collected a tenth of has rows on it too.

     This settles it the only way it can be settled: regenerate the same
     REPORT_TYPE_TRIP_ACTIVITY the backfill uses, for a window we already
     stored, and compare Uber's Trip UUIDs against ours. Costs one Uber report
     — minutes at the provider, one of an org's three in-flight slots — so it
     takes an explicit window rather than sweeping the year.

     Bounded to EIGHT days, which is not Uber's limit — Uber serves 31 — but
     the gateway's. A monthly report for ninety vehicles takes minutes at the
     provider and this platform cuts a request off at seventy-five seconds, so
     a month asked for here would always die half-answered and read as a
     provider failure. A week lands in seconds. A month is what the audit JOB
     is for: it runs in the worker, where minutes are allowed, and keeps its
     verdict in uber_trip_audit rather than in a response nobody kept. */
  app.get('/api/probe/uber/audit', wrap(async (req, res) => {
    await loadSettings();
    const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    if (!isDay(req.query.from) || !isDay(req.query.to)) {
      return res.status(400).json({ error: 'from and to are required, as YYYY-MM-DD' });
    }
    const from = new Date(`${req.query.from}T00:00:00Z`);
    const to = new Date(`${req.query.to}T00:00:00Z`);
    if (!(to >= from)) return res.status(400).json({ error: 'window is not a range' });
    const days = Math.round((to - from) / 864e5) + 1;
    if (days > 8) {
      return res.status(400).json({
        error: `window is ${days} days; this endpoint serves at most 8`,
        detail: 'a longer report outlives the gateway\'s 75s. Queue the audit job for whole months — it writes uber_trip_audit, which /api/coverage/verified reads.',
      });
    }
    const fleet = ['ecosine', 'egari'].includes(String(req.query.fleet)) ? String(req.query.fleet) : null;
    if (!uberOrgs(fleet).length) return res.status(400).json({ error: 'no Uber org configured' });

    const fleets = await auditTripWindow({ from, to, fleet });
    /* Totalled across fleets as well as reported per fleet, because the
       question a reader arrives with is about the window, not about an org,
       and a reader who has to add two numbers to get their answer will get it
       wrong on the audit that matters. */
    const num = (k) => fleets.reduce((a, f) => a + (Number(f[k]) || 0), 0);
    const measured = fleets.filter((f) => !f.error);
    res.json({
      window: [req.query.from, req.query.to], days, fleets,
      total: measured.length ? {
        uber: num('uber_rows_in_window'), ours: num('ours'),
        uber_only: num('uber_only'), ours_only: num('ours_only'),
        agreement_pct: num('uber_rows_in_window')
          ? Math.round(((num('uber_rows_in_window') - num('uber_only')) / num('uber_rows_in_window')) * 1000) / 10
          : null,
      } : null,
      /* Said in the response rather than left for the reader to infer: this
         verifies TRIPS, for ONE window. It says nothing about whether that
         window has money against it, and nothing at all about ratings, which
         Uber serves only as a current value with no history to check. */
      verifies: 'trips only, for this window, for the fleets listed',
    });
  }));

  app.get('/api/probe/uber/tier', wrap(async (req, res) => {
    await loadSettings();
    const org = uberOrg();
    if (!org.orgUuid) return res.status(400).json({ error: 'no Uber org configured' });

    let uuid = String(req.query.uuid || '').trim();
    if (!uuid) {
      const { rows } = await pool.query(
        `SELECT driver_ext_id FROM driver_platform_state
          WHERE platform = 'uber' AND fleet_id = $1
            AND coalesce(btrim(driver_ext_id), '') <> ''
          ORDER BY observed_at DESC NULLS LAST LIMIT 1`, [org.fleet]);
      uuid = rows[0]?.driver_ext_id || '';
    }
    if (!uuid) return res.json({ error: 'no uber driver uuid to ask about' });

    const GQL = `${UBER_WEB_HOST}/graphql`;
    const ask = async (query, variables) => {
      try {
        const { data } = await http(GQL, {
          method: 'POST', timeoutMs: 20000, retries: 0, headers: uberWebHeaders(org),
          body: JSON.stringify({ query, variables }),
        });
        return data;
      } catch (e) { return { transportError: String(e?.message || e).slice(0, 200) }; }
    };
    /* GraphQL puts the interesting part in `errors`, and an error object
       stringifies to [object Object] — the trap this codebase has already
       been caught by three times. */
    const errText = (d) => (d?.errors || []).map((e) => e?.message || JSON.stringify(e)).join(' | ');

    /* 1. Introspection. If it answers, nothing below is needed. */
    const introspection = {};
    /* SupplierUserEntity is the type the contact fields actually live on — the
       refusals name it — and PhoneNumber and UserName are the two objects
       hanging off it. Asking about 'User' was asking about a type this schema
       does not use for the driver's account. */
    for (const t of ['DriverInfo', 'Driver', 'User', 'SupplierUserEntity',
      'PhoneNumber', 'UserName']) {
      const d = await ask(`query I($n: String!) { __type(name: $n) { name fields { name } } }`, { n: t });
      const fields = d?.data?.__type?.fields;
      introspection[t] = fields ? fields.map((f) => f.name)
        : { refused: errText(d).slice(0, 160) || 'no such type' };
    }

    /* If the server described DriverInfo, every guess below is answered
       already and forty more requests would only confirm it more slowly. */
    const described = Array.isArray(introspection.DriverInfo) ? introspection : null;

    /* Does this server NAME the fields it does not have? Run the impossible
       names first, so every verdict below is read against a known no. */
    const NAMED = /Cannot query field|Unknown field|FieldUndefined|Unknown argument/i;
    const probeField = async (parent, field, selection = '') => {
      const d = await ask(driverQueryWith(parent, field + selection),
        { orgUUID: org.orgUuid, driverUUID: uuid });
      const err = errText(d);
      const got = d?.data?.getDriver?.driver;
      const value = got
        ? (parent === 'driver' ? got[field]
          : parent === 'user' ? got.member?.user?.[field]
            : got.member?.user?.driverInfo?.[field])
        : undefined;
      return {
        parent, field, selection: selection || null,
        named_absent: NAMED.test(err),
        answered: !err && !d?.transportError,
        value: value === undefined ? null : value,
        suggests: /Did you mean ([^?]+)\?/i.exec(err)?.[1] || null,
        note: (d?.transportError || err || '').slice(0, 200) || null,
      };
    };

    /* The positive control runs FIRST and gates everything. */
    const positive = described ? null : await probeField(POSITIVE_CONTROL[0], POSITIVE_CONTROL[1]);
    const sessionWorks = !!positive && positive.value != null;
    await new Promise((r) => setTimeout(r, 80));

    /* Does a bare object announce itself? The retry branch depends on it. */
    const bareObject = described || !sessionWorks
      ? null : await probeField(OBJECT_CONTROL[0], OBJECT_CONTROL[1]);
    const objectSignatureFires = /must have a selection of subfields/i.test(bareObject?.note || '');
    if (bareObject) await new Promise((r) => setTimeout(r, 80));

    /* And is the generic refusal about proximity rather than existence? */
    const nearMiss = described || !sessionWorks
      ? null : await probeField(NEAR_MISS_CONTROL[0], NEAR_MISS_CONTROL[1]);
    const genericMeansNearMiss = !!nearMiss && !nearMiss.named_absent;
    if (nearMiss) await new Promise((r) => setTimeout(r, 80));

    const controls = [];
    for (const [parent, field] of (described || !sessionWorks ? [] : CONTROL_FIELDS)) {
      controls.push(await probeField(parent, field));
      await new Promise((r) => setTimeout(r, 80));
    }
    /* The whole run's interpretation, in one boolean. */
    const namesItsAbsences = controls.length > 0 && controls.every((c) => c.named_absent);

    /* 2. One field at a time, and the ERROR is the payload. */
    /* WHICH fixed list, never which field. The caller picks a set by name and
       the names in it are all in this file, so this stays what the header
       promises: not an open GraphQL proxy onto the fleet's session. */
    const SETS = { tier: TIER_FIELDS, contact: CONTACT_FIELDS,
      subfields: CONTACT_SUBFIELDS, pairs: CONTACT_PAIRS, phone: PHONE_LAST,
      identity: IDENTITY_FIELDS, compliance: COMPLIANCE_SUB, documents: COMPLIANCE_DOCS,
      doctype: COMPLIANCE_DOC_TYPE };
    const wanted = SETS[String(req.query.set || 'tier')] || TIER_FIELDS;
    const fields = [];
    for (const [parent, field, sel] of (described || !sessionWorks ? [] : wanted)) {
      const r = await probeField(parent, field, sel);
      await new Promise((r2) => setTimeout(r2, 80));
      /* A field the server would not name, on a server that names its
         absences, is the only interesting outcome on this surface — and the
         likeliest reason for it is an object type asked for as a scalar. So
         ask again WITH a sub-selection, which is the question that separates
         "does not exist" from "exists and I asked wrongly". */
      /* Retried whenever the server would not name it, whatever the controls
         say about why. The controls decide how to read a REFUSAL; they cannot
         decide how to read an ANSWER, and a sub-selection that comes back with
         a __typename has proved the field exists on its own authority. */
      if (!r.named_absent && !r.answered && namesItsAbsences) {
        r.retry_with_selection = await probeField(parent, field, ' { __typename }');
        await new Promise((r2) => setTimeout(r2, 80));
      }
      fields.push({ ...r, selection: sel || null,
        exists: namesItsAbsences ? !r.named_absent : null });
    }

    /* 3. Whole operations, against the same control. PERMISSION_DENIED is a
       YES about existence; an unnamed refusal is only a YES if the server has
       just demonstrated that it names the operations it does not have. */
    const probeOp = async (name, args) => {
      const d = args
        ? await ask(`query Probe($orgUUID: ID!) { ${name}(orgUUID: $orgUUID) { __typename } }`,
          { orgUUID: org.orgUuid })
        : await ask(`query Probe { ${name} { __typename } }`, {});
      const err = errText(d);
      return { err, transport: d?.transportError || null, named: /Cannot query field|Unknown field/i.test(err) };
    };
    const control = described || !sessionWorks ? null : await probeOp(CONTROL_OP, true);
    const namesItsMissingOps = !!control?.named;

    const ops = [];
    /* Operations are a tier question; the contact set is about fields on a
       driver we already fetch, so it does not spend thirteen more requests. */
    for (const name of (described || !sessionWorks || wanted !== TIER_FIELDS ? [] : TIER_OPS)) {
      const withArg = await probeOp(name, true);
      await new Promise((r) => setTimeout(r, 80));
      /* An operation that exists but takes different arguments answers the
         argument-free form differently from one that does not exist at all,
         so the second shape is what separates them. */
      const bare = withArg.named ? null : await probeOp(name, false);
      if (bare) await new Promise((r) => setTimeout(r, 80));
      const denied = /PERMISSION_DENIED|UNAUTHENTICATED|FORBIDDEN/i.test(withArg.err + (bare?.err || ''));
      ops.push({
        operation: name,
        /* Four answers, and they lead four different places: absent means no
           credential will ever help; denied means the right login would;
           wrong-arguments means it is there and we have not found its shape;
           unnamed on a server that names things is the one worth chasing. */
        verdict: withArg.transport ? 'transport'
          : withArg.named && (!bare || bare.named) ? 'no such operation'
            : denied ? 'exists — denied to this session'
              : /Unknown argument|used in position expecting/i.test(withArg.err) ? 'exists — wrong arguments'
                : !withArg.err ? 'answered'
                  : namesItsMissingOps ? 'refused without naming it — worth chasing' : 'inconclusive',
        detail: (withArg.transport || withArg.err || '').slice(0, 200) || null,
        without_arguments: bare ? (bare.err || 'answered').slice(0, 160) : null,
      });
    }

    const found = fields.filter((f) => f.exists);
    res.json({
      driver: uuid, org: org.fleet,
      introspection,
      /* The control, stated before any verdict that depends on it. Without it
         "the server would not name this field" is a Rorschach blot. */
      control: {
        /* Stated first and checked first: a run against a dead session
           refuses everything, and thirty refusals read exactly like "Uber
           does not publish a tier" when they mean "we did not ask anybody". */
        positive: positive
          ? { field: 'driverInfo.recognitionRating', value: positive.value,
            session_works: sessionWorks, note: positive.note }
          : null,
        bare_object: bareObject
          ? { field: 'driver.complianceInfo', signature_fires: objectSignatureFires, note: bareObject.note }
          : null,
        /* The one that decides whether a generic refusal is evidence at all. */
        near_miss: nearMiss
          ? { field: 'driverInfo.recognitionRatingg', invented: true,
            refused_generically: genericMeansNearMiss, note: nearMiss.note }
          : null,
        generic_refusal_means: genericMeansNearMiss
          ? 'a near miss on a real name, scrubbed of its suggestion — NOT evidence the field exists'
          : 'unexplained; a generic refusal may be worth chasing',
        fields: controls, names_its_absent_fields: namesItsAbsences,
        operation: control ? { probe: CONTROL_OP, named: control.named, detail: (control.err || '').slice(0, 160) } : null,
        names_its_absent_operations: namesItsMissingOps,
      },
      /* Said plainly, because the three outcomes lead to three different next
         moves and a bare list of nulls reads as all of them at once. */
      verdict: described ? 'the schema described itself — read introspection[], which is the whole answer'
        : !sessionWorks
          ? 'VOID: the known-real field recognitionRating did not answer, so this session is not working '
            + 'and no refusal below would mean anything. Re-paste the supplier cookie and ask again.'
          : !namesItsAbsences ? 'inconclusive: this server does not name the fields it lacks, so a refusal proves nothing'
          : found.some((f) => f.value != null) ? 'a tier-like field answered — see fields[]'
            : found.some((f) => f.retry_with_selection?.answered)
              ? 'a field answered once asked with a sub-selection — see fields_that_exist[]'
              : found.length ? (genericMeansNearMiss
                ? 'no tier field. The ones the server would not name are near misses on real names, and '
                  + 'an invented control name got the same refusal — proximity, not existence'
                : 'fields the server would not name and no control explains why — worth chasing')
              : fields.some((f) => f.suggests) ? 'no candidate existed, but the schema suggested real names'
                : ops.some((o) => o.verdict.startsWith('exists') || o.verdict.startsWith('refused'))
                  ? 'no tier field on GetDriver, but an operation is there — see operations_that_exist[]'
                  : 'nothing on this surface names a driver tier, and the control proves the server would have said so',
      fields_that_exist: found,
      suggestions: [...new Set(fields.map((f) => f.suggests).filter(Boolean))],
      operations_that_exist: ops.filter((o) => o.verdict.startsWith('exists') || o.verdict.startsWith('refused')
        || o.verdict === 'answered'),
      fields, ops,
    });
  }));


  /* Is the FMS history actually gone, or did we ask for it wrongly?
     ─────────────────────────────────────────────────────────────────────────
     The record says six consecutive monthly windows covering August 2025 to
     February 2026 were asked and answered ok with zero rows, while every
     window after them returned thousands. That is the provider's answer as far
     as our collector can tell — but "returned an empty list" and "returned an
     empty list because the request was subtly wrong" are indistinguishable in
     a row count, and the difference decides whether five months of telematics
     are recoverable or gone.

     So this asks FMS the same question the collector asks, for a window the
     caller names, and reports the SHAPE of what comes back: the HTTP status,
     the top-level keys, how many records, and the field names of the first one.
     Same operation, same parameters, same credentials as the collector — a
     different answer here would mean the collector is at fault, and an
     identical empty one means the data is not there.

     Read-only: both operations are report endpoints, the name comes from a
     fixed allowlist rather than from the caller, and only the shape is
     returned.

     The alert operation is here because it is the one that fails. Every FMS
     run on record refused its alert window with HTTP 400 while the trip window
     beside it answered 200, and the fix — one-day windows, against a service
     ceiling measured at roughly 5,000 records and an alert feed running 4,248
     rows a day — could not be verified without a way to ask for a single
     alert day. Sending a multi-hour backfill to find out is not verification;
     it is hoping. */
  app.get('/api/probe/fms/window', wrap(async (req, res) => {
    await loadSettings();
    const from = String(req.query.from || '').slice(0, 10);
    const to = String(req.query.to || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'from and to are required as YYYY-MM-DD' });
    }
    /* An allowlist, not a passthrough: the caller chooses BETWEEN two named
       report operations and cannot name a third. */
    const OPS = { trips: 'GetTripPassenger', alerts: 'GetAlertData' };
    const op = OPS[String(req.query.op || 'trips')];
    if (!op) {
      return res.status(400).json({ error: `op must be one of ${Object.keys(OPS).join(', ')}` });
    }
    const dot = (d) => d.replace(/-/g, '.');
    const out = [];
    for (const f of (config.fms.fleets || [])) {
      if (!f.username || !f.password) { out.push({ fleet: f.fleet, skipped: 'no credential' }); continue; }
      try {
        const url = `${config.fms.base}/${op}?${qs({
          username: f.username, Password: f.password, vehicleno: 'ALL',
          fromdate: dot(from), todate: dot(to),
        })}`;
        const { status, data } = await http(url, { timeoutMs: 120000, retries: 0 });
        const arr = Array.isArray(data?.Data) ? data.Data : null;
        out.push({
          fleet: f.fleet,
          http: status,
          top_level_keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 20) : [],
          message: data?.Message || data?.message || data?.error || null,
          records: arr ? arr.length : null,
          /* Field NAMES only. A telematics row carries positions and a plate,
             which is the fleet's own data and does not need to leave here to
             answer whether the window is empty. */
          fields: arr && arr.length ? Object.keys(arr[0]).slice(0, 40) : [],
          first_start: arr && arr.length ? String(arr[0]['Start Time'] || '').slice(0, 19) : null,
        });
      } catch (e) { out.push({ fleet: f.fleet, error: String(e).slice(0, 220) }); }
    }
    res.json({ window: [from, to], operation: op, fleets: out });
  }));

  log.info('api', 'probe routes mounted (read-only, allowlisted)');
}
