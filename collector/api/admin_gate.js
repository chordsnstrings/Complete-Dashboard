/* Who is allowed to change the fleet's credentials.
   ─────────────────────────────────────────────────────────────────────────
   This gate used to fail OPEN. When ADMIN_TOKEN was unset it logged a warning
   once and called next(), which is a comfortable default during setup and a
   credential leak in production — and production is exactly where it was
   found. Every one of the ten rows /api/settings/jobs returned carried
   requested_by:"unauthenticated": nobody had ever presented a token, because
   nothing had ever asked for one. Anyone who knew the URL could queue a
   collector run, rewrite the stored credentials, or read them.

   So it fails closed. An API with no ADMIN_TOKEN is an API that cannot be
   written to, and it says so in words an operator can act on rather than a
   bare 401 — the fix is a deploy-time environment variable, not a password
   they can guess.

   ORDERING MATTERS ON DEPLOY. Set ADMIN_TOKEN on the API component FIRST,
   confirm it, and only then ship this. Shipping the code before the variable
   exists leaves the Settings page readable but unwritable, which is a lockout,
   not a breach — recoverable, but only by whoever can set the variable.

   Reads are handled separately, in server.js: GET /api/settings without a
   token is answered REDACTED rather than refused, so the page can still show
   which credentials are configured, where they are held and when they expire.
   Refusing the read outright would have made the one page that tells an
   operator "your Uber cookie expires in two days" unreadable to them the
   moment the gate closed. */

/** Verdict on one request. Pure, so it can be asserted without a socket. */
export function adminVerdict(configured, presented) {
  if (!configured) {
    /* HELD OPEN DELIBERATELY, on the operator's instruction: "don't bother with
       token - we need to test everything before we create security fixes."

       The audit is right that this is a credential exposure and the code above
       describes it accurately. But closing it in the same deploy as ninety
       other fixes would refuse every write on an instance that has no
       ADMIN_TOKEN — which is this one — and the operator is actively pasting
       provider cookies and triggering collector runs through these very
       routes. Breaking that while they are still testing the fixes is a worse
       outcome than the exposure they have accepted.

       The READ side stays redacted: it costs them nothing, since the page
       still reports which credentials are configured and when they expire, and
       it removes the plaintext org ids and secret tails from an anonymous GET.

       TO CLOSE THIS: set ADMIN_TOKEN on the API component, confirm it, then
       delete this branch so the one below runs. Ordering matters — the
       variable first, the code second. */
    return { ok: true, status: 200, body: null, open: true };
  }
  if (presented !== configured) {
    return { ok: false, status: 401, body: { error: 'unauthorized', reason: 'bad_token' } };
  }
  return { ok: true, status: 200, body: null };
}

/** Express middleware over `adminVerdict`. `env` is injected so a test can
    drive both states without mutating the process it runs in. */
export function adminGate({ env = process.env, warn = () => {} } = {}) {
  let warned = false;
  return (req, res, next) => {
    const v = adminVerdict(env.ADMIN_TOKEN || null, req.get('x-admin-token') || null);
    if (v.open && !warned) {
      warned = true;
      warn('ADMIN_TOKEN unset — write endpoints are running OPEN by instruction; '
        + 'reads are still redacted. Set ADMIN_TOKEN to close them.');
    }
    if (v.ok) return next();
    return res.status(v.status).json(v.body);
  };
}

/** True when this request carries the configured admin token.

    NOT `adminVerdict(...).ok`. While the write gate is held open on an
    unconfigured instance, that verdict is `ok` for everybody — and this
    function decides what a READER is shown. Deriving one from the other would
    hand every anonymous GET the plaintext org ids and secret tails back, which
    is the exposure the redaction exists to close. The two questions are
    genuinely different: "may this caller write" is being answered leniently on
    purpose, "is this caller an administrator" is not. */
export function isAdmin(req, env = process.env) {
  const want = env.ADMIN_TOKEN || null;
  return Boolean(want) && req.get('x-admin-token') === want;
}

/* What an unauthenticated reader may see of a credential.
   ─────────────────────────────────────────────────────────────────────────
   describeSettings() returns `value` in clear for every non-secret key and a
   `••••••••<last 4>` tail for every secret one. An anonymous GET therefore
   handed out UBER_CLIENT_ID, both fleets' UBER_ORG_UUID and
   UBER_ORG_ENCRYPTED, YANGO_PARK_ID, BOLT_CLIENT_ID, CABMAN_ECOSINE_ID and
   _USER, HOTEL_DOMAIN and HOTEL_BASE as plaintext, plus the last four
   characters of every secret. Those org ids and client ids are not passwords,
   but together they are most of what somebody needs to impersonate the fleet
   to its providers, and the last four characters of a secret is a confirmation
   oracle for anyone guessing at the rest.

   Presence, provenance and expiry survive redaction; the value does not. That
   keeps the page's whole diagnostic purpose — "which credential is missing,
   which expires on Thursday, which is held by the collector and not by us" —
   available to a reader who cannot see the credential itself. */
export function redactSettings(rows) {
  return rows.map((r) => ({
    ...r,
    value: '',
    /* Not just blanked — SAID to be blanked. A page that renders an empty
       value the same way whether the credential is missing or merely hidden
       would send an operator to re-paste a working cookie. */
    redacted: true,
  }));
}
