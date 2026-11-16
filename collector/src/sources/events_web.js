/* The web tier of the events layer: what is COMING UP in Dubai, found by a
   model that searched the web for it (EVW, 2026-11-16).
   ═══════════════════════════════════════════════════════════════════════════
   WHY IT EXISTS. The three tiers in events.js look backwards or at the
   calendar: seasons and Ramadan are arithmetic, and the GDELT tier reads a
   week of headlines that have already happened. None of them knows that a
   stadium concert, a trade show at the World Trade Centre or a road closure
   for a marathon is on next Saturday — and those are the evenings a ride
   fleet is either positioned for or is not. The operator asked for "modelark
   to search on google and use that as a direction". This is that direction.

   WHAT IT IS NOT. A search result read by a model is a LEAD. Every row this
   file writes carries source 'web', the model's own confidence, and — where
   the search's own citations carry it — the page it was found on. #causes
   prints "found by web search — a direction, not a measurement" over them.
   Nothing here is a measurement of demand, and nothing downstream may treat
   it as one.

   HOW IT ASKS. BytePlus ModelArk's Responses API with its built-in web_search
   tool. MEASURED 2026-11-16 on https://ark.ap-southeast.bytepluses.com/api/v3:
     · POST /responses, tools [{type:'web_search'}], thinking disabled →
       HTTP 403 {"error":{"code":"AccessDenied","message":"The request failed
       because you do not have access to the built in tool. …","type":
       "Forbidden"}} — the tool exists on the Responses API and is refused
       until it is switched on for the account in the BytePlus console;
     · POST /chat/completions with the same tool → 400 MissingParameter
       tools.function: chat completions does not offer it.
   So this is the one caller in the collector on /responses rather than
   /chat/completions, and the request shape is EXACTLY the measured one —
   model, input, tools [{type:'web_search'}], thinking — with no extra field
   (max_output_tokens, tool options, user_location) that was never sent to
   that endpoint and could turn a working call into a 400.

   WHEN IT CANNOT RUN, IT SAYS WHY — and only the true why. A 403 that names
   the built-in tool is the console switch; any other 403 is quoted verbatim,
   because "AccessDenied" also covers a model the account has not activated,
   and telling the operator to flip the wrong switch is the failure this
   product exists to avoid. The outcome is written as its own collection_run
   row (source 'events', mode 'web'), so /api/status carries it under the
   events source and it survives the thirty-minute incremental runs that do
   not search; /api/events/web hands the same row to #causes.

   HOW OFTEN. Once a Dubai day when it worked; again after six hours when it
   did not (a console switch flipped at 10:00 should not wait for tomorrow,
   and a refused call costs nothing — but a timeout may have been billed, so
   failure is not retried every thirty minutes either). The operator's note
   relayed with this task: the allowance is 4,000 credits a day and live usage
   comes back in X-Rate-Limit-Remaining. One call a day is far inside that;
   the header is recorded on every row when the response carries it, so the
   first real run shows whether ModelArk sends it at all. */
import { config, thinkingSwitch } from '../config.js';
import { http } from '../http.js';
import { pool, upsertMany, logRun } from '../db.js';
import { lastJsonArray } from '../analyst.js';
import { dubaiIso } from '../util.js';
import { log } from '../log.js';

const SRC = 'events';
export const WEB_MODE = 'web';
/* 21 calendar days including today: today .. today+20. */
export const WEB_WINDOW_DAYS = 21;
const TIMEOUT_MS = 150000;
const RETRY_FAILED_AFTER_MS = 6 * 3600e3;
const KEY = ['source', 'code', 'starts_on', 'title'];

export const CATEGORIES = ['concert', 'sports', 'conference', 'exhibition', 'festival', 'holiday',
  'closure', 'disruption', 'other'];
export const EFFECTS = ['demand_up', 'demand_down', 'unknown'];

/* The reasons, word for word, because #causes and /api/status print them and
   a test holds them to the cause each one names. */
export const REASON = {
  accessDenied: 'ModelArk’s built-in web search is not enabled for this account — an account owner switches it on in the BytePlus console',
  noModel: 'no model configured — neither ANALYST_API_KEY nor ARK_API_KEY is set for the collector, so nothing can search the web',
  notArk: (host) => `the analyst model’s endpoint is ${host || 'not a valid URL'}, not BytePlus ModelArk — `
    + 'the built-in web search this tier uses is offered only on ModelArk’s Responses API',
};

/* ModelArk on either region's host — the hostname, never a substring of the
   whole URL (the lesson thinkingSwitch's test pins). MiniMax takes the
   thinking switch but has no built-in web search, so it is not ModelArk. */
export const isModelArk = (baseUrl) => {
  let host = '';
  try { host = new URL(String(baseUrl || '')).hostname.toLowerCase(); } catch { return false; }
  return ['bytepluses.com', 'volces.com'].some((d) => host === d || host.endsWith(`.${d}`));
};

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && addDays(s, 0) === s;   // 2026-02-30 round-trips to 2026-03-02 and is refused

/* The Dubai window this run asks about. */
export function webWindow(now = new Date()) {
  const from = dubaiIso(now);
  return { from, to: addDays(from, WEB_WINDOW_DAYS - 1) };
}

export function webPrompt({ from, to }) {
  return `Search the web for public events in Dubai, UAE between ${from} and ${to} (both inclusive) that would move demand for taxis and ride-hailing: concerts, sports fixtures, conferences and exhibitions, festivals, public holidays and road or venue closures, and major disruptions (storms, airport, metro or road outages).

Answer with ONLY a JSON array and nothing before or after it. One object per event:
{"title": "...", "starts_on": "YYYY-MM-DD", "ends_on": "YYYY-MM-DD", "venue": "..." or null, "area": "..." or null, "category": "${CATEGORIES.join('|')}", "expected_attendance": number or null, "expected_effect": "${EFFECTS.join('|')}", "confidence": 0 to 1, "url": "..." or null}

Rules:
- Only events you found in this search. Nothing from memory.
- starts_on and ends_on must fall inside the window; a one-day event has ends_on equal to starts_on.
- url is the page your search returned for the event, or null. Never construct or guess an address.
- expected_attendance only when a source states it; otherwise null, never 0.
- confidence is how likely the event is to move Dubai ride demand materially.
- If you find nothing, answer [].`;
}

/* The request, on its own so a test can read it without a network. The
   measured shape and nothing more (see the header). */
export function webSearchBody(m, win) {
  return {
    model: m.model,
    input: webPrompt(win),
    tools: [{ type: 'web_search' }],
    /* Reasoning off where the endpoint understands the switch — the same
       list every other caller of config.analystModel asks (src/config.js).
       Without it the model reasons for minutes before it answers. */
    ...(thinkingSwitch(m.baseUrl) ? { thinking: { type: 'disabled' } } : {}),
  };
}

/* The answer text and the citations, from a Responses API body.
   ─────────────────────────────────────────────────────────────────────────
   The text sits in output[] items of type 'message', in content parts of type
   'output_text', and each part's annotations carry the search's url_citation
   entries. `output_text` is the SDK convenience some servers also send; it is
   read only when no message part carries text. web_search_call items are
   counted, because "the model answered without searching" is worth knowing
   when a run returns nothing. */
export function responseText(data) {
  const parts = [];
  const citations = [];
  let searches = 0;
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type === 'web_search_call') { searches++; continue; }
    if (item?.type !== 'message') continue;
    for (const c of Array.isArray(item.content) ? item.content : []) {
      if (typeof c?.text === 'string' && (c.type === 'output_text' || c.type === 'text')) parts.push(c.text);
      for (const a of Array.isArray(c?.annotations) ? c.annotations : []) {
        if (a?.type === 'url_citation' && typeof a.url === 'string') {
          citations.push({ url: a.url, title: typeof a.title === 'string' ? a.title.slice(0, 300) : null });
        }
      }
    }
  }
  if (!parts.length && typeof data?.output_text === 'string') parts.push(data.output_text);
  const seen = new Set();
  return { text: parts.join('\n'), searches,
    citations: citations.filter((c) => (seen.has(c.url) ? false : seen.add(c.url))) };
}

/* Two spellings of one page compare equal: scheme, a leading www., a trailing
   slash and the fragment do not make it a different page. The query does —
   an event id often lives there. */
const urlKey = (u) => {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return null;
    return `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`;
  } catch { return null; }
};

const slug = (s) => String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const text = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

/* The model's array, validated into world_event rows.
   ─────────────────────────────────────────────────────────────────────────
   Parsed with analyst.js lastJsonArray — the bracket matcher the analyst
   needed after a model revised its own answer mid-response — so a think block
   or a corrected second array cannot defeat this one either.

   What is refused, and why each is not repaired:
     · no title, no start date, or a date that is not a calendar day — a lead
       with no "what" or no "when" cannot be acted on;
     · an event wholly outside the window — asked for the next three weeks, a
       model that returns last month's concert is answering from memory;
     · ends_on before starts_on is treated as a one-day event, not refused:
       the start is the fact a dispatcher plans around.
   What is NOT trusted:
     · url. Kept only when it is one of the pages the search itself cited.
       A model will write a plausible address for an event it half-remembers;
       a link on the page is a claim that someone can click through to the
       source, so an address the search did not return is kept in raw as
       model_url (unverified) and is never rendered as a link;
     · expected_attendance 0 — the analyst measured that "a number or null"
       gets 0 as a placeholder; a public event with nobody at it is not an
       estimate;
     · confidence outside 0..1 is dropped rather than rescaled: 85 might be a
       percentage or might be noise, and the column is the model's own.
   Two entries for the same event in one answer keep the first. */
export function parseWebEvents(answer, { from, to, citations = [], foundOn = from, call = null } = {}) {
  const { arr, error } = lastJsonArray(answer);
  if (!arr) return { rows: [], rejected: [], error, offered: 0 };
  const cited = new Map(citations.map((c) => [urlKey(c.url), c]).filter(([k]) => k));
  const rows = [], rejected = [], codes = new Set();
  for (const e of arr) {
    if (!e || typeof e !== 'object') { rejected.push({ reason: 'not an object' }); continue; }
    const title = text(e.title, 300);
    if (!title) { rejected.push({ raw: e, reason: 'no title' }); continue; }
    if (!isDay(e.starts_on)) { rejected.push({ raw: e, reason: `no start date (${JSON.stringify(e.starts_on ?? null)})` }); continue; }
    const starts = e.starts_on;
    const ends = isDay(e.ends_on) && e.ends_on >= starts ? e.ends_on : starts;
    if (starts > to) { rejected.push({ raw: e, reason: `starts ${starts}, after the window ending ${to}` }); continue; }
    if (ends < from) { rejected.push({ raw: e, reason: `ended ${ends}, before the window starting ${from}` }); continue; }
    const code = `${slug(title) || 'event'}:${starts}`;
    if (codes.has(code)) { rejected.push({ raw: e, reason: 'a second entry for the same event' }); continue; }
    codes.add(code);
    const modelUrl = typeof e.url === 'string' ? e.url.trim() : null;
    const hit = modelUrl ? cited.get(urlKey(modelUrl)) : null;
    const att = Number(e.expected_attendance);
    const attendance = e.expected_attendance != null && Number.isFinite(att) && att > 0 ? Math.round(att) : null;
    const conf = Number(e.confidence);
    const venue = text(e.venue, 160), area = text(e.area, 160);
    const category = CATEGORIES.includes(String(e.category || '').toLowerCase()) ? String(e.category).toLowerCase() : 'other';
    rows.push({
      source: 'web', code, title, category, scope: 'dubai',
      starts_on: starts, ends_on: ends,
      expected_effect: EFFECTS.includes(e.expected_effect) ? e.expected_effect : 'unknown',
      confidence: e.confidence != null && Number.isFinite(conf) && conf >= 0 && conf <= 1 ? conf : null,
      url: hit ? hit.url : null,
      summary: [[venue, area].filter(Boolean).join(', '),
        attendance ? `about ${attendance.toLocaleString('en-US')} expected` : null].filter(Boolean).join(' — ') || null,
      raw: {
        venue, area, expected_attendance: attendance, found_on: foundOn,
        ...(modelUrl && !hit ? { model_url: modelUrl.slice(0, 500), model_url_unverified: true } : {}),
        ...(hit ? { citation: hit } : {}),
        citations: citations.slice(0, 25),
        ...(call ? { call } : {}),
      },
    });
  }
  return { rows, rejected, error: null, offered: arr.length };
}

/* One call to ModelArk, and what came of it: rows to write, or the true
   reason there are none. Never throws — every failure is a reason. */
export async function searchWeb({ now = new Date(), m = config.analystModel, timeoutMs = TIMEOUT_MS } = {}) {
  const win = webWindow(now);
  const base = { ...win, rows: [], rejected: [], citations: [], searches: 0 };
  if (!m?.apiKey) return { ...base, status: 'error', reason: REASON.noModel };
  if (!isModelArk(m.baseUrl)) {
    let host = null; try { host = new URL(String(m.baseUrl)).hostname; } catch { /* named as invalid */ }
    return { ...base, status: 'error', reason: REASON.notArk(host) };
  }
  let res;
  try {
    /* retries 0: a retried search is a second bill for the same answer, and
       a 429 or a 5xx is reported and tried again in six hours instead. */
    res = await http(`${String(m.baseUrl).replace(/\/+$/, '')}/responses`, {
      method: 'POST', timeoutMs, retries: 0,
      headers: { authorization: `Bearer ${m.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(webSearchBody(m, win)),
    });
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 240);
    return { ...base, status: 'error',
      reason: e?.name === 'AbortError'
        ? `the web search call timed out after ${timeoutMs / 1000} s (${msg})`
        : `the web search call failed: ${msg}` };
  }
  const remaining = res.headers?.get?.('x-rate-limit-remaining') ?? null;
  const data = res.data;
  if (!res.ok) {
    const er = data && typeof data === 'object' ? (data.error || data) : null;
    const code = er?.code ? String(er.code) : '';
    const message = er?.message ? String(er.message) : (typeof data === 'string' ? data : JSON.stringify(data || {}));
    /* The console switch only when the refusal names the tool. */
    const toolRefused = res.status === 403 && code === 'AccessDenied' && /built[- ]?in tool/i.test(message);
    return { ...base, status: 'error', rateLimitRemaining: remaining,
      reason: toolRefused ? REASON.accessDenied
        : `ModelArk answered HTTP ${res.status}${code ? ` ${code}` : ''}: ${message.slice(0, 240)}` };
  }
  const { text: answer, citations, searches } = responseText(data);
  const call = { model: m.model, response_id: data?.id ?? null, usage: data?.usage ?? null,
    searches, ...(remaining != null ? { rate_limit_remaining: remaining } : {}) };
  if (!answer.trim()) {
    const why = data?.incomplete_details?.reason || data?.status || 'no output text';
    return { ...base, citations, searches, call, rateLimitRemaining: remaining, status: 'error',
      reason: `ModelArk answered 200 with no answer text (${String(why).slice(0, 120)})` };
  }
  const parsed = parseWebEvents(answer, { ...win, citations, foundOn: win.from, call });
  if (parsed.error) {
    return { ...base, citations, searches, call, rateLimitRemaining: remaining, status: 'error',
      reason: `the model’s answer could not be read (${parsed.error}): ${JSON.stringify(answer.slice(0, 160))}` };
  }
  if (parsed.offered > 0 && !parsed.rows.length) {
    return { ...base, citations, searches, call, rejected: parsed.rejected, rateLimitRemaining: remaining, status: 'error',
      reason: `all ${parsed.offered} events the model returned failed validation (first: ${parsed.rejected[0]?.reason})` };
  }
  return { ...base, citations, searches, call, rows: parsed.rows, rejected: parsed.rejected,
    rateLimitRemaining: remaining, status: 'ok', reason: null };
}

/* Is a search due? `last` is the newest web row in collection_run. Pure, so
   the cadence is tested without a clock. */
export function webDue(last, now = new Date()) {
  if (!last?.finished_at) return true;
  const at = new Date(last.finished_at);
  if (last.status === 'error') return now - at >= RETRY_FAILED_AFTER_MS;
  return dubaiIso(at) !== dubaiIso(now);
}

/* The tier as events.collect runs it: decide, ask, write, record. */
export async function collectWeb({ now = new Date(), m = config.analystModel, force = false } = {}) {
  const { rows: [last] } = await pool.query(
    `SELECT status, error, finished_at FROM collection_run
      WHERE source = $1 AND mode = $2 ORDER BY finished_at DESC LIMIT 1`, [SRC, WEB_MODE]);
  if (!force && !webDue(last, now)) return { ran: false, written: 0, last };
  const out = await searchWeb({ now, m });
  const written = out.rows.length ? await upsertMany('world_event', out.rows, KEY) : 0;
  await logRun({ source: SRC, fleet_id: null, mode: WEB_MODE,
    window_start: out.from, window_end: out.to,
    status: out.status, rows_written: written, error: out.reason });
  (out.status === 'ok' ? log.info : log.warn)(SRC, 'web search tier', {
    status: out.status, events: out.rows.length, written, rejected: out.rejected.length,
    citations: out.citations.length, searches: out.searches,
    ...(out.rateLimitRemaining != null ? { rate_limit_remaining: out.rateLimitRemaining } : {}),
    ...(out.reason ? { reason: out.reason } : {}) });
  return { ran: true, written, ...out };
}
