// fetch wrapper with timeout, retry + exponential backoff, and helpers.
// Node 18+ has global fetch. Honors HTTPS proxy CA if the runtime sets NODE_EXTRA_CA_CERTS.
import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* WHAT NODE CALLS ITSELF, AND WHY THAT IS A PROBLEM.
   ──────────────────────────────────────────────────────────────────────────
   Node's global fetch sends `user-agent: node` and `sec-fetch-mode: cors`
   unless told otherwise — measured, not assumed. The first is a published
   automated-client signature and the second is a browser header that makes no
   sense from a server, and edge providers score both. Every request this
   product makes to every provider carried them.

   So a real name is sent instead, identifying the application rather than the
   runtime. A caller may still override it; nothing here forces it. This is
   not a workaround for one provider — it is what a well-behaved API client
   sends, and `node` is what a client sends when nobody has thought about it. */
const UA = 'ecosine-fleet-dashboard/1.0 (+https://fleet-dashboard-wpeqb.ondigitalocean.app)';

export async function http(url, { method = 'GET', headers = {}, body, timeoutMs = 60000,
                                  retries = 4, retryOn = [429, 500, 502, 503, 504], expect = 'json' } = {}) {
  /* Case-insensitively, because a caller that already set one must win and
     HTTP header names are not case sensitive. */
  if (!Object.keys(headers).some((h) => h.toLowerCase() === 'user-agent')) {
    headers = { ...headers, 'user-agent': UA };
  }
  let attempt = 0;
  for (;;) {
    attempt++;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, headers, body, signal: ctl.signal });
      clearTimeout(t);
      if (retryOn.includes(res.status) && attempt <= retries) {
        const wait = Math.min(2 ** attempt * 500, 16000);
        log.warn('http', `retry ${res.status} ${url}`, { attempt, wait });
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      let data = text;
      if (expect === 'json') { try { data = JSON.parse(text); } catch { /* leave as text */ } }
      /* A refusal that nobody checks is a silent hole.
         ─────────────────────────────────────────────────────────────────────
         This resolves for any status — which is right, because some callers
         need to read a 4xx body — but no collector was checking. A provider
         answering 400 therefore arrived with no records under the key the
         mapper reads, fell through `data?.X || []`, and was recorded as a
         window that was asked and answered with nothing. FMS did exactly that
         for six months of 2025 while still serving those months on request,
         and the Collection gaps page reported the hole as the provider's.

         The control flow is deliberately unchanged: making this throw would
         alter the error semantics of nine collectors at once, and each of them
         needs exercising against its own provider before that is safe. What
         changes is that a refusal can no longer pass without saying so, in any
         of them, which is what let this one hide. */
      if (!res.ok) {
        /* 600, not 160. An edge provider's refusal is an HTML page whose only
           useful content — the rule reference that says WHY — sits past the
           first 160 characters, so the truncation kept exactly the boilerplate
           and dropped the diagnosis. That cost a round trip through the logs
           on a Tesla 403 that turned out to be an edge block rather than a
           credential problem. */
        log.warn('http', `${res.status} ${String(url).split('?')[0]}`,
          { status: res.status, body: String(text).slice(0, 600) });
      }
      /* finalUrl and redirected, because fetch follows redirects silently and
         by the time a caller sees the response the 302 is gone. A provider
         that answers a data request by bouncing you to a login page is the
         only evidence there is that a session has expired — see
         src/auth_state.js for what that cost before anyone looked. */
      return { status: res.status, ok: res.ok, data, headers: res.headers,
        finalUrl: res.url, redirected: res.redirected };
    } catch (err) {
      clearTimeout(t);
      if (attempt <= retries) {
        const wait = Math.min(2 ** attempt * 500, 16000);
        log.warn('http', `retry error ${err.name} ${url}`, { attempt, wait });
        await sleep(wait);
        continue;
      }
      /* `TypeError: fetch failed` names nothing. undici puts the real reason —
         ENOTFOUND, ECONNREFUSED, a TLS failure, a timeout — on err.cause, and
         every caller that logs String(err) throws it away.
         ─────────────────────────────────────────────────────────────────────
         Measured 2026-09-02: the calendar feed had been dead since 08-31 and
         once the run finally reported it, all it could say was "hijri 2026-09:
         TypeError: fetch failed" — for a host that answers 200 in 0.5s from
         outside the app. Two days of a silent gap became a message that could
         not be acted on either. The cause is attached rather than replacing
         the error, so nothing that matches on err.name changes behaviour. */
      const why = err?.cause?.code || err?.cause?.message;
      if (why && !String(err.message).includes(why)) {
        err.message = `${err.message} (${String(why).slice(0, 120)}) ${url.split('?')[0]}`;
      }
      throw err;
    }
  }
}

export const qs = (o) => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

export { sleep };
