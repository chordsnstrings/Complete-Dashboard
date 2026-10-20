/* ntfy alerts: the credential banner, pushed to a phone when it changes.
   ─────────────────────────────────────────────────────────────────────────
   The banner (api/auth_routes.js) is the dashboard's one verdict on whether
   each source is collecting, and it is only seen by somebody who opens the
   dashboard. A Bolt portal token that expires at 09:18 on a Tuesday was found
   when somebody looked. This watcher reads the SAME verdict — authHealth, not
   a second rule — every five minutes and posts to ntfy when a row changes:

     stopped    a credential or surface refused, nothing collected      prio 4
     at-risk    no successful collection inside the source's limit       prio 4
     degraded   one surface refused, the channel still collecting        prio 3
     missing    a credential that is not configured at all               prio 3
     ok         back to working after any of the above                   prio 2

   'pending' (saved on the Settings page, not yet tested) is never sent and
   never recorded: it is neither a fault nor a recovery, and the verdict that
   replaces it is the one worth a push.

   What it remembers (alert_state, schema_v110) is what it last TOLD the
   operator, written only once ntfy has accepted the push. So:
     - a restart or a deploy re-announces nothing;
     - a push that failed is simply tried again on the next pass;
     - FLAPPING. A verdict that changes and changes back inside the quiet gap
       (30 minutes per row) is never sent. A stall clock sitting on its limit
       would otherwise buzz the phone twice an hour — and an alert channel
       that cries wolf is muted, after which it reports nothing at all.
   Changes found in the same pass go out as ONE message: a deploy that breaks
   six rows is one buzz with six lines, not six buzzes.

   The first pass with a topic configured and nothing remembered sends one
   "alerts are on" message carrying everything currently wrong, then stays
   quiet until something changes. That is also the end-to-end proof that the
   topic, the server and the phone are wired.

   Runs in the API process, which is one instance (as the banner's own
   reasoning assumes). What it cannot see is its own death: if the API is
   down, nothing here runs. The worker's death IS seen — every source's stall
   clock runs out, CABMAN's first, after two hours. */
import { authHealth, label } from './auth_routes.js';
import { publish as ntfyPublish } from '../src/ntfy.js';
import { get, loadSettings } from '../src/settings.js';
import { log as defaultLog } from '../src/log.js';

export const ALERT_GAP_MS = 30 * 60e3;
const RANK = { ok: 0, missing: 1, degraded: 2, 'at-risk': 3, stopped: 4 };
const PRIORITY = { ok: 2, missing: 3, degraded: 3, 'at-risk': 4, stopped: 4 };
const WORD = { ok: 'Working again', missing: 'Not configured', degraded: 'Degraded',
  'at-risk': 'Not collecting', stopped: 'Stopped' };
const TAG = { ok: 'white_check_mark', missing: 'grey_question', degraded: 'large_orange_diamond',
  'at-risk': 'warning', stopped: 'rotating_light' };

export const alertKey = (r) => [r.provider, r.fleet_id, r.credential, r.surface ?? ''].join('|');

const dubai = (t) => new Date(t).toLocaleString('en-GB', { timeZone: 'Asia/Dubai',
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** The banner's own reason for a row, in one line. */
export function reasonOf(r) {
  switch (r.severity) {
    case 'stopped': return r.detail || `refused (${r.state})`;
    case 'at-risk':
      return r.state === 'ok' && r.run_age_h != null
        ? `no successful collection for ${Math.round(r.run_age_h)}h — expected at least every ${r.stall_limit_h}h`
        : (r.detail || `state "${r.state}" is not one this dashboard knows to be fine`);
    case 'degraded':
      return `${r.detail || 'this feed is refused'} — the rest of the channel is still collecting`;
    case 'missing': return r.detail || 'no value is configured';
    default: return 'collecting normally';
  }
}

/* What it was before, when that was a fault. "since" would be a claim this
   cannot make: notified_at is when the fault was ANNOUNCED, and for one that
   predates the alerts, that is the moment they were switched on. "first
   reported" is true either way. A row that was collecting needs no history:
   that it stopped is the news. */
function wasOf(from, r) {
  if (!from || from.severity === r.severity || from.severity === 'ok') return null;
  return `was ${WORD[from.severity]?.toLowerCase() || from.severity}, first reported ${dubai(from.notified_at)} Dubai`;
}

function line({ r, from }) {
  const was = wasOf(from, r);
  return `${WORD[r.severity]}: ${label(r)} — ${reasonOf(r)}${was ? ` (${was})` : ''}`;
}

/** One message for every change found in one pass. */
export function compose(changes, click = null) {
  const worst = changes.reduce((a, c) => (RANK[c.r.severity] > RANK[a] ? c.r.severity : a), 'ok');
  const priority = Math.max(...changes.map((c) => PRIORITY[c.r.severity]));
  if (changes.length === 1) {
    const [c] = changes;
    const was = wasOf(c.from, c.r);
    return { title: `${WORD[c.r.severity]}: ${label(c.r)}`,
      message: `${reasonOf(c.r)}${was ? `\n${was[0].toUpperCase()}${was.slice(1)}.` : ''}`,
      priority, tags: [TAG[c.r.severity]], click };
  }
  const n = {};
  for (const c of changes) n[c.r.severity] = (n[c.r.severity] || 0) + 1;
  const counts = Object.keys(RANK).reverse().filter((s) => n[s])
    .map((s) => `${n[s]} ${WORD[s].toLowerCase()}`).join(', ');
  const sorted = [...changes].sort((a, b) => RANK[b.r.severity] - RANK[a.r.severity]);
  return { title: `${changes.length} sources changed: ${counts}`,
    message: sorted.map(line).join('\n'), priority, tags: [TAG[worst]], click };
}

/** The first message on a newly configured topic: what is wrong right now. */
export function firstMessage(rows, click = null) {
  const bad = rows.filter((r) => r.severity !== 'ok')
    .sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const intro = 'You will get a message here when a source stops, goes quiet past its limit, or '
    + 'comes back. Same verdicts as the banner on the dashboard.';
  return {
    title: 'Fleet dashboard alerts are on',
    message: bad.length
      ? `${intro}\n\nRight now, ${bad.length} of ${rows.length} are not working:\n`
        + bad.map((r) => `${WORD[r.severity]}: ${label(r)} — ${reasonOf(r)}`).join('\n')
      : `${intro}\n\nRight now all ${rows.length} are collecting.`,
    priority: 3, tags: ['bell'], click,
  };
}

async function remember(q, rows, at) {
  for (const r of rows) {
    await q(`INSERT INTO alert_state (key, severity, state, label, notified_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (key) DO UPDATE SET severity = EXCLUDED.severity, state = EXCLUDED.state,
               label = EXCLUDED.label, notified_at = EXCLUDED.notified_at`,
    [alertKey(r), r.severity, r.state, label(r), new Date(at).toISOString()]);
  }
}

async function settings() {
  await loadSettings();
  return { topic: String(get('NTFY_TOPIC', '') || '').trim(), click: get('PUBLIC_URL', '') || null };
}

/**
 * One pass. Injectable so a test can drive it without a network or a clock.
 * @returns { sent, changes?, first?, skipped?, error? }
 */
export async function alertTick({
  q, publish = ntfyPublish, now = Date.now(), gapMs = ALERT_GAP_MS, config = settings,
} = {}) {
  const { topic, click } = await config();
  if (!topic) return { sent: 0, skipped: 'NTFY_TOPIC is not set' };
  const health = await authHealth(q);
  /* Absent, not healthy — the banner's own rule: an empty table supports no
     claim, including "all collecting". */
  if (!health.observed) return { sent: 0, skipped: 'nothing observed yet' };
  const rows = health.rows.filter((r) => r.severity !== 'pending' && r.severity in RANK);
  const prev = new Map((await q('SELECT key, severity, state, notified_at FROM alert_state'))
    .map((r) => [r.key, r]));

  if (!prev.size) {
    const sent = await publish(firstMessage(rows, click));
    if (!sent.ok) return { sent: 0, error: sent.error };
    await remember(q, rows, now);
    return { sent: 1, first: true, changes: 0 };
  }

  const changes = []; const quiet = [];
  for (const r of rows) {
    const p = prev.get(alertKey(r));
    if (!p) {
      /* A row the banner did not have before: new credential, new surface.
         Healthy, it is recorded without a word; broken, it is news. */
      if (r.severity === 'ok') quiet.push(r); else changes.push({ r, from: null });
      continue;
    }
    /* Same verdict. Inside 'stopped', a different STATE is a different errand
       (a refused token vs. a moved URL), so it is news; a growing stall age
       under the same verdict is not. */
    if (p.severity === r.severity && (r.severity === 'ok' || p.state === r.state)) continue;
    if (now - Date.parse(p.notified_at) < gapMs) continue;
    changes.push({ r, from: p });
  }
  if (!changes.length) {
    if (quiet.length) await remember(q, quiet, now);
    return { sent: 0, changes: 0 };
  }
  const sent = await publish(compose(changes, click));
  if (!sent.ok) return { sent: 0, changes: changes.length, error: sent.error };
  await remember(q, [...changes.map((c) => c.r), ...quiet], now);
  return { sent: 1, changes: changes.length };
}

/** Every five minutes, from 90 seconds after boot. ALERTS=off to disable. */
export function startAlerts({ q, everyMs = 5 * 60e3, firstMs = 90e3, enabled = true, log = defaultLog } = {}) {
  if (!enabled) return null;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await alertTick({ q });
      if (r.sent) log.info('alerts', 'ntfy sent', r);
      else if (r.error) log.warn('alerts', 'ntfy not sent — will retry', r);
    } catch (e) {
      log.warn('alerts', 'pass failed', { err: String(e?.message || e).slice(0, 160) });
    } finally { busy = false; }
  };
  const first = setTimeout(tick, firstMs); first.unref?.();
  const every = setInterval(tick, everyMs); every.unref?.();
  return { tick, stop() { clearTimeout(first); clearInterval(every); } };
}
