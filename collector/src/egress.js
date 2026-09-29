/* The address this process's requests leave from, asked once per process.
   ─────────────────────────────────────────────────────────────────────────
   Yandex's edge refuses fleet.yango.com from this app and not from another
   network with the same cookie bytes (measured 2026-09-22), and the one
   window after 2026-09-06 when the console answered sat inside a single
   deployment — 2026-09-12, on bce22f4f. App Platform has no fixed egress
   (app.spec.egress is null), so every deploy can leave from a different
   address, and nothing recorded which address any console answer came from.
   The question "does the edge refuse every address this app gets, or only
   some?" was therefore unanswerable from records, and a success window, if one
   comes, would say nothing about why.

   So a console result is filed with the address it was asked from. Asked of
   two independent services, as /api/probe/tesla/egress does, because one of
   them being down would look exactly like having no answer; cached for the
   life of the process, because an App Platform container keeps its address
   until it is replaced and a redeploy starts a new process anyway. A failure
   is cached for ten minutes only, so a lookup that fails once is tried again. */
import { http as realHttp } from './http.js';

const SERVICES = [
  ['ipify', 'https://api.ipify.org?format=json'],
  ['aws', 'https://checkip.amazonaws.com'],
];
const IP = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,39}$/i;
let cached = null; // { address, at, failed }

/** The egress address as text, or null when neither service answered. Never
    throws: an unknown address must not cost the result it was going to sit
    beside. */
export async function egressAddress({ http = realHttp, now = Date.now() } = {}) {
  if (cached && (!cached.failed || now - cached.at < 10 * 60e3)) return cached.address;
  for (const [, url] of SERVICES) {
    try {
      const r = await http(url, { timeoutMs: 8000, retries: 0, expect: 'text' });
      const raw = typeof r.data === 'string' ? r.data : r.data?.ip;
      const text = String(raw ?? '').trim();
      /* ipify answers JSON even when asked for text, and a proxy answers with
         a page: only something shaped like an address is kept. */
      const address = (/^\{/.test(text) ? (() => { try { return JSON.parse(text).ip; } catch { return ''; } })() : text);
      if (r.ok && IP.test(String(address))) {
        cached = { address: String(address), at: now, failed: false };
        return cached.address;
      }
    } catch { /* the next service, then null */ }
  }
  cached = { address: null, at: now, failed: true };
  return null;
}

/** For tests: forget the cached address. */
export const forgetEgress = () => { cached = null; };
