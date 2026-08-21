// fetch wrapper with timeout, retry + exponential backoff, and helpers.
// Node 18+ has global fetch. Honors HTTPS proxy CA if the runtime sets NODE_EXTRA_CA_CERTS.
import { log } from './log.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function http(url, { method = 'GET', headers = {}, body, timeoutMs = 60000,
                                  retries = 4, retryOn = [429, 500, 502, 503, 504], expect = 'json' } = {}) {
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
      return { status: res.status, ok: res.ok, data, headers: res.headers };
    } catch (err) {
      clearTimeout(t);
      if (attempt <= retries) {
        const wait = Math.min(2 ** attempt * 500, 16000);
        log.warn('http', `retry error ${err.name} ${url}`, { attempt, wait });
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }
}

export const qs = (o) => Object.entries(o)
  .filter(([, v]) => v !== undefined && v !== null)
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

export { sleep };
