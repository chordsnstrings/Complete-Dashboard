/* Does this credential actually work — before it replaces the one that does?
   ─────────────────────────────────────────────────────────────────────────
   Storing a credential and finding out on the next collector tick is the wrong
   order. The tick is up to fifteen minutes away, the old value is already
   gone, and what the operator sees in between is a dashboard that stopped
   updating for a reason nothing on screen explains. A pasted cookie that was
   copied from the wrong browser tab, or after the session had already been
   invalidated by a second login, fails exactly this way.

   So every candidate is tried against its own provider FIRST, with the value
   in hand rather than the value in the store, and only what answers is
   written. Three properties make that safe to run on demand:

     read-only    each check is the cheapest READ that requires authentication.
                  Nothing here creates, updates or deletes at the provider.
     scoped       the URL and body are fixed per provider. There is no
                  caller-supplied endpoint, so this cannot be turned into a
                  proxy onto the fleet's network.
     candidate    the value under test never touches the settings store, and
                  the check is a pure function of what was passed in. A failed
                  candidate leaves the working credential exactly where it was.

   The verdict is deliberately three-valued. `pass` and `fail` are obvious;
   `unknown` is for a provider that could not be reached at all — a DNS failure
   or a gateway timeout says nothing about the credential, and treating it as a
   failure would tell an operator to re-capture a cookie that is fine. */
import { config } from './config.js';
import { http } from './http.js';
import { get, SETTING_DEFAULTS } from './settings.js';
import { keyFor } from './credkit.js';
import { UBER_WEB_HOST } from './auth/uber.js';
import { dubaiIso } from './util.js';

/* The same host the collector uses, from the same export. This checker kept
   its own copy of the URL, so when Uber moved supplier.uber.com to fleethub
   the paste box went on probing the old host and REFUSED a perfectly good
   session — the page telling an operator their credential was dead was the
   last thing standing between them and a working collector. */
const REPORTS = `${UBER_WEB_HOST}/api/vs-sp-reports-management`;
/* The Dubai day. These bound a window asked of a provider whose reports are
   filed on the fleet's own calendar, and read as the UTC day the window was a
   day short for the four hours after 20:00 Dubai — the hours a credential
   check run from a nightly job would most often land in. A check that asks for
   the wrong day and is refused reports a working credential as dead, which is
   the one outcome this file's own header calls worse than no check at all. */
const day = (n) => dubaiIso(new Date(Date.now() - n * 864e5));

/* A network failure is not a credential failure. */
const unreachable = (e) => /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|abort|socket hang up|network/i
  .test(String(e && e.message ? e.message : e));

const verdict = (ok, detail) => ({ verdict: ok ? 'pass' : 'fail', detail });

/* ── Uber: does this session answer for the org it claims? ──────────────
   GenerateReport is the cheapest authenticated read on the supplier surface,
   and it is org-scoped — which is the property that matters here. A cookie
   for the wrong organisation does not fail to authenticate; it authenticates
   as the OTHER business. Passing the org uuid the credential itself declared
   and requiring success is what catches that. */
async function checkUber({ value, org_uuid }) {
  if (!org_uuid) return { verdict: 'fail', detail: 'no organisation in the session cookie' };
  try {
    const { data, status } = await http(`${REPORTS}/GenerateReport?localeCode=en-GB`, {
      method: 'POST', timeoutMs: 30000, retries: 0,
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'x', cookie: value },
      body: JSON.stringify({
        orgId: { uuid: { value: org_uuid } },
        reportType: 'REPORT_TYPE_DRIVER_ACTIVITY',
        startDate: { value: day(1) }, endDate: { value: day(0) },
        childOrgUuids: [{ uuid: { value: org_uuid } }],
      }),
    });
    if (data?.status === 'success') return verdict(true, `the supplier API accepted this session for org ${org_uuid}`);
    /* A redirect to the login page is what an expired session looks like from
       here — the status is 200 and the body is HTML. */
    if (typeof data === 'string' && /login|sign in/i.test(data)) {
      return verdict(false, 'the session is no longer signed in — re-capture from a logged-in fleethub.uber.com tab');
    }
    return verdict(false, String(JSON.stringify(data?.data?.meta?.details || data?.data || data || status)).slice(0, 200));
  } catch (e) {
    if (unreachable(e)) return { verdict: 'unknown', detail: `${UBER_WEB_HOST.replace('https://', '')} could not be reached: ${String(e.message).slice(0, 120)}` };
    return verdict(false, String(e.message || e).slice(0, 200));
  }
}

/* ── Bolt: does this refresh token still mint an access token? ──────────── */
async function checkBolt({ value, fleet }) {
  const company = (config.bolt.companies || []).find((c) => c.fleet === fleet);
  if (!company) return { verdict: 'fail', detail: `no Bolt company is configured for ${fleet}` };
  try {
    const { data } = await http(`${config.bolt.portalBase}/getAccessToken?language=en-us&version=FO.3.856&brand=bolt`, {
      method: 'POST', timeoutMs: 30000, retries: 0,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: value, company: { company_id: company.companyId, company_type: 'fleet_company' } }),
    });
    const at = data?.data?.access_token || data?.access_token;
    if (at) return verdict(true, `the portal minted an access token for company ${company.companyId}`);
    return verdict(false, String(data?.message || data?.error_data?.hint || JSON.stringify(data)).slice(0, 200));
  } catch (e) {
    if (unreachable(e)) return { verdict: 'unknown', detail: `the Bolt portal could not be reached: ${String(e.message).slice(0, 120)}` };
    return verdict(false, String(e.message || e).slice(0, 200));
  }
}

/* ── Yango: does this session list anything? ───────────────────────────── */
async function checkYango({ value }) {
  if (!config.yango.parkId || !config.yango.apiKey) {
    return { verdict: 'unknown', detail: 'YANGO_PARK_ID and YANGO_API_KEY must be set before a cookie can be tested' };
  }
  /* The endpoint the COLLECTOR calls, with the headers it sends.
     ─────────────────────────────────────────────────────────────────────
     A check that picks its own endpoint tests its own choice. The first
     version of this asked /api/v1/parks/orders/list and got a 403 for a
     cookie the collector was using successfully at that moment — a false
     failure, which is the one outcome worse than no check: it tells an
     operator to go and re-capture a session that is fine. */
  const day = (n) => dubaiIso(new Date(Date.now() - n * 864e5));
  /* Three credentials ride on every Yango request — the park id, the API key
     and the cookie — so a refusal names none of them. Asking once cannot tell
     them apart; asking twice can. */
  const ask = (cookie) => http(`${config.yango.base}/api/reports-api/v1/orders/list`, {
    method: 'POST', timeoutMs: 30000, retries: 0,
    headers: {
      'X-Park-Id': config.yango.parkId, 'X-API-Key': config.yango.apiKey,
      'content-type': 'application/json', 'Accept-Language': 'en',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({
      date_type: 'booked_at',
      date_from: `${day(1)}T00:00:00+04:00`, date_to: `${day(0)}T23:59:59+04:00`,
    }),
  });
  try {
    const { data, status } = await ask(value);
    if (status === 401 || status === 403) {
      /* The false failure this function's own header warns about, committed
         one screen below it.
         ───────────────────────────────────────────────────────────────────
         Measured 2026-09-02: this endpoint answers 403 with a byte-identical
         body when the cookie header is omitted ENTIRELY. So a 403 here is not
         evidence about the cookie, and telling an operator to go back to a
         logged-in fleet.yango.com tab and re-capture a session is telling them
         to do work that cannot change the answer — which is exactly what the
         product had been saying.

         One extra request settles it: if the refusal is the same without the
         cookie, the cookie is not what is being refused. */
      const bare = await ask(null).catch(() => null);
      if (bare && bare.status === status) {
        return verdict(false, `the portal refuses this park with or without a session (${status}), `
          + 'so the cookie is not what it is rejecting — check YANGO_PARK_ID and YANGO_API_KEY, '
          + `whose park is ${config.yango.parkId}`);
      }
      /* The comparison is reported, not just its verdict: a check that says
         "refused" without saying what it compared against is the same
         unfalsifiable claim this block replaced. */
      if (bare) return verdict(false, `the fleet portal refused this session (${status}), `
        + `where the same call without a cookie answers ${bare.status} — so the session is being read`);
      return { verdict: 'unknown',
        detail: `the portal refused (${status}), and the cookie-free comparison did not complete, `
          + 'so this does not establish which of the park id, the API key and the cookie is being refused' };
    }
    /* `orders` present — even empty — is the portal answering as this park. */
    if (data && typeof data === 'object' && Array.isArray(data.orders)) {
      return verdict(true, `the fleet portal answered for park ${config.yango.parkId}`);
    }
    if (data && typeof data === 'object') return verdict(true, 'the fleet portal answered with this session');
    return verdict(false, String(status || 'no answer').slice(0, 200));
  } catch (e) {
    if (unreachable(e)) return { verdict: 'unknown', detail: `fleet.yango.com could not be reached: ${String(e.message).slice(0, 120)}` };
    return verdict(false, String(e.message || e).slice(0, 200));
  }
}

/* ── Uber: does this OAuth application work, and whose is it? ────────────
   The only check here that ANSWERS a question rather than confirming one.

   Every other credential arrives already named: a Bolt token carries its
   fleet owner id, an Uber cookie carries its org uuid, so the recogniser
   decides the key and the check merely proves the credential still works. An
   OAuth application carries nothing — two opaque strings — so the recogniser
   deliberately refuses to guess, and this does the asking:

     1. grant a token, trying the labelled order and then the other one,
        because "client id" and "client secret" are not reliably told apart by
        looking at them;
     2. ask /v1/vehicle-suppliers/orgs, the one REST surface that takes no
        org_id and therefore the only one that can say what a valid org_id is;
     3. name the fleet from what came back, and hand up THREE keys — the id,
        the secret, and the organisation.

   Step 3 is why this exists in this shape. An application is registered under
   one organisation, so the org that comes back IS the fleet, and the encrypted
   id in that answer is exactly the string UBER_ORG_ENCRYPTED wants. This
   fleet's Egari half was 403ing on every REST call with a correct new client
   installed, because the org id stored beside it still belonged to the old
   one. A paste that sets two of the three leaves that trap armed. */
const UBER_SCOPE = 'solutions.suppliers.metrics.read solutions.suppliers.drivers.status.read '
  + 'supplier.partner.payments vehicle_suppliers.organizations.read '
  + 'vehicle_suppliers.vehicles.read solutions.suppliers.reports';

async function grant(clientId, clientSecret) {
  const { data, status } = await http(config.uber.oauth.tokenUrl, {
    method: 'POST', timeoutMs: 30000, retries: 0,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      grant_type: 'client_credentials', scope: UBER_SCOPE,
    }).toString(),
  });
  return { token: data?.access_token || null, status,
    error: String(data?.error_description || data?.error || '').slice(0, 160) };
}

/* Which fleet an organisation belongs to, in descending order of how much it
   is being trusted to a guess. */
function fleetOfOrg(org) {
  const id = String(org?.id || '');
  const name = String(org?.name || '');
  /* Exact: the encrypted id already configured for a fleet. Costs nothing and
     is the only branch with no judgement in it. */
  if (id && id === String(get('UBER_ORG_ENCRYPTED') || '')) return { fleet: 'ecosine', how: 'its org id is the one already stored for ecosine' };
  if (id && id === String(get('UBER_ORG_ENCRYPTED_EGARI') || '')) return { fleet: 'egari', how: 'its org id is the one already stored for egari' };
  /* The business's own name. "Egari Luxury Cars Transport LLC" and "ECOSINE
     TRANSPORTS" are what Uber calls these two, and a fleet id that appears in
     the name it is registered under is not a coincidence. */
  for (const fleet of ['ecosine', 'egari']) {
    if (name.toLowerCase().includes(fleet)) return { fleet, how: `Uber calls this organisation “${name}”` };
  }
  return { fleet: null, how: null };
}

async function checkUberOAuth({ value, secret, said_fleet: said }) {
  try {
    /* The labelled order first, then the other one. A pair that grants either
       way round is still one working application. */
    let id = value, sec = secret, g = await grant(id, sec);
    if (!g.token) {
      const swapped = await grant(secret, value);
      if (swapped.token) { [id, sec] = [secret, value]; g = swapped; }
      else {
        return verdict(false, `Uber refused this application either way round${
          g.error ? ` — ${g.error}` : ` (${g.status})`}`);
      }
    }

    const { data, status } = await http(get('UBER_ORGS_URL', SETTING_DEFAULTS.UBER_ORGS_URL), {
      headers: { authorization: `Bearer ${g.token}` }, timeoutMs: 20000, retries: 0,
    });
    const orgs = data?.organizations || data?.orgs || [];
    if (!Array.isArray(orgs) || !orgs.length) {
      /* A token that grants but reaches no organisation is an application
         nobody has given access to yet — a real state, and a different errand
         from a wrong secret. */
      return verdict(false, `the application authenticates but reaches no organisation (${status})`
        + ' — it has not been granted access to a supplier org yet');
    }
    if (orgs.length > 1) {
      return { verdict: 'fail',
        detail: `this application reaches ${orgs.length} organisations (${
          orgs.map((o) => o.name).filter(Boolean).join(', ')}), so it cannot be filed against one fleet` };
    }

    const org = orgs[0];
    const { fleet, how } = fleetOfOrg(org);
    if (!fleet) {
      return { verdict: 'fail',
        detail: `this application works, and reaches “${org.name || org.id}” — an organisation `
          + 'that matches neither configured fleet, so nothing has been written' };
    }
    if (said && said !== fleet) {
      /* The paste said one thing and Uber said another. Uber wins, and the
         disagreement is reported rather than quietly resolved: a label that
         is wrong about which business a credential belongs to is worth an
         operator's attention even when the outcome is right. */
      return { verdict: 'fail',
        detail: `this paste is labelled ${said}, but the application reaches “${org.name}” `
          + `(${fleet}). Nothing has been written — relabel the paste, or check you copied the right application.` };
    }

    /* Resolved through the catalogue, NOT by appending the fleet.
       ─────────────────────────────────────────────────────────────────────
       The per-fleet suffix is not one convention, and inventing it here got
       it wrong exactly the way credkit's own note says it always does:
       Egari's keys are UBER_CLIENT_ID_EGARI and friends, and Ecosine's are
       the BARE names — there is no UBER_CLIENT_ID_ECOSINE, src/config.js
       never reads one, and setSetting throws on a key the catalogue does not
       declare. So an Ecosine application would have passed its grant, told
       the operator the provider accepted it, and then 500'd on write. */
    const keys = {
      [keyFor('UBER_CLIENT_ID', fleet)]: id,
      [keyFor('UBER_CLIENT_SECRET', fleet)]: sec,
      [keyFor('UBER_ORG_ENCRYPTED', fleet)]: org.id,
    };
    /* keyFor returns null for a base the catalogue does not know at all. A
       credential that cannot be filed is refused here rather than half-written
       three lines later. */
    if (Object.keys(keys).some((k) => k === 'null' || !k)) {
      return { verdict: 'fail',
        detail: `this application belongs to ${fleet}, and this dashboard has no settings to file `
          + 'an Uber OAuth application for that fleet' };
    }
    return {
      verdict: 'pass',
      fleet,
      /* Three keys from one credential, because an application without the
         organisation it is registered under is two thirds of a working
         configuration and 403s exactly like a broken one. */
      keys,
      account: org.name || null,
      detail: `Uber granted a token and this application reaches one organisation, “${org.name}” — ${how}`,
    };
  } catch (e) {
    if (unreachable(e)) return { verdict: 'unknown', detail: `Uber could not be reached: ${String(e.message).slice(0, 120)}` };
    return verdict(false, String(e.message || e).slice(0, 200));
  }
}

const CHECKS = { Uber: checkUber, Bolt: checkBolt, Yango: checkYango };
/* Which check belongs to which KEY. The provider map above is the fallback for
   a credential that named itself by shape; this is what a credential the
   operator labelled is routed on, because "Yango" does not say whether the
   thing in hand is a session or an API key and the two are tested nothing
   alike. Only the keys whose check actually tests THAT credential appear. */
const BY_KEY = {
  YANGO_COOKIE: checkYango,
  UBER_WEB_COOKIE: checkUber,
  UBER_WEB_COOKIE_EGARI: checkUber,
  BOLT_REFRESH_TOKEN: checkBolt,
  BOLT_REFRESH_TOKEN_ECOSINE: checkBolt,
  BOLT_REFRESH_TOKEN_EGARI: checkBolt,
};

/** Test one recognised candidate. Never stores, never mutates. */
export async function checkCandidate(cand) {
  /* An OAuth application is the one credential that arrives WITHOUT a key,
     on purpose: which key it belongs in is the question the check answers.
     Routed on kind before the key test below, which every other candidate
     must still pass. */
  if (cand?.ok && cand.kind === 'oauth' && cand.provider === 'Uber') {
    return { ...cand, ...(await checkUberOAuth(cand)) };
  }
  if (!cand?.ok || !cand.key) {
    return { ...cand, verdict: 'fail', detail: cand?.why || 'this credential could not be named' };
  }
  /* Routed on the KEY where one exists, not only on the provider.
     ─────────────────────────────────────────────────────────────────────
     checkYango tests a COOKIE — it puts cand.value into the cookie header. So
     any candidate whose provider is Yango went there, and a YANGO_API_KEY sent
     through it would be pasted into a cookie jar and reported as a dead
     session. The check that runs has to match the credential, and the
     credential is the key.

     A key with no check of its own is 'unknown', not 'fail': "we cannot test
     this one" and "this one is broken" are different answers, and only one of
     them should stop an operator from saving it. */
  const fn = BY_KEY[cand.key] || (cand.labelled ? null : CHECKS[cand.provider]);
  if (!fn) {
    return { ...cand, verdict: 'unknown',
      detail: cand.key && !BY_KEY[cand.key]
        ? `no live check exists for ${cand.key} — it will be saved as given and tested by the next run`
        : `no live check exists for ${cand.provider}` };
  }
  const r = await fn(cand);
  return { ...cand, ...r };
}

/** Test every candidate, in parallel — they are separate providers. */
export const checkAll = (cands) => Promise.all(cands.map(checkCandidate));

export const PROVIDERS_CHECKED = Object.keys(CHECKS);
