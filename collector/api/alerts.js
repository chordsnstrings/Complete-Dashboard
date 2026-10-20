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

   ONE ROW PER CREDENTIAL, provider|fleet_id|credential, the key
   credential_state upserts on. Not the surface: noteCredential overwrites it
   on every write, and a healthy Bolt run ends on getPayouts while an expired
   token is written on orderHistory. Keyed on the surface (the first version,
   caught by review before it shipped), the recovery landed on a key that was
   already 'ok' and the NEXT expiry on a key still reading 'stopped' — so the
   routine weekly Bolt expiry would have been silent.

   What it remembers (alert_state, schema_v110) is what it last TOLD the
   operator, written only once ntfy has accepted the push, and what the banner
   has said since when. So:
     - a restart or a deploy re-announces nothing;
     - a push that failed is simply tried again on the next pass;
     - A BLIP IS NOT NEWS. A changed verdict is sent only once the source has
       been OBSERVED AGAIN and still says it: a run of that source finished,
       or the credential was re-checked, after the watcher first saw the
       change. Passes are not observations — most sources run half-hourly, so
       a verdict from one failed run survives every pass until the next run,
       and "two passes" (the second version) still buzzed twice for one
       failed Yango run (review of c2a9ccb). One refused login fixed by the
       next run is now nothing at all — and an alert channel that cries wolf
       is muted, after which it reports nothing.
       Two exceptions. A pure stall (no successful run past the source's
       limit) has no later run to wait for — the silence IS the evidence —
       so it is confirmed by holding for two passes (CONFIRM_MS). And any
       verdict held for an hour (HOLD_MAX_MS) is sent whatever else, so a
       refusal followed by a dead worker is not silent forever.
     - and a row is told at most once per half hour (ALERT_GAP_MS), so a stall
       clock sitting on its limit cannot buzz on every crossing.
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
/* A stall is confirmed by holding for two passes at the five-minute cadence
   (less a little for timer drift); anything else by a later observation, or
   by holding for an hour. */
export const CONFIRM_MS = 9 * 60e3;
export const HOLD_MAX_MS = 60 * 60e3;
const RANK = { ok: 0, missing: 1, degraded: 2, 'at-risk': 3, stopped: 4 };
const PRIORITY = { ok: 2, missing: 3, degraded: 3, 'at-risk': 4, stopped: 4 };
const WORD = { ok: 'Working again', missing: 'Not configured', degraded: 'Degraded',
  'at-risk': 'Not collecting', stopped: 'Stopped' };
const TAG = { ok: 'white_check_mark', missing: 'grey_question', degraded: 'large_orange_diamond',
  'at-risk': 'warning', stopped: 'rotating_light' };

export const alertKey = (r) => [r.provider, r.fleet_id, r.credential].join('|');

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
      ? `${intro}\n\nRight now ${bad.length} of the ${rows.length} credentials watched `
        + `${bad.length === 1 ? 'is' : 'are'} not working:\n`
        + bad.map((r) => `${WORD[r.severity]}: ${label(r)} — ${reasonOf(r)}`).join('\n')
      : `${intro}\n\nRight now all ${rows.length} credentials watched are collecting.`,
    priority: 3, tags: ['bell'], click,
  };
}

/* A full timestamp for a TIMESTAMPTZ column — not a calendar day (src/util.js's
   stamp() is the UTC DAY, which test/timezone.test.mjs forbids on a clock). */
const stamp = (t) => new Date(t).toISOString();

/* Different news, not merely a different moment: another verdict, or inside a
   fault another STATE (a refused token is replaced, a moved URL is changed —
   two errands). A growing stall age under the same verdict is not news. */
const differs = (a, b) => a.severity !== b.severity
  || (b.severity !== 'ok' && (a.state ?? null) !== (b.state ?? null));

async function told(q, r, at) {
  await q(`UPDATE alert_state SET severity = $2, state = $3, label = $4, notified_at = $5 WHERE key = $1`,
    [alertKey(r), r.severity, r.state, label(r), stamp(at)]);
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
  q, publish = ntfyPublish, now = Date.now(), gapMs = ALERT_GAP_MS, confirmMs = CONFIRM_MS,
  holdMaxMs = HOLD_MAX_MS, config = settings,
} = {}) {
  const { topic, click } = await config();
  if (!topic) return { sent: 0, skipped: 'NTFY_TOPIC is not set' };
  const health = await authHealth(q);
  /* Absent, not healthy — the banner's own rule: an empty table supports no
     claim, including "all collecting". */
  if (!health.observed) return { sent: 0, skipped: 'nothing observed yet' };
  const rows = health.rows.filter((r) => r.severity !== 'pending' && r.severity in RANK);
  /* Every row saved and not yet tested: there is no verdict to report, and
     "all 0 are collecting" would be a claim about nothing. */
  if (!rows.length) return { sent: 0, skipped: 'every row is waiting for its first test' };
  const prev = new Map((await q(`SELECT key, severity, state, notified_at, seen_severity, seen_state, seen_since
                                   FROM alert_state`)).map((r) => [r.key, r]));
  /* The freshest finish per source and fleet, any status — the clock of
     "observed again". The fleet's own runs, else the source's fleet-less
     ones, as the banner's own clock reads them. */
  const lastRun = new Map((await q(`SELECT source, coalesce(fleet_id,'*') AS fleet_id, max(finished_at) AS at
                                      FROM collection_run GROUP BY 1, 2`).catch(() => []))
    .map((r) => [`${r.source}|${r.fleet_id}`, r.at]));
  const observedSince = (r, since) => [r.checked_at,
    lastRun.get(`${r.provider}|${r.fleet_id}`) ?? lastRun.get(`${r.provider}|*`)]
    .some((t) => t != null && Date.parse(t) > Date.parse(since));

  if (!prev.size) {
    const sent = await publish(firstMessage(rows, click));
    if (!sent.ok) return { sent: 0, error: sent.error };
    for (const r of rows) {
      await q(`INSERT INTO alert_state (key, severity, state, label, notified_at, seen_severity, seen_state, seen_since)
               VALUES ($1, $2, $3, $4, $5, $2, $3, $5) ON CONFLICT (key) DO NOTHING`,
      [alertKey(r), r.severity, r.state, label(r), stamp(now)]);
    }
    return { sent: 1, first: true, changes: 0 };
  }

  const changes = [];
  for (const r of rows) {
    const key = alertKey(r);
    let p = prev.get(key);
    /* What the banner says now, and since when it has said it. */
    if (!p) {
      /* A row the banner did not have before: a new credential. Healthy, it
         is recorded as told without a word; broken, it is news once it holds. */
      const quiet = r.severity === 'ok';
      await q(`INSERT INTO alert_state (key, severity, state, label, notified_at, seen_severity, seen_state, seen_since)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (key) DO NOTHING`,
      [key, quiet ? r.severity : null, quiet ? r.state : null, label(r), quiet ? stamp(now) : null,
        r.severity, r.state, stamp(now)]);
      if (quiet) continue;
      p = { severity: null, state: null, notified_at: null, seen_since: stamp(now) };
    } else if (differs({ severity: p.seen_severity, state: p.seen_state }, r)) {
      await q('UPDATE alert_state SET seen_severity = $2, seen_state = $3, seen_since = $4 WHERE key = $1',
        [key, r.severity, r.state, stamp(now)]);
      p = { ...p, seen_since: stamp(now) };
    }
    if (p.severity != null && !differs(p, r)) continue;            // already told
    /* Broken when it appeared, mended before anybody was told: nothing to say. */
    if (p.severity == null && r.severity === 'ok') {
      await q('UPDATE alert_state SET severity = $2, state = $3 WHERE key = $1', [key, r.severity, r.state]);
      continue;
    }
    const held = now - Date.parse(p.seen_since);
    const stall = r.severity === 'at-risk' && r.state === 'ok';
    const confirmed = stall ? held >= confirmMs : (observedSince(r, p.seen_since) || held >= holdMaxMs);
    if (!confirmed) continue;                                       // not observed again yet
    if (p.notified_at && now - Date.parse(p.notified_at) < gapMs) continue;
    changes.push({ r, from: p.severity == null ? null : p });
  }
  if (!changes.length) return { sent: 0, changes: 0 };
  const sent = await publish(compose(changes, click));
  if (!sent.ok) return { sent: 0, changes: changes.length, error: sent.error };
  for (const c of changes) await told(q, c.r, now);
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
