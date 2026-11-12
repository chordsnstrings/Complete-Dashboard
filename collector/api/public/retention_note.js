/* "Thinned by retention before <date>" — one line at the top of a page, and
   the record of the nightly pass on #settings.
   ─────────────────────────────────────────────────────────────────────────
   The data-retention pass (src/data_retention.js) thins old positions and,
   only if the operator opts in, removes old safety alerts. Once it has done
   either for real, a page whose window reaches back past that point computes
   from fewer rows than were collected — fewer fixes, coarser tracks, shorter
   distances, alerts that read as "not covered". Shown without a word that is
   a smaller number presented as complete, which this product exists not to
   do. The server names it in x-fm-retention on exactly those answers
   (api/data_retention_notes.js); data.js api() hands every header here, the
   same way x-fm-withheld reaches access.js, and the page prints the line.

   No imports: data.js imports this, and this importing data.js or ui.js
   (which imports data.js) would make a cycle. The Settings panel takes its
   helpers as arguments for the same reason. */

/* tz.js, a leaf module the page already loads: the one Dubai calendar. */
import { dubaiDay } from './tz.js';
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const dayWords = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTH[Number(m[2]) - 1]} ${m[1]}` : String(iso || '');
};

/* table;action;first-whole-day;bucket-minutes, comma separated. Anything
   malformed is dropped rather than printed half-understood. */
export function parseRetentionHeader(h) {
  return String(h || '').split(',').map((part) => {
    const [table, action, before, bucket] = part.trim().split(';');
    if (!table || !/^(thinned|removed)$/.test(action || '') || !/^\d{4}-\d{2}-\d{2}$/.test(before || '')) return null;
    const b = Number(bucket);
    return { table, action, before, bucket_min: Number.isFinite(b) && b > 0 ? b : null };
  }).filter(Boolean);
}

/* The sentence, per table, in the words the page prints. */
export function retentionSentence(n) {
  const when = dayWords(n.before);
  if (n.table === 'telemetry_snapshot') {
    return `Vehicle positions before ${when} were thinned by retention to one fix per car per `
      + `${n.bucket_min || 15} minutes, plus every change of ignition, seat, status or moving and each day’s `
      + 'last fix. Counts, tracks, distances and stops before that date come from fewer fixes than were '
      + 'collected and are not complete.';
  }
  if (n.table === 'alert') {
    return `Safety alerts before ${when} were removed by retention (RETENTION_ALERT_DAYS). Alert counts and `
      + 'rates before that date are not complete; those days count as not covered for that reason.';
  }
  return `${n.table} before ${when} was ${n.action} by retention; figures before that date are not complete.`;
}

/* What this render's answers said, gathered by api(); one entry per table.
   TIED TO THE RENDER THAT ASKED (review of 2026-11-12). /api/coverage takes
   16-33 s, and a reader who leaves #coverage before it answers would have
   had its note land on whatever page they opened next: a claim about a range
   that page never read. resetRetention() starts a new generation, api()
   stamps each request with the generation it was made in, and a note from
   an older one is dropped. */
const seen = new Map();
let gen = 0;
export const retentionGen = () => gen;
export function noteRetention(header, g = gen) {
  if (g !== gen) return;
  for (const n of parseRetentionHeader(header)) {
    const had = seen.get(n.table);
    if (!had || n.before > had.before) seen.set(n.table, n);
  }
}
export const resetRetention = () => { seen.clear(); gen += 1; };
export const retentionNow = () => [...seen.values()];

/* One line at the top of the page, or nothing. */
export function retentionBanner() {
  const rows = retentionNow();
  if (!rows.length || typeof document === 'undefined') return null;
  const el = document.createElement('div');
  el.className = 'access-withheld retention-note';
  el.setAttribute('role', 'note');
  el.innerHTML = rows.map((n) => `<b>${n.action === 'removed' ? 'Removed' : 'Thinned'} by retention before `
    + `${esc(dayWords(n.before))}.</b> ${esc(retentionSentence(n))}`).join('<br>');
  return el;
}

/* Each fact on a line of its own and under 15 words: the Arkiv focus pass
   folds a longer block into the panel's notes (api/public/focus.js
   LEAD_WORDS), and "dry run — removes nothing" is the one line on this panel
   nobody should have to open a fold to read. Measured: the first draft put
   all four facts in one 50-word line, and it was folded out of sight. */
const MODE_WORDS = {
  dry_run: 'dry run — counts what it would remove; removes nothing',
  on: 'on — removes what the rules below allow',
  off: 'off — the nightly pass is skipped',
};
const DUBAI_MS = 4 * 3600e3;
/* The first Dubai day left whole, as api/data_retention_notes.js computes it
   — or, with `own`, the Dubai day the instant falls in (where a claim
   begins). */
/* The day is read through tz.js's dubaiDay, the browser's one Dubai calendar
   (test/timezone.test.mjs bans \`toISOString().slice(0, 10)\` under api/public:
   it is the UTC day). The next day is noon of this one, in Dubai, plus 24 h. */
export const wholeDayAfter = (t, own = false) => {
  const ms = new Date(t).getTime();
  if (!Number.isFinite(ms)) return null;
  const day = dubaiDay(new Date(ms));
  return own || (ms + DUBAI_MS) % 864e5 === 0 ? day
    : dubaiDay(new Date(Date.parse(`${day}T12:00:00+04:00`) + 864e5));
};
const POLICY_WORDS = { thin: 'thinned', remove: 'removed', keep: 'kept', failed: 'failed' };
const num = (v) => (v == null ? null : Number(v).toLocaleString('en-US'));

/* The Settings panel. `h` carries the page's own helpers (panel, tableFrom,
   loading, empty, pill, dtStr, api) so this module imports nothing but tz.js. */
export function retentionPanel(h) {
  const p = h.panel('Data retention',
    'What the nightly pass looked at, would remove and removed — per table, with the reason each table is kept.');
  const fill = async () => {
    h.loading(p.body);
    let d;
    try { d = await h.api('/api/settings/retention'); }
    catch (e) { p.body.innerHTML = ''; h.empty(p.body, `The retention record could not be read: ${e.message}`); return; }
    p.body.innerHTML = '';
    const n = d.next || {};
    const tele = n.telemetry_cutoff;
    /* One box for the facts, so .pbody's panel gap falls around it and not
       between every line; each line stays its own short block for focus.js. */
    const facts = document.createElement('div');
    facts.className = 'ret-facts';
    p.body.append(facts);
    const line = (html) => { const e = document.createElement('p'); e.style.margin = '0'; e.innerHTML = html; facts.append(e); };
    line(`<b>Mode:</b> ${esc(MODE_WORDS[n.mode] || n.mode || 'not read')}`);
    line(`<b>Runs</b> nightly at ${esc(n.schedule?.utc || '19:53')} UTC (${esc(n.schedule?.dubai || '23:53')} Dubai)`);
    line(tele ? `<b>Positions</b> thinned past ${esc(dayWords(tele.day))}`
      : '<b>Positions</b> never thinned (RETENTION_TELEMETRY_DAYS is 0)');
    if (tele?.floored) line(`held back from ${esc(dayWords(tele.asked))}: never inside the weekly backfill’s window`);
    line(n.alert_cutoff ? `<b>Alerts</b> removed past ${esc(dayWords(n.alert_cutoff.day))}`
      : '<b>Alerts</b> kept for ever (RETENTION_ALERT_DAYS is 0)');
    if (!d.last) { h.empty(p.body, d.absent || 'No retention pass has run yet'); return; }
    const l = d.last;
    const status = document.createElement('p');
    status.innerHTML = `<b>Last pass:</b> ${esc(h.dtStr(l.started_at))}, ${esc(l.mode)} — ${h.pill(l.status,
      l.status === 'ok' ? 'ok' : l.status === 'failed' ? 'err' : 'warn')}${l.error ? ` ${esc(l.error)}` : ''}`;
    p.body.append(status);
    p.body.append(h.tableFrom(l.tables || [], [
      { label: 'Table', key: 'tbl' },
      { label: 'Rule', key: 'policy', render: (r) => esc(POLICY_WORDS[r.policy] || r.policy) },
      { label: 'Older than', key: 'cutoff', render: (r) => (r.cutoff ? esc(h.dtStr(r.cutoff)) : '<span class="ent-off">no horizon</span>') },
      { label: 'Considered', key: 'considered', num: true, render: (r) => esc(num(r.considered) ?? '—') },
      /* A dry run never moves the cursor, so it re-examines the first 31
         days past the horizon every night: past that, its count is of the
         days it examined, not of everything an "on" pass would remove, and
         it says so rather than showing a part as the whole (review of
         2026-11-12). */
      { label: 'Would remove', key: 'would_delete', num: true,
        render: (r) => (r.would_delete == null ? '—' : `${esc(num(r.would_delete))}${Number(r.days_pending) > 0
          ? ` <span class="ent-off">in the ${esc(num(r.days_examined))} day${Number(r.days_examined) === 1 ? '' : 's'} examined; `
            + `${esc(num(r.days_pending))} more day${Number(r.days_pending) === 1 ? '' : 's'} past the horizon not examined this pass</span>`
          : ''}`) },
      { label: 'Removed', key: 'deleted', num: true, render: (r) => esc(num(r.deleted) ?? '—') },
      { label: 'Rows (estimate)', key: 'total_estimate', num: true,
        render: (r) => (r.total_estimate == null
          ? '<span class="ent-off" title="the table has not been analysed yet, so Postgres holds no estimate">not estimated</span>'
          : esc(num(r.total_estimate))) },
      { label: 'Why', key: 'note', render: (r) => esc(r.note || '') },
    ]));
    /* What pages are told: the range rows were really removed from. A
       policy that has run and removed nothing claims nothing (its
       done_before is only where the next pass resumes). */
    for (const s of d.state || []) {
      const e = document.createElement('p');
      e.textContent = s.removed_from && s.removed_before
        ? `${s.action === 'removed' ? 'Removed' : 'Thinned'} for real: ${s.tbl} from `
          + `${dayWords(wholeDayAfter(s.removed_from, true))} to before ${dayWords(wholeDayAfter(s.removed_before))}`
        : `${s.tbl}: the policy has run up to ${dayWords(wholeDayAfter(s.done_before))} and removed nothing yet`;
      p.body.append(e);
    }
  };
  fill();
  return p.panel;
}
