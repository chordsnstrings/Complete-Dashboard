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

const REPORTS = 'https://supplier.uber.com/api/vs-sp-reports-management';
const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

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
      return verdict(false, 'the session is no longer signed in — re-capture from a logged-in supplier.uber.com tab');
    }
    return verdict(false, String(JSON.stringify(data?.data?.meta?.details || data?.data || data || status)).slice(0, 200));
  } catch (e) {
    if (unreachable(e)) return { verdict: 'unknown', detail: `supplier.uber.com could not be reached: ${String(e.message).slice(0, 120)}` };
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
  try {
    const { data, status } = await http(`${config.yango.base}/api/v1/parks/orders/list`, {
      method: 'POST', timeoutMs: 30000, retries: 0,
      headers: {
        'X-Park-Id': config.yango.parkId, 'X-API-Key': config.yango.apiKey,
        'content-type': 'application/json', 'Accept-Language': 'en', cookie: value,
      },
      body: JSON.stringify({ query: { park: { id: config.yango.parkId } }, limit: 1 }),
    });
    if (status === 401 || status === 403) return verdict(false, `the fleet portal refused this session (${status})`);
    if (data && typeof data === 'object') return verdict(true, 'the fleet portal answered with this session');
    return verdict(false, String(status || 'no answer').slice(0, 200));
  } catch (e) {
    if (unreachable(e)) return { verdict: 'unknown', detail: `fleet.yango.com could not be reached: ${String(e.message).slice(0, 120)}` };
    return verdict(false, String(e.message || e).slice(0, 200));
  }
}

const CHECKS = { Uber: checkUber, Bolt: checkBolt, Yango: checkYango };

/** Test one recognised candidate. Never stores, never mutates. */
export async function checkCandidate(cand) {
  if (!cand?.ok || !cand.key) {
    return { ...cand, verdict: 'fail', detail: cand?.why || 'this credential could not be named' };
  }
  const fn = CHECKS[cand.provider];
  if (!fn) return { ...cand, verdict: 'unknown', detail: `no live check exists for ${cand.provider}` };
  const r = await fn(cand);
  return { ...cand, ...r };
}

/** Test every candidate, in parallel — they are separate providers. */
export const checkAll = (cands) => Promise.all(cands.map(checkCandidate));

export const PROVIDERS_CHECKED = Object.keys(CHECKS);
