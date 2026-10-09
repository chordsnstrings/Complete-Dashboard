/* WHAT THE ASSISTANT MAY SAY — checked after it has written, before anybody
   reads it.
   ──────────────────────────────────────────────────────────────────────────
   The model writes figures as placeholders — {{r3.completed_trips}} — and this
   file puts the server's number in their place, formatted the way the pages
   format it. A placeholder that names a result or a figure that does not
   exist is refused, not left blank.

   Then everything the model typed ITSELF is read for numbers. A number is
   allowed only if it can be found somewhere it could honestly have come from:
   a result fetched in this chat (a value, a cell, a date in a label), a tool
   argument, or the person's own messages. Anything else is a number the model
   produced, and on this dashboard that is the one thing it may not do — the
   daily email has run the same rule since 2026-09-30 (guardCommentary in
   src/daily_report.js), and its first night caught a "3.4" the model had
   worked out for itself.

   And a sentence is held to the result it cites. The trial run of Seed 2.0
   (2026-10-09) fetched one driver's trips over every platform and wrote "he
   completed {{r1.total}} trips on Bolt": every number real, the sentence
   false. A sentence that names a platform, a fleet or a driver must cite a
   result that is about that platform, fleet or driver.

   A reply that fails is sent back ONCE with exactly what was wrong; a second
   failure is replaced by the figures themselves, as measured, said plainly
   (api/agent_routes.js). */
import { rangeLabel } from './agent_period.js';

const PLATFORMS = ['uber', 'bolt', 'yango', 'hotel', 'careem'];
const FLEETS = ['ecosine', 'egari'];
/* {{r3.completed_trips}} — a figure of a result; {{r4.rows[0].completed}} — a
   cell of one of its rows. Both are the server's numbers. The cell form was
   added after the rehearsal of 2026-10-09, when the model cited a one-row
   table that way and the braces reached the screen unfilled: the pattern did
   not match, so nothing filled them and nothing refused them. Anything else
   in braces is refused now, whatever it looks like. */
const PH = /\{\{\s*(r\d+)\.(?:rows\[(\d+)\]\.)?([a-z0-9_]+)\s*\}\}/gi;
const ANY_BRACES = /\{\{[^}]*\}\}/g;
const lookup = (r, row, key) => {
  if (!r) return { ok: false };
  if (row != null) {
    const rr = (r.rows || [])[Number(row)];
    const c = (r.columns || []).find((x) => x.key === key);
    if (!rr || !c) return { ok: false };
    return { ok: true, value: rr[key], kind: c.kind };
  }
  if (!r.values || !(key in r.values)) return { ok: false };
  return { ok: true, value: r.values[key], kind: (r.kinds || {})[key] };
};
const MARK = /\[\[\s*(table|file)\s+(r\d+)\s*\]\]/gi;

/* The pages' formatting, so a figure reads the same in the chat as on the
   page it came from. */
export function formatValue(v, kind) {
  if (v == null) return 'not available';
  if (kind === 'text' || typeof v === 'string' && !Number.isFinite(Number(v))) {
    return kind === 'date' && /^\d{4}-\d{2}-\d{2}/.test(v) ? rangeLabel(v.slice(0, 10), v.slice(0, 10)) : String(v);
  }
  if (kind === 'date') return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? rangeLabel(String(v).slice(0, 10), String(v).slice(0, 10)) : String(v);
  const n = Number(v);
  const f = (d) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const sign = n < 0 ? '−' : '';
  switch (kind) {
    case 'aed': return `${sign}AED ${f(2)}`;
    case 'int': return `${sign}${f(0)}`;
    case 'km': return `${sign}${f(Math.abs(n) >= 100 ? 0 : 1)} km`;
    case 'pct': return `${sign}${f(1)}%`;
    case 'pts': return `${n > 0 ? '+' : sign}${f(1)} pts`;
    case 'num2': return `${sign}${f(2)}`;
    default: return Number.isInteger(n) ? `${sign}${f(0)}` : `${sign}${f(2)}`;
  }
}

/* Every number a string contains, as a bare digit string: "1,234.50" → "1234.5",
   "AED 3,318.24" → "3318.24". */
export function numbersIn(s) {
  const out = [];
  for (const m of String(s ?? '').matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    let t = m[0].replace(/,/g, '');
    if (t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
    out.push(t);
  }
  return out;
}

/* Everything a number may honestly have come from. */
export function sourcedNumbers({ results = [], userTexts = [], args = [] }) {
  const ok = new Set();
  const add = (x) => { for (const n of numbersIn(x)) { ok.add(n); ok.add(n.split('.')[0]); } };
  const addNum = (v, kind) => {
    if (v == null) return;
    if (typeof v === 'number') {
      add(String(v));
      add(String(Math.round(v)));
      add(v.toFixed(1)); add(v.toFixed(2));
      add(formatValue(v, kind));
    } else add(v);
  };
  for (const r of results) {
    add(r.definition); add(r.note); add(r.period?.label); add(r.period?.from); add(r.period?.to);
    for (const [k, v] of Object.entries(r.values || {})) addNum(v, (r.kinds || {})[k]);
    for (const row of r.rows || []) for (const c of r.columns || []) addNum(row[c.key], c.kind);
    for (const c of r.candidates || []) add(JSON.stringify(c));
  }
  for (const t of userTexts) add(t);
  for (const a of args) add(JSON.stringify(a));
  return ok;
}

/**
 * Check and fill a reply.
 * @param {string} text        what the model wrote
 * @param {Map} results        rid → stored result (the whole chat's)
 * @param {object} o
 * @returns {{ok, text, problems:string[], used:string[], tables:string[], files:string[]}}
 */
export function checkReply(text, results, { userTexts = [], args = [], driverNames = [] } = {}) {
  const problems = [];
  const used = new Set();
  const tables = []; const files = [];
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, text: '', problems: ['the reply was empty'], used: [], tables, files };

  /* 1. Placeholders and markers point at things that exist. */
  for (const m of raw.matchAll(PH)) {
    const [, rid, row, key] = m;
    const r = results.get(rid);
    if (!r) { problems.push(`${m[0]} names a result that does not exist`); continue; }
    if (!lookup(r, row, key).ok) {
      problems.push(row != null
        ? `${m[0]}: ${rid} has no row ${row} with a column ${key}; its columns are ${(r.columns || []).map((c) => c.key).join(', ') || 'none'} and it has ${(r.rows || []).length} rows`
        : `${m[0]}: ${rid} has no figure called ${key}; it has ${Object.keys(r.values || {}).join(', ') || 'no single figures'}`);
      continue;
    }
    used.add(rid);
  }
  /* Braces that are not a placeholder at all. */
  for (const m of raw.replace(PH, ' ').matchAll(ANY_BRACES)) {
    problems.push(`${m[0]} is not a placeholder this server can fill — write {{rN.figure}} or {{rN.rows[i].column}}`);
  }
  for (const m of raw.matchAll(MARK)) {
    const r = results.get(m[2]);
    if (!r) { problems.push(`[[${m[1]} ${m[2]}]] names a result that does not exist`); continue; }
    if (m[1].toLowerCase() === 'table' && !r.columns) problems.push(`[[table ${m[2]}]]: ${m[2]} is not a table`);
    else if (m[1].toLowerCase() === 'file' && r.kind !== 'file') problems.push(`[[file ${m[2]}]]: ${m[2]} is not a file — call make_excel`);
    else { (m[1].toLowerCase() === 'table' ? tables : files).push(m[2]); used.add(m[2]); }
  }

  /* 2. Numbers the model typed itself. List numbering ("1. ", "2) ") is
     structure, not a figure. */
  const bare = raw.replace(PH, ' ').replace(MARK, ' ').replace(/^\s*\d{1,2}[.)]\s/gm, ' ');
  const allowed = sourcedNumbers({ results: [...results.values()], userTexts, args });
  const stray = [...new Set(numbersIn(bare))].filter((n) => !allowed.has(n) && !allowed.has(n.split('.')[0]));
  if (stray.length) {
    problems.push(`these numbers did not come from any result: ${stray.slice(0, 6).join(', ')} — use placeholders, or call summarise/compare to compute them`);
  }

  /* 3. Each sentence agrees with the results it cites. */
  for (const sentence of raw.split(/(?<=[.!?])\s+|\n+/)) {
    const cited = [...sentence.matchAll(PH)].map((m) => ({ r: results.get(m[1]), key: m[3].toLowerCase() })).filter((c) => c.r);
    if (!cited.length) continue;
    const low = sentence.replace(PH, ' ').toLowerCase();
    for (const p of PLATFORMS) {
      if (!new RegExp(`\\b${p}\\b`).test(low)) continue;
      const fine = cited.some(({ r, key }) => r.filters?.platform === p || key.startsWith(`${p}_`)
        || (r.filters?.grouped_by === 'platform' && key.includes(p)) || r.kind === 'period' || r.kind === 'lookup');
      if (!fine) {
        const c = cited[0];
        problems.push(`a sentence says "${p}" but cites ${c.r.id} (${c.r.definition}), which is not about ${p} alone — filter by platform, or summarise ${c.r.id} grouped by platform and cite the ${p} figure`);
        break;
      }
    }
    for (const f of FLEETS) {
      if (!new RegExp(`\\b${f}\\b`).test(low)) continue;
      const fine = cited.some(({ r, key }) => r.filters?.fleet === f || key.startsWith(`${f}_`)
        || (r.filters?.grouped_by === 'fleet' && key.includes(f)) || r.kind === 'period' || r.kind === 'lookup');
      if (!fine) {
        problems.push(`a sentence says "${f}" but cites ${cited[0].r.id} (${cited[0].r.definition}), which covers ${cited[0].r.filters?.fleet || 'both fleets'}`);
        break;
      }
    }
    for (const name of driverNames) {
      if (!name || name.length < 4 || !low.includes(name.toLowerCase())) continue;
      const about = cited.find(({ r }) => r.filters?.driver && r.filters.driver.toLowerCase() !== name.toLowerCase()
        && !name.toLowerCase().includes(r.filters.driver.toLowerCase()) && !r.filters.driver.toLowerCase().includes(name.toLowerCase()));
      if (about) problems.push(`a sentence names ${name} but cites ${about.r.id}, which is about ${about.r.filters.driver}`);
    }
  }

  /* 4. Fill — absorbing a unit the model wrote around the placeholder. The
     server formats with the unit ("AED 412,126.99", "16.9%"), and the
     rehearsal of 2026-10-09 showed the model adding its own as well:
     "16.9%%", "AED 412,126.99 AED". A unit is only absorbed when it is the
     figure's own; "AED {{r1.trips}}" is left for the reader to see. */
  const UNIT = /(AED\s*)?\{\{\s*(r\d+)\.(?:rows\[(\d+)\]\.)?([a-z0-9_]+)\s*\}\}(\s*(?:%|percent\b|per cent\b|AED\b|dirhams?\b|km\b))?/gi;
  const filled = raw.replace(UNIT, (all, pre, rid, row, key, post) => {
    const f = lookup(results.get(rid), row, key);
    if (!f.ok) return '(not available)';
    const kind = f.kind;
    const v = formatValue(f.value, kind);
    const p0 = pre || ''; const p1 = post || '';
    const dropPre = kind === 'aed' && /AED/i.test(p0);
    const dropPost = (kind === 'aed' && /AED|dirham/i.test(p1)) || ((kind === 'pct' || kind === 'pts') && /%|percent|per cent/i.test(p1))
      || (kind === 'km' && /km/i.test(p1));
    return `${dropPre ? '' : p0}${v}${dropPost ? '' : p1}`;
  });
  const text2 = filled.replace(ANY_BRACES, '(not available)');
  return { ok: problems.length === 0, text: text2, problems, used: [...used], tables, files };
}

/* When the model cannot write it up honestly, the figures themselves —
   every result it fetched this turn, as measured, with what each one is. */
export function plainAnswer(results, why) {
  const lines = [`I fetched the figures but could not write them up without a number I cannot source (${why}), so here they are exactly as measured:`];
  const tables = [];
  for (const r of results) {
    if (r.kind === 'period' || r.kind === 'lookup') continue;
    if (r.withheld) { lines.push(`- ${r.definition}: not shown — ${r.withheld}`); continue; }
    if (r.error) { lines.push(`- ${r.definition}: not available — ${r.error}`); continue; }
    const vals = Object.entries(r.values || {}).filter(([, v]) => v != null).slice(0, 8)
      .map(([k, v]) => `${k.replace(/_/g, ' ')} ${formatValue(v, (r.kinds || {})[k])}`);
    lines.push(`- ${r.definition}${vals.length ? `: ${vals.join('; ')}` : ''}`);
    if (r.columns && (r.rows || []).length) tables.push(r.id);
  }
  return { text: lines.join('\n'), tables };
}
