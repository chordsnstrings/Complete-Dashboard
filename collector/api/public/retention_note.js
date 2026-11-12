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

/* What this render's answers said, gathered by api(); one entry per table. */
const seen = new Map();
export function noteRetention(header) {
  for (const n of parseRetentionHeader(header)) {
    const had = seen.get(n.table);
    if (!had || n.before > had.before) seen.set(n.table, n);
  }
}
export const resetRetention = () => seen.clear();
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
/* The first Dubai day left whole, as api/data_retention_notes.js computes it. */
export const wholeDayAfter = (t) => {
  const ms = new Date(t).getTime();
  if (!Number.isFinite(ms)) return null;
  const day = new Date(ms + DUBAI_MS).toISOString().slice(0, 10);
  return (ms + DUBAI_MS) % 864e5 === 0 ? day
    : new Date(Date.parse(`${day}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
};
const POLICY_WORDS = { thin: 'thinned', remove: 'removed', keep: 'kept', failed: 'failed' };
const num = (v) => (v == null ? null : Number(v).toLocaleString('en-US'));

/* The Settings panel. `h` carries the page's own helpers (panel, tableFrom,
   loading, empty, pill, dtStr, api) so this module imports nothing. */
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
      { label: 'Would remove', key: 'would_delete', num: true, render: (r) => esc(num(r.would_delete) ?? '—') },
      { label: 'Removed', key: 'deleted', num: true, render: (r) => esc(num(r.deleted) ?? '—') },
      { label: 'Rows (estimate)', key: 'total_estimate', num: true,
        render: (r) => (r.total_estimate == null
          ? '<span class="ent-off" title="the table has not been analysed yet, so Postgres holds no estimate">not estimated</span>'
          : esc(num(r.total_estimate))) },
      { label: 'Why', key: 'note', render: (r) => esc(r.note || '') },
    ]));
    for (const s of d.state || []) {
      const e = document.createElement('p');
      e.textContent = `${s.action === 'removed' ? 'Removed' : 'Thinned'} for real: ${s.tbl} before `
        + `${dayWords(wholeDayAfter(s.done_before))}`;
      p.body.append(e);
    }
  };
  fill();
  return p.panel;
}
