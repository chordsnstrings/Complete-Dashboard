/* Which credentials are working, for the banner every page carries.
   ─────────────────────────────────────────────────────────────────────────
   This exists because an expired Uber web session did not look like a
   failure. Measured live on 2026-08-26: with the `sid` cookie dropped, the
   supplier GraphQL request follows a redirect to auth.uber.com, answers 404,
   and the collector read that as a week in which nobody drove — reporting the
   run 'ok'. The most perishable credential in this deployment could have
   stopped on a Friday and every page would have gone on saying every source
   was healthy. src/auth_state.js carries the whole measurement and does the
   detection; this reads what it recorded.

   Three states, and the difference between them is what an operator does next:

     stopped   a credential was refused, or bounced to a login page. Somebody
               has to replace it, and until they do the surfaces behind it are
               collecting nothing. Red.
     at risk   the credential still authenticates, but the surface behind it
               has not completed a run in far longer than its own schedule —
               so it is failing at something, and a credential is the usual
               reason. Amber.
     missing   configured for one fleet and absent for another that has data.
               A known gap rather than a fault; it never turns red, because
               nothing broke.

   What this deliberately does NOT do is predict expiry from the cookie. The
   jar holds one dated token, `sp-jwt-session`, and it was measured NOT to be
   the session: dropping it leaves both fleets answering 200 with data, while
   dropping `sid` or `csid` bounces to the login page. Egari's `jwt-session`
   expired three hours before this was written and Egari collected normally
   through it. A banner driven off those dates would have gone amber on a
   working fleet within the week, and a banner that is sometimes wrong is one
   nobody reads. So the amber here is earned by an observed stall, not by a
   date that turned out to describe something else. */

/** How long a source may go without finishing before it counts as stalled.
    Generous against each source's real cadence — the half-hourly incremental,
    CABMAN's five minutes — because one missed tick is a restart and six is a
    problem. */
const STALL_HOURS = {
  cabman: 2, uber: 6, uber_fleet: 6, fms: 6, yango: 12, hotel: 12, bolt: 24,
};
const DEFAULT_STALL_H = 12;

/* What each recorded credential state means to a reader. 'ok' is absent on
   purpose: a working credential's severity is decided by the stall clock, not
   by this table. */
const SEVERITY_OF = {
  expired: 'stopped',
  invalid: 'stopped',
  missing: 'missing',
  /* An endpoint that moved. Scored 'stopped' because nothing is being
     collected — the severity is identical — but it is a different STATE and
     therefore a different errand: somebody changes a URL rather than
     re-capturing a session that already works. src/auth_state.js wrote
     'expired' for these on purpose while this map had no row for the word,
     since an unknown state falls to 'at-risk' and would have taken a dead
     surface from red to amber. supplier.uber.com → fleethub.uber.com is the
     measured case; days went into re-pasting cookies that were fine. */
  moved: 'stopped',
  /* A check that could not run is not a check that passed — the Yango
     cookie-free comparison records this when it cannot complete. */
  unknown: 'at-risk',
};

export function authRoutes(app, { q, wrap }) {
  app.get('/api/auth', wrap(async (_req, res) => {
    const [creds, runs] = await Promise.all([
      q(`SELECT provider, fleet_id, credential, state, detail, surface,
                last_ok_at, checked_at
           FROM credential_state ORDER BY provider, fleet_id, credential`).catch(() => []),
      /* The freshest finish per source and fleet, so a stall is measured
         against the thing that actually runs rather than against a source
         name that covers two fleets with different credentials. */
      q(`SELECT DISTINCT ON (source, coalesce(fleet_id,'*'))
                source, coalesce(fleet_id,'*') AS fleet_id, status, finished_at, rows_written
           FROM collection_run
          ORDER BY source, coalesce(fleet_id,'*'), finished_at DESC NULLS LAST`).catch(() => []),
    ]);

    const now = Date.now();
    const ageH = (t) => (t ? (now - Date.parse(t)) / 3600e3 : null);
    const lastOk = new Map();
    for (const r of runs) {
      if (r.status !== 'ok' && r.status !== 'partial') continue;
      /* A partial that wrote nothing is not evidence that anything works, and
         this clock is the product's only measure of "the credential is still
         collecting". Rows are what a working credential produces. */
      if (r.status === 'partial' && !(Number(r.rows_written) > 0)) continue;
      lastOk.set(`${r.source}|${r.fleet_id}`, r.finished_at);
    }

    const rows = creds.map((c) => {
      const runAge = ageH(lastOk.get(`${c.provider}|${c.fleet_id}`)
        ?? lastOk.get(`${c.provider}|*`));
      const limit = STALL_HOURS[c.provider] ?? DEFAULT_STALL_H;
      /* A stall only means something while the credential still works: once it
         is refused, the stall is a consequence and saying both would report
         one fault twice. */
      const stalled = c.state === 'ok' && runAge != null && runAge > limit;
      return {
        ...c,
        last_ok_age_h: ageH(c.last_ok_at),
        run_age_h: runAge == null ? null : Math.round(runAge * 10) / 10,
        stall_limit_h: limit,
        /* Exhaustive, and its default is NOT 'ok'.
           ─────────────────────────────────────────────────────────────────
           This tested only for 'expired' and 'missing', so every other state
           fell through to the stall clock — which only fires for state 'ok'
           — and landed on 'ok'. Measured on production 2026-09-02, minutes
           after the collector first learned to record its refusals: two rows
           read state 'invalid' and severity 'ok', with stopped 0 and no
           headline at all. One of them was a Bolt token minted for the wrong
           fleet's owner and the other a Yango session answering 403.

           A state this does not know is at-risk rather than fine, because
           that is the failure that just happened: a state added by one change
           and silently rendered healthy by another. */
        severity: c.state === 'ok'
          ? (stalled ? 'at-risk' : 'ok')
          : (SEVERITY_OF[c.state] || 'at-risk'),
      };
    });

    const bad = rows.filter((r) => r.severity === 'stopped');
    const warn = rows.filter((r) => r.severity === 'at-risk');
    res.json({
      rows,
      stopped: bad.length,
      at_risk: warn.length,
      missing: rows.filter((r) => r.severity === 'missing').length,
      /* One sentence the banner can print without the page having to compose
         it, so every surface that shows this says the same thing. */
      /* A moved endpoint is counted here so the page can name the OTHER
         errand: "stopped working" sends somebody to re-capture a credential,
         and for these rows the credential is not what is wrong. */
      moved: rows.filter((r) => r.state === 'moved').length,
      headline: bad.length
        ? (bad.every((r) => r.state === 'moved')
          ? `${bad.length === 1 ? 'An endpoint has' : `${bad.length} endpoints have`} moved — nothing is `
            + 'being collected from them, and the credential is not what is wrong: '
            + bad.map((r) => `${label(r)} — ${r.detail || 'redirected'}`).join('; ')
          : `${bad.length === 1 ? 'A credential has' : `${bad.length} credentials have`} stopped working: `
            + bad.map((r) => `${label(r)} — ${r.detail || 'refused'}`).join('; '))
        : warn.length
          ? `${warn.length === 1 ? 'A source has' : `${warn.length} sources have`} not collected recently: `
            + warn.map((r) => `${label(r)}, last run ${r.run_age_h}h ago`).join('; ')
          : null,
      /* Absent, not healthy. A brand-new database has recorded nothing, and
         "every credential is fine" is not a claim an empty table supports. */
      observed: rows.length > 0,
    });
  }));
}

/** "Uber · Egari (UBER_WEB_COOKIE_EGARI)" — the provider, the fleet it fails
    for, and the key a person has to go and replace. */
function label(r) {
  const fleet = r.fleet_id && r.fleet_id !== '*'
    ? ` · ${r.fleet_id[0].toUpperCase()}${r.fleet_id.slice(1)}` : '';
  return `${r.provider}${fleet} (${r.credential})`;
}
