/* Dubai events found by SearchInfinity, read by the model (EVW2, 2026-11-16).
   ───────────────────────────────────────────────────────────────────────
   Production's ModelArk account refuses the Responses API's built-in
   web_search (403 AccessDenied). The operator: "Searchinfinity is already
   active in modelark", with its key. Measured with that key: POST
   https://torchlight.byteintlapi.com/search_api/web_search, Bearer key,
   {Query, Count, TimeRange} → 200 in 2.8 s, Result.WebResults[] of
   {Title, Url, Snippet, Summary, SiteName, PublishTime}.

   So the tier searches first, then hands ONLY the pages it got — numbered —
   to the analyst model, which may name an event only by citing the numbers of
   the pages that state it. Held here against a fake SearchInfinity and a fake
   model (no request leaves this machine):

     1. the searches: the window's months, the kinds of event that move rides;
     2. one search: results mapped; 700901 is the key, said so and fatal; a
        quota refusal is fatal and verbatim; a 500 is one failed search;
     3. search then read: duplicates folded; the model is sent the numbered
        pages with thinking off; an event's link is the page its number names,
        never an address the model typed; an event citing no given page is
        refused; the key never appears in what the tier returns;
     4. the reasons when it cannot run: no model, every search refused, no page;
     5. collectWeb takes this path when SEARCHINFINITY_API_KEY is set.

   REVERSIONS (each run, each failing as named):
     · parseWebEvents' source resolution removed (the model's own url used)
       → §3 "the link is the page its number names" fails
     · the "cites none of the search results" refusal removed → §3 "an event
       citing no given page is refused" fails
     · the fatal break in searchInfinityWeb removed → §4 "stops at the first"
       fails
     · webDue's searchInfinity clause removed → §4b "due at once" fails */
import { readFileSync } from 'node:fs';

for (const k of ['ANALYST_BASE_URL', 'ANALYST_MODEL', 'ANALYST_API_KEY', 'ARK_BASE_URL', 'ARK_MODEL', 'ARK_API_KEY',
  'SEARCHINFINITY_API_KEY', 'SEARCHINFINITY_URL']) delete process.env[k];
const W = await import('../src/sources/events_web.js');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const SI = { apiKey: 'si-test-key-not-real', url: 'https://si.example.test/search_api/web_search' };
const M = { baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3', apiKey: 'ark-test-key-not-real', model: 'seed-2-0-pro-260328' };
const NOW = new Date('2026-11-16T10:00:00Z');   // Dubai 14:00 on the 16th → window 16 Nov … 6 Dec
const page = (n, extra = {}) => ({ Title: `Page ${n}`, Url: `https://news${n}.example/dubai-events-${n}`, Snippet: `snippet ${n}`,
  Summary: `Summary of page ${n}`, SiteName: `Site ${n}`, PublishTime: '2026-11-10T10:00:00+04:00', ...extra });
const siOk = (results) => ({ status: 200, ok: true, data: { ResponseMetadata: { RequestId: 'r' }, Result: { ResultCount: results.length, WebResults: results } } });

console.log('\n1. the searches');
{
  const win = W.webWindow(NOW);
  const qs = W.siQueries(win);
  check('a window over two months searches each month, and the kinds that move rides — seven searches',
    win.from === '2026-11-16' && win.to === '2026-12-06' && qs.length === 7
    && qs.includes('Dubai events November 2026') && qs.includes('Dubai events December 2026')
    && qs.includes('Dubai concerts December 2026') && qs.some((q) => /road closures/.test(q)), JSON.stringify(qs));
  check('a window inside one month: five', W.siQueries({ from: '2026-11-01', to: '2026-11-21' }).length === 5);
}

console.log('\n2. one search');
{
  let seen = null;
  const r = await W.siSearch(SI, 'Dubai events', { httpImpl: async (url, o) => { seen = { url, o }; return siOk([page(1), { Title: 'no url' }]); } });
  const body = JSON.parse(seen.o.body);
  check('POST to the endpoint with the Bearer key and {Query, Count, TimeRange}',
    seen.url === SI.url && seen.o.method === 'POST' && seen.o.headers.authorization === `Bearer ${SI.apiKey}`
    && body.Query === 'Dubai events' && body.Count === 10 && body.TimeRange === 'OneMonth', JSON.stringify(body));
  check('results mapped (title, url, site, published, summary), a result with no url dropped',
    r.results.length === 1 && r.results[0].url === 'https://news1.example/dubai-events-1' && r.results[0].site === 'Site 1'
    && /Summary of page 1/.test(r.results[0].text), JSON.stringify(r));
  const bad = await W.siSearch(SI, 'q', { httpImpl: async () => ({ status: 200, ok: true,
    data: { ResponseMetadata: { Error: { CodeN: 700901, Code: 'invalid_api_key', Message: 'invalid api key' } } } }) });
  check('700901 is the key, said so, and fatal', bad.error === W.REASON.siKey && bad.fatal === true, JSON.stringify(bad));
  const quota = await W.siSearch(SI, 'q', { httpImpl: async () => ({ status: 200, ok: true,
    data: { ResponseMetadata: { Error: { CodeN: 10403, Code: '10403', Message: 'free quota exhausted' } } } }) });
  check('a quota refusal is fatal and quoted', quota.fatal === true && /10403/.test(quota.error) && /quota exhausted/.test(quota.error), JSON.stringify(quota));
  const five = await W.siSearch(SI, 'q', { httpImpl: async () => ({ status: 500, ok: false, data: 'upstream boom' }) });
  check('a 500 is one failed search, not fatal', /HTTP 500/.test(five.error) && !five.fatal, JSON.stringify(five));
}

console.log('\n3. search, then read');
{
  const calls = [];
  let modelBody = null;
  const answer = JSON.stringify([
    { title: 'Dubai Run 2026', starts_on: '2026-11-23', ends_on: '2026-11-23', venue: 'Sheikh Zayed Road', area: 'Downtown',
      category: 'sports', expected_attendance: 300000, expected_effect: 'demand_down', confidence: 0.8, sources: [2],
      url: 'https://made-up.example/not-a-result' },
    { title: 'A concert nobody listed', starts_on: '2026-11-25', ends_on: '2026-11-25', category: 'concert', confidence: 0.5,
      sources: [99] },
    { title: 'A festival with a url but no number', starts_on: '2026-11-28', category: 'festival', confidence: 0.4,
      url: 'https://news3.example/dubai-events-3' },
  ]);
  const httpImpl = async (url, o) => {
    calls.push(url);
    if (url === SI.url) {
      const q = JSON.parse(o.body).Query;
      // every search returns pages 1–3, the concerts search one more; duplicates must fold
      return siOk(/concerts/.test(q) ? [page(1), page(2), page(3), page(4)] : [page(1), page(2), page(3)]);
    }
    modelBody = JSON.parse(o.body);
    return { status: 200, ok: true, data: { choices: [{ message: { content: answer } }], usage: { total_tokens: 1234 } } };
  };
  const out = await W.searchInfinityWeb({ now: NOW, m: M, cfg: SI, httpImpl });
  const prompt = modelBody?.messages?.[0]?.content || '';
  check('seven searches, then one call to the model', calls.filter((u) => u === SI.url).length === 7
    && calls.filter((u) => /chat\/completions$/.test(u)).length === 1, JSON.stringify(calls.slice(-2)));
  check('duplicate pages fold: the model is given four numbered pages', out.call.results === 4
    && /\[1\] Page 1/.test(prompt) && /\[4\] Page 4/.test(prompt) && !/\[5\]/.test(prompt), String(out.call.results));
  check('…with thinking off, on ModelArk, and the window in the instructions',
    modelBody.thinking?.type === 'disabled' && /between 2026-11-16 and 2026-12-06/.test(prompt) && /THESE RESULTS ONLY/.test(prompt));
  const run = out.rows.find((r) => r.title === 'Dubai Run 2026');
  check('the link is the page its number names, never the address the model typed',
    run && run.url === 'https://news2.example/dubai-events-2' && !JSON.stringify(out.rows).includes('made-up.example/not-a-result'),
    JSON.stringify(run && { url: run.url, raw: run.raw?.model_url }));
  check('an event citing no given page is refused, and so is one that only typed a url',
    out.rows.length === 1 && out.rejected.length === 2 && out.rejected.every((x) => /cites none of the search results/.test(x.reason)),
    JSON.stringify(out.rejected.map((x) => x.reason)));
  check('the row keeps its sources and is a web lead with the model\'s confidence',
    run?.source === 'web' && run.confidence === 0.8 && run.raw?.sources?.[0]?.site === 'Site 2' && out.status === 'ok');
  check('neither key appears in anything the tier returns', !JSON.stringify(out).includes(SI.apiKey) && !JSON.stringify(out).includes(M.apiKey));
}

console.log('\n4. the reasons when it cannot run');
{
  let called = 0;
  const noModel = await W.searchInfinityWeb({ now: NOW, m: { ...M, apiKey: null }, cfg: SI, httpImpl: async () => { called++; return siOk([]); } });
  check('no model: said so, and nothing is searched', noModel.reason === W.REASON.siNoModel && called === 0);
  const searched = [];
  const refused = await W.searchInfinityWeb({ now: NOW, m: M, cfg: SI, httpImpl: async (u) => { searched.push(u);
    return { status: 200, ok: true, data: { ResponseMetadata: { Error: { CodeN: 700901, Code: 'invalid_api_key', Message: 'x' } } } }; } });
  check('a refused key stops at the first search and says it is the key', refused.status === 'error'
    && refused.reason === W.REASON.siKey && searched.length === 1, JSON.stringify([refused.reason, searched.length]));
  const empty = await W.searchInfinityWeb({ now: NOW, m: M, cfg: SI, httpImpl: async () => siOk([]) });
  check('no page from any search: said so, with the count', empty.status === 'error' && /no page for any of the 7 searches/.test(empty.reason), empty.reason);
}

console.log('\n4b. the old path\'s refusal does not hold back the new one');
{
  const last = { status: 'error', error: W.REASON.accessDenied, finished_at: '2026-11-16T11:28:07Z' };
  const at = new Date('2026-11-16T12:30:00Z');
  check('the 403 of 11:28Z waits six hours for the Responses path…', W.webDue(last, at) === false);
  check('…but SearchInfinity, never tried, is due at once', W.webDue(last, at, { searchInfinity: true }) === true);
  check('a SearchInfinity failure still waits its six hours',
    W.webDue({ status: 'error', error: W.REASON.siKey, finished_at: '2026-11-16T11:28:07Z' }, at, { searchInfinity: true }) === false);
}

console.log('\n5. collectWeb takes this path when the key is set');
{
  const src = readFileSync('src/sources/events_web.js', 'utf8');
  check('searchInfinityConfig() decides, and the ModelArk Responses path is the fallback',
    /const si = searchInfinityConfig\(\);[\s\S]{0,200}const out = si \? await searchInfinityWeb\(\{ now, m, cfg: si \}\) : await searchWeb\(\{ now, m \}\);/.test(src));
  process.env.SEARCHINFINITY_API_KEY = 'from-env-not-real';
  const cfg = W.searchInfinityConfig();
  check('the key from the environment, the measured endpoint by default', cfg?.apiKey === 'from-env-not-real' && cfg.url === W.SI_URL_DEFAULT);
  delete process.env.SEARCHINFINITY_API_KEY;
  check('…and no key, no SearchInfinity', W.searchInfinityConfig() === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
