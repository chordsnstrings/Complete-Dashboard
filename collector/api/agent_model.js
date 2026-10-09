/* THE ASSISTANT'S MODEL — Seed 2.0 Pro, then Seed 2.0 Lite, then an honest
   "cannot reach it".
   ──────────────────────────────────────────────────────────────────────────
   The operator's choices (2026-10-09): Seed 2.0 Pro on BytePlus ModelArk;
   GLM 5.2 is "extremely slow" and is not a fallback. Measured that day with
   the assistant's own tools, thinking off: Pro 1.9–3.1 s a step, Lite 1.6–3.1
   s, both asking "which Khalid?" when two were offered and both writing
   placeholders rather than digits — so Lite is a fallback that behaves the
   same, not a degraded mode that guesses.

   One retry on Pro, then Lite. A 401/403 is the KEY, which both models share,
   so it is not retried on the other: it is reported as the key, because "the
   assistant is busy" would send somebody to wait for a thing that will not
   change. The answer says which model wrote it whenever it was not Pro.

   Thinking is off: it tripled the time to the first tool call (6.8 s against
   2.4 s) for a planning step the tools already constrain. */
import { config, loadSettings } from '../src/config.js';

const TIMEOUT_MS = 45_000;

export function agentConfig() {
  return config.agentModel;
}

/**
 * @param {{messages:object[], tools?:object[], http?:Function, cfg?:object}} o
 * @returns {Promise<{message:object, model:string, fallback:boolean, ms:number}>}
 */
export async function callModel({ messages, tools, http = fetch, cfg = null, signal = null }) {
  await loadSettings().catch(() => {});
  const c = cfg || agentConfig();
  if (!c.apiKey) {
    const e = new Error('no model key is set (AGENT_API_KEY, or REPORT_MODEL_API_KEY / ARK_API_KEY)');
    e.code = 'no_key';
    throw e;
  }
  const plan = [c.model, c.model, c.fallback].filter(Boolean);
  let last = null;
  for (let i = 0; i < plan.length; i += 1) {
    const model = plan[i];
    const t0 = Date.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    signal?.addEventListener?.('abort', onAbort);
    try {
      const res = await http(`${String(c.baseUrl).replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal: ctl.signal,
        headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, temperature: 0.1, max_tokens: 1800,
          thinking: { type: 'disabled' } }),
      });
      const status = res.status;
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      if (status === 401 || status === 403) {
        const e = new Error(`the model key was refused (${status})`);
        e.code = 'key';
        throw e;
      }
      if (status >= 400 || !data?.choices?.[0]?.message) {
        last = new Error(`${model} answered ${status}${data?.error?.message ? `: ${String(data.error.message).slice(0, 120)}` : ''}`);
        continue;
      }
      return { message: data.choices[0].message, model, fallback: model !== c.model, ms: Date.now() - t0,
        usage: data.usage || null };
    } catch (e) {
      if (e.code === 'key' || e.code === 'no_key') throw e;
      if (signal?.aborted) { const a = new Error('the request was cancelled'); a.code = 'cancelled'; throw a; }
      last = new Error(`${model}: ${e.name === 'AbortError' ? `no answer in ${TIMEOUT_MS / 1000} s` : String(e.message || e).slice(0, 120)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }
  const e = new Error(last ? last.message : 'no model answered');
  e.code = 'unreachable';
  throw e;
}
