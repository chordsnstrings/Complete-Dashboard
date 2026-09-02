// World-event layer: what was happening when the numbers moved.
//
// Three tiers, cheapest and most reliable first:
//   1. seasonal  — computed from the calendar (Dubai summer, school terms). Zero API risk.
//   2. calendar  — Ramadan/Eid, computed from the Hijri calendar (these reshape demand every year).
//   3. news      — GDELT headlines, classified by an LLM into "does this move a Dubai fleet?".
//
// Nothing here claims causation. It supplies candidates so a human can judge, and it
// quantifies the coincidence so the judgement is informed.
import { config } from '../config.js';
import { http } from '../http.js';
import { gregorianOfHijri } from './external.js';
import { upsert, upsertMany, logRun, pool } from '../db.js';
import { log } from '../log.js';

const SRC = 'events';
const q = (t, p = []) => pool.query(t, p).then((r) => r.rows);

/* ── 1. seasonal: the rhythms a Dubai fleet lives by ───────────────────── */
function seasonalEvents(fromYear, toYear) {
  const out = [];
  for (let y = fromYear; y <= toYear; y++) {
    // Peak summer: residents travel out, heat suppresses street demand, tourism troughs.
    out.push({ source: 'seasonal', code: 'summer', title: `Dubai summer ${y}`, category: 'seasonal', scope: 'dubai',
      starts_on: `${y}-06-15`, ends_on: `${y}-09-15`, expected_effect: 'demand_down', confidence: 0.75,
      summary: 'Peak heat and the annual exodus. Residential demand falls, hotel occupancy softens, and EV range drops under constant AC load.' });
    // High season: tourism peak, events calendar, comfortable weather.
    out.push({ source: 'seasonal', code: 'high_season', title: `Dubai high season ${y}-${String(y + 1).slice(2)}`, category: 'seasonal', scope: 'dubai',
      starts_on: `${y}-11-01`, ends_on: `${y + 1}-03-31`, expected_effect: 'demand_up', confidence: 0.8,
      summary: 'Tourism peak with a dense events calendar. Historically the strongest months for ride demand.' });
    // UAE school calendar (approximate public-school terms; drives commuter patterns).
    out.push({ source: 'seasonal', code: 'school_summer_break', title: `UAE school summer break ${y}`, category: 'seasonal', scope: 'uae',
      starts_on: `${y}-07-01`, ends_on: `${y}-08-31`, expected_effect: 'demand_down', confidence: 0.6,
      summary: 'School run disappears and families travel. Weekday morning peaks flatten noticeably.' });
    out.push({ source: 'seasonal', code: 'school_winter_break', title: `UAE school winter break ${y}`, category: 'seasonal', scope: 'uae',
      starts_on: `${y}-12-08`, ends_on: `${y}-12-31`, expected_effect: 'demand_up', confidence: 0.5,
      summary: 'Commuter demand dips but leisure and airport demand rise over the holiday period.' });
  }
  return out;
}

/* ── 2. Ramadan / Eid, computed rather than fetched ─────────────────────── */
/* MEASURED, production /api/status, 2026-09-02:

     events incremental partial
       ramadan 2025: TypeError: fetch failed (ETIMEDOUT) …/hToG/01-09-1446
       ramadan 2026: TypeError: fetch failed (ETIMEDOUT) …/hToG/01-09-1447
       ramadan 2027: TypeError: fetch failed (ETIMEDOUT) …/hToG/01-09-1448

   The same failure as external.js and the same host, on the simplest endpoint
   Aladhan has — a single date conversion, which rules out "the calendar
   endpoints are slow": nothing is reached to be slow. The full diagnosis, and
   why the three other candidates were ruled out, is in external.js beside
   hijriOf().

   `hToG/01-09-<hy>` asks which Gregorian day is 1 Ramaḍān. That is arithmetic
   on a deterministic calendar, so it is done here. gregorianOfHijri agrees
   with the three rows this collector wrote WHEN Aladhan was still reachable —
   /api/events today holds Ramadan 1446 → 2025-03-01, 1447 → 2026-02-18,
   1448 → 2027-02-08, and it reproduces all three exactly.

   And it fixes an off-by-one the network version could not see. Ramadan is 29
   or 30 days depending on the year; `start + 29` assumed 30. Ramadan 1446 has
   29, so production's stored row ends 2025-03-30 — which is 1 Shawwāl, the
   Eid day, already claimed by the eid_fitr row beginning the same date. The
   month now ends where Shawwāl begins, whichever length the year has. */
export function ramadanEvents(years, failed = []) {
  const out = [];
  const dayAfter = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  for (const y of years) {
    // The Hijri year overlapping Gregorian year y.
    const hy = Math.round((y - 622) * 1.0307);
    const start = gregorianOfHijri(hy, 9, 1);          // 1 Ramaḍān
    const shawwal = gregorianOfHijri(hy, 10, 1);       // 1 Shawwāl — Eid al-Fitr
    if (!start || !shawwal) {
      /* Unreachable for any year this product asks about (ICU's Umm al-Qura
         tables run 1300–1600 AH), and reported rather than skipped if it ever
         is not: silence here is what put the collector two days behind. */
      log.warn(SRC, `ramadan ${y} not convertible`, { hy });
      failed.push(`ramadan ${y}: no Gregorian date for 01-09-${hy}`);
      continue;
    }
    const endOfRamadan = dayAfter(shawwal, -1);
    const eidEnd = dayAfter(shawwal, 2);
    out.push({ source: 'calendar', code: 'ramadan', title: `Ramadan ${hy}`, category: 'holiday', scope: 'uae',
      starts_on: start, ends_on: endOfRamadan, expected_effect: 'demand_down', confidence: 0.85,
      summary: 'Daytime demand collapses and shifts to a sharp post-iftar night peak. Working hours are shortened across the UAE.' });
    out.push({ source: 'calendar', code: 'eid_fitr', title: `Eid al-Fitr ${hy}`, category: 'holiday', scope: 'uae',
      starts_on: shawwal, ends_on: eidEnd, expected_effect: 'demand_up', confidence: 0.7,
      summary: 'Multi-day public holiday: leisure, family visiting and airport demand spike together.' });
  }
  return out;
}

/* ── 3. news: headlines that plausibly move a Dubai fleet ──────────────── */
// GDELT allows ~1 request / 5s. We make a handful of narrow queries, once per run.
const NEWS_QUERIES = [
  { code: 'gulf_conflict', q: '("Iran" OR "Strait of Hormuz" OR "Red Sea") (conflict OR strike OR attack OR war)', category: 'geopolitical', scope: 'regional' },
  { code: 'uae_travel', q: '("UAE" OR "Dubai") (tourism OR "travel demand" OR airport OR visa)', category: 'economic', scope: 'uae' },
  { code: 'dubai_transport', q: '("Dubai") (taxi OR "ride hailing" OR RTA OR transport)', category: 'regulatory', scope: 'dubai' },
  { code: 'fuel_energy', q: '("UAE fuel price" OR "petrol price" OR "electricity tariff")', category: 'economic', scope: 'uae' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchNews(failed = []) {
  const arts = [];
  for (const nq of NEWS_QUERIES) {
    try {
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(nq.q)}`
        + `&mode=artlist&maxrecords=10&format=json&timespan=7d&sort=hybridrel`;
      const { data } = await http(url, { timeoutMs: 30000, retries: 1, expect: 'json' });
      if (typeof data === 'string') {
        log.warn(SRC, `gdelt throttled for ${nq.code}`);
        failed.push(`news ${nq.code}: gdelt throttled`);
        await sleep(6000); continue;
      }
      for (const a of (data?.articles || [])) {
        arts.push({ ...nq, title: a.title, url: a.url, domain: a.domain, seendate: a.seendate });
      }
    } catch (e) {
      log.warn(SRC, `news ${nq.code} failed`, { err: String(e).slice(0, 80) });
      failed.push(`news ${nq.code}: ${String(e).slice(0, 110)}`);
    }
    await sleep(6000);                                   // respect the 1-per-5s limit
  }
  return arts;
}

// Ask an LLM whether a headline plausibly affects Dubai ride demand, and how.
// Conservative by design: default to "unknown / low confidence" rather than inventing a story.
async function classifyNews(articles, failed = []) {
  if (!articles.length || !config.analystModel?.apiKey) return [];
  const list = articles.slice(0, 30).map((a, i) => `${i}. ${a.title}`).join('\n');
  const prompt = `You assess whether news affects a taxi/ride-hailing fleet operating in Dubai, UAE.
For each headline return: index, effect (demand_up|demand_down|supply_down|risk_up|none), confidence 0-1, and one short reason.
Be strict: most headlines have no measurable effect on a Dubai fleet — use "none" with low confidence unless the link is direct and material.
Return ONLY a JSON array like [{"i":0,"effect":"none","confidence":0.1,"reason":"..."}].

${list}`;
  try {
    const { data } = await http(`${config.analystModel.baseUrl}/chat/completions`, {
      method: 'POST', timeoutMs: 90000, retries: 1,
      headers: { authorization: `Bearer ${config.analystModel.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.analystModel.model, messages: [{ role: 'user', content: prompt }], max_tokens: 1600 }),
    });
    const txt = data?.choices?.[0]?.message?.content || '';
    const m = txt.match(/\[[\s\S]*\]/);
    if (!m) return [];
    return JSON.parse(m[0]);
  } catch (e) {
    log.warn(SRC, 'llm classify failed', { err: String(e).slice(0, 100) });
    failed.push(`classifier: ${String(e).slice(0, 110)}`);
    return [];
  }
}

/* ── break detection + attribution ─────────────────────────────────────── */
/* ── break decisions, kept pure so they can be tested ──────────────────────
   Everything here is arithmetic over two month summaries. The IO around it —
   reading trips, looking up overlapping events, writing metric_break — lives in
   detectBreaks below. The bug these functions exist to prevent was invisible
   precisely because the only test reimplemented the logic instead of calling
   it. */

export const prevMonth = (m) => {
  const [y, mm] = m.split('-').map(Number);
  return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`;
};

// `a` and `b` are consecutive-month summaries: { m, trips, drivers, attributed }.
// Returns null when the pair is not worth reporting as a break.
export function breakBetween(a, b, { minChange = 0.30, minTrips = 20 } = {}) {
  if (!a || !b) return null;                       // no observed neighbour: a gap, not a break
  if (prevMonth(b.m) !== a.m) return null;         // never compare across missing months
  if (a.trips < minTrips && b.trips < minTrips) return null;
  const change = a.trips ? (b.trips - a.trips) / a.trips : 0;
  if (Math.abs(change) < minChange) return null;

  // Driver counts only compare when both months carry driver ids. The
  // telematics feed does not, so an FMS-only month would otherwise read as
  // "every driver left".
  const comparable = a.attributed > 0 && b.attributed > 0;
  const dChange = comparable && a.drivers ? (b.drivers - a.drivers) / a.drivers : null;
  const prodA = a.trips / (a.drivers || 1), prodB = b.trips / (b.drivers || 1);
  const pChange = comparable && prodA ? (prodB - prodA) / prodA : null;

  // Fewer drivers (supply) versus each driver doing less (demand). Without
  // comparable driver counts we cannot separate the two, and saying so beats
  // picking one.
  let attribution = 'unattributable';
  if (comparable) {
    attribution = 'mixed';
    if (Math.abs(pChange) > Math.abs(dChange) * 2) attribution = 'demand';
    else if (Math.abs(dChange) > Math.abs(pChange) * 2) attribution = 'supply';
  }
  return {
    change_pct: change,
    drivers_from: comparable ? a.drivers : null,
    drivers_to: comparable ? b.drivers : null,
    driver_change_pct: dChange, productivity_change_pct: pChange, attribution,
  };
}

export async function detectBreaks() {
  // `HAVING count(*) > 20` used to drop thin months from the series. Combined
  // with comparing adjacent ROWS rather than adjacent MONTHS, that let October
  // 2025 sit next to August 2026 and produce a confident "-91% break" spanning
  // ten months in which nothing had been collected at all.
  const rows = await q(
    `SELECT to_char(date_trunc('month', requested_at), 'YYYY-MM') AS m, platform,
            count(*)::int trips, count(distinct driver_ext_id)::int drivers,
            count(*) FILTER (WHERE driver_ext_id IS NOT NULL)::int attributed
     FROM trip GROUP BY 1,2 ORDER BY 2,1`);
  const byPlatform = {};
  for (const r of rows) (byPlatform[r.platform] ||= new Map()).set(r.m, r);

  let n = 0;
  for (const [platform, series] of Object.entries(byPlatform)) {
    for (const [m, b] of series) {
      const verdict = breakBetween(series.get(prevMonth(m)), b);
      if (!verdict) continue;
      const a = series.get(prevMonth(m));
      const fromDate = `${a.m}-01`, toDate = `${b.m}-01`;
      const events = await q(
        `SELECT title, category, scope, starts_on, ends_on, expected_effect, confidence, summary
         FROM world_event
         WHERE starts_on <= $2 AND coalesce(ends_on, starts_on) >= $1
         ORDER BY confidence DESC NULLS LAST LIMIT 8`, [fromDate, toDate]);

      await upsert('metric_break', {
        metric: 'trips', grain: 'month', platform, fleet_id: null,
        period_from: fromDate, period_to: toDate,
        value_from: a.trips, value_to: b.trips,
        ...verdict, candidate_events: JSON.stringify(events),
      }, ['metric', 'grain', 'platform', 'period_from', 'period_to']);
      n++;
    }
  }

  // Breaks written by the old row-adjacent logic span months we never observed.
  // Their primary key includes the bogus period, so recomputation cannot
  // overwrite them — they have to be deleted.
  const { rowCount } = await pool.query(
    `DELETE FROM metric_break
     WHERE grain = 'month'
       AND period_to <> (period_from + interval '1 month')::date`);
  if (rowCount) log.info(SRC, 'cleared breaks spanning unobserved months', { removed: rowCount });

  return n;
}

export async function collect({ mode = 'incremental' } = {}) {
  /* Three fetches under here swallow independently — the Hijri lookup, each
     news query, and the classifier — and the run status was the literal 'ok'
     above all of them, so this source could only ever report 'ok' or a thrown
     error. It is the same construction that let external.js report ok for two
     days with a dead calendar behind it; fixed here before it does. */
  const failed = [];
  try {
    const yNow = new Date().getUTCFullYear();
    const seasonal = seasonalEvents(yNow - 2, yNow + 1);
    const ramadan = ramadanEvents([yNow - 1, yNow, yNow + 1], failed);
    let rows = [...seasonal, ...ramadan];

    // news tier (best-effort; never blocks the rest)
    let newsRows = [];
    try {
      const arts = await fetchNews(failed);
      const verdicts = await classifyNews(arts, failed);
      const byIdx = Object.fromEntries(verdicts.map((v) => [v.i, v]));
      newsRows = arts.slice(0, 30).map((a, i) => {
        const v = byIdx[i];
        if (!v || v.effect === 'none' || (v.confidence ?? 0) < 0.4) return null;   // keep only material ones
        const day = a.seendate ? `${a.seendate.slice(0, 4)}-${a.seendate.slice(4, 6)}-${a.seendate.slice(6, 8)}` : null;
        if (!day) return null;
        return { source: 'news', code: a.code, title: (a.title || '').slice(0, 300), category: a.category, scope: a.scope,
          starts_on: day, ends_on: day, expected_effect: v.effect, confidence: v.confidence,
          url: a.url, summary: v.reason, raw: { domain: a.domain } };
      }).filter(Boolean);
    } catch (e) {
      log.warn(SRC, 'news tier skipped', { err: String(e).slice(0, 80) });
      failed.push(`news tier: ${String(e).slice(0, 110)}`);
    }

    rows = [...rows, ...newsRows];
    const written = rows.length ? await upsertMany('world_event', rows, ['source', 'code', 'starts_on', 'title']) : 0;
    const breaks = await detectBreaks();
    await logRun({ source: SRC, fleet_id: null, mode, rows_written: written + breaks,
      status: !failed.length ? 'ok' : (written + breaks > 0 ? 'partial' : 'error'),
      error: failed.length ? failed.slice(0, 4).join('; ').slice(0, 400) : null });
    log.info(SRC, 'done', { seasonal: seasonal.length, ramadan: ramadan.length,
      news: newsRows.length, breaks, failed: failed.length });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: null, mode, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
