/* What each page CONCLUDES, separated from how it says it.
   ─────────────────────────────────────────────────────────────────────────
   The first verdict written into a page read `r.value` for a channel's share,
   where /api/mix returns `n`. Every load computed a 0% leader, every load fell
   through to the branch that restates the totals, and the page looked fine:
   a sentence appeared, it was true, and it was the wrong one. A verdict that
   cannot be wrong because it never says anything is worse than no verdict, and
   nothing in a rendered page distinguishes the two.

   So the DECISION lives here as a pure function over the endpoint payloads,
   returning raw numbers and a branch name. The page formats it. That makes the
   branch a thing a test can assert against the same fixtures the mock API
   serves — which is where the field-name bug would have been caught. */

/** Which field a mix row carries its count in. The endpoints are not uniform:
 *  /api/mix says `n`, some rollups say `value`, some say `trips`. */
export const shareOf = (r) => +(r?.n ?? r?.value ?? r?.trips ?? 0) || 0;

/**
 * Fleet activity. Ranked by what a reader must not miss, not by a fixed
 * sentence: a hole in the record makes every rate computed across it wrong, so
 * it outranks any figure those rates produce — including a bad one.
 * @returns {{branch, tone, perDay, days, uncollected, partial, leadPct, lead, others}}
 */
export function fleetVerdict({ kpis = {}, daily = [], byPlatform = [] } = {}) {
  const days = daily.length || 0;
  const perDay = days ? Math.round((+kpis.trips || 0) / days) : 0;
  const uncollected = daily.filter((d) => d.uncollected).length;
  const partial = daily.filter((d) => !d.uncollected && (+d.sources_silent || 0) > 0).length;

  const charted = byPlatform.reduce((a, r) => a + shareOf(r), 0);
  const lead = [...byPlatform].sort((a, b) => shareOf(b) - shareOf(a))[0] || null;
  const leadPct = lead && charted ? Math.round((shareOf(lead) / charted) * 100) : 0;
  /* A second channel worth the name carries at least a tenth of the work.
     Below that the fleet has one channel and some rounding. */
  const others = byPlatform.filter((r) => r !== lead && shareOf(r) >= charted * 0.1).length;

  const cancel = kpis.cancel_pct == null ? null : +kpis.cancel_pct;
  const branch = uncollected ? 'gap'
    : (cancel != null && cancel >= 15) ? 'cancellations'
      : leadPct >= 80 ? 'single-channel'
        : others ? 'multi-channel' : 'plain';
  const tone = branch === 'gap' ? 'bad' : branch === 'cancellations' ? 'warn' : null;

  return { branch, tone, days, perDay, uncollected, partial, lead, leadPct, others, charted };
}

/**
 * The drivers directory. The question an operator opens it with is "who is on
 * the books and not earning", which was previously reachable only by scrolling
 * past everyone who is.
 */
export function driversVerdict({ rows = [], expired = [], idle = [], never = [], notFilled = [] } = {}) {
  const total = rows.length;
  const notEarning = idle.length + never.length;
  const idlePct = total ? Math.round((notEarning / total) * 100) : 0;
  const blocked = rows.filter((r) => /suspend|deact|block|reject/i.test(r.platform_state || '')).length;
  const branch = expired.length ? 'expired' : idlePct >= 50 ? 'idle' : 'working';
  return {
    branch,
    tone: branch === 'expired' ? 'bad' : branch === 'idle' ? 'warn' : null,
    total, notEarning, idlePct, blocked,
    expired: expired.length, idle: idle.length, never: never.length, notFilled: notFilled.length,
    active: total - notEarning,
  };
}
